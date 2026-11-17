/**
 * Overcharger (Machinist upgrade #38) ONGOING: "You may spend 2 Water to
 * increase your base LIGHT, MEDIUM or HEAVY damage."
 *
 * Designer ruling (2026-11-15): a spend moves that damage type to its
 * upgraded value on the Delversuit board's damage track - LIGHT 1 -> 2,
 * MEDIUM 2 -> 4, HEAVY 4 -> 8 - for the rest of the quest, unless it is
 * already increased. It is the same per-quest bonus the "+1 LIGHT / +2
 * MEDIUM / +4 HEAVY Damage" shop products give (`state.shopDamageBonus`,
 * cleared at quest end), so the suit panel's damage cube moves to the
 * upgraded diamond the same way.
 */

import type { CampaignState } from "../state";
import { getEffectiveEquipmentRanks, getEquipmentCardFor } from "../state";
import type { DamageType, Element } from "../types";
import { Tuning } from "../config/tuning";
import { logEvent } from "../debug/sessionLog";

/** The bearer's Overcharger effect, or null when they don't play one. */
export function overchargeEffect(state: CampaignState, heroId: string): { element: Element; cost: number } | null {
  const rank = getEffectiveEquipmentRanks(state, heroId).Supercharger ?? 0;
  if (rank < 1) return null;
  const card = getEquipmentCardFor(state, heroId, "Supercharger", rank);
  const eff = (card.effects ?? []).find((e) => e.kind === "overcharge-damage");
  return eff && eff.kind === "overcharge-damage" ? { element: eff.element, cost: eff.cost } : null;
}

/** True when that damage type is already at its upgraded value this quest. */
export function damageAlreadyIncreased(state: CampaignState, heroId: string, damageType: DamageType): boolean {
  return (state.shopDamageBonus[heroId]?.[damageType] ?? 0) > 0;
}

/** Spend the element cost to raise `damageType` to its upgraded value for the quest. */
export function overcharge(state: CampaignState, heroId: string, damageType: DamageType): { ok: true } | { ok: false; reason: string } {
  const eff = overchargeEffect(state, heroId);
  if (!eff) return { ok: false, reason: "no Overcharger" };
  if (damageAlreadyIncreased(state, heroId, damageType)) return { ok: false, reason: `${damageType} damage is already increased` };
  const bag = state.elements[heroId] ?? {};
  if ((bag[eff.element] ?? 0) < eff.cost) return { ok: false, reason: `needs ${eff.cost} ${eff.element}` };
  bag[eff.element] = (bag[eff.element] ?? 0) - eff.cost;
  state.elements[heroId] = bag;
  const bonus = state.shopDamageBonus[heroId] ?? {};
  bonus[damageType] = Tuning.damageBase[damageType];
  state.shopDamageBonus[heroId] = bonus;
  logEvent("engine.overcharger.spend", { heroId, damageType, bonus: bonus[damageType] });
  return { ok: true };
}
