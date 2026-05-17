import type { CreatePageParameters } from "@notionhq/client/build/src/api-endpoints/pages.js";

import { BRAIN_ID_PROPERTY, DOC_TYPE_SPECS, type DocType } from "./doc-types.js";
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
	status(name: string): PagePropertyValue {
		return { status: { name } };
	},
	date(iso: string): PagePropertyValue {
		return { date: { start: iso } };
	},
	dateRange(start: string, end?: string | null): PagePropertyValue {
		// Notion accepts `{ start, end? }`. Passing `end: undefined` or `null` both
		// fall back to single-date behavior — the SDK type accepts `end?: string | null`.
		if (end && end.length > 0) {
			return { date: { start, end } };
		}
		return { date: { start } };
	},
	checkbox(value: boolean): PagePropertyValue {
		return { checkbox: value };
	},
	url(href: string): PagePropertyValue {
		return { url: href };
	},
	people(userIds: string[]): PagePropertyValue {
		return { people: userIds.map((id) => ({ id, object: "user" as const })) };
	},
};

/**
 * Discriminated payload shape for the push pipeline. `push.ts` builds one of
 * these from the tool input's flat shape after validating per-doctype required
 * fields.
 */
export type PushPayload =
	| {
			docType: "Docs";
			brainId: string;
			title: string;
			type: string;
			status: string;
			bodyMarkdown?: string | null;
	  }
	| {
			docType: "StatusUpdate";
			brainId: string;
			title: string;
			date: string;
			summary: string;
			presenterEmail?: string | null;
			addressed?: boolean | null;
			bodyMarkdown?: string | null;
	  }
	| {
			docType: "Deliverable";
			brainId: string;
			title: string;
			status: string;
			timelineStart: string;
			timelineEnd?: string | null;
			ownerEmail?: string | null;
			bodyMarkdown?: string | null;
	  };

/**
 * Builds the full `properties` map for `pages.create` based on the docType.
 * Required props are always present; optional props are included only when
 * both the payload value is present AND the destination schema records the
 * property as available.
 *
 * `presenterUserId` (StatusUpdate only) and `ownerUserId` (Deliverable only)
 * are email-resolved Notion user ids. When `undefined`, the corresponding
 * people property is emitted with an empty array — the caller is expected
 * to have emitted a warning to the agent. Owner is schema-required, so the
 * key is always present (just empty); Presenter is schema-optional and
 * omitted entirely when unresolved.
 */
export function buildPropertiesFor(
	payload: PushPayload,
	schema: DestSchema,
	presenterUserId?: string,
	ownerUserId?: string,
): PageProperties {
	switch (payload.docType) {
		case "Docs":
			return buildDocs(payload, schema);
		case "StatusUpdate":
			return buildStatusUpdate(payload, schema, presenterUserId);
		case "Deliverable":
			return buildDeliverable(payload, schema, ownerUserId);
	}
}

function buildDocs(
	payload: Extract<PushPayload, { docType: "Docs" }>,
	_schema: DestSchema,
): PageProperties {
	const titleProp = DOC_TYPE_SPECS.Docs.titleProperty.name; // "File Name"
	return {
		[titleProp]: properties.title(payload.title),
		[BRAIN_ID_PROPERTY]: properties.richText(payload.brainId),
		Status: properties.status(payload.status),
		Type: properties.select(payload.type),
	};
}

function buildStatusUpdate(
	payload: Extract<PushPayload, { docType: "StatusUpdate" }>,
	schema: DestSchema,
	presenterUserId?: string,
): PageProperties {
	const titleProp = DOC_TYPE_SPECS.StatusUpdate.titleProperty.name; // "Title"
	const out: PageProperties = {
		[titleProp]: properties.title(payload.title),
		[BRAIN_ID_PROPERTY]: properties.richText(payload.brainId),
		Date: properties.date(payload.date),
		Summary: properties.richText(payload.summary),
	};
	if (schema.optionalPropertiesPresent.Presenter && presenterUserId) {
		out.Presenter = properties.people([presenterUserId]);
	}
	if (
		schema.optionalPropertiesPresent.Addressed &&
		payload.addressed != null
	) {
		out.Addressed = properties.checkbox(payload.addressed);
	}
	return out;
}

function buildDeliverable(
	payload: Extract<PushPayload, { docType: "Deliverable" }>,
	_schema: DestSchema,
	ownerUserId?: string,
): PageProperties {
	const titleProp = DOC_TYPE_SPECS.Deliverable.titleProperty.name; // "Title"
	return {
		[titleProp]: properties.title(payload.title),
		[BRAIN_ID_PROPERTY]: properties.richText(payload.brainId),
		Status: properties.status(payload.status),
		Timeline: properties.dateRange(payload.timelineStart, payload.timelineEnd),
		Owner: properties.people(ownerUserId ? [ownerUserId] : []),
	};
}

export function pickDocType(payload: PushPayload): DocType {
	return payload.docType;
}
