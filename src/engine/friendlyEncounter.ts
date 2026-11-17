/**
 * Friendly Encounter engine — Friendly Spawn Card grants +
 * board-token pickup + resolution.
 *
 * Three responsibilities, kept in one module so the full
 * lifecycle (grant -> draw -> pickup -> resolve) reads top-down:
 *
 *   1. `grantFriendlySpawnCard(state)` — append the next
 *      available friendly spawn card number to
 *      `state.friendlySpawnDeck`. Drawn from the printed pool
 *      (`FRIENDLY_SPAWN_CARD_NUMBERS` = [13, 14]) in order, so
 *      a fresh campaign granted twice always picks #13 first,
 *      then #14. Returns `[]` (with a skip log) once both
 *      printed friendlies are already owned.
 *
 *   2. `collectFriendlyEncountersAt(state, x, y)` — drain every
 *      `encounter.friendlyEncounters` entry on the tile; for each
 *      drained token draw one Friendly Encounter card number
 *      from the printed deck (today only #01 -- Flambe) and push
 *      it onto `state.pendingFriendlyEncounters`. Returns the
 *      list of drawn card numbers so callers (`moveDelverStep`,
 *      `stepWitness`) can include them in their own pickup
 *      summary.
 *
 *   3. `resolveFriendlyEncounter(state)` — pop the head of
 *      `pendingFriendlyEncounters` and return a
 *      `friendly-encounter-resolved` reward event. Called by
 *      the modal's Continue button.
 *
 * Persistence: `state.pendingFriendlyEncounters` lives at
 * CAMPAIGN scope so a player who reloads with an unresolved
 * encounter sees the modal again on next boot — mirrors the
 * `currentScenarioCard` pattern.
 *
 * Idempotency: `grantFriendlySpawnCard` is idempotent vs.
 * already-owned cards (skips silently). `collectFriendlyEncountersAt`
 * is idempotent vs. already-drained tiles (returns `[]`).
 * `resolveFriendlyEncounter` is idempotent vs. an empty queue
 * (logs + returns `[]`).
 */

import { gainMemoryChips } from "./opinionEffects";
import type { CampaignState } from "../state";
import type { RewardEvent } from "../types";
import {
  drawFriendlyEncounterCard,
  getFriendlyEncounterCard,
  getSpawnCard,
  nextFriendlySpawnCardNumber,
} from "../data";
import { logEvent } from "../debug/sessionLog";

/**
 * Try to grant one Friendly Spawn Card to the campaign. Walks
 * `FRIENDLY_SPAWN_CARD_NUMBERS` in printed order and appends the
 * first entry not yet in `state.friendlySpawnDeck`.
 *
 * Returns a single `friendly-spawn-card-gained` reward event on
 * success; returns `[]` (silent no-op + log) when every printed
 * friendly is already owned -- the storybook page that fires this
 * action still renders its narrative beat, but the rewards modal
 * just doesn't surface a card the player already has.
 */
export function grantFriendlySpawnCard(state: CampaignState): RewardEvent[] {
  const owned = state.friendlySpawnDeck;
  const nextNumber = nextFriendlySpawnCardNumber(owned);
  if (nextNumber === null) {
    logEvent("engine.friendlyEncounter.grant.skip", {
      reason: "all-owned",
      friendlySpawnDeckBefore: owned.slice(),
    });
    return [];
  }
  // Push onto the deck so the next wave bootstrap that calls
  // `shuffleSpawnDeckWithFriendly` picks it up. Storage order
  // doesn't matter (the shuffle is order-agnostic) but we keep
  // numeric-ascending so saves stay stable across grants.
  state.friendlySpawnDeck = [...owned, nextNumber].sort((a, b) => a - b);
  const card = getSpawnCard(nextNumber);
  logEvent("engine.friendlyEncounter.grant", {
    cardNumber: nextNumber,
    friendlySpawnDeckAfter: state.friendlySpawnDeck.slice(),
  });
  return [{
    kind: "friendly-spawn-card-gained",
    cardNumber: nextNumber,
    image: card.image,
    deckSize: state.friendlySpawnDeck.length,
  }];
}

/**
 * Drain every `encounter.friendlyEncounters` entry on tile (x, y)
 * and queue a Friendly Encounter card draw per token. Caller is
 * responsible for routing the queue through the modal (the
 * BoardScreen auto-mount handles that).
 *
 * Returns the list of drawn card numbers (one per drained
 * token). Empty when no encounter is in flight, no tokens sit on
 * the tile, or `state.encounter` is null.
 *
 * The draw uses `Math.random` via `drawFriendlyEncounterCard`. A
 * test-friendly overload lives in `data.ts` if a deterministic
 * draw is needed in the future.
 */
export function collectFriendlyEncountersAt(
  state: CampaignState,
  x: number,
  y: number,
): number[] {
  const enc = state.encounter;
  if (!enc) return [];
  const tokens = enc.friendlyEncounters;
  if (!tokens || tokens.length === 0) return [];
  const remaining: typeof tokens = [];
  const drawn: number[] = [];
  for (const t of tokens) {
    if (t.x === x && t.y === y) {
      drawn.push(drawFriendlyEncounterCard());
      continue;
    }
    remaining.push(t);
  }
  if (drawn.length === 0) return [];
  enc.friendlyEncounters = remaining;
  state.pendingFriendlyEncounters = [...state.pendingFriendlyEncounters, ...drawn];
  logEvent("engine.friendlyEncounter.collect", {
    x,
    y,
    drawn,
    pendingAfter: state.pendingFriendlyEncounters.slice(),
    tokensRemaining: remaining.length,
  });
  return drawn;
}

/**
 * Pop the head of `state.pendingFriendlyEncounters` and return a
 * `friendly-encounter-resolved` reward event for the rewards
 * modal. Idempotent against an empty queue (logs + returns `[]`).
 *
 * Effects: today the printed Friendly Encounter card (#01
 * Flambe) is resolved MANUALLY at the table -- the digital modal
 * shows the printed art + a Continue button and the player
 * applies the mechanical effect themselves (mirrors how
 * Scenario Cards #03..#09 are handled). Future cards with
 * auto-applied effects would land their per-effect reward events
 * here alongside the headline.
 */
export function resolveFriendlyEncounter(state: CampaignState, preRoll?: number): RewardEvent[] {
  const queue = state.pendingFriendlyEncounters;
  if (queue.length === 0) {
    logEvent("engine.friendlyEncounter.resolve.skip", { reason: "empty-queue" });
    return [];
  }
  const head = queue[0]!;
  state.pendingFriendlyEncounters = queue.slice(1);
  const card = getFriendlyEncounterCard(head);

  const events: RewardEvent[] = [];

  // Card #01 — Flambé: Both Delvers gain 1 die roll worth of Minion Parts.
  if (head === 1) {
    const roll = preRoll ?? Math.ceil(Math.random() * 6);
    const heroIds = Object.keys(state.minionParts);
    const recipients: { heroId: string; before: number; after: number }[] = [];
    for (const heroId of heroIds) {
      const before = state.minionParts[heroId] ?? 0;
      const after = before + roll;
      state.minionParts[heroId] = after;
      recipients.push({ heroId, before, after });
    }
    logEvent("engine.friendlyEncounter.resolve.flambe", {
      cardNumber: head,
      roll,
      recipients,
    });
    events.push({
      kind: "creature-parts-changed",
      partKind: "minion",
      direction: "gain",
      recipients,
    });
  }

  logEvent("engine.friendlyEncounter.resolve", {
    cardNumber: head,
    pendingAfter: state.pendingFriendlyEncounters.slice(),
  });
  events.push({
    kind: "friendly-encounter-resolved",
    cardNumber: head,
    name: card.name,
    image: card.frontImage,
  });
  return events;
}

/** True iff the campaign has any unresolved friendly encounter cards. */
export function hasPendingFriendlyEncounter(state: CampaignState): boolean {
  return state.pendingFriendlyEncounters.length > 0;
}

/**
 * Drain any memory fragment tokens at `(x, y)` and credit them to
 * `state.memoryChips`. Returns the number collected (0 when none).
 * Used by both delver (`engine/movement.ts`) and Witness
 * (`engine/witness.ts`) so pickup behaviour stays symmetric.
 */
export function collectMemoryFragmentsAt(
  state: CampaignState,
  x: number,
  y: number,
): number {
  const enc = state.encounter;
  if (!enc || !enc.memoryFragments || enc.memoryFragments.length === 0) return 0;
  let collected = 0;
  const remaining: typeof enc.memoryFragments = [];
  for (const mf of enc.memoryFragments) {
    if (mf.x === x && mf.y === y) {
      // The token leaves the board either way; Elias Nemesis stops the gain.
      collected += gainMemoryChips(state, 1);
    } else {
      remaining.push(mf);
    }
  }
  if (remaining.length !== enc.memoryFragments.length) enc.memoryFragments = remaining;
  return collected;
}
