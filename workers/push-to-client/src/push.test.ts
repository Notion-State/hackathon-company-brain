import { describe, expect, it, vi } from "vitest";

import {
	DestinationSchemaMismatch,
	ProductionPushNotAuthorized,
} from "./errors.js";
import type { ClientApi, NotionSdkSubset } from "./notion-client.js";
import { PreflightCache, type DestSchema } from "./preflight.js";
import { pushToClient } from "./push.js";
import type { PushPayload } from "./properties.js";

function defaultSchema(): DestSchema {
	return {
		dataSourceId: "ds_acme",
		hasOriginalDate: true,
		hasOriginUrl: true,
		categoryOptions: new Set(["summary", "action-items"]),
	};
}

function defaultPayload(overrides: Partial<PushPayload> = {}): PushPayload {
	return {
		brainId: "brain-1",
		title: "T",
		source: "Fireflies",
		category: "summary",
		originalDate: "2026-05-15T18:00:00.000Z",
		originUrl: "https://example.com/x",
		bodyMarkdown: "# hi\n\npara",
		...overrides,
	};
}

type MakeApiOpts = {
	mode?: "staging" | "production";
	queryResults?: Array<{ id: string; url: string }>;
	createResponse?: { id: string; url: string } | (() => { id: string; url: string });
	appendThrows?: unknown;
	createThrows?: unknown;
};

function makeApi(opts: MakeApiOpts = {}) {
	const pacerWait = vi.fn<() => Promise<void>>(async () => undefined);
	const dsQuery = vi.fn<NotionSdkSubset["dataSources"]["query"]>(async () => ({
		results: opts.queryResults ?? [],
	}));
	const dsRetrieve = vi.fn<NotionSdkSubset["dataSources"]["retrieve"]>(async () => ({}));
	const dbRetrieve = vi.fn<NotionSdkSubset["databases"]["retrieve"]>(async () => ({}));
	const pagesCreate = vi.fn<NotionSdkSubset["pages"]["create"]>(async () => {
		if (opts.createThrows) throw opts.createThrows;
		return typeof opts.createResponse === "function"
			? opts.createResponse()
			: opts.createResponse ?? { id: "page_new", url: "https://notion.so/new" };
	});
	const blocksAppend = vi.fn<NotionSdkSubset["blocks"]["children"]["append"]>(async () => {
		if (opts.appendThrows) throw opts.appendThrows;
		return { results: [] };
	});

	const sdk: NotionSdkSubset = {
		databases: { retrieve: dbRetrieve },
		dataSources: { retrieve: dsRetrieve, query: dsQuery },
		pages: { create: pagesCreate },
		blocks: { children: { append: blocksAppend } },
	};
	const api: ClientApi = {
		id: "acme",
		destDbId: "db_acme",
		mode: opts.mode ?? "staging",
		waitForPacer: pacerWait,
		sdk,
	};
	return { api, pacerWait, dsQuery, pagesCreate, blocksAppend };
}

function makePreflight(schema: DestSchema = defaultSchema()): PreflightCache {
	const cache = new PreflightCache();
	// Seed via the documented test seam so tests that exercise `pushToClient`
	// don't have to also mock the underlying databases.retrieve / dataSources.retrieve
	// calls used by preflight itself.
	cache.seed({ id: "acme", destDbId: "db_acme" }, schema);
	return cache;
}

describe("pushToClient", () => {
	it("creates a page in staging mode and returns its id + url", async () => {
		const { api, pagesCreate } = makeApi();
		const out = await pushToClient(
			{ clientId: "acme", payload: defaultPayload() },
			{ api, preflight: makePreflight() },
		);
		expect(out.status).toBe("created");
		expect(out.pushedPageId).toBe("page_new");
		expect(out.pushedPageUrl).toBe("https://notion.so/new");
		expect(pagesCreate).toHaveBeenCalledTimes(1);
	});

	it("calls pages.create with parent.data_source_id and the right properties keys", async () => {
		const { api, pagesCreate } = makeApi();
		await pushToClient(
			{ clientId: "acme", payload: defaultPayload() },
			{ api, preflight: makePreflight() },
		);
		const arg = pagesCreate.mock.calls[0]?.[0];
		if (!arg || !arg.parent || !arg.properties) {
			throw new Error("expected pages.create to receive parent + properties");
		}
		if (!("data_source_id" in arg.parent)) {
			throw new Error("expected data_source_id parent");
		}
		expect(arg.parent.data_source_id).toBe("ds_acme");
		expect(Object.keys(arg.properties).sort()).toEqual(
			["Brain ID", "Category", "Origin URL", "Original Date", "Pushed At", "Source", "Title"],
		);
	});

	it("returns already_pushed when an existing Brain ID matches", async () => {
		const { api, pagesCreate } = makeApi({
			queryResults: [{ id: "page_existing", url: "https://notion.so/old" }],
		});
		const out = await pushToClient(
			{ clientId: "acme", payload: defaultPayload() },
			{ api, preflight: makePreflight() },
		);
		expect(out.status).toBe("already_pushed");
		expect(out.pushedPageId).toBe("page_existing");
		expect(pagesCreate).not.toHaveBeenCalled();
	});

	it("throws ProductionPushNotAuthorized before any SDK call when mode is production", async () => {
		const { api, pagesCreate, dsQuery } = makeApi({ mode: "production" });
		await expect(
			pushToClient(
				{ clientId: "acme", payload: defaultPayload() },
				{ api, preflight: makePreflight() },
			),
		).rejects.toBeInstanceOf(ProductionPushNotAuthorized);
		expect(pagesCreate).not.toHaveBeenCalled();
		expect(dsQuery).not.toHaveBeenCalled();
	});

	it("allows production pushes when allowProduction=true is passed", async () => {
		const { api } = makeApi({ mode: "production" });
		const out = await pushToClient(
			{
				clientId: "acme",
				payload: defaultPayload(),
				allowProduction: true,
			},
			{ api, preflight: makePreflight() },
		);
		expect(out.status).toBe("created");
	});

	it("throws DestinationSchemaMismatch (unknownCategory) before any write when the category is not in the destination's options", async () => {
		const { api, pagesCreate, dsQuery } = makeApi();
		try {
			await pushToClient(
				{ clientId: "acme", payload: defaultPayload({ category: "unknown" }) },
				{ api, preflight: makePreflight() },
			);
			expect.unreachable("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(DestinationSchemaMismatch);
			if (e instanceof DestinationSchemaMismatch) {
				expect(e.details.unknownCategory).toBe("unknown");
				expect(e.details.validCategories).toEqual(["action-items", "summary"]);
			}
		}
		expect(pagesCreate).not.toHaveBeenCalled();
		expect(dsQuery).not.toHaveBeenCalled();
	});

	it("forwards markdown warnings to the result", async () => {
		const { api } = makeApi();
		const out = await pushToClient(
			{
				clientId: "acme",
				payload: defaultPayload({
					bodyMarkdown: "![cat](https://x.png)\n\nhi",
				}),
			},
			{ api, preflight: makePreflight() },
		);
		expect(out.warnings.some((w) => /images/i.test(w))).toBe(true);
	});

	it("chunks block children: pages.create gets <=100, the rest go via blocks.children.append", async () => {
		// 250 paragraph lines = 250 blocks; we expect 1 create call + 2 append calls.
		const md = Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n\n");
		const { api, pagesCreate, blocksAppend } = makeApi();
		await pushToClient(
			{ clientId: "acme", payload: defaultPayload({ bodyMarkdown: md }) },
			{ api, preflight: makePreflight() },
		);
		expect(pagesCreate).toHaveBeenCalledTimes(1);
		expect(blocksAppend).toHaveBeenCalledTimes(2);

		const createArg = pagesCreate.mock.calls[0]?.[0];
		if (!createArg?.children) throw new Error("expected create call with children");
		expect(createArg.children).toHaveLength(100);
		const firstAppendArg = blocksAppend.mock.calls[0]?.[0];
		if (!firstAppendArg) throw new Error("expected first append call");
		expect(firstAppendArg.children).toHaveLength(100);
		const secondAppendArg = blocksAppend.mock.calls[1]?.[0];
		if (!secondAppendArg) throw new Error("expected second append call");
		expect(secondAppendArg.children).toHaveLength(50);
	});

	it("waits on the pacer before each Notion SDK call", async () => {
		const { api, pacerWait } = makeApi();
		await pushToClient(
			{ clientId: "acme", payload: defaultPayload() },
			{ api, preflight: makePreflight() },
		);
		// Preflight is injected into the cache (no SDK calls).
		// Expected: 1 wait for dataSources.query + 1 wait for pages.create.
		expect(pacerWait).toHaveBeenCalledTimes(2);
	});
});
