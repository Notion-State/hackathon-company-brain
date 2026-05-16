import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentityLookup } from "./lookups.js";
import type { SlackClient, SlackMessage } from "./slack.js";

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

const aliceUser = {
	id: "U001",
	real_name: "Alice Adams",
	display_name: "alice",
	email: "alice@notionstate.com",
	is_bot: false,
} as const;

describe("createIdentityLookup", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	describe("resolveUser", () => {
		it("renders displayText as `Real Name (@handle)` and carries email", async () => {
			const client = makeClient({ usersInfo: vi.fn().mockResolvedValue(aliceUser) });
			const out = await createIdentityLookup(client).resolveUser("U001");
			expect(out).toEqual({
				displayText: "Alice Adams (@alice)",
				email: "alice@notionstate.com",
				isBot: false,
			});
		});

		it("caches: a second call for the same id does not call the API again", async () => {
			const usersInfo = vi.fn().mockResolvedValue(aliceUser);
			const client = makeClient({ usersInfo });
			const lookup = createIdentityLookup(client);
			await lookup.resolveUser("U001");
			await lookup.resolveUser("U001");
			expect(usersInfo).toHaveBeenCalledTimes(1);
		});

		it("falls back when users.info returns null (e.g., user_not_found)", async () => {
			const client = makeClient({ usersInfo: vi.fn().mockResolvedValue(null) });
			const out = await createIdentityLookup(client).resolveUser("U999");
			expect(out.displayText).toBe("(unknown user U999)");
			expect(out.email).toBeNull();
		});

		it("falls back gracefully when users.info throws (does not throw)", async () => {
			const client = makeClient({ usersInfo: vi.fn().mockRejectedValue(new Error("boom")) });
			vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const out = await createIdentityLookup(client).resolveUser("U999");
			expect(out.displayText).toBe("(unknown user U999)");
		});
	});

	describe("resolveBot", () => {
		it("renders displayText as `name (bot)` and email is always null", async () => {
			const client = makeClient({ botsInfo: vi.fn().mockResolvedValue({ id: "B001", name: "ci-bot" }) });
			const out = await createIdentityLookup(client).resolveBot("B001");
			expect(out).toEqual({ displayText: "ci-bot (bot)", email: null, isBot: true });
		});

		it("uses fallback username when bots.info returns null", async () => {
			const client = makeClient({ botsInfo: vi.fn().mockResolvedValue(null) });
			const out = await createIdentityLookup(client).resolveBot("Bxxx", "github-actions");
			expect(out.displayText).toBe("github-actions (bot)");
		});

		it("uses `bot {id}` when both API and fallback are missing", async () => {
			const client = makeClient({ botsInfo: vi.fn().mockResolvedValue(null) });
			const out = await createIdentityLookup(client).resolveBot("Bxxx");
			expect(out.displayText).toBe("bot Bxxx (bot)");
		});

		it("caches per bot id", async () => {
			const botsInfo = vi.fn().mockResolvedValue({ id: "B001", name: "ci-bot" });
			const client = makeClient({ botsInfo });
			const lookup = createIdentityLookup(client);
			await Promise.all([lookup.resolveBot("B001"), lookup.resolveBot("B001")]);
			expect(botsInfo).toHaveBeenCalledTimes(1);
		});
	});

	describe("resolveMessageAuthor", () => {
		function msg(overrides: Partial<SlackMessage>): SlackMessage {
			return {
				ts: "1.0",
				thread_ts: null,
				type: "message",
				subtype: null,
				text: "",
				user: null,
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

		it("dispatches to bot path when bot_id is set, even if user is also populated", async () => {
			const client = makeClient({ botsInfo: vi.fn().mockResolvedValue({ id: "B001", name: "ci-bot" }) });
			const out = await createIdentityLookup(client).resolveMessageAuthor(
				msg({ bot_id: "B001", user: "U001", username: "ci-bot" }),
			);
			expect(out.displayText).toBe("ci-bot (bot)");
		});

		it("synthesizes bot identity (no API call) when subtype=bot_message but bot_id missing", async () => {
			const botsInfo = vi.fn();
			const client = makeClient({ botsInfo });
			const out = await createIdentityLookup(client).resolveMessageAuthor(
				msg({ subtype: "bot_message", username: "legacy-bot" }),
			);
			expect(out).toEqual({ displayText: "legacy-bot (bot)", email: null, isBot: true });
			expect(botsInfo).not.toHaveBeenCalled();
		});

		it("dispatches to user path when only user is set", async () => {
			const client = makeClient({ usersInfo: vi.fn().mockResolvedValue(aliceUser) });
			const out = await createIdentityLookup(client).resolveMessageAuthor(msg({ user: "U001" }));
			expect(out.displayText).toBe("Alice Adams (@alice)");
		});

		it("returns the (unknown) sentinel when neither user nor bot is set", async () => {
			const client = makeClient();
			const out = await createIdentityLookup(client).resolveMessageAuthor(msg({}));
			expect(out).toEqual({ displayText: "(unknown)", email: null, isBot: false });
		});
	});
});
