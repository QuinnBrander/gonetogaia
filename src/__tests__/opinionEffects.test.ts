/**
 * Ongoing Opinion Card rules (Nov 15 printed cards) — `engine/opinionEffects.ts`
 * plus the redemption / card-update hooks that use it.
 */

import { describe, it, expect } from "vitest";

import { migrateV61ToV62, newCampaign, type CampaignState } from "../state";
import { QUEST3 } from "../data";
import type { OpinionLevel } from "../data";
import { ensureEncounter } from "../engine/encounter";
import {
  effectiveShopProductCost,
  purchaseShopProduct,
  redeemEliasCard,
  redeemIraAlly,
  runTownVisitAction,
  shopPurchaseError,
  startTownVisit,
  finishTownVisit,
} from "../engine/townVisit";
import { applyEndWaveOpinionPenalties } from "../engine/opinionEffects";
import { redeemElaynaAlly } from "../engine/opinionRedeem";
import { resolveAcademyDonation } from "../engine/academyDonation";

function hold(s: CampaignState, characterId: string, level: OpinionLevel): void {
  s.opinionCards.push({ characterId, characterName: characterId, level });
}

/** Shop product #1 (Trident, Equipment Market, 7 minion). */
const TRIDENT = 1;
/** Shop product #4 (Reroll x2, General Store, 5 minion). */
const REROLLS = 4;
/** Shop product #34 (Cyclone Boots, Machinist, 1 Lvl 2 boss part). */
const CYCLONE = 34;

describe("shop prices", () => {
  it("Ira Confidant -1, Detractor +1, Nemesis +2 on every product", () => {
    for (const [level, price] of [["confidant", 4], ["detractor", 6], ["nemesis", 7]] as const) {
      const s = newCampaign();
      hold(s, "ira", level);
      expect(effectiveShopProductCost(s, REROLLS).minionParts).toBe(price);
    }
  });

  it("Flores Detractor / Nemesis only touch the Equipment Market", () => {
    const s = newCampaign();
    hold(s, "flores", "nemesis");
    expect(effectiveShopProductCost(s, TRIDENT).minionParts).toBe(9);
    expect(effectiveShopProductCost(s, REROLLS).minionParts).toBe(5);
  });

  it("Ira Ally gives -1 for the rest of the visit, then resets", () => {
    const s = newCampaign();
    hold(s, "ira", "ally");
    startTownVisit(s, "ch1");
    expect(redeemIraAlly(s)).toBeNull();
    expect(effectiveShopProductCost(s, REROLLS).minionParts).toBe(4);
    expect(s.opinionCardsSpent).toContain("ira-ally");
    finishTownVisit(s);
    expect(s.iraDiscountActive).toBe(false);
  });

  it("Samantha Nemesis blocks every Machinist product", () => {
    const s = newCampaign();
    hold(s, "samantha", "nemesis");
    s.shopProductsAvailable.push(CYCLONE);
    s.bossPartsLvl2["hero-01"] = 5;
    expect(shopPurchaseError(s, "hero-01", CYCLONE)).toEqual({ code: "samantha-nemesis-blocked" });
  });

  it("Flores Confidant pays missing boss parts with 3 minion parts per level", () => {
    const s = newCampaign();
    s.shopProductsAvailable.push(CYCLONE);
    s.minionParts["hero-01"] = 6;
    expect(shopPurchaseError(s, "hero-01", CYCLONE)).toEqual({ code: "insufficient-boss-lvl-2" });
    hold(s, "flores", "confidant");
    expect(shopPurchaseError(s, "hero-01", CYCLONE)).toBeNull();
    startTownVisit(s, "ch1");
    expect(purchaseShopProduct(s, "hero-01", CYCLONE)).toBeNull();
    expect(s.minionParts["hero-01"]).toBe(0);
    expect(s.bossPartsLvl2["hero-01"]).toBe(0);
  });
});

describe("Interlude penalties", () => {
  it("Elayna Detractor: each delver loses 2 elements from their largest stacks", () => {
    const s = newCampaign();
    hold(s, "elayne", "detractor");
    s.elements["hero-01"] = { fire: 2, water: 1 };
    s.elements["hero-02"] = { earth: 1 };
    const lines = applyEndWaveOpinionPenalties(s);
    expect(s.elements["hero-01"]).toEqual({ fire: 0, water: 1 });
    expect(s.elements["hero-02"]).toEqual({ earth: 0 });
    expect(lines).toHaveLength(2);
  });

  it("Elayna Nemesis: all elements; Rodrigo Detractor: 2 XP; Nemesis: all XP", () => {
    const s = newCampaign();
    hold(s, "elayne", "nemesis");
    hold(s, "rodrigo", "detractor");
    s.elements["hero-01"] = { fire: 2, water: 2 };
    s.xpOnHand = 5;
    applyEndWaveOpinionPenalties(s);
    expect(Object.values(s.elements["hero-01"]!).every((n) => n === 0)).toBe(true);
    expect(s.xpOnHand).toBe(3);
    const t = newCampaign();
    hold(t, "rodrigo", "nemesis");
    t.xpOnHand = 5;
    applyEndWaveOpinionPenalties(t);
    expect(t.xpOnHand).toBe(0);
  });
});

describe("Elias — Memory Chips", () => {
  it("Nemesis blocks every new Memory Chip", () => {
    const s = newCampaign();
    hold(s, "elias", "nemesis");
    const before = s.memoryChips;
    expect(runTownVisitAction(s, { kind: "grant-memory-chip", amount: 2 })).toEqual([]);
    expect(s.memoryChips).toBe(before);
  });

  it("Detractor: lose 1 chip the moment it's taken, then it's discarded", () => {
    const s = newCampaign();
    s.memoryChips = 2;
    s.favour["elias"] = { name: "Elias", value: 0 };
    runTownVisitAction(s, { kind: "shift-favour", characterId: "elias", characterName: "Elias", delta: -1 });
    expect(s.memoryChips).toBe(1);
    expect(s.opinionCardsSpent).toContain("elias-detractor");
  });

  it("Ally: spend 3 minion parts for 1 chip, once", () => {
    const s = newCampaign();
    hold(s, "elias", "ally");
    startTownVisit(s, "ch1");
    s.minionParts["hero-02"] = 4;
    const chips = s.memoryChips;
    expect(redeemEliasCard(s, "hero-02", "ally")).toBeNull();
    expect(s.minionParts["hero-02"]).toBe(1);
    expect(s.memoryChips).toBe(chips + 1);
    expect(redeemEliasCard(s, "hero-02", "ally")).toEqual({ code: "already-spent" });
  });
});

describe("quest start", () => {
  it("Dahlia Confidant: both delvers +1 Universal 2x Damage and +1 Block Counterattack", () => {
    const s = newCampaign();
    hold(s, "dahlia", "confidant");
    s.currentQuestId = "quest3";
    ensureEncounter(s, QUEST3);
    for (const h of ["hero-01", "hero-02"]) {
      expect(s.consumableTokens[h]!["damage-2x-universal"]?.available).toBe(1);
      expect(s.consumableTokens[h]!["prevent-counterattack"]?.available).toBe(1);
    }
  });

  it("Dahlia Ally: each delver gets their chosen token (Reroll when first gained)", () => {
    const s = newCampaign();
    s.favour["dahlia"] = { name: "Dahlia", value: 0 };
    runTownVisitAction(s, { kind: "shift-favour", characterId: "dahlia", characterName: "Dahlia", delta: 1 });
    expect(s.dahliaTokenChoice).toEqual({ "hero-01": "reroll", "hero-02": "reroll" });
    s.dahliaTokenChoice["hero-02"] = "damage-2x-universal";
    s.currentQuestId = "quest3";
    ensureEncounter(s, QUEST3);
    expect(s.consumableTokens["hero-01"]!.reroll?.available).toBe(1);
    expect(s.consumableTokens["hero-02"]!["damage-2x-universal"]?.available).toBe(1);
  });

  it("Xavier Nemesis: each delver starts the quest one equipment rank down", () => {
    const s = newCampaign();
    hold(s, "xavier", "nemesis");
    s.currentQuestId = "quest3";
    ensureEncounter(s, QUEST3);
    const picks = s.encounter!.pendingOpinionRankPicks.filter((p) => p.source === "xavier-nemesis");
    expect(picks.map((p) => [p.heroId, p.delta])).toEqual([["hero-01", -1], ["hero-02", -1]]);
  });
});

describe("Arlen", () => {
  it("Detractor caps Ally/Confidant cards at 2; the third isn't taken", () => {
    const s = newCampaign();
    hold(s, "arlen", "detractor");
    hold(s, "xavier", "ally");
    hold(s, "flores", "ally");
    s.favour["ira"] = { name: "Dr Ira", value: 0 };
    const events = runTownVisitAction(s, { kind: "shift-favour", characterId: "ira", characterName: "Dr Ira", delta: 1 });
    expect(s.favour["ira"]!.value).toBe(1);
    expect(s.opinionCards.some((c) => c.characterId === "ira")).toBe(false);
    expect(events.some((e) => e.kind === "opinion-card-blocked")).toBe(true);
  });

  it("Confidant: a donation resolves at its best tier whatever was donated", () => {
    const s = newCampaign();
    hold(s, "arlen", "confidant");
    const ev = resolveAcademyDonation(s, "ch2");
    expect(ev).toMatchObject({ kind: "academy-donation-resolved", tier: "large" });
  });

  it("Ally: the next donation resolves at its best tier, then the card is spent", () => {
    const s = newCampaign();
    hold(s, "arlen", "ally");
    expect(resolveAcademyDonation(s, "ch2")).toMatchObject({ tier: "large" });
    expect(s.opinionCardsSpent).toContain("arlen-ally");
  });
});

describe("Confidant one-shots match their Ally cards", () => {
  it("Elayna Confidant is a Med Kit", () => {
    const s = newCampaign();
    hold(s, "elayne", "confidant");
    s.loadouts["hero-01"]!.currentHp = 1;
    expect(redeemElaynaAlly(s)).toBeNull();
    expect(s.loadouts["hero-01"]!.currentHp).toBe(s.loadouts["hero-01"]!.maxHp);
    expect(s.opinionCardsSpent).toContain("elayne-confidant");
  });

  it("Samantha Confidant shields the next opinion loss", () => {
    const s = newCampaign();
    hold(s, "samantha", "confidant");
    s.favour["xavier"] = { name: "Xavier", value: 1 };
    runTownVisitAction(s, { kind: "shift-favour", characterId: "xavier", characterName: "Xavier", delta: -1 });
    expect(s.favour["xavier"]!.value).toBe(1);
    expect(s.opinionCardsSpent).toContain("samantha-confidant");
  });
});

describe("v61 -> v62", () => {
  it("keeps only the card matching each character's current opinion", () => {
    const save = {
      version: 61,
      loadouts: { "hero-01": {}, "hero-02": {} },
      favour: { xavier: { value: 2 }, samantha: { value: 0 } },
      opinionCards: [
        { characterId: "xavier", characterName: "Xavier", level: "ally" },
        { characterId: "xavier", characterName: "Xavier", level: "confidant" },
        { characterId: "samantha", characterName: "Samantha", level: "detractor" },
      ],
    };
    const out = migrateV61ToV62(save) as unknown as CampaignState;
    expect(out.version).toBe(62);
    expect(out.opinionCards).toEqual([{ characterId: "xavier", characterName: "Xavier", level: "confidant" }]);
    expect(out.iraDiscountActive).toBe(false);
  });
});
