/**
 * Pure conversions: a client's Notion `FeatureRequestPage` → Notion managed-DB
 * property values and the page-body markdown.
 *
 * Readers are intentionally defensive: a missing property, wrong `type`, null,
 * or empty array always falls back to a typed empty value rather than throwing.
 * That keeps a single client with a schema-drifted DB from killing the cycle —
 * we'd rather emit a partial row than crash.
 *
 * The SDK's strict `SyncChangeUpsert` mapped type requires every schema-declared
 * property to appear in every change record, so `toChangeProperties` always
 * emits every key with a typed fallback (mirrors workers/ingest-fireflies/src/render.ts:145-172).
 */

import * as Builder from "@notionhq/workers/builder";
import type {
	GroupObjectResponse,
	PageObjectResponse,
	PartialUserObjectResponse,
	RichTextItemResponse,
	UserObjectResponse,
} from "@notionhq/client/build/src/api-endpoints/common.js";

import { escapeMarkdown } from "./blocks.js";

type PageProperty = PageObjectResponse["properties"][string];
type PageProperties = PageObjectResponse["properties"];

const STATUS_FALLBACK = "Triage";

/** Build the composite primary key. */
export function recordId(clientId: string, pageId: string): string {
	return `${clientId}:${pageId}`;
}

/** Find the title property by type. Notion guarantees exactly one. */
export function findTitle(props: PageProperties): string {
	for (const key of Object.keys(props)) {
		const value: PageProperty | undefined = props[key];
		if (value && value.type === "title") {
			const text = concatRichText(value.title).trim();
			if (text.length > 0) return text;
		}
	}
	return "";
}

export function readRichText(prop: PageProperty | undefined): string {
	if (!prop) return "";
	if (prop.type !== "rich_text") return "";
	return concatRichText(prop.rich_text);
}

export function readSelect(prop: PageProperty | undefined): string {
	if (!prop) return "";
	if (prop.type !== "select") return "";
	return prop.select?.name ?? "";
}

export function readStatus(prop: PageProperty | undefined): string {
	if (!prop) return "";
	if (prop.type !== "status") return "";
	return prop.status?.name ?? "";
}

export function readUrl(prop: PageProperty | undefined): string {
	if (!prop) return "";
	if (prop.type !== "url") return "";
	return prop.url ?? "";
}

export function readUniqueId(prop: PageProperty | undefined): string {
	if (!prop) return "";
	if (prop.type !== "unique_id") return "";
	const { prefix, number } = prop.unique_id;
	if (number == null) return "";
	return prefix ? `${prefix}-${number}` : `#${number}`;
}

export function readFormula(prop: PageProperty | undefined): string {
	if (!prop) return "";
	if (prop.type !== "formula") return "";
	const f = prop.formula;
	switch (f.type) {
		case "string":
			return f.string ?? "";
		case "number":
			return f.number == null ? "" : String(f.number);
		case "boolean":
			return f.boolean == null ? "" : f.boolean ? "true" : "false";
		case "date":
			return f.date?.start ?? "";
		default:
			return "";
	}
}

export function readPeople(prop: PageProperty | undefined): string {
	if (!prop) return "";
	if (prop.type !== "people") return "";
	const parts: string[] = [];
	for (const entry of prop.people) {
		const s = serializeUserOrGroup(entry);
		if (s) parts.push(s);
	}
	return parts.join(", ");
}

/** Same shape as readPeople — single Person properties still come back as arrays. */
export const readPersonSingle = readPeople;

function serializeUserOrGroup(
	entry: UserObjectResponse | PartialUserObjectResponse | GroupObjectResponse,
): string {
	if (entry.object === "group") {
		return escapeSerializedField(entry.name ?? "");
	}
	if (!("name" in entry)) return ""; // PartialUserObjectResponse — id only
	const name = escapeSerializedField(entry.name ?? "");
	const email = "type" in entry && entry.type === "person" ? entry.person?.email : undefined;
	if (name && email) return `${name} <${escapeSerializedField(email)}>`;
	return name;
}

/** Strip characters that would break the `Name <email>, Name2 <email2>` shape. */
function escapeSerializedField(s: string): string {
	return s.replace(/[<>,]/g, " ").replace(/\s+/g, " ").trim();
}

function concatRichText(rt: ReadonlyArray<RichTextItemResponse>): string {
	let out = "";
	for (const r of rt) out += r.plain_text;
	return out;
}

/**
 * Build the Notion property map for a change record. Every property emitted,
 * always — the SDK's strict mapped type requires every declared key on each
 * upsert.
 */
export function toChangeProperties(
	page: PageObjectResponse,
	clientId: string,
	now: Date,
) {
	const props = page.properties;
	const titleText = findTitle(props) || "Untitled feature request";
	const composite = recordId(clientId, page.id);
	const status = readStatus(props.Status) || STATUS_FALLBACK;

	return {
		Title: Builder.title(titleText),
		"Record ID": Builder.richText(composite),
		Client: Builder.select(clientId),
		Source: Builder.select("Notion"),
		"Source Page ID": Builder.richText(page.id),
		"Source Unique ID": Builder.richText(readUniqueId(props.ID)),
		"Source URL": Builder.url(page.url),
		Description: Builder.richText(readRichText(props.Description)),
		Status: Builder.status(status),
		Priority: Builder.select(readSelect(props.Priority)),
		Complexity: Builder.select(readSelect(props.Complexity)),
		Effort: Builder.select(readSelect(props.Effort)),
		Projection: Builder.select(readSelect(props.Projection)),
		Type: Builder.richText(readSelect(props.Type)),
		Team: Builder.richText(readRichText(props.Team)),
		Dependencies: Builder.richText(readRichText(props.Dependencies)),
		"Assigned Owner": Builder.richText(readSelect(props["Assigned Owner"])),
		Submitter: Builder.richText(readPeople(props.Submitter)),
		POC: Builder.richText(readPeople(props.POC)),
		"Support Owner": Builder.richText(readPersonSingle(props["Support Owner"])),
		"Technical Lead": Builder.richText(readPersonSingle(props["Technical Lead"])),
		"Proposed Owner": Builder.richText(readFormula(props["Proposed Owner"])),
		"Source Created Time": Builder.dateTime(page.created_time),
		"Source Last Edited Time": Builder.dateTime(page.last_edited_time),
		"Synced At": Builder.dateTime(now.toISOString()),
	};
}

/**
 * Render the page body. The header summarizes the mapped properties and links
 * to the source. `blocksMarkdown` is already escape-safe (built by blocks.ts).
 */
export function renderPageMarkdown(
	page: PageObjectResponse,
	blocksMarkdown: string,
	clientId: string,
): string {
	const props = page.properties;
	const titleText = findTitle(props) || "Untitled feature request";
	const status = readStatus(props.Status) || "(no status)";
	const priority = readSelect(props.Priority) || "(no priority)";
	const description = readRichText(props.Description);

	const parts: string[] = [];
	parts.push(`# ${escapeMarkdown(titleText)}`);
	parts.push("");
	parts.push(
		`**Client:** ${escapeMarkdown(clientId)}  |  ` +
			`**Status:** ${escapeMarkdown(status)}  |  ` +
			`**Priority:** ${escapeMarkdown(priority)}`,
	);
	parts.push(`**Source:** ${page.url}  |  **Last edited:** ${page.last_edited_time}`);
	parts.push("");

	parts.push("## Description property");
	parts.push(description.trim() ? escapeMarkdown(description) : "_No description property._");
	parts.push("");

	parts.push("## Page content");
	parts.push("");
	parts.push(blocksMarkdown.trim() ? blocksMarkdown : "_No page content._");
	return parts.join("\n");
}
