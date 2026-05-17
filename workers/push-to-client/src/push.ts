import type { BlockObjectRequest } from "@notionhq/client/build/src/api-endpoints/common.js";

import { translateNotionError } from "./api-errors.js";
import { findExistingByBrainId } from "./dedup.js";
import { ClientApiError, DestinationSchemaMismatch } from "./errors.js";
import { markdownToBlocks } from "./markdown.js";
import { assertModeAllowsPush } from "./mode-gate.js";
import type { ClientApi } from "./notion-client.js";
import { resolveUserByEmail } from "./people.js";
import { PreflightCache, type DestSchema } from "./preflight.js";
import { buildPropertiesFor, type PushPayload } from "./properties.js";

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
 * Push a single approved payload into the destination database for its
 * `docType` in the client's workspace.
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
		docType: input.payload.docType,
		brainId: input.payload.brainId,
		bodyMarkdownLength: input.payload.bodyMarkdown?.length ?? 0,
	});

	const schema = await deps.preflight.get(deps.api, input.payload.docType);

	validateOptions(input.payload, schema);

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

	const warnings: string[] = [];

	// Presenter resolution (StatusUpdate only).
	let presenterUserId: string | undefined;
	if (input.payload.docType === "StatusUpdate" && input.payload.presenterEmail) {
		if (!schema.optionalPropertiesPresent.Presenter) {
			warnings.push(
				`Presenter email "${input.payload.presenterEmail}" provided but destination DB has no Presenter property; field skipped.`,
			);
		} else {
			const userId = await resolveUserByEmail(deps.api, input.payload.presenterEmail);
			if (userId) {
				presenterUserId = userId;
			} else {
				warnings.push(
					`Presenter email "${input.payload.presenterEmail}" did not match any user in the destination workspace; field left empty. Add the user to the workspace and re-push to populate.`,
				);
			}
		}
	}

	// Owner resolution (Deliverable only). Schema-required, data best-effort:
	// the property key is always emitted (`Owner: []` when unresolved). Missing
	// destination column is impossible — preflight would have thrown.
	let ownerUserId: string | undefined;
	if (input.payload.docType === "Deliverable") {
		const ownerEmail = input.payload.ownerEmail ?? "";
		if (!ownerEmail) {
			warnings.push(
				"Deliverable push has no owner email; Owner left blank. Set the draft's DRI (or pass `ownerEmail`) and re-push to populate.",
			);
		} else {
			const userId = await resolveUserByEmail(deps.api, ownerEmail);
			if (userId) {
				ownerUserId = userId;
			} else {
				warnings.push(
					`Owner email "${ownerEmail}" did not match any user in the destination workspace; field left empty. Add the user to the workspace and re-push to populate.`,
				);
			}
		}
	}

	const { blocks, warnings: mdWarnings } = markdownToBlocks(
		input.payload.bodyMarkdown,
	);
	for (const w of mdWarnings) warnings.push(w);

	const props = buildPropertiesFor(input.payload, schema, presenterUserId, ownerUserId);

	const firstChunk = blocks.slice(0, MAX_PAGE_CREATE_CHILDREN);
	const rest = blocks.slice(MAX_PAGE_CREATE_CHILDREN);

	const created = await createPage(deps.api, schema.dataSourceId, props, firstChunk);

	for (let i = 0; i < rest.length; i += MAX_APPEND_CHILDREN) {
		const batch = rest.slice(i, i + MAX_APPEND_CHILDREN);
		await appendChildren(deps.api, created.pageId, batch);
	}

	// `startedAt` is part of the audit log; not currently a property so just
	// reference it to keep the timestamp consistent with the log line.
	void startedAt;

	return {
		status: "created",
		pushedPageId: created.pageId,
		pushedPageUrl: created.pageUrl,
		warnings,
	};
}

/**
 * Validates option-bearing properties (`Status` everywhere, `Type` on Docs)
 * against the destination's declared options. Throws a structured
 * `DestinationSchemaMismatch` before any write happens.
 */
function validateOptions(payload: PushPayload, schema: DestSchema): void {
	switch (payload.docType) {
		case "Docs": {
			if (!schema.statusOptions.has(payload.status)) {
				throw new DestinationSchemaMismatch({
					missing: [],
					wrongType: [],
					unknownStatus: payload.status,
					validStatuses: [...schema.statusOptions].sort(),
				});
			}
			if (!schema.typeOptions.has(payload.type)) {
				throw new DestinationSchemaMismatch({
					missing: [],
					wrongType: [],
					unknownType: payload.type,
					validTypes: [...schema.typeOptions].sort(),
				});
			}
			return;
		}
		case "Deliverable": {
			if (!schema.statusOptions.has(payload.status)) {
				throw new DestinationSchemaMismatch({
					missing: [],
					wrongType: [],
					unknownStatus: payload.status,
					validStatuses: [...schema.statusOptions].sort(),
				});
			}
			return;
		}
		case "StatusUpdate":
			// No option-validated properties on Status Updates.
			return;
	}
}

type CreatedPage = { pageId: string; pageUrl: string };

async function createPage(
	api: ClientApi,
	dataSourceId: string,
	properties: ReturnType<typeof buildPropertiesFor>,
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
