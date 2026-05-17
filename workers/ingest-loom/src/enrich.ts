/**
 * Pure composition of source-row data + Loom enrichment results into the
 * change-record properties + page-body markdown that the sync writes.
 *
 * "Pure" means: no fetches, no clock reads except the caller-provided `now`,
 * no module-level state. Easy to test by handing in fully-formed enrichment
 * objects.
 *
 * Sync Status precedence (per-property table):
 *   - oembed.status === "private"     ─> "Private"      (privileged signal)
 *   - oembed.status === "unavailable" ─> "Unavailable"  (removed/404)
 *   - scrape.status === "private"     ─> "Private"      (fallback signal)
 *   - scrape.status === "unavailable" ─> "Unavailable"
 *   - any of oembed/scrape is "ok"    ─> "Enriched"
 *   - everything failed/skipped       ─> "Failed"
 *
 * GraphQL is never the determining signal — its absence (kill switch, server
 * drift, or password-protected video) shouldn't downgrade a row whose Core
 * metadata loaded cleanly.
 */

import * as Builder from "@notionhq/workers/builder";

import type { GraphQLResult, OEmbedResult, SharePageResult, TranscriptCue } from "./loom.js";
import type { SourceVideoRow } from "./source-db.js";

/** Notion rich_text per-text-element cap. */
const RICH_TEXT_MAX = 2000;

export type SyncStatus = "Enriched" | "Private" | "Unavailable" | "Failed";

export type ComposeInput = {
	source: SourceVideoRow;
	videoId: string | null;
	oembed: OEmbedResult;
	scrape: SharePageResult;
	graphql: GraphQLResult;
	now: Date;
};

/**
 * Build the Notion property literal for one change record. Return type is
 * intentionally inferred (not annotated as `Record<string, …>`) so callers
 * can use `ReturnType<typeof toChangeProperties>` to get the strict
 * mapped-type SDK expects — `Record<string, TextValue>` is too loose and
 * the SDK rejects it.
 */
export function toChangeProperties(input: ComposeInput) {
	const status = pickStatus(input.oembed, input.scrape);
	const merged = mergeFields(input);
	const uploadDateIso = merged.uploadDate ?? input.now.toISOString();

	return {
		Title: Builder.title(merged.title),
		"Source Page ID": Builder.richText(input.source.pageId),
		"Source URL": Builder.url(input.source.pageUrl),
		"Video URL": Builder.url(input.source.videoUrl),
		"Video ID": Builder.richText(input.videoId ?? ""),
		"Thumbnail URL": Builder.url(merged.thumbnailUrl ?? ""),
		"Duration (sec)": Builder.number(merged.durationSeconds ?? 0),
		"Owner Name": Builder.richText(merged.ownerName ?? ""),
		"Owner Email": Builder.email(merged.ownerEmail ?? ""),
		"Upload Date": Builder.dateTime(uploadDateIso),
		Description: Builder.richText(truncate(merged.description ?? "", RICH_TEXT_MAX)),
		"View Count": Builder.number(merged.viewCount ?? 0),
		"Comment Count": Builder.number(merged.commentCount ?? 0),
		"Sync Status": Builder.select(status),
		"Last Enriched At": Builder.dateTime(input.now.toISOString()),
		Source: Builder.select("Loom"),
		"Synced At": Builder.dateTime(input.now.toISOString()),
	};
}

export type ComposeOutput = {
	properties: ReturnType<typeof toChangeProperties>;
	pageContentMarkdown: string;
	syncStatus: SyncStatus;
};

export function composeEnrichment(input: ComposeInput): ComposeOutput {
	const status = pickStatus(input.oembed, input.scrape);
	const merged = mergeFields(input);
	const properties = toChangeProperties(input);

	const pageContentMarkdown = renderVideoMarkdown({
		title: merged.title,
		ownerName: merged.ownerName,
		ownerEmail: merged.ownerEmail,
		uploadDate: merged.uploadDate,
		durationSeconds: merged.durationSeconds,
		viewCount: merged.viewCount,
		commentCount: merged.commentCount,
		sourcePageUrl: input.source.pageUrl,
		videoUrl: input.source.videoUrl,
		description: merged.description,
		transcript: merged.transcript,
		status,
	});

	return { properties, pageContentMarkdown, syncStatus: status };
}

// ---- Status ----

export function pickStatus(oembed: OEmbedResult, scrape: SharePageResult): SyncStatus {
	// "Private" beats "Unavailable" beats "Enriched" beats "Failed". We pick
	// the most specific signal that any source returned.
	if (oembed.status === "private" || scrape.status === "private") return "Private";
	if (oembed.status === "unavailable" || scrape.status === "unavailable") return "Unavailable";
	if (oembed.status === "ok" || scrape.status === "ok") return "Enriched";
	return "Failed";
}

// ---- Merge ----

type MergedFields = {
	title: string;
	thumbnailUrl: string | null;
	durationSeconds: number | null;
	ownerName: string | null;
	ownerEmail: string | null;
	uploadDate: string | null;
	description: string | null;
	viewCount: number | null;
	commentCount: number | null;
	transcript: TranscriptCue[] | null;
};

export function mergeFields(input: ComposeInput): MergedFields {
	const { oembed, scrape, graphql } = input;
	const oembedOk = oembed.status === "ok" ? oembed : null;
	const scrapeOk = scrape.status === "ok" ? scrape : null;
	const graphqlOk = graphql.status === "ok" ? graphql : null;

	// Title fallback ladder: oEmbed → OG/JSON-LD → static.
	const title =
		oembedOk?.title?.trim() ||
		scrapeOk?.title?.trim() ||
		"Untitled Loom video";

	return {
		title,
		thumbnailUrl: oembedOk?.thumbnailUrl ?? scrapeOk?.thumbnailUrl ?? null,
		durationSeconds: oembedOk?.durationSeconds ?? scrapeOk?.durationSeconds ?? null,
		ownerName: graphqlOk?.ownerName ?? oembedOk?.authorName ?? null,
		ownerEmail: graphqlOk?.ownerEmail ?? null,
		uploadDate: scrapeOk?.uploadDate ?? graphqlOk?.createdAt ?? null,
		description: scrapeOk?.description ?? null,
		viewCount: graphqlOk?.viewCount ?? null,
		commentCount: graphqlOk?.commentCount ?? null,
		transcript: graphqlOk?.transcript ?? null,
	};
}

// ---- Markdown body ----

type RenderArgs = {
	title: string;
	ownerName: string | null;
	ownerEmail: string | null;
	uploadDate: string | null;
	durationSeconds: number | null;
	viewCount: number | null;
	commentCount: number | null;
	sourcePageUrl: string;
	videoUrl: string;
	description: string | null;
	transcript: TranscriptCue[] | null;
	status: SyncStatus;
};

export function renderVideoMarkdown(args: RenderArgs): string {
	const parts: string[] = [];

	parts.push(`# ${escapeMarkdown(args.title)}`);
	parts.push("");

	if (args.status !== "Enriched") {
		// Surfacing the status at the top of the page makes it clear in
		// gallery views why a row looks sparse.
		parts.push(`> _Status: ${args.status}. Some fields may be empty._`);
		parts.push("");
	}

	const ownerLine = renderOwnerLine(args.ownerName, args.ownerEmail);
	const metaPieces: string[] = [];
	if (ownerLine) metaPieces.push(`**Owner:** ${ownerLine}`);
	if (args.uploadDate) metaPieces.push(`**Uploaded:** ${escapeMarkdown(args.uploadDate)}`);
	if (args.durationSeconds != null) {
		metaPieces.push(`**Duration:** ${formatDuration(args.durationSeconds)}`);
	}
	if (metaPieces.length) parts.push(metaPieces.join("  |  "));

	const statsPieces: string[] = [];
	if (args.viewCount != null) statsPieces.push(`**Views:** ${args.viewCount}`);
	if (args.commentCount != null) statsPieces.push(`**Comments:** ${args.commentCount}`);
	if (statsPieces.length) parts.push(statsPieces.join("  |  "));

	parts.push(`**Source page:** [${escapeMarkdown(args.sourcePageUrl)}](${args.sourcePageUrl})`);
	parts.push("");
	parts.push(`[Watch on Loom](${args.videoUrl})`);
	parts.push("");

	parts.push("## Description");
	parts.push(args.description?.trim() ? escapeMarkdown(args.description.trim()) : "_No description._");
	parts.push("");

	parts.push("## Transcript");
	if (!args.transcript || args.transcript.length === 0) {
		parts.push("_Transcript not available._");
	} else {
		for (const cue of args.transcript) {
			const ts = formatTimestamp(cue.startSeconds);
			const speaker = cue.speaker?.trim();
			const prefix = speaker ? `**[${ts}] ${escapeMarkdown(speaker)}:**` : `**[${ts}]**`;
			parts.push(`${prefix} ${escapeMarkdown(cue.text.trim())}`);
			parts.push("");
		}
	}

	return parts.join("\n");
}

function renderOwnerLine(name: string | null, email: string | null): string | null {
	const n = name?.trim();
	const e = email?.trim();
	if (n && e) return `${escapeMarkdown(n)} <${escapeMarkdown(e)}>`;
	if (n) return escapeMarkdown(n);
	if (e) return escapeMarkdown(e);
	return null;
}

/** Format seconds as `H:MM:SS` or `M:SS`. */
export function formatDuration(seconds: number): string {
	const total = Math.max(0, Math.round(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) {
		return `${h}:${pad2(m)}:${pad2(s)}`;
	}
	return `${m}:${pad2(s)}`;
}

/** Format a transcript cue timestamp (seconds → `M:SS`). */
export function formatTimestamp(seconds: number): string {
	return formatDuration(seconds);
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

function escapeMarkdown(input: string): string {
	return input
		.replace(/\\/g, "\\\\")
		.replace(/\*/g, "\\*")
		.replace(/_/g, "\\_")
		.replace(/`/g, "\\`")
		.replace(/\[/g, "\\[")
		.replace(/\]/g, "\\]")
		.replace(/</g, "\\<")
		.replace(/>/g, "\\>")
		.replace(/#/g, "\\#");
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1)}…`;
}
