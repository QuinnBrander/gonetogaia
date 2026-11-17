/**
 * Quest #05 "The Rogue Delver" (Chapter 3) — data + the 2-card boss.
 *
 * Covers:
 *   - quest5.json integrity + Chapter 3 launch.
 *   - Oblivionwing (2 cards): spawns with the 2/2 card east of the 1/2
 *     card, damage to either card lands on the one boss, both cards
 *     counterattack, both are removed when it dies, and the 2/2 card has
 *     no parting shot of its own.
 */

import { describe, it, expect } from "vitest";

import { newCampaign, type CampaignState } from "../state";
import { CHAPTER3, getEnemy, getQuestData, QUEST5 } from "../data";
import { bootstrapWaveAtNumber, ensureEncounter, isMultiCardBoss } from "../engine/encounter";
import { finalizeAttackSession, resolveAllDamage, resolveSharedCounter, type AttackSession } from "../engine/combat";
import { legalMoveDestinationsForEnemy } from "../engine/boots";

function wave(n: number): CampaignState {
  const s = newCampaign();
  s.currentQuestId = "quest5";
  ensureEncounter(s, QUEST5, (pool) => [...pool]);
  if (n > 1) bootstrapWaveAtNumber(s, QUEST5, n);
  return s;
}

function session(tiles: Array<{ x: number; y: number }>, damage: number): AttackSession {
  return {
    attackerId: "hero-01",
    source: { kind: "weapon", slotIdx: 0, cardId: "mind-hammer-r1" },
    damage,
    damageType: null,
    hitTiles: tiles,
    steps: [],
    sharedCounter: null,
    finalized: false,
    preEffects: [],
    postEffects: [],
    levelUpsApplied: 0,
  };
}

describe("quest5 — data integrity", () => {
  it("is registered, 3 waves, enemies + pages exist, Ch3 launches it", () => {
    expect(getQuestData("quest5")).toBe(QUEST5);
    expect(QUEST5.waves.map((w) => w.number)).toEqual([1, 2, 3]);
    for (const w of QUEST5.waves) {
      expect(() => getEnemy(w.bossEnemyId)).not.toThrow();
      expect(w.minionEnemyIds).toHaveLength(7);
      for (const id of w.minionEnemyIds) expect(() => getEnemy(id)).not.toThrow();
      expect(QUEST5.pages[w.eow!.defeat.pageId]).toBeDefined();
      for (const c of w.eow!.victory) expect(QUEST5.pages[c.pageId]).toBeDefined();
    }
    expect(Object.values(CHAPTER3.pages).some((p) => p.startQuest === "quest5")).toBe(true);
  });

  it("Wave 3 rewards Key Item #11 and completes the quest", () => {
    const rewards = QUEST5.waves[2]!.eow!.victory[0]!.rewards!;
    expect(rewards).toContainEqual({ kind: "gain-key-item", number: 11, name: "Baby Janus" });
    expect(rewards).toContainEqual({ kind: "complete-quest", number: 5, name: "The Rogue Delver" });
  });

  it("Wave 1 spawns Vicious enemies with their monster token", () => {
    const s = wave(1);
    expect(s.encounter!.enemies.every((e) => e.viciousToken === true)).toBe(true);
  });
});

describe("Oblivionwing — 2-card boss", () => {
  it("spawns the 2/2 card on the tile east of the 1/2 card, sharing nothing else", () => {
    for (let i = 0; i < 20; i++) {
      const s = wave(3);
      const enc = s.encounter!;
      expect(enc.enemies).toHaveLength(9);
      const boss = enc.enemies.find((e) => e.instanceId === "boss")!;
      const part = enc.enemies.find((e) => e.linkedTo === "boss")!;
      expect(boss.cardId).toBe("oblivionwing-095");
      expect(part.cardId).toBe("oblivionwing-096");
      expect([part.x, part.y]).toEqual([boss.x + 1, boss.y]);
      const tiles = enc.enemies.map((e) => `${e.x},${e.y}`);
      expect(new Set(tiles).size).toBe(tiles.length);
      for (const pos of Object.values(enc.delverPositions)) expect(tiles).not.toContain(`${pos.x},${pos.y}`);
      expect(isMultiCardBoss(enc, boss)).toBe(true);
      expect(isMultiCardBoss(enc, part)).toBe(true);
    }
  });

  it("damage to the 2/2 card hurts the boss; both cards counterattack", () => {
    const s = wave(3);
    const enc = s.encounter!;
    const boss = enc.enemies.find((e) => e.instanceId === "boss")!;
    const part = enc.enemies.find((e) => e.linkedTo === "boss")!;
    enc.delverPositions = { "hero-01": { x: part.x, y: (part.y + 3) % 5 }, "hero-02": { x: part.x, y: (part.y + 3) % 5 } };
    const phase = resolveAllDamage(s, session([{ x: part.x, y: part.y }], 7));
    expect(boss.damageTaken).toBe(7);
    expect(part.damageTaken).toBe(7);
    expect(phase.damagedEnemies.map((d) => d.instanceId).sort()).toEqual(["boss", "boss-part"]);
  });

  it("hitting both cards in one attack deals damage twice but each card counters once", () => {
    const s = wave(3);
    const enc = s.encounter!;
    const boss = enc.enemies.find((e) => e.instanceId === "boss")!;
    const part = enc.enemies.find((e) => e.linkedTo === "boss")!;
    const phase = resolveAllDamage(s, session([{ x: boss.x, y: boss.y }, { x: part.x, y: part.y }], 5));
    expect(boss.damageTaken).toBe(10);
    expect(phase.damagedEnemies.filter((d) => !d.bonus).map((d) => d.instanceId).sort()).toEqual(["boss", "boss-part"]);
  });

  it("killing the boss removes both cards; only the 1/2 card gives rewards", () => {
    const s = wave(3);
    const enc = s.encounter!;
    const boss = enc.enemies.find((e) => e.instanceId === "boss")!;
    const part = enc.enemies.find((e) => e.linkedTo === "boss")!;
    const sess = session([{ x: part.x, y: part.y }], 60);
    resolveAllDamage(s, sess);
    resolveSharedCounter(s, sess, -1);
    finalizeAttackSession(s, sess);
    expect(boss.alive).toBe(false);
    expect(part.alive).toBe(false);
    const bossDrops = enc.tileDrops.filter((d) => d.dropId === "boss-part-lvl-3");
    expect(bossDrops.length).toBeGreaterThan(0);
    expect(bossDrops.every((d) => d.x === boss.x && d.y === boss.y)).toBe(true);
  });

  it("neither card can be moved by Boots", () => {
    const s = wave(3);
    const enc = s.encounter!;
    for (const e of enc.enemies.filter((x) => x.instanceId === "boss" || x.linkedTo)) {
      expect(legalMoveDestinationsForEnemy(s, e.instanceId, { w: 5, h: 5 })).toEqual([]);
    }
  });
});
