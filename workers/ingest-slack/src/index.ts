/**
 * `workers/ingest-slack` — Slack ingest worker for the Company Brain.
 *
 * Manages two databases (`Slack Channels`, `Slack Messages`) and three syncs:
 *   - `slackChannelsSync` (replace, 1h)   — channel discovery + auto-join + metadata
 *   - `slackBackfill`    (replace, manual) — full thread sweep per channel
 *   - `slackDelta`       (incremental, 5m) — per-channel ts cursor, picks up edits + new replies
 *
 * Single workspace in v1 (`SLACK_BOT_TOKEN`). All Slack calls share one pacer
 * (~45 req/min, 10% margin under Tier-3 ~50/min for modern non-distributed apps).
 */

import { Worker } from "@notionhq/workers";
import * as Schema from "@notionhq/workers/schema";

import { discoverEligibleChannels } from "./channels.js";
import { parseInternalDomains } from "./internal-domains.js";
import { createIdentityLookup } from "./lookups.js";
import { renderChannelMarkdown, toChannelChangeProperties } from "./render-channels.js";
import { renderThreadMarkdown, recordId, toThreadChangeProperties } from "./render-threads.js";
import { createSlackClient, type SlackChannel } from "./slack.js";
import {
	advanceBackfillState,
	advanceDeltaState,
	clampInt,
	initBackfillState,
	initDeltaState,
	nextChannelsState,
	type BackfillState,
	type ChannelsState,
	type DeltaState,
} from "./sync-state.js";
import { assembleThread } from "./threads.js";

const worker = new Worker();
export default worker;

// ---- Config ----

const BACKFILL_DAYS = clampInt(process.env.SLACK_BACKFILL_DAYS, { fallback: 30, min: 1, max: 3650 });

/**
 * Delta cursor lags real-time by this many ms. Slack writes propagate fast,
 * but a small buffer protects against a message that finalizes "in the past"
 * relative to our last `now` — primarily clock skew between our runtime and
 * Slack's edge.
 */
const CONSISTENCY_BUFFER_MS = 60_000;

// Project-specific constant. Hardcoded rather than env-driven so a deploy-time
// misconfig can't silently disable internal-vs-external classification. See
// workers/ingest-fireflies/src/index.ts:39 for the same rationale.
const INTERNAL_DOMAINS = parseInternalDomains("notionstate.com");

// ---- Module-init: client, identity cache, lazy team.info ----

const token = process.env.SLACK_BOT_TOKEN;
if (!token) {
	throw new Error("SLACK_BOT_TOKEN required. Set via `ntn workers env set SLACK_BOT_TOKEN=xoxb-...`.");
}

const slackApi = worker.pacer("slack:default", { allowedRequests: 45, intervalMs: 60_000 });
const slack = createSlackClient(token, slackApi);
const identity = createIdentityLookup(slack);

/**
 * Lazy `team.info` promise. Resolves to the workspace's slack.com subdomain
 * for constructing channel deep-link URLs. One call per worker lifetime;
 * falls back to "app" if the API fails (URL still works, just not branded).
 */
let teamDomainPromise: Promise<string> | null = null;
function getTeamDomain(): Promise<string> {
	return (teamDomainPromise ??= slack
		.teamInfo()
		.then((t) => t?.domain || "app")
		.catch(() => "app"));
}

// ---- Databases ----

const channelsDb = worker.database("slack-channels-v1", {
	type: "managed",
	initialTitle: "Slack Channels",
	primaryKeyProperty: "Channel ID",
	schema: {
		properties: {
			Name: Schema.title(),
			"Channel ID": Schema.richText(),
			Topic: Schema.richText(),
			Purpose: Schema.richText(),
			"Member Count": Schema.number(),
			"Is Member": Schema.checkbox(),
			"Is Archived": Schema.checkbox(),
			Created: Schema.date(),
			"Creator Email": Schema.email(),
			"Internal Creator": Schema.people(),
			"Slack URL": Schema.url(),
			Source: Schema.select([{ name: "Slack" }]),
			"Synced At": Schema.date(),
		},
	},
});

const messagesDb = worker.database("slack-messages-v1", {
	type: "managed",
	initialTitle: "Slack Messages",
	primaryKeyProperty: "Record ID",
	schema: {
		properties: {
			Title: Schema.title(),
			"Record ID": Schema.richText(),
			Channel: Schema.relation("slack-channels-v1", { twoWay: true, relatedPropertyName: "Threads" }),
			Author: Schema.richText(),
			"Author Email": Schema.email(),
			"Internal Participants": Schema.people(),
			"Thread Participants": Schema.richText(),
			"Posted At": Schema.date(),
			"Last Activity": Schema.date(),
			"Reply Count": Schema.number(),
			"Reaction Count": Schema.number(),
			"Has Attachments": Schema.checkbox(),
			Permalink: Schema.url(),
			Source: Schema.select([{ name: "Slack" }]),
			"Synced At": Schema.date(),
		},
	},
});

// ---- Sync 1: slackChannelsSync (replace, 1h) ----

worker.sync("slackChannelsSync", {
	database: channelsDb,
	mode: "replace",
	schedule: "1h",
	execute: async (rawState) => {
		const state = rawState as ChannelsState;
		const teamDomain = await getTeamDomain();
		const page = await slack.listPublicChannels(state?.listCursor);

		const eligible: SlackChannel[] = [];
		for (const ch of page.channels) {
			if (ch.is_archived || ch.is_private || ch.is_shared || ch.is_ext_shared) continue;
			if (!ch.is_member) {
				const r = await slack.joinChannel(ch.id);
				if (r.ok) ch.is_member = true;
				// On failure, the row still gets written with is_member=false so the
				// operator can see why ingest is stalled on it.
			}
			eligible.push(ch);
		}

		// Sequential, not Promise.all: rendering hits the identity cache and so
		// shares the pacer with everything else. Parallelism gives no throughput
		// gain (the pacer serializes anyway) and just bunches awaits in memory.
		const opts = { identity, internalDomains: INTERNAL_DOMAINS, teamDomain };
		const changes: Array<{
			type: "upsert";
			key: string;
			properties: Awaited<ReturnType<typeof toChannelChangeProperties>>;
			pageContentMarkdown: string;
		}> = [];
		for (const ch of eligible) {
			changes.push({
				type: "upsert",
				key: ch.id,
				properties: await toChannelChangeProperties(ch, opts),
				pageContentMarkdown: await renderChannelMarkdown(ch, opts),
			});
		}

		const nextState = nextChannelsState(page.nextCursor);
		return { changes, hasMore: nextState !== undefined, nextState };
	},
});

// ---- Sync 2: slackBackfill (replace, manual) ----

worker.sync("slackBackfill", {
	database: messagesDb,
	mode: "replace",
	schedule: "manual",
	execute: async (rawState) => {
		// Discover channel set fresh on first execute of the cycle; freeze it in state.
		const incoming = rawState as BackfillState;
		let state: NonNullable<BackfillState>;
		let channelsThisCycle: SlackChannel[] | null = null;

		if (incoming) {
			state = incoming;
		} else {
			channelsThisCycle = await discoverEligibleChannels(slack, { autoJoin: false });
			state = initBackfillState(undefined, channelsThisCycle.map((c) => c.id), BACKFILL_DAYS, new Date());
		}

		if (state.channelIds.length === 0) return { changes: [], hasMore: false };

		// Fetch the active channel's metadata for rendering. If we just discovered, we have it
		// in `channelsThisCycle`; otherwise re-resolve via a fresh list. Cheap and simple.
		const activeId = state.channelIds[state.currentIndex]!;
		const active = channelsThisCycle?.find((c) => c.id === activeId)
			?? (await findChannelInList(activeId));
		if (!active) {
			// Channel disappeared between discovery and now — skip ahead.
			const next = advanceBackfillState(state, undefined);
			return { changes: [], hasMore: next !== undefined, nextState: next };
		}

		const page = await slack.historyPage(activeId, {
			oldest: state.fromTs,
			cursor: state.historyCursor,
		});

		const changes = await buildThreadChanges(activeId, active, page.messages);

		const next = advanceBackfillState(state, page.nextCursor);
		return { changes, hasMore: next !== undefined, nextState: next };
	},
});

// ---- Sync 3: slackDelta (incremental, 5m) ----

worker.sync("slackDelta", {
	database: messagesDb,
	mode: "incremental",
	schedule: "5m",
	execute: async (rawState) => {
		const now = new Date();
		const incoming = rawState as DeltaState;

		// Always re-discover at cycle start so brand-new (already-joined) channels
		// start picking up activity quickly.
		const channelsThisCycle = incoming?.cycle
			? null
			: await discoverEligibleChannels(slack, { autoJoin: false });

		const state = initDeltaState(
			incoming,
			channelsThisCycle?.map((c) => c.id) ?? Object.keys(incoming?.cursorByChannel ?? {}),
			BACKFILL_DAYS,
			now,
		);

		if (!state.cycle || state.cycle.pendingChannelIds.length === 0) {
			return { changes: [], hasMore: false, nextState: state };
		}

		const activeId = state.cycle.pendingChannelIds[0]!;
		const cursor = state.cursorByChannel[activeId]!;
		const active = channelsThisCycle?.find((c) => c.id === activeId) ?? (await findChannelInList(activeId));

		if (!active) {
			// Channel gone — drop its cursor and advance.
			const dropped = { ...state.cursorByChannel };
			delete dropped[activeId];
			const remaining = state.cycle.pendingChannelIds.slice(1);
			return {
				changes: [],
				hasMore: remaining.length > 0,
				nextState: {
					cursorByChannel: dropped,
					cycle: remaining.length > 0
						? { pendingChannelIds: remaining, historyCursor: undefined, latestTsInCurrentChannel: null }
						: undefined,
				},
			};
		}

		const page = await slack.historyPage(activeId, { oldest: cursor, cursor: state.cycle.historyCursor });
		const pageLatestTs = pageMaxTs(page.messages);
		const changes = await buildThreadChanges(activeId, active, page.messages);

		const next = advanceDeltaState(state, page.nextCursor, pageLatestTs, now, CONSISTENCY_BUFFER_MS);
		const hasMore = next.cycle !== undefined && next.cycle.pendingChannelIds.length > 0;
		return { changes, hasMore, nextState: next };
	},
});

// ---- Internal helpers ----

async function findChannelInList(channelId: string): Promise<SlackChannel | null> {
	let cursor: string | undefined;
	for (;;) {
		const page = await slack.listPublicChannels(cursor);
		const found = page.channels.find((c) => c.id === channelId);
		if (found) return found;
		if (!page.nextCursor) return null;
		cursor = page.nextCursor;
	}
}

function pageMaxTs(messages: Array<{ ts: string; latest_reply: string | null }>): string | null {
	let max: string | null = null;
	for (const m of messages) {
		if (max === null || m.ts > max) max = m.ts;
		if (m.latest_reply && (max === null || m.latest_reply > max)) max = m.latest_reply;
	}
	return max;
}

/**
 * For each top-level message in a history page, assemble the thread and build
 * a change record. Skips reply-broadcasts (they're handled as part of their
 * parent's thread) and any message whose thread assembly returns null
 * (tombstone, system event).
 */
async function buildThreadChanges(
	channelId: string,
	channel: SlackChannel,
	messages: Array<import("./slack.js").SlackMessage>,
) {
	const out: Array<{
		type: "upsert";
		key: string;
		properties: Awaited<ReturnType<typeof toThreadChangeProperties>>;
		pageContentMarkdown: string;
	}> = [];

	// Filter out reply-broadcasts at the page level (they have thread_ts !== ts).
	const topLevel = messages.filter((m) => !m.thread_ts || m.thread_ts === m.ts);

	// Sequential, not Promise.all: rendering is async (identity cache + replies fetch)
	// and we share the pacer; concurrent calls bunch into the pacer window and trip
	// Slack's rolling rate limit. Same rationale as fireflies' fetchAllDetails.
	for (const parent of topLevel) {
		try {
			const thread = await assembleThread(slack, channelId, parent);
			if (!thread) continue;
			const permalink = await slack.getPermalink(channelId, thread.parent.ts);
			const opts = { identity, internalDomains: INTERNAL_DOMAINS, permalink };
			const properties = await toThreadChangeProperties(thread, channel, opts);
			const pageContentMarkdown = await renderThreadMarkdown(thread, channel, opts);
			out.push({
				type: "upsert",
				key: recordId(channelId, thread.parent.ts),
				properties,
				pageContentMarkdown,
			});
		} catch (e) {
			console.warn(`slack: failed to render thread ${channelId}:${parent.ts}:`, e);
		}
	}
	return out;
}
