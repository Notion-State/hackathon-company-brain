/**
 * Fixture shapes for Loom's public GraphQL endpoint.
 *
 * Composite query: `getVideo(id:)` (union — RegularUserVideo / PrivateVideo /
 * VideoPasswordMissingOrIncorrect) + `fetchVideoTranscript(videoId:)` (union
 * containing VideoTranscriptDetails). The transcript JSON itself lives at the
 * signed CloudFront URL in `source_url` — fixtures for that JSON live in
 * `transcript-response.ts`.
 */

export const GRAPHQL_OK = {
	data: {
		getVideo: {
			__typename: "RegularUserVideo",
			id: "abc123def456",
			createdAt: "2026-04-12T15:30:00.000Z",
			name: "Product walkthrough",
			description: "Quick demo of the new dashboard.\n\nFollow-up Q&A pinned in comments.",
			commentCount: 3,
			owner: { display_name: "Alex Lee", email: "alex@notionstate.com" },
		},
		fetchVideoTranscript: {
			__typename: "VideoTranscriptDetails",
			transcription_status: "success",
			source_url:
				"https://cdn.loom.com/mediametadata/transcription/abc123def456-1.json?Policy=stub&Signature=stub&Key-Pair-Id=stub",
		},
	},
};

/** RegularUserVideo where transcription is still being generated. */
export const GRAPHQL_TRANSCRIPT_IN_PROGRESS = {
	data: {
		getVideo: {
			__typename: "RegularUserVideo",
			id: "abc123def456",
			createdAt: "2026-04-12T15:30:00.000Z",
			name: "Just-recorded clip",
			description: "Awaiting transcription.",
			commentCount: 0,
			owner: { display_name: "Solo", email: "solo@example.com" },
		},
		fetchVideoTranscript: {
			__typename: "VideoTranscriptDetails",
			transcription_status: "in_progress",
			source_url: null,
		},
	},
};

/** PrivateVideo variant — no metadata fields, transcript null. */
export const GRAPHQL_PRIVATE = {
	data: {
		getVideo: {
			__typename: "PrivateVideo",
			id: "abc123def456",
		},
		fetchVideoTranscript: null,
	},
};

/**
 * Partial-data response: `getVideo` resolved but `fetchVideoTranscript`
 * errored. GraphQL spec returns the remaining data with a per-field entry
 * in `errors[]` carrying the failing `path`. The normalizer should still
 * return `ok` for the metadata side.
 */
export const GRAPHQL_PARTIAL_ERROR = {
	data: {
		getVideo: {
			__typename: "RegularUserVideo",
			id: "abc123def456",
			createdAt: "2026-04-12T15:30:00.000Z",
			name: "Half-resolved",
			description: null,
			commentCount: 0,
			owner: { display_name: "Zee", email: "" },
		},
		fetchVideoTranscript: null,
	},
	errors: [{ message: "Internal error", path: ["fetchVideoTranscript"] }],
};

/** Top-level error with no usable `data` block. */
export const GRAPHQL_ERROR = {
	errors: [{ message: "Cannot query field 'foo' on type 'RegularUserVideo'." }],
};
