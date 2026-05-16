import { Client } from "@notionhq/client";
import type { AppendBlockChildrenParameters } from "@notionhq/client/build/src/api-endpoints/blocks.js";
import type { GetDatabaseParameters } from "@notionhq/client/build/src/api-endpoints/databases.js";
import type {
	GetDataSourceParameters,
	QueryDataSourceParameters,
} from "@notionhq/client/build/src/api-endpoints/data-sources.js";
import type { CreatePageParameters } from "@notionhq/client/build/src/api-endpoints/pages.js";

import type { ClientConfig, ClientMode } from "./clients.js";

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
	};
	blocks: {
		children: {
			append: (args: AppendBlockChildrenParameters) => Promise<unknown>;
		};
	};
};

/**
 * Bundles a per-client Notion SDK handle, a pacer, and the resolved client
 * config. Every call site must `await api.waitForPacer()` before invoking
 * `api.sdk.*`.
 */
export type ClientApi = {
	id: string;
	destDbId: string;
	mode: ClientMode;
	waitForPacer: () => Promise<void>;
	sdk: NotionSdkSubset;
};

export type PacerLike = { wait: () => Promise<void> };

export function createClientApi(cfg: ClientConfig, pacer: PacerLike): ClientApi {
	return {
		id: cfg.id,
		destDbId: cfg.destDbId,
		mode: cfg.mode,
		waitForPacer: () => pacer.wait(),
		sdk: new Client({ auth: cfg.token }),
	};
}
