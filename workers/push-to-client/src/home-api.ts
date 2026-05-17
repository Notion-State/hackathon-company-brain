/**
 * Thin handle over the home-workspace SDK — the Notion API client whose token
 * is configured under `CLIENT_TOKEN_NOTIONSTATE`. The dispatcher uses this for
 * reads + writes against our own workspace (the AI Drafts row, its `Company`
 * + `Artifact Category` relations, body blocks, Status/Location writeback).
 *
 * We reuse the `notionstate` `ClientApi` from the existing per-client
 * registry rather than configuring a separate token: one secret, one set of
 * connections to maintain. The id is one word (`notionstate`, not
 * `notion-state`) because env-var names can't contain hyphens — the
 * `CLIENT_TOKEN_<ID>` parser lowercases the suffix verbatim.
 */

import type { UpdatePageParameters } from "@notionhq/client/build/src/api-endpoints/pages.js";

import { translateNotionError } from "./api-errors.js";
import { ClientNotConfigured } from "./errors.js";
import type { Block } from "./body-renderer.js";
import type { ClientApi, NotionSdkSubset } from "./notion-client.js";

export type UpdatePageProperties = NonNullable<UpdatePageParameters["properties"]>;

export const HOME_CLIENT_ID = "notionstate";

export type HomeApi = {
	id: typeof HOME_CLIENT_ID;
	waitForPacer: () => Promise<void>;
	sdk: NotionSdkSubset;
};

/**
 * Resolve the home-workspace API from a registry of per-client APIs. Throws
 * `ClientNotConfigured` when the reserved id is absent.
 */
export function resolveHomeApi(perClient: Record<string, ClientApi>): HomeApi {
	const api = perClient[HOME_CLIENT_ID];
	if (!api) {
		throw new ClientNotConfigured(HOME_CLIENT_ID);
	}
	return {
		id: HOME_CLIENT_ID,
		waitForPacer: api.waitForPacer,
		sdk: api.sdk,
	};
}

/**
 * `pages.retrieve` against the home workspace, wrapped with pacer + error
 * translation. Returns the raw response — callers narrow via type guards.
 */
export async function retrievePage(
	api: HomeApi,
	pageId: string,
): Promise<unknown> {
	try {
		await api.waitForPacer();
		return await api.sdk.pages.retrieve({ page_id: pageId });
	} catch (err) {
		throw translateNotionError(api.id, err);
	}
}

/**
 * `pages.update` against the home workspace. Used by the dispatcher to write
 * back `Status` + `Location` to the AI Drafts row.
 */
export async function updatePage(
	api: HomeApi,
	pageId: string,
	properties: UpdatePageProperties,
): Promise<unknown> {
	try {
		await api.waitForPacer();
		return await api.sdk.pages.update({
			page_id: pageId,
			properties,
		});
	} catch (err) {
		throw translateNotionError(api.id, err);
	}
}

/**
 * Recursively reads a page's block tree up to `maxDepth`. Returns blocks with
 * a `_children` field populated where the recursion descended. Pacer is
 * waited on once per list call (one per block-list page).
 */
export async function listPageBlocks(
	api: HomeApi,
	pageId: string,
	opts: { maxDepth?: number; maxBlocks?: number } = {},
): Promise<Block[]> {
	const maxDepth = opts.maxDepth ?? 2;
	const maxBlocks = opts.maxBlocks ?? 500;
	const counter = { total: 0, cap: maxBlocks };
	return fetchChildren(api, pageId, maxDepth, counter);
}

async function fetchChildren(
	api: HomeApi,
	blockId: string,
	remainingDepth: number,
	counter: { total: number; cap: number },
): Promise<Block[]> {
	if (counter.total >= counter.cap) return [];

	const out: Block[] = [];
	let cursor: string | undefined = undefined;
	do {
		let response: unknown;
		try {
			await api.waitForPacer();
			response = await api.sdk.blocks.children.list({
				block_id: blockId,
				page_size: 100,
				start_cursor: cursor,
			});
		} catch (err) {
			throw translateNotionError(api.id, err);
		}

		if (!isObject(response) || !Array.isArray(response.results)) break;

		for (const raw of response.results) {
			if (counter.total >= counter.cap) return out;
			if (!isLikelyBlock(raw)) continue;
			counter.total += 1;
			if (raw.has_children && remainingDepth > 0) {
				raw._children = await fetchChildren(api, raw.id, remainingDepth - 1, counter);
			}
			out.push(raw);
		}

		cursor = typeof response.next_cursor === "string" ? response.next_cursor : undefined;
		if (response.has_more !== true) break;
	} while (cursor);
	return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

/**
 * Structural type guard: trust the SDK's response shape if it has the
 * minimum fields we touch (`type`, `id`, `has_children`). Avoids the
 * `as unknown as Block` escape hatch for the per-block narrowing.
 */
function isLikelyBlock(v: unknown): v is Block {
	if (!isObject(v)) return false;
	if (typeof v.type !== "string") return false;
	if (typeof v.id !== "string") return false;
	return true;
}
