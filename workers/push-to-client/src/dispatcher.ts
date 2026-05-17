/**
 * AI Drafts dispatcher.
 *
 * Reads a draft row, decides routing from `Status`, fans out to the matching
 * destinations via `pushToClient`, formats `Location` as the spec describes
 * (one Markdown-linked line per destination), then writes `Status` + `Location`
 * back to the draft.
 *
 * Failure semantics (per the AI Drafts Trigger and Return spec):
 *   - If ANY destination fails on a multi-destination send: leave `Status` in
 *     the originating "Send to …", write the partial `Location` (so the human
 *     sees what already landed), and return `partial_failure`. Retries are
 *     safe because per-destination `Brain ID` dedup skips the side that
 *     already landed.
 *   - If `Status` is already in a Complete group (`In Both`, `In Client
 *     Workspace`, `In Notion State OS`, `Archive`): return `no_op` without
 *     touching anything.
 *
 * Triggered by the `dispatchDraft` tool (agent / `ntn workers exec`) and by
 * the `onDraftStatusChange` webhook (Notion UI database automation). Both
 * paths go through this single entry-point.
 */

import type { ArtifactCategoryResolver } from "./artifact-category.js";
import { renderBodyMarkdown } from "./body-renderer.js";
import type { CompanyMapping } from "./company-mapping.js";
import { DOC_TYPE_SPECS, type DocType } from "./doc-types.js";
import {
	ClientNotConfigured,
	DraftDispatchFailure,
	MissingClientForCompany,
	MissingDraftRelation,
	PushToClientError,
	UnpushableArtifactCategory,
	type DraftDispatchFailureEntry,
	type DraftDispatchSide,
	type DraftDispatchSuccess,
} from "./errors.js";
import {
	formatLocation,
	type LocationEntry,
} from "./location-format.js";
import {
	HOME_CLIENT_ID,
	listPageBlocks,
	retrievePage,
	retrieveUserEmail,
	updatePage,
	type HomeApi,
} from "./home-api.js";
import type { ClientApi } from "./notion-client.js";
import { properties } from "./properties.js";
import { pushToClient } from "./push.js";
import { PreflightCache } from "./preflight.js";
import type { PushPayload } from "./properties.js";

const TRIGGER_STATUSES = new Set([
	"Send to Both",
	"Send to Client OS",
	"Send to Notion State OS",
]);

const COMPLETE_STATUSES = new Set([
	"In Both",
	"In Client Workspace",
	"In Notion State OS",
	"Archive",
]);

type Routing = {
	sides: DraftDispatchSide[];
	resultingStatus: "In Both" | "In Client Workspace" | "In Notion State OS";
};

const ROUTING_BY_STATUS: Record<string, Routing> = {
	"Send to Both": {
		sides: ["ClientOS", "NSOS"],
		resultingStatus: "In Both",
	},
	"Send to Client OS": {
		sides: ["ClientOS"],
		resultingStatus: "In Client Workspace",
	},
	"Send to Notion State OS": {
		sides: ["NSOS"],
		resultingStatus: "In Notion State OS",
	},
};

const DOC_TYPE_LABEL: Record<DocType, string> = {
	Docs: "Docs",
	StatusUpdate: "Status Updates",
	Deliverable: "Deliverables",
};

export type DispatchInput = {
	draftPageId: string;
	allowProduction?: boolean | null;
};

export type DispatchPushedEntry = DraftDispatchSuccess & {
	warnings: string[];
};

export type DispatchResult =
	| {
			status: "dispatched";
			resultingStatus: string;
			location: string;
			pushed: DispatchPushedEntry[];
			failures: DraftDispatchFailureEntry[];
	  }
	| {
			status: "no_op";
			resultingStatus: string;
			location: string;
			pushed: DispatchPushedEntry[];
			failures: DraftDispatchFailureEntry[];
	  }
	| {
			status: "partial_failure";
			resultingStatus: string;
			location: string;
			pushed: DispatchPushedEntry[];
			failures: DraftDispatchFailureEntry[];
	  };

export type DispatcherDeps = {
	homeApi: HomeApi;
	perClient: Record<string, ClientApi>;
	preflight: PreflightCache;
	companyMapping: CompanyMapping;
	artifactCategory: ArtifactCategoryResolver;
	displayNames: Record<string, string>; // by clientId, plus the home id (HOME_CLIENT_ID)
	now?: () => Date;
};

export async function dispatchDraft(
	input: DispatchInput,
	deps: DispatcherDeps,
): Promise<DispatchResult> {
	const now = (deps.now ?? (() => new Date()))();

	const draft = await retrievePage(deps.homeApi, input.draftPageId);
	const parsed = parseDraft(draft);

	console.log("dispatch-draft", {
		draftPageId: input.draftPageId,
		status: parsed.statusName,
		artifactCategoryRelationCount: parsed.artifactCategoryIds.length,
		companyRelationCount: parsed.companyIds.length,
	});

	// 1. Idempotent no-op when already in a Complete state.
	if (parsed.statusName && COMPLETE_STATUSES.has(parsed.statusName)) {
		return {
			status: "no_op",
			resultingStatus: parsed.statusName,
			location: "",
			pushed: [],
			failures: [],
		};
	}

	// 2. No-op when not a dispatch trigger (covers webhook fan-out from other
	//    property changes).
	const statusName = parsed.statusName ?? "";
	const routing = ROUTING_BY_STATUS[statusName];
	if (!routing) {
		return {
			status: "no_op",
			resultingStatus: statusName,
			location: "",
			pushed: [],
			failures: [],
		};
	}

	// 3. Resolve docType from Artifact Category.
	if (parsed.artifactCategoryIds.length === 0) {
		throw new MissingDraftRelation(
			"Artifact Category",
			"draft must link to exactly one Artifact Categories registry row",
		);
	}
	const categoryPageId = parsed.artifactCategoryIds[0]!;
	const category = await deps.artifactCategory.get(categoryPageId);
	if (!category) {
		throw new MissingDraftRelation(
			"Artifact Category",
			`category page "${categoryPageId}" is not in the registry or has an unrecognized title`,
		);
	}
	if (category === "FeatureRequests") {
		throw new UnpushableArtifactCategory("Feature Requests");
	}
	const docType: DocType = category;

	// 4. Resolve clientId only for Client OS-bound sends.
	let resolvedClientId: string | undefined;
	if (routing.sides.includes("ClientOS")) {
		if (parsed.companyIds.length === 0) {
			throw new MissingDraftRelation(
				"Company",
				"Client OS routing requires the draft to link to exactly one Company page",
			);
		}
		const companyPageId = parsed.companyIds[0]!;
		const clientId = deps.companyMapping.get(companyPageId);
		if (!clientId) throw new MissingClientForCompany(companyPageId);
		resolvedClientId = clientId;
		if (parsed.companyIds.length > 1) {
			console.warn("dispatch-draft: multiple Company relations; using first", {
				draftPageId: input.draftPageId,
				picked: companyPageId,
				ignored: parsed.companyIds.slice(1),
			});
		}
	}

	// 5. Render the draft body to our markdown subset.
	const blocks = await listPageBlocks(deps.homeApi, input.draftPageId);
	const bodyMarkdown = renderBodyMarkdown(blocks);

	// 6. Resolve DRI (people) on the draft to an email — only when the docType
	//    actually needs it (Deliverable). Skipping for Docs / Status Update
	//    avoids an unnecessary `users.retrieve` API call on every dispatch
	//    where the draft happens to have DRI set.
	const ownerEmail =
		docType === "Deliverable"
			? await resolveOwnerEmailFromDraft({
					draftPageId: input.draftPageId,
					driUserIds: parsed.driUserIds,
					homeApi: deps.homeApi,
			  })
			: "";

	// 7. Build the per-docType payload with defaults.
	const payload = buildPayloadWithDefaults({
		docType,
		draftPageId: input.draftPageId,
		title: parsed.title,
		sourceExcerpt: parsed.sourceExcerpt,
		bodyMarkdown,
		ownerEmail,
		now,
	});

	// 8. Fan out.
	const allowProduction = input.allowProduction ?? false;
	const sideResults = await Promise.allSettled(
		routing.sides.map((side) =>
			runSide({
				side,
				payload,
				clientId: side === "ClientOS" ? resolvedClientId! : HOME_CLIENT_ID,
				deps,
				allowProduction,
			}),
		),
	);

	const pushed: DispatchPushedEntry[] = [];
	const failures: DraftDispatchFailureEntry[] = [];
	for (let i = 0; i < sideResults.length; i++) {
		const side = routing.sides[i]!;
		const result = sideResults[i]!;
		if (result.status === "fulfilled") {
			pushed.push(result.value);
		} else {
			failures.push(translateSideError(side, result.reason));
		}
	}

	// 9. Format Location for the successful sides only.
	const location = formatLocation(
		pushed.map((entry): LocationEntry => ({
			side: entry.side,
			linkText: linkTextFor(entry.side, docType, resolvedClientId, deps.displayNames),
			url: entry.pushedPageUrl,
		})),
	);

	// 10. Writeback.
	if (failures.length > 0) {
		// Partial failure → keep Status in the trigger value; record what landed.
		await updatePage(deps.homeApi, input.draftPageId, {
			Location: properties.richText(location),
		});
		return {
			status: "partial_failure",
			resultingStatus: statusName,
			location,
			pushed,
			failures,
		};
	}

	await updatePage(deps.homeApi, input.draftPageId, {
		Status: properties.status(routing.resultingStatus),
		Location: properties.richText(location),
	});
	return {
		status: "dispatched",
		resultingStatus: routing.resultingStatus,
		location,
		pushed,
		failures: [],
	};
}

// ---- Internals ----

type ParsedDraft = {
	statusName: string | null;
	title: string;
	sourceExcerpt: string;
	artifactCategoryIds: string[];
	companyIds: string[];
	driUserIds: string[];
};

export function parseDraft(response: unknown): ParsedDraft {
	if (!isObject(response)) {
		return {
			statusName: null,
			title: "",
			sourceExcerpt: "",
			artifactCategoryIds: [],
			companyIds: [],
			driUserIds: [],
		};
	}
	const props = isObject(response.properties) ? response.properties : {};
	return {
		statusName: readStatus(props.Status),
		title: readTitle(props.Name),
		sourceExcerpt: readText(props["Source Excerpt"]),
		artifactCategoryIds: readRelationIds(props["Artifact Category"]),
		companyIds: readRelationIds(props.Company),
		driUserIds: readPeopleIds(props.DRI),
	};
}

function readStatus(value: unknown): string | null {
	if (!isObject(value) || value.type !== "status") return null;
	const status = isObject(value.status) ? value.status : null;
	const name = status && typeof status.name === "string" ? status.name : null;
	return name;
}

function readTitle(value: unknown): string {
	if (!isObject(value) || value.type !== "title" || !Array.isArray(value.title)) return "";
	let out = "";
	for (const seg of value.title) {
		if (isObject(seg) && typeof seg.plain_text === "string") out += seg.plain_text;
	}
	return out.trim();
}

function readText(value: unknown): string {
	if (!isObject(value) || value.type !== "rich_text" || !Array.isArray(value.rich_text)) return "";
	let out = "";
	for (const seg of value.rich_text) {
		if (isObject(seg) && typeof seg.plain_text === "string") out += seg.plain_text;
	}
	return out.trim();
}

function readRelationIds(value: unknown): string[] {
	if (!isObject(value) || value.type !== "relation" || !Array.isArray(value.relation)) return [];
	const out: string[] = [];
	for (const rel of value.relation) {
		if (isObject(rel) && typeof rel.id === "string") out.push(rel.id);
	}
	return out;
}

function readPeopleIds(value: unknown): string[] {
	if (!isObject(value) || value.type !== "people" || !Array.isArray(value.people)) return [];
	const out: string[] = [];
	for (const person of value.people) {
		if (isObject(person) && typeof person.id === "string") out.push(person.id);
	}
	return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function buildPayloadWithDefaults(args: {
	docType: DocType;
	draftPageId: string;
	title: string;
	sourceExcerpt: string;
	bodyMarkdown: string;
	ownerEmail: string;
	now: Date;
}): PushPayload {
	const title = args.title || "Untitled draft";
	const todayIso = args.now.toISOString().slice(0, 10);
	switch (args.docType) {
		case "Docs":
			return {
				docType: "Docs",
				brainId: args.draftPageId,
				title,
				type: "Guide",
				status: "Drafting",
				bodyMarkdown: args.bodyMarkdown,
			};
		case "StatusUpdate":
			return {
				docType: "StatusUpdate",
				brainId: args.draftPageId,
				title,
				date: todayIso,
				summary: args.sourceExcerpt || title,
				presenterEmail: null,
				addressed: null,
				bodyMarkdown: args.bodyMarkdown,
			};
		case "Deliverable":
			return {
				docType: "Deliverable",
				brainId: args.draftPageId,
				title,
				status: "Not Started",
				timelineStart: todayIso,
				timelineEnd: null,
				ownerEmail: args.ownerEmail || null,
				bodyMarkdown: args.bodyMarkdown,
			};
	}
}

/**
 * Reads the draft's first `DRI` user id and resolves it to an email via the
 * home workspace. Returns `""` when DRI is empty or unresolvable — the push
 * path treats that as "Owner left blank" and surfaces a warning. Multi-DRI is
 * logged and the first entry wins, matching the multi-Company precedent.
 */
async function resolveOwnerEmailFromDraft(args: {
	draftPageId: string;
	driUserIds: string[];
	homeApi: HomeApi;
}): Promise<string> {
	if (args.driUserIds.length === 0) return "";
	const firstId = args.driUserIds[0]!;
	if (args.driUserIds.length > 1) {
		console.warn("dispatch-draft: multiple DRI users; using first", {
			draftPageId: args.draftPageId,
			picked: firstId,
			ignored: args.driUserIds.slice(1),
		});
	}
	const email = await retrieveUserEmail(args.homeApi, firstId);
	return email ?? "";
}

async function runSide(args: {
	side: DraftDispatchSide;
	payload: PushPayload;
	clientId: string;
	deps: DispatcherDeps;
	allowProduction: boolean;
}): Promise<DispatchPushedEntry> {
	const api = args.deps.perClient[args.clientId];
	if (!api) throw new ClientNotConfigured(args.clientId);
	const result = await pushToClient(
		{
			clientId: args.clientId,
			payload: args.payload,
			allowProduction: args.allowProduction,
		},
		{ api, preflight: args.deps.preflight },
	);
	return {
		side: args.side,
		pushedPageId: result.pushedPageId,
		pushedPageUrl: result.pushedPageUrl,
		warnings: result.warnings,
	};
}

function translateSideError(
	side: DraftDispatchSide,
	err: unknown,
): DraftDispatchFailureEntry {
	if (err instanceof PushToClientError) {
		return { side, code: err.code, message: err.message };
	}
	if (err instanceof Error) {
		return { side, code: "UNKNOWN", message: err.message };
	}
	return { side, code: "UNKNOWN", message: String(err) };
}

function linkTextFor(
	side: DraftDispatchSide,
	docType: DocType,
	resolvedClientId: string | undefined,
	displayNames: Record<string, string>,
): string {
	const baseName =
		side === "NSOS"
			? displayNames[HOME_CLIENT_ID] ?? "Notion State OS"
			: displayNames[resolvedClientId ?? ""] ?? resolvedClientId ?? "Client";
	return `${baseName} – ${DOC_TYPE_LABEL[docType]}`;
}

/**
 * Convenience helper used by the tool's execute handler: if the result is a
 * partial failure, throw a typed error so the tool boundary serializes the
 * structured details. The webhook path uses `dispatchDraft` directly and just
 * logs.
 */
export function throwIfPartialFailure(result: DispatchResult): DispatchResult {
	if (result.status === "partial_failure") {
		throw new DraftDispatchFailure(
			result.pushed.map(({ warnings: _w, ...rest }) => rest),
			result.failures,
		);
	}
	return result;
}
