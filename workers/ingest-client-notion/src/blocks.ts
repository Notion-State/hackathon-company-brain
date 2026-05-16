/**
 * Renders a fetched Notion block tree to markdown.
 *
 * Inputs are pre-built `Block` trees where each block carries its children
 * inline as `_children` (the notion.ts wrapper populates this). The renderer
 * walks the tree, emitting markdown for each known block type and escaping
 * markdown specials in user-supplied text. Unknown types render as
 * `_[unsupported block: <type>]_`.
 *
 * Caps:
 *   - `maxDepth` (default 2): children below this depth render as a single
 *     `_[nested children truncated]_` line.
 *   - `maxBytes` (default 50_000): total UTF-8 byte length. When exceeded, the
 *     output is truncated at the most-recent newline and a marker is appended.
 *
 * Synced data is untrusted. Every rich-text segment goes through `escapeMarkdown`
 * before being concatenated.
 */

import type { PageIconResponse } from "@notionhq/client/build/src/api-endpoints/common.js";
import { TRUNCATED_BLOCK_MARKER, type Block } from "./notion.js";

export const DEFAULT_MAX_BYTES = 50_000;
export const DEFAULT_MAX_DEPTH = 2;

const TRUNCATED_HINT = "_…[truncated at 50KB; see source page]_";
const NESTED_TRUNCATED_HINT = "_[nested children truncated]_";
const TRUNCATED_BLOCK_HINT = "_[content truncated; see source page]_";

type RichTextItem = {
	plain_text: string;
	href: string | null;
	annotations: {
		bold: boolean;
		italic: boolean;
		strikethrough: boolean;
		underline: boolean;
		code: boolean;
	};
};

/** Escape characters that markdown would interpret as formatting. */
export function escapeMarkdown(input: string): string {
	return input
		.replace(/\\/g, "\\\\")
		.replace(/\*/g, "\\*")
		.replace(/_/g, "\\_")
		.replace(/`/g, "\\`")
		.replace(/\[/g, "\\[")
		.replace(/\]/g, "\\]")
		.replace(/</g, "\\<")
		.replace(/>/g, "\\>")
		.replace(/#/g, "\\#");
}

export function renderBlocksMarkdown(
	blocks: Block[],
	opts: { maxBytes?: number; maxDepth?: number } = {},
): string {
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
	const parts: string[] = [];
	const ctx: RenderCtx = { byteCount: 0, maxBytes, truncated: false };

	renderInto(parts, ctx, blocks, 0, maxDepth);

	if (ctx.truncated) {
		// Trim any in-progress part: truncate at last newline so we don't split a line.
		const joined = parts.join("");
		const lastNewline = joined.lastIndexOf("\n");
		const safe = lastNewline > 0 ? joined.slice(0, lastNewline) : joined;
		return `${safe}\n\n${TRUNCATED_HINT}`;
	}
	return parts.join("");
}

type RenderCtx = {
	byteCount: number;
	maxBytes: number;
	truncated: boolean;
};

function pushPart(parts: string[], ctx: RenderCtx, part: string): boolean {
	if (ctx.truncated) return false;
	const len = Buffer.byteLength(part, "utf8");
	if (ctx.byteCount + len > ctx.maxBytes) {
		ctx.truncated = true;
		return false;
	}
	parts.push(part);
	ctx.byteCount += len;
	return true;
}

function renderInto(
	parts: string[],
	ctx: RenderCtx,
	blocks: Block[],
	indentLevel: number,
	remainingDepth: number,
): void {
	let numberedCounter = 0;
	let prevWasNumbered = false;
	for (const block of blocks) {
		if (ctx.truncated) return;
		if (block.id === TRUNCATED_BLOCK_MARKER) {
			pushPart(parts, ctx, `${indent(indentLevel)}${TRUNCATED_BLOCK_HINT}\n`);
			continue;
		}
		if (block.type === "numbered_list_item") {
			if (!prevWasNumbered) numberedCounter = 0;
			numberedCounter += 1;
			prevWasNumbered = true;
		} else {
			prevWasNumbered = false;
			numberedCounter = 0;
		}
		const rendered = renderBlock(block, indentLevel, numberedCounter);
		if (rendered) pushPart(parts, ctx, rendered);

		if (block._children && block._children.length > 0) {
			if (remainingDepth > 0) {
				renderInto(parts, ctx, block._children, indentLevel + 1, remainingDepth - 1);
			} else {
				pushPart(parts, ctx, `${indent(indentLevel + 1)}${NESTED_TRUNCATED_HINT}\n`);
			}
		}
	}
}

function indent(level: number): string {
	return "  ".repeat(level);
}

function renderBlock(block: Block, indentLevel: number, numberedIndex: number): string {
	const pad = indent(indentLevel);
	switch (block.type) {
		case "paragraph":
			return `${pad}${renderRichText(block.paragraph.rich_text)}\n\n`;
		case "heading_1":
			return `${pad}# ${renderRichText(block.heading_1.rich_text)}\n\n`;
		case "heading_2":
			return `${pad}## ${renderRichText(block.heading_2.rich_text)}\n\n`;
		case "heading_3":
			return `${pad}### ${renderRichText(block.heading_3.rich_text)}\n\n`;
		case "bulleted_list_item":
			return `${pad}- ${renderRichText(block.bulleted_list_item.rich_text)}\n`;
		case "numbered_list_item":
			return `${pad}${numberedIndex}. ${renderRichText(block.numbered_list_item.rich_text)}\n`;
		case "to_do": {
			const mark = block.to_do.checked ? "[x]" : "[ ]";
			return `${pad}- ${mark} ${renderRichText(block.to_do.rich_text)}\n`;
		}
		case "code": {
			const lang = block.code.language ?? "";
			const text = concatPlainText(block.code.rich_text);
			return `${pad}\`\`\`${lang}\n${text}\n${pad}\`\`\`\n\n`;
		}
		case "quote":
			return `${pad}> ${renderRichText(block.quote.rich_text)}\n\n`;
		case "callout": {
			const emoji = calloutEmoji(block.callout.icon);
			const text = renderRichText(block.callout.rich_text);
			return `${pad}> ${emoji}${emoji ? " " : ""}${text}\n\n`;
		}
		case "divider":
			return `${pad}---\n\n`;
		default:
			return `${pad}_[unsupported block: ${escapeMarkdown(block.type)}]_\n\n`;
	}
}

function concatPlainText(items: ReadonlyArray<RichTextItem>): string {
	let out = "";
	for (const item of items) out += item.plain_text;
	return out;
}

function renderRichText(items: ReadonlyArray<RichTextItem>): string {
	let out = "";
	for (const item of items) {
		const plain = escapeMarkdown(item.plain_text);
		out += applyAnnotations(plain, item.annotations);
	}
	return out;
}

function applyAnnotations(text: string, ann: RichTextItem["annotations"]): string {
	if (text.length === 0) return text;
	let wrapped = text;
	if (ann.code) wrapped = `\`${wrapped}\``;
	if (ann.bold) wrapped = `**${wrapped}**`;
	if (ann.italic) wrapped = `*${wrapped}*`;
	if (ann.strikethrough) wrapped = `~~${wrapped}~~`;
	return wrapped;
}

function calloutEmoji(icon: PageIconResponse | null): string {
	if (!icon) return "";
	if (icon.type === "emoji") return icon.emoji;
	return "";
}
