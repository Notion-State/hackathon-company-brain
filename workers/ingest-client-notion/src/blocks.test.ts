import { describe, expect, it } from "vitest";
import { escapeMarkdown, renderBlocksMarkdown } from "./blocks.js";
import {
	bullet,
	callout,
	code,
	divider,
	heading,
	numbered,
	paragraph,
	quote,
	todo,
	unsupportedBlock,
} from "./fixtures/blocks.js";
import type { Block } from "./notion.js";
import { TRUNCATED_BLOCK_MARKER } from "./notion.js";

describe("escapeMarkdown", () => {
	it("escapes markdown specials", () => {
		expect(escapeMarkdown("**bold** and *italic* with `code` [link](u) <tag> #h")).toBe(
			"\\*\\*bold\\*\\* and \\*italic\\* with \\`code\\` \\[link\\](u) \\<tag\\> \\#h",
		);
	});

	it("escapes a leading backslash", () => {
		expect(escapeMarkdown("\\path\\to")).toBe("\\\\path\\\\to");
	});
});

describe("renderBlocksMarkdown", () => {
	it("renders headings with markdown # prefix", () => {
		const out = renderBlocksMarkdown([heading(1, "Big"), heading(2, "Mid"), heading(3, "Sm")]);
		expect(out).toContain("# Big");
		expect(out).toContain("## Mid");
		expect(out).toContain("### Sm");
	});

	it("renders a paragraph with annotations", () => {
		const out = renderBlocksMarkdown([paragraph("hello", { ann: { bold: true, italic: true } })]);
		expect(out).toContain("***hello***"); // bold+italic wraps inside-out
	});

	it("escapes markdown specials in plain text", () => {
		const out = renderBlocksMarkdown([paragraph("not **bold**")]);
		// the asterisks in the plain text should be escaped
		expect(out).toContain("not \\*\\*bold\\*\\*");
	});

	it("renders bulleted lists with - and nested children indented", () => {
		const out = renderBlocksMarkdown([
			bullet("top", { children: [bullet("child"), bullet("child2")] }),
		]);
		expect(out).toContain("- top\n");
		expect(out).toContain("  - child\n");
		expect(out).toContain("  - child2\n");
	});

	it("numbers numbered_list_item starting at 1, resets after a non-numbered block", () => {
		const out = renderBlocksMarkdown([
			numbered("first"),
			numbered("second"),
			numbered("third"),
			paragraph("break"),
			numbered("again-one"),
		]);
		expect(out).toContain("1. first");
		expect(out).toContain("2. second");
		expect(out).toContain("3. third");
		expect(out).toContain("1. again-one");
		expect(out).not.toContain("4. again-one");
	});

	it("renders to_do checked and unchecked", () => {
		const out = renderBlocksMarkdown([todo("done", true), todo("todo", false)]);
		expect(out).toContain("- [x] done");
		expect(out).toContain("- [ ] todo");
	});

	it("renders code blocks with a fence and language", () => {
		const out = renderBlocksMarkdown([code("const x = 1;", "typescript")]);
		expect(out).toContain("```typescript\n");
		expect(out).toContain("const x = 1;");
	});

	it("renders quote with > prefix", () => {
		const out = renderBlocksMarkdown([quote("wisdom")]);
		expect(out).toMatch(/^> wisdom\n\n/);
	});

	it("renders callout with emoji prefix when present", () => {
		const withEmoji = renderBlocksMarkdown([callout("note", "💡")]);
		expect(withEmoji).toContain("> 💡 note");
		const without = renderBlocksMarkdown([callout("note", null)]);
		expect(without).toContain("> note");
	});

	it("renders divider as ---", () => {
		const out = renderBlocksMarkdown([divider()]);
		expect(out).toContain("---");
	});

	it("renders unsupported block types with a sentinel", () => {
		const out = renderBlocksMarkdown([unsupportedBlock()]);
		expect(out).toContain("_[unsupported block: table]_");
	});

	it("renders the synthetic truncation marker block", () => {
		const truncated: Block = {
			object: "block",
			id: TRUNCATED_BLOCK_MARKER,
			parent: { type: "block_id", block_id: TRUNCATED_BLOCK_MARKER },
			created_time: "2026-05-16T00:00:00.000Z",
			last_edited_time: "2026-05-16T00:00:00.000Z",
			created_by: { object: "user", id: TRUNCATED_BLOCK_MARKER },
			last_edited_by: { object: "user", id: TRUNCATED_BLOCK_MARKER },
			has_children: false,
			archived: false,
			in_trash: false,
			type: "unsupported",
			unsupported: { block_type: TRUNCATED_BLOCK_MARKER },
		};
		const out = renderBlocksMarkdown([truncated]);
		expect(out).toContain("_[content truncated; see source page]_");
	});

	it("truncates nested children below maxDepth", () => {
		const tree = bullet("a", { children: [bullet("b", { children: [bullet("c-deep")] })] });
		const out = renderBlocksMarkdown([tree], { maxDepth: 1 });
		expect(out).toContain("- a");
		expect(out).toContain("- b");
		expect(out).not.toContain("c-deep");
		expect(out).toContain("_[nested children truncated]_");
	});

	it("caps the total output at maxBytes and appends a truncation hint", () => {
		const big = paragraph("x".repeat(120));
		const blocks = Array.from({ length: 100 }, (_, i) => paragraph(`p${i}-`.repeat(20)));
		blocks.push(big);
		const out = renderBlocksMarkdown(blocks, { maxBytes: 500 });
		expect(out.length).toBeLessThanOrEqual(700); // 500 + truncation hint slack
		expect(out).toContain("_…[truncated at 50KB; see source page]_");
	});
});
