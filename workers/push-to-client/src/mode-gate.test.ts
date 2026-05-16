import { describe, expect, it } from "vitest";

import { assertModeAllowsPush } from "./mode-gate.js";
import { ProductionPushNotAuthorized } from "./errors.js";

describe("assertModeAllowsPush", () => {
	it("staging mode always passes (no allowProduction needed)", () => {
		expect(() =>
			assertModeAllowsPush({ id: "acme", mode: "staging" }, undefined),
		).not.toThrow();
		expect(() =>
			assertModeAllowsPush({ id: "acme", mode: "staging" }, false),
		).not.toThrow();
		expect(() =>
			assertModeAllowsPush({ id: "acme", mode: "staging" }, true),
		).not.toThrow();
	});

	it("production mode requires allowProduction === true", () => {
		expect(() =>
			assertModeAllowsPush({ id: "acme", mode: "production" }, true),
		).not.toThrow();
	});

	it("production mode throws without allowProduction", () => {
		for (const arg of [undefined, null, false]) {
			expect(() =>
				assertModeAllowsPush({ id: "acme", mode: "production" }, arg),
			).toThrowError(ProductionPushNotAuthorized);
		}
	});

	it("the thrown error carries the clientId", () => {
		try {
			assertModeAllowsPush({ id: "acme", mode: "production" }, undefined);
			expect.unreachable("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(ProductionPushNotAuthorized);
			if (e instanceof ProductionPushNotAuthorized) {
				expect(e.clientId).toBe("acme");
			}
		}
	});
});
