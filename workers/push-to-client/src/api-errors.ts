import { APIErrorCode, APIResponseError } from "@notionhq/client";

import {
	ClientApiError,
	IntegrationRevoked,
	PushToClientError,
	RateLimited,
} from "./errors.js";

/**
 * Translates a Notion SDK error into one of our typed `PushToClientError`s.
 *
 * If the error is already a `PushToClientError` (e.g., re-thrown from another
 * stage), it passes through. Unknown errors are returned unchanged so they
 * surface as themselves rather than being silently wrapped.
 */
export function translateNotionError(clientId: string, err: unknown): unknown {
	if (err instanceof PushToClientError) return err;
	if (err instanceof APIResponseError) {
		if (
			err.code === APIErrorCode.Unauthorized ||
			err.code === APIErrorCode.RestrictedResource
		) {
			return new IntegrationRevoked(clientId);
		}
		if (err.code === APIErrorCode.RateLimited) {
			return new RateLimited(clientId, parseRetryAfterMs(err.headers));
		}
		return new ClientApiError(clientId, err.status, err.message);
	}
	return err;
}

/**
 * Pulls a millisecond delay from a `Retry-After` header. `headers` is typed as
 * `unknown` on `APIResponseError`; we narrow it with a single guard rather
 * than a double-cast.
 */
function parseRetryAfterMs(headers: unknown): number | undefined {
	if (typeof headers !== "object" || headers === null) return undefined;
	const rec = headers as Record<string, unknown>;
	const raw = rec["retry-after"] ?? rec["Retry-After"];
	if (typeof raw !== "string") return undefined;
	const seconds = Number.parseFloat(raw);
	if (!Number.isFinite(seconds)) return undefined;
	return Math.round(seconds * 1000);
}
