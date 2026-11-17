/**
 * Machinist Equipment Upgrade deck (printed cards #141-155, scans in
 * `public/equipment-upgrades/`) — data audit + variant mechanics.
 *
 * Three families of five ranks REPLACE a standard equipment family
 * for the quest (2026-07-22; previously approximated as a +2 rank
 * bump of the standard card, whose printed abilities differ):
 *
 *   - Shock Gauntlet  (#141-145, weapon → Gauntlet): rx LIGHT chain
 *     damage anchored on the bearer; +rx MEDIUM to the chain when
 *     the bearer is at or below 50% HP. No creature-part collection.
 *   - Cyclone Boots   (#146-150, passive → Boots): movement floor
 *     r+1; ONGOING costs 1 movement (standard: 2) and can MOVE or
 *     ROTATE regardless of suit.
 *   - Earth's Embrace Shield (#151-155, passive → Shield): spend 1
 *     element → a hero on the tile suffers r+1 less damage; heal
 *     r+1 HP when the spent element is Earth. No overblock heal.
 */

import { describe, it, expect } from "vitest";

import { newCampaign, getEquipmentCardFor, type CampaignState } from "../state";
import { QUEST1, UPGRADE_EQUIPMENT, getUpgradeEquipment, upgradeFamilyForProduct } from "../data";
import { ensureEncounter } from "../engine/encounter";
import { startHeroTurn, playWeaponCard, useWeaponAbility } from "../engine/turn";
import { bootsOngoingCost, bootsModes, canActivateBootsOngoing, rotateAdjacentEnemy } from "../engine/boots";
import type { EnemyInstance } from "../state";

const noShuffle = (pool: readonly string[]) => [...pool];

function arena(): CampaignState {
  const s = newCampaign();
  ensureEncounter(s, QUEST1, noShuffle);
  s.encounter!.enemies = [];
  s.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
  s.encounter!.delverPositions["hero-02"] = { x: 4, y: 4 };
  startHeroTurn(s);
  return s;
}

function spawn(s: CampaignState, x: number, y: number): EnemyInstance {
  const e: EnemyInstance = {
    instanceId: `e-${x}-${y}`, cardId: "crystanid-001", x, y,
    damageTaken: 0, alive: true, facing: 0,
  };
  s.encounter!.enemies.push(e);
  return e;
}

// --- Data audit -------------------------------------------------------------

describe("equipment upgrade deck data (cards 141-155)", () => {
  it("ships 70 printed cards (14 families) expanded to 140 suit entries, families mapped to products", () => {
    expect(UPGRADE_EQUIPMENT.length).toBe(140);
    expect(upgradeFamilyForProduct(41)).toBe("shock-gauntlet");
    expect(upgradeFamilyForProduct(34)).toBe("cyclone-boots");
    expect(upgradeFamilyForProduct(32)).toBe("earths-embrace-shield");
    expect(upgradeFamilyForProduct(3)).toBeNull();
  });

  it.each(["mind", "body"] as const)("%s Shock Gauntlet: rx LIGHT chain + rx MEDIUM low-HP bonus", (suit) => {
    for (let r = 1; r <= 5; r++) {
      const c = getUpgradeEquipment("shock-gauntlet", suit, r)!;
      expect(c.type).toBe("Gauntlet");
      expect(c.damageType).toBe("light");
      expect(c.damageMultiplier).toBe(r);
      expect(c.range).toEqual({ kind: "chain", requiresAdjacentTo: "self" });
      const low = (c.effects ?? []).find((e) => e.kind === "additional-damage-if-low-hp");
      expect(low).toEqual({ kind: "additional-damage-if-low-hp", damageType: "medium", multiplier: r, thresholdPercent: 50 });
      // The upgrade REPLACES the collect-creature-part clause.
      expect((c.effects ?? []).some((e) => e.kind === "collect-creature-part")).toBe(false);
    }
  });

  it.each(["mind", "body"] as const)("%s Cyclone Boots: floor r+1, ONGOING cost 1, both modes", (suit) => {
    for (let r = 1; r <= 5; r++) {
      const c = getUpgradeEquipment("cyclone-boots", suit, r)!;
      expect(c.type).toBe("Boots");
      const floor = (c.effects ?? []).find((e) => e.kind === "set-base-movement");
      expect(floor).toEqual({ kind: "set-base-movement", value: r + 1 });
      const ongoing = (c.effects ?? []).find((e) => e.kind === "boots-ongoing-override");
      expect(ongoing).toEqual({ kind: "boots-ongoing-override", cost: 1, canMove: true, canRotate: true });
    }
  });

  it.each(["mind", "body"] as const)("%s Earth's Embrace Shield: block r+1, heal r+1 on Earth spend, no overblock heal", (suit) => {
    for (let r = 1; r <= 5; r++) {
      const c = getUpgradeEquipment("earths-embrace-shield", suit, r)!;
      expect(c.type).toBe("Shield");
      const eff = (c.effects ?? []).find((e) => e.kind === "block-on-tile");
      expect(eff).toEqual({
        kind: "block-on-tile", baseBlock: r + 1, bonusElement: "earth", bonusBlock: r + 1,
        healPerOverblock: 0, healOnBonusElementSpend: r + 1,
      });
    }
  });
});

// --- Variant resolution ------------------------------------------------------

describe("getEquipmentCardFor — variant-aware resolution", () => {
  it("returns the standard card without a variant, the upgrade card with one", () => {
    const s = newCampaign();
    expect(getEquipmentCardFor(s, "hero-02", "Boots", 2).id).toBe("body-boots-r2");
    s.equipmentVariants["hero-02"]!.Boots = "cyclone-boots";
    expect(getEquipmentCardFor(s, "hero-02", "Boots", 2).id).toBe("body-upgrade-cyclone-boots-r2");
  });

  it("falls back to the standard card for an unknown family (data gap)", () => {
    const s = newCampaign();
    s.equipmentVariants["hero-02"]!.Boots = "no-such-family";
    expect(getEquipmentCardFor(s, "hero-02", "Boots", 1).id).toBe("body-boots-r1");
  });
});

// --- Shock Gauntlet low-HP bonus ----------------------------------------------

describe("Shock Gauntlet — low-HP bonus damage", () => {
  function shockSwing(hpFraction: number): number {
    const s = arena();
    s.equipmentRanks["hero-01"]!.Gauntlet = 1;
    s.equipmentVariants["hero-01"]!.Gauntlet = "shock-gauntlet";
    const lo = s.loadouts["hero-01"]!;
    lo.currentHp = Math.floor(lo.maxHp * hpFraction);
    spawn(s, 2, 1); // adjacent to hero-01 at (2,2)
    const placed = playWeaponCard(s, "hero-01", 0, "mind-gauntlet-r1");
    expect(placed.ok).toBe(true);
    const r = useWeaponAbility(s, "hero-01", 0, { kind: "chain", targetX: 2, targetY: 1 });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) throw new Error("swing failed");
    return r.session.damage;
  }

  it("above 50% HP: plain rx LIGHT (1 at R1)", () => {
    expect(shockSwing(1.0)).toBe(1);
  });

  it("at or below 50% HP: +rx MEDIUM (1 + 2 = 3 at R1)", () => {
    expect(shockSwing(0.5)).toBe(3);
  });
});

// --- Cyclone Boots ONGOING ------------------------------------------------------

describe("Cyclone Boots — 1-movement move-or-rotate for either suit", () => {
  it("costs 1 movement and unlocks BOTH modes (mind delver can MOVE, body could rotate)", () => {
    const s = arena();
    s.equipmentRanks["hero-01"]!.Boots = 1;
    s.equipmentVariants["hero-01"]!.Boots = "cyclone-boots";
    expect(bootsOngoingCost(s, "hero-01")).toBe(1);
    expect(bootsModes(s, "hero-01")).toEqual({ canMove: true, canRotate: true });
  });

  it("standard boots keep cost 2 and the suit-split modes", () => {
    const s = arena();
    s.equipmentRanks["hero-01"]!.Boots = 1;
    expect(bootsOngoingCost(s, "hero-01")).toBe(2);
    expect(bootsModes(s, "hero-01")).toEqual({ canMove: false, canRotate: true }); // mind = rotate
    expect(bootsModes(s, "hero-02")).toEqual({ canMove: true, canRotate: false }); // body = move
  });

  it("a MIND bearer with Cyclone Boots can rotate for 1 movement after placing", () => {
    const s = arena();
    s.equipmentRanks["hero-01"]!.Boots = 1;
    s.equipmentVariants["hero-01"]!.Boots = "cyclone-boots";
    const lo = s.loadouts["hero-01"]!;
    lo.currentMovement = 1; // enough for Cyclone (1), not standard (2)
    spawn(s, 2, 1);
    expect(playWeaponCard(s, "hero-01", 0, "mind-hammer-r1").ok).toBe(true);
    expect(canActivateBootsOngoing(s, "hero-01").ok).toBe(true);
    const r = rotateAdjacentEnemy(s, "hero-01", "e-2-1", 90);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(lo.currentMovement).toBe(0); // spent 1, not 2
  });
});
