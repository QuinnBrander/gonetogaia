/**
 * Loadout engine — the rules for putting cards in / out of weapon slots.
 *
 * Pulled out of `screens/SuitPanel.ts` so that the screen only handles
 * rendering + input dispatch, and the actual rules ("can a card go here?",
 * "what happens to the displaced one?") live in one testable place.
 *
 * All functions take and mutate a `DelverLoadout` directly to keep the
 * call-sites simple. If we later move to immutable state we change this
 * one file.
 */

import type { DelverLoadout } from "../state";

export type LoadoutResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Place `cardId` into the slot at `slotIdx`, replacing whatever was there.
 * Returns the displaced card id (if any) so the caller can put it back in
 * the hand UI / log it.
 */
export function placeCardInSlot(
  loadout: DelverLoadout,
  slotIdx: number,
  cardId: string,
): { ok: true; displaced: string | null } | { ok: false; reason: string } {
  if (slotIdx < 0 || slotIdx >= loadout.slotCards.length) {
    return { ok: false, reason: `slotIdx ${slotIdx} out of range` };
  }
  const displaced = loadout.slotCards[slotIdx] ?? null;
  loadout.slotCards[slotIdx] = cardId;
  return { ok: true, displaced };
}

/** Remove the card in the given slot. No-op (still ok) if already empty. */
export function removeCardFromSlot(
  loadout: DelverLoadout,
  slotIdx: number,
): { ok: true; removed: string | null } | { ok: false; reason: string } {
  if (slotIdx < 0 || slotIdx >= loadout.slotCards.length) {
    return { ok: false, reason: `slotIdx ${slotIdx} out of range` };
  }
  const removed = loadout.slotCards[slotIdx] ?? null;
  loadout.slotCards[slotIdx] = null;
  return { ok: true, removed };
}

// Historical note (removed 2026-05-18): an earlier `resolveSlotClick`
// helper encapsulated "click empty to place / occupied to remove /
// different-selection to swap" semantics for the SuitPanel. Those
// semantics pre-date the strict turn-engine (DESIGN.md §4 / §5.2 / §5.5.1)
// and bypassed every gate: placement skipped mandatory-placement
// validation, removal was free (no 2-AP cost), and swap was a hybrid
// of both. The SuitPanel now routes weapon placement through
// `playWeaponCard` and card-return through `spendApRefreshWeapon`
// directly; the only remaining legitimate "low-level" callers of
// `placeCardInSlot` / `removeCardFromSlot` are inside `engine/turn.ts`
// (the actual gated entry points). Do NOT re-introduce a generic
// "slot click" helper here — it WILL re-create the free-remove
// exploit (user repro 2026-05-18, see SuitPanel.handleSlotClick).
