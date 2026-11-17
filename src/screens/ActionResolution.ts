/**
 * Action resolution UI (DESIGN.md §5.2 — Slice 4c).
 *
 * Owns:
 *   - the action-menu modal that opens when the active delver clicks
 *     the just-placed slot,
 *   - the die-roll modal (Hammer) for `die-roll-fixed` weapons,
 *   - the delver-choice modal for `gain-token` / `gain-element` slot
 *     abilities,
 *   - the target overlay painted on the board when an ability is
 *     "armed",
 *   - the shared counter-roll modal (ONE prompt covering every
 *     damaged enemy from the just-finished attack — DESIGN.md §5.4),
 *   - the Cancel-armed button shown next to the turn indicator.
 *
 * Lives outside `BoardScreen.ts` to keep that file focused on layout.
 * BoardScreen calls `renderActionTargets` (paints the on-board target
 * overlay) and `renderActionModal` (paints the current modal at the
 * bottom of the board frame) at the end of each render pass.
 *
 * State lives on `uiState` (`armedAbility`, `attackSession`, `modal`)
 * so a router refresh re-renders cleanly.
 *
 * Note: there used to be an "Action resolved" resolution-log modal
 * that summarized each attack (kills, counter result, level-ups).
 * It was removed once the dedicated counter-roll modal showed the
 * counter outcome inline AND the level-up flow got its own modal —
 * the resolution-log modal then carried no info the player couldn't
 * already see on the board / sheet, so it was just an extra click.
 */

import { isRelayedPromptOwner, onlineIsActorNow } from "../net/onlineController";
import { ritualOptions, sacrificeToRitual } from "../engine/questAbilities";
import type { Router } from "../main";
import type { CampaignState } from "../state";
import {
  type ArmedAbility,
  type Modal,
  clearActionState,
  getArmedAbility,
  getAttackSession,
  getModal,
  getPeekedDelverId,
  pushPartingShotLog,
  setArmedAbility,
  setAttackSession,
  setLastAutoRefresh,
  setModal,
} from "../uiState";
import { resolvePartingShot } from "../engine/wave";
import {
  applyCounterDamageWithShieldChoices,
  computeCounterTargetTiles,
  counterAttackOutcomeForRoll,
  counterBlockCandidates,
  counterOffsetsFor,
  findShieldOpportunities,
  finalizeAttackSession,
  hasAllClaw,
  previewCounterHitsByDelver,
  resolveAllDamage,
  resolveSharedCounter,
  sessionWeaponCounterBlockAmount,
  sessionWeaponCounterBlockCount,
  weaponCounterBlockMap,
  type AttackSession,
  type CounterBlockCandidate,
  type ShieldChoice,
  type ShieldOpportunity,
  type WeaponCounterBlockChoice,
  computeWeaponHitTiles,
  blockCounterattack,
} from "../engine/combat";
import { commitEndTurnAfterUndo, commitManualEndTurn, maybeAutoEndTurn } from "./turnFlow";
import { movementUndoBlockedReason } from "../engine/movement";
import { hasPendingLevelUpDraws, renderLevelUpModal } from "./LevelUpModal";
import { renderOpinionRankPickModal } from "./OpinionRankPickModal";
import { renderScenarioCardModal } from "./ScenarioCardModal";
import { renderFriendlyEncounterModal } from "./FriendlyEncounterModal";
import { renderRulesViewerModal } from "./RulesViewerModal";
import { renderSuitConditionRankPickModal } from "./SuitConditionRankPickModal";
import { renderScenarioDelverPickModal } from "./ScenarioDelverPickModal";
import { snapshotKillSites, playKillAnimations } from "./killAnimations";
import { hasPendingOpinionRankPicks } from "../engine/opinionGrants";
import {
  spendApDoubleMovement,
  spendApRefreshWeapon,
  spendApRefreshAllWeapons,
  undoWeaponPlacement,
  useSlotAbility,
  useWeaponAbility,
  type WeaponAbilityParams,
  type WeaponSpendOption,
} from "../engine/turn";
import { type SlotAbilityParams } from "../engine/slotAbilities";
import {
  ELEMENT_CAP_PER_DELVER,
  applyXpRoll,
  hasPendingXpRolls,
  peekNextPendingXpRoll,
} from "../engine/kills";
import {
  getDelverBoard,
  getEnemy,
  getEquipment,
  getEquipmentByTypeSuitRank,
  getHero,
  HEROES,
  QUEST1,
  CONSUMABLE_TOKEN_DISPLAY,
  consumableIconInnerHtml,
} from "../data";
import { getEffectiveEquipmentRanks, getPlayedWeaponCard } from "../state";
import { ADJACENT_OFFSETS_8WAY } from "../rules";
import { cellCenterPct, cellSizePct } from "../board/tideBoard";
import {
  consumeFreshRoll,
  isResultBlocked,
  markFreshRoll,
  playDieRollCycle,
} from "../ui/dieRollAnimation";
import { getDelverAt, getDelversAt, getEnemyAt, getEnemyInstance } from "../engine/encounter";
import {
  adjacentEnemyTargets,
  canActivateBootsOngoing,
  legalMoveDestinationsForEnemy,
  moveAdjacentEnemy,
  rotateAdjacentEnemy,
  bootsModes,
  bootsOngoingCost,
  type RotateAmount,
} from "../engine/boots";
import {
  adjacentLiveEnemiesForRepeat,
  attackSessionTriggersSoulshiftRoll,
  classifySoulshiftRoll,
} from "../engine/soulshift";
import {
  attackSessionTriggersBeamRepeat,
  clearBeamRepeats,
  repeatAttackCountForCard,
} from "../engine/beamRepeat";
import {
  applyCreaturePartChoice,
  availableCreaturePartDropsForHero,
  hasPendingCreaturePartChoices,
  peekNextPendingCreaturePartChoice,
  skipCreaturePartChoice,
} from "../engine/creatureParts";
import {
  adjacentLiveEnemiesMatchingFilter,
  availableElementKinds,
  classifyMaceModes,
  getTargetFilterOrSpendElementEffect,
} from "../engine/mace";
import {
  applyElementChoice,
  hasPendingElementChoices,
  peekNextPendingElementChoice,
} from "../engine/os";
import {
  applyEquipmentRoll,
  canSpendPreventCounter,
  canSpendReroll,
  equipmentRollTableForCard,
  hasPendingEquipmentRolls,
  outcomeForRoll,
  peekNextPendingEquipmentRoll,
  spendToken,
  tokenAvailable,
  typedDoubleDamageKindFor,
  type EquipmentRollOutcome,
} from "../engine/tokens";
import {
  canBeginWitnessAction,
  legalWitnessStepDestinations,
  stepWitness,
  WITNESS_ACTION_STEP_CAP,
  witnessPickupsHasAny,
  type WitnessStepPickups,
} from "../engine/witness";
import type { ConsumableTokenKind } from "../state";
import type { Element, EquipmentCard, EquipmentType, SlotAbility, WeaponRange } from "../types";
import { logEvent, snapElements, snapHeroAp, snapModal, snapSlots, snapTurn } from "../debug/sessionLog";
import { flyTilePickupsToWallet } from "../ui/flyToWallet";

const ALL_ELEMENTS_DISPLAY_ORDER: readonly Element[] = [
  "earth",
  "wind",
  "fire",
  "water",
  "void",
  "radiance",
] as const;

const BOARD = QUEST1.waves[0]!.spawn.boardSize;

// --- Public render entry points -----------------------------------------

/**
 * Paints the target overlay for the currently-armed ability. Renders
 * nothing when no ability is armed (or when a modal is open that
 * blocks board interaction).
 */
export function renderActionTargets(
  layer: HTMLDivElement,
  router: Router,
): void {
  layer.innerHTML = "";
  const armed = getArmedAbility();
  const modal = getModal();

  // Special case: die-roll modal in its RESULT stage. Even though a
  // modal is open we want the player to see WHICH tiles their roll
  // will hit before they Confirm. The sticky `choice` field on the
  // modal drives the preview — `"keep"` (default) shows tiles for
  // the rolled value; `"flip"` shows tiles for the flipped value
  // (after paying the reroll cost). The two options are exclusive.
  //
  // Gated on the die-roll cycle: while the cycling animation is
  // still spinning the die, we DON'T paint the preview tiles —
  // they'd give the result away before the player sees the die
  // settle. The cycle's onDone fires `router.refresh()` which
  // re-runs this with the gate cleared.
  if (modal && modal.kind === "die-roll" && modal.rolled !== undefined) {
    if (isResultBlocked("die-roll")) return;
    const choice = modal.choice ?? "keep";
    const previewDie = choice === "flip" ? flipDie(modal.rolled) : modal.rolled;
    const tiles = computeDieRollPreviewTiles(router.state, modal.cardId, previewDie);
    paintPreviewTargets(layer, tiles, choice === "flip");
    return;
  }

  // Special case: counter-roll modal. Pre-roll: highlight every enemy
  // that took damage from the just-resolved attack so the player can
  // see "these are the bodies about to swing back". Post-roll: ALSO
  // paint the strike-pattern tiles (the offset tiles each damaged
  // enemy actually swung at for the rolled outcome) so the player
  // can read which tiles took the counter — including tiles a delver
  // happened to be off of. The dying enemies are still on the board
  // (kill side-effects are deferred to session finalize).
  if (modal && modal.kind === "counter-roll") {
    const session = getAttackSession();
    const phase = session?.sharedCounter ?? null;
    if (phase) {
      paintCounterSourceHighlights(layer, phase.damagedEnemies);
      // Post-roll: paint the strike pattern (offset tiles each
      // damaged enemy actually swung at for the rolled outcome) so
      // the player can read which tiles the counter landed on. The
      // engine's `phase.resolved` doesn't flip until Confirm, so we
      // compute strike tiles eagerly off the rolled outcome.
      //
      // Tiles already occupied by an enemy are filtered out: only
      // delvers can be hit by a counter, so highlighting an
      // enemy-occupied tile would just be visual noise (and would
      // also cover up the source-ring on the dying enemy itself
      // if its own pattern happened to wrap onto it). Empty tiles
      // and delver-occupied tiles both stay highlighted.
      // Gated on the counter-roll cycle: while the cycling
      // animation is still spinning, we keep the SOURCE highlights
      // (those don't depend on the roll result) but suppress the
      // STRIKE pattern — painting it before the die settles would
      // give the result away. The cycle's onDone refreshes us.
      if (modal.rolled !== undefined && !isResultBlocked("counter-roll")) {
        const outcome = counterAttackOutcomeForRoll(modal.rolled);
        const enc = router.state.encounter;
        const strikeTiles = computeCounterTargetTiles(
          phase.damagedEnemies,
          outcome,
          BOARD,
        ).filter((t) => !enc || getEnemyAt(enc, t.x, t.y) == null);
        paintCounterStrikeHighlights(layer, strikeTiles);
      }
    }
    return;
  }

  // Boots ONGOING auto-paint (DESIGN.md §5.5, 2026-05-18 redesign).
  // When nothing is armed and no modal is up, but the active delver
  // can legally fire Boots ONGOING right now (owns Boots, has \u22652
  // movement, weapon placed, etc.) and there's at least one 8-way
  // adjacent live enemy, paint those enemies as "boots-auto" target
  // tiles. Tapping one skips the old hand-side arm step and goes
  // straight to Phase B:
  //   - Body / Strider Boots  -> sets targetEnemyId, refresh, the
  //     standard `boots-move-enemy` overlay paints destination tiles.
  //   - Mind / Slip Strider   -> sets targetEnemyId AND opens the
  //     `boots-rotate-direction` modal so the player picks CW vs CCW.
  // Visually distinct from the armed `.board-target` (cyan-tinted
  // matching the movement-track cube colour) so players read it as
  // "Boots is offered here" rather than "ability is targeting".
  if (!armed && !modal) {
    paintBootsAutoTargetsIfAvailable(layer, router);
  }

  if (!armed) return;
  // While any other modal is open (level-up, AP-spend, etc.) the
  // board overlay is hidden — the user is mid-prompt and shouldn't be
  // picking new targets.
  if (modal) return;

  const targets = computeArmedTargets(router.state, armed);
  for (const tile of targets) {
    const { left, top } = cellCenterPct(tile.x, tile.y);
    const { wPct, hPct } = cellSizePct(tile.x, tile.y);
    const el = document.createElement("button");
    const isTridentTarget = armed.kind === "trident-pre-move-target";
    const isTridentDest   = armed.kind === "trident-pre-move-dest";
    const isChosen = armed.kind === "weapon" && (armed.chosenTargets ?? []).some((t) => t.x === tile.x && t.y === tile.y);
    el.className = [
      "board-target",
      isTridentTarget ? "board-target--trident-enemy" : "",
      isTridentDest   ? "board-target--trident-dest"  : "",
      isChosen        ? "board-target--chosen"        : "",
    ].filter(Boolean).join(" ");
    el.dataset.x = String(tile.x);
    el.dataset.y = String(tile.y);
    el.style.left   = `${left}%`;
    el.style.top    = `${top}%`;
    el.style.width  = `${wPct}%`;
    el.style.height = `${hPct}%`;
    el.title = `Target (${tile.x}, ${tile.y})`;
    el.addEventListener("click", () => onTargetClick(router, tile.x, tile.y));
    layer.appendChild(el);
  }
}

/**
 * Paint Boots ONGOING auto-targets on the board for the active
 * delver. Pure presentation: assumes the caller has already verified
 * that no ability is armed and no modal is open. No-op when:
 *   - Boots ONGOING isn't legally available (see
 *     `canActivateBootsOngoing` for the full gate).
 *   - No 8-way adjacent live enemy exists.
 *
 * Click handler arms Boots with the picked enemy id AND, for the
 * Mind / Slip Strider variant, opens the rotate-direction modal in
 * the same tick. Body / Strider Boots stays armed (Phase B) so the
 * standard armed-overlay re-render paints destination tiles.
 */
function paintBootsAutoTargetsIfAvailable(
  layer: HTMLDivElement,
  router: Router,
): void {
  const state = router.state;
  const heroId = state.currentDelverId;
  if (!canActivateBootsOngoing(state, heroId).ok) return;
  const enemies = adjacentEnemyTargets(state, heroId);
  if (enemies.length === 0) return;
  const suit = getHero(heroId).suit;
  // Capability-driven since 2026-07-22 (Cyclone Boots grants BOTH
  // modes to either suit and drops the cost to 1) — standard Boots
  // still resolve to their suit's single printed mode.
  const modes = bootsModes(state, heroId);
  const cost = bootsOngoingCost(state, heroId);
  for (const enemy of enemies) {
    const { left, top } = cellCenterPct(enemy.x, enemy.y);
    const { wPct, hPct } = cellSizePct(enemy.x, enemy.y);
    const el = document.createElement("button");
    el.className = "board-target board-target--boots-auto";
    el.dataset.x = String(enemy.x);
    el.dataset.y = String(enemy.y);
    el.style.left   = `${left}%`;
    el.style.top    = `${top}%`;
    el.style.width  = `${wPct}%`;
    el.style.height = `${hPct}%`;
    el.title = modes.canMove && modes.canRotate
      ? `Cyclone Boots: move or rotate this enemy (costs ${cost} movement)`
      : modes.canMove
        ? `Strider Boots: move this enemy (costs ${cost} movement)`
        : `Slip Strider Boots: rotate this enemy (costs ${cost} movement)`;
    el.addEventListener("click", () => {
      const enemyId = enemy.instanceId;
      logEvent("click.boots-auto-target", { heroId, enemyId, suit, modes });
      if (modes.canMove && !modes.canRotate) {
        setArmedAbility({ kind: "boots-move-enemy", targetEnemyId: enemyId });
      } else {
        // Rotate-only OR both: the rotate-direction modal is the
        // hub — for Cyclone it also offers "Move instead", which
        // arms the standard move flow.
        setArmedAbility({ kind: "boots-rotate-enemy", targetEnemyId: enemyId });
        setModal({ kind: "boots-rotate-direction", targetEnemyId: enemyId });
      }
      router.refresh();
    });
    layer.appendChild(el);
  }
}

/**
 * Paint die-roll preview tiles (non-interactive). Each tile reuses the
 * `.board-target` look so the player learns "orange box = where damage
 * lands". The `--preview` modifier strips the click affordance and the
 * `--alt` modifier (set when previewing the flipped die on hover)
 * tints the preview a touch differently so the player can tell at a
 * glance "this is the alternate, not the committed one".
 */
function paintPreviewTargets(
  layer: HTMLDivElement,
  tiles: { x: number; y: number }[],
  isAlternate: boolean,
): void {
  for (const tile of tiles) {
    const { left, top } = cellCenterPct(tile.x, tile.y);
    const { wPct, hPct } = cellSizePct(tile.x, tile.y);
    const el = document.createElement("div");
    el.className = `board-target board-target--preview${isAlternate ? " board-target--preview-alt" : ""}`;
    el.style.left   = `${left}%`;
    el.style.top    = `${top}%`;
    el.style.width  = `${wPct}%`;
    el.style.height = `${hPct}%`;
    layer.appendChild(el);
  }
}

/**
 * Paint a non-interactive highlight ring around every enemy currently
 * counter-attacking. Used while the shared counter-roll modal is open
 * so the player can identify which bodies are about to swing back.
 * Visually distinct from `.board-target--preview` (which is reserved
 * for the die-roll forecast) — uses a red ring with its own pulse.
 */
function paintCounterSourceHighlights(
  layer: HTMLDivElement,
  damaged: { x: number; y: number }[],
): void {
  for (const tile of damaged) {
    const { left, top } = cellCenterPct(tile.x, tile.y);
    const { wPct, hPct } = cellSizePct(tile.x, tile.y);
    const el = document.createElement("div");
    el.className = "board-target board-target--counter-source";
    el.style.left   = `${left}%`;
    el.style.top    = `${top}%`;
    el.style.width  = `${wPct}%`;
    el.style.height = `${hPct}%`;
    layer.appendChild(el);
  }
}

/**
 * Paint a non-interactive highlight on every tile the just-rolled
 * counter-attack swung at (the offset tiles of every damaged enemy
 * for the rolled outcome's pattern). Distinct from the source ring
 * — uses a softer red fill so the source ring still reads on top
 * when an enemy's pattern overlaps its own tile.
 */
function paintCounterStrikeHighlights(
  layer: HTMLDivElement,
  tiles: { x: number; y: number }[],
): void {
  for (const tile of tiles) {
    const { left, top } = cellCenterPct(tile.x, tile.y);
    const { wPct, hPct } = cellSizePct(tile.x, tile.y);
    const el = document.createElement("div");
    el.className = "board-target board-target--counter-strike";
    el.style.left   = `${left}%`;
    el.style.top    = `${top}%`;
    el.style.width  = `${wPct}%`;
    el.style.height = `${hPct}%`;
    layer.appendChild(el);
  }
}

/**
 * Compute the tile coordinates a die-roll-fixed weapon would hit if
 * the rolled value were `dieValue`. Returns the in-board tiles for
 * the matching `rolls[]` entry; off-board offsets are clipped out
 * (mirrors `computeDieRollFixed` in engine/combat).
 */
function computeDieRollPreviewTiles(
  state: CampaignState,
  cardId: string,
  dieValue: number,
): { x: number; y: number }[] {
  const enc = state.encounter;
  if (!enc) return [];
  const me = getDelverAt(enc, state.currentDelverId);
  if (!me) return [];
  const card = getEquipment(cardId);
  const range = card.range;
  if (!range || range.kind !== "die-roll-fixed") return [];
  const entry = range.rolls.find((r) => dieValue >= r.min && dieValue <= r.max);
  if (!entry) return [];
  const out: { x: number; y: number }[] = [];
  for (const off of entry.tiles) {
    const x = me.x + off.dx;
    const y = me.y + off.dy;
    if (isInBoard(x, y)) out.push({ x, y });
  }
  return out;
}

/**
 * Compute the tile coordinates a fixed-pattern weapon (Trident or
 * Shockwave) would hit from the active delver's current position.
 * Off-board offsets are silently dropped \u2014 mirrors
 * `computeFixedPattern` in `engine/combat.ts`. Self-targeting
 * `(0, 0)` offsets are also dropped (no card prints them today,
 * but the gate keeps parity with the resolver).
 *
 * Used by the action-menu hover preview to telegraph "these are the
 * tiles your swing will hit" before the player commits. Mouse-only
 * affordance \u2014 touch users tap-to-execute and never see the
 * preview, which matches the "no targeting picker" model for fixed-
 * pattern weapons.
 */
function computeFixedPatternPreviewTiles(
  state: CampaignState,
  cardId: string,
): { x: number; y: number }[] {
  const enc = state.encounter;
  if (!enc) return [];
  const me = getDelverAt(enc, state.currentDelverId);
  if (!me) return [];
  const card = getEquipment(cardId);
  const range = card.range;
  if (!range || range.kind !== "fixed-pattern") return [];
  const out: { x: number; y: number }[] = [];
  for (const off of range.tiles) {
    if (off.dx === 0 && off.dy === 0) continue;
    const x = me.x + off.dx;
    const y = me.y + off.dy;
    if (isInBoard(x, y)) out.push({ x, y });
  }
  return out;
}

/**
 * Render the Cancel-armed pill in the turn indicator strip. Returns
 * the HTML snippet (or empty string) so `BoardScreen` can string-
 * concat it into the topbar template.
 */
export function renderCancelArmedBadge(): string {
  return getArmedAbility() != null ? `<span class="turn-pill turn-pill--armed">Armed</span>` : "";
}

/**
 * Wire any inline buttons rendered inside `wrap` (e.g. a "Cancel
 * ability" button). Call AFTER innerHTML is set.
 */
export function wireActionTopbarButtons(wrap: HTMLElement, router: Router): void {
  wrap.querySelector<HTMLButtonElement>("[data-action=fire-chosen-targets]")?.addEventListener("click", () => {
    const armed = getArmedAbility();
    if (!armed || armed.kind !== "weapon" || armed.rangeKind !== "choose-targets") return;
    const targets = armed.chosenTargets ?? [];
    if (targets.length === 0) return;
    promptDoubleDamageOrFire(router, armed.slotIdx, armed.cardId, { kind: "choose-targets", targets }, undefined);
  });
  const cancel = wrap.querySelector<HTMLButtonElement>("[data-action=cancel-armed]");
  if (cancel) {
    cancel.addEventListener("click", () => {
      const armed = getArmedAbility();
      // Beam-repeat-target: cancelling the picker re-opens the
      // explicit Fire/Skip prompt so the player can't accidentally
      // strand remaining repeats. (The picker can be re-armed by
      // hitting Fire Again; Skip forfeits the rest.) Without this
      // re-open, the beam repeats would silently dangle forever
      // because nothing else triggers `advanceAfterAction` until
      // another action fires.
      if (armed && armed.kind === "beam-repeat-target") {
        const heroId = router.state.currentDelverId;
        const remaining = router.state.encounter?.beamRepeatsRemaining[heroId] ?? 0;
        setArmedAbility(null);
        if (remaining > 0) {
          setModal({
            kind: "beam-repeat-prompt",
            slotIdx: armed.slotIdx,
            cardId: armed.cardId,
            remaining,
          });
        }
        router.refresh();
        return;
      }
      setArmedAbility(null);
      router.refresh();
    });
  }
}

/**
 * Renders the "ability armed" status as a self-contained banner that
 * the BoardScreen positions as an overlay BELOW the topbar (see
 * `.armed-instruction-banner` in styles.css). Pre-2026-05-09 this
 * lived inside `.board-turn-indicator` as inline text + button, but
 * the long instruction strings ("Pick an enemy adjacent to the OTHER
 * delver to start the chain.") wrapped the topbar onto a second
 * line, growing the topbar's height and shrinking the board area
 * below. Same fix pattern as `.auto-refresh-banner`: pull conditional
 * topbar content out of the layout flow into an absolute-positioned
 * overlay, so its appear/disappear cycle never resizes the board.
 *
 * Returns empty string when no ability is armed (banner hidden).
 */
export function renderArmedInstruction(state: CampaignState): string {
  const armed = getArmedAbility();
  if (!armed) return "";
  const text = describeArmed(state, armed);
  const chosen = armed.kind === "weapon" && armed.rangeKind === "choose-targets" ? (armed.chosenTargets?.length ?? 0) : null;
  return `
    <div class="armed-instruction-banner" role="status" aria-live="polite">
      <span class="armed-instruction-banner-pill">ARMED</span>
      <span class="armed-instruction-banner-text">${escapeHtml(text)}</span>
      ${chosen !== null ? `<button class="btn btn--small btn--primary" data-action="fire-chosen-targets" ${chosen === 0 ? "disabled" : ""}>Fire (${chosen})</button>` : ""}
      <button class="btn btn--small btn--ghost armed-instruction-banner-cancel" data-action="cancel-armed">Cancel ability</button>
    </div>
  `;
}

/**
 * Render the currently-open modal into `host`. If no modal is open,
 * `host` is emptied and hidden.
 */
// Tracks the most-recently-rendered modal so we only emit a
// `modal.open` / `modal.close` log row when the modal kind actually
// CHANGES (renderActionModal runs on every router.refresh() — which
// is dozens of times per click — and we don't want the log spammed
// with redundant render rows).
let lastRenderedModalKind: string | null = null;

export function renderActionModal(host: HTMLDivElement, router: Router): void {
  host.innerHTML = "";
  const modal = getModal();
  if (!modal) {
    if (lastRenderedModalKind !== null) {
      logEvent("modal.close", { kind: lastRenderedModalKind });
      lastRenderedModalKind = null;
    }
    host.setAttribute("hidden", "");
    host.removeAttribute("data-modal-kind");
    return;
  }
  if (modal.kind !== lastRenderedModalKind) {
    logEvent("modal.render", {
      kind: modal.kind,
      detail: snapModal(modal),
    });
    lastRenderedModalKind = modal.kind;
  }
  host.removeAttribute("hidden");
  // The wrapper's `data-modal-kind` lets CSS reposition specific
  // modals (e.g. dock the die-roll modal to a non-board area so the
  // board's tile preview stays fully visible behind it).
  host.setAttribute("data-modal-kind", modal.kind);
  switch (modal.kind) {
    case "action-menu":            renderActionMenuModal(host, router, modal); break;
    case "die-roll":               renderDieRollModal(host, router, modal);    break;
    case "delver-choice":          renderDelverChoiceModal(host, router, modal); break;
    case "counter-roll":           renderCounterRollModal(host, router, modal); break;
    case "ap-spend":               renderApSpendModal(host, router);           break;
    case "ap-refresh-pick-slot":   renderApRefreshPickSlotModal(host, router); break;
    case "level-up":               renderLevelUpModal(host, router);           break;
    case "opinion-rank-pick":      renderOpinionRankPickModal(host, router);   break;
    case "weapon-spend-pick":      renderWeaponSpendPickModal(host, router, modal); break;
    case "scenario-card":          renderScenarioCardModal(host, router);      break;
    case "friendly-encounter":     renderFriendlyEncounterModal(host, router); break;
    case "rules-viewer":           renderRulesViewerModal(host, router); break;
    case "suit-condition-rank-pick":
      renderSuitConditionRankPickModal(host, router, {
        onDrained: () => { setModal(null); router.refresh(); },
      });
      break;
    case "scenario-delver-pick":
      renderScenarioDelverPickModal(host, router, {
        onDrained: () => { setModal(null); router.refresh(); },
      });
      break;
    case "shield-prompt":          renderShieldPromptModal(host, router, modal); break;
    case "parting-shot-shield-prompt": renderPartingShotShieldPromptModal(host, router, modal); break;
    case "boots-rotate-direction": renderBootsRotateDirectionModal(host, router, modal); break;
    case "soulshift-roll":         renderSoulshiftRollModal(host, router, modal); break;
    case "beam-repeat-prompt":     renderBeamRepeatPromptModal(host, router, modal); break;
    case "creature-part-pick":     renderCreaturePartPickModal(host, router); break;
    case "element-pick":           renderElementPickModal(host, router); break;
    case "ritual-pick":            renderRitualPickModal(host, router); break;
    case "witness-move":           renderWitnessMoveModal(host, router); break;
    case "trident-pre-move-prompt":      renderTridentPreMovePromptModal(host, router, modal); break;
    case "weapon-counter-block-prompt":  renderWeaponCounterBlockPromptModal(host, router, modal); break;
    case "equipment-roll":               renderEquipmentRollModal(host, router, modal); break;
    case "xp-roll":                      renderXpRollModal(host, router, modal); break;
    case "double-damage-prompt":         renderDoubleDamagePromptModal(host, router, modal); break;
    case "prevent-counter-pick":         renderPreventCounterPickModal(host, router, modal); break;
    case "weapon-block-info":            renderWeaponBlockInfoModal(host, router, modal); break;
    case "mace-mode-pick":               renderMaceModePickModal(host, router, modal); break;
    case "mace-element-pick":            renderMaceElementPickModal(host, router, modal); break;
    case "end-turn-undo-prompt":         renderEndTurnUndoPromptModal(host, router); break;
  }

  // SELF-DISMISS GUARD (soft-lock fix 2026-07-22): several renderers
  // bail with `setModal(null); return;` when their backing state has
  // drained (friendly-encounter queue popped, scenario card closed,
  // stale enemy id, ...). The host was already un-hidden above, so
  // without this check an empty `.action-modal` — a full-screen
  // `position: fixed; inset: 0` layer — would sit invisibly on top
  // of the board eating every click until the next render pass that
  // may never come (playtester report: board frozen after friendly-
  // encounter rewards, only the out-of-app sound toggle clickable).
  if (getModal() === null) {
    host.innerHTML = "";
    host.setAttribute("hidden", "");
    host.removeAttribute("data-modal-kind");
    lastRenderedModalKind = null;
  }
}

// --- Action menu --------------------------------------------------------

function renderActionMenuModal(
  host: HTMLDivElement,
  router: Router,
  modal: Extract<Modal, { kind: "action-menu" }>,
): void {
  const state = router.state;
  const heroId = state.currentDelverId;
  const turnState = state.encounter?.turnState[heroId] ?? null;
  const placed = turnState?.cardPlacedThisTurn ?? null;
  if (!turnState || !placed || placed.slotIdx !== modal.slotIdx) {
    setModal(null);
    return;
  }
  const card = getEquipment(placed.cardId);
  const hero = getHero(heroId);
  const slot = getDelverBoard(hero.suit).weaponSlots[modal.slotIdx]!;
  const ability = slot.slotAbility;
  const hasWeaponAbility = card.category === "weapon" && card.range != null;
  // Resolve the rank-correct card for description text (e.g. Hammer R2+
  // says "Choose direction" rather than "Die-roll determines targets").
  const effectiveRanks = getEffectiveEquipmentRanks(state, heroId);
  const effectiveRank = effectiveRanks[card.type as EquipmentType] ?? 1;
  void effectiveRank;
  const rankedCard = playedWeaponCard(state, heroId, card.id);
  const playedRange = rankedCard.range ?? card.range;
  const weaponFreeChoice = playedRange?.kind === "die-roll-fixed" &&
    !(rankedCard.effects ?? []).some((e) => e.kind === "may-reroll-by-suffering");
  // Fabled Hammer fires with no target pick: say up front when it can't.
  const weaponBlockedReason = (() => {
    if (playedRange?.kind !== "between-delvers") return "";
    const enc0 = state.encounter;
    const me = enc0 ? getDelverAt(enc0, heroId) : null;
    const otherId = Object.keys(state.loadouts).find((id) => id !== heroId);
    const other = enc0 && otherId ? getDelverAt(enc0, otherId) : null;
    if (!enc0 || !me) return "Not on the board.";
    const r = computeWeaponHitTiles({ range: playedRange, attackerPos: me, otherDelverPos: other, encounter: enc0, board: BOARD });
    return r.ok ? "" : r.reason;
  })();

  // "Undo placement" is allowed any time before the action step is
  // resolved. The action menu itself only opens when actionUsedThisTurn
  // is false, so by construction we can offer undo unconditionally
  // here. Movement already used this turn stays committed — undo only
  // pulls the card and refunds any auto-refresh tokens. This matches
  // the engine's `undoWeaponPlacement` gate and is what the
  // "movement-before-card" flow (2026-05-21) actually requires: if we
  // blocked undo after movement, players who legitimately move-then-
  // place would be stuck with their first card choice.
  const canUndo = true;
  const undoDisabledReason = "";

  // The `refresh-ap` slot ability is a no-op if the active delver is
  // already at their base AP — pressing it would burn the action with
  // zero effect. Disable the button (and explain why) in that case so
  // the player can't accidentally waste their turn on it.
  const slotAbilityDisabledReason = (() => {
    if (ability.kind !== "refresh-ap") return "";
    const lo = state.loadouts[heroId];
    if (!lo) return "";
    if (lo.currentAp >= lo.baseAp) {
      return `Already at base AP (${lo.baseAp}) - nothing to refresh.`;
    }
    return "";
  })();
  const slotAbilityDisabled = slotAbilityDisabledReason !== "";

  // Witness "Move up to 2 tiles" action (Q2+ companion, Witness
  // Reference Card v2 PROOF 1). Surface the button only when the
  // quest actually carries Witness — for Q1 / non-Witness quests
  // we hide it entirely so the action menu doesn't grow a dead
  // option. Same "consumes the per-turn Action" gate as use-weapon /
  // use-slot; canBeginWitnessAction encodes the full predicate
  // (placed card + action not yet used + Witness on board).
  const enc = state.encounter;
  const witnessOnBoard = enc?.witnessPosition != null;
  const witnessActionAvailable = witnessOnBoard && canBeginWitnessAction(state);
  // Snapshot what we'll need for the Witness button title / detail:
  // remaining-step count + "you already moved Witness this turn"
  // wording. The button is enabled both when no Witness step has been
  // taken (start of action) AND when 1 step remains in the same
  // action (re-open the modal to take step 2).
  const witnessStepsUsed = enc?.turnState[heroId]?.witnessStepsThisTurn ?? 0;
  const witnessStepsRemaining = WITNESS_ACTION_STEP_CAP - witnessStepsUsed;
  const witnessButtonLabel = witnessStepsUsed > 0
    ? `Continue Witness move`
    : `Move Witness (up to ${WITNESS_ACTION_STEP_CAP} tiles)`;
  const witnessButtonDetail = witnessStepsUsed > 0
    ? `Witness has ${witnessStepsRemaining} step${witnessStepsRemaining === 1 ? "" : "s"} remaining this turn.`
    : `Companion robot - collects creature parts and memory chips for both delvers on the tiles he moves through.`;

  host.innerHTML = `
    <div class="action-menu-backdrop" data-close-modal></div>
    <div class="action-menu-body">
      <h3>Action - choose ONE</h3>
      <p class="small muted">Slot ${modal.slotIdx + 1} (${slot.element})</p>
      <div class="action-menu-options">
        <button class="action-option" data-action="use-weapon"${hasWeaponAbility && !weaponBlockedReason ? "" : " disabled"} title="${escapeHtml(weaponBlockedReason)}">
          <span class="action-option-label">Use weapon ability</span>
          <span class="action-option-detail small muted">${escapeHtml(rankedCard.name)} - ${escapeHtml(weaponBlockedReason || weaponAbilityDescription(playedRange, weaponFreeChoice))}</span>
        </button>
        <button class="action-option" data-action="use-slot"${slotAbilityDisabled ? " disabled" : ""} title="${escapeHtml(slotAbilityDisabledReason)}">
          <span class="action-option-label">Use slot ability</span>
          <span class="action-option-detail small muted">${escapeHtml(slotOnlyAbilityText(slot.slotAbilityText))}</span>
        </button>
        ${witnessOnBoard ? `
        <button class="action-option action-option--witness" data-action="move-witness"${witnessActionAvailable ? "" : " disabled"}>
          <span class="action-option-label">${escapeHtml(witnessButtonLabel)}</span>
          <span class="action-option-detail small muted">${escapeHtml(witnessButtonDetail)}</span>
        </button>` : ""}
        <button class="action-option action-option--undo" data-action="undo-placement"${canUndo ? "" : " disabled"} title="${escapeHtml(undoDisabledReason)}">
          <span class="action-option-label">Undo placement</span>
        </button>
      </div>
      <div class="action-menu-footer">
        <button class="btn btn--small btn--ghost" data-close-modal>Cancel</button>
      </div>
    </div>
  `;

  for (const closer of host.querySelectorAll<HTMLElement>("[data-close-modal]")) {
    closer.addEventListener("click", () => {
      setModal(null);
      router.refresh();
    });
  }

  const useWeapon = host.querySelector<HTMLButtonElement>("[data-action=use-weapon]");
  if (useWeapon && hasWeaponAbility && !weaponBlockedReason) {
    useWeapon.addEventListener("click", () => onChooseWeaponAbility(router, modal.slotIdx, playedRange!));

    // Fixed-pattern weapons (Trident, Shockwave) fire their printed
    // pattern with no targeting picker, so the player normally can't
    // tell which tiles their swing will hit until AFTER they commit.
    // Telegraph the hit tiles on hover into the existing board
    // targets layer (sibling DOM node) so the preview appears the
    // moment the cursor enters the button. Mouse-only \u2014 touch
    // users don't fire mouseenter/mouseleave and tap-to-execute
    // immediately, which matches the "no picker" model.
    //
    // We paint directly into the targets layer rather than going
    // through `router.refresh()` because a refresh would tear down
    // the modal DOM and the current button would be replaced by a
    // fresh DOM node \u2014 the browser doesn't re-fire mouseenter on
    // the new node even if the cursor is still hovering, which would
    // strand the preview when the cursor moved off. Direct DOM
    // mutation against the persistent targets layer sidesteps that
    // and is fast enough that the (heavier) refresh isn't worth it
    // for an enter/leave pair.
    if (card.range?.kind === "fixed-pattern") {
      const targetsLayer = document.querySelector<HTMLDivElement>("[data-board-targets]");
      if (targetsLayer) {
        useWeapon.addEventListener("mouseenter", () => {
          // Preview the RANK-CORRECT pattern, not the R1 placeholder
          // stored in the slot. Trident R2-R5 doubles its tile set
          // from 3 to 6; without this the preview would lie by 3
          // tiles and players would see fewer hits than the engine
          // actually fires.
          const tiles = computeFixedPatternPreviewTiles(router.state, rankedCard.id);
          targetsLayer.innerHTML = "";
          paintPreviewTargets(targetsLayer, tiles, false);
        });
        useWeapon.addEventListener("mouseleave", () => {
          targetsLayer.innerHTML = "";
        });
      }
    }
  }
  const useSlot = host.querySelector<HTMLButtonElement>("[data-action=use-slot]");
  if (useSlot && !slotAbilityDisabled) {
    useSlot.addEventListener("click", () => onChooseSlotAbility(router, modal.slotIdx, ability));
  }
  const moveWitness = host.querySelector<HTMLButtonElement>("[data-action=move-witness]");
  if (moveWitness && witnessActionAvailable) {
    moveWitness.addEventListener("click", () => onChooseWitnessMove(router));
  }
  const undoBtn = host.querySelector<HTMLButtonElement>("[data-action=undo-placement]");
  if (undoBtn && canUndo) {
    undoBtn.addEventListener("click", () => onUndoPlacement(router));
  }
}

// --- Machinist upgrade weapons ------------------------------------------

const playedWeaponCard = getPlayedWeaponCard;

const WEAPON_SPEND_KINDS: readonly WeaponSpendOption[] = [
  "spend-element-damage-all-enemies",
  "spend-element-block-counterattacks",
  "spend-element-extra-adjacent-damage",
  "spend-element-bonus-damage",
  "spend-element-die-multiplier",
];

type WeaponSpendEffect = { kind: WeaponSpendOption; element: Element; cost: number };

function weaponSpendEffects(card: EquipmentCard): WeaponSpendEffect[] {
  return (card.effects ?? []).filter((e) => (WEAPON_SPEND_KINDS as readonly string[]).includes(e.kind)) as WeaponSpendEffect[];
}

function weaponSpendLabel(eff: WeaponSpendEffect, card: EquipmentCard): string {
  const m = `${(card.damageMultiplier ?? 1) > 1 ? `${card.damageMultiplier}x ` : ""}`;
  switch (eff.kind) {
    case "spend-element-damage-all-enemies": return `Spend ${eff.cost} ${eff.element}: ${m}LIGHT damage to all enemies`;
    case "spend-element-block-counterattacks": return `Spend ${eff.cost} ${eff.element}: block counterattacks`;
    case "spend-element-extra-adjacent-damage": return `Spend ${eff.cost} ${eff.element}: additional ${m}HEAVY damage to 1 adjacent target`;
    case "spend-element-bonus-damage": return `Spend ${eff.cost} ${eff.element}: additional ${m}HEAVY damage`;
    case "spend-element-die-multiplier": return `Spend ${eff.cost} ${eff.element}: roll a die and multiply damage by the result`;
  }
}

/** Spend options picked in the `weapon-spend-pick` modal, carried to the
 *  swing's dispatch (cleared whenever a new weapon action starts). */
let pendingWeaponSpend: { spends: WeaponSpendOption[]; extraTarget?: { x: number; y: number }; dieRoll?: number } | null = null;

/** Lunar Trident's multiplier die, kept for the rest of this turn (keyed
 *  on the turn-state object, replaced every turn) - backing out of
 *  targeting and re-opening the menu must not reroll it. */
let rolledMultiplierDie: { turn: object; roll: number } | null = null;

/** Action-menu hook: swap to the witness-move modal. No engine state
 *  change happens here — the actual `stepWitness` call fires when the
 *  player taps a destination on the board. */
function onChooseWitnessMove(router: Router): void {
  logEvent("click.move-witness", {
    heroId: router.state.currentDelverId,
    witnessAt: router.state.encounter?.witnessPosition ?? null,
    stepsUsed: router.state.encounter?.turnState[router.state.currentDelverId]?.witnessStepsThisTurn ?? 0,
  });
  setModal({ kind: "witness-move" });
  router.refresh();
}

function onUndoPlacement(router: Router): void {
  const r = undoWeaponPlacement(router.state, router.state.currentDelverId);
  if (!r.ok) {
    console.warn("undoWeaponPlacement rejected:", r.reason);
    setModal(null);
    router.refresh();
    return;
  }
  setModal(null);
  router.save();
}

function onChooseWeaponAbility(router: Router, slotIdx: number, range: WeaponRange): void {
  const heroId = router.state.currentDelverId;
  const cardId = router.state.encounter!.turnState[heroId]!.cardPlacedThisTurn!.cardId;
  pendingWeaponSpend = null;
  // Machinist upgrade "Spend N [element]" options: ask first when any is
  // affordable (the picks ride along to the swing's dispatch).
  const played = playedWeaponCard(router.state, heroId, cardId);
  const bag = router.state.elements[heroId] ?? {};
  if (weaponSpendEffects(played).some((e) => (bag[e.element] ?? 0) >= e.cost)) {
    setModal({ kind: "weapon-spend-pick", slotIdx, cardId });
    router.refresh();
    return;
  }
  continueWeaponAbility(router, slotIdx, range);
}

function continueWeaponAbility(router: Router, slotIdx: number, range: WeaponRange): void {
  const heroId = router.state.currentDelverId;
  const turnState = router.state.encounter!.turnState[heroId]!;
  const cardId = turnState.cardPlacedThisTurn!.cardId;
  const card = getEquipment(cardId);
  // The hand always stores the R1 card ID for backward compatibility, but
  // effects may differ by rank (e.g. Hammer loses may-reroll-by-suffering at
  // R2+; Gauntlet gains/scales collect-creature-part at R2+). Resolve the
  // rank-correct (and Machinist-variant) card once here.
  const rankedCard = playedWeaponCard(router.state, heroId, cardId);
  const isVariant = rankedCard.id.includes("-upgrade-");
  // Fabled Hammer: every enemy between the delvers - no target pick.
  if (range.kind === "between-delvers") {
    promptDoubleDamageOrFire(router, slotIdx, cardId, { kind: "between-delvers" }, undefined);
    return;
  }
  // Precise Shockwave: tap enemies within range, then Fire in the banner.
  if (range.kind === "choose-targets") {
    setArmedAbility({ kind: "weapon", slotIdx, cardId, rangeKind: range.kind, chosenTargets: [] });
    setModal(null);
    router.refresh();
    return;
  }
  // For die-roll-fixed weapons, roll the die NOW and open the modal
  // straight to its result stage. The previous "Roll Die" pre-roll
  // step was redundant — the action-menu choice already advertises
  // "Die-roll determines targets" as its subtitle, and the result
  // stage immediately surfaces the rolled value + Keep/Flip choice +
  // board preview, so the click-to-roll button was just a
  // ceremonial extra tap.
  if (range.kind === "die-roll-fixed") {
    const mayReroll = (rankedCard.effects ?? []).some((e) => e.kind === "may-reroll-by-suffering");
    if (mayReroll) {
      // R1: roll die + offer keep/suffer-flip choice.
      setModal({
        kind: "die-roll",
        slotIdx,
        cardId: rankedCard.id,
        mayReroll: true,
        rolled: rollD6(),
        choice: "keep",
      });
      markFreshRoll("die-roll");
    } else {
      // R2+: free direction choice — no die roll animation.
      // rolled=1 means "keep" → option A, "flip" → option B (via flipDie),
      // which keeps the existing tile-preview path (modal.choice) working.
      setModal({
        kind: "die-roll",
        slotIdx,
        cardId: rankedCard.id,
        mayReroll: false,
        rolled: 1,
        choice: "keep",
      });
      // No markFreshRoll → renderDieRollModal renders choice UI immediately.
    }
    router.refresh();
    return;
  }
  // Fixed-pattern weapons (Trident, Shockwave): no targeting
  // picker — every printed tile fires every swing. If the card
  // carries the optional pre-attack `may-move-adjacent` effect AND
  // at least one adjacent enemy actually has somewhere to be pushed
  // to, open the pre-move prompt so the player can choose to push
  // someone before the swing fires. Otherwise fire immediately
  // (no prompt — there's nothing to decide).
  //
  // The "actually has somewhere to be pushed to" gate
  // (`anyAdjEnemyHasLegalDest`) was tightened 2026-05-09 from the
  // earlier "≥ 1 adjacent enemy" rule. With the looser gate the
  // prompt could open in crowded-board scenarios where every
  // adjacent enemy is fully boxed in by other enemies / delvers,
  // leaving the player with an armed picker that paints the
  // enemies but no destination overlay once they pick one. Now
  // we don't open the modal unless there's at least one enemy
  // the player could legally complete the push with.
  if (range.kind === "fixed-pattern") {
    const hasMoveEffect = (card.effects ?? []).some(
      (e) => e.kind === "pre-attack-may-move-adjacent",
    );
    const adj = adjacentEnemyTargets(router.state, heroId);
    const anyAdjEnemyHasLegalDest = adj.some(
      (e) => legalMoveDestinationsForEnemy(router.state, e.instanceId, BOARD).length > 0,
    );
    if (hasMoveEffect && anyAdjEnemyHasLegalDest) {
      setModal({ kind: "trident-pre-move-prompt", slotIdx, cardId });
      router.refresh();
      return;
    }
    fireFixedPatternSwing(router, slotIdx, undefined);
    return;
  }
  // Mace (both suits R1) `target-filter-or-spend-element`: the
  // `single-adjacent` range carries a card-level filter + element
  // bypass. Decide which modal (if any) to open BEFORE arming the
  // weapon so the target overlay paints the correct subset of
  // adjacent enemies.
  //
  // Auto-skip rules (matches `engine/mace.ts > classifyMaceModes`):
  //   - both modes viable                    → mace-mode-pick modal
  //   - only default viable                  → arm default directly
  //   - only spend viable + 1 element kind   → arm spend directly
  //   - only spend viable + multiple kinds   → mace-element-pick modal
  //   - neither viable                       → no-op (close menu, refresh)
  if (range.kind === "single-adjacent") {
    // A Machinist variant (War Mace) has no UNDAMAGED filter of its own.
    const modes = classifyMaceModes(router.state, heroId, isVariant ? rankedCard : card);
    if (modes) {
      if (modes.defaultModeAvailable && modes.spendModeAvailable) {
        setModal({ kind: "mace-mode-pick", slotIdx, cardId });
        router.refresh();
        return;
      }
      if (modes.defaultModeAvailable) {
        setArmedAbility({ kind: "weapon", slotIdx, cardId, rangeKind: range.kind });
        setModal(null);
        router.refresh();
        return;
      }
      if (modes.spendModeAvailable) {
        if (modes.availableElementKinds.length === 1) {
          setArmedAbility({
            kind: "weapon",
            slotIdx,
            cardId,
            rangeKind: range.kind,
            spendElementForBypass: modes.availableElementKinds[0],
          });
          setModal(null);
          router.refresh();
          return;
        }
        setModal({ kind: "mace-element-pick", slotIdx, cardId });
        router.refresh();
        return;
      }
      // Neither mode viable — no adjacent enemies at all (with or
      // without the filter), or filter empty + bag empty. Close the
      // action menu silently; the player can re-open it once the
      // board state changes.
      console.warn(`Mace ${cardId}: no legal target in either mode; not arming`);
      setModal(null);
      router.refresh();
      return;
    }
  }
  // Chain weapon: if there are no valid start tiles (e.g. the other
  // delver isn't adjacent to any live enemy for Surge Claw) but the
  // card has a collect-creature-part effect, fire immediately with a
  // guaranteed-miss target so the engine builds a 0-hit session and
  // the creature-part post-effect still fires.
  if (range.kind === "chain") {
    const hasCollectPart = (rankedCard.effects ?? []).some(
      (e) => e.kind === "collect-creature-part",
    );
    if (hasCollectPart) {
      const enc = router.state.encounter;
      let anchor: { x: number; y: number } | null = null;
      if (enc) {
        if (range.requiresAdjacentTo === "self") {
          anchor = getDelverAt(enc, heroId);
        } else {
          const otherId = Object.keys(router.state.loadouts).find((id) => id !== heroId);
          anchor = otherId ? getDelverAt(enc, otherId) : null;
        }
      }
      const hasValidStart =
        anchor != null &&
        (enc?.enemies ?? []).some(
          (e) =>
            e.alive &&
            Math.abs(e.x - anchor!.x) <= 1 &&
            Math.abs(e.y - anchor!.y) <= 1,
        );
      if (!hasValidStart) {
        // No valid chain start tiles — dispatch with an off-board target.
        // The engine will produce 0 hit tiles but still apply post-effects.
        dispatchWeaponAbility(
          router, slotIdx, cardId,
          { kind: "chain", targetX: -1, targetY: -1 },
          undefined, undefined,
        );
        return;
      }
    }
  }
  // For all other range kinds: arm the ability and switch to target-pick mode.
  setArmedAbility({ kind: "weapon", slotIdx, cardId, rangeKind: range.kind });
  setModal(null);
  router.refresh();
}

/**
 * Dispatch a fixed-pattern swing (Trident, Shockwave) — these
 * weapons take no target picker so this is the single entry point
 * for both the no-pre-move path AND the post-pre-move-pick path.
 * Builds the `WeaponAbilityParams` + optional `preAttackMove` and
 * either starts the resulting attack session or — when no live
 * enemy ended up on any printed tile — silently consumes the
 * action and finalizes (the action gate is already latched inside
 * `useWeaponAbility`).
 *
 * The "no live enemy" empty-swing case is intentional: the rules
 * say the action fires regardless of whether there's anyone to hit,
 * matching `die-roll-fixed`'s "miss tile" behavior in
 * `resolveAllDamage`.
 */
function fireFixedPatternSwing(
  router: Router,
  slotIdx: number,
  preAttackMove: { enemyInstanceId: string; toX: number; toY: number } | undefined,
): void {
  const ts = router.state.encounter?.turnState[router.state.currentDelverId];
  const cardId = ts?.cardPlacedThisTurn?.cardId;
  if (!cardId) return;
  promptDoubleDamageOrFire(
    router,
    slotIdx,
    cardId,
    { kind: "fixed-pattern" },
    preAttackMove,
  );
}

/**
 * Single source of truth for "actually call the engine". Combines
 * the optional pre-attack move (Trident) and the optional
 * Double Damage spend (Supercharger) into one
 * {@link useWeaponAbility} call, then either starts the resulting
 * `AttackSession` or surfaces the engine's rejection reason.
 *
 * Called from:
 *   - {@link promptDoubleDamageOrFire} on the no-DD-eligible / Skip /
 *     spend-confirmed paths,
 *   - the Double Damage prompt modal's spend / skip buttons.
 *
 * Rejection paths (engine returns `{ ok: false, reason }`) clear
 * armed + modal state and refresh — the player gets a console
 * warning but the UI stays responsive (today no engine-level
 * rejection is reachable from a happy-path UI tick; this branch
 * exists for defense and easier debugging).
 */
function dispatchWeaponAbility(
  router: Router,
  slotIdx: number,
  cardId: string,
  weaponParams: WeaponAbilityParams,
  preAttackMove: { enemyInstanceId: string; toX: number; toY: number } | undefined,
  spendKind: ConsumableTokenKind | undefined,
): void {
  const opts: {
    preAttackMove?: typeof preAttackMove;
    spendDoubleDamage?: ConsumableTokenKind;
    spends?: WeaponSpendOption[];
    extraTarget?: { x: number; y: number };
    dieMultiplierRoll?: number;
  } = {};
  if (preAttackMove) opts.preAttackMove = preAttackMove;
  if (spendKind) opts.spendDoubleDamage = spendKind;
  if (pendingWeaponSpend && pendingWeaponSpend.spends.length > 0) {
    opts.spends = pendingWeaponSpend.spends;
    if (pendingWeaponSpend.extraTarget) opts.extraTarget = pendingWeaponSpend.extraTarget;
    // Lunar Trident: the multiplier die was rolled (and shown) in the
    // spend prompt.
    if (pendingWeaponSpend.dieRoll) opts.dieMultiplierRoll = pendingWeaponSpend.dieRoll;
  }
  pendingWeaponSpend = null;
  const heroId = router.state.currentDelverId;
  const elementsBefore = snapElements(router.state, heroId);
  const r = useWeaponAbility(
    router.state,
    heroId,
    slotIdx,
    weaponParams,
    opts,
  );
  logEvent("engine.useWeaponAbility", {
    heroId,
    slotIdx,
    cardId,
    spendDoubleDamage: spendKind ?? null,
    preAttackMove: preAttackMove
      ? { enemyInstanceId: preAttackMove.enemyInstanceId, toX: preAttackMove.toX, toY: preAttackMove.toY }
      : null,
    result: r.ok ? "ok" : `fail:${r.reason}`,
    elementsBefore,
    elementsAfter: snapElements(router.state, heroId),
    apAfter: snapHeroAp(router.state, heroId),
    turnAfter: snapTurn(router.state, heroId),
  });
  if (!r.ok) {
    console.warn("useWeaponAbility rejected:", r.reason);
    setArmedAbility(null);
    setModal(null);
    router.refresh();
    return;
  }
  setArmedAbility(null);
  setModal(null);
  startAttackSession(router, r.session, cardId);
}

/**
 * Pre-fire gate: if the bearer has at least one matching Double
 * Damage token AND hasn't already spent one this turn, open the
 * `double-damage-prompt` modal so the player can spend / skip.
 * Otherwise, dispatch the swing immediately.
 *
 * "Matching" means either the typed kind for the weapon's printed
 * `damageType` (e.g. `damage-2x-light` for a Light swing) OR the
 * universal kind (always doubles).
 *
 * Slot-ability swings (`damage-any-enemy`) do NOT route through
 * here because the slot-ability path doesn't go through
 * {@link useWeaponAbility} — the rulebook implies DD tokens only
 * apply to weapon attacks (the printed example on p15 is a swing,
 * not a slot ability), and the engine guards against a wasted
 * spend regardless.
 *
 * Soulshift bonus swings (`freeRepeat: true`) intentionally do NOT
 * route through here either — the engine's per-turn cap will block
 * a second spend anyway, and the chain-flow UI is already busy.
 * Future work could surface a prompt on the FIRST chain link to
 * let the player pick when to spend.
 */
function promptDoubleDamageOrFire(
  router: Router,
  slotIdx: number,
  cardId: string,
  weaponParams: WeaponAbilityParams,
  preAttackMove: { enemyInstanceId: string; toX: number; toY: number } | undefined,
): void {
  // The played card's damage type (a Machinist variant can differ).
  const card = playedWeaponCard(router.state, router.state.currentDelverId, cardId);
  // Weapons without a damageType (none today, but defensive) and
  // non-weapon cards (impossible here, but defensive) skip the
  // prompt.
  if (card.damageType !== "light" && card.damageType !== "medium" && card.damageType !== "heavy") {
    dispatchWeaponAbility(router, slotIdx, cardId, weaponParams, preAttackMove, undefined);
    return;
  }
  const heroId = router.state.currentDelverId;
  const ts = router.state.encounter?.turnState[heroId];
  if (!ts || ts.damage2xUsedThisTurn) {
    dispatchWeaponAbility(router, slotIdx, cardId, weaponParams, preAttackMove, undefined);
    return;
  }
  const matchingKind = typedDoubleDamageKindFor(card.damageType);
  const matchingAvail = tokenAvailable(router.state, heroId, matchingKind);
  const universalAvail = tokenAvailable(router.state, heroId, "damage-2x-universal");
  if (matchingAvail <= 0 && universalAvail <= 0) {
    dispatchWeaponAbility(router, slotIdx, cardId, weaponParams, preAttackMove, undefined);
    return;
  }
  setModal({
    kind: "double-damage-prompt",
    slotIdx,
    cardId,
    damageType: card.damageType,
    weaponParams,
    preAttackMove,
  });
  router.refresh();
}

function onChooseSlotAbility(router: Router, slotIdx: number, ability: SlotAbility): void {
  switch (ability.kind) {
    case "damage-any-enemy":
      setArmedAbility({ kind: "slot-damage", slotIdx });
      setModal(null);
      router.refresh();
      return;
    case "bonus-movement-this-turn":
    case "refresh-ap": {
      // Auto-resolve, no input needed.
      const params: SlotAbilityParams = { kind: ability.kind } as SlotAbilityParams;
      const r = useSlotAbility(router.state, router.state.currentDelverId, slotIdx, params);
      if (!r.ok) { console.warn("useSlotAbility rejected:", r.reason); setModal(null); router.refresh(); return; }
      finalizeAppliedSlotAbility(router, r.result);
      return;
    }
    case "gain-token":
    case "gain-element":
      setModal({ kind: "delver-choice", slotIdx, ability });
      router.refresh();
      return;
  }
}

// --- Die-roll modal -----------------------------------------------------

function renderDieRollModal(
  host: HTMLDivElement,
  router: Router,
  modal: Extract<Modal, { kind: "die-roll" }>,
): void {
  const card = getEquipment(modal.cardId);
  // The modal is opened by `onChooseWeaponAbility` already in its
  // result stage (`modal.rolled` is set + `modal.choice` defaulted
  // to "keep") — there is no pre-roll step to render. The narrow
  // type-guard below documents the invariant for future readers and
  // satisfies TS that `modal.rolled` is non-undefined below.
  if (modal.rolled === undefined) {
    setModal(null);
    return;
  }

  // Result stage. Once a die has been rolled the result is locked in
  // (rulebook general rule — no roll-undos), so the only outs are
  // Confirm or, for cards that grant a reroll effect (today only
  // Hammer's `may-reroll-by-suffering`), pay the cost and flip first.
  // No Cancel button here on purpose.
  const reroll = modal.mayReroll ? getRerollEffect(card) : null;
  const choice: "keep" | "flip" = modal.choice ?? "keep";
  const flipped = flipDie(modal.rolled);
  const effectiveDie = choice === "flip" ? flipped : modal.rolled;
  const heroId = router.state.currentDelverId;
  const hp = router.state.loadouts[heroId]?.currentHp ?? 0;
  // The reroll forecast pulls from card data so future upgrades with
  // non-HP reroll costs (e.g. AP, free reroll) just need to extend
  // the helpers — the modal layout is already data-driven.
  const flipForecast = reroll
    ? formatRerollForecast(reroll, hp)
    : null;
  const flipLabel = reroll ? formatRerollLabel(reroll) : "";

  // --- Free-choice path (R2+ hammers: "Choose 1: WEST or EAST") ----
  // When there is no reroll cost, the player freely picks a direction.
  // Show two direction buttons directly — no die animation needed.
  if (!reroll && card.range?.kind === "die-roll-fixed") {
    const rolls = card.range.rolls;
    const dirA = dxDyToDirection(rolls[0]?.tiles[0] ?? { dx: 0, dy: 0 });
    const dirB = dxDyToDirection(rolls[1]?.tiles[0] ?? { dx: 0, dy: 0 });
    host.innerHTML = `
      <div class="action-menu-backdrop"></div>
      <div class="action-menu-body modal-numpad die-roll-result-body">
        <h3>${escapeHtml(card.name)}</h3>
        <p class="small muted">Choose direction</p>
        <div class="die-roll-choices" role="radiogroup" aria-label="Choose direction">
          <button class="die-roll-choice ${choice === "keep" ? "die-roll-choice--selected" : ""}"
                  data-choice="keep" role="radio" aria-checked="${choice === "keep"}">
            <span class="die-roll-choice-title">${dirA}</span>
          </button>
          <button class="die-roll-choice ${choice === "flip" ? "die-roll-choice--selected" : ""}"
                  data-choice="flip" role="radio" aria-checked="${choice === "flip"}">
            <span class="die-roll-choice-title">${dirB}</span>
          </button>
        </div>
        <div class="modal-footer">
          <button class="btn btn--primary" data-confirm>Take that!</button>
        </div>
      </div>
    `;
    host.querySelector<HTMLButtonElement>("[data-confirm]")?.addEventListener("click", () => {
      onDieRollSubmit(router, modal.slotIdx, modal.cardId, effectiveDie, false);
    });
    for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-choice]")) {
      btn.addEventListener("click", () => {
        const next = btn.dataset.choice as "keep" | "flip";
        if ((modal.choice ?? "keep") === next) return;
        setModal({ ...modal, choice: next });
        router.refresh();
      });
    }
    return;
  }

  // --- Standard die-roll path (R1: roll die + keep/suffer-flip) ----
  // If the cycle is about to start (this is the FIRST render after
  // the engine rolled), suppress everything that derives from the
  // result — Keep/Flip choice, forecast, and Confirm — until the
  // die settles. The cycle's onDone fires `router.refresh()` which
  // re-runs this with `isFreshRoll = false` and the full UI shown.
  const isFreshRoll = consumeFreshRoll("die-roll");
  const resultUiHtml = isFreshRoll ? "" : `
      ${reroll ? `
        <div class="die-roll-choices" role="radiogroup" aria-label="Roll outcome">
          <button class="die-roll-choice ${choice === "keep" ? "die-roll-choice--selected" : ""}"
                  data-choice="keep" role="radio" aria-checked="${choice === "keep"}">
            <span class="die-roll-choice-title">Keep rolled direction</span>
          </button>
          <button class="die-roll-choice ${choice === "flip" ? "die-roll-choice--selected" : ""}"
                  data-choice="flip" role="radio" aria-checked="${choice === "flip"}">
            <span class="die-roll-choice-title">${escapeHtml(flipLabel)}</span>
          </button>
        </div>
        ${flipForecast && choice === "flip"
          ? `<p class="die-roll-forecast small">${flipForecast}</p>`
          : ""}
      ` : ""}
      <div class="modal-footer">
        <button class="btn btn--primary" data-confirm>Take that!</button>
      </div>
    `;

  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body modal-numpad die-roll-result-body">
      <h3>Roll Die - ${escapeHtml(card.name)}</h3>
      <p class="small muted">${escapeHtml(weaponAbilityDescription(card.range))}</p>
      <div class="die-roll-stage die-roll-stage--result">
        <div class="die-roll-result die-roll-result--effective" aria-live="polite">${modal.rolled}</div>
      </div>
      ${resultUiHtml}
    </div>
  `;
  // Wire result-UI buttons only when they exist (i.e. cycle has
  // settled). querySelector returns null while the cycle is still
  // in flight, so guarded queries here keep us safe.
  const confirmBtn = host.querySelector<HTMLButtonElement>("[data-confirm]");
  if (confirmBtn) {
    confirmBtn.addEventListener("click", () => {
      onDieRollSubmit(router, modal.slotIdx, modal.cardId, effectiveDie, choice === "flip");
    });
  }
  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-choice]")) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.choice as "keep" | "flip";
      if ((modal.choice ?? "keep") === next) return;
      setModal({ ...modal, choice: next });
      router.refresh();
    });
  }
  if (isFreshRoll) {
    playDieRollCycle(
      host.querySelector<HTMLElement>(".die-roll-result--effective"),
      modal.rolled,
      "die-roll",
      () => router.refresh(),
    );
  }
}

// --- Reroll-effect descriptors -----------------------------------------

/**
 * Reroll descriptor extracted from a weapon card's `effects[]`. Today
 * only `may-reroll-by-suffering` exists (Hammer rank 1), but the UI
 * code below pattern-matches on `kind` so extending this union with a
 * future "spend AP", "free reroll", etc. only needs the new variant +
 * the corresponding cases in `formatRerollLabel` / `formatRerollForecast`.
 */
type RerollEffect =
  | { kind: "may-reroll-by-suffering"; suffer: number };

function getRerollEffect(card: { effects?: { kind: string }[] }): RerollEffect | null {
  for (const eff of card.effects ?? []) {
    if (eff.kind === "may-reroll-by-suffering") {
      const e = eff as { kind: "may-reroll-by-suffering"; suffer: number };
      return { kind: "may-reroll-by-suffering", suffer: e.suffer };
    }
  }
  return null;
}

function formatRerollLabel(effect: RerollEffect): string {
  switch (effect.kind) {
    case "may-reroll-by-suffering":
      return `Suffer ${effect.suffer} HP to change direction`;
  }
}

/**
 * One-line forecast shown when the player has the "flip" option
 * selected, summarising the cost they're about to pay. Returns
 * `null` for cost-free reroll variants (future). Keeps the
 * presentation simple: "HP: 5 → 4".
 */
function formatRerollForecast(effect: RerollEffect, currentHp: number): string | null {
  switch (effect.kind) {
    case "may-reroll-by-suffering": {
      if (effect.suffer <= 0) return null;
      const after = Math.max(0, currentHp - effect.suffer);
      return `HP: <strong>${currentHp}</strong> \u2192 <strong>${after}</strong>`;
    }
  }
}

function rollD6(): number {
  return Math.floor(Math.random() * 6) + 1;
}

function flipDie(roll: number): number {
  // 1-3 ↔ 4-6 (so 1↔4, 2↔5, 3↔6).
  return roll <= 3 ? roll + 3 : roll - 3;
}

/** Convert a dx/dy offset to a cardinal direction label for the free-choice hammer UI. */
function dxDyToDirection(tile: { dx: number; dy: number }): string {
  if (tile.dx < 0) return "WEST";
  if (tile.dx > 0) return "EAST";
  if (tile.dy < 0) return "NORTH";
  if (tile.dy > 0) return "SOUTH";
  return "?";
}

function onDieRollSubmit(
  router: Router,
  slotIdx: number,
  cardId: string,
  dieRoll: number,
  suffered: boolean,
): void {
  promptDoubleDamageOrFire(
    router,
    slotIdx,
    cardId,
    { kind: "die-roll-fixed", dieRoll, suffered },
    undefined,
  );
}

// --- Delver choice modal -----------------------------------------------

function renderDelverChoiceModal(
  host: HTMLDivElement,
  router: Router,
  modal: Extract<Modal, { kind: "delver-choice" }>,
): void {
  const ability = modal.ability;
  const what = ability.kind === "gain-token"
    ? (ability.token === "boss-part" ? "BOSS PART" : "CREATURE PART")
    : `${ability.element.toUpperCase()} element`;
  // For element grants, swap the generic "Hero #01" subtitle for the
  // delver's CURRENT count of the element being granted (with the
  // per-delver cap appended). Tokens don't have a per-delver count
  // (they're a shared pool), so the token flow falls back to the
  // hero's printed name.
  const detailFor = (heroId: string): string => {
    if (ability.kind !== "gain-element") {
      return escapeHtml(getHero(heroId).name);
    }
    const have = router.state.elements[heroId]?.[ability.element] ?? 0;
    const atCap = have >= ELEMENT_CAP_PER_DELVER;
    const cap = ELEMENT_CAP_PER_DELVER;
    const elementLabel = escapeHtml(ability.element);
    const capPill = atCap ? ` <span class="muted">(at cap - lost)</span>` : "";
    return `Has <strong>${have} / ${cap}</strong> ${elementLabel}${capPill}`;
  };
  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body">
      <h3>Grant +1 ${escapeHtml(what)}</h3>
      <p class="small muted">Choose which Delver receives.</p>
      <div class="action-menu-options">
        ${HEROES.map((h) => `
          <button class="action-option" data-recipient="${h.id}">
            <span class="action-option-label">${escapeHtml(h.suit === "mind" ? "Mind Delver" : "Body Delver")}</span>
            <span class="action-option-detail small muted">${detailFor(h.id)}</span>
          </button>
        `).join("")}
      </div>
      <div class="modal-footer">
        <button class="btn btn--small btn--ghost" data-cancel>Cancel</button>
      </div>
    </div>
  `;
  host.querySelector<HTMLButtonElement>("[data-cancel]")!
    .addEventListener("click", () => { setModal(null); router.refresh(); });
  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-recipient]")) {
    btn.addEventListener("click", () => {
      const recipientHeroId = btn.dataset.recipient!;
      const params: SlotAbilityParams = ability.kind === "gain-token"
        ? { kind: "gain-token", recipientHeroId }
        : { kind: "gain-element", recipientHeroId };
      const r = useSlotAbility(router.state, router.state.currentDelverId, modal.slotIdx, params);
      if (!r.ok) { console.warn("useSlotAbility rejected:", r.reason); setModal(null); router.refresh(); return; }
      finalizeAppliedSlotAbility(router, r.result);
    });
  }
}

// --- Shared counter-roll modal (DESIGN.md §5.4) -------------------------
// One d6 roll covers EVERY damaged enemy's counter-attack in a single
// attack. Each damaged enemy still applies its own counter pattern,
// but they all share the same outcome (miss / common / uncommon)
// derived from the single roll. Auto-skipped if no possible roll
// outcome could land on a delver.

function renderCounterRollModal(
  host: HTMLDivElement,
  router: Router,
  modal: Extract<Modal, { kind: "counter-roll" }>,
): void {
  const session = getAttackSession();
  const phase = session?.sharedCounter ?? null;
  if (!session || !phase || phase.resolved) {
    setModal(null);
    return;
  }

  // Pre-roll stage: stripped down to just the header + Roll button.
  // The damaged-enemy roster and the 1/2-5/6 outcome key both live
  // on the cheatsheet panel so duplicating them here was just noise
  // between an attack and its inevitable counter prompt.
  if (modal.rolled === undefined) {
    host.innerHTML = `
      <div class="action-menu-backdrop"></div>
      <div class="action-menu-body modal-numpad">
        <h3>Counterattack</h3>
        <div class="die-roll-stage die-roll-stage--pre">
          <button class="btn btn--primary die-roll-btn" data-roll>Roll Die</button>
        </div>
      </div>
    `;
    host.querySelector<HTMLButtonElement>("[data-roll]")!
      .addEventListener("click", () => {
        setModal({ kind: "counter-roll", rolled: rollD6() });
        markFreshRoll("counter-roll");
        router.refresh();
      });
    return;
  }

  // Result stage: big die-roll readout + per-delver damage breakdown
  // + Confirm. Each damaged-enemy's offsets are highlighted on the
  // board behind us (`paintCounterStrikeHighlights`) so the player
  // can read which tiles took the swing. Per the spec we omit any
  // delver who suffered 0 damage (no "Body Delver suffers 0 damage"
  // line) and show a single "Missed" line when nobody was hit.
  const outcome = counterAttackOutcomeForRoll(modal.rolled);
  const hits = previewCounterHitsByDelver(
    router.state,
    phase.damagedEnemies,
    outcome,
    undefined,
    modal.rolled,
  );
  const breakdownHtml = renderCounterBreakdown(hits);
  // Reroll + Prevent buttons attach to the active delver (= the
  // attacker / counter recipient) — they spend their own bag.
  // Available on this stage only; if rerolled, the modal recurses
  // back into Stage B with the new die value.
  const activeHeroId = router.state.currentDelverId;
  const rerollCheck = canSpendReroll(router.state, activeHeroId);
  const rerollAvail = tokenAvailable(router.state, activeHeroId, "reroll");
  const rerollHtml = rerollCheck.ok
    ? `<button class="btn btn--small btn--ghost" data-counter-reroll>
         Reroll (${rerollAvail} available)
       </button>`
    : "";

  // Block Counterattack: show one button per delver who has tokens,
  // since either delver can spend their token on any turn to prevent
  // an enemy counterattack that would hit any delver.
  const hasAnyCounterattacker = phase.damagedEnemies.length > 0 && hits.length > 0;
  const preventHtml = hasAnyCounterattacker
    ? Object.keys(router.state.loadouts)
        .filter((heroId) => canSpendPreventCounter(router.state, heroId).ok)
        .map((heroId) => {
          const avail = tokenAvailable(router.state, heroId, "prevent-counterattack");
          const label = heroId === "hero-01" ? "Mind" : "Body";
          return `<button class="btn btn--small btn--ghost" data-counter-prevent data-prevent-spender="${escapeHtml(heroId)}">
            ${escapeHtml(label)}: Block 1 counterattack (${avail} available)
          </button>`;
        })
        .join("")
    : "";

  // Hide the per-delver damage breakdown + Confirm/Reroll/Prevent
  // buttons while the cycle is still spinning the die — they all
  // derive from the rolled outcome and would spoil the result. The
  // cycle's onDone refreshes us and the full UI re-appears.
  const isFreshRoll = consumeFreshRoll("counter-roll");
  const stageInnerHtml = isFreshRoll ? "" : breakdownHtml;
  // Confirm-button flavour: when at least one delver is about to
  // take damage from this counterattack ("Owch"), vs the miss case
  // where nobody got hit (plain "Confirm"). Mirrors the die-roll
  // modal's "Take that!" treatment so the player gets a clear
  // tonal signal in both directions: cheer when YOU land an
  // attack, wince when the enemies counter you. (User request
  // 2026-05-20.)
  // "Owch" (damage incoming) gets a distinct orange paint via
  // `.btn--owch` so the player gets a colour cue matching the tone
  // of the label — soft amber-orange reads as "ouch" without the
  // alarm of a full red. Miss case keeps the neutral blue
  // `.btn--primary` paint since nothing bad is happening.
  const confirmLabel = hits.length > 0 ? "Owch" : "Confirm";
  const confirmClass = hits.length > 0 ? "btn btn--owch" : "btn btn--primary";
  const footerHtml = isFreshRoll ? "" : `
      <div class="modal-footer">
        ${rerollHtml}
        ${preventHtml}
        <button class="${confirmClass}" data-confirm>${confirmLabel}</button>
      </div>
    `;
  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body modal-numpad">
      <h3>Counterattack Result</h3>
      <div class="die-roll-stage die-roll-stage--result">
        <div class="die-roll-result die-roll-result--counter">${modal.rolled}</div>
        ${stageInnerHtml}
      </div>
      ${footerHtml}
    </div>
  `;
  const confirmBtn = host.querySelector<HTMLButtonElement>("[data-confirm]");
  if (confirmBtn) {
    confirmBtn.addEventListener("click", () => applySharedCounter(router, modal.rolled!));
  }
  const rerollBtn = host.querySelector<HTMLButtonElement>("[data-counter-reroll]");
  if (rerollBtn) {
    rerollBtn.addEventListener("click", () => {
      const ok = spendToken(router.state, activeHeroId, "reroll");
      if (!ok) return;
      router.save();
      setModal({ kind: "counter-roll", rolled: rollD6() });
      markFreshRoll("counter-roll");
      router.refresh();
    });
  }
  for (const preventBtn of host.querySelectorAll<HTMLButtonElement>("[data-counter-prevent]")) {
    preventBtn.addEventListener("click", () => {
      setModal({ kind: "prevent-counter-pick", counterRoll: modal.rolled!, spenderHeroId: preventBtn.dataset.preventSpender! });
      router.refresh();
    });
  }
  if (isFreshRoll) {
    playDieRollCycle(
      host.querySelector<HTMLElement>(".die-roll-result--counter"),
      modal.rolled,
      "counter-roll",
      () => router.refresh(),
    );
  }
}

/**
 * Render the post-roll per-delver damage list. Returns either:
 *   - "Missed" when nobody was hit (miss outcome OR no offset
 *     intersected a delver tile), OR
 *   - one "{Suit} Delver suffers N damage" line per hero who took
 *     damage. Heroes with 0 damage are intentionally omitted (the
 *     player just doesn't need to see a no-op line).
 */
function renderCounterBreakdown(
  hits: { heroId: string; damage: number }[],
): string {
  if (hits.length === 0) {
    return `<div class="counter-breakdown counter-breakdown--missed">Missed</div>`;
  }
  // Sort mind first, body second — gives a stable, suit-ordered
  // readout even if `hits` came back in heroId order from the Map.
  const lines = hits
    .map((h) => ({ ...h, hero: getHero(h.heroId) }))
    .sort((a, b) => (a.hero.suit === "mind" ? 0 : 1) - (b.hero.suit === "mind" ? 0 : 1))
    .map(({ hero, damage }) => {
      const suit = hero.suit === "mind" ? "Mind" : "Body";
      return `<div class="counter-breakdown-line">${suit} Delver suffers ${damage} damage</div>`;
    });
  return `<div class="counter-breakdown">${lines.join("")}</div>`;
}

/**
 * Block Counterattack pick modal. Lists every counterattacker
 * still on the shared-counter phase that would land damage given
 * the current outcome. Picking one mutates `phase.damagedEnemies`
 * (drops the picked entry), spends one BLOCK COUNTERATTACK
 * token, latches the per-turn cap, and routes back to the
 * counter-roll modal at the same `counterRoll` so the player can
 * re-confirm or stack another decision.
 *
 * Why mutate the phase rather than carry a "prevented set"?
 * `phase.damagedEnemies` is the source of truth for every
 * downstream computation (block candidates, shield opportunities,
 * board highlights, damage application). Removing the entry
 * cascades through naturally; no parallel state to keep in sync.
 */
function renderPreventCounterPickModal(
  host: HTMLDivElement,
  router: Router,
  modal: Extract<Modal, { kind: "prevent-counter-pick" }>,
): void {
  const session = getAttackSession();
  const phase = session?.sharedCounter ?? null;
  if (!session || !phase) {
    setModal(null);
    router.refresh();
    return;
  }
  const spenderHeroId = modal.spenderHeroId;
  const spenderLabel = spenderHeroId === "hero-01" ? "Mind" : "Body";
  const outcome = counterAttackOutcomeForRoll(modal.counterRoll);

  // Surface ONLY counterattackers whose offsets currently land on at
  // least one delver — preventing one whose pattern misses everyone
  // would burn the token for nothing. Done by computing the
  // per-enemy hit list and filtering down.
  const candidates = phase.damagedEnemies.filter((d) => {
    const offsets = d.facing !== undefined
      ? perEnemyOffsetsHit(router.state, d, outcome)
      : 0;
    return offsets > 0;
  });

  // Defensive: if the list shrank to empty between renders (e.g. a
  // shield/block already nullified everything), bounce back to the
  // counter-roll modal.
  if (candidates.length === 0) {
    setModal({ kind: "counter-roll", rolled: modal.counterRoll });
    router.refresh();
    return;
  }

  const buttons = candidates.map((d) => {
    const card = getEnemy(d.cardId);
    return `
      <button class="action-option" data-prevent-id="${escapeHtml(d.instanceId)}">
        <span class="action-option-label">${escapeHtml(card.name)} @ (${d.x},${d.y})</span>
        <span class="action-option-detail small muted">Counter would deal ${card.attack} to each delver in pattern</span>
      </button>
    `;
  }).join("");
  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body">
      <h3>Block which enemy's counterattack?</h3>
      <p class="small muted">Spends 1 of <strong>${escapeHtml(spenderLabel)} Delver</strong>'s BLOCK COUNTERATTACK tokens. The picked enemy's counterattack is cancelled completely: no damage and none of its after-counterattack effects (Rotates, Alert, Flees and so on).</p>
      <div class="action-menu-options">
        ${buttons}
      </div>
      <div class="action-menu-footer">
        <button class="btn btn--small btn--ghost" data-back>Back</button>
      </div>
    </div>
  `;
  host.querySelector<HTMLButtonElement>("[data-back]")!
    .addEventListener("click", () => {
      setModal({ kind: "counter-roll", rolled: modal.counterRoll });
      router.refresh();
    });
  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-prevent-id]")) {
    btn.addEventListener("click", () => {
      // Cancels that enemy's whole counterattack, side effects
      // included (`combat.ts > blockCounterattack`).
      blockCounterattack(router.state, phase, spenderHeroId, btn.dataset.preventId!);
      router.save();
      setModal({ kind: "counter-roll", rolled: modal.counterRoll });
      router.refresh();
    });
  }
}

/**
 * Tiny helper: how many delver tiles does a single counterattacker
 * currently hit on the given outcome? Used by the prevent-pick
 * filter to skip enemies whose counter would whiff anyway.
 */
function perEnemyOffsetsHit(
  state: CampaignState,
  enemy: import("../engine/combat").DamagedEnemySnapshot,
  outcome: import("../engine/combat").CounterAttackOutcome,
): number {
  if (outcome === "miss" && !hasAllClaw(enemy.cardId)) return 0;
  const enc = state.encounter;
  if (!enc) return 0;
  const card = getEnemy(enemy.cardId);
  void card; // already validated existence in the closure caller
  const offsets = counterOffsetsFor(enemy, enemy.facing, outcome);
  let hit = 0;
  for (const off of offsets) {
    const tx = enemy.x + off.dx;
    const ty = enemy.y + off.dy;
    if (getDelversAt(enc, tx, ty).length > 0) hit += 1;
  }
  return hit;
}

/**
 * Apply the shared counter roll. If any shield-bearer is eligible to
 * spend an element to block damage on the bearer's tile (Sol / Lunar
 * Shield ONGOING — `findShieldOpportunities`), open the shield-prompt
 * modal and walk the player through one decision per opportunity
 * BEFORE damage is applied. Otherwise, fall straight through the
 * legacy resolveSharedCounter path.
 *
 * The rule (decided 2026-05-03): shield activations resolve BEFORE
 * `finalizeAttackSession` (which is where pending Level-Up draws are
 * enqueued via `applyKill > applyPendingLevelUps`), so a shield play
 * always precedes any Level-Up modal that the same action would
 * eventually open.
 */
function applySharedCounter(router: Router, counterRoll: number): void {
  const session = getAttackSession();
  if (!session) { setModal(null); router.refresh(); return; }
  const phase = session.sharedCounter;
  if (!phase) { setModal(null); router.refresh(); return; }
  // `weapon-counter-block`: opens BEFORE the shield queue so the
  // player can save an element when the free block alone is enough.
  // Considered when:
  //   - the source weapon's `weapon-counter-block.amount > 0`,
  //   - the source weapon's `weapon-counter-block.count > 0`,
  //   - the counter outcome is not `miss`,
  //   - at least one counterattacker would actually deal damage to
  //     a delver (= `counterBlockCandidates` returns something).
  //
  // Then routed via `weaponCounterBlockDecision`:
  //   - more candidates than the cap          → open the multi-pick
  //                                              prompt (real
  //                                              decision exists),
  //   - candidates fit within the cap          → AUTO-APPLY block
  //                                              to all of them, no
  //                                              prompt (the printed
  //                                              text "Block 1 damage
  //                                              from 1 counterattack"
  //                                              is mandatory, so a
  //                                              no-choice prompt
  //                                              would just be an
  //                                              extra confirmation
  //                                              tap),
  //   - no candidates / no block effect        → straight through to
  //                                              the shield queue.
  //
  // The auto-apply branch was added 2026-05-09 after a Trident
  // gameplay review noted the prompt was firing for single-
  // counterattacker swings — matches the player's expected "ask
  // ONLY when there's a multi-enemy decision" mental model.
  const blockAmt = sessionWeaponCounterBlockAmount(router.state, session);
  const blockCap = sessionWeaponCounterBlockCount(router.state, session);
  if (blockAmt > 0 && blockCap > 0 && counterRoll > 0) {
    // `counterBlockCandidates` gates on `phase.outcome !== "miss"`, but
    // `phase.outcome` is still the default "miss" at this point because
    // `resolveSharedCounter` hasn't run yet. Pre-resolve it now so the
    // candidate check reads the actual roll outcome.
    phase.outcome = counterAttackOutcomeForRoll(counterRoll);
    phase.rolled = counterRoll;
    const candidates = counterBlockCandidates(router.state, session);
    const decision = weaponCounterBlockDecision(candidates, blockCap);
    if (decision.kind === "prompt") {
      setModal({
        kind: "weapon-counter-block-prompt",
        rolled: counterRoll,
        cap: blockCap,
        picked: [],
      });
      router.refresh();
      return;
    }
    if (decision.kind === "auto-apply") {
      proceedToShieldsOrApply(router, session, counterRoll, {
        kind: "block",
        enemyInstanceIds: decision.enemyInstanceIds,
      });
      return;
    }
    // decision.kind === "skip" — no candidates / no block to apply.
    // Falls through to the no-block path below.
  }
  proceedToShieldsOrApply(router, session, counterRoll, undefined);
}

/**
 * Decide what to do with a weapon-counter-block opportunity.
 *
 * Pure (no UI, no router) so the dispatch decision is unit-testable
 * — pinning this routing in tests is the whole point of pulling it
 * out of `applySharedCounter`. The caller (UI) is responsible for
 * actually opening the modal / calling the engine according to the
 * returned discriminant.
 *
 * Three outcomes (see `applySharedCounter` for context):
 *   - `skip`:       no candidates; nothing to apply.
 *   - `auto-apply`: candidates fit within `cap` (the player has no
 *                   real choice — block all of them automatically).
 *                   Returned only when at least one candidate
 *                   exists; the `enemyInstanceIds` payload is the
 *                   full candidate list, in `counterBlockCandidates`
 *                   order.
 *   - `prompt`:     more candidates than `cap` — a real "which to
 *                   block?" decision exists; the UI must open the
 *                   multi-pick modal.
 */
export function weaponCounterBlockDecision(
  candidates: ReadonlyArray<{ enemyInstanceId: string }>,
  cap: number,
):
  | { kind: "skip" }
  | { kind: "auto-apply"; enemyInstanceIds: string[] }
  | { kind: "prompt" } {
  if (candidates.length === 0 || cap <= 0) return { kind: "skip" };
  if (candidates.length <= cap) {
    return { kind: "auto-apply", enemyInstanceIds: candidates.map((c) => c.enemyInstanceId) };
  }
  return { kind: "prompt" };
}

/**
 * Common tail after the (optional) trident-block decision: open the
 * shield queue if any bearer can react (passing the trident-block
 * choice through so the per-bearer "incoming damage" preview reflects
 * the post-block reality), or fast-path apply directly when no shield
 * activations are possible.
 *
 * `weaponCounterBlock = undefined` means "no Trident swing was made"
 * OR "Trident swing was made but the player skipped the prompt" —
 * both reach the engine the same way (no reduction applied).
 */
function proceedToShieldsOrApply(
  router: Router,
  session: AttackSession,
  counterRoll: number,
  weaponCounterBlock: WeaponCounterBlockChoice | undefined,
): void {
  const phase = session.sharedCounter;
  if (!phase) { setModal(null); router.refresh(); return; }
  const outcome = counterAttackOutcomeForRoll(counterRoll);
  // Build the per-enemy block-amount map once and reuse it for both
  // the preview helpers and (eventually) the engine consumer. The
  // helper already handles skip / count-cap / amount=0 → empty map.
  const previewBlockMap = weaponCounterBlockMap(router.state, session, weaponCounterBlock);
  const opportunities = findShieldOpportunities(
    router.state,
    phase.damagedEnemies,
    outcome,
    previewBlockMap,
    counterRoll,
  );
  if (opportunities.length === 0) {
    // Fast path: no shield-bearer can act on this counter. When a
    // Trident block is in play we MUST go through
    // `applyCounterDamageWithShieldChoices` (the legacy
    // resolveSharedCounter path doesn't know about the block); the
    // empty `choices` map is the no-shield equivalent.
    if (weaponCounterBlock) {
      applyCounterDamageWithShieldChoices(
        router.state, session, counterRoll, {}, weaponCounterBlock,
      );
      // Show an acknowledgement popup so the player learns the block
      // happened — without it the damage reduction is invisible.
      const blockAmt = sessionWeaponCounterBlockAmount(router.state, session);
      const srcCard = session.source.kind === "weapon"
        ? getEquipment(session.source.cardId)
        : null;
      setModal({
        kind: "weapon-block-info",
        counterRoll,
        weaponCounterBlock: weaponCounterBlock as
          (typeof weaponCounterBlock) & { kind: "block" },
        blockAmountPerEnemy: blockAmt,
        weaponName: srcCard?.name ?? "Weapon",
      });
      router.refresh();
    } else {
      // No trident block AND no shields → keep the legacy per-offset
      // hit emission (preserves downstream telemetry / tests that
      // read `phase.hits`).
      resolveSharedCounter(router.state, session, counterRoll);
      finalizeAndAdvance(router, session);
    }
    return;
  }
  setModal({
    kind: "shield-prompt",
    counterRoll,
    queue: opportunities,
    cursor: 0,
    choices: {},
    pendingSpends: [],
    weaponCounterBlock,
  });
  router.refresh();
}

/**
 * Common post-action tail: finalize the session (applies deferred
 * kills + on-death rewards + level-up bookkeeping) and then either
 * open the level-up modal (if any draws are pending) or silently
 * clear action state and auto-end-turn-if-eligible. Used by both the
 * counter-resolved path and any auto-skip / no-target paths.
 *
 * Kill animations (XP fly-up + element fly-to-suit-slot) are
 * orchestrated around the finalize/refresh boundary:
 *
 *   1. BEFORE `finalizeAttackSession` we snapshot each dying
 *      enemy tile's viewport rect via `data-enemy-instance` --
 *      this only works while the tile is still rendered, which
 *      is until `enemy.alive = false` fires inside finalize.
 *   2. `finalizeAttackSession` applies the kill rewards (so
 *      `step.killResult.xpGained` / `elementGrants` are populated)
 *      and `advanceAfterAction` re-renders the board (the tile
 *      element is now gone).
 *   3. On the next paint we run `playKillAnimations` against the
 *      snapshot -- the fly tokens spawn at the captured source
 *      coords and animate toward the still-live target elements
 *      (`.xp-pill-value`, `.suit-slot--el-*`).
 */
const BOSS_DEATH_ANIM_MS = 3000;

function hasBossKill(session: AttackSession): boolean {
  return session.steps.some((s) => s.killed && s.enemyInstanceId === "boss");
}

function playBossDeathAnimation(): Promise<void> {
  const bossEl = document.querySelector<HTMLElement>('[data-enemy-instance="boss"]');
  if (!bossEl) return Promise.resolve();
  bossEl.classList.add("boss-death-fx");
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, BOSS_DEATH_ANIM_MS);
  });
}

function doFinalizeAndAdvance(router: Router, session: AttackSession): void {
  const killSeeds = snapshotKillSites(session);
  // CREATURE PART pickups are now per-pick player choices (see
  // `engine/creatureParts.ts`), so the wallet-fly animation
  // moves to the `creature-part-pick` modal handler — fired
  // ONCE per resolved pick with the attacker's tile + chosen
  // wallet. `finalizeAttackSession` returns `creaturePartsEnqueued`
  // here only as a debug breadcrumb / future-hook handle — the
  // animation is intentionally NOT triggered at finalize time.
  finalizeAttackSession(router.state, session);
  advanceAfterAction(router);
  if (killSeeds.length > 0) {
    requestAnimationFrame(() => playKillAnimations(killSeeds, session));
  }
}

function finalizeAndAdvance(router: Router, session: AttackSession): void {
  if (hasBossKill(session)) {
    // Dismiss the counter-roll panel immediately so it isn't visible
    // while the death animation plays.
    setModal(null);
    router.refresh();
    void playBossDeathAnimation().then(() => doFinalizeAndAdvance(router, session));
    return;
  }
  doFinalizeAndAdvance(router, session);
}

// --- Sol / Lunar Shield prompt -----------------------------------------
// Walks the per-bearer opportunity queue produced by
// `findShieldOpportunities` one entry at a time. Each prompt offers
// Skip + one Spend button per non-empty element kind in the bearer's
// bag. The bonusElement (radiance for Sol, void for Lunar) gets a
// distinguished label showing the higher block amount + heal hint.
//
// Once `cursor` walks past the last opportunity we hand the recorded
// choices to `applyCounterDamageWithShieldChoices`, which mutates HP
// and element bags in one shot, and then proceed into the existing
// `finalizeAndAdvance` pipeline (kills → level-up → maybe end-turn).

/**
 * Informational popup shown when a weapon (e.g. Shift Trident) auto-
 * blocked damage from a counterattack and there were no shield
 * activations to queue. The player taps OK to continue; finalisation
 * happens then so the popup gives them a chance to see what happened
 * before the turn advances.
 */
function renderWeaponBlockInfoModal(
  host: HTMLDivElement,
  router: Router,
  modal: Extract<Modal, { kind: "weapon-block-info" }>,
): void {
  const session = getAttackSession();
  const totalBlocked =
    modal.blockAmountPerEnemy * modal.weaponCounterBlock.enemyInstanceIds.length;

  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body weapon-block-info-body">
      <h3>Damage Blocked</h3>
      <p class="weapon-block-info-summary">
        <strong>${escapeHtml(modal.weaponName)}</strong> blocked
        <strong>${totalBlocked}</strong> damage from the counterattack.
      </p>
      <div class="action-menu-options">
        <button class="action-option action-option--primary" data-ok>
          <span class="action-option-label">OK</span>
        </button>
      </div>
    </div>
  `;

  host.querySelector<HTMLButtonElement>("[data-ok]")!
    .addEventListener("click", () => {
      setModal(null);
      if (session) finalizeAndAdvance(router, session);
      else router.refresh();
    });
}

/**
 * Shared rendering body for both shield-prompt modal kinds
 * (counter-resolution and parting-shot). Pulls every UI bit that
 * works the same regardless of damage source — the per-delver
 * "before → after" rows, the multi-spend forecast, the cap pill,
 * the spend buttons (with bag-count + at-cap disabling), the
 * undo + commit footer.
 *
 * Caller wires the kind-specific bits via `opts`:
 *   - `weaponBlockNote`: HTML string injected just under the
 *     header (Trident/Shockwave block notice for counter; empty
 *     for parting-shot).
 *   - `subline`: replaces the standard "Block up to N
 *     counterattacks..." cap line. Counter uses the default;
 *     parting-shot supplies a parting-shot-flavoured variant.
 *   - `onCommit / onUndo / onSpend`: callbacks the rendered
 *     buttons fire. Each callback is responsible for re-issuing
 *     `setModal` with the appropriate `kind` and refreshing.
 */
interface ShieldPromptViewOpts {
  weaponBlockNote: string;
  subline: string | null;
  onCommit: () => void;
  onUndo: () => void;
  onSpend: (element: Element) => void;
}

function renderShieldPromptCommon(
  host: HTMLDivElement,
  router: Router,
  op: ShieldOpportunity,
  pendingSpends: readonly Element[],
  cursor: number,
  queueLength: number,
  opts: ShieldPromptViewOpts,
): void {
  const bearer = getHero(op.shieldBearerHeroId);
  const card = getEquipment(op.shieldCardId);
  const bonus = op.bonusElement;

  // Multi-spend forecast: walk `pendingSpends` in click order and
  // simulate the engine's per-activation block + overblock-heal so
  // the modal can render running totals. This MUST stay in lockstep
  // with `applyShieldChoicesToDamageMap`'s for-each loop — the test
  // suite pins both halves.
  const remainingByDelver = new Map<string, number>(
    op.protectedDelvers.map((d) => [d.heroId, d.incomingDamage]),
  );
  const elementsRemaining: Partial<Record<Element, number>> = {};
  for (const el of op.availableElements) {
    elementsRemaining[el] = (elementsRemaining[el] ?? 0) + 1;
  }
  // `availableElements` lists ONE entry per kind (count > 0); the
  // bearer's actual bag may carry more than 1 of a kind, so re-read
  // the bag here for accurate per-kind counts.
  const liveBag = router.state.elements[op.shieldBearerHeroId] ?? {};
  for (const el of Object.keys(liveBag) as Element[]) {
    const n = liveBag[el] ?? 0;
    if (n > 0) elementsRemaining[el] = n;
    else delete elementsRemaining[el];
  }
  let overblockHeal = 0;
  for (const spentEl of pendingSpends) {
    const have = elementsRemaining[spentEl] ?? 0;
    if (have <= 0) continue;
    elementsRemaining[spentEl] = have - 1;
    if ((elementsRemaining[spentEl] ?? 0) <= 0) delete elementsRemaining[spentEl];
    const blockAmount = spentEl === bonus ? op.bonusBlock : op.baseBlock;
    for (const [delverId, dmg] of remainingByDelver) {
      if (dmg <= 0) continue;
      const blocked = Math.min(dmg, blockAmount);
      remainingByDelver.set(delverId, dmg - blocked);
      overblockHeal += (blockAmount - blocked) * op.healPerOverblock;
    }
  }
  const totalRemainingDamage = [...remainingByDelver.values()]
    .reduce((acc, d) => acc + Math.max(0, d), 0);

  const protectedRows = [...op.protectedDelvers]
    .map((d) => ({ ...d, hero: getHero(d.heroId) }))
    .sort((a, b) => (a.hero.suit === "mind" ? 0 : 1) - (b.hero.suit === "mind" ? 0 : 1))
    .map(({ hero, heroId, incomingDamage }) => {
      const suit = hero.suit === "mind" ? "Mind" : "Body";
      const remaining = Math.max(0, remainingByDelver.get(heroId) ?? 0);
      const reduced = pendingSpends.length > 0 && remaining !== incomingDamage;
      const label = reduced
        ? `<span class="muted"><s>${incomingDamage}</s></span> &rarr; <strong>${remaining}</strong> incoming`
        : `${incomingDamage} incoming`;
      return `<div class="counter-breakdown-line">${suit} Delver: ${label}</div>`;
    })
    .join("");

  const cap = op.maxActivations;
  const usedActivations = pendingSpends.length;
  const atCap = usedActivations >= cap;

  let spendsSummary = "";
  if (pendingSpends.length > 0) {
    const labels = pendingSpends
      .map((el) => escapeHtml(el))
      .join(", ");
    const healPart = overblockHeal > 0
      ? ` <span class="shield-prompt-heal-hint">(+${overblockHeal} HP heal)</span>`
      : "";
    spendsSummary = `
      <div class="shield-prompt-spends-row small">
        <span class="muted">Activations queued <span class="shield-prompt-cap-pill">${usedActivations}/${cap}</span>:</span>
        <strong>${labels}</strong>${healPart}
        <button class="btn btn--small btn--ghost shield-prompt-undo" data-undo>Undo last</button>
      </div>`;
  }

  const elementsForButtons = (Object.keys(elementsRemaining) as Element[])
    .filter((el) => (elementsRemaining[el] ?? 0) > 0)
    .sort();
  const spendButtons = elementsForButtons
    .map((el) => {
      const isBonus = el === bonus;
      const block = isBonus ? op.bonusBlock : op.baseBlock;
      const elLabel = escapeHtml(el);
      const remaining = elementsRemaining[el] ?? 0;
      const blockLabel = isBonus
        ? `block ${block} <span class="muted">(heal ${op.healPerOverblock} per overblock)</span>`
        : `block ${block}`;
      const disabledAttr = atCap ? " disabled" : "";
      const titleAttr = atCap
        ? ` title="Cap reached: 1 shield activation per counterattacker (${cap})."`
        : "";
      return `
        <button class="action-option shield-prompt-spend ${isBonus ? "shield-prompt-spend--bonus" : ""}"
                data-spend="${elLabel}"${disabledAttr}${titleAttr}>
          <span class="action-option-label">Spend ${elLabel} <span class="shield-prompt-bag-pill">x${remaining}</span></span>
          <span class="action-option-detail small muted">${blockLabel}</span>
        </button>
      `;
    })
    .join("");

  const queuePill = queueLength > 1
    ? `<span class="level-up-queue-pill">${cursor + 1} / ${queueLength}</span>`
    : "";

  const hasPending = pendingSpends.length > 0;
  const commitLabel = hasPending
    ? (totalRemainingDamage === 0
        ? `Done <span class="muted">(no damage taken)</span>`
        : "Done")
    : "Skip";
  const commitDetail = hasPending
    ? "Commit the queued shield activations."
    : "Take the damage as shown.";

  const sublineHtml = opts.subline ?? (cap === 1
    ? `Block up to <strong>1</strong> counterattack on this tile (1 activation per counterattacker).`
    : `Block up to <strong>${cap}</strong> counterattacks on this tile (1 activation per counterattacker).`);

  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body shield-prompt-body">
      <h3>${escapeHtml(card.name)} ${queuePill}</h3>
      ${opts.weaponBlockNote}
      <p class="small muted">
        <strong class="turn-${bearer.suit}">${escapeHtml(bearer.suit === "mind" ? "Mind Delver" : "Body Delver")}</strong>
        - ${sublineHtml}
      </p>
      <div class="counter-breakdown">${protectedRows}</div>
      ${spendsSummary}
      <div class="action-menu-options">
        <button class="action-option shield-prompt-commit" data-commit>
          <span class="action-option-label">${commitLabel}</span>
          <span class="action-option-detail small muted">${commitDetail}</span>
        </button>
        ${spendButtons}
      </div>
    </div>
  `;

  host.querySelector<HTMLButtonElement>("[data-commit]")!
    .addEventListener("click", () => opts.onCommit());
  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-spend]")) {
    btn.addEventListener("click", () => {
      const element = btn.dataset.spend as Element;
      opts.onSpend(element);
    });
  }
  const undoBtn = host.querySelector<HTMLButtonElement>("[data-undo]");
  if (undoBtn) undoBtn.addEventListener("click", () => opts.onUndo());
}

function renderShieldPromptModal(
  host: HTMLDivElement,
  router: Router,
  modal: Extract<Modal, { kind: "shield-prompt" }>,
): void {
  const op = modal.queue[modal.cursor];
  if (!op) {
    // Online relay: the other player answered the last bearer and handed
    // the prompt back. Only the flow owner (who holds the attack session)
    // finishes it; the other client shows nothing until the relay ends.
    if (modal.cursor >= modal.queue.length && modal.queue.length > 0) {
      host.innerHTML = "";
      if (isRelayedPromptOwner()) {
        queueMicrotask(() => {
          if (getModal() !== modal) return;
          finishShieldPrompt(router, modal, modal.choices);
        });
      }
      return;
    }
    setModal(null);
    router.refresh();
    return;
  }

  // Counter-specific weapon-counter-block notice (Trident / Shockwave
  // pre-block already applied before this modal opened).
  let weaponBlockNote = "";
  if (modal.weaponCounterBlock?.kind === "block") {
    const session = getAttackSession();
    if (session) {
      const blockAmt = sessionWeaponCounterBlockAmount(router.state, session);
      const totalBlocked = blockAmt * modal.weaponCounterBlock.enemyInstanceIds.length;
      const srcCard = session.source.kind === "weapon"
        ? getEquipment(session.source.cardId)
        : null;
      const srcName = srcCard ? escapeHtml(srcCard.name) : "weapon";
      weaponBlockNote = `
        <div class="weapon-block-note">
          <span class="weapon-block-note-icon">🛡</span>
          <span><strong>${srcName}</strong> already blocked <strong>${totalBlocked}</strong> damage (shown above is post-block)</span>
        </div>`;
    }
  }

  renderShieldPromptCommon(host, router, op, modal.pendingSpends, modal.cursor, modal.queue.length, {
    weaponBlockNote,
    subline: null, // uses default counter-flavoured cap subline
    onCommit: () => commitShieldChoice(router, modal),
    onUndo: () => undoShieldSpend(router, modal),
    onSpend: (el) => queueShieldSpend(router, modal, el),
  });
}

function queueShieldSpend(
  router: Router,
  modal: Extract<Modal, { kind: "shield-prompt" }>,
  element: Element,
): void {
  setModal({
    kind: "shield-prompt",
    counterRoll: modal.counterRoll,
    queue: modal.queue,
    cursor: modal.cursor,
    choices: modal.choices,
    pendingSpends: [...modal.pendingSpends, element],
    weaponCounterBlock: modal.weaponCounterBlock,
  });
  router.refresh();
}

function undoShieldSpend(
  router: Router,
  modal: Extract<Modal, { kind: "shield-prompt" }>,
): void {
  if (modal.pendingSpends.length === 0) return;
  setModal({
    kind: "shield-prompt",
    counterRoll: modal.counterRoll,
    queue: modal.queue,
    cursor: modal.cursor,
    choices: modal.choices,
    pendingSpends: modal.pendingSpends.slice(0, -1),
    weaponCounterBlock: modal.weaponCounterBlock,
  });
  router.refresh();
}

function commitShieldChoice(
  router: Router,
  modal: Extract<Modal, { kind: "shield-prompt" }>,
): void {
  const op = modal.queue[modal.cursor];
  if (!op) { setModal(null); router.refresh(); return; }
  const choice: ShieldChoice = modal.pendingSpends.length === 0
    ? { kind: "skip" }
    : { kind: "spend", elements: modal.pendingSpends };
  recordShieldChoice(router, modal, op.shieldBearerHeroId, choice);
}

function recordShieldChoice(
  router: Router,
  modal: Extract<Modal, { kind: "shield-prompt" }>,
  bearerId: string,
  choice: ShieldChoice,
): void {
  const choices = { ...modal.choices, [bearerId]: choice };
  const nextCursor = modal.cursor + 1;
  // Online: a bearer answering a relayed prompt only records the choice
  // and hands the prompt back (cursor past the end); the flow owner
  // finishes it (see `renderShieldPromptModal`).
  if (nextCursor < modal.queue.length || !isRelayedPromptOwner()) {
    setModal({
      kind: "shield-prompt",
      counterRoll: modal.counterRoll,
      queue: modal.queue,
      cursor: nextCursor,
      choices,
      pendingSpends: [],
      weaponCounterBlock: modal.weaponCounterBlock,
    });
    router.refresh();
    return;
  }
  finishShieldPrompt(router, modal, choices);
}

/** All shield prompts answered: commit counter damage with the recorded
 *  choices (and the optional trident block carried from
 *  `proceedToShieldsOrApply`), then the standard finalize + level-up tail. */
function finishShieldPrompt(
  router: Router,
  modal: Extract<Modal, { kind: "shield-prompt" }>,
  choices: Record<string, ShieldChoice>,
): void {
  const session = getAttackSession();
  if (!session) { setModal(null); router.refresh(); return; }
  applyCounterDamageWithShieldChoices(
    router.state, session, modal.counterRoll, choices, modal.weaponCounterBlock,
  );
  finalizeAndAdvance(router, session);
}

// --- Parting-shot shield prompt -----------------------------------------
//
// Mirrors the counter-side `shield-prompt` flow, but drives off the
// `parting-shot-shield-prompt` modal kind and commits via the
// `engine/wave.ts > resolvePartingShot` path with `shieldChoices` set.
// Re-uses `renderShieldPromptCommon` so both modal kinds present an
// identical multi-spend UI — the only differences are:
//   - no `weaponBlockNote` (parting shots don't carry a Trident pre-block)
//   - parting-shot-flavoured cap subline ("Block up to 1 parting shot")
//
// The commit handler imports `resolvePartingShot` lazily to avoid a
// circular import between ActionResolution and engine/wave.

function renderPartingShotShieldPromptModal(
  host: HTMLDivElement,
  router: Router,
  modal: Extract<Modal, { kind: "parting-shot-shield-prompt" }>,
): void {
  const op = modal.queue[modal.cursor];
  if (!op) {
    // Online relay handed back past the last bearer — see the counter
    // shield prompt above.
    if (modal.cursor >= modal.queue.length && modal.queue.length > 0) {
      host.innerHTML = "";
      if (isRelayedPromptOwner()) {
        queueMicrotask(() => {
          if (getModal() !== modal) return;
          finishPartingShotShieldPrompt(router, modal, modal.choices);
        });
      }
      return;
    }
    setModal(null);
    router.refresh();
    return;
  }
  const cap = op.maxActivations;
  const subline = cap === 1
    ? `Block this <strong>parting shot</strong> on your tile (1 activation per parting shot).`
    : `Block up to <strong>${cap}</strong> parting shots on this tile.`;
  renderShieldPromptCommon(host, router, op, modal.pendingSpends, modal.cursor, modal.queue.length, {
    weaponBlockNote: "",
    subline,
    onCommit: () => commitPartingShotShieldChoice(router, modal),
    onUndo: () => undoPartingShotShieldSpend(router, modal),
    onSpend: (el) => queuePartingShotShieldSpend(router, modal, el),
  });
}

function queuePartingShotShieldSpend(
  router: Router,
  modal: Extract<Modal, { kind: "parting-shot-shield-prompt" }>,
  element: Element,
): void {
  setModal({
    kind: "parting-shot-shield-prompt",
    queue: modal.queue,
    cursor: modal.cursor,
    choices: modal.choices,
    pendingSpends: [...modal.pendingSpends, element],
    partingShotParams: modal.partingShotParams,
  });
  router.refresh();
}

function undoPartingShotShieldSpend(
  router: Router,
  modal: Extract<Modal, { kind: "parting-shot-shield-prompt" }>,
): void {
  if (modal.pendingSpends.length === 0) return;
  setModal({
    kind: "parting-shot-shield-prompt",
    queue: modal.queue,
    cursor: modal.cursor,
    choices: modal.choices,
    pendingSpends: modal.pendingSpends.slice(0, -1),
    partingShotParams: modal.partingShotParams,
  });
  router.refresh();
}

function commitPartingShotShieldChoice(
  router: Router,
  modal: Extract<Modal, { kind: "parting-shot-shield-prompt" }>,
): void {
  const op = modal.queue[modal.cursor];
  if (!op) { setModal(null); router.refresh(); return; }
  const choice: ShieldChoice = modal.pendingSpends.length === 0
    ? { kind: "skip" }
    : { kind: "spend", elements: modal.pendingSpends };
  const choices = { ...modal.choices, [op.shieldBearerHeroId]: choice };
  const nextCursor = modal.cursor + 1;
  if (nextCursor < modal.queue.length || !isRelayedPromptOwner()) {
    setModal({
      kind: "parting-shot-shield-prompt",
      queue: modal.queue,
      cursor: nextCursor,
      choices,
      pendingSpends: [],
      partingShotParams: modal.partingShotParams,
    });
    router.refresh();
    return;
  }
  finishPartingShotShieldPrompt(router, modal, choices);
}

/** Queue cleared: close modal, fire the engine resolve with the
 *  accumulated shield choices, push the result into the parting-shot
 *  log, and let the WavePhases screen re-render. */
function finishPartingShotShieldPrompt(
  router: Router,
  modal: Extract<Modal, { kind: "parting-shot-shield-prompt" }>,
  choices: Record<string, ShieldChoice>,
): void {
  setModal(null);
  const result = resolvePartingShot(router.state, {
    ...(modal.partingShotParams.chosenDelverId
      ? { chosenDelverId: modal.partingShotParams.chosenDelverId }
      : {}),
    shieldChoices: choices,
  });
  if (result) pushPartingShotLog(result);
  router.save();
}

/**
 * After any action resolves, walk the post-action prompt queue in
 * priority order:
 *
 *   1. Pending Level-Up draws (rulebook p24) — open the Level-Up
 *      modal first so the player resolves XP rewards from the kill
 *      that triggered the draw before any chained side-effects.
 *   2. Soulshift Sword `repeat-on-kill` — if the just-finished
 *      attack session killed at least one enemy with a weapon that
 *      has a `repeat-on-kill` effect (currently only `body-sword-r1`),
 *      open the Soulshift roll modal so the player can chain a bonus
 *      swing.
 *   3. Otherwise wipe action state and auto-end the turn if movement
 *      + action are both spent.
 *
 * Re-entered from {@link LevelUpModal.onPickChoice} after the player
 * clears the level-up queue, so the soulshift check happens AFTER all
 * level-ups have been picked even though the level-up modal opened
 * first. Also re-entered after a Soulshift bonus swing finalizes —
 * which lets chains roll forever (each chain link runs the same
 * pipeline, so a kill on swing N+1 will queue ANOTHER soulshift
 * prompt automatically).
 */
export function advanceAfterAction(router: Router): void {
  // Online: a player who just resolved a choice for their own delver
  // during the other player's flow stops here; the flow owner's client
  // continues it once the shared state arrives (BoardScreen's
  // remote-applied listener calls back into this function).
  if (!onlineIsActorNow()) {
    setModal(null);
    router.refresh();
    return;
  }
  // Post-action modal queue (FIFO blocking prompts):
  //   1. Pending element-pick prompts (Elemental OS IMMEDIATELY,
  //      enqueued by `applyLevelUpChoice` for first-time gains; the
  //      ONGOING flavor only fires at End Wave open and is gated
  //      separately in WavePhases). Keeping this BEFORE the level-up
  //      check is important because `applyLevelUpChoice` could enqueue
  //      one DURING the current level-up flow, and the player should
  //      pick that element before proceeding to the next pending draw.
  //   2. Pending equipment die rolls (Supercharger / Battery / etc;
  //      same provenance as element picks — fired from
  //      `applyLevelUpChoice` on first-gain — and gated for the
  //      same reason).
  //   3. Pending Level-Up draws.
  //   4. Soulshift bonus-swing prompt (per-kill, weapon-source only).
  //   5. Default — clear action state and maybe auto-advance to next
  //      turn.
  // Opinion-card rank picks fire BEFORE element-pick / equipment-roll
  // gates because they're a quest-start passive gate — the player
  // mustn't be allowed to take any action / advance any turn until
  // every Xavier pick is resolved (the bumps affect hand
  // composition + combat math from turn 1).
  if (hasPendingOpinionRankPicks(router.state)) {
    setModal({ kind: "opinion-rank-pick" });
    router.refresh();
    return;
  }
  if ((router.state.encounter?.pendingRitualPicks.length ?? 0) > 0) {
    setModal({ kind: "ritual-pick" });
    router.refresh();
    return;
  }
  if (hasPendingElementChoices(router.state)) {
    setModal({ kind: "element-pick" });
    router.refresh();
    return;
  }
  if (hasPendingEquipmentRolls(router.state)) {
    const head = peekNextPendingEquipmentRoll(router.state);
    if (head) {
      setModal({
        kind: "equipment-roll",
        heroId: head.heroId,
        cardId: head.cardId,
      });
      router.refresh();
      return;
    }
  }
  // XP die rolls ("Gain 1 [die] XP" on-death rewards) resolve BEFORE
  // pending Level-Up draws so all XP from the kill batch is banked
  // before the player starts drawing — `applyXpRoll` can itself push
  // more draws onto the queue when the rolled XP crosses a level
  // threshold.
  if (hasPendingXpRolls(router.state)) {
    const head = peekNextPendingXpRoll(router.state);
    if (head) {
      setModal({
        kind: "xp-roll",
        heroId: head.heroId,
        enemyCardId: head.enemyCardId,
      });
      router.refresh();
      return;
    }
  }
  if (hasPendingLevelUpDraws(router.state)) {
    setModal({ kind: "level-up" });
    router.refresh();
    return;
  }
  // CREATURE PART picks (MINION vs BOSS) from Gauntlet
  // `collect-creature-part` swings. Resolved AFTER level-up
  // draws so a kill that triggers BOTH (e.g. R3 Surge Claw
  // kills the last enemy on its chain → applyPendingLevelUps
  // queues a draw + the post-effect enqueues 2 picks) lets the
  // player resolve the bigger XP-reward decision first, then
  // pick parts. Per-pick FIFO; the modal handler re-runs
  // `advanceAfterAction` after each pick so a count-of-N swing
  // walks through all N before falling back to soulshift/beam
  // /default tails.
  if (hasPendingCreaturePartChoices(router.state)) {
    setModal({ kind: "creature-part-pick" });
    router.refresh();
    return;
  }
  const session = getAttackSession();
  if (session && attackSessionTriggersSoulshiftRoll(router.state, session)) {
    if (session.source.kind === "weapon") {
      setModal({
        kind: "soulshift-roll",
        slotIdx: session.source.slotIdx,
        cardId: session.source.cardId,
      });
      router.refresh();
      return;
    }
  }
  // Scorchline Beam (Body R2-R5) repeat-attack prompt. Fires after
  // the Soulshift check because Soulshift's `repeat-on-kill` is a
  // one-off kill-conditioned chain that we surface immediately;
  // Beam's repeat is a guaranteed bonus the player can spread out
  // however they like and is fine to come second. (No card today
  // carries BOTH effects — but if one ever does, kill-conditioned
  // wins.)
  if (session && attackSessionTriggersBeamRepeat(router.state, session)) {
    if (session.source.kind === "weapon") {
      const remaining =
        router.state.encounter?.beamRepeatsRemaining[session.attackerId] ?? 0;
      setModal({
        kind: "beam-repeat-prompt",
        slotIdx: session.source.slotIdx,
        cardId: session.source.cardId,
        remaining,
      });
      router.refresh();
      return;
    }
  }
  setModal(null);
  clearActionState();
  // After-action snapshot — captures the state the player will see
  // once advanceAfterAction returns. Useful for diagnosing "I clicked
  // X, the engine said ok, but the UI shows Y": cross-reference this
  // ts with the next BoardScreen render to see whether anything
  // mutated state in between.
  logEvent("state.after-advance", {
    heroId: router.state.currentDelverId,
    ap: snapHeroAp(router.state, router.state.currentDelverId),
    slots: snapSlots(router.state, router.state.currentDelverId),
    turn: snapTurn(router.state, router.state.currentDelverId),
    elements: snapElements(router.state, router.state.currentDelverId),
  });
  if (!maybeAutoEndTurn(router)) router.save();
  router.refresh();
}

// --- Slip Strider Boots (Mind) — rotate-direction modal --------------

/**
 * Three-button modal that closes the Mind Boots ONGOING flow: pick
 * 90° / 180° / 270° clockwise (or Cancel). Engine call
 * (`rotateAdjacentEnemy`) lives inline because it's a one-shot.
 *
 * Per design clarification 2026-05-24: cost is 2 movement for the
 * single activation regardless of how far the enemy turns. 270° CW
 * is equivalent to 90° CCW, so the three options cover every
 * meaningful reorientation.
 *
 * Cancel returns the player to "armed but no enemy picked" — they
 * could either pick a different enemy or hit the topbar Cancel-armed
 * button to back all the way out without spending movement. Cancel
 * specifically does NOT clear the armed state because a stray miss-
 * click would otherwise be punishing.
 */
function renderBootsRotateDirectionModal(
  host: HTMLDivElement,
  router: Router,
  modal: Extract<Modal, { kind: "boots-rotate-direction" }>,
): void {
  const enc = router.state.encounter;
  const enemy = enc ? getEnemyInstance(enc, modal.targetEnemyId) : null;
  if (!enemy) {
    // Enemy vanished (e.g. saved game with stale id). Bail cleanly.
    setModal(null);
    setArmedAbility(null);
    return;
  }
  const enemyName = getEnemy(enemy.cardId).name;
  const heroIdNow = router.state.currentDelverId;
  const modesNow = bootsModes(router.state, heroIdNow);
  const costNow = bootsOngoingCost(router.state, heroIdNow);
  const bothModes = modesNow.canMove && modesNow.canRotate;
  const moveInsteadHtml = bothModes
    ? `<button class="action-option" data-move-instead>
         <span class="action-option-label">Move this enemy instead</span>
         <span class="action-option-detail small muted">Cyclone Boots: pick a destination tile</span>
       </button>`
    : "";
  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body">
      <h3>${bothModes ? "Cyclone Boots" : "Slip Strider Boots"}</h3>
      <p class="small muted">Rotate <strong>${escapeHtml(enemyName)}</strong> - costs ${costNow} movement.</p>
      <div class="action-menu-options">
        <button class="action-option" data-rotate-amount="90">
          <span class="action-option-label">Rotate 90&deg;</span>
          <span class="action-option-detail small muted">quarter turn clockwise</span>
        </button>
        <button class="action-option" data-rotate-amount="180">
          <span class="action-option-label">Rotate 180&deg;</span>
          <span class="action-option-detail small muted">half turn (faces opposite)</span>
        </button>
        <button class="action-option" data-rotate-amount="270">
          <span class="action-option-label">Rotate 270&deg;</span>
          <span class="action-option-detail small muted">three-quarter turn (= 90&deg; counter-clockwise)</span>
        </button>
      </div>
      ${moveInsteadHtml}
      <div class="modal-footer">
        <button class="btn btn--small btn--ghost" data-cancel>Pick a different enemy</button>
      </div>
    </div>
  `;

  // Cyclone Boots dual mode: swap to the standard move flow for the
  // SAME target enemy (destination overlay paints on refresh).
  host.querySelector<HTMLButtonElement>("[data-move-instead]")
    ?.addEventListener("click", () => {
      logEvent("click.boots-move-instead", { heroId: heroIdNow, enemyId: modal.targetEnemyId });
      setArmedAbility({ kind: "boots-move-enemy", targetEnemyId: modal.targetEnemyId });
      setModal(null);
      router.refresh();
    });

  host.querySelector<HTMLButtonElement>("[data-cancel]")!
    .addEventListener("click", () => {
      // Drop back to Phase A: armed, awaiting an adjacent-enemy pick.
      setArmedAbility({ kind: "boots-rotate-enemy" });
      setModal(null);
      router.refresh();
    });

  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-rotate-amount]")) {
    btn.addEventListener("click", () => {
      const amount = Number(btn.dataset.rotateAmount) as RotateAmount;
      const r = rotateAdjacentEnemy(
        router.state,
        router.state.currentDelverId,
        modal.targetEnemyId,
        amount,
      );
      if (!r.ok) { console.warn("rotateAdjacentEnemy rejected:", r.reason); return; }
      setArmedAbility(null);
      setModal(null);
      // Boots spends movement POINTS only — `movementUsedThisTurn`
      // stays false so the player can chain another rotate or fall
      // back to a normal move with whatever budget is left. Auto-end
      // can't fire here for the same reason; explicit "End turn"
      // closes out the turn once the player is done.
      if (!maybeAutoEndTurn(router)) router.save();
    });
  }
}

// --- Soulshift Sword (Body) — repeat-on-kill modal --------------------

/**
 * Two-stage modal driving the Soulshift Sword `repeat-on-kill` loop:
 *
 *   Stage A (`rolled === undefined`)
 *     A single "Roll die" button. Clicking rolls a fresh d6, stores
 *     the result on the modal, and re-renders into Stage B.
 *
 *   Stage B (`rolled` set)
 *     Show the rolled value plus the outcome computed by
 *     {@link classifySoulshiftRoll}:
 *       - `no-repeat` (1-3, OR 4-6 with no adjacent live enemies):
 *         single "Continue" button that closes the modal and falls
 *         through to `advanceAfterAction`.
 *       - `repeat-available` (4-6 with at least one adjacent live
 *         enemy): "Skip" + "Swing again" buttons. Skip falls through
 *         the same as no-repeat. Swing again arms the
 *         `soulshift-repeat-target` picker (closes the modal so the
 *         board overlays show) — the click handler in `onTargetClick`
 *         then dispatches the bonus swing via
 *         `useWeaponAbility(..., { freeRepeat: true })`.
 *
 * The modal stays in front of the board overlay layer so the player
 * can still see the bearer's tile and surrounding enemies while
 * deciding. The "Skip" button is offered even on `no-repeat` outcomes
 * (single-button form) for consistency: the player always closes the
 * prompt explicitly.
 */
function renderSoulshiftRollModal(
  host: HTMLDivElement,
  router: Router,
  modal: Extract<Modal, { kind: "soulshift-roll" }>,
): void {
  const card = getEquipment(modal.cardId);
  const cardName = card.name;
  const heroId = router.state.currentDelverId;

  // Stage A: pre-roll. Show the trigger context + a single Roll button.
  if (modal.rolled === undefined) {
    host.innerHTML = `
      <div class="action-menu-backdrop"></div>
      <div class="action-menu-body">
        <h3>${escapeHtml(cardName)}</h3>
        <p class="small muted">Target died - roll a die. On <strong>4-6</strong>, you may swing again at an adjacent enemy.</p>
        <div class="action-menu-options">
          <button class="action-option" data-roll>
            <span class="action-option-label">Roll die</span>
          </button>
        </div>
      </div>
    `;
    host.querySelector<HTMLButtonElement>("[data-roll]")!
      .addEventListener("click", () => {
        const rolled = rollD6();
        setModal({ ...modal, rolled });
        markFreshRoll("soulshift-roll");
        router.refresh();
      });
    return;
  }

  // Stage B: post-roll. Branch on classify outcome.
  //
  // Cycle gate: the branch (no-repeat vs swing-again) IS the result
  // — picking either template would spoil it. So while the cycle is
  // still spinning, render a minimal "rolling..." view (header + a
  // big die square that the cycle drives), and let the cycle's
  // onDone refresh us into the actual branch template.
  const isFreshRoll = consumeFreshRoll("soulshift-roll");
  if (isFreshRoll) {
    host.innerHTML = `
      <div class="action-menu-backdrop"></div>
      <div class="action-menu-body">
        <h3>${escapeHtml(cardName)}</h3>
        <div class="die-roll-stage die-roll-stage--result">
          <div class="die-roll-result die-roll-result--effective soulshift-roll-cycling" aria-live="polite">${modal.rolled}</div>
        </div>
      </div>
    `;
    playDieRollCycle(
      host.querySelector<HTMLElement>(".soulshift-roll-cycling"),
      modal.rolled,
      "soulshift-roll",
      () => router.refresh(),
    );
    return;
  }

  const result = classifySoulshiftRoll(router.state, heroId, modal.rolled);
  const rolledLabel = `<strong class="soulshift-roll-value">${result.rolled}</strong>`;

  if (result.outcome === "no-repeat") {
    // Either the roll missed (1-3) or no adjacent live targets to
    // chain into. Single Continue button closes and advances.
    const reason = result.rolled <= 3
      ? `Rolled ${rolledLabel} - no repeat.`
      : `Rolled ${rolledLabel} - no adjacent enemy to repeat against.`;
    host.innerHTML = `
      <div class="action-menu-backdrop"></div>
      <div class="action-menu-body">
        <h3>${escapeHtml(cardName)}</h3>
        <p class="small muted">${reason}</p>
        <div class="modal-footer">
          <button class="btn btn--small" data-continue>Continue</button>
        </div>
      </div>
    `;
    host.querySelector<HTMLButtonElement>("[data-continue]")!
      .addEventListener("click", () => {
        // Close the modal and fall back into the standard tail.
        // `advanceAfterAction` will clear action state and fire the
        // auto-end-turn gate as appropriate.
        setModal(null);
        clearActionState();
        if (!maybeAutoEndTurn(router)) router.save();
        router.refresh();
      });
    return;
  }

  // Stage B, repeat-available: 4-6 + at least one adjacent live enemy.
  const targetCount = result.candidates.length;
  const targetLabel = targetCount === 1 ? "1 adjacent target" : `${targetCount} adjacent targets`;
  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body">
      <h3>${escapeHtml(cardName)}</h3>
      <p class="small muted">Rolled ${rolledLabel} - swing again? (${escapeHtml(targetLabel)})</p>
      <div class="action-menu-options">
        <button class="action-option" data-swing>
          <span class="action-option-label">Swing again</span>
          <span class="action-option-detail small muted">Pick an adjacent enemy</span>
        </button>
      </div>
      <div class="modal-footer">
        <button class="btn btn--small btn--ghost" data-skip>Skip</button>
      </div>
    </div>
  `;

  host.querySelector<HTMLButtonElement>("[data-skip]")!
    .addEventListener("click", () => {
      setModal(null);
      clearActionState();
      if (!maybeAutoEndTurn(router)) router.save();
      router.refresh();
    });

  host.querySelector<HTMLButtonElement>("[data-swing]")!
    .addEventListener("click", () => {
      // Arm the picker; close the modal so the board overlays render.
      // Note we leave the attack session in uiState so the active
      // hand-panel highlight (placed weapon → exhausted) renders
      // unchanged while the player picks. The session is REPLACED
      // when the bonus swing fires.
      setArmedAbility({
        kind: "soulshift-repeat-target",
        slotIdx: modal.slotIdx,
        cardId: modal.cardId,
      });
      setModal(null);
      router.refresh();
    });
}

// --- Scorchline Beam (Body) — repeat-attack prompt -------------------

/**
 * Two-button "Fire Beam Again?" prompt opened by
 * {@link advanceAfterAction} after every Scorchline R2-R5 swing
 * while the bearer's `beamRepeatsRemaining` counter is > 0:
 *
 *   - "Fire Again" arms the `beam-repeat-target` picker and closes
 *     the modal. The board overlay paints valid straight-line
 *     targets via {@link computeArmedTargets}; on click the bonus
 *     swing fires through `useWeaponAbility(..., { freeRepeat:
 *     true })` and `useWeaponAbility` decrements the counter
 *     itself. If the counter is still > 0 after the next session
 *     finalises, this prompt reopens automatically.
 *
 *   - "Skip" forces the counter to 0 (no banking — remaining
 *     repeats are forfeit) and falls through to the standard
 *     end-turn tail. Used when the player has nothing useful to
 *     hit or wants to dodge the counter-attack risk on another
 *     swing.
 *
 * The modal's `remaining` snapshot is shown as "X repeat(s)
 * left" so the player can plan around the chain length without
 * tracking it in their head.
 */
function renderBeamRepeatPromptModal(
  host: HTMLDivElement,
  router: Router,
  modal: Extract<Modal, { kind: "beam-repeat-prompt" }>,
): void {
  const card = getEquipment(modal.cardId);
  const cardName = card.name;
  const remaining = modal.remaining;
  const remainingLabel = remaining === 1 ? "1 repeat left" : `${remaining} repeats left`;

  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body">
      <h3>${escapeHtml(cardName)}</h3>
      <p class="small muted">Fire again? (${escapeHtml(remainingLabel)}) Pick a new straight line.</p>
      <div class="action-menu-options">
        <button class="action-option" data-fire>
          <span class="action-option-label">Fire Again</span>
          <span class="action-option-detail small muted">Pick the first enemy in any straight line</span>
        </button>
      </div>
      <div class="modal-footer">
        <button class="btn btn--small btn--ghost" data-skip>Skip remaining</button>
      </div>
    </div>
  `;

  host.querySelector<HTMLButtonElement>("[data-skip]")!
    .addEventListener("click", () => {
      // Forfeit any remaining repeats and fall through to the
      // standard end-turn tail.
      clearBeamRepeats(router.state, router.state.currentDelverId);
      setModal(null);
      clearActionState();
      if (!maybeAutoEndTurn(router)) router.save();
      router.refresh();
    });

  host.querySelector<HTMLButtonElement>("[data-fire]")!
    .addEventListener("click", () => {
      // Arm the picker; close the modal so the board overlays render.
      // The session from the prior swing is left in uiState so
      // exhaustion / hand-panel state stays stable while the player
      // picks (mirrors the Soulshift swing-again handoff). The
      // session is REPLACED when the bonus swing fires.
      setArmedAbility({
        kind: "beam-repeat-target",
        slotIdx: modal.slotIdx,
        cardId: modal.cardId,
      });
      setModal(null);
      router.refresh();
    });
}

// --- CREATURE PART pickup pick (Gauntlet) ----------------------------

/**
 * Tile picker for the head of
 * `state.encounter.pendingCreaturePartChoices`. Each pending
 * pick represents one CREATURE PART that the bearer can collect
 * "from any tile" (Gauntlet R2-R5; Surge Claw R1-R5). A
 * `count: N` swing produces N independent prompts that walk
 * through one-at-a-time.
 *
 * The card text — "Collect 1 CREATURE PART from any tile." —
 * means the bearer plucks an existing creature-part DROP TOKEN
 * off the board (one of the per-delver tokens left by enemy
 * kills) without having to walk onto the tile. It is NOT a
 * supply credit, so the modal lists every tile that currently
 * carries a drop owed to the bearer:
 *
 *   - Each button corresponds to one tile (deduped by `(x, y)`)
 *     and reports the tile coords + how many of the bearer's
 *     drops are stacked there.
 *   - Clicking a tile claims ONE drop (FIFO within the stack)
 *     and credits the matching wallet (`minion-part` →
 *     `state.minionParts`; `boss-part` / `boss-part-lvl-<N>` →
 *     `state.bossParts`). Multi-drop tiles are still legal
 *     subsequent targets for later picks in the queue.
 *   - If no eligible drops exist (e.g. a swing that misses
 *     and kills nothing while a count: 1 effect is queued, or
 *     the bearer's drops have all been claimed via foot
 *     movement), a single "Skip — nothing to collect" button
 *     drains the queue head as a no-op.
 *
 * Each pick fires the wallet-fly animation from the picked
 * tile to the corresponding wallet UI, then re-runs
 * `advanceAfterAction` so the next pending pick (if any)
 * re-opens this modal, or the standard tail takes over once
 * the queue empties.
 *
 * Cancel-less by design — the queue must drain before the
 * player can advance the phase.
 */
function renderCreaturePartPickModal(host: HTMLDivElement, router: Router): void {
  const entry = peekNextPendingCreaturePartChoice(router.state);
  if (!entry) {
    setModal(null);
    advanceAfterAction(router);
    return;
  }
  let sourceLabel = "Gauntlet";
  try {
    sourceLabel = getEquipment(entry.sourceCardId).name;
  } catch {
    // Unknown source id — keep the generic label rather than crash.
  }
  const remainingInQueue = router.state.encounter?.pendingCreaturePartChoices.length ?? 0;
  const queueHint = remainingInQueue > 1
    ? ` <span class="muted">(${remainingInQueue} pending)</span>`
    : "";
  const heroId = entry.heroId;
  const hero = getHero(heroId);
  const heroLabel = hero.suit === "mind" ? "Mind Delver" : "Body Delver";

  // Group every drop owed to the bearer by tile (x, y) so each
  // tile renders as a single button regardless of stack depth.
  // Mind-suit drops on the same tile as Body-suit drops are
  // intentionally separate entries in `tileDrops` (per-delver
  // ownership), so this filter naturally excludes the OTHER
  // delver's tokens.
  const eligibleDrops = availableCreaturePartDropsForHero(router.state, heroId);
  const tileBuckets = new Map<string, { x: number; y: number; minion: number; boss: number }>();
  for (const d of eligibleDrops) {
    const k = `${d.x},${d.y}`;
    let b = tileBuckets.get(k);
    if (!b) {
      b = { x: d.x, y: d.y, minion: 0, boss: 0 };
      tileBuckets.set(k, b);
    }
    if (d.dropId === "minion-part") b.minion += 1;
    else b.boss += 1;
  }
  const tiles = [...tileBuckets.values()];

  let bodyHtml: string;
  if (tiles.length === 0) {
    bodyHtml = `
      <div class="action-menu-options">
        <button class="action-option" data-skip="1">
          <span class="action-option-label">Skip — nothing to collect</span>
          <span class="action-option-detail small muted">No CREATURE PART drops are on the board for this delver.</span>
        </button>
      </div>
    `;
  } else {
    const buttons = tiles.map((t) => {
      const partsLabel = t.minion > 0 && t.boss > 0
        ? `${t.minion} MINION + ${t.boss} BOSS`
        : t.minion > 0
          ? `${t.minion} MINION PART${t.minion > 1 ? "S" : ""}`
          : `${t.boss} BOSS PART${t.boss > 1 ? "S" : ""}`;
      return `
        <button class="action-option" data-x="${t.x}" data-y="${t.y}">
          <span class="action-option-label">Tile (${t.x}, ${t.y})</span>
          <span class="action-option-detail small muted">${escapeHtml(partsLabel)} available</span>
        </button>
      `;
    }).join("");
    bodyHtml = `
      <div class="action-menu-options">
        ${buttons}
      </div>
    `;
  }

  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body">
      <h3>${escapeHtml(sourceLabel)}${queueHint}</h3>
      <p class="small muted">${escapeHtml(heroLabel)} — collect 1 CREATURE PART from any tile:</p>
      ${bodyHtml}
    </div>
  `;

  const skipBtn = host.querySelector<HTMLButtonElement>("[data-skip]");
  if (skipBtn) {
    skipBtn.addEventListener("click", () => {
      const r = skipCreaturePartChoice(router.state, heroId);
      if (!r.ok) {
        console.warn("skipCreaturePartChoice rejected:", r.reason);
      }
      setModal(null);
      advanceAfterAction(router);
    });
  }
  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-x][data-y]")) {
    btn.addEventListener("click", () => {
      const x = Number(btn.dataset.x);
      const y = Number(btn.dataset.y);
      const r = applyCreaturePartChoice(router.state, heroId, x, y);
      if (!r.ok) {
        console.warn("applyCreaturePartChoice rejected:", r.reason);
        setModal(null);
        advanceAfterAction(router);
        return;
      }
      const suit = hero.suit;
      const minionCount = r.dropId === "minion-part" ? 1 : 0;
      const bossCount = r.dropId === "minion-part" ? 0 : 1;
      requestAnimationFrame(() =>
        flyTilePickupsToWallet(x, y, minionCount, bossCount, suit),
      );
      setModal(null);
      advanceAfterAction(router);
    });
  }
}

// --- Ritual pick (Ch4 Winona the Oak) --------------------------------

function renderRitualPickModal(host: HTMLDivElement, router: Router): void {
  const enc = router.state.encounter;
  const heroId = enc?.pendingRitualPicks[0];
  if (!enc || !heroId) {
    setModal(null);
    advanceAfterAction(router);
    return;
  }
  const ranks = getEffectiveEquipmentRanks(router.state, heroId);
  const options = ritualOptions(router.state, heroId, ranks);
  const who = getHero(heroId).suit === "mind" ? "Mind Delver" : "Body Delver";
  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body">
      <h3>Ritual - ${who}</h3>
      <p class="small muted">Choose one equipment to sacrifice: it drops one rank for the rest of the wave (a Rank 1 card is lost until Winona is slain or the wave ends).</p>
      <div class="action-menu-options">
        ${options.map((t) => `<button class="action-option" data-ritual="${t}"><span class="action-option-label">${t} (Rank ${ranks[t]} &rarr; ${(ranks[t] ?? 1) - 1})</span></button>`).join("")}
      </div>
    </div>
  `;
  if (options.length === 0) {
    enc.pendingRitualPicks.shift();
    setModal(null);
    advanceAfterAction(router);
    return;
  }
  host.querySelectorAll<HTMLButtonElement>("[data-ritual]").forEach((btn) => btn.addEventListener("click", () => {
    logEvent("click.ritual-pick", { heroId, type: btn.dataset.ritual });
    sacrificeToRitual(router.state, heroId, btn.dataset.ritual as EquipmentType);
    setModal(null);
    router.persist();
    advanceAfterAction(router);
  }));
}

// --- Element-pick modal (Elemental OS — Body) ------------------------

/**
 * 6-button element grid for resolving a {@link PendingElementChoice}.
 * The head of `state.encounter.pendingElementChoices` decides who's
 * picking; this modal stays open across multiple back-to-back
 * picks (the engine's `applyElementChoice` pops the head, and the
 * advance gate re-opens the modal if more entries remain).
 *
 *   - Buttons for elements at the per-delver cap of 2 are disabled.
 *     A queued grant against a fully-capped delver (rare; would
 *     need 12 elements held) would deadlock the queue, so we
 *     surface a "Skip - all elements at cap" footer button that
 *     pops the head as a no-op grant against any element (overflow
 *     is silently lost per `grantElementToDelver`).
 *   - No Cancel button by design — once a grant is queued, it must
 *     resolve before any phase-advance gate (End Turn, End Wave
 *     "Continue", next Level-Up draw).
 *   - Each pick re-runs `advanceAfterAction` so the standard
 *     post-action queue (more element picks → level-ups → soulshift
 *     → end-turn) takes over once this queue empties.
 */
function renderElementPickModal(host: HTMLDivElement, router: Router): void {
  const entry = peekNextPendingElementChoice(router.state);
  if (!entry) {
    // Defensive: queue drained between renders.
    setModal(null);
    advanceAfterAction(router);
    return;
  }
  const hero = getHero(entry.heroId);
  const heroLabel = hero.suit === "mind" ? "Mind Delver" : "Body Delver";
  // cardNumber 0 = a Ch3+ quest End-of-Wave entry ("Delvers gain 2
  // elements"), applied through the scenario-effect pipeline.
  const sourceLabel = entry.source.kind === "scenario-card"
    ? (entry.source.cardNumber === 0
      ? "End of Wave reward"
      : `Scenario Card #${String(entry.source.cardNumber).padStart(2, "0")}`)
    : entry.source.kind === "os-immediate"
      ? `${getEquipment(entry.source.cardId).name} - gained`
      : entry.source.kind === "townsfolk"
        ? `${entry.source.name} - Assault on Bird's Nest`
      : entry.source.kind === "weapon"
        ? `${getEquipment(entry.source.cardId).name} - hit a minion`
        : `${getEquipment(entry.source.cardId).name} - end of wave`;
  const bag = router.state.elements[entry.heroId] ?? {};
  const cap = ELEMENT_CAP_PER_DELVER;
  const remainingInQueue = router.state.encounter?.pendingElementChoices.length ?? 0;
  const queueHint = remainingInQueue > 1
    ? ` <span class="muted">(${remainingInQueue} pending)</span>`
    : "";
  const allCapped = ALL_ELEMENTS_DISPLAY_ORDER.every((el) => (bag[el] ?? 0) >= cap);

  const buttons = ALL_ELEMENTS_DISPLAY_ORDER.map((el) => {
    const have = bag[el] ?? 0;
    const atCap = have >= cap;
    const detail = atCap
      ? `Has <strong>${have} / ${cap}</strong> - at cap`
      : `Has <strong>${have} / ${cap}</strong>`;
    return `
      <button class="action-option" data-element="${el}"${atCap ? " disabled" : ""}>
        <span class="action-option-label">${escapeHtml(el.toUpperCase())}</span>
        <span class="action-option-detail small muted">${detail}</span>
      </button>
    `;
  }).join("");

  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body">
      <h3>${escapeHtml(heroLabel)} - choose 1 element${queueHint}</h3>
      <p class="small muted">${escapeHtml(sourceLabel)}.</p>
      <div class="action-menu-options action-menu-options--grid-2">
        ${buttons}
      </div>
      ${allCapped ? `
        <div class="modal-footer">
          <button class="btn btn--small btn--ghost" data-skip>Skip (all at cap - lost)</button>
        </div>
      ` : ""}
    </div>
  `;

  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-element]")) {
    btn.addEventListener("click", () => {
      const element = btn.dataset.element as Element;
      const r = applyElementChoice(router.state, element);
      if (!r.ok) {
        // Defensive: queue raced empty. Bail to advance gate.
        setModal(null);
        advanceAfterAction(router);
        return;
      }
      // Persist + advance. If more element picks remain, the gate
      // re-opens this modal; otherwise it routes back to the next
      // queued prompt (level-up, soulshift, end-turn).
      router.save();
      // Close the current modal first so `advanceAfterAction` can
      // re-open the next one cleanly (the post-action gate uses
      // `setModal(...)` to reopen).
      setModal(null);
      advanceAfterAction(router);
    });
  }

  const skipBtn = host.querySelector<HTMLButtonElement>("[data-skip]");
  if (skipBtn) {
    skipBtn.addEventListener("click", () => {
      // Pop the head as a "lost" grant — pick any element; the
      // engine's `grantElementToDelver` will silently discard since
      // the bag is at cap.
      applyElementChoice(router.state, ALL_ELEMENTS_DISPLAY_ORDER[0]!);
      router.save();
      setModal(null);
      advanceAfterAction(router);
    });
  }
}

/**
 * Witness companion "Move up to 2 tiles" Action — the witness-move
 * modal kind acts purely as a MODE FLAG (no UI popup). The destination
 * overlay on the board (`renderWitnessMoveTargets` below) keys off
 * `modal.kind === "witness-move"` to paint the legal-step tiles; the
 * player commits each step by tapping a highlighted tile, and the
 * mode auto-closes when the step cap is reached (see
 * `onWitnessStepClick`).
 *
 * Per user request 2026-05-19: the previous status/instructions
 * popup was removed. The player can still re-enter the mode mid-Action
 * via the action-menu "Move Witness" button to take their 2nd step,
 * and can exit the mode without stepping by clicking any weapon slot
 * (which opens the action-menu and replaces the witness-move modal).
 *
 * Defensive bail-outs (close immediately): encounter went away or
 * Witness left the board mid-mode (wave teardown raced this). The
 * mode is otherwise stateless — we render NOTHING here so the
 * wrapper stays invisible + click-through (see CSS rule
 * `.action-modal[data-modal-kind="witness-move"]`).
 */
function renderWitnessMoveModal(host: HTMLDivElement, router: Router): void {
  const state = router.state;
  const enc = state.encounter;
  const heroId = state.currentDelverId;
  if (!enc || enc.witnessPosition == null) {
    setModal(null);
    router.refresh();
    return;
  }
  const ts = enc.turnState[heroId];
  if (!ts) {
    setModal(null);
    router.refresh();
    return;
  }
  // Intentionally empty — the action-modal wrapper is invisible and
  // click-through under `[data-modal-kind="witness-move"]`. All UX
  // for the witness-move mode lives on the board overlay.
  host.innerHTML = "";
}

/**
 * Paint the Witness destination overlay (8-way legal tiles) into the
 * BoardScreen's `data-board-witness-targets` layer. Called from
 * `BoardScreen.ts` every render while the witness-move modal is open.
 *
 * Each highlighted tile is a button — tapping it fires `stepWitness`
 * and immediately refreshes the modal + board so the player sees the
 * updated Witness position, wallet credit, and remaining-step
 * counter. The overlay disappears automatically when the step cap is
 * hit (`legalWitnessStepDestinations` returns `[]`).
 *
 * Visual treatment is intentionally similar to the delver movement
 * overlay (`board-move-target`) so the affordance reads instantly to
 * players already familiar with the movement pattern; a small
 * Witness-tint class (`board-witness-target--ultra`) is added when the
 * destination tile carries a drop or memory fragment so the player
 * can prioritise pickups when planning their 2-tile path.
 */
export function renderWitnessMoveTargets(
  layer: HTMLDivElement,
  router: Router,
): void {
  layer.innerHTML = "";
  const modal = getModal();
  if (!modal || modal.kind !== "witness-move") return;

  const state = router.state;
  const enc = state.encounter;
  if (!enc || enc.witnessPosition == null) return;
  const heroId = state.currentDelverId;
  const ts = enc.turnState[heroId];
  if (!ts) return;

  const reachable = legalWitnessStepDestinations(state, BOARD);
  if (reachable.length === 0) return;

  for (const tile of reachable) {
    const { left, top } = cellCenterPct(tile.x, tile.y);
    const { wPct, hPct } = cellSizePct(tile.x, tile.y);
    const el = document.createElement("button");
    // Tile-level pickup preview — read off the encounter without
    // mutating. Used to flag "this tile has a creature part" in the
    // overlay so the player can plan their 2-step path around drops.
    const hasDrop = enc.tileDrops.some((d) => d.x === tile.x && d.y === tile.y);
    const hasFragment = enc.memoryFragments.some((m) => m.x === tile.x && m.y === tile.y);
    const pickupHint = hasDrop || hasFragment ? " board-witness-target--pickup" : "";
    el.className = `board-witness-target${pickupHint}`;
    el.style.left   = `${left}%`;
    el.style.top    = `${top}%`;
    el.style.width  = `${wPct}%`;
    el.style.height = `${hPct}%`;
    el.title = hasDrop || hasFragment
      ? `Step Witness here (collects items on this tile)`
      : `Step Witness here`;
    el.addEventListener("click", () => onWitnessStepClick(router, tile.x, tile.y));
    layer.appendChild(el);
  }
}

/** Engine bridge for a single witness tile tap. Validates via the
 *  engine, surfaces any pickups via the session log, then refreshes
 *  the board overlay. With no popup to show progress (user request
 *  2026-05-19), we auto-dismiss the witness-move mode as soon as the
 *  step cap is reached so the player isn't stranded in a mode with
 *  no visible affordance to exit — the Witness sprite has moved and
 *  the wallet counters have updated, that's the feedback. */
function onWitnessStepClick(router: Router, x: number, y: number): void {
  const heroId = router.state.currentDelverId;
  const r = stepWitness(router.state, heroId, x, y, BOARD);
  logEvent("click.witness-move.step", {
    heroId,
    to: { x, y },
    result: r.ok ? "ok" : `fail:${r.reason}`,
    stepsRemaining: r.ok ? r.stepsRemaining : null,
    pickedUp: r.ok ? summarizePickups(r.pickups) : null,
  });
  if (!r.ok) {
    router.refresh();
    return;
  }
  // Fly any picked-up creature parts to the topbar wallet
  const minionCount = Object.values(r.pickups.minionParts).reduce((s, n) => s + n, 0);
  const bossCount   = Object.values(r.pickups.bossParts).reduce((s, n) => s + n, 0);
  if (minionCount > 0 || bossCount > 0) {
    const viewedId = getPeekedDelverId() ?? router.state.currentDelverId;
    const suit = (HEROES.find(h => h.id === viewedId) ?? HEROES[0]!).suit;
    flyTilePickupsToWallet(x, y, minionCount, bossCount, suit);
  }
  router.save();
  if (r.stepsRemaining === 0) {
    setModal(null);
    router.refresh();
  }
}

/** Compact summary for the session log — lossless enough to debug
 *  pickup credit issues without inlining 3 separate Records. */
function summarizePickups(p: WitnessStepPickups): string {
  if (!witnessPickupsHasAny(p)) return "nothing";
  const parts: string[] = [];
  for (const [hid, n] of Object.entries(p.minionParts)) {
    if (n > 0) parts.push(`${hid}:${n}mp`);
  }
  for (const [hid, n] of Object.entries(p.bossParts)) {
    if (n > 0) parts.push(`${hid}:${n}bp`);
  }
  if (p.memoryFragments > 0) parts.push(`${p.memoryFragments}mf`);
  return parts.join(",");
}

// --- Trident pre-attack move prompt -----------------------------------
// Opens BEFORE the swing fires when the placed Trident card carries
// the `pre-attack-may-move-adjacent` effect AND there is at least
// one 8-way adjacent live enemy (the renderer also shows a count of
// adjacent enemies — 0 should never reach this modal but the gate
// is defensive).
//
// Two outcomes:
//   - Skip: fire the swing immediately at the printed pattern.
//   - Pick: arm `trident-pre-move-target` and close the modal so
//     the board overlays paint the adjacent enemies.

function renderTridentPreMovePromptModal(
  host: HTMLDivElement,
  router: Router,
  modal: Extract<Modal, { kind: "trident-pre-move-prompt" }>,
): void {
  const card = getEquipment(modal.cardId);
  const heroId = router.state.currentDelverId;
  const adj = adjacentEnemyTargets(router.state, heroId);
  // Mirror the open-side gate (`onChooseWeaponAbility`): a candidate
  // here means "adjacent live enemy with at least one legal
  // destination tile". If no candidates remain (board mutated since
  // open, or the open-side gate was skipped due to a state-restore
  // edge case), short-circuit to the swing.
  const movableAdj = adj.filter(
    (e) => legalMoveDestinationsForEnemy(router.state, e.instanceId, BOARD).length > 0,
  );
  const count = movableAdj.length;
  if (count === 0) {
    setModal(null);
    fireFixedPatternSwing(router, modal.slotIdx, undefined);
    return;
  }

  const targetLabel = count === 1 ? "1 adjacent enemy" : `${count} adjacent enemies`;
  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body">
      <h3>Move enemy?</h3>
      <p class="small muted">May move an adjacent enemy 1 tile before the swing. (${escapeHtml(targetLabel)}.)</p>
      <div class="action-menu-options">
        <button class="action-option" data-pick>
          <span class="action-option-label">Pick adjacent enemy</span>
          <span class="action-option-detail small muted">Then choose a destination tile</span>
        </button>
      </div>
      <div class="modal-footer">
        <button class="btn btn--small btn--ghost" data-skip>Skip - fire now</button>
      </div>
    </div>
  `;

  host.querySelector<HTMLButtonElement>("[data-skip]")!
    .addEventListener("click", () => {
      setModal(null);
      fireFixedPatternSwing(router, modal.slotIdx, undefined);
    });

  host.querySelector<HTMLButtonElement>("[data-pick]")!
    .addEventListener("click", () => {
      setArmedAbility({
        kind: "trident-pre-move-target",
        slotIdx: modal.slotIdx,
        cardId: modal.cardId,
      });
      setModal(null);
      router.refresh();
    });
}

// --- Mace mode-pick / element-pick ------------------------------------
//
// Mace prints a UNDAMAGED-only / DAMAGED-only filter on its
// `single-adjacent` swing, with an "OR Spend an element to deal
// HEAVY to an adjacent enemy" bypass clause. Two-modal flow when
// the player picks "Use weapon ability":
//
//   1. `mace-mode-pick`  — opens iff BOTH modes are viable. Two
//      buttons: Default mode (filtered targeting) vs Spend element
//      (any-adjacent targeting). Clicking Default arms the weapon
//      directly; clicking Spend routes to the element picker
//      (or arms directly when the bag has only one element kind).
//      Cancel returns to the action menu.
//
//   2. `mace-element-pick` — opens iff the player has committed to
//      spend AND the bag holds >1 element kind (so we need to ask
//      WHICH element to spend). One button per available element
//      kind; clicking arms the weapon with the chosen element +
//      `spendElementForBypass = picked` and closes the modal so
//      the target overlay paints every adjacent enemy.
//
// Auto-skip rules live in `onChooseWeaponAbility` (above) — by
// the time these modals open we know they're each REQUIRED.

function renderMaceModePickModal(
  host: HTMLDivElement,
  router: Router,
  modal: Extract<Modal, { kind: "mace-mode-pick" }>,
): void {
  const card = getEquipment(modal.cardId);
  const heroId = router.state.currentDelverId;
  const filterEff = getTargetFilterOrSpendElementEffect(card);
  const filterLabel = filterEff?.filter === "undamaged" ? "UNDAMAGED" : "DAMAGED";
  const matching = filterEff
    ? adjacentLiveEnemiesMatchingFilter(router.state, heroId, filterEff.filter).length
    : 0;
  const kinds = availableElementKinds(router.state, heroId);
  const elementSummary = kinds.length === 1
    ? `Spend 1 ${kinds[0]} to ignore the filter.`
    : `Spend any 1 element (you'll pick which) to ignore the filter.`;

  host.innerHTML = `
    <div class="action-menu-backdrop" data-close-modal></div>
    <div class="action-menu-body">
      <h3>${escapeHtml(card.name)}</h3>
      <p class="small muted">Pick a targeting mode for this swing.</p>
      <div class="action-menu-options">
        <button class="action-option" data-mode="default">
          <span class="action-option-label">Default — adjacent ${escapeHtml(filterLabel)} enemy</span>
          <span class="action-option-detail small muted">${matching} legal target${matching === 1 ? "" : "s"} in range</span>
        </button>
        <button class="action-option" data-mode="spend">
          <span class="action-option-label">Spend element — any adjacent enemy</span>
          <span class="action-option-detail small muted">${escapeHtml(elementSummary)}</span>
        </button>
      </div>
      <div class="modal-footer">
        <button class="btn btn--small btn--ghost" data-cancel>Cancel</button>
      </div>
    </div>
  `;

  host.querySelector<HTMLButtonElement>("[data-mode=default]")!
    .addEventListener("click", () => {
      setArmedAbility({
        kind: "weapon",
        slotIdx: modal.slotIdx,
        cardId: modal.cardId,
        rangeKind: "single-adjacent",
      });
      setModal(null);
      router.refresh();
    });

  host.querySelector<HTMLButtonElement>("[data-mode=spend]")!
    .addEventListener("click", () => {
      if (kinds.length === 1) {
        setArmedAbility({
          kind: "weapon",
          slotIdx: modal.slotIdx,
          cardId: modal.cardId,
          rangeKind: "single-adjacent",
          spendElementForBypass: kinds[0],
        });
        setModal(null);
        router.refresh();
        return;
      }
      setModal({
        kind: "mace-element-pick",
        slotIdx: modal.slotIdx,
        cardId: modal.cardId,
      });
      router.refresh();
    });

  host.querySelector<HTMLButtonElement>("[data-cancel]")!
    .addEventListener("click", () => {
      setModal({ kind: "action-menu", slotIdx: modal.slotIdx });
      router.refresh();
    });

  host.querySelector<HTMLDivElement>("[data-close-modal]")!
    .addEventListener("click", () => {
      setModal({ kind: "action-menu", slotIdx: modal.slotIdx });
      router.refresh();
    });
}

function renderMaceElementPickModal(
  host: HTMLDivElement,
  router: Router,
  modal: Extract<Modal, { kind: "mace-element-pick" }>,
): void {
  const card = getEquipment(modal.cardId);
  const heroId = router.state.currentDelverId;
  const kinds = availableElementKinds(router.state, heroId);

  // Defensive: bag changed since we opened the modal (e.g. another
  // queued effect drained it). Bail back to the mode pick — which
  // will likely auto-route or show the action menu.
  if (kinds.length === 0) {
    setModal({ kind: "mace-mode-pick", slotIdx: modal.slotIdx, cardId: modal.cardId });
    router.refresh();
    return;
  }

  const buttons = kinds
    .map((el) => {
      const have = router.state.elements[heroId]?.[el] ?? 0;
      return `
        <button class="action-option" data-element="${escapeHtml(el)}">
          <span class="action-option-label">Spend 1 ${escapeHtml(el)}</span>
          <span class="action-option-detail small muted">${have} in bag</span>
        </button>
      `;
    })
    .join("");

  host.innerHTML = `
    <div class="action-menu-backdrop" data-close-modal></div>
    <div class="action-menu-body">
      <h3>${escapeHtml(card.name)}</h3>
      <p class="small muted">Spend 1 element to bypass the targeting filter. Any 8-way adjacent enemy will be a legal target.</p>
      <div class="action-menu-options">
        ${buttons}
      </div>
      <div class="modal-footer">
        <button class="btn btn--small btn--ghost" data-back>Back</button>
      </div>
    </div>
  `;

  host.querySelectorAll<HTMLButtonElement>("[data-element]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const el = btn.getAttribute("data-element") as Element;
      setArmedAbility({
        kind: "weapon",
        slotIdx: modal.slotIdx,
        cardId: modal.cardId,
        rangeKind: "single-adjacent",
        spendElementForBypass: el,
      });
      setModal(null);
      router.refresh();
    });
  });

  host.querySelector<HTMLButtonElement>("[data-back]")!
    .addEventListener("click", () => {
      setModal({ kind: "mace-mode-pick", slotIdx: modal.slotIdx, cardId: modal.cardId });
      router.refresh();
    });

  host.querySelector<HTMLDivElement>("[data-close-modal]")!
    .addEventListener("click", () => {
      setModal({ kind: "mace-mode-pick", slotIdx: modal.slotIdx, cardId: modal.cardId });
      router.refresh();
    });
}

// --- End-Turn undo prompt ---------------------------------------------
//
// Opens from the BoardScreen End Turn click handler when the active
// delver has taken 1+ movement steps THIS turn but has NOT placed a
// weapon card. The new turn flow (2026-05-21) allows movement
// before placement, but End Turn after movement-without-placement
// is likely a mistake — surface a forced choice rather than silently
// commit a wasted turn.
//
// Cancel-less by design (no Escape, no backdrop-click dismiss): the
// player must pick one of the two outcomes. Ephemeral UI state means
// a reload while the prompt is open defaults to "Go Back" (the
// movement state is preserved on `CampaignState`, so the player
// can re-tap End Turn to re-surface the same choice).

function renderEndTurnUndoPromptModal(host: HTMLDivElement, router: Router): void {
  const heroId = router.state.currentDelverId;
  const ts = router.state.encounter?.turnState[heroId] ?? null;
  // Defensive: if the precondition has somehow cleared (placement
  // happened in another flow, snapshot gone, etc.), close the modal
  // so the player isn't stuck staring at a now-meaningless prompt.
  const stepCount = ts?.movementStepsThisTurn ?? 0;
  const hasPlaced = ts?.cardPlacedThisTurn != null;
  if (!ts || hasPlaced || stepCount === 0 || ts.movementSnapshot === null) {
    setModal(null);
    router.refresh();
    return;
  }

  const stepLabel = stepCount === 1 ? "1 tile" : `${stepCount} tiles`;
  const undoBlocked = movementUndoBlockedReason(router.state, heroId);

  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body end-turn-undo-prompt-body">
      <h3>End turn without playing a card?</h3>
      <p class="small muted">You moved ${escapeHtml(stepLabel)} this turn but haven't exhausted a weapon card.</p>
      <div class="action-menu-options">
        ${undoBlocked
          ? `<button class="action-option" data-action="end-anyway">
              <span class="action-option-label">End turn anyway</span>
              <span class="action-option-detail small muted">Movement can't be undone: ${escapeHtml(undoBlocked)}</span>
            </button>`
          : `<button class="action-option" data-action="undo-submit">
              <span class="action-option-label">Undo movement &amp; submit</span>
              <span class="action-option-detail small muted">Rewind to the start of your turn, then end it.</span>
            </button>`}
        <button class="action-option" data-action="go-back">
          <span class="action-option-label">Go back</span>
          <span class="action-option-detail small muted">Keep your movement and finish your turn (play a card, take an action).</span>
        </button>
      </div>
    </div>
  `;

  host.querySelector<HTMLButtonElement>("[data-action=end-anyway]")
    ?.addEventListener("click", () => {
      logEvent("end-turn-undo-prompt.end-anyway", { heroId, movementSteps: stepCount, undoBlocked });
      setModal(null);
      commitManualEndTurn(router);
    });

  host.querySelector<HTMLButtonElement>("[data-action=undo-submit]")
    ?.addEventListener("click", () => {
      logEvent("end-turn-undo-prompt.undo-submit", {
        heroId,
        movementSteps: stepCount,
      });
      setModal(null);
      commitEndTurnAfterUndo(router);
    });

  host.querySelector<HTMLButtonElement>("[data-action=go-back]")!
    .addEventListener("click", () => {
      logEvent("end-turn-undo-prompt.go-back", {
        heroId,
        movementSteps: stepCount,
      });
      setModal(null);
      router.refresh();
    });
}

// --- Weapon counter-block prompt --------------------------------------
// Opens AFTER the counter roll AND BEFORE damage is applied (and
// before any Sol/Lunar Shield prompts) when the source weapon
// carries `weapon-counter-block.amount > 0` AND `count > 0` AND at
// least one counterattacker would actually deal damage.
//
// Multi-pick: the player toggles up to `modal.cap` counterattackers
// (each click adds/removes from `modal.picked`); Confirm dispatches
// the running list, Skip dispatches none. Trident (count: 1) and
// Shockwave (count: 2) share this single modal — the only knob is
// `cap`.
//
// The choice routes into `proceedToShieldsOrApply` so the post-block
// reality is reflected in any subsequent shield prompts.

function renderWeaponCounterBlockPromptModal(
  host: HTMLDivElement,
  router: Router,
  modal: Extract<Modal, { kind: "weapon-counter-block-prompt" }>,
): void {
  const session = getAttackSession();
  if (!session) { setModal(null); router.refresh(); return; }
  const blockAmount = sessionWeaponCounterBlockAmount(router.state, session);
  const candidates = counterBlockCandidates(router.state, session);
  const sourceCard = session.source.kind === "weapon" ? getEquipment(session.source.cardId) : null;
  const cardName = sourceCard ? sourceCard.name : "Weapon";

  // Defensive: if candidates evaporated (e.g. due to a stale render),
  // bail back to the standard apply path with no block.
  if (candidates.length === 0 || blockAmount <= 0 || modal.cap <= 0) {
    setModal(null);
    proceedToShieldsOrApply(router, session, modal.rolled, undefined);
    return;
  }

  // Drop any picked ids that aren't candidates anymore (defensive
  // against stale state). This keeps the cap math honest.
  const candidateIds = new Set(candidates.map((c) => c.enemyInstanceId));
  const liveSelections = modal.picked.filter((id) => candidateIds.has(id));
  if (liveSelections.length !== modal.picked.length) {
    setModal({ ...modal, picked: liveSelections });
    router.refresh();
    return;
  }

  const selectedSet = new Set(liveSelections);
  const atCap = liveSelections.length >= modal.cap;
  const buttons = candidates
    .map((c) => renderCounterBlockToggle(c, blockAmount, selectedSet.has(c.enemyInstanceId), atCap))
    .join("");

  // Title + sub-line shape:
  //   - count == 1: "Block 1 counterattack?" (matches Trident copy)
  //   - count >= 2: "Block up to N counterattacks?"
  // Sub-line always shows the running tally so the player knows how
  // many slots remain.
  const titleSuffix = modal.cap === 1
    ? "Block 1 counterattack?"
    : `Block up to ${modal.cap} counterattacks?`;
  const tally = `<strong>${liveSelections.length}/${modal.cap}</strong> picked`;

  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body">
      <h3>${escapeHtml(cardName)} - ${titleSuffix}</h3>
      <p class="small muted">Reduce each picked counterattacker's damage by <strong>${blockAmount}</strong>. ${tally}.</p>
      <div class="action-menu-options">
        ${buttons}
      </div>
      <div class="modal-footer">
        <button class="btn btn--small btn--ghost" data-skip>Skip - take full damage</button>
        <button class="btn btn--primary" data-confirm ${liveSelections.length === 0 ? "disabled" : ""}>Confirm</button>
      </div>
    </div>
  `;

  host.querySelector<HTMLButtonElement>("[data-skip]")!
    .addEventListener("click", () => {
      setModal(null);
      proceedToShieldsOrApply(router, session, modal.rolled, { kind: "skip" });
    });

  host.querySelector<HTMLButtonElement>("[data-confirm]")!
    .addEventListener("click", () => {
      if (liveSelections.length === 0) return; // Disabled-state guard.
      setModal(null);
      proceedToShieldsOrApply(
        router, session, modal.rolled,
        { kind: "block", enemyInstanceIds: liveSelections },
      );
    });

  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-block-enemy]")) {
    btn.addEventListener("click", () => {
      const enemyInstanceId = btn.dataset.blockEnemy!;
      const next = selectedSet.has(enemyInstanceId)
        ? liveSelections.filter((id) => id !== enemyInstanceId)
        // Cap-enforce on add: if at cap, clicking an unselected enemy
        // is a no-op (button already shows the disabled visual).
        : (liveSelections.length < modal.cap
            ? [...liveSelections, enemyInstanceId]
            : liveSelections);
      if (next === liveSelections) return; // No change → skip refresh.
      setModal({ ...modal, picked: next });
      router.refresh();
    });
  }
}

function renderCounterBlockToggle(
  c: CounterBlockCandidate,
  blockAmount: number,
  isSelected: boolean,
  atCap: boolean,
): string {
  const card = getEnemy(c.cardId);
  const lines = [...c.preBlockDamage]
    .map((d) => ({ ...d, hero: getHero(d.heroId) }))
    .sort((a, b) => (a.hero.suit === "mind" ? 0 : 1) - (b.hero.suit === "mind" ? 0 : 1))
    .map(({ hero, damage }) => {
      const suit = hero.suit === "mind" ? "Mind" : "Body";
      const after = isSelected ? Math.max(0, damage - blockAmount) : damage;
      return `${suit}: ${damage}${isSelected ? ` -> ${after}` : ""}`;
    })
    .join(" - ");
  // Disabled when at-cap AND not already selected (player can't pick a
  // 3rd, but they CAN deselect to free a slot).
  const disabled = atCap && !isSelected;
  const cls = ["action-option"];
  if (isSelected) cls.push("is-selected");
  if (disabled) cls.push("is-disabled");
  const checkmark = isSelected ? '<span class="counter-block-toggle-mark">✓ </span>' : "";
  return `
    <button class="${cls.join(" ")}"
            data-block-enemy="${escapeHtml(c.enemyInstanceId)}"
            ${disabled ? "disabled" : ""}>
      <span class="action-option-label">${checkmark}Block ${escapeHtml(card.name)}</span>
      <span class="action-option-detail small muted">${escapeHtml(lines)}</span>
    </button>
  `;
}

// --- Supercharger die-roll modal --------------------------------------
// Two-stage prompt for the IMMEDIATELY effect on Reflex / Spinejack
// Equipment IMMEDIATELY die-roll modal (Supercharger / Battery /
// future cards). Opens from `advanceAfterAction` whenever
// `state.encounter.pendingEquipmentRolls` is non-empty, mirroring
// the element-pick gate. Resolution dispatches `applyEquipmentRoll`
// and re-runs `advanceAfterAction` so the next pending prompt (or
// the level-up modal) takes over.
//
// The per-card outcome table (`equipmentRollTableForCard(cardId)`)
// supplies:
//   - `outcomes` — the printed grant options (1..N).
//   - `rollMap`  — d6 → outcome id OR `"choice"`. A direct outcome
//                  routes to a single-Confirm button; `"choice"`
//                  routes to one button per outcome (player picks).
//
// The Reroll consumable is offered in Stage B when the bearer holds
// a Reroll token AND hasn't spent one this turn (per-kind cap).

// --- XP die roll ("Gain 1 [die] XP" on-death reward) ------------------------
//
// Mirrors the equipment-roll modal's two-stage shape:
//   Stage A: "Roll die" button.
//   Stage B: cycled result + Confirm (plus the standard Reroll-token
//            offer — any player die roll can be rerolled per the
//            2026-05-04 ruling).
// Confirm banks the roll via `applyXpRoll` (shared XP pool + any
// level-ups it affords) and routes back through `advanceAfterAction`
// so follow-up queues (another XP roll, fresh Level-Up draws) open
// naturally.

function renderXpRollModal(
  host: HTMLDivElement,
  router: Router,
  modal: Extract<Modal, { kind: "xp-roll" }>,
): void {
  const head = peekNextPendingXpRoll(router.state);
  if (!head) {
    // Defensive: queue drained between renders.
    setModal(null);
    advanceAfterAction(router);
    return;
  }
  const enemy = getEnemy(modal.enemyCardId);
  const hero = getHero(modal.heroId);
  const heroLabel = hero.suit === "mind" ? "Mind Delver" : "Body Delver";
  const remainingInQueue = router.state.encounter?.pendingXpRolls.length ?? 0;
  const queueHint = remainingInQueue > 1
    ? ` <span class="muted">(${remainingInQueue} pending)</span>`
    : "";

  // Stage A: not yet rolled.
  if (modal.rolled === undefined) {
    host.innerHTML = `
      <div class="action-menu-backdrop"></div>
      <div class="action-menu-body">
        <h3>${escapeHtml(heroLabel)} - ${escapeHtml(enemy.name)} reward${queueHint}</h3>
        <p class="small muted">ON DEATH: Gain 1 die of XP. Roll for it.</p>
        <div class="action-menu-options">
          <button class="action-option" data-roll>
            <span class="action-option-label">Roll die</span>
            <span class="action-option-detail small muted">d6 - the party gains the rolled amount of XP</span>
          </button>
        </div>
      </div>
    `;
    host.querySelector<HTMLButtonElement>("[data-roll]")!
      .addEventListener("click", () => {
        const rolled = Math.floor(Math.random() * 6) + 1;
        setModal({ ...modal, rolled });
        markFreshRoll("xp-roll");
        router.refresh();
      });
    return;
  }

  // Stage B, part 1: cycle animation on a fresh roll.
  const isFreshRoll = consumeFreshRoll("xp-roll");
  if (isFreshRoll) {
    host.innerHTML = `
      <div class="action-menu-backdrop"></div>
      <div class="action-menu-body">
        <h3>${escapeHtml(heroLabel)} - ${escapeHtml(enemy.name)} reward${queueHint}</h3>
        <div class="die-roll-stage die-roll-stage--result">
          <div class="die-roll-result die-roll-result--effective xp-roll-cycling" aria-live="polite">${modal.rolled}</div>
        </div>
      </div>
    `;
    playDieRollCycle(
      host.querySelector<HTMLElement>(".xp-roll-cycling"),
      modal.rolled,
      "xp-roll",
      () => router.refresh(),
    );
    return;
  }

  // Stage B, part 2: settled result + Confirm (+ optional Reroll).
  const rerollCheck = canSpendReroll(router.state, modal.heroId);
  const rerollHtml = rerollCheck.ok
    ? `<div class="action-menu-footer">
         <button class="btn btn--small btn--ghost" data-reroll>
           Reroll (${tokenAvailable(router.state, modal.heroId, "reroll")} available)
         </button>
       </div>`
    : "";
  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body">
      <h3>${escapeHtml(heroLabel)} - ${escapeHtml(enemy.name)} reward</h3>
      <p class="small muted">Rolled <strong>${modal.rolled}</strong>.</p>
      <div class="action-menu-options">
        <button class="action-option" data-confirm>
          <span class="action-option-label">Gain ${modal.rolled} XP</span>
          <span class="action-option-detail small muted">Banked to the party's shared XP pool</span>
        </button>
      </div>
      ${rerollHtml}
    </div>
  `;
  host.querySelector<HTMLButtonElement>("[data-confirm]")!
    .addEventListener("click", () => {
      const r = applyXpRoll(router.state, modal.rolled!);
      logEvent("click.xp-roll-confirm", {
        heroId: modal.heroId,
        enemyCardId: modal.enemyCardId,
        rolled: modal.rolled,
        result: r,
      });
      router.save();
      setModal(null);
      advanceAfterAction(router);
    });
  const rerollBtn = host.querySelector<HTMLButtonElement>("[data-reroll]");
  if (rerollBtn) {
    rerollBtn.addEventListener("click", () => {
      const ok = spendToken(router.state, modal.heroId, "reroll");
      if (!ok) return;
      const rolled = Math.floor(Math.random() * 6) + 1;
      router.save();
      setModal({ ...modal, rolled });
      markFreshRoll("xp-roll");
      router.refresh();
    });
  }
}

function renderEquipmentRollModal(
  host: HTMLDivElement,
  router: Router,
  modal: Extract<Modal, { kind: "equipment-roll" }>,
): void {
  const head = peekNextPendingEquipmentRoll(router.state);
  if (!head) {
    // Defensive: queue drained between renders.
    setModal(null);
    advanceAfterAction(router);
    return;
  }
  const card = getEquipment(modal.cardId);
  const hero = getHero(modal.heroId);
  const heroLabel = hero.suit === "mind" ? "Mind Delver" : "Body Delver";
  const table = equipmentRollTableForCard(modal.cardId);
  if (!table) {
    // Data bug: pending roll for a card with no registered table.
    // Fail loud in dev — the registry should be exhaustive.
    console.error(`[equipment-roll] no table registered for ${modal.cardId}`);
    setModal(null);
    advanceAfterAction(router);
    return;
  }
  const remainingInQueue = router.state.encounter?.pendingEquipmentRolls.length ?? 0;
  const queueHint = remainingInQueue > 1
    ? ` <span class="muted">(${remainingInQueue} pending)</span>`
    : "";

  // "Immediately: choose 1 listed reward" cards (Ion Battery,
  // Overcharger): no die - go straight to the choice.
  if (table.pickOnly) {
    const choiceButtons = table.outcomes.map((o) => `
      <button class="action-option" data-outcome="${o.id}">
        <span class="action-option-label">${escapeHtml(o.label)}</span>
      </button>
    `).join("");
    host.innerHTML = `
      <div class="action-menu-backdrop"></div>
      <div class="action-menu-body">
        <h3>${escapeHtml(heroLabel)} - ${escapeHtml(table.cardName)}${queueHint}</h3>
        <p class="small muted">Immediately: choose 1 listed reward.</p>
        <div class="action-menu-options">${choiceButtons}</div>
      </div>
    `;
    for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-outcome]")) {
      btn.addEventListener("click", () => {
        const outcome = table.outcomes.find((o) => o.id === Number(btn.dataset.outcome));
        if (!outcome) throw new Error(`equipment choice: unknown outcome ${btn.dataset.outcome}`);
        applyEquipmentRoll(router.state, modal.heroId, outcome);
        router.save();
        setModal(null);
        advanceAfterAction(router);
      });
    }
    return;
  }

  // Stage A: not-yet-rolled. Single "Roll die" button.
  if (modal.rolled === undefined) {
    host.innerHTML = `
      <div class="action-menu-backdrop"></div>
      <div class="action-menu-body">
        <h3>${escapeHtml(heroLabel)} - ${escapeHtml(card.name)}${queueHint}</h3>
        <p class="small muted">${escapeHtml(card.abilityText)}</p>
        <div class="action-menu-options">
          <button class="action-option" data-roll>
            <span class="action-option-label">Roll die</span>
            <span class="action-option-detail small muted">d6 - direct outcomes 1..${table.outcomes.length}, "choice" faces let you pick</span>
          </button>
        </div>
      </div>
    `;
    host.querySelector<HTMLButtonElement>("[data-roll]")!
      .addEventListener("click", () => {
        const rolled = Math.floor(Math.random() * 6) + 1;
        setModal({ kind: "equipment-roll", heroId: modal.heroId, cardId: modal.cardId, rolled });
        markFreshRoll("equipment-roll");
        router.refresh();
      });
    return;
  }

  // Stage B: rolled. Branch on the per-card map.
  //
  // Cycle gate: whether the rolled value maps to a direct outcome
  // (single Confirm button) or a "choice" face (multi-button picker)
  // is itself a function of the result, so neither branch can render
  // until the die has settled. While the cycle is in flight we show
  // a minimal "rolling..." view; the cycle's onDone refreshes us
  // into the actual branch.
  const isFreshRoll = consumeFreshRoll("equipment-roll");
  if (isFreshRoll) {
    host.innerHTML = `
      <div class="action-menu-backdrop"></div>
      <div class="action-menu-body">
        <h3>${escapeHtml(heroLabel)} - ${escapeHtml(card.name)}${queueHint}</h3>
        <p class="small muted">${escapeHtml(card.abilityText)}</p>
        <div class="die-roll-stage die-roll-stage--result">
          <div class="die-roll-result die-roll-result--effective equipment-roll-cycling" aria-live="polite">${modal.rolled}</div>
        </div>
      </div>
    `;
    playDieRollCycle(
      host.querySelector<HTMLElement>(".equipment-roll-cycling"),
      modal.rolled,
      "equipment-roll",
      () => router.refresh(),
    );
    return;
  }

  const mapped = outcomeForRoll(table, modal.rolled);

  // Reroll button: shown in Stage B when the BEARER (= roll target)
  // has a Reroll token available AND hasn't already spent one this
  // turn. Spending re-rolls the die in place; the new roll re-enters
  // Stage B (could land on direct OR "choice" again).
  const rerollCheck = canSpendReroll(router.state, modal.heroId);
  const rerollHtml = rerollCheck.ok
    ? `<div class="action-menu-footer">
         <button class="btn btn--small btn--ghost" data-reroll>
           Reroll (${tokenAvailable(router.state, modal.heroId, "reroll")} available)
         </button>
       </div>`
    : "";

  const wireReroll = () => {
    const btn = host.querySelector<HTMLButtonElement>("[data-reroll]");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const ok = spendToken(router.state, modal.heroId, "reroll");
      if (!ok) return;
      const rolled = Math.floor(Math.random() * 6) + 1;
      router.save();
      setModal({ kind: "equipment-roll", heroId: modal.heroId, cardId: modal.cardId, rolled });
      markFreshRoll("equipment-roll");
      router.refresh();
    });
  };

  // Direct outcome: show "Gain ..." + Confirm. Confirm dispatches
  // `applyEquipmentRoll(direct)` and pops the queue.
  if (mapped && mapped !== "choice") {
    host.innerHTML = `
      <div class="action-menu-backdrop"></div>
      <div class="action-menu-body">
        <h3>${escapeHtml(heroLabel)} - ${escapeHtml(card.name)}</h3>
        <p class="small muted">Rolled <strong>${modal.rolled}</strong>.</p>
        <div class="action-menu-options">
          <button class="action-option" data-confirm>
            <span class="action-option-label">Gain ${escapeHtml(mapped.label)}</span>
            <span class="action-option-detail small muted">Adds to your Available consumable tokens</span>
          </button>
        </div>
        ${rerollHtml}
      </div>
    `;
    host.querySelector<HTMLButtonElement>("[data-confirm]")!
      .addEventListener("click", () => {
        applyEquipmentRoll(router.state, modal.heroId, mapped);
        router.save();
        setModal(null);
        advanceAfterAction(router);
      });
    wireReroll();
    return;
  }

  // "choice" face: player picks one outcome from the printed table.
  // No skip — the grant always lands.
  const buttons = table.outcomes.map((o) => `
    <button class="action-option" data-outcome="${o.id}">
      <span class="action-option-label">Option ${o.id}: ${escapeHtml(o.label)}</span>
    </button>
  `).join("");
  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body">
      <h3>${escapeHtml(heroLabel)} - ${escapeHtml(card.name)}</h3>
      <p class="small muted">Rolled <strong>${modal.rolled}</strong> - your choice.</p>
      <div class="action-menu-options">
        ${buttons}
      </div>
      ${rerollHtml}
    </div>
  `;
  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-outcome]")) {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.outcome);
      const outcome: EquipmentRollOutcome | undefined = table.outcomes.find((o) => o.id === id);
      if (!outcome) return;
      applyEquipmentRoll(router.state, modal.heroId, outcome);
      router.save();
      setModal(null);
      advanceAfterAction(router);
    });
  }
  wireReroll();
}

// --- Machinist upgrade "Spend N [element]" prompt -----------------------

/** "north-west" etc. for an adjacent tile (north = top row, y 0). */
function compassFrom(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const ns = to.y < from.y ? "north" : to.y > from.y ? "south" : "";
  const ew = to.x < from.x ? "west" : to.x > from.x ? "east" : "";
  return [ns, ew].filter(Boolean).join("-");
}

function renderWeaponSpendPickModal(
  host: HTMLDivElement,
  router: Router,
  modal: Extract<Modal, { kind: "weapon-spend-pick" }>,
): void {
  const heroId = router.state.currentDelverId;
  const card = playedWeaponCard(router.state, heroId, modal.cardId);
  // Result stage (Lunar Trident): show the multiplier die, then target.
  if (modal.rolled !== undefined && pendingWeaponSpend) {
    host.innerHTML = `
      <div class="action-menu-backdrop"></div>
      <div class="action-menu-body">
        <h3>${escapeHtml(card.name)}</h3>
        <div class="die-roll-stage die-roll-stage--result">
          <div class="die-roll-result die-roll-result--effective" aria-live="polite">${modal.rolled}</div>
        </div>
        <p>This swing's damage is multiplied by <strong>${modal.rolled}</strong>.</p>
        <div class="action-menu-footer">
          <button class="btn btn--small btn--primary" data-spend-continue>Pick target</button>
        </div>
      </div>
    `;
    host.querySelector<HTMLButtonElement>("[data-spend-continue]")!.addEventListener("click", () => {
      const keep = { ...pendingWeaponSpend!, dieRoll: modal.rolled };
      setModal(null);
      continueWeaponAbility(router, modal.slotIdx, card.range!);
      pendingWeaponSpend = keep;
    });
    return;
  }
  const bag = router.state.elements[heroId] ?? {};
  const effects = weaponSpendEffects(card);
  const enc = router.state.encounter!;
  const me = getDelverAt(enc, heroId)!;
  const adjacentEnemies = enc.enemies.filter((e) => e.alive && Math.max(Math.abs(e.x - me.x), Math.abs(e.y - me.y)) === 1);
  const rows = effects.map((eff, i) => {
    const affordable = (bag[eff.element] ?? 0) >= eff.cost;
    const needsTarget = eff.kind === "spend-element-extra-adjacent-damage";
    const targetPick = needsTarget
      ? `<select data-extra-target ${adjacentEnemies.length === 0 ? "disabled" : ""}>${adjacentEnemies.map((e) =>
          `<option value="${e.x},${e.y}">${escapeHtml(getEnemy(e.cardId).name)} (${compassFrom(me, e)})</option>`).join("")}</select>`
      : "";
    const usable = affordable && (!needsTarget || adjacentEnemies.length > 0);
    return `
      <label class="action-option">
        <input type="checkbox" data-spend-idx="${i}" ${usable ? "" : "disabled"} />
        <span class="action-option-label">${escapeHtml(weaponSpendLabel(eff, card))}</span>
        <span class="action-option-detail small muted">You have ${bag[eff.element] ?? 0} ${eff.element}${needsTarget && adjacentEnemies.length === 0 ? " - no adjacent enemy" : ""}</span>
        ${targetPick}
      </label>`;
  }).join("");
  host.innerHTML = `
    <div class="action-menu-backdrop" data-close-modal></div>
    <div class="action-menu-body">
      <h3>${escapeHtml(card.name)}</h3>
      <p class="small muted">${escapeHtml(card.abilityText)}</p>
      <div class="action-menu-options">${rows}</div>
      <p class="small muted" data-spend-error></p>
      <div class="action-menu-footer">
        <button class="btn btn--small btn--ghost" data-close-modal>Cancel</button>
        <button class="btn btn--small btn--primary" data-spend-continue>Continue</button>
      </div>
    </div>
  `;
  for (const closer of host.querySelectorAll<HTMLElement>("[data-close-modal]")) {
    closer.addEventListener("click", () => { setModal(null); router.refresh(); });
  }
  host.querySelector<HTMLButtonElement>("[data-spend-continue]")!.addEventListener("click", () => {
    const picked = [...host.querySelectorAll<HTMLInputElement>("[data-spend-idx]")]
      .filter((cb) => cb.checked)
      .map((cb) => effects[Number(cb.dataset.spendIdx)]!);
    const totals: Partial<Record<Element, number>> = {};
    for (const eff of picked) totals[eff.element] = (totals[eff.element] ?? 0) + eff.cost;
    const short = (Object.entries(totals) as [Element, number][]).find(([el, n]) => (bag[el] ?? 0) < n);
    if (short) {
      host.querySelector<HTMLElement>("[data-spend-error]")!.textContent = `Not enough ${short[0]} for all of those (need ${short[1]}).`;
      return;
    }
    const sel = host.querySelector<HTMLSelectElement>("[data-extra-target]");
    const extra = picked.some((e) => e.kind === "spend-element-extra-adjacent-damage") && sel
      ? { x: Number(sel.value.split(",")[0]), y: Number(sel.value.split(",")[1]) }
      : undefined;
    logEvent("click.weapon-spend-pick", { cardId: card.id, spends: picked.map((e) => e.kind), extra });
    pendingWeaponSpend = { spends: picked.map((e) => e.kind), ...(extra ? { extraTarget: extra } : {}) };
    if (picked.some((e) => e.kind === "spend-element-die-multiplier")) {
      const turn = router.state.encounter!.turnState[heroId]!;
      const roll = rolledMultiplierDie?.turn === turn ? rolledMultiplierDie.roll : rollD6();
      rolledMultiplierDie = { turn, roll };
      setModal({ kind: "weapon-spend-pick", slotIdx: modal.slotIdx, cardId: modal.cardId, rolled: roll });
      router.refresh();
      return;
    }
    setModal(null);
    const range = card.range!;
    const keep = pendingWeaponSpend;
    continueWeaponAbility(router, modal.slotIdx, range);
    // continueWeaponAbility may arm targeting instead of firing; keep the
    // picks for the eventual dispatch.
    if (getArmedAbility()) pendingWeaponSpend = keep;
  });
}

// --- Double Damage prompt ----------------------------------------------
// Opens from `promptDoubleDamageOrFire` BEFORE the swing fires when
// the bearer holds a matching DD token AND hasn't already spent
// one this turn. Lets the player either spend a token (typed Light/
// Medium/Heavy or future Universal) to double the swing damage, or
// Skip to fire normally. Either choice routes back through
// `dispatchWeaponAbility` so the engine call is unified.

function renderDoubleDamagePromptModal(
  host: HTMLDivElement,
  router: Router,
  modal: Extract<Modal, { kind: "double-damage-prompt" }>,
): void {
  const card = getEquipment(modal.cardId);
  const heroId = router.state.currentDelverId;
  const matchingKind = typedDoubleDamageKindFor(modal.damageType);
  const matchingAvail = tokenAvailable(router.state, heroId, matchingKind);
  const universalAvail = tokenAvailable(router.state, heroId, "damage-2x-universal");
  const typeLabel = modal.damageType.toUpperCase();

  // Build one button per available kind. Order: typed first
  // (because the player USUALLY wants to spend the typed one first
  // and save the universal for off-type swings), then universal.
  const buttons: string[] = [];
  if (matchingAvail > 0) {
    buttons.push(`
      <button class="action-option" data-spend="${matchingKind}">
        <span class="action-option-label">Spend 1 x 2x ${escapeHtml(typeLabel)} (${matchingAvail} available)</span>
        <span class="action-option-detail small muted">Doubles this swing's damage</span>
      </button>
    `);
  }
  if (universalAvail > 0) {
    buttons.push(`
      <button class="action-option" data-spend="damage-2x-universal">
        <span class="action-option-label">Spend 1 x 2x UNIVERSAL (${universalAvail} available)</span>
        <span class="action-option-detail small muted">Doubles this swing's damage</span>
      </button>
    `);
  }

  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body">
      <h3>Spend a Double Damage token?</h3>
      <p class="small muted">${escapeHtml(card.name)} is about to deal ${escapeHtml(typeLabel)} damage. You may spend ONE Double Damage token (1 per turn).</p>
      <div class="action-menu-options">
        ${buttons.join("")}
      </div>
      <div class="modal-footer">
        <button class="btn btn--small btn--ghost" data-skip>Skip - fire without doubling</button>
      </div>
    </div>
  `;

  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-spend]")) {
    btn.addEventListener("click", () => {
      const kind = btn.dataset.spend as ConsumableTokenKind;
      dispatchWeaponAbility(
        router,
        modal.slotIdx,
        modal.cardId,
        modal.weaponParams,
        modal.preAttackMove,
        kind,
      );
    });
  }
  host.querySelector<HTMLButtonElement>("[data-skip]")!
    .addEventListener("click", () => {
      dispatchWeaponAbility(
        router,
        modal.slotIdx,
        modal.cardId,
        modal.weaponParams,
        modal.preAttackMove,
        undefined,
      );
    });
}

// --- AP-spend menus (DESIGN.md §4.3) -----------------------------------

/**
 * Top-level AP menu: lists every available AP-spend (currently
 * 2 options). Picking one either auto-resolves (double movement) or
 * opens a sub-menu (refresh weapon → slot picker).
 */
function renderApSpendModal(host: HTMLDivElement, router: Router): void {
  const state = router.state;
  const heroId = state.currentDelverId;
  const loadout = state.loadouts[heroId];
  const ts = state.encounter?.turnState[heroId] ?? null;
  if (!loadout || !ts) {
    setModal(null);
    return;
  }

  const ap = loadout.currentAp;
  const baseAp = loadout.baseAp;

  // Double-movement gating mirrors the engine.
  const dblCost = 1;
  const dblBlockedReason = ts.movementUsedThisTurn
    ? "Movement already used this turn."
    : ts.apMovementDoubledThisTurn
      ? "Movement already doubled this turn."
      : ap < dblCost
        ? `Need ${dblCost} AP (have ${ap}).`
        : "";
  const canDouble = dblBlockedReason === "";

  // Refresh-weapon gating: any occupied slot, ≥2 AP.
  const refreshCost = 2;
  const occupiedSlots = loadout.slotCards.filter((s) => s !== null).length;
  const refreshBlockedReason = occupiedSlots === 0
    ? "No exhausted weapon cards in your slots."
    : ap < refreshCost
      ? `Need ${refreshCost} AP (have ${ap}).`
      : "";
  const canRefresh = refreshBlockedReason === "";

  // Refresh-ALL gating (rulebook AP table: "5 AP: refresh all Weapon
  // Cards"; option was missing pre-2026-07-22): any occupied slot,
  // ≥5 AP. No slot picker needed — every exhausted card comes back.
  const refreshAllCost = 5;
  const refreshAllBlockedReason = occupiedSlots === 0
    ? "No exhausted weapon cards in your slots."
    : ap < refreshAllCost
      ? `Need ${refreshAllCost} AP (have ${ap}).`
      : "";
  const canRefreshAll = refreshAllBlockedReason === "";

  // Consumable bag section. Lists every kind the bearer currently
  // HAS in Available > 0.
  //
  // Double Damage rows are CLICKABLE — clicking activates the token
  // upfront so every matching swing for the rest of the turn fires
  // at 2x. Per rulebook p15 ("only 1 DD token per turn") the rest
  // of the DD rows lock once one is activated; the active row shows
  // an "ACTIVATED" badge so the player can see which kind is hot.
  //
  // Reactive tokens (Reroll, Block Counterattack) stay greyed-out
  // — they surface inside their own modal at the moment of use
  // (counter-roll modal, equipment-roll modal, etc.). The hint
  // tooltip on each greyed row tells the player WHERE the token is
  // actually spent.
  //
  // Order: typed Double Damage (Light → Medium → Heavy), then the
  // surviving Battery family (Reroll → Block Counterattack).
  // Matches the AVAILABLE-box badge row order so the player sees
  // the same sequence in the menu and on the board. AP is NOT in
  // this list any more — it's the unified pool, paid directly via
  // the two AP-spend buttons above (post-2026-05-09 unification).
  const bagOrder: readonly ConsumableTokenKind[] = [
    "damage-2x-light",
    "damage-2x-medium",
    "damage-2x-heavy",
    "reroll",
    "prevent-counterattack",
  ];
  const ddDamageTypeFor = (kind: ConsumableTokenKind): "light" | "medium" | "heavy" | null => {
    switch (kind) {
      case "damage-2x-light":  return "light";
      case "damage-2x-medium": return "medium";
      case "damage-2x-heavy":  return "heavy";
      default: return null;
    }
  };
  const bagRows = bagOrder
    .map((kind) => ({
      kind,
      available: tokenAvailable(state, heroId, kind),
    }))
    .filter((row) => row.available > 0);
  const bagSectionHtml = bagRows.length === 0
    ? ""
    : `
        <h4 class="ap-spend-bag-title small muted">Consumables in your bag</h4>
        <div class="action-menu-options ap-spend-bag">
          ${bagRows.map((row) => {
            const meta = CONSUMABLE_TOKEN_DISPLAY[row.kind];
            const ddType = ddDamageTypeFor(row.kind);
            const isActivatedNow = ddType ? !!ts.doubleDamageActive[ddType] : false;
            const ddBlocked = ddType
              ? (ts.damage2xUsedThisTurn
                  ? (isActivatedNow
                      ? "Active for the rest of this turn — every matching swing is 2x."
                      : "A Double Damage token is already active this turn.")
                  : "")
              : null;
            const isDdActivatable = ddType !== null && ddBlocked === "";
            const detailHint = ddType
              ? (isActivatedNow
                  ? "Active: every matching swing this turn is doubled."
                  : isDdActivatable
                    ? "Click to activate: every matching swing this turn will be doubled (max 1 Double Damage token per turn)."
                    : meta.spendContextHint)
              : meta.spendContextHint;
            const titleAttr = ddType
              ? (isDdActivatable ? detailHint : (ddBlocked || detailHint))
              : meta.spendContextHint;
            const dataAttr = isDdActivatable ? ` data-action="ap-activate-dd" data-dd-kind="${escapeHtml(row.kind)}"` : "";
            const disabledAttr = isDdActivatable ? "" : " disabled";
            const rowClasses = `action-option ap-spend-bag-row${isActivatedNow ? " ap-spend-bag-row--activated" : ""}${isDdActivatable ? " ap-spend-bag-row--clickable" : ""}`;
            const activatedBadge = isActivatedNow
              ? `<span class="ap-spend-bag-active-badge">ACTIVE</span>`
              : "";
            return `
              <button class="${rowClasses}"${dataAttr}${disabledAttr} title="${escapeHtml(titleAttr)}">
                <span class="ap-spend-bag-icon">${consumableIconInnerHtml(row.kind)}</span>
                <span class="ap-spend-bag-text">
                  <span class="action-option-label">${escapeHtml(meta.label)}${activatedBadge}</span>
                </span>
                <span class="ap-spend-bag-count">x${row.available}</span>
              </button>
            `;
          }).join("")}
        </div>
      `;

  host.innerHTML = `
    <div class="action-menu-backdrop" data-close-modal></div>
    <div class="action-menu-body">
      <h3>Spend AP / Use Consumables</h3>
      <p class="small muted">AP: ${ap} of ${baseAp} available (refreshes at the end of the wave)</p>
      <div class="action-menu-options">
        <button class="action-option" data-action="ap-double-mov"${canDouble ? "" : " disabled"} title="${escapeHtml(dblBlockedReason)}">
          <span class="action-option-label">Double movement (1 AP)</span>
        </button>
        <button class="action-option" data-action="ap-refresh"${canRefresh ? "" : " disabled"} title="${escapeHtml(refreshBlockedReason)}">
          <span class="action-option-label">Refresh weapon card (2 AP)</span>
        </button>
        <button class="action-option" data-action="ap-refresh-all"${canRefreshAll ? "" : " disabled"} title="${escapeHtml(refreshAllBlockedReason)}">
          <span class="action-option-label">Refresh ALL weapon cards (5 AP)</span>
          <span class="action-option-detail small muted">${occupiedSlots} exhausted card${occupiedSlots === 1 ? "" : "s"} return to hand</span>
        </button>
      </div>
      ${bagSectionHtml}
      <div class="action-menu-footer">
        <button class="btn btn--small btn--ghost" data-close-modal>Cancel</button>
      </div>
    </div>
  `;

  for (const closer of host.querySelectorAll<HTMLElement>("[data-close-modal]")) {
    closer.addEventListener("click", () => {
      setModal(null);
      router.refresh();
    });
  }

  const dblBtn = host.querySelector<HTMLButtonElement>("[data-action=ap-double-mov]");
  if (dblBtn && canDouble) {
    dblBtn.addEventListener("click", () => {
      logEvent("click.ap-spend.double-mov", {
        heroId: router.state.currentDelverId,
        ap: snapHeroAp(router.state, router.state.currentDelverId),
      });
      onApDoubleMovement(router);
    });
  }
  const refreshBtn = host.querySelector<HTMLButtonElement>("[data-action=ap-refresh]");
  if (refreshBtn && canRefresh) {
    refreshBtn.addEventListener("click", () => {
      logEvent("click.ap-spend.refresh", {
        heroId: router.state.currentDelverId,
        ap: snapHeroAp(router.state, router.state.currentDelverId),
        slots: snapSlots(router.state, router.state.currentDelverId),
      });
      logEvent("modal.open", { kind: "ap-refresh-pick-slot" });
      setModal({ kind: "ap-refresh-pick-slot" });
      router.refresh();
    });
  }

  const refreshAllBtn = host.querySelector<HTMLButtonElement>("[data-action=ap-refresh-all]");
  if (refreshAllBtn && canRefreshAll) {
    refreshAllBtn.addEventListener("click", () => {
      const heroIdNow = router.state.currentDelverId;
      logEvent("click.ap-spend.refresh-all", {
        heroId: heroIdNow,
        ap: snapHeroAp(router.state, heroIdNow),
        slots: snapSlots(router.state, heroIdNow),
      });
      const r = spendApRefreshAllWeapons(router.state, heroIdNow);
      logEvent("engine.spendApRefreshAllWeapons", {
        result: r.ok ? "ok" : r.reason,
        apAfter: snapHeroAp(router.state, heroIdNow),
      });
      setModal(null);
      router.save();
    });
  }

  // Double Damage activation rows — click to spend the token
  // upfront, flipping the per-type `doubleDamageActive` latch so
  // every matching swing for the rest of this turn is doubled.
  // Uses the existing `spendToken` engine path (same code the
  // attack-time prompt drives), so the per-turn cap, bag mutation,
  // and `useWeaponAbility`'s 2x lookup all stay consistent.
  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-action=ap-activate-dd]")) {
    btn.addEventListener("click", () => {
      const kindAttr = btn.dataset.ddKind;
      if (!kindAttr) return;
      const kind = kindAttr as ConsumableTokenKind;
      const heroIdNow = router.state.currentDelverId;
      const ok = spendToken(router.state, heroIdNow, kind);
      logEvent("click.ap-spend.activate-double-damage", {
        heroId: heroIdNow,
        kind,
        result: ok ? "ok" : "fail",
        availableAfter: tokenAvailable(router.state, heroIdNow, kind),
      });
      if (!ok) {
        console.warn("ap-spend.activate-double-damage: spendToken refused", kind);
      }
      setModal(null);
      router.refresh();
    });
  }
}

function onApDoubleMovement(router: Router): void {
  const heroId = router.state.currentDelverId;
  const apBefore = snapHeroAp(router.state, heroId);
  const r = spendApDoubleMovement(router.state, heroId);
  logEvent("engine.spendApDoubleMovement", {
    heroId,
    result: r.ok ? "ok" : `fail:${r.reason}`,
    apBefore,
    apAfter: snapHeroAp(router.state, heroId),
    turnAfter: snapTurn(router.state, heroId),
  });
  if (!r.ok) {
    console.warn("spendApDoubleMovement rejected:", r.reason);
    setModal(null);
    router.refresh();
    return;
  }
  // Outcome is visible immediately on the AP track — no popup needed.
  advanceAfterAction(router);
}

/**
 * Slot picker for "Spend 2 AP → refresh weapon". Shows one button
 * per occupied slot with a small thumbnail of the card. Picking one
 * runs the engine and goes to the resolution log.
 */
function renderApRefreshPickSlotModal(host: HTMLDivElement, router: Router): void {
  const state = router.state;
  const heroId = state.currentDelverId;
  const loadout = state.loadouts[heroId];
  if (!loadout) {
    setModal(null);
    return;
  }
  const occupied = loadout.slotCards
    .map((cardId, idx) => ({ cardId, idx }))
    .filter((s): s is { cardId: string; idx: number } => s.cardId !== null);

  const hero = getHero(heroId);
  const board = getDelverBoard(hero.suit);
  host.innerHTML = `
    <div class="action-menu-backdrop" data-close-modal></div>
    <div class="action-menu-body">
      <h3>Refresh which weapon card?</h3>
      <p class="small muted">Spends 2 AP. The card returns to your hand.</p>
      <div class="action-menu-options ap-refresh-picker">
        ${occupied.map((s) => {
          const card = getEquipment(s.cardId);
          const slot = board.weaponSlots[s.idx];
          const abilityText = slot ? slotOnlyAbilityText(slot.slotAbilityText) : "";
          return `
            <button class="action-option ap-refresh-option" data-action="ap-refresh-slot" data-slot-idx="${s.idx}">
              <img class="ap-refresh-thumb" src="/cards/${card.image}" alt="${escapeHtml(card.name)}" draggable="false" />
              <span class="ap-refresh-option-info">
                <span class="action-option-label">Slot ${s.idx + 1}: ${escapeHtml(card.name)}</span>
                ${abilityText ? `<span class="ap-refresh-slot-ability small muted">${escapeHtml(abilityText)}</span>` : ""}
              </span>
            </button>
          `;
        }).join("")}
      </div>
      <div class="action-menu-footer">
        <button class="btn btn--small btn--ghost" data-back>Back</button>
        <button class="btn btn--small btn--ghost" data-close-modal>Cancel</button>
      </div>
    </div>
  `;

  for (const closer of host.querySelectorAll<HTMLElement>("[data-close-modal]")) {
    closer.addEventListener("click", () => {
      setModal(null);
      router.refresh();
    });
  }
  host.querySelector<HTMLButtonElement>("[data-back]")!
    .addEventListener("click", () => {
      setModal({ kind: "ap-spend" });
      router.refresh();
    });
  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-action=ap-refresh-slot]")) {
    btn.addEventListener("click", () => {
      const slotIdx = Number(btn.dataset.slotIdx);
      logEvent("click.ap-refresh-pick-slot", {
        heroId: router.state.currentDelverId,
        slotIdx,
        ap: snapHeroAp(router.state, router.state.currentDelverId),
        slots: snapSlots(router.state, router.state.currentDelverId),
        turn: snapTurn(router.state, router.state.currentDelverId),
      });
      onApRefreshSlot(router, slotIdx);
    });
  }
}

/**
 * Pick handler for the AP-spend "refresh weapon" slot picker. Calls
 * the engine, surfaces a `REFRESHED` banner so the player gets
 * explicit confirmation that the slot emptied AND 2 AP came off
 * their pool, then runs the post-action queue (so any pending
 * level-up / equipment-roll / element-pick prompts still gate the
 * turn-end flip).
 *
 * Bug-history note: the banner was added 2026-05-09 after a user
 * reported "I picked the slot, the card is still in its slot, and
 * 2 AP isn't spent." The engine call has always succeeded for this
 * scenario (see `turn.test.ts > USER REPRO 2026-05-09`); the
 * confusion came from refreshing the JUST-PLACED slot, which clears
 * `cardPlacedThisTurn` so the player has to do their mandatory
 * placement again. Without the banner, that re-placement reads as
 * "the refresh did nothing." With the banner, the AP cost and the
 * card name show up explicitly so the state change is unmistakable.
 */
function onApRefreshSlot(router: Router, slotIdx: number): void {
  const heroId = router.state.currentDelverId;
  const loadout = router.state.loadouts[heroId];
  // Capture the card name BEFORE the engine empties the slot — the
  // banner needs to show "Refreshed Crash Hammer", but after a
  // successful refresh `slotCards[slotIdx]` is null.
  const refreshedCardId = loadout?.slotCards[slotIdx] ?? null;

  // Snapshot the full pre-state so a bug-report log captures EXACTLY
  // what the engine saw at call time (the active intermittent
  // refresh bug pivots on whether AP / placement state line up the
  // way the player thinks).
  const apBefore = snapHeroAp(router.state, heroId);
  const slotsBefore = snapSlots(router.state, heroId);
  const turnBefore = snapTurn(router.state, heroId);

  const r = spendApRefreshWeapon(router.state, heroId, slotIdx);

  logEvent("engine.spendApRefreshWeapon", {
    heroId,
    slotIdx,
    refreshedCardId,
    result: r.ok ? "ok" : `fail:${r.reason}`,
    apBefore,
    apAfter: snapHeroAp(router.state, heroId),
    slotsBefore,
    slotsAfter: snapSlots(router.state, heroId),
    turnBefore,
    turnAfter: snapTurn(router.state, heroId),
  });

  if (!r.ok) {
    console.warn("spendApRefreshWeapon rejected:", r.reason);
    setModal(null);
    router.refresh();
    return;
  }

  if (refreshedCardId) {
    setLastAutoRefresh({
      reason: "ap-spend",
      heroId,
      cardId: refreshedCardId,
      cardName: playedWeaponCard(router.state, heroId, refreshedCardId).name,
      apSpent: 2,
    });
  }

  advanceAfterAction(router);
}

// --- Slot-ability "applied" finalization -------------------------------

function finalizeAppliedSlotAbility(router: Router, result: { kind: "applied"; log: { summary: string; detail: unknown } } | { kind: "damage-session"; session: AttackSession }): void {
  if (result.kind === "damage-session") {
    // Damage slot ability: behaves identically to a weapon attack
    // session — start the counter loop.
    startAttackSession(router, result.session);
    return;
  }
  // Non-damage slot abilities (bonus movement, refresh AP, gain
  // token, gain element) all show their effect directly on the
  // sheet/board the moment they're applied — no popup needed.
  advanceAfterAction(router);
}

// --- Attack session entry-point (shared by weapon + slot-damage) -------

function startAttackSession(router: Router, session: AttackSession, _cardId?: string): void {
  setAttackSession(session);
  if (session.hitTiles.length === 0) {
    // Nothing to hit (e.g. die-roll clipped out of bounds). Finalize
    // now and silently advance — the player already saw the ability
    // fire and the board state is unchanged, so no popup.
    doFinalizeAndAdvance(router, session);
    return;
  }
  // Apply ALL damage upfront — one tile after another, in hit-tile
  // order — and snapshot the damaged enemies. This populates
  // session.steps and session.sharedCounter.
  const counterPhase = resolveAllDamage(router.state, session);
  // Auto-skip the counter-roll prompt when no possible roll could
  // land on a delver (DESIGN.md §5.4). Pass `-1` to mark skipped,
  // then finalize + advance silently — the kill is already visible
  // (bodies vanish on finalize) and there was no counter outcome
  // to surface.
  if (!counterPhase.anyCanLand) {
    resolveSharedCounter(router.state, session, -1);
    finalizeAndAdvance(router, session);
    return;
  }
  // Otherwise prompt for the single shared d6.
  setModal({ kind: "counter-roll" });
  router.refresh();
}

// --- Target overlay click handler --------------------------------------

function onTargetClick(router: Router, x: number, y: number): void {
  const armed = getArmedAbility();
  if (!armed) return;
  if (armed.kind === "weapon" && armed.rangeKind === "choose-targets") {
    const picked = armed.chosenTargets ?? [];
    const has = picked.some((t) => t.x === x && t.y === y);
    setArmedAbility({ ...armed, chosenTargets: has ? picked.filter((t) => t.x !== x || t.y !== y) : [...picked, { x, y }] });
    router.refresh();
    return;
  }
  if (armed.kind === "weapon") {
    let params: WeaponAbilityParams;
    if (armed.rangeKind === "die-roll-fixed") {
      params = { kind: "die-roll-fixed", dieRoll: armed.dieRoll!, suffered: armed.suffered };
    } else if (armed.rangeKind === "single-adjacent") {
      // Forward the Mace OR-mode element spend (if any) so the
      // engine debits the bag + bypasses the filter. Cards without
      // the filter effect ignore the field; the engine guards
      // defensively.
      params = {
        kind: "single-adjacent",
        targetX: x,
        targetY: y,
        ...(armed.spendElementForBypass
          ? { spendElementForTargetBypass: { element: armed.spendElementForBypass } }
          : {}),
      };
    } else {
      params = { kind: armed.rangeKind, targetX: x, targetY: y } as WeaponAbilityParams;
    }
    promptDoubleDamageOrFire(router, armed.slotIdx, armed.cardId, params, undefined);
    return;
  }
  if (armed.kind === "boots-move-enemy") {
    onBootsMoveTargetClick(router, armed, x, y);
    return;
  }
  if (armed.kind === "boots-rotate-enemy") {
    onBootsRotateTargetClick(router, x, y);
    return;
  }
  if (armed.kind === "soulshift-repeat-target") {
    onSoulshiftRepeatTargetClick(router, armed, x, y);
    return;
  }
  if (armed.kind === "beam-repeat-target") {
    onBeamRepeatTargetClick(router, armed, x, y);
    return;
  }
  if (armed.kind === "trident-pre-move-target") {
    onTridentPreMoveTargetClick(router, armed, x, y);
    return;
  }
  if (armed.kind === "trident-pre-move-dest") {
    onTridentPreMoveDestClick(router, armed, x, y);
    return;
  }
  // slot-damage
  const r = useSlotAbility(router.state, router.state.currentDelverId, armed.slotIdx, {
    kind: "damage-any-enemy",
    targetX: x, targetY: y,
  });
  if (!r.ok) { console.warn("useSlotAbility rejected:", r.reason); return; }
  setArmedAbility(null);
  finalizeAppliedSlotAbility(router, r.result);
}

/**
 * Two-phase Boots ONGOING (Body — move adjacent enemy):
 *
 *   Phase A: no `targetEnemyId` yet. The clicked tile (x, y) is one of
 *     the adjacent enemies. Look it up and re-arm with that
 *     instance id; rerender so Phase B's destination tiles paint.
 *   Phase B: `targetEnemyId` is set. The clicked tile is one of the
 *     enemy's legal destinations. Dispatch `moveAdjacentEnemy`,
 *     clear armed, persist, possibly auto-end the turn.
 *
 * The board's overlay layer keeps `boots-move-enemy` clicks routed
 * through `onTargetClick` even when the target tile happens to be an
 * enemy (otherwise the enemy-card preview popup would intercept).
 */
function onBootsMoveTargetClick(
  router: Router,
  armed: Extract<ArmedAbility, { kind: "boots-move-enemy" }>,
  x: number,
  y: number,
): void {
  const enc = router.state.encounter;
  if (!enc) return;
  if (armed.targetEnemyId === undefined) {
    const enemy = getEnemyAt(enc, x, y);
    if (!enemy) return;
    setArmedAbility({ kind: "boots-move-enemy", targetEnemyId: enemy.instanceId });
    router.refresh();
    return;
  }
  const r = moveAdjacentEnemy(
    router.state,
    router.state.currentDelverId,
    armed.targetEnemyId,
    x, y,
    BOARD,
  );
  if (!r.ok) { console.warn("moveAdjacentEnemy rejected:", r.reason); return; }
  setArmedAbility(null);
  // Boots spends movement POINTS only — `movementUsedThisTurn` stays
  // false so the player can keep using their remaining budget (Boots
  // again or a normal move). Auto-end therefore won't fire here even
  // if the action is done; the player still has movement options.
  // Once the budget runs out and the turn is otherwise complete, the
  // explicit "End turn" button covers the close-out.
  if (!maybeAutoEndTurn(router)) router.save();
}

/**
 * Single-phase Slip Strider Boots ONGOING (Mind — rotate adjacent
 * enemy). Player has already armed; clicking an adjacent enemy
 * tile records that enemy as the target and opens the
 * `boots-rotate-direction` modal so they can pick CW vs CCW.
 *
 * The actual `rotateAdjacentEnemy` engine call happens in the
 * modal's button handler — keeps the click path here a one-liner.
 */
function onBootsRotateTargetClick(
  router: Router,
  x: number,
  y: number,
): void {
  const enc = router.state.encounter;
  if (!enc) return;
  const enemy = getEnemyAt(enc, x, y);
  if (!enemy) return;
  setArmedAbility({ kind: "boots-rotate-enemy", targetEnemyId: enemy.instanceId });
  setModal({ kind: "boots-rotate-direction", targetEnemyId: enemy.instanceId });
  router.refresh();
}

/**
 * Single-click handler for the Soulshift Sword bonus-swing picker.
 * The clicked tile must hold a live enemy 8-way adjacent to the
 * bearer (the engine validates anyway via `useWeaponAbility`'s
 * single-adjacent range check).
 *
 * Dispatches `useWeaponAbility(..., { freeRepeat: true })` so the
 * bonus swing bypasses the action gate's "action already used"
 * check (the original swing already consumed the action, the bonus
 * is FREE per card text). On success, replaces the in-flight attack
 * session with the new one and re-enters the standard pipeline:
 * resolve damage → counter prompt (if any can land) → finalize →
 * advance. If the new swing also kills, `advanceAfterAction` will
 * naturally re-open the Soulshift roll modal — that's how chains
 * roll forever.
 */
function onSoulshiftRepeatTargetClick(
  router: Router,
  armed: Extract<ArmedAbility, { kind: "soulshift-repeat-target" }>,
  x: number,
  y: number,
): void {
  const enc = router.state.encounter;
  if (!enc) return;
  // Sanity: the click must hit a live enemy (the overlay only paints
  // adjacent live targets so this is belt-and-braces).
  const enemy = getEnemyAt(enc, x, y);
  if (!enemy || !enemy.alive) return;
  const r = useWeaponAbility(
    router.state,
    router.state.currentDelverId,
    armed.slotIdx,
    { kind: "single-adjacent", targetX: x, targetY: y },
    { freeRepeat: true },
  );
  if (!r.ok) {
    console.warn("useWeaponAbility (soulshift repeat) rejected:", r.reason);
    return;
  }
  setArmedAbility(null);
  startAttackSession(router, r.session);
}

/**
 * Scorchline Beam (Body R2-R5) bonus-swing target click. The clicked
 * tile must be the first enemy along one of the 8 ray directions
 * from the bearer (the overlay only paints those — see
 * {@link computeArmedTargets}'s `straight-line` branch). Dispatches
 * a freeRepeat swing through `useWeaponAbility(..., { freeRepeat:
 * true })`; the engine decrements the bearer's pending repeat
 * counter as part of that call.
 *
 * If the new swing leaves the counter > 0, `advanceAfterAction`
 * naturally re-opens the `beam-repeat-prompt` modal — that's how
 * R5's 4-repeat chains play out across multiple targets.
 */
function onBeamRepeatTargetClick(
  router: Router,
  armed: Extract<ArmedAbility, { kind: "beam-repeat-target" }>,
  x: number,
  y: number,
): void {
  const enc = router.state.encounter;
  if (!enc) return;
  const enemy = getEnemyAt(enc, x, y);
  if (!enemy || !enemy.alive) return;
  const r = useWeaponAbility(
    router.state,
    router.state.currentDelverId,
    armed.slotIdx,
    { kind: "straight-line", targetX: x, targetY: y },
    { freeRepeat: true },
  );
  if (!r.ok) {
    console.warn("useWeaponAbility (beam repeat) rejected:", r.reason);
    return;
  }
  setArmedAbility(null);
  startAttackSession(router, r.session);
}

/**
 * Trident pre-attack move — phase A click handler. The clicked tile
 * is one of the 8-way adjacent live enemies (the overlay only paints
 * those). Looks the enemy up, switches to phase B (`trident-pre-move-dest`),
 * and rerenders so the destination tiles paint.
 */
function onTridentPreMoveTargetClick(
  router: Router,
  armed: Extract<ArmedAbility, { kind: "trident-pre-move-target" }>,
  x: number,
  y: number,
): void {
  const enc = router.state.encounter;
  if (!enc) return;
  const enemy = getEnemyAt(enc, x, y);
  if (!enemy || !enemy.alive) return;
  setArmedAbility({
    kind: "trident-pre-move-dest",
    slotIdx: armed.slotIdx,
    cardId: armed.cardId,
    enemyInstanceId: enemy.instanceId,
  });
  router.refresh();
}

/**
 * Trident pre-attack move — phase B click handler. The clicked tile
 * is one of the chosen enemy's legal destinations. Dispatches
 * `useWeaponAbility(..., { preAttackMove: ... })`, which mutates the
 * enemy's position FIRST and then computes the printed pattern's
 * hit tiles against the new layout. The resulting attack session is
 * started normally.
 *
 * The enemy MAY end up on a printed pattern tile and take damage on
 * the same swing — that's the whole point of the "may move" effect:
 * pull an enemy out of cover into your strike zone (or push them
 * out of yours).
 */
function onTridentPreMoveDestClick(
  router: Router,
  armed: Extract<ArmedAbility, { kind: "trident-pre-move-dest" }>,
  x: number,
  y: number,
): void {
  fireFixedPatternSwing(router, armed.slotIdx, {
    enemyInstanceId: armed.enemyInstanceId,
    toX: x,
    toY: y,
  });
}

// --- Target computation --------------------------------------------------

function computeArmedTargets(
  state: CampaignState,
  armed: ArmedAbility,
): { x: number; y: number }[] {
  const enc = state.encounter;
  if (!enc) return [];
  const heroId = state.currentDelverId;
  const me = getDelverAt(enc, heroId);
  if (!me) return [];

  if (armed.kind === "slot-damage") {
    return enc.enemies.filter((e) => e.alive).map((e) => ({ x: e.x, y: e.y }));
  }

  if (armed.kind === "boots-move-enemy") {
    if (armed.targetEnemyId === undefined) {
      // Phase A: paint every adjacent live enemy as a clickable target
      // tile. The Boots engine has already validated activation; this
      // just surfaces the spatial picks.
      return adjacentEnemyTargets(state, heroId).map((e) => ({ x: e.x, y: e.y }));
    }
    // Phase B: paint the legal destination tiles for the picked enemy.
    return legalMoveDestinationsForEnemy(state, armed.targetEnemyId, BOARD);
  }

  if (armed.kind === "boots-rotate-enemy") {
    // Single phase: paint adjacent enemies as clickable targets. The
    // CW / CCW pick lives on a follow-up modal (see
    // `boots-rotate-direction`); after the enemy is picked we don't
    // need to paint anything else on the board.
    if (armed.targetEnemyId === undefined) {
      return adjacentEnemyTargets(state, heroId).map((e) => ({ x: e.x, y: e.y }));
    }
    return [];
  }

  if (armed.kind === "soulshift-repeat-target") {
    // Single phase: paint every adjacent live enemy as a clickable
    // target tile. `adjacentLiveEnemiesForRepeat` filters for `alive`
    // (a chain swing could otherwise highlight an already-dying
    // enemy if the bonus pickup races weirdly with finalize).
    return adjacentLiveEnemiesForRepeat(state, heroId).map((e) => ({ x: e.x, y: e.y }));
  }

  if (armed.kind === "beam-repeat-target") {
    // Single phase: paint the first live enemy along each of the 8
    // straight-line rays from the bearer (Beam's printed range).
    // Mirrors the regular `straight-line` weapon-armed branch below
    // — kept inline so we don't have to fake an `armed.rangeKind`.
    const card = getEquipment(armed.cardId);
    const range = card.range;
    if (!range || range.kind !== "straight-line") return [];
    const dirs = range.includeDiagonals ? ADJACENT_OFFSETS_8WAY : ORTHO_4WAY;
    const out: { x: number; y: number }[] = [];
    for (const d of dirs) {
      let x = me.x + d.dx;
      let y = me.y + d.dy;
      while (isInBoard(x, y)) {
        if (getEnemyAt(enc, x, y)) { out.push({ x, y }); break; }
        x += d.dx; y += d.dy;
      }
    }
    return out;
  }

  if (armed.kind === "trident-pre-move-target") {
    // Phase A: paint every 8-way adjacent live enemy. Same spatial
    // helper Boots uses for its move-adjacent picker.
    return adjacentEnemyTargets(state, heroId).map((e) => ({ x: e.x, y: e.y }));
  }

  if (armed.kind === "trident-pre-move-dest") {
    // Phase B: paint the legal destination tiles for the chosen
    // enemy. Same helper Boots uses for its move-enemy destinations.
    return legalMoveDestinationsForEnemy(state, armed.enemyInstanceId, BOARD);
  }

  // weapon:
  switch (armed.rangeKind) {
    case "single-adjacent": {
      // Mace `target-filter-or-spend-element`: when armed without
      // `spendElementForBypass` AND the card carries the filter
      // effect, restrict the painted tiles to enemies whose
      // `damageTaken` matches the filter. With `spendElementForBypass`
      // set the filter is bypassed and EVERY adjacent live enemy is
      // legal. Non-Mace single-adjacent weapons (Sword, Soulshift)
      // skip the filter entirely (no effect on the card → no
      // restriction).
      const card = playedWeaponCard(state, heroId, armed.cardId);
      const filterEff = getTargetFilterOrSpendElementEffect(card);
      const allAdj = ADJACENT_OFFSETS_8WAY
        .map((o) => ({ x: me.x + o.dx, y: me.y + o.dy }))
        .filter((t) => isInBoard(t.x, t.y) && getEnemyAt(enc, t.x, t.y) != null);
      if (!filterEff || armed.spendElementForBypass) return allAdj;
      return allAdj.filter((t) => {
        const e = getEnemyAt(enc, t.x, t.y);
        if (!e) return false;
        return filterEff.filter === "undamaged"
          ? e.damageTaken === 0
          : e.damageTaken > 0;
      });
    }
    case "chain": {
      // Eligible chain start tiles depend on the precondition anchor:
      //   - "self":  enemies adjacent to the attacker (Chain Gauntlet).
      //   - "other": enemies adjacent to the OTHER delver (Surge Claw).
      const card = playedWeaponCard(state, heroId, armed.cardId);
      const range = card.range;
      if (!range || range.kind !== "chain") return [];
      let anchor: { x: number; y: number } | null = me;
      if (range.requiresAdjacentTo === "other") {
        const otherId = Object.keys(state.loadouts).find((id) => id !== heroId);
        anchor = otherId ? getDelverAt(enc, otherId) : null;
      }
      if (!anchor) return [];
      return ADJACENT_OFFSETS_8WAY
        .map((o) => ({ x: anchor!.x + o.dx, y: anchor!.y + o.dy }))
        .filter((t) => isInBoard(t.x, t.y) && getEnemyAt(enc, t.x, t.y) != null);
    }
    case "straight-line": {
      const card = playedWeaponCard(state, heroId, armed.cardId);
      const range = card.range;
      if (!range || range.kind !== "straight-line") return [];
      const dirs = range.includeDiagonals ? ADJACENT_OFFSETS_8WAY : ORTHO_4WAY;
      const out: { x: number; y: number }[] = [];
      for (const d of dirs) {
        let x = me.x + d.dx;
        let y = me.y + d.dy;
        while (isInBoard(x, y)) {
          if (getEnemyAt(enc, x, y)) { out.push({ x, y }); break; }
          x += d.dx; y += d.dy;
        }
      }
      return out;
    }
    case "die-roll-fixed":
      // Die-roll-fixed weapons don't take a target click — the roll
      // determines tiles. Should not reach here (we open the die-roll
      // modal directly from action-menu).
      return [];
    case "fixed-pattern":
      // Fixed-pattern weapons (Trident) don't take a target click —
      // every printed tile fires every swing. Should not reach here
      // (the action-menu fires directly or opens the pre-move modal).
      return [];
    case "between-delvers":
      // Fires straight from the action menu - no target click.
      return [];
    case "choose-targets": {
      const range = playedWeaponCard(state, heroId, armed.cardId).range;
      if (!range || range.kind !== "choose-targets") return [];
      return enc.enemies
        .filter((e) => e.alive && Math.max(Math.abs(e.x - me.x), Math.abs(e.y - me.y)) <= range.maxDistance)
        .map((e) => ({ x: e.x, y: e.y }));
    }
  }
  return [];
}

const ORTHO_4WAY = [
  { dx: 0,  dy: -1 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 },
];

function isInBoard(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < BOARD.w && y < BOARD.h;
}

// --- Helpers -----------------------------------------------------------

function describeArmed(state: CampaignState, armed: ArmedAbility): string {
  if (armed.kind === "slot-damage") return "Pick any live enemy on the board.";
  if (armed.kind === "boots-move-enemy") {
    if (armed.targetEnemyId === undefined) {
      return "Strider Boots: pick an adjacent enemy to move (costs 2 movement).";
    }
    const enc = state.encounter;
    const enemy = enc ? getEnemyInstance(enc, armed.targetEnemyId) : null;
    const name = enemy ? `the ${getEnemy(enemy.cardId).name}` : "the enemy";
    return `Strider Boots: pick a destination tile for ${name}.`;
  }
  if (armed.kind === "boots-rotate-enemy") {
    if (armed.targetEnemyId === undefined) {
      return "Slip Strider Boots: pick an adjacent enemy to rotate (costs 2 movement).";
    }
    return "Slip Strider Boots: pick rotation direction.";
  }
  if (armed.kind === "soulshift-repeat-target") {
    return "Soulshift Sword: pick an adjacent enemy to swing again at.";
  }
  if (armed.kind === "beam-repeat-target") {
    return "Scorchline Beam: pick the first enemy in any straight line.";
  }
  if (armed.kind === "trident-pre-move-target") {
    return "Trident: pick an adjacent enemy to push 1 tile, or close to skip.";
  }
  if (armed.kind === "trident-pre-move-dest") {
    const enc = state.encounter;
    const enemy = enc ? getEnemyInstance(enc, armed.enemyInstanceId) : null;
    const name = enemy ? `the ${getEnemy(enemy.cardId).name}` : "the enemy";
    return `Trident: pick a destination tile for ${name}.`;
  }
  switch (armed.rangeKind) {
    case "single-adjacent": {
      // Mace: surface which mode is active so the player remembers
      // (a) why some adjacent enemies are not lit up, or (b) that
      // an element WILL be spent on click.
      const card = playedWeaponCard(state, state.currentDelverId, armed.cardId);
      const filterEff = getTargetFilterOrSpendElementEffect(card);
      if (!filterEff) return "Pick an adjacent enemy.";
      if (armed.spendElementForBypass) {
        return `${card.name}: pick ANY adjacent enemy (will spend 1 ${armed.spendElementForBypass}).`;
      }
      const filterLabel = filterEff.filter === "undamaged" ? "UNDAMAGED" : "DAMAGED";
      return `${card.name}: pick an adjacent ${filterLabel} enemy.`;
    }
    case "straight-line": {
      const range = playedWeaponCard(state, state.currentDelverId, armed.cardId).range;
      return range?.kind === "straight-line" && range.firstTargetOnly === false
        ? "Pick a direction - every enemy in that line is hit."
        : "Pick the first enemy in any direction.";
    }
    case "chain": {
      const card = playedWeaponCard(state, state.currentDelverId, armed.cardId);
      const range = card.range;
      if (range && range.kind === "chain" && range.requiresAdjacentTo === "other") {
        return "Pick an enemy adjacent to the OTHER delver to start the chain.";
      }
      return "Pick an adjacent enemy as the chain start.";
    }
    case "die-roll-fixed":  return "Awaiting die roll...";
    case "fixed-pattern":   return "Firing the printed pattern.";
    case "between-delvers": return "Hitting every enemy between the delvers.";
    case "choose-targets": {
      const n = armed.chosenTargets?.length ?? 0;
      return `Tap enemies within 2 tiles to choose targets (${n} chosen), then Fire.`;
    }
  }
  void state;
  return "Pick a target.";
}

function weaponAbilityDescription(range: WeaponRange | null | undefined, freeChoice = false): string {
  if (!range) return "(no range)";
  switch (range.kind) {
    case "single-adjacent": return "Single-adjacent attack";
    case "straight-line":   return range.includeDiagonals ? "Straight-line (8 directions)" : "Straight-line (4 directions)";
    case "die-roll-fixed":  return freeChoice ? "Choose direction" : "Die-roll determines targets";
    case "chain":           return "Chain attack";
    case "fixed-pattern":   return `Hits ${range.tiles.length} fixed tiles`;
    case "between-delvers": return "Enemies between the two delvers";
    case "choose-targets":  return `Targets of your choice within ${range.maxDistance} tiles`;
  }
  return "";
}

/**
 * Strip the printed "USE WEAPON ABILITY OR " prefix from a slot's
 * ability text for the slot-ability menu option. The prefix is
 * redundant in this context because the *previous* menu option (the
 * "Use weapon ability" button immediately above) already represents
 * that branch — surfacing it again on the slot row clutters the menu
 * and visually competes with the actual slot effect on the right.
 *
 * Matches case-insensitively and collapses one-or-more whitespace
 * runs around `OR` so the printed double-spaced source ("USE WEAPON
 * ABILITY  OR  Deal LIGHT damage...") is handled cleanly.
 */
function slotOnlyAbilityText(raw: string): string {
  return raw.replace(/^\s*USE\s+WEAPON\s+ABILITY\s+OR\s+/i, "");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
