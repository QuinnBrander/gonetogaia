/**
 * Tests for src/screens/SuitPanel.ts > computeTotalMovementThisTurn —
 * the pure math behind the "current / total" movement overlay badge.
 *
 * The badge's GATE (when it renders at all) is exercised at the
 * SuitPanel render-call site:
 *   visible iff isActive
 *     AND (currentMovement !== baseMovement OR buffActive).
 *
 * Here we only test the TOTAL computation, since that's the bit
 * with non-trivial AP-double / +1-mov interaction. The badge gate
 * is a single boolean expression and not worth a JSdom integration
 * test on its own (the engine resets currentMovement -> baseMovement
 * at turn start, which is already covered in turn.test.ts).
 */

import { describe, it, expect } from "vitest";

import { computeTotalMovementThisTurn } from "../screens/SuitPanel";
import type { DelverLoadout, HeroTurnState } from "../state";

/** Bare loadout — fields not used by the helper are stubbed to defaults. */
function loadout(opts: { base: number; current: number }): DelverLoadout {
  return {
    heroId: "hero-01",
    slotCards: [null, null, null, null, null, null],
    maxHp: 9,
    currentHp: 9,
    currentAp: 3,
    baseAp: 3,
    currentMovement: opts.current,
    baseMovement: opts.base,
  };
}

/** Bare turn state — only the two flags the helper reads matter. */
function ts(opts: {
  doubled?: boolean;
  extraMov?: boolean;
} = {}): HeroTurnState {
  return {
    cardPlacedThisTurn: null,
    actionUsedThisTurn: false,
    movementUsedThisTurn: false,
    movementStepsThisTurn: 0,
    apMovementDoubledThisTurn: opts.doubled ?? false,
    actionGrantedExtraMovement: opts.extraMov ?? false,
    damage2xUsedThisTurn: false,
    doubleDamageActive: {},
    witnessStepsThisTurn: 0,
    movementSnapshot: null,
  };
}

describe("computeTotalMovementThisTurn", () => {
  it("returns baseMovement when no buff and nothing spent", () => {
    const lo = loadout({ base: 2, current: 2 });
    expect(computeTotalMovementThisTurn(lo, ts())).toBe(2);
  });

  it("returns baseMovement when some movement has been spent (no buff)", () => {
    const lo = loadout({ base: 2, current: 1 });
    expect(computeTotalMovementThisTurn(lo, ts())).toBe(2);
  });

  it("AP-double, nothing else: total = base * 2", () => {
    const lo = loadout({ base: 2, current: 4 });
    expect(computeTotalMovementThisTurn(lo, ts({ doubled: true }))).toBe(4);
  });

  it("AP-double + 1 step spent: total still base * 2 (denominator stable)", () => {
    const lo = loadout({ base: 2, current: 3 });
    expect(computeTotalMovementThisTurn(lo, ts({ doubled: true }))).toBe(4);
  });

  it("+1-mov slot ability, no AP-double: total = base + 1", () => {
    const lo = loadout({ base: 2, current: 3 });
    expect(computeTotalMovementThisTurn(lo, ts({ extraMov: true }))).toBe(3);
  });

  it("AP-double + +1-mov slot ability: total = (base + 1) * 2 (both buffs doubled, DESIGN.md §5.5.1)", () => {
    // base 2, doubled (mult=2) + +1 mov (extra=1, also doubled): 2*2 + 1*2 = 6
    const lo = loadout({ base: 2, current: 6 });
    expect(computeTotalMovementThisTurn(lo, ts({ doubled: true, extraMov: true }))).toBe(6);
  });

  it("AP-double + +1-mov slot ability + 3 spent: denominator still 6, numerator follows currentMovement", () => {
    const lo = loadout({ base: 2, current: 3 });
    // Total is still 6 (the buffed budget); the SuitPanel renders
    // `currentMovement / total` so the badge would read "3 / 6".
    expect(computeTotalMovementThisTurn(lo, ts({ doubled: true, extraMov: true }))).toBe(6);
  });

  it("treats null turnState as no-buff fallback (matches `?? null` path in renderSuitPanel)", () => {
    const lo = loadout({ base: 2, current: 1 });
    expect(computeTotalMovementThisTurn(lo, null)).toBe(2);
  });

  it("treats undefined turnState as no-buff fallback", () => {
    const lo = loadout({ base: 2, current: 2 });
    expect(computeTotalMovementThisTurn(lo, undefined)).toBe(2);
  });

  it("Boots base=2 + AP-double + 1 spent → total 4, current 3 (typical mid-turn snapshot)", () => {
    // Realistic scenario: Boots bumped baseMovement to 2, player
    // spent 1 AP to double (current 2 -> 4), then took one normal
    // move step (current 4 -> 3). Badge should read "3 / 4".
    const lo = loadout({ base: 2, current: 3 });
    expect(computeTotalMovementThisTurn(lo, ts({ doubled: true }))).toBe(4);
  });
});
