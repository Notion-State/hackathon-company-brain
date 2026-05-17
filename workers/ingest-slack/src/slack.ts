/**
 * Slack Web API client factory.
 *
 * `createSlackClient(token, pacer)` returns a typed wrapper around
 * `@slack/web-api`'s `WebClient`. Every method awaits the shared pacer before
 * making a request, then normalizes responses into narrow types that downstream
 * code can rely on (the SDK's response types are everything-optional, which
 * makes them painful to consume directly).
 *
 * On `WebAPIRateLimitedError` we sleep `retryAfter` seconds and retry once.
 * Beyond that we re-throw — let the workers runtime retry the cycle.
 *
 * On a `WebAPIPlatformError` with a recoverable Slack `error` code
 * (e.g. `not_in_channel`, `is_archived`, `user_not_found`), individual methods
 * return `null` / a soft-failure shape rather than throwing, so a single bad
 * channel/user doesn't kill a whole cycle.
 */

import { ErrorCode, WebClient, type WebAPICallError } from "@slack/web-api";

/**
 * Type guard for narrowing `unknown` caught errors to the SDK's discriminated
 * union. After this returns true, `e.code` is `ErrorCode.*` and the union
 * narrows automatically when checked against a specific code.
 */
function isWebAPIError(e: unknown): e is WebAPICallError {
	if (e == null || typeof e !== "object") return false;
	const code = (e as { code?: unknown }).code;
	return typeof code === "string" && (Object.values(ErrorCode) as string[]).includes(code);
}

// ---- Normalized response types ----

export type SlackChannel = {
	id: string;
	name: string;
	is_archived: boolean;
	is_member: boolean;
	is_private: boolean;
	is_shared: boolean;
	is_ext_shared: boolean;
	num_members: number;
	created: number; // epoch seconds
	creator: string | null; // Slack user id
	topic: string;
	purpose: string;
};

export type SlackReaction = { name: string; count: number };

export type SlackFile = {
	id: string;
	name: string;
	mimetype: string | null;
	url_private: string | null;
	url_private_download: string | null;
	permalink: string | null;
};

export type SlackMessage = {
	ts: string;
	thread_ts: string | null;
	type: string | null;
	subtype: string | null;
	text: string;
	user: string | null; // Slack user id (humans); null for some bot messages
	bot_id: string | null;
	username: string | null; // bot-supplied display name
	edited_ts: string | null;
	reply_count: number;
	latest_reply: string | null;
	reactions: SlackReaction[];
	files: SlackFile[];
	attachments_count: number; // count only — attachments shape is broad and varied
};

export type SlackUserProfile = {
	id: string;
	real_name: string;
	display_name: string;
	email: string | null;
	is_bot: boolean;
};

export type SlackBotProfile = {
	id: string;
	name: string;
};

export type SlackTeamInfo = {
	id: string;
	name: string;
	domain: string;
};

// ---- Minimal pacer interface for stub-ability in tests ----

export type Pacer = { wait(): Promise<void> };

export type SlackClient = {
	listChannels(cursor?: string): Promise<{ channels: SlackChannel[]; nextCursor?: string }>;
	/** Paginates `conversations.members` for a channel. Soft-fails on `channel_not_found` / `not_in_channel` (returns `[]`). */
	listMembers(channelId: string): Promise<string[]>;
	joinChannel(channelId: string): Promise<{ ok: boolean; warning?: string }>;
	historyPage(channelId: string, args: { oldest?: string; cursor?: string }): Promise<{ messages: SlackMessage[]; hasMore: boolean; nextCursor?: string }>;
	/** Fetches every reply page for a thread. Returns parent + replies, in arrival order. */
	repliesAll(channelId: string, threadTs: string): Promise<SlackMessage[]>;
	usersInfo(userId: string): Promise<SlackUserProfile | null>;
	botsInfo(botId: string): Promise<SlackBotProfile | null>;
	getPermalink(channelId: string, ts: string): Promise<string | null>;
	teamInfo(): Promise<SlackTeamInfo | null>;
};

export type CreateSlackClientOpts = {
	/** Override the underlying WebClient (test injection). */
	web?: WebClient;
	/** Cap on auto-retry-on-rate-limit. Default 1. */
	maxRetries?: number;
	/** Sleep implementation (test injection). */
	sleep?: (ms: number) => Promise<void>;
};

export function createSlackClient(token: string, pacer: Pacer, opts: CreateSlackClientOpts = {}): SlackClient {
	if (!token) throw new Error("createSlackClient: token is required");
	const web = opts.web ?? new WebClient(token);
	const maxRetries = opts.maxRetries ?? 1;
	const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

	async function call<T>(label: string, fn: () => Promise<T>): Promise<T> {
		let attempt = 0;
		for (;;) {
			await pacer.wait();
			try {
				return await fn();
			} catch (e) {
				if (isWebAPIError(e) && e.code === ErrorCode.RateLimitedError && attempt < maxRetries) {
					console.warn(`slack: rate limited on ${label}, retrying in ${e.retryAfter}s`);
					await sleep(e.retryAfter * 1000);
					attempt += 1;
					continue;
				}
				throw e;
			}
		}
	}

	function isPlatformErrorWithCode(e: unknown, code: string): boolean {
		return isWebAPIError(e) && e.code === ErrorCode.PlatformError && e.data.error === code;
	}

	return {
		async listChannels(cursor) {
			const res = await call("conversations.list", () =>
				web.conversations.list({
					types: "public_channel,private_channel",
					exclude_archived: true,
					limit: 200,
					cursor,
				}),
			);
			const channels = (res.channels ?? []).map(normalizeChannel).filter((c): c is SlackChannel => c !== null);
			return { channels, nextCursor: res.response_metadata?.next_cursor || undefined };
		},

		async listMembers(channelId) {
			const memberIds: string[] = [];
			let cursor: string | undefined;
			try {
				for (;;) {
					const res = await call("conversations.members", () =>
						web.conversations.members({
							channel: channelId,
							limit: 200,
							cursor,
						}),
					);
					for (const id of res.members ?? []) memberIds.push(id);
					const next = res.response_metadata?.next_cursor;
					if (!next) break;
					cursor = next;
				}
			} catch (e) {
				if (
					isPlatformErrorWithCode(e, "channel_not_found")
					|| isPlatformErrorWithCode(e, "not_in_channel")
				) {
					return [];
				}
				throw e;
			}
			return memberIds;
		},

		async joinChannel(channelId) {
			try {
				const res = await call("conversations.join", () => web.conversations.join({ channel: channelId }));
				return { ok: Boolean(res.ok), warning: res.warning ?? undefined };
			} catch (e) {
				if (
					isPlatformErrorWithCode(e, "is_archived")
					|| isPlatformErrorWithCode(e, "not_authorized")
					|| isPlatformErrorWithCode(e, "missing_scope")
					|| isPlatformErrorWithCode(e, "method_not_supported_for_channel_type")
				) {
					// Narrowed by the guard chain above: e is a platform error with .data.error.
					const errCode = isWebAPIError(e) && e.code === ErrorCode.PlatformError ? e.data.error : "unknown";
					console.warn(`slack: cannot join ${channelId}: ${errCode}`);
					return { ok: false, warning: errCode };
				}
				throw e;
			}
		},

		async historyPage(channelId, { oldest, cursor }) {
			const res = await call("conversations.history", () =>
				web.conversations.history({
					channel: channelId,
					oldest,
					cursor,
					limit: 50, // sync-state.HISTORY_PAGE_SIZE — kept literal to avoid an import cycle
					include_all_metadata: false,
				}),
			);
			const messages = (res.messages ?? []).map(normalizeMessage);
			return {
				messages,
				hasMore: Boolean(res.has_more),
				nextCursor: res.response_metadata?.next_cursor || undefined,
			};
		},

		async repliesAll(channelId, threadTs) {
			const out: SlackMessage[] = [];
			let cursor: string | undefined;
			for (;;) {
				const res = await call("conversations.replies", () =>
					web.conversations.replies({
						channel: channelId,
						ts: threadTs,
						cursor,
						limit: 200, // sync-state.REPLIES_PAGE_SIZE
					}),
				);
				for (const m of res.messages ?? []) out.push(normalizeMessage(m));
				const next = res.response_metadata?.next_cursor;
				if (!res.has_more || !next) break;
				cursor = next;
			}
			return out;
		},

		async usersInfo(userId) {
			try {
				const res = await call("users.info", () => web.users.info({ user: userId }));
				const u = res.user;
				if (!u || !u.id) return null;
				return {
					id: u.id,
					real_name: u.real_name ?? u.profile?.real_name ?? u.name ?? "",
					display_name: u.profile?.display_name ?? u.name ?? "",
					email: u.profile?.email ?? null,
					is_bot: Boolean(u.is_bot),
				};
			} catch (e) {
				if (isPlatformErrorWithCode(e, "user_not_found") || isPlatformErrorWithCode(e, "user_not_visible")) {
					return null;
				}
				throw e;
			}
		},

		async botsInfo(botId) {
			try {
				const res = await call("bots.info", () => web.bots.info({ bot: botId }));
				const b = res.bot;
				if (!b || !b.id) return null;
				return { id: b.id, name: b.name ?? "" };
			} catch (e) {
				if (isPlatformErrorWithCode(e, "bot_not_found")) return null;
				throw e;
			}
		},

		async getPermalink(channelId, ts) {
			try {
				const res = await call("chat.getPermalink", () =>
					web.chat.getPermalink({ channel: channelId, message_ts: ts }),
				);
				return res.permalink ?? null;
			} catch (e) {
				if (isPlatformErrorWithCode(e, "message_not_found") || isPlatformErrorWithCode(e, "channel_not_found")) {
					return null;
				}
				throw e;
			}
		},

		async teamInfo() {
			try {
				const res = await call("team.info", () => web.team.info());
				const t = res.team;
				if (!t || !t.id) return null;
				return { id: t.id, name: t.name ?? "", domain: t.domain ?? "" };
			} catch (e) {
				// team.info failures shouldn't kill the worker — the URL just falls back.
				console.warn("slack: team.info failed:", e);
				return null;
			}
		},
	};
}

// ---- Normalizers ----

function normalizeChannel(c: {
	id?: string;
	name?: string;
	is_archived?: boolean;
	is_member?: boolean;
	is_private?: boolean;
	is_shared?: boolean;
	is_ext_shared?: boolean;
	num_members?: number;
	created?: number;
	creator?: string;
	topic?: { value?: string };
	purpose?: { value?: string };
}): SlackChannel | null {
	if (!c.id || !c.name) return null;
	return {
		id: c.id,
		name: c.name,
		is_archived: Boolean(c.is_archived),
		is_member: Boolean(c.is_member),
		is_private: Boolean(c.is_private),
		is_shared: Boolean(c.is_shared),
		is_ext_shared: Boolean(c.is_ext_shared),
		num_members: c.num_members ?? 0,
		created: c.created ?? 0,
		creator: c.creator ?? null,
		topic: c.topic?.value ?? "",
		purpose: c.purpose?.value ?? "",
	};
}

function normalizeMessage(m: {
	ts?: string;
	thread_ts?: string;
	type?: string;
	subtype?: string;
	text?: string;
	user?: string;
	bot_id?: string;
	username?: string;
	edited?: { ts?: string };
	reply_count?: number;
	latest_reply?: string;
	reactions?: Array<{ name?: string; count?: number }>;
	files?: Array<{ id?: string; name?: string; mimetype?: string; url_private?: string; url_private_download?: string; permalink?: string }>;
	attachments?: unknown[];
}): SlackMessage {
	return {
		ts: m.ts ?? "",
		thread_ts: m.thread_ts ?? null,
		type: m.type ?? null,
		subtype: m.subtype ?? null,
		text: m.text ?? "",
		user: m.user ?? null,
		bot_id: m.bot_id ?? null,
		username: m.username ?? null,
		edited_ts: m.edited?.ts ?? null,
		reply_count: m.reply_count ?? 0,
		latest_reply: m.latest_reply ?? null,
		reactions: (m.reactions ?? [])
			.filter((r): r is { name: string; count: number } => Boolean(r.name) && typeof r.count === "number")
			.map((r) => ({ name: r.name, count: r.count })),
		files: (m.files ?? [])
			.filter((f): f is { id: string; name: string; mimetype?: string; url_private?: string; url_private_download?: string; permalink?: string } =>
				Boolean(f.id) && Boolean(f.name),
			)
			.map((f) => ({
				id: f.id,
				name: f.name,
				mimetype: f.mimetype ?? null,
				url_private: f.url_private ?? null,
				url_private_download: f.url_private_download ?? null,
				permalink: f.permalink ?? null,
			})),
		attachments_count: m.attachments?.length ?? 0,
	};
}

// Re-export error code enum for callers that want to inspect specific errors.
export { ErrorCode };
