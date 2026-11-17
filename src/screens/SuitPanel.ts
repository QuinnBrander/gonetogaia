/**
 * SuitPanel — right column of the BoardScreen.
 *
 * Renders the (active or peeked) delver's printed suit board with the
 * weapon slots, HP / movement / damage / AP overlays. The hand of
 * equipment cards is rendered separately by HeroHandPanel in the left
 * column; this panel only handles the suit board itself + slot
 * placement clicks.
 *
 * The suit JPG (`/suits/mind.jpg` or `/suits/body.jpg`) is the background.
 * HP / movement / AP / damage / weapon slot positions come from
 * `data/delverBoards.json` and are expressed as percentages so the whole
 * panel scales with the container.
 *
 * Interaction model:
 *   - Hand-card selection happens in HeroHandPanel (shared via heroSelection.ts).
 *   - Click an empty slot while a card is selected → place the card there.
 *   - Click an occupied slot while no card is selected → return to hand.
 *   - Click an occupied slot while a *different* card is selected → swap.
 *
 * State persistence: slot assignments + HP/AP/movement live on
 * `CampaignState.loadouts[heroId]` (saved to localStorage).
 */

import type { Router } from "../main";
import {
  getDelverBoard,
  getEquipment,
  getHero,
  ELEMENT_IMAGE,
  imageForRank,
  AP_BOLT_SVG_INNER,
  CONSUMABLE_TOKEN_DISPLAY,
  consumableIconInnerHtml,
} from "../data";
import type { EquipmentCard, WeaponSlotOverlay } from "../types";
import { Tuning } from "../config/tuning";
import {
  clearSelectedCard,
  damageFxDurationMs,
  getActiveHealForDelver,
  getArmedAbility,
  getModal,
  getSelectedCard,
  setLastAutoRefresh,
  setModal,
} from "../uiState";
import { playWeaponCard } from "../engine/turn";
import type { ConsumableTokenKind, DelverLoadout, HeroTurnState } from "../state";
import { getEffectiveEquipmentRanks, getPlayedWeaponCard } from "../state";
import { logEvent, snapElements, snapHeroAp, snapSlots, snapTurn } from "../debug/sessionLog";

export function renderSuitPanel(
  container: HTMLElement,
  heroId: string,
  router: Router,
): void {
  const hero = getHero(heroId);
  const overlay = getDelverBoard(hero.suit);
  const loadout = router.state.loadouts[heroId];
  if (!loadout) throw new Error(`No loadout for hero ${heroId}`);

  const selectedCardId = getSelectedCard(heroId);

  // Slot interactivity is gated on:
  //   - peeking the other delver = read-only (matches movement overlay)
  //   - the just-placed slot for this turn is irreversible (DESIGN.md §4)
  const isActive = heroId === router.state.currentDelverId;
  const turnState = router.state.encounter?.turnState[heroId] ?? null;
  const placedThisTurn = turnState?.cardPlacedThisTurn ?? null;
  const actionUsed = turnState?.actionUsedThisTurn ?? false;

  const wrap = document.createElement("section");
  wrap.className = `suit-panel suit-panel--${hero.suit}`;
  wrap.innerHTML = `
    <div class="suit-board" data-suit-board>
      <img class="suit-board-bg" src="${overlay.background}" alt="${hero.suit} suit board" draggable="false" />
      <div class="suit-overlays" data-suit-overlays></div>
    </div>
  `;
  container.appendChild(wrap);

  const overlaysLayer = wrap.querySelector<HTMLDivElement>("[data-suit-overlays]")!;

  // Per-delver effective equipment-rank table (printed rank +
  // Opinion-Card temporary bonus). Used to swap the slot-card image
  // to the rank-N art when the placed card has been levelled past
  // R1 OR when a Xavier bonus has temporarily lifted the slot's
  // effective rank for the current quest.
  const equipmentRanks = getEffectiveEquipmentRanks(router.state, heroId);

  // Suppress the green "Click to Act" pulse + badge on the just-placed
  // slot whenever a modal (counter-roll, level-up, AP-spend, etc.) is
  // open OR an ability is currently armed and awaiting a target click
  // on the board — in either case the slot tap is not the player's
  // next valid input, so pulsing it is misleading. The slot is still
  // wired to the action menu in the underlying state, just visually
  // demoted to the neutral `placed-spent` look until the gate clears.
  const actionGateOpen = getModal() == null && getArmedAbility() == null;

  overlay.weaponSlots.forEach((slot, idx) => {
    const cardId = loadout.slotCards[idx] ?? null;
    const isPlacedSlot = placedThisTurn !== null && placedThisTurn.slotIdx === idx;
    // The just-placed slot is INTERACTIVE for the active delver — clicking
    // opens the action-menu modal (DESIGN.md §5.2). Once the action has
    // been used (or not-yet-active state), the slot becomes locked again
    // and shows an "Action used" badge.
    const isPlacedActive = isActive && isPlacedSlot && !actionUsed && actionGateOpen;
    const disabled =
      !isActive || (isPlacedSlot && actionUsed) || (isPlacedSlot && !isPlacedActive);
    const slotState: SlotState = !isActive
      ? "peek-locked"
      : isPlacedActive
        ? "placed-active"
        : isPlacedSlot && actionUsed
          ? "placed-spent"
          : "interactive";
    // Resolve the rank-derived image for the placed card (if any).
    // Loadouts only ever store R1 ids, but the player may have
    // upgraded this equipment type past R1 via level-up — show the
    // R{n} art so the slot reflects what the delver actually owns.
    const placedRank = cardId
      ? (equipmentRanks[getEquipment(cardId).type] ?? 1)
      : 0;
    // Deferred auto-refresh banner gate: only paint the "WILL AUTO
    // REFRESH" affordance on the slot whose placement queued the
    // refresh, AND only while that placement's latch still carries
    // a non-null `autoRefreshedElement` (the latch is cleared at
    // end of turn via `applyDeferredAutoRefreshes`). Other-delver
    // peek view never paints the banner -- the placement latch
    // lives on the active delver's turn state, not the peeked one.
    const willAutoRefresh =
      isActive
      && isPlacedSlot
      && placedThisTurn?.autoRefreshedElement != null;
    // The card it plays as (rank- and Machinist-variant-correct).
    const shownCard = cardId ? getPlayedWeaponCard(router.state, heroId, cardId) : null;
    overlaysLayer.appendChild(buildSlotEl(slot, idx, shownCard, placedRank, selectedCardId, disabled, slotState, willAutoRefresh, () => {
      handleSlotClick(heroId, idx, router);
    }));

    // Element-token wells above this slot. Renders 0..2 token icons
    // for the slot's printed element (state.elements[heroId][slot.element]).
    // 2 tokens trigger the auto-refresh on next placement (DESIGN.md §4.3).
    const elementCount = router.state.elements[heroId]?.[slot.element] ?? 0;
    if (elementCount > 0) {
      overlaysLayer.appendChild(buildSlotElementTokens(slot, elementCount));
    }
  });

  // HP track: max-HP cube + heart-shaped current-HP marker on top.
  overlaysLayer.appendChild(buildTrackToken(
    overlay.hpTrack, loadout.maxHp, "hp",
    "track-token--max-hp",
    `Max HP: ${loadout.maxHp}`,
  ));
  overlaysLayer.appendChild(buildHeartMarker(
    overlay.hpTrack, loadout.currentHp, loadout.maxHp, hero.suit,
  ));
  // Movement track: cube is pinned to BASE movement (a permanent stat
  // readout — it never walks down during play and never extends past
  // the printed base when temporary buffs apply). Per-turn deltas
  // (movement spent OR AP-double / +1-mov slot buffs) are surfaced
  // separately via the floating `.movement-overlay-badge` below, so
  // the cube never lies about the delver's underlying stat.
  // Pre-2026-05-18 the cube tracked `currentMovement` and walked with
  // every action, which mis-read as "Boots' IMMEDIATELY effect didn't
  // stick" when an AP-double pushed the cube past the printed base
  // (track has only 6 cells; a baseMovement=2 delver doubled to 4
  // looked like baseMovement=4 then dropped back to 2 next turn).
  overlaysLayer.appendChild(buildTrackToken(
    overlay.movementTrack, loadout.baseMovement, "mov",
    "track-token--mov",
    `Base movement: ${loadout.baseMovement}`,
  ));
  // "N / M" pill rendered just outside the right edge of the
  // movement track, ONLY for the active delver and ONLY while their
  // current per-turn movement pool differs from base (i.e. they've
  // either spent some movement OR they've gained a temporary buff
  // this turn). At turn start `startHeroTurn` resets currentMovement
  // back to baseMovement and clears the AP-double latch, which
  // means current == base and the badge naturally disappears.
  if (isActive) {
    const buffActive =
      turnState?.apMovementDoubledThisTurn === true
      || turnState?.actionGrantedExtraMovement === true;
    if (loadout.currentMovement !== loadout.baseMovement || buffActive) {
      const total = computeTotalMovementThisTurn(loadout, turnState);
      overlaysLayer.appendChild(buildMovementOverlayBadge(
        overlay.movementTrack,
        loadout.currentMovement,
        total,
        buffActive,
      ));
    }
  }
  // Damage tokens — three small cubes. Move to upgradedX when the
  // delver owns a Shop Damage Bonus for that tier (e.g. product #5
  // "+1 LIGHT Damage" shifts the light token one column right).
  const dmgBonus = router.state.shopDamageBonus?.[heroId] ?? {};
  overlaysLayer.appendChild(buildDamageToken(overlay.damageLight,  "light",  "Light damage",  (dmgBonus.light  ?? 0) > 0));
  overlaysLayer.appendChild(buildDamageToken(overlay.damageMedium, "medium", "Medium damage", (dmgBonus.medium ?? 0) > 0));
  overlaysLayer.appendChild(buildDamageToken(overlay.damageHeavy,  "heavy",  "Heavy damage",  (dmgBonus.heavy  ?? 0) > 0));
  // AVAILABLE box: tap to open the AP-spend menu (DESIGN.md §4.3).
  // Active delver only; AP can be spent at any point during the
  // turn, including BEFORE the mandatory placement.
  const apBoxClickable = isActive;
  overlaysLayer.appendChild(buildAvailableBox(
    overlay.available,
    loadout.currentAp,
    loadout.baseAp,
    apBoxClickable,
    () => {
      logEvent("click.available-box", {
        heroId,
        ap: snapHeroAp(router.state, heroId),
        turn: snapTurn(router.state, heroId),
      });
      setModal({ kind: "ap-spend" });
      router.refresh();
    },
  ));

  // Resource badge rows — one per box (AVAILABLE / SPENT). Both
  // boxes share the SAME badge inventory and SAME visual grammar:
  //
  //   [AP-bolt xN] [2x-light xN] [2x-medium xN] [2x-heavy xN]
  //   [reroll xN] [prevent-counter xN]
  //
  // - AP is ALWAYS the leftmost badge — it's the universal resource
  //   every delver carries from the start of the campaign, so the
  //   yellow bolt's position is a stable anchor for the eye.
  //   Pre-2026-05-09 this lived in its own `buildApDotRow` call
  //   (one bolt-glyph per AP) which made AP visually dominate the
  //   box and forced consumable badges into a cramped second row.
  //   Now AP is one icon + an integer count, rendered identically
  //   to the rest — uniform sizing, no overlap, full use of the
  //   horizontal real estate, and the row wraps gracefully when
  //   the player owns the full Supercharger + Battery families.
  //
  // - Consumable order is stable: 3 typed Double Damage tokens
  //   (Supercharger), then 2 Battery family (Reroll → Prevent-
  //   Counter). Universal DD and Ignore-Ability are reserved kinds
  //   with no granter today and are omitted; they'll slot in next
  //   to their family when their granter ships.
  //
  // - Filter rule: keep AP unconditionally; for consumables, hide
  //   kinds the delver has never gained (available + spent both 0
  //   for the chosen variant's denominator). This keeps the row
  //   uncluttered for fresh-from-the-printed-board delvers but
  //   shows the dim x0 once a kind has been gained at any point
  //   in the run, so the player sees "yes, you have a Battery,
  //   you've just spent everything" rather than the badge
  //   disappearing.
  //
  // Pure overlay (read-only); spend interactions live in:
  //   - AP                → `ap-spend` modal (AVAILABLE-box click)
  //   - Double Damage     → `double-damage-prompt` modal (attack flow)
  //   - Reroll            → counter-roll + equipment-roll modals
  //   - Block Counterattack   → counter-roll modal's prevent button
  //
  // Image / label / spend hint live on `CONSUMABLE_TOKEN_DISPLAY`
  // in `data.ts` so the AVAILABLE-box AP-spend menu can read the
  // same data without duplicating filenames or labels.
  const bag = router.state.consumableTokens[heroId] ?? {};
  const consumableEntries: Array<{
    kind: ConsumableTokenKind;
    available: number;
    spent: number;
  }> = (
    [
      "damage-2x-light",
      "damage-2x-medium",
      "damage-2x-heavy",
      "reroll",
      "prevent-counterattack",
    ] as const satisfies readonly ConsumableTokenKind[]
  ).map((kind) => ({
    kind,
    available: bag[kind]?.available ?? 0,
    spent: bag[kind]?.spent ?? 0,
  }));
  const consumableVisible = consumableEntries.filter(
    (e) => e.available > 0 || e.spent > 0,
  );
  const apEntry: ApBadgeEntry = {
    available: Math.max(0, loadout.currentAp),
    spent: Math.max(0, loadout.baseAp - loadout.currentAp),
    titleAvailable: `AP: ${loadout.currentAp} of ${loadout.baseAp}`,
    titleSpent: `Spent AP: ${Math.max(0, loadout.baseAp - loadout.currentAp)} of ${loadout.baseAp}`,
  };
  overlaysLayer.appendChild(buildResourceBadgeRow(
    overlay.available, apEntry, consumableVisible, "available",
  ));
  overlaysLayer.appendChild(buildResourceBadgeRow(
    overlay.spent, apEntry, consumableVisible, "spent",
  ));
}

// --- Element builders ------------------------------------------------------

/** Visual / interactive state of a slot. */
type SlotState =
  /** Other delver's slot — read-only. */
  | "peek-locked"
  /** Slot just placed this turn, awaiting Action — clicking opens menu. */
  | "placed-active"
  /** Slot just placed this turn, action already used — locked + badge. */
  | "placed-spent"
  /** Normal click-to-place / click-to-return slot. */
  | "interactive";

function buildSlotEl(
  slot: WeaponSlotOverlay,
  idx: number,
  shownCard: EquipmentCard | null,
  placedRank: number,
  selectedCardId: string | null,
  disabled: boolean,
  slotState: SlotState,
  willAutoRefresh: boolean,
  onClick: () => void,
): HTMLButtonElement {
  const el = document.createElement("button");
  const empty = shownCard === null;
  const dropTarget = !disabled && empty && selectedCardId !== null;
  el.className = [
    "suit-slot",
    `suit-slot--el-${slot.element}`,
    empty ? "suit-slot--empty" : "suit-slot--filled",
    dropTarget ? "suit-slot--drop-target" : "",
    slotState === "peek-locked" ? "suit-slot--locked" : "",
    slotState === "placed-active" ? "suit-slot--placed-active" : "",
    slotState === "placed-spent" ? "suit-slot--placed-spent" : "",
    willAutoRefresh ? "suit-slot--will-auto-refresh" : "",
  ].filter(Boolean).join(" ");
  el.style.left   = `${slot.rect.x}%`;
  el.style.top    = `${slot.rect.y}%`;
  el.style.width  = `${slot.rect.w}%`;
  el.style.height = `${slot.rect.h}%`;
  el.dataset.slotIdx = String(idx);
  el.title = titleForSlot(slot, idx, shownCard, placedRank, slotState);
  if (shownCard) {
    const card = shownCard;
    const rank = Math.max(1, placedRank);
    // Upgrade art doesn't follow the ranked-filename convention.
    const image = card.image ?? imageForRank(card.suit, card.type, rank);
    // Badge stack (rendered bottom-up on the slot's bottom edge):
    //   1. WILL AUTO REFRESH -- 2026-05-21: shown for the whole
    //      turn after the placement queued an auto-refresh
    //      (deferred clear lives on `endHeroTurn`). Shown in BOTH
    //      placed-active AND placed-spent so the player still sees
    //      it after using the action; auto-suppressed by the
    //      `willAutoRefresh` gate in renderSuitPanel as soon as
    //      the latch's `autoRefreshedElement` clears.
    //   2. CLICK TO ACT / ACTION USED -- existing per-slot CTA
    //      that's mutually exclusive between the two states.
    el.innerHTML = `
      <img class="suit-slot-card" src="/cards/${image}" alt="${escapeHtml(card.name)} (R${rank})" draggable="false" />
      ${willAutoRefresh ? `<span class="suit-slot-badge suit-slot-badge--refresh" title="The slot's 2 element tokens were spent. This weapon returns to your hand at end of turn.">Will Auto Refresh</span>` : ""}
      ${slotState === "placed-active" ? `<span class="suit-slot-badge suit-slot-badge--cta">Click to Act</span>` : ""}
      ${slotState === "placed-spent"  ? `<span class="suit-slot-badge suit-slot-badge--spent">Action used</span>` : ""}
    `;
  }
  if (disabled) {
    el.disabled = true;
  } else {
    el.addEventListener("click", onClick);
  }
  return el;
}

/**
 * Render the 0..2 element-token icons that sit in the printed
 * "element wells" ABOVE the weapon card area. `count` is the
 * delver's current count of this slot's printed element (rulebook
 * p17 caps this at 2). When count == 2, placing a weapon into this
 * slot triggers the auto-refresh rule (DESIGN.md §4.3.2), spending
 * both tokens to send the weapon back to hand.
 *
 * Positioning model: the wells sit ABOVE `slot.rect`. `slot.rect`
 * measures only the weapon-card area (the orange/brown trapezoid
 * that holds the placed Weapon Card), so the wells live at NEGATIVE
 * y-offsets relative to `slot.rect.y`. The numeric magic constants
 * below were calibrated against the printed body/mind suit boards
 * — see the screenshot reference in DESIGN.md §4.3.2 for the
 * artwork layout.
 *
 * Positioning is in % of the suit-board (which is what slot.rect
 * also uses), so the tokens scale with the board responsively.
 * Pointer events are off so the underlying slot button still wins
 * clicks where the wells overlap it.
 */
function buildSlotElementTokens(
  slot: WeaponSlotOverlay,
  count: number,
): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "suit-slot-elements";
  // Wells live ABOVE slot.rect: top = rect.y - 32% of slot height,
  // wrapper is ~32% of slot height tall.
  wrap.style.left   = `${slot.rect.x}%`;
  wrap.style.top    = `${slot.rect.y - slot.rect.h * 0.40}%`;
  wrap.style.width  = `${slot.rect.w}%`;
  wrap.style.height = `${slot.rect.h * 0.32}%`;
  const filename = ELEMENT_IMAGE[slot.element];
  // Always render 2 grid cells (left well + right well). Fill
  // LEFT-TO-RIGHT — a single token sits in the left cell and the
  // right cell stays empty (transparent placeholder), matching the
  // physical board's "stack from left" convention.
  const filled = Math.min(2, count);
  for (let i = 0; i < 2; i++) {
    if (i < filled) {
      const tok = document.createElement("img");
      tok.className = "suit-slot-element";
      tok.src = `/tokens/${filename}`;
      tok.alt = `${slot.element} element`;
      tok.draggable = false;
      wrap.appendChild(tok);
    } else {
      const empty = document.createElement("div");
      empty.className = "suit-slot-element-empty";
      wrap.appendChild(empty);
    }
  }
  if (count >= 2) {
    wrap.classList.add("suit-slot-elements--ready");
    wrap.title = `2 ${slot.element} elements ready - placing a weapon here will auto-refresh it`;
  } else {
    wrap.title = `${count}/2 ${slot.element} element${count === 1 ? "" : "s"}`;
  }
  return wrap;
}

function titleForSlot(
  slot: WeaponSlotOverlay,
  idx: number,
  shownCard: EquipmentCard | null,
  placedRank: number,
  slotState: SlotState,
): string {
  if (shownCard) {
    const card = shownCard;
    const rankSuffix = placedRank > 1 ? ` R${placedRank}` : "";
    if (slotState === "placed-active") {
      return `Slot ${idx + 1}: ${card.name}${rankSuffix} - click for Action menu`;
    }
    if (slotState === "placed-spent") {
      return `Slot ${idx + 1}: ${card.name}${rankSuffix} (action used)`;
    }
    return `Slot ${idx + 1}: ${card.name}${rankSuffix}`;
  }
  return `Slot ${idx + 1} (${slot.element}) - ${slot.slotAbilityText}`;
}

/**
 * Compute the pct-X centre of a cell on a labelled track. HP track is
 * labelled 0..21 (so value V → cell index V), movement is labelled 1..6
 * (so value V → cell index V-1).
 */
function trackCellLeftPct(
  track: { x0: number; x1: number; cells: number },
  currentValue: number,
  kind: "hp" | "mov",
): number {
  const cellWidth = (track.x1 - track.x0) / track.cells;
  const cellIndex = kind === "hp"
    ? Math.max(0, Math.min(track.cells - 1, currentValue))
    : Math.max(0, Math.min(track.cells - 1, currentValue - 1));
  return track.x0 + (cellIndex + 0.5) * cellWidth;
}

/**
 * "Total movement budget this turn" for the active delver, accounting
 * for the AP-double-movement spend and any +1-mov slot ability that
 * fired (both can stack — slot ability is doubled by the AP-double
 * latch in `slotAbilities.ts`). Spec mirrors the engine math in
 * `engine/turn.ts > spendApDoubleMovement` and
 * `engine/slotAbilities.ts > resolveBonusMovement` so the badge
 * always reads the same total the engine just computed.
 *
 * Returns `loadout.baseMovement` when no buff is active.
 *
 * Exported for `__tests__/movementOverlay.test.ts` — pure math, no
 * DOM access, safe to unit-test in isolation.
 */
export function computeTotalMovementThisTurn(
  loadout: DelverLoadout,
  turnState: HeroTurnState | null | undefined,
): number {
  const doubled = turnState?.apMovementDoubledThisTurn === true;
  // The `+1 mov` slot ability (usable only before moving) is tracked by
  // the display flag `actionGrantedExtraMovement`, independently of
  // doubling, so the buffed total is `base * mult + extra * mult`
  // — and we take the larger of that and the current pool so a
  // buffed delver who has ALREADY spent movement still sees the
  // pre-spend total as the denominator. Concretely:
  //   - base 2, doubled, +1 mov, 0 spent  -> total = 4 + 2 = 6,  cur = 6,  badge "6 / 6"
  //   - base 2, doubled, +1 mov, 3 spent  -> total = 6,           cur = 3,  badge "3 / 6"
  //   - base 2, no buff,    0 spent      -> badge hidden (cur == base)
  //   - base 2, no buff,    1 spent      -> total = 2,           cur = 1,  badge "1 / 2"
  const mult = doubled ? 2 : 1;
  const extra = turnState?.actionGrantedExtraMovement ? 1 : 0;
  const buffedTotal = loadout.baseMovement * mult + extra * mult;
  return Math.max(buffedTotal, loadout.currentMovement, loadout.baseMovement);
}

/**
 * Floating "current / total movement this turn" badge anchored
 * BELOW the movement track row, aligned to the LEFT of the printed
 * "MOVEMENT" label (so it slots into the otherwise-empty whitespace
 * to the left of that word). Non-interactive (pure status readout).
 * Disappears when current == base and no buff is active — see the
 * gate in `renderSuitPanel`.
 *
 * `buffActive` toggles a subtle accent (yellow) so the player can
 * tell at a glance "I bought / earned a buff this turn" vs. "I'm
 * just down on spend".
 *
 * Pre-2026-05-18-late this badge was anchored to the RIGHT of the
 * track and overlapped the XP / End-Turn topbar at high counts; the
 * below-track placement keeps it inside the suit-board frame and
 * gives the player a stable left-of-label reading position that
 * doesn't shift width as the numbers grow.
 */
function buildMovementOverlayBadge(
  track: { x0: number; x1: number; y: number; cells: number },
  current: number,
  total: number,
  buffActive: boolean,
): HTMLDivElement {
  const el = document.createElement("div");
  el.className = `movement-overlay-badge${buffActive ? " movement-overlay-badge--buffed" : ""}`;
  // `track.y` is the vertical centre of the track row in suit-board
  // %; push down ~3.5% to clear the cube and land in the label band.
  // `track.x0` is the LEFT edge of the track — same horizontal
  // anchor as the "MOVEMENT" word starts, so the badge sits flush
  // to its left in the negative space the label leaves behind.
  el.style.left = `${track.x0}%`;
  el.style.top  = `${track.y + 3.5}%`;
  el.title = buffActive
    ? `Movement this turn: ${current} of ${total} (buffed)`
    : `Movement this turn: ${current} of ${total}`;
  el.textContent = `${current} / ${total}`;
  return el;
}

/**
 * A small cube/diamond "token" sitting on a track cell. Used for max-HP
 * and current-movement markers. Heart marker for current HP is separate.
 */
function buildTrackToken(
  track: { x0: number; x1: number; y: number; cells: number },
  currentValue: number,
  kind: "hp" | "mov",
  extraClass: string,
  title: string,
): HTMLDivElement {
  const left = trackCellLeftPct(track, currentValue, kind);
  const el = document.createElement("div");
  el.className = `track-token ${extraClass}`;
  el.style.left = `${left}%`;
  el.style.top  = `${track.y}%`;
  el.title = title;
  return el;
}

/**
 * Heart-shaped current-HP marker. Sits ON TOP of the max-HP token at the
 * current-HP cell. Always rendered, even at full HP (where it overlaps the
 * max-HP cube exactly so they read as a stacked pair).
 *
 * When this delver was healed in the recent FX window (see
 * `getActiveHealForDelver` in `uiState.ts`), the marker gets a
 * `--just-healed` modifier class plus a negative `animation-delay`
 * matching the elapsed time so a re-render mid-animation picks up
 * where the pulse was rather than restarting from frame 0. CSS
 * keyframe (`heart-marker-pulse`) drives the green pulse + scale
 * pop. Without this the heal would land silently on the topbar
 * even though the rewards modal showed a +N HP card.
 */
function buildHeartMarker(
  track: { x0: number; x1: number; y: number; cells: number },
  currentHp: number,
  maxHp: number,
  suit: "mind" | "body",
): HTMLDivElement {
  const left = trackCellLeftPct(track, currentHp, "hp");
  const el = document.createElement("div");
  el.className = "track-token track-token--current-hp";
  el.style.left = `${left}%`;
  el.style.top  = `${track.y}%`;
  el.title = `Current HP: ${currentHp} / ${maxHp}`;
  const heal = getActiveHealForDelver(suit);
  if (heal) {
    el.classList.add("track-token--just-healed");
    const elapsed = Math.max(0, Math.min(damageFxDurationMs(), performance.now() - heal.startedAt));
    el.style.setProperty("--heart-pulse-delay", `-${elapsed.toFixed(0)}ms`);
  }
  el.innerHTML = `
    <svg viewBox="0 0 24 22" aria-hidden="true">
      <path d="M12 21.5 L2.5 11.5 A5.5 5.5 0 0 1 12 5.0 A5.5 5.5 0 0 1 21.5 11.5 Z"
            fill="#e93b3b"
            stroke="#fff"
            stroke-width="1.6"
            stroke-linejoin="round" />
    </svg>
  `;
  return el;
}

/**
 * Damage token sitting at the base-value column of the Light/Medium/Heavy
 * damage row. Town upgrades (later) will move it to the upgradedX column.
 */
function buildDamageToken(
  dmg: { baseX: number; shopBonusX: number; upgradedX: number; y: number },
  tier: "light" | "medium" | "heavy",
  title: string,
  upgraded: boolean = false,
): HTMLDivElement {
  const el = document.createElement("div");
  el.className = `track-token track-token--dmg track-token--dmg-${tier}`;
  el.style.left = `${upgraded ? dmg.shopBonusX : dmg.baseX}%`;
  el.style.top  = `${dmg.y}%`;
  el.title = title;
  return el;
}

/**
 * AP-side input to {@link buildResourceBadgeRow} — pre-computed so
 * the row builder doesn't have to know about loadout shape (it's a
 * pure presentation helper).
 */
interface ApBadgeEntry {
  /** AP currently available to spend (= `loadout.currentAp`). */
  available: number;
  /** AP already spent this wave (= `baseAp - currentAp`). */
  spent: number;
  /** Tooltip for the AP badge in the AVAILABLE row. */
  titleAvailable: string;
  /** Tooltip for the AP badge in the SPENT row. */
  titleSpent: string;
}

/**
 * Unified resource-badge row rendered along the BOTTOM of either
 * the AVAILABLE or SPENT box. AP is the leftmost badge, followed by
 * any visible consumable kinds, all rendered with the same visual
 * grammar:
 *
 *   [icon-16x16] xN
 *
 * - `variant === "available"` reads each entry's `available` count
 *   and renders the AP icon as the bright yellow lit-bolt.
 * - `variant === "spent"` reads each entry's `spent` count and
 *   renders the AP icon as the muted grey spent-bolt.
 *
 * Badges with `count === 0` render with the `--zero` modifier
 * (dimmed icon + grayed count), keeping the row's layout stable
 * across spend/refill ticks. The flex container wraps so even when
 * the player owns the full Supercharger (3) + Battery (2) + AP (1)
 * = 6-badge inventory, nothing overflows into / overlaps the
 * "AVAILABLE" / "SPENT" word printed at the top of each box.
 *
 * Pure presentation; spend / refill logic lives elsewhere
 * (`engine/tokens.ts` for the consumable bag, `engine/turn.ts >
 * chargeAp` for AP, and the various spend-time modals in
 * `screens/ActionResolution.ts`).
 *
 * Pre-2026-05-09 this was two separate rows: `buildApDotRow`
 * (which stacked one yellow lightning glyph PER AP, dominating
 * the box) and `buildConsumableTokenRow` (one badge per kind,
 * uniform 16px). Merging them under the badge model gives every
 * token type the same visual weight per the player request: same
 * icon size, no overlap, full use of the box's horizontal space.
 */
function buildResourceBadgeRow(
  rect: { x: number; y: number; w: number; h: number },
  ap: ApBadgeEntry,
  consumables: Array<{
    kind: ConsumableTokenKind;
    available: number;
    spent: number;
  }>,
  variant: "available" | "spent",
): HTMLDivElement {
  const row = document.createElement("div");
  row.className = `consumable-row consumable-row--${variant}`;
  // Anchor: bottom-centred inside the box. CSS uses transform:
  // translate(-50%, -100%) so the row's bottom edge lines up just
  // inside the bottom of the box, leaving the AVAILABLE / SPENT
  // header label's vertical real estate clear.
  row.style.left   = `${rect.x + rect.w / 2}%`;
  row.style.top    = `${rect.y + rect.h - 5}%`;
  // Cap horizontal width so flex-wrap can do its job — without a
  // width constraint the absolute-positioned row would otherwise
  // overflow off the right edge of the box at long bag inventories.
  row.style.width  = `${rect.w - 6}%`;

  // Responsive icon sizing — bumps the badge size up when the row
  // is sparse and shrinks it back down at the rare 6-kind extreme.
  // Most-of-the-game state is just AP (1) or AP + a couple of
  // damage tokens (2-3 badges); at those counts the icons can be
  // significantly larger without overflowing the box. Once the
  // delver picks up the full Supercharger + Battery inventory
  // (3 + 2 + AP = 6 badges), we fall back to the original 20px so
  // everything still fits on a single row inside the box.
  //
  // Sizing applied via a `--badge-icon-size` CSS custom property
  // on the row element so the badge / icon / count classes can
  // all read from one source. The count text scales with the
  // icon (~45% of icon size, clamped to a readable minimum) so
  // the badge stays visually balanced at every step.
  // Sizes bumped 2026-05-20 on user feedback that the badges read
  // too small in the AVAILABLE / SPENT boxes. Each step grows
  // ~30-35%; the 6-badge extreme grows the least so the full
  // Supercharger + Battery inventory still fits in the box without
  // wrapping aggressively. Text floor raised to 13px so the count
  // stays crisp even at the smallest icon step.
  const totalBadges = 1 + consumables.length;
  const iconPx =
    totalBadges <= 3 ? 48 :
    totalBadges <= 4 ? 40 :
    totalBadges <= 5 ? 32 :
    26;
  row.style.setProperty("--badge-icon-size", `${iconPx}px`);
  row.style.setProperty("--badge-text-size", `${Math.max(13, Math.round(iconPx * 0.45))}px`);

  // 1) AP badge — synthetic kind: rendered with the inline
  // AP_BOLT_SVG_INNER + a `consumable-badge--ap` modifier so CSS
  // can paint the bolt yellow (lit) or grey (spent).
  //
  // Hidden entirely when the count is zero (per user request
  // 2026-05-20): the previous behaviour rendered an "x0" badge
  // even when the box held no AP, which read as visual noise on
  // a frequently-zero side of the row (e.g. the spent box on
  // turn 1). Empty box now means empty box. The AVAILABLE box's
  // click region is independent of badge presence, so omitting
  // the badge doesn't lose any interaction surface.
  const apCount = variant === "available" ? ap.available : ap.spent;
  if (apCount > 0) {
    const apBadge = document.createElement("div");
    apBadge.className = "consumable-badge consumable-badge--ap";
    apBadge.title = variant === "available" ? ap.titleAvailable : ap.titleSpent;
    apBadge.innerHTML = `
      <span class="consumable-icon">${AP_BOLT_SVG_INNER}</span>
      <span class="consumable-badge-count">x${apCount}</span>
    `;
    row.appendChild(apBadge);
  }

  // 2) Consumable badges — same visual grammar, in stable order.
  // Same zero-hides-completely rule as the AP badge above (user
  // request 2026-05-20): an "x0" badge is visual noise; empty
  // box now means empty box across both AP and consumables.
  for (const e of consumables) {
    const meta = CONSUMABLE_TOKEN_DISPLAY[e.kind];
    const count = variant === "available" ? e.available : e.spent;
    if (count === 0) continue;
    const badge = document.createElement("div");
    badge.className = "consumable-badge";
    badge.title = `${meta.label} (${variant}): ${count}`;
    badge.innerHTML = `
      <span class="consumable-icon">${consumableIconInnerHtml(e.kind)}</span>
      <span class="consumable-badge-count">x${count}</span>
    `;
    row.appendChild(badge);
  }

  return row;
}

/**
 * Transparent click region overlaid on the AVAILABLE box of the suit
 * board. When clickable, opens the AP-spend menu via `onClick`. When
 * not (e.g. peeking the off-turn delver, or stage 1 still pending),
 * renders as an inert div with a tooltip explaining why.
 */
function buildAvailableBox(
  rect: { x: number; y: number; w: number; h: number },
  currentAp: number,
  baseAp: number,
  clickable: boolean,
  onClick: () => void,
): HTMLElement {
  const el = clickable
    ? document.createElement("button")
    : document.createElement("div");
  el.className = `available-box${clickable ? " available-box--clickable" : ""}`;
  el.style.left   = `${rect.x}%`;
  el.style.top    = `${rect.y}%`;
  el.style.width  = `${rect.w}%`;
  el.style.height = `${rect.h}%`;
  el.title = clickable
    ? `Spend AP (${currentAp} of ${baseAp} available)`
    : `AP: ${currentAp} of ${baseAp}`;
  if (clickable) {
    (el as HTMLButtonElement).addEventListener("click", onClick);
  }
  return el;
}

// --- Click handlers --------------------------------------------------------

function handleSlotClick(heroId: string, slotIdx: number, router: Router): void {
  const state = router.state;

  // Click-entry trace — captures EVERY slot-click before any short-circuit
  // returns, so a bug report always shows what was clicked even if the
  // engine never ran. The corresponding `engine.*` row (if any) follows
  // immediately after.
  logEvent("click.slot", {
    heroId,
    slotIdx,
    selectedCardId: getSelectedCard(heroId),
    isCurrentDelver: heroId === state.currentDelverId,
    slots: snapSlots(state, heroId),
    turn: snapTurn(state, heroId),
    ap: snapHeroAp(state, heroId),
  });

  // Defensive: peek + just-placed-spent are also blocked at the button
  // level via `disabled`, but re-check here in case anything binds the
  // click path differently.
  if (heroId !== state.currentDelverId) return;

  const loadout = state.loadouts[heroId];
  if (!loadout) return;

  const ts = state.encounter?.turnState[heroId] ?? null;
  const placed = ts?.cardPlacedThisTurn ?? null;
  const actionUsed = ts?.actionUsedThisTurn ?? false;

  // Click on the JUST-PLACED slot (and Action not yet used) → open the
  // action-menu modal (DESIGN.md §5.2). The modal lives in BoardScreen.
  if (placed && placed.slotIdx === slotIdx && !actionUsed) {
    logEvent("modal.open", { kind: "action-menu", slotIdx });
    setModal({ kind: "action-menu", slotIdx });
    router.refresh();
    return;
  }
  if (placed && placed.slotIdx === slotIdx) return; // action already used

  const selectedCardId = getSelectedCard(heroId);

  // If a weapon is selected, this is a placement attempt — route through
  // the turn engine so the mandatory-placement rules apply (DESIGN.md §4
  // stage 1). On rejection, no-op for now (no toast in this slice).
  if (selectedCardId !== null) {
    const sel = getEquipment(selectedCardId);
    if (sel.category === "weapon") {
      // Snapshot the element bag BEFORE the call — the auto-refresh
      // decision (DESIGN.md §4.3) hinges entirely on this slice, so
      // logging it on the same row as the result is what makes the
      // "should have auto-refreshed but didn't" bug-class diagnosable.
      const elementsBefore = snapElements(state, heroId);
      const r = playWeaponCard(state, heroId, slotIdx, selectedCardId);
      logEvent("engine.playWeaponCard", {
        heroId,
        slotIdx,
        cardId: selectedCardId,
        result: r.ok ? "ok" : `fail:${r.reason}`,
        autoRefresh: r.ok && r.autoRefresh
          ? { cardId: r.autoRefresh.cardId, element: r.autoRefresh.element }
          : null,
        elementsBefore,
        elementsAfter: snapElements(state, heroId),
        slotsAfter: snapSlots(state, heroId),
        turnAfter: snapTurn(state, heroId),
        apAfter: snapHeroAp(state, heroId),
      });
      if (!r.ok) return;
      // Auto-refresh fired? Stash a transient toast so BoardScreen
      // can surface "Refreshed! Weapon returned to hand (spent 2 X)".
      // Cleared on End Turn / next placement / dismiss.
      if (r.autoRefresh) {
        setLastAutoRefresh({
          reason: "element-stack",
          heroId,
          cardId: r.autoRefresh.cardId,
          cardName: getPlayedWeaponCard(router.state, heroId, r.autoRefresh.cardId).name,
          element: r.autoRefresh.element,
        });
      } else {
        setLastAutoRefresh(null);
      }
      clearSelectedCard(heroId);
      router.save();
      return;
    }
  }

  // No selection (or non-weapon selected) on a slot that isn't the
  // just-placed one: strict no-op. The legacy `resolveSlotClick`
  // fallback used to free-remove the card from an occupied prior-turn
  // slot here, which bypassed the AP-refresh contract entirely
  // (DESIGN.md §5.5.1 — refresh is a 2-AP spend, not a free click).
  // User repro 2026-05-18: clicking a placed Gauntlet with no card
  // selected returned it to hand without spending AP, letting players
  // recycle weapons for free. Removed 2026-05-18; the only legitimate
  // ways to clear a placed slot mid-wave are (a) `spendApRefreshWeapon`
  // via the AVAILABLE-box menu, (b) `undoWeaponPlacement` mid-turn
  // before any action/movement, or (c) the element auto-refresh rule.
}

// --- Misc ------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Tuning re-export so future modules can find the slot count constant via SuitPanel.
export const SUIT_PANEL_SLOTS = Tuning.weaponSlotsPerSuit;
