/**
 * Unit tests for the Friendly Spawn Card + Friendly Encounter
 * engine (`engine/friendlyEncounter.ts`).
 *
 * Covers:
 *   - grantFriendlySpawnCard: picks the next printed number in
 *     order (13 then 14), idempotent vs. already-owned, returns
 *     the right reward event.
 *   - collectFriendlyEncountersAt: drains tokens at a tile and
 *     pushes draws onto `pendingFriendlyEncounters`; idempotent
 *     for empty tiles / no encounter.
 *   - resolveFriendlyEncounter: pops the head, returns a
 *     friendly-encounter-resolved event with the right name +
 *     image; idempotent for empty queue.
 *   - hasPendingFriendlyEncounter: boolean predicate.
 *
 * Engine bootstrap integration (spawn-deck draw consumes friendly
 * card; board state seeds `friendlyEncounters`) lives in
 * `encounter.test.ts` so the wiring is exercised end-to-end there.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { newCampaign, type CampaignState } from "../state";
import {
  grantFriendlySpawnCard,
  collectFriendlyEncountersAt,
  resolveFriendlyEncounter,
  hasPendingFriendlyEncounter,
} from "../engine/friendlyEncounter";

let state: CampaignState;
beforeEach(() => {
  state = newCampaign();
});

describe("grantFriendlySpawnCard", () => {
  it("first grant picks card #13 and appends to friendlySpawnDeck", () => {
    const events = grantFriendlySpawnCard(state);
    expect(state.friendlySpawnDeck).toEqual([13]);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.kind).toBe("friendly-spawn-card-gained");
    if (ev.kind !== "friendly-spawn-card-gained") throw new Error("kind mismatch");
    expect(ev.cardNumber).toBe(13);
    expect(ev.image).toBe("spawn-card-13.png");
    expect(ev.deckSize).toBe(1);
  });

  it("second grant picks card #14 (printed order continues)", () => {
    grantFriendlySpawnCard(state);
    const events = grantFriendlySpawnCard(state);
    expect(state.friendlySpawnDeck).toEqual([13, 14]);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    if (ev.kind !== "friendly-spawn-card-gained") throw new Error("kind mismatch");
    expect(ev.cardNumber).toBe(14);
    expect(ev.deckSize).toBe(2);
  });

  it("third grant is a silent no-op (both printed cards already owned)", () => {
    grantFriendlySpawnCard(state);
    grantFriendlySpawnCard(state);
    const events = grantFriendlySpawnCard(state);
    expect(events).toEqual([]);
    expect(state.friendlySpawnDeck).toEqual([13, 14]);
  });

  it("storage order is numeric-ascending (stable across saves)", () => {
    state.friendlySpawnDeck = [14];
    const events = grantFriendlySpawnCard(state);
    expect(state.friendlySpawnDeck).toEqual([13, 14]);
    if (events[0]?.kind === "friendly-spawn-card-gained") {
      expect(events[0].cardNumber).toBe(13);
    }
  });
});

describe("collectFriendlyEncountersAt", () => {
  it("returns [] when there is no encounter", () => {
    state.encounter = null;
    const drawn = collectFriendlyEncountersAt(state, 0, 0);
    expect(drawn).toEqual([]);
    expect(state.pendingFriendlyEncounters).toEqual([]);
  });

  it("returns [] when the encounter has no friendly tokens", () => {
    state.encounter = makeEmptyEncounter();
    const drawn = collectFriendlyEncountersAt(state, 0, 0);
    expect(drawn).toEqual([]);
  });

  it("drains a token on the matching tile and pushes a card number onto pendingFriendlyEncounters", () => {
    const enc = makeEmptyEncounter();
    enc.friendlyEncounters = [{ x: 2, y: 3 }];
    state.encounter = enc;
    const drawn = collectFriendlyEncountersAt(state, 2, 3);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]).toBe(1); // today only card #01 in the deck
    expect(state.pendingFriendlyEncounters).toEqual([1]);
    expect(enc.friendlyEncounters).toEqual([]);
  });

  it("leaves tokens on other tiles alone", () => {
    const enc = makeEmptyEncounter();
    enc.friendlyEncounters = [
      { x: 2, y: 3 },
      { x: 4, y: 4 },
    ];
    state.encounter = enc;
    const drawn = collectFriendlyEncountersAt(state, 2, 3);
    expect(drawn).toHaveLength(1);
    expect(enc.friendlyEncounters).toEqual([{ x: 4, y: 4 }]);
  });

  it("drains multiple tokens on the same tile (defensive: one card per token)", () => {
    const enc = makeEmptyEncounter();
    enc.friendlyEncounters = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ];
    state.encounter = enc;
    const drawn = collectFriendlyEncountersAt(state, 0, 0);
    expect(drawn).toHaveLength(2);
    expect(state.pendingFriendlyEncounters).toHaveLength(2);
    expect(enc.friendlyEncounters).toEqual([]);
  });

  it("appends to (rather than replaces) the pending queue", () => {
    state.pendingFriendlyEncounters = [99];
    const enc = makeEmptyEncounter();
    enc.friendlyEncounters = [{ x: 1, y: 1 }];
    state.encounter = enc;
    collectFriendlyEncountersAt(state, 1, 1);
    expect(state.pendingFriendlyEncounters).toEqual([99, 1]);
  });
});

describe("resolveFriendlyEncounter", () => {
  it("returns [] on an empty queue (idempotent)", () => {
    const events = resolveFriendlyEncounter(state);
    expect(events).toEqual([]);
  });

  it("pops the head and returns the Flambé reward batch (parts grant + headline)", () => {
    // Card #01 (Flambé) now resolves AUTOMATICALLY: both delvers
    // gain `roll` minion parts AND the headline
    // `friendly-encounter-resolved` event is emitted. The headline
    // is always the LAST entry so the rewards modal renders the
    // parts change first then the celebration card. We pass an
    // explicit `preRoll` so the test is deterministic.
    state.pendingFriendlyEncounters = [1];
    const events = resolveFriendlyEncounter(state, 4);
    expect(state.pendingFriendlyEncounters).toEqual([]);
    expect(events).toHaveLength(2);
    const partsEv = events[0]!;
    expect(partsEv.kind).toBe("creature-parts-changed");
    if (partsEv.kind !== "creature-parts-changed") throw new Error("kind mismatch");
    expect(partsEv.partKind).toBe("minion");
    expect(partsEv.direction).toBe("gain");
    // Both delvers gained 4 parts each.
    for (const rec of partsEv.recipients) {
      expect(rec.after - rec.before).toBe(4);
    }
    const headlineEv = events.at(-1)!;
    expect(headlineEv.kind).toBe("friendly-encounter-resolved");
    if (headlineEv.kind !== "friendly-encounter-resolved") throw new Error("kind mismatch");
    expect(headlineEv.cardNumber).toBe(1);
    expect(headlineEv.name).toBe("Flambe");
    expect(headlineEv.image).toBe("friendly-monster-front-01.png");
  });

  it("preserves trailing queue entries (multi-pickup case)", () => {
    state.pendingFriendlyEncounters = [1, 1];
    resolveFriendlyEncounter(state);
    expect(state.pendingFriendlyEncounters).toEqual([1]);
  });
});

describe("hasPendingFriendlyEncounter", () => {
  it("returns false on a fresh campaign", () => {
    expect(hasPendingFriendlyEncounter(state)).toBe(false);
  });

  it("returns true when the queue has entries", () => {
    state.pendingFriendlyEncounters = [1];
    expect(hasPendingFriendlyEncounter(state)).toBe(true);
  });
});

// ----- helpers -----

function makeEmptyEncounter(): NonNullable<CampaignState["encounter"]> {
  return {
    questId: "quest1",
    waveNumber: 1,
    delverPositions: {},
    witnessPosition: null,
    enemies: [],
    turnState: {},
    preparedToRun: {},
    phase: "hero",
    partingShotCursor: 0,
    endWaveRefresh: null,
    endOfWavePageId: null,
    endOfWaveOutcome: null,
    levelUpDeck: [],
    levelUpDiscard: [],
    pendingLevelUpDraws: [],
    pendingElementChoices: [],
    pendingEquipmentRolls: [],
    pendingXpRolls: [],
    pendingOpinionRankPicks: [],
    pendingCreaturePartChoices: [],
    beamRepeatsRemaining: {},
    tileDrops: [],
    spawnCardDrawn: null,
    memoryFragments: [],
    friendlyEncounters: [],
    countdownTokens: 0,
    accurateMarks: {},
    omenTokens: {},
    rebirthTiles: [],
    enemyDiedThisHeroTurn: false,
    combatOnlyTokens: [],
    stolenWeapon: null,
    ritualSacrifices: [],
    pendingRitualPicks: [],
    corruption: null,
  };
}
