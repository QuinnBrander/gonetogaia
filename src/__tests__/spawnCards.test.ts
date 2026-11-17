/**
 * Spawn Deck contract tests — pin the per-card invariants and
 * draw-pile semantics that downstream Quest #2+ setup will rely on.
 *
 * What this file covers:
 *   - Catalog shape: SPAWN_CARDS holds the 12 base cards (1..12),
 *     each lookup-able by `getSpawnCard(number)`.
 *   - Per-card invariants (the "what's printed on every card") so a
 *     copy/paste typo when adding card #13/#14 later fails loudly
 *     instead of silently producing a malformed encounter:
 *       * exactly 1 boss
 *       * exactly 7 minions
 *       * exactly 2 delver-spawn compasses
 *       * 0 or 1 memory-fragment glyphs
 *       * all markers inside the 5x5 grid (0..4 on both axes)
 *       * no two markers share a coordinate (a tile can't host both
 *         a boss and a delver-spawn etc.)
 *   - Image path follows the `spawn-card-NN.png` convention so the
 *     viewer's `<img src>` resolves under `/public/spawn-cards/`.
 *   - `shuffleSpawnDeck` produces a permutation of the catalog
 *     (no missing / duplicate numbers) and is deterministic when
 *     given a deterministic RNG (this is the property Q2's setup
 *     will lean on for replays + tests).
 *   - `drawSpawnCard` pops the top card without mutating the
 *     input pile and throws on empty (per the rulebook, an empty
 *     pile must be reshuffled before drawing — the caller is
 *     responsible for that, not the helper).
 */

import { describe, it, expect } from "vitest";
import {
  SPAWN_CARDS,
  getSpawnCard,
  shuffleSpawnDeck,
  shuffleSpawnDeckWithFriendly,
  drawSpawnCard,
  FRIENDLY_SPAWN_CARD_NUMBERS,
} from "../data";

describe("Spawn Deck catalog", () => {
  it("ships 12 base cards (1..12) + 2 friendly (13, 14) + 6 Lieutenants spawn cards (19-24)", () => {
    expect(SPAWN_CARDS).toHaveLength(20);
    const numbers = SPAWN_CARDS.map((c) => c.number);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 19, 20, 21, 22, 23, 24]);
    expect(FRIENDLY_SPAWN_CARD_NUMBERS).toEqual([13, 14]);
  });

  it("getSpawnCard returns the correct card for every shipped number", () => {
    for (let n = 1; n <= 14; n++) {
      const card = getSpawnCard(n);
      expect(card.number).toBe(n);
    }
  });

  it("getSpawnCard throws on unknown numbers (config error, not runtime)", () => {
    expect(() => getSpawnCard(0)).toThrow(/Unknown spawn card/);
    expect(() => getSpawnCard(15)).toThrow(/Unknown spawn card/);
    expect(() => getSpawnCard(-1)).toThrow(/Unknown spawn card/);
  });

  it("friendly spawn cards (#13, #14) carry at least one friendly-encounter glyph", () => {
    for (const n of FRIENDLY_SPAWN_CARD_NUMBERS) {
      const card = getSpawnCard(n);
      expect(card.friendlyEncounters?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("base spawn cards (#01..#12) have no friendly-encounter glyphs", () => {
    for (let n = 1; n <= 12; n++) {
      const card = getSpawnCard(n);
      expect(card.friendlyEncounters?.length ?? 0).toBe(0);
    }
  });

  it("each card's image filename follows the spawn-card-NN.png convention", () => {
    for (const card of SPAWN_CARDS) {
      const padded = String(card.number).padStart(2, "0");
      expect(card.image).toBe(`spawn-card-${padded}.png`);
    }
  });

  describe.each(SPAWN_CARDS)("Card #$number", (card) => {
    it("has exactly 1 boss", () => {
      expect(card.bosses).toHaveLength(1);
    });

    it("has exactly 7 minions", () => {
      expect(card.minions).toHaveLength(7);
    });

    it("has exactly 2 delver-spawn compasses", () => {
      expect(card.delverSpawns).toHaveLength(2);
    });

    it("has 0 or 1 memory-fragment glyphs", () => {
      expect(card.memoryFragments.length).toBeGreaterThanOrEqual(0);
      expect(card.memoryFragments.length).toBeLessThanOrEqual(1);
    });

    it("keeps every marker inside the 5x5 grid", () => {
      const all = [
        ...card.bosses,
        ...card.minions,
        ...card.delverSpawns,
        ...card.memoryFragments,
        ...(card.friendlyEncounters ?? []),
      ];
      for (const m of all) {
        expect(m.x).toBeGreaterThanOrEqual(0);
        expect(m.x).toBeLessThanOrEqual(4);
        expect(m.y).toBeGreaterThanOrEqual(0);
        expect(m.y).toBeLessThanOrEqual(4);
      }
    });

    it("never places two markers on the same tile", () => {
      const all = [
        ...card.bosses.map((m) => ({ ...m, kind: "boss" })),
        ...card.minions.map((m) => ({ ...m, kind: "minion" })),
        ...card.delverSpawns.map((m) => ({ ...m, kind: "delver" })),
        ...card.memoryFragments.map((m) => ({ ...m, kind: "fragment" })),
        ...((card.friendlyEncounters ?? []).map((m) => ({ ...m, kind: "friendly" }))),
      ];
      const seen = new Map<string, string>();
      for (const m of all) {
        const key = `${m.x},${m.y}`;
        const prior = seen.get(key);
        if (prior) {
          throw new Error(
            `Card #${card.number} stacks ${prior} and ${m.kind} on (${m.x},${m.y})`,
          );
        }
        seen.set(key, m.kind);
      }
      // (assertion is the implicit "no throw" path; explicit assert
      // gives vitest a hook to count this test as having actually
      // checked something.)
      expect(seen.size).toBe(all.length);
    });
  });
});

/**
 * Tiny LCG seeded with a fixed value — gives deterministic shuffle
 * order across runs so the test can assert exact draw sequence
 * (we care about determinism, not statistical uniformity here —
 * Fisher-Yates correctness is tested separately by the permutation
 * check). Using a custom RNG instead of Math.random keeps the test
 * stable even if the test runner reseeds Math.random under us.
 */
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("shuffleSpawnDeck", () => {
  it("returns a permutation of the BASE 12 cards (friendly cards excluded)", () => {
    const rng = seededRng(42);
    const shuffled = shuffleSpawnDeck(rng);
    expect(shuffled).toHaveLength(12);
    expect(new Set(shuffled).size).toBe(shuffled.length);
    expect([...shuffled].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // Friendly cards stay OUT of the base shuffle until they're
    // explicitly granted via `shuffleSpawnDeckWithFriendly`.
    expect(shuffled).not.toContain(13);
    expect(shuffled).not.toContain(14);
  });

  it("is deterministic for a fixed RNG seed (replay-friendly)", () => {
    const a = shuffleSpawnDeck(seededRng(123));
    const b = shuffleSpawnDeck(seededRng(123));
    expect(a).toEqual(b);
  });

  it("different seeds usually produce different orders", () => {
    const a = shuffleSpawnDeck(seededRng(1));
    const b = shuffleSpawnDeck(seededRng(2));
    expect(a).not.toEqual(b);
  });

  it("returns a fresh array (mutating the result doesn't affect future shuffles)", () => {
    const first = shuffleSpawnDeck(seededRng(7));
    first.length = 0;
    const second = shuffleSpawnDeck(seededRng(7));
    expect(second).toHaveLength(12);
  });
});

describe("shuffleSpawnDeckWithFriendly", () => {
  it("with no friendly grants, returns the same base 12 cards", () => {
    const a = shuffleSpawnDeck(seededRng(42));
    const b = shuffleSpawnDeckWithFriendly([], seededRng(42));
    expect(b).toEqual(a);
  });

  it("adds owned friendly cards to the pile (each entry one slot)", () => {
    const shuffled = shuffleSpawnDeckWithFriendly([13], seededRng(5));
    expect(shuffled).toHaveLength(13);
    expect(shuffled).toContain(13);
    // Friendly cards are placed at index 0 so they are drawn first.
    expect(shuffled[0]).toBe(13);
    expect([...shuffled].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
  });

  it("with both friendlies granted, both appear before base cards", () => {
    const shuffled = shuffleSpawnDeckWithFriendly([13, 14], seededRng(5));
    expect(shuffled).toHaveLength(14);
    expect(shuffled[0]).toBe(13);
    expect(shuffled[1]).toBe(14);
    expect([...shuffled].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
  });

  it("is deterministic for a fixed RNG seed (replay-friendly)", () => {
    const a = shuffleSpawnDeckWithFriendly([13], seededRng(99));
    const b = shuffleSpawnDeckWithFriendly([13], seededRng(99));
    expect(a).toEqual(b);
  });
});

describe("drawSpawnCard", () => {
  it("pops the top card and returns the rest", () => {
    const pile = [3, 7, 1, 9];
    const { card, remaining } = drawSpawnCard(pile);
    expect(card.number).toBe(3);
    expect(remaining).toEqual([7, 1, 9]);
  });

  it("does not mutate the input pile (immutable draw)", () => {
    const pile = [5, 2, 8] as const;
    const before = [...pile];
    drawSpawnCard(pile);
    expect([...pile]).toEqual(before);
  });

  it("can be chained: draw, draw, draw resolves to consecutive top cards", () => {
    let pile: readonly number[] = shuffleSpawnDeck(seededRng(99));
    const drawn: number[] = [];
    for (let i = 0; i < 3; i++) {
      const step = drawSpawnCard(pile);
      drawn.push(step.card.number);
      pile = step.remaining;
    }
    // The seed-99 deterministic shuffle's first three numbers MUST be
    // the same three drawn back, in order.
    const seedOrder = shuffleSpawnDeck(seededRng(99));
    expect(drawn).toEqual(seedOrder.slice(0, 3));
    expect(pile).toEqual(seedOrder.slice(3));
  });

  it("throws on an empty pile (rulebook: reshuffle the discard first)", () => {
    expect(() => drawSpawnCard([])).toThrow(/empty pile/i);
  });
});
