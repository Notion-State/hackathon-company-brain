import { describe, expect, it, vi } from "vitest";
import {
	ALICE_HUMAN_MESSAGE,
	BOB_REPLY,
	BOT_PARENT,
	CAROL_REPLY,
	CHANNEL_JOIN_NOISE,
	FILE_SHARE_MESSAGE,
	REPLY_BROADCAST,
	TOMBSTONE_PARENT,
	msg,
	reaction,
} from "./fixtures/messages.js";
import type { SlackClient } from "./slack.js";
import { assembleThread } from "./threads.js";

function makeClient(overrides: Partial<SlackClient> = {}): SlackClient {
	const base: SlackClient = {
		listPublicChannels: vi.fn(),
		joinChannel: vi.fn(),
		historyPage: vi.fn(),
		repliesAll: vi.fn(),
		usersInfo: vi.fn(),
		botsInfo: vi.fn(),
		getPermalink: vi.fn(),
		teamInfo: vi.fn(),
	};
	return { ...base, ...overrides };
}

describe("assembleThread", () => {
	it("returns null for tombstone parents", async () => {
		const repliesAll = vi.fn();
		const client = makeClient({ repliesAll });
		const out = await assembleThread(client, "C001", TOMBSTONE_PARENT);
		expect(out).toBeNull();
		expect(repliesAll).not.toHaveBeenCalled();
	});

	it("returns null for reply broadcasts that surface at the channel level", async () => {
		const repliesAll = vi.fn();
		const client = makeClient({ repliesAll });
		const out = await assembleThread(client, "C001", REPLY_BROADCAST);
		expect(out).toBeNull();
		expect(repliesAll).not.toHaveBeenCalled();
	});

	it("returns null for system-event parents (defensive)", async () => {
		const out = await assembleThread(
			makeClient(),
			"C001",
			msg({ subtype: "channel_topic", text: "<@U001> set the topic..." }),
		);
		expect(out).toBeNull();
	});

	it("does not call repliesAll when parent has zero replies (single-message thread)", async () => {
		const repliesAll = vi.fn();
		const client = makeClient({ repliesAll });
		const out = await assembleThread(client, "C001", ALICE_HUMAN_MESSAGE);
		expect(repliesAll).not.toHaveBeenCalled();
		expect(out).not.toBeNull();
		expect(out!.parent.ts).toBe(ALICE_HUMAN_MESSAGE.ts);
		expect(out!.replies).toEqual([]);
		expect(out!.latestTs).toBe(ALICE_HUMAN_MESSAGE.ts);
	});

	it("calls repliesAll when parent has replies and filters system events out of replies", async () => {
		const parent = { ...ALICE_HUMAN_MESSAGE, reply_count: 2, latest_reply: CAROL_REPLY.ts };
		const repliesAll = vi.fn().mockResolvedValue([parent, BOB_REPLY, CHANNEL_JOIN_NOISE, CAROL_REPLY]);
		const client = makeClient({ repliesAll });
		const out = await assembleThread(client, "C001", parent);
		expect(repliesAll).toHaveBeenCalledWith("C001", parent.ts);
		expect(out).not.toBeNull();
		expect(out!.replies.map((r) => r.ts)).toEqual([BOB_REPLY.ts, CAROL_REPLY.ts]);
		expect(out!.latestTs).toBe(CAROL_REPLY.ts);
	});

	it("uses the canonical parent from repliesAll (carries edited text, latest reactions)", async () => {
		const historyParent = { ...ALICE_HUMAN_MESSAGE, reply_count: 1, latest_reply: BOB_REPLY.ts };
		const canonicalParent = {
			...historyParent,
			text: "Hey team, what do we think about migrating to *Bun*? (edited)",
			edited_ts: "1715900000.000000",
			reactions: [reaction("thumbsup", 3)],
		};
		const repliesAll = vi.fn().mockResolvedValue([canonicalParent, BOB_REPLY]);
		const client = makeClient({ repliesAll });
		const out = await assembleThread(client, "C001", historyParent);
		expect(out!.parent.text).toContain("(edited)");
		expect(out!.parent.reactions).toEqual([{ name: "thumbsup", count: 3 }]);
	});

	it("returns null if the parent comes back as a tombstone in repliesAll (race)", async () => {
		const parent = { ...ALICE_HUMAN_MESSAGE, reply_count: 1, latest_reply: BOB_REPLY.ts };
		const tombstoned = { ...parent, subtype: "tombstone", text: "This message was deleted." };
		const repliesAll = vi.fn().mockResolvedValue([tombstoned, BOB_REPLY]);
		const client = makeClient({ repliesAll });
		const out = await assembleThread(client, "C001", parent);
		expect(out).toBeNull();
	});

	it("aggregates reaction counts across parent and replies", async () => {
		const parent = {
			...ALICE_HUMAN_MESSAGE,
			reply_count: 1,
			latest_reply: BOB_REPLY.ts,
			reactions: [reaction("thumbsup", 3), reaction("eyes", 2)],
		};
		const reply = { ...BOB_REPLY, reactions: [reaction("rocket", 4)] };
		const repliesAll = vi.fn().mockResolvedValue([parent, reply]);
		const client = makeClient({ repliesAll });
		const out = await assembleThread(client, "C001", parent);
		expect(out!.totalReactionCount).toBe(3 + 2 + 4);
	});

	it("hasAttachments true when any thread message carries files", async () => {
		const parent = { ...ALICE_HUMAN_MESSAGE, reply_count: 1, latest_reply: FILE_SHARE_MESSAGE.ts };
		const repliesAll = vi.fn().mockResolvedValue([parent, { ...FILE_SHARE_MESSAGE, thread_ts: parent.ts }]);
		const client = makeClient({ repliesAll });
		const out = await assembleThread(client, "C001", parent);
		expect(out!.hasAttachments).toBe(true);
	});

	it("hasAttachments false when no message has files or attachments", async () => {
		const out = await assembleThread(makeClient(), "C001", ALICE_HUMAN_MESSAGE);
		expect(out!.hasAttachments).toBe(false);
	});

	it("accepts a bot message as parent (bot messages are first-class authors)", async () => {
		const out = await assembleThread(makeClient(), "C001", BOT_PARENT);
		expect(out).not.toBeNull();
		expect(out!.parent.bot_id).toBe("B_CI");
	});
});
