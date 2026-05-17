/**
 * Read the Notion source database that holds Loom URLs. Paginates one page
 * at a time and yields normalized rows (one per source page with a non-empty
 * Loom URL).
 *
 * The public Notion API queries DATA SOURCES, not databases. The user-facing
 * id (the one in the Notion URL bar) is a database id — we resolve it lazily
 * to its single data source via `databases.retrieve` and cache the result
 * for the lifetime of the module (= for the lifetime of the worker process).
 *
 * Mirrors `workers/ingest-fireflies/src/lookups.ts` for the resolve pattern
 * and `workers/ingest-client-notion/src/notion.ts` for the typed query path,
 * but inverted: we don't expose a client struct, just a free function that
 * takes `notion` from `context.notion` plus a pacer.
 */

import type { Client } from "@notionhq/client";
import type { QueryDataSourceParameters } from "@notionhq/client/build/src/api-endpoints/data-sources.js";

export type PacerLike = { wait: () => Promise<void> };

export type ListVideoRowsArgs = {
	notion: Client;
	pacer: PacerLike;
	databaseId: string;
	urlProperty: string;
	pageSize?: number;
	startCursor?: string | null;
	sorts?: QueryDataSourceParameters["sorts"];
	filter?: QueryDataSourceParameters["filter"];
};

export type SourceVideoRow = {
	pageId: string;
	pageUrl: string;
	videoUrl: string;
	lastEditedTime: string;
};

export type ListVideoRowsResult = {
	rows: SourceVideoRow[];
	hasMore: boolean;
	nextCursor: string | null;
};

const dataSourceIdByDb = new Map<string, string>();

export async function listVideoRows(args: ListVideoRowsArgs): Promise<ListVideoRowsResult> {
	const dataSourceId = await resolveDataSourceId(args.notion, args.pacer, args.databaseId);

	await args.pacer.wait();
	const res = await args.notion.dataSources.query({
		data_source_id: dataSourceId,
		page_size: args.pageSize ?? 50,
		start_cursor: args.startCursor ?? undefined,
		sorts: args.sorts,
		filter: args.filter,
	});

	const rows: SourceVideoRow[] = [];
	for (const result of res.results) {
		// Skip partial page responses, databases, etc. — we only want full pages.
		if (result.object !== "page") continue;
		if (!("properties" in result) || !("last_edited_time" in result)) continue;

		const prop = result.properties[args.urlProperty];
		const videoUrl = extractUrl(prop);
		if (!videoUrl) continue;

		rows.push({
			pageId: result.id,
			pageUrl: result.url,
			videoUrl,
			lastEditedTime: result.last_edited_time,
		});
	}

	return {
		rows,
		hasMore: res.has_more,
		nextCursor: res.next_cursor,
	};
}

async function resolveDataSourceId(
	notion: Client,
	pacer: PacerLike,
	databaseId: string,
): Promise<string> {
	const cached = dataSourceIdByDb.get(databaseId);
	if (cached) return cached;

	await pacer.wait();
	const db = await notion.databases.retrieve({ database_id: databaseId });
	if (!("data_sources" in db) || db.data_sources.length === 0) {
		throw new Error(
			`Database "${databaseId}" returned no data sources (partial response or missing access). Verify the integration has been shared on the database.`,
		);
	}
	// Source DB is expected to be single-source. Multi-source would change
	// what "the Loom URLs" means; fail loudly so we notice instead of
	// silently syncing one of them.
	if (db.data_sources.length > 1) {
		throw new Error(
			`Database "${databaseId}" has ${db.data_sources.length} data sources; this worker only supports single-source databases. Set LOOM_SOURCE_DATABASE_ID to a specific data source id, or split the source.`,
		);
	}
	const dsId = db.data_sources[0]!.id;
	dataSourceIdByDb.set(databaseId, dsId);
	return dsId;
}

/**
 * Extract a URL string from a Notion property. Supports `url`-typed
 * properties (the canonical case for "Video URL") and `rich_text`-typed
 * fallbacks (some workspaces store URLs as text). Returns the trimmed
 * value, or null if there's nothing usable.
 */
export function extractUrl(prop: unknown): string | null {
	if (!isObject(prop)) return null;
	if (prop.type === "url") {
		const v = prop.url;
		return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
	}
	if (prop.type === "rich_text" && Array.isArray(prop.rich_text)) {
		const joined = prop.rich_text
			.map((r) => (isObject(r) && typeof r.plain_text === "string" ? r.plain_text : ""))
			.join("")
			.trim();
		return joined.length > 0 ? joined : null;
	}
	return null;
}

/** Test-only: reset module-level cache so tests don't bleed into each other. */
export function _resetDataSourceCache(): void {
	dataSourceIdByDb.clear();
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
