/**
 * Pure-ish conversions: `Thread` → Notion change-record properties + page-body
 * markdown. Async because identity resolution is async.
 *
 * Property rationale (`Internal Participants` mirrors fireflies'
 * `Notion State Attendees` at workers/ingest-fireflies/src/render.ts:258):
 * Notion resolves the `Builder.people(...emails)` variadic against workspace
 * users automatically. Emails not matching a workspace user are silently dropped.
 *
 * Markdown rendering: Slack mrkdwn (`<@U…>`, `<#C…|name>`, `<url|label>`,
 * `*bold*`, `_italic_`, `~strike~`) is converted to commonmark before the
 * surrounding template is built. Plain text segments are **not** escaped — see
 * `convertSlackMrkdwn` notes for the rationale.
 */

import * as Builder from "@notionhq/workers/builder";
import { isInternal } from "./internal-domains.js";
import type { IdentityLookup, SlackIdentity } from "./lookups.js";
import { escapeMarkdown } from "./markdown.js";
import type { SlackChannel, SlackFile, SlackMessage } from "./slack.js";
import { slackTsToIso } from "./sync-state.js";
import type { Thread } from "./threads.js";

const TITLE_MAX = 80;
const RICH_TEXT_MAX = 2000;

export function recordId(channelId: string, threadTs: string): string {
	return `${channelId}:${threadTs}`;
}

export function buildTitle(parent: SlackMessage, channel: SlackChannel): string {
	const raw = (parent.text ?? "").replace(/\s+/g, " ").trim();
	if (!raw) return `[Message in #${channel.name}]`;
	if (raw.length <= TITLE_MAX) return raw;
	return raw.slice(0, TITLE_MAX - 1) + "…";
}

export type RenderThreadOpts = {
	identity: IdentityLookup;
	internalDomains: Set<string>;
	permalink: string | null; // fetched by the executor via client.getPermalink
};

export async function toThreadChangeProperties(
	thread: Thread,
	channel: SlackChannel,
	opts: RenderThreadOpts,
	now: Date = new Date(),
) {
	const { parent, replies, latestTs, hasAttachments, totalReactionCount } = thread;
	const authorIdentity = await opts.identity.resolveMessageAuthor(parent);
	const participants = await collectParticipants(parent, replies, opts.identity);

	const internalEmails = participants
		.map((p) => p.email)
		.filter((e): e is string => Boolean(e) && isInternal(e, opts.internalDomains));
	const uniqueInternalEmails = [...new Set(internalEmails)];
	const participantNames = [...new Set(participants.map((p) => p.displayText))];

	return {
		Title: Builder.title(buildTitle(parent, channel)),
		"Record ID": Builder.richText(recordId(channel.id, parent.ts)),
		Channel: [Builder.relation(channel.id)],
		Author: Builder.richText(authorIdentity.displayText),
		"Author Email": Builder.email(authorIdentity.email ?? ""),
		"Internal Participants": Builder.people(...uniqueInternalEmails),
		"Thread Participants": Builder.richText(clip(participantNames.join(", "))),
		"Posted At": Builder.dateTime(slackTsToIso(parent.ts)),
		"Last Activity": Builder.dateTime(slackTsToIso(latestTs)),
		"Reply Count": Builder.number(replies.length),
		"Reaction Count": Builder.number(totalReactionCount),
		"Has Attachments": Builder.checkbox(hasAttachments),
		Permalink: Builder.url(opts.permalink ?? ""),
		Source: Builder.select("Slack"),
		"Synced At": Builder.dateTime(now.toISOString()),
	};
}

export async function renderThreadMarkdown(
	thread: Thread,
	channel: SlackChannel,
	opts: RenderThreadOpts,
): Promise<string> {
	const { parent, replies } = thread;
	const authorIdentity = await opts.identity.resolveMessageAuthor(parent);
	const participants = await collectParticipants(parent, replies, opts.identity);
	const participantNames = [...new Set(participants.map((p) => p.displayText))];
	const title = buildTitle(parent, channel);

	const lines: string[] = [];
	lines.push(`# ${escapeMarkdown(title)}`);
	lines.push("");
	lines.push(
		`**Channel:** #${escapeMarkdown(channel.name)}  |  **Posted:** ${slackTsToIso(parent.ts)}  |  **Replies:** ${replies.length}`,
	);
	lines.push(`**Author:** ${escapeMarkdown(authorIdentity.displayText)}`);
	lines.push(`**Participants:** ${participantNames.length ? escapeMarkdown(participantNames.join(", ")) : "_None_"}`);
	lines.push("");
	if (opts.permalink) {
		lines.push(`[View in Slack](${opts.permalink})`);
		lines.push("");
	}
	lines.push("## Thread");
	lines.push("");

	for (const m of [parent, ...replies]) {
		const ident = m === parent ? authorIdentity : await opts.identity.resolveMessageAuthor(m);
		const convertedText = await convertSlackMrkdwn(m.text, opts.identity);
		lines.push(`**${escapeMarkdown(ident.displayText)} — ${slackTsToIso(m.ts)}**`);
		lines.push(convertedText || "_(no text)_");
		for (const f of m.files) {
			lines.push(`- 📎 [${escapeMarkdown(f.name)}](${fileUrl(f)})`);
		}
		lines.push("");
	}

	return lines.join("\n").trimEnd() + "\n";
}

async function collectParticipants(
	parent: SlackMessage,
	replies: SlackMessage[],
	identity: IdentityLookup,
): Promise<SlackIdentity[]> {
	// De-dupe by Slack user/bot id so we don't repeat the same person.
	const seen = new Set<string>();
	const out: SlackIdentity[] = [];
	for (const m of [parent, ...replies]) {
		const key = m.bot_id ? `bot:${m.bot_id}` : m.user ? `user:${m.user}` : `anon:${m.ts}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(await identity.resolveMessageAuthor(m));
	}
	return out;
}

function fileUrl(f: SlackFile): string {
	return f.permalink ?? f.url_private ?? "";
}

function clip(s: string): string {
	if (s.length <= RICH_TEXT_MAX) return s;
	return s.slice(0, RICH_TEXT_MAX - 1) + "…";
}

// ---- Slack mrkdwn → commonmark ----

/**
 * Convert Slack's mrkdwn flavor to commonmark.
 *
 * NOT escaped: we don't run `escapeMarkdown` on the result because converting
 * `<url|label>` to `[label](url)` produces brackets we *want* to keep. The
 * tradeoff: a user can inject markdown (e.g., a fake link) into their message
 * and it will render. Acceptable for the inline thread body — the surrounding
 * template (headers, metadata, permalink) uses our own escaped strings, so
 * structural integrity of the page is preserved. Notion blocks aren't HTML
 * so XSS doesn't apply.
 *
 * User mentions are resolved via the identity cache; unknown users render as
 * `@user`. Channel mentions use the inline `|name` Slack provides; absent
 * that, we render `#${channelId}` since we don't have a channel-name lookup
 * here (deliberately — keeps render-threads decoupled from channel listing).
 */
export async function convertSlackMrkdwn(text: string, identity: IdentityLookup): Promise<string> {
	if (!text) return "";

	// 1. Pre-resolve user mentions in parallel.
	const userIds = new Set<string>();
	for (const m of text.matchAll(/<@(U[A-Z0-9_]+)(?:\|[^>]+)?>/g)) {
		userIds.add(m[1]!);
	}
	const handleById = new Map<string, string>();
	await Promise.all(
		[...userIds].map(async (id) => {
			const ident = await identity.resolveUser(id);
			handleById.set(id, extractHandle(ident.displayText));
		}),
	);

	let out = text;

	// User mention: <@U…> or <@U…|alt-label>
	out = out.replace(/<@(U[A-Z0-9_]+)(?:\|([^>]+))?>/g, (_full, id: string, alt?: string) => {
		if (alt) return `@${alt}`;
		const handle = handleById.get(id);
		return handle ? `@${handle}` : "@user";
	});

	// Channel mention: <#C…|name> or <#C…>
	out = out.replace(/<#(C[A-Z0-9_]+)(?:\|([^>]+))?>/g, (_full, id: string, name?: string) => `#${name || id}`);

	// User group: <!subteam^S…|name>
	out = out.replace(/<!subteam\^(S[A-Z0-9_]+)(?:\|([^>]+))?>/g, (_full, id: string, name?: string) => `@${name || id}`);

	// Special mentions
	out = out.replace(/<!(here|channel|everyone)>/g, (_full, kw: string) => `@${kw}`);

	// Date entity: <!date^123|fallback>
	out = out.replace(/<!date\^\d+(?:\^[^|>]+)?\|([^>]+)>/g, (_full, label: string) => label);

	// URL with label: <url|label>
	out = out.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, (_full, url: string, label: string) => `[${label}](${url})`);

	// Bare URL: <url>
	out = out.replace(/<(https?:\/\/[^>]+)>/g, (_full, url: string) => url);

	// Slack HTML entities
	out = out.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

	// Bold: *foo* → **foo**. Skip when adjacent * present (already bold or list markers).
	out = out.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, (_full, pre: string, inner: string) => `${pre}**${inner}**`);

	// Italic: _foo_ → *foo*. Require non-word boundaries so file_names don't trigger.
	out = out.replace(/(^|[^\w_])_([^_\s][^_]*?)_(?![\w_])/g, (_full, pre: string, inner: string) => `${pre}*${inner}*`);

	// Strikethrough: ~foo~ → ~~foo~~
	out = out.replace(/(^|[^~])~([^~\s][^~]*?)~(?!~)/g, (_full, pre: string, inner: string) => `${pre}~~${inner}~~`);

	return out;
}

function extractHandle(displayText: string): string {
	// IdentityLookup formats as "Real Name (@handle)". Pull out handle.
	const m = displayText.match(/\(@([^)]+)\)/);
	return m ? m[1]! : "user";
}
