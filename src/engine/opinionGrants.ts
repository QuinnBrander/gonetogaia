/**
 * Opinion-Card grants — applies the Xavier rank-bump effects at the
 * start of every quest, and resolves the player's pending picks
 * into the temporary rank bonus table.
 *
 * Two public entry points:
 *
 *   `applyOpinionGrantsForQuest(state, questId)`
 *     Fires once per quest (idempotent via
 *     `state.opinionGrantsAppliedQuests`). Scans
 *     `state.opinionCards` for each Xavier card the player owns
 *     and enqueues a `PendingOpinionRankPick` per printed bump:
 *
 *       - Xavier Ally       -> 1 pick,  delta = +1, heroId = null
 *       - Xavier Confidant  -> 2 picks, delta = +1, one per delver
 *       - Xavier Detractor  -> 1 pick,  delta = -1, heroId = null
 *
 *     Called from `engine/encounter.ts > ensureEncounter` /
 *     `resetEncounter` / `bootstrapWaveAtNumber`, in lockstep
 *     with `applyShopGrantsForQuest`. The OpinionRankPickModal
 *     drains the queue.
 *
 *   `applyOpinionRankPick(state, pickId, heroId, type)`
 *     Resolves one queued pick. Validates that `pickId` is at the
 *     head of `pendingOpinionRankPicks` (FIFO), folds the bump
 *     into `state.temporaryRankBonus[heroId][type]` (clamped via
 *     `getEffectiveEquipmentRank` consumers), and pops the queue.
 *     Returns the resulting `opinion-rank-bumped` reward event so
 *     the caller can surface it through the rewards modal.
 *
 * Resets:
 *   - `state.temporaryRankBonus` is wiped per delver at quest end
 *     by `engine/wave.ts > endQuestReset`.
 *   - `state.opinionGrantsAppliedQuests` is wiped at the same time
 *     so the next quest re-enqueues fresh picks.
 */

import { grantDahliaQuestTokens, holdsOpinionCard } from "./opinionEffects";
import type { CampaignState, PendingOpinionRankPick } from "../state";
import { getEffectiveEquipmentRank } from "../state";
import { EQUIPMENT_RANK_CAP, type EquipmentType, type RewardEvent } from "../types";
import { logEvent } from "../debug/sessionLog";

/**
 * Apply every Xavier opinion-card grant by enqueueing the
 * corresponding `PendingOpinionRankPick` entries on the current
 * encounter. Idempotent: once `questId` is in
 * `state.opinionGrantsAppliedQuests`, this is a no-op.
 *
 * Returns the list of newly-enqueued picks (empty if already
 * applied or the player owns no Xavier cards). Callers can ignore
 * the return; the audit log records the same info via `logEvent`.
 *
 * Defensive: no-op when there's no encounter (the picks live on
 * the encounter's queue, so we'd have nowhere to enqueue them).
 * That's fine — the next `ensureEncounter` call that DOES have an
 * encounter will re-fire this and seed the queue.
 */
export function applyOpinionGrantsForQuest(
  state: CampaignState,
  questId: string,
): PendingOpinionRankPick[] {
  if (state.opinionGrantsAppliedQuests.includes(questId)) return [];
  const enc = state.encounter;
  if (!enc) return [];
  const owned = state.opinionCards
    .filter((c) => c.characterId === "xavier" && holdsOpinionCard(state, "xavier", c.level))
    .map((c) => `xavier-${c.level}`);
  const heroIds = Object.keys(state.loadouts);
  const enqueued: PendingOpinionRankPick[] = [];
  for (const source of owned) {
    if (source === "xavier-ally") {
      enqueued.push({
        pickId: `${source}-${questId}`,
        source,
        delta: 1,
        heroId: null,
      });
    } else if (source === "xavier-detractor") {
      enqueued.push({
        pickId: `${source}-${questId}`,
        source,
        delta: -1,
        heroId: null,
      });
    } else if (source === "xavier-nemesis") {
      // "Both heroes start each Quest with one equipment rank less."
      for (const heroId of heroIds) {
        enqueued.push({
          pickId: `${source}-${questId}-${heroId}`,
          source,
          delta: -1,
          heroId,
        });
      }
    } else if (source === "xavier-confidant") {
      // Confidant bumps EVERY delver — one pick per hero so the
      // modal walks through them one at a time ("Mind delver:
      // pick a slot for +1 RANK" then "Body delver: ..."). Pinning
      // heroId keeps the modal header unambiguous.
      for (const heroId of heroIds) {
        enqueued.push({
          pickId: `${source}-${questId}-${heroId}`,
          source,
          delta: 1,
          heroId,
        });
      }
    }
  }
  enc.pendingOpinionRankPicks.push(...enqueued);
  grantDahliaQuestTokens(state);
  state.opinionGrantsAppliedQuests.push(questId);
  logEvent("engine.opinionGrants.quest.applied", {
    questId,
    enqueuedCount: enqueued.length,
    pickIds: enqueued.map((p) => p.pickId),
  });
  return enqueued;
}

/**
 * Result of `applyOpinionRankPick`. `effectiveBefore` and
 * `effectiveAfter` are the values the rewards modal needs; the
 * matching `RewardEvent` is also returned for convenience so
 * callers can push it onto whatever reward bus the modal reads
 * from.
 */
export interface OpinionRankPickResult {
  pick: PendingOpinionRankPick;
  effectiveBefore: number;
  effectiveAfter: number;
  reward: Extract<RewardEvent, { kind: "opinion-rank-bumped" }>;
}

/**
 * Resolve the head of `pendingOpinionRankPicks` against a chosen
 * `(heroId, type)`. Throws (rather than returning null) for any
 * invalid input — the modal is responsible for validating before
 * calling, and an out-of-order dispatch indicates a real bug.
 *
 * Specifically:
 *   - No encounter -> throw.
 *   - Empty queue -> throw.
 *   - Queue head's `pickId` !== `pickId` arg -> throw (FIFO
 *     violation; the modal must always resolve the visible head
 *     pick before moving on).
 *   - Queue head's `heroId` is pinned (e.g. Confidant) and
 *     differs from the `heroId` arg -> throw.
 *
 * On success: pops the queue head, adds `pick.delta` to
 * `state.temporaryRankBonus[heroId][type]` (no per-slot clamp
 * here; the clamp lives in `getEffectiveEquipmentRank` where it
 * combines with the printed rank), and emits an
 * `opinion-rank-bumped` reward event.
 *
 * Note on clamp: we DON'T pre-clamp the stored bonus because the
 * combine-and-clamp logic in `getEffectiveEquipmentRank` is the
 * single source of truth for the effective rank. Storing the raw
 * delta means a future Detractor pick that stacks on top of an
 * Ally pick (-1 over +1 on the same slot) produces the correct
 * net 0 bonus, rather than two pre-clamped values that drift.
 */
export function applyOpinionRankPick(
  state: CampaignState,
  pickId: string,
  heroId: string,
  type: EquipmentType,
): OpinionRankPickResult {
  const enc = state.encounter;
  if (!enc) {
    throw new Error("applyOpinionRankPick: no encounter");
  }
  const head = enc.pendingOpinionRankPicks[0];
  if (!head) {
    throw new Error("applyOpinionRankPick: queue is empty");
  }
  if (head.pickId !== pickId) {
    throw new Error(
      `applyOpinionRankPick: head pickId is "${head.pickId}", not "${pickId}"`,
    );
  }
  if (head.heroId != null && head.heroId !== heroId) {
    throw new Error(
      `applyOpinionRankPick: pick "${pickId}" is pinned to heroId "${head.heroId}", not "${heroId}"`,
    );
  }
  if (!state.loadouts[heroId]) {
    throw new Error(`applyOpinionRankPick: unknown heroId "${heroId}"`);
  }
  const before = getEffectiveEquipmentRank(state, heroId, type);
  const bonusBucket = state.temporaryRankBonus[heroId] ?? {};
  bonusBucket[type] = (bonusBucket[type] ?? 0) + head.delta;
  state.temporaryRankBonus[heroId] = bonusBucket;
  const after = getEffectiveEquipmentRank(state, heroId, type);
  enc.pendingOpinionRankPicks.shift();
  const reward: Extract<RewardEvent, { kind: "opinion-rank-bumped" }> = {
    kind: "opinion-rank-bumped",
    heroId,
    equipmentType: type,
    effectiveBefore: before,
    effectiveAfter: after,
    delta: head.delta,
    source: head.source,
  };
  logEvent("engine.opinionGrants.pick.applied", {
    pickId,
    heroId,
    equipmentType: type,
    delta: head.delta,
    effectiveBefore: before,
    effectiveAfter: after,
    remainingQueue: enc.pendingOpinionRankPicks.length,
  });
  return { pick: head, effectiveBefore: before, effectiveAfter: after, reward };
}

/** Whether the encounter has any unresolved Xavier picks. Gates
 *  Start-Wave / End-Turn in the BoardScreen so the player can't
 *  advance past picks the modal is waiting on. */
export function hasPendingOpinionRankPicks(state: CampaignState): boolean {
  return (state.encounter?.pendingOpinionRankPicks.length ?? 0) > 0;
}

/** Peek at the head pick (for the modal). Returns null when the
 *  queue is empty rather than throwing — the modal renders blank
 *  / closes itself in that case. */
export function peekNextOpinionRankPick(
  state: CampaignState,
): PendingOpinionRankPick | null {
  return state.encounter?.pendingOpinionRankPicks[0] ?? null;
}

/**
 * List the equipment types eligible for the given pick on the
 * given delver. Used by the modal to render the type buttons.
 *
 * Rules:
 *   - Positive picks (Ally / Confidant, delta = +1) allow ANY
 *     equipment type — including R0 slots (the bump grants a
 *     fresh R1 card for the quest). Slots already at the rank
 *     cap (R5) are filtered out because the +1 would clamp to
 *     zero effective gain.
 *   - Negative picks (Detractor, delta = -1) require an
 *     OWNED slot (effective rank >= 1). Bumping R0 to R(-1) is
 *     a no-op the player shouldn't be invited to make, and
 *     also defeats the storytelling purpose of the curse.
 *
 * The `_max` (capped) and `_min` (already-at-floor) filters
 * intentionally hide the no-op picks from the modal — picks
 * always have a meaningful effect when the player makes them.
 */
export function eligibleEquipmentTypesForPick(
  state: CampaignState,
  pick: PendingOpinionRankPick,
  heroId: string,
  allTypes: readonly EquipmentType[],
): EquipmentType[] {
  const result: EquipmentType[] = [];
  for (const type of allTypes) {
    const current = getEffectiveEquipmentRank(state, heroId, type);
    if (pick.delta > 0) {
      if (current >= EQUIPMENT_RANK_CAP) continue;
      result.push(type);
    } else {
      if (current < 1) continue;
      result.push(type);
    }
  }
  return result;
}
