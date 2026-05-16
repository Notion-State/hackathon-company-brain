/**
 * Hand-built page fixtures for render.test.ts. Property values are typed
 * against PageObjectResponse["properties"]["..."] so the discriminated union
 * narrows correctly without `as` casts.
 */

import type {
	PageObjectResponse,
	RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints/common.js";

type Property = PageObjectResponse["properties"][string];

const TS = "2026-05-16T12:00:00.000Z";

function txtItem(plain: string): RichTextItemResponse {
	return {
		type: "text",
		text: { content: plain, link: null },
		plain_text: plain,
		href: null,
		annotations: {
			bold: false,
			italic: false,
			strikethrough: false,
			underline: false,
			code: false,
			color: "default",
		},
	};
}

const PAGE_META = {
	object: "page" as const,
	parent: { type: "database_id" as const, database_id: "db-x" },
	created_time: "2026-05-01T00:00:00.000Z",
	last_edited_time: TS,
	created_by: { object: "user" as const, id: "creator" },
	last_edited_by: { object: "user" as const, id: "editor" },
	cover: null,
	icon: null,
	archived: false,
	in_trash: false,
	is_archived: false,
	is_locked: false,
	public_url: null,
};

export function title(plain: string, id = "title-prop"): Property {
	return { id, type: "title", title: [txtItem(plain)] };
}

export function richText(plain: string, id = "rt-prop"): Property {
	return { id, type: "rich_text", rich_text: [txtItem(plain)] };
}

export function selectProp(name: string | null, id = "sel-prop"): Property {
	return {
		id,
		type: "select",
		select: name === null ? null : {
			id: `opt-${name}`,
			name,
			color: "default",
		},
	};
}

export function statusProp(name: string | null, id = "stat-prop"): Property {
	return {
		id,
		type: "status",
		status: name === null ? null : {
			id: `opt-${name}`,
			name,
			color: "default",
		},
	};
}

export function urlProp(url: string | null, id = "url-prop"): Property {
	return { id, type: "url", url };
}

export function uniqueIdProp(prefix: string | null, number: number | null, id = "uid-prop"): Property {
	return { id, type: "unique_id", unique_id: { prefix, number } };
}

export function formulaProp(value: string, id = "fml-prop"): Property {
	return { id, type: "formula", formula: { type: "string", string: value } };
}

export function personUser(name: string | null, email: string | undefined, id: string) {
	return {
		object: "user" as const,
		id,
		name,
		avatar_url: null,
		type: "person" as const,
		person: email === undefined ? {} : { email },
	};
}

export function peopleProp(users: ReturnType<typeof personUser>[], id = "people-prop"): Property {
	return { id, type: "people", people: users };
}

export function makePage(props: Record<string, Property>, opts?: { id?: string; url?: string; created?: string; lastEdited?: string }): PageObjectResponse {
	return {
		...PAGE_META,
		id: opts?.id ?? "page-1",
		url: opts?.url ?? "https://notion.so/page-1",
		created_time: opts?.created ?? PAGE_META.created_time,
		last_edited_time: opts?.lastEdited ?? PAGE_META.last_edited_time,
		properties: props,
	};
}
