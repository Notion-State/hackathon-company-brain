import { describe, expect, it } from "vitest";
import {
	advanceBackfillState,
	advanceDeltaState,
	clampInt,
	initBackfillState,
	initDeltaState,
	skipCurrentDeltaClient,
} from "./sync-state.js";

const NOW = new Date("2026-05-16T12:00:00.000Z");
const BUFFER_MS = 60_000;

describe("initBackfillState", () => {
	it("seeds with all client ids and a null cursor on first run", () => {
		const state = initBackfillState(undefined, ["acme", "beta"]);
		expect(state).toEqual({ pendingClientIds: ["acme", "beta"], cursor: null });
	});

	it("returns existing state untouched", () => {
		const existing = { pendingClientIds: ["beta"], cursor: "abc" };
		expect(initBackfillState(existing, ["acme", "beta"])).toBe(existing);
	});
});

describe("advanceBackfillState", () => {
	it("keeps the same client and advances cursor when more pages remain", () => {
		const next = advanceBackfillState(
			{ pendingClientIds: ["acme", "beta"], cursor: null },
			true,
			"page2",
		);
		expect(next).toEqual({ pendingClientIds: ["acme", "beta"], cursor: "page2" });
	});

	it("pops the head client and resets cursor when no more pages and more clients remain", () => {
		const next = advanceBackfillState(
			{ pendingClientIds: ["acme", "beta"], cursor: "page9" },
			false,
			null,
		);
		expect(next).toEqual({ pendingClientIds: ["beta"], cursor: null });
	});

	it("returns undefined when the last client finishes", () => {
		const next = advanceBackfillState(
			{ pendingClientIds: ["acme"], cursor: "page9" },
			false,
			null,
		);
		expect(next).toBeUndefined();
	});
});

describe("initDeltaState", () => {
	it("seeds cursors at now-initialBackfillDays for unseen clients on first run", () => {
		const state = initDeltaState(undefined, ["acme", "beta"], 30, NOW);
		const expected = new Date(NOW.getTime() - 30 * 86400_000).toISOString();
		expect(state.cursorByClient).toEqual({ acme: expected, beta: expected });
		expect(state.cycle).toEqual({
			pendingClientIds: ["acme", "beta"],
			cursor: null,
			latestEditedInCurrentClient: null,
		});
	});

	it("preserves existing cursors and only seeds new clients", () => {
		const state = initDeltaState(
			{ cursorByClient: { acme: "2026-04-01T00:00:00.000Z" } },
			["acme", "beta"],
			30,
			NOW,
		);
		const seeded = new Date(NOW.getTime() - 30 * 86400_000).toISOString();
		expect(state.cursorByClient).toEqual({
			acme: "2026-04-01T00:00:00.000Z",
			beta: seeded,
		});
	});

	it("starts a fresh cycle when none is in progress", () => {
		const state = initDeltaState(
			{ cursorByClient: { acme: "x", beta: "y" } },
			["acme", "beta"],
			30,
			NOW,
		);
		expect(state.cycle).toEqual({
			pendingClientIds: ["acme", "beta"],
			cursor: null,
			latestEditedInCurrentClient: null,
		});
	});

	it("preserves an in-progress cycle untouched", () => {
		const cycle = { pendingClientIds: ["beta"], cursor: "page5", latestEditedInCurrentClient: "2026-05-15T00:00:00.000Z" };
		const state = initDeltaState(
			{ cursorByClient: { acme: "x", beta: "y" }, cycle },
			["acme", "beta"],
			30,
			NOW,
		);
		expect(state.cycle).toBe(cycle);
	});
});

describe("advanceDeltaState", () => {
	it("advances pagination cursor and tracks latest edited within a client", () => {
		const next = advanceDeltaState(
			{
				cursorByClient: { acme: "a", beta: "b" },
				cycle: { pendingClientIds: ["acme", "beta"], cursor: null, latestEditedInCurrentClient: null },
			},
			true,
			"2026-05-16T11:00:00.000Z",
			"page2",
			NOW,
			BUFFER_MS,
		);
		expect(next.cycle).toEqual({
			pendingClientIds: ["acme", "beta"],
			cursor: "page2",
			latestEditedInCurrentClient: "2026-05-16T11:00:00.000Z",
		});
		expect(next.cursorByClient).toEqual({ acme: "a", beta: "b" });
	});

	it("keeps the later of (existing-in-cycle, new-page) when tracking latestEdited", () => {
		const next = advanceDeltaState(
			{
				cursorByClient: { acme: "a" },
				cycle: { pendingClientIds: ["acme"], cursor: "p1", latestEditedInCurrentClient: "2026-05-16T11:30:00.000Z" },
			},
			true,
			"2026-05-16T11:00:00.000Z", // earlier than existing
			"p2",
			NOW,
			BUFFER_MS,
		);
		expect(next.cycle?.latestEditedInCurrentClient).toBe("2026-05-16T11:30:00.000Z");
	});

	it("finalizes the active client's cursor at min(latestSeen, now-buffer), pops, moves to next", () => {
		const latestSeen = "2026-05-16T11:30:00.000Z"; // earlier than now-60s
		const next = advanceDeltaState(
			{
				cursorByClient: { acme: "a", beta: "b" },
				cycle: { pendingClientIds: ["acme", "beta"], cursor: "p3", latestEditedInCurrentClient: latestSeen },
			},
			false,
			null,
			null,
			NOW,
			BUFFER_MS,
		);
		expect(next.cursorByClient.acme).toBe(latestSeen);
		expect(next.cursorByClient.beta).toBe("b");
		expect(next.cycle).toEqual({
			pendingClientIds: ["beta"],
			cursor: null,
			latestEditedInCurrentClient: null,
		});
	});

	it("caps the new cursor at now-buffer when latestSeen is in the future relative to it", () => {
		// latestSeen exactly at NOW — must be capped at NOW - bufferMs
		const next = advanceDeltaState(
			{
				cursorByClient: { acme: "a" },
				cycle: { pendingClientIds: ["acme"], cursor: null, latestEditedInCurrentClient: NOW.toISOString() },
			},
			false,
			null,
			null,
			NOW,
			BUFFER_MS,
		);
		const safeCeiling = new Date(NOW.getTime() - BUFFER_MS).toISOString();
		expect(next.cursorByClient.acme).toBe(safeCeiling);
	});

	it("uses now-buffer as the cursor when no records were seen this cycle", () => {
		const next = advanceDeltaState(
			{
				cursorByClient: { acme: "a" },
				cycle: { pendingClientIds: ["acme"], cursor: null, latestEditedInCurrentClient: null },
			},
			false,
			null,
			null,
			NOW,
			BUFFER_MS,
		);
		const safeCeiling = new Date(NOW.getTime() - BUFFER_MS).toISOString();
		expect(next.cursorByClient.acme).toBe(safeCeiling);
	});

	it("clears the cycle when the last client finishes", () => {
		const next = advanceDeltaState(
			{
				cursorByClient: { acme: "a" },
				cycle: { pendingClientIds: ["acme"], cursor: null, latestEditedInCurrentClient: null },
			},
			false,
			null,
			null,
			NOW,
			BUFFER_MS,
		);
		expect(next.cycle).toBeUndefined();
	});

	it("returns idle (cycle: undefined) state unchanged", () => {
		const next = advanceDeltaState(
			{ cursorByClient: { acme: "a" } },
			false,
			null,
			null,
			NOW,
			BUFFER_MS,
		);
		expect(next).toEqual({ cursorByClient: { acme: "a" } });
	});
});

describe("skipCurrentDeltaClient", () => {
	it("pops the active client and resets cycle scratch state, leaving cursors untouched", () => {
		const next = skipCurrentDeltaClient({
			cursorByClient: { acme: "a", beta: "b" },
			cycle: { pendingClientIds: ["acme", "beta"], cursor: "p3", latestEditedInCurrentClient: "2026-05-16T11:30:00.000Z" },
		});
		expect(next.cursorByClient).toEqual({ acme: "a", beta: "b" });
		expect(next.cycle).toEqual({
			pendingClientIds: ["beta"],
			cursor: null,
			latestEditedInCurrentClient: null,
		});
	});

	it("clears the cycle when the active client was the last one", () => {
		const next = skipCurrentDeltaClient({
			cursorByClient: { acme: "a" },
			cycle: { pendingClientIds: ["acme"], cursor: "p3", latestEditedInCurrentClient: "x" },
		});
		expect(next.cursorByClient).toEqual({ acme: "a" });
		expect(next.cycle).toBeUndefined();
	});

	it("returns idle state unchanged", () => {
		const idle = { cursorByClient: { acme: "a" } };
		expect(skipCurrentDeltaClient(idle)).toBe(idle);
	});
});

describe("clampInt", () => {
	it("uses fallback when raw is undefined", () => {
		expect(clampInt(undefined, { fallback: 30, min: 1, max: 100 })).toBe(30);
	});

	it("uses fallback when raw is not a number", () => {
		expect(clampInt("abc", { fallback: 30, min: 1, max: 100 })).toBe(30);
	});

	it("clamps to min", () => {
		expect(clampInt("-5", { fallback: 30, min: 1, max: 100 })).toBe(1);
	});

	it("clamps to max", () => {
		expect(clampInt("9999", { fallback: 30, min: 1, max: 100 })).toBe(100);
	});

	it("returns the integer when in range", () => {
		expect(clampInt("42", { fallback: 30, min: 1, max: 100 })).toBe(42);
	});
});
