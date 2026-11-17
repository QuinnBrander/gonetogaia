/**
 * Tests for src/engine/encounter.ts.
 *
 * Covers the contract laid out in DESIGN.md §6.1:
 *   - bootstrap from quest spawn data,
 *   - idempotency on repeat calls,
 *   - rebuild when the existing encounter looks inconsistent,
 *   - spatial / instance lookups (alive vs dead, stacked delvers).
 */

import { describe, it, expect } from "vitest";

import { newCampaign, type CampaignState, type EncounterState } from "../state";
import { QUEST1, QUEST2, getQuestWave } from "../data";
import {
  ensureEncounter,
  resetEncounter,
  bootstrapWaveAtNumber,
  getEnemyAt,
  getDelverAt,
  getDelversAt,
  getEnemyInstance,
} from "../engine/encounter";

/** Deterministic "shuffle" — keeps the input order so tests are stable. */
const noShuffle = (pool: readonly string[]) => [...pool];

function freshState(): CampaignState {
  return newCampaign();
}

// Q1's wave 1 spawn is always hand-authored — narrow once at the
// top so the tests can read `delverStart` / `boss` / `minions`
// directly without re-narrowing in every assertion.
const W1 = QUEST1.waves[0]!;
if (W1.spawn.kind !== "hand-authored") {
  throw new Error(`Expected Q1 W1 spawn to be hand-authored, got "${W1.spawn.kind}"`);
}
const W1_SPAWN = W1.spawn;

describe("ensureEncounter", () => {
  it("bootstraps from quest1 spawn when state.encounter is null", () => {
    const state = freshState();
    expect(state.encounter).toBeNull();

    const enc = ensureEncounter(state, QUEST1, noShuffle);

    expect(enc.questId).toBe(QUEST1.id);
    expect(enc.waveNumber).toBe(1);
    expect(state.encounter).toBe(enc);
  });

  it("places both delvers at the spawn delverStart tile", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST1, noShuffle);

    const start = W1_SPAWN.delverStart;
    expect(enc.delverPositions["hero-01"]).toEqual({ x: start.x, y: start.y });
    expect(enc.delverPositions["hero-02"]).toEqual({ x: start.x, y: start.y });
  });

  it("creates 1 boss + N minions, all alive at full HP", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST1, noShuffle);

    const expectedCount = 1 + W1_SPAWN.minions.length;
    expect(enc.enemies).toHaveLength(expectedCount);
    expect(enc.enemies.every((e) => e.alive)).toBe(true);
    expect(enc.enemies.every((e) => e.damageTaken === 0)).toBe(true);

    const boss = enc.enemies.find((e) => e.instanceId === "boss")!;
    expect(boss.cardId).toBe(W1.bossEnemyId);
    expect(boss.x).toBe(W1_SPAWN.boss.x);
    expect(boss.y).toBe(W1_SPAWN.boss.y);
  });

  it("uses stable instance ids minion-0..minion-N for the minion spawns", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST1, noShuffle);

    const minionInstanceIds = enc.enemies
      .filter((e) => e.instanceId !== "boss")
      .map((e) => e.instanceId);
    expect(minionInstanceIds).toEqual(
      W1_SPAWN.minions.map((_, i) => `minion-${i}`),
    );
  });

  it("assigns each spawn slot a card from the quest's minion pool", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST1, noShuffle);

    const minionCards = enc.enemies
      .filter((e) => e.instanceId !== "boss")
      .map((e) => e.cardId);
    // No duplicates and every assignment must come from the pool.
    expect(new Set(minionCards).size).toBe(minionCards.length);
    for (const id of minionCards) {
      expect(W1.minionEnemyIds).toContain(id);
    }
  });

  it("is idempotent: a second call returns the same encounter object", () => {
    const state = freshState();
    const a = ensureEncounter(state, QUEST1, noShuffle);
    a.enemies[0]!.damageTaken = 1; // simulate in-progress damage
    const b = ensureEncounter(state, QUEST1, noShuffle);

    expect(b).toBe(a);
    expect(b.enemies[0]!.damageTaken).toBe(1); // damage preserved
  });

  it("rebuilds when the existing encounter is for a different quest", () => {
    const state = freshState();
    const a = ensureEncounter(state, QUEST1, noShuffle);
    a.questId = "some-other-quest";
    const b = ensureEncounter(state, QUEST1, noShuffle);

    expect(b).not.toBe(a);
    expect(b.questId).toBe(QUEST1.id);
  });

  it("rebuilds when an enemy cardId is no longer recognised", () => {
    const state = freshState();
    const a = ensureEncounter(state, QUEST1, noShuffle);
    a.enemies[0]!.cardId = "ghost-card-id";
    const b = ensureEncounter(state, QUEST1, noShuffle);

    expect(b).not.toBe(a);
  });
});

describe("resetEncounter", () => {
  it("forces a rebuild even when an encounter is already present", () => {
    const state = freshState();
    const a = ensureEncounter(state, QUEST1, noShuffle);
    a.enemies[0]!.damageTaken = 5;

    const b = resetEncounter(state, QUEST1, noShuffle);
    expect(b).not.toBe(a);
    expect(b.enemies[0]!.damageTaken).toBe(0);
  });
});

// --- Spatial lookups ----------------------------------------------------

function withEncounter(): { state: CampaignState; enc: EncounterState } {
  const state = freshState();
  const enc = ensureEncounter(state, QUEST1, noShuffle);
  return { state, enc };
}

describe("getEnemyAt", () => {
  it("finds a live enemy on its tile", () => {
    const { enc } = withEncounter();
    const boss = enc.enemies.find((e) => e.instanceId === "boss")!;
    expect(getEnemyAt(enc, boss.x, boss.y)).toBe(boss);
  });

  it("returns null on an empty tile", () => {
    const { enc } = withEncounter();
    // Pick a tile we know has no spawn (top-left corner is empty in QUEST1).
    expect(getEnemyAt(enc, 0, 0)).toBeNull();
  });

  it("ignores dead enemies", () => {
    const { enc } = withEncounter();
    const boss = enc.enemies.find((e) => e.instanceId === "boss")!;
    boss.alive = false;
    expect(getEnemyAt(enc, boss.x, boss.y)).toBeNull();
  });
});

describe("getDelverAt / getDelversAt", () => {
  it("getDelverAt returns the hero's current position", () => {
    const { enc } = withEncounter();
    const start = W1_SPAWN.delverStart;
    expect(getDelverAt(enc, "hero-01")).toEqual({ x: start.x, y: start.y });
  });

  it("getDelverAt returns null for an unknown hero id", () => {
    const { enc } = withEncounter();
    expect(getDelverAt(enc, "hero-99")).toBeNull();
  });

  it("getDelversAt returns BOTH heroes when they share the spawn tile", () => {
    const { enc } = withEncounter();
    const start = W1_SPAWN.delverStart;
    const ids = getDelversAt(enc, start.x, start.y);
    expect(ids).toHaveLength(2);
    expect(ids).toContain("hero-01");
    expect(ids).toContain("hero-02");
  });

  it("getDelversAt returns just one when they split up", () => {
    const { enc } = withEncounter();
    enc.delverPositions["hero-02"] = { x: 4, y: 4 };
    expect(getDelversAt(enc, 4, 4)).toEqual(["hero-02"]);
  });
});

describe("getEnemyInstance", () => {
  it("returns the instance whose id matches", () => {
    const { enc } = withEncounter();
    const boss = getEnemyInstance(enc, "boss");
    expect(boss).not.toBeNull();
    expect(boss!.instanceId).toBe("boss");
  });

  it("returns null when the id is unknown", () => {
    const { enc } = withEncounter();
    expect(getEnemyInstance(enc, "minion-999")).toBeNull();
  });
});

// --- Slice 4b.2: turnState + preparedToRun bootstrapping -----------------

describe("buildEncounter — Slice 4b.2 fields", () => {
  it("initializes turnState for both heroes with all-null/false defaults", () => {
    const { enc } = withEncounter();

    for (const heroId of ["hero-01", "hero-02"]) {
      expect(enc.turnState[heroId]).toEqual({
        cardPlacedThisTurn: null,
        actionUsedThisTurn: false,
        movementUsedThisTurn: false,
        movementStepsThisTurn: 0,
        apMovementDoubledThisTurn: false,
        actionGrantedExtraMovement: false,
        damage2xUsedThisTurn: false,
        // Per-type Double Damage latch (HeroTurnState.doubleDamageActive)
        // — empty bag at turn start; populated when the player spends
        // a `damage-2x-*` consumable token.
        doubleDamageActive: {},
        witnessStepsThisTurn: 0,
        movementSnapshot: null,
      });
    }
  });

  it("initializes preparedToRun to false for both heroes", () => {
    const { enc } = withEncounter();

    expect(enc.preparedToRun["hero-01"]).toBe(false);
    expect(enc.preparedToRun["hero-02"]).toBe(false);
  });

  it("rebuilds when a saved encounter is missing the new fields", () => {
    const state = freshState();
    const a = ensureEncounter(state, QUEST1, noShuffle);
    // Simulate a v9 save (pre-Slice 4b.2) loaded into v10 code.
    delete (a as Partial<typeof a>).turnState;
    delete (a as Partial<typeof a>).preparedToRun;

    const b = ensureEncounter(state, QUEST1, noShuffle);

    expect(b).not.toBe(a);
    expect(b.turnState["hero-01"]).toBeDefined();
    expect(b.preparedToRun["hero-01"]).toBe(false);
  });
});

// --- Stage 5: phase-machine bootstrap (DESIGN.md §4) ---------------------

describe("buildEncounter — phase machine fields", () => {
  it("starts in the first-turn-pick phase with default cursors", () => {
    // Q1 (hand-authored) used to land directly in `hero` — since
    // the 2026-05-20 wiring of the pre-hero "who takes turn 1?"
    // picker, every wave parks in `first-turn-pick` first so the
    // player can review each delver's suit board before committing.
    const { enc } = withEncounter();
    expect(enc.phase).toBe("first-turn-pick");
    expect(enc.partingShotCursor).toBe(0);
    expect(enc.endWaveRefresh).toBeNull();
    expect(enc.endOfWavePageId).toBeNull();
    expect(enc.endOfWaveOutcome).toBeNull();
  });

  it("rebuilds when a saved encounter is missing phase-machine fields", () => {
    const state = freshState();
    const a = ensureEncounter(state, QUEST1, noShuffle);
    // Simulate a v13 save loaded under v14.
    delete (a as Partial<typeof a>).phase;
    delete (a as Partial<typeof a>).partingShotCursor;

    const b = ensureEncounter(state, QUEST1, noShuffle);

    expect(b).not.toBe(a);
    expect(b.phase).toBe("first-turn-pick");
    expect(b.partingShotCursor).toBe(0);
    expect(b.endWaveRefresh).toBeNull();
  });
});

describe("bootstrapWaveAtNumber — explicit-wave bootstrapping (Q2 W1→W2)", () => {
  it("builds a Q2 W2 encounter on demand and seeds the W2 enemy cardIds", () => {
    // After Q2 W1 victory the UI calls `completeWave` and then
    // `bootstrapWaveAtNumber(state, QUEST2, 2)` — this is the
    // single hook that gets the player onto the Wave 2 board.
    const state = newCampaign();
    const w2 = getQuestWave(QUEST2, 2);

    const enc = bootstrapWaveAtNumber(state, QUEST2, 2);

    expect(enc.questId).toBe(QUEST2.id);
    expect(enc.waveNumber).toBe(2);
    expect(state.encounter).toBe(enc);
    // Hundredeyes (W2 boss) must be present on the board.
    const bossOnBoard = enc.enemies.some((e) => e.cardId === w2.bossEnemyId);
    expect(bossOnBoard, `expected ${w2.bossEnemyId} on Q2 W2 board`).toBe(true);
    // Every spawned enemy belongs to the W2 catalog (boss + 7 minions).
    const w2Catalog = new Set<string>([w2.bossEnemyId, ...w2.minionEnemyIds]);
    for (const e of enc.enemies) {
      expect(w2Catalog.has(e.cardId), `unexpected cardId ${e.cardId} for Q2 W2`).toBe(true);
    }
  });

  it("Q2 W2 is a spawn-deck wave -> starts in delver-spawn-pick", () => {
    // Both W1 and W2 of Q2 use the spawn-deck system, so a
    // freshly-bootstrapped W2 must drop us into the spawn-pick
    // phase (UI lets the player place each delver before the
    // wave actually starts).
    const state = newCampaign();
    const enc = bootstrapWaveAtNumber(state, QUEST2, 2);
    expect(enc.phase).toBe("delver-spawn-pick");
  });

  it("builds a Q2 W3 encounter on demand with Sporecloud + Death Cap ids only", () => {
    // After Q2 W2 victory \u00b7 Follow Shouts, the UI calls
    // `bootstrapWaveAtNumber(state, QUEST2, 3)` so the next
    // BoardScreen render lands on the W3 board.
    const state = newCampaign();
    const w3 = getQuestWave(QUEST2, 3);

    const enc = bootstrapWaveAtNumber(state, QUEST2, 3);

    expect(enc.questId).toBe(QUEST2.id);
    expect(enc.waveNumber).toBe(3);
    expect(state.encounter).toBe(enc);
    // Death Cap must be present on the board.
    const bossOnBoard = enc.enemies.some((e) => e.cardId === w3.bossEnemyId);
    expect(bossOnBoard, `expected ${w3.bossEnemyId} on Q2 W3 board`).toBe(true);
    // Every spawned enemy belongs to the W3 catalog (boss + 7 minions).
    const w3Catalog = new Set<string>([w3.bossEnemyId, ...w3.minionEnemyIds]);
    for (const e of enc.enemies) {
      expect(w3Catalog.has(e.cardId), `unexpected cardId ${e.cardId} for Q2 W3`).toBe(true);
    }
  });

  it("Q2 W3 starts in delver-spawn-pick (spawn-deck wave)", () => {
    const state = newCampaign();
    const enc = bootstrapWaveAtNumber(state, QUEST2, 3);
    expect(enc.phase).toBe("delver-spawn-pick");
  });
});
