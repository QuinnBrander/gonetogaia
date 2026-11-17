/**
 * Scenario Card modal — front-of-card narrative + choice picker
 * then back-of-card resolution + interactive steps + Continue.
 *
 * Reads `state.currentScenarioCard`:
 *   - `chosenOption === null`  -> render the FRONT (image,
 *                                  narrative, choice buttons).
 *   - `chosenOption !== null`  -> render the BACK (image,
 *                                  resolution text, and any
 *                                  pending interactive step, then
 *                                  Continue once resolved).
 *
 * Interactive back-of-card states (before Continue is available):
 *   - `pendingDieRoll`      -> show a "Roll Die" button; when
 *                              rolled, show the result and apply
 *                              sub-effects via `resolveScenarioDieRoll`.
 *   - `pendingSubChoice`    -> show sub-option buttons; on pick,
 *                              apply sub-effects via
 *                              `resolveScenarioSubChoice`.
 *   - `pendingElementSpend` -> show delver picker + Skip button;
 *                              apply via `resolveScenarioElementSpend`.
 *
 * All interactive steps accumulate their reward events into
 * `PENDING_REWARDS` (keyed on the host element) so they are all
 * shown together after Continue is tapped.
 */

import type { Router } from "../main";
import {
  chooseScenarioOption,
  closeScenarioCard,
  resolveScenarioDieRoll,
  resolveScenarioSubChoice,
  resolveScenarioElementSpend,
  type ScenarioCardChoiceLetter,
} from "../engine/scenarioCard";
import { getScenarioCard } from "../data";
import { setModal } from "../uiState";
import { logEvent } from "../debug/sessionLog";
import { presentRewards } from "./RewardsModal";
import type { RewardEvent } from "../types";
import { playDieRollCycle } from "../ui/dieRollAnimation";
import { markFreshRoll, consumeFreshRoll, isResultBlocked } from "../ui/dieRollAnimation";

export function renderScenarioCardModal(host: HTMLDivElement, router: Router): void {
  const state = router.state;
  const current = state.currentScenarioCard;
  if (!current) {
    // Re-hide the full-screen layer too — see the self-dismiss guard
    // in `ActionResolution.ts > renderActionModal` (soft-lock fix
    // 2026-07-22). Kept here as well for direct-render callers.
    setModal(null);
    host.setAttribute("hidden", "");
    return;
  }
  const card = getScenarioCard(current.number);

  if (current.chosenOption === null) {
    renderFront(host, router, card);
  } else {
    renderBack(host, router, card, current.chosenOption);
  }
}

function renderFront(
  host: HTMLDivElement,
  router: Router,
  card: ReturnType<typeof getScenarioCard>,
): void {
  const sortedChoices = [...card.choices].sort((a, b) => a.letter.localeCompare(b.letter));
  const buttonsHtml = sortedChoices.map((choice) => `
    <button class="scenario-card-choice-btn"
            data-scenario-choice="${choice.letter}">
      <span class="scenario-card-choice-letter">${choice.letter}</span>
      <span class="scenario-card-choice-label">${escapeHtml(choice.label)}</span>
    </button>
  `).join("");

  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body scenario-card-modal">
      <header class="scenario-card-modal-header">
        <h3>${escapeHtml(card.printedId)} — ${escapeHtml(card.name.toUpperCase())}</h3>
      </header>
      <div class="scenario-card-modal-body scenario-card-modal-body--front">
        <figure class="scenario-card-modal-art">
          <img src="/scenario-cards/${escapeHtml(card.frontImage)}"
               alt="${escapeHtml(card.printedId)} — ${escapeHtml(card.name)} (front)"
               draggable="false" />
        </figure>
        <div class="scenario-card-modal-narrative-wrap">
          <p class="scenario-card-modal-narrative">${escapeHtml(card.narrative)}</p>
          <div class="scenario-card-modal-choices">
            ${buttonsHtml}
          </div>
        </div>
      </div>
    </div>
  `;

  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-scenario-choice]")) {
    btn.addEventListener("click", () => {
      const letter = btn.dataset.scenarioChoice as ScenarioCardChoiceLetter;
      logEvent("click.scenario-card.choose", { cardNumber: card.number, chosenOption: letter });
      for (const b of host.querySelectorAll<HTMLButtonElement>("[data-scenario-choice]")) {
        b.disabled = true;
      }
      let events: RewardEvent[] = [];
      try {
        events = chooseScenarioOption(router.state, letter);
      } catch (err) {
        console.warn("chooseScenarioOption rejected:", err);
        return;
      }
      PENDING_REWARDS.set(host, events);
      router.save();
      router.refresh();
    });
  }
}

function renderBack(
  host: HTMLDivElement,
  router: Router,
  card: ReturnType<typeof getScenarioCard>,
  letter: ScenarioCardChoiceLetter,
): void {
  const current = router.state.currentScenarioCard!;
  const choice = card.choices.find((c) => c.letter === letter)!;

  // Build interactive section HTML (if any pending step).
  let interactiveHtml = "";
  let showContinue = current.resolved;

  if (current.pendingDieRoll) {
    const pd = current.pendingDieRoll;
    if (pd.rolled === undefined) {
      // Pre-roll state: show Roll Die button.
      const outcomesHtml = pd.outcomeLabels.map((label) =>
        `<div class="scenario-die-outcome small muted">${escapeHtml(label)}</div>`,
      ).join("");
      interactiveHtml = `
        <div class="scenario-card-interactive scenario-card-interactive--die-roll">
          <div class="scenario-die-outcomes">${outcomesHtml}</div>
          <div class="die-roll-stage die-roll-stage--pre">
            <button class="btn btn--primary die-roll-btn" data-scenario-roll>Roll Die</button>
          </div>
        </div>
      `;
      showContinue = false;
    } else {
      // Post-roll state: show result, ready to continue.
      const rolled = pd.rolled;
      const outcomeLabel = pd.outcomeLabels.find((_, i) => {
        // Re-derive which range applies based on index order (no stored range).
        // The engine stored outcomeLabels in the same order as the effects array.
        // We just show the rolled number prominently; label lookup is cosmetic.
        return true; // fallback — show all labels, highlight the rolled result.
      }) ?? "";
      void outcomeLabel;
      interactiveHtml = `
        <div class="scenario-card-interactive scenario-card-interactive--die-roll">
          <div class="die-roll-stage die-roll-stage--result">
            <div class="die-roll-result die-roll-result--effective scenario-die-result-cycling"
                 aria-live="polite">${rolled}</div>
          </div>
        </div>
      `;
      showContinue = true;
    }
  } else if (current.pendingSubChoice) {
    const ps = current.pendingSubChoice;
    const optionBtns = ps.optionLabels.map((label, idx) => `
      <button class="scenario-card-choice-btn" data-scenario-sub-choice="${idx}">
        <span class="scenario-card-choice-label">${escapeHtml(label)}</span>
      </button>
    `).join("");
    interactiveHtml = `
      <div class="scenario-card-interactive scenario-card-interactive--sub-choice">
        <p class="small muted">Choose one:</p>
        <div class="scenario-card-sub-choices">${optionBtns}</div>
      </div>
    `;
    showContinue = false;
  } else if (current.pendingElementSpend) {
    const state = router.state;
    const delverButtons = Object.keys(state.loadouts).map((heroId) => {
      const bag = state.elements[heroId] ?? {};
      const totalElements = Object.values(bag).reduce((s, v) => s + (v ?? 0), 0);
      const disabled = totalElements === 0 ? "disabled" : "";
      const heroLabel = heroId === "hero-01" ? "Mind Delver" : "Body Delver";
      return `
        <button class="scenario-card-choice-btn" data-scenario-element-spend="${heroId}"
                ${disabled}>
          <span class="scenario-card-choice-label">
            ${escapeHtml(heroLabel)} (${totalElements} element${totalElements === 1 ? "" : "s"})
          </span>
        </button>
      `;
    }).join("");
    interactiveHtml = `
      <div class="scenario-card-interactive scenario-card-interactive--element-spend">
        <p class="small muted">Choose a delver to spend 1 ELEMENT (or skip):</p>
        <div class="scenario-card-sub-choices">
          ${delverButtons}
          <button class="scenario-card-choice-btn scenario-card-choice-btn--skip"
                  data-scenario-element-skip>
            <span class="scenario-card-choice-label">Skip</span>
          </button>
        </div>
      </div>
    `;
    showContinue = false;
  }

  const manualNote = (choice.effects.length === 0)
    ? `<p class="scenario-card-modal-manual-note small muted">Apply the printed resolution at the table; the digital state will not auto-update.</p>`
    : "";

  host.innerHTML = `
    <div class="action-menu-backdrop"></div>
    <div class="action-menu-body scenario-card-modal">
      <header class="scenario-card-modal-header">
        <h3>${escapeHtml(card.printedId)} — RESOLUTION ${escapeHtml(letter)}</h3>
        <p class="small muted">${escapeHtml(card.name)}</p>
      </header>
      <div class="scenario-card-modal-body scenario-card-modal-body--back">
        <figure class="scenario-card-modal-art">
          <img src="/scenario-cards/${escapeHtml(card.backImage)}"
               alt="${escapeHtml(card.printedId)} — ${escapeHtml(card.name)} (back)"
               draggable="false" />
        </figure>
        <div class="scenario-card-modal-resolution-wrap">
          <div class="scenario-card-modal-resolution-eyebrow small muted">
            You chose <strong>${escapeHtml(letter)}</strong>: ${escapeHtml(choice.label)}
          </div>
          <p class="scenario-card-modal-resolution">${escapeHtml(choice.resolutionText)}</p>
          ${manualNote}
          ${interactiveHtml}
          <div class="scenario-card-modal-actions">
            ${showContinue
              ? `<button class="btn btn--primary" data-scenario-continue>Continue →</button>`
              : `<button class="btn btn--primary" disabled>Continue →</button>`
            }
          </div>
        </div>
      </div>
    </div>
  `;

  // --- Die-roll button ---
  const rollBtn = host.querySelector<HTMLButtonElement>("[data-scenario-roll]");
  if (rollBtn) {
    const resultEl = host.querySelector<HTMLElement>(".scenario-die-result-cycling");
    rollBtn.addEventListener("click", () => {
      if (isResultBlocked("scenario-die-roll")) return;
      markFreshRoll("scenario-die-roll");
      rollBtn.disabled = true;
      const roll = Math.ceil(Math.random() * 6);
      let events: RewardEvent[] = [];
      try {
        events = resolveScenarioDieRoll(router.state, roll);
      } catch (err) {
        console.warn("resolveScenarioDieRoll rejected:", err);
        return;
      }
      const existing = PENDING_REWARDS.get(host) ?? [];
      PENDING_REWARDS.set(host, [...existing, ...events]);
      router.save();
      // Play animation on the result element if it exists after re-render,
      // then re-render to show the result and enable Continue.
      router.refresh();
      // After refresh the result element will be the cycling die.
      const newResultEl = host.querySelector<HTMLElement>(".scenario-die-result-cycling");
      if (newResultEl && consumeFreshRoll("scenario-die-roll")) {
        playDieRollCycle(newResultEl, roll, "scenario-die-roll");
      }
      void resultEl;
    });
  }

  // --- Sub-choice buttons ---
  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-scenario-sub-choice]")) {
    btn.addEventListener("click", () => {
      const optionIdx = parseInt(btn.dataset.scenarioSubChoice!, 10);
      for (const b of host.querySelectorAll<HTMLButtonElement>("[data-scenario-sub-choice]")) {
        b.disabled = true;
      }
      let events: RewardEvent[] = [];
      try {
        events = resolveScenarioSubChoice(router.state, optionIdx);
      } catch (err) {
        console.warn("resolveScenarioSubChoice rejected:", err);
        return;
      }
      const existing = PENDING_REWARDS.get(host) ?? [];
      PENDING_REWARDS.set(host, [...existing, ...events]);
      router.save();
      router.refresh();
    });
  }

  // --- Element spend buttons ---
  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-scenario-element-spend]")) {
    btn.addEventListener("click", () => {
      const heroId = btn.dataset.scenarioElementSpend!;
      disableElementSpendButtons(host);
      let events: RewardEvent[] = [];
      try {
        events = resolveScenarioElementSpend(router.state, heroId);
      } catch (err) {
        console.warn("resolveScenarioElementSpend rejected:", err);
        return;
      }
      const existing = PENDING_REWARDS.get(host) ?? [];
      PENDING_REWARDS.set(host, [...existing, ...events]);
      router.save();
      router.refresh();
    });
  }

  const skipBtn = host.querySelector<HTMLButtonElement>("[data-scenario-element-skip]");
  if (skipBtn) {
    skipBtn.addEventListener("click", () => {
      disableElementSpendButtons(host);
      let events: RewardEvent[] = [];
      try {
        events = resolveScenarioElementSpend(router.state, null);
      } catch (err) {
        console.warn("resolveScenarioElementSpend(skip) rejected:", err);
        return;
      }
      const existing = PENDING_REWARDS.get(host) ?? [];
      PENDING_REWARDS.set(host, [...existing, ...events]);
      router.save();
      router.refresh();
    });
  }

  // --- Continue button ---
  const continueBtn = host.querySelector<HTMLButtonElement>("[data-scenario-continue]");
  if (continueBtn) {
    continueBtn.addEventListener("click", async () => {
      logEvent("click.scenario-card.continue", {
        cardNumber: card.number,
        chosenOption: letter,
      });
      const pending = PENDING_REWARDS.get(host) ?? [];
      PENDING_REWARDS.delete(host);
      try {
        closeScenarioCard(router.state);
      } catch (err) {
        console.warn("closeScenarioCard rejected:", err);
        return;
      }
      // ORDER MATTERS (soft-lock fix 2026-07-22, same pattern as
      // FriendlyEncounterModal): present the rewards overlay BEFORE
      // persisting — `router.save()` re-renders the screen, which
      // detaches `host` (rewards overlay becomes unclickable) and
      // leaves the rebuilt `.action-modal` layer unhidden+empty (a
      // full-screen click-eater) because the scenario card is
      // already closed. Persist once at the end.
      if (pending.length > 0) {
        await presentRewards(host, pending);
      }
      setModal(null);
      router.save();
    });
  }
}

function disableElementSpendButtons(host: HTMLDivElement): void {
  for (const b of host.querySelectorAll<HTMLButtonElement>(
    "[data-scenario-element-spend], [data-scenario-element-skip]",
  )) {
    b.disabled = true;
  }
}

// Per-host pending-rewards bucket (WeakMap so entries are GC'd with the element).
const PENDING_REWARDS = new WeakMap<HTMLDivElement, RewardEvent[]>();

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
