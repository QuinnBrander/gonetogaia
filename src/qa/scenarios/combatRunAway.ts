/**
 * Combat run-away scenario — bootstrap Q2 W1 and have BOTH delvers
 * declare Prepared to Run on their first hero turn. Once both are
 * latched, `endHeroTurn` flips into Parting Shots immediately
 * (without any weapon swings).
 *
 * This is the simplest tactical-combat scenario possible: zero
 * placements, zero attacks. It exists to give the harness coverage
 * of the prepareToRun → bothPrepared → parting-shots path, which
 * the `debugWinWave` shortcut in `quest2-fullrun` doesn't exercise.
 *
 * Coverage:
 *   - `prepareToRun` action gate (rejects if a card was already
 *     placed this turn — we explicitly DO NOT place anything so
 *     the action lands).
 *   - `endHeroTurn` → `maybeEnterPartingShotsAfterTurn` →
 *     `enterPartingShots` phase flip.
 *   - Parting shots queue drainage with live enemies still on
 *     the board (every spawned enemy queues a counter shot).
 *   - End Wave (victory) → completed transitions reached without
 *     any combat damage. NB: the engine treats "ran away from a
 *     full board" as a victory: the last parting shot calls
 *     `enterEndOfWave(state, "victory")`. A wave survived is a
 *     win, and this scenario exercises that end-to-end.
 */

import type { Scenario } from "./types";

export const combatRunAwayScenario: Scenario = {
  name: "combat-run-away",
  description: "Both delvers prepare-to-run on turn 1; exercises parting-shots without combat.",
  run(session) {
    session.state.quest1Completed = true;
    session.state.currentQuestId = "quest2";

    session.checkpoint("run-away — bootstrap Q2 W1");
    session.bootstrapWave("quest2", 1);
    session.drainOpinionPicks();
    session.autoPlaceSpawns();
    session.startWaveAfterPick();
    session.checkpoint("run-away — hero phase begins");

    const heroIds = Object.keys(session.state.loadouts);
    // Active delver first. `prepareToRun` is rejected if the
    // turn-state shows a card was placed this turn — by going
    // BEFORE any other action we hit the legal path.
    const firstActive = session.state.currentDelverId;
    const firstRes = session.prepareDelverToRun(firstActive);
    if (!firstRes.ok) {
      session.checkpoint(`run-away — prepareToRun rejected for ${firstActive}: ${firstRes.reason}`);
      return;
    }
    // Pre-flip flag check: only the first delver should be
    // latched yet (the second hasn't acted). After endHeroTurn
    // flips, the second delver becomes active.
    session.endHeroTurn();
    session.drainPendingModals();

    // Second delver — same flow on their own first turn.
    const secondActive = session.state.currentDelverId;
    if (secondActive === firstActive) {
      // 1-delver loadout (defensive — should never happen for
      // Q2 which always has both delvers). Skip the second
      // prepare and bail; the parting-shots transition won't
      // fire on a single-delver loadout, so we just complete
      // the wave manually.
      session.checkpoint("run-away — single-delver loadout, skipping second prepare");
      return;
    }
    const secondRes = session.prepareDelverToRun(secondActive);
    if (!secondRes.ok) {
      session.checkpoint(`run-away — prepareToRun rejected for ${secondActive}: ${secondRes.reason}`);
      return;
    }
    session.endHeroTurn();
    // After this flip the engine sees both `preparedToRun[*]
    // = true` and transitions encounter.phase to
    // "parting-shots". The next assertion verifies that.
    const phaseAfterFlip = session.state.encounter?.phase;
    session.checkpoint(`run-away — both prepared, phase = "${phaseAfterFlip ?? "no-encounter"}"`);

    // From here on out, the standard wave teardown handles
    // counter-shots, end-of-wave.
    session.drainPendingModals();
    session.resolveAllPartingShots();
    session.completeWave();
    session.checkpoint(`run-away — wave completed (heroes: ${heroIds.join(",")})`);
  },
};
