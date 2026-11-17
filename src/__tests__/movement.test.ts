/**
 * Tests for src/engine/movement.ts.
 *
 * Verifies the step-by-step movement contract from DESIGN.md §5.1
 * (model change 2026-05-09):
 *   - 8-way (king-move) adjacency for legal step destinations
 *   - enemy tiles are walls (cannot end on)
 *   - the OTHER delver's tile is fine (stacking is allowed)
 *   - out-of-bounds is filtered
 *   - the delver's own current tile is NOT included
 *   - `moveDelverStep` decrements `currentMovement` by exactly 1 per
 *     successful step
 *   - `moveDelverStep` latches `movementUsedThisTurn = true` ONLY when
 *     MP hits 0 (auto-end of the movement session). With MP remaining
 *     after the step, the latch stays false so the player can keep
 *     stepping (and double back).
 *   - `endMovementStep` is the explicit early-end latch (idempotent)
 *   - per-step pickup: every step's destination tile is checked, not
 *     just the final tile of a multi-step session
 *   - the same turn-state gates apply (prepared-to-run, movement
 *     session locked); placement is NO LONGER a gate as of
 *     2026-05-21 — movement may precede placement, and the End Turn
 *     UI prompts for "Undo and submit" / "Go Back" when a turn ends
 *     in that state
 */

import { describe, it, expect } from "vitest";

import { newCampaign, type CampaignState } from "../state";
import { QUEST1 } from "../data";
import { ensureEncounter } from "../engine/encounter";
import {
  chebyshevDistance,
  isAdjacent8,
  legalStepDestinations,
  moveDelverStep,
  endMovementStep,
  collectTileDrops,
  undoMovementThisTurn,
  movementUndoBlockedReason,
} from "../engine/movement";

const BOARD = QUEST1.waves[0]!.spawn.boardSize;

/**
 * Build a campaign with: encounter ready, both delvers movable, no
 * enemies, AND mandatory turn-start placement already satisfied for
 * both heroes. Placement is no longer required for movement
 * (2026-05-21), but tests that pre-date that change keep the
 * placement so the assertions exercise the same code paths as
 * before — the placement is just defensive scaffolding for both
 * pre- and post-2026-05-21 callers.
 *
 * Tests that specifically exercise the gating clear `cardPlacedThisTurn`
 * (or set `preparedToRun` / `movementUsedThisTurn`) themselves.
 */
function emptyArenaState(): CampaignState {
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

// --- Pure utilities -----------------------------------------------------

describe("chebyshevDistance", () => {
  it("orthogonal: |dx|+|dy| with the larger axis dominating", () => {
    expect(chebyshevDistance(0, 0, 3, 0)).toBe(3);
    expect(chebyshevDistance(0, 0, 0, 4)).toBe(4);
  });
  it("diagonal: max(|dx|, |dy|) — diagonals don't cost more than orthogonals", () => {
    expect(chebyshevDistance(0, 0, 3, 3)).toBe(3);
    expect(chebyshevDistance(0, 0, 2, 4)).toBe(4);
  });
  it("same tile = 0", () => {
    expect(chebyshevDistance(2, 2, 2, 2)).toBe(0);
  });
});

describe("isAdjacent8", () => {
  it("is true for the 8 surrounding tiles", () => {
    const neighbours = [
      [1, 1], [2, 1], [3, 1],
      [1, 2],         [3, 2],
      [1, 3], [2, 3], [3, 3],
    ];
    for (const [x, y] of neighbours) {
      expect(isAdjacent8(2, 2, x!, y!)).toBe(true);
    }
  });
  it("is false for the same tile", () => {
    expect(isAdjacent8(2, 2, 2, 2)).toBe(false);
  });
  it("is false for tiles 2+ steps away", () => {
    expect(isAdjacent8(2, 2, 4, 2)).toBe(false);
    expect(isAdjacent8(2, 2, 0, 0)).toBe(false);
  });
});

// --- legalStepDestinations: shape + filters -----------------------------

describe("legalStepDestinations", () => {
  it("returns the 8 surrounding tiles when in the centre of the board", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 1;

    const reachable = legalStepDestinations(state, "hero-01", BOARD);
    expect(reachable).toHaveLength(8);
    const coords = reachable.map((t) => `${t.x},${t.y}`).sort();
    expect(coords).toEqual([
      "1,1", "1,2", "1,3",
      "2,1", "2,3",
      "3,1", "3,2", "3,3",
    ]);
    expect(reachable.every((t) => t.cost === 1)).toBe(true);
  });

  it("filters out-of-bounds tiles in the corner", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 0, y: 0 };
    state.loadouts["hero-01"]!.currentMovement = 1;

    const reachable = legalStepDestinations(state, "hero-01", BOARD);
    const coords = reachable.map((t) => `${t.x},${t.y}`).sort();
    expect(coords).toEqual(["0,1", "1,0", "1,1"]);
  });

  it("excludes the delver's own current tile", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 1;

    const reachable = legalStepDestinations(state, "hero-01", BOARD);
    expect(reachable.find((t) => t.x === 2 && t.y === 2)).toBeUndefined();
  });

  it("filters tiles occupied by an enemy", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 1;
    state.encounter!.enemies = [
      { instanceId: "e1", cardId: "crystanid-001", x: 3, y: 3, damageTaken: 0, alive: true, facing: 0 },
      { instanceId: "e2", cardId: "crystanid-001", x: 1, y: 1, damageTaken: 0, alive: true, facing: 0 },
    ];

    const reachable = legalStepDestinations(state, "hero-01", BOARD);
    const coords = reachable.map((t) => `${t.x},${t.y}`).sort();
    expect(coords).toEqual([
      "1,2", "1,3",
      "2,1", "2,3",
      "3,1", "3,2",
      // 1,1 and 3,3 stripped by the enemy filter
    ]);
  });

  it("INCLUDES the OTHER delver's tile (stacking is allowed)", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.encounter!.delverPositions["hero-02"] = { x: 3, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 1;

    const reachable = legalStepDestinations(state, "hero-01", BOARD);
    expect(reachable.find((t) => t.x === 3 && t.y === 2)).toBeDefined();
  });

  it("returns [] when MP is 0", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 0;
    expect(legalStepDestinations(state, "hero-01", BOARD)).toEqual([]);
  });
});

describe("legalStepDestinations turn-state gates (DESIGN.md §4 + §5.7)", () => {
  // 2026-05-21: placement is no longer required before movement.
  // The End Turn UI prompts the player when a turn ends with
  // movement-but-no-placement (engine has `undoMovementThisTurn`
  // for the "Undo and submit" branch; the modal lives in
  // ActionResolution / BoardScreen).
  it("returns valid destinations BEFORE the active delver has placed a card (movement-before-placement allowed)", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 1;
    state.encounter!.turnState["hero-01"]!.cardPlacedThisTurn = null;

    expect(legalStepDestinations(state, "hero-01", BOARD).length).toBeGreaterThan(0);
  });

  it("returns [] when the delver has prepared to run", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 1;
    state.encounter!.preparedToRun["hero-01"] = true;

    expect(legalStepDestinations(state, "hero-01", BOARD)).toEqual([]);
  });

  it("returns [] when the delver's movement session is over (latched)", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 1;
    state.encounter!.turnState["hero-01"]!.movementUsedThisTurn = true;

    expect(legalStepDestinations(state, "hero-01", BOARD)).toEqual([]);
  });

  // Action-gates-REMAINING-movement (rule refined 2026-05-18 after
  // user repro: Body delver couldn't move after Chain Gauntlet
  // swing on a turn where they hadn't moved yet). Only MP left
  // over from a partially-stepped session is forfeit; a fresh
  // pool stays usable for the action-then-move ordering.
  it("returns valid destinations when the active delver has used their action but NOT moved yet (action-then-move)", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 2;
    state.encounter!.turnState["hero-01"]!.actionUsedThisTurn = true;
    // movementStepsThisTurn = 0 (fresh, no steps yet).

    expect(legalStepDestinations(state, "hero-01", BOARD).length).toBeGreaterThan(0);
  });

  it("returns [] when the action helper auto-latched movementUsedThisTurn after interrupting an in-progress session", () => {
    // The "split sequence blocked" path. As of 2026-05-18 part 4 the
    // check lives in `turn.ts > endMovementSessionIfActionInterruptsIt`
    // and writes the result into `movementUsedThisTurn`. We simulate
    // that post-helper invariant here. End-to-end coverage of the
    // helper running through `useWeaponAbility` / `useSlotAbility`
    // lives in `turn.test.ts > USER REPRO 2026-05-18 part 4`.
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 2;
    const ts = state.encounter!.turnState["hero-01"]!;
    ts.actionUsedThisTurn = true;
    ts.movementStepsThisTurn = 1;
    ts.movementUsedThisTurn = true; // post-helper invariant

    expect(legalStepDestinations(state, "hero-01", BOARD)).toEqual([]);
  });
});

// --- moveDelverStep -----------------------------------------------------

describe("moveDelverStep — single-step semantics", () => {
  it("applies a valid step and decrements movement by exactly 1", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 3;

    const r = moveDelverStep(state, "hero-01", 3, 3, BOARD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.from).toEqual({ x: 2, y: 2 });
    expect(r.to).toEqual({ x: 3, y: 3 });
    expect(r.movementRemaining).toBe(2);
    expect(r.sessionEnded).toBe(false);
    expect(state.encounter!.delverPositions["hero-01"]).toEqual({ x: 3, y: 3 });
    expect(state.loadouts["hero-01"]!.currentMovement).toBe(2);
  });

  it("rejects a non-adjacent destination without mutating state", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 0, y: 0 };
    state.loadouts["hero-01"]!.currentMovement = 3;

    const r = moveDelverStep(state, "hero-01", 3, 3, BOARD); // 3 tiles away
    expect(r.ok).toBe(false);
    expect(state.encounter!.delverPositions["hero-01"]).toEqual({ x: 0, y: 0 });
    expect(state.loadouts["hero-01"]!.currentMovement).toBe(3);
    expect(state.encounter!.turnState["hero-01"]!.movementUsedThisTurn).toBe(false);
  });

  it("rejects stepping onto an enemy-occupied tile", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 1;
    state.encounter!.enemies = [
      { instanceId: "e1", cardId: "crystanid-001", x: 3, y: 3, damageTaken: 0, alive: true, facing: 0 },
    ];

    const r = moveDelverStep(state, "hero-01", 3, 3, BOARD);
    expect(r.ok).toBe(false);
    expect(state.encounter!.delverPositions["hero-01"]).toEqual({ x: 2, y: 2 });
    expect(state.loadouts["hero-01"]!.currentMovement).toBe(1);
  });

  it("allows stepping onto the OTHER delver's tile (stacking)", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.encounter!.delverPositions["hero-02"] = { x: 3, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 1;

    const r = moveDelverStep(state, "hero-01", 3, 2, BOARD);
    expect(r.ok).toBe(true);
    expect(state.encounter!.delverPositions["hero-01"]).toEqual({ x: 3, y: 2 });
  });

  it("returns an error if the encounter doesn't exist yet", () => {
    const state = newCampaign(); // no ensureEncounter
    const r = moveDelverStep(state, "hero-01", 1, 1, BOARD);
    expect(r.ok).toBe(false);
  });
});

describe("moveDelverStep — movementUsedThisTurn latching", () => {
  it("does NOT latch movementUsedThisTurn while MP remains", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 3;

    const r = moveDelverStep(state, "hero-01", 2, 3, BOARD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sessionEnded).toBe(false);
    expect(state.encounter!.turnState["hero-01"]!.movementUsedThisTurn).toBe(false);
    // Subsequent steps must still be legal — adjacency recomputes
    // from the new position.
    const next = legalStepDestinations(state, "hero-01", BOARD);
    expect(next.length).toBeGreaterThan(0);
  });

  it("latches movementUsedThisTurn when the step exhausts MP", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 1;

    const r = moveDelverStep(state, "hero-01", 3, 3, BOARD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.movementRemaining).toBe(0);
    expect(r.sessionEnded).toBe(true);
    expect(state.encounter!.turnState["hero-01"]!.movementUsedThisTurn).toBe(true);
    // legalStepDestinations now returns [] (the gate kicks in).
    expect(legalStepDestinations(state, "hero-01", BOARD)).toEqual([]);
  });

  it("does NOT latch when the step is rejected", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 0, y: 0 };
    state.loadouts["hero-01"]!.currentMovement = 1;

    const r = moveDelverStep(state, "hero-01", 4, 4, BOARD); // not adjacent
    expect(r.ok).toBe(false);
    expect(state.encounter!.turnState["hero-01"]!.movementUsedThisTurn).toBe(false);
  });

  it("supports doubling back over a previously-visited tile", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 3;

    // Step → step back → step somewhere new.
    expect(moveDelverStep(state, "hero-01", 3, 3, BOARD).ok).toBe(true);
    expect(state.encounter!.delverPositions["hero-01"]).toEqual({ x: 3, y: 3 });
    expect(moveDelverStep(state, "hero-01", 2, 2, BOARD).ok).toBe(true);
    expect(state.encounter!.delverPositions["hero-01"]).toEqual({ x: 2, y: 2 });
    expect(moveDelverStep(state, "hero-01", 1, 1, BOARD).ok).toBe(true);
    expect(state.encounter!.delverPositions["hero-01"]).toEqual({ x: 1, y: 1 });
    // 3 MP spent → session ended.
    expect(state.loadouts["hero-01"]!.currentMovement).toBe(0);
    expect(state.encounter!.turnState["hero-01"]!.movementUsedThisTurn).toBe(true);
  });
});

// movementStepsThisTurn — the explicit per-turn step counter the UI
// reads to decide whether disarming the movement overlay is a free
// toggle (0 steps) or a session-ending commit (1+ steps). MUST be
// independent of `currentMovement` because AP-double-movement and
// `+1 mov` slot abilities push the starting MP above `baseMovement`.
describe("moveDelverStep — movementStepsThisTurn counter", () => {
  it("starts at 0 on a fresh turnState and increments by 1 per successful step", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 3;
    expect(state.encounter!.turnState["hero-01"]!.movementStepsThisTurn).toBe(0);

    moveDelverStep(state, "hero-01", 3, 3, BOARD);
    expect(state.encounter!.turnState["hero-01"]!.movementStepsThisTurn).toBe(1);

    moveDelverStep(state, "hero-01", 2, 3, BOARD);
    expect(state.encounter!.turnState["hero-01"]!.movementStepsThisTurn).toBe(2);
  });

  it("does NOT increment on a rejected step", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 0, y: 0 };
    state.loadouts["hero-01"]!.currentMovement = 1;

    const r = moveDelverStep(state, "hero-01", 4, 4, BOARD); // not adjacent
    expect(r.ok).toBe(false);
    expect(state.encounter!.turnState["hero-01"]!.movementStepsThisTurn).toBe(0);
  });

  it("counts steps correctly even when starting MP exceeds baseMovement (AP-doubled)", () => {
    // The whole reason this counter exists: with AP-double-movement,
    // currentMovement starts at 4 while baseMovement stays at 2, so
    // the naive `currentMovement < baseMovement` check would still
    // be false after 1 step. The explicit counter is unaffected.
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.baseMovement = 2;
    state.loadouts["hero-01"]!.currentMovement = 4; // simulate AP-doubled

    moveDelverStep(state, "hero-01", 3, 3, BOARD);
    expect(state.loadouts["hero-01"]!.currentMovement).toBe(3);
    // currentMovement (3) > baseMovement (2) — the old check would
    // be wrong. The counter is the source of truth.
    expect(state.encounter!.turnState["hero-01"]!.movementStepsThisTurn).toBe(1);
  });
});

// Integration: the action-gates-REMAINING-movement path. Confirms
// the user-visible rule (refined 2026-05-18 part 2 after user repro:
// Body delver couldn't move at all after a Chain Gauntlet swing on a
// turn where they hadn't moved yet) holds end-to-end via the public
// engine API.
//
// Refined rule (current, post part-4 refinement 2026-05-18): the
// Action only forfeits MP that's REMAINING from a partially-stepped
// session. A delver who hasn't moved yet keeps their full pool of
// fresh MP — action-then-move is legal. Crucially, the "did the
// action interrupt movement" check now lives in the action helper
// (`turn.ts > endMovementSessionIfActionInterruptsIt`) where it has
// the timing info needed; `legalStepDestinations` itself no longer
// inspects `actionUsedThisTurn` and just reads `movementUsedThisTurn`.
//
// IMPORTANT for these tests: setting `ts.actionUsedThisTurn = true`
// in a stub state does NOT trigger the auto-latch (the helper runs
// inside `useWeaponAbility` / `useSlotAbility`). We simulate the
// post-helper invariant explicitly with `movementUsedThisTurn = true`
// where we want to assert the "remaining MP forfeit" path. The
// end-to-end tests in `turn.test.ts` drive through the public action
// API and assert the auto-latch behavior directly.
describe("legalStepDestinations + actionUsedThisTurn (refined 2026-05-18)", () => {
  it("ALLOWS a fresh movement session after the action when no steps have been taken yet (action-then-move)", () => {
    // User repro 2026-05-18 part 1: Body delver placed Chain Gauntlet,
    // used the weapon ability (action), and then could not move
    // at all even though they had baseMovement = 1 to spend and
    // had not stepped yet. Refined rule unblocks this. With steps=0
    // at action time, `endMovementSessionIfActionInterruptsIt` is a
    // no-op (movementUsedThisTurn stays false), so the fresh MP pool
    // remains spendable.
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 2;
    state.encounter!.turnState["hero-01"]!.actionUsedThisTurn = true;
    expect(state.encounter!.turnState["hero-01"]!.movementStepsThisTurn).toBe(0);
    expect(state.encounter!.turnState["hero-01"]!.movementUsedThisTurn).toBe(false);
    expect(legalStepDestinations(state, "hero-01", BOARD).length).toBeGreaterThan(0);
    const r = moveDelverStep(state, "hero-01", 3, 3, BOARD);
    expect(r.ok).toBe(true);
  });

  it("interrupts a paused mid-step movement session (steps already taken, MP remaining)", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 3;

    // Step once: MP=2, stepsCount=1.
    expect(moveDelverStep(state, "hero-01", 3, 3, BOARD).ok).toBe(true);
    expect(state.loadouts["hero-01"]!.currentMovement).toBe(2);
    expect(state.encounter!.turnState["hero-01"]!.movementStepsThisTurn).toBe(1);
    expect(legalStepDestinations(state, "hero-01", BOARD).length).toBeGreaterThan(0);

    // Player resolves their action mid-session. We simulate the
    // post-`endMovementSessionIfActionInterruptsIt` invariant here
    // (in real play, calling `useWeaponAbility` triggers the latch).
    const ts = state.encounter!.turnState["hero-01"]!;
    ts.actionUsedThisTurn = true;
    ts.movementUsedThisTurn = true; // helper's auto-latch
    // Remaining MP is forfeit — no further steps allowed.
    expect(legalStepDestinations(state, "hero-01", BOARD)).toEqual([]);
    expect(moveDelverStep(state, "hero-01", 4, 4, BOARD).ok).toBe(false);
  });

  it("action with 0 MP banked auto-disallows movement (gate falls through to currentMovement <= 0)", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 0;
    state.encounter!.turnState["hero-01"]!.actionUsedThisTurn = true;
    expect(legalStepDestinations(state, "hero-01", BOARD)).toEqual([]);
  });
});

// --- legalStepDestinations after an action -----------------------------
// `legalStepDestinations` only reads `movementUsedThisTurn`. An action
// latches it when it interrupts a movement in progress (no exceptions,
// designer ruling 2026-11-17); a delver who acted before moving keeps
// their whole pool. `actionGrantedExtraMovement` is display only.
describe("legalStepDestinations after an action", () => {
  it("allows movement after an action taken before moving (movementUsedThisTurn=false)", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 2;
    const ts = state.encounter!.turnState["hero-01"]!;
    // Acted before moving: action latched, movement not ended.
    ts.actionUsedThisTurn = true;
    ts.actionGrantedExtraMovement = true;
    ts.movementUsedThisTurn = false;
    const reachable = legalStepDestinations(state, "hero-01", BOARD);
    expect(reachable.length).toBeGreaterThan(0);
    const r = moveDelverStep(state, "hero-01", 3, 3, BOARD);
    expect(r.ok).toBe(true);
  });

  it("normal MP / movementUsedThisTurn gates still wind down the post-action move", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 1; // exactly 1 step left
    const ts = state.encounter!.turnState["hero-01"]!;
    ts.actionUsedThisTurn = true;
    ts.actionGrantedExtraMovement = true;
    ts.movementUsedThisTurn = false;

    // Step once -> MP=0, movementUsedThisTurn auto-latches.
    const r = moveDelverStep(state, "hero-01", 3, 3, BOARD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sessionEnded).toBe(true);
    expect(ts.movementUsedThisTurn).toBe(true);
    // MP spent: no further steps allowed.
    expect(legalStepDestinations(state, "hero-01", BOARD)).toEqual([]);
  });
});

// --- endMovementStep ----------------------------------------------------

describe("endMovementStep", () => {
  it("latches movementUsedThisTurn = true", () => {
    const state = emptyArenaState();
    expect(state.encounter!.turnState["hero-01"]!.movementUsedThisTurn).toBe(false);
    endMovementStep(state, "hero-01");
    expect(state.encounter!.turnState["hero-01"]!.movementUsedThisTurn).toBe(true);
  });

  it("is idempotent (safe to call after MP-exhausted auto-latch)", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 1;
    moveDelverStep(state, "hero-01", 3, 3, BOARD); // auto-latches
    expect(state.encounter!.turnState["hero-01"]!.movementUsedThisTurn).toBe(true);
    endMovementStep(state, "hero-01");
    expect(state.encounter!.turnState["hero-01"]!.movementUsedThisTurn).toBe(true);
  });

  it("does NOT touch currentMovement (leftover MP is forfeit, not refunded)", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 3;

    moveDelverStep(state, "hero-01", 3, 3, BOARD); // spent 1, 2 left
    endMovementStep(state, "hero-01");
    expect(state.loadouts["hero-01"]!.currentMovement).toBe(2);
    // ...but no further steps allowed.
    expect(legalStepDestinations(state, "hero-01", BOARD)).toEqual([]);
  });

  it("is a no-op when the encounter / turn-state for this hero is missing", () => {
    const state = newCampaign(); // no ensureEncounter
    expect(() => endMovementStep(state, "hero-01")).not.toThrow();
  });
});

// --- Per-step pickup (DESIGN.md §3.5 / §5.1) ----------------------------

describe("moveDelverStep — per-step pickup", () => {
  it("claims a matching minion-part on the step's destination tile", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 1;
    state.encounter!.tileDrops.push({
      x: 3, y: 3, heroId: "hero-01", dropId: "minion-part",
    });

    const r = moveDelverStep(state, "hero-01", 3, 3, BOARD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pickups).toHaveLength(1);
    expect(state.minionParts["hero-01"]).toBe(1);
    expect(state.encounter!.tileDrops).toHaveLength(0);
  });

  it("does NOT pick up the OTHER delver's drop (heroId scoping)", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 1;
    state.encounter!.tileDrops.push({
      x: 3, y: 3, heroId: "hero-02", dropId: "minion-part",
    });

    const r = moveDelverStep(state, "hero-01", 3, 3, BOARD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pickups).toHaveLength(0);
    expect(state.minionParts["hero-01"]).toBe(0);
    expect(state.encounter!.tileDrops).toHaveLength(1);
  });

  it("fires pickup on EVERY step of a multi-step path (not just the final tile)", () => {
    // The whole point of step-by-step movement: a delver with
    // currentMovement = 2 walking past a tile with their drop on
    // the way to a different tile picks the drop up en route.
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 0, y: 0 };
    state.loadouts["hero-01"]!.currentMovement = 2;
    // Drops on both the intermediate AND the final tile.
    state.encounter!.tileDrops.push(
      { x: 1, y: 0, heroId: "hero-01", dropId: "minion-part" },
      { x: 2, y: 0, heroId: "hero-01", dropId: "minion-part" },
    );

    // Step 1 → (1, 0): pick up the intermediate.
    const r1 = moveDelverStep(state, "hero-01", 1, 0, BOARD);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.pickups).toHaveLength(1);
    expect(state.minionParts["hero-01"]).toBe(1);

    // Step 2 → (2, 0): pick up the final.
    const r2 = moveDelverStep(state, "hero-01", 2, 0, BOARD);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.pickups).toHaveLength(1);
    expect(state.minionParts["hero-01"]).toBe(2);
    expect(state.encounter!.tileDrops).toHaveLength(0);
  });

  it("doubling back over a tile after pickup yields no further drops", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 0, y: 0 };
    state.loadouts["hero-01"]!.currentMovement = 3;
    state.encounter!.tileDrops.push({
      x: 1, y: 0, heroId: "hero-01", dropId: "minion-part",
    });

    const r1 = moveDelverStep(state, "hero-01", 1, 0, BOARD);
    expect(r1.ok && r1.pickups).toHaveLength(1);
    const r2 = moveDelverStep(state, "hero-01", 0, 0, BOARD);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.pickups).toHaveLength(0);
    const r3 = moveDelverStep(state, "hero-01", 1, 0, BOARD);
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    expect(r3.pickups).toHaveLength(0);
    expect(state.minionParts["hero-01"]).toBe(1);
  });
});

// --- collectTileDrops (independent helper) ------------------------------

describe("collectTileDrops", () => {
  it("claims ALL matching drops on the tile in one call (multi-drop transfer)", () => {
    const state = emptyArenaState();
    state.encounter!.tileDrops.push(
      { x: 3, y: 3, heroId: "hero-01", dropId: "minion-part" },
      { x: 3, y: 3, heroId: "hero-01", dropId: "minion-part" },
      { x: 3, y: 3, heroId: "hero-01", dropId: "boss-part" },
      { x: 3, y: 3, heroId: "hero-02", dropId: "minion-part" }, // not ours
    );

    const claimed = collectTileDrops(state, "hero-01", 3, 3);
    expect(claimed).toHaveLength(3);
    expect(state.minionParts["hero-01"]).toBe(2);
    expect(state.bossParts["hero-01"]).toBe(1);
    // Other hero's drop untouched.
    expect(state.encounter!.tileDrops).toHaveLength(1);
    expect(state.encounter!.tileDrops[0]!.heroId).toBe("hero-02");
  });

  it("credits boss-part-lvl-N variants to the LEVEL-MATCHED wallet (v58)", () => {
    // Pre-v58 every boss part landed on the flat lvl-1 counter, which
    // made lvl-2 shop costs unpayable (player report 2026-07-20).
    const state = emptyArenaState();
    state.encounter!.tileDrops.push(
      { x: 3, y: 3, heroId: "hero-01", dropId: "boss-part-lvl-2" }, // Hundredeyes
      { x: 3, y: 3, heroId: "hero-01", dropId: "boss-part-lvl-3" }, // Death Cap
      { x: 3, y: 3, heroId: "hero-01", dropId: "boss-part-lvl-1" }, // Soulhunter / Goldmonger
    );
    collectTileDrops(state, "hero-01", 3, 3);
    expect(state.bossParts["hero-01"]).toBe(1);
    expect(state.bossPartsLvl2["hero-01"]).toBe(1);
    expect(state.bossPartsLvl3["hero-01"]).toBe(1);
  });

  it("is a no-op (and returns []) when no matching drops on the tile", () => {
    const state = emptyArenaState();
    expect(collectTileDrops(state, "hero-01", 3, 3)).toEqual([]);
    expect(state.minionParts["hero-01"]).toBe(0);
  });
});

// --- 2026-05-21: movement before placement + undo --------------------
//
// Placement is no longer required before movement (`legalStepDestinations`
// no longer reads `cardPlacedThisTurn`). The End Turn UI guards the
// resulting "moved without placing" state by surfacing a confirmation
// modal whose "Undo and submit" branch calls `undoMovementThisTurn`,
// which is exercised end-to-end here.

describe("movement before placement (2026-05-21)", () => {
  it("legalStepDestinations returns destinations even with cardPlacedThisTurn === null", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 1;
    state.encounter!.turnState["hero-01"]!.cardPlacedThisTurn = null;
    expect(legalStepDestinations(state, "hero-01", BOARD).length).toBe(8);
  });

  it("moveDelverStep succeeds with cardPlacedThisTurn === null and lazily captures a movementSnapshot on the first step", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 2;
    state.encounter!.turnState["hero-01"]!.cardPlacedThisTurn = null;
    expect(state.encounter!.turnState["hero-01"]!.movementSnapshot).toBeNull();

    const r = moveDelverStep(state, "hero-01", 3, 3, BOARD);
    expect(r.ok).toBe(true);
    expect(state.encounter!.delverPositions["hero-01"]).toEqual({ x: 3, y: 3 });

    const snap = state.encounter!.turnState["hero-01"]!.movementSnapshot;
    expect(snap).not.toBeNull();
    expect(snap!.startPosition).toEqual({ x: 2, y: 2 });
    expect(snap!.startMovement).toBe(2);
    expect(snap!.claimedDrops).toEqual([]);
  });

  it("movementSnapshot is captured once and stays put across additional steps", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 3;

    moveDelverStep(state, "hero-01", 3, 3, BOARD);
    const firstSnap = state.encounter!.turnState["hero-01"]!.movementSnapshot;
    moveDelverStep(state, "hero-01", 2, 3, BOARD);
    const secondSnap = state.encounter!.turnState["hero-01"]!.movementSnapshot;
    expect(secondSnap).toBe(firstSnap); // same object — captured exactly once
    expect(secondSnap!.startPosition).toEqual({ x: 2, y: 2 });
  });

  it("movementSnapshot.claimedDrops accumulates every pickup taken during the turn", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 0, y: 0 };
    state.loadouts["hero-01"]!.currentMovement = 2;
    state.encounter!.tileDrops.push(
      { x: 1, y: 0, heroId: "hero-01", dropId: "minion-part" },
      { x: 2, y: 0, heroId: "hero-01", dropId: "boss-part" },
    );

    moveDelverStep(state, "hero-01", 1, 0, BOARD);
    moveDelverStep(state, "hero-01", 2, 0, BOARD);

    const snap = state.encounter!.turnState["hero-01"]!.movementSnapshot!;
    expect(snap.claimedDrops).toHaveLength(2);
    expect(snap.claimedDrops.map((d) => d.dropId).sort()).toEqual([
      "boss-part",
      "minion-part",
    ]);
  });
});

describe("undoMovementThisTurn", () => {
  it("restores position, MP, and clears step counter to the turn-start baseline", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 3;

    moveDelverStep(state, "hero-01", 3, 3, BOARD);
    moveDelverStep(state, "hero-01", 4, 3, BOARD);
    expect(state.encounter!.delverPositions["hero-01"]).toEqual({ x: 4, y: 3 });
    expect(state.loadouts["hero-01"]!.currentMovement).toBe(1);
    expect(state.encounter!.turnState["hero-01"]!.movementStepsThisTurn).toBe(2);

    const undone = undoMovementThisTurn(state, "hero-01");
    expect(undone).toBe(true);
    expect(state.encounter!.delverPositions["hero-01"]).toEqual({ x: 2, y: 2 });
    expect(state.loadouts["hero-01"]!.currentMovement).toBe(3);
    expect(state.encounter!.turnState["hero-01"]!.movementStepsThisTurn).toBe(0);
    expect(state.encounter!.turnState["hero-01"]!.movementUsedThisTurn).toBe(false);
    expect(state.encounter!.turnState["hero-01"]!.movementSnapshot).toBeNull();
  });

  it("returns the claimed pickups to tileDrops and reverts the per-hero counters", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 0, y: 0 };
    state.loadouts["hero-01"]!.currentMovement = 2;
    state.encounter!.tileDrops.push(
      { x: 1, y: 0, heroId: "hero-01", dropId: "minion-part" },
      { x: 2, y: 0, heroId: "hero-01", dropId: "boss-part" },
    );

    moveDelverStep(state, "hero-01", 1, 0, BOARD);
    moveDelverStep(state, "hero-01", 2, 0, BOARD);
    expect(state.minionParts["hero-01"]).toBe(1);
    expect(state.bossParts["hero-01"]).toBe(1);
    expect(state.encounter!.tileDrops).toHaveLength(0);

    undoMovementThisTurn(state, "hero-01");
    expect(state.minionParts["hero-01"]).toBe(0);
    expect(state.bossParts["hero-01"]).toBe(0);
    expect(state.encounter!.tileDrops).toHaveLength(2);
    // The restored drops carry the same heroId / coords so a future
    // re-step over the same tile would re-claim them.
    const ids = state.encounter!.tileDrops.map((d) => d.dropId).sort();
    expect(ids).toEqual(["boss-part", "minion-part"]);
  });

  it("clears the movementUsedThisTurn auto-latch after a session-ending step", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 1;

    moveDelverStep(state, "hero-01", 3, 3, BOARD);
    expect(state.encounter!.turnState["hero-01"]!.movementUsedThisTurn).toBe(true);

    undoMovementThisTurn(state, "hero-01");
    expect(state.encounter!.turnState["hero-01"]!.movementUsedThisTurn).toBe(false);
    // Movement is fully restored, so the player can step again
    // (or, in the real flow, the End Turn modal commits the turn).
    expect(legalStepDestinations(state, "hero-01", BOARD).length).toBeGreaterThan(0);
  });

  it("is idempotent (no snapshot = no-op, returns false)", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 2;
    expect(undoMovementThisTurn(state, "hero-01")).toBe(false);
    // State untouched.
    expect(state.encounter!.delverPositions["hero-01"]).toEqual({ x: 2, y: 2 });
    expect(state.loadouts["hero-01"]!.currentMovement).toBe(2);
  });

  it("is a no-op for an encounter that doesn't exist", () => {
    const state = newCampaign();
    expect(undoMovementThisTurn(state, "hero-01")).toBe(false);
  });

  it("preserves AP-double-movement MP boost: restored currentMovement matches the boosted pre-step value", () => {
    // AP-double-mov sets currentMovement = baseMovement * 2 before
    // the player even moves. If the player AP-doubles, then steps,
    // then undoes, currentMovement should be back to the boosted
    // value (the AP spend itself is unchanged).
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.baseMovement = 2;
    state.loadouts["hero-01"]!.currentMovement = 4; // simulate AP-doubled
    state.encounter!.turnState["hero-01"]!.apMovementDoubledThisTurn = true;

    moveDelverStep(state, "hero-01", 3, 3, BOARD);
    expect(state.loadouts["hero-01"]!.currentMovement).toBe(3);

    undoMovementThisTurn(state, "hero-01");
    expect(state.loadouts["hero-01"]!.currentMovement).toBe(4);
    // AP-double-mov latch is intentionally NOT touched (undo is
    // scoped to movement only).
    expect(state.encounter!.turnState["hero-01"]!.apMovementDoubledThisTurn).toBe(true);
  });
});

describe("UNDO MOVEMENT any time before End Turn (movementUndoBlockedReason)", () => {
  function moved(): CampaignState {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 3;
    moveDelverStep(state, "hero-01", 3, 3, BOARD);
    moveDelverStep(state, "hero-01", 4, 3, BOARD);
    return state;
  }

  it("is allowed right after moving (card placed before moving is fine)", () => {
    const state = moved();
    expect(movementUndoBlockedReason(state, "hero-01")).toBeNull();
    expect(undoMovementThisTurn(state, "hero-01")).toBe(true);
    expect(state.encounter!.delverPositions["hero-01"]).toEqual({ x: 2, y: 2 });
    expect(state.encounter!.turnState["hero-01"]!.cardPlacedThisTurn).not.toBeNull();
  });

  it("lets the delver move again after undoing, and undo again", () => {
    const state = moved();
    undoMovementThisTurn(state, "hero-01");
    expect(moveDelverStep(state, "hero-01", 1, 1, BOARD).ok).toBe(true);
    expect(movementUndoBlockedReason(state, "hero-01")).toBeNull();
    undoMovementThisTurn(state, "hero-01");
    expect(state.encounter!.delverPositions["hero-01"]).toEqual({ x: 2, y: 2 });
    expect(state.loadouts["hero-01"]!.currentMovement).toBe(3);
  });

  it("is blocked before any step", () => {
    const state = emptyArenaState();
    expect(movementUndoBlockedReason(state, "hero-01")).toMatch(/haven't moved/);
  });

  it("is blocked after an action, and the engine refuses to undo", () => {
    const state = moved();
    state.encounter!.turnState["hero-01"]!.actionUsedThisTurn = true;
    expect(movementUndoBlockedReason(state, "hero-01")).toMatch(/action/);
    expect(() => undoMovementThisTurn(state, "hero-01")).toThrow(/action/);
    expect(state.encounter!.delverPositions["hero-01"]).toEqual({ x: 4, y: 3 });
  });

  it("is blocked after AP is spent since moving (e.g. AP-double movement mid-move)", () => {
    const state = moved();
    state.loadouts["hero-01"]!.currentAp -= 1;
    expect(movementUndoBlockedReason(state, "hero-01")).toMatch(/AP/);
  });

  it("is blocked after a card is placed since moving, until the placement is undone", () => {
    const state = emptyArenaState();
    const ts = state.encounter!.turnState["hero-01"]!;
    ts.cardPlacedThisTurn = null;
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 3;
    moveDelverStep(state, "hero-01", 3, 3, BOARD);
    ts.cardPlacedThisTurn = { slotIdx: 1, cardId: "test-card", autoRefreshedElement: null };
    expect(movementUndoBlockedReason(state, "hero-01")).toMatch(/Undo the placement first/);
    ts.cardPlacedThisTurn = null;
    expect(movementUndoBlockedReason(state, "hero-01")).toBeNull();
  });

  it("is blocked once a step reveals a Friendly Encounter", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 3;
    state.encounter!.friendlyEncounters = [{ x: 3, y: 3 }];
    moveDelverStep(state, "hero-01", 3, 3, BOARD);
    expect(state.pendingFriendlyEncounters.length).toBe(1);
    expect(movementUndoBlockedReason(state, "hero-01")).toMatch(/Friendly Encounter/);
  });

  it("is blocked once a step collects a Memory Fragment", () => {
    const state = emptyArenaState();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.loadouts["hero-01"]!.currentMovement = 3;
    state.encounter!.memoryFragments = [{ x: 3, y: 3 }];
    moveDelverStep(state, "hero-01", 3, 3, BOARD);
    expect(movementUndoBlockedReason(state, "hero-01")).toMatch(/Memory Fragment/);
  });

  it("is blocked for a snapshot saved by an older build (no startAp)", () => {
    const state = moved();
    delete state.encounter!.turnState["hero-01"]!.movementSnapshot!.startAp;
    expect(movementUndoBlockedReason(state, "hero-01")).toMatch(/older version/);
  });
});
