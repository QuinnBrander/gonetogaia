/**
 * HeroPick — quest-start "which printed Hero Card am I bringing
 * into this quest?" picker. Renders BEFORE the encounter is built
 * (or before the DelverSpawnPick for Q2+ spawn-deck waves), one
 * delver at a time, for any delver that owns 2+ hero cards of
 * their suit.
 *
 * Rendered when `state.pendingHeroPickDelvers.length > 0`. The
 * queue is populated by `engine/heroPick.ts >
 * populatePendingHeroPicks` from BoardScreen's render entry
 * point. Each commit pops the head of the queue and refreshes —
 * if more delvers remain, the screen re-renders for the next
 * one; once empty, BoardScreen proceeds with `ensureEncounter` +
 * the regular wave flow.
 *
 * Layout:
 *
 *   +----------------------------------------------------------+
 *   | TopBar: Quest #N - <name>  ·  Mind Delver: choose a card |
 *   |         [View Shop Products]                  [Back]     |
 *   +----------------------------------------------------------+
 *   |                                                          |
 *   |  +-------+   +-------+   +-------+                       |
 *   |  | Card1 |   | Card3 |   | Card5 |   (owned cards only,  |
 *   |  | (art) |   | (art) |   | (art) |    filtered by suit)  |
 *   |  +-------+   +-------+   +-------+                       |
 *   |                                                          |
 *   |  Click a card to select. Hero Cards print starting       |
 *   |  loadout + special ability text on the back.             |
 *   |                                                          |
 *   |                       [Confirm Pick]                     |
 *   +----------------------------------------------------------+
 *
 * Why a button (not a modal) for Shop Products:
 *   - The product art is dense and the player needs to study it
 *     against the hero card art to make a strategic choice. A
 *     modal that the player can pop open / close repeatedly is
 *     less context-thrashing than an inline panel that pushes
 *     the hero grid below the fold.
 *   - Mirrors the Shop wallet's existing pattern (same modal —
 *     `presentShopProducts` is reused) so the player sees the
 *     same UI they're used to from the Visit-the-Shops phase.
 *
 * Why a separate screen (not an encounter phase):
 *   - The hero pick is a CAMPAIGN-level decision (it predates
 *     the encounter — see `engine/heroPick.ts` doc block). Living
 *     outside the encounter keeps the EncounterPhase enum
 *     clean + means every existing encounter test (which never
 *     simulates the picker) stays green.
 *   - BoardScreen's "if pendingHeroPickDelvers.length > 0,
 *     render HeroPick and return" gate is the only integration
 *     point — no router-table changes needed.
 *
 * Added 2026-05-20 alongside `engine/heroPick.ts` + the v40 → v41
 * schema migration that introduced `activeHeroCardByDelver`,
 * `pendingHeroPickDelvers`, `heroPicksAppliedQuests`.
 */

import type { Router } from "../main";
import { HERO_CARDS, getHero, getQuestData } from "../data";
import { commitHeroPick, ownedHeroCardNumbersForSuit } from "../engine/heroPick";
import { presentShopProducts } from "./ShopProductsModal";
import { presentEquipmentCards } from "./EquipmentCardsModal";
import { logEvent } from "../debug/sessionLog";

/**
 * Module-local selection state. Keyed by heroId so a back-and-forth
 * (e.g. View Shop Products → return) preserves the player's tentative
 * pick. Cleared after `commitHeroPick` succeeds. Lives outside the
 * router because it's pure UI state — no need to persist a card # the
 * player hasn't confirmed yet.
 */
let selectedCardByHero: Record<string, number> = {};

/** Reset transient pick selection — e.g. when leaving the screen for
 * the title or when the queue is cleared by a hot-reload artifact.
 * Exported so future "Cancel pick" / "Reset campaign" wiring can
 * keep this module honest. */
export function resetHeroPickSelection(): void {
  selectedCardByHero = {};
}

export function renderHeroPickScreen(root: HTMLElement, router: Router): void {
  const state = router.state;
  const pendingHeroId = state.pendingHeroPickDelvers[0];
  if (!pendingHeroId) {
    // Defensive: caller should have checked queue length before
    // dispatching here. Falling back to a "nothing to pick"
    // placeholder is friendlier than throwing.
    renderEmptyQueuePlaceholder(root, router);
    return;
  }

  const hero = getHero(pendingHeroId);
  const quest = getQuestData(state.currentQuestId);
  const ownedNumbers = ownedHeroCardNumbersForSuit(state, hero.suit);
  const delverLabel = hero.suit === "mind" ? "Mind Delver" : "Body Delver";

  // Seed the tentative pick to the delver's currently-active card
  // (defaults to the starter on a fresh campaign) so the player
  // always has SOMETHING selected when they land — confirms work
  // as a "yes, keep this" gesture rather than forcing a click just
  // to enable the button. Selection is sticky if they've already
  // hovered + picked another card, since the seed only fires for
  // unseeded hero ids.
  if (selectedCardByHero[pendingHeroId] === undefined) {
    const active = state.activeHeroCardByDelver[pendingHeroId];
    selectedCardByHero[pendingHeroId] =
      typeof active === "number" && ownedNumbers.includes(active) ? active : ownedNumbers[0]!;
  }
  const selectedCardNumber = selectedCardByHero[pendingHeroId]!;

  logEvent("heroPick.render", {
    questId: quest.id,
    heroId: pendingHeroId,
    suit: hero.suit,
    ownedCount: ownedNumbers.length,
    selected: selectedCardNumber,
    remaining: state.pendingHeroPickDelvers.length,
  });

  const wrap = document.createElement("div");
  // Reuse the storybook screen frame so we get the ambient dark
  // backdrop + centered stage that the Story screen uses — feels
  // like a continuation of the narrative-to-board hand-off rather
  // than a separate utility screen.
  const chapterClass = quest.id !== "quest1" ? " screen--ch2" : "";
  wrap.className = "screen screen--story screen--hero-pick" + chapterClass;

  const cardsHtml = ownedNumbers
    .map((num) => {
      const card = HERO_CARDS.find((c) => c.number === num)!;
      const isSelected = num === selectedCardNumber;
      // Wrapped in a column so the SEE EQUIPMENT button sits
      // directly under the card without sitting INSIDE the
      // selectable <button> (can't nest buttons in HTML, so we
      // put them as siblings inside the wrapper).
      return `
        <div class="hero-pick-card-wrap">
          <button
            type="button"
            class="hero-pick-card hero-pick-card--${card.suit}${isSelected ? " hero-pick-card--selected" : ""}"
            data-action="select-card"
            data-card-number="${card.number}"
            aria-pressed="${isSelected}"
            title="Hero #${String(card.number).padStart(2, "0")} - ${escapeHtml(card.name)}"
          >
            <img class="hero-pick-card-art" src="/heroes/${card.image}" alt="${escapeHtml(card.name)}" draggable="false" />
          </button>
          <button
            type="button"
            class="btn btn--small btn--ghost see-equipment-btn"
            data-action="see-equipment"
            data-card-number="${card.number}"
            title="Show the equipment cards that come with this Hero Card."
          >SEE EQUIPMENT</button>
        </div>
      `;
    })
    .join("");

  wrap.innerHTML = `
    <div class="board-topbar">
      <div class="board-topbar-goal">
        <strong>${escapeHtml(quest.name)}</strong>
        <span class="muted small"> &middot; ${escapeHtml(delverLabel)}: choose your Hero Card</span>
      </div>
      <div class="board-topbar-actions">
        <button class="btn btn--small btn--ghost" data-action="view-shop-products">View Shop Products</button>
        <button class="btn btn--small btn--ghost" data-action="back">Back to title</button>
      </div>
    </div>
    <div class="story-stage hero-pick-stage">
      <div class="hero-pick-intro">
        <h2 class="hero-pick-title">${escapeHtml(delverLabel)} - Choose Your Hero Card</h2>
      </div>
      <div class="hero-pick-grid" role="radiogroup" aria-label="${escapeHtml(delverLabel)} Hero Cards">
        ${cardsHtml}
      </div>
      <div class="hero-pick-actions">
        <button class="btn btn--primary btn--ready" data-action="confirm">
          Confirm Pick &rarr;
        </button>
      </div>
    </div>
  `;
  root.appendChild(wrap);

  // ---------------- Wiring ----------------

  for (const btn of wrap.querySelectorAll<HTMLButtonElement>("[data-action=select-card]")) {
    btn.addEventListener("click", () => {
      const num = Number(btn.dataset["cardNumber"]);
      if (!Number.isFinite(num)) return;
      selectedCardByHero[pendingHeroId] = num;
      logEvent("heroPick.select", {
        heroId: pendingHeroId,
        cardNumber: num,
      });
      router.refresh();
    });
  }

  const shopBtn = wrap.querySelector<HTMLButtonElement>("[data-action=view-shop-products]");
  shopBtn?.addEventListener("click", () => {
    const owned = state.shopProductsOwned[pendingHeroId] ?? [];
    void presentShopProducts(document.body, {
      delverLabel,
      ownedProductNumbers: owned,
    });
  });

  // "SEE EQUIPMENT" button under each hero card -- opens the
  // EquipmentCardsModal for that specific card so the player can
  // study the starting hand without committing the pick yet.
  for (const btn of wrap.querySelectorAll<HTMLButtonElement>("[data-action=see-equipment]")) {
    btn.addEventListener("click", () => {
      const num = Number(btn.dataset["cardNumber"]);
      if (!Number.isFinite(num)) return;
      logEvent("heroPick.seeEquipment", {
        heroId: pendingHeroId,
        cardNumber: num,
      });
      void presentEquipmentCards(document.body, { heroCardNumber: num });
    });
  }

  wrap.querySelector<HTMLButtonElement>("[data-action=confirm]")?.addEventListener("click", () => {
    const cardNumber = selectedCardByHero[pendingHeroId];
    if (typeof cardNumber !== "number") return;
    try {
      commitHeroPick(state, pendingHeroId, cardNumber);
    } catch (err) {
      logEvent("heroPick.commit.error", {
        heroId: pendingHeroId,
        cardNumber,
        message: err instanceof Error ? err.message : String(err),
      });
      // Don't crash the screen — surface the failure and let the
      // player try again. In practice the picker only offers valid
      // cards so this branch is defensive.
      return;
    }
    delete selectedCardByHero[pendingHeroId];
    router.save();
  });

  wrap.querySelector<HTMLButtonElement>("[data-action=back]")?.addEventListener("click", () => {
    router.goTo({ name: "title" });
  });
}

function renderEmptyQueuePlaceholder(root: HTMLElement, router: Router): void {
  // Should never render in normal flow (BoardScreen checks queue
  // length first), but a friendly bail-out is better than a blank
  // screen if a hot-reload path lands here mid-development.
  const wrap = document.createElement("div");
  wrap.className = "screen screen--story";
  wrap.innerHTML = `
    <div class="story-stage">
      <div class="story-stage-row">
        <article class="storybook-page">
          <h2>No hero picks pending</h2>
          <div class="storybook-text">
            <p>You shouldn't normally see this screen. Please return to the title.</p>
          </div>
        </article>
      </div>
      <div class="story-actions">
        <button class="btn btn--primary" data-action="back">Back to title</button>
      </div>
    </div>
  `;
  root.appendChild(wrap);
  wrap.querySelector<HTMLButtonElement>("[data-action=back]")?.addEventListener("click", () => {
    router.goTo({ name: "title" });
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
