/**
 * Quest 2 full-run scenario — bootstrap Q2 W1 → W2 → W3 with
 * `debugWinWave` auto-resolving each wave, then enter the
 * Chapter 2 town visit and complete it.
 *
 * Coverage:
 *   - Wave bootstrap (`bootstrapWaveAtNumber`), which fires
 *     `applyShopGrantsForQuest`, `applyShopGrantsForWave`, and
 *     `applyOpinionGrantsForQuest` as side-effects.
 *   - Spawn-pick phase (`delver-spawn-pick`): every Q2 wave
 *     starts here; the harness auto-places delvers + Witness
 *     on the drawn spawn card's printed compass tiles.
 *   - Delver phase → parting shots → end-of-wave → completed
 *     transitions (via `debugWinWave` shortcut, which still
 *     routes through the normal `applyKill` / parting-shot /
 *     End Wave pipelines).
 *   - Multi-wave progression: complete W1, bootstrap W2,
 *     complete W2, continue to W3, complete W3.
 *   - Q2 key-item grants (Surveillance Camera on W2 victory,
 *     Abandoned Syringe on W3 victory).
 *   - `endQuestReset` clears per-quest scratch state.
 *   - Chapter 2 town visit walk.
 *
 * The scenario plays the VICTORY path on every wave because
 * defeat short-circuits the W2 → W3 progression (W2 defeat goes
 * straight to "Quest #2 complete" per the storybook). A future
 * `quest2-defeat` scenario can flip an HP to 0 before
 * `debugWinWave` to exercise the defeat branches.
 */

import type { QaSession } from "../session";
import type { Scenario } from "./types";
import { MAX_STEPS } from "./types";

const MAX_PAGE_REVISITS = 8;

function walkCh2(session: QaSession): void {
  // ch2 has its own start page id — `startTownVisit` reads
  // the chapter's `startPageId` field directly.
  session.startTownVisit("ch2");
  let actions = 1;
  const visitCount = new Map<string, number>();
  while (actions < MAX_STEPS) {
    const pageId = session.currentPageId();
    if (pageId === null) break;
    const seen = (visitCount.get(pageId) ?? 0) + 1;
    visitCount.set(pageId, seen);
    if (seen > MAX_PAGE_REVISITS) {
      session.checkpoint(`q2-fullrun walker — bail (page \`${pageId}\` revisited ${seen}x)`);
      break;
    }
    session.applyOnEnter();
    actions++;
    const choices = session.currentChoiceKeys();
    if (choices.length > 0) {
      session.choose(choices[0]!);
      actions++;
    } else if (session.currentPageHasNext()) {
      session.advancePage();
      actions++;
    } else {
      break;
    }
  }
}

/** Run one Q2 wave end-to-end via the debug shortcut. Mirrors
 *  the screen's Delver → Parting Shots → End Wave button
 *  sequence. Waves after the first are reached by continuing
 *  (`continueToWave`), which also applies the End Wave
 *  "if continuing" effects. */
function playWaveViaDebug(session: QaSession, questId: string, waveNumber: number): void {
  session.checkpoint(`q2 w${waveNumber} — bootstrap`);
  if (waveNumber === 1) session.bootstrapWave(questId, waveNumber);
  else session.continueToWave(questId, waveNumber);
  session.drainOpinionPicks();
  session.autoPlaceSpawns();
  session.startWaveAfterPick();
  session.checkpoint(`q2 w${waveNumber} — hero phase begins`);
  session.winWaveViaDebug();
  session.resolveAllPartingShots();
  session.checkpoint(`q2 w${waveNumber} — end-of-wave reached`);
}

export const quest2FullrunScenario: Scenario = {
  name: "quest2-fullrun",
  description: "Bootstrap Q2 W1→W2→W3 via debugWinWave, then walk Ch2 town visit.",
  run(session) {
    // Pre-conditions: skip the Q1 + Ch1 setup, mark Q1
    // complete, point currentQuestId at Q2. The harness's
    // `bootstrapWave` calls `applyShopGrantsForQuest` /
    // `applyOpinionGrantsForQuest` for us — no need to call
    // them manually.
    session.state.quest1Completed = true;
    session.state.currentQuestId = "quest2";

    // Wave 1 — no key-item grant on completion, just bootstrap
    // the next wave.
    playWaveViaDebug(session, "quest2", 1);
    session.completeWave();
    session.checkpoint("q2 w1 — completed");

    // Wave 2 — completion grants Surveillance Camera (Key #1).
    playWaveViaDebug(session, "quest2", 2);
    session.grantQuest2KeyItem(1);
    session.completeWave();
    session.checkpoint("q2 w2 — completed + key item 1");

    // Wave 3 — completion grants Abandoned Syringe (Key #2)
    // + ends the quest.
    playWaveViaDebug(session, "quest2", 3);
    session.grantQuest2KeyItem(2);
    session.completeWave();
    session.endQuestReset();
    session.checkpoint("q2 w3 — completed + key item 2 + quest reset");

    // Chapter 2 town visit. With both key items in the bag, the
    // chapter's `add-shop-products-if-key-items-min` gates open
    // up the donation + premium products.
    walkCh2(session);
    if (session.state.townVisit) session.finishTownVisit();
    session.checkpoint("ch2 — done");
  },
};
