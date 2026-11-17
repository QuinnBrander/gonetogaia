/**
 * Payer-pick modal — small overlay shown when a Town Visit choice
 * with a `prePay` cost has 2+ eligible delvers (i.e. either could
 * legitimately afford to pay). Lets the player decide which delver
 * spends the resource before the engine navigates to the
 * downstream page.
 *
 * Resolves with the chosen delver's hero id on selection, or
 * `null` on cancel (backdrop click / Escape) so the caller can
 * abort the navigation and leave the player on the parent
 * choice page.
 *
 * Mirrors the `RewardsModal` / `HeroCardsModal` presentation
 * pattern — reuses the shared `.rewards-modal*` CSS scaffold for
 * the backdrop, body framing, and dismiss affordances so the
 * overlay feels visually consistent with the rest of the town-
 * visit UI without re-styling from scratch.
 *
 * Added 2026-05-18 to support the Pub's "Buy her a drink" branch
 * (page 10-C2 of Chapter 1) where the rulebook leaves the
 * payer-pick to the players. Generalised to any 2-delver pre-pay
 * cost so future cost-decision UIs (e.g. "donate a boss part",
 * "spend a memory chip") can reuse the same modal by just
 * extending the `costLabel` line.
 */

import { HEROES, getHero } from "../data";
import { logEvent } from "../debug/sessionLog";

export interface PresentPayerPickOpts {
  /**
   * Hero ids the player can pick from. Caller pre-filters by
   * affordability; the modal renders one button per id in the
   * order given. Typically `["hero-01", "hero-02"]` (2 delvers)
   * but the renderer is N-friendly.
   */
  eligibleHeroIds: string[];
  /**
   * Short cost description shown above the picker, e.g.
   * "Cost: 1 minion part". Pure presentation — the actual debit
   * happens in the downstream page's onEnter via
   * `lose-minion-parts`.
   */
  costLabel: string;
  /**
   * Short context line shown above `costLabel`, e.g. "Buy her a
   * drink — who pays?". Defaults to "Who pays?" when omitted so
   * the modal is always self-explanatory.
   */
  prompt?: string;
  /**
   * Per-hero parts-on-hand snapshot so the modal can render a
   * little "Mind: 5 minion parts" subtitle under each button —
   * gives the player the info they need to decide who can spare
   * the cost. Keyed by hero id. Missing entries render as 0.
   */
  partsByHeroId?: Record<string, number>;
}

/**
 * Mount the payer-pick modal over `host` and resolve with the
 * chosen hero id (or `null` on cancel).
 */
export function presentPayerPick(
  host: HTMLElement,
  opts: PresentPayerPickOpts,
): Promise<string | null> {
  return new Promise((resolve) => {
    logEvent("payerPick.open", {
      eligibleHeroIds: opts.eligibleHeroIds,
      costLabel: opts.costLabel,
    });

    const overlay = document.createElement("div");
    overlay.className = "rewards-modal payer-pick-modal";
    overlay.innerHTML = `
      <div class="rewards-modal-backdrop" data-pp-backdrop></div>
      <div class="rewards-modal-body payer-pick-body" role="dialog" aria-modal="true" aria-labelledby="pp-title">
        <h3 class="rewards-modal-title" id="pp-title">${escapeHtml(opts.prompt ?? "Who pays?")}</h3>
        <p class="payer-pick-cost small muted">${escapeHtml(opts.costLabel)}</p>
        <div class="payer-pick-options">
          ${opts.eligibleHeroIds
            .map((id) => {
              // Defensive: skip ids that aren't in HEROES. Should
              // never happen with today's roster but a hand-edited
              // chapter file could land here.
              if (!HEROES.find((h) => h.id === id)) return "";
              const hero = getHero(id);
              const suitLabel = hero.suit === "mind" ? "Mind Delver" : "Body Delver";
              const onHand = opts.partsByHeroId?.[id] ?? 0;
              const partsLine = opts.partsByHeroId
                ? `<span class="small muted payer-pick-option-parts">${onHand} minion part${onHand === 1 ? "" : "s"} on hand</span>`
                : "";
              return `
                <button class="btn btn--primary payer-pick-option payer-pick-option--${hero.suit}"
                        data-pp-hero="${escapeHtml(id)}">
                  <span class="payer-pick-option-label"><strong>${escapeHtml(suitLabel)}</strong> pays</span>
                  ${partsLine}
                </button>
              `;
            })
            .join("")}
        </div>
        <div class="rewards-modal-footer">
          <button class="btn btn--ghost" data-pp-cancel>Cancel</button>
        </div>
      </div>
    `;
    host.appendChild(overlay);

    let resolved = false;
    const finish = (heroId: string | null, reason: "select" | "cancel" | "backdrop" | "escape" | "unmount"): void => {
      if (resolved) return;
      resolved = true;
      logEvent("payerPick.close", { reason, heroId });
      document.removeEventListener("keydown", onKeydown);
      overlay.remove();
      resolve(heroId);
    };
    const onKeydown = (ev: KeyboardEvent): void => {
      if (!overlay.isConnected) {
        finish(null, "unmount");
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        finish(null, "escape");
      }
    };

    overlay.querySelector<HTMLDivElement>("[data-pp-backdrop]")!
      .addEventListener("click", () => finish(null, "backdrop"));
    overlay.querySelector<HTMLButtonElement>("[data-pp-cancel]")!
      .addEventListener("click", () => finish(null, "cancel"));
    overlay.querySelectorAll<HTMLButtonElement>("[data-pp-hero]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          finish(btn.dataset.ppHero ?? null, "select");
        });
      });
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
