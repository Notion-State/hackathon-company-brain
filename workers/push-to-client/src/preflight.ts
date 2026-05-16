import { APIErrorCode, APIResponseError } from "@notionhq/client";

import { translateNotionError } from "./api-errors.js";
import { DestinationSchemaMismatch } from "./errors.js";
import type { ClientApi } from "./notion-client.js";

/**
 * Pre-flight verification of a destination "Company Brain Inbox" database.
 *
 * Resolves the database id → its single data source id, then walks the data
 * source's property schema. Required properties must exist with the listed
 * type; optional properties are tracked as flags so the property builder can
 * include or skip them. The `Category` select options are captured for
 * push-time validation.
 *
 * Results are cached in a `PreflightCache` keyed by `clientId:destDbId`. The
 * cache stores the *promise* so concurrent first calls share one HTTP request.
 * Rejected promises are cleared so retries try again.
 */

export type DestSchema = {
	dataSourceId: string;
	hasOriginalDate: boolean;
	hasOriginUrl: boolean;
	categoryOptions: Set<string>;
};

type RequiredCheck = { name: string; expected: string };

const REQUIRED: RequiredCheck[] = [
	{ name: "Title", expected: "title" },
	{ name: "Brain ID", expected: "rich_text" },
	{ name: "Source", expected: "select" },
	{ name: "Category", expected: "select" },
	{ name: "Pushed At", expected: "date" },
];

type OptionalCheck = {
	name: string;
	expected: string;
	flag: "hasOriginalDate" | "hasOriginUrl";
};

const OPTIONAL: OptionalCheck[] = [
	{ name: "Original Date", expected: "date", flag: "hasOriginalDate" },
	{ name: "Origin URL", expected: "url", flag: "hasOriginUrl" },
];

export class PreflightCache {
	private readonly map = new Map<string, Promise<DestSchema>>();

	get(api: ClientApi): Promise<DestSchema> {
		const key = `${api.id}:${api.destDbId}`;
		const existing = this.map.get(key);
		if (existing) return existing;

		const pending = verifyDestSchema(api).catch((err) => {
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
	seed(key: Pick<ClientApi, "id" | "destDbId">, schema: DestSchema): void {
		this.map.set(`${key.id}:${key.destDbId}`, Promise.resolve(schema));
	}
}

export async function verifyDestSchema(api: ClientApi): Promise<DestSchema> {
	// Step 1: resolve the database id → single data source id.
	let dbResponse: unknown;
	try {
		await api.waitForPacer();
		dbResponse = await api.sdk.databases.retrieve({ database_id: api.destDbId });
	} catch (err) {
		throw translateDbError(api.id, err);
	}

	const dataSourceId = resolveSoleDataSource(dbResponse);

	// Step 2: retrieve the data source's full property schema.
	let dsResponse: unknown;
	try {
		await api.waitForPacer();
		dsResponse = await api.sdk.dataSources.retrieve({
			data_source_id: dataSourceId,
		});
	} catch (err) {
		throw translateDbError(api.id, err);
	}

	const props = extractProperties(dsResponse);

	// Step 3: walk required + optional properties.
	const missing: string[] = [];
	const wrongType: Array<{ name: string; expected: string; actual: string }> = [];

	for (const req of REQUIRED) {
		const p = props[req.name];
		if (!p) {
			missing.push(req.name);
			continue;
		}
		if (p.type !== req.expected) {
			wrongType.push({ name: req.name, expected: req.expected, actual: p.type });
		}
	}

	const flags = { hasOriginalDate: false, hasOriginUrl: false };
	for (const opt of OPTIONAL) {
		const p = props[opt.name];
		if (!p) continue;
		if (p.type !== opt.expected) {
			wrongType.push({ name: opt.name, expected: opt.expected, actual: p.type });
			continue;
		}
		flags[opt.flag] = true;
	}

	if (missing.length > 0 || wrongType.length > 0) {
		throw new DestinationSchemaMismatch({ missing, wrongType });
	}

	// Step 4: capture Category select options.
	const categoryProp = props["Category"];
	const categoryOptions = new Set<string>();
	if (categoryProp && categoryProp.type === "select" && Array.isArray(categoryProp.select?.options)) {
		for (const opt of categoryProp.select.options) {
			if (typeof opt.name === "string") categoryOptions.add(opt.name);
		}
	}

	return {
		dataSourceId,
		hasOriginalDate: flags.hasOriginalDate,
		hasOriginUrl: flags.hasOriginUrl,
		categoryOptions,
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
};

function extractProperties(dsResponse: unknown): Record<string, PropEntry> {
	if (!isObject(dsResponse) || !isObject(dsResponse.properties)) return {};
	const out: Record<string, PropEntry> = {};
	for (const [name, raw] of Object.entries(dsResponse.properties)) {
		if (!isObject(raw) || typeof raw.type !== "string") continue;
		const entry: PropEntry = { type: raw.type };
		if (raw.type === "select" && isObject(raw.select)) {
			const opts = (raw.select as { options?: unknown }).options;
			if (Array.isArray(opts)) {
				entry.select = {
					options: opts
						.filter(isObject)
						.map((o) => ({ name: typeof o.name === "string" ? o.name : undefined })),
				};
			}
		}
		out[name] = entry;
	}
	return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function translateDbError(clientId: string, err: unknown): unknown {
	// 404 has a specific actionable framing for the destination DB context
	// (the most common cause is "integration not shared with this database").
	// All other errors get the shared translator.
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
