/**
 * Resolves a draft's `Company` relation (a Notion page id in our workspace) to
 * the configured `clientId` of the Client OS destination workspace.
 *
 * Env contract: one `COMPANY_PAGE_<ID>=<companyPageId>` entry per client whose
 * `CLIENT_TOKEN_<ID>` is also configured in `clients.ts`. The dispatcher uses
 * the returned map to pick the right `pushToClient` client when a draft is
 * routed to Client OS.
 *
 * Notion page ids appear in env both with and without dashes; we normalize to
 * lowercase + dashes-stripped at parse and lookup time so either form works.
 */

const PREFIX = "COMPANY_PAGE_";

export type CompanyMapping = {
	/** Lookup a clientId by the company page id (any Notion format). Returns undefined if no mapping. */
	get(companyPageId: string): string | undefined;
	/** All configured (companyPageId, clientId) entries, normalized form. */
	entries(): Array<{ companyPageId: string; clientId: string }>;
};

export function getCompanyMapping(
	env: NodeJS.ProcessEnv = process.env,
): CompanyMapping {
	const map = new Map<string, string>();
	for (const [name, raw] of Object.entries(env)) {
		if (!name.startsWith(PREFIX)) continue;
		const value = (raw ?? "").trim();
		if (!value) continue;
		const suffix = name.slice(PREFIX.length);
		if (suffix.length === 0) continue;
		const clientId = suffix.toLowerCase();
		const key = normalize(value);
		if (!key) continue;
		// First-write-wins; duplicate mappings throw to surface misconfiguration.
		const existing = map.get(key);
		if (existing && existing !== clientId) {
			throw new Error(
				`Company page "${value}" is mapped to two different clients ("${existing}" and "${clientId}"). Each company can only map to one client.`,
			);
		}
		map.set(key, clientId);
	}

	return {
		get(companyPageId) {
			return map.get(normalize(companyPageId));
		},
		entries() {
			return Array.from(map.entries())
				.map(([companyPageId, clientId]) => ({ companyPageId, clientId }))
				.sort((a, b) => a.clientId.localeCompare(b.clientId));
		},
	};
}

/**
 * Normalize a Notion id to lowercase + dashes-stripped so callers can pass any
 * format Notion hands them (dashed uuid, undashed, mixed case).
 */
export function normalize(id: string): string {
	return id.trim().toLowerCase().replace(/-/g, "");
}
