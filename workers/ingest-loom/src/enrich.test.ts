import { describe, expect, it } from "vitest";

import {
	composeEnrichment,
	formatDuration,
	formatTimestamp,
	mergeFields,
	pickStatus,
	renderVideoMarkdown,
} from "./enrich.js";
import type { GraphQLResult, OEmbedResult, SharePageResult } from "./loom.js";
import type { SourceVideoRow } from "./source-db.js";

const NOW = new Date("2026-05-16T12:00:00.000Z");

const SOURCE: SourceVideoRow = {
	pageId: "page-1",
	pageUrl: "https://www.notion.so/page-1",
	videoUrl: "https://www.loom.com/share/abc123def456abc123def456",
	lastEditedTime: "2026-05-16T10:00:00.000Z",
};

const OEMBED_OK: OEmbedResult = {
	status: "ok",
	title: "Product walkthrough",
	thumbnailUrl: "https://cdn.loom.com/sessions/thumbnails/abc.jpg",
	durationSeconds: 225,
	authorName: "Alex Lee",
};

const SCRAPE_OK: SharePageResult = {
	status: "ok",
	title: "Product walkthrough",
	description: "Quick demo of the new dashboard.",
	thumbnailUrl: "https://cdn.loom.com/sessions/thumbnails/scrape.jpg",
	uploadDate: "2026-04-12T15:30:00.000Z",
	durationSeconds: 225,
};

const GRAPHQL_OK: GraphQLResult = {
	status: "ok",
	ownerName: "Alex Lee",
	ownerEmail: "alex@notionstate.com",
	createdAt: "2026-04-12T15:30:00.000Z",
	viewCount: 142,
	commentCount: 3,
	transcript: [
		{ startSeconds: 0, text: "Hey team.", speaker: "Alex Lee" },
		{ startSeconds: 12, text: "Here's the new filters panel." },
	],
};

describe("pickStatus", () => {
	it("returns Private when oEmbed is private", () => {
		expect(pickStatus({ status: "private" }, { status: "ok" } as SharePageResult)).toBe("Private");
	});

	it("returns Private when share page is private (and oEmbed failed)", () => {
		expect(
			pickStatus({ status: "failed", error: "boom" }, { status: "private" }),
		).toBe("Private");
	});

	it("returns Unavailable when only an unavailable signal is present", () => {
		expect(
			pickStatus({ status: "unavailable" }, { status: "failed", error: "boom" }),
		).toBe("Unavailable");
	});

	it("returns Enriched when oEmbed succeeded but share page failed", () => {
		expect(pickStatus(OEMBED_OK, { status: "failed", error: "timeout" })).toBe("Enriched");
	});

	it("returns Enriched when share page succeeded but oEmbed failed", () => {
		expect(pickStatus({ status: "failed", error: "timeout" }, SCRAPE_OK)).toBe("Enriched");
	});

	it("returns Failed when everything errored", () => {
		expect(
			pickStatus({ status: "failed", error: "x" }, { status: "failed", error: "y" }),
		).toBe("Failed");
	});

	it("does not consider GraphQL status when picking the row status", () => {
		// GraphQL is best-effort; it should not downgrade a row to Failed when
		// Core metadata loaded cleanly. pickStatus has no graphql arg, so the
		// invariant is structural — verify by composing with a failed GraphQL.
		const out = composeEnrichment({
			source: SOURCE,
			videoId: "abc123",
			oembed: OEMBED_OK,
			scrape: SCRAPE_OK,
			graphql: { status: "failed", error: "schema drift" },
			now: NOW,
		});
		expect(out.syncStatus).toBe("Enriched");
	});
});

describe("mergeFields", () => {
	it("prefers oEmbed for title and thumbnail; falls back to scrape", () => {
		const merged = mergeFields({
			source: SOURCE,
			videoId: "abc123",
			oembed: { ...OEMBED_OK, title: "OEmbed wins" },
			scrape: { ...SCRAPE_OK, title: "Scrape loses", thumbnailUrl: "scrape-fallback" },
			graphql: { status: "skipped" },
			now: NOW,
		});
		expect(merged.title).toBe("OEmbed wins");
		expect(merged.thumbnailUrl).toBe(OEMBED_OK.thumbnailUrl);
	});

	it("falls back to scrape title when oEmbed failed", () => {
		const merged = mergeFields({
			source: SOURCE,
			videoId: "abc123",
			oembed: { status: "failed", error: "boom" },
			scrape: SCRAPE_OK,
			graphql: { status: "skipped" },
			now: NOW,
		});
		expect(merged.title).toBe(SCRAPE_OK.title);
	});

	it("uses static fallback when both fail", () => {
		const merged = mergeFields({
			source: SOURCE,
			videoId: "abc123",
			oembed: { status: "failed", error: "x" },
			scrape: { status: "failed", error: "y" },
			graphql: { status: "failed", error: "z" },
			now: NOW,
		});
		expect(merged.title).toBe("Untitled Loom video");
	});

	it("prefers GraphQL owner over oEmbed author_name", () => {
		const merged = mergeFields({
			source: SOURCE,
			videoId: "abc123",
			oembed: { ...OEMBED_OK, authorName: "OEmbed Author" },
			scrape: SCRAPE_OK,
			graphql: { ...GRAPHQL_OK, ownerName: "GraphQL Owner" },
			now: NOW,
		});
		expect(merged.ownerName).toBe("GraphQL Owner");
	});

	it("uses oEmbed author_name when GraphQL is unavailable", () => {
		const merged = mergeFields({
			source: SOURCE,
			videoId: "abc123",
			oembed: OEMBED_OK,
			scrape: SCRAPE_OK,
			graphql: { status: "skipped" },
			now: NOW,
		});
		expect(merged.ownerName).toBe("Alex Lee");
		expect(merged.ownerEmail).toBeNull();
	});
});

describe("composeEnrichment", () => {
	it("produces a full property set when all sources succeed", () => {
		const out = composeEnrichment({
			source: SOURCE,
			videoId: "abc123def456abc123def456",
			oembed: OEMBED_OK,
			scrape: SCRAPE_OK,
			graphql: GRAPHQL_OK,
			now: NOW,
		});
		expect(out.syncStatus).toBe("Enriched");
		expect(out.properties["Title"]).toBeDefined();
		expect(out.properties["Source Page ID"]).toBeDefined();
		expect(out.properties["Sync Status"]).toBeDefined();
		expect(out.properties["Owner Email"]).toBeDefined();
		expect(out.properties["View Count"]).toBeDefined();
	});

	it("marks Sync Status = Private and still emits a row when video is private", () => {
		const out = composeEnrichment({
			source: SOURCE,
			videoId: "abc123def456abc123def456",
			oembed: { status: "private" },
			scrape: { status: "private" },
			graphql: { status: "skipped" },
			now: NOW,
		});
		expect(out.syncStatus).toBe("Private");
		expect(out.pageContentMarkdown).toContain("Status: Private");
	});

	it("works when videoId is null (URL didn't parse)", () => {
		const out = composeEnrichment({
			source: { ...SOURCE, videoUrl: "https://example.com/not-loom" },
			videoId: null,
			oembed: { status: "failed", error: "unparseable url" },
			scrape: { status: "failed", error: "wrong host" },
			graphql: { status: "skipped" },
			now: NOW,
		});
		expect(out.syncStatus).toBe("Failed");
	});

	it("renders transcript cues with timestamps when GraphQL provides them", () => {
		const out = composeEnrichment({
			source: SOURCE,
			videoId: "abc123def456abc123def456",
			oembed: OEMBED_OK,
			scrape: SCRAPE_OK,
			graphql: GRAPHQL_OK,
			now: NOW,
		});
		expect(out.pageContentMarkdown).toMatch(/\[0:00\].*Alex Lee.*Hey team\./);
		expect(out.pageContentMarkdown).toMatch(/\[0:12\].*filters panel/);
	});

	it("falls back to '_Transcript not available._' when transcript is missing", () => {
		const out = composeEnrichment({
			source: SOURCE,
			videoId: "abc123def456abc123def456",
			oembed: OEMBED_OK,
			scrape: SCRAPE_OK,
			graphql: { status: "skipped" },
			now: NOW,
		});
		expect(out.pageContentMarkdown).toContain("_Transcript not available._");
	});
});

describe("renderVideoMarkdown", () => {
	it("includes a status banner only when status is not Enriched", () => {
		const enriched = renderVideoMarkdown({
			title: "Test",
			ownerName: null,
			ownerEmail: null,
			uploadDate: null,
			durationSeconds: null,
			viewCount: null,
			commentCount: null,
			sourcePageUrl: "https://notion.so/page",
			videoUrl: "https://loom.com/share/abc",
			description: null,
			transcript: null,
			status: "Enriched",
		});
		expect(enriched).not.toContain("Status:");

		const failed = renderVideoMarkdown({
			title: "Test",
			ownerName: null,
			ownerEmail: null,
			uploadDate: null,
			durationSeconds: null,
			viewCount: null,
			commentCount: null,
			sourcePageUrl: "https://notion.so/page",
			videoUrl: "https://loom.com/share/abc",
			description: null,
			transcript: null,
			status: "Failed",
		});
		expect(failed).toContain("Status: Failed");
	});
});

describe("formatDuration", () => {
	it("formats sub-hour durations as M:SS", () => {
		expect(formatDuration(0)).toBe("0:00");
		expect(formatDuration(12)).toBe("0:12");
		expect(formatDuration(75)).toBe("1:15");
	});

	it("formats hour+ durations as H:MM:SS", () => {
		expect(formatDuration(3661)).toBe("1:01:01");
	});

	it("rounds fractional seconds", () => {
		expect(formatDuration(12.6)).toBe("0:13");
	});

	it("treats negative durations as 0", () => {
		expect(formatDuration(-5)).toBe("0:00");
	});
});

describe("formatTimestamp", () => {
	it("delegates to formatDuration", () => {
		expect(formatTimestamp(225)).toBe("3:45");
	});
});
