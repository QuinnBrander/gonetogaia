/**
 * Opinion-Card PENALTY engine — the negative-side counterpart to
 * `opinionRedeem` / the in-`townVisit` redemption helpers.
 *
 * Today this module owns one card:
 *
 *   Samantha Detractor (printed: "PENALTY — The next Shop Product
 *   from the Machinist is unpurchasable until you pay Samantha
 *   1 x LVL 1 BOSS PART. (Discard once resolved)")
 *
 *   While owned and not yet resolved, EVERY shop product whose
 *   `location === "Machinist"` (#32, #34, #41 today) is gated. The
 *   player resolves the card by paying 1 LVL 1 BOSS PART from
 *   either delver's wallet at any time during a town visit, which
 *   marks the card spent on `state.opinionCardsSpent` (mirroring
 *   the Ally one-shot pattern: card stays in `opinionCards` for
 *   the campaign-sheet ledger, but the `*-spent` flag is what
 *   downstream gates read).
 *
 * Why "spent" rather than splice from `opinionCards`: the existing
 * Flores / Elayna / Rodrigo / Vera one-shots all use the
 * spent-flag pattern, the rewards modal renders the printed art
 * with a "spent" badge once that flag flips, and the campaign
 * sheet roster keeps the historical record. Splicing would lose
 * the narrative beat ("Samantha was angry, and you appeased her")
 * and break the "discovered cards" panel.
 *
 * Re-trigger: if a future favour drop crosses Samantha's
 * detractor threshold AGAIN (e.g. -1 -> +1 -> -1) the engine's
 * `runTownVisitAction > shift-favour` already re-grants the card
 * on a fresh crossing — but ONLY if the card isn't currently in
 * `state.opinionCards`. Today the spent flag doesn't clear, so
 * the penalty is effectively a once-per-campaign liability — the
 * second Detractor grant will fire normally and re-arm the
 * penalty (the `already-owned` dedupe in townVisit checks
 * `opinionCards`, not `opinionCardsSpent`). That's the same
 * behaviour as the Ally one-shots so the family stays
 * consistent: one redemption per crossing.
 */

import type { CampaignState } from "../state";
import { getShopProduct } from "../data";
import { logEvent } from "../debug/sessionLog";

/**
 * Whether the player owns a currently-unresolved Samantha
 * Detractor card. This is the predicate every "is the Machinist
 * blocked?" gate ultimately reads.
 *
 * Returns false for any of:
 *   - Card never granted (`opinionCards` doesn't include it).
 *   - Card was granted but already paid off
 *     (`opinionCardsSpent` includes `samantha-detractor`).
 */
export function hasUnresolvedSamanthaDetractor(state: CampaignState): boolean {
  const owned = state.opinionCards.some(
    (c) => c.characterId === "samantha" && c.level === "detractor",
  );
  if (!owned) return false;
  if (state.opinionCardsSpent.includes("samantha-detractor")) return false;
  return true;
}

/**
 * Whether a specific shop product is currently blocked from
 * purchase by the Samantha Detractor penalty. Pure read — no
 * mutation. Used by `purchaseShopProduct` to short-circuit BEFORE
 * the cost check (so the player sees the right rejection reason)
 * and by the shop UI's affordability preview / disabled-button
 * tooltip.
 *
 * The block scope is "any product hosted by the Machinist", which
 * matches the printed shop-card top-bar label (`location:
 * "Machinist"` in `data/shopProducts.json`). Products at any other
 * location pass through untouched.
 */
export function isShopProductBlockedBySamanthaDetractor(
  state: CampaignState,
  productNumber: number,
): boolean {
  if (!hasUnresolvedSamanthaDetractor(state)) return false;
  const product = getShopProduct(productNumber);
  return product.location === "Machinist";
}

/**
 * Reasons a `resolveSamanthaDetractor` call can reject. Mirrors
 * the `OpinionRedemptionError` shape used by the Ally redemption
 * helpers so the UI can surface a consistent error pattern.
 */
export interface SamanthaDetractorResolutionError {
  code:
    | "card-not-owned"
    | "already-resolved"
    | "no-town-visit"
    | "insufficient-boss-lvl-1";
}

/**
 * Pay 1 LVL 1 BOSS PART from `heroId`'s wallet to discard the
 * Samantha Detractor card. On success: debits one boss part,
 * pushes `samantha-detractor` onto `state.opinionCardsSpent`, and
 * returns `null`. On failure: returns the error code without
 * mutating state (atomic, like the `purchaseShopProduct` contract).
 *
 * Required preconditions:
 *   - `state.townVisit` is active (the resolution is town-scoped
 *     by analogy with the Ally cards — payment + the "card is
 *     gone now" UX both belong to the visit).
 *   - The card is in `state.opinionCards` (favour crossed -1).
 *   - The card hasn't already been resolved this campaign.
 *   - `heroId`'s `bossParts` >= 1.
 *
 * Caller is responsible for `router.save()` / `refresh()` after
 * a successful call.
 */
export function resolveSamanthaDetractor(
  state: CampaignState,
  heroId: string,
): SamanthaDetractorResolutionError | null {
  if (!state.townVisit) return { code: "no-town-visit" };
  const owned = state.opinionCards.some(
    (c) => c.characterId === "samantha" && c.level === "detractor",
  );
  if (!owned) return { code: "card-not-owned" };
  if (state.opinionCardsSpent.includes("samantha-detractor")) {
    return { code: "already-resolved" };
  }
  const wallet = state.bossParts[heroId] ?? 0;
  if (wallet < 1) return { code: "insufficient-boss-lvl-1" };
  state.bossParts[heroId] = wallet - 1;
  state.opinionCardsSpent.push("samantha-detractor");
  logEvent("engine.opinionPenalty.samanthaDetractor.resolved", {
    heroId,
    bossPartsAfter: state.bossParts[heroId],
    chapterId: state.townVisit?.chapterId,
  });
  return null;
}

/**
 * Whether the Samantha Detractor "Pay" tile should be visible
 * RIGHT NOW (in the shop favors panel). True iff the card is
 * owned AND not yet resolved. The per-delver "Pay" button's
 * disabled state is computed separately (disabled when that
 * delver's boss-part wallet is empty) so the player still sees
 * the tile when they can't afford it, just with disabled CTAs
 * and a "no boss parts" tooltip.
 */
export function canShowSamanthaDetractorTile(state: CampaignState): boolean {
  return hasUnresolvedSamanthaDetractor(state);
}
