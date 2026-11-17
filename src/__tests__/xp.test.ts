/**
 * Tests for the shared XP / Level helpers (src/xp.ts).
 *
 * The cost-to-level-up table from DESIGN.md §3.2:
 *   Level 0 -> 1 :  1 XP
 *   Level 1 -> 2 :  3 XP
 *   Level 2 -> 3 :  5 XP
 *   Level N-1 -> N : 2N - 1 XP
 */

import { describe, it, expect } from "vitest";
import {
  xpCostForNextLevel,
  canLevelUp,
  xpToNextLevel,
  resolvePendingLevelUps,
} from "../xp";

describe("xpCostForNextLevel", () => {
  it("matches the printed XP board (2N - 1)", () => {
    expect(xpCostForNextLevel(0)).toBe(1);
    expect(xpCostForNextLevel(1)).toBe(3);
    expect(xpCostForNextLevel(2)).toBe(5);
    expect(xpCostForNextLevel(3)).toBe(7);
    expect(xpCostForNextLevel(9)).toBe(19);
  });

  it("treats negative input as level 0", () => {
    expect(xpCostForNextLevel(-1)).toBe(1);
    expect(xpCostForNextLevel(-5)).toBe(1);
  });
});

describe("canLevelUp", () => {
  it("is false when XP is below the cost", () => {
    expect(canLevelUp(0, 0)).toBe(false);
    expect(canLevelUp(2, 1)).toBe(false); // need 3 to go 1->2
  });

  it("is true exactly at the cost threshold", () => {
    expect(canLevelUp(1, 0)).toBe(true);
    expect(canLevelUp(3, 1)).toBe(true);
    expect(canLevelUp(5, 2)).toBe(true);
  });

  it("is true above the cost threshold", () => {
    expect(canLevelUp(100, 5)).toBe(true);
  });
});

describe("xpToNextLevel", () => {
  it("returns the difference between cost and current XP", () => {
    expect(xpToNextLevel(0, 0)).toBe(1);
    expect(xpToNextLevel(0, 1)).toBe(3);
    expect(xpToNextLevel(2, 1)).toBe(1);
  });

  it("returns 0 when a level-up is ready or overdue", () => {
    expect(xpToNextLevel(1, 0)).toBe(0);
    expect(xpToNextLevel(5, 1)).toBe(0);
    expect(xpToNextLevel(99, 2)).toBe(0);
  });
});

describe("resolvePendingLevelUps", () => {
  it("is a no-op when not enough XP for one level", () => {
    const r = resolvePendingLevelUps(0, 0);
    expect(r).toEqual({ xpOnHand: 0, currentLevel: 0, levelUps: 0 });

    const r2 = resolvePendingLevelUps(2, 1);
    expect(r2).toEqual({ xpOnHand: 2, currentLevel: 1, levelUps: 0 });
  });

  it("spends exactly the cost for a single level-up", () => {
    // 1 XP at level 0 -> spend 1, level becomes 1, 0 XP left
    const r = resolvePendingLevelUps(1, 0);
    expect(r).toEqual({ xpOnHand: 0, currentLevel: 1, levelUps: 1 });
  });

  it("chains multiple level-ups one at a time (rulebook p24)", () => {
    // 9 XP at level 0:
    //   spend 1 (1 XP) -> level 1, 8 XP
    //   spend 3 (3 XP) -> level 2, 5 XP
    //   spend 5 (5 XP) -> level 3, 0 XP   (next costs 7, can't afford)
    const r = resolvePendingLevelUps(9, 0);
    expect(r).toEqual({ xpOnHand: 0, currentLevel: 3, levelUps: 3 });
  });

  it("stops at the first unaffordable level", () => {
    // 4 XP at level 0:
    //   spend 1 -> level 1, 3 XP
    //   spend 3 -> level 2, 0 XP   (next costs 5, can't afford)
    const r = resolvePendingLevelUps(4, 0);
    expect(r).toEqual({ xpOnHand: 0, currentLevel: 2, levelUps: 2 });
  });

  it("starts from a non-zero current level correctly", () => {
    // Already at level 5, with 6 XP banked:
    //   next cost is 11, can't afford, so no change.
    const r = resolvePendingLevelUps(6, 5);
    expect(r).toEqual({ xpOnHand: 6, currentLevel: 5, levelUps: 0 });
  });

  it("handles a single big XP grant from a multi-kill (DESIGN.md §3.2)", () => {
    // After resolving multiple enemies, total XP gained could be large.
    // Spend down one level at a time until below the next threshold.
    const r = resolvePendingLevelUps(20, 2);
    // From level 2 (next costs 5): 5, 7, 9 -> spent 21 XP, but we only have 20.
    //   spend 5 -> level 3, 15 left
    //   spend 7 -> level 4, 8 left
    //   spend 9 -> can't (need 9, have 8)? Actually 8 < 9. So stop.
    expect(r).toEqual({ xpOnHand: 8, currentLevel: 4, levelUps: 2 });
  });
});
