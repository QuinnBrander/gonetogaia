/**
 * Wave phase machine — Delver (Hero) Phase → Parting Shots → End Wave.
 * (3-phase structure from the Nov 15 player aid, designer decision
 * 2026-11-17; there is no Interlude Phase.)
 *
 * This module owns every transition between `EncounterState.phase`
 * values, plus the per-phase resolvers:
 *
 *   - Delver Phase exit:  {@link maybeEnterPartingShotsAfterTurn}.
 *                         Triggered after every `endHeroTurn` when
 *                         both Delvers have prepared (DESIGN.md §5.7).
 *
 *   - Parting Shots:      {@link nextPartingShotEnemy} +
 *                         {@link resolvePartingShot}. Each alive
 *                         enemy resolves once, in `enemies[]` order.
 *                         Unless an ability says otherwise, a Parting
 *                         Shot affects both Delvers wherever they are.
 *
 *   - End Wave:           {@link enterEndOfWave}. Runs the End Wave
 *                         refresh (weapons, AP, consumables, Harvester)
 *                         on every wave end, then routes to the wave's
 *                         `endOfWave.bothSurvive` / `.anyDie` page.
 *                         Continuing to the next wave goes through
 *                         {@link bootstrapNextWave}, which also applies
 *                         the "if continuing" effects (Elemental OS /
 *                         Shield elements, Armor heals, opinion
 *                         penalties).
 *
 *   - Death short-circuit: {@link onDelverDamaged} must be called from
 *                         EVERY damage-application path. If a delver
 *                         hits 0 HP, the current phase ends and we jump
 *                         straight to End Wave (skipping Parting Shots).
 *
 *   - Reset for retry:    {@link resetWaveForRetry}. Drops the
 *                         encounter so the user can retry the wave
 *                         from scratch (the "anyDie" page tells the
 *                         player to do this).
 */

import { bossWallet, recordQuestDeaths } from "../state";
import { applyEndWaveOpinionPenalties, grantDahliaQuestTokens } from "./opinionEffects";
import type {
  CampaignState,
  EncounterState,
  EnemyInstance,
} from "../state";
import type { EnemyCard, EquipmentType, Quest, RewardEvent } from "../types";
import {
  getEnemy,
  getQuestData,
  getEquipmentByTypeSuit,
  getEquipmentByTypeSuitRank,
  getHero,
  getActiveHeroCardStartingEquipment,
  HERO_CARDS,
} from "../data";
import {
  applyShieldChoicesToDamageMap,
  findShieldOpportunitiesForDamageMap,
  type ShieldChoice,
  type ShieldOpportunity,
} from "./combat";
import {
  applyImmediatePassiveEffects,
  getEffectiveEquipmentRanks,
  getEquipmentCardFor,
  newEquipmentRanksForActiveCard,
  reapplyOwnedPassiveImmediates,
} from "../state";
import { Tuning } from "../config/tuning";
import { enqueueEndWaveElementChoices } from "./os";
import { bootstrapWaveAtNumber } from "./encounter";
import { refreshAllSpentTokens } from "./tokens";
import { damageDelverInWave } from "./omenRebirth";
import { reapplyShopConsumableGrantsForRetry } from "./shopGrants";
import { logEvent } from "../debug/sessionLog";
import { recordAbilityProc } from "./abilityProcs";

// --- Hero → Parting Shots --------------------------------------------------

/** True iff every delver has latched preparedToRun. */
export function bothPrepared(enc: EncounterState): boolean {
  const ids = Object.keys(enc.preparedToRun);
  if (ids.length === 0) return false;
  return ids.every((id) => enc.preparedToRun[id] === true);
}

/**
 * Called by `endHeroTurn` after the active delver has been flipped.
 * If both delvers are now prepared AND the encounter is still in the
 * Hero Phase, transition to Parting Shots.
 *
 * Returns the new phase (so the UI can re-render the right panel).
 */
export function maybeEnterPartingShotsAfterTurn(
  state: CampaignState,
): EncounterState["phase"] | null {
  const enc = state.encounter;
  if (!enc) return null;
  if (enc.phase !== "hero") return enc.phase;
  if (!bothPrepared(enc)) return enc.phase;
  enc.phase = "parting-shots";
  enc.partingShotCursor = 0;
  return enc.phase;
}

// --- Parting Shots ---------------------------------------------------------

/**
 * Find the next alive enemy whose parting shot has not yet resolved.
 * Skips dead enemies (which shouldn't have a parting shot per p26:
 * *"Resolve each enemy's Parting Shot Ability one at a time"* — only
 * surviving enemies act). Returns `null` when the phase is done.
 */
export function nextPartingShotEnemy(
  enc: EncounterState,
): EnemyInstance | null {
  while (enc.partingShotCursor < enc.enemies.length) {
    const e = enc.enemies[enc.partingShotCursor]!;
    // The 2/2 card of a 2-card boss shares the boss's single parting shot.
    if (e.alive && !e.linkedTo) return e;
    enc.partingShotCursor += 1;
  }
  return null;
}

/**
 * Result of a single parting shot resolution. `hits` is the per-delver
 * damage applied, in stable hero-id order — the UI uses this for the
 * resolution log.
 */
export interface PartingShotResult {
  enemyInstanceId: string;
  enemyCardId: string;
  /**
   * Per-delver effect entries the UI iterates to render the log
   * row. Each entry MAY carry damage AND/OR an element-clear
   * count, depending on the parting-shot variant:
   *
   *   - `all-delvers`, `nearest-delver`, `delvers-within`
   *     → one entry per damaged delver with `damage > 0`,
   *       `elementsCleared == null`.
   *   - `all-delvers-lose-elements`
   *     → one entry per delver with `damage == 0`,
   *       `elementsCleared >= 0` (could be 0 if their bag was
   *       already empty).
   *   - `all-delvers-damage-and-lose-xp`
   *     → one entry per delver with `damage > 0`,
   *       `elementsCleared == null`. The XP loss is shared and
   *       lives on the top-level `xpLost` field, NOT duplicated
   *       per delver.
   *   - `all-delvers-lose-xp`
   *     → empty `hits[]`. The shared XP loss is solely on
   *       `xpLost` — there's nothing per-delver to report.
   *   - `all-delvers-damage-and-discard-consumable`
   *     → one entry per delver with `damage > 0` AND
   *       `consumablesDiscarded >= 0` (0 if their bag was
   *       already empty — the damage still lands).
   */
  hits: Array<{
    heroId: string;
    damage: number;
    elementsCleared?: number;
    consumablesDiscarded?: number;
  }>;
  /**
   * Shared XP pool drained by this parting shot, if any.
   * Populated for the `all-delvers-lose-xp` +
   * `all-delvers-damage-and-lose-xp` variants. `0` (not
   * undefined) when the variant doesn't touch XP — keeps the
   * UI's "if (xpLost)" check trivial. */
  xpLost: number;
  /**
   * For `nearest-delver` ties, the active player picked which delver
   * got hit. `null` if the parting shot kind didn't require a choice
   * (or there was no tie).
   */
  chosenDelverId: string | null;
  /** True if this parting shot caused a delver to die. */
  delverDied: boolean;
}

/** Optional caller-supplied resolution params for the next parting shot. */
export interface ResolvePartingShotParams {
  /**
   * For `nearest-delver` parting shots when multiple delvers tie on
   * Chebyshev distance, the UI picks one delver id. Required on tie;
   * ignored otherwise.
   */
  chosenDelverId?: string;
  /**
   * Optional Sol / Lunar Shield activations to fold in BEFORE the
   * parting-shot damage is applied. Keyed by shield-bearer hero id;
   * each entry carries the elements the bearer is spending against
   * this parting shot. Cap is enforced inside the engine — a single
   * parting shot is a single "counterattack source", so the engine
   * truncates each bearer's `elements` array to length 1 (rulebook
   * reading "1 shield per enemy counterattack"). Empty / omitted
   * → no shield reductions (legacy behaviour).
   *
   * UI flow: `WavePhases.onResolvePartingShot` calls
   * `findPartingShotShieldOpportunities` first; if non-empty, the
   * `parting-shot-shield-prompt` modal opens, walks the queue, and
   * commits via this param. Otherwise the resolve fires straight
   * through with `shieldChoices` omitted, matching pre-2026-05-25
   * behaviour exactly.
   */
  shieldChoices?: Record<string, ShieldChoice>;
}

/**
 * Resolve the parting shot of the enemy at `enc.partingShotCursor`,
 * advance the cursor, and return what happened.
 *
 * Phase transitions handled here:
 *   - If a delver hits 0 HP, fire {@link onDelverDamaged} which jumps
 *     straight to End of Wave (rulebook p26 short-circuit).
 *   - If the cursor walks off the end of the alive list, the wave
 *     ends (End Wave Phase, victory).
 *
 * Rejects (returns `null`) if there is no encounter, the phase is not
 * "parting-shots", or no alive enemy remains. The UI should re-check
 * `enc.phase` after every call to know whether to advance the screen.
 */
export function resolvePartingShot(
  state: CampaignState,
  params: ResolvePartingShotParams = {},
): PartingShotResult | null {
  const enc = state.encounter;
  if (!enc) return null;
  if (enc.phase !== "parting-shots") return null;
  const enemy = nextPartingShotEnemy(enc);
  if (!enemy) {
    enterEndOfWave(state, "victory");
    return null;
  }

  const card = getEnemy(enemy.cardId);
  const applied = applyPartingShot(state, enemy, card, params);
  const result: PartingShotResult = {
    enemyInstanceId: enemy.instanceId,
    enemyCardId: enemy.cardId,
    hits: applied.hits,
    xpLost: applied.xpLost,
    chosenDelverId: params.chosenDelverId ?? null,
    delverDied: false,
  };
  enc.partingShotCursor += 1;

  // Death short-circuit. Check AFTER advancing the cursor so the UI
  // knows which enemy "ended" the phase if a re-enter happens.
  for (const hit of result.hits) {
    const lo = state.loadouts[hit.heroId];
    if (lo && lo.currentHp <= 0) {
      result.delverDied = true;
      onDelverDamaged(state);
      // Phase has already flipped to "end-of-wave"; bail.
      return result;
    }
  }

  // If that was the last enemy, the wave ends: End Wave Phase.
  if (!nextPartingShotEnemy(enc)) {
    enterEndOfWave(state, "victory");
  }
  return result;
}

/**
 * Returns true on a tie that requires a chooser modal in the UI for a
 * `nearest-delver` parting shot. Lets the UI know whether to prompt
 * before calling `resolvePartingShot` with a `chosenDelverId`.
 *
 * For `all-delvers` and `delvers-within`, no choice is needed.
 */
export function partingShotNeedsChoice(
  enc: EncounterState,
  enemy: EnemyInstance,
  card: EnemyCard,
): boolean {
  if (card.partingShot.kind !== "nearest-delver") return false;
  const distances = delverDistances(enc, enemy);
  if (distances.length === 0) return false;
  const min = Math.min(...distances.map((d) => d.distance));
  const tied = distances.filter((d) => d.distance === min);
  return tied.length > 1;
}

/**
 * Variant-agnostic effect bundle returned by `applyPartingShot`.
 * Per-delver effects live in `hits[]`; SHARED effects (XP) live
 * at the top level — XP is a campaign-wide pool, not per-delver,
 * so duplicating it under every hit row would lie about the
 * actual mechanic.
 */
interface PartingShotEffects {
  hits: Array<{
    heroId: string;
    damage: number;
    elementsCleared?: number;
    consumablesDiscarded?: number;
  }>;
  xpLost: number;
}

/**
 * Pure function: compute the per-delver damage a parting shot
 * WOULD apply, in stable hero-id order. Returns an empty map for
 * non-damage variants (`all-delvers-lose-xp`,
 * `all-delvers-lose-elements`).
 *
 * Used by:
 *   - `applyPartingShot` (folds shield reductions in BEFORE
 *     committing damage).
 *   - `findPartingShotShieldOpportunities` (computes the would-be
 *     damage so the UI can decide whether to open the shield prompt
 *     in the first place).
 *
 * Stays in lockstep with the damage cases inside `applyPartingShot`
 * — adding a new parting-shot variant requires updating BOTH this
 * preview AND the apply switch (the test suite pins a few key
 * variants to catch drift).
 */
export function computePartingShotDamageMap(
  state: CampaignState,
  enemy: EnemyInstance,
  card: EnemyCard,
  params: ResolvePartingShotParams,
): Map<string, number> {
  const enc = state.encounter;
  const map = new Map<string, number>();
  if (!enc) return map;
  const ps = card.partingShot;
  switch (ps.kind) {
    case "all-delvers":
    case "all-delvers-damage-and-lose-xp":
    case "all-delvers-damage-and-discard-consumable":
    case "all-delvers-damage-and-lose-elements": {
      for (const heroId of Object.keys(enc.delverPositions)) {
        map.set(heroId, ps.damage);
      }
      break;
    }
    case "nearest-delver": {
      const candidates = delverDistances(enc, enemy);
      if (candidates.length === 0) break;
      const min = Math.min(...candidates.map((d) => d.distance));
      const tied = candidates.filter((d) => d.distance === min);
      const chosen =
        tied.length > 1 && params.chosenDelverId
          ? tied.find((t) => t.heroId === params.chosenDelverId) ?? tied[0]!
          : tied[0]!;
      map.set(chosen.heroId, ps.damage);
      break;
    }
    case "delvers-within": {
      const candidates = delverDistances(enc, enemy);
      for (const c of candidates) {
        if (c.distance <= ps.range) map.set(c.heroId, ps.damage);
      }
      break;
    }
    // No-damage variants explicitly leave the map empty.
    case "all-delvers-lose-xp":
    case "all-delvers-lose-elements":
      break;
  }
  return map;
}

/**
 * Build a `capByBearer` map for parting-shot shield activations.
 * Cap is always 1 — a parting shot is a single source enemy, so
 * the rulebook "1 shield per enemy counterattack" reading caps
 * each bearer at one activation per parting shot. Every loadout-
 * present hero gets cap 1 so `applyShieldChoicesToDamageMap` can
 * truncate over-supply defensively for any potential bearer.
 */
function partingShotCapByBearer(state: CampaignState): Map<string, number> {
  const cap = new Map<string, number>();
  for (const heroId of Object.keys(state.loadouts)) cap.set(heroId, 1);
  return cap;
}

/**
 * Public preview: which shield-bearer prompts (if any) should the UI
 * surface BEFORE applying this parting shot?
 *
 * Returns `[]` when there's no enemy to resolve, the parting shot
 * deals no damage (XP / element drain only), or no shield-bearer
 * is on a tile with a damaged delver. UI gates the
 * `parting-shot-shield-prompt` modal on a non-empty result.
 *
 * Re-uses the generic `findShieldOpportunitiesForDamageMap` helper
 * shared with counter resolution, so the same `ShieldOpportunity`
 * shape (incl. `maxActivations`, `protectedDelvers`, etc.) renders
 * via the same modal code path. Cap = 1 per bearer.
 */
export function findPartingShotShieldOpportunities(
  state: CampaignState,
  params: ResolvePartingShotParams = {},
): ShieldOpportunity[] {
  const enc = state.encounter;
  if (!enc) return [];
  const enemy = nextPartingShotEnemy(enc);
  if (!enemy) return [];
  const card = getEnemy(enemy.cardId);
  const damageByHero = computePartingShotDamageMap(state, enemy, card, params);
  if (damageByHero.size === 0) return [];
  return findShieldOpportunitiesForDamageMap(
    state, damageByHero, partingShotCapByBearer(state),
  );
}

function applyPartingShot(
  state: CampaignState,
  enemy: EnemyInstance,
  card: EnemyCard,
  params: ResolvePartingShotParams,
): PartingShotEffects {
  const enc = state.encounter!;
  const hits: PartingShotEffects["hits"] = [];
  let xpLost = 0;
  const ps = card.partingShot;

  // Step 1: compute would-be damage. Step 2: fold in shield
  // activations (truncated to cap = 1 per bearer per parting shot).
  // Step 3: dispatch on `ps.kind` to commit the (possibly reduced)
  // damage AND any non-damage side effects (XP / element drain /
  // consumable discard). The damage value committed comes from
  // `damageMap` rather than `ps.damage` directly so the shield
  // reductions actually take effect — this is the core difference
  // from the pre-2026-05-25 path.
  const damageMap = computePartingShotDamageMap(state, enemy, card, params);
  if (params.shieldChoices && Object.keys(params.shieldChoices).length > 0 && damageMap.size > 0) {
    applyShieldChoicesToDamageMap(
      state, damageMap, params.shieldChoices, partingShotCapByBearer(state),
    );
  }
  // After shields, expose 0-damage entries as 0 (vs. absent) so the
  // `hits.push({ damage })` rows below stay honest about "we tried
  // to deal damage but it was fully blocked".
  const damageFor = (heroId: string): number => damageMap.get(heroId) ?? 0;

  switch (ps.kind) {
    case "all-delvers": {
      // p26: "Unless an ability states otherwise, ... affects both
      // Delvers regardless of their position on the board."
      for (const heroId of Object.keys(enc.delverPositions)) {
        const dmg = damageFor(heroId);
        const dealt = damageDelver(state, heroId, dmg, card);
        hits.push({ heroId, damage: dealt });
      }
      break;
    }
    case "nearest-delver": {
      const candidates = delverDistances(enc, enemy);
      if (candidates.length === 0) break;
      const min = Math.min(...candidates.map((d) => d.distance));
      const tied = candidates.filter((d) => d.distance === min);
      const chosen =
        tied.length > 1 && params.chosenDelverId
          ? tied.find((t) => t.heroId === params.chosenDelverId) ?? tied[0]!
          : tied[0]!;
      const dmg = damageFor(chosen.heroId);
      const dealt = damageDelver(state, chosen.heroId, dmg, card);
      hits.push({ heroId: chosen.heroId, damage: dealt });
      break;
    }
    case "delvers-within": {
      const candidates = delverDistances(enc, enemy);
      for (const c of candidates) {
        if (c.distance <= ps.range) {
          const dmg = damageFor(c.heroId);
          const dealt = damageDelver(state, c.heroId, dmg, card);
          hits.push({ heroId: c.heroId, damage: dealt });
        }
      }
      break;
    }
    case "all-delvers-lose-xp": {
      // Shared pool — "lose N XP" / "lose ALL XP". The text on the
      // card says "BOTH delvers lose..." but XP is a SHARED resource
      // (rulebook p23-24), so this drains the single party pool by
      // either a fixed amount or to zero. No per-delver hit rows —
      // the UI surfaces this via the result's top-level `xpLost`.
      xpLost = drainSharedXp(state, ps.amount);
      logEvent("partingShot.loseXp", {
        enemyInstanceId: enemy.instanceId,
        enemyCardId: card.id,
        amount: ps.amount,
        xpLost,
        xpAfter: state.xpOnHand,
      });
      break;
    }
    case "all-delvers-lose-elements": {
      // Per-delver element bags — drain each independently.
      // `amount === "all"` zeroes the bag; numeric `amount` drains
      // up to N tokens per delver via `drainDelverElements`. Both
      // record the actual count cleared so the log row stays
      // honest about "you only lost what you had".
      for (const heroId of Object.keys(enc.delverPositions)) {
        const cleared = drainDelverElements(state, heroId, ps.amount);
        hits.push({ heroId, damage: 0, elementsCleared: cleared });
      }
      logEvent("partingShot.loseElements", {
        enemyInstanceId: enemy.instanceId,
        enemyCardId: card.id,
        amount: ps.amount,
        perDelver: hits.map((h) => ({ heroId: h.heroId, cleared: h.elementsCleared ?? 0 })),
      });
      break;
    }
    case "all-delvers-damage-and-lose-xp": {
      // Goldmonger's "2 Damage & lose ALL XP on hand." Combo —
      // apply the damage to BOTH delvers, then drain the shared
      // XP pool. Damage uses the existing `damageDelver` path
      // (so delver-death routing through `endOfWaveTransition`
      // still fires if either drops). XP loss is shared, so a
      // single drain after the damage loop.
      for (const heroId of Object.keys(enc.delverPositions)) {
        const dmg = damageFor(heroId);
        const dealt = damageDelver(state, heroId, dmg, card);
        hits.push({ heroId, damage: dealt });
      }
      xpLost = drainSharedXp(state, ps.amount);
      logEvent("partingShot.damageAndLoseXp", {
        enemyInstanceId: enemy.instanceId,
        enemyCardId: card.id,
        damage: ps.damage,
        amount: ps.amount,
        xpLost,
        xpAfter: state.xpOnHand,
      });
      break;
    }
    case "all-delvers-damage-and-discard-consumable": {
      // Death Cap's "4 Damage & Discard 1 Consumable." Combo —
      // every delver takes `damage`, then auto-discards up to
      // `count` consumable token(s) from their bag. Rulebook
      // p20 leaves the choice to the player; the digital
      // prototype auto-picks the SHALLOWEST non-empty stack to
      // minimise the strategic dial-back (kinder fallback than
      // hitting the biggest stockpile). Discards remove the
      // token from `available` outright — they don't pivot to
      // `spent` because the End Wave refresh would otherwise
      // restore the discarded copy on the next wave start.
      for (const heroId of Object.keys(enc.delverPositions)) {
        const dmg = damageFor(heroId);
        const dealt = damageDelver(state, heroId, dmg, card);
        const discarded = discardConsumablesShallowest(state, heroId, ps.count);
        hits.push({ heroId, damage: dealt, consumablesDiscarded: discarded });
      }
      logEvent("partingShot.damageAndDiscardConsumable", {
        enemyInstanceId: enemy.instanceId,
        enemyCardId: card.id,
        damage: ps.damage,
        count: ps.count,
        perDelver: hits.map((h) => ({
          heroId: h.heroId,
          damage: h.damage,
          discarded: h.consumablesDiscarded ?? 0,
        })),
      });
      break;
    }
    case "all-delvers-damage-and-lose-elements": {
      // Hundredeyes' "3 Damage & lose ALL Elements." Combo —
      // mirrors the damage-and-lose-xp shape but drains element
      // BAGS (per-delver) instead of the shared XP pool. Damage
      // is applied first per-delver, then each delver's bag is
      // drained independently. The per-hit row carries BOTH the
      // damage and the `elementsCleared` count so the parting-
      // shot log can render "Mind -3 · Mind cleared 2 elements"
      // in a single line via `formatPartingShotLogParts`.
      //
      // NOTE on shield interaction: the element-drain still fires
      // even if a shield blocked all the damage, because the
      // parting shot's drain clause is unconditional ("3 Damage &
      // lose ALL Elements") rather than predicated on damage
      // landing. This matches the printed text — the shield
      // protects HP, not the bag.
      for (const heroId of Object.keys(enc.delverPositions)) {
        const dmg = damageFor(heroId);
        const dealt = damageDelver(state, heroId, dmg, card);
        const cleared = drainDelverElements(state, heroId, ps.amount);
        hits.push({ heroId, damage: dealt, elementsCleared: cleared });
      }
      logEvent("partingShot.damageAndLoseElements", {
        enemyInstanceId: enemy.instanceId,
        enemyCardId: card.id,
        damage: ps.damage,
        amount: ps.amount,
        perDelver: hits.map((h) => ({
          heroId: h.heroId,
          damage: h.damage,
          cleared: h.elementsCleared ?? 0,
        })),
      });
      break;
    }
  }
  return { hits, xpLost };
}

/**
 * Drain the SHARED XP pool by `amount` (or `"all"`). Clamps
 * non-negative — you can't go below 0 XP. Returns how much was
 * actually drained (could be less than `amount` if the pool was
 * already low). Used by `all-delvers-lose-xp` and the combo
 * variant; pulled out so both call sites have one source of
 * truth for the clamp + "actual amount drained" arithmetic.
 */
function drainSharedXp(state: CampaignState, amount: number | "all"): number {
  const before = state.xpOnHand;
  if (amount === "all") {
    state.xpOnHand = 0;
    return before;
  }
  const drained = Math.min(before, Math.max(0, amount));
  state.xpOnHand = before - drained;
  return drained;
}

/**
 * Drain `heroId`'s element bag. `"all"` zeroes every element
 * bucket; a numeric amount drops up to N tokens deterministically
 * — iterate buckets in canonical `Element` enum order, popping
 * one at a time until N is reached or every bucket is empty.
 *
 * Returns the actual count drained, so the UI can show "Mind
 * lost 3 elements (you had 3 in bag)" honestly.
 *
 * Q2 W1 only ships `"all"` (Venena 012, Goldmonger), but the
 * numeric path is implemented for future cards rather than
 * thrown — keeps the "no fallbacks" rule (the primary path must
 * work) honest. Per-player CHOICE of which elements to drop is
 * not modelled today; if a future card needs that, promote this
 * to a pending-element-loss queue (mirroring
 * `pendingElementChoices`).
 */
function drainDelverElements(
  state: CampaignState,
  heroId: string,
  amount: number | "all",
): number {
  const bag = state.elements[heroId];
  if (!bag) return 0;
  // Canonical element iteration order — pulled from the keys
  // already present in the bag (which Object.keys serialises in
  // insertion order, and `gainElement` always uses the same enum
  // order). Stable across runs without dragging the Element enum
  // import into this file.
  const keys = Object.keys(bag) as Array<keyof typeof bag>;
  if (amount === "all") {
    let total = 0;
    for (const k of keys) {
      total += bag[k] ?? 0;
      bag[k] = 0;
    }
    return total;
  }
  let remaining = Math.max(0, amount);
  let drained = 0;
  for (const k of keys) {
    if (remaining === 0) break;
    const have = bag[k] ?? 0;
    if (have <= 0) continue;
    const take = Math.min(have, remaining);
    bag[k] = have - take;
    drained += take;
    remaining -= take;
  }
  return drained;
}

function damageDelver(
  state: CampaignState,
  heroId: string,
  amount: number,
  source: EnemyCard,
): number {
  return damageDelverInWave(state, heroId, amount, source);
}

/**
 * Discard up to `count` consumable token(s) from `heroId`'s bag,
 * picking the SHALLOWEST non-empty stack first on each tick.
 * Returns the actual count discarded — can be 0 if the bag was
 * empty, or less than `count` if the bag emptied mid-discard.
 *
 * "Discard" semantics: the token is removed from `available` and
 * NOT pivoted to `spent`. Pivoting would let the next End Wave
 * refresh restore the token (rulebook p15: *"refresh ALL
 * Consumables at the start of each Wave"*), which would defeat
 * the parting shot's intent.
 *
 * Auto-pick rationale: rulebook p20 leaves the choice to the
 * player; the digital prototype's auto-pick avoids opening an
 * interactive modal mid-parting-shot. Shallowest-first is the
 * gentlest default — punishes long-tail one-offs before eating
 * into the player's strongest stockpile.
 */
function discardConsumablesShallowest(
  state: CampaignState,
  heroId: string,
  count: number,
): number {
  const bag = state.consumableTokens[heroId];
  if (!bag) return 0;
  let discarded = 0;
  for (let i = 0; i < count; i += 1) {
    // Find the kind with the smallest non-zero `available` count.
    let pickKind: string | null = null;
    let pickAvailable = Number.POSITIVE_INFINITY;
    for (const [k, entry] of Object.entries(bag)) {
      if (!entry || entry.available <= 0) continue;
      if (entry.available < pickAvailable) {
        pickKind = k;
        pickAvailable = entry.available;
      }
    }
    if (!pickKind) break; // bag is empty
    const entry = bag[pickKind as keyof typeof bag]!;
    entry.available -= 1;
    discarded += 1;
  }
  return discarded;
}

/**
 * Chebyshev distance from `enemy` to every delver currently on the
 * board. (During Parting Shots all delvers are guaranteed alive —
 * any death already short-circuited to End of Wave per p26.)
 */
function delverDistances(
  enc: EncounterState,
  enemy: EnemyInstance,
): Array<{ heroId: string; distance: number }> {
  const out: Array<{ heroId: string; distance: number }> = [];
  for (const [heroId, pos] of Object.entries(enc.delverPositions)) {
    const d = Math.max(Math.abs(pos.x - enemy.x), Math.abs(pos.y - enemy.y));
    out.push({ heroId, distance: d });
  }
  return out;
}

// --- End Wave refresh --------------------------------------------------------

/**
 * What the End Wave refresh did, for the End of Wave screen. Kept on the
 * encounter (`enc.endWaveRefresh`) so an online guest, whose client never
 * runs the refresh, sees the same summary as the host.
 */
export interface EndWaveRefreshResult {
  /** Exhausted weapons returned to hand, per delver, in hero-id order. */
  weaponsRefreshed: Array<{ heroId: string; count: number }>;
  /** Consumable tokens flipped Spent -> Available, summed over both delvers. */
  consumableTokensRefreshed: number;
  /** Harvester payouts, one line per bearer per card. */
  harvesterGrants: Array<{ heroId: string; cardId: string; description: string }>;
}

/**
 * The part of the End Wave Phase that happens on EVERY wave end, victory
 * or defeat (3-phase wave structure, designer decision 2026-11-17):
 *   - exhausted weapons return to hand,
 *   - AP refills to `baseAp`,
 *   - every Spent consumable token flips back to Available,
 *   - Harvester pays its LIVING bearers (on defeat too).
 *
 * Effects that only matter when the delvers go on to the next wave
 * (Elemental OS / Shield elements, Armor heals, Elayna / Rodrigo
 * penalties) run in {@link applyContinuingEndWaveEffects} instead.
 */
function applyEndWaveRefresh(state: CampaignState): EndWaveRefreshResult {
  const weaponsRefreshed: EndWaveRefreshResult["weaponsRefreshed"] = [];
  for (const heroId of Object.keys(state.loadouts)) {
    const lo = state.loadouts[heroId]!;
    let count = 0;
    for (let i = 0; i < lo.slotCards.length; i++) {
      if (lo.slotCards[i] !== null) {
        lo.slotCards[i] = null;
        count += 1;
      }
    }
    weaponsRefreshed.push({ heroId, count });
    // AP is one per-wave pool (DESIGN.md §5.5); Battery's quest-long
    // bumps already live on `baseAp`.
    lo.currentAp = lo.baseAp;
  }

  const harvesterGrants = applyHarvesterGrants(state);

  let consumableTokensRefreshed = 0;
  for (const heroId of Object.keys(state.consumableTokens)) {
    const bag = state.consumableTokens[heroId];
    if (!bag) continue;
    for (const kind of Object.keys(bag)) {
      consumableTokensRefreshed += bag[kind as keyof typeof bag]?.spent ?? 0;
    }
  }
  refreshAllSpentTokens(state);

  return { weaponsRefreshed, consumableTokensRefreshed, harvesterGrants };
}

/**
 * Harvester ONGOING ("You gain N MINION PART tokens at the end of the
 * wave"): every owned passive (rank >= 1, effective ranks so Xavier
 * bumps count) on every LIVING delver. Creature parts go to
 * `state.minionParts`; New Harvester's boss parts to the wallet of the
 * card's level. No supply tracking (the "from supply" note is a
 * tabletop artefact).
 */
function applyHarvesterGrants(state: CampaignState): EndWaveRefreshResult["harvesterGrants"] {
  const out: EndWaveRefreshResult["harvesterGrants"] = [];
  for (const bearerId of Object.keys(state.loadouts)) {
    const lo = state.loadouts[bearerId];
    if (!lo || lo.currentHp <= 0) continue;
    const ranks = getEffectiveEquipmentRanks(state, bearerId);
    for (const type of Object.keys(ranks) as EquipmentType[]) {
      const rank = ranks[type] ?? 0;
      if (rank < 1) continue;
      const card = getEquipmentCardFor(state, bearerId, type, rank);
      if (card.category !== "passive") continue;
      for (const eff of card.effects ?? []) {
        if (eff.kind !== "gain-tokens-at-end-of-wave") continue;
        if (eff.token === "creature-part") {
          state.minionParts[bearerId] = (state.minionParts[bearerId] ?? 0) + eff.amount;
          out.push({ heroId: bearerId, cardId: card.id, description: `${card.name}: +${eff.amount} minion part${eff.amount === 1 ? "" : "s"}` });
        } else {
          const level = eff.bossLevel ?? 1;
          const wallet = bossWallet(state, level);
          wallet[bearerId] = (wallet[bearerId] ?? 0) + eff.amount;
          out.push({ heroId: bearerId, cardId: card.id, description: `${card.name}: +${eff.amount} Lvl ${level} boss part${eff.amount === 1 ? "" : "s"}` });
        }
      }
    }
  }
  return out;
}

// --- End Wave: continuing to the next wave ----------------------------------

function delverLabel(heroId: string): string {
  return getHero(heroId).suit === "mind" ? "Mind" : "Body";
}

/**
 * End Wave step A ("Gain End of Wave passive equipment benefits") for a
 * party that CONTINUES to the next wave. Leaving the Tide (retreat, the
 * quest's last wave, defeat) skips these, because HP and elements reset
 * at the end of a quest anyway.
 *
 * Order: Elayna / Rodrigo opinion penalties, then Armor heals, then the
 * Elemental OS / Sol & Lunar Shield element picks. The picks are queued
 * on the NEW wave's encounter, so call this after the next wave is built
 * (use {@link bootstrapNextWave}); the board opens the element-pick
 * modal when the wave starts.
 */
export function applyContinuingEndWaveEffects(state: CampaignState): RewardEvent[] {
  if (!state.encounter) throw new Error("applyContinuingEndWaveEffects: build the next wave first");
  const events: RewardEvent[] = [];
  for (const line of applyEndWaveOpinionPenalties(state)) events.push({ kind: "wave-effect", text: line });

  for (const heroId of Object.keys(state.loadouts)) {
    const lo = state.loadouts[heroId]!;
    const ranks = getEffectiveEquipmentRanks(state, heroId);
    for (const type of Object.keys(ranks) as EquipmentType[]) {
      const rank = ranks[type] ?? 0;
      if (rank < 1) continue;
      const card = getEquipmentCardFor(state, heroId, type, rank);
      if (card.category !== "passive") continue;
      for (const eff of card.effects ?? []) {
        if (eff.kind !== "heal-at-end-of-wave") continue;
        const before = lo.currentHp;
        lo.currentHp = Math.min(lo.maxHp, lo.currentHp + eff.amount);
        events.push({
          kind: "wave-effect",
          text: `${delverLabel(heroId)}: ${card.name} heals ${lo.currentHp - before} HP (${lo.currentHp}/${lo.maxHp})`,
        });
      }
    }
  }

  const picks = enqueueEndWaveElementChoices(state);
  if (picks > 0) {
    events.push({
      kind: "wave-effect",
      text: `${picks} element pick${picks === 1 ? "" : "s"} from Elemental OS / Shield: choose when the wave starts.`,
    });
  }
  logEvent("engine.wave.continuingEndWaveEffects", { lines: events.length, elementPicks: picks });
  return events;
}

/**
 * Build the next wave of a quest the party is continuing, then apply the
 * continuing End Wave effects to it. Every "Continue -> Wave N" path uses
 * this so the effects can't be forgotten.
 */
export function bootstrapNextWave(
  state: CampaignState,
  quest: Quest,
  waveNumber: number,
): RewardEvent[] {
  bootstrapWaveAtNumber(state, quest, waveNumber);
  return applyContinuingEndWaveEffects(state);
}

// --- End of Wave -----------------------------------------------------------

/**
 * Enter the End Wave Phase. Applies the End Wave refresh (see
 * {@link EndWaveRefreshResult}) once, then `outcome` selects between the two
 * narrative pages declared on the active wave's `endOfWave` block
 * (`bothSurvive` vs `anyDie`).
 *
 * Quest is resolved at runtime via `enc.questId` + `enc.waveNumber`,
 * so this routes correctly for Q1 W1 (single-wave) AND Q2 W1-W3
 * (multi-wave). For Q1, victory flips `state.quest1Completed = true`;
 * for Q2 we currently don't have an equivalent flag (Q2 victory
 * routing lives in the UI for now — Wave 2 transition is handled by
 * the End-of-Wave screen by clearing the encounter and bumping
 * `waveNumber`). Defeat leaves the campaign untouched so the user
 * can retry from the start of the wave (the `anyDie` page tells them
 * to do so).
 */
export function enterEndOfWave(
  state: CampaignState,
  outcome: "victory" | "defeat",
): void {
  const enc = state.encounter;
  if (!enc) return;
  // Soothsayer (Ch3 Carnatia): "This boss kills both delvers if not
  // defeated by the end of the wave." A wave that would end in victory
  // with a living Soothsayer becomes a defeat with both delvers at 0 HP.
  if (outcome === "victory") {
    const soothsayer = enc.enemies.find(
      (e) => e.alive && getEnemy(e.cardId).abilities.some((a) => a.kind === "soothsayer"),
    );
    if (soothsayer) {
      for (const lo of Object.values(state.loadouts)) lo.currentHp = 0;
      outcome = "defeat";
      recordAbilityProc(soothsayer, "soothsayer");
      logEvent("engine.enterEndOfWave.soothsayer", { instanceId: soothsayer.instanceId, cardId: soothsayer.cardId });
    }
  }
  enc.phase = "end-of-wave";
  enc.endOfWaveOutcome = outcome;
  // End Wave refresh — every wave end, victory or defeat. Latched so a
  // second call (or a save migrated from the old Interlude, which had
  // already refreshed) can't pay Harvester twice.
  if (!enc.endWaveRefresh) {
    enc.endWaveRefresh = applyEndWaveRefresh(state);
    logEvent("engine.wave.endWaveRefresh", { outcome, ...enc.endWaveRefresh });
  }
  // Who died on this quest — read by the Town Visit death pages.
  if (outcome === "defeat") recordQuestDeaths(state, enc.questId);
  const wave = resolveActiveWave(enc);
  const q = wave.endOfWave;
  enc.endOfWavePageId = outcome === "victory" ? q.bothSurvive : q.anyDie;
  // Per rulebook p26 ("After all Parting Shot Abilities have been
  // resolved, discard all enemies and any uncollected items remaining
  // on the board") we mark every enemy dead. Mostly a UI signal; the
  // encounter is about to be cleared on completion.
  for (const e of enc.enemies) e.alive = false;
  // Q1-only completion latch — Q2 doesn't have a per-quest flag yet
  // (it'll get one once Wave 3's victory routes into the Ch2 town
  // visit). The check on `enc.questId` keeps Q2's first-wave victory
  // from silently masquerading as a Q1 completion.
  if (outcome === "victory" && enc.questId === "quest1") {
    state.quest1Completed = true;
  }
}

/**
 * Look up the live `QuestWave` for an encounter — i.e. find the
 * entry in the active Quest whose `number` matches `enc.waveNumber`.
 * Throws (rather than falling back) if either the quest or the wave
 * isn't registered, so a stale encounter from a deleted quest crashes
 * loudly in the End-of-Wave path instead of silently rendering Q1
 * pages on top of Q2 state.
 */
function resolveActiveWave(enc: { questId: string; waveNumber: number }) {
  const quest = getQuestData(enc.questId);
  const wave = quest.waves.find((w) => w.number === enc.waveNumber);
  if (!wave) {
    throw new Error(
      `enterEndOfWave: quest "${enc.questId}" has no wave #${enc.waveNumber}`,
    );
  }
  return wave;
}

/**
 * Public completion — used by the End-of-Wave screen's "Return to
 * Title" button. Marks the encounter `completed` (so the Title
 * screen's Resume vs Begin check sees no in-progress wave) and
 * clears it.
 */
export function completeWave(state: CampaignState): void {
  const enc = state.encounter;
  if (!enc) return;
  if (enc.phase !== "end-of-wave") return;
  enc.phase = "completed";
  // Drop the encounter so the next Quest start re-bootstraps fresh.
  state.encounter = null;
}

/**
 * Reset the encounter so the player can retry the wave from scratch.
 * Used by the End-of-Wave (defeat) screen's "Try Again" button.
 *
 * Restores per-delver loadouts to a fresh wave start: full HP/AP/
 * movement, no slot cards, fresh element bag. Passive IMMEDIATELY
 * effects re-run. Caller (UI) is responsible for re-bootstrapping
 * the encounter on next board entry via `ensureEncounter`.
 */
export function resetWaveForRetry(state: CampaignState): void {
  // Drop the encounter; ensureEncounter on next render will rebuild.
  state.encounter = null;
  // Restore loadouts to fresh state. Don't touch
  // shared XP / level / quest1Completed — those persist across retries
  // (rulebook is silent on retry-reset semantics; we keep accrued
  // progress to avoid grinding away XP/parts on a near-miss).
  for (const heroId of Object.keys(state.loadouts)) {
    const lo = state.loadouts[heroId]!;
    // Clear elements and consumable tokens — delvers enter each attempt
    // with only what their hero cards and shop products provide, not
    // whatever they accumulated during the failed run.
    state.elements[heroId] = {};
    state.consumableTokens[heroId] = {};
    // Reset baseMovement to the campaign baseline before re-applying
    // passive floors. Otherwise a prior Boots IMMEDIATELY would already
    // have raised baseMovement to 2 and re-applying would be a no-op
    // — which is fine TODAY but will matter once quest transitions
    // exist (baseMovement should reset between quests; within a quest
    // the IMMEDIATELY effect re-establishes the floor).
    lo.baseMovement = Tuning.startingMovement;
    lo.currentHp = lo.maxHp; // reset to current (possibly upgraded) maxHp
    lo.currentAp = lo.baseAp;
    lo.currentMovement = lo.baseMovement;
    for (let i = 0; i < lo.slotCards.length; i++) lo.slotCards[i] = null;
    // Card-aware: re-apply IMMEDIATELYs only for the picked card's
    // printed loadout — keeps wave retry consistent with the picker
    // (a player who picked card #5 retries WITHOUT Shield even if
    // hero-01's legacy default would have included it).
    applyImmediatePassiveEffects(lo, getActiveHeroCardStartingEquipment(state, heroId));
    // Re-apply IMMEDIATELY effects from level-up-gained passives too
    // (e.g. Boots' set-base-movement). This keeps per-quest gains
    // (rest of THIS quest, not the campaign) intact across retries.
    reapplyOwnedPassiveImmediates(state, heroId);
  }
  // Re-grant ONLY the shop consumable-token starters (Reroll x2,
  // Block Counterattack) that the bag-wipe above just destroyed.
  // Pre-2026-07-20 this instead removed the quest from
  // `shopGrantsAppliedQuests` so `ensureEncounter` would re-fire the
  // FULL quest grant set — which stacked every non-consumable grant
  // on each retry (equipment-rank bumps: Boots R1 → R2 → ...;
  // damage bonuses: +1 LIGHT → +2 → ...) because those write into
  // state that survives the retry. The ledger now stays stamped and
  // the targeted helper re-applies just the wiped tokens.
  const questId = state.currentQuestId;
  reapplyShopConsumableGrantsForRetry(state);
  // Dahlia's quest-start tokens were wiped with the bags too.
  grantDahliaQuestTokens(state);
  // Mirror shopGrantsAppliedQuests: clear equipment-roll ledger so
  // Supercharger / Battery rolls re-fire on the retry attempt
  // (consumableTokens were wiped above, so the player would have no
  // damage-doublers unless the roll re-fires).
  state.equipmentRollsAppliedQuests = state.equipmentRollsAppliedQuests.filter(
    (id) => id !== questId,
  );
  // Reset turn-relative state by flipping back to hero-01 as the
  // active delver for the rebuilt wave.
  state.currentDelverId = Object.keys(state.loadouts)[0] ?? "hero-01";
}

// --- End of Quest ----------------------------------------------------------

/**
 * Tear down per-quest progress at the end of a Quest.
 *
 * Per design call 2026-05-09 (mirrors the printed Campaign Sheet's
 * "end of quest" reset row): the player keeps **campaign-level**
 * progress (creature parts, memory chips, completion flags, town-visit
 * shop ownership) but loses **quest-level** progress (equipment
 * upgrades, XP, levels, consumable + element tokens, loadout state).
 *
 * Called from the End-of-Wave screen's "Continue → Town Visit" handler
 * AFTER `completeWave` has cleared the encounter. Idempotent: no-op
 * fields are simply re-zeroed.
 *
 * | Field                              | Outcome                |
 * |------------------------------------|------------------------|
 * | minionParts / bossParts            | **PRESERVED** (currency for shop) |
 * | memoryChips                        | **PRESERVED** |
 * | memoryCards                        | **PRESERVED** (printed-art collection survives quests) |
 * | quest1Completed                    | **PRESERVED** (must already be true) |
 * | townVisit1Completed / townVisit    | **PRESERVED** (caller wires the visit) |
 * | shopProductsAvailable / Owned      | **PRESERVED** |
 * | townDecisions                      | **PRESERVED** |
 * | equipmentRanks                     | RESET → starting (R1 starter only) |
 * | xpOnHand / totalXp / currentLevel  | RESET → 0 |
 * | levelUpCardsOwed                   | RESET → 0 (any pending forfeit) |
 * | consumableTokens                   | RESET → empty bag per delver |
 * | elements                           | RESET → empty bag per delver |
 * | loadouts (HP/AP/MP/slots)          | RESET → fresh per Tuning + starter passives |
 * | encounter                          | RESET → null |
 * | currentDelverId                    | RESET → first hero in loadout map |
 *
 * Loadout reset rebuilds from `Tuning.startingHp/baseAp/startingMovement`
 * and re-runs `applyImmediatePassiveEffects` on the starter equipment
 * (Exoframe Armor → +3 HP/maxHp, Boots → +1 baseMovement floor) so
 * end-of-quest leaves the delvers in the same shape they would be in
 * for a brand-new campaign — minus the campaign-level keepers above.
 *
 * Does NOT route the player anywhere — caller (UI) is responsible for
 * `goTo({name: "townVisit"})` after this returns.
 */
export function endQuestReset(state: CampaignState): void {
  state.witnessAbilityUsed = false;
  // The quest is over; keep its death record for the Town Visit, but the
  // next quest start opens a fresh one (see `beginQuestDeathRecord`).
  if (state.lastQuestDeaths) state.lastQuestDeaths.ended = true;
  // Drop any encounter that's still hanging around. completeWave
  // does this too on the success path; we duplicate defensively
  // because endQuestReset is also a sensible building block for
  // future "abandon quest" flows that don't go via End-of-Wave.
  state.encounter = null;

  for (const heroId of Object.keys(state.loadouts)) {
    // Equipment ranks → starter baseline for the delver's currently
    // ACTIVE hero card (see `state.activeHeroCardByDelver` +
    // `HERO_CARD_LOADOUTS`). For card #1 / card #2 (the heroId
    // defaults) this is identical to the legacy `newEquipmentRanks`
    // path — but for picked cards #3-#6 the rank table reflects the
    // printed card's actual loadout (e.g. card #5: Trident r2 + Mace
    // r1, NO shield/boots/etc.).
    state.equipmentRanks[heroId] = newEquipmentRanksForActiveCard(state, heroId);

    // Temporary rank bonus (Opinion Card Xavier picks) is per-quest
    // — wipe it here so the next quest re-enqueues fresh picks via
    // `applyOpinionGrantsForQuest` rather than stacking on top of
    // last quest's bumps.
    state.temporaryRankBonus[heroId] = {};

    // Machinist equipment-variant replacements are quest-scoped like
    // the other shop grants — wipe here; `applyShopGrantsForQuest`
    // re-applies at the next quest bootstrap while the product is
    // still owned.
    state.equipmentVariants[heroId] = {};

    // Consumable + element bags → empty. New objects (rather than
    // mutating-then-clearing) so any UI that captured a reference
    // to the old bag from a stale render sees a fresh shape on the
    // next frame, not a half-cleared one.
    state.consumableTokens[heroId] = {};
    state.elements[heroId] = {};
    // Shop-granted per-quest damage bonuses are quest-scoped — they
    // wipe alongside ranks / tokens / elements. The next quest will
    // re-seed them via `applyShopGrantsForQuest` if the player still
    // owns the matching shop cards.
    state.shopDamageBonus[heroId] = {};

    // Loadout → fresh shape. Reset baseAp / baseMovement / maxHp to
    // the campaign baselines BEFORE re-applying starter passives so
    // any IMMEDIATELY effects that bump them (Exoframe maxHp +3,
    // Boots baseMovement floor) re-establish from a clean slate.
    const lo = state.loadouts[heroId]!;
    lo.baseAp = Tuning.baseAp;
    lo.currentAp = lo.baseAp;
    lo.baseMovement = Tuning.startingMovement;
    lo.currentMovement = lo.baseMovement;
    lo.maxHp = Tuning.startingHp;
    lo.currentHp = lo.maxHp;
    for (let i = 0; i < lo.slotCards.length; i++) lo.slotCards[i] = null;
    // Card-aware reset: the next quest may run the picker again and
    // pick a different card. Using the CURRENT active card here means
    // the post-quest preview shape matches what the player just
    // played; `commitHeroPick` re-seeds again if they pick a new card
    // for the next quest.
    applyImmediatePassiveEffects(lo, getActiveHeroCardStartingEquipment(state, heroId));
  }

  // Shared-pool campaign progression that doesn't survive the quest.
  // levelUpCardsOwed is cleared because the equipment-rank reset
  // would silently invalidate any pending pick anyway (the level-up
  // deck can re-grant ranks the player just lost), and forfeit is
  // the design-intended behaviour per the user call 2026-05-09.
  state.xpOnHand = 0;
  state.totalXp = 0;
  state.currentLevel = 0;
  state.levelUpCardsOwed = 0;
  // Opinion-grant idempotency ledger — clear so the next quest
  // re-applies Xavier picks fresh. Mirrors the temporaryRankBonus
  // wipe above; the two reset together because the bonus is the
  // output of the grants the ledger gates.
  state.opinionGrantsAppliedQuests = [];
  // Equipment-roll ledger — clear so Supercharger / Battery rolls
  // fire again at the start of the next quest.
  state.equipmentRollsAppliedQuests = [];

  // Hand the next-quest's first turn back to hero-01 — keeps the
  // resume-from-title flow predictable. (currentDelverId is also
  // re-stamped by `ensureEncounter` for the next wave; setting it
  // here just makes the transient title-screen state consistent.)
  state.currentDelverId = Object.keys(state.loadouts)[0] ?? "hero-01";
}

// --- Death short-circuit ---------------------------------------------------

/**
 * Hook into every damage path that could reduce a delver's HP to 0.
 * If any delver is at or below 0 HP, set the encounter into
 * End-of-Wave (defeat) immediately, regardless of the current phase
 * (rulebook p26: *"the current Phase immediately ends and both
 * players proceed directly to the End of Wave Phase"*).
 *
 * Idempotent — re-checking after the phase has already flipped is a
 * no-op. Returns true if a phase flip occurred this call.
 */
export function onDelverDamaged(state: CampaignState): boolean {
  const enc = state.encounter;
  if (!enc) return false;
  if (enc.phase === "end-of-wave" || enc.phase === "completed") return false;
  for (const heroId of Object.keys(state.loadouts)) {
    const lo = state.loadouts[heroId];
    if (lo && lo.currentHp <= 0) {
      enterEndOfWave(state, "defeat");
      return true;
    }
  }
  return false;
}

/**
 * Permanently discard the hero card held by any delver whose HP has
 * reached 0 during the just-completed quest wave.
 *
 * **Exempt waves (no card loss):**
 *   - Quest 1 (all waves) — introductory quest, always retryable.
 *   - Quest 2, Wave 1 — first wave of the main campaign, also exempt.
 *
 * All other waves: the dead delver's active hero card is removed from
 * `state.unlockedHeroCards`, added to `state.discardedHeroCards`, and
 * their `activeHeroCardByDelver` entry is updated to the first
 * remaining card of their suit (or kept as-is if none remain, which
 * shouldn't happen in normal play).
 *
 * Must be called BEFORE `endQuestReset` (which wipes loadout HP back
 * to full, making it impossible to detect who died afterwards).
 */
export function applyHeroCardLossForDeaths(state: CampaignState): void {
  const enc = state.encounter;
  if (!enc) return;

  // Exempt waves — no permanent card loss.
  if (enc.questId === "quest1") return;
  if (enc.questId === "quest2" && enc.waveNumber === 1) return;

  for (const heroId of Object.keys(state.loadouts)) {
    const lo = state.loadouts[heroId];
    if (!lo || lo.currentHp > 0) continue;

    const deadCard = state.activeHeroCardByDelver[heroId];
    if (deadCard == null) continue;

    // Remove from unlocked pool.
    state.unlockedHeroCards = state.unlockedHeroCards.filter((n) => n !== deadCard);
    if (!state.discardedHeroCards.includes(deadCard)) {
      state.discardedHeroCards.push(deadCard);
    }

    // Set active card to first remaining card of the same suit so the
    // delver isn't left pointing at a discarded card.
    const hero = getHero(heroId);
    const remaining = HERO_CARDS.filter(
      (c) => c.suit === hero.suit && state.unlockedHeroCards.includes(c.number),
    );
    if (remaining.length > 0) {
      state.activeHeroCardByDelver[heroId] = remaining[0]!.number;
    }

    logEvent("engine.wave.heroCardLost", {
      heroId,
      discardedCard: deadCard,
      replacedWith: state.activeHeroCardByDelver[heroId],
    });
  }
}
