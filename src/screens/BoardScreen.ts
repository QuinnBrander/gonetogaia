/**
 * BoardScreen — the main play screen.
 *
 * Layout (no-scroll, fits one viewport):
 *
 *   +--------------------------------------------------------+
 *   | TopBar: Goal text                  [Peek] [Back]       |
 *   +---------------------------+----------------------------+
 *   |                           |  Suit Board (active)       |
 *   |  Tide Board (5x5)         +----------------------------+
 *   |                           |  Hand of equipment cards   |
 *   +---------------------------+----------------------------+
 *
 * Only ONE delver's suit board + hand is shown at a time. The "viewed"
 * delver defaults to `state.currentDelverId`. The Peek button
 * temporarily switches the right column to show the other delver's
 * state without flipping turn ownership. The Tide Board (left) never
 * changes.
 *
 * Stage 4 will own the actual end-turn flow that flips currentDelverId.
 */

import { damageAlreadyIncreased, overcharge, overchargeEffect } from "../engine/overcharger";
import { useWitnessAbility, witnessAbility, witnessAbilityBlocker, type WitnessAbilityMode } from "../engine/witnessAbility";
import type { Router } from "../main";
import { totalBossParts } from "../state";
import { HEROES, activeQuestGoalText, getEnemy, getHero, getQuestData, questDisplayLabel } from "../data";
import { presentRewards } from "./RewardsModal";
import { populatePendingHeroPicks } from "../engine/heroPick";
import { renderHeroPickScreen } from "./HeroPick";
import {
  buildEncounterTokens,
  cellCenterPct,
  cellSizePct,
  CELL_SIZE_PCT,
  renderEnemyHpOverlayHtml,
  renderFatalFlawLockHtml,
  renderEnemyStatusTokensHtml,
  humanoidStackOffset,
  type BoardToken,
} from "../board/tideBoard";
import { renderSuitPanel } from "./SuitPanel";
import { renderCombatRulesPanel, type CheatsheetActive } from "./CombatRulesPanel";
import { renderHandPanel } from "./HandPanel";
import { xpToNextLevel } from "../xp";
import {
  clearActionState,
  clearLastAutoRefresh,
  clearPeek,
  clearSelectedCard,
  abilityProcFxDurationMs,
  collectAbilityProcFx,
  damageFxDurationMs,
  detectDamageAndQueueFx,
  getActiveDamageFx,
  getArmedAbility,
  getLastAutoRefresh,
  getModal,
  getMovementArmed,
  getPeekedDelverId,
  getSelectedCard,
  setMovementArmed,
  setPeekedDelverId,
  syncAutoPeekToModal,
  type TokenHealthSnap,
} from "../uiState";
import { ensureEncounter } from "../engine/encounter";
import { endHeroTurn, startHeroTurn, prepareToRun } from "../engine/turn";
import { legalStepDestinations, moveDelverStep, movementUndoBlockedReason, undoMovementThisTurn } from "../engine/movement";
import { flyTilePickupsToWallet } from "../ui/flyToWallet";
import {
  advanceAfterAction,
  renderActionModal,
  renderActionTargets,
  renderWitnessMoveTargets,
  renderArmedInstruction,
  wireActionTopbarButtons,
} from "./ActionResolution";
import { commitManualEndTurn, maybeAutoEndTurn } from "./turnFlow";
import { installRemoteSuitPickOpener, renderWavePhaseScreen } from "./WavePhases";
import { renderDelverSpawnPickScreen } from "./DelverSpawnPick";
import { renderFirstTurnPickScreen } from "./FirstTurnPick";
import { enemyAbilityLabel, presentEnemyAbilities, waveHasAnyEnemyAbilities } from "./EnemyAbilitiesModal";
import { presentShopProducts } from "./ShopProductsModal";
import { hasPendingLevelUpDraws } from "./LevelUpModal";
import { hasPendingOpinionRankPicks } from "../engine/opinionGrants";
import { hasPendingSuitConditionRankPicks } from "../engine/suitConditionGrants";
import {
  canShowElaynaRedeemButton,
  canShowRodrigoRedeemButton,
  countSpentTokens,
  missingHp,
  redeemElaynaAlly,
  redeemRodrigoAlly,
} from "../engine/opinionRedeem";
import { hasPendingElementChoices } from "../engine/os";
import { hasPendingEquipmentRolls, peekNextPendingEquipmentRoll } from "../engine/tokens";
import { hasPendingXpRolls, peekNextPendingXpRoll } from "../engine/kills";
import { hasPendingCreaturePartChoices } from "../engine/creatureParts";
import { setModal } from "../uiState";
import { debugKeyLoseWave, debugKeyWinWave } from "../engine/debugCommands";
import { onlineIsActorNow, REMOTE_APPLIED_EVENT } from "../net/onlineController";
import type { Modal } from "../uiState";
import { logEvent, snapElements, snapHeroAp, snapTurn } from "../debug/sessionLog";
import { maybeShowTurnStartBanner } from "../ui/turnStartBanner";

export function renderBoardScreen(root: HTMLElement, router: Router): void {
  // Bootstrap (or reuse) the live encounter for whichever quest the
  // campaign is on. Quest 1 has a hand-authored Wave 1 spawn and
  // `ensureEncounter` builds it directly. Quest 2 declares spawn-deck
  // spawning which the engine doesn't yet wire (Phase B) — catch the
  // `buildEncounter` throw here and render a friendly placeholder
  // explaining what isn't done yet, instead of crashing the whole
  // screen render. If the current delver still has full base
  // resources we ALSO start their turn so a fresh encounter begins
  // at "you have your full Movement and AP" rather than whatever
  // stale values were on the loadout. NOTE: persist() (not save())
  // — save() would re-render and infinite-loop.
  const isFreshEncounter = router.state.encounter === null;
  const activeQuest = getQuestData(router.state.currentQuestId);

  // Quest-start hero pick (2026-05-20): if this is a fresh quest
  // entry and any delver owns 2+ hero cards of their suit, prompt
  // them to choose which one to bring. Each delver picks in turn,
  // one screen-render apart, until the queue empties — only THEN
  // do we fall through to `ensureEncounter` and the regular wave
  // flow. The populate call is gated by
  // `state.heroPicksAppliedQuests`, so quest retries / resumes
  // don't re-fire the picker mid-quest.
  if (isFreshEncounter) {
    populatePendingHeroPicks(router.state, activeQuest.id);
  }
  if (router.state.pendingHeroPickDelvers.length > 0) {
    // Persist (no re-render) so the `heroPicksAppliedQuests` latch
    // + the queue itself survive a browser refresh in the middle of
    // the picker flow. Picker confirms call `router.save()` which
    // both persists + re-renders, advancing through the queue.
    router.persist();
    renderHeroPickScreen(root, router);
    return;
  }

  try {
    ensureEncounter(router.state, activeQuest);
  } catch (err) {
    renderQuestNotYetWiredPlaceholder(root, router, activeQuest.name, err);
    return;
  }
  // Pre-wave picker phases (spawn-deck → first-turn-pick → hero)
  // own the transition into the hero phase via
  // `engine/encounter.ts > startWaveAfterPick` (compass-tile
  // commit) and `commitFirstTurnPick` (first-turn-delver commit).
  // `startHeroTurn` fires inside the latter, so DON'T fire it here
  // for any fresh-encounter that's still parked in a picker phase
  // — otherwise we'd set up turn 1 against the default
  // currentDelverId before the player has chosen, then SECOND-fire
  // `startHeroTurn` after Take First Turn — breaking the "fresh
  // encounter = one and only one startHeroTurn" invariant and
  // double-counting AP refresh.
  const liveEnc = router.state.encounter!;
  const isPreWavePick = liveEnc.phase === "delver-spawn-pick"
    || liveEnc.phase === "first-turn-pick";
  if (isFreshEncounter && !isPreWavePick) {
    startHeroTurn(router.state);
    logEvent("turn.start-fresh-encounter", {
      heroId: router.state.currentDelverId,
      ap: snapHeroAp(router.state, router.state.currentDelverId),
      elements: snapElements(router.state, router.state.currentDelverId),
    });
  }
  router.persist();

  // Auto-peek to the modal's deciding delver, if any (DESIGN.md §X
  // "Auto-peek to deciding delver"). Mutates `peekedDelverId` so the
  // right column tracks per-delver decisions like Level Up draws,
  // Supercharger / Battery rolls, element picks, and Sol/Lunar Shield
  // prompts. Returns the peek to the active delver when the queue
  // empties. Done BEFORE the wave-phase router check so the latch
  // also tears down when a per-delver modal closes during End Wave
  // (e.g. an Elemental OS end-of-wave grant).
  syncAutoPeekToModal(getModal(), router.state.encounter);

  // Wave-phase router. Anything other than the Hero Phase renders
  // one of the dedicated phase screens (DelverSpawnPick for spawn-
  // deck waves before the player commits compass tiles, then
  // Parting Shots / End Wave / End of Wave for in-wave transitions)
  // and bails — the hero-phase HTML below isn't relevant.
  const enc = router.state.encounter!;
  installRemoteSuitPickOpener(router);
  if (enc.phase === "delver-spawn-pick") {
    renderDelverSpawnPickScreen(root, router, enc);
    return;
  }
  if (enc.phase === "first-turn-pick") {
    renderFirstTurnPickScreen(root, router, enc);
    return;
  }
  if (enc.phase !== "hero") {
    renderWavePhaseScreen(root, router, enc);
    return;
  }

  const activeDelverId = router.state.currentDelverId;
  // Peek state lives on uiState (page-session, not persisted). `null`
  // means "view the active delver". `syncAutoPeekToModal` above may
  // have just forced this to the modal's decider.
  const peekedDelverId = getPeekedDelverId();
  const viewedDelverId = peekedDelverId ?? activeDelverId;
  const activeHero = getHero(activeDelverId);

  // Turn-start banner — fires once each time the active delver
  // flips (handed off via End Turn / auto-end-turn / End Wave).
  // Internally latches against `currentDelverId` so the common case
  // of "router.refresh() on the same turn" is a no-op. Kept here
  // (rather than inside endHeroTurn) so the engine stays UI-free.
  maybeShowTurnStartBanner(router.state, activeHero.suit);
  const viewedHero = getHero(viewedDelverId);
  const otherHero = HEROES.find((h) => h.id !== activeDelverId)!;
  const isPeeking = peekedDelverId !== null && peekedDelverId !== activeDelverId;

  // Per-delver parts counters for the topbar pill row. The
  // boss-part pill INTENTIONALLY collapses every level into one
  // count per the user's "for simplicity" call (2026-05-09).
  // Since v58 the wallets are level-aware (`bossParts` /
  // `bossPartsLvl2` / `bossPartsLvl3`) so the pill sums them via
  // `totalBossParts`; the per-level split shows in the Shop wallet
  // + Campaign Sheet where it matters for purchases. Icons use the
  // VIEWED delver's suit so the row matches the right-column
  // suit/hand whenever peek shifts (manual or auto-peek to a
  // modal's decider — DESIGN.md §6.2).
  const viewedMinionParts = router.state.minionParts[viewedDelverId] ?? 0;
  const viewedBossParts   = totalBossParts(router.state, viewedDelverId);
  const minionPartIcon = viewedHero.suit === "mind"
    ? "/tokens/minion-mind.webp"
    : "/tokens/minion-body.webp";
  // Boss icon is suit-flavored too; the `lvl-1-` prefix in the
  // filename is a holdover from the asset-pack naming. We do NOT
  // surface "lvl-1" in the counter label per the user's
  // simplification — every collected boss part folds into the
  // single Boss pill regardless of level.
  const bossPartIcon = viewedHero.suit === "mind"
    ? "/tokens/boss-lvl-1-mind.webp"
    : "/tokens/boss-lvl-1-body.webp";

  // XP and Level are SHARED resources (DESIGN.md §2-§3, rulebook p23-p24).
  // They do NOT change with the peek toggle, so we read them straight from
  // the campaign state without indexing by delver.
  const partyXp = router.state.xpOnHand;
  const partyLevel = router.state.currentLevel;
  const partyXpToNext = xpToNextLevel(partyXp, partyLevel);

  // Active-delver turn-state gates (DESIGN.md §4 / §5.7).
  const activeTurnState =
    router.state.encounter?.turnState[activeDelverId] ?? null;
  const hasPlacedThisTurn = activeTurnState?.cardPlacedThisTurn != null;
  const hasPreparedToRun = !!router.state.encounter?.preparedToRun[activeDelverId];
  // Level-up draws (rulebook p24) MUST be resolved before End Turn /
  // phase advance \u2014 they happen "now", interrupting the turn flow.
  // Same gate applies to pending element-pick prompts (Elemental OS,
  // see `engine/os.ts`): the player must resolve every queued element
  // grant before ending the turn.
  const pendingLevelUps = hasPendingLevelUpDraws(router.state);
  const pendingElementPicks = hasPendingElementChoices(router.state);
  const pendingEquipmentRolls = hasPendingEquipmentRolls(router.state);
  const pendingOpinionPicks = hasPendingOpinionRankPicks(router.state);
  // CREATURE PART picks (MINION vs BOSS — Gauntlet `collect-
  // creature-part`) follow the same gate semantics as the other
  // post-action queues: each pending token MUST resolve before
  // the turn flips so a count-of-N swing doesn't strand picks
  // across turn boundaries.
  const pendingCreaturePartPicks = hasPendingCreaturePartChoices(router.state);
  // XP die rolls ("Gain 1 [die] XP" on-death rewards) — same gate
  // semantics: the roll happens in front of the player before the
  // turn flips.
  const pendingXpRollsGate = hasPendingXpRolls(router.state);
  // End Turn is enabled when the active delver has finished their
  // mandatory turn-start choice (placed a card OR prepared to run)
  // OR when they've moved without placing — in which case tapping
  // End Turn opens the "Undo and submit" confirmation modal
  // (2026-05-21). Both paths are gated on no pending modal queues.
  const movedWithoutPlacing =
    !hasPlacedThisTurn
    && !hasPreparedToRun
    && (activeTurnState?.movementStepsThisTurn ?? 0) > 0;
  // UNDO MOVEMENT: shown once the active delver has stepped this turn
  // (until End Turn); greyed with the reason when the engine blocks it.
  const showUndoMovement =
    router.state.encounter?.phase === "hero" && (activeTurnState?.movementStepsThisTurn ?? 0) > 0;
  const undoMovementBlocked = showUndoMovement
    ? movementUndoBlockedReason(router.state, activeDelverId)
    : null;
  // End Turn is always available — players may pass their turn
  // without doing anything. The only hard blocks are pending
  // resolution queues that must be handled before the turn flips.
  const canEndTurn =
    (router.state.encounter?.pendingRitualPicks.length ?? 0) === 0 &&
    !pendingLevelUps &&
    !pendingElementPicks &&
    !pendingEquipmentRolls &&
    !pendingXpRollsGate &&
    !pendingOpinionPicks &&
    !pendingCreaturePartPicks;

  // "Turn fully done" highlight on the End Turn button — fires when
  // the active delver has nothing meaningful left to do but end
  // their turn. We light up green + add a vacillating pulse so the
  // player's eye is pulled to the obvious next click.
  //
  // Trigger when canEndTurn AND EITHER:
  //   - the action has been used AND movement is NOT still
  //     available (action-then-move is legal when no movement has
  //     been taken yet, so the End Turn pulse must NOT fire just
  //     because the action is used — it would steer the player
  //     past their remaining fresh-MP movement opportunity), OR
  //   - the delver is Prepared to Run (no hand → no placement / no
  //     action / no movement, the only legal exit is End Turn).
  //
  // "Movement still available" mirrors the gates in
  // `legalStepDestinations`: MP > 0, no `movementUsedThisTurn`
  // latch, not Prepared-to-Run. Movement is NO LONGER gated on
  // `cardPlacedThisTurn` (2026-05-21) — a player can step before
  // exhausting a card, so we don't gate the End Turn pulse on
  // placement either. The action-gates-REMAINING-movement rule is
  // captured at the moment the action fires (the action helper
  // auto-latches `movementUsedThisTurn` if movement was in-progress,
  // DESIGN.md §5.1.1), so checking `movementUsedThisTurn` alone is sufficient
  // here.
  const activeLoadoutForReady = router.state.loadouts[activeDelverId];
  const actionUsedFlag = activeTurnState?.actionUsedThisTurn === true;
  const movementSessionEnded = activeTurnState?.movementUsedThisTurn === true;
  const mpLeft = activeLoadoutForReady?.currentMovement ?? 0;
  const movementStillAvailable =
    !movementSessionEnded
    && mpLeft > 0
    && !hasPreparedToRun;
  const isTurnFullyDone =
    canEndTurn &&
    !movementStillAvailable &&
    (actionUsedFlag || hasPreparedToRun);

  // Cheatsheet reactivity: which "what to do next" lines pulse green.
  // Mirrors the same gates the rest of the UI uses so the cheatsheet
  // stays in lockstep with the action overlays.
  const actionUsed = actionUsedFlag;
  const moveUsed = movementSessionEnded;
  const cheatsheet: CheatsheetActive = {
    placeWeapon: !hasPlacedThisTurn && !hasPreparedToRun,
    useWeapon:   hasPlacedThisTurn && !actionUsed,
    // Movement is no longer gated on placement (2026-05-21) — the
    // player can step before exhausting a card. Prepared-to-Run
    // delvers can't move at all. The action-gates-REMAINING-movement
    // rule is captured in `movementUsedThisTurn` (auto-latched by
    // the action helper when the action interrupts an in-progress
    // session — DESIGN.md §5.1.1), so `!moveUsed` is the only gate we need
    // here to mirror `legalStepDestinations`.
    moveDelver:  !moveUsed && !hasPreparedToRun,
  };

  const wrap = document.createElement("div");
  // Chapter-id modifier (`screen--ch2`) lets the stylesheet swap the
  // default backdrop for an ambient underwater scene on Chapter 2
  // gameplay screens. Same class is applied by Story.ts (intro pages)
  // and TownVisit.ts (town-visit pages) so Chapter 2 reads
  // consistently across narrative + tactical screens.
  const chapterClass = activeQuest.id !== "quest1" ? " screen--ch2" : "";
  wrap.className = "screen screen--board" + chapterClass;
  // Read the in-progress wave's label from the active Quest data
  // rather than hard-coding "Quest #1, Wave 1" \u2014 otherwise a Q2
  // wave session displays the wrong label in the top bar.
  const activeWave =
    activeQuest.waves.find((w) => w.number === enc.waveNumber)
    ?? activeQuest.waves[0]!;
  const questNumberLabel = questDisplayLabel(activeQuest.id);
  // Hide the "Enemy Abilities" topbar button entirely when no
  // enemy in this wave has a printed passive ability — that's
  // Quest #1 today, where the modal would otherwise open to the
  // "no passive abilities in this wave" empty state, which is
  // more confusing than informative. See
  // `waveHasAnyEnemyAbilities` in EnemyAbilitiesModal.ts.
  const showEnemyAbilitiesBtn = waveHasAnyEnemyAbilities(enc);
  // Show the SHOP PRODUCTS button when either delver owns at least one product.
  const anyHeroHasShopProducts = HEROES.some(
    (h) => (router.state.shopProductsOwned[h.id]?.length ?? 0) > 0,
  );
  wrap.innerHTML = `
    <div class="board-topbar">
      <div class="board-topbar-goal">
        ${showEnemyAbilitiesBtn ? `<button class="btn btn--small btn--ghost board-topbar-enemy-abilities" data-action="enemy-abilities" title="View ability + parting-shot reference for every enemy in this wave.">Enemy Abilities</button>` : ""}
        <button class="btn btn--small btn--ghost board-topbar-rules" data-action="rules" title="Open the rulebook -- tap pages to flip through the rules for reference at any time.">RULES</button>
        ${anyHeroHasShopProducts ? `<button class="btn btn--small btn--ghost board-topbar-shop-products" data-action="shop-products" title="View your purchased Shop Products.">Shop Products</button>` : ""}
        ${renderAllyRedeemButtonsHtml(router.state)}
        <strong>${escapeHtml(questNumberLabel)}, Wave ${activeWave.number}</strong>
        ${renderCountdownPillHtml(router.state)}
        ${renderOmenPillHtml(router.state)}
        ${renderRitualPillHtml(router.state)}
        <span class="muted small"> &middot; ${escapeHtml(activeQuestGoalText(activeQuest, activeWave.number))}</span>
      </div>
      <div class="board-topbar-xp">
        <span class="xp-pill">
          <span class="xp-pill-label">XP On Hand</span>
          <span class="xp-pill-value">${partyXp}</span>
        </span>
        <span class="xp-pill">
          <span class="xp-pill-label">Level</span>
          <span class="xp-pill-value xp-pill-value--level">${partyLevel}</span>
        </span>
        <span class="xp-pill">
          <span class="xp-pill-label">XP to Next Level</span>
          <span class="xp-pill-value">${partyXpToNext}</span>
        </span>
      </div>
      <div class="board-topbar-actions">
        <span class="parts-pill-row" title="Parts collected by the ${escapeHtml(viewedHero.suit === "mind" ? "Mind" : "Body")} Delver (the delver currently shown on the right). Boss parts collapse every level into one count for display.">
          <span class="parts-pill parts-pill--minion" data-parts-wallet="minion">
            <img class="parts-pill-icon" src="${minionPartIcon}" alt="Minion part" draggable="false" />
            <span class="parts-pill-value">${viewedMinionParts}</span>
          </span>
          <span class="parts-pill parts-pill--boss" data-parts-wallet="boss">
            <img class="parts-pill-icon" src="${bossPartIcon}" alt="Boss part" draggable="false" />
            <span class="parts-pill-value">${viewedBossParts}</span>
          </span>
        </span>
        <span class="board-turn-indicator">
          Turn: <strong class="turn-${activeHero.suit}">${activeHero.suit === "mind" ? "Mind" : "Body"} Delver</strong>
          ${hasPreparedToRun ? `<span class="turn-pill turn-pill--prepared" title="No weapon cards left in hand - this delver is prepared to run for the rest of the wave.">Prepared to Run</span>` : ""}
        </span>
        <button class="btn btn--small btn--accent${isTurnFullyDone ? " btn--ready" : ""}" data-action="end-turn"${canEndTurn ? "" : " disabled"}${pendingLevelUps ? " title=\"Resolve pending Level Up draws first.\"" : ""}>End Turn</button>
        <button class="btn btn--small ${isPeeking ? "btn--primary" : "btn--ghost"}" data-action="peek">
          ${isPeeking
            ? `Back to ${activeHero.suit === "mind" ? "Mind" : "Body"} Delver`
            : `See other Delver`}
        </button>
        <button class="btn btn--small btn--ghost" data-action="back">Back to title</button>
      </div>
      ${renderAutoRefreshBanner()}
      ${renderTopbarStatusOverlay({ armedInstructionHtml: renderArmedInstruction(router.state) })}
    </div>
    <div class="board-cols">
      <main class="board-col board-col--board">
        <div class="board-frame" data-board-frame>
          <img class="board-bg" src="/board/tide.jpg" alt="Tide board" draggable="false" />
          <div class="board-moves" data-board-moves></div>
          <div class="board-targets" data-board-targets></div>
          <div class="board-witness-targets" data-board-witness-targets></div>
          <div class="board-tokens" data-board-tokens></div>
          <div class="board-fx" data-board-fx aria-hidden="true"></div>
          ${showUndoMovement
            ? `<button class="btn btn--undo-movement${undoMovementBlocked ? " btn--undo-movement-blocked" : ""}" data-action="undo-movement" aria-disabled="${undoMovementBlocked ? "true" : "false"}" title="${escapeHtml(undoMovementBlocked ?? "Put the delver back where this turn's movement started.")}">UNDO MOVEMENT</button>`
            : ""}
        </div>
      </main>
      <aside class="board-col board-col--right">
        <div class="suit-stack" data-col-suit></div>
        <div class="board-bottom-row">
          ${renderCombatRulesPanel(cheatsheet)}
          <div class="hand-stack" data-col-hand></div>
        </div>
      </aside>
    </div>
    <div class="card-modal" data-card-modal hidden>
      <div class="card-modal-backdrop" data-card-modal-backdrop></div>
      <div class="card-modal-body" data-card-modal-body></div>
    </div>
    <div class="action-modal" data-action-modal hidden></div>
  `;
  root.appendChild(wrap);

  // Right column renders against the *viewed* delver, not the active one.
  const colSuit = wrap.querySelector<HTMLDivElement>("[data-col-suit]")!;
  const colHand = wrap.querySelector<HTMLDivElement>("[data-col-hand]")!;
  renderSuitPanel(colSuit, viewedDelverId, router);
  renderHandPanel(colHand, viewedDelverId, router);

  // Tokens — read from the live encounter (delver positions move and
  // dead enemies disappear; spawn data is consulted only by ensureEncounter).
  const tokensLayer = wrap.querySelector<HTMLDivElement>("[data-board-tokens]")!;
  const tokens = buildEncounterTokens(router.state.encounter!);
  const modalLayer = wrap.querySelector<HTMLDivElement>("[data-card-modal]")!;
  const modalBody  = wrap.querySelector<HTMLDivElement>("[data-card-modal-body]")!;
  // When the weapon-counter-block-prompt is open, highlight the
  // matching enemy cards on the board so the player can visually
  // confirm which counterattackers their checkmarks correspond to.
  // Updated reactively because the modal calls `router.refresh()`
  // on every toggle.
  const activeModal = getModal();
  const counterBlockPreviewIds =
    activeModal?.kind === "weapon-counter-block-prompt"
      ? new Set(activeModal.picked)
      : undefined;
  renderTokens(
    tokensLayer,
    tokens,
    activeHero.suit,
    (token) => openCardModal(modalLayer, modalBody, token),
    counterBlockPreviewIds,
  );

  // Damage FX — diff this render's HP snapshot against the previous
  // render's, push events for any token that lost HP (or vanished
  // from the board while still alive), and paint a short splash on
  // each one. See `uiState.ts > detectDamageAndQueueFx` for the
  // diff semantics; CSS `.damage-fx*` rules drive the visuals.
  const fxLayer = wrap.querySelector<HTMLDivElement>("[data-board-fx]")!;
  const hpSnap = buildTokenHealthSnap(router.state);
  detectDamageAndQueueFx(hpSnap);
  renderDamageFx(fxLayer);
  // Enemy ability names floated over the tile whose ability just fired.
  fxLayer.insertAdjacentHTML("beforeend", renderAbilityProcFx());

  // Step-by-step movement flow (DESIGN.md §5.1):
  //   1. The active delver's tile shows a green "Click to Move" pulse
  //      while there's MP to spend — tap to ARM the movement session.
  //   2. Once armed, every 8-way adjacent walkable tile is highlighted
  //      as a step destination, and a floating "Moves left: N" badge
  //      anchors to the delver. The source tile flips to a brighter
  //      "tap to cancel" state.
  //   3. Tapping a destination steps the delver one tile, decrements
  //      MP by 1, fires per-tile pickup, and re-renders. The overlay
  //      recomputes adjacency from the new position; the player can
  //      keep stepping until MP hits 0 (engine auto-latches
  //      `movementUsedThisTurn`) or they tap their delver to disarm.
  //   4. Tap the source tile to disarm:
  //        - 0 steps taken so far → free disarm (can re-arm later)
  //        - 1+ steps taken AND MP remaining → NO-OP (stay armed).
  //          Previously this forfeited leftover MP via
  //          `endMovementStep`, but that was a major footgun: a
  //          stray/reflex tap on the delver after a partial step
  //          silently destroyed remaining moves. To commit position
  //          mid-session the player can take their action (which
  //          forfeits leftover MP per the action-gates-movement rule)
  //          or End Turn — both natural exits.
  //        - MP=0 path is unreachable here because the engine auto-
  //          latches `movementUsedThisTurn` on the exhausting step,
  //          which the defensive sync below clears `movementArmed`
  //          for, so the source overlay isn't rendered.
  //
  // Available only when the engine itself would actually return a
  // non-empty `legalStepDestinations`: active delver (peeking is
  // read-only), no ability currently armed (that flow takes
  // precedence), no modal open (counter-roll, level-up, AP-spend etc.
  // all gate input), AND the delver mustn't be flagged Prepared-to-
  // Run. Placement is NO LONGER a gate (2026-05-21): the player can
  // step before exhausting a card, so the source-tile "tap to move"
  // pulse must paint regardless of `cardPlacedThisTurn`. The End
  // Turn click handler then surfaces the "Undo and submit" /
  // "Go back" confirmation modal if the player tries to end after
  // moving without placing — see `topbar.end-turn-undo-prompt`
  // below.
  const movesLayer = wrap.querySelector<HTMLDivElement>("[data-board-moves]")!;
  // Action-gates-REMAINING-movement, refined 2026-05-18 (user repro
  // part 1: Body delver couldn't move after a Chain Gauntlet swing
  // even though they hadn't moved yet that turn; part 4:
  // action → AP-double-mov → step → step was blocked).
  //
  // The "did this action interrupt an in-progress movement session"
  // check now lives in the action helpers themselves (single source
  // of truth: `endMovementSessionIfActionInterruptsIt`), which
  // auto-latches `movementUsedThisTurn = true` in that case (no
  // exceptions, not even the +1 movement slot ability).
  //
  // Here in the UI we only need to mirror the lighter-weight
  // "should we paint the click-to-move source pulse" gate; the
  // actual destinations are computed by the engine via
  // `legalStepDestinations` (called below in the
  // `moveAvailable && !movementUsed` block).
  const moveAvailable =
    !isPeeking &&
    getArmedAbility() == null &&
    getModal() == null &&
    !hasPreparedToRun;
  const movementArmed = moveAvailable && getMovementArmed();
  // Defensive sync — if the engine has used movement (e.g. via an
  // ability that spends it) since we last armed, drop the armed flag
  // so the source pulse doesn't linger on a no-op tile.
  const ts = activeTurnState;
  const movementUsed = ts?.movementUsedThisTurn ?? false;
  if (movementArmed && movementUsed) setMovementArmed(false);

  if (moveAvailable && !movementUsed) {
    const reachable = legalStepDestinations(
      router.state,
      activeDelverId,
      activeWave.spawn.boardSize,
    );
    const sourcePos = router.state.encounter!.delverPositions[activeDelverId]!;
    const activeLoadout = router.state.loadouts[activeDelverId]!;
    const movesLeft = activeLoadout.currentMovement;
    // "Has the player stepped at least once this turn?" — needed so a
    // 0-step disarm stays free (per the session-lock rule confirmed
    // 2026-05-09: only a session that actually consumed MP locks out
    // re-arming this turn). We read the explicit step counter from
    // turnState rather than `currentMovement < baseMovement` because
    // AP-double-movement and `+1 mov` slot abilities push the
    // starting MP above `baseMovement`, so the comparison would
    // wrongly report "no steps yet" after the first step.
    const hasSteppedThisTurn = (activeTurnState?.movementStepsThisTurn ?? 0) > 0;
    renderMovementOverlay(
      movesLayer,
      sourcePos,
      reachable,
      movementArmed,
      movesLeft,
      // Source-tile click toggles the armed gate, with one critical
      // exception: a click during a partial-stepped session that
      // still has MP left is a NO-OP. See the long comment block
      // above — this used to silently forfeit remaining MP via
      // `endMovementStep` and was the dominant accidental-loss
      // scenario in playtests.
      () => {
        const next = !movementArmed;
        const isPartialSessionWithMP = movementArmed && hasSteppedThisTurn && movesLeft > 0;
        logEvent("click.movement-source", {
          armed: isPartialSessionWithMP ? true : next,
          hasSteppedThisTurn,
          movesLeft,
          ignored: isPartialSessionWithMP,
        });
        if (isPartialSessionWithMP) {
          // Stay armed; do nothing. Player keeps the option to step
          // to a remaining adjacent tile or commit position by
          // taking their action / ending the turn.
          return;
        }
        setMovementArmed(next);
        router.refresh();
      },
      // Destination click steps the delver one tile and stays armed
      // (until the engine auto-latches `movementUsedThisTurn` on
      // MP = 0, which the next render will see and clear the flag).
      (x, y) => {
        logEvent("click.movement-dest", { heroId: activeDelverId, x, y });
        const result = moveDelverStep(
          router.state,
          activeDelverId,
          x, y,
          activeWave.spawn.boardSize,
        );
        logEvent("engine.moveDelverStep", {
          heroId: activeDelverId,
          x, y,
          result: result.ok ? "ok" : `fail:${result.reason}`,
          movementRemaining: result.ok ? result.movementRemaining : null,
          sessionEnded: result.ok ? result.sessionEnded : null,
          pickups: result.ok ? result.pickups.length : 0,
          turn: snapTurn(router.state, activeDelverId),
        });
        if (!result.ok) return;
        // Fly any picked-up creature parts to the topbar wallet
        if (result.pickups.length > 0) {
          const minionCount = result.pickups.filter(p => p.dropId === "minion-part").length;
          const bossCount   = result.pickups.filter(p => p.dropId.startsWith("boss-part")).length;
          const viewedId = getPeekedDelverId() ?? router.state.currentDelverId;
          const suit = (HEROES.find(h => h.id === viewedId) ?? HEROES[0]!).suit;
          flyTilePickupsToWallet(x, y, minionCount, bossCount, suit);
        }
        // MP exhausted — engine has already latched
        // `movementUsedThisTurn`. Drop the armed flag locally so the
        // source pulse doesn't linger; defensive sync above also
        // handles this on the next render, but doing it here keeps
        // the click-to-render frame clean.
        if (result.sessionEnded) setMovementArmed(false);
        // If movement + action are both spent, auto-end the turn (single
        // save inside the helper); otherwise persist + repaint.
        if (!maybeAutoEndTurn(router)) router.save();
      },
    );
  }

  // Action target overlay (Slice 4c). Painted only when an ability is
  // armed and no modal is open — see ActionResolution.ts for the rules.
  const targetsLayer = wrap.querySelector<HTMLDivElement>("[data-board-targets]")!;
  renderActionTargets(targetsLayer, router);

  // Witness "Move up to 2 tiles" destination overlay (rulebook Q2+
  // companion; engine in `engine/witness.ts`). Painted only while
  // the `witness-move` modal is open — `renderWitnessMoveTargets`
  // is a no-op for any other modal kind / no modal. Lives in its
  // own layer below the action targets so a Witness step picker
  // doesn't fight a stray weapon-target overlay for the same z-band.
  const witnessTargetsLayer = wrap.querySelector<HTMLDivElement>("[data-board-witness-targets]")!;
  renderWitnessMoveTargets(witnessTargetsLayer, router);

  // Auto-open the Opinion-Card rank pick modal at quest start
  // whenever the pick queue has entries and nothing else is open.
  // Same pattern the action-modal uses for any "must resolve
  // before progressing" queue (level-up, element-pick) — without
  // an auto-open the player would see an empty BoardScreen with
  // no obvious way to clear the gated Start-Turn buttons. Calling
  // setModal eagerly is safe because renderActionModal below
  // re-reads via getModal().
  if (
    hasPendingOpinionRankPicks(router.state) &&
    getModal() == null
  ) {
    setModal({ kind: "opinion-rank-pick" });
  }

  // Auto-open the Scenario Card modal at wave start whenever
  // `state.currentScenarioCard` is set and nothing else is open.
  // Mirrors the opinion-rank-pick auto-open pattern above —
  // `bootstrapWaveAtNumber` sets `currentScenarioCard` on a
  // wave that has `scenarioCardOnStart` declared, then the next
  // BoardScreen render lands here and mounts the modal over the
  // freshly-built board. A reload mid-modal also flows through
  // this path because `currentScenarioCard` lives at campaign
  // scope (persisted) so the in-flight card survives the page
  // reload.
  if (
    router.state.currentScenarioCard != null &&
    getModal() == null
  ) {
    setModal({ kind: "scenario-card" });
  }

  // Ch3+ mid-wave story entry (`wave.onBossSlain`): the boss just died,
  // its rewards are already applied — show the entry, then the rewards.
  const questEntry = router.state.encounter?.pendingQuestEntry;
  if (questEntry && getModal() == null && !document.querySelector(".quest-entry-overlay")) {
    void presentQuestEntry(router, questEntry);
  }

  // Auto-open the Friendly Encounter modal whenever a delver or
  // Witness has picked up a Friendly Encounter token and the
  // queue has entries waiting to resolve. Same auto-open
  // pattern as the scenario card / opinion-rank-pick paths -- a
  // reload mid-pickup still surfaces the unresolved encounter
  // because `pendingFriendlyEncounters` lives at campaign
  // scope (persisted to localStorage).
  if (
    router.state.pendingFriendlyEncounters.length > 0 &&
    getModal() == null
  ) {
    setModal({ kind: "friendly-encounter" });
  }

  // Auto-open the element-pick modal whenever there are pending
  // per-delver element choices — e.g. from a Scenario Card's
  // "grant-element-choice-each" effect. The scenario card modal
  // closes first, then BoardScreen re-renders and lands here.
  // Mirrors the friendly-encounter / scenario-card auto-open pattern.
  if (
    hasPendingElementChoices(router.state) &&
    getModal() == null
  ) {
    setModal({ kind: "element-pick" });
  }

  // Auto-open the suit-condition rank pick modal whenever there are
  // pending picks enqueued by a Scenario Card's
  // `grant-equipment-rank-one-delver` effect. The scenario card modal
  // closes first, then BoardScreen re-renders and lands here — mirrors
  // the element-pick auto-open pattern above.
  if (
    hasPendingSuitConditionRankPicks(router.state) &&
    getModal() == null
  ) {
    setModal({ kind: "suit-condition-rank-pick" });
  }

  // Auto-open the LEVEL UP modal whenever there are pending draws
  // queued on the current encounter — e.g. from a Scenario Card's
  // `grant-level-up-card` effect (cards #02-B, #04-A, #06-B, #07-A
  // outcome 3-6, #08-B, #B-B today). The scenario card modal closes
  // first, then BoardScreen re-renders and lands here. Mirrors the
  // suit-condition-rank-pick auto-open above. Attack-driven level-ups
  // (XP-to-level transitions inside `applyPendingLevelUps`) still
  // open the modal directly from `advanceAfterAction` so the player
  // sees it without a board re-render in between — this auto-open
  // is the catch-net for any path that lands draws OUTSIDE the
  // attack-resolution pipeline.
  if (
    hasPendingLevelUpDraws(router.state) &&
    getModal() == null
  ) {
    setModal({ kind: "level-up" });
  }

  // Auto-open the scenario-delver-pick modal whenever scenario card
  // effects have queued per-delver resource picks. Drains
  // `state.pendingScenarioDelverPicks` one entry at a time; each pick
  // requires the player to choose which delver gains the token / AP
  // or loses the HP. Same auto-open pattern as suit-condition-rank-pick.
  if (
    router.state.pendingScenarioDelverPicks.length > 0 &&
    getModal() == null
  ) {
    setModal({ kind: "scenario-delver-pick" });
  }

  // Auto-open the equipment-roll modal for quest-start passive rolls
  // (Supercharger / Battery). These are enqueued by
  // `applyEquipmentRollsForQuest` when the encounter is first built
  // and must be resolved before the player can end their turn. Fires
  // immediately on board entry if a roll is waiting — same pattern
  // as the element-pick auto-open above.
  if (
    hasPendingEquipmentRolls(router.state) &&
    getModal() == null
  ) {
    const head = peekNextPendingEquipmentRoll(router.state);
    if (head) {
      setModal({ kind: "equipment-roll", heroId: head.heroId, cardId: head.cardId });
    }
  }

  // Auto-open the XP die-roll modal ("Gain 1 [die] XP" on-death
  // rewards). Normally opened by `advanceAfterAction` right after
  // the kill, but a mid-queue refresh / save-reload lands here —
  // same recovery pattern as the equipment-roll auto-open above.
  if (
    hasPendingXpRolls(router.state) &&
    getModal() == null
  ) {
    const head = peekNextPendingXpRoll(router.state);
    if (head) {
      setModal({ kind: "xp-roll", heroId: head.heroId, enemyCardId: head.enemyCardId });
    }
  }

  // Action modal (action-menu / die-roll / counter-roll / etc).
  const actionModalLayer = wrap.querySelector<HTMLDivElement>("[data-action-modal]")!;
  renderActionModal(actionModalLayer, router);

  // Cancel-armed button + any other topbar action wires owned by
  // ActionResolution.
  wireActionTopbarButtons(wrap, router);

  // Modal close: click backdrop. Escape close + the `~` debug-panel
  // toggle live on a SINGLETON document keydown handler installed
  // by `installBoardKeydownListener` (every BoardScreen render
  // re-publishes its current router + modalLayer to the shared
  // closure). Pre-singleton this listener was added per render and
  // accumulated, which doubled the toggle's effect every render.
  const closeModal = () => modalLayer.setAttribute("hidden", "");
  wrap.querySelector<HTMLDivElement>("[data-card-modal-backdrop]")!
    .addEventListener("click", closeModal);
  installBoardKeydownListener(router, modalLayer);
  installRemoteResumeListener(router);
  installEquipmentZoomListener();

  // --- Top-bar actions --------------------------------------------------
  wrap.querySelector<HTMLButtonElement>("[data-action=back]")!
    .addEventListener("click", () => {
      logEvent("topbar.back-to-title");
      clearPeek();
      router.goTo({ name: "title" });
    });

  wrap.querySelector<HTMLButtonElement>("[data-action=peek]")!
    .addEventListener("click", () => {
      const next = isPeeking ? null : otherHero.id;
      logEvent("topbar.peek", { peekedDelverId: next });
      setPeekedDelverId(next);
      router.save();
    });

  // The button may be omitted (waves with no enemy abilities —
  // see the `showEnemyAbilitiesBtn` gate where the HTML is
  // emitted). Skip wiring when the element isn't in the DOM.
  wrap.querySelector<HTMLButtonElement>("[data-action=enemy-abilities]")
    ?.addEventListener("click", () => {
      const waveLabel = `${questNumberLabel}, Wave ${activeWave.number}`;
      logEvent("topbar.enemy-abilities", { questId: activeQuest.id, waveNumber: activeWave.number });
      void presentEnemyAbilities(document.body, router.state.encounter!, waveLabel);
    });

  // RULES button — opens the bundled rulebook flipbook (see
  // `RulesViewerModal`). Always starts on page 1 since the page
  // cursor lives on uiState and resets to 1 each time the modal
  // is opened fresh from the topbar.
  wrap.querySelector<HTMLButtonElement>("[data-action=rules]")
    ?.addEventListener("click", () => {
      logEvent("topbar.rules", { questId: activeQuest.id, waveNumber: activeWave.number });
      setModal({ kind: "rules-viewer", pageNumber: 1 });
      router.refresh();
    });

  // SHOP PRODUCTS button — opens the owned-products viewer for the
  // delver who has products. If the viewed delver has products, show
  // theirs; otherwise fall back to the other delver who must have
  // products (since the button is only rendered when at least one
  // delver owns something).
  wrap.querySelector<HTMLButtonElement>("[data-action=shop-products]")
    ?.addEventListener("click", () => {
      const viewedOwned = router.state.shopProductsOwned[viewedDelverId] ?? [];
      const { heroId: targetHeroId, label: targetLabel } =
        viewedOwned.length > 0
          ? { heroId: viewedDelverId, label: getHero(viewedDelverId).suit === "mind" ? "Mind Delver" : "Body Delver" }
          : { heroId: otherHero.id, label: otherHero.suit === "mind" ? "Mind Delver" : "Body Delver" };
      const ownedNumbers = router.state.shopProductsOwned[targetHeroId] ?? [];
      logEvent("topbar.shop-products", { heroId: targetHeroId, ownedCount: ownedNumbers.length });
      void presentShopProducts(document.body, { delverLabel: targetLabel, ownedProductNumbers: ownedNumbers });
    });

  // Rodrigo / Elayna Ally redeem buttons — only present while the
  // card is owned + unspent. Disabled state is baked into the HTML by
  // `renderAllyRedeemButtonsHtml`, so a disabled click never fires.
  wrap.querySelectorAll<HTMLButtonElement>("[data-action=witness-ability]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode as WitnessAbilityMode;
      logEvent("topbar.witness-ability", { mode });
      useWitnessAbility(router.state, mode);
      router.save();
    });
  });
  wrap.querySelectorAll<HTMLButtonElement>("[data-action=overcharge]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dt = btn.dataset.damageType as "light" | "medium" | "heavy";
      const res = overcharge(router.state, router.state.currentDelverId, dt);
      if (!res.ok) throw new Error(`overcharge rejected: ${res.reason}`);
      router.save();
    });
  });
  wrap.querySelector<HTMLButtonElement>("[data-action=redeem-rodrigo]")
    ?.addEventListener("click", () => {
      logEvent("topbar.redeem-rodrigo", { spentTokensBefore: countSpentTokens(router.state) });
      const err = redeemRodrigoAlly(router.state);
      if (err) throw new Error(`redeemRodrigoAlly rejected: ${err.code}`);
      router.save();
    });
  wrap.querySelector<HTMLButtonElement>("[data-action=redeem-elayna]")
    ?.addEventListener("click", () => {
      logEvent("topbar.redeem-elayna", { missingHpBefore: missingHp(router.state) });
      const err = redeemElaynaAlly(router.state);
      if (err) throw new Error(`redeemElaynaAlly rejected: ${err.code}`);
      router.save();
    });

  wrap.querySelector<HTMLButtonElement>("[data-action=undo-movement]")
    ?.addEventListener("click", () => {
      const heroId = router.state.currentDelverId;
      const blocked = movementUndoBlockedReason(router.state, heroId);
      if (blocked) {
        alert(`Can't undo movement: ${blocked}`);
        return;
      }
      const steps = router.state.encounter?.turnState[heroId]?.movementStepsThisTurn ?? 0;
      undoMovementThisTurn(router.state, heroId);
      logEvent("topbar.undo-movement", { heroId, steps });
      router.save();
    });

  wrap.querySelector<HTMLButtonElement>("[data-action=end-turn]")!
    .addEventListener("click", () => {
      if (!canEndTurn) return;
      const heroId = router.state.currentDelverId;
      // Moved-but-no-placement guard (2026-05-21): movement may
      // precede placement, but a player who taps End Turn after
      // moving without placing is most likely tapping End Turn by
      // mistake. Open the confirmation modal — "Undo and submit"
      // calls `undoMovementThisTurn` then ends the turn; "Go Back"
      // closes the modal and lets the player place a card / keep
      // moving. Modal is ephemeral UI state, so a reload while it's
      // open defaults to "Go Back" naturally.
      if (movedWithoutPlacing) {
        logEvent("topbar.end-turn-undo-prompt", {
          heroId,
          movementSteps:
            router.state.encounter?.turnState[heroId]
              ?.movementStepsThisTurn ?? 0,
        });
        setModal({ kind: "end-turn-undo-prompt" });
        router.refresh();
        return;
      }
      // Idle end-turn: player did nothing this turn — no movement,
      // no card placed, no action, not already prepared. Implicitly
      // treat this as "Prepare to Run". When both delvers pass in
      // sequence the existing `bothPrepared` check inside
      // `endHeroTurn → maybeEnterPartingShotsAfterTurn` advances
      // the phase to Parting Shots automatically.
      const didNothing =
        !hasPlacedThisTurn &&
        !hasPreparedToRun &&
        !actionUsedFlag &&
        !movementSessionEnded;
      if (didNothing) {
        prepareToRun(router.state, heroId);
      }
      logEvent("topbar.end-turn", {
        heroId,
        ap: snapHeroAp(router.state, heroId),
        turn: snapTurn(router.state, heroId),
      });
      commitManualEndTurn(router);
    });

  // (Session-log panel toggle previously lived here as a topbar
  // "Log" button. Removed 2026-05-20 — the `~` key shortcut is the
  // primary access point, installed globally at app load by
  // `installGlobalSessionLogPanel`. The panel mount also lives on
  // `document.body` independently so it still survives screen swaps.)

  // Auto-refresh banner dismiss button (DESIGN.md §4.3).
  const dismissBtn = wrap.querySelector<HTMLButtonElement>("[data-action=dismiss-auto-refresh]");
  if (dismissBtn) {
    dismissBtn.addEventListener("click", () => {
      clearLastAutoRefresh();
      router.refresh();
    });
  }

  // (Pending-Level-Up topbar pill removed 2026-05-20 — the Level
  // Up modal auto-opens on pending draws and can't be dismissed
  // without resolving, so the click-to-reopen pill had no use case.
  // See `renderTopbarStatusOverlay` for the related render-side
  // cleanup.)


  // Background-click deselect: clicking on empty space (anywhere
  // on the board screen that isn't a card, slot, board target,
  // button, modal, etc.) clears the active delver's currently
  // selected equipment card. Mirrors the deselect-on-board-tap
  // behaviour of physical play.
  //
  // Implementation: a single click listener on `wrap` that walks
  // up from `event.target` via `closest()` looking for any known
  // interactive selector. If none match, the click is treated as
  // "background" and the active hero's selection is cleared.
  //
  // The exclusion list captures every clickable game element on
  // this screen. If a new interactive element is added without
  // being listed here, the worst-case is an extra deselect call
  // when it's clicked — annoying but not destructive (the
  // element's own click handler still runs first, and clearing
  // an already-null selection is a no-op).
  //
  // Modal gate: when any modal is open the modal owns the click
  // surface (its backdrop / dialog handles dismiss + actions);
  // we bail out so background-click semantics don't fight modal
  // semantics.
  const INTERACTIVE_DESELECT_EXCLUSIONS = [
    ".hand-card",
    ".suit-slot",
    ".board-tile",
    ".board-move-target",
    ".board-move-source",
    ".board-target",
    ".board-witness-target",
    ".card-modal",
    ".action-modal",
    ".rewards-modal",
    ".action-menu",
    ".action-menu-backdrop",
    "button",
    "a",
    "input",
    "select",
    "textarea",
  ].join(", ");
  wrap.addEventListener("click", (event) => {
    if (getModal() !== null) return;
    const target = event.target as HTMLElement | null;
    if (target && target.closest(INTERACTIVE_DESELECT_EXCLUSIONS)) return;
    const heroId = router.state.currentDelverId;
    if (getSelectedCard(heroId) === null) return;
    logEvent("ui.cardSelection.deselect.background", { heroId });
    clearSelectedCard(heroId);
    router.save();
  });
}

// --- Singleton document-level keydown listener ------------------------------
//
// Pre-singleton, BoardScreen added a fresh `keydown` listener on
// every render and never removed any of them. For the Escape-close
// behaviour that was a benign no-op on the second-and-after
// invocations (the modal was already hidden), but for any TOGGLE
// behaviour (e.g. the `~` debug-log toggle) it would flip state N
// times per keypress where N = number of renders, leaving an
// unpredictable net result.
//
// The fix: install the listener exactly once (on first BoardScreen
// render) and have every subsequent render REPUBLISH its current
// router + modalLayer into a shared mutable ref. The listener
// closes over the ref, not the per-render values, so it always
// acts on the latest screen state.

// --- Singleton equipment-card right-click zoom listener ---------------------
//
// Mounted once on `document` (mirrors the keydown singleton's
// install-on-first-render pattern). Maintains a single
// "currently zoomed" element reference so right-clicks toggle
// the zoom across renders.
//
// Affordance: right-click an equipment card (in-hand `.hand-card`
// or placed `.suit-slot--filled`) to magnify it for reading.
// Right-click the SAME card again, right-click any non-equipment
// surface, left-click anywhere, or press Escape to dismiss. Enemy
// cards (`.board-tile`) are intentionally untouched — they keep
// their original hover-to-zoom behaviour per user request
// 2026-05-20.
//
// Re-render durability: the reference may point at a detached
// element after BoardScreen rebuilds the DOM. We guard with
// `isConnected` before touching it; a detached node is treated
// the same as null. The `.equipment-card--zoomed` class itself
// is naturally cleared on re-render (HTML is rebuilt from
// scratch), so the zoom dismisses automatically the moment the
// player takes any action that triggers a save/refresh — which
// is the desired UX anyway.
let equipmentZoomInstalled = false;
let zoomedEquipmentEl: HTMLElement | null = null;
const EQUIPMENT_CARD_SELECTOR = ".hand-card, .suit-slot--filled";

function clearEquipmentZoom(): void {
  if (zoomedEquipmentEl && zoomedEquipmentEl.isConnected) {
    zoomedEquipmentEl.classList.remove("equipment-card--zoomed");
  }
  zoomedEquipmentEl = null;
}

function setEquipmentZoom(el: HTMLElement): void {
  if (zoomedEquipmentEl === el) return;
  clearEquipmentZoom();
  zoomedEquipmentEl = el;
  el.classList.add("equipment-card--zoomed");
}

function installEquipmentZoomListener(): void {
  if (equipmentZoomInstalled) return;
  equipmentZoomInstalled = true;

  document.addEventListener("contextmenu", (event) => {
    const target = event.target as HTMLElement | null;
    const card = target?.closest<HTMLElement>(EQUIPMENT_CARD_SELECTOR) ?? null;
    if (!card) {
      // Right-click outside any equipment card dismisses an
      // active zoom (if any). We DO NOT preventDefault here —
      // the browser context menu is still useful on non-game
      // surfaces (and the default-context-menu suppression for
      // enemy cards is explicitly out of scope per user spec).
      clearEquipmentZoom();
      return;
    }
    // Right-click on an equipment card: suppress the browser
    // context menu and toggle the zoom on the clicked card.
    event.preventDefault();
    if (zoomedEquipmentEl === card) {
      clearEquipmentZoom();
    } else {
      setEquipmentZoom(card);
    }
  });

  // Left-click anywhere dismisses the zoom. Listener is in the
  // bubble phase so per-element click handlers (card selection,
  // slot placement, etc.) still get their first crack at the
  // event; we just clean up the zoom afterwards.
  document.addEventListener("click", () => {
    clearEquipmentZoom();
  });

  // Escape as the keyboard dismiss. Note: the board's existing
  // keydown singleton ALSO handles Escape (it hides the modal
  // layer); both can fire and they don't conflict — modal hide
  // is a no-op when no modal is open, and clearing an already-
  // cleared zoom is a no-op too.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") clearEquipmentZoom();
  });
}

// --- Online: resume the flow after the other player's choice ---------------
//
// Online co-op (design owner 2026-11-15): when a queued choice belongs to
// the other delver (their level-up card, element pick, roll, ...), their
// player makes it on their own screen and the flow pauses here. Once the
// shared state comes back and it's this player's move again, continue the
// post-action queue (`advanceAfterAction`: the next prompt, a Soulshift /
// Beam repeat, or the auto End Turn), which needs this client's attack
// session.

/** Queued per-delver choice modals (see `net/roles.ts > pendingChoiceOwner`). */
const QUEUED_CHOICE_MODALS: ReadonlySet<Modal["kind"]> = new Set<Modal["kind"]>([
  "level-up", "element-pick", "opinion-rank-pick", "equipment-roll", "xp-roll",
  "creature-part-pick", "ritual-pick", "suit-condition-rank-pick",
]);

let remoteResumeInstalled = false;
let remoteResumeRouter: Router | null = null;

function installRemoteResumeListener(router: Router): void {
  remoteResumeRouter = router;
  if (remoteResumeInstalled) return;
  remoteResumeInstalled = true;
  document.addEventListener(REMOTE_APPLIED_EVENT, () => {
    const r = remoteResumeRouter;
    if (!r || !document.querySelector(".screen--board")) return;
    if (r.state.encounter?.phase !== "hero") return;
    const m = getModal();
    if (!m || !QUEUED_CHOICE_MODALS.has(m.kind)) return;
    if (!onlineIsActorNow()) return;
    logEvent("online.resume-after-remote-choice", { modal: m.kind });
    advanceAfterAction(r);
  });
}

let boardKeydownInstalled = false;
let boardKeydownTarget: { router: Router; modalLayer: HTMLDivElement } | null = null;

function installBoardKeydownListener(router: Router, modalLayer: HTMLDivElement): void {
  boardKeydownTarget = { router, modalLayer };
  if (boardKeydownInstalled) return;
  boardKeydownInstalled = true;
  document.addEventListener("keydown", (e) => {
    if (!boardKeydownTarget) return;
    const { router: r, modalLayer: m } = boardKeydownTarget;
    if (e.key === "Escape" && !m.hasAttribute("hidden")) {
      // End-Turn confirmation prompt is cancel-less by design — the
      // player must explicitly pick "Undo and submit" or "Go Back"
      // (2026-05-21). Escape would otherwise dismiss the prompt as
      // an implicit "Go Back", but we want both options to be
      // surfaced as deliberate clicks so the player doesn't
      // accidentally end their turn by reflexively tapping Escape.
      if (getModal()?.kind === "end-turn-undo-prompt") return;
      m.setAttribute("hidden", "");
      return;
    }
    // Note: the `~` (backtick / tilde) toggle for the session log
    // panel used to live here. It's now installed globally by
    // `installGlobalSessionLogPanel` (called from `main.ts` at app
    // load) so the panel toggle works on EVERY screen, not just
    // BoardScreen. A duplicate handler here would double-toggle and
    // net to no-op, so it's been removed.

    // W / L debug keys — win / lose the current wave (rules live in
    // `engine/debugCommands.ts`). Only while a quest encounter exists
    // (the listener is a singleton that outlives the board, so title /
    // town screens must not react) and never while typing. Any press
    // inside a quest but outside the Hero Phase alerts the engine's
    // error. Mutates via the engine, then `router.save()` so the online
    // commit gate applies like any other move.
    const key = e.key.toLowerCase();
    if (key !== "w" && key !== "l") return;
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || !r.state.encounter) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    try {
      if (key === "w") debugKeyWinWave(r.state);
      else debugKeyLoseWave(r.state);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEvent("debug.key-wave.error", { key, message });
      alert(`Debug ${key.toUpperCase()} key failed:\n${message}`);
      return;
    }
    r.save();
  });
}

/**
 * Render the "Refreshed!" banner that appears immediately after a
 * card was returned to hand outside the normal turn loop. Two
 * flavors share the same banner channel:
 *
 *   - element-stack (DESIGN.md §4.3.2) — placement spent 2 stacked
 *     element tokens of the slot's printed element.
 *   - ap-spend (DESIGN.md §4.3.1) — player paid 2 AP from the
 *     AVAILABLE-box menu to recover an exhausted slot. Without this
 *     banner the player can mistake "slot empty + new mandatory-
 *     placement prompt" for "nothing happened, AP wasn't spent" —
 *     the bug report from 2026-05-09.
 *
 * Dismissed by the player's next placement, by End Turn, or by the
 * close button.
 *
 * Returns an empty string when there is no auto-refresh to surface.
 */
function renderAutoRefreshBanner(): string {
  const t = getLastAutoRefresh();
  if (!t) return "";
  const detail = t.reason === "element-stack"
    ? `returned to hand - spent 2 ${escapeHtml(t.element)} elements`
    : `returned to hand - spent ${t.apSpent} AP`;
  return `
    <div class="auto-refresh-banner" role="status" aria-live="polite">
      <span class="auto-refresh-banner-pill">REFRESHED</span>
      <strong>${escapeHtml(t.cardName)}</strong>
      <span class="muted">${detail}</span>
      <button class="auto-refresh-banner-close" data-action="dismiss-auto-refresh" title="Dismiss">\u00d7</button>
    </div>
  `;
}

/**
 * Conditional-status overlay row that floats just below the topbar
 * (absolute positioned, anchored to `.board-topbar`, see
 * `.topbar-status-overlay` in styles.css). Holds:
 *
 *   1. The pending-Level-Up button (clickable pill that re-opens the
 *      modal when the player has unresolved level-up draws).
 *   2. The "ability armed" instruction banner (text + Cancel button).
 *
 * Pre-2026-05-09 both lived inline inside `.board-turn-indicator`.
 * Long instruction strings ("Pick an enemy adjacent to the OTHER
 * delver to start the chain.") wrapped the topbar onto a second
 * line and shrunk the playable board area underneath. Pulling them
 * into an absolute-positioned overlay decouples their visibility
 * from the column-flex sizing entirely (same pattern as
 * `.auto-refresh-banner`).
 *
 * Returns an empty string when nothing needs to be surfaced so the
 * overlay's empty wrapper isn't paid for.
 */
function renderTopbarStatusOverlay(args: {
  armedInstructionHtml: string;
}): string {
  const { armedInstructionHtml } = args;
  // 2026-05-20: the pending-level-up "click to resolve" pill was
  // removed at user request — the Level Up modal already auto-
  // opens whenever there are pending draws, and the redundant
  // top-bar CTA was noisy chrome with no use case (the modal
  // can't be dismissed without resolving, so the player is never
  // left looking for a way back in).
  if (!armedInstructionHtml) return "";
  return `
    <div class="topbar-status-overlay" role="status" aria-live="polite">
      ${armedInstructionHtml}
    </div>
  `;
}

// --- Token rendering ------------------------------------------------------

function renderTokens(
  layer: HTMLDivElement,
  tokens: BoardToken[],
  activeSuit: "mind" | "body",
  onEnemyClick: (token: BoardToken) => void,
  /**
   * Optional set of enemy instance ids that should be visually
   * highlighted as "preview targets" — currently driven by the
   * weapon-counter-block-prompt modal (Trident / Shockwave) so the
   * player can see WHICH enemy cards on the board correspond to the
   * checkmarks they've ticked in the prompt. Applied as a
   * `board-tile--counter-block-preview` class on the matching
   * enemy tile.
   */
  counterBlockPreviewIds?: ReadonlySet<string>,
): void {
  layer.innerHTML = "";

  // Group tokens by (col,row) so stacked delvers can offset slightly.
  const byCell = new Map<string, BoardToken[]>();
  for (const t of tokens) {
    const key = `${t.col},${t.row}`;
    const arr = byCell.get(key) ?? [];
    arr.push(t);
    byCell.set(key, arr);
  }

  for (const t of tokens) {
    const stackmates = byCell.get(`${t.col},${t.row}`)!;
    const { left, top } = cellCenterPct(t.col, t.row);

    // Fan-out for stacked HUMANOID tokens (delvers + the Witness
    // companion). Enemies / drops / memory fragments stay centred.
    //
    // Layouts (per total mates on a tile):
    //   1 → centred (no offset).
    //   2 → side-by-side, edge-to-edge (`HUMANOID_FAN_PCT` each side
    //        of the cell centre).
    //   3 → 2x2 grid with one slot empty: idx 0 + 1 on the top row,
    //        idx 2 centred on the bottom row. Keeps all three chips
    //        inside the printed cell rim. With the canonical token
    //        order (Mind delver, Body delver, Witness) this puts
    //        M + B on top and W centred below — matching the
    //        screenshot proportions.
    //   4+ → fall back to the linear horizontal fan; only humanoid
    //        kind today is delvers + Witness so this is defensive.
    //
    // Both axes use `CELL_SIZE_PCT * HUMANOID_FAN_PCT` (≈ token
    // radius) so chips on the top row sit edge-to-edge horizontally
    // AND the bottom-row chip sits clear of the top row vertically.
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

    if (t.kind === "drop") {
      // Tile drop (monster part). Renders as a small icon centred on
      // the tile, fanned horizontally and symmetrically around the
      // centre when more than one drop sits on the same tile (e.g.
      // one per delver after a kill). Drops sit on tiles AFTER the
      // enemy is dead and the card has been removed (`alive: false`
      // gates the enemy render path), so the centre is free real
      // estate — the top-right HP heart overlay and the centred
      // delver token only collide here if the same tile is also
      // currently occupied by a delver, which only happens AFTER
      // the same delver has walked over and triggered pickup, so the
      // drop is already gone.
      const dropMates = stackmates.filter((m) => m.kind === "drop");
      const dropIdx = dropMates.indexOf(t);
      const dropTotal = dropMates.length;
      const DROP_SIZE_PCT = CELL_SIZE_PCT * 0.22;
      // Fan-out distance per slot — slightly smaller than the icon
      // width so the icons overlap a little (looks like a pile).
      const fanPct = DROP_SIZE_PCT * 0.7;
      // Symmetric fan around the cell centre: with N drops, slots are
      // -(N-1)/2 .. +(N-1)/2 (so 1 drop sits dead-centre, 2 drops sit
      // edge-to-edge across centre, 3 drops put one centre + one each
      // side, etc.).
      const fanOffset = dropTotal > 1
        ? (dropIdx - (dropTotal - 1) / 2) * fanPct
        : 0;
      const isActiveOwner = (t.dropHeroId && activeSuit === (t.dropHeroId === "hero-01" ? "mind" : "body"));
      const el = document.createElement("div");
      el.className = [
        "board-token",
        "board-token--drop",
        isActiveOwner ? "board-token--drop-active" : "",
      ].filter(Boolean).join(" ");
      el.style.left   = `${left + fanOffset}%`;
      el.style.top    = `${top}%`;
      el.style.width  = `${DROP_SIZE_PCT}%`;
      el.style.height = `${DROP_SIZE_PCT}%`;
      el.title = t.name;
      if (t.dropArt) {
        el.innerHTML = `<img src="${t.dropArt}" alt="${escapeHtml(t.name)}" draggable="false" />`;
      } else {
        el.textContent = t.label;
      }
      layer.appendChild(el);
      continue;
    }

    if (t.kind === "delver") {
      // Suit is derived from the stable `cardId` ("hero-mind" /
      // "hero-body") rather than the display label so the chip
      // text can change (e.g. "M" -> "Mind") without breaking
      // the per-suit paint lookup below.
      const suit = t.cardId === "hero-mind" ? "mind" : "body";
      const isActive = suit === activeSuit;
      const el = document.createElement("div");
      el.className = [
        "board-token",
        "board-token--delver",
        `board-token--delver-${suit}`,
        isActive ? "" : "board-token--delver-inactive",
      ].filter(Boolean).join(" ");
      el.style.left = `${left + stackOffsetPct}%`;
      el.style.top  = `${top + stackOffsetYPct}%`;
      // Token diameter ≈ 35% of a cell — small enough that two stacked
      // delvers (offset above) stay clear of each other.
      el.style.width  = `${CELL_SIZE_PCT * 0.35}%`;
      el.style.height = `${CELL_SIZE_PCT * 0.35}%`;
      el.textContent = t.label;
      el.title = isActive ? `${t.name} (active)` : `${t.name} (waiting)`;
      layer.appendChild(el);
      continue;
    }

    if (t.kind === "witness") {
      // Q2+ companion robot — same chip footprint as a delver so the
      // fan-out math above lines all three humanoids up cleanly when
      // they share a tile. No "active" affordance: Witness never takes
      // a turn, so the chip stays in its rest paint regardless of
      // whose turn it is.
      const el = document.createElement("div");
      el.className = "board-token board-token--witness";
      el.style.left = `${left + stackOffsetPct}%`;
      el.style.top  = `${top + stackOffsetYPct}%`;
      el.style.width  = `${CELL_SIZE_PCT * 0.35}%`;
      el.style.height = `${CELL_SIZE_PCT * 0.35}%`;
      el.textContent = t.label;
      el.title = `${t.name} - hauls your gear, recovers your bodies`;
      layer.appendChild(el);
      continue;
    }

    if (t.kind === "rebirth") {
      const SIZE = CELL_SIZE_PCT * 0.34;
      const { wPct, hPct } = cellSizePct(t.col, t.row);
      const el = document.createElement("div");
      el.className = "board-token board-token--rebirth";
      el.style.left = `${left + wPct / 2 - SIZE / 2}%`;
      el.style.top = `${top + hPct / 2 - SIZE / 2}%`;
      el.style.width = `${SIZE}%`;
      el.style.height = `${SIZE}%`;
      el.title = t.name;
      el.textContent = t.label;
      layer.appendChild(el);
      continue;
    }

    if (t.kind === "memory-fragment") {
      // Memory Fragment glyph from the drawn Spawn Card. Non-
      // interactive today (pickup wiring comes in a later slice
      // that drains `encounter.memoryFragments` and credits
      // `state.memoryChips`). Anchored to the cell's bottom-right
      // corner so it doesn't crowd a delver/enemy on the same
      // tile (which Spawn Card #3 actually puts at (3,0) — same
      // row as a minion). Uses the existing icon asset at
      // `/tokens/memory-fragment.webp` (no new art needed).
      const MF_SIZE_PCT = CELL_SIZE_PCT * 0.30;
      const { wPct, hPct } = cellSizePct(t.col, t.row);
      const el = document.createElement("div");
      el.className = "board-token board-token--memory-fragment";
      el.style.left   = `${left + wPct / 2 - MF_SIZE_PCT / 2}%`;
      el.style.top    = `${top + hPct / 2 - MF_SIZE_PCT / 2}%`;
      el.style.width  = `${MF_SIZE_PCT}%`;
      el.style.height = `${MF_SIZE_PCT}%`;
      el.title = t.name;
      el.innerHTML = `<img src="/tokens/memory-fragment.webp" alt="${escapeHtml(t.name)}" draggable="false" />`;
      layer.appendChild(el);
      continue;
    }

    if (t.kind === "friendly-encounter") {
      // Friendly Encounter token (Spawn Cards #13, #14). Uses the
      // friendly monster card art as an icon, matching the visual
      // language of the Memory Fragment token. Pickup wiring lives
      // in `engine/friendlyEncounter.ts > collectFriendlyEncountersAt`,
      // called from `moveDelverStep` and `stepWitness` -- the chip
      // removes itself on the next render after the mover lands on
      // the tile.
      const FE_SIZE_PCT = CELL_SIZE_PCT * 0.30;
      const { wPct, hPct } = cellSizePct(t.col, t.row);
      const el = document.createElement("div");
      el.className = "board-token board-token--friendly-encounter";
      el.style.left   = `${left + wPct / 2 - FE_SIZE_PCT / 2}%`;
      el.style.top    = `${top + hPct / 2 - FE_SIZE_PCT / 2}%`;
      el.style.width  = `${FE_SIZE_PCT}%`;
      el.style.height = `${FE_SIZE_PCT}%`;
      el.title = t.name;
      el.innerHTML = `<span class="board-token-fe-label">FRIENDLY<br>ENCOUNTER</span>`;
      layer.appendChild(el);
      continue;
    }

    // Enemy tile: render the actual card art scaled into the cell. Use the
    // PER-TILE rim size (not the centre-to-centre pitch) so each card sits
    // inside the visible cyan rectangle on the printed board.
    const enemy = t.cardId ? getEnemy(t.cardId) : null;
    const { wPct, hPct } = cellSizePct(t.col, t.row);
    const el = document.createElement("button");
    const isCounterBlockPreview = !!(counterBlockPreviewIds && t.id && counterBlockPreviewIds.has(String(t.id)));
    el.className = [
      "board-tile",
      `board-tile--${t.kind}`,
      isCounterBlockPreview ? "board-tile--counter-block-preview" : "",
    ].filter(Boolean).join(" ");
    // Stamp the live enemy instance id on the tile so the kill
    // animation pipeline (`screens/killAnimations.ts`) can look the
    // tile rect up by instanceId BEFORE `finalizeAttackSession`
    // wipes the body. Cheap (one dataset write per tile per
    // render) and keeps the animation code from having to walk the
    // encounter state to derive tile coords -> screen pixels.
    if (t.id) el.dataset["enemyInstance"] = String(t.id);
    el.style.left = `${left}%`;
    el.style.top  = `${top}%`;
    el.style.width  = `${wPct}%`;
    el.style.height = `${hPct}%`;
    if (enemy) {
      el.innerHTML =
        `<img src="/cards/${enemy.image}" alt="${escapeHtml(enemy.name)}" draggable="false" />` +
        renderEnemyHpOverlayHtml(t) +
        renderFatalFlawLockHtml(t) + renderEnemyStatusTokensHtml(t);
    } else {
      el.textContent = t.label;
    }
    // Slip Strider Boots: enemies rotate 90/180/270 degrees from
    // printed orientation when the Mind delver spends 2 movement to
    // rotate them. We pass the angle through a CSS variable so
    // `.board-tile`'s base transform (translate -50% -50% for
    // centering) AND its `:hover` `scale(2)` magnification still
    // compose with the rotation. The HP heart overlay is nested
    // inside the same tile container, so it rotates as a unit with
    // the card art (heart icon + current-HP number stay anchored
    // to the card's top-right corner regardless of orientation).
    if (t.facing) {
      el.style.setProperty("--enemy-rotation", `${t.facing}deg`);
    }
    el.addEventListener("click", () => onEnemyClick(t));
    layer.appendChild(el);
  }
}

// --- Movement overlay ----------------------------------------------------

/**
 * Render the step-by-step movement UI:
 *
 *   1. A pulsing green "source" overlay on the active delver's
 *      current tile (`.board-move-source`). Always painted while
 *      movement is available — unarmed shows a "Click to Move"
 *      pill, armed switches to a brighter "tap to cancel" state.
 *   2. When `armed === true`, additional click targets on each
 *      8-way adjacent legal destination (`.board-move-target`),
 *      AND a floating "N moves" badge anchored to the delver so
 *      the player can see remaining MP without looking away from
 *      the board (DESIGN.md §5.1 — confirmed mp_on_delver
 *      placement 2026-05-09). When `armed === false`, only the
 *      source overlay is shown.
 *
 * All overlays nest inside the printed tile rim (same per-cell
 * sizing as enemy cards) so the highlights line up with the
 * underlying board art. Cells outside the legal set are unchanged.
 */
function renderMovementOverlay(
  layer: HTMLDivElement,
  source: { x: number; y: number },
  reachable: import("../engine/movement").ReachableTile[],
  armed: boolean,
  movesLeft: number,
  onSourceClick: () => void,
  onDestClick: (x: number, y: number) => void,
): void {
  layer.innerHTML = "";

  // Source tile — actionable pulse on the delver's current cell.
  // Carries a "Click to Move" pill while not armed (mirrors the
  // "Click for Action" badge under a placed weapon card so the same
  // visual vocabulary teaches both affordances).
  {
    const { left, top } = cellCenterPct(source.x, source.y);
    const { wPct, hPct } = cellSizePct(source.x, source.y);
    const el = document.createElement("button");
    el.className = `board-move-source${armed ? " board-move-source--armed" : ""}`;
    el.style.left   = `${left}%`;
    el.style.top    = `${top}%`;
    el.style.width  = `${wPct}%`;
    el.style.height = `${hPct}%`;
    el.title = armed ? "Tap to end movement" : "Tap to move";
    if (!armed) {
      el.innerHTML = `<span class="suit-slot-badge suit-slot-badge--cta board-move-source-badge">Click to Move</span>`;
    }
    el.addEventListener("click", onSourceClick);
    layer.appendChild(el);
  }

  // Destination tiles — only painted once the player has armed
  // movement by tapping their own tile (step 2 of the flow).
  if (!armed) return;
  for (const tile of reachable) {
    const { left, top } = cellCenterPct(tile.x, tile.y);
    const { wPct, hPct } = cellSizePct(tile.x, tile.y);
    const el = document.createElement("button");
    el.className = "board-move-target";
    el.dataset.cost = String(tile.cost);
    el.style.left   = `${left}%`;
    el.style.top    = `${top}%`;
    el.style.width  = `${wPct}%`;
    el.style.height = `${hPct}%`;
    el.title = `Step here (1 movement)`;
    el.addEventListener("click", () => onDestClick(tile.x, tile.y));
    layer.appendChild(el);
  }

  // Floating "moves left" badge — anchored to the delver tile's
  // top-right corner so it tracks the delver as they step. Sized
  // independently of the cell so it never overlaps the destination
  // ring on adjacent tiles. Pointer-events: none so clicks on the
  // delver tile fall through to the source overlay (the disarm
  // hotspot).
  {
    const { left, top } = cellCenterPct(source.x, source.y);
    const { wPct, hPct } = cellSizePct(source.x, source.y);
    const badge = document.createElement("div");
    badge.className = "board-move-counter";
    // Anchor to the cell's top-right rim. Use percent offsets
    // derived from the cell rect so the badge floats just inside
    // the upper-right corner of the cell regardless of board zoom.
    badge.style.left = `${left + wPct / 2}%`;
    badge.style.top  = `${top - hPct / 2}%`;
    badge.title = `${movesLeft} movement point${movesLeft === 1 ? "" : "s"} remaining`;
    badge.textContent = String(movesLeft);
    layer.appendChild(badge);
  }
}

// --- Modal ---------------------------------------------------------------

function openCardModal(modalLayer: HTMLDivElement, modalBody: HTMLDivElement, token: BoardToken): void {
  if (!token.cardId) return;
  const enemy = getEnemy(token.cardId);
  modalBody.innerHTML = `
    <h3>${escapeHtml(enemy.name)} <span class="muted">#${enemy.cardNumber}</span></h3>
    <div class="card-modal-stats small">
      ${escapeHtml(enemy.kind)} &middot; HP ${enemy.hp} &middot; ATK ${enemy.attack}
    </div>
    <img class="card-modal-img" src="/cards/${enemy.image}" alt="${escapeHtml(enemy.name)} card" />
    ${enemy.partingShotText
      ? `<p class="small"><strong>Parting shot:</strong> ${escapeHtml(enemy.partingShotText)}</p>`
      : ""}
    <p class="small"><strong>On death:</strong> ${formatOnDeath(enemy)}</p>
  `;
  modalLayer.removeAttribute("hidden");
}

function formatOnDeath(enemy: import("../types").EnemyCard): string {
  const parts: string[] = [];
  if (enemy.onDeath.drops.length) parts.push(`drops ${enemy.onDeath.drops.join(", ")}`);
  if (enemy.onDeath.gainXp) parts.push(`+${enemy.onDeath.gainXp} XP`);
  if (enemy.onDeath.gainElements?.length) parts.push(`gain elements: ${enemy.onDeath.gainElements.join(", ")}`);
  if (enemy.onDeath.gainLevelUpCards) parts.push(`+${enemy.onDeath.gainLevelUpCards} Level Up card`);
  return parts.join(" &middot; ") || "-";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Ch4 Ritual sacrifices this wave (Winona the Oak). */
function renderRitualPillHtml(state: import("../state").CampaignState): string {
  const s = state.encounter?.ritualSacrifices ?? [];
  if (s.length === 0) return "";
  const parts = s.map((x) => `${HEROES.find((h) => h.id === x.heroId)?.suit === "body" ? "Body" : "Mind"} ${x.type} -1`);
  return `<span class="board-topbar-countdown" title="Ritual: sacrificed equipment ranks come back when Winona is slain or the wave ends.">Ritual ${parts.join(" / ")}</span>`;
}

/** Omen tokens per delver (Ch4) - shown while any delver holds one. */
function renderOmenPillHtml(state: import("../state").CampaignState): string {
  const tokens = state.encounter?.omenTokens ?? {};
  const parts = HEROES.filter((h) => (tokens[h.id] ?? 0) > 0)
    .map((h) => `${h.suit === "mind" ? "Mind" : "Body"} +${tokens[h.id]}`);
  if (parts.length === 0) return "";
  return `<span class="board-topbar-countdown" title="Omen: each token adds 1 to every damage that delver takes for the rest of the wave.">Omen ${parts.join(" / ")}</span>`;
}

/** Countdown pile readout (Ch3 Timber Fiend / Saplings) — shown only
 *  while a living enemy has the Countdown ability. */
function renderCountdownPillHtml(state: import("../state").CampaignState): string {
  const enc = state.encounter;
  if (!enc) return "";
  const any = enc.enemies.some((e) => e.alive && getEnemy(e.cardId).abilities.some((a) => a.kind === "countdown"));
  if (!any) return "";
  return `<span class="board-topbar-countdown" title="Countdown pile: each attack on a Countdown enemy adds a token. At 4, every Countdown enemy also counterattacks.">Countdown ${enc.countdownTokens}/4</span>`;
}

/**
 * Render the board-side Ally redeem buttons (Nov 15 card text):
 *   - Rodrigo Ally "Elemental Kit": refresh all spent consumable tokens.
 *   - Elayna Ally "Med Kit": delvers heal to full.
 * A button only renders while its card is owned + unspent, and is
 * disabled when it would do nothing (no spent tokens / nobody hurt).
 * Click listeners attach after `wrap.innerHTML` settles.
 */
function renderAllyRedeemButtonsHtml(state: import("../state").CampaignState): string {
  let html = "";
  // Memory Fragment Witness ability: once per quest, damage or heal around Witness.
  const wa = witnessAbility(state);
  if (wa && state.encounter?.witnessPosition) {
    const modes: { mode: WitnessAbilityMode; label: string; text: string }[] = [
      { mode: "damage", label: `Witness: ${wa.damage} damage`, text: `deals ${wa.damage} damage to every enemy next to Witness` },
    ];
    if (wa.heal > 0) modes.push({ mode: "heal", label: `Witness: heal ${wa.heal}`, text: `heals ${wa.heal} HP to every delver next to (or on) Witness's tile` });
    for (const m of modes) {
      const blocker = witnessAbilityBlocker(state, m.mode);
      const title = blocker
        ? `Memory Fragment #${wa.fragment} Witness ability: ${blocker}.`
        : `Memory Fragment #${wa.fragment}, once per quest free action: Witness ${m.text}.`;
      html += `
    <button class="btn btn--small btn--ghost board-topbar-redeem-ally"
            data-action="witness-ability" data-mode="${m.mode}"
            title="${title}"
            ${blocker ? "disabled" : ""}>
      ${m.label}
    </button>`;
    }
  }
  // Overcharger (Machinist upgrade): spend 2 Water to raise a damage type
  // to its upgraded value (LIGHT 2 / MEDIUM 4 / HEAVY 8) for the quest.
  const oc = overchargeEffect(state, state.currentDelverId);
  if (oc) {
    const have = state.elements[state.currentDelverId]?.[oc.element] ?? 0;
    const upgraded = { light: 2, medium: 4, heavy: 8 } as const;
    for (const dt of ["light", "medium", "heavy"] as const) {
      const done = damageAlreadyIncreased(state, state.currentDelverId, dt);
      const can = !done && have >= oc.cost;
      const title = done
        ? `${dt.toUpperCase()} damage is already increased this quest.`
        : `Overcharger: spend ${oc.cost} ${oc.element} to raise your base ${dt.toUpperCase()} damage to ${upgraded[dt]} for the rest of the quest (${have} ${oc.element} now).`;
      html += `
    <button class="btn btn--small btn--ghost board-topbar-redeem-ally"
            data-action="overcharge" data-damage-type="${dt}"
            title="${title}"
            ${can ? "" : "disabled"}>
      ${dt.toUpperCase()} ${upgraded[dt]}
    </button>`;
    }
  }
  if (canShowRodrigoRedeemButton(state)) {
    const spent = countSpentTokens(state);
    const title = spent === 0
      ? "Rodrigo's Elemental Kit: refresh every spent consumable token. No spent tokens right now."
      : `Rodrigo's Elemental Kit: refresh every spent consumable token (${spent} currently spent). One-shot.`;
    html += `
    <button class="btn btn--small btn--ghost board-topbar-redeem-ally"
            data-action="redeem-rodrigo"
            title="${escapeHtml(title)}"
            ${spent === 0 ? "disabled" : ""}>
      Elemental Kit <span class="board-topbar-favor-pill">${spent}</span>
    </button>`;
  }
  if (canShowElaynaRedeemButton(state)) {
    const missing = missingHp(state);
    const title = missing === 0
      ? "Elayna's Med Kit: both delvers heal to full. Nobody is hurt right now."
      : `Elayna's Med Kit: both delvers heal to full (+${missing} HP). Downed delvers are not revived. One-shot.`;
    html += `
    <button class="btn btn--small btn--ghost board-topbar-redeem-ally"
            data-action="redeem-elayna"
            title="${escapeHtml(title)}"
            ${missing === 0 ? "disabled" : ""}>
      Med Kit <span class="board-topbar-favor-pill">+${missing}</span>
    </button>`;
  }
  return html;
}

/**
 * Build the per-render snapshot of "thing on the board with HP" so
 * `detectDamageAndQueueFx` can spot HP losses across renders. One
 * entry per delver (always, since delvers persist on the board even
 * at 0 HP) and one per ALIVE enemy (dying-but-still-on-board enemies
 * during the counter window also stay alive=true until
 * `finalizeAttackSession`).
 *
 * Token ids match `BoardToken.id` so the FX layer can anchor at the
 * same cell the token is drawn on.
 */
function buildTokenHealthSnap(state: import("../state").CampaignState): TokenHealthSnap[] {
  const out: TokenHealthSnap[] = [];
  const enc = state.encounter;
  if (!enc) return out;
  for (const hero of HEROES) {
    const pos = enc.delverPositions[hero.id];
    if (!pos) continue;
    const lo = state.loadouts[hero.id];
    out.push({
      id: `delver-${hero.suit}`,
      col: pos.x,
      row: pos.y,
      hp: lo?.currentHp ?? 0,
    });
  }
  for (const enemy of enc.enemies) {
    if (!enemy.alive) continue;
    const card = getEnemy(enemy.cardId);
    out.push({
      id: enemy.instanceId,
      col: enemy.x,
      row: enemy.y,
      hp: Math.max(0, card.hp - enemy.damageTaken),
    });
  }
  return out;
}

/**
 * Paint one absolute-positioned splash element per active damage FX
 * event into `layer`. Each element gets a `style.animationDelay` of
 * `-elapsed ms` so a render that lands mid-animation picks up where
 * the splash should be (rather than restarting from frame 0). After
 * `damageFxDurationMs()` the entry is auto-pruned by
 * `getActiveDamageFx` and stops rendering.
 */
function renderDamageFx(layer: HTMLDivElement): void {
  const events = getActiveDamageFx();
  if (events.length === 0) {
    layer.innerHTML = "";
    return;
  }
  const now = performance.now();
  const duration = damageFxDurationMs();
  const html = events.map((e) => {
    const { left, top } = cellCenterPct(e.col, e.row);
    const elapsed = Math.max(0, Math.min(duration, now - e.startedAt));
    const delay = `-${elapsed.toFixed(0)}ms`;
    if (e.kind === "heal") {
      // Green burst + floating "+N HP" — same animation timing as
      // damage so the FX layer's expiry logic doesn't need to
      // care about variant. No "big" treatment for now: heals are
      // typically 1-2 HP and the standard size reads cleanly.
      return `
        <div class="damage-fx heal-fx" style="left:${left}%;top:${top}%;animation-delay:${delay};">
          <div class="heal-fx-burst" style="animation-delay:${delay};"></div>
          <div class="heal-fx-num" style="animation-delay:${delay};">+${e.amount}</div>
        </div>
      `;
    }
    const big = e.amount >= 8 ? " damage-fx-burst--big" : "";
    const bigNum = e.amount >= 8 ? " damage-fx-num--big" : "";
    return `
      <div class="damage-fx" style="left:${left}%;top:${top}%;animation-delay:${delay};">
        <div class="damage-fx-burst${big}" style="animation-delay:${delay};"></div>
        <div class="damage-fx-num${bigNum}" style="animation-delay:${delay};">-${e.amount}</div>
      </div>
    `;
  }).join("");
  layer.innerHTML = html;
}

/** Labels for enemy abilities that just took effect (see `collectAbilityProcFx`). */
function renderAbilityProcFx(): string {
  const now = performance.now();
  const duration = abilityProcFxDurationMs();
  return collectAbilityProcFx().map((f) => {
    const { left, top } = cellCenterPct(f.col, f.row);
    const delay = `-${Math.max(0, Math.min(duration, now - f.startedAt)).toFixed(0)}ms`;
    return `<div class="ability-proc-fx" style="left:${left}%;top:${top}%;--stack:${f.stackIdx};animation-delay:${delay};">${escapeHtml(enemyAbilityLabel(f.kind))}</div>`;
  }).join("");
}

/**
 * Fallback screen for a quest whose engine path isn't wired yet
 * (currently: any spawn-deck quest, i.e. Q2+). Shown when
 * `ensureEncounter` throws while bootstrapping the active quest's
 * Wave 1. Keeps the player from being trapped on a blank board and
 * makes the missing engine work obvious. The Back-to-Title button
 * is the only way out (we don't auto-clear the questId because the
 * debug button explicitly set it — the user should choose to leave).
 */
function renderQuestNotYetWiredPlaceholder(
  root: HTMLElement,
  router: Router,
  questName: string,
  err: unknown,
): void {
  const msg = err instanceof Error ? err.message : String(err);
  logEvent("board.questNotYetWired", { questName, errorMessage: msg });
  const wrap = document.createElement("div");
  wrap.className = "screen screen--story";
  wrap.innerHTML = `
    <div class="story-stage">
      <div class="story-stage-row">
        <article class="storybook-page">
          <h2>${escapeHtml(questName)} - Wave 1 not yet wired</h2>
          <div class="storybook-text">
            <p>
              You reached the start of Wave 1, but the engine doesn't yet
              know how to build a board for this quest. The spawn-deck
              encounter setup (drawing a Spawn Card, placing enemies,
              picking which delver lands on which compass tile) is queued
              up as Phase B of the Quest&nbsp;#2 work.
            </p>
            <p class="small muted">
              Use the Title screen's debug controls to switch quests
              or reset the campaign in the meantime.
            </p>
            <details class="small muted">
              <summary>Engine error (for debugging)</summary>
              <pre style="white-space:pre-wrap;">${escapeHtml(msg)}</pre>
            </details>
          </div>
        </article>
      </div>
      <div class="story-actions">
        <button class="btn btn--primary" data-action="back-to-title">Back to Title</button>
      </div>
    </div>
  `;
  root.appendChild(wrap);
  wrap.querySelector<HTMLButtonElement>("[data-action=back-to-title]")!
    .addEventListener("click", () => router.goTo({ name: "title" }));
}


/** Overlay for a mid-wave story entry, then its rewards modal. */
async function presentQuestEntry(
  router: Router,
  entry: { pageId: string; events: import("../types").RewardEvent[] },
): Promise<void> {
  const quest = getQuestData(router.state.currentQuestId);
  const text = quest.pages[entry.pageId];
  if (text === undefined) throw new Error(`Quest ${quest.id} is missing page ${entry.pageId}`);
  await new Promise<void>((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "boss-card-back-overlay quest-entry-overlay";
    overlay.innerHTML = `
      <div class="boss-card-back-modal quest-entry-modal">
        <h3 class="boss-card-back-title">${quest.name}</h3>
        <div class="quest-entry-text">${text.split(/\n\n/).map((p) => `<p>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`).join("")}</div>
        <button class="btn btn--primary boss-card-back-continue">Continue</button>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector<HTMLButtonElement>(".boss-card-back-continue")!.addEventListener("click", () => {
      overlay.remove();
      resolve();
    });
  });
  await presentRewards(document.body, entry.events);
  if (router.state.encounter) router.state.encounter.pendingQuestEntry = null;
  router.save();
}
