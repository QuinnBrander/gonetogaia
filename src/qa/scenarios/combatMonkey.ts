/**
 * Combat monkey scenario — bootstrap Q2 W1 and drive the hero
 * turn loop with seeded random actions per turn.
 *
 * Per-turn action menu (active delver, weights sum to 1):
 *   - 0.25 prepareToRun — only legal as the FIRST action of the
 *     turn (rejected after a placement). Sticky for the wave.
 *   - 0.55 play a weapon (any range kind found in hand). If
 *     placed AND the weapon is `single-adjacent` AND there's a
 *     live adjacent enemy, swing at it 70% of the time.
 *   - 0.20 do nothing (just call endHeroTurn). Legal — the
 *     active delver just passes their turn.
 *
 * After the action, the turn ends and modals drain. The loop
 * bails on the same conditions as `combat-brute`:
 *   - encounter cleared / completed,
 *   - phase no longer `hero`,
 *   - hero-turn cap exceeded.
 *
 * Coverage delta vs. `combat-brute`:
 *   - Random `prepareToRun` mixed in with placements (exercises
 *     the per-wave latch propagation + late-prepare gating).
 *   - Random pass-the-turn turns (exercises endHeroTurn flips
 *     against a stale turn-state where nothing was placed).
 *   - Random counter rolls passed to `resolveAttackSession`
 *     (1..6) — exercises every counterAttackOutcomeForRoll
 *     bucket rather than always rolling "miss".
 *
 * Like the existing `monkey` scenario for town visits, the
 * seed parameter makes every run deterministic so a surfaced
 * bug can be reproduced exactly.
 */

import { mulberry32 } from "../seededRandom";
import type { QaSession } from "../session";
import type { Scenario } from "./types";

const MAX_HERO_TURNS = 80;

function pickWeighted<T>(rng: () => number, options: Array<[T, number]>): T {
  const r = rng();
  let acc = 0;
  for (const [val, w] of options) {
    acc += w;
    if (r < acc) return val;
  }
  return options[options.length - 1]![0]!;
}

function takeRandomAction(
  session: QaSession,
  rng: () => number,
  heroId: string,
): void {
  const enc = session.state.encounter;
  if (!enc) return;
  if (enc.preparedToRun[heroId]) return; // can't do anything
  const ts = enc.turnState[heroId];
  if (!ts) return;

  type Action = "prepare" | "play" | "pass";
  const action = pickWeighted<Action>(rng, [
    ["prepare", 0.25],
    ["play", 0.55],
    ["pass", 0.20],
  ]);

  if (action === "prepare") {
    session.prepareDelverToRun(heroId);
    return;
  }
  if (action === "pass") {
    return;
  }
  // "play" — place a weapon and maybe attack.
  const pick = session.firstPlayableWeapon(heroId);
  if (!pick) return;
  const res = session.playWeapon(heroId, pick.slotIdx, pick.cardId);
  if (!res.ok) return;
  // 70% chance to attack if we can.
  if (rng() > 0.70) return;
  const kind = session.placedWeaponRangeKind(heroId, pick.slotIdx);
  if (kind !== "single-adjacent") return;
  const target = session.adjacentLiveEnemy(heroId);
  if (!target) return;
  const swing = session.useWeaponAbility(heroId, pick.slotIdx, {
    kind: "single-adjacent",
    targetX: target.x,
    targetY: target.y,
  });
  if (!swing.ok) return;
  // Random counter roll 1..6 — exercises every bucket.
  const counterRoll = Math.floor(rng() * 6) + 1;
  session.resolveAttackSession(swing.session, counterRoll);
}

export const combatMonkeyScenario: Scenario = {
  name: "combat-monkey",
  description: "Seeded random hero-phase actions through Q2 W1.",
  run(session) {
    session.state.quest1Completed = true;
    session.state.currentQuestId = "quest2";

    session.checkpoint("combat-monkey — bootstrap Q2 W1");
    session.bootstrapWave("quest2", 1);
    session.drainOpinionPicks();
    session.autoPlaceSpawns();
    session.startWaveAfterPick();

    // Per-scenario rng so runs are reproducible from the seed
    // in the bug report. Splits off the session rng so the
    // shop / opinion grant noise doesn't shift our action
    // stream.
    const rng = mulberry32((session.rng() * 0xffffffff) >>> 0);

    let turn = 0;
    while (turn++ < MAX_HERO_TURNS) {
      const enc = session.state.encounter;
      if (!enc) break;
      if (enc.phase !== "hero") break;
      takeRandomAction(session, rng, session.state.currentDelverId);
      session.endHeroTurn();
      session.drainPendingModals();
    }
    session.checkpoint(`combat-monkey — hero loop exited after ${turn - 1} turns, phase=${session.state.encounter?.phase ?? "null"}`);

    if (session.state.encounter?.phase === "parting-shots") {
      session.resolveAllPartingShots();
    }
    if (session.state.encounter?.phase === "end-of-wave") {
      session.completeWave();
    }
    session.checkpoint(`combat-monkey — done, encounter=${session.state.encounter ? "alive" : "cleared"}`);
  },
};
