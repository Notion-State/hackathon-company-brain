/**
 * Pure-ish conversions: SlackChannel → Notion change-record properties + page
 * body markdown. "Pure-ish" because resolving the creator's identity requires
 * the async identity cache.
 *
 * All schema-declared properties are emitted on every change record (the SDK's
 * strict mapped type requires it); missing source values get a typed empty fallback.
 */

import * as Builder from "@notionhq/workers/builder";
import { isInternal } from "./internal-domains.js";
import type { IdentityLookup } from "./lookups.js";
import { escapeMarkdown } from "./markdown.js";
import type { SlackChannel } from "./slack.js";

const RICH_TEXT_MAX = 2000;

export type ChannelType = "Public" | "Private" | "Slack Connect";

export function classifyChannelType(ch: SlackChannel): ChannelType {
	if (ch.is_ext_shared) return "Slack Connect";
	if (ch.is_private) return "Private";
	return "Public";
}

export type RenderChannelOpts = {
	identity: IdentityLookup;
	internalDomains: Set<string>;
	teamDomain: string; // workspace subdomain for slack.com URLs; falls back to "app" upstream
	memberEmails: string; // pre-joined comma-separated email list of channel members
};

export async function toChannelChangeProperties(
	channel: SlackChannel,
	opts: RenderChannelOpts,
	now: Date = new Date(),
) {
	const name = `#${channel.name}`;
	const createdIso = epochSecondsToIso(channel.created, now);
	const slackUrl = buildChannelUrl(opts.teamDomain, channel.id);

	let creatorEmail: string | null = null;
	if (channel.creator) {
		const identity = await opts.identity.resolveUser(channel.creator);
		creatorEmail = identity.email;
	}
	const internalCreatorEmails =
		creatorEmail && isInternal(creatorEmail, opts.internalDomains) ? [creatorEmail] : [];

	return {
		Name: Builder.title(name),
		"Channel ID": Builder.richText(channel.id),
		Topic: Builder.richText(clip(escapeMarkdown(channel.topic))),
		Purpose: Builder.richText(clip(escapeMarkdown(channel.purpose))),
		"Member Count": Builder.number(channel.num_members),
		"Is Member": Builder.checkbox(channel.is_member),
		"Is Archived": Builder.checkbox(channel.is_archived),
		"Is Private": Builder.checkbox(channel.is_private),
		"Is Shared": Builder.checkbox(channel.is_shared),
		"Is Externally Shared": Builder.checkbox(channel.is_ext_shared),
		"Member Emails": Builder.richText(clip(opts.memberEmails)),
		"Channel Type": Builder.select(classifyChannelType(channel)),
		Created: Builder.dateTime(createdIso),
		"Creator Email": Builder.email(creatorEmail ?? ""),
		"Internal Creator": Builder.people(...internalCreatorEmails),
		"Slack URL": Builder.url(slackUrl),
		Source: Builder.select("Slack"),
		"Synced At": Builder.dateTime(now.toISOString()),
	};
}

export async function renderChannelMarkdown(channel: SlackChannel, opts: RenderChannelOpts): Promise<string> {
	const name = `#${channel.name}`;
	const created = epochSecondsToIso(channel.created, new Date());
	const slackUrl = buildChannelUrl(opts.teamDomain, channel.id);

	let creatorDisplay = "(unknown)";
	if (channel.creator) {
		const identity = await opts.identity.resolveUser(channel.creator);
		creatorDisplay = identity.displayText;
	}

	const lines: string[] = [];
	lines.push(`# ${escapeMarkdown(name)}`);
	lines.push("");
	lines.push(
		`**Members:** ${channel.num_members}  |  **Created:** ${created}  |  **Created by:** ${escapeMarkdown(creatorDisplay)}`,
	);
	lines.push("");
	lines.push(`**Topic:** ${channel.topic.trim() ? escapeMarkdown(channel.topic) : "_No topic set._"}`);
	lines.push("");
	lines.push(`**Purpose:** ${channel.purpose.trim() ? escapeMarkdown(channel.purpose) : "_No purpose set._"}`);
	lines.push("");
	if (opts.memberEmails) {
		lines.push(`**Member Emails:** ${escapeMarkdown(opts.memberEmails)}`);
		lines.push("");
	}
	lines.push(`[Open in Slack](${slackUrl})`);
	return lines.join("\n");
}

function epochSecondsToIso(seconds: number, fallbackDate: Date): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return fallbackDate.toISOString();
	return new Date(seconds * 1000).toISOString();
}

function buildChannelUrl(teamDomain: string, channelId: string): string {
	const domain = teamDomain || "app";
	return `https://${domain}.slack.com/archives/${channelId}`;
}

function clip(s: string): string {
	if (s.length <= RICH_TEXT_MAX) return s;
	return s.slice(0, RICH_TEXT_MAX - 1) + "…";
}
