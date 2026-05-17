import { describe, expect, it, vi } from "vitest";

import { HOME_CLIENT_ID, retrieveUserEmail, type HomeApi } from "./home-api.js";
import type { NotionSdkSubset } from "./notion-client.js";

function makeHomeApi(retrieveImpl: NotionSdkSubset["users"]["retrieve"]): HomeApi {
	const sdk: NotionSdkSubset = {
		databases: { retrieve: vi.fn(async () => ({})) },
		dataSources: {
			retrieve: vi.fn(async () => ({})),
			query: vi.fn(async () => ({ results: [] })),
		},
		pages: {
			create: vi.fn(async () => ({})),
			retrieve: vi.fn(async () => ({})),
			update: vi.fn(async () => ({})),
		},
		blocks: {
			children: {
				append: vi.fn(async () => ({})),
				list: vi.fn(async () => ({ results: [], has_more: false })),
			},
		},
		users: {
			list: vi.fn(async () => ({ results: [] })),
			retrieve: retrieveImpl,
		},
	};
	return {
		id: HOME_CLIENT_ID,
		waitForPacer: vi.fn(async () => undefined),
		sdk,
	};
}

describe("retrieveUserEmail", () => {
	it("returns the email when the user is type=person with a published email", async () => {
		const api = makeHomeApi(
			vi.fn(async () => ({
				object: "user",
				id: "u_alice",
				type: "person",
				person: { email: "alice@x.com" },
			})),
		);
		const email = await retrieveUserEmail(api, "u_alice");
		expect(email).toBe("alice@x.com");
	});

	it("trims surrounding whitespace from the returned email", async () => {
		const api = makeHomeApi(
			vi.fn(async () => ({
				type: "person",
				person: { email: "  spaced@x.com  " },
			})),
		);
		const email = await retrieveUserEmail(api, "u_anyone");
		expect(email).toBe("spaced@x.com");
	});

	it("returns null when the user is a bot", async () => {
		const api = makeHomeApi(
			vi.fn(async () => ({
				type: "bot",
				bot: {},
			})),
		);
		expect(await retrieveUserEmail(api, "u_bot")).toBeNull();
	});

	it("returns null when the user is a group", async () => {
		const api = makeHomeApi(
			vi.fn(async () => ({
				type: "group",
			})),
		);
		expect(await retrieveUserEmail(api, "u_group")).toBeNull();
	});

	it("returns null when type=person but email is missing", async () => {
		const api = makeHomeApi(
			vi.fn(async () => ({
				type: "person",
				person: {},
			})),
		);
		expect(await retrieveUserEmail(api, "u_no_email")).toBeNull();
	});

	it("returns null when type=person but email is empty string", async () => {
		const api = makeHomeApi(
			vi.fn(async () => ({
				type: "person",
				person: { email: "" },
			})),
		);
		expect(await retrieveUserEmail(api, "u_empty")).toBeNull();
	});

	it("waits for the pacer before issuing the SDK call", async () => {
		const order: string[] = [];
		const api = makeHomeApi(
			vi.fn(async () => {
				order.push("retrieve");
				return { type: "person", person: { email: "a@b.c" } };
			}),
		);
		api.waitForPacer = vi.fn(async () => {
			order.push("pacer");
		});
		await retrieveUserEmail(api, "u_paced");
		expect(order).toEqual(["pacer", "retrieve"]);
	});
});
