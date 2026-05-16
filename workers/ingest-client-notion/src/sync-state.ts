/**
 * Pure state-machine helpers for the backfill + delta syncs. Live in their own
 * module so tests can import them without triggering `index.ts`'s module-init
 * client enumeration (which reads `process.env`).
 *
 * Mirrors the shape of `workers/ingest-fireflies/src/sync-state.ts`, with two
 * differences:
 *   1. The pagination cursor is Notion's opaque `next_cursor` string (nullable),
 *      not a numeric `skip`.
 *   2. Backfill state has no `fromDate` — it's a full sweep of each client's
 *      data source. `initialBackfillDays` only seeds the delta cursor on first
 *      run (so we don't pull years of history the first time delta wakes up).
 */

export const PAGE_SIZE = 50;

export type BackfillState =
	| {
			pendingClientIds: string[];
			cursor: string | null;
	  }
	| undefined;

export type BackfillStateInitialized = {
	pendingClientIds: string[];
	cursor: string | null;
};

export type DeltaCycle = {
	pendingClientIds: string[];
	cursor: string | null;
	latestEditedInCurrentClient: string | null;
};

export type DeltaState =
	| {
			cursorByClient: Record<string, string>;
			cycle?: DeltaCycle;
	  }
	| undefined;

export type DeltaStateInitialized = {
	cursorByClient: Record<string, string>;
	cycle?: DeltaCycle;
};

export function initBackfillState(
	state: BackfillState,
	allClientIds: string[],
): BackfillStateInitialized {
	if (state) return state;
	return {
		pendingClientIds: [...allClientIds],
		cursor: null,
	};
}

export function advanceBackfillState(
	state: BackfillStateInitialized,
	hasMorePages: boolean,
	nextCursor: string | null,
): BackfillState {
	if (hasMorePages) {
		return {
			pendingClientIds: state.pendingClientIds,
			cursor: nextCursor,
		};
	}
	const remaining = state.pendingClientIds.slice(1);
	if (remaining.length === 0) return undefined;
	return {
		pendingClientIds: remaining,
		cursor: null,
	};
}

export function initDeltaState(
	state: DeltaState,
	allClientIds: string[],
	initialBackfillDays: number,
	now: Date,
): DeltaStateInitialized {
	const initialFrom = new Date(now.getTime() - initialBackfillDays * 24 * 60 * 60 * 1000).toISOString();
	const cursorByClient = { ...(state?.cursorByClient ?? {}) };
	for (const id of allClientIds) {
		if (!cursorByClient[id]) cursorByClient[id] = initialFrom;
	}
	const cycle: DeltaCycle = state?.cycle ?? {
		pendingClientIds: [...allClientIds],
		cursor: null,
		latestEditedInCurrentClient: null,
	};
	return { cursorByClient, cycle };
}

/**
 * Drop the current active client from the cycle without touching its cursor,
 * so the next delta cycle retries the same time window. Used when the active
 * client's request failed mid-cycle (bad token, lost DB access). Other clients'
 * cursors remain unchanged.
 */
export function skipCurrentDeltaClient(state: DeltaStateInitialized): DeltaStateInitialized {
	if (!state.cycle || state.cycle.pendingClientIds.length === 0) {
		return state;
	}
	const remaining = state.cycle.pendingClientIds.slice(1);
	if (remaining.length === 0) {
		return { cursorByClient: state.cursorByClient };
	}
	return {
		cursorByClient: state.cursorByClient,
		cycle: { pendingClientIds: remaining, cursor: null, latestEditedInCurrentClient: null },
	};
}

export function advanceDeltaState(
	state: DeltaStateInitialized,
	hasMorePages: boolean,
	pageLatestEdited: string | null,
	nextCursor: string | null,
	now: Date,
	bufferMs: number,
): DeltaStateInitialized {
	if (!state.cycle || state.cycle.pendingClientIds.length === 0) {
		return { cursorByClient: state.cursorByClient };
	}
	const activeClientId = state.cycle.pendingClientIds[0]!;
	const latestInCycle = laterIso(state.cycle.latestEditedInCurrentClient, pageLatestEdited);

	if (hasMorePages) {
		return {
			cursorByClient: state.cursorByClient,
			cycle: {
				pendingClientIds: state.cycle.pendingClientIds,
				cursor: nextCursor,
				latestEditedInCurrentClient: latestInCycle,
			},
		};
	}

	// End of this client's stream — finalize the cursor. Cap at `now - bufferMs`
	// so an upcoming edit that's in flight but not yet visible won't be skipped.
	const safeCeiling = new Date(now.getTime() - bufferMs).toISOString();
	const newCursor = latestInCycle ? earlierIso(latestInCycle, safeCeiling) : safeCeiling;
	const nextCursors = { ...state.cursorByClient, [activeClientId]: newCursor };

	const remaining = state.cycle.pendingClientIds.slice(1);
	if (remaining.length === 0) {
		return { cursorByClient: nextCursors };
	}
	return {
		cursorByClient: nextCursors,
		cycle: { pendingClientIds: remaining, cursor: null, latestEditedInCurrentClient: null },
	};
}

export function clampInt(
	raw: string | undefined,
	opts: { fallback: number; min: number; max: number },
): number {
	if (raw == null) return opts.fallback;
	const n = Number.parseInt(raw, 10);
	if (Number.isNaN(n)) return opts.fallback;
	return Math.max(opts.min, Math.min(opts.max, n));
}

function laterIso(a: string | null, b: string | null): string | null {
	if (a == null) return b;
	if (b == null) return a;
	return a > b ? a : b;
}

function earlierIso(a: string, b: string): string {
	return a < b ? a : b;
}
