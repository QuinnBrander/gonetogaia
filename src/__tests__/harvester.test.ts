/**
 * Tests for the Harvester equipment family (Slice 5+).
 *
 * Both R1 cards print:
 *   - `category: "passive"` (no weapon range, no slot ability surface
 *     beyond the standard passive sheet entry).
 *   - `effects: [{ kind: "gain-tokens-at-end-of-wave",
 *                 token: "creature-part", amount: 2 }]`.
 *
 * Engine behaviour (per design decisions 2026-05-04):
 *   - Bearer-only grant — no `recipient` enum. The other delver
 *     does not get a Harvester bump from one delver's card.
 *   - Pays at End Wave, on EVERY wave end incl. defeat (3-phase wave,
 *     designer decision 2026-11-17), via the End Wave refresh in
 *     `enterEndOfWave`.
 *   - Walks `state.equipmentRanks[bearerId]` (not just starting
 *     equipment) so a Harvester acquired mid-quest via Level Up
 *     correctly fires from the next wave end onward.
 *   - Skips dead delvers (currentHp ≤ 0) — same convention as
 *     `enqueueElementChoice` for `gain-element-at-end-of-wave`.
 *   - Idempotent — `enc.endWaveRefresh` latches the refresh, so a
 *     second `enterEndOfWave` doesn't pay twice.
 *   - No supply tracking (the prototype treats the supply as
 *     infinite; the parenthetical is a tabletop bookkeeping note).
 *   - `state.minionParts[bearerId]` is the sink for `creature-part`
 *     (mirrors slot ability `gain-token` discriminator);
 *     `state.bossParts` for `boss-part` (forward-compat — no R1
 *     card grants boss parts today).
 *
 * Coverage:
 *   - `equipment.json` shape for both Mind / Body Harvester.
 *   - End Wave grants 2 minion parts to the bearer only.
 *   - Both delvers, both Harvesters, independent grants.
 *   - Dead delver is skipped (counter unchanged); other delver
 *     still grants.
 *   - Idempotency latch: a second `enterEndOfWave` doesn't double-
 *     grant.
 *   - Mid-quest acquisition (rank flips 0 → 1 between waves)
 *     correctly fires from the NEXT wave end.
 *   - No-Harvester regression: `state.minionParts` unchanged for a
 *     vanilla state.
 */

import { describe, it, expect } from "vitest";

import { newCampaign, type CampaignState } from "../state";
import { QUEST1, getEquipment } from "../data";
import { ensureEncounter } from "../engine/encounter";
import { startHeroTurn } from "../engine/turn";
import { applyContinuingEndWaveEffects, enterEndOfWave } from "../engine/wave";

const HARVESTER_MIND = "mind-harvester-r1";
const HARVESTER_BODY = "body-harvester-r1";

const noShuffle = (pool: readonly string[]) => [...pool];

function freshState(): CampaignState {
  const s = newCampaign();
  ensureEncounter(s, QUEST1, noShuffle);
  startHeroTurn(s);
  return s;
}

/** End the current wave (End Wave refresh runs on entry). */
function endWave(s: CampaignState, outcome: "victory" | "defeat" = "victory"): void {
  enterEndOfWave(s, outcome);
}

/** Simulate the next wave of the same quest: a fresh hero phase with
 *  the refresh latch cleared (the engine builds a new encounter). */
function nextWave(s: CampaignState): void {
  s.encounter!.phase = "hero";
  s.encounter!.endWaveRefresh = null;
}

// --- equipment.json shape ---------------------------------------------

describe("equipment.json — Harvester cards", () => {
  it("Dragonfly Model Harvester (Mind R1) carries the printed effect", () => {
    const card = getEquipment(HARVESTER_MIND);
    expect(card.type).toBe("Harvester");
    expect(card.suit).toBe("mind");
    expect(card.category).toBe("passive");
    expect(card.rank).toBe(1);
    expect(card.effects).toContainEqual({
      kind: "gain-tokens-at-end-of-wave",
      token: "creature-part",
      amount: 2,
    });
  });

  it("Beetle Model Harvester (Body R1) carries the printed effect", () => {
    const card = getEquipment(HARVESTER_BODY);
    expect(card.type).toBe("Harvester");
    expect(card.suit).toBe("body");
    expect(card.category).toBe("passive");
    expect(card.rank).toBe(1);
    expect(card.effects).toContainEqual({
      kind: "gain-tokens-at-end-of-wave",
      token: "creature-part",
      amount: 2,
    });
  });
});

// --- engine: End Wave refresh -------------------------------------------

describe("End Wave — Harvester grants", () => {
  it("no Harvester owned → minionParts unchanged (regression)", () => {
    const s = freshState();
    const beforeM = s.minionParts["hero-01"] ?? 0;
    const beforeB = s.minionParts["hero-02"] ?? 0;
    endWave(s);
    expect(s.minionParts["hero-01"] ?? 0).toBe(beforeM);
    expect(s.minionParts["hero-02"] ?? 0).toBe(beforeB);
  });

  it("Mind Harvester (rank 1) on hero-01 grants +2 to hero-01 only", () => {
    const s = freshState();
    s.equipmentRanks["hero-01"]!.Harvester = 1;
    const beforeOther = s.minionParts["hero-02"] ?? 0;
    endWave(s);
    expect(s.minionParts["hero-01"]).toBe(2);
    expect(s.minionParts["hero-02"] ?? 0).toBe(beforeOther);
  });

  // Rank scaling (2026-07-22): Harvester prints 2/4/6/8/10 end-of-wave
  // creature parts per rank. Pre-fix the walk read the R1 card and
  // every rank granted 2.
  it("Rank 3 Harvester grants +6 per wave end (rank-correct card)", () => {
    const s = freshState();
    s.equipmentRanks["hero-01"]!.Harvester = 3;
    endWave(s);
    expect(s.minionParts["hero-01"]).toBe(6);
  });

  it("Body Harvester (rank 1) on hero-02 grants +2 to hero-02 only", () => {
    const s = freshState();
    s.equipmentRanks["hero-02"]!.Harvester = 1;
    const beforeOther = s.minionParts["hero-01"] ?? 0;
    endWave(s);
    expect(s.minionParts["hero-02"]).toBe(2);
    expect(s.minionParts["hero-01"] ?? 0).toBe(beforeOther);
  });

  it("BOTH delvers own their suit's Harvester → independent +2 each", () => {
    const s = freshState();
    s.equipmentRanks["hero-01"]!.Harvester = 1;
    s.equipmentRanks["hero-02"]!.Harvester = 1;
    endWave(s);
    expect(s.minionParts["hero-01"]).toBe(2);
    expect(s.minionParts["hero-02"]).toBe(2);
  });

  it("counts STACK on top of existing minion parts (not reset to amount)", () => {
    const s = freshState();
    s.minionParts["hero-01"] = 5;
    s.equipmentRanks["hero-01"]!.Harvester = 1;
    endWave(s);
    expect(s.minionParts["hero-01"]).toBe(7);
  });

  it("rank 0 (not owned) does NOT fire", () => {
    const s = freshState();
    // newCampaign initialises every equipment type to rank 0; ensure
    // that explicit 0 does NOT get walked.
    s.equipmentRanks["hero-01"]!.Harvester = 0;
    endWave(s);
    expect(s.minionParts["hero-01"] ?? 0).toBe(0);
  });
});

// --- dead-delver skip --------------------------------------------------

describe("End Wave — dead delver skip", () => {
  it("Harvester bearer at currentHp = 0 does NOT grant", () => {
    const s = freshState();
    s.equipmentRanks["hero-01"]!.Harvester = 1;
    s.loadouts["hero-01"]!.currentHp = 0;
    endWave(s, "defeat");
    expect(s.minionParts["hero-01"] ?? 0).toBe(0);
  });

  it("Harvester bearer at currentHp < 0 does NOT grant (defensive)", () => {
    const s = freshState();
    s.equipmentRanks["hero-01"]!.Harvester = 1;
    s.loadouts["hero-01"]!.currentHp = -2;
    endWave(s, "defeat");
    expect(s.minionParts["hero-01"] ?? 0).toBe(0);
  });

  it("dead bearer is skipped but the OTHER delver's Harvester still fires", () => {
    const s = freshState();
    s.equipmentRanks["hero-01"]!.Harvester = 1;
    s.equipmentRanks["hero-02"]!.Harvester = 1;
    s.loadouts["hero-01"]!.currentHp = 0;
    endWave(s, "defeat");
    expect(s.minionParts["hero-01"] ?? 0).toBe(0);
    expect(s.minionParts["hero-02"]).toBe(2);
  });

  it("a LIVING bearer is paid on a defeat (designer decision 2026-11-17)", () => {
    const s = freshState();
    s.equipmentRanks["hero-02"]!.Harvester = 1;
    s.loadouts["hero-01"]!.currentHp = 0; // the wave was lost
    endWave(s, "defeat");
    expect(s.minionParts["hero-02"]).toBe(2);
    expect(s.encounter!.endWaveRefresh!.harvesterGrants).toEqual([
      expect.objectContaining({ heroId: "hero-02", cardId: HARVESTER_BODY }),
    ]);
  });
});

// --- idempotency + multi-wave -----------------------------------

describe("End Wave — idempotency + multi-wave", () => {
  it("a second enterEndOfWave in the same wave does NOT double-grant", () => {
    const s = freshState();
    s.equipmentRanks["hero-01"]!.Harvester = 1;
    endWave(s);
    expect(s.minionParts["hero-01"]).toBe(2);
    endWave(s);
    expect(s.minionParts["hero-01"]).toBe(2);
  });

  it("the next wave's end DOES grant again", () => {
    const s = freshState();
    s.equipmentRanks["hero-01"]!.Harvester = 1;
    endWave(s);
    expect(s.minionParts["hero-01"]).toBe(2);
    nextWave(s);
    endWave(s);
    expect(s.minionParts["hero-01"]).toBe(4);
  });

  it("mid-quest acquisition: rank 0 → 1 between waves fires from the NEXT wave end", () => {
    const s = freshState();
    endWave(s);
    expect(s.minionParts["hero-01"] ?? 0).toBe(0);
    s.equipmentRanks["hero-01"]!.Harvester = 1;
    nextWave(s);
    endWave(s);
    expect(s.minionParts["hero-01"]).toBe(2);
  });
});

// --- interaction with the "if continuing" effects ----------------

describe("End Wave — Harvester vs Armor timing", () => {
  it("Harvester pays at End Wave; Armor heals only when continuing to the next wave", () => {
    const s = freshState();
    s.loadouts["hero-02"]!.currentHp = s.loadouts["hero-02"]!.maxHp - 1;
    s.equipmentRanks["hero-02"]!.Harvester = 1;
    const beforeHp = s.loadouts["hero-02"]!.currentHp;

    endWave(s);
    expect(s.minionParts["hero-02"]).toBe(2);                     // Harvester +2
    expect(s.loadouts["hero-02"]!.currentHp).toBe(beforeHp);      // no heal yet

    const events = applyContinuingEndWaveEffects(s);
    expect(s.loadouts["hero-02"]!.currentHp).toBe(beforeHp + 1);  // Armor +1
    expect(events.some((e) => e.kind === "wave-effect" && e.text.includes("heals 1 HP"))).toBe(true);
  });
});
