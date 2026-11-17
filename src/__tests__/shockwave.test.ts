/**
 * Tests for the Shockwave equipment family (Slice 5+).
 *
 * Both ranks ship the same two engine pieces:
 *   1. `range.kind === "fixed-pattern"` with a printed offset list —
 *      every printed tile fires every swing, no targeting picker.
 *      Mind (Web) hits 4 cardinals as RAYS of 3 tiles each (N/E/S/W)
 *      + 4 diagonals at distance 1 (NE/SE/SW/NW). Body (Overload)
 *      is the rotation: 4 cardinals at distance 1 + 4 diagonal RAYS
 *      of 3 tiles each. Total: 16 printed tiles per swing for each
 *      card; off-board ones clip silently. (Pattern verified against
 *      the printed Suit A + Suit B PDFs — see DESIGN.md §7.2.)
 *   2. `weapon-counter-block { amount: 1, count: 2 }` — after the
 *      counter rolls, the player picks UP TO 2 counterattackers
 *      whose effective `attack` drops by 1 each. This file is the
 *      primary coverage of the multi-pick path on top of the
 *      single-pick coverage in `trident.test.ts`.
 *
 * Coverage notes:
 *   - The pattern coords are validated against the printed cards
 *     (Mind = 4 cardinal-3 rays + 4 diagonals; Body = 4 cardinals
 *     + 4 diagonal-3 rays). If the offsets ever drift, these tests
 *     fail loudly.
 *   - The 2-pick path is exercised via two Soulhunters, both on
 *     Body Shockwave diagonal-ray tiles AND both counter-hitting
 *     the bearer on a "common" roll. The full block matrix (skip,
 *     1 pick, 2 picks, duplicate, excess) is asserted.
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
  sessionWeaponCounterBlockCount,
  weaponCounterBlockMap,
  type AttackSession,
} from "../engine/combat";

const BOARD = QUEST1.waves[0]!.spawn.boardSize;
const SHOCK_BODY = "body-shockwave-r1";
const SHOCK_MIND = "mind-shockwave-r1";

/**
 * Standardised setup mirroring the Trident harness: encounter
 * ready, both delvers placed, Shockwave manually wired into
 * hero-02's Body suit slot 0. Bearer defaults to (2, 2) so that the
 * Body Overload pattern's far-diagonal rays (distance 3) only clip
 * by 1 tile per direction — making the on-board hit list tractable.
 */
function arenaWithBodyShockwave(): CampaignState {
  const state = newCampaign();
  state.currentDelverId = "hero-02";
  ensureEncounter(state, QUEST1);
  state.encounter!.enemies = [];
  state.encounter!.delverPositions["hero-02"] = { x: 2, y: 2 };
  state.encounter!.delverPositions["hero-01"] = { x: 0, y: 4 };
  startHeroTurn(state);
  state.loadouts["hero-02"]!.slotCards[0] = SHOCK_BODY;
  state.encounter!.turnState["hero-02"]!.cardPlacedThisTurn = {
    slotIdx: 0,
    cardId: SHOCK_BODY,
    autoRefreshedElement: null,
  };
  state.equipmentRanks["hero-02"]!.Shockwave = 1;
  return state;
}

function placeEnemy(
  state: CampaignState,
  instanceId: string,
  x: number,
  y: number,
  cardId = "soulhunter-001",
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

describe("Shockwave equipment data", () => {
  it("Mind (Web) Shockwave R1 has fixed-pattern range with 4 cardinal-3 rays + 4 diagonals", () => {
    const card = getEquipment(SHOCK_MIND);
    expect(card.range?.kind).toBe("fixed-pattern");
    if (card.range?.kind !== "fixed-pattern") throw new Error("type guard");
    // Per printed Suit B card 101: cardinals ray out 3 tiles each
    // (N/E/S/W), diagonals stop at distance 1 (NE/SE/SW/NW). Order
    // matches `equipment.json` so a re-shuffle would break this —
    // intentional, so coord drift is caught at PR time.
    expect(card.range.tiles).toEqual([
      { dx:  1, dy: -1 },
      { dx:  1, dy:  1 },
      { dx: -1, dy:  1 },
      { dx: -1, dy: -1 },
      { dx:  0, dy: -1 }, { dx:  0, dy: -2 }, { dx:  0, dy: -3 },
      { dx:  1, dy:  0 }, { dx:  2, dy:  0 }, { dx:  3, dy:  0 },
      { dx:  0, dy:  1 }, { dx:  0, dy:  2 }, { dx:  0, dy:  3 },
      { dx: -1, dy:  0 }, { dx: -2, dy:  0 }, { dx: -3, dy:  0 },
    ]);
  });

  it("Body (Overload) Shockwave R1 has fixed-pattern range with 4 cardinals + 4 diagonal-3 rays", () => {
    const card = getEquipment(SHOCK_BODY);
    expect(card.range?.kind).toBe("fixed-pattern");
    if (card.range?.kind !== "fixed-pattern") throw new Error("type guard");
    // Per printed Suit A card 031: diagonals ray out 3 tiles each
    // (NE/SE/SW/NW), cardinals stop at distance 1 (N/E/S/W). This
    // is the rotation of the Mind (Web) pattern above.
    expect(card.range.tiles).toEqual([
      { dx:  0, dy: -1 },
      { dx:  1, dy:  0 },
      { dx:  0, dy:  1 },
      { dx: -1, dy:  0 },
      { dx:  1, dy: -1 }, { dx:  2, dy: -2 }, { dx:  3, dy: -3 },
      { dx:  1, dy:  1 }, { dx:  2, dy:  2 }, { dx:  3, dy:  3 },
      { dx: -1, dy:  1 }, { dx: -2, dy:  2 }, { dx: -3, dy:  3 },
      { dx: -1, dy: -1 }, { dx: -2, dy: -2 }, { dx: -3, dy: -3 },
    ]);
  });

  it("both Shockwaves carry weapon-counter-block (1, 2) and no pre-attack-may-move-adjacent", () => {
    for (const id of [SHOCK_BODY, SHOCK_MIND]) {
      const card = getEquipment(id);
      const blockEff = (card.effects ?? []).find((e) => e.kind === "weapon-counter-block");
      const moveEff = (card.effects ?? []).find((e) => e.kind === "pre-attack-may-move-adjacent");
      expect(blockEff).toBeDefined();
      expect(moveEff).toBeUndefined(); // Shockwave doesn't share Trident's pre-move
      if (blockEff?.kind === "weapon-counter-block") {
        expect(blockEff.amount).toBe(1);
        // The defining knob — count: 2 unlocks the multi-pick UI.
        expect(blockEff.count).toBe(2);
      }
    }
  });
});

// --- computeWeaponHitTiles for Shockwave fixed-pattern ----------------

describe("computeWeaponHitTiles - Shockwave fixed-pattern", () => {
  it("Body Shockwave from (2,2) produces 4 cardinals + 8 in-bounds diagonal-ray tiles", () => {
    const s = arenaWithBodyShockwave();
    const range = getEquipment(SHOCK_BODY).range!;
    const out = computeWeaponHitTiles({
      range,
      attackerPos: { x: 2, y: 2 },
      otherDelverPos: null,
      encounter: s.encounter!,
      board: BOARD,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("guard");
    // From (2,2) on a 5x5: each diagonal ray of 3 has its 3rd tile
    // clip once per direction (e.g. 3NE = (5,-1) → off-board).
    expect(out.tiles).toEqual([
      // 4 cardinals
      { x: 2, y: 1 }, // 1N
      { x: 3, y: 2 }, // 1E
      { x: 2, y: 3 }, // 1S
      { x: 1, y: 2 }, // 1W
      // NE ray (3rd clips)
      { x: 3, y: 1 }, { x: 4, y: 0 },
      // SE ray (3rd clips)
      { x: 3, y: 3 }, { x: 4, y: 4 },
      // SW ray (3rd clips)
      { x: 1, y: 3 }, { x: 0, y: 4 },
      // NW ray (3rd clips)
      { x: 1, y: 1 }, { x: 0, y: 0 },
    ]);
  });

  it("Mind Shockwave from (2,2) produces all on-board tiles with cardinal rays clipped at one edge each", () => {
    const s = arenaWithBodyShockwave();
    s.loadouts["hero-02"]!.slotCards[0] = SHOCK_MIND;
    s.encounter!.turnState["hero-02"]!.cardPlacedThisTurn!.cardId = SHOCK_MIND;
    const range = getEquipment(SHOCK_MIND).range!;
    const out = computeWeaponHitTiles({
      range,
      attackerPos: { x: 2, y: 2 },
      otherDelverPos: null,
      encounter: s.encounter!,
      board: BOARD,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("guard");
    // From (2,2) on a 5x5: every diagonal stays on-board; each
    // cardinal ray of 3 has its 3rd tile clip exactly once (e.g.
    // 3N from (2,2) is (2,-1) → off-board).
    expect(out.tiles).toEqual([
      // 4 diagonals
      { x: 3, y: 1 }, // 1NE
      { x: 3, y: 3 }, // 1SE
      { x: 1, y: 3 }, // 1SW
      { x: 1, y: 1 }, // 1NW
      // N ray (3rd clips)
      { x: 2, y: 1 }, { x: 2, y: 0 },
      // E ray (3rd clips)
      { x: 3, y: 2 }, { x: 4, y: 2 },
      // S ray (3rd clips)
      { x: 2, y: 3 }, { x: 2, y: 4 },
      // W ray (3rd clips)
      { x: 1, y: 2 }, { x: 0, y: 2 },
    ]);
  });

  it("Body Shockwave from a corner clips heavily but still returns all on-board tiles", () => {
    const s = arenaWithBodyShockwave();
    s.encounter!.delverPositions["hero-02"] = { x: 0, y: 0 };
    const range = getEquipment(SHOCK_BODY).range!;
    const out = computeWeaponHitTiles({
      range,
      attackerPos: { x: 0, y: 0 },
      otherDelverPos: null,
      encounter: s.encounter!,
      board: BOARD,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("guard");
    // From (0,0) on a 5x5: only the E + S cardinals and the SE
    // diagonal-3 ray stay on-board; the N + W cardinals and the
    // NE/SW/NW diagonal rays all clip entirely.
    expect(out.tiles).toEqual([
      { x: 1, y: 0 }, // 1E cardinal
      { x: 0, y: 1 }, // 1S cardinal
      // SE ray (all 3 fit)
      { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 },
    ]);
  });
});

// --- useWeaponAbility — fixed-pattern end-to-end (Shockwave) ----------

describe("useWeaponAbility - Body Shockwave fires every printed tile", () => {
  let s: CampaignState;
  beforeEach(() => { s = arenaWithBodyShockwave(); });

  it("damages every enemy on a printed tile and records the rest as miss steps", () => {
    // Place enemies on 3 Body Shockwave tiles from (2,2):
    //   - (3, 1) = 1NE (NE diagonal-ray 1st tile)
    //   - (1, 1) = 1NW (NW diagonal-ray 1st tile)
    //   - (4, 0) = 2NE (NE diagonal-ray 2nd tile)
    placeEnemy(s, "ne",  3, 1);
    placeEnemy(s, "nw",  1, 1);
    placeEnemy(s, "ne2", 4, 0);
    const r = useWeaponAbility(s, "hero-02", 0, { kind: "fixed-pattern" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("guard");
    resolveAllDamage(s, r.session);
    finalizeAttackSession(s, r.session);
    // 12 printed (on-board) tiles → 3 hits, 9 miss steps.
    expect(r.session.steps.length).toBe(12);
    const hits = r.session.steps.filter((st) => st.enemyInstanceId != null);
    const misses = r.session.steps.filter((st) => st.enemyInstanceId == null);
    expect(hits.length).toBe(3);
    expect(misses.length).toBe(9);
    // Soulhunter HP=12 - LIGHT damage 1 → 1 dmg taken, none killed.
    const live = s.encounter!.enemies.filter((e) => e.alive);
    expect(live.length).toBe(3);
    for (const e of s.encounter!.enemies) {
      expect(e.damageTaken).toBe(1);
    }
  });

  it("latches actionUsedThisTurn on success", () => {
    placeEnemy(s, "ne", 3, 1);
    const r = useWeaponAbility(s, "hero-02", 0, { kind: "fixed-pattern" });
    expect(r.ok).toBe(true);
    expect(s.encounter!.turnState["hero-02"]!.actionUsedThisTurn).toBe(true);
  });
});

// --- session helpers (count: 2) ---------------------------------------

// State passed to the rank-aware counter-block helpers (2026-07-20:
// they resolve the RANK-CORRECT card off equipmentRanks instead of
// trusting the R1 placeholder id in the slot). hero-02 has no
// Shockwave/Trident rank in a fresh campaign, so these helper tests
// fall back to the placed card's printed rank (R1) — pinning the
// same values the old session-only helpers returned.
const blockHelperState = newCampaign();

describe("session helpers - Shockwave", () => {
  it("sessionWeaponCounterBlockAmount returns 1 for Shockwave", () => {
    const session = buildAttackSession({
      attackerId: "hero-02",
      source: { kind: "weapon", slotIdx: 0, cardId: SHOCK_BODY },
      damage: 1,
      hitTiles: [],
    });
    expect(sessionWeaponCounterBlockAmount(blockHelperState, session)).toBe(1);
  });

  it("sessionWeaponCounterBlockCount returns 2 for Shockwave (vs 1 for Trident, 0 for Sword)", () => {
    for (const cardId of [SHOCK_BODY, SHOCK_MIND]) {
      const session = buildAttackSession({
        attackerId: "hero-02",
        source: { kind: "weapon", slotIdx: 0, cardId },
        damage: 1,
        hitTiles: [],
      });
      expect(sessionWeaponCounterBlockCount(blockHelperState, session)).toBe(2);
    }
    const tridSession = buildAttackSession({
      attackerId: "hero-02",
      source: { kind: "weapon", slotIdx: 0, cardId: "body-trident-r1" },
      damage: 2,
      hitTiles: [],
    });
    expect(sessionWeaponCounterBlockCount(blockHelperState, tridSession)).toBe(1);
    const swordSession = buildAttackSession({
      attackerId: "hero-02",
      source: { kind: "weapon", slotIdx: 0, cardId: "body-sword-r1" },
      damage: 2,
      hitTiles: [],
    });
    expect(sessionWeaponCounterBlockCount(blockHelperState, swordSession)).toBe(0);
  });
});

// --- weaponCounterBlockMap helper -------------------------------------

describe("weaponCounterBlockMap - Shockwave", () => {
  it("undefined choice → empty map", () => {
    const session = buildAttackSession({
      attackerId: "hero-02",
      source: { kind: "weapon", slotIdx: 0, cardId: SHOCK_BODY },
      damage: 1,
      hitTiles: [],
    });
    const map = weaponCounterBlockMap(blockHelperState, session, undefined);
    expect(map.size).toBe(0);
  });

  it("skip choice → empty map", () => {
    const session = buildAttackSession({
      attackerId: "hero-02",
      source: { kind: "weapon", slotIdx: 0, cardId: SHOCK_BODY },
      damage: 1,
      hitTiles: [],
    });
    const map = weaponCounterBlockMap(blockHelperState, session, { kind: "skip" });
    expect(map.size).toBe(0);
  });

  it("block 2 picks → both ids mapped to amount 1", () => {
    const session = buildAttackSession({
      attackerId: "hero-02",
      source: { kind: "weapon", slotIdx: 0, cardId: SHOCK_BODY },
      damage: 1,
      hitTiles: [],
    });
    const map = weaponCounterBlockMap(blockHelperState, session, {
      kind: "block",
      enemyInstanceIds: ["a", "b"],
    });
    expect(map.size).toBe(2);
    expect(map.get("a")).toBe(1);
    expect(map.get("b")).toBe(1);
  });

  it("excess picks (3 with cap=2) → first 2 applied, last dropped", () => {
    const session = buildAttackSession({
      attackerId: "hero-02",
      source: { kind: "weapon", slotIdx: 0, cardId: SHOCK_BODY },
      damage: 1,
      hitTiles: [],
    });
    const map = weaponCounterBlockMap(blockHelperState, session, {
      kind: "block",
      enemyInstanceIds: ["a", "b", "c"],
    });
    expect(map.size).toBe(2);
    expect(map.get("a")).toBe(1);
    expect(map.get("b")).toBe(1);
    expect(map.has("c")).toBe(false);
  });

  it("duplicate picks stack the reduction (defensive)", () => {
    const session = buildAttackSession({
      attackerId: "hero-02",
      source: { kind: "weapon", slotIdx: 0, cardId: SHOCK_BODY },
      damage: 1,
      hitTiles: [],
    });
    const map = weaponCounterBlockMap(blockHelperState, session, {
      kind: "block",
      enemyInstanceIds: ["a", "a"],
    });
    expect(map.size).toBe(1);
    // 2 picks of "a" within cap → 1 + 1 = 2 reduction.
    expect(map.get("a")).toBe(2);
  });

  it("non-Shockwave source (Sword) → empty map even with picks", () => {
    const session = buildAttackSession({
      attackerId: "hero-02",
      source: { kind: "weapon", slotIdx: 0, cardId: "body-sword-r1" },
      damage: 2,
      hitTiles: [],
    });
    const map = weaponCounterBlockMap(blockHelperState, session, {
      kind: "block",
      enemyInstanceIds: ["a", "b"],
    });
    expect(map.size).toBe(0);
  });
});

// --- counter-block multi-pick (count: 2) end-to-end -------------------

describe("applyCounterDamageWithShieldChoices - Shockwave count:2 multi-pick", () => {
  /**
   * Build a Shockwave swing + counter phase against TWO Soulhunters
   * placed on Body Shockwave NW + NE diagonal tiles. Both have
   * `counterCommon` offsets that land on the bearer at (2, 2) on a
   * "common" roll (2-5):
   *   - Soulhunter at (1, 1): offset (+1, +1) → (2, 2). HIT.
   *   - Soulhunter at (3, 1): offset (-1, +1) → (2, 2). HIT.
   * Each has attack=2 → bearer takes 4 total at full damage.
   * Block 2 picks → bearer takes 2 (each enemy reduced by 1).
   */
  function shockwaveSwingAtTwoSoulhunters(): {
    state: CampaignState;
    session: AttackSession;
    nwId: string;
    neId: string;
  } {
    const state = arenaWithBodyShockwave();
    const nw = placeEnemy(state, "nw-boss", 1, 1, "soulhunter-001");
    const ne = placeEnemy(state, "ne-boss", 3, 1, "soulhunter-001");
    const r = useWeaponAbility(state, "hero-02", 0, { kind: "fixed-pattern" });
    if (!r.ok) throw new Error(`useWeaponAbility failed: ${r.reason}`);
    resolveAllDamage(state, r.session);
    return { state, session: r.session, nwId: nw.instanceId, neId: ne.instanceId };
  }

  it("counterBlockCandidates lists both counterattackers", () => {
    const { state, session } = shockwaveSwingAtTwoSoulhunters();
    session.sharedCounter!.outcome = "common";
    const out = counterBlockCandidates(state, session);
    expect(out.length).toBe(2);
    for (const c of out) {
      expect(c.preBlockAttack).toBe(2);
      const hit = c.preBlockDamage.find((d) => d.heroId === "hero-02");
      expect(hit?.damage).toBe(2);
    }
  });

  it("skip → bearer takes full 4 damage (2 + 2)", () => {
    const { state, session } = shockwaveSwingAtTwoSoulhunters();
    const beforeHp = state.loadouts["hero-02"]!.currentHp;
    applyCounterDamageWithShieldChoices(state, session, 2, {}, { kind: "skip" });
    expect(state.loadouts["hero-02"]!.currentHp).toBe(beforeHp - 4);
  });

  it("block 1 of 2 (NW) → bearer takes 3 damage (1 + 2)", () => {
    const { state, session, nwId } = shockwaveSwingAtTwoSoulhunters();
    const beforeHp = state.loadouts["hero-02"]!.currentHp;
    applyCounterDamageWithShieldChoices(
      state, session, 2, {},
      { kind: "block", enemyInstanceIds: [nwId] },
    );
    expect(state.loadouts["hero-02"]!.currentHp).toBe(beforeHp - 3);
  });

  it("block 2 of 2 (NW + NE) → bearer takes 2 damage (1 + 1)", () => {
    const { state, session, nwId, neId } = shockwaveSwingAtTwoSoulhunters();
    const beforeHp = state.loadouts["hero-02"]!.currentHp;
    applyCounterDamageWithShieldChoices(
      state, session, 2, {},
      { kind: "block", enemyInstanceIds: [nwId, neId] },
    );
    expect(state.loadouts["hero-02"]!.currentHp).toBe(beforeHp - 2);
  });

  // Regression (player report 2026-07-20, Q2 W2): a Mind Shockwave R2
  // bearer counterattacked by two enemies dealing 2 each still took
  // damage. The engine read the block effect off the R1 placeholder
  // card in the slot (block 1 from 2) instead of the rank-correct R2
  // card (block 2 from 2). At R2, two attack-2 counters must be
  // blocked to ZERO.
  it("RANK 2: block 2 of 2 → bearer takes 0 damage (2 blocked from each counter)", () => {
    const { state, session, nwId, neId } = shockwaveSwingAtTwoSoulhunters();
    state.equipmentRanks["hero-02"]!.Shockwave = 2;
    const beforeHp = state.loadouts["hero-02"]!.currentHp;
    applyCounterDamageWithShieldChoices(
      state, session, 2, {},
      { kind: "block", enemyInstanceIds: [nwId, neId] },
    );
    expect(state.loadouts["hero-02"]!.currentHp).toBe(beforeHp);
  });

  it("RANK 2: session helpers report amount 2 / count 2 off the rank-correct card", () => {
    const { state, session } = shockwaveSwingAtTwoSoulhunters();
    state.equipmentRanks["hero-02"]!.Shockwave = 2;
    expect(sessionWeaponCounterBlockAmount(state, session)).toBe(2);
    expect(sessionWeaponCounterBlockCount(state, session)).toBe(2);
    const map = weaponCounterBlockMap(state, session, {
      kind: "block", enemyInstanceIds: ["a", "b"],
    });
    expect(map.get("a")).toBe(2);
    expect(map.get("b")).toBe(2);
  });

  it("RANK 3: blocks 3 per counter (attack-2 counters still floor at 0, no heal)", () => {
    const { state, session, nwId, neId } = shockwaveSwingAtTwoSoulhunters();
    state.equipmentRanks["hero-02"]!.Shockwave = 3;
    const beforeHp = state.loadouts["hero-02"]!.currentHp;
    applyCounterDamageWithShieldChoices(
      state, session, 2, {},
      { kind: "block", enemyInstanceIds: [nwId, neId] },
    );
    expect(state.loadouts["hero-02"]!.currentHp).toBe(beforeHp);
  });

  it("excess picks (3 ids with cap=2) → only first 2 reductions applied", () => {
    const { state, session, nwId, neId } = shockwaveSwingAtTwoSoulhunters();
    const beforeHp = state.loadouts["hero-02"]!.currentHp;
    // Third pick is a phantom id; even if it WERE in the counter, the
    // count cap means only the first 2 reductions are applied. Same
    // damage as the legit 2-pick case.
    applyCounterDamageWithShieldChoices(
      state, session, 2, {},
      { kind: "block", enemyInstanceIds: [nwId, neId, "ghost-id"] },
    );
    expect(state.loadouts["hero-02"]!.currentHp).toBe(beforeHp - 2);
  });

  it("multi-delver tile-mate: both delvers benefit from BOTH picks", () => {
    const { state, session, nwId, neId } = shockwaveSwingAtTwoSoulhunters();
    // Park hero-01 on the bearer's tile (2, 2) — both delvers take the
    // same incoming counter; both should see the post-block totals.
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    const beforeHp1 = state.loadouts["hero-01"]!.currentHp;
    const beforeHp2 = state.loadouts["hero-02"]!.currentHp;
    applyCounterDamageWithShieldChoices(
      state, session, 2, {},
      { kind: "block", enemyInstanceIds: [nwId, neId] },
    );
    expect(state.loadouts["hero-01"]!.currentHp).toBe(beforeHp1 - 2);
    expect(state.loadouts["hero-02"]!.currentHp).toBe(beforeHp2 - 2);
  });

  it("source isn't a Shockwave (Sword) → cap is 0 → block silently ignored", () => {
    // Build a Sword swing against one Soulhunter; pass a 2-pick block
    // anyway. Engine reads cap=0 from the Sword card and applies no
    // reduction, so full damage lands.
    const state = arenaWithBodyShockwave();
    state.loadouts["hero-02"]!.slotCards[0] = "body-sword-r1";
    state.encounter!.turnState["hero-02"]!.cardPlacedThisTurn!.cardId = "body-sword-r1";
    const sh = placeEnemy(state, "boss", 3, 2, "soulhunter-001");
    const r = useWeaponAbility(state, "hero-02", 0, {
      kind: "single-adjacent", targetX: 3, targetY: 2,
    });
    if (!r.ok) throw new Error(`useWeaponAbility failed: ${r.reason}`);
    resolveAllDamage(state, r.session);
    const beforeHp = state.loadouts["hero-02"]!.currentHp;
    applyCounterDamageWithShieldChoices(
      state, r.session, 2, {},
      { kind: "block", enemyInstanceIds: [sh.instanceId, "ghost"] },
    );
    // Soulhunter at (3, 2) common offset (-1, 0) → (2, 2), but
    // bearer is at (2, 2). attack=2 full damage lands.
    expect(state.loadouts["hero-02"]!.currentHp).toBe(beforeHp - 2);
  });
});
