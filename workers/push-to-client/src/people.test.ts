import { describe, expect, it, vi } from "vitest";

import { APIErrorCode } from "@notionhq/client";

import { IntegrationRevoked } from "./errors.js";
import { makeApiError } from "./fixtures/notion-error.js";
import {
	lazyMap,
	type ClientApi,
	type NotionSdkSubset,
} from "./notion-client.js";
import { loadUsersByEmail, resolveUserByEmail } from "./people.js";

type UserListResponse = {
	results: Array<{
		object?: string;
		id?: string;
		type?: string;
		person?: { email?: string };
		bot?: object;
	}>;
	next_cursor?: string | null;
	has_more?: boolean;
};

function makeApi(opts: { pages: UserListResponse[]; throwsOnCallIndex?: number }) {
	let callIndex = 0;
	const usersList = vi.fn<NotionSdkSubset["users"]["list"]>(async () => {
		if (opts.throwsOnCallIndex === callIndex) {
			callIndex += 1;
			throw makeApiError({
				code: APIErrorCode.Unauthorized,
				status: 401,
				message: "unauthorized",
			});
		}
		const page = opts.pages[callIndex] ?? { results: [] };
		callIndex += 1;
		return page;
	});

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
			list: usersList,
			retrieve: vi.fn(async () => ({})),
		},
	};

	const pacerWait = vi.fn<() => Promise<void>>(async () => undefined);

	const api: ClientApi = {
		id: "acme",
		destDbIdsByType: { Docs: "d", StatusUpdate: "s", Deliverable: "v" },
		mode: "staging",
		waitForPacer: pacerWait,
		sdk,
		usersByEmail: lazyMap(() => loadUsersByEmail(api)),
	};

	return { api, usersList, pacerWait };
}

describe("loadUsersByEmail", () => {
	it("indexes person-typed users by lowercased email", async () => {
		const { api } = makeApi({
			pages: [
				{
					results: [
						{ object: "user", id: "u_alice", type: "person", person: { email: "Alice@Example.com" } },
						{ object: "user", id: "u_bot", type: "bot", bot: {} },
						{ object: "user", id: "u_bob", type: "person", person: { email: "bob@example.com" } },
						{ object: "user", id: "u_noemail", type: "person", person: {} },
					],
					has_more: false,
				},
			],
		});
		const map = await loadUsersByEmail(api);
		expect(map.get("alice@example.com")).toBe("u_alice");
		expect(map.get("bob@example.com")).toBe("u_bob");
		expect(map.size).toBe(2);
	});

	it("paginates across multiple pages of users.list", async () => {
		const { api, usersList } = makeApi({
			pages: [
				{
					results: [{ object: "user", id: "u_1", type: "person", person: { email: "one@x.com" } }],
					has_more: true,
					next_cursor: "cursor_2",
				},
				{
					results: [{ object: "user", id: "u_2", type: "person", person: { email: "two@x.com" } }],
					has_more: false,
				},
			],
		});
		const map = await loadUsersByEmail(api);
		expect(map.size).toBe(2);
		expect(usersList).toHaveBeenCalledTimes(2);
	});

	it("translates 401 into IntegrationRevoked", async () => {
		const { api } = makeApi({
			pages: [{ results: [], has_more: false }],
			throwsOnCallIndex: 0,
		});
		await expect(loadUsersByEmail(api)).rejects.toBeInstanceOf(IntegrationRevoked);
	});
});

describe("resolveUserByEmail (with lazy cache)", () => {
	it("looks up via the api's lazy map and returns the id", async () => {
		const { api } = makeApi({
			pages: [
				{
					results: [
						{ object: "user", id: "u_alice", type: "person", person: { email: "alice@x.com" } },
					],
					has_more: false,
				},
			],
		});
		expect(await resolveUserByEmail(api, "Alice@x.com")).toBe("u_alice");
	});

	it("returns null for unknown email", async () => {
		const { api } = makeApi({
			pages: [{ results: [], has_more: false }],
		});
		expect(await resolveUserByEmail(api, "ghost@x.com")).toBeNull();
	});

	it("returns null for empty input without an SDK call", async () => {
		const { api, usersList } = makeApi({ pages: [{ results: [], has_more: false }] });
		expect(await resolveUserByEmail(api, "   ")).toBeNull();
		expect(usersList).not.toHaveBeenCalled();
	});

	it("caches the map across calls: one SDK fetch per ClientApi lifetime", async () => {
		const { api, usersList } = makeApi({
			pages: [
				{
					results: [{ object: "user", id: "u_1", type: "person", person: { email: "one@x.com" } }],
					has_more: false,
				},
			],
		});
		await resolveUserByEmail(api, "one@x.com");
		await resolveUserByEmail(api, "one@x.com");
		await resolveUserByEmail(api, "nobody@x.com");
		expect(usersList).toHaveBeenCalledTimes(1);
	});
});
