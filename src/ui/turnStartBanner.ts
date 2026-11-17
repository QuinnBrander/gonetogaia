/**
 * Turn-start banner — a brief centered popup that fires once each
 * time the active delver flips, so a player who just took their
 * eyes off the screen for a counter-roll modal / level-up flow
 * notices that the device has switched hands.
 *
 * Architecture:
 *
 * - **Detection lives in `BoardScreen`** (not in the engine /
 *   turnFlow), via {@link maybeShowTurnStartBanner}. BoardScreen
 *   already re-renders on every router refresh and sees every
 *   active-delver change naturally; injecting a "did the delver
 *   flip since I last rendered?" check there avoids threading a
 *   one-shot UI signal through `endHeroTurn` / `the End Wave refresh` /
 *   the various End Turn entry-points.
 *
 * - **Module-level latch** (`lastShownDelverId`) — stores the most
 *   recently announced delver id. The banner only fires when the
 *   current id differs. Initial value is `null` so the very first
 *   render (fresh encounter / first turn of the game / page
 *   refresh mid-quest) DOES announce. The latch is in-memory only
 *   — refreshing the page re-fires once per delver, which is
 *   acceptable noise.
 *
 * - **DOM-level render**, not React/state-based: the banner is
 *   purely cosmetic (no game state mutation), should NOT block
 *   input (the player can immediately tap their slot / hand while
 *   it fades), and self-removes after its lifetime is up. Doing
 *   it via direct `document.body.appendChild` keeps it out of the
 *   BoardScreen DOM tree so subsequent re-renders don't blow it
 *   away mid-fade.
 *
 * - **Single-instance** — every show call removes any prior banner
 *   first, so back-to-back delver flips don't pile up overlapping
 *   text.
 */

import type { CampaignState } from "../state";
import { logEvent } from "../debug/sessionLog";

/** Total visible lifetime of the banner in ms. Keep in lockstep
 *  with the `turnStartBanner` keyframes + animation duration in
 *  styles.css. Bumped 2026-05-25 from 800ms → 1800ms (player
 *  feedback: the banner faded too fast to register on a quick
 *  hand-off). The in/out animation phases stay at ~96ms each;
 *  the extra 1000ms is added to the steady-state hold. */
const BANNER_LIFETIME_MS = 1800;

let lastShownDelverId: string | null = null;

/**
 * Reset the latch. Call on title-screen exits or "new game" flows
 * if you want the banner to re-fire on the next BoardScreen mount.
 * Today nothing calls this — the in-memory default of `null`
 * already makes a fresh page load re-announce — but exporting it
 * keeps the API symmetric and discoverable.
 */
export function resetTurnStartBanner(): void {
  lastShownDelverId = null;
}

/**
 * Called from `renderBoardScreen` once per render. Compares the
 * active delver id against the latch; if it changed, dispatch the
 * banner and update the latch. No-op when the delver hasn't
 * changed (which is the common case — most renders are
 * `router.refresh()` calls on the SAME delver's turn).
 *
 * `suit` and `displayName` are passed in (rather than re-derived
 * from `state`) because the caller already has a `Hero` lookup in
 * hand and we want this helper to stay decoupled from `data.ts`.
 */
export function maybeShowTurnStartBanner(
  state: CampaignState,
  suit: "mind" | "body",
): void {
  const currentDelverId = state.currentDelverId;
  if (currentDelverId === lastShownDelverId) return;
  lastShownDelverId = currentDelverId;
  showTurnStartBanner(suit);
  // Surface in the session log so a bug repro can correlate "banner
  // fired" with whatever the player did next. Cheap to log — happens
  // at most twice per wave per delver swap.
  logEvent("ui.turn-start-banner", { delverId: currentDelverId, suit });
}

function showTurnStartBanner(suit: "mind" | "body"): void {
  // Tear down any in-flight banner so back-to-back flips don't
  // overlap (would happen if the player auto-end-turned and then
  // also got an immediate End Wave → next-hero-turn within the
  // banner's 800ms lifetime, which is plausible).
  const existing = document.querySelector(".turn-start-banner");
  if (existing) existing.remove();

  const text = suit === "mind"
    ? "DISCIPLE OF THE MIND'S TURN"
    : "DISCIPLE OF THE BODY'S TURN";

  const el = document.createElement("div");
  el.className = `turn-start-banner turn-start-banner--${suit}`;
  // `aria-live=polite` lets screen-readers announce the new turn
  // without interrupting the current speech queue. `aria-hidden=
  // false` on a polite live region is the right shape for
  // ephemeral status updates.
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.textContent = text;

  document.body.appendChild(el);

  // Self-removal — the CSS animation reaches `opacity: 0` slightly
  // before `BANNER_LIFETIME_MS` so the DOM removal here is just a
  // safety net (also matters for screen-readers / DOM cleanliness).
  setTimeout(() => { el.remove(); }, BANNER_LIFETIME_MS);
}
