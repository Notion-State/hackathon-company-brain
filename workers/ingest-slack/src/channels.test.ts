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

describe("isEligible", () => {
	it("accepts a normal public channel", () => {
		expect(isEligible(ch({ id: "C1", name: "eng" }))).toBe(true);
	});

	it.each([
		["archived", { is_archived: true }],
		["private", { is_private: true }],
		["shared", { is_shared: true }],
		["ext_shared", { is_ext_shared: true }],
	])("rejects %s channels", (_label, overrides) => {
		expect(isEligible(ch({ id: "C1", name: "x", ...overrides }))).toBe(false);
	});
});

describe("discoverEligibleChannels", () => {
	it("paginates the list endpoint and filters out non-eligible channels", async () => {
		const listPublicChannels = vi
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
				],
				nextCursor: undefined,
			});
		const client = makeClient({ listPublicChannels });
		const out = await discoverEligibleChannels(client, { autoJoin: false });
		expect(listPublicChannels).toHaveBeenCalledTimes(2);
		expect(out.map((c) => c.id)).toEqual(["C1", "C3"]);
	});

	describe("autoJoin: true (channels sync)", () => {
		it("joins channels the bot isn't in; leaves member channels alone", async () => {
			const channels = [
				ch({ id: "C1", name: "eng", is_member: false }),
				ch({ id: "C2", name: "general", is_member: true }),
				ch({ id: "C3", name: "design", is_member: false }),
			];
			const listPublicChannels = vi.fn().mockResolvedValue({ channels, nextCursor: undefined });
			const joinChannel = vi.fn().mockResolvedValue({ ok: true });
			const client = makeClient({ listPublicChannels, joinChannel });

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
			const listPublicChannels = vi.fn().mockResolvedValue({ channels, nextCursor: undefined });
			const joinChannel = vi
				.fn()
				.mockResolvedValueOnce({ ok: false, warning: "not_authorized" })
				.mockResolvedValueOnce({ ok: true });
			const client = makeClient({ listPublicChannels, joinChannel });

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
			const listPublicChannels = vi.fn().mockResolvedValue({ channels, nextCursor: undefined });
			const joinChannel = vi.fn();
			const client = makeClient({ listPublicChannels, joinChannel });

			const out = await discoverEligibleChannels(client, { autoJoin: false });

			expect(joinChannel).not.toHaveBeenCalled();
			expect(out.map((c) => c.id)).toEqual(["C1", "C3"]);
		});
	});
});
