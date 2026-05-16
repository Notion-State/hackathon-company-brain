import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebClient } from "@slack/web-api";
import { createSlackClient, ErrorCode, type Pacer } from "./slack.js";

function makePacer(): Pacer & { calls: number } {
	const p = {
		calls: 0,
		async wait() {
			p.calls += 1;
		},
	};
	return p;
}

/**
 * Build a stub WebClient just typed enough for the methods we use. The double
 * cast is the standard pattern for partial test-time stubs of complex class
 * instances — not the kind of Notion-SDK-silencing cast CLAUDE.md warns against.
 */
function makeStubWeb(overrides: Partial<Record<string, unknown>> = {}): WebClient {
	const stub = {
		conversations: {
			list: vi.fn(),
			join: vi.fn(),
			history: vi.fn(),
			replies: vi.fn(),
		},
		users: { info: vi.fn() },
		bots: { info: vi.fn() },
		chat: { getPermalink: vi.fn() },
		team: { info: vi.fn() },
		...overrides,
	};
	return stub as unknown as WebClient;
}

function makePlatformError(slackErrorCode: string): Error {
	const e = new Error(`slack error: ${slackErrorCode}`) as Error & {
		code: string;
		data: { error: string };
	};
	e.code = ErrorCode.PlatformError;
	e.data = { error: slackErrorCode };
	return e;
}

function makeRateLimitedError(retryAfterSec: number): Error {
	const e = new Error("rate limited") as Error & { code: string; retryAfter: number };
	e.code = ErrorCode.RateLimitedError;
	e.retryAfter = retryAfterSec;
	return e;
}

describe("createSlackClient", () => {
	let pacer: ReturnType<typeof makePacer>;

	beforeEach(() => {
		pacer = makePacer();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rejects construction without a token", () => {
		expect(() => createSlackClient("", pacer)).toThrow(/token is required/);
	});

	describe("listPublicChannels", () => {
		it("calls pacer.wait, returns normalized channels + cursor", async () => {
			const web = makeStubWeb();
			(web.conversations.list as ReturnType<typeof vi.fn>).mockResolvedValue({
				ok: true,
				channels: [
					{ id: "C001", name: "general", num_members: 10, topic: { value: "general topic" }, purpose: { value: "" } },
					{ id: "C002", name: "random", is_archived: true, is_member: true, created: 1234 },
				],
				response_metadata: { next_cursor: "next-page" },
			});
			const client = createSlackClient("xoxb-test", pacer, { web });
			const out = await client.listPublicChannels("start-cursor");
			expect(pacer.calls).toBe(1);
			expect(out.nextCursor).toBe("next-page");
			expect(out.channels).toHaveLength(2);
			expect(out.channels[0]).toMatchObject({
				id: "C001",
				name: "general",
				num_members: 10,
				topic: "general topic",
				purpose: "",
				is_archived: false,
				is_member: false,
			});
			expect(out.channels[1]).toMatchObject({
				id: "C002",
				is_archived: true,
				is_member: true,
				created: 1234,
			});
		});

		it("drops channels missing id or name (defensive)", async () => {
			const web = makeStubWeb();
			(web.conversations.list as ReturnType<typeof vi.fn>).mockResolvedValue({
				ok: true,
				channels: [
					{ id: "C001", name: "ok" },
					{ name: "no-id" },
					{ id: "C002" }, // no name
				],
			});
			const out = await createSlackClient("t", pacer, { web }).listPublicChannels();
			expect(out.channels.map((c) => c.id)).toEqual(["C001"]);
		});

		it("omits nextCursor when empty (Slack returns empty-string when no more pages)", async () => {
			const web = makeStubWeb();
			(web.conversations.list as ReturnType<typeof vi.fn>).mockResolvedValue({
				ok: true,
				channels: [],
				response_metadata: { next_cursor: "" },
			});
			const out = await createSlackClient("t", pacer, { web }).listPublicChannels();
			expect(out.nextCursor).toBeUndefined();
		});
	});

	describe("joinChannel", () => {
		it("returns ok:true on success", async () => {
			const web = makeStubWeb();
			(web.conversations.join as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
			const r = await createSlackClient("t", pacer, { web }).joinChannel("C001");
			expect(r).toEqual({ ok: true, warning: undefined });
		});

		it.each(["is_archived", "not_authorized", "missing_scope", "method_not_supported_for_channel_type"])(
			"returns ok:false with warning for recoverable error %s (does not throw)",
			async (slackError) => {
				const web = makeStubWeb();
				(web.conversations.join as ReturnType<typeof vi.fn>).mockRejectedValue(makePlatformError(slackError));
				const r = await createSlackClient("t", pacer, { web }).joinChannel("C999");
				expect(r).toEqual({ ok: false, warning: slackError });
			},
		);

		it("re-throws unexpected platform errors", async () => {
			const web = makeStubWeb();
			(web.conversations.join as ReturnType<typeof vi.fn>).mockRejectedValue(makePlatformError("invalid_auth"));
			await expect(createSlackClient("t", pacer, { web }).joinChannel("C999")).rejects.toThrow(/invalid_auth/);
		});
	});

	describe("historyPage", () => {
		it("normalizes messages and surfaces pagination", async () => {
			const web = makeStubWeb();
			(web.conversations.history as ReturnType<typeof vi.fn>).mockResolvedValue({
				ok: true,
				has_more: true,
				response_metadata: { next_cursor: "page-2" },
				messages: [
					{
						ts: "1715898253.000100",
						type: "message",
						text: "hello",
						user: "U001",
						reactions: [{ name: "thumbsup", count: 3 }, { name: "no-count" }, { name: "ok", count: 1 }],
						files: [{ id: "F1", name: "f.png", url_private: "https://example/f.png" }],
					},
					{
						ts: "1715898260.000100",
						subtype: "bot_message",
						text: "ci built",
						bot_id: "B001",
						username: "ci-bot",
					},
				],
			});
			const out = await createSlackClient("t", pacer, { web }).historyPage("C001", { oldest: "1715000000.000000" });
			expect(pacer.calls).toBe(1);
			expect(out.hasMore).toBe(true);
			expect(out.nextCursor).toBe("page-2");
			expect(out.messages).toHaveLength(2);
			expect(out.messages[0]).toMatchObject({
				ts: "1715898253.000100",
				text: "hello",
				user: "U001",
				bot_id: null,
				reactions: [
					{ name: "thumbsup", count: 3 },
					{ name: "ok", count: 1 }, // reaction without count is dropped
				],
				files: [{ id: "F1", name: "f.png", url_private: "https://example/f.png", mimetype: null }],
			});
			expect(out.messages[1]).toMatchObject({
				subtype: "bot_message",
				bot_id: "B001",
				username: "ci-bot",
				user: null,
			});
		});

		it("omits nextCursor when empty", async () => {
			const web = makeStubWeb();
			(web.conversations.history as ReturnType<typeof vi.fn>).mockResolvedValue({
				ok: true,
				has_more: false,
				messages: [],
				response_metadata: { next_cursor: "" },
			});
			const out = await createSlackClient("t", pacer, { web }).historyPage("C001", {});
			expect(out.nextCursor).toBeUndefined();
		});
	});

	describe("repliesAll", () => {
		it("paginates internally and flattens all replies", async () => {
			const web = makeStubWeb();
			(web.conversations.replies as ReturnType<typeof vi.fn>)
				.mockResolvedValueOnce({
					ok: true,
					has_more: true,
					response_metadata: { next_cursor: "p2" },
					messages: [
						{ ts: "1.000000", text: "parent", user: "U1" },
						{ ts: "2.000000", text: "r1", user: "U2", thread_ts: "1.000000" },
					],
				})
				.mockResolvedValueOnce({
					ok: true,
					has_more: false,
					messages: [{ ts: "3.000000", text: "r2", user: "U3", thread_ts: "1.000000" }],
				});
			const out = await createSlackClient("t", pacer, { web }).repliesAll("C001", "1.000000");
			expect(pacer.calls).toBe(2);
			expect(out.map((m) => m.text)).toEqual(["parent", "r1", "r2"]);
		});

		it("returns single page when has_more is false", async () => {
			const web = makeStubWeb();
			(web.conversations.replies as ReturnType<typeof vi.fn>).mockResolvedValue({
				ok: true,
				has_more: false,
				messages: [{ ts: "1.000000", text: "only", user: "U1" }],
			});
			const out = await createSlackClient("t", pacer, { web }).repliesAll("C001", "1.000000");
			expect(out).toHaveLength(1);
			expect(pacer.calls).toBe(1);
		});
	});

	describe("usersInfo", () => {
		it("returns normalized user with email when present", async () => {
			const web = makeStubWeb();
			(web.users.info as ReturnType<typeof vi.fn>).mockResolvedValue({
				ok: true,
				user: {
					id: "U001",
					name: "alice",
					real_name: "Alice Adams",
					is_bot: false,
					profile: { display_name: "alice", email: "alice@notionstate.com", real_name: "Alice Adams" },
				},
			});
			const u = await createSlackClient("t", pacer, { web }).usersInfo("U001");
			expect(u).toEqual({
				id: "U001",
				real_name: "Alice Adams",
				display_name: "alice",
				email: "alice@notionstate.com",
				is_bot: false,
			});
		});

		it("returns null on user_not_found / user_not_visible (soft fail)", async () => {
			const web = makeStubWeb();
			(web.users.info as ReturnType<typeof vi.fn>).mockRejectedValueOnce(makePlatformError("user_not_found"));
			const r1 = await createSlackClient("t", pacer, { web }).usersInfo("U001");
			expect(r1).toBeNull();

			(web.users.info as ReturnType<typeof vi.fn>).mockRejectedValueOnce(makePlatformError("user_not_visible"));
			const r2 = await createSlackClient("t", pacer, { web }).usersInfo("U002");
			expect(r2).toBeNull();
		});

		it("re-throws unexpected platform errors", async () => {
			const web = makeStubWeb();
			(web.users.info as ReturnType<typeof vi.fn>).mockRejectedValue(makePlatformError("invalid_auth"));
			await expect(createSlackClient("t", pacer, { web }).usersInfo("U001")).rejects.toThrow(/invalid_auth/);
		});
	});

	describe("botsInfo", () => {
		it("returns normalized bot when found", async () => {
			const web = makeStubWeb();
			(web.bots.info as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, bot: { id: "B001", name: "ci-bot" } });
			const b = await createSlackClient("t", pacer, { web }).botsInfo("B001");
			expect(b).toEqual({ id: "B001", name: "ci-bot" });
		});

		it("returns null on bot_not_found", async () => {
			const web = makeStubWeb();
			(web.bots.info as ReturnType<typeof vi.fn>).mockRejectedValue(makePlatformError("bot_not_found"));
			expect(await createSlackClient("t", pacer, { web }).botsInfo("Bxxx")).toBeNull();
		});
	});

	describe("getPermalink", () => {
		it("returns permalink string when present", async () => {
			const web = makeStubWeb();
			(web.chat.getPermalink as ReturnType<typeof vi.fn>).mockResolvedValue({
				ok: true,
				permalink: "https://acme.slack.com/archives/C001/p1715898253000100",
			});
			const p = await createSlackClient("t", pacer, { web }).getPermalink("C001", "1715898253.000100");
			expect(p).toBe("https://acme.slack.com/archives/C001/p1715898253000100");
		});

		it("returns null on message_not_found / channel_not_found", async () => {
			const web = makeStubWeb();
			(web.chat.getPermalink as ReturnType<typeof vi.fn>).mockRejectedValueOnce(makePlatformError("message_not_found"));
			expect(await createSlackClient("t", pacer, { web }).getPermalink("C001", "x")).toBeNull();
		});
	});

	describe("teamInfo", () => {
		it("returns normalized team info", async () => {
			const web = makeStubWeb();
			(web.team.info as ReturnType<typeof vi.fn>).mockResolvedValue({
				ok: true,
				team: { id: "T1", name: "Acme", domain: "acme" },
			});
			const t = await createSlackClient("t", pacer, { web }).teamInfo();
			expect(t).toEqual({ id: "T1", name: "Acme", domain: "acme" });
		});

		it("returns null and warns on any failure (does not throw)", async () => {
			const web = makeStubWeb();
			(web.team.info as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const t = await createSlackClient("t", pacer, { web }).teamInfo();
			expect(t).toBeNull();
			expect(warnSpy).toHaveBeenCalled();
		});
	});

	describe("rate-limit retry", () => {
		it("sleeps retryAfter, retries once, then propagates if still rate-limited", async () => {
			const web = makeStubWeb();
			(web.conversations.list as ReturnType<typeof vi.fn>)
				.mockRejectedValueOnce(makeRateLimitedError(2))
				.mockResolvedValueOnce({ ok: true, channels: [], response_metadata: {} });
			const sleeps: number[] = [];
			const sleep = (ms: number) => {
				sleeps.push(ms);
				return Promise.resolve();
			};
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

			const client = createSlackClient("t", pacer, { web, sleep });
			const out = await client.listPublicChannels();
			expect(sleeps).toEqual([2000]);
			expect(pacer.calls).toBe(2); // wait before each attempt
			expect(out.channels).toEqual([]);
			expect(warnSpy).toHaveBeenCalled();
		});

		it("propagates the rate-limit error after maxRetries exhausted", async () => {
			const web = makeStubWeb();
			(web.conversations.list as ReturnType<typeof vi.fn>).mockRejectedValue(makeRateLimitedError(1));
			const client = createSlackClient("t", pacer, { web, sleep: () => Promise.resolve(), maxRetries: 1 });
			vi.spyOn(console, "warn").mockImplementation(() => undefined);
			await expect(client.listPublicChannels()).rejects.toMatchObject({ code: ErrorCode.RateLimitedError });
		});
	});
});
