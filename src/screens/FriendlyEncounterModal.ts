/**
 * Friendly Encounter modal — printed card art + die-roll phase + COLLECT.
 *
 * Flow for Card #01 (Flambé, "roll 1 die worth of Minion Parts"):
 *   1. Card view phase  — shows full card art + RESOLVE button.
 *   2. Roll phase       — RESOLVE click rolls a d6, plays the die-cycling
 *                         animation (uses existing dieRollAnimation.ts),
 *                         then reveals "Both Delvers gain N Minion Parts"
 *                         and a COLLECT button.
 *   3. Collect phase    — COLLECT flies N token images to the topbar wallet,
 *                         calls resolveFriendlyEncounter (with the pre-rolled
 *                         value so the engine doesn't re-roll), then opens
 *                         the standard rewards modal.
 *
 * Cards without a die-roll (future cards) skip phases 2-3 and go straight
 * to presentRewards on RESOLVE.
 */

import type { Router } from "../main";
import { resolveFriendlyEncounter } from "../engine/friendlyEncounter";
import { getFriendlyEncounterCard, HEROES } from "../data";
import { getPeekedDelverId, setModal } from "../uiState";
import { logEvent } from "../debug/sessionLog";
import { presentRewards } from "./RewardsModal";
import { markFreshRoll, consumeFreshRoll, playDieRollCycle } from "../ui/dieRollAnimation";
import { flyFromElementToWallet } from "../ui/flyToWallet";

const DIE_ROLL_KEY = "fe-die";

/** Module-level roll storage — survives the re-render triggered by
 *  markFreshRoll / consumeFreshRoll but is cleared on dismiss. */
let pendingRoll: number | null = null;

export function renderFriendlyEncounterModal(host: HTMLDivElement, router: Router): void {
  const state = router.state;
  const headNumber = state.pendingFriendlyEncounters[0];
  if (headNumber === undefined) {
    // Defensive: ALSO re-hide the host. `.action-modal` is a
    // full-screen fixed layer — renderActionModal un-hides it before
    // dispatching, so an early return that leaves it visible-but-
    // empty is an invisible click-eater that soft-locks the whole
    // board (playtester report 2026-07-22).
    setModal(null);
    host.setAttribute("hidden", "");
    return;
  }
  const card = getFriendlyEncounterCard(headNumber);
  const needsDieRoll = headNumber === 1;
  const rolledValue = pendingRoll;
  const isFreshRoll = consumeFreshRoll(DIE_ROLL_KEY);

  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body friendly-encounter-modal">
      <div class="friendly-encounter-modal-body">
        <figure class="friendly-encounter-modal-art">
          <img src="/friendly-encounter-cards/${escapeHtml(card.frontImage)}"
               alt="${escapeHtml(card.printedId)} &mdash; ${escapeHtml(card.name)}"
               draggable="false" />
        </figure>
        ${needsDieRoll && rolledValue !== null ? `
          <div class="fe-die-result-row">
            <div class="fe-die-box die-roll-result">${rolledValue}</div>
            <div class="fe-die-desc">Both Delvers gain
              <strong class="fe-die-count">${rolledValue}</strong>
              Minion Parts
            </div>
          </div>
          <button class="btn btn--primary friendly-encounter-modal-resolve"
                  data-fe-collect
                  ${isFreshRoll ? 'style="visibility:hidden"' : ""}>COLLECT</button>
        ` : `
          <button class="btn btn--primary friendly-encounter-modal-resolve"
                  data-friendly-continue>RESOLVE</button>
        `}
      </div>
    </div>
  `;

  // Play die animation immediately after a fresh roll
  if (isFreshRoll && rolledValue !== null) {
    const dieEl = host.querySelector<HTMLElement>(".fe-die-box");
    const countEl = host.querySelector<HTMLElement>(".fe-die-count");
    const collectBtn = host.querySelector<HTMLButtonElement>("[data-fe-collect]");
    // Seed inline label with "?" so it doesn't briefly flash the real number
    if (countEl) countEl.textContent = "?";
    playDieRollCycle(dieEl, rolledValue, DIE_ROLL_KEY, () => {
      if (countEl) countEl.textContent = String(rolledValue);
      if (collectBtn) collectBtn.style.visibility = "";
    });
  }

  // RESOLVE: roll die, store result, re-render into die phase
  host.querySelector<HTMLButtonElement>("[data-friendly-continue]")
    ?.addEventListener("click", () => {
      if (needsDieRoll) {
        pendingRoll = Math.ceil(Math.random() * 6);
        logEvent("click.friendly-encounter.roll", {
          cardNumber: card.number,
          roll: pendingRoll,
        });
        markFreshRoll(DIE_ROLL_KEY);
        renderFriendlyEncounterModal(host, router);
      } else {
        // No die roll — resolve directly.
        // ORDER MATTERS (soft-lock fix 2026-07-22): present the
        // rewards overlay FIRST, then persist. `router.save()`
        // re-renders the whole screen, which (a) detaches `host` so
        // the rewards overlay becomes invisible and unclickable, and
        // (b) rebuilds the full-screen `.action-modal` layer
        // unhidden-but-empty because the encounter queue is already
        // popped — a click-eater that froze the board for a
        // playtester. State is already mutated; saving at the end
        // loses nothing.
        logEvent("click.friendly-encounter.continue", { cardNumber: card.number });
        const events = resolveFriendlyEncounter(router.state);
        void (events.length > 0 ? presentRewards(host, events) : Promise.resolve())
          .then(() => { setModal(null); router.save(); });
      }
    });

  // COLLECT: fly tokens → resolve (with pre-roll) → rewards modal
  host.querySelector<HTMLButtonElement>("[data-fe-collect]")
    ?.addEventListener("click", async () => {
      const roll = pendingRoll ?? 1;
      logEvent("click.friendly-encounter.collect", { cardNumber: card.number, roll });

      // Fly the token images to the topbar wallet as visual feedback
      const dieEl = host.querySelector<HTMLElement>(".fe-die-box");
      const viewedId = getPeekedDelverId() ?? router.state.currentDelverId;
      const hero = HEROES.find(h => h.id === viewedId) ?? HEROES[0]!;
      const iconSrc = hero.suit === "mind" ? "/tokens/minion-mind.webp" : "/tokens/minion-body.webp";
      await flyFromElementToWallet(dieEl, roll, "minion", iconSrc);

      // Apply the encounter using the pre-determined roll.
      // ORDER MATTERS (soft-lock fix 2026-07-22): NO `router.save()`
      // before the rewards overlay — see the RESOLVE branch above
      // for the full failure mode (detached host + unhidden empty
      // modal layer = frozen board). Persist once at the end.
      const events = resolveFriendlyEncounter(router.state, roll);
      pendingRoll = null;
      if (events.length > 0) {
        await presentRewards(host, events);
      }
      setModal(null);
      router.save();
    });
}

// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
