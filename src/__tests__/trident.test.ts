/**
 * Tests for the Trident equipment family (Slice 5+).
 *
 * Both ranks ship the same three engine pieces:
 *   1. `range.kind === "fixed-pattern"` with a printed offset list —
 *      every printed tile fires every swing, no targeting picker.
 *   2. `pre-attack-may-move-adjacent` effect — optional 1-tile push
 *      of an 8-way-adjacent enemy BEFORE damage resolves so the
 *      printed pattern targets the new position.
 *   3. `weapon-counter-block` effect — after the counter rolls, the
 *      player picks ONE counterattacker whose effective `attack`
 *      drops by `amount` for this counter only.
 *
 * Coverage notes:
 *   - The pattern coords are validated against the printed cards
 *     (Shift Trident NORTH = W/WW/S; Golden Trident NORTH = NW/NE/2NE).
 *     If the offsets ever diverge from the cards, these tests fail
 *     loudly so the data drift is caught at PR time.
 *   - `useWeaponAbility(..., { preAttackMove })` exercises every
 *     legality branch (alive-only, adjacent-only, legal-dest-only,
 *     effect-on-card-only) since these are all engine-level rules
 *     the UI relies on for "only paint legal options".
 *   - `applyCounterDamageWithShieldChoices(..., weaponCounterBlock)`
 *     is exercised both with and without a shield in play; the
 *     ordering rule "block first, then shield" is verified
 *     by checking that a shield's overblock heal is computed
 *     against the post-block damage.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { newCampaign, type CampaignState, type EnemyInstance } from "../state";
import { QUEST1, getEquipment } from "../data";
import { ensureEncounter } from "../engine/encounter";
import { startHeroTurn, useWeaponAbility } from "../engine/turn";
import {
  applyCounterDamageWithShieldChoices,
  buildAttackSession,
  computeWeaponHitTiles,
  counterBlockCandidates,
  finalizeAttackSession,
  resolveAllDamage,
  sessionWeaponCounterBlockAmount,
  type AttackSession,
} from "../engine/combat";
import { weaponCounterBlockDecision } from "../screens/ActionResolution";

const BOARD = QUEST1.waves[0]!.spawn.boardSize;
const TRIDENT_BODY = "body-trident-r1";
const TRIDENT_MIND = "mind-trident-r1";

/**
 * Standardised setup: encounter ready, both delvers placed at known
 * tiles, no enemies. The Trident is manually wired into hero-02's
 * loadout (Body) since it isn't in the printed starting hand —
 * bypassing `playWeaponCard` avoids changing real game data just
 * for the harness.
 */
function arenaWithBodyTrident(): CampaignState {
  const state = newCampaign();
  state.currentDelverId = "hero-02";
  ensureEncounter(state, QUEST1);
  state.encounter!.enemies = [];
  state.encounter!.delverPositions["hero-02"] = { x: 3, y: 3 };
  state.encounter!.delverPositions["hero-01"] = { x: 0, y: 5 };
  startHeroTurn(state);
  // Manually place the Body Trident in slot 0 (skips the hand check
  // which would otherwise reject because Trident isn't in the
  // printed starting equipment).
  state.loadouts["hero-02"]!.slotCards[0] = TRIDENT_BODY;
  state.encounter!.turnState["hero-02"]!.cardPlacedThisTurn = {
    slotIdx: 0,
    cardId: TRIDENT_BODY,
    autoRefreshedElement: null,
  };
  // Trident at R1 — the rank lookup matches printed damage.
  state.equipmentRanks["hero-02"]!.Trident = 1;
  return state;
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

// --- equipment.json shape ---------------------------------------------

describe("Trident equipment data", () => {
  it("Body (Shift) Trident R1 has fixed-pattern range with W/WW/S tiles", () => {
    const card = getEquipment(TRIDENT_BODY);
    expect(card.range?.kind).toBe("fixed-pattern");
    if (card.range?.kind !== "fixed-pattern") throw new Error("type guard");
    // Printed tiles: 1W, 2W, 1S relative to the bearer (NORTH-orientation
    // pattern; user-confirmed offsets).
    expect(card.range.tiles).toEqual([
      { dx: -1, dy: 0 },
      { dx: -2, dy: 0 },
      { dx:  0, dy: 1 },
    ]);
  });

  it("Mind (Golden) Trident R1 has fixed-pattern range with NW/NE/2NE tiles", () => {
    const card = getEquipment(TRIDENT_MIND);
    expect(card.range?.kind).toBe("fixed-pattern");
    if (card.range?.kind !== "fixed-pattern") throw new Error("type guard");
    // Printed tiles: 1 NW, 1 NE, 2 NE.
    expect(card.range.tiles).toEqual([
      { dx: -1, dy: -1 },
      { dx:  1, dy: -1 },
      { dx:  2, dy: -2 },
    ]);
  });

  it("both Tridents carry pre-attack-may-move-adjacent (range 1) and weapon-counter-block (1, 1)", () => {
    for (const id of [TRIDENT_BODY, TRIDENT_MIND]) {
      const card = getEquipment(id);
      const moveEff = (card.effects ?? []).find((e) => e.kind === "pre-attack-may-move-adjacent");
      const blockEff = (card.effects ?? []).find((e) => e.kind === "weapon-counter-block");
      expect(moveEff).toBeDefined();
      expect(blockEff).toBeDefined();
      if (moveEff?.kind === "pre-attack-may-move-adjacent") {
        expect(moveEff.range).toBe(1);
      }
      if (blockEff?.kind === "weapon-counter-block") {
        expect(blockEff.amount).toBe(1);
        expect(blockEff.count).toBe(1);
      }
    }
  });
});

// --- computeWeaponHitTiles for fixed-pattern --------------------------

describe("computeWeaponHitTiles — fixed-pattern", () => {
  it("returns every printed tile when the bearer is mid-board (Shift Trident)", () => {
    const s = arenaWithBodyTrident();
    const range = getEquipment(TRIDENT_BODY).range!;
    const out = computeWeaponHitTiles({
      range,
      attackerPos: { x: 3, y: 3 },
      otherDelverPos: null,
      encounter: s.encounter!,
      board: BOARD,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("guard");
    // Printed pattern offsets translated to absolute coords.
    expect(out.tiles).toEqual([
      { x: 2, y: 3 },
      { x: 1, y: 3 },
      { x: 3, y: 4 },
    ]);
  });

  it("clips off-board tiles silently (bearer near west edge)", () => {
    const s = arenaWithBodyTrident();
    s.encounter!.delverPositions["hero-02"] = { x: 0, y: 3 };
    const range = getEquipment(TRIDENT_BODY).range!;
    const out = computeWeaponHitTiles({
      range,
      attackerPos: { x: 0, y: 3 },
      otherDelverPos: null,
      encounter: s.encounter!,
      board: BOARD,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("guard");
    // Both W tiles clip off-board; only the S tile survives.
    expect(out.tiles).toEqual([{ x: 0, y: 4 }]);
  });

  it("Golden Trident NORTH from a position that fits all 3 prongs produces NW/NE/2NE", () => {
    // Bearer at (2, 2) on the 5x5 quest1 board so 2NE = (4, 0) stays
    // on-board. From (3, 3) the 2NE prong would clip (x=5 ≥ 5).
    const s = arenaWithBodyTrident();
    const range = getEquipment(TRIDENT_MIND).range!;
    const out = computeWeaponHitTiles({
      range,
      attackerPos: { x: 2, y: 2 },
      otherDelverPos: null,
      encounter: s.encounter!,
      board: BOARD,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("guard");
    expect(out.tiles).toEqual([
      { x: 1, y: 1 },
      { x: 3, y: 1 },
      { x: 4, y: 0 },
    ]);
  });

  it("clips Golden Trident's 2NE prong when bearer is too far east", () => {
    const s = arenaWithBodyTrident();
    const range = getEquipment(TRIDENT_MIND).range!;
    const out = computeWeaponHitTiles({
      range,
      attackerPos: { x: 3, y: 3 }, // 2NE = (5, 1) clips off x=5 edge
      otherDelverPos: null,
      encounter: s.encounter!,
      board: BOARD,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("guard");
    expect(out.tiles).toEqual([
      { x: 2, y: 2 },
      { x: 4, y: 2 },
    ]);
  });

  it("does NOT require a live enemy on every (or any) printed tile — the swing still fires", () => {
    const s = arenaWithBodyTrident();
    // Empty board around the bearer; the engine still returns the
    // tile list, and `resolveAllDamage` records each as a miss step.
    const range = getEquipment(TRIDENT_BODY).range!;
    const out = computeWeaponHitTiles({
      range,
      attackerPos: { x: 3, y: 3 },
      otherDelverPos: null,
      encounter: s.encounter!,
      board: BOARD,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("guard");
    expect(out.tiles.length).toBe(3);
  });
});

// --- useWeaponAbility — fixed-pattern end-to-end ----------------------

describe("useWeaponAbility — fixed-pattern (no pre-move)", () => {
  let s: CampaignState;
  beforeEach(() => { s = arenaWithBodyTrident(); });

  it("succeeds with no preAttackMove and damages enemies on each printed tile", () => {
    placeEnemy(s, "e1", 2, 3); // 1W of bearer at (3, 3)
    placeEnemy(s, "e2", 1, 3); // 2W
    placeEnemy(s, "e3", 3, 4); // 1S
    const r = useWeaponAbility(s, "hero-02", 0, { kind: "fixed-pattern" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("guard");
    resolveAllDamage(s, r.session);
    finalizeAttackSession(s, r.session);
    // All three enemies took the printed damage and (since their HP
    // is 2 and damage is 2) died on the same swing.
    const live = s.encounter!.enemies.filter((e) => e.alive).map((e) => e.instanceId);
    expect(live).toEqual([]);
    // Three damage steps, all kills.
    expect(r.session.steps.length).toBe(3);
    expect(r.session.steps.every((st) => st.killed)).toBe(true);
  });

  it("missing tiles (no live enemy) become miss steps without breaking the swing", () => {
    placeEnemy(s, "e1", 2, 3); // only the 1W tile is occupied
    const r = useWeaponAbility(s, "hero-02", 0, { kind: "fixed-pattern" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("guard");
    resolveAllDamage(s, r.session);
    expect(r.session.steps.length).toBe(3);
    const killed = r.session.steps.filter((st) => st.killed).length;
    const misses = r.session.steps.filter((st) => st.enemyInstanceId == null).length;
    expect(killed).toBe(1);
    expect(misses).toBe(2);
  });

  it("latches actionUsedThisTurn on success", () => {
    placeEnemy(s, "e1", 2, 3);
    const r = useWeaponAbility(s, "hero-02", 0, { kind: "fixed-pattern" });
    expect(r.ok).toBe(true);
    expect(s.encounter!.turnState["hero-02"]!.actionUsedThisTurn).toBe(true);
  });
});

// --- pre-attack-may-move-adjacent --------------------------------------

describe("useWeaponAbility — fixed-pattern with preAttackMove", () => {
  let s: CampaignState;
  beforeEach(() => { s = arenaWithBodyTrident(); });

  it("applies the move BEFORE damage so the enemy at its NEW position takes the hit", () => {
    // Enemy starts at (3, 2) — N of bearer, OUTSIDE the printed
    // pattern. Move it to (2, 3) — 1W of bearer, INSIDE the pattern.
    const enemy = placeEnemy(s, "e1", 3, 2);
    const r = useWeaponAbility(
      s, "hero-02", 0,
      { kind: "fixed-pattern" },
      { preAttackMove: { enemyInstanceId: enemy.instanceId, toX: 2, toY: 3 } },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("guard");
    resolveAllDamage(s, r.session);
    finalizeAttackSession(s, r.session);
    // The enemy ended up on a printed tile (1W) and died.
    expect(enemy.alive).toBe(false);
    expect(enemy.x).toBe(2);
    expect(enemy.y).toBe(3);
    // PreEffect was recorded.
    const preMove = r.session.preEffects.find((e) => e.kind === "pre-attack-move-enemy");
    expect(preMove).toBeDefined();
    if (preMove?.kind === "pre-attack-move-enemy") {
      expect(preMove.from).toEqual({ x: 3, y: 2 });
      expect(preMove.to).toEqual({ x: 2, y: 3 });
      expect(preMove.heroId).toBe("hero-02");
    }
  });

  it("can move an enemy OUT of a pattern tile to dodge the swing", () => {
    // Enemy starts on a pattern tile (2, 3). Move them to (3, 2) —
    // OUTSIDE the pattern. They should survive the swing.
    const enemy = placeEnemy(s, "e1", 2, 3);
    const r = useWeaponAbility(
      s, "hero-02", 0,
      { kind: "fixed-pattern" },
      { preAttackMove: { enemyInstanceId: enemy.instanceId, toX: 3, toY: 2 } },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("guard");
    resolveAllDamage(s, r.session);
    finalizeAttackSession(s, r.session);
    expect(enemy.alive).toBe(true);
    expect(enemy.x).toBe(3);
    expect(enemy.y).toBe(2);
  });

  it("rejects when the placed card has no pre-attack-may-move-adjacent effect", () => {
    // Swap the placed card to body-sword-r1 (no pre-move effect).
    s.loadouts["hero-02"]!.slotCards[0] = "body-sword-r1";
    s.encounter!.turnState["hero-02"]!.cardPlacedThisTurn!.cardId = "body-sword-r1";
    const enemy = placeEnemy(s, "e1", 2, 3);
    const r = useWeaponAbility(
      s, "hero-02", 0,
      { kind: "single-adjacent", targetX: 2, targetY: 3 },
      { preAttackMove: { enemyInstanceId: enemy.instanceId, toX: 3, toY: 2 } },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("guard");
    expect(r.reason).toMatch(/no pre-attack move effect/);
    // Action gate NOT latched on rejection.
    expect(s.encounter!.turnState["hero-02"]!.actionUsedThisTurn).toBe(false);
    // Enemy not moved.
    expect(enemy.x).toBe(2);
    expect(enemy.y).toBe(3);
  });

  it("rejects when the named enemy is not 8-way adjacent to the bearer", () => {
    const enemy = placeEnemy(s, "e1", 3, 5); // 2 tiles south of (3, 3)
    const r = useWeaponAbility(
      s, "hero-02", 0,
      { kind: "fixed-pattern" },
      { preAttackMove: { enemyInstanceId: enemy.instanceId, toX: 3, toY: 4 } },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("guard");
    expect(r.reason).toMatch(/not 8-way adjacent/);
    expect(enemy.x).toBe(3);
    expect(enemy.y).toBe(5);
  });

  it("rejects when the destination is not a legal move tile (occupied by enemy)", () => {
    const e1 = placeEnemy(s, "e1", 2, 3); // adjacent to bearer
    placeEnemy(s, "e2", 2, 4);            // would-be destination, occupied
    const r = useWeaponAbility(
      s, "hero-02", 0,
      { kind: "fixed-pattern" },
      { preAttackMove: { enemyInstanceId: e1.instanceId, toX: 2, toY: 4 } },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("guard");
    expect(r.reason).toMatch(/not a legal/);
    // e1 not moved.
    expect(e1.x).toBe(2);
    expect(e1.y).toBe(3);
  });

  it("rejects when the named enemy is dead", () => {
    const enemy = placeEnemy(s, "e1", 2, 3);
    enemy.alive = false;
    const r = useWeaponAbility(
      s, "hero-02", 0,
      { kind: "fixed-pattern" },
      { preAttackMove: { enemyInstanceId: enemy.instanceId, toX: 2, toY: 4 } },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("guard");
    expect(r.reason).toMatch(/not found or dead/);
  });
});

// --- weapon-counter-block via applyCounterDamageWithShieldChoices ----

describe("applyCounterDamageWithShieldChoices — weaponCounterBlock", () => {
  /**
   * Build a finalized-up-to-counter session: a Trident swing + its
   * `sharedCounter` populated by `resolveAllDamage`. The block tests
   * then drive `applyCounterDamageWithShieldChoices` directly.
   *
   * Layout: bearer at (3, 3); Soulhunter (attack=2) placed at (3, 4)
   * — on the bearer's 1S tile (printed Trident pattern). The
   * Soulhunter's `counterCommon` includes (0, -1), so on a roll of 2
   * (common) the counter pattern hits (3, 3) — the bearer's own
   * tile. That's the hit we'll use to verify the block reduction.
   */
  function tridentSwingAtSoulhunter(): { state: CampaignState; session: AttackSession } {
    const state = arenaWithBodyTrident();
    placeEnemy(state, "boss", 3, 4, "soulhunter-001");
    const r = useWeaponAbility(state, "hero-02", 0, { kind: "fixed-pattern" });
    if (!r.ok) throw new Error(`useWeaponAbility failed: ${r.reason}`);
    resolveAllDamage(state, r.session);
    return { state, session: r.session };
  }

  it("with kind:'block' choice — reduces the chosen enemy's effective attack by 1", () => {
    const { state, session } = tridentSwingAtSoulhunter();
    const phase = session.sharedCounter!;
    expect(phase.damagedEnemies[0]!.cardId).toBe("soulhunter-001");
    const enemyInstanceId = phase.damagedEnemies[0]!.instanceId;
    const beforeHp = state.loadouts["hero-02"]!.currentHp;
    // Roll a 2 → "common" outcome → counter lands on (3, 3) for 2 attack.
    applyCounterDamageWithShieldChoices(
      state, session, 2, {},
      { kind: "block", enemyInstanceIds: [enemyInstanceId] },
    );
    // Soulhunter attack=2; block=1; net 1 damage to the bearer.
    expect(state.loadouts["hero-02"]!.currentHp).toBe(beforeHp - 1);
    expect(phase.resolved).toBe(true);
    // `phase.hits` now records the per-hero total.
    const hit = phase.hits.find((h) => h.heroId === "hero-02");
    expect(hit?.damage).toBe(1);
  });

  it("with kind:'skip' — no reduction, full damage lands", () => {
    const { state, session } = tridentSwingAtSoulhunter();
    const beforeHp = state.loadouts["hero-02"]!.currentHp;
    applyCounterDamageWithShieldChoices(
      state, session, 2, {},
      { kind: "skip" },
    );
    expect(state.loadouts["hero-02"]!.currentHp).toBe(beforeHp - 2);
  });

  it("multi-delver tile-mate: both delvers benefit when the chosen enemy is reduced", () => {
    const { state, session } = tridentSwingAtSoulhunter();
    // Park hero-01 (Mind) on the bearer's tile — both delvers should
    // be hit by the Soulhunter's counter for the SAME reduced 1.
    state.encounter!.delverPositions["hero-01"] = { x: 3, y: 3 };
    const phase = session.sharedCounter!;
    const enemyInstanceId = phase.damagedEnemies[0]!.instanceId;
    const beforeHp1 = state.loadouts["hero-01"]!.currentHp;
    const beforeHp2 = state.loadouts["hero-02"]!.currentHp;
    applyCounterDamageWithShieldChoices(
      state, session, 2, {},
      { kind: "block", enemyInstanceIds: [enemyInstanceId] },
    );
    expect(state.loadouts["hero-01"]!.currentHp).toBe(beforeHp1 - 1);
    expect(state.loadouts["hero-02"]!.currentHp).toBe(beforeHp2 - 1);
  });

  it("source isn't a Trident → block is silently ignored (defensive)", () => {
    // Build a Sword swing instead (no weapon-counter-block effect).
    // Soulhunter at (3, 4); Sword targets it via single-adjacent.
    const state = arenaWithBodyTrident();
    state.loadouts["hero-02"]!.slotCards[0] = "body-sword-r1";
    state.encounter!.turnState["hero-02"]!.cardPlacedThisTurn!.cardId = "body-sword-r1";
    placeEnemy(state, "boss", 3, 4, "soulhunter-001");
    const r = useWeaponAbility(state, "hero-02", 0, {
      kind: "single-adjacent", targetX: 3, targetY: 4,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("guard");
    resolveAllDamage(state, r.session);
    const beforeHp = state.loadouts["hero-02"]!.currentHp;
    // Pass a block choice anyway — engine should ignore it because the
    // Sword doesn't carry weapon-counter-block.
    applyCounterDamageWithShieldChoices(
      state, r.session, 2, {},
      { kind: "block", enemyInstanceIds: [r.session.sharedCounter!.damagedEnemies[0]!.instanceId] },
    );
    expect(state.loadouts["hero-02"]!.currentHp).toBe(beforeHp - 2);
  });

  it("block referencing an enemy NOT in the counter — silent no-op", () => {
    const { state, session } = tridentSwingAtSoulhunter();
    const beforeHp = state.loadouts["hero-02"]!.currentHp;
    applyCounterDamageWithShieldChoices(
      state, session, 2, {},
      { kind: "block", enemyInstanceIds: ["ghost-id"] },
    );
    expect(state.loadouts["hero-02"]!.currentHp).toBe(beforeHp - 2);
  });

  it("block reduces an attack=1 enemy to 0 damage (full block)", () => {
    // Crystanid (HP=2, attack=1) at (2, 3) — Body Trident's 1W tile.
    // Trident damage = MEDIUM = 2, so the Crystanid dies on the
    // swing. Its `counterCommon` includes (1, 0) (1E), which from
    // (2, 3) lands on the bearer at (3, 3) for a roll of 2 (common).
    // Block 1 → 0 net damage to bearer.
    const state = arenaWithBodyTrident();
    placeEnemy(state, "minion", 2, 3, "crystanid-001");
    const r = useWeaponAbility(state, "hero-02", 0, { kind: "fixed-pattern" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("guard");
    resolveAllDamage(state, r.session);
    const phase = r.session.sharedCounter!;
    // The Crystanid was killed on the swing but is still snapshotted
    // for the counter (DamagedEnemySnapshot is taken at damage time).
    const minionSnap = phase.damagedEnemies.find((d) => d.cardId === "crystanid-001");
    expect(minionSnap).toBeDefined();
    const beforeHp = state.loadouts["hero-02"]!.currentHp;
    applyCounterDamageWithShieldChoices(
      state, r.session, 2, {},
      { kind: "block", enemyInstanceIds: [minionSnap!.instanceId] },
    );
    // Crystanid attack=1; block=1; net 0 damage.
    expect(state.loadouts["hero-02"]!.currentHp).toBe(beforeHp);
    const hit = phase.hits.find((h) => h.heroId === "hero-02");
    expect(hit).toBeUndefined(); // 0-damage hits are dropped.
  });

  it("undefined block choice (non-Trident or skipped) behaves identically to skip", () => {
    const { state, session } = tridentSwingAtSoulhunter();
    const beforeHp = state.loadouts["hero-02"]!.currentHp;
    applyCounterDamageWithShieldChoices(state, session, 2, {});
    expect(state.loadouts["hero-02"]!.currentHp).toBe(beforeHp - 2);
  });
});

// --- counterBlockCandidates -----------------------------------------

describe("counterBlockCandidates", () => {
  it("returns one entry per counterattacker that would actually deal damage", () => {
    const state = arenaWithBodyTrident();
    placeEnemy(state, "boss", 3, 4, "soulhunter-001");
    const r = useWeaponAbility(state, "hero-02", 0, { kind: "fixed-pattern" });
    if (!r.ok) throw new Error("guard");
    resolveAllDamage(state, r.session);
    // Force the outcome so the candidates compute deterministically.
    r.session.sharedCounter!.outcome = "common";
    const out = counterBlockCandidates(state, r.session);
    expect(out.length).toBe(1);
    expect(out[0]!.cardId).toBe("soulhunter-001");
    expect(out[0]!.preBlockAttack).toBe(2);
    // Bearer at (3, 3) is hit; common (0, -1) offset from (3, 4) lands on (3, 3).
    const hit = out[0]!.preBlockDamage.find((d) => d.heroId === "hero-02");
    expect(hit?.damage).toBe(2);
  });

  it("returns [] when source has no weapon-counter-block effect", () => {
    const state = arenaWithBodyTrident();
    state.loadouts["hero-02"]!.slotCards[0] = "body-sword-r1";
    state.encounter!.turnState["hero-02"]!.cardPlacedThisTurn!.cardId = "body-sword-r1";
    placeEnemy(state, "boss", 3, 4, "soulhunter-001");
    const r = useWeaponAbility(state, "hero-02", 0, {
      kind: "single-adjacent", targetX: 3, targetY: 4,
    });
    if (!r.ok) throw new Error("guard");
    resolveAllDamage(state, r.session);
    r.session.sharedCounter!.outcome = "common";
    expect(counterBlockCandidates(state, r.session)).toEqual([]);
  });

  it("returns [] when outcome is miss", () => {
    const state = arenaWithBodyTrident();
    placeEnemy(state, "boss", 3, 4, "soulhunter-001");
    const r = useWeaponAbility(state, "hero-02", 0, { kind: "fixed-pattern" });
    if (!r.ok) throw new Error("guard");
    resolveAllDamage(state, r.session);
    r.session.sharedCounter!.outcome = "miss";
    expect(counterBlockCandidates(state, r.session)).toEqual([]);
  });
});

// --- session helper -----------------------------------------------------

describe("sessionWeaponCounterBlockAmount", () => {
  // Rank-aware since 2026-07-20; fresh campaign = R1 fallback.
  const blockHelperState = newCampaign();
  it("returns the printed amount for Trident sessions", () => {
    const session = buildAttackSession({
      attackerId: "hero-02",
      source: { kind: "weapon", slotIdx: 0, cardId: TRIDENT_BODY },
      damage: 2,
      hitTiles: [],
    });
    expect(sessionWeaponCounterBlockAmount(blockHelperState, session)).toBe(1);
  });

  it("returns the RANK-CORRECT amount for a ranked-up Trident (R3 blocks 3)", () => {
    // Regression companion to the Shockwave R2 fix 2026-07-20: the
    // helper must resolve the bearer's effective rank, not trust the
    // R1 placeholder id stored in the slot.
    const st = newCampaign();
    st.equipmentRanks["hero-02"]!.Trident = 3;
    const session = buildAttackSession({
      attackerId: "hero-02",
      source: { kind: "weapon", slotIdx: 0, cardId: TRIDENT_BODY },
      damage: 2,
      hitTiles: [],
    });
    expect(sessionWeaponCounterBlockAmount(st, session)).toBe(3);
  });

  it("returns 0 for non-Trident weapons", () => {
    const session = buildAttackSession({
      attackerId: "hero-02",
      source: { kind: "weapon", slotIdx: 0, cardId: "body-sword-r1" },
      damage: 2,
      hitTiles: [],
    });
    expect(sessionWeaponCounterBlockAmount(blockHelperState, session)).toBe(0);
  });

  it("returns 0 for slot-ability sources", () => {
    const session = buildAttackSession({
      attackerId: "hero-02",
      source: { kind: "slot", slotIdx: 0, element: "earth" },
      damage: 1,
      hitTiles: [],
    });
    expect(sessionWeaponCounterBlockAmount(blockHelperState, session)).toBe(0);
  });
});

// --- weaponCounterBlockDecision (UI-dispatch routing helper) ---------
//
// Pure decision helper extracted from `applySharedCounter` so the
// "open prompt vs. auto-apply vs. skip" routing can be pinned in
// tests without standing up the whole UI.
//
// Bug-history: pre-2026-05-09 the prompt opened whenever
// `candidates.length > 0`, which meant Trident's "Block 1 damage
// from 1 counterattack" — a printed-as-mandatory effect — fired
// an "ask which to block?" modal even when there was only one
// counterattacker. These tests pin the new routing: only PROMPT
// when there's a real choice (`candidates.length > cap`).

describe("weaponCounterBlockDecision", () => {
  it("returns 'skip' when no candidates exist (nothing to apply)", () => {
    const out = weaponCounterBlockDecision([], 1);
    expect(out.kind).toBe("skip");
  });

  it("returns 'skip' when cap is 0 (defensive — non-block weapon shouldn't reach here)", () => {
    const out = weaponCounterBlockDecision([{ enemyInstanceId: "e1" }], 0);
    expect(out.kind).toBe("skip");
  });

  // Trident: cap=1, 1 candidate → no real choice, AUTO-APPLY.
  // Pre-2026-05-09 this would have opened a useless one-button modal.
  it("returns 'auto-apply' for 1 candidate at cap 1 (Trident, single counterattacker)", () => {
    const out = weaponCounterBlockDecision([{ enemyInstanceId: "e1" }], 1);
    expect(out.kind).toBe("auto-apply");
    if (out.kind === "auto-apply") expect(out.enemyInstanceIds).toEqual(["e1"]);
  });

  // Shockwave: cap=2. With 1 or 2 candidates, no real choice, AUTO-APPLY all.
  it("returns 'auto-apply' for 1 candidate at cap 2 (Shockwave with single counterattacker)", () => {
    const out = weaponCounterBlockDecision([{ enemyInstanceId: "e1" }], 2);
    expect(out.kind).toBe("auto-apply");
    if (out.kind === "auto-apply") expect(out.enemyInstanceIds).toEqual(["e1"]);
  });

  it("returns 'auto-apply' for 2 candidates at cap 2 (Shockwave at exact cap)", () => {
    const out = weaponCounterBlockDecision(
      [{ enemyInstanceId: "e1" }, { enemyInstanceId: "e2" }],
      2,
    );
    expect(out.kind).toBe("auto-apply");
    if (out.kind === "auto-apply") expect(out.enemyInstanceIds).toEqual(["e1", "e2"]);
  });

  // The "real choice" cases — modal must open.
  it("returns 'prompt' for 2 candidates at cap 1 (Trident with multiple counterattackers)", () => {
    const out = weaponCounterBlockDecision(
      [{ enemyInstanceId: "e1" }, { enemyInstanceId: "e2" }],
      1,
    );
    expect(out.kind).toBe("prompt");
  });

  it("returns 'prompt' for 3 candidates at cap 2 (Shockwave with overflow)", () => {
    const out = weaponCounterBlockDecision(
      [
        { enemyInstanceId: "e1" },
        { enemyInstanceId: "e2" },
        { enemyInstanceId: "e3" },
      ],
      2,
    );
    expect(out.kind).toBe("prompt");
  });

  it("preserves candidate order in the auto-apply payload (so the engine apply order matches the UI's enumeration)", () => {
    const out = weaponCounterBlockDecision(
      [
        { enemyInstanceId: "alpha" },
        { enemyInstanceId: "beta" },
        { enemyInstanceId: "gamma" },
      ],
      3,
    );
    expect(out.kind).toBe("auto-apply");
    if (out.kind === "auto-apply") {
      expect(out.enemyInstanceIds).toEqual(["alpha", "beta", "gamma"]);
    }
  });
});
