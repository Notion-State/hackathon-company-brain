import { APIErrorCode } from "@notionhq/client";
import { describe, expect, it, vi } from "vitest";

import {
	createArtifactCategoryResolver,
	type ArtifactCategoryName,
} from "./artifact-category.js";
import { IntegrationRevoked } from "./errors.js";
import { makeApiError } from "./fixtures/notion-error.js";
import type { ClientApi, NotionSdkSubset } from "./notion-client.js";

type QueryResponse = {
	results: Array<{
		id?: string;
		properties?: Record<string, unknown>;
	}>;
	has_more?: boolean;
	next_cursor?: string | null;
};

function row(pageId: string, title: string) {
	return {
		id: pageId,
		properties: {
			Name: {
				type: "title",
				title: [{ plain_text: title }],
			},
		},
	};
}

function makeApi(
	pages: QueryResponse[] | Error,
): { api: Pick<ClientApi, "id" | "waitForPacer" | "sdk">; queryFn: ReturnType<typeof vi.fn<NotionSdkSubset["dataSources"]["query"]>> } {
	let i = 0;
	const queryFn = vi.fn<NotionSdkSubset["dataSources"]["query"]>(async () => {
		if (pages instanceof Error) throw pages;
		const page = pages[i] ?? { results: [], has_more: false };
		i += 1;
		return page;
	});
	const sdk: NotionSdkSubset = {
		databases: { retrieve: vi.fn(async () => ({})) },
		dataSources: { retrieve: vi.fn(async () => ({})), query: queryFn },
		pages: {
			create: vi.fn(async () => ({})),
			retrieve: vi.fn(async () => ({})),
			update: vi.fn(async () => ({})),
		},
		blocks: {
			children: {
				append: vi.fn(async () => ({})),
				list: vi.fn(async () => ({ results: [], has_more: false })),
			},
		},
		users: { list: vi.fn(async () => ({ results: [] })) },
	};
	return {
		api: {
			id: "acme",
			waitForPacer: vi.fn<() => Promise<void>>(async () => undefined),
			sdk,
		},
		queryFn,
	};
}

describe("createArtifactCategoryResolver", () => {
	it("indexes the registry by page id (normalized) and returns the canonical category", async () => {
		const { api } = makeApi([
			{
				results: [
					row("aaaaaaaa-bbbb-cccc-dddd-000000000001", "Doc"),
					row("aaaaaaaa-bbbb-cccc-dddd-000000000002", "Status Update"),
					row("aaaaaaaa-bbbb-cccc-dddd-000000000003", "Deliverable"),
					row("aaaaaaaa-bbbb-cccc-dddd-000000000004", "Feature Requests"),
				],
				has_more: false,
			},
		]);
		const r = createArtifactCategoryResolver(api, "ds_registry");
		expect(await r.get("aaaaaaaa-bbbb-cccc-dddd-000000000001")).toBe("Docs");
		expect(await r.get("aaaaaaaabbbbccccdddd000000000002")).toBe("StatusUpdate");
		expect(await r.get("AAAAAAAA-BBBB-CCCC-DDDD-000000000003")).toBe("Deliverable");
		expect(await r.get("aaaaaaaa-bbbb-cccc-dddd-000000000004")).toBe(
			"FeatureRequests" satisfies ArtifactCategoryName,
		);
	});

	it("returns undefined for an unknown page id", async () => {
		const { api } = makeApi([
			{
				results: [row("page_doc", "Doc")],
				has_more: false,
			},
		]);
		const r = createArtifactCategoryResolver(api, "ds_registry");
		expect(await r.get("page_unknown")).toBeUndefined();
	});

	it("ignores registry rows whose title doesn't match a known category", async () => {
		const { api } = makeApi([
			{
				results: [
					row("page_doc", "Doc"),
					row("page_misc", "Random Other Category"),
				],
				has_more: false,
			},
		]);
		const r = createArtifactCategoryResolver(api, "ds_registry");
		expect(await r.get("page_misc")).toBeUndefined();
		expect(await r.get("page_doc")).toBe("Docs");
	});

	it("caches across calls: one SDK fetch per resolver lifetime", async () => {
		const { api, queryFn } = makeApi([
			{ results: [row("page_doc", "Doc")], has_more: false },
		]);
		const r = createArtifactCategoryResolver(api, "ds_registry");
		await r.get("page_doc");
		await r.get("page_doc");
		await r.get("page_unknown");
		expect(queryFn).toHaveBeenCalledTimes(1);
	});

	it("paginates across multiple registry pages", async () => {
		const { api, queryFn } = makeApi([
			{
				results: [row("page_doc", "Doc")],
				has_more: true,
				next_cursor: "c2",
			},
			{ results: [row("page_su", "Status Update")], has_more: false },
		]);
		const r = createArtifactCategoryResolver(api, "ds_registry");
		expect(await r.get("page_su")).toBe("StatusUpdate");
		expect(queryFn).toHaveBeenCalledTimes(2);
	});

	it("clears the cache on a failed load so the next call retries", async () => {
		const { api } = makeApi(
			makeApiError({
				code: APIErrorCode.Unauthorized,
				status: 401,
				message: "u",
			}),
		);
		const r = createArtifactCategoryResolver(api, "ds_registry");
		await expect(r.get("page_doc")).rejects.toBeInstanceOf(IntegrationRevoked);
		await expect(r.get("page_doc")).rejects.toBeInstanceOf(IntegrationRevoked);
	});
});
