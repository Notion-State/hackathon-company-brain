/**
 * Enumerates configured client destinations from env vars.
 *
 * Per-client trio (all three keyed by the same suffix `<ID>`):
 *   - `CLIENT_TOKEN_<ID>`     — the client's internal-integration token (`ntn_...`).
 *   - `CLIENT_DEST_DB_<ID>`   — the destination "Company Brain Inbox" database id.
 *   - `CLIENT_MODE_<ID>`      — optional, `"staging"` (default) or `"production"`.
 *
 * `<ID>` is uppercase in env-var names; the parsed `id` is its lowercase form.
 *
 * Adding a client is a config change, not a code change — but the worker must
 * be redeployed for the new per-client pacer and SDK client to wire up.
 *
 * Throws if zero clients are configured or any client has partial config
 * (token without dest DB, or vice versa).
 */

export type ClientMode = "staging" | "production";

export type ClientConfig = {
	id: string;
	token: string;
	destDbId: string;
	mode: ClientMode;
};

const TOKEN_PREFIX = "CLIENT_TOKEN_";
const DEST_DB_PREFIX = "CLIENT_DEST_DB_";
const MODE_PREFIX = "CLIENT_MODE_";

export function getClients(
	env: NodeJS.ProcessEnv = process.env,
): ClientConfig[] {
	// Discover the set of client ids by union of suffixes across the three prefixes.
	const idsBySuffix = new Set<string>();
	for (const name of Object.keys(env)) {
		const suffix = matchPrefix(name);
		if (suffix !== undefined) idsBySuffix.add(suffix);
	}

	const clients: ClientConfig[] = [];
	for (const suffix of idsBySuffix) {
		const token = (env[TOKEN_PREFIX + suffix] ?? "").trim();
		const destDbId = (env[DEST_DB_PREFIX + suffix] ?? "").trim();
		const rawMode = (env[MODE_PREFIX + suffix] ?? "").trim().toLowerCase();

		const id = suffix.toLowerCase();
		if (id.length === 0) continue;

		// Partial config is a hard error — silently dropping it would hide a
		// misconfigured client during onboarding.
		if (!token && !destDbId && !rawMode) continue;
		if (!token) {
			throw new Error(
				`Client "${id}" has ${DEST_DB_PREFIX}${suffix} (or ${MODE_PREFIX}${suffix}) set but no ${TOKEN_PREFIX}${suffix}.`,
			);
		}
		if (!destDbId) {
			throw new Error(
				`Client "${id}" has ${TOKEN_PREFIX}${suffix} set but no ${DEST_DB_PREFIX}${suffix}.`,
			);
		}

		const mode: ClientMode = rawMode === "" ? "staging" : parseMode(id, rawMode);
		clients.push({ id, token, destDbId, mode });
	}

	if (clients.length === 0) {
		throw new Error(
			"No clients configured. Set CLIENT_TOKEN_<ID> + CLIENT_DEST_DB_<ID> (and optionally CLIENT_MODE_<ID>) for at least one client.",
		);
	}

	clients.sort((a, b) => a.id.localeCompare(b.id));
	return clients;
}

function matchPrefix(name: string): string | undefined {
	if (name.startsWith(TOKEN_PREFIX)) return name.slice(TOKEN_PREFIX.length);
	if (name.startsWith(DEST_DB_PREFIX)) return name.slice(DEST_DB_PREFIX.length);
	if (name.startsWith(MODE_PREFIX)) return name.slice(MODE_PREFIX.length);
	return undefined;
}

function parseMode(id: string, raw: string): ClientMode {
	if (raw === "staging" || raw === "production") return raw;
	throw new Error(
		`Client "${id}" has invalid CLIENT_MODE_<ID> = "${raw}". Expected "staging" or "production".`,
	);
}
