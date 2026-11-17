/**
 * Scorchline Beam (Suit A, R2-R5) — `repeat-attack` engine.
 *
 * Printed text on Suit A Beam cards (`card_body_beam_r{2..5}.jpg`):
 *   R2: "MEDIUM damage to the first target in any straight line
 *        (including diagonals). Repeat once. (Can be a different
 *        straight line.)"
 *   R3: "...Repeat 2 times..."  (3 total swings)
 *   R4: "...Repeat 3 times..."  (4 total swings)
 *   R5: "...Repeat 4 times..."  (5 total swings)
 *
 * Suit B's Ion Cannon Beam scales by per-hit damage at higher ranks
 * and does NOT carry a `repeat-attack` effect — only Scorchline
 * repeats. (Audit confirmation 2026-05-24.)
 *
 * Resolution model — mirrors Soulshift Sword's `repeat-on-kill`
 * chain (per-link counter timing, freeRepeat dispatch):
 *
 *   Per-swing counter timing
 *     Each swing is its own self-contained {@link AttackSession} —
 *     damage → shared counter prompt → finalize (kills + XP +
 *     level-ups). Each repeat is a SEPARATE session that re-runs
 *     the same pipeline.
 *
 *   Optional repeat
 *     The card says "Repeat N times" but the player is allowed to
 *     skip remaining repeats (e.g. nothing left to hit, or banking
 *     counter-attack risk). Skip clears the pending counter for the
 *     rest of the turn; remaining repeats can NOT be banked.
 *
 *   Per-swing damage clamp
 *     Scorchline scales by VOLUME, not per-hit damage. Each swing
 *     deals rank-1 damage (= 1 × MEDIUM) regardless of effective
 *     rank — see `combat.ts > effectiveDamageForCard`'s volume-
 *     scaling clamp. (Net ceiling: rank N Scorchline can deal
 *     N × MEDIUM total when every repeat connects, matching Ion
 *     Cannon's single-hit ceiling at the same rank.)
 *
 *   Death short-circuit
 *     If the triggering swing's counter killed the bearer (or the
 *     OTHER delver — End-of-Wave defeat fires at any 0-HP delver
 *     per rulebook p26), the encounter has already flipped to
 *     `end-of-wave` by the time we check. The phase guard inside
 *     {@link attackSessionTriggersBeamRepeat} suppresses the
 *     prompt.
 *
 * Cost
 *   Each bonus swing is FREE — no AP, no element token, no
 *   movement, no fresh action gate. Routes through
 *   `useWeaponAbility(..., { freeRepeat: true })` (see
 *   `engine/turn.ts > UseWeaponAbilityOptions`).
 *
 * Counter integration
 *   Each repeat fires the counter-roll modal independently. A
 *   repeat that lands on a target with a `rotates` ability re-
 *   evaluates the counter pattern against the new facing.
 */

import type { CampaignState } from "../state";
import { getEquipment, getEquipmentByTypeSuitRank } from "../data";
import type { AttackSession } from "./combat";
import { getEffectiveEquipmentRank } from "../state";

/**
 * Read the `repeat-attack.count` value off the rank-correct version
 * of `cardId` for the named delver. Returns 0 when:
 *   - `cardId` is unknown (defensive — should never happen).
 *   - The rank-correct card has no `repeat-attack` effect (rank-1
 *     Scorchline, or any non-Beam weapon).
 *
 * The card id passed in is typically the R1 placeholder from
 * `state.loadouts[heroId].slotCards[slotIdx]`. We resolve the
 * effective rank against `state.equipmentRanks` and look up the
 * matching rank-N card to read its effects, mirroring the lookup
 * pattern used in `useWeaponAbility` for `collect-creature-part`.
 */
export function repeatAttackCountForCard(
  state: CampaignState,
  heroId: string,
  cardId: string,
): number {
  let card;
  try {
    card = getEquipment(cardId);
  } catch {
    return 0;
  }
  const effective = getEffectiveEquipmentRank(state, heroId, card.type);
  const rank = effective > 0 ? effective : (card.rank ?? 1);
  const rankedCard = getEquipmentByTypeSuitRank(card.suit, card.type, rank);
  for (const eff of rankedCard.effects ?? []) {
    if (eff.kind === "repeat-attack") return eff.count;
  }
  return 0;
}

/**
 * Should the engine surface a "Fire Beam Again?" prompt after the
 * just-finalized attack session? True iff:
 *
 *   1. The session's source is a weapon with a `straight-line`
 *      range (today only Beam — structural so any future repeating
 *      straight-line weapon Just Works).
 *   2. There's at least one repeat still pending in
 *      `state.encounter.beamRepeatsRemaining[bearerId]`.
 *   3. The encounter is still in the `hero` phase. If a counter
 *      blow killed a delver and flipped us into End-of-Wave, the
 *      bonus swing is suppressed (mirrors Soulshift's check).
 *   4. The bearer is still alive — a 0-HP bearer post-counter
 *      shouldn't be offered another swing even if End-of-Wave
 *      hasn't latched yet.
 *
 * Pure check — does NOT mutate or roll anything.
 */
export function attackSessionTriggersBeamRepeat(
  state: CampaignState,
  session: AttackSession,
): boolean {
  if (session.source.kind !== "weapon") return false;
  const enc = state.encounter;
  if (!enc) return false;
  if (enc.phase !== "hero") return false;

  const remaining = enc.beamRepeatsRemaining?.[session.attackerId] ?? 0;
  if (remaining <= 0) return false;

  // Only Beam (straight-line) weapons carry the prompt today. Cheap
  // structural guard — if we ever ship another repeating range kind
  // we'll widen this here once.
  let card;
  try {
    card = getEquipment(session.source.cardId);
  } catch {
    return false;
  }
  if (card.range?.kind !== "straight-line") return false;

  // Bearer must still be standing — if the counter zeroed their HP,
  // suppress the prompt so the End-of-Wave flow takes over.
  const lo = state.loadouts[session.attackerId];
  if (!lo || lo.currentHp <= 0) return false;

  return true;
}

/**
 * Mutator: set the bearer's pending repeat counter to `count`.
 * Idempotent — overwriting a non-zero counter is a defensive no-op
 * concern (`useWeaponAbility` only calls this on the FIRST,
 * non-freeRepeat swing, when the prior counter should already be 0
 * from `startHeroTurn`'s reset).
 */
export function seedBeamRepeats(
  state: CampaignState,
  heroId: string,
  count: number,
): void {
  if (!state.encounter) return;
  if (count <= 0) return;
  state.encounter.beamRepeatsRemaining[heroId] = count;
}

/**
 * Mutator: decrement the bearer's pending repeat counter by 1
 * (floor 0). Called by `useWeaponAbility` at the end of every
 * `freeRepeat: true` swing of a `straight-line` weapon, so the
 * prompt doesn't reopen with a stale count after the player burns
 * through their bonus swings.
 */
export function consumeOneBeamRepeat(
  state: CampaignState,
  heroId: string,
): void {
  if (!state.encounter) return;
  const cur = state.encounter.beamRepeatsRemaining[heroId] ?? 0;
  state.encounter.beamRepeatsRemaining[heroId] = Math.max(0, cur - 1);
}

/**
 * Mutator: clear the bearer's pending repeat counter to 0. Used
 * when the player picks "Skip" on the prompt (no banking) and as
 * a defensive end-of-turn / end-of-wave reset.
 */
export function clearBeamRepeats(
  state: CampaignState,
  heroId: string,
): void {
  if (!state.encounter) return;
  state.encounter.beamRepeatsRemaining[heroId] = 0;
}
