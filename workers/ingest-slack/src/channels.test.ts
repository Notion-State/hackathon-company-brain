import { describe, expect, it, vi } from "vitest";
import { discoverEligibleChannels, isEligible } from "./channels.js";
import type { SlackChannel, SlackClient } from "./slack.js";

function ch(overrides: Partial<SlackChannel>): SlackChannel {
	return {
		id: "C000",
		name: "default",
		is_archived: false,
		is_member: false,
		is_private: false,
		is_shared: false,
		is_ext_shared: false,
		num_members: 0,
		created: 0,
		creator: null,
		topic: "",
		purpose: "",
		...overrides,
	};
}

function makeClient(overrides: Partial<SlackClient> = {}): SlackClient {
	const base: SlackClient = {
		listChannels: vi.fn(),
		listMembers: vi.fn(),
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

describe("isEligible", () => {
	it("accepts a normal public channel", () => {
		expect(isEligible(ch({ id: "C1", name: "eng" }))).toBe(true);
	});

	it("accepts private, shared, and ext_shared channels", () => {
		expect(isEligible(ch({ id: "C1", name: "priv", is_private: true }))).toBe(true);
		expect(isEligible(ch({ id: "C2", name: "shared", is_shared: true }))).toBe(true);
		expect(isEligible(ch({ id: "C3", name: "ext", is_ext_shared: true }))).toBe(true);
	});

	it("rejects archived channels", () => {
		expect(isEligible(ch({ id: "C1", name: "x", is_archived: true }))).toBe(false);
	});
});

describe("discoverEligibleChannels", () => {
	it("paginates the list endpoint and includes private/shared channels (only filters archived)", async () => {
		const listChannels = vi
			.fn()
			.mockResolvedValueOnce({
				channels: [
					ch({ id: "C1", name: "eng", is_member: true }),
					ch({ id: "C2", name: "shared", is_shared: true, is_member: true }),
				],
				nextCursor: "p2",
			})
			.mockResolvedValueOnce({
				channels: [
					ch({ id: "C3", name: "general", is_member: true }),
					ch({ id: "C4", name: "private", is_private: true, is_member: true }),
					ch({ id: "C5", name: "archived", is_archived: true, is_member: true }),
				],
				nextCursor: undefined,
			});
		const client = makeClient({ listChannels });
		const out = await discoverEligibleChannels(client, { autoJoin: false });
		expect(listChannels).toHaveBeenCalledTimes(2);
		// All non-archived member channels included (C1, C2, C3, C4); archived C5 excluded
		expect(out.map((c) => c.id)).toEqual(["C1", "C2", "C3", "C4"]);
	});

	describe("autoJoin: true (channels sync)", () => {
		it("joins channels the bot isn't in; leaves member channels alone", async () => {
			const channels = [
				ch({ id: "C1", name: "eng", is_member: false }),
				ch({ id: "C2", name: "general", is_member: true }),
				ch({ id: "C3", name: "design", is_member: false }),
			];
			const listChannels = vi.fn().mockResolvedValue({ channels, nextCursor: undefined });
			const joinChannel = vi.fn().mockResolvedValue({ ok: true });
			const client = makeClient({ listChannels, joinChannel });

			const out = await discoverEligibleChannels(client, { autoJoin: true });

			expect(joinChannel).toHaveBeenCalledTimes(2);
			expect(joinChannel).toHaveBeenCalledWith("C1");
			expect(joinChannel).toHaveBeenCalledWith("C3");
			// All three eligible channels returned (none filtered)
			expect(out.map((c) => c.id)).toEqual(["C1", "C2", "C3"]);
			// is_member flipped on the joined channels
			expect(out.find((c) => c.id === "C1")?.is_member).toBe(true);
			expect(out.find((c) => c.id === "C3")?.is_member).toBe(true);
		});

		it("keeps is_member=false when join returns ok:false (e.g., not_authorized)", async () => {
			const channels = [
				ch({ id: "C1", name: "restricted", is_member: false }),
				ch({ id: "C2", name: "eng", is_member: false }),
			];
			const listChannels = vi.fn().mockResolvedValue({ channels, nextCursor: undefined });
			const joinChannel = vi
				.fn()
				.mockResolvedValueOnce({ ok: false, warning: "not_authorized" })
				.mockResolvedValueOnce({ ok: true });
			const client = makeClient({ listChannels, joinChannel });

			const out = await discoverEligibleChannels(client, { autoJoin: true });

			expect(out.find((c) => c.id === "C1")?.is_member).toBe(false);
			expect(out.find((c) => c.id === "C2")?.is_member).toBe(true);
		});
	});

	describe("autoJoin: false (messages syncs)", () => {
		it("drops non-member channels and never calls join", async () => {
			const channels = [
				ch({ id: "C1", name: "eng", is_member: true }),
				ch({ id: "C2", name: "design", is_member: false }),
				ch({ id: "C3", name: "general", is_member: true }),
			];
			const listChannels = vi.fn().mockResolvedValue({ channels, nextCursor: undefined });
			const joinChannel = vi.fn();
			const client = makeClient({ listChannels, joinChannel });

			const out = await discoverEligibleChannels(client, { autoJoin: false });

			expect(joinChannel).not.toHaveBeenCalled();
			expect(out.map((c) => c.id)).toEqual(["C1", "C3"]);
		});
	});
});
