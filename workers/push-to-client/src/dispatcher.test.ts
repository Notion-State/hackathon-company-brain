import { describe, expect, it, vi } from "vitest";

import type { ArtifactCategoryName, ArtifactCategoryResolver } from "./artifact-category.js";
import type { CompanyMapping } from "./company-mapping.js";
import type { DocType } from "./doc-types.js";
import {
	DraftDispatchFailure,
	MissingClientForCompany,
	MissingDraftRelation,
	PushToClientError,
	UnpushableArtifactCategory,
} from "./errors.js";
import type { HomeApi } from "./home-api.js";
import type { ClientApi, NotionSdkSubset } from "./notion-client.js";
import { PreflightCache, type DestSchema } from "./preflight.js";
import { dispatchDraft, throwIfPartialFailure, type DispatcherDeps } from "./dispatcher.js";

const DRAFT_ID = "draft_001";
const COMPANY_ID = "company_acme";
const CATEGORY_ID = "category_doc";

function makeHomeSdk(opts: {
	page?: unknown;
	updateThrows?: unknown;
}): {
	sdk: NotionSdkSubset;
	pagesRetrieve: ReturnType<typeof vi.fn<NotionSdkSubset["pages"]["retrieve"]>>;
	pagesUpdate: ReturnType<typeof vi.fn<NotionSdkSubset["pages"]["update"]>>;
} {
	const pagesRetrieve = vi.fn<NotionSdkSubset["pages"]["retrieve"]>(async () => opts.page ?? {});
	const pagesUpdate = vi.fn<NotionSdkSubset["pages"]["update"]>(async () => {
		if (opts.updateThrows) throw opts.updateThrows;
		return {};
	});
	const blocksList = vi.fn<NotionSdkSubset["blocks"]["children"]["list"]>(async () => ({
		results: [],
		has_more: false,
	}));
	const sdk: NotionSdkSubset = {
		databases: { retrieve: vi.fn(async () => ({})) },
		dataSources: {
			retrieve: vi.fn(async () => ({})),
			query: vi.fn(async () => ({ results: [] })),
		},
		pages: {
			create: vi.fn(async () => ({})),
			retrieve: pagesRetrieve,
			update: pagesUpdate,
		},
		blocks: {
			children: {
				append: vi.fn(async () => ({})),
				list: blocksList,
			},
		},
		users: { list: vi.fn(async () => ({ results: [] })) },
	};
	return { sdk, pagesRetrieve, pagesUpdate };
}

function makeHomeApi(opts: {
	page?: unknown;
	updateThrows?: unknown;
}): {
	api: HomeApi;
	pagesRetrieve: ReturnType<typeof vi.fn<NotionSdkSubset["pages"]["retrieve"]>>;
	pagesUpdate: ReturnType<typeof vi.fn<NotionSdkSubset["pages"]["update"]>>;
} {
	const { sdk, pagesRetrieve, pagesUpdate } = makeHomeSdk(opts);
	return {
		api: {
			id: "notion-state",
			waitForPacer: vi.fn<() => Promise<void>>(async () => undefined),
			sdk,
		},
		pagesRetrieve,
		pagesUpdate,
	};
}

function makePerClient(ids: string[]): Record<string, ClientApi> {
	const out: Record<string, ClientApi> = {};
	for (const id of ids) {
		const sdk: NotionSdkSubset = {
			databases: { retrieve: vi.fn(async () => ({})) },
			dataSources: {
				retrieve: vi.fn(async () => ({})),
				query: vi.fn(async () => ({ results: [] })),
			},
			pages: {
				create: vi.fn(async () => ({
					id: `page_${id}`,
					url: `https://notion.so/${id}`,
				})),
				retrieve: vi.fn(async () => ({})),
				update: vi.fn(async () => ({})),
			},
			blocks: {
				children: {
					append: vi.fn(async () => ({})),
					list: vi.fn(async () => ({ results: [], has_more: false })),
				},
			},
			users: { list: vi.fn(async () => ({ results: [] })) },
		};
		out[id] = {
			id,
			destDbIdsByType: {
				Docs: `${id}_docs_db`,
				StatusUpdate: `${id}_status_db`,
				Deliverable: `${id}_deliv_db`,
			},
			mode: "staging",
			waitForPacer: vi.fn<() => Promise<void>>(async () => undefined),
			sdk,
			usersByEmail: {
				get: () => Promise.resolve(new Map()),
				reset: () => undefined,
			},
		};
	}
	return out;
}

function preflightWith(perClient: Record<string, ClientApi>, docType: DocType): PreflightCache {
	const cache = new PreflightCache();
	const schemasByDoc: Record<DocType, DestSchema> = {
		Docs: {
			dataSourceId: "ds_docs",
			statusOptions: new Set(["Drafting", "In Review", "Published", "Archived"]),
			typeOptions: new Set(["Contract", "Brand", "Framework", "Requirements", "Guide", "Research", "Planning", "Analysis"]),
			optionalPropertiesPresent: { Presenter: false, Addressed: false },
		},
		StatusUpdate: {
			dataSourceId: "ds_status",
			statusOptions: new Set(),
			typeOptions: new Set(),
			optionalPropertiesPresent: { Presenter: true, Addressed: true },
		},
		Deliverable: {
			dataSourceId: "ds_deliv",
			statusOptions: new Set(["Not Started", "Planning", "In Progress", "In Review", "Done"]),
			typeOptions: new Set(),
			optionalPropertiesPresent: { Presenter: false, Addressed: false },
		},
	};
	for (const id of Object.keys(perClient)) {
		cache.seed(
			{ id, docType, destDbId: perClient[id]!.destDbIdsByType[docType] },
			schemasByDoc[docType],
		);
	}
	return cache;
}

function makeArtifactCategoryResolver(
	map: Record<string, ArtifactCategoryName>,
): ArtifactCategoryResolver {
	return {
		async get(pageId: string) {
			return map[pageId];
		},
		reset() {
			/* noop */
		},
	};
}

function makeCompanyMapping(map: Record<string, string>): CompanyMapping {
	return {
		get(companyPageId: string) {
			return map[companyPageId];
		},
		entries() {
			return Object.entries(map)
				.map(([companyPageId, clientId]) => ({ companyPageId, clientId }))
				.sort((a, b) => a.clientId.localeCompare(b.clientId));
		},
	};
}

function makeDeps(args: {
	homeApi: HomeApi;
	perClient: Record<string, ClientApi>;
	docType?: DocType;
	categoryMap?: Record<string, ArtifactCategoryName>;
	companyMap?: Record<string, string>;
	displayNames?: Record<string, string>;
	now?: () => Date;
}): DispatcherDeps {
	const docType = args.docType ?? "Docs";
	return {
		homeApi: args.homeApi,
		perClient: args.perClient,
		preflight: preflightWith(args.perClient, docType),
		companyMapping: makeCompanyMapping(args.companyMap ?? { [COMPANY_ID]: "acme" }),
		artifactCategory: makeArtifactCategoryResolver(
			args.categoryMap ?? { [CATEGORY_ID]: docType },
		),
		displayNames: args.displayNames ?? { acme: "Acme", "notion-state": "Notion State" },
		now: args.now ?? (() => new Date("2026-05-20T12:00:00.000Z")),
	};
}

function draftPage(opts: {
	statusName: string;
	titleText?: string;
	artifactCategoryIds?: string[];
	companyIds?: string[];
	sourceExcerpt?: string;
}): unknown {
	return {
		object: "page",
		id: DRAFT_ID,
		properties: {
			Status: {
				type: "status",
				status: opts.statusName === "" ? null : { name: opts.statusName },
			},
			Name: {
				type: "title",
				title: opts.titleText
					? [{ type: "text", plain_text: opts.titleText }]
					: [],
			},
			"Source Excerpt": {
				type: "rich_text",
				rich_text: opts.sourceExcerpt
					? [{ type: "text", plain_text: opts.sourceExcerpt }]
					: [],
			},
			"Artifact Category": {
				type: "relation",
				relation: (opts.artifactCategoryIds ?? []).map((id) => ({ id })),
			},
			Company: {
				type: "relation",
				relation: (opts.companyIds ?? []).map((id) => ({ id })),
			},
		},
	};
}

describe("dispatchDraft — Docs / Send to Client OS", () => {
	it("dispatches to the resolved client and writes back In Client Workspace", async () => {
		const { api: homeApi, pagesUpdate } = makeHomeApi({
			page: draftPage({
				statusName: "Send to Client OS",
				titleText: "Smoke Doc",
				artifactCategoryIds: [CATEGORY_ID],
				companyIds: [COMPANY_ID],
			}),
		});
		const perClient = makePerClient(["acme", "notion-state"]);
		const deps = makeDeps({ homeApi, perClient, docType: "Docs" });

		const result = await dispatchDraft({ draftPageId: DRAFT_ID }, deps);

		expect(result.status).toBe("dispatched");
		expect(result.resultingStatus).toBe("In Client Workspace");
		expect(result.pushed).toHaveLength(1);
		expect(result.pushed[0]!.side).toBe("ClientOS");

		const update = pagesUpdate.mock.calls[0]?.[0];
		if (!update?.properties) throw new Error("expected update properties");
		expect(update.properties.Status).toEqual({ status: { name: "In Client Workspace" } });
		expect(result.location).toContain("Client OS: [Acme – Docs]");
	});
});

describe("dispatchDraft — Send to Notion State OS", () => {
	it("dispatches only to the home workspace", async () => {
		const { api: homeApi } = makeHomeApi({
			page: draftPage({
				statusName: "Send to Notion State OS",
				titleText: "Internal note",
				artifactCategoryIds: [CATEGORY_ID],
				companyIds: [],
			}),
		});
		const perClient = makePerClient(["acme", "notion-state"]);
		const deps = makeDeps({ homeApi, perClient, docType: "Docs" });

		const result = await dispatchDraft({ draftPageId: DRAFT_ID }, deps);

		expect(result.status).toBe("dispatched");
		expect(result.pushed.map((p) => p.side)).toEqual(["NSOS"]);
		expect(result.resultingStatus).toBe("In Notion State OS");
		expect(result.location).toContain("NS OS: [Notion State – Docs]");
	});
});

describe("dispatchDraft — Send to Both", () => {
	it("dispatches to both sides with two-line Location and In Both status", async () => {
		const { api: homeApi } = makeHomeApi({
			page: draftPage({
				statusName: "Send to Both",
				titleText: "Both ways",
				artifactCategoryIds: [CATEGORY_ID],
				companyIds: [COMPANY_ID],
			}),
		});
		const perClient = makePerClient(["acme", "notion-state"]);
		const deps = makeDeps({ homeApi, perClient, docType: "Docs" });

		const result = await dispatchDraft({ draftPageId: DRAFT_ID }, deps);

		expect(result.status).toBe("dispatched");
		expect(result.resultingStatus).toBe("In Both");
		expect(result.pushed.map((p) => p.side).sort()).toEqual(["ClientOS", "NSOS"]);
		const lines = result.location.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/^Client OS: /);
		expect(lines[1]).toMatch(/^NS OS: /);
	});

	it("partial failure: NS OS push throws → Status untouched; partial Location written", async () => {
		const { api: homeApi, pagesUpdate } = makeHomeApi({
			page: draftPage({
				statusName: "Send to Both",
				titleText: "Both ways",
				artifactCategoryIds: [CATEGORY_ID],
				companyIds: [COMPANY_ID],
			}),
		});
		const perClient = makePerClient(["acme", "notion-state"]);
		// Build deps that only seed the ACME side; NS OS preflight falls through
		// to the SDK (whose default mock returns `{}` — no data_sources → preflight
		// throws DestinationSchemaMismatch, which surfaces as a per-side failure).
		const partialPreflight = new PreflightCache();
		partialPreflight.seed(
			{ id: "acme", docType: "Docs", destDbId: perClient.acme!.destDbIdsByType.Docs },
			{
				dataSourceId: "ds_acme_docs",
				statusOptions: new Set(["Drafting"]),
				typeOptions: new Set(["Guide"]),
				optionalPropertiesPresent: { Presenter: false, Addressed: false },
			},
		);
		const deps: DispatcherDeps = {
			homeApi,
			perClient,
			preflight: partialPreflight,
			companyMapping: makeCompanyMapping({ [COMPANY_ID]: "acme" }),
			artifactCategory: makeArtifactCategoryResolver({ [CATEGORY_ID]: "Docs" }),
			displayNames: { acme: "Acme", "notion-state": "Notion State" },
			now: () => new Date("2026-05-20T12:00:00.000Z"),
		};

		const result = await dispatchDraft({ draftPageId: DRAFT_ID }, deps);

		expect(result.status).toBe("partial_failure");
		expect(result.resultingStatus).toBe("Send to Both"); // unchanged
		expect(result.pushed.map((p) => p.side)).toEqual(["ClientOS"]);
		expect(result.failures.map((f) => f.side)).toEqual(["NSOS"]);

		// Status is NOT written back; only Location is.
		const update = pagesUpdate.mock.calls[0]?.[0];
		if (!update?.properties) throw new Error("expected update properties");
		expect(update.properties.Status).toBeUndefined();
		expect(update.properties.Location).toBeDefined();
	});
});

describe("dispatchDraft — idempotency + non-trigger no-ops", () => {
	it("returns no_op when Status is already a Complete value", async () => {
		const { api: homeApi, pagesUpdate } = makeHomeApi({
			page: draftPage({
				statusName: "In Both",
				artifactCategoryIds: [CATEGORY_ID],
				companyIds: [COMPANY_ID],
			}),
		});
		const perClient = makePerClient(["acme", "notion-state"]);
		const deps = makeDeps({ homeApi, perClient });

		const result = await dispatchDraft({ draftPageId: DRAFT_ID }, deps);

		expect(result.status).toBe("no_op");
		expect(pagesUpdate).not.toHaveBeenCalled();
	});

	it("returns no_op when Status is not one of the Send to … triggers (e.g., In Review)", async () => {
		const { api: homeApi } = makeHomeApi({
			page: draftPage({
				statusName: "In Review",
				artifactCategoryIds: [CATEGORY_ID],
			}),
		});
		const perClient = makePerClient(["acme", "notion-state"]);
		const deps = makeDeps({ homeApi, perClient });

		const result = await dispatchDraft({ draftPageId: DRAFT_ID }, deps);

		expect(result.status).toBe("no_op");
		expect(result.resultingStatus).toBe("In Review");
	});
});

describe("dispatchDraft — error paths", () => {
	it("rejects Feature Requests artifact category with UnpushableArtifactCategory", async () => {
		const { api: homeApi } = makeHomeApi({
			page: draftPage({
				statusName: "Send to Client OS",
				artifactCategoryIds: ["fr_id"],
				companyIds: [COMPANY_ID],
			}),
		});
		const perClient = makePerClient(["acme", "notion-state"]);
		const deps = makeDeps({
			homeApi,
			perClient,
			docType: "Docs",
			categoryMap: { fr_id: "FeatureRequests" },
		});
		await expect(dispatchDraft({ draftPageId: DRAFT_ID }, deps)).rejects.toBeInstanceOf(
			UnpushableArtifactCategory,
		);
	});

	it("throws MissingClientForCompany when Company doesn't map to a client", async () => {
		const { api: homeApi } = makeHomeApi({
			page: draftPage({
				statusName: "Send to Client OS",
				artifactCategoryIds: [CATEGORY_ID],
				companyIds: ["unknown_company"],
			}),
		});
		const perClient = makePerClient(["acme", "notion-state"]);
		const deps = makeDeps({ homeApi, perClient, docType: "Docs" });
		await expect(dispatchDraft({ draftPageId: DRAFT_ID }, deps)).rejects.toBeInstanceOf(
			MissingClientForCompany,
		);
	});

	it("throws MissingDraftRelation when Company is empty for Client OS-bound route", async () => {
		const { api: homeApi } = makeHomeApi({
			page: draftPage({
				statusName: "Send to Client OS",
				artifactCategoryIds: [CATEGORY_ID],
				companyIds: [],
			}),
		});
		const perClient = makePerClient(["acme", "notion-state"]);
		const deps = makeDeps({ homeApi, perClient, docType: "Docs" });
		await expect(dispatchDraft({ draftPageId: DRAFT_ID }, deps)).rejects.toBeInstanceOf(
			MissingDraftRelation,
		);
	});

	it("throws MissingDraftRelation when Artifact Category is absent", async () => {
		const { api: homeApi } = makeHomeApi({
			page: draftPage({
				statusName: "Send to Notion State OS",
				artifactCategoryIds: [],
			}),
		});
		const perClient = makePerClient(["notion-state"]);
		const deps = makeDeps({ homeApi, perClient });
		await expect(dispatchDraft({ draftPageId: DRAFT_ID }, deps)).rejects.toBeInstanceOf(
			MissingDraftRelation,
		);
	});
});

describe("dispatchDraft — defaults applied per docType", () => {
	it("Docs default fills type=Guide + status=Drafting", async () => {
		const { api: homeApi } = makeHomeApi({
			page: draftPage({
				statusName: "Send to Notion State OS",
				titleText: "Default Doc",
				artifactCategoryIds: [CATEGORY_ID],
			}),
		});
		const perClient = makePerClient(["notion-state"]);
		const deps = makeDeps({ homeApi, perClient, docType: "Docs" });
		await dispatchDraft({ draftPageId: DRAFT_ID }, deps);
		const create = vi.mocked(perClient["notion-state"]!.sdk.pages.create)
			.mock.calls[0]?.[0];
		if (!create?.properties) throw new Error("expected properties");
		expect(create.properties.Type).toEqual({ select: { name: "Guide" } });
		expect(create.properties.Status).toEqual({ status: { name: "Drafting" } });
	});

	it("StatusUpdate default fills date=today + summary from Source Excerpt", async () => {
		const { api: homeApi } = makeHomeApi({
			page: draftPage({
				statusName: "Send to Notion State OS",
				titleText: "Default SU",
				sourceExcerpt: "The excerpt",
				artifactCategoryIds: [CATEGORY_ID],
			}),
		});
		const perClient = makePerClient(["notion-state"]);
		const deps = makeDeps({
			homeApi,
			perClient,
			docType: "StatusUpdate",
			categoryMap: { [CATEGORY_ID]: "StatusUpdate" },
		});
		await dispatchDraft({ draftPageId: DRAFT_ID }, deps);
		const create = vi.mocked(perClient["notion-state"]!.sdk.pages.create)
			.mock.calls[0]?.[0];
		if (!create?.properties) throw new Error("expected properties");
		expect(create.properties.Date).toEqual({ date: { start: "2026-05-20" } });
		expect(create.properties.Summary).toMatchObject({
			rich_text: [{ text: { content: "The excerpt" } }],
		});
	});

	it("Deliverable default fills status=Not Started + timeline=today (single date)", async () => {
		const { api: homeApi } = makeHomeApi({
			page: draftPage({
				statusName: "Send to Notion State OS",
				titleText: "Default deliv",
				artifactCategoryIds: [CATEGORY_ID],
			}),
		});
		const perClient = makePerClient(["notion-state"]);
		const deps = makeDeps({
			homeApi,
			perClient,
			docType: "Deliverable",
			categoryMap: { [CATEGORY_ID]: "Deliverable" },
		});
		await dispatchDraft({ draftPageId: DRAFT_ID }, deps);
		const create = vi.mocked(perClient["notion-state"]!.sdk.pages.create)
			.mock.calls[0]?.[0];
		if (!create?.properties) throw new Error("expected properties");
		expect(create.properties.Status).toEqual({ status: { name: "Not Started" } });
		expect(create.properties.Timeline).toEqual({ date: { start: "2026-05-20" } });
	});
});

describe("throwIfPartialFailure", () => {
	it("throws DraftDispatchFailure on partial_failure", () => {
		expect(() =>
			throwIfPartialFailure({
				status: "partial_failure",
				resultingStatus: "Send to Both",
				location: "",
				pushed: [],
				failures: [{ side: "NSOS", code: "X", message: "y" }],
			}),
		).toThrow(DraftDispatchFailure);
	});

	it("returns the result unchanged on dispatched / no_op", () => {
		const r = {
			status: "dispatched" as const,
			resultingStatus: "In Both",
			location: "",
			pushed: [],
			failures: [],
		};
		expect(throwIfPartialFailure(r)).toBe(r);
	});
});

describe("PushToClientError surface compatibility", () => {
	it("all dispatcher error classes are typed PushToClientErrors", () => {
		const errs = [
			new MissingDraftRelation("X"),
			new MissingClientForCompany("c"),
			new UnpushableArtifactCategory("Feature Requests"),
			new DraftDispatchFailure([], []),
		];
		for (const e of errs) {
			expect(e).toBeInstanceOf(PushToClientError);
		}
	});
});
