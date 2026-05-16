/**
 * Per-`DocType` metadata: title property name, required + optional property
 * names with their Notion-side types, and the payload-field → property-name
 * mapping that the property builder follows.
 *
 * Single source of truth so `preflight.ts`, `properties.ts`, and `push.ts`
 * don't each re-encode the canonical schema.
 *
 * Schemas mirror the Transformation Hub canonical reference:
 *   https://www.notion.so/d931147211b445d9b62b0fd66cf5ff2b
 * filtered to `Source Database = Docs`, `Status Updates`, `Deliverables`.
 *
 * `Brain ID` (rich_text) is augmented onto every destination by us — it's our
 * idempotency key and the only property the client adds beyond the canonical
 * schema.
 *
 * Relations (`Project` on Docs, `Event` on Status Updates) are intentionally
 * omitted: cross-workspace push can't resolve destination-side ids without
 * caller help. Documented as a known limitation in the README.
 */

export const DOC_TYPES = ["Docs", "StatusUpdate", "Deliverable"] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const BRAIN_ID_PROPERTY = "Brain ID";

export type PropertySpec = {
	/** Notion-side property name (case-sensitive). */
	name: string;
	/** Notion property type, e.g. "title", "rich_text", "select", "status", "date", "checkbox", "people". */
	type: string;
	/** When true, preflight reads the property's options into the schema. */
	hasOptions?: boolean;
};

export type DocTypeSpec = {
	docType: DocType;
	/** Human label used in agent-facing error messages. */
	label: string;
	/** Notion property that holds the page title for this destination. */
	titleProperty: PropertySpec;
	/** Required non-title canonical properties. Preflight fails closed if any are missing. */
	requiredProperties: PropertySpec[];
	/** Optional canonical properties — preflight records presence; push includes them when payload has the value AND the property exists in the destination. */
	optionalProperties: PropertySpec[];
	/** Payload fields this doc type requires before any network I/O. Index.ts checks these in `execute`. */
	requiredPayloadFields: PayloadField[];
};

/** Payload fields the tool input may carry. Per-type required subsets are listed in DOC_TYPE_SPECS. */
export type PayloadField =
	| "title"
	| "type"
	| "status"
	| "date"
	| "summary"
	| "presenterEmail"
	| "addressed"
	| "timelineStart"
	| "timelineEnd";

export const DOC_TYPE_SPECS: Record<DocType, DocTypeSpec> = {
	Docs: {
		docType: "Docs",
		label: "Doc",
		titleProperty: { name: "File Name", type: "title" },
		requiredProperties: [
			{ name: "Status", type: "status", hasOptions: true },
			{ name: "Type", type: "select", hasOptions: true },
		],
		optionalProperties: [],
		requiredPayloadFields: ["title", "type", "status"],
	},
	StatusUpdate: {
		docType: "StatusUpdate",
		label: "Status Update",
		titleProperty: { name: "Title", type: "title" },
		requiredProperties: [
			{ name: "Date", type: "date" },
			{ name: "Summary", type: "rich_text" },
		],
		optionalProperties: [
			{ name: "Presenter", type: "people" },
			{ name: "Addressed", type: "checkbox" },
		],
		requiredPayloadFields: ["title", "date", "summary"],
	},
	Deliverable: {
		docType: "Deliverable",
		label: "Deliverable",
		titleProperty: { name: "Title", type: "title" },
		requiredProperties: [
			{ name: "Status", type: "status", hasOptions: true },
			{ name: "Timeline", type: "date" },
		],
		optionalProperties: [],
		requiredPayloadFields: ["title", "status", "timelineStart"],
	},
};

/**
 * Convenience: walk both required and optional props together. The `kind` field
 * lets preflight distinguish "missing required → error" from "missing optional
 * → just don't record the presence flag".
 */
export function allPropertySpecs(
	spec: DocTypeSpec,
): Array<PropertySpec & { kind: "title" | "required" | "optional" }> {
	return [
		{ ...spec.titleProperty, kind: "title" },
		...spec.requiredProperties.map((p) => ({ ...p, kind: "required" as const })),
		...spec.optionalProperties.map((p) => ({ ...p, kind: "optional" as const })),
	];
}
