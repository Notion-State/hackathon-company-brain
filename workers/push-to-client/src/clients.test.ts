import { describe, expect, it } from "vitest";

import { getClients } from "./clients.js";

describe("getClients", () => {
	it("returns a single client with mode defaulting to staging", () => {
		const clients = getClients({
			CLIENT_TOKEN_ACME: "ntn_acme",
			CLIENT_DEST_DB_ACME: "db_acme",
		});
		expect(clients).toEqual([
			{ id: "acme", token: "ntn_acme", destDbId: "db_acme", mode: "staging" },
		]);
	});

	it("parses explicit staging and production modes", () => {
		const clients = getClients({
			CLIENT_TOKEN_ACME: "ntn_acme",
			CLIENT_DEST_DB_ACME: "db_acme",
			CLIENT_MODE_ACME: "production",
			CLIENT_TOKEN_BETA: "ntn_beta",
			CLIENT_DEST_DB_BETA: "db_beta",
			CLIENT_MODE_BETA: "staging",
		});
		expect(clients).toEqual([
			{ id: "acme", token: "ntn_acme", destDbId: "db_acme", mode: "production" },
			{ id: "beta", token: "ntn_beta", destDbId: "db_beta", mode: "staging" },
		]);
	});

	it("lowercases the id and sorts deterministically", () => {
		const clients = getClients({
			CLIENT_TOKEN_BETA: "ntn_beta",
			CLIENT_DEST_DB_BETA: "db_beta",
			CLIENT_TOKEN_ACME: "ntn_acme",
			CLIENT_DEST_DB_ACME: "db_acme",
		});
		expect(clients.map((c) => c.id)).toEqual(["acme", "beta"]);
	});

	it("trims surrounding whitespace from values", () => {
		const clients = getClients({
			CLIENT_TOKEN_ACME: "  ntn_acme  ",
			CLIENT_DEST_DB_ACME: "\tdb_acme\n",
			CLIENT_MODE_ACME: " production ",
		});
		expect(clients[0]).toMatchObject({
			token: "ntn_acme",
			destDbId: "db_acme",
			mode: "production",
		});
	});

	it("rejects unknown mode values", () => {
		expect(() =>
			getClients({
				CLIENT_TOKEN_ACME: "ntn_acme",
				CLIENT_DEST_DB_ACME: "db_acme",
				CLIENT_MODE_ACME: "preview",
			}),
		).toThrow(/invalid CLIENT_MODE/);
	});

	it("throws when a client has a token but no destination DB", () => {
		expect(() =>
			getClients({ CLIENT_TOKEN_ACME: "ntn_acme" }),
		).toThrow(/no CLIENT_DEST_DB_ACME/);
	});

	it("throws when a client has a destination DB but no token", () => {
		expect(() =>
			getClients({ CLIENT_DEST_DB_ACME: "db_acme" }),
		).toThrow(/no CLIENT_TOKEN_ACME/);
	});

	it("throws when no clients are configured", () => {
		expect(() => getClients({})).toThrow(/No clients configured/);
	});

	it("ignores empty-string values (treats as unset)", () => {
		expect(() =>
			getClients({ CLIENT_TOKEN_ACME: "", CLIENT_DEST_DB_ACME: "" }),
		).toThrow(/No clients configured/);
	});
});
