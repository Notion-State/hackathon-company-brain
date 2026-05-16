import { describe, expect, it } from "vitest";

import { createFirefliesClient, FirefliesError } from "./fireflies.js";

type FetchCall = { url: string; init: RequestInit };

function mockFetch(responses: Array<Partial<Response> & { jsonValue?: unknown; textValue?: string }>) {
	const calls: FetchCall[] = [];
	let i = 0;
	const impl = async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		const r = responses[i++];
		if (!r) throw new Error("mockFetch: no response queued");
		return {
			ok: r.status == null ? true : r.status >= 200 && r.status < 300,
			status: r.status ?? 200,
			json: async () => r.jsonValue ?? {},
			text: async () => r.textValue ?? "",
		} as Response;
	};
	return { impl, calls };
}

describe("createFirefliesClient", () => {
	it("throws if apiKey is empty", () => {
		expect(() => createFirefliesClient("")).toThrow();
	});

	it("sends Bearer auth header and posts JSON to the endpoint", async () => {
		const { impl, calls } = mockFetch([
			{ jsonValue: { data: { transcripts: [{ id: "t1", date: "2026-05-10T00:00:00.000Z" }] } } },
		]);
		const client = createFirefliesClient("secret-key", { fetchImpl: impl });

		await client.listTranscriptIds({ fromIso: "2026-04-01T00:00:00.000Z", skip: 0, limit: 50 });

		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("https://api.fireflies.ai/graphql");
		expect(calls[0]!.init.method).toBe("POST");
		const headers = calls[0]!.init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer secret-key");
		expect(headers["Content-Type"]).toBe("application/json");
		const body = JSON.parse(calls[0]!.init.body as string);
		expect(body.variables).toEqual({ fromDate: "2026-04-01T00:00:00.000Z", skip: 0, limit: 50 });
	});

	it("each client instance uses its own apiKey (multi-account safety)", async () => {
		const { impl: fa, calls: ca } = mockFetch([{ jsonValue: { data: { transcripts: [] } } }]);
		const { impl: fb, calls: cb } = mockFetch([{ jsonValue: { data: { transcripts: [] } } }]);
		const clientA = createFirefliesClient("KEY-A", { fetchImpl: fa });
		const clientB = createFirefliesClient("KEY-B", { fetchImpl: fb });

		await clientA.listTranscriptIds({ fromIso: "2026-01-01T00:00:00.000Z", skip: 0, limit: 1 });
		await clientB.listTranscriptIds({ fromIso: "2026-01-01T00:00:00.000Z", skip: 0, limit: 1 });

		expect((ca[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer KEY-A");
		expect((cb[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer KEY-B");
	});

	it("listTranscriptIds reports hasMore=true when page is full and tracks latestDate", async () => {
		const ids = Array.from({ length: 50 }, (_, i) => ({
			id: `t${i}`,
			date: `2026-05-${String(10 + (i % 5)).padStart(2, "0")}T00:00:00.000Z`,
		}));
		const { impl } = mockFetch([{ jsonValue: { data: { transcripts: ids } } }]);
		const client = createFirefliesClient("k", { fetchImpl: impl });

		const result = await client.listTranscriptIds({ fromIso: "2026-01-01T00:00:00.000Z", skip: 0, limit: 50 });
		expect(result.ids).toHaveLength(50);
		expect(result.hasMore).toBe(true);
		expect(result.latestDate).toBe("2026-05-14T00:00:00.000Z");
	});

	it("listTranscriptIds reports hasMore=false when page is short", async () => {
		const { impl } = mockFetch([
			{ jsonValue: { data: { transcripts: [{ id: "t1", date: "2026-05-10T00:00:00.000Z" }] } } },
		]);
		const client = createFirefliesClient("k", { fetchImpl: impl });
		const result = await client.listTranscriptIds({ fromIso: "2026-01-01T00:00:00.000Z", skip: 0, limit: 50 });
		expect(result.hasMore).toBe(false);
	});

	it("getTranscript returns the transcript payload", async () => {
		const fixture = {
			id: "t1",
			title: "Test",
			date: "2026-05-10T00:00:00.000Z",
			duration: 600,
			host_email: "a@b.com",
			transcript_url: "https://example.com",
			meeting_attendees: null,
			speakers: null,
			sentences: null,
			summary: null,
		};
		const { impl } = mockFetch([{ jsonValue: { data: { transcript: fixture } } }]);
		const client = createFirefliesClient("k", { fetchImpl: impl });

		const t = await client.getTranscript("t1");
		expect(t.id).toBe("t1");
		expect(t.title).toBe("Test");
	});

	it("throws retryable FirefliesError on HTTP 429", async () => {
		const { impl } = mockFetch([{ status: 429, textValue: "rate limited" }]);
		const client = createFirefliesClient("k", { fetchImpl: impl });
		await expect(client.getTranscript("t1")).rejects.toMatchObject({
			name: "FirefliesError",
			status: 429,
			retryable: true,
		});
	});

	it("throws retryable FirefliesError on HTTP 5xx", async () => {
		const { impl } = mockFetch([{ status: 503, textValue: "down" }]);
		const client = createFirefliesClient("k", { fetchImpl: impl });
		await expect(client.getTranscript("t1")).rejects.toMatchObject({
			status: 503,
			retryable: true,
		});
	});

	it("throws non-retryable FirefliesError on GraphQL errors field", async () => {
		const { impl } = mockFetch([{ jsonValue: { errors: [{ message: "Bad query" }] } }]);
		const client = createFirefliesClient("k", { fetchImpl: impl });
		await expect(client.getTranscript("t1")).rejects.toMatchObject({
			name: "FirefliesError",
			retryable: false,
		});
	});

	it("throws non-retryable FirefliesError on HTTP 4xx (non-429)", async () => {
		const { impl } = mockFetch([{ status: 401, textValue: "bad token" }]);
		const client = createFirefliesClient("k", { fetchImpl: impl });
		await expect(client.getTranscript("t1")).rejects.toMatchObject({
			status: 401,
			retryable: false,
		});
	});

	it("FirefliesError exposes the graphqlErrors payload", async () => {
		const errs = [{ message: "Bad" }];
		const { impl } = mockFetch([{ jsonValue: { errors: errs } }]);
		const client = createFirefliesClient("k", { fetchImpl: impl });
		try {
			await client.getTranscript("t1");
			expect.fail("expected throw");
		} catch (e) {
			expect(e).toBeInstanceOf(FirefliesError);
			expect((e as FirefliesError).graphqlErrors).toEqual(errs);
		}
	});
});
