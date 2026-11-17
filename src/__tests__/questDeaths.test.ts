/**
 * Who died on the last quest (`state.lastQuestDeaths`) and the Town Visit
 * "did any delver die?" pages that branch on it instead of asking
 * (user request 2026-11-15).
 */
import { describe, expect, it } from "vitest";
import { migrateV63ToV64, newCampaign, type CampaignState } from "../state";
import { QUEST1, QUEST2 } from "../data";
import { ensureEncounter } from "../engine/encounter";
import { endQuestReset, enterEndOfWave, resetWaveForRetry } from "../engine/wave";
import { lastQuestDeathOutcome, startTownVisit, visibleTownVisitChoices } from "../engine/townVisit";

const noShuffle = (pool: readonly string[]) => [...pool];

function loseWave(s: CampaignState, dead: string[]): void {
  for (const id of dead) s.loadouts[id]!.currentHp = 0;
  enterEndOfWave(s, "defeat");
}

describe("lastQuestDeaths record", () => {
  it("is null on a fresh campaign, so the death gates stay open", () => {
    expect(lastQuestDeathOutcome(newCampaign())).toBeNull();
  });

  it("starts empty when a quest begins and reads 'none' with no deaths", () => {
    const s = newCampaign();
    ensureEncounter(s, QUEST1, noShuffle);
    expect(s.lastQuestDeaths).toEqual({ questId: "quest1", heroIds: [], ended: false });
    enterEndOfWave(s, "victory");
    endQuestReset(s);
    expect(lastQuestDeathOutcome(s)).toBe("none");
  });

  it("records exactly which delvers died", () => {
    for (const [dead, outcome] of [
      [["hero-01"], "mind-only"],
      [["hero-02"], "body-only"],
      [["hero-01", "hero-02"], "both"],
    ] as const) {
      const s = newCampaign();
      ensureEncounter(s, QUEST1, noShuffle);
      loseWave(s, [...dead]);
      endQuestReset(s);
      expect(lastQuestDeathOutcome(s)).toBe(outcome);
    }
  });

  it("keeps a death across a wave retry of the same quest", () => {
    const s = newCampaign();
    ensureEncounter(s, QUEST1, noShuffle);
    loseWave(s, ["hero-02"]);
    resetWaveForRetry(s);
    ensureEncounter(s, QUEST1, noShuffle);
    enterEndOfWave(s, "victory");
    endQuestReset(s);
    expect(lastQuestDeathOutcome(s)).toBe("body-only");
  });

  it("starts fresh for the next quest", () => {
    const s = newCampaign();
    ensureEncounter(s, QUEST1, noShuffle);
    loseWave(s, ["hero-01"]);
    endQuestReset(s);
    ensureEncounter(s, QUEST2, noShuffle);
    expect(s.lastQuestDeaths).toEqual({ questId: "quest2", heroIds: [], ended: false });
  });

  it("v63 -> v64 migration sets the record to null (unknown)", () => {
    const old = { ...newCampaign(), version: 63 } as Record<string, unknown>;
    delete old.lastQuestDeaths;
    const out = migrateV63ToV64(old)!;
    expect(out.version).toBe(64);
    expect(out.lastQuestDeaths).toBeNull();
  });
});

describe("Town Visit death pages branch on the last quest", () => {
  function atPage(chapter: "ch2" | "ch3" | "ch4", pageId: string, deaths: string[] | null): string[] {
    const s = newCampaign();
    s.lastQuestDeaths = deaths === null ? null : { questId: "q", heroIds: deaths, ended: true };
    startTownVisit(s, chapter);
    s.townVisit!.pageId = pageId;
    return visibleTownVisitChoices(s).map((c) => c.decisionKey);
  }

  it.each([
    ["ch2", "page22-entry", "ch2.entry"],
    ["ch3", "ch3-arrival", "ch3.arrival"],
    ["ch4", "ch4-arrival", "ch4.arrival"],
  ] as const)("%s arrival: survived vs died follows the record", (ch, page, key) => {
    expect(atPage(ch, page, [])).toEqual([`${key}.both-survived`]);
    expect(atPage(ch, page, ["hero-02"])).toEqual([`${key}.died`]);
    // Unknown (pre-v64 save): ask, as before.
    expect(atPage(ch, page, null)).toEqual([`${key}.both-survived`, `${key}.died`]);
  });

  it.each([
    ["ch2", "page22-died", "ch2.entry.died"],
    ["ch3", "ch3-died", "ch3.arrival.died"],
    ["ch4", "ch4-died", "ch4.arrival.died"],
  ] as const)("%s 'The Fallen': only the matching delver option shows", (ch, page, key) => {
    expect(atPage(ch, page, ["hero-01"])).toEqual([`${key}.mind`]);
    expect(atPage(ch, page, ["hero-02"])).toEqual([`${key}.body`]);
    expect(atPage(ch, page, ["hero-01", "hero-02"])).toEqual([`${key}.both`]);
  });
});
