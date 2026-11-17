/**
 * Shop Product Grants — applies the structured `grants` array on
 * every owned `ShopProduct` to the campaign state at the right
 * scope boundary.
 *
 * Two scope helpers, called from the encounter bootstrap path:
 *
 *   `applyShopGrantsForQuest(state, questId)`
 *     Fires once per quest (idempotent via
 *     `state.shopGrantsAppliedQuests`). Applies every
 *     `scope: "quest"` grant from products in
 *     `shopProductsOwned[heroId]` for both delvers. Includes
 *     equipment-rank bumps (Trident, Supercharger, Boots,
 *     Shockwave, Mace, Machinist upgrades), consumable-token
 *     starters (Reroll, Block Counterattack), per-damage-type
 *     bonuses (+1 LIGHT / +2 MEDIUM / +4 HEAVY), and the donation
 *     no-op. Called from `engine/encounter.ts > ensureEncounter`
 *     so it fires both when the player first enters a new quest
 *     AND when a save is loaded mid-quest before grants existed
 *     (the flag-gate keeps it from double-applying).
 *
 *   `applyShopGrantsForWave(state)`
 *     Fires at every wave start (when a fresh `EncounterState`
 *     is built — see `ensureEncounter` / `resetEncounter`).
 *     Applies every `scope: "wave"` grant: today only the
 *     element-token Wave-Bonus products (Fire, Earth, Light,
 *     Dark). Designed to fire on retries too — wave bonuses are
 *     the per-wave compensation in the printed rules.
 *
 * NEITHER helper consults `buildEncounter` arguments or returns
 * encounter data — they mutate persistent `CampaignState` only.
 * This keeps `buildEncounter` pure (its job is the board, not
 * the player's loadout) and means shop grants survive any
 * subsequent encounter re-build.
 *
 * Equipment-upgrade note (REAL swap since 2026-07-22): the three
 * Machinist products (#32 Earth's Embrace Shield, #34 Cyclone
 * Boots, #41 Shock Gauntlet) print as "find the 5 matching
 * Equipment cards in the Equipment Upgrade Deck. These will
 * replace your current X Equipment." The upgrade deck is now
 * authored in `data/equipmentUpgrades.json` (cards #141-155) and
 * the grant records a FAMILY REPLACEMENT in
 * `state.equipmentVariants` — rank is preserved (min 1) and every
 * effect-bearing lookup resolves the upgrade family's rank-correct
 * card via `state.ts > getEquipmentCardFor`. The `bonusRanks`
 * field on the grant data is retained but UNUSED (legacy of the
 * pre-2026-07-22 "+2 rank bump" approximation).
 */

import type { CampaignState, ConsumableTokenKind } from "../state";
import { ALL_CONSUMABLE_TOKEN_KINDS, applyImmediatePassiveEffects, getEquipmentCardFor } from "../state";
import { SHOP_PRODUCTS, getEquipmentByTypeSuitRank, getHero, upgradeFamilyForProduct } from "../data";
import { ALL_EQUIPMENT_TYPES } from "../types";
import type { EquipmentType, ShopProductGrant } from "../types";
import { grantToken } from "./tokens";
import { grantElementToDelver } from "./kills";
import { EQUIPMENT_RANK_CAP } from "./levelUp";
import { logEvent } from "../debug/sessionLog";

/**
 * Apply every `scope: "quest"` grant from products owned by either
 * delver. Idempotent: once `questId` is in
 * `state.shopGrantsAppliedQuests`, this is a no-op.
 *
 * Returns the list of `{ heroId, productNumber, grant }` triples
 * that actually fired (empty if already applied). Callers (engine
 * hooks) can ignore the return; the audit log captures the same
 * info via `logEvent`.
 */
export function applyShopGrantsForQuest(
  state: CampaignState,
  questId: string,
): Array<{ heroId: string; productNumber: number; grant: ShopProductGrant }> {
  if (state.shopGrantsAppliedQuests.includes(questId)) {
    return [];
  }
  const applied: Array<{ heroId: string; productNumber: number; grant: ShopProductGrant }> = [];
  for (const [heroId, ownedNumbers] of Object.entries(state.shopProductsOwned)) {
    for (const productNumber of ownedNumbers) {
      const product = SHOP_PRODUCTS.find((p) => p.number === productNumber);
      if (!product) {
        logEvent("engine.shopGrants.skipUnknownProduct", { heroId, productNumber });
        continue;
      }
      for (const grant of product.grants) {
        if (grant.scope !== "quest") continue;
        applyOneGrant(state, heroId, grant, { questId, productNumber });
        applied.push({ heroId, productNumber, grant });
      }
    }
  }
  state.shopGrantsAppliedQuests.push(questId);
  logEvent("engine.shopGrants.quest.applied", {
    questId,
    grantsApplied: applied.length,
    perHero: countByHero(applied),
  });
  return applied;
}

/**
 * Apply every `scope: "wave"` grant from products owned by either
 * delver. Always fires when called (no flag-gate): wave bonuses
 * are designed to re-trigger every wave per their printed text
 * ("Start each Wave with +1 Fire Element Token").
 *
 * Today only the Wave-Bonus element-token products produce
 * wave-scoped grants. If a future product authors a new
 * wave-scope grant kind, add a case in `applyOneGrant`.
 */
export function applyShopGrantsForWave(
  state: CampaignState,
): Array<{ heroId: string; productNumber: number; grant: ShopProductGrant }> {
  const applied: Array<{ heroId: string; productNumber: number; grant: ShopProductGrant }> = [];
  for (const [heroId, ownedNumbers] of Object.entries(state.shopProductsOwned)) {
    for (const productNumber of ownedNumbers) {
      const product = SHOP_PRODUCTS.find((p) => p.number === productNumber);
      if (!product) {
        logEvent("engine.shopGrants.skipUnknownProduct", { heroId, productNumber });
        continue;
      }
      for (const grant of product.grants) {
        if (grant.scope !== "wave") continue;
        applyOneGrant(state, heroId, grant, { productNumber });
        applied.push({ heroId, productNumber, grant });
      }
    }
  }
  logEvent("engine.shopGrants.wave.applied", {
    grantsApplied: applied.length,
    perHero: countByHero(applied),
  });
  return applied;
}

/**
 * Re-apply ONLY the quest-scope `consumable-tokens` grants after a
 * wave retry. `resetWaveForRetry` wipes each delver's consumable
 * bag, so the shop-bought starters (Reroll x2, Prevent
 * Counterattack) must be re-granted for the fresh attempt.
 *
 * Deliberately NOT the full `applyShopGrantsForQuest`: every other
 * quest-scope grant kind writes into state that SURVIVES the retry —
 * `equipment-rank-bump` / `equipment-upgrade` → `equipmentRanks`,
 * `damage-bonus` → `shopDamageBonus` — so re-firing those would
 * STACK the bonus on every retry (Boots R1 → R2 → R3...). That
 * stacking was a live bug pre-2026-07-20, when `resetWaveForRetry`
 * instead removed the quest from `shopGrantsAppliedQuests` and let
 * `ensureEncounter` re-fire the whole grant set.
 *
 * No ledger interaction: the quest stays stamped in
 * `shopGrantsAppliedQuests`, so the subsequent `ensureEncounter`
 * re-bootstrap is a quest-grant no-op.
 */
export function reapplyShopConsumableGrantsForRetry(
  state: CampaignState,
): Array<{ heroId: string; productNumber: number; grant: ShopProductGrant }> {
  const applied: Array<{ heroId: string; productNumber: number; grant: ShopProductGrant }> = [];
  for (const [heroId, ownedNumbers] of Object.entries(state.shopProductsOwned)) {
    for (const productNumber of ownedNumbers) {
      const product = SHOP_PRODUCTS.find((p) => p.number === productNumber);
      if (!product) continue;
      for (const grant of product.grants) {
        if (grant.scope !== "quest" || grant.kind !== "consumable-tokens") continue;
        applyOneGrant(state, heroId, grant, { productNumber });
        applied.push({ heroId, productNumber, grant });
      }
    }
  }
  logEvent("engine.shopGrants.retry.consumables-reapplied", {
    grantsApplied: applied.length,
    perHero: countByHero(applied),
  });
  return applied;
}

/**
 * Single-grant dispatcher. Switches over `grant.kind` so adding a
 * new variant in `types.ts` is a compile-time fan-out — TS will
 * flag any branch that isn't handled.
 *
 * The `ctx` argument provides log context (which product fired
 * this grant + which quest, when applicable) so the session log
 * tells a clean story: "Mind delver gained Rank 1 Trident because
 * they own Shop Product #1, applied at the start of quest2".
 */
function applyOneGrant(
  state: CampaignState,
  heroId: string,
  grant: ShopProductGrant,
  ctx: { productNumber: number; questId?: string },
): void {
  switch (grant.kind) {
    case "equipment-rank-bump": {
      const { before, after } = bumpEquipmentRank(state, heroId, grant.equipmentType, grant.amount);
      maybeApplyFirstGainImmediates(state, heroId, grant.equipmentType, before, after, ctx);
      logEvent("engine.shopGrants.equipment-rank-bump", {
        heroId,
        productNumber: ctx.productNumber,
        equipmentType: grant.equipmentType,
        amount: grant.amount,
        newRank: state.equipmentRanks[heroId]?.[grant.equipmentType] ?? 0,
      });
      return;
    }
    case "consumable-tokens": {
      // Validate against the known kinds at apply time. The grant's
      // `tokenKind` is typed as `string` in `types.ts` to dodge a
      // circular type ref between `types.ts` and `state.ts`; this
      // narrow keeps the boundary honest.
      if (!isConsumableTokenKind(grant.tokenKind)) {
        logEvent("engine.shopGrants.invalidTokenKind", {
          heroId,
          productNumber: ctx.productNumber,
          tokenKind: grant.tokenKind,
        });
        return;
      }
      grantToken(state, heroId, grant.tokenKind, grant.amount);
      logEvent("engine.shopGrants.consumable-tokens", {
        heroId,
        productNumber: ctx.productNumber,
        tokenKind: grant.tokenKind,
        amount: grant.amount,
      });
      return;
    }
    case "damage-bonus": {
      const bag = state.shopDamageBonus[heroId] ?? {};
      bag[grant.damageType] = (bag[grant.damageType] ?? 0) + grant.amount;
      state.shopDamageBonus[heroId] = bag;
      logEvent("engine.shopGrants.damage-bonus", {
        heroId,
        productNumber: ctx.productNumber,
        damageType: grant.damageType,
        amount: grant.amount,
        newTotal: bag[grant.damageType],
      });
      return;
    }
    case "element-tokens": {
      // One token at a time through the normal grant path, so the
      // 2-per-element cap applies (overflow is lost, rulebook p16)
      // exactly as for every other element gain.
      let granted = 0;
      for (let i = 0; i < grant.amount; i++) {
        if (grantElementToDelver(state, heroId, grant.element).granted) granted += 1;
      }
      logEvent("engine.shopGrants.element-tokens", {
        heroId,
        productNumber: ctx.productNumber,
        element: grant.element,
        amount: grant.amount,
        granted,
        newTotal: state.elements[heroId]?.[grant.element] ?? 0,
      });
      return;
    }
    case "equipment-upgrade": {
      // REAL Machinist deck swap (2026-07-22; pre-fix this was
      // approximated as a +2 rank bump of the STANDARD card, whose
      // printed abilities differ from the upgrade family entirely).
      // Printed text: "Find the 5 matching Equipment cards in the
      // Equipment Upgrade Deck. These will replace your current X
      // Equipment." — the delver's rank is UNCHANGED; the family
      // swaps (Shock Gauntlet / Cyclone Boots / Earth's Embrace
      // Shield play with their own printed effects at every rank).
      const family = upgradeFamilyForProduct(ctx.productNumber);
      if (!family) {
        logEvent("engine.shopGrants.equipment-upgrade-unknown-family", {
          heroId, productNumber: ctx.productNumber,
        });
        return;
      }
      const variants = state.equipmentVariants[heroId] ?? {};
      variants[grant.equipmentType] = family;
      state.equipmentVariants[heroId] = variants;
      // "Replace your current X" presumes ownership — a buyer with
      // no ranks in the type starts the family at R1 (the deck hands
      // them all five cards; rank table still gates which is live).
      const ranks = state.equipmentRanks[heroId] ?? {};
      const rankBefore = ranks[grant.equipmentType] ?? 0;
      if (rankBefore < 1) {
        ranks[grant.equipmentType] = 1;
        state.equipmentRanks[heroId] = ranks;
      }
      const rankNow = Math.max(1, rankBefore);
      // Apply the UPGRADE card's IMMEDIATELY effects for the live
      // rank (Cyclone Boots' movement floor). Uses the variant-aware
      // resolver, which now points at the upgrade family.
      const lo = state.loadouts[heroId];
      if (lo) {
        try {
          applyImmediatePassiveEffects(lo, [getEquipmentCardFor(state, heroId, grant.equipmentType, rankNow)]);
        } catch { /* data gap — swap still recorded */ }
      }
      logEvent("engine.shopGrants.equipment-upgrade", {
        heroId,
        productNumber: ctx.productNumber,
        equipmentType: grant.equipmentType,
        family,
        rank: rankNow,
      });
      return;
    }
    case "donation": {
      logEvent("engine.shopGrants.donation", {
        heroId,
        productNumber: ctx.productNumber,
      });
      return;
    }
  }
}

/**
 * Bump (heroId, type) by `delta` ranks, capped at the global rank
 * ceiling. Materialises the per-hero map entry on first bump.
 * Validates `type` against the canonical type list so a bad data
 * entry surfaces in the audit log instead of corrupting state.
 *
 * Returns `{ before, after }` so callers can detect a FIRST-TIME
 * gain (R0 → ≥1) and fire the card's IMMEDIATELY effects — see
 * {@link maybeApplyFirstGainImmediates}.
 */
function bumpEquipmentRank(
  state: CampaignState,
  heroId: string,
  type: EquipmentType,
  delta: number,
): { before: number; after: number } {
  if (!ALL_EQUIPMENT_TYPES.includes(type)) {
    logEvent("engine.shopGrants.invalidEquipmentType", { heroId, type });
    return { before: 0, after: 0 };
  }
  const ranks = state.equipmentRanks[heroId] ?? {};
  const current = ranks[type] ?? 0;
  const next = Math.min(current + delta, EQUIPMENT_RANK_CAP);
  ranks[type] = next;
  state.equipmentRanks[heroId] = ranks;
  return { before: current, after: next };
}

/**
 * Fire the R1 card's synchronous IMMEDIATELY passive effects when a
 * shop grant takes an equipment slot from unowned (R0) to owned
 * (R1+) — e.g. Boots' `set-base-movement` floor of 2, Armor-style
 * `set-max-hp`. Mirrors `engine/levelUp.ts > applyLevelUpChoice`,
 * which does exactly this on a first-time Level-Up gain (and, like
 * it, does NOT re-fire on rank-ups of an already-owned slot).
 *
 * BUG FIX 2026-07-20 (user report): buying the Boots shop product
 * (#3) bumped `equipmentRanks` so the card correctly appeared in the
 * player's hand next quest, but nothing ever applied the card's
 * IMMEDIATELY movement floor — `baseMovement` stayed at 1, the suit
 * board's movement cube (which faithfully renders `baseMovement`)
 * showed 1, and the Boots ONGOING (needs 2 movement) was unusable.
 * A wave RETRY would ironically fix it via
 * `reapplyOwnedPassiveImmediates` in `resetWaveForRetry`.
 *
 * Async gain-time effects (`gain-element-on-acquire`,
 * `immediately-equipment-roll`) are intentionally NOT enqueued here:
 * no shop product grants an OS card today, and Supercharger /
 * Battery rolls are already covered per-quest by
 * `applyEquipmentRollsForQuest` in the same `ensureEncounter`
 * bootstrap that applies these grants (double-enqueueing would
 * duplicate the roll prompt).
 */
function maybeApplyFirstGainImmediates(
  state: CampaignState,
  heroId: string,
  type: EquipmentType,
  rankBefore: number,
  rankAfter: number,
  ctx: { productNumber: number; questId?: string },
): void {
  if (rankAfter <= rankBefore) return;
  const lo = state.loadouts[heroId];
  if (!lo) return;
  // One application PER TIER GAINED, reading each tier's printed
  // card (2026-07-22, same ruling as the level-up path in
  // `levelUp.ts > applyLevelUpChoice`): a Machinist Cyclone Boots
  // purchase taking Boots R0 -> R2 fires the R1 card's floor of 2
  // AND the R2 card's floor of 3. Pre-fix this only fired the R1
  // card on a first-time gain.
  for (let r = rankBefore + 1; r <= rankAfter; r++) {
    try {
      const card = getEquipmentByTypeSuitRank(getHero(heroId).suit, type, r);
      applyImmediatePassiveEffects(lo, [card]);
      logEvent("engine.shopGrants.tier-gain-immediates", {
        heroId,
        productNumber: ctx.productNumber,
        equipmentType: type,
        cardId: card.id,
        rank: r,
        baseMovement: lo.baseMovement,
        maxHp: lo.maxHp,
      });
    } catch {
      // No ranked entry for (suit, type, r) — data gap; skip so it
      // can't crash the quest bootstrap. Same defensive posture as
      // `reapplyOwnedPassiveImmediates`.
      logEvent("engine.shopGrants.tier-gain-immediates-missing-card", {
        heroId,
        productNumber: ctx.productNumber,
        equipmentType: type,
        rank: r,
      });
    }
  }
}

function isConsumableTokenKind(s: string): s is ConsumableTokenKind {
  return (ALL_CONSUMABLE_TOKEN_KINDS as readonly string[]).includes(s);
}

function countByHero(
  applied: Array<{ heroId: string; productNumber: number; grant: ShopProductGrant }>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { heroId } of applied) out[heroId] = (out[heroId] ?? 0) + 1;
  return out;
}
