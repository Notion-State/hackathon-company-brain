import type { Transcript } from "../fireflies.js";

export const transcriptShort: Transcript = {
	id: "ff_short_001",
	title: "Weekly sync — Acme onboarding",
	date: "2026-05-10T15:00:00.000Z",
	duration: 30.5, // minutes → rounds to 31
	host_email: "alice@acme.com",
	transcript_url: "https://app.fireflies.ai/view/ff_short_001",
	meeting_attendees: [
		{ displayName: "Alice", email: "alice@acme.com", location: null },
		{ displayName: "Bob", email: "bob@acme.com", location: null },
	],
	speakers: [
		{ name: "Alice" },
		{ name: "Bob" },
		{ name: "Alice" }, // duplicate — should dedupe
	],
	sentences: [
		{ speaker_name: "Alice", text: "Hey Bob, welcome aboard.", start_time: 0, end_time: 2.5 },
		{ speaker_name: "Bob", text: "Thanks Alice — excited to dive in.", start_time: 3, end_time: 6 },
		{ speaker_name: "Alice", text: "Let's start with permissions next week.", start_time: 7, end_time: 10.5 },
	],
	summary: {
		overview: "Alice welcomed Bob and outlined next-week onboarding tasks.",
		action_items: ["Bob: read the platform overview doc", "Alice: schedule permissions review for next week"],
		keywords: ["onboarding", "permissions", "platform-overview"],
	},
};
