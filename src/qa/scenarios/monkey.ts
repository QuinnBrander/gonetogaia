/**
 * Monkey scenario — drives the game through Ch1 + Ch2 visits
 * making RANDOM valid choices each step. Reproducibility comes
 * from the seeded RNG on the session (every call to
 * `session.rng()` advances the same Mulberry32 stream).
 *
 * What "monkey" means in practice:
 *   - On a choice page, pick one of `choices` at random.
 *   - On a linear page, sometimes advance, sometimes try a noisy
 *     side-action (donate a random amount, try to redeem an
 *     opinion card the player may not own — see `expectThrow`
 *     usage in `session.ts`) before advancing.
 *   - In the Shop / between pages, occasionally try a random
 *     shop product number (most will be `not-available` — the
 *     session swallows the rejection but still records the
 *     trace entry, which is useful coverage).
 *
 * Why this catches bugs the happy path misses:
 *   - Out-of-order interactions (donate before / after visiting
 *     Tower Square).
 *   - Repeated redemptions (Vera twice in one visit).
 *   - Donation amounts that exactly equal the wallet vs. just
 *     under / over.
 *   - State that's only reachable when you take an unusual path
 *     through the chapter graph.
 *
 * Reproducer: a failing monkey run prints `seed=N` — re-run
 * `npm run qa -- --scenario=monkey --seed=N` to replay.
 */

import type { QaSession } from "../session";
import { coinFlip, pickOne, randInt } from "../seededRandom";
import type { Scenario } from "./types";
import { MAX_STEPS } from "./types";

/** Probability the monkey runs a "side-action" instead of just
 *  advancing on a linear page. Bumped to 0.3 because pure
 *  page-advances are the LEAST interesting actions — the
 *  point of monkey is to chaos-test the side surfaces. */
const SIDE_ACTION_PROB = 0.3;

function maybeSideAction(session: QaSession): void {
  if (!coinFlip(session.rng, SIDE_ACTION_PROB)) return;
  const choice = randInt(session.rng, 0, 5);
  switch (choice) {
    case 0: {
      // Random donation, often invalid. We expect the engine to
      // reject `invalid-amount` / `insufficient-minion-parts`
      // cleanly — the harness swallows the rejection so the
      // monkey can keep going.
      const heroIds = Object.keys(session.state.minionParts);
      if (heroIds.length === 0) return;
      const heroId = pickOne(session.rng, heroIds);
      const amount = randInt(session.rng, 1, 10);
      // Pre-check so we only expectThrow when the engine WILL
      // throw — otherwise an unexpected success would still log
      // a trace entry but the next throw would also be eaten,
      // and we'd lose a real bug.
      const wallet = session.state.minionParts[heroId] ?? 0;
      const hasVisit = session.state.townVisit !== null;
      if (!hasVisit || wallet < amount) {
        session.expectThrow("monkey may try to over-donate / donate-outside-visit");
      }
      session.donate(heroId, amount);
      return;
    }
    case 1: {
      // Try to redeem Vera. Expect throw most of the time
      // (already spent, not owned, no visit) — that's fine.
      session.expectThrow("monkey may redeem vera when not eligible");
      session.redeemVera("hero-01");
      return;
    }
    case 2: {
      session.expectThrow("monkey may redeem flores when not eligible");
      session.redeemFlores();
      return;
    }
    case 3: {
      session.expectThrow("monkey may redeem elayna when not eligible");
      session.redeemElayna();
      return;
    }
    case 4: {
      // Try a random shop product purchase — usually rejected.
      const heroIds = Object.keys(session.state.shopProductsOwned);
      if (heroIds.length === 0) return;
      const heroId = pickOne(session.rng, heroIds);
      const productNumber = randInt(session.rng, 1, 12);
      session.expectThrow("monkey may buy random / unavailable product");
      session.buy(heroId, productNumber);
      return;
    }
    default:
      return;
  }
}

/** See happyPath.ts for rationale. Mirrored here so monkey runs
 *  are protected from cycles by the same policy. */
const MAX_PAGE_REVISITS = 12;

function monkeyWalkChapter(session: QaSession, chapterId: "ch1" | "ch2"): void {
  session.startTownVisit(chapterId);
  let actions = 1;
  const visitCount = new Map<string, number>();
  while (actions < MAX_STEPS) {
    const pageId = session.currentPageId();
    if (pageId === null) break;
    const seen = (visitCount.get(pageId) ?? 0) + 1;
    visitCount.set(pageId, seen);
    if (seen > MAX_PAGE_REVISITS) {
      session.checkpoint(`monkey-walker — bail (page \`${pageId}\` revisited ${seen}x)`);
      break;
    }
    session.applyOnEnter();
    actions++;
    maybeSideAction(session);
    actions++;
    const choices = session.currentChoiceKeys();
    if (choices.length > 0) {
      const key = pickOne(session.rng, choices);
      session.choose(key);
      actions++;
    } else if (session.currentPageHasNext()) {
      session.advancePage();
      actions++;
    } else {
      break;
    }
  }
}

export const monkeyScenario: Scenario = {
  name: "monkey",
  description: "Seeded random walk of Ch1 + Ch2 with noisy side-actions.",
  run(session) {
    session.checkpoint("ch1 — start");
    monkeyWalkChapter(session, "ch1");
    if (session.state.townVisit) session.finishTownVisit();
    session.checkpoint("ch1 — done");

    // Bridge into Q2.
    session.state.quest1Completed = true;
    session.state.currentQuestId = "quest2";
    session.applyQuestOpinionGrants("quest2");

    session.checkpoint("ch2 — start");
    monkeyWalkChapter(session, "ch2");
    if (session.state.townVisit) session.finishTownVisit();
    session.checkpoint("ch2 — done");
  },
};
