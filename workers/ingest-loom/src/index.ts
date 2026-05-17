import { Worker } from "@notionhq/workers";
import * as Schema from "@notionhq/workers/schema";

import { composeEnrichment, toChangeProperties } from "./enrich.js";
import {
	createLoomClient,
	parseVideoId,
	type LoomClient,
	type TranscriptResult,
} from "./loom.js";
import { listVideoRows, type SourceVideoRow } from "./source-db.js";
import {
	advanceBackfillState,
	advanceDeltaState,
	initBackfillState,
	initDeltaState,
	PAGE_SIZE,
	type BackfillState,
	type DeltaState,
} from "./sync-state.js";

const worker = new Worker();
export default worker;

// ---- Config ----

const SOURCE_DATABASE_ID = required("LOOM_SOURCE_DATABASE_ID");
const SOURCE_URL_PROPERTY = process.env.LOOM_SOURCE_URL_PROPERTY ?? "Video URL";
const ENABLE_GRAPHQL = (process.env.LOOM_ENABLE_GRAPHQL ?? "true").toLowerCase() !== "false";

// Notion writes are atomic; 60s comfortably covers cross-region propagation +
// clock skew between us and Notion. Mirrors ingest-client-notion.
const CONSISTENCY_BUFFER_MS = 60_000;

// ---- Module-init: pacers + Loom client ----

// Notion's documented per-integration limit is "an average of 3 requests per
// second." One integration → one global ceiling.
const notionPacer = worker.pacer("notion", { allowedRequests: 3, intervalMs: 1000 });

// oEmbed has no published rate limit; 5/sec is conservative.
const oembedPacer = worker.pacer("loom-oembed", { allowedRequests: 5, intervalMs: 1000 });

// Share-page HTML scrape: bigger payload, tighter budget.
const pagePacer = worker.pacer("loom-page", { allowedRequests: 3, intervalMs: 1000 });

// GraphQL is undocumented; 2/sec keeps us well under whatever Loom's web client
// trips. Returns the signed CDN transcript URL alongside metadata.
const graphqlPacer = worker.pacer("loom-graphql", { allowedRequests: 2, intervalMs: 1000 });

// Signed CloudFront fetch for the transcript JSON. Separate from the page
// scrape pacer because it's a different host (cdn.loom.com) with its own
// limits and we want to tune it independently.
const transcriptPacer = worker.pacer("loom-transcript", {
	allowedRequests: 3,
	intervalMs: 1000,
});

const loom: LoomClient = createLoomClient({
	oembedPacer,
	pagePacer,
	graphqlPacer,
	transcriptPacer,
	enableGraphql: ENABLE_GRAPHQL,
});

// ---- Database ----

const loomVideosDb = worker.database("loom-videos-v1", {
	type: "managed",
	initialTitle: "Loom Videos",
	primaryKeyProperty: "Source Page ID",
	schema: {
		properties: {
			Title: Schema.title(),
			"Source Page ID": Schema.richText(),
			"Source URL": Schema.url(),
			"Video URL": Schema.url(),
			"Video ID": Schema.richText(),
			// URL (not file) so empty values are unambiguous — Builder.file's
			// behavior with an empty URL is undocumented and Notion's files
			// property doesn't have a clean single-Builder "no file" shape.
			"Thumbnail URL": Schema.url(),
			"Duration (sec)": Schema.number(),
			"Owner Name": Schema.richText(),
			"Owner Email": Schema.email(),
			"Upload Date": Schema.date(),
			Description: Schema.richText(),
			"Comment Count": Schema.number(),
			"Sync Status": Schema.select([
				{ name: "Enriched", color: "green" },
				{ name: "Private", color: "orange" },
				{ name: "Unavailable", color: "red" },
				{ name: "Failed", color: "red" },
			]),
			"Last Enriched At": Schema.date(),
			Source: Schema.select([{ name: "Loom" }]),
			"Synced At": Schema.date(),
		},
	},
});

// ---- Backfill sync (replace, manual) ----

worker.sync("loomBackfill", {
	database: loomVideosDb,
	mode: "replace",
	schedule: "manual",
	execute: async (rawState, { notion }) => {
		const state = initBackfillState(rawState as BackfillState);
		const now = new Date();

		const page = await listVideoRows({
			notion,
			pacer: notionPacer,
			databaseId: SOURCE_DATABASE_ID,
			urlProperty: SOURCE_URL_PROPERTY,
			pageSize: PAGE_SIZE,
			startCursor: state.cursor,
		});

		const changes = await enrichRows(loom, page.rows, now);
		const nextState = advanceBackfillState(state, page.hasMore, page.nextCursor);

		return {
			changes,
			hasMore: nextState !== undefined,
			nextState,
		};
	},
});

// ---- Delta sync (incremental, 5m) ----

worker.sync("loomDelta", {
	database: loomVideosDb,
	mode: "incremental",
	schedule: "5m",
	execute: async (rawState, { notion }) => {
		const now = new Date();
		const state = initDeltaState(rawState as DeltaState);

		const page = await listVideoRows({
			notion,
			pacer: notionPacer,
			databaseId: SOURCE_DATABASE_ID,
			urlProperty: SOURCE_URL_PROPERTY,
			pageSize: PAGE_SIZE,
			startCursor: state.cursor,
			// last_edited_time ascending so rows arrive in chronological order;
			// we advance the cursor to the max we saw at end-of-cycle.
			sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
			filter: {
				timestamp: "last_edited_time",
				last_edited_time: { on_or_after: state.fromCursor },
			},
		});

		const changes = await enrichRows(loom, page.rows, now);

		const pageLatest = page.rows.reduce<string | null>(
			(acc, r) => (acc == null || r.lastEditedTime > acc ? r.lastEditedTime : acc),
			null,
		);

		const nextState = advanceDeltaState(
			state,
			page.hasMore,
			pageLatest,
			page.nextCursor,
			now,
			CONSISTENCY_BUFFER_MS,
		);

		return {
			changes,
			hasMore: page.hasMore,
			nextState,
		};
	},
});

// ---- Helpers ----

type ChangeUpsert = {
	type: "upsert";
	key: string;
	properties: ReturnType<typeof toChangeProperties>;
	pageContentMarkdown: string;
};

async function enrichRows(loom: LoomClient, rows: SourceVideoRow[], now: Date): Promise<ChangeUpsert[]> {
	const out: ChangeUpsert[] = [];
	for (const row of rows) {
		const videoId = parseVideoId(row.videoUrl);
		const oembed = await loom.fetchOEmbed(row.videoUrl);
		const scrape = await loom.scrapeSharePage(row.videoUrl);
		const graphql = videoId ? await loom.fetchGraphQL(videoId) : { status: "skipped" as const };

		// Transcript is a second hop: GraphQL returns a signed CloudFront URL
		// (~5 min expiry) and we immediately fetch the JSON before it lapses.
		// Per-row ordering (not batched) is what keeps us inside the window.
		let transcript: TranscriptResult = { status: "skipped", reason: "no-url" };
		if (graphql.status === "ok" && graphql.transcriptUrl && graphql.transcriptStatus === "success") {
			transcript = await loom.fetchTranscriptJson(graphql.transcriptUrl);
		} else if (graphql.status === "ok" && graphql.transcriptStatus && graphql.transcriptStatus !== "success") {
			transcript = { status: "skipped", reason: "status-not-success" };
		}

		const enriched = composeEnrichment({
			source: row,
			videoId,
			oembed,
			scrape,
			graphql,
			transcript,
			now,
		});

		out.push({
			type: "upsert",
			key: row.pageId,
			properties: enriched.properties,
			pageContentMarkdown: enriched.pageContentMarkdown,
		});
	}
	return out;
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
