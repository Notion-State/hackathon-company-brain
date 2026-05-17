import { describe, expect, it, vi } from "vitest";

import { _resetDataSourceCache, extractUrl, listVideoRows } from "./source-db.js";

const noopPacer = { wait: async () => undefined };

describe("extractUrl", () => {
	it("returns the trimmed value from a url-typed property", () => {
		expect(extractUrl({ type: "url", url: "  https://loom.com/share/abc  " })).toBe(
			"https://loom.com/share/abc",
		);
	});

	it("returns null for a url-typed property with no value", () => {
		expect(extractUrl({ type: "url", url: null })).toBeNull();
		expect(extractUrl({ type: "url", url: "" })).toBeNull();
		expect(extractUrl({ type: "url", url: "   " })).toBeNull();
	});

	it("joins rich_text segments as a fallback for text-stored URLs", () => {
		expect(
			extractUrl({
				type: "rich_text",
				rich_text: [
					{ plain_text: "https://loom.com/" },
					{ plain_text: "share/abc" },
				],
			}),
		).toBe("https://loom.com/share/abc");
	});

	it("returns null for empty rich_text", () => {
		expect(extractUrl({ type: "rich_text", rich_text: [] })).toBeNull();
	});

	it("returns null for unknown property shapes", () => {
		expect(extractUrl({ type: "number", number: 42 })).toBeNull();
		expect(extractUrl(null)).toBeNull();
		expect(extractUrl("string")).toBeNull();
	});
});

describe("listVideoRows", () => {
	function makeNotion(overrides: {
		dataSources?: Array<{ id: string }>;
		queryResults?: unknown[];
		hasMore?: boolean;
		nextCursor?: string | null;
	}) {
		return {
			databases: {
				retrieve: vi.fn(async () => ({
					data_sources: overrides.dataSources ?? [{ id: "ds-1" }],
				})),
			},
			dataSources: {
				query: vi.fn(async () => ({
					results: overrides.queryResults ?? [],
					has_more: overrides.hasMore ?? false,
					next_cursor: overrides.nextCursor ?? null,
				})),
			},
		};
	}

	function pageResult(opts: {
		id: string;
		url: string;
		lastEdited: string;
		videoUrl: string | null;
	}) {
		return {
			object: "page",
			id: opts.id,
			url: opts.url,
			last_edited_time: opts.lastEdited,
			properties: {
				"Video URL": { type: "url", url: opts.videoUrl },
			},
		};
	}

	it("resolves data source id then queries it", async () => {
		_resetDataSourceCache();
		const notion = makeNotion({
			queryResults: [
				pageResult({
					id: "page-1",
					url: "https://www.notion.so/page-1",
					lastEdited: "2026-05-16T10:00:00.000Z",
					videoUrl: "https://www.loom.com/share/abc123def456abc123def456",
				}),
			],
		});
		const r = await listVideoRows({
			notion: notion as never,
			pacer: noopPacer,
			databaseId: "db-1",
			urlProperty: "Video URL",
		});
		expect(notion.databases.retrieve).toHaveBeenCalledWith({ database_id: "db-1" });
		expect(notion.dataSources.query).toHaveBeenCalledWith(
			expect.objectContaining({ data_source_id: "ds-1" }),
		);
		expect(r.rows).toEqual([
			{
				pageId: "page-1",
				pageUrl: "https://www.notion.so/page-1",
				videoUrl: "https://www.loom.com/share/abc123def456abc123def456",
				lastEditedTime: "2026-05-16T10:00:00.000Z",
			},
		]);
	});

	it("skips pages with empty Video URL", async () => {
		_resetDataSourceCache();
		const notion = makeNotion({
			queryResults: [
				pageResult({
					id: "page-1",
					url: "https://www.notion.so/page-1",
					lastEdited: "2026-05-16T10:00:00.000Z",
					videoUrl: null,
				}),
				pageResult({
					id: "page-2",
					url: "https://www.notion.so/page-2",
					lastEdited: "2026-05-16T10:01:00.000Z",
					videoUrl: "https://www.loom.com/share/has-url",
				}),
			],
		});
		const r = await listVideoRows({
			notion: notion as never,
			pacer: noopPacer,
			databaseId: "db-1",
			urlProperty: "Video URL",
		});
		expect(r.rows.map((row) => row.pageId)).toEqual(["page-2"]);
	});

	it("propagates pagination state", async () => {
		_resetDataSourceCache();
		const notion = makeNotion({
			queryResults: [],
			hasMore: true,
			nextCursor: "next-page-cursor",
		});
		const r = await listVideoRows({
			notion: notion as never,
			pacer: noopPacer,
			databaseId: "db-1",
			urlProperty: "Video URL",
		});
		expect(r.hasMore).toBe(true);
		expect(r.nextCursor).toBe("next-page-cursor");
	});

	it("caches the data source id across calls", async () => {
		_resetDataSourceCache();
		const notion = makeNotion({ queryResults: [] });
		await listVideoRows({
			notion: notion as never,
			pacer: noopPacer,
			databaseId: "db-1",
			urlProperty: "Video URL",
		});
		await listVideoRows({
			notion: notion as never,
			pacer: noopPacer,
			databaseId: "db-1",
			urlProperty: "Video URL",
		});
		expect(notion.databases.retrieve).toHaveBeenCalledTimes(1);
		expect(notion.dataSources.query).toHaveBeenCalledTimes(2);
	});

	it("throws when the database has no data sources", async () => {
		_resetDataSourceCache();
		const notion = makeNotion({ dataSources: [] });
		await expect(
			listVideoRows({
				notion: notion as never,
				pacer: noopPacer,
				databaseId: "db-missing",
				urlProperty: "Video URL",
			}),
		).rejects.toThrow(/no data sources/i);
	});

	it("throws when the database has multiple data sources", async () => {
		_resetDataSourceCache();
		const notion = makeNotion({ dataSources: [{ id: "ds-1" }, { id: "ds-2" }] });
		await expect(
			listVideoRows({
				notion: notion as never,
				pacer: noopPacer,
				databaseId: "db-multi",
				urlProperty: "Video URL",
			}),
		).rejects.toThrow(/2 data sources/);
	});
});
