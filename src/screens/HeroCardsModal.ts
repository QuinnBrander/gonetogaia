/**
 * Hero Cards reference viewer — a read-only modal that lets the
 * player see the printed art for every Hero Card their delver
 * currently owns (i.e. every unlocked card matching the delver's
 * suit). Triggered from the Shop wallet so the player can cross-
 * reference their loadout while deciding what to buy.
 *
 * Why a modal vs an inline panel:
 *   - The shop screen is already dense (wallets + cost pills +
 *     7-up product grid + finish button). Inlining a card gallery
 *     would push the products below the fold and re-trigger the
 *     "huge empty gap" class of layout bugs the shop just escaped.
 *   - Mirrors `RewardsModal`'s presentation pattern, so the modal
 *     scaffolding (overlay, backdrop blur, Escape/click dismiss)
 *     comes for free via the `.rewards-modal*` CSS classes.
 *
 * Lifecycle: `presentHeroCards` mounts the overlay, returns a
 * Promise that resolves on dismiss. The overlay self-cleans on
 * dismiss so callers don't have to teardown. If the host element
 * unmounts mid-modal (e.g. router navigates away), the keydown
 * listener no-ops via the `overlay.isConnected` check and
 * resolves with reason "unmount".
 *
 * Added 2026-05-18 so players can reference owned Hero Cards
 * during the Visit-the-Shops phase without leaving the shop screen.
 */

import { HERO_CARDS } from "../data";
import { presentEquipmentCards } from "./EquipmentCardsModal";
import { logEvent } from "../debug/sessionLog";

export interface PresentHeroCardsOpts {
  /** "Mind Delver" / "Body Delver" — used as the modal title. */
  delverLabel: string;
  /** Suit to filter `HERO_CARDS` by; only unlocked cards of this
   *  suit are shown. */
  suit: "mind" | "body";
  /** Currently-unlocked card numbers (typically
   *  `state.unlockedHeroCards`). Cards not in this list are not
   *  rendered — this is a "what you own" reference, not a campaign
   *  progress tracker (the Campaign Sheet handles that). */
  unlockedNumbers: readonly number[];
}

/**
 * Mount the hero-cards viewer over `host` and resolve when dismissed.
 * Always renders (even with zero owned cards) — the empty state is
 * informative ("No Hero Cards unlocked for this delver yet") whereas
 * a silently disabled button leaves the player guessing.
 */
export function presentHeroCards(
  host: HTMLElement,
  opts: PresentHeroCardsOpts,
): Promise<void> {
  return new Promise((resolve) => {
    const ownedForSuit = HERO_CARDS.filter(
      (c) => c.suit === opts.suit && opts.unlockedNumbers.includes(c.number),
    );
    logEvent("heroCardsViewer.open", {
      delverLabel: opts.delverLabel,
      suit: opts.suit,
      ownedCount: ownedForSuit.length,
      ownedNumbers: ownedForSuit.map((c) => c.number),
    });

    const overlay = document.createElement("div");
    overlay.className = "rewards-modal hero-cards-viewer";
    overlay.innerHTML = `
      <div class="rewards-modal-backdrop" data-hcv-backdrop></div>
      <div class="rewards-modal-body" role="dialog" aria-modal="true" aria-labelledby="hcv-title">
        <h3 class="rewards-modal-title" id="hcv-title">
          ${escapeHtml(opts.delverLabel)}'s Hero Cards
        </h3>
        ${ownedForSuit.length === 0 ? `
          <p class="hero-cards-viewer-empty">
            No Hero Cards unlocked for the ${escapeHtml(opts.delverLabel)} yet.
            They are awarded during Town Visit narrative beats.
          </p>
        ` : `
          <div class="hero-cards-viewer-grid">
            ${ownedForSuit
              .map((c) => `
                <figure class="hero-cards-viewer-card hero-cards-viewer-card--${c.suit}">
                  <img class="hero-cards-viewer-art"
                       src="/heroes/${c.image}"
                       alt="${escapeHtml(c.name)}" />
                  <figcaption class="hero-cards-viewer-caption">
                    <strong>HERO #${String(c.number).padStart(2, "0")}</strong>
                    <span class="small muted">${escapeHtml(c.name)}</span>
                  </figcaption>
                  <button
                    type="button"
                    class="btn btn--small btn--ghost see-equipment-btn"
                    data-hcv-see-equipment
                    data-card-number="${c.number}"
                    title="Show the equipment cards that come with this Hero Card."
                  >SEE EQUIPMENT</button>
                </figure>
              `)
              .join("")}
          </div>
        `}
        <div class="rewards-modal-footer">
          <button class="btn btn--primary" data-hcv-close>Close</button>
        </div>
      </div>
    `;
    host.appendChild(overlay);

    let resolved = false;
    const dismiss = (reason: "backdrop" | "button" | "escape" | "unmount"): void => {
      if (resolved) return;
      resolved = true;
      logEvent("heroCardsViewer.close", { reason });
      document.removeEventListener("keydown", onKeydown);
      overlay.remove();
      resolve();
    };
    const onKeydown = (ev: KeyboardEvent): void => {
      if (!overlay.isConnected) {
        dismiss("unmount");
        return;
      }
      if (ev.key === "Escape" || ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        dismiss("escape");
      }
    };

    overlay.querySelector<HTMLDivElement>("[data-hcv-backdrop]")!
      .addEventListener("click", () => dismiss("backdrop"));
    overlay.querySelector<HTMLButtonElement>("[data-hcv-close]")!
      .addEventListener("click", () => dismiss("button"));
    // "SEE EQUIPMENT" per-card buttons -- open the dedicated
    // EquipmentCardsModal stacked on top of this one. We do NOT
    // dismiss the HeroCardsModal first so the player returns to
    // the same scroll position / context after closing the
    // equipment viewer.
    for (const btn of overlay.querySelectorAll<HTMLButtonElement>("[data-hcv-see-equipment]")) {
      btn.addEventListener("click", (ev) => {
        // Stop the click bubbling to the backdrop dismiss handler
        // (which lives on the same overlay element).
        ev.stopPropagation();
        const num = Number(btn.dataset["cardNumber"]);
        if (!Number.isFinite(num)) return;
        logEvent("heroCardsViewer.seeEquipment", {
          delverLabel: opts.delverLabel,
          cardNumber: num,
        });
        void presentEquipmentCards(document.body, { heroCardNumber: num });
      });
    }
    document.addEventListener("keydown", onKeydown);
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
