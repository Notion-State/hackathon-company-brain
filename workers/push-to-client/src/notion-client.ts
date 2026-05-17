import { Client } from "@notionhq/client";
import type {
	AppendBlockChildrenParameters,
	ListBlockChildrenParameters,
} from "@notionhq/client/build/src/api-endpoints/blocks.js";
import type { GetDatabaseParameters } from "@notionhq/client/build/src/api-endpoints/databases.js";
import type {
	GetDataSourceParameters,
	QueryDataSourceParameters,
} from "@notionhq/client/build/src/api-endpoints/data-sources.js";
import type {
	CreatePageParameters,
	GetPageParameters,
	UpdatePageParameters,
} from "@notionhq/client/build/src/api-endpoints/pages.js";
import type {
	GetUserParameters,
	ListUsersParameters,
} from "@notionhq/client/build/src/api-endpoints/users.js";

import type { ClientConfig, ClientMode } from "./clients.js";
import type { DocType } from "./doc-types.js";

/**
 * Narrow subset of `@notionhq/client`'s `Client` covering only the endpoints
 * this worker calls. Implementation modules and tests both program against this
 * interface — the real `Client` satisfies it structurally; mocks satisfy it
 * directly without `as unknown as` escape hatches.
 *
 * Return types are intentionally `Promise<unknown>`: every consumer narrows the
 * response via a hand-written type guard anyway, and keeping the return loose
 * lets test mocks pass partial fixtures without partial-cast contortions.
 */
export type NotionSdkSubset = {
	databases: {
		retrieve: (args: GetDatabaseParameters) => Promise<unknown>;
	};
	dataSources: {
		retrieve: (args: GetDataSourceParameters) => Promise<unknown>;
		query: (args: QueryDataSourceParameters) => Promise<unknown>;
	};
	pages: {
		create: (args: CreatePageParameters) => Promise<unknown>;
		retrieve: (args: GetPageParameters) => Promise<unknown>;
		update: (args: UpdatePageParameters) => Promise<unknown>;
	};
	blocks: {
		children: {
			append: (args: AppendBlockChildrenParameters) => Promise<unknown>;
			list: (args: ListBlockChildrenParameters) => Promise<unknown>;
		};
	};
	users: {
		list: (args: ListUsersParameters) => Promise<unknown>;
		retrieve: (args: GetUserParameters) => Promise<unknown>;
	};
};

/**
 * Bundles a per-client Notion SDK handle, an in-process rate limiter, the
 * resolved client config, and a lazy email→user-id index. Every call site must
 * `await api.waitForPacer()` before invoking `api.sdk.*`.
 */
export type ClientApi = {
	id: string;
	destDbIdsByType: Record<DocType, string>;
	mode: ClientMode;
	waitForPacer: () => Promise<void>;
	sdk: NotionSdkSubset;
	/** Lazy email→Notion user id map, populated on first read by `people.ts`. */
	usersByEmail: { get: () => Promise<Map<string, string>>; reset: () => void };
};

export type RateLimitConfig = { allowedRequests: number; intervalMs: number };

/** Lazy loader for the email→user-id map. Defined here as a type so the factory and tests can both implement it. */
export type UsersByEmailLoader = (api: ClientApi) => Promise<Map<string, string>>;

/**
 * Single-instance rate limiter that paces calls at `allowedRequests` per
 * `intervalMs`. The algorithm mirrors the SDK's `pacer_internal.pacerWait` —
 * we re-implement it locally because in `@notionhq/workers` 0.4.0 the SDK
 * only initializes pacer state for sync capabilities, so calling
 * `worker.pacer().wait()` from a tool or webhook handler throws
 * `Pacer "<key>" not found`. The corresponding `worker.pacer(...)`
 * declarations are kept in `index.ts` for manifest fidelity (future SDK
 * versions that wire pacers into tool/webhook caps will pick them up
 * automatically).
 *
 * Per-client instance: concurrent dispatches to the same client share one
 * limiter, so a single Notion integration token can never exceed its 3 r/s
 * cap regardless of fan-out.
 */
/** Scheduler seam: production uses setTimeout; tests inject a fake. */
export type Scheduler = (delayMs: number) => Promise<void>;

const realSchedule: Scheduler = (delayMs) =>
	new Promise((resolve) => setTimeout(resolve, delayMs));

export class RateLimiter {
	private lastScheduledAtMs = 0;
	private readonly paceMs: number;
	private readonly now: () => number;
	private readonly schedule: Scheduler;

	constructor(
		config: RateLimitConfig,
		opts: { now?: () => number; schedule?: Scheduler } = {},
	) {
		const { allowedRequests, intervalMs } = config;
		if (!Number.isFinite(allowedRequests) || allowedRequests <= 0) {
			throw new Error(`RateLimiter allowedRequests must be > 0 (got ${allowedRequests}).`);
		}
		if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
			throw new Error(`RateLimiter intervalMs must be > 0 (got ${intervalMs}).`);
		}
		this.paceMs = Math.ceil(intervalMs / allowedRequests);
		this.now = opts.now ?? (() => Date.now());
		this.schedule = opts.schedule ?? realSchedule;
	}

	async wait(): Promise<void> {
		const t = this.now();
		const scheduledAtMs = Math.max(this.lastScheduledAtMs + this.paceMs, t);
		this.lastScheduledAtMs = scheduledAtMs;
		const delayMs = scheduledAtMs - t;
		if (delayMs > 0) {
			await this.schedule(delayMs);
		}
	}
}

export function createClientApi(
	cfg: ClientConfig,
	rateLimit: RateLimitConfig,
	loadUsersByEmail: UsersByEmailLoader,
): ClientApi {
	const sdk: NotionSdkSubset = new Client({ auth: cfg.token });
	const limiter = new RateLimiter(rateLimit);
	const api: ClientApi = {
		id: cfg.id,
		destDbIdsByType: cfg.destDbIdsByType,
		mode: cfg.mode,
		waitForPacer: () => limiter.wait(),
		sdk,
		usersByEmail: lazyMap(() => loadUsersByEmail(api)),
	};
	return api;
}

/**
 * Single-flight lazy cache for an async-loaded `Map<string, string>`. Used for
 * the email→user-id resolver; exported so tests can build their own.
 */
export function lazyMap(
	load: () => Promise<Map<string, string>>,
): ClientApi["usersByEmail"] {
	let cached: Promise<Map<string, string>> | null = null;
	return {
		get: () => {
			if (!cached) cached = load();
			return cached;
		},
		reset: () => {
			cached = null;
		},
	};
}
