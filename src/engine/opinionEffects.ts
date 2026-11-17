/**
 * Ongoing Opinion Card rules (Nov 15 printed cards) that aren't one-shot
 * redemptions. One place for every "while you hold this card" effect so
 * the shop, End Wave, quest start and memory-chip code just ask here.
 *
 * Holding a card: the rulebook gives you ONE card per character ("If
 * players already have an Opinion Card for that character, return the
 * previous card to the box"), so `state.opinionCards` holds at most one
 * entry per character. A one-shot card that was redeemed ("Discard once
 * redeemed") stays in the list for the Campaign Sheet but is listed in
 * `state.opinionCardsSpent`, and no longer counts as held.
 *
 *   Shop costs   Ira Confidant -1 / Ally (this visit, once) -1 /
 *                Detractor +1 / Nemesis +2 minion on every product;
 *                Flores Detractor +1 / Nemesis +2 on Equipment Market;
 *                Samantha Nemesis: Machinist products unpurchasable.
 *   Flores Confidant  missing boss parts may be paid with minion parts
 *                (3 per boss level).
 *   End Wave    Elayna Detractor: each delver loses 2 elements;
 *                Elayna Nemesis: all elements. Rodrigo Detractor: lose
 *                2 XP on hand; Nemesis: all XP on hand.
 *   Chips        Elias Nemesis: no new Memory Chip tokens.
 *   Quest start  Dahlia Confidant: both delvers +1 Universal 2x Damage
 *                and +1 Block 1 Counterattack token; Dahlia Ally: each
 *                delver +1 consumable token of their choice.
 *   Card limits  Arlen Detractor: at most 2 Ally/Confidant cards; Nemesis:
 *                at most 1.
 */

import type { CampaignState, ConsumableTokenKind } from "../state";
import type { OpinionLevel } from "../data";
import { logEvent } from "../debug/sessionLog";
import { grantToken } from "./tokens";

/** Opinion track value -> printed level (null = neutral). */
export function opinionLevelForValue(value: number): OpinionLevel | null {
  if (value >= 2) return "confidant";
  if (value === 1) return "ally";
  if (value === -1) return "detractor";
  if (value <= -2) return "nemesis";
  return null;
}

/** True while the player holds this card (owned and not discarded). */
export function holdsOpinionCard(state: CampaignState, characterId: string, level: OpinionLevel): boolean {
  return state.opinionCards.some((c) => c.characterId === characterId && c.level === level)
    && !state.opinionCardsSpent.includes(`${characterId}-${level}`);
}

/** Number of Ally / Confidant cards currently held (Arlen's limits). */
export function heldPositiveCardCount(state: CampaignState): number {
  return state.opinionCards.filter((c) =>
    (c.level === "ally" || c.level === "confidant") && holdsOpinionCard(state, c.characterId, c.level)).length;
}

/** Arlen Detractor (2) / Nemesis (1) cap on Ally + Confidant cards, or null. */
export function positiveCardLimit(state: CampaignState): number | null {
  if (holdsOpinionCard(state, "arlen", "nemesis")) return 1;
  if (holdsOpinionCard(state, "arlen", "detractor")) return 2;
  return null;
}

// --- Shop ---------------------------------------------------------------

/**
 * Net minion-part change Ira / Flores cards make to one product's price,
 * plus a short label per effect for the cost readout. Variable-cost
 * products (the Academy donation) are untouched.
 */
export function opinionShopMinionAdjust(
  state: CampaignState,
  product: { location: string; cost: { variableMinionParts?: boolean } },
): { delta: number; labels: string[] } {
  if (product.cost.variableMinionParts) return { delta: 0, labels: [] };
  let delta = 0;
  const labels: string[] = [];
  const add = (d: number, label: string) => { delta += d; labels.push(label); };
  if (holdsOpinionCard(state, "ira", "confidant")) add(-1, "Ira -1");
  if (state.iraDiscountActive) add(-1, "Ira (this visit) -1");
  if (holdsOpinionCard(state, "ira", "detractor")) add(1, "Ira +1");
  if (holdsOpinionCard(state, "ira", "nemesis")) add(2, "Ira +2");
  if (product.location === "Equipment Market") {
    if (holdsOpinionCard(state, "flores", "detractor")) add(1, "Flores +1");
    if (holdsOpinionCard(state, "flores", "nemesis")) add(2, "Flores +2");
  }
  return { delta, labels };
}

/** Samantha Nemesis: "Shop Products from the Machinist are unpurchasable." */
export function isShopProductBlockedBySamanthaNemesis(state: CampaignState, location: string): boolean {
  return location === "Machinist" && holdsOpinionCard(state, "samantha", "nemesis");
}

/** Flores Confidant: boss-part shortfalls may be paid in minion parts. */
export function floresPaysBossPartsInMinion(state: CampaignState): boolean {
  return holdsOpinionCard(state, "flores", "confidant");
}

// --- End Wave (continuing) -----------------------------------------------

/**
 * Elayna / Rodrigo penalties. The cards say "at the start of each
 * Interlude Phase"; with the 3-phase wave (no Interlude) they apply at
 * End Wave when the party continues to the next wave.
 * Elayna Detractor's "2 elements are lost" is applied per delver, taken
 * from that delver's largest stacks (the prototype picks for you).
 * Returns one summary line per effect that did something.
 */
export function applyEndWaveOpinionPenalties(state: CampaignState): string[] {
  const lines: string[] = [];
  const elaynaAll = holdsOpinionCard(state, "elayne", "nemesis");
  const elaynaTwo = holdsOpinionCard(state, "elayne", "detractor");
  if (elaynaAll || elaynaTwo) {
    for (const heroId of Object.keys(state.loadouts)) {
      const bag = state.elements[heroId] ?? {};
      let lost = 0;
      if (elaynaAll) {
        for (const el of Object.keys(bag) as (keyof typeof bag)[]) { lost += bag[el] ?? 0; bag[el] = 0; }
      } else {
        for (let i = 0; i < 2; i++) {
          const top = (Object.keys(bag) as (keyof typeof bag)[])
            .filter((el) => (bag[el] ?? 0) > 0)
            .sort((a, b) => (bag[b] ?? 0) - (bag[a] ?? 0) || String(a).localeCompare(String(b)))[0];
          if (!top) break;
          bag[top] = (bag[top] ?? 0) - 1;
          lost += 1;
        }
      }
      if (lost > 0) lines.push(`Elayna's ${elaynaAll ? "Nemesis" : "Detractor"} card: ${heroId === "hero-01" ? "Mind" : "Body"} delver loses ${lost} element${lost === 1 ? "" : "s"}.`);
    }
  }
  const rodrigoAll = holdsOpinionCard(state, "rodrigo", "nemesis");
  const rodrigoTwo = holdsOpinionCard(state, "rodrigo", "detractor");
  if ((rodrigoAll || rodrigoTwo) && state.xpOnHand > 0) {
    const lost = rodrigoAll ? state.xpOnHand : Math.min(2, state.xpOnHand);
    state.xpOnHand -= lost;
    lines.push(`Rodrigo's ${rodrigoAll ? "Nemesis" : "Detractor"} card: lose ${lost} XP on hand.`);
  }
  if (lines.length > 0) logEvent("engine.opinionEffects.endWave", { lines });
  return lines;
}

// --- Memory Chips ---------------------------------------------------------

/**
 * The single way to add Memory Chip tokens. Elias Nemesis ("You cannot
 * gain new Memory Chip tokens") blocks every gain. Returns the number
 * actually gained.
 */
export function gainMemoryChips(state: CampaignState, amount: number): number {
  if (amount <= 0) return 0;
  if (holdsOpinionCard(state, "elias", "nemesis")) {
    logEvent("engine.opinionEffects.eliasNemesis.blockedChips", { amount });
    return 0;
  }
  state.memoryChips += amount;
  return amount;
}

// --- Quest start ------------------------------------------------------------

/** Consumable kinds Dahlia's Ally card lets a delver pick. */
export const DAHLIA_ALLY_TOKEN_CHOICES: readonly ConsumableTokenKind[] = [
  "reroll", "damage-2x-universal", "prevent-counterattack",
];

/**
 * Dahlia's quest-start consumable tokens. Confidant: both delvers start
 * with 1 Universal 2x Damage + 1 Block 1 Counterattack token. Ally: each
 * delver starts with 1 token of their choice (`state.dahliaTokenChoice`,
 * picked in the Shop; set to Reroll when the card is gained). Called
 * once per quest start and again after a wave retry wipes the bags.
 */
export function grantDahliaQuestTokens(state: CampaignState): string[] {
  const lines: string[] = [];
  const heroIds = Object.keys(state.loadouts);
  if (holdsOpinionCard(state, "dahlia", "confidant")) {
    for (const heroId of heroIds) {
      grantToken(state, heroId, "damage-2x-universal", 1);
      grantToken(state, heroId, "prevent-counterattack", 1);
    }
    lines.push("Dahlia's Confidant card: both delvers +1 Universal 2x Damage and +1 Block Counterattack token.");
  }
  if (holdsOpinionCard(state, "dahlia", "ally")) {
    for (const heroId of heroIds) {
      const kind = state.dahliaTokenChoice[heroId];
      if (!kind) throw new Error(`grantDahliaQuestTokens: no token choice for ${heroId}`);
      grantToken(state, heroId, kind, 1);
    }
    lines.push("Dahlia's Ally card: each delver +1 consumable token of their choice.");
  }
  if (lines.length > 0) logEvent("engine.opinionEffects.dahliaTokens", { lines });
  return lines;
}
