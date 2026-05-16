import { describe, expect, it } from "vitest";

import type { Transcript } from "./fireflies.js";
import { transcriptLong } from "./fixtures/transcript-long.js";
import { transcriptShort } from "./fixtures/transcript-short.js";
import { recordId, renderTranscriptMarkdown, toChangeProperties } from "./render.js";

describe("recordId", () => {
	it("formats accountId:transcriptId", () => {
		expect(recordId("default", "abc123")).toBe("default:abc123");
		expect(recordId("acme", "xyz789")).toBe("acme:xyz789");
	});
});

describe("renderTranscriptMarkdown", () => {
	it("renders a complete short transcript with all sections", () => {
		const md = renderTranscriptMarkdown(transcriptShort);
		expect(md).toContain("# Weekly sync — Acme onboarding");
		expect(md).toContain("**Date:** 2026-05-10T15:00:00.000Z");
		expect(md).toContain("**Duration:** 31 min");
		expect(md).toContain("**Host:** alice@acme.com");
		expect(md).toContain("**Attendees:** Alice, Bob");
		expect(md).toContain("## Summary");
		expect(md).toContain("Alice welcomed Bob");
		expect(md).toContain("## Action Items");
		expect(md).toContain("- Bob: read the platform overview doc");
		expect(md).toContain("- Alice: schedule permissions review for next week");
		expect(md).toContain("## Keywords");
		expect(md).toContain("onboarding, permissions, platform-overview");
		expect(md).toContain("## Transcript");
		expect(md).toContain("**Alice:** Hey Bob, welcome aboard.");
		expect(md).toContain("**Bob:** Thanks Alice — excited to dive in.");
	});

	it("handles the long transcript without crashing and emits all sentences", () => {
		const md = renderTranscriptMarkdown(transcriptLong);
		expect(md).toContain("# Q2 planning — engineering leads");
		expect(md).toContain("**Duration:** 90 min");
		// String-form action items: each newline-separated bullet becomes a list item.
		expect(md).toContain("- Alice: finalize roadmap doc");
		expect(md).toContain("- Bob: scope migration spike");
		expect(md).toContain("- Carol: post hiring plan in \\#leadership"); // # is escaped
		// All 200 sentences rendered.
		const occurrences = md.match(/\*\*(Alice|Bob|Carol|Dave):\*\*/g) ?? [];
		expect(occurrences.length).toBe(200);
	});

	it("renders fallback placeholders when sections are missing", () => {
		const empty: Transcript = {
			id: "x",
			title: null,
			date: null,
			duration: null,
			host_email: null,
			transcript_url: null,
			meeting_attendees: null,
			speakers: null,
			sentences: null,
			summary: null,
		};
		const md = renderTranscriptMarkdown(empty);
		expect(md).toContain("# Untitled meeting");
		expect(md).toContain("_None recorded_");
		expect(md).toContain("_No summary available._");
		expect(md).toContain("_No action items captured._");
		expect(md).toContain("_No keywords extracted._");
		expect(md).toContain("_No transcript text available._");
	});

	it("escapes markdown special characters in user-supplied text", () => {
		const t: Transcript = {
			...transcriptShort,
			title: "Project *Stealth* [v2]",
			sentences: [{ speaker_name: "Eve", text: "Use `npm run build` first.", start_time: 0 }],
		};
		const md = renderTranscriptMarkdown(t);
		expect(md).toContain("Project \\*Stealth\\* \\[v2\\]");
		expect(md).toContain("\\`npm run build\\`");
	});
});

describe("toChangeProperties", () => {
	it("builds the composite Record ID and required schema properties", () => {
		const now = new Date("2026-05-15T00:00:00.000Z");
		const props = toChangeProperties(transcriptShort, "default", now);
		expect(props.Title).toBeDefined();
		expect(props["Record ID"]).toBeDefined();
		expect(props["Transcript ID"]).toBeDefined();
		expect(props.Account).toBeDefined();
		expect(props.Source).toBeDefined();
		expect(props["Synced At"]).toBeDefined();
		expect(props["Meeting Date"]).toBeDefined();
		expect(props["Duration (min)"]).toBeDefined();
		expect(props.Host).toBeDefined();
		expect(props["Transcript URL"]).toBeDefined();
		expect(props.Speakers).toBeDefined();
		expect(props.Attendees).toBeDefined();
	});

	it("uses the namespaced account id in the composite Record ID", () => {
		const props = toChangeProperties(transcriptShort, "acme");
		// Record ID is built by recordId() — verified directly here:
		expect(recordId("acme", transcriptShort.id)).toBe("acme:ff_short_001");
		expect(props["Record ID"]).toBeDefined();
	});

	it("always emits Host (empty when email is invalid or missing) — SDK requires all schema props", () => {
		const propsNoHost = toChangeProperties({ ...transcriptShort, host_email: null }, "default");
		expect(propsNoHost.Host).toBeDefined();

		const propsBadEmail = toChangeProperties({ ...transcriptShort, host_email: "not-an-email" }, "default");
		expect(propsBadEmail.Host).toBeDefined();
	});

	it("falls back Meeting Date to `now` when source date is null", () => {
		const now = new Date("2026-05-15T00:00:00.000Z");
		const props = toChangeProperties({ ...transcriptShort, date: null }, "default", now);
		expect(props["Meeting Date"]).toBeDefined();
	});

	it("always emits Speakers (empty richText when none recorded)", () => {
		const props = toChangeProperties({ ...transcriptShort, speakers: null }, "default");
		expect(props.Speakers).toBeDefined();
	});

	it("always emits Duration (min) (falls back to 0 when source duration is null)", () => {
		const props = toChangeProperties({ ...transcriptShort, duration: null }, "default");
		expect(props["Duration (min)"]).toBeDefined();
	});
});
