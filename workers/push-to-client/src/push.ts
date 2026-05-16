import type { BlockObjectRequest } from "@notionhq/client/build/src/api-endpoints/common.js";

import { translateNotionError } from "./api-errors.js";
import { findExistingByBrainId } from "./dedup.js";
import { ClientApiError, DestinationSchemaMismatch } from "./errors.js";
import { markdownToBlocks } from "./markdown.js";
import { assertModeAllowsPush } from "./mode-gate.js";
import type { ClientApi } from "./notion-client.js";
import { PreflightCache } from "./preflight.js";
import { buildProperties, type PushPayload } from "./properties.js";

/** Notion `pages.create` accepts at most 100 children. Overflow goes via append. */
const MAX_PAGE_CREATE_CHILDREN = 100;
/** `blocks.children.append` accepts at most 100 per call. */
const MAX_APPEND_CHILDREN = 100;

export type PushInput = {
	clientId: string;
	payload: PushPayload;
	allowProduction?: boolean | null;
};

export type PushResult =
	| {
			status: "created";
			pushedPageId: string;
			pushedPageUrl: string;
			warnings: string[];
	  }
	| {
			status: "already_pushed";
			pushedPageId: string;
			pushedPageUrl: string;
			warnings: string[];
	  };

export type PushDeps = {
	api: ClientApi;
	preflight: PreflightCache;
	now?: () => Date;
};

/**
 * Push a single approved payload to a client's destination workspace.
 *
 * Order of operations is deliberate: the mode gate runs *before* any network
 * I/O so a misconfigured production attempt fails with zero side effects.
 */
export async function pushToClient(
	input: PushInput,
	deps: PushDeps,
): Promise<PushResult> {
	assertModeAllowsPush(deps.api, input.allowProduction ?? undefined);

	const startedAt = (deps.now ?? (() => new Date()))();
	console.log("push-to-client", {
		clientId: deps.api.id,
		mode: deps.api.mode,
		allowProduction: input.allowProduction ?? false,
		brainId: input.payload.brainId,
		source: input.payload.source,
		category: input.payload.category,
		bodyMarkdownLength: input.payload.bodyMarkdown?.length ?? 0,
	});

	const schema = await deps.preflight.get(deps.api);

	// Category must be a declared option on the destination DB.
	if (!schema.categoryOptions.has(input.payload.category)) {
		throw new DestinationSchemaMismatch({
			missing: [],
			wrongType: [],
			unknownCategory: input.payload.category,
			validCategories: [...schema.categoryOptions].sort(),
		});
	}

	// Idempotency: skip create if Brain ID already exists in destination.
	const existing = await findExistingByBrainId(
		deps.api,
		schema.dataSourceId,
		input.payload.brainId,
	);
	if (existing) {
		return {
			status: "already_pushed",
			pushedPageId: existing.pageId,
			pushedPageUrl: existing.pageUrl,
			warnings: [],
		};
	}

	const { blocks, warnings } = markdownToBlocks(input.payload.bodyMarkdown);
	const props = buildProperties(input.payload, schema, startedAt);

	const firstChunk = blocks.slice(0, MAX_PAGE_CREATE_CHILDREN);
	const rest = blocks.slice(MAX_PAGE_CREATE_CHILDREN);

	const created = await createPage(deps.api, schema.dataSourceId, props, firstChunk);

	for (let i = 0; i < rest.length; i += MAX_APPEND_CHILDREN) {
		const batch = rest.slice(i, i + MAX_APPEND_CHILDREN);
		await appendChildren(deps.api, created.pageId, batch);
	}

	return {
		status: "created",
		pushedPageId: created.pageId,
		pushedPageUrl: created.pageUrl,
		warnings,
	};
}

type CreatedPage = { pageId: string; pageUrl: string };

async function createPage(
	api: ClientApi,
	dataSourceId: string,
	properties: ReturnType<typeof buildProperties>,
	children: BlockObjectRequest[],
): Promise<CreatedPage> {
	let response: unknown;
	try {
		await api.waitForPacer();
		response = await api.sdk.pages.create({
			parent: { type: "data_source_id", data_source_id: dataSourceId },
			properties,
			children,
		});
	} catch (err) {
		throw translateNotionError(api.id, err);
	}
	return extractCreatedPage(api.id, response);
}

function extractCreatedPage(clientId: string, response: unknown): CreatedPage {
	if (typeof response !== "object" || response === null) {
		throw new ClientApiError(clientId, 500, "pages.create response was not an object");
	}
	const rec = response as Record<string, unknown>;
	const pageId = typeof rec.id === "string" ? rec.id : "";
	const pageUrl = typeof rec.url === "string" ? rec.url : "";
	if (!pageId) {
		throw new ClientApiError(clientId, 500, "pages.create response missing id");
	}
	return { pageId, pageUrl };
}

async function appendChildren(
	api: ClientApi,
	pageId: string,
	children: BlockObjectRequest[],
): Promise<void> {
	try {
		await api.waitForPacer();
		await api.sdk.blocks.children.append({ block_id: pageId, children });
	} catch (err) {
		throw translateNotionError(api.id, err);
	}
}
