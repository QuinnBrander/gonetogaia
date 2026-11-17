/**
 * Combat brute scenario — bootstrap Q2 W1 and hand-drive the
 * hero turn loop with a primitive AI that prefers melee swings.
 *
 * Per-turn algorithm (active delver):
 *   1. If a `single-adjacent` weapon is in hand AND there is a
 *      live enemy 8-way-adjacent — play that weapon into an
 *      empty slot and swing at the enemy.
 *   2. Else, play whatever weapon is in hand (any range kind)
 *      to satisfy the mandatory turn-start placement; do NOT
 *      attack (we don't model die-roll / pattern targeting in
 *      this scenario).
 *   3. End the turn. Modal queues (level-up, element, eq-roll)
 *      drain after every turn so a kill mid-attack doesn't
 *      strand the next placement on a pending pick.
 *
 * The loop bails when either of:
 *   - `state.encounter` is null (wave completed, end-of-wave
 *     resolved, etc.), OR
 *   - both delvers have latched preparedToRun (auto-fired by
 *     `startHeroTurn` when no playable weapons remain), OR
 *   - the per-wave hero-turn cap is exceeded (defensive — a
 *     never-terminating wave is itself a bug, but the cap
 *     keeps the harness from spinning).
 *
 * Coverage delta vs. `quest2-fullrun`:
 *   - Real `playWeaponCard` + `useWeaponAbility` calls instead
 *     of the `debugWinWave` shortcut.
 *   - Real `resolveAllDamage` + `resolveSharedCounter` +
 *     `finalizeAttackSession` (with a fixed counter roll of 5
 *     = "miss" so the harness doesn't take counter damage).
 *   - Real `endHeroTurn` flipping + `maybeEnterPartingShots`
 *     gate.
 *   - Real pending-modal drain (level-up triggered by killing
 *     enemies → pending draws → element choices → eq-rolls).
 */

import type { QaSession } from "../session";
import type { Scenario } from "./types";

const MAX_HERO_TURNS = 60;

function tryAttackAdjacent(session: QaSession, heroId: string): boolean {
  // The placed weapon's slot is whatever we just played into.
  // The active delver's turn state remembers it.
  const enc = session.state.encounter;
  if (!enc) return false;
  const ts = enc.turnState[heroId];
  if (!ts || !ts.cardPlacedThisTurn) return false;
  const slotIdx = ts.cardPlacedThisTurn.slotIdx;
  const kind = session.placedWeaponRangeKind(heroId, slotIdx);
  if (kind !== "single-adjacent") return false;
  const target = session.adjacentLiveEnemy(heroId);
  if (!target) return false;

  // Mace requires either an undamaged target OR a spent
  // element. We don't track the bag here — if the bearer has
  // any elements they could be spent, but for v1 we just try
  // the default-filter path and let the engine reject Mace-on-
  // damaged-target cleanly (the scenario records the reject
  // and moves on without attacking, satisfying placement
  // alone).
  const swing = session.useWeaponAbility(heroId, slotIdx, {
    kind: "single-adjacent",
    targetX: target.x,
    targetY: target.y,
  });
  if (!swing.ok) {
    session.checkpoint(`brute — useWeaponAbility rejected: ${swing.reason}`);
    return false;
  }
  session.resolveAttackSession(swing.session, 5);
  return true;
}

function playFirstWeapon(session: QaSession, heroId: string): boolean {
  const pick = session.firstPlayableWeapon(heroId);
  if (!pick) return false;
  const res = session.playWeapon(heroId, pick.slotIdx, pick.cardId);
  if (!res.ok) {
    session.checkpoint(`brute — playWeapon rejected ${pick.cardId}@${pick.slotIdx}: ${res.reason}`);
    return false;
  }
  return true;
}

export const combatBruteScenario: Scenario = {
  name: "combat-brute",
  description: "Hand-drive Q2 W1 hero turns: place a card, swing at adjacent enemies.",
  run(session) {
    session.state.quest1Completed = true;
    session.state.currentQuestId = "quest2";

    session.checkpoint("brute — bootstrap Q2 W1");
    session.bootstrapWave("quest2", 1);
    session.drainOpinionPicks();
    session.autoPlaceSpawns();
    session.startWaveAfterPick();
    session.checkpoint("brute — hero phase begins");

    let turn = 0;
    while (turn++ < MAX_HERO_TURNS) {
      const enc = session.state.encounter;
      if (!enc) break;
      if (enc.phase !== "hero") break;
      const active = session.state.currentDelverId;

      // If startHeroTurn auto-latched preparedToRun for the
      // active delver (out of playable weapons), the only
      // legal action is endHeroTurn — placement and attacks
      // are both gated.
      const preparedActive = enc.preparedToRun[active] === true;
      if (!preparedActive) {
        // Try the placement path first; if no weapon is in
        // hand (defensive), we still call endHeroTurn so the
        // loop terminates.
        playFirstWeapon(session, active);
        tryAttackAdjacent(session, active);
      }
      session.endHeroTurn();
      session.drainPendingModals();
    }
    session.checkpoint(`brute — hero loop exited after ${turn - 1} turns, phase=${session.state.encounter?.phase ?? "null"}`);

    // Whichever way the loop exited, walk the standard wave
    // teardown so end-of-wave / completed transitions get
    // exercised. Each call is idempotent / no-op when the
    // encounter is already past that phase.
    if (session.state.encounter && session.state.encounter.phase === "parting-shots") {
      session.resolveAllPartingShots();
    }
    if (session.state.encounter && session.state.encounter.phase === "end-of-wave") {
      session.completeWave();
    }
    session.checkpoint(`brute — done, encounter=${session.state.encounter ? "alive" : "cleared"}`);
  },
};
