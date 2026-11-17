/**
 * Nov 15 Machinist weapon upgrades (engine): Engulfing Beam (#39),
 * Precise Shockwave (#40), Fabled Hammer (#42), Sword of Ruin (#43),
 * War Mace (#44), Lunar Trident (#45).
 */
import { describe, it, expect } from "vitest";

import { newCampaign, type CampaignState, type EnemyInstance } from "../state";
import { QUEST1 } from "../data";
import type { EquipmentType } from "../types";
import { ensureEncounter } from "../engine/encounter";
import { startHeroTurn, playWeaponCard, useWeaponAbility, type WeaponAbilityParams, type UseWeaponAbilityOptions } from "../engine/turn";
import { finalizeAttackSession, resolveAllDamage, resolveSharedCounter } from "../engine/combat";

function arena(family: string, type: EquipmentType, rank = 1): CampaignState {
  const s = newCampaign();
  ensureEncounter(s, QUEST1, (pool) => [...pool]);
  s.encounter!.enemies = [];
  s.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
  s.encounter!.delverPositions["hero-02"] = { x: 4, y: 4 };
  s.equipmentRanks["hero-01"]![type] = rank;
  s.equipmentVariants["hero-01"]![type] = family;
  startHeroTurn(s);
  return s;
}

function spawn(s: CampaignState, x: number, y: number, cardId = "tidegazer-048"): EnemyInstance {
  const e: EnemyInstance = { instanceId: `e-${x}-${y}`, cardId, x, y, damageTaken: 0, alive: true, facing: 0 };
  s.encounter!.enemies.push(e);
  return e;
}

function swing(s: CampaignState, type: string, params: WeaponAbilityParams, options: UseWeaponAbilityOptions = {}) {
  const placed = playWeaponCard(s, "hero-01", 0, `mind-${type}-r1`);
  expect(placed.ok, JSON.stringify(placed)).toBe(true);
  const r = useWeaponAbility(s, "hero-01", 0, params, options);
  expect(r.ok, JSON.stringify(r)).toBe(true);
  if (!r.ok) throw new Error(r.reason);
  return r.session;
}

describe("War Mace", () => {
  it("HEAVY on a boss; LIGHT + 1 element choice on a minion", () => {
    const s = arena("war-mace", "Mace", 2);
    spawn(s, 2, 1, "soulhunter-001");
    s.encounter!.enemies[0]!.instanceId = "boss";
    expect(swing(s, "mace", { kind: "single-adjacent", targetX: 2, targetY: 1 }).damage).toBe(8);
    const t = arena("war-mace", "Mace", 2);
    spawn(t, 2, 1);
    const sess = swing(t, "mace", { kind: "single-adjacent", targetX: 2, targetY: 1 });
    expect(sess.damage).toBe(2);
    expect(sess.damageType).toBe("light");
    expect(t.encounter!.pendingElementChoices.map((c) => c.heroId)).toEqual(["hero-01"]);
  });
});

describe("War Mace targeting", () => {
  it("has no UNDAMAGED filter: hits an already-damaged enemy", () => {
    const s = arena("war-mace", "Mace", 1);
    spawn(s, 2, 1).damageTaken = 1;
    expect(swing(s, "mace", { kind: "single-adjacent", targetX: 2, targetY: 1 }).damage).toBe(1);
  });
});

describe("Sword of Ruin", () => {
  it("Spend 2 Wind: additional HEAVY; a kill gains 1 Wind", () => {
    const s = arena("sword-of-ruin", "Sword", 1);
    spawn(s, 2, 1, "crystanid-002"); // 2 HP, gains XP (not elements) on death
    s.elements["hero-01"] = { wind: 2 };
    const sess = swing(s, "sword", { kind: "single-adjacent", targetX: 2, targetY: 1 }, { spends: ["spend-element-bonus-damage"] });
    expect(sess.damage).toBe(2 + 4);
    expect(s.elements["hero-01"]!.wind).toBe(0);
    resolveAllDamage(s, sess);
    resolveSharedCounter(s, sess, -1);
    finalizeAttackSession(s, sess);
    expect(s.elements["hero-01"]!.wind).toBe(1);
  });

  it("rejects a spend the bearer can't afford", () => {
    const s = arena("sword-of-ruin", "Sword", 1);
    spawn(s, 2, 1);
    playWeaponCard(s, "hero-01", 0, "mind-sword-r1");
    const r = useWeaponAbility(s, "hero-01", 0, { kind: "single-adjacent", targetX: 2, targetY: 1 }, { spends: ["spend-element-bonus-damage"] });
    expect(r.ok).toBe(false);
  });
});

describe("Lunar Trident", () => {
  it("single adjacent MEDIUM; Spend 2 Void multiplies by the rolled die", () => {
    const s = arena("lunar-trident", "Trident", 3);
    spawn(s, 3, 2);
    s.elements["hero-01"] = { void: 2 };
    const sess = swing(s, "trident", { kind: "single-adjacent", targetX: 3, targetY: 2 },
      { spends: ["spend-element-die-multiplier"], dieMultiplierRoll: 4 });
    expect(sess.damage).toBe(3 * 2 * 4);
  });
});

describe("Fabled Hammer", () => {
  it("hits every enemy strictly between the delvers in a straight line", () => {
    const s = arena("fabled-hammer", "Hammer", 1);
    s.encounter!.delverPositions["hero-02"] = { x: 2, y: 4 };
    spawn(s, 2, 3);
    spawn(s, 1, 1);
    const sess = swing(s, "hammer", { kind: "between-delvers" });
    expect(sess.hitTiles).toEqual([{ x: 2, y: 3 }]);
    expect(sess.damage).toBe(4);
  });

  it("refuses when the delvers aren't in a straight line", () => {
    const s = arena("fabled-hammer", "Hammer", 1);
    s.encounter!.delverPositions["hero-02"] = { x: 3, y: 4 };
    spawn(s, 2, 3);
    playWeaponCard(s, "hero-01", 0, "mind-hammer-r1");
    expect(useWeaponAbility(s, "hero-01", 0, { kind: "between-delvers" }).ok).toBe(false);
  });
});

describe("Precise Shockwave", () => {
  it("LIGHT on chosen targets within 2 tiles; Spend 1 Radiance adds HEAVY on 1 adjacent", () => {
    const s = arena("precise-shockwave", "Shockwave", 1);
    spawn(s, 0, 0);
    spawn(s, 3, 3);
    s.elements["hero-01"] = { radiance: 1 };
    const sess = swing(s, "shockwave", { kind: "choose-targets", targets: [{ x: 0, y: 0 }, { x: 3, y: 3 }] },
      { spends: ["spend-element-extra-adjacent-damage"], extraTarget: { x: 3, y: 3 } });
    expect(sess.hitTiles).toEqual([{ x: 0, y: 0 }, { x: 3, y: 3 }, { x: 3, y: 3, damage: 4, damageType: "heavy" }]);
    resolveAllDamage(s, sess);
    expect(s.encounter!.enemies[1]!.damageTaken).toBe(5);
  });

  it("rejects a target more than 2 tiles away", () => {
    const s = arena("precise-shockwave", "Shockwave", 1);
    spawn(s, 2, 0);
    spawn(s, 0, 4);
    playWeaponCard(s, "hero-01", 0, "mind-shockwave-r1");
    expect(useWeaponAbility(s, "hero-01", 0, { kind: "choose-targets", targets: [{ x: 0, y: 4 }] }).ok).toBe(true);
    const t = arena("precise-shockwave", "Shockwave", 1);
    t.encounter!.delverPositions["hero-01"] = { x: 0, y: 0 };
    spawn(t, 3, 3);
    playWeaponCard(t, "hero-01", 0, "mind-shockwave-r1");
    expect(useWeaponAbility(t, "hero-01", 0, { kind: "choose-targets", targets: [{ x: 3, y: 3 }] }).ok).toBe(false);
  });
});

describe("Engulfing Beam", () => {
  it("MEDIUM to every target in the line; Fire spends add LIGHT to all enemies and block counters", () => {
    const s = arena("engulfing-beam", "Beam", 1);
    spawn(s, 2, 1);
    spawn(s, 2, 0);
    spawn(s, 4, 0);
    s.elements["hero-01"] = { fire: 2 };
    const sess = swing(s, "beam", { kind: "straight-line", targetX: 2, targetY: 1 },
      { spends: ["spend-element-damage-all-enemies", "spend-element-block-counterattacks"] });
    expect(s.elements["hero-01"]!.fire).toBe(0);
    const phase = resolveAllDamage(s, sess);
    const [a, b, c] = s.encounter!.enemies;
    expect([a!.damageTaken, b!.damageTaken, c!.damageTaken]).toEqual([3, 3, 1]);
    expect(phase.damagedEnemies).toEqual([]);
    expect(phase.anyCanLand).toBe(false);
  });
});
