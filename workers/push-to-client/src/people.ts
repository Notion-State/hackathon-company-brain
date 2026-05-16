import { translateNotionError } from "./api-errors.js";
import type { ClientApi } from "./notion-client.js";

/**
 * Email → Notion user id lookup for the per-client destination workspace.
 *
 * The map is loaded once per `ClientApi` lifetime via `loadUsersByEmail`
 * (wired into the api at construction time in `index.ts`). On lookup we
 * normalize the email and return the cached id, or `null` if unresolved.
 *
 * Unresolved → returns `null`. The caller emits a `warnings[]` entry and skips
 * the property; the push still succeeds.
 */

export async function resolveUserByEmail(
	api: ClientApi,
	email: string,
): Promise<string | null> {
	const key = email.trim().toLowerCase();
	if (!key) return null;
	const map = await api.usersByEmail.get();
	return map.get(key) ?? null;
}

/**
 * Paginated `users.list` loader that indexes person-typed users by lowercased
 * email. Bots and groups are filtered out; people without published emails are
 * skipped. Wired into the `ClientApi`'s `usersByEmail` lazy cache by `index.ts`.
 */
export async function loadUsersByEmail(
	api: ClientApi,
): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	let cursor: string | undefined = undefined;
	try {
		for (;;) {
			await api.waitForPacer();
			const response: unknown = await api.sdk.users.list({
				page_size: 100,
				start_cursor: cursor,
			});
			indexResults(response, map);
			const next = extractNextCursor(response);
			if (!next) break;
			cursor = next;
		}
	} catch (err) {
		throw translateNotionError(api.id, err);
	}
	return map;
}

function indexResults(response: unknown, into: Map<string, string>): void {
	if (!isObject(response) || !Array.isArray(response.results)) return;
	for (const raw of response.results) {
		if (!isObject(raw)) continue;
		if (typeof raw.id !== "string") continue;
		if (raw.type !== "person") continue; // skip bots, groups
		const person = isObject(raw.person) ? raw.person : null;
		const email = person && typeof person.email === "string" ? person.email.trim().toLowerCase() : "";
		if (!email) continue;
		if (!into.has(email)) into.set(email, raw.id);
	}
}

function extractNextCursor(response: unknown): string | undefined {
	if (!isObject(response)) return undefined;
	if (response.has_more !== true) return undefined;
	return typeof response.next_cursor === "string" ? response.next_cursor : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}
