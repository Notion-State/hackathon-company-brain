import { APIErrorCode, APIResponseError } from "@notionhq/client";

import { translateNotionError } from "./api-errors.js";
import {
	BRAIN_ID_PROPERTY,
	DOC_TYPE_SPECS,
	allPropertySpecs,
	type DocType,
} from "./doc-types.js";
import { DestinationSchemaMismatch } from "./errors.js";
import type { ClientApi } from "./notion-client.js";

/**
 * Per-`(clientId, docType, destDbId)` schema verification of a client's
 * destination database.
 *
 * Resolves the database id → its single data source, walks the data source's
 * property schema against the canonical Transformation Hub spec for that
 * docType plus our `Brain ID` rich_text augmentation. Captures any select /
 * status option sets so push-time validation can give actionable errors before
 * any write.
 *
 * Cached in a `PreflightCache` whose key is `${clientId}:${docType}:${destDbId}`.
 */

export type OptionalPropertyFlag = "Presenter" | "Addressed";

export type DestSchema = {
	dataSourceId: string;
	/** Status-property allowed option names (set when the spec marks Status as hasOptions). */
	statusOptions: Set<string>;
	/** Select-property allowed option names for the `Type` property (Docs only). */
	typeOptions: Set<string>;
	/** Optional-property presence by name. Push only includes optional props that are both present in the destination and supplied by the payload. */
	optionalPropertiesPresent: Record<OptionalPropertyFlag, boolean>;
};

export class PreflightCache {
	private readonly map = new Map<string, Promise<DestSchema>>();

	get(api: ClientApi, docType: DocType): Promise<DestSchema> {
		const destDbId = api.destDbIdsByType[docType];
		const key = `${api.id}:${docType}:${destDbId}`;
		const existing = this.map.get(key);
		if (existing) return existing;

		const pending = verifyDestSchema(api, docType).catch((err) => {
			this.map.delete(key);
			throw err;
		});
		this.map.set(key, pending);
		return pending;
	}

	clear(): void {
		this.map.clear();
	}

	/**
	 * Test-only seam: pre-populate the cache with a resolved schema so tests
	 * that exercise `pushToClient` don't have to also mock the underlying
	 * `databases.retrieve` / `dataSources.retrieve` calls used by preflight.
	 *
	 * @internal
	 */
	seed(
		key: Pick<ClientApi, "id"> & { docType: DocType; destDbId: string },
		schema: DestSchema,
	): void {
		this.map.set(`${key.id}:${key.docType}:${key.destDbId}`, Promise.resolve(schema));
	}
}

export async function verifyDestSchema(
	api: ClientApi,
	docType: DocType,
): Promise<DestSchema> {
	const spec = DOC_TYPE_SPECS[docType];
	const destDbId = api.destDbIdsByType[docType];

	// Step 1: resolve database id → single data source id.
	let dbResponse: unknown;
	try {
		await api.waitForPacer();
		dbResponse = await api.sdk.databases.retrieve({ database_id: destDbId });
	} catch (err) {
		throw translateDbError(api.id, err);
	}

	const dataSourceId = resolveSoleDataSource(dbResponse);

	// Step 2: retrieve the data source's full property schema.
	let dsResponse: unknown;
	try {
		await api.waitForPacer();
		dsResponse = await api.sdk.dataSources.retrieve({ data_source_id: dataSourceId });
	} catch (err) {
		throw translateDbError(api.id, err);
	}

	const props = extractProperties(dsResponse);

	// Step 3: walk the canonical schema for this doc type.
	const missing: string[] = [];
	const wrongType: Array<{ name: string; expected: string; actual: string }> = [];
	const optionalPropertiesPresent: Record<OptionalPropertyFlag, boolean> = {
		Presenter: false,
		Addressed: false,
	};
	let statusOptions = new Set<string>();
	let typeOptions = new Set<string>();

	for (const ps of allPropertySpecs(spec)) {
		const p = props[ps.name];
		if (!p) {
			if (ps.kind === "optional") continue;
			missing.push(ps.name);
			continue;
		}
		if (p.type !== ps.type) {
			if (ps.kind === "optional") continue; // wrong-type on optional → just skip (don't set the flag)
			wrongType.push({ name: ps.name, expected: ps.type, actual: p.type });
			continue;
		}
		if (ps.kind === "optional") {
			if (ps.name === "Presenter") optionalPropertiesPresent.Presenter = true;
			if (ps.name === "Addressed") optionalPropertiesPresent.Addressed = true;
		}
		if (ps.hasOptions) {
			if (ps.name === "Status") {
				statusOptions = extractStatusOptions(p);
			} else if (ps.name === "Type") {
				typeOptions = extractSelectOptions(p);
			}
		}
	}

	// Step 4: verify the Brain ID augmentation. Required on every destination.
	const brain = props[BRAIN_ID_PROPERTY];
	if (!brain) {
		missing.push(BRAIN_ID_PROPERTY);
	} else if (brain.type !== "rich_text") {
		wrongType.push({
			name: BRAIN_ID_PROPERTY,
			expected: "rich_text",
			actual: brain.type,
		});
	}

	if (missing.length > 0 || wrongType.length > 0) {
		throw new DestinationSchemaMismatch({ missing, wrongType });
	}

	return {
		dataSourceId,
		statusOptions,
		typeOptions,
		optionalPropertiesPresent,
	};
}

function resolveSoleDataSource(dbResponse: unknown): string {
	if (!isObject(dbResponse) || !Array.isArray(dbResponse.data_sources)) {
		throw new DestinationSchemaMismatch({
			missing: [],
			wrongType: [],
			hint: "Destination database response did not include a data_sources list. Ensure the integration is shared with the database (Connections menu).",
		});
	}
	const refs = dbResponse.data_sources;
	if (refs.length !== 1) {
		throw new DestinationSchemaMismatch({
			missing: [],
			wrongType: [],
			hint: `Destination database must contain exactly one data source (found ${refs.length}). Multi-source destination DBs are not supported.`,
		});
	}
	const ref = refs[0];
	if (!isObject(ref) || typeof ref.id !== "string") {
		throw new DestinationSchemaMismatch({
			missing: [],
			wrongType: [],
			hint: "Destination database response had a malformed data_sources entry.",
		});
	}
	return ref.id;
}

type PropEntry = {
	type: string;
	select?: { options?: Array<{ name?: string }> };
	status?: { options?: Array<{ name?: string }> };
};

function extractProperties(dsResponse: unknown): Record<string, PropEntry> {
	if (!isObject(dsResponse) || !isObject(dsResponse.properties)) return {};
	const out: Record<string, PropEntry> = {};
	for (const [name, raw] of Object.entries(dsResponse.properties)) {
		if (!isObject(raw) || typeof raw.type !== "string") continue;
		const entry: PropEntry = { type: raw.type };
		if (raw.type === "select" && isObject(raw.select)) {
			entry.select = readOptions(raw.select);
		}
		if (raw.type === "status" && isObject(raw.status)) {
			entry.status = readOptions(raw.status);
		}
		out[name] = entry;
	}
	return out;
}

function readOptions(raw: Record<string, unknown>): {
	options?: Array<{ name?: string }>;
} {
	const opts = raw.options;
	if (!Array.isArray(opts)) return {};
	return {
		options: opts
			.filter(isObject)
			.map((o) => ({ name: typeof o.name === "string" ? o.name : undefined })),
	};
}

function extractSelectOptions(p: PropEntry): Set<string> {
	const out = new Set<string>();
	for (const o of p.select?.options ?? []) {
		if (typeof o.name === "string") out.add(o.name);
	}
	return out;
}

function extractStatusOptions(p: PropEntry): Set<string> {
	const out = new Set<string>();
	for (const o of p.status?.options ?? []) {
		if (typeof o.name === "string") out.add(o.name);
	}
	return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function translateDbError(clientId: string, err: unknown): unknown {
	if (
		err instanceof APIResponseError &&
		err.code === APIErrorCode.ObjectNotFound
	) {
		return new DestinationSchemaMismatch({
			missing: [],
			wrongType: [],
			hint: "Destination database not found. Either the id is wrong or the integration has not been shared with this database (Connections menu).",
		});
	}
	return translateNotionError(clientId, err);
}
