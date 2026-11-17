/**
 * Chapter 2 Town Center Academy donation (Shop Product #8) —
 * comprehensive coverage of:
 *
 *   - v36 -> v37 schema migration (backfill `academyDonation` and
 *     `suitConditionRankBonus`).
 *   - `donateToAcademy` debit + accumulation, plus every reject
 *     branch (no town visit, invalid amount, insufficient wallet).
 *   - `totalAcademyDonation` summing across delvers.
 *   - `donationTierForTotal` boundaries (0-2/3-5/6-9/10+).
 *   - `resolveAcademyDonation` tier-to-staging mapping +
 *     idempotency (small/medium pin OS+Battery; large opens type).
 *   - Phase 1 helpers (`canAdvanceDonationAssignment`) — gate
 *     correctness across assignment / large-tier type pick states.
 *   - Phase 2 commit (`recordAcademyDonationPlacement` +
 *     `commitAcademyDonationResolution`) — bumps land on
 *     `suitConditionRankBonus`, slot writes land on `suitLoadouts`,
 *     staging field clears, the per-placement reward events fire.
 *   - `getEffectiveEquipmentRank` factoring in `suitConditionRankBonus`.
 *   - `finishTownVisit` clearing the per-visit accumulator while
 *     preserving the resolution side-effects.
 *   - Defensive guard: `purchaseShopProduct` refuses the donation
 *     product so a stray Buy click can't softlock the donation row.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  getEffectiveEquipmentRank,
  migrateV36ToV37,
  newCampaign,
  type CampaignState,
  type PendingAcademyDonationResolution,
} from "../state";
import {
  canAdvanceDonationAssignment,
  commitAcademyDonationResolution,
  donateToAcademy,
  donationRewardsForTier,
  donationTierForTotal,
  hasPendingAcademyDonationResolution,
  recordAcademyDonationPlacement,
  resolveAcademyDonation,
  totalAcademyDonation,
} from "../engine/academyDonation";
import {
  finishTownVisit,
  purchaseShopProduct,
  runTownVisitAction,
  startTownVisit,
} from "../engine/townVisit";
import type { EquipmentType } from "../types";

/**
 * Test helper — resolve a fully-staged donation by assigning
 * `(hero, type, loadoutIdx, slotIdx)` tuples in order, then
 * committing. The default mapping mirrors the legacy "Mind takes
 * the first ticket, Body takes the second" convention so the
 * per-tier "bumps land here" assertions still read meaningfully.
 *
 * For `large` tier callers must override `typesByHero` because
 * the resolved staging has `chosenType === null` until the
 * "Pick equipment" sub-menu runs.
 */
function resolveStagedDonationLegacyDefaults(
  s: CampaignState,
  opts: {
    typesByHero?: Partial<Record<string, EquipmentType>>;
    slotByHero?: Partial<Record<string, { loadoutIdx: number; slotIdx: number }>>;
  } = {},
): void {
  const res = s.pendingAcademyDonationResolution;
  if (!res) throw new Error("resolveStagedDonationLegacyDefaults: nothing staged");
  // Phase 1: ensure every ticket has a chosenType + assignedHeroId.
  res.rewards[0]!.assignedHeroId = "hero-01";
  res.rewards[1]!.assignedHeroId = "hero-02";
  for (const reward of res.rewards) {
    if (reward.chosenType == null) {
      const heroId = reward.assignedHeroId!;
      const override = opts.typesByHero?.[heroId];
      if (override) reward.chosenType = override;
      else if (heroId === "hero-01") reward.chosenType = "Supercharger";
      else reward.chosenType = "Harvester";
    }
  }
  // Phase 2: record one placement per ticket. Default places
  // each ticket into loadout 0, slot 0 of the assigned delver.
  for (const reward of res.rewards) {
    const heroId = reward.assignedHeroId!;
    const type = reward.chosenType!;
    const slot = opts.slotByHero?.[heroId] ?? { loadoutIdx: 0, slotIdx: 0 };
    recordAcademyDonationPlacement(s, heroId, type, slot.loadoutIdx, slot.slotIdx);
  }
  commitAcademyDonationResolution(s);
}

// ---------- v36 -> v37 migration ------------------------------------------

describe("migrateV36ToV37 — Academy donation field backfill", () => {
  it("graduates a v36 save to v37 (intermediate version, not SCHEMA_VERSION)", () => {
    const save = { version: 36, encounter: null, loadouts: { "hero-01": {}, "hero-02": {} } };
    const out = migrateV36ToV37(save) as CampaignState;
    expect(out.version).toBe(37);
  });

  it("backfills academyDonation = 0 per delver and suitConditionRankBonus = {} per delver", () => {
    const save = { version: 36, encounter: null, loadouts: { "hero-01": {}, "hero-02": {} } };
    const out = migrateV36ToV37(save) as unknown as CampaignState;
    expect(out.academyDonation).toEqual({ "hero-01": 0, "hero-02": 0 });
    expect(out.suitConditionRankBonus).toEqual({ "hero-01": {}, "hero-02": {} });
  });

  it("does NOT clobber pre-existing values (forward-compat)", () => {
    const save = {
      version: 36,
      encounter: null,
      loadouts: { "hero-01": {}, "hero-02": {} },
      academyDonation: { "hero-01": 4 },
      suitConditionRankBonus: { "hero-01": { OS: 2 } },
    };
    const out = migrateV36ToV37(save) as unknown as CampaignState;
    expect(out.academyDonation).toEqual({ "hero-01": 4 });
    expect(out.suitConditionRankBonus).toEqual({ "hero-01": { OS: 2 } });
  });
});

// ---------- donateToAcademy ----------------------------------------------

describe("donateToAcademy", () => {
  let s: CampaignState;
  beforeEach(() => {
    s = newCampaign();
    startTownVisit(s, "ch2");
    s.minionParts["hero-01"] = 8;
    s.minionParts["hero-02"] = 5;
  });

  it("rejects when no town visit is in progress", () => {
    const fresh = newCampaign();
    fresh.minionParts["hero-01"] = 10;
    expect(donateToAcademy(fresh, "hero-01", 3)).toEqual({ code: "no-town-visit" });
  });

  it("rejects an invalid amount (zero, negative, fractional)", () => {
    expect(donateToAcademy(s, "hero-01", 0)).toEqual({ code: "invalid-amount" });
    expect(donateToAcademy(s, "hero-01", -1)).toEqual({ code: "invalid-amount" });
    expect(donateToAcademy(s, "hero-01", 1.5)).toEqual({ code: "invalid-amount" });
  });

  it("rejects when the hero doesn't exist in the wallets table", () => {
    expect(donateToAcademy(s, "hero-XX", 1)).toEqual({ code: "hero-not-found" });
  });

  it("rejects when the wallet is insufficient", () => {
    expect(donateToAcademy(s, "hero-01", 9)).toEqual({ code: "insufficient-minion-parts" });
    expect(s.minionParts["hero-01"]).toBe(8);
    expect(s.academyDonation["hero-01"] ?? 0).toBe(0);
  });

  it("debits the wallet and accumulates on the donation counter", () => {
    expect(donateToAcademy(s, "hero-01", 3)).toBeNull();
    expect(s.minionParts["hero-01"]).toBe(5);
    expect(s.academyDonation["hero-01"]).toBe(3);
    expect(donateToAcademy(s, "hero-01", 2)).toBeNull();
    expect(s.minionParts["hero-01"]).toBe(3);
    expect(s.academyDonation["hero-01"]).toBe(5);
  });

  it("accumulates independently per delver", () => {
    donateToAcademy(s, "hero-01", 4);
    donateToAcademy(s, "hero-02", 3);
    expect(s.academyDonation["hero-01"]).toBe(4);
    expect(s.academyDonation["hero-02"]).toBe(3);
    expect(totalAcademyDonation(s)).toBe(7);
  });
});

// ---------- donationTierForTotal -----------------------------------------

describe("donationTierForTotal — boundary mapping", () => {
  it.each([
    [0, "none"],
    [1, "none"],
    [2, "none"],
    [3, "small"],
    [4, "small"],
    [5, "small"],
    [6, "medium"],
    [7, "medium"],
    [9, "medium"],
    [10, "large"],
    [11, "large"],
    [99, "large"],
  ])("total %d -> tier %s", (total, expected) => {
    expect(donationTierForTotal(total)).toBe(expected);
  });
});

// ---------- donationRewardsForTier ---------------------------------------

describe("donationRewardsForTier — tier-to-ticket spec", () => {
  it("none -> empty list", () => {
    expect(donationRewardsForTier("none")).toEqual([]);
  });
  it("small -> +1 OS / +1 Battery (pinned)", () => {
    expect(donationRewardsForTier("small")).toEqual([
      { delta: 1, pinnedType: "OS" },
      { delta: 1, pinnedType: "Battery" },
    ]);
  });
  it("medium -> +2 OS / +2 Battery (pinned)", () => {
    expect(donationRewardsForTier("medium")).toEqual([
      { delta: 2, pinnedType: "OS" },
      { delta: 2, pinnedType: "Battery" },
    ]);
  });
  it("large -> two +2 tickets with open type (pinnedType: null)", () => {
    expect(donationRewardsForTier("large")).toEqual([
      { delta: 2, pinnedType: null },
      { delta: 2, pinnedType: null },
    ]);
  });
});

// ---------- resolveAcademyDonation ---------------------------------------

describe("resolveAcademyDonation — tier-to-staging mapping", () => {
  function freshTownVisit(): CampaignState {
    const s = newCampaign();
    startTownVisit(s, "ch2");
    return s;
  }

  /** Narrow the resolver's return so `tier`, `totalDonated`, and
   *  `grants` are reachable directly. */
  function asResolved(ev: ReturnType<typeof resolveAcademyDonation>) {
    if (ev.kind !== "academy-donation-resolved") {
      throw new Error(`unexpected event kind ${ev.kind}`);
    }
    return ev;
  }

  it("0 donated -> 'none' tier, no resolution staged", () => {
    const s = freshTownVisit();
    const ev = asResolved(resolveAcademyDonation(s));
    expect(ev.totalDonated).toBe(0);
    expect(ev.tier).toBe("none");
    expect(ev.grants).toEqual([]);
    expect(s.pendingAcademyDonationResolution).toBeNull();
    expect(hasPendingAcademyDonationResolution(s)).toBe(false);
    expect(s.suitConditionRankBonus["hero-01"]).toEqual({});
    expect(s.suitConditionRankBonus["hero-02"]).toEqual({});
    // The legacy suit-condition queue is NOT used by the new flow.
    expect(s.pendingSuitConditionPicks).toEqual([]);
  });

  it("3 donated -> 'small' stages 2 pinned tickets (OS / Battery) with unassigned heroes", () => {
    const s = freshTownVisit();
    s.minionParts["hero-01"] = 3;
    donateToAcademy(s, "hero-01", 3);
    const ev = asResolved(resolveAcademyDonation(s));
    expect(ev.tier).toBe("small");
    const res = s.pendingAcademyDonationResolution as PendingAcademyDonationResolution;
    expect(res).not.toBeNull();
    expect(res.tier).toBe("small");
    expect(res.totalDonated).toBe(3);
    expect(res.rewards.length).toBe(2);
    expect(res.rewards[0]).toEqual({
      delta: 1,
      pinnedType: "OS",
      chosenType: "OS",
      assignedHeroId: null,
    });
    expect(res.rewards[1]).toEqual({
      delta: 1,
      pinnedType: "Battery",
      chosenType: "Battery",
      assignedHeroId: null,
    });
    expect(res.placements).toEqual([]);
    // No bumps yet — the modal commits them after the player
    // resolves Phase 1 + Phase 2.
    expect(s.suitConditionRankBonus["hero-01"]).toEqual({});
    expect(s.suitConditionRankBonus["hero-02"]).toEqual({});
    // Legacy queue stays empty.
    expect(s.pendingSuitConditionPicks).toEqual([]);
  });

  it("8 donated -> 'medium': same pinned shape as small but +2 delta", () => {
    const s = freshTownVisit();
    s.minionParts["hero-01"] = 4;
    s.minionParts["hero-02"] = 4;
    donateToAcademy(s, "hero-01", 4);
    donateToAcademy(s, "hero-02", 4);
    const ev = asResolved(resolveAcademyDonation(s));
    expect(ev.tier).toBe("medium");
    const res = s.pendingAcademyDonationResolution as PendingAcademyDonationResolution;
    expect(res.rewards.every((r) => r.delta === 2)).toBe(true);
    expect(res.rewards[0]!.pinnedType).toBe("OS");
    expect(res.rewards[1]!.pinnedType).toBe("Battery");
  });

  it("12 donated -> 'large': two +2 tickets with open type (pinnedType + chosenType both null)", () => {
    const s = freshTownVisit();
    s.minionParts["hero-01"] = 6;
    s.minionParts["hero-02"] = 6;
    donateToAcademy(s, "hero-01", 6);
    donateToAcademy(s, "hero-02", 6);
    const ev = asResolved(resolveAcademyDonation(s));
    expect(ev.tier).toBe("large");
    const res = s.pendingAcademyDonationResolution as PendingAcademyDonationResolution;
    expect(res.rewards.length).toBe(2);
    for (const reward of res.rewards) {
      expect(reward.delta).toBe(2);
      expect(reward.pinnedType).toBeNull();
      expect(reward.chosenType).toBeNull();
      expect(reward.assignedHeroId).toBeNull();
    }
  });

  it("idempotent — second call returns 'already-resolved' shape AND does not re-stage", () => {
    const s = freshTownVisit();
    s.minionParts["hero-01"] = 5;
    donateToAcademy(s, "hero-01", 5);
    const first = asResolved(resolveAcademyDonation(s));
    expect(first.tier).toBe("small");
    const stagedFirst = s.pendingAcademyDonationResolution;
    expect(stagedFirst).not.toBeNull();
    const second = asResolved(resolveAcademyDonation(s));
    expect(second.tier).toBe("small");
    expect(second.grants).toEqual([]);
    // Same staging object survives the second call — no double-stage.
    expect(s.pendingAcademyDonationResolution).toBe(stagedFirst);
  });
});

// ---------- canAdvanceDonationAssignment ---------------------------------

describe("canAdvanceDonationAssignment — Phase 1 gate", () => {
  function stagedSmall(): CampaignState {
    const s = newCampaign();
    startTownVisit(s, "ch2");
    s.minionParts["hero-01"] = 3;
    donateToAcademy(s, "hero-01", 3);
    resolveAcademyDonation(s);
    return s;
  }

  it("false when nothing is staged", () => {
    const s = newCampaign();
    expect(canAdvanceDonationAssignment(s)).toBe(false);
  });

  it("false until both rewards have an assigned hero", () => {
    const s = stagedSmall();
    expect(canAdvanceDonationAssignment(s)).toBe(false);
    s.pendingAcademyDonationResolution!.rewards[0]!.assignedHeroId = "hero-01";
    expect(canAdvanceDonationAssignment(s)).toBe(false);
    s.pendingAcademyDonationResolution!.rewards[1]!.assignedHeroId = "hero-02";
    expect(canAdvanceDonationAssignment(s)).toBe(true);
  });

  it("false when both rewards are assigned to the SAME hero (no double-assign)", () => {
    const s = stagedSmall();
    s.pendingAcademyDonationResolution!.rewards[0]!.assignedHeroId = "hero-01";
    s.pendingAcademyDonationResolution!.rewards[1]!.assignedHeroId = "hero-01";
    expect(canAdvanceDonationAssignment(s)).toBe(false);
  });

  it("false for large tier until each ticket has a chosenType picked", () => {
    const s = newCampaign();
    startTownVisit(s, "ch2");
    s.minionParts["hero-01"] = 10;
    donateToAcademy(s, "hero-01", 10);
    resolveAcademyDonation(s);
    const res = s.pendingAcademyDonationResolution!;
    res.rewards[0]!.assignedHeroId = "hero-01";
    res.rewards[1]!.assignedHeroId = "hero-02";
    // Heroes assigned but types not picked yet.
    expect(canAdvanceDonationAssignment(s)).toBe(false);
    res.rewards[0]!.chosenType = "Sword";
    expect(canAdvanceDonationAssignment(s)).toBe(false);
    res.rewards[1]!.chosenType = "Shockwave";
    expect(canAdvanceDonationAssignment(s)).toBe(true);
  });
});

// ---------- recordAcademyDonationPlacement + commit ---------------------

describe("recordAcademyDonationPlacement / commitAcademyDonationResolution", () => {
  function stagedAndAssigned(tier: "small" | "medium" | "large"): CampaignState {
    const s = newCampaign();
    startTownVisit(s, "ch2");
    const amount = tier === "small" ? 3 : tier === "medium" ? 8 : 12;
    s.minionParts["hero-01"] = amount;
    donateToAcademy(s, "hero-01", amount);
    resolveAcademyDonation(s);
    const res = s.pendingAcademyDonationResolution!;
    res.rewards[0]!.assignedHeroId = "hero-01";
    res.rewards[1]!.assignedHeroId = "hero-02";
    if (tier === "large") {
      res.rewards[0]!.chosenType = "Sword";
      res.rewards[1]!.chosenType = "Shockwave";
    }
    return s;
  }

  it("throws when no resolution is staged", () => {
    const s = newCampaign();
    expect(() => recordAcademyDonationPlacement(s, "hero-01", "OS", 0, 0)).toThrow(/no resolution/);
    expect(() => commitAcademyDonationResolution(s)).toThrow(/no resolution/);
  });

  it("throws when loadoutIdx or slotIdx is out of range", () => {
    const s = stagedAndAssigned("small");
    expect(() => recordAcademyDonationPlacement(s, "hero-01", "OS", -1, 0)).toThrow(/out of range/);
    expect(() => recordAcademyDonationPlacement(s, "hero-01", "OS", 0, 3)).toThrow(/out of range/);
  });

  it("throws when no reward ticket matches (heroId, type)", () => {
    const s = stagedAndAssigned("small");
    // OS is on hero-01 in the small tier; ask hero-02 to place OS.
    expect(() => recordAcademyDonationPlacement(s, "hero-02", "OS", 0, 0)).toThrow(/no reward ticket/);
  });

  it("throws when the target slot is already filled in suitLoadouts", () => {
    const s = stagedAndAssigned("small");
    s.suitLoadouts["hero-01"]![0]![0] = { type: "Gauntlet", rank: 1 };
    expect(() => recordAcademyDonationPlacement(s, "hero-01", "OS", 0, 0)).toThrow(/occupied/);
  });

  it("throws on double-placement of the same ticket", () => {
    const s = stagedAndAssigned("small");
    recordAcademyDonationPlacement(s, "hero-01", "OS", 0, 0);
    expect(() => recordAcademyDonationPlacement(s, "hero-01", "OS", 0, 1)).toThrow(/already placed/);
  });

  it("commit applies rank bumps + slot writes + clears the staging field", () => {
    const s = stagedAndAssigned("medium");
    recordAcademyDonationPlacement(s, "hero-01", "OS", 1, 2);
    recordAcademyDonationPlacement(s, "hero-02", "Battery", 0, 1);
    const events = commitAcademyDonationResolution(s);
    // Rank bumps land on suitConditionRankBonus.
    expect(s.suitConditionRankBonus["hero-01"]!.OS).toBe(2);
    expect(s.suitConditionRankBonus["hero-02"]!.Battery).toBe(2);
    // Slot writes land where the player picked.
    expect(s.suitLoadouts["hero-01"]![1]![2]).toEqual({ type: "OS", rank: 2 });
    expect(s.suitLoadouts["hero-02"]![0]![1]).toEqual({ type: "Battery", rank: 2 });
    // Staging field cleared.
    expect(s.pendingAcademyDonationResolution).toBeNull();
    expect(hasPendingAcademyDonationResolution(s)).toBe(false);
    // Two reward events emitted, one per placement.
    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({
      kind: "suit-condition-rank-bumped",
      heroId: "hero-01",
      equipmentType: "OS",
      delta: 2,
      source: "academy-donation-medium",
    });
    expect(events[1]).toMatchObject({
      kind: "suit-condition-rank-bumped",
      heroId: "hero-02",
      equipmentType: "Battery",
      delta: 2,
      source: "academy-donation-medium",
    });
  });

  it("large tier commit honours the player-chosen open types", () => {
    const s = stagedAndAssigned("large");
    recordAcademyDonationPlacement(s, "hero-01", "Sword", 0, 0);
    recordAcademyDonationPlacement(s, "hero-02", "Shockwave", 2, 2);
    const events = commitAcademyDonationResolution(s);
    expect(s.suitConditionRankBonus["hero-01"]!.Sword).toBe(2);
    expect(s.suitConditionRankBonus["hero-02"]!.Shockwave).toBe(2);
    expect(s.suitLoadouts["hero-01"]![0]![0]).toEqual({ type: "Sword", rank: 2 });
    expect(s.suitLoadouts["hero-02"]![2]![2]).toEqual({ type: "Shockwave", rank: 2 });
    expect(events.length).toBe(2);
    expect(events.map((e) => e.equipmentType)).toEqual(["Sword", "Shockwave"]);
  });

  it("commit throws when not every reward has a placement", () => {
    const s = stagedAndAssigned("small");
    recordAcademyDonationPlacement(s, "hero-01", "OS", 0, 0);
    expect(() => commitAcademyDonationResolution(s)).toThrow(/placements/);
  });
});

// ---------- getEffectiveEquipmentRank includes suit-condition bonus -----

describe("getEffectiveEquipmentRank — suitConditionRankBonus folded into the sum", () => {
  it("returns base + suit-condition bonus when no temp bonus is present", () => {
    const s = newCampaign();
    s.equipmentRanks["hero-01"]!.OS = 3;
    s.suitConditionRankBonus["hero-01"] = { OS: 1 };
    expect(getEffectiveEquipmentRank(s, "hero-01", "OS")).toBe(4);
  });

  it("stacks suit-condition + temporary bonus before clamp", () => {
    const s = newCampaign();
    s.equipmentRanks["hero-01"]!.OS = 2;
    s.suitConditionRankBonus["hero-01"] = { OS: 1 };
    s.temporaryRankBonus["hero-01"]!.OS = 1;
    expect(getEffectiveEquipmentRank(s, "hero-01", "OS")).toBe(4);
  });

  it("clamps the combined sum at EQUIPMENT_RANK_CAP", () => {
    const s = newCampaign();
    s.equipmentRanks["hero-01"]!.OS = 5;
    s.suitConditionRankBonus["hero-01"] = { OS: 3 };
    expect(getEffectiveEquipmentRank(s, "hero-01", "OS")).toBe(5);
  });

  it("returns positive rank for a slot the delver doesn't own but has a suit-condition bonus on", () => {
    const s = newCampaign();
    s.suitConditionRankBonus["hero-01"] = { Supercharger: 2 };
    expect(getEffectiveEquipmentRank(s, "hero-01", "Supercharger")).toBe(2);
  });
});

// ---------- TownVisitAction integration ----------------------------------

describe("resolve-academy-donation TownVisitAction integration", () => {
  it("runs the resolution helper, emits the academy-donation-resolved event, AND stages the resolution", () => {
    const s = newCampaign();
    startTownVisit(s, "ch2");
    s.minionParts["hero-01"] = 3;
    donateToAcademy(s, "hero-01", 3);
    const events = runTownVisitAction(s, { kind: "resolve-academy-donation" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "academy-donation-resolved",
      totalDonated: 3,
      tier: "small",
    });
    // Resolution staged for the modal; no bumps until commit.
    expect(s.pendingAcademyDonationResolution).not.toBeNull();
    expect(s.suitConditionRankBonus["hero-01"]).toEqual({});
    // Legacy suit-condition queue stays untouched by the new flow.
    expect(s.pendingSuitConditionPicks).toEqual([]);
  });
});

// ---------- finishTownVisit reset ----------------------------------------

describe("finishTownVisit — academy donation per-visit reset", () => {
  it("clears every delver's academyDonation accumulator", () => {
    const s = newCampaign();
    startTownVisit(s, "ch2");
    s.minionParts["hero-01"] = 5;
    s.minionParts["hero-02"] = 5;
    donateToAcademy(s, "hero-01", 3);
    donateToAcademy(s, "hero-02", 4);
    finishTownVisit(s);
    expect(s.academyDonation["hero-01"]).toBe(0);
    expect(s.academyDonation["hero-02"]).toBe(0);
  });

  it("PRESERVES suitConditionRankBonus across visits (the bumps are permanent)", () => {
    const s = newCampaign();
    startTownVisit(s, "ch2");
    s.minionParts["hero-01"] = 3;
    donateToAcademy(s, "hero-01", 3);
    resolveAcademyDonation(s);
    // Drain the staged resolution before finishing the visit.
    resolveStagedDonationLegacyDefaults(s);
    finishTownVisit(s);
    expect(s.suitConditionRankBonus["hero-01"]!.OS).toBe(1);
    expect(s.suitConditionRankBonus["hero-02"]!.Battery).toBe(1);
  });

  it("PRESERVES pendingAcademyDonationResolution across town-visit boundaries (campaign-scope staging)", () => {
    const s = newCampaign();
    startTownVisit(s, "ch2");
    s.minionParts["hero-01"] = 3;
    donateToAcademy(s, "hero-01", 3);
    resolveAcademyDonation(s);
    // Player closes the visit mid-modal — the staging must survive.
    expect(s.pendingAcademyDonationResolution).not.toBeNull();
    finishTownVisit(s);
    expect(s.pendingAcademyDonationResolution).not.toBeNull();
  });
});

// ---------- Defensive guard on purchaseShopProduct ----------------------

describe("purchaseShopProduct refuses the variableMinionParts donation product", () => {
  it("returns not-available without mutating state", () => {
    const s = newCampaign();
    startTownVisit(s, "ch2");
    s.minionParts["hero-01"] = 50;
    s.shopProductsAvailable.push(8); // donation product
    const minionBefore = s.minionParts["hero-01"];
    const ownedBefore = (s.shopProductsOwned["hero-01"] ?? []).slice();
    const err = purchaseShopProduct(s, "hero-01", 8);
    expect(err).toEqual({ code: "not-available" });
    expect(s.minionParts["hero-01"]).toBe(minionBefore);
    expect(s.shopProductsOwned["hero-01"] ?? []).toEqual(ownedBefore);
    expect(s.shopProductsAvailable).toContain(8);
  });
});
