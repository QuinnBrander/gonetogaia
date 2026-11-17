/**
 * Build-ID guard — clears persisted state when a fresh .exe build runs
 * for the first time on a given machine.
 *
 * Vite's `define` injects `__G2G_BUILD_ID__` at bundle time:
 *   - Portable .exe (`vite build --mode portable`): a unique
 *     `exe-<timestamp>` string per build.
 *   - Dev / regular web build: the constant `"dev"`.
 *
 * On boot we compare the bundled ID to one stored in localStorage:
 *   - Equal (or bundled === "dev"): no-op. Saves persist normally.
 *   - Different: clear campaign + session-log state, then record the
 *     new ID so subsequent launches of the SAME .exe keep their save.
 *
 * Net effect: every freshly-packaged .exe distributed to a tester
 * starts them in a clean campaign on first launch, but lets them keep
 * playing the same .exe across sessions afterwards.
 *
 * Web/Cloudflare deploys (mode != "portable") keep `BUILD_ID === "dev"`
 * so live updates never wipe a player's browser save.
 */

import { clearCampaign } from "../state";

declare const __G2G_BUILD_ID__: string;

const STORED_ID_KEY = "g2g.build.id";
const SESSION_LOG_KEY = "g2g.sessionLog.v1";

export function clearCampaignIfNewBuild(): void {
  const bundledId =
    typeof __G2G_BUILD_ID__ !== "undefined" ? __G2G_BUILD_ID__ : "dev";
  if (bundledId === "dev") return;

  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORED_ID_KEY);
  } catch {
    return;
  }
  if (stored === bundledId) return;

  try {
    clearCampaign();
    localStorage.removeItem(SESSION_LOG_KEY);
    localStorage.setItem(STORED_ID_KEY, bundledId);
  } catch {
    /* localStorage unavailable — let the app continue with whatever state it has */
  }
}
