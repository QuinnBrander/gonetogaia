/**
 * Wave-phase screens — Parting Shots / End Wave (3-phase wave: Delver,
 * Parting Shots, End Wave; there is no Interlude).
 *
 * BoardScreen routes to one of these based on `encounter.phase`. Each
 * is a full-screen render (replaces the hero-phase BoardScreen content)
 * and lives outside `BoardScreen.ts` to keep that file focused on the
 * Hero Phase.
 *
 * Layout (utilitarian — designer-first per DESIGN.md §1):
 *
 *   +--------------------------------------------------------+
 *   | TopBar: Phase name + quest goal           [Back]       |
 *   +---------------------------+----------------------------+
 *   |                           |                            |
 *   |  Tide Board (5x5)         |  Phase panel:              |
 *   |  (read-only view)         |   - Parting Shots: step    |
 *   |                           |   - End Wave: page text    |
 *   +---------------------------+----------------------------+
 *
 * Phase transitions live in `engine/wave.ts`. UI never mutates the
 * phase directly — it calls into the engine (`resolvePartingShot`,
 * `bootstrapNextWave`, `completeWave`, `resetWaveForRetry`).
 */

import type { Router } from "../main";
import type { CampaignState, EncounterState } from "../state";
import type { EnemyCard, Element, RewardEvent } from "../types";
import { QUEST1, getEnemy, getHero, getHeroCard, getKeyItem, getQuestData, getShopProduct, questDisplayLabel, HEROES, shopProductImageOrNull } from "../data";
import {
  SUIT_PART_EQUIPMENT_TYPES_BY_SUIT,
  SUIT_PART_LABEL,
  type SuitPart,
  type EquipmentType,
} from "../types";
import { enqueueSuitConditionRankPicks } from "../engine/suitConditionGrants";
import { drainSuitConditionPicksViaModal } from "./SuitConditionRankPickModal";
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
import {
  applyHeroCardLossForDeaths,
  completeWave,
  endQuestReset,
  findPartingShotShieldOpportunities,
  nextPartingShotEnemy,
  partingShotNeedsChoice,
  resolvePartingShot,
  resetWaveForRetry,
  bootstrapNextWave,
  type PartingShotResult,
  type ResolvePartingShotParams,
} from "../engine/wave";
import { applyQuestCarryEffect } from "../engine/scenarioCard";
import { eligibleShopProductPicks, resolveShopProductPicks, runTownVisitAction } from "../engine/townVisit";
import { grantElementToDelver, ELEMENT_CAP_PER_DELVER } from "../engine/kills";
import {
  clearWavePhaseEphemera,
  clearAllUiState,
  getModal,
  getPartingShotLog,
  pushPartingShotLog,
  setModal,
} from "../uiState";
import { presentEnemyAbilities, waveHasAnyEnemyAbilities } from "./EnemyAbilitiesModal";
import { presentRewards } from "./RewardsModal";
import { presentGraveyardEntries, type PendingGraveyardEntry } from "./GraveyardModal";
import { logEvent } from "../debug/sessionLog";
import { onlineIsActorNow, onlineMyDelverId, REMOTE_APPLIED_EVENT } from "../net/onlineController";
import {
  formatNarrativeWithTypewriterSpans,
  startTypewriter,
  stopActiveTypewriter,
  withTypewriterSkipFirst,
  wireSkipOnClick,
} from "./typewriter";

// --- Boss card back data --------------------------------------------------

/**
 * Defines which suit part each delver must improve when a wave's boss
 * card back is revealed. The array is ordered by hero position
 * (Object.keys(state.loadouts)), so index 0 = first delver (hero-01)
 * and index 1 = second delver (hero-02).
 *
 * Source: Boss Monster Cards 80x80mm Back v4 PROOF 2.
 *   Wave 2 (Hundredeyes): « Improve 1 LEFT ARM | Improve 1 LEFT ARM » (Nov 15 PDF)
 *   Wave 3 (Death Cap):   « Improve 1 LEFT ARM  | Improve 1 HELMET     »
 */
interface BossCardBack {
  /** Boss enemy id whose printed card back this is. */
  bossEnemyId: string;
  /** Path inside public/. */
  image: string;
  /** Suit part assigned to delver 0 (hero-01) and delver 1 (hero-02). */
  suitParts: [SuitPart, SuitPart];
}

export const BOSS_CARD_BACKS: BossCardBack[] = [
  {
    bossEnemyId: "hundredeyes-003",
    // Nov 15 PDF back: "improve one Left Arm" for both delvers (the older
    // graphic-design card said Right Arm), so the art is the PDF crop too.
    image: "/boss-card-backs/hundredeyes-back.png",
    suitParts: ["left-arm", "left-arm"],
  },
  {
    bossEnemyId: "deathcap-004",
    image: "/boss-card-backs/deathcap-back.png",
    suitParts: ["left-arm", "helmet"],
  },
  // Chapter 3 bosses: prototype card backs from "Game Materials - All -
  // Nov 15.pdf" (pages 34 / 36; copied by scripts/applyGameMaterials.py).
  // Level 1 bosses' backs print no Suit Condition line, and they only lead
  // Wave 1, so they have no entry.
  { bossEnemyId: "gerald-030", image: "/boss-card-backs/gerald-back.png", suitParts: ["right-arm", "body"] },
  { bossEnemyId: "carnatia-039", image: "/boss-card-backs/carnatia-back.png", suitParts: ["body", "helmet"] },
  { bossEnemyId: "empressash-047", image: "/boss-card-backs/empressash-back.png", suitParts: ["right-arm", "right-arm"] },
  { bossEnemyId: "golem-055", image: "/boss-card-backs/golem-back.png", suitParts: ["right-arm", "legs"] },
  { bossEnemyId: "abomination-063", image: "/boss-card-backs/abomination-back.png", suitParts: ["body", "legs"] },
  { bossEnemyId: "timberfiend-071", image: "/boss-card-backs/timberfiend-back.png", suitParts: ["legs", "body"] },
  { bossEnemyId: "mindslayer-087", image: "/boss-card-backs/mindslayer-back.png", suitParts: ["legs", "body"] },
  { bossEnemyId: "oblivionwing-095", image: "/boss-card-backs/oblivionwing-back.png", suitParts: ["helmet", "body"] },
  // Chapter 4 quests (#4, #7, #13).
  { bossEnemyId: "arnold-120", image: "/boss-card-backs/arnold-back.png", suitParts: ["body", "left-arm"] },
  { bossEnemyId: "ruinedtidekin-121", image: "/boss-card-backs/ruinedtidekin-back.png", suitParts: ["left-arm", "helmet"] },
  { bossEnemyId: "anna-130", image: "/boss-card-backs/anna-back.png", suitParts: ["body", "legs"] },
  { bossEnemyId: "winona-131", image: "/boss-card-backs/winona-back.png", suitParts: ["body", "right-arm"] },
  { bossEnemyId: "laura-133", image: "/boss-card-backs/laura-back.png", suitParts: ["helmet", "legs"] },
  { bossEnemyId: "george-134", image: "/boss-card-backs/george-back.png", suitParts: ["right-arm", "body"] },
  { bossEnemyId: "revenant-135", image: "/boss-card-backs/revenant-back.png", suitParts: ["left-arm", "left-arm"] },
];

/**
 * Show the boss card back for `nextWaveNumber` (the wave the players are
 * about to enter), queue one suit-condition rank pick per delver with the
 * assigned suit part, then drain the queue via the pick modal.
 *
 * Returns a Promise that resolves once the player has dismissed the card
 * back image AND completed all picks, so the caller can proceed to
 * bootstrap the next wave.
 */
/**
 * Online co-op: when the next queued suit-condition pick (e.g. a boss-card
 * rank unlock pinned to a delver) is this player's and no picker is open
 * here, open it. The host's End of Wave chain opened the picker on its own
 * screen; this lets the other player answer theirs. Installed once.
 */
let remoteSuitPickInstalled = false;
let remoteSuitPickRouter: Router | null = null;
export function installRemoteSuitPickOpener(router: Router): void {
  remoteSuitPickRouter = router;
  if (remoteSuitPickInstalled) return;
  remoteSuitPickInstalled = true;
  document.addEventListener(REMOTE_APPLIED_EVENT, () => {
    const r = remoteSuitPickRouter;
    const phase = r?.state.encounter?.phase;
    if (!r || (phase !== "end-of-wave" && phase !== "delver-spawn-pick" && phase !== "first-turn-pick")) return;
    if (r.state.pendingSuitConditionPicks.length === 0) return;
    if (document.querySelector(".suit-condition-rank-overlay")) return;
    if (!onlineIsActorNow()) return;
    logEvent("online.open-own-suit-pick", { pickId: r.state.pendingSuitConditionPicks[0]!.pickId });
    void drainSuitConditionPicksViaModal(document.createElement("div"), r);
  });
}

export function presentBossCardBackAndPicks(
  state: CampaignState,
  router: Router,
  nextWaveNumber: number,
): Promise<void> {
  // Keyed by the upcoming wave's boss (not the wave number) so Ch3+
  // quests never show a Quest #2 card back. Level 1 bosses print no Suit
  // Condition line, so their waves skip the upgrade beat.
  const questId = state.encounter?.questId ?? state.currentQuestId;
  const upcomingBoss = getQuestData(questId).waves.find((w) => w.number === nextWaveNumber)?.bossEnemyId;
  const bossBack = BOSS_CARD_BACKS.find((b) => b.bossEnemyId === upcomingBoss);
  if (!bossBack) return Promise.resolve();

  const heroIds = Object.keys(state.loadouts);

  return new Promise<void>((resolveAll) => {
    // Build + show the card-back overlay.
    const overlay = document.createElement("div");
    overlay.className = "boss-card-back-overlay";

    const delverRows = bossBack.suitParts.map((part, i) => {
      const heroId = heroIds[i];
      if (!heroId) return "";
      const hero = getHero(heroId);
      const label = SUIT_PART_LABEL[part];
      return `
        <div class="boss-card-back-delver-row">
          <span class="boss-card-back-delver-name turn-${hero.suit}">${hero.suit === "mind" ? "Mind Delver" : "Body Delver"}</span>
          <span class="boss-card-back-delver-part">Improve 1 <strong>${label}</strong></span>
        </div>
      `;
    }).join("");

    overlay.innerHTML = `
      <div class="boss-card-back-modal">
        <h3 class="boss-card-back-title">Upcoming Boss</h3>
        <img class="boss-card-back-img" src="${bossBack.image}" alt="Boss card back" draggable="false" />
        <div class="boss-card-back-assignments">
          ${delverRows}
        </div>
        <button class="btn btn--primary boss-card-back-continue">Choose Equipment Upgrades</button>
      </div>
    `;
    document.body.appendChild(overlay);

    const continueBtn = overlay.querySelector<HTMLButtonElement>(".boss-card-back-continue")!;
    continueBtn.addEventListener("click", () => {
      overlay.remove();

      // Enqueue one suit-condition rank pick per delver, each pinned to
      // the assigned suit part's equipment types, with unlockHigherRanks.
      for (let i = 0; i < bossBack.suitParts.length; i++) {
        const heroId = heroIds[i];
        if (!heroId) continue;
        const part = bossBack.suitParts[i]!;
        const hero = getHero(heroId);
        const allowedTypes = SUIT_PART_EQUIPMENT_TYPES_BY_SUIT[hero.suit][part] as EquipmentType[];
        const label = SUIT_PART_LABEL[part];
        enqueueSuitConditionRankPicks(
          state,
          `boss-card-w${nextWaveNumber}-${part}-${heroId}`,
          [{
            delta: 1,
            pinnedHeroId: heroId,
            allowedTypes,
            unlockHigherRanks: true,
          }],
        );
        logEvent("engine.bossCardBack.enqueue", {
          nextWaveNumber,
          heroId,
          suitPart: part,
          label,
          allowedTypes,
        });
      }

      // Drain the picks via the existing modal, then resolve.
      drainSuitConditionPicksViaModal(document.createElement("div"), router).then(() => {
        resolveAll();
      });
    });
  });
}

// --- Top-level dispatcher -------------------------------------------------

/**
 * Render the right wave-phase screen for the current encounter.
 * Caller (BoardScreen) has already verified `enc.phase !== "hero"`.
 */
export function renderWavePhaseScreen(
  root: HTMLElement,
  router: Router,
  enc: EncounterState,
): void {
  installRemoteSuitPickOpener(router);
  switch (enc.phase) {
    case "parting-shots":
      renderPartingShots(root, router, enc);
      return;
    case "end-of-wave":
      renderEndOfWave(root, router, enc);
      return;
    case "completed":
      // Shouldn't normally render — completed clears the encounter.
      // Defensive bounce back to title.
      router.goTo({ name: "title" });
      return;
    case "delver-spawn-pick":
      // BoardScreen owns this dispatch directly so we don't need a
      // WavePhases hand-off; if someone DID route here, it's a UI
      // bug worth surfacing rather than silently rendering nothing.
      throw new Error(
        `WavePhases.renderWavePhaseScreen: phase "${enc.phase}" routes through BoardScreen, not here`,
      );
    case "hero":
      // Caller filtered this out; keep the exhaustiveness guard.
      return;
  }
}

// --- Parting Shots --------------------------------------------------------

function renderPartingShots(
  root: HTMLElement,
  router: Router,
  enc: EncounterState,
): void {
  const enemy = nextPartingShotEnemy(enc);

  const wrap = document.createElement("div");
  // Chapter-id modifier — see BoardScreen.ts / Story.ts / TownVisit.ts
  // for the matching markup. Drives the `.screen--board.screen--ch2`
  // underwater backdrop in styles.css.
  const chapterClass = enc.questId !== "quest1" ? " screen--ch2" : "";
  wrap.className = "screen screen--board screen--phase" + chapterClass;
  // Hide "Enemy Abilities" topbar button when no wave enemy has
  // a passive ability (e.g. Quest #1) — same gating as the live
  // board / spawn-pick screens, see
  // `waveHasAnyEnemyAbilities`.
  const showEnemyAbilitiesBtn = waveHasAnyEnemyAbilities(enc);
  wrap.innerHTML = `
    <div class="board-topbar">
      <div class="board-topbar-goal">
        ${showEnemyAbilitiesBtn ? `<button class="btn btn--small btn--ghost board-topbar-enemy-abilities" data-action="enemy-abilities" title="View ability + parting-shot reference for every enemy in this wave.">Enemy Abilities</button>` : ""}
        <strong>Parting Shots Phase</strong>
        <span class="muted small"> &middot; Surviving enemies attack one at a time.</span>
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
          <div class="board-targets" data-board-targets></div>
        </div>
      </main>
      <aside class="board-col board-col--right phase-panel">
        <div data-phase-body></div>
      </aside>
    </div>
  `;
  root.appendChild(wrap);

  // Tokens (read-only).
  const tokensLayer = wrap.querySelector<HTMLDivElement>("[data-board-tokens]")!;
  renderTokensReadOnly(tokensLayer, buildEncounterTokens(enc));

  // Highlight the current parting-shot enemy on the board.
  if (enemy) {
    const targetsLayer = wrap.querySelector<HTMLDivElement>("[data-board-targets]")!;
    paintEnemyHighlight(targetsLayer, enemy.x, enemy.y);
  }

  // Right column: phase body.
  const body = wrap.querySelector<HTMLDivElement>("[data-phase-body]")!;
  renderPartingShotsBody(body, router, enc, enemy);

  wrap.querySelector<HTMLButtonElement>("[data-action=back]")!
    .addEventListener("click", () => {
      // Don't lose the in-progress phase: just go back to title with
      // state intact (Resume will return here).
      router.goTo({ name: "title" });
    });

  // Button may be omitted on waves with no enemy abilities (see
  // `showEnemyAbilitiesBtn` gate above). Optional-chain the
  // wiring so the missing element is a no-op.
  wrap.querySelector<HTMLButtonElement>("[data-action=enemy-abilities]")
    ?.addEventListener("click", () => {
      const waveLabel = enemyAbilitiesWaveLabel(enc);
      logEvent("topbar.enemy-abilities", { questId: enc.questId, waveNumber: enc.waveNumber, from: "parting-shots" });
      void presentEnemyAbilities(document.body, enc, waveLabel);
    });
}

/**
 * Format the wave-aware modal title used by the "Enemy Abilities"
 * popup. Pulled into a helper because the Parting Shots phase and
 * the board need it and it makes the call sites read clean
 * (`presentEnemyAbilities(document.body, enc, enemyAbilitiesWaveLabel(enc))`).
 */
function enemyAbilitiesWaveLabel(enc: EncounterState): string {
  const q = getQuestData(enc.questId);
  return `${q.name} \u2014 Wave ${enc.waveNumber}`;
}

function renderPartingShotsBody(
  body: HTMLDivElement,
  router: Router,
  enc: EncounterState,
  enemy: ReturnType<typeof nextPartingShotEnemy>,
): void {
  const log = getPartingShotLog();

  if (!enemy) {
    // Reachable when the Parting Shots phase is entered with no
    // alive enemies left (all kills happened during Hero Phase, so
    // there's nothing for the cursor to walk through). The phase
    // machine doesn't auto-advance in that case because
    // `resolvePartingShot` is the only thing that ends the phase.
    // Tap Continue to fire `resolvePartingShot` once — it sees no
    // enemy and enters End Wave itself, then `router.save`
    // re-renders into the End of Wave screen.
    body.innerHTML = `
      <h2>Parting Shots resolved</h2>
      <p class="small muted">No surviving enemies to act. Continuing to End Wave...</p>
      <button class="btn btn--primary" data-continue>Continue</button>
      ${renderPartingShotLog(log)}
    `;
    body.querySelector<HTMLButtonElement>("[data-continue]")!
      .addEventListener("click", () => {
        // `resolvePartingShot` returns null on no-enemy and enters
        // End Wave (victory). Save triggers a re-render and the
        // dispatcher routes us to the End of Wave screen.
        resolvePartingShot(router.state);
        router.save();
      });
    return;
  }

  const card = getEnemy(enemy.cardId);
  const needsChoice = partingShotNeedsChoice(enc, enemy, card);
  const total = enc.enemies.length;
  const remaining = enc.enemies
    .slice(enc.partingShotCursor)
    .filter((e) => e.alive).length;
  const idxOneBased = total - remaining + 1;

  body.innerHTML = `
    <h2>Parting Shot ${idxOneBased} of ${total}</h2>
    <div class="phase-card">
      <div class="phase-card-row">
        <strong>${escapeHtml(card.name)}</strong>
      </div>
      <div class="phase-card-row small muted">
        ${describePartingShot(card)}
      </div>
    </div>

    ${needsChoice ? renderTieChooser(card, enemy.x, enemy.y, router.state) : ""}

    ${renderDelverHpStatus(router.state)}

    <div class="phase-actions">
      ${needsChoice
        ? `<p class="small muted">Pick which delver takes the hit (the two are tied for nearest).</p>`
        : `<button class="btn btn--primary" data-resolve>Resolve</button>`}
    </div>

    ${renderPartingShotLog(log)}
  `;

  if (!needsChoice) {
    body.querySelector<HTMLButtonElement>("[data-resolve]")!
      .addEventListener("click", () => onResolvePartingShot(router, undefined));
    return;
  }
  for (const btn of body.querySelectorAll<HTMLButtonElement>("[data-target-hero]")) {
    btn.addEventListener("click", () => {
      const id = btn.dataset.targetHero!;
      onResolvePartingShot(router, id);
    });
  }
}

function onResolvePartingShot(router: Router, chosenDelverId: string | undefined): void {
  // Sol / Lunar Shield can intercept parting-shot damage too (post-
  // 2026-05-25). Preview the would-be damage map and check whether
  // any shielded delver stands on a tile with at-risk tile-mates.
  // If so, hand control to the `parting-shot-shield-prompt` modal —
  // it walks the queue, records spends, and ultimately calls
  // `resolvePartingShot` itself with `shieldChoices` populated.
  // Otherwise resolve directly (legacy fast-path, no modal opens).
  const params: ResolvePartingShotParams = chosenDelverId ? { chosenDelverId } : {};
  const opportunities = findPartingShotShieldOpportunities(router.state, params);
  if (opportunities.length > 0) {
    setModal({
      kind: "parting-shot-shield-prompt",
      queue: opportunities,
      cursor: 0,
      choices: {},
      pendingSpends: [],
      partingShotParams: chosenDelverId ? { chosenDelverId } : {},
    });
    router.refresh();
    return;
  }
  const result = resolvePartingShot(router.state, params);
  if (result) pushPartingShotLog(result);
  router.save();
}

function renderTieChooser(
  card: EnemyCard,
  enemyX: number,
  enemyY: number,
  state: CampaignState,
): string {
  const enc = state.encounter!;
  return `
    <div class="phase-tie-chooser">
      ${HEROES.map((h) => {
        const pos = enc.delverPositions[h.id];
        if (!pos) return "";
        const dist = Math.max(Math.abs(pos.x - enemyX), Math.abs(pos.y - enemyY));
        const lo = state.loadouts[h.id];
        const hp = lo ? `HP ${lo.currentHp}/${lo.maxHp}` : "";
        return `
          <button class="btn btn--secondary phase-tie-btn" data-target-hero="${h.id}">
            <strong>${escapeHtml(h.suit === "mind" ? "Mind Delver" : "Body Delver")}</strong>
            <span class="small muted">@(${pos.x},${pos.y}) \u00b7 dist ${dist} \u00b7 ${hp}</span>
            <span class="small">Take ${card.partingShot.kind === "nearest-delver" ? card.partingShot.damage : "?"} dmg</span>
          </button>
        `;
      }).join("")}
    </div>
  `;
}

/**
 * Render a HP-status row for both delvers, shown at the bottom of
 * every Parting Shots step so the player can watch HP tick down as
 * shots resolve (and confirm survival before tapping Resolve on the
 * final shot). Suit-tinted pills (blue = mind, orange = body) mirror
 * the colour language used by the rest of the board chrome.
 */
function renderDelverHpStatus(state: CampaignState): string {
  const cells = HEROES.map((h) => {
    const lo = state.loadouts[h.id];
    if (!lo) return "";
    const label = h.suit === "mind" ? "Mind Delver" : "Body Delver";
    const downed = lo.currentHp <= 0;
    return `
      <div class="phase-hp-cell phase-hp-cell--${h.suit}${downed ? " phase-hp-cell--downed" : ""}">
        <span class="phase-hp-label">${label}</span>
        <span class="phase-hp-value">${lo.currentHp} / ${lo.maxHp} HP</span>
      </div>
    `;
  }).join("");
  return `<div class="phase-hp-status">${cells}</div>`;
}

function describePartingShot(card: EnemyCard): string {
  const ps = card.partingShot;
  switch (ps.kind) {
    case "all-delvers":
      return `Hits both delvers for ${ps.damage} damage.`;
    case "nearest-delver":
      return `Hits the closest delver (Chebyshev) for ${ps.damage} damage. Ties: active player picks.`;
    case "delvers-within":
      return `Hits every delver within ${ps.range} tiles for ${ps.damage} damage.`;
    case "all-delvers-lose-xp":
      return `Both delvers lose ${ps.amount === "all" ? "ALL" : ps.amount} XP on hand.`;
    case "all-delvers-lose-elements":
      return `Both delvers lose ${ps.amount === "all" ? "ALL" : ps.amount} element tokens.`;
    case "all-delvers-damage-and-lose-xp":
      return `Both delvers take ${ps.damage} damage AND lose ${ps.amount === "all" ? "ALL" : ps.amount} XP on hand.`;
    case "all-delvers-damage-and-lose-elements":
      return `Both delvers take ${ps.damage} damage AND lose ${ps.amount === "all" ? "ALL" : ps.amount} element tokens.`;
    case "all-delvers-damage-and-discard-consumable":
      return `Both delvers take ${ps.damage} damage AND discard ${ps.count} consumable token${ps.count === 1 ? "" : "s"}.`;
  }
}

function renderPartingShotLog(log: PartingShotResult[]): string {
  if (log.length === 0) return "";
  return `
    <div class="phase-log">
      <h4 class="small muted">Resolved this phase</h4>
      <ol class="phase-log-list">
        ${log.map((r) => {
          const card = getEnemy(r.enemyCardId);
          const parts = formatPartingShotLogParts(r);
          if (parts.length === 0) {
            return `<li><strong>${escapeHtml(card.name)}</strong>: no effect.</li>`;
          }
          const died = r.delverDied ? " <strong class=\"log-kill\">Delver killed!</strong>" : "";
          return `<li><strong>${escapeHtml(card.name)}</strong>: ${parts.join(" &middot; ")}${died}</li>`;
        }).join("")}
      </ol>
    </div>
  `;
}

/**
 * Break a `PartingShotResult` into human-readable middot-joined
 * chunks for the log row. Handles every variant uniformly:
 *
 *   - damage hits → "Mind −2, Body −2"
 *   - element clears → "Mind cleared 3 elements, Body cleared 1"
 *   - xpLost (shared) → "−5 XP" (added as a final chunk)
 *   - no targets / no effects → empty array (caller prints
 *     "no effect.")
 *
 * Damage and element-clear can co-exist on the same delver
 * (none of today's variants combine them per-hit, but the
 * shape allows it — render both if both are present).
 */
function formatPartingShotLogParts(r: PartingShotResult): string[] {
  const parts: string[] = [];
  const damageHits = r.hits.filter((h) => h.damage > 0);
  if (damageHits.length > 0) {
    parts.push(damageHits.map((h) => `${heroLabel(h.heroId)} \u2212${h.damage}`).join(", "));
  }
  const elementHits = r.hits.filter((h) => (h.elementsCleared ?? 0) > 0);
  if (elementHits.length > 0) {
    parts.push(
      elementHits
        .map((h) => `${heroLabel(h.heroId)} cleared ${h.elementsCleared} element${h.elementsCleared === 1 ? "" : "s"}`)
        .join(", "),
    );
  }
  // Honest reporting: "the parting shot tried to take elements
  // but our bag was empty" — show as a single muted phrase so
  // the player isn't confused by a silent log row.
  const triedElementsButEmpty =
    r.hits.length > 0 &&
    r.hits.every((h) => h.damage === 0 && (h.elementsCleared ?? -1) === 0);
  if (triedElementsButEmpty) {
    parts.push("no elements to lose");
  }
  if (r.xpLost > 0) {
    parts.push(`\u2212${r.xpLost} XP`);
  }
  return parts;
}

// --- End Wave refresh summary --------------------------------------------

/**
 * The End Wave refresh card shown on every End of Wave screen: weapons
 * back to hand, consumables refreshed, Harvester payouts. Reads the
 * engine's record on the encounter (`enterEndOfWave` writes it), so an
 * online guest sees the same lines.
 */
function renderEndWaveRefreshHtml(enc: EncounterState): string {
  const r = enc.endWaveRefresh;
  if (!r) throw new Error("End of Wave screen: the End Wave refresh hasn't run");
  const label = (heroId: string) => (getHero(heroId).suit === "mind" ? "Mind" : "Body");
  const weapons = r.weaponsRefreshed.filter((w) => w.count > 0)
    .map((w) => `${label(w.heroId)} ${w.count}`).join(", ");
  const lines = [
    `Weapons back to hand: ${weapons || "none were exhausted"}.`,
    `AP refilled.${r.consumableTokensRefreshed > 0 ? ` ${r.consumableTokensRefreshed} spent consumable token${r.consumableTokensRefreshed === 1 ? "" : "s"} refreshed.` : ""}`,
    ...r.harvesterGrants.map((g) => `${label(g.heroId)}: ${g.description}.`),
  ];
  return `
    <div class="phase-card end-wave-refresh">
      <h4>End Wave</h4>
      <ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>
    </div>
  `;
}

// --- End of Wave ----------------------------------------------------------

function renderEndOfWave(
  root: HTMLElement,
  router: Router,
  enc: EncounterState,
): void {
  const outcome = enc.endOfWaveOutcome ?? "victory";
  // Resolve the active Quest+Wave from the encounter (Q1, Q2, ...)
  // so the page lookup and button layout pull from the right data
  // block. `enterEndOfWave` always sets `endOfWavePageId`, so the
  // `??` is defensive only (a re-render with a stale phase still
  // gets a non-empty page id).
  const activeQuest = getQuestData(enc.questId);
  const wave = activeQuest.waves.find((w) => w.number === enc.waveNumber)
    ?? activeQuest.waves[0]!;
  const pageId = enc.endOfWavePageId
    ?? (outcome === "victory" ? wave.endOfWave.bothSurvive : wave.endOfWave.anyDie);
  const pageText = activeQuest.pages[pageId] ?? "";

  // Ch3+ quests carry their End-of-Wave flow as data (`wave.eow`).
  if (wave.eow) {
    renderGenericEndOfWave(root, router, enc, activeQuest, wave, outcome);
    return;
  }

  // Quest-specific end-of-wave branch handling. Q1 W1 is the
  // hand-authored "to town" or "retry" flow; Q2 W1 introduces a
  // two-button defeat choice (Retreat vs Continue → both reset
  // the wave) plus an inline element picker on victory (page
  // 2.3's "Delvers gain 3 elements") that gates the W2 transition.
  // Q2 W2 victory adds a Return-to-Town / Follow-Shouts split.
  // All branches kept module-local (not on state) so a browser
  // refresh re-shows the parent page — losing the choice mid-flip
  // is harmless; the player just re-selects.
  const isQuest2 = enc.questId === "quest2";
  const q2WaveNumber = enc.waveNumber;
  const q2DefeatStep = isQuest2 && outcome === "defeat" ? endOfWaveBranch : "initial";
  const q2W2VictoryStepNow = isQuest2 && q2WaveNumber === 2 && outcome === "victory"
    ? q2W2VictoryStep
    : "initial";
  // Q1 is a single-wave quest: a victory here clears the whole quest,
  // so the End-of-Wave screen doubles as the End-of-Quest stage and
  // routes the player into the Chapter 1 Town Visit (rulebook page 6).
  // First clear → Continue button drives the End-of-Quest reset and
  // navigates to the Town Visit screen. Subsequent replays of Q1
  // (after `townVisit1Completed === true`) skip the visit and just
  // reset back to title.
  const isFirstQuestClear =
    !isQuest2 && outcome === "victory" && !router.state.townVisit1Completed;

  // Stop any prior typewriter (e.g. left over from the Town Visit
  // screen if the player jumped here via dev navigation). Idempotent
  // when nothing is running.
  stopActiveTypewriter();

  // Hero splash beside the prose. Q1-only: victory shows the two
  // delvers together (`quest1-conclusion.png`); defeat reuses the
  // Soulhunter portrait shipped with the Q1 wave intro art so the
  // loss page still has a face. Both render through
  // `.storybook-portrait` (aspect-preserving — see styles.css).
  //
  // Q2 EOW screens render WITHOUT a side portrait — the Q1 art is
  // narratively wrong on Q2 outcomes (e.g. Q2 W2 defeat would have
  // shown the Q1 Soulhunter back), and we don't have Q2-specific
  // EOW portraits today. The `.story-stage-row` flex column
  // collapses cleanly when the portrait aside is omitted.
  const sidePortraitSrc: string | null = isQuest2
    ? null
    : outcome === "victory"
      ? "/story/quest1-conclusion.png"
      : "/story/soulhunter.png";

  // Quest label for the top bar — was hard-coded to "Quest #1" so
  // Q2 W1 sessions would mislabel themselves. The wave number now
  // also comes from the encounter rather than being implicit.
  const questLabel = isQuest2 ? `Quest #2, Wave ${enc.waveNumber}` : `Quest #1, Wave ${enc.waveNumber}`;
  const questNameForTopbar = activeQuest.name;

  // Q2 defeat re-uses pageId for the FIRST page; if the player has
  // already picked Retreat / Continue, swap the prose to the
  // corresponding follow-up page declared on Q2's page block.
  // Q2 W2 victory has a parallel branching: if the player picked
  // "Follow the shouts" (B), swap to a Wave-3-stub prose since
  // Wave 3 isn't shipped yet (page2_7 is reserved for the real
  // W3 victory).
  const q2Pick = isQuest2 && outcome === "victory" ? q2ContinuePick(router.state, wave) : null;
  const renderedPageText = (() => {
    if (!isQuest2) return pageText;
    if (q2Pick) {
      const text = activeQuest.pages[q2Pick.pageId];
      if (text === undefined) throw new Error(`Quest #2 is missing page ${q2Pick.pageId}`);
      return text;
    }
    if (outcome === "defeat") {
      if (q2DefeatStep === "retreat") {
        return activeQuest.pages[`${pageId}_retreat`] ?? pageText;
      }
      if (q2DefeatStep === "continue") {
        return activeQuest.pages[`${pageId}_continue`] ?? pageText;
      }
      return pageText;
    }
    // Q2 W2 victory is a two-step screen (page 2.5 split). The
    // first step prints `page2_5` (Witness recovers the camera);
    // after the player taps COLLECT REWARD the step flips and we
    // swap in `page2_5_after_reward` (the faint-shouting prose
    // that gates the Town / Wave 3 choice).
    if (q2WaveNumber === 2 && q2W2VictoryStepNow === "after-reward") {
      return activeQuest.pages[`${pageId}_after_reward`] ?? pageText;
    }
    return pageText;
  })();

  const wrap = document.createElement("div");
  // Chapter-id modifier — drives `.screen--board.screen--ch2` backdrop.
  const chapterClass = enc.questId !== "quest1" ? " screen--ch2" : "";
  wrap.className = "screen screen--board screen--phase screen--end-of-wave" + chapterClass;
  wrap.innerHTML = `
    <div class="board-topbar">
      <div class="board-topbar-goal">
        <strong>End of Wave - ${outcome === "victory" ? "Victory" : "Defeat"}</strong>
        <span class="muted small"> &middot; ${escapeHtml(questLabel)}: ${escapeHtml(questNameForTopbar)}</span>
      </div>
    </div>
    <div class="end-of-wave-stage">
      <div class="story-stage-row">
        <article class="storybook-page">
          <h2>${renderEndOfWaveHeadline({
            isQuest2,
            outcome,
            q2WaveNumber,
            q2DefeatStep,
            q2W2VictoryStep: q2W2VictoryStepNow,
          })}</h2>
          <div class="storybook-text" data-story-text>${formatNarrativeWithTypewriterSpans(renderedPageText)}</div>
        </article>
        ${sidePortraitSrc ? `
        <aside class="storybook-portrait">
          <img alt="" src="${sidePortraitSrc}" />
        </aside>` : ""}
      </div>
      ${renderEndWaveRefreshHtml(enc)}
      <div class="end-of-wave-actions">
        ${renderEndOfWaveActions({
          isQuest2,
          outcome,
          isFirstQuestClear,
          q2DefeatStep,
          q2WaveNumber,
          q2W2VictoryStep: q2W2VictoryStepNow,
          q2ContinueHtml: isQuest2 && outcome === "victory"
            ? renderQ2ContinueChoicesHtml(router.state, wave)
            : "",
        })}
      </div>
    </div>
  `;
  root.appendChild(wrap);

  wireQ2ContinueChoices(wrap, router, activeQuest, wave);

  // Start the typewriter on the narrative body. The "Recorded on
  // your Campaign Sheet" summary panel below the body is NOT
  // wrapped in `.tt-char` spans — meta info should appear instantly,
  // only the storybook prose reveals character-by-character. Tap
  // anywhere on the screen (background, card body, summary panel)
  // to fast-forward. Action buttons keep their own skip-first
  // wrappers so the first click on a button still becomes a skip
  // (rather than triggering whatever the button does).
  // Broadened from `.storybook-page` to the full screen wrap on
  // 2026-05-18.
  const textEl = wrap.querySelector<HTMLElement>("[data-story-text]")!;
  startTypewriter(textEl);
  wireSkipOnClick(wrap);

  // Every action button is wrapped with `withTypewriterSkipFirst` so
  // the player's first click while the End-of-Wave reveal is still
  // typing skips the reveal instead of blowing past unread text. The
  // second click then fires the underlying handler.

  // Victory \xb7 first clear \u2192 end-of-quest reset, then into the Town Visit.
  const continueTown = wrap.querySelector<HTMLButtonElement>("[data-action=continue-town]");
  if (continueTown) {
    continueTown.addEventListener("click", withTypewriterSkipFirst(() => {
      completeWave(router.state);
      endQuestReset(router.state);
      // Anchor the Town Visit at Chapter 1 page 6 (the "With bodies
      // aching, you ascend the slopes of Bird's Nest..." narrative
      // that the page1_1 prose hands off to). The parallel-agent
      // Town Visit renderer reads this and drives page 6+ flow.
      router.state.townVisit = {
        chapterId: "ch1",
        pageId: "page6",
        pagesEntered: [],
      };
      clearWavePhaseEphemera();
      clearAllUiState();
      router.goTo({ name: "townVisit" });
    }));
  }

  // Victory \xb7 replay (town visit already done) \u2192 reset and home.
  const finishReplay = wrap.querySelector<HTMLButtonElement>("[data-action=finish-replay]");
  if (finishReplay) {
    finishReplay.addEventListener("click", withTypewriterSkipFirst(() => {
      completeWave(router.state);
      endQuestReset(router.state);
      clearWavePhaseEphemera();
      clearAllUiState();
      router.goTo({ name: "title" });
    }));
  }

  // Defeat \u2192 back to title without ending the quest. Same shape as
  // before \u2014 no end-of-quest reset on a loss (player's progress is
  // intact, they just need to retry the wave).
  const finishDefeat = wrap.querySelector<HTMLButtonElement>("[data-action=finish-defeat]");
  if (finishDefeat) {
    finishDefeat.addEventListener("click", withTypewriterSkipFirst(() => {
      router.state.encounter = null;
      clearWavePhaseEphemera();
      clearAllUiState();
      router.goTo({ name: "title" });
    }));
  }
  const retry = wrap.querySelector<HTMLButtonElement>("[data-action=retry]");
  if (retry) {
    retry.addEventListener("click", withTypewriterSkipFirst(() => {
      resetWaveForRetry(router.state);
      clearWavePhaseEphemera();
      clearAllUiState();
      router.save();
    }));
  }
  // The "View Campaign Sheet" peek-only button + handler were
  // removed 2026-05-21 (user request) -- at the quest-clear beat
  // the only narrative-correct next step is Continue / Finish.
  // Campaign Sheet remains reachable from the Title screen.

  // ---- Quest 2 W1 end-of-wave handlers --------------------------------

  // Q2 W1 defeat \u00b7 page2_1 \u00b7 player picks Retreat. Swap the
  // module-local branch and re-render in place \u2014 the next render
  // sees `endOfWaveBranch === "retreat"` and pulls page2_1_retreat
  // prose plus a single "Try Wave 1 Again" button.
  const q2Retreat = wrap.querySelector<HTMLButtonElement>("[data-action=q2-defeat-retreat]");
  if (q2Retreat) {
    q2Retreat.addEventListener("click", withTypewriterSkipFirst(() => {
      endOfWaveBranch = "retreat";
      router.refresh();
    }));
  }

  // Q2 W1 defeat \u00b7 page2_1 \u00b7 player picks Continue. Same
  // pattern as Retreat \u2014 mutate the branch and re-render.
  const q2Continue = wrap.querySelector<HTMLButtonElement>("[data-action=q2-defeat-continue]");
  if (q2Continue) {
    q2Continue.addEventListener("click", withTypewriterSkipFirst(() => {
      endOfWaveBranch = "continue";
      router.refresh();
    }));
  }

  // Q2 W1 defeat \u00b7 follow-up page (retreat OR continue) \u2192
  // commit the retry. Both narrative branches resolve to the same
  // mechanical reset (`resetWaveForRetry`: full HP, fresh consumables,
  // weapons returned to hand). The narrative-only difference (town
  // patch-up vs no town) lives entirely in the prose. After committing
  // we clear the branch latch so a future end-of-wave starts at
  // "initial" cleanly.
  const q2Retry = wrap.querySelector<HTMLButtonElement>("[data-action=q2-defeat-retry]");
  if (q2Retry) {
    q2Retry.addEventListener("click", withTypewriterSkipFirst(() => {
      resetWaveForRetry(router.state);
      clearWavePhaseEphemera();
      clearAllUiState();
      resetEndOfWaveUiState();
      router.save();
    }));
  }

  // ---- Quest 2 W2 end-of-wave handlers --------------------------------

  // Q2 W2 victory \u00b7 page 2.5 STEP 1 (per user request
  // 2026-05-20). The screen is split into two sequential pages:
  // step 1 shows the Witness-recovers-camera prose with a single
  // COLLECT REWARD button, and step 2 shows the faint-shouting
  // prose plus the Town / Wave 3 choice. Key Item #1 (Surveillance
  // Camera) is granted HERE \u2014 the reward modal opens, the
  // player dismisses it, then the screen flips to step 2 in place.
  // `presentKeyItemRewards` is a no-op when no new items were
  // granted (e.g. debug replays where the player already owned
  // #1), so on replays we still advance to step 2 without
  // re-opening the modal.
  const q2W2CollectReward = wrap.querySelector<HTMLButtonElement>("[data-action=q2-w2-collect-reward]");
  if (q2W2CollectReward) {
    q2W2CollectReward.addEventListener("click", withTypewriterSkipFirst(() => {
      runEowChain(q2W2CollectReward, "q2-w2-collect-reward", async (step) => {
        step("grant-key-item");
        const newlyGranted = grantQ2KeyItemsAndCollectNew(router.state, [1]);
        step("present-rewards");
        await presentKeyItemRewards(newlyGranted);
        step("advance-step");
        q2W2VictoryStep = "after-reward";
        router.refresh();
      });
    }));
  }

  // Q2 W2 victory \u00b7 page 2.5 STEP 2 \u00b7 player picks RETURN
  // TO TOWN. Witness already inserted the camera in step 1 so the
  // Key Item is in the bag; this button just ends Quest #2 and
  // routes INTO the Chapter 2 Town Visit (rulebook page 22) \u2014
  // unless the player has already completed Ch2 once (debug
  // replays), in which case bounce back to title.
  const q2W2ReturnTown = wrap.querySelector<HTMLButtonElement>("[data-action=q2-w2-return-town]");
  if (q2W2ReturnTown) {
    q2W2ReturnTown.addEventListener("click", withTypewriterSkipFirst(() => {
      runEowChain(q2W2ReturnTown, "q2-w2-return-town", async (step) => {
        step("complete-wave");
        completeWave(router.state);
        step("end-quest-reset");
        endQuestReset(router.state);
        step("clear-ephemera");
        clearWavePhaseEphemera();
        clearAllUiState();
        resetEndOfWaveUiState();
        step("route");
        routeToCh2OrTitle(router, "both-survived");
      });
    }));
  }

  // Q2 W2 \u00b7 "Quest complete" terminus for the W2 DEFEAT
  // path (page 2.4). Key Item #1 grants on this button press
  // (Witness recovered the camera while the boss was distracted).
  // Defeat is still "Quest #2 complete" per the storybook, so the
  // delvers proceed straight to the Chapter 2 Town Visit (or
  // bounce to title if the visit was already completed).
  const q2W2Complete = wrap.querySelector<HTMLButtonElement>("[data-action=q2-w2-quest-complete]");
  if (q2W2Complete) {
    q2W2Complete.addEventListener("click", withTypewriterSkipFirst(() => {
      runEowChain(q2W2Complete, "q2-w2-quest-complete", async (step) => {
        step("grant-key-item");
        const newlyGranted = grantQ2KeyItemsAndCollectNew(router.state, [1]);
        step("collect-dying");
        const dying = collectDyingHeroes(router.state);
        logEvent("ui.eowChain.q2-w2-quest-complete.snapshot", {
          newlyGrantedCount: newlyGranted.length,
          dyingCount: dying.length,
          dyingHeroIds: dying.map((d) => d.heroId),
        });
        step("present-rewards");
        await presentKeyItemRewards(newlyGranted);
        step("present-graveyard");
        await presentGraveyardEntries(dying, router.state);
        step("apply-card-loss");
        applyHeroCardLossForDeaths(router.state);
        step("complete-wave");
        completeWave(router.state);
        step("end-quest-reset");
        endQuestReset(router.state);
        step("clear-ephemera");
        clearWavePhaseEphemera();
        clearAllUiState();
        resetEndOfWaveUiState();
        step("route");
        routeToCh2OrTitle(router, "died");
      });
    }));
  }

  // ---- Quest 2 W3 end-of-wave handlers --------------------------------

  // Q2 W3 victory \u00b7 page 2.7. The delvers chase the
  // fleeing strangers, find the diseased tree, and recover
  // the dropped syringe (Key Item #2). Key Item #1 was
  // already in the bag from the W2 victory, but the W2 DEFEAT
  // path skips W3 entirely — so we still grant #1 here too
  // for the (currently unreachable) "started at W3 fresh"
  // debug path. Both idempotent.
  //
  // Reward modal: typically only #2 is new here (the player saw #1
  // claimed at the end of W2). The "started fresh at W3" debug
  // path is the rare case where both are new and both show.
  const q2W3VictoryComplete = wrap.querySelector<HTMLButtonElement>("[data-action=q2-w3-victory-complete]");
  if (q2W3VictoryComplete) {
    q2W3VictoryComplete.addEventListener("click", withTypewriterSkipFirst(() => {
      runEowChain(q2W3VictoryComplete, "q2-w3-victory-complete", async (step) => {
        step("grant-key-items");
        const newlyGranted = grantQ2KeyItemsAndCollectNew(router.state, [1, 2]);
        step("present-rewards");
        await presentKeyItemRewards(newlyGranted);
        step("complete-wave");
        completeWave(router.state);
        step("end-quest-reset");
        endQuestReset(router.state);
        step("clear-ephemera");
        clearWavePhaseEphemera();
        clearAllUiState();
        resetEndOfWaveUiState();
        step("route");
        routeToCh2OrTitle(router, "both-survived");
      });
    }));
  }

  // Q2 W3 defeat \u00b7 page 2.6. The mist takes both delvers
  // and the storybook page closes with "you did great." No new
  // key items here \u2014 Key Item #1 (from W2 victory) stays on the
  // campaign sheet, but #2 (the syringe) requires reaching the
  // tree. Quest is still considered complete (per the storybook
  // "your Quest is complete!" copy on page 2.6), so we continue
  // into the Chapter 2 Town Visit.
  const q2W3DefeatComplete = wrap.querySelector<HTMLButtonElement>("[data-action=q2-w3-defeat-complete]");
  if (q2W3DefeatComplete) {
    q2W3DefeatComplete.addEventListener("click", withTypewriterSkipFirst(() => {
      runEowChain(q2W3DefeatComplete, "q2-w3-defeat-complete", async (step) => {
        step("collect-dying");
        const dying = collectDyingHeroes(router.state);
        step("present-graveyard");
        await presentGraveyardEntries(dying, router.state);
        step("apply-card-loss");
        applyHeroCardLossForDeaths(router.state);
        step("complete-wave");
        completeWave(router.state);
        step("end-quest-reset");
        endQuestReset(router.state);
        step("clear-ephemera");
        clearWavePhaseEphemera();
        clearAllUiState();
        resetEndOfWaveUiState();
        step("route");
        routeToCh2OrTitle(router, "died");
      });
    }));
  }
}

/**
 * Wrap an async end-of-wave click handler with comprehensive error
 * handling + step logging.
 *
 * The previous shape of these handlers was a bare `void presentXxx().then(...)`
 * chain; if anything threw mid-chain, the `void` discarded the
 * rejection silently and the player was left with "the button does
 * nothing" and zero log trail. A real bug surfaced exactly that way
 * on Q2 W2 defeat (2026-05-23) — `routeToCh2OrTitle` was never
 * reached, but no error was visible anywhere.
 *
 * This helper fixes that pattern in three ways:
 *  1. **Button-disable.** The button is disabled the moment the
 *     chain starts and only re-enabled on error (success navigates
 *     away). Rapid re-clicks during in-flight chains used to start
 *     parallel chains, multiplying the failure modes — now they're
 *     simply ignored.
 *  2. **Step logging.** The caller's `run` callback receives a
 *     `step(name)` function it calls before each meaningful sub-step.
 *     Each call writes a `ui.eowChain.step` log row so a stuck or
 *     thrown handler shows EXACTLY which step it was on.
 *  3. **Error surfacing.** Any thrown error is caught, logged with
 *     the failing step name and stack, and surfaced to the player
 *     via `alert(...)` so they know to share the log rather than
 *     suffer in silence on a dead screen.
 */
function runEowChain(
  button: HTMLButtonElement,
  chainName: string,
  run: (step: (name: string) => void) => Promise<void>,
): void {
  if (button.disabled) {
    logEvent("ui.eowChain.click.ignored", {
      chainName,
      reason: "already-processing",
    });
    return;
  }
  button.disabled = true;
  let currentStep = "start";
  const step = (name: string): void => {
    currentStep = name;
    logEvent("ui.eowChain.step", { chainName, step: name });
  };
  logEvent("ui.eowChain.start", { chainName });
  void (async () => {
    try {
      await run(step);
      logEvent("ui.eowChain.complete", { chainName });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      logEvent("ui.eowChain.error", {
        chainName,
        failedStep: currentStep,
        message,
        stack,
      });
      button.disabled = false;
      if (typeof window !== "undefined" && typeof window.alert === "function") {
        window.alert(
          `End-of-wave action "${chainName}" failed at step "${currentStep}":\n${message}\n\nPress \`~\` to view the log and share it with the developer.`,
        );
      }
      throw err;
    }
  })();
}

/**
 * Route the Q2 end-of-wave terminus into the Chapter 2 Town Visit.
 *
 * \u2022 Fresh campaign (Ch2 not yet completed): anchor the visit
 *   DIRECTLY on the survival branch implied by the wave outcome \u2014
 *   `page22-both-survived` for victory, `page22-died` for defeat \u2014
 *   skipping the manual `page22-entry` fork. The game already knows
 *   which delvers fell during the wave so asking the player to
 *   re-tell that story is friction. Both destination pages still
 *   `record-decision` for `ch2.entry.both-survived` /
 *   `ch2.entry.died` on enter, so decision-tracking parity with the
 *   old "player picks" flow is preserved.
 * \u2022 Already-completed Ch2 (debug replays, future Q2 re-runs):
 *   bounce straight back to title \u2014 the visit only happens once
 *   per campaign just like Ch1.
 *
 * Idempotency note: `startTownVisit` defends against a double-set
 * if `state.townVisit` is already non-null, but we explicitly
 * pre-set the page id here so the router lands on the correct
 * page on the first render (the engine's lazy bootstrap in
 * `TownVisit.ts` would default to `ch1` which would be wrong).
 */
function routeToCh2OrTitle(
  router: Router,
  outcome: "both-survived" | "died",
): void {
  if (router.state.townVisit2Completed) {
    logEvent("engine.routeToCh2OrTitle.skip", { reason: "ch2-already-completed" });
    router.goTo({ name: "title" });
    return;
  }
  const pageId = outcome === "both-survived"
    ? "page22-both-survived"
    : "page22-died";
  router.state.townVisit = {
    chapterId: "ch2",
    pageId,
    pagesEntered: [],
  };
  logEvent("engine.routeToCh2OrTitle.enter", {
    chapterId: "ch2",
    pageId,
    outcome,
  });
  router.goTo({ name: "townVisit" });
}

/**
 * Module-local branch state for the Q2 W1 defeat two-step UI.
 * `"initial"` = show page2_1 + Retreat/Continue buttons. Either
 * pick flips to `"retreat"` / `"continue"` and re-renders with the
 * follow-up prose + a single "Try again" button. Reset to
 * `"initial"` after the retry commits and after a Q2 victory routes
 * out (so future end-of-wave entries start fresh).
 *
 * Not persisted: a browser refresh resets to `"initial"` which is
 * fine \u2014 the player just sees the parent page and reselects.
 */
let endOfWaveBranch: "initial" | "retreat" | "continue" = "initial";

/**
 * Module-local branch state for the Q2 W2 victory two-step UI
 * (page 2.5). The screen is split into two sequential pages:
 *   `"initial"`      \u2014 first paragraph (Witness recovers the
 *                       surveillance device) + a single COLLECT
 *                       REWARD button. Clicking it grants Key Item
 *                       #1 via the rewards modal, then advances
 *                       to the next step.
 *   `"after-reward"` \u2014 second paragraph (faint shouts in the
 *                       distance) + the two branch buttons
 *                       (RETURN TO TOWN \u00b7 A / FOLLOW THE SHOUTS
 *                       \u00b7 B). The Key Item is NOT re-granted
 *                       here \u2014 it already fired in step 1.
 * Reset to `"initial"` on commit so future end-of-wave entries
 * start fresh.
 */
let q2W2VictoryStep: "initial" | "after-reward" = "initial";

/**
 * Reset all module-local end-of-wave UI state. Called whenever an
 * end-of-wave transition COMMITS (advances to the next wave, the
 * Town Visit, the title, or a retry). Centralises the latch reset
 * so future state additions only have to land in one place.
 */
function resetEndOfWaveUiState(): void {
  endOfWaveBranch = "initial";
  q2W2VictoryStep = "initial";
}

/**
 * Headline for the End-of-Wave page. Q1 W1 stays at the two
 * fixed strings (preserving the Q1 player's experience exactly).
 * Q2 uses quest-flavored headlines that key off (waveNumber,
 * outcome, defeatBranch, q2W2VictoryStep) so multi-wave + multi-
 * branch flows stay distinct on the page.
 */
function renderEndOfWaveHeadline(args: {
  isQuest2: boolean;
  outcome: "victory" | "defeat";
  q2WaveNumber: number;
  q2DefeatStep: "initial" | "retreat" | "continue";
  q2W2VictoryStep: "initial" | "after-reward";
}): string {
  const { isQuest2, outcome, q2WaveNumber, q2DefeatStep, q2W2VictoryStep } = args;
  if (!isQuest2) {
    return outcome === "victory" ? "You reached the buoy" : "You fell to the Tide";
  }
  if (q2WaveNumber === 1) {
    if (outcome === "victory") return "Wave 1 complete";
    if (q2DefeatStep === "retreat") return "You retreat to town";
    if (q2DefeatStep === "continue") return "You push through";
    return "Delver fallen";
  }
  if (q2WaveNumber === 2) {
    // Both halves of the two-step W2 victory screen share the
    // same headline so the prose flip reads as a continuation of
    // the same scene rather than a separate beat.
    if (outcome === "victory") {
      if (q2W2VictoryStep === "after-reward") return "The surveillance device";
      return "The surveillance device";
    }
    return "Witness recovers the device";
  }
  // Q2 Wave 3 — page 2.6 (defeat) / page 2.7 (victory).
  if (outcome === "victory") return "You collect the syringe";
  return "The mist takes you both";
}

/**
 * Pick the right action-button layout for the (quest, wave,
 * outcome, branch) combo. Returns raw HTML (the caller's
 * `wrap.querySelector` event wiring matches via `[data-action]`).
 *
 * Q2 W1 victory shipped the inline element picker; the action
 * row's "Continue \u2192 Wave 2" button is gated on every delver
 * having committed `ELEMENT_GRANT_PER_DELVER_Q2_W1` picks (page
 * 2.3 grants "3 elements of your choice" per delver). Disabled
 * until the picker reports ready — the picker DOM itself toggles
 * the disabled attr on each click.
 */
function renderEndOfWaveActions(args: {
  isQuest2: boolean;
  outcome: "victory" | "defeat";
  isFirstQuestClear: boolean;
  q2DefeatStep: "initial" | "retreat" | "continue";
  q2WaveNumber: number;
  q2W2VictoryStep: "initial" | "after-reward";
  /** Quest #2 victory: the wave's continue-choice buttons (or the
   *  picked choice's Continue button). See `renderQ2ContinueChoicesHtml`. */
  q2ContinueHtml: string;
}): string {
  const {
    isQuest2,
    outcome,
    isFirstQuestClear,
    q2DefeatStep,
    q2WaveNumber,
    q2W2VictoryStep,
    q2ContinueHtml,
  } = args;
  if (isQuest2) {
    if (q2WaveNumber === 1) {
      // Victory: the storybook continue choices (they replace the old
      // "3 elements" picker and the Wave 2 Scenario Card).
      if (outcome === "victory") return q2ContinueHtml;
      if (q2DefeatStep === "initial") {
        return `
          <button class="btn btn--primary" data-action="q2-defeat-retreat">Fall back to town</button>
          <button class="btn btn--primary" data-action="q2-defeat-continue">Push through the mist</button>
        `;
      }
      return `
        <button class="btn btn--primary" data-action="q2-defeat-retry">Start Wave 1 Again</button>
      `;
    }
    if (q2WaveNumber === 2) {
      if (outcome === "victory") {
        // page 2.5 split into two sequential screens (per user
        // request 2026-05-20). Step 1 (`"initial"`) shows the
        // Witness-recovers-camera prose with a single COLLECT
        // REWARD button that fires the Key Item #1 rewards modal,
        // then advances to step 2. Step 2 (`"after-reward"`) swaps
        // in the faint-shouting prose and shows the original two
        // choice buttons (RETURN TO TOWN \u00b7 A / FOLLOW THE
        // SHOUTS \u00b7 B). No `btn--ready` pulse on any of these
        // \u2014 EOW phase is a deliberate review screen.
        if (q2W2VictoryStep === "after-reward") {
          // Return to Town, or one of the continue choices (which
          // replace the Wave 3 Scenario Card). Once a choice is picked
          // only its Continue button shows.
          const picked = q2ContinueHtml.includes('data-action="q2-continue-next"');
          return `
            ${picked ? "" : `<button class="btn btn--accent" data-action="q2-w2-return-town">A - Return to Town (Quest complete)</button>`}
            ${q2ContinueHtml}
          `;
        }
        return `
          <button class="btn btn--accent" data-action="q2-w2-collect-reward">Collect Reward</button>
        `;
      }
      // Q2 Wave 2 defeat \u2014 page 2.4. Witness collects the
      // device, quest is still considered complete with Key Item #1.
      return `
        <button class="btn btn--accent" data-action="q2-w2-quest-complete">Return to Title (Quest complete)</button>
      `;
    }
    // Q2 Wave 3 \u2014 page 2.7 (victory) / page 2.6 (defeat).
    // Victory grants Key Item #2 (the abandoned syringe) on
    // top of Key Item #1; defeat leaves the player with
    // whatever Key Items they already collected. Both terminate
    // the quest and route back to title.
    if (outcome === "victory") {
      return `
        <button class="btn btn--accent" data-action="q2-w3-victory-complete">Return to Title (Quest complete)</button>
      `;
    }
    return `
      <button class="btn btn--accent" data-action="q2-w3-defeat-complete">Return to Title (Quest complete)</button>
    `;
  }
  if (outcome === "victory") {
    // "View Campaign Sheet" peek-only button removed 2026-05-21
    // (user request): at this beat the only narrative-correct next
    // step is to continue into the Town Visit (or replay back to
    // title); peeking at the campaign sheet here is a side-trip
    // that pulls focus from the quest-clear payoff. The campaign
    // sheet stays reachable from the Title screen at any time.
    return isFirstQuestClear
      ? `
        <button class="btn btn--primary" data-action="continue-town">Continue \u2192 Chapter 1: Town Visit</button>
      `
      : `
        <button class="btn btn--primary" data-action="finish-replay">Finish Quest \u2192 Return to Title</button>
      `;
  }
  return `
    <button class="btn btn--primary" data-action="retry">Try Again</button>
    <button class="btn btn--ghost" data-action="finish-defeat">Return to Title</button>
  `;
}


// --- Quest #2 storybook continue choices -----------------------------------
//
// The victory page offers the wave's `continueChoices` (data/quest2.json)
// in place of the old fixed bonus and the next wave's Scenario Card. The
// results are printed on each button. A Key-Item bonus option shows on
// every playthrough but is only selectable while the party owns the item.
// Picking a choice swaps in its result page; Continue then sets up the
// next wave and applies the choice's effects there.

/** The continue choice the party picked this End of Wave, if any. */
function q2ContinuePick(state: CampaignState, wave: import("../types").QuestWave): import("../types").QuestEowChoice | null {
  const idx = state.encounter?.eowContinuePick;
  if (idx == null) return null;
  const choice = wave.continueChoices?.[idx];
  if (!choice) throw new Error(`Quest #2 wave ${wave.number} has no continue choice ${idx}`);
  return choice;
}

function ownsKeyItem(state: CampaignState, number: number): boolean {
  return state.keyItems.some((k) => k.number === number);
}

/**
 * Button text for an End-of-Wave choice. A Key-Item bonus leads with its
 * lock right after the option letter ("D - 🔒 Requires Key Item #3 Woo's
 * Diary: Follow Woo's directions: ..."), so the requirement reads first;
 * once the party owns the item the lock becomes a key.
 */
function eowChoiceLabelHtml(state: CampaignState, c: import("../types").QuestEowChoice): string {
  if (c.requireKeyItem === undefined) return escapeHtml(c.label);
  const locked = !ownsKeyItem(state, c.requireKeyItem);
  const gate = `${locked ? "🔒 Requires" : "🔑"} Key Item #${c.requireKeyItem} ${getKeyItem(c.requireKeyItem).name}:`;
  const gateHtml = `<span class="eow-continue-choice-gate">${escapeHtml(gate)}</span>`;
  const m = /^([A-Z]) - ([\s\S]*)$/.exec(c.label);
  return m ? `${escapeHtml(m[1]!)} - ${gateHtml} ${escapeHtml(m[2]!)}` : `${gateHtml} ${escapeHtml(c.label)}`;
}

function renderQ2ContinueChoicesHtml(state: CampaignState, wave: import("../types").QuestWave): string {
  const choices = wave.continueChoices ?? [];
  if (choices.length === 0) return "";
  const nextWave = wave.number + 1;
  if (q2ContinuePick(state, wave)) {
    return `<button class="btn btn--accent" data-action="q2-continue-next">Continue → Wave ${nextWave}</button>`;
  }
  return choices.map((c, i) => {
    const gate = c.requireKeyItem;
    const locked = gate !== undefined && !ownsKeyItem(state, gate);
    return `
      <button class="btn btn--primary eow-continue-choice${gate !== undefined ? " eow-continue-choice--bonus" : ""}"
              data-q2-continue-choice="${i}" ${locked ? "disabled" : ""}>
        ${eowChoiceLabelHtml(state, c)}
      </button>`;
  }).join("");
}

function wireQ2ContinueChoices(
  wrap: HTMLElement,
  router: Router,
  quest: import("../types").Quest,
  wave: import("../types").QuestWave,
): void {
  wrap.querySelectorAll<HTMLButtonElement>("[data-q2-continue-choice]").forEach((btn) => {
    btn.addEventListener("click", withTypewriterSkipFirst(() => {
      const idx = Number(btn.dataset.q2ContinueChoice);
      const choice = wave.continueChoices![idx]!;
      if (choice.requireKeyItem !== undefined && !ownsKeyItem(router.state, choice.requireKeyItem)) return;
      router.state.encounter!.eowContinuePick = idx;
      logEvent("click.q2-continue-choice", { wave: wave.number, pick: idx, label: choice.label });
      router.save();
    }));
  });

  const next = wrap.querySelector<HTMLButtonElement>("[data-action=q2-continue-next]");
  if (!next) return;
  next.addEventListener("click", withTypewriterSkipFirst(() => {
    const choice = q2ContinuePick(router.state, wave)!;
    const nextWave = wave.number + 1;
    runEowChain(next, "q2-continue-next", async (step) => {
      step("complete-wave");
      completeWave(router.state);
      step("bootstrap-next");
      const events = bootstrapNextWave(router.state, quest, nextWave);
      step("carry-effects");
      events.push(...(choice.carryEffects ?? []).flatMap((e) => applyQuestCarryEffect(router.state, e)));
      step("present-rewards");
      await presentRewards(document.body, events);
      step("boss-card-back");
      await presentBossCardBackAndPicks(router.state, router, nextWave);
      step("route-board");
      clearWavePhaseEphemera();
      clearAllUiState();
      resetEndOfWaveUiState();
      router.goTo({ name: "board" });
    });
  }));
}

// --- Data-driven End of Wave (Ch3+ quests) --------------------------------

// The picked option and the picked Shop Products live on the encounter
// (`eowContinuePick` / `eowShopPicks`), not the screen, so in online co-op
// the watching player sees the same pick and the same product picker.

function renderGenericEndOfWave(
  root: HTMLElement,
  router: Router,
  enc: EncounterState,
  quest: import("../types").Quest,
  wave: import("../types").QuestWave,
  outcome: "victory" | "defeat",
): void {
  const eow = wave.eow!;
  stopActiveTypewriter();
  const pickIdx = enc.eowContinuePick ?? null;
  const picked = outcome === "victory" && pickIdx !== null ? eow.victory[pickIdx] ?? null : null;
  const shopPicks = enc.eowShopPicks ?? [];
  const pageId = outcome === "defeat" ? eow.defeat.pageId
    : picked ? picked.pageId
    : wave.endOfWave.bothSurvive;
  const text = quest.pages[pageId];
  if (text === undefined) throw new Error(`Quest ${quest.id} is missing page ${pageId}`);
  const questLabel = `${questDisplayLabel(quest.id)}, Wave ${enc.waveNumber}`;
  const nextWaveNumber = (picked?.then === "next-wave" && picked.nextWaveNumber) || enc.waveNumber + 1;
  const nextWave = quest.waves.find((w) => w.number === nextWaveNumber) ?? null;

  const shopPick = outcome === "victory" ? picked?.pickShopProducts ?? null : null;
  const eligiblePicks = shopPick ? eligibleShopProductPicks(router.state, shopPick.from) : [];
  const picksNeeded = shopPick ? Math.min(shopPick.count, eligiblePicks.length) : 0;
  const pickerHtml = shopPick ? renderShopProductPicker(shopPick, eligiblePicks, picksNeeded, shopPicks) : "";

  let actionsHtml: string;
  if (outcome === "defeat" || picked?.then === "end-quest") {
    const waiting = shopPick !== null && shopPicks.length !== picksNeeded;
    actionsHtml = `<button class="btn btn--accent" data-action="generic-eow-end" ${waiting ? "disabled" : ""}>Return to Bird's Nest</button>`;
  } else if (picked) {
    if (!nextWave) throw new Error(`Quest ${quest.id} wave ${enc.waveNumber} continues to a wave that doesn't exist`);
    actionsHtml = `<button class="btn btn--accent" data-action="generic-eow-next">Continue \u2192 Wave ${nextWave.number}</button>`;
  } else {
    actionsHtml = eow.victory
      .map((c, i) => {
        const locked = c.requireKeyItem !== undefined && !ownsKeyItem(router.state, c.requireKeyItem);
        const bonus = c.requireKeyItem !== undefined ? " eow-continue-choice--bonus" : "";
        return `<button class="btn btn--primary eow-continue-choice${bonus}" data-eow-choice="${i}" ${locked ? "disabled" : ""}>${eowChoiceLabelHtml(router.state, c)}</button>`;
      })
      .join("");
  }

  const wrap = document.createElement("div");
  wrap.className = "screen screen--board screen--phase screen--end-of-wave screen--ch2";
  wrap.innerHTML = `
    <div class="board-topbar">
      <div class="board-topbar-goal">
        <strong>End of Wave - ${outcome === "victory" ? "Victory" : "Defeat"}</strong>
        <span class="muted small"> &middot; ${escapeHtml(questLabel)}${/^quest\d+$/.test(quest.id) ? `: ${escapeHtml(quest.name)}` : ""}</span>
      </div>
    </div>
    <div class="end-of-wave-stage">
      <div class="story-stage-row">
        <article class="storybook-page">
          <h2>${outcome === "victory" ? `Wave ${enc.waveNumber} Survived` : "The Mist Takes You"}</h2>
          <div class="storybook-text" data-story-text>${formatNarrativeWithTypewriterSpans(text)}</div>
        </article>
      </div>
      ${renderEndWaveRefreshHtml(enc)}
      ${pickerHtml}
      <div class="end-of-wave-actions">${actionsHtml}</div>
    </div>
  `;
  root.appendChild(wrap);
  startTypewriter(wrap.querySelector<HTMLElement>("[data-story-text]")!);
  wireSkipOnClick(wrap);

  wrap.querySelectorAll<HTMLButtonElement>("[data-shop-pick]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const n = Number(btn.dataset.shopPick);
      const next = shopPicks.includes(n) ? shopPicks.filter((x) => x !== n)
        : shopPicks.length < picksNeeded ? [...shopPicks, n] : shopPicks;
      enc.eowShopPicks = next;
      logEvent("click.generic-eow-shop-pick", { product: n, picks: next });
      router.save();
    });
  });

  wrap.querySelectorAll<HTMLButtonElement>("[data-eow-choice]").forEach((btn) => {
    btn.addEventListener("click", withTypewriterSkipFirst(() => {
      const idx = Number(btn.dataset.eowChoice);
      const choice = eow.victory[idx]!;
      if (choice.requireKeyItem !== undefined && !ownsKeyItem(router.state, choice.requireKeyItem)) return;
      enc.eowContinuePick = idx;
      logEvent("click.generic-eow-choice", { questId: quest.id, wave: enc.waveNumber, pick: idx });
      router.save();
    }));
  });

  const nextBtn = wrap.querySelector<HTMLButtonElement>("[data-action=generic-eow-next]");
  if (nextBtn && picked && nextWave) {
    nextBtn.addEventListener("click", withTypewriterSkipFirst(() => {
      runEowChain(nextBtn, "generic-eow-next", async (step) => {
        step("rewards");
        const events = (picked.rewards ?? []).flatMap((a) => runTownVisitAction(router.state, a));
        step("complete-wave");
        completeWave(router.state);
        step("bootstrap-next");
        events.push(...bootstrapNextWave(router.state, quest, nextWave.number));
        step("carry-effects");
        for (const effect of picked.carryEffects ?? []) {
          events.push(...applyQuestCarryEffect(router.state, effect));
        }
        step("present-rewards");
        await presentRewards(document.body, events);
        step("boss-card-back");
        await presentBossCardBackAndPicks(router.state, router, nextWave.number);
        step("route-board");
        clearWavePhaseEphemera();
        clearAllUiState();
        resetEndOfWaveUiState();
        router.goTo({ name: "board" });
      });
    }));
  }

  const endBtn = wrap.querySelector<HTMLButtonElement>("[data-action=generic-eow-end]");
  if (endBtn) {
    endBtn.addEventListener("click", withTypewriterSkipFirst(() => {
      runEowChain(endBtn, "generic-eow-end", async (step) => {
        step("rewards");
        const rewards = outcome === "defeat" ? (eow.defeat.rewards ?? []) : (picked?.rewards ?? []);
        const events = rewards.flatMap((a) => runTownVisitAction(router.state, a));
        if (shopPick) {
          events.push(...resolveShopProductPicks(router.state, shopPick.from, shopPick.count, shopPicks, quest.name));
        }
        await presentRewards(document.body, events);
        step("graveyard");
        const dying = collectDyingHeroes(router.state);
        await presentGraveyardEntries(dying, router.state);
        applyHeroCardLossForDeaths(router.state);
        step("end-quest");
        completeWave(router.state);
        endQuestReset(router.state);
        clearWavePhaseEphemera();
        clearAllUiState();
        resetEndOfWaveUiState();
        step("route");
        // Ch3+ quests are launched from a Town Visit (the Quest Report);
        // the visit stays active while the quest runs, so return to it.
        router.goTo(router.state.townVisit ? { name: "townVisit" } : { name: "title" });
      });
    }));
  }
}

/** Product picker for a `pickShopProducts` End-of-Wave reward. */
function renderShopProductPicker(
  pick: { from: number[]; count: number },
  eligible: readonly number[],
  needed: number,
  picks: readonly number[],
): string {
  const tiles = pick.from.map((n) => {
    const product = getShopProduct(n);
    const img = shopProductImageOrNull(n);
    const canPick = eligible.includes(n);
    const chosen = picks.includes(n);
    const full = !chosen && picks.length >= needed;
    const title = canPick ? `#${n} ${product.name}` : `#${n} ${product.name} - already available or owned`;
    return `
      <button class="eow-shop-pick${chosen ? " eow-shop-pick--chosen" : ""}" data-shop-pick="${n}"
              ${!canPick || full ? "disabled" : ""} title="${escapeHtml(title)}" aria-pressed="${chosen}">
        ${img ? `<img src="/shop-products/${img}" alt="${escapeHtml(product.name)}" />` : `<span>#${n} ${escapeHtml(product.name)}</span>`}
      </button>`;
  }).join("");
  const shortfall = pick.count - needed;
  const note = shortfall > 0
    ? `Only ${needed} can still be added - you gain ${shortfall} Memory Chip token${shortfall === 1 ? "" : "s"} instead of the rest.`
    : `Choose ${needed}.`;
  return `
    <section class="eow-shop-picker">
      <h3>Choose ${pick.count} Shop Products (${picks.length}/${needed} picked)</h3>
      <p class="small muted">${escapeHtml(note)}</p>
      <div class="eow-shop-pick-grid">${tiles}</div>
    </section>`;
}


/**
 * Append Key Item #1 (the Surveillance Camera) to the campaign's
 * key-items list, idempotent on re-grant. Mirrors the
 * `gain-key-item` town-visit action so the EOW path produces the
 * same campaign-sheet line. Name is captured from the printed
 * Key Item card; the storybook references it as "Key Item #1".
 */
function grantSurveillanceCameraKeyItem(state: CampaignState): void {
  const number = 1;
  const name = "Surveillance Camera";
  const already = state.keyItems.some((k) => k.number === number);
  if (already) {
    logEvent("engine.q2.grantKeyItem.skip", { number, reason: "already-owned" });
    return;
  }
  state.keyItems.push({ number, name, clues: getKeyItem(number).clues });
  logEvent("engine.q2.grantKeyItem", {
    number,
    name,
    keyItemsAfter: state.keyItems.map((k) => k.number),
  });
}

/**
 * Q2 W3 victory grant \u2014 the abandoned syringe the fleeing
 * strangers dropped by the diseased tree (page 2.7). Same
 * shape + idempotency as the Surveillance Camera grant, just a
 * different (number, name) pair. Storybook references it as
 * "Key Item #2" and the catalog name is "Abandoned Syringe".
 */
function grantAbandonedSyringeKeyItem(state: CampaignState): void {
  const number = 2;
  const name = "Abandoned Syringe";
  const already = state.keyItems.some((k) => k.number === number);
  if (already) {
    logEvent("engine.q2.grantKeyItem.skip", { number, reason: "already-owned" });
    return;
  }
  state.keyItems.push({ number, name, clues: getKeyItem(number).clues });
  logEvent("engine.q2.grantKeyItem", {
    number,
    name,
    keyItemsAfter: state.keyItems.map((k) => k.number),
  });
}

/**
 * Capture which of the requested Q2 key item numbers are NEW for
 * this campaign, then apply the grants. Returns the
 * `key-item-gained` reward events for the modal — empty for an
 * already-owned item (debug replays), populated for fresh grants.
 *
 * Why capture-then-grant instead of just diffing post-grant: the
 * grant helpers each log a "skip" event when the item is already
 * owned, which is the signal we want to mirror in the reward modal
 * (no card surfaced for skipped grants).
 */
function grantQ2KeyItemsAndCollectNew(
  state: CampaignState,
  numbers: ReadonlyArray<1 | 2>,
): RewardEvent[] {
  const ownedBefore = new Set(state.keyItems.map((k) => k.number));
  const events: RewardEvent[] = [];
  for (const n of numbers) {
    if (n === 1) {
      grantSurveillanceCameraKeyItem(state);
      if (!ownedBefore.has(1)) {
        events.push({ kind: "key-item-gained", number: 1, name: "Surveillance Camera" });
      }
    } else {
      grantAbandonedSyringeKeyItem(state);
      if (!ownedBefore.has(2)) {
        events.push({ kind: "key-item-gained", number: 2, name: "Abandoned Syringe" });
      }
    }
  }
  return events;
}

/**
 * Open the rewards modal (centered overlay, key item card art)
 * for the given key-item-gained events and resolve when the player
 * dismisses it (Continue button, backdrop click, or Escape/Enter/
 * Space). Empty input resolves immediately so callers can pipe
 * through unconditionally and let `presentRewards` handle the
 * "nothing new to show" case.
 *
 * Mounted on `document.body` rather than the wave-phase wrap so the
 * `position: fixed` overlay isn't constrained by the screen's flex
 * layout \u2014 matches how Shop.ts mounts its variant.
 */
function presentKeyItemRewards(events: RewardEvent[]): Promise<void> {
  return presentRewards(document.body, events);
}

/**
 * Collect the set of delvers who are currently at 0 HP (dead) AND
 * have a non-exempt active hero card that `applyHeroCardLossForDeaths`
 * will discard. Called BEFORE `applyHeroCardLossForDeaths` so
 * `state.activeHeroCardByDelver` still points at the doomed card.
 */
function collectDyingHeroes(
  state: import("../state").CampaignState,
): PendingGraveyardEntry[] {
  const enc = state.encounter;
  if (!enc) return [];
  // Mirrors the exempt-wave check in applyHeroCardLossForDeaths.
  if (enc.questId === "quest1") return [];
  if (enc.questId === "quest2" && enc.waveNumber === 1) return [];

  const entries: PendingGraveyardEntry[] = [];
  for (const heroId of Object.keys(state.loadouts)) {
    const lo = state.loadouts[heroId];
    if (!lo || lo.currentHp > 0) continue;
    const cardNumber = state.activeHeroCardByDelver[heroId];
    if (cardNumber == null) continue;
    let cardName = `Hero #${String(cardNumber).padStart(2, "0")}`;
    try { cardName = getHeroCard(cardNumber).name; } catch { /* keep fallback */ }
    entries.push({
      heroId,
      cardNumber,
      cardName,
      questId: enc.questId,
      waveNumber: enc.waveNumber,
    });
  }
  return entries;
}

// --- Shared helpers -------------------------------------------------------

/**
 * Read-only token rendering — no clicks, no movement overlay, no
 * action targets. Reuses the tide-board cell-rect helpers so the
 * positions match the Hero Phase board pixel-for-pixel.
 */
function renderTokensReadOnly(layer: HTMLDivElement, tokens: BoardToken[]): void {
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
    // See BoardScreen.renderTokens for the rationale: delvers + the
    // Witness companion share `humanoidStackOffset` (triangle for 3)
    // so a fully-stacked spawn tile fits inside the cell.
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
      const el = document.createElement("div");
      el.className = `board-token board-token--delver board-token--delver-${suit}`;
      el.style.left = `${left + stackOffsetPct}%`;
      el.style.top  = `${top + stackOffsetYPct}%`;
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
      el.style.top  = `${top + stackOffsetYPct}%`;
      el.style.width  = `${CELL_SIZE_PCT * 0.35}%`;
      el.style.height = `${CELL_SIZE_PCT * 0.35}%`;
      el.textContent = t.label;
      el.title = t.name;
      layer.appendChild(el);
      continue;
    }

    if (t.kind === "memory-fragment") {
      // Same anchor + sizing rules as BoardScreen.renderTokens
      // (bottom-right corner, 30% of a cell). Kept inline so this
      // read-only renderer doesn't gain a dependency on the
      // interactive BoardScreen path.
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

    const enemy = t.cardId ? getEnemy(t.cardId) : null;
    const { wPct, hPct } = cellSizePct(t.col, t.row);
    const el = document.createElement("div");
    el.className = `board-tile board-tile--${t.kind}`;
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
    // Mirror BoardScreen: rotate the entire enemy tile container so
    // the card art AND the HP heart overlay rotate together. The
    // CSS variable composes with `.board-tile`'s base transform.
    if (t.facing) {
      el.style.setProperty("--enemy-rotation", `${t.facing}deg`);
    }
    layer.appendChild(el);
  }
}

function paintEnemyHighlight(layer: HTMLDivElement, x: number, y: number): void {
  const { left, top } = cellCenterPct(x, y);
  const { wPct, hPct } = cellSizePct(x, y);
  const el = document.createElement("div");
  el.className = "board-target board-target--phase";
  el.style.left = `${left}%`;
  el.style.top = `${top}%`;
  el.style.width = `${wPct}%`;
  el.style.height = `${hPct}%`;
  el.title = `Resolving parting shot at (${x}, ${y})`;
  layer.appendChild(el);
}

function heroLabel(heroId: string): string {
  const hero = getHero(heroId);
  return hero.suit === "mind" ? "Mind" : "Body";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
