/**
 * Tests for the Supercharger equipment family + the consumable
 * Double Damage token economy it underwrites (Slice 5+).
 *
 * Both Supercharger R1 cards (Reflex / Mind, Spinejack / Body) ship
 * the same single engine piece:
 *   - `effects: [{ kind: "immediately-supercharger-die-roll" }]`
 *
 * On first-gain (R0 -> R1), `applyLevelUpChoice` enqueues a pending
 * Supercharger roll. The UI's `supercharger-roll` modal walks the
 * d6 outcomes:
 *   - 1 -> two `damage-2x-light` tokens
 *   - 2 -> two `damage-2x-medium` tokens
 *   - 3 -> two `damage-2x-heavy` tokens
 *   - 4 -> one of each
 *   - 5/6 -> player picks one of outcomes 1..4
 *
 * The granted tokens land on `state.consumableTokens[heroId]` and
 * persist across waves (refreshed Spent -> Available at End Wave).
 *
 * Coverage (10 sections, 26+ tests):
 *   1. equipment.json shape.
 *   2. `engine/tokens.ts` bag CRUD (`grantToken`, `spendToken`,
 *      `tokenAvailable`, `tokenSpent`).
 *   3. Per-turn DD cap (`canSpendDoubleDamage`).
 *   4. `doubledDamageMultiplier` typed + universal logic.
 *   5. `SUPERCHARGER_OUTCOMES` table shape + `superchargerOutcomeForRoll`.
 *   6. `enqueueSuperchargerRoll` + `peekNextPendingSuperchargerRoll` +
 *      `hasPendingSuperchargerRolls`.
 *   7. `applySuperchargerRoll` grants the tokens + pops the queue.
 *   8. `applyLevelUpChoice` enqueues one roll PER RANK gained
 *      (first gain AND rank-ups — designer ruling 2026-07-20).
 *   9. `useWeaponAbility(..., { spendDoubleDamage })` doubles the
 *      damage AND spends the token AND latches the per-turn cap.
 *  10. End Wave `refreshAllSpentTokens` flips Spent -> Available
 *      across both delvers.
 *
 * Following the Trident / Shockwave test conventions: minimal
 * fixtures, manually-wired weapons / equipment, every printed rule
 * pinned by an assertion that fails if the data drifts.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  newCampaign,
  type CampaignState,
  type EnemyInstance,
} from "../state";
import { QUEST1, getEquipment } from "../data";
import { ensureEncounter } from "../engine/encounter";
import { startHeroTurn, useWeaponAbility } from "../engine/turn";
import { resolveAllDamage } from "../engine/combat";
import { enterEndOfWave } from "../engine/wave";
import { applyLevelUpChoice } from "../engine/levelUp";
import {
  applyEquipmentRoll,
  canSpendDoubleDamage,
  doubledDamageMultiplier,
  enqueueEquipmentRoll,
  EQUIPMENT_ROLL_TABLES,
  equipmentRollTableForCard,
  grantToken,
  hasPendingEquipmentRolls,
  outcomeForRoll,
  peekNextPendingEquipmentRoll,
  refreshAllSpentTokens,
  spendToken,
  tokenAvailable,
  tokenSpent,
  typedDoubleDamageKindFor,
  type EquipmentRollOutcome,
} from "../engine/tokens";

const SUPERCHARGER_MIND = "mind-supercharger-r1";
const SUPERCHARGER_BODY = "body-supercharger-r1";

// Convenience: the Supercharger outcome table — same shape as before
// `SUPERCHARGER_OUTCOMES` but now sourced through the per-card
// registry so this test exercises the public API rather than a
// Supercharger-only constant.
const SUPERCHARGER_OUTCOMES: readonly EquipmentRollOutcome[] =
  EQUIPMENT_ROLL_TABLES[SUPERCHARGER_MIND]!.outcomes;

function superchargerOutcomeForRoll(roll: number): EquipmentRollOutcome | null {
  const table = equipmentRollTableForCard(SUPERCHARGER_MIND)!;
  const r = outcomeForRoll(table, roll);
  return r === "choice" ? null : r;
}

/** Standard test arena: encounter ready, both delvers placed, no enemies. */
function arena(): CampaignState {
  const state = newCampaign();
  ensureEncounter(state, QUEST1);
  state.encounter!.enemies = [];
  state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
  state.encounter!.delverPositions["hero-02"] = { x: 0, y: 0 };
  startHeroTurn(state);
  return state;
}

/** Manually wire a weapon into the active delver's slot 0 + latch
 *  the placement so `useWeaponAbility` can fire without going through
 *  the full hand / placement flow. */
function placeWeapon(state: CampaignState, heroId: string, cardId: string): void {
  state.loadouts[heroId]!.slotCards[0] = cardId;
  state.encounter!.turnState[heroId]!.cardPlacedThisTurn = {
    slotIdx: 0,
    cardId,
    autoRefreshedElement: null,
  };
  // Ensure the equipment type is at R1 so `effectiveDamageForCard`
  // doesn't read 0 from the rank table.
  const card = getEquipment(cardId);
  state.equipmentRanks[heroId]![card.type] = 1;
}

function placeEnemy(
  state: CampaignState,
  instanceId: string,
  x: number,
  y: number,
  cardId = "crystanid-001",
): EnemyInstance {
  const e: EnemyInstance = {
    instanceId,
    cardId,
    x, y,
    damageTaken: 0,
    alive: true,
    facing: 0,
  };
  state.encounter!.enemies.push(e);
  return e;
}

// --- 1. equipment.json shape -------------------------------------------

describe("Supercharger equipment data", () => {
  it("Mind (Reflex) Supercharger R1 carries `immediately-equipment-roll`", () => {
    const card = getEquipment(SUPERCHARGER_MIND);
    expect(card.category).toBe("passive");
    expect(card.type).toBe("Supercharger");
    expect(card.suit).toBe("mind");
    const effs = card.effects ?? [];
    expect(effs).toEqual([{ kind: "immediately-equipment-roll" }]);
  });

  it("Body (Spinejack) Supercharger R1 carries `immediately-equipment-roll`", () => {
    const card = getEquipment(SUPERCHARGER_BODY);
    expect(card.category).toBe("passive");
    expect(card.type).toBe("Supercharger");
    expect(card.suit).toBe("body");
    const effs = card.effects ?? [];
    expect(effs).toEqual([{ kind: "immediately-equipment-roll" }]);
  });
});

// --- 2. Bag CRUD --------------------------------------------------------

describe("engine/tokens — bag CRUD", () => {
  let state: CampaignState;
  beforeEach(() => { state = arena(); });

  it("tokenAvailable / tokenSpent default to 0 on an empty bag", () => {
    expect(tokenAvailable(state, "hero-01", "damage-2x-light")).toBe(0);
    expect(tokenSpent(state, "hero-01", "damage-2x-light")).toBe(0);
  });

  it("grantToken adds to Available; never touches Spent", () => {
    grantToken(state, "hero-01", "damage-2x-light", 2);
    expect(tokenAvailable(state, "hero-01", "damage-2x-light")).toBe(2);
    expect(tokenSpent(state, "hero-01", "damage-2x-light")).toBe(0);
    grantToken(state, "hero-01", "damage-2x-light", 3);
    expect(tokenAvailable(state, "hero-01", "damage-2x-light")).toBe(5);
  });

  it("grantToken with count <= 0 is a silent no-op", () => {
    grantToken(state, "hero-01", "damage-2x-light", 0);
    grantToken(state, "hero-01", "damage-2x-light", -1);
    expect(tokenAvailable(state, "hero-01", "damage-2x-light")).toBe(0);
  });

  it("spendToken moves 1 from Available -> Spent and returns true", () => {
    grantToken(state, "hero-01", "damage-2x-medium", 3);
    expect(spendToken(state, "hero-01", "damage-2x-medium")).toBe(true);
    expect(tokenAvailable(state, "hero-01", "damage-2x-medium")).toBe(2);
    expect(tokenSpent(state, "hero-01", "damage-2x-medium")).toBe(1);
  });

  it("spendToken returns false (no-op) when Available is 0", () => {
    expect(spendToken(state, "hero-01", "damage-2x-light")).toBe(false);
    expect(tokenAvailable(state, "hero-01", "damage-2x-light")).toBe(0);
    expect(tokenSpent(state, "hero-01", "damage-2x-light")).toBe(0);
  });
});

// --- 3. Per-turn DD cap ------------------------------------------------

describe("canSpendDoubleDamage — per-turn cap", () => {
  let state: CampaignState;
  beforeEach(() => { state = arena(); });

  it("ok when matching token available + nothing spent yet this turn", () => {
    grantToken(state, "hero-01", "damage-2x-light", 1);
    const r = canSpendDoubleDamage(state, "hero-01", "damage-2x-light");
    expect(r.ok).toBe(true);
  });

  it("rejects when no token is available", () => {
    const r = canSpendDoubleDamage(state, "hero-01", "damage-2x-light");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no .* tokens available/);
  });

  it("rejects when a DD token has already been spent this turn (cap)", () => {
    grantToken(state, "hero-01", "damage-2x-light", 2);
    spendToken(state, "hero-01", "damage-2x-light");
    expect(state.encounter!.turnState["hero-01"]!.damage2xUsedThisTurn).toBe(true);
    const r = canSpendDoubleDamage(state, "hero-01", "damage-2x-light");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/already spent/);
  });

  it("rejects spending a Light DD on a Light swing AFTER a Medium DD already spent", () => {
    grantToken(state, "hero-01", "damage-2x-light", 1);
    grantToken(state, "hero-01", "damage-2x-medium", 1);
    spendToken(state, "hero-01", "damage-2x-medium");
    const r = canSpendDoubleDamage(state, "hero-01", "damage-2x-light");
    expect(r.ok).toBe(false);
  });

  it("rejects a non-DD kind", () => {
    grantToken(state, "hero-01", "reroll", 1);
    const r = canSpendDoubleDamage(state, "hero-01", "reroll");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not a Double Damage/);
  });
});

// --- 4. doubledDamageMultiplier ----------------------------------------

describe("doubledDamageMultiplier", () => {
  it("returns base when spentKind is null", () => {
    expect(doubledDamageMultiplier(3, "light", null)).toBe(3);
  });

  it("doubles when typed kind matches the swing's damageType", () => {
    expect(doubledDamageMultiplier(2, "light", "damage-2x-light")).toBe(4);
    expect(doubledDamageMultiplier(2, "medium", "damage-2x-medium")).toBe(4);
    expect(doubledDamageMultiplier(2, "heavy", "damage-2x-heavy")).toBe(4);
  });

  it("does NOT double when typed kind mismatches", () => {
    expect(doubledDamageMultiplier(2, "light", "damage-2x-medium")).toBe(2);
    expect(doubledDamageMultiplier(2, "heavy", "damage-2x-light")).toBe(2);
  });

  it("Universal doubles ANY damageType", () => {
    expect(doubledDamageMultiplier(2, "light", "damage-2x-universal")).toBe(4);
    expect(doubledDamageMultiplier(2, "medium", "damage-2x-universal")).toBe(4);
    expect(doubledDamageMultiplier(2, "heavy", "damage-2x-universal")).toBe(4);
  });

  it("typedDoubleDamageKindFor returns the matching typed kind", () => {
    expect(typedDoubleDamageKindFor("light")).toBe("damage-2x-light");
    expect(typedDoubleDamageKindFor("medium")).toBe("damage-2x-medium");
    expect(typedDoubleDamageKindFor("heavy")).toBe("damage-2x-heavy");
  });
});

// --- 5. Supercharger outcome table -------------------------------------

describe("SUPERCHARGER_OUTCOMES + superchargerOutcomeForRoll", () => {
  it("table has exactly 4 entries with the printed grants", () => {
    expect(SUPERCHARGER_OUTCOMES).toHaveLength(4);
    expect(SUPERCHARGER_OUTCOMES[0]!.grants).toEqual({ "damage-2x-light": 2 });
    expect(SUPERCHARGER_OUTCOMES[1]!.grants).toEqual({ "damage-2x-medium": 2 });
    expect(SUPERCHARGER_OUTCOMES[2]!.grants).toEqual({ "damage-2x-heavy": 2 });
    expect(SUPERCHARGER_OUTCOMES[3]!.grants).toEqual({
      "damage-2x-light": 1,
      "damage-2x-medium": 1,
      "damage-2x-heavy": 1,
    });
  });

  it("rolls 1..4 map directly to outcome 1..4", () => {
    expect(superchargerOutcomeForRoll(1)?.id).toBe(1);
    expect(superchargerOutcomeForRoll(2)?.id).toBe(2);
    expect(superchargerOutcomeForRoll(3)?.id).toBe(3);
    expect(superchargerOutcomeForRoll(4)?.id).toBe(4);
  });

  it("rolls 5 and 6 return null (player picks)", () => {
    expect(superchargerOutcomeForRoll(5)).toBeNull();
    expect(superchargerOutcomeForRoll(6)).toBeNull();
  });

  it("out-of-range rolls return null (defensive)", () => {
    expect(superchargerOutcomeForRoll(0)).toBeNull();
    expect(superchargerOutcomeForRoll(7)).toBeNull();
  });
});

// --- 6. Pending equipment-roll queue helpers ---------------------------

describe("pendingEquipmentRolls queue (Supercharger entries)", () => {
  let state: CampaignState;
  beforeEach(() => { state = arena(); });

  it("starts empty", () => {
    expect(hasPendingEquipmentRolls(state)).toBe(false);
    expect(peekNextPendingEquipmentRoll(state)).toBeNull();
  });

  it("enqueueEquipmentRoll pushes onto the queue (FIFO peek)", () => {
    enqueueEquipmentRoll(state, "hero-01", SUPERCHARGER_MIND);
    enqueueEquipmentRoll(state, "hero-02", SUPERCHARGER_BODY);
    expect(hasPendingEquipmentRolls(state)).toBe(true);
    const head = peekNextPendingEquipmentRoll(state);
    expect(head).toEqual({ heroId: "hero-01", cardId: SUPERCHARGER_MIND });
  });

  it("enqueueEquipmentRoll is a no-op when there's no encounter", () => {
    state.encounter = null;
    enqueueEquipmentRoll(state, "hero-01", SUPERCHARGER_MIND);
    expect(hasPendingEquipmentRolls(state)).toBe(false);
  });
});

// --- 7. applyEquipmentRoll (Supercharger outcomes) ---------------------

describe("applyEquipmentRoll for Supercharger", () => {
  let state: CampaignState;
  beforeEach(() => {
    state = arena();
    enqueueEquipmentRoll(state, "hero-01", SUPERCHARGER_MIND);
  });

  it("outcome 1: grants two Light tokens + pops the queue", () => {
    const r = applyEquipmentRoll(state, "hero-01", SUPERCHARGER_OUTCOMES[0]!);
    expect(r).toEqual(SUPERCHARGER_OUTCOMES[0]);
    expect(tokenAvailable(state, "hero-01", "damage-2x-light")).toBe(2);
    expect(tokenAvailable(state, "hero-01", "damage-2x-medium")).toBe(0);
    expect(tokenAvailable(state, "hero-01", "damage-2x-heavy")).toBe(0);
    expect(hasPendingEquipmentRolls(state)).toBe(false);
  });

  it("outcome 4: grants one of each", () => {
    const r = applyEquipmentRoll(state, "hero-01", SUPERCHARGER_OUTCOMES[3]!);
    expect(r).toEqual(SUPERCHARGER_OUTCOMES[3]);
    expect(tokenAvailable(state, "hero-01", "damage-2x-light")).toBe(1);
    expect(tokenAvailable(state, "hero-01", "damage-2x-medium")).toBe(1);
    expect(tokenAvailable(state, "hero-01", "damage-2x-heavy")).toBe(1);
  });

  it("returns null when no entry matches the heroId (defensive)", () => {
    const r = applyEquipmentRoll(state, "hero-02", SUPERCHARGER_OUTCOMES[0]!);
    expect(r).toBeNull();
    // Original entry untouched.
    expect(hasPendingEquipmentRolls(state)).toBe(true);
  });

  it("only pops the FIRST matching entry — multi-stacked rolls drain in order", () => {
    enqueueEquipmentRoll(state, "hero-01", SUPERCHARGER_MIND);
    expect(state.encounter!.pendingEquipmentRolls).toHaveLength(2);

    applyEquipmentRoll(state, "hero-01", SUPERCHARGER_OUTCOMES[0]!);
    expect(state.encounter!.pendingEquipmentRolls).toHaveLength(1);
    // The second entry is still pending.
    expect(peekNextPendingEquipmentRoll(state)).toEqual({
      heroId: "hero-01", cardId: SUPERCHARGER_MIND,
    });

    applyEquipmentRoll(state, "hero-01", SUPERCHARGER_OUTCOMES[1]!);
    expect(state.encounter!.pendingEquipmentRolls).toHaveLength(0);
    expect(tokenAvailable(state, "hero-01", "damage-2x-light")).toBe(2);
    expect(tokenAvailable(state, "hero-01", "damage-2x-medium")).toBe(2);
  });
});

// --- 8. applyLevelUpChoice triggers the queue --------------------------

describe("applyLevelUpChoice — Supercharger first-gain enqueue", () => {
  it("first-time gain (R0 -> R1) enqueues a pending equipment roll", () => {
    const state = arena();
    // Set up a fake pending Level-Up draw with Supercharger in the
    // choices.
    state.encounter!.pendingLevelUpDraws = [
      { heroId: "hero-01", cardNumber: 6 }, // levelup_06 has Supercharger
    ];
    expect(hasPendingEquipmentRolls(state)).toBe(false);

    const r = applyLevelUpChoice(state, "Supercharger");

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.newRank).toBe(1);
    expect(hasPendingEquipmentRolls(state)).toBe(true);
    expect(peekNextPendingEquipmentRoll(state)).toEqual({
      heroId: "hero-01",
      cardId: SUPERCHARGER_MIND,
    });
  });

  it("rank-up (R1 -> R2) ALSO enqueues one roll (designer ruling 2026-07-20: 1 benefit per rank)", () => {
    const state = arena();
    // Pre-bump to R1 so the next pick is a rank-up, not a first-gain.
    state.equipmentRanks["hero-01"]!.Supercharger = 1;
    state.encounter!.pendingLevelUpDraws = [
      { heroId: "hero-01", cardNumber: 6 },
    ];

    const r = applyLevelUpChoice(state, "Supercharger");

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.newRank).toBe(2);
    expect(peekNextPendingEquipmentRoll(state)).toEqual({
      heroId: "hero-01",
      cardId: SUPERCHARGER_MIND,
    });
    expect(state.encounter!.pendingEquipmentRolls).toHaveLength(1);
  });
});

// --- 9. useWeaponAbility honours `spendDoubleDamage` -------------------

describe("useWeaponAbility(..., { spendDoubleDamage })", () => {
  it("doubles the swing damage AND moves the token Available -> Spent", () => {
    const state = arena();
    // Mind delver (hero-01) is active; place a Mind Hammer (Heavy)
    // and grant a Heavy DD token.
    placeWeapon(state, "hero-01", "mind-hammer-r1");
    grantToken(state, "hero-01", "damage-2x-heavy", 1);
    // Hammer rolls 1-3 -> hit tile (-1, 0) (1W of bearer);
    // 4-6 -> (+1, 0) (1E of bearer). Bearer at (2,2), dieRoll=1 ->
    // hits (1,2). Place the enemy there so it actually takes damage
    // when we run `resolveAllDamage` below.
    const target = placeEnemy(state, "test", 1, 2);

    // Hammer's R1 damage is 1x HEAVY = 1 * Tuning.damageBase.heavy
    // = 1 * 4 = 4 damage. With a Heavy DD spend the engine doubles
    // the multiplier => 4 * 2 = 8 damage applied to every hit tile.
    const r = useWeaponAbility(
      state,
      "hero-01",
      0,
      { kind: "die-roll-fixed", dieRoll: 1 },
      { spendDoubleDamage: "damage-2x-heavy" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session.damage).toBe(8);

    // `useWeaponAbility` builds the session but doesn't apply damage
    // (that's the UI's `startAttackSession` -> `resolveAllDamage`
    // tick). Run it manually so we can assert the per-enemy damage.
    resolveAllDamage(state, r.session);
    expect(target.damageTaken).toBe(8);

    // Token consumed.
    expect(tokenAvailable(state, "hero-01", "damage-2x-heavy")).toBe(0);
    expect(tokenSpent(state, "hero-01", "damage-2x-heavy")).toBe(1);
    // Per-turn cap latched.
    expect(state.encounter!.turnState["hero-01"]!.damage2xUsedThisTurn).toBe(true);
  });

  it("Universal DD doubles a swing of any damage type", () => {
    const state = arena();
    placeWeapon(state, "hero-01", "mind-hammer-r1"); // Heavy
    grantToken(state, "hero-01", "damage-2x-universal", 1);
    placeEnemy(state, "u", 1, 2);

    const r = useWeaponAbility(
      state,
      "hero-01",
      0,
      { kind: "die-roll-fixed", dieRoll: 1 },
      { spendDoubleDamage: "damage-2x-universal" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session.damage).toBe(8);
    expect(tokenAvailable(state, "hero-01", "damage-2x-universal")).toBe(0);
    expect(tokenSpent(state, "hero-01", "damage-2x-universal")).toBe(1);
  });

  it("rejects + does NOT consume the token when typed DD mismatches the swing", () => {
    const state = arena();
    placeWeapon(state, "hero-01", "mind-hammer-r1"); // Heavy
    grantToken(state, "hero-01", "damage-2x-light", 1);

    const r = useWeaponAbility(
      state,
      "hero-01",
      0,
      { kind: "die-roll-fixed", dieRoll: 1 },
      { spendDoubleDamage: "damage-2x-light" },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/cannot spend damage-2x-light/);
    // Token preserved.
    expect(tokenAvailable(state, "hero-01", "damage-2x-light")).toBe(1);
    expect(tokenSpent(state, "hero-01", "damage-2x-light")).toBe(0);
    // Per-turn cap NOT latched on a rejected swing.
    expect(state.encounter!.turnState["hero-01"]!.damage2xUsedThisTurn).toBe(false);
  });

  it("rejects + does NOT consume the token when no token is available", () => {
    const state = arena();
    placeWeapon(state, "hero-01", "mind-hammer-r1");
    // No grantToken call — bag is empty.

    const r = useWeaponAbility(
      state,
      "hero-01",
      0,
      { kind: "die-roll-fixed", dieRoll: 1 },
      { spendDoubleDamage: "damage-2x-heavy" },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no .* tokens available/);
  });

  it("rejects + does NOT consume when a DD token has already been spent this turn", () => {
    const state = arena();
    placeWeapon(state, "hero-01", "mind-hammer-r1");
    grantToken(state, "hero-01", "damage-2x-heavy", 2);
    // Pre-flip the cap as if a previous swing this turn already spent.
    state.encounter!.turnState["hero-01"]!.damage2xUsedThisTurn = true;

    const r = useWeaponAbility(
      state,
      "hero-01",
      0,
      { kind: "die-roll-fixed", dieRoll: 1 },
      { spendDoubleDamage: "damage-2x-heavy" },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/already spent/);
    expect(tokenAvailable(state, "hero-01", "damage-2x-heavy")).toBe(2);
    expect(tokenSpent(state, "hero-01", "damage-2x-heavy")).toBe(0);
  });

  it("no `spendDoubleDamage` option = swing damage unchanged + token untouched", () => {
    const state = arena();
    placeWeapon(state, "hero-01", "mind-hammer-r1");
    grantToken(state, "hero-01", "damage-2x-heavy", 1);
    placeEnemy(state, "n", 1, 2);

    const r = useWeaponAbility(
      state,
      "hero-01",
      0,
      { kind: "die-roll-fixed", dieRoll: 1 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Hammer R1 is 1 * Tuning.damageBase.heavy = 1 * 4 = 4.
    expect(r.session.damage).toBe(4);
    expect(tokenAvailable(state, "hero-01", "damage-2x-heavy")).toBe(1);
    expect(state.encounter!.turnState["hero-01"]!.damage2xUsedThisTurn).toBe(false);
  });

  // Regression (2026-05-25): the Double Damage multiplier composes over
  // additional-damage-if-delvers-adjacent (Flicker Blade's combo +1
  // LIGHT). Prior to the fix the engine doubled the BASE only and added
  // the bonus on top — `(2*medium) + 1 light = 5` — which the player
  // reported as wrong: activating "2x" means the WHOLE swing damage
  // doubles, so the expected value is `(2 medium + 1 light) * 2 = 6`.
  it("Flicker Blade + Medium DD: bonus composes, then DD doubles the WHOLE swing", () => {
    const state = arena();
    // Bearer at (2,2), other delver at (3,3) — 8-way adjacent so the
    // additional-damage-if-delvers-adjacent effect fires.
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.encounter!.delverPositions["hero-02"] = { x: 3, y: 3 };
    placeWeapon(state, "hero-01", "mind-sword-r1");
    grantToken(state, "hero-01", "damage-2x-medium", 1);
    const target = placeEnemy(state, "fb-target", 3, 2);

    const r = useWeaponAbility(
      state,
      "hero-01",
      0,
      { kind: "single-adjacent", targetX: 3, targetY: 2 },
      { spendDoubleDamage: "damage-2x-medium" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Base 2 (medium) + 1 (light adjacency bonus) = 3, doubled = 6.
    expect(r.session.damage).toBe(6);

    resolveAllDamage(state, r.session);
    expect(target.damageTaken).toBe(6);

    expect(tokenAvailable(state, "hero-01", "damage-2x-medium")).toBe(0);
    expect(tokenSpent(state, "hero-01", "damage-2x-medium")).toBe(1);
  });

  // Regression (2026-05-25): without DD active, the adjacency bonus is
  // simply added — pinning the post-fix sum so a future order-of-ops
  // tweak can't regress the no-DD case.
  it("Flicker Blade without DD: prints (2 medium + 1 light) = 3 when delvers are adjacent", () => {
    const state = arena();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.encounter!.delverPositions["hero-02"] = { x: 3, y: 3 };
    placeWeapon(state, "hero-01", "mind-sword-r1");
    placeEnemy(state, "fb-target-2", 3, 2);

    const r = useWeaponAbility(
      state,
      "hero-01",
      0,
      { kind: "single-adjacent", targetX: 3, targetY: 2 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session.damage).toBe(3);
  });

  // Regression (2026-05-25): when delvers are NOT adjacent, the bonus
  // doesn't fire so DD just doubles the printed swing — `2 * 2 = 4`,
  // never 5 or 6 (no phantom bonus, no double-counted bonus).
  it("Flicker Blade + Medium DD: no adjacency bonus when delvers are far apart", () => {
    const state = arena();
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 0 }; // distance > 1
    placeWeapon(state, "hero-01", "mind-sword-r1");
    grantToken(state, "hero-01", "damage-2x-medium", 1);
    placeEnemy(state, "fb-target-3", 3, 2);

    const r = useWeaponAbility(
      state,
      "hero-01",
      0,
      { kind: "single-adjacent", targetX: 3, targetY: 2 },
      { spendDoubleDamage: "damage-2x-medium" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session.damage).toBe(4);
  });
});

// --- 10. End Wave refresh ----------------------------------------------

describe("End Wave — refreshAllSpentTokens", () => {
  it("flips every Spent token back to Available across both delvers", () => {
    const state = arena();
    grantToken(state, "hero-01", "damage-2x-light", 2);
    grantToken(state, "hero-02", "damage-2x-medium", 1);
    grantToken(state, "hero-02", "damage-2x-heavy", 1);
    spendToken(state, "hero-01", "damage-2x-light");
    spendToken(state, "hero-02", "damage-2x-medium");

    refreshAllSpentTokens(state);

    expect(tokenAvailable(state, "hero-01", "damage-2x-light")).toBe(2);
    expect(tokenSpent(state, "hero-01", "damage-2x-light")).toBe(0);
    expect(tokenAvailable(state, "hero-02", "damage-2x-medium")).toBe(1);
    expect(tokenSpent(state, "hero-02", "damage-2x-medium")).toBe(0);
    // Untouched kind unchanged.
    expect(tokenAvailable(state, "hero-02", "damage-2x-heavy")).toBe(1);
  });

  it("is idempotent — calling twice on a refreshed bag is a no-op", () => {
    const state = arena();
    grantToken(state, "hero-01", "damage-2x-light", 1);
    spendToken(state, "hero-01", "damage-2x-light");
    refreshAllSpentTokens(state);
    refreshAllSpentTokens(state);
    expect(tokenAvailable(state, "hero-01", "damage-2x-light")).toBe(1);
    expect(tokenSpent(state, "hero-01", "damage-2x-light")).toBe(0);
  });

  it("enterEndOfWave runs the refresh + reports the count", () => {
    const state = arena();
    grantToken(state, "hero-01", "damage-2x-light", 2);
    grantToken(state, "hero-02", "damage-2x-heavy", 1);
    spendToken(state, "hero-01", "damage-2x-light");
    spendToken(state, "hero-01", "damage-2x-light"); // cap doesn't apply here (no encounter check on second call); we forced both for the count
    spendToken(state, "hero-02", "damage-2x-heavy");

    enterEndOfWave(state, "victory");
    const result = state.encounter!.endWaveRefresh!;

    // hero-01 spent 1 (cap blocked the second), hero-02 spent 1.
    // The second hero-01 spend is silently rejected by the engine
    // (returns false), so only 2 spend operations succeeded total.
    // After refresh, all spent tokens flip back.
    expect(result.consumableTokensRefreshed).toBeGreaterThan(0);
    expect(tokenSpent(state, "hero-01", "damage-2x-light")).toBe(0);
    expect(tokenSpent(state, "hero-02", "damage-2x-heavy")).toBe(0);
    expect(tokenAvailable(state, "hero-01", "damage-2x-light")).toBe(2);
    expect(tokenAvailable(state, "hero-02", "damage-2x-heavy")).toBe(1);
  });
});

// --- 11. Cross-turn cap reset ------------------------------------------

describe("Per-turn DD cap resets on startHeroTurn", () => {
  it("a new turn for the same delver re-arms `damage2xUsedThisTurn`", () => {
    const state = arena();
    grantToken(state, "hero-01", "damage-2x-light", 2);
    spendToken(state, "hero-01", "damage-2x-light");
    expect(state.encounter!.turnState["hero-01"]!.damage2xUsedThisTurn).toBe(true);

    // Flip to hero-02, then back to hero-01 for a new turn.
    state.currentDelverId = "hero-02";
    startHeroTurn(state); // resets hero-02 only, but doesn't touch hero-01

    state.currentDelverId = "hero-01";
    startHeroTurn(state); // resets hero-01 — cap should clear.

    expect(state.encounter!.turnState["hero-01"]!.damage2xUsedThisTurn).toBe(false);
    const r = canSpendDoubleDamage(state, "hero-01", "damage-2x-light");
    expect(r.ok).toBe(true);
  });
});
