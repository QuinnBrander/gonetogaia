/**
 * Chapter 3 playtest fixes (2026-11-17).
 */
import { describe, it, expect } from "vitest";
import { newCampaign } from "../state";
import { QUEST1 } from "../data";
import { ensureEncounter } from "../engine/encounter";
import { playWeaponCard, startHeroTurn, useWeaponAbility } from "../engine/turn";
import { enterEndOfWave } from "../engine/wave";

function swordArena(rank: number) {
  const s = newCampaign();
  ensureEncounter(s, QUEST1, (p) => [...p]);
  s.encounter!.enemies = [{ instanceId: "e", cardId: "squiddy-088", x: 0, y: 0, damageTaken: 0, alive: true, facing: 0 }];
  s.encounter!.delverPositions["hero-01"] = { x: 1, y: 1 };
  s.encounter!.delverPositions["hero-02"] = { x: 2, y: 0 };
  s.equipmentRanks["hero-01"]!["Sword"] = rank;
  startHeroTurn(s);
  return s;
}

function swing(s: ReturnType<typeof swordArena>): number {
  expect(playWeaponCard(s, "hero-01", 0, "mind-sword-r1").ok).toBe(true);
  const r = useWeaponAbility(s, "hero-01", 0, { kind: "single-adjacent", targetX: 0, targetY: 0 });
  if (!r.ok) throw new Error(r.reason);
  return r.session.damage;
}

describe("Flicker Blade adjacency bonus", () => {
  it("R3 with delvers adjacent deals 3x MEDIUM + 3x LIGHT", () => {
    expect(swing(swordArena(3))).toBe(9);
  });

  it("the bonus LIGHT damage includes the Shop LIGHT damage bonus", () => {
    const s = swordArena(3);
    s.shopDamageBonus["hero-01"] = { ...(s.shopDamageBonus["hero-01"] ?? {}), light: 1 };
    // 3 x MEDIUM (2) + 3 x LIGHT (1 + 1 Shop bonus) = 12
    expect(swing(s)).toBe(12);
  });
});

describe("End Wave summary is synced on the encounter", () => {
  it("enterEndOfWave stores the refresh summary on the encounter for online guests", () => {
    const s = newCampaign();
    ensureEncounter(s, QUEST1, (p) => [...p]);
    enterEndOfWave(s, "victory");
    expect(s.encounter!.endWaveRefresh).toMatchObject({
      weaponsRefreshed: expect.any(Array),
      consumableTokensRefreshed: 0,
      harvesterGrants: [],
    });
  });
});

import { QUEST2 } from "../data";
import { applyQuestCarryEffect } from "../engine/scenarioCard";
import { bootstrapWaveAtNumber } from "../engine/encounter";

describe("Quest #2 storybook continue choices", () => {
  it("Wave 1 offers 2 Sparkle choices + a Woo's Diary bonus; Wave 2 offers 2 Cold choices", () => {
    const w1 = QUEST2.waves[0]!.continueChoices!;
    const w2 = QUEST2.waves[1]!.continueChoices!;
    expect(w1).toHaveLength(3);
    expect(w1.filter((c) => c.requireKeyItem === 3)).toHaveLength(1);
    expect(w2).toHaveLength(2);
    expect(w2.some((c) => c.requireKeyItem !== undefined)).toBe(false);
    expect(QUEST2.waves[2]!.continueChoices).toBeUndefined();
    const negative = new Set(["reduce-max-hp-both", "lose-hp-both-floor-at-one", "lose-hp-one-delver-floor-at-one", "lose-all-elements-both"]);
    for (const c of [...w1, ...w2]) {
      expect(QUEST2.pages[c.pageId], c.pageId).toBeDefined();
      expect(c.then).toBe("next-wave");
      // Results are visible before choosing, so no option may be a pure loss.
      expect((c.carryEffects ?? []).some((e) => negative.has(e.kind)), c.label).toBe(false);
    }
  });

  it("the Woo's Diary bonus heals both delvers to full and queues 4 element picks each", () => {
    const s = newCampaign();
    bootstrapWaveAtNumber(s, QUEST2, 2);
    for (const lo of Object.values(s.loadouts)) lo.currentHp = 1;
    const bonus = QUEST2.waves[0]!.continueChoices!.find((c) => c.requireKeyItem === 3)!;
    for (const e of bonus.carryEffects!) applyQuestCarryEffect(s, e);
    for (const lo of Object.values(s.loadouts)) expect(lo.currentHp).toBe(lo.maxHp);
    expect(s.encounter!.pendingElementChoices).toHaveLength(4 * Object.keys(s.loadouts).length);
  });
});

import { QUEST3, QUEST4, QUEST5, QUEST6, QUEST7, QUEST13, getKeyItem } from "../data";

describe("Chapter 3-4 quests: no Scenario Deck, Key Item bonuses", () => {
  const QUESTS = [QUEST3, QUEST4, QUEST5, QUEST6, QUEST7, QUEST13];
  const negative = new Set(["reduce-max-hp-both", "lose-hp-both-floor-at-one", "lose-hp-one-delver-floor-at-one", "lose-all-elements-both"]);

  it("no wave draws a Scenario Card and no reward seeds the deck", () => {
    for (const q of [QUEST2, ...QUESTS]) {
      for (const w of q.waves) {
        expect(w.scenarioCardDraw, `${q.id} W${w.number}`).toBeFalsy();
        expect(w.scenarioCardOnStart, `${q.id} W${w.number}`).toBeUndefined();
        for (const c of w.eow?.victory ?? []) {
          expect((c.rewards ?? []).some((r) => r.kind === "place-scenario-card-on-top"), c.label).toBe(false);
        }
      }
    }
  });

  it("Key Item bonuses (one per quest, two in Quest #3) are positive next-wave options with a real page and Key Item", () => {
    const expected: Record<string, number> = { quest3: 2, quest4: 1, quest5: 1, quest6: 1, quest7: 1, quest13: 1 };
    for (const q of QUESTS) {
      const bonuses = q.waves.flatMap((w) => (w.eow?.victory ?? []).filter((c) => c.requireKeyItem !== undefined));
      expect(bonuses, q.id).toHaveLength(expected[q.id]!);
      for (const b of bonuses) {
        expect(() => getKeyItem(b.requireKeyItem!)).not.toThrow();
        expect(q.pages[b.pageId], b.pageId).toBeDefined();
        expect(b.then).toBe("next-wave");
        expect((b.carryEffects ?? []).some((e) => negative.has(e.kind)), b.label).toBe(false);
      }
    }
  });
});

import { runTownVisitAction } from "../engine/townVisit";

describe("Key Item bonuses grant unreachable Equipment Upgrades + a benefit", () => {
  const PRODUCT_BONUS: Record<string, number> = { quest3: 33, quest4: 32, quest5: 34, quest6: 44, quest7: 35, quest13: 41 };

  it("each quest's product bonus adds its Equipment Upgrade (chip fallback) and also grants a benefit", () => {
    for (const q of [QUEST3, QUEST4, QUEST5, QUEST6, QUEST7, QUEST13]) {
      const bonuses = q.waves.flatMap((w) => (w.eow?.victory ?? []).filter((c) => c.requireKeyItem !== undefined));
      const withProduct = bonuses.filter((b) => (b.rewards ?? []).some((r) => r.kind === "add-shop-products"));
      expect(withProduct, q.id).toHaveLength(1);
      const b = withProduct[0]!;
      expect(b.rewards).toContainEqual({ kind: "add-shop-products", products: [PRODUCT_BONUS[q.id]!], chipFallback: 1 });
      expect((b.carryEffects ?? []).length, b.label).toBeGreaterThan(0);
      expect(b.label).toContain(`#${PRODUCT_BONUS[q.id]}`);
    }
  });

  it("add-shop-products with chipFallback grants a Memory Chip when the product is already available or owned", () => {
    const s = newCampaign();
    const action = { kind: "add-shop-products" as const, products: [33], chipFallback: 1 };
    runTownVisitAction(s, action);
    expect(s.shopProductsAvailable).toContain(33);
    expect(s.memoryChips).toBe(0);
    runTownVisitAction(s, action);
    expect(s.memoryChips).toBe(1);
  });
});

import { CHAPTER4 } from "../data";

describe("Chapter 5 needs Quest #03 completed (Dahlia must have been rescued)", () => {
  const P = CHAPTER4.pages;

  it("Chapter 4 opens by granting Quest #03 (Memory Chip if already owned or completed)", () => {
    expect(P["ch4-story-so-far"]!.onEnter).toContainEqual(
      { kind: "reveal-quest-or-grant-chip", number: 3, name: "Xavier's Request", chipFallback: 1 });
  });

  it("the only way into ch4-end is the 'Continue to Chapter 5' choice gated on quest.3.completed", () => {
    for (const [id, page] of Object.entries(P)) {
      if (id === "ch4-before-chapter-5") continue;
      expect(page.next, id).not.toBe("ch4-end");
      expect((page.choices ?? []).some((c) => c.next === "ch4-end"), id).toBe(false);
    }
    const gate = P["ch4-before-chapter-5"]!;
    const cont = gate.choices!.find((c) => c.next === "ch4-end")!;
    expect(cont.requireDecision).toBe("quest.3.completed");
    const play = gate.choices!.find((c) => c.next === "ch4-q3-required")!;
    expect(play.hideIfDecisionMade).toBe("quest.3.completed");
    expect(P["ch4-q3-required"]!.startQuest).toBe("quest3");
    expect(P["ch4-q3-required"]!.next).toBe("ch4-before-chapter-5");
  });
});

describe("Chapter 3-4 Scenario Cards folded into the continue choices", () => {
  const QUESTS = [QUEST3, QUEST4, QUEST5, QUEST6, QUEST7, QUEST13];
  const negative = new Set(["reduce-max-hp-both", "lose-hp-both-floor-at-one", "lose-hp-one-delver-floor-at-one", "lose-all-elements-both"]);

  it("every wave that leads on to another wave offers 2-3 continue choices (plus any Key Item bonus)", () => {
    for (const q of QUESTS) {
      for (const w of q.waves) {
        const cont = (w.eow?.victory ?? []).filter((c) => c.then === "next-wave");
        if (cont.length === 0) continue;
        const plain = cont.filter((c) => c.requireKeyItem === undefined);
        expect(plain.length, `${q.id} W${w.number}`).toBeGreaterThanOrEqual(2);
        expect(plain.length, `${q.id} W${w.number}`).toBeLessThanOrEqual(3);
        for (const c of cont) {
          expect(q.pages[c.pageId], c.pageId).toBeDefined();
          expect(c.label.startsWith("A - Continue: "), c.label).toBe(true);
          expect((c.carryEffects ?? []).some((e) => negative.has(e.kind)), c.label).toBe(false);
        }
      }
    }
  });
});
