/**
 * Lieutenants + the storybook Lieutenant challenge (2026-11-17).
 *
 * Covers:
 *   - Lieutenant enemy cards (Lvl 1-5) and Lieutenants Spawn Cards #19-24.
 *   - The base spawn shuffle never contains a Lieutenants Spawn Card.
 *   - `lieutenant-challenge`: adds the next card to the campaign deck and
 *     puts it on top; once all six are in, one of them goes on top.
 *   - The next wave draws the on-top card, places Lieutenants at the
 *     wave's level, clears the slot and keeps the card in the deck.
 *   - Later spawn-deck draws include the campaign's Lieutenant cards.
 *   - Aggressive: moves one tile closer, else turns a blue arrow on the
 *     attacker.
 *   - "Gain 3 elements" on death queues element picks.
 *   - Quest data: every Quest #4+ continue into Wave 3+ offers the
 *     challenge, before the Key Item bonus; no other moment does.
 *   - v65 -> v66 migration.
 */

import { describe, it, expect } from "vitest";

import { migrateV65ToV66, newCampaign, type CampaignState } from "../state";
import {
  ENEMIES,
  getEnemy,
  getQuestData,
  getSpawnCard,
  LIEUTENANT_SPAWN_CARD_NUMBERS,
  lieutenantEnemyIdFor,
  shuffleSpawnDeck,
  shuffleSpawnDeckWithFriendly,
} from "../data";
import { bootstrapWaveAtNumber, ensureEncounter } from "../engine/encounter";
import { getSpawnCard as spawnCardOf } from "../data";
import { resolveAllDamage, resolveSharedCounter, rotateOffset, type AttackSession } from "../engine/combat";
import { applyKill } from "../engine/kills";
import { runTownVisitAction } from "../engine/townVisit";
import type { EnemyFacing } from "../state";

const LT_QUESTS = ["quest4", "quest5", "quest6", "quest7", "quest13"];

function waveOf(questId: string, n: number): CampaignState {
  const s = newCampaign();
  s.currentQuestId = questId;
  const q = getQuestData(questId);
  ensureEncounter(s, q, (pool) => [...pool]);
  if (n > 1) bootstrapWaveAtNumber(s, q, n);
  return s;
}

function session(tiles: Array<{ x: number; y: number }>, damage: number): AttackSession {
  return {
    attackerId: "hero-01",
    source: { kind: "weapon", slotIdx: 0 },
    damage,
    damageType: null,
    hitTiles: tiles,
    steps: [],
    sharedCounter: null,
    preEffects: [],
    postEffects: [],
    finalized: false,
    levelUpsApplied: 0,
  } as unknown as AttackSession;
}

function arrange(
  s: CampaignState,
  enemies: Array<{ cardId: string; x: number; y: number }>,
  delvers: Record<string, { x: number; y: number }>,
): void {
  const enc = s.encounter!;
  enc.enemies = enemies.map((e, i) => ({
    instanceId: `t-${i}`, cardId: e.cardId, x: e.x, y: e.y, damageTaken: 0, alive: true, facing: 0,
  }));
  enc.delverPositions = delvers;
  enc.witnessPosition = null;
}

describe("Lieutenant data", () => {
  it("ships a Lieutenant card per level (two for Lvl 1-4) with Aggressive", () => {
    for (let lvl = 1; lvl <= 5; lvl++) {
      for (const slot of [0, 1]) {
        const e = getEnemy(lieutenantEnemyIdFor(lvl, slot));
        expect(e.kind).toBe("lieutenant");
        expect(e.name).toBe(`Lieutenant - Lvl ${lvl}`);
        expect(e.abilities).toEqual([{ kind: "aggressive" }]);
        expect(e.onDeath.drops).toEqual(["minion-part", "minion-part"]);
      }
    }
    expect(ENEMIES.filter((e) => e.kind === "lieutenant")).toHaveLength(9);
  });

  it("Lieutenants Spawn Cards #19-24: 1 boss, 7 minions, 2 Lieutenants, 2 delver spawns", () => {
    expect([...LIEUTENANT_SPAWN_CARD_NUMBERS]).toEqual([19, 20, 21, 22, 23, 24]);
    for (const n of LIEUTENANT_SPAWN_CARD_NUMBERS) {
      const c = getSpawnCard(n);
      expect([c.bosses.length, c.minions.length, c.lieutenants?.length, c.delverSpawns.length]).toEqual([1, 7, 2, 2]);
      const tiles = [...c.bosses, ...c.minions, ...c.lieutenants!, ...c.delverSpawns, ...c.memoryFragments].map((p) => `${p.x},${p.y}`);
      expect(new Set(tiles).size).toBe(tiles.length);
    }
  });

  it("the base shuffles never contain a Lieutenants Spawn Card", () => {
    expect(shuffleSpawnDeck().some((n) => n >= 19)).toBe(false);
    expect(shuffleSpawnDeckWithFriendly([13]).some((n) => n >= 19)).toBe(false);
  });
});

describe("lieutenant-challenge", () => {
  it("adds the next card to the campaign deck and puts it on top", () => {
    const s = newCampaign();
    const ev = runTownVisitAction(s, { kind: "lieutenant-challenge" });
    expect(s.lieutenantSpawnDeck).toEqual([19]);
    expect(s.lieutenantSpawnOnTop).toBe(19);
    expect(ev).toEqual([{ kind: "lieutenant-spawn-card-on-top", cardNumber: 19, image: "spawn-card-19.png", added: true, deckSize: 1 }]);
    runTownVisitAction(s, { kind: "lieutenant-challenge" });
    expect(s.lieutenantSpawnDeck).toEqual([19, 20]);
    expect(s.lieutenantSpawnOnTop).toBe(20);
  });

  it("with all six in the deck, puts one of them on top instead", () => {
    const s = newCampaign();
    s.lieutenantSpawnDeck = [19, 20, 21, 22, 23, 24];
    const ev = runTownVisitAction(s, { kind: "lieutenant-challenge" });
    expect(s.lieutenantSpawnDeck).toHaveLength(6);
    expect(s.lieutenantSpawnDeck).toContain(s.lieutenantSpawnOnTop);
    expect(ev[0]).toMatchObject({ kind: "lieutenant-spawn-card-on-top", added: false, deckSize: 6 });
  });

  it("the next wave draws the on-top card, places Lieutenants at its level, and keeps the card", () => {
    const s = waveOf("quest7", 1);
    runTownVisitAction(s, { kind: "lieutenant-challenge" });
    const q = getQuestData("quest7");
    bootstrapWaveAtNumber(s, q, 3);
    const enc = s.encounter!;
    expect(enc.spawnCardDrawn).toBe(19);
    expect(s.lieutenantSpawnOnTop).toBeNull();
    expect(s.lieutenantSpawnDeck).toEqual([19]);
    const lts = enc.enemies.filter((e) => e.instanceId.startsWith("lieutenant-"));
    const level = Number(getEnemy(q.waves.find((w) => w.number === 3)!.bossEnemyId).kind.slice(-1));
    expect(lts.map((e) => e.cardId)).toEqual([lieutenantEnemyIdFor(level, 0), lieutenantEnemyIdFor(level, 1)]);
    expect(lts.map((e) => `${e.x},${e.y}`)).toEqual(getSpawnCard(19).lieutenants!.map((p) => `${p.x},${p.y}`));
    // A reload keeps the wave (the Lieutenants count toward the expected enemies).
    const before = s.encounter;
    ensureEncounter(s, q);
    expect(s.encounter).toBe(before);
  });

  it("later spawn-deck draws include the campaign's Lieutenant cards", () => {
    const s = waveOf("quest7", 1);
    s.lieutenantSpawnDeck = [19, 20, 21, 22, 23, 24];
    const q = getQuestData("quest7");
    const drawn = new Set<number>();
    for (let i = 0; i < 200; i++) {
      bootstrapWaveAtNumber(s, q, 2);
      drawn.add(s.encounter!.spawnCardDrawn!);
    }
    expect([...drawn].some((n) => n >= 19)).toBe(true);
    expect([...drawn].some((n) => n <= 12)).toBe(true);
    expect(s.lieutenantSpawnDeck).toHaveLength(6);
  });
});

describe("Aggressive", () => {
  it("moves one tile closer to the attacker", () => {
    const s = waveOf("quest7", 1);
    arrange(s, [{ cardId: "lieutenant-l3a", x: 2, y: 3 }], { "hero-01": { x: 2, y: 0 }, "hero-02": { x: 4, y: 0 } });
    const sess = session([{ x: 2, y: 3 }], 1);
    resolveAllDamage(s, sess);
    resolveSharedCounter(s, sess, 1);
    const lt = s.encounter!.enemies[0]!;
    expect(Math.max(Math.abs(lt.x - 2), Math.abs(lt.y - 0))).toBe(2);
  });

  it("when it can't move closer, it turns so a blue arrow targets the attacker", () => {
    const s = waveOf("quest7", 1);
    // Adjacent on the diagonal (south-east of the Lieutenant).
    arrange(s, [{ cardId: "lieutenant-l1a", x: 2, y: 2 }], { "hero-01": { x: 3, y: 3 }, "hero-02": { x: 0, y: 0 } });
    const card = getEnemy("lieutenant-l1a");
    const blueAt = (f: EnemyFacing) => card.counterCommon.some((o) => {
      const r = rotateOffset(o, f);
      return r.dx === 1 && r.dy === 1;
    });
    expect(blueAt(0)).toBe(false);
    const sess = session([{ x: 2, y: 2 }], 1);
    resolveAllDamage(s, sess);
    resolveSharedCounter(s, sess, 1);
    const lt = s.encounter!.enemies[0]!;
    expect([lt.x, lt.y]).toEqual([2, 2]);
    expect(blueAt(lt.facing)).toBe(true);
  });
});

describe("Lieutenant on death", () => {
  it('"Gain 3 elements" queues three picks per living delver', () => {
    const s = waveOf("quest7", 1);
    const before = s.encounter!.pendingElementChoices.length;
    applyKill(s, getEnemy("lieutenant-l2b"), { x: 0, y: 0 });
    const picks = s.encounter!.pendingElementChoices.slice(before);
    expect(picks).toHaveLength(3 * Object.keys(s.loadouts).length);
    expect(picks[0]!.source).toEqual({ kind: "enemy-kill", enemyName: "Lieutenant - Lvl 2" });
  });
});

describe("storybook Lieutenant challenge in quest data", () => {
  it("every Quest #4+ continue into Wave 3+ offers it once, before the Key Item bonus", () => {
    for (const id of [...LT_QUESTS, "quest3"]) {
      const q = getQuestData(id);
      for (const w of q.waves) {
        const vic = w.eow?.victory ?? [];
        const lt = vic.filter((c) => (c.rewards ?? []).some((r) => r.kind === "lieutenant-challenge"));
        const continues = vic.some((c) => c.then === "next-wave");
        const nextWave = w.number + 1;
        const eligible = id !== "quest3" && continues && nextWave >= 3 && !(id === "quest4" && w.number === 1);
        expect(lt.length, `${id} W${w.number}`).toBe(eligible ? 1 : 0);
        if (!eligible) continue;
        const c = lt[0]!;
        expect(c.then).toBe("next-wave");
        expect(c.label).toContain("Challenge the Lieutenant");
        expect(q.pages[c.pageId]).toContain("Lieutenant");
        const bonusIdx = vic.findIndex((v) => v.requireKeyItem !== undefined);
        if (bonusIdx >= 0) expect(vic.indexOf(c)).toBeLessThan(bonusIdx);
        const parts = (c.rewards ?? []).find((r) => r.kind === "grant-boss-parts");
        const nextBoss = getEnemy(q.waves.find((x) => x.number === nextWave)!.bossEnemyId);
        expect(parts).toMatchObject({ level: Number(nextBoss.kind.slice(-1)), amount: 1, to: "all-delvers" });
        expect((c.carryEffects ?? []).some((e) => e.kind === "grant-level-up-card")).toBe(true);
      }
    }
  });
});

describe("migrateV65ToV66", () => {
  it("adds an empty Lieutenant deck and no on-top card", () => {
    const old = { ...newCampaign(), version: 65 } as Record<string, unknown>;
    delete old.lieutenantSpawnDeck;
    delete old.lieutenantSpawnOnTop;
    const out = migrateV65ToV66(old)!;
    expect(out.version).toBe(66);
    expect(out.lieutenantSpawnDeck).toEqual([]);
    expect(out.lieutenantSpawnOnTop).toBeNull();
  });
});

describe("Dahlia Detractor / Nemesis", () => {
  const dahlia = (s: CampaignState, level: "detractor" | "nemesis") =>
    s.opinionCards.push({ characterId: "dahlia", characterName: "Dahlia", level });
  const lieutenants = (s: CampaignState) =>
    s.encounter!.enemies.filter((e) => getEnemy(e.cardId).kind === "lieutenant");

  it("without the cards, a base spawn card has no Lieutenants", () => {
    const s = waveOf("quest7", 1);
    bootstrapWaveAtNumber(s, getQuestData("quest7"), 2, { drawSpawnCardNumber: () => 1 });
    expect(lieutenants(s)).toHaveLength(0);
  });

  for (const [level, n] of [["detractor", 1], ["nemesis", 2]] as const) {
    it(`${level}: every wave has at least ${n} Lieutenant(s), at the boss level, on free non-spawn tiles`, () => {
      const s = waveOf("quest7", 1);
      dahlia(s, level);
      const q = getQuestData("quest7");
      bootstrapWaveAtNumber(s, q, 2, { drawSpawnCardNumber: () => 1 });
      const lts = lieutenants(s);
      expect(lts).toHaveLength(n);
      const lvl = Number(getEnemy(q.waves.find((w) => w.number === 2)!.bossEnemyId).kind.slice(-1));
      expect(lts.map((e) => e.cardId)).toEqual([0, 1].slice(0, n).map((slot) => lieutenantEnemyIdFor(lvl, slot)));
      const card = spawnCardOf(1);
      const forbidden = new Set([...card.delverSpawns, ...card.memoryFragments].map((p) => `${p.x},${p.y}`));
      const tiles = s.encounter!.enemies.map((e) => `${e.x},${e.y}`);
      expect(new Set(tiles).size).toBe(tiles.length);
      for (const e of lts) expect(forbidden.has(`${e.x},${e.y}`)).toBe(false);
      // A reload keeps the wave.
      const before = s.encounter;
      ensureEncounter(s, q);
      expect(s.encounter).toBe(before);
    });
  }

  it("a Lieutenants Spawn Card already meets the Nemesis minimum (no extras)", () => {
    const s = waveOf("quest7", 1);
    dahlia(s, "nemesis");
    bootstrapWaveAtNumber(s, getQuestData("quest7"), 2, { drawSpawnCardNumber: () => 19 });
    expect(lieutenants(s)).toHaveLength(2);
    expect(s.encounter!.enemies.some((e) => e.instanceId.startsWith("dahlia-lieutenant-"))).toBe(false);
  });
});
