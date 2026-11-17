/**
 * Rewards modal — centered overlay presented after a Town Visit
 * page's typewriter completes, showing each `RewardEvent` the
 * engine emitted as a card / token visual. Player must click
 * (anywhere on the backdrop, the Continue button, or press Escape)
 * to dismiss; the navigation buttons (choices / continue / shop)
 * mount only after `presentRewards` resolves.
 *
 * Why a modal vs inline rewards next to the prose:
 *   - Forces the player to look at WHAT they earned (the
 *     storybook text already buried "Each player gains HERO #3"
 *     in a footnote that's easy to skim past). A centered card
 *     with the hero portrait is much more "you got a thing!".
 *   - Keeps the storybook screen layout stable — no per-page
 *     "make room for rewards" CSS work in TownVisit.ts.
 *   - One shared modal renderer handles every reward type. Adding
 *     a new RewardEvent variant (memory chip, key item, favour
 *     shift) is "add a case in `renderRewardCard`".
 *
 * Lifecycle: `presentRewards` mounts the overlay, returns a
 * Promise that resolves when the player dismisses it. The
 * overlay self-cleans (removes itself from the DOM) on dismiss
 * so callers don't need to teardown. If the host element is
 * removed mid-modal (e.g. router navigates away), the modal's
 * keydown listener no-ops on its `host.isConnected` check.
 *
 * Added 2026-05-18 as part of the "hook up real rewards in the
 * town visit" series. Hero cards are the first reward type
 * presented; subsequent reward types (memory fragments, key
 * items, favour) plug into the same modal via new
 * `renderRewardCard` cases.
 */

import type { RewardEvent } from "../types";
import { equipmentUpgradeCardsForShopProduct, equipmentUpgradeImage, getEquipmentByTypeSuit, getHero, getHeroCard, getScenarioCard, getShopProduct, imageForRank, keyItemImageOrNull, levelUpCardImageOrNull, memoryCardBackImageOrNull, memoryCardImageOrNull, memoryCardNameOrNull, opinionCardImageOrNull, questImageOrNull, shopProductImageOrNull } from "../data";
import { presentEquipmentCards } from "./EquipmentCardsModal";
import { logEvent } from "../debug/sessionLog";

/**
 * Render the rewards modal over `host` and resolve when dismissed.
 * No-op (resolves immediately) if `events` is empty so callers
 * don't have to gate the call themselves — `presentRewards(host, events)`
 * is always safe.
 */
export function presentRewards(host: HTMLElement, events: RewardEvent[]): Promise<void> {
  if (events.length === 0) return Promise.resolve();
  // De-duplicate the favour story: when a `shift-favour` action
  // walks the player INTO a named threshold (ally, detractor, ...)
  // the engine emits BOTH a `favour-shifted` event AND an
  // `opinion-card-gained` event for the same character. Rendering
  // both produces a redundant "Favour Gained: Vera Brass +1" card
  // next to the "Opinion Card Gained: Vera Brass — Ally" card —
  // same character, same beat, two visuals telling the player the
  // exact same thing. The Opinion Card variant carries the printed
  // art + headline, so we keep that one and drop the matching
  // favour shift. Favour shifts on characters that DIDN'T cross a
  // threshold this batch (e.g. +2 -> +3 with no new card) still
  // render normally — those are the only beats where the favour
  // card is the sole signal the player has of the change.
  const opinionCardCharacterIds = new Set(
    events
      .filter((e): e is Extract<RewardEvent, { kind: "opinion-card-gained" }> => e.kind === "opinion-card-gained")
      .map((e) => e.characterId),
  );
  const filteredEvents = events.filter((e) => {
    if (e.kind === "favour-shifted" && opinionCardCharacterIds.has(e.characterId)) {
      logEvent("rewards.modal.suppressed-favour-shift", {
        characterId: e.characterId,
        characterName: e.characterName,
        delta: e.delta,
        reason: "opinion-card-gained-in-same-batch",
      });
      return false;
    }
    return true;
  });
  // Coalesce ALL `shop-products-added` events in the batch into a
  // single merged event. A page that fires multiple
  // `add-shop-products` actions (e.g. Ch2's `page33-town-center` —
  // unconditional [8..12] + conditional [13] at >=2 key items +
  // conditional [14] at >=4 key items) would otherwise produce one
  // shop-card tile per event, splitting the products into multiple
  // stacked cards in the modal — each with their own 4-up grid that
  // mostly displays a single tile centred in 3/4 empty space,
  // overflowing the modal height and forcing the vertical scroll
  // the user explicitly rejected.
  //
  // Merging preserves authored order (concat in original event
  // sequence) and surfaces all unlocked product numbers in a single
  // 4-up grid (4+3 wrap for the 7-product Ch2 max). The merged
  // event takes the position of the FIRST shop-products-added entry
  // so mixed batches (shop-products + key-item-gained + ...) keep
  // their relative ordering vs the other reward variants.
  //
  // `questLabel` is taken from the first event that defines one —
  // today no page authors conflicting labels, and the modal only
  // surfaces a single banner per shop-card tile.
  //
  // Skipped when the batch contains 0 or 1 shop-products-added
  // events (nothing to merge) so the common case is a pass-through.
  const shopEventIndices: number[] = [];
  for (let i = 0; i < filteredEvents.length; i++) {
    if (filteredEvents[i]!.kind === "shop-products-added") shopEventIndices.push(i);
  }
  let visibleEvents = filteredEvents;
  if (shopEventIndices.length > 1) {
    const shopEvents = shopEventIndices.map((i) => filteredEvents[i]! as Extract<RewardEvent, { kind: "shop-products-added" }>);
    const mergedProductNumbers = shopEvents.flatMap((e) => e.productNumbers);
    const mergedQuestLabel = shopEvents.find((e) => e.questLabel)?.questLabel;
    // Preserve the highest-threshold clue context from merged events
    // so the player sees the most informative unlock reason.
    const mergedClueCtx = shopEvents
      .filter((e) => e.clueUnlockContext)
      .sort((a, b) => (b.clueUnlockContext!.threshold) - (a.clueUnlockContext!.threshold))[0]
      ?.clueUnlockContext;
    const merged: RewardEvent = {
      kind: "shop-products-added",
      productNumbers: mergedProductNumbers,
      ...(mergedQuestLabel !== undefined ? { questLabel: mergedQuestLabel } : {}),
      ...(mergedClueCtx !== undefined ? { clueUnlockContext: mergedClueCtx } : {}),
    };
    const firstShopIdx = shopEventIndices[0]!;
    const shopIdxSet = new Set(shopEventIndices);
    visibleEvents = filteredEvents.map((e, i) => {
      if (i === firstShopIdx) return merged;
      return e;
    }).filter((_, i) => i === firstShopIdx || !shopIdxSet.has(i));
    logEvent("rewards.modal.merged-shop-products", {
      mergedFromCount: shopEvents.length,
      productNumbers: mergedProductNumbers,
      questLabel: mergedQuestLabel ?? null,
    });
  }
  // Defensive: filtering should never empty the batch (a paired
  // favour-shift + opinion-card-gained always leaves at least the
  // opinion-card-gained), but a future event author who manually
  // crafts an opinion-card-only batch + a stray favour shift for
  // the same character would land here. Treat as "no rewards to
  // show" so the gate button doesn't open an empty modal.
  if (visibleEvents.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    logEvent("rewards.modal.open", {
      eventCount: visibleEvents.length,
      eventKinds: visibleEvents.map((e) => e.kind),
      suppressedCount: events.length - visibleEvents.length,
    });
    // Title swap for the "shop products added to the shop"
    // batch: those events represent a stock change, not a grant
    // to the player, so a player-facing "Earned" / "Discovered"
    // headline overstates what just happened. When EVERY visible
    // event is `shop-products-added`, re-label the modal to
    // "Added to Shop" so the player reads the moment as "the
    // shop opened up". For every other batch (hero-cards-
    // unlocked, key-item-gained, opinion-card-gained, memory-
    // chips-granted, creature-parts-changed, favour-shifted,
    // story-tokens-granted, quest-revealed, mixed batches that
    // include a shop-products-added event alongside something
    // else, ...) we use "Discovered" — broad enough to cover
    // every grant variant without the slightly transactional
    // tone of the original "Rewards Earned" copy.
    const isShopOnlyBatch = visibleEvents.every((e) => e.kind === "shop-products-added");
    const title = isShopOnlyBatch ? "Added to Shop" : "Discovered";
    const overlay = document.createElement("div");
    overlay.className = "rewards-modal";
    overlay.innerHTML = `
      <div class="rewards-modal-backdrop" data-rewards-backdrop></div>
      <div class="rewards-modal-body" role="dialog" aria-modal="true" aria-labelledby="rewards-modal-title">
        <h3 class="rewards-modal-title" id="rewards-modal-title">${title}</h3>
        <div class="rewards-modal-grid">
          ${visibleEvents.map(renderRewardCard).join("")}
        </div>
        <div class="rewards-modal-footer">
          <button class="btn btn--primary" data-rewards-continue>Continue \u2192</button>
        </div>
      </div>
    `;
    host.appendChild(overlay);

    let resolved = false;
    const dismiss = (reason: "backdrop" | "button" | "escape" | "unmount"): void => {
      if (resolved) return;
      resolved = true;
      logEvent("rewards.modal.close", { reason });
      document.removeEventListener("keydown", onKeydown);
      overlay.remove();
      resolve();
    };
    const onKeydown = (ev: KeyboardEvent): void => {
      // Self-clean if the screen unmounted while we were open (e.g.
      // user hit Back-to-Title via a global hotkey). Without this,
      // the keydown listener would leak past screen teardown and
      // continue handling input for a now-invisible modal.
      if (!overlay.isConnected) {
        dismiss("unmount");
        return;
      }
      if (ev.key === "Escape" || ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        dismiss("escape");
      }
    };

    overlay.querySelector<HTMLDivElement>("[data-rewards-backdrop]")!
      .addEventListener("click", () => dismiss("backdrop"));
    overlay.querySelector<HTMLButtonElement>("[data-rewards-continue]")!
      .addEventListener("click", () => dismiss("button"));
    // "SEE EQUIPMENT" buttons under any hero-card rewards in the
    // grid -- opens the equipment viewer stacked on top of this
    // modal so the player can study the starting loadout for a
    // newly granted Hero Card without dismissing the rewards
    // summary first.
    for (const btn of overlay.querySelectorAll<HTMLButtonElement>("[data-action=see-equipment]")) {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const num = Number(btn.dataset["cardNumber"]);
        if (!Number.isFinite(num)) return;
        void presentEquipmentCards(document.body, { heroCardNumber: num });
      });
    }
    document.addEventListener("keydown", onKeydown);
  });
}

/**
 * Per-variant card renderer. Each case returns the HTML for a
 * single `<article class="reward-card">` (or multiple if the
 * event represents a multi-recipient grant). Discriminated-union
 * exhaustiveness check at the bottom catches new variants at
 * compile time.
 */
function renderRewardCard(event: RewardEvent): string {
  switch (event.kind) {
    case "hero-cards-unlocked": {
      // One card per hero number. Multiple cards in a single event
      // flow into a CSS grid that wraps on narrow viewports. The
      // printed hero card art already carries the hero number,
      // name, suit, and slot loadout in its painted frame — so we
      // render just the image and let the card art speak for the
      // event without redundant eyebrow / name / suit-label rows.
      // Variant + suit modifier classes are preserved so any
      // existing CSS hooks (e.g. border-accent colour by suit) keep
      // working.
      return event.cardNumbers
        .map((num) => {
          const meta = getHeroCard(num);
          return `
            <article class="reward-card reward-card--hero reward-card--suit-${meta.suit}">
              <img class="reward-card-art" src="/heroes/${meta.image}" alt="${escapeHtml(meta.name)}" />
              <button
                type="button"
                class="btn btn--small btn--ghost see-equipment-btn"
                data-action="see-equipment"
                data-card-number="${num}"
                title="Show the equipment cards that come with this Hero Card."
              >SEE EQUIPMENT</button>
            </article>
          `;
        })
        .join("");
    }
    case "memory-chips-granted": {
      const label = event.amount === 1 ? "Memory Chip" : "Memory Chips";
      return `
        <article class="reward-card reward-card--memory">
          <div class="reward-card-eyebrow small muted">${escapeHtml(label)} Earned</div>
          <div class="reward-card-token-row">
            <img class="reward-card-token" src="/tokens/memory-fragment.webp" alt="Memory Chip" />
            <span class="reward-card-delta reward-card-delta--gain">+${event.amount}</span>
          </div>
          <div class="reward-card-name"><strong>${escapeHtml(label)}</strong></div>
          <div class="reward-card-meta small muted">Total: ${event.totalAfter} chip${event.totalAfter === 1 ? "" : "s"}</div>
        </article>
      `;
    }
    case "creature-parts-changed": {
      const isGain = event.direction === "gain";
      const verb = isGain ? "Gained" : "Lost";
      const partLabel = event.partKind === "minion" ? "Minion Part" : `Level ${event.partKind.slice(-1)} Boss Part`;
      // One row per recipient hero, each showing the delta + the
      // suit-aware token icon (mind / body uses different token art).
      const rows = event.recipients
        .map((r) => {
          const hero = getHero(r.heroId);
          const tokenFile = event.partKind === "minion"
            ? `minion-${hero.suit}.webp`
            : `${event.partKind}-${hero.suit}.webp`;
          const delta = r.after - r.before;
          const signed = delta >= 0 ? `+${delta}` : `${delta}`;
          const deltaCls = delta >= 0 ? "reward-card-delta--gain" : "reward-card-delta--loss";
          const suitLabel = hero.suit === "mind" ? "Mind" : "Body";
          return `
            <div class="reward-card-token-row">
              <img class="reward-card-token" src="/tokens/${tokenFile}" alt="${escapeHtml(partLabel)} (${escapeHtml(suitLabel)})" />
              <span class="reward-card-delta ${deltaCls}">${signed}</span>
              <span class="reward-card-recipient small">${escapeHtml(suitLabel)} (${r.before} &rarr; ${r.after})</span>
            </div>
          `;
        })
        .join("");
      const variantCls = isGain ? "reward-card--parts-gain" : "reward-card--parts-loss";
      return `
        <article class="reward-card reward-card--parts ${variantCls}">
          <div class="reward-card-eyebrow small muted">${escapeHtml(verb)}: ${escapeHtml(partLabel)}${event.recipients.length === 1 ? "" : "s"}</div>
          ${rows}
        </article>
      `;
    }
    case "shop-products-added": {
      // The printed shop-product card art carries the number, name,
      // category, location, and effect text in its painted frame,
      // so each row collapses to just the thumbnail when art is
      // available. Placeholder rows (no art bundled for that product
      // number yet) fall back to a number + name label so the player
      // can still tell what was unlocked.
      //
      // Machinist shop products (#41 Shock Gauntlet, #34 Cyclone Boots,
      // #32 Earth's Embrace Shield) ALSO grant 5 Equipment Upgrade
      // cards — the printed shop-card text says "Find the 5 matching
      // Equipment cards in the Equipment Upgrade Deck. These will
      // replace your current X Equipment." For those, we render a
      // larger shop-card thumbnail PLUS the row of 5 upgrade cards
      // beneath so the player actually sees what they unlocked.
      // Lookup returns null for non-Machinist products, which fall
      // through to the compact 4-up tile layout.
      const list = event.productNumbers
        .map((n) => {
          const p = getShopProduct(n);
          const img = shopProductImageOrNull(p.number);
          const upgradeCards = equipmentUpgradeCardsForShopProduct(p.number);
          if (img && upgradeCards) {
            const upgrades = upgradeCards
              .map((cardNum) => `
                <li class="reward-card-upgrade">
                  <img class="reward-card-upgrade-thumb" src="/equipment-upgrades/${equipmentUpgradeImage(cardNum)}" alt="Equipment Upgrade #${cardNum}" />
                </li>
              `)
              .join("");
            return `
              <li class="reward-card-product reward-card-product--featured">
                <img class="reward-card-product-thumb reward-card-product-thumb--featured" src="/shop-products/${img}" alt="Shop Product #${p.number} - ${escapeHtml(p.name)}" />
                <div class="reward-card-upgrade-eyebrow small muted">5 Equipment Upgrade cards unlocked</div>
                <ul class="reward-card-upgrade-list">${upgrades}</ul>
              </li>
            `;
          }
          if (img) {
            return `
              <li class="reward-card-product reward-card-product--art">
                <img class="reward-card-product-thumb" src="/shop-products/${img}" alt="Shop Product #${p.number} - ${escapeHtml(p.name)}" />
              </li>
            `;
          }
          return `
            <li class="reward-card-product">
              <span class="reward-card-product-thumb reward-card-product-thumb--placeholder" aria-hidden="true">#${p.number}</span>
              <span class="reward-card-product-num">#${p.number}</span>
              <span class="reward-card-product-name">${escapeHtml(p.name)}</span>
            </li>
          `;
        })
        .join("");
      // If the batch contains at least one featured (Machinist)
      // product, switch the outer card to the featured variant so
      // the CSS knows to widen the card and let the upgrade row
      // breathe horizontally.
      const hasFeatured = event.productNumbers.some((n) => equipmentUpgradeCardsForShopProduct(n) !== null);
      const variantCls = hasFeatured ? " reward-card--shop-featured" : "";
      const clueNote = event.clueUnlockContext
        ? `<p class="reward-card-clue-note small muted">&#128270; Unlocked: you have ${event.clueUnlockContext.clues} clue icon${event.clueUnlockContext.clues === 1 ? "" : "s"} across your Key Items (${event.clueUnlockContext.threshold}+ required)</p>`
        : "";
      return `
        <article class="reward-card reward-card--shop${variantCls}">
          <ul class="reward-card-product-list">${list}</ul>
          ${clueNote}
        </article>
      `;
    }
    case "key-item-gained": {
      // Printed key item art carries number + name + flavour, so
      // when art is bundled we render just the image. Placeholder
      // path still labels with eyebrow + name so a yet-to-be-imaged
      // key item doesn't appear without context.
      const image = keyItemImageOrNull(event.number);
      if (image) {
        return `
          <article class="reward-card reward-card--key-item">
            <img class="reward-card-key-art-img" src="/key-items/${image}" alt="Key Item #${event.number} - ${escapeHtml(event.name)}" />
          </article>
        `;
      }
      return `
        <article class="reward-card reward-card--key-item">
          <div class="reward-card-eyebrow small muted">Key Item Acquired</div>
          <div class="reward-card-key-art reward-card-key-art--placeholder" aria-hidden="true">
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path d="M14.5 2a5.5 5.5 0 0 0-5.39 6.64L2 15.76V21h5.24l1.5-1.5 1.5 1.5 1.86-1.86-1.5-1.5 1.5-1.5-1.86-1.86 4.12-4.12A5.5 5.5 0 1 0 14.5 2zm1.5 6.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z" fill="currentColor"/>
            </svg>
            <span class="reward-card-key-num">#${event.number}</span>
          </div>
          <div class="reward-card-name"><strong>Key Item #${event.number}</strong> &middot; ${escapeHtml(event.name)}</div>
        </article>
      `;
    }
    case "quest-revealed": {
      // Printed quest card carries the number + name + objective in
      // its painted frame. Render just the image when art is
      // available; placeholder path keeps text so a yet-to-be-imaged
      // quest still surfaces meaningfully.
      const image = questImageOrNull(event.number);
      if (image) {
        return `
          <article class="reward-card reward-card--quest">
            <img class="reward-card-quest-art-img" src="/quests/${image}" alt="Quest #${event.number} - ${escapeHtml(event.name)}" />
          </article>
        `;
      }
      return `
        <article class="reward-card reward-card--quest">
          <div class="reward-card-eyebrow small muted">New Quest Unlocked</div>
          <div class="reward-card-quest-art reward-card-quest-art--placeholder" aria-hidden="true">
            <div class="reward-card-quest-art-label">QUEST</div>
            <div class="reward-card-quest-art-num">#${String(event.number).padStart(2, "0")}</div>
          </div>
          <div class="reward-card-name">
            <strong>Quest #${String(event.number).padStart(2, "0")}</strong> &middot; ${escapeHtml(event.name)}
          </div>
        </article>
      `;
    }
    case "opinion-card-gained": {
      // The favour engine emits this for every newly-entered named
      // level regardless of whether art ships for the pair (e.g.
      // Rodrigo Ally from Ch2's Library/B has no art in the
      // `OPINION_CARDS` catalog). When art is present we render
      // just the image — the printed card carries the character
      // name + ALLY / DETRACTOR / CONFIDANT / NEMESIS level + the
      // effect text in its painted frame. Placeholder fallback
      // keeps its labels because the placeholder tile can't convey
      // any of that visually.
      const image = opinionCardImageOrNull(event.characterId, event.level);
      if (image) {
        return `
          <article class="reward-card reward-card--opinion reward-card--opinion-${event.level}">
            <img class="reward-card-opinion-art-img" src="/opinion-cards/${image}" alt="${escapeHtml(event.characterName)} - ${event.level} Opinion Card" />
          </article>
        `;
      }
      const levelLabel = event.level.charAt(0).toUpperCase() + event.level.slice(1);
      return `
        <article class="reward-card reward-card--opinion reward-card--opinion-${event.level}">
          <div class="reward-card-eyebrow small muted">Opinion Card Gained</div>
          <div class="reward-card-opinion-art reward-card-opinion-art--placeholder" aria-hidden="true">
            <div class="reward-card-opinion-art-label">OPINION CARD</div>
            <div class="reward-card-opinion-art-name">${escapeHtml(event.characterName)}</div>
            <div class="reward-card-opinion-art-level">${escapeHtml(levelLabel.toUpperCase())}</div>
          </div>
          <div class="reward-card-name">
            <strong>${escapeHtml(event.characterName)}</strong> &middot; ${escapeHtml(levelLabel)}
          </div>
        </article>
      `;
    }
    case "story-tokens-granted": {
      // Stylised dots — one filled per story token granted (capped
      // visually at 5 to keep the row tidy; absurd amounts would
      // still render the headline number).
      const dots = Array.from({ length: Math.min(event.amount, 5) })
        .map(() => `<span class="reward-card-token-dot" aria-hidden="true"></span>`)
        .join("");
      return `
        <article class="reward-card reward-card--story-tokens">
          <div class="reward-card-eyebrow small muted">Story Tokens Granted</div>
          <div class="reward-card-token-row">${dots}</div>
          <div class="reward-card-name"><strong>+${event.amount} Story Token${event.amount === 1 ? "" : "s"}</strong></div>
          <div class="small muted">Pool now ${event.totalAfter}</div>
        </article>
      `;
    }
    case "key-item-discarded": {
      // Discard state is conveyed visually by the CSS treatment
      // attached to `.reward-card-key-art-img--discarded` (overlay
      // ribbon, desaturation, etc.). With art available we render
      // just the image; placeholder path keeps text so the player
      // can still tell what was handed over when art isn't bundled.
      const image = keyItemImageOrNull(event.number);
      if (image) {
        return `
          <article class="reward-card reward-card--key-item reward-card--key-item-discarded">
            <img class="reward-card-key-art-img reward-card-key-art-img--discarded" src="/key-items/${image}" alt="Key Item #${event.number} - ${escapeHtml(event.name)}" />
          </article>
        `;
      }
      return `
        <article class="reward-card reward-card--key-item reward-card--key-item-discarded">
          <div class="reward-card-eyebrow small muted">Key Item Handed Over</div>
          <div class="reward-card-key-art reward-card-key-art--placeholder reward-card-key-art--discarded" aria-hidden="true">
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path d="M14.5 2a5.5 5.5 0 0 0-5.39 6.64L2 15.76V21h5.24l1.5-1.5 1.5 1.5 1.86-1.86-1.5-1.5 1.5-1.5-1.86-1.86 4.12-4.12A5.5 5.5 0 1 0 14.5 2zm1.5 6.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z" fill="currentColor"/>
            </svg>
            <span class="reward-card-key-num">#${event.number}</span>
          </div>
          <div class="reward-card-name"><strong>Key Item #${event.number}</strong> &middot; ${escapeHtml(event.name)}</div>
        </article>
      `;
    }
    case "favour-shifted": {
      const isAlly = event.delta > 0;
      const variantCls = isAlly ? "reward-card--favour-ally" : "reward-card--favour-detractor";
      const signed = event.delta >= 0 ? `+${event.delta}` : `${event.delta}`;
      const deltaCls = isAlly ? "reward-card-delta--gain" : "reward-card-delta--loss";
      const eyebrow = isAlly ? "Favour Gained" : "Favour Lost";
      const totalSigned = event.totalAfter > 0
        ? `+${event.totalAfter}`
        : `${event.totalAfter}`;
      return `
        <article class="reward-card reward-card--favour ${variantCls}">
          <div class="reward-card-eyebrow small muted">${escapeHtml(eyebrow)}</div>
          <div class="reward-card-favour-row">
            <div class="reward-card-favour-avatar" aria-hidden="true">${escapeHtml(initialsOf(event.characterName))}</div>
            <div class="reward-card-favour-meta">
              <div class="reward-card-name"><strong>${escapeHtml(event.characterName)}</strong></div>
              <div class="small muted">${isAlly ? "Ally opinion" : "Detractor opinion"} &middot; now at ${totalSigned}</div>
            </div>
            <span class="reward-card-delta ${deltaCls}">${signed}</span>
          </div>
        </article>
      `;
    }
    case "opinion-rank-bumped": {
      const isPositive = event.delta > 0;
      const hero = getHero(event.heroId);
      const suitLabel = hero.suit === "mind" ? "Mind Delver" : "Body Delver";
      const variantCls = isPositive ? "reward-card--opinion-bump-up" : "reward-card--opinion-bump-down";
      const deltaCls = isPositive ? "reward-card-delta--gain" : "reward-card-delta--loss";
      const signed = isPositive ? `+${event.delta}` : `${event.delta}`;
      // "R3 -> R4" vs "R3 -> R3" (when clamped); fall back to a
      // compact "no change" label when the bump was a no-op.
      const rankCopy = event.effectiveBefore === event.effectiveAfter
        ? `R${event.effectiveBefore} (clamped)`
        : `R${event.effectiveBefore} -> R${event.effectiveAfter}`;
      return `
        <article class="reward-card reward-card--opinion-bump ${variantCls}">
          <div class="reward-card-eyebrow small muted">Opinion - ${escapeHtml(sourceLabel(event.source))}</div>
          <div class="reward-card-favour-row">
            <div class="reward-card-favour-meta">
              <div class="reward-card-name"><strong>${escapeHtml(suitLabel)}</strong> &middot; ${escapeHtml(event.equipmentType)}</div>
              <div class="small muted">${escapeHtml(rankCopy)}</div>
            </div>
            <span class="reward-card-delta ${deltaCls}">${signed} RANK</span>
          </div>
        </article>
      `;
    }
    case "opinion-card-redeemed": {
      // Spent state is conveyed visually by the
      // `.reward-card-opinion-art-img--spent` CSS treatment
      // (desaturation / "SPENT" stamp) attached to the printed
      // opinion card art. With art available we render just the
      // image. Placeholder fallback keeps text + the redeem summary
      // because the placeholder tile can't communicate what the
      // ability did on its own.
      const image = opinionCardImageOrNull(event.characterId, event.level);
      if (image) {
        return `
          <article class="reward-card reward-card--opinion reward-card--opinion-redeemed reward-card--opinion-${event.level}">
            <img class="reward-card-opinion-art-img reward-card-opinion-art-img--spent" src="/opinion-cards/${image}" alt="${escapeHtml(event.characterName)} - ${event.level} Opinion Card (redeemed)" />
          </article>
        `;
      }
      const levelLabel = event.level.charAt(0).toUpperCase() + event.level.slice(1);
      return `
        <article class="reward-card reward-card--opinion reward-card--opinion-redeemed reward-card--opinion-${event.level}">
          <div class="reward-card-eyebrow small muted">Opinion Card Redeemed</div>
          <div class="reward-card-opinion-art reward-card-opinion-art--placeholder" aria-hidden="true">
            <div class="reward-card-opinion-art-label">OPINION CARD</div>
            <div class="reward-card-opinion-art-name">${escapeHtml(event.characterName)}</div>
            <div class="reward-card-opinion-art-level">${escapeHtml(levelLabel.toUpperCase())}</div>
          </div>
          <div class="reward-card-name">
            <strong>${escapeHtml(event.characterName)}</strong> &middot; ${escapeHtml(levelLabel)}
          </div>
          <div class="small muted">${escapeHtml(event.summary)}</div>
        </article>
      `;
    }
    case "opinion-card-shielded-decrease": {
      // Samantha Ally ("Popular") auto-fired — render her Ally art with the spent
      // CSS treatment (`--spent` desaturation / "SPENT" stamp). The
      // contextual "who got shielded" copy lives in the session
      // log + can be added back to the modal on request if players
      // need the explicit narrative beat.
      const image = opinionCardImageOrNull("samantha", "ally");
      if (image) {
        return `
          <article class="reward-card reward-card--opinion reward-card--opinion-shielded reward-card--opinion-ally">
            <img class="reward-card-opinion-art-img reward-card-opinion-art-img--spent" src="/opinion-cards/${image}" alt="Samantha - Ally Opinion Card (shielded ${escapeHtml(event.shieldedCharacterName)}'s opinion)" />
          </article>
        `;
      }
      return `
        <article class="reward-card reward-card--opinion reward-card--opinion-shielded reward-card--opinion-ally">
          <div class="reward-card-eyebrow small muted">Samantha's Favor Shielded You</div>
          <div class="reward-card-opinion-art reward-card-opinion-art--placeholder" aria-hidden="true">
            <div class="reward-card-opinion-art-label">OPINION CARD</div>
            <div class="reward-card-opinion-art-name">Samantha</div>
            <div class="reward-card-opinion-art-level">ALLY</div>
          </div>
          <div class="reward-card-name"><strong>${escapeHtml(event.shieldedCharacterName)}</strong>'s opinion shielded</div>
          <div class="small muted">A ${event.preventedDelta} opinion shift was prevented. Samantha's card is now spent.</div>
        </article>
      `;
    }
    case "ultra-level-cards-gained": {
      // One printed card per granted Ultra. The card face already
      // shows "ULTRA LEVEL UP" + the three equipment choices in its
      // painted frame, so we render just the image — same simplified
      // pass as hero / quest / opinion cards. Cards are sorted
      // ascending by number so the modal layout is stable across
      // refreshes (the engine also stores them sorted). The implicit
      // "this card will appear in future quests" promise is conveyed
      // by the printed text on the card itself; if it ever needs an
      // explicit caption, add a single eyebrow row here.
      const cards = event.cardNumbers
        .map((n) => ({ n, image: levelUpCardImageOrNull(n) }))
        .map((c) => {
          if (c.image) {
            return `
              <article class="reward-card reward-card--ultra-level">
                <img class="reward-card-ultra-level-art-img" src="/levelup/${c.image}" alt="Ultra Level Up Card #${c.n}" />
              </article>
            `;
          }
          return `
            <article class="reward-card reward-card--ultra-level">
              <div class="reward-card-eyebrow small muted">Ultra Level Card</div>
              <div class="reward-card-name"><strong>Ultra Level Card #${c.n}</strong></div>
            </article>
          `;
        })
        .join("");
      return cards;
    }
    case "memory-cards-gained": {
      // One printed Memory card per drawn number. Duplicates are
      // expected (the v1 pool only has 2 cards; a 3+ chip player
      // collapses repeats visually but the array carries every
      // draw so the count math stays honest). Render each draw as
      // its own tile so the player can SEE "I spent 3, I got 3
      // cards" without having to do the bookkeeping mentally.
      // The eyebrow row carries the spend math ("3 Memory Chip
      // Tokens spent") so the moment reads as transactional —
      // distinct from the silent "memory chip granted" event that
      // fires elsewhere.
      const tiles = event.cardNumbers
        .map((n) => {
          const image = memoryCardImageOrNull(n);
          const name = memoryCardNameOrNull(n) ?? `Memory #${String(n).padStart(2, "0")}`;
          if (image) {
            const back = memoryCardBackImageOrNull(n);
            return `
              <article class="reward-card reward-card--memory-card">
                <img class="reward-card-memory-art-img" src="/memory-cards/${image}" alt="Memory Card #${n} - ${escapeHtml(name)}" />
              </article>
              ${back ? `
              <article class="reward-card reward-card--memory-card">
                <img class="reward-card-memory-art-img" src="/memory-cards/${back}" alt="Memory Card #${n} back" />
              </article>` : ""}
            `;
          }
          return `
            <article class="reward-card reward-card--memory-card">
              <div class="reward-card-eyebrow small muted">Memory Card</div>
              <div class="reward-card-name"><strong>Memory #${String(n).padStart(2, "0")}</strong></div>
              <div class="small muted">${escapeHtml(name)}</div>
            </article>
          `;
        })
        .join("");
      const chipLabel = event.chipsSpent === 1 ? "Memory Chip Token" : "Memory Chip Tokens";
      return `
        <article class="reward-card reward-card--memory-cards-batch">
          <div class="reward-card-eyebrow small muted">${event.chipsSpent} ${escapeHtml(chipLabel)} spent</div>
          <div class="reward-card-memory-card-grid">${tiles}</div>
        </article>
      `;
    }
    case "academy-donation-resolved": {
      // Renders the Chapter 2 Town Center donation resolution
      // card. Tier-coloured eyebrow + per-delver grant list. For
      // `tier === "none"` (0-2 donated) we still show the card
      // so the player sees their donation was logged but didn't
      // reach a reward tier — surfaces the threshold rule.
      //
      // Per-pick bumps (the actual +N rank deltas) surface
      // SEPARATELY as `suit-condition-rank-bumped` cards after
      // the picker modal resolves — so for non-"none" tiers we
      // swap the grants-list copy for a "your picks land
      // below" affordance to set the player's expectation.
      const tierLabel = event.schedule === "ch4"
        ? (event.tier === "none"   ? "No reward tier (running total 11+ needed)"
          : event.tier === "small"  ? "Running total 11-20"
          : event.tier === "medium" ? "Running total 21-34"
          : "Running total 35+")
        : event.schedule === "ch3"
        ? (event.tier === "none"   ? "No reward tier (running total 6+ needed)"
          : event.tier === "small"  ? "Running total 6-12"
          : event.tier === "medium" ? "Running total 13-21"
          : "Running total 22+")
        : (event.tier === "none"   ? "No reward tier (donate 3+ for a reward)"
          : event.tier === "small"  ? "Small reward tier (3-5)"
          : event.tier === "medium" ? "Medium reward tier (6-9)"
          : "Large reward tier (10+)");
      const grantLines = event.tier === "none"
        ? `<div class="small muted">No rank bonuses earned this visit.</div>`
        : event.grants.length === 0
          ? `<div class="small muted">Your equipment-rank picks will resolve next.</div>`
          : event.grants.map((g) => {
              const heroLabel = g.heroId === "hero-01" ? "Mind delver"
                : g.heroId === "hero-02" ? "Body delver"
                : g.heroId;
              return `<div class="reward-card-donation-grant"><strong>${escapeHtml(heroLabel)}</strong>: +${g.delta} ${escapeHtml(g.equipmentType)} Rank</div>`;
            }).join("");
      return `
        <article class="reward-card reward-card--donation reward-card--donation-${event.tier}">
          <div class="reward-card-eyebrow small muted">Delving Academy Donation</div>
          <div class="reward-card-name"><strong>${event.totalDonated}</strong> minion parts donated${event.schedule === "ch3" || event.schedule === "ch4" ? " (running total)" : ""}</div>
          <div class="reward-card-donation-tier">${escapeHtml(tierLabel)}</div>
          <div class="reward-card-donation-grants">${grantLines}</div>
        </article>
      `;
    }
    case "scenario-card-resolved": {
      // Headline "you resolved Scenario #N" card emitted by
      // `engine/scenarioCard.ts > chooseScenarioOption`. Renders
      // alongside any granular reward events the chosen option
      // produced (HP heal, level-up draw, etc.); for MANUAL
      // resolutions (cards #03..#09, A, B today) this is the
      // only card in the batch, and the modal serves as a
      // "click-through to acknowledge you handled the printed
      // effect at the table" affordance.
      return `
        <article class="reward-card reward-card--scenario">
          <div class="reward-card-eyebrow small muted">${escapeHtml(event.headline)}</div>
          <div class="reward-card-name"><strong>Resolution ${escapeHtml(event.chosenOption)}</strong> applied</div>
        </article>
      `;
    }
    case "friendly-spawn-card-gained": {
      // Player visited a Town Visit page that granted a Friendly
      // Spawn Card (Ch1 Library Atlas Archives, Ch2 Academy
      // Xavier's Lecture today). Renders the printed spawn-card
      // art so the player sees which card was shuffled in.
      const padded = String(event.cardNumber).padStart(2, "0");
      return `
        <article class="reward-card reward-card--friendly-spawn">
          <div class="reward-card-eyebrow small muted">Friendly Spawn Card Added</div>
          <img class="reward-card-friendly-spawn-art" src="/spawn-cards/${escapeHtml(event.image)}" alt="Friendly Spawn Card #${padded}" draggable="false" />
          <div class="reward-card-name"><strong>Friendly Spawn Card #${padded}</strong></div>

        </article>
      `;
    }
    case "lieutenant-spawn-card-on-top": {
      // Storybook Lieutenant challenge: the card is on top of the Spawn
      // Deck (fought next wave) and stays in the deck afterwards.
      return `
        <article class="reward-card reward-card--friendly-spawn">
          <div class="reward-card-eyebrow small muted">${event.added ? "Lieutenants Spawn Card Added" : "Lieutenants Spawn Card on Top"}</div>
          <img class="reward-card-friendly-spawn-art" src="/spawn-cards/${escapeHtml(event.image)}" alt="Lieutenants Spawn Card #${event.cardNumber}" draggable="false" />
          <div class="reward-card-name"><strong>Lieutenants Spawn Card #${event.cardNumber}</strong> &middot; next wave, then in the Spawn Deck for the rest of the campaign (${event.deckSize}/6)</div>
        </article>
      `;
    }
    case "friendly-encounter-resolved": {
      // Headline "Friendly Encounter resolved" card emitted by
      // `engine/friendlyEncounter.ts > resolveFriendlyEncounter`.
      // Today the printed effect is applied manually at the table
      // (mirrors MANUAL scenario cards); the card serves as the
      // player-facing "you handled the printed effect" log entry.
      const padded = String(event.cardNumber).padStart(2, "0");
      return `
        <article class="reward-card reward-card--friendly-encounter">
          <div class="reward-card-eyebrow small muted">Friendly Encounter #${padded}</div>
          <img class="reward-card-friendly-encounter-art" src="/friendly-encounter-cards/${escapeHtml(event.image)}" alt="${escapeHtml(event.name)}" draggable="false" />
          <div class="reward-card-name"><strong>${escapeHtml(event.name)}</strong></div>
        </article>
      `;
    }
    case "delver-healed": {
      // Per-delver HP heal surfaced alongside the parent
      // `scenario-card-resolved` headline (today the only
      // emitter is `heal-both-delvers`; future heal effects
      // can reuse this card without changes).
      const hero = getHero(event.heroId);
      const heroLabel = hero.suit === "mind" ? "Mind Delver" : "Body Delver";
      return `
        <article class="reward-card reward-card--heal reward-card--heal-${hero.suit}">
          <div class="reward-card-eyebrow small muted">Healed</div>
          <div class="reward-card-token-row">
            <span class="reward-card-heart" aria-hidden="true">
              <svg viewBox="0 0 24 22">
                <path d="M12 21.5 L2.5 11.5 A5.5 5.5 0 0 1 12 5.0 A5.5 5.5 0 0 1 21.5 11.5 Z"
                      fill="#e93b3b" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" />
              </svg>
            </span>
            <span class="reward-card-delta reward-card-delta--gain">+${event.amount} HP</span>
          </div>
          <div class="reward-card-name"><strong>${escapeHtml(heroLabel)}</strong></div>
          <div class="reward-card-meta small muted">${event.before} &rarr; ${event.after} HP</div>
        </article>
      `;
    }
    case "suit-condition-rank-bumped": {
      // Renders a single Suit Condition picker resolution — fired
      // from `engine/suitConditionGrants.ts > applySuitConditionRankPick`,
      // surfaced in the post-picker rewards modal sweep that
      // `screens/TownVisit.ts > mountCollectRewards` runs after
      // draining `pendingSuitConditionPicks`. Eyebrow surfaces
      // the source (blood-soaked / academy donation) so the
      // player can connect the +N to the in-fiction reason.
      const heroLabel = event.heroId === "hero-01" ? "Mind delver"
        : event.heroId === "hero-02" ? "Body delver"
        : event.heroId;
      const sourceText =
        event.source === "ch2.entry.died.mind" ? "Blood-Soaked Mind Delversuit"
        : event.source === "ch2.entry.died.body" ? "Blood-Soaked Body Delversuit"
        : event.source === "ch2.entry.died.both" ? "Blood-Soaked Delversuit"
        : event.source.startsWith("academy-donation-") ? "Delving Academy Donation"
        : event.source.startsWith("boss-card-") ? "Upcoming Boss — Rank Access"
        : event.source;
      const heroSuit = event.heroId === "hero-01" ? "mind" : "body";

      if (event.unlockOnly) {
        // Boss-card unlock: one new rank of access was opened (R4 or R5).
        const cap = event.unlockedCap ?? 4;
        let artHtml = "";
        try {
          const card = getEquipmentByTypeSuit(heroSuit, event.equipmentType);
          const capImage = imageForRank(heroSuit, event.equipmentType, cap);
          artHtml = `<img class="reward-card-rank-art-img" src="/cards/${escapeHtml(capImage)}" alt="${escapeHtml(card.name)} R${cap}" draggable="false" />`;
        } catch { /* no art — text only */ }
        return `
          <article class="reward-card reward-card--suit-condition">
            <div class="reward-card-eyebrow small muted">${escapeHtml(sourceText)}</div>
            <div class="reward-card-name"><strong>${escapeHtml(heroLabel)}</strong>: ${escapeHtml(event.equipmentType)} — R${cap} Access Unlocked</div>
            <div class="reward-card-rank-delta small muted">R${cap} is now accessible</div>
            ${artHtml}
          </article>
        `;
      }

      // Preview the post-pick rank card so the player sees the
      // equipment they upgraded (or unlocked).
      let artHtml = "";
      try {
        const card = getEquipmentByTypeSuit(heroSuit, event.equipmentType);
        const previewImage = imageForRank(heroSuit, event.equipmentType, Math.max(1, event.effectiveAfter));
        artHtml = `<img class="reward-card-rank-art-img" src="/cards/${escapeHtml(previewImage)}" alt="${escapeHtml(card.name)} R${event.effectiveAfter}" draggable="false" />`;
      } catch {
        // No matching card art (e.g. a delver doesn't own this
        // slot's R1 card yet). Render the headline copy only.
      }
      return `
        <article class="reward-card reward-card--suit-condition">
          <div class="reward-card-eyebrow small muted">${escapeHtml(sourceText)}</div>
          <div class="reward-card-name"><strong>${escapeHtml(heroLabel)}</strong>: +${event.delta} ${escapeHtml(event.equipmentType)} Rank</div>
          <div class="reward-card-rank-delta small muted">R${event.effectiveBefore} &rarr; R${event.effectiveAfter}</div>
          ${artHtml}
        </article>
      `;
    }
    case "quest-completed": {
      const image = questImageOrNull(event.number);
      return `
        <article class="reward-card reward-card--quest">
          <div class="reward-card-eyebrow small muted">Quest Complete</div>
          ${image ? `<img class="reward-card-quest-art-img" src="/quests/${image}" alt="Quest #${event.number} - ${escapeHtml(event.name)}" />` : ""}
          <div class="reward-card-name">
            <strong>Quest #${String(event.number).padStart(2, "0")}</strong> &middot; ${escapeHtml(event.name)}
          </div>
        </article>
      `;
    }
    case "scenario-card-placed": {
      const card = getScenarioCard(event.cardNumber);
      return `
        <article class="reward-card reward-card--scenario-placed">
          <div class="reward-card-eyebrow small muted">Placed on top of the Scenario Deck</div>
          <img class="reward-card-product-thumb reward-card-product-thumb--featured" src="/scenario-cards/${escapeHtml(card.frontImage)}" alt="${escapeHtml(card.printedId)} - ${escapeHtml(card.name)}" />
        </article>
      `;
    }
    case "opinion-card-blocked": {
      const image = opinionCardImageOrNull(event.characterId, event.level);
      return `
        <article class="reward-card reward-card--opinion reward-card--discarded">
          <div class="reward-card-eyebrow small muted">Opinion Card Not Taken</div>
          ${image ? `<img class="reward-card-opinion-art-img reward-card-opinion-art-img--spent" src="/opinion-cards/${image}" alt="${escapeHtml(event.characterName)} ${escapeHtml(event.level)}" />` : ""}
          <div class="reward-card-name"><strong>${escapeHtml(event.characterName)}</strong> &middot; ${escapeHtml(event.level)}</div>
          <div class="small muted">Headmistress Arlen's card: you can't hold more than ${event.limit} Ally/Confidant card${event.limit === 1 ? "" : "s"}.</div>
        </article>
      `;
    }
    case "opinion-card-discarded": {
      const image = opinionCardImageOrNull(event.characterId, event.level as Parameters<typeof opinionCardImageOrNull>[1]);
      return `
        <article class="reward-card reward-card--opinion reward-card--discarded">
          <div class="reward-card-eyebrow small muted">Opinion Card Discarded</div>
          ${image ? `<img class="reward-card-opinion-art-img reward-card-opinion-art-img--spent" src="/opinion-cards/${image}" alt="${escapeHtml(event.characterName)} ${escapeHtml(event.level)}" />` : ""}
          <div class="reward-card-name"><strong>${escapeHtml(event.characterName)}</strong> &middot; ${escapeHtml(event.level)}</div>
        </article>
      `;
    }
    case "wave-effect": {
      return `
        <article class="reward-card reward-card--wave-effect">
          <div class="reward-card-eyebrow small muted">End of Wave</div>
          <div class="reward-card-name">${escapeHtml(event.text)}</div>
        </article>
      `;
    }
    case "shop-product-granted": {
      const p = getShopProduct(event.productNumber);
      const img = shopProductImageOrNull(p.number);
      const hero = getHero(event.heroId);
      return `
        <article class="reward-card reward-card--shop">
          <div class="reward-card-eyebrow small muted">Free Shop Product &middot; ${hero.suit === "mind" ? "Mind" : "Body"} delver</div>
          ${img ? `<img class="reward-card-product-thumb reward-card-product-thumb--featured" src="/shop-products/${img}" alt="Shop Product #${p.number} - ${escapeHtml(p.name)}" />` : ""}
          <div class="reward-card-name"><strong>#${p.number}</strong> &middot; ${escapeHtml(p.name)}</div>
        </article>
      `;
    }
  }
  // Exhaustiveness check — every variant above returns, so if a
  // future RewardEvent kind lands without a render case, TS will
  // refuse to assign it to `never` and yell at compile time.
  const _exhaustive: never = event;
  throw new Error(`Unhandled RewardEvent kind: ${(_exhaustive as { kind: string }).kind}`);
}

/**
 * Pretty-print an Opinion Card source id for the rewards modal
 * eyebrow. `"xavier-ally"` -> `"Xavier's Ally Favor"`, etc.
 * Defensive fallback to the raw id keeps unknown sources legible
 * if a future card lands without a matching label here.
 */
function sourceLabel(source: string): string {
  switch (source) {
    case "xavier-ally":      return "Xavier's Ally Favor";
    case "xavier-confidant": return "Xavier's Confidant Favor";
    case "xavier-detractor": return "Xavier's Detractor Curse";
    case "xavier-nemesis":   return "Xavier's Nemesis Curse";
    default: return source;
  }
}

/** Initials helper for the favour-card avatar — "Vera Brass" -> "VB",
 * "Xavier" -> "X". Truncates to 2 characters max so the avatar disc
 * never overflows its fixed size. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
