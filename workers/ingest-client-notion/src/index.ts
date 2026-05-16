import { APIErrorCode, APIResponseError } from "@notionhq/client";
import { Worker } from "@notionhq/workers";
import * as Schema from "@notionhq/workers/schema";

import { renderBlocksMarkdown } from "./blocks.js";
import { getClientNotionConfigs, type ClientConfig } from "./clients.js";
import { createClientNotion, type ClientNotion, type FeatureRequestPage } from "./notion.js";
import { renderPageMarkdown, toChangeProperties } from "./render.js";
import {
	advanceBackfillState,
	advanceDeltaState,
	clampInt,
	initBackfillState,
	initDeltaState,
	PAGE_SIZE,
	skipCurrentDeltaClient,
	type BackfillState,
	type DeltaState,
} from "./sync-state.js";

const worker = new Worker();
export default worker;

// ---- Config ----

/**
 * Days to look back when seeding a brand-new client's delta cursor. The
 * backfill sync ignores this entirely (it's a full sweep). Clamped [1, 3650].
 */
const BACKFILL_DAYS = clampInt(process.env.CLIENT_NOTION_BACKFILL_DAYS, {
	fallback: 30,
	min: 1,
	max: 3650,
});

/**
 * Delta cursor lags real-time by this many ms. Notion's `last_edited_time` is
 * atomic with writes, but cross-region propagation + clock skew between us and
 * Notion means an edit "in flight" at the moment we query may not be visible
 * yet. 60s comfortably covers both.
 */
const CONSISTENCY_BUFFER_MS = 60_000;

const BODY_RECURSION_DEPTH = 2;
const BODY_MAX_BYTES = 50_000;

// ---- Module-init: clients → pacers + Notion clients ----

const clients: ClientConfig[] = getClientNotionConfigs();
const clientIds = clients.map((c) => c.id);

type PerClient = {
	pacer: ReturnType<typeof worker.pacer>;
	api: ClientNotion;
	sourceDbId: string;
};

const perClient: Record<string, PerClient> = Object.fromEntries(
	clients.map((c) => {
		// Notion's documented per-integration limit is "an average of 3 requests
		// per second." Each client uses its own integration token, so the
		// ceiling applies per-client.
		const pacer = worker.pacer(`clientNotion:${c.id}`, { allowedRequests: 3, intervalMs: 1000 });
		return [
			c.id,
			{
				pacer,
				api: createClientNotion(c.token, pacer),
				sourceDbId: c.sourceDbId,
			},
		];
	}),
);

// ---- Database ----

const featureRequestsDb = worker.database("clientFeatureRequests", {
	type: "managed",
	initialTitle: "Client Feature Requests",
	primaryKeyProperty: "Record ID",
	schema: {
		properties: {
			Title: Schema.title(),
			"Record ID": Schema.richText(),
			Client: Schema.select(clientIds.map((id) => ({ name: id }))),
			Source: Schema.select([{ name: "Notion" }]),
			"Source Page ID": Schema.richText(),
			"Source Unique ID": Schema.richText(),
			"Source URL": Schema.url(),
			Description: Schema.richText(),
			Status: Schema.status({
				groups: [
					{
						name: "To-do",
						options: [
							{ name: "Triage", color: "gray" },
							{ name: "Planned", color: "blue" },
						],
					},
					{
						name: "In progress",
						options: [
							{ name: "Active", color: "yellow" },
							{ name: "POC Review", color: "orange" },
						],
					},
					{
						name: "Complete",
						options: [{ name: "Done", color: "green" }],
					},
				],
			}),
			Priority: Schema.select([
				{ name: "Critical", color: "red" },
				{ name: "High", color: "orange" },
				{ name: "Medium", color: "yellow" },
				{ name: "Low", color: "gray" },
			]),
			Complexity: Schema.select([
				{ name: "High" },
				{ name: "Medium" },
				{ name: "Low" },
			]),
			Effort: Schema.select([
				{ name: "High" },
				{ name: "Medium" },
				{ name: "Low" },
			]),
			Projection: Schema.select([
				{ name: "Company" },
				{ name: "Leadership" },
				{ name: "Department" },
				{ name: "Team" },
				{ name: "Individual" },
			]),
			// rich_text (not select) because option sets vary per client and we can't
			// pre-declare them at module init. Parallel to Fireflies' `Speakers`.
			Type: Schema.richText(),
			Team: Schema.richText(),
			Dependencies: Schema.richText(),
			"Assigned Owner": Schema.richText(),
			// People properties from client workspaces serialize to "Name <email>".
			// We can't use Schema.people because the source users don't exist in our
			// internal workspace.
			Submitter: Schema.richText(),
			POC: Schema.richText(),
			"Support Owner": Schema.richText(),
			"Technical Lead": Schema.richText(),
			"Proposed Owner": Schema.richText(),
			"Source Created Time": Schema.date(),
			"Source Last Edited Time": Schema.date(),
			"Synced At": Schema.date(),
		},
	},
});

// ---- Backfill sync (replace, manual) ----

worker.sync("clientFeatureRequestsBackfill", {
	database: featureRequestsDb,
	mode: "replace",
	schedule: "manual",
	execute: async (rawState) => {
		const state = initBackfillState(rawState as BackfillState, clientIds);
		if (state.pendingClientIds.length === 0) {
			return { changes: [], hasMore: false };
		}

		const activeClientId = state.pendingClientIds[0]!;
		const { api, sourceDbId } = perClient[activeClientId]!;
		const now = new Date();

		try {
			const page = await api.listFeatureRequestPages({
				dbId: sourceDbId,
				pageSize: PAGE_SIZE,
				startCursor: state.cursor,
				sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
			});
			const changes = await fetchAndRender(api, page.pages, activeClientId, now);
			const nextState = advanceBackfillState(state, page.hasMore, page.nextCursor);
			return {
				changes,
				hasMore: nextState !== undefined,
				nextState,
			};
		} catch (err) {
			if (isSkippableClientError(err)) {
				console.warn(
					`ingest-client-notion: skipping client "${activeClientId}" for the rest of this backfill cycle:`,
					err,
				);
				// Drop the active client (as if it returned `hasMore: false`).
				const nextState = advanceBackfillState(state, false, null);
				return {
					changes: [],
					hasMore: nextState !== undefined,
					nextState,
				};
			}
			throw err;
		}
	},
});

// ---- Delta sync (incremental, 5m) ----

worker.sync("clientFeatureRequestsDelta", {
	database: featureRequestsDb,
	mode: "incremental",
	schedule: "5m",
	execute: async (rawState) => {
		const now = new Date();
		const state = initDeltaState(rawState as DeltaState, clientIds, BACKFILL_DAYS, now);

		if (!state.cycle || state.cycle.pendingClientIds.length === 0) {
			return { changes: [], hasMore: false, nextState: state };
		}

		const activeClientId = state.cycle.pendingClientIds[0]!;
		const { api, sourceDbId } = perClient[activeClientId]!;
		const fromIso = state.cursorByClient[activeClientId]!;

		try {
			const page = await api.listFeatureRequestPages({
				dbId: sourceDbId,
				pageSize: PAGE_SIZE,
				startCursor: state.cycle.cursor,
				sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
				filter: {
					timestamp: "last_edited_time",
					last_edited_time: { on_or_after: fromIso },
				},
			});
			const changes = await fetchAndRender(api, page.pages, activeClientId, now);
			const pageLatest = latestEdited(page.pages);
			const nextState = advanceDeltaState(
				state,
				page.hasMore,
				pageLatest,
				page.nextCursor,
				now,
				CONSISTENCY_BUFFER_MS,
			);
			const hasMore = nextState.cycle !== undefined && nextState.cycle.pendingClientIds.length > 0;
			return { changes, hasMore, nextState };
		} catch (err) {
			if (isSkippableClientError(err)) {
				console.warn(
					`ingest-client-notion: skipping client "${activeClientId}" for the rest of this delta cycle:`,
					err,
				);
				// Drop active client without advancing its cursor — try again next cycle.
				const nextState = skipCurrentDeltaClient(state);
				const hasMore = nextState.cycle !== undefined && nextState.cycle.pendingClientIds.length > 0;
				return { changes: [], hasMore, nextState };
			}
			throw err;
		}
	},
});

// ---- Internal helpers ----

type ChangeUpsert = {
	type: "upsert";
	key: string;
	properties: ReturnType<typeof toChangeProperties>;
	pageContentMarkdown: string;
};

async function fetchAndRender(
	api: ClientNotion,
	pages: FeatureRequestPage[],
	clientId: string,
	now: Date,
): Promise<ChangeUpsert[]> {
	// Sequential per page (not Promise.all): each `getPageBlocks` call may issue
	// multiple paginated/recursive requests, all gated by the per-client pacer
	// inside notion.ts. Concurrent fan-out would burst against the rolling 3/s
	// limit. Per-page try/catch preserves partial success — one bad page
	// doesn't drop its page-mates.
	const out: ChangeUpsert[] = [];
	for (const page of pages) {
		try {
			const blocks = await api.getPageBlocks({
				pageId: page.id,
				recursionDepth: BODY_RECURSION_DEPTH,
			});
			const blocksMd = renderBlocksMarkdown(blocks, { maxBytes: BODY_MAX_BYTES });
			const bodyMd = renderPageMarkdown(page, blocksMd, clientId);
			out.push({
				type: "upsert",
				key: `${clientId}:${page.id}`,
				properties: toChangeProperties(page, clientId, now),
				pageContentMarkdown: bodyMd,
			});
		} catch (err) {
			console.warn(
				`ingest-client-notion: failed to render page=${page.id} for client="${clientId}":`,
				err,
			);
		}
	}
	return out;
}

function latestEdited(pages: FeatureRequestPage[]): string | null {
	let latest: string | null = null;
	for (const p of pages) {
		if (latest === null || p.last_edited_time > latest) latest = p.last_edited_time;
	}
	return latest;
}

function isSkippableClientError(err: unknown): boolean {
	if (!APIResponseError.isAPIResponseError(err)) return false;
	return (
		err.code === APIErrorCode.Unauthorized ||
		err.code === APIErrorCode.RestrictedResource ||
		err.code === APIErrorCode.ObjectNotFound
	);
}
