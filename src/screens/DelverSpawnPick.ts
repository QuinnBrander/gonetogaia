/**
 * DelverSpawnPick — pre-wave compass-tile picker (Q2+ only).
 *
 * Rendered when `encounter.phase === "delver-spawn-pick"`, which
 * `engine/encounter.ts > buildEncounter` parks the encounter in
 * after drawing a Spawn Card for a `spawn-deck`-style wave. The
 * board + enemies are already placed; only the delvers' starting
 * tiles remain undecided.
 *
 * Each Spawn Card prints 2 compass-star tiles (`card.delverSpawns`)
 * and the rulebook lets the party either STACK both delvers on the
 * same compass tile OR SPLIT them across the two. The picker
 * surfaces this as a "tap-a-delver, then tap-a-tile" placement
 * flow rather than a radio pair, so the deliberate act of placing
 * each delver reads as a setup moment rather than a passive
 * default-and-go.
 *
 * Layout (utilitarian, mirrors WavePhases conventions):
 *
 *   +----------------------------------------------------------+
 *   | TopBar: Quest name + Wave + "Pick spawn tiles" [Back]    |
 *   +-----------------------------+----------------------------+
 *   |                             |  Drawn Spawn Card art      |
 *   |  5x5 Tide Board with all    +----------------------------+
 *   |  enemies placed + A/B       |  Delver tray:              |
 *   |  badges on the 2 compass    |   [M] Hero #01 (unplaced)  |
 *   |  tiles (clickable when a    |   [B] Hero #02 (on Tile A) |
 *   |  delver is selected)        +----------------------------+
 *   |                             |  [Start Wave] (disabled    |
 *   |                             |   until both placed)       |
 *   +-----------------------------+----------------------------+
 *
 * UX flow:
 *   1. Both heroes start in the tray with a "needs placement"
 *      glow. Neither is rendered on the board yet — even though
 *      the engine pre-positions them on compass A as a safe
 *      default, the UI hides that fact until the player commits.
 *   2. Tap a tray icon → it becomes "selected" (ring glow).
 *   3. Tap one of the compass tiles → the delver lands there,
 *      the tray slot flips to "placed", and the selection clears.
 *   4. Tap a placed delver (either via the tray row or the
 *      board token) → selects them again. Tap the OTHER compass
 *      tile to move them.
 *   5. Once both heroes are placed, the Start Wave button
 *      releases its disabled state and adopts the same green
 *      attention-pulse the End Turn button uses when the active
 *      delver has nothing left to do.
 *
 * Engine contract (`engine/encounter.ts`):
 *   - `assignDelverToTile(state, heroId, x, y)` — placement
 *     mutation. Throws on bad input (heroId / tile mismatch).
 *   - `startWaveAfterPick(state, startHeroTurn)` — Start Wave
 *     button. Flips `phase` from `"delver-spawn-pick"` to
 *     `"first-turn-pick"`; the second-stage picker
 *     (`screens/FirstTurnPick.ts`) commits the actual hero turn
 *     via `commitFirstTurnPick`. The `startHeroTurn` arg is kept
 *     for source compatibility but is intentionally unused by the
 *     engine call now.
 *
 * The "which delvers has the player explicitly placed?" question is
 * intentionally module-local UI state (`pickSession`) rather than
 * a new EncounterState field. The session is keyed by the encounter's
 * Quest + Wave + drawn Spawn Card so navigating away (Back to title)
 * and returning re-prompts the player to consciously place each
 * delver — which matches the design intent. A browser refresh
 * also resets the session, which is acceptable for a single-screen
 * setup flow with no destructive consequences (engine state still
 * holds the safe default A/A placement).
 *
 * Back button is intentionally a "give up + return to title"
 * escape hatch — the partial pick survives (state.encounter is
 * already persisted), so reentry resumes at this same screen.
 */

import type { Router } from "../main";
import type { EncounterState } from "../state";
import { getEffectiveEquipmentRanks } from "../state";
import { getEnemy, HEROES, getHero, getQuestData, getEquipmentByTypeSuit, imageForRank } from "../data";
import { ALL_EQUIPMENT_TYPES, type EquipmentType } from "../types";
import {
  buildEncounterTokens,
  cellCenterPct,
  cellSizePct,
  CELL_SIZE_PCT,
  renderFatalFlawLockHtml,
  renderEnemyStatusTokensHtml,
  humanoidStackOffset,
  type BoardToken,
} from "../board/tideBoard";
import { assignDelverToTile, assignWitnessToTile, getSpawnCard, startWaveAfterPick } from "../engine/encounter";
import { startHeroTurn } from "../engine/turn";
import { presentEnemyAbilities, waveHasAnyEnemyAbilities } from "./EnemyAbilitiesModal";
import { renderActionModal } from "./ActionResolution";
import { hasPendingOpinionRankPicks } from "../engine/opinionGrants";
import { getModal, setModal } from "../uiState";
import { logEvent } from "../debug/sessionLog";

// --- Pick session (module-local UI state) -------------------------------

/**
 * Sentinel deployable id for the Witness companion (Q2+).
 *
 * The pick session treats Witness as a third "deployable" alongside
 * the actual delvers — same tap-and-place flow, same Start Wave
 * gate — but Witness isn't a hero (no HP, no turn, no `HEROES`
 * entry). Branching on this sentinel inside the picker keeps the
 * UI uniform without polluting `HEROES` or `state.loadouts` with
 * a fake third character.
 */
const WITNESS_DEPLOYABLE_ID = "witness";

/**
 * The "scratch" state for the current spawn-pick session.
 *
 * Holds two things that the engine's `EncounterState` doesn't model:
 *   - `unplaced` — deployable ids the player hasn't explicitly
 *     placed yet. The engine pre-positions delvers (+ Witness, on
 *     Q2+) on compass A, but the UI deliberately treats them as
 *     "in the tray" until the player taps a tile.
 *   - `selectedHeroId` — which deployable is currently "armed" for
 *     the next compass-tile click. Either a hero id (from
 *     `HEROES`) or the Witness sentinel (`WITNESS_DEPLOYABLE_ID`).
 *     `null` means "no selection; tile clicks are no-ops".
 *
 * Keyed by Quest+Wave+SpawnCard so a fresh draw OR a different
 * quest's pick screen reinitialises cleanly. Module-local (not
 * persisted) — see file header for the rationale.
 */
interface PickSession {
  key: string;
  unplaced: Set<string>;
  selectedHeroId: string | null;
}
let pickSession: PickSession | null = null;

function sessionKey(enc: EncounterState): string {
  return `${enc.questId}#w${enc.waveNumber}#card${enc.spawnCardDrawn}`;
}

function getOrInitPickSession(enc: EncounterState, deployableIds: string[]): PickSession {
  const key = sessionKey(enc);
  if (pickSession && pickSession.key === key) return pickSession;
  pickSession = {
    key,
    unplaced: new Set(deployableIds),
    selectedHeroId: null,
  };
  return pickSession;
}

/**
 * "Is this deployable id the Witness companion sentinel?"
 *
 * Wrapping the sentinel check in a helper means every branch
 * point — tray render, commit dispatch, status text — reads the
 * intent at the call site instead of repeating a magic-string
 * comparison. Cheap rename insurance for the day Witness gets a
 * proper id in a future schema bump.
 */
function isWitnessDeployable(id: string): boolean {
  return id === WITNESS_DEPLOYABLE_ID;
}

/**
 * Display name for a deployable id — Witness gets a hand-rolled
 * label, delvers go through `getHero` for their printed name.
 * Pulled into a helper so the prompt + tray rows + commit logs
 * stay in sync without each site re-checking the sentinel.
 */
function deployableDisplayName(id: string): string {
  if (isWitnessDeployable(id)) return "Witness";
  return getHero(id).name;
}

/**
 * Clear the module-local pick session — call when the encounter
 * leaves the pick phase (Start Wave commits) or when the player
 * returns to the title screen. Public so callers outside this
 * module can reset between encounters without poking the
 * implementation details.
 */
export function resetSpawnPickSession(): void {
  pickSession = null;
}

// --- Render --------------------------------------------------------------

export function renderDelverSpawnPickScreen(
  root: HTMLElement,
  router: Router,
  enc: EncounterState,
): void {
  // Sanity: bail back to BoardScreen if the encounter slipped out
  // of the pick phase between persist + re-render. Also defends
  // against a hand-edited save dropping us here without a drawn
  // card — `getSpawnCard` would otherwise throw mid-render.
  if (enc.phase !== "delver-spawn-pick" || enc.spawnCardDrawn == null) {
    router.refresh();
    return;
  }
  const card = getSpawnCard(enc.spawnCardDrawn);
  const compass = card.delverSpawns;
  // Defensive — `assertSpawnCardShape` already enforces exactly 2
  // compass tiles per card at build time. The bang is justified by
  // that invariant; if a future card breaks it, the engine throws
  // before we ever reach the UI.
  const tileA = compass[0]!;
  const tileB = compass[1]!;

  const activeQuest = getQuestData(router.state.currentQuestId);
  const wave = activeQuest.waves.find((w) => w.number === enc.waveNumber) ?? activeQuest.waves[0]!;

  const heroIds = HEROES.map((h) => h.id);
  // Deployables = heroes + (optionally) Witness. Q1 waves omit
  // Witness entirely, so the picker stays a 2-slot tray; Q2+
  // waves seed `witnessPosition` in `engine/encounter.ts >
  // buildEncounter`, which is what we branch on here so the UI
  // never has to consult the quest catalog directly.
  const deployableIds: string[] = [...heroIds];
  const hasWitness = enc.witnessPosition !== null;
  if (hasWitness) deployableIds.push(WITNESS_DEPLOYABLE_ID);
  const session = getOrInitPickSession(enc, deployableIds);
  // Defensive: drop any selectedHeroId that no longer exists in the
  // deployable list (shouldn't happen, but cheap guard so a stale
  // selection never gates a Start Wave click).
  if (session.selectedHeroId && !deployableIds.includes(session.selectedHeroId)) {
    session.selectedHeroId = null;
  }

  const wrap = document.createElement("div");
  // Chapter-id modifier — drives `.screen--board.screen--ch2` backdrop.
  const chapterClass = activeQuest.id !== "quest1" ? " screen--ch2" : "";
  wrap.className = "screen screen--board screen--phase screen--delver-spawn-pick" + chapterClass;
  const allPlaced = session.unplaced.size === 0;
  // Start Wave is also gated on the Opinion-Card pick queue being
  // empty — the picks are a quest-start passive that must resolve
  // before the wave proper begins (the bumps may change which
  // weapons are in the player's hand for turn 1).
  const pendingOpinionPicks = hasPendingOpinionRankPicks(router.state);
  const canStartWave = allPlaced && !pendingOpinionPicks;
  // Hide "Enemy Abilities" topbar button when no wave enemy has
  // a passive ability (e.g. Quest #1). See `waveHasAnyEnemy-
  // Abilities` in EnemyAbilitiesModal.ts.
  const showEnemyAbilitiesBtn = waveHasAnyEnemyAbilities(enc);
  wrap.innerHTML = `
    <div class="board-topbar">
      <div class="board-topbar-goal">
        ${showEnemyAbilitiesBtn ? `<button class="btn btn--small btn--ghost board-topbar-enemy-abilities" data-action="enemy-abilities" title="View ability + parting-shot reference for every enemy in this wave.">Enemy Abilities</button>` : ""}
        <strong>${escapeHtml(activeQuest.name)} - Wave ${wave.number}</strong>
        <span class="muted small"> &middot; ${renderPickPrompt(session, allPlaced, hasWitness)}</span>
      </div>
      <div class="board-topbar-actions">
        <button class="btn btn--small btn--ghost" data-action="back">Back to title</button>
      </div>
    </div>
    <div class="board-cols">
      <main class="board-col board-col--board">
        <div class="board-frame" data-board-frame>
          <img class="board-bg" src="/board/tide.jpg" alt="Tide board" draggable="false" />
          <div class="board-targets" data-board-compass></div>
          <div class="board-tokens" data-board-tokens></div>
        </div>
      </main>
      <aside class="board-col board-col--right phase-panel">
        <div class="spawn-pick-stack">
          <div class="spawn-pick-card">
            <h3 class="spawn-pick-card-title">Spawn Card <span class="muted">#${card.number}</span></h3>
            <img class="spawn-pick-card-img" src="/spawn-cards/${escapeHtml(card.image)}" alt="Spawn card #${card.number}" draggable="false" />
            <p class="small muted">${hasWitness
              ? "Each delver picks one of the two highlighted spawn points; Witness picks one too. All three may share a tile."
              : "Each delver picks one of the two highlighted spawn points. Both may share a tile."}</p>
          </div>
          <div class="spawn-tray" data-spawn-tray>
            <h4 class="spawn-tray-title">${hasWitness ? "Delvers + Witness to deploy" : "Delvers to deploy"}</h4>
            <div class="spawn-tray-slots" data-spawn-tray-slots></div>
          </div>
          <div class="spawn-pick-actions">
            <button class="btn btn--accent btn--large${canStartWave ? " btn--ready" : ""}" data-action="start-wave"${canStartWave ? "" : " disabled"}>Start Wave</button>
            ${pendingOpinionPicks
              ? `<p class="small muted">Resolve Xavier's favor first &mdash; the Opinion Card picker is open.</p>`
              : ""}
          </div>
        </div>
      </aside>
    </div>
    <div class="action-modal" data-action-modal hidden></div>
  `;
  root.appendChild(wrap);

  // Auto-open the Opinion-Card rank pick modal at quest start
  // whenever the pick queue has entries and nothing else is open.
  // Mirrors the BoardScreen wiring — the player must resolve
  // every Xavier pick before placing delvers on the board.
  if (pendingOpinionPicks && getModal() == null) {
    setModal({ kind: "opinion-rank-pick" });
  }
  const actionModalLayer = wrap.querySelector<HTMLDivElement>("[data-action-modal]")!;
  renderActionModal(actionModalLayer, router);

  // --- Tray slots ---------------------------------------------------------
  const slotsHost = wrap.querySelector<HTMLDivElement>("[data-spawn-tray-slots]")!;
  slotsHost.innerHTML = deployableIds
    .map((id) => renderTraySlotHtml(id, session, enc, tileA, tileB))
    .join("");
  slotsHost.querySelectorAll<HTMLButtonElement>("[data-tray-hero]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const heroId = btn.dataset.trayHero!;
      // Re-tap of the same selection clears it (so the player can
      // back out of a mis-tap without committing anywhere).
      session.selectedHeroId = session.selectedHeroId === heroId ? null : heroId;
      logEvent("ui.delverSpawnPick.selectHero", {
        heroId,
        from: "tray",
        nowSelected: session.selectedHeroId,
        placed: !session.unplaced.has(heroId),
      });
      router.refresh();
    });
  });

  // "See Equipment" buttons — one per delver (not Witness, who has
  // no equipment). Shows the delver's current effective equipment
  // (all types owned at rank ≥ 1 this quest) so the player can
  // review their hand before deciding which spawn tile to take.
  slotsHost.querySelectorAll<HTMLButtonElement>("[data-see-equipment]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const heroId = btn.dataset.seeEquipment!;
      showDelverEquipmentPopup(heroId, router);
    });
  });

  // --- Board: enemies + delver tokens + compass-tile A/B badges ----------
  // Build the token list, then strip any delver / witness tokens
  // that correspond to currently-unplaced deployables. This is the
  // visual hand-off: the engine still has them on compass A, but
  // the picker hides them in the tray instead of double-drawing.
  const placedTokens = buildEncounterTokens(enc).filter((t) => {
    if (t.kind === "delver") return !session.unplaced.has(t.heroId ?? "");
    if (t.kind === "witness") return !session.unplaced.has(WITNESS_DEPLOYABLE_ID);
    return true;
  });
  const tokensLayer = wrap.querySelector<HTMLDivElement>("[data-board-tokens]")!;
  renderTokensReadOnly(
    tokensLayer,
    placedTokens,
    session.selectedHeroId,
    (deployableId) => {
      // Board-side token click — same select/deselect behaviour as
      // the tray row, but only fires on PLACED deployables (since
      // the unplaced ones aren't on the board). Works for both
      // delver chips and the Witness chip.
      session.selectedHeroId = session.selectedHeroId === deployableId ? null : deployableId;
      logEvent("ui.delverSpawnPick.selectHero", {
        heroId: deployableId,
        from: "board",
        nowSelected: session.selectedHeroId,
        placed: true,
      });
      router.refresh();
    },
  );

  // Compass tiles are clickable only while a delver is selected.
  // The pulsing "this tile is important" glow stays on regardless
  // so the player learns which tiles are A and B even before they
  // arm a delver.
  const compassLayer = wrap.querySelector<HTMLDivElement>("[data-board-compass]")!;
  paintCompassBadge(
    compassLayer,
    tileA.x,
    tileA.y,
    "A",
    session.selectedHeroId !== null,
    () => commitTile(router, enc, session, tileA, "A"),
  );
  paintCompassBadge(
    compassLayer,
    tileB.x,
    tileB.y,
    "B",
    session.selectedHeroId !== null,
    () => commitTile(router, enc, session, tileB, "B"),
  );

  // --- Start Wave: transition to hero phase + kick off turn 1 -----------
  wrap.querySelector<HTMLButtonElement>("[data-action=start-wave]")!
    .addEventListener("click", () => {
      if (session.unplaced.size > 0) {
        // Defensive — the button is `disabled` in the DOM until
        // both placed, but a stray programmatic click would
        // otherwise commit the engine's default A/A placement
        // without the player's consent.
        return;
      }
      if (hasPendingOpinionRankPicks(router.state)) {
        // Defensive — DOM disable handles this for keyboard / mouse
        // input; the guard catches programmatic clicks (e.g. from a
        // stale auto-click race the player's resolve handler kicks
        // off as the modal closes).
        return;
      }
      logEvent("ui.delverSpawnPick.startWave", {
        spawnCardNumber: card.number,
        delverPositions: enc.delverPositions,
      });
      resetSpawnPickSession();
      startWaveAfterPick(router.state, startHeroTurn);
      router.save();
    });

  // Back to title — leaves the pick state intact (still persisted on
  // `state.encounter`), so reentry via "Resume" returns here. The
  // module-local session resets so the player consciously re-picks
  // on resume (matches the design intent of "deploy your delvers").
  wrap.querySelector<HTMLButtonElement>("[data-action=back]")!
    .addEventListener("click", () => {
      logEvent("ui.delverSpawnPick.backToTitle");
      resetSpawnPickSession();
      router.goTo({ name: "title" });
    });

  // Button may be omitted when no wave enemy has a passive
  // ability (see `showEnemyAbilitiesBtn` gate above). Optional-
  // chain the wiring so the missing element is a no-op.
  wrap.querySelector<HTMLButtonElement>("[data-action=enemy-abilities]")
    ?.addEventListener("click", () => {
      const waveLabel = `${activeQuest.name} \u2014 Wave ${wave.number}`;
      logEvent("topbar.enemy-abilities", { questId: activeQuest.id, waveNumber: wave.number, from: "delver-spawn-pick" });
      void presentEnemyAbilities(document.body, enc, waveLabel);
    });
}

// --- Commit -------------------------------------------------------------

/**
 * Commit the currently-armed deployable (delver or Witness) to
 * `tile`. Used by both compass tile click handlers — the only
 * difference per-tile is which (x, y) gets passed into the engine
 * call. After the engine call the deployable leaves the `unplaced`
 * set (if they were in it), the selection clears, and we re-render
 * so the board token shows up / moves.
 *
 * Dispatches between `assignDelverToTile` and `assignWitnessToTile`
 * based on the sentinel — Witness has a single `witnessPosition`
 * slot on the encounter, delvers go through the per-hero
 * `delverPositions` map. The "already on this tile" no-op guard
 * also branches on the sentinel so the mis-tap log fires for
 * either kind of deployable.
 */
function commitTile(
  router: Router,
  enc: EncounterState,
  session: PickSession,
  tile: { x: number; y: number },
  tileLabel: "A" | "B",
): void {
  const deployableId = session.selectedHeroId;
  if (!deployableId) return;
  const isWitness = isWitnessDeployable(deployableId);
  // No-op if the player taps the tile this deployable is already
  // on. Without this guard, the engine call still succeeds
  // (idempotent) but we'd lose the visual cue that nothing changed
  // and burn a re-render. Cleaner to early-exit + log it so the
  // audit trail captures the player's mis-tap.
  const currentPos = isWitness
    ? enc.witnessPosition
    : enc.delverPositions[deployableId];
  const isAlreadyPlacedHere =
    !session.unplaced.has(deployableId)
    && currentPos != null
    && currentPos.x === tile.x
    && currentPos.y === tile.y;
  if (isAlreadyPlacedHere) {
    logEvent("ui.delverSpawnPick.tileClick.noop", { heroId: deployableId, tile: tileLabel });
    session.selectedHeroId = null;
    router.refresh();
    return;
  }
  if (isWitness) {
    assignWitnessToTile(router.state, tile.x, tile.y);
  } else {
    assignDelverToTile(router.state, deployableId, tile.x, tile.y);
  }
  const wasUnplaced = session.unplaced.has(deployableId);
  session.unplaced.delete(deployableId);
  session.selectedHeroId = null;
  logEvent("ui.delverSpawnPick.commit", {
    heroId: deployableId,
    tile: tileLabel,
    x: tile.x,
    y: tile.y,
    wasUnplaced,
    unplacedRemaining: session.unplaced.size,
  });
  router.save();
}

// --- Tray slot HTML ------------------------------------------------------

/**
 * One delver's tray slot. Three visual states the slot can be in:
 *   - unplaced (needs-placement glow) — default on screen entry.
 *   - selected (ring glow) — armed for the next tile click.
 *   - placed (dimmed + "On Tile A/B" status) — fully deployed.
 *
 * Selected + unplaced can co-exist (an armed but not-yet-placed
 * delver pulses AND glows). Selected + placed can co-exist (a
 * placed delver re-selected for repositioning).
 */
function renderTraySlotHtml(
  deployableId: string,
  session: PickSession,
  enc: EncounterState,
  tileA: { x: number; y: number },
  tileB: { x: number; y: number },
): string {
  const isWitness = isWitnessDeployable(deployableId);
  const isUnplaced = session.unplaced.has(deployableId);
  const isSelected = session.selectedHeroId === deployableId;
  const pos = isWitness
    ? enc.witnessPosition
    : enc.delverPositions[deployableId];
  // "On Tile A" / "On Tile B" only matters once placed; for
  // unplaced deployables we show the placement prompt instead.
  let statusText: string;
  if (isUnplaced) {
    statusText = isSelected ? "Tap tile A or B" : "Tap to deploy";
  } else if (pos && pos.x === tileA.x && pos.y === tileA.y) {
    statusText = "On Tile A";
  } else if (pos && pos.x === tileB.x && pos.y === tileB.y) {
    statusText = "On Tile B";
  } else {
    // Off-compass position — shouldn't happen since the engine's
    // assign helpers only accept compass coords, but cheap to
    // surface honestly instead of lying with "On Tile A".
    statusText = pos ? `On (${pos.x}, ${pos.y})` : "Position unknown";
  }
  // Witness uses its own copper-tinted variant; delvers keep their
  // suit-based mind/body styling. The pip letter mirrors the board
  // token letter ("W" vs "M"/"B") so the tray row reads as the
  // same chip the player will see on the board after Start Wave.
  let suitOrVariant: string;
  let pipLetter: string;
  let displayName: string;
  if (isWitness) {
    suitOrVariant = "witness";
    pipLetter = "W";
    displayName = "Witness";
  } else {
    const hero = getHero(deployableId);
    suitOrVariant = hero.suit;
    pipLetter = hero.suit === "mind" ? "M" : "B";
    displayName = hero.name;
  }
  const cls = [
    "spawn-tray-slot",
    `spawn-tray-slot--${suitOrVariant}`,
    isUnplaced ? "spawn-tray-slot--needs-placement" : "spawn-tray-slot--placed",
    isSelected ? "spawn-tray-slot--selected" : "",
  ].filter(Boolean).join(" ");
  const seeEquipBtn = !isWitness
    ? `<button type="button" class="btn btn--small btn--ghost spawn-tray-equip-btn" data-see-equipment="${escapeHtml(deployableId)}">See Equipment</button>`
    : "";
  return `
    <div class="spawn-tray-row">
      <button type="button" class="${cls}" data-tray-hero="${escapeHtml(deployableId)}">
        <span class="spawn-tray-pip spawn-tray-pip--${suitOrVariant}">${pipLetter}</span>
        <div class="spawn-tray-info">
          <strong>${escapeHtml(displayName)}</strong>
          <span class="spawn-tray-status small muted">${escapeHtml(statusText)}</span>
        </div>
      </button>
      ${seeEquipBtn}
    </div>
  `;
}

// --- Board overlays ------------------------------------------------------

/**
 * Render the live board tokens (enemies + already-placed delvers).
 * Delver tokens are clickable so the player can re-select a placed
 * delver to move them to the other compass tile. `selectedHeroId`
 * drives the per-token `--selected` ring; `onDelverClick` handles
 * the selection toggle.
 */
function renderTokensReadOnly(
  layer: HTMLDivElement,
  tokens: BoardToken[],
  selectedHeroId: string | null,
  onDeployableClick: (deployableId: string) => void,
): void {
  layer.innerHTML = "";
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
    // Same stacking as BoardScreen / WavePhases (`humanoidStackOffset`:
    // 2 side by side, 3 in a triangle) so all chips fit inside the tile
    // the moment the third unit is placed, not only after Start Wave.
    const isHumanoid = t.kind === "delver" || t.kind === "witness";
    const humanoidMates = isHumanoid
      ? stackmates.filter((m) => m.kind === "delver" || m.kind === "witness")
      : [];
    const humanoidIdx = isHumanoid ? humanoidMates.indexOf(t) : 0;
    const humanoidTotal = humanoidMates.length;
    const { dxPct: stackOffsetPct, dyPct: stackOffsetYPct } = humanoidStackOffset(
      humanoidIdx,
      humanoidTotal,
    );

    if (t.kind === "delver") {
      const suit = t.cardId === "hero-mind" ? "mind" : "body";
      const heroId = t.heroId ?? "";
      const isSelected = heroId !== "" && heroId === selectedHeroId;
      const el = document.createElement("button");
      el.type = "button";
      el.className = `board-token board-token--delver board-token--delver-${suit} board-token--delver-pickable${isSelected ? " is-selected" : ""}`;
      el.style.left = `${left + stackOffsetPct}%`;
      el.style.top  = `${top + stackOffsetYPct}%`;
      el.style.width  = `${CELL_SIZE_PCT * 0.35}%`;
      el.style.height = `${CELL_SIZE_PCT * 0.35}%`;
      el.textContent = t.label;
      el.title = `${t.name} — tap to reposition`;
      el.addEventListener("click", () => onDeployableClick(heroId));
      layer.appendChild(el);
      continue;
    }

    if (t.kind === "witness") {
      // Same chip footprint as a delver but with the witness paint
      // and a tap-to-reposition affordance only available during
      // the pick phase (this read-only renderer). Once the wave
      // starts, BoardScreen renders Witness without the click
      // handler / "is-selected" ring — he becomes inert.
      const isSelected = selectedHeroId === WITNESS_DEPLOYABLE_ID;
      const el = document.createElement("button");
      el.type = "button";
      el.className = `board-token board-token--witness board-token--delver-pickable${isSelected ? " is-selected" : ""}`;
      el.style.left = `${left + stackOffsetPct}%`;
      el.style.top  = `${top + stackOffsetYPct}%`;
      el.style.width  = `${CELL_SIZE_PCT * 0.35}%`;
      el.style.height = `${CELL_SIZE_PCT * 0.35}%`;
      el.textContent = t.label;
      el.title = `${t.name} - tap to reposition`;
      el.addEventListener("click", () => onDeployableClick(WITNESS_DEPLOYABLE_ID));
      layer.appendChild(el);
      continue;
    }

    if (t.kind === "memory-fragment") {
      // Visible at the pick screen so the player can see the
      // diamond glyph from the drawn Spawn Card before they
      // commit compass tiles — informs whether one delver should
      // detour for the fragment. Same anchor/sizing as the
      // BoardScreen render branch.
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

    if (t.kind === "drop") continue; // No drops yet at wave start.

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

/**
 * Paint a compass spawn-point ring on top of the board. No visible
 * letter / glyph — the ring itself communicates "this is a spawn
 * tile" via its pulse, and the tooltip carries the disambiguation
 * for assistive tech. When `clickable` is true the tile gets the
 * loud `--compass-clickable` paint (saturated green glow + scale
 * pulse + downward chevron) so the player sees instantly which
 * tiles to tap; when false it stays as a quieter base ring so the
 * layout is legible without screaming for attention.
 *
 * The `label` param is intentionally kept ("A" / "B") but is now
 * tooltip-only — useful for debugging and screen readers, never
 * painted on the board.
 */
function paintCompassBadge(
  layer: HTMLDivElement,
  x: number,
  y: number,
  label: "A" | "B",
  clickable: boolean,
  onClick: () => void,
): void {
  const { left, top } = cellCenterPct(x, y);
  const { wPct, hPct } = cellSizePct(x, y);
  const el = document.createElement("button");
  el.type = "button";
  const cls = [
    "board-target",
    "board-target--phase",
    "board-target--compass",
    clickable ? "board-target--compass-clickable" : "",
  ].filter(Boolean).join(" ");
  el.className = cls;
  el.style.left = `${left}%`;
  el.style.top = `${top}%`;
  el.style.width = `${wPct}%`;
  el.style.height = `${hPct}%`;
  el.title = clickable
    ? `Deploy here (spawn point ${label})`
    : `Spawn point ${label} (${x}, ${y})`;
  el.setAttribute("aria-label", el.title);
  el.disabled = !clickable;
  if (clickable) {
    el.addEventListener("click", onClick);
  }
  layer.appendChild(el);
}

// --- Equipment popup -----------------------------------------------------

/**
 * Show a lightweight overlay with every piece of equipment the
 * delver currently owns (rank ≥ 1) so the player can review
 * their hand before committing to a spawn tile.
 *
 * Tap/click outside the card grid (on the backdrop) or the ✕
 * button to dismiss. The overlay is appended to `document.body`
 * so it floats above the spawn-pick UI without disrupting the
 * phase layout.
 */
function showDelverEquipmentPopup(heroId: string, router: Router): void {
  const hero = getHero(heroId);
  const ranks = getEffectiveEquipmentRanks(router.state, heroId);
  const ownedTypes = (ALL_EQUIPMENT_TYPES as readonly EquipmentType[]).filter(
    (t) => (ranks[t] ?? 0) >= 1,
  );

  const overlay = document.createElement("div");
  overlay.className = "spawn-equip-overlay";
  const suit = hero.suit;
  const heroLabel = hero.name.toUpperCase();

  const cardsHtml = ownedTypes.length === 0
    ? `<p class="spawn-equip-empty muted">No equipment owned yet.</p>`
    : ownedTypes.map((type) => {
        const rank = ranks[type] ?? 1;
        const equip = getEquipmentByTypeSuit(suit, type);
        const imgSrc = `/cards/${imageForRank(suit, type, rank)}`;
        const cardName = equip?.name ?? type;
        return `<div class="spawn-equip-card"><img src="${imgSrc}" alt="${escapeHtml(cardName)} R${rank}" draggable="false" /></div>`;
      }).join("");

  overlay.innerHTML = `
    <div class="spawn-equip-backdrop" data-equip-backdrop></div>
    <div class="spawn-equip-panel">
      <div class="spawn-equip-header">
        <h3 class="spawn-equip-title">${escapeHtml(heroLabel)} — Equipment</h3>
        <button class="spawn-equip-close" data-equip-close aria-label="Close">✕</button>
      </div>
      <div class="spawn-equip-grid">${cardsHtml}</div>
    </div>
  `;

  const dismiss = (): void => { overlay.remove(); };
  overlay.querySelector("[data-equip-backdrop]")!.addEventListener("click", dismiss);
  overlay.querySelector("[data-equip-close]")!.addEventListener("click", dismiss);
  document.body.appendChild(overlay);
}

// --- Helpers -------------------------------------------------------------

/**
 * Resolve a card id to its art-path fragment. Falls back to an
 * empty string if the lookup misses — the read-only render is
 * allowed to skip cards that don't resolve, since the pick screen
 * is purely informational about board state. A graceful blank tile
 * here beats a `getEnemy` throw that aborts the whole render mid-
 * frame (and beats a brittle 404'd `<img>`).
 */
function getEnemyImage(cardId: string): string {
  try {
    return getEnemy(cardId).image;
  } catch {
    return "";
  }
}

/**
 * Top-bar microcopy that mirrors the current pick-session state.
 * Three states, with a fourth refinement for selected + already-
 * placed (where "deploy" reads as misleading — they're just
 * moving to the other compass tile).
 */
function renderPickPrompt(
  session: PickSession,
  allPlaced: boolean,
  hasWitness: boolean,
): string {
  if (allPlaced && session.selectedHeroId === null) {
    // Pluralise the "all placed" copy depending on whether Witness
    // is in the deployable list — saying "Both delvers placed" on
    // a Q2 wave is a lie about the third chip on the board.
    return hasWitness
      ? "Both delvers + Witness placed. Start the wave whenever you're ready."
      : "Both delvers placed. Start the wave whenever you're ready.";
  }
  if (session.selectedHeroId === null) {
    return hasWitness
      ? "Tap a delver or Witness on the right, then tap one of the highlighted spawn points."
      : "Tap a delver on the right, then tap one of the highlighted spawn points.";
  }
  const name = escapeHtml(deployableDisplayName(session.selectedHeroId));
  const isAlreadyPlaced = !session.unplaced.has(session.selectedHeroId);
  return isAlreadyPlaced
    ? `${name} selected. Tap the other spawn point to reposition.`
    : `${name} selected. Tap a highlighted spawn point to deploy.`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
