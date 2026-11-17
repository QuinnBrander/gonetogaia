/**
 * Quest #03 "Xavier's Request" (Chapter 3) — data + abilities.
 *
 * Covers:
 *   - quest3.json integrity + Chapter 3 launch.
 *   - Flees: a surviving Flees enemy moves to the free tile farthest
 *     from the attacker (max 2 steps); dying ones stay put.
 *   - Synchronized: damaging one Synchronized enemy pulls every
 *     8-adjacent chain-connected enemy into the shared counter.
 *   - Soothsayer: ending a wave with the boss alive kills both delvers.
 *   - onBossSlain: killing the Carnatia applies 3.4's rewards and parks
 *     the entry for the board.
 */

import { describe, it, expect } from "vitest";

import { newCampaign, type CampaignState } from "../state";
import { CHAPTER3, getEnemy, getQuestData, QUEST3 } from "../data";
import { bootstrapWaveAtNumber, ensureEncounter } from "../engine/encounter";
import { finalizeAttackSession, resolveAllDamage, resolveSharedCounter, type AttackSession } from "../engine/combat";
import { applyKill } from "../engine/kills";
import { enterEndOfWave } from "../engine/wave";

function wave(n: number): CampaignState {
  const s = newCampaign();
  s.currentQuestId = "quest3";
  ensureEncounter(s, QUEST3, (pool) => [...pool]);
  if (n > 1) bootstrapWaveAtNumber(s, QUEST3, n);
  return s;
}

/** Clear the board, then place enemies + delvers exactly where a test needs them. */
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

describe("quest3 — data integrity", () => {
  it("is registered, enemies exist, pages exist, Ch3 launches it", () => {
    expect(getQuestData("quest3")).toBe(QUEST3);
    for (const w of QUEST3.waves) {
      expect(() => getEnemy(w.bossEnemyId)).not.toThrow();
      for (const id of w.minionEnemyIds) expect(() => getEnemy(id)).not.toThrow();
      expect(QUEST3.pages[w.eow!.defeat.pageId]).toBeDefined();
      for (const c of w.eow!.victory) expect(QUEST3.pages[c.pageId]).toBeDefined();
      if (w.onBossSlain) expect(QUEST3.pages[w.onBossSlain.pageId]).toBeDefined();
    }
    expect(Object.values(CHAPTER3.pages).some((p) => p.startQuest === "quest3")).toBe(true);
  });
});

describe("quest3 — Flees", () => {
  it("a surviving Flees enemy runs to the farthest free tile; a dying one doesn't", () => {
    const s = wave(1);
    arrange(s, [{ cardId: "cerberus-031", x: 2, y: 2 }, { cardId: "fleetfoot-032", x: 1, y: 2 }],
      { "hero-01": { x: 2, y: 1 }, "hero-02": { x: 0, y: 0 } });
    const sess = session([{ x: 2, y: 2 }, { x: 1, y: 2 }], 3);
    resolveAllDamage(s, sess);
    resolveSharedCounter(s, sess, 1);
    const [cerberus, fleetfoot] = s.encounter!.enemies;
    // Cerberus (20 HP) survives and flees 2 tiles south, away from (2,1).
    expect(Math.max(Math.abs(cerberus!.x - 2), Math.abs(cerberus!.y - 1))).toBe(3);
    // Fleetfoot (3 HP) took lethal damage — stays to be cleared.
    expect([fleetfoot!.x, fleetfoot!.y]).toEqual([1, 2]);
  });
});

describe("quest3 — Synchronized", () => {
  it("damaging one Colibrius pulls the adjacent chain into the counter", () => {
    const s = wave(2);
    arrange(s, [
      { cardId: "colibrius-040", x: 0, y: 0 },
      { cardId: "colibrius-041", x: 1, y: 1 },
      { cardId: "carnatia-039", x: 2, y: 2 },
      { cardId: "colibrius-042", x: 4, y: 4 },
    ], { "hero-01": { x: 0, y: 1 }, "hero-02": { x: 4, y: 0 } });
    const sess = session([{ x: 0, y: 0 }], 1);
    const phase = resolveAllDamage(s, sess);
    const ids = phase.damagedEnemies.map((d) => d.instanceId).sort();
    expect(ids).toEqual(["t-0", "t-1", "t-2"]);
  });
});

describe("quest3 — Soothsayer + Carnatia entry", () => {
  it("a living Carnatia at end of wave kills both delvers", () => {
    const s = wave(2);
    enterEndOfWave(s, "victory");
    expect(s.encounter!.endOfWaveOutcome).toBe("defeat");
    expect(Object.values(s.loadouts).every((l) => l.currentHp === 0)).toBe(true);
  });

  it("slaying the Carnatia completes the quest and queues entry 3.4", () => {
    const s = wave(2);
    applyKill(s, getEnemy("carnatia-039"), { x: 2, y: 2 });
    expect(s.completedQuests).toContain(3);
    expect(s.keyItems.some((k) => k.number === 12)).toBe(true);
    expect(s.bossPartsLvl2["hero-01"]).toBe(1);
    expect(s.favour.xavier?.value).toBe(1);
    expect(s.encounter!.pendingQuestEntry?.pageId).toBe("q3_carnatia_slain");
    expect(s.encounter!.pendingQuestEntry?.events.length).toBeGreaterThan(0);
  });

  it("once the Carnatia is dead, ending the wave is a victory", () => {
    const s = wave(2);
    for (const e of s.encounter!.enemies) if (e.cardId === "carnatia-039") e.alive = false;
    enterEndOfWave(s, "victory");
    expect(s.encounter!.endOfWaveOutcome).toBe("victory");
  });
});

describe("quest3 — Wave 3 (All-Claw, Death Heal, Scenario D)", () => {
  it("All-Claw: a roll of 1 fires both patterns; normal enemies still miss", () => {
    const s = wave(3);
    const ash = getEnemy("empressash-047");
    const off = [...ash.counterCommon, ...ash.counterUncommon][0]!;
    // Delver stands on one of Ash's arrow tiles (either pattern).
    arrange(s, [{ cardId: "empressash-047", x: 2, y: 2 }],
      { "hero-01": { x: 2 + off.dx, y: 2 + off.dy }, "hero-02": { x: 4, y: 4 } });
    const before = s.loadouts["hero-01"]!.currentHp;
    const sess = session([{ x: 2, y: 2 }], 1);
    resolveAllDamage(s, sess);
    const phase = resolveSharedCounter(s, sess, 1);
    expect(phase.hits.some((h) => h.heroId === "hero-01")).toBe(true);
    expect(s.loadouts["hero-01"]!.currentHp).toBeLessThan(before);

    const t = wave(3);
    const tg = getEnemy("tidegazer-048");
    const toff = tg.counterCommon[0]!;
    arrange(t, [{ cardId: "tidegazer-048", x: 2, y: 2 }],
      { "hero-01": { x: 2 + toff.dx, y: 2 + toff.dy }, "hero-02": { x: 4, y: 4 } });
    const tsess = session([{ x: 2, y: 2 }], 1);
    resolveAllDamage(t, tsess);
    expect(resolveSharedCounter(t, tsess, 1).hits).toEqual([]);
  });

  it("Death Heal: a dying Tidegazer heals adjacent survivors, not ones that also died", () => {
    const s = wave(3);
    arrange(s, [
      { cardId: "tidegazer-048", x: 1, y: 1 },
      { cardId: "empressash-047", x: 2, y: 1 },
      { cardId: "tidegazer-049", x: 0, y: 0 },
    ], { "hero-01": { x: 4, y: 4 }, "hero-02": { x: 4, y: 3 } });
    const [dying, ash, alsoDying] = s.encounter!.enemies;
    ash!.damageTaken = 10;
    const sess = session([{ x: 1, y: 1 }, { x: 0, y: 0 }], 12);
    resolveAllDamage(s, sess);
    resolveSharedCounter(s, sess, -1);
    finalizeAttackSession(s, sess);
    expect(dying!.alive).toBe(false);
    expect(alsoDying!.alive).toBe(false);
    expect(ash!.damageTaken).toBe(0);
  });

  it("Wave 3 no longer seeds Scenario D; the Dahlia is Free bonus opens Quest #4 instead", () => {
    const w3 = QUEST3.waves.find((w) => w.number === 3)!;
    const rewards = w3.eow!.victory.flatMap((c) => c.rewards ?? []);
    expect(rewards.some((r) => r.kind === "place-scenario-card-on-top")).toBe(false);
    const bonus = w3.eow!.victory.find((c) => c.requireKeyItem === 12)!;
    expect(bonus.rewards).toContainEqual({ kind: "reveal-quest-or-grant-chip", number: 4, name: "A Hand Outstretched", chipFallback: 1 });
  });
});
