import { describe, expect, it } from "vitest";

import {
	BRAIN_ID_PROPERTY,
	DOC_TYPES,
	DOC_TYPE_SPECS,
	allPropertySpecs,
	type DocType,
} from "./doc-types.js";

describe("DOC_TYPE_SPECS", () => {
	it("has an entry for every member of DOC_TYPES", () => {
		for (const t of DOC_TYPES) {
			expect(DOC_TYPE_SPECS[t]).toBeDefined();
		}
	});

	it("each spec defines a title-typed title property", () => {
		for (const spec of Object.values(DOC_TYPE_SPECS)) {
			expect(spec.titleProperty.type).toBe("title");
			expect(spec.titleProperty.name.length).toBeGreaterThan(0);
		}
	});

	it("each spec has non-empty required payload fields", () => {
		for (const spec of Object.values(DOC_TYPE_SPECS)) {
			expect(spec.requiredPayloadFields.length).toBeGreaterThan(0);
			expect(spec.requiredPayloadFields).toContain("title");
		}
	});

	it("required payload field 'title' maps to the title property's name (Docs uses File Name)", () => {
		expect(DOC_TYPE_SPECS.Docs.titleProperty.name).toBe("File Name");
		expect(DOC_TYPE_SPECS.StatusUpdate.titleProperty.name).toBe("Title");
		expect(DOC_TYPE_SPECS.Deliverable.titleProperty.name).toBe("Title");
	});

	it("Docs requires Status (status) and Type (select), both with options", () => {
		const required = DOC_TYPE_SPECS.Docs.requiredProperties;
		expect(required.find((p) => p.name === "Status")).toMatchObject({
			type: "status",
			hasOptions: true,
		});
		expect(required.find((p) => p.name === "Type")).toMatchObject({
			type: "select",
			hasOptions: true,
		});
	});

	it("StatusUpdate has Presenter (people) and Addressed (checkbox) as optional", () => {
		const optional = DOC_TYPE_SPECS.StatusUpdate.optionalProperties;
		expect(optional.find((p) => p.name === "Presenter")?.type).toBe("people");
		expect(optional.find((p) => p.name === "Addressed")?.type).toBe("checkbox");
	});

	it("Deliverable requires Status (status, with options) and Timeline (date)", () => {
		const required = DOC_TYPE_SPECS.Deliverable.requiredProperties;
		expect(required.find((p) => p.name === "Status")).toMatchObject({
			type: "status",
			hasOptions: true,
		});
		expect(required.find((p) => p.name === "Timeline")?.type).toBe("date");
	});
});

describe("allPropertySpecs", () => {
	it("returns the title spec first, then required, then optional, tagged with kind", () => {
		const all = allPropertySpecs(DOC_TYPE_SPECS.StatusUpdate);
		expect(all[0]).toMatchObject({ name: "Title", kind: "title" });
		const requiredEntries = all.filter((p) => p.kind === "required");
		const optionalEntries = all.filter((p) => p.kind === "optional");
		expect(requiredEntries.map((p) => p.name).sort()).toEqual(["Date", "Summary"]);
		expect(optionalEntries.map((p) => p.name).sort()).toEqual(["Addressed", "Presenter"]);
	});
});

describe("BRAIN_ID_PROPERTY", () => {
	it("is the augmentation property name", () => {
		expect(BRAIN_ID_PROPERTY).toBe("Brain ID");
	});

	it("is not part of any canonical spec (it's our augmentation)", () => {
		const types: DocType[] = ["Docs", "StatusUpdate", "Deliverable"];
		for (const t of types) {
			const all = allPropertySpecs(DOC_TYPE_SPECS[t]);
			expect(all.find((p) => p.name === BRAIN_ID_PROPERTY)).toBeUndefined();
		}
	});
});
