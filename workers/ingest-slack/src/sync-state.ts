/**
 * Pure state-machine helpers for the three slack syncs:
 * - `slackChannelsSync` (replace, 1h)   → `ChannelsState`
 * - `slackBackfill`    (replace, manual) → `BackfillState`
 * - `slackDelta`       (incremental, 5m) → `DeltaState`
 *
 * Lives in its own module so tests can exercise the state machines without
 * touching the worker's module-init env reads or the Slack client.
 *
 * Cursor format: Slack ts string ("1715898253.123456") — the same format the
 * `conversations.history(oldest=...)` parameter accepts. String comparison on
 * this format is numerically correct, so we can do lexicographic max/min.
 */

export const HISTORY_PAGE_SIZE = 50;
export const REPLIES_PAGE_SIZE = 200;
export const LIST_PAGE_SIZE = 200;

// ---- Channels sync (replace, paginated conversations.list) ----

export type ChannelsState = { listCursor?: string } | undefined;

export function nextChannelsState(nextCursor: string | undefined): ChannelsState {
	if (!nextCursor) return undefined;
	return { listCursor: nextCursor };
}

// ---- Messages backfill (replace, manual) ----

export type BackfillState =
	| {
			/** Channel ids frozen at cycle start. New channels mid-cycle wait for the next cycle. */
			channelIds: string[];
			/** Index of the channel currently being walked. */
			currentIndex: number;
			/** Slack cursor for the next conversations.history page within the current channel. */
			historyCursor?: string;
			/** Slack ts ("seconds.microseconds") for the `oldest` filter — frozen at cycle start. */
			fromTs: string;
	  }
	| undefined;

export type BackfillStateInitialized = NonNullable<BackfillState>;

export function initBackfillState(
	state: BackfillState,
	discoveredChannelIds: string[],
	backfillDays: number,
	now: Date,
): BackfillStateInitialized {
	if (state) return state;
	const fromTs = isoToSlackTs(new Date(now.getTime() - backfillDays * 24 * 60 * 60 * 1000));
	return {
		channelIds: [...discoveredChannelIds],
		currentIndex: 0,
		historyCursor: undefined,
		fromTs,
	};
}

export function advanceBackfillState(
	state: BackfillStateInitialized,
	nextHistoryCursor: string | undefined,
): BackfillState {
	if (nextHistoryCursor) {
		return {
			channelIds: state.channelIds,
			currentIndex: state.currentIndex,
			historyCursor: nextHistoryCursor,
			fromTs: state.fromTs,
		};
	}
	// Current channel exhausted — advance to next.
	const nextIndex = state.currentIndex + 1;
	if (nextIndex >= state.channelIds.length) return undefined;
	return {
		channelIds: state.channelIds,
		currentIndex: nextIndex,
		historyCursor: undefined,
		fromTs: state.fromTs,
	};
}

// ---- Messages delta (incremental, 5m) ----

export type DeltaCycle = {
	pendingChannelIds: string[];
	historyCursor?: string;
	/** Max ts seen across pages of the current channel; folded into cursorByChannel when channel exhausts. */
	latestTsInCurrentChannel: string | null;
};

export type DeltaState =
	| {
			/** channelId → Slack ts of last-seen activity (a thread's max(parent, ...replies).ts). */
			cursorByChannel: Record<string, string>;
			cycle?: DeltaCycle;
	  }
	| undefined;

export type DeltaStateInitialized = NonNullable<DeltaState>;

export function initDeltaState(
	state: DeltaState,
	discoveredChannelIds: string[],
	backfillDays: number,
	now: Date,
): DeltaStateInitialized {
	const seedTs = isoToSlackTs(new Date(now.getTime() - backfillDays * 24 * 60 * 60 * 1000));
	const cursorByChannel = { ...(state?.cursorByChannel ?? {}) };
	for (const id of discoveredChannelIds) {
		if (!cursorByChannel[id]) cursorByChannel[id] = seedTs;
	}
	const cycle: DeltaCycle = state?.cycle ?? {
		pendingChannelIds: [...discoveredChannelIds],
		historyCursor: undefined,
		latestTsInCurrentChannel: null,
	};
	return { cursorByChannel, cycle };
}

export function advanceDeltaState(
	state: DeltaStateInitialized,
	nextHistoryCursor: string | undefined,
	pageLatestTs: string | null,
	now: Date,
	bufferMs: number,
): DeltaStateInitialized {
	if (!state.cycle || state.cycle.pendingChannelIds.length === 0) {
		return { cursorByChannel: state.cursorByChannel };
	}
	const activeChannelId = state.cycle.pendingChannelIds[0]!;
	const latestInCycle = laterTs(state.cycle.latestTsInCurrentChannel, pageLatestTs);

	if (nextHistoryCursor) {
		// More pages remain in the current channel.
		return {
			cursorByChannel: state.cursorByChannel,
			cycle: {
				pendingChannelIds: state.cycle.pendingChannelIds,
				historyCursor: nextHistoryCursor,
				latestTsInCurrentChannel: latestInCycle,
			},
		};
	}

	// Current channel exhausted — commit its cursor, advance to the next.
	const safeCeiling = isoToSlackTs(new Date(now.getTime() - bufferMs));
	const newCursor = latestInCycle ? earlierTs(latestInCycle, safeCeiling) : safeCeiling;
	const nextCursors = { ...state.cursorByChannel, [activeChannelId]: newCursor };

	const remaining = state.cycle.pendingChannelIds.slice(1);
	if (remaining.length === 0) {
		return { cursorByChannel: nextCursors };
	}
	return {
		cursorByChannel: nextCursors,
		cycle: {
			pendingChannelIds: remaining,
			historyCursor: undefined,
			latestTsInCurrentChannel: null,
		},
	};
}

// ---- Shared helpers ----

/**
 * Bounded parse. Returns `fallback` when raw is unset / non-numeric; otherwise
 * clamps to [min, max]. Copied verbatim from workers/ingest-fireflies/src/sync-state.ts.
 */
export function clampInt(raw: string | undefined, opts: { fallback: number; min: number; max: number }): number {
	if (raw == null) return opts.fallback;
	const n = Number.parseInt(raw, 10);
	if (Number.isNaN(n)) return opts.fallback;
	return Math.max(opts.min, Math.min(opts.max, n));
}

/**
 * Convert a Date to a Slack ts string ("seconds.microseconds"). Microsecond
 * precision is zeroed — sufficient for cursor / oldest comparisons where
 * we'd never round-trip a real message's exact ts through this path.
 */
export function isoToSlackTs(d: Date): string {
	const ms = d.getTime();
	const seconds = Math.floor(ms / 1000);
	const microsPart = String((ms % 1000) * 1000).padStart(6, "0");
	return `${seconds}.${microsPart}`;
}

/**
 * Convert a Slack ts string to an ISO 8601 datetime string. Used at the
 * boundary when emitting `Posted At` / `Last Activity` properties.
 */
export function slackTsToIso(ts: string): string {
	// Slack ts is "1715898253.123456"; multiplying by 1000 keeps the float as ms.
	const ms = Math.round(Number.parseFloat(ts) * 1000);
	return new Date(ms).toISOString();
}

/**
 * Max of two Slack ts strings (null-safe). Lexicographic comparison matches
 * numeric comparison because the format is fixed-width on either side of the dot.
 */
export function laterTs(a: string | null, b: string | null): string | null {
	if (a == null) return b;
	if (b == null) return a;
	return a > b ? a : b;
}

/** Min of two Slack ts strings (no nulls). */
export function earlierTs(a: string, b: string): string {
	return a < b ? a : b;
}
