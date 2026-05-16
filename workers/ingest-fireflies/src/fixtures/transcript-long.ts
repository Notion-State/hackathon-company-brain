import type { Sentence, Transcript } from "../fireflies.js";

const SPEAKERS = ["Alice", "Bob", "Carol", "Dave"];

function buildSentences(count: number): Sentence[] {
	const out: Sentence[] = [];
	for (let i = 0; i < count; i++) {
		const speaker = SPEAKERS[i % SPEAKERS.length]!;
		out.push({
			speaker_name: speaker,
			text: `Utterance number ${i + 1} from ${speaker}. Discussing item ${Math.floor(i / 4) + 1}.`,
			start_time: i * 7,
			end_time: i * 7 + 6,
		});
	}
	return out;
}

/**
 * Long-form transcript — exercises page-body rendering at ~200 sentences and
 * the multi_select speaker dedup logic. Used by the render tests to confirm
 * we don't crash on real-sized inputs.
 */
export const transcriptLong: Transcript = {
	id: "ff_long_002",
	title: "Q2 planning — engineering leads",
	date: "2026-04-22T13:30:00.000Z",
	duration: 90, // minutes
	host_email: "alice@acme.com",
	transcript_url: "https://app.fireflies.ai/view/ff_long_002",
	meeting_attendees: [
		{ displayName: "Alice", email: "alice@acme.com", location: null },
		{ displayName: "Bob", email: "bob@acme.com", location: null },
		{ displayName: "Carol", email: "carol@acme.com", location: null },
		{ displayName: "Dave", email: "dave@acme.com", location: null },
	],
	speakers: SPEAKERS.map((name) => ({ name })),
	sentences: buildSentences(200),
	summary: {
		// Use a string with markdown-style bullets to exercise the string-form
		// branch of normalizeActionItems.
		overview: "Discussed roadmap, scoping, hiring plan, and customer commitments.",
		action_items: "- Alice: finalize roadmap doc\n- Bob: scope migration spike\n* Carol: post hiring plan in #leadership",
		keywords: ["roadmap", "hiring", "migration", "customers"],
	},
};
