import { describe, expect, it } from "vitest";
import { convertEmojiShortcodes, shortcodeToUnicode } from "./emoji.js";

describe("shortcodeToUnicode", () => {
	it("converts standard emoji shortcodes", () => {
		expect(shortcodeToUnicode("tada")).toBe("🎉");
		expect(shortcodeToUnicode("rocket")).toBe("🚀");
		expect(shortcodeToUnicode("heart")).toBe("❤️");
	});

	it("converts Slack-specific aliases via SLACK_ALIAS_MAP", () => {
		// Slack uses :thumbsup: but standard is :+1:
		expect(shortcodeToUnicode("thumbsup")).toBe("👍");
		expect(shortcodeToUnicode("thumbsdown")).toBe("👎");
		expect(shortcodeToUnicode("hankey")).toBe("💩");
	});

	it("returns null for custom/unknown emojis", () => {
		expect(shortcodeToUnicode("custom_company_logo")).toBeNull();
		expect(shortcodeToUnicode("not_a_real_emoji_xyz")).toBeNull();
	});
});

describe("convertEmojiShortcodes", () => {
	it("replaces known shortcodes with Unicode in text", () => {
		expect(convertEmojiShortcodes("Great work :tada: :rocket:")).toBe("Great work 🎉 🚀");
	});

	it("leaves custom/unknown shortcodes as :name:", () => {
		expect(convertEmojiShortcodes("love this :custom_thing:")).toBe("love this :custom_thing:");
	});

	it("handles mixed known and unknown in the same string", () => {
		const input = ":thumbsup: approved :company_logo: ship it :rocket:";
		const result = convertEmojiShortcodes(input);
		expect(result).toBe("👍 approved :company_logo: ship it 🚀");
	});

	it("does not modify text without shortcodes", () => {
		const plain = "Hello world, no emojis here.";
		expect(convertEmojiShortcodes(plain)).toBe(plain);
	});

	it("handles shortcodes with hyphens and plus signs", () => {
		// :+1: is the standard for thumbsup
		expect(convertEmojiShortcodes(":+1:")).toBe("👍");
	});

	it("returns empty string for empty input", () => {
		expect(convertEmojiShortcodes("")).toBe("");
	});
});
