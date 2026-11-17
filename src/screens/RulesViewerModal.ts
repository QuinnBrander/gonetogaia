/**
 * Rules Viewer modal -- flipbook view of the printed rulebook.
 *
 * Opened from the BoardScreen topbar "RULES" button. Pages are
 * pre-rendered JPEGs at `/rulebook/rulebook-page-NN.jpg` (see
 * `scripts/extractRulebookPages.mjs`); the modal just steps
 * through them.
 *
 * Controls:
 *   - Tap the page image to flip FORWARD one page (mobile-first
 *     primary affordance — fast read-through with one thumb).
 *   - On-screen Prev / Next buttons step in either direction.
 *   - Close button or backdrop click dismisses the modal back to
 *     the BoardScreen.
 *
 * State: `state.modal` carries the current `pageNumber` so a
 * re-render (e.g. after a save) lands on the same page. Page is
 * NOT persisted to localStorage -- a hard reload re-opens at
 * page 1 next time the player taps RULES.
 */

import type { Router } from "../main";
import { getModal, setModal } from "../uiState";
import { logEvent } from "../debug/sessionLog";

/**
 * Total pages in the bundled rulebook PDF. Bumped by re-running
 * `scripts/extractRulebookPages.mjs` whenever the source PDF is
 * updated; the script prints the new count at the end.
 */
export const RULEBOOK_PAGE_COUNT = 32;

export function renderRulesViewerModal(host: HTMLDivElement, router: Router): void {
  const modal = getModal();
  if (!modal || modal.kind !== "rules-viewer") {
    return;
  }
  const pageNumber = clampPage(modal.pageNumber);
  const padded = String(pageNumber).padStart(2, "0");
  const isFirst = pageNumber === 1;
  const isLast = pageNumber === RULEBOOK_PAGE_COUNT;

  host.innerHTML = `
    <div class="action-menu-backdrop" data-rules-close-backdrop></div>
    <div class="action-menu-body rules-viewer-modal">
      <header class="rules-viewer-modal-header">
        <h3>Rulebook</h3>
        <span class="rules-viewer-modal-page small muted">
          Page <strong>${pageNumber}</strong> / ${RULEBOOK_PAGE_COUNT}
        </span>
        <button class="btn btn--small btn--ghost rules-viewer-modal-close-btn" data-rules-close>Close</button>
      </header>
      <figure class="rules-viewer-modal-art">
        <img class="rules-viewer-modal-page-img"
             src="/rulebook/rulebook-page-${padded}.jpg"
             alt="Rulebook page ${pageNumber}"
             draggable="false"
             data-rules-page-img />
      </figure>
      <nav class="rules-viewer-modal-nav">
        <button class="btn btn--small btn--ghost" data-rules-prev${isFirst ? " disabled" : ""}>&larr; Prev</button>
        <span class="rules-viewer-modal-hint small muted">Tap the page to flip forward</span>
        <button class="btn btn--small btn--primary" data-rules-next${isLast ? " disabled" : ""}>Next &rarr;</button>
      </nav>
    </div>
  `;

  const goTo = (next: number) => {
    const clamped = clampPage(next);
    if (clamped === pageNumber) return;
    logEvent("click.rules-viewer.flip", {
      fromPage: pageNumber,
      toPage: clamped,
    });
    setModal({ kind: "rules-viewer", pageNumber: clamped });
    router.refresh();
  };

  // Tap the page itself to flip forward (mobile-first primary
  // affordance). On the last page, the tap is inert -- the same
  // dismiss path uses the Close button so a misfire on the page
  // image doesn't accidentally close the modal.
  host.querySelector<HTMLImageElement>("[data-rules-page-img]")!
    .addEventListener("click", () => {
      if (isLast) return;
      goTo(pageNumber + 1);
    });

  host.querySelector<HTMLButtonElement>("[data-rules-prev]")
    ?.addEventListener("click", () => goTo(pageNumber - 1));

  host.querySelector<HTMLButtonElement>("[data-rules-next]")
    ?.addEventListener("click", () => goTo(pageNumber + 1));

  const close = () => {
    logEvent("click.rules-viewer.close", { lastPage: pageNumber });
    setModal(null);
    router.refresh();
  };
  host.querySelector<HTMLButtonElement>("[data-rules-close]")!
    .addEventListener("click", close);
  host.querySelector<HTMLDivElement>("[data-rules-close-backdrop]")!
    .addEventListener("click", close);
}

function clampPage(n: number): number {
  if (!Number.isFinite(n)) return 1;
  if (n < 1) return 1;
  if (n > RULEBOOK_PAGE_COUNT) return RULEBOOK_PAGE_COUNT;
  return Math.floor(n);
}
