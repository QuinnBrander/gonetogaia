/**
 * Opinion-Card abilities — comprehensive coverage of the v36 system:
 *
 *   - Schema migration v35 -> v36 (backfill all new fields).
 *   - `getEffectiveEquipmentRank` clamping + combination math.
 *   - Xavier picks: enqueue at quest start, FIFO resolution,
 *     temporary bonus folding, quest-end wipe.
 *   - Flores shop discount + Vera gift (in `engine/townVisit.ts`).
 *   - Rodrigo consumable refresh + Elayna heal-to-full (Nov 15 cards).
 *   - Samantha shield: intercept negative shift, mark spent.
 *   - v59 -> v60: drop the old Samantha boss-part discount latch.
 *   - Arlen ally: tracked but inert (no engine wiring fires).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  EQUIPMENT_RANK_CAP,
  type EquipmentType,
} from "../types";
import {
  getEffectiveEquipmentRank,
  getEffectiveEquipmentRanks,
  migrateV35ToV36,
  migrateV59ToV60,
  newCampaign,
  type CampaignState,
} from "../state";
import {
  applyOpinionGrantsForQuest,
  applyOpinionRankPick,
  eligibleEquipmentTypesForPick,
  hasPendingOpinionRankPicks,
  peekNextOpinionRankPick,
} from "../engine/opinionGrants";
import {
  effectiveShopProductCost,
  purchaseShopProduct,
  redeemFloresAlly,
  redeemVeraAlly,
  startTownVisit,
  runTownVisitAction,
  finishTownVisit,
} from "../engine/townVisit";
import {
  canShowElaynaRedeemButton,
  canShowRodrigoRedeemButton,
  countSpentTokens,
  redeemElaynaAlly,
  redeemRodrigoAlly,
} from "../engine/opinionRedeem";
import * as DATA from "../data";
import * as TownVisitModule from "../engine/townVisit";
import * as OpinionRedeemModule from "../engine/opinionRedeem";
import * as OpinionPenaltyModule from "../engine/opinionPenalty";

// ---------- v35 -> v36 migration ------------------------------------------

describe("migrateV35ToV36 — Opinion Card ability backfill", () => {
  it("graduates a v35 save to v36 (intermediate version, not SCHEMA_VERSION)", () => {
    // Hard-code 36 (not SCHEMA_VERSION) so future migrations
    // don't silently regress this — the v36 -> v37 migration
    // (Academy donation backfill) is what actually graduates the
    // save to SCHEMA_VERSION. This test verifies the intermediate
    // stop; chained migration coverage lives in loadCampaign tests.
    const save = { version: 35, encounter: null, loadouts: {} };
    const out = migrateV35ToV36(save) as CampaignState;
    expect(out.version).toBe(36);
  });

  it("backfills every new field with safe defaults when absent", () => {
    const save = {
      version: 35,
      encounter: null,
      loadouts: { "hero-01": {}, "hero-02": {} },
    };
    const out = migrateV35ToV36(save) as unknown as CampaignState;
    expect(out.temporaryRankBonus).toEqual({ "hero-01": {}, "hero-02": {} });
    expect(out.opinionCardsSpent).toEqual([]);
    expect((out as unknown as Record<string, unknown>).samanthaDiscountActive).toBe(false);
    expect(out.floresDiscountArmed).toBe(false);
    expect(out.opinionGrantsAppliedQuests).toEqual([]);
  });

  it("backfills pendingOpinionRankPicks = [] on a v35 encounter that predates the field", () => {
    const save = {
      version: 35,
      encounter: { /* shape doesn't matter for this test */ },
      loadouts: { "hero-01": {}, "hero-02": {} },
    };
    const out = migrateV35ToV36(save) as unknown as { encounter: { pendingOpinionRankPicks: unknown } };
    expect(out.encounter.pendingOpinionRankPicks).toEqual([]);
  });

  it("does NOT clobber pre-existing values (forward-compat)", () => {
    const save = {
      version: 35,
      encounter: null,
      loadouts: { "hero-01": {} },
      temporaryRankBonus: { "hero-01": { Gauntlet: 1 } },
      opinionCardsSpent: ["samantha-ally"],
      samanthaDiscountActive: true,
      floresDiscountArmed: true,
      opinionGrantsAppliedQuests: ["quest2"],
    };
    const out = migrateV35ToV36(save) as unknown as CampaignState;
    expect(out.temporaryRankBonus["hero-01"]).toEqual({ Gauntlet: 1 });
    expect(out.opinionCardsSpent).toEqual(["samantha-ally"]);
    expect((out as unknown as Record<string, unknown>).samanthaDiscountActive).toBe(true);
    expect(out.floresDiscountArmed).toBe(true);
    expect(out.opinionGrantsAppliedQuests).toEqual(["quest2"]);
  });
});

describe("migrateV59ToV60 - Nov 15 opinion-card rules", () => {
  it("drops samanthaDiscountActive, keeps spent ids, and lands on v60", () => {
    const save = { version: 59, samanthaDiscountActive: true, opinionCardsSpent: ["samantha-ally"] };
    const out = migrateV59ToV60(save) as unknown as Record<string, unknown>;
    expect(out.version).toBe(60);
    expect("samanthaDiscountActive" in out).toBe(false);
    expect(out.opinionCardsSpent).toEqual(["samantha-ally"]);
  });
});

// ---------- getEffectiveEquipmentRank --------------------------------------

describe("getEffectiveEquipmentRank — base + bonus clamp", () => {
  let s: CampaignState;
  beforeEach(() => {
    s = newCampaign();
  });

  it("returns base rank when no bonus is set", () => {
    s.equipmentRanks["hero-01"]!.Gauntlet = 3;
    expect(getEffectiveEquipmentRank(s, "hero-01", "Gauntlet")).toBe(3);
  });

  it("adds positive bonus on top of base", () => {
    s.equipmentRanks["hero-01"]!.Gauntlet = 3;
    s.temporaryRankBonus["hero-01"] = { Gauntlet: 1 };
    expect(getEffectiveEquipmentRank(s, "hero-01", "Gauntlet")).toBe(4);
  });

  it("subtracts negative bonus from base", () => {
    s.equipmentRanks["hero-01"]!.Gauntlet = 3;
    s.temporaryRankBonus["hero-01"] = { Gauntlet: -1 };
    expect(getEffectiveEquipmentRank(s, "hero-01", "Gauntlet")).toBe(2);
  });

  it("clamps at the rank cap (R5)", () => {
    s.equipmentRanks["hero-01"]!.Gauntlet = 5;
    s.temporaryRankBonus["hero-01"] = { Gauntlet: 1 };
    expect(getEffectiveEquipmentRank(s, "hero-01", "Gauntlet")).toBe(EQUIPMENT_RANK_CAP);
  });

  it("clamps at 0 (negative bonus on R1 yields R0 -> card disappears)", () => {
    s.equipmentRanks["hero-01"]!.Gauntlet = 1;
    s.temporaryRankBonus["hero-01"] = { Gauntlet: -1 };
    expect(getEffectiveEquipmentRank(s, "hero-01", "Gauntlet")).toBe(0);
  });

  it("returns 0 for a slot the delver doesn't own and has no bonus on", () => {
    expect(getEffectiveEquipmentRank(s, "hero-01", "Trident")).toBe(0);
  });

  it("returns 1 for an unowned slot when a +1 bonus is applied (grants R1)", () => {
    s.temporaryRankBonus["hero-01"] = { Trident: 1 };
    expect(getEffectiveEquipmentRank(s, "hero-01", "Trident")).toBe(1);
  });

  it("getEffectiveEquipmentRanks merges base + bonus keys", () => {
    s.equipmentRanks["hero-01"]!.Gauntlet = 3;
    s.temporaryRankBonus["hero-01"] = { Trident: 1, Boots: -1 };
    const out = getEffectiveEquipmentRanks(s, "hero-01");
    expect(out.Gauntlet).toBe(3);
    expect(out.Trident).toBe(1);
    expect(out.Boots).toBeGreaterThanOrEqual(0);
  });
});

// ---------- Xavier picks (engine/opinionGrants) ---------------------------

/** Build a state with an active Q2 encounter so opinion-grants
 *  can enqueue picks. Returns the bare encounter shape needed by
 *  the helper; bypasses `buildEncounter` so the tests are pure
 *  unit tests of the grant logic. */
function newStateWithQ2Encounter(): CampaignState {
  const s = newCampaign();
  // Synthesize a minimal-but-functional EncounterState for
  // opinion-grant unit tests. We don't go through
  // `buildEncounter` because (a) it pulls the full quest spawn
  // deck and (b) we only need the bits Xavier picks actually
  // touch: `questId`, `delverPositions` (read by the grants
  // helper to enumerate delvers), and `pendingOpinionRankPicks`
  // (the destination). Cast to `EncounterState` to bypass the
  // strict-shape check on fields irrelevant to opinion grants.
  // Tests that need real combat / wave behavior should call
  // `buildEncounter` instead.
  s.encounter = {
    questId: "quest2",
    waveNumber: 1,
    delverPositions: { "hero-01": { x: 0, y: 0 }, "hero-02": { x: 0, y: 0 } },
    witnessPosition: null,
    pendingOpinionRankPicks: [],
  } as unknown as CampaignState["encounter"];
  return s;
}

describe("applyOpinionGrantsForQuest — enqueue at quest start", () => {
  it("enqueues nothing when no Xavier card is owned", () => {
    const s = newStateWithQ2Encounter();
    applyOpinionGrantsForQuest(s, "quest2");
    expect(s.encounter!.pendingOpinionRankPicks).toEqual([]);
    expect(s.opinionGrantsAppliedQuests).toEqual(["quest2"]);
  });

  it("enqueues 1 +1 pick (heroId=null) for Xavier Ally", () => {
    const s = newStateWithQ2Encounter();
    s.opinionCards.push({ characterId: "xavier", characterName: "Xavier", level: "ally" });
    applyOpinionGrantsForQuest(s, "quest2");
    expect(s.encounter!.pendingOpinionRankPicks).toHaveLength(1);
    expect(s.encounter!.pendingOpinionRankPicks[0]).toMatchObject({
      source: "xavier-ally",
      delta: 1,
      heroId: null,
    });
  });

  it("enqueues 1 -1 pick (heroId=null) for Xavier Detractor", () => {
    const s = newStateWithQ2Encounter();
    s.opinionCards.push({ characterId: "xavier", characterName: "Xavier", level: "detractor" });
    applyOpinionGrantsForQuest(s, "quest2");
    expect(s.encounter!.pendingOpinionRankPicks).toHaveLength(1);
    expect(s.encounter!.pendingOpinionRankPicks[0]).toMatchObject({
      source: "xavier-detractor",
      delta: -1,
      heroId: null,
    });
  });

  it("enqueues 2 +1 picks (one per delver, pinned heroIds) for Xavier Confidant", () => {
    const s = newStateWithQ2Encounter();
    s.opinionCards.push({ characterId: "xavier", characterName: "Xavier", level: "confidant" });
    applyOpinionGrantsForQuest(s, "quest2");
    const picks = s.encounter!.pendingOpinionRankPicks;
    expect(picks).toHaveLength(2);
    expect(picks.map((p) => p.heroId).sort()).toEqual(["hero-01", "hero-02"]);
    for (const p of picks) {
      expect(p.source).toBe("xavier-confidant");
      expect(p.delta).toBe(1);
    }
  });

  it("idempotent across re-entry — re-calling does NOT double-enqueue", () => {
    const s = newStateWithQ2Encounter();
    s.opinionCards.push({ characterId: "xavier", characterName: "Xavier", level: "ally" });
    applyOpinionGrantsForQuest(s, "quest2");
    applyOpinionGrantsForQuest(s, "quest2");
    expect(s.encounter!.pendingOpinionRankPicks).toHaveLength(1);
  });

  it("no-op when there's no encounter (caller's next ensureEncounter will retry)", () => {
    const s = newCampaign();
    s.opinionCards.push({ characterId: "xavier", characterName: "Xavier", level: "ally" });
    const enqueued = applyOpinionGrantsForQuest(s, "quest2");
    expect(enqueued).toEqual([]);
    // Idempotency ledger should also stay empty so a future
    // ensureEncounter call (with an encounter present) actually
    // fires.
    expect(s.opinionGrantsAppliedQuests).toEqual([]);
  });
});

describe("applyOpinionRankPick — FIFO resolution + temporaryRankBonus folding", () => {
  it("folds a +1 pick into temporaryRankBonus + emits opinion-rank-bumped event", () => {
    const s = newStateWithQ2Encounter();
    s.opinionCards.push({ characterId: "xavier", characterName: "Xavier", level: "ally" });
    applyOpinionGrantsForQuest(s, "quest2");
    const pick = peekNextOpinionRankPick(s)!;
    s.equipmentRanks["hero-01"]!.Gauntlet = 2;
    const r = applyOpinionRankPick(s, pick.pickId, "hero-01", "Gauntlet");
    expect(r.effectiveBefore).toBe(2);
    expect(r.effectiveAfter).toBe(3);
    expect(s.temporaryRankBonus["hero-01"]!.Gauntlet).toBe(1);
    expect(s.encounter!.pendingOpinionRankPicks).toHaveLength(0);
    expect(r.reward.kind).toBe("opinion-rank-bumped");
    expect(r.reward.delta).toBe(1);
    expect(r.reward.source).toBe("xavier-ally");
  });

  it("clamps a +1 pick on a R5 slot to the cap (reward records the clamp)", () => {
    const s = newStateWithQ2Encounter();
    s.opinionCards.push({ characterId: "xavier", characterName: "Xavier", level: "ally" });
    applyOpinionGrantsForQuest(s, "quest2");
    const pick = peekNextOpinionRankPick(s)!;
    s.equipmentRanks["hero-01"]!.Gauntlet = 5;
    const r = applyOpinionRankPick(s, pick.pickId, "hero-01", "Gauntlet");
    expect(r.effectiveBefore).toBe(5);
    expect(r.effectiveAfter).toBe(5);
  });

  it("rejects out-of-order resolution (pickId must match queue head)", () => {
    const s = newStateWithQ2Encounter();
    s.opinionCards.push({ characterId: "xavier", characterName: "Xavier", level: "confidant" });
    applyOpinionGrantsForQuest(s, "quest2");
    expect(() =>
      applyOpinionRankPick(s, "non-existent-pick-id", "hero-01", "Gauntlet"),
    ).toThrow(/head pickId/);
  });

  it("rejects mismatched heroId for a pinned Confidant pick", () => {
    const s = newStateWithQ2Encounter();
    s.opinionCards.push({ characterId: "xavier", characterName: "Xavier", level: "confidant" });
    applyOpinionGrantsForQuest(s, "quest2");
    const head = peekNextOpinionRankPick(s)!;
    const wrongHero = head.heroId === "hero-01" ? "hero-02" : "hero-01";
    expect(() =>
      applyOpinionRankPick(s, head.pickId, wrongHero, "Gauntlet"),
    ).toThrow(/pinned to heroId/);
  });

  it("eligibleEquipmentTypesForPick filters R5 for +1 and R0 for -1", () => {
    const s = newStateWithQ2Encounter();
    s.equipmentRanks["hero-01"]!.Gauntlet = 5; // capped
    s.equipmentRanks["hero-01"]!.Hammer = 3;   // bumpable
    const allTypes = ["Gauntlet", "Hammer", "Trident"] as EquipmentType[];
    const upPick = { delta: 1 as const, source: "xavier-ally", pickId: "x", heroId: null };
    const downPick = { delta: -1 as const, source: "xavier-detractor", pickId: "x", heroId: null };
    const upEligible = eligibleEquipmentTypesForPick(s, upPick, "hero-01", allTypes);
    const downEligible = eligibleEquipmentTypesForPick(s, downPick, "hero-01", allTypes);
    expect(upEligible).toEqual(["Hammer", "Trident"]);     // Gauntlet capped, others < cap
    expect(downEligible).toEqual(["Gauntlet", "Hammer"]); // Trident R0 not eligible
  });

  it("hasPendingOpinionRankPicks reports queue state", () => {
    const s = newStateWithQ2Encounter();
    expect(hasPendingOpinionRankPicks(s)).toBe(false);
    s.opinionCards.push({ characterId: "xavier", characterName: "Xavier", level: "ally" });
    applyOpinionGrantsForQuest(s, "quest2");
    expect(hasPendingOpinionRankPicks(s)).toBe(true);
    const head = peekNextOpinionRankPick(s)!;
    applyOpinionRankPick(s, head.pickId, "hero-01", "Gauntlet");
    expect(hasPendingOpinionRankPicks(s)).toBe(false);
  });
});

// ---------- Flores shop discount -----------------------------------------

describe("effectiveShopProductCost - Flores discount", () => {
  it("no-op when the discount isn't armed", () => {
    const s = newCampaign();
    const cost = effectiveShopProductCost(s, 1);
    expect(cost.floresApplied).toBe(false);
  });

  it("Flores alone removes 1 boss-part when a boss-lvl-1 cost is present", () => {
    const s = newCampaign();
    s.floresDiscountArmed = true;
    const target = (DATA as unknown as { SHOP_PRODUCTS: Array<{ number: number; cost: { bossLvl1: number } }> })
      .SHOP_PRODUCTS.find((p) => p.cost.bossLvl1 > 0);
    if (!target) {
      // Defensive — should never happen with current data, but
      // skip rather than false-positive if shop data later loses
      // every boss-part product.
      return;
    }
    const cost = effectiveShopProductCost(s, target.number);
    expect(cost.floresApplied).toBe(true);
    expect(cost.bossLvl1).toBe(target.cost.bossLvl1 - 1);
  });

  it("Flores stays armed on a minion-only product (no boss part to remove)", () => {
    const s = newCampaign();
    s.floresDiscountArmed = true;
    const minionOnly = (DATA as unknown as { SHOP_PRODUCTS: Array<{ number: number; cost: { bossLvl1: number; bossLvl2: number; minionParts: number } }> })
      .SHOP_PRODUCTS.find((p) =>
        p.cost.bossLvl1 === 0 && p.cost.bossLvl2 === 0 && p.cost.minionParts > 0,
      );
    if (!minionOnly) return;
    const cost = effectiveShopProductCost(s, minionOnly.number);
    expect(cost.floresApplied).toBe(false);
    expect(s.floresDiscountArmed).toBe(true); // still armed
  });
});

describe("purchaseShopProduct — discount application + Flores latch clear", () => {
  it("clears floresDiscountArmed on successful debit that used the discount", () => {
    const s = newCampaign();
    s.floresDiscountArmed = true;
    const product = (DATA as unknown as { SHOP_PRODUCTS: Array<{ number: number; cost: { bossLvl1: number; minionParts: number } }> })
      .SHOP_PRODUCTS.find((p) => p.cost.bossLvl1 >= 1 && p.cost.minionParts <= 0);
    if (!product) return;
    // Seed buyer's wallet to afford the discounted price exactly.
    s.shopProductsAvailable.push(product.number);
    s.bossParts["hero-01"] = Math.max(0, product.cost.bossLvl1 - 1);
    s.minionParts["hero-01"] = product.cost.minionParts;
    const err = purchaseShopProduct(s, "hero-01", product.number);
    expect(err).toBeNull();
    expect(s.floresDiscountArmed).toBe(false);
  });
});

describe("redeemVeraAlly / redeemFloresAlly preflight", () => {
  it("rejects when no town visit is in progress (Vera card owned)", () => {
    const s = newCampaign();
    s.opinionCards.push({ characterId: "vera", characterName: "Vera Brass", level: "ally" });
    expect(redeemVeraAlly(s, "hero-01")).toEqual({ code: "no-town-visit" });
    // `no-town-visit` is checked before ownership in the shared preflight.
    expect(redeemFloresAlly(s)).toEqual({ code: "no-town-visit" });
  });

  it("rejects when the card isn't owned", () => {
    const s = newCampaign();
    startTownVisit(s, "ch1");
    expect(redeemVeraAlly(s, "hero-01")).toEqual({ code: "card-not-owned" });
  });

  it("rejects when the card has already been spent", () => {
    const s = newCampaign();
    s.opinionCards.push({ characterId: "vera", characterName: "Vera Brass", level: "ally" });
    startTownVisit(s, "ch1");
    s.opinionCardsSpent.push("vera-ally");
    expect(redeemVeraAlly(s, "hero-01")).toEqual({ code: "already-spent" });
  });

  it("redeemVeraAlly gives the chosen delver 1 Lvl 2 boss part + marks the card spent", () => {
    const s = newCampaign();
    s.opinionCards.push({ characterId: "vera", characterName: "Vera Brass", level: "ally" });
    startTownVisit(s, "ch1");
    expect(redeemVeraAlly(s, "hero-02")).toBeNull();
    expect(s.bossPartsLvl2["hero-02"]).toBe(1);
    expect(s.bossPartsLvl2["hero-01"]).toBe(0);
    expect(s.opinionCardsSpent).toContain("vera-ally");
  });

  it("redeemVeraAlly throws on an unknown delver", () => {
    const s = newCampaign();
    s.opinionCards.push({ characterId: "vera", characterName: "Vera Brass", level: "ally" });
    startTownVisit(s, "ch1");
    expect(() => redeemVeraAlly(s, "hero-99")).toThrow();
  });

  it("redeemFloresAlly flips floresDiscountArmed + appends to opinionCardsSpent", () => {
    const s = newCampaign();
    s.opinionCards.push({ characterId: "flores", characterName: "Flores", level: "ally" });
    startTownVisit(s, "ch1");
    expect(redeemFloresAlly(s)).toBeNull();
    expect(s.floresDiscountArmed).toBe(true);
    expect(s.opinionCardsSpent).toContain("flores-ally");
  });

  it("finishTownVisit resets the Flores latch (spent record persists)", () => {
    const s = newCampaign();
    s.opinionCards.push({ characterId: "flores", characterName: "Flores", level: "ally" });
    startTownVisit(s, "ch1");
    redeemFloresAlly(s);
    finishTownVisit(s);
    expect(s.floresDiscountArmed).toBe(false);
    expect(s.opinionCardsSpent).toContain("flores-ally");
  });
});

// ---------- Rodrigo refresh (Elemental Kit) --------------------------------

describe("redeemRodrigoAlly", () => {
  it("rejects when the card isn't owned", () => {
    const s = newCampaign();
    expect(redeemRodrigoAlly(s)).toEqual({ code: "card-not-owned" });
  });

  it("rejects when already spent", () => {
    const s = newCampaign();
    s.opinionCards.push({ characterId: "rodrigo", characterName: "Rodrigo", level: "ally" });
    s.opinionCardsSpent.push("rodrigo-ally");
    expect(redeemRodrigoAlly(s)).toEqual({ code: "already-spent" });
  });

  it("rejects when there are no spent tokens to refresh", () => {
    const s = newCampaign();
    s.opinionCards.push({ characterId: "rodrigo", characterName: "Rodrigo", level: "ally" });
    expect(redeemRodrigoAlly(s)).toEqual({ code: "nothing-to-do" });
  });

  it("refreshes every spent token + marks card spent on success", () => {
    const s = newCampaign();
    s.opinionCards.push({ characterId: "rodrigo", characterName: "Rodrigo", level: "ally" });
    s.consumableTokens["hero-01"]!.reroll = { available: 1, spent: 2 };
    s.consumableTokens["hero-02"]!["damage-2x-light"] = { available: 0, spent: 1 };
    expect(countSpentTokens(s)).toBe(3);
    expect(redeemRodrigoAlly(s)).toBeNull();
    expect(s.consumableTokens["hero-01"]!.reroll).toEqual({ available: 3, spent: 0 });
    expect(s.consumableTokens["hero-02"]!["damage-2x-light"]).toEqual({ available: 1, spent: 0 });
    expect(s.opinionCardsSpent).toContain("rodrigo-ally");
  });

  it("canShowRodrigoRedeemButton: owned + unspent only", () => {
    const s = newCampaign();
    expect(canShowRodrigoRedeemButton(s)).toBe(false);
    s.opinionCards.push({ characterId: "rodrigo", characterName: "Rodrigo", level: "ally" });
    expect(canShowRodrigoRedeemButton(s)).toBe(true);
    s.opinionCardsSpent.push("rodrigo-ally");
    expect(canShowRodrigoRedeemButton(s)).toBe(false);
  });
});

// ---------- Elayna heal (Med Kit) ------------------------------------------

describe("redeemElaynaAlly", () => {
  it("rejects when the card isn't owned", () => {
    const s = newCampaign();
    expect(redeemElaynaAlly(s)).toEqual({ code: "card-not-owned" });
  });

  it("rejects when nobody living is hurt", () => {
    const s = newCampaign();
    s.opinionCards.push({ characterId: "elayne", characterName: "Elayna", level: "ally" });
    expect(redeemElaynaAlly(s)).toEqual({ code: "nothing-to-do" });
  });

  it("heals living delvers to full, skips a downed delver, marks the card spent", () => {
    const s = newCampaign();
    s.opinionCards.push({ characterId: "elayne", characterName: "Elayna", level: "ally" });
    const h1 = s.loadouts["hero-01"]!;
    const h2 = s.loadouts["hero-02"]!;
    h1.currentHp = 1;
    h2.currentHp = 0;
    expect(redeemElaynaAlly(s)).toBeNull();
    expect(h1.currentHp).toBe(h1.maxHp);
    expect(h2.currentHp).toBe(0);
    expect(s.opinionCardsSpent).toContain("elayne-ally");
    expect(canShowElaynaRedeemButton(s)).toBe(false);
  });
});

// ---------- Samantha shield (Popular) --------------------------------------

describe("Samantha Ally - shift-favour intercept", () => {
  it("shields ANY negative shift when Samantha Ally is owned + unspent", () => {
    const s = newCampaign();
    s.opinionCards.push({ characterId: "samantha", characterName: "Samantha", level: "ally" });
    s.favour["xavier"] = { name: "Xavier", value: 2 };
    const events = runTownVisitAction(s, {
      kind: "shift-favour",
      characterId: "xavier",
      characterName: "Xavier",
      delta: -1,
    });
    expect(s.favour["xavier"]!.value).toBe(2);
    expect(s.opinionCardsSpent).toContain("samantha-ally");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "opinion-card-shielded-decrease",
      shieldedCharacterId: "xavier",
      preventedDelta: -1,
    });
  });

  it("passes through a positive shift untouched (the card is a SHIELD against decreases)", () => {
    const s = newCampaign();
    s.opinionCards.push({ characterId: "samantha", characterName: "Samantha", level: "ally" });
    s.favour["arlen"] = { name: "Arlen", value: 0 };
    runTownVisitAction(s, { kind: "shift-favour", characterId: "arlen", characterName: "Arlen", delta: +1 });
    expect(s.favour["arlen"]!.value).toBe(1);
    expect(s.opinionCardsSpent).not.toContain("samantha-ally");
  });

  it("passes through a negative shift after Samantha's card is spent", () => {
    const s = newCampaign();
    s.opinionCards.push({ characterId: "samantha", characterName: "Samantha", level: "ally" });
    s.opinionCardsSpent.push("samantha-ally");
    s.favour["xavier"] = { name: "Xavier", value: 0 };
    runTownVisitAction(s, { kind: "shift-favour", characterId: "xavier", characterName: "Xavier", delta: -1 });
    expect(s.favour["xavier"]!.value).toBe(-1);
  });

  it("Vera Ally no longer shields (its Nov 15 effect is the Gift)", () => {
    const s = newCampaign();
    s.opinionCards.push({ characterId: "vera", characterName: "Vera Brass", level: "ally" });
    s.favour["xavier"] = { name: "Xavier", value: 1 };
    runTownVisitAction(s, { kind: "shift-favour", characterId: "xavier", characterName: "Xavier", delta: -1 });
    expect(s.favour["xavier"]!.value).toBe(0);
    expect(s.opinionCardsSpent).not.toContain("vera-ally");
  });
});

// ---------- Arlen tracked-but-inert ---------------------------------------

describe("Arlen Ally — tracked but inert", () => {
  it("is in OPINION_CARDS catalog (so its art renders on the Campaign Sheet)", () => {
    const cat = (DATA as unknown as { OPINION_CARDS: Array<{ characterId: string; level: string }>; opinionCardImageOrNull: (cid: string, lvl: string) => string | null });
    const arlen = cat.OPINION_CARDS.find(
      (c) => c.characterId === "arlen" && c.level === "ally",
    );
    expect(arlen).toBeTruthy();
    expect(cat.opinionCardImageOrNull("arlen", "ally")).toBeTruthy();
  });

  it("crossing Arlen Ally never produces a redeem entry point yet (no shop button, no top-bar button)", () => {
    // Arlen has no redemption helper exposed in either townVisit.ts
    // or opinionRedeem.ts — verify by structural assertion. If a
    // future change ships donations, this test should be replaced
    // with the actual redemption coverage.
    expect((TownVisitModule as Record<string, unknown>).redeemArlenAlly).toBeUndefined();
    expect((OpinionRedeemModule as Record<string, unknown>).redeemArlenAlly).toBeUndefined();
  });
});

// ---------- Samantha Detractor (penalty) ----------------------------------

describe("Samantha Detractor opinion card — catalog + art", () => {
  it("is registered in OPINION_CARDS so the rewards modal renders the printed art", () => {
    const cat = (DATA as unknown as { OPINION_CARDS: Array<{ characterId: string; level: string; image: string }>; opinionCardImageOrNull: (cid: string, lvl: string) => string | null });
    const det = cat.OPINION_CARDS.find(
      (c) => c.characterId === "samantha" && c.level === "detractor",
    );
    expect(det).toBeTruthy();
    expect(det!.image).toBe("opinion-samantha-detractor.png");
    expect(cat.opinionCardImageOrNull("samantha", "detractor")).toBe(
      "opinion-samantha-detractor.png",
    );
  });

  it("is granted automatically when Samantha's favour drops to detractor", () => {
    // End-to-end through the favour engine: the existing `shift-favour`
    // action emits an `opinion-card-gained` event for every newly-
    // entered named level. With detractor art now in the catalog the
    // engine no longer suppresses the event for "missing art", so the
    // card lands in `opinionCards` with the `samantha-detractor` key.
    const s = newCampaign();
    startTownVisit(s, "ch1");
    runTownVisitAction(s, {
      kind: "shift-favour",
      characterId: "samantha",
      characterName: "Samantha",
      delta: -1,
    });
    const owned = s.opinionCards.some(
      (c) => c.characterId === "samantha" && c.level === "detractor",
    );
    expect(owned).toBe(true);
  });
});

describe("hasUnresolvedSamanthaDetractor", () => {
  it("returns false when the card was never granted", () => {
    const s = newCampaign();
    expect(OpinionPenaltyModule.hasUnresolvedSamanthaDetractor(s)).toBe(false);
  });

  it("returns true when the card is owned and unresolved", () => {
    const s = newCampaign();
    s.opinionCards.push({ characterId: "samantha", characterName: "Samantha", level: "detractor" });
    expect(OpinionPenaltyModule.hasUnresolvedSamanthaDetractor(s)).toBe(true);
  });

  it("returns false once the card has been resolved (spent flag)", () => {
    const s = newCampaign();
    s.opinionCards.push({ characterId: "samantha", characterName: "Samantha", level: "detractor" });
    s.opinionCardsSpent.push("samantha-detractor");
    expect(OpinionPenaltyModule.hasUnresolvedSamanthaDetractor(s)).toBe(false);
  });
});

describe("isShopProductBlockedBySamanthaDetractor", () => {
  it("only blocks Machinist-hosted products while the card is unresolved", () => {
    const s = newCampaign();
    s.opinionCards.push({ characterId: "samantha", characterName: "Samantha", level: "detractor" });
    // #41 = Shock Gauntlet (location: "Machinist") → blocked.
    expect(OpinionPenaltyModule.isShopProductBlockedBySamanthaDetractor(s, 41)).toBe(true);
    // #1 = Trident (location: "Equipment Market") → allowed.
    expect(OpinionPenaltyModule.isShopProductBlockedBySamanthaDetractor(s, 1)).toBe(false);
  });

  it("never blocks anything when the card isn't owned", () => {
    const s = newCampaign();
    expect(OpinionPenaltyModule.isShopProductBlockedBySamanthaDetractor(s, 41)).toBe(false);
    expect(OpinionPenaltyModule.isShopProductBlockedBySamanthaDetractor(s, 32)).toBe(false);
    expect(OpinionPenaltyModule.isShopProductBlockedBySamanthaDetractor(s, 34)).toBe(false);
  });

  it("stops blocking once the card is resolved (spent flag set)", () => {
    const s = newCampaign();
    s.opinionCards.push({ characterId: "samantha", characterName: "Samantha", level: "detractor" });
    expect(OpinionPenaltyModule.isShopProductBlockedBySamanthaDetractor(s, 32)).toBe(true);
    s.opinionCardsSpent.push("samantha-detractor");
    expect(OpinionPenaltyModule.isShopProductBlockedBySamanthaDetractor(s, 32)).toBe(false);
  });
});

describe("resolveSamanthaDetractor — preflight + state mutation", () => {
  it("rejects when no town visit is in progress", () => {
    const s = newCampaign();
    s.opinionCards.push({ characterId: "samantha", characterName: "Samantha", level: "detractor" });
    s.bossParts["hero-01"] = 5;
    expect(OpinionPenaltyModule.resolveSamanthaDetractor(s, "hero-01"))
      .toEqual({ code: "no-town-visit" });
  });

  it("rejects when the card isn't owned", () => {
    const s = newCampaign();
    startTownVisit(s, "ch1");
    s.bossParts["hero-01"] = 5;
    expect(OpinionPenaltyModule.resolveSamanthaDetractor(s, "hero-01"))
      .toEqual({ code: "card-not-owned" });
  });

  it("rejects when the card is already resolved", () => {
    const s = newCampaign();
    startTownVisit(s, "ch1");
    s.opinionCards.push({ characterId: "samantha", characterName: "Samantha", level: "detractor" });
    s.opinionCardsSpent.push("samantha-detractor");
    s.bossParts["hero-01"] = 5;
    expect(OpinionPenaltyModule.resolveSamanthaDetractor(s, "hero-01"))
      .toEqual({ code: "already-resolved" });
  });

  it("rejects when the paying delver has no Lvl 1 boss parts", () => {
    const s = newCampaign();
    startTownVisit(s, "ch1");
    s.opinionCards.push({ characterId: "samantha", characterName: "Samantha", level: "detractor" });
    s.bossParts["hero-01"] = 0;
    expect(OpinionPenaltyModule.resolveSamanthaDetractor(s, "hero-01"))
      .toEqual({ code: "insufficient-boss-lvl-1" });
  });

  it("debits 1 boss part + appends spent flag on success (atomic)", () => {
    const s = newCampaign();
    startTownVisit(s, "ch1");
    s.opinionCards.push({ characterId: "samantha", characterName: "Samantha", level: "detractor" });
    s.bossParts["hero-01"] = 2;
    s.bossParts["hero-02"] = 1;
    expect(OpinionPenaltyModule.resolveSamanthaDetractor(s, "hero-01")).toBeNull();
    expect(s.bossParts["hero-01"]).toBe(1);
    expect(s.bossParts["hero-02"]).toBe(1); // unaffected
    expect(s.opinionCardsSpent).toContain("samantha-detractor");
  });

  it("either delver may pay (the other delver's wallet is irrelevant)", () => {
    const s = newCampaign();
    startTownVisit(s, "ch1");
    s.opinionCards.push({ characterId: "samantha", characterName: "Samantha", level: "detractor" });
    s.bossParts["hero-01"] = 0;
    s.bossParts["hero-02"] = 1;
    expect(OpinionPenaltyModule.resolveSamanthaDetractor(s, "hero-02")).toBeNull();
    expect(s.bossParts["hero-02"]).toBe(0);
  });

  it("does NOT mutate state when any preflight rejects", () => {
    const s = newCampaign();
    startTownVisit(s, "ch1");
    s.opinionCards.push({ characterId: "samantha", characterName: "Samantha", level: "detractor" });
    s.bossParts["hero-01"] = 0;
    OpinionPenaltyModule.resolveSamanthaDetractor(s, "hero-01");
    expect(s.bossParts["hero-01"]).toBe(0);
    expect(s.opinionCardsSpent).not.toContain("samantha-detractor");
  });

  it("survives finishTownVisit (the spent flag is sticky like the Ally one-shots)", () => {
    const s = newCampaign();
    startTownVisit(s, "ch1");
    s.opinionCards.push({ characterId: "samantha", characterName: "Samantha", level: "detractor" });
    s.bossParts["hero-01"] = 1;
    OpinionPenaltyModule.resolveSamanthaDetractor(s, "hero-01");
    finishTownVisit(s);
    expect(s.opinionCardsSpent).toContain("samantha-detractor");
  });
});

describe("purchaseShopProduct — Samantha Detractor gate", () => {
  it("rejects Machinist purchases with `samantha-detractor-blocked` while the card is unresolved", () => {
    const s = newCampaign();
    startTownVisit(s, "ch1");
    s.opinionCards.push({ characterId: "samantha", characterName: "Samantha", level: "detractor" });
    // Make #41 (Shock Gauntlet, Machinist) available + give the
    // delver enough parts to actually afford the cost — proves the
    // rejection isn't an insufficient-funds masquerade.
    s.shopProductsAvailable = [41];
    s.minionParts["hero-01"] = 50;
    s.bossParts["hero-01"] = 5;
    const err = purchaseShopProduct(s, "hero-01", 41);
    expect(err).toEqual({ code: "samantha-detractor-blocked" });
    // No state mutation on rejection.
    expect(s.minionParts["hero-01"]).toBe(50);
    expect(s.bossParts["hero-01"]).toBe(5);
    expect(s.shopProductsAvailable).toContain(41);
  });

  it("allows non-Machinist purchases through unchanged (Equipment Market #1)", () => {
    const s = newCampaign();
    startTownVisit(s, "ch1");
    s.opinionCards.push({ characterId: "samantha", characterName: "Samantha", level: "detractor" });
    s.shopProductsAvailable = [1];
    s.minionParts["hero-01"] = 50;
    const err = purchaseShopProduct(s, "hero-01", 1);
    expect(err).toBeNull();
    expect(s.shopProductsOwned["hero-01"]).toContain(1);
  });

  it("permits Machinist purchases the moment the card is resolved", () => {
    const s = newCampaign();
    startTownVisit(s, "ch1");
    s.opinionCards.push({ characterId: "samantha", characterName: "Samantha", level: "detractor" });
    s.shopProductsAvailable = [41];
    s.minionParts["hero-01"] = 50;
    s.bossParts["hero-01"] = 5;
    expect(purchaseShopProduct(s, "hero-01", 41))
      .toEqual({ code: "samantha-detractor-blocked" });
    expect(OpinionPenaltyModule.resolveSamanthaDetractor(s, "hero-01")).toBeNull();
    // Wallet drops by 1 (paying Samantha) — leaves 4 for the buy.
    expect(s.bossParts["hero-01"]).toBe(4);
    const err = purchaseShopProduct(s, "hero-01", 41);
    expect(err).toBeNull();
    expect(s.shopProductsOwned["hero-01"]).toContain(41);
  });
});
