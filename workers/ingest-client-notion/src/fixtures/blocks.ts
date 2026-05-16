/**
 * Hand-built fixtures for blocks.test.ts.
 *
 * Each factory returns a complete Block object so tests can construct trees
 * without `as` casts. The shared metadata is built into MK and refined per
 * factory so the discriminated union narrows correctly.
 */

import type { LanguageRequest } from "@notionhq/client/build/src/api-endpoints/common.js";
import type { Block } from "../notion.js";

const META = {
	object: "block" as const,
	parent: { type: "page_id" as const, page_id: "page-x" },
	created_time: "2026-05-16T12:00:00.000Z",
	last_edited_time: "2026-05-16T12:00:00.000Z",
	created_by: { object: "user" as const, id: "user-x" },
	last_edited_by: { object: "user" as const, id: "user-x" },
	has_children: false,
	in_trash: false,
	archived: false,
};

type Annotations = Partial<{
	bold: boolean;
	italic: boolean;
	strikethrough: boolean;
	underline: boolean;
	code: boolean;
}>;

export function text(plain: string, ann: Annotations = {}) {
	return {
		type: "text" as const,
		text: { content: plain, link: null },
		plain_text: plain,
		href: null,
		annotations: {
			bold: ann.bold ?? false,
			italic: ann.italic ?? false,
			strikethrough: ann.strikethrough ?? false,
			underline: ann.underline ?? false,
			code: ann.code ?? false,
			color: "default" as const,
		},
	};
}

function withChildren(block: Block, children?: Block[]): Block {
	if (!children || children.length === 0) return block;
	return { ...block, has_children: true, _children: children };
}

export function paragraph(plain: string, opts?: { ann?: Annotations; children?: Block[]; id?: string }): Block {
	const block: Block = {
		...META,
		id: opts?.id ?? `paragraph-${plain.slice(0, 8)}`,
		type: "paragraph",
		paragraph: { rich_text: [text(plain, opts?.ann)], color: "default", icon: null },
	};
	return withChildren(block, opts?.children);
}

export function heading(level: 1 | 2 | 3, plain: string, opts?: { id?: string }): Block {
	const id = opts?.id ?? `h${level}-${plain.slice(0, 8)}`;
	if (level === 1) {
		return {
			...META,
			id,
			type: "heading_1",
			heading_1: { rich_text: [text(plain)], color: "default", is_toggleable: false },
		};
	}
	if (level === 2) {
		return {
			...META,
			id,
			type: "heading_2",
			heading_2: { rich_text: [text(plain)], color: "default", is_toggleable: false },
		};
	}
	return {
		...META,
		id,
		type: "heading_3",
		heading_3: { rich_text: [text(plain)], color: "default", is_toggleable: false },
	};
}

export function bullet(plain: string, opts?: { children?: Block[]; id?: string }): Block {
	const block: Block = {
		...META,
		id: opts?.id ?? `bullet-${plain.slice(0, 8)}`,
		type: "bulleted_list_item",
		bulleted_list_item: { rich_text: [text(plain)], color: "default" },
	};
	return withChildren(block, opts?.children);
}

export function numbered(plain: string, opts?: { id?: string }): Block {
	return {
		...META,
		id: opts?.id ?? `num-${plain.slice(0, 8)}`,
		type: "numbered_list_item",
		numbered_list_item: { rich_text: [text(plain)], color: "default" },
	};
}

export function todo(plain: string, checked: boolean, opts?: { id?: string }): Block {
	return {
		...META,
		id: opts?.id ?? `todo-${plain.slice(0, 8)}`,
		type: "to_do",
		to_do: { rich_text: [text(plain)], checked, color: "default" },
	};
}

export function code(content: string, language: LanguageRequest, opts?: { id?: string }): Block {
	return {
		...META,
		id: opts?.id ?? `code-${content.slice(0, 8)}`,
		type: "code",
		code: {
			rich_text: [text(content)],
			caption: [],
			language,
		},
	};
}

export function quote(plain: string, opts?: { id?: string }): Block {
	return {
		...META,
		id: opts?.id ?? `quote-${plain.slice(0, 8)}`,
		type: "quote",
		quote: { rich_text: [text(plain)], color: "default" },
	};
}

export function callout(plain: string, emoji: string | null, opts?: { id?: string }): Block {
	return {
		...META,
		id: opts?.id ?? `callout-${plain.slice(0, 8)}`,
		type: "callout",
		callout: {
			rich_text: [text(plain)],
			color: "default",
			icon: emoji === null ? null : { type: "emoji", emoji },
		},
	};
}

export function divider(id = "div-1"): Block {
	return { ...META, id, type: "divider", divider: {} };
}

/**
 * A block whose `type` falls outside the renderer's switch (e.g. "table").
 * The renderer should emit `_[unsupported block: table]_`.
 */
export function unsupportedBlock(id = "unsup-1"): Block {
	return {
		...META,
		id,
		type: "table",
		table: { table_width: 1, has_column_header: false, has_row_header: false },
	};
}
