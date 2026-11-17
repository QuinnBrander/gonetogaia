/**
 * Spawn Deck reference viewer — a read-only modal that displays
 * every card in the base Spawn Deck so the player (and the
 * designer, while iterating) can scan the printed layouts at a
 * glance. Triggered from the Campaign Sheet "Spawn Deck" panel.
 *
 * The viewer also serves a quick "did the data match the art?"
 * smoke test: each card tile shows the printed art alongside a
 * compact marker tally (boss / minions / delver-spawns / fragments)
 * derived from `SpawnCard.*` arrays. If the tally disagrees with
 * what's printed on the card, the catalog needs fixing. The unit
 * test in `src/__tests__/spawnCards.test.ts` covers the
 * structural invariants (1 boss + 7 minions + 2 compasses), but
 * doesn't catch position-typos — that's what the eyeball check is for.
 *
 * Why a modal (vs an inline panel on Campaign Sheet):
 *   - Twelve poker-aspect tiles want a lot of horizontal real
 *     estate to stay readable; an inline section would either
 *     scroll or stack into a narrow column.
 *   - The Campaign Sheet is already dense with hero / key item /
 *     quest / opinion / shop grids; the spawn deck is a reference
 *     tool, not a per-campaign progress tracker, so it belongs
 *     behind a button rather than always-on.
 *   - Reuses the `.rewards-modal*` scaffold (backdrop blur,
 *     Escape/click dismiss, footer) for free.
 *
 * Added 2026-05-18 as the first piece of Chapter 2 / Quest #2
 * groundwork — Q2 will draw from this deck at wave setup.
 */

import { SPAWN_CARDS } from "../data";
import type { SpawnCard } from "../types";
import { logEvent } from "../debug/sessionLog";

/**
 * Mount the spawn-deck viewer over `host` and resolve when dismissed.
 * No options — the viewer always shows the full base deck (Q1 doesn't
 * draw from it; Q2+ will, and the player benefits from being able to
 * cross-reference any time).
 */
export function presentSpawnDeck(host: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    logEvent("spawnDeckViewer.open", {
      cardCount: SPAWN_CARDS.length,
      numbers: SPAWN_CARDS.map((c) => c.number),
    });

    const overlay = document.createElement("div");
    overlay.className = "rewards-modal spawn-deck-viewer";
    overlay.innerHTML = `
      <div class="rewards-modal-backdrop" data-sdv-backdrop></div>
      <div class="rewards-modal-body" role="dialog" aria-modal="true" aria-labelledby="sdv-title">
        <h3 class="rewards-modal-title" id="sdv-title">Base Spawn Deck</h3>
        <p class="spawn-deck-viewer-intro">
          The 12 cards drawn from at the start of most quests (Quest #1
          uses a hand-authored layout instead). Each card shows where
          minions, the boss, delver-spawn options, and any memory
          fragment tokens go. NORTH is the top of every card.
        </p>
        <div class="spawn-deck-viewer-grid">
          ${SPAWN_CARDS.map(renderSpawnCardTile).join("")}
        </div>
        <div class="rewards-modal-footer">
          <button class="btn btn--primary" data-sdv-close>Close</button>
        </div>
      </div>
    `;
    host.appendChild(overlay);

    let resolved = false;
    const dismiss = (reason: "backdrop" | "button" | "escape" | "unmount"): void => {
      if (resolved) return;
      resolved = true;
      logEvent("spawnDeckViewer.close", { reason });
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

    overlay.querySelector<HTMLDivElement>("[data-sdv-backdrop]")!
      .addEventListener("click", () => dismiss("backdrop"));
    overlay.querySelector<HTMLButtonElement>("[data-sdv-close]")!
      .addEventListener("click", () => dismiss("button"));
    document.addEventListener("keydown", onKeydown);
  });
}

function renderSpawnCardTile(card: SpawnCard): string {
  const tally: string[] = [];
  tally.push(`<span class="spawn-deck-viewer-tally-pill spawn-deck-viewer-tally-pill--boss">1 boss</span>`);
  tally.push(`<span class="spawn-deck-viewer-tally-pill spawn-deck-viewer-tally-pill--minion">${card.minions.length} minions</span>`);
  tally.push(`<span class="spawn-deck-viewer-tally-pill spawn-deck-viewer-tally-pill--delver">${card.delverSpawns.length} delver spawns</span>`);
  if (card.memoryFragments.length > 0) {
    tally.push(`<span class="spawn-deck-viewer-tally-pill spawn-deck-viewer-tally-pill--fragment">${card.memoryFragments.length} memory chip${card.memoryFragments.length === 1 ? "" : "s"}</span>`);
  }
  const numLabel = String(card.number).padStart(2, "0");
  return `
    <figure class="spawn-deck-viewer-card" data-card-number="${card.number}">
      <img class="spawn-deck-viewer-art"
           src="/spawn-cards/${card.image}"
           alt="Base Spawn Card ${numLabel}" />
      <figcaption class="spawn-deck-viewer-caption">
        <strong>SPAWN CARD #${numLabel}</strong>
        <div class="spawn-deck-viewer-tally">${tally.join("")}</div>
      </figcaption>
    </figure>
  `;
}
