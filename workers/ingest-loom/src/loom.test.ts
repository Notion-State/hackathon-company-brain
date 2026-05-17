import { describe, expect, it, vi } from "vitest";

import { GRAPHQL_ERROR, GRAPHQL_NO_CAPTIONS, GRAPHQL_OK } from "./fixtures/graphql-response.js";
import { OEMBED_OK } from "./fixtures/oembed-response.js";
import {
	SHARE_PAGE_FULL,
	SHARE_PAGE_MALFORMED_JSONLD,
	SHARE_PAGE_NESTED_JSONLD,
	SHARE_PAGE_OG_ONLY,
	SHARE_PAGE_REVERSED_META,
} from "./fixtures/share-page-html.js";
import {
	createLoomClient,
	normalizeGraphqlResponse,
	parseIso8601Duration,
	parseSharePageHtml,
	parseVideoId,
} from "./loom.js";

const noopPacer = { wait: async () => undefined };

describe("parseVideoId", () => {
	it("parses /share/<id> URLs", () => {
		expect(parseVideoId("https://www.loom.com/share/abc123def456abc123def456")).toBe(
			"abc123def456abc123def456",
		);
	});

	it("parses /embed/<id> URLs", () => {
		expect(parseVideoId("https://loom.com/embed/abc123def456abc123def456")).toBe(
			"abc123def456abc123def456",
		);
	});

	it("tolerates trailing query strings and fragments", () => {
		expect(parseVideoId("https://www.loom.com/share/abc123def456abc123def456?sid=foo#bar")).toBe(
			"abc123def456abc123def456",
		);
	});

	it("lowercases mixed-case ids", () => {
		expect(parseVideoId("https://www.loom.com/share/AbC123dEf456AbC123dEf456")).toBe(
			"abc123def456abc123def456",
		);
	});

	it("returns null for non-Loom URLs", () => {
		expect(parseVideoId("https://example.com/share/abc123")).toBeNull();
		expect(parseVideoId("https://evil-loom.com/share/abc123def456abc123def456")).toBeNull();
	});

	it("returns null for Loom URLs that don't match the share/embed path", () => {
		expect(parseVideoId("https://www.loom.com/looms")).toBeNull();
		expect(parseVideoId("https://www.loom.com/share/")).toBeNull();
	});

	it("returns null for non-URL input", () => {
		expect(parseVideoId("not a url")).toBeNull();
		expect(parseVideoId("")).toBeNull();
	});
});

describe("parseIso8601Duration", () => {
	it("parses minutes + seconds", () => {
		expect(parseIso8601Duration("PT3M45S")).toBe(225);
	});

	it("parses hours + minutes + seconds", () => {
		expect(parseIso8601Duration("PT1H2M3S")).toBe(3723);
	});

	it("parses seconds only", () => {
		expect(parseIso8601Duration("PT45S")).toBe(45);
	});

	it("rounds fractional seconds", () => {
		expect(parseIso8601Duration("PT12.6S")).toBe(13);
	});

	it("returns null for unparseable input", () => {
		expect(parseIso8601Duration("garbage")).toBeNull();
		expect(parseIso8601Duration(null)).toBeNull();
	});

	it("returns null for zero duration", () => {
		expect(parseIso8601Duration("PT0S")).toBeNull();
	});
});

describe("parseSharePageHtml", () => {
	it("extracts everything when OG + JSON-LD are both present", () => {
		const r = parseSharePageHtml(SHARE_PAGE_FULL);
		if (r.status !== "ok") throw new Error("expected ok");
		expect(r.title).toBe("Product walkthrough");
		expect(r.description).toContain("filters panel");
		expect(r.thumbnailUrl).toBe(
			"https://cdn.loom.com/sessions/thumbnails/abc123-with-play.jpg",
		);
		expect(r.uploadDate).toBe("2026-04-12T15:30:00.000Z");
		// JSON-LD says 3m45s = 225; matches og:video:duration 225.
		expect(r.durationSeconds).toBe(225);
	});

	it("falls back to OG-only when JSON-LD is absent", () => {
		const r = parseSharePageHtml(SHARE_PAGE_OG_ONLY);
		if (r.status !== "ok") throw new Error("expected ok");
		expect(r.title).toBe("Untitled but tagged");
		expect(r.description).toBe("No JSON-LD on this page.");
		expect(r.uploadDate).toBeNull();
		expect(r.durationSeconds).toBeNull();
	});

	it("handles reversed meta attribute order and name= variants", () => {
		const r = parseSharePageHtml(SHARE_PAGE_REVERSED_META);
		if (r.status !== "ok") throw new Error("expected ok");
		expect(r.title).toBe("Reversed attribute order works too");
		expect(r.description).toBe("Some HTML emits name= instead of property=.");
	});

	it("digs into @graph wrappers for the VideoObject", () => {
		const r = parseSharePageHtml(SHARE_PAGE_NESTED_JSONLD);
		if (r.status !== "ok") throw new Error("expected ok");
		expect(r.title).toBe("Nested video object");
		expect(r.thumbnailUrl).toBe("https://cdn.loom.com/sessions/thumbnails/nested.jpg");
		expect(r.uploadDate).toBe("2026-01-01");
		expect(r.durationSeconds).toBe(45);
	});

	it("survives malformed JSON-LD by falling back to OG", () => {
		const r = parseSharePageHtml(SHARE_PAGE_MALFORMED_JSONLD);
		if (r.status !== "ok") throw new Error("expected ok");
		expect(r.title).toBe("Survives malformed JSON-LD");
		expect(r.uploadDate).toBeNull();
	});
});

describe("normalizeGraphqlResponse", () => {
	it("normalizes a complete response", () => {
		const r = normalizeGraphqlResponse(GRAPHQL_OK);
		if (r.status !== "ok") throw new Error("expected ok");
		expect(r.ownerName).toBe("Alex Lee");
		expect(r.ownerEmail).toBe("alex@notionstate.com");
		expect(r.createdAt).toBe("2026-04-12T15:30:00.000Z");
		expect(r.viewCount).toBe(142);
		expect(r.commentCount).toBe(3);
		expect(r.transcript).toHaveLength(3);
		expect(r.transcript![0]).toEqual({
			startSeconds: 0,
			text: "Hey team, quick walkthrough.",
			speaker: "Alex Lee",
		});
	});

	it("returns failed when the response carries errors", () => {
		const r = normalizeGraphqlResponse(GRAPHQL_ERROR);
		expect(r.status).toBe("failed");
		if (r.status !== "failed") throw new Error("expected failed");
		expect(r.error).toContain("Cannot query field");
	});

	it("returns ok with null transcript when captions are missing", () => {
		const r = normalizeGraphqlResponse(GRAPHQL_NO_CAPTIONS);
		if (r.status !== "ok") throw new Error("expected ok");
		expect(r.transcript).toBeNull();
		expect(r.viewCount).toBe(1);
	});

	it("returns failed for non-object input", () => {
		expect(normalizeGraphqlResponse(null).status).toBe("failed");
		expect(normalizeGraphqlResponse(42).status).toBe("failed");
		expect(normalizeGraphqlResponse({ no: "data" }).status).toBe("failed");
	});
});

describe("createLoomClient — oEmbed status mapping", () => {
	function mockFetch(handler: (input: string) => Response) {
		return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
			const url = typeof input === "string" ? input : input.toString();
			return handler(url);
		}) as unknown as typeof fetch;
	}

	it("returns ok for a 200 oEmbed body", async () => {
		const client = createLoomClient({
			oembedPacer: noopPacer,
			pagePacer: noopPacer,
			graphqlPacer: noopPacer,
			enableGraphql: false,
			fetchImpl: mockFetch(
				() =>
					new Response(JSON.stringify(OEMBED_OK), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			),
		});
		const r = await client.fetchOEmbed("https://www.loom.com/share/abc123def456abc123def456");
		if (r.status !== "ok") throw new Error("expected ok");
		expect(r.title).toBe("Product walkthrough");
		expect(r.durationSeconds).toBe(225);
	});

	it("returns private on 403", async () => {
		const client = createLoomClient({
			oembedPacer: noopPacer,
			pagePacer: noopPacer,
			graphqlPacer: noopPacer,
			enableGraphql: false,
			fetchImpl: mockFetch(() => new Response("", { status: 403 })),
		});
		const r = await client.fetchOEmbed("https://www.loom.com/share/abc123def456abc123def456");
		expect(r.status).toBe("private");
	});

	it("returns unavailable on 404", async () => {
		const client = createLoomClient({
			oembedPacer: noopPacer,
			pagePacer: noopPacer,
			graphqlPacer: noopPacer,
			enableGraphql: false,
			fetchImpl: mockFetch(() => new Response("", { status: 404 })),
		});
		const r = await client.fetchOEmbed("https://www.loom.com/share/abc123def456abc123def456");
		expect(r.status).toBe("unavailable");
	});

	it("returns failed on 500", async () => {
		const client = createLoomClient({
			oembedPacer: noopPacer,
			pagePacer: noopPacer,
			graphqlPacer: noopPacer,
			enableGraphql: false,
			fetchImpl: mockFetch(() => new Response("", { status: 500 })),
		});
		const r = await client.fetchOEmbed("https://www.loom.com/share/abc123def456abc123def456");
		if (r.status !== "failed") throw new Error("expected failed");
		expect(r.error).toBe("HTTP 500");
	});

	it("returns failed on network error", async () => {
		const client = createLoomClient({
			oembedPacer: noopPacer,
			pagePacer: noopPacer,
			graphqlPacer: noopPacer,
			enableGraphql: false,
			fetchImpl: vi.fn(async () => {
				throw new Error("connection refused");
			}) as unknown as typeof fetch,
		});
		const r = await client.fetchOEmbed("https://www.loom.com/share/abc123def456abc123def456");
		if (r.status !== "failed") throw new Error("expected failed");
		expect(r.error).toBe("connection refused");
	});
});

describe("createLoomClient — GraphQL kill switch", () => {
	it("short-circuits to skipped when enableGraphql is false", async () => {
		const fetchSpy = vi.fn();
		const client = createLoomClient({
			oembedPacer: noopPacer,
			pagePacer: noopPacer,
			graphqlPacer: noopPacer,
			enableGraphql: false,
			fetchImpl: fetchSpy as unknown as typeof fetch,
		});
		const r = await client.fetchGraphQL("abc123def456abc123def456");
		expect(r.status).toBe("skipped");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("calls fetch when enableGraphql is true", async () => {
		const fetchSpy = vi.fn(
			async () =>
				new Response(JSON.stringify(GRAPHQL_OK), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;
		const client = createLoomClient({
			oembedPacer: noopPacer,
			pagePacer: noopPacer,
			graphqlPacer: noopPacer,
			enableGraphql: true,
			fetchImpl: fetchSpy,
		});
		const r = await client.fetchGraphQL("abc123def456abc123def456");
		expect(r.status).toBe("ok");
	});
});
