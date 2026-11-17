/**
 * Happy-path scenario — exercises every feature added in
 * Chapter 2 with deterministic, sensible choices. Designed to be
 * the "this should always pass" baseline; if it ever fails, the
 * project is in a broken state for normal play.
 *
 * Coverage:
 *   - Full Chapter 1 town visit (Pub -> Vera + Samantha) so the
 *     happy path naturally seeds Q2 with Samantha-Ally and
 *     Vera-something.
 *   - Quest 2 town visit (Chapter 2): visits Watchtower,
 *     Tower Square, spends story tokens, donates 10 minion parts
 *     to the Academy (large tier), redeems Vera's gift + the
 *     Flores discount.
 *   - Buys at least one shop product so wave-bonus + quest-bonus
 *     grants run.
 *
 * "Sensible" choices are picked by always taking the FIRST choice
 * key — happy path doesn't randomize. That gives us a fixed
 * golden trace we can diff against when triaging regressions.
 *
 * If a particular page's first choice doesn't exist (data drift),
 * the walker falls back to advancePage / break — better to
 * complete the run with reduced coverage than to throw and lose
 * the rest of the trace.
 */

import type { QaSession } from "../session";
import type { Scenario } from "./types";
import { MAX_STEPS } from "./types";

/** Max times the walker tolerates re-visiting the same page
 *  before bailing. Chapter 2's location hub legitimately gets
 *  re-entered 2-3 times (once per location); 8 leaves room for
 *  future expansion while still catching infinite cycles. */
const MAX_PAGE_REVISITS = 8;

/** Walk a chapter from `startTownVisit` until no further progress
 *  is possible. Returns the number of actions taken. Bounded by
 *  `MAX_STEPS` AND by per-page visit counts so a circular page
 *  graph can't hang the run. */
function walkChapter(session: QaSession, chapterId: "ch1" | "ch2"): number {
  session.startTownVisit(chapterId);
  let actionsTaken = 1;
  const visitCount = new Map<string, number>();
  while (actionsTaken < MAX_STEPS) {
    const pageId = session.currentPageId();
    if (pageId === null) break;
    const seen = (visitCount.get(pageId) ?? 0) + 1;
    visitCount.set(pageId, seen);
    if (seen > MAX_PAGE_REVISITS) {
      // The walker has revisited this page too many times —
      // almost certainly a cycle (either a real game bug or a
      // walker policy that doesn't know how to escape). Stop
      // and let the caller decide what to do.
      session.checkpoint(`walker — bail (page \`${pageId}\` revisited ${seen}x)`);
      break;
    }
    session.applyOnEnter();
    actionsTaken++;
    const choices = session.currentChoiceKeys();
    if (choices.length > 0) {
      // Deterministic: always take the first VISIBLE choice.
      // Keeps the golden trace stable across runs and makes
      // diffs legible.
      session.choose(choices[0]!);
      actionsTaken++;
    } else if (session.currentPageHasNext()) {
      session.advancePage();
      actionsTaken++;
    } else {
      // Terminal page — finish the visit + exit.
      break;
    }
  }
  return actionsTaken;
}

export const happyPathScenario: Scenario = {
  name: "happyPath",
  description: "Deterministic walk of Ch1 + Ch2 + key Opinion-Card + donation flows.",
  run(session) {
    // ----- Chapter 1 ----------------------------------------------------
    session.checkpoint("ch1 — start");
    walkChapter(session, "ch1");
    session.finishTownVisit();
    session.checkpoint("ch1 — done");

    // Mark Quest 1 complete + advance the campaign so the engine
    // treats us as ready for Q2 setup. We skip the Quest 1 + 2
    // wave combat because v1 of the harness focuses on town +
    // shop + opinion flows; combat coverage is a Phase-2 task.
    session.state.quest1Completed = true;
    session.state.currentQuestId = "quest2";

    // Apply Q2 opinion grants here (the screen does this when
    // Q2 boots; in the harness we call directly so Xavier picks
    // get enqueued + resolved before we open Ch2). The grants
    // only enqueue if there's an encounter — the happy path
    // doesn't bootstrap a Q2 encounter, so on this scripted
    // walk no picks are enqueued. The call is still a useful
    // smoke test of the idempotency latch.
    session.applyQuestOpinionGrants("quest2");
    session.checkpoint("q2 — opinion grants applied");

    // Resolve any picks the engine DID enqueue (defensive —
    // future scenarios may pre-bootstrap an encounter; this
    // loop keeps the walker generic).
    let safety = 0;
    while ((session.state.encounter?.pendingOpinionRankPicks.length ?? 0) > 0 && safety++ < 8) {
      const pick = session.state.encounter!.pendingOpinionRankPicks[0]!;
      // For unpinned picks (Ally / Detractor), assign to the
      // first delver. For pinned picks (Confidant), the engine
      // requires the pinned heroId — read it off the pick.
      const heroId = pick.heroId ?? Object.keys(session.state.loadouts)[0]!;
      const eligible = session.eligibleTypesForPick(pick.pickId, heroId);
      if (eligible.length === 0) break;
      session.applyOpinionPick(pick.pickId, heroId, eligible[0]!);
    }

    // ----- Chapter 2 ----------------------------------------------------
    session.checkpoint("ch2 — start");
    walkChapter(session, "ch2");

    // Before we end the visit, exercise the donation system end
    // to end if we still have parts + are at a non-terminal
    // page that allows it. Donations are valid any time during
    // a town visit; the resolution fires at `page34`.
    if (session.state.townVisit) {
      const heroes = Object.keys(session.state.minionParts);
      // Donate up to 5 parts per delver to hit the "large" tier
      // (10+ total) and exercise the multi-stat suit-condition
      // bonus path. Skips if the wallet can't afford it — the
      // happy path tolerates a thin wallet rather than throwing.
      for (const heroId of heroes) {
        const wallet = session.state.minionParts[heroId] ?? 0;
        const amount = Math.min(5, wallet);
        if (amount > 0) session.donate(heroId, amount);
      }
    }

    // Redeem Vera + Flores if owned. These are spot-checks
    // that the redemption path doesn't crash even when called
    // from a fully-walked visit.
    const hasVera = session.state.opinionCards.some((c) => c.characterId === "vera" && c.level === "ally");
    if (hasVera) {
      session.expectThrow("vera may already be spent");
      session.redeemVera("hero-01");
    }
    const hasFlores = session.state.opinionCards.some((c) => c.characterId === "flores" && c.level === "ally");
    if (hasFlores) {
      session.expectThrow("flores may already be spent");
      session.redeemFlores();
    }

    session.checkpoint("ch2 — done");
    if (session.state.townVisit) session.finishTownVisit();
  },
};
