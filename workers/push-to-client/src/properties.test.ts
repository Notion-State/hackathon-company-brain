import { describe, expect, it } from "vitest";

import { BRAIN_ID_PROPERTY } from "./doc-types.js";
import { MAX_RICH_TEXT_CHARS } from "./markdown.js";
import type { DestSchema } from "./preflight.js";
import {
	buildPropertiesFor,
	properties,
	type PushPayload,
} from "./properties.js";

function schema(overrides: Partial<DestSchema> = {}): DestSchema {
	return {
		dataSourceId: "ds_1",
		statusOptions: new Set(),
		typeOptions: new Set(),
		optionalPropertiesPresent: { Presenter: false, Addressed: false },
		...overrides,
	};
}

describe("properties builders", () => {
	it("title returns the expected shape", () => {
		expect(properties.title("hello")).toEqual({
			title: [{ text: { content: "hello", link: null } }],
		});
	});

	it("richText returns rich_text shape", () => {
		expect(properties.richText("hi")).toEqual({
			rich_text: [{ text: { content: "hi", link: null } }],
		});
	});

	it("select returns select.name", () => {
		expect(properties.select("Contract")).toEqual({ select: { name: "Contract" } });
	});

	it("status returns status.name", () => {
		expect(properties.status("Drafting")).toEqual({ status: { name: "Drafting" } });
	});

	it("date returns date.start", () => {
		expect(properties.date("2026-05-15T18:00:00.000Z")).toEqual({
			date: { start: "2026-05-15T18:00:00.000Z" },
		});
	});

	it("dateRange returns date.start with optional end", () => {
		expect(properties.dateRange("2026-05-15")).toEqual({
			date: { start: "2026-05-15" },
		});
		expect(properties.dateRange("2026-05-15", "2026-06-01")).toEqual({
			date: { start: "2026-05-15", end: "2026-06-01" },
		});
	});

	it("dateRange ignores empty / null end values", () => {
		expect(properties.dateRange("2026-05-15", "")).toEqual({
			date: { start: "2026-05-15" },
		});
		expect(properties.dateRange("2026-05-15", null)).toEqual({
			date: { start: "2026-05-15" },
		});
	});

	it("checkbox returns the boolean", () => {
		expect(properties.checkbox(true)).toEqual({ checkbox: true });
		expect(properties.checkbox(false)).toEqual({ checkbox: false });
	});

	it("url returns the href", () => {
		expect(properties.url("https://x")).toEqual({ url: "https://x" });
	});

	it("people returns one entry per user id", () => {
		const v = properties.people(["u1", "u2"]);
		expect(v).toEqual({
			people: [
				{ id: "u1", object: "user" },
				{ id: "u2", object: "user" },
			],
		});
	});

	it("title/richText split content over 2000 chars across multiple items", () => {
		const t = "a".repeat(MAX_RICH_TEXT_CHARS + 50);
		const out = properties.title(t);
		if (!("title" in out)) throw new Error("expected title shape");
		expect(out.title).toHaveLength(2);
	});
});

describe("buildPropertiesFor — Docs", () => {
	function payload(overrides: Partial<Extract<PushPayload, { docType: "Docs" }>> = {}): PushPayload {
		return {
			docType: "Docs",
			brainId: "brain-1",
			title: "Doc Title",
			type: "Contract",
			status: "Drafting",
			...overrides,
		};
	}

	it("emits File Name + Brain ID + Status + Type, no extras", () => {
		const out = buildPropertiesFor(payload(), schema());
		expect(Object.keys(out).sort()).toEqual(["Brain ID", "File Name", "Status", "Type"]);
		expect(out.Status).toEqual({ status: { name: "Drafting" } });
		expect(out.Type).toEqual({ select: { name: "Contract" } });
	});
});

describe("buildPropertiesFor — StatusUpdate", () => {
	function payload(
		overrides: Partial<Extract<PushPayload, { docType: "StatusUpdate" }>> = {},
	): PushPayload {
		return {
			docType: "StatusUpdate",
			brainId: "brain-1",
			title: "Status Update @Next Monday",
			date: "2026-05-18",
			summary: "Hello",
			...overrides,
		};
	}

	it("emits Title + Brain ID + Date + Summary by default; no Presenter/Addressed when destination lacks them", () => {
		const out = buildPropertiesFor(payload(), schema());
		expect(Object.keys(out).sort()).toEqual(["Brain ID", "Date", "Summary", "Title"]);
	});

	it("includes Presenter when destination has it AND presenterUserId is provided", () => {
		const out = buildPropertiesFor(
			payload({ presenterEmail: "p@x.com" }),
			schema({ optionalPropertiesPresent: { Presenter: true, Addressed: false } }),
			"user_123",
		);
		expect(out.Presenter).toEqual({
			people: [{ id: "user_123", object: "user" }],
		});
	});

	it("omits Presenter when destination has it but presenterUserId is undefined (resolution failed)", () => {
		const out = buildPropertiesFor(
			payload({ presenterEmail: "p@x.com" }),
			schema({ optionalPropertiesPresent: { Presenter: true, Addressed: false } }),
			undefined,
		);
		expect(out.Presenter).toBeUndefined();
	});

	it("includes Addressed when both destination and payload have it", () => {
		const out = buildPropertiesFor(
			payload({ addressed: true }),
			schema({ optionalPropertiesPresent: { Presenter: false, Addressed: true } }),
		);
		expect(out.Addressed).toEqual({ checkbox: true });
	});

	it("omits Addressed when payload value is null even if destination has the property", () => {
		const out = buildPropertiesFor(
			payload({ addressed: null }),
			schema({ optionalPropertiesPresent: { Presenter: false, Addressed: true } }),
		);
		expect(out.Addressed).toBeUndefined();
	});
});

describe("buildPropertiesFor — Deliverable", () => {
	function payload(
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

	it("emits Title + Brain ID + Status + Timeline + Owner (empty) when no ownerUserId", () => {
		const out = buildPropertiesFor(payload(), schema());
		expect(Object.keys(out).sort()).toEqual([
			"Brain ID",
			"Owner",
			"Status",
			"Timeline",
			"Title",
		]);
		expect(out.Timeline).toEqual({ date: { start: "2026-05-15" } });
		expect(out.Status).toEqual({ status: { name: "In Progress" } });
		expect(out.Owner).toEqual({ people: [] });
	});

	it("emits Timeline with end when timelineEnd is set", () => {
		const out = buildPropertiesFor(
			payload({ timelineEnd: "2026-06-30" }),
			schema(),
		);
		expect(out.Timeline).toEqual({
			date: { start: "2026-05-15", end: "2026-06-30" },
		});
	});

	it("populates Owner.people when ownerUserId is provided", () => {
		const out = buildPropertiesFor(
			payload({ ownerEmail: "dri@x.com" }),
			schema(),
			undefined,
			"user_dri",
		);
		expect(out.Owner).toEqual({
			people: [{ id: "user_dri", object: "user" }],
		});
	});

	it("emits empty Owner array when ownerUserId is undefined (resolution failed or empty DRI)", () => {
		const out = buildPropertiesFor(
			payload({ ownerEmail: "dri@x.com" }),
			schema(),
			undefined,
			undefined,
		);
		expect(out.Owner).toEqual({ people: [] });
	});
});
