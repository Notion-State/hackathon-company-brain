import { describe, expect, it, vi } from "vitest";
import {
	ALICE_HUMAN_MESSAGE,
	BOB_REPLY,
	CAROL_REPLY,
	FILE_SHARE_MESSAGE,
	IMAGE_SHARE_MESSAGE,
	REACTIONS_MESSAGE,
	msg,
} from "./fixtures/messages.js";
import { parseInternalDomains } from "./internal-domains.js";
import type { IdentityLookup, SlackIdentity } from "./lookups.js";
import {
	buildTitle,
	convertSlackMrkdwn,
	formatSlackTs,
	recordId,
	renderThreadMarkdown,
	toThreadChangeProperties,
} from "./render-threads.js";
import type { SlackChannel } from "./slack.js";
import type { Thread } from "./threads.js";

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
		num_members: 10,
		created: 1715000000,
		creator: "U_ALICE",
		topic: "",
		purpose: "",
		...overrides,
	};
}

const IDENTITY_MAP: Record<string, SlackIdentity> = {
	U_ALICE: { displayText: "Alice Adams (@alice)", email: "alice@example.com", isBot: false },
	U_BOB: { displayText: "Bob Brown (@bob)", email: "bob@example.com", isBot: false },
	U_CAROL: { displayText: "Carol Chen (@carol)", email: "carol@partner.com", isBot: false },
	U_DAVE: { displayText: "Dave Doe (@dave)", email: null, isBot: false },
};
const BOT_MAP: Record<string, SlackIdentity> = {
	B_CI: { displayText: "ci-bot (bot)", email: null, isBot: true },
};

function makeIdentity(): IdentityLookup {
	return {
		resolveUser: vi.fn(async (id: string) => IDENTITY_MAP[id] ?? { displayText: `(unknown user ${id})`, email: null, isBot: false }),
		resolveBot: vi.fn(async (id: string, fb?: string | null) => BOT_MAP[id] ?? { displayText: `${fb ?? id} (bot)`, email: null, isBot: true }),
		resolveMessageAuthor: vi.fn(async (m) => {
			if (m.bot_id) return BOT_MAP[m.bot_id] ?? { displayText: `${m.username ?? m.bot_id} (bot)`, email: null, isBot: true };
			if (m.user) return IDENTITY_MAP[m.user] ?? { displayText: `(unknown user ${m.user})`, email: null, isBot: false };
			return { displayText: "(unknown)", email: null, isBot: false };
		}),
	};
}

function thread(overrides: Partial<Thread> = {}): Thread {
	const parent = ALICE_HUMAN_MESSAGE;
	return {
		parent,
		replies: [BOB_REPLY, CAROL_REPLY],
		latestTs: CAROL_REPLY.ts,
		hasAttachments: false,
		totalReactionCount: 0,
		...overrides,
	};
}

describe("recordId", () => {
	it("composes channelId:threadTs", () => {
		expect(recordId("C001", "1715898253.000100")).toBe("C001:1715898253.000100");
	});
});

describe("buildTitle", () => {
	it("returns parent text under the cap, single-line", () => {
		expect(buildTitle(msg({ text: "Short one" }), channel())).toBe("Short one");
	});

	it("collapses whitespace and newlines", () => {
		expect(buildTitle(msg({ text: "Multi\nline\twith   spaces" }), channel())).toBe("Multi line with spaces");
	});

	it("truncates at 80 chars with ellipsis", () => {
		const long = "x".repeat(120);
		const t = buildTitle(msg({ text: long }), channel());
		expect(t.length).toBe(80);
		expect(t.endsWith("…")).toBe(true);
	});

	it("falls back to [Message in #{channel}] for empty text", () => {
		expect(buildTitle(msg({ text: "" }), channel({ name: "eng" }))).toBe("[Message in #eng]");
		expect(buildTitle(msg({ text: "   \n  " }), channel({ name: "eng" }))).toBe("[Message in #eng]");
	});
});

describe("toThreadChangeProperties", () => {
	it("emits every schema-declared property", async () => {
		const props = await toThreadChangeProperties(thread(), channel(), {
			identity: makeIdentity(), internalDomains: INTERNAL, permalink: "https://acme.slack.com/archives/C001/p1",
		}, NOW);
		const required = [
			"Title", "Record ID", "Channel", "Author", "Author Email", "Internal Participants",
			"Thread Participants", "Posted At", "Last Activity", "Reply Count", "Reaction Count",
			"Has Attachments", "Permalink", "Source", "Synced At",
		];
		for (const key of required) expect(Object.keys(props)).toContain(key);
	});

	it("Channel property is a relation array referencing the channel id", async () => {
		const props = await toThreadChangeProperties(thread(), channel({ id: "C_TEST" }), {
			identity: makeIdentity(), internalDomains: INTERNAL, permalink: null,
		}, NOW);
		// Builder.relation returns a RelationReference; array wraps to a property value
		expect(Array.isArray(props.Channel)).toBe(true);
		expect(JSON.stringify(props.Channel)).toContain("C_TEST");
	});

	it("Internal Participants collects unique internal-domain emails across parent + replies", async () => {
		// Alice + Bob are internal (example.com); Carol is external (partner.com).
		const props = await toThreadChangeProperties(thread(), channel(), {
			identity: makeIdentity(), internalDomains: INTERNAL, permalink: null,
		}, NOW);
		const serialized = JSON.stringify(props["Internal Participants"]);
		expect(serialized).toContain("alice@example.com");
		expect(serialized).toContain("bob@example.com");
		expect(serialized).not.toContain("carol@partner.com");
	});

	it("Reply Count reflects post-filter replies (not Slack's raw count)", async () => {
		const t = thread({ replies: [BOB_REPLY] });
		const props = await toThreadChangeProperties(t, channel(), {
			identity: makeIdentity(), internalDomains: INTERNAL, permalink: null,
		}, NOW);
		expect(JSON.stringify(props["Reply Count"])).toContain("1");
	});

	it("bot author renders with (bot) suffix and no email", async () => {
		const parent = msg({ ts: "1715800000.000000", bot_id: "B_CI", username: "ci-bot", user: null, subtype: "bot_message", text: "Deploy ok" });
		const t = thread({ parent, replies: [], latestTs: parent.ts });
		const props = await toThreadChangeProperties(t, channel(), {
			identity: makeIdentity(), internalDomains: INTERNAL, permalink: null,
		}, NOW);
		expect(JSON.stringify(props.Author)).toContain("ci-bot (bot)");
		expect(JSON.stringify(props["Author Email"])).not.toContain("@");
	});
});

describe("renderThreadMarkdown", () => {
	it("renders header, metadata, view-in-slack link, and a chronological thread", async () => {
		const t = thread();
		const md = await renderThreadMarkdown(t, channel(), {
			identity: makeIdentity(),
			internalDomains: INTERNAL,
			permalink: "https://acme.slack.com/archives/C001/p1715898253000100",
		});
		expect(md).toContain("# Hey team, what do we think about migrating to \\*Bun\\*?");
		expect(md).toContain("**Channel:** #engineering");
		expect(md).toContain("**Posted:** Thursday, May 16, 2024 | 6:24 PM ET");
		expect(md).toContain("**Author:** Alice Adams (@alice)");
		expect(md).toContain("[View in Slack](https://acme.slack.com/archives/C001/p1715898253000100)");
		expect(md).toContain("## Thread");
		// Each participant appears as a section header with human-readable dates
		expect(md).toContain("**Alice Adams (@alice) — Thursday, May 16, 2024 | 6:24 PM ET**");
		expect(md).toContain("**Bob Brown (@bob) — Thursday, May 16, 2024 | 6:26 PM ET**");
		expect(md).toContain("**Carol Chen (@carol) — Thursday, May 16, 2024 | 6:30 PM ET**");
	});

	it("renders --- separators between messages", async () => {
		const t = thread();
		const md = await renderThreadMarkdown(t, channel(), {
			identity: makeIdentity(), internalDomains: INTERNAL, permalink: null,
		});
		const separatorCount = (md.match(/^---$/gm) ?? []).length;
		// One separator before each message (parent + 2 replies)
		expect(separatorCount).toBe(3);
	});

	it("omits the view-in-slack line when permalink is null", async () => {
		const md = await renderThreadMarkdown(thread(), channel(), {
			identity: makeIdentity(), internalDomains: INTERNAL, permalink: null,
		});
		expect(md).not.toContain("View in Slack");
	});

	it("renders attachments as bullet links under their message", async () => {
		const t = thread({
			parent: { ...FILE_SHARE_MESSAGE, user: "U_ALICE", reply_count: 0 },
			replies: [],
			latestTs: FILE_SHARE_MESSAGE.ts,
			hasAttachments: true,
		});
		const md = await renderThreadMarkdown(t, channel(), {
			identity: makeIdentity(), internalDomains: INTERNAL, permalink: null,
		});
		expect(md).toContain("📎 [spec.pdf](https://acme.slack.com/files/U_ALICE/F001/spec.pdf)");
	});

	it("converts <@U…> mentions inline using the identity lookup", async () => {
		const parent = msg({ ts: "1.000000", user: "U_ALICE", text: "<@U_BOB> can you review?" });
		const md = await renderThreadMarkdown(
			{ parent, replies: [], latestTs: parent.ts, hasAttachments: false, totalReactionCount: 0 },
			channel(), { identity: makeIdentity(), internalDomains: INTERNAL, permalink: null },
		);
		expect(md).toContain("@bob can you review?");
	});

	it("renders empty parent text as `(no text)` placeholder", async () => {
		const parent = msg({ ts: "1.000000", user: "U_ALICE", text: "" });
		const md = await renderThreadMarkdown(
			{ parent, replies: [], latestTs: parent.ts, hasAttachments: false, totalReactionCount: 0 },
			channel(), { identity: makeIdentity(), internalDomains: INTERNAL, permalink: null },
		);
		expect(md).toContain("_(no text)_");
	});

	it("renders image files with 🖼️ prefix and non-images with 📎", async () => {
		const t = {
			parent: { ...IMAGE_SHARE_MESSAGE, user: "U_ALICE", reply_count: 0 },
			replies: [],
			latestTs: IMAGE_SHARE_MESSAGE.ts,
			hasAttachments: true,
			totalReactionCount: 0,
		};
		const md = await renderThreadMarkdown(t, channel(), {
			identity: makeIdentity(), internalDomains: INTERNAL, permalink: null,
		});
		expect(md).toContain("🖼️ [screenshot.png]");
		expect(md).not.toContain("📎 [screenshot.png]");

		// Non-image file (PDF) still gets 📎
		const t2 = {
			parent: { ...FILE_SHARE_MESSAGE, user: "U_ALICE", reply_count: 0 },
			replies: [],
			latestTs: FILE_SHARE_MESSAGE.ts,
			hasAttachments: true,
			totalReactionCount: 0,
		};
		const md2 = await renderThreadMarkdown(t2, channel(), {
			identity: makeIdentity(), internalDomains: INTERNAL, permalink: null,
		});
		expect(md2).toContain("📎 [spec.pdf]");
		expect(md2).not.toContain("🖼️ [spec.pdf]");
	});

	it("renders reactions as a blockquote line with emoji + count", async () => {
		const t = {
			parent: { ...REACTIONS_MESSAGE, user: "U_ALICE", reply_count: 0 },
			replies: [],
			latestTs: REACTIONS_MESSAGE.ts,
			hasAttachments: false,
			totalReactionCount: 6,
		};
		const md = await renderThreadMarkdown(t, channel(), {
			identity: makeIdentity(), internalDomains: INTERNAL, permalink: null,
		});
		// thumbsup resolves to 👍 via alias, tada resolves to 🎉
		expect(md).toContain("👍 3");
		expect(md).toContain("🎉 2");
		// Custom emoji stays as :name:
		expect(md).toContain(":custom_company_emoji: 1");
		// All on a blockquote line
		expect(md).toContain("> ");
	});
});

describe("convertSlackMrkdwn", () => {
	const idLookup = makeIdentity();

	it("returns empty string for empty input", async () => {
		expect(await convertSlackMrkdwn("", idLookup)).toBe("");
	});

	it("converts <@U…> to @handle from the identity lookup", async () => {
		expect(await convertSlackMrkdwn("hey <@U_ALICE>", idLookup)).toBe("hey @alice");
	});

	it("uses Slack's `|alt` label when provided for user mentions", async () => {
		expect(await convertSlackMrkdwn("hey <@U_ALICE|alice-from-iOS>", idLookup)).toBe("hey @alice-from-iOS");
	});

	it("falls back to @user when the user can't be resolved", async () => {
		expect(await convertSlackMrkdwn("ping <@U_GHOST>", idLookup)).toBe("ping @user");
	});

	it("converts channel mentions with and without inline name", async () => {
		expect(await convertSlackMrkdwn("see <#C001|general> and <#C002>", idLookup)).toBe("see #general and #C002");
	});

	it("converts !here/!channel/!everyone broadcasts", async () => {
		expect(await convertSlackMrkdwn("<!here> heads up <!channel>", idLookup)).toBe("@here heads up @channel");
	});

	it("converts subteam mentions", async () => {
		expect(await convertSlackMrkdwn("cc <!subteam^S123|frontend>", idLookup)).toBe("cc @frontend");
	});

	it("converts <url|label> links to commonmark", async () => {
		expect(await convertSlackMrkdwn("see <https://example.com|the docs>", idLookup)).toBe("see [the docs](https://example.com)");
	});

	it("strips angle brackets from bare urls", async () => {
		expect(await convertSlackMrkdwn("ref <https://example.com>", idLookup)).toBe("ref https://example.com");
	});

	it("unescapes Slack HTML entities", async () => {
		expect(await convertSlackMrkdwn("&lt;tag&gt; &amp; more", idLookup)).toBe("<tag> & more");
	});

	it("converts *bold* and _italic_ and ~strike~", async () => {
		expect(await convertSlackMrkdwn("hey *strong* and _slanted_ and ~gone~", idLookup)).toBe(
			"hey **strong** and *slanted* and ~~gone~~",
		);
	});

	it("does NOT mistake intra-word underscores for italic", async () => {
		expect(await convertSlackMrkdwn("file_name_here", idLookup)).toBe("file_name_here");
	});

	it("leaves backtick code spans untouched", async () => {
		expect(await convertSlackMrkdwn("call `foo()` please", idLookup)).toBe("call `foo()` please");
	});

	it("converts emoji shortcodes to Unicode", async () => {
		expect(await convertSlackMrkdwn("great :tada: let's go :rocket:", idLookup)).toBe("great 🎉 let's go 🚀");
	});

	it("leaves custom emoji shortcodes as :name:", async () => {
		expect(await convertSlackMrkdwn("love this :custom_thing:", idLookup)).toBe("love this :custom_thing:");
	});

	it("converts Slack-specific emoji aliases", async () => {
		expect(await convertSlackMrkdwn(":thumbsup: approved", idLookup)).toBe("👍 approved");
	});
});

describe("formatSlackTs", () => {
	it("formats epoch-seconds timestamp to human-readable ET string", () => {
		// 1715898253 = May 16, 2024 22:24:13 UTC = 6:24 PM EDT
		expect(formatSlackTs("1715898253.000100")).toBe("Thursday, May 16, 2024 | 6:24 PM ET");
	});

	it("handles timestamps that cross day boundaries in ET", () => {
		// 1715000000 = May 6, 2024 12:53:20 UTC = 8:53 AM EDT
		expect(formatSlackTs("1715000000.000000")).toBe("Monday, May 6, 2024 | 8:53 AM ET");
	});

	it("handles EST (winter) timestamps correctly", () => {
		// 1704067200 = Jan 1, 2024 00:00:00 UTC = Dec 31, 2023 7:00 PM EST
		expect(formatSlackTs("1704067200.000000")).toBe("Sunday, December 31, 2023 | 7:00 PM ET");
	});
});
