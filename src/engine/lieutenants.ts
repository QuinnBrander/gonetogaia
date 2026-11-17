/**
 * Storybook Lieutenant challenge (2026-11-17).
 *
 * Quests #4+ offer a "Challenge the Lieutenant" option at every continue
 * moment that leads into Wave 3 or later. Picking it runs the
 * `lieutenant-challenge` Town Visit action (before the next wave is built):
 *
 *   - The next Lieutenants Spawn Card (#19-24, printed order) that isn't in
 *     the campaign deck yet joins `state.lieutenantSpawnDeck` for the rest
 *     of the campaign, and is placed on top of the Spawn Deck
 *     (`state.lieutenantSpawnOnTop`), so the next wave is drawn from it.
 *   - Once all six are in the deck, one of them (random) goes on top
 *     instead. The option never disappears (no "only if" branches).
 *
 * `engine/encounter.ts` draws the on-top card, clears the slot, and shuffles
 * the campaign's Lieutenant cards into every later spawn-deck draw.
 */
import type { CampaignState } from "../state";
import type { RewardEvent } from "../types";
import { getSpawnCard, LIEUTENANT_SPAWN_CARD_NUMBERS } from "../data";
import { shuffle } from "../util/random";
import { logEvent } from "../debug/sessionLog";

export function grantLieutenantChallenge(state: CampaignState): RewardEvent[] {
  const next = LIEUTENANT_SPAWN_CARD_NUMBERS.find((n) => !state.lieutenantSpawnDeck.includes(n));
  const added = next !== undefined;
  const cardNumber = added ? next : shuffle([...state.lieutenantSpawnDeck])[0]!;
  if (added) state.lieutenantSpawnDeck = [...state.lieutenantSpawnDeck, cardNumber];
  state.lieutenantSpawnOnTop = cardNumber;
  logEvent("engine.lieutenantChallenge", { cardNumber, added, deck: [...state.lieutenantSpawnDeck] });
  return [{
    kind: "lieutenant-spawn-card-on-top",
    cardNumber,
    image: getSpawnCard(cardNumber).image,
    added,
    deckSize: state.lieutenantSpawnDeck.length,
  }];
}
