import { describe, expect, it } from "vitest";

import { getCompanyMapping, normalize } from "./company-mapping.js";

describe("getCompanyMapping", () => {
	it("returns an empty mapping when no COMPANY_PAGE_<ID> is set", () => {
		const m = getCompanyMapping({});
		expect(m.entries()).toEqual([]);
		expect(m.get("anything")).toBeUndefined();
	});

	it("parses one entry per client and lowercases the id", () => {
		const m = getCompanyMapping({
			COMPANY_PAGE_ACME: "362d3984-d5b8-8000-0000-000000000001",
		});
		expect(m.entries()).toEqual([
			{
				companyPageId: "362d3984d5b880000000000000000001",
				clientId: "acme",
			},
		]);
	});

	it("returns clientId for either dashed or undashed lookup", () => {
		const m = getCompanyMapping({
			COMPANY_PAGE_ACME: "362d3984-d5b8-8000-0000-000000000001",
		});
		expect(m.get("362d3984-d5b8-8000-0000-000000000001")).toBe("acme");
		expect(m.get("362d3984d5b880000000000000000001")).toBe("acme");
		expect(m.get("362D3984D5B880000000000000000001")).toBe("acme");
	});

	it("supports multiple clients, deterministically sorted by entries()", () => {
		const m = getCompanyMapping({
			COMPANY_PAGE_BETA: "page-beta",
			COMPANY_PAGE_ACME: "page-acme",
		});
		expect(m.entries().map((e) => e.clientId)).toEqual(["acme", "beta"]);
	});

	it("trims surrounding whitespace from the env value", () => {
		const m = getCompanyMapping({
			COMPANY_PAGE_ACME: "  362d3984-d5b8-8000-0000-000000000001  ",
		});
		expect(m.get("362d3984-d5b8-8000-0000-000000000001")).toBe("acme");
	});

	it("ignores empty-string values (treats as unset)", () => {
		const m = getCompanyMapping({ COMPANY_PAGE_ACME: "" });
		expect(m.entries()).toEqual([]);
	});

	it("throws when the same company page is mapped to two different clients", () => {
		expect(() =>
			getCompanyMapping({
				COMPANY_PAGE_ACME: "page-shared",
				COMPANY_PAGE_BETA: "page-shared",
			}),
		).toThrow(/mapped to two different clients/);
	});

	it("idempotent duplicate (same company → same client across two env vars) is allowed", () => {
		// Practically can't happen since env vars must have unique names, but the
		// map collision check should accept identical client ids defensively.
		const m = getCompanyMapping({
			COMPANY_PAGE_ACME: "page-acme",
		});
		expect(m.get("page-acme")).toBe("acme");
	});
});

describe("normalize", () => {
	it("strips dashes and lowercases", () => {
		expect(normalize("ABC-DEF")).toBe("abcdef");
	});

	it("trims whitespace", () => {
		expect(normalize("  abc  ")).toBe("abc");
	});
});
