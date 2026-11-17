/**
 * Combat mover scenario — bootstrap Q2 W1 and hand-drive the
 * hero loop with a tactical AI that walks toward enemies before
 * swinging. Closes the Phase 3 gap where `combat-brute` /
 * `combat-monkey` stayed rooted on the spawn tile.
 *
 * Per-turn algorithm (active delver):
 *   1. Place a weapon (first playable; required first step).
 *      If the placed weapon is `single-adjacent`:
 *      a. If an adjacent enemy exists, swing immediately.
 *      b. Else, step toward the nearest enemy until MP exhausts
 *         OR the delver becomes adjacent. After stepping, swing
 *         if newly adjacent.
 *      `endMovementStep` is called when we voluntarily stop
 *      stepping (so we don't strand `movementUsedThisTurn`).
 *   2. End the turn.
 *
 * Coverage delta vs. `combat-brute`:
 *   - Real `moveDelverStep` calls — exercises `legalStepDestinations`
 *     + the 8-way adjacency + `tileDrops` claim path.
 *   - Real `endMovementStep` calls — exercises the explicit
 *     "I'm done moving" latch.
 *   - Lands attacks against enemies that didn't happen to spawn
 *     adjacent to the delver's compass tile (most boards).
 *
 * The mover doesn't (yet) spend AP on double-movement or
 * refresh — that's the `combat-token-spender` scenario's job.
 */

import type { QaSession } from "../session";
import type { Scenario } from "./types";

const MAX_HERO_TURNS = 60;
const MAX_STEPS_PER_TURN = 6;

function tryMoveTowardNearestEnemy(session: QaSession, heroId: string): boolean {
  let stepped = false;
  for (let step = 0; step < MAX_STEPS_PER_TURN; step++) {
    const target = session.nearestLiveEnemy(heroId);
    if (!target) {
      if (stepped) session.endMovementStep(heroId);
      return stepped;
    }
    // Already adjacent → stop walking. Only latch
    // `endMovementStep` if we ACTUALLY moved this turn; calling
    // it preemptively with `movementStepsThisTurn === 0` would
    // forfeit the entire movement budget (every subsequent
    // `legalStepDestinations` returns []) and starve the
    // fallback step below.
    if (Math.max(Math.abs(target.dx), Math.abs(target.dy)) <= 1) {
      if (stepped) session.endMovementStep(heroId);
      return stepped;
    }
    const next = session.bestStepToward(heroId, target.x, target.y);
    if (!next) {
      if (stepped) session.endMovementStep(heroId);
      return stepped;
    }
    const result = session.moveStep(heroId, next.x, next.y);
    if (!result.ok) {
      session.checkpoint(`mover — moveStep rejected ${heroId} → (${next.x},${next.y}): ${result.reason}`);
      if (stepped) session.endMovementStep(heroId);
      return stepped;
    }
    stepped = true;
    if (result.sessionEnded) return true; // MP exhausted, auto-latched
  }
  if (stepped) session.endMovementStep(heroId);
  return stepped;
}

/** Last-resort movement to guarantee `moveDelverStep` coverage:
 *  even when the placed weapon isn't single-adjacent (so we
 *  can't attack from any tile), take 1 legal step away from
 *  the spawn so the engine's movement path is exercised. The
 *  step direction is picked deterministically — the first
 *  legal destination in `legalStepDestinations`'s 8-way
 *  iteration order. */
function takeOneStepIfAble(session: QaSession, heroId: string): void {
  const dests = session.legalMovementTiles(heroId);
  if (dests.length === 0) return;
  const dest = dests[0]!;
  const result = session.moveStep(heroId, dest.x, dest.y);
  if (!result.ok) {
    session.checkpoint(`mover — fallback moveStep rejected: ${result.reason}`);
    return;
  }
  if (!result.sessionEnded) {
    session.endMovementStep(heroId);
  }
}

function tryAttackAdjacent(session: QaSession, heroId: string): boolean {
  const enc = session.state.encounter;
  if (!enc) return false;
  const ts = enc.turnState[heroId];
  if (!ts || !ts.cardPlacedThisTurn) return false;
  const slotIdx = ts.cardPlacedThisTurn.slotIdx;
  if (session.placedWeaponRangeKind(heroId, slotIdx) !== "single-adjacent") return false;
  const target = session.adjacentLiveEnemy(heroId);
  if (!target) return false;
  const swing = session.useWeaponAbility(heroId, slotIdx, {
    kind: "single-adjacent",
    targetX: target.x,
    targetY: target.y,
  });
  if (!swing.ok) {
    session.checkpoint(`mover — useWeaponAbility rejected: ${swing.reason}`);
    return false;
  }
  session.resolveAttackSession(swing.session, 5);
  return true;
}

export const combatMoverScenario: Scenario = {
  name: "combat-mover",
  description: "Walk toward nearest enemy before swinging; exercises movement engine + tile drops.",
  run(session) {
    session.state.quest1Completed = true;
    session.state.currentQuestId = "quest2";

    session.checkpoint("mover — bootstrap Q2 W1");
    session.bootstrapWave("quest2", 1);
    session.drainOpinionPicks();
    session.autoPlaceSpawns();
    session.startWaveAfterPick();
    session.checkpoint("mover — hero phase begins");

    let turn = 0;
    while (turn++ < MAX_HERO_TURNS) {
      const enc = session.state.encounter;
      if (!enc) break;
      if (enc.phase !== "hero") break;
      const active = session.state.currentDelverId;

      if (!enc.preparedToRun[active]) {
        const placed = session.firstPlayableWeapon(active);
        if (placed) {
          const placeRes = session.playWeapon(active, placed.slotIdx, placed.cardId);
          if (placeRes.ok) {
            // Movement → attack sequencing matters: if we're
            // already adjacent, swing FIRST so the action gate
            // doesn't kill the movement session (per
            // `endMovementSessionIfActionInterruptsIt` —
            // attacking while a movement session is in-progress
            // forfeits remaining MP). Adjacent on placement →
            // no walking → no forfeiture issue.
            if (!tryAttackAdjacent(session, active)) {
              tryMoveTowardNearestEnemy(session, active);
              if (!tryAttackAdjacent(session, active)) {
                // No swing this turn (placed weapon isn't
                // `single-adjacent`, OR target moved out of
                // range). Still want to exercise the movement
                // engine — take 1 fallback step.
                takeOneStepIfAble(session, active);
              }
            }
          }
        }
      }
      session.endHeroTurn();
      session.drainPendingModals();
    }
    session.checkpoint(`mover — hero loop exited after ${turn - 1} turns, phase=${session.state.encounter?.phase ?? "null"}`);

    if (session.state.encounter?.phase === "parting-shots") {
      session.resolveAllPartingShots();
    }
    if (session.state.encounter?.phase === "end-of-wave") {
      session.completeWave();
    }
    session.checkpoint(`mover — done, encounter=${session.state.encounter ? "alive" : "cleared"}`);
  },
};
