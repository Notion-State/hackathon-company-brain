import { translateNotionError } from "./api-errors.js";
import type { ClientApi } from "./notion-client.js";

/**
 * Looks for an existing page in the client's destination database with
 * `Brain ID == brainId`. Returns the page id + URL of a match, or `null` if
 * none exist.
 *
 * Two-result page_size is intentional: when more than one match is present
 * (shouldn't happen if all writes go through `pushToClient`, but pre-existing
 * duplicates are possible) we warn and return the first one to keep the call
 * idempotent.
 */

export type ExistingPage = {
	pageId: string;
	pageUrl: string;
};

export async function findExistingByBrainId(
	api: ClientApi,
	dataSourceId: string,
	brainId: string,
): Promise<ExistingPage | null> {
	let response: unknown;
	try {
		await api.waitForPacer();
		response = await api.sdk.dataSources.query({
			data_source_id: dataSourceId,
			page_size: 2,
			filter: {
				property: "Brain ID",
				rich_text: { equals: brainId },
			},
		});
	} catch (err) {
		throw translateNotionError(api.id, err);
	}

	const results = extractResults(response);
	if (results.length === 0) return null;
	if (results.length >= 2) {
		console.warn("duplicate Brain ID in destination", {
			clientId: api.id,
			brainId,
		});
	}
	const first = results[0]!;
	return { pageId: first.id, pageUrl: first.url };
}

type ResultRow = { id: string; url: string };

function extractResults(response: unknown): ResultRow[] {
	if (!isObject(response) || !Array.isArray(response.results)) return [];
	const out: ResultRow[] = [];
	for (const r of response.results) {
		if (!isObject(r)) continue;
		if (typeof r.id !== "string") continue;
		// A page result carries a `url`; data_source results would not. Filter
		// those out by requiring a string url.
		const url = typeof r.url === "string" ? r.url : "";
		out.push({ id: r.id, url });
	}
	return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}
