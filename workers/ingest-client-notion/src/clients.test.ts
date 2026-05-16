import { describe, expect, it } from "vitest";
import { getClientNotionConfigs } from "./clients.js";

describe("getClientNotionConfigs", () => {
	it("returns a single client from a matched pair", () => {
		const clients = getClientNotionConfigs({
			CLIENT_NOTION_TOKEN_ACME: "secret_a",
			CLIENT_NOTION_DB_ID_ACME: "db-a",
		});
		expect(clients).toEqual([
			{ id: "acme", token: "secret_a", sourceDbId: "db-a" },
		]);
	});

	it("returns multiple clients sorted by id", () => {
		const clients = getClientNotionConfigs({
			CLIENT_NOTION_TOKEN_BETA: "secret_b",
			CLIENT_NOTION_DB_ID_BETA: "db-b",
			CLIENT_NOTION_TOKEN_ACME: "secret_a",
			CLIENT_NOTION_DB_ID_ACME: "db-a",
		});
		expect(clients).toEqual([
			{ id: "acme", token: "secret_a", sourceDbId: "db-a" },
			{ id: "beta", token: "secret_b", sourceDbId: "db-b" },
		]);
	});

	it("lowercases the suffix for the id", () => {
		const clients = getClientNotionConfigs({
			CLIENT_NOTION_TOKEN_MixedCase: "secret",
			CLIENT_NOTION_DB_ID_MixedCase: "db",
		});
		expect(clients).toEqual([{ id: "mixedcase", token: "secret", sourceDbId: "db" }]);
	});

	it("trims whitespace from values", () => {
		const clients = getClientNotionConfigs({
			CLIENT_NOTION_TOKEN_ACME: "  secret_a  ",
			CLIENT_NOTION_DB_ID_ACME: "\tdb-a\n",
		});
		expect(clients).toEqual([{ id: "acme", token: "secret_a", sourceDbId: "db-a" }]);
	});

	it("throws when a token is set without its db id", () => {
		expect(() =>
			getClientNotionConfigs({ CLIENT_NOTION_TOKEN_ACME: "secret_a" }),
		).toThrow(/CLIENT_NOTION_DB_ID_ACME/);
	});

	it("throws when a db id is set without its token", () => {
		expect(() =>
			getClientNotionConfigs({ CLIENT_NOTION_DB_ID_ACME: "db-a" }),
		).toThrow(/CLIENT_NOTION_TOKEN_ACME/);
	});

	it("treats both halves empty as 'no client', skipping silently", () => {
		expect(() =>
			getClientNotionConfigs({
				CLIENT_NOTION_TOKEN_ACME: "",
				CLIENT_NOTION_DB_ID_ACME: "",
			}),
		).toThrow(/No clients configured/);
	});

	it("throws when no clients are configured", () => {
		expect(() => getClientNotionConfigs({})).toThrow(/No clients configured/);
	});

	it("ignores unrelated env vars", () => {
		const clients = getClientNotionConfigs({
			PATH: "/usr/bin",
			HOME: "/home/x",
			CLIENT_NOTION_TOKEN_ACME: "secret_a",
			CLIENT_NOTION_DB_ID_ACME: "db-a",
		});
		expect(clients).toEqual([{ id: "acme", token: "secret_a", sourceDbId: "db-a" }]);
	});

	it("reports the right error for partial pairs across multiple clients", () => {
		expect(() =>
			getClientNotionConfigs({
				CLIENT_NOTION_TOKEN_ACME: "secret_a",
				CLIENT_NOTION_DB_ID_ACME: "db-a",
				CLIENT_NOTION_TOKEN_BETA: "secret_b",
				// db id missing for beta
			}),
		).toThrow(/CLIENT_NOTION_DB_ID_BETA/);
	});
});
