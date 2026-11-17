/**
 * Who may act right now, and which delver each seat controls.
 *
 * Rules (agreed with the design owner, 2026-11-15):
 *   - Host picks Mind or Body; the guest gets the other.
 *   - During a wave's hero phase, the player whose delver's turn it is
 *     (`state.currentDelverId`) acts; the other watches.
 *   - Everything else (story pages, town visits / shops, spawn + first-
 *     turn picks, enemy phase, End Wave, rewards, title-screen
 *     campaign actions) is driven by the host; the guest watches.
 */
import type { CampaignState } from "../state";
import type { DelverRole, Seat } from "./types";

export const MIND_DELVER_ID = "hero-01";
export const BODY_DELVER_ID = "hero-02";

export function delverIdForRole(role: DelverRole): string {
  return role === "mind" ? MIND_DELVER_ID : BODY_DELVER_ID;
}

export function roleForDelverId(delverId: string): DelverRole {
  if (delverId === MIND_DELVER_ID) return "mind";
  if (delverId === BODY_DELVER_ID) return "body";
  throw new Error(`Online play: unknown delver id "${delverId}" (expected ${MIND_DELVER_ID} or ${BODY_DELVER_ID}).`);
}

export function otherRole(role: DelverRole): DelverRole {
  return role === "mind" ? "body" : "mind";
}

export function roleLabel(role: DelverRole): string {
  return role === "mind" ? "Mind" : "Body";
}

export function roleForSeat(seat: Seat, hostRole: DelverRole): DelverRole {
  return seat === "host" ? hostRole : otherRole(hostRole);
}

export function seatForRole(role: DelverRole, hostRole: DelverRole): Seat {
  return role === hostRole ? "host" : "guest";
}

/**
 * Extra, non-campaign facts the acting-seat rule needs. Published with
 * every snapshot so both clients agree.
 *   - `promptDeciderRole`: a relayed on-screen prompt (Sol / Lunar Shield
 *     during a counterattack or Parting Shots) is waiting for this
 *     delver's player. Highest priority.
 *   - `busy`: the flow owner is mid-flow (an attack or other non-choice
 *     modal is open). Queued per-delver choices for the other player wait
 *     until it finishes, so an in-progress flow is never cut off.
 */
export interface ActorContext {
  promptDeciderRole: DelverRole | null;
  busy: boolean;
}

export const NO_ACTOR_CONTEXT: ActorContext = { promptDeciderRole: null, busy: false };

/**
 * The delver who must make the next queued choice, `"shared"` when the
 * next queued choice affects both delvers (the normal phase rule picks
 * who decides), or `null` when nothing is queued.
 *
 * Order mirrors what the screens show first: the hero-card picker, the
 * quest-start / shared gates (opinion picks, scenario card, quest entry,
 * friendly encounter, Academy donation), then the post-action queue of
 * `ActionResolution.ts > advanceAfterAction` (ritual, element picks,
 * equipment rolls, XP rolls, level-up draws, creature parts), with Town
 * Visit suit-condition picks before level-ups as on the BoardScreen.
 */
export function pendingChoiceOwner(state: CampaignState): string | "shared" | null {
  const heroPick = state.pendingHeroPickDelvers[0];
  if (heroPick !== undefined) return heroPick;
  const enc = state.encounter;
  // A queued choice only steers who acts where its prompt is on screen;
  // otherwise (e.g. level-up draws waiting through Parting Shots and the
  // End Wave) the phase's own buttons must stay with their owner.
  const onBoard = enc !== null && enc.phase === "hero";
  const preWave = enc !== null && (enc.phase === "delver-spawn-pick" || enc.phase === "first-turn-pick");
  const opinion = enc?.pendingOpinionRankPicks[0];
  if (opinion !== undefined && (onBoard || preWave)) return opinion.heroId ?? "shared";
  // Shared prompts (both delvers) only block where they are shown too:
  // the scenario card / quest entry / friendly encounter on the board,
  // the Academy donation in the Town Visit.
  if (onBoard && state.currentScenarioCard != null) return "shared";
  if (onBoard && enc.pendingQuestEntry) return "shared";
  if (onBoard && state.pendingFriendlyEncounters.length > 0) return "shared";
  if (enc === null && state.pendingAcademyDonationResolution != null) return "shared";
  if (onBoard) {
    const ritual = enc.pendingRitualPicks[0];
    if (ritual !== undefined) return ritual;
  }
  const element = enc?.pendingElementChoices[0];
  if (element !== undefined && onBoard) return element.heroId;
  if (onBoard) {
    const equipmentRoll = enc.pendingEquipmentRolls[0];
    if (equipmentRoll !== undefined) return equipmentRoll.heroId;
    const xpRoll = enc.pendingXpRolls[0];
    if (xpRoll !== undefined) return xpRoll.heroId;
  }
  // Suit-condition picks show on the board, the End of Wave / next-wave
  // start (boss card back — the next wave is already built) and in the
  // Town Visit.
  const suit = state.pendingSuitConditionPicks[0];
  const endOfWave = enc !== null && enc.phase === "end-of-wave";
  if (suit !== undefined && (onBoard || endOfWave || preWave || enc === null)) return suit.heroId ?? "shared";
  if (onBoard) {
    const levelUp = enc.pendingLevelUpDraws[0];
    if (levelUp !== undefined) return levelUp.heroId;
    if (state.pendingScenarioDelverPicks.length > 0) return "shared";
    const creaturePart = enc.pendingCreaturePartChoices[0];
    if (creaturePart !== undefined) return creaturePart.heroId;
  }
  return null;
}

/**
 * The seat allowed to change the campaign right now (design owner,
 * 2026-11-15: each player makes the choices that only affect their own
 * delver). In priority order:
 *   1. A relayed Shield prompt → that delver's player.
 *   2. A queued per-delver choice (level-up card, element pick, rank pick,
 *      rolls, creature part, ritual, hero card) → that delver's player,
 *      unless the flow owner is mid-flow (`busy`).
 *   3. A Town Visit shop turn or an End of Wave element-pick turn
 *      (online) → that delver's player.
 *   4. A wave's hero phase → the player whose delver's turn it is.
 *   5. Everything else (story, shared choices, phases) → the host.
 * With no role chosen yet the host drives everything.
 */
export function actingSeat(
  state: CampaignState,
  hostRole: DelverRole | null,
  ctx: ActorContext = NO_ACTOR_CONTEXT,
): Seat {
  if (hostRole === null) return "host";
  return seatForRole(actingRole(state, hostRole, ctx), hostRole);
}

/** Role of the player who acts now (see {@link actingSeat}). */
export function actingRole(state: CampaignState, hostRole: DelverRole, ctx: ActorContext = NO_ACTOR_CONTEXT): DelverRole {
  if (ctx.promptDeciderRole !== null) return ctx.promptDeciderRole;
  if (!ctx.busy) {
    const owner = pendingChoiceOwner(state);
    if (owner !== null && owner !== "shared") return roleForDelverId(owner);
  }
  const shopTurn = state.townVisit?.shopTurn;
  if (shopTurn) return roleForDelverId(shopTurn);
  const enc = state.encounter;
  if (enc !== null && enc.phase === "hero") return roleForDelverId(state.currentDelverId);
  return hostRole;
}

/** Delver role whose turn it is in the hero phase, else null. */
export function heroTurnRole(state: CampaignState): DelverRole | null {
  const enc = state.encounter;
  if (enc === null || enc.phase !== "hero") return null;
  return roleForDelverId(state.currentDelverId);
}
