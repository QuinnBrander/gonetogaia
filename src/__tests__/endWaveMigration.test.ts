/**
 * v64 -> v65 save migration: the Interlude Phase is gone (3-phase wave:
 * Delver, Parting Shots, End Wave — designer decision 2026-11-17).
 */

import { describe, it, expect } from "vitest";

import { migrateV64ToV65, newCampaign, type CampaignState } from "../state";
import { QUEST1 } from "../data";
import { ensureEncounter } from "../engine/encounter";
import { enterEndOfWave, nextPartingShotEnemy, resolvePartingShot } from "../engine/wave";

/** A v64 save whose encounter sits in the old `"interlude"` phase. */
function oldInterludeSave(applied: boolean): Record<string, unknown> {
  const s = newCampaign();
  ensureEncounter(s, QUEST1, (p) => [...p]);
  const raw = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
  raw.version = 64;
  const enc = raw.encounter as Record<string, unknown>;
  delete enc.endWaveRefresh;
  enc.phase = "interlude";
  enc.interludeApplied = applied;
  enc.interludeResult = applied
    ? { weaponsRefreshed: [{ heroId: "hero-01", count: 2 }], consumableTokensRefreshed: 1, passivesApplied: [], pendingElementChoicesEnqueued: 1, opinionPenalties: [] }
    : null;
  enc.pendingElementChoices = [
    { heroId: "hero-01", source: { kind: "interlude", cardId: "body-os-r1" } },
    { heroId: "hero-02", source: { kind: "scenario-card", cardNumber: 3 } },
  ];
  return raw;
}

describe("migrateV64ToV65", () => {
  it("parks an already-refreshed Interlude on Parting Shots and keeps its refresh, so End Wave won't redo it", () => {
    const out = migrateV64ToV65(oldInterludeSave(true))! as CampaignState;
    const enc = out.encounter!;
    expect(out.version).toBe(65);
    expect(enc.phase).toBe("parting-shots");
    expect(nextPartingShotEnemy(enc)).toBeNull();
    expect(enc.endWaveRefresh).toEqual({
      weaponsRefreshed: [{ heroId: "hero-01", count: 2 }],
      consumableTokensRefreshed: 1,
      harvesterGrants: [],
    });
    expect("interludeApplied" in enc).toBe(false);
    expect("interludeResult" in enc).toBe(false);
    // Old-timing Elemental OS picks are dropped; other picks stay.
    expect(enc.pendingElementChoices.map((c) => c.source.kind)).toEqual(["scenario-card"]);

    // Continue on the Parting Shots screen -> End Wave, without a second refresh.
    out.loadouts["hero-01"]!.slotCards[0] = "mind-hammer-r1";
    resolvePartingShot(out);
    expect(enc.phase).toBe("end-of-wave");
    expect(out.loadouts["hero-01"]!.slotCards[0]).toBe("mind-hammer-r1");
  });

  it("an Interlude that hadn't run yet gets the full End Wave refresh", () => {
    const out = migrateV64ToV65(oldInterludeSave(false))! as CampaignState;
    expect(out.encounter!.endWaveRefresh).toBeNull();
    out.loadouts["hero-01"]!.slotCards[0] = "mind-hammer-r1";
    resolvePartingShot(out);
    expect(out.encounter!.phase).toBe("end-of-wave");
    expect(out.loadouts["hero-01"]!.slotCards[0]).toBeNull();
  });

  it("an encounter in any other phase just gets the new field", () => {
    const raw = oldInterludeSave(false);
    const enc = raw.encounter as Record<string, unknown>;
    enc.phase = "hero";
    delete enc.interludeResult;
    const out = migrateV64ToV65(raw)! as CampaignState;
    expect(out.encounter!.phase).toBe("hero");
    expect(out.encounter!.endWaveRefresh).toBeNull();
    enterEndOfWave(out, "victory");
    expect(out.encounter!.endWaveRefresh).not.toBeNull();
  });

  it("a save with no encounter just bumps the version", () => {
    const raw = JSON.parse(JSON.stringify(newCampaign())) as Record<string, unknown>;
    raw.version = 64;
    expect(migrateV64ToV65(raw)!.version).toBe(65);
  });
});
