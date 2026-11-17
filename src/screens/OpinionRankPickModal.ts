/**
 * Opinion-Card Rank Pick modal (rulebook p7 — Xavier Ally /
 * Confidant / Detractor).
 *
 * Surfaces the head of `state.encounter.pendingOpinionRankPicks`
 * as a two-step picker:
 *
 *   1. (Optional) Pick a delver. Skipped for Confidant picks
 *      which have a pinned `heroId`. Shown for Ally (+1) and
 *      Detractor (-1) picks which are `heroId: null`.
 *   2. Pick an equipment slot to bump. The grid is filtered by
 *      `engine/opinionGrants.ts > eligibleEquipmentTypesForPick`:
 *      positive bumps allow any slot below the rank cap;
 *      negative bumps require an owned slot (effective rank
 *      >= 1).
 *
 * Confirming applies `applyOpinionRankPick`, which pops the
 * queue. The dispatch loop in `renderActionModal` re-opens the
 * modal against the next pending entry; when the queue empties,
 * `renderActionModal` clears the modal and routes back to
 * BoardScreen / DelverSpawnPick (whichever was hosting it).
 *
 * Layout:
 *
 *   +----------------------------------------------------------+
 *   | Xavier's Ally favor                                      |
 *   | Pick a delver to gain +1 RANK in one of their slots.     |
 *   |                                                          |
 *   |  [Mind delver] [Body delver]   <- skipped for Confidant  |
 *   |                                                          |
 *   |  [Gauntlet R3->R4] [Battery R0->R1] [...]                |
 *   |                                                          |
 *   |  N more pick{s} pending after this                       |
 *   +----------------------------------------------------------+
 *
 * No cancel button — picks are mandatory. The Start Wave / End
 * Turn gates in DelverSpawnPick / BoardScreen keep the player
 * from progressing past the queue.
 */

import type { Router } from "../main";
import {
  applyOpinionRankPick,
  eligibleEquipmentTypesForPick,
  peekNextOpinionRankPick,
} from "../engine/opinionGrants";
import {
  getEffectiveEquipmentRank,
  type CampaignState,
} from "../state";
import { getEquipmentByTypeSuit, getHero, imageForRank } from "../data";
import {
  ALL_EQUIPMENT_TYPES,
  EQUIPMENT_RANK_CAP,
  type EquipmentType,
} from "../types";
import { setModal } from "../uiState";

/**
 * Render the modal into `host`. If there's no pending pick,
 * dismisses the modal (caller re-renders the underlying screen,
 * which will route past the now-cleared queue gate).
 */
export function renderOpinionRankPickModal(
  host: HTMLDivElement,
  router: Router,
): void {
  const state = router.state;
  const pick = peekNextOpinionRankPick(state);
  if (!pick) {
    setModal(null);
    return;
  }

  // Module-local "delver selection" between step 1 and step 2.
  // For pinned picks (Confidant) we skip step 1 entirely by
  // pre-selecting the pinned hero. Cleared on every fresh modal
  // open via the `pickId` cursor below.
  if (selectedHeroForPickId !== pick.pickId) {
    selectedHeroForPickId = pick.pickId;
    selectedHeroId = pick.heroId; // null until the player picks
  }

  const heroIds = Object.keys(state.loadouts);
  const remainingAfterThis = (state.encounter?.pendingOpinionRankPicks.length ?? 1) - 1;

  // Header copy keyed off pick source + delta — we don't reach
  // for the catalog image here because the picker is a UTILITY
  // surface (not a "look at the pretty card" moment); the card
  // itself is visible in the Campaign Sheet whenever the player
  // wants to read it.
  const heading = headingFor(pick.source);
  const deltaCopy = pick.delta > 0
    ? `Pick a slot to gain +1 RANK.`
    : `Pick a slot to lose -1 RANK.`;

  // Step 1: delver picker (skipped when pinned).
  const heroPickerHtml = selectedHeroId == null
    ? renderHeroPicker(state, pick.delta, heroIds)
    : renderHeroPicked(state, selectedHeroId);

  // Step 2: equipment-type grid (only shown once a hero is locked in).
  const typeGridHtml = selectedHeroId != null
    ? renderTypeGrid(state, pick, selectedHeroId)
    : "";

  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body opinion-rank-modal">
      <header class="opinion-rank-modal-header">
        <h3>${escapeHtml(heading)}</h3>
        <p class="small muted">${escapeHtml(deltaCopy)}</p>
        ${remainingAfterThis > 0
          ? `<p class="small muted opinion-rank-modal-queue">${remainingAfterThis} more pick${remainingAfterThis === 1 ? "" : "s"} pending after this.</p>`
          : ""}
      </header>
      <div class="opinion-rank-modal-body">
        ${heroPickerHtml}
        ${typeGridHtml}
      </div>
    </div>
  `;

  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-opinion-pick-hero]")) {
    btn.addEventListener("click", () => {
      selectedHeroId = btn.dataset.opinionPickHero!;
      router.refresh();
    });
  }
  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-opinion-pick-type]")) {
    btn.addEventListener("click", () => {
      const type = btn.dataset.opinionPickType as EquipmentType;
      const heroId = selectedHeroId;
      if (!heroId) return;
      try {
        applyOpinionRankPick(state, pick.pickId, heroId, type);
      } catch (err) {
        // Defensive — the type grid only renders eligible types and
        // hero ids are validated above, so this should never fire
        // in practice. Log + bail so a real bug doesn't get
        // silently swallowed.
        console.warn("applyOpinionRankPick rejected:", err);
        return;
      }
      router.save();
      // The Modal dispatch (renderActionModal) re-enters this
      // module on the next refresh; renderOpinionRankPickModal
      // peeks the new queue head and either renders the next pick
      // or self-dismisses via setModal(null).
      selectedHeroForPickId = null;
      selectedHeroId = null;
      router.refresh();
    });
  }
}

// --- Module-local UI state ------------------------------------------------

// "Which delver is the player currently aiming this pick at?".
// Lives at module scope so the Step 1 → Step 2 transition
// survives a `router.refresh()` between clicks. Re-seeded
// whenever a new pickId becomes head of the queue, so a follow-on
// pick re-prompts the player from scratch instead of inheriting
// the previous selection.
let selectedHeroForPickId: string | null = null;
let selectedHeroId: string | null = null;

// --- Render helpers -------------------------------------------------------

function headingFor(source: string): string {
  switch (source) {
    case "xavier-ally":      return "Xavier's favor (Ally): +1 RANK";
    case "xavier-confidant": return "Xavier's favor (Confidant): +1 RANK";
    case "xavier-detractor": return "Xavier's curse (Detractor): -1 RANK";
    case "xavier-nemesis":   return "Xavier's curse (Nemesis): -1 RANK";
    default: return `${source}: ${"\u00B1"}1 RANK`;
  }
}

function renderHeroPicker(state: CampaignState, delta: 1 | -1, heroIds: string[]): string {
  const buttons = heroIds.map((heroId) => {
    const hero = getHero(heroId);
    // Surface a quick "no eligible slots" hint for negative picks
    // on a delver who has no owned equipment — the player would
    // otherwise click in, see an empty grid, and have to back out.
    const eligible = eligibleEquipmentTypesForPick(state, { delta } as never, heroId, ALL_EQUIPMENT_TYPES);
    const noSlots = eligible.length === 0;
    return `
      <button class="opinion-rank-hero-btn turn-${hero.suit}${noSlots ? " opinion-rank-hero-btn--disabled" : ""}"
              data-opinion-pick-hero="${escapeHtml(heroId)}"
              ${noSlots ? "disabled" : ""}
              title="${escapeHtml(noSlots ? "No eligible slots on this delver." : `Pick ${hero.suit} delver`)}">
        <span class="opinion-rank-hero-suit">${hero.suit === "mind" ? "Mind" : "Body"}</span>
        <span class="opinion-rank-hero-name">delver</span>
      </button>
    `;
  }).join("");
  return `
    <section class="opinion-rank-step">
      <h4 class="opinion-rank-step-title">Step 1: pick a delver</h4>
      <div class="opinion-rank-hero-row">${buttons}</div>
    </section>
  `;
}

function renderHeroPicked(state: CampaignState, heroId: string): string {
  const hero = getHero(heroId);
  return `
    <section class="opinion-rank-step opinion-rank-step--picked">
      <h4 class="opinion-rank-step-title">Step 1: <span class="turn-${hero.suit}">${escapeHtml(hero.suit === "mind" ? "Mind delver" : "Body delver")}</span></h4>
    </section>
  `;
}

function renderTypeGrid(state: CampaignState, pick: { delta: 1 | -1; source: string; pickId: string; heroId: string | null }, heroId: string): string {
  const eligible = eligibleEquipmentTypesForPick(state, pick as never, heroId, ALL_EQUIPMENT_TYPES);
  if (eligible.length === 0) {
    return `
      <section class="opinion-rank-step">
        <h4 class="opinion-rank-step-title">Step 2: pick a slot</h4>
        <p class="small muted">No eligible slots for this delver. Pick a different delver above.</p>
      </section>
    `;
  }
  const hero = getHero(heroId);
  const cards = eligible.map((type) => {
    const before = getEffectiveEquipmentRank(state, heroId, type);
    const after = pick.delta > 0
      ? Math.min(before + 1, EQUIPMENT_RANK_CAP)
      : Math.max(before - 1, 0);
    // The R0 -> R1 (gain a new card) case uses the R1 art; the
    // R1 -> R0 (lose the card) case uses the current R1 art with
    // a "fading" badge so the player sees what they're about to
    // give up. Everything else previews the AFTER art so the
    // player sees the upgrade they're choosing.
    const equipmentR1 = getEquipmentByTypeSuit(hero.suit, type);
    const previewRank = pick.delta > 0
      ? (after > 0 ? after : 1)
      : (before > 0 ? before : 1);
    const previewImage = imageForRank(hero.suit, type, previewRank);
    const beforeLabel = before === 0 ? "(not owned)" : `R${before}`;
    const afterLabel = after === 0 ? "(lost)" : `R${after}`;
    return `
      <button class="opinion-rank-type-btn"
              data-opinion-pick-type="${escapeHtml(type)}"
              title="${escapeHtml(`${equipmentR1.name}: ${beforeLabel} -> ${afterLabel}`)}">
        <figure class="opinion-rank-type-card">
          <img src="/cards/${escapeHtml(previewImage)}" alt="${escapeHtml(equipmentR1.name)} R${previewRank}" draggable="false" />
        </figure>
        <span class="opinion-rank-type-rank ${pick.delta > 0 ? "opinion-rank-type-rank--gain" : "opinion-rank-type-rank--loss"}">${escapeHtml(beforeLabel)} &rarr; ${escapeHtml(afterLabel)}</span>
      </button>
    `;
  }).join("");
  return `
    <section class="opinion-rank-step">
      <h4 class="opinion-rank-step-title">Step 2: pick a slot</h4>
      <div class="opinion-rank-type-grid">${cards}</div>
    </section>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
