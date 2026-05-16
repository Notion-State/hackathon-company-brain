/**
 * Helpers for the `INTERNAL_DOMAINS` env contract. Drives Internal/External
 * classification and the NS Talk % calculation.
 *
 * Env value is a comma-separated list of bare hostnames (e.g.,
 * `INTERNAL_DOMAINS=notionstate.com,acme.com`). Empty / unset → no domain
 * is internal (everything classifies as External).
 */

export function parseInternalDomains(raw: string | undefined): Set<string> {
	if (!raw) return new Set();
	return new Set(
		raw
			.split(",")
			.map((d) => d.trim().toLowerCase())
			.filter((d) => d.length > 0),
	);
}

export function extractDomain(email: string | null | undefined): string | null {
	if (!email) return null;
	const at = email.lastIndexOf("@");
	if (at < 0 || at === email.length - 1) return null;
	return email.slice(at + 1).trim().toLowerCase() || null;
}

export function isInternal(email: string | null | undefined, internalDomains: Set<string>): boolean {
	const domain = extractDomain(email);
	if (!domain) return false;
	return internalDomains.has(domain);
}
