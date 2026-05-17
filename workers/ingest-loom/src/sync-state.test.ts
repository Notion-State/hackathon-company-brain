import { describe, expect, it } from "vitest";

import {
	advanceBackfillState,
	advanceDeltaState,
	initBackfillState,
	initDeltaState,
} from "./sync-state.js";

describe("backfill state", () => {
	it("initializes with null cursor on first run", () => {
		expect(initBackfillState(undefined)).toEqual({ cursor: null });
	});

	it("preserves an existing state", () => {
		const existing = { cursor: "abc" };
		expect(initBackfillState(existing)).toBe(existing);
	});

	it("advances the cursor when more pages remain", () => {
		expect(advanceBackfillState({ cursor: null }, true, "next-cursor-123")).toEqual({
			cursor: "next-cursor-123",
		});
	});

	it("returns undefined when the cycle is complete", () => {
		expect(advanceBackfillState({ cursor: "anything" }, false, null)).toBeUndefined();
	});
});

describe("delta state", () => {
	const now = new Date("2026-05-16T12:00:00.000Z");
	const bufferMs = 60_000;

	it("initializes with EPOCH cursor and empty cycle on first run", () => {
		const init = initDeltaState(undefined);
		expect(init.fromCursor).toBe("1970-01-01T00:00:00.000Z");
		expect(init.cursor).toBeNull();
		expect(init.cycle).toEqual({ cursor: null, latestSeen: null });
	});

	it("resumes mid-cycle pagination from prior state", () => {
		const prior = {
			fromCursor: "2026-05-16T10:00:00.000Z",
			cycle: { cursor: "page-cursor-2", latestSeen: "2026-05-16T11:30:00.000Z" },
		};
		const init = initDeltaState(prior);
		expect(init.fromCursor).toBe("2026-05-16T10:00:00.000Z");
		expect(init.cursor).toBe("page-cursor-2");
		expect(init.cycle.latestSeen).toBe("2026-05-16T11:30:00.000Z");
	});

	it("advances within a cycle by storing the next page cursor and latestSeen", () => {
		const state = initDeltaState({ fromCursor: "2026-05-16T10:00:00.000Z" });
		const next = advanceDeltaState(state, true, "2026-05-16T11:45:00.000Z", "next-cursor", now, bufferMs);
		expect(next).toEqual({
			fromCursor: "2026-05-16T10:00:00.000Z",
			cycle: { cursor: "next-cursor", latestSeen: "2026-05-16T11:45:00.000Z" },
		});
	});

	it("at end-of-cycle, promotes latestSeen to the new fromCursor", () => {
		const state = initDeltaState({
			fromCursor: "2026-05-16T10:00:00.000Z",
			cycle: { cursor: null, latestSeen: "2026-05-16T11:00:00.000Z" },
		});
		const next = advanceDeltaState(state, false, "2026-05-16T11:30:00.000Z", null, now, bufferMs);
		expect(next).toEqual({ fromCursor: "2026-05-16T11:30:00.000Z" });
	});

	it("clamps the new fromCursor to now - buffer when latestSeen is later than safe ceiling", () => {
		const state = initDeltaState({ fromCursor: "2026-05-16T11:00:00.000Z" });
		// pageLatest is "in the future" relative to now-buffer; expect clamp to safeCeiling.
		const next = advanceDeltaState(state, false, "2026-05-16T11:59:30.000Z", null, now, bufferMs);
		expect(next).toEqual({ fromCursor: "2026-05-16T11:59:00.000Z" });
	});

	it("falls back to now-buffer when no rows were seen in the cycle", () => {
		const state = initDeltaState({ fromCursor: "2026-05-16T10:00:00.000Z" });
		const next = advanceDeltaState(state, false, null, null, now, bufferMs);
		expect(next).toEqual({ fromCursor: "2026-05-16T11:59:00.000Z" });
	});
});
