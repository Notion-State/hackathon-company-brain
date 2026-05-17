/**
 * Hand-built Slack message fixtures for thread / render tests.
 *
 * Shapes mirror `SlackMessage` from src/slack.ts (already normalized — no raw
 * SDK shapes here). Use the `msg()` helper to fill in defaults; override only
 * the fields each test cares about.
 */

import type { SlackMessage, SlackReaction } from "../slack.js";

export function msg(overrides: Partial<SlackMessage> = {}): SlackMessage {
	return {
		ts: "1715898253.000100",
		thread_ts: null,
		type: "message",
		subtype: null,
		text: "hello world",
		user: "U001",
		bot_id: null,
		username: null,
		edited_ts: null,
		reply_count: 0,
		latest_reply: null,
		reactions: [],
		files: [],
		attachments_count: 0,
		...overrides,
	};
}

export function reaction(name: string, count: number): SlackReaction {
	return { name, count };
}

export const ALICE_HUMAN_MESSAGE = msg({
	ts: "1715898253.000100",
	user: "U_ALICE",
	text: "Hey team, what do we think about migrating to *Bun*?",
});

export const BOB_REPLY = msg({
	ts: "1715898400.000200",
	thread_ts: "1715898253.000100",
	user: "U_BOB",
	text: "Curious — what's the upside?",
});

export const CAROL_REPLY = msg({
	ts: "1715898600.000300",
	thread_ts: "1715898253.000100",
	user: "U_CAROL",
	text: "I'd want benchmarks first.",
});

export const CHANNEL_JOIN_NOISE = msg({
	ts: "1715898500.000150",
	thread_ts: "1715898253.000100",
	user: "U_DAVE",
	subtype: "channel_join",
	text: "<@U_DAVE> has joined the channel",
});

export const TOMBSTONE_PARENT = msg({
	ts: "1715000000.000000",
	subtype: "tombstone",
	text: "This message was deleted.",
	reply_count: 2,
});

export const BOT_PARENT = msg({
	ts: "1715800000.000000",
	bot_id: "B_CI",
	username: "ci-bot",
	subtype: "bot_message",
	user: null,
	text: "Deploy completed: v1.2.3",
});

export const FILE_SHARE_MESSAGE = msg({
	ts: "1715900000.000000",
	user: "U_ALICE",
	subtype: "file_share",
	text: "Here's the spec",
	files: [
		{
			id: "F001",
			name: "spec.pdf",
			mimetype: "application/pdf",
			url_private: "https://files.slack.com/files-pri/T1-F001/spec.pdf",
			url_private_download: "https://files.slack.com/files-pri/T1-F001/download/spec.pdf",
			permalink: "https://acme.slack.com/files/U_ALICE/F001/spec.pdf",
		},
	],
});

export const IMAGE_SHARE_MESSAGE = msg({
	ts: "1715900100.000000",
	user: "U_ALICE",
	subtype: "file_share",
	text: "Check this screenshot",
	files: [
		{
			id: "F002",
			name: "screenshot.png",
			mimetype: "image/png",
			url_private: "https://files.slack.com/files-pri/T1-F002/screenshot.png",
			url_private_download: "https://files.slack.com/files-pri/T1-F002/download/screenshot.png",
			permalink: "https://acme.slack.com/files/U_ALICE/F002/screenshot.png",
		},
	],
});

export const REACTIONS_MESSAGE = msg({
	ts: "1715900200.000000",
	user: "U_ALICE",
	text: "Ship it!",
	reactions: [
		{ name: "thumbsup", count: 3 },
		{ name: "tada", count: 2 },
		{ name: "custom_company_emoji", count: 1 },
	],
});

export const REPLY_BROADCAST = msg({
	ts: "1715898400.000200",
	thread_ts: "1715898253.000100",
	subtype: "thread_broadcast",
	user: "U_BOB",
	text: "Echoed to channel",
});
