/**
 * Tests for src/engine/wave.ts — the wave phase machine.
 *
 * Covers:
 *   - Hero → Parting Shots transition (both prepared latch).
 *   - Parting Shot resolution per pattern kind (all-delvers /
 *     nearest-delver / delvers-within), including the active-player
 *     tie chooser.
 *   - Auto-advance from Parting Shots → End Wave when no alive
 *     enemy remains (3-phase wave; there is no Interlude).
 *   - End Wave refresh: weapons returned to hand, per-Wave AP refresh
 *     (`currentAp = baseAp` per delver — AP unification 2026-05-09),
 *     idempotency latch; on defeat too.
 *   - "If continuing" effects (`applyContinuingEndWaveEffects`):
 *     `heal-at-end-of-wave` Armor heals.
 *   - End of Wave routing (victory page1_1 vs defeat page1_2).
 *   - Delver-death short-circuit from any phase (rulebook p26).
 *   - Wave completion + retry resets.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { newCampaign, type CampaignState } from "../state";
import { QUEST1, QUEST2, getEnemy } from "../data";
import { commitFirstTurnPick, ensureEncounter } from "../engine/encounter";
import { startHeroTurn, endHeroTurn, prepareToRun } from "../engine/turn";
import {
  bothPrepared,
  completeWave,
  endQuestReset,
  enterEndOfWave,
  findPartingShotShieldOpportunities,
  maybeEnterPartingShotsAfterTurn,
  nextPartingShotEnemy,
  onDelverDamaged,
  partingShotNeedsChoice,
  resetWaveForRetry,
  resolvePartingShot,
  applyContinuingEndWaveEffects,
} from "../engine/wave";

const noShuffle = (pool: readonly string[]) => [...pool];

function freshState(): CampaignState {
  const s = newCampaign();
  ensureEncounter(s, QUEST1, noShuffle);
  // ensureEncounter lands a Q1 encounter in `first-turn-pick`
  // (every wave goes through the new first-turn picker since the
  // 2026-05-20 wiring). Commit hero-01 as the starting delver so
  // the encounter advances into `hero` phase + the first
  // `startHeroTurn` fires, which is what all the wave-flow
  // assertions below rely on.
  commitFirstTurnPick(s, "hero-01", startHeroTurn);
  return s;
}

// --- Hero → Parting Shots --------------------------------------------------

describe("bothPrepared / maybeEnterPartingShotsAfterTurn", () => {
  it("bothPrepared is false until BOTH delvers latch preparedToRun", () => {
    const s = freshState();
    expect(bothPrepared(s.encounter!)).toBe(false);

    s.encounter!.preparedToRun["hero-01"] = true;
    expect(bothPrepared(s.encounter!)).toBe(false);

    s.encounter!.preparedToRun["hero-02"] = true;
    expect(bothPrepared(s.encounter!)).toBe(true);
  });

  it("maybeEnter... no-ops while phase is hero and not both prepared", () => {
    const s = freshState();
    s.encounter!.preparedToRun["hero-01"] = true;
    const phase = maybeEnterPartingShotsAfterTurn(s);
    expect(phase).toBe("hero");
    expect(s.encounter!.phase).toBe("hero");
  });

  it("transitions to parting-shots when both have prepared", () => {
    const s = freshState();
    s.encounter!.preparedToRun["hero-01"] = true;
    s.encounter!.preparedToRun["hero-02"] = true;
    const phase = maybeEnterPartingShotsAfterTurn(s);
    expect(phase).toBe("parting-shots");
    expect(s.encounter!.phase).toBe("parting-shots");
    expect(s.encounter!.partingShotCursor).toBe(0);
  });

  it("endHeroTurn fires the transition when both delvers are now prepared", () => {
    const s = freshState();
    // Realistic precondition: both delvers have exhausted every
    // playable weapon into a slot, so the auto-prepare path will fire
    // (and its sibling self-heal in `startHeroTurn` won't clear the
    // latch). We still call `prepareToRun` explicitly afterwards to
    // be belt-and-braces about the latch on hero-01 (whose
    // `startHeroTurn` already ran inside `freshState()` against a
    // full hand and so didn't auto-latch).
    s.loadouts["hero-01"]!.slotCards[0] = "mind-hammer-r1";
    s.loadouts["hero-01"]!.slotCards[1] = "mind-shield-r1";
    s.loadouts["hero-01"]!.slotCards[2] = "mind-beam-r1";
    s.loadouts["hero-02"]!.slotCards[0] = "body-gauntlet-r1";
    s.loadouts["hero-02"]!.slotCards[1] = "body-sword-r1";
    prepareToRun(s, "hero-01");
    prepareToRun(s, "hero-02");
    expect(s.encounter!.phase).toBe("hero");

    endHeroTurn(s);
    expect(s.encounter!.phase).toBe("parting-shots");
  });
});

// --- Parting Shots ---------------------------------------------------------

/** Force an encounter into the parting-shots phase with a single
 * controlled enemy lineup so the test can pick which pattern fires. */
function setupPartingShotsScenario(
  enemyCardIds: string[],
  delverPositions: Record<string, { x: number; y: number }>,
  enemyPositions: Array<{ x: number; y: number }>,
): CampaignState {
  const s = freshState();
  const enc = s.encounter!;
  enc.delverPositions = delverPositions;
  enc.enemies = enemyCardIds.map((cardId, idx) => ({
    instanceId: idx === 0 ? "boss" : `minion-${idx - 1}`,
    cardId,
    x: enemyPositions[idx]!.x,
    y: enemyPositions[idx]!.y,
    damageTaken: 0,
    alive: true,
    facing: 0,
  }));
  enc.phase = "parting-shots";
  enc.partingShotCursor = 0;
  return s;
}

describe("Parting Shots — all-delvers pattern (rulebook p26)", () => {
  it("hits BOTH delvers regardless of position", () => {
    // crystanid-001 has partingShot { kind: "all-delvers", damage: 1 }.
    const s = setupPartingShotsScenario(
      ["crystanid-001"],
      { "hero-01": { x: 0, y: 0 }, "hero-02": { x: 4, y: 4 } },
      [{ x: 2, y: 2 }],
    );
    const hpBefore01 = s.loadouts["hero-01"]!.currentHp;
    const hpBefore02 = s.loadouts["hero-02"]!.currentHp;

    const result = resolvePartingShot(s);

    expect(result).not.toBeNull();
    expect(result!.hits).toHaveLength(2);
    expect(s.loadouts["hero-01"]!.currentHp).toBe(hpBefore01 - 1);
    expect(s.loadouts["hero-02"]!.currentHp).toBe(hpBefore02 - 1);
    // Single enemy → cursor walks past, the wave ends (End Wave).
    expect(s.encounter!.phase).toBe("end-of-wave");
  });
});

describe("Parting Shots — nearest-delver pattern", () => {
  it("hits ONLY the closer delver when distances differ", () => {
    // crystanid-002 is partingShot { kind: "nearest-delver", damage: 2 }.
    // Place enemy at (2,2). hero-01 at (2,2) (distance 0), hero-02 at (4,4) (distance 2).
    const s = setupPartingShotsScenario(
      ["crystanid-002"],
      { "hero-01": { x: 2, y: 2 }, "hero-02": { x: 4, y: 4 } },
      [{ x: 2, y: 2 }],
    );
    const hpBefore01 = s.loadouts["hero-01"]!.currentHp;
    const hpBefore02 = s.loadouts["hero-02"]!.currentHp;

    const result = resolvePartingShot(s);

    expect(result!.hits).toEqual([{ heroId: "hero-01", damage: 2 }]);
    expect(s.loadouts["hero-01"]!.currentHp).toBe(hpBefore01 - 2);
    expect(s.loadouts["hero-02"]!.currentHp).toBe(hpBefore02);
  });

  it("flags the tie path when both delvers tie on distance", () => {
    // Both delvers at (2,2), enemy at (2,2) — distance 0 for both.
    const s = setupPartingShotsScenario(
      ["crystanid-002"],
      { "hero-01": { x: 2, y: 2 }, "hero-02": { x: 2, y: 2 } },
      [{ x: 2, y: 2 }],
    );
    const enemy = nextPartingShotEnemy(s.encounter!)!;
    const card = getEnemy(enemy.cardId);

    expect(partingShotNeedsChoice(s.encounter!, enemy, card)).toBe(true);
  });

  it("respects the active-player chooser on a tie", () => {
    const s = setupPartingShotsScenario(
      ["crystanid-002"],
      { "hero-01": { x: 2, y: 2 }, "hero-02": { x: 2, y: 2 } },
      [{ x: 2, y: 2 }],
    );
    const hpBefore01 = s.loadouts["hero-01"]!.currentHp;
    const hpBefore02 = s.loadouts["hero-02"]!.currentHp;

    const result = resolvePartingShot(s, { chosenDelverId: "hero-02" });
    expect(result!.hits).toEqual([{ heroId: "hero-02", damage: 2 }]);
    expect(result!.chosenDelverId).toBe("hero-02");
    expect(s.loadouts["hero-01"]!.currentHp).toBe(hpBefore01);
    expect(s.loadouts["hero-02"]!.currentHp).toBe(hpBefore02 - 2);
  });
});

describe("Parting Shots — delvers-within pattern", () => {
  it("hits delvers within Chebyshev range, ignores outside", () => {
    // crystanid-003 is partingShot { kind: "delvers-within", damage: 2, range: 2 }.
    // Enemy at (2,2). hero-01 at (3,3) (distance 1) → IN. hero-02 at (4,4) (distance 2) → IN.
    const s = setupPartingShotsScenario(
      ["crystanid-003"],
      { "hero-01": { x: 3, y: 3 }, "hero-02": { x: 4, y: 4 } },
      [{ x: 2, y: 2 }],
    );
    const before = {
      "hero-01": s.loadouts["hero-01"]!.currentHp,
      "hero-02": s.loadouts["hero-02"]!.currentHp,
    };

    const result = resolvePartingShot(s);

    // Both inside range 2 → both hit for 2.
    expect(result!.hits).toHaveLength(2);
    expect(s.loadouts["hero-01"]!.currentHp).toBe(before["hero-01"] - 2);
    expect(s.loadouts["hero-02"]!.currentHp).toBe(before["hero-02"] - 2);
  });

  it("ignores delvers OUTSIDE the printed range", () => {
    // Enemy at (0,0). hero-01 at (1,1) (distance 1) IN. hero-02 at (4,4) (distance 4) OUT.
    const s = setupPartingShotsScenario(
      ["crystanid-003"],
      { "hero-01": { x: 1, y: 1 }, "hero-02": { x: 4, y: 4 } },
      [{ x: 0, y: 0 }],
    );
    const before = {
      "hero-01": s.loadouts["hero-01"]!.currentHp,
      "hero-02": s.loadouts["hero-02"]!.currentHp,
    };

    const result = resolvePartingShot(s);
    expect(result!.hits).toEqual([{ heroId: "hero-01", damage: 2 }]);
    expect(s.loadouts["hero-01"]!.currentHp).toBe(before["hero-01"] - 2);
    expect(s.loadouts["hero-02"]!.currentHp).toBe(before["hero-02"]);
  });
});

describe("Parting Shots — sequence + dead-enemy skip", () => {
  it("walks alive enemies one-at-a-time and advances the cursor", () => {
    // Three enemies, all alive, all small "1 damage" patterns.
    const s = setupPartingShotsScenario(
      ["crystanid-001", "crystanid-005", "crystanid-007"],
      { "hero-01": { x: 0, y: 0 }, "hero-02": { x: 4, y: 4 } },
      [{ x: 2, y: 2 }, { x: 1, y: 1 }, { x: 3, y: 3 }],
    );

    const r0 = resolvePartingShot(s);
    expect(r0!.enemyInstanceId).toBe("boss");
    expect(s.encounter!.partingShotCursor).toBe(1);

    const r1 = resolvePartingShot(s);
    expect(r1!.enemyInstanceId).toBe("minion-0");
    expect(s.encounter!.partingShotCursor).toBe(2);

    // Last one — phase should auto-advance.
    const r2 = resolvePartingShot(s);
    expect(r2!.enemyInstanceId).toBe("minion-1");
    expect(s.encounter!.phase).toBe("end-of-wave");
  });

  it("skips dead enemies entirely (no parting shot, no hits)", () => {
    const s = setupPartingShotsScenario(
      ["crystanid-001", "crystanid-005"],
      { "hero-01": { x: 0, y: 0 }, "hero-02": { x: 4, y: 4 } },
      [{ x: 2, y: 2 }, { x: 3, y: 3 }],
    );
    s.encounter!.enemies[0]!.alive = false;
    const before01 = s.loadouts["hero-01"]!.currentHp;

    // First call: cursor at 0 (dead boss) — should advance to minion-0
    // and resolve THAT one immediately.
    const r0 = resolvePartingShot(s);
    expect(r0!.enemyInstanceId).toBe("minion-0");
    // Only minion-0's parting shot (crystanid-005, "1 Damage." → all-delvers)
    // applied, not the dead boss's.
    expect(s.loadouts["hero-01"]!.currentHp).toBe(before01 - 1);
    // Phase advances — only one alive enemy, and we just resolved it.
    expect(s.encounter!.phase).toBe("end-of-wave");
  });
});

// --- Parting Shots — Q2 lose-XP / lose-elements / combo (Venena 011, 012, Goldmonger)

describe("Parting Shots — all-delvers-lose-xp pattern (Venena 011)", () => {
  it("drains the shared XP pool by the printed amount and reports xpLost", () => {
    // venena-011: partingShot { kind: "all-delvers-lose-xp", amount: 2 }
    const s = setupPartingShotsScenario(
      ["venena-011"],
      { "hero-01": { x: 0, y: 0 }, "hero-02": { x: 4, y: 4 } },
      [{ x: 2, y: 2 }],
    );
    s.xpOnHand = 5;
    const hpBefore01 = s.loadouts["hero-01"]!.currentHp;
    const hpBefore02 = s.loadouts["hero-02"]!.currentHp;

    const result = resolvePartingShot(s);

    expect(result).not.toBeNull();
    expect(result!.xpLost).toBe(2);
    expect(s.xpOnHand).toBe(3);
    // Lose-XP variant has no per-delver effects -> hits[] is empty.
    expect(result!.hits).toEqual([]);
    // Delvers take no damage.
    expect(s.loadouts["hero-01"]!.currentHp).toBe(hpBefore01);
    expect(s.loadouts["hero-02"]!.currentHp).toBe(hpBefore02);
  });

  it("clamps at 0 XP when the pool is shorter than the drain amount", () => {
    const s = setupPartingShotsScenario(
      ["venena-011"],
      { "hero-01": { x: 0, y: 0 }, "hero-02": { x: 4, y: 4 } },
      [{ x: 2, y: 2 }],
    );
    s.xpOnHand = 1;

    const result = resolvePartingShot(s);

    // Only 1 XP available - report 1 drained, not 2 (honest reporting).
    expect(result!.xpLost).toBe(1);
    expect(s.xpOnHand).toBe(0);
  });

  it("xpLost reports 0 when the pool was already empty", () => {
    const s = setupPartingShotsScenario(
      ["venena-011"],
      { "hero-01": { x: 0, y: 0 }, "hero-02": { x: 4, y: 4 } },
      [{ x: 2, y: 2 }],
    );
    s.xpOnHand = 0;

    const result = resolvePartingShot(s);

    expect(result!.xpLost).toBe(0);
    expect(s.xpOnHand).toBe(0);
  });
});

describe("Parting Shots — all-delvers-lose-elements pattern (Venena 012)", () => {
  it("zeroes both delvers' element bags on amount: 'all' and reports cleared count per delver", () => {
    // venena-012: partingShot { kind: "all-delvers-lose-elements", amount: "all" }
    const s = setupPartingShotsScenario(
      ["venena-012"],
      { "hero-01": { x: 0, y: 0 }, "hero-02": { x: 4, y: 4 } },
      [{ x: 2, y: 2 }],
    );
    s.elements["hero-01"] = { earth: 2, fire: 1 };
    s.elements["hero-02"] = { water: 3 };

    const result = resolvePartingShot(s);

    expect(result).not.toBeNull();
    expect(result!.xpLost).toBe(0);
    // One hit row per delver (Object.keys insertion order on delverPositions).
    expect(result!.hits.map((h) => h.heroId).sort()).toEqual(["hero-01", "hero-02"]);
    const h01 = result!.hits.find((h) => h.heroId === "hero-01")!;
    const h02 = result!.hits.find((h) => h.heroId === "hero-02")!;
    expect(h01).toEqual({ heroId: "hero-01", damage: 0, elementsCleared: 3 });
    expect(h02).toEqual({ heroId: "hero-02", damage: 0, elementsCleared: 3 });
    // Bags actually drained to zero.
    expect(s.elements["hero-01"]).toEqual({ earth: 0, fire: 0 });
    expect(s.elements["hero-02"]).toEqual({ water: 0 });
  });

  it("reports elementsCleared: 0 when the bag was already empty", () => {
    const s = setupPartingShotsScenario(
      ["venena-012"],
      { "hero-01": { x: 0, y: 0 }, "hero-02": { x: 4, y: 4 } },
      [{ x: 2, y: 2 }],
    );
    s.elements["hero-01"] = {};
    s.elements["hero-02"] = { earth: 0, fire: 0 };

    const result = resolvePartingShot(s);

    expect(result!.hits.every((h) => h.elementsCleared === 0)).toBe(true);
    expect(result!.hits.every((h) => h.damage === 0)).toBe(true);
  });
});

describe("Parting Shots — all-delvers-damage-and-lose-xp pattern (Goldmonger 002)", () => {
  it("damages BOTH delvers AND drains the shared XP pool", () => {
    // goldmonger-002: partingShot { kind: "all-delvers-damage-and-lose-xp", damage: 2, amount: "all" }
    const s = setupPartingShotsScenario(
      ["goldmonger-002"],
      { "hero-01": { x: 0, y: 0 }, "hero-02": { x: 4, y: 4 } },
      [{ x: 2, y: 2 }],
    );
    s.xpOnHand = 7;
    const hpBefore01 = s.loadouts["hero-01"]!.currentHp;
    const hpBefore02 = s.loadouts["hero-02"]!.currentHp;

    const result = resolvePartingShot(s);

    expect(result).not.toBeNull();
    // Damage on BOTH delvers (rulebook p26 -- combo still hits both).
    expect(result!.hits).toHaveLength(2);
    expect(result!.hits.every((h) => h.damage === 2)).toBe(true);
    expect(s.loadouts["hero-01"]!.currentHp).toBe(hpBefore01 - 2);
    expect(s.loadouts["hero-02"]!.currentHp).toBe(hpBefore02 - 2);
    // amount: "all" -> drains the full 7.
    expect(result!.xpLost).toBe(7);
    expect(s.xpOnHand).toBe(0);
  });

  it("xpLost is the actual drained amount (not the printed 'all') when pool is small", () => {
    const s = setupPartingShotsScenario(
      ["goldmonger-002"],
      { "hero-01": { x: 0, y: 0 }, "hero-02": { x: 4, y: 4 } },
      [{ x: 2, y: 2 }],
    );
    s.xpOnHand = 3;

    const result = resolvePartingShot(s);

    expect(result!.xpLost).toBe(3);
    expect(s.xpOnHand).toBe(0);
  });
});

describe("Parting Shots — all-delvers-damage-and-lose-elements pattern (Hundredeyes 003)", () => {
  it("damages BOTH delvers AND zeroes BOTH delvers' element bags on amount: 'all'", () => {
    // hundredeyes-003: partingShot { kind: "all-delvers-damage-and-lose-elements", damage: 3, amount: "all" }
    const s = setupPartingShotsScenario(
      ["hundredeyes-003"],
      { "hero-01": { x: 0, y: 0 }, "hero-02": { x: 4, y: 4 } },
      [{ x: 2, y: 2 }],
    );
    s.elements["hero-01"] = { earth: 2, fire: 1 };
    s.elements["hero-02"] = { water: 4 };
    const hpBefore01 = s.loadouts["hero-01"]!.currentHp;
    const hpBefore02 = s.loadouts["hero-02"]!.currentHp;

    const result = resolvePartingShot(s);

    expect(result).not.toBeNull();
    // Damage on BOTH delvers; XP pool is untouched (this is the
    // damage+elements combo, not damage+xp).
    expect(result!.xpLost).toBe(0);
    expect(result!.hits).toHaveLength(2);
    const h01 = result!.hits.find((h) => h.heroId === "hero-01")!;
    const h02 = result!.hits.find((h) => h.heroId === "hero-02")!;
    expect(h01.damage).toBe(3);
    expect(h02.damage).toBe(3);
    expect(h01.elementsCleared).toBe(3);
    expect(h02.elementsCleared).toBe(4);
    expect(s.loadouts["hero-01"]!.currentHp).toBe(hpBefore01 - 3);
    expect(s.loadouts["hero-02"]!.currentHp).toBe(hpBefore02 - 3);
    // Bags drained to zero.
    expect(s.elements["hero-01"]).toEqual({ earth: 0, fire: 0 });
    expect(s.elements["hero-02"]).toEqual({ water: 0 });
  });

  it("reports elementsCleared: 0 when the bag was already empty (still applies damage)", () => {
    const s = setupPartingShotsScenario(
      ["hundredeyes-003"],
      { "hero-01": { x: 0, y: 0 }, "hero-02": { x: 4, y: 4 } },
      [{ x: 2, y: 2 }],
    );
    s.elements["hero-01"] = {};
    s.elements["hero-02"] = { earth: 0 };
    const hpBefore01 = s.loadouts["hero-01"]!.currentHp;

    const result = resolvePartingShot(s);

    expect(result!.hits.every((h) => h.damage === 3)).toBe(true);
    expect(result!.hits.every((h) => h.elementsCleared === 0)).toBe(true);
    expect(s.loadouts["hero-01"]!.currentHp).toBe(hpBefore01 - 3);
  });
});

describe("Parting Shots — all-delvers-damage-and-discard-consumable pattern (Death Cap 004)", () => {
  it("damages BOTH delvers AND discards 1 consumable per delver (shallowest stack first)", () => {
    // deathcap-004: partingShot { kind: "all-delvers-damage-and-discard-consumable", damage: 4, count: 1 }
    const s = setupPartingShotsScenario(
      ["deathcap-004"],
      { "hero-01": { x: 0, y: 0 }, "hero-02": { x: 4, y: 4 } },
      [{ x: 2, y: 2 }],
    );
    // Hero-01: stacked bag — reroll (2) + damage-2x-medium (1).
    // Discard picks the SHALLOWEST = damage-2x-medium (1 → 0).
    s.consumableTokens["hero-01"] = {
      "reroll": { available: 2, spent: 0 },
      "damage-2x-medium": { available: 1, spent: 0 },
    };
    // Hero-02: single stack — prevent-counterattack (3).
    s.consumableTokens["hero-02"] = {
      "prevent-counterattack": { available: 3, spent: 0 },
    };
    const hpBefore01 = s.loadouts["hero-01"]!.currentHp;
    const hpBefore02 = s.loadouts["hero-02"]!.currentHp;

    const result = resolvePartingShot(s);

    expect(result).not.toBeNull();
    expect(result!.xpLost).toBe(0);
    expect(result!.hits).toHaveLength(2);
    const h01 = result!.hits.find((h) => h.heroId === "hero-01")!;
    const h02 = result!.hits.find((h) => h.heroId === "hero-02")!;
    expect(h01.damage).toBe(4);
    expect(h02.damage).toBe(4);
    expect(h01.consumablesDiscarded).toBe(1);
    expect(h02.consumablesDiscarded).toBe(1);
    expect(s.loadouts["hero-01"]!.currentHp).toBe(hpBefore01 - 4);
    expect(s.loadouts["hero-02"]!.currentHp).toBe(hpBefore02 - 4);
    // hero-01 lost the SHALLOWEST (damage-2x-medium 1→0). reroll untouched.
    expect(s.consumableTokens["hero-01"]!["damage-2x-medium"]!.available).toBe(0);
    expect(s.consumableTokens["hero-01"]!["reroll"]!.available).toBe(2);
    // hero-02's only stack was decremented.
    expect(s.consumableTokens["hero-02"]!["prevent-counterattack"]!.available).toBe(2);
  });

  it("reports consumablesDiscarded: 0 when the delver had no consumables (damage still applies)", () => {
    const s = setupPartingShotsScenario(
      ["deathcap-004"],
      { "hero-01": { x: 0, y: 0 }, "hero-02": { x: 4, y: 4 } },
      [{ x: 2, y: 2 }],
    );
    s.consumableTokens["hero-01"] = {};
    s.consumableTokens["hero-02"] = {
      "reroll": { available: 0, spent: 1 }, // all spent — nothing available
    };
    const hpBefore01 = s.loadouts["hero-01"]!.currentHp;
    const hpBefore02 = s.loadouts["hero-02"]!.currentHp;

    const result = resolvePartingShot(s);

    expect(result!.hits.every((h) => h.damage === 4)).toBe(true);
    expect(result!.hits.every((h) => h.consumablesDiscarded === 0)).toBe(true);
    expect(s.loadouts["hero-01"]!.currentHp).toBe(hpBefore01 - 4);
    expect(s.loadouts["hero-02"]!.currentHp).toBe(hpBefore02 - 4);
    // The parting shot itself never pivots spent→available; that's the
    // End Wave refresh, which runs right after this last parting shot.
    expect(s.encounter!.phase).toBe("end-of-wave");
    expect(s.encounter!.endWaveRefresh!.consumableTokensRefreshed).toBe(1);
    expect(s.consumableTokens["hero-02"]!["reroll"]).toEqual({ available: 1, spent: 0 });
  });

  it("discard removes from `available` (NOT `spent`) so the next End Wave refresh can't restore it", () => {
    const s = setupPartingShotsScenario(
      ["deathcap-004"],
      { "hero-01": { x: 0, y: 0 }, "hero-02": { x: 4, y: 4 } },
      [{ x: 2, y: 2 }],
    );
    s.consumableTokens["hero-01"] = {
      "reroll": { available: 2, spent: 0 },
    };
    s.consumableTokens["hero-02"] = {
      "reroll": { available: 2, spent: 0 },
    };

    resolvePartingShot(s);

    // Both delvers had identical bags; both lose 1 from `available`.
    // `spent` stays at 0 — the End Wave refresh would otherwise
    // pivot spent→available and restore the discarded token.
    expect(s.consumableTokens["hero-01"]!["reroll"]!.available).toBe(1);
    expect(s.consumableTokens["hero-01"]!["reroll"]!.spent).toBe(0);
    expect(s.consumableTokens["hero-02"]!["reroll"]!.available).toBe(1);
    expect(s.consumableTokens["hero-02"]!["reroll"]!.spent).toBe(0);
  });
});

describe("Parting Shots — Q1 regression: existing damage variants unchanged", () => {
  it("all-delvers variant still returns xpLost: 0 with no element fields", () => {
    const s = setupPartingShotsScenario(
      ["crystanid-001"],
      { "hero-01": { x: 0, y: 0 }, "hero-02": { x: 4, y: 4 } },
      [{ x: 2, y: 2 }],
    );

    const result = resolvePartingShot(s);

    expect(result!.xpLost).toBe(0);
    expect(result!.hits).toHaveLength(2);
    // Existing damage variants don't carry the elementsCleared key at all.
    expect(result!.hits.every((h) => h.elementsCleared === undefined)).toBe(true);
  });
});

// --- Parting-Shot Shield (post-2026-05-25) -------------------------------
//
// Sol / Lunar Shield can intercept parting-shot damage. The engine
// surfaces opportunities via `findPartingShotShieldOpportunities` and
// folds shield-spend reductions into the damage map before applying via
// `resolvePartingShot(state, { shieldChoices })`. Cap is 1 per parting
// shot (single source enemy = one counterattack worth of activations).

describe("Parting Shots — Sol / Lunar Shield interception", () => {
  it("findPartingShotShieldOpportunities returns the bearer when a damaged delver shares their tile", () => {
    // crystanid-001 (all-delvers, 1 damage). Both delvers stacked at
    // (1,2); Mind delver owns the Sol Shield by default + has earth.
    const s = setupPartingShotsScenario(
      ["crystanid-001"],
      { "hero-01": { x: 1, y: 2 }, "hero-02": { x: 1, y: 2 } },
      [{ x: 2, y: 2 }],
    );
    s.elements["hero-01"] = { earth: 1 };

    const ops = findPartingShotShieldOpportunities(s);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.shieldBearerHeroId).toBe("hero-01");
    expect(ops[0]!.maxActivations).toBe(1); // single parting shot = cap 1
    expect(ops[0]!.protectedDelvers.map((d) => d.heroId).sort())
      .toEqual(["hero-01", "hero-02"]);
  });

  it("returns empty when the shield-bearer has no elements to spend", () => {
    const s = setupPartingShotsScenario(
      ["crystanid-001"],
      { "hero-01": { x: 1, y: 2 }, "hero-02": { x: 1, y: 2 } },
      [{ x: 2, y: 2 }],
    );
    s.elements["hero-01"] = {};
    s.elements["hero-02"] = {};
    expect(findPartingShotShieldOpportunities(s)).toEqual([]);
  });

  it("returns empty for non-damage variants (XP drain only)", () => {
    // venena-011: all-delvers-lose-xp — no damage to block.
    const s = setupPartingShotsScenario(
      ["venena-011"],
      { "hero-01": { x: 1, y: 2 }, "hero-02": { x: 1, y: 2 } },
      [{ x: 2, y: 2 }],
    );
    s.elements["hero-01"] = { earth: 5 };
    expect(findPartingShotShieldOpportunities(s)).toEqual([]);
  });

  it("base spend reduces the parting-shot damage by 1 to every tile-mate", () => {
    // crystanid-001 (all-delvers, 1 damage). Mind spends 1 earth →
    // baseBlock = 1 → both tile-mates take 0 damage.
    const s = setupPartingShotsScenario(
      ["crystanid-001"],
      { "hero-01": { x: 1, y: 2 }, "hero-02": { x: 1, y: 2 } },
      [{ x: 2, y: 2 }],
    );
    s.elements["hero-01"] = { earth: 1 };
    const startMind = s.loadouts["hero-01"]!.currentHp;
    const startBody = s.loadouts["hero-02"]!.currentHp;

    const result = resolvePartingShot(s, {
      shieldChoices: { "hero-01": { kind: "spend", elements: ["earth"] } },
    });

    expect(result).toBeTruthy();
    expect(s.loadouts["hero-01"]!.currentHp).toBe(startMind);
    expect(s.loadouts["hero-02"]!.currentHp).toBe(startBody);
    expect(s.elements["hero-01"]!.earth).toBe(0);
    // Hits row reflects POST-shield damage so the log is honest.
    expect(result!.hits.every((h) => h.damage === 0)).toBe(true);
  });

  it("bonus radiance overblock heals the Sol Shield bearer", () => {
    // crystanid-001 (1 damage), Mind alone on tile so overblock-heal
    // fires (1 incoming, 2 block → 1 overblock × healPerOverblock=1).
    const s = setupPartingShotsScenario(
      ["crystanid-001"],
      { "hero-01": { x: 1, y: 2 }, "hero-02": { x: 4, y: 4 } },
      [{ x: 2, y: 2 }],
    );
    s.elements["hero-01"] = { radiance: 1 };
    s.loadouts["hero-01"]!.currentHp = 4;
    const maxHp = s.loadouts["hero-01"]!.maxHp;

    resolvePartingShot(s, {
      shieldChoices: { "hero-01": { kind: "spend", elements: ["radiance"] } },
    });

    // 1 incoming, 2 blocked → 0 damage taken + 1 overblock heal.
    expect(s.loadouts["hero-01"]!.currentHp).toBe(Math.min(maxHp, 5));
    expect(s.elements["hero-01"]!.radiance).toBe(0);
  });

  it("higher-damage parting shot fully blocked by the bonus element (Hundredeyes 3 damage + radiance)", () => {
    // hundredeyes-003: all-delvers-damage-and-lose-elements, damage 3.
    // Sol Shield bonusBlock = 2 → 1 damage gets through after 1 spend.
    // The element-drain side-effect still fires (per the printed text).
    const s = setupPartingShotsScenario(
      ["hundredeyes-003"],
      { "hero-01": { x: 1, y: 2 }, "hero-02": { x: 1, y: 2 } },
      [{ x: 2, y: 2 }],
    );
    s.elements["hero-01"] = { radiance: 1, earth: 2 };
    const startMind = s.loadouts["hero-01"]!.currentHp;
    const startBody = s.loadouts["hero-02"]!.currentHp;

    const result = resolvePartingShot(s, {
      shieldChoices: { "hero-01": { kind: "spend", elements: ["radiance"] } },
    });

    // 3 incoming, 2 blocked → 1 damage taken per tile-mate.
    expect(s.loadouts["hero-01"]!.currentHp).toBe(startMind - 1);
    expect(s.loadouts["hero-02"]!.currentHp).toBe(startBody - 1);
    // Element drain ran regardless of shield (the parting shot's
    // drain clause is unconditional). Earth bag was 2 → cleared to 0.
    expect(s.elements["hero-01"]!.earth).toBe(0);
    expect(s.elements["hero-01"]!.radiance).toBe(0);
    // hits[].elementsCleared reports drained-after-shield count (the
    // 1 radiance spent + 2 earth pre-existing all got drained).
    expect(result!.hits.find((h) => h.heroId === "hero-01")!.damage).toBe(1);
  });

  it("cap is 1 per parting shot — 2 elements supplied → engine truncates to 1", () => {
    const s = setupPartingShotsScenario(
      ["hundredeyes-003"], // 3 damage
      { "hero-01": { x: 1, y: 2 }, "hero-02": { x: 1, y: 2 } },
      [{ x: 2, y: 2 }],
    );
    s.elements["hero-01"] = { earth: 5 };
    const startMind = s.loadouts["hero-01"]!.currentHp;

    resolvePartingShot(s, {
      shieldChoices: { "hero-01": { kind: "spend", elements: ["earth", "earth", "earth"] } },
    });

    // Cap = 1 → only 1 element spent, blocking 1 of 3 damage.
    // Plus element drain still wipes everything to 0.
    expect(s.loadouts["hero-01"]!.currentHp).toBe(startMind - 2);
    // Earth count: started at 5, spent 1 to shield, 4 drained by
    // hundredeyes' all-elements drain → 0.
    expect(s.elements["hero-01"]!.earth).toBe(0);
  });

  it("nearest-delver parting shot routes shield to the chosen target's tile-mate", () => {
    // crystanid-002 (nearest-delver, 2 damage). Both delvers at the
    // same tile → tied → chosenDelverId picks. Sol Shield bonus-2
    // exactly covers it.
    const s = setupPartingShotsScenario(
      ["crystanid-002"],
      { "hero-01": { x: 1, y: 2 }, "hero-02": { x: 1, y: 2 } },
      [{ x: 2, y: 2 }],
    );
    s.elements["hero-01"] = { radiance: 1 };
    const startMind = s.loadouts["hero-01"]!.currentHp;
    const startBody = s.loadouts["hero-02"]!.currentHp;

    const result = resolvePartingShot(s, {
      chosenDelverId: "hero-02", // Body takes the hit
      shieldChoices: { "hero-01": { kind: "spend", elements: ["radiance"] } },
    });

    // Body got hit for 2, but Mind's shield blocks 2 → 0 damage.
    expect(s.loadouts["hero-02"]!.currentHp).toBe(startBody);
    expect(s.loadouts["hero-01"]!.currentHp).toBe(startMind);
    expect(result!.hits.find((h) => h.heroId === "hero-02")!.damage).toBe(0);
  });

  it("legacy resolve without shieldChoices is unchanged (regression)", () => {
    // No `shieldChoices` param → engine takes the pre-2026-05-25 path,
    // applying full damage even though a shield COULD have intercepted.
    const s = setupPartingShotsScenario(
      ["crystanid-001"],
      { "hero-01": { x: 1, y: 2 }, "hero-02": { x: 1, y: 2 } },
      [{ x: 2, y: 2 }],
    );
    s.elements["hero-01"] = { earth: 1 };
    const startMind = s.loadouts["hero-01"]!.currentHp;
    const startBody = s.loadouts["hero-02"]!.currentHp;

    resolvePartingShot(s);

    expect(s.loadouts["hero-01"]!.currentHp).toBe(startMind - 1);
    expect(s.loadouts["hero-02"]!.currentHp).toBe(startBody - 1);
    expect(s.elements["hero-01"]!.earth).toBe(1); // shield unspent
  });
});

// --- End Wave refresh + "if continuing" effects ---------------------------

describe("End Wave refresh (enterEndOfWave)", () => {
  it("returns all exhausted weapons to hand for both delvers", () => {
    const s = freshState();
    s.loadouts["hero-01"]!.slotCards[0] = "ion-cannon-beam";
    s.loadouts["hero-01"]!.slotCards[3] = "crash-hammer";
    s.loadouts["hero-02"]!.slotCards[1] = "soulshift-sword";

    enterEndOfWave(s, "victory");

    expect(s.loadouts["hero-01"]!.slotCards.every((c) => c === null)).toBe(true);
    expect(s.loadouts["hero-02"]!.slotCards.every((c) => c === null)).toBe(true);
    const result = s.encounter!.endWaveRefresh!;
    expect(result.weaponsRefreshed.find((w) => w.heroId === "hero-01")!.count).toBe(2);
    expect(result.weaponsRefreshed.find((w) => w.heroId === "hero-02")!.count).toBe(1);
  });

  it("also runs on a defeat", () => {
    const s = freshState();
    s.loadouts["hero-01"]!.slotCards[0] = "ion-cannon-beam";
    s.loadouts["hero-01"]!.currentAp = 0;
    s.loadouts["hero-01"]!.currentHp = 0;

    enterEndOfWave(s, "defeat");

    expect(s.loadouts["hero-01"]!.slotCards[0]).toBeNull();
    expect(s.loadouts["hero-01"]!.currentAp).toBe(s.loadouts["hero-01"]!.baseAp);
  });

  it("does NOT heal: Armor heals only when continuing", () => {
    const s = freshState();
    s.loadouts["hero-02"]!.currentHp = s.loadouts["hero-02"]!.maxHp - 3;
    const before = s.loadouts["hero-02"]!.currentHp;

    enterEndOfWave(s, "victory");

    expect(s.loadouts["hero-02"]!.currentHp).toBe(before);
  });

  it("is idempotent — a second enterEndOfWave doesn't refresh again", () => {
    const s = freshState();
    s.loadouts["hero-01"]!.slotCards[0] = "ion-cannon-beam";
    enterEndOfWave(s, "victory");
    const first = s.encounter!.endWaveRefresh;
    s.loadouts["hero-01"]!.slotCards[0] = "crash-hammer";

    enterEndOfWave(s, "victory");

    expect(s.encounter!.endWaveRefresh).toBe(first);
    expect(s.loadouts["hero-01"]!.slotCards[0]).toBe("crash-hammer");
  });

  // AP unification (2026-05-09): currentAp is refreshed per-Wave (NOT
  // per-turn at startHeroTurn), including a delver who burned it to 0.
  it("refreshes currentAp -> baseAp for BOTH delvers (per-Wave AP, not per-turn)", () => {
    const s = freshState();
    s.loadouts["hero-01"]!.currentAp = 0;
    s.loadouts["hero-02"]!.currentAp = Math.max(0, s.loadouts["hero-02"]!.baseAp - 1);

    enterEndOfWave(s, "victory");

    expect(s.loadouts["hero-01"]!.currentAp).toBe(s.loadouts["hero-01"]!.baseAp);
    expect(s.loadouts["hero-02"]!.currentAp).toBe(s.loadouts["hero-02"]!.baseAp);
  });

  // The refresh honors quest-long baseAp bumps (Battery's "+1 AP for
  // the rest of the quest" bumps baseAp directly).
  it("refreshes currentAp to the CURRENT baseAp (honors quest-long bumps like Battery's +AP)", () => {
    const s = freshState();
    const lo = s.loadouts["hero-01"]!;
    const originalBase = lo.baseAp;
    lo.baseAp = originalBase + 1;
    lo.currentAp = 0;

    enterEndOfWave(s, "victory");

    expect(lo.baseAp).toBe(originalBase + 1);
    expect(lo.currentAp).toBe(originalBase + 1);
  });
});

describe("applyContinuingEndWaveEffects — Armor heals", () => {
  it("applies heal-at-end-of-wave passives (Exoframe Armor +1 HP)", () => {
    const s = freshState();
    s.loadouts["hero-02"]!.currentHp = s.loadouts["hero-02"]!.maxHp - 3;
    const before = s.loadouts["hero-02"]!.currentHp;

    const events = applyContinuingEndWaveEffects(s);

    expect(s.loadouts["hero-02"]!.currentHp).toBe(before + 1);
    expect(events).toContainEqual({
      kind: "wave-effect",
      text: expect.stringMatching(/^Body: .*Armor heals 1 HP/),
    });
  });

  // Regression (designer report 2026-07-22): ranked-up Armor healed 1
  // forever and level-up-gained Armor never healed.
  it("heals the RANK-CORRECT amount for ranked-up Armor (R3 heals 3)", () => {
    const s = freshState();
    s.equipmentRanks["hero-02"]!.Armor = 3;
    s.loadouts["hero-02"]!.maxHp = 15; // R3 card's set-max-hp
    s.loadouts["hero-02"]!.currentHp = 5;

    applyContinuingEndWaveEffects(s);

    expect(s.loadouts["hero-02"]!.currentHp).toBe(8); // +3, not +1
  });

  it("heals a delver whose Armor was gained via Level Up (not a starter card)", () => {
    const s = freshState();
    expect(s.equipmentRanks["hero-01"]!.Armor ?? 0).toBe(0);
    s.equipmentRanks["hero-01"]!.Armor = 1;
    s.loadouts["hero-01"]!.maxHp = 9;
    s.loadouts["hero-01"]!.currentHp = 4;

    applyContinuingEndWaveEffects(s);

    expect(s.loadouts["hero-01"]!.currentHp).toBe(5);
  });

  it("does not heal above maxHp", () => {
    const s = freshState();
    s.loadouts["hero-02"]!.currentHp = s.loadouts["hero-02"]!.maxHp;

    applyContinuingEndWaveEffects(s);

    expect(s.loadouts["hero-02"]!.currentHp).toBe(s.loadouts["hero-02"]!.maxHp);
  });
});

// --- End of Wave -----------------------------------------------------------

describe("enterEndOfWave + completeWave", () => {
  it("victory routes to the bothSurvive page and sets quest1Completed", () => {
    const s = freshState();
    enterEndOfWave(s, "victory");
    expect(s.encounter!.endOfWavePageId).toBe(QUEST1.waves[0]!.endOfWave.bothSurvive);
    expect(s.quest1Completed).toBe(true);
    // Per p26 — discard remaining enemies on the way out of parting shots.
    expect(s.encounter!.enemies.every((e) => !e.alive)).toBe(true);
  });

  it("defeat routes to the anyDie page and does NOT set quest1Completed", () => {
    const s = freshState();
    enterEndOfWave(s, "defeat");
    expect(s.encounter!.endOfWavePageId).toBe(QUEST1.waves[0]!.endOfWave.anyDie);
    expect(s.quest1Completed).toBe(false);
  });

  it("completeWave clears the encounter (Title now sees no in-progress wave)", () => {
    const s = freshState();
    enterEndOfWave(s, "victory");
    completeWave(s);
    expect(s.encounter).toBeNull();
  });
});

describe("resetWaveForRetry", () => {
  it("clears the encounter and restores per-delver HP / AP / movement", () => {
    const s = freshState();
    s.loadouts["hero-01"]!.currentHp = 1;
    s.loadouts["hero-01"]!.currentAp = 0;
    s.loadouts["hero-01"]!.slotCards[2] = "ion-cannon-beam";
    enterEndOfWave(s, "defeat");

    resetWaveForRetry(s);

    expect(s.encounter).toBeNull();
    expect(s.loadouts["hero-01"]!.currentHp).toBe(s.loadouts["hero-01"]!.maxHp);
    expect(s.loadouts["hero-01"]!.currentAp).toBe(s.loadouts["hero-01"]!.baseAp);
    expect(s.loadouts["hero-01"]!.slotCards.every((c) => c === null)).toBe(true);
  });

  it("re-applies Boots' set-base-movement on retry (per-quest gain survives wave reset)", () => {
    const s = freshState();
    // Player gained Boots earlier this quest via level-up.
    s.equipmentRanks["hero-01"]!.Boots = 1;
    s.loadouts["hero-01"]!.baseMovement = 2;
    s.loadouts["hero-01"]!.currentMovement = 0; // mid-turn / spent
    enterEndOfWave(s, "defeat");

    resetWaveForRetry(s);

    // Boots' floor of 2 is preserved (re-applied from
    // equipmentRanks, not just from starting equipment).
    expect(s.loadouts["hero-01"]!.baseMovement).toBe(2);
    expect(s.loadouts["hero-01"]!.currentMovement).toBe(2);
  });
});

// --- End of Quest reset (2026-05-09) ---------------------------------------

describe("endQuestReset", () => {
  it("clears equipment ranks back to starting (R1 starter only, 0 elsewhere)", () => {
    const s = freshState();
    // Player gained ranks via level-ups: Boots R2 (mind), Battery R3 (body).
    s.equipmentRanks["hero-01"]!.Boots = 2;
    s.equipmentRanks["hero-02"]!.Battery = 3;

    endQuestReset(s);

    // Mind starter (Hammer/Beam/Trident/Shield/Sword/Shockwave per data)
    // — every starter type at R1, every other type back to 0.
    const ranks01 = s.equipmentRanks["hero-01"]!;
    expect(ranks01.Boots).toBe(0); // gained rank stripped
    // Mind starter still owned at R1 (e.g. Hammer is mind-suit starter).
    // We assert against the freshState baseline rather than a hard-coded
    // type so this test survives the data file rotating starters.
    const fresh = newCampaign();
    for (const k of Object.keys(fresh.equipmentRanks["hero-01"]!) as Array<keyof typeof ranks01>) {
      expect(ranks01[k]).toBe(fresh.equipmentRanks["hero-01"]![k]);
    }
    expect(s.equipmentRanks["hero-02"]!.Battery).toBe(0);
  });

  it("zeros XP-on-hand, totalXp, currentLevel, and levelUpCardsOwed", () => {
    const s = freshState();
    s.xpOnHand = 7;
    s.totalXp = 42;
    s.currentLevel = 3;
    s.levelUpCardsOwed = 2;

    endQuestReset(s);

    expect(s.xpOnHand).toBe(0);
    expect(s.totalXp).toBe(0);
    expect(s.currentLevel).toBe(0);
    expect(s.levelUpCardsOwed).toBe(0);
  });

  it("clears consumable + element bags for every delver", () => {
    const s = freshState();
    s.consumableTokens["hero-01"] = {
      reroll: { available: 1, spent: 0 },
      "prevent-counterattack": { available: 0, spent: 1 },
    };
    s.consumableTokens["hero-02"] = {
      "damage-2x-medium": { available: 2, spent: 0 },
    };
    s.elements["hero-01"] = { earth: 2, wind: 1 };
    s.elements["hero-02"] = { void: 1, radiance: 2 };

    endQuestReset(s);

    expect(s.consumableTokens["hero-01"]).toEqual({});
    expect(s.consumableTokens["hero-02"]).toEqual({});
    expect(s.elements["hero-01"]).toEqual({});
    expect(s.elements["hero-02"]).toEqual({});
  });

  it("resets per-delver loadout to fresh: HP/AP/MP/baseAp/baseMov + clears slots", () => {
    const s = freshState();
    // Mid-wave state: damaged, AP spent, weapons in slots, base values
    // bumped by Battery / Boots (which the rank reset will undo).
    const lo01 = s.loadouts["hero-01"]!;
    lo01.currentHp = 1;
    lo01.currentAp = 0;
    lo01.baseAp = 4; // Battery bumped
    lo01.baseMovement = 2; // Boots bumped
    lo01.currentMovement = 0;
    lo01.slotCards[0] = "ion-cannon-beam";
    lo01.slotCards[3] = "crash-hammer";

    endQuestReset(s);

    // baseAp / baseMovement back to Tuning baselines (Battery / Boots
    // gone with the equipment-rank reset). Body delver's Exoframe
    // Armor IMMEDIATELY effect re-applies, so its maxHp stays at 9.
    const fresh = newCampaign();
    expect(lo01.baseAp).toBe(fresh.loadouts["hero-01"]!.baseAp);
    expect(lo01.currentAp).toBe(lo01.baseAp);
    expect(lo01.baseMovement).toBe(fresh.loadouts["hero-01"]!.baseMovement);
    expect(lo01.currentMovement).toBe(lo01.baseMovement);
    expect(lo01.maxHp).toBe(fresh.loadouts["hero-01"]!.maxHp);
    expect(lo01.currentHp).toBe(lo01.maxHp);
    expect(lo01.slotCards.every((c) => c === null)).toBe(true);

    // Body delver's starter passive re-runs, so its post-reset shape
    // matches the new-campaign body baseline (with Exoframe applied).
    expect(s.loadouts["hero-02"]!.maxHp).toBe(fresh.loadouts["hero-02"]!.maxHp);
    expect(s.loadouts["hero-02"]!.currentHp).toBe(s.loadouts["hero-02"]!.maxHp);
  });

  it("preserves campaign-level progress (parts, memory chips, completion flags, town visit)", () => {
    const s = freshState();
    s.minionParts["hero-01"] = 5;
    s.minionParts["hero-02"] = 3;
    s.bossParts["hero-01"] = 1;
    s.bossParts["hero-02"] = 2;
    s.memoryChips = 4;
    s.quest1Completed = true;
    s.townVisit1Completed = false;
    s.townVisit = { chapterId: "ch1", pageId: "page6", pagesEntered: ["page6"] };
    s.shopProductsAvailable = [1, 2, 3];
    s.shopProductsOwned = { "hero-01": [4], "hero-02": [5] };
    s.townDecisions = ["ch1.bram.A"];

    endQuestReset(s);

    expect(s.minionParts).toEqual({ "hero-01": 5, "hero-02": 3 });
    expect(s.bossParts).toEqual({ "hero-01": 1, "hero-02": 2 });
    expect(s.memoryChips).toBe(4);
    expect(s.quest1Completed).toBe(true);
    expect(s.townVisit1Completed).toBe(false);
    expect(s.townVisit).toEqual({
      chapterId: "ch1", pageId: "page6", pagesEntered: ["page6"],
    });
    expect(s.shopProductsAvailable).toEqual([1, 2, 3]);
    expect(s.shopProductsOwned).toEqual({ "hero-01": [4], "hero-02": [5] });
    expect(s.townDecisions).toEqual(["ch1.bram.A"]);
  });

  it("drops any in-flight encounter and resets the active delver to the first hero", () => {
    const s = freshState();
    s.currentDelverId = "hero-02";
    expect(s.encounter).not.toBeNull();

    endQuestReset(s);

    expect(s.encounter).toBeNull();
    expect(s.currentDelverId).toBe("hero-01");
  });

  it("is idempotent (calling twice has no further effect)", () => {
    const s = freshState();
    s.minionParts["hero-01"] = 4;
    endQuestReset(s);
    const snapshot = JSON.stringify(s);
    endQuestReset(s);
    expect(JSON.stringify(s)).toBe(snapshot);
  });
});

// --- Stuck-Continue regression (2026-05-09 playthrough) --------------------

// The "Parting Shots resolved - Continuing to End Wave..." UI panel is
// reachable when the parting-shots phase enters with no alive enemies
// (every enemy was killed during Hero Phase, so `nextPartingShotEnemy`
// returns null on first poll). Only `resolvePartingShot` ends the
// phase, so the UI's Continue button calls it once - it sees no enemy
// and enters End Wave itself.
describe("Parting Shots auto-advance when no enemies survived (stuck-Continue regression)", () => {
  it("resolvePartingShot returns null and enters End Wave when no alive enemies", () => {
    const s = freshState();
    // No enemies on the board. Phase forced to parting-shots as if the
    // wave just ended via maybeEnterPartingShotsAfterTurn.
    s.encounter!.enemies = [];
    s.encounter!.phase = "parting-shots";
    s.encounter!.partingShotCursor = 0;

    const r = resolvePartingShot(s);

    expect(r).toBeNull();
    expect(s.encounter!.phase).toBe("end-of-wave");
    expect(s.encounter!.endOfWaveOutcome).toBe("victory");
  });

  it("works when every enemy in the lineup is already dead (cursor walks past them)", () => {
    const s = setupPartingShotsScenario(
      ["crystanid-001", "crystanid-005"],
      { "hero-01": { x: 0, y: 0 }, "hero-02": { x: 4, y: 4 } },
      [{ x: 2, y: 2 }, { x: 3, y: 3 }],
    );
    s.encounter!.enemies.forEach((e) => { e.alive = false; });

    const r = resolvePartingShot(s);

    expect(r).toBeNull();
    expect(s.encounter!.phase).toBe("end-of-wave");
    expect(s.encounter!.endOfWaveOutcome).toBe("victory");
  });
});

// --- Death short-circuit (rulebook p26) ------------------------------------

describe("onDelverDamaged", () => {
  let s: CampaignState;
  beforeEach(() => { s = freshState(); });

  it("does nothing when no delver is at 0 HP", () => {
    expect(onDelverDamaged(s)).toBe(false);
    expect(s.encounter!.phase).toBe("hero");
  });

  it("flips to end-of-wave (defeat) when any delver is at 0 HP", () => {
    s.loadouts["hero-02"]!.currentHp = 0;
    expect(onDelverDamaged(s)).toBe(true);
    expect(s.encounter!.phase).toBe("end-of-wave");
    expect(s.encounter!.endOfWaveOutcome).toBe("defeat");
    expect(s.encounter!.endOfWavePageId).toBe(QUEST1.waves[0]!.endOfWave.anyDie);
  });

  it("is idempotent once already in end-of-wave", () => {
    s.loadouts["hero-02"]!.currentHp = 0;
    onDelverDamaged(s);
    expect(onDelverDamaged(s)).toBe(false);
  });

  it("fires from the parting-shot path when an enemy kills a delver", () => {
    // Soulhunter parting shot: 2 damage to BOTH. Drop hero-01 to 1 HP so
    // the parting shot reduces them to -1 → 0 (clamped).
    const s2 = freshState();
    s2.loadouts["hero-01"]!.currentHp = 1;
    s2.encounter!.enemies = [{
      instanceId: "boss", cardId: "soulhunter-001",
      x: 2, y: 2, damageTaken: 0, alive: true, facing: 0,
    }];
    s2.encounter!.phase = "parting-shots";
    s2.encounter!.partingShotCursor = 0;

    const r = resolvePartingShot(s2);

    expect(r!.delverDied).toBe(true);
    expect(s2.encounter!.phase).toBe("end-of-wave");
    expect(s2.encounter!.endOfWaveOutcome).toBe("defeat");
  });
});

// --- Q2 W1 end-of-wave routing (multi-quest engine generalisation) ----

/**
 * Q2 builds via spawn-deck so the encounter is bootstrapped through
 * the same `ensureEncounter` path as Q1, but with `currentQuestId`
 * pre-flipped to `"quest2"` so `enterEndOfWave` resolves the right
 * Quest+Wave pair. Spawn-card draw is pinned so the test is
 * deterministic.
 */
function freshQ2State(): CampaignState {
  const s = newCampaign();
  s.currentQuestId = "quest2";
  ensureEncounter(s, QUEST2, {
    assign: noShuffle,
    drawSpawnCardNumber: () => 1,
  });
  return s;
}

describe("enterEndOfWave — Quest 2 routing", () => {
  it("victory routes to Q2 W1's bothSurvive page (page2_3)", () => {
    const s = freshQ2State();
    enterEndOfWave(s, "victory");
    expect(s.encounter!.endOfWavePageId).toBe(QUEST2.waves[0]!.endOfWave.bothSurvive);
    expect(s.encounter!.endOfWavePageId).toBe("page2_3");
  });

  it("defeat routes to Q2 W1's anyDie page (page2_1)", () => {
    const s = freshQ2State();
    enterEndOfWave(s, "defeat");
    expect(s.encounter!.endOfWavePageId).toBe(QUEST2.waves[0]!.endOfWave.anyDie);
    expect(s.encounter!.endOfWavePageId).toBe("page2_1");
  });

  it("Q2 victory does NOT flip quest1Completed", () => {
    const s = freshQ2State();
    expect(s.quest1Completed).toBe(false);
    enterEndOfWave(s, "victory");
    // Q2 has no equivalent flag yet, but Q1's must stay untouched
    // -- otherwise replaying Q2 from the title would silently mark
    // Q1 complete and unlock its Town Visit.
    expect(s.quest1Completed).toBe(false);
  });

  it("marks every Q2 enemy dead on exit (rulebook p26 cleanup)", () => {
    const s = freshQ2State();
    // Encounter is still in delver-spawn-pick phase from buildEncounter;
    // fast-forward the phase as if we got here through normal play.
    s.encounter!.phase = "hero";
    enterEndOfWave(s, "victory");
    expect(s.encounter!.enemies.every((e) => !e.alive)).toBe(true);
  });

  it("Q1 victory still flips quest1Completed when currentQuestId stays quest1", () => {
    // Regression guard: the new questId-gated branch must not break
    // the existing Q1 victory flag.
    const s = freshState();
    expect(s.encounter!.questId).toBe("quest1");
    enterEndOfWave(s, "victory");
    expect(s.quest1Completed).toBe(true);
  });

  it("throws helpfully when the encounter references an unknown wave number", () => {
    const s = freshQ2State();
    s.encounter!.waveNumber = 99;
    expect(() => enterEndOfWave(s, "victory")).toThrow(/quest2.*wave #99/);
  });
});
