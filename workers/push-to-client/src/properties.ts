import type { CreatePageParameters } from "@notionhq/client/build/src/api-endpoints/pages.js";

import { splitText } from "./markdown.js";
import type { DestSchema } from "./preflight.js";

/**
 * Typed builders for destination DB property values. These produce raw Notion
 * API JSON shapes for `pages.create.properties`, *not* sync-change builders
 * (which use `@notionhq/workers/builder` and a different shape).
 */

export type PageProperties = NonNullable<CreatePageParameters["properties"]>;
export type PagePropertyValue = PageProperties[string];

export const properties = {
	title(value: string): PagePropertyValue {
		return { title: splitText(value) };
	},
	richText(value: string): PagePropertyValue {
		return { rich_text: splitText(value) };
	},
	select(name: string): PagePropertyValue {
		return { select: { name } };
	},
	date(iso: string): PagePropertyValue {
		return { date: { start: iso } };
	},
	url(href: string): PagePropertyValue {
		return { url: href };
	},
};

export type PushPayload = {
	brainId: string;
	title: string;
	source: "Fireflies" | "Slack" | "Loom" | "Other";
	category: string;
	originalDate?: string | null;
	originUrl?: string | null;
	bodyMarkdown?: string | null;
};

/**
 * Builds the full `properties` map for `pages.create`. Required props are
 * always present; optional props are included only when both the payload value
 * is present AND the destination schema has the property declared.
 */
export function buildProperties(
	payload: PushPayload,
	schema: DestSchema,
	now: Date = new Date(),
): PageProperties {
	const out: PageProperties = {
		Title: properties.title(payload.title),
		"Brain ID": properties.richText(payload.brainId),
		Source: properties.select(payload.source),
		Category: properties.select(payload.category),
		"Pushed At": properties.date(now.toISOString()),
	};

	if (schema.hasOriginalDate && payload.originalDate) {
		out["Original Date"] = properties.date(payload.originalDate);
	}
	if (schema.hasOriginUrl && payload.originUrl) {
		out["Origin URL"] = properties.url(payload.originUrl);
	}
	return out;
}
