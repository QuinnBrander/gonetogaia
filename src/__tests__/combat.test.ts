/**
 * Tests for src/engine/combat.ts.
 *
 * Covers DESIGN.md §5.4 + §5.4.3:
 *   - hit-tile computation per `WeaponRange.kind`
 *   - per-tile damage application
 *   - counter-attack roll classification + damage to delvers
 *   - the session-based resolver (build / step / finalize)
 *   - ordering: damage \u2192 counter \u2192 kill bookkeeping per tile
 */

import { describe, it, expect } from "vitest";

import { newCampaign, type CampaignState, type EnemyInstance } from "../state";
import type { WeaponRange } from "../types";
import { QUEST1 } from "../data";
import { ensureEncounter } from "../engine/encounter";
import {
  computeWeaponHitTiles,
  applyDamageAtTile,
  applyCounter,
  buildAttackSession,
  resolveAllDamage,
  resolveSharedCounter,
  finalizeAttackSession,
  damageValueForCard,
  effectiveDamageForCard,
  damageValueForType,
  counterAttackOutcomeForRoll,
  COUNTER_ROLL,
  findShieldOpportunities,
  applyCounterDamageWithShieldChoices,
} from "../engine/combat";
import { getEquipment, getEnemy } from "../data";

const BOARD = QUEST1.waves[0]!.spawn.boardSize;

/** Empty arena: encounter ready, both delvers movable, no enemies pre-laid. */
function emptyArenaState(): CampaignState {
  const state = newCampaign();
  ensureEncounter(state, QUEST1);
  state.encounter!.enemies = [];
  return state;
}

/** Spawn a Crystanid at (x,y); returns the EnemyInstance for direct mutation. */
function spawnCrystanid(state: CampaignState, x: number, y: number, idSuffix = ""): EnemyInstance {
  const e: EnemyInstance = {
    instanceId: `c-${x}-${y}-${idSuffix}`,
    cardId: "crystanid-001",
    x, y,
    damageTaken: 0,
    alive: true,
    facing: 0,
  };
  state.encounter!.enemies.push(e);
  return e;
}

// --- Damage values ------------------------------------------------------

describe("damage values", () => {
  it("damageValueForCard uses card.damageMultiplier * Tuning.damageBase[type]", () => {
    // Per the printed suit board: LIGHT=1, MEDIUM=2, HEAVY=4 at the
    // un-upgraded diamond (DESIGN.md §5.4.1). All r1 weapons have
    // damageMultiplier = 1, so total damage equals the base value.
    const beam = getEquipment("mind-beam-r1");      // medium, mult 1 -> 2
    const hammer = getEquipment("mind-hammer-r1");  // heavy,  mult 1 -> 4
    const sword = getEquipment("body-sword-r1");    // medium, mult 1 -> 2
    const claw = getEquipment("body-gauntlet-r1");  // light,  mult 1 -> 1
    expect(damageValueForCard(beam)).toBe(2);
    expect(damageValueForCard(hammer)).toBe(4);
    expect(damageValueForCard(sword)).toBe(2);
    expect(damageValueForCard(claw)).toBe(1);
  });

  it("damageValueForType uses Tuning.damageBase", () => {
    expect(damageValueForType("light")).toBe(1);
    expect(damageValueForType("medium")).toBe(2);
    expect(damageValueForType("heavy")).toBe(4);
  });

  it("effectiveDamageForCard scales by the delver's per-type rank", () => {
    const state = emptyArenaState();
    const claw = getEquipment("body-gauntlet-r1"); // light
    // R1 baseline (matches the printed R1 text).
    expect(effectiveDamageForCard(state, "hero-02", claw)).toBe(1);
    // Bump rank to 3 — should yield 3 x LIGHT = 3.
    state.equipmentRanks["hero-02"]!.Gauntlet = 3;
    expect(effectiveDamageForCard(state, "hero-02", claw)).toBe(3);
    // Cap at R5 — multiplier of 5 yields 5 x LIGHT = 5.
    state.equipmentRanks["hero-02"]!.Gauntlet = 5;
    expect(effectiveDamageForCard(state, "hero-02", claw)).toBe(5);
  });

  // Regression (player report 2026-07-20): an unbuffed R2 Anchor
  // Hammer dealt 8 damage — the engine multiplied by RANK instead of
  // the PRINTED multiplier. Per the card JPGs (both suits), Hammer
  // R2 prints plain "HEAVY damage" (only the 3-tile line + free
  // direction choice are new at R2); the multiplier ramp is offset
  // one rank: R3 = 2x, R4 = 3x, R5 = 4x. Trident has the same
  // offset. Damage must follow `rankedCard.damageMultiplier`.
  it("Hammer's printed multiplier is OFFSET from rank (R2 = 1x HEAVY = 4, not 8)", () => {
    const state = emptyArenaState();
    const hammer = getEquipment("body-hammer-r1"); // heavy, base 4
    state.equipmentRanks["hero-02"]!.Hammer = 2;
    expect(effectiveDamageForCard(state, "hero-02", hammer)).toBe(4); // 1 x 4
    state.equipmentRanks["hero-02"]!.Hammer = 3;
    expect(effectiveDamageForCard(state, "hero-02", hammer)).toBe(8); // 2 x 4
    state.equipmentRanks["hero-02"]!.Hammer = 5;
    expect(effectiveDamageForCard(state, "hero-02", hammer)).toBe(16); // 4 x 4
  });

  it("Trident's printed multiplier is OFFSET from rank (R2 = 1x MEDIUM = 2)", () => {
    const state = emptyArenaState();
    const trident = getEquipment("body-trident-r1"); // medium, base 2
    state.equipmentRanks["hero-02"]!.Trident = 2;
    expect(effectiveDamageForCard(state, "hero-02", trident)).toBe(2); // 1 x 2
    state.equipmentRanks["hero-02"]!.Trident = 3;
    expect(effectiveDamageForCard(state, "hero-02", trident)).toBe(4); // 2 x 2
  });

  it("data regression guard: Hammer/Trident R2-R5 print multiplier = rank - 1 (both suits)", () => {
    for (const suit of ["mind", "body"]) {
      for (const type of ["hammer", "trident"]) {
        for (let rank = 2; rank <= 5; rank++) {
          const card = getEquipment(`${suit}-${type}-r${rank}`);
          expect(card.damageMultiplier, card.id).toBe(rank - 1);
        }
      }
    }
  });
});

// --- Counter-attack die classification ----------------------------------

describe("counterAttackOutcomeForRoll", () => {
  it("classifies 1 as miss, 2-5 as common, 6 as uncommon", () => {
    expect(counterAttackOutcomeForRoll(1)).toBe("miss");
    for (let r = 2; r <= 5; r++) expect(counterAttackOutcomeForRoll(r)).toBe("common");
    expect(counterAttackOutcomeForRoll(6)).toBe("uncommon");
    // Sanity: thresholds reflect the COUNTER_ROLL constant.
    expect(COUNTER_ROLL.miss.max).toBe(1);
    expect(COUNTER_ROLL.uncommon.min).toBe(6);
  });
});

// --- computeWeaponHitTiles per kind -------------------------------------

describe("computeWeaponHitTiles: single-adjacent", () => {
  it("succeeds when chosen tile is 8-adjacent and has a live enemy", () => {
    const state = emptyArenaState();
    spawnCrystanid(state, 3, 2);
    const r = computeWeaponHitTiles({
      range: { kind: "single-adjacent" },
      attackerPos: { x: 2, y: 2 },
      otherDelverPos: null,
      encounter: state.encounter!,
      board: BOARD,
      chosenStartTile: { x: 3, y: 2 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tiles).toEqual([{ x: 3, y: 2 }]);
  });

  it("rejects when chosen tile is not adjacent", () => {
    const state = emptyArenaState();
    spawnCrystanid(state, 4, 4);
    const r = computeWeaponHitTiles({
      range: { kind: "single-adjacent" },
      attackerPos: { x: 0, y: 0 },
      otherDelverPos: null,
      encounter: state.encounter!,
      board: BOARD,
      chosenStartTile: { x: 4, y: 4 },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects when chosen tile has no live enemy", () => {
    const state = emptyArenaState();
    const r = computeWeaponHitTiles({
      range: { kind: "single-adjacent" },
      attackerPos: { x: 2, y: 2 },
      otherDelverPos: null,
      encounter: state.encounter!,
      board: BOARD,
      chosenStartTile: { x: 3, y: 2 },
    });
    expect(r.ok).toBe(false);
  });
});

describe("computeWeaponHitTiles: straight-line", () => {
  it("hits the FIRST live enemy along a cardinal ray", () => {
    const state = emptyArenaState();
    spawnCrystanid(state, 2, 0); // closer in the +y=0 row
    spawnCrystanid(state, 4, 0); // further along the same row
    const r = computeWeaponHitTiles({
      range: { kind: "straight-line", includeDiagonals: true, firstTargetOnly: true },
      attackerPos: { x: 0, y: 0 },
      otherDelverPos: null,
      encounter: state.encounter!,
      board: BOARD,
      chosenStartTile: { x: 4, y: 0 }, // user clicked the far one
    });
    expect(r.ok).toBe(true);
    // Engine substitutes the actually-first enemy in that direction.
    if (r.ok) expect(r.tiles).toEqual([{ x: 2, y: 0 }]);
  });

  it("rejects diagonals when includeDiagonals=false", () => {
    const state = emptyArenaState();
    spawnCrystanid(state, 2, 2);
    const r = computeWeaponHitTiles({
      range: { kind: "straight-line", includeDiagonals: false, firstTargetOnly: true },
      attackerPos: { x: 0, y: 0 },
      otherDelverPos: null,
      encounter: state.encounter!,
      board: BOARD,
      chosenStartTile: { x: 2, y: 2 },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects when no enemy lies in the chosen direction", () => {
    const state = emptyArenaState();
    const r = computeWeaponHitTiles({
      range: { kind: "straight-line", includeDiagonals: true, firstTargetOnly: true },
      attackerPos: { x: 0, y: 0 },
      otherDelverPos: null,
      encounter: state.encounter!,
      board: BOARD,
      chosenStartTile: { x: 4, y: 0 },
    });
    expect(r.ok).toBe(false);
  });
});

describe("computeWeaponHitTiles: die-roll-fixed (Crash Hammer W/E)", () => {
  const hammerRange = getEquipment("mind-hammer-r1").range!; // die-roll-fixed
  it("hits the WEST tile on rolls 1-3", () => {
    const state = emptyArenaState();
    for (const roll of [1, 2, 3]) {
      const r = computeWeaponHitTiles({
        range: hammerRange,
        attackerPos: { x: 2, y: 2 },
        otherDelverPos: null,
        encounter: state.encounter!,
        board: BOARD,
        dieRoll: roll,
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.tiles).toEqual([{ x: 1, y: 2 }]);
    }
  });

  it("hits the EAST tile on rolls 4-6", () => {
    const state = emptyArenaState();
    for (const roll of [4, 5, 6]) {
      const r = computeWeaponHitTiles({
        range: hammerRange,
        attackerPos: { x: 2, y: 2 },
        otherDelverPos: null,
        encounter: state.encounter!,
        board: BOARD,
        dieRoll: roll,
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.tiles).toEqual([{ x: 3, y: 2 }]);
    }
  });

  it("clips out-of-bounds offsets silently (e.g. WEST from column 0)", () => {
    const state = emptyArenaState();
    const r = computeWeaponHitTiles({
      range: hammerRange,
      attackerPos: { x: 0, y: 2 },
      otherDelverPos: null,
      encounter: state.encounter!,
      board: BOARD,
      dieRoll: 1, // would be (-1, 2) — clipped
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tiles).toEqual([]);
  });
});

describe("computeWeaponHitTiles: chain — self-adjacent variant (Chain Gauntlet)", () => {
  const chainRange = getEquipment("body-gauntlet-r1").range!; // chain, "self"

  it("BFS includes all 8-way connected enemies starting from chosen tile", () => {
    const state = emptyArenaState();
    // Cluster: (1,1), (2,1), (2,2). All 8-way connected. Plus an isolated (4,4).
    spawnCrystanid(state, 1, 1);
    spawnCrystanid(state, 2, 1);
    spawnCrystanid(state, 2, 2);
    spawnCrystanid(state, 4, 4);
    const r = computeWeaponHitTiles({
      range: chainRange,
      attackerPos: { x: 0, y: 0 }, // adjacent to (1,1) — self-precondition met
      otherDelverPos: { x: 4, y: 0 },
      encounter: state.encounter!,
      board: BOARD,
      chosenStartTile: { x: 1, y: 1 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const sorted = r.tiles.map((t) => `${t.x},${t.y}`).sort();
      expect(sorted).toEqual(["1,1", "2,1", "2,2"]);
    }
  });

  it("rejects when self-adjacent precondition fails (attacker not adjacent to any enemy in chain)", () => {
    const state = emptyArenaState();
    spawnCrystanid(state, 3, 3); // isolated enemy
    const r = computeWeaponHitTiles({
      range: chainRange,
      attackerPos: { x: 0, y: 0 }, // far from (3,3)
      otherDelverPos: { x: 3, y: 2 },
      encounter: state.encounter!,
      board: BOARD,
      chosenStartTile: { x: 3, y: 3 },
    });
    expect(r.ok).toBe(false);
  });
});

describe("computeWeaponHitTiles: chain — other-adjacent variant (Surge Claw)", () => {
  // No "other"-variant card ships in v1, so build a synthetic range to
  // exercise the precondition path.
  const otherChain: WeaponRange = { kind: "chain", requiresAdjacentTo: "other" };

  it("BFS succeeds when the OTHER delver anchors the chain (attacker may be far)", () => {
    const state = emptyArenaState();
    spawnCrystanid(state, 1, 1);
    spawnCrystanid(state, 2, 1);
    const r = computeWeaponHitTiles({
      range: otherChain,
      attackerPos: { x: 4, y: 4 }, // intentionally far from the chain
      otherDelverPos: { x: 0, y: 1 }, // adjacent to (1,1)
      encounter: state.encounter!,
      board: BOARD,
      chosenStartTile: { x: 1, y: 1 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const sorted = r.tiles.map((t) => `${t.x},${t.y}`).sort();
      expect(sorted).toEqual(["1,1", "2,1"]);
    }
  });

  it("rejects when other-delver-adjacent precondition fails", () => {
    const state = emptyArenaState();
    spawnCrystanid(state, 1, 1);
    const r = computeWeaponHitTiles({
      range: otherChain,
      attackerPos: { x: 0, y: 0 },
      otherDelverPos: { x: 4, y: 4 }, // far away
      encounter: state.encounter!,
      board: BOARD,
      chosenStartTile: { x: 1, y: 1 },
    });
    expect(r.ok).toBe(false);
  });
});

// --- Per-tile damage ----------------------------------------------------

describe("applyDamageAtTile", () => {
  it("reduces the enemy's HP and marks dead at >= card.hp", () => {
    const state = emptyArenaState();
    const enemy = spawnCrystanid(state, 2, 2); // HP 2
    const r1 = applyDamageAtTile(state, 2, 2, 1);
    expect(r1.enemy).toBe(enemy);
    expect(r1.killed).toBe(false);
    expect(enemy.damageTaken).toBe(1);
    expect(enemy.alive).toBe(true);
    const r2 = applyDamageAtTile(state, 2, 2, 1);
    expect(r2.killed).toBe(true);
    expect(enemy.alive).toBe(false);
  });

  it("returns null/no-kill on an empty tile", () => {
    const state = emptyArenaState();
    const r = applyDamageAtTile(state, 1, 1, 5);
    expect(r.enemy).toBeNull();
    expect(r.killed).toBe(false);
  });
});

// --- Counter-attack application ----------------------------------------

describe("applyCounter", () => {
  it("returns miss + no hits on a roll of 1", () => {
    const state = emptyArenaState();
    const enemy = spawnCrystanid(state, 2, 2);
    state.encounter!.delverPositions["hero-01"] = { x: 1, y: 2 }; // counter-uncommon (-1,0)
    const r = applyCounter(state, enemy, 1);
    expect(r.outcome).toBe("miss");
    expect(r.hits).toEqual([]);
  });

  it("applies common-pattern damage to delvers on offset tiles", () => {
    const state = emptyArenaState();
    const enemy = spawnCrystanid(state, 2, 2);
    // Crystanid common: (1,-1),(1,0),(1,1),(2,2),(-1,1),(-2,2),(-1,-1),(-2,-2)
    state.encounter!.delverPositions["hero-01"] = { x: 3, y: 2 }; // (+1,0) — common
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 0 }; // (-2,-2) — common
    const startHp1 = state.loadouts["hero-01"]!.currentHp;
    const startHp2 = state.loadouts["hero-02"]!.currentHp;
    const r = applyCounter(state, enemy, 3);
    expect(r.outcome).toBe("common");
    expect(r.hits).toHaveLength(2);
    const card = getEnemy("crystanid-001");
    expect(state.loadouts["hero-01"]!.currentHp).toBe(startHp1 - card.attack);
    expect(state.loadouts["hero-02"]!.currentHp).toBe(startHp2 - card.attack);
  });

  it("applies uncommon-pattern damage on a roll of 6", () => {
    const state = emptyArenaState();
    const enemy = spawnCrystanid(state, 2, 2);
    // Crystanid uncommon: (0,-1),(0,-2),(0,1),(0,2),(-1,0),(-2,0)
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 1 }; // (0,-1) — uncommon
    state.encounter!.delverPositions["hero-02"] = { x: 2, y: 2 }; // attacker tile, no offset hit
    const startHp1 = state.loadouts["hero-01"]!.currentHp;
    const startHp2 = state.loadouts["hero-02"]!.currentHp;
    const r = applyCounter(state, enemy, 6);
    expect(r.outcome).toBe("uncommon");
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.heroId).toBe("hero-01");
    expect(state.loadouts["hero-01"]!.currentHp).toBe(startHp1 - 1);
    expect(state.loadouts["hero-02"]!.currentHp).toBe(startHp2);
  });

  it("clamps delver HP to 0 (no negative HP)", () => {
    const state = emptyArenaState();
    const enemy = spawnCrystanid(state, 2, 2);
    state.encounter!.delverPositions["hero-01"] = { x: 3, y: 2 };
    state.loadouts["hero-01"]!.currentHp = 1;
    applyCounter(state, enemy, 3);
    expect(state.loadouts["hero-01"]!.currentHp).toBe(0);
  });

  // --- Facing-aware counter projection (Slip Strider Boots) -----------

  it("facing 90 (CW): the (+1,0) common offset rotates to (0,+1) — south", () => {
    // Crystanid common offsets include (+1, 0). Rotated 90° CW that
    // becomes (0, +1) — i.e. SOUTH of the enemy. So the same hero who
    // was previously hit by being EAST of the enemy is now hit by
    // being SOUTH of it.
    const state = emptyArenaState();
    const enemy = spawnCrystanid(state, 2, 2);
    enemy.facing = 90;
    // Park hero-01 SOUTH of the enemy. With facing 0 they wouldn't be
    // hit by (+1,0); with facing 90 they should be hit because that
    // offset has rotated to (0,+1) = south.
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 3 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 0 };
    const startHp = state.loadouts["hero-01"]!.currentHp;
    const r = applyCounter(state, enemy, 3);
    expect(r.outcome).toBe("common");
    expect(r.hits.some((h) => h.heroId === "hero-01")).toBe(true);
    expect(state.loadouts["hero-01"]!.currentHp).toBe(startHp - 1);
  });

  it("facing 90: a hero on the (+1,0) tile (east) is NO LONGER hit", () => {
    // Mirror of the above — east is no longer in the rotated pattern.
    const state = emptyArenaState();
    const enemy = spawnCrystanid(state, 2, 2);
    enemy.facing = 90;
    // (+1,0) was the original common-offset tile. After rotation it's
    // gone; the hero standing there should NOT be hit.
    state.encounter!.delverPositions["hero-01"] = { x: 3, y: 2 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 }; // out of pattern
    const startHp = state.loadouts["hero-01"]!.currentHp;
    const r = applyCounter(state, enemy, 3);
    // The east tile is not in the rotated common pattern, so hero-01
    // takes 0 damage. (Other rotated offsets might still hit hero-02
    // if it were in pattern; we parked them out of harm's way.)
    expect(r.hits.some((h) => h.heroId === "hero-01")).toBe(false);
    expect(state.loadouts["hero-01"]!.currentHp).toBe(startHp);
  });

  it("facing 180 mirrors the pattern (the original west-of-enemy tile is now east)", () => {
    // Crystanid uncommon includes (-1, 0). With facing 180 that
    // becomes (+1, 0) — i.e. east of the enemy. So a hero standing
    // EAST of the enemy gets hit by an uncommon counter under
    // facing 180.
    const state = emptyArenaState();
    const enemy = spawnCrystanid(state, 2, 2);
    enemy.facing = 180;
    state.encounter!.delverPositions["hero-01"] = { x: 3, y: 2 }; // east
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 }; // clear
    const startHp = state.loadouts["hero-01"]!.currentHp;
    const r = applyCounter(state, enemy, 6); // uncommon
    expect(r.outcome).toBe("uncommon");
    expect(r.hits.some((h) => h.heroId === "hero-01")).toBe(true);
    expect(state.loadouts["hero-01"]!.currentHp).toBe(startHp - 1);
  });

  it("facing 270 (CCW) is the inverse of 90: north hero hit by what was originally east", () => {
    // (+1,0) under facing 270 becomes (0,-1) — i.e. NORTH of the enemy.
    const state = emptyArenaState();
    const enemy = spawnCrystanid(state, 2, 2);
    enemy.facing = 270;
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 1 }; // north
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };
    const startHp = state.loadouts["hero-01"]!.currentHp;
    const r = applyCounter(state, enemy, 3);
    expect(r.outcome).toBe("common");
    expect(r.hits.some((h) => h.heroId === "hero-01")).toBe(true);
    expect(state.loadouts["hero-01"]!.currentHp).toBe(startHp - 1);
  });

  it("facing 0 (default) preserves the printed pattern (regression: no surprise rotation)", () => {
    // Smoke-test that the new facing field doesn't accidentally
    // shift the pattern when no rotation has happened. (+1,0) hero
    // east of enemy, facing 0 → still hit.
    const state = emptyArenaState();
    const enemy = spawnCrystanid(state, 2, 2);
    expect(enemy.facing).toBe(0);
    state.encounter!.delverPositions["hero-01"] = { x: 3, y: 2 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };
    const r = applyCounter(state, enemy, 3);
    expect(r.hits.some((h) => h.heroId === "hero-01")).toBe(true);
  });
});

// --- Session-based resolver ---------------------------------------------

describe("AttackSession lifecycle (shared counter — DESIGN.md §5.4)", () => {
  it("resolves a single hit + shared counter then finalizes once", () => {
    const state = emptyArenaState();
    const enemy = spawnCrystanid(state, 3, 2);
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    // Move hero-02 well clear of any counter pattern offsets.
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };

    const session = buildAttackSession({
      attackerId: "hero-01",
      source: { kind: "weapon", slotIdx: 0, cardId: "body-sword-r1" },
      damage: 2, // one-shot the Crystanid (HP 2)
      hitTiles: [{ x: 3, y: 2 }],
    });

    const phase = resolveAllDamage(state, session);
    expect(session.steps).toHaveLength(1);
    expect(session.steps[0]!.killed).toBe(true);
    // On-death side-effects are deferred to finalize so the dying enemy
    // remains visible during the shared counter-roll prompt — the body
    // is only cleared (and `applyKill`'s XP/drops/elements granted) once
    // the counter resolves and the session finalizes.
    expect(session.steps[0]!.killResult).toBeUndefined();
    expect(enemy.alive).toBe(true);
    expect(phase.damagedEnemies).toHaveLength(1);

    // Apply the shared counter with a miss roll.
    const after = resolveSharedCounter(state, session, 1);
    expect(after.outcome).toBe("miss");
    expect(after.hits).toEqual([]);
    expect(after.resolved).toBe(true);
    // Counter has resolved but enemy still hasn't been removed — that's
    // the finalize step's job (and is what lets the UI keep the body
    // highlighted for the entire counter-roll modal lifetime).
    expect(enemy.alive).toBe(true);
    expect(session.steps[0]!.killResult).toBeUndefined();

    // Finalize applies the deferred kill and is idempotent on re-call.
    const f1 = finalizeAttackSession(state, session);
    expect(enemy.alive).toBe(false);
    expect(session.steps[0]!.killResult).toBeDefined();
    const f2 = finalizeAttackSession(state, session);
    expect(f1.levelUps).toBe(f2.levelUps);
  });

  it("missed tiles produce a null-enemy step and contribute no damaged enemies", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 0, y: 0 };
    state.encounter!.delverPositions["hero-02"] = { x: 4, y: 4 };
    const session = buildAttackSession({
      attackerId: "hero-01",
      source: { kind: "weapon", slotIdx: 0, cardId: "mind-hammer-r1" },
      damage: 1,
      hitTiles: [{ x: 1, y: 1 }], // empty tile
    });
    const phase = resolveAllDamage(state, session);
    expect(session.steps[0]!.enemyInstanceId).toBeNull();
    expect(session.steps[0]!.damageApplied).toBe(0);
    expect(phase.damagedEnemies).toHaveLength(0);
    expect(phase.anyCanLand).toBe(false);
  });

  it("damages every hit tile in order; ALL kills happen before the shared counter", () => {
    const state = emptyArenaState();
    spawnCrystanid(state, 1, 1);
    spawnCrystanid(state, 2, 2);
    state.encounter!.delverPositions["hero-01"] = { x: 0, y: 0 };
    state.encounter!.delverPositions["hero-02"] = { x: 4, y: 4 };
    const session = buildAttackSession({
      attackerId: "hero-01",
      source: { kind: "weapon", slotIdx: 0, cardId: "body-gauntlet-r1" },
      damage: 2,
      hitTiles: [{ x: 1, y: 1 }, { x: 2, y: 2 }],
    });

    const phase = resolveAllDamage(state, session);
    expect(session.steps).toHaveLength(2);
    expect(session.steps[0]!.killed).toBe(true);
    expect(session.steps[1]!.killed).toBe(true);
    // Both damaged enemies remembered in the shared counter snapshot.
    expect(phase.damagedEnemies).toHaveLength(2);
  });

  it("ONE shared roll covers ALL damaged enemies' counter patterns simultaneously", () => {
    const state = emptyArenaState();
    // Two Crystanids — east and south of hero-01. Crystanid-001's
    // counterUncommon includes (-1,0) and (0,-1) — so an UNCOMMON
    // roll hits hero-01 from BOTH crystanids in one resolution.
    spawnCrystanid(state, 3, 2); // east  → uncommon offset (-1,0) lands on (2,2)
    spawnCrystanid(state, 2, 3); // south → uncommon offset (0,-1) lands on (2,2)
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };

    const session = buildAttackSession({
      attackerId: "hero-01",
      source: { kind: "weapon", slotIdx: 0, cardId: "body-gauntlet-r1" },
      damage: 1, // both survive after this single hit
      hitTiles: [{ x: 3, y: 2 }, { x: 2, y: 3 }],
    });

    const startHp = state.loadouts["hero-01"]!.currentHp;
    resolveAllDamage(state, session);
    const phase = resolveSharedCounter(state, session, 6); // uncommon
    expect(phase.outcome).toBe("uncommon");

    // Hero-01 took counter damage from BOTH enemies on the same roll.
    const heroHits = phase.hits.filter((h) => h.heroId === "hero-01");
    expect(heroHits.length).toBe(2);
    const hpDelta = startHp - state.loadouts["hero-01"]!.currentHp;
    expect(hpDelta).toBe(heroHits.reduce((sum, h) => sum + h.damage, 0));
  });

  it("auto-skip path: anyCanLand=false when no damaged-enemy pattern intersects any delver", () => {
    const state = emptyArenaState();
    // Park both delvers far from the enemy.
    state.encounter!.delverPositions["hero-01"] = { x: 0, y: 0 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };
    // Spawn a Crystanid in the corner of the board, far from delvers.
    spawnCrystanid(state, 4, 4);
    const session = buildAttackSession({
      attackerId: "hero-01",
      source: { kind: "slot", slotIdx: 0, element: "radiance" },
      damage: 1,
      hitTiles: [{ x: 4, y: 4 }],
    });
    const phase = resolveAllDamage(state, session);
    expect(phase.damagedEnemies).toHaveLength(1);
    expect(phase.anyCanLand).toBe(false);

    // Caller passes -1 to mark the prompt as skipped.
    const after = resolveSharedCounter(state, session, -1);
    expect(after.rolled).toBe(-1);
    expect(after.outcome).toBe("miss");
    expect(after.hits).toEqual([]);
    expect(after.resolved).toBe(true);
  });

  it("anyCanLand=true when the common OR uncommon offset would land on a delver", () => {
    const state = emptyArenaState();
    spawnCrystanid(state, 3, 2);
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };
    const session = buildAttackSession({
      attackerId: "hero-01",
      source: { kind: "weapon", slotIdx: 0, cardId: "body-sword-r1" },
      damage: 1,
      hitTiles: [{ x: 3, y: 2 }],
    });
    const phase = resolveAllDamage(state, session);
    expect(phase.anyCanLand).toBe(true);
  });

  it("resolveSharedCounter is idempotent (second call is a no-op)", () => {
    const state = emptyArenaState();
    spawnCrystanid(state, 3, 2);
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };
    const session = buildAttackSession({
      attackerId: "hero-01",
      source: { kind: "weapon", slotIdx: 0, cardId: "body-sword-r1" },
      damage: 1,
      hitTiles: [{ x: 3, y: 2 }],
    });
    resolveAllDamage(state, session);
    const first = resolveSharedCounter(state, session, 6);
    const startHp = state.loadouts["hero-01"]!.currentHp;
    const second = resolveSharedCounter(state, session, 1); // ignored
    expect(second).toBe(first);
    expect(state.loadouts["hero-01"]!.currentHp).toBe(startHp); // no extra damage
  });
});

// --- Sol / Lunar Shield (block-on-tile) ---------------------------------

/** Stage a counter session that:
 *   - spawns one Crystanid #001 at (0, 2). Its `counterCommon` includes
 *     (+1, 0), so on the common roll it strikes tile (1, 2) for
 *     `card.attack` damage.
 *   - parks both delvers at (1, 2) so the common counter offset hits
 *     them both.
 *   - registers the Crystanid as the lone "damaged enemy" of the
 *     session so the counter resolves regardless of whether the staging
 *     attack actually wounded it.
 *
 * Returns the prepared `session` + the per-delver pre-roll damage
 * forecast (always `card.attack` in the common branch). */
function stageCounterAt(state: CampaignState): { session: ReturnType<typeof buildAttackSession>; perHitDamage: number } {
  const enemy = spawnCrystanid(state, 0, 2);
  state.encounter!.delverPositions["hero-01"] = { x: 1, y: 2 };
  state.encounter!.delverPositions["hero-02"] = { x: 1, y: 2 };
  const session = buildAttackSession({
    attackerId: "hero-01",
    source: { kind: "weapon", slotIdx: 0, cardId: "body-sword-r1" },
    damage: 1,
    hitTiles: [{ x: 0, y: 2 }],
  });
  resolveAllDamage(state, session);
  const phase = session.sharedCounter!;
  if (!phase.damagedEnemies.some((d) => d.cardId === enemy.cardId)) {
    phase.damagedEnemies.push({
      cardId: enemy.cardId,
      x: enemy.x, y: enemy.y,
      instanceId: enemy.instanceId,
      facing: enemy.facing,
    });
  }
  const perHitDamage = getEnemy(enemy.cardId).attack;
  return { session, perHitDamage };
}

describe("findShieldOpportunities (Sol / Lunar Shield)", () => {
  it("returns empty when the bearer owns no Shield", () => {
    const state = emptyArenaState();
    const { session } = stageCounterAt(state);
    // Mind starts with Sol Shield; clear it so neither delver owns one.
    state.equipmentRanks["hero-01"]!.Shield = 0;
    state.equipmentRanks["hero-02"]!.Shield = 0;
    const ops = findShieldOpportunities(state, session.sharedCounter!.damagedEnemies, "common");
    expect(ops).toEqual([]);
  });

  it("returns empty when the bearer's element bag is empty", () => {
    const state = emptyArenaState();
    const { session } = stageCounterAt(state);
    state.elements["hero-01"] = {};
    state.elements["hero-02"] = {};
    const ops = findShieldOpportunities(state, session.sharedCounter!.damagedEnemies, "common");
    expect(ops).toEqual([]);
  });

  it("returns one opportunity per shielded delver-on-tile-with-damage", () => {
    const state = emptyArenaState();
    const { session } = stageCounterAt(state);
    state.elements["hero-01"] = { earth: 1, radiance: 1 };
    const ops = findShieldOpportunities(state, session.sharedCounter!.damagedEnemies, "common");
    expect(ops).toHaveLength(1);
    const op = ops[0]!;
    expect(op.shieldBearerHeroId).toBe("hero-01");
    expect(op.shieldCardId).toBe("mind-shield-r1");
    expect(op.bonusElement).toBe("radiance");
    expect(op.baseBlock).toBe(1);
    expect(op.bonusBlock).toBe(2);
    expect(op.healPerOverblock).toBe(1);
    expect(op.availableElements.sort()).toEqual(["earth", "radiance"]);
    // Both delvers on tile (1,2) take perHitDamage from this counter.
    expect(op.protectedDelvers.map((d) => d.heroId).sort()).toEqual(["hero-01", "hero-02"]);
    // Single counterattacker hits this tile, so cap = 1 activation.
    expect(op.maxActivations).toBe(1);
  });

  it("returns empty on `miss` outcome", () => {
    const state = emptyArenaState();
    const { session } = stageCounterAt(state);
    state.elements["hero-01"] = { earth: 1 };
    expect(findShieldOpportunities(state, session.sharedCounter!.damagedEnemies, "miss")).toEqual([]);
  });

  // Rank scaling (2026-07-22, "all equipment fully authored through
  // all ranks" pass): Shield prints block = rank / bonus = rank + 1.
  // Pre-fix `shieldCardIdForHero` hard-returned the R1 id so R2-R5
  // shields blocked 1/2 forever.
  it("resolves the RANK-CORRECT shield card (R3 Sol Shield blocks 3, bonus 4)", () => {
    const state = emptyArenaState();
    const { session } = stageCounterAt(state);
    state.equipmentRanks["hero-01"]!.Shield = 3;
    state.elements["hero-01"] = { earth: 1 };
    const ops = findShieldOpportunities(state, session.sharedCounter!.damagedEnemies, "common");
    expect(ops).toHaveLength(1);
    expect(ops[0]!.shieldCardId).toBe("mind-shield-r3");
    expect(ops[0]!.baseBlock).toBe(3);
    expect(ops[0]!.bonusBlock).toBe(4);
  });
});

describe("applyCounterDamageWithShieldChoices (Sol / Lunar Shield)", () => {
  it("user scenario: 1 enemy hits both tile-mates for 1 each, Mind spends 1 earth, both block 1, no overblock heal", () => {
    const state = emptyArenaState();
    const { session, perHitDamage } = stageCounterAt(state);
    expect(perHitDamage).toBe(1); // sanity (Crystanid #001 attack = 1)
    state.elements["hero-01"] = { earth: 1 };
    // Pre-set HP so we can read deltas cleanly.
    state.loadouts["hero-01"]!.currentHp = 4;
    state.loadouts["hero-02"]!.currentHp = 5;

    const phase = applyCounterDamageWithShieldChoices(state, session, 3 /* common */, {
      "hero-01": { kind: "spend", elements: ["earth"] },
    });

    expect(phase.outcome).toBe("common");
    expect(state.loadouts["hero-01"]!.currentHp).toBe(4); // blocked
    expect(state.loadouts["hero-02"]!.currentHp).toBe(5); // tile-mate blocked too
    expect(state.elements["hero-01"]!.earth).toBe(0);
    expect(phase.hits).toEqual([]); // no damage actually applied
  });

  it("spending bonus element on a single damaged delver overblocks and heals the bearer", () => {
    const state = emptyArenaState();
    const { session, perHitDamage } = stageCounterAt(state);
    // Park the body delver off-tile so only the Mind bearer is hit.
    state.encounter!.delverPositions["hero-02"] = { x: 4, y: 4 };
    state.elements["hero-01"] = { radiance: 1 };
    state.loadouts["hero-01"]!.currentHp = 4;
    const startMaxHp = state.loadouts["hero-01"]!.maxHp;

    applyCounterDamageWithShieldChoices(state, session, 3 /* common */, {
      "hero-01": { kind: "spend", elements: ["radiance"] },
    });

    // perHitDamage incoming, 2 blocked, 1 overblock -> heal 1 to bearer.
    expect(state.loadouts["hero-01"]!.currentHp).toBe(Math.min(startMaxHp, 4 + (2 - perHitDamage)));
    expect(state.elements["hero-01"]!.radiance).toBe(0);
  });

  it("overblock heal is clamped at maxHp (no overheal)", () => {
    const state = emptyArenaState();
    const { session } = stageCounterAt(state);
    state.encounter!.delverPositions["hero-02"] = { x: 4, y: 4 };
    state.elements["hero-01"] = { radiance: 1 };
    // Bearer already at full HP -> heal should be clamped.
    state.loadouts["hero-01"]!.currentHp = state.loadouts["hero-01"]!.maxHp;

    applyCounterDamageWithShieldChoices(state, session, 3 /* common */, {
      "hero-01": { kind: "spend", elements: ["radiance"] },
    });

    expect(state.loadouts["hero-01"]!.currentHp).toBe(state.loadouts["hero-01"]!.maxHp);
  });

  it("skip choice leaves HP loss + element bag unchanged", () => {
    const state = emptyArenaState();
    const { session, perHitDamage } = stageCounterAt(state);
    state.elements["hero-01"] = { earth: 1 };
    const startMind = state.loadouts["hero-01"]!.currentHp;
    const startBody = state.loadouts["hero-02"]!.currentHp;

    applyCounterDamageWithShieldChoices(state, session, 3 /* common */, {
      "hero-01": { kind: "skip" },
    });

    expect(state.loadouts["hero-01"]!.currentHp).toBe(startMind - perHitDamage);
    expect(state.loadouts["hero-02"]!.currentHp).toBe(startBody - perHitDamage);
    expect(state.elements["hero-01"]!.earth).toBe(1); // not spent
  });

  it("`miss` outcome applies no damage even with shield choices supplied", () => {
    const state = emptyArenaState();
    const { session } = stageCounterAt(state);
    state.elements["hero-01"] = { earth: 1 };
    const startMind = state.loadouts["hero-01"]!.currentHp;

    applyCounterDamageWithShieldChoices(state, session, 1 /* miss */, {
      "hero-01": { kind: "spend", elements: ["earth"] },
    });

    expect(state.loadouts["hero-01"]!.currentHp).toBe(startMind);
    expect(state.elements["hero-01"]!.earth).toBe(1); // engine should NOT spend on miss
  });

  it("Body delver's Lunar Shield bonus element is `void` (not radiance)", () => {
    const state = emptyArenaState();
    const { session, perHitDamage } = stageCounterAt(state);
    state.encounter!.delverPositions["hero-01"] = { x: 4, y: 4 };
    state.equipmentRanks["hero-02"]!.Shield = 1; // grant Body the Lunar Shield
    state.elements["hero-02"] = { void: 1 };
    state.loadouts["hero-02"]!.currentHp = 4;

    const ops = findShieldOpportunities(state, session.sharedCounter!.damagedEnemies, "common");
    expect(ops).toHaveLength(1);
    expect(ops[0]!.shieldCardId).toBe("body-shield-r1");
    expect(ops[0]!.bonusElement).toBe("void");

    applyCounterDamageWithShieldChoices(state, session, 3 /* common */, {
      "hero-02": { kind: "spend", elements: ["void"] },
    });
    // 2 blocked, perHitDamage incoming -> no damage taken; overblock heal.
    expect(state.loadouts["hero-02"]!.currentHp).toBeGreaterThanOrEqual(4);
    expect(state.elements["hero-02"]!.void).toBe(0);
  });
});

// --- Multi-spend (post-2026-05-25) --------------------------------------
//
// User-reported intent: "the player should be able to use the shield any
// number of times at once, so long as they have the elements to spend on
// each activation. so if they get hit by two different counterattacks
// and have 2+ elements, they should be able to block damage from both
// counterattacks by spending 2 elements." These tests pin the new
// `ShieldChoice.elements: Element[]` semantics — one shield activation
// per array entry, applied in order, each contributing baseBlock /
// bonusBlock to every damaged tile-mate (and feeding overblock-heal
// when the bonusElement is one of the spends).

/**
 * Stage TWO Crystanid #001's whose `counterCommon` patterns BOTH
 * happen to land on tile (1, 2):
 *   - Crystanid at (0, 2) — offset (+1, 0)  → (1, 2)
 *   - Crystanid at (0, 1) — offset (+1, +1) → (1, 2)
 * Both delvers parked on (1, 2) so each takes 1 damage from each
 * counterattacker, totalling 2 damage per delver. Returns the staged
 * session.
 */
function stageTwoCounterattackersAt(state: CampaignState): {
  session: ReturnType<typeof buildAttackSession>;
  perDelverDamage: number;
} {
  const a = spawnCrystanid(state, 0, 2, "a");
  const b = spawnCrystanid(state, 0, 1, "b");
  state.encounter!.delverPositions["hero-01"] = { x: 1, y: 2 };
  state.encounter!.delverPositions["hero-02"] = { x: 1, y: 2 };
  const session = buildAttackSession({
    attackerId: "hero-01",
    source: { kind: "weapon", slotIdx: 0, cardId: "body-sword-r1" },
    damage: 1,
    hitTiles: [{ x: 0, y: 2 }],
  });
  resolveAllDamage(state, session);
  const phase = session.sharedCounter!;
  // Make sure both counterattackers land in the damaged-enemies list
  // (the staging swing only damaged ONE of them; the second has to be
  // pushed in for the counter resolution to consider it).
  for (const e of [a, b]) {
    if (!phase.damagedEnemies.some((d) => d.instanceId === e.instanceId)) {
      phase.damagedEnemies.push({
        cardId: e.cardId,
        x: e.x, y: e.y,
        instanceId: e.instanceId,
        facing: e.facing,
      });
    }
  }
  // Crystanid attack = 1; both counterattackers hit (1, 2) → 2 damage
  // per delver. Sanity-checked separately in test bodies via
  // `previewCounterHitsByDelver`.
  return { session, perDelverDamage: getEnemy(a.cardId).attack * 2 };
}

describe("applyCounterDamageWithShieldChoices — multi-spend", () => {
  it("user scenario: 2 counterattackers (2 dmg each delver), Mind spends 2 base elements, both delvers fully blocked", () => {
    const state = emptyArenaState();
    const { session, perDelverDamage } = stageTwoCounterattackersAt(state);
    expect(perDelverDamage).toBe(2); // sanity
    state.elements["hero-01"] = { earth: 2 };
    const startMind = state.loadouts["hero-01"]!.currentHp;
    const startBody = state.loadouts["hero-02"]!.currentHp;

    applyCounterDamageWithShieldChoices(state, session, 3 /* common */, {
      "hero-01": { kind: "spend", elements: ["earth", "earth"] },
    });

    // 2 spends × baseBlock=1 each = 2 blocked per tile-mate; both
    // delvers fully covered.
    expect(state.loadouts["hero-01"]!.currentHp).toBe(startMind);
    expect(state.loadouts["hero-02"]!.currentHp).toBe(startBody);
    expect(state.elements["hero-01"]!.earth).toBe(0);
  });

  it("legacy single-spend on 2-counterattacker scenario: only 1 damage blocked; bearer + tile-mate each take 1", () => {
    const state = emptyArenaState();
    const { session } = stageTwoCounterattackersAt(state);
    state.elements["hero-01"] = { earth: 2 };
    const startMind = state.loadouts["hero-01"]!.currentHp;
    const startBody = state.loadouts["hero-02"]!.currentHp;

    applyCounterDamageWithShieldChoices(state, session, 3 /* common */, {
      "hero-01": { kind: "spend", elements: ["earth"] },
    });

    expect(state.loadouts["hero-01"]!.currentHp).toBe(startMind - 1);
    expect(state.loadouts["hero-02"]!.currentHp).toBe(startBody - 1);
    expect(state.elements["hero-01"]!.earth).toBe(1); // only 1 spent
  });

  it("mixed spend (bonus + base) blocks the bonus amount first then the base, summing per tile-mate", () => {
    const state = emptyArenaState();
    const { session } = stageTwoCounterattackersAt(state);
    // 2 damage per delver. Bonus radiance blocks 2 → fully covers
    // each delver in one swing; base earth would then fire on 0
    // damage and contribute 0 overblock-heal (per the "skip 0-damage
    // tile-mates" rule).
    state.elements["hero-01"] = { radiance: 1, earth: 1 };
    state.loadouts["hero-01"]!.currentHp = 4;
    const startBody = state.loadouts["hero-02"]!.currentHp;

    applyCounterDamageWithShieldChoices(state, session, 3 /* common */, {
      "hero-01": { kind: "spend", elements: ["radiance", "earth"] },
    });

    // Both bagged — radiance alone fully blocks both delvers.
    expect(state.loadouts["hero-01"]!.currentHp).toBe(4); // no heal: zero overblock
    expect(state.loadouts["hero-02"]!.currentHp).toBe(startBody);
    expect(state.elements["hero-01"]!.radiance).toBe(0);
    // Earth WAS spent (the engine processes every entry in `elements`
    // in order — multi-spend is the player's promise to commit them).
    // The 2nd activation just had nothing to block.
    expect(state.elements["hero-01"]!.earth).toBe(0);
  });

  it("empty `elements: []` array is a no-op (semantically identical to skip)", () => {
    const state = emptyArenaState();
    const { session, perHitDamage } = stageCounterAt(state);
    state.elements["hero-01"] = { earth: 1 };
    const startMind = state.loadouts["hero-01"]!.currentHp;
    const startBody = state.loadouts["hero-02"]!.currentHp;

    applyCounterDamageWithShieldChoices(state, session, 3 /* common */, {
      "hero-01": { kind: "spend", elements: [] },
    });

    expect(state.loadouts["hero-01"]!.currentHp).toBe(startMind - perHitDamage);
    expect(state.loadouts["hero-02"]!.currentHp).toBe(startBody - perHitDamage);
    expect(state.elements["hero-01"]!.earth).toBe(1); // not spent
  });

  it("supplying more elements than maxActivations is silently truncated (rulebook cap)", () => {
    const state = emptyArenaState();
    const { session } = stageTwoCounterattackersAt(state);
    // 2 counterattackers → cap = 2. The player smuggles in 3 spend
    // entries (e.g. via a stale modal). The engine truncates to the
    // cap: 2 elements spent, 1 stays in the bag.
    state.elements["hero-01"] = { earth: 3 };
    state.loadouts["hero-01"]!.currentHp = 5;
    const startMaxHp = state.loadouts["hero-01"]!.maxHp;
    const startBody = state.loadouts["hero-02"]!.currentHp;

    applyCounterDamageWithShieldChoices(state, session, 3 /* common */, {
      "hero-01": { kind: "spend", elements: ["earth", "earth", "earth"] },
    });

    // Both tile-mates at 0 damage after 2 activations; no heal-pump
    // from the truncated 3rd spend.
    expect(state.loadouts["hero-01"]!.currentHp).toBe(Math.min(startMaxHp, 5));
    expect(state.loadouts["hero-02"]!.currentHp).toBe(startBody);
    expect(state.elements["hero-01"]!.earth).toBe(1); // only 2 spent (cap)
  });

  it("skip choice + multi-spend on the SAME bearer is impossible: skip wins (kind discriminator)", () => {
    // Sanity guard for the type — `kind: "skip"` and `kind: "spend"`
    // are mutually exclusive. The engine respects the discriminator
    // (skip → no spend, no block) regardless of whatever fields a
    // type-asserted caller might smuggle alongside.
    const state = emptyArenaState();
    const { session, perHitDamage } = stageCounterAt(state);
    state.elements["hero-01"] = { earth: 2 };
    const startMind = state.loadouts["hero-01"]!.currentHp;

    applyCounterDamageWithShieldChoices(state, session, 3 /* common */, {
      "hero-01": { kind: "skip" },
    });

    expect(state.loadouts["hero-01"]!.currentHp).toBe(startMind - perHitDamage);
    expect(state.elements["hero-01"]!.earth).toBe(2); // nothing spent
  });
});

// --- maxActivations cap (rulebook "1 shield per enemy counterattack")
//
// Pin the per-counterattacker cap exposed via
// `ShieldOpportunity.maxActivations` and enforced (via truncation) by
// `applyCounterDamageWithShieldChoices`. Cap = distinct enemies whose
// counter offsets land on the bearer's tile with non-zero post-block
// effective attack.

describe("ShieldOpportunity.maxActivations (per-counterattacker cap)", () => {
  it("single counterattacker → cap = 1; a 2nd element supplied is silently truncated", () => {
    const state = emptyArenaState();
    const { session, perHitDamage } = stageCounterAt(state);
    state.elements["hero-01"] = { earth: 2 };
    const startMind = state.loadouts["hero-01"]!.currentHp;
    const startBody = state.loadouts["hero-02"]!.currentHp;

    const ops = findShieldOpportunities(state, session.sharedCounter!.damagedEnemies, "common");
    expect(ops).toHaveLength(1);
    expect(ops[0]!.maxActivations).toBe(1);

    applyCounterDamageWithShieldChoices(state, session, 3 /* common */, {
      "hero-01": { kind: "spend", elements: ["earth", "earth"] },
    });

    // 1 spend applied (cap), tile-mate took (perHitDamage - 1) of damage.
    expect(state.loadouts["hero-01"]!.currentHp).toBe(startMind - Math.max(0, perHitDamage - 1));
    expect(state.loadouts["hero-02"]!.currentHp).toBe(startBody - Math.max(0, perHitDamage - 1));
    expect(state.elements["hero-01"]!.earth).toBe(1); // 2nd element NOT spent
  });

  it("two counterattackers hitting the same tile → cap = 2", () => {
    const state = emptyArenaState();
    const { session } = stageTwoCounterattackersAt(state);
    state.elements["hero-01"] = { earth: 5 };

    const ops = findShieldOpportunities(state, session.sharedCounter!.damagedEnemies, "common");
    expect(ops).toHaveLength(1);
    expect(ops[0]!.maxActivations).toBe(2);
  });

  it("two counterattackers + 5 elements supplied → cap truncates spends to 2", () => {
    const state = emptyArenaState();
    const { session } = stageTwoCounterattackersAt(state);
    state.elements["hero-01"] = { earth: 5 };

    applyCounterDamageWithShieldChoices(state, session, 3 /* common */, {
      "hero-01": { kind: "spend", elements: ["earth", "earth", "earth", "earth", "earth"] },
    });

    // Cap = 2 → exactly 2 elements spent; 3 remain in the bag.
    expect(state.elements["hero-01"]!.earth).toBe(3);
  });

  it("weapon-counter-block reducing an enemy to 0 attack drops it from the cap", () => {
    // 2 enemies in `damagedEnemies`, but Trident block silences one
    // of them entirely (effectiveAttack = max(0, 1 - 1) = 0). That
    // counterattacker no longer counts toward the shield cap because
    // the bearer takes no damage from it. Cap drops to 1.
    const state = emptyArenaState();
    const { session } = stageTwoCounterattackersAt(state);
    state.elements["hero-01"] = { earth: 2 }; // bearer needs elements for opportunity
    const phase = session.sharedCounter!;
    const blockedId = phase.damagedEnemies[0]!.instanceId;
    const blockMap = new Map<string, number>([[blockedId, 1]]); // 1 attack reduction

    const ops = findShieldOpportunities(
      state, phase.damagedEnemies, "common", blockMap,
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]!.maxActivations).toBe(1); // 2 → 1 after weapon block
  });

  it("counter outcome `miss` → no opportunities at all (cap doesn't even surface)", () => {
    const state = emptyArenaState();
    const { session } = stageTwoCounterattackersAt(state);
    state.elements["hero-01"] = { earth: 2 };
    const ops = findShieldOpportunities(state, session.sharedCounter!.damagedEnemies, "miss");
    expect(ops).toEqual([]);
  });
});

// --- Rotates ability (Q2 W2 enemies) -------------------------------------

describe("Rotates ability (Q2 W2 Ophidian + Hundredeyes)", () => {
  /** Spawn an Ophidian (HP 6, Rotates) at (x,y) facing 0°. */
  function spawnOphidian(state: CampaignState, x: number, y: number, cardId = "ophidian-015"): EnemyInstance {
    const e: EnemyInstance = {
      instanceId: `o-${x}-${y}`,
      cardId,
      x, y,
      damageTaken: 0,
      alive: true,
      facing: 0,
    };
    state.encounter!.enemies.push(e);
    return e;
  }

  it("rotates 90° CW after the shared counter when the enemy survives", () => {
    const state = emptyArenaState();
    const enemy = spawnOphidian(state, 3, 2);
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };

    expect(enemy.facing).toBe(0);
    const session = buildAttackSession({
      attackerId: "hero-01",
      source: { kind: "weapon", slotIdx: 0, cardId: "body-sword-r1" },
      damage: 2, // Ophidian HP 6 -> survives
      hitTiles: [{ x: 3, y: 2 }],
    });
    resolveAllDamage(state, session);
    expect(enemy.damageTaken).toBe(2);
    expect(enemy.alive).toBe(true);

    resolveSharedCounter(state, session, 1); // any roll — Rotates fires regardless
    // 0° + 90° (CW) = 90°.
    expect(enemy.facing).toBe(90);
  });

  it("does NOT rotate a dying enemy (HP fully consumed)", () => {
    // Narrative: "after attempting to counterattack" — dead bodies don't
    // re-aim. The engine guards on damageTaken < hp.
    const state = emptyArenaState();
    const enemy = spawnOphidian(state, 3, 2);
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };

    const session = buildAttackSession({
      attackerId: "hero-01",
      source: { kind: "weapon", slotIdx: 0, cardId: "body-gauntlet-r1" },
      damage: 6, // exactly fatal
      hitTiles: [{ x: 3, y: 2 }],
    });
    resolveAllDamage(state, session);
    expect(enemy.damageTaken).toBe(6);
    // Body remains visible during counter-roll modal.
    expect(enemy.alive).toBe(true);

    resolveSharedCounter(state, session, 1);
    expect(enemy.facing).toBe(0); // unchanged — corpse doesn't rotate
  });

  it("wraps 270° → 0° on the next rotation", () => {
    const state = emptyArenaState();
    const enemy = spawnOphidian(state, 3, 2);
    enemy.facing = 270;
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };

    const session = buildAttackSession({
      attackerId: "hero-01",
      source: { kind: "weapon", slotIdx: 0, cardId: "body-sword-r1" },
      damage: 1,
      hitTiles: [{ x: 3, y: 2 }],
    });
    resolveAllDamage(state, session);
    resolveSharedCounter(state, session, 1);
    expect(enemy.facing).toBe(0);
  });

  it("does not rotate Crystanid (no Rotates ability)", () => {
    const state = emptyArenaState();
    const c = spawnCrystanid(state, 3, 2);
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };
    const session = buildAttackSession({
      attackerId: "hero-01",
      source: { kind: "weapon", slotIdx: 0, cardId: "body-gauntlet-r1" },
      damage: 1, // Crystanid HP 2 -> survives
      hitTiles: [{ x: 3, y: 2 }],
    });
    resolveAllDamage(state, session);
    resolveSharedCounter(state, session, 1);
    expect(c.facing).toBe(0);
  });

  it("rotates multiple Rotates enemies independently in a single shared counter", () => {
    const state = emptyArenaState();
    const a = spawnOphidian(state, 3, 2);
    a.instanceId = "ophA";
    const b = spawnOphidian(state, 2, 3);
    b.instanceId = "ophB";
    b.facing = 180;
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };

    const session = buildAttackSession({
      attackerId: "hero-01",
      source: { kind: "weapon", slotIdx: 0, cardId: "body-gauntlet-r1" },
      damage: 1, // both survive
      hitTiles: [{ x: 3, y: 2 }, { x: 2, y: 3 }],
    });
    resolveAllDamage(state, session);
    resolveSharedCounter(state, session, 1);
    expect(a.facing).toBe(90);
    expect(b.facing).toBe(270);
  });

  // Regression: prior to 2026-05-23, rotation only fired through
  // `resolveSharedCounter`. Trident / Shockwave (weapon-counter-
  // block) and shield activations route through
  // `applyCounterDamageWithShieldChoices` instead, which silently
  // skipped Rotates / Teleports. Reported in-game: hitting an
  // Ophidian with Golden Trident never rotated its facing.
  it("rotates 90° CW when counter is resolved via applyCounterDamageWithShieldChoices (Trident path)", () => {
    const state = emptyArenaState();
    const enemy = spawnOphidian(state, 3, 2);
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };

    expect(enemy.facing).toBe(0);
    const session = buildAttackSession({
      attackerId: "hero-01",
      source: { kind: "weapon", slotIdx: 2, cardId: "mind-trident-r1" },
      damage: 2, // Ophidian HP 6 -> survives
      hitTiles: [{ x: 3, y: 2 }],
    });
    resolveAllDamage(state, session);
    expect(enemy.alive).toBe(true);

    applyCounterDamageWithShieldChoices(state, session, 3 /* common */, {});
    expect(enemy.facing).toBe(90);
  });

  it("rotates 90° CW even on a missed counter routed through applyCounterDamageWithShieldChoices", () => {
    const state = emptyArenaState();
    const enemy = spawnOphidian(state, 3, 2);
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };

    const session = buildAttackSession({
      attackerId: "hero-01",
      source: { kind: "weapon", slotIdx: 2, cardId: "mind-trident-r1" },
      damage: 1,
      hitTiles: [{ x: 3, y: 2 }],
    });
    resolveAllDamage(state, session);

    applyCounterDamageWithShieldChoices(state, session, 1 /* miss */, {});
    expect(enemy.facing).toBe(90);
  });
});

// --- Primordial ability (Q2 W3 Sporecloud) ------------------------------

describe("Primordial ability (Q2 W3 Sporecloud)", () => {
  /**
   * Spawn a Sporecloud at (x,y). Defaults to `sporecloud-022`
   * (Primordial: water, fire). Slot index ↔ element map for
   * BOTH suits (from `data/delverBoards.json`):
   *   slot 0 = radiance, slot 1 = void, slot 2 = earth,
   *   slot 3 = fire,     slot 4 = wind, slot 5 = water.
   */
  function spawnSporecloud(state: CampaignState, x: number, y: number, cardId = "sporecloud-022"): EnemyInstance {
    const e: EnemyInstance = {
      instanceId: `sc-${x}-${y}`,
      cardId,
      x, y,
      damageTaken: 0,
      alive: true,
      facing: 0,
    };
    state.encounter!.enemies.push(e);
    return e;
  }

  it("blocks ALL damage when slot element is not in Primordial whitelist", () => {
    const state = emptyArenaState();
    const sc = spawnSporecloud(state, 3, 2); // water + fire
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };
    // hero-01 (mind) slot 0 = radiance — NOT in {water, fire}.
    const session = buildAttackSession({
      attackerId: "hero-01",
      source: { kind: "weapon", slotIdx: 0, cardId: "mind-beam-r1" },
      damage: 5,
      hitTiles: [{ x: 3, y: 2 }],
    });
    resolveAllDamage(state, session);
    expect(sc.damageTaken).toBe(0);
    expect(session.steps[0]!.damageApplied).toBe(0);
    expect(session.steps[0]!.killed).toBe(false);
  });

  it("allows full damage when slot element matches a Primordial entry", () => {
    const state = emptyArenaState();
    const sc = spawnSporecloud(state, 3, 2); // water + fire
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };
    // hero-01 (mind) slot 3 = fire — IN {water, fire}.
    const session = buildAttackSession({
      attackerId: "hero-01",
      source: { kind: "weapon", slotIdx: 3, cardId: "mind-hammer-r1" },
      damage: 4,
      hitTiles: [{ x: 3, y: 2 }],
    });
    resolveAllDamage(state, session);
    expect(sc.damageTaken).toBe(4);
    expect(session.steps[0]!.damageApplied).toBe(4);
  });

  it("allows damage from EITHER of the two Primordial elements", () => {
    const state = emptyArenaState();
    const sc = spawnSporecloud(state, 3, 2); // water + fire
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };
    // hero-02 (body) slot 5 = water — the OTHER allowed slot.
    const session = buildAttackSession({
      attackerId: "hero-02",
      source: { kind: "weapon", slotIdx: 5, cardId: "body-sword-r1" },
      damage: 3,
      hitTiles: [{ x: 3, y: 2 }],
    });
    resolveAllDamage(state, session);
    expect(sc.damageTaken).toBe(3);
  });

  it("blocks all four non-matching slots on Sporecloud 022", () => {
    // Defensive: cycle through every NON-matching slot on the
    // mind board to make sure the gate isn't off-by-one.
    for (const slotIdx of [0, 1, 2, 4]) { // radiance, void, earth, wind
      const state = emptyArenaState();
      const sc = spawnSporecloud(state, 3, 2); // water + fire
      state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
      state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };
      const session = buildAttackSession({
        attackerId: "hero-01",
        source: { kind: "slot", slotIdx, element: "radiance" /* not used by gate */ },
        damage: 10,
        hitTiles: [{ x: 3, y: 2 }],
      });
      resolveAllDamage(state, session);
      expect(sc.damageTaken, `mind slot ${slotIdx} should be blocked`).toBe(0);
    }
  });

  it("non-Primordial enemies (Crystanid) are unaffected by the gate", () => {
    // Regression: Q1 + Q2 W1/W2 enemies must take damage from
    // ANY slot regardless of element binding.
    const state = emptyArenaState();
    const c = spawnCrystanid(state, 3, 2);
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };
    const session = buildAttackSession({
      attackerId: "hero-01",
      source: { kind: "weapon", slotIdx: 0, cardId: "mind-beam-r1" }, // radiance slot
      damage: 2,
      hitTiles: [{ x: 3, y: 2 }],
    });
    resolveAllDamage(state, session);
    expect(c.damageTaken).toBe(2);
  });

  it("counter still fires after a Primordial-blocked strike (snapshot pushed regardless)", () => {
    // The strike WAS attempted (weapon exhausted, swing
    // resolved), it just didn't connect. Counter should still
    // fire — same precedent as Fatal Flaw blocked attacks.
    const state = emptyArenaState();
    const sc = spawnSporecloud(state, 3, 2); // water + fire
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };
    const session = buildAttackSession({
      attackerId: "hero-01",
      source: { kind: "weapon", slotIdx: 0, cardId: "mind-beam-r1" }, // blocked
      damage: 5,
      hitTiles: [{ x: 3, y: 2 }],
    });
    const phase = resolveAllDamage(state, session);
    expect(sc.damageTaken).toBe(0);
    // Snapshot pushed so the counter still has someone to roll for.
    expect(phase.damagedEnemies).toHaveLength(1);
  });
});

// --- Teleports ability (Q2 W3 Death Cap) --------------------------------

describe("Teleports ability (Q2 W3 Death Cap)", () => {
  /** Spawn a Death Cap at (x,y). Boss: 50 HP, 3 ATK, Teleports. */
  function spawnDeathCap(state: CampaignState, x: number, y: number): EnemyInstance {
    const e: EnemyInstance = {
      instanceId: `dc-${x}-${y}`,
      cardId: "deathcap-004",
      x, y,
      damageTaken: 0,
      alive: true,
      facing: 0,
    };
    state.encounter!.enemies.push(e);
    return e;
  }
  /** Spawn a Sporecloud minion at (x,y). */
  function spawnSpore(state: CampaignState, x: number, y: number, suffix = ""): EnemyInstance {
    const e: EnemyInstance = {
      instanceId: `sp-${x}-${y}-${suffix}`,
      cardId: "sporecloud-022",
      x, y,
      damageTaken: 0,
      alive: true,
      facing: 0,
    };
    state.encounter!.enemies.push(e);
    return e;
  }

  it("swaps Death Cap with the nearest living enemy after a survived counter", () => {
    const state = emptyArenaState();
    const dc = spawnDeathCap(state, 2, 2);
    const spore = spawnSpore(state, 4, 4);
    state.encounter!.delverPositions["hero-01"] = { x: 0, y: 0 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };
    // hero-02 (body) slot 3 = fire — matches Death Cap (no Primordial)
    // and the spore-022 (water+fire) doesn't gate via slot.
    const session = buildAttackSession({
      attackerId: "hero-02",
      source: { kind: "weapon", slotIdx: 3, cardId: "body-sword-r1" },
      damage: 1, // Death Cap survives (HP 50)
      hitTiles: [{ x: 2, y: 2 }],
    });
    resolveAllDamage(state, session);
    expect(dc.alive).toBe(true);
    resolveSharedCounter(state, session, 1);
    // Positions swapped: Death Cap now on (4,4), spore on (2,2).
    expect(dc.x).toBe(4);
    expect(dc.y).toBe(4);
    expect(spore.x).toBe(2);
    expect(spore.y).toBe(2);
  });

  it("does NOT teleport a dying Death Cap (HP fully consumed)", () => {
    const state = emptyArenaState();
    const dc = spawnDeathCap(state, 2, 2);
    spawnSpore(state, 4, 4);
    state.encounter!.delverPositions["hero-01"] = { x: 0, y: 0 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };
    const session = buildAttackSession({
      attackerId: "hero-02",
      source: { kind: "weapon", slotIdx: 3, cardId: "body-sword-r1" },
      damage: 50, // exactly fatal
      hitTiles: [{ x: 2, y: 2 }],
    });
    resolveAllDamage(state, session);
    expect(dc.damageTaken).toBe(50);
    resolveSharedCounter(state, session, 1);
    // Position unchanged — the body is about to be cleared.
    expect(dc.x).toBe(2);
    expect(dc.y).toBe(2);
  });

  it("picks the closest enemy by Chebyshev distance, tie-broken by enemy-array order", () => {
    const state = emptyArenaState();
    const dc = spawnDeathCap(state, 2, 2);
    // Both spores at Chebyshev distance 2. Array order picks the
    // FIRST one (spawned first → indexed earlier).
    const sporeA = spawnSpore(state, 4, 2, "A");
    const sporeB = spawnSpore(state, 2, 4, "B");
    // Capture sporeA's pre-swap tile so a successful swap can
    // assert against the original coordinates (not the post-swap
    // ones, which would equal the Death Cap's old position).
    const sporeAStartX = sporeA.x;
    const sporeAStartY = sporeA.y;
    state.encounter!.delverPositions["hero-01"] = { x: 0, y: 0 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };
    const session = buildAttackSession({
      attackerId: "hero-02",
      source: { kind: "weapon", slotIdx: 3, cardId: "body-sword-r1" },
      damage: 1,
      hitTiles: [{ x: 2, y: 2 }],
    });
    resolveAllDamage(state, session);
    resolveSharedCounter(state, session, 1);
    // Death Cap took sporeA's old spot, sporeA took Death Cap's
    // old spot, sporeB is unchanged.
    expect(dc.x).toBe(sporeAStartX);
    expect(dc.y).toBe(sporeAStartY);
    expect(sporeA.x).toBe(2);
    expect(sporeA.y).toBe(2);
    expect(sporeB.x).toBe(2);
    expect(sporeB.y).toBe(4);
  });

  it("silently no-ops when no other living enemy exists", () => {
    const state = emptyArenaState();
    const dc = spawnDeathCap(state, 2, 2);
    state.encounter!.delverPositions["hero-01"] = { x: 0, y: 0 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };
    const session = buildAttackSession({
      attackerId: "hero-02",
      source: { kind: "weapon", slotIdx: 3, cardId: "body-sword-r1" },
      damage: 1,
      hitTiles: [{ x: 2, y: 2 }],
    });
    resolveAllDamage(state, session);
    resolveSharedCounter(state, session, 1);
    expect(dc.x).toBe(2);
    expect(dc.y).toBe(2);
  });

  it("does not teleport non-Teleports enemies (Crystanid)", () => {
    const state = emptyArenaState();
    const c = spawnCrystanid(state, 2, 2);
    spawnSpore(state, 4, 4);
    state.encounter!.delverPositions["hero-01"] = { x: 0, y: 0 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };
    const session = buildAttackSession({
      attackerId: "hero-02",
      source: { kind: "weapon", slotIdx: 3, cardId: "body-sword-r1" },
      damage: 1,
      hitTiles: [{ x: 2, y: 2 }],
    });
    resolveAllDamage(state, session);
    resolveSharedCounter(state, session, 1);
    expect(c.x).toBe(2);
    expect(c.y).toBe(2);
  });
});
