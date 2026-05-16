/**
 * Slack message subtypes that represent channel-bookkeeping events rather than
 * conversational content (joins, leaves, topic changes, pins). These are
 * dropped from every ingested thread.
 *
 * Reference: https://api.slack.com/events/message — "subtypes" section.
 *
 * Deliberately NOT included:
 * - `bot_message` — bots are first-class authors per project decision.
 * - `me_message` — `/me`-style messages carry user text and are valid content.
 * - `thread_broadcast` — a reply that was also broadcast to the channel; we
 *   handle de-duplication separately when walking history vs. replies.
 * - `file_share` — message with attached file(s); body is real content.
 * - undefined — a normal message with no subtype is the common case.
 */
export const SYSTEM_EVENT_SUBTYPES: ReadonlySet<string> = new Set([
	"channel_join",
	"channel_leave",
	"channel_topic",
	"channel_purpose",
	"channel_name",
	"channel_archive",
	"channel_unarchive",
	"channel_convert_to_private",
	"channel_convert_to_public",
	"pinned_item",
	"unpinned_item",
	"bot_add",
	"bot_remove",
]);

export function isSystemEvent(msg: { subtype?: string | null | undefined }): boolean {
	return msg.subtype != null && SYSTEM_EVENT_SUBTYPES.has(msg.subtype);
}

/**
 * A `tombstone` parent indicates Slack returned a thread whose top-level
 * message has been deleted. The thread shell remains but carries no signal —
 * we drop these and let the backfill mark-and-sweep clean up.
 */
export function isTombstone(msg: { subtype?: string | null | undefined }): boolean {
	return msg.subtype === "tombstone";
}
