/**
 * Resolves `AI Drafts.Artifact Category` relation page ids to a canonical
 * category name we can route on (`Docs` / `StatusUpdate` / `Deliverable` /
 * `FeatureRequests`).
 *
 * The registry lives at a configured `dataSourceId`. We paginate it once per
 * worker lifetime, index by Notion page id (normalized — dashes stripped /
 * lowercased), and serve all subsequent reads from memory. The registry list
 * is small (4 rows today) and rarely changes; re-paging on every dispatch
 * would burn the pacer for no value.
 *
 * Unrecognized title → `undefined` (the dispatcher treats this as
 * `MissingDraftRelation` since we can't route it).
 */

import { translateNotionError } from "./api-errors.js";
import { normalize } from "./company-mapping.js";
import type { ClientApi, NotionSdkSubset } from "./notion-client.js";

export type ArtifactCategoryName =
	| "Docs"
	| "StatusUpdate"
	| "Deliverable"
	| "FeatureRequests";

/** Map the human-readable registry title to our internal canonical id. */
const TITLE_TO_CATEGORY: Record<string, ArtifactCategoryName> = {
	doc: "Docs",
	docs: "Docs",
	"status update": "StatusUpdate",
	"status updates": "StatusUpdate",
	deliverable: "Deliverable",
	deliverables: "Deliverable",
	"feature request": "FeatureRequests",
	"feature requests": "FeatureRequests",
};

export type ArtifactCategoryResolver = {
	get(pageId: string): Promise<ArtifactCategoryName | undefined>;
	/** Force a reload on next access (test-only). */
	reset(): void;
};

export function createArtifactCategoryResolver(
	api: Pick<ClientApi, "id" | "waitForPacer" | "sdk">,
	registryDataSourceId: string,
): ArtifactCategoryResolver {
	let cached: Promise<Map<string, ArtifactCategoryName>> | null = null;
	return {
		async get(pageId) {
			if (!cached) {
				cached = loadRegistry(api, registryDataSourceId).catch((err) => {
					cached = null; // reject → clear so the next call retries
					throw err;
				});
			}
			const map = await cached;
			return map.get(normalize(pageId));
		},
		reset() {
			cached = null;
		},
	};
}

async function loadRegistry(
	api: Pick<ClientApi, "id" | "waitForPacer" | "sdk">,
	registryDataSourceId: string,
): Promise<Map<string, ArtifactCategoryName>> {
	const map = new Map<string, ArtifactCategoryName>();
	let cursor: string | undefined = undefined;
	try {
		for (;;) {
			await api.waitForPacer();
			const response: unknown = await api.sdk.dataSources.query({
				data_source_id: registryDataSourceId,
				page_size: 100,
				start_cursor: cursor,
			});
			indexResults(response, map);
			const next = extractNextCursor(response);
			if (!next) break;
			cursor = next;
		}
	} catch (err) {
		throw translateNotionError(api.id, err);
	}
	return map;
}

function indexResults(
	response: unknown,
	into: Map<string, ArtifactCategoryName>,
): void {
	if (!isObject(response) || !Array.isArray(response.results)) return;
	for (const raw of response.results) {
		if (!isObject(raw)) continue;
		if (typeof raw.id !== "string") continue;
		const title = extractTitle(raw);
		if (!title) continue;
		const key = title.trim().toLowerCase();
		const category = TITLE_TO_CATEGORY[key];
		if (!category) continue; // unknown registry row — ignore
		into.set(normalize(raw.id), category);
	}
}

function extractTitle(row: Record<string, unknown>): string | undefined {
	const props = row.properties;
	if (!isObject(props)) return undefined;
	for (const value of Object.values(props)) {
		if (!isObject(value)) continue;
		if (value.type !== "title") continue;
		const titleArr = value.title;
		if (!Array.isArray(titleArr)) continue;
		let text = "";
		for (const segment of titleArr) {
			if (isObject(segment) && typeof segment.plain_text === "string") {
				text += segment.plain_text;
			}
		}
		if (text) return text;
	}
	return undefined;
}

function extractNextCursor(response: unknown): string | undefined {
	if (!isObject(response)) return undefined;
	if (response.has_more !== true) return undefined;
	return typeof response.next_cursor === "string" ? response.next_cursor : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

// Re-export the SDK subset type for tests.
export type { NotionSdkSubset };
