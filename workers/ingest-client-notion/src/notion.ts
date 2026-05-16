/**
 * Per-client Notion SDK wrapper. Each client's worker integration token gets
 * its own `Client` instance and its own pacer.
 *
 * The public Notion API queries data sources, not databases. The user-facing
 * id (`CLIENT_NOTION_DB_ID_<ID>`) is a *database* id; we resolve it lazily to
 * the contained data source id via `databases.retrieve` and cache the result.
 *
 * Every SDK call is gated on `pacer.wait()` — the pacer is passed in at
 * construction so callers don't need to remember to wait themselves (and so a
 * single logical "list pages" call that's actually two HTTP requests on first
 * use doesn't burst past the per-integration rate ceiling).
 *
 * Block fetching is bounded: pagination is honored, recursion is depth-capped,
 * and the total block count per page is capped at MAX_BLOCKS_PER_PAGE. Overflow
 * is surfaced as a synthetic "truncation" block so the renderer can mark it.
 */

import { Client } from "@notionhq/client";
import type { BlockObjectResponse } from "@notionhq/client/build/src/api-endpoints/blocks.js";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints/common.js";
import type { QueryDataSourceParameters } from "@notionhq/client/build/src/api-endpoints/data-sources.js";

/** A Notion block with our `_children` extension for nested content. */
export type Block = BlockObjectResponse & { _children?: Block[] };

export type FeatureRequestPage = PageObjectResponse;

export type ListPagesArgs = {
	dbId: string;
	filter?: QueryDataSourceParameters["filter"];
	sorts?: QueryDataSourceParameters["sorts"];
	startCursor?: string | null;
	pageSize?: number;
};

export type ListPagesResult = {
	pages: FeatureRequestPage[];
	nextCursor: string | null;
	hasMore: boolean;
};

/** Minimal interface satisfied by `worker.pacer(...)`. */
export type PacerLike = { wait: () => Promise<void> };

export type ClientNotion = {
	listFeatureRequestPages(args: ListPagesArgs): Promise<ListPagesResult>;
	getPageBlocks(args: { pageId: string; recursionDepth: number }): Promise<Block[]>;
};

const BLOCKS_PAGE_SIZE = 100;
const MAX_BLOCKS_PER_PAGE = 500;
/** Defensive upper bound on the block-pagination loop. 500 blocks ÷ 100/page = 5; double for safety. */
const MAX_BLOCK_LIST_PAGES_PER_PARENT = 10;

/**
 * Synthetic block emitted when block traversal hits a cap. The renderer
 * recognizes this by `type === "unsupported"` and an internal marker.
 */
export const TRUNCATED_BLOCK_MARKER = "__hackathon_company_brain_truncated__";

export function createClientNotion(token: string, pacer: PacerLike): ClientNotion {
	const sdk = new Client({ auth: token });
	const dataSourceIdByDb = new Map<string, string>();

	async function resolveDataSourceId(dbId: string): Promise<string> {
		const cached = dataSourceIdByDb.get(dbId);
		if (cached) return cached;
		await pacer.wait();
		const db = await sdk.databases.retrieve({ database_id: dbId });
		if (!("data_sources" in db) || db.data_sources.length === 0) {
			throw new Error(
				`Database "${dbId}" has no data sources (received a partial database object or empty list). Reauthorize the integration or check that the id refers to a database.`,
			);
		}
		// Feature Requests databases are single-source. If a client ever has
		// multiple, picking the first is wrong — fail loudly so we notice.
		if (db.data_sources.length > 1) {
			throw new Error(
				`Database "${dbId}" has ${db.data_sources.length} data sources; this worker only supports single-source databases.`,
			);
		}
		const dsId = db.data_sources[0]!.id;
		dataSourceIdByDb.set(dbId, dsId);
		return dsId;
	}

	async function listFeatureRequestPages(args: ListPagesArgs): Promise<ListPagesResult> {
		const dataSourceId = await resolveDataSourceId(args.dbId);
		await pacer.wait();
		const response = await sdk.dataSources.query({
			data_source_id: dataSourceId,
			page_size: args.pageSize ?? 50,
			start_cursor: args.startCursor ?? undefined,
			sorts: args.sorts,
			filter: args.filter,
		});
		const pages: FeatureRequestPage[] = [];
		for (const result of response.results) {
			if (result.object === "page" && "properties" in result) {
				pages.push(result);
			}
		}
		return {
			pages,
			nextCursor: response.next_cursor,
			hasMore: response.has_more,
		};
	}

	async function getPageBlocks(args: { pageId: string; recursionDepth: number }): Promise<Block[]> {
		const counter = { total: 0 };
		return fetchChildren(sdk, pacer, args.pageId, args.recursionDepth, counter);
	}

	return { listFeatureRequestPages, getPageBlocks };
}

async function fetchChildren(
	sdk: Client,
	pacer: PacerLike,
	blockId: string,
	remainingDepth: number,
	counter: { total: number },
): Promise<Block[]> {
	if (counter.total >= MAX_BLOCKS_PER_PAGE) return [];

	const out: Block[] = [];
	let cursor: string | undefined = undefined;
	let listPages = 0;
	do {
		await pacer.wait();
		const response = await sdk.blocks.children.list({
			block_id: blockId,
			page_size: BLOCKS_PAGE_SIZE,
			start_cursor: cursor,
		});
		listPages += 1;
		for (const raw of response.results) {
			if (counter.total >= MAX_BLOCKS_PER_PAGE) {
				out.push(truncationMarker());
				return out;
			}
			if (!("type" in raw)) continue; // PartialBlockObjectResponse — skip
			const block: Block = raw;
			counter.total += 1;
			if (block.has_children && remainingDepth > 0) {
				block._children = await fetchChildren(sdk, pacer, block.id, remainingDepth - 1, counter);
			}
			out.push(block);
		}
		cursor = response.next_cursor ?? undefined;
		if (!response.has_more) break;
		if (listPages >= MAX_BLOCK_LIST_PAGES_PER_PARENT) {
			// Defensive: if Notion returns has_more forever, bail rather than spin.
			out.push(truncationMarker());
			break;
		}
	} while (cursor);
	return out;
}

function truncationMarker(): Block {
	// Minimal shape that's a valid Block. The renderer keys off the marker text.
	const now = new Date().toISOString();
	const marker: BlockObjectResponse = {
		object: "block",
		id: TRUNCATED_BLOCK_MARKER,
		parent: { type: "block_id", block_id: TRUNCATED_BLOCK_MARKER },
		created_time: now,
		last_edited_time: now,
		created_by: { object: "user", id: TRUNCATED_BLOCK_MARKER },
		last_edited_by: { object: "user", id: TRUNCATED_BLOCK_MARKER },
		has_children: false,
		archived: false,
		in_trash: false,
		type: "unsupported",
		unsupported: { block_type: TRUNCATED_BLOCK_MARKER },
	};
	return marker;
}
