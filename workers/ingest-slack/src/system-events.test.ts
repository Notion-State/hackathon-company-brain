import { describe, expect, it } from "vitest";
import { SYSTEM_EVENT_SUBTYPES, isSystemEvent, isTombstone } from "./system-events.js";

describe("isSystemEvent", () => {
	it("returns true for every declared system subtype", () => {
		for (const subtype of SYSTEM_EVENT_SUBTYPES) {
			expect(isSystemEvent({ subtype })).toBe(true);
		}
	});

	it("returns false for undefined / null subtype (a normal message)", () => {
		expect(isSystemEvent({})).toBe(false);
		expect(isSystemEvent({ subtype: undefined })).toBe(false);
		expect(isSystemEvent({ subtype: null })).toBe(false);
	});

	it("returns false for content-bearing subtypes that must not be filtered", () => {
		expect(isSystemEvent({ subtype: "bot_message" })).toBe(false);
		expect(isSystemEvent({ subtype: "me_message" })).toBe(false);
		expect(isSystemEvent({ subtype: "thread_broadcast" })).toBe(false);
		expect(isSystemEvent({ subtype: "file_share" })).toBe(false);
	});

	it("returns false for unknown subtypes (fail-open: prefer over-inclusion to silent drops)", () => {
		expect(isSystemEvent({ subtype: "some_future_subtype" })).toBe(false);
	});
});

describe("isTombstone", () => {
	it("returns true only for the tombstone subtype", () => {
		expect(isTombstone({ subtype: "tombstone" })).toBe(true);
	});

	it("returns false for other subtypes and for missing subtype", () => {
		expect(isTombstone({})).toBe(false);
		expect(isTombstone({ subtype: "channel_join" })).toBe(false);
		expect(isTombstone({ subtype: "bot_message" })).toBe(false);
	});
});
