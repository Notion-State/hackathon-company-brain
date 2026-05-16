/**
 * Enumerates configured client source workspaces from env vars.
 *
 * Per-client pair (both keyed by the same suffix `<ID>`):
 *   - `CLIENT_NOTION_TOKEN_<ID>`  — internal-integration token (`ntn_...` or `secret_...`).
 *   - `CLIENT_NOTION_DB_ID_<ID>`  — id of the client's Feature Requests database (the
 *                                  uuid visible in the database URL).
 *
 * `<ID>` is uppercase in env-var names; the parsed `id` is its lowercase form.
 *
 * Adding a client is a config change — but the worker must be redeployed so the
 * per-client pacer and the `Client` schema option are wired up.
 *
 * Throws if zero clients are configured, or if any client has partial config
 * (one half of the pair without the other).
 */

export type ClientConfig = {
	id: string;
	token: string;
	sourceDbId: string;
};

const TOKEN_PREFIX = "CLIENT_NOTION_TOKEN_";
const DB_ID_PREFIX = "CLIENT_NOTION_DB_ID_";

export function getClientNotionConfigs(
	env: NodeJS.ProcessEnv = process.env,
): ClientConfig[] {
	// Union the suffixes seen across both prefixes so we notice partial pairs.
	const idsBySuffix = new Set<string>();
	for (const name of Object.keys(env)) {
		const suffix = matchPrefix(name);
		if (suffix !== undefined) idsBySuffix.add(suffix);
	}

	const clients: ClientConfig[] = [];
	for (const suffix of idsBySuffix) {
		const token = (env[TOKEN_PREFIX + suffix] ?? "").trim();
		const sourceDbId = (env[DB_ID_PREFIX + suffix] ?? "").trim();

		const id = suffix.toLowerCase();
		if (id.length === 0) continue;

		// Both empty: a stray prefix-shaped env var, skip silently.
		if (!token && !sourceDbId) continue;

		// Partial config is a hard error — silently dropping it would hide a
		// misconfigured client during onboarding.
		if (!token) {
			throw new Error(
				`Client "${id}" has ${DB_ID_PREFIX}${suffix} set but no ${TOKEN_PREFIX}${suffix}.`,
			);
		}
		if (!sourceDbId) {
			throw new Error(
				`Client "${id}" has ${TOKEN_PREFIX}${suffix} set but no ${DB_ID_PREFIX}${suffix}.`,
			);
		}

		clients.push({ id, token, sourceDbId });
	}

	if (clients.length === 0) {
		throw new Error(
			"No clients configured. Set CLIENT_NOTION_TOKEN_<ID> + CLIENT_NOTION_DB_ID_<ID> for at least one client.",
		);
	}

	// Deterministic order so module-init pacer/schema declarations are stable.
	clients.sort((a, b) => a.id.localeCompare(b.id));
	return clients;
}

function matchPrefix(name: string): string | undefined {
	if (name.startsWith(TOKEN_PREFIX)) return name.slice(TOKEN_PREFIX.length);
	if (name.startsWith(DB_ID_PREFIX)) return name.slice(DB_ID_PREFIX.length);
	return undefined;
}
