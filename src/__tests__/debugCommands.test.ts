/**
 * Tests for src/engine/debugCommands.ts — the W-key "win the wave"
 * jam-time debug shortcut.
 *
 * Covers:
 *   - Slays every alive enemy + transitions to Parting Shots.
 *   - Auto-collects every drop (minion-part + boss-part-lvl-N) into
 *     the matching delver's parts bag.
 *   - Pre-existing tile drops on the board are also collected (the
 *     "you walked onto every tile" behavior).
 *   - XP / level-ups credited via the regular kill path.
 *   - No-op when there is no encounter.
 *   - No-op when the encounter is past the Hero Phase.
 *   - Handles a downed delver: drops are owed only to alive delvers
 *     (mirrors `applyKill`'s dead-delver skip).
 */

import { describe, it, expect } from "vitest";

import { newCampaign, type CampaignState } from "../state";
import { QUEST1 } from "../data";
import { commitFirstTurnPick, ensureEncounter } from "../engine/encounter";
import { startHeroTurn } from "../engine/turn";
import { debugKeyLoseWave, debugKeyWinWave, debugWinWave } from "../engine/debugCommands";
import { getEnemy } from "../data";

const noShuffle = (pool: readonly string[]) => [...pool];

// Q1's wave 1 spawn is hand-authored — narrow once so the tests
// below can read `spawn.minions.length` without re-narrowing per call.
const W1 = QUEST1.waves[0]!;
if (W1.spawn.kind !== "hand-authored") {
  throw new Error(`Expected Q1 W1 spawn to be hand-authored, got "${W1.spawn.kind}"`);
}
const W1_SPAWN = W1.spawn;

function freshState(): CampaignState {
  const s = newCampaign();
  ensureEncounter(s, QUEST1, noShuffle);
  // Q1 lands in `first-turn-pick` since the 2026-05-20 wiring of
  // the pre-hero "who takes turn 1?" picker. Commit hero-01 to
  // advance into `hero` phase so debugWinWave (which gates on
  // hero phase) can fire.
  commitFirstTurnPick(s, "hero-01", startHeroTurn);
  return s;
}

describe("debugWinWave", () => {
  it("returns null when there is no encounter", () => {
    const s = newCampaign();
    expect(s.encounter).toBeNull();
    expect(debugWinWave(s)).toBeNull();
  });

  it("returns null when the encounter is past the Hero Phase", () => {
    const s = freshState();
    s.encounter!.phase = "parting-shots";
    expect(debugWinWave(s)).toBeNull();
    expect(s.encounter!.phase).toBe("parting-shots"); // unchanged
  });

  it("slays every alive enemy and transitions to parting-shots", () => {
    const s = freshState();
    const enc = s.encounter!;
    expect(enc.enemies.every((e) => e.alive)).toBe(true);
    const enemyCount = enc.enemies.length;

    const result = debugWinWave(s);

    expect(result).not.toBeNull();
    expect(result!.enemiesSlain).toBe(enemyCount);
    expect(result!.phaseFrom).toBe("hero");
    expect(result!.phaseTo).toBe("parting-shots");
    expect(s.encounter!.phase).toBe("parting-shots");
    expect(s.encounter!.partingShotCursor).toBe(0);
    expect(s.encounter!.enemies.every((e) => !e.alive)).toBe(true);
  });

  it("does NOT re-kill enemies that were already dead", () => {
    const s = freshState();
    const enc = s.encounter!;
    // Mark one minion as already dead (e.g. killed during hero phase).
    enc.enemies[1]!.alive = false;
    const aliveBefore = enc.enemies.filter((e) => e.alive).length;

    const result = debugWinWave(s);

    expect(result!.enemiesSlain).toBe(aliveBefore);
    expect(s.encounter!.enemies.every((e) => !e.alive)).toBe(true);
  });

  it("auto-collects ALL on-death drops into matching delver part bags", () => {
    const s = freshState();
    const enc = s.encounter!;
    const heroIds = Object.keys(s.loadouts);

    // Sanity: at start every part counter is 0 and tileDrops empty.
    for (const heroId of heroIds) {
      expect(s.minionParts[heroId] ?? 0).toBe(0);
      expect(s.bossParts[heroId] ?? 0).toBe(0);
    }
    expect(enc.tileDrops.length).toBe(0);

    const result = debugWinWave(s)!;

    // Q1 spawns 1 boss + N minions. Per `applyKill`'s per-delver
    // drop fan-out, every living delver gets ONE token per drop on
    // each enemy. So with 2 living delvers + 1 boss + N minions:
    //   - minion parts per delver = N
    //   - boss parts per delver   = 1
    const minionCount = W1_SPAWN.minions.length;
    for (const heroId of heroIds) {
      expect(s.minionParts[heroId]).toBe(minionCount);
      expect(s.bossParts[heroId]).toBe(1);
      expect(result.minionPartsCollected[heroId]).toBe(minionCount);
      expect(result.bossPartsCollected[heroId]).toBe(1);
    }

    // tileDrops should be drained after auto-collect.
    expect(s.encounter!.tileDrops.length).toBe(0);
  });

  it("also collects pre-existing tile drops sitting on the board", () => {
    const s = freshState();
    const enc = s.encounter!;
    // Simulate a kill that already happened during hero phase: a
    // crystanid was killed and its tile-drop is still sitting there
    // because the delver hasn't walked onto the tile yet.
    const heroId = Object.keys(s.loadouts)[0]!;
    enc.tileDrops.push({ x: 0, y: 0, heroId, dropId: "minion-part" });

    debugWinWave(s);

    // The pre-existing drop should be collected on top of the new
    // ones. Hero[0]'s minion-part total = QUEST1 minions + 1
    // pre-existing.
    const minionCount = W1_SPAWN.minions.length;
    expect(s.minionParts[heroId]).toBe(minionCount + 1);
  });

  it("credits XP through the regular applyKill path", () => {
    const s = freshState();
    const xpBefore = s.totalXp;

    debugWinWave(s);

    // Q1 enemies grant XP varied per-card; we just assert SOMETHING
    // got credited. The exact value is enemy-dataset-dependent and
    // covered by kills.test.ts.
    expect(s.totalXp).toBeGreaterThan(xpBefore);
  });

  it("respects dead-delver skip for drops (alive delver still gets theirs)", () => {
    const s = freshState();
    const heroIds = Object.keys(s.loadouts);
    const downed = heroIds[1]!;
    const alive = heroIds[0]!;
    // Take the second delver to 0 HP before W is pressed.
    s.loadouts[downed]!.currentHp = 0;

    debugWinWave(s);

    const minionCount = W1_SPAWN.minions.length;
    // Alive delver gets a full set of drops (one per enemy).
    expect(s.minionParts[alive]).toBe(minionCount);
    expect(s.bossParts[alive]).toBe(1);
    // Downed delver gets nothing — applyKill's dead-delver skip
    // never created TileDrops for them.
    expect(s.minionParts[downed] ?? 0).toBe(0);
    expect(s.bossParts[downed] ?? 0).toBe(0);
  });
});

/** Number of `minion-part` drops each delver would be owed by the living enemies. */
function livingMinionDrops(s: CampaignState): number {
  let n = 0;
  for (const e of s.encounter!.enemies) {
    if (!e.alive || e.linkedTo) continue;
    n += (getEnemy(e.cardId).onDeath.drops ?? []).filter((d) => d === "minion-part").length;
  }
  return n;
}

describe("debugKeyWinWave (W key)", () => {
  it("throws when there is no wave in progress", () => {
    expect(() => debugKeyWinWave(newCampaign())).toThrow(/no wave in progress/);
  });

  it("throws outside the Hero Phase and leaves state alone", () => {
    const s = freshState();
    s.encounter!.phase = "parting-shots";
    expect(() => debugKeyWinWave(s)).toThrow(/Hero Phase/);
    expect(s.encounter!.enemies.every((e) => e.alive)).toBe(true);
  });

  it("gives each delver half the minion parts (rounded down) and every boss part", () => {
    const s = freshState();
    const owed = livingMinionDrops(s);
    expect(owed).toBeGreaterThan(0);
    const result = debugKeyWinWave(s);
    for (const heroId of Object.keys(s.loadouts)) {
      expect(s.minionParts[heroId] ?? 0).toBe(Math.floor(owed / 2));
      expect(s.bossParts[heroId]).toBe(1);
      expect(result.bossPartsCollected[heroId]).toBe(1);
    }
    expect(s.encounter!.tileDrops).toEqual([]);
  });

  it("rounds an odd minion count down", () => {
    const s = freshState();
    // Kill minions off-board until the remaining owed count is odd.
    const minions = s.encounter!.enemies.filter((e) => getEnemy(e.cardId).kind === "minion");
    for (const m of minions) {
      if (livingMinionDrops(s) % 2 === 1) break;
      m.alive = false;
    }
    const owed = livingMinionDrops(s);
    expect(owed % 2).toBe(1);
    debugKeyWinWave(s);
    for (const heroId of Object.keys(s.loadouts)) {
      expect(s.minionParts[heroId] ?? 0).toBe((owed - 1) / 2);
    }
  });

  it("collects drops already on the board in full", () => {
    const s = freshState();
    const heroId = Object.keys(s.loadouts)[0]!;
    s.encounter!.tileDrops.push({ x: 0, y: 0, heroId, dropId: "minion-part" });
    const owed = livingMinionDrops(s);
    debugKeyWinWave(s);
    expect(s.minionParts[heroId]).toBe(Math.floor(owed / 2) + 1);
  });

  it("credits XP like real kills and routes into Parting Shots", () => {
    const s = freshState();
    const xpBefore = s.totalXp;
    debugKeyWinWave(s);
    expect(s.totalXp).toBeGreaterThan(xpBefore);
    expect(s.encounter!.phase).toBe("parting-shots");
    expect(s.encounter!.partingShotCursor).toBe(0);
    expect(s.encounter!.enemies.every((e) => !e.alive)).toBe(true);
  });
});

describe("debugKeyLoseWave (L key)", () => {
  it("throws outside the Hero Phase", () => {
    expect(() => debugKeyLoseWave(newCampaign())).toThrow(/no wave in progress/);
    const s = freshState();
    s.encounter!.phase = "parting-shots";
    expect(() => debugKeyLoseWave(s)).toThrow(/Hero Phase/);
  });

  it("gives each delver half the minion parts, no boss parts and no XP", () => {
    const s = freshState();
    const owed = livingMinionDrops(s);
    const xpBefore = s.totalXp;
    debugKeyLoseWave(s);
    for (const heroId of Object.keys(s.loadouts)) {
      expect(s.minionParts[heroId] ?? 0).toBe(Math.floor(owed / 2));
      expect(s.bossParts[heroId] ?? 0).toBe(0);
    }
    expect(s.totalXp).toBe(xpBefore);
  });

  it("downs only the active delver and enters End of Wave (defeat)", () => {
    const s = freshState();
    const active = s.currentDelverId;
    debugKeyLoseWave(s);
    for (const heroId of Object.keys(s.loadouts)) {
      const hp = s.loadouts[heroId]!.currentHp;
      if (heroId === active) expect(hp).toBe(0);
      else expect(hp).toBeGreaterThan(0);
    }
    expect(s.encounter!.phase).toBe("end-of-wave");
    expect(s.encounter!.endOfWaveOutcome).toBe("defeat");
  });
});
