/**
 * Thread assembly: turn a top-level Slack message into a `Thread` aggregate
 * with its full reply chain, ready for property/markdown rendering.
 *
 * - Tombstone parents (deleted top-level message) → returns `null`.
 * - System-event parents → returns `null` (defensive; `conversations.history`
 *   shouldn't surface these, but a future Slack change could).
 * - Messages where `thread_ts` is set and differs from `ts` are reply
 *   broadcasts surfaced at the channel level — caller is expected to filter
 *   these out, but `assembleThread` also returns `null` for them as a safety net.
 * - Replies that are system events are filtered out of the thread; the thread
 *   itself stays.
 *
 * The parent's reactions/files are taken from `conversations.replies` when
 * available — that endpoint returns up-to-date reaction counts and the
 * canonical edited text — falling back to the history-page parent shape when
 * the replies fetch returns no matching entry (a rare race).
 */

import type { SlackClient, SlackMessage } from "./slack.js";
import { isSystemEvent, isTombstone } from "./system-events.js";

export type Thread = {
	parent: SlackMessage;
	replies: SlackMessage[]; // excludes the parent
	latestTs: string; // max(parent.ts, ...replies[].ts)
	hasAttachments: boolean;
	totalReactionCount: number;
};

export async function assembleThread(
	client: SlackClient,
	channelId: string,
	parentFromHistory: SlackMessage,
): Promise<Thread | null> {
	if (isTombstone(parentFromHistory)) return null;
	if (isSystemEvent(parentFromHistory)) return null;
	// Reply broadcasts: thread_ts set, but not equal to ts → this is a reply, not a thread root.
	if (parentFromHistory.thread_ts && parentFromHistory.thread_ts !== parentFromHistory.ts) return null;

	let parent = parentFromHistory;
	let replies: SlackMessage[] = [];

	if (parentFromHistory.reply_count > 0) {
		const all = await client.repliesAll(channelId, parentFromHistory.ts);
		const canonicalParent = all.find((m) => m.ts === parentFromHistory.ts) ?? parentFromHistory;
		// Re-check: the canonical parent may now be a tombstone (deleted between history list and replies fetch).
		if (isTombstone(canonicalParent)) return null;
		parent = canonicalParent;
		replies = all.filter((m) => m.ts !== parent.ts && !isSystemEvent(m) && !isTombstone(m));
	}

	const latestTs = computeLatestTs(parent, replies);
	const hasAttachments = aggregateAttachments(parent, replies);
	const totalReactionCount = aggregateReactions(parent, replies);

	return { parent, replies, latestTs, hasAttachments, totalReactionCount };
}

function computeLatestTs(parent: SlackMessage, replies: SlackMessage[]): string {
	let latest = parent.ts;
	for (const r of replies) {
		if (r.ts > latest) latest = r.ts; // fixed-width slack ts: lex compare == numeric compare
	}
	return latest;
}

function aggregateAttachments(parent: SlackMessage, replies: SlackMessage[]): boolean {
	if (parent.files.length > 0 || parent.attachments_count > 0) return true;
	for (const r of replies) {
		if (r.files.length > 0 || r.attachments_count > 0) return true;
	}
	return false;
}

function aggregateReactions(parent: SlackMessage, replies: SlackMessage[]): number {
	let total = parent.reactions.reduce((s, r) => s + r.count, 0);
	for (const r of replies) total += r.reactions.reduce((s, x) => s + x.count, 0);
	return total;
}
