/**
 * Tests for src/engine/levelUp.ts (rulebook p24).
 *
 * Covers:
 *   - deck shuffles into encounter on init (28 base cards present;
 *     Ultras 29..32 excluded unless `ultraLevelCardsOwned` adds them).
 *   - drawNextLevelUpCard: pop semantics + reshuffle when empty.
 *   - enqueueLevelUpDraws: 1 draw per delver in delverOrder.
 *   - applyLevelUpChoice (base): +1 rank bump, queue pop, discard.
 *   - applyLevelUpChoice (Ultra): +2 on a printed type, +1 on any
 *     passive, reject for off-card non-passives. Rank cap clamp.
 *   - rank cap (5) prevents further bumps.
 *   - applyPendingLevelUps wires through to enqueue 2 draws per
 *     level-up.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  migrateV37ToV38,
  migrateV38ToV39,
  newCampaign,
  type CampaignState,
} from "../state";
import { runTownVisitAction } from "../engine/townVisit";
import { QUEST1, LEVEL_DECK } from "../data";
import { ensureEncounter } from "../engine/encounter";
import {
  applyLevelUpChoice,
  discardUnplayableLevelUpDraw,
  drawNextLevelUpCard,
  legalLevelUpTypes,
  enqueueLevelUpDraws,
  EQUIPMENT_RANK_CAP,
  getLevelUpCard,
  peekNextPendingDraw,
  rankDeltaForLevelUpChoice,
} from "../engine/levelUp";
import { applyPendingLevelUps } from "../engine/kills";
import type { EquipmentType } from "../types";

function freshState(): CampaignState {
  const s = newCampaign();
  ensureEncounter(s, QUEST1, (pool) => [...pool]); // deterministic
  return s;
}

describe("encounter init", () => {
  it("seeds levelUpDeck with the 28 base level cards (1..28); Ultras (29..32) are NOT in the base deck", () => {
    const s = freshState();
    const enc = s.encounter!;
    const baseCount = LEVEL_DECK.filter((c) => !c.isUltra).length;
    expect(enc.levelUpDeck.length).toBe(baseCount);
    expect(baseCount).toBe(28);
    expect(enc.levelUpDiscard.length).toBe(0);
    expect(enc.pendingLevelUpDraws.length).toBe(0);
    const sorted = [...enc.levelUpDeck].sort((a, b) => a - b);
    expect(sorted[0]).toBe(1);
    expect(sorted[sorted.length - 1]).toBe(28);
    // No Ultras leaked into the base deck.
    for (const ultraNum of LEVEL_DECK.filter((c) => c.isUltra).map((c) => c.cardNumber)) {
      expect(sorted).not.toContain(ultraNum);
    }
  });

  it("shuffles owned Ultras into the per-encounter deck when the campaign owns them", () => {
    const s = newCampaign();
    s.ultraLevelCardsOwned = [29, 31];
    ensureEncounter(s, QUEST1, (pool) => [...pool]);
    const enc = s.encounter!;
    expect(enc.levelUpDeck.length).toBe(28 + 2);
    expect(enc.levelUpDeck).toContain(29);
    expect(enc.levelUpDeck).toContain(31);
    expect(enc.levelUpDeck).not.toContain(30);
    expect(enc.levelUpDeck).not.toContain(32);
  });

  it("ignores stale Ultra numbers in `ultraLevelCardsOwned` that aren't printed Ultras", () => {
    const s = newCampaign();
    // 99 isn't a printed card; 29 is a real Ultra; 5 is a base
    // card that should NOT be re-added (it's already in the base deck);
    // 25 was an Ultra under v38 but is back to base in v39 — must be
    // dropped here too (otherwise it would double up in the deck).
    s.ultraLevelCardsOwned = [29, 99, 5, 25];
    ensureEncounter(s, QUEST1, (pool) => [...pool]);
    const enc = s.encounter!;
    // 28 base + 1 valid Ultra (29). 99 dropped, 5 dropped, 25 dropped.
    expect(enc.levelUpDeck.length).toBe(28 + 1);
    expect(enc.levelUpDeck).toContain(29);
    expect(enc.levelUpDeck).not.toContain(99);
    // 5 and 25 still present (base deck), but only once each.
    expect(enc.levelUpDeck.filter((n) => n === 5).length).toBe(1);
    expect(enc.levelUpDeck.filter((n) => n === 25).length).toBe(1);
  });
});

describe("drawNextLevelUpCard", () => {
  it("pops the top card off the deck and returns it", () => {
    const s = freshState();
    const enc = s.encounter!;
    const top = enc.levelUpDeck[0];
    const sizeBefore = enc.levelUpDeck.length;
    const drawn = drawNextLevelUpCard(enc);
    expect(drawn).toBe(top);
    expect(enc.levelUpDeck.length).toBe(sizeBefore - 1);
  });

  it("reshuffles from discard when deck is empty", () => {
    const s = freshState();
    const enc = s.encounter!;
    enc.levelUpDeck = [];
    enc.levelUpDiscard = [3, 7, 11];
    const drawn = drawNextLevelUpCard(enc);
    expect([3, 7, 11]).toContain(drawn);
    expect(enc.levelUpDeck.length).toBe(2);
    expect(enc.levelUpDiscard.length).toBe(0);
  });

  it("returns null when both deck and discard are empty", () => {
    const s = freshState();
    const enc = s.encounter!;
    enc.levelUpDeck = [];
    enc.levelUpDiscard = [];
    expect(drawNextLevelUpCard(enc)).toBeNull();
  });
});

describe("enqueueLevelUpDraws", () => {
  it("enqueues one draw per delver in the given order", () => {
    const s = freshState();
    const sizeBefore = s.encounter!.levelUpDeck.length;
    const added = enqueueLevelUpDraws(s, ["hero-01", "hero-02"]);
    expect(added).toBe(2);
    const enc = s.encounter!;
    expect(enc.pendingLevelUpDraws.length).toBe(2);
    expect(enc.pendingLevelUpDraws[0]!.heroId).toBe("hero-01");
    expect(enc.pendingLevelUpDraws[1]!.heroId).toBe("hero-02");
    // Each pending draw is locked to a real BASE card (Ultras aren't
    // in the per-encounter deck unless owned, and freshState() owns none).
    for (const draw of enc.pendingLevelUpDraws) {
      expect(draw.cardNumber).toBeGreaterThanOrEqual(1);
      expect(draw.cardNumber).toBeLessThanOrEqual(28);
      const card = getLevelUpCard(draw.cardNumber);
      expect(card.isUltra ?? false).toBe(false);
    }
    // Deck shrunk by 2.
    expect(enc.levelUpDeck.length).toBe(sizeBefore - 2);
  });
});

describe("grant-ultra-level-cards town visit action", () => {
  it("grants `amount` Ultras from the unowned pool and emits one ultra-level-cards-gained event", () => {
    const s = newCampaign();
    expect(s.ultraLevelCardsOwned).toEqual([]);
    const events = runTownVisitAction(s, { kind: "grant-ultra-level-cards", amount: 2 });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.kind).toBe("ultra-level-cards-gained");
    if (ev.kind !== "ultra-level-cards-gained") throw new Error("kind mismatch");
    expect(ev.cardNumbers).toHaveLength(2);
    const ultraNums = LEVEL_DECK.filter((c) => c.isUltra).map((c) => c.cardNumber);
    for (const n of ev.cardNumbers) expect(ultraNums).toContain(n);
    // No duplicates within the granted batch.
    expect(new Set(ev.cardNumbers).size).toBe(ev.cardNumbers.length);
    // State updated and stored sorted.
    expect(s.ultraLevelCardsOwned).toEqual([...s.ultraLevelCardsOwned].sort((a, b) => a - b));
    expect(s.ultraLevelCardsOwned.length).toBe(2);
  });

  it("grants only what's left when amount exceeds unowned pool", () => {
    const s = newCampaign();
    s.ultraLevelCardsOwned = [29, 30, 31];
    const events = runTownVisitAction(s, { kind: "grant-ultra-level-cards", amount: 5 });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    if (ev.kind !== "ultra-level-cards-gained") throw new Error("kind mismatch");
    expect(ev.cardNumbers).toEqual([32]); // only Ultra left
    expect(s.ultraLevelCardsOwned).toEqual([29, 30, 31, 32]);
  });

  it("emits no event (silent no-op) when every Ultra is already owned", () => {
    const s = newCampaign();
    s.ultraLevelCardsOwned = [29, 30, 31, 32];
    const events = runTownVisitAction(s, { kind: "grant-ultra-level-cards", amount: 2 });
    expect(events).toEqual([]);
    expect(s.ultraLevelCardsOwned).toEqual([29, 30, 31, 32]);
  });

  it("emits no event when amount <= 0", () => {
    const s = newCampaign();
    const events = runTownVisitAction(s, { kind: "grant-ultra-level-cards", amount: 0 });
    expect(events).toEqual([]);
    expect(s.ultraLevelCardsOwned).toEqual([]);
  });
});

describe("applyLevelUpChoice", () => {
  let s: CampaignState;
  beforeEach(() => {
    s = freshState();
  });

  it("rejects when there is no pending draw", () => {
    const r = applyLevelUpChoice(s, "Gauntlet");
    expect(r.ok).toBe(false);
  });

  it("bumps the chosen type's rank by +1 and pops the queue", () => {
    // Force-enqueue a known draw with a known card so we control which
    // 3 types are on offer.
    const enc = s.encounter!;
    enc.pendingLevelUpDraws.push({ heroId: "hero-02", cardNumber: 1 });
    const card = getLevelUpCard(1);
    expect(card.types).toEqual(["Gauntlet", "Battery", "Harvester"]);
    // hero-02 is body suit, starts with Gauntlet at R1.
    const ranksBefore = s.equipmentRanks["hero-02"]!;
    expect(ranksBefore.Gauntlet).toBe(1);

    const r = applyLevelUpChoice(s, "Gauntlet");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.newRank).toBe(2);
    expect(s.equipmentRanks["hero-02"]!.Gauntlet).toBe(2);
    expect(enc.pendingLevelUpDraws.length).toBe(0);
    expect(enc.levelUpDiscard).toContain(1);
  });

  it("can pick a 0-rank type to gain it at R1 (adds it to the hand)", () => {
    const enc = s.encounter!;
    enc.pendingLevelUpDraws.push({ heroId: "hero-02", cardNumber: 1 });
    // hero-02 doesn't start with Battery.
    expect(s.equipmentRanks["hero-02"]!.Battery).toBe(0);
    const r = applyLevelUpChoice(s, "Battery");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.newRank).toBe(1);
    expect(s.equipmentRanks["hero-02"]!.Battery).toBe(1);
  });

  it("rejects a type that is not on the drawn card", () => {
    const enc = s.encounter!;
    enc.pendingLevelUpDraws.push({ heroId: "hero-02", cardNumber: 1 });
    // Card 1 lists Gauntlet/Battery/Harvester, not Hammer.
    const r = applyLevelUpChoice(s, "Hammer" as EquipmentType);
    expect(r.ok).toBe(false);
    expect(s.equipmentRanks["hero-02"]!.Hammer).toBe(0);
  });

  it("rejects when the chosen type is already at the rank cap (R5)", () => {
    const enc = s.encounter!;
    enc.pendingLevelUpDraws.push({ heroId: "hero-02", cardNumber: 1 });
    s.equipmentRanks["hero-02"]!.Gauntlet = EQUIPMENT_RANK_CAP;
    const r = applyLevelUpChoice(s, "Gauntlet");
    expect(r.ok).toBe(false);
    expect(s.equipmentRanks["hero-02"]!.Gauntlet).toBe(EQUIPMENT_RANK_CAP);
  });

  it("peekNextPendingDraw returns null when queue is empty, head when not", () => {
    expect(peekNextPendingDraw(s)).toBeNull();
    s.encounter!.pendingLevelUpDraws.push({ heroId: "hero-01", cardNumber: 5 });
    s.encounter!.pendingLevelUpDraws.push({ heroId: "hero-02", cardNumber: 6 });
    expect(peekNextPendingDraw(s)?.heroId).toBe("hero-01");
  });
});

describe("applyLevelUpChoice — Ultra cards", () => {
  // Ultra card 32: types = [Hammer, Trident]. So +2 RANKS on Hammer
  // or Trident, +1 RANK on any passive (OS / Shield / Boots /
  // Supercharger / Armor / Harvester / Battery), reject anything
  // else (e.g. an off-card weapon like Beam).
  let s: CampaignState;
  beforeEach(() => {
    s = freshState();
  });

  it("rankDeltaForLevelUpChoice returns the right per-pick delta for Ultra 32", () => {
    const card = getLevelUpCard(32);
    expect(card.isUltra).toBe(true);
    expect(card.types).toEqual(["Hammer", "Trident"]);
    expect(rankDeltaForLevelUpChoice(card, "Hammer")).toBe(2);
    expect(rankDeltaForLevelUpChoice(card, "Trident")).toBe(2);
    // Any passive yields +1, even when not in `card.types`.
    expect(rankDeltaForLevelUpChoice(card, "Boots")).toBe(1);
    expect(rankDeltaForLevelUpChoice(card, "Battery")).toBe(1);
    // Off-card weapon (Beam): not a printed type, not a passive -> 0.
    expect(rankDeltaForLevelUpChoice(card, "Beam")).toBe(0);
  });

  it("rankDeltaForLevelUpChoice returns +1 only for printed types on base cards", () => {
    const card = getLevelUpCard(1); // [Gauntlet, Battery, Harvester]
    expect(card.isUltra ?? false).toBe(false);
    expect(rankDeltaForLevelUpChoice(card, "Gauntlet")).toBe(1);
    // Battery IS on this card AND IS a passive — still resolves to
    // +1 (base card path doesn't care about passive-ness).
    expect(rankDeltaForLevelUpChoice(card, "Battery")).toBe(1);
    // Boots is a passive but NOT on the card -> 0 (no Ultra escape hatch).
    expect(rankDeltaForLevelUpChoice(card, "Boots")).toBe(0);
    expect(rankDeltaForLevelUpChoice(card, "Hammer")).toBe(0);
  });

  it("picking a printed type on an Ultra bumps the rank by +2", () => {
    const enc = s.encounter!;
    enc.pendingLevelUpDraws.push({ heroId: "hero-02", cardNumber: 32 });
    // hero-02 doesn't start with Trident.
    expect(s.equipmentRanks["hero-02"]!.Trident ?? 0).toBe(0);
    const r = applyLevelUpChoice(s, "Trident");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.delta).toBe(2);
    expect(r.newRank).toBe(2);
    expect(s.equipmentRanks["hero-02"]!.Trident).toBe(2);
    expect(enc.levelUpDiscard).toContain(32);
    expect(enc.pendingLevelUpDraws.length).toBe(0);
  });

  it("picking a passive on an Ultra (not on card) bumps the rank by +1", () => {
    const enc = s.encounter!;
    enc.pendingLevelUpDraws.push({ heroId: "hero-02", cardNumber: 32 });
    expect(s.equipmentRanks["hero-02"]!.Battery ?? 0).toBe(0);
    const r = applyLevelUpChoice(s, "Battery");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.delta).toBe(1);
    expect(r.newRank).toBe(1);
    expect(s.equipmentRanks["hero-02"]!.Battery).toBe(1);
  });

  it("rejects picking an off-card weapon on an Ultra", () => {
    const enc = s.encounter!;
    enc.pendingLevelUpDraws.push({ heroId: "hero-02", cardNumber: 32 });
    // Card 32 lists Hammer/Trident; Beam is a weapon (not passive) and
    // not on the card -> illegal.
    const r = applyLevelUpChoice(s, "Beam");
    expect(r.ok).toBe(false);
    expect(s.equipmentRanks["hero-02"]!.Beam ?? 0).toBe(0);
    // Card is NOT discarded on a rejected pick — the pending draw
    // stays in the queue so the player can retry.
    expect(enc.pendingLevelUpDraws.length).toBe(1);
    expect(enc.levelUpDiscard).not.toContain(32);
  });

  it("clamps the +2 bump at the rank cap (R4 + 2 -> R5)", () => {
    const enc = s.encounter!;
    enc.pendingLevelUpDraws.push({ heroId: "hero-02", cardNumber: 32 });
    s.equipmentRanks["hero-02"]!.Trident = 4;
    // Unlock Trident for rank 4+ so the level-up is not blocked by the R3 cap.
    if (!s.unlockedForHigherRanks["hero-02"]) s.unlockedForHigherRanks["hero-02"] = {};
    s.unlockedForHigherRanks["hero-02"]!.Trident = 5;
    const r = applyLevelUpChoice(s, "Trident");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Printed delta is still 2, but the applied amount is clamped.
    expect(r.delta).toBe(2);
    expect(r.newRank).toBe(EQUIPMENT_RANK_CAP);
    expect(s.equipmentRanks["hero-02"]!.Trident).toBe(EQUIPMENT_RANK_CAP);
  });

  it("fires PER-TIER IMMEDIATELY effects when an Ultra +2 takes a type from R0 to R2", () => {
    // Ultra 30 lists [Boots, Supercharger]. Picking Boots from R0 on
    // hero-01 (Mind) crosses R0 -> R2 and fires BOTH tiers' printed
    // IMMEDIATELYs in order: R1 sets the floor to 2, R2 raises it to
    // 3 (designer ruling 2026-07-22 — every ranked card re-prints
    // its own IMMEDIATELY line).
    const enc = s.encounter!;
    enc.pendingLevelUpDraws.push({ heroId: "hero-01", cardNumber: 30 });
    expect(s.loadouts["hero-01"]!.baseMovement).toBe(1);
    const r = applyLevelUpChoice(s, "Boots");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.delta).toBe(2);
    expect(s.equipmentRanks["hero-01"]!.Boots).toBe(2);
    expect(s.loadouts["hero-01"]!.baseMovement).toBe(3);
  });
});

describe("applyLevelUpChoice — IMMEDIATELY hook on first gain", () => {
  it("gaining Boots at R0 -> R1 fires set-base-movement on the bearer", () => {
    const s = freshState();
    const enc = s.encounter!;
    // Card 2 lists Hammer / Boots / OS — pick Boots for hero-01 (Mind).
    enc.pendingLevelUpDraws.push({ heroId: "hero-01", cardNumber: 2 });
    expect(s.equipmentRanks["hero-01"]!.Boots ?? 0).toBe(0);
    expect(s.loadouts["hero-01"]!.baseMovement).toBe(1);

    const r = applyLevelUpChoice(s, "Boots");
    expect(r.ok).toBe(true);
    expect(s.equipmentRanks["hero-01"]!.Boots).toBe(1);
    // Slip Strider Boots: baseMovement bumps from 1 to 2 immediately.
    expect(s.loadouts["hero-01"]!.baseMovement).toBe(2);
    expect(s.loadouts["hero-01"]!.currentMovement).toBe(2);
  });

  it("only the chosen delver's loadout is affected (not the other delver)", () => {
    const s = freshState();
    const enc = s.encounter!;
    enc.pendingLevelUpDraws.push({ heroId: "hero-01", cardNumber: 2 });
    applyLevelUpChoice(s, "Boots");
    // hero-02 still at baseline.
    expect(s.loadouts["hero-02"]!.baseMovement).toBe(1);
    expect(s.equipmentRanks["hero-02"]!.Boots ?? 0).toBe(0);
  });

  it("ranking up an EXISTING card (R1 -> R2) fires the R2 card's IMMEDIATELY (designer ruling 2026-07-22)", () => {
    // Every ranked card re-prints its own IMMEDIATELY line — Boots
    // R2 raises the movement floor to 3 (Armor R2 sets max HP 12).
    // Pre-fix, rank-ups fired nothing, which is how "armor above
    // rank 1 gives no HP" slipped through.
    const s = freshState();
    const enc = s.encounter!;
    // Pre-bump Boots to R1 + IMMEDIATELY-applied state by hand.
    s.equipmentRanks["hero-01"]!.Boots = 1;
    s.loadouts["hero-01"]!.baseMovement = 2;
    s.loadouts["hero-01"]!.currentMovement = 0; // pretend they spent it.

    enc.pendingLevelUpDraws.push({ heroId: "hero-01", cardNumber: 2 });
    const r = applyLevelUpChoice(s, "Boots");
    expect(r.ok).toBe(true);
    expect(s.equipmentRanks["hero-01"]!.Boots).toBe(2);
    // R2 card: "set base movement to 3" — floor rises, and the
    // only-up current pull brings the spent pool up to the new floor.
    expect(s.loadouts["hero-01"]!.baseMovement).toBe(3);
    expect(s.loadouts["hero-01"]!.currentMovement).toBe(3);
  });

  it("ranking up Armor applies the ranked card's max-HP and heal-tier values", () => {
    // The reported bug verbatim: Armor above R1 gave no HP increase.
    // hero-02 starts with Armor R1 (maxHp 9). R1 -> R2 must set max
    // HP to 12 and grant the printed +3 current HP.
    const s = freshState();
    const enc = s.encounter!;
    const lo = s.loadouts["hero-02"]!;
    expect(s.equipmentRanks["hero-02"]!.Armor).toBe(1);
    expect(lo.maxHp).toBe(9);
    lo.currentHp = 5; // mid-quest damage
    // Level card 3 lists Armor (find any card listing Armor).
    const armorCard = LEVEL_DECK.find((c) => !c.isUltra && c.types.includes("Armor"))!;
    enc.pendingLevelUpDraws.push({ heroId: "hero-02", cardNumber: armorCard.cardNumber });
    const r = applyLevelUpChoice(s, "Armor");
    expect(r.ok).toBe(true);
    expect(s.equipmentRanks["hero-02"]!.Armor).toBe(2);
    expect(lo.maxHp).toBe(12);
    expect(lo.currentHp).toBe(8); // 5 + printed +3
  });
});

// ---------- v37 -> v38 (Ultra-owned field seed) --------------------------

describe("migrateV37ToV38 — ultraLevelCardsOwned seed", () => {
  it("graduates a v37 save to v38 (intermediate version, not SCHEMA_VERSION)", () => {
    // Hard-code 38 (not SCHEMA_VERSION) so a future migration doesn't
    // silently regress this — v38 -> v39 (Ultra card renumber) is
    // what actually graduates the save to the current head. This
    // test verifies the intermediate stop; chained migration coverage
    // lives in loadCampaign tests.
    const save = { version: 37, encounter: null, loadouts: { "hero-01": {}, "hero-02": {} } };
    const out = migrateV37ToV38(save) as CampaignState;
    expect(out.version).toBe(38);
  });

  it("seeds ultraLevelCardsOwned = [] when absent", () => {
    const save = { version: 37, encounter: null, loadouts: { "hero-01": {}, "hero-02": {} } };
    const out = migrateV37ToV38(save) as CampaignState;
    expect(out.ultraLevelCardsOwned).toEqual([]);
  });

  it("does NOT clobber a pre-existing array (forward-compat)", () => {
    const save = {
      version: 37,
      encounter: null,
      loadouts: { "hero-01": {}, "hero-02": {} },
      // Under v37, the (buggy) Ultra range was 25..28. We preserve
      // whatever's there so the next migration step (v38 -> v39) can
      // clean it up correctly.
      ultraLevelCardsOwned: [25, 27],
    };
    const out = migrateV37ToV38(save) as unknown as CampaignState;
    expect(out.ultraLevelCardsOwned).toEqual([25, 27]);
  });
});

// ---------- v38 -> v39 (Ultra card renumber: 25..28 -> 29..32) -----------

describe("migrateV38ToV39 — Ultra card renumber", () => {
  it("graduates a v38 save to v39 (intermediate stop, not SCHEMA_VERSION)", () => {
    // Hard-code 39 (not SCHEMA_VERSION) so future migrations don't
    // silently regress this — the v39 -> v40 migration (Witness
    // `witnessStepsThisTurn` backfill) is what actually graduates
    // the save to SCHEMA_VERSION. This test verifies the
    // intermediate stop; chained migration coverage lives in
    // loadCampaign tests.
    const save = { version: 38, ultraLevelCardsOwned: [] };
    const out = migrateV38ToV39(save) as CampaignState;
    expect(out.version).toBe(39);
  });

  it("drops legacy 25..28 Ultras from ultraLevelCardsOwned (they're base cards now)", () => {
    const save = { version: 38, ultraLevelCardsOwned: [25, 26, 27, 28] };
    const out = migrateV38ToV39(save) as CampaignState;
    expect(out.ultraLevelCardsOwned).toEqual([]);
  });

  it("preserves valid v39 Ultras (29..32)", () => {
    const save = { version: 38, ultraLevelCardsOwned: [29, 30, 31, 32] };
    const out = migrateV38ToV39(save) as CampaignState;
    expect(out.ultraLevelCardsOwned).toEqual([29, 30, 31, 32]);
  });

  it("filters out garbage entries (non-numeric, out-of-range, stale base numbers)", () => {
    const save = {
      version: 38,
      // Mix of: valid Ultras (29, 31), legacy "Ultras" that became
      // base cards (25, 28), out-of-range (99), and a base card (5).
      ultraLevelCardsOwned: [29, 25, 99, 5, 31, 28],
    };
    const out = migrateV38ToV39(save) as CampaignState;
    expect(out.ultraLevelCardsOwned).toEqual([29, 31]);
  });

  it("seeds an empty array when the field is missing", () => {
    const save = { version: 38 };
    const out = migrateV38ToV39(save) as CampaignState;
    expect(out.ultraLevelCardsOwned).toEqual([]);
  });

  it("returns null for non-object input", () => {
    expect(migrateV38ToV39(null)).toBeNull();
  });
});

describe("applyPendingLevelUps integration", () => {
  it("enqueues 2 pending draws per level-up (one per delver)", () => {
    const s = freshState();
    s.xpOnHand = 1; // exactly enough for level 0 -> 1.
    const levelUps = applyPendingLevelUps(s);
    expect(levelUps).toBe(1);
    expect(s.encounter!.pendingLevelUpDraws.length).toBe(2);
    expect(s.encounter!.pendingLevelUpDraws[0]!.heroId).toBe("hero-01");
    expect(s.encounter!.pendingLevelUpDraws[1]!.heroId).toBe("hero-02");
  });

  it("multi-level-up enqueues 2 draws per level (4 total for 2 levels)", () => {
    const s = freshState();
    // Cost from level 0: 1, then from level 1: 3 -> 4 total for 2 levels.
    s.xpOnHand = 4;
    const levelUps = applyPendingLevelUps(s);
    expect(levelUps).toBe(2);
    expect(s.encounter!.pendingLevelUpDraws.length).toBe(4);
    // Order: level 1 hero-01, hero-02, then level 2 hero-01, hero-02.
    expect(s.encounter!.pendingLevelUpDraws.map((d) => d.heroId))
      .toEqual(["hero-01", "hero-02", "hero-01", "hero-02"]);
  });
});

describe("unplayable level-up card (ruling 2026-11-15: just discard it)", () => {
  const baseCard = () => LEVEL_DECK.find((c) => !c.isUltra)!;

  it("lists the printed types while they are below the R3 lock", () => {
    const s = freshState();
    expect(legalLevelUpTypes(s, "hero-02", baseCard()).sort()).toEqual([...baseCard().types].sort());
  });

  it("discards the card with no rank change when every printed type is locked at R3", () => {
    const s = freshState();
    const card = baseCard();
    for (const t of card.types) s.equipmentRanks["hero-02"]![t] = 3;
    expect(legalLevelUpTypes(s, "hero-02", card)).toEqual([]);
    s.encounter!.pendingLevelUpDraws.push({ heroId: "hero-02", cardNumber: card.cardNumber });
    const before = structuredClone(s.equipmentRanks);
    expect(discardUnplayableLevelUpDraw(s)).toBe(card.cardNumber);
    expect(s.encounter!.pendingLevelUpDraws).toEqual([]);
    expect(s.encounter!.levelUpDiscard).toContain(card.cardNumber);
    expect(s.equipmentRanks).toEqual(before);
  });

  it("refuses to discard a card that still has a legal pick", () => {
    const s = freshState();
    s.encounter!.pendingLevelUpDraws.push({ heroId: "hero-02", cardNumber: baseCard().cardNumber });
    expect(() => discardUnplayableLevelUpDraw(s)).toThrow(/still has a legal pick/);
  });
});
