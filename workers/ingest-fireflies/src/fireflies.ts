/**
 * Fireflies.AI GraphQL client.
 *
 * Factory pattern: `createFirefliesClient(apiKey)` returns a client bound to a
 * single API key. The factory is invoked once per configured account at module
 * init, so multi-account ingest is just "instantiate N clients."
 */

const FIREFLIES_ENDPOINT = "https://api.fireflies.ai/graphql";

export type Sentence = {
	speaker_name: string | null;
	text: string;
	start_time: number | null;
	end_time: number | null;
};

export type Speaker = {
	name: string | null;
};

export type MeetingAttendee = {
	displayName: string | null;
	email: string | null;
	location: string | null;
};

export type TranscriptSummary = {
	overview: string | null;
	// Fireflies has returned action_items as either a string (bulleted) or array;
	// accept both shapes and let the renderer normalize.
	action_items: string | string[] | null;
	keywords: string[] | null;
};

export type Transcript = {
	id: string;
	title: string | null;
	date: string | null; // ISO 8601 datetime, normalized from epoch-millis at the client boundary
	duration: number | null; // minutes (Fireflies returns float minutes, not seconds as the public docs imply)
	host_email: string | null;
	transcript_url: string | null;
	meeting_attendees: MeetingAttendee[] | null;
	speakers: Speaker[] | null;
	sentences: Sentence[] | null;
	summary: TranscriptSummary | null;
};

/**
 * Fireflies returns `date` fields as Unix epoch milliseconds (number), but the
 * Notion `Builder.dateTime` expects ISO 8601. Normalize at the client boundary
 * so all downstream code treats dates uniformly as ISO strings.
 */
function normalizeDate(raw: unknown): string | null {
	if (raw == null) return null;
	if (typeof raw === "string") return raw;
	if (typeof raw === "number" && Number.isFinite(raw)) return new Date(raw).toISOString();
	return null;
}

export type ListTranscriptsArgs = {
	fromIso: string; // ISO datetime — Fireflies accepts ISO and date-only
	skip: number;
	limit: number;
};

export type FirefliesClient = {
	listTranscriptIds(args: ListTranscriptsArgs): Promise<{
		ids: string[];
		latestDate: string | null; // ISO of the latest meeting in the page, for cursor advancement
		hasMore: boolean;
	}>;
	getTranscript(id: string): Promise<Transcript>;
};

export class FirefliesError extends Error {
	readonly status: number;
	readonly retryable: boolean;
	readonly graphqlErrors?: unknown;

	constructor(message: string, opts: { status: number; retryable: boolean; graphqlErrors?: unknown }) {
		super(message);
		this.name = "FirefliesError";
		this.status = opts.status;
		this.retryable = opts.retryable;
		this.graphqlErrors = opts.graphqlErrors;
	}
}

const LIST_QUERY = /* GraphQL */ `
	query ListTranscripts($fromDate: DateTime, $limit: Int, $skip: Int) {
		transcripts(fromDate: $fromDate, limit: $limit, skip: $skip) {
			id
			date
		}
	}
`;

const TRANSCRIPT_QUERY = /* GraphQL */ `
	query GetTranscript($id: String!) {
		transcript(id: $id) {
			id
			title
			date
			duration
			host_email
			transcript_url
			meeting_attendees {
				displayName
				email
				location
			}
			speakers {
				name
			}
			sentences {
				speaker_name
				text
				start_time
				end_time
			}
			summary {
				overview
				action_items
				keywords
			}
		}
	}
`;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function createFirefliesClient(
	apiKey: string,
	opts: { endpoint?: string; fetchImpl?: FetchLike } = {},
): FirefliesClient {
	if (!apiKey) {
		throw new Error("createFirefliesClient: apiKey is required");
	}
	const endpoint = opts.endpoint ?? FIREFLIES_ENDPOINT;
	const doFetch: FetchLike = opts.fetchImpl ?? (globalThis.fetch as FetchLike);

	async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
		const res = await doFetch(endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({ query, variables }),
		});

		if (res.status === 429) {
			throw new FirefliesError("Fireflies rate limit hit (429)", { status: 429, retryable: true });
		}
		if (res.status >= 500) {
			throw new FirefliesError(`Fireflies server error (${res.status})`, { status: res.status, retryable: true });
		}
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new FirefliesError(`Fireflies HTTP ${res.status}: ${body.slice(0, 500)}`, {
				status: res.status,
				retryable: false,
			});
		}

		const payload = (await res.json()) as { data?: T; errors?: unknown };
		if (payload.errors) {
			// Fireflies sometimes returns rate-limit errors as HTTP 200 with a
			// GraphQL error of code "too_many_requests". Classify as retryable
			// so logs/reviewers can distinguish from genuine query bugs.
			const isRateLimit = Array.isArray(payload.errors)
				&& payload.errors.some((e) => (e as { code?: string })?.code === "too_many_requests");
			throw new FirefliesError(`Fireflies GraphQL error: ${JSON.stringify(payload.errors).slice(0, 500)}`, {
				status: res.status,
				retryable: isRateLimit,
				graphqlErrors: payload.errors,
			});
		}
		if (!payload.data) {
			throw new FirefliesError("Fireflies returned empty data", { status: res.status, retryable: false });
		}
		return payload.data;
	}

	return {
		async listTranscriptIds({ fromIso, skip, limit }) {
			const data = await gql<{ transcripts: Array<{ id: string; date: unknown }> }>(LIST_QUERY, {
				fromDate: fromIso,
				skip,
				limit,
			});
			const items = data.transcripts ?? [];
			let latestDate: string | null = null;
			for (const item of items) {
				const iso = normalizeDate(item.date);
				if (iso && (latestDate === null || iso > latestDate)) {
					latestDate = iso;
				}
			}
			return {
				ids: items.map((i) => i.id),
				latestDate,
				hasMore: items.length === limit,
			};
		},

		async getTranscript(id) {
			const data = await gql<{ transcript: (Omit<Transcript, "date"> & { date: unknown }) | null }>(
				TRANSCRIPT_QUERY,
				{ id },
			);
			if (!data.transcript) {
				throw new FirefliesError(`Fireflies returned null transcript for id=${id}`, {
					status: 200,
					retryable: false,
				});
			}
			return { ...data.transcript, date: normalizeDate(data.transcript.date) };
		},
	};
}
