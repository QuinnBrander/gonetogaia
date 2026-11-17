/**
 * Suit Condition Rank Pick modal — drains
 * `state.pendingSuitConditionPicks` one entry at a time through the
 * same two-phase UX as `AcademyDonationResolutionModal`:
 *
 *   Phase 1 — Assignment
 *     - Pick a delver (auto-skipped if the queue head pins one).
 *     - Pick an equipment TYPE — text-only buttons (UPPERCASE),
 *       no card art. Each choice shows the rank it reaches with the
 *       bonus ("R2 → R3"; boss-card unlocks show the cap, "max R3 →
 *       R4") via `previewSuitConditionPick` (user request 2026-11-15;
 *       this used to be hidden on purpose).
 *       (Skipped when `pick.pinnedType` is set.)
 *     - "Confirm Assignment" enables once both are chosen.
 *
 *   Phase 2 — Placement
 *     - Render the chosen delver's 3-loadout × 3-slot grid.
 *     - Empty cells are clickable; filled cells lock and display
 *       their existing entry.
 *     - "Confirm Placement" commits the pick to the chosen cell
 *       via `applySuitConditionRankPickToSlot`, advances the queue,
 *       and either re-mounts the modal for the next pick or
 *       resolves the drain promise.
 *
 *   Boss-card unlock picks (`unlockHigherRanks === true`) skip
 *   Phase 2 entirely — the unlock raises the rank cap on a type
 *   but writes nothing to `suitLoadouts`, so there's no cell for
 *   the player to choose. Their "Confirm Assignment" button is
 *   labelled "Confirm Unlock" and commits via the legacy
 *   `applySuitConditionRankPick` (which is a no-op on loadouts for
 *   these picks by design).
 *
 * No Cancel: `hasPendingSuitConditionRankPicks` in
 * `screens/TownVisit.ts` keeps the player gated until the queue
 * drains, matching the academy-donation gate.
 *
 * CSS reuse: shares the `.academy-donation-resolution-*` styles
 * for the type picker + 3x3 grid so the two flows feel visually
 * identical. Only the hero-row + picked-hero badge keep their
 * original `.suit-condition-rank-*` classes because those affordances
 * don't exist in the donation modal (donations bake hero choice
 * into each ticket).
 */

import type { Router } from "../main";
import {
  applySuitConditionRankPick,
  applySuitConditionRankPickToSlot,
  eligibleEquipmentTypesForSuitConditionPick,
  peekNextSuitConditionRankPick,
  previewSuitConditionPick,
} from "../engine/suitConditionGrants";
import {
  type CampaignState,
  type PendingSuitConditionRankPick,
} from "../state";
import { getHero } from "../data";
import {
  ALL_EQUIPMENT_TYPES,
  type EquipmentType,
  type RewardEvent,
} from "../types";
import { logEvent } from "../debug/sessionLog";
import { presentRewards } from "./RewardsModal";
import { renderSuitConditionArt } from "../ui/suitConditionArt";
import { REMOTE_APPLIED_EVENT } from "../net/onlineController";

// --- Module-local UI state ------------------------------------------------

/**
 * Per-pick UI selection state. Reset whenever the queue head's
 * `pickId` changes so a stale selection from a previous pick can't
 * leak into the next one's render.
 */
interface PickUi {
  pickId: string;
  heroId: string | null;
  type: EquipmentType | null;
  slot: { loadoutIdx: number; slotIdx: number } | null;
  /** True while the in-modal type chooser is expanded. Only meaningful when `type` is null. */
  typeChooserOpen: boolean;
}

let ui: PickUi | null = null;

function ensureUiForPick(state: CampaignState, pick: PendingSuitConditionRankPick): PickUi {
  if (ui != null && ui.pickId === pick.pickId) return ui;
  // Reset selection when the queue head changes. Seed pinned values
  // so a fully-pinned pick (e.g. paired second pick after the first
  // resolved) lands directly on the placement phase.
  const seededHero = pick.heroId ?? autoHeroIfOnlyOneEligible(state, pick);
  ui = {
    pickId: pick.pickId,
    heroId: seededHero,
    type: pick.pinnedType ?? null,
    slot: null,
    typeChooserOpen: false,
  };
  return ui;
}

function resetUi(): void {
  ui = null;
}

/**
 * When the queue head's hero is open AND only one delver has any
 * eligible types (the other's slots are all at rank cap or excluded
 * by `allowedTypes`), auto-seed the hero so the player isn't shown
 * a 2-button picker where one is disabled. Mirrors the auto-select
 * behaviour the original modal had inline.
 */
function autoHeroIfOnlyOneEligible(
  state: CampaignState,
  pick: PendingSuitConditionRankPick,
): string | null {
  if (pick.heroId != null) return pick.heroId;
  const eligibleHeroIds = Object.keys(state.loadouts).filter(
    (hId) =>
      eligibleEquipmentTypesForSuitConditionPick(state, pick, hId, ALL_EQUIPMENT_TYPES)
        .length > 0,
  );
  return eligibleHeroIds.length === 1 ? eligibleHeroIds[0]! : null;
}

// --- Drain entry point ----------------------------------------------------

/**
 * Convenience adapter — drain the entire queue via the modal,
 * collecting every `suit-condition-rank-bumped` event into a single
 * array. Mounts a fixed-overlay host on `document.body` so the
 * picker sits above the Town Visit / Wave Phase surface regardless
 * of where the caller lives in the DOM.
 *
 * `_host` is accepted (and ignored) for parity with
 * `drainAcademyDonationResolutionViaModal` and the rewards modal
 * presenter — every concrete drain helper takes the same shape so
 * callers can hand them all the same wrap host.
 */
export function drainSuitConditionPicksViaModal(
  _host: HTMLDivElement,
  router: Router,
): Promise<Array<Extract<RewardEvent, { kind: "suit-condition-rank-bumped" }>>> {
  void _host;
  const overlay = document.createElement("div");
  overlay.className = "suit-condition-rank-overlay";
  document.body.appendChild(overlay);
  resetUi();

  return new Promise((resolve) => {
    const collected: Array<Extract<RewardEvent, { kind: "suit-condition-rank-bumped" }>> = [];
    // Online: picks for the other delver are made on their player's screen
    // — redraw (or finish) when their pick arrives.
    const onRemote = () => tick();
    document.addEventListener(REMOTE_APPLIED_EVENT, onRemote);
    const tick = () => {
      renderSuitConditionRankPickModal(overlay, router, {
        onDrained: () => {
          document.removeEventListener(REMOTE_APPLIED_EVENT, onRemote);
          overlay.remove();
          resetUi();
          resolve(collected);
        },
        onPickResolved: (ev) => {
          collected.push(ev);
          tick();
        },
      });
    };
    tick();
  });
}

// --- Render entry point ---------------------------------------------------

/**
 * Render the suit-condition picker into `host`. If the queue is
 * empty, dismisses itself by calling `onDrained()` so the caller
 * can resume normal navigation.
 *
 * Re-renders itself in-place on every selection / phase change.
 * The router is NOT refreshed between clicks because this modal is
 * mounted into a fixed overlay that lives outside the screen wrap
 * — calling router.refresh would tear down the host's parent
 * (TownVisit / WavePhases) mid-drain.
 *
 * `onPickResolved` is fired AFTER each pick lands so the host can
 * surface the resulting `suit-condition-rank-bumped` event in its
 * rewards bus / log.
 */
export function renderSuitConditionRankPickModal(
  host: HTMLDivElement,
  router: Router,
  hooks: {
    /** Called when the queue drains (no pending picks remain). */
    onDrained: () => void;
    /** Called after each pick resolves with the resulting event. */
    onPickResolved?: (event: Extract<RewardEvent, { kind: "suit-condition-rank-bumped" }>) => void;
  },
): void {
  const state = router.state;
  const pick = peekNextSuitConditionRankPick(state);
  if (!pick) {
    hooks.onDrained();
    return;
  }
  const pickUi = ensureUiForPick(state, pick);
  const phase = derivePhase(pick, pickUi);

  if (phase === "assign") {
    renderAssignPhase(host, router, pick, pickUi, hooks);
    return;
  }
  // phase === "place"
  renderPlacePhase(host, router, pick, pickUi, hooks);
}

type Phase = "assign" | "place";

function derivePhase(pick: PendingSuitConditionRankPick, pickUi: PickUi): Phase {
  // Boss-card unlocks never leave Phase 1 — there's no slot to choose,
  // the assign phase confirms the unlock and dispatches commit.
  if (pick.unlockHigherRanks) return "assign";
  // Otherwise we move to Phase 2 once both selections are made.
  if (pickUi.heroId != null && pickUi.type != null) return "place";
  return "assign";
}

// --- Phase 1: Assignment --------------------------------------------------

function renderAssignPhase(
  host: HTMLDivElement,
  router: Router,
  pick: PendingSuitConditionRankPick,
  pickUi: PickUi,
  hooks: {
    onDrained: () => void;
    onPickResolved?: (event: Extract<RewardEvent, { kind: "suit-condition-rank-bumped" }>) => void;
  },
): void {
  const state = router.state;
  const heading = headingFor(pick);
  const subline = sublineFor(pick);
  const remainingAfterThis = Math.max(0, state.pendingSuitConditionPicks.length - 1);
  const heroIds = Object.keys(state.loadouts);

  const heroBlockHtml = pickUi.heroId == null
    ? renderHeroPicker(state, pick, heroIds)
    : renderHeroPicked(pickUi.heroId);

  // Once the hero is locked in we can show the type chooser. The
  // type chooser is text-only — `pick.allowedTypes` narrows it to
  // a specific subset (boss-card suit parts), otherwise the player
  // picks from `ALL_EQUIPMENT_TYPES`. When `pick.pinnedType` is set
  // we skip the chooser entirely and just display the headline.
  let typeBlockHtml = "";
  if (pickUi.heroId != null) {
    typeBlockHtml = renderTypeBlock(state, pick, pickUi);
  }

  const canConfirm = pickUi.heroId != null && pickUi.type != null;
  const confirmLabel = pick.unlockHigherRanks
    ? "Confirm Unlock"
    : pickUi.type != null
      ? "Continue to Placement"
      : "Continue to Placement";

  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body suit-condition-rank-modal academy-donation-resolution-modal academy-donation-resolution-modal--assign${pick.unlockHigherRanks ? " suit-condition-rank-modal--unlock" : ""}">
      <header class="suit-condition-rank-modal-header academy-donation-resolution-header">
        <h3>${escapeHtml(heading)}</h3>
        <p class="small muted">${escapeHtml(subline)}</p>
        ${remainingAfterThis > 0
          ? `<p class="small muted suit-condition-rank-modal-queue">${remainingAfterThis} more pick${remainingAfterThis === 1 ? "" : "s"} pending after this.</p>`
          : ""}
      </header>
      ${pick.unlockHigherRanks
        ? `<div class="suit-condition-rank-unlock-layout">
            <div class="suit-condition-rank-unlock-art">${renderUnlockArt(state, pick, pickUi, heroIds)}</div>
            <div class="suit-condition-rank-modal-body">
              ${heroBlockHtml}
              ${typeBlockHtml}
            </div>
          </div>`
        : `<div class="suit-condition-rank-modal-body">
            ${heroBlockHtml}
            ${typeBlockHtml}
          </div>`}
      <footer class="academy-donation-resolution-footer">
        <button class="btn academy-donation-resolution-confirm"
                data-suit-pick-confirm-assign
                ${canConfirm ? "" : "disabled"}>
          ${escapeHtml(confirmLabel)}
        </button>
      </footer>
    </div>
  `;

  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-suit-pick-hero]")) {
    btn.addEventListener("click", () => {
      const hId = btn.dataset["suitPickHero"];
      if (!hId) return;
      pickUi.heroId = hId;
      // Changing hero invalidates the chosen type when it's no
      // longer eligible (e.g. the other delver had that slot at
      // cap). Re-validate and clear so the player picks again.
      if (pickUi.type != null) {
        const stillEligible = eligibleEquipmentTypesForSuitConditionPick(
          state,
          pick,
          hId,
          ALL_EQUIPMENT_TYPES,
        ).includes(pickUi.type);
        if (!stillEligible) {
          pickUi.type = null;
        }
      }
      logEvent("ui.suitConditionRankPick.assign.hero", {
        pickId: pick.pickId,
        heroId: hId,
        source: pick.source,
      });
      renderSuitConditionRankPickModal(host, router, hooks);
    });
  }
  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-suit-pick-open-type-chooser]")) {
    btn.addEventListener("click", () => {
      pickUi.typeChooserOpen = true;
      renderSuitConditionRankPickModal(host, router, hooks);
    });
  }
  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-suit-pick-close-type-chooser]")) {
    btn.addEventListener("click", () => {
      pickUi.typeChooserOpen = false;
      renderSuitConditionRankPickModal(host, router, hooks);
    });
  }
  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-suit-pick-type]")) {
    btn.addEventListener("click", () => {
      const type = btn.dataset["suitPickType"] as EquipmentType | undefined;
      if (!type) return;
      pickUi.type = type;
      pickUi.typeChooserOpen = false;
      logEvent("ui.suitConditionRankPick.assign.type", {
        pickId: pick.pickId,
        heroId: pickUi.heroId,
        equipmentType: type,
        source: pick.source,
      });
      renderSuitConditionRankPickModal(host, router, hooks);
    });
  }
  const confirmBtn = host.querySelector<HTMLButtonElement>("[data-suit-pick-confirm-assign]");
  if (confirmBtn) {
    confirmBtn.addEventListener("click", () => {
      if (pickUi.heroId == null || pickUi.type == null) return;
      if (pick.unlockHigherRanks) {
        // Boss-card unlock — no Phase 2. Commit immediately.
        commitUnlockPick(router, pick, pickUi.heroId, pickUi.type, hooks);
        return;
      }
      // Non-unlock — re-render to enter Phase 2. No state mutation
      // here; the placement phase derives from the same UI state.
      renderSuitConditionRankPickModal(host, router, hooks);
    });
  }
}

/**
 * Boss-card unlock picks show the printed Suit Condition sheet with the
 * delver's current rank caps (filled R4/R5 dots) so the player can see
 * the whole suit before choosing. Eligible types are clickable rows on
 * the art; the selected type previews the dot it would unlock. Before
 * a delver is chosen, both delvers' sheets show read-only.
 */
function renderUnlockArt(
  state: CampaignState,
  pick: PendingSuitConditionRankPick,
  pickUi: PickUi,
  heroIds: string[],
): string {
  const sheet = (heroId: string, interactive: boolean): string => {
    const hero = getHero(heroId);
    const eligible = interactive
      ? eligibleEquipmentTypesForSuitConditionPick(state, pick, heroId, ALL_EQUIPMENT_TYPES)
      : [];
    const selected = interactive ? pickUi.type : null;
    return `
      <figure class="suit-condition-rank-unlock-sheet">
        <figcaption class="turn-${hero.suit}">${hero.suit === "mind" ? "Mind Delver" : "Body Delver"} — current rank access</figcaption>
        ${renderSuitConditionArt(state, heroId, hero.suit, {
          pickable: eligible,
          selected,
          selectedAfter: selected ? previewSuitConditionPick(state, pick, heroId, selected).after : undefined,
        })}
      </figure>
    `;
  };
  if (pickUi.heroId != null) return sheet(pickUi.heroId, true);
  return `<div class="suit-condition-rank-unlock-sheets">${heroIds.map((h) => sheet(h, false)).join("")}</div>`;
}

function renderHeroPicker(
  state: CampaignState,
  pick: PendingSuitConditionRankPick,
  heroIds: string[],
): string {
  const buttons = heroIds.map((heroId) => {
    const hero = getHero(heroId);
    const eligible = eligibleEquipmentTypesForSuitConditionPick(
      state,
      pick,
      heroId,
      ALL_EQUIPMENT_TYPES,
    );
    const noSlots = eligible.length === 0;
    return `
      <button class="suit-condition-rank-hero-btn turn-${hero.suit}${noSlots ? " suit-condition-rank-hero-btn--disabled" : ""}"
              data-suit-pick-hero="${escapeHtml(heroId)}"
              ${noSlots ? "disabled" : ""}
              title="${escapeHtml(noSlots ? "No eligible slots on this delver (at rank cap)." : `Pick ${hero.suit} delver`)}">
        <span class="suit-condition-rank-hero-suit">${hero.suit === "mind" ? "Mind" : "Body"}</span>
        <span class="suit-condition-rank-hero-name">delver</span>
      </button>
    `;
  }).join("");
  return `
    <section class="suit-condition-rank-step">
      <p class="suit-condition-rank-step-title small muted">Pick a delver</p>
      <div class="suit-condition-rank-hero-row">${buttons}</div>
    </section>
  `;
}

function renderHeroPicked(heroId: string): string {
  const hero = getHero(heroId);
  return `
    <section class="suit-condition-rank-step suit-condition-rank-step--picked">
      <span class="suit-condition-rank-step-hero turn-${hero.suit}">${escapeHtml(hero.suit === "mind" ? "Mind Delver" : "Body Delver")}</span>
    </section>
  `;
}

/**
 * Render the type-selection block for Phase 1. Three shapes:
 *   - Pinned type: show "TYPE +N RANK" headline (no chooser).
 *   - Chosen type (chooser closed): show headline + "change" affordance.
 *   - No type yet, OR chooser explicitly re-opened via "change":
 *     show the eligible-type buttons inline. A "Back" affordance is
 *     only added when there's a previously-picked type to fall back
 *     to (otherwise there's no prior state to return to and the
 *     button would be a no-op cul-de-sac).
 *
 * Bug history (2026-05-25): an earlier shape gated the inline chooser
 * behind a "Pick equipment +N Rank" wrapper button, costing the
 * player an extra click before any types appeared. Repro: Quest 2
 * Wave 1 boss-card unlock with `allowedTypes=[Gauntlet,Hammer,Trident]`
 * — the player saw a single "Pick equipment +1 Rank" button and
 * read it as "the choices are missing". Inlining the chooser when
 * no type is picked surfaces the 3 options immediately.
 */
function renderTypeBlock(
  state: CampaignState,
  pick: PendingSuitConditionRankPick,
  pickUi: PickUi,
): string {
  const heroId = pickUi.heroId!;
  const eligible = eligibleEquipmentTypesForSuitConditionPick(
    state,
    pick,
    heroId,
    ALL_EQUIPMENT_TYPES,
  );
  if (eligible.length === 0) {
    return `
      <section class="suit-condition-rank-step">
        <p class="small muted">No eligible slots for this delver (all at rank cap). Pick a different delver above.</p>
      </section>
    `;
  }
  // Pinned type — just show the headline.
  if (pick.pinnedType != null) {
    const headline = `${pick.pinnedType.toUpperCase()} +${pick.delta} RANK`;
    return `
      <section class="suit-condition-rank-step suit-condition-rank-step--picked">
        <div class="academy-donation-resolution-type-headline">
          <span class="academy-donation-resolution-type-headline-text">${escapeHtml(headline)}</span>
          <span class="suit-condition-rank-preview">${escapeHtml(rankPreviewLabel(state, pick, heroId, pick.pinnedType))}</span>
        </div>
      </section>
    `;
  }
  // Player has chosen a type AND chooser is collapsed — show
  // headline + "change" affordance to re-open the chooser.
  if (pickUi.type != null && !pickUi.typeChooserOpen) {
    const headline = `${pickUi.type.toUpperCase()} +${pick.delta} RANK`;
    return `
      <section class="suit-condition-rank-step suit-condition-rank-step--picked">
        <div class="academy-donation-resolution-type-headline">
          <span class="academy-donation-resolution-type-headline-text">${escapeHtml(headline)}</span>
          <span class="suit-condition-rank-preview">${escapeHtml(rankPreviewLabel(state, pick, heroId, pickUi.type))}</span>
          <button class="academy-donation-resolution-type-repick small"
                  data-suit-pick-open-type-chooser>
            change
          </button>
        </div>
      </section>
    `;
  }
  // Chooser is visible — either because no type is picked yet (the
  // initial state for non-pinned picks) or because the player clicked
  // "change". Render the text-only type grid. `allowedTypes` narrows
  // the catalog for boss-card suit-part picks; otherwise it's the
  // eligible subset of `ALL_EQUIPMENT_TYPES` (each type already
  // filtered for "not at rank cap" by
  // `eligibleEquipmentTypesForSuitConditionPick`).
  const buttons = eligible.map((t) => `
    <button class="academy-donation-resolution-type-pick-btn"
            data-suit-pick-type="${escapeHtml(t)}">
      ${escapeHtml(t.toUpperCase())}
      <span class="suit-condition-rank-preview">${escapeHtml(rankPreviewLabel(state, pick, heroId, t))}</span>
    </button>
  `).join("");
  // "Back" only makes sense when there's a previously-picked type
  // to collapse to. In the first-render-no-pick case there's no
  // prior state, so the chooser is the entry point.
  const backHtml = pickUi.type != null
    ? `<button class="btn btn-secondary academy-donation-resolution-type-cancel"
               data-suit-pick-close-type-chooser>
         Back
       </button>`
    : "";
  return `
    <section class="suit-condition-rank-step">
      <p class="small muted">Pick an equipment type:</p>
      <div class="academy-donation-resolution-type-pick-grid">${buttons}</div>
      ${backHtml}
    </section>
  `;
}

// --- Phase 2: Placement ---------------------------------------------------

function renderPlacePhase(
  host: HTMLDivElement,
  router: Router,
  pick: PendingSuitConditionRankPick,
  pickUi: PickUi,
  hooks: {
    onDrained: () => void;
    onPickResolved?: (event: Extract<RewardEvent, { kind: "suit-condition-rank-bumped" }>) => void;
  },
): void {
  const state = router.state;
  const heroId = pickUi.heroId!;
  const type = pickUi.type!;
  const hero = getHero(heroId);
  const heroLabel = hero.suit === "mind" ? "Mind Delver" : "Body Delver";
  const heading = headingFor(pick);
  const headline = `${type.toUpperCase()} +${pick.delta} RANK`;

  const heroLoadouts = state.suitLoadouts[heroId]
    ?? [[null, null, null], [null, null, null], [null, null, null]];
  const gridHtml = heroLoadouts
    .map((slots, lIdx) => renderLoadoutColumn(slots, lIdx, pickUi.slot))
    .join("");
  const hasSelection = pickUi.slot !== null;
  const remainingAfterThis = Math.max(0, state.pendingSuitConditionPicks.length - 1);

  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body suit-condition-rank-modal academy-donation-resolution-modal academy-donation-resolution-modal--place">
      <header class="suit-condition-rank-modal-header academy-donation-resolution-header">
        <h3>${escapeHtml(heading)}</h3>
        <p class="small muted">${escapeHtml(heroLabel)} \u2014 ${escapeHtml(headline)} (${escapeHtml(rankPreviewLabel(state, pick, heroId, type))})</p>
        <p class="small muted">Pick an empty slot in any Loadout, then Confirm Placement.</p>
        <p class="small loadout-placement-tip"><strong>Tip:</strong> you can only take 1 loadout into each quest, so best practice is to fill all slots of 1 loadout first.</p>
        ${remainingAfterThis > 0
          ? `<p class="small muted suit-condition-rank-modal-queue">${remainingAfterThis} more pick${remainingAfterThis === 1 ? "" : "s"} pending after this.</p>`
          : ""}
      </header>
      <div class="academy-donation-resolution-loadouts">${gridHtml}</div>
      <footer class="academy-donation-resolution-footer">
        ${pick.pinnedType == null || pick.heroId == null
          ? `<button class="btn btn-secondary academy-donation-resolution-type-cancel"
                data-suit-pick-back-to-assign>
          Back
        </button>`
          : ""}
        <button class="btn academy-donation-resolution-confirm"
                data-suit-pick-confirm-place
                ${hasSelection ? "" : "disabled"}>
          Confirm Placement
        </button>
      </footer>
    </div>
  `;

  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-suit-pick-slot]")) {
    btn.addEventListener("click", () => {
      const lIdx = Number(btn.dataset["suitPickLoadoutIdx"]);
      const sIdx = Number(btn.dataset["suitPickSlotIdx"]);
      if (Number.isNaN(lIdx) || Number.isNaN(sIdx)) return;
      pickUi.slot = { loadoutIdx: lIdx, slotIdx: sIdx };
      logEvent("ui.suitConditionRankPick.place.select", {
        pickId: pick.pickId,
        heroId,
        equipmentType: type,
        loadoutIdx: lIdx,
        slotIdx: sIdx,
      });
      renderSuitConditionRankPickModal(host, router, hooks);
    });
  }
  const backBtn = host.querySelector<HTMLButtonElement>("[data-suit-pick-back-to-assign]");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      // Back to Phase 1 so the player can change the upgrade they
      // chose. The phase is derived from hero + type, so one of them
      // must be cleared or the modal lands straight back here: clear
      // the type (and reopen the chooser) when it's the player's
      // choice, else clear the delver when that's the open choice.
      pickUi.slot = null;
      if (pick.pinnedType == null) {
        pickUi.type = null;
        pickUi.typeChooserOpen = true;
      } else if (pick.heroId == null) {
        pickUi.heroId = null;
      }
      renderSuitConditionRankPickModal(host, router, hooks);
    });
  }
  const confirmBtn = host.querySelector<HTMLButtonElement>("[data-suit-pick-confirm-place]");
  if (confirmBtn) {
    confirmBtn.addEventListener("click", () => {
      if (!pickUi.slot) return;
      commitPlacementPick(
        router,
        pick,
        heroId,
        type,
        pickUi.slot.loadoutIdx,
        pickUi.slot.slotIdx,
        hooks,
      );
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
                  data-suit-pick-slot
                  data-suit-pick-loadout-idx="${loadoutIdx}"
                  data-suit-pick-slot-idx="${sIdx}">
            <span class="academy-donation-resolution-slot-name small muted">Empty</span>
            <span class="academy-donation-resolution-slot-rank muted">+</span>
          </button>
        `;
      }
      return `
        <div class="academy-donation-resolution-slot academy-donation-resolution-slot--filled">
          <span class="academy-donation-resolution-slot-name small">${escapeHtml(cell.type.toUpperCase())}</span>
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

// --- Commit helpers -------------------------------------------------------

function commitPlacementPick(
  router: Router,
  pick: PendingSuitConditionRankPick,
  heroId: string,
  type: EquipmentType,
  loadoutIdx: number,
  slotIdx: number,
  hooks: {
    onDrained: () => void;
    onPickResolved?: (event: Extract<RewardEvent, { kind: "suit-condition-rank-bumped" }>) => void;
  },
): void {
  let result;
  try {
    result = applySuitConditionRankPickToSlot(
      router.state,
      pick.pickId,
      heroId,
      type,
      loadoutIdx,
      slotIdx,
    );
  } catch (err) {
    // Defensive — the modal only renders empty/valid cells so this
    // should never fire in practice. Log + bail so a real bug
    // surfaces in the session log rather than vanishing.
    logEvent("ui.suitConditionRankPick.place.error", {
      pickId: pick.pickId,
      heroId,
      equipmentType: type,
      loadoutIdx,
      slotIdx,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  router.save();
  resetUi();
  hooks.onPickResolved?.(result.reward);
}

function commitUnlockPick(
  router: Router,
  pick: PendingSuitConditionRankPick,
  heroId: string,
  type: EquipmentType,
  hooks: {
    onDrained: () => void;
    onPickResolved?: (event: Extract<RewardEvent, { kind: "suit-condition-rank-bumped" }>) => void;
  },
): void {
  let result;
  try {
    result = applySuitConditionRankPick(router.state, pick.pickId, heroId, type);
  } catch (err) {
    logEvent("ui.suitConditionRankPick.unlock.error", {
      pickId: pick.pickId,
      heroId,
      equipmentType: type,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  router.save();
  resetUi();
  hooks.onPickResolved?.(result.reward);
}

// --- Copy helpers ---------------------------------------------------------

/** "R2 → R3" (rank picks; "not owned" for R0) or "max R3 → R4" (boss-card unlocks). */
function rankPreviewLabel(
  state: CampaignState,
  pick: PendingSuitConditionRankPick,
  heroId: string,
  type: EquipmentType,
): string {
  const p = previewSuitConditionPick(state, pick, heroId, type);
  if (p.kind === "cap") return `max R${p.before} → R${p.after}`;
  return `${p.before === 0 ? "not owned" : `R${p.before}`} → R${p.after}`;
}

function headingFor(pick: PendingSuitConditionRankPick): string {
  // Source ids are namespaced from `chapter2.json` enqueue payloads
  // and from `engine/academyDonation.ts > resolveAcademyDonation`.
  // Unknown sources fall through to a generic title so the modal
  // still renders something readable.
  const src = pick.source;
  if (src === "ch2.entry.died.mind") return "Blood-Soaked Mind Delversuit";
  if (src === "ch2.entry.died.body") return "Blood-Soaked Body Delversuit";
  if (src === "ch2.entry.died.both") return "Blood-Soaked Delversuit";
  if (src.startsWith("academy-donation-")) return "Delving Academy Donation";
  if (src.startsWith("scenario-card-")) return "Scenario Card Reward";
  if (src.startsWith("boss-card-")) return "Boss Card Rank Unlock";
  return "Suit Condition: Rank Bonus";
}

function sublineFor(pick: PendingSuitConditionRankPick): string {
  if (pick.unlockHigherRanks) {
    return "Choose which equipment type gains access to a higher rank.";
  }
  const action = pick.delta === 2 ? "+2 RANK" : "+1 RANK";
  // The "Loadout" framing is deliberate — the user gave clear
  // direction that this is long-term storage for future quests,
  // NOT a per-quest hero-card bump. The subline echoes that so the
  // player doesn't read the type chooser as "which card on the
  // currently-equipped hero gets stronger right now".
  return `Pick an equipment to add ${action} to your Suit Condition Loadout.`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Keep `presentRewards` reachable so callers that import this
// module for `drainSuitConditionPicksViaModal` can chain into the
// reward display without a second import. Re-exported via the
// existing modal entry-point for symmetry with how OpinionRank
// pickers are dispatched from `renderActionModal`.
export { presentRewards };
