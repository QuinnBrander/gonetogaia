/**
 * Quest #06 "The Forgotten Vault" (Chapter 3) — data + engine wiring.
 *
 * Covers:
 *   - quest6.json integrity: enemies exist, every End-of-Wave page and
 *     "next-wave" target exists, and the quest is reachable from Ch3.
 *   - New enemy abilities: Strength (counter damage grows) and Stout
 *     (max 8 damage per attack).
 *   - Scenario deck draws (story-placed cards first, then printed order).
 *   - Wave 1 bootstraps a real encounter with Joyce + Venena.
 */

import { describe, it, expect } from "vitest";

import { newCampaign, type CampaignState } from "../state";
import { CHAPTER3, getEnemy, getQuestData, QUEST6 } from "../data";
import { bootstrapWaveAtNumber, drawScenarioCard, ensureEncounter } from "../engine/encounter";
import {
  enemyCounterDamage,
  resolveSharedCounter,
  stoutCappedDamage,
  type AttackSession,
} from "../engine/combat";

function fresh(): CampaignState {
  return newCampaign();
}

describe("quest6 — data integrity", () => {
  it("is registered and every enemy id exists", () => {
    expect(getQuestData("quest6")).toBe(QUEST6);
    for (const w of QUEST6.waves) {
      expect(() => getEnemy(w.bossEnemyId)).not.toThrow();
      for (const id of w.minionEnemyIds) expect(() => getEnemy(id)).not.toThrow();
    }
  });

  it("every End-of-Wave page exists and next-wave choices have a next wave", () => {
    for (const w of QUEST6.waves) {
      expect(w.eow, `wave ${w.number}`).toBeDefined();
      expect(QUEST6.pages[w.eow!.defeat.pageId]).toBeDefined();
      expect(QUEST6.pages[w.endOfWave.bothSurvive]).toBeDefined();
      for (const c of w.eow!.victory) {
        expect(QUEST6.pages[c.pageId], c.pageId).toBeDefined();
        if (c.then === "next-wave") {
          expect(QUEST6.waves.some((x) => x.number === w.number + 1)).toBe(true);
        }
      }
    }
  });

  it("the primary-goal wave completes Quest #6 and adds Shop Product #43", () => {
    const w2 = QUEST6.waves.find((w) => w.number === 2)!;
    const rewards = w2.eow!.victory.flatMap((c) => c.rewards ?? []);
    expect(rewards).toContainEqual({ kind: "complete-quest", number: 6, name: "The Forgotten Vault" });
    expect(rewards.some((r) => r.kind === "add-shop-products" && r.products.includes(43))).toBe(true);
  });

  it("Chapter 3's Quest Report launches it", () => {
    const launch = Object.values(CHAPTER3.pages).find((p) => p.startQuest === "quest6");
    expect(launch?.next).toBe("ch3-quest-report");
  });
});

describe("quest6 — Strength and Stout", () => {
  it("Stout caps a single attack at 8 damage", () => {
    const gerald = getEnemy("gerald-030");
    expect(stoutCappedDamage(gerald, 12)).toBe(8);
    expect(stoutCappedDamage(gerald, 5)).toBe(5);
    expect(stoutCappedDamage(getEnemy("joyce-029"), 12)).toBe(12);
  });

  it("Strength adds a token after each counterattack (not on a miss)", () => {
    const s = fresh();
    s.currentQuestId = "quest6";
    ensureEncounter(s, QUEST6, (pool) => [...pool]);
    const enc = s.encounter!;
    const joyce = enc.enemies.find((e) => e.cardId === "joyce-029")!;
    const card = getEnemy("joyce-029");
    expect(enemyCounterDamage(s, card, joyce.instanceId)).toBe(2);

    const session = (rolled: number): AttackSession => ({
      attackerId: "hero-01",
      source: { kind: "weapon", slotIdx: 0 },
      damage: 1,
      hitTiles: [],
      steps: [],
      sharedCounter: {
        damagedEnemies: [{ instanceId: joyce.instanceId, cardId: joyce.cardId, x: joyce.x, y: joyce.y, facing: joyce.facing }],
        anyCanLand: true, rolled: -1, outcome: "miss", hits: [], resolved: false,
      },
    } as unknown as AttackSession);

    resolveSharedCounter(s, session(1), 1);
    expect(joyce.strengthTokens ?? 0).toBe(0);
    resolveSharedCounter(s, session(3), 3);
    expect(joyce.strengthTokens).toBe(1);
    expect(enemyCounterDamage(s, card, joyce.instanceId)).toBe(3);
  });
});

describe("quest6 — scenario deck + bootstrap", () => {
  it("draws story-placed cards first, then the lowest unresolved printed card", () => {
    const s = fresh();
    s.scenarioDeckTop = [103];
    s.scenarioCardsResolved = [1, 2];
    expect(drawScenarioCard(s)).toBe(103);
    expect(s.scenarioDeckTop).toEqual([]);
    expect(drawScenarioCard(s)).toBe(3);
  });

  it("wave 2 starts without a Scenario Card (storybook choices replaced the deck draw)", () => {
    const s = fresh();
    s.currentQuestId = "quest6";
    ensureEncounter(s, QUEST6, (pool) => [...pool]);
    bootstrapWaveAtNumber(s, QUEST6, 2);
    expect(s.encounter?.waveNumber).toBe(2);
    expect(s.currentScenarioCard).toBeNull();
  });

  it("wave 1 spawns Joyce the Bear with Venena minions", () => {
    const s = fresh();
    s.currentQuestId = "quest6";
    ensureEncounter(s, QUEST6, (pool) => [...pool]);
    const ids = s.encounter!.enemies.map((e) => e.cardId);
    expect(ids).toContain("joyce-029");
    expect(ids.filter((id) => id.startsWith("venena-")).length).toBeGreaterThan(0);
  });
});
