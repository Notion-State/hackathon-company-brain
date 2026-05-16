/**
 * Enumerates Fireflies accounts from env vars.
 *
 * v1: a single `FIREFLIES_API_KEY` env var → `{ id: "default" }`.
 * v2+: add `FIREFLIES_API_KEY_<ID>` env vars to ingest from additional accounts.
 *      ID is the suffix lowercased (e.g., `FIREFLIES_API_KEY_ACME` → `id: "acme"`).
 *
 * Adding accounts is a config change — no code edit required, but a redeploy is
 * needed so the per-account pacer and the `Account` schema option are wired up.
 */

export type Account = {
	id: string;
	apiKey: string;
};

const DEFAULT_ACCOUNT_ID = "default";
const NAMED_KEY_PREFIX = "FIREFLIES_API_KEY_";

export function getFirefliesAccounts(
	env: NodeJS.ProcessEnv = process.env,
): Account[] {
	const accounts: Account[] = [];

	const defaultKey = env.FIREFLIES_API_KEY;
	if (defaultKey && defaultKey.length > 0) {
		accounts.push({ id: DEFAULT_ACCOUNT_ID, apiKey: defaultKey });
	}

	for (const [name, value] of Object.entries(env)) {
		if (!name.startsWith(NAMED_KEY_PREFIX)) continue;
		if (!value || value.length === 0) continue;
		const id = name.slice(NAMED_KEY_PREFIX.length).toLowerCase();
		if (id.length === 0) continue;
		if (id === DEFAULT_ACCOUNT_ID) continue; // avoid collision with FIREFLIES_API_KEY
		accounts.push({ id, apiKey: value });
	}

	if (accounts.length === 0) {
		throw new Error(
			"No Fireflies accounts configured. Set FIREFLIES_API_KEY (and optionally FIREFLIES_API_KEY_<ID> for additional accounts).",
		);
	}

	// Deterministic order so module-init pacer/schema declarations are stable.
	accounts.sort((a, b) => a.id.localeCompare(b.id));
	return accounts;
}
