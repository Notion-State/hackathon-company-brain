import { describe, expect, it } from "vitest";
import {
	findTitle,
	readFormula,
	readPeople,
	readSelect,
	readStatus,
	readUniqueId,
	readUrl,
	recordId,
	renderPageMarkdown,
	toChangeProperties,
} from "./render.js";
import {
	formulaProp,
	makePage,
	peopleProp,
	personUser,
	richText,
	selectProp,
	statusProp,
	title,
	uniqueIdProp,
	urlProp,
} from "./fixtures/pages.js";

const NOW = new Date("2026-05-16T12:00:00.000Z");

describe("recordId", () => {
	it("joins clientId and pageId with a colon", () => {
		expect(recordId("acme", "abc-123")).toBe("acme:abc-123");
	});
});

describe("findTitle", () => {
	it("finds the title regardless of the property name", () => {
		const page = makePage({ "Anything Here": title("Build feature X") });
		expect(findTitle(page.properties)).toBe("Build feature X");
	});

	it("returns empty when title is empty rich_text", () => {
		const page = makePage({ Name: title("   ") });
		expect(findTitle(page.properties)).toBe("");
	});

	it("returns empty when no title-typed property exists", () => {
		const page = makePage({ Name: richText("not a title") });
		expect(findTitle(page.properties)).toBe("");
	});
});

describe("readers", () => {
	it("readSelect returns the option name or empty", () => {
		expect(readSelect(selectProp("High"))).toBe("High");
		expect(readSelect(selectProp(null))).toBe("");
		expect(readSelect(richText("not select"))).toBe("");
		expect(readSelect(undefined)).toBe("");
	});

	it("readStatus returns the status name or empty", () => {
		expect(readStatus(statusProp("Planned"))).toBe("Planned");
		expect(readStatus(statusProp(null))).toBe("");
		expect(readStatus(undefined)).toBe("");
	});

	it("readUrl returns the URL or empty", () => {
		expect(readUrl(urlProp("https://x.test"))).toBe("https://x.test");
		expect(readUrl(urlProp(null))).toBe("");
		expect(readUrl(undefined)).toBe("");
	});

	it("readUniqueId formats prefix-number, or #number when no prefix", () => {
		expect(readUniqueId(uniqueIdProp("FR", 42))).toBe("FR-42");
		expect(readUniqueId(uniqueIdProp(null, 42))).toBe("#42");
		expect(readUniqueId(uniqueIdProp("FR", null))).toBe("");
		expect(readUniqueId(undefined)).toBe("");
	});

	it("readFormula coerces string formulas", () => {
		expect(readFormula(formulaProp("Computed"))).toBe("Computed");
		expect(readFormula(undefined)).toBe("");
	});

	it("readPeople serializes 'Name <email>' for person users with email", () => {
		expect(
			readPeople(peopleProp([personUser("Alice", "alice@test.com", "u1")])),
		).toBe("Alice <alice@test.com>");
	});

	it("readPeople joins multiple users with comma", () => {
		expect(
			readPeople(
				peopleProp([
					personUser("Alice", "alice@test.com", "u1"),
					personUser("Bob", undefined, "u2"),
				]),
			),
		).toBe("Alice <alice@test.com>, Bob");
	});

	it("readPeople drops users without a name", () => {
		expect(
			readPeople(
				peopleProp([
					personUser(null, "a@t.com", "u1"),
					personUser("Bob", undefined, "u2"),
				]),
			),
		).toBe("Bob");
	});

	it("readPeople sanitizes commas and angle brackets in names/emails", () => {
		// Commas/angle brackets in source text would corrupt the comma-joined `Name <email>`
		// shape. We replace them with spaces and collapse consecutive whitespace.
		expect(
			readPeople(
				peopleProp([personUser("Alice, the Great", "weird<x>@t.com", "u1")]),
			),
		).toBe("Alice the Great <weird x @t.com>");
	});

	it("readPeople returns empty for non-people properties", () => {
		expect(readPeople(richText("text"))).toBe("");
		expect(readPeople(undefined)).toBe("");
	});
});

describe("toChangeProperties", () => {
	it("emits every schema property even when the source has nothing", () => {
		const page = makePage({});
		const out = toChangeProperties(page, "acme", NOW);
		// Spot-check: every expected key is present (whatever the value is).
		const requiredKeys = [
			"Title", "Record ID", "Client", "Source", "Source Page ID",
			"Source Unique ID", "Source URL", "Description", "Status",
			"Priority", "Complexity", "Effort", "Projection", "Type",
			"Team", "Dependencies", "Assigned Owner", "Submitter", "POC",
			"Support Owner", "Technical Lead", "Proposed Owner",
			"Source Created Time", "Source Last Edited Time", "Synced At",
		];
		for (const k of requiredKeys) {
			expect(out).toHaveProperty(k);
		}
	});

	it("falls back to 'Untitled feature request' when source has no title", () => {
		const page = makePage({});
		const out = toChangeProperties(page, "acme", NOW);
		expect(JSON.stringify(out.Title)).toContain("Untitled feature request");
	});

	it("falls back Status to Triage when source has no Status", () => {
		const page = makePage({ Name: title("X") });
		const out = toChangeProperties(page, "acme", NOW);
		expect(JSON.stringify(out.Status)).toContain("Triage");
	});

	it("builds the composite Record ID from clientId and page.id", () => {
		const page = makePage({ Name: title("X") }, { id: "page-7" });
		const out = toChangeProperties(page, "acme", NOW);
		expect(JSON.stringify(out["Record ID"])).toContain("acme:page-7");
	});

	it("maps source schema properties to the canonical internal layout", () => {
		const page = makePage(
			{
				Name: title("Implement onboarding flow"),
				ID: uniqueIdProp("FR", 7),
				Description: richText("Needs SSO integration."),
				Status: statusProp("Planned"),
				Submitter: peopleProp([personUser("Sam", "sam@t.com", "u1")]),
				Priority: selectProp("High"),
				Complexity: selectProp("Medium"),
				Effort: selectProp("Low"),
				Projection: selectProp("Company"),
				Type: selectProp("Support & Maintenance"),
				Team: richText("Platform"),
				Dependencies: richText("blocked by API rollout"),
				"Assigned Owner": selectProp("Aduro"),
				POC: peopleProp([personUser("Pat", undefined, "u2")]),
				"Proposed Owner": formulaProp("Aduro"),
				"Support Owner": peopleProp([personUser("Sue", "sue@t.com", "u3")]),
				"Technical Lead": peopleProp([personUser("Ty", "ty@t.com", "u4")]),
			},
			{ id: "page-1", url: "https://notion.so/page-1" },
		);
		const out = toChangeProperties(page, "acme", NOW);
		expect(JSON.stringify(out.Title)).toContain("Implement onboarding flow");
		expect(JSON.stringify(out["Source Unique ID"])).toContain("FR-7");
		expect(JSON.stringify(out.Description)).toContain("Needs SSO integration.");
		expect(JSON.stringify(out.Status)).toContain("Planned");
		expect(JSON.stringify(out.Submitter)).toContain("Sam <sam@t.com>");
		expect(JSON.stringify(out.Priority)).toContain("High");
		expect(JSON.stringify(out.Type)).toContain("Support & Maintenance");
		expect(JSON.stringify(out["Proposed Owner"])).toContain("Aduro");
	});
});

describe("renderPageMarkdown", () => {
	it("composes a header, description section, and page content section", () => {
		const page = makePage(
			{
				Name: title("Build X"),
				Description: richText("Some description"),
				Status: statusProp("Planned"),
				Priority: selectProp("High"),
			},
			{ id: "page-1", url: "https://notion.so/page-1" },
		);
		const md = renderPageMarkdown(page, "BODY_BLOCKS", "acme");
		expect(md).toContain("# Build X");
		expect(md).toContain("**Client:** acme");
		expect(md).toContain("**Status:** Planned");
		expect(md).toContain("**Priority:** High");
		expect(md).toContain("**Source:** https://notion.so/page-1");
		expect(md).toContain("## Description property");
		expect(md).toContain("Some description");
		expect(md).toContain("## Page content");
		expect(md).toContain("BODY_BLOCKS");
	});

	it("uses fallbacks when properties are missing", () => {
		const page = makePage({});
		const md = renderPageMarkdown(page, "", "acme");
		expect(md).toContain("Untitled feature request");
		expect(md).toContain("(no status)");
		expect(md).toContain("(no priority)");
		expect(md).toContain("_No description property._");
		expect(md).toContain("_No page content._");
	});

	it("escapes markdown specials in source title and description", () => {
		const page = makePage({
			Name: title("**not bold**"),
			Description: richText("[link](u) #hash"),
		});
		const md = renderPageMarkdown(page, "", "acme");
		expect(md).toContain("\\*\\*not bold\\*\\*");
		expect(md).toContain("\\[link\\](u) \\#hash");
	});
});
