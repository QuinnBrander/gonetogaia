/**
 * Chapter 3 late waves: Quest #3 Waves 4-5, Quest #6 Waves 3-5 (Wave 5 is
 * the shared Gaia wave, book page 206) and the enemy abilities they need.
 *
 * Covers:
 *   - quest3 / quest6 data integrity for the new waves.
 *   - Immunity, Guards, Tough, Countdown, Accurate (Phase A abilities).
 *   - Vicious, Alert, Critical, Frenzy (Quest #5 abilities, engine side).
 *   - Lvl 4 / Lvl 5 boss-part wallets + the v60 -> v61 migration.
 *   - The Gaia wave's "choose 2 of Shop Products #32-45" reward.
 */

import { describe, it, expect } from "vitest";

import { migrateV60ToV61, newCampaign, creditBossPartDrop, totalBossParts, type CampaignState, type EnemyInstance } from "../state";
import { getEnemy, getShopProduct, QUEST3, QUEST6, shopProductImageOrNull } from "../data";
import { bootstrapWaveAtNumber, ensureEncounter } from "../engine/encounter";
import { resolveAllDamage, resolveSharedCounter, type AttackSession } from "../engine/combat";
import { eligibleShopProductPicks, resolveShopProductPicks } from "../engine/townVisit";
import type { DamageType, Quest } from "../types";

function wave(quest: Quest, n: number): CampaignState {
  const s = newCampaign();
  s.currentQuestId = quest.id;
  ensureEncounter(s, quest, (pool) => [...pool]);
  if (n > 1) bootstrapWaveAtNumber(s, quest, n);
  return s;
}

/** Clear the board and place enemies (with their on-spawn tokens) + delvers. */
function arrange(
  s: CampaignState,
  enemies: Array<{ cardId: string; x: number; y: number }>,
  delvers: Record<string, { x: number; y: number }>,
): EnemyInstance[] {
  const enc = s.encounter!;
  enc.enemies = enemies.map((e, i) => {
    const inst: EnemyInstance = { instanceId: `t-${i}`, cardId: e.cardId, x: e.x, y: e.y, damageTaken: 0, alive: true, facing: 0 };
    for (const ab of getEnemy(e.cardId).abilities) {
      if (ab.kind === "guards") inst.guardTokens = ab.tokens;
      if (ab.kind === "vicious") inst.viciousToken = true;
    }
    return inst;
  });
  enc.delverPositions = delvers;
  enc.witnessPosition = null;
  enc.countdownTokens = 0;
  enc.accurateMarks = {};
  return enc.enemies;
}

function session(
  tiles: Array<{ x: number; y: number }>,
  damage: number,
  damageType: DamageType | null = null,
  attackerId = "hero-01",
): AttackSession {
  return {
    attackerId,
    source: { kind: "weapon", slotIdx: 0, cardId: "mind-hammer-r1" },
    damage,
    damageType,
    hitTiles: tiles,
    steps: [],
    sharedCounter: null,
    finalized: false,
    preEffects: [],
    postEffects: [],
    levelUpsApplied: 0,
  };
}

const FAR = { "hero-01": { x: 4, y: 4 }, "hero-02": { x: 4, y: 3 } };

describe("late Ch3 waves — data integrity", () => {
  it("Quest #3 runs Waves 1-5 and Quest #6 Waves 1-5, every page and enemy exists", () => {
    for (const q of [QUEST3, QUEST6]) {
      expect(q.waves.map((w) => w.number)).toEqual([1, 2, 3, 4, 5]);
      for (const w of q.waves) {
        expect(() => getEnemy(w.bossEnemyId)).not.toThrow();
        expect(w.minionEnemyIds).toHaveLength(7);
        for (const id of w.minionEnemyIds) expect(() => getEnemy(id)).not.toThrow();
        expect(q.pages[w.eow!.defeat.pageId]).toBeDefined();
        for (const c of w.eow!.victory) expect(q.pages[c.pageId]).toBeDefined();
        // Every wave but the last offers a way on; the last only ends the quest.
        const thens = w.eow!.victory.map((c) => c.then);
        expect(thens.includes("next-wave")).toBe(w.number < 5);
      }
    }
    expect(QUEST3.waves[3]!.bossEnemyId).toBe("golem-055");
    expect(QUEST6.waves[2]!.bossEnemyId).toBe("abomination-063");
    expect(QUEST6.waves[3]!.bossEnemyId).toBe("golem-055");
    expect(QUEST3.waves[4]!.bossEnemyId).toBe("timberfiend-071");
    expect(QUEST6.waves[4]!.bossEnemyId).toBe("timberfiend-071");
  });

  it("Quest #3 Wave 3's Key Item #12 bonus opens Quest #4; Quest #6 Wave 2 completes the quest either way", () => {
    const dahlia = QUEST3.waves[2]!.eow!.victory.find((c) => c.requireKeyItem === 12)!;
    expect(dahlia.rewards).toContainEqual({ kind: "reveal-quest-or-grant-chip", number: 4, name: "A Hand Outstretched", chipFallback: 1 });
    for (const c of QUEST6.waves[1]!.eow!.victory) {
      expect(c.rewards?.some((r) => r.kind === "complete-quest")).toBe(true);
    }
  });

  it("the Gaia reward offers Shop Products #32-45, all with data and art", () => {
    const pick = QUEST3.waves[4]!.eow!.victory[0]!.pickShopProducts!;
    expect(pick.count).toBe(2);
    expect(pick.from).toEqual([32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45]);
    for (const n of pick.from) {
      expect(() => getShopProduct(n)).not.toThrow();
      expect(shopProductImageOrNull(n)).not.toBeNull();
    }
  });
});

describe("Immunity", () => {
  it("a Light-immune Blackguard takes no light damage but full medium damage", () => {
    const s = wave(QUEST6, 3);
    const [bg] = arrange(s, [{ cardId: "blackguard-064", x: 2, y: 2 }], FAR);
    expect(getEnemy("blackguard-064").abilities).toContainEqual({ kind: "immunity", damageType: "light" });
    resolveAllDamage(s, session([{ x: 2, y: 2 }], 5, "light"));
    expect(bg!.damageTaken).toBe(0);
    resolveAllDamage(s, session([{ x: 2, y: 2 }], 5, "medium"));
    expect(bg!.damageTaken).toBe(5);
  });
});

describe("Guards", () => {
  it("each attack strips a token without damage; once they're gone it takes damage", () => {
    const s = wave(QUEST3, 4);
    const [golem] = arrange(s, [{ cardId: "golem-055", x: 2, y: 2 }], FAR);
    expect(golem!.guardTokens).toBe(2);
    resolveAllDamage(s, session([{ x: 2, y: 2 }], 9));
    resolveAllDamage(s, session([{ x: 2, y: 2 }], 9));
    expect(golem!.guardTokens).toBe(0);
    expect(golem!.damageTaken).toBe(0);
    resolveAllDamage(s, session([{ x: 2, y: 2 }], 9));
    expect(golem!.damageTaken).toBe(9);
  });

  it("spawned Orites start with their printed token", () => {
    const s = wave(QUEST3, 4);
    const orites = s.encounter!.enemies.filter((e) => e.cardId.startsWith("orite-"));
    expect(orites.length).toBe(7);
    expect(orites.every((e) => e.guardTokens === 1)).toBe(true);
  });
});

describe("Tough", () => {
  it("rounds attack damage down to the nearest 5", () => {
    const s = wave(QUEST3, 5);
    const [sap] = arrange(s, [{ cardId: "sapling-072", x: 2, y: 2 }], FAR);
    resolveAllDamage(s, session([{ x: 2, y: 2 }], 4));
    expect(sap!.damageTaken).toBe(0);
    resolveAllDamage(s, session([{ x: 2, y: 2 }], 12));
    expect(sap!.damageTaken).toBe(10);
  });
});

describe("Countdown", () => {
  it("the 4th attack resets the pile and every Countdown enemy joins the counter", () => {
    const s = wave(QUEST3, 5);
    arrange(s, [
      { cardId: "sapling-072", x: 0, y: 0 },
      { cardId: "sapling-073", x: 2, y: 2 },
      { cardId: "timberfiend-071", x: 4, y: 0 },
    ], FAR);
    for (let i = 0; i < 3; i++) {
      const phase = resolveAllDamage(s, session([{ x: 0, y: 0 }], 5));
      expect(phase.damagedEnemies.length).toBe(1);
    }
    expect(s.encounter!.countdownTokens).toBe(3);
    const phase = resolveAllDamage(s, session([{ x: 0, y: 0 }], 5));
    expect(s.encounter!.countdownTokens).toBe(0);
    // The attacked sapling counters normally AND again as a Countdown bonus.
    expect(phase.damagedEnemies.filter((d) => d.bonus).map((d) => d.instanceId).sort()).toEqual(["t-0", "t-1", "t-2"]);
    expect(phase.damagedEnemies.filter((d) => !d.bonus).map((d) => d.instanceId)).toEqual(["t-0"]);
  });
});

describe("Accurate", () => {
  it("marks the attacker; a marked attacker is always hit, even on a miss roll", () => {
    const s = wave(QUEST3, 4);
    const [golem] = arrange(s, [{ cardId: "golem-055", x: 0, y: 0 }], FAR);
    golem!.guardTokens = 0;
    const first = session([{ x: 0, y: 0 }], 1);
    resolveAllDamage(s, first);
    resolveSharedCounter(s, first, 1);
    expect(s.encounter!.accurateMarks["t-0"]).toBe("hero-01");

    const hp = s.loadouts["hero-01"]!.currentHp;
    const second = session([{ x: 0, y: 0 }], 1);
    const phase = resolveAllDamage(s, second);
    expect(phase.anyCanLand).toBe(true);
    resolveSharedCounter(s, second, 1);
    expect(s.loadouts["hero-01"]!.currentHp).toBe(hp - getEnemy("golem-055").attack);

    // The other delver attacking moves the token to them.
    const third = session([{ x: 0, y: 0 }], 1, null, "hero-02");
    resolveAllDamage(s, third);
    resolveSharedCounter(s, third, 1);
    expect(s.encounter!.accurateMarks["t-0"]).toBe("hero-02");
  });
});

describe("Quest #5 abilities (engine)", () => {
  it("Vicious caps damage at 1 until an adjacent delver is hurt", () => {
    const s = wave(QUEST3, 1);
    const card = getEnemy("bob-079");
    const off = card.counterCommon.find((o) => Math.max(Math.abs(o.dx), Math.abs(o.dy)) === 1)!;
    const [bob] = arrange(s, [{ cardId: "bob-079", x: 2, y: 2 }],
      { "hero-01": { x: 2 + off.dx, y: 2 + off.dy }, "hero-02": { x: 4, y: 4 } });
    expect(bob!.viciousToken).toBe(true);
    const a = session([{ x: 2, y: 2 }], 6);
    resolveAllDamage(s, a);
    expect(bob!.damageTaken).toBe(1);
    resolveSharedCounter(s, a, 3); // white arrows hit the adjacent attacker
    expect(bob!.viciousToken).toBe(false);
    resolveAllDamage(s, session([{ x: 2, y: 2 }], 6));
    expect(bob!.damageTaken).toBe(7);
  });

  it("Alert turns the card so its icon faces the attacker", () => {
    const s = wave(QUEST3, 1);
    const [slayer] = arrange(s, [{ cardId: "mindslayer-087", x: 2, y: 2 }],
      { "hero-01": { x: 4, y: 2 }, "hero-02": { x: 0, y: 0 } });
    const a = session([{ x: 2, y: 2 }], 1);
    resolveAllDamage(s, a);
    resolveSharedCounter(s, a, 1);
    expect(slayer!.facing).toBe(90); // attacker due east
  });

  it("Critical doubles white-arrow damage on a 5 only", () => {
    const card = getEnemy("oblivionwing-095");
    const off = card.counterCommon[0]!;
    for (const [roll, mult] of [[5, 2], [4, 1]] as const) {
      const s = wave(QUEST3, 1);
      arrange(s, [{ cardId: "oblivionwing-095", x: 2, y: 2 }],
        { "hero-01": { x: 2 + off.dx, y: 2 + off.dy }, "hero-02": { x: 4, y: 4 } });
      const a = session([{ x: 2, y: 2 }], 1);
      resolveAllDamage(s, a);
      const phase = resolveSharedCounter(s, a, roll);
      expect(phase.hits.filter((h) => h.heroId === "hero-01")).toEqual([{ heroId: "hero-01", damage: card.attack * mult }]);
    }
  });

  it("Frenzy: overkilling a Frenzy enemy makes every Frenzy enemy counter", () => {
    const s = wave(QUEST3, 1);
    arrange(s, [
      { cardId: "nightswiper-097", x: 0, y: 0 },
      { cardId: "nightswiper-098", x: 4, y: 0 },
    ], FAR);
    const exact = resolveAllDamage(s, session([{ x: 0, y: 0 }], 12));
    expect(exact.damagedEnemies.some((d) => d.bonus)).toBe(false);
    const t = wave(QUEST3, 1);
    arrange(t, [
      { cardId: "nightswiper-097", x: 0, y: 0 },
      { cardId: "nightswiper-098", x: 4, y: 0 },
    ], FAR);
    const over = resolveAllDamage(t, session([{ x: 0, y: 0 }], 13));
    expect(over.damagedEnemies.filter((d) => d.bonus).map((d) => d.instanceId).sort()).toEqual(["t-0", "t-1"]);
  });
});

describe("Lvl 4 / Lvl 5 boss parts", () => {
  it("Golem and Timber Fiend drops land in their own wallets", () => {
    const s = newCampaign();
    expect(getEnemy("golem-055").onDeath.drops).toEqual(["boss-part-lvl-4"]);
    expect(getEnemy("timberfiend-071").onDeath.drops).toEqual(["boss-part-lvl-5"]);
    creditBossPartDrop(s, "hero-01", "boss-part-lvl-4");
    creditBossPartDrop(s, "hero-01", "boss-part-lvl-5");
    expect(s.bossPartsLvl4["hero-01"]).toBe(1);
    expect(s.bossPartsLvl5["hero-01"]).toBe(1);
    expect(totalBossParts(s, "hero-01")).toBe(2);
  });

  it("v60 -> v61 seeds the new wallets and encounter fields", () => {
    const save = { version: 60, loadouts: { "hero-01": {}, "hero-02": {} }, encounter: { enemies: [] } };
    const out = migrateV60ToV61(save) as unknown as Record<string, unknown>;
    expect(out.version).toBe(61);
    expect(out.bossPartsLvl4).toEqual({ "hero-01": 0, "hero-02": 0 });
    expect(out.bossPartsLvl5).toEqual({ "hero-01": 0, "hero-02": 0 });
    expect(out.encounter).toMatchObject({ countdownTokens: 0, accurateMarks: {} });
  });
});

describe("Gaia reward — choose 2 Shop Products", () => {
  const FROM = [32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45];

  it("adds the two picks", () => {
    const s = newCampaign();
    resolveShopProductPicks(s, FROM, 2, [38, 45], "Gaia");
    expect(s.shopProductsAvailable).toEqual(expect.arrayContaining([38, 45]));
  });

  it("skips products already available or owned, and rejects invalid picks", () => {
    const s = newCampaign();
    s.shopProductsAvailable.push(43);
    s.shopProductsOwned["hero-01"] = [32];
    expect(eligibleShopProductPicks(s, FROM)).not.toContain(43);
    expect(eligibleShopProductPicks(s, FROM)).not.toContain(32);
    expect(() => resolveShopProductPicks(s, FROM, 2, [43, 44], "Gaia")).toThrow();
    expect(() => resolveShopProductPicks(s, FROM, 2, [44], "Gaia")).toThrow();
  });

  it("each pick that can't be made becomes a Memory Chip", () => {
    const s = newCampaign();
    s.shopProductsAvailable.push(...FROM.filter((n) => n !== 40));
    const chips = s.memoryChips;
    resolveShopProductPicks(s, FROM, 2, [40], "Gaia");
    expect(s.shopProductsAvailable).toContain(40);
    expect(s.memoryChips).toBe(chips + 1);
  });
});
