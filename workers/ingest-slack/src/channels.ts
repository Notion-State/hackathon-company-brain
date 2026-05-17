/**
 * Channel discovery + filtering + optional auto-join.
 *
 * The single source of truth for "which channels are in scope for ingest." Both
 * the channels sync and the messages syncs go through this function so the
 * filter rules can't drift.
 *
 * Scope: all non-archived channels (public, private, shared, externally shared).
 *
 * `autoJoin: true` — channels sync. Bot joins any qualifying channel it isn't
 *   already in. Visible "X joined the channel" message in Slack is unavoidable.
 *
 * `autoJoin: false` — messages syncs. Returns only channels the bot is already
 *   a member of; non-member channels are silently dropped (the channels sync
 *   will get to them on its next cycle).
 */

import type { SlackChannel, SlackClient } from "./slack.js";

export type DiscoverOpts = { autoJoin: boolean };

/**
 * Returns the eligible-channel list, fully paginated. With `autoJoin: true`,
 * also calls `conversations.join` on any returned channel where the bot isn't
 * already a member.
 *
 * Filter: drops only archived channels. All non-archived channels (public,
 * private, shared, externally shared) are in scope.
 * With `autoJoin: false`, additionally drops non-member channels.
 */
export async function discoverEligibleChannels(
	client: SlackClient,
	opts: DiscoverOpts,
): Promise<SlackChannel[]> {
	const eligible: SlackChannel[] = [];
	let cursor: string | undefined;
	for (;;) {
		const page = await client.listChannels(cursor);
		for (const ch of page.channels) {
			if (!isEligible(ch)) continue;
			eligible.push(ch);
		}
		if (!page.nextCursor) break;
		cursor = page.nextCursor;
	}

	if (opts.autoJoin) {
		for (const ch of eligible) {
			if (ch.is_member) continue;
			const r = await client.joinChannel(ch.id);
			if (r.ok) {
				ch.is_member = true;
			}
			// On non-ok, leave is_member=false; downstream filters will skip this
			// channel for messages, but the channels-sync still records it so the
			// operator can see why ingest is stalled on it.
		}
		return eligible;
	}

	return eligible.filter((c) => c.is_member);
}

/** Pure: returns true when a channel passes the in-scope filter (non-archived). */
export function isEligible(c: SlackChannel): boolean {
	if (c.is_archived) return false;
	return true;
}
