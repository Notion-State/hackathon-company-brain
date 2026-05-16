/**
 * Pure state-machine helpers for the backfill + delta syncs. Live in their own
 * module so tests can import them without triggering `index.ts`'s
 * module-init account enumeration (which reads `process.env`).
 */

export const PAGE_SIZE = 50;

export type BackfillState =
	| {
			pendingAccountIds: string[];
			currentSkip: number;
			fromDate: string;
	  }
	| undefined;

export type DeltaCycle = {
	pendingAccountIds: string[];
	skip: number;
	latestDateInCurrentAccount: string | null;
};

export type DeltaState =
	| {
			cursorByAccount: Record<string, string>;
			cycle?: DeltaCycle;
	  }
	| undefined;

export type DeltaStateInitialized = {
	cursorByAccount: Record<string, string>;
	cycle?: DeltaCycle;
};

export type BackfillStateInitialized = {
	pendingAccountIds: string[];
	currentSkip: number;
	fromDate: string;
};

export function initBackfillState(
	state: BackfillState,
	allAccountIds: string[],
	backfillDays: number,
	now: Date,
): BackfillStateInitialized {
	if (state) return state;
	const fromDate = new Date(now.getTime() - backfillDays * 24 * 60 * 60 * 1000).toISOString();
	return {
		pendingAccountIds: [...allAccountIds],
		currentSkip: 0,
		fromDate,
	};
}

export function advanceBackfillState(
	state: BackfillStateInitialized,
	hasMorePages: boolean,
): BackfillState {
	if (hasMorePages) {
		return {
			pendingAccountIds: state.pendingAccountIds,
			currentSkip: state.currentSkip + PAGE_SIZE,
			fromDate: state.fromDate,
		};
	}
	const remaining = state.pendingAccountIds.slice(1);
	if (remaining.length === 0) return undefined;
	return {
		pendingAccountIds: remaining,
		currentSkip: 0,
		fromDate: state.fromDate,
	};
}

export function initDeltaState(
	state: DeltaState,
	allAccountIds: string[],
	backfillDays: number,
	now: Date,
): DeltaStateInitialized {
	const initialFrom = new Date(now.getTime() - backfillDays * 24 * 60 * 60 * 1000).toISOString();
	const cursorByAccount = { ...(state?.cursorByAccount ?? {}) };
	for (const id of allAccountIds) {
		if (!cursorByAccount[id]) cursorByAccount[id] = initialFrom;
	}
	const cycle: DeltaCycle = state?.cycle ?? {
		pendingAccountIds: [...allAccountIds],
		skip: 0,
		latestDateInCurrentAccount: null,
	};
	return { cursorByAccount, cycle };
}

export function advanceDeltaState(
	state: DeltaStateInitialized,
	hasMorePages: boolean,
	pageLatestDate: string | null,
	now: Date,
	bufferMs: number,
): DeltaStateInitialized {
	if (!state.cycle || state.cycle.pendingAccountIds.length === 0) {
		return { cursorByAccount: state.cursorByAccount };
	}
	const activeAccountId = state.cycle.pendingAccountIds[0]!;
	const latestInCycle = laterIso(state.cycle.latestDateInCurrentAccount, pageLatestDate);

	if (hasMorePages) {
		return {
			cursorByAccount: state.cursorByAccount,
			cycle: {
				pendingAccountIds: state.cycle.pendingAccountIds,
				skip: state.cycle.skip + PAGE_SIZE,
				latestDateInCurrentAccount: latestInCycle,
			},
		};
	}

	const safeCeiling = new Date(now.getTime() - bufferMs).toISOString();
	const newCursor = latestInCycle ? earlierIso(latestInCycle, safeCeiling) : safeCeiling;
	const nextCursors = { ...state.cursorByAccount, [activeAccountId]: newCursor };

	const remaining = state.cycle.pendingAccountIds.slice(1);
	if (remaining.length === 0) {
		return { cursorByAccount: nextCursors };
	}
	return {
		cursorByAccount: nextCursors,
		cycle: { pendingAccountIds: remaining, skip: 0, latestDateInCurrentAccount: null },
	};
}

export function clampInt(raw: string | undefined, opts: { fallback: number; min: number; max: number }): number {
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
