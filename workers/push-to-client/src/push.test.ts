import { describe, expect, it, vi } from "vitest";

import { DestinationSchemaMismatch, ProductionPushNotAuthorized } from "./errors.js";
import type { DocType } from "./doc-types.js";
import type { ClientApi, NotionSdkSubset } from "./notion-client.js";
import { PreflightCache, type DestSchema } from "./preflight.js";
import { pushToClient } from "./push.js";
import type { PushPayload } from "./properties.js";

const DOCS_DB = "db_docs";
const STATUS_DB = "db_status";
const DELIV_DB = "db_deliv";

function schemaFor(
	docType: DocType,
	overrides: Partial<DestSchema> = {},
): DestSchema {
	const base: Record<DocType, DestSchema> = {
		Docs: {
			dataSourceId: "ds_docs",
			statusOptions: new Set(["Drafting", "In Review", "Published", "Archived"]),
			typeOptions: new Set(["Contract", "Brand", "Framework", "Guide"]),
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
			statusOptions: new Set(["Not Started", "In Progress", "Done"]),
			typeOptions: new Set(),
			optionalPropertiesPresent: { Presenter: false, Addressed: false },
		},
	};
	return { ...base[docType], ...overrides };
}

type MakeApiOpts = {
	mode?: "staging" | "production";
	queryResults?: Array<{ id: string; url: string }>;
	createResponse?: { id: string; url: string };
	usersByEmail?: Map<string, string>;
};

type CreateArg = {
	parent: { type?: string; data_source_id: string };
	properties: Record<string, unknown>;
	children?: unknown[];
};

function makeApi(opts: MakeApiOpts = {}) {
	const pacerWait = vi.fn<() => Promise<void>>(async () => undefined);
	const dsQuery = vi.fn<NotionSdkSubset["dataSources"]["query"]>(async () => ({
		results: opts.queryResults ?? [],
	}));
	const dsRetrieve = vi.fn<NotionSdkSubset["dataSources"]["retrieve"]>(async () => ({}));
	const dbRetrieve = vi.fn<NotionSdkSubset["databases"]["retrieve"]>(async () => ({}));
	const pagesCreate = vi.fn<NotionSdkSubset["pages"]["create"]>(async () => {
		return opts.createResponse ?? { id: "page_new", url: "https://notion.so/new" };
	});
	const pagesRetrieve = vi.fn<NotionSdkSubset["pages"]["retrieve"]>(async () => ({}));
	const pagesUpdate = vi.fn<NotionSdkSubset["pages"]["update"]>(async () => ({}));
	const blocksAppend = vi.fn<NotionSdkSubset["blocks"]["children"]["append"]>(
		async () => ({ results: [] }),
	);
	const blocksList = vi.fn<NotionSdkSubset["blocks"]["children"]["list"]>(
		async () => ({ results: [], has_more: false }),
	);
	const usersList = vi.fn<NotionSdkSubset["users"]["list"]>(async () => ({ results: [] }));

	const sdk: NotionSdkSubset = {
		databases: { retrieve: dbRetrieve },
		dataSources: { retrieve: dsRetrieve, query: dsQuery },
		pages: { create: pagesCreate, retrieve: pagesRetrieve, update: pagesUpdate },
		blocks: { children: { append: blocksAppend, list: blocksList } },
		users: { list: usersList },
	};
	const usersMap = opts.usersByEmail ?? new Map<string, string>();
	const api: ClientApi = {
		id: "acme",
		destDbIdsByType: { Docs: DOCS_DB, StatusUpdate: STATUS_DB, Deliverable: DELIV_DB },
		mode: opts.mode ?? "staging",
		waitForPacer: pacerWait,
		sdk,
		usersByEmail: {
			get: () => Promise.resolve(usersMap),
			reset: () => undefined,
		},
	};
	return { api, pacerWait, dsQuery, pagesCreate, blocksAppend };
}

function preflightWith(api: ClientApi, schemas: Partial<Record<DocType, DestSchema>>): PreflightCache {
	const cache = new PreflightCache();
	for (const [docType, schema] of Object.entries(schemas) as Array<[DocType, DestSchema]>) {
		cache.seed(
			{ id: api.id, docType, destDbId: api.destDbIdsByType[docType] },
			schema,
		);
	}
	return cache;
}

function docsPayload(overrides: Partial<Extract<PushPayload, { docType: "Docs" }>> = {}): PushPayload {
	return {
		docType: "Docs",
		brainId: "brain-1",
		title: "Doc",
		type: "Contract",
		status: "Drafting",
		bodyMarkdown: "# Hi",
		...overrides,
	};
}

function statusPayload(
	overrides: Partial<Extract<PushPayload, { docType: "StatusUpdate" }>> = {},
): PushPayload {
	return {
		docType: "StatusUpdate",
		brainId: "brain-1",
		title: "Status Update",
		date: "2026-05-18",
		summary: "Hello",
		...overrides,
	};
}

function deliverablePayload(
	overrides: Partial<Extract<PushPayload, { docType: "Deliverable" }>> = {},
): PushPayload {
	return {
		docType: "Deliverable",
		brainId: "brain-1",
		title: "Aduro Home",
		status: "In Progress",
		timelineStart: "2026-05-15",
		...overrides,
	};
}

describe("pushToClient — Docs", () => {
	it("creates a Doc against the Docs data source", async () => {
		const { api, pagesCreate } = makeApi();
		const preflight = preflightWith(api, { Docs: schemaFor("Docs") });
		const out = await pushToClient(
			{ clientId: "acme", payload: docsPayload() },
			{ api, preflight },
		);
		expect(out.status).toBe("created");
		const arg = pagesCreate.mock.calls[0]?.[0] as CreateArg | undefined;
		if (!arg?.parent || !("data_source_id" in arg.parent) || !arg.properties) {
			throw new Error("expected data_source_id parent + properties");
		}
		expect(arg.parent.data_source_id).toBe("ds_docs");
		expect(Object.keys(arg.properties).sort()).toEqual([
			"Brain ID",
			"File Name",
			"Status",
			"Type",
		]);
	});

	it("throws DestinationSchemaMismatch (unknownStatus) before any write when status is invalid", async () => {
		const { api, pagesCreate, dsQuery } = makeApi();
		const preflight = preflightWith(api, { Docs: schemaFor("Docs") });
		await expect(
			pushToClient(
				{ clientId: "acme", payload: docsPayload({ status: "Bogus" }) },
				{ api, preflight },
			),
		).rejects.toMatchObject({ details: { unknownStatus: "Bogus" } });
		expect(pagesCreate).not.toHaveBeenCalled();
		expect(dsQuery).not.toHaveBeenCalled();
	});

	it("throws DestinationSchemaMismatch (unknownType) when type is invalid", async () => {
		const { api } = makeApi();
		const preflight = preflightWith(api, { Docs: schemaFor("Docs") });
		await expect(
			pushToClient(
				{ clientId: "acme", payload: docsPayload({ type: "Nope" }) },
				{ api, preflight },
			),
		).rejects.toMatchObject({ details: { unknownType: "Nope" } });
	});
});

describe("pushToClient — StatusUpdate", () => {
	it("creates a Status Update against the Status Updates data source", async () => {
		const { api, pagesCreate } = makeApi();
		const preflight = preflightWith(api, { StatusUpdate: schemaFor("StatusUpdate") });
		const out = await pushToClient(
			{ clientId: "acme", payload: statusPayload() },
			{ api, preflight },
		);
		expect(out.status).toBe("created");
		const arg = pagesCreate.mock.calls[0]?.[0] as CreateArg | undefined;
		if (!arg?.parent || !("data_source_id" in arg.parent) || !arg.properties) {
			throw new Error("expected data_source_id parent + properties");
		}
		expect(arg.parent.data_source_id).toBe("ds_status");
		expect(Object.keys(arg.properties).sort()).toEqual([
			"Brain ID",
			"Date",
			"Summary",
			"Title",
		]);
	});

	it("includes Presenter when email resolves to a user", async () => {
		const usersByEmail = new Map([["alice@example.com", "user_alice"]]);
		const { api, pagesCreate } = makeApi({ usersByEmail });
		const preflight = preflightWith(api, { StatusUpdate: schemaFor("StatusUpdate") });
		await pushToClient(
			{
				clientId: "acme",
				payload: statusPayload({ presenterEmail: "alice@example.com" }),
			},
			{ api, preflight },
		);
		const arg = pagesCreate.mock.calls[0]?.[0] as CreateArg | undefined;
		if (!arg?.properties) throw new Error("expected properties");
		expect(arg.properties.Presenter).toEqual({
			people: [{ id: "user_alice", object: "user" }],
		});
	});

	it("warns and skips Presenter when email does not resolve", async () => {
		const { api, pagesCreate } = makeApi({ usersByEmail: new Map() });
		const preflight = preflightWith(api, { StatusUpdate: schemaFor("StatusUpdate") });
		const out = await pushToClient(
			{
				clientId: "acme",
				payload: statusPayload({ presenterEmail: "ghost@example.com" }),
			},
			{ api, preflight },
		);
		expect(out.status).toBe("created");
		expect(out.warnings.some((w) => /Presenter email/i.test(w))).toBe(true);
		const arg = pagesCreate.mock.calls[0]?.[0] as CreateArg | undefined;
		if (!arg?.properties) throw new Error("expected properties");
		expect(arg.properties.Presenter).toBeUndefined();
	});

	it("warns when destination DB lacks the Presenter property entirely", async () => {
		const { api } = makeApi({ usersByEmail: new Map([["x@y.z", "u_x"]]) });
		const preflight = preflightWith(api, {
			StatusUpdate: schemaFor("StatusUpdate", {
				optionalPropertiesPresent: { Presenter: false, Addressed: true },
			}),
		});
		const out = await pushToClient(
			{ clientId: "acme", payload: statusPayload({ presenterEmail: "x@y.z" }) },
			{ api, preflight },
		);
		expect(out.warnings.some((w) => /no Presenter property/i.test(w))).toBe(true);
	});

	it("Addressed checkbox flows through to properties when supplied", async () => {
		const { api, pagesCreate } = makeApi();
		const preflight = preflightWith(api, { StatusUpdate: schemaFor("StatusUpdate") });
		await pushToClient(
			{ clientId: "acme", payload: statusPayload({ addressed: true }) },
			{ api, preflight },
		);
		const arg = pagesCreate.mock.calls[0]?.[0] as CreateArg | undefined;
		if (!arg?.properties) throw new Error("expected properties");
		expect(arg.properties.Addressed).toEqual({ checkbox: true });
	});
});

describe("pushToClient — Deliverable", () => {
	it("creates a Deliverable with Timeline as a date range when end provided", async () => {
		const { api, pagesCreate } = makeApi();
		const preflight = preflightWith(api, { Deliverable: schemaFor("Deliverable") });
		await pushToClient(
			{
				clientId: "acme",
				payload: deliverablePayload({ timelineEnd: "2026-06-30" }),
			},
			{ api, preflight },
		);
		const arg = pagesCreate.mock.calls[0]?.[0] as CreateArg | undefined;
		if (!arg?.parent || !("data_source_id" in arg.parent) || !arg.properties) {
			throw new Error("expected data_source_id parent + properties");
		}
		expect(arg.parent.data_source_id).toBe("ds_deliv");
		expect(arg.properties.Timeline).toEqual({
			date: { start: "2026-05-15", end: "2026-06-30" },
		});
	});

	it("throws DestinationSchemaMismatch on unknown status", async () => {
		const { api } = makeApi();
		const preflight = preflightWith(api, { Deliverable: schemaFor("Deliverable") });
		await expect(
			pushToClient(
				{ clientId: "acme", payload: deliverablePayload({ status: "Mystery" }) },
				{ api, preflight },
			),
		).rejects.toMatchObject({ details: { unknownStatus: "Mystery" } });
	});
});

describe("pushToClient — shared behavior", () => {
	it("returns already_pushed when an existing Brain ID matches", async () => {
		const { api, pagesCreate } = makeApi({
			queryResults: [{ id: "page_existing", url: "https://notion.so/old" }],
		});
		const preflight = preflightWith(api, { Docs: schemaFor("Docs") });
		const out = await pushToClient(
			{ clientId: "acme", payload: docsPayload() },
			{ api, preflight },
		);
		expect(out.status).toBe("already_pushed");
		expect(out.pushedPageId).toBe("page_existing");
		expect(pagesCreate).not.toHaveBeenCalled();
	});

	it("throws ProductionPushNotAuthorized before any SDK call when mode is production", async () => {
		const { api, pagesCreate, dsQuery } = makeApi({ mode: "production" });
		const preflight = preflightWith(api, { Docs: schemaFor("Docs") });
		await expect(
			pushToClient(
				{ clientId: "acme", payload: docsPayload() },
				{ api, preflight },
			),
		).rejects.toBeInstanceOf(ProductionPushNotAuthorized);
		expect(pagesCreate).not.toHaveBeenCalled();
		expect(dsQuery).not.toHaveBeenCalled();
	});

	it("allows production pushes when allowProduction=true is passed", async () => {
		const { api } = makeApi({ mode: "production" });
		const preflight = preflightWith(api, { Docs: schemaFor("Docs") });
		const out = await pushToClient(
			{ clientId: "acme", payload: docsPayload(), allowProduction: true },
			{ api, preflight },
		);
		expect(out.status).toBe("created");
	});

	it("chunks >100 children via blocks.children.append", async () => {
		const md = Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n\n");
		const { api, pagesCreate, blocksAppend } = makeApi();
		const preflight = preflightWith(api, { Docs: schemaFor("Docs") });
		await pushToClient(
			{ clientId: "acme", payload: docsPayload({ bodyMarkdown: md }) },
			{ api, preflight },
		);
		expect(pagesCreate).toHaveBeenCalledTimes(1);
		expect(blocksAppend).toHaveBeenCalledTimes(2);
	});

	it("emits the structured log line with docType", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const { api } = makeApi();
		const preflight = preflightWith(api, { Docs: schemaFor("Docs") });
		await pushToClient(
			{ clientId: "acme", payload: docsPayload() },
			{ api, preflight },
		);
		expect(logSpy).toHaveBeenCalledWith(
			"push-to-client",
			expect.objectContaining({
				clientId: "acme",
				docType: "Docs",
				brainId: "brain-1",
			}),
		);
		logSpy.mockRestore();
	});
});

describe("DocType conformance", () => {
	it("type-system enforces that PushPayload's docType matches the docs", () => {
		const _doc: DocType = "Docs";
		const _su: DocType = "StatusUpdate";
		const _d: DocType = "Deliverable";
		expect([_doc, _su, _d]).toHaveLength(3);
	});
});
