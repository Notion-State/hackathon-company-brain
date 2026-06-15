import { describe, expect, it } from "vitest";

import { extractDomain, isInternal, parseInternalDomains } from "./internal-domains.js";

describe("parseInternalDomains", () => {
	it("returns empty set when undefined or empty", () => {
		expect(parseInternalDomains(undefined).size).toBe(0);
		expect(parseInternalDomains("").size).toBe(0);
	});

	it("parses a comma-separated list, trimming and lowercasing", () => {
		const set = parseInternalDomains(" Example.com , Acme.com ");
		expect(set.has("example.com")).toBe(true);
		expect(set.has("acme.com")).toBe(true);
		expect(set.size).toBe(2);
	});

	it("ignores empty entries between commas", () => {
		const set = parseInternalDomains(",,a.com,,b.com,");
		expect(set.size).toBe(2);
	});
});

describe("extractDomain", () => {
	it("returns null for empty input", () => {
		expect(extractDomain(null)).toBeNull();
		expect(extractDomain(undefined)).toBeNull();
		expect(extractDomain("")).toBeNull();
	});

	it("returns null when there's no @", () => {
		expect(extractDomain("noatsign")).toBeNull();
	});

	it("returns null when the @ is the last character", () => {
		expect(extractDomain("user@")).toBeNull();
	});

	it("extracts and lowercases the domain", () => {
		expect(extractDomain("Alice@Acme.COM")).toBe("acme.com");
	});

	it("uses the last @ (handles double-at edge case gracefully)", () => {
		expect(extractDomain("a@b@acme.com")).toBe("acme.com");
	});
});

describe("isInternal", () => {
	const internal = parseInternalDomains("example.com,acme.com");

	it("returns false for missing email", () => {
		expect(isInternal(null, internal)).toBe(false);
		expect(isInternal("", internal)).toBe(false);
	});

	it("returns true when the domain matches", () => {
		expect(isInternal("leslie@example.com", internal)).toBe(true);
		expect(isInternal("alice@acme.com", internal)).toBe(true);
	});

	it("returns false for external domains", () => {
		expect(isInternal("ext@partner.com", internal)).toBe(false);
	});

	it("returns false when internal set is empty", () => {
		expect(isInternal("anyone@anywhere.com", new Set())).toBe(false);
	});
});
