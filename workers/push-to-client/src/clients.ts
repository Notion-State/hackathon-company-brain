/**
 * Enumerates configured client destinations from env vars.
 *
 * Per-client config (all keyed by the same suffix `<ID>`):
 *   - `CLIENT_TOKEN_<ID>`              — the client's internal-integration token (`ntn_...`).
 *   - `CLIENT_DOCS_DB_<ID>`            — the client's Docs destination database id.
 *   - `CLIENT_STATUS_UPDATES_DB_<ID>`  — the client's Status Updates destination database id.
 *   - `CLIENT_DELIVERABLES_DB_<ID>`    — the client's Deliverables destination database id.
 *   - `CLIENT_MODE_<ID>`               — optional, `"staging"` (default) or `"production"`.
 *
 * Each destination database mirrors the canonical Transformation Hub schema
 * for its type (see SCHEMA.md) PLUS a `Brain ID` rich_text augmentation we
 * publish for idempotency.
 *
 * `<ID>` is uppercase in env-var names; the parsed `id` is its lowercase form.
 *
 * Adding a client is a config change, not a code change — but the worker must
 * be redeployed for the new per-client pacer and SDK client to wire up.
 *
 * Throws if zero clients are configured or any client has partial config (any
 * required env var present without the others for that client).
 */

import { DOC_TYPES, type DocType } from "./doc-types.js";

export type ClientMode = "staging" | "production";

export type ClientConfig = {
	id: string;
	token: string;
	destDbIdsByType: Record<DocType, string>;
	mode: ClientMode;
};

const TOKEN_PREFIX = "CLIENT_TOKEN_";
const MODE_PREFIX = "CLIENT_MODE_";

/**
 * Maps each DocType to the env-var prefix that supplies its destination DB id.
 * Same suffix `<ID>` across all four prefixes identifies one client.
 */
const DEST_DB_PREFIXES: Record<DocType, string> = {
	Docs: "CLIENT_DOCS_DB_",
	StatusUpdate: "CLIENT_STATUS_UPDATES_DB_",
	Deliverable: "CLIENT_DELIVERABLES_DB_",
};

const ALL_PREFIXES = [
	TOKEN_PREFIX,
	MODE_PREFIX,
	...Object.values(DEST_DB_PREFIXES),
];

export function getClients(
	env: NodeJS.ProcessEnv = process.env,
): ClientConfig[] {
	// Discover the set of client ids by union of suffixes across all prefixes.
	const idsBySuffix = new Set<string>();
	for (const name of Object.keys(env)) {
		const suffix = matchPrefix(name);
		if (suffix !== undefined) idsBySuffix.add(suffix);
	}

	const clients: ClientConfig[] = [];
	for (const suffix of idsBySuffix) {
		const token = (env[TOKEN_PREFIX + suffix] ?? "").trim();
		const rawMode = (env[MODE_PREFIX + suffix] ?? "").trim().toLowerCase();
		const dbIds: Partial<Record<DocType, string>> = {};
		for (const docType of DOC_TYPES) {
			const raw = (env[DEST_DB_PREFIXES[docType] + suffix] ?? "").trim();
			if (raw) dbIds[docType] = raw;
		}

		const id = suffix.toLowerCase();
		if (id.length === 0) continue;

		// Nothing set at all for this suffix → not actually a client, skip.
		const anyDb = Object.keys(dbIds).length > 0;
		if (!token && !anyDb && !rawMode) continue;

		// Partial config is a hard error — silently dropping it would hide a
		// misconfigured client during onboarding.
		if (!token) {
			throw new Error(
				`Client "${id}" has destination DB ids (or ${MODE_PREFIX}${suffix}) set but no ${TOKEN_PREFIX}${suffix}.`,
			);
		}
		for (const docType of DOC_TYPES) {
			if (!dbIds[docType]) {
				throw new Error(
					`Client "${id}" is missing ${DEST_DB_PREFIXES[docType]}${suffix}. All three destination DB ids (Docs, Status Updates, Deliverables) are required per client.`,
				);
			}
		}

		const mode: ClientMode = rawMode === "" ? "staging" : parseMode(id, rawMode);
		clients.push({
			id,
			token,
			destDbIdsByType: dbIds as Record<DocType, string>,
			mode,
		});
	}

	if (clients.length === 0) {
		throw new Error(
			"No clients configured. Set CLIENT_TOKEN_<ID> + CLIENT_DOCS_DB_<ID> + CLIENT_STATUS_UPDATES_DB_<ID> + CLIENT_DELIVERABLES_DB_<ID> (and optionally CLIENT_MODE_<ID>) for at least one client.",
		);
	}

	clients.sort((a, b) => a.id.localeCompare(b.id));
	return clients;
}

function matchPrefix(name: string): string | undefined {
	for (const prefix of ALL_PREFIXES) {
		if (name.startsWith(prefix)) return name.slice(prefix.length);
	}
	return undefined;
}

function parseMode(id: string, raw: string): ClientMode {
	if (raw === "staging" || raw === "production") return raw;
	throw new Error(
		`Client "${id}" has invalid CLIENT_MODE_<ID> = "${raw}". Expected "staging" or "production".`,
	);
}
