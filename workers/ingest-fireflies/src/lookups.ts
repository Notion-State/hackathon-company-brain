/**
 * Lazy-cached Companies lookup: attendee email domain → company name.
 *
 * The Companies DB lives outside this worker (Notion State workspace).
 * We can't declare a `Schema.relation` to a non-managed DB, so we
 * materialize matched company names as a text property on each Meeting
 * Transcripts row.
 *
 * Loaded on the first sync execute after a deploy; stays in memory
 * until the next deploy. Stale entries appear after the next deploy —
 * acceptable trade-off vs. paying the lookup cost every cycle.
 *
 * Caller passes the **database id** (the thing in the Notion URL); we
 * resolve to a data source via `databases.retrieve` at load time. The
 * Companies DB is single-data-source so the first entry is the only entry.
 *
 * If `NOTION_API_TOKEN` isn't set or any call fails, the map stays
 * empty and Companies columns get blank values instead of crashing.
 */

import type { Client } from "@notionhq/client";

export type CompaniesLookup = {
	companyNameByDomain(domain: string | null | undefined): string | null;
};

export type CompaniesLookupConfig = {
	notion: Client;
	companiesDatabaseId: string | undefined;
	companiesDomainProperty?: string; // defaults to "Domain"
};

let cached: Promise<CompaniesLookup> | null = null;

export function getCompaniesLookup(config: CompaniesLookupConfig): Promise<CompaniesLookup> {
	if (cached) return cached;
	cached = load(config);
	return cached;
}

/** Test-only: reset module-level cache so tests don't bleed into each other. */
export function _resetCompaniesCache(): void {
	cached = null;
}

async function load(config: CompaniesLookupConfig): Promise<CompaniesLookup> {
	if (!config.companiesDatabaseId) {
		return { companyNameByDomain: () => null };
	}
	const map = await loadCompanies(
		config.notion,
		config.companiesDatabaseId,
		config.companiesDomainProperty ?? "Domain",
	).catch((e) => {
		console.warn("lookups: failed to load Companies:", e);
		return new Map<string, string>();
	});
	return {
		companyNameByDomain: (domain) => (domain ? map.get(domain.trim().toLowerCase()) ?? null : null),
	};
}

async function resolveDataSourceId(notion: Client, databaseId: string): Promise<string> {
	const db = (await notion.databases.retrieve({ database_id: databaseId })) as {
		data_sources?: Array<{ id: string }>;
	};
	const first = db.data_sources?.[0]?.id;
	if (!first) throw new Error(`Database ${databaseId} returned no data_sources`);
	return first;
}

async function loadCompanies(
	notion: Client,
	databaseId: string,
	domainProperty: string,
): Promise<Map<string, string>> {
	const dataSourceId = await resolveDataSourceId(notion, databaseId);
	const out = new Map<string, string>();
	let cursor: string | undefined;
	for (;;) {
		const res = await notion.dataSources.query({
			data_source_id: dataSourceId,
			start_cursor: cursor,
			page_size: 100,
		});
		for (const page of res.results) {
			if (!("properties" in page)) continue;
			const domainProp = page.properties[domainProperty];
			if (domainProp?.type !== "rich_text") continue;
			const domain = domainProp.rich_text
				.map((t) => t.plain_text)
				.join("")
				.trim()
				.toLowerCase();
			if (!domain) continue;

			// Find the title property (any property where type === "title").
			let name = "";
			for (const prop of Object.values(page.properties)) {
				if (prop?.type === "title") {
					name = prop.title.map((t: { plain_text: string }) => t.plain_text).join("").trim();
					break;
				}
			}
			if (name) out.set(domain, name);
		}
		if (!res.has_more || !res.next_cursor) break;
		cursor = res.next_cursor;
	}
	return out;
}
