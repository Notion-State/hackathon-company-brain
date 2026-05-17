import { APIErrorCode } from "@notionhq/client";
import { describe, expect, it, vi } from "vitest";

import type { DocType } from "./doc-types.js";
import { DestinationSchemaMismatch, IntegrationRevoked } from "./errors.js";
import { makeApiError } from "./fixtures/notion-error.js";
import type { ClientApi, NotionSdkSubset } from "./notion-client.js";
import { PreflightCache, verifyDestSchema } from "./preflight.js";

type Calls = {
	dbRetrieve: ReturnType<typeof vi.fn<NotionSdkSubset["databases"]["retrieve"]>>;
	dsRetrieve: ReturnType<typeof vi.fn<NotionSdkSubset["dataSources"]["retrieve"]>>;
	pacerWait: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

const DOCS_DB = "db_docs";
const STATUS_DB = "db_status";
const DELIV_DB = "db_deliv";

function makeApi(
	overrides: {
		dbResponse?: unknown;
		dsResponses?: Partial<Record<string, unknown>>; // keyed by data source id
		dbThrows?: unknown;
		dsThrows?: unknown;
	} = {},
): { api: ClientApi; calls: Calls } {
	const dbRetrieve = vi.fn<NotionSdkSubset["databases"]["retrieve"]>(async (args) => {
		if (overrides.dbThrows) throw overrides.dbThrows;
		return overrides.dbResponse ?? defaultDbResponseFor(args.database_id);
	});
	const dsRetrieve = vi.fn<NotionSdkSubset["dataSources"]["retrieve"]>(async (args) => {
		if (overrides.dsThrows) throw overrides.dsThrows;
		const stub = overrides.dsResponses?.[args.data_source_id];
		return stub ?? defaultDsResponseFor(args.data_source_id);
	});
	const dsQuery = vi.fn<NotionSdkSubset["dataSources"]["query"]>(async () => ({ results: [] }));
	const pagesCreate = vi.fn<NotionSdkSubset["pages"]["create"]>(async () => ({}));
	const pagesRetrieve = vi.fn<NotionSdkSubset["pages"]["retrieve"]>(async () => ({}));
	const pagesUpdate = vi.fn<NotionSdkSubset["pages"]["update"]>(async () => ({}));
	const blocksAppend = vi.fn<NotionSdkSubset["blocks"]["children"]["append"]>(async () => ({}));
	const blocksList = vi.fn<NotionSdkSubset["blocks"]["children"]["list"]>(async () => ({ results: [], has_more: false }));
	const usersList = vi.fn<NotionSdkSubset["users"]["list"]>(async () => ({ results: [] }));
	const usersRetrieve = vi.fn<NotionSdkSubset["users"]["retrieve"]>(async () => ({}));
	const pacerWait = vi.fn<() => Promise<void>>(async () => undefined);

	const sdk: NotionSdkSubset = {
		databases: { retrieve: dbRetrieve },
		dataSources: { retrieve: dsRetrieve, query: dsQuery },
		pages: { create: pagesCreate, retrieve: pagesRetrieve, update: pagesUpdate },
		blocks: { children: { append: blocksAppend, list: blocksList } },
		users: { list: usersList, retrieve: usersRetrieve },
	};
	let cached: Promise<Map<string, string>> | null = null;
	const api: ClientApi = {
		id: "acme",
		destDbIdsByType: {
			Docs: DOCS_DB,
			StatusUpdate: STATUS_DB,
			Deliverable: DELIV_DB,
		},
		mode: "staging",
		waitForPacer: pacerWait,
		sdk,
		usersByEmail: {
			get: () => {
				if (!cached) cached = Promise.resolve(new Map());
				return cached;
			},
			reset: () => {
				cached = null;
			},
		},
	};
	return { api, calls: { dbRetrieve, dsRetrieve, pacerWait } };
}

function defaultDbResponseFor(dbId: string) {
	return {
		object: "database",
		id: dbId,
		data_sources: [{ id: `${dbId}_ds`, name: "Default" }],
	};
}

function defaultDsResponseFor(dsId: string) {
	if (dsId === `${DOCS_DB}_ds`) {
		return {
			object: "data_source",
			id: dsId,
			properties: {
				"File Name": { type: "title" },
				"Brain ID": { type: "rich_text" },
				Status: {
					type: "status",
					status: {
						options: [
							{ name: "Drafting" },
							{ name: "In Review" },
							{ name: "Published" },
							{ name: "Archived" },
						],
					},
				},
				Type: {
					type: "select",
					select: {
						options: [
							{ name: "Contract" },
							{ name: "Brand" },
							{ name: "Framework" },
						],
					},
				},
			},
		};
	}
	if (dsId === `${STATUS_DB}_ds`) {
		return {
			object: "data_source",
			id: dsId,
			properties: {
				Title: { type: "title" },
				"Brain ID": { type: "rich_text" },
				Date: { type: "date" },
				Summary: { type: "rich_text" },
				Presenter: { type: "people" },
				Addressed: { type: "checkbox" },
			},
		};
	}
	if (dsId === `${DELIV_DB}_ds`) {
		return {
			object: "data_source",
			id: dsId,
			properties: {
				Title: { type: "title" },
				"Brain ID": { type: "rich_text" },
				Status: {
					type: "status",
					status: {
						options: [
							{ name: "Not Started" },
							{ name: "In Progress" },
							{ name: "Done" },
						],
					},
				},
				Timeline: { type: "date" },
				Owner: { type: "people" },
			},
		};
	}
	return { object: "data_source", id: dsId, properties: {} };
}

describe("verifyDestSchema — Docs", () => {
	it("returns dataSourceId, status options, type options when schema is healthy", async () => {
		const { api } = makeApi();
		const schema = await verifyDestSchema(api, "Docs");
		expect(schema.dataSourceId).toBe(`${DOCS_DB}_ds`);
		expect([...schema.statusOptions].sort()).toEqual([
			"Archived",
			"Drafting",
			"In Review",
			"Published",
		]);
		expect([...schema.typeOptions].sort()).toEqual([
			"Brand",
			"Contract",
			"Framework",
		]);
		expect(schema.optionalPropertiesPresent).toEqual({
			Presenter: false,
			Addressed: false,
		});
	});

	it("throws when File Name title is missing", async () => {
		const ds = defaultDsResponseFor(`${DOCS_DB}_ds`);
		delete (ds.properties as Record<string, unknown>)["File Name"];
		const { api } = makeApi({ dsResponses: { [`${DOCS_DB}_ds`]: ds } });
		await expect(verifyDestSchema(api, "Docs")).rejects.toMatchObject({
			details: { missing: ["File Name"] },
		});
	});

	it("throws when Brain ID is missing", async () => {
		const ds = defaultDsResponseFor(`${DOCS_DB}_ds`);
		delete (ds.properties as Record<string, unknown>)["Brain ID"];
		const { api } = makeApi({ dsResponses: { [`${DOCS_DB}_ds`]: ds } });
		await expect(verifyDestSchema(api, "Docs")).rejects.toMatchObject({
			details: { missing: ["Brain ID"] },
		});
	});

	it("throws on wrong type for Status (e.g., select instead of status)", async () => {
		const ds = defaultDsResponseFor(`${DOCS_DB}_ds`);
		(ds.properties as Record<string, unknown>).Status = { type: "select" };
		const { api } = makeApi({ dsResponses: { [`${DOCS_DB}_ds`]: ds } });
		try {
			await verifyDestSchema(api, "Docs");
			expect.unreachable("should have thrown");
		} catch (e) {
			if (e instanceof DestinationSchemaMismatch) {
				expect(e.details.wrongType).toContainEqual({
					name: "Status",
					expected: "status",
					actual: "select",
				});
			} else {
				throw e;
			}
		}
	});
});

describe("verifyDestSchema — StatusUpdate", () => {
	it("captures optional Presenter + Addressed presence flags", async () => {
		const { api } = makeApi();
		const schema = await verifyDestSchema(api, "StatusUpdate");
		expect(schema.optionalPropertiesPresent).toEqual({
			Presenter: true,
			Addressed: true,
		});
	});

	it("flags optional as absent when destination lacks them (Presenter only example)", async () => {
		const ds = defaultDsResponseFor(`${STATUS_DB}_ds`);
		delete (ds.properties as Record<string, unknown>).Presenter;
		const { api } = makeApi({ dsResponses: { [`${STATUS_DB}_ds`]: ds } });
		const schema = await verifyDestSchema(api, "StatusUpdate");
		expect(schema.optionalPropertiesPresent.Presenter).toBe(false);
		expect(schema.optionalPropertiesPresent.Addressed).toBe(true);
	});
});

describe("verifyDestSchema — Deliverable", () => {
	it("returns Status options and no Type options (Deliverable has no Type)", async () => {
		const { api } = makeApi();
		const schema = await verifyDestSchema(api, "Deliverable");
		expect(schema.statusOptions.has("Not Started")).toBe(true);
		expect(schema.typeOptions.size).toBe(0);
	});

	it("throws when required Owner property is missing", async () => {
		const ds = defaultDsResponseFor(`${DELIV_DB}_ds`);
		delete (ds.properties as Record<string, unknown>).Owner;
		const { api } = makeApi({ dsResponses: { [`${DELIV_DB}_ds`]: ds } });
		await expect(verifyDestSchema(api, "Deliverable")).rejects.toMatchObject({
			details: { missing: ["Owner"] },
		});
	});

	it("throws on wrong type for Owner (e.g. select instead of people)", async () => {
		const ds = defaultDsResponseFor(`${DELIV_DB}_ds`);
		(ds.properties as Record<string, unknown>).Owner = { type: "select" };
		const { api } = makeApi({ dsResponses: { [`${DELIV_DB}_ds`]: ds } });
		try {
			await verifyDestSchema(api, "Deliverable");
			expect.unreachable("should have thrown");
		} catch (e) {
			if (e instanceof DestinationSchemaMismatch) {
				expect(e.details.wrongType).toContainEqual({
					name: "Owner",
					expected: "people",
					actual: "select",
				});
			} else {
				throw e;
			}
		}
	});
});

describe("verifyDestSchema — error handling", () => {
	it("rejects a multi-data-source destination DB", async () => {
		const { api } = makeApi({
			dbResponse: {
				object: "database",
				id: DOCS_DB,
				data_sources: [
					{ id: "ds_a", name: "A" },
					{ id: "ds_b", name: "B" },
				],
			},
		});
		await expect(verifyDestSchema(api, "Docs")).rejects.toMatchObject({
			details: { hint: expect.stringMatching(/exactly one data source/) },
		});
	});

	it("translates 401 into IntegrationRevoked", async () => {
		const { api } = makeApi({
			dbThrows: makeApiError({
				code: APIErrorCode.Unauthorized,
				status: 401,
				message: "u",
			}),
		});
		await expect(verifyDestSchema(api, "Docs")).rejects.toBeInstanceOf(IntegrationRevoked);
	});

	it("translates 404 into DestinationSchemaMismatch with a sharing hint", async () => {
		const { api } = makeApi({
			dbThrows: makeApiError({
				code: APIErrorCode.ObjectNotFound,
				status: 404,
				message: "nf",
			}),
		});
		await expect(verifyDestSchema(api, "Docs")).rejects.toBeInstanceOf(
			DestinationSchemaMismatch,
		);
	});
});

describe("PreflightCache", () => {
	it("returns the cached promise on subsequent get() calls for the same docType", async () => {
		const cache = new PreflightCache();
		const { api, calls } = makeApi();
		const a = cache.get(api, "Docs");
		const b = cache.get(api, "Docs");
		expect(a).toBe(b);
		await a;
		expect(calls.dbRetrieve).toHaveBeenCalledTimes(1);
		expect(calls.dsRetrieve).toHaveBeenCalledTimes(1);
	});

	it("treats different docTypes as separate cache entries", async () => {
		const cache = new PreflightCache();
		const { api, calls } = makeApi();
		await cache.get(api, "Docs");
		await cache.get(api, "StatusUpdate");
		expect(calls.dbRetrieve).toHaveBeenCalledTimes(2);
		expect(calls.dsRetrieve).toHaveBeenCalledTimes(2);
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
		await expect(cache.get(api, "Docs")).rejects.toBeInstanceOf(IntegrationRevoked);
		await expect(cache.get(api, "Docs")).rejects.toBeInstanceOf(IntegrationRevoked);
		expect(calls.dbRetrieve).toHaveBeenCalledTimes(2);
	});

	it("seed pre-populates the cache so get() doesn't call the SDK", async () => {
		const cache = new PreflightCache();
		const { api, calls } = makeApi();
		const seeded = {
			dataSourceId: "seeded_ds",
			statusOptions: new Set(["Drafting"]),
			typeOptions: new Set(["Contract"]),
			optionalPropertiesPresent: { Presenter: false, Addressed: false },
		};
		cache.seed(
			{ id: api.id, docType: "Docs" as DocType, destDbId: api.destDbIdsByType.Docs },
			seeded,
		);
		const got = await cache.get(api, "Docs");
		expect(got).toBe(seeded);
		expect(calls.dbRetrieve).not.toHaveBeenCalled();
	});
});
