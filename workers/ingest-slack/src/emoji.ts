/**
 * Slack emoji shortcode → Unicode conversion.
 *
 * Uses `node-emoji` for the standard mapping (~1800 entries) and augments with
 * a small alias map for Slack-specific names that differ from the standard set.
 * Custom workspace emojis (no Unicode mapping) are left as `:name:` in text.
 */

import { find } from "node-emoji";

/**
 * Slack uses several shortcode names that don't match the standard emoji set.
 * Map them to their standard equivalents so `node-emoji` can resolve them.
 */
const SLACK_ALIAS_MAP: Record<string, string> = {
	thumbsup: "+1",
	thumbsdown: "-1",
	hankey: "poop",
	shipit: "squirrel",
	simple_smile: "slightly_smiling_face",
	white_frowning_face: "frowning_face",
	// Add more as we discover them in real payloads.
};

/**
 * Convert a single shortcode (without surrounding colons) to its Unicode emoji.
 * Returns `null` for custom/unknown emojis.
 */
export function shortcodeToUnicode(name: string): string | null {
	// Try the name directly first.
	const direct = find(`:${name}:`);
	if (direct) return direct.emoji;

	// Try Slack alias mapping.
	const aliased = SLACK_ALIAS_MAP[name];
	if (aliased) {
		const result = find(`:${aliased}:`);
		if (result) return result.emoji;
	}

	return null;
}

/**
 * Replace all `:shortcode:` patterns in text with their Unicode equivalents.
 * Standard emojis become Unicode; custom/unknown emojis are left as `:name:`.
 */
export function convertEmojiShortcodes(text: string): string {
	return text.replace(/:([a-z0-9_+-]+):/g, (_match, name: string) => {
		const unicode = shortcodeToUnicode(name);
		return unicode ?? `:${name}:`;
	});
}
