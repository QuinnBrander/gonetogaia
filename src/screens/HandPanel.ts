/**
 * HandPanel — the (active or peeked) delver's hand of equipment cards.
 *
 * Positioned beneath the Suit Board in the right column of the BoardScreen.
 * Click a hand card to "select" it; then click an empty weapon slot on the
 * SuitPanel above to place it. Selection state is shared with SuitPanel
 * via `heroSelection.ts`.
 *
 * The hand is computed from `state.equipmentRanks[heroId]` — every
 * equipment type owned at rank >= 1 appears in the hand at the
 * rank-correct image (`imageForRank`), MINUS anything currently
 * placed in a slot. Starting equipment seeds the rank table at R1
 * for each starter type; level-up choices add new types at R1 and
 * upgrade existing types past R1.
 *
 * Passive cards (Boots, Armor, Battery, Supercharger) are NOT
 * clickable from the hand — their IMMEDIATELY effects fire at
 * acquisition (see `state.ts > applyImmediatePassiveEffects`) and
 * their ONGOING effects are triggered from the board itself
 * (Boots ONGOING: adjacent enemies are auto-painted as
 * "boots-targetable" by `ActionResolution.ts > renderActionTargets`
 * whenever `canActivateBootsOngoing` is true — see DESIGN.md §5.5).
 * Pre-2026-05-18 the Boots card pulsed green in the hand to act as
 * the activation affordance, which players read as "tap me to apply
 * the IMMEDIATELY effect" — the highlight has been moved to the
 * board side so passives never imply a hand-side click.
 *
 * Layout:
 *   - Up to 8 cards are shown at once in a 2-row wrapping grid (4 per row).
 *   - If the hand exceeds 8 cards, a tab strip ABOVE the cards lets the
 *     player switch layers ("Cards 1–8" / "Cards 9–11"). It used to be a
 *     `‹ 1/2 ›` pager BELOW the grid, which fell off the bottom of the
 *     screen on a full hand (user report 2026-11-15).
 *   - Page state is tracked per-hero in `handPageByHero`; it resets to 0
 *     whenever the visible hand size changes (e.g. a card is placed).
 */

import type { Router } from "../main";
import { getHero, getEquipmentByTypeSuit, imageForRank } from "../data";
import type { EquipmentCard, EquipmentType } from "../types";
import { ALL_EQUIPMENT_TYPES } from "../types";
import {
  getArmedAbility,
  getModal,
  getSelectedCard,
  toggleSelectedCard,
} from "../uiState";
import { getEffectiveEquipmentRanks, getEquipmentCardFor } from "../state";
import { logEvent } from "../debug/sessionLog";

/** Cards shown per page (fills a 4 × 2 grid). */
const PAGE_SIZE = 8;

/** Per-hero current page index. Resets when hand size changes. */
const handPageByHero: Record<string, { page: number; lastHandSize: number }> = {};

export function renderHandPanel(
  container: HTMLElement,
  heroId: string,
  router: Router,
): void {
  const hero = getHero(heroId);
  const loadout = router.state.loadouts[heroId];
  if (!loadout) throw new Error(`No loadout for hero ${heroId}`);
  // Effective ranks (printed + Opinion-Card temporary bonus) so a
  // Xavier Ally +1 RANK that lifts an unowned slot from R0 to R1
  // surfaces a fresh card in the delver's hand, and a Detractor
  // -1 RANK that pushes an owned slot to R0 hides it for the quest.
  const ranks = getEffectiveEquipmentRanks(router.state, heroId);
  // Build the OWNED set: every (suit, type) where rank >= 1. Iterates
  // ALL_EQUIPMENT_TYPES so the order is the deterministic deck order
  // (Gauntlet first, Battery last) regardless of pickup sequence.
  const owned: Array<{ card: EquipmentCard; rank: number; display: EquipmentCard }> = [];
  for (const type of ALL_EQUIPMENT_TYPES) {
    const rank = ranks[type] ?? 0;
    if (rank < 1) continue;
    const card = getEquipmentByTypeSuit(hero.suit, type);
    // `card` (the standard R1 entry) stays the MECHANICAL identity —
    // slotCards / selection / placement all key on its id. `display`
    // is the variant- and rank-correct card (2026-07-22) so a
    // Machinist-replaced family shows its own art + name (Shock
    // Gauntlet, Cyclone Boots, Earth's Embrace Shield).
    const display = getEquipmentCardFor(router.state, heroId, type, rank);
    owned.push({ card, rank, display });
  }
  const placed = new Set(loadout.slotCards.filter((id): id is string => !!id));
  const hand = owned.filter(({ card }) => !placed.has(card.id));
  const selectedCardId = getSelectedCard(heroId);

  // "Actionable" weapons get the green pulsing outline (same visual
  // vocabulary as `.suit-slot--placed-active` once a card is placed)
  // while THIS hero is the active delver and has not yet placed a
  // card this turn. We only paint it on the active delver — peeking
  // the other delver's hand should NOT pulse, since they aren't
  // choosing right now.
  //
  // Also suppressed whenever a modal (level-up, AP-spend, etc.) is
  // open or an ability is currently armed — in either case the click
  // isn't the player's next valid input, so pulsing it is misleading.
  //
  // ALSO gated on `enc.phase === "hero"` so the pre-wave pickers
  // (first-turn-pick, delver-spawn-pick) — which embed this panel
  // read-only to let the player inspect each loadout before
  // committing — don't paint pulses on hand cards the engine will
  // refuse to act on. Without this gate every weapon in the hand
  // would glow during the first-turn picker even though clicking
  // does nothing.
  const isActiveHero = router.state.currentDelverId === heroId;
  const isHeroPhase = router.state.encounter?.phase === "hero";
  const turnState = router.state.encounter?.turnState[heroId];
  const hasPlacedThisTurn = turnState?.cardPlacedThisTurn != null;
  const inputGateOpen = getModal() == null && getArmedAbility() == null;
  const showActionable = isActiveHero && isHeroPhase && !hasPlacedThisTurn && inputGateOpen;

  // Passive ONGOING activation (Boots) is NOT exposed via the hand
  // anymore — see file header. The bearer triggers it by tapping a
  // highlighted adjacent enemy on the board instead. The hand only
  // surfaces the weapon-placement flow.

  const wrap = document.createElement("section");
  wrap.className = `hand-panel hand-panel--${hero.suit}`;

  if (hand.length === 0) {
    wrap.innerHTML = `<span class="muted small">All equipment placed</span>`;
    container.appendChild(wrap);
    return;
  }

  // --- Pagination ----------------------------------------------------------
  // Reset page to 0 if the hand size changed since last render (a card was
  // placed or returned). Keeps the pager in sync without stale offsets.
  const pageState = handPageByHero[heroId] ?? { page: 0, lastHandSize: hand.length };
  if (pageState.lastHandSize !== hand.length) {
    pageState.page = 0;
    pageState.lastHandSize = hand.length;
  }
  handPageByHero[heroId] = pageState;

  const needsPager = hand.length > PAGE_SIZE;
  const totalPages = Math.ceil(hand.length / PAGE_SIZE);
  // Clamp in case the hand shrank and our page is now out of range.
  if (pageState.page >= totalPages) pageState.page = totalPages - 1;

  const pageStart = pageState.page * PAGE_SIZE;
  const pageEnd = Math.min(pageStart + PAGE_SIZE, hand.length);
  const pageHand = hand.slice(pageStart, pageEnd);

  // --- Cards ---------------------------------------------------------------
  for (const entry of pageHand) {
    const isWeapon = entry.card.category === "weapon";
    // A weapon in hand is SELECTABLE only when the active delver
    // could legally place it right now: same gate as the green
    // pulsing "actionable" highlight (`showActionable`) — active
    // delver, hasn't already placed their mandatory card this
    // turn, no modal / armed ability blocking input, AND not while
    // the player is peeking the OTHER delver's hand. Pre-fix this
    // was just `isWeapon`, so a player who'd already placed (or
    // who was peeking) could "select" a weapon, click a slot, and
    // see the engine reject opaquely with "already placed a card
    // this turn" — see the 2026-05-09 user report (Soulshift Sword
    // appeared selectable after the gauntlet placement+swing,
    // making it look like a second placement was available).
    const weaponSelectable = isWeapon && showActionable;
    const onClick = () => {
      const wasSelected = getSelectedCard(heroId) === entry.card.id;
      logEvent("click.hand.toggle-card", {
        heroId,
        cardId: entry.card.id,
        cardName: entry.card.name,
        action: wasSelected ? "deselect" : "select",
      });
      toggleSelectedCard(heroId, entry.card.id);
      router.save(); // re-render so SuitPanel sees the new selection too
    };
    wrap.appendChild(buildHandCardEl(
      entry.display,
      entry.rank,
      entry.card.id === selectedCardId,
      weaponSelectable,
      weaponSelectable,
      onClick,
    ));
  }

  // A short last layer is padded with invisible card spaces so the grid
  // (and the tabs above it) keeps the same size and position as layer 1 —
  // otherwise the vertically-centred stack shifts and the tabs jump.
  if (needsPager) {
    for (let i = pageHand.length; i < PAGE_SIZE; i++) {
      const spacer = document.createElement("div");
      spacer.className = "hand-card hand-card--spacer";
      spacer.setAttribute("aria-hidden", "true");
      wrap.appendChild(spacer);
    }
  }

  // --- Layer tabs ----------------------------------------------------------
  // One tab per layer of 8 cards, placed ABOVE the grid so it's always
  // on screen. Clicking a tab jumps straight to that layer (and back).
  if (needsPager) {
    const tabs = document.createElement("div");
    tabs.className = "hand-tabs";
    tabs.setAttribute("role", "tablist");
    for (let page = 0; page < totalPages; page++) {
      const first = page * PAGE_SIZE + 1;
      const last = Math.min((page + 1) * PAGE_SIZE, hand.length);
      const isActive = page === pageState.page;
      const tab = document.createElement("button");
      tab.className = `hand-tab${isActive ? " hand-tab--active" : ""}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(isActive));
      tab.dataset["handTab"] = String(page);
      tab.textContent = first === last ? `Card ${first}` : `Cards ${first}\u2013${last}`;
      tab.addEventListener("click", () => {
        if (pageState.page === page) return;
        logEvent("click.hand.tab", { heroId, page });
        pageState.page = page;
        router.save();
      });
      tabs.appendChild(tab);
    }
    container.appendChild(tabs);
  }
  container.appendChild(wrap);
}

function buildHandCardEl(
  card: EquipmentCard,
  rank: number,
  selected: boolean,
  selectable: boolean,
  actionable: boolean,
  onClick: () => void,
): HTMLButtonElement {
  const el = document.createElement("button");
  // Passive cards can't be played as a turn action, so we render them
  // unselectable here. They still appear in the hand (for visibility) but
  // ignore clicks and use a muted visual style.
  el.className = [
    "hand-card",
    selected && "hand-card--selected",
    !selectable && "hand-card--passive",
    actionable && "hand-card--actionable",
  ].filter(Boolean).join(" ");
  el.disabled = !selectable;
  // The display card's own `image` field is authoritative — ranked
  // standard cards AND Machinist upgrade cards each carry their
  // exact filename (upgrade art doesn't follow the
  // `card_{suit}_{type}_r{n}.jpg` convention).
  const image = card.image ?? imageForRank(card.suit, card.type as EquipmentType, rank);
  const altSuffix = rank > 1 ? ` (R${rank})` : "";
  el.innerHTML = `
    <img src="/cards/${image}" alt="${escapeHtml(card.name)}${altSuffix}" draggable="false" />
  `;
  if (selectable) el.addEventListener("click", onClick);
  return el;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
