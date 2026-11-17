/**
 * Soulshift Sword (Body, R1) — `repeat-on-kill` engine.
 *
 * Printed text (`card_body_sword_r1.jpg`):
 *   "MEDIUM damage to an adjacent enemy. If the target dies, roll a
 *    die. On a result of 4-6, repeat if able."
 *
 * Resolution model (per design decision 2026-05-04):
 *
 *   Per-swing counter timing
 *     Each swing is its own self-contained {@link AttackSession} —
 *     damage → shared counter prompt → finalize (kills + XP +
 *     level-ups). The bonus swing is a SECOND, separate session that
 *     re-runs the same pipeline.
 *
 *   Optional repeat
 *     The card says "repeat if able" but the player is allowed to
 *     decline a successful (4-6) roll. The engine reports whether a
 *     repeat is even possible via {@link classifySoulshiftRoll}; the
 *     UI offers Skip vs Swing-again.
 *
 *   "If able" definition
 *     There must be at least one LIVE enemy 8-way adjacent to the
 *     bearer's current position (Sword's printed `single-adjacent`
 *     range, applied unchanged to the bonus swing). The bearer does
 *     NOT move between swings; the bonus targets are computed from
 *     wherever the bearer currently stands.
 *
 *   Death short-circuit
 *     If the triggering swing's counter killed the bearer (or even
 *     the OTHER delver — End-of-Wave defeat fires at any 0-HP delver
 *     per rulebook p26), the encounter has already flipped to
 *     `end-of-wave` by the time we check. The phase guard inside
 *     {@link attackSessionTriggersSoulshiftRoll} suppresses the
 *     bonus swing.
 *
 * Cost
 *   The bonus swing is FREE — no AP, no element token, no movement.
 *   It bypasses the `actionUsedThisTurn` half of the action gate
 *   via `useWeaponAbility(..., { freeRepeat: true })` (see
 *   `engine/turn.ts > UseWeaponAbilityOptions`).
 *
 * Rolls that miss
 *   On a 1-3, the printed text says nothing happens. The engine
 *   reports `outcome: "no-repeat"` and the UI closes the prompt with
 *   no further side-effect.
 *
 * Chaining
 *   No cap. A 4-6 roll can chain again on a new kill, ad infinitum.
 *   Real-game chains are bounded by adjacent live enemies (typically
 *   <5 in a single bearer-neighbourhood) and the kill probability.
 */

import type { CampaignState, EnemyInstance } from "../state";
import { ADJACENT_OFFSETS_8WAY } from "../rules";
import { getEquipment } from "../data";
import { getDelverAt, getEnemyAt } from "./encounter";
import type { AttackSession } from "./combat";

/**
 * Did the just-finalized attack session leave the engine in a state
 * that should prompt a Soulshift roll? True iff:
 *
 *   1. The session's source is a weapon AND that weapon card declares
 *      a `repeat-on-kill` effect (structural — works for any future
 *      R2-R5 Soulshift variant or other repeat-on-kill weapons that
 *      get added later).
 *   2. At least one of the session's hit-tiles `killed` the enemy
 *      there (`session.steps[i].killed === true`).
 *   3. The encounter is still in the `hero` phase. If a counter blow
 *      killed a delver and {@link onDelverDamaged} flipped us into
 *      End-of-Wave, the bonus swing is suppressed.
 *   4. There is at least one LIVE enemy 8-way adjacent to the bearer's
 *      CURRENT tile. The card's "repeat if able" wording means that
 *      with no adjacent enemies the roll is a deterministic no-op
 *      (`classifySoulshiftRoll` would always return `no-repeat`); we
 *      short-circuit here so the player doesn't have to click through
 *      a wasted die roll. (User report 2026-05-09 — last adjacent
 *      Crystanid died, modal still asked for a roll.)
 *
 * Pure check — does NOT mutate or roll anything.
 */
export function attackSessionTriggersSoulshiftRoll(
  state: CampaignState,
  session: AttackSession,
): boolean {
  if (session.source.kind !== "weapon") return false;
  const card = getEquipment(session.source.cardId);
  const hasRepeat = (card.effects ?? []).some(
    (e) => e.kind === "repeat-on-kill",
  );
  if (!hasRepeat) return false;

  const anyKilled = session.steps.some((s) => s.killed);
  if (!anyKilled) return false;

  const phase = state.encounter?.phase;
  if (phase !== "hero") return false;

  // "If able" precondition — no point asking the player to roll if
  // there's nothing left to chain into. `attackerId` is the bearer
  // (matches the heroId `useWeaponAbility` was called with).
  if (adjacentLiveEnemiesForRepeat(state, session.attackerId).length === 0) {
    return false;
  }
  return true;
}

/**
 * Bonus-swing target candidates: live enemies 8-way adjacent to the
 * bearer's CURRENT position. Empty array means "not able" — the
 * outer flow should skip the prompt entirely (or surface a no-op
 * roll) per "repeat if able".
 *
 * Pure helper — UI uses this to highlight the picker; engine uses it
 * to validate target choice on the click handler.
 */
export function adjacentLiveEnemiesForRepeat(
  state: CampaignState,
  heroId: string,
): EnemyInstance[] {
  const enc = state.encounter;
  if (!enc) return [];
  const pos = getDelverAt(enc, heroId);
  if (!pos) return [];
  const out: EnemyInstance[] = [];
  for (const off of ADJACENT_OFFSETS_8WAY) {
    const e = getEnemyAt(enc, pos.x + off.dx, pos.y + off.dy);
    if (e && e.alive) out.push(e);
  }
  return out;
}

/**
 * Outcome of a single Soulshift die roll.
 *
 *   "repeat-available"
 *     Roll was 4-6 AND there is at least one adjacent live enemy. UI
 *     should offer the player the choice to swing again (mandatory
 *     decision, but Skip is allowed per design decision 2026-05-04 —
 *     see module-level docs).
 *
 *   "no-repeat"
 *     Roll was 1-3, OR roll was 4-6 but there are no adjacent live
 *     enemies (nothing to chain into). UI should close the prompt
 *     and continue the turn flow.
 */
export type SoulshiftRollOutcome = "repeat-available" | "no-repeat";

export interface SoulshiftRollResult {
  rolled: number;
  outcome: SoulshiftRollOutcome;
  /** Empty unless `outcome === "repeat-available"`. */
  candidates: EnemyInstance[];
}

/**
 * Pure: classify a Soulshift d6 result against the live-target snapshot.
 *
 * `roll` must be 1-6. Caller (UI) supplies the value — engine doesn't
 * own RNG so tests can pin specific outcomes by hand.
 *
 * Threshold (4-6 = repeat-eligible) is hardcoded to match the only
 * Soulshift card that exists. If we ever ship a variant with a
 * different `rollMin`/`rollMax` we'll thread those through here from
 * the card's `repeat-on-kill` effect.
 */
export function classifySoulshiftRoll(
  state: CampaignState,
  heroId: string,
  rolled: number,
): SoulshiftRollResult {
  const eligible = rolled >= 4 && rolled <= 6;
  if (!eligible) {
    return { rolled, outcome: "no-repeat", candidates: [] };
  }
  const candidates = adjacentLiveEnemiesForRepeat(state, heroId);
  if (candidates.length === 0) {
    return { rolled, outcome: "no-repeat", candidates: [] };
  }
  return { rolled, outcome: "repeat-available", candidates };
}
