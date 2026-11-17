/**
 * Debug "Quick Start Chapter N": the simulated campaign must reach the
 * start of the requested chapter through the real engine, for any seed.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { simulateCampaignTo } from "../debug/quickStart";
import { mulberry32 } from "../qa/seededRandom";
import { checkAllInvariants } from "../qa/invariants";
import { SCHEMA_VERSION, type CampaignState } from "../state";

const SEEDS = [1, 2, 3, 7, 42, 99, 1234, 31337];

/** The engine itself also rolls with Math.random (deck shuffles etc.),
 *  so route it through the same seeded RNG to keep each case replayable. */
function seeded(seed: number): () => number {
  const rng = mulberry32(seed);
  vi.spyOn(Math, "random").mockImplementation(rng);
  return rng;
}
afterEach(() => { vi.restoreAllMocks(); });

function commonChecks(s: CampaignState, maxLeftoverParts = Infinity): void {
  expect(s.version).toBe(SCHEMA_VERSION);
  expect(s.encounter).toBeNull();
  expect(s.currentScenarioCard ?? null).toBeNull();
  expect(s.pendingSuitConditionPicks).toEqual([]);
  expect(s.pendingAcademyDonationResolution ?? null).toBeNull();
  expect(checkAllInvariants(s)).toEqual([]);
  // A save must survive a JSON round-trip unchanged.
  expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  for (const h of Object.keys(s.loadouts)) {
    expect(s.minionParts[h] ?? 0).toBeGreaterThanOrEqual(0);
    expect(s.minionParts[h] ?? 0).toBeLessThanOrEqual(maxLeftoverParts);
  }
}

describe("simulateCampaignTo", () => {
  for (const seed of SEEDS) {
    it(`chapter 2, seed ${seed}`, () => {
      const s = simulateCampaignTo(2, seeded(seed));
      commonChecks(s, 2); // the Ch1 shop is the last thing played
      expect(s.townVisit1Completed).toBe(true);
      expect(s.townVisit2Completed).toBe(false);
      expect(s.townVisit).toBeNull();
      expect(s.currentQuestId).toBe("quest2");
    });

    it(`chapter 3, seed ${seed}`, () => {
      const s = simulateCampaignTo(3, seeded(seed));
      commonChecks(s, 2); // the Ch2 shop is the last thing played
      expect(s.townVisit2Completed).toBe(true);
      expect(s.townVisit3Completed).toBe(false);
      expect(s.townVisit?.chapterId).toBe("ch3");
      // Key Item #1 is handed to Father Flores during the Ch2 visit.
      expect(s.keyItems.map((k) => k.number)).toContain(2);
    });

    it(`chapter 4, seed ${seed}`, () => {
      const s = simulateCampaignTo(4, seeded(seed));
      commonChecks(s); // Ch3 quest-report quests can pay out after the shop
      expect(s.townVisit3Completed).toBe(true);
      expect(s.townVisit?.chapterId).toBe("ch4");
    });
  }
});
