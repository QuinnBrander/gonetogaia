/**
 * Turn-flow helpers shared between BoardScreen and ActionResolution.
 *
 * Lives in its own module so ActionResolution can call into auto-end
 * logic without re-importing BoardScreen (which would cycle).
 */

import type { Router } from "../main";
import { clearActionState, clearLastAutoRefresh, clearPeek } from "../uiState";
import { endHeroTurn, shouldAutoSkipTurn } from "../engine/turn";
import { undoMovementThisTurn } from "../engine/movement";
import { hasPendingElementChoices } from "../engine/os";
import { hasPendingEquipmentRolls } from "../engine/tokens";
import { hasPendingXpRolls } from "../engine/kills";
import { logEvent, snapElements, snapHeroAp, snapTurn } from "../debug/sessionLog";
import { resetTurnStartBanner } from "../ui/turnStartBanner";

/**
 * After a turn flip, check whether the newly-active delver's turn
 * should be silently skipped (no playable weapon cards, insufficient
 * AP to refresh). If so, call `endHeroTurn` once more (depth-guarded
 * to prevent infinite looping when both delvers would theoretically
 * qualify), log the outcome, and reset the turn-start banner latch so
 * the original delver's next turn still triggers a visible banner.
 */
function maybeSkipEmptyTurn(router: Router): void {
  const newHeroId = router.state.currentDelverId;
  if (!shouldAutoSkipTurn(router.state, newHeroId)) return;

  logEvent("turn.auto-skip", {
    heroId: newHeroId,
    reason: "no-playable-weapons-insufficient-ap",
  });

  endHeroTurn(router.state);
  logEvent("turn.start-next", {
    heroId: router.state.currentDelverId,
    ap: snapHeroAp(router.state, router.state.currentDelverId),
    elements: snapElements(router.state, router.state.currentDelverId),
  });
  // Reset the banner latch so the original delver's resumed turn
  // shows a fresh "X's turn" banner on the next render.
  resetTurnStartBanner();
}

/**
 * button flow: clear ephemeral UI state, flip the active delver,
 * refresh resources, persist).
 *
 * Returns `true` iff the turn was ended (so callers can skip an
 * otherwise-redundant `router.save()`).
 *
 * Intentional non-triggers:
 *   - Prepare to Run does NOT auto-end (the player can't move/act
 *     anyway, and may want to peek before handing the device over).
 *   - Using only one of (movement, action) does NOT auto-end — the
 *     player may still want the other half of their turn.
 */
export function maybeAutoEndTurn(router: Router): boolean {
  const heroId = router.state.currentDelverId;
  const ts = router.state.encounter?.turnState[heroId] ?? null;
  if (!ts) return false;
  if (!ts.movementUsedThisTurn || !ts.actionUsedThisTurn) return false;
  // Don't auto-end if the delver still has enough AP to refresh a weapon
  // card (costs 2 AP). Mirrors the same guard in `shouldAutoSkipTurn` —
  // both must agree or a delver with spendable AP would be silently robbed
  // of their chance to refresh before the turn flips.
  const lo = router.state.loadouts[heroId];
  if (lo && lo.currentAp >= 2) return false;
  // Pending element-pick prompts (Elemental OS) MUST resolve before
  // turn-end \u2014 ending mid-queue would leak the prompt into the next
  // delver's turn and read as "the wrong delver is being asked to
  // pick". The element-pick modal's own click handler will route
  // back through `advanceAfterAction` once the queue drains, which
  // re-enters this auto-end gate naturally.
  if (hasPendingElementChoices(router.state)) return false;
  // Same provenance, same gate: Supercharger die rolls fired from
  // a level-up choice must be resolved before the turn flips.
  if (hasPendingEquipmentRolls(router.state)) return false;
  // XP die rolls from "Gain 1 [die] XP" kills — the roll happens in
  // front of the player before the turn flips.
  if (hasPendingXpRolls(router.state)) return false;

  logEvent("turn.end-auto", {
    heroId,
    apBefore: snapHeroAp(router.state, heroId),
    turnBefore: snapTurn(router.state, heroId),
  });
  clearPeek();
  clearActionState();
  // Banner is per-action — wipe it on hand-off so it doesn't bleed
  // into the next delver's turn (mirrors the manual End Turn path).
  clearLastAutoRefresh();
  endHeroTurn(router.state);
  logEvent("turn.start-next", {
    heroId: router.state.currentDelverId,
    ap: snapHeroAp(router.state, router.state.currentDelverId),
    elements: snapElements(router.state, router.state.currentDelverId),
  });
  maybeSkipEmptyTurn(router);
  router.save();
  return true;
}

/**
 * Commit the End Turn flow without any auto-detection — used by the
 * End Turn topbar button and the "Undo and submit" branch of the
 * `end-turn-undo-prompt` modal (2026-05-21). Mirrors
 * {@link maybeAutoEndTurn} except that the caller has already
 * decided the turn is over, so no gating happens here:
 *   - clearPeek (hand the device to the next player on a clean view),
 *   - clearActionState (wipe per-turn UI ephemera),
 *   - clearLastAutoRefresh (banner is per-action),
 *   - `endHeroTurn` (engine flip + reset for the new active delver),
 *   - `router.save()`.
 *
 * Distinct from {@link maybeAutoEndTurn} in that this path does NOT
 * check the pending-element / pending-equipment-roll queues — the
 * BoardScreen's `canEndTurn` already gates those, and the modal
 * confirmation only opens when canEndTurn is true.
 */
export function commitManualEndTurn(router: Router): void {
  logEvent("turn.end-manual", {
    heroId: router.state.currentDelverId,
    apBefore: snapHeroAp(router.state, router.state.currentDelverId),
    turnBefore: snapTurn(router.state, router.state.currentDelverId),
  });
  clearPeek();
  clearActionState();
  clearLastAutoRefresh();
  endHeroTurn(router.state);
  logEvent("turn.start-next", {
    heroId: router.state.currentDelverId,
    ap: snapHeroAp(router.state, router.state.currentDelverId),
    elements: snapElements(router.state, router.state.currentDelverId),
  });
  maybeSkipEmptyTurn(router);
  router.save();
}

/**
 * "Undo and submit" branch of the `end-turn-undo-prompt` modal
 * (2026-05-21). Rewinds the active delver's movement to the turn-
 * start baseline via `undoMovementThisTurn`, then commits End Turn
 * via {@link commitManualEndTurn}. Returns `true` when both legs
 * ran; `false` if there was nothing to undo (defensive — the modal
 * should never open without a snapshot).
 */
export function commitEndTurnAfterUndo(router: Router): boolean {
  const heroId = router.state.currentDelverId;
  const undone = undoMovementThisTurn(router.state, heroId);
  if (!undone) {
    // Defensive: no snapshot to undo. Still commit End Turn so the
    // player isn't stranded staring at the modal with no apparent
    // way out — the precondition is broken upstream but the safest
    // user-facing recovery is to finish the turn cleanly.
    commitManualEndTurn(router);
    return false;
  }
  logEvent("turn.end-with-undo", {
    heroId,
  });
  commitManualEndTurn(router);
  return true;
}
