import { describe, expect, it } from "vitest";

import { MarkdownTooLong } from "./errors.js";
import {
	MAX_BODY_CHARS,
	MAX_RICH_TEXT_CHARS,
	markdownToBlocks,
	parseInline,
	splitText,
} from "./markdown.js";

describe("markdownToBlocks", () => {
	it("returns empty blocks for empty or null input", () => {
		expect(markdownToBlocks("")).toEqual({ blocks: [], warnings: [] });
		expect(markdownToBlocks(null)).toEqual({ blocks: [], warnings: [] });
		expect(markdownToBlocks(undefined)).toEqual({ blocks: [], warnings: [] });
	});

	it("renders each heading level", () => {
		const r = markdownToBlocks("# h1\n\n## h2\n\n### h3");
		expect(r.warnings).toEqual([]);
		expect(r.blocks).toMatchObject([
			{ heading_1: { rich_text: [{ text: { content: "h1" } }] } },
			{ heading_2: { rich_text: [{ text: { content: "h2" } }] } },
			{ heading_3: { rich_text: [{ text: { content: "h3" } }] } },
		]);
	});

	it("downgrades H4+ headings to H3 with a warning", () => {
		const r = markdownToBlocks("#### deep");
		expect(r.blocks).toMatchObject([
			{ heading_3: { rich_text: [{ text: { content: "deep" } }] } },
		]);
		expect(r.warnings[0]).toMatch(/downgraded/i);
	});

	it("renders a single paragraph from soft-wrapped lines", () => {
		const r = markdownToBlocks("hello\nworld");
		expect(r.blocks).toHaveLength(1);
		expect(r.blocks[0]).toMatchObject({
			paragraph: { rich_text: [{ text: { content: "hello\nworld" } }] },
		});
	});

	it("separates paragraphs on blank lines", () => {
		const r = markdownToBlocks("one\n\ntwo");
		expect(r.blocks).toHaveLength(2);
	});

	it("renders bulleted lists (- and *)", () => {
		const r = markdownToBlocks("- a\n- b\n* c");
		expect(r.blocks).toHaveLength(3);
		for (const b of r.blocks) {
			expect(b).toHaveProperty("bulleted_list_item");
		}
	});

	it("renders numbered lists", () => {
		const r = markdownToBlocks("1. a\n2. b\n3. c");
		expect(r.blocks).toHaveLength(3);
		for (const b of r.blocks) {
			expect(b).toHaveProperty("numbered_list_item");
		}
	});

	it("warns and renders flat when a list item is indented", () => {
		const r = markdownToBlocks("- top\n  - nested");
		expect(r.warnings.some((w) => /nested/i.test(w))).toBe(true);
		expect(r.blocks).toHaveLength(2);
		for (const b of r.blocks) {
			expect(b).toHaveProperty("bulleted_list_item");
		}
	});

	it("renders a fenced code block with a known language", () => {
		const r = markdownToBlocks("```ts\nconsole.log(1);\n```");
		expect(r.warnings).toEqual([]);
		expect(r.blocks[0]).toMatchObject({
			code: {
				language: "typescript",
				rich_text: [{ text: { content: "console.log(1);" } }],
			},
		});
	});

	it("falls back to plain text for unknown languages, with a warning", () => {
		const r = markdownToBlocks("```fortran77\nx\n```");
		expect(r.warnings.some((w) => /fortran77/i.test(w))).toBe(true);
		expect(r.blocks[0]).toMatchObject({ code: { language: "plain text" } });
	});

	it("treats missing fence language as plain text without warning", () => {
		const r = markdownToBlocks("```\nx\n```");
		expect(r.warnings).toEqual([]);
		expect(r.blocks[0]).toMatchObject({ code: { language: "plain text" } });
	});

	it("warns on an unclosed code fence and still emits a code block", () => {
		const r = markdownToBlocks("```ts\nconsole.log(1);");
		expect(r.warnings.some((w) => /unclosed/i.test(w))).toBe(true);
		expect(r.blocks[0]).toHaveProperty("code");
	});

	it("renders a horizontal rule as a divider", () => {
		const r = markdownToBlocks("before\n\n---\n\nafter");
		expect(r.blocks).toHaveLength(3);
		expect(r.blocks[1]).toEqual({ divider: {} });
	});

	it("collapses consecutive quote lines into a single quote block", () => {
		const r = markdownToBlocks("> line 1\n> line 2\n\nelsewhere");
		expect(r.blocks).toHaveLength(2);
		expect(r.blocks[0]).toMatchObject({
			quote: { rich_text: [{ text: { content: "line 1\nline 2" } }] },
		});
		expect(r.blocks[1]).toHaveProperty("paragraph");
	});

	it("warns on Markdown table syntax", () => {
		const r = markdownToBlocks("| a | b |\n| - | - |\n| 1 | 2 |");
		expect(r.warnings.some((w) => /tables/i.test(w))).toBe(true);
	});

	it("warns on images", () => {
		const r = markdownToBlocks("![alt](https://example.com/cat.png)");
		expect(r.warnings.some((w) => /images/i.test(w))).toBe(true);
	});

	it("warns on inline HTML", () => {
		const r = markdownToBlocks("hello <b>world</b>");
		expect(r.warnings.some((w) => /HTML/i.test(w))).toBe(true);
	});

	it("warns on task lists", () => {
		const r = markdownToBlocks("- [ ] todo");
		expect(r.warnings.some((w) => /task lists/i.test(w))).toBe(true);
	});

	it("throws MarkdownTooLong when input exceeds the cap", () => {
		const big = "a".repeat(MAX_BODY_CHARS + 1);
		expect(() => markdownToBlocks(big)).toThrowError(MarkdownTooLong);
	});
});

describe("parseInline", () => {
	it("returns empty array for empty input", () => {
		expect(parseInline("", [])).toEqual([]);
	});

	it("treats plain text as a single item with no annotations", () => {
		const items = parseInline("hello world", []);
		expect(items).toMatchObject([
			{ text: { content: "hello world", link: null } },
		]);
		expect(items[0]).not.toHaveProperty("annotations");
	});

	it("parses bold", () => {
		const items = parseInline("a **b** c", []);
		expect(items).toMatchObject([
			{ text: { content: "a " } },
			{ text: { content: "b" }, annotations: { bold: true } },
			{ text: { content: " c" } },
		]);
	});

	it("parses italic with * and _", () => {
		const items1 = parseInline("hi *world*", []);
		const items2 = parseInline("hi _world_", []);
		for (const items of [items1, items2]) {
			expect(items[1]).toMatchObject({
				text: { content: "world" },
				annotations: { italic: true },
			});
		}
	});

	it("parses inline code verbatim", () => {
		const items = parseInline("call `f(x)` now", []);
		expect(items[1]).toMatchObject({
			text: { content: "f(x)" },
			annotations: { code: true },
		});
	});

	it("parses links", () => {
		const items = parseInline("[hi](https://example.com)", []);
		expect(items).toMatchObject([
			{ text: { content: "hi", link: { url: "https://example.com" } } },
		]);
	});

	it("treats `\\*` as a literal asterisk", () => {
		const items = parseInline("\\*not italic\\*", []);
		expect(items[0]?.text?.content).toBe("*not italic*");
	});

	it("falls back to literal characters on unbalanced markers", () => {
		const items = parseInline("a *unclosed", []);
		expect(items[0]?.text?.content).toBe("a *unclosed");
	});
});

describe("splitText", () => {
	it("returns one item for short input", () => {
		const out = splitText("hello");
		expect(out).toHaveLength(1);
		expect(out[0]?.text?.content).toBe("hello");
	});

	it("splits long input at whitespace, preserving annotations on each chunk", () => {
		const big = `${"word ".repeat(800)}tail`;
		const out = splitText(big, { bold: true });
		expect(out.length).toBeGreaterThan(1);
		for (const item of out) {
			expect(item.text?.content.length).toBeLessThanOrEqual(MAX_RICH_TEXT_CHARS);
			expect(item.annotations?.bold).toBe(true);
		}
		expect(out.map((i) => i.text?.content).join(" ").replace(/\s+/g, " ").trim())
			.toBe(big.trim());
	});

	it("falls back to a hard cut for tokens longer than the limit", () => {
		const out = splitText("a".repeat(MAX_RICH_TEXT_CHARS + 50));
		expect(out).toHaveLength(2);
		expect(out[0]?.text?.content.length).toBe(MAX_RICH_TEXT_CHARS);
		expect(out[1]?.text?.content.length).toBe(50);
	});

	it("emits a link on every chunk when split", () => {
		const url = "https://example.com";
		const out = splitText("a".repeat(MAX_RICH_TEXT_CHARS + 10), {}, url);
		for (const item of out) {
			expect(item.text?.link).toEqual({ url });
		}
	});
});
