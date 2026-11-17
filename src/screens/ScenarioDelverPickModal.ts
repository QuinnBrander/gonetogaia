/**
 * Scenario Delver Pick modal — drains `state.pendingScenarioDelverPicks`
 * one entry at a time.
 *
 * Each `PendingScenarioDelverPick` requires the player to choose WHICH
 * delver receives (or loses) a resource:
 *   - `consumable-token` → grant N tokens to chosen delver
 *   - `gain-ap`          → add N AP to chosen delver's base + current pool
 *   - `lose-hp-floor-at-one` → reduce chosen delver's HP (min 1)
 *
 * Layout:
 *
 *   +----------------------------------------------------+
 *   | Scenario Card Reward                               |
 *   | Choose a delver to: <rewardLabel>                  |
 *   |                                                    |
 *   |   [Mind Delver]        [Body Delver]               |
 *   |                                                    |
 *   |   N more picks pending after this                  |
 *   +----------------------------------------------------+
 *
 * Cancel-less by design: the queue must drain before board flow
 * resumes. Mirrors the element-pick / suit-condition-rank-pick pattern.
 */

import type { Router } from "../main";
import { applyScenarioDelverPick } from "../engine/scenarioCard";
import { getHero } from "../data";
import { setModal } from "../uiState";

/**
 * Render the scenario-delver pick modal into `host`.
 * Calls `onDrained()` when the queue is empty so the caller can
 * close the modal and refresh.
 */
export function renderScenarioDelverPickModal(
  host: HTMLDivElement,
  router: Router,
  hooks: {
    onDrained: () => void;
  },
): void {
  const state = router.state;
  const pick = state.pendingScenarioDelverPicks[0];

  if (!pick) {
    hooks.onDrained();
    return;
  }

  const heroIds = Object.keys(state.loadouts);
  const remainingAfterThis = Math.max(0, state.pendingScenarioDelverPicks.length - 1);

  const isLoss = pick.reward.kind === "lose-hp-floor-at-one";
  const verb = isLoss ? "Choose a delver to:" : "Choose a delver to receive:";

  const heroBtns = heroIds.map((heroId) => {
    const hero = getHero(heroId);
    const lo = state.loadouts[heroId];
    let subtitle = "";
    if (lo) {
      if (pick.reward.kind === "lose-hp-floor-at-one") {
        const after = Math.max(1, lo.currentHp - pick.reward.amount);
        subtitle = `HP: ${lo.currentHp} → ${after}`;
      } else if (pick.reward.kind === "gain-ap") {
        subtitle = `AP: ${lo.currentAp} → ${lo.currentAp + pick.reward.amount}`;
      }
    }
    return `
      <button class="scenario-delver-pick-hero-btn turn-${hero.suit}"
              data-scenario-delver-pick-hero="${escapeHtml(heroId)}">
        <span class="scenario-delver-pick-suit">${hero.suit === "mind" ? "Mind" : "Body"}</span>
        <span class="scenario-delver-pick-name">Delver</span>
        ${subtitle ? `<span class="scenario-delver-pick-subtitle small muted">${escapeHtml(subtitle)}</span>` : ""}
      </button>
    `;
  }).join("");

  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body scenario-delver-pick-modal">
      <header class="scenario-delver-pick-modal-header">
        <h3>Scenario Card Reward</h3>
        <p class="small muted">${escapeHtml(verb)}</p>
        <p class="scenario-delver-pick-label">${escapeHtml(pick.rewardLabel)}</p>
        ${remainingAfterThis > 0
          ? `<p class="small muted scenario-delver-pick-queue">${remainingAfterThis} more pick${remainingAfterThis === 1 ? "" : "s"} pending after this.</p>`
          : ""}
      </header>
      <div class="scenario-delver-pick-hero-row">${heroBtns}</div>
    </div>
  `;

  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-scenario-delver-pick-hero]")) {
    btn.addEventListener("click", () => {
      const heroId = btn.dataset.scenarioDelverPickHero!;
      applyScenarioDelverPick(state, pick.pickId, heroId);
      router.save();
      // Re-render: either the next pick appears or onDrained fires.
      renderScenarioDelverPickModal(host, router, hooks);
    });
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
