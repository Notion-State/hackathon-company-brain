import { APIErrorCode } from "@notionhq/client";
import { describe, expect, it, vi } from "vitest";

import { DestinationSchemaMismatch, IntegrationRevoked } from "./errors.js";
import { makeApiError } from "./fixtures/notion-error.js";
import type { ClientApi, NotionSdkSubset } from "./notion-client.js";
import { PreflightCache, verifyDestSchema } from "./preflight.js";

type Calls = {
	dbRetrieve: ReturnType<typeof vi.fn<NotionSdkSubset["databases"]["retrieve"]>>;
	dsRetrieve: ReturnType<typeof vi.fn<NotionSdkSubset["dataSources"]["retrieve"]>>;
	pacerWait: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

function makeApi(
	overrides: {
		dbResponse?: unknown;
		dsResponse?: unknown;
		dbThrows?: unknown;
		dsThrows?: unknown;
	} = {},
): { api: ClientApi; calls: Calls } {
	const dbRetrieve = vi.fn<NotionSdkSubset["databases"]["retrieve"]>(async () => {
		if (overrides.dbThrows) throw overrides.dbThrows;
		return overrides.dbResponse ?? defaultDbResponse();
	});
	const dsRetrieve = vi.fn<NotionSdkSubset["dataSources"]["retrieve"]>(async () => {
		if (overrides.dsThrows) throw overrides.dsThrows;
		return overrides.dsResponse ?? defaultDsResponse();
	});
	const dsQuery = vi.fn<NotionSdkSubset["dataSources"]["query"]>(async () => ({ results: [] }));
	const pagesCreate = vi.fn<NotionSdkSubset["pages"]["create"]>(async () => ({}));
	const blocksAppend = vi.fn<NotionSdkSubset["blocks"]["children"]["append"]>(async () => ({}));
	const pacerWait = vi.fn<() => Promise<void>>(async () => undefined);

	const sdk: NotionSdkSubset = {
		databases: { retrieve: dbRetrieve },
		dataSources: { retrieve: dsRetrieve, query: dsQuery },
		pages: { create: pagesCreate },
		blocks: { children: { append: blocksAppend } },
	};
	const api: ClientApi = {
		id: "acme",
		destDbId: "db_acme",
		mode: "staging",
		waitForPacer: pacerWait,
		sdk,
	};
	return { api, calls: { dbRetrieve, dsRetrieve, pacerWait } };
}

function defaultDbResponse() {
	return {
		object: "database",
		id: "db_acme",
		data_sources: [{ id: "ds_acme", name: "Inbox" }],
	};
}

function defaultDsResponse() {
	return {
		object: "data_source",
		id: "ds_acme",
		properties: {
			Title: { type: "title" },
			"Brain ID": { type: "rich_text" },
			Source: { type: "select" },
			Category: {
				type: "select",
				select: {
					options: [{ name: "summary" }, { name: "action-items" }],
				},
			},
			"Pushed At": { type: "date" },
			"Original Date": { type: "date" },
			"Origin URL": { type: "url" },
		},
	};
}

describe("verifyDestSchema", () => {
	it("returns the dataSourceId, optional flags, and category options when schema is healthy", async () => {
		const { api } = makeApi();
		const schema = await verifyDestSchema(api);
		expect(schema.dataSourceId).toBe("ds_acme");
		expect(schema.hasOriginalDate).toBe(true);
		expect(schema.hasOriginUrl).toBe(true);
		expect([...schema.categoryOptions]).toEqual(
			expect.arrayContaining(["summary", "action-items"]),
		);
	});

	it("waits on the pacer before each SDK call", async () => {
		const { api, calls } = makeApi();
		await verifyDestSchema(api);
		expect(calls.pacerWait).toHaveBeenCalledTimes(2);
	});

	it("flags hasOriginalDate=false when the schema omits Original Date", async () => {
		const ds = defaultDsResponse();
		delete (ds.properties as Record<string, unknown>)["Original Date"];
		const { api } = makeApi({ dsResponse: ds });
		const schema = await verifyDestSchema(api);
		expect(schema.hasOriginalDate).toBe(false);
		expect(schema.hasOriginUrl).toBe(true);
	});

	it("throws DestinationSchemaMismatch with `missing` when a required property is absent", async () => {
		const ds = defaultDsResponse();
		delete (ds.properties as Record<string, unknown>)["Brain ID"];
		const { api } = makeApi({ dsResponse: ds });
		try {
			await verifyDestSchema(api);
			expect.unreachable("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(DestinationSchemaMismatch);
			if (e instanceof DestinationSchemaMismatch) {
				expect(e.details.missing).toEqual(["Brain ID"]);
				expect(e.details.wrongType).toEqual([]);
			}
		}
	});

	it("throws DestinationSchemaMismatch with `wrongType` when a property has the wrong type", async () => {
		const ds = defaultDsResponse();
		(ds.properties as Record<string, unknown>)["Brain ID"] = { type: "title" };
		const { api } = makeApi({ dsResponse: ds });
		try {
			await verifyDestSchema(api);
			expect.unreachable("should have thrown");
		} catch (e) {
			if (e instanceof DestinationSchemaMismatch) {
				expect(e.details.wrongType).toEqual([
					{ name: "Brain ID", expected: "rich_text", actual: "title" },
				]);
			} else {
				throw e;
			}
		}
	});

	it("throws DestinationSchemaMismatch when the database has multiple data sources", async () => {
		const db = defaultDbResponse();
		db.data_sources = [
			{ id: "ds_a", name: "A" },
			{ id: "ds_b", name: "B" },
		];
		const { api } = makeApi({ dbResponse: db });
		try {
			await verifyDestSchema(api);
			expect.unreachable("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(DestinationSchemaMismatch);
			if (e instanceof DestinationSchemaMismatch) {
				expect(e.details.hint).toMatch(/exactly one data source/);
			}
		}
	});

	it("translates a 404 from databases.retrieve into DestinationSchemaMismatch with a sharing hint", async () => {
		const err = makeApiError({
			code: APIErrorCode.ObjectNotFound,
			status: 404,
			message: "Not found",
		});
		const { api } = makeApi({ dbThrows: err });
		try {
			await verifyDestSchema(api);
			expect.unreachable("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(DestinationSchemaMismatch);
		}
	});

	it("translates a 401 from databases.retrieve into IntegrationRevoked", async () => {
		const err = makeApiError({
			code: APIErrorCode.Unauthorized,
			status: 401,
			message: "Unauthorized",
		});
		const { api } = makeApi({ dbThrows: err });
		await expect(verifyDestSchema(api)).rejects.toBeInstanceOf(IntegrationRevoked);
	});
});

describe("PreflightCache", () => {
	it("returns the cached promise on subsequent get() calls (one SDK call total)", async () => {
		const cache = new PreflightCache();
		const { api, calls } = makeApi();
		const a = cache.get(api);
		const b = cache.get(api);
		expect(a).toBe(b);
		await a;
		await b;
		expect(calls.dbRetrieve).toHaveBeenCalledTimes(1);
		expect(calls.dsRetrieve).toHaveBeenCalledTimes(1);
	});

	it("clears the entry on a rejected promise so the next call retries", async () => {
		const cache = new PreflightCache();
		const { api, calls } = makeApi({
			dbThrows: makeApiError({
				code: APIErrorCode.Unauthorized,
				status: 401,
				message: "x",
			}),
		});
		await expect(cache.get(api)).rejects.toBeInstanceOf(IntegrationRevoked);
		// Subsequent call should re-invoke the SDK (not reuse the failed promise).
		await expect(cache.get(api)).rejects.toBeInstanceOf(IntegrationRevoked);
		expect(calls.dbRetrieve).toHaveBeenCalledTimes(2);
	});
});
