/**
 * Full-catalog completeness + rank-ramp audit of `data/equipment.json`
 * (2026-07-22, "all equipment cards should be fully authored through
 * all ranks" pass).
 *
 * Two layers:
 *   1. COMPLETENESS — every (suit, type) pair has exactly R1-R5
 *     entries, each with an image file reference, ability text, and
 *     a category; weapons also carry damageType / damageMultiplier /
 *     range.
 *   2. RAMPS — the numeric scaling on rank-bearing effects matches
 *     the authored progression the engine now consumes via
 *     rank-correct lookups (Armor maxHp/heal, Boots floor, Shield
 *     blocks, OS grants, Harvester parts, Scorchline repeats,
 *     Flicker Blade combo). Damage-multiplier ramps for weapons are
 *     pinned in `combat.test.ts` (uniform mult = rank, except the
 *     card-verified Hammer/Trident offset ramp).
 *
 * If a future re-extraction / hand edit drifts, this points at the
 * exact card id.
 */

import { describe, it, expect } from "vitest";

import { EQUIPMENT } from "../data";
import { ALL_EQUIPMENT_TYPES } from "../types";
import type { EquipmentCard, EquipmentType } from "../types";

function card(suit: "mind" | "body", type: EquipmentType, rank: number): EquipmentCard {
  const e = EQUIPMENT.find((x) => x.suit === suit && x.type === type && x.rank === rank);
  expect(e, `${suit}-${type}-r${rank} missing`).toBeDefined();
  return e!;
}

function effect<K extends string>(c: EquipmentCard, kind: K) {
  const e = (c.effects ?? []).find((x) => x.kind === kind);
  expect(e, `${c.id} missing effect ${kind}`).toBeDefined();
  return e as Extract<NonNullable<EquipmentCard["effects"]>[number], { kind: K }>;
}

describe("equipment catalog completeness (14 types x 2 suits x 5 ranks)", () => {
  it("has exactly 140 entries with no duplicate (suit, type, rank)", () => {
    expect(EQUIPMENT.length).toBe(140);
    const keys = new Set(EQUIPMENT.map((e) => `${e.suit}|${e.type}|${e.rank}`));
    expect(keys.size).toBe(140);
  });

  it.each(ALL_EQUIPMENT_TYPES.flatMap((t) =>
    (["mind", "body"] as const).map((s) => [s, t] as const),
  ))("%s %s has complete R1-R5 entries", (suit, type) => {
    for (let rank = 1; rank <= 5; rank++) {
      const c = card(suit, type, rank);
      expect(c.image, `${c.id} image`).toBeTruthy();
      expect(c.abilityText, `${c.id} abilityText`).toBeTruthy();
      expect(["weapon", "passive"]).toContain(c.category);
      if (c.category === "weapon") {
        expect(c.damageType, `${c.id} damageType`).toBeTruthy();
        expect(c.damageMultiplier, `${c.id} damageMultiplier`).toBeGreaterThan(0);
        expect(c.range, `${c.id} range`).toBeTruthy();
      }
    }
  });
});

describe("rank-scaled effect ramps (consumed via rank-correct lookups)", () => {
  it.each(["mind", "body"] as const)("%s Armor: maxHp 6+3r, +3 current, heal = rank", (suit) => {
    for (let r = 1; r <= 5; r++) {
      const c = card(suit, "Armor", r);
      expect(effect(c, "set-max-hp").value, c.id).toBe(6 + 3 * r);
      expect(effect(c, "modify-current-hp").delta, c.id).toBe(3);
      expect(effect(c, "heal-at-end-of-wave").amount, c.id).toBe(r);
    }
  });

  it.each(["mind", "body"] as const)("%s Boots: movement floor = rank + 1", (suit) => {
    for (let r = 1; r <= 5; r++) {
      expect(effect(card(suit, "Boots", r), "set-base-movement").value).toBe(r + 1);
    }
  });

  it.each(["mind", "body"] as const)("%s Shield: block = rank, bonus = rank + 1, heal-per-overblock 1", (suit) => {
    for (let r = 1; r <= 5; r++) {
      const eff = effect(card(suit, "Shield", r), "block-on-tile");
      expect(eff.baseBlock, `r${r}`).toBe(r);
      expect(eff.bonusBlock, `r${r}`).toBe(r + 1);
      expect(eff.healPerOverblock, `r${r}`).toBe(1);
      expect(eff.bonusElement).toBe(suit === "mind" ? "radiance" : "void");
    }
  });

  it("mind OS (Providence): bonus XP = rank", () => {
    for (let r = 1; r <= 5; r++) {
      expect(effect(card("mind", "OS", r), "bonus-xp-on-kill").amount).toBe(r);
    }
  });

  it("body OS (Elemental): interlude element grants = rank, acquire grant = 1 at every rank", () => {
    for (let r = 1; r <= 5; r++) {
      const c = card("body", "OS", r);
      expect(effect(c, "gain-element-at-end-of-wave").amount, c.id).toBe(r);
      expect(effect(c, "gain-element-on-acquire").amount, c.id).toBe(1);
    }
  });

  it.each(["mind", "body"] as const)("%s Harvester: interlude creature parts = 2 x rank", (suit) => {
    for (let r = 1; r <= 5; r++) {
      expect(effect(card(suit, "Harvester", r), "gain-tokens-at-end-of-wave").amount).toBe(2 * r);
    }
  });

  it.each(["mind", "body"] as const)("%s Trident: counter-block = rank from 1 counterattack", (suit) => {
    for (let r = 1; r <= 5; r++) {
      const eff = effect(card(suit, "Trident", r), "weapon-counter-block");
      expect(eff.amount, `r${r}`).toBe(r);
      expect(eff.count, `r${r}`).toBe(1);
    }
  });

  it.each(["mind", "body"] as const)("%s Shockwave: counter-block = rank from 2 counterattacks", (suit) => {
    for (let r = 1; r <= 5; r++) {
      const eff = effect(card(suit, "Shockwave", r), "weapon-counter-block");
      expect(eff.amount, `r${r}`).toBe(r);
      expect(eff.count, `r${r}`).toBe(2);
    }
  });

  it("body Beam (Scorchline): repeat swings = rank - 1 at R2+, flat damage", () => {
    for (let r = 2; r <= 5; r++) {
      const c = card("body", "Beam", r);
      expect(effect(c, "repeat-attack").count, c.id).toBe(r - 1);
      expect(c.damageMultiplier, c.id).toBe(1); // volume-scaling, never 2x
    }
  });

  it("mind Sword (Flicker Blade): adjacent-combo bonus multiplier = rank", () => {
    for (let r = 1; r <= 5; r++) {
      expect(effect(card("mind", "Sword", r), "additional-damage-if-delvers-adjacent").multiplier).toBe(r);
    }
  });

  it("every Battery + Supercharger rank carries the equipment-roll effect (1 benefit per rank gained)", () => {
    for (const suit of ["mind", "body"] as const) {
      for (const type of ["Battery", "Supercharger"] as const) {
        for (let r = 1; r <= 5; r++) {
          effect(card(suit, type, r), "immediately-equipment-roll");
        }
      }
    }
  });
});
