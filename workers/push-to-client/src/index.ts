import { Worker, WebhookVerificationError } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

import {
	createArtifactCategoryResolver,
	type ArtifactCategoryResolver,
} from "./artifact-category.js";
import { getClients } from "./clients.js";
import { getCompanyMapping } from "./company-mapping.js";
import {
	dispatchDraft,
	throwIfPartialFailure,
	type DispatcherDeps,
} from "./dispatcher.js";
import { DOC_TYPE_SPECS, type DocType, type PayloadField } from "./doc-types.js";
import {
	ClientNotConfigured,
	MissingRequiredField,
	PushToClientError,
} from "./errors.js";
import { HOME_CLIENT_ID, resolveHomeApi } from "./home-api.js";
import { createClientApi, type ClientApi } from "./notion-client.js";
import { loadUsersByEmail } from "./people.js";
import { PreflightCache } from "./preflight.js";
import { pushToClient } from "./push.js";
import type { PushPayload } from "./properties.js";

const worker = new Worker();
export default worker;

// ---- Module init: clients → per-client pacers + API handles ----

const clients = getClients();

// Notion's per-integration limit is ~3 r/s. Each client gets its own in-process
// rate limiter (built inside `createClientApi`) so concurrent dispatches to
// different workspaces don't share a budget. We also call `worker.pacer()` per
// client so the deploy manifest lists the pacers — the SDK's pacer state only
// initializes for sync caps in 0.4.0, but declaring keeps the manifest accurate
// and future-proofs us for when tool/webhook caps get pacer support.
const CLIENT_RATE_LIMIT = { allowedRequests: 3, intervalMs: 1000 } as const;

const perClient: Record<string, ClientApi> = Object.fromEntries(
	clients.map((cfg) => {
		worker.pacer(`clientNotion:${cfg.id}`, CLIENT_RATE_LIMIT);
		return [cfg.id, createClientApi(cfg, CLIENT_RATE_LIMIT, loadUsersByEmail)];
	}),
);

const preflight = new PreflightCache();

const KNOWN_CLIENT_IDS = clients.map((c) => c.id);

// ---- Module init: dispatcher deps ----

const ARTIFACT_REGISTRY_DS =
	process.env.DRAFTS_REGISTRY_ARTIFACT_CATEGORIES_DS ?? "";

const companyMapping = getCompanyMapping();

const displayNames: Record<string, string> = Object.fromEntries(
	clients.map((c) => [
		c.id,
		process.env[`CLIENT_DISPLAY_NAME_${c.id.toUpperCase()}`]?.trim() || c.id,
	]),
);
displayNames[HOME_CLIENT_ID] =
	process.env.NS_OS_DISPLAY_NAME?.trim() || "Notion State OS";

// Dispatcher deps are lazy: the home API + artifact-category resolver only
// matter when a dispatch call actually fires. Building them at module init
// would throw `ClientNotConfigured` for installations that haven't onboarded
// the `notionstate` client yet — which would break the older `pushToClient`
// tool that doesn't need them.
let dispatcherDepsCache: DispatcherDeps | null = null;
function getDispatcherDeps(): DispatcherDeps {
	if (dispatcherDepsCache) return dispatcherDepsCache;
	const homeApi = resolveHomeApi(perClient);
	if (!ARTIFACT_REGISTRY_DS) {
		throw new Error(
			"DRAFTS_REGISTRY_ARTIFACT_CATEGORIES_DS is not set. The dispatcher cannot route Artifact Category relations without the registry data source id.",
		);
	}
	const artifactCategory: ArtifactCategoryResolver =
		createArtifactCategoryResolver(homeApi, ARTIFACT_REGISTRY_DS);
	dispatcherDepsCache = {
		homeApi,
		perClient,
		preflight,
		companyMapping,
		artifactCategory,
		displayNames,
	};
	return dispatcherDepsCache;
}

// ---- Tool capability: pushToClient ----

worker.tool("pushToClient", {
	title: "Push to Client Workspace",
	hints: { readOnlyHint: false },
	description: [
		"Push one approved Company Brain item into a client's external Notion workspace. Pick the destination DB by `docType`: Docs / StatusUpdate / Deliverable. Per-docType required fields are documented on each field's `.describe()`.",
		"",
		"Idempotent on `(brainId, docType)`: a duplicate call returns `status=\"already_pushed\"`. Pages are read-only after creation — no update flow.",
		"",
		"Failure modes you must NOT auto-retry; surface to the human:",
		"- MissingRequiredField — payload incomplete for this docType.",
		"- ProductionPushNotAuthorized — client is in production mode; require explicit `allowProduction=true` and human confirmation.",
		"- DestinationSchemaMismatch — destination DB missing properties or has unknown Status/Type values.",
		"Other errors (RateLimited, IntegrationRevoked, ClientApiError) are operational; report them.",
		"",
		"Relations (`Project` on Docs, `Event` on Status Updates) are NOT set — the client links them manually. `presenterEmail` is best-effort resolved via `users.list`; unmatched emails are skipped with a warning.",
	].join("\n"),
	schema: j.object({
		clientId: j
			.string()
			.describe(
				`Lowercase id of the destination client (one of: ${KNOWN_CLIENT_IDS.join(", ")}). Must match a CLIENT_TOKEN_<ID> configured on this worker. Do not guess; ask the human if uncertain.`,
			),
		docType: j
			.enum("Docs", "StatusUpdate", "Deliverable")
			.describe(
				"Which destination database to write to. Picks the database and the canonical Transformation Hub schema we validate against.",
			),
		brainId: j
			.string()
			.describe(
				"Stable id of the source Review Queue item; written to the destination's Brain ID property as the idempotency key. Safe to retry with the same value.",
			),
		title: j
			.string()
			.describe(
				"Page title in the client's workspace. Maps to `File Name` for Docs and to `Title` for Status Updates and Deliverables. The human reviewer is expected to have proofread it.",
			),
		bodyMarkdown: j
			.string()
			.describe(
				"Page body as Markdown. Supported subset: paragraphs, #/##/### headings, -/* bulleted lists, 1. numbered lists, fenced code blocks, > quotes, --- dividers. Other Markdown is dropped with a warning. Total length must be under 50,000 characters.",
			)
			.nullable(),
		// Docs-only fields
		type: j
			.string()
			.describe(
				"Docs only — required when `docType=Docs`. Maps to the `Type` select (e.g. Contract, Brand, Framework, Requirements, Guide, Research, Planning, Analysis). Pre-validated against the destination's Type options.",
			)
			.nullable(),
		// Docs + Deliverable
		status: j
			.string()
			.describe(
				"Required when `docType` is `Docs` or `Deliverable`. Maps to the `Status` status property. Pre-validated against the destination's Status options for that doc type (Docs: Drafting/In Review/Published/Archived; Deliverable: Not Started/Planning/In Progress/In Review/Ongoing/Postponed/Blocked/Done/Propose Delete).",
			)
			.nullable(),
		// Status Update-only
		date: j
			.string()
			.describe(
				"StatusUpdate only — required when `docType=StatusUpdate`. ISO 8601 date of the status update.",
			)
			.nullable(),
		summary: j
			.string()
			.describe(
				"StatusUpdate only — required when `docType=StatusUpdate`. Free-text summary that fills the destination's `Summary` rich_text property.",
			)
			.nullable(),
		presenterEmail: j
			.string()
			.describe(
				"StatusUpdate only — optional. Email of the presenter. Best-effort resolved against the destination workspace's users; if no match, the `Presenter` field is left empty and a warning is returned.",
			)
			.nullable(),
		addressed: j
			.boolean()
			.describe(
				"StatusUpdate only — optional. Sets the `Addressed` checkbox on the destination row. Pass null/omit to leave it untouched.",
			)
			.nullable(),
		// Deliverable-only
		timelineStart: j
			.string()
			.describe(
				"Deliverable only — required when `docType=Deliverable`. ISO 8601 start of the deliverable's timeline.",
			)
			.nullable(),
		timelineEnd: j
			.string()
			.describe(
				"Deliverable only — optional. ISO 8601 end of the deliverable's timeline; pair with timelineStart to write a date range. Pass null/omit for a single-day timeline.",
			)
			.nullable(),
		allowProduction: j
			.boolean()
			.describe(
				"Required true only when the client is configured in production mode; staging clients ignore this flag. Set only after explicit human confirmation that this push is going to the production workspace.",
			)
			.nullable(),
	}),
	outputSchema: j.object({
		status: j.enum("created", "already_pushed"),
		pushedPageId: j.string(),
		pushedPageUrl: j.string(),
		warnings: j.array(j.string()),
	}),
	execute: async (input) => {
		const api = perClient[input.clientId];
		if (!api) throw new ClientNotConfigured(input.clientId);

		const docType = input.docType;
		try {
			const payload = assemblePayload(docType, input);
			return await pushToClient(
				{
					clientId: input.clientId,
					payload,
					allowProduction: input.allowProduction ?? undefined,
				},
				{ api, preflight },
			);
		} catch (err) {
			if (err instanceof PushToClientError) {
				const e = new Error(err.message);
				e.name = err.name;
				Object.assign(e, err.toJSON());
				throw e;
			}
			throw err;
		}
	},
});

// ---- Tool capability: dispatchDraft ----

worker.tool("dispatchDraft", {
	title: "Dispatch AI Draft",
	hints: { readOnlyHint: false },
	description: [
		"Read an AI Drafts row, route it by Status, write back Status + Location.",
		"",
		"Routing:",
		"- `Send to Both` → Client OS + Notion State OS → `In Both`.",
		"- `Send to Client OS` → Client OS only → `In Client Workspace`.",
		"- `Send to Notion State OS` → Notion State OS only → `In Notion State OS`.",
		"Already-complete drafts (`In Both` / `In Client Workspace` / `In Notion State OS` / `Archive`) are an idempotent no-op.",
		"",
		"Reads `Artifact Category` → `docType` (Feature Requests rejected) and, for Client OS routes, `Company` → COMPANY_PAGE_<ID>. Per-docType required fields not on the draft get sensible defaults (Type=Guide, Status=Drafting, Date=today, etc.) the destination consultant edits.",
		"",
		"Failure modes: UnpushableArtifactCategory (Feature Requests); MissingClientForCompany / MissingDraftRelation (fix the draft or env); DraftDispatchFailure (one side failed — Status stays in originating Send to …; Brain ID dedup makes retry safe).",
	].join("\n"),
	schema: j.object({
		draftPageId: j
			.string()
			.describe(
				"Notion page id of the AI Drafts row to dispatch. The page's current Status drives routing.",
			),
		allowProduction: j
			.boolean()
			.describe(
				"Required true only when the resolved client is in production mode; staging clients (and notionstate) ignore this flag.",
			)
			.nullable(),
	}),
	outputSchema: j.object({
		status: j.enum("dispatched", "no_op", "partial_failure"),
		resultingStatus: j.string(),
		location: j.string(),
		pushed: j.array(
			j.object({
				side: j.enum("ClientOS", "NSOS"),
				pushedPageId: j.string(),
				pushedPageUrl: j.string(),
				warnings: j.array(j.string()),
			}),
		),
		failures: j.array(
			j.object({
				side: j.enum("ClientOS", "NSOS"),
				code: j.string(),
				message: j.string(),
			}),
		),
	}),
	execute: async (input) => {
		try {
			const deps = getDispatcherDeps();
			const result = await dispatchDraft(
				{
					draftPageId: input.draftPageId,
					allowProduction: input.allowProduction ?? undefined,
				},
				deps,
			);
			// The tool boundary throws DraftDispatchFailure on partial failure so
			// the caller sees the structured details; success/no-op return verbatim.
			return throwIfPartialFailure(result);
		} catch (err) {
			if (err instanceof PushToClientError) {
				const e = new Error(err.message);
				e.name = err.name;
				Object.assign(e, err.toJSON());
				throw e;
			}
			throw err;
		}
	},
});

// ---- Webhook capability: onDraftStatusChange ----

worker.webhook("onDraftStatusChange", {
	title: "AI Drafts: Status change",
	description:
		"Receives database-automation webhook posts from Notion when an AI Drafts row's Status changes to one of the trigger values. Calls dispatchDraft for each event.",
	execute: async (events) => {
		for (const event of events) {
			const pageId = extractPageIdFromWebhook(event.body);

			try {
				const deps = getDispatcherDeps();
				const result = await dispatchDraft({ draftPageId: pageId }, deps);
				console.log("onDraftStatusChange", {
					pageId,
					status: result.status,
					resultingStatus: result.resultingStatus,
					pushed: result.pushed.length,
					failures: result.failures.length,
				});
			} catch (err) {
				// Log + swallow so a misconfigured single draft doesn't trip the
				// platform's invalid-payload counter (those are for malformed input,
				// not in-flight dispatch errors).
				const code = err instanceof PushToClientError ? err.code : "UNKNOWN";
				const message = err instanceof Error ? err.message : String(err);
				console.warn("onDraftStatusChange: dispatch error", { pageId, code, message });
			}
		}
	},
});

// ---- Helpers ----

type ToolInputFields = {
	brainId: string;
	title: string;
	bodyMarkdown?: string | null;
	type?: string | null;
	status?: string | null;
	date?: string | null;
	summary?: string | null;
	presenterEmail?: string | null;
	addressed?: boolean | null;
	timelineStart?: string | null;
	timelineEnd?: string | null;
};

function assemblePayload(docType: DocType, input: ToolInputFields): PushPayload {
	const spec = DOC_TYPE_SPECS[docType];
	for (const field of spec.requiredPayloadFields) {
		if (isMissing(input, field)) {
			throw new MissingRequiredField(docType, field);
		}
	}

	switch (docType) {
		case "Docs":
			return {
				docType: "Docs",
				brainId: input.brainId,
				title: input.title,
				type: input.type ?? "",
				status: input.status ?? "",
				bodyMarkdown: input.bodyMarkdown ?? null,
			};
		case "StatusUpdate":
			return {
				docType: "StatusUpdate",
				brainId: input.brainId,
				title: input.title,
				date: input.date ?? "",
				summary: input.summary ?? "",
				presenterEmail: input.presenterEmail ?? null,
				addressed: input.addressed ?? null,
				bodyMarkdown: input.bodyMarkdown ?? null,
			};
		case "Deliverable":
			return {
				docType: "Deliverable",
				brainId: input.brainId,
				title: input.title,
				status: input.status ?? "",
				timelineStart: input.timelineStart ?? "",
				timelineEnd: input.timelineEnd ?? null,
				bodyMarkdown: input.bodyMarkdown ?? null,
			};
	}
}

function isMissing(input: ToolInputFields, field: PayloadField): boolean {
	const value = input[field];
	if (value == null) return true;
	if (typeof value === "string" && value.trim().length === 0) return true;
	return false;
}

/**
 * Accepts any of `{ pageId }`, `{ page_id }`, or `{ data: { id } }` (the
 * common shapes Notion DB automations post). Throws
 * `WebhookVerificationError` otherwise so the platform's 5-in-a-row
 * invalid-payload counter trips for genuinely malformed input.
 */
function extractPageIdFromWebhook(body: unknown): string {
	if (typeof body === "object" && body !== null) {
		const rec = body as Record<string, unknown>;
		if (typeof rec.pageId === "string" && rec.pageId.length > 0) return rec.pageId;
		if (typeof rec.page_id === "string" && rec.page_id.length > 0) return rec.page_id;
		if (typeof rec.id === "string" && rec.id.length > 0) return rec.id;
		const data = rec.data;
		if (typeof data === "object" && data !== null) {
			const dataRec = data as Record<string, unknown>;
			if (typeof dataRec.id === "string" && dataRec.id.length > 0) return dataRec.id;
			if (typeof dataRec.pageId === "string" && dataRec.pageId.length > 0) return dataRec.pageId;
		}
	}
	throw new WebhookVerificationError(
		"onDraftStatusChange: webhook payload missing pageId. Expected `{ pageId }`, `{ page_id }`, or `{ data: { id } }`.",
	);
}

// Re-export the reserved client id so README + ops have a single source.
export { HOME_CLIENT_ID };
