import { describe, expect, it, vi } from "vitest";
import { parseInternalDomains } from "./internal-domains.js";
import type { IdentityLookup, SlackIdentity } from "./lookups.js";
import { classifyChannelType, renderChannelMarkdown, toChannelChangeProperties } from "./render-channels.js";
import type { SlackChannel } from "./slack.js";

const NOW = new Date("2026-05-15T12:00:00.000Z");
const INTERNAL = parseInternalDomains("example.com");

function channel(overrides: Partial<SlackChannel> = {}): SlackChannel {
	return {
		id: "C001",
		name: "engineering",
		is_archived: false,
		is_member: true,
		is_private: false,
		is_shared: false,
		is_ext_shared: false,
		num_members: 42,
		created: 1715000000, // 2024-05-06T...
		creator: "U_ALICE",
		topic: "Build great things",
		purpose: "Engineering coordination",
		...overrides,
	};
}

function makeIdentity(map: Record<string, SlackIdentity>): IdentityLookup {
	return {
		resolveUser: vi.fn(async (id: string) => map[id] ?? { displayText: `(unknown user ${id})`, email: null, isBot: false }),
		resolveBot: vi.fn(),
		resolveMessageAuthor: vi.fn(),
	};
}

describe("toChannelChangeProperties", () => {
	it("emits all properties with correct shapes and escaped text", async () => {
		const identity = makeIdentity({
			U_ALICE: { displayText: "Alice Adams (@alice)", email: "alice@example.com", isBot: false },
		});
		const props = await toChannelChangeProperties(channel(), {
			identity,
			internalDomains: INTERNAL,
			teamDomain: "acme",
			memberEmails: "alice@example.com, bob@partner.com",
		}, NOW);

		expect(props).toMatchObject({
			Name: expect.anything(),
			"Channel ID": expect.anything(),
			Topic: expect.anything(),
			Purpose: expect.anything(),
			"Member Count": expect.anything(),
			"Is Member": expect.anything(),
			"Is Archived": expect.anything(),
			"Is Private": expect.anything(),
			"Is Shared": expect.anything(),
			"Is Externally Shared": expect.anything(),
			"Member Emails": expect.anything(),
			"Channel Type": expect.anything(),
			Created: expect.anything(),
			"Creator Email": expect.anything(),
			"Internal Creator": expect.anything(),
			"Slack URL": expect.anything(),
			Source: expect.anything(),
			"Synced At": expect.anything(),
		});
	});

	it("populates Internal Creator only when creator email matches an internal domain", async () => {
		const ident = makeIdentity({
			U_ALICE: { displayText: "Alice (@alice)", email: "alice@example.com", isBot: false },
			U_EXT: { displayText: "Ext (@ext)", email: "ext@partner.com", isBot: false },
		});
		const internal = await toChannelChangeProperties(channel({ creator: "U_ALICE" }), {
			identity: ident, internalDomains: INTERNAL, teamDomain: "acme", memberEmails: "",
		}, NOW);
		// Internal Creator should be populated (people value with one email)
		expect(JSON.stringify(internal["Internal Creator"])).toContain("alice@example.com");

		const external = await toChannelChangeProperties(channel({ creator: "U_EXT" }), {
			identity: ident, internalDomains: INTERNAL, teamDomain: "acme", memberEmails: "",
		}, NOW);
		expect(JSON.stringify(external["Internal Creator"])).not.toContain("ext@partner.com");
	});

	it("leaves Internal Creator empty when channel has no creator", async () => {
		const ident = makeIdentity({});
		const props = await toChannelChangeProperties(channel({ creator: null }), {
			identity: ident, internalDomains: INTERNAL, teamDomain: "acme", memberEmails: "",
		}, NOW);
		expect(JSON.stringify(props["Internal Creator"])).not.toContain("@");
	});

	it("falls back to current time when created is zero/missing", async () => {
		const ident = makeIdentity({});
		const props = await toChannelChangeProperties(channel({ creator: null, created: 0 }), {
			identity: ident, internalDomains: INTERNAL, teamDomain: "acme", memberEmails: "",
		}, NOW);
		// Builder.dateTime splits ISO into start_date + start_time in its internal shape.
		const serialized = JSON.stringify(props.Created);
		expect(serialized).toContain("2026-05-15");
		expect(serialized).toContain("12:00");
	});

	it("builds Slack URL from teamDomain + channel id; defaults to `app` when domain is empty", async () => {
		const ident = makeIdentity({});
		const a = await toChannelChangeProperties(channel({ creator: null }), {
			identity: ident, internalDomains: INTERNAL, teamDomain: "acme", memberEmails: "",
		}, NOW);
		expect(JSON.stringify(a["Slack URL"])).toContain("https://acme.slack.com/archives/C001");

		const b = await toChannelChangeProperties(channel({ creator: null, id: "C002" }), {
			identity: ident, internalDomains: INTERNAL, teamDomain: "", memberEmails: "",
		}, NOW);
		expect(JSON.stringify(b["Slack URL"])).toContain("https://app.slack.com/archives/C002");
	});
});

describe("renderChannelMarkdown", () => {
	it("produces a body with creator display name, topic, purpose, and slack URL", async () => {
		const identity = makeIdentity({
			U_ALICE: { displayText: "Alice Adams (@alice)", email: "alice@example.com", isBot: false },
		});
		const md = await renderChannelMarkdown(channel(), {
			identity, internalDomains: INTERNAL, teamDomain: "acme", memberEmails: "alice@example.com",
		});
		expect(md).toContain("# \\#engineering");
		expect(md).toContain("**Members:** 42");
		// escapeMarkdown does not escape parens — they aren't structural markdown.
		expect(md).toContain("Alice Adams (@alice)");
		expect(md).toContain("**Topic:** Build great things");
		expect(md).toContain("**Purpose:** Engineering coordination");
		expect(md).toContain("[Open in Slack](https://acme.slack.com/archives/C001)");
	});

	it("renders empty topic/purpose as placeholders", async () => {
		const identity = makeIdentity({ U_ALICE: { displayText: "Alice", email: null, isBot: false } });
		const md = await renderChannelMarkdown(channel({ topic: "", purpose: "" }), {
			identity, internalDomains: INTERNAL, teamDomain: "acme", memberEmails: "alice@example.com",
		});
		expect(md).toContain("_No topic set._");
		expect(md).toContain("_No purpose set._");
	});

	it("uses (unknown) for the creator when channel has no creator field", async () => {
		const identity = makeIdentity({});
		const md = await renderChannelMarkdown(channel({ creator: null }), {
			identity, internalDomains: INTERNAL, teamDomain: "acme", memberEmails: "alice@example.com",
		});
		expect(md).toContain("**Created by:** (unknown)");
	});
});

describe("classifyChannelType", () => {
	it("returns 'Public' for a standard public channel", () => {
		expect(classifyChannelType(channel({ is_private: false, is_ext_shared: false }))).toBe("Public");
	});

	it("returns 'Private' for a private channel", () => {
		expect(classifyChannelType(channel({ is_private: true, is_ext_shared: false }))).toBe("Private");
	});

	it("returns 'Slack Connect' for an externally shared channel", () => {
		expect(classifyChannelType(channel({ is_private: false, is_ext_shared: true }))).toBe("Slack Connect");
	});

	it("prioritizes 'Slack Connect' over 'Private' when both are true", () => {
		expect(classifyChannelType(channel({ is_private: true, is_ext_shared: true }))).toBe("Slack Connect");
	});
});

describe("toChannelChangeProperties — Channel Type", () => {
	it("emits Channel Type property with correct classification", async () => {
		const ident = makeIdentity({});
		const props = await toChannelChangeProperties(
			channel({ creator: null, is_private: true, is_ext_shared: false }),
			{ identity: ident, internalDomains: INTERNAL, teamDomain: "acme", memberEmails: "" },
			NOW,
		);
		expect(JSON.stringify(props["Channel Type"])).toContain("Private");
	});

	it("emits Slack Connect for externally shared channels", async () => {
		const ident = makeIdentity({});
		const props = await toChannelChangeProperties(
			channel({ creator: null, is_ext_shared: true }),
			{ identity: ident, internalDomains: INTERNAL, teamDomain: "acme", memberEmails: "" },
			NOW,
		);
		expect(JSON.stringify(props["Channel Type"])).toContain("Slack Connect");
	});
});
