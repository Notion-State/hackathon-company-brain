import { describe, expect, it } from "vitest";

import { getFirefliesAccounts } from "./accounts.js";

describe("getFirefliesAccounts", () => {
	it("returns a single default account when only FIREFLIES_API_KEY is set", () => {
		const accounts = getFirefliesAccounts({ FIREFLIES_API_KEY: "k1" });
		expect(accounts).toEqual([{ id: "default", apiKey: "k1" }]);
	});

	it("returns multiple accounts from FIREFLIES_API_KEY_<ID> env vars", () => {
		const accounts = getFirefliesAccounts({
			FIREFLIES_API_KEY: "k1",
			FIREFLIES_API_KEY_ACME: "k2",
			FIREFLIES_API_KEY_BETA: "k3",
		});
		// Deterministic sort by id
		expect(accounts).toEqual([
			{ id: "acme", apiKey: "k2" },
			{ id: "beta", apiKey: "k3" },
			{ id: "default", apiKey: "k1" },
		]);
	});

	it("returns only named accounts when no default is set", () => {
		const accounts = getFirefliesAccounts({ FIREFLIES_API_KEY_ACME: "k2" });
		expect(accounts).toEqual([{ id: "acme", apiKey: "k2" }]);
	});

	it("lowercases the suffix in named-account ids", () => {
		const accounts = getFirefliesAccounts({ FIREFLIES_API_KEY_BIGCORP: "k" });
		expect(accounts[0]?.id).toBe("bigcorp");
	});

	it("ignores empty-string values", () => {
		const accounts = getFirefliesAccounts({
			FIREFLIES_API_KEY: "",
			FIREFLIES_API_KEY_ACME: "k2",
		});
		expect(accounts).toEqual([{ id: "acme", apiKey: "k2" }]);
	});

	it("throws when zero accounts are configured", () => {
		expect(() => getFirefliesAccounts({})).toThrow(/No Fireflies accounts configured/);
	});

	it("skips a FIREFLIES_API_KEY_DEFAULT suffix (would collide with the default)", () => {
		const accounts = getFirefliesAccounts({
			FIREFLIES_API_KEY: "k1",
			FIREFLIES_API_KEY_DEFAULT: "k_dupe",
		});
		expect(accounts).toEqual([{ id: "default", apiKey: "k1" }]);
	});
});
