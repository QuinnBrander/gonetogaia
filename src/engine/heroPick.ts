/**
 * Quest-start Hero Pick — owns the per-delver "which printed Hero
 * Card am I bringing into this quest?" decision flow.
 *
 * Two public entry points:
 *
 *   `populatePendingHeroPicks(state, questId)`
 *     Fires once per quest (idempotent via
 *     `state.heroPicksAppliedQuests`). For each delver, counts how
 *     many of their suit's hero cards the campaign has unlocked.
 *     Delvers owning 2+ get appended to
 *     `state.pendingHeroPickDelvers` in spawn order ("hero-01"
 *     first, "hero-02" second — matches the suit-board left-to-
 *     right convention used everywhere else in the UI). Delvers
 *     with 0 or 1 owned cards are skipped — they have nothing to
 *     choose between, so the picker would be busywork.
 *
 *     Adds `questId` to the applied list even when no delver
 *     needed to pick, so a Q1 entry (where neither delver has 2+)
 *     still latches and we don't re-evaluate every render.
 *
 *     Called from `screens/BoardScreen.ts` BEFORE
 *     `ensureEncounter` so the picker resolves first; the picked
 *     card number is stored in `state.activeHeroCardByDelver`
 *     and `commitHeroPick` immediately re-seeds the delver's
 *     equipment ranks + loadout via
 *     `reseedDelverFromActiveHeroCard` so the wave-bootstrap path
 *     sees the picked card's printed starting hand (cards #3-#6
 *     differ from the legacy heroId defaults — e.g. card #5 is
 *     Trident r2 + Mace r1, no shield/armor).
 *
 *   `commitHeroPick(state, heroId, cardNumber)`
 *     Resolves one queued pick. Validates that `heroId` is at the
 *     head of `pendingHeroPickDelvers` (FIFO), validates that
 *     `cardNumber` is in `unlockedHeroCards` AND matches the
 *     delver's suit (defensive — the UI gates both, but the
 *     engine is the source of truth), then:
 *       1. Writes `state.activeHeroCardByDelver[heroId] = cardNumber`
 *       2. Pops the head of `state.pendingHeroPickDelvers`
 *       3. Calls `reseedDelverFromActiveHeroCard(state, heroId)`
 *          — re-stamps `state.equipmentRanks` + `state.loadouts`
 *          from the picked card so the wave bootstraps with the
 *          right printed loadout (not whatever the previous
 *          quest's end-reset stamped)
 *
 *     Returns nothing — the caller is expected to `router.save()`
 *     (or `router.persist()` + `router.refresh()`) to pick up the
 *     queue mutation. Throws on validation failure rather than
 *     silently no-op'ing; the picker UI should never feed bad
 *     input.
 *
 * Resets:
 *   - `state.heroPicksAppliedQuests` and
 *     `state.activeHeroCardByDelver` are NOT wiped at quest end.
 *     Once you've picked Hero #3 for Q2 you stay as Hero #3 for
 *     all Q2 retries; the next quest re-fires the picker (since
 *     its id isn't in the applied list yet) and may flip the
 *     active card again.
 *
 * Why a separate file from `engine/encounter.ts`:
 *   - The hero pick is a CAMPAIGN-level decision (it predates the
 *     encounter — the encounter isn't built until the picker
 *     resolves), so coupling it to encounter bootstrap would
 *     muddy the encounter lifecycle. Keeping it standalone also
 *     makes the future "Redo my hero pick" affordance (Campaign
 *     Sheet → reset for the next quest) a 2-line addition.
 *
 * Added 2026-05-20 alongside the `HeroPick.ts` screen + the
 * v40 → v41 schema migration that introduced
 * `activeHeroCardByDelver` / `pendingHeroPickDelvers` /
 * `heroPicksAppliedQuests`.
 */

import { reseedDelverFromActiveHeroCard, type CampaignState } from "../state";
import { HERO_CARDS, getHero } from "../data";
import { logEvent } from "../debug/sessionLog";

/**
 * The fixed pick order. Mind delver picks first, then Body —
 * matches the suit-board left-to-right convention used by the
 * topbar / suit panels / spawn-pick tray. Exported so tests can
 * assert the queue without re-deriving it.
 */
export const HERO_PICK_ORDER: readonly string[] = ["hero-01", "hero-02"];

/**
 * Count how many of `suit`'s hero cards the campaign currently
 * owns. Used by `populatePendingHeroPicks` to decide if a delver
 * has a real choice to make at quest start, and by the
 * `HeroPick.ts` screen to render the owned-cards grid. The Shop
 * wallet uses the same filter — see `Shop.ts > ownedHeroCardCount`.
 */
export function ownedHeroCardNumbersForSuit(
  state: CampaignState,
  suit: "mind" | "body",
): number[] {
  return HERO_CARDS
    .filter((c) => c.suit === suit && state.unlockedHeroCards.includes(c.number))
    .map((c) => c.number);
}

/**
 * Populate `state.pendingHeroPickDelvers` with the delvers that
 * need to pick a hero card for this quest. Idempotent via
 * `state.heroPicksAppliedQuests` — second call for the same
 * `questId` is a no-op.
 *
 * Returns the (possibly empty) list of delvers added to the queue
 * so the caller can log / branch on whether the picker will fire.
 * The audit log records the same info via `logEvent`.
 */
export function populatePendingHeroPicks(
  state: CampaignState,
  questId: string,
): string[] {
  if (state.heroPicksAppliedQuests.includes(questId)) return [];
  const added: string[] = [];
  for (const heroId of HERO_PICK_ORDER) {
    const hero = getHero(heroId);
    const ownedCount = ownedHeroCardNumbersForSuit(state, hero.suit).length;
    if (ownedCount >= 2) {
      // Defensive: don't double-add if a previous (aborted) populate
      // already queued this delver. The applied-quests latch should
      // prevent this, but the guard keeps the queue clean even if
      // somebody calls us out-of-order from a test.
      if (!state.pendingHeroPickDelvers.includes(heroId)) {
        state.pendingHeroPickDelvers.push(heroId);
        added.push(heroId);
      }
    }
  }
  state.heroPicksAppliedQuests.push(questId);
  logEvent("heroPick.populate", {
    questId,
    added,
    pending: [...state.pendingHeroPickDelvers],
  });
  return added;
}

/**
 * Resolve the head of the pending pick queue: write the picked
 * card number to `state.activeHeroCardByDelver[heroId]` and pop
 * `heroId` from `state.pendingHeroPickDelvers`.
 *
 * Throws on:
 *   - `heroId` not at the head of the queue (out-of-order pick)
 *   - `cardNumber` not in `state.unlockedHeroCards` (the picker
 *     should never offer a locked card)
 *   - `cardNumber` whose suit doesn't match the delver's suit
 *     (cross-suit picks would break the existing left/right
 *     suit-board assumption)
 *
 * Throwing rather than no-op'ing is the right call here — the
 * picker UI is the only caller and any of these means a real bug
 * upstream, not a recoverable input.
 */
export function commitHeroPick(
  state: CampaignState,
  heroId: string,
  cardNumber: number,
): void {
  const head = state.pendingHeroPickDelvers[0];
  if (head !== heroId) {
    throw new Error(
      `commitHeroPick: out-of-order pick (head="${head ?? "<empty>"}", got="${heroId}")`,
    );
  }
  if (!state.unlockedHeroCards.includes(cardNumber)) {
    throw new Error(
      `commitHeroPick: card #${cardNumber} not in unlockedHeroCards [${state.unlockedHeroCards.join(", ")}]`,
    );
  }
  const card = HERO_CARDS.find((c) => c.number === cardNumber);
  if (!card) {
    throw new Error(`commitHeroPick: unknown hero card number ${cardNumber}`);
  }
  const hero = getHero(heroId);
  if (card.suit !== hero.suit) {
    throw new Error(
      `commitHeroPick: card #${cardNumber} (suit=${card.suit}) does not match delver ${heroId} (suit=${hero.suit})`,
    );
  }
  state.activeHeroCardByDelver[heroId] = cardNumber;
  state.pendingHeroPickDelvers.shift();
  // Apply the picked card's loadout NOW so `ensureEncounter`
  // bootstraps wave 1 with the right ranks + passives. Without this
  // the wave would inherit whatever `endQuestReset` last stamped (the
  // previous quest's active card, or the heroId default on first
  // run), and only the next end-of-quest reset would catch up.
  // See `state.ts > reseedDelverFromActiveHeroCard` for the exact
  // subset that gets refreshed.
  reseedDelverFromActiveHeroCard(state, heroId);
  logEvent("heroPick.commit", {
    heroId,
    cardNumber,
    remaining: [...state.pendingHeroPickDelvers],
  });
}
