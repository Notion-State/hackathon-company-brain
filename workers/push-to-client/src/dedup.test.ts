import { APIErrorCode } from "@notionhq/client";
import { describe, expect, it, vi } from "vitest";

import { findExistingByBrainId } from "./dedup.js";
import {
	ClientApiError,
	IntegrationRevoked,
	RateLimited,
} from "./errors.js";
import { makeApiError } from "./fixtures/notion-error.js";
import type { ClientApi, NotionSdkSubset } from "./notion-client.js";

function makeApi(opts: { queryResponse?: unknown; throws?: unknown }) {
	const dsQuery = vi.fn<NotionSdkSubset["dataSources"]["query"]>(async () => {
		if (opts.throws) throw opts.throws;
		return opts.queryResponse;
	});
	const dsRetrieve = vi.fn<NotionSdkSubset["dataSources"]["retrieve"]>(async () => ({}));
	const dbRetrieve = vi.fn<NotionSdkSubset["databases"]["retrieve"]>(async () => ({}));
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
		destDbIdsByType: { Docs: "db_docs", StatusUpdate: "db_status", Deliverable: "db_deliv" },
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
	return { api, dsQuery, pacerWait };
}

describe("findExistingByBrainId", () => {
	it("returns null when no results match", async () => {
		const { api, dsQuery, pacerWait } = makeApi({
			queryResponse: { results: [] },
		});
		const out = await findExistingByBrainId(api, "ds_acme", "brain-1");
		expect(out).toBeNull();
		expect(pacerWait).toHaveBeenCalledTimes(1);
		expect(dsQuery).toHaveBeenCalledWith({
			data_source_id: "ds_acme",
			page_size: 2,
			filter: { property: "Brain ID", rich_text: { equals: "brain-1" } },
		});
	});

	it("returns the page id and url on a single match", async () => {
		const { api } = makeApi({
			queryResponse: {
				results: [
					{ id: "page_1", url: "https://notion.so/page_1" },
				],
			},
		});
		const out = await findExistingByBrainId(api, "ds_acme", "brain-1");
		expect(out).toEqual({ pageId: "page_1", pageUrl: "https://notion.so/page_1" });
	});

	it("warns and returns the first when multiple matches exist", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { api } = makeApi({
			queryResponse: {
				results: [
					{ id: "page_1", url: "https://notion.so/page_1" },
					{ id: "page_2", url: "https://notion.so/page_2" },
				],
			},
		});
		const out = await findExistingByBrainId(api, "ds_acme", "brain-1");
		expect(out?.pageId).toBe("page_1");
		expect(warnSpy).toHaveBeenCalledWith(
			"duplicate Brain ID in destination",
			expect.objectContaining({ clientId: "acme", brainId: "brain-1" }),
		);
		warnSpy.mockRestore();
	});

	it("translates 401 into IntegrationRevoked", async () => {
		const err = makeApiError({
			code: APIErrorCode.Unauthorized,
			status: 401,
			message: "Unauthorized",
		});
		const { api } = makeApi({ throws: err });
		await expect(findExistingByBrainId(api, "ds_acme", "brain-1")).rejects.toBeInstanceOf(
			IntegrationRevoked,
		);
	});

	it("translates 429 into RateLimited with retry-after ms", async () => {
		const err = makeApiError({
			code: APIErrorCode.RateLimited,
			status: 429,
			message: "rate limited",
			headers: { "retry-after": "1.5" },
		});
		const { api } = makeApi({ throws: err });
		try {
			await findExistingByBrainId(api, "ds_acme", "brain-1");
			expect.unreachable("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(RateLimited);
			if (e instanceof RateLimited) {
				expect(e.retryAfterMs).toBe(1500);
			}
		}
	});

	it("translates other 4xx into ClientApiError preserving status + message", async () => {
		const err = makeApiError({
			code: APIErrorCode.ValidationError,
			status: 400,
			message: "bad filter",
		});
		const { api } = makeApi({ throws: err });
		try {
			await findExistingByBrainId(api, "ds_acme", "brain-1");
			expect.unreachable("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(ClientApiError);
			if (e instanceof ClientApiError) {
				expect(e.status).toBe(400);
				expect(e.message).toContain("bad filter");
			}
		}
	});
});
