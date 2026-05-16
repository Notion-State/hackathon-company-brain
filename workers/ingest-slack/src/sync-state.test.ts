import { describe, expect, it } from "vitest";
import {
	advanceBackfillState,
	advanceDeltaState,
	clampInt,
	earlierTs,
	initBackfillState,
	initDeltaState,
	isoToSlackTs,
	laterTs,
	nextChannelsState,
	slackTsToIso,
} from "./sync-state.js";

const NOW = new Date("2026-05-15T12:00:00.000Z");

describe("nextChannelsState", () => {
	it("returns undefined when no more pages (cycle complete)", () => {
		expect(nextChannelsState(undefined)).toBeUndefined();
		expect(nextChannelsState("")).toBeUndefined();
	});

	it("carries the cursor forward when more pages remain", () => {
		expect(nextChannelsState("abc123")).toEqual({ listCursor: "abc123" });
	});
});

describe("backfill state", () => {
	const CHANNELS = ["C001", "C002", "C003"];

	it("init seeds fromTs at now - backfillDays and freezes the channel set", () => {
		const s = initBackfillState(undefined, CHANNELS, 30, NOW);
		expect(s.channelIds).toEqual(CHANNELS);
		expect(s.currentIndex).toBe(0);
		expect(s.historyCursor).toBeUndefined();
		// 30 days back from 2026-05-15 = 2026-04-15
		expect(slackTsToIso(s.fromTs)).toBe("2026-04-15T12:00:00.000Z");
	});

	it("init passes through an existing state (cycle in flight)", () => {
		const existing = { channelIds: ["X"], currentIndex: 0, fromTs: "1.000000", historyCursor: "abc" };
		expect(initBackfillState(existing, CHANNELS, 30, NOW)).toBe(existing);
	});

	it("advance keeps the same channel when more history pages remain", () => {
		const s = initBackfillState(undefined, CHANNELS, 30, NOW);
		const next = advanceBackfillState(s, "cursor-page-2");
		expect(next).toEqual({
			channelIds: CHANNELS,
			currentIndex: 0,
			historyCursor: "cursor-page-2",
			fromTs: s.fromTs,
		});
	});

	it("advance moves to next channel when history exhausts", () => {
		const s = initBackfillState(undefined, CHANNELS, 30, NOW);
		const next = advanceBackfillState(s, undefined);
		expect(next).toEqual({
			channelIds: CHANNELS,
			currentIndex: 1,
			historyCursor: undefined,
			fromTs: s.fromTs,
		});
	});

	it("advance returns undefined when last channel finishes", () => {
		const s = initBackfillState(undefined, CHANNELS, 30, NOW);
		const final = { ...s, currentIndex: CHANNELS.length - 1 };
		expect(advanceBackfillState(final, undefined)).toBeUndefined();
	});

	it("first init with empty channel list yields immediate cycle-end on advance", () => {
		const s = initBackfillState(undefined, [], 30, NOW);
		expect(s.channelIds).toEqual([]);
		expect(advanceBackfillState(s, undefined)).toBeUndefined();
	});
});

describe("delta state", () => {
	const CHANNELS = ["C001", "C002"];
	const BUFFER_MS = 60_000;

	it("init seeds missing per-channel cursors at now - backfillDays", () => {
		const s = initDeltaState(undefined, CHANNELS, 30, NOW);
		expect(slackTsToIso(s.cursorByChannel.C001!)).toBe("2026-04-15T12:00:00.000Z");
		expect(slackTsToIso(s.cursorByChannel.C002!)).toBe("2026-04-15T12:00:00.000Z");
		expect(s.cycle?.pendingChannelIds).toEqual(CHANNELS);
	});

	it("init preserves existing cursors and only seeds newcomers", () => {
		const existing = {
			cursorByChannel: { C001: "1715000000.000000" },
			cycle: undefined,
		};
		const s = initDeltaState(existing, CHANNELS, 30, NOW);
		expect(s.cursorByChannel.C001).toBe("1715000000.000000");
		expect(slackTsToIso(s.cursorByChannel.C002!)).toBe("2026-04-15T12:00:00.000Z");
	});

	it("init starts a new cycle when none in progress", () => {
		const s = initDeltaState({ cursorByChannel: {} }, CHANNELS, 30, NOW);
		expect(s.cycle).toEqual({
			pendingChannelIds: CHANNELS,
			historyCursor: undefined,
			latestTsInCurrentChannel: null,
		});
	});

	it("advance: more history pages → carry cursor, track max ts", () => {
		const s = initDeltaState(undefined, CHANNELS, 30, NOW);
		const next = advanceDeltaState(s, "next-cursor", "1747008000.000000", NOW, BUFFER_MS);
		expect(next.cycle?.pendingChannelIds).toEqual(CHANNELS);
		expect(next.cycle?.historyCursor).toBe("next-cursor");
		expect(next.cycle?.latestTsInCurrentChannel).toBe("1747008000.000000");
	});

	it("advance: max ts accumulates across pages, then commits clamped to safe ceiling", () => {
		let s = initDeltaState(undefined, CHANNELS, 30, NOW);
		// Page 1: ts way in the future relative to NOW
		s = advanceDeltaState(s, "p2", "9999999999.000000", NOW, BUFFER_MS);
		expect(s.cycle?.latestTsInCurrentChannel).toBe("9999999999.000000");
		// Page 2 (final): commit cursor — must be clamped to NOW - bufferMs because the seen ts is past the safe ceiling
		s = advanceDeltaState(s, undefined, "1700000000.000000", NOW, BUFFER_MS);
		const expectedCeiling = isoToSlackTs(new Date(NOW.getTime() - BUFFER_MS));
		expect(s.cursorByChannel.C001).toBe(expectedCeiling);
		// And move on to C002
		expect(s.cycle?.pendingChannelIds).toEqual(["C002"]);
	});

	it("advance: empty channel (no activity) still bumps cursor to safe ceiling", () => {
		const s = initDeltaState(undefined, CHANNELS, 30, NOW);
		const next = advanceDeltaState(s, undefined, null, NOW, BUFFER_MS);
		const expectedCeiling = isoToSlackTs(new Date(NOW.getTime() - BUFFER_MS));
		expect(next.cursorByChannel.C001).toBe(expectedCeiling);
	});

	it("advance: last channel finishing clears the cycle (no cycle field)", () => {
		let s = initDeltaState(undefined, ["C001"], 30, NOW);
		s = advanceDeltaState(s, undefined, "1746000000.000000", NOW, BUFFER_MS);
		expect(s.cycle).toBeUndefined();
		expect(s.cursorByChannel.C001).toBe("1746000000.000000");
	});

	it("advance: returns input unchanged when there is no active cycle", () => {
		const noCycle = { cursorByChannel: { C001: "1.000000" } };
		const next = advanceDeltaState(noCycle, "x", "2.000000", NOW, BUFFER_MS);
		expect(next).toEqual(noCycle);
	});
});

describe("clampInt", () => {
	it("returns fallback for unset/non-numeric input", () => {
		expect(clampInt(undefined, { fallback: 30, min: 1, max: 100 })).toBe(30);
		expect(clampInt("abc", { fallback: 30, min: 1, max: 100 })).toBe(30);
	});

	it("clamps to [min, max]", () => {
		expect(clampInt("0", { fallback: 30, min: 1, max: 100 })).toBe(1);
		expect(clampInt("999", { fallback: 30, min: 1, max: 100 })).toBe(100);
		expect(clampInt("50", { fallback: 30, min: 1, max: 100 })).toBe(50);
	});
});

describe("ts conversion helpers", () => {
	it("isoToSlackTs / slackTsToIso roundtrip a Date", () => {
		const d = new Date("2026-05-15T12:34:56.789Z");
		expect(slackTsToIso(isoToSlackTs(d))).toBe(d.toISOString());
	});

	it("laterTs is null-safe and picks the larger ts", () => {
		expect(laterTs(null, null)).toBeNull();
		expect(laterTs("1.0", null)).toBe("1.0");
		expect(laterTs(null, "1.0")).toBe("1.0");
		expect(laterTs("1715000000.000000", "1747000000.000000")).toBe("1747000000.000000");
	});

	it("earlierTs picks the smaller ts (lexicographic = numeric for fixed-width slack ts)", () => {
		expect(earlierTs("1715000000.000000", "1747000000.000000")).toBe("1715000000.000000");
	});
});
