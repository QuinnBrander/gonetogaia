/**
 * Hero Phase turn flow (rulebook p19, p25; DESIGN.md §4).
 *
 * A turn proceeds in two stages:
 *   1. **Mandatory turn-start choice**: place a Weapon Card from
 *      hand into an empty Weapon Slot (`playWeaponCard`). If the hand
 *      is empty when the turn starts, `startHeroTurn` auto-latches
 *      Prepare to Run (DESIGN.md §5.7) instead — players cannot
 *      manually declare it.
 *   2. **Optional follow-ups**: ≤1 movement and ≤1 action, in either
 *      order, gated on a placement having happened this turn.
 *
 * This file owns the per-turn lifecycle (`startHeroTurn`, `endHeroTurn`),
 * the placement primitive (`playWeaponCard`), and the prepare-to-run
 * latch (`prepareToRun` — kept as a low-level primitive for tests
 * and future wave-end automation, not wired to a UI button).
 * Movement gating reads `turnState` from the encounter and lives in
 * `engine/movement.ts`.
 *
 * Out of scope per DESIGN.md §4.1:
 *   - Refreshing exhausted Weapon Cards. Those refresh at the End Wave
 *     Phase (§4.2) or via in-wave element/AP spend (§4.3); NOT per turn.
 */

import { damageDelverInWave, tickRebirthAfterHeroTurn } from "./omenRebirth";
import { isStolenCard, tickCorruption } from "./questAbilities";
import type { CampaignState, HeroTurnState } from "../state";
import { getEffectiveEquipmentRank, getEffectiveEquipmentRanks, getEquipmentCardFor } from "../state";
import type { EquipmentCard, EquipmentType } from "../types";
import { getEquipment, getEquipmentByTypeSuit, getEquipmentByTypeSuitRank, getDelverBoard, QUEST1 } from "../data";
import { getEnemy, getHero } from "../data";
import { ALL_EQUIPMENT_TYPES } from "../types";
import type { Element } from "../types";
import { freshTurnState, getDelverAt, getEnemyAt, getEnemyInstance } from "./encounter";
import { enqueueElementChoice } from "./os";
import { legalMoveDestinationsForEnemy } from "./boots";
import { seedBeamRepeats, consumeOneBeamRepeat } from "./beamRepeat";
import { placeCardInSlot, removeCardFromSlot } from "./loadout";
import { ELEMENT_CAP_PER_DELVER } from "./kills";
import {
  buildAttackSession,
  computeWeaponHitTiles,
  effectiveDamageForCard,
  damageValueForType,
  effectiveDamageForType,
  type AttackSession,
  type PreEffect,
  type PostEffect,
  type HitTile,
} from "./combat";
import {
  resolveSlotAbility,
  type SlotAbilityParams,
  type SlotAbilityResult,
} from "./slotAbilities";
import { maybeEnterPartingShotsAfterTurn, onDelverDamaged } from "./wave";
import {
  canSpendDoubleDamage,
  spendToken,
  typedDoubleDamageKindFor,
} from "./tokens";
import type { ConsumableTokenKind } from "../state";
import { logEvent } from "../debug/sessionLog";

/** Switch `state.currentDelverId` to the other hero. */
export function flipActiveDelver(state: CampaignState): void {
  const heroIds = Object.keys(state.loadouts);
  if (heroIds.length < 2) return;
  const idx = heroIds.indexOf(state.currentDelverId);
  const next = heroIds[(idx + 1) % heroIds.length]!;
  state.currentDelverId = next;
}

/**
 * Refresh the per-turn resources of the currently active delver, and
 * reset their per-turn state so placement is required again. Called:
 *   - once when an encounter starts (after `ensureEncounter`),
 *   - by `endHeroTurn` immediately after flipping, so the new delver
 *     starts with their full budget.
 *
 * Resets `currentMovement -> baseMovement` AND clears
 * `turnState[currentDelverId]` so the new turn requires a placement
 * before movement / action can be taken (DESIGN.md §4 stage 1).
 * Any unspent movement from the previous turn is intentionally
 * discarded — movement stands alone per turn (rulebook p19,
 * DESIGN.md §4.1).
 *
 * AP is intentionally NOT refreshed here (rule unified with the
 * consumable AP-token model on 2026-05-09 — see
 * `state.ts > ConsumableTokenKind` jsdoc). `currentAp` carries
 * across Hero turns for the rest of the wave; the per-Wave refresh
 * to `baseAp` happens at the End Wave
 * (`engine/wave.ts > enterEndOfWave` (End Wave refresh)). A delver who burns through
 * all their AP early in a wave runs out until next End Wave.
 *
 * The other delver's `turnState` is left as-is; they get a fresh reset
 * on their own `startHeroTurn`.
 */
export function startHeroTurn(state: CampaignState): void {
  const loadout = state.loadouts[state.currentDelverId];
  if (!loadout) return;
  loadout.currentMovement = loadout.baseMovement;

  if (state.encounter) {
    state.encounter.turnState[state.currentDelverId] = freshTurnState();
    const heroId = state.currentDelverId;
    // Defensive reset: any pending Beam repeats from a prior turn
    // (shouldn't happen — the `beam-repeat-prompt` modal is mandatory
    // before End Turn) get cleared so a stale counter can't haunt
    // the new turn. Old-save migration also lands here when an
    // encounter loaded from disk lacks the field entirely.
    if (!state.encounter.beamRepeatsRemaining) {
      state.encounter.beamRepeatsRemaining = {};
    }
    state.encounter.beamRepeatsRemaining[heroId] = 0;
    const playable = hasPlayableWeaponInHand(state, heroId);
    // Auto-prepare to run if the delver has no playable weapon cards
    // left in hand (DESIGN.md §5.7 — there is no manual button).
    // Players must use the in-turn AP-refresh option (§5.5.1) on a
    // PRIOR turn if they want to keep playing past their last
    // exhaustion. Once latched, sticky for the wave.
    if (!state.encounter.preparedToRun[heroId] && !playable) {
      state.encounter.preparedToRun[heroId] = true;
    }
    // Self-heal stale latches from the pre-2026-05-09 bug (auto-prepare
    // walked starting equipment only, so it fired the moment all
    // *starting* weapons were placed even if level-up acquired weapons
    // were still in hand). Under the corrected logic, a delver with at
    // least one playable weapon in hand SHOULDN'T be latched
    // — `preparedToRun` is only ever auto-set, never manually toggled
    // (DESIGN.md §5.7), so unconditionally clearing here is safe and
    // unsticks any save in the bad state without losing progress.
    if (state.encounter.preparedToRun[heroId] && playable) {
      state.encounter.preparedToRun[heroId] = false;
    }
  }
}

/**
 * True if the delver has at least one weapon card in hand (i.e., not
 * already exhausted into a slot). Passive cards do not count toward
 * "playable" — they are equipped automatically and can't be placed.
 *
 * IMPORTANT: walks `state.equipmentRanks[heroId]` rather than
 * `getStartingEquipment(heroId)` — must mirror HandPanel's hand
 * definition (every owned type at rank ≥ 1) and `playWeaponCard`'s
 * ownership check, otherwise the auto-Prepare-to-Run latch fires
 * the moment all *starting* weapons are placed even if level-up
 * acquired weapons (Trident, Mace, Shockwave, …) are still in hand.
 *
 * Bug history: pre-2026-05-09 this read `getStartingEquipment`,
 * mirroring the same starting-only-scope bug `playWeaponCard` had
 * before its 2026-05-04 widening. User repro 2026-05-09: with
 * Hammer + Beam (starting) placed and Mace (level-up) still in
 * hand, `startHeroTurn` auto-latched `preparedToRun`, after which
 * every subsequent `playWeaponCard` rejected silently → empty
 * slots looked unresponsive. Both code paths now agree on the
 * single owned-equipment definition.
 */
function hasPlayableWeaponInHand(state: CampaignState, heroId: string): boolean {
  const loadout = state.loadouts[heroId];
  if (!loadout) return false;
  const placed = new Set(loadout.slotCards.filter((id): id is string => !!id));
  // Effective ranks so a Xavier +1 bump that adds a new weapon type
  // to the delver's hand (R0 -> R1 Trident, say) is correctly
  // counted as a playable card-in-hand for the Prepare-to-Run gate.
  const ranks = getEffectiveEquipmentRanks(state, heroId);
  const hero = getHero(heroId);
  for (const type of ALL_EQUIPMENT_TYPES) {
    if ((ranks[type] ?? 0) < 1) continue;
    const card = getEquipmentByTypeSuit(hero.suit, type);
    if (card.category !== "weapon") continue;
    if (placed.has(card.id)) continue;
    return true;
  }
  return false;
}

/**
 * True when the given delver's turn should be silently skipped —
 * they have no weapon card in hand to place (so they cannot fire any
 * weapon this turn) AND they lack the 2 AP needed to refresh a slot
 * card back to hand. Movement alone doesn't justify a full turn
 * hand-off, so we skip them entirely and let the other delver take
 * back-to-back turns.
 *
 * Called by the turnFlow helpers after each `endHeroTurn` flip; if
 * it returns true the caller immediately calls `endHeroTurn` again
 * (once only — depth-guarded by the caller to avoid looping when
 * both delvers are somehow exhausted simultaneously).
 */
export function shouldAutoSkipTurn(state: CampaignState, heroId: string): boolean {
  const enc = state.encounter;
  if (!enc || enc.phase !== "hero") return false;
  const loadout = state.loadouts[heroId];
  if (!loadout) return false;
  // Can they play a card? If yes, they have a real turn.
  if (hasPlayableWeaponInHand(state, heroId)) return false;
  // Can they afford AP refresh (2 AP) to free a slot card back to hand?
  if (loadout.currentAp >= 2) return false;
  return true;
}

/**
 * (DESIGN.md §5.7) — if so, transitions the encounter from Hero Phase
 * to Parting Shots Phase via `engine/wave.ts`. The phase transition
 * is what tells the UI to swap from BoardScreen's hero-phase rendering
 * to the Parting Shots panel.
 *
 * No "current delver had unspent movement / AP" warning — that's the
 * caller's job (e.g. an "End Turn" button can prompt for confirmation
 * before invoking this).
 */
export function endHeroTurn(state: CampaignState): void {
  // Drain any deferred auto-refresh BEFORE the flip -- the active
  // delver's just-placed card needs to return to hand at end of
  // THEIR turn, not the next delver's. `flipActiveDelver` swaps
  // `currentDelverId` and `startHeroTurn` resets `turnState` via
  // `freshTurnState()`, so if we waited until after either of
  // those, the `cardPlacedThisTurn.autoRefreshedElement` latch
  // would be on the wrong delver / wiped entirely.
  applyDeferredAutoRefreshes(state);
  tickRebirthAfterHeroTurn(state);
  // Ch4 Corruption: the corrupted delver suffers 1 at the end of each turn.
  if (tickCorruption(state) && onDelverDamaged(state)) return;
  flipActiveDelver(state);
  // IMPORTANT: check bothPrepared BEFORE startHeroTurn. startHeroTurn's
  // self-heal logic clears the newly-active delver's preparedToRun latch
  // if they still have playable weapon cards (to fix stale latches from
  // prior bugs). That clear races with the transition check and silently
  // prevents parting shots from ever firing when both delvers pass their
  // turns consecutively.
  //
  // Only skip startHeroTurn when the check actually transitioned the phase
  // to "parting-shots". All other return values (null = no encounter,
  // "hero" = not both prepared, any other phase = wasn't in hero phase)
  // should still fall through to startHeroTurn.
  if (maybeEnterPartingShotsAfterTurn(state) === "parting-shots") return;
  startHeroTurn(state);
}

/**
 * Drain any pending end-of-turn auto-refresh for the currently
 * active delver. Called from {@link endHeroTurn} just before the
 * flip + `startHeroTurn` reset.
 *
 * The 2026-05-21 deferred-refresh change in `playWeaponCard`
 * leaves the just-placed card sitting in its slot (instead of
 * snapping back to hand the moment placement succeeds) when the
 * matching element bag had 2 tokens -- this helper is the
 * matching back-half that finally clears the slot so the card
 * is effectively "in hand" again on the player's next turn.
 *
 * Idempotent + defensive:
 *   - no-op if no encounter / no turn state / no placement latch,
 *   - no-op if `autoRefreshedElement` is null (no deferred clear
 *     is pending),
 *   - no-op if the slot has already been cleared by some other
 *     code path (e.g., `undoWeaponPlacement`).
 *
 * Exported so tests can drive the deferred clear without going
 * through the full `endHeroTurn` flow (which also runs phase
 * transitions). Not part of the public engine surface used by
 * BoardScreen.
 */
export function applyDeferredAutoRefreshes(state: CampaignState): void {
  const heroId = state.currentDelverId;
  const ts = state.encounter?.turnState[heroId];
  const placed = ts?.cardPlacedThisTurn;
  if (!placed || placed.autoRefreshedElement === null) return;
  const loadout = state.loadouts[heroId];
  if (!loadout) return;
  const { slotIdx, cardId, autoRefreshedElement } = placed;
  // Ch4 Steals: a stolen card stays put (it comes back exhausted).
  if (isStolenCard(state, heroId, cardId)) return;
  if (loadout.slotCards[slotIdx] !== cardId) {
    // Slot was cleared by some other code path (most likely
    // `undoWeaponPlacement`, which also restored the 2 spent
    // element tokens). Nothing left to do.
    return;
  }
  loadout.slotCards[slotIdx] = null;
  logEvent("engine.applyDeferredAutoRefresh", {
    heroId,
    slotIdx,
    cardId,
    element: autoRefreshedElement,
  });
}

// --- Stage 1: mandatory turn-start choice --------------------------------

export type TurnActionResult =
  | { ok: true; autoRefresh?: PlacementAutoRefresh }
  | { ok: false; reason: string };

/**
 * Result detail when {@link playWeaponCard} triggered the auto-refresh
 * rule (DESIGN.md §4.3 — slot already had 2 matching elements above
 * it, so the card returns to hand and those 2 element tokens are
 * spent). The UI uses this to surface a "Refreshed!" toast / log
 * entry so the player understands why their weapon went back to hand
 * the moment they placed it.
 */
export interface PlacementAutoRefresh {
  /** Slot index whose 2 matching elements were consumed. */
  slotIdx: number;
  /** The element printed on that slot (and consumed in pairs of 2). */
  element: Element;
  /** Card id that was placed AND immediately refreshed back to hand. */
  cardId: string;
}

/**
 * Mandatory turn-start placement (DESIGN.md §4 stage 1).
 *
 * Exhaust one Weapon Card from the active delver's hand into an empty
 * Weapon Slot. Once this succeeds, movement and action become available
 * for this turn (gated separately). Placement is reversible via
 * `undoWeaponPlacement` so long as no movement / action has been taken
 * yet — see that function. Calling `playWeaponCard` again while a
 * placement is already latched is rejected; undo first.
 *
 * Rejected when:
 *   - no encounter is in progress,
 *   - `heroId` is not the active delver,
 *   - the hero has already prepared to run this wave,
 *   - placement has already happened this turn,
 *   - the slot index is out of range or already occupied,
 *   - the card is the wrong suit for the hero (Mind hero can't play
 *     a Body card and vice-versa),
 *   - the card's equipment type is not OWNED by the hero (rank < 1
 *     in `state.equipmentRanks[heroId]`) — i.e., starting equipment
 *     OR any card acquired mid-quest via Level Up is fine; nothing
 *     else,
 *   - the card is already placed in another slot,
 *   - the card is not category `"weapon"` (passives can't be played as a
 *     turn action — DESIGN.md §3 / HandPanel).
 */
export function playWeaponCard(
  state: CampaignState,
  heroId: string,
  slotIdx: number,
  cardId: string,
): TurnActionResult {
  const enc = state.encounter;
  if (!enc) return { ok: false, reason: "no encounter in progress" };
  if (heroId !== state.currentDelverId) {
    return { ok: false, reason: "not the active delver" };
  }
  if (enc.preparedToRun[heroId]) {
    return { ok: false, reason: "delver has prepared to run" };
  }
  const ts = enc.turnState[heroId];
  if (!ts) return { ok: false, reason: "no turn state for delver" };
  if (ts.cardPlacedThisTurn !== null) {
    return { ok: false, reason: "already placed a card this turn" };
  }

  const loadout = state.loadouts[heroId];
  if (!loadout) return { ok: false, reason: "no loadout for delver" };
  if (slotIdx < 0 || slotIdx >= loadout.slotCards.length) {
    return { ok: false, reason: `slotIdx ${slotIdx} out of range` };
  }
  if (loadout.slotCards[slotIdx] !== null) {
    return { ok: false, reason: "slot is occupied" };
  }

  // Hand check: card must be (a) the hero's suit, (b) OWNED at
  // rank ≥ 1 in `state.equipmentRanks[heroId]`, and (c) not already
  // placed in any slot. Mirrors HandPanel's hand definition (which
  // walks `equipmentRanks` directly), so any card the player can
  // SEE in their hand can be played — including weapons acquired
  // mid-quest via Level Up (Trident, Mace, Shockwave, etc.).
  //
  // NOTE: pre-2026-05-04 this validated against
  // `getStartingEquipment(heroId)`, which silently rejected every
  // level-up acquired weapon since the printed starting hand only
  // covers Hammer/Beam/Shield (Mind) and Gauntlet/Sword/Armor
  // (Body). HandPanel surfaced the cards as clickable but the slot
  // click was a no-op — bug fixed by widening the check here.
  const card = getEquipment(cardId);
  if (card.category !== "weapon") {
    return { ok: false, reason: "card is not a weapon" };
  }
  const hero = getHero(heroId);
  if (card.suit !== hero.suit) {
    return { ok: false, reason: "card not in hero's hand" };
  }
  // Effective rank so a Xavier Ally-bumped slot (R0 -> R1) is
  // playable from hand, and a Detractor-suppressed slot (R1 -> R0)
  // is not. Mirrors HandPanel's hand composition.
  if (getEffectiveEquipmentRank(state, heroId, card.type) < 1) {
    return { ok: false, reason: "card not in hero's hand" };
  }
  if (loadout.slotCards.includes(cardId)) {
    return { ok: false, reason: "card already placed in a slot" };
  }

  const r = placeCardInSlot(loadout, slotIdx, cardId);
  if (!r.ok) return { ok: false, reason: r.reason };

  // Auto-refresh check (DESIGN.md §4.3, rulebook p17 implicit):
  //   "Weapon slots are composed of 6 distinct sections that can
  //    contain 2 element tokens and a weapon card."
  // If the slot already has 2 matching element tokens stacked above
  // it, placing a weapon there spends both tokens and queues the
  // weapon to refresh (return to hand) at end of turn -- the card
  // stays visibly placed for the rest of the turn so the player
  // (a) can still see + use its ability without the slot looking
  // mysteriously empty, and (b) gets a clear "WILL AUTO REFRESH"
  // affordance on the slot until the deferred clear fires from
  // `endHeroTurn > applyDeferredAutoRefreshes`. The placement
  // still counts for the mandatory turn-start step and
  // `cardPlacedThisTurn` stays set, so the player can still take
  // their action this turn -- both weapon ability AND slot ability
  // remain available either way (the engine reads the placed card
  // from `cardPlacedThisTurn.cardId` as well as `slotCards[slotIdx]`).
  //
  // Bug history: pre-2026-05-21 this cleared `slotCards[slotIdx]`
  // synchronously, so the slot looked empty the instant the player
  // dropped the card and the UI provided no signal that the
  // weapon was about to return -- it just vanished. User request
  // to keep the card visibly placed + add a "WILL AUTO REFRESH"
  // banner; deferred clear lives on `endHeroTurn` below.
  const slotElement = getDelverBoard(getHero(heroId).suit).weaponSlots[slotIdx]!.element;
  const bag = state.elements[heroId] ?? {};
  let autoRefreshedElement: Element | null = null;
  if ((bag[slotElement] ?? 0) >= ELEMENT_CAP_PER_DELVER) {
    bag[slotElement] = bag[slotElement]! - ELEMENT_CAP_PER_DELVER;
    state.elements[heroId] = bag;
    // NOTE: intentionally NOT clearing `loadout.slotCards[slotIdx]`
    // here -- the card stays placed until `applyDeferredAutoRefreshes`
    // runs at end of turn (see `endHeroTurn`).
    autoRefreshedElement = slotElement;
    // Audit-trail log for the auto-refresh element consumption — the
    // SuitPanel call site logs `engine.playWeaponCard` with the bag
    // snapshot, but if both rows aren't visible (e.g. when the engine
    // is invoked from a non-instrumented call path), this row is the
    // ground truth that the consumption did happen.
    logEvent("engine.spendElement", {
      heroId,
      element: slotElement,
      reason: "weapon-auto-refresh",
      cardId,
      slotIdx,
      newTotal: bag[slotElement],
    });
  }

  ts.cardPlacedThisTurn = { slotIdx, cardId, autoRefreshedElement };
  return autoRefreshedElement
    ? { ok: true, autoRefresh: { slotIdx, element: autoRefreshedElement, cardId } }
    : { ok: true };
}

/**
 * Undo this turn's mandatory placement (DESIGN.md §4 stage 1, flexibility
 * affordance). Returns the just-placed card to the hand by clearing the
 * slot and the per-turn placement latch. The player can then either
 * place again (different card and/or different slot) or declare Prepare
 * to Run instead.
 *
 * Allowed as long as the player hasn't used their action step yet.
 * The action step is the hard commit point — once a weapon ability
 * has been resolved (`useWeaponAbility`), the placement is locked in.
 *
 * Movement is intentionally NOT a gate. The 2026-05-21
 * "movement-before-card" feature lets the player legally walk first
 * and then place; locking undo behind `!movementUsedThisTurn` would
 * defeat that flexibility (the player would be stuck with whatever
 * card they tried after moving, even though no attack has happened
 * yet). Movement already taken stays committed — undo only pulls the
 * card and refunds any auto-refresh tokens.
 *
 * Rejected when:
 *   - no encounter is in progress,
 *   - `heroId` is not the active delver,
 *   - no card has been placed this turn,
 *   - the action step has already been used this turn,
 *   - the delver has already prepared to run (defensive — prepare
 *     blocks placement, so this should be unreachable).
 */
export function undoWeaponPlacement(
  state: CampaignState,
  heroId: string,
): TurnActionResult {
  const enc = state.encounter;
  if (!enc) return { ok: false, reason: "no encounter in progress" };
  if (heroId !== state.currentDelverId) {
    return { ok: false, reason: "not the active delver" };
  }
  if (enc.preparedToRun[heroId]) {
    return { ok: false, reason: "delver has prepared to run" };
  }
  const ts = enc.turnState[heroId];
  if (!ts) return { ok: false, reason: "no turn state for delver" };
  if (ts.cardPlacedThisTurn === null) {
    return { ok: false, reason: "no card placed this turn to undo" };
  }
  if (ts.actionUsedThisTurn) {
    return { ok: false, reason: "cannot undo placement after using an action" };
  }

  const loadout = state.loadouts[heroId];
  if (!loadout) return { ok: false, reason: "no loadout for delver" };

  const { slotIdx, autoRefreshedElement } = ts.cardPlacedThisTurn;

  // Pull the card out of the slot first. Under the 2026-05-21
  // deferred-refresh change, the card stays in `slotCards[slotIdx]`
  // for the rest of the turn even when an auto-refresh is queued
  // (cleared by `applyDeferredAutoRefreshes` at end of turn). So
  // undo always needs to remove from the slot here, regardless of
  // whether an auto-refresh was queued -- only the element-token
  // restore is conditional.
  //
  // Bug history: pre-2026-05-21 the auto-refresh path cleared the
  // slot synchronously, so undo had a branch that DIDN'T touch the
  // slot and only restored the tokens. With the deferred clear,
  // that branch left the just-placed card stranded in the slot
  // after undo.
  const r = removeCardFromSlot(loadout, slotIdx);
  if (!r.ok) return { ok: false, reason: r.reason };

  if (autoRefreshedElement !== null) {
    // The 2 matching element tokens were spent when the placement
    // queued its auto-refresh; cap-clamp them back to 2 since they
    // were just there.
    const bag = state.elements[heroId] ?? {};
    bag[autoRefreshedElement] = (bag[autoRefreshedElement] ?? 0) + ELEMENT_CAP_PER_DELVER;
    state.elements[heroId] = bag;
    logEvent("engine.grantElement", {
      heroId,
      element: autoRefreshedElement,
      granted: true,
      reason: "undo-auto-refresh",
      newTotal: bag[autoRefreshedElement],
    });
  }

  ts.cardPlacedThisTurn = null;
  return { ok: true };
}

// --- AP spend (DESIGN.md §4.3 — in-wave AP economy) ----------------------

/**
 * Spend 1 AP to double the active delver's movement budget for this
 * turn (DESIGN.md §4.3).
 *
 * The doubling is multiplicative: any movement points the delver
 * currently has — base + slot bonuses already gained — are doubled
 * immediately, AND any *future* slot-ability +movement gained this
 * turn is also doubled (handled in `resolveBonusMovement`). The
 * `apMovementDoubledThisTurn` latch on `HeroTurnState` is the
 * source of truth so order of operations doesn't matter:
 *   - AP first, then "+1 mov" slot ability:   1 → 2 → 2 + 1*2 = 4
 *   - "+1 mov" slot ability first, then AP:   1 → 2 → 2 * 2 = 4
 *
 * Can be spent at any point during the active delver's turn,
 * including BEFORE the mandatory placement.
 * Once-per-turn; the `apMovementDoubledThisTurn` latch is what
 * enforces that and is reset by `startHeroTurn`.
 *
 * Rejected when:
 *   - no encounter is in progress,
 *   - `heroId` is not the active delver,
 *   - delver has prepared to run,
 *   - movement has already been used this turn (doubled budget would
 *     be wasted — `legalDestinations` blocks further moves),
 *   - already doubled this turn,
 *   - currentAp < 1.
 */
export function spendApDoubleMovement(
  state: CampaignState,
  heroId: string,
): TurnActionResult {
  const enc = state.encounter;
  if (!enc) return { ok: false, reason: "no encounter in progress" };
  if (heroId !== state.currentDelverId) {
    return { ok: false, reason: "not the active delver" };
  }
  if (enc.preparedToRun[heroId]) {
    return { ok: false, reason: "delver has prepared to run" };
  }
  const ts = enc.turnState[heroId];
  if (!ts) return { ok: false, reason: "no turn state for delver" };
  if (ts.movementUsedThisTurn) {
    return { ok: false, reason: "movement already used this turn" };
  }
  if (ts.apMovementDoubledThisTurn) {
    return { ok: false, reason: "movement already doubled this turn" };
  }
  const loadout = state.loadouts[heroId];
  if (!loadout) return { ok: false, reason: "no loadout for delver" };
  if (!chargeAp(state, heroId, 1)) {
    return { ok: false, reason: "not enough AP" };
  }
  loadout.currentMovement *= 2;
  ts.apMovementDoubledThisTurn = true;
  return { ok: true };
}

/**
 * Spend `cost` AP for the active delver from the unified AP pool
 * (`loadout.currentAp`). Returns `true` on success, `false` when the
 * pool is short. No-op (and returns `true`) for a 0 / negative cost.
 *
 * AP was unified with the consumable-AP-token bag on 2026-05-09 —
 * there is no longer a separate token top-up pathway. Battery's
 * "AP" outcome bumps `loadout.baseAp` (and tops up `currentAp`)
 * directly via `EquipmentRollOutcome.baseApDelta`, so any "I gained
 * AP from Battery" credit shows up as a higher pool here without
 * any spend-time plumbing.
 *
 * Callers MUST gate on encounter / active-delver / payable-cost
 * preconditions BEFORE calling this; the helper's only contract is
 * "deduct atomically from currentAp".
 */
function chargeAp(state: CampaignState, heroId: string, cost: number): boolean {
  const loadout = state.loadouts[heroId];
  if (!loadout) return false;
  if (cost <= 0) return true;
  if (loadout.currentAp < cost) return false;
  loadout.currentAp -= cost;
  return true;
}

/**
 * Spend 2 AP to return one exhausted Weapon Card from a slot to the
 * hand (DESIGN.md §4.3). The card becomes immediately playable again
 * on a future turn (this turn's mandatory placement latch — if any —
 * is NOT cleared, so the player can't replay this turn).
 *
 * Can be spent at any point during the active delver's turn,
 * including BEFORE the mandatory placement.
 *
 * Refreshing the just-placed slot also clears `cardPlacedThisTurn`
 * so the action menu doesn't dangle a pointer to a now-empty slot.
 * If the action was already used, that latch stays — refresh just
 * recovers the card for future turns.
 *
 * Rejected when:
 *   - no encounter is in progress,
 *   - `heroId` is not the active delver,
 *   - slotIdx is out of range or the slot is empty,
 *   - currentAp < 2.
 *
 * NOTE: `preparedToRun` is intentionally NOT a rejection condition
 * here (changed 2026-05-18 after user repro). Refresh is the
 * player's escape hatch from prepared-to-run lockout — the rulebook
 * intent (DESIGN.md §5.7) is "players who want to keep playing past
 * their last exhaustion must spend 2 AP ... to refresh a weapon
 * card back to hand". Pre-fix this was Catch-22'd: the gate rejected
 * the very call that would have un-stuck the delver.
 *
 * After a successful refresh, this function ALSO re-evaluates the
 * latch in place: if the delver now has a playable weapon in hand,
 * `preparedToRun` clears immediately so the player can finish the
 * SAME turn normally (mandatory placement → optional movement /
 * action). This mirrors `startHeroTurn`'s self-heal — the auto-
 * prepare check fires "no playable weapon in hand", so the moment
 * that precondition stops being true the latch should clear,
 * regardless of whether it's start-of-turn or mid-turn. Without this
 * mid-turn clear the player would refresh, then have `playWeaponCard`
 * reject them with "delver has prepared to run" because the latch
 * lingered — a second user-visible Catch-22 (repro 2026-05-18).
 */
export function spendApRefreshWeapon(
  state: CampaignState,
  heroId: string,
  slotIdx: number,
): TurnActionResult {
  const enc = state.encounter;
  if (!enc) return { ok: false, reason: "no encounter in progress" };
  if (heroId !== state.currentDelverId) {
    return { ok: false, reason: "not the active delver" };
  }
  const ts = enc.turnState[heroId];
  if (!ts) return { ok: false, reason: "no turn state for delver" };
  const loadout = state.loadouts[heroId];
  if (!loadout) return { ok: false, reason: "no loadout for delver" };
  if (slotIdx < 0 || slotIdx >= loadout.slotCards.length) {
    return { ok: false, reason: `slotIdx ${slotIdx} out of range` };
  }
  if (loadout.slotCards[slotIdx] === null) {
    return { ok: false, reason: "slot is empty (nothing to refresh)" };
  }
  if (isStolenCard(state, heroId, loadout.slotCards[slotIdx]!)) {
    return { ok: false, reason: "this weapon was stolen by the Ruined Tidekin" };
  }
  if (!chargeAp(state, heroId, 2)) {
    return { ok: false, reason: "not enough AP" };
  }
  const r = removeCardFromSlot(loadout, slotIdx);
  if (!r.ok) {
    // Defensive: should never happen because we validated slot above.
    // If it does, the AP spend has already committed; the precondition
    // check upstream means we never expect to land here.
    return { ok: false, reason: r.reason };
  }
  if (ts.cardPlacedThisTurn?.slotIdx === slotIdx) {
    ts.cardPlacedThisTurn = null;
  }
  // Self-heal the prepared-to-run latch mid-turn if the refresh
  // restored a playable weapon to hand. See the jsdoc above for the
  // rationale — without this, the latch would remain sticky and the
  // mandatory placement would silently reject.
  if (enc.preparedToRun[heroId] && hasPlayableWeaponInHand(state, heroId)) {
    enc.preparedToRun[heroId] = false;
  }
  return { ok: true };
}

/**
 * Spend 5 AP to refresh EVERY exhausted weapon card back to hand
 * (rulebook AP table: "5 AP: Spending 5 AP allows a player to
 * refresh all Weapon Cards"). Missing pre-2026-07-22 — the AP menu
 * only offered Double Movement (1) and single refresh (2).
 *
 * Same semantics as {@link spendApRefreshWeapon}, batched:
 *   - spendable any time during the active delver's turn,
 *   - clears `cardPlacedThisTurn` if the just-placed slot was among
 *     the refreshed ones (the action-used latch stays),
 *   - NOT gated on `preparedToRun` and self-heals that latch when
 *     the refresh restores a playable weapon (escape-hatch rationale
 *     in the single-refresh jsdoc above),
 *   - rejected when no slot holds a card (nothing to refresh) or
 *     currentAp < 5.
 */
export function spendApRefreshAllWeapons(
  state: CampaignState,
  heroId: string,
): TurnActionResult {
  const enc = state.encounter;
  if (!enc) return { ok: false, reason: "no encounter in progress" };
  if (heroId !== state.currentDelverId) {
    return { ok: false, reason: "not the active delver" };
  }
  const ts = enc.turnState[heroId];
  if (!ts) return { ok: false, reason: "no turn state for delver" };
  const loadout = state.loadouts[heroId];
  if (!loadout) return { ok: false, reason: "no loadout for delver" };
  const filledSlots: number[] = [];
  for (let i = 0; i < loadout.slotCards.length; i++) {
    if (loadout.slotCards[i] !== null && !isStolenCard(state, heroId, loadout.slotCards[i]!)) filledSlots.push(i);
  }
  if (filledSlots.length === 0) {
    return { ok: false, reason: "no exhausted weapon cards to refresh" };
  }
  if (!chargeAp(state, heroId, 5)) {
    return { ok: false, reason: "not enough AP" };
  }
  for (const slotIdx of filledSlots) {
    const r = removeCardFromSlot(loadout, slotIdx);
    if (!r.ok) continue; // defensive — slot validated above
    if (ts.cardPlacedThisTurn?.slotIdx === slotIdx) {
      ts.cardPlacedThisTurn = null;
    }
  }
  if (enc.preparedToRun[heroId] && hasPlayableWeaponInHand(state, heroId)) {
    enc.preparedToRun[heroId] = false;
  }
  return { ok: true };
}

/**
 * Declare Prepare to Run for `heroId` (DESIGN.md §5.7). Sticky for the
 * rest of the wave: once true, cannot be undone. Wave-end transition
 * (when both delvers have prepared) lands in Slice 4d.
 *
 * Rejected when:
 *   - no encounter is in progress,
 *   - the delver has already prepared,
 *   - the delver has already started this turn by placing a card
 *     (you can only declare in lieu of placement, not after).
 */
export function prepareToRun(
  state: CampaignState,
  heroId: string,
): TurnActionResult {
  const enc = state.encounter;
  if (!enc) return { ok: false, reason: "no encounter in progress" };
  if (enc.preparedToRun[heroId]) {
    return { ok: false, reason: "already prepared to run" };
  }
  const ts = enc.turnState[heroId];
  if (ts && ts.cardPlacedThisTurn !== null) {
    return { ok: false, reason: "cannot prepare after placing a card this turn" };
  }
  enc.preparedToRun[heroId] = true;
  return { ok: true };
}

// --- Stage 2: optional Action step (DESIGN.md §5.2) ----------------------

/**
 * Common Action-step gate (DESIGN.md §5.2.1). Returns null on
 * success or a rejection reason on any failure. Used by both
 * `useWeaponAbility` and `useSlotAbility` so the rule lives in one
 * place.
 */
function checkActionGate(
  state: CampaignState,
  heroId: string,
  slotIdx: number,
  options: { skipActionUsedCheck?: boolean } = {},
): string | null {
  const enc = state.encounter;
  if (!enc) return "no encounter in progress";
  if (heroId !== state.currentDelverId) return "not the active delver";
  if (enc.preparedToRun[heroId]) return "delver has prepared to run";
  const ts = enc.turnState[heroId];
  if (!ts) return "no turn state for delver";
  if (ts.cardPlacedThisTurn === null) return "no card placed this turn (placement required first)";
  if (ts.cardPlacedThisTurn.slotIdx !== slotIdx) {
    return `slot ${slotIdx} is not this turn's placed slot`;
  }
  // Free-repeat (Soulshift Sword) intentionally bypasses this — the
  // triggering swing has already consumed the action; the bonus swing
  // is FREE per card text. All other action-gate constraints still
  // apply.
  if (!options.skipActionUsedCheck && ts.actionUsedThisTurn) {
    return "action already used this turn";
  }
  return null;
}

/**
 * Action-gates-REMAINING-movement rule (DESIGN.md §5.1, refined
 * 2026-05-18). Call this immediately after the action latches
 * (`ts.actionUsedThisTurn = true`) in `useWeaponAbility` and
 * `useSlotAbility`.
 *
 * Semantics: if the action fires while a movement session is
 * IN-PROGRESS (at least one step has been taken but the session
 * hasn't ended via MP=0 or `endMovementStep`), the action TERMINATES
 * that session — remaining MP is forfeit. We model this by latching
 * `movementUsedThisTurn = true`, which is already the universal
 * "no more stepping this turn" signal read by `legalStepDestinations`,
 * `BoardScreen`, and the cheatsheet.
 *
 * No exceptions (designer ruling 2026-11-17): the "+1 movement this
 * turn" slot ability ends an in-progress movement like every other
 * action; you can't move, act and then move again.
 *
 * What this DOES NOT do: it does not affect the "action-then-move"
 * ordering. If steps=0 at action time, the helper is a no-op and the
 * player keeps their full fresh MP pool to spend after the action
 * (including any MP they acquire post-action via AP-double-mov or a
 * slot ability) — see USER REPRO 2026-05-18 in `turn.test.ts`.
 *
 * Bug history:
 *   - Pre-2026-05-18: rule was "actionUsedThisTurn → all movement
 *     blocked", silently blocked Body delver from moving on turns
 *     they hadn't moved yet (Chain Gauntlet swing → end turn).
 *   - 2026-05-18 first refinement put the gate in
 *     `legalStepDestinations` as `actionUsedThisTurn &&
 *     movementStepsThisTurn > 0 && !actionGrantedExtraMovement → []`,
 *     which restored action-then-move but then BROKE the user repro
 *     "action → AP-double-mov → step → step" — the gate couldn't
 *     distinguish "stepped before action" (forfeit remaining) from
 *     "stepped after action with fresh MP" (still spendable).
 *   - 2026-05-18 second refinement (this helper): move the gate to
 *     the action helpers themselves and capture the timing
 *     semantics in the existing `movementUsedThisTurn` flag at the
 *     moment the action fires. `legalStepDestinations` returns to
 *     reading a single canonical signal.
 */
export function endMovementSessionIfActionInterruptsIt(ts: HeroTurnState): void {
  if (ts.movementStepsThisTurn > 0 && !ts.movementUsedThisTurn) {
    ts.movementUsedThisTurn = true;
  }
}

/**
 * Inputs for `useWeaponAbility` — one variant per `WeaponRange.kind`.
 * The UI builds these from user clicks / die-roll modals.
 */
export type WeaponAbilityParams =
  | {
      kind: "single-adjacent";
      targetX: number;
      targetY: number;
      /**
       * Mace (both suits R1) `target-filter-or-spend-element`
       * OR-mode: if set, the engine debits 1 of `element` from the
       * bearer's bag and BYPASSES the card's UNDAMAGED / DAMAGED
       * targeting filter. Player-pick across element kinds in the
       * bag. Damage is unchanged from default mode.
       *
       * Rejected (with no element debit) when:
       *   - the placed card has no `target-filter-or-spend-element`
       *     effect (defensive — keeps the bypass Mace-scoped),
       *   - the bearer's bag has 0 of the named element.
       *
       * When unset, the engine enforces the filter against the
       * target enemy's `damageTaken`. Cards without the filter
       * effect ignore this param entirely.
       *
       * Recorded as a `target-bypass-spend-element` PreEffect on
       * the session for the audit trail.
       */
      spendElementForTargetBypass?: { element: Element };
    }
  | { kind: "straight-line"; targetX: number; targetY: number }
  | {
      kind: "die-roll-fixed";
      /** Final d6 value (already flipped by UI if `suffered` is true). */
      dieRoll: number;
      /**
       * True if the player paid 1 HP via the
       * `may-reroll-by-suffering` effect (Hammer). Engine applies the
       * 1 self-damage and records it in the session preEffects.
       */
      suffered?: boolean;
    }
  | { kind: "chain"; targetX: number; targetY: number }
  /**
   * Trident (both suits R1). `fixed-pattern` weapons take no
   * targeting input — every printed offset fires every swing. The
   * UI carries no target picker for this kind, just the optional
   * pre-attack move (see {@link UseWeaponAbilityOptions.preAttackMove}).
   */
  | { kind: "fixed-pattern" }
  /** Fabled Hammer: no input - every enemy between the two delvers. */
  | { kind: "between-delvers" }
  /** Precise Shockwave: the enemy tiles the player picked. */
  | { kind: "choose-targets"; targets: { x: number; y: number }[] };

/** The "Spend N [element]: ..." options a Machinist upgrade weapon prints. */
export type WeaponSpendOption =
  | "spend-element-damage-all-enemies"
  | "spend-element-block-counterattacks"
  | "spend-element-extra-adjacent-damage"
  | "spend-element-bonus-damage"
  | "spend-element-die-multiplier";

export type UseAbilityResult =
  | { ok: true; session: AttackSession }
  | { ok: false; reason: string };

/**
 * Optional knobs for {@link useWeaponAbility}. Defaults are zero-cost
 * — every existing call site (including all tests) compiles unchanged.
 */
export interface UseWeaponAbilityOptions {
  /**
   * If true, treat this invocation as a FREE repeat swing (Soulshift
   * Sword "If the target dies, roll a die. On 4-6, repeat if able.").
   * Specifically:
   *   - Skip the `actionUsedThisTurn` half of the action gate. The
   *     placed-card / slot / phase / not-prepared-to-run checks STILL
   *     apply. (`actionUsedThisTurn` is already true from the
   *     triggering swing.)
   *   - Do NOT re-latch `actionUsedThisTurn` on success; it stays
   *     true.
   *   - Do NOT replay one-shot pre-effects whose semantics belong to
   *     the FIRST swing only. Today the only such effect is
   *     `collect-creature-part` (Surge Claw — chain weapons can't
   *     repeat-on-kill so this is theoretical, but enforcing the
   *     invariant here means future repeat-on-kill weapons that ALSO
   *     ship a `collect-creature-part` won't double-grant parts).
   *     `additional-damage-if-delvers-adjacent` is recomputed each
   *     swing because the board may have shifted between swings.
   */
  freeRepeat?: boolean;

  /**
   * Trident `pre-attack-may-move-adjacent`: optionally push an
   * 8-way-adjacent enemy 1 tile BEFORE damage resolves. The new
   * position is what the printed pattern targets. Validated against
   * `legalMoveDestinationsForEnemy` (8-way around the enemy's
   * current tile, not occupied by another enemy or a delver, on-
   * board). The engine REJECTS the entire invocation if the move is
   * illegal — UI is expected to only offer legal targets / dests.
   *
   * Only valid when the placed weapon card carries a
   * `pre-attack-may-move-adjacent` effect; passing it for any other
   * card is a hard reject (defensive — keeps the rule "this is a
   * Trident-only sub-flow" enforced at the engine boundary).
   *
   * Recorded as a `pre-attack-move-enemy` PreEffect on the session.
   */
  preAttackMove?: {
    enemyInstanceId: string;
    toX: number;
    toY: number;
  };

  /**
   * Supercharger / future "double damage" tokens: the player may
   * spend ONE Double Damage token alongside this swing to double
   * the damage. The kind MUST be either `damage-2x-universal`
   * (always doubles) or the typed kind matching the weapon's
   * printed `damageType` (e.g. `damage-2x-light` only doubles a
   * Light swing — see `engine/tokens.ts > doubledDamageMultiplier`).
   *
   * Engine validates via `canSpendDoubleDamage` (token available +
   * per-turn cap not yet hit). On success it spends the token (bag
   * available -> spent + flips `damage2xUsedThisTurn`) BEFORE the
   * AttackSession is built, so a swing that ultimately rejects on
   * a downstream gate does NOT eat the token. (Today the only
   * downstream gates fire BEFORE this point — pre-attack move,
   * weapon-ability gate — so the ordering is conservative; if a
   * future gate fires AFTER, it'd need to refund the token.)
   *
   * Mismatched typed kinds (e.g. spending a `damage-2x-light` on a
   * Heavy swing) ARE rejected — the spend would be wasted otherwise.
   * UI is expected to only surface matching tokens, but the engine
   * guards in case the player drives via console / stale UI.
   */
  spendDoubleDamage?: ConsumableTokenKind;

  /**
   * Machinist upgrade weapons: the "Spend N [element]: ..." options the
   * player chose for this swing (each must be printed on the card and
   * affordable; their elements are debited together after every gate).
   */
  spends?: WeaponSpendOption[];
  /** `spend-element-die-multiplier` (Lunar Trident): the rolled d6. */
  dieMultiplierRoll?: number;
  /** `spend-element-extra-adjacent-damage` (Precise Shockwave): the
   *  adjacent enemy that takes the additional damage. */
  extraTarget?: { x: number; y: number };
}

/**
 * Use the placed card's printed Weapon Ability (DESIGN.md §5.2.1).
 *
 * Validates the gate, computes hit tiles via `computeWeaponHitTiles`,
 * applies any pre-effects (e.g. Hammer self-suffer, Flicker Blade
 * adjacent-bonus damage), builds an `AttackSession`, latches
 * `actionUsedThisTurn = true`, and returns the session for the UI to
 * step through one counter prompt at a time.
 *
 * Rejection paths leave state unchanged and do NOT latch
 * `actionUsedThisTurn` — the player may try again with different
 * params (e.g. picking a different target).
 *
 * See {@link UseWeaponAbilityOptions.freeRepeat} for the Soulshift
 * Sword bonus-swing entry point.
 */
export function useWeaponAbility(
  state: CampaignState,
  heroId: string,
  slotIdx: number,
  params: WeaponAbilityParams,
  options: UseWeaponAbilityOptions = {},
): UseAbilityResult {
  const gateErr = checkActionGate(state, heroId, slotIdx, {
    skipActionUsedCheck: options.freeRepeat === true,
  });
  if (gateErr) return { ok: false, reason: gateErr };

  const enc = state.encounter!;
  const ts = enc.turnState[heroId]!;
  const cardId = ts.cardPlacedThisTurn!.cardId;
  const card = getEquipment(cardId);
  if (card.category !== "weapon" || !card.range) {
    return { ok: false, reason: "placed card has no weapon ability" };
  }

  // Resolve the rank-correct card so effects read from the actual rank the
  // delver owns. The hand always stores the R1 card ID for backward
  // compatibility, but effects (e.g. collect-creature-part count, presence of
  // may-reroll-by-suffering) may differ between R1 and higher ranks.
  const effectiveRanks = getEffectiveEquipmentRanks(state, heroId);
  const effectiveRank = effectiveRanks[card.type as EquipmentType] ?? 1;
  // Variant-aware (2026-07-22): a Machinist-replaced family (Shock
  // Gauntlet et al.) supplies its own range + effects here. Its range
  // kind can differ from the standard card's (Fabled Hammer vs Hammer),
  // so the params are checked against the ranked card.
  const rankedCard = getEquipmentCardFor(state, heroId, card.type as EquipmentType, effectiveRank);
  const playedRange = rankedCard.range ?? card.range;
  if (playedRange.kind !== params.kind) {
    return {
      ok: false,
      reason: `weapon range kind mismatch: card=${playedRange.kind} params=${params.kind}`,
    };
  }

  const attackerPos = getDelverAt(enc, heroId);
  if (!attackerPos) return { ok: false, reason: "attacker not on board" };
  const otherHeroId = Object.keys(state.loadouts).find((id) => id !== heroId) ?? null;
  const otherDelverPos = otherHeroId ? getDelverAt(enc, otherHeroId) : null;
  const board = QUEST1.waves[0]!.spawn.boardSize;

  // Trident: optional `preAttackMove` mutates the board BEFORE
  // `computeWeaponHitTiles` runs so the printed pattern targets the
  // enemy's NEW position. Validated against `legalMoveDestinationsForEnemy`
  // (the same 8-way / on-board / not-occupied check Boots uses for
  // its move-adjacent-enemy ability). REJECT the entire invocation if:
  //   - the placed weapon doesn't carry `pre-attack-may-move-adjacent`
  //     (defensive: keeps the sub-flow Trident-scoped),
  //   - the named enemy doesn't exist or is dead,
  //   - the enemy isn't 8-way-adjacent to the bearer,
  //   - the destination isn't a legal move destination for the enemy.
  // The session is NOT built on rejection so `actionUsedThisTurn` stays
  // false and the player can retry.
  const preEffects: PreEffect[] = [];
  if (options.preAttackMove) {
    const hasMoveEffect = (card.effects ?? []).some(
      (e) => e.kind === "pre-attack-may-move-adjacent",
    );
    if (!hasMoveEffect) {
      return { ok: false, reason: "placed card has no pre-attack move effect" };
    }
    const enemy = getEnemyInstance(enc, options.preAttackMove.enemyInstanceId);
    if (!enemy || !enemy.alive) {
      return { ok: false, reason: "pre-attack move target enemy not found or dead" };
    }
    const dxAdj = Math.abs(enemy.x - attackerPos.x);
    const dyAdj = Math.abs(enemy.y - attackerPos.y);
    if (dxAdj > 1 || dyAdj > 1 || (dxAdj === 0 && dyAdj === 0)) {
      return { ok: false, reason: "pre-attack move target enemy not 8-way adjacent to bearer" };
    }
    const legalDests = legalMoveDestinationsForEnemy(state, enemy.instanceId, board);
    const dest = legalDests.find(
      (d) => d.x === options.preAttackMove!.toX && d.y === options.preAttackMove!.toY,
    );
    if (!dest) {
      return { ok: false, reason: "pre-attack move destination is not a legal tile" };
    }
    const from = { x: enemy.x, y: enemy.y };
    enemy.x = dest.x;
    enemy.y = dest.y;
    preEffects.push({
      kind: "pre-attack-move-enemy",
      heroId,
      enemyInstanceId: enemy.instanceId,
      from,
      to: { x: dest.x, y: dest.y },
    });
  }

  // Resolve hit tiles against the RANK-CORRECT range, not the R1
  // placeholder stored in the slot (DESIGN.md §5.2.1). Hammer R2-R5
  // widens from 1 tile to 3 tiles in a line; Trident R2-R5 widens
  // from 3 fixed tiles to 6. Reading `card.range` here would silently
  // fire the R1 footprint regardless of the bearer's effective rank,
  // matching the documented bug from session 20260509-152644-4tyt
  // (Hammer R2 hit only the first minion in the line). The kind-stable
  // check at line 983 keeps `params.kind` aligned with both ranks since
  // every weapon family keeps a consistent `range.kind` across ranks.
  const effectiveRange = rankedCard.range ?? card.range;
  const hitRes = computeWeaponHitTiles({
    range: effectiveRange,
    attackerPos,
    otherDelverPos,
    encounter: enc,
    board,
    dieRoll: params.kind === "die-roll-fixed" ? params.dieRoll : undefined,
    chosenStartTile:
      params.kind === "die-roll-fixed" || params.kind === "fixed-pattern"
        || params.kind === "between-delvers" || params.kind === "choose-targets"
        ? undefined
        : { x: params.targetX, y: params.targetY },
    chosenTargets: params.kind === "choose-targets" ? params.targets : undefined,
  });
  if (!hitRes.ok) {
    // If the hit computation failed but the card carries a
    // collect-creature-part effect (Surge Claw), allow the ability
    // to fire with 0 hit tiles so the post-effect still grants the
    // part even when there are no valid chain targets.
    const canCollectWithoutAttack = (rankedCard.effects ?? []).some(
      (e) => e.kind === "collect-creature-part",
    );
    if (!canCollectWithoutAttack) {
      return { ok: false, reason: hitRes.reason };
    }
  }
  const hitTiles = hitRes.ok ? hitRes.tiles : [];

  // Machinist upgrade "Spend N [element]: ..." options - validated here
  // (printed on the card, affordable, inputs present); elements are
  // debited together with the other spends below, after every gate.
  const spendEffects = (options.spends ?? []).map((kind) => {
    const eff = (rankedCard.effects ?? []).find((e) => e.kind === kind);
    if (!eff) return null;
    return eff as Extract<NonNullable<typeof rankedCard.effects>[number], { kind: WeaponSpendOption }>;
  });
  if (spendEffects.some((e) => e === null)) {
    return { ok: false, reason: "a chosen spend option isn't printed on this card" };
  }
  const spendCost: Partial<Record<Element, number>> = {};
  for (const eff of spendEffects) spendCost[eff!.element] = (spendCost[eff!.element] ?? 0) + eff!.cost;
  for (const [el, cost] of Object.entries(spendCost) as [Element, number][]) {
    if ((state.elements[heroId]?.[el] ?? 0) < cost) {
      return { ok: false, reason: `needs ${cost} ${el} for the chosen spend options` };
    }
  }
  const spendKinds = new Set(options.spends ?? []);
  if (spendKinds.has("spend-element-die-multiplier")
      && !(options.dieMultiplierRoll && options.dieMultiplierRoll >= 1 && options.dieMultiplierRoll <= 6)) {
    return { ok: false, reason: "the die-multiplier spend needs a d6 roll" };
  }
  if (spendKinds.has("spend-element-extra-adjacent-damage")) {
    const t = options.extraTarget;
    if (!t || Math.max(Math.abs(t.x - attackerPos.x), Math.abs(t.y - attackerPos.y)) !== 1 || !getEnemyAt(enc, t.x, t.y)) {
      return { ok: false, reason: "the additional damage needs an adjacent enemy target" };
    }
  }

  // Mace `target-filter-or-spend-element` resolution.
  //
  // For `single-adjacent` weapons that print the filter+bypass
  // effect (Mace today): VALIDATE the chosen mode here — but defer
  // the element-bag debit until after every other rejection gate
  // has passed (DD validation below). The deferred debit means a
  // wasted-spend prompt that bounces on DD doesn't eat an element.
  //
  // Reject paths (no state mutation):
  //   - spendElementForTargetBypass set on a card with NO
  //     `target-filter-or-spend-element` effect (defensive — keeps
  //     the bypass scoped to cards that print it),
  //   - spendElementForTargetBypass set but the bearer's bag has 0
  //     of the named element,
  //   - spendElementForTargetBypass UNSET on a Mace whose target
  //     enemy doesn't match the printed UNDAMAGED / DAMAGED filter.
  //
  // Cards without the filter effect ignore the param entirely (the
  // first reject above), so existing single-adjacent weapons (Sword,
  // Soulshift Sword, …) compile + pass through unchanged.
  let pendingMaceSpend: { element: Element } | null = null;
  if (params.kind === "single-adjacent") {
    // The PLAYED card's filter: a Machinist variant (War Mace) has none.
    const filterEff = (rankedCard.effects ?? []).find(
      (e): e is Extract<typeof e, { kind: "target-filter-or-spend-element" }> =>
        e.kind === "target-filter-or-spend-element",
    );
    if (params.spendElementForTargetBypass) {
      if (!filterEff) {
        return {
          ok: false,
          reason: "placed card has no target-filter-or-spend-element effect; cannot bypass",
        };
      }
      const bag = state.elements[heroId] ?? {};
      const have = bag[params.spendElementForTargetBypass.element] ?? 0;
      if (have < 1) {
        return {
          ok: false,
          reason: `bag has 0 of ${params.spendElementForTargetBypass.element}; cannot spend to bypass`,
        };
      }
      pendingMaceSpend = { element: params.spendElementForTargetBypass.element };
    } else if (filterEff) {
      // Default mode — enforce the filter against the target enemy.
      const targetEnemy = (() => {
        for (const e of enc.enemies) {
          if (e.alive && e.x === params.targetX && e.y === params.targetY) return e;
        }
        return null;
      })();
      if (!targetEnemy) {
        return { ok: false, reason: "no live enemy on target tile" };
      }
      const matchesUndamaged = targetEnemy.damageTaken === 0;
      const ok = filterEff.filter === "undamaged" ? matchesUndamaged : !matchesUndamaged;
      if (!ok) {
        return {
          ok: false,
          reason: `target enemy is not ${filterEff.filter} (spend an element to bypass)`,
        };
      }
    }
  }

  // Optional Double Damage token spend (Supercharger grants).
  // Validates first so a wasted-spend prompt has the engine's
  // veto. Spending here means a downstream `freeRepeat` swing
  // does NOT consume another token — the per-turn cap is
  // already latched and the ts flag would block a second spend.
  // The PLAYED card's damage type (a Machinist variant can differ).
  const playedDamageType = rankedCard.damageType ?? card.damageType;
  if (options.spendDoubleDamage) {
    if (!playedDamageType) {
      return { ok: false, reason: "weapon has no damage type; cannot spend Double Damage" };
    }
    const matching = typedDoubleDamageKindFor(playedDamageType);
    if (
      options.spendDoubleDamage !== matching &&
      options.spendDoubleDamage !== "damage-2x-universal"
    ) {
      return {
        ok: false,
        reason: `cannot spend ${options.spendDoubleDamage} on a ${playedDamageType} swing`,
      };
    }
    const check = canSpendDoubleDamage(state, heroId, options.spendDoubleDamage);
    if (!check.ok) return { ok: false, reason: check.reason };
    spendToken(state, heroId, options.spendDoubleDamage);
    preEffects.push({
      kind: "double-damage-spend",
      heroId,
      tokenKind: options.spendDoubleDamage,
    });
  }

  // Mace element debit — committed AFTER every gate above has
  // passed (so a rejected DD spend doesn't eat an element). The
  // PreEffect is the audit trail; UI surfaces it in the action log.
  if (pendingMaceSpend) {
    const bag = state.elements[heroId] ?? {};
    const have = bag[pendingMaceSpend.element] ?? 0;
    bag[pendingMaceSpend.element] = have - 1;
    state.elements[heroId] = bag;
    logEvent("engine.spendElement", {
      heroId,
      element: pendingMaceSpend.element,
      reason: "mace-target-bypass",
      cardId,
      newTotal: have - 1,
    });
    preEffects.push({
      kind: "target-bypass-spend-element",
      heroId,
      element: pendingMaceSpend.element,
    });
  }

  // Debit the chosen spend options' elements (all gates have passed).
  for (const [el, cost] of Object.entries(spendCost) as [Element, number][]) {
    const bag = state.elements[heroId] ?? {};
    bag[el] = (bag[el] ?? 0) - cost;
    state.elements[heroId] = bag;
    logEvent("engine.spendElement", { heroId, element: el, amount: cost, reason: "weapon-spend-option", cardId: rankedCard.id });
    preEffects.push({ kind: "weapon-spend", heroId, element: el, amount: cost });
  }

  // Compute base damage + any per-card damage modifiers. Reads the
  // delver's per-equipment-type rank table so upgraded weapons (R2-R5
  // via level-up) deal the rank-scaled damage automatically.
  let damage = effectiveDamageForCard(state, heroId, card);
  let swingDamageType = rankedCard.damageType ?? card.damageType ?? null;
  const postEffects: PostEffect[] = [];

  // War Mace: the printed damage is for a boss; a minion target takes the
  // override damage instead and the bearer gains 1 element of their choice.
  const minionOverride = (rankedCard.effects ?? []).find((e) => e.kind === "minion-damage-override");
  if (minionOverride && minionOverride.kind === "minion-damage-override" && params.kind === "single-adjacent") {
    const target = getEnemyAt(enc, params.targetX, params.targetY);
    if (target && getEnemy(target.cardId).kind === "minion") {
      damage = minionOverride.multiplier * (damageValueForType(minionOverride.damageType)
        + (state.shopDamageBonus[heroId]?.[minionOverride.damageType] ?? 0));
      swingDamageType = minionOverride.damageType;
      for (let i = 0; i < minionOverride.gainElementChoice; i++) {
        enqueueElementChoice(state, { heroId, source: { kind: "weapon", cardId: rankedCard.id } });
      }
    }
  }

  // Sword of Ruin "Spend 2 Wind: Additional Nx HEAVY damage".
  for (const eff of spendEffects) {
    if (eff!.kind === "spend-element-bonus-damage") {
      damage += eff!.multiplier * effectiveDamageForType(state, heroId, eff!.damageType);
    }
  }
  // Lunar Trident "Spend 2 Void: roll a die and multiply damage by the result".
  if (spendKinds.has("spend-element-die-multiplier")) {
    damage *= options.dieMultiplierRoll!;
    preEffects.push({ kind: "die-multiplier", heroId, roll: options.dieMultiplierRoll! });
  }

  // Hammer: may-reroll-by-suffering — UI signals via `suffered`. Engine
  // applies the 1 self-damage and records it.
  if (params.kind === "die-roll-fixed" && params.suffered) {
    const loadout = state.loadouts[heroId];
    if (loadout) {
      damageDelverInWave(state, heroId, 1);
      preEffects.push({ kind: "self-suffer", heroId, amount: 1 });
    }
  }

  // Flicker Blade etc.: additional-damage-if-delvers-adjacent applies
  // when the two delvers are 8-way-adjacent or sharing a tile. Folded
  // into the running total BEFORE the Double Damage multiplier so the
  // doubler applies to the FULL swing damage (player-intuitive: "I
  // activated 2x — my next swing's damage doubles, period"). For a R1
  // Flicker Blade with delvers adjacent that means
  // `(2 medium + 1 light) * 2 = 6` rather than the older
  // `(2 medium * 2) + 1 light = 5`.
  //
  // Reads the RANK-CORRECT card (not the R1 placeholder in `card`) so
  // the bonus scales with rank — Flicker Blade R2 prints "Additional
  // 2x LIGHT" (verified against the card JPG 2026-07-20). Same
  // R1-placeholder bug class as the Shockwave/Trident counter-block
  // fix in `combat.ts > weaponCounterBlockEffects`.
  damage += additionalDamageBonus(state, heroId, rankedCard, attackerPos, otherDelverPos);

  // Shock Gauntlet (Equipment Upgrade): "If you're at or below 50%
  // HP, deal additional Nx MEDIUM damage to that chain." Same
  // fold-in point as the Flicker Blade combo above so the Double
  // Damage multiplier applies to the FULL swing.
  {
    const lo = state.loadouts[heroId];
    if (lo) {
      for (const eff of rankedCard.effects ?? []) {
        if (eff.kind === "additional-damage-if-low-hp"
            && lo.currentHp * 100 <= lo.maxHp * eff.thresholdPercent) {
          damage += eff.multiplier * effectiveDamageForType(state, heroId, eff.damageType);
        }
      }
    }
  }

  // Double Damage applies if:
  //   (a) the caller explicitly spent a token this swing (options.spendDoubleDamage),
  //   (b) a typed DD token matching this weapon's damage type was spent EARLIER
  //       this turn (doubleDamageActive[damageType] === true), or
  //   (c) a universal DD token was spent earlier this turn.
  // Case (a) has already run spendToken above, so doubleDamageActive is now set
  // for (a) too — a single check of the turn-state flag covers all three cases.
  // Applied LAST so the multiplier covers both the printed swing damage AND
  // any composed additional-damage bonuses (Flicker Blade adjacency, etc.).
  const damageTypeKey = playedDamageType ?? "";
  const ts2x = state.encounter?.turnState[heroId];
  const isDoubled = !!(ts2x?.doubleDamageActive[damageTypeKey] || ts2x?.doubleDamageActive["universal"]);
  if (isDoubled) damage *= 2;

  // Surge Claw: collect-creature-part fires after the chain damage.
  // Grants to the attacker only — the "from any tile" clause means
  // no adjacency restriction, not that all delvers gain a part.
  // SKIPPED on free-repeat swings: the printed pickup happens once per
  // ability use (the triggering swing), not per chain-link.
  if (!options.freeRepeat) {
    for (const eff of rankedCard.effects ?? []) {
      if (eff.kind === "collect-creature-part") {
        postEffects.push({
          kind: "collect-creature-part",
          count: eff.count,
          sourceCardId: rankedCard.id,
        });
      }
    }
  }

  // Commit: latch action AFTER inputs validate but BEFORE returning.
  // Free-repeat (Soulshift Sword) leaves the existing `true` in place;
  // we don't toggle it since the triggering swing already set it.
  if (!options.freeRepeat) {
    ts.actionUsedThisTurn = true;
    endMovementSessionIfActionInterruptsIt(ts);
  }

  // Scorchline Beam (Suit A R2-R5) repeat-attack accounting:
  //   - First swing seeds the bearer's pending-repeat counter from
  //     the rank-correct `repeat-attack.count`.
  //   - Each subsequent freeRepeat swing decrements the counter by 1.
  // The "Fire Again?" prompt in `screens/ActionResolution.ts >
  // advanceAfterAction` reads the counter post-finalise. Suit B's
  // Ion Cannon Beam has no `repeat-attack` effect, so `seed` is a
  // no-op for it.
  if (params.kind === "straight-line") {
    if (!options.freeRepeat) {
      for (const eff of rankedCard.effects ?? []) {
        if (eff.kind === "repeat-attack") {
          seedBeamRepeats(state, heroId, eff.count);
          break;
        }
      }
    } else {
      consumeOneBeamRepeat(state, heroId);
    }
  }

  // Extra hits from spend options (own damage + type per hit).
  const extraHits: HitTile[] = [];
  for (const eff of spendEffects) {
    if (eff!.kind === "spend-element-damage-all-enemies") {
      const dmg = eff!.multiplier * effectiveDamageForType(state, heroId, eff!.damageType);
      for (const e of enc.enemies) {
        if (e.alive && !e.linkedTo) extraHits.push({ x: e.x, y: e.y, damage: dmg, damageType: eff!.damageType });
      }
    }
    if (eff!.kind === "spend-element-extra-adjacent-damage") {
      extraHits.push({ ...options.extraTarget!, damage: eff!.multiplier * effectiveDamageForType(state, heroId, eff!.damageType), damageType: eff!.damageType });
    }
  }
  const gainOnKill = (rankedCard.effects ?? []).find((e) => e.kind === "gain-element-on-kill");

  const session = buildAttackSession({
    attackerId: heroId,
    source: { kind: "weapon", slotIdx, cardId },
    damage,
    damageType: swingDamageType,
    blockCounterattacks: spendKinds.has("spend-element-block-counterattacks"),
    gainElementOnKill: gainOnKill && gainOnKill.kind === "gain-element-on-kill"
      ? { element: gainOnKill.element, amount: gainOnKill.amount } : undefined,
    hitTiles: [...hitTiles, ...extraHits],
    preEffects,
    postEffects,
  });
  return { ok: true, session };
}

/** Sum any damage modifiers from `card.effects` that depend on board state. */
function additionalDamageBonus(
  state: CampaignState,
  heroId: string,
  card: EquipmentCard,
  attackerPos: { x: number; y: number },
  otherDelverPos: { x: number; y: number } | null,
): number {
  let bonus = 0;
  for (const eff of card.effects ?? []) {
    if (eff.kind === "additional-damage-if-delvers-adjacent") {
      if (!otherDelverPos) continue;
      const dx = Math.abs(attackerPos.x - otherDelverPos.x);
      const dy = Math.abs(attackerPos.y - otherDelverPos.y);
      if (dx <= 1 && dy <= 1) {
        // N x <type> units, each at the delver's Shop-boosted value
        // (a +1 LIGHT bonus makes Flicker Blade R3's 3x LIGHT deal 6).
        bonus += eff.multiplier * effectiveDamageForType(state, heroId, eff.damageType);
      }
    }
  }
  return bonus;
}

export type UseSlotAbilityResult =
  | { ok: true; result: SlotAbilityResult }
  | { ok: false; reason: string };

/**
 * Use the placed slot's printed Slot Ability (DESIGN.md §5.2.1 + §5.8).
 *
 * Validates the gate, dispatches to `resolveSlotAbility`, latches
 * `actionUsedThisTurn = true` on success. For damage-any-enemy this
 * returns a session for the UI to step (one counter prompt). For all
 * other kinds it returns an immediate `applied` log.
 */
export function useSlotAbility(
  state: CampaignState,
  heroId: string,
  slotIdx: number,
  params: SlotAbilityParams,
): UseSlotAbilityResult {
  const gateErr = checkActionGate(state, heroId, slotIdx);
  if (gateErr) return { ok: false, reason: gateErr };

  const r = resolveSlotAbility(state, heroId, slotIdx, params);
  if (!r.ok) return { ok: false, reason: r.reason };

  const ts = state.encounter!.turnState[heroId]!;
  ts.actionUsedThisTurn = true;
  // Every slot ability, the +1 movement one included, ends a movement
  // already in progress (designer ruling 2026-11-17).
  endMovementSessionIfActionInterruptsIt(ts);
  return { ok: true, result: r.result };
}
