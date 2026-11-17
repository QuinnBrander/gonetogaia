/**
 * Tests for the quest-start Hero Pick flow:
 *
 *   - `engine/heroPick.ts > populatePendingHeroPicks` queues only
 *     delvers with 2+ unlocked cards in their suit, and is idempotent
 *     via `state.heroPicksAppliedQuests`.
 *   - `engine/heroPick.ts > commitHeroPick` validates FIFO order,
 *     locked-card rejection, and suit-mismatch rejection — and
 *     re-seeds equipment ranks + loadout from the picked card's
 *     `HERO_CARD_LOADOUTS` entry.
 *   - `data.ts > HERO_CARD_LOADOUTS` table integrity: every card
 *     #1-#6 has an entry, every equipment id in those entries
 *     resolves via `getEquipment`, and the `startingRanks` keys
 *     match the equipment cards.
 *   - `state.ts > newEquipmentRanksForActiveCard` mirrors the
 *     picked card's ranks; `reseedDelverFromActiveHeroCard`
 *     replays IMMEDIATELY passive effects for the picked card.
 *   - End-to-end: picking card #5 (Mind, TRIDENT r2 + MACE r1
 *     only) leaves the Mind delver WITHOUT Shield/Boots/etc.
 *
 * Added 2026-05-20 alongside the per-card gameplay differentiation
 * patch (HERO_CARD_LOADOUTS + reseedDelverFromActiveHeroCard).
 */

import { describe, it, expect } from "vitest";

import {
  newCampaign,
  newEquipmentRanksForActiveCard,
  reseedDelverFromActiveHeroCard,
  type CampaignState,
} from "../state";
import {
  HERO_CARD_LOADOUTS,
  HERO_CARDS,
  getEquipment,
  getActiveHeroCardNumber,
  getActiveHeroCardStartingEquipment,
  getActiveHeroCardStartingRanks,
} from "../data";
import {
  populatePendingHeroPicks,
  commitHeroPick,
  ownedHeroCardNumbersForSuit,
  HERO_PICK_ORDER,
} from "../engine/heroPick";
import type { EquipmentType } from "../types";

// ---------------------------------------------------------------------------
// HERO_CARD_LOADOUTS table integrity
// ---------------------------------------------------------------------------

describe("HERO_CARD_LOADOUTS — table integrity", () => {
  it("has an entry for every printed hero card #1-#6", () => {
    for (const card of HERO_CARDS) {
      const loadout = HERO_CARD_LOADOUTS[card.number];
      expect(loadout, `card #${card.number}`).toBeDefined();
    }
  });

  it("every starting equipment id resolves via getEquipment", () => {
    for (const [num, loadout] of Object.entries(HERO_CARD_LOADOUTS)) {
      for (const id of loadout.startingEquipmentIds) {
        expect(() => getEquipment(id), `card #${num} id=${id}`).not.toThrow();
      }
    }
  });

  it("every startingRanks key matches an equipment id of the loadout", () => {
    for (const [num, loadout] of Object.entries(HERO_CARD_LOADOUTS)) {
      const cardTypes = new Set(
        loadout.startingEquipmentIds.map((id) => getEquipment(id).type as string),
      );
      for (const type of Object.keys(loadout.startingRanks)) {
        expect(
          cardTypes.has(type),
          `card #${num} ranks key "${type}" must appear in startingEquipmentIds`,
        ).toBe(true);
      }
    }
  });

  it("card #1 mirrors legacy hero-01 starter (Beam/Hammer/Shield r1) — backward compat", () => {
    const ranks = HERO_CARD_LOADOUTS[1]!.startingRanks;
    expect(ranks).toEqual({ Beam: 1, Hammer: 1, Shield: 1 });
  });

  it("card #2 mirrors legacy hero-02 starter (Gauntlet/Sword/Armor r1) — backward compat", () => {
    const ranks = HERO_CARD_LOADOUTS[2]!.startingRanks;
    expect(ranks).toEqual({ Gauntlet: 1, Sword: 1, Armor: 1 });
  });

  it("card #5 is the print-faithful 2-weapon loadout: Trident r2 + Mace r1", () => {
    expect(HERO_CARD_LOADOUTS[5]).toEqual({
      startingEquipmentIds: ["mind-trident-r1", "mind-mace-r1"],
      startingRanks: { Trident: 2, Mace: 1 },
    });
  });

  it("card #6 is the print-faithful 2-weapon loadout: Shockwave r2 + Beam r1", () => {
    expect(HERO_CARD_LOADOUTS[6]).toEqual({
      startingEquipmentIds: ["body-shockwave-r1", "body-beam-r1"],
      startingRanks: { Shockwave: 2, Beam: 1 },
    });
  });
});

// ---------------------------------------------------------------------------
// getActiveHeroCardNumber + active-card lookups
// ---------------------------------------------------------------------------

describe("getActiveHeroCardNumber — picked card resolution", () => {
  it("returns the picked card from state", () => {
    const s = newCampaign();
    s.activeHeroCardByDelver["hero-01"] = 3;
    expect(getActiveHeroCardNumber(s, "hero-01")).toBe(3);
  });

  it("falls back to the heroId's natural card number when unset", () => {
    const s = newCampaign();
    // Defensively drop the map entry — exercises the `getHero(heroId).number`
    // fallback used during `newCampaign`'s chicken-and-egg construction.
    delete (s.activeHeroCardByDelver as Record<string, number>)["hero-01"];
    expect(getActiveHeroCardNumber(s, "hero-01")).toBe(1);
    delete (s.activeHeroCardByDelver as Record<string, number>)["hero-02"];
    expect(getActiveHeroCardNumber(s, "hero-02")).toBe(2);
  });

  it("getActiveHeroCardStartingEquipment honours the picked card", () => {
    const s = newCampaign();
    s.activeHeroCardByDelver["hero-01"] = 5;
    const eq = getActiveHeroCardStartingEquipment(s, "hero-01");
    expect(eq.map((c) => c.id).sort()).toEqual(["mind-mace-r1", "mind-trident-r1"]);
  });

  it("getActiveHeroCardStartingRanks honours the picked card", () => {
    const s = newCampaign();
    s.activeHeroCardByDelver["hero-02"] = 6;
    expect(getActiveHeroCardStartingRanks(s, "hero-02")).toEqual({
      Shockwave: 2,
      Beam: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// newEquipmentRanksForActiveCard — state-aware rank initialisation
// ---------------------------------------------------------------------------

describe("newEquipmentRanksForActiveCard — picked card determines the rank table", () => {
  it("card #1 → same shape as the legacy newEquipmentRanks (backward compat)", () => {
    const s = newCampaign();
    s.activeHeroCardByDelver["hero-01"] = 1;
    const ranks = newEquipmentRanksForActiveCard(s, "hero-01");
    expect(ranks.Beam).toBe(1);
    expect(ranks.Hammer).toBe(1);
    expect(ranks.Shield).toBe(1);
    // Every other type is 0
    expect(ranks.Trident).toBe(0);
    expect(ranks.Boots).toBe(0);
  });

  it("card #5 → only Trident (r2) and Mace (r1) above zero", () => {
    const s = newCampaign();
    s.activeHeroCardByDelver["hero-01"] = 5;
    const ranks = newEquipmentRanksForActiveCard(s, "hero-01");
    expect(ranks.Trident).toBe(2);
    expect(ranks.Mace).toBe(1);
    // Card #5 doesn't print Shield/Boots/Beam/Hammer — must all be 0.
    expect(ranks.Shield).toBe(0);
    expect(ranks.Boots).toBe(0);
    expect(ranks.Beam).toBe(0);
    expect(ranks.Hammer).toBe(0);
  });

  it("card #6 → Shockwave r2 + Beam r1 only", () => {
    const s = newCampaign();
    s.activeHeroCardByDelver["hero-02"] = 6;
    const ranks = newEquipmentRanksForActiveCard(s, "hero-02");
    expect(ranks.Shockwave).toBe(2);
    expect(ranks.Beam).toBe(1);
    expect(ranks.Armor).toBe(0);
    expect(ranks.Gauntlet).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// reseedDelverFromActiveHeroCard — picks reset HP/AP/movement + ranks
// ---------------------------------------------------------------------------

describe("reseedDelverFromActiveHeroCard — re-stamps loadout + ranks", () => {
  function seedSwitch(cardNumber: number): CampaignState {
    const s = newCampaign();
    // Pretend the delver previously had upgraded ranks + slotted weapons
    // that should be cleared by the re-seed.
    const lo = s.loadouts["hero-01"]!;
    lo.slotCards[0] = "mind-hammer-r1";
    lo.currentHp = 1; // bumped down to verify reset to maxHp
    s.equipmentRanks["hero-01"]!.Hammer = 5;
    s.equipmentRanks["hero-01"]!.Boots = 3;
    s.activeHeroCardByDelver["hero-01"] = cardNumber;
    reseedDelverFromActiveHeroCard(s, "hero-01");
    return s;
  }

  it("card #5 reseed → ranks reflect Trident r2 / Mace r1 only", () => {
    const s = seedSwitch(5);
    const ranks = s.equipmentRanks["hero-01"]!;
    expect(ranks.Trident).toBe(2);
    expect(ranks.Mace).toBe(1);
    expect(ranks.Hammer).toBe(0); // cleared — not in card #5's loadout
    expect(ranks.Boots).toBe(0); // cleared
  });

  it("reseed clears slotCards and resets HP / AP / movement", () => {
    const s = seedSwitch(3);
    const lo = s.loadouts["hero-01"]!;
    expect(lo.slotCards.every((c) => c === null)).toBe(true);
    expect(lo.currentHp).toBe(lo.maxHp);
    expect(lo.currentAp).toBe(lo.baseAp);
    expect(lo.currentMovement).toBe(lo.baseMovement);
  });

  it("re-applies IMMEDIATELY passive effects from the picked card's loadout", () => {
    // Card #2 includes Armor — the Body delver's Exoframe Armor R1 should
    // re-apply set-max-hp + modify-current-hp on re-seed.
    const s = newCampaign();
    s.loadouts["hero-02"]!.maxHp = 1; // wipe any pre-existing maxHp bump
    s.loadouts["hero-02"]!.currentHp = 1;
    s.activeHeroCardByDelver["hero-02"] = 2;
    reseedDelverFromActiveHeroCard(s, "hero-02");
    expect(s.loadouts["hero-02"]!.maxHp).toBe(9);
    expect(s.loadouts["hero-02"]!.currentHp).toBe(9);
  });

  it("card #6 (Body, no passives in loadout) reseed → no maxHp bump", () => {
    const s = newCampaign();
    // Card #6 is Shockwave + Beam — both ACTIVE weapons, no passives. The
    // Body delver who would normally start with Exoframe Armor doesn't get
    // it under card #6 — so maxHp stays at the Tuning baseline (6).
    s.activeHeroCardByDelver["hero-02"] = 6;
    reseedDelverFromActiveHeroCard(s, "hero-02");
    expect(s.loadouts["hero-02"]!.maxHp).toBe(6); // Tuning.startingHp
    expect(s.loadouts["hero-02"]!.currentHp).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// populatePendingHeroPicks — quest-start picker queue
// ---------------------------------------------------------------------------

describe("populatePendingHeroPicks — queues only delvers with 2+ owned cards", () => {
  it("Q1 default (only #1 + #2 unlocked) → empty queue, marks quest applied", () => {
    const s = newCampaign();
    const added = populatePendingHeroPicks(s, "quest1");
    expect(added).toEqual([]);
    expect(s.pendingHeroPickDelvers).toEqual([]);
    expect(s.heroPicksAppliedQuests).toContain("quest1");
  });

  it("Mind unlocks #3 → Mind delver queues, Body delver does not", () => {
    const s = newCampaign();
    s.unlockedHeroCards.push(3);
    const added = populatePendingHeroPicks(s, "quest2");
    expect(added).toEqual(["hero-01"]);
    expect(s.pendingHeroPickDelvers).toEqual(["hero-01"]);
  });

  it("Both unlock 2+ → queue follows HERO_PICK_ORDER (Mind first, then Body)", () => {
    const s = newCampaign();
    s.unlockedHeroCards.push(3, 4);
    populatePendingHeroPicks(s, "quest2");
    expect(s.pendingHeroPickDelvers).toEqual([...HERO_PICK_ORDER]);
  });

  it("idempotent: second call for the same questId is a no-op", () => {
    const s = newCampaign();
    s.unlockedHeroCards.push(3);
    populatePendingHeroPicks(s, "quest2");
    populatePendingHeroPicks(s, "quest2");
    expect(s.pendingHeroPickDelvers).toEqual(["hero-01"]); // not doubled
  });
});

describe("ownedHeroCardNumbersForSuit — filter by suit + unlocked set", () => {
  it("returns only unlocked cards matching the suit, in card-number order", () => {
    const s = newCampaign();
    s.unlockedHeroCards.push(3, 4, 5);
    expect(ownedHeroCardNumbersForSuit(s, "mind")).toEqual([1, 3, 5]);
    expect(ownedHeroCardNumbersForSuit(s, "body")).toEqual([2, 4]);
  });
});

// ---------------------------------------------------------------------------
// commitHeroPick — validation + re-seed
// ---------------------------------------------------------------------------

describe("commitHeroPick — validation gates", () => {
  it("throws when heroId is not at the head of the FIFO queue", () => {
    const s = newCampaign();
    s.unlockedHeroCards.push(3, 4);
    populatePendingHeroPicks(s, "quest2");
    // Mind delver is at the head — attempting to commit Body first throws
    expect(() => commitHeroPick(s, "hero-02", 4)).toThrow(/out-of-order/);
  });

  it("throws when the picked card is not unlocked", () => {
    const s = newCampaign();
    s.unlockedHeroCards.push(3);
    populatePendingHeroPicks(s, "quest2");
    // #5 isn't unlocked yet — must reject even though it's a valid Mind card
    expect(() => commitHeroPick(s, "hero-01", 5)).toThrow(/not in unlockedHeroCards/);
  });

  it("throws when the picked card's suit doesn't match the delver's suit", () => {
    const s = newCampaign();
    s.unlockedHeroCards.push(3, 4);
    populatePendingHeroPicks(s, "quest2");
    // hero-01 is Mind — card #4 is Body, must reject
    expect(() => commitHeroPick(s, "hero-01", 4)).toThrow(/does not match delver/);
  });
});

describe("commitHeroPick — happy path re-seeds the delver", () => {
  it("writes activeHeroCardByDelver and pops the queue head", () => {
    const s = newCampaign();
    s.unlockedHeroCards.push(3);
    populatePendingHeroPicks(s, "quest2");
    commitHeroPick(s, "hero-01", 3);
    expect(s.activeHeroCardByDelver["hero-01"]).toBe(3);
    expect(s.pendingHeroPickDelvers).toEqual([]);
  });

  it("re-seeds equipmentRanks to the picked card's loadout (#5 → Trident r2 only)", () => {
    const s = newCampaign();
    s.unlockedHeroCards.push(3, 5);
    populatePendingHeroPicks(s, "quest2");
    commitHeroPick(s, "hero-01", 5);
    const ranks = s.equipmentRanks["hero-01"]!;
    expect(ranks.Trident).toBe(2);
    expect(ranks.Mace).toBe(1);
    expect(ranks.Hammer).toBe(0);
    expect(ranks.Beam).toBe(0);
    expect(ranks.Shield).toBe(0); // dropped vs. legacy hero-01 starter
  });

  it("picking the Body delver does not disturb the Mind delver's ranks", () => {
    const s = newCampaign();
    s.unlockedHeroCards.push(4);
    populatePendingHeroPicks(s, "quest2");
    // Mind delver isn't in the queue (only #1 unlocked for mind), so the
    // pending queue head is hero-02. Commit the Body pick.
    commitHeroPick(s, "hero-02", 4);
    // Mind delver still on card #1 with the legacy starters intact.
    const mindRanks = s.equipmentRanks["hero-01"]!;
    expect(mindRanks.Beam).toBe(1);
    expect(mindRanks.Hammer).toBe(1);
    expect(mindRanks.Shield).toBe(1);
    // Body delver swapped to card #4: Trident r1 + Mace r1 + Battery r1.
    const bodyRanks = s.equipmentRanks["hero-02"]!;
    expect(bodyRanks.Trident).toBe(1);
    expect(bodyRanks.Mace).toBe(1);
    expect(bodyRanks.Battery).toBe(1);
    expect(bodyRanks.Gauntlet).toBe(0);
    expect(bodyRanks.Armor).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: pick a card -> ranks honour print -> hand snapshot matches
// ---------------------------------------------------------------------------

describe("end-to-end — picked card shapes the playable hand", () => {
  function hasHand(s: CampaignState, heroId: string, type: EquipmentType): boolean {
    return (s.equipmentRanks[heroId]?.[type] ?? 0) >= 1;
  }

  it("Mind delver on card #5 sees Trident + Mace only in their hand", () => {
    const s = newCampaign();
    s.unlockedHeroCards.push(3, 5);
    populatePendingHeroPicks(s, "quest2");
    commitHeroPick(s, "hero-01", 5);
    expect(hasHand(s, "hero-01", "Trident")).toBe(true);
    expect(hasHand(s, "hero-01", "Mace")).toBe(true);
    // Things card #5 doesn't print:
    expect(hasHand(s, "hero-01", "Shield")).toBe(false);
    expect(hasHand(s, "hero-01", "Beam")).toBe(false);
    expect(hasHand(s, "hero-01", "Hammer")).toBe(false);
  });

  it("Body delver on card #6 has Shockwave + Beam but no Armor", () => {
    const s = newCampaign();
    s.unlockedHeroCards.push(4, 6);
    populatePendingHeroPicks(s, "quest2");
    commitHeroPick(s, "hero-02", 6);
    expect(hasHand(s, "hero-02", "Shockwave")).toBe(true);
    expect(hasHand(s, "hero-02", "Beam")).toBe(true);
    expect(hasHand(s, "hero-02", "Armor")).toBe(false);
    // And the Body delver doesn't get Exoframe Armor's +3 maxHp.
    expect(s.loadouts["hero-02"]!.maxHp).toBe(6);
  });
});
