import type {
	BlockObjectRequest,
	LanguageRequest,
	RichTextItemRequest,
} from "@notionhq/client/build/src/api-endpoints/common.js";

import { MarkdownTooLong } from "./errors.js";

/**
 * Translates a documented subset of Markdown into `BlockObjectRequest[]` for
 * `pages.create.children` / `blocks.children.append`.
 *
 * Supported:
 *   - Headings `#`, `##`, `###` (H4+ downgraded to H3 with warning)
 *   - Paragraphs (consecutive non-blank lines joined with "\n" inside one block)
 *   - Bulleted lists (`- ` / `* `) — flat only
 *   - Numbered lists (`1. `) — flat only
 *   - Fenced code ``` ``` ``` (with optional language; unknowns become "plain text")
 *   - Block quotes `> ` (consecutive lines collapse into a single quote)
 *   - Horizontal rule `---`
 *
 * Inline:
 *   - `**bold**`, `*italic*` / `_italic_`, `` `code` ``
 *   - `[text](url)` links
 *   - Backslash escapes `\X` → literal X
 *
 * Unsupported features (tables, images, inline HTML, nested lists, task lists,
 * footnotes) are dropped with a warning; the source line is included as a plain
 * paragraph where possible.
 *
 * Hard limits:
 *   - `MAX_BODY_CHARS` (50_000) on the input — throws `MarkdownTooLong`.
 *   - Individual `rich_text.text.content` capped at `MAX_RICH_TEXT_CHARS` (2000)
 *     and split at whitespace into multiple items sharing annotations.
 */

export const MAX_BODY_CHARS = 50_000;
export const MAX_RICH_TEXT_CHARS = 2000;

/** Narrow alias for the text variant of `RichTextItemRequest` (the only kind we emit). */
export type TextRichTextItem = RichTextItemRequest & {
	type?: "text";
	text: { content: string; link?: { url: string } | null };
	annotations?: {
		bold?: boolean;
		italic?: boolean;
		code?: boolean;
	};
};

export type MarkdownResult = {
	blocks: BlockObjectRequest[];
	warnings: string[];
};

type Annotations = {
	bold?: boolean;
	italic?: boolean;
	code?: boolean;
};

type BlockToken =
	| { kind: "paragraph"; text: string }
	| { kind: "heading"; level: 1 | 2 | 3; text: string }
	| { kind: "bulleted"; text: string }
	| { kind: "numbered"; text: string }
	| { kind: "quote"; text: string }
	| { kind: "code"; language: string; text: string }
	| { kind: "divider" };

export function markdownToBlocks(input: string | null | undefined): MarkdownResult {
	const source = input ?? "";
	if (source.length > MAX_BODY_CHARS) {
		throw new MarkdownTooLong(source.length, MAX_BODY_CHARS);
	}

	const warnings: string[] = [];
	const tokens = tokenizeBlocks(source, warnings);
	const blocks = tokens.map((t) => renderBlock(t, warnings));
	return { blocks, warnings };
}

// ---- Pass 1: line-oriented block tokenizer ----

function tokenizeBlocks(source: string, warnings: string[]): BlockToken[] {
	const lines = source.split("\n");
	const tokens: BlockToken[] = [];

	let inCode = false;
	let codeLang = "";
	let codeBuffer: string[] = [];

	let paragraphBuffer: string[] = [];
	let quoteBuffer: string[] = [];

	const flushParagraph = () => {
		if (paragraphBuffer.length === 0) return;
		tokens.push({ kind: "paragraph", text: paragraphBuffer.join("\n") });
		paragraphBuffer = [];
	};
	const flushQuote = () => {
		if (quoteBuffer.length === 0) return;
		tokens.push({ kind: "quote", text: quoteBuffer.join("\n") });
		quoteBuffer = [];
	};
	const flushOpenBlocks = () => {
		flushParagraph();
		flushQuote();
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";

		// Inside fenced code: consume verbatim until closing fence.
		if (inCode) {
			const fenceClose = /^```\s*$/.exec(line);
			if (fenceClose) {
				tokens.push({ kind: "code", language: codeLang, text: codeBuffer.join("\n") });
				inCode = false;
				codeLang = "";
				codeBuffer = [];
			} else {
				codeBuffer.push(line);
			}
			continue;
		}

		// Fenced code open.
		const fenceOpen = /^```\s*(\S*)\s*$/.exec(line);
		if (fenceOpen) {
			flushOpenBlocks();
			inCode = true;
			codeLang = (fenceOpen[1] ?? "").toLowerCase();
			codeBuffer = [];
			continue;
		}

		// Quote.
		const quoteMatch = /^>\s?(.*)$/.exec(line);
		if (quoteMatch) {
			flushParagraph();
			quoteBuffer.push(quoteMatch[1] ?? "");
			continue;
		}

		// Anything that isn't a quote breaks an open quote block.
		flushQuote();

		// Blank line: flush.
		if (line.trim() === "") {
			flushParagraph();
			continue;
		}

		// Divider.
		if (/^---\s*$/.test(line)) {
			flushParagraph();
			tokens.push({ kind: "divider" });
			continue;
		}

		// Heading.
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			flushParagraph();
			const rawLevel = heading[1]!.length;
			let level: 1 | 2 | 3;
			if (rawLevel <= 3) {
				level = rawLevel as 1 | 2 | 3;
			} else {
				level = 3;
				warnings.push(
					`Heading level ${rawLevel} downgraded to H3 (Notion supports only H1–H3).`,
				);
			}
			tokens.push({ kind: "heading", level, text: heading[2] ?? "" });
			continue;
		}

		// Task list (warn before falling through to bullet).
		const taskList = /^(\s*)[-*]\s+\[[ xX]\]\s+(.*)$/.exec(line);
		if (taskList) {
			warnings.push("Task lists are not supported; rendered as a plain bullet.");
			flushParagraph();
			tokens.push({ kind: "bulleted", text: taskList[2] ?? "" });
			continue;
		}

		// Bulleted list. Allow leading whitespace but warn (no nesting).
		const bullet = /^(\s*)([-*])\s+(.*)$/.exec(line);
		if (bullet) {
			const indent = bullet[1] ?? "";
			if (indent.length > 0) {
				warnings.push(
					`Nested list items are not supported; rendering as a top-level bullet.`,
				);
			}
			flushParagraph();
			tokens.push({ kind: "bulleted", text: bullet[3] ?? "" });
			continue;
		}

		// Numbered list.
		const numbered = /^(\s*)\d+\.\s+(.*)$/.exec(line);
		if (numbered) {
			const indent = numbered[1] ?? "";
			if (indent.length > 0) {
				warnings.push(
					`Nested list items are not supported; rendering as a top-level numbered item.`,
				);
			}
			flushParagraph();
			tokens.push({ kind: "numbered", text: numbered[2] ?? "" });
			continue;
		}

		// Unsupported syntactic markers: surface a warning and treat as paragraph.
		if (/^\s*\|.*\|\s*$/.test(line)) {
			warnings.push("Markdown tables are not supported; rendered as plain text.");
		}
		if (/!\[[^\]]*\]\([^)]+\)/.test(line)) {
			warnings.push("Images are not supported; rendered as plain text.");
		}
		if (/<\/?[a-zA-Z]/.test(line)) {
			warnings.push("Inline HTML is not supported; rendered as plain text.");
		}
		if (/^\s*-\s+\[[ xX]\]\s/.test(line)) {
			warnings.push("Task lists are not supported; rendered as plain text.");
		}

		// Paragraph content.
		paragraphBuffer.push(line);
	}

	if (inCode) {
		warnings.push("Unclosed code fence — remaining lines rendered as code.");
		tokens.push({ kind: "code", language: codeLang, text: codeBuffer.join("\n") });
	}
	flushOpenBlocks();
	return tokens;
}

// ---- Pass 2: render each token to a BlockObjectRequest ----

function renderBlock(token: BlockToken, warnings: string[]): BlockObjectRequest {
	switch (token.kind) {
		case "paragraph":
			return { paragraph: { rich_text: parseInline(token.text, warnings) } };
		case "heading":
			if (token.level === 1) return { heading_1: { rich_text: parseInline(token.text, warnings) } };
			if (token.level === 2) return { heading_2: { rich_text: parseInline(token.text, warnings) } };
			return { heading_3: { rich_text: parseInline(token.text, warnings) } };
		case "bulleted":
			return { bulleted_list_item: { rich_text: parseInline(token.text, warnings) } };
		case "numbered":
			return { numbered_list_item: { rich_text: parseInline(token.text, warnings) } };
		case "quote":
			return { quote: { rich_text: parseInline(token.text, warnings) } };
		case "code":
			return {
				code: {
					rich_text: splitText(token.text),
					language: normalizeLanguage(token.language, warnings),
				},
			};
		case "divider":
			return { divider: {} };
	}
}

const KNOWN_LANGUAGES: Set<LanguageRequest> = new Set<LanguageRequest>([
	"abap", "abc", "agda", "arduino", "ascii art", "assembly", "bash", "basic",
	"bnf", "c", "c#", "c++", "clojure", "coffeescript", "coq", "css", "dart",
	"dhall", "diff", "docker", "ebnf", "elixir", "elm", "erlang", "f#", "flow",
	"fortran", "gherkin", "glsl", "go", "graphql", "groovy", "haskell", "hcl",
	"html", "idris", "java", "javascript", "json", "julia", "kotlin", "latex",
	"less", "lisp", "livescript", "llvm ir", "lua", "makefile", "markdown",
	"markup", "matlab", "mathematica", "mermaid", "nix", "notion formula",
	"objective-c", "ocaml", "pascal", "perl", "php", "plain text", "powershell",
	"prolog", "protobuf", "purescript", "python", "r", "racket", "reason",
	"ruby", "rust", "sass", "scala", "scheme", "scss", "shell", "smalltalk",
	"solidity", "sql", "swift", "toml", "typescript", "vb.net", "verilog",
	"vhdl", "visual basic", "webassembly", "xml", "yaml", "java/c/c++/c#",
]);

const LANGUAGE_ALIASES: Record<string, LanguageRequest> = {
	ts: "typescript",
	js: "javascript",
	py: "python",
	rb: "ruby",
	sh: "shell",
	bash: "bash",
	yml: "yaml",
	"c++": "c++",
	"c#": "c#",
	"f#": "f#",
};

function normalizeLanguage(raw: string, warnings: string[]): LanguageRequest {
	const trimmed = raw.trim().toLowerCase();
	if (trimmed === "") return "plain text";
	if (KNOWN_LANGUAGES.has(trimmed as LanguageRequest)) return trimmed as LanguageRequest;
	const aliased = LANGUAGE_ALIASES[trimmed];
	if (aliased) return aliased;
	warnings.push(`Unknown code language "${raw}"; defaulting to plain text.`);
	return "plain text";
}

// ---- Inline parser ----

export function parseInline(text: string, warnings: string[]): TextRichTextItem[] {
	if (text.length === 0) return [];

	const items: TextRichTextItem[] = [];
	let buf = "";
	let i = 0;
	let bold = false;
	let italic = false;

	const flushBuffer = (link?: string) => {
		if (buf.length === 0 && link === undefined) return;
		for (const item of splitText(buf, { bold, italic }, link)) items.push(item);
		buf = "";
	};

	while (i < text.length) {
		const ch = text[i]!;

		// Escape: `\X` → literal X.
		if (ch === "\\" && i + 1 < text.length) {
			buf += text[i + 1]!;
			i += 2;
			continue;
		}

		// Inline code: `` `...` ``. Treat content verbatim, no nested parsing.
		if (ch === "`") {
			const end = text.indexOf("`", i + 1);
			if (end > i) {
				flushBuffer();
				const codeText = text.slice(i + 1, end);
				for (const item of splitText(codeText, { bold, italic, code: true })) {
					items.push(item);
				}
				i = end + 1;
				continue;
			}
		}

		// Bold: `**...**`. Match a closing `**` somewhere later; do not toggle if absent.
		if (ch === "*" && text[i + 1] === "*") {
			if (bold) {
				flushBuffer();
				bold = false;
				i += 2;
				continue;
			}
			const close = findClosing(text, i + 2, "**");
			if (close >= 0) {
				flushBuffer();
				bold = true;
				i += 2;
				continue;
			}
		}

		// Italic: `*...*` or `_..._`. Single-char markers; skip if no closer.
		if (ch === "*" || ch === "_") {
			if (italic) {
				flushBuffer();
				italic = false;
				i += 1;
				continue;
			}
			const close = findClosing(text, i + 1, ch);
			if (close >= 0) {
				flushBuffer();
				italic = true;
				i += 1;
				continue;
			}
		}

		// Link: `[text](url)`.
		if (ch === "[") {
			const closeBracket = text.indexOf("]", i + 1);
			if (closeBracket > i && text[closeBracket + 1] === "(") {
				const closeParen = text.indexOf(")", closeBracket + 2);
				if (closeParen > closeBracket) {
					const linkText = text.slice(i + 1, closeBracket);
					const url = text.slice(closeBracket + 2, closeParen);
					flushBuffer();
					for (const item of splitText(linkText, { bold, italic }, url)) {
						items.push(item);
					}
					i = closeParen + 1;
					continue;
				}
			}
		}

		buf += ch;
		i += 1;
	}

	if (bold || italic) {
		warnings.push(
			"Unbalanced inline formatting; the unclosed run is rendered without annotations.",
		);
	}

	if (buf.length > 0) {
		for (const item of splitText(buf, { bold: false, italic: false })) {
			items.push(item);
		}
	}
	return items;
}

function findClosing(text: string, start: number, marker: string): number {
	let i = start;
	while (i <= text.length - marker.length) {
		// Skip escaped chars.
		if (text[i] === "\\" && i + 1 < text.length) {
			i += 2;
			continue;
		}
		if (text.startsWith(marker, i)) return i;
		i += 1;
	}
	return -1;
}

/**
 * Splits a string into `RichTextItemRequest[]`, keeping each `text.content`
 * under `MAX_RICH_TEXT_CHARS`. Splits at the last whitespace before the limit
 * when possible; falls back to a hard cut for tokens longer than the limit.
 */
export function splitText(
	content: string,
	annotations: Annotations = {},
	link?: string,
): TextRichTextItem[] {
	if (content.length === 0) return [];

	const items: TextRichTextItem[] = [];
	let rest = content;
	while (rest.length > MAX_RICH_TEXT_CHARS) {
		const slice = rest.slice(0, MAX_RICH_TEXT_CHARS);
		const lastWs = slice.search(/\s\S*$/);
		const cut = lastWs > 0 ? lastWs : MAX_RICH_TEXT_CHARS;
		items.push(buildRichTextItem(rest.slice(0, cut), annotations, link));
		rest = rest.slice(cut).replace(/^\s+/, "");
	}
	if (rest.length > 0) {
		items.push(buildRichTextItem(rest, annotations, link));
	}
	return items;
}

function buildRichTextItem(
	content: string,
	annotations: Annotations,
	link?: string,
): TextRichTextItem {
	const item: TextRichTextItem = {
		text: { content, link: link ? { url: link } : null },
	};
	const a: Annotations = {};
	if (annotations.bold) a.bold = true;
	if (annotations.italic) a.italic = true;
	if (annotations.code) a.code = true;
	if (a.bold || a.italic || a.code) {
		item.annotations = a;
	}
	return item;
}
