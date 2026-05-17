import { describe, expect, it } from "vitest";

import { RateLimiter } from "./notion-client.js";

/**
 * Each test injects a fake clock and a fake scheduler so we observe the
 * pacing algorithm without sleeping or monkey-patching globals.
 */

function makeFakes() {
	let clock = 1_000_000;
	const delays: number[] = [];
	return {
		now: () => clock,
		advance: (ms: number) => {
			clock += ms;
		},
		schedule: (ms: number): Promise<void> => {
			delays.push(ms);
			clock += ms; // fake scheduler: time jumps forward by the delay
			return Promise.resolve();
		},
		delays,
	};
}

describe("RateLimiter", () => {
	it("returns immediately on the first call (no delay scheduled)", async () => {
		const fakes = makeFakes();
		const limiter = new RateLimiter(
			{ allowedRequests: 3, intervalMs: 1000 },
			{ now: fakes.now, schedule: fakes.schedule },
		);
		await limiter.wait();
		expect(fakes.delays).toEqual([]);
	});

	it("paces consecutive calls at ceil(intervalMs / allowedRequests) apart", async () => {
		const fakes = makeFakes();
		const limiter = new RateLimiter(
			{ allowedRequests: 3, intervalMs: 1000 },
			{ now: fakes.now, schedule: fakes.schedule },
		);
		await limiter.wait();
		await limiter.wait();
		await limiter.wait();
		// paceMs = ceil(1000/3) = 334. First call: 0 delay. Second + third: 334 each
		// (the fake scheduler advances the clock so the next call's delay is again 334).
		expect(fakes.delays).toEqual([334, 334]);
	});

	it("does not delay when enough real time has elapsed between calls", async () => {
		const fakes = makeFakes();
		const limiter = new RateLimiter(
			{ allowedRequests: 3, intervalMs: 1000 },
			{ now: fakes.now, schedule: fakes.schedule },
		);
		await limiter.wait();
		fakes.advance(500); // > paceMs (334)
		await limiter.wait();
		fakes.advance(500);
		await limiter.wait();
		expect(fakes.delays).toEqual([]);
	});

	it("each instance has its own state (per-client isolation)", async () => {
		const fakesA = makeFakes();
		const fakesB = makeFakes();
		const a = new RateLimiter(
			{ allowedRequests: 3, intervalMs: 1000 },
			{ now: fakesA.now, schedule: fakesA.schedule },
		);
		const b = new RateLimiter(
			{ allowedRequests: 3, intervalMs: 1000 },
			{ now: fakesB.now, schedule: fakesB.schedule },
		);
		await a.wait();
		await a.wait();
		await b.wait();
		await b.wait();
		expect(fakesA.delays).toEqual([334]);
		expect(fakesB.delays).toEqual([334]);
	});

	it("rejects invalid configurations at construction time", () => {
		expect(() => new RateLimiter({ allowedRequests: 0, intervalMs: 1000 })).toThrow(
			/allowedRequests/,
		);
		expect(() => new RateLimiter({ allowedRequests: 3, intervalMs: 0 })).toThrow(
			/intervalMs/,
		);
		expect(() => new RateLimiter({ allowedRequests: -1, intervalMs: 1000 })).toThrow();
		expect(() => new RateLimiter({ allowedRequests: NaN, intervalMs: 1000 })).toThrow();
		expect(() => new RateLimiter({ allowedRequests: 3, intervalMs: NaN })).toThrow();
	});
});
