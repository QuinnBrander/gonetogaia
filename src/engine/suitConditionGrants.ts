/**
 * Suit Condition rank grants — the campaign-level sibling of
 * `engine/opinionGrants.ts`.
 *
 * Two public entry points:
 *
 *   `enqueueSuitConditionRankPicks(state, source, picks, idSuffix?)`
 *     Append N picks to `state.pendingSuitConditionPicks`. Each pick
 *     gets a stable id derived from `source` + per-call index +
 *     optional suffix so re-firing the source action is observable
 *     in logs. Picks may reference each other via `pairWithIndex` —
 *     the engine translates that index to the other pick's `pickId`
 *     so the OTHER-delver constraint is stable across saves.
 *
 *   `applySuitConditionRankPick(state, pickId, heroId, type)`
 *     Resolve one queued pick with AUTO-FILL loadout placement
 *     (fills the first empty slot). Validates that `pickId` matches
 *     the queue head (FIFO), validates `heroId` / `type` against
 *     the pin constraints, adds `pick.delta` to
 *     `state.suitConditionRankBonus[heroId][type]` (clamped by
 *     `EQUIPMENT_RANK_CAP` at write time, mirroring the existing
 *     academy-donation policy), pops the head, and rewrites any
 *     paired pick's `heroId` to the OTHER delver so the printed
 *     "one player ... other player ..." rule holds without the
 *     modal needing to know about the pairing. Used for boss-card
 *     `unlockHigherRanks` picks (which never touch loadouts) and
 *     for debug / legacy zero-prompt resolution.
 *
 *   `applySuitConditionRankPickToSlot(state, pickId, heroId, type, loadoutIdx, slotIdx)`
 *     Slot-aware variant of the above — the player chose the cell
 *     in the `SuitConditionRankPickModal` Phase 2 placement step.
 *     Rejects `unlockHigherRanks` picks (no slot semantics) and
 *     occupied target cells.
 *     Returns the resulting `suit-condition-rank-bumped` event so
 *     the caller can surface it through the post-picker rewards
 *     modal.
 *
 * Persistence:
 *   - `state.pendingSuitConditionPicks` lives at CAMPAIGN scope —
 *     `endQuestReset` and `finishTownVisit` do NOT clear it. A
 *     player who closes the tab mid-picker resumes with the queue
 *     intact next session.
 *   - Bumps land on `state.suitConditionRankBonus[heroId][type]`
 *     which IS persistent (survives `endQuestReset`).
 */

import type { CampaignState, PendingSuitConditionRankPick } from "../state";
import { getEffectiveEquipmentRank } from "../state";
import { EQUIPMENT_RANK_CAP, type EquipmentType, type RewardEvent } from "../types";
import { logEvent } from "../debug/sessionLog";

/** Spec shape for one pick — matches the
 *  `enqueue-suit-condition-rank-picks` TownVisitAction payload entry.
 *  Kept local (not re-exported from `types.ts`) because it's an
 *  engine-private intermediate; the public surface is the action
 *  variant itself. */
export interface SuitConditionPickSpec {
  delta: 1 | 2;
  pinnedHeroId?: string;
  pinnedType?: EquipmentType;
  /** Restrict the player's type choice to this subset (e.g. all types in a suit part). */
  allowedTypes?: EquipmentType[];
  pairWithIndex?: number;
  /**
   * When true, applying this pick also sets
   * `state.unlockedForHigherRanks[heroId][type] = true`, lifting the
   * base-rank level-up cap from 3 to 5 for the chosen type.
   * Used by boss-card rank unlocks.
   */
  unlockHigherRanks?: boolean;
}

/**
 * Append `picks` to the campaign queue. Returns the newly-enqueued
 * `PendingSuitConditionRankPick` entries (with resolved `pickId`s)
 * so callers can log what landed without re-reading state.
 *
 * `idSuffix` is appended to every pick's `pickId` to disambiguate
 * multiple call sites that share a `source` (the academy donation
 * "small" tier and the "blood-soaked power" enqueue both fire from
 * different pages but could in theory collide on raw source +
 * index). Default is the empty string — callers from page onEnter
 * actions pass the page id to keep ids stable across re-renders of
 * the same page within a single visit.
 */
export function enqueueSuitConditionRankPicks(
  state: CampaignState,
  source: string,
  picks: SuitConditionPickSpec[],
  idSuffix: string = "",
): PendingSuitConditionRankPick[] {
  if (picks.length === 0) return [];
  const suffix = idSuffix ? `-${idSuffix}` : "";
  // Step 1: build the enqueued entries (without pair links yet).
  // We need every entry's stable `pickId` resolved before we can
  // translate `pairWithIndex` -> `pairsWithPickId`.
  const built: PendingSuitConditionRankPick[] = picks.map((p, i) => ({
    pickId: `${source}-${i}${suffix}`,
    source,
    delta: p.delta,
    heroId: p.pinnedHeroId ?? null,
    pinnedType: p.pinnedType ?? null,
    ...(p.allowedTypes ? { allowedTypes: p.allowedTypes } : {}),
    ...(p.unlockHigherRanks ? { unlockHigherRanks: true } : {}),
  }));
  // Step 2: thread the pair links. `pairWithIndex` refers to the
  // OTHER pick in the same `picks` batch (not a global index); a
  // pick that points at itself or an out-of-range index is dropped
  // with a warning rather than corrupting the queue.
  for (let i = 0; i < picks.length; i++) {
    const pair = picks[i]!.pairWithIndex;
    if (pair === undefined) continue;
    if (pair === i || pair < 0 || pair >= picks.length) {
      logEvent("engine.suitConditionGrants.enqueue.invalid-pair", {
        source,
        index: i,
        pairWithIndex: pair,
      });
      continue;
    }
    built[i]!.pairsWithPickId = built[pair]!.pickId;
  }
  state.pendingSuitConditionPicks.push(...built);
  logEvent("engine.suitConditionGrants.enqueue", {
    source,
    idSuffix,
    enqueuedCount: built.length,
    pickIds: built.map((p) => p.pickId),
    queueLength: state.pendingSuitConditionPicks.length,
  });
  return built;
}

/** Whether the campaign has any unresolved Suit Condition picks.
 *  Gates the Continue / Choices / Shop UI in `TownVisit.ts` so the
 *  player can't progress past the picker. */
export function hasPendingSuitConditionRankPicks(state: CampaignState): boolean {
  return state.pendingSuitConditionPicks.length > 0;
}

/** Peek at the head pick (for the modal). Returns null when the
 *  queue is empty rather than throwing — the modal renders blank
 *  / closes itself in that case. */
export function peekNextSuitConditionRankPick(
  state: CampaignState,
): PendingSuitConditionRankPick | null {
  return state.pendingSuitConditionPicks[0] ?? null;
}

/**
 * List the equipment types eligible for the given pick on the
 * given delver. Used by the modal to render the type buttons.
 *
 * Rules:
 *   - Suit Condition picks are always POSITIVE (delta = 1 | 2).
 *     A slot already at `EQUIPMENT_RANK_CAP` is filtered out
 *     because a +N to an at-cap slot is a guaranteed no-op (the
 *     bump would clamp to zero effective gain on read).
 *   - `pick.pinnedType` shrinks the eligible list to a single
 *     entry (the pinned type) — used by the academy donation
 *     small / medium tiers.
 *   - The caller passes `allTypes` (typically `ALL_EQUIPMENT_TYPES`
 *     from `types.ts`) so the helper doesn't have to import the
 *     full catalog itself; this also lets tests narrow the input
 *     to a known set.
 */
export function eligibleEquipmentTypesForSuitConditionPick(
  state: CampaignState,
  pick: PendingSuitConditionRankPick,
  heroId: string,
  allTypes: readonly EquipmentType[],
): EquipmentType[] {
  // allowedTypes (boss card suit part) > pinnedType (single-type) > all
  const candidates = pick.allowedTypes != null
    ? allTypes.filter((t) => pick.allowedTypes!.includes(t))
    : pick.pinnedType != null
      ? allTypes.filter((t) => t === pick.pinnedType)
      : allTypes;
  const result: EquipmentType[] = [];
  for (const type of candidates) {
    const current = getEffectiveEquipmentRank(state, heroId, type);
    if (current >= EQUIPMENT_RANK_CAP) continue;
    result.push(type);
  }
  return result;
}

/**
 * What resolving `pick` on `(heroId, type)` would do, without mutating
 * state — the picker shows it next to each choice ("R2 → R3").
 *   - Rank picks: `kind: "rank"`, effective rank before / after the
 *     bonus (same clamps as `applyHeadInternal` + `getEffectiveEquipmentRank`).
 *   - Boss-card unlocks: `kind: "cap"`, the level-up rank cap before /
 *     after the unlock (3 → 4 → 5).
 */
export interface SuitConditionPickPreview {
  kind: "rank" | "cap";
  before: number;
  after: number;
}

export function previewSuitConditionPick(
  state: CampaignState,
  pick: PendingSuitConditionRankPick,
  heroId: string,
  type: EquipmentType,
): SuitConditionPickPreview {
  if (pick.unlockHigherRanks) {
    const before = state.unlockedForHigherRanks[heroId]?.[type] ?? 3;
    return { kind: "cap", before, after: Math.min(EQUIPMENT_RANK_CAP, before + 1) };
  }
  const bucket = state.suitConditionRankBonus[heroId] ?? {};
  const nextBonus = Math.min(EQUIPMENT_RANK_CAP, (bucket[type] ?? 0) + pick.delta);
  const after = getEffectiveEquipmentRank(
    {
      ...state,
      suitConditionRankBonus: { ...state.suitConditionRankBonus, [heroId]: { ...bucket, [type]: nextBonus } },
    },
    heroId,
    type,
  );
  return { kind: "rank", before: getEffectiveEquipmentRank(state, heroId, type), after };
}

/**
 * Result of `applySuitConditionRankPick`. `effectiveBefore` and
 * `effectiveAfter` are the values the rewards modal needs; the
 * matching `RewardEvent` is also returned for convenience so
 * callers can push it onto whatever reward bus the modal reads
 * from.
 */
export interface SuitConditionRankPickResult {
  pick: PendingSuitConditionRankPick;
  effectiveBefore: number;
  effectiveAfter: number;
  reward: Extract<RewardEvent, { kind: "suit-condition-rank-bumped" }>;
}

/**
 * Resolve the head of `pendingSuitConditionPicks` against a chosen
 * `(heroId, type)`. Throws (rather than returning null) for any
 * invalid input — the modal is responsible for validating before
 * calling, and an out-of-order dispatch indicates a real bug.
 *
 * On success: pops the queue head, adds `pick.delta` to
 * `state.suitConditionRankBonus[heroId][type]` (clamped at
 * `EQUIPMENT_RANK_CAP` on write to keep the stored value inside the
 * legal range, mirroring the existing `resolveAcademyDonation`
 * policy), rewrites any paired pick's `heroId` to the OTHER delver
 * (so the next picker iteration sees a pre-resolved hero), and
 * returns the `suit-condition-rank-bumped` reward event.
 *
 * Loadout slot policy: this entry point AUTO-FILLS the next empty
 * `state.suitLoadouts[heroId]` slot (loadout 0 slot 0, then walking
 * forward). For interactive flows where the player should choose the
 * slot themselves, call {@link applySuitConditionRankPickToSlot}
 * instead — that variant takes an explicit `(loadoutIdx, slotIdx)`
 * and is the path the rewritten `SuitConditionRankPickModal` uses.
 * The auto-fill variant is preserved for boss-card unlocks (which
 * never touch `suitLoadouts`) and for any legacy / debug callers
 * that want zero-prompt resolution.
 */
export function applySuitConditionRankPick(
  state: CampaignState,
  pickId: string,
  heroId: string,
  type: EquipmentType,
): SuitConditionRankPickResult {
  return applyHeadInternal(state, pickId, heroId, type, null);
}

/**
 * Slot-aware sibling of {@link applySuitConditionRankPick}. Writes
 * the rank bump into the explicit `(loadoutIdx, slotIdx)` cell on
 * `state.suitLoadouts[heroId]` instead of auto-filling.
 *
 * Validations on top of the base ones:
 *   - The pick must NOT be an `unlockHigherRanks` (boss-card) pick —
 *     unlocks don't touch loadouts at all, so passing a slot for
 *     one is a real bug. Callers route unlocks through
 *     {@link applySuitConditionRankPick} instead.
 *   - `loadoutIdx` / `slotIdx` must be in `[0, 2]`.
 *   - The target cell must currently be `null` (empty).
 *
 * Used by the two-phase `SuitConditionRankPickModal` flow — Phase 1
 * collects `(heroId, type)`, Phase 2 collects `(loadoutIdx, slotIdx)`,
 * then this function commits both in one shot per pick.
 */
export function applySuitConditionRankPickToSlot(
  state: CampaignState,
  pickId: string,
  heroId: string,
  type: EquipmentType,
  loadoutIdx: number,
  slotIdx: number,
): SuitConditionRankPickResult {
  if (loadoutIdx < 0 || loadoutIdx > 2 || slotIdx < 0 || slotIdx > 2) {
    throw new Error(
      `applySuitConditionRankPickToSlot: loadoutIdx/slotIdx out of range (${loadoutIdx}, ${slotIdx})`,
    );
  }
  return applyHeadInternal(state, pickId, heroId, type, { loadoutIdx, slotIdx });
}

/**
 * Shared implementation behind both apply variants. `slotOverride`
 * is the only branching axis: `null` triggers the legacy
 * "fill the first empty cell" walk; a `{loadoutIdx, slotIdx}`
 * payload writes directly to that cell (and rejects when the cell
 * is occupied or when the pick is an `unlockHigherRanks` boss-card
 * unlock that doesn't touch loadouts at all).
 */
function applyHeadInternal(
  state: CampaignState,
  pickId: string,
  heroId: string,
  type: EquipmentType,
  slotOverride: { loadoutIdx: number; slotIdx: number } | null,
): SuitConditionRankPickResult {
  const head = state.pendingSuitConditionPicks[0];
  if (!head) {
    throw new Error("applySuitConditionRankPick: queue is empty");
  }
  if (head.pickId !== pickId) {
    throw new Error(
      `applySuitConditionRankPick: head pickId is "${head.pickId}", not "${pickId}"`,
    );
  }
  if (head.heroId != null && head.heroId !== heroId) {
    throw new Error(
      `applySuitConditionRankPick: pick "${pickId}" is pinned to heroId "${head.heroId}", not "${heroId}"`,
    );
  }
  if (head.pinnedType != null && head.pinnedType !== type) {
    throw new Error(
      `applySuitConditionRankPick: pick "${pickId}" is pinned to type "${head.pinnedType}", not "${type}"`,
    );
  }
  if (!state.loadouts[heroId]) {
    throw new Error(`applySuitConditionRankPick: unknown heroId "${heroId}"`);
  }
  if (slotOverride && head.unlockHigherRanks) {
    throw new Error(
      `applySuitConditionRankPickToSlot: pick "${pickId}" is an unlockHigherRanks pick and does not target a loadout slot`,
    );
  }
  // Validate the slot override BEFORE mutating anything, so a
  // rejected placement is a fully atomic no-op (no half-written
  // bonus bump that leaks into the next render). The auto-fill
  // path has no analogous failure mode (it silently no-ops when
  // every cell is full).
  if (slotOverride && !head.unlockHigherRanks) {
    const existingLoadouts = state.suitLoadouts[heroId];
    const targetRow = existingLoadouts?.[slotOverride.loadoutIdx];
    if (existingLoadouts !== undefined && !targetRow) {
      throw new Error(
        `applySuitConditionRankPickToSlot: no loadout at index ${slotOverride.loadoutIdx}`,
      );
    }
    const existingCell = targetRow?.[slotOverride.slotIdx];
    if (existingCell !== null && existingCell !== undefined) {
      throw new Error(
        `applySuitConditionRankPickToSlot: slot (${slotOverride.loadoutIdx}, ${slotOverride.slotIdx}) on "${heroId}" is occupied`,
      );
    }
  }
  const before = getEffectiveEquipmentRank(state, heroId, type);
  if (!state.suitConditionRankBonus[heroId]) {
    state.suitConditionRankBonus[heroId] = {};
  }
  const bonusBucket = state.suitConditionRankBonus[heroId]!;
  // Boss-card unlocks only set unlockedForHigherRanks — they do NOT
  // grant a rank bonus. All other picks add delta to suitConditionRankBonus.
  if (!head.unlockHigherRanks) {
    const prior = bonusBucket[type] ?? 0;
    const next = Math.min(EQUIPMENT_RANK_CAP, prior + head.delta);
    bonusBucket[type] = next;
    if (!state.suitLoadouts[heroId]) {
      state.suitLoadouts[heroId] = [[null, null, null], [null, null, null], [null, null, null]];
    }
    const loadouts = state.suitLoadouts[heroId]!;
    if (slotOverride) {
      // The validation block above already verified the cell is
      // free and the loadout row exists (or that the per-hero
      // loadout grid is yet to be lazily-initialised, in which
      // case the freshly-built grid above gives us all-empty
      // cells and the write below is safe).
      loadouts[slotOverride.loadoutIdx]![slotOverride.slotIdx] = { type, rank: head.delta };
    } else {
      // Legacy auto-fill: walk loadouts in order, drop into the first
      // empty cell. Silent no-op when every cell is full — the bonus
      // bucket still got the bump, so the rank-cap effect lands
      // regardless of loadout capacity.
      outer: for (const loadout of loadouts) {
        for (let si = 0; si < loadout.length; si++) {
          if (loadout[si] === null) {
            loadout[si] = { type, rank: head.delta };
            break outer;
          }
        }
      }
    }
  }
  // If this pick was flagged as a boss-card unlock, raise the
  // base-rank level-up ceiling for this type by one step (3→4, 4→5).
  let unlockedCap: 4 | 5 | undefined;
  if (head.unlockHigherRanks) {
    if (!state.unlockedForHigherRanks[heroId]) {
      state.unlockedForHigherRanks[heroId] = {};
    }
    const currentCap = state.unlockedForHigherRanks[heroId]![type] ?? 3;
    unlockedCap = Math.min(EQUIPMENT_RANK_CAP, currentCap + 1) as 4 | 5;
    state.unlockedForHigherRanks[heroId]![type] = unlockedCap;
    logEvent("engine.suitConditionGrants.unlockHigherRanks", {
      pickId,
      heroId,
      equipmentType: type,
      newCap: unlockedCap,
    });
  }
  const after = getEffectiveEquipmentRank(state, heroId, type);
  state.pendingSuitConditionPicks.shift();
  // Rewrite paired pick's heroId to the OTHER delver. The pair
  // link is one-way (paired pick references the just-resolved
  // pick's id), so we only need to scan for the matching link in
  // the still-pending tail. A pick that's already pinned
  // (heroId != null) is left alone — the pin wins (defence
  // against a future grant that uses both `pinnedHeroId` AND
  // `pairWithIndex` for some reason). The "other delver" is
  // computed from `state.loadouts` so the helper works for any
  // 2-delver lineup without hardcoding "hero-01"/"hero-02".
  const otherHeroId = Object.keys(state.loadouts).find((id) => id !== heroId) ?? null;
  if (otherHeroId) {
    for (const pending of state.pendingSuitConditionPicks) {
      if (pending.pairsWithPickId === pickId && pending.heroId == null) {
        pending.heroId = otherHeroId;
        logEvent("engine.suitConditionGrants.pair.rewrite", {
          pickId,
          pairedPickId: pending.pickId,
          rewriteHeroId: otherHeroId,
        });
      }
    }
  }
  const reward: Extract<RewardEvent, { kind: "suit-condition-rank-bumped" }> = {
    kind: "suit-condition-rank-bumped",
    heroId,
    equipmentType: type,
    effectiveBefore: before,
    effectiveAfter: after,
    delta: head.delta,
    source: head.source,
    ...(head.unlockHigherRanks ? { unlockOnly: true, unlockedCap } : {}),
  };
  logEvent("engine.suitConditionGrants.pick.applied", {
    pickId,
    heroId,
    equipmentType: type,
    delta: head.delta,
    effectiveBefore: before,
    effectiveAfter: after,
    remainingQueue: state.pendingSuitConditionPicks.length,
    source: head.source,
    ...(slotOverride ? { loadoutIdx: slotOverride.loadoutIdx, slotIdx: slotOverride.slotIdx } : {}),
  });
  return { pick: head, effectiveBefore: before, effectiveAfter: after, reward };
}
