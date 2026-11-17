/**
 * Tests for the Chapter 3 Town Visit ("The Memorial Festival").
 *
 * Covers:
 *   - `data/chapter3.json` integrity: every `next` / choice / die-roll
 *     target exists, and every referenced shop product, key item,
 *     quest, scenario card and hero card is in its catalog.
 *   - New Town Visit actions: `if`, `complete-quest`, `grant-boss-parts`,
 *     `discard-opinion-card`, `reveal-first-unowned-quest`,
 *     `grant-shop-product`, `place-scenario-card-on-top`,
 *     `grant-minion-parts-per-open-quest`.
 *   - Choice gates (`requireDecision`, `requireKeyItemAny`,
 *     `requireQuestRevealed`, `requireOpenQuests`) and die-roll pages.
 *   - Ch3 donation schedule (running total, OS + Supercharger tiers).
 *   - `finishTownVisit("ch3")` latch + v58 -> v59 migration.
 */

import { describe, it, expect } from "vitest";

import { migrateV58ToV59, newCampaign, type CampaignState } from "../state";
import {
  applyOnEnter,
  finishTownVisit,
  openQuestCount,
  resolveTownVisitDieRoll,
  runTownVisitAction,
  setTownVisitPage,
  startTownVisit,
  townVisitChoiceGated,
} from "../engine/townVisit";
import { donateToAcademy, donationTierForTotal, resolveAcademyDonation } from "../engine/academyDonation";
import {
  CHAPTER3,
  getChapter,
  getHeroCard,
  getKeyItem,
  getQuest,
  getScenarioCard,
  getShopProduct,
  HERO_CARD_LOADOUTS,
} from "../data";
import type { TownVisitAction } from "../types";

function fresh(): CampaignState {
  return newCampaign();
}

function allActions(actions: TownVisitAction[] | undefined): TownVisitAction[] {
  const out: TownVisitAction[] = [];
  for (const a of actions ?? []) {
    out.push(a);
    if (a.kind === "if") out.push(...allActions(a.then), ...allActions(a.otherwise));
  }
  return out;
}

describe("chapter3 — data integrity", () => {
  it("getChapter('ch3') returns CHAPTER3 and the start page exists", () => {
    expect(getChapter("ch3")).toBe(CHAPTER3);
    expect(CHAPTER3.pages[CHAPTER3.startPageId]).toBeDefined();
  });

  it("every next / choice / die-roll target is a real page", () => {
    for (const [id, page] of Object.entries(CHAPTER3.pages)) {
      if (page.next) expect(CHAPTER3.pages[page.next], `${id} -> ${page.next}`).toBeDefined();
      for (const c of page.choices ?? []) expect(CHAPTER3.pages[c.next], `${id} -> ${c.next}`).toBeDefined();
      for (const o of page.dieRoll ?? []) expect(CHAPTER3.pages[o.next], `${id} -> ${o.next}`).toBeDefined();
    }
  });

  it("every page has exactly one way forward (or ends the visit)", () => {
    for (const [id, page] of Object.entries(CHAPTER3.pages)) {
      const ways = [page.next, page.choices?.length, page.dieRoll?.length, page.kind === "end-town-visit"]
        .filter(Boolean).length;
      expect(ways, id).toBe(1);
    }
  });

  it("die-roll brackets cover 1-6 exactly once", () => {
    for (const [id, page] of Object.entries(CHAPTER3.pages)) {
      if (!page.dieRoll) continue;
      for (let roll = 1; roll <= 6; roll++) {
        const hits = page.dieRoll.filter((o) => roll >= o.min && roll <= o.max);
        expect(hits.length, `${id} roll ${roll}`).toBe(1);
      }
    }
  });

  it("every referenced catalog entry exists", () => {
    for (const page of Object.values(CHAPTER3.pages)) {
      for (const a of allActions(page.onEnter)) {
        switch (a.kind) {
          case "add-shop-products":
          case "add-shop-products-if-key-items-min":
            for (const n of a.products) expect(() => getShopProduct(n)).not.toThrow();
            break;
          case "grant-shop-product": expect(() => getShopProduct(a.product)).not.toThrow(); break;
          case "gain-key-item": expect(() => getKeyItem(a.number)).not.toThrow(); break;
          case "reveal-quest":
          case "reveal-quest-or-grant-chip":
          case "complete-quest":
            expect(() => getQuest(a.number)).not.toThrow(); break;
          case "reveal-first-unowned-quest":
            for (const q of a.quests) expect(() => getQuest(q.number)).not.toThrow();
            break;
          case "place-scenario-card-on-top": expect(() => getScenarioCard(a.cardNumber)).not.toThrow(); break;
          case "unlock-hero-cards":
            for (const n of a.cardNumbers) {
              expect(() => getHeroCard(n)).not.toThrow();
              expect(HERO_CARD_LOADOUTS[n], `loadout #${n}`).toBeDefined();
            }
            break;
          default: break;
        }
      }
    }
  });
});

describe("chapter3 — new actions", () => {
  it("complete-quest stamps completion, reveals, and is idempotent", () => {
    const s = fresh();
    const ev = runTownVisitAction(s, { kind: "complete-quest", number: 5, name: "The Rogue Delver" });
    expect(ev).toEqual([{ kind: "quest-completed", number: 5, name: "The Rogue Delver" }]);
    expect(s.completedQuests).toEqual([5]);
    expect(s.revealedQuests.some((q) => q.number === 5)).toBe(true);
    expect(s.townDecisions).toContain("quest.5.completed");
    expect(runTownVisitAction(s, { kind: "complete-quest", number: 5, name: "The Rogue Delver" })).toEqual([]);
  });

  it("open quests = revealed minus completed", () => {
    const s = fresh();
    s.revealedQuests.push({ number: 3, name: "x" }, { number: 5, name: "y" });
    s.completedQuests.push(5);
    expect(openQuestCount(s)).toBe(1);
  });

  it("grant-boss-parts credits the matching level wallet", () => {
    const s = fresh();
    runTownVisitAction(s, { kind: "grant-boss-parts", level: 2, amount: 1, to: "all-delvers" });
    expect(s.bossPartsLvl2["hero-01"]).toBe(1);
    expect(s.bossPartsLvl2["hero-02"]).toBe(1);
    expect(s.bossParts["hero-01"]).toBe(0);
  });

  it("if runs then/otherwise branches", () => {
    const s = fresh();
    const action: TownVisitAction = {
      kind: "if", cond: { kind: "quest-completed", number: 5 },
      then: [{ kind: "grant-memory-chip", amount: 3 }],
      otherwise: [{ kind: "grant-memory-chip", amount: 1 }],
    };
    runTownVisitAction(s, action);
    expect(s.memoryChips).toBe(1);
    s.completedQuests.push(5);
    runTownVisitAction(s, action);
    expect(s.memoryChips).toBe(4);
  });

  it("Vera's Ally card is discarded only when owned", () => {
    const s = fresh();
    expect(runTownVisitAction(s, { kind: "discard-opinion-card", characterId: "vera", level: "ally" })).toEqual([]);
    s.opinionCards.push({ characterId: "vera", characterName: "Vera Brass", level: "ally" });
    const ev = runTownVisitAction(s, { kind: "discard-opinion-card", characterId: "vera", level: "ally" });
    expect(ev[0]?.kind).toBe("opinion-card-discarded");
    expect(s.opinionCards).toHaveLength(0);
  });

  it("an already-redeemed Vera Ally card isn't reported as discarded twice", () => {
    const s = fresh();
    s.opinionCards.push({ characterId: "vera", characterName: "Vera Brass", level: "ally" });
    s.opinionCardsSpent.push("vera-ally");
    const ev = runTownVisitAction(s, { kind: "discard-opinion-card", characterId: "vera", level: "ally" });
    expect(ev).toEqual([]);
    expect(s.opinionCards).toHaveLength(0);
    expect(s.opinionCardsSpent).not.toContain("vera-ally");
  });

  it("reveal-first-unowned-quest walks the chain then falls back to a chip", () => {
    const s = fresh();
    const chain: TownVisitAction = {
      kind: "reveal-first-unowned-quest", chipFallback: 1,
      quests: [{ number: 3, name: "a" }, { number: 13, name: "b" }],
    };
    runTownVisitAction(s, chain);
    runTownVisitAction(s, chain);
    expect(s.revealedQuests.map((q) => q.number)).toEqual([3, 13]);
    runTownVisitAction(s, chain);
    expect(s.memoryChips).toBe(1);
  });

  it("grant-shop-product gives the product to the active delver and removes it from the shop", () => {
    const s = fresh();
    s.shopProductsAvailable.push(39);
    runTownVisitAction(s, { kind: "grant-shop-product", product: 39, to: "active-delver" });
    expect(s.shopProductsOwned[s.currentDelverId]).toContain(39);
    expect(s.shopProductsAvailable).not.toContain(39);
  });

  it("place-scenario-card-on-top puts the card first without duplicates", () => {
    const s = fresh();
    runTownVisitAction(s, { kind: "place-scenario-card-on-top", cardNumber: 100 });
    runTownVisitAction(s, { kind: "place-scenario-card-on-top", cardNumber: 103 });
    runTownVisitAction(s, { kind: "place-scenario-card-on-top", cardNumber: 100 });
    expect(s.scenarioDeckTop).toEqual([100, 103]);
  });

  it("grant-minion-parts-per-open-quest pays per open quest", () => {
    const s = fresh();
    s.revealedQuests.push({ number: 3, name: "a" }, { number: 6, name: "b" });
    runTownVisitAction(s, { kind: "grant-minion-parts-per-open-quest", perQuest: 1, to: "all-delvers" });
    expect(s.minionParts["hero-01"]).toBe(2);
  });
});

describe("chapter3 — gates and dice", () => {
  it("choice gates read decisions, key items, revealed and open quests", () => {
    const s = fresh();
    expect(townVisitChoiceGated(s, { requireDecision: "quest.3.completed" })).toBe(true);
    s.townDecisions.push("quest.3.completed");
    expect(townVisitChoiceGated(s, { requireDecision: "quest.3.completed" })).toBe(false);
    expect(townVisitChoiceGated(s, { requireKeyItemAny: [4, 8] })).toBe(true);
    s.keyItems.push({ number: 8, name: "Melted Vial", clues: 1 });
    expect(townVisitChoiceGated(s, { requireKeyItemAny: [4, 8] })).toBe(false);
    expect(townVisitChoiceGated(s, { requireQuestRevealed: 6 })).toBe(true);
    expect(townVisitChoiceGated(s, { requireOpenQuests: "zero" })).toBe(false);
    s.revealedQuests.push({ number: 6, name: "v" });
    expect(townVisitChoiceGated(s, { requireQuestRevealed: 6 })).toBe(false);
    expect(townVisitChoiceGated(s, { requireOpenQuests: "zero" })).toBe(true);
  });

  it("a die roll moves to the matching bracket's page", () => {
    const s = fresh();
    startTownVisit(s, "ch3");
    setTownVisitPage(s, "ch3-f1-b");
    resolveTownVisitDieRoll(s, 1);
    expect(s.townVisit?.pageId).toBe("ch3-f1-b-fail");
    setTownVisitPage(s, "ch3-f1-b");
    resolveTownVisitDieRoll(s, 4);
    expect(s.townVisit?.pageId).toBe("ch3-f1-b-success");
  });

  it("Machinist gives the product free at Ally favour, otherwise stocks it", () => {
    const s = fresh();
    startTownVisit(s, "ch3");
    setTownVisitPage(s, "ch3-machinist-a");
    applyOnEnter(s);
    expect(s.shopProductsAvailable).toContain(39);

    const ally = fresh();
    ally.favour.samantha = { name: "Samantha", value: 1 };
    startTownVisit(ally, "ch3");
    setTownVisitPage(ally, "ch3-machinist-a");
    applyOnEnter(ally);
    expect(ally.shopProductsOwned[ally.currentDelverId]).toContain(39);
  });
});

describe("chapter3 — donations, finish, migration", () => {
  it("Ch3 tiers read the running total (6 / 13 / 22)", () => {
    expect(donationTierForTotal(5, "ch3")).toBe("none");
    expect(donationTierForTotal(6, "ch3")).toBe("small");
    expect(donationTierForTotal(13, "ch3")).toBe("medium");
    expect(donationTierForTotal(22, "ch3")).toBe("large");
  });

  it("donations accumulate a lifetime total and the Ch3 small tier pins OS + Supercharger", () => {
    const s = fresh();
    startTownVisit(s, "ch3");
    s.minionParts["hero-01"] = 10;
    expect(donateToAcademy(s, "hero-01", 7)).toBeNull();
    expect(s.academyDonationLifetime).toBe(7);
    const ev = resolveAcademyDonation(s, "ch3");
    expect(ev.kind === "academy-donation-resolved" && ev.tier).toBe("small");
    expect(s.pendingAcademyDonationResolution?.rewards.map((r) => r.pinnedType)).toEqual(["OS", "Supercharger"]);
  });

  it("finishTownVisit flips the Ch3 latch and clears story tokens", () => {
    const s = fresh();
    startTownVisit(s, "ch3");
    s.storyTokens = 2;
    finishTownVisit(s);
    expect(s.townVisit3Completed).toBe(true);
    expect(s.storyTokens).toBe(0);
  });

  it("v58 -> v59 seeds the new fields", () => {
    const s = fresh() as unknown as Record<string, unknown>;
    delete s.townVisit3Completed;
    delete s.completedQuests;
    delete s.scenarioDeckTop;
    delete s.academyDonationLifetime;
    s.version = 58;
    s.academyDonation = { "hero-01": 4, "hero-02": 1 };
    const out = migrateV58ToV59(s)!;
    expect(out.version).toBe(59);
    expect(out.townVisit3Completed).toBe(false);
    expect(out.completedQuests).toEqual([]);
    expect(out.scenarioDeckTop).toEqual([]);
    expect(out.academyDonationLifetime).toBe(5);
  });
});
