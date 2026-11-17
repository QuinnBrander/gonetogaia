/**
 * Owned Shop Products viewer — a read-only modal that shows every
 * Shop Product a given delver has previously purchased (this
 * campaign), rendered as the printed-card art. Triggered from the
 * Shop wallet so the player can cross-reference their owned gear /
 * bonuses without leaving the shop screen.
 *
 * Mirrors `HeroCardsModal` (overlay scaffold, backdrop blur,
 * Escape/click dismiss, self-clean lifecycle) and reuses the same
 * `.rewards-modal*` CSS chrome so the shop's two reference modals
 * (Hero Cards + Shop Products) share visual language.
 *
 * Lifecycle: `presentShopProducts` mounts the overlay, returns a
 * Promise that resolves on dismiss. Empty state is informative
 * ("X hasn't purchased any Shop Products yet") rather than the
 * silent-disabled-button alternative — but the Shop wallet ALSO
 * disables the trigger button at 0 owned so we typically only see
 * the empty state via direct script invocation or hot-reload
 * artifacts. Defensive copy stays so the modal never renders blank.
 *
 * Added 2026-05-18 alongside the Hero Cards viewer.
 */

import { getShopProduct, shopProductImageOrNull } from "../data";
import { logEvent } from "../debug/sessionLog";

export interface PresentShopProductsOpts {
  /** "Mind Delver" / "Body Delver" — used as the modal title. */
  delverLabel: string;
  /** Owned shop product numbers for this delver (typically
   *  `state.shopProductsOwned[heroId]`). Cards not in this list are
   *  not rendered — this is a "what you own" reference, not a
   *  catalog browser. */
  ownedProductNumbers: readonly number[];
}

/**
 * Mount the owned-products viewer over `host` and resolve when
 * dismissed. Always renders (even with zero owned products) — the
 * empty state is informative ("hasn't purchased any") whereas a
 * silently disabled button leaves the player guessing about the
 * difference between "no products owned" and "feature broken".
 */
export function presentShopProducts(
  host: HTMLElement,
  opts: PresentShopProductsOpts,
): Promise<void> {
  return new Promise((resolve) => {
    // Stable display order — sort by printed product number so the
    // grid matches the order players see in the live shop screen.
    const owned = [...opts.ownedProductNumbers].sort((a, b) => a - b);
    logEvent("shopProductsViewer.open", {
      delverLabel: opts.delverLabel,
      ownedCount: owned.length,
      ownedNumbers: owned,
    });

    const overlay = document.createElement("div");
    overlay.className = "rewards-modal shop-products-viewer";
    overlay.innerHTML = `
      <div class="rewards-modal-backdrop" data-spv-backdrop></div>
      <div class="rewards-modal-body" role="dialog" aria-modal="true" aria-labelledby="spv-title">
        <h3 class="rewards-modal-title" id="spv-title">
          ${escapeHtml(opts.delverLabel)}'s Shop Products
        </h3>
        ${owned.length === 0 ? `
          <p class="hero-cards-viewer-empty">
            The ${escapeHtml(opts.delverLabel)} hasn't purchased any
            Shop Products yet. Products bought during a Town Visit
            appear here for future reference.
          </p>
        ` : `
          <div class="shop-products-viewer-grid">
            ${owned
              .map((n) => {
                const p = getShopProduct(n);
                const img = shopProductImageOrNull(n);
                const art = img
                  ? `<img class="shop-products-viewer-art"
                          src="/shop-products/${img}"
                          alt="Shop Product #${p.number} - ${escapeHtml(p.name)}" />`
                  : `<div class="shop-products-viewer-art shop-products-viewer-art--placeholder">
                       #${p.number}
                     </div>`;
                return `
                  <figure class="shop-products-viewer-card">
                    ${art}
                  </figure>
                `;
              })
              .join("")}
          </div>
        `}
        <div class="rewards-modal-footer">
          <button class="btn btn--primary" data-spv-close>Close</button>
        </div>
      </div>
    `;
    host.appendChild(overlay);

    let resolved = false;
    const dismiss = (reason: "backdrop" | "button" | "escape" | "unmount"): void => {
      if (resolved) return;
      resolved = true;
      logEvent("shopProductsViewer.close", { reason });
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

    overlay.querySelector<HTMLDivElement>("[data-spv-backdrop]")!
      .addEventListener("click", () => dismiss("backdrop"));
    overlay.querySelector<HTMLButtonElement>("[data-spv-close]")!
      .addEventListener("click", () => dismiss("button"));
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
