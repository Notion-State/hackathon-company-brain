import { describe, expect, it } from "vitest";

import {
	advanceBackfillState,
	advanceDeltaState,
	clampInt,
	initBackfillState,
	initDeltaState,
	PAGE_SIZE,
} from "./sync-state.js";

const NOW = new Date("2026-05-15T12:00:00.000Z");
const BUFFER_MS = 60 * 60 * 1000; // 1h

describe("clampInt", () => {
	it("falls back when undefined", () => {
		expect(clampInt(undefined, { fallback: 30, min: 1, max: 100 })).toBe(30);
	});
	it("falls back when not numeric", () => {
		expect(clampInt("abc", { fallback: 30, min: 1, max: 100 })).toBe(30);
	});
	it("clamps to min and max", () => {
		expect(clampInt("0", { fallback: 30, min: 1, max: 100 })).toBe(1);
		expect(clampInt("999", { fallback: 30, min: 1, max: 100 })).toBe(100);
		expect(clampInt("50", { fallback: 30, min: 1, max: 100 })).toBe(50);
	});
});

describe("backfill state machine — single account", () => {
	const accounts = ["default"];

	it("initializes from undefined: all accounts pending, skip=0, fromDate=now-30d", () => {
		const state = initBackfillState(undefined, accounts, 30, NOW);
		expect(state.pendingAccountIds).toEqual(["default"]);
		expect(state.currentSkip).toBe(0);
		expect(state.fromDate).toBe(new Date(NOW.getTime() - 30 * 86400_000).toISOString());
	});

	it("advances skip when more pages remain for current account", () => {
		const state = { pendingAccountIds: ["default"], currentSkip: 0, fromDate: "f" };
		const next = advanceBackfillState(state, true);
		expect(next).toEqual({ pendingAccountIds: ["default"], currentSkip: PAGE_SIZE, fromDate: "f" });
	});

	it("returns undefined when last account finishes (cycle complete)", () => {
		const state = { pendingAccountIds: ["default"], currentSkip: 0, fromDate: "f" };
		const next = advanceBackfillState(state, false);
		expect(next).toBeUndefined();
	});
});

describe("backfill state machine — multi-account", () => {
	const accounts = ["acme", "default"];

	it("initializes with all configured accounts pending in input order", () => {
		const state = initBackfillState(undefined, accounts, 30, NOW);
		expect(state.pendingAccountIds).toEqual(["acme", "default"]);
		expect(state.currentSkip).toBe(0);
	});

	it("shifts to next account when first completes; skip resets", () => {
		const state = { pendingAccountIds: ["acme", "default"], currentSkip: 100, fromDate: "f" };
		const next = advanceBackfillState(state, false);
		expect(next).toEqual({ pendingAccountIds: ["default"], currentSkip: 0, fromDate: "f" });
	});

	it("returns undefined only after all accounts complete", () => {
		const stateA = advanceBackfillState({ pendingAccountIds: ["acme", "default"], currentSkip: 0, fromDate: "f" }, false);
		expect(stateA?.pendingAccountIds).toEqual(["default"]);
		const stateB = advanceBackfillState(stateA!, false);
		expect(stateB).toBeUndefined();
	});

	it("keeps the current account pending when hasMorePages is true", () => {
		const state = { pendingAccountIds: ["acme", "default"], currentSkip: 0, fromDate: "f" };
		const next = advanceBackfillState(state, true);
		expect(next?.pendingAccountIds).toEqual(["acme", "default"]);
		expect(next?.currentSkip).toBe(PAGE_SIZE);
	});
});

describe("delta state machine — single account", () => {
	const accounts = ["default"];

	it("seeds cursor at now-Nd on first run and starts a cycle", () => {
		const state = initDeltaState(undefined, accounts, 30, NOW);
		expect(state.cursorByAccount.default).toBe(new Date(NOW.getTime() - 30 * 86400_000).toISOString());
		expect(state.cycle?.pendingAccountIds).toEqual(["default"]);
		expect(state.cycle?.skip).toBe(0);
		expect(state.cycle?.latestDateInCurrentAccount).toBeNull();
	});

	it("preserves an existing cursor and starts a fresh cycle", () => {
		const stored = { cursorByAccount: { default: "2026-05-14T11:00:00.000Z" } };
		const state = initDeltaState(stored, accounts, 30, NOW);
		expect(state.cursorByAccount.default).toBe("2026-05-14T11:00:00.000Z");
		expect(state.cycle?.pendingAccountIds).toEqual(["default"]);
	});

	it("advances skip and tracks latestDate within cycle when more pages remain", () => {
		const state = {
			cursorByAccount: { default: "2026-05-14T11:00:00.000Z" },
			cycle: { pendingAccountIds: ["default"], skip: 0, latestDateInCurrentAccount: null as string | null },
		};
		const next = advanceDeltaState(state, true, "2026-05-15T08:00:00.000Z", NOW, BUFFER_MS);
		expect(next.cycle?.skip).toBe(PAGE_SIZE);
		expect(next.cycle?.latestDateInCurrentAccount).toBe("2026-05-15T08:00:00.000Z");
		// Cursor unchanged until cycle for this account completes
		expect(next.cursorByAccount.default).toBe("2026-05-14T11:00:00.000Z");
	});

	it("advances cursor to min(latestSeen, now - buffer) when account completes", () => {
		const state = {
			cursorByAccount: { default: "2026-05-14T11:00:00.000Z" },
			cycle: { pendingAccountIds: ["default"], skip: 0, latestDateInCurrentAccount: "2026-05-15T08:00:00.000Z" },
		};
		const next = advanceDeltaState(state, false, null, NOW, BUFFER_MS);
		// now - 1h = 11:00. latestSeen = 08:00. min = 08:00.
		expect(next.cursorByAccount.default).toBe("2026-05-15T08:00:00.000Z");
		// Cycle cleared.
		expect(next.cycle).toBeUndefined();
	});

	it("caps cursor at (now - buffer) even when latestSeen is more recent", () => {
		const state = {
			cursorByAccount: { default: "2026-05-14T11:00:00.000Z" },
			cycle: { pendingAccountIds: ["default"], skip: 0, latestDateInCurrentAccount: "2026-05-15T11:55:00.000Z" },
		};
		const next = advanceDeltaState(state, false, null, NOW, BUFFER_MS);
		// safeCeiling = NOW - 1h = 11:00. latestSeen = 11:55. min = 11:00.
		expect(next.cursorByAccount.default).toBe("2026-05-15T11:00:00.000Z");
	});

	it("advances cursor to (now - buffer) when no records were seen this cycle", () => {
		const state = {
			cursorByAccount: { default: "2026-05-14T11:00:00.000Z" },
			cycle: { pendingAccountIds: ["default"], skip: 0, latestDateInCurrentAccount: null as string | null },
		};
		const next = advanceDeltaState(state, false, null, NOW, BUFFER_MS);
		expect(next.cursorByAccount.default).toBe("2026-05-15T11:00:00.000Z");
	});
});

describe("delta state machine — multi-account", () => {
	const accounts = ["acme", "default"];

	it("seeds cursors for all newly configured accounts", () => {
		const state = initDeltaState(undefined, accounts, 30, NOW);
		expect(Object.keys(state.cursorByAccount).sort()).toEqual(["acme", "default"]);
	});

	it("preserves existing cursors and seeds only the new account", () => {
		const stored = { cursorByAccount: { default: "2026-05-14T00:00:00.000Z" } };
		const state = initDeltaState(stored, accounts, 30, NOW);
		expect(state.cursorByAccount.default).toBe("2026-05-14T00:00:00.000Z");
		expect(state.cursorByAccount.acme).toBe(new Date(NOW.getTime() - 30 * 86400_000).toISOString());
	});

	it("processes accounts in order; advances first account's cursor before moving to second", () => {
		// Start: cycle pending [acme, default]
		const state0 = {
			cursorByAccount: { acme: "2026-05-14T00:00:00.000Z", default: "2026-05-14T00:00:00.000Z" },
			cycle: { pendingAccountIds: ["acme", "default"], skip: 0, latestDateInCurrentAccount: null as string | null },
		};
		// Acme returns one page short, latestDate seen = 09:00
		const state1 = advanceDeltaState(state0, false, "2026-05-15T09:00:00.000Z", NOW, BUFFER_MS);
		expect(state1.cursorByAccount.acme).toBe("2026-05-15T09:00:00.000Z");
		expect(state1.cursorByAccount.default).toBe("2026-05-14T00:00:00.000Z"); // unchanged
		expect(state1.cycle?.pendingAccountIds).toEqual(["default"]);
		expect(state1.cycle?.skip).toBe(0);

		// Default returns one page short with no records — cursor → safeCeiling
		const state2 = advanceDeltaState(state1, false, null, NOW, BUFFER_MS);
		expect(state2.cursorByAccount.default).toBe("2026-05-15T11:00:00.000Z"); // now - 1h
		expect(state2.cycle).toBeUndefined();
	});

	it("returns idle state (no cycle) when called with an empty pending list", () => {
		const state = {
			cursorByAccount: { acme: "x", default: "y" },
			cycle: { pendingAccountIds: [], skip: 0, latestDateInCurrentAccount: null as string | null },
		};
		const next = advanceDeltaState(state, false, null, NOW, BUFFER_MS);
		expect(next.cycle).toBeUndefined();
		expect(next.cursorByAccount).toEqual({ acme: "x", default: "y" });
	});
});
