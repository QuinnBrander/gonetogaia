/**
 * Level-Up Modal (rulebook p24).
 *
 * Shows the active pending Level-Up draw (head of
 * `state.encounter.pendingLevelUpDraws`). Layout:
 *
 *   +---------------------------------------------------------------+
 *   | Level Up! Mind delver, pick one to gain +1 RANK in:           |
 *   |                                                               |
 *   |  [drawn level card image]                                     |
 *   |                                                               |
 *   |  [Gauntlet R1 -> R2]   [Battery 0 -> R1]   [Harvester R3->R4] |
 *   |  (current rank shown; cap-disabled buttons are R5)            |
 *   |                                                               |
 *   |                                                  [Confirm]    |
 *   +---------------------------------------------------------------+
 *
 * Picking a choice fires `applyLevelUpChoice`, pops the queue, and
 * the next pending draw (if any) immediately replaces the modal
 * contents — so a 2-level-up event walks through 4 draws (2 per
 * delver) one after another. End Turn / phase advance is gated on
 * the queue being empty (see `BoardScreen.ts > canEndTurn` and
 * `ActionResolution.ts > advanceAfterAction`).
 */

import type { Router } from "../main";
import type { CampaignState } from "../state";
import {
  applyLevelUpChoice,
  discardUnplayableLevelUpDraw,
  EQUIPMENT_RANK_CAP,
  getLevelUpCard,
  legalLevelUpTypes,
  peekNextPendingDraw,
} from "../engine/levelUp";
import { logEvent } from "../debug/sessionLog";
import {
  getEquipmentByTypeSuit,
  getHero,
  imageForRank,
} from "../data";
import type { EquipmentType, LevelUpDeckCard } from "../types";
import { PASSIVE_EQUIPMENT_TYPES } from "../types";
import { setModal } from "../uiState";
import { advanceAfterAction } from "./ActionResolution";

/**
 * Render the modal into `host`. Caller (ActionResolution.ts) is
 * responsible for un-hiding `host`. If there is no pending draw,
 * dismisses the modal and returns — caller should re-render.
 */
export function renderLevelUpModal(host: HTMLDivElement, router: Router): void {
  const state = router.state;
  const pending = peekNextPendingDraw(state);
  if (!pending) {
    setModal(null);
    return;
  }

  const hero = getHero(pending.heroId);
  const card = getLevelUpCard(pending.cardNumber);
  const ranks = state.equipmentRanks[pending.heroId] ?? {};

  // Build the legal choice list per card subtype. See `LevelUpDeckCard`
  // jsdoc + `rankDeltaForLevelUpChoice` for the source-of-truth rules.
  //
  //   - BASE: 3 buttons, one per `card.types`, +1 RANK each.
  //   - ULTRA: 2 buttons for the printed types (+2 RANKS, "primary"
  //     row) + up to 7 buttons for any passive equipment (+1 RANK,
  //     "secondary" row). Passive buttons for any type already
  //     present in the printed pair are skipped to avoid duplicating
  //     a +2-and-+1 choice for the same type (the player would always
  //     pick the +2).
  const primaryChoices: ChoiceVm[] = card.types.map((type) =>
    buildChoiceVm(type, card.isUltra ? 2 : 1, hero.suit, ranks, state, pending.heroId),
  );
  const secondaryChoices: ChoiceVm[] = card.isUltra
    ? PASSIVE_EQUIPMENT_TYPES
        .filter((p) => !card.types.includes(p))
        .map((type) => buildChoiceVm(type, 1, hero.suit, ranks, state, pending.heroId))
    : [];

  // Ruling: a card with no legal pick (all allowed types capped /
  // locked at R3) is discarded with no effect.
  const unplayable = legalLevelUpTypes(state, pending.heroId, card).length === 0;

  const remainingAfterThis = state.encounter
    ? state.encounter.pendingLevelUpDraws.length - 1
    : 0;

  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body level-up-modal ${card.isUltra ? "level-up-modal--ultra" : ""}">
      <header class="level-up-header">
        <h3>${card.isUltra ? "Ultra Level Up" : "Level Up"}</h3>
        <p class="small muted">
          <strong class="turn-${hero.suit}">${escapeHtml(hero.suit === "mind" ? "Mind Delver" : "Body Delver")}</strong>
          - ${card.isUltra ? "pick one (+2 RANKS in a listed type, OR +1 RANK in any passive)." : "pick one."}
          ${remainingAfterThis > 0
            ? `<span class="level-up-queue-pill">${remainingAfterThis} more draw${remainingAfterThis === 1 ? "" : "s"} pending</span>`
            : ""}
        </p>
      </header>
      <div class="level-up-stage">
        <figure class="level-up-card">
          <img src="/levelup/${card.image}" alt="Level Up card #${card.cardNumber}" draggable="false" />
        </figure>
        <div class="level-up-choices-wrap">
          ${renderChoiceGroup(card, primaryChoices, "primary")}
          ${renderChoiceGroup(card, secondaryChoices, "secondary")}
          ${unplayable
            ? `<p class="level-up-choices-label small muted">No legal pick: every type on this card is maxed or locked at R3. Discard it with no effect.</p>
               <button class="btn level-up-discard" data-discard>Discard card</button>`
            : ""}
        </div>
      </div>
    </div>
  `;

  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-choice]")) {
    btn.addEventListener("click", () => {
      const type = btn.dataset.choice as EquipmentType;
      onPickChoice(router, type);
    });
  }
  host.querySelector<HTMLButtonElement>("[data-discard]")?.addEventListener("click", () => {
    const cardNumber = discardUnplayableLevelUpDraw(router.state);
    logEvent("levelUp.discardUnplayable", { heroId: pending.heroId, cardNumber });
    router.save();
    advanceAfterAction(router);
  });
}

/** Build display data for a single choice button. Centralised so the
 * Ultra primary/secondary groups + the base 3-pick layout all use
 * the same per-type computation. */
function buildChoiceVm(
  type: EquipmentType,
  printedDelta: 1 | 2,
  suit: ReturnType<typeof getHero>["suit"],
  ranks: Record<string, number | undefined>,
  state: CampaignState,
  heroId: string,
): ChoiceVm {
  const before = ranks[type] ?? 0;
  // Enforce the base-rank cap: R3 is the ceiling until the type is
  // unlocked via a boss-card reveal (stored in unlockedForHigherRanks).
  const unlockedCap = state.unlockedForHigherRanks?.[heroId]?.[type];
  const isUnlocked = unlockedCap != null;
  // Same cap the engine applies (`applyLevelUpChoice`): the unlocked
  // rank on the Suit Condition sheet, else R3.
  const baseRankCap = isUnlocked ? unlockedCap : 3;
  const atCap = before >= EQUIPMENT_RANK_CAP || (isUnlocked && before >= baseRankCap);
  const locked = !atCap && !isUnlocked && before >= 3;
  // Clamp the preview so a R4 + printedDelta=2 lands at R5 (not R6),
  // and a locked R2 + delta=2 can't preview R4 (lands at R3).
  const after = Math.min(baseRankCap, before + printedDelta);
  // The R1 card data carries the printed name + suit; rank-N image
  // is derived. We show R(after) so the player sees the card they'll
  // end up with — including the +2 result for Ultras.
  const equipmentR1 = getEquipmentByTypeSuit(suit, type);
  const previewRank = (atCap || locked) ? before : after;
  const previewImage = imageForRank(suit, type, previewRank);
  return {
    type,
    before,
    after,
    atCap,
    locked,
    name: equipmentR1.name,
    previewImage,
    previewRank,
    printedDelta,
  };
}

/** Render a row of choice buttons. `kind` separates Ultra primary
 * (+2 listed types) from Ultra secondary (+1 any passive); base
 * cards render only `primary`. Empty groups render nothing. */
function renderChoiceGroup(
  card: LevelUpDeckCard,
  choices: readonly ChoiceVm[],
  kind: "primary" | "secondary",
): string {
  if (choices.length === 0) return "";
  const isUltraSecondary = card.isUltra && kind === "secondary";
  const label = isUltraSecondary
    ? `<p class="level-up-choices-label small muted">— OR — +1 RANK in any PASSIVE</p>`
    : card.isUltra && kind === "primary"
      ? `<p class="level-up-choices-label small muted">+2 RANKS in one of the printed types</p>`
      : "";
  return `
    ${label}
    <div class="level-up-choices level-up-choices--${kind}">
      ${choices.map((c) => renderChoiceCard(c)).join("")}
    </div>
  `;
}

interface ChoiceVm {
  type: EquipmentType;
  before: number;
  after: number;
  atCap: boolean;
  /** True when the type is at base rank 3 but NOT unlocked for rank 4+. */
  locked: boolean;
  name: string;
  previewImage: string;
  previewRank: number;
  /** Printed rank delta for this button (1 for base / Ultra-secondary,
   * 2 for Ultra-primary). Drives the +1 / +2 badge + the tooltip
   * wording so Ultra picks read distinctly from base picks. */
  printedDelta: 1 | 2;
}

function renderChoiceCard(c: ChoiceVm): string {
  // Card art shows the equipment + final rank; we layer a +1 / +2
  // badge in the corner for Ultras so the rank-jump intent is
  // immediately obvious without reading the tooltip. Tooltip still
  // spells out the before/after for accessibility.
  const disabled = c.atCap || c.locked;
  const badge = c.printedDelta === 2
    ? `<span class="level-up-choice-badge level-up-choice-badge--ultra">+2</span>`
    : `<span class="level-up-choice-badge">+1</span>`;
  const lockIcon = c.locked ? `<span class="level-up-choice-lock">🔒</span>` : "";
  const tooltip = c.atCap
    ? `${c.name} is already at the rank cap (${EQUIPMENT_RANK_CAP}).`
    : c.locked
      ? `${c.name} is locked at R3 — unlock it via a boss-card rank reveal to reach R4+.`
      : c.before === 0
        ? `Gain ${c.name} (R${c.after}) and add it to your hand.`
        : `Upgrade ${c.name} from R${c.before} to R${c.after}.`;
  return `
    <button class="level-up-choice ${disabled ? "level-up-choice--disabled" : ""} ${c.printedDelta === 2 ? "level-up-choice--ultra" : ""} ${c.locked ? "level-up-choice--locked" : ""}"
            data-choice="${c.type}"
            ${disabled ? "disabled" : ""}
            title="${escapeHtml(tooltip)}">
      <figure class="level-up-choice-card">
        ${badge}
        ${lockIcon}
        <img src="/cards/${c.previewImage}" alt="${escapeHtml(c.name)} R${c.previewRank}" draggable="false" />
      </figure>
    </button>
  `;
}

function onPickChoice(router: Router, type: EquipmentType): void {
  const r = applyLevelUpChoice(router.state, type);
  if (!r.ok) {
    console.warn("applyLevelUpChoice rejected:", r.reason);
    return;
  }
  router.save();
  // Always route through `advanceAfterAction` so the post-action
  // prompt queue gets the right precedence:
  //
  //   1. Pending element-pick prompts FIRST. `applyLevelUpChoice` may
  //      have just enqueued one (Elemental OS first-time gain) — per
  //      design decision 2026-05-04 the element pick fires INSIDE the
  //      Level-Up flow, BEFORE the next pending Level-Up draw.
  //   2. Next pending Level-Up draw (multi-level-up / both-delvers).
  //      The advance gate re-opens this same modal against the new
  //      head — no special-case early-return needed here.
  //   3. Soulshift bonus-swing roll (only relevant when level-ups
  //      kicked off mid-attack-session).
  //   4. End-turn auto-advance.
  advanceAfterAction(router);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- BoardScreen integration helpers -------------------------------------

/**
 * True iff there is at least one pending Level-Up draw. Used by
 * `BoardScreen` to gate End Turn (player must resolve all draws
 * before ending their turn) and by `ActionResolution.advanceAfterAction`
 * to decide whether to open the LevelUpModal after an action's
 * session has finalized.
 */
export function hasPendingLevelUpDraws(state: CampaignState): boolean {
  return peekNextPendingDraw(state) !== null;
}
