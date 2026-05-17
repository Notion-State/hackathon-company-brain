import { describe, expect, it } from "vitest";

import {
	DEFAULT_MAX_BYTES,
	escapeMarkdown,
	renderBodyMarkdown,
	type Block,
} from "./body-renderer.js";

const NOW = "2026-05-16T00:00:00.000Z";

function paragraph(text: string): Block {
	return blockOf({
		type: "paragraph",
		paragraph: { rich_text: [richText(text)], color: "default" as const },
	});
}

function heading(level: 1 | 2 | 3, text: string): Block {
	if (level === 1) {
		return blockOf({
			type: "heading_1",
			heading_1: {
				rich_text: [richText(text)],
				color: "default" as const,
				is_toggleable: false,
			},
		});
	}
	if (level === 2) {
		return blockOf({
			type: "heading_2",
			heading_2: {
				rich_text: [richText(text)],
				color: "default" as const,
				is_toggleable: false,
			},
		});
	}
	return blockOf({
		type: "heading_3",
		heading_3: {
			rich_text: [richText(text)],
			color: "default" as const,
			is_toggleable: false,
		},
	});
}

function bullet(text: string): Block {
	return blockOf({
		type: "bulleted_list_item",
		bulleted_list_item: { rich_text: [richText(text)], color: "default" as const },
	});
}

function numbered(text: string): Block {
	return blockOf({
		type: "numbered_list_item",
		numbered_list_item: { rich_text: [richText(text)], color: "default" as const },
	});
}

function todo(text: string, checked = false): Block {
	return blockOf({
		type: "to_do",
		to_do: { rich_text: [richText(text)], color: "default" as const, checked },
	});
}

function codeBlock(language: string, text: string): Block {
	return blockOf({
		type: "code",
		code: {
			rich_text: [richText(text)],
			language: language as never,
			caption: [],
		},
	});
}

function quoteBlock(text: string): Block {
	return blockOf({
		type: "quote",
		quote: { rich_text: [richText(text)], color: "default" as const },
	});
}

function divider(): Block {
	return blockOf({ type: "divider", divider: {} });
}

function calloutBlock(text: string, emoji?: string): Block {
	return blockOf({
		type: "callout",
		callout: {
			rich_text: [richText(text)],
			color: "default" as const,
			icon: emoji
				? { type: "emoji" as const, emoji: emoji as never }
				: null,
		},
	});
}

function unsupported(typeName: string): Block {
	return blockOf({
		type: "unsupported",
		unsupported: { block_type: typeName },
	});
}

function blockOf(specific: Record<string, unknown>): Block {
	return {
		object: "block" as const,
		id: "test",
		parent: { type: "page_id" as const, page_id: "p" },
		created_time: NOW,
		last_edited_time: NOW,
		created_by: { object: "user" as const, id: "u" },
		last_edited_by: { object: "user" as const, id: "u" },
		has_children: false,
		archived: false,
		in_trash: false,
		...specific,
	} as Block;
}

function richText(
	plain: string,
	overrides: Partial<{
		bold: boolean;
		italic: boolean;
		code: boolean;
		strikethrough: boolean;
		underline: boolean;
		href: string | null;
	}> = {},
) {
	return {
		plain_text: plain,
		href: overrides.href ?? null,
		annotations: {
			bold: overrides.bold ?? false,
			italic: overrides.italic ?? false,
			code: overrides.code ?? false,
			strikethrough: overrides.strikethrough ?? false,
			underline: overrides.underline ?? false,
		},
	};
}

describe("renderBodyMarkdown", () => {
	it("returns empty string for empty input", () => {
		expect(renderBodyMarkdown([])).toBe("");
	});

	it("renders a paragraph", () => {
		expect(renderBodyMarkdown([paragraph("hello")])).toBe("hello\n\n");
	});

	it("renders headings H1–H3", () => {
		expect(
			renderBodyMarkdown([heading(1, "a"), heading(2, "b"), heading(3, "c")]),
		).toBe("# a\n\n## b\n\n### c\n\n");
	});

	it("renders a bulleted list", () => {
		expect(renderBodyMarkdown([bullet("one"), bullet("two")])).toBe(
			"- one\n- two\n",
		);
	});

	it("renders a numbered list with auto-increment", () => {
		expect(renderBodyMarkdown([numbered("a"), numbered("b"), numbered("c")])).toBe(
			"1. a\n2. b\n3. c\n",
		);
	});

	it("renders a code block with fence language", () => {
		expect(renderBodyMarkdown([codeBlock("typescript", "console.log(1)")])).toBe(
			"```typescript\nconsole.log(1)\n```\n\n",
		);
	});

	it("renders a quote", () => {
		expect(renderBodyMarkdown([quoteBlock("be excellent")])).toBe(
			"> be excellent\n\n",
		);
	});

	it("renders a divider", () => {
		expect(renderBodyMarkdown([divider()])).toBe("---\n\n");
	});

	it("renders a to_do as a plain bullet with checkbox prefix (degrades cleanly)", () => {
		expect(renderBodyMarkdown([todo("ship it", true)])).toBe("- [x] ship it\n");
	});

	it("renders a callout as a quote with emoji prefix", () => {
		expect(renderBodyMarkdown([calloutBlock("watch out", "⚠️")])).toBe(
			"> ⚠️ watch out\n\n",
		);
	});

	it("renders an unsupported block as a paragraph hint (block.type is the SDK discriminator)", () => {
		// `unsupported` is the SDK's catch-all type for blocks it doesn't model.
		// The renderer reports `block.type` itself — which for these is the
		// literal string "unsupported".
		expect(renderBodyMarkdown([unsupported("ignored")])).toBe(
			"_[unsupported block: unsupported]_\n\n",
		);
	});

	it("renders bold + italic + inline code annotations", () => {
		const b = blockOf({
			type: "paragraph",
			paragraph: {
				rich_text: [
					richText("normal "),
					richText("strong", { bold: true }),
					richText(" then "),
					richText("emph", { italic: true }),
					richText(" then "),
					richText("code", { code: true }),
				],
				color: "default" as const,
			},
		});
		expect(renderBodyMarkdown([b])).toBe(
			"normal **strong** then *emph* then `code`\n\n",
		);
	});

	it("wraps a link around the (annotated) text when href is set", () => {
		const b = blockOf({
			type: "paragraph",
			paragraph: {
				rich_text: [richText("notion", { href: "https://notion.so" })],
				color: "default" as const,
			},
		});
		expect(renderBodyMarkdown([b])).toBe("[notion](https://notion.so)\n\n");
	});

	it("escapes markdown specials in plain text", () => {
		expect(renderBodyMarkdown([paragraph("# not heading *not bold*")])).toBe(
			"\\# not heading \\*not bold\\*\n\n",
		);
	});

	it("emits a nested-truncated marker when child depth exceeds maxDepth=2", () => {
		const grandchild = paragraph("deep");
		const child: Block = { ...paragraph("mid"), _children: [grandchild] };
		const top: Block = { ...paragraph("top"), _children: [child] };
		const greatgrand: Block = {
			...paragraph("deeper"),
			_children: [{ ...child, _children: [{ ...child, _children: [grandchild] }] }],
		};
		const out = renderBodyMarkdown([{ ...top, _children: [greatgrand] }]);
		expect(out).toContain("_[nested children truncated]_");
	});

	it("emits a truncated marker when byte cap exceeded", () => {
		const longChunk = paragraph("x".repeat(1000));
		const blocks = Array.from({ length: 100 }, () => longChunk);
		const out = renderBodyMarkdown(blocks, { maxBytes: 2_000 });
		expect(out).toContain("_…[truncated at 50KB; see source page]_");
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(2_000 + 100);
	});

	it("respects the default 50KB cap", () => {
		expect(DEFAULT_MAX_BYTES).toBe(50_000);
	});
});

describe("escapeMarkdown", () => {
	it("escapes the documented set of specials", () => {
		expect(escapeMarkdown("\\*_`[]#")).toBe("\\\\\\*\\_\\`\\[\\]\\#");
	});
});
