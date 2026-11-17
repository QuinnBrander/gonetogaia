/**
 * `engine/loadout.ts` is the home of the LOW-LEVEL slot mutators only.
 *
 * Every public path that the UI calls to put a card in or out of a
 * slot must go through `engine/turn.ts` so the turn-engine gates
 * (mandatory placement, AP cost, prepared-to-run, etc.) actually
 * fire. The historical `resolveSlotClick` "UI click handler" lived
 * here and bypassed all of those gates — clicking an occupied
 * prior-turn slot with no card selected returned the card to hand
 * for FREE (no AP, no logging, no preparedToRun re-evaluation).
 *
 * The user repro that surfaced this was 2026-05-18 — see the
 * `screens/SuitPanel.ts > handleSlotClick` comment and DESIGN.md
 * §5.5.1.
 *
 * These tests pin the contract going forward:
 *   1. The low-level mutators are still exported (the gated entry
 *      points in `engine/turn.ts` use them internally).
 *   2. No "slot click" / "free remove" / "swap" helper is exported.
 *      Re-introducing one here would silently reopen the exploit
 *      because the SuitPanel would gain a tempting import target
 *      that's just one re-bind away from the buggy behavior.
 *
 * If you legitimately need a new public surface to put a card in or
 * out of a slot, add it to `engine/turn.ts` next to `playWeaponCard`
 * / `spendApRefreshWeapon` / `undoWeaponPlacement` so it picks up
 * the rest of the gates by construction.
 */

import { describe, expect, it } from "vitest";

import * as loadout from "../engine/loadout";

describe("engine/loadout public API surface", () => {
  it("exposes the low-level mutators that the gated turn-engine entry points wrap", () => {
    expect(typeof loadout.placeCardInSlot).toBe("function");
    expect(typeof loadout.removeCardFromSlot).toBe("function");
  });

  // Regression for the 2026-05-18 free-remove exploit. Do NOT relax
  // these assertions without rewriting `screens/SuitPanel.ts >
  // handleSlotClick` to route the new helper through the AP-spend
  // / placement gates in `engine/turn.ts`.
  it("does NOT export a `resolveSlotClick` UI helper (free-remove exploit)", () => {
    expect((loadout as Record<string, unknown>).resolveSlotClick).toBeUndefined();
  });

  it("does NOT export a `SlotClickOutcome` type alias (the legacy shape that the UI handler returned)", () => {
    // Types are erased at runtime, but if the alias were re-exported
    // as a value (e.g. `export const SlotClickOutcome = ...`) we'd
    // catch it here too.
    expect((loadout as Record<string, unknown>).SlotClickOutcome).toBeUndefined();
  });
});
