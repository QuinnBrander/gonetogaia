/**
 * Shop sub-screen — rendered inside TownVisit when the active page
 * is `kind: "shop"` (Chapter 1 page 13).
 *
 * Layout:
 *   +-------------------------------------------------+
 *   |  Mind wallet  |  Body wallet  |  Trade actions  |
 *   +-------------------------------------------------+
 *   |  Product grid (one card per available product)  |
 *   +-------------------------------------------------+
 *   |              Finish Town Visit button           |
 *   +-------------------------------------------------+
 *
 * All transactions go through `engine/townVisit.ts` so the rules
 * (cost checks, atomicity, transfer/convert constraints) live in
 * one place. The Shop's job here is purely UI: render the current
 * state, wire buttons to engine calls, then ask the router to save
 * (which re-renders).
 */

import { DAHLIA_ALLY_TOKEN_CHOICES, holdsOpinionCard } from "../engine/opinionEffects";
import type { Router } from "../main";

/**
 * In-shop refresh callback: persists state to disk and re-renders
 * the shop body in the SAME host element. Used by shop sub-
 * renderers (`renderWallet`, `renderProductCard`,
 * `renderDonationControls`, `renderShopFavorsPanel`) instead of the
 * full `router.save()` for shop-internal state changes (purchases,
 * transfers, conversions, donations, opinion-card redemptions).
 *
 * Why: `router.save()` calls `render()` which clears the entire
 * screen root (`#app > root.innerHTML = ""`) and re-mounts the
 * `.screen--town-visit` wrap from scratch. That tears down the
 * ambient particle canvas mounted on the wrap and re-creates a
 * fresh one, which visibly resets the particle field every time
 * the player buys a card. The targeted refresh leaves the wrap
 * (and its particles) untouched and just rebuilds the shop UI
 * inside the existing `[data-town-actions]` host, so the ambient
 * effect keeps drifting smoothly across purchases. User feedback
 * 2026-05-20: "When buying shop products, don't interrupt the
 * particle effects when removing bought cards".
 */
type RefreshShop = () => void;
import { CONSUMABLE_TOKEN_DISPLAY, HEROES, HERO_CARDS, getHero, getShopProduct, shopProductImageOrNull } from "../data";
import { presentHeroCards } from "./HeroCardsModal";
import { presentShopProducts } from "./ShopProductsModal";
import {
  advanceTownVisitPage,
  convertBossPartToMinion,
  currentTownVisitPage,
  effectiveShopProductCost,
  finishTownVisit,
  otherHeroId,
  purchaseShopProduct,
  redeemEliasCard,
  redeemFloresAlly,
  redeemIraAlly,
  redeemVeraAlly,
  shopPurchaseError,
  transferBossParts,
  transferMinionParts,
  type PurchaseError,
} from "../engine/townVisit";
import {
  canShowSamanthaDetractorTile,
  isShopProductBlockedBySamanthaDetractor,
  resolveSamanthaDetractor,
} from "../engine/opinionPenalty";
import {
  donateToAcademy,
  totalAcademyDonation,
} from "../engine/academyDonation";
import type { CampaignState, ConsumableTokenKind } from "../state";
import { logEvent } from "../debug/sessionLog";
import { onlineIsActorNow, onlineMyDelverId } from "../net/onlineController";

export function renderShopBody(host: HTMLDivElement, router: Router): void {
  const state = router.state;
  logEvent("screen.renderShopBody.enter", {
    available: state.shopProductsAvailable.slice().sort((a, b) => a - b),
    owned: Object.fromEntries(
      Object.entries(state.shopProductsOwned).map(([k, v]) => [k, v.slice()]),
    ),
    minion: { ...state.minionParts },
    boss: { ...state.bossParts },
  });

  // Empty out + drop the action-row flex layout from the storybook so
  // the shop owns its full-width section.
  host.innerHTML = "";
  host.classList.remove("town-choices");
  host.classList.add("shop-host");

  // Online co-op (design owner 2026-11-15): each player buys for their own
  // delver, one at a time — the host's delver first. Started by the host
  // the first time it renders this shop page; offline there are no turns.
  const myDelver = onlineMyDelverId();
  const visit = state.townVisit;
  if (myDelver !== null && visit && visit.shopDone === undefined && onlineIsActorNow()) {
    visit.shopTurn = myDelver;
    visit.shopDone = [];
    logEvent("online.shop-turn.start", { heroId: myDelver });
    router.persist();
  }

  // In-shop refresh closure — see `RefreshShop` jsdoc at the top of
  // this file. Sub-renderers call this instead of `router.save()`
  // for shop-internal state changes so the surrounding particle
  // canvas (mounted on the `.screen--town-visit` wrap by
  // `TownVisit.ts`) keeps drifting smoothly across purchases.
  // Re-enters this function, which rebuilds the shop UI into the
  // same `host` — no DOM above the host is touched.
  const refresh: RefreshShop = () => {
    router.persist();
    renderShopBody(host, router);
  };

  const wallets = document.createElement("section");
  wallets.className = "shop-wallets";
  for (const hero of HEROES) {
    wallets.appendChild(renderWallet(hero.id, router, refresh));
  }
  host.appendChild(wallets);

  // Opinion-Card "favors" panel — only rendered when at least one
  // one-shot opinion card is currently actionable (owned + unspent,
  // or currently armed/active for this visit). Hidden entirely
  // otherwise so the shop layout stays clean for players who
  // haven't engaged with the opinion system yet.
  const favorsPanel = renderShopFavorsPanel(router, refresh);
  if (favorsPanel) host.appendChild(favorsPanel);

  const grid = document.createElement("section");
  grid.className = "shop-grid";
  const available = router.state.shopProductsAvailable;
  if (available.length === 0) {
    const empty = document.createElement("div");
    empty.className = "shop-empty muted";
    empty.textContent = "All shop products have been purchased.";
    grid.appendChild(empty);
  } else {
    // Render in printed product-number order for a stable layout.
    const sorted = [...available].sort((a, b) => a - b);
    for (const productNumber of sorted) {
      grid.appendChild(renderProductCard(productNumber, router, refresh));
    }
  }
  host.appendChild(grid);

  // The shop page's exit button serves two roles depending on
  // whether the page has a `next`:
  //   - With `next` (current Chapter 1 flow: page13 -> page14):
  //     this is a "Continue" — the shop is one beat in a longer
  //     town-visit sequence and the next page is the actual ending
  //     narrative. No confirm needed because the player isn't yet
  //     leaving the visit; they can still flip back through the
  //     remaining shop UI if they advance, well, no they can't —
  //     but we don't want to fire a confirm on every purchase pass.
  //   - Without `next` (terminal shop page, e.g. if a future
  //     chapter ends directly on the shop): legacy
  //     "Finish Town Visit" path with the confirm + clear encounter
  //     + return to title.
  const ctx = currentTownVisitPage(state);
  const hasNext = !!ctx?.page.next;
  const finish = document.createElement("div");
  finish.className = "shop-finish-row";
  const shopTurn = state.townVisit?.shopTurn ?? null;
  if (shopTurn) {
    const doneBtn = document.createElement("button");
    doneBtn.className = "btn btn--accent";
    const other = otherHeroId(shopTurn);
    const otherDone = !other || (state.townVisit?.shopDone ?? []).includes(other);
    doneBtn.innerHTML = otherDone
      ? "Done shopping \u2192"
      : `Done shopping \u2192 ${getHero(other).suit === "mind" ? "Mind" : "Body"} player's turn`;
    doneBtn.addEventListener("click", () => {
      const v = router.state.townVisit;
      if (!v || v.shopTurn !== shopTurn) return;
      const done = [...(v.shopDone ?? []), shopTurn];
      v.shopDone = done;
      v.shopTurn = other && !done.includes(other) ? other : null;
      logEvent("click.shop-done-shopping", { heroId: shopTurn, nextTurn: v.shopTurn });
      router.save();
    });
    finish.appendChild(doneBtn);
    host.appendChild(finish);
    return;
  }
  const finishBtn = document.createElement("button");
  finishBtn.className = "btn btn--accent";
  finishBtn.innerHTML = hasNext
    ? "Continue \u2192"
    : "Finish Town Visit \u2192";
  finishBtn.addEventListener("click", () => {
    logEvent("click.shop-finish", {
      pageId: ctx?.visit.pageId ?? null,
      hasNext,
      ownedSummary: Object.fromEntries(
        Object.entries(router.state.shopProductsOwned)
          .map(([k, v]) => [k, v.slice()]),
      ),
    });
    if (hasNext) {
      advanceTownVisitPage(router.state);
      router.save();
      return;
    }
    if (!confirm("Finish the Town Visit? You won't be able to return to the shop until your next Town Visit.")) {
      logEvent("click.shop-finish.cancelled");
      return;
    }
    finishTownVisit(router.state);
    router.state.encounter = null;
    router.goTo({ name: "title" });
  });
  finish.appendChild(finishBtn);
  host.appendChild(finish);
}

/**
 * Emit a `screen.shopLayout.snapshot` event with the post-paint
 * bounding rects + key computed styles of every layout-relevant box
 * in the shop screen. Called by `screens/TownVisit.ts` immediately
 * after `renderShopBody` mounts.
 *
 * Why: the recurring "huge empty gap on the shop page" bug class is
 * impossible to diagnose without seeing actual computed heights —
 * the source of the slack could be any of {screen min-height,
 * story-stage flex, story-actions auto-margin, shop-grid
 * align-content, shop-host gap, intrinsic article height}. With this
 * snapshot the user's session log shows the exact rect of each one,
 * and we can pinpoint which box is taller than expected without a
 * screen share.
 *
 * Scheduling: `requestAnimationFrame` defers measurement to the
 * frame AFTER the DOM mount so layout/paint has actually committed.
 * Measuring synchronously inside `renderShopBody` would either
 * force a sync layout (perf hit) or report 0x0 placeholders for any
 * style that depends on a later style recalc (e.g. `flex: 1` won't
 * resolve until the parent's main-axis size is known).
 */
export function logShopLayoutSnapshot(wrap: HTMLElement, host: HTMLDivElement): void {
  if (typeof requestAnimationFrame === "undefined") return; // jsdom test env
  requestAnimationFrame(() => {
    try {
      const screen = wrap;
      const stage = wrap.querySelector<HTMLElement>(".story-stage");
      const article = wrap.querySelector<HTMLElement>(".storybook-page");
      const wallets = wrap.querySelector<HTMLElement>(".shop-wallets");
      const grid = wrap.querySelector<HTMLElement>(".shop-grid");
      const finishRow = wrap.querySelector<HTMLElement>(".shop-finish-row");

      const rect = (el: Element | null): { top: number; bottom: number; height: number; width: number } | null => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          height: Math.round(r.height),
          width: Math.round(r.width),
        };
      };
      const cs = (el: Element | null, keys: readonly string[]): Record<string, string> | null => {
        if (!el) return null;
        const style = getComputedStyle(el);
        const out: Record<string, string> = {};
        for (const k of keys) out[k] = style.getPropertyValue(k);
        return out;
      };

      // Per-card heights — added 2026-05-18 (5th pass) after the
      // session log revealed that the grid is 1769px tall for 2
      // rows (~876px per row), meaning the cards THEMSELVES are
      // the source of the "empty space" the user keeps reporting,
      // not any of the surrounding chrome. Without per-card data we
      // can't tell which card(s) are tall or what's inside them
      // that's blowing up the row height.
      const cards = Array.from(grid?.querySelectorAll<HTMLElement>(".shop-product") ?? []);
      const cardRects = cards.map((c, i) => {
        const r = c.getBoundingClientRect();
        // Prefer the data attributes (set on every card regardless
        // of whether the body is the printed art or the text-only
        // fallback); fall back to the legacy `.shop-product-number`
        // selector so older renders still log meaningful identifiers.
        const num = c.dataset.productNumber
          ? `#${c.dataset.productNumber}`
          : (c.querySelector(".shop-product-number")?.textContent ?? `#${i}`);
        const name = c.dataset.productName
          ?? c.querySelector(".shop-product-name")?.textContent
          ?? "";
        // `.shop-product-effect` only exists on the text-only fallback;
        // when the card uses printed art, it's `null` and we log
        // `null` for `effectH` (a meaningful "no effect block" signal).
        const effect = c.querySelector<HTMLElement>(".shop-product-effect");
        const buttons = c.querySelector<HTMLElement>(".shop-product-buttons");
        const art = c.querySelector<HTMLElement>(".shop-product-art");
        const effectRect = effect?.getBoundingClientRect();
        const buttonsRect = buttons?.getBoundingClientRect();
        const artRect = art?.getBoundingClientRect();
        return {
          i,
          num: num.trim(),
          name: name.trim(),
          // Absolute position so we can see if cards are in a 4-up
          // grid or stacked single-column — `top` is the row, `left`
          // is the column. Critical for the "rows are 876px when
          // cards are 261px" mystery: positions tell us if the
          // layout engine put the cards where we think it did.
          top: Math.round(r.top),
          left: Math.round(r.left),
          w: Math.round(r.width),
          h: Math.round(r.height),
          effectH: effectRect ? Math.round(effectRect.height) : null,
          buttonsH: buttonsRect ? Math.round(buttonsRect.height) : null,
          artH: artRect ? Math.round(artRect.height) : null,
          // Slack inside the card: card height minus the sum of its
          // direct children's heights (header/name/cost/tag/effect/
          // buttons). A large value means there's empty space INSIDE
          // the card itself (e.g. a stretched flex child).
          children: Array.from(c.children).map((ch) => ({
            cls: ch.className,
            h: Math.round(ch.getBoundingClientRect().height),
          })),
        };
      });

      // Direct children of the grid container (not filtered by
      // `.shop-product`) — catches any phantom child (CSS
      // pseudo-elements aren't here, but any actual DOM node
      // appended to the grid by something else would be). Added
      // 2026-05-18 (6th pass on the shop-layout bug) because
      // querying `.shop-product` couldn't explain why the grid was
      // 1769px tall when 7 cards summed to ~538px of row height.
      const gridChildren = Array.from(grid?.children ?? []).map((ch, i) => {
        const r = ch.getBoundingClientRect();
        return {
          i,
          tag: ch.tagName.toLowerCase(),
          cls: ch.className,
          top: Math.round(r.top),
          left: Math.round(r.left),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      });

      logEvent("screen.shopLayout.snapshot", {
        viewport: {
          w: window.innerWidth,
          h: window.innerHeight,
          dpr: window.devicePixelRatio ?? 1,
          scrollY: window.scrollY,
        },
        document: {
          scrollHeight: document.documentElement.scrollHeight,
          clientHeight: document.documentElement.clientHeight,
          bodyScrollHeight: document.body.scrollHeight,
        },
        rects: {
          screen: rect(screen),
          stage: rect(stage),
          article: rect(article),
          host: rect(host),
          wallets: rect(wallets),
          grid: rect(grid),
          finishRow: rect(finishRow),
        },
        computed: {
          screen: cs(screen, ["min-height", "height", "padding-top", "padding-bottom", "overflow"]),
          stage: cs(stage, ["flex-grow", "flex-shrink", "flex-basis", "min-height", "height", "padding-top", "padding-bottom", "gap", "justify-content", "align-items"]),
          host: cs(host, ["margin-top", "margin-bottom", "flex-direction", "gap", "min-height", "height"]),
          // We migrated `.shop-grid` from CSS Grid to Flexbox on
          // 2026-05-18 (6th pass) to escape the row-track sizing
          // weirdness, so we now ask for both the flex AND the
          // legacy grid props — that way the snapshot is still
          // useful if anyone reverts the implementation, AND we
          // can see whether `display` is what we expect.
          grid: cs(grid, [
            "display",
            "min-height",
            "height",
            "flex-direction",
            "flex-wrap",
            "align-items",
            "align-content",
            "justify-content",
            "gap",
            "grid-template-columns",
            "grid-auto-rows",
          ]),
          finishRow: cs(finishRow, ["margin-top", "padding-top", "height"]),
          firstCard: cs(cards[0] ?? null, [
            "height",
            "min-height",
            "width",
            "flex-grow",
            "flex-shrink",
            "flex-basis",
            "align-self",
            "justify-self",
            "display",
            "flex-direction",
          ]),
        },
        cards: cardRects,
        gridChildren,
        // The single most useful diagnostic: the y-distance from the
        // bottom of the grid to the top of the finish-row. If it's
        // anywhere near the previously-reported "huge gap" (>50px
        // beyond the host's `gap` value), the slack is INSIDE the
        // host. If the gap is tight but the screen extends well
        // below the finish row, the slack is in the screen itself.
        gridToFinishGapPx:
          grid && finishRow
            ? Math.round(finishRow.getBoundingClientRect().top - grid.getBoundingClientRect().bottom)
            : null,
        finishRowToScreenBottomPx:
          finishRow && screen
            ? Math.round(screen.getBoundingClientRect().bottom - finishRow.getBoundingClientRect().bottom)
            : null,
      });
    } catch (err) {
      logEvent("screen.shopLayout.snapshot.error", { message: String(err) });
    }
  });
}

function renderWallet(heroId: string, router: Router, refresh: RefreshShop): HTMLDivElement {
  const state = router.state;
  const hero = getHero(heroId);
  const otherId = otherHeroId(heroId);
  const minion = state.minionParts[heroId] ?? 0;
  const boss = state.bossParts[heroId] ?? 0;
  const bossL2 = state.bossPartsLvl2[heroId] ?? 0;
  const bossL3 = state.bossPartsLvl3[heroId] ?? 0;
  const bossL4 = state.bossPartsLvl4[heroId] ?? 0;
  const bossL5 = state.bossPartsLvl5[heroId] ?? 0;
  const suit = hero.suit;
  const delverLabel = suit === "mind" ? "Mind Delver" : "Body Delver";

  // Hero Cards "owned" by this delver = unlocked cards whose suit
  // matches. Hero Cards in this game live at the campaign level
  // (`state.unlockedHeroCards`) but each card has a fixed suit, so
  // the per-delver split is the suit filter.
  const ownedHeroCardCount = HERO_CARDS.filter(
    (c) => c.suit === suit && state.unlockedHeroCards.includes(c.number),
  ).length;

  // Shop Products previously purchased by this delver (this
  // campaign). Stored per-hero in `state.shopProductsOwned`. Note:
  // these are the persistent owned-cards reference, distinct from
  // `state.shopProductsAvailable` which is the currently-for-sale
  // list rendered in the product grid below.
  const ownedShopProductNumbers = state.shopProductsOwned[heroId] ?? [];
  const ownedShopProductCount = ownedShopProductNumbers.length;

  const card = document.createElement("div");
  card.className = `shop-wallet shop-wallet--${suit}`;
  card.dataset["delverOnly"] = heroId;
  card.innerHTML = `
    <div class="shop-wallet-header">
      <strong>${escapeHtml(delverLabel)}</strong>
    </div>
    <div class="shop-wallet-counts">
      <div class="shop-count" title="Minion Parts">
        <img src="/tokens/minion-${suit}.webp" alt="Minion Part" width="32" height="32" />
        <strong class="shop-count-num">${minion}</strong>
        <span class="small muted">minion</span>
      </div>
      <div class="shop-count" title="Lvl 1 Boss Parts (Soulhunter, Goldmonger)">
        <img src="/tokens/boss-lvl-1-${suit}.webp" alt="Lvl 1 Boss Part" width="32" height="32" />
        <strong class="shop-count-num">${boss}</strong>
        <span class="small muted">boss L1</span>
      </div>
      <div class="shop-count" title="Lvl 2 Boss Parts (Hundredeyes)">
        <img src="/tokens/boss-lvl-2-${suit}.webp" alt="Lvl 2 Boss Part" width="32" height="32" />
        <strong class="shop-count-num">${bossL2}</strong>
        <span class="small muted">boss L2</span>
      </div>
      ${bossL3 > 0 ? `
      <div class="shop-count" title="Lvl 3 Boss Parts (Death Cap)">
        <img src="/tokens/boss-lvl-3-${suit}.webp" alt="Lvl 3 Boss Part" width="32" height="32" />
        <strong class="shop-count-num">${bossL3}</strong>
        <span class="small muted">boss L3</span>
      </div>` : ""}
      ${bossL4 > 0 ? `
      <div class="shop-count" title="Lvl 4 Boss Parts (Golem)">
        <img src="/tokens/boss-lvl-4-${suit}.webp" alt="Lvl 4 Boss Part" width="32" height="32" />
        <strong class="shop-count-num">${bossL4}</strong>
        <span class="small muted">boss L4</span>
      </div>` : ""}
      ${bossL5 > 0 ? `
      <div class="shop-count" title="Lvl 5 Boss Parts (Timber Fiend)">
        <img src="/tokens/boss-lvl-5-${suit}.webp" alt="Lvl 5 Boss Part" width="32" height="32" />
        <strong class="shop-count-num">${bossL5}</strong>
        <span class="small muted">boss L5</span>
      </div>` : ""}
    </div>
    <div class="shop-wallet-actions">
      <button class="btn btn--small btn--ghost shop-view-hero-cards-btn"
              data-action="view-hero-cards"
              title="Open a reference of every Hero Card the ${escapeAttr(delverLabel)} currently owns.">
        View ${escapeHtml(suit === "mind" ? "Mind" : "Body")} Hero Cards
        <span class="shop-view-hero-cards-count">${ownedHeroCardCount}</span>
      </button>
      <button class="btn btn--small btn--ghost shop-view-hero-cards-btn"
              data-action="view-shop-products"
              ${ownedShopProductCount === 0 ? "disabled" : ""}
              title="${ownedShopProductCount === 0
                ? `The ${escapeAttr(delverLabel)} hasn't purchased any Shop Products yet.`
                : `Open a reference of every Shop Product the ${escapeAttr(delverLabel)} has previously purchased.`}">
        View ${escapeHtml(suit === "mind" ? "Mind" : "Body")} Shop Products
        <span class="shop-view-hero-cards-count">${ownedShopProductCount}</span>
      </button>
      <button class="btn btn--small btn--ghost" data-action="convert-boss" ${boss < 1 ? "disabled" : ""}>
        Convert Lvl 1 Boss Part \u2192 3 Minion
      </button>
      <button class="btn btn--small btn--ghost" data-action="convert-boss-l2" ${bossL2 < 1 ? "disabled" : ""}>
        Convert Lvl 2 Boss Part \u2192 6 Minion
      </button>
      <button class="btn btn--small btn--ghost" data-action="convert-boss-l3" ${bossL3 < 1 ? "disabled" : ""}>
        Convert Lvl 3 Boss Part \u2192 9 Minion
      </button>
      ${bossL4 > 0 ? `<button class="btn btn--small btn--ghost" data-action="convert-boss-l4">
        Convert Lvl 4 Boss Part \u2192 12 Minion
      </button>` : ""}
      ${bossL5 > 0 ? `<button class="btn btn--small btn--ghost" data-action="convert-boss-l5">
        Convert Lvl 5 Boss Part \u2192 15 Minion
      </button>` : ""}
      ${otherId ? `
        <button class="btn btn--small btn--ghost" data-action="give-minion" ${minion < 1 ? "disabled" : ""}>
          Give 1 Minion to ${escapeHtml(getHero(otherId).suit === "mind" ? "Mind" : "Body")}
        </button>
        <button class="btn btn--small btn--ghost" data-action="give-boss" ${boss < 1 ? "disabled" : ""}>
          Give 1 Boss Part to ${escapeHtml(getHero(otherId).suit === "mind" ? "Mind" : "Body")}
        </button>
      ` : ""}
    </div>
  `;

  card.querySelector<HTMLButtonElement>("[data-action=view-hero-cards]")
    ?.addEventListener("click", () => {
      logEvent("click.shop-view-hero-cards", {
        heroId, suit, ownedCount: ownedHeroCardCount,
      });
      // Mount on document.body so the fixed-position overlay is
      // unconstrained by the shop screen's flex layout — matches
      // how `presentRewards` is wired from TownVisit.ts.
      void presentHeroCards(document.body, {
        delverLabel,
        suit,
        unlockedNumbers: router.state.unlockedHeroCards,
      });
    });
  card.querySelector<HTMLButtonElement>("[data-action=view-shop-products]")
    ?.addEventListener("click", () => {
      logEvent("click.shop-view-shop-products", {
        heroId, suit, ownedCount: ownedShopProductCount,
        ownedNumbers: ownedShopProductNumbers.slice(),
      });
      // Read owned products fresh from `router.state` (not the
      // local capture) so a re-render between mount and click still
      // shows the latest list. The local capture is only used for
      // the disabled-button gate, where staleness across a single
      // render cycle is harmless.
      void presentShopProducts(document.body, {
        delverLabel,
        ownedProductNumbers: router.state.shopProductsOwned[heroId] ?? [],
      });
    });
  card.querySelector<HTMLButtonElement>("[data-action=convert-boss]")
    ?.addEventListener("click", () => {
      logEvent("click.shop-convert-boss", { heroId, level: 1 });
      if (convertBossPartToMinion(router.state, heroId, 1)) refresh();
    });
  // Printed rate is 3 minion parts PER LEVEL of the converted part
  // (Ch2 town-visit text) — the Lvl 2 / Lvl 3 options were missing
  // pre-2026-07-20 because the converter predated the level-aware
  // boss-part wallets.
  card.querySelector<HTMLButtonElement>("[data-action=convert-boss-l2]")
    ?.addEventListener("click", () => {
      logEvent("click.shop-convert-boss", { heroId, level: 2 });
      if (convertBossPartToMinion(router.state, heroId, 2)) refresh();
    });
  card.querySelector<HTMLButtonElement>("[data-action=convert-boss-l3]")
    ?.addEventListener("click", () => {
      logEvent("click.shop-convert-boss", { heroId, level: 3 });
      if (convertBossPartToMinion(router.state, heroId, 3)) refresh();
    });
  for (const level of [4, 5] as const) {
    card.querySelector<HTMLButtonElement>(`[data-action=convert-boss-l${level}]`)
      ?.addEventListener("click", () => {
        logEvent("click.shop-convert-boss", { heroId, level });
        if (convertBossPartToMinion(router.state, heroId, level)) refresh();
      });
  }
  card.querySelector<HTMLButtonElement>("[data-action=give-minion]")
    ?.addEventListener("click", () => {
      logEvent("click.shop-give-minion", { fromHeroId: heroId, toHeroId: otherId, amount: 1 });
      if (otherId && transferMinionParts(router.state, heroId, otherId, 1)) refresh();
    });
  card.querySelector<HTMLButtonElement>("[data-action=give-boss]")
    ?.addEventListener("click", () => {
      logEvent("click.shop-give-boss", { fromHeroId: heroId, toHeroId: otherId, amount: 1 });
      if (otherId && transferBossParts(router.state, heroId, otherId, 1)) refresh();
    });

  return card;
}

function renderProductCard(productNumber: number, router: Router, refresh: RefreshShop): HTMLDivElement {
  const product = getShopProduct(productNumber);
  const state = router.state;

  const card = document.createElement("div");
  card.className = `shop-product shop-product--${categoryClass(product.category)}`;
  // Stable identifier for the layout snapshot helper — the printed
  // card art replaced the in-DOM number/name text, so we can't read
  // them out of `.shop-product-number` etc anymore. Snapshot reads
  // this attribute to keep per-card diagnostics meaningful.
  card.dataset.productNumber = String(product.number);
  card.dataset.productName = product.name;
  // Printed card art (from `Shop Cards Front v3 PROOF 1.pdf`) is
  // the authoritative source of the product number/name/location/
  // category/effect text — all baked into the image. We render it
  // as the card body, then keep just the cost pills (suit-aware
  // affordability scan) and buy buttons below for interaction.
  // If a future product number doesn't have card art, we fall back
  // to the legacy text-only card so the shop still functions.
  const image = shopProductImageOrNull(product.number);
  const artAlt = `Shop Product #${product.number} - ${product.name} (${product.location}, ${product.category}). ${product.effectText}`;
  const artBody = image
    ? `<img class="shop-product-art" src="/shop-products/${image}" alt="${escapeAttr(artAlt)}" />`
    : `
      <div class="shop-product-header">
        <span class="shop-product-number">#${product.number}</span>
        <span class="shop-product-location small muted">${escapeHtml(product.location)}</span>
      </div>
      <h4 class="shop-product-name">${escapeHtml(product.name)}</h4>
      <div class="shop-product-tag small muted">${escapeHtml(product.category)}</div>
      <p class="shop-product-effect">${escapeHtml(product.effectText)}</p>
    `;
  // Effective post-discount cost. Renders any reduction with a
  // "discounted" badge so the player sees Flores actually
  // doing something. The printed cost is shown struck-through next
  // to the discounted value whenever they differ.
  const effective = effectiveShopProductCost(state, product.number);
  const minionDiscounted = effective.minionParts < product.cost.minionParts;
  const lvl1Discounted = effective.bossLvl1 < product.cost.bossLvl1;
  const lvl2Discounted = effective.bossLvl2 < product.cost.bossLvl2;
  const lvl3Discounted = effective.bossLvl3 < (product.cost.bossLvl3 ?? 0);
  const lvl4Discounted = effective.bossLvl4 < (product.cost.bossLvl4 ?? 0);
  card.innerHTML = `
    ${artBody}
    <div class="shop-product-cost" aria-label="Cost">
      ${renderCostHtml(effective.minionParts, "minion", { printed: product.cost.minionParts, discounted: minionDiscounted })}
      ${renderCostHtml(effective.bossLvl1, "boss-lvl-1", { printed: product.cost.bossLvl1, discounted: lvl1Discounted })}
      ${product.cost.bossLvl2 > 0 || effective.bossLvl2 > 0
        ? renderCostHtml(effective.bossLvl2, "boss-lvl-2", { printed: product.cost.bossLvl2, discounted: lvl2Discounted })
        : ""}
      ${(product.cost.bossLvl3 ?? 0) > 0 || effective.bossLvl3 > 0
        ? renderCostHtml(effective.bossLvl3, "boss-lvl-3", { printed: product.cost.bossLvl3 ?? 0, discounted: lvl3Discounted })
        : ""}
      ${(product.cost.bossLvl4 ?? 0) > 0 || effective.bossLvl4 > 0
        ? renderCostHtml(effective.bossLvl4, "boss-lvl-4", { printed: product.cost.bossLvl4 ?? 0, discounted: lvl4Discounted })
        : ""}
      ${effective.floresApplied ? `<span class="shop-cost-discount-pill" title="Flores's Ally favor: 1 boss part removed from this purchase.">Flores</span>` : ""}
      ${effective.opinionLabels.map((l) => `<span class="shop-cost-discount-pill" title="Opinion card: changes this product's minion-part price.">${escapeHtml(l)}</span>`).join("")}
    </div>
    <div class="shop-product-buttons" data-buy-row></div>
  `;

  const buyRow = card.querySelector<HTMLDivElement>("[data-buy-row]")!;
  // Variable-cost donation product (#8) uses a completely
  // different UX from the normal buy-buttons row — render a
  // per-delver donation input + running total + live "tier
  // hint" instead. The normal Buy buttons would be nonsense on
  // a `variableMinionParts: true` product because the cost
  // table reads as "0" (the printed cost is just a placeholder).
  if (product.cost.variableMinionParts) {
    renderDonationControls(buyRow, product.number, router, refresh);
    return card;
  }
  for (const hero of HEROES) {
    const buyer = hero.id;
    const buyerSuit = hero.suit;
    const result = previewPurchase(state, buyer, productNumber);
    const btn = document.createElement("button");
    btn.className = `btn btn--small btn--primary shop-buy-btn shop-buy-btn--${buyerSuit}`;
    btn.dataset["delverOnly"] = buyer;
    const reason = result.error ? buyDisabledReason(result.error) : null;
    btn.innerHTML = `${buyerSuit === "mind" ? "Mind" : "Body"} buys`;
    if (result.error) {
      btn.disabled = true;
      if (reason) btn.title = reason;
    }
    btn.addEventListener("click", () => {
      logEvent("click.shop-buy", { buyer, productNumber, productName: product.name });
      const err = purchaseShopProduct(router.state, buyer, productNumber);
      if (!err) refresh();
    });
    buyRow.appendChild(btn);
  }

  return card;
}

/**
 * Render the donation-product (Shop Product #8) controls into the
 * passed `buyRow` element: one "Donate 1" button per delver, plus
 * a per-visit running total.
 *
 * Each click calls `donateToAcademy(state, heroId, 1)`, persists,
 * and re-renders. The button is disabled when the delver's
 * minion-part wallet is empty.
 *
 * Design (2026-05-21): the previous version exposed a per-row
 * `<input type="number">` so the player could donate N at a time;
 * that turned out to be more friction than help — at the table the
 * player counts a single donation at a time and is happy clicking
 * twice to donate 2. Collapsing to a single "Donate 1" button per
 * delver matches the count-as-you-go tabletop ritual and removes
 * the keyboard-juggling required to set "3" or "10" before
 * clicking Donate.
 *
 * Design (2026-05-23): the tier mapping is no longer hidden in
 * the donation panel itself, but it's also NOT shown inline here
 * — the page's banner `image` on `page33-shop` was swapped to
 * `arlen-donation-tiers.png` (the printed "Parts Donated /
 * Arlen's Reaction" table for ~1 / ~4 / ~7 / ~11) so the
 * reference is always visible above the shop without crowding
 * the donation card. Earlier spoiler-free stance (hide all tier
 * mapping until the Fundraising Results beat) created a UX where
 * players were donating blind — the banner placement gives them
 * the same information the printed rulebook would.
 */
function renderDonationControls(buyRow: HTMLDivElement, productNumber: number, router: Router, refresh: RefreshShop): void {
  buyRow.classList.add("shop-donation-controls");
  const state = router.state;
  const total = totalAcademyDonation(state);
  // Per-hero donation rows
  for (const hero of HEROES) {
    const wallet = state.minionParts[hero.id] ?? 0;
    const heroDonated = state.academyDonation[hero.id] ?? 0;
    const row = document.createElement("div");
    row.className = `shop-donation-row shop-donation-row--${hero.suit}`;
    row.innerHTML = `
      <div class="shop-donation-row-label">
        <strong>${hero.suit === "mind" ? "Mind" : "Body"} delver</strong>
      </div>
      <div class="shop-donation-row-input">
        <button class="btn btn--small btn--primary shop-donation-btn shop-buy-btn--${hero.suit}"
                data-action="donate" data-hero="${hero.id}" data-delver-only="${hero.id}"
                ${wallet <= 0 ? "disabled" : ""}>
          Donate 1
        </button>
      </div>
    `;
    buyRow.appendChild(row);
  }
  const tierHint = document.createElement("div");
  tierHint.className = `shop-donation-tier`;
  tierHint.innerHTML = `
    <span class="shop-donation-total">Donated this visit: <strong>${total}</strong></span>
  `;
  buyRow.appendChild(tierHint);
  // Wire each Donate button — fixed amount of 1 per click. The
  // engine helper's `invalid-amount` / `insufficient-funds` rejects
  // are wrapped in a `console.warn` for parity with the other
  // shop interactions; both are guarded above (disabled when
  // wallet === 0) so they should never fire in practice.
  const buttons = buyRow.querySelectorAll<HTMLButtonElement>("[data-action=donate]");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const heroId = btn.getAttribute("data-hero")!;
      const amount = 1;
      logEvent("click.shop-donate", { heroId, productNumber, amount });
      const err = donateToAcademy(router.state, heroId, amount);
      if (err) {
        console.warn("donateToAcademy rejected:", err.code);
        return;
      }
      refresh();
    });
  });
}

function renderCostHtml(
  amount: number,
  kind: "minion" | "boss-lvl-1" | "boss-lvl-2" | "boss-lvl-3" | "boss-lvl-4",
  meta?: { printed: number; discounted: boolean },
): string {
  // Hide a cost cell completely if BOTH the printed AND the
  // effective amount are zero (no need to show "0 minion"). For
  // discounted-to-zero cases (e.g. Flores stripped the last
  // boss-lvl-1) we still render a struck-through "0" pill so the
  // player can see the discount took effect.
  const printed = meta?.printed ?? amount;
  if (amount <= 0 && printed <= 0 && kind === "minion") return "";
  if (amount <= 0 && printed <= 0) return "";
  // Use the mind variant of the part icon as the canonical "this kind
  // of part" symbol on the shop card. Suit-specific variants are
  // shown in the wallet readout above; the shop product itself is
  // suit-agnostic.
  let src = "";
  let alt = "";
  if (kind === "minion") { src = "/tokens/minion-mind.webp"; alt = "Minion Part"; }
  else if (kind === "boss-lvl-1") { src = "/tokens/boss-lvl-1-mind.webp"; alt = "Lvl 1 Boss Part"; }
  else if (kind === "boss-lvl-2") { src = "/tokens/boss-lvl-2-mind.webp"; alt = "Lvl 2 Boss Part"; }
  else if (kind === "boss-lvl-3") { src = "/tokens/boss-lvl-3-mind.webp"; alt = "Lvl 3 Boss Part"; }
  else { src = "/tokens/boss-lvl-4-mind.webp"; alt = "Lvl 4 Boss Part"; }
  const lvlLabel = kind === "boss-lvl-2" ? " <span class=\"small muted\">L2</span>"
    : kind === "boss-lvl-3" ? " <span class=\"small muted\">L3</span>"
    : kind === "boss-lvl-4" ? " <span class=\"small muted\">L4</span>" : "";
  const discountedCls = meta?.discounted ? " shop-cost-pill--discounted" : "";
  const struckPrinted = meta?.discounted && meta.printed !== amount
    ? `<s class="shop-cost-pill-printed" aria-hidden="true">${meta.printed}</s>`
    : "";
  return `
    <span class="shop-cost-pill${discountedCls}" title="${escapeAttr(alt)}">
      ${struckPrinted}<strong>${amount}</strong>
      <img src="${src}" alt="${escapeAttr(alt)}" width="22" height="22" />${lvlLabel}
    </span>
  `;
}

function previewPurchase(state: CampaignState, heroId: string, productNumber: number): { error: PurchaseError | null } {
  // Same gate the engine applies on Buy (Samantha cards, Ira / Flores
  // price changes, Flores Confidant paying boss parts in minion parts).
  return { error: shopPurchaseError(state, heroId, productNumber) };
}

function buyDisabledReason(err: PurchaseError): string {
  switch (err.code) {
    case "not-available":             return "This product has already been purchased.";
    case "already-owned":             return "This delver already owns this product.";
    case "insufficient-minion":       return "Not enough minion parts.";
    case "insufficient-boss-lvl-1":   return "Not enough Lvl 1 boss parts.";
    case "insufficient-boss-lvl-2":   return "Not enough Lvl 2 boss parts.";
    case "insufficient-boss-lvl-3":   return "Not enough Lvl 3 boss parts.";
    case "insufficient-boss-lvl-4":   return "Not enough Lvl 4 boss parts.";
    case "samantha-detractor-blocked": return "Samantha won't sell — pay her 1 Lvl 1 Boss Part to resolve her Detractor card first.";
    case "samantha-nemesis-blocked": return "Samantha is your Nemesis - the Machinist won't sell to you.";
    case "wrong-suit":               return "Only the other suit's delver can purchase this.";
  }
}

function categoryClass(cat: string): string {
  return cat.toLowerCase().replace(/\s+/g, "-");
}

/**
 * Render the "Favors" row above the shop grid — one tile per
 * Opinion Card whose ability is actionable RIGHT NOW (Flores,
 * Vera's gift, and the Samantha Detractor penalty today). Returns `null` when no card has anything to
 * show, so the caller can omit the panel entirely instead of
 * rendering an empty bar.
 *
 * Each tile shows:
 *   - The card art at a small thumbnail size.
 *   - A one-line summary of what happens on redeem.
 *   - A "Redeem" button (disabled when already-active / already-
 *     spent / already-armed).
 *   - The current state ("Active this visit", "Armed for next
 *     purchase", "Spent") when the button can't be clicked.
 *
 * Pre-conditions for each tile:
 *   - The (characterId, level) pair is in `state.opinionCards`.
 *   - The card-specific actionable state is true (either unspent
 *     or in an active/armed state worth surfacing).
 */
function renderShopFavorsPanel(router: Router, refresh: RefreshShop): HTMLElement | null {
  const state = router.state;
  const tiles: HTMLElement[] = [];
  // Flores Ally
  const hasFlores = state.opinionCards.some(
    (c) => c.characterId === "flores" && c.level === "ally",
  );
  if (hasFlores) {
    const spent = state.opinionCardsSpent.includes("flores-ally");
    const armed = state.floresDiscountArmed;
    if (!spent || armed) {
      tiles.push(renderFavorTile({
        cardId: "flores-ally",
        title: "Flores's Ally favor",
        summary: "Arm a one-shot discount: the next shop purchase removes 1 boss part from its cost.",
        ctaLabel: armed ? "Armed - apply on next purchase" : "Arm discount",
        ctaDisabled: spent,
        state: armed ? "active" : (spent ? "spent" : "ready"),
        onRedeem: () => {
          const err = redeemFloresAlly(router.state);
          if (err) {
            console.warn("redeemFloresAlly rejected:", err.code);
            return;
          }
          logEvent("click.shop-redeem-flores");
          refresh();
        },
      }));
    }
  }
  // Ira Ally "Influential" — this visit, every product costs 1 less minion part.
  if (holdsOpinionCard(state, "ira", "ally") || state.iraDiscountActive) {
    const active = state.iraDiscountActive;
    tiles.push(renderFavorTile({
      cardId: "ira-ally",
      title: "Ira's Ally favor",
      summary: "This town visit, all Shop Products cost 1 less minion part.",
      ctaLabel: active ? "Active this visit" : "Redeem",
      ctaDisabled: active,
      state: active ? "active" : "ready",
      onRedeem: () => {
        const err = redeemIraAlly(router.state);
        if (err) throw new Error(`redeemIraAlly rejected: ${err.code}`);
        logEvent("click.shop-redeem-ira");
        refresh();
      },
    }));
  }
  // Elias Ally / Confidant — spend 3 minion parts for 1 Memory Chip token.
  for (const level of ["ally", "confidant"] as const) {
    if (!holdsOpinionCard(state, "elias", level)) continue;
    tiles.push(renderPerHeroTile({
      cardId: `elias-${level}`,
      variant: "ready",
      title: `Elias's ${level === "ally" ? "Ally" : "Confidant"} favor`,
      summary: "Spend 3 minion parts to gain 1 Memory Chip token. Discarded once redeemed.",
      perHero: HEROES.map((hero) => {
        const minion = state.minionParts[hero.id] ?? 0;
        return {
          heroId: hero.id,
          suit: hero.suit,
          label: `${hero.suit === "mind" ? "Mind" : "Body"} pays 3 minion parts`,
          disabled: minion < 3,
          disabledReason: minion < 3 ? "This delver has fewer than 3 minion parts." : null,
          onClick: () => {
            const err = redeemEliasCard(router.state, hero.id, level);
            if (err) throw new Error(`redeemEliasCard rejected: ${err.code}`);
            logEvent("click.shop-redeem-elias", { heroId: hero.id, level });
            refresh();
          },
        };
      }),
    }));
  }
  // Dahlia Ally — each delver's quest-start consumable token choice.
  if (holdsOpinionCard(state, "dahlia", "ally")) {
    tiles.push(renderDahliaChoiceTile(router, refresh));
  }
  // Vera Ally "Gift" — one delver gains a Lvl 2 boss part. One
  // button per delver; the tile disappears once redeemed.
  const hasVera = state.opinionCards.some(
    (c) => c.characterId === "vera" && c.level === "ally",
  );
  if (hasVera && !state.opinionCardsSpent.includes("vera-ally")) {
    tiles.push(renderPerHeroTile({
      cardId: "vera-ally",
      variant: "ready",
      title: "Vera's Gift",
      summary: "Choose a delver to gain a Level 2 Boss Part. Discarded once redeemed.",
      perHero: HEROES.map((hero) => ({
        heroId: hero.id,
        suit: hero.suit,
        label: `${hero.suit === "mind" ? "Mind" : "Body"} gains 1 Lvl 2 Boss Part`,
        disabled: false,
        disabledReason: null,
        onClick: () => {
          const err = redeemVeraAlly(router.state, hero.id);
          if (err) throw new Error(`redeemVeraAlly rejected: ${err.code}`);
          logEvent("click.shop-redeem-vera", { heroId: hero.id });
          refresh();
        },
      })),
    }));
  }
  // Samantha DETRACTOR — penalty card. Owned-and-unresolved
  // surfaces a tile with one "Pay 1 Boss Part" button per delver
  // (either wallet can settle the debt). Buttons are disabled when
  // that delver has 0 boss parts; the tile itself disappears once
  // resolution lands. Distinct CSS state ("debt") so the panel
  // visually separates the "favor" tiles from this penalty.
  if (canShowSamanthaDetractorTile(state)) {
    tiles.push(renderPerHeroTile({
      cardId: "samantha-detractor",
      variant: "debt",
      title: "Samantha's Detractor penalty",
      summary: "Machinist products are unpurchasable until you pay Samantha 1 Lvl 1 Boss Part.",
      perHero: HEROES.map((hero) => {
        const wallet = state.bossParts[hero.id] ?? 0;
        return {
          heroId: hero.id,
          suit: hero.suit,
          label: `${hero.suit === "mind" ? "Mind" : "Body"} pays 1 Boss Part`,
          disabled: wallet < 1,
          disabledReason: wallet < 1 ? "This delver has no Lvl 1 Boss Parts." : null,
          onClick: () => {
            const err = resolveSamanthaDetractor(router.state, hero.id);
            if (err) {
              console.warn("resolveSamanthaDetractor rejected:", err.code);
              return;
            }
            logEvent("click.shop-resolve-samantha-detractor", { heroId: hero.id });
            refresh();
          },
        };
      }),
    }));
  }
  if (tiles.length === 0) return null;
  const panel = document.createElement("section");
  panel.className = "shop-favors";
  const heading = document.createElement("h4");
  heading.className = "shop-favors-title";
  heading.textContent = "Opinion Card favors";
  panel.appendChild(heading);
  const row = document.createElement("div");
  row.className = "shop-favors-row";
  for (const tile of tiles) row.appendChild(tile);
  panel.appendChild(row);
  return panel;
}

function renderFavorTile(opts: {
  cardId: string;
  title: string;
  summary: string;
  ctaLabel: string;
  ctaDisabled: boolean;
  state: "ready" | "active" | "spent";
  onRedeem: () => void;
}): HTMLElement {
  const tile = document.createElement("div");
  tile.className = `shop-favor shop-favor--${opts.state}`;
  // Card id maps directly to the asset filename via the catalog
  // pattern (`opinion-{characterId}-{level}.png`) — split on the
  // first dash so the thumbnail always finds its image without a
  // catalog round-trip.
  const dashIdx = opts.cardId.indexOf("-");
  const characterId = dashIdx >= 0 ? opts.cardId.slice(0, dashIdx) : opts.cardId;
  const level = dashIdx >= 0 ? opts.cardId.slice(dashIdx + 1) : "";
  const imgSrc = `/opinion-cards/opinion-${characterId}-${level}.png`;
  tile.innerHTML = `
    <img class="shop-favor-thumb" src="${escapeAttr(imgSrc)}" alt="${escapeAttr(opts.title)}" />
    <div class="shop-favor-meta">
      <strong class="shop-favor-title">${escapeHtml(opts.title)}</strong>
      <p class="small muted shop-favor-summary">${escapeHtml(opts.summary)}</p>
      <button class="btn btn--small ${opts.state === "active" ? "btn--ghost" : "btn--primary"} shop-favor-cta"
              data-action="redeem"
              ${opts.ctaDisabled ? "disabled" : ""}>${escapeHtml(opts.ctaLabel)}</button>
    </div>
  `;
  tile.querySelector<HTMLButtonElement>("[data-action=redeem]")?.addEventListener("click", opts.onRedeem);
  return tile;
}

/** Dahlia Ally: pick the consumable token each delver starts quests with. */
function renderDahliaChoiceTile(router: Router, refresh: RefreshShop): HTMLElement {
  const state = router.state;
  const tile = document.createElement("div");
  tile.className = "shop-favor shop-favor--active";
  const rows = HEROES.map((hero) => {
    const current = state.dahliaTokenChoice[hero.id];
    const opts = DAHLIA_ALLY_TOKEN_CHOICES.map((k) =>
      `<option value="${k}" ${k === current ? "selected" : ""}>${escapeHtml(CONSUMABLE_TOKEN_DISPLAY[k].label)}</option>`).join("");
    return `<label class="small" data-delver-only="${hero.id}">${hero.suit === "mind" ? "Mind" : "Body"}:
      <select data-dahlia-hero="${hero.id}">${opts}</select></label>`;
  }).join(" ");
  tile.innerHTML = `
    <img class="shop-favor-thumb" src="/opinion-cards/opinion-dahlia-ally.png" alt="Dahlia's Ally card" />
    <div class="shop-favor-meta">
      <strong class="shop-favor-title">Dahlia's Ally favor</strong>
      <p class="small muted shop-favor-summary">Delvers start quests with 1 consumable token of their choice.</p>
      <div class="shop-favor-actions">${rows}</div>
    </div>
  `;
  tile.querySelectorAll<HTMLSelectElement>("[data-dahlia-hero]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const heroId = sel.dataset.dahliaHero!;
      router.state.dahliaTokenChoice[heroId] = sel.value as ConsumableTokenKind;
      logEvent("click.shop-dahlia-token-choice", { heroId, kind: sel.value });
      refresh();
    });
  });
  return tile;
}

/**
 * Per-delver variant of {@link renderFavorTile}. Same layout, ONE
 * button per delver instead of a single CTA — the Samantha Detractor
 * card needs the player to pick which wallet pays the boss part, and
 * Vera's Gift needs them to pick who receives one. `variant: "debt"`
 * uses the penalty CSS hook (`shop-favor--debt`). Each
 * `perHero` entry renders a suit-tinted button (matching the
 * `shop-buy-btn--{suit}` classes used on the buy buttons below)
 * so the player reads the row as "this is a Mind/Body action" at
 * a glance.
 */
function renderPerHeroTile(opts: {
  cardId: string;
  variant: "debt" | "ready";
  title: string;
  summary: string;
  perHero: ReadonlyArray<{
    heroId: string;
    suit: "mind" | "body";
    label: string;
    disabled: boolean;
    disabledReason: string | null;
    onClick: () => void;
  }>;
}): HTMLElement {
  const tile = document.createElement("div");
  tile.className = `shop-favor shop-favor--${opts.variant}`;
  const dashIdx = opts.cardId.indexOf("-");
  const characterId = dashIdx >= 0 ? opts.cardId.slice(0, dashIdx) : opts.cardId;
  const level = dashIdx >= 0 ? opts.cardId.slice(dashIdx + 1) : "";
  const imgSrc = `/opinion-cards/opinion-${characterId}-${level}.png`;
  const buttonsHtml = opts.perHero.map((row, i) => `
    <button class="btn btn--small btn--primary shop-favor-cta shop-buy-btn--${row.suit}"
            data-action="resolve" data-row-idx="${i}" data-delver-only="${escapeAttr(row.heroId)}"
            ${row.disabled ? "disabled" : ""}
            ${row.disabledReason ? `title="${escapeAttr(row.disabledReason)}"` : ""}>
      ${escapeHtml(row.label)}
    </button>
  `).join("");
  tile.innerHTML = `
    <img class="shop-favor-thumb" src="${escapeAttr(imgSrc)}" alt="${escapeAttr(opts.title)}" />
    <div class="shop-favor-meta">
      <strong class="shop-favor-title">${escapeHtml(opts.title)}</strong>
      <p class="small muted shop-favor-summary">${escapeHtml(opts.summary)}</p>
      <div class="shop-favor-actions">${buttonsHtml}</div>
    </div>
  `;
  tile.querySelectorAll<HTMLButtonElement>("[data-action=resolve]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-row-idx") ?? "-1");
      const row = opts.perHero[idx];
      if (!row || row.disabled) return;
      row.onClick();
    });
  });
  return tile;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

