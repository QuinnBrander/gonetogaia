/**
 * Chapter 2 Town Center "Donate to the Delving Academy" mechanic
 * (Shop Product #8 — `variableMinionParts: true`).
 *
 * Three public entry points:
 *
 *   `donateToAcademy(state, heroId, amount)`
 *     Debits `amount` minion parts from `heroId`'s wallet and
 *     accumulates the same amount on `state.academyDonation[heroId]`.
 *     Returns a `DonationError` discriminated reject on insufficient
 *     funds / invalid amount / not-in-town-visit; `null` on success.
 *     The Shop screen's donation row calls this once per click.
 *
 *   `resolveAcademyDonation(state)`
 *     Reads the total donation across every delver, picks a tier
 *     (0-2 / 3-5 / 6-9 / 10+), and POPULATES
 *     `state.pendingAcademyDonationResolution` with the two reward
 *     "tickets" the tier grants. Returns the
 *     `academy-donation-resolved` reward event for the rewards
 *     modal (tier label only; the per-ticket bumps surface
 *     separately as `suit-condition-rank-bumped` events emitted by
 *     `commitAcademyDonationResolution` during modal resolution).
 *     Idempotent — safe to call twice (the second call
 *     short-circuits because `state.townDecisions` already contains
 *     the resolution marker).
 *
 *   `commitAcademyDonationResolution(state)`
 *     Apply every queued placement on `state.pendingAcademyDonationResolution`
 *     to `state.suitConditionRankBonus` + `state.suitLoadouts`, clear
 *     the staging field, and return the list of
 *     `suit-condition-rank-bumped` reward events for the post-modal
 *     rewards sweep. Throws if any reward ticket is unresolved (the
 *     UI is responsible for gating Confirm until everything is set).
 *
 * Tier mapping (rulebook + Ch2 storybook p34-resolution — printed
 * rules grant PLAYER CHOICE on which delver picks up which bump):
 *
 *   |  Total  | Pick spec                                            |
 *   |---------|------------------------------------------------------|
 *   | 0 - 2   | -                                                    |
 *   | 3 - 5   | "one player +1 OS, OTHER player +1 Battery"          |
 *   | 6 - 9   | "one player +2 OS, OTHER player +2 Battery"          |
 *   |  10+    | "each player +2 RANK of your choice of equipment"    |
 *
 * The small / medium tiers stage two tickets with fixed
 * `pinnedType`s (OS + Battery); the player picks which delver
 * takes which ticket in the modal. The large tier stages two
 * tickets with `pinnedType: null` — the player picks ANY of the
 * 14 equipment types per ticket via a sub-menu before the
 * assignment Confirm enables.
 *
 * The bumps land on `suitConditionRankBonus` (not
 * `temporaryRankBonus`) so they survive `endQuestReset` and
 * persist for every quest after Chapter 2 — matching the printed
 * Suit Condition sheet as a permanent record. Each commit also
 * writes a `{ type, rank: delta }` entry into the player-chosen
 * `state.suitLoadouts[heroId][loadoutIdx][slotIdx]` cell so the
 * Campaign Sheet's Starting Equipment Loadouts grid reflects the
 * placement.
 *
 * Reset: per-visit accumulators (`state.academyDonation`) are
 * cleared by `finishTownVisit` so a future Ch2 re-entry (debug
 * tooling, or a future "second pass" mechanic) starts fresh.
 */

import { holdsOpinionCard } from "./opinionEffects";
import type {
  CampaignState,
  PendingAcademyDonationReward,
  PendingAcademyDonationPlacement,
} from "../state";
import { getEffectiveEquipmentRank } from "../state";
import { EQUIPMENT_RANK_CAP, type EquipmentType, type RewardEvent } from "../types";
import { logEvent } from "../debug/sessionLog";

export interface DonationError {
  code:
    | "no-town-visit"
    | "invalid-amount"
    | "insufficient-minion-parts"
    | "hero-not-found";
}

/**
 * Debit `amount` minion parts from `heroId` and accumulate into
 * `state.academyDonation[heroId]`. `amount` must be a positive
 * integer (donating zero is a no-op rejected as `invalid-amount`
 * so the UI surfaces a friendly error rather than silently
 * "committing" a zero-donation click).
 *
 * Returns `null` on success, a `DonationError` on rejection.
 * Caller is responsible for `router.save()` + `router.refresh()`
 * after a successful call.
 */
export function donateToAcademy(
  state: CampaignState,
  heroId: string,
  amount: number,
): DonationError | null {
  if (!state.townVisit) return { code: "no-town-visit" };
  if (!Number.isInteger(amount) || amount <= 0) return { code: "invalid-amount" };
  if (!(heroId in state.minionParts)) return { code: "hero-not-found" };
  const wallet = state.minionParts[heroId] ?? 0;
  if (wallet < amount) return { code: "insufficient-minion-parts" };
  state.minionParts[heroId] = wallet - amount;
  // The donation accumulator is initialised lazily — older saves
  // that migrated up may have an empty `academyDonation` object,
  // so `?? 0` is the only safe read pattern. We always write the
  // sum back so subsequent reads find the up-to-date total.
  const prior = state.academyDonation[heroId] ?? 0;
  state.academyDonation[heroId] = prior + amount;
  state.academyDonationLifetime += amount;
  logEvent("engine.academyDonation.donate", {
    heroId,
    amount,
    walletBefore: wallet,
    walletAfter: state.minionParts[heroId],
    donationBefore: prior,
    donationAfter: state.academyDonation[heroId],
  });
  return null;
}

/**
 * Sum across every delver's `academyDonation` entry. `0` for a
 * fresh save / un-donated party. Read by `resolveAcademyDonation`
 * and by the Shop UI when rendering the running-total pill.
 */
export function totalAcademyDonation(state: CampaignState): number {
  let total = 0;
  for (const heroId of Object.keys(state.academyDonation)) {
    total += state.academyDonation[heroId] ?? 0;
  }
  return total;
}

/** Resolution-tier label. Exposed for the Shop UI's "current tier"
 *  hint so the player sees in real time which tier their running
 *  total currently qualifies for. */
export type DonationTier = "none" | "small" | "medium" | "large";

/** Which printed donation table a chapter uses. Ch2 reads the per-visit
 *  total (3 / 6 / 10); Ch3 reads the campaign RUNNING total
 *  (6-12 / 13-21 / 22+, "Experimental Division Results"). */
export type DonationSchedule = "ch2" | "ch3" | "ch4";

export function donationTierForTotal(total: number, schedule: DonationSchedule = "ch2"): DonationTier {
  // Ch4 Experimental Division Results (running total): 11-20 / 21-34 / 35+.
  if (schedule === "ch4") {
    if (total >= 35) return "large";
    if (total >= 21) return "medium";
    if (total >= 11) return "small";
    return "none";
  }
  if (schedule === "ch3") {
    if (total >= 22) return "large";
    if (total >= 13) return "medium";
    if (total >= 6) return "small";
    return "none";
  }
  if (total >= 10) return "large";
  if (total >= 6) return "medium";
  if (total >= 3) return "small";
  return "none";
}

/** The donation total a schedule's tiers are measured against. */
export function donationTotalForSchedule(state: CampaignState, schedule: DonationSchedule): number {
  return schedule === "ch2" ? totalAcademyDonation(state) : state.academyDonationLifetime;
}

/**
 * One reward "ticket" granted by a donation tier — the input to
 * the staging field built by `resolveAcademyDonation`. Mirrors
 * `PendingAcademyDonationReward` minus the player-driven fields
 * (`chosenType`, `assignedHeroId`) which start `null`.
 */
export interface AcademyDonationRewardSpec {
  delta: 1 | 2;
  /** `null` for the `large` tier — player picks any of 14 types. */
  pinnedType: EquipmentType | null;
}

/**
 * Build the per-tier reward-ticket spec used by `resolveAcademyDonation`.
 * Exported for unit tests + the eventual "preview my picks before
 * I commit the donation" UI (out of scope today). Returns an empty
 * list for `tier === "none"` so the resolver can skip staging
 * without a special case.
 */
export function donationRewardsForTier(tier: DonationTier, schedule: DonationSchedule = "ch2"): AcademyDonationRewardSpec[] {
  if (schedule === "ch4") {
    // Printed Ch4: "One player +N Armor, other player +N Boots"; 35+ is
    // "each player +2 Rank of your choice".
    switch (tier) {
      case "none": return [];
      case "small": return [{ delta: 1, pinnedType: "Armor" }, { delta: 1, pinnedType: "Boots" }];
      case "medium": return [{ delta: 2, pinnedType: "Armor" }, { delta: 2, pinnedType: "Boots" }];
      case "large": return [{ delta: 2, pinnedType: null }, { delta: 2, pinnedType: null }];
    }
  }
  if (schedule === "ch3") {
    // Printed Ch3 Experimental Division Results: "One player +N OS,
    // other player +N Super Charger"; 22+ is "each player +2 of your choice".
    switch (tier) {
      case "none": return [];
      case "small": return [{ delta: 1, pinnedType: "OS" }, { delta: 1, pinnedType: "Supercharger" }];
      case "medium": return [{ delta: 2, pinnedType: "OS" }, { delta: 2, pinnedType: "Supercharger" }];
      case "large": return [{ delta: 2, pinnedType: null }, { delta: 2, pinnedType: null }];
    }
  }
  switch (tier) {
    case "none": return [];
    case "small": return [
      // Printed: "one player +1 OS, OTHER player +1 Battery". The
      // assignment modal lets the player pick which delver takes
      // which ticket (and swap).
      { delta: 1, pinnedType: "OS" },
      { delta: 1, pinnedType: "Battery" },
    ];
    case "medium": return [
      { delta: 2, pinnedType: "OS" },
      { delta: 2, pinnedType: "Battery" },
    ];
    case "large": return [
      // Printed: "each player +2 RANK of your choice of equipment".
      // Both tickets have an open `pinnedType: null` so the modal
      // surfaces the 14-equipment-type picker per ticket. After
      // assignment + type selection, the per-delver slot picker
      // lets the player place each ticket into any empty
      // `suitLoadouts` cell.
      { delta: 2, pinnedType: null },
      { delta: 2, pinnedType: null },
    ];
  }
}

/**
 * Populate `state.pendingAcademyDonationResolution` with the two
 * reward tickets matching the current `academyDonation` total, and
 * return the `academy-donation-resolved` reward event. The per-
 * ticket bumps surface separately as `suit-condition-rank-bumped`
 * events when `commitAcademyDonationResolution` runs (called by
 * the AcademyDonationResolutionModal once both placements land).
 *
 * Idempotent: if `state.townDecisions` already contains
 * `"ch2.town-center.donation-resolved"`, the call short-circuits
 * — no double-stage of the same tier on a page re-entry. The
 * staging field is left untouched (so a player who reloaded
 * mid-flow resumes the modal).
 *
 * `tier === "none"` is a special case: no staging happens and the
 * returned event's `grants` array is empty. The rewards modal
 * still shows the donation card so the player sees the explicit
 * "no reward" tier landed.
 */
export function resolveAcademyDonation(state: CampaignState, schedule: DonationSchedule = "ch2"): RewardEvent {
  const total = donationTotalForSchedule(state, schedule);
  const resolvedKey = `${schedule}.town-center.donation-resolved`;
  const alreadyResolved = state.townDecisions.includes(resolvedKey);
  // Headmistress Arlen: "New Hero cards receive the best equipment
  // result, regardless of your donation level." Confidant: every
  // resolution; Ally ("the next batch", discard once redeemed): this one.
  let tier = donationTierForTotal(total, schedule);
  if (!alreadyResolved) {
    if (holdsOpinionCard(state, "arlen", "confidant")) {
      tier = "large";
    } else if (holdsOpinionCard(state, "arlen", "ally")) {
      tier = "large";
      state.opinionCardsSpent.push("arlen-ally");
    }
    if (tier !== donationTierForTotal(total, schedule)) logEvent("engine.academyDonation.arlenBestResult", { total });
  }
  if (alreadyResolved) {
    logEvent("engine.academyDonation.resolve.skip", { reason: "already-resolved", total, tier });
    return {
      kind: "academy-donation-resolved",
      schedule,
      totalDonated: total,
      tier,
      grants: [],
    };
  }
  const tickets = donationRewardsForTier(tier, schedule);
  if (tier !== "none" && tickets.length === 2) {
    // Stage the resolution for the modal. `chosenType` mirrors
    // `pinnedType` for the pinned tiers so the placement code
    // always reads `chosenType` for the effective type — the
    // large tier writes `chosenType` from the player's pick
    // before Confirm.
    const buildReward = (spec: AcademyDonationRewardSpec): PendingAcademyDonationReward => ({
      delta: spec.delta,
      pinnedType: spec.pinnedType,
      chosenType: spec.pinnedType,
      assignedHeroId: null,
    });
    state.pendingAcademyDonationResolution = {
      tier,
      totalDonated: total,
      rewards: [buildReward(tickets[0]!), buildReward(tickets[1]!)],
      placements: [],
    };
  }
  state.townDecisions.push(resolvedKey);
  logEvent("engine.academyDonation.resolve", {
    total,
    tier,
    stagedRewardCount: tickets.length,
  });
  return {
    kind: "academy-donation-resolved",
      schedule,
    totalDonated: total,
    tier,
    // `grants` stays empty here — the per-ticket bumps surface
    // as `suit-condition-rank-bumped` events emitted by
    // `commitAcademyDonationResolution` after the player resolves
    // both placements in the modal. The RewardsModal's
    // `academy-donation-resolved` card renders the tier headline
    // + "your picks land below" copy; the modal then renders
    // SEPARATE `suit-condition-rank-bumped` cards in the
    // post-modal rewards sweep.
    grants: [],
  };
}

/**
 * True when a donation resolution is staged and not yet committed.
 * Gates the TownVisit navigation + drives the modal mount in
 * `screens/TownVisit.ts`.
 */
export function hasPendingAcademyDonationResolution(state: CampaignState): boolean {
  return state.pendingAcademyDonationResolution !== null;
}

/**
 * True when every reward ticket on the staged resolution has a
 * `chosenType` and a unique `assignedHeroId`. The Phase 1 Confirm
 * button reads this to enable. Returns `false` (rather than
 * throwing) when no resolution is staged so the UI gate is always
 * safe to call.
 */
export function canAdvanceDonationAssignment(state: CampaignState): boolean {
  const res = state.pendingAcademyDonationResolution;
  if (!res) return false;
  const assigned: Array<string | null> = [];
  for (const reward of res.rewards) {
    if (reward.chosenType == null) return false;
    if (reward.assignedHeroId == null) return false;
    if (assigned.includes(reward.assignedHeroId)) return false;
    assigned.push(reward.assignedHeroId);
  }
  return true;
}

/**
 * Apply one Phase 2 placement to the staged resolution. Records
 * the placement on `pendingAcademyDonationResolution.placements`
 * so a mid-flow tab close resumes the picker at the next delver.
 * Does NOT yet write to `suitLoadouts` / `suitConditionRankBonus`
 * — those land in one batch via `commitAcademyDonationResolution`
 * once every reward ticket has a placement (the simplest "all-or-
 * nothing" commit so a partial flow can be undone by clearing the
 * staging field).
 *
 * Throws on:
 *   - No resolution staged.
 *   - `loadoutIdx` / `slotIdx` out of range (0..2).
 *   - Slot already occupied in `suitLoadouts[heroId][loadoutIdx][slotIdx]`.
 *   - Slot already targeted by an earlier placement in this resolution
 *     (two tickets can't share a cell even when both go to the same
 *     delver — irrelevant today since the assignment gate forces
 *     different delvers, but defends against future tier shapes).
 *   - The reward ticket for `(heroId, type)` couldn't be matched
 *     (the modal is responsible for only calling this when the
 *     ticket exists).
 */
export function recordAcademyDonationPlacement(
  state: CampaignState,
  heroId: string,
  type: EquipmentType,
  loadoutIdx: number,
  slotIdx: number,
): void {
  const res = state.pendingAcademyDonationResolution;
  if (!res) {
    throw new Error("recordAcademyDonationPlacement: no resolution staged");
  }
  if (loadoutIdx < 0 || loadoutIdx > 2 || slotIdx < 0 || slotIdx > 2) {
    throw new Error(
      `recordAcademyDonationPlacement: loadoutIdx/slotIdx out of range (${loadoutIdx}, ${slotIdx})`,
    );
  }
  const reward = res.rewards.find(
    (r) => r.assignedHeroId === heroId && r.chosenType === type,
  );
  if (!reward) {
    throw new Error(
      `recordAcademyDonationPlacement: no reward ticket for hero "${heroId}" type "${type}"`,
    );
  }
  // Defend against double-placement on the same ticket (the modal
  // should advance to the next delver after each Confirm, but a
  // double-tap shouldn't corrupt the queue).
  const alreadyPlaced = res.placements.some(
    (p) => p.heroId === heroId && p.type === type,
  );
  if (alreadyPlaced) {
    throw new Error(
      `recordAcademyDonationPlacement: ticket (${heroId}, ${type}) already placed`,
    );
  }
  if (!state.suitLoadouts[heroId]) {
    throw new Error(`recordAcademyDonationPlacement: unknown heroId "${heroId}"`);
  }
  const cell = state.suitLoadouts[heroId]![loadoutIdx]?.[slotIdx];
  if (cell !== null && cell !== undefined) {
    throw new Error(
      `recordAcademyDonationPlacement: slot (${loadoutIdx}, ${slotIdx}) on "${heroId}" is occupied`,
    );
  }
  const overlap = res.placements.find(
    (p) => p.heroId === heroId && p.loadoutIdx === loadoutIdx && p.slotIdx === slotIdx,
  );
  if (overlap) {
    throw new Error(
      `recordAcademyDonationPlacement: slot (${loadoutIdx}, ${slotIdx}) already targeted by an earlier ticket`,
    );
  }
  const placement: PendingAcademyDonationPlacement = {
    heroId,
    type,
    delta: reward.delta,
    loadoutIdx,
    slotIdx,
  };
  res.placements.push(placement);
  logEvent("engine.academyDonation.placement.recorded", {
    heroId,
    equipmentType: type,
    loadoutIdx,
    slotIdx,
    delta: reward.delta,
    placementsCount: res.placements.length,
    rewardsCount: res.rewards.length,
  });
}

/**
 * Apply every staged placement to `state.suitConditionRankBonus`
 * and `state.suitLoadouts`, clear `pendingAcademyDonationResolution`,
 * and return the `suit-condition-rank-bumped` reward events for
 * the post-modal rewards sweep.
 *
 * Throws if the resolution isn't fully staged (every reward
 * ticket must have a placement). The modal Confirm button gates
 * the call so this should never fire from the UI.
 */
export function commitAcademyDonationResolution(
  state: CampaignState,
): Array<Extract<RewardEvent, { kind: "suit-condition-rank-bumped" }>> {
  const res = state.pendingAcademyDonationResolution;
  if (!res) {
    throw new Error("commitAcademyDonationResolution: no resolution staged");
  }
  if (res.placements.length !== res.rewards.length) {
    throw new Error(
      `commitAcademyDonationResolution: placements (${res.placements.length}) != rewards (${res.rewards.length})`,
    );
  }
  const events: Array<Extract<RewardEvent, { kind: "suit-condition-rank-bumped" }>> = [];
  for (const placement of res.placements) {
    const { heroId, type, delta, loadoutIdx, slotIdx } = placement;
    const before = getEffectiveEquipmentRank(state, heroId, type);
    if (!state.suitConditionRankBonus[heroId]) {
      state.suitConditionRankBonus[heroId] = {};
    }
    const bucket = state.suitConditionRankBonus[heroId]!;
    const prior = bucket[type] ?? 0;
    bucket[type] = Math.min(EQUIPMENT_RANK_CAP, prior + delta);
    if (!state.suitLoadouts[heroId]) {
      state.suitLoadouts[heroId] = [[null, null, null], [null, null, null], [null, null, null]];
    }
    const loadout = state.suitLoadouts[heroId]![loadoutIdx]!;
    loadout[slotIdx] = { type, rank: delta };
    const after = getEffectiveEquipmentRank(state, heroId, type);
    const source = `academy-donation-${res.tier}`;
    events.push({
      kind: "suit-condition-rank-bumped",
      heroId,
      equipmentType: type,
      effectiveBefore: before,
      effectiveAfter: after,
      delta,
      source,
    });
    logEvent("engine.academyDonation.commit.placement", {
      heroId,
      equipmentType: type,
      delta,
      loadoutIdx,
      slotIdx,
      effectiveBefore: before,
      effectiveAfter: after,
      source,
    });
  }
  logEvent("engine.academyDonation.commit", {
    tier: res.tier,
    totalDonated: res.totalDonated,
    placementCount: res.placements.length,
  });
  state.pendingAcademyDonationResolution = null;
  return events;
}

/**
 * Abandon the staged resolution without applying any placements.
 * Exposed for debug / "reset campaign" tooling; the modal itself
 * never calls this (the player can't dismiss the modal — Confirm
 * is the only exit). Returns `true` if a resolution was cleared,
 * `false` if nothing was staged.
 */
export function clearAcademyDonationResolution(state: CampaignState): boolean {
  if (state.pendingAcademyDonationResolution == null) return false;
  state.pendingAcademyDonationResolution = null;
  return true;
}
