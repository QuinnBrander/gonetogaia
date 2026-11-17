/**
 * Tests for the spawn-deck variant of `engine/encounter.ts` —
 * Quest #2's encounter bootstrap path. Complements the existing
 * `encounter.test.ts` suite (which covers Q1's hand-authored
 * variant) by exercising:
 *
 *   - `buildEncounter` draws a Spawn Card via the injected
 *     `drawSpawnCardNumber` hook and seats boss + 7 minions on
 *     the card's printed tiles.
 *   - Both delvers default to compass tile A, leaving the
 *     encounter parked in `"delver-spawn-pick"`.
 *   - `assignDelverToTile` mutates one delver's position to
 *     either compass tile (and rejects bad inputs).
 *   - `startWaveAfterPick` flips the phase and dispatches the
 *     injected `startHeroTurn` exactly once.
 *   - `isConsistent` (via `ensureEncounter` idempotency) accepts
 *     an in-progress spawn-deck encounter without redrawing.
 */

import { describe, it, expect, vi } from "vitest";

import { newCampaign, type CampaignState } from "../state";
import { QUEST1, QUEST2, getSpawnCard } from "../data";
import {
  assignDelverToTile,
  commitFirstTurnPick,
  ensureEncounter,
  resetEncounter,
  startWaveAfterPick,
  type EncounterBuildHooks,
} from "../engine/encounter";
import { buildEncounterTokens } from "../board/tideBoard";

const noShuffle = (pool: readonly string[]) => [...pool];

/**
 * Pin both spawn-card draw + minion shuffle so the encounter
 * setup is deterministic. The picked card # 1 is arbitrary —
 * any base-deck number works; `1` keeps the assertions readable.
 */
function pinnedHooks(spawnCardNumber: number = 1): EncounterBuildHooks {
  return {
    assign: noShuffle,
    drawSpawnCardNumber: () => spawnCardNumber,
  };
}

function freshState(): CampaignState {
  return newCampaign();
}

describe("buildEncounter — spawn-deck variant (Quest 2 Wave 1)", () => {
  it("draws a Spawn Card via the injected hook and records its number", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(3));
    expect(enc.spawnCardDrawn).toBe(3);
  });

  it("parks the wave in delver-spawn-pick phase pending the player's choice", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks());
    expect(enc.phase).toBe("delver-spawn-pick");
  });

  it("seats 1 boss + 7 minions on the drawn card's printed tiles", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    const card = getSpawnCard(1);
    expect(enc.enemies).toHaveLength(8);
    const boss = enc.enemies.find((e) => e.instanceId === "boss")!;
    expect(boss.x).toBe(card.bosses[0]!.x);
    expect(boss.y).toBe(card.bosses[0]!.y);
    // Every minion sits on one of the card's printed minion tiles.
    const minionTiles = new Set(card.minions.map((m) => `${m.x},${m.y}`));
    for (const e of enc.enemies.filter((e) => e.instanceId !== "boss")) {
      expect(minionTiles.has(`${e.x},${e.y}`)).toBe(true);
    }
  });

  it("defaults BOTH delvers to compass tile A (rulebook: stacking is legal)", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    const tileA = getSpawnCard(1).delverSpawns[0]!;
    expect(enc.delverPositions["hero-01"]).toEqual({ x: tileA.x, y: tileA.y });
    expect(enc.delverPositions["hero-02"]).toEqual({ x: tileA.x, y: tileA.y });
  });

  it("uses the wave's printed minion pool (no Q1 ids leak in)", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks());
    const minionCards = enc.enemies
      .filter((e) => e.instanceId !== "boss")
      .map((e) => e.cardId);
    for (const id of minionCards) {
      expect(QUEST2.waves[0]!.minionEnemyIds).toContain(id);
    }
  });

  it("assigns the Q2 W1 boss (goldmonger-002) regardless of which card was drawn", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(7));
    const boss = enc.enemies.find((e) => e.instanceId === "boss")!;
    expect(boss.cardId).toBe(QUEST2.waves[0]!.bossEnemyId);
    expect(boss.cardId).toBe("goldmonger-002");
  });
});

describe("buildEncounter — hand-authored variant still works (Q1 regression)", () => {
  it("Q1 wave 1 sets spawnCardDrawn = null (no draw happened)", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST1, noShuffle);
    expect(enc.spawnCardDrawn).toBeNull();
    // Hand-authored waves skip the compass-tile picker but still
    // enter the first-turn picker — see `engine/encounter.ts >
    // resolveSpawn.hand-authored` for the rationale.
    expect(enc.phase).toBe("first-turn-pick");
  });

  it("Q1 wave 1 leaves memoryFragments empty (no spawn card glyph)", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST1, noShuffle);
    expect(enc.memoryFragments).toEqual([]);
  });
});

describe("buildEncounter — Memory Fragments from the drawn Spawn Card", () => {
  it("populates encounter.memoryFragments from the card's printed glyphs (#1: 1 fragment)", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    const expected = getSpawnCard(1).memoryFragments.map((m) => ({ x: m.x, y: m.y }));
    expect(enc.memoryFragments).toEqual(expected);
    // Sanity — spawn card #1 actually ships with 1 diamond glyph.
    expect(enc.memoryFragments.length).toBeGreaterThan(0);
  });

  it("stays empty for cards with no printed diamond glyph (#2: 0 fragments)", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(2));
    expect(enc.memoryFragments).toEqual([]);
  });

  it("returned fragment array is a fresh copy (mutating it doesn't mutate the catalog)", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    enc.memoryFragments.pop(); // drain locally
    const catalog = getSpawnCard(1).memoryFragments;
    expect(catalog.length).toBeGreaterThan(0); // catalog unchanged
  });
});

describe("buildEncounterTokens — Memory Fragment token emission", () => {
  it("emits one `memory-fragment` BoardToken per entry on the encounter, with the label 'Memory Chip'", () => {
    // Token display name was renamed from "Memory Fragment" to
    // "Memory Chip" (BoardToken.name in tideBoard.ts emitter) to
    // match the printed in-game terminology. The TOKEN KIND
    // (`memory-fragment`) and short label (`MF`) stay the same for
    // backward-compat with renderers + saves.
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    const tokens = buildEncounterTokens(enc);
    const mfTokens = tokens.filter((t) => t.kind === "memory-fragment");
    expect(mfTokens).toHaveLength(enc.memoryFragments.length);
    for (const t of mfTokens) {
      expect(t.name).toBe("Memory Chip");
      expect(t.label).toBe("MF");
      // Token coord must match a registered fragment entry.
      expect(enc.memoryFragments.some((m) => m.x === t.col && m.y === t.row)).toBe(true);
    }
  });

  it("emits no `memory-fragment` tokens for hand-authored Q1 encounters", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST1, noShuffle);
    const tokens = buildEncounterTokens(enc);
    expect(tokens.filter((t) => t.kind === "memory-fragment")).toHaveLength(0);
  });

  it("uses stable per-tile token ids (renderers can diff by id across renders)", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    const a = buildEncounterTokens(enc).filter((t) => t.kind === "memory-fragment");
    const b = buildEncounterTokens(enc).filter((t) => t.kind === "memory-fragment");
    expect(a.map((t) => t.id)).toEqual(b.map((t) => t.id));
  });
});

describe("ensureEncounter — isConsistent across both spawn variants", () => {
  it("Q2: idempotent — second call returns the SAME encounter (no redraw)", () => {
    const state = freshState();
    const a = ensureEncounter(state, QUEST2, pinnedHooks(2));
    // Tag the in-progress encounter so we can see if we got a fresh one.
    a.enemies[0]!.damageTaken = 3;
    const b = ensureEncounter(state, QUEST2, pinnedHooks(8));
    expect(b).toBe(a);
    expect(b.enemies[0]!.damageTaken).toBe(3);
    // The drawn card MUST NOT have changed.
    expect(b.spawnCardDrawn).toBe(2);
  });

  it("Q2: rebuilds when spawnCardDrawn was somehow cleared (data drift)", () => {
    const state = freshState();
    const a = ensureEncounter(state, QUEST2, pinnedHooks(2));
    a.spawnCardDrawn = null; // simulate v30 save accidentally surviving
    const b = ensureEncounter(state, QUEST2, pinnedHooks(5));
    expect(b).not.toBe(a);
    expect(b.spawnCardDrawn).toBe(5);
  });

  it("Q1: rebuilds when spawnCardDrawn was set non-null (schema drift the other way)", () => {
    const state = freshState();
    const a = ensureEncounter(state, QUEST1, noShuffle);
    a.spawnCardDrawn = 4; // Q1 should never carry a drawn-card number
    const b = ensureEncounter(state, QUEST1, noShuffle);
    expect(b).not.toBe(a);
    expect(b.spawnCardDrawn).toBeNull();
  });

  it("Q2: rebuilds when the drawn card number stops resolving in the catalog", () => {
    const state = freshState();
    const a = ensureEncounter(state, QUEST2, pinnedHooks(2));
    a.spawnCardDrawn = 999; // not in SPAWN_CARDS
    const b = ensureEncounter(state, QUEST2, pinnedHooks(2));
    expect(b).not.toBe(a);
  });
});

describe("resetEncounter — spawn-deck redraw", () => {
  it("forces a fresh draw, picks up a new spawn-card number", () => {
    const state = freshState();
    const a = ensureEncounter(state, QUEST2, pinnedHooks(1));
    const b = resetEncounter(state, QUEST2, pinnedHooks(5));
    expect(b).not.toBe(a);
    expect(b.spawnCardDrawn).toBe(5);
  });
});

describe("assignDelverToTile", () => {
  it("moves the chosen delver to compass tile B; the other stays on A", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    const tileA = getSpawnCard(1).delverSpawns[0]!;
    const tileB = getSpawnCard(1).delverSpawns[1]!;
    assignDelverToTile(state, "hero-01", tileB.x, tileB.y);
    expect(enc.delverPositions["hero-01"]).toEqual({ x: tileB.x, y: tileB.y });
    expect(enc.delverPositions["hero-02"]).toEqual({ x: tileA.x, y: tileA.y });
  });

  it("is idempotent — same tile twice doesn't error", () => {
    const state = freshState();
    ensureEncounter(state, QUEST2, pinnedHooks(1));
    const tileB = getSpawnCard(1).delverSpawns[1]!;
    expect(() => {
      assignDelverToTile(state, "hero-01", tileB.x, tileB.y);
      assignDelverToTile(state, "hero-01", tileB.x, tileB.y);
    }).not.toThrow();
  });

  it("throws when the target isn't one of the drawn card's compass tiles", () => {
    const state = freshState();
    ensureEncounter(state, QUEST2, pinnedHooks(1));
    expect(() => assignDelverToTile(state, "hero-01", 0, 0))
      .toThrow(/not a printed compass tile/);
  });

  it("throws when the heroId isn't part of the encounter", () => {
    const state = freshState();
    ensureEncounter(state, QUEST2, pinnedHooks(1));
    const tileA = getSpawnCard(1).delverSpawns[0]!;
    expect(() => assignDelverToTile(state, "hero-99", tileA.x, tileA.y))
      .toThrow(/unknown heroId/);
  });

  it("throws when the encounter isn't in the pick phase", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    enc.phase = "hero";
    const tileA = getSpawnCard(1).delverSpawns[0]!;
    expect(() => assignDelverToTile(state, "hero-01", tileA.x, tileA.y))
      .toThrow(/expected "delver-spawn-pick"/);
  });
});

describe("startWaveAfterPick", () => {
  it("flips phase to first-turn-pick (NOT hero) and does NOT dispatch startHeroTurn", () => {
    // The hero turn no longer kicks off inside startWaveAfterPick —
    // it waits for the player to commit a starting delver via the
    // second-stage `commitFirstTurnPick`. The hook arg is kept for
    // source compat with screen + QA call sites but is unused now.
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    const start = vi.fn<(s: CampaignState) => void>();
    startWaveAfterPick(state, start);
    expect(enc.phase).toBe("first-turn-pick");
    expect(start).not.toHaveBeenCalled();
  });

  it("is a no-op outside the pick phase (no double-fire on stray clicks)", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    enc.phase = "hero";
    const start = vi.fn<(s: CampaignState) => void>();
    startWaveAfterPick(state, start);
    expect(enc.phase).toBe("hero"); // unchanged
    expect(start).not.toHaveBeenCalled();
  });

  it("is a no-op when there is no encounter at all", () => {
    const state = freshState();
    const start = vi.fn<(s: CampaignState) => void>();
    expect(() => startWaveAfterPick(state, start)).not.toThrow();
    expect(start).not.toHaveBeenCalled();
  });
});

describe("commitFirstTurnPick — second-stage pre-hero picker", () => {
  it("flips first-turn-pick → hero, writes currentDelverId, fires startHeroTurn once", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    // Advance to first-turn-pick via the compass-tile commit step.
    startWaveAfterPick(state, () => { /* no-op for stage 1 */ });
    expect(enc.phase).toBe("first-turn-pick");

    const start = vi.fn<(s: CampaignState) => void>();
    commitFirstTurnPick(state, "hero-02", start);
    expect(enc.phase).toBe("hero");
    expect(state.currentDelverId).toBe("hero-02");
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(state);
  });

  it("is a no-op outside the first-turn-pick phase", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    // Still in delver-spawn-pick — commit must early-return without
    // mutating phase or firing the hook.
    expect(enc.phase).toBe("delver-spawn-pick");
    const start = vi.fn<(s: CampaignState) => void>();
    commitFirstTurnPick(state, "hero-01", start);
    expect(enc.phase).toBe("delver-spawn-pick");
    expect(start).not.toHaveBeenCalled();
  });

  it("throws on unknown heroId (defensive — the picker UI only ever commits a real delver)", () => {
    const state = freshState();
    ensureEncounter(state, QUEST2, pinnedHooks(1));
    startWaveAfterPick(state, () => { /* no-op */ });
    expect(() => commitFirstTurnPick(state, "hero-99", () => { /* no-op */ }))
      .toThrow(/unknown hero/);
  });

  it("Q1 (hand-authored) commitFirstTurnPick walks straight through (no spawn-pick step)", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST1, noShuffle);
    expect(enc.phase).toBe("first-turn-pick");
    const start = vi.fn<(s: CampaignState) => void>();
    commitFirstTurnPick(state, "hero-01", start);
    expect(enc.phase).toBe("hero");
    expect(state.currentDelverId).toBe("hero-01");
    expect(start).toHaveBeenCalledTimes(1);
  });
});

// `shuffleSpawnDeck` + `drawSpawnCard` already have their own deterministic
// tests in `spawnCards.test.ts` — the assertion below pins that the
// default draw path *also* terminates with a real card (the default
// hook composes those two and the encounter must end up with a number
// in the printed range).
describe("default spawn-card draw path (no test hook)", () => {
  it("produces a spawnCardDrawn in the printed catalog range", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2); // no hooks, real RNG
    expect(enc.spawnCardDrawn).not.toBeNull();
    expect(enc.spawnCardDrawn!).toBeGreaterThanOrEqual(1);
    // SPAWN_CARDS ships 12 base cards (numbers 1..12); spawnCards
    // 13-14 are reserved for future quest-specific cards.
    expect(enc.spawnCardDrawn!).toBeLessThanOrEqual(14);
    // The card MUST resolve — the encounter setup assertions would
    // have thrown otherwise.
    expect(() => getSpawnCard(enc.spawnCardDrawn!)).not.toThrow();
  });
});
