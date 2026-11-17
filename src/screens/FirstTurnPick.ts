/**
 * FirstTurnPick — pre-hero "who takes the first turn?" picker.
 *
 * Runs at the start of every wave (both hand-authored Q1 and
 * spawn-deck Q2+), AFTER `delver-spawn-pick` resolves (Q2+) or
 * directly out of `buildEncounter` (Q1).
 *
 * Layout (mirrors BoardScreen so the hand-off into the wave feels
 * like a single continuous screen):
 *
 *   +--------------------------------------------------------+
 *   | TopBar: Quest #N - Wave X · Choose first delver        |
 *   +---------------------------+----------------------------+
 *   |                           | [View Mind] [View Body]    |
 *   |  Tide Board (read-only,   +----------------------------+
 *   |  full enemy + delver +    |  Suit board of currently-  |
 *   |  witness placement)       |  previewed delver          |
 *   |                           +----------------------------+
 *   |                           | [Take first turn ->]       |
 *   +---------------------------+----------------------------+
 *
 * UX flow:
 *   1. Phase enters `"first-turn-pick"`; this screen renders with
 *      the Mind delver previewed by default (matches the
 *      left-to-right suit-board convention used elsewhere).
 *   2. The toggle row above the suit board lets the player flip
 *      to the OTHER delver's suit board to inspect HP / weapons /
 *      passives / consumables before committing.
 *   3. "Take first turn ->" commits the currently-viewed delver
 *      as `state.currentDelverId`, flips the phase to `"hero"`,
 *      and fires the first `startHeroTurn` via
 *      `engine/encounter.ts > commitFirstTurnPick`.
 *
 * State model:
 *   - Currently-viewed delver lives in `uiState > peekedDelverId`
 *     — the same field the BoardScreen's Peek button uses, so
 *     the swap mechanism is shared with the in-wave flow.
 *   - Module-local state is intentionally empty: the picker is
 *     a single binary choice with no scratch state worth
 *     persisting. Browser refresh re-prompts with the default
 *     view, which is fine.
 *
 * Back button is a "give up + return to title" escape hatch — the
 * encounter survives (still persisted), so reentry resumes here.
 */

import type { Router } from "../main";
import type { EncounterState } from "../state";
import { getEnemy, HEROES, getHero, getQuestData } from "../data";
import {
  buildEncounterTokens,
  cellCenterPct,
  cellSizePct,
  CELL_SIZE_PCT,
  renderFatalFlawLockHtml,
  renderEnemyStatusTokensHtml,
  type BoardToken,
} from "../board/tideBoard";
import { commitFirstTurnPick } from "../engine/encounter";
import { startHeroTurn } from "../engine/turn";
import { renderSuitPanel } from "./SuitPanel";
import { renderHandPanel } from "./HandPanel";
import { renderCombatRulesPanel } from "./CombatRulesPanel";
import { renderActionModal } from "./ActionResolution";
import { presentEnemyAbilities, waveHasAnyEnemyAbilities } from "./EnemyAbilitiesModal";
import { getPeekedDelverId, setPeekedDelverId } from "../uiState";
import { logEvent } from "../debug/sessionLog";

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export function renderFirstTurnPickScreen(
  root: HTMLElement,
  router: Router,
  enc: EncounterState,
): void {
  // Defensive bail — same shape as DelverSpawnPick's guard. If the
  // phase slipped out between persist + re-render, bounce back to
  // BoardScreen rather than rendering a phase-inappropriate UI.
  if (enc.phase !== "first-turn-pick") {
    router.refresh();
    return;
  }

  const activeQuest = getQuestData(router.state.currentQuestId);
  const wave = activeQuest.waves.find((w) => w.number === enc.waveNumber) ?? activeQuest.waves[0]!;

  // Seed the previewed delver to whatever is in `peekedDelverId`,
  // falling back to the first hero (Mind, by HEROES convention)
  // — matches the left-to-right suit-board order the player sees
  // everywhere else in the UI. Defensive: drop any peek that
  // points to a non-existent loadout (e.g. a stale value from a
  // prior quest with a different roster).
  const heroIds = HEROES.map((h) => h.id);
  let viewedHeroId = getPeekedDelverId();
  if (!viewedHeroId || !heroIds.includes(viewedHeroId)) {
    viewedHeroId = heroIds[0]!;
    setPeekedDelverId(viewedHeroId);
  }

  const wrap = document.createElement("div");
  const chapterClass = activeQuest.id !== "quest1" ? " screen--ch2" : "";
  wrap.className = "screen screen--board screen--phase screen--first-turn-pick" + chapterClass;

  const viewedHero = getHero(viewedHeroId);
  const otherHeroId = heroIds.find((id) => id !== viewedHeroId) ?? viewedHeroId;
  const otherHero = getHero(otherHeroId);
  // Suit-named copy ("Mind Player Goes First" / "Body Player Goes
  // First") since that's the language the player thinks in — the
  // suit boards, topbar turn pill, and combat rules all reference
  // delvers by suit, never by hero card number.
  const suitLabel = viewedHero.suit === "mind" ? "Mind" : "Body";

  const showEnemyAbilitiesBtn = waveHasAnyEnemyAbilities(enc);
  wrap.innerHTML = `
    <div class="board-topbar">
      <div class="board-topbar-goal">
        ${showEnemyAbilitiesBtn ? `<button class="btn btn--small btn--ghost board-topbar-enemy-abilities" data-action="enemy-abilities" title="View ability + parting-shot reference for every enemy in this wave.">Enemy Abilities</button>` : ""}
        <strong>${escapeHtml(activeQuest.name)} - Wave ${wave.number}</strong>
        <span class="muted small"> &middot; Choose which delver takes the first turn</span>
      </div>
      <div class="board-topbar-actions">
        <button class="btn btn--small btn--ghost" data-action="back">Back to title</button>
      </div>
    </div>
    <div class="board-cols">
      <main class="board-col board-col--board">
        <div class="board-frame" data-board-frame>
          <img class="board-bg" src="/board/tide.jpg" alt="Tide board" draggable="false" />
          <div class="board-tokens" data-board-tokens></div>
        </div>
      </main>
      <aside class="board-col board-col--right first-turn-pick-aside">
        <div class="suit-stack" data-col-suit></div>
        <div class="board-bottom-row">
          ${renderCombatRulesPanel({ placeWeapon: false, useWeapon: false, moveDelver: false })}
          <div class="first-turn-pick-hand-col">
            <div class="first-turn-pick-actions">
            <h2 class="first-turn-pick-title">Choose who goes first</h2>
            <div class="first-turn-pick-buttons">
              <button class="btn btn--large first-turn-pick-confirm first-turn-pick-confirm--${viewedHero.suit}" data-action="confirm">
                ${escapeHtml(suitLabel)} Player Goes First
              </button>
              <button class="btn btn--large first-turn-pick-swap first-turn-pick-swap--${otherHero.suit}" data-action="swap-view" data-other-hero-id="${escapeHtml(otherHeroId)}">
                See other board
              </button>
            </div>
            </div>
            <div class="hand-stack" data-col-hand></div>
          </div>
        </div>
      </aside>
    </div>
    <div class="action-modal" data-action-modal hidden></div>
  `;
  root.appendChild(wrap);

  // Right column suit board + hand — re-uses the live in-wave
  // panel renderers so what the player sees here is byte-for-byte
  // what they'll see on turn 1 (HP, slot cards, passive
  // immediates, consumable widgets, the full equipment hand).
  // Read-only is enforced by the phase machinery —
  // `playWeaponCard` etc. all gate on `enc.phase === "hero"` so
  // the user can click slots / cards all they want, nothing
  // commits.
  const colSuit = wrap.querySelector<HTMLDivElement>("[data-col-suit]")!;
  const colHand = wrap.querySelector<HTMLDivElement>("[data-col-hand]")!;
  renderSuitPanel(colSuit, viewedHeroId, router);
  renderHandPanel(colHand, viewedHeroId, router);

  // Board tokens — read-only render (no click handlers, no
  // damage FX, no movement overlays). The player is here to look,
  // not interact.
  const tokensLayer = wrap.querySelector<HTMLDivElement>("[data-board-tokens]")!;
  const tokens = buildEncounterTokens(enc);
  renderTokensReadOnly(tokensLayer, tokens);

  const actionModalLayer = wrap.querySelector<HTMLDivElement>("[data-action-modal]")!;
  renderActionModal(actionModalLayer, router);

  // --- See other board (swap previewed delver) ----------------------------
  wrap.querySelector<HTMLButtonElement>("[data-action=swap-view]")!
    .addEventListener("click", () => {
      const target = otherHeroId;
      if (target === viewedHeroId) return;
      setPeekedDelverId(target);
      logEvent("ui.firstTurnPick.viewDelver", { heroId: target });
      router.refresh();
    });

  // --- Confirm button -----------------------------------------------------
  wrap.querySelector<HTMLButtonElement>("[data-action=confirm]")!
    .addEventListener("click", () => {
      logEvent("ui.firstTurnPick.confirm", {
        heroId: viewedHeroId,
        questId: activeQuest.id,
        waveNumber: enc.waveNumber,
      });
      // Clear the peek BEFORE commit so the BoardScreen render that
      // follows lands on the active delver's column (not stuck in
      // a stale peek state from the picker's tab toggle).
      setPeekedDelverId(null);
      commitFirstTurnPick(router.state, viewedHeroId!, startHeroTurn);
      router.save();
    });

  // --- Back to title ------------------------------------------------------
  wrap.querySelector<HTMLButtonElement>("[data-action=back]")!
    .addEventListener("click", () => {
      logEvent("ui.firstTurnPick.backToTitle");
      setPeekedDelverId(null);
      router.goTo({ name: "title" });
    });

  // --- Enemy abilities reference (Q2+ waves) ------------------------------
  wrap.querySelector<HTMLButtonElement>("[data-action=enemy-abilities]")
    ?.addEventListener("click", () => {
      const waveLabel = `${activeQuest.name} \u2014 Wave ${wave.number}`;
      logEvent("topbar.enemy-abilities", {
        questId: activeQuest.id,
        waveNumber: wave.number,
        from: "first-turn-pick",
      });
      void presentEnemyAbilities(document.body, enc, waveLabel);
    });
}

// ---------------------------------------------------------------------------
// Token rendering helpers
// ---------------------------------------------------------------------------

/**
 * Render the live board tokens without interactivity. Mirrors the
 * "no click, no FX" subset of BoardScreen's renderer + the read-only
 * branch of DelverSpawnPick. Witness chip, memory fragments, drops,
 * and enemy cards all render at their final tile positions so the
 * player sees the wave layout exactly as it will be on turn 1.
 */
function renderTokensReadOnly(
  layer: HTMLDivElement,
  tokens: BoardToken[],
): void {
  layer.innerHTML = "";
  // Stack offset for humanoid tokens that share a tile — same
  // 2x2 layout BoardScreen uses (two on top row, one centered
  // below) so the picker's board view matches the play board's
  // visual language.
  const byCell = new Map<string, BoardToken[]>();
  for (const t of tokens) {
    const k = `${t.col},${t.row}`;
    const arr = byCell.get(k) ?? [];
    arr.push(t);
    byCell.set(k, arr);
  }
  for (const t of tokens) {
    const stackmates = byCell.get(`${t.col},${t.row}`)!;
    const { left, top } = cellCenterPct(t.col, t.row);
    const isHumanoid = t.kind === "delver" || t.kind === "witness";
    const humanoidMates = isHumanoid
      ? stackmates.filter((m) => m.kind === "delver" || m.kind === "witness")
      : [];
    const humanoidIdx = isHumanoid ? humanoidMates.indexOf(t) : 0;
    const humanoidTotal = humanoidMates.length;
    const stackOffsetPct = (isHumanoid && humanoidTotal > 1)
      ? (humanoidIdx - (humanoidTotal - 1) / 2) * (CELL_SIZE_PCT * 0.35)
      : 0;

    if (t.kind === "delver") {
      const suit = t.cardId === "hero-mind" ? "mind" : "body";
      const el = document.createElement("div");
      el.className = `board-token board-token--delver board-token--delver-${suit}`;
      el.style.left = `${left + stackOffsetPct}%`;
      el.style.top  = `${top}%`;
      el.style.width  = `${CELL_SIZE_PCT * 0.35}%`;
      el.style.height = `${CELL_SIZE_PCT * 0.35}%`;
      el.textContent = t.label;
      el.title = t.name;
      layer.appendChild(el);
      continue;
    }

    if (t.kind === "witness") {
      const el = document.createElement("div");
      el.className = "board-token board-token--witness";
      el.style.left = `${left + stackOffsetPct}%`;
      el.style.top  = `${top}%`;
      el.style.width  = `${CELL_SIZE_PCT * 0.35}%`;
      el.style.height = `${CELL_SIZE_PCT * 0.35}%`;
      el.textContent = t.label;
      el.title = t.name;
      layer.appendChild(el);
      continue;
    }

    if (t.kind === "memory-fragment") {
      const MF_SIZE_PCT = CELL_SIZE_PCT * 0.30;
      const { wPct: cw, hPct: ch } = cellSizePct(t.col, t.row);
      const el = document.createElement("div");
      el.className = "board-token board-token--memory-fragment";
      el.style.left   = `${left + cw / 2 - MF_SIZE_PCT / 2}%`;
      el.style.top    = `${top + ch / 2 - MF_SIZE_PCT / 2}%`;
      el.style.width  = `${MF_SIZE_PCT}%`;
      el.style.height = `${MF_SIZE_PCT}%`;
      el.title = t.name;
      el.innerHTML = `<img src="/tokens/memory-fragment.webp" alt="${escapeHtml(t.name)}" draggable="false" />`;
      layer.appendChild(el);
      continue;
    }

    if (t.kind === "drop") continue;

    if (t.kind === "friendly-encounter") {
      const FE_SIZE_PCT = CELL_SIZE_PCT * 0.30;
      const { wPct: cw, hPct: ch } = cellSizePct(t.col, t.row);
      const el = document.createElement("div");
      el.className = "board-token board-token--friendly-encounter";
      el.style.left   = `${left + cw / 2 - FE_SIZE_PCT / 2}%`;
      el.style.top    = `${top + ch / 2 - FE_SIZE_PCT / 2}%`;
      el.style.width  = `${FE_SIZE_PCT}%`;
      el.style.height = `${FE_SIZE_PCT}%`;
      el.title = t.name;
      el.innerHTML = `<span class="board-token-fe-label">FRIENDLY<br>ENCOUNTER</span>`;
      layer.appendChild(el);
      continue;
    }

    const { wPct, hPct } = cellSizePct(t.col, t.row);
    const el = document.createElement("div");
    el.className = `board-tile board-tile--${t.kind}`;
    el.style.left = `${left}%`;
    el.style.top  = `${top}%`;
    el.style.width  = `${wPct}%`;
    el.style.height = `${hPct}%`;
    if (t.cardId) {
      el.innerHTML =
        `<img src="/cards/${encodeURI(getEnemyImage(t.cardId))}" alt="" draggable="false" />` +
        renderFatalFlawLockHtml(t) + renderEnemyStatusTokensHtml(t);
    } else {
      el.textContent = t.label;
    }
    layer.appendChild(el);
  }
}

function getEnemyImage(cardId: string): string {
  try {
    return getEnemy(cardId).image;
  } catch {
    return "";
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
