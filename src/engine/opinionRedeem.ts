/**
 * Opinion-Card one-shot redemption helpers that fire OUTSIDE the
 * Town Visit / Shop context (Nov 15 card text):
 *   - Rodrigo Ally / Confidant "Elemental Kit": refresh all spent consumable tokens.
 *   - Elayna Ally / Confidant "Med Kit": delvers heal to full.
 * Both are available any time during a wave, so their buttons live in
 * the BoardScreen top bar. Town-visit-scoped redemptions (Flores, Vera)
 * live in `engine/townVisit.ts`.
 *
 * Splitting these by trigger context keeps the import boundaries
 * clean — board-side UIs (BoardScreen, SuitPanel) only need to
 * pull from this module, never from townVisit.ts.
 *
 * Elayna's character id is `elayne` (kept for save compatibility);
 * every player-facing string says "Elayna".
 */

import type { CampaignState } from "../state";
import { refreshAllSpentTokens } from "./tokens";
import { logEvent } from "../debug/sessionLog";
import { holdsOpinionCard } from "./opinionEffects";

/** Reasons a board-side opinion redemption can reject. */
export interface BoardRedemptionError {
  code: "card-not-owned" | "already-spent" | "nothing-to-do";
}

/** The Ally or Confidant card the player holds for `characterId` (both
 *  print the same one-shot for Elayna / Rodrigo), or null. */
function heldKitCard(state: CampaignState, characterId: string): "ally" | "confidant" | null {
  if (holdsOpinionCard(state, characterId, "confidant")) return "confidant";
  if (holdsOpinionCard(state, characterId, "ally")) return "ally";
  return null;
}

function ownsUnspent(state: CampaignState, characterId: string): boolean {
  return heldKitCard(state, characterId) !== null;
}

function preflight(state: CampaignState, characterId: string): BoardRedemptionError | null {
  const owned = state.opinionCards.some(
    (c) => c.characterId === characterId && (c.level === "ally" || c.level === "confidant"),
  );
  if (!owned) return { code: "card-not-owned" };
  if (!heldKitCard(state, characterId)) return { code: "already-spent" };
  return null;
}

/**
 * Redeem Rodrigo Ally: refresh every spent consumable token on every
 * delver and mark the card spent. Rejects with `nothing-to-do` when no
 * token is spent, so the card can't be wasted on a no-op.
 */
export function redeemRodrigoAlly(state: CampaignState): BoardRedemptionError | null {
  const err = preflight(state, "rodrigo");
  if (err) return err;
  if (countSpentTokens(state) === 0) return { code: "nothing-to-do" };
  refreshAllSpentTokens(state);
  state.opinionCardsSpent.push(`rodrigo-${heldKitCard(state, "rodrigo")!}`);
  logEvent("engine.opinionRedeem.rodrigo", {});
  return null;
}

/**
 * Redeem Elayna Ally: both delvers heal to full HP and the card is
 * marked spent. A downed delver (0 HP) is not revived; reviving is
 * Shop Product #55's job. Rejects with `nothing-to-do` when no living
 * delver is missing HP.
 */
export function redeemElaynaAlly(state: CampaignState): BoardRedemptionError | null {
  const err = preflight(state, "elayne");
  if (err) return err;
  if (missingHp(state) === 0) return { code: "nothing-to-do" };
  const spentId = `elayne-${heldKitCard(state, "elayne")!}`;
  const healed: Record<string, number> = {};
  for (const [heroId, lo] of Object.entries(state.loadouts)) {
    if (lo.currentHp <= 0) continue;
    healed[heroId] = lo.maxHp - lo.currentHp;
    lo.currentHp = lo.maxHp;
  }
  state.opinionCardsSpent.push(spentId);
  logEvent("engine.opinionRedeem.elayna", { healed });
  return null;
}

/** Count every Spent consumable token across every delver. */
export function countSpentTokens(state: CampaignState): number {
  let n = 0;
  for (const heroId of Object.keys(state.consumableTokens)) {
    const bag = state.consumableTokens[heroId];
    if (!bag) continue;
    for (const kind of Object.keys(bag)) {
      n += bag[kind as keyof typeof bag]?.spent ?? 0;
    }
  }
  return n;
}

/** Total HP missing across living delvers (downed delvers excluded). */
export function missingHp(state: CampaignState): number {
  let n = 0;
  for (const lo of Object.values(state.loadouts)) {
    if (lo.currentHp > 0) n += Math.max(0, lo.maxHp - lo.currentHp);
  }
  return n;
}

/** Whether the Rodrigo Ally button should be visible (owned + unspent). */
export function canShowRodrigoRedeemButton(state: CampaignState): boolean {
  return ownsUnspent(state, "rodrigo");
}

/** Whether the Elayna Ally button should be visible (owned + unspent). */
export function canShowElaynaRedeemButton(state: CampaignState): boolean {
  return ownsUnspent(state, "elayne");
}
