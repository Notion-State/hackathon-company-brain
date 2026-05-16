import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

import { getClients } from "./clients.js";
import { ClientNotConfigured, PushToClientError } from "./errors.js";
import { createClientApi, type ClientApi } from "./notion-client.js";
import { PreflightCache } from "./preflight.js";
import { pushToClient } from "./push.js";

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
		"Push a single approved, categorized \"Company Brain\" item into a client's external Notion workspace as a new page in their \"Company Brain Inbox\" database.",
		"",
		"Call this exactly once per approved item after a human has approved it. The push is idempotent on payload.brainId: a second call with the same brainId returns status=\"already_pushed\" without creating a duplicate.",
		"",
		"Pages are read-only from this worker's perspective after creation — there is no update flow.",
		"",
		"Two failure modes you must not auto-retry:",
		"1) ProductionPushNotAuthorized — surface to the human; require explicit confirmation before retrying with allowProduction=true.",
		"2) DestinationSchemaMismatch — surface the details to the human so the client can fix their destination database.",
		"Other errors (RateLimited, IntegrationRevoked, ClientApiError) are operational; report them.",
	].join("\n"),
	schema: j.object({
		clientId: j
			.string()
			.describe(
				`Lowercase id of the destination client (one of: ${KNOWN_CLIENT_IDS.join(", ")}). Must match a CLIENT_TOKEN_<ID> configured on this worker. Do not guess; ask the human if uncertain.`,
			),
		payload: j
			.object({
				brainId: j
					.string()
					.describe(
						"Stable id of the source Review Queue item; written to the destination's Brain ID property as the idempotency key. Safe to retry with the same value.",
					),
				title: j
					.string()
					.describe(
						"Page title in the client's workspace. The human reviewer is expected to have proofread it; do not edit it without permission.",
					),
				source: j
					.enum("Fireflies", "Slack", "Loom", "Other")
					.describe(
						"Origin system. Drives the Source select option in the destination DB.",
					),
				category: j
					.string()
					.describe(
						"Category name from the categorizer taxonomy. Pre-validated against the destination DB's Category select options; unknown categories throw DestinationSchemaMismatch before any write.",
					),
				originalDate: j
					.string()
					.describe(
						"ISO 8601 datetime of the source event (meeting date, message date). Pass null when unknown.",
					)
					.nullable(),
				originUrl: j
					.string()
					.describe(
						"Permalink back to the origin (Fireflies meeting URL, Slack permalink, Loom video URL). Pass null when unknown.",
					)
					.nullable(),
				bodyMarkdown: j
					.string()
					.describe(
						"Page body as Markdown. Supported subset: paragraphs, #/##/### headings, -/* bulleted lists, 1. numbered lists, fenced code blocks, > quotes, --- dividers. Other Markdown is dropped with a warning. Total length must be under 50,000 characters.",
					)
					.nullable(),
			})
			.describe(
				"The content to publish. Assemble this from the approved Review Queue row before calling — this tool does not read the Review Queue itself.",
			),
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
		try {
			return await pushToClient(
				{
					clientId: input.clientId,
					payload: {
						brainId: input.payload.brainId,
						title: input.payload.title,
						source: input.payload.source,
						category: input.payload.category,
						originalDate: input.payload.originalDate ?? null,
						originUrl: input.payload.originUrl ?? null,
						bodyMarkdown: input.payload.bodyMarkdown ?? null,
					},
					allowProduction: input.allowProduction ?? undefined,
				},
				{ api, preflight },
			);
		} catch (err) {
			if (err instanceof PushToClientError) {
				// Re-throw as a plain Error carrying the structured JSON so the
				// tool boundary serializes it predictably.
				const e = new Error(err.message);
				e.name = err.name;
				Object.assign(e, err.toJSON());
				throw e;
			}
			throw err;
		}
	},
});
