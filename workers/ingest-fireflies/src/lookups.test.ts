import { beforeEach, describe, expect, it, vi } from "vitest";

import { _resetCompaniesCache, getCompaniesLookup } from "./lookups.js";

type StubClient = {
	databases: {
		retrieve: ReturnType<typeof vi.fn>;
	};
	dataSources: {
		query: ReturnType<typeof vi.fn>;
	};
};

function makeStubClient(pages: Array<{ id: string; properties: Record<string, unknown> }>): StubClient {
	return {
		databases: {
			retrieve: vi.fn(async () => ({ data_sources: [{ id: "ds-stub" }] })),
		},
		dataSources: {
			query: vi.fn(async () => ({
				results: pages,
				has_more: false,
				next_cursor: null,
			})),
		},
	};
}

function richTextProp(text: string) {
	return { type: "rich_text" as const, rich_text: [{ plain_text: text, type: "text" }] };
}
function titleProp(text: string) {
	return { type: "title" as const, title: [{ plain_text: text, type: "text" }] };
}

describe("getCompaniesLookup", () => {
	beforeEach(() => _resetCompaniesCache());

	it("returns a no-op lookup when companiesDatabaseId is unset", async () => {
		const stub = makeStubClient([]);
		const lookup = await getCompaniesLookup({
			notion: stub as never,
			companiesDatabaseId: undefined,
		});
		expect(lookup.companyNameByDomain("acme.com")).toBeNull();
		expect(stub.dataSources.query).not.toHaveBeenCalled();
	});

	it("builds domain → company-name map from the Companies datasource", async () => {
		const stub = makeStubClient([
			{
				id: "page-acme",
				properties: {
					Company: titleProp("Acme Corp"),
					Domain: richTextProp("acme.com"),
				},
			},
			{
				id: "page-beta",
				properties: {
					Company: titleProp("Beta Inc"),
					Domain: richTextProp("BETA.IO"),
				},
			},
		]);
		const lookup = await getCompaniesLookup({
			notion: stub as never,
			companiesDatabaseId: "datasource-x",
		});
		expect(lookup.companyNameByDomain("acme.com")).toBe("Acme Corp");
		expect(lookup.companyNameByDomain("beta.io")).toBe("Beta Inc");
		expect(lookup.companyNameByDomain("unknown.com")).toBeNull();
	});

	it("is case-insensitive on lookup input", async () => {
		const stub = makeStubClient([
			{
				id: "p",
				properties: { Title: titleProp("Acme"), Domain: richTextProp("acme.com") },
			},
		]);
		const lookup = await getCompaniesLookup({ notion: stub as never, companiesDatabaseId: "x" });
		expect(lookup.companyNameByDomain("ACME.COM")).toBe("Acme");
		expect(lookup.companyNameByDomain(" acme.com ")).toBe("Acme");
	});

	it("skips rows without a domain", async () => {
		const stub = makeStubClient([
			{ id: "p1", properties: { Title: titleProp("Empty"), Domain: richTextProp("") } },
			{ id: "p2", properties: { Title: titleProp("Valid"), Domain: richTextProp("ok.com") } },
		]);
		const lookup = await getCompaniesLookup({ notion: stub as never, companiesDatabaseId: "x" });
		expect(lookup.companyNameByDomain("ok.com")).toBe("Valid");
	});

	it("returns null lookups when the API call throws (resilient)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const stub: StubClient = {
			databases: { retrieve: vi.fn(async () => ({ data_sources: [{ id: "ds-x" }] })) },
			dataSources: { query: vi.fn(async () => { throw new Error("boom"); }) },
		};
		const lookup = await getCompaniesLookup({ notion: stub as never, companiesDatabaseId: "x" });
		expect(lookup.companyNameByDomain("anything.com")).toBeNull();
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
	});

	it("returns null lookups when databases.retrieve fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const stub: StubClient = {
			databases: { retrieve: vi.fn(async () => { throw new Error("not found"); }) },
			dataSources: { query: vi.fn() },
		};
		const lookup = await getCompaniesLookup({ notion: stub as never, companiesDatabaseId: "x" });
		expect(lookup.companyNameByDomain("anything.com")).toBeNull();
		expect(stub.dataSources.query).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
	});

	it("caches the load (second call doesn't re-query)", async () => {
		const stub = makeStubClient([
			{ id: "p", properties: { Title: titleProp("X"), Domain: richTextProp("x.com") } },
		]);
		await getCompaniesLookup({ notion: stub as never, companiesDatabaseId: "ds" });
		await getCompaniesLookup({ notion: stub as never, companiesDatabaseId: "ds" });
		expect(stub.dataSources.query).toHaveBeenCalledTimes(1);
	});
});
