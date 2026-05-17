/**
 * Pure formatter for the AI Drafts `Location` property per the AI Drafts
 * Trigger and Return spec:
 *
 *   Client OS: [Aduro Advisors – Drafts Inbox](https://...)
 *   NS OS:    [Notion State – Drafts Inbox](https://...)
 *
 * One line per destination, label-prefixed, link text + URL as Markdown.
 * Empty input → empty string (used to clear `Location` on cases where there's
 * nothing to report).
 *
 * Link-text characters `[`, `]`, `\` are escaped so Notion renders them as
 * literals instead of breaking the link parse. URLs are passed through as-is
 * (Notion handles URL encoding).
 */

import type { DraftDispatchSide } from "./errors.js";

export const DESTINATION_LABEL: Record<DraftDispatchSide, string> = {
	ClientOS: "Client OS",
	NSOS: "NS OS",
};

export type LocationEntry = {
	side: DraftDispatchSide;
	linkText: string;
	url: string;
};

export function formatLocation(entries: LocationEntry[]): string {
	if (entries.length === 0) return "";
	return entries.map(formatEntry).join("\n");
}

function formatEntry(entry: LocationEntry): string {
	const label = DESTINATION_LABEL[entry.side];
	const text = escapeLinkText(entry.linkText);
	return `${label}: [${text}](${entry.url})`;
}

/**
 * Escape characters that would break Markdown link parsing inside the link
 * text. Notion's renderer treats `]` as the close of the link text and `[` as
 * a nested open; `\` is the escape character so we double it.
 */
function escapeLinkText(text: string): string {
	return text.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}
