/**
 * Pure state-machine helpers for `loomBackfill` (replace) and `loomDelta`
 * (incremental). Lives in its own module so tests don't have to import
 * `index.ts` (which throws if `LOOM_SOURCE_DATABASE_ID` isn't set).
 *
 * Mirrors `ingest-client-notion/src/sync-state.ts` in spirit but simpler:
 * single source DB, so no per-client iteration. Backfill state is just a
 * Notion pagination cursor; delta state tracks the persisted
 * `last_edited_time` watermark plus the current cycle's pagination cursor
 * and max-seen-edited-time.
 */

export const PAGE_SIZE = 50;

// Far-past sentinel used as the initial delta cursor before any data has
// been observed. `1970-01-01T00:00:00.000Z` is the natural ISO zero point —
// Notion accepts it; downstream callers compare it with `>` so it never
// excludes any real edit.
const EPOCH_ISO = new Date(0).toISOString();

// ---- Backfill ----

export type BackfillState =
	| {
			cursor: string | null;
	  }
	| undefined;

export type BackfillStateInitialized = {
	cursor: string | null;
};

export function initBackfillState(state: BackfillState): BackfillStateInitialized {
	if (state) return state;
	return { cursor: null };
}

export function advanceBackfillState(
	_prev: BackfillStateInitialized,
	hasMorePages: boolean,
	nextCursor: string | null,
): BackfillState {
	if (hasMorePages) {
		return { cursor: nextCursor };
	}
	// Cycle complete — return undefined so the runtime starts the next cycle
	// fresh (replace-mode mark-and-sweep happens then).
	return undefined;
}

// ---- Delta ----

export type DeltaCycle = {
	cursor: string | null;
	latestSeen: string | null;
};

export type DeltaState =
	| {
			fromCursor: string;
			cycle?: DeltaCycle;
	  }
	| undefined;

export type DeltaStateInitialized = {
	fromCursor: string;
	cursor: string | null;
	cycle: DeltaCycle;
};

/**
 * Materialize the working state for one delta `execute` call. The
 * `fromCursor` is the persisted watermark we're filtering Notion on; the
 * `cycle` carries within-cycle pagination + latest-seen tracking.
 */
export function initDeltaState(state: DeltaState): DeltaStateInitialized {
	const fromCursor = state?.fromCursor ?? EPOCH_ISO;
	const cycle: DeltaCycle = state?.cycle ?? { cursor: null, latestSeen: null };
	return {
		fromCursor,
		cursor: cycle.cursor,
		cycle,
	};
}

/**
 * Advance state at the end of a delta `execute` call.
 *
 * - Mid-cycle (more pages): keep `fromCursor` and update the cycle's Notion
 *   cursor and `latestSeen`.
 * - End-of-cycle: promote `latestSeen` to the new `fromCursor`, clamped to
 *   `now - bufferMs` so an edit in flight at query time isn't permanently
 *   skipped. Drop the cycle so the next firing starts fresh.
 */
export function advanceDeltaState(
	state: DeltaStateInitialized,
	hasMorePages: boolean,
	pageLatest: string | null,
	nextCursor: string | null,
	now: Date,
	bufferMs: number,
): DeltaState {
	const latestSeen = laterIso(state.cycle.latestSeen, pageLatest);

	if (hasMorePages) {
		return {
			fromCursor: state.fromCursor,
			cycle: { cursor: nextCursor, latestSeen },
		};
	}

	// Cycle complete. Promote the watermark.
	const safeCeiling = new Date(now.getTime() - bufferMs).toISOString();
	const newFromCursor = latestSeen ? earlierIso(latestSeen, safeCeiling) : safeCeiling;
	return { fromCursor: newFromCursor };
}

// ---- Pure helpers ----

function laterIso(a: string | null, b: string | null): string | null {
	if (a == null) return b;
	if (b == null) return a;
	return a > b ? a : b;
}

function earlierIso(a: string, b: string): string {
	return a < b ? a : b;
}
