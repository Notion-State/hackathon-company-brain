/**
 * Lazy-cached identity lookups (Slack users + bots).
 *
 * Powers two consumers:
 * - render-threads.ts: message author + thread participants
 * - render-channels.ts: channel creator
 *
 * Cache lifetime = process lifetime (cleared on redeploy). A stale display name
 * surfaces in the next deploy; acceptable vs. paying users.info on every cycle.
 *
 * Mirrors the lazy-promise pattern from
 * `workers/ingest-fireflies/src/lookups.ts`, but with a per-id map rather than
 * a load-once-everything-at-once map (slack workspaces can have thousands of
 * users; we only ever need the ones who actually authored content).
 */

import type { SlackBotProfile, SlackClient, SlackMessage, SlackUserProfile } from "./slack.js";

export type SlackIdentity = {
	displayText: string; // "Real Name (@handle)" or "BotName (bot)" or "(unknown)"
	email: string | null;
	isBot: boolean;
};

export type IdentityLookup = {
	resolveUser(userId: string): Promise<SlackIdentity>;
	resolveBot(botId: string, fallbackUsername?: string | null): Promise<SlackIdentity>;
	resolveMessageAuthor(msg: SlackMessage): Promise<SlackIdentity>;
};

const UNKNOWN: SlackIdentity = { displayText: "(unknown)", email: null, isBot: false };

export function createIdentityLookup(client: SlackClient): IdentityLookup {
	const userCache = new Map<string, Promise<SlackIdentity>>();
	const botCache = new Map<string, Promise<SlackIdentity>>();

	async function loadUser(userId: string): Promise<SlackIdentity> {
		const u = await client.usersInfo(userId).catch((e) => {
			console.warn(`lookups: users.info failed for ${userId}:`, e);
			return null;
		});
		return identityFromUser(u, userId);
	}

	async function loadBot(botId: string, fallbackUsername: string | null): Promise<SlackIdentity> {
		const b = await client.botsInfo(botId).catch((e) => {
			console.warn(`lookups: bots.info failed for ${botId}:`, e);
			return null;
		});
		return identityFromBot(b, botId, fallbackUsername);
	}

	function resolveUser(userId: string): Promise<SlackIdentity> {
		const cached = userCache.get(userId);
		if (cached) return cached;
		const p = loadUser(userId);
		userCache.set(userId, p);
		return p;
	}

	function resolveBot(botId: string, fallbackUsername?: string | null): Promise<SlackIdentity> {
		const cached = botCache.get(botId);
		if (cached) return cached;
		const p = loadBot(botId, fallbackUsername ?? null);
		botCache.set(botId, p);
		return p;
	}

	function resolveMessageAuthor(msg: SlackMessage): Promise<SlackIdentity> {
		// Order matters: a bot may also have a `user` field (Slack sometimes
		// populates it with the installing user). bot_id wins because that's
		// the source of identity for a bot-authored message.
		if (msg.bot_id) return resolveBot(msg.bot_id, msg.username);
		if (msg.subtype === "bot_message" && msg.username) {
			// Bot without an id (rare — legacy integrations). Synthesize an identity
			// without making an API call.
			return Promise.resolve({ displayText: `${msg.username} (bot)`, email: null, isBot: true });
		}
		if (msg.user) return resolveUser(msg.user);
		return Promise.resolve(UNKNOWN);
	}

	return { resolveUser, resolveBot, resolveMessageAuthor };
}

function identityFromUser(u: SlackUserProfile | null, fallbackId: string): SlackIdentity {
	if (!u) return { displayText: `(unknown user ${fallbackId})`, email: null, isBot: false };
	const name = u.real_name || u.display_name || u.id;
	const handle = u.display_name || u.real_name || u.id;
	return {
		displayText: `${name} (@${handle})`,
		email: u.email,
		isBot: u.is_bot,
	};
}

function identityFromBot(b: SlackBotProfile | null, fallbackId: string, fallbackUsername: string | null): SlackIdentity {
	const name = b?.name || fallbackUsername || `bot ${fallbackId}`;
	return {
		displayText: `${name} (bot)`,
		email: null,
		isBot: true,
	};
}
