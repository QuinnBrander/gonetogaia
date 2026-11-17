/**
 * Tests for src/engine/beamRepeat.ts and the `repeat-attack` data
 * + `freeRepeat` engine path the Scorchline Beam (Body R2-R5)
 * bonus-swing flow rides on top of.
 *
 * Covers:
 *   - `attackSessionTriggersBeamRepeat` semantics: weapon source,
 *     straight-line range, encounter still in `hero` phase, bearer
 *     alive, pending counter > 0.
 *   - `repeatAttackCountForCard` reads the rank-correct effect
 *     (R1 returns 0; R2-R5 return printed N).
 *   - `seedBeamRepeats` / `consumeOneBeamRepeat` / `clearBeamRepeats`
 *     mutate the per-hero counter as advertised.
 *   - `useWeaponAbility` integration:
 *       - First Scorchline R2+ swing seeds the bearer's counter.
 *       - A subsequent freeRepeat swing decrements the counter by 1.
 *       - Suit B Ion Cannon Beam carries no `repeat-attack` effect,
 *         so its swings DO NOT seed any counter (volume vs damage
 *         scaling distinction per audit 2026-05-24).
 *   - `effectiveDamageForCard` clamps Scorchline R2-R5 per-swing
 *     damage to rank-1 base (volume scaling), while Ion Cannon
 *     keeps the rank-N multiplier.
 *   - `startHeroTurn` resets a stale counter to 0.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { newCampaign, type CampaignState, type EnemyInstance } from "../state";
import { QUEST1, getEquipment } from "../data";
import { ensureEncounter } from "../engine/encounter";
import { startHeroTurn, useWeaponAbility, playWeaponCard } from "../engine/turn";
import {
  buildAttackSession,
  effectiveDamageForCard,
  type AttackSession,
} from "../engine/combat";
import {
  attackSessionTriggersBeamRepeat,
  clearBeamRepeats,
  consumeOneBeamRepeat,
  repeatAttackCountForCard,
  seedBeamRepeats,
} from "../engine/beamRepeat";
import { Tuning } from "../config/tuning";

/**
 * Standardised setup: encounter ready, both delvers placed at known
 * tiles, no enemies. Beam is FORCED into the body delver's loadout
 * (Scorchline = Suit A = body) by bumping `equipmentRanks.Beam` and
 * stuffing the R1 card directly into a slot — the body delver's
 * printed `startingEquipment` is gauntlet/sword/armor (no Beam by
 * default), so the player would have had to earn Beam via a
 * level-up draw to actually use Scorchline. We sidestep the draw
 * here for harness compactness.
 *
 * - hero-02 (Body) at (2, 2) — the Scorchline bearer.
 * - hero-01 (Mind) at (0, 4) — well clear of any counter pattern.
 *
 * Beam lives in slot 2 (the body delver's last slot).
 */
function arenaWithBeamBearer(): CampaignState {
  const state = newCampaign();
  state.currentDelverId = "hero-02";
  ensureEncounter(state, QUEST1);
  state.encounter!.phase = "hero";
  state.encounter!.enemies = [];
  state.encounter!.delverPositions["hero-02"] = { x: 2, y: 2 };
  state.encounter!.delverPositions["hero-01"] = { x: 0, y: 4 };
  // Grant Beam to the body delver. With rank >= 1, the card is
  // "owned" and `playWeaponCard` will accept it even though it's
  // not in `startingEquipment` (real-game equivalent: a level-up
  // draw that picked Beam).
  state.equipmentRanks["hero-02"]!.Beam = 1;
  startHeroTurn(state);
  const placed = playWeaponCard(state, "hero-02", 2, "body-beam-r1");
  if (!placed.ok) throw new Error(`setup: playWeaponCard failed: ${placed.reason}`);
  return state;
}

/**
 * Push a fresh enemy at (x, y). Crystanid 001 has 2 HP — exactly
 * Scorchline R1 / R2's MEDIUM damage value — so a single swing
 * always kills.
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
 * Build a synthetic attack session matching what `useWeaponAbility`
 * would produce for a single Scorchline straight-line swing.
 * Caller picks the cardId so we can probe both R1 (no repeat) and
 * R2+ (with repeat) trigger paths.
 */
function fakeFinalizedBeamSession(cardId: string): AttackSession {
  return buildAttackSession({
    attackerId: "hero-02",
    source: { kind: "weapon", slotIdx: 2, cardId },
    damage: Tuning.damageBase.medium,
    hitTiles: [{ x: 3, y: 2 }],
  });
}

// --- repeatAttackCountForCard ----------------------------------------

describe("repeatAttackCountForCard", () => {
  let s: CampaignState;
  beforeEach(() => { s = arenaWithBeamBearer(); });

  it("returns 0 for Scorchline R1 (no repeat-attack effect printed)", () => {
    expect(repeatAttackCountForCard(s, "hero-02", "body-beam-r1")).toBe(0);
  });

  it("returns the printed count when the bearer's effective rank matches an R2-R5 card", () => {
    s.equipmentRanks["hero-02"]!.Beam = 2;
    expect(repeatAttackCountForCard(s, "hero-02", "body-beam-r1")).toBe(1);
    s.equipmentRanks["hero-02"]!.Beam = 3;
    expect(repeatAttackCountForCard(s, "hero-02", "body-beam-r1")).toBe(2);
    s.equipmentRanks["hero-02"]!.Beam = 4;
    expect(repeatAttackCountForCard(s, "hero-02", "body-beam-r1")).toBe(3);
    s.equipmentRanks["hero-02"]!.Beam = 5;
    expect(repeatAttackCountForCard(s, "hero-02", "body-beam-r1")).toBe(4);
  });

  it("returns 0 for Ion Cannon Beam (Suit B scales by damage, no repeat-attack effect)", () => {
    // Mind-suit setup: bump Mind's Beam rank and ask for that hero's
    // count. Suit B Beam (Ion Cannon) carries no `repeat-attack`
    // effect at any rank, so we expect 0 regardless of rank.
    s.currentDelverId = "hero-01";
    for (const rank of [1, 2, 3, 4, 5]) {
      s.equipmentRanks["hero-01"]!.Beam = rank;
      expect(repeatAttackCountForCard(s, "hero-01", "mind-beam-r1")).toBe(0);
    }
  });

  it("returns 0 for a non-Beam card", () => {
    expect(repeatAttackCountForCard(s, "hero-02", "body-sword-r1")).toBe(0);
  });
});

// --- seed / consume / clear ------------------------------------------

describe("beamRepeats counter mutators", () => {
  let s: CampaignState;
  beforeEach(() => { s = arenaWithBeamBearer(); });

  it("seedBeamRepeats writes the count for the bearer", () => {
    seedBeamRepeats(s, "hero-02", 3);
    expect(s.encounter!.beamRepeatsRemaining["hero-02"]).toBe(3);
  });

  it("seedBeamRepeats with count <= 0 is a no-op (defensive)", () => {
    seedBeamRepeats(s, "hero-02", 0);
    expect(s.encounter!.beamRepeatsRemaining["hero-02"] ?? 0).toBe(0);
    seedBeamRepeats(s, "hero-02", -2);
    expect(s.encounter!.beamRepeatsRemaining["hero-02"] ?? 0).toBe(0);
  });

  it("consumeOneBeamRepeat decrements the counter, flooring at 0", () => {
    seedBeamRepeats(s, "hero-02", 2);
    consumeOneBeamRepeat(s, "hero-02");
    expect(s.encounter!.beamRepeatsRemaining["hero-02"]).toBe(1);
    consumeOneBeamRepeat(s, "hero-02");
    expect(s.encounter!.beamRepeatsRemaining["hero-02"]).toBe(0);
    consumeOneBeamRepeat(s, "hero-02");
    expect(s.encounter!.beamRepeatsRemaining["hero-02"]).toBe(0);
  });

  it("clearBeamRepeats resets the counter to 0", () => {
    seedBeamRepeats(s, "hero-02", 4);
    clearBeamRepeats(s, "hero-02");
    expect(s.encounter!.beamRepeatsRemaining["hero-02"]).toBe(0);
  });
});

// --- attackSessionTriggersBeamRepeat ---------------------------------

describe("attackSessionTriggersBeamRepeat", () => {
  let s: CampaignState;
  beforeEach(() => { s = arenaWithBeamBearer(); });

  it("true when bearer has pending repeats AND session source is a straight-line weapon AND phase=hero AND bearer alive", () => {
    seedBeamRepeats(s, "hero-02", 1);
    const session = fakeFinalizedBeamSession("body-beam-r1");
    expect(attackSessionTriggersBeamRepeat(s, session)).toBe(true);
  });

  it("false when remaining counter is 0", () => {
    const session = fakeFinalizedBeamSession("body-beam-r1");
    expect(attackSessionTriggersBeamRepeat(s, session)).toBe(false);
  });

  it("false when the source is a slot ability rather than a weapon", () => {
    seedBeamRepeats(s, "hero-02", 1);
    const session = buildAttackSession({
      attackerId: "hero-02",
      source: { kind: "slot", slotIdx: 0, element: "earth" },
      damage: 1,
      hitTiles: [{ x: 3, y: 2 }],
    });
    expect(attackSessionTriggersBeamRepeat(s, session)).toBe(false);
  });

  it("false when the weapon is not straight-line (e.g. Sword's single-adjacent)", () => {
    seedBeamRepeats(s, "hero-02", 1);
    const session = buildAttackSession({
      attackerId: "hero-02",
      source: { kind: "weapon", slotIdx: 0, cardId: "body-sword-r1" },
      damage: 1,
      hitTiles: [{ x: 3, y: 2 }],
    });
    expect(attackSessionTriggersBeamRepeat(s, session)).toBe(false);
  });

  it("false when encounter has flipped to end-of-wave", () => {
    seedBeamRepeats(s, "hero-02", 1);
    s.encounter!.phase = "end-of-wave";
    const session = fakeFinalizedBeamSession("body-beam-r1");
    expect(attackSessionTriggersBeamRepeat(s, session)).toBe(false);
  });

  it("false when bearer has 0 HP (counter killed them)", () => {
    seedBeamRepeats(s, "hero-02", 1);
    s.loadouts["hero-02"]!.currentHp = 0;
    const session = fakeFinalizedBeamSession("body-beam-r1");
    expect(attackSessionTriggersBeamRepeat(s, session)).toBe(false);
  });

  it("false when there is no encounter at all", () => {
    const session = fakeFinalizedBeamSession("body-beam-r1");
    s.encounter = null;
    expect(attackSessionTriggersBeamRepeat(s, session)).toBe(false);
  });
});

// --- useWeaponAbility integration ------------------------------------

describe("useWeaponAbility seeds + consumes beamRepeatsRemaining", () => {
  let s: CampaignState;
  beforeEach(() => {
    s = arenaWithBeamBearer();
    // R2 Scorchline = 1 repeat. Place a target enemy along a
    // straight line so the swing actually hits.
    s.equipmentRanks["hero-02"]!.Beam = 2;
    placeEnemy(s, "victim", 4, 2); // east of bearer at (2,2)
  });

  it("first Scorchline R2 swing seeds the bearer's counter to 1", () => {
    expect(s.encounter!.beamRepeatsRemaining["hero-02"] ?? 0).toBe(0);
    const r = useWeaponAbility(
      s, "hero-02", 2,
      { kind: "straight-line", targetX: 4, targetY: 2 },
    );
    expect(r.ok).toBe(true);
    expect(s.encounter!.beamRepeatsRemaining["hero-02"]).toBe(1);
  });

  it("a subsequent freeRepeat swing decrements the counter by 1", () => {
    // Bump rank to 3 so both first + freeRepeat have a count > 0
    // afterwards (saves us writing a second target-respawn dance).
    s.equipmentRanks["hero-02"]!.Beam = 3;
    placeEnemy(s, "victim2", 2, 4); // south of bearer (different ray)

    const first = useWeaponAbility(
      s, "hero-02", 2,
      { kind: "straight-line", targetX: 4, targetY: 2 },
    );
    expect(first.ok).toBe(true);
    expect(s.encounter!.beamRepeatsRemaining["hero-02"]).toBe(2);

    const second = useWeaponAbility(
      s, "hero-02", 2,
      { kind: "straight-line", targetX: 2, targetY: 4 },
      { freeRepeat: true },
    );
    expect(second.ok).toBe(true);
    expect(s.encounter!.beamRepeatsRemaining["hero-02"]).toBe(1);
  });

  it("Ion Cannon Beam (Suit B) does NOT seed a repeat counter — it scales by damage instead", () => {
    // Reset to mind-suit bearer for this case. Mind's
    // startingEquipment includes mind-beam-r1, so we can use the
    // standard placement primitive (no slotCards stuffing needed).
    s = arenaWithBeamBearer();
    s.currentDelverId = "hero-01";
    s.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    s.encounter!.delverPositions["hero-02"] = { x: 0, y: 0 };
    s.equipmentRanks["hero-01"]!.Beam = 5; // any rank, no repeat-attack on Suit B
    startHeroTurn(s);
    const placed = playWeaponCard(s, "hero-01", 1, "mind-beam-r1");
    expect(placed.ok).toBe(true);
    placeEnemy(s, "victim", 4, 2);

    const r = useWeaponAbility(
      s, "hero-01", 1,
      { kind: "straight-line", targetX: 4, targetY: 2 },
    );
    expect(r.ok).toBe(true);
    // Counter never seeded — Ion Cannon's effects array doesn't
    // carry `repeat-attack` so the seed-or-skip branch in
    // `useWeaponAbility` is a no-op.
    expect(s.encounter!.beamRepeatsRemaining["hero-01"] ?? 0).toBe(0);
  });
});

// --- damage clamp ----------------------------------------------------

describe("effectiveDamageForCard volume-scaling clamp (Scorchline)", () => {
  let s: CampaignState;
  beforeEach(() => { s = arenaWithBeamBearer(); });

  it("Scorchline R1: rank-1 baseline = MEDIUM (no clamp)", () => {
    s.equipmentRanks["hero-02"]!.Beam = 1;
    const card = getEquipment("body-beam-r1");
    expect(effectiveDamageForCard(s, "hero-02", card)).toBe(Tuning.damageBase.medium);
  });

  it("Scorchline R2-R5: each swing clamped to rank-1 MEDIUM (volume scaling, not damage)", () => {
    const card = getEquipment("body-beam-r1");
    for (const rank of [2, 3, 4, 5]) {
      s.equipmentRanks["hero-02"]!.Beam = rank;
      expect(effectiveDamageForCard(s, "hero-02", card)).toBe(Tuning.damageBase.medium);
    }
  });

  it("Ion Cannon Beam (Suit B): per-swing damage scales with rank (damage scaling, not volume)", () => {
    // Switch active delver to mind suit so the rank lookup hits
    // hero-01's Beam slot. Card we pass is the Suit-B R1 card —
    // `effectiveDamageForCard` resolves the rank-correct lookup
    // internally for the volume-scaling check.
    s.currentDelverId = "hero-01";
    const card = getEquipment("mind-beam-r1");
    for (const rank of [1, 2, 3, 4, 5]) {
      s.equipmentRanks["hero-01"]!.Beam = rank;
      expect(effectiveDamageForCard(s, "hero-01", card)).toBe(rank * Tuning.damageBase.medium);
    }
  });
});

// --- startHeroTurn reset ---------------------------------------------

describe("startHeroTurn clears stale beamRepeatsRemaining", () => {
  it("resets the active delver's counter to 0 even if a prior turn left it dangling", () => {
    const s = arenaWithBeamBearer();
    seedBeamRepeats(s, "hero-02", 4);
    startHeroTurn(s);
    expect(s.encounter!.beamRepeatsRemaining["hero-02"]).toBe(0);
  });

  it("self-heals an old save that lacks the field entirely", () => {
    const s = arenaWithBeamBearer();
    // Simulate an old-save shape: drop the field altogether.
    delete (s.encounter as { beamRepeatsRemaining?: unknown }).beamRepeatsRemaining;
    startHeroTurn(s);
    expect(s.encounter!.beamRepeatsRemaining).toBeDefined();
    expect(s.encounter!.beamRepeatsRemaining["hero-02"]).toBe(0);
  });
});
