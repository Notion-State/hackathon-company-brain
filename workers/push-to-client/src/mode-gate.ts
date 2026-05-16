import { ProductionPushNotAuthorized } from "./errors.js";
import type { ClientMode } from "./clients.js";

/**
 * Enforces the staging/production interlock. Called as the first step of
 * `push.pushToClient` — before preflight, before any network I/O — so a
 * misconfigured production attempt fails with zero side effects.
 *
 * Rules:
 *   - mode = "staging":    allow regardless of allowProduction
 *   - mode = "production": allow only when allowProduction === true
 */
export function assertModeAllowsPush(
	cfg: { id: string; mode: ClientMode },
	allowProduction: boolean | undefined | null,
): void {
	if (cfg.mode === "staging") return;
	if (allowProduction === true) return;
	throw new ProductionPushNotAuthorized(cfg.id);
}
