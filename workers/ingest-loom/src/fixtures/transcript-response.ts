/**
 * Fixture shapes for the signed-CloudFront transcript JSON fetched after
 * GraphQL's `fetchVideoTranscript.source_url`. Real bodies are larger and
 * include per-phrase `ranges[]` for character-level highlighting; we only
 * care about `ts` (start seconds) and `value` (phrase text).
 */

export const TRANSCRIPT_OK = {
	schemaVersion: "1.0",
	phrases: [
		{ ts: 0, value: "Hey team, quick walkthrough.", ranges: [] },
		{ ts: 6.5, value: "We just shipped the new filters panel.", ranges: [] },
		{ ts: 12, value: "  Let me show you what's changed.  ", ranges: [] },
	],
};

export const TRANSCRIPT_EMPTY = {
	schemaVersion: "1.0",
	phrases: [],
};

export const TRANSCRIPT_MALFORMED = {
	something: "else",
};
