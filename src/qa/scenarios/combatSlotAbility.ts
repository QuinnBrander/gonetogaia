/**
 * Combat slot-ability scenario — exercises the alternative
 * "USE WEAPON ABILITY  OR  <slot ability>" branch by ALWAYS
 * firing the printed slot ability instead of the weapon's
 * range. Q2 W1 places weapons on slots whose printed abilities
 * span every kind:
 *   - `damage-any-enemy`  (mind slot 0, body slot 1)
 *   - `bonus-movement-this-turn` (mind slot 2, body slot 4)
 *   - `refresh-ap` (mind slot 3, body slot 5)
 *   - `gain-element` (mind slot 1/4/5, body slot 0/2/3)
 *
 * Per-turn algorithm (active delver):
 *   1. Place a weapon (mandatory first action).
 *   2. Use the placed slot's printed ability instead of the
 *      weapon range. For `damage-any-enemy`, fire at the first
 *      live enemy on the board (range-anywhere; no adjacency
 *      check).
 *   3. End the turn.
 *
 * Coverage delta:
 *   - Real `useSlotAbility` calls (not just `useWeaponAbility`).
 *   - Real `resolveSharedCounter` against the damage-any-enemy
 *     session (range-anywhere kills route through the same
 *     counter-attack pipeline as melee swings).
 *   - The `gain-token` / `gain-element` / `refresh-ap` /
 *     `bonus-movement-this-turn` resolution paths in
 *     `engine/slotAbilities.ts` get exercised every wave.
 *   - Body slot 1's `selfSuffer: 1` path (delver takes 1 HP
 *     loss to fire the medium damage) gets routine coverage —
 *     this is the only place outside Hammer's reroll that a
 *     delver self-suffers under normal play.
 */

import type { QaSession } from "../session";
import type { Scenario } from "./types";

const MAX_HERO_TURNS = 60;

function placeAndFireSlot(session: QaSession, heroId: string): void {
  const placed = session.firstPlayableWeapon(heroId);
  if (!placed) return;
  const res = session.playWeapon(heroId, placed.slotIdx, placed.cardId);
  if (!res.ok) {
    session.checkpoint(`slot-ability — playWeapon rejected ${placed.cardId}@${placed.slotIdx}: ${res.reason}`);
    return;
  }
  // Counter roll 5 (= miss) keeps damage symmetric across runs;
  // a deterministic roll means the scenario doesn't bleed HP
  // randomly from a counter-attack and lose the wave to a
  // bookkeeping issue we'd then triage as a tactical bug.
  const slotRes = session.useSlotAbilityAndResolve(heroId, placed.slotIdx, 5);
  if (!slotRes.ok) {
    session.checkpoint(`slot-ability — useSlotAbility rejected slot ${placed.slotIdx}: ${slotRes.reason}`);
  }
}

export const combatSlotAbilityScenario: Scenario = {
  name: "combat-slot-ability",
  description: "Place a card and fire the printed SLOT ABILITY every turn (not the weapon).",
  run(session) {
    session.state.quest1Completed = true;
    session.state.currentQuestId = "quest2";

    session.checkpoint("slot-ability — bootstrap Q2 W1");
    session.bootstrapWave("quest2", 1);
    session.drainOpinionPicks();
    session.autoPlaceSpawns();
    session.startWaveAfterPick();
    session.checkpoint("slot-ability — hero phase begins");

    let turn = 0;
    while (turn++ < MAX_HERO_TURNS) {
      const enc = session.state.encounter;
      if (!enc) break;
      if (enc.phase !== "hero") break;
      const active = session.state.currentDelverId;
      if (!enc.preparedToRun[active]) {
        placeAndFireSlot(session, active);
      }
      session.endHeroTurn();
      session.drainPendingModals();
    }
    session.checkpoint(`slot-ability — hero loop exited after ${turn - 1} turns, phase=${session.state.encounter?.phase ?? "null"}`);

    if (session.state.encounter?.phase === "parting-shots") {
      session.resolveAllPartingShots();
    }
    if (session.state.encounter?.phase === "end-of-wave") {
      session.completeWave();
    }
    session.checkpoint(`slot-ability — done, encounter=${session.state.encounter ? "alive" : "cleared"}`);
  },
};
