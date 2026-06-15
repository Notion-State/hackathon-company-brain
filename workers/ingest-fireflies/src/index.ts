import { Worker } from "@notionhq/workers";
import * as Schema from "@notionhq/workers/schema";

import { getFirefliesAccounts, type Account } from "./accounts.js";
import { createFirefliesClient, type FirefliesClient, type Transcript } from "./fireflies.js";
import { parseInternalDomains } from "./internal-domains.js";
import { getCompaniesLookup, type CompaniesLookup } from "./lookups.js";
import { renderTranscriptMarkdown, toChangeProperties } from "./render.js";
import {
	advanceBackfillState,
	advanceDeltaState,
	clampInt,
	initBackfillState,
	initDeltaState,
	PAGE_SIZE,
	type BackfillState,
	type DeltaState,
} from "./sync-state.js";

const worker = new Worker();
export default worker;

// ---- Config ----

const BACKFILL_DAYS = clampInt(process.env.FIREFLIES_BACKFILL_DAYS, { fallback: 30, min: 1, max: 3650 });

/**
 * Delta cursor lags real-time by this many ms. Fireflies' `transcripts(fromDate)`
 * filters by meeting date, but transcripts can take hours to finalize after a
 * meeting ends. Advancing past the buffer would permanently skip any transcript
 * that finalizes "in the past." 1h is conservative; the manual backfill catches
 * anything still missed.
 */
const CONSISTENCY_BUFFER_MS = 60 * 60 * 1000;

// The internal email-domain list is our own org domain, not a per-environment
// value; pinning it keeps a deploy-time misconfig from silently disabling the
// Internal/External classification.
const INTERNAL_DOMAINS = parseInternalDomains("notionstate.com");
// The Companies DB id is tenant-specific, so it's read from the environment
// (required: module-init throws if unset) rather than baked into source.
const COMPANIES_DATABASE_ID = required("COMPANIES_DATABASE_ID");

// ---- Module-init: accounts → pacers + clients ----

const accounts: Account[] = getFirefliesAccounts();
const accountIds = accounts.map((a) => a.id);

type PerAccount = {
	pacer: ReturnType<typeof worker.pacer>;
	client: FirefliesClient;
};

const perAccount: Record<string, PerAccount> = Object.fromEntries(
	accounts.map((a) => [
		a.id,
		{
			// Fireflies rate-limits per API key on a rolling window (60/min on
			// Business). 30/min gives generous margin since the pacer dispenses
			// budget on a per-cycle basis but Fireflies counts across cycles.
			pacer: worker.pacer(`fireflies:${a.id}`, { allowedRequests: 30, intervalMs: 60_000 }),
			client: createFirefliesClient(a.apiKey),
		},
	]),
);

// ---- Database ----

// Note: `transcripts-v2` (not `transcripts`) so the workers runtime provisions
// a fresh managed database. The original `transcripts` DB ended up with stale
// archived rows the framework kept resolving to (writes succeeded but were
// invisible in the UI). Reset wasn't enough to break the binding. The old DB
// stays orphaned in the workspace; archive it manually once this is healthy.
const transcriptsDb = worker.database("transcripts-v2", {
	type: "managed",
	initialTitle: "Meeting Transcripts",
	primaryKeyProperty: "Record ID",
	schema: {
		properties: {
			"Meeting Title": Schema.title(),
			"Record ID": Schema.richText(),
			"Fireflies Meeting ID": Schema.richText(),
			Account: Schema.select(accountIds.map((id) => ({ name: id }))),
			"Meeting Date": Schema.date(),
			"Duration (min)": Schema.number(),
			"Internal/External": Schema.select([
				{ name: "Internal", color: "blue" },
				{ name: "External", color: "orange" },
			]),
			Summary: Schema.richText(),
			Keywords: Schema.richText(),
			Attendees: Schema.richText(),
			"Attendee Count": Schema.number(),
			"Participant Emails": Schema.richText(),
			// richText (comma-separated) rather than multi_select: avoids needing
			// to pre-declare speaker names as select options, which is impossible
			// at module init.
			Speakers: Schema.richText(),
			"Notion State Attendees": Schema.people(),
			"NS Talk %": Schema.number("percent"),
			Companies: Schema.richText(),
			"Company Domains": Schema.richText(),
			"Transcript URL": Schema.url(),
			"Recording Status": Schema.select([{ name: "Transcribed", color: "green" }]),
			Source: Schema.select([{ name: "Fireflies" }]),
			"Synced At": Schema.date(),
		},
	},
});

// ---- Backfill sync (replace, manual) ----

worker.sync("firefliesBackfill", {
	database: transcriptsDb,
	mode: "replace",
	schedule: "manual",
	execute: async (rawState, { notion }) => {
		const state = initBackfillState(rawState as BackfillState, accountIds, BACKFILL_DAYS, new Date());
		if (state.pendingAccountIds.length === 0) {
			return { changes: [], hasMore: false };
		}
		const companies = await getCompaniesLookup({ notion, companiesDatabaseId: COMPANIES_DATABASE_ID });

		const activeAccountId = state.pendingAccountIds[0]!;
		const { client, pacer } = perAccount[activeAccountId]!;

		await pacer.wait();
		const page = await client.listTranscriptIds({
			fromIso: state.fromDate,
			skip: state.currentSkip,
			limit: PAGE_SIZE,
		});

		const transcripts = await fetchAllDetails(client, pacer, page.ids);
		const changes = transcripts.map((t) => toUpsertChange(t, activeAccountId, companies));

		const nextState = advanceBackfillState(state, page.hasMore);
		return {
			changes,
			hasMore: nextState !== undefined,
			nextState,
		};
	},
});

// ---- Delta sync (incremental, 5m) ----

worker.sync("firefliesDelta", {
	database: transcriptsDb,
	mode: "incremental",
	schedule: "5m",
	execute: async (rawState, { notion }) => {
		const now = new Date();
		const state = initDeltaState(rawState as DeltaState, accountIds, BACKFILL_DAYS, now);

		if (!state.cycle || state.cycle.pendingAccountIds.length === 0) {
			return { changes: [], hasMore: false, nextState: state };
		}
		const companies = await getCompaniesLookup({ notion, companiesDatabaseId: COMPANIES_DATABASE_ID });

		const activeAccountId = state.cycle.pendingAccountIds[0]!;
		const { client, pacer } = perAccount[activeAccountId]!;
		const fromIso = state.cursorByAccount[activeAccountId]!;

		await pacer.wait();
		const page = await client.listTranscriptIds({
			fromIso,
			skip: state.cycle.skip,
			limit: PAGE_SIZE,
		});

		const transcripts = await fetchAllDetails(client, pacer, page.ids);
		const changes = transcripts.map((t) => toUpsertChange(t, activeAccountId, companies));

		const nextState = advanceDeltaState(state, page.hasMore, page.latestDate, now, CONSISTENCY_BUFFER_MS);
		const hasMore = nextState.cycle !== undefined && nextState.cycle.pendingAccountIds.length > 0;
		return { changes, hasMore, nextState };
	},
});

// ---- Internal helpers ----

async function fetchAllDetails(
	client: FirefliesClient,
	pacer: ReturnType<typeof worker.pacer>,
	ids: string[],
): Promise<Transcript[]> {
	// Sequential (not Promise.all): the pacer's per-call wait spreads requests
	// over the interval, but with concurrent calls the pacer dispenses budget
	// in a burst at the start of each minute and Fireflies' rolling rate-limit
	// trips. Sequential calls give the pacer time to enforce real spacing.
	// Per-id try/catch preserves the partial-success behavior of allSettled:
	// one failing fetch doesn't discard its page-mates.
	const transcripts: Transcript[] = [];
	for (const id of ids) {
		try {
			await pacer.wait();
			transcripts.push(await client.getTranscript(id));
		} catch (e) {
			console.warn(`fireflies: getTranscript failed for id=${id}:`, e);
		}
	}
	return transcripts;
}

function toUpsertChange(t: Transcript, accountId: string, companies: CompaniesLookup) {
	return {
		type: "upsert" as const,
		key: `${accountId}:${t.id}`,
		properties: toChangeProperties(t, accountId, INTERNAL_DOMAINS, companies),
		pageContentMarkdown: renderTranscriptMarkdown(t),
	};
}

function required(name: string): string {
	const v = process.env[name];
	if (!v) {
		throw new Error(
			`${name} is required. Set via \`ntn workers env set ${name}=...\` (deployed) or in .env (local).`,
		);
	}
	return v;
}
