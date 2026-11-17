/**
 * Nov 15 Machinist passive upgrades: Living Armor (#33), Ion Battery (#35),
 * New Harvester (#36), Ancient OS (#37), Overcharger (#38).
 */
import { describe, it, expect } from "vitest";

import { newCampaign, type CampaignState } from "../state";
import { QUEST3, getShopProduct, upgradeFamilyForProduct } from "../data";
import type { EquipmentType } from "../types";
import { ensureEncounter } from "../engine/encounter";
import { enterEndOfWave } from "../engine/wave";
import { applyPendingLevelUps, xpBonusFromPassives } from "../engine/kills";
import { applyEquipmentRoll, equipmentRollTableForCard } from "../engine/tokens";
import { overcharge } from "../engine/overcharger";

function withUpgrade(family: string, type: EquipmentType, rank: number, heroId = "hero-01"): CampaignState {
  const s = newCampaign();
  s.equipmentVariants[heroId] = { ...(s.equipmentVariants[heroId] ?? {}), [type]: family };
  s.equipmentRanks[heroId] = { ...(s.equipmentRanks[heroId] ?? {}), [type]: rank };
  return s;
}

function startQuest(s: CampaignState): void {
  s.currentQuestId = "quest3";
  ensureEncounter(s, QUEST3);
}

describe("product wiring", () => {
  it("#33/#35-#38 swap in their upgrade family", () => {
    expect([33, 35, 36, 37, 38].map(upgradeFamilyForProduct)).toEqual(
      ["living-armor", "ion-battery", "new-harvester", "ancient-os", "overcharger"]);
    for (const n of [33, 35, 36, 37, 38]) {
      expect(getShopProduct(n).grants[0]).toMatchObject({ kind: "equipment-upgrade" });
    }
  });
});

describe("New Harvester", () => {
  it("gains a boss part of its rank's level at the end of each wave", () => {
    const s = withUpgrade("new-harvester", "Harvester", 3);
    startQuest(s);
    enterEndOfWave(s, "victory");
    expect(s.bossPartsLvl3["hero-01"]).toBe(1);
    expect(s.minionParts["hero-01"]).toBe(0);
  });
});

describe("Ancient OS", () => {
  it("adds its rank in XP to XP-granting enemies", () => {
    const s = withUpgrade("ancient-os", "OS", 2);
    expect(xpBonusFromPassives(s, 1)).toBe(2);
    expect(xpBonusFromPassives(s, 0)).toBe(0);
  });
});

describe("Living Armor", () => {
  it("earning a Level card heals the delvers on the bearer's tile", () => {
    const s = withUpgrade("living-armor", "Armor", 2);
    startQuest(s);
    const enc = s.encounter!;
    enc.delverPositions = { "hero-01": { x: 1, y: 1 }, "hero-02": { x: 1, y: 1 } };
    s.loadouts["hero-01"]!.currentHp = 1;
    s.loadouts["hero-02"]!.currentHp = 1;
    s.xpOnHand = 1000;
    const levels = applyPendingLevelUps(s);
    expect(levels).toBeGreaterThan(0);
    expect(s.loadouts["hero-02"]!.currentHp).toBe(Math.min(s.loadouts["hero-02"]!.maxHp, 1 + 2 * levels));
  });
});

describe("Ion Battery / Overcharger choices", () => {
  it("Ion Battery: a choose-1 prompt at quest start, one per rank", () => {
    const s = withUpgrade("ion-battery", "Battery", 2, "hero-01");
    startQuest(s);
    const rolls = s.encounter!.pendingEquipmentRolls.filter((r) => r.heroId === "hero-01");
    expect(rolls.map((r) => r.cardId)).toEqual(["mind-upgrade-ion-battery-r1", "mind-upgrade-ion-battery-r1"]);
    const table = equipmentRollTableForCard("mind-upgrade-ion-battery-r1")!;
    expect(table.pickOnly).toBe(true);
    const ap = s.loadouts["hero-01"]!.baseAp;
    applyEquipmentRoll(s, "hero-01", table.outcomes[1]!);
    expect(s.loadouts["hero-01"]!.baseAp).toBe(ap + 1);
    expect(s.consumableTokens["hero-01"]!.reroll?.available).toBe(2);
  });

  it("Overcharger: choose 2x tokens, then spend 2 Water to raise a base damage for the quest", () => {
    const s = withUpgrade("overcharger", "Supercharger", 1, "hero-02");
    startQuest(s);
    expect(s.encounter!.pendingEquipmentRolls.some((r) => r.cardId === "body-upgrade-overcharger-r1")).toBe(true);
    s.elements["hero-02"] = { water: 3 };
    expect(overcharge(s, "hero-02", "heavy")).toEqual({ ok: true });
    expect(s.elements["hero-02"]!.water).toBe(1);
    expect(s.shopDamageBonus["hero-02"]!.heavy).toBe(4); // HEAVY 4 -> 8
    s.elements["hero-02"] = { water: 4 };
    expect(overcharge(s, "hero-02", "heavy").ok).toBe(false); // already increased
    expect(overcharge(s, "hero-02", "light")).toEqual({ ok: true });
    expect(s.shopDamageBonus["hero-02"]!.light).toBe(1); // LIGHT 1 -> 2
    s.elements["hero-02"] = { water: 1 };
    expect(overcharge(s, "hero-02", "heavy").ok).toBe(false);
    expect(overcharge(s, "hero-01", "light").ok).toBe(false);
  });
});
