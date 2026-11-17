/**
 * Mace targeting helpers.
 *
 * Two cards, two filters, one shared OR-bypass:
 *
 *   - Pulse Maul Mace (Mind, R1) — *"HEAVY damage to an adjacent
 *     UNDAMAGED enemy. OR Spend an element to deal HEAVY to an
 *     adjacent enemy."*
 *   - Geoshade Mace (Body, R1) — *"HEAVY damage to an adjacent
 *     DAMAGED enemy. OR Spend an element to deal HEAVY to an
 *     adjacent enemy."*
 *
 * Both ride the existing `single-adjacent` `WeaponRange.kind`. The
 * card-specific bit is the `target-filter-or-spend-element` effect
 * (see `types.ts > EquipmentEffect`) that names which filter the
 * default mode applies and signals the OR-mode is available.
 *
 * Engine model (decisions confirmed by user 2026-05-04):
 *   - Default mode: only adjacent enemies whose `damageTaken` matches
 *     the filter (UNDAMAGED → 0; DAMAGED → > 0) are legal targets.
 *   - OR mode: spend ANY 1 element from the bearer's bag (player
 *     picks the element kind when multiple are available); filter
 *     is fully bypassed and ANY 8-way adjacent live enemy is a
 *     legal target. Damage is identical to the default mode (per
 *     the printed text — only targeting changes).
 *   - The element bag debit is committed inside `useWeaponAbility`
 *     so a swing that ultimately rejects on a downstream gate does
 *     NOT eat the element. (Today downstream gates fire BEFORE this
 *     point — placement / action-used / range-compute — so the
 *     ordering is conservative; a future post-debit gate would need
 *     to refund the element.)
 *   - The spend is recorded as a `target-bypass-spend-element`
 *     PreEffect on the AttackSession for the audit trail.
 *
 * UI model (auto-skip rules):
 *   - Both modes viable → mode-pick modal.
 *   - Only default viable (no element OR no enemy in bag, but
 *     filter has matches) → arm default directly, no modal.
 *   - Only spend viable (filter empty, has element + adjacent enemy):
 *       - one element kind in bag → arm spend with that kind.
 *       - multiple element kinds in bag → element-pick modal.
 *   - Neither viable → action menu pick is a no-op (UI swallows).
 *
 * This module is pure helpers — it does NOT mutate state. Element
 * debit + filter validation happen in `engine/turn.ts >
 * useWeaponAbility`; this file just answers the questions the UI
 * needs to decide what to render.
 */

import type { CampaignState, EnemyInstance } from "../state";
import type { Element, EquipmentCard, EquipmentEffect } from "../types";
import { ADJACENT_OFFSETS_8WAY } from "../rules";
import { getEnemyAt, getDelverAt } from "./encounter";

/** Pull the (single, optional) `target-filter-or-spend-element` effect
 *  from a card's effects list. Returns `null` if the card doesn't
 *  carry one. Mace today; any future card that prints the same
 *  filter+bypass pattern can opt in by adding the effect. */
export function getTargetFilterOrSpendElementEffect(
  card: EquipmentCard,
): Extract<EquipmentEffect, { kind: "target-filter-or-spend-element" }> | null {
  for (const eff of card.effects ?? []) {
    if (eff.kind === "target-filter-or-spend-element") return eff;
  }
  return null;
}

/** True if the enemy's `damageTaken` matches the filter. */
export function enemyMatchesFilter(
  enemy: EnemyInstance,
  filter: "undamaged" | "damaged",
): boolean {
  if (filter === "undamaged") return enemy.damageTaken === 0;
  return enemy.damageTaken > 0;
}

/** Every 8-way adjacent live enemy to the named delver. Pure spatial
 *  helper — does NOT consider any filter. (Separate from `boots.ts >
 *  adjacentEnemyTargets` so the Mace UI can keep its imports
 *  weapon-local.) */
export function adjacentLiveEnemies(
  state: CampaignState,
  heroId: string,
): EnemyInstance[] {
  const enc = state.encounter;
  if (!enc) return [];
  const pos = getDelverAt(enc, heroId);
  if (!pos) return [];
  const out: EnemyInstance[] = [];
  for (const off of ADJACENT_OFFSETS_8WAY) {
    const e = getEnemyAt(enc, pos.x + off.dx, pos.y + off.dy);
    if (e) out.push(e);
  }
  return out;
}

/** Subset of {@link adjacentLiveEnemies} that pass the named filter. */
export function adjacentLiveEnemiesMatchingFilter(
  state: CampaignState,
  heroId: string,
  filter: "undamaged" | "damaged",
): EnemyInstance[] {
  return adjacentLiveEnemies(state, heroId).filter((e) =>
    enemyMatchesFilter(e, filter),
  );
}

/** Element kinds the named delver currently has in their bag (count > 0).
 *  Sorted alphabetically for stable UI render order — matches the
 *  Sol/Lunar Shield prompt convention. */
export function availableElementKinds(
  state: CampaignState,
  heroId: string,
): Element[] {
  const bag = state.elements[heroId] ?? {};
  return (Object.keys(bag) as Element[])
    .filter((el) => (bag[el] ?? 0) > 0)
    .sort();
}

/** Snapshot the auto-skip / modal-routing decision for a Mace card.
 *  Pure helper — no mutation. The UI uses this to decide which
 *  modal (if any) to open after the player picks "Use weapon
 *  ability" on a Mace.
 *
 *  Result fields:
 *    - `defaultModeLegalTargets`: adjacent live enemies that pass
 *      the card's filter. Empty → default mode is unviable.
 *    - `spendModeLegalTargets`: adjacent live enemies, period.
 *      Empty → spend mode is unviable regardless of element bag.
 *    - `availableElementKinds`: element kinds in the bearer's bag.
 *      Empty → spend mode is unviable regardless of adjacency.
 *    - `defaultModeAvailable`: defaultModeLegalTargets.length > 0.
 *    - `spendModeAvailable`: spendModeLegalTargets.length > 0 AND
 *      availableElementKinds.length > 0.
 */
export interface MaceModeAvailability {
  filter: "undamaged" | "damaged";
  defaultModeLegalTargets: EnemyInstance[];
  spendModeLegalTargets: EnemyInstance[];
  availableElementKinds: Element[];
  defaultModeAvailable: boolean;
  spendModeAvailable: boolean;
}

export function classifyMaceModes(
  state: CampaignState,
  heroId: string,
  card: EquipmentCard,
): MaceModeAvailability | null {
  const eff = getTargetFilterOrSpendElementEffect(card);
  if (!eff) return null;
  const adj = adjacentLiveEnemies(state, heroId);
  const filtered = adj.filter((e) => enemyMatchesFilter(e, eff.filter));
  const kinds = availableElementKinds(state, heroId);
  return {
    filter: eff.filter,
    defaultModeLegalTargets: filtered,
    spendModeLegalTargets: adj,
    availableElementKinds: kinds,
    defaultModeAvailable: filtered.length > 0,
    spendModeAvailable: adj.length > 0 && kinds.length > 0,
  };
}
