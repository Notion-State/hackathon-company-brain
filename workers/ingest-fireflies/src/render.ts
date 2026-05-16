/**
 * Pure conversions: Fireflies `Transcript` → Notion page body markdown and
 * change-record properties. Tested.
 */

import * as Builder from "@notionhq/workers/builder";
import type { Transcript } from "./fireflies.js";

/**
 * Builds the composite primary key. Two accounts that both see a shared
 * meeting produce two distinct rows (one per account), each keyed by its own
 * `${accountId}:${transcriptId}` rather than racing to overwrite.
 */
export function recordId(accountId: string, transcriptId: string): string {
	return `${accountId}:${transcriptId}`;
}

/** Escape characters that markdown would interpret as formatting. */
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

function durationMinutes(rawMinutes: number | null | undefined): number | null {
	// Fireflies returns `duration` as float minutes (verified empirically; the
	// public docs say seconds but actual responses are minutes).
	if (rawMinutes == null || Number.isNaN(rawMinutes)) return null;
	return Math.max(0, Math.round(rawMinutes));
}

function attendeeNames(t: Transcript): string[] {
	const out: string[] = [];
	for (const a of t.meeting_attendees ?? []) {
		const name = a.displayName?.trim();
		if (name) out.push(name);
	}
	return out;
}

function speakerNames(t: Transcript): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const s of t.speakers ?? []) {
		const name = s.name?.trim();
		if (!name || seen.has(name)) continue;
		seen.add(name);
		out.push(name);
	}
	return out;
}

function normalizeActionItems(items: string | string[] | null | undefined): string[] {
	if (items == null) return [];
	if (Array.isArray(items)) return items.map((s) => s.trim()).filter(Boolean);
	// Fireflies sometimes returns a single string with newline-separated bullets.
	return items
		.split("\n")
		.map((line) => line.replace(/^[-*•]\s*/, "").trim())
		.filter(Boolean);
}

function normalizeKeywords(keywords: string[] | null | undefined): string[] {
	if (!keywords) return [];
	return keywords.map((k) => k.trim()).filter(Boolean);
}

/**
 * Render the page body as markdown. The workers runtime converts this to
 * Notion blocks — we don't need to chunk manually.
 */
export function renderTranscriptMarkdown(t: Transcript): string {
	const title = t.title?.trim() || "Untitled meeting";
	const date = t.date ?? "(unknown date)";
	const mins = durationMinutes(t.duration);
	const host = t.host_email?.trim() || "(unknown host)";
	const attendees = attendeeNames(t);
	const actionItems = normalizeActionItems(t.summary?.action_items);
	const keywords = normalizeKeywords(t.summary?.keywords);
	const overview = t.summary?.overview?.trim() ?? "";

	const parts: string[] = [];
	parts.push(`# ${escapeMarkdown(title)}`);
	parts.push("");
	const metaLine =
		`**Date:** ${escapeMarkdown(date)}  |  ` +
		`**Duration:** ${mins == null ? "(unknown)" : `${mins} min`}  |  ` +
		`**Host:** ${escapeMarkdown(host)}`;
	parts.push(metaLine);
	parts.push(`**Attendees:** ${attendees.length ? escapeMarkdown(attendees.join(", ")) : "_None recorded_"}`);
	parts.push("");

	parts.push("## Summary");
	parts.push(overview ? escapeMarkdown(overview) : "_No summary available._");
	parts.push("");

	parts.push("## Action Items");
	if (actionItems.length === 0) {
		parts.push("_No action items captured._");
	} else {
		for (const item of actionItems) {
			parts.push(`- ${escapeMarkdown(item)}`);
		}
	}
	parts.push("");

	parts.push("## Keywords");
	parts.push(keywords.length ? escapeMarkdown(keywords.join(", ")) : "_No keywords extracted._");
	parts.push("");

	parts.push("## Transcript");
	parts.push("");
	const sentences = t.sentences ?? [];
	if (sentences.length === 0) {
		parts.push("_No transcript text available._");
	} else {
		for (const s of sentences) {
			const speaker = s.speaker_name?.trim() || "Unknown";
			const text = s.text?.trim() ?? "";
			if (!text) continue;
			parts.push(`**${escapeMarkdown(speaker)}:** ${escapeMarkdown(text)}`);
			parts.push("");
		}
	}

	return parts.join("\n");
}

/**
 * Build the Notion property map for a change record.
 *
 * The SDK's `SyncChangeUpsert` type requires every schema-declared property to
 * appear in every change record (a strict mapped type over `keyof Schema`).
 * So we always emit every property; missing source values get a typed empty
 * fallback (empty string for text/url/email, `now` for dates, 0 for number)
 * rather than being omitted.
 */
export function toChangeProperties(t: Transcript, accountId: string, now: Date = new Date()) {
	const title = t.title?.trim() || "Untitled meeting";
	const composite = recordId(accountId, t.id);
	const mins = durationMinutes(t.duration);
	const speakers = speakerNames(t);
	const attendees = attendeeNames(t);
	const hostEmail = t.host_email?.trim();
	const validHostEmail = hostEmail && /.+@.+\..+/.test(hostEmail) ? hostEmail : "";
	// Defense in depth: the client normalizes Fireflies' epoch-ms `date` to ISO,
	// but if any non-string slips through, fall back to `now` so Builder.dateTime
	// never sees a number it'd reject.
	const meetingDateIso = typeof t.date === "string" && t.date.length > 0 ? t.date : now.toISOString();

	return {
		Title: Builder.title(title),
		"Record ID": Builder.richText(composite),
		"Transcript ID": Builder.richText(t.id),
		Account: Builder.select(accountId),
		"Meeting Date": Builder.dateTime(meetingDateIso),
		"Duration (min)": Builder.number(mins ?? 0),
		Host: Builder.email(validHostEmail),
		Attendees: Builder.richText(attendees.join(", ")),
		Speakers: Builder.richText(speakers.join(", ")),
		"Transcript URL": Builder.url(t.transcript_url ?? ""),
		Source: Builder.select("Fireflies"),
		"Synced At": Builder.dateTime(now.toISOString()),
	};
}
