/**
 * Tests for the Q2 Witness companion (rulebook Chapter 2 — "From
 * now on, you won't go alone... He's useless in a fight, but he'll
 * haul your gear for you").
 *
 * Coverage:
 *   - `engine/encounter.ts > buildEncounter` seeds
 *     `witnessPosition` on Q2 waves and leaves it null on Q1.
 *   - The Witness defaults to compass tile A on spawn-deck waves
 *     (same place as both delvers' default — the pick screen
 *     re-prompts the player to commit).
 *   - `assignWitnessToTile` mutates the slot, validates the phase
 *     + compass-tile invariants, and refuses to operate on a Q1
 *     encounter (no Witness present).
 *   - `buildEncounterTokens` emits exactly one `witness` BoardToken
 *     per Q2 encounter with the "W" label.
 *   - `migrateV34ToV35` backfills `witnessPosition: null` on
 *     legacy saves without clobbering present values.
 *   - `migrateV39ToV40` backfills `witnessStepsThisTurn: 0` on
 *     legacy saves with no clobber.
 *   - `stepWitness` / `legalWitnessStepDestinations` — Witness
 *     Reference Card "Move Witness up to 2 tiles" Action:
 *       * legal destinations are 8-way-adjacent, OOB-safe,
 *         enemy-blocker-safe; stop after the cap is hit.
 *       * first step latches `actionUsedThisTurn`, step 2 bypasses
 *         the gate, step 3 is rejected.
 *       * gates: needs Witness on board, needs a placed weapon
 *         card, blocks if action already used (and we haven't
 *         started a Witness step yet).
 *       * pickup routing: minion-parts credit OWNER wallets (not
 *         the mover's), memory fragments credit shared
 *         `state.memoryChips`.
 */

import { describe, it, expect } from "vitest";

import {
  migrateV34ToV35,
  migrateV39ToV40,
  newCampaign,
  type CampaignState,
} from "../state";
import { QUEST1, QUEST2, getSpawnCard } from "../data";
import {
  assignWitnessToTile,
  ensureEncounter,
  freshTurnState,
  hasWitness,
  type EncounterBuildHooks,
} from "../engine/encounter";
import {
  canBeginWitnessAction,
  legalWitnessStepDestinations,
  stepWitness,
  WITNESS_ACTION_STEP_CAP,
} from "../engine/witness";
import type { BoardBounds } from "../engine/movement";
import { buildEncounterTokens } from "../board/tideBoard";

const BOARD: BoardBounds = QUEST2.waves[0]!.spawn.boardSize;

const noShuffle = (pool: readonly string[]) => [...pool];

function pinnedHooks(spawnCardNumber: number = 1): EncounterBuildHooks {
  return {
    assign: noShuffle,
    drawSpawnCardNumber: () => spawnCardNumber,
  };
}

function freshState(): CampaignState {
  return newCampaign();
}

describe("hasWitness — per-quest opt-in helper", () => {
  it("returns true for Quest 2 (Chapter 2 reveal)", () => {
    expect(hasWitness(QUEST2)).toBe(true);
  });

  it("returns false for Quest 1 (pre-reveal)", () => {
    expect(hasWitness(QUEST1)).toBe(false);
  });
});

describe("buildEncounter — Witness seeding", () => {
  it("Q2 W1: seeds witnessPosition to compass tile A by default", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    const tileA = getSpawnCard(1).delverSpawns[0]!;
    expect(enc.witnessPosition).toEqual({ x: tileA.x, y: tileA.y });
  });

  it("Q2 W1: Witness defaults to the SAME tile as both delvers", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    expect(enc.witnessPosition).toEqual(enc.delverPositions["hero-01"]);
    expect(enc.witnessPosition).toEqual(enc.delverPositions["hero-02"]);
  });

  it("Q1: leaves witnessPosition null (no companion in Chapter 1)", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST1, noShuffle);
    expect(enc.witnessPosition).toBeNull();
  });
});

describe("assignWitnessToTile — pick-phase placement", () => {
  it("moves Witness to a chosen compass tile", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    const tileB = getSpawnCard(1).delverSpawns[1]!;
    assignWitnessToTile(state, tileB.x, tileB.y);
    expect(enc.witnessPosition).toEqual({ x: tileB.x, y: tileB.y });
  });

  it("is idempotent — re-placing on the current tile is a no-op", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    const tileA = getSpawnCard(1).delverSpawns[0]!;
    assignWitnessToTile(state, tileA.x, tileA.y);
    assignWitnessToTile(state, tileA.x, tileA.y);
    expect(enc.witnessPosition).toEqual({ x: tileA.x, y: tileA.y });
  });

  it("rejects a non-compass tile (fail-loud, the picker UI gates this)", () => {
    const state = freshState();
    ensureEncounter(state, QUEST2, pinnedHooks(1));
    // (4, 4) — corner tile that is highly unlikely to be on the
    // delverSpawns list for any printed card. Sanity-check the
    // assumption against the card we drew before asserting.
    const compass = getSpawnCard(1).delverSpawns;
    const offCompass = { x: 4, y: 4 };
    const isOff = !compass.some((c) => c.x === offCompass.x && c.y === offCompass.y);
    expect(isOff).toBe(true);
    expect(() => assignWitnessToTile(state, offCompass.x, offCompass.y))
      .toThrow(/not a printed compass tile/);
  });

  it("throws when called on a Q1 encounter (Witness absent)", () => {
    const state = freshState();
    ensureEncounter(state, QUEST1, noShuffle);
    expect(() => assignWitnessToTile(state, 0, 0))
      .toThrow(/no Witness|expected "delver-spawn-pick"/);
  });

  it("throws when there's no encounter at all", () => {
    const state = freshState();
    expect(() => assignWitnessToTile(state, 0, 0))
      .toThrow(/no encounter/);
  });
});

describe("buildEncounterTokens — Witness token emission", () => {
  it("Q2: emits exactly one witness token at witnessPosition with label 'W'", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    const tokens = buildEncounterTokens(enc);
    const witnessTokens = tokens.filter((t) => t.kind === "witness");
    expect(witnessTokens).toHaveLength(1);
    const w = witnessTokens[0]!;
    expect(w.label).toBe("Witness");
    expect(w.name).toBe("Witness (companion)");
    expect({ x: w.col, y: w.row }).toEqual(enc.witnessPosition);
  });

  it("Q1: emits no witness tokens", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST1, noShuffle);
    const tokens = buildEncounterTokens(enc);
    expect(tokens.filter((t) => t.kind === "witness")).toHaveLength(0);
  });

  it("Witness token tracks witnessPosition mutations through reposition", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    const tileB = getSpawnCard(1).delverSpawns[1]!;
    assignWitnessToTile(state, tileB.x, tileB.y);
    const tokens = buildEncounterTokens(enc);
    const w = tokens.find((t) => t.kind === "witness")!;
    expect({ x: w.col, y: w.row }).toEqual({ x: tileB.x, y: tileB.y });
  });

  it("uses a stable id (renderers can diff across renders)", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    const a = buildEncounterTokens(enc).find((t) => t.kind === "witness")!;
    const b = buildEncounterTokens(enc).find((t) => t.kind === "witness")!;
    expect(a.id).toBe(b.id);
    expect(a.id).toBe("witness");
  });
});

describe("migrateV34ToV35 — witnessPosition backfill on legacy saves", () => {
  it("graduates a v34 save to v35 (intermediate version, not SCHEMA_VERSION)", () => {
    // Hard-code 35 (not SCHEMA_VERSION) so future migrations don't
    // silently regress this — the v35 -> v36 migration (Opinion
    // Card abilities) is what actually graduates the save to
    // SCHEMA_VERSION. This test verifies the intermediate stop;
    // chained migration coverage lives in loadCampaign tests.
    const save = { version: 34, encounter: null };
    const out = migrateV34ToV35(save) as CampaignState;
    expect(out.version).toBe(35);
  });

  it("backfills witnessPosition = null on a v34 encounter that predates the field", () => {
    const save = {
      version: 34,
      encounter: {
        questId: "quest2",
        waveNumber: 1,
        delverPositions: { "hero-01": { x: 0, y: 0 } },
      },
    };
    const out = migrateV34ToV35(save) as CampaignState;
    const enc = (out as unknown as { encounter: { witnessPosition: unknown } }).encounter;
    expect(enc.witnessPosition).toBeNull();
  });

  it("does NOT clobber an existing witnessPosition (forward-compat)", () => {
    const save = {
      version: 34,
      encounter: {
        questId: "quest2",
        waveNumber: 1,
        witnessPosition: { x: 2, y: 0 },
      },
    };
    const out = migrateV34ToV35(save) as CampaignState;
    const enc = (out as unknown as { encounter: { witnessPosition: unknown } }).encounter;
    expect(enc.witnessPosition).toEqual({ x: 2, y: 0 });
  });

  it("tolerates a null encounter (no field to backfill)", () => {
    const save = { version: 34, encounter: null };
    const out = migrateV34ToV35(save) as CampaignState;
    expect(out.encounter).toBeNull();
  });

  it("returns null on malformed input (caller falls through to newCampaign)", () => {
    expect(migrateV34ToV35(null)).toBeNull();
  });
});

describe("migrateV39ToV40 — witnessStepsThisTurn backfill on legacy saves", () => {
  it("backfills witnessStepsThisTurn = 0 on every existing HeroTurnState", () => {
    const save = {
      version: 39,
      encounter: {
        questId: "quest2",
        waveNumber: 1,
        turnState: {
          "hero-01": {
            cardPlacedThisTurn: null,
            actionUsedThisTurn: false,
            movementUsedThisTurn: false,
            movementStepsThisTurn: 0,
            apMovementDoubledThisTurn: false,
            actionGrantedExtraMovement: false,
            damage2xUsedThisTurn: false,
          },
          "hero-02": {
            cardPlacedThisTurn: null,
            actionUsedThisTurn: false,
            movementUsedThisTurn: false,
            movementStepsThisTurn: 0,
            apMovementDoubledThisTurn: false,
            actionGrantedExtraMovement: false,
            damage2xUsedThisTurn: false,
          },
        },
      },
    };
    const out = migrateV39ToV40(save) as CampaignState;
    expect(out.version).toBeGreaterThanOrEqual(40);
    const enc = out.encounter!;
    expect(enc.turnState["hero-01"]!.witnessStepsThisTurn).toBe(0);
    expect(enc.turnState["hero-02"]!.witnessStepsThisTurn).toBe(0);
  });

  it("does NOT clobber an existing witnessStepsThisTurn (forward-compat)", () => {
    const save = {
      version: 39,
      encounter: {
        questId: "quest2",
        turnState: {
          "hero-01": {
            cardPlacedThisTurn: null,
            actionUsedThisTurn: false,
            movementUsedThisTurn: false,
            movementStepsThisTurn: 0,
            apMovementDoubledThisTurn: false,
            actionGrantedExtraMovement: false,
            damage2xUsedThisTurn: false,
            witnessStepsThisTurn: 1,
          },
        },
      },
    };
    const out = migrateV39ToV40(save) as CampaignState;
    expect(out.encounter!.turnState["hero-01"]!.witnessStepsThisTurn).toBe(1);
  });

  it("tolerates a null encounter (no turnState to backfill)", () => {
    const save = { version: 39, encounter: null };
    const out = migrateV39ToV40(save) as CampaignState;
    expect(out.encounter).toBeNull();
  });

  it("returns null on malformed input", () => {
    expect(migrateV39ToV40(null)).toBeNull();
  });
});

// --- Witness Action engine -----------------------------------------------

/** Build a Q2 encounter with Witness at a known centre tile, an
 *  empty enemy roster, and the current delver's turnState set up
 *  with a placed card (the minimum precondition for the Witness
 *  Action). Skips the spawn-pick phase manually to avoid pulling in
 *  startWaveAfterPick wiring — the witness engine doesn't gate on
 *  encounter phase. */
function setupWitnessActionState(opts: {
  witnessAt?: { x: number; y: number };
  actionUsed?: boolean;
  noCardPlaced?: boolean;
} = {}): CampaignState {
  const state = newCampaign();
  ensureEncounter(state, QUEST2, pinnedHooks(1));
  const enc = state.encounter!;
  // Clean slate for the engine: no enemies blocking adjacency, no
  // existing drops or fragments (each test seeds these as needed).
  enc.enemies = [];
  enc.tileDrops = [];
  enc.memoryFragments = [];
  // Park Witness at a centre tile (2, 2) so all 8 adjacents are
  // in-bounds for the legal-destination tests.
  enc.witnessPosition = opts.witnessAt ?? { x: 2, y: 2 };

  // Reset both delvers' turn state to a known baseline. Active
  // delver gets a placed card unless the test explicitly opts out.
  const heroId = state.currentDelverId;
  const ts = freshTurnState();
  if (!opts.noCardPlaced) {
    ts.cardPlacedThisTurn = {
      slotIdx: 0,
      cardId: "test-card",
      autoRefreshedElement: null,
    };
  }
  if (opts.actionUsed) ts.actionUsedThisTurn = true;
  enc.turnState[heroId] = ts;
  return state;
}

describe("legalWitnessStepDestinations — 8-way adjacency from Witness", () => {
  it("returns all 8 adjacent tiles when Witness is at the centre with no blockers", () => {
    const state = setupWitnessActionState({ witnessAt: { x: 2, y: 2 } });
    const dests = legalWitnessStepDestinations(state, BOARD);
    expect(dests).toHaveLength(8);
    // Sanity-check a couple of corners.
    expect(dests.find((d) => d.x === 1 && d.y === 1)).toBeDefined();
    expect(dests.find((d) => d.x === 3 && d.y === 3)).toBeDefined();
  });

  it("clips out-of-bounds tiles when Witness is in a corner", () => {
    const state = setupWitnessActionState({ witnessAt: { x: 0, y: 0 } });
    const dests = legalWitnessStepDestinations(state, BOARD);
    // (0, 0) corner — only 3 of the 8 offsets land in-bounds.
    expect(dests).toHaveLength(3);
    expect(dests.find((d) => d.x === 1 && d.y === 0)).toBeDefined();
    expect(dests.find((d) => d.x === 0 && d.y === 1)).toBeDefined();
    expect(dests.find((d) => d.x === 1 && d.y === 1)).toBeDefined();
  });

  it("skips enemy-occupied tiles (Witness can't share a tile with an enemy)", () => {
    const state = setupWitnessActionState({ witnessAt: { x: 2, y: 2 } });
    const enc = state.encounter!;
    enc.enemies = [{
      instanceId: "minion-0",
      cardId: "crystanid-001",
      x: 3,
      y: 2,
      damageTaken: 0,
      alive: true,
      facing: 0,
    }];
    const dests = legalWitnessStepDestinations(state, BOARD);
    expect(dests.find((d) => d.x === 3 && d.y === 2)).toBeUndefined();
    // The other 7 adjacents still work.
    expect(dests).toHaveLength(7);
  });

  it("returns [] once the per-turn step cap has been hit", () => {
    const state = setupWitnessActionState();
    state.encounter!.turnState[state.currentDelverId]!.witnessStepsThisTurn =
      WITNESS_ACTION_STEP_CAP;
    expect(legalWitnessStepDestinations(state, BOARD)).toEqual([]);
  });

  it("returns [] when the quest has no Witness (Q1, witnessPosition null)", () => {
    const state = newCampaign();
    ensureEncounter(state, QUEST1);
    // No witness ever — gate kicks in before adjacency.
    expect(legalWitnessStepDestinations(state, BOARD)).toEqual([]);
  });
});

describe("stepWitness — gates and step accounting", () => {
  it("rejects when no card has been placed this turn (rulebook: weapon-card-first requirement)", () => {
    const state = setupWitnessActionState({ noCardPlaced: true });
    const r = stepWitness(state, state.currentDelverId, 2, 3, BOARD);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no-card-placed/);
    // Engine did NOT mutate Witness or the step counter on rejection.
    expect(state.encounter!.witnessPosition).toEqual({ x: 2, y: 2 });
    expect(state.encounter!.turnState[state.currentDelverId]!.witnessStepsThisTurn).toBe(0);
  });

  it("rejects when actionUsedThisTurn is already true (and witness steps = 0)", () => {
    const state = setupWitnessActionState({ actionUsed: true });
    const r = stepWitness(state, state.currentDelverId, 2, 3, BOARD);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/action-already-used/);
  });

  it("rejects when the destination isn't 8-way adjacent (no jumping)", () => {
    const state = setupWitnessActionState({ witnessAt: { x: 2, y: 2 } });
    const r = stepWitness(state, state.currentDelverId, 4, 4, BOARD);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/destination-not-reachable/);
  });

  it("rejects the 3rd step within a single Action", () => {
    const state = setupWitnessActionState();
    const heroId = state.currentDelverId;
    // Two valid 1-tile steps.
    const r1 = stepWitness(state, heroId, 2, 3, BOARD);
    expect(r1.ok).toBe(true);
    const r2 = stepWitness(state, heroId, 2, 4, BOARD);
    expect(r2.ok).toBe(true);
    expect(state.encounter!.turnState[heroId]!.witnessStepsThisTurn).toBe(2);
    // 3rd step hits the cap.
    const r3 = stepWitness(state, heroId, 3, 4, BOARD);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.reason).toMatch(/witness-step-cap-reached/);
  });

  it("first step latches actionUsedThisTurn; step 2 keeps it set without re-latching", () => {
    const state = setupWitnessActionState();
    const heroId = state.currentDelverId;
    expect(state.encounter!.turnState[heroId]!.actionUsedThisTurn).toBe(false);

    const r1 = stepWitness(state, heroId, 2, 3, BOARD);
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.latchedAction).toBe(true);
      expect(r1.stepsUsed).toBe(1);
      expect(r1.stepsRemaining).toBe(1);
    }
    expect(state.encounter!.turnState[heroId]!.actionUsedThisTurn).toBe(true);

    const r2 = stepWitness(state, heroId, 2, 4, BOARD);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.latchedAction).toBe(false); // not re-latched
      expect(r2.stepsUsed).toBe(2);
      expect(r2.stepsRemaining).toBe(0);
    }
  });

  it("moves Witness to the destination tile on success", () => {
    const state = setupWitnessActionState({ witnessAt: { x: 2, y: 2 } });
    const r = stepWitness(state, state.currentDelverId, 3, 3, BOARD);
    expect(r.ok).toBe(true);
    expect(state.encounter!.witnessPosition).toEqual({ x: 3, y: 3 });
  });
});

describe("stepWitness — pickup routing (rulebook + user request 2026-05-19)", () => {
  it("credits a minion-part drop to its OWNER delver (not the mover)", () => {
    const state = setupWitnessActionState({ witnessAt: { x: 2, y: 2 } });
    const enc = state.encounter!;
    // Drop belongs to the OTHER delver — proves Witness is a courier.
    const otherHeroId = state.currentDelverId === "hero-01" ? "hero-02" : "hero-01";
    enc.tileDrops = [{ x: 2, y: 3, heroId: otherHeroId, dropId: "minion-part" }];
    const before = state.minionParts[otherHeroId] ?? 0;

    const r = stepWitness(state, state.currentDelverId, 2, 3, BOARD);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pickups.minionParts[otherHeroId]).toBe(1);
    }
    expect(state.minionParts[otherHeroId]).toBe(before + 1);
    // Active delver's wallet is untouched.
    expect(state.minionParts[state.currentDelverId]).toBe(0);
    // Drop was removed from the board.
    expect(enc.tileDrops).toHaveLength(0);
  });

  it("credits a boss-part drop to its OWNER delver", () => {
    const state = setupWitnessActionState({ witnessAt: { x: 2, y: 2 } });
    const enc = state.encounter!;
    const heroId = state.currentDelverId;
    enc.tileDrops = [{ x: 2, y: 3, heroId, dropId: "boss-part" }];
    const before = state.bossParts[heroId] ?? 0;

    const r = stepWitness(state, heroId, 2, 3, BOARD);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pickups.bossParts[heroId]).toBe(1);
    expect(state.bossParts[heroId]).toBe(before + 1);
  });

  it("credits a Memory Fragment to the shared state.memoryChips pool", () => {
    const state = setupWitnessActionState({ witnessAt: { x: 2, y: 2 } });
    const enc = state.encounter!;
    enc.memoryFragments = [{ x: 2, y: 3 }];
    const before = state.memoryChips;

    const r = stepWitness(state, state.currentDelverId, 2, 3, BOARD);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pickups.memoryFragments).toBe(1);
    expect(state.memoryChips).toBe(before + 1);
    expect(enc.memoryFragments).toHaveLength(0);
  });

  it("claims everything on the destination tile in a single step (drops for BOTH delvers + fragment)", () => {
    const state = setupWitnessActionState({ witnessAt: { x: 2, y: 2 } });
    const enc = state.encounter!;
    enc.tileDrops = [
      { x: 2, y: 3, heroId: "hero-01", dropId: "minion-part" },
      { x: 2, y: 3, heroId: "hero-02", dropId: "minion-part" },
    ];
    enc.memoryFragments = [{ x: 2, y: 3 }];

    const r = stepWitness(state, state.currentDelverId, 2, 3, BOARD);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pickups.minionParts["hero-01"]).toBe(1);
      expect(r.pickups.minionParts["hero-02"]).toBe(1);
      expect(r.pickups.memoryFragments).toBe(1);
    }
    expect(state.minionParts["hero-01"]).toBe(1);
    expect(state.minionParts["hero-02"]).toBe(1);
    expect(state.memoryChips).toBe(1);
  });

  it("does NOT scoop drops on Witness's STARTING tile (only the destination)", () => {
    const state = setupWitnessActionState({ witnessAt: { x: 2, y: 2 } });
    const enc = state.encounter!;
    enc.tileDrops = [{ x: 2, y: 2, heroId: state.currentDelverId, dropId: "minion-part" }];

    const r = stepWitness(state, state.currentDelverId, 2, 3, BOARD);
    expect(r.ok).toBe(true);
    // Drop on the starting tile stays on the board — Witness is
    // LEAVING it, not landing on it.
    expect(enc.tileDrops).toHaveLength(1);
    expect(state.minionParts[state.currentDelverId]).toBe(0);
  });
});

describe("canBeginWitnessAction — action-menu button gate", () => {
  it("returns false when Witness isn't on the board (Q1)", () => {
    const state = newCampaign();
    ensureEncounter(state, QUEST1);
    expect(canBeginWitnessAction(state)).toBe(false);
  });

  it("returns false before a card has been placed this turn", () => {
    const state = setupWitnessActionState({ noCardPlaced: true });
    expect(canBeginWitnessAction(state)).toBe(false);
  });

  it("returns true after card placement (cold start)", () => {
    const state = setupWitnessActionState();
    expect(canBeginWitnessAction(state)).toBe(true);
  });

  it("returns false when action already used AND no Witness step taken", () => {
    const state = setupWitnessActionState({ actionUsed: true });
    expect(canBeginWitnessAction(state)).toBe(false);
  });

  it("returns TRUE when action used but Witness has 1 step remaining (continue same Action)", () => {
    const state = setupWitnessActionState();
    // Take step 1 (this latches actionUsedThisTurn).
    const r = stepWitness(state, state.currentDelverId, 2, 3, BOARD);
    expect(r.ok).toBe(true);
    expect(canBeginWitnessAction(state)).toBe(true);
  });

  it("returns false after both steps are spent", () => {
    const state = setupWitnessActionState();
    stepWitness(state, state.currentDelverId, 2, 3, BOARD);
    stepWitness(state, state.currentDelverId, 2, 4, BOARD);
    expect(canBeginWitnessAction(state)).toBe(false);
  });
});
