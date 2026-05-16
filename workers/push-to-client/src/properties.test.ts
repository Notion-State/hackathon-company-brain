import { describe, expect, it } from "vitest";

import { MAX_RICH_TEXT_CHARS } from "./markdown.js";
import type { DestSchema } from "./preflight.js";
import { buildProperties, properties, type PushPayload } from "./properties.js";

function schema(overrides: Partial<DestSchema> = {}): DestSchema {
	return {
		dataSourceId: "ds_1",
		hasOriginalDate: true,
		hasOriginUrl: true,
		categoryOptions: new Set(["summary", "action-items"]),
		...overrides,
	};
}

function payload(overrides: Partial<PushPayload> = {}): PushPayload {
	return {
		brainId: "brain-1",
		title: "T",
		source: "Fireflies",
		category: "summary",
		originalDate: "2026-05-15T18:00:00.000Z",
		originUrl: "https://example.com/x",
		bodyMarkdown: null,
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
		expect(properties.select("Fireflies")).toEqual({
			select: { name: "Fireflies" },
		});
	});

	it("date returns date.start", () => {
		expect(properties.date("2026-05-15T18:00:00.000Z")).toEqual({
			date: { start: "2026-05-15T18:00:00.000Z" },
		});
	});

	it("url returns the href", () => {
		expect(properties.url("https://x")).toEqual({ url: "https://x" });
	});

	it("title/richText split content over 2000 chars across multiple items", () => {
		const t = "a".repeat(MAX_RICH_TEXT_CHARS + 50);
		const out = properties.title(t);
		if (!("title" in out)) throw new Error("expected title shape");
		expect(out.title).toHaveLength(2);
	});

	it("empty title produces an empty rich-text array (not omitted)", () => {
		const out = properties.title("");
		if (!("title" in out)) throw new Error("expected title shape");
		expect(out.title).toEqual([]);
	});
});

describe("buildProperties", () => {
	it("includes all required + optional properties when both flags are set", () => {
		const now = new Date("2026-05-16T12:00:00.000Z");
		const out = buildProperties(payload(), schema(), now);
		expect(Object.keys(out).sort()).toEqual(
			["Brain ID", "Category", "Origin URL", "Original Date", "Pushed At", "Source", "Title"],
		);
		expect(out["Pushed At"]).toEqual({ date: { start: now.toISOString() } });
	});

	it("omits Original Date when the payload value is null", () => {
		const out = buildProperties(payload({ originalDate: null }), schema());
		expect(out["Original Date"]).toBeUndefined();
		expect(out["Origin URL"]).toBeDefined();
	});

	it("omits Origin URL when the payload value is null", () => {
		const out = buildProperties(payload({ originUrl: null }), schema());
		expect(out["Origin URL"]).toBeUndefined();
		expect(out["Original Date"]).toBeDefined();
	});

	it("omits optional props when the schema reports them missing", () => {
		const out = buildProperties(
			payload(),
			schema({ hasOriginalDate: false, hasOriginUrl: false }),
		);
		expect(out["Original Date"]).toBeUndefined();
		expect(out["Origin URL"]).toBeUndefined();
	});

	it("always includes Pushed At", () => {
		const out = buildProperties(
			payload({ originalDate: null, originUrl: null }),
			schema({ hasOriginalDate: false, hasOriginUrl: false }),
		);
		expect(out["Pushed At"]).toBeDefined();
	});

	it("emits the right Source select option", () => {
		const out = buildProperties(payload({ source: "Slack" }), schema());
		expect(out.Source).toEqual({ select: { name: "Slack" } });
	});
});
