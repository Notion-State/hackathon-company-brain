import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

import { getClients } from "./clients.js";
import { DOC_TYPE_SPECS, type DocType, type PayloadField } from "./doc-types.js";
import {
	ClientNotConfigured,
	MissingRequiredField,
	PushToClientError,
} from "./errors.js";
import { createClientApi, type ClientApi } from "./notion-client.js";
import { loadUsersByEmail } from "./people.js";
import { PreflightCache } from "./preflight.js";
import { pushToClient } from "./push.js";
import type { PushPayload } from "./properties.js";

const worker = new Worker();
export default worker;

// ---- Module init: clients → per-client pacers + API handles ----

const clients = getClients();

const perClient: Record<string, ClientApi> = Object.fromEntries(
	clients.map((cfg) => [
		cfg.id,
		// Notion's per-integration limit is ~3 r/s; one pacer per client so
		// concurrent pushes to different workspaces do not share a budget.
		createClientApi(
			cfg,
			worker.pacer(`clientNotion:${cfg.id}`, {
				allowedRequests: 3,
				intervalMs: 1000,
			}),
			loadUsersByEmail,
		),
	]),
);

const preflight = new PreflightCache();

const KNOWN_CLIENT_IDS = clients.map((c) => c.id);

// ---- Tool capability: pushToClient ----

worker.tool("pushToClient", {
	title: "Push to Client Workspace",
	hints: { readOnlyHint: false },
	description: [
		"Push a single approved item from the Company Brain into the matching destination database in a client's external Notion workspace.",
		"",
		"Pick the destination by `docType`:",
		"  - `Docs`         → the client's Docs DB. Requires `title`, `type`, `status`.",
		"  - `StatusUpdate` → the client's Status Updates DB. Requires `title`, `date`, `summary`. Optional: `presenterEmail`, `addressed`.",
		"  - `Deliverable`  → the client's Deliverables DB. Requires `title`, `status`, `timelineStart`. Optional: `timelineEnd` for a date range.",
		"",
		"Call this exactly once per approved item after a human has approved it. The push is idempotent on `brainId`: a second call with the same `brainId` for the same `docType` returns `status=\"already_pushed\"` without creating a duplicate.",
		"",
		"Pages are read-only from this worker's perspective after creation — there is no update flow.",
		"",
		"Failure modes you must not auto-retry:",
		"1) MissingRequiredField — surface to the human; payload was incomplete for the chosen docType.",
		"2) ProductionPushNotAuthorized — surface to the human; require explicit confirmation before retrying with allowProduction=true.",
		"3) DestinationSchemaMismatch — surface details to the human so the client can fix their destination database (and/or canonical Status/Type options).",
		"Other errors (RateLimited, IntegrationRevoked, ClientApiError) are operational; report them.",
		"",
		"Relations (`Project` on Docs, `Event` on Status Updates) are not set by this tool — they require destination-side page ids the agent doesn't have. The client fills them in manually.",
		"",
		"`presenterEmail` is best-effort: we resolve the email against the destination workspace's users via `users.list`. If no match, the push still succeeds and a warning is included in the result.",
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

/**
 * Validates per-docType required fields and shapes the flat tool input into a
 * discriminated `PushPayload`. Throws `MissingRequiredField` (a typed
 * `PushToClientError`) on missing values — the tool boundary translates that
 * into a structured error response.
 */
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
