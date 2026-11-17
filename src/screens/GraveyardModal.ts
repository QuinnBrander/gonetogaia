/**
 * GraveyardModal — "hero perished" overlay shown after a non-exempt
 * quest wave ends in defeat and a hero card is permanently lost.
 *
 * For each perished delver (there can be one or two in a single wave):
 *  1. A full-screen overlay fades in showing the hero card art and a
 *     dramatic "FALLEN" headline.
 *  2. The player is invited to "Record their final words" (textarea,
 *     200-character limit). They may skip by leaving it empty.
 *  3. Clicking "Record & Continue" resolves the current entry; the
 *     next entry shows if there are multiple deaths, otherwise the
 *     overlay dismisses.
 *
 * Exported entry point: `presentGraveyardEntries(entries, state)`
 *   - `entries` — array of { heroId, cardNumber, cardName, questId, waveNumber }
 *   - Appends resolved final words into `state.graveyard` before resolving.
 *   - Returns a `Promise<void>` so callers chain `.then(...)` just like
 *     `presentKeyItemRewards`.
 */

import type { CampaignState } from "../state";
import { getHeroCard } from "../data";
import { logEvent } from "../debug/sessionLog";

export interface PendingGraveyardEntry {
  heroId: string;
  cardNumber: number;
  cardName: string;
  questId: string;
  waveNumber: number;
}

const MAX_WORDS_LEN = 200;

/**
 * Present a "hero perished" prompt for each entry sequentially, record
 * the final words into `state.graveyard`, then resolve. If `entries`
 * is empty this is an immediate no-op.
 */
export function presentGraveyardEntries(
  entries: PendingGraveyardEntry[],
  state: CampaignState,
): Promise<void> {
  logEvent("graveyard.presentEntries.start", {
    entryCount: entries.length,
    heroIds: entries.map((e) => e.heroId),
  });
  if (entries.length === 0) {
    logEvent("graveyard.presentEntries.skip", { reason: "no-entries" });
    return Promise.resolve();
  }
  return entries.reduce<Promise<void>>(
    (chain, entry) =>
      chain.then(() => presentOneEntry(entry, state)),
    Promise.resolve(),
  ).then(() => {
    logEvent("graveyard.presentEntries.complete", { entryCount: entries.length });
  });
}

function presentOneEntry(
  entry: PendingGraveyardEntry,
  state: CampaignState,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let heroCard;
    try { heroCard = getHeroCard(entry.cardNumber); } catch { /* unknown — use entry data */ }
    // Hero card art lives in `public/heroes/hero-NN.jpg` (NOT
    // `public/cards/heroes/` — that path doesn't exist on disk and the
    // broken `<img>` would silently sit there with a placeholder).
    // Mirrors the path used by RewardsModal's hero-cards-unlocked
    // tile and BoardScreen's portrait chips.
    const cardImage = heroCard ? `/heroes/${heroCard.image}` : null;
    const displayName = entry.cardName;

    const overlay = document.createElement("div");
    overlay.className = "graveyard-overlay";
    // Inline-style hardening. The class-based styles in styles.css
    // were not making the overlay visible for at least one user
    // (logged `graveyard.entry.mounted` repeatedly with no visible
    // modal). Setting the visibility-critical properties inline beats
    // any later/external rule that might hide it (display:none,
    // opacity:0, pointer-events:none, parent transform creating an
    // unexpected containing block, etc.). We KEEP the class so the
    // animation + child styles still apply, and rely on the cascade
    // (inline > stylesheet for non-!important rules) to win for
    // visibility. Z-index is bumped above any reasonable competitor.
    overlay.style.position = "fixed";
    overlay.style.top = "0";
    overlay.style.left = "0";
    overlay.style.right = "0";
    overlay.style.bottom = "0";
    overlay.style.width = "100vw";
    overlay.style.height = "100vh";
    overlay.style.zIndex = "2147483000";
    overlay.style.background = "rgba(0, 0, 0, 0.88)";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.opacity = "1";
    overlay.style.pointerEvents = "auto";
    overlay.innerHTML = `
      <div class="graveyard-modal">
        <div class="graveyard-header">
          <div class="graveyard-skull">✦</div>
          <h2 class="graveyard-title">Hero Fallen</h2>
          <p class="graveyard-subtitle">${escapeHtml(displayName)} has perished.</p>
        </div>
        ${cardImage ? `
          <div class="graveyard-card-art" style="display:flex;justify-content:center;">
            <img src="${escapeHtml(cardImage)}" alt="${escapeHtml(displayName)}" draggable="false"
              style="width:260px;height:auto;max-width:100%;max-height:380px;object-fit:contain;border-radius:6px;filter:grayscale(55%) brightness(0.8);border:1px solid rgba(180,60,60,0.4);" />
          </div>
        ` : ""}
        <div class="graveyard-words-section">
          <label class="graveyard-words-label" for="graveyard-words-input">
            Record their final words
          </label>
          <textarea
            id="graveyard-words-input"
            class="graveyard-words-input"
            placeholder="Leave blank to skip…"
            maxlength="${MAX_WORDS_LEN}"
            rows="3"
          ></textarea>
          <div class="graveyard-words-counter">
            <span data-counter>0</span> / ${MAX_WORDS_LEN}
          </div>
        </div>
        <div class="graveyard-actions">
          <button class="btn btn--ghost graveyard-skip-btn" type="button">
            Skip
          </button>
          <button class="btn btn--accent graveyard-confirm-btn" type="button">
            Record &amp; Continue
          </button>
        </div>
      </div>
    `;

    const textarea = overlay.querySelector<HTMLTextAreaElement>(".graveyard-words-input")!;
    const counter = overlay.querySelector<HTMLSpanElement>("[data-counter]")!;
    const confirmBtn = overlay.querySelector<HTMLButtonElement>(".graveyard-confirm-btn")!;
    const skipBtn = overlay.querySelector<HTMLButtonElement>(".graveyard-skip-btn")!;

    textarea.addEventListener("input", () => {
      counter.textContent = String(textarea.value.length);
    });

    let resolved = false;
    const dismiss = (reason: "confirm" | "skip" | "escape"): void => {
      if (resolved) return;
      resolved = true;
      const finalWords = reason === "confirm"
        ? textarea.value.slice(0, MAX_WORDS_LEN).trim()
        : "";
      state.graveyard.push({
        heroId: entry.heroId,
        cardNumber: entry.cardNumber,
        cardName: entry.cardName,
        questId: entry.questId,
        waveNumber: entry.waveNumber,
        finalWords,
      });
      logEvent("graveyard.entry.dismiss", {
        heroId: entry.heroId,
        cardNumber: entry.cardNumber,
        reason,
        wordsLength: finalWords.length,
      });
      document.removeEventListener("keydown", onKeydown);
      overlay.classList.add("graveyard-overlay--dismiss");
      overlay.addEventListener("animationend", () => {
        overlay.remove();
        resolve();
      }, { once: true });
      // Fallback in case animationend doesn't fire (no animation defined,
      // tab in background, OS reduce-motion forcing instant dismiss, etc.).
      setTimeout(() => {
        if (overlay.isConnected) { overlay.remove(); resolve(); }
      }, 600);
    };

    confirmBtn.addEventListener("click", () => dismiss("confirm"));
    skipBtn.addEventListener("click", () => dismiss("skip"));
    const onKeydown = (ev: KeyboardEvent): void => {
      // Defensive self-clean if the modal unmounted from underneath us
      // (e.g. router navigated away via a global hotkey while open).
      if (!overlay.isConnected) {
        dismiss("escape");
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        dismiss("skip");
      }
    };
    document.addEventListener("keydown", onKeydown);

    document.body.appendChild(overlay);
    logEvent("graveyard.entry.mounted", {
      heroId: entry.heroId,
      cardNumber: entry.cardNumber,
      cardName: entry.cardName,
    });
    // After paint, sanity-check the overlay is ACTUALLY visible.
    // Logs the geometric size + key computed-style properties so
    // we can diagnose any future "invisible modal" report from a log
    // alone. Compares the overlay rect to the viewport — a covering
    // overlay should have width≈innerWidth and height≈innerHeight.
    requestAnimationFrame(() => {
      textarea.focus();
      try {
        const rect = overlay.getBoundingClientRect();
        const cs = window.getComputedStyle(overlay);
        const modal = overlay.querySelector<HTMLElement>(".graveyard-modal");
        const modalRect = modal ? modal.getBoundingClientRect() : null;
        logEvent("graveyard.entry.visibilityCheck", {
          heroId: entry.heroId,
          overlay: {
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            display: cs.display,
            visibility: cs.visibility,
            opacity: cs.opacity,
            position: cs.position,
            zIndex: cs.zIndex,
            pointerEvents: cs.pointerEvents,
            parentTag: overlay.parentElement?.tagName ?? null,
            isConnected: overlay.isConnected,
          },
          modal: modalRect ? {
            w: Math.round(modalRect.width),
            h: Math.round(modalRect.height),
            top: Math.round(modalRect.top),
            left: Math.round(modalRect.left),
          } : null,
          viewport: {
            w: window.innerWidth,
            h: window.innerHeight,
          },
        });
      } catch (err) {
        logEvent("graveyard.entry.visibilityCheck.error", {
          heroId: entry.heroId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
