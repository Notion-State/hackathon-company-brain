import { describe, expect, it } from "vitest";

import { getClients } from "./clients.js";

const FULL_TRIO = {
	CLIENT_TOKEN_ACME: "ntn_acme",
	CLIENT_DOCS_DB_ACME: "db_docs_acme",
	CLIENT_STATUS_UPDATES_DB_ACME: "db_status_acme",
	CLIENT_DELIVERABLES_DB_ACME: "db_deliv_acme",
};

describe("getClients", () => {
	it("returns a single client with mode defaulting to staging", () => {
		const clients = getClients(FULL_TRIO);
		expect(clients).toEqual([
			{
				id: "acme",
				token: "ntn_acme",
				destDbIdsByType: {
					Docs: "db_docs_acme",
					StatusUpdate: "db_status_acme",
					Deliverable: "db_deliv_acme",
				},
				mode: "staging",
			},
		]);
	});

	it("parses explicit staging and production modes", () => {
		const clients = getClients({
			...FULL_TRIO,
			CLIENT_MODE_ACME: "production",
			CLIENT_TOKEN_BETA: "ntn_beta",
			CLIENT_DOCS_DB_BETA: "db_docs_beta",
			CLIENT_STATUS_UPDATES_DB_BETA: "db_status_beta",
			CLIENT_DELIVERABLES_DB_BETA: "db_deliv_beta",
			CLIENT_MODE_BETA: "staging",
		});
		expect(clients.map((c) => ({ id: c.id, mode: c.mode }))).toEqual([
			{ id: "acme", mode: "production" },
			{ id: "beta", mode: "staging" },
		]);
	});

	it("lowercases the id and sorts deterministically", () => {
		const clients = getClients({
			CLIENT_TOKEN_BETA: "ntn_beta",
			CLIENT_DOCS_DB_BETA: "b1",
			CLIENT_STATUS_UPDATES_DB_BETA: "b2",
			CLIENT_DELIVERABLES_DB_BETA: "b3",
			CLIENT_TOKEN_ACME: "ntn_acme",
			CLIENT_DOCS_DB_ACME: "a1",
			CLIENT_STATUS_UPDATES_DB_ACME: "a2",
			CLIENT_DELIVERABLES_DB_ACME: "a3",
		});
		expect(clients.map((c) => c.id)).toEqual(["acme", "beta"]);
	});

	it("trims surrounding whitespace from values", () => {
		const clients = getClients({
			CLIENT_TOKEN_ACME: "  ntn_acme  ",
			CLIENT_DOCS_DB_ACME: "\tdocs\n",
			CLIENT_STATUS_UPDATES_DB_ACME: " status ",
			CLIENT_DELIVERABLES_DB_ACME: " deliv ",
			CLIENT_MODE_ACME: " production ",
		});
		expect(clients[0]).toMatchObject({
			token: "ntn_acme",
			destDbIdsByType: {
				Docs: "docs",
				StatusUpdate: "status",
				Deliverable: "deliv",
			},
			mode: "production",
		});
	});

	it("rejects unknown mode values", () => {
		expect(() =>
			getClients({ ...FULL_TRIO, CLIENT_MODE_ACME: "preview" }),
		).toThrow(/invalid CLIENT_MODE/);
	});

	it("throws when a client has a token but is missing a destination DB id", () => {
		expect(() =>
			getClients({
				CLIENT_TOKEN_ACME: "ntn_acme",
				CLIENT_DOCS_DB_ACME: "db_docs",
				CLIENT_STATUS_UPDATES_DB_ACME: "db_status",
				// missing CLIENT_DELIVERABLES_DB_ACME
			}),
		).toThrow(/missing CLIENT_DELIVERABLES_DB_ACME/);
	});

	it("throws when destination DB ids are set but no token", () => {
		expect(() =>
			getClients({
				CLIENT_DOCS_DB_ACME: "db_docs",
				CLIENT_STATUS_UPDATES_DB_ACME: "db_status",
				CLIENT_DELIVERABLES_DB_ACME: "db_deliv",
			}),
		).toThrow(/no CLIENT_TOKEN_ACME/);
	});

	it("throws when no clients are configured", () => {
		expect(() => getClients({})).toThrow(/No clients configured/);
	});

	it("ignores empty-string values (treats as unset)", () => {
		expect(() =>
			getClients({
				CLIENT_TOKEN_ACME: "",
				CLIENT_DOCS_DB_ACME: "",
				CLIENT_STATUS_UPDATES_DB_ACME: "",
				CLIENT_DELIVERABLES_DB_ACME: "",
			}),
		).toThrow(/No clients configured/);
	});
});
