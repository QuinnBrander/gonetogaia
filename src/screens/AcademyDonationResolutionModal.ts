/**
 * Academy Donation Resolution modal — Chapter 2 Town Center
 * "Delving Academy Donation" bespoke flow.
 *
 * Drains `state.pendingAcademyDonationResolution` (populated by
 * `engine/academyDonation.ts > resolveAcademyDonation`) through
 * two phases:
 *
 *   Phase 1 — Assignment
 *     Display the two reward "tickets" side-by-side. For pinned
 *     tiers (small / medium) each ticket shows e.g. "+1 OS Rank"
 *     directly. For the large tier each ticket shows a "Pick
 *     equipment" button that opens an in-modal 14-button picker
 *     of `ALL_EQUIPMENT_TYPES` (text-only — no card art) so the
 *     player chooses any base equipment per ticket.
 *
 *     Below each ticket: two delver buttons (Mind / Body). The
 *     assignment is mutually-exclusive — clicking Mind on
 *     ticket #1 also assigns Body to ticket #2 (and vice-versa).
 *     A "Swap" affordance is unnecessary because clicking the
 *     OTHER delver on either ticket performs the swap implicitly.
 *
 *     CONFIRM enables once every ticket has a `chosenType` and a
 *     unique `assignedHeroId`. Advances to Phase 2.
 *
 *   Phase 2 — Placement (per delver, sequential)
 *     For each delver in turn (Mind first, Body second by the
 *     `Object.keys(state.loadouts)` order), render the delver's
 *     3-loadout × 3-slot grid. Empty cells are clickable; filled
 *     cells are locked and show their existing entry. The player
 *     picks an empty cell + clicks CONFIRM PLACEMENT; the
 *     placement is recorded on
 *     `pendingAcademyDonationResolution.placements`, and the
 *     modal advances to the next delver. Once both delvers have
 *     placed, the modal calls `commitAcademyDonationResolution`
 *     to apply all bumps + slot writes in one batch and resolves
 *     the drain promise with the collected
 *     `suit-condition-rank-bumped` reward events.
 *
 * Cancel-less by design (mirrors the suit-condition rank picker):
 * the player MUST resolve the donation before progressing past
 * the Town Center Resolution page. The TownVisit screen gates on
 * `hasPendingAcademyDonationResolution` until the modal commits.
 */

import type { Router } from "../main";
import {
  canAdvanceDonationAssignment,
  commitAcademyDonationResolution,
  recordAcademyDonationPlacement,
} from "../engine/academyDonation";
import { getEffectiveEquipmentRank } from "../state";
import type {
  CampaignState,
  PendingAcademyDonationResolution,
  PendingAcademyDonationReward,
} from "../state";
import { getEquipmentByTypeSuit, getHero } from "../data";
import {
  ALL_EQUIPMENT_TYPES,
  EQUIPMENT_RANK_CAP,
  type EquipmentType,
  type RewardEvent,
} from "../types";
import { logEvent } from "../debug/sessionLog";

// --- Module-local UI state -------------------------------------------------

/**
 * Which ticket the player is currently picking an equipment TYPE
 * for (large-tier sub-menu). `null` collapses the picker back to
 * the assignment view. Reset whenever the modal re-mounts so a
 * stale "picker open" state from a previous donation can't leak.
 */
let typePickerOpenForRewardIndex: number | null = null;

/**
 * Phase 2 selection — the cell the player has highlighted (but
 * not yet confirmed) for the active delver. Keyed by hero id so
 * a re-render across the delver advance keeps the selection per-
 * delver-isolated. Reset whenever the modal re-mounts.
 */
const selectedSlotByHeroId: Record<string, { loadoutIdx: number; slotIdx: number } | null> = {};

function resetUiState(): void {
  typePickerOpenForRewardIndex = null;
  for (const k of Object.keys(selectedSlotByHeroId)) {
    delete selectedSlotByHeroId[k];
  }
}

// --- Drain entry point -----------------------------------------------------

/**
 * Convenience adapter — drive the donation modal to completion
 * and resolve with the collected `suit-condition-rank-bumped`
 * events from the commit. Mirrors `drainSuitConditionPicksViaModal`
 * so the TownVisit screen can hand both the same `wrap` host and
 * feed both result lists into a single follow-on rewards modal.
 *
 * `_host` is accepted (and ignored) for parity with the existing
 * drain-via-modal pattern — this modal mounts its own fixed
 * overlay onto `document.body` so it sits above the Town Visit
 * surface regardless of where the caller lives in the DOM.
 *
 * No-ops + resolves with `[]` when nothing is staged so the
 * TownVisit chain can call it unconditionally.
 */
export function drainAcademyDonationResolutionViaModal(
  _host: HTMLDivElement,
  router: Router,
): Promise<Array<Extract<RewardEvent, { kind: "suit-condition-rank-bumped" }>>> {
  void _host;
  if (router.state.pendingAcademyDonationResolution == null) {
    return Promise.resolve([]);
  }
  resetUiState();
  const overlay = document.createElement("div");
  overlay.className = "academy-donation-resolution-overlay";
  document.body.appendChild(overlay);
  logEvent("ui.academyDonationResolution.start", {
    tier: router.state.pendingAcademyDonationResolution.tier,
    totalDonated: router.state.pendingAcademyDonationResolution.totalDonated,
  });

  return new Promise((resolve) => {
    const finish = (events: Array<Extract<RewardEvent, { kind: "suit-condition-rank-bumped" }>>) => {
      overlay.remove();
      resetUiState();
      logEvent("ui.academyDonationResolution.done", {
        eventCount: events.length,
      });
      resolve(events);
    };
    renderAcademyDonationResolutionModal(overlay, router, { onCommitted: finish });
  });
}

/**
 * Render the donation resolution modal into `host`. Re-renders
 * itself in-place on every state change (delver assignment, type
 * pick, slot selection, Phase advance) so the same `host` is
 * reused for the whole flow. Calls `onCommitted` once both
 * placements have been resolved AND
 * `commitAcademyDonationResolution` has run, passing the
 * resulting reward events.
 *
 * Exported for tests + as the lower-level entry point — call
 * `drainAcademyDonationResolutionViaModal` from production code
 * unless you have a strong reason to manage the host yourself.
 */
export function renderAcademyDonationResolutionModal(
  host: HTMLDivElement,
  router: Router,
  hooks: {
    onCommitted: (events: Array<Extract<RewardEvent, { kind: "suit-condition-rank-bumped" }>>) => void;
  },
): void {
  const state = router.state;
  const res = state.pendingAcademyDonationResolution;
  if (!res) {
    // Defensive: nothing staged. Call onCommitted with [] so the
    // caller's promise still resolves cleanly.
    hooks.onCommitted([]);
    return;
  }
  // Decide which phase to render based on the staged data alone.
  // This keeps the modal stateless across reloads — closing the
  // tab mid-Phase 2 and re-opening resumes at the next delver.
  const phase = derivePhase(res);
  if (phase === "assign") {
    renderAssignmentPhase(host, router, res, hooks);
    return;
  }
  if (phase === "place") {
    renderPlacementPhase(host, router, res, hooks);
    return;
  }
  // phase === "commit" — every reward has a placement. Apply the
  // commit + resolve the drain. Wrapped in try/catch so a
  // throw from the engine surfaces in the session log rather
  // than vanishing silently.
  let events: Array<Extract<RewardEvent, { kind: "suit-condition-rank-bumped" }>> = [];
  try {
    events = commitAcademyDonationResolution(state);
  } catch (err) {
    logEvent("ui.academyDonationResolution.commit.error", {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  router.save();
  hooks.onCommitted(events);
}

type Phase = "assign" | "place" | "commit";

function derivePhase(res: PendingAcademyDonationResolution): Phase {
  const allRewardsResolved = res.rewards.every(
    (r) => r.chosenType !== null && r.assignedHeroId !== null,
  );
  if (!allRewardsResolved) return "assign";
  if (res.placements.length < res.rewards.length) return "place";
  return "commit";
}

// --- Phase 1: Assignment ---------------------------------------------------

function renderAssignmentPhase(
  host: HTMLDivElement,
  router: Router,
  res: PendingAcademyDonationResolution,
  hooks: {
    onCommitted: (events: Array<Extract<RewardEvent, { kind: "suit-condition-rank-bumped" }>>) => void;
  },
): void {
  const state = router.state;
  const tierCopy = tierHeadline(res);
  const ticketsHtml = res.rewards
    .map((reward, idx) => renderTicketCard(state, reward, idx))
    .join("");
  const canConfirm = canAdvanceDonationAssignment(state);
  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body academy-donation-resolution-modal academy-donation-resolution-modal--assign">
      <header class="academy-donation-resolution-header">
        <h3>Delving Academy Donation</h3>
        <p class="small muted">${escapeHtml(tierCopy)}</p>
        <p class="small muted">Assign one delver to each reward, then Confirm.</p>
      </header>
      <div class="academy-donation-resolution-tickets">
        ${ticketsHtml}
      </div>
      <footer class="academy-donation-resolution-footer">
        <button class="btn academy-donation-resolution-confirm"
                data-academy-donation-confirm-assign
                ${canConfirm ? "" : "disabled"}>
          Confirm Assignment
        </button>
      </footer>
    </div>
  `;
  // Type-picker buttons (large tier "Pick Equipment" entry).
  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-academy-donation-open-type-picker]")) {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset["academyDonationOpenTypePicker"]);
      typePickerOpenForRewardIndex = idx;
      renderAcademyDonationResolutionModal(host, router, hooks);
    });
  }
  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-academy-donation-close-type-picker]")) {
    btn.addEventListener("click", () => {
      typePickerOpenForRewardIndex = null;
      renderAcademyDonationResolutionModal(host, router, hooks);
    });
  }
  // Type-pick buttons (inside the open type picker).
  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-academy-donation-pick-type]")) {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset["academyDonationPickType"]);
      const type = btn.dataset["academyDonationPickTypeValue"] as EquipmentType | undefined;
      const target = res.rewards[idx];
      if (!target || !type) return;
      target.chosenType = type;
      typePickerOpenForRewardIndex = null;
      logEvent("ui.academyDonationResolution.assign.type", {
        rewardIndex: idx,
        equipmentType: type,
        tier: res.tier,
      });
      router.save();
      renderAcademyDonationResolutionModal(host, router, hooks);
    });
  }
  // Delver-assignment buttons.
  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-academy-donation-assign-hero]")) {
    btn.addEventListener("click", () => {
      const rewardIdx = Number(btn.dataset["academyDonationRewardIndex"]);
      const heroId = btn.dataset["academyDonationAssignHero"];
      if (!heroId || Number.isNaN(rewardIdx)) return;
      const target = res.rewards[rewardIdx];
      if (!target) return;
      // Toggle: clicking the same hero already assigned to this
      // ticket unassigns it (player can reset before swapping).
      if (target.assignedHeroId === heroId) {
        target.assignedHeroId = null;
      } else {
        target.assignedHeroId = heroId;
        // Enforce mutex: any OTHER ticket holding this hero gets
        // its assignment swapped to the only other delver in the
        // party (or cleared when there are more than 2 — defensive
        // for a future 3-delver lineup).
        const otherHeroIds = Object.keys(state.loadouts).filter((id) => id !== heroId);
        for (let i = 0; i < res.rewards.length; i++) {
          if (i === rewardIdx) continue;
          const sibling = res.rewards[i]!;
          if (sibling.assignedHeroId === heroId) {
            sibling.assignedHeroId = otherHeroIds.length === 1 ? otherHeroIds[0]! : null;
          }
        }
      }
      logEvent("ui.academyDonationResolution.assign.hero", {
        rewardIndex: rewardIdx,
        heroId,
        tier: res.tier,
        assignments: res.rewards.map((r) => ({
          chosenType: r.chosenType,
          heroId: r.assignedHeroId,
        })),
      });
      router.save();
      renderAcademyDonationResolutionModal(host, router, hooks);
    });
  }
  // Confirm-assignment button.
  const confirmBtn = host.querySelector<HTMLButtonElement>("[data-academy-donation-confirm-assign]");
  if (confirmBtn) {
    confirmBtn.addEventListener("click", () => {
      if (!canAdvanceDonationAssignment(router.state)) return;
      logEvent("ui.academyDonationResolution.assign.confirm", {
        tier: res.tier,
        assignments: res.rewards.map((r) => ({
          chosenType: r.chosenType,
          heroId: r.assignedHeroId,
        })),
      });
      // No state mutation here — Phase 2 derives from the same
      // staged resolution. Just trigger a re-render to flip into
      // the placement phase.
      renderAcademyDonationResolutionModal(host, router, hooks);
    });
  }
}

function renderTicketCard(
  state: CampaignState,
  reward: PendingAcademyDonationReward,
  idx: number,
): string {
  const isOpenType = reward.pinnedType == null;
  const pickerOpen = typePickerOpenForRewardIndex === idx;
  let typeBlockHtml: string;
  if (pickerOpen) {
    // Render the 14-button picker INSIDE the ticket card. The
    // picker is text-only per the user spec ("just the words for
    // the base equipment, not the cards"). The button uppercases
    // the type name for visual weight in the grid.
    const buttons = ALL_EQUIPMENT_TYPES.map(
      (t) => `
        <button class="academy-donation-resolution-type-pick-btn"
                data-academy-donation-pick-type="${idx}"
                data-academy-donation-pick-type-value="${escapeHtml(t)}">
          ${escapeHtml(t.toUpperCase())}
        </button>
      `,
    ).join("");
    typeBlockHtml = `
      <div class="academy-donation-resolution-type-picker">
        <p class="small muted">Pick an equipment type:</p>
        <div class="academy-donation-resolution-type-pick-grid">${buttons}</div>
        <button class="btn btn-secondary academy-donation-resolution-type-cancel"
                data-academy-donation-close-type-picker>
          Back
        </button>
      </div>
    `;
  } else if (isOpenType && reward.chosenType == null) {
    typeBlockHtml = `
      <button class="btn academy-donation-resolution-type-open"
              data-academy-donation-open-type-picker="${idx}">
        Pick equipment +${reward.delta} Rank
      </button>
    `;
  } else {
    // Either pinned-type (small/medium) or large-tier with a
    // chosen type. Show the chosen type as a centred headline so
    // both tier shapes share the same visual frame.
    const headline = `${reward.chosenType ?? reward.pinnedType ?? "—"} +${reward.delta} Rank`;
    const repickAffordance = isOpenType
      ? `<button class="academy-donation-resolution-type-repick small"
                  data-academy-donation-open-type-picker="${idx}">
            change
          </button>`
      : "";
    typeBlockHtml = `
      <div class="academy-donation-resolution-type-headline">
        <span class="academy-donation-resolution-type-headline-text">${escapeHtml(headline)}</span>
        ${repickAffordance}
      </div>
    `;
  }
  // Delver-assignment row. Only render when the ticket has a
  // chosen type — otherwise the player should pick a type first
  // (assignment is meaningless without knowing what's being
  // assigned to whom).
  const assignmentHtml = reward.chosenType != null && !pickerOpen
    ? renderAssignmentRow(state, reward, idx)
    : "";
  return `
    <article class="academy-donation-resolution-ticket">
      <header class="academy-donation-resolution-ticket-header">
        <span class="academy-donation-resolution-ticket-label small muted">Reward ${idx + 1}</span>
      </header>
      <div class="academy-donation-resolution-ticket-type">
        ${typeBlockHtml}
      </div>
      ${assignmentHtml}
    </article>
  `;
}

function renderAssignmentRow(
  state: CampaignState,
  reward: PendingAcademyDonationReward,
  idx: number,
): string {
  const heroIds = Object.keys(state.loadouts);
  const buttons = heroIds
    .map((heroId) => {
      const hero = getHero(heroId);
      const selected = reward.assignedHeroId === heroId;
      const label = hero.suit === "mind" ? "Mind" : "Body";
      return `
        <button class="academy-donation-resolution-assign-btn turn-${hero.suit}${selected ? " academy-donation-resolution-assign-btn--selected" : ""}"
                data-academy-donation-assign-hero="${escapeHtml(heroId)}"
                data-academy-donation-reward-index="${idx}">
          ${escapeHtml(label)} Delver
        </button>
      `;
    })
    .join("");
  return `
    <div class="academy-donation-resolution-assign-row">
      <p class="small muted">Assign delver:</p>
      <div class="academy-donation-resolution-assign-buttons">${buttons}</div>
    </div>
  `;
}

// --- Phase 2: Placement ----------------------------------------------------

function renderPlacementPhase(
  host: HTMLDivElement,
  router: Router,
  res: PendingAcademyDonationResolution,
  hooks: {
    onCommitted: (events: Array<Extract<RewardEvent, { kind: "suit-condition-rank-bumped" }>>) => void;
  },
): void {
  const state = router.state;
  // Find the next reward whose ticket hasn't been placed yet.
  // Walk in the same order the player assigned (so the modal
  // visits delvers in a stable, predictable sequence).
  const remaining = res.rewards.filter(
    (r) =>
      !res.placements.some(
        (p) => p.heroId === r.assignedHeroId && p.type === r.chosenType,
      ),
  );
  const reward = remaining[0]!;
  const heroId = reward.assignedHeroId!;
  const type = reward.chosenType!;
  const hero = getHero(heroId);
  const heroLabel = hero.suit === "mind" ? "Mind Delver" : "Body Delver";
  const stepLabel = `Placement ${res.placements.length + 1} of ${res.rewards.length}`;
  const before = getEffectiveEquipmentRank(state, heroId, type);
  const after = Math.min(before + reward.delta, EQUIPMENT_RANK_CAP);
  const beforeLabel = before === 0 ? "(not owned)" : `R${before}`;
  // Render the 3x3 loadout grid. Empty cells are clickable;
  // filled cells (either pre-existing or written by an earlier
  // placement in this same resolution) are locked. We OR-merge
  // the current `suitLoadouts` with the in-flight `placements`
  // so a cell the player has already picked in a previous
  // delver's turn stays visibly locked — defensive even though
  // each delver has their own grid in the 2-delver lineup.
  const heroLoadouts = state.suitLoadouts[heroId]
    ?? [[null, null, null], [null, null, null], [null, null, null]];
  const selection = selectedSlotByHeroId[heroId] ?? null;
  const gridHtml = heroLoadouts
    .map((slots, lIdx) => renderLoadoutColumn(slots, lIdx, selection))
    .join("");
  const hasSelection = selection !== null;
  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body academy-donation-resolution-modal academy-donation-resolution-modal--place">
      <header class="academy-donation-resolution-header">
        <h3>${escapeHtml(heroLabel)}: Place +${reward.delta} ${escapeHtml(type)} Rank</h3>
        <p class="small muted">${escapeHtml(stepLabel)} \u2014 ${escapeHtml(beforeLabel)} \u2192 R${after}</p>
        <p class="small muted">Pick an empty slot in any loadout, then Confirm Placement.</p>
        <p class="small loadout-placement-tip"><strong>Tip:</strong> you can only take 1 loadout into each quest, so best practice is to fill all slots of 1 loadout first.</p>
      </header>
      <div class="academy-donation-resolution-loadouts">${gridHtml}</div>
      <footer class="academy-donation-resolution-footer">
        <button class="btn academy-donation-resolution-confirm"
                data-academy-donation-confirm-place
                ${hasSelection ? "" : "disabled"}>
          Confirm Placement
        </button>
      </footer>
    </div>
  `;
  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-academy-donation-pick-slot]")) {
    btn.addEventListener("click", () => {
      const lIdx = Number(btn.dataset["academyDonationLoadoutIdx"]);
      const sIdx = Number(btn.dataset["academyDonationSlotIdx"]);
      if (Number.isNaN(lIdx) || Number.isNaN(sIdx)) return;
      selectedSlotByHeroId[heroId] = { loadoutIdx: lIdx, slotIdx: sIdx };
      logEvent("ui.academyDonationResolution.place.select", {
        heroId,
        equipmentType: type,
        loadoutIdx: lIdx,
        slotIdx: sIdx,
      });
      renderAcademyDonationResolutionModal(host, router, hooks);
    });
  }
  const confirmBtn = host.querySelector<HTMLButtonElement>("[data-academy-donation-confirm-place]");
  if (confirmBtn) {
    confirmBtn.addEventListener("click", () => {
      const sel = selectedSlotByHeroId[heroId];
      if (!sel) return;
      try {
        recordAcademyDonationPlacement(state, heroId, type, sel.loadoutIdx, sel.slotIdx);
      } catch (err) {
        // Defensive — the grid only renders clickable empty slots so
        // this should never fire in practice. Log + bail so a real
        // bug surfaces in the session log.
        logEvent("ui.academyDonationResolution.place.error", {
          heroId,
          equipmentType: type,
          loadoutIdx: sel.loadoutIdx,
          slotIdx: sel.slotIdx,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      selectedSlotByHeroId[heroId] = null;
      router.save();
      logEvent("ui.academyDonationResolution.place.confirm", {
        heroId,
        equipmentType: type,
        loadoutIdx: sel.loadoutIdx,
        slotIdx: sel.slotIdx,
        placementsSoFar: state.pendingAcademyDonationResolution?.placements.length ?? 0,
      });
      renderAcademyDonationResolutionModal(host, router, hooks);
    });
  }
}

function renderLoadoutColumn(
  slots: Array<{ type: EquipmentType; rank: number } | null>,
  loadoutIdx: number,
  selection: { loadoutIdx: number; slotIdx: number } | null,
): string {
  const cells = slots
    .map((cell, sIdx) => {
      const isSelected = selection !== null
        && selection.loadoutIdx === loadoutIdx
        && selection.slotIdx === sIdx;
      if (cell === null) {
        return `
          <button class="academy-donation-resolution-slot academy-donation-resolution-slot--empty${isSelected ? " academy-donation-resolution-slot--selected" : ""}"
                  data-academy-donation-pick-slot
                  data-academy-donation-loadout-idx="${loadoutIdx}"
                  data-academy-donation-slot-idx="${sIdx}">
            <span class="academy-donation-resolution-slot-name small muted">Empty</span>
            <span class="academy-donation-resolution-slot-rank muted">+</span>
          </button>
        `;
      }
      return `
        <div class="academy-donation-resolution-slot academy-donation-resolution-slot--filled">
          <span class="academy-donation-resolution-slot-name small">${escapeHtml(typeDisplayName(cell.type))}</span>
          <span class="academy-donation-resolution-slot-rank">+${cell.rank}</span>
        </div>
      `;
    })
    .join("");
  return `
    <div class="academy-donation-resolution-loadout-card">
      <div class="academy-donation-resolution-loadout-header">
        <span class="academy-donation-resolution-loadout-title">Loadout ${loadoutIdx + 1}</span>
      </div>
      <div class="academy-donation-resolution-loadout-slots">${cells}</div>
    </div>
  `;
}

// --- Helpers ---------------------------------------------------------------

function tierHeadline(res: PendingAcademyDonationResolution): string {
  switch (res.tier) {
    case "small":  return `Small Reward Tier (${res.totalDonated} minion parts donated)`;
    case "medium": return `Medium Reward Tier (${res.totalDonated} minion parts donated)`;
    case "large":  return `Large Reward Tier (${res.totalDonated} minion parts donated)`;
  }
}

/**
 * Friendly display name for an equipment type. We try the suit-
 * neutral catalog name first (Mind R1 today — both suits agree on
 * display names per `data/equipment.json`), and fall back to the
 * raw type identifier if the catalog lookup throws (defensive
 * against a type we haven't catalogued yet).
 */
function typeDisplayName(type: EquipmentType): string {
  try {
    return getEquipmentByTypeSuit("mind", type).name;
  } catch {
    return type;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
