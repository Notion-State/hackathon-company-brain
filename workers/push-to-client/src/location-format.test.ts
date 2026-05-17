import { describe, expect, it } from "vitest";

import { formatLocation } from "./location-format.js";

describe("formatLocation", () => {
	it("returns empty string for empty input", () => {
		expect(formatLocation([])).toBe("");
	});

	it("formats a single Client OS entry", () => {
		expect(
			formatLocation([
				{
					side: "ClientOS",
					linkText: "Aduro Advisors – Docs",
					url: "https://notion.so/abc",
				},
			]),
		).toBe("Client OS: [Aduro Advisors – Docs](https://notion.so/abc)");
	});

	it("formats a single NS OS entry", () => {
		expect(
			formatLocation([
				{
					side: "NSOS",
					linkText: "Notion State OS – Status Updates",
					url: "https://notion.so/xyz",
				},
			]),
		).toBe("NS OS: [Notion State OS – Status Updates](https://notion.so/xyz)");
	});

	it("formats both destinations, one per line, ClientOS-then-NSOS by caller order", () => {
		expect(
			formatLocation([
				{ side: "ClientOS", linkText: "Aduro – Docs", url: "https://n/c" },
				{ side: "NSOS", linkText: "NS – Docs", url: "https://n/n" },
			]),
		).toBe(
			"Client OS: [Aduro – Docs](https://n/c)\nNS OS: [NS – Docs](https://n/n)",
		);
	});

	it("escapes `[` and `]` in link text so Markdown doesn't break", () => {
		expect(
			formatLocation([
				{
					side: "ClientOS",
					linkText: "Foo [v2] – Docs",
					url: "https://n",
				},
			]),
		).toBe("Client OS: [Foo \\[v2\\] – Docs](https://n)");
	});

	it("escapes a literal backslash in link text", () => {
		expect(
			formatLocation([
				{ side: "ClientOS", linkText: "path\\name", url: "https://n" },
			]),
		).toBe("Client OS: [path\\\\name](https://n)");
	});
});
