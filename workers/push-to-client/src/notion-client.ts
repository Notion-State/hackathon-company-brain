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
import type { ListUsersParameters } from "@notionhq/client/build/src/api-endpoints/users.js";

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
	};
};

/**
 * Bundles a per-client Notion SDK handle, a pacer, the resolved client config,
 * and a lazy email→user-id index. Every call site must `await api.waitForPacer()`
 * before invoking `api.sdk.*`.
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

export type PacerLike = { wait: () => Promise<void> };

/** Lazy loader for the email→user-id map. Defined here as a type so the factory and tests can both implement it. */
export type UsersByEmailLoader = (api: ClientApi) => Promise<Map<string, string>>;

export function createClientApi(
	cfg: ClientConfig,
	pacer: PacerLike,
	loadUsersByEmail: UsersByEmailLoader,
): ClientApi {
	const sdk: NotionSdkSubset = new Client({ auth: cfg.token });
	const api: ClientApi = {
		id: cfg.id,
		destDbIdsByType: cfg.destDbIdsByType,
		mode: cfg.mode,
		waitForPacer: () => pacer.wait(),
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
