/**
 * Tests for src/engine/boots.ts — Strider Boots (Body) ONGOING:
 * "spend 2 movement to MOVE an adjacent enemy" and the shared
 * activation gate that Slip Strider Boots (Mind, Phase 3) will also
 * sit behind.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { newCampaign, type CampaignState } from "../state";
import { QUEST1 } from "../data";
import { ensureEncounter } from "../engine/encounter";
import {
  BOOTS_ONGOING_COST,
  adjacentEnemyTargets,
  bootsCardIdForHero,
  canActivateBootsOngoing,
  legalMoveDestinationsForEnemy,
  moveAdjacentEnemy,
  ownsBoots,
  rotateAdjacentEnemy,
} from "../engine/boots";
import { rotateOffset } from "../engine/combat";

const BOARD = QUEST1.waves[0]!.spawn.boardSize;

/**
 * Standardised setup: encounter ready, both delvers placed at known
 * tiles, no enemies. Mandatory placement satisfied so the gate
 * doesn't trip. Boots NOT yet owned (caller grants per test).
 */
function emptyArena(): CampaignState {
  const state = newCampaign();
  ensureEncounter(state, QUEST1);
  state.encounter!.enemies = [];
  for (const heroId of Object.keys(state.loadouts)) {
    state.encounter!.turnState[heroId] = {
      cardPlacedThisTurn: { slotIdx: 0, cardId: "test-card", autoRefreshedElement: null },
      actionUsedThisTurn: false,
      movementUsedThisTurn: false,
      movementStepsThisTurn: 0,
      apMovementDoubledThisTurn: false,
      actionGrantedExtraMovement: false,
      damage2xUsedThisTurn: false,
      doubleDamageActive: {},
      witnessStepsThisTurn: 0,
      movementSnapshot: null,
    };
  }
  return state;
}

/** Place hero-02 (Body) at (x, y) and grant Boots R1 with movement 2. */
function setupBodyBootsBearer(state: CampaignState, x: number, y: number): void {
  state.encounter!.delverPositions["hero-02"] = { x, y };
  // Move hero-01 far away so it doesn't accidentally block destinations.
  state.encounter!.delverPositions["hero-01"] = { x: 0, y: 0 };
  state.equipmentRanks["hero-02"]!.Boots = 1;
  state.loadouts["hero-02"]!.baseMovement = 2;
  state.loadouts["hero-02"]!.currentMovement = 2;
}

/** Push a fresh enemy at (x, y). Uses crystanid-001 since its specifics
 *  (HP, counter pattern) don't matter for these tests — we only care
 *  about position and `alive`. */
function placeEnemy(state: CampaignState, instanceId: string, x: number, y: number): void {
  state.encounter!.enemies.push({
    instanceId,
    cardId: "crystanid-001",
    x, y,
    damageTaken: 0,
    alive: true,
    facing: 0,
  });
}

describe("ownsBoots / bootsCardIdForHero", () => {
  it("returns false / null when the delver has no Boots", () => {
    const s = emptyArena();
    expect(ownsBoots(s, "hero-02")).toBe(false);
    expect(bootsCardIdForHero(s, "hero-02")).toBeNull();
  });

  it("returns true / suit-correct id when Boots is owned", () => {
    const s = emptyArena();
    s.equipmentRanks["hero-02"]!.Boots = 1;
    expect(ownsBoots(s, "hero-02")).toBe(true);
    expect(bootsCardIdForHero(s, "hero-02")).toBe("body-boots-r1");
    s.equipmentRanks["hero-01"]!.Boots = 1;
    expect(bootsCardIdForHero(s, "hero-01")).toBe("mind-boots-r1");
  });
});

describe("canActivateBootsOngoing", () => {
  let s: CampaignState;
  beforeEach(() => { s = emptyArena(); setupBodyBootsBearer(s, 2, 2); });

  it("ok when bearer owns Boots, has 2+ movement, hasn't moved, and has placed", () => {
    expect(canActivateBootsOngoing(s, "hero-02")).toEqual({ ok: true });
  });

  it("blocked when no Boots owned", () => {
    s.equipmentRanks["hero-02"]!.Boots = 0;
    const r = canActivateBootsOngoing(s, "hero-02");
    expect(r.ok).toBe(false);
  });

  it("blocked when currentMovement < 2", () => {
    s.loadouts["hero-02"]!.currentMovement = 1;
    const r = canActivateBootsOngoing(s, "hero-02");
    expect(r.ok).toBe(false);
  });

  it("blocked when movementUsedThisTurn", () => {
    s.encounter!.turnState["hero-02"]!.movementUsedThisTurn = true;
    const r = canActivateBootsOngoing(s, "hero-02");
    expect(r.ok).toBe(false);
  });

  it("blocked when no card placed yet this turn", () => {
    s.encounter!.turnState["hero-02"]!.cardPlacedThisTurn = null;
    const r = canActivateBootsOngoing(s, "hero-02");
    expect(r.ok).toBe(false);
  });

  it("blocked when prepared to run", () => {
    s.encounter!.preparedToRun["hero-02"] = true;
    const r = canActivateBootsOngoing(s, "hero-02");
    expect(r.ok).toBe(false);
  });
});

describe("adjacentEnemyTargets", () => {
  let s: CampaignState;
  beforeEach(() => { s = emptyArena(); setupBodyBootsBearer(s, 2, 2); });

  it("empty when no enemies are within 1 tile", () => {
    placeEnemy(s, "e1", 4, 4); // 2 tiles away
    expect(adjacentEnemyTargets(s, "hero-02")).toEqual([]);
  });

  it("collects all 8-way adjacent enemies", () => {
    placeEnemy(s, "e1", 1, 1); // NW diagonal
    placeEnemy(s, "e2", 3, 2); // E
    placeEnemy(s, "e3", 0, 0); // not adjacent (2 away)
    const ids = adjacentEnemyTargets(s, "hero-02").map((e) => e.instanceId).sort();
    expect(ids).toEqual(["e1", "e2"]);
  });
});

describe("legalMoveDestinationsForEnemy", () => {
  let s: CampaignState;
  beforeEach(() => { s = emptyArena(); setupBodyBootsBearer(s, 2, 2); });

  it("8 candidates minus the bearer's tile (enemy at (2,3), bearer at (2,2)) = 7 destinations", () => {
    placeEnemy(s, "e1", 2, 3);
    const dests = legalMoveDestinationsForEnemy(s, "e1", BOARD);
    // (2,2) is excluded because the bearer (hero-02) is standing
    // there — delver-occupied tiles are blocked for enemy moves.
    expect(dests.length).toBe(7);
    expect(dests.some((d) => d.x === 2 && d.y === 2)).toBe(false);
  });

  it("8 destinations when no delver is among the candidate tiles", () => {
    // Move both delvers far from the enemy's neighbourhood.
    s.encounter!.delverPositions["hero-02"] = { x: 0, y: 0 };
    s.encounter!.delverPositions["hero-01"] = { x: 4, y: 4 };
    placeEnemy(s, "e1", 2, 2); // middle-of-board, all 8 neighbours in-bounds and clear
    const dests = legalMoveDestinationsForEnemy(s, "e1", BOARD);
    expect(dests.length).toBe(8);
  });

  it("excludes off-board tiles when enemy is on a corner", () => {
    s.encounter!.delverPositions["hero-02"] = { x: 4, y: 4 };
    s.encounter!.delverPositions["hero-01"] = { x: 4, y: 0 };
    placeEnemy(s, "e1", 0, 0);
    const dests = legalMoveDestinationsForEnemy(s, "e1", BOARD);
    // Only (1,0), (0,1), (1,1) — 3 in-bounds neighbours.
    expect(dests.length).toBe(3);
  });

  it("excludes tiles occupied by other enemies", () => {
    s.encounter!.delverPositions["hero-02"] = { x: 0, y: 0 };
    s.encounter!.delverPositions["hero-01"] = { x: 4, y: 4 };
    placeEnemy(s, "e1", 2, 2); // 8 candidates
    placeEnemy(s, "blocker", 3, 3); // remove one candidate
    const dests = legalMoveDestinationsForEnemy(s, "e1", BOARD);
    expect(dests.length).toBe(7);
    expect(dests.some((d) => d.x === 3 && d.y === 3)).toBe(false);
  });

  it("excludes tiles occupied by any delver (own or other)", () => {
    placeEnemy(s, "e1", 2, 3); // 8 candidates
    // Both delvers stand on tiles that would otherwise be candidates.
    s.encounter!.delverPositions["hero-02"] = { x: 2, y: 2 };
    s.encounter!.delverPositions["hero-01"] = { x: 3, y: 4 };
    const dests = legalMoveDestinationsForEnemy(s, "e1", BOARD);
    expect(dests.some((d) => d.x === 2 && d.y === 2)).toBe(false);
    expect(dests.some((d) => d.x === 3 && d.y === 4)).toBe(false);
  });

  it("returns [] for a dead enemy", () => {
    placeEnemy(s, "e1", 2, 3);
    s.encounter!.enemies.find((e) => e.instanceId === "e1")!.alive = false;
    expect(legalMoveDestinationsForEnemy(s, "e1", BOARD)).toEqual([]);
  });
});

describe("moveAdjacentEnemy (Strider Boots, Body)", () => {
  let s: CampaignState;
  beforeEach(() => { s = emptyArena(); setupBodyBootsBearer(s, 2, 2); });

  it("happy path: moves enemy 1 tile, spends 2 movement, does NOT latch movementUsedThisTurn", () => {
    // Boots spends movement POINTS from the pool, not the once-per-turn
    // move STEP. The flag stays false so a delver with leftover budget
    // (e.g. AP-spend Double Movement → 4 movement) can still issue a
    // normal move or trigger Boots again. With baseMovement = 2 the
    // pool happens to be empty after one use, but the flag invariant
    // is what we're asserting.
    placeEnemy(s, "e1", 2, 3);
    const r = moveAdjacentEnemy(s, "hero-02", "e1", 2, 4, BOARD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.from).toEqual({ x: 2, y: 3 });
    expect(r.to).toEqual({ x: 2, y: 4 });

    const enemy = s.encounter!.enemies.find((e) => e.instanceId === "e1")!;
    expect(enemy.x).toBe(2);
    expect(enemy.y).toBe(4);
    expect(s.loadouts["hero-02"]!.currentMovement).toBe(0);
    expect(s.encounter!.turnState["hero-02"]!.movementUsedThisTurn).toBe(false);
  });

  it("with 4 movement (e.g. buffed via AP-spend), leaves 2 remaining and stays unlocked for a second activation", () => {
    // Simulate the AP-spend "Double Movement" buff: baseMovement = 2,
    // currentMovement = 4 after AP doubling. After spending Boots once
    // the pool drops to 2 — enough for a second Boots activation OR a
    // normal move order, both of which require movementUsedThisTurn to
    // remain false.
    s.loadouts["hero-02"]!.currentMovement = 4;
    placeEnemy(s, "e1", 2, 3);

    const r1 = moveAdjacentEnemy(s, "hero-02", "e1", 2, 4, BOARD);
    expect(r1.ok).toBe(true);
    expect(s.loadouts["hero-02"]!.currentMovement).toBe(2);
    expect(s.encounter!.turnState["hero-02"]!.movementUsedThisTurn).toBe(false);

    // Gate is still open for another activation.
    expect(canActivateBootsOngoing(s, "hero-02")).toEqual({ ok: true });

    // Second use: enemy is now at (2,4) — still adjacent to bearer at
    // (2,2)? No — distance is 2 in y. Move bearer adjacent first to
    // line up a clean second activation.
    s.encounter!.delverPositions["hero-02"] = { x: 2, y: 5 };
    const r2 = moveAdjacentEnemy(s, "hero-02", "e1", 1, 4, BOARD);
    expect(r2.ok).toBe(true);
    expect(s.loadouts["hero-02"]!.currentMovement).toBe(0);
    // Two activations later we still haven't latched the flag — the
    // budget is what gates further use, via canActivateBootsOngoing.
    expect(s.encounter!.turnState["hero-02"]!.movementUsedThisTurn).toBe(false);

    // Now the budget gate trips even though the step gate doesn't.
    const after = canActivateBootsOngoing(s, "hero-02");
    expect(after.ok).toBe(false);
  });

  it("rejects when target enemy is not adjacent (e.g. 2 tiles away)", () => {
    placeEnemy(s, "e1", 4, 2);
    const r = moveAdjacentEnemy(s, "hero-02", "e1", 4, 3, BOARD);
    expect(r.ok).toBe(false);
    // No mutation.
    expect(s.encounter!.enemies.find((e) => e.instanceId === "e1")!.x).toBe(4);
    expect(s.loadouts["hero-02"]!.currentMovement).toBe(2);
  });

  it("rejects when destination is not in legalMoveDestinationsForEnemy", () => {
    placeEnemy(s, "e1", 2, 3);
    // (2, 5) is 2 tiles from the enemy → not a legal 1-step destination.
    const r = moveAdjacentEnemy(s, "hero-02", "e1", 2, 5, BOARD);
    expect(r.ok).toBe(false);
  });

  it("rejects when destination is off-board", () => {
    placeEnemy(s, "e1", 0, 0);
    const r = moveAdjacentEnemy(s, "hero-02", "e1", -1, 0, BOARD);
    expect(r.ok).toBe(false);
  });

  it("rejects when destination is occupied by another enemy", () => {
    placeEnemy(s, "e1", 2, 3);
    placeEnemy(s, "blocker", 3, 3);
    const r = moveAdjacentEnemy(s, "hero-02", "e1", 3, 3, BOARD);
    expect(r.ok).toBe(false);
  });

  it("rejects when destination is occupied by the bearer itself", () => {
    // Bearer at (2,2), enemy adjacent at (2,3). Player tries to move
    // enemy ONTO the bearer's tile.
    placeEnemy(s, "e1", 2, 3);
    const r = moveAdjacentEnemy(s, "hero-02", "e1", 2, 2, BOARD);
    expect(r.ok).toBe(false);
  });

  it("rejects when destination is occupied by the OTHER delver", () => {
    placeEnemy(s, "e1", 2, 3);
    s.encounter!.delverPositions["hero-01"] = { x: 3, y: 4 };
    const r = moveAdjacentEnemy(s, "hero-02", "e1", 3, 4, BOARD);
    expect(r.ok).toBe(false);
  });

  it("rejects when bearer doesn't own Boots", () => {
    s.equipmentRanks["hero-02"]!.Boots = 0;
    placeEnemy(s, "e1", 2, 3);
    const r = moveAdjacentEnemy(s, "hero-02", "e1", 2, 4, BOARD);
    expect(r.ok).toBe(false);
  });

  it("rejects when bearer has insufficient movement", () => {
    s.loadouts["hero-02"]!.currentMovement = 1;
    placeEnemy(s, "e1", 2, 3);
    const r = moveAdjacentEnemy(s, "hero-02", "e1", 2, 4, BOARD);
    expect(r.ok).toBe(false);
  });

  it("rejects when bearer has already used their movement this turn", () => {
    s.encounter!.turnState["hero-02"]!.movementUsedThisTurn = true;
    placeEnemy(s, "e1", 2, 3);
    const r = moveAdjacentEnemy(s, "hero-02", "e1", 2, 4, BOARD);
    expect(r.ok).toBe(false);
  });

  it("rejects when MIND delver tries the body-only move (Slip Strider doesn't move enemies)", () => {
    // Set up the Mind delver as the bearer instead.
    s.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    s.encounter!.delverPositions["hero-02"] = { x: 0, y: 0 };
    s.equipmentRanks["hero-01"]!.Boots = 1;
    s.loadouts["hero-01"]!.baseMovement = 2;
    s.loadouts["hero-01"]!.currentMovement = 2;
    placeEnemy(s, "e1", 2, 3);
    const r = moveAdjacentEnemy(s, "hero-01", "e1", 2, 4, BOARD);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Card-based since Cyclone Boots: only Strider / Cyclone Boots move enemies.
    expect(r.reason).toMatch(/cannot MOVE enemies/);
  });

  it("rejects when target enemy is dead", () => {
    placeEnemy(s, "e1", 2, 3);
    s.encounter!.enemies.find((e) => e.instanceId === "e1")!.alive = false;
    const r = moveAdjacentEnemy(s, "hero-02", "e1", 2, 4, BOARD);
    expect(r.ok).toBe(false);
  });

  it("BOOTS_ONGOING_COST is 2 (sanity check on the contract)", () => {
    expect(BOOTS_ONGOING_COST).toBe(2);
  });
});

// --- rotateOffset (pure helper) ----------------------------------------

describe("rotateOffset (combat.ts)", () => {
  it("facing 0 is the identity", () => {
    expect(rotateOffset({ dx: 1, dy: 0 }, 0)).toEqual({ dx: 1, dy: 0 });
    expect(rotateOffset({ dx: 0, dy: 1 }, 0)).toEqual({ dx: 0, dy: 1 });
    expect(rotateOffset({ dx: -2, dy: 3 }, 0)).toEqual({ dx: -2, dy: 3 });
  });

  it("facing 90 (CW): east -> south, north -> east, south -> west, west -> north", () => {
    // (+x = east, +y = south)
    expect(rotateOffset({ dx: 1, dy: 0 }, 90)).toEqual({ dx: 0, dy: 1 });   // E -> S
    expect(rotateOffset({ dx: 0, dy: -1 }, 90)).toEqual({ dx: 1, dy: 0 });  // N -> E
    expect(rotateOffset({ dx: 0, dy: 1 }, 90)).toEqual({ dx: -1, dy: 0 });  // S -> W
    expect(rotateOffset({ dx: -1, dy: 0 }, 90)).toEqual({ dx: 0, dy: -1 }); // W -> N
  });

  it("facing 180 negates both axes", () => {
    expect(rotateOffset({ dx: 1, dy: 0 }, 180)).toEqual({ dx: -1, dy: 0 });
    expect(rotateOffset({ dx: 0, dy: 1 }, 180)).toEqual({ dx: 0, dy: -1 });
    expect(rotateOffset({ dx: -2, dy: 3 }, 180)).toEqual({ dx: 2, dy: -3 });
  });

  it("facing 270 (CCW from 0) is the inverse of 90", () => {
    // 270 CW = 90 CCW: east -> north, north -> west, west -> south, south -> east.
    expect(rotateOffset({ dx: 1, dy: 0 }, 270)).toEqual({ dx: 0, dy: -1 });  // E -> N
    expect(rotateOffset({ dx: 0, dy: -1 }, 270)).toEqual({ dx: -1, dy: 0 }); // N -> W
    expect(rotateOffset({ dx: -1, dy: 0 }, 270)).toEqual({ dx: 0, dy: 1 });  // W -> S
    expect(rotateOffset({ dx: 0, dy: 1 }, 270)).toEqual({ dx: 1, dy: 0 });   // S -> E
  });

  it("rotating 4 quarter-turns is the identity (closure)", () => {
    const samples = [
      { dx: 1, dy: 0 }, { dx: -2, dy: 3 }, { dx: 4, dy: -1 },
    ];
    for (const off of samples) {
      const r1 = rotateOffset(off, 90);
      const r2 = rotateOffset({ ...r1, dx: -r1.dy, dy: r1.dx }, 0); // sanity
      void r2;
      // compose: rotate90 four times on each sample manually.
      let cur = off;
      for (let i = 0; i < 4; i++) cur = rotateOffset(cur, 90);
      expect(cur).toEqual(off);
    }
  });
});

// --- rotateAdjacentEnemy (Slip Strider Boots, Mind) -------------------

/** Place hero-01 (Mind) at (x, y) and grant Boots R1 with movement 2. */
function setupMindBootsBearer(state: CampaignState, x: number, y: number): void {
  state.encounter!.delverPositions["hero-01"] = { x, y };
  state.encounter!.delverPositions["hero-02"] = { x: 0, y: 0 };
  state.equipmentRanks["hero-01"]!.Boots = 1;
  state.loadouts["hero-01"]!.baseMovement = 2;
  state.loadouts["hero-01"]!.currentMovement = 2;
}

describe("rotateAdjacentEnemy (Slip Strider Boots, Mind)", () => {
  let s: CampaignState;
  beforeEach(() => { s = emptyArena(); setupMindBootsBearer(s, 2, 2); });

  it("90°: facing 0 -> 90, spends 2 movement, does NOT latch movementUsedThisTurn", () => {
    placeEnemy(s, "e1", 2, 3);
    const enemy = s.encounter!.enemies.find((e) => e.instanceId === "e1")!;
    expect(enemy.facing).toBe(0);
    const r = rotateAdjacentEnemy(s, "hero-01", "e1", 90);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.from).toBe(0);
    expect(r.to).toBe(90);
    expect(r.amount).toBe(90);
    expect(enemy.facing).toBe(90);
    expect(s.loadouts["hero-01"]!.currentMovement).toBe(0);
    // Same point-vs-step semantics as Body Boots: the flag stays
    // false; only the movement pool gates further use.
    expect(s.encounter!.turnState["hero-01"]!.movementUsedThisTurn).toBe(false);
  });

  it("180° in a single activation costs 2 movement (NOT 2x90° quarter-turns)", () => {
    // Per design clarification 2026-05-24: cost is 2 movement
    // regardless of rotation amount — the player picks 90/180/270 in
    // ONE 2-movement spend rather than paying per quarter-turn.
    placeEnemy(s, "e1", 2, 3);
    const enemy = s.encounter!.enemies.find((e) => e.instanceId === "e1")!;
    const r = rotateAdjacentEnemy(s, "hero-01", "e1", 180);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.to).toBe(180);
    expect(enemy.facing).toBe(180);
    expect(s.loadouts["hero-01"]!.currentMovement).toBe(0);
  });

  it("270° from facing 0 lands at 270 (= 90° CCW)", () => {
    placeEnemy(s, "e1", 2, 3);
    const enemy = s.encounter!.enemies.find((e) => e.instanceId === "e1")!;
    const r = rotateAdjacentEnemy(s, "hero-01", "e1", 270);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.to).toBe(270);
    expect(enemy.facing).toBe(270);
  });

  it("90° from 270 wraps to 0", () => {
    placeEnemy(s, "e1", 2, 3);
    const enemy = s.encounter!.enemies.find((e) => e.instanceId === "e1")!;
    enemy.facing = 270;
    const r = rotateAdjacentEnemy(s, "hero-01", "e1", 90);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.to).toBe(0);
  });

  it("180° from 270 wraps to 90", () => {
    placeEnemy(s, "e1", 2, 3);
    const enemy = s.encounter!.enemies.find((e) => e.instanceId === "e1")!;
    enemy.facing = 270;
    const r = rotateAdjacentEnemy(s, "hero-01", "e1", 180);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.to).toBe(90);
  });

  it("with 4 movement (buffed), can rotate two different enemies in one turn", () => {
    s.loadouts["hero-01"]!.currentMovement = 4;
    placeEnemy(s, "e1", 2, 3);
    placeEnemy(s, "e2", 3, 2);

    const r1 = rotateAdjacentEnemy(s, "hero-01", "e1", 90);
    expect(r1.ok).toBe(true);
    expect(s.loadouts["hero-01"]!.currentMovement).toBe(2);
    expect(s.encounter!.turnState["hero-01"]!.movementUsedThisTurn).toBe(false);

    const r2 = rotateAdjacentEnemy(s, "hero-01", "e2", 180);
    expect(r2.ok).toBe(true);
    expect(s.loadouts["hero-01"]!.currentMovement).toBe(0);
    expect(s.encounter!.enemies.find((e) => e.instanceId === "e1")!.facing).toBe(90);
    expect(s.encounter!.enemies.find((e) => e.instanceId === "e2")!.facing).toBe(180);
  });

  it("rejects when target enemy is not adjacent", () => {
    placeEnemy(s, "e1", 4, 2); // 2 tiles east of bearer
    const r = rotateAdjacentEnemy(s, "hero-01", "e1", 90);
    expect(r.ok).toBe(false);
    expect(s.encounter!.enemies[0]!.facing).toBe(0); // unchanged
    expect(s.loadouts["hero-01"]!.currentMovement).toBe(2);
  });

  it("rejects when bearer is BODY suit (Strider Boots doesn't rotate)", () => {
    // Re-cast to body bearer.
    s.encounter!.delverPositions["hero-02"] = { x: 2, y: 2 };
    s.encounter!.delverPositions["hero-01"] = { x: 0, y: 0 };
    s.equipmentRanks["hero-02"]!.Boots = 1;
    s.loadouts["hero-02"]!.baseMovement = 2;
    s.loadouts["hero-02"]!.currentMovement = 2;
    placeEnemy(s, "e1", 2, 3);
    const r = rotateAdjacentEnemy(s, "hero-02", "e1", 90);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Card-based since Cyclone Boots: only Slip Strider / Cyclone Boots rotate enemies.
    expect(r.reason).toMatch(/cannot ROTATE enemies/);
  });

  it("rejects when bearer doesn't own Boots", () => {
    s.equipmentRanks["hero-01"]!.Boots = 0;
    placeEnemy(s, "e1", 2, 3);
    const r = rotateAdjacentEnemy(s, "hero-01", "e1", 90);
    expect(r.ok).toBe(false);
  });

  it("rejects when bearer has insufficient movement", () => {
    s.loadouts["hero-01"]!.currentMovement = 1;
    placeEnemy(s, "e1", 2, 3);
    const r = rotateAdjacentEnemy(s, "hero-01", "e1", 90);
    expect(r.ok).toBe(false);
  });

  it("rejects when bearer has already used their movement this turn", () => {
    s.encounter!.turnState["hero-01"]!.movementUsedThisTurn = true;
    placeEnemy(s, "e1", 2, 3);
    const r = rotateAdjacentEnemy(s, "hero-01", "e1", 90);
    expect(r.ok).toBe(false);
  });

  it("rejects when target enemy is dead", () => {
    placeEnemy(s, "e1", 2, 3);
    s.encounter!.enemies[0]!.alive = false;
    const r = rotateAdjacentEnemy(s, "hero-01", "e1", 90);
    expect(r.ok).toBe(false);
  });
});
