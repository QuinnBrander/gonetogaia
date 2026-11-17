/**
 * Equipment Cards reference viewer -- a read-only modal that lets
 * the player see the printed art for every equipment card that
 * comes with a specific Hero Card's starting loadout. Triggered
 * from the "SEE EQUIPMENT" button under any hero card (HeroPick,
 * HeroCardsModal, CampaignSheet, RewardsModal).
 *
 * Sources its card list from `HERO_CARD_LOADOUTS[heroCardNumber]
 * .startingEquipmentIds`, which is the canonical "what cards does
 * this hero come with" map (see `data.ts`). Falls back to an empty
 * state if the hero card has no recorded loadout (defensive --
 * every shipped HERO_CARDS entry has one today).
 *
 * Lifecycle mirrors `HeroCardsModal.presentHeroCards`: mounts an
 * overlay, returns a Promise that resolves on dismiss
 * (backdrop/click/escape/unmount). Reuses the `.rewards-modal*`
 * scaffolding (same as HeroCardsModal) so the visual chrome stays
 * consistent across the two reference modals.
 */

import { HERO_CARD_LOADOUTS, getEquipment } from "../data";
import { logEvent } from "../debug/sessionLog";

export interface PresentEquipmentCardsOpts {
  /**
   * Printed hero card number (e.g. 1 for "Hero #01"). Used to look
   * up the starting equipment loadout via `HERO_CARD_LOADOUTS`.
   */
  heroCardNumber: number;
}

export function presentEquipmentCards(
  host: HTMLElement,
  opts: PresentEquipmentCardsOpts,
): Promise<void> {
  return new Promise((resolve) => {
    const loadout = HERO_CARD_LOADOUTS[opts.heroCardNumber];
    const equipmentIds: readonly string[] = loadout?.startingEquipmentIds ?? [];
    const equipment = equipmentIds.map((id) => getEquipment(id));

    logEvent("equipmentCardsViewer.open", {
      heroCardNumber: opts.heroCardNumber,
      equipmentCount: equipment.length,
      equipmentIds: equipment.map((e) => e.id),
    });

    const overlay = document.createElement("div");
    overlay.className = "rewards-modal equipment-cards-viewer";
    overlay.innerHTML = `
      <div class="rewards-modal-backdrop" data-ecv-backdrop></div>
      <div class="rewards-modal-body" role="dialog" aria-modal="true" aria-labelledby="ecv-title">
        <h3 class="rewards-modal-title" id="ecv-title">
          STARTING EQUIPMENT
        </h3>
        ${equipment.length === 0 ? `
          <p class="equipment-cards-viewer-empty">
            No starting equipment is recorded for this Hero Card yet.
          </p>
        ` : `
          <div class="equipment-cards-viewer-grid">
            ${equipment
              .map((e) => `
                <figure class="equipment-cards-viewer-card equipment-cards-viewer-card--${e.suit}">
                  <img class="equipment-cards-viewer-art"
                       src="/cards/${e.image}"
                       alt="${escapeHtml(e.name)} (R${e.rank})" />
                  <figcaption class="equipment-cards-viewer-caption">
                    <strong>${escapeHtml(e.name.toUpperCase())}</strong>
                    <span class="small muted">${escapeHtml(e.type)} -- Rank ${e.rank}</span>
                  </figcaption>
                </figure>
              `)
              .join("")}
          </div>
        `}
        <div class="rewards-modal-footer">
          <button class="btn btn--primary" data-ecv-close>Close</button>
        </div>
      </div>
    `;
    host.appendChild(overlay);

    let resolved = false;
    const dismiss = (reason: "backdrop" | "button" | "escape" | "unmount"): void => {
      if (resolved) return;
      resolved = true;
      logEvent("equipmentCardsViewer.close", { reason });
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

    overlay.querySelector<HTMLDivElement>("[data-ecv-backdrop]")!
      .addEventListener("click", () => dismiss("backdrop"));
    overlay.querySelector<HTMLButtonElement>("[data-ecv-close]")!
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
