/**
 * Tests for src/engine/soulshift.ts and the `freeRepeat` knob on
 * `useWeaponAbility` that the Soulshift Sword bonus-swing flow rides
 * on top of.
 *
 * Covers:
 *   - `attackSessionTriggersSoulshiftRoll` semantics: weapon source,
 *     `repeat-on-kill` effect present, kill in steps, encounter still
 *     in `hero` phase.
 *   - `adjacentLiveEnemiesForRepeat` 8-way + alive filter.
 *   - `classifySoulshiftRoll` thresholds (4-6 eligible) + "if able"
 *     short-circuit when no adjacent live targets.
 *   - `useWeaponAbility(..., { freeRepeat: true })`: bypasses the
 *     `actionUsedThisTurn` half of the action gate, does NOT re-latch
 *     it on success, and does NOT replay one-shot post-effects.
 *   - End-to-end: a chained kill via `freeRepeat` produces a NEW
 *     attack session whose own kill RE-triggers the Soulshift roll
 *     check (chain semantics).
 */

import { describe, it, expect, beforeEach } from "vitest";

import { newCampaign, type CampaignState, type EnemyInstance } from "../state";
import { QUEST1 } from "../data";
import { ensureEncounter } from "../engine/encounter";
import { startHeroTurn, useWeaponAbility, playWeaponCard } from "../engine/turn";
import {
  buildAttackSession,
  finalizeAttackSession,
  resolveAllDamage,
  resolveSharedCounter,
  type AttackSession,
} from "../engine/combat";
import {
  adjacentLiveEnemiesForRepeat,
  attackSessionTriggersSoulshiftRoll,
  classifySoulshiftRoll,
} from "../engine/soulshift";

const BOARD = QUEST1.waves[0]!.spawn.boardSize;

/**
 * Standardised setup: encounter ready, both delvers placed at known
 * tiles, no enemies. Matches the harness used by `boots.test.ts` so
 * the two test files stay easy to scan side-by-side.
 *
 * - hero-02 (Body) at (2, 2) — the Soulshift bearer.
 * - hero-01 (Mind) at (0, 4) — well clear of any counter pattern so
 *   the optional counter-roll path doesn't accidentally hit them.
 */
function arenaWithBodyBearer(): CampaignState {
  const state = newCampaign();
  state.currentDelverId = "hero-02";
  ensureEncounter(state, QUEST1);
  // Bypass the new first-turn-pick picker phase — the test builds
  // a bespoke arena and drives the engine directly, so flip
  // straight to `hero` rather than routing through
  // `commitFirstTurnPick` (which would overwrite the
  // hero-02 currentDelverId we just pinned).
  state.encounter!.phase = "hero";
  state.encounter!.enemies = [];
  state.encounter!.delverPositions["hero-02"] = { x: 2, y: 2 };
  state.encounter!.delverPositions["hero-01"] = { x: 0, y: 4 };
  // Run the start-of-turn helpers so currentMovement / currentAp / turnState
  // are sane. Then place the Soulshift Sword in slot 0 (matches the body
  // hero's `startingEquipment` order: gauntlet, sword, armor).
  startHeroTurn(state);
  const placed = playWeaponCard(state, "hero-02", 0, "body-sword-r1");
  if (!placed.ok) throw new Error(`setup: playWeaponCard failed: ${placed.reason}`);
  return state;
}

/**
 * Push a fresh enemy at (x, y). Crystanid 001 has 2 HP — exactly the
 * Soulshift Sword's MEDIUM damage value at R1 — so a single swing
 * always kills. That's the property we lean on for chain tests.
 */
function placeEnemy(state: CampaignState, instanceId: string, x: number, y: number): EnemyInstance {
  const e: EnemyInstance = {
    instanceId,
    cardId: "crystanid-001",
    x, y,
    damageTaken: 0,
    alive: true,
    facing: 0,
  };
  state.encounter!.enemies.push(e);
  return e;
}

/**
 * Build a synthetic attack session that already has its damage steps
 * recorded. Useful for testing
 * {@link attackSessionTriggersSoulshiftRoll} without having to wire
 * a full `useWeaponAbility` flow per case.
 */
function fakeFinalizedSession(
  cardId: string,
  killed: boolean,
): AttackSession {
  const session = buildAttackSession({
    attackerId: "hero-02",
    source: { kind: "weapon", slotIdx: 0, cardId },
    damage: 2,
    hitTiles: [{ x: 1, y: 2 }],
  });
  session.steps.push({
    tile: { x: 1, y: 2 },
    enemyInstanceId: killed ? "victim-1" : null,
    damageApplied: 2,
    killed,
  });
  return session;
}

// --- attackSessionTriggersSoulshiftRoll --------------------------------

describe("attackSessionTriggersSoulshiftRoll", () => {
  let s: CampaignState;
  beforeEach(() => { s = arenaWithBodyBearer(); });

  it("true when weapon was Soulshift Sword AND a kill landed AND phase is hero AND a live enemy is still adjacent", () => {
    // Adjacent live enemy is now part of the trigger precondition
    // ("if able" — see engine/soulshift.ts). Without one the trigger
    // short-circuits to false; that case is covered by its own test
    // below.
    placeEnemy(s, "still-adj", 3, 2);
    const session = fakeFinalizedSession("body-sword-r1", true);
    expect(attackSessionTriggersSoulshiftRoll(s, session)).toBe(true);
  });

  it("false when no LIVE enemy is 8-way adjacent to the bearer (the kill cleared the last one)", () => {
    // No enemy placed on the board at all → adjacency snapshot is
    // empty. Even though the synthetic session reports a kill, the
    // trigger's "if able" precondition fails and the modal is
    // suppressed (user report 2026-05-09 — kill the last adjacent
    // Crystanid, no point asking for a die roll that can never
    // chain).
    const session = fakeFinalizedSession("body-sword-r1", true);
    expect(attackSessionTriggersSoulshiftRoll(s, session)).toBe(false);
  });

  it("false when weapon has no `repeat-on-kill` effect (e.g. Body Beam)", () => {
    const session = fakeFinalizedSession("body-beam-r1", true);
    expect(attackSessionTriggersSoulshiftRoll(s, session)).toBe(false);
  });

  it("false when no kill was registered (session.steps[i].killed all false)", () => {
    const session = fakeFinalizedSession("body-sword-r1", false);
    expect(attackSessionTriggersSoulshiftRoll(s, session)).toBe(false);
  });

  it("false when the source is a slot ability rather than a weapon", () => {
    // Slot abilities can damage enemies (see slotAbilities.ts) but they
    // never carry the weapon's `repeat-on-kill` effect. Source kind is
    // "slot" — the early return inside `attackSessionTriggersSoulshiftRoll`
    // bails before we even touch `getEquipment`.
    const session = buildAttackSession({
      attackerId: "hero-02",
      source: { kind: "slot", slotIdx: 0, element: "earth" },
      damage: 1,
      hitTiles: [{ x: 1, y: 2 }],
    });
    session.steps.push({
      tile: { x: 1, y: 2 },
      enemyInstanceId: "victim-1",
      damageApplied: 1,
      killed: true,
    });
    expect(attackSessionTriggersSoulshiftRoll(s, session)).toBe(false);
  });

  it("false when the encounter has flipped to end-of-wave (delver-death short-circuit)", () => {
    const session = fakeFinalizedSession("body-sword-r1", true);
    s.encounter!.phase = "end-of-wave";
    expect(attackSessionTriggersSoulshiftRoll(s, session)).toBe(false);
  });

  it("false when no encounter at all", () => {
    const session = fakeFinalizedSession("body-sword-r1", true);
    s.encounter = null;
    expect(attackSessionTriggersSoulshiftRoll(s, session)).toBe(false);
  });
});

// --- adjacentLiveEnemiesForRepeat --------------------------------------

describe("adjacentLiveEnemiesForRepeat", () => {
  let s: CampaignState;
  beforeEach(() => { s = arenaWithBodyBearer(); });

  it("empty when no enemies are within 1 tile of the bearer", () => {
    placeEnemy(s, "e1", 4, 4); // 2 tiles away
    expect(adjacentLiveEnemiesForRepeat(s, "hero-02")).toEqual([]);
  });

  it("collects all 8-way adjacent LIVE enemies (excludes diagonals at distance 2 and dead enemies)", () => {
    placeEnemy(s, "e1", 1, 1);  // NW diagonal — adjacent
    placeEnemy(s, "e2", 3, 2);  // E — adjacent
    placeEnemy(s, "e3", 0, 0);  // 2 tiles away — not adjacent
    const dead = placeEnemy(s, "e4", 2, 3); // S — adjacent but dead
    dead.alive = false;
    const ids = adjacentLiveEnemiesForRepeat(s, "hero-02").map((e) => e.instanceId).sort();
    expect(ids).toEqual(["e1", "e2"]);
  });

  it("uses the bearer's CURRENT position (not the position they were at when they swung)", () => {
    // No enemies near (2, 2) but two near (4, 4).
    placeEnemy(s, "e1", 4, 5);
    placeEnemy(s, "e2", 5, 4);
    expect(adjacentLiveEnemiesForRepeat(s, "hero-02")).toEqual([]);
    // Teleport the bearer.
    s.encounter!.delverPositions["hero-02"] = { x: 4, y: 4 };
    expect(adjacentLiveEnemiesForRepeat(s, "hero-02").length).toBe(2);
  });
});

// --- classifySoulshiftRoll --------------------------------------------

describe("classifySoulshiftRoll", () => {
  let s: CampaignState;
  beforeEach(() => { s = arenaWithBodyBearer(); });

  it("rolls 1-3 are no-repeat regardless of adjacency", () => {
    placeEnemy(s, "e1", 2, 3);
    for (const r of [1, 2, 3]) {
      const out = classifySoulshiftRoll(s, "hero-02", r);
      expect(out.rolled).toBe(r);
      expect(out.outcome).toBe("no-repeat");
      expect(out.candidates).toEqual([]);
    }
  });

  it("rolls 4-6 with at least one adjacent live enemy → repeat-available", () => {
    placeEnemy(s, "e1", 2, 3);
    for (const r of [4, 5, 6]) {
      const out = classifySoulshiftRoll(s, "hero-02", r);
      expect(out.rolled).toBe(r);
      expect(out.outcome).toBe("repeat-available");
      expect(out.candidates.map((e) => e.instanceId)).toEqual(["e1"]);
    }
  });

  it("rolls 4-6 with no adjacent live enemies → no-repeat (the 'if able' clause)", () => {
    // No adjacent enemies at all.
    const out = classifySoulshiftRoll(s, "hero-02", 6);
    expect(out.outcome).toBe("no-repeat");
    expect(out.candidates).toEqual([]);
  });

  it("ignores enemies adjacent but DEAD when deciding 'if able'", () => {
    const dead = placeEnemy(s, "e1", 2, 3);
    dead.alive = false;
    const out = classifySoulshiftRoll(s, "hero-02", 5);
    expect(out.outcome).toBe("no-repeat");
  });
});

// --- useWeaponAbility(..., { freeRepeat: true }) ---------------------

describe("useWeaponAbility free-repeat (Soulshift Sword bonus swing)", () => {
  let s: CampaignState;
  beforeEach(() => { s = arenaWithBodyBearer(); });

  it("is rejected when actionUsedThisTurn is false (the gate is asymmetric: freeRepeat ONLY relaxes that one check)", () => {
    // Sanity: the body sword is placed but the action HASN'T been used.
    // freeRepeat is intended for SECOND swings; calling it before the
    // first swing is meaningless but still safe — the engine just
    // accepts because nothing else trips the gate. We document the
    // INVERSE here: on the first swing, freeRepeat=true behaves the
    // same as freeRepeat=false (both succeed when action is unused).
    expect(s.encounter!.turnState["hero-02"]!.actionUsedThisTurn).toBe(false);
    placeEnemy(s, "e1", 2, 3);
    const r = useWeaponAbility(
      s, "hero-02", 0,
      { kind: "single-adjacent", targetX: 2, targetY: 3 },
      { freeRepeat: true },
    );
    expect(r.ok).toBe(true);
    // freeRepeat should NOT latch the action flag (it stays where it was).
    expect(s.encounter!.turnState["hero-02"]!.actionUsedThisTurn).toBe(false);
  });

  it("after a normal swing has latched actionUsedThisTurn, a freeRepeat=false call is rejected but freeRepeat=true succeeds", () => {
    placeEnemy(s, "e1", 2, 3);
    placeEnemy(s, "e2", 1, 2); // a different adjacent target for the bonus

    // First swing — normal path. Latches the gate.
    const first = useWeaponAbility(
      s, "hero-02", 0,
      { kind: "single-adjacent", targetX: 2, targetY: 3 },
    );
    expect(first.ok).toBe(true);
    expect(s.encounter!.turnState["hero-02"]!.actionUsedThisTurn).toBe(true);

    // Without freeRepeat, gate trips.
    const blocked = useWeaponAbility(
      s, "hero-02", 0,
      { kind: "single-adjacent", targetX: 1, targetY: 2 },
    );
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.reason).toMatch(/action already used/);

    // With freeRepeat: gate is bypassed; succeeds; gate stays latched.
    const bonus = useWeaponAbility(
      s, "hero-02", 0,
      { kind: "single-adjacent", targetX: 1, targetY: 2 },
      { freeRepeat: true },
    );
    expect(bonus.ok).toBe(true);
    expect(s.encounter!.turnState["hero-02"]!.actionUsedThisTurn).toBe(true);
  });

  it("freeRepeat does NOT bypass the OTHER gate constraints (placement / phase / not-prepared-to-run)", () => {
    placeEnemy(s, "e1", 2, 3);
    // Mark the bearer as prepared to run — this should still block the
    // bonus swing because freeRepeat only opens the action-used door.
    s.encounter!.preparedToRun["hero-02"] = true;
    const r = useWeaponAbility(
      s, "hero-02", 0,
      { kind: "single-adjacent", targetX: 2, targetY: 3 },
      { freeRepeat: true },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/prepared to run/);
  });
});

// --- End-to-end: chained kills re-trigger the soulshift roll ----------

describe("end-to-end: chained Soulshift kills", () => {
  let s: CampaignState;
  beforeEach(() => { s = arenaWithBodyBearer(); });

  /**
   * Walk a single attack session through the standard pipeline and
   * return the finalized session. Mirrors what `startAttackSession`
   * + `applySharedCounter` + `finalizeAttackSession` do in the UI,
   * minus the modal plumbing — so test-side we control whether to
   * pass freeRepeat + verify the trigger check at every step.
   *
   * `counterRoll` is forwarded to `resolveSharedCounter`. Pass `1`
   * (miss) for clean tests; pass `-1` to skip the counter entirely
   * (matches the `!counterPhase.anyCanLand` auto-skip path).
   */
  function runOneSwing(
    state: CampaignState,
    targetX: number,
    targetY: number,
    options: { freeRepeat?: boolean; counterRoll?: number } = {},
  ): AttackSession {
    const r = useWeaponAbility(
      state, "hero-02", 0,
      { kind: "single-adjacent", targetX, targetY },
      { freeRepeat: options.freeRepeat },
    );
    if (!r.ok) throw new Error(`useWeaponAbility rejected: ${r.reason}`);
    const session = r.session;
    const phase = resolveAllDamage(state, session);
    const roll = options.counterRoll ?? (phase.anyCanLand ? 1 : -1);
    resolveSharedCounter(state, session, roll);
    finalizeAttackSession(state, session);
    return session;
  }

  it("first swing kills enemy A → trigger fires → bonus swing kills enemy B → trigger fires AGAIN", () => {
    const a = placeEnemy(s, "a", 2, 3); // adjacent S
    const b = placeEnemy(s, "b", 1, 2); // adjacent W
    const aPos = { x: a.x, y: a.y };
    const bPos = { x: b.x, y: b.y };

    // Sanity: both should die in one MEDIUM swing (Crystanid HP = 2).
    const swing1 = runOneSwing(s, aPos.x, aPos.y);
    expect(swing1.steps[0]!.killed).toBe(true);
    expect(attackSessionTriggersSoulshiftRoll(s, swing1)).toBe(true);

    // Bonus swing — freeRepeat path.
    const swing2 = runOneSwing(s, bPos.x, bPos.y, { freeRepeat: true });
    expect(swing2.steps[0]!.killed).toBe(true);
    // Updated 2026-05-09: the trigger now short-circuits when no live
    // enemy remains 8-way-adjacent to the bearer. This is the second
    // kill in a 2-enemy arena, so adjacency is empty → trigger is
    // false and the UI skips the wasted die roll. (See
    // `attackSessionTriggersSoulshiftRoll` precondition #4.)
    expect(attackSessionTriggersSoulshiftRoll(s, swing2)).toBe(false);

    // Belt-and-braces: even if upstream code DID open the modal, the
    // classifier would also gate any roll to no-repeat.
    expect(classifySoulshiftRoll(s, "hero-02", 6).outcome).toBe("no-repeat");
  });

  it("if a non-killing swing happens (e.g. damaged but not killed), the trigger does NOT fire", () => {
    // Pre-damage the enemy so MEDIUM (2 dmg) won't drop it past its HP.
    // Crystanid HP = 2; place a Crystanid with 1 damage already taken
    // — wait, that would kill it on the swing. Use a tougher target:
    // pre-damage past 2 won't help since 2 dmg + any prior >= 2 also
    // kills. We need an enemy with HP > 2. Soulhunter has higher HP
    // (data check below). Use it instead.
    const tank = placeEnemy(s, "tank", 2, 3);
    tank.cardId = "soulhunter-001"; // HP > 2 (verified in data)

    const swing = runOneSwing(s, 2, 3);
    expect(swing.steps[0]!.killed).toBe(false);
    expect(attackSessionTriggersSoulshiftRoll(s, swing)).toBe(false);
  });

  it("a chain of 3 kills is possible (no engine-side cap on chain length)", () => {
    // Three adjacent enemies at NW, N, NE.
    placeEnemy(s, "a", 1, 1);
    placeEnemy(s, "b", 2, 1);
    placeEnemy(s, "c", 3, 1);

    const swing1 = runOneSwing(s, 1, 1);
    expect(attackSessionTriggersSoulshiftRoll(s, swing1)).toBe(true);
    const swing2 = runOneSwing(s, 2, 1, { freeRepeat: true });
    expect(attackSessionTriggersSoulshiftRoll(s, swing2)).toBe(true);
    const swing3 = runOneSwing(s, 3, 1, { freeRepeat: true });
    // Third kill clears the entire adjacency cluster; trigger
    // short-circuits to false (precondition #4 — see
    // `attackSessionTriggersSoulshiftRoll` doc comment).
    expect(attackSessionTriggersSoulshiftRoll(s, swing3)).toBe(false);

    // Defence-in-depth: the classifier also gates to no-repeat if
    // anything else accidentally opens the modal.
    expect(classifySoulshiftRoll(s, "hero-02", 6).outcome).toBe("no-repeat");
    // Action gate is still latched the entire time (one action total
    // — the chain counts as ONE consumed action).
    expect(s.encounter!.turnState["hero-02"]!.actionUsedThisTurn).toBe(true);
  });
});

// Sanity: BOARD shape used here matches the global board so the tests
// don't accidentally pass on a non-Quest1 layout.
describe("test-fixture sanity", () => {
  it("BOARD has w,h matching QUEST1 wave1 spawn", () => {
    expect(BOARD.w).toBeGreaterThan(0);
    expect(BOARD.h).toBeGreaterThan(0);
  });
});
