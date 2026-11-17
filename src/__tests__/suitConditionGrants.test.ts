/**
 * Suit Condition Rank pick queue — coverage for the new
 * `engine/suitConditionGrants.ts` module.
 *
 * Covers:
 *   - enqueue: pickId generation, idSuffix, pair-link translation
 *     (pairWithIndex -> pairsWithPickId), defensive drop of an
 *     invalid `pairWithIndex` (self-reference / out-of-range)
 *   - peek/has: queue-empty + queue-non-empty
 *   - eligible: pinnedType narrowing, at-cap filter
 *   - apply: pops the head, bumps suitConditionRankBonus, returns
 *     the `suit-condition-rank-bumped` event, rewrites paired
 *     pick's heroId to the OTHER delver
 *   - apply: throws on out-of-order / wrong-hero / wrong-type /
 *     unknown hero
 *   - apply: persists state across `endQuestReset` (the bumps
 *     and the queue both survive)
 */

import { describe, it, expect } from "vitest";
import { newCampaign, type CampaignState } from "../state";
import {
  applySuitConditionRankPick,
  applySuitConditionRankPickToSlot,
  eligibleEquipmentTypesForSuitConditionPick,
  enqueueSuitConditionRankPicks,
  hasPendingSuitConditionRankPicks,
  peekNextSuitConditionRankPick,
  previewSuitConditionPick,
} from "../engine/suitConditionGrants";
import { ALL_EQUIPMENT_TYPES, EQUIPMENT_RANK_CAP } from "../types";
import { endQuestReset } from "../engine/wave";

// ---------- enqueue -------------------------------------------------------

describe("enqueueSuitConditionRankPicks", () => {
  it("returns [] for an empty pick list and leaves the queue untouched", () => {
    const s = newCampaign();
    const out = enqueueSuitConditionRankPicks(s, "test-source", []);
    expect(out).toEqual([]);
    expect(s.pendingSuitConditionPicks).toEqual([]);
  });

  it("assigns stable pickIds derived from source + index + idSuffix", () => {
    const s = newCampaign();
    enqueueSuitConditionRankPicks(s, "test", [
      { delta: 1, pinnedHeroId: "hero-01" },
      { delta: 2, pinnedHeroId: "hero-02" },
    ], "suffix");
    expect(s.pendingSuitConditionPicks.map((p) => p.pickId)).toEqual([
      "test-0-suffix",
      "test-1-suffix",
    ]);
  });

  it("omits the dash when idSuffix is empty", () => {
    const s = newCampaign();
    enqueueSuitConditionRankPicks(s, "test", [
      { delta: 1 },
    ]);
    expect(s.pendingSuitConditionPicks[0]!.pickId).toBe("test-0");
  });

  it("translates pairWithIndex into pairsWithPickId on the linking pick", () => {
    const s = newCampaign();
    enqueueSuitConditionRankPicks(s, "pair-test", [
      { delta: 1, pinnedType: "OS" },
      { delta: 1, pinnedType: "Battery", pairWithIndex: 0 },
    ]);
    const [a, b] = s.pendingSuitConditionPicks;
    expect(b!.pairsWithPickId).toBe(a!.pickId);
    // The other direction is NOT linked: pair links are one-way.
    expect(a!.pairsWithPickId).toBeUndefined();
  });

  it("drops a self-referential pairWithIndex defensively", () => {
    const s = newCampaign();
    enqueueSuitConditionRankPicks(s, "bad-pair", [
      { delta: 1, pairWithIndex: 0 },
    ]);
    expect(s.pendingSuitConditionPicks[0]!.pairsWithPickId).toBeUndefined();
  });

  it("drops an out-of-range pairWithIndex defensively", () => {
    const s = newCampaign();
    enqueueSuitConditionRankPicks(s, "bad-pair", [
      { delta: 1, pairWithIndex: 99 },
    ]);
    expect(s.pendingSuitConditionPicks[0]!.pairsWithPickId).toBeUndefined();
  });

  it("preserves pinnedHeroId / pinnedType in the enqueued entry", () => {
    const s = newCampaign();
    enqueueSuitConditionRankPicks(s, "pin-test", [
      { delta: 2, pinnedHeroId: "hero-01", pinnedType: "OS" },
    ]);
    const entry = s.pendingSuitConditionPicks[0]!;
    expect(entry.heroId).toBe("hero-01");
    expect(entry.pinnedType).toBe("OS");
    expect(entry.delta).toBe(2);
    expect(entry.source).toBe("pin-test");
  });

  it("APPENDS to (does not replace) the existing queue", () => {
    const s = newCampaign();
    enqueueSuitConditionRankPicks(s, "first", [{ delta: 1 }]);
    enqueueSuitConditionRankPicks(s, "second", [{ delta: 2 }]);
    expect(s.pendingSuitConditionPicks).toHaveLength(2);
    expect(s.pendingSuitConditionPicks[0]!.source).toBe("first");
    expect(s.pendingSuitConditionPicks[1]!.source).toBe("second");
  });
});

// ---------- peek / has ----------------------------------------------------

describe("peekNextSuitConditionRankPick / hasPendingSuitConditionRankPicks", () => {
  it("returns null / false for an empty queue", () => {
    const s = newCampaign();
    expect(peekNextSuitConditionRankPick(s)).toBeNull();
    expect(hasPendingSuitConditionRankPicks(s)).toBe(false);
  });

  it("returns the head / true when at least one pick is queued", () => {
    const s = newCampaign();
    enqueueSuitConditionRankPicks(s, "test", [{ delta: 1, pinnedHeroId: "hero-01" }]);
    expect(peekNextSuitConditionRankPick(s)?.source).toBe("test");
    expect(hasPendingSuitConditionRankPicks(s)).toBe(true);
  });
});

// ---------- eligible ------------------------------------------------------

describe("eligibleEquipmentTypesForSuitConditionPick", () => {
  it("returns ALL types when no type is pinned and the delver has no at-cap slots", () => {
    const s = newCampaign();
    enqueueSuitConditionRankPicks(s, "t", [{ delta: 1, pinnedHeroId: "hero-01" }]);
    const pick = s.pendingSuitConditionPicks[0]!;
    const out = eligibleEquipmentTypesForSuitConditionPick(s, pick, "hero-01", ALL_EQUIPMENT_TYPES);
    expect(out.length).toBe(ALL_EQUIPMENT_TYPES.length);
  });

  it("narrows to just the pinned type when pinnedType is set", () => {
    const s = newCampaign();
    enqueueSuitConditionRankPicks(s, "t", [
      { delta: 1, pinnedHeroId: "hero-01", pinnedType: "OS" },
    ]);
    const pick = s.pendingSuitConditionPicks[0]!;
    const out = eligibleEquipmentTypesForSuitConditionPick(s, pick, "hero-01", ALL_EQUIPMENT_TYPES);
    expect(out).toEqual(["OS"]);
  });

  it("filters out a slot already at EQUIPMENT_RANK_CAP", () => {
    const s = newCampaign();
    s.equipmentRanks["hero-01"]!.OS = EQUIPMENT_RANK_CAP;
    enqueueSuitConditionRankPicks(s, "t", [
      { delta: 1, pinnedHeroId: "hero-01" },
    ]);
    const pick = s.pendingSuitConditionPicks[0]!;
    const out = eligibleEquipmentTypesForSuitConditionPick(s, pick, "hero-01", ALL_EQUIPMENT_TYPES);
    expect(out).not.toContain("OS");
  });

  it("returns [] when the pinned-type slot is already at cap (no useful pick available)", () => {
    const s = newCampaign();
    s.equipmentRanks["hero-01"]!.OS = EQUIPMENT_RANK_CAP;
    enqueueSuitConditionRankPicks(s, "t", [
      { delta: 1, pinnedHeroId: "hero-01", pinnedType: "OS" },
    ]);
    const pick = s.pendingSuitConditionPicks[0]!;
    const out = eligibleEquipmentTypesForSuitConditionPick(s, pick, "hero-01", ALL_EQUIPMENT_TYPES);
    expect(out).toEqual([]);
  });
});

// ---------- apply ---------------------------------------------------------

describe("applySuitConditionRankPick — happy paths", () => {
  function freshState(): CampaignState {
    const s = newCampaign();
    enqueueSuitConditionRankPicks(s, "t", [
      { delta: 1, pinnedHeroId: "hero-01" },
    ]);
    return s;
  }

  it("pops the head, bumps suitConditionRankBonus, and returns a suit-condition-rank-bumped event", () => {
    const s = freshState();
    const head = s.pendingSuitConditionPicks[0]!;
    const result = applySuitConditionRankPick(s, head.pickId, "hero-01", "OS");
    expect(s.pendingSuitConditionPicks).toHaveLength(0);
    expect(s.suitConditionRankBonus["hero-01"]!.OS).toBe(1);
    expect(result.reward).toMatchObject({
      kind: "suit-condition-rank-bumped",
      heroId: "hero-01",
      equipmentType: "OS",
      delta: 1,
      effectiveBefore: 0,
      effectiveAfter: 1,
      source: "t",
    });
  });

  it("stacks bumps on the same slot when applied twice from separate picks", () => {
    const s = newCampaign();
    enqueueSuitConditionRankPicks(s, "t", [
      { delta: 1, pinnedHeroId: "hero-01", pinnedType: "OS" },
      { delta: 2, pinnedHeroId: "hero-01", pinnedType: "OS" },
    ]);
    const [first, second] = s.pendingSuitConditionPicks;
    applySuitConditionRankPick(s, first!.pickId, "hero-01", "OS");
    applySuitConditionRankPick(s, second!.pickId, "hero-01", "OS");
    expect(s.suitConditionRankBonus["hero-01"]!.OS).toBe(3);
  });

  it("clamps the stored bonus at EQUIPMENT_RANK_CAP (defensive)", () => {
    const s = newCampaign();
    s.suitConditionRankBonus["hero-01"] = { OS: EQUIPMENT_RANK_CAP - 1 };
    enqueueSuitConditionRankPicks(s, "t", [
      { delta: 2, pinnedHeroId: "hero-01", pinnedType: "OS" },
    ]);
    const head = s.pendingSuitConditionPicks[0]!;
    applySuitConditionRankPick(s, head.pickId, "hero-01", "OS");
    expect(s.suitConditionRankBonus["hero-01"]!.OS).toBe(EQUIPMENT_RANK_CAP);
  });

  it("rewrites paired pick's heroId to the OTHER delver after the first pick resolves", () => {
    const s = newCampaign();
    enqueueSuitConditionRankPicks(s, "t", [
      { delta: 1, pinnedType: "OS" },
      { delta: 1, pinnedType: "Battery", pairWithIndex: 0 },
    ]);
    const [first, second] = s.pendingSuitConditionPicks;
    expect(second!.heroId).toBeNull();
    applySuitConditionRankPick(s, first!.pickId, "hero-01", "OS");
    expect(s.pendingSuitConditionPicks[0]!.pickId).toBe(second!.pickId);
    expect(s.pendingSuitConditionPicks[0]!.heroId).toBe("hero-02");
  });

  it("leaves a paired pick's heroId alone if it is already pinned", () => {
    const s = newCampaign();
    enqueueSuitConditionRankPicks(s, "t", [
      { delta: 1, pinnedType: "OS" },
      { delta: 1, pinnedHeroId: "hero-01", pinnedType: "Battery", pairWithIndex: 0 },
    ]);
    const [first] = s.pendingSuitConditionPicks;
    applySuitConditionRankPick(s, first!.pickId, "hero-02", "OS");
    expect(s.pendingSuitConditionPicks[0]!.heroId).toBe("hero-01");
  });
});

describe("applySuitConditionRankPick — error paths", () => {
  it("throws when the queue is empty", () => {
    const s = newCampaign();
    expect(() =>
      applySuitConditionRankPick(s, "anything", "hero-01", "OS"),
    ).toThrow(/queue is empty/);
  });

  it("throws when pickId doesn't match the queue head (out-of-order)", () => {
    const s = newCampaign();
    enqueueSuitConditionRankPicks(s, "t", [{ delta: 1 }, { delta: 1 }]);
    const second = s.pendingSuitConditionPicks[1]!;
    expect(() =>
      applySuitConditionRankPick(s, second.pickId, "hero-01", "OS"),
    ).toThrow(/head pickId is/);
  });

  it("throws when the pick is pinned to a different hero", () => {
    const s = newCampaign();
    enqueueSuitConditionRankPicks(s, "t", [
      { delta: 1, pinnedHeroId: "hero-01" },
    ]);
    const head = s.pendingSuitConditionPicks[0]!;
    expect(() =>
      applySuitConditionRankPick(s, head.pickId, "hero-02", "OS"),
    ).toThrow(/pinned to heroId/);
  });

  it("throws when the pick is pinned to a different equipment type", () => {
    const s = newCampaign();
    enqueueSuitConditionRankPicks(s, "t", [
      { delta: 1, pinnedHeroId: "hero-01", pinnedType: "OS" },
    ]);
    const head = s.pendingSuitConditionPicks[0]!;
    expect(() =>
      applySuitConditionRankPick(s, head.pickId, "hero-01", "Battery"),
    ).toThrow(/pinned to type/);
  });

  it("throws when the heroId is unknown to the loadout map", () => {
    const s = newCampaign();
    enqueueSuitConditionRankPicks(s, "t", [{ delta: 1 }]);
    const head = s.pendingSuitConditionPicks[0]!;
    expect(() =>
      applySuitConditionRankPick(s, head.pickId, "hero-99", "OS"),
    ).toThrow(/unknown heroId/);
  });
});

// ---------- apply: slot-aware variant ------------------------------------

describe("applySuitConditionRankPickToSlot", () => {
  it("writes the bump into the requested (loadoutIdx, slotIdx) cell", () => {
    const s = newCampaign();
    enqueueSuitConditionRankPicks(s, "t", [
      { delta: 1, pinnedHeroId: "hero-01" },
    ]);
    const head = s.pendingSuitConditionPicks[0]!;
    applySuitConditionRankPickToSlot(s, head.pickId, "hero-01", "OS", 1, 2);
    expect(s.suitLoadouts["hero-01"]![1]![2]).toEqual({ type: "OS", rank: 1 });
    // The auto-fill walk would have written into (0, 0) — confirm the
    // first cell is still empty to prove the slot override took effect.
    expect(s.suitLoadouts["hero-01"]![0]![0]).toBeNull();
  });

  it("rejects a request for an occupied cell without popping the queue", () => {
    const s = newCampaign();
    s.suitLoadouts["hero-01"]![0]![0] = { type: "Battery", rank: 1 };
    enqueueSuitConditionRankPicks(s, "t", [
      { delta: 1, pinnedHeroId: "hero-01" },
    ]);
    const head = s.pendingSuitConditionPicks[0]!;
    expect(() =>
      applySuitConditionRankPickToSlot(s, head.pickId, "hero-01", "OS", 0, 0),
    ).toThrow(/is occupied/);
    expect(s.pendingSuitConditionPicks).toHaveLength(1);
    // The bonus must not have leaked through either — the apply is
    // all-or-nothing per pick.
    expect(s.suitConditionRankBonus["hero-01"]?.OS ?? 0).toBe(0);
  });

  it("rejects an out-of-range loadoutIdx / slotIdx", () => {
    const s = newCampaign();
    enqueueSuitConditionRankPicks(s, "t", [
      { delta: 1, pinnedHeroId: "hero-01" },
    ]);
    const head = s.pendingSuitConditionPicks[0]!;
    expect(() =>
      applySuitConditionRankPickToSlot(s, head.pickId, "hero-01", "OS", 3, 0),
    ).toThrow(/out of range/);
    expect(() =>
      applySuitConditionRankPickToSlot(s, head.pickId, "hero-01", "OS", 0, 3),
    ).toThrow(/out of range/);
  });

  it("rejects an unlockHigherRanks pick (no loadout semantics)", () => {
    const s = newCampaign();
    enqueueSuitConditionRankPicks(s, "boss-card-w2-helmet-hero-01", [
      { delta: 1, pinnedHeroId: "hero-01", unlockHigherRanks: true },
    ]);
    const head = s.pendingSuitConditionPicks[0]!;
    expect(() =>
      applySuitConditionRankPickToSlot(s, head.pickId, "hero-01", "OS", 0, 0),
    ).toThrow(/unlockHigherRanks pick/);
    // The unlock didn't fire either — leaves the queue alone.
    expect(s.pendingSuitConditionPicks).toHaveLength(1);
  });

  it("still rewrites paired pick's heroId to the OTHER delver", () => {
    const s = newCampaign();
    enqueueSuitConditionRankPicks(s, "t", [
      { delta: 1, pinnedType: "OS" },
      { delta: 1, pinnedType: "Battery", pairWithIndex: 0 },
    ]);
    const [first, second] = s.pendingSuitConditionPicks;
    applySuitConditionRankPickToSlot(s, first!.pickId, "hero-01", "OS", 0, 0);
    expect(s.pendingSuitConditionPicks[0]!.pickId).toBe(second!.pickId);
    expect(s.pendingSuitConditionPicks[0]!.heroId).toBe("hero-02");
  });
});

// ---------- persistence across endQuestReset -----------------------------

describe("Suit Condition queue + bonuses persist across endQuestReset", () => {
  it("preserves both pendingSuitConditionPicks AND suitConditionRankBonus when a quest resets", () => {
    const s = newCampaign();
    s.suitConditionRankBonus["hero-01"] = { OS: 1 };
    enqueueSuitConditionRankPicks(s, "t", [
      { delta: 1, pinnedHeroId: "hero-02" },
    ]);
    const queueLengthBefore = s.pendingSuitConditionPicks.length;
    endQuestReset(s);
    expect(s.pendingSuitConditionPicks.length).toBe(queueLengthBefore);
    expect(s.suitConditionRankBonus["hero-01"]!.OS).toBe(1);
  });
});

describe("previewSuitConditionPick", () => {
  it("predicts the effective rank the apply call lands on, without mutating state", () => {
    const s = newCampaign();
    s.equipmentRanks["hero-01"]!.OS = 2;
    enqueueSuitConditionRankPicks(s, "t", [{ delta: 2, pinnedHeroId: "hero-01" }]);
    const head = s.pendingSuitConditionPicks[0]!;
    const preview = previewSuitConditionPick(s, head, "hero-01", "OS");
    expect(preview).toEqual({ kind: "rank", before: 2, after: 4 });
    expect(s.suitConditionRankBonus["hero-01"]?.OS ?? 0).toBe(0);
    const result = applySuitConditionRankPick(s, head.pickId, "hero-01", "OS");
    expect(result.effectiveAfter).toBe(preview.after);
  });

  it("clamps the preview at EQUIPMENT_RANK_CAP", () => {
    const s = newCampaign();
    s.equipmentRanks["hero-01"]!.OS = EQUIPMENT_RANK_CAP - 1;
    enqueueSuitConditionRankPicks(s, "t", [{ delta: 2, pinnedHeroId: "hero-01" }]);
    const preview = previewSuitConditionPick(s, s.pendingSuitConditionPicks[0]!, "hero-01", "OS");
    expect(preview.after).toBe(EQUIPMENT_RANK_CAP);
  });

  it("shows the rank-cap step for boss-card unlock picks", () => {
    const s = newCampaign();
    enqueueSuitConditionRankPicks(s, "t", [{ delta: 1, pinnedHeroId: "hero-01", unlockHigherRanks: true }]);
    const head = s.pendingSuitConditionPicks[0]!;
    expect(previewSuitConditionPick(s, head, "hero-01", "OS")).toEqual({ kind: "cap", before: 3, after: 4 });
    applySuitConditionRankPick(s, head.pickId, "hero-01", "OS");
    expect(s.unlockedForHigherRanks["hero-01"]!.OS).toBe(4);
  });
});
