/**
 * Pure conversions: Fireflies `Transcript` → Notion page body markdown and
 * change-record properties. Tested.
 */

import * as Builder from "@notionhq/workers/builder";
import type { Transcript } from "./fireflies.js";
import { extractDomain, isInternal } from "./internal-domains.js";
import type { CompaniesLookup } from "./lookups.js";

/** Notion rich_text per-text-element cap. Long summaries must be sliced. */
const RICH_TEXT_MAX = 2000;

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

function attendeeEmails(t: Transcript): string[] {
	const out: string[] = [];
	for (const a of t.meeting_attendees ?? []) {
		const email = a.email?.trim();
		if (email) out.push(email);
	}
	return out;
}

function uniqueAttendeeDomains(t: Transcript): string[] {
	const seen = new Set<string>();
	for (const email of attendeeEmails(t)) {
		const d = extractDomain(email);
		if (d) seen.add(d);
	}
	return [...seen];
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

/** Build a lowercase displayName → email map for sentence-speaker lookup. */
function attendeeEmailByName(t: Transcript): Map<string, string> {
	const out = new Map<string, string>();
	for (const a of t.meeting_attendees ?? []) {
		const name = a.displayName?.trim().toLowerCase();
		const email = a.email?.trim();
		if (name && email) out.set(name, email);
	}
	return out;
}

/**
 * Compute the fraction of meeting talk time spent by internal speakers.
 * Returns 0 when no sentences carry usable timings.
 *
 * Speakers are matched to attendees by displayName (Fireflies' `speaker_name`
 * is the attendee's display name in practice). Sentences whose speaker can't
 * be matched count toward total time but not toward NS time.
 */
export function nsTalkPercent(t: Transcript, internalDomains: Set<string>): number {
	const byName = attendeeEmailByName(t);
	let total = 0;
	let ns = 0;
	for (const s of t.sentences ?? []) {
		if (s.start_time == null || s.end_time == null) continue;
		const dur = s.end_time - s.start_time;
		if (!Number.isFinite(dur) || dur <= 0) continue;
		total += dur;
		const speaker = s.speaker_name?.trim().toLowerCase();
		const email = speaker ? byName.get(speaker) : undefined;
		if (email && isInternal(email, internalDomains)) ns += dur;
	}
	if (total <= 0) return 0;
	return ns / total;
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
 * appear in every change record (strict mapped type). All properties below are
 * emitted unconditionally; missing source values get a typed empty fallback.
 */
export function toChangeProperties(
	t: Transcript,
	accountId: string,
	internalDomains: Set<string>,
	companies: CompaniesLookup,
	now: Date = new Date(),
) {
	const title = t.title?.trim() || "Untitled meeting";
	const composite = recordId(accountId, t.id);
	const mins = durationMinutes(t.duration);
	const speakers = speakerNames(t);
	const attendeeDisplayNames = attendeeNames(t);
	const emails = attendeeEmails(t);
	const domains = uniqueAttendeeDomains(t);
	const internalEmails = emails.filter((e) => isInternal(e, internalDomains));

	// Internal/External: every attendee internal → Internal; otherwise External.
	// Empty attendee list → External (defensive — meetings with no captured
	// attendees default to the more permissive bucket downstream).
	const allInternal = emails.length > 0 && emails.every((e) => isInternal(e, internalDomains));
	const internalExternal = allInternal ? "Internal" : "External";

	const overview = t.summary?.overview?.trim() ?? "";
	const summaryText = overview.length > RICH_TEXT_MAX ? overview.slice(0, RICH_TEXT_MAX - 1) + "…" : overview;
	const keywordsText = normalizeKeywords(t.summary?.keywords).join(", ");

	// Defense in depth: the client normalizes Fireflies' epoch-ms `date` to ISO,
	// but if any non-string slips through, fall back to `now` so Builder.dateTime
	// never sees a number it'd reject.
	const meetingDateIso = typeof t.date === "string" && t.date.length > 0 ? t.date : now.toISOString();

	// Companies: dedupe matched names; preserves order of first appearance.
	const seenCompanies = new Set<string>();
	const companyNames: string[] = [];
	for (const d of domains) {
		const name = companies.companyNameByDomain(d);
		if (name && !seenCompanies.has(name)) {
			seenCompanies.add(name);
			companyNames.push(name);
		}
	}

	return {
		"Meeting Title": Builder.title(title),
		"Record ID": Builder.richText(composite),
		"Fireflies Meeting ID": Builder.richText(t.id),
		Account: Builder.select(accountId),
		"Meeting Date": Builder.dateTime(meetingDateIso),
		"Duration (min)": Builder.number(mins ?? 0),
		"Internal/External": Builder.select(internalExternal),
		Summary: Builder.richText(summaryText),
		Keywords: Builder.richText(keywordsText),
		Attendees: Builder.richText(attendeeDisplayNames.join(", ")),
		"Attendee Count": Builder.number(emails.length),
		"Participant Emails": Builder.richText(emails.join(", ")),
		Speakers: Builder.richText(speakers.join(", ")),
		"Notion State Attendees": Builder.people(...internalEmails),
		"NS Talk %": Builder.number(nsTalkPercent(t, internalDomains)),
		Companies: Builder.richText(companyNames.join(", ")),
		"Company Domains": Builder.richText(domains.join(", ")),
		"Transcript URL": Builder.url(t.transcript_url ?? ""),
		"Recording Status": Builder.select("Transcribed"),
		Source: Builder.select("Fireflies"),
		"Synced At": Builder.dateTime(now.toISOString()),
	};
}
