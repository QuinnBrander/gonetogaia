/**
 * `QaSession` — the central object scenarios drive. Bundles:
 *
 *   - A campaign state (built fresh via `newCampaign`).
 *   - A seeded RNG (`mulberry32`) so monkey runs are reproducible.
 *   - An ordered trace of every action that ran (used by the bug
 *     report writer to produce a reproducer).
 *   - A list of invariant violations found along the way.
 *
 * Action methods are thin wrappers around engine APIs that:
 *   1. Push a `TraceEntry` onto `session.trace` BEFORE the engine
 *      call (so a thrown error still leaves the trace pointing at
 *      the offending action).
 *   2. Call the engine.
 *   3. Run `checkAllInvariants(state)` and push any violations
 *      onto `session.bugs` with the action's trace position so
 *      a single violation can be cross-referenced back to the
 *      action that caused it.
 *
 * Scenarios can also call `session.checkpoint(label)` to mark
 * milestone moments in the trace ("after ch1 completed",
 * "after q2 wave 1") — these help the bug report tell a story
 * rather than just dumping 200 raw action lines.
 *
 * Action methods deliberately throw on engine error rather than
 * returning a discriminated reject. The runner catches the throw
 * and writes it up as a bug if the scenario didn't expect it.
 * This keeps scenario code linear (no `if (err) return` after
 * every line).
 */

import {
  applyOnEnter,
  chooseTownVisitOption,
  advanceTownVisitPage,
  currentTownVisitPage,
  finishTownVisit,
  startTownVisit,
  purchaseShopProduct,
  redeemVeraAlly,
  redeemFloresAlly,
  runTownVisitAction,
  setTownVisitPage,
  convertBossPartToMinion,
  visibleTownVisitChoices,
} from "../engine/townVisit";
import { donateToAcademy } from "../engine/academyDonation";
import { redeemElaynaAlly, redeemRodrigoAlly } from "../engine/opinionRedeem";
import {
  applyOpinionGrantsForQuest,
  applyOpinionRankPick,
  eligibleEquipmentTypesForPick,
} from "../engine/opinionGrants";
import {
  assignDelverToTile,
  assignWitnessToTile,
  bootstrapWaveAtNumber,
  getDelverAt,
  getEnemyAt,
  getSpawnCard,
  startWaveAfterPick,
  commitFirstTurnPick,
} from "../engine/encounter";
import {
  endHeroTurn,
  playWeaponCard,
  prepareToRun,
  spendApDoubleMovement,
  spendApRefreshWeapon,
  startHeroTurn,
  useSlotAbility,
  useWeaponAbility,
  type TurnActionResult,
  type UseAbilityResult,
  type UseSlotAbilityResult,
  type WeaponAbilityParams,
} from "../engine/turn";
import {
  endMovementStep,
  legalStepDestinations,
  moveDelverStep,
  type MoveResult,
} from "../engine/movement";
import type { SlotAbilityParams } from "../engine/slotAbilities";
import {
  completeWave,
  endQuestReset,
  resolvePartingShot,
  bootstrapNextWave,
} from "../engine/wave";
import { debugWinWave } from "../engine/debugCommands";
import {
  finalizeAttackSession,
  resolveAllDamage,
  resolveSharedCounter,
  type AttackSession,
} from "../engine/combat";
import {
  applyLevelUpChoice,
  getLevelUpCard,
  peekNextPendingDraw,
} from "../engine/levelUp";
import { applyElementChoice, peekNextPendingElementChoice } from "../engine/os";
import { applyXpRoll, peekNextPendingXpRoll } from "../engine/kills";
import {
  applyCreaturePartChoice,
  availableCreaturePartDropsForHero,
  peekNextPendingCreaturePartChoice,
  skipCreaturePartChoice,
} from "../engine/creatureParts";
import {
  applyEquipmentRoll,
  equipmentRollTableForCard,
  outcomeForRoll,
  peekNextPendingEquipmentRoll,
} from "../engine/tokens";
import {
  getDelverBoard,
  getEquipment,
  getEquipmentByTypeSuit,
  getHero,
  getKeyItem,
  getQuestData,
} from "../data";
import type { Element } from "../types";
import { newCampaign, type CampaignState } from "../state";
import type { EquipmentType, RewardEvent, TownVisitAction } from "../types";
import { ALL_EQUIPMENT_TYPES } from "../types";
import { checkAllInvariants, type InvariantViolation } from "./invariants";
import { mulberry32 } from "./seededRandom";

/** One entry in the action trace. The runner serializes these
 *  into the bug report's reproducer steps. */
export interface TraceEntry {
  /** Monotonic step index (`session.trace.length` at push time). */
  step: number;
  /** Action kind — `"startTownVisit"`, `"choose"`, `"donate"`, etc. */
  kind: string;
  /** JSON-serialisable payload of the action arguments. */
  payload: unknown;
  /** Wall-clock-ish ordering only. NOT used for reproduction. */
  recordedAtMs: number;
  /** Optional human label set by `session.checkpoint`. */
  checkpoint?: string;
}

/** One captured bug — an invariant violation tied to the action
 *  that triggered it. */
export interface SessionBug {
  /** Index into `session.trace` of the action that caused this. */
  triggeringStep: number;
  /** The trace entry itself, copied so a later mutation of the
   *  payload can't retroactively change a bug report. */
  triggeringAction: TraceEntry;
  /** The actual invariant violation reported by `checkAllInvariants`. */
  violation: InvariantViolation;
}

/** An expected-throw entry — `session.expectThrow(...)` adds one
 *  so the runner doesn't treat the throw as a bug. */
interface ExpectedThrow {
  fromStep: number;
  reason: string;
}

export class QaSession {
  state: CampaignState;
  rng: () => number;
  trace: TraceEntry[] = [];
  bugs: SessionBug[] = [];
  seed: number;
  scenarioName: string;
  /** When non-null, the NEXT action's throw will be swallowed
   *  and not reported. `expectThrow` sets this for one shot. */
  private nextThrowReason: string | null = null;
  /** Audit log of every expected-throw entry that actually
   *  fired (or didn't) — used by the report writer to flag
   *  "expected an error but none fired" surprises. */
  expectedThrows: Array<{ entry: ExpectedThrow; fired: boolean }> = [];

  constructor(opts: { seed: number; scenarioName: string }) {
    this.seed = opts.seed;
    this.scenarioName = opts.scenarioName;
    this.state = newCampaign();
    this.rng = mulberry32(opts.seed);
  }

  // ---------- Trace + invariant plumbing ---------------------------------

  /** Push a trace entry and run invariants. Returns the step
   *  index of the entry. Scenarios don't normally call this
   *  directly — the action methods below do. */
  private record(kind: string, payload: unknown): number {
    const step = this.trace.length;
    const entry: TraceEntry = {
      step,
      kind,
      payload,
      recordedAtMs: Date.now(),
    };
    this.trace.push(entry);
    const violations = checkAllInvariants(this.state);
    for (const v of violations) {
      this.bugs.push({
        triggeringStep: step,
        triggeringAction: entry,
        violation: v,
      });
    }
    return step;
  }

  /** Run `fn`; swallow any throw if `expectThrow` was called
   *  immediately before. Otherwise re-throw — but FIRST emit a
   *  synthetic "engine-threw" bug so the report has a record
   *  of the throw even if the scenario doesn't catch it. */
  private safely<T>(kind: string, payload: unknown, fn: () => T): T | undefined {
    const expected = this.nextThrowReason;
    this.nextThrowReason = null;
    try {
      return fn();
    } catch (err) {
      const step = this.trace.length - 1;
      if (expected !== null) {
        this.expectedThrows.push({
          entry: { fromStep: step, reason: expected },
          fired: true,
        });
        return undefined;
      }
      // Unexpected throw — record as a synthetic bug + re-throw
      // so the runner can decide whether to abort the scenario.
      this.bugs.push({
        triggeringStep: step,
        triggeringAction: this.trace[step]!,
        violation: {
          invariantId: "engine-threw",
          message: `Engine call \`${kind}\` threw: ${err instanceof Error ? err.message : String(err)}`,
          path: "(engine)",
          observed: err instanceof Error ? err.message : String(err),
          expected: "no throw",
        },
      });
      throw err;
    }
  }

  /** Mark the NEXT action as expected to throw. The runner will
   *  swallow exactly ONE subsequent throw — useful for scenarios
   *  that intentionally exercise reject paths
   *  (e.g. "buy a product you can't afford"). */
  expectThrow(reason: string): void {
    this.nextThrowReason = reason;
  }

  /** Annotate the most recent trace entry with a checkpoint label
   *  ("after ch1 visit", "before q2 w1") so the bug report
   *  surfaces story beats. */
  checkpoint(label: string): void {
    if (this.trace.length === 0) {
      // No prior action — synthesise an empty entry so the
      // checkpoint label is preserved.
      this.trace.push({
        step: 0,
        kind: "checkpoint",
        payload: { label },
        recordedAtMs: Date.now(),
        checkpoint: label,
      });
      return;
    }
    const last = this.trace[this.trace.length - 1]!;
    last.checkpoint = label;
  }

  // ---------- Action wrappers --------------------------------------------

  startTownVisit(chapterId: import("../types").TownVisitChapterId): void {
    this.record("startTownVisit", { chapterId });
    this.safely("startTownVisit", { chapterId }, () => startTownVisit(this.state, chapterId));
  }

  /** Run `applyOnEnter` for the current page (fires `onEnter`
   *  actions if not already entered) — returns the emitted
   *  `RewardEvent[]` so the scenario can react to what was
   *  granted. */
  applyOnEnter(): RewardEvent[] {
    this.record("applyOnEnter", {});
    const result = this.safely("applyOnEnter", {}, () => applyOnEnter(this.state));
    return result?.events ?? [];
  }

  choose(decisionKey: string): void {
    this.record("choose", { decisionKey });
    this.safely("choose", { decisionKey }, () => chooseTownVisitOption(this.state, decisionKey));
  }

  advancePage(): void {
    this.record("advancePage", {});
    this.safely("advancePage", {}, () => advanceTownVisitPage(this.state));
  }

  setPage(pageId: string): void {
    this.record("setPage", { pageId });
    this.safely("setPage", { pageId }, () => setTownVisitPage(this.state, pageId));
  }

  donate(heroId: string, amount: number): void {
    this.record("donate", { heroId, amount });
    this.safely("donate", { heroId, amount }, () => {
      const err = donateToAcademy(this.state, heroId, amount);
      if (err) throw new Error(`donateToAcademy rejected: ${err.code}`);
    });
  }

  buy(heroId: string, productNumber: number): void {
    this.record("buy", { heroId, productNumber });
    this.safely("buy", { heroId, productNumber }, () => {
      const err = purchaseShopProduct(this.state, heroId, productNumber);
      if (err) throw new Error(`purchaseShopProduct rejected: ${err.code}`);
    });
  }

  convertBossToMinion(heroId: string): boolean {
    this.record("convertBossToMinion", { heroId });
    return this.safely("convertBossToMinion", { heroId }, () =>
      convertBossPartToMinion(this.state, heroId),
    ) ?? false;
  }

  redeemVera(heroId: string): void {
    this.record("redeemVera", { heroId });
    this.safely("redeemVera", { heroId }, () => {
      const err = redeemVeraAlly(this.state, heroId);
      if (err) throw new Error(`redeemVeraAlly rejected: ${err.code}`);
    });
  }

  redeemFlores(): void {
    this.record("redeemFlores", {});
    this.safely("redeemFlores", {}, () => {
      const err = redeemFloresAlly(this.state);
      if (err) throw new Error(`redeemFloresAlly rejected: ${err.code}`);
    });
  }

  redeemRodrigo(): void {
    this.record("redeemRodrigo", {});
    this.safely("redeemRodrigo", {}, () => {
      const err = redeemRodrigoAlly(this.state);
      if (err) throw new Error(`redeemRodrigoAlly rejected: ${err.code}`);
    });
  }

  redeemElayna(): void {
    this.record("redeemElayna", {});
    this.safely("redeemElayna", {}, () => {
      const err = redeemElaynaAlly(this.state);
      if (err) throw new Error(`redeemElaynaAlly rejected: ${err.code}`);
    });
  }

  finishTownVisit(): void {
    this.record("finishTownVisit", {});
    this.safely("finishTownVisit", {}, () => finishTownVisit(this.state));
  }

  /** Enqueue Quest-2 opinion grants on the current encounter
   *  (idempotent — second call is a no-op). The harness needs
   *  this so happy-path tests see Xavier picks without booting
   *  Q2's wave-1 spawn. */
  applyQuestOpinionGrants(questId: string): void {
    this.record("applyQuestOpinionGrants", { questId });
    this.safely("applyQuestOpinionGrants", { questId }, () =>
      applyOpinionGrantsForQuest(this.state, questId),
    );
  }

  /** Resolve a Xavier rank-pick. The scenario picks the heroId
   *  + equipmentType; the engine asserts eligibility (throws on
   *  invalid input — the modal validates before calling, and the
   *  harness mirrors that contract). */
  applyOpinionPick(pickId: string, heroId: string, equipmentType: EquipmentType): void {
    this.record("applyOpinionPick", { pickId, heroId, equipmentType });
    this.safely("applyOpinionPick", { pickId, heroId, equipmentType }, () =>
      applyOpinionRankPick(this.state, pickId, heroId, equipmentType),
    );
  }

  /** Returns the eligible equipment types for a given pending
   *  pick on the given delver. Pure helper for scenarios. */
  eligibleTypesForPick(pickId: string, heroId: string): readonly EquipmentType[] {
    const pick = this.state.encounter?.pendingOpinionRankPicks.find((p) => p.pickId === pickId);
    if (!pick) return [];
    return eligibleEquipmentTypesForPick(this.state, pick, heroId, ALL_EQUIPMENT_TYPES);
  }

  /** Apply a one-off TownVisitAction directly (used by scenarios
   *  to short-circuit the page-walk path — e.g. shift Samantha
   *  to Ally without actually visiting the pub). */
  applyAction(action: TownVisitAction): RewardEvent[] {
    this.record("applyAction", action);
    return this.safely("applyAction", action, () =>
      runTownVisitAction(this.state, action),
    ) ?? [];
  }

  // ---------- Introspection helpers --------------------------------------

  /** Returns the current town visit's page id, or `null` if no
   *  visit is active. Used by scenarios to decide what to do
   *  next. */
  currentPageId(): string | null {
    return this.state.townVisit?.pageId ?? null;
  }

  /** Returns the VISIBLE choice keys for the current page —
   *  i.e. the same set the screen would render, with
   *  `hideIfDecisionMade` and `requireStoryTokens` gates
   *  applied. Without this filter, the walker would click
   *  already-spent location buttons and burn its step budget
   *  in a tight loop. */
  currentChoiceKeys(): string[] {
    return visibleTownVisitChoices(this.state).map((c) => c.decisionKey);
  }

  /** Returns the FULL list of choice keys including gated ones.
   *  Scenarios that intentionally test the gating contract
   *  (e.g. "what happens if I dispatch a hidden choice?") need
   *  this to construct the action. */
  allChoiceKeysIncludingHidden(): string[] {
    const ctx = currentTownVisitPage(this.state);
    if (!ctx) return [];
    return (ctx.page.choices ?? []).map((c) => c.decisionKey);
  }

  /** Does the current page have a `next` field (i.e. is it
   *  advanceable)? */
  currentPageHasNext(): boolean {
    const ctx = currentTownVisitPage(this.state);
    return ctx?.page.next !== undefined;
  }

  // ---------- Combat / wave action wrappers ------------------------------
  //
  // Drives the wave-lifecycle through the SAME engine APIs the
  // BoardScreen + DelverSpawnPick + WavePhases screens use. The
  // harness uses `debugWinWave` as a tactical shortcut — it
  // routes through the normal `applyKill` path so XP, elements,
  // level-up cards, parting shots, End Wave refresh, etc. all run
  // exactly as on a real wave win. The shortcut just skips the
  // hand-driven hero-turn loop, which is the right tradeoff
  // for Phase 2 coverage: we exercise the entire wave-
  // transition machinery without re-implementing combat AI in
  // the QA harness.
  //
  // Phase 3 (future): add `playWeapon`, `attack`, `endTurn`
  // wrappers that drive the hero loop directly so a
  // `combat-greedy` / `combat-monkey` scenario can find bugs in
  // the per-turn flow (Soulshift, counter, weapon slot
  // placement, etc.). The infrastructure already supports it —
  // just write the wrappers + scenarios.

  /** Bootstrap an encounter at the given (quest, wave) pair.
   *  Triggers `applyShopGrantsForQuest`,
   *  `applyShopGrantsForWave`, and `applyOpinionGrantsForQuest`
   *  along the way (same as the screen path). On Q2 the
   *  encounter lands in `delver-spawn-pick` phase awaiting
   *  `autoPlaceSpawns()` + `startWaveAfterPick()`. */
  /** Continue to `waveNumber` of the current quest the way the
   *  End of Wave screen's "Continue → Wave N" does: build the wave
   *  and apply the End Wave "if continuing" effects (Elemental OS /
   *  Shield element picks, Armor heals, opinion penalties). */
  continueToWave(questId: string, waveNumber: number): void {
    this.record("continueToWave", { questId, waveNumber });
    this.safely("continueToWave", { questId, waveNumber }, () =>
      bootstrapNextWave(this.state, getQuestData(questId), waveNumber),
    );
  }

  bootstrapWave(questId: string, waveNumber: number): void {
    this.record("bootstrapWave", { questId, waveNumber });
    this.safely("bootstrapWave", { questId, waveNumber }, () =>
      bootstrapWaveAtNumber(this.state, getQuestData(questId), waveNumber),
    );
  }

  /** Auto-place every unplaced delver (+ Witness if present) on
   *  the first printed compass tile of the drawn spawn card.
   *  Skips the action entirely if the encounter isn't in
   *  `delver-spawn-pick` phase (Q1 / hand-authored encounters
   *  land directly in `hero` and don't need a pick step). */
  autoPlaceSpawns(): void {
    const enc = this.state.encounter;
    if (!enc) {
      this.record("autoPlaceSpawns", { skipped: "no-encounter" });
      return;
    }
    if (enc.phase !== "delver-spawn-pick") {
      this.record("autoPlaceSpawns", { skipped: "wrong-phase", phase: enc.phase });
      return;
    }
    if (enc.spawnCardDrawn == null) {
      this.record("autoPlaceSpawns", { skipped: "no-spawn-card" });
      return;
    }
    const card = getSpawnCard(enc.spawnCardDrawn);
    const compassTiles = card.delverSpawns;
    if (compassTiles.length === 0) {
      this.record("autoPlaceSpawns", { skipped: "no-compass-tiles", spawnCardNumber: card.number });
      return;
    }
    // Place every delver onto the first compass tile. Multiple
    // delvers sharing a tile is legal — the engine doesn't
    // enforce a per-tile cap during the pick phase. Witness goes
    // onto the LAST compass tile so it spawns somewhere distinct
    // from the delvers when there are 2+ printed compass tiles.
    const first = compassTiles[0]!;
    const last = compassTiles[compassTiles.length - 1]!;
    for (const heroId of Object.keys(enc.delverPositions)) {
      this.record("autoPlaceSpawns/delver", { heroId, x: first.x, y: first.y });
      this.safely("autoPlaceSpawns/delver", { heroId, x: first.x, y: first.y }, () =>
        assignDelverToTile(this.state, heroId, first.x, first.y),
      );
    }
    if (enc.witnessPosition !== null) {
      this.record("autoPlaceSpawns/witness", { x: last.x, y: last.y });
      this.safely("autoPlaceSpawns/witness", { x: last.x, y: last.y }, () =>
        assignWitnessToTile(this.state, last.x, last.y),
      );
    }
  }

  /** Commit the pick phase → start the hero phase. Two-stage
   *  internally now that every wave goes through the
   *  `first-turn-pick` picker:
   *
   *    1. `startWaveAfterPick` flips compass-tile-pick →
   *       first-turn-pick (no-op on hand-authored Q1 waves,
   *       which land directly in first-turn-pick out of
   *       `buildEncounter`).
   *    2. `commitFirstTurnPick(hero-01, ...)` flips
   *       first-turn-pick → hero, firing `startHeroTurn`.
   *
   *  The default starting delver is `hero-01` (Mind) — matches
   *  the convention used everywhere else in QA scenarios
   *  (combat brute, mover, etc. all assume Mind takes turn 1).
   *  Idempotent on non-pick phases — both engine calls early-
   *  return so a stray harness call after the wave is already
   *  running is safe. */
  startWaveAfterPick(): void {
    this.record("startWaveAfterPick", {});
    this.safely("startWaveAfterPick", {}, () =>
      startWaveAfterPick(this.state, startHeroTurn),
    );
    // The startWaveAfterPick engine call leaves the phase at
    // first-turn-pick (or earlier — e.g. hand-authored Q1 lands
    // directly in first-turn-pick out of buildEncounter), so chain
    // commitFirstTurnPick to fast-forward through the picker and
    // into the hero phase. Scenarios that want to test the picker
    // explicitly can use `commitFirstTurnPick(heroId)` below
    // instead of `startWaveAfterPick`.
    this.safely("commitFirstTurnPick", { heroId: "hero-01" }, () =>
      commitFirstTurnPick(this.state, "hero-01", startHeroTurn),
    );
  }

  /** Explicit first-turn-pick commit for scenarios that want to
   *  test the picker without going through the default
   *  `startWaveAfterPick` fast-forward. Engine no-op on non-
   *  picker phases. */
  commitFirstTurnPick(heroId: string): void {
    this.record("commitFirstTurnPick", { heroId });
    this.safely("commitFirstTurnPick", { heroId }, () =>
      commitFirstTurnPick(this.state, heroId, startHeroTurn),
    );
  }

  /** Resolve every pending Xavier rank-pick by assigning the
   *  first eligible (heroId, equipmentType) for each. Skips when
   *  the queue is empty. Used by combat scenarios at wave-
   *  bootstrap time to drain picks before continuing. Bounded
   *  by `maxIters` so a future bug that fails to pop the queue
   *  head can't infinite-loop the scenario. */
  drainOpinionPicks(maxIters: number = 8): void {
    let safety = 0;
    while ((this.state.encounter?.pendingOpinionRankPicks.length ?? 0) > 0 && safety++ < maxIters) {
      const pick = this.state.encounter!.pendingOpinionRankPicks[0]!;
      const heroId = pick.heroId ?? Object.keys(this.state.loadouts)[0]!;
      const eligible = this.eligibleTypesForPick(pick.pickId, heroId);
      if (eligible.length === 0) break;
      this.applyOpinionPick(pick.pickId, heroId, eligible[0]!);
    }
  }

  /** Slay every alive enemy via `debugWinWave` — routes through
   *  the normal `applyKill` path (XP, elements, level-up cards,
   *  tile drops) and transitions `enc.phase` to
   *  `"parting-shots"`. No-op when not in `"hero"` phase
   *  (engine returns null). */
  winWaveViaDebug(): void {
    this.record("winWaveViaDebug", {});
    this.safely("winWaveViaDebug", {}, () => debugWinWave(this.state));
  }

  /** Drain the parting-shots queue. `resolvePartingShot` returns
   *  the next result + transitions to `end-of-wave` when no alive
   *  enemy remains; calling it in a bounded loop is the
   *  harness's equivalent of the player tapping "Continue"
   *  through every parting-shot beat. */
  resolveAllPartingShots(maxIters: number = 32): void {
    let safety = 0;
    while (
      this.state.encounter?.phase === "parting-shots" &&
      safety++ < maxIters
    ) {
      this.record("resolvePartingShot", { cursor: this.state.encounter.partingShotCursor });
      this.safely("resolvePartingShot", {}, () => resolvePartingShot(this.state));
    }
  }

  /** Complete the wave — clears the encounter and marks
   *  `enc.phase = "completed"`. Mirrors the screen's "Return
   *  to Title" / "Continue" buttons on the End-of-Wave
   *  screen. */
  completeWave(): void {
    this.record("completeWave", {});
    this.safely("completeWave", {}, () => completeWave(this.state));
  }

  /** Wipe per-quest scratch state (encounter, temporary rank
   *  bonus, opinion-grants-applied set). Called by the Q2 end-
   *  of-wave terminus buttons before the player routes back to
   *  the town visit. */
  endQuestReset(): void {
    this.record("endQuestReset", {});
    this.safely("endQuestReset", {}, () => endQuestReset(this.state));
  }

  /** Grant a key item the engine doesn't auto-grant (Q2 W2 +
   *  W3 victory grant Surveillance Camera / Abandoned Syringe
   *  on the End-of-Wave screen, not the engine). Inlined here
   *  rather than extracting `grantSurveillanceCameraKeyItem`
   *  out of `screens/WavePhases.ts` — that's a future refactor
   *  target, but for v1 the QA harness duplicates the 3-line
   *  helper to avoid touching the screen file. */
  grantQuest2KeyItem(number: 1 | 2): void {
    const name = number === 1 ? "Surveillance Camera" : "Abandoned Syringe";
    this.record("grantQuest2KeyItem", { number, name });
    this.safely("grantQuest2KeyItem", { number, name }, () => {
      const already = this.state.keyItems.some((k) => k.number === number);
      if (already) return;
      this.state.keyItems.push({ number, name, clues: getKeyItem(number).clues });
    });
  }

  // ---------- Tactical hero-phase wrappers (Phase 3) ---------------------
  //
  // These drive the BoardScreen's "place a card / move / attack /
  // end turn" loop without a DOM. The contract for each method
  // mirrors the screen's onClick handlers — the wrapper records
  // the trace entry, runs the engine call, and invariants fire.
  //
  // Most methods return a small status object (`{ ok, reason }`)
  // so tactical scenarios can decide whether the attempted move
  // actually landed (e.g. "play this card" might be rejected
  // because the card was already placed). The wrapper does NOT
  // throw on engine-rejection — that's a legitimate outcome the
  // scenario should be able to inspect and branch on.

  /** Declare the active delver "Prepared to Run". Latches sticky
   *  for the wave; once BOTH delvers are prepared,
   *  `endHeroTurn`'s post-flip check transitions the encounter
   *  into the Parting Shots phase. Rejected if the delver has
   *  already placed a card this turn. */
  prepareDelverToRun(heroId: string): TurnActionResult {
    this.record("prepareToRun", { heroId });
    return this.safely("prepareToRun", { heroId }, () => prepareToRun(this.state, heroId)) ??
      { ok: false, reason: "engine threw" };
  }

  /** Place a weapon card into the active delver's empty slot.
   *  Mandatory first action of every hero turn (DESIGN.md §4
   *  stage 1). Rejected if the card isn't in hand, isn't a
   *  weapon, etc. — see `playWeaponCard` for the full reject
   *  matrix. */
  playWeapon(heroId: string, slotIdx: number, cardId: string): TurnActionResult {
    this.record("playWeapon", { heroId, slotIdx, cardId });
    return this.safely("playWeapon", { heroId, slotIdx, cardId }, () =>
      playWeaponCard(this.state, heroId, slotIdx, cardId),
    ) ?? { ok: false, reason: "engine threw" };
  }

  /** Use the placed weapon's printed ability. Returns the
   *  built `AttackSession` (which the caller resolves via
   *  `resolveAttackSession`) OR a `{ ok: false }` reject.
   *  Tactical scenarios will typically pair this with
   *  `resolveAttackSession` immediately after — the harness
   *  doesn't auto-resolve so the scenario can choose how to
   *  exercise pre/post effects mid-attack. */
  useWeaponAbility(
    heroId: string,
    slotIdx: number,
    params: WeaponAbilityParams,
  ): { ok: true; session: AttackSession } | { ok: false; reason: string } {
    this.record("useWeaponAbility", { heroId, slotIdx, params });
    const r = this.safely("useWeaponAbility", { heroId, slotIdx, params }, () =>
      useWeaponAbility(this.state, heroId, slotIdx, params),
    );
    if (!r) return { ok: false, reason: "engine threw" };
    return r;
  }

  /** End-to-end resolution of an attack session: runs the
   *  damage pass, then a fixed counter-roll (5 → "miss" to keep
   *  the harness deterministic — tactical scenarios that want
   *  to probe counter behaviour should pass a different roll),
   *  then finalize. Returns the finalize summary
   *  (`{ levelUps }`) so the scenario can react to mid-attack
   *  level-ups (which trigger a pending pick + might queue
   *  element choices, etc.). */
  resolveAttackSession(
    session: AttackSession,
    counterRoll: number = 5,
  ): { levelUps: number } {
    this.record("resolveAttackSession", { source: session.source, counterRoll });
    return this.safely("resolveAttackSession", { counterRoll }, () => {
      resolveAllDamage(this.state, session);
      resolveSharedCounter(this.state, session, counterRoll);
      return finalizeAttackSession(this.state, session);
    }) ?? { levelUps: 0 };
  }

  /** End the active delver's hero turn — flips active delver,
   *  refreshes the new delver's per-turn state, transitions to
   *  parting shots if both prepared. */
  endHeroTurn(): void {
    this.record("endHeroTurn", { previousActive: this.state.currentDelverId });
    this.safely("endHeroTurn", {}, () => endHeroTurn(this.state));
  }

  /** Drain EVERY pending modal queue on the current encounter
   *  by deterministically picking the first option in each
   *  case. Bounded by `maxIters` so a future bug that fails to
   *  pop the queue can't infinite-loop.
   *
   *  Resolution policy (matches the LevelUpModal / OS modal /
   *  Supercharger roll modal defaults the player would see):
   *    - Xavier rank pick → first eligible (heroId, type)
   *    - Level-up draw → first printed type on the card
   *    - Element choice → "earth" (first in the engine's
   *      element enum; arbitrary but deterministic)
   *    - Equipment roll → outcome for fixed die-roll 4 (a
   *      mid-range result that lands a real outcome rather than
   *      a no-op on most tables)
   *
   *  Tactical scenarios that want to probe specific picks
   *  should call the underlying engine functions directly
   *  rather than relying on this drainer's defaults. */
  drainPendingModals(maxIters: number = 24): void {
    let safety = 0;
    while (safety++ < maxIters) {
      // Xavier rank picks first — the BoardScreen modal stack
      // gives them top priority, so the harness does too.
      if ((this.state.encounter?.pendingOpinionRankPicks.length ?? 0) > 0) {
        const pick = this.state.encounter!.pendingOpinionRankPicks[0]!;
        const heroId = pick.heroId ?? Object.keys(this.state.loadouts)[0]!;
        const eligible = this.eligibleTypesForPick(pick.pickId, heroId);
        if (eligible.length === 0) {
          // No legal type — pop manually so we don't deadlock
          // the loop. This case is itself a possible bug; the
          // `encounter-queue-shape` invariant won't catch it
          // (the queue is still an array), so we log a
          // checkpoint for triage visibility.
          this.checkpoint(`drainPendingModals — pop unfillable opinion pick "${pick.pickId}"`);
          this.state.encounter!.pendingOpinionRankPicks.shift();
          continue;
        }
        this.applyOpinionPick(pick.pickId, heroId, eligible[0]!);
        continue;
      }
      // Level-up draws next — these are gated above element
      // choices in the screen modal stack.
      const draw = peekNextPendingDraw(this.state);
      if (draw) {
        // Pick the first type on the printed card. Hard-pinned
        // so the trace is deterministic across runs; a
        // tactical scenario that wants to probe a different
        // pick should call `applyLevelUpChoice` directly with
        // the desired type rather than relying on this drainer.
        const card = getLevelUpCard(draw.cardNumber);
        const type = card.types[0]!;
        this.record("applyLevelUpChoice", { heroId: draw.heroId, type, cardNumber: draw.cardNumber });
        this.safely("applyLevelUpChoice", { type }, () => applyLevelUpChoice(this.state, type));
        continue;
      }
      // Element choices.
      const elementPick = peekNextPendingElementChoice(this.state);
      if (elementPick) {
        const element: Element = "earth";
        this.record("applyElementChoice", { heroId: elementPick.heroId, element });
        this.safely("applyElementChoice", { element }, () => applyElementChoice(this.state, element));
        continue;
      }
      // Equipment rolls (Supercharger). Roll a deterministic
      // 4 against the printed table — if the table says
      // "choice" at that index we fall back to the first
      // listed outcome rather than asking the scenario.
      const eqRoll = peekNextPendingEquipmentRoll(this.state);
      if (eqRoll) {
        const table = equipmentRollTableForCard(eqRoll.cardId);
        if (!table) {
          this.checkpoint(`drainPendingModals — no roll table for "${eqRoll.cardId}"`);
          this.state.encounter!.pendingEquipmentRolls.shift();
          continue;
        }
        let outcome = outcomeForRoll(table, 4);
        if (outcome === "choice" || outcome === null) {
          outcome = table.outcomes[0] ?? null;
        }
        if (!outcome) {
          this.checkpoint(`drainPendingModals — no outcome for equipment roll "${eqRoll.cardId}"@4`);
          this.state.encounter!.pendingEquipmentRolls.shift();
          continue;
        }
        this.record("applyEquipmentRoll", { heroId: eqRoll.heroId, outcome });
        this.safely("applyEquipmentRoll", { outcome }, () =>
          applyEquipmentRoll(this.state, eqRoll.heroId, outcome),
        );
        continue;
      }
      // XP die rolls ("Gain 1 [die] XP" on-death rewards). The UI
      // rolls in front of the player; the harness pins a
      // deterministic 4 (same policy as the equipment-roll drain
      // above) so scenario XP totals are reproducible.
      const xpRoll = peekNextPendingXpRoll(this.state);
      if (xpRoll) {
        this.record("applyXpRoll", { heroId: xpRoll.heroId, enemyCardId: xpRoll.enemyCardId, rolled: 4 });
        this.safely("applyXpRoll", { rolled: 4 }, () => applyXpRoll(this.state, 4));
        continue;
      }
      // CREATURE PART picks (Gauntlet `collect-creature-part`).
      // Resolution policy: claim the FIRST eligible drop owed
      // to the bearer (insertion order). If no eligible drop
      // exists on the board, skip the head pick (the "from any
      // tile" clause is unfulfillable). Tactical scenarios that
      // want a specific tile should call
      // `applyCreaturePartChoice(state, heroId, x, y)` directly.
      const partPick = peekNextPendingCreaturePartChoice(this.state);
      if (partPick) {
        const drops = availableCreaturePartDropsForHero(this.state, partPick.heroId);
        const target = drops[0];
        if (target) {
          this.record("applyCreaturePartChoice", {
            heroId: partPick.heroId, x: target.x, y: target.y,
          });
          this.safely("applyCreaturePartChoice", { x: target.x, y: target.y }, () =>
            applyCreaturePartChoice(this.state, partPick.heroId, target.x, target.y),
          );
        } else {
          this.record("skipCreaturePartChoice", { heroId: partPick.heroId });
          this.safely("skipCreaturePartChoice", {}, () =>
            skipCreaturePartChoice(this.state, partPick.heroId),
          );
        }
        continue;
      }
      break;
    }
  }

  // ---------- Tactical introspection helpers ------------------------------
  //
  // Pure read helpers scenarios use to pick their next move.
  // Keeping these on the session keeps scenario code linear:
  // `session.firstPlayableWeapon(heroId)` instead of inlining
  // an iteration over equipmentRanks + slotCards every turn.

  /** Find the FIRST weapon card the active delver can legally
   *  play this turn (in-hand, suit-matched, not already
   *  placed). Returns null if there's no playable weapon —
   *  startHeroTurn will have auto-latched preparedToRun in
   *  that case, but the helper is safe to call from any
   *  state. */
  firstPlayableWeapon(heroId: string): { slotIdx: number; cardId: string } | null {
    const loadout = this.state.loadouts[heroId];
    if (!loadout) return null;
    const placed = new Set(loadout.slotCards.filter((id): id is string => !!id));
    const ranks = this.state.equipmentRanks[heroId] ?? {};
    // Find the first empty slot index — slot indices are stable
    // 0..(slotCards.length-1), and a freshly-placed card occupies
    // a single slot regardless of its element printed there.
    let emptySlot = -1;
    for (let i = 0; i < loadout.slotCards.length; i++) {
      if (loadout.slotCards[i] === null) {
        emptySlot = i;
        break;
      }
    }
    if (emptySlot < 0) return null;
    // Walk every owned equipment type in insertion order. Use
    // the EFFECTIVE rank (folds in Xavier + suit-condition
    // bumps) so a delver whose only playable hand is a
    // Xavier-granted weapon still finds it.
    for (const type of Object.keys(ranks) as Array<keyof typeof ranks>) {
      const r = ranks[type] ?? 0;
      if (r < 1) continue;
      // `getEquipment` lookup needs the actual card id; we
      // resolve via the hero's suit + type pair below. Skip
      // gracefully if the lookup fails (hero metadata gap).
      let card;
      try {
        const hero = getHero(heroId);
        card = getEquipmentByTypeSuit(hero.suit, type);
      } catch {
        continue;
      }
      if (card.category !== "weapon") continue;
      if (placed.has(card.id)) continue;
      return { slotIdx: emptySlot, cardId: card.id };
    }
    return null;
  }

  /** Find the nearest live adjacent (8-way) enemy to the
   *  active delver. Returns null when none is in melee range.
   *  Tactical scenarios use this to decide between
   *  `single-adjacent` attacks vs. movement. */
  adjacentLiveEnemy(heroId: string): { x: number; y: number; instanceId: string } | null {
    const enc = this.state.encounter;
    if (!enc) return null;
    const pos = getDelverAt(enc, heroId);
    if (!pos) return null;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const enemy = getEnemyAt(enc, pos.x + dx, pos.y + dy);
        if (enemy) return { x: enemy.x, y: enemy.y, instanceId: enemy.instanceId };
      }
    }
    return null;
  }

  /** Look up a placed card's range kind so the tactical
   *  scenario knows whether to call `useWeaponAbility` with
   *  `single-adjacent` / `die-roll-fixed` / `fixed-pattern` /
   *  etc. Returns null if the slot is empty or the card has no
   *  range. */
  placedWeaponRangeKind(heroId: string, slotIdx: number): string | null {
    const loadout = this.state.loadouts[heroId];
    if (!loadout) return null;
    const cardId = loadout.slotCards[slotIdx];
    if (!cardId) return null;
    try {
      const card = getEquipment(cardId);
      return card.range?.kind ?? null;
    } catch {
      return null;
    }
  }

  // ---------- Tactical wrappers (Phase 4) --------------------------------
  //
  // Movement, slot abilities, and AP-spend paths. Phase 3 left
  // these unwrapped — the brute / monkey scenarios stayed on
  // the spawn tile and never spent an AP token. These wrappers
  // close that gap so scenarios can exercise the full set of
  // BoardScreen actions.

  /** Compute legal 1-step destinations for the active delver.
   *  Pure read; mirrors what the BoardScreen paints as the
   *  destination overlay. Returns an empty array when movement
   *  is blocked (preparedToRun latched, MP=0, movement session
   *  already locked, etc.). Movement before placement is now
   *  allowed (2026-05-21) — that case is NOT a blocker here.
   *  The Q2 board is always 5×5. */
  legalMovementTiles(heroId: string): Array<{ x: number; y: number }> {
    if (!this.state.encounter) return [];
    return legalStepDestinations(this.state, heroId, this.activeBoardBounds());
  }

  /** Apply a single 8-way movement step. Mirrors a BoardScreen
   *  click on a destination tile. The wrapper bounces the
   *  raw {@link MoveResult} back to the scenario so it can
   *  decide whether to keep stepping (MP remaining) or stop.
   *  Auto-claims any monster-part drops on the destination
   *  tile per `engine/movement.ts > moveDelverStep`. */
  moveStep(heroId: string, toX: number, toY: number): MoveResult {
    this.record("moveStep", { heroId, toX, toY });
    const result = this.safely("moveStep", { heroId, toX, toY }, () =>
      moveDelverStep(this.state, heroId, toX, toY, this.activeBoardBounds()),
    );
    return result ?? { ok: false, reason: "engine threw" };
  }

  /** Explicit "I'm done moving" latch. Idempotent. Called by
   *  the screen when the player disarms after taking 1+ steps,
   *  so the engine doesn't let them re-arm with leftover MP. */
  endMovementStep(heroId: string): void {
    this.record("endMovementStep", { heroId });
    this.safely("endMovementStep", { heroId }, () => endMovementStep(this.state, heroId));
  }

  /** Spend 1 AP to double the active delver's currentMovement.
   *  Rejected if AP < 1, movement already used this turn, or
   *  movement already doubled this turn. Mirrors the BoardScreen
   *  "AP: double mov" button. */
  spendApDoubleMovement(heroId: string): TurnActionResult {
    this.record("spendApDoubleMovement", { heroId });
    return this.safely("spendApDoubleMovement", { heroId }, () =>
      spendApDoubleMovement(this.state, heroId),
    ) ?? { ok: false, reason: "engine threw" };
  }

  /** Spend 2 AP to refresh the named slot (returns the placed
   *  card to hand, clears the slot). Lets a delver play another
   *  weapon next turn / clear an unwanted placement. Rejected
   *  if AP < 2 or the slot is empty. */
  spendApRefreshWeapon(heroId: string, slotIdx: number): TurnActionResult {
    this.record("spendApRefreshWeapon", { heroId, slotIdx });
    return this.safely("spendApRefreshWeapon", { heroId, slotIdx }, () =>
      spendApRefreshWeapon(this.state, heroId, slotIdx),
    ) ?? { ok: false, reason: "engine threw" };
  }

  /** Use the placed slot's printed Slot Ability — the
   *  alternative to swinging the weapon. The wrapper looks up
   *  the printed ability so the scenario doesn't have to,
   *  builds matching {@link SlotAbilityParams}, and invokes the
   *  engine. For `damage-any-enemy`, the caller must pass a
   *  target tile via `targetOverride` (defaults to the first
   *  live enemy on the board). For `gain-token` /
   *  `gain-element`, the recipient defaults to the bearer; pass
   *  `recipientOverride` to grant to the other delver. */
  useSlotAbility(
    heroId: string,
    slotIdx: number,
    options?: {
      targetOverride?: { x: number; y: number };
      recipientOverride?: string;
    },
  ): UseSlotAbilityResult {
    const params = this.buildSlotAbilityParams(heroId, slotIdx, options);
    if (!params) {
      const reason = `useSlotAbility — no printed ability for slot ${slotIdx} on hero ${heroId}`;
      this.record("useSlotAbility", { heroId, slotIdx, params: null, reason });
      return { ok: false, reason };
    }
    this.record("useSlotAbility", { heroId, slotIdx, params });
    return this.safely("useSlotAbility", { heroId, slotIdx, params }, () =>
      useSlotAbility(this.state, heroId, slotIdx, params),
    ) ?? { ok: false, reason: "engine threw" };
  }

  /** Convenience: drive `useSlotAbility` AND, when the result
   *  is a `damage-session`, resolve it through the attack
   *  pipeline. Mirrors the BoardScreen flow which auto-prompts
   *  for the counter roll. */
  useSlotAbilityAndResolve(
    heroId: string,
    slotIdx: number,
    counterRoll: number = 5,
    options?: { targetOverride?: { x: number; y: number }; recipientOverride?: string },
  ): UseSlotAbilityResult {
    const result = this.useSlotAbility(heroId, slotIdx, options);
    if (result.ok && result.result.kind === "damage-session") {
      this.resolveAttackSession(result.result.session, counterRoll);
    }
    return result;
  }

  // ---------- Phase 4 introspection helpers --------------------------------

  /** Find the nearest live enemy (any range) for the named
   *  delver. Returns null if no live enemies remain on the
   *  board. Used by tactical scenarios to pick a movement
   *  target. */
  nearestLiveEnemy(heroId: string): { x: number; y: number; instanceId: string; dx: number; dy: number } | null {
    const enc = this.state.encounter;
    if (!enc) return null;
    const pos = getDelverAt(enc, heroId);
    if (!pos) return null;
    let best: { x: number; y: number; instanceId: string; dx: number; dy: number; d: number } | null = null;
    for (const e of enc.enemies) {
      if (!e.alive) continue;
      const dx = e.x - pos.x;
      const dy = e.y - pos.y;
      // Chebyshev distance — matches the 8-way movement cost
      // (one step covers (dx,dy) ∈ {-1,0,1}²).
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      if (best === null || d < best.d) {
        best = { x: e.x, y: e.y, instanceId: e.instanceId, dx, dy, d };
      }
    }
    return best;
  }

  /** Pick the legal 1-step destination that brings the named
   *  delver closest (Chebyshev) to (`tx`, `ty`). Returns null
   *  if no movement is legal right now or every legal step
   *  ties at the current distance (no improvement). */
  bestStepToward(heroId: string, tx: number, ty: number): { x: number; y: number } | null {
    const enc = this.state.encounter;
    if (!enc) return null;
    const here = getDelverAt(enc, heroId);
    if (!here) return null;
    const dests = this.legalMovementTiles(heroId);
    if (dests.length === 0) return null;
    let bestDist = Math.max(Math.abs(tx - here.x), Math.abs(ty - here.y));
    let best: { x: number; y: number } | null = null;
    for (const d of dests) {
      const dist = Math.max(Math.abs(tx - d.x), Math.abs(ty - d.y));
      if (dist < bestDist) {
        bestDist = dist;
        best = { x: d.x, y: d.y };
      }
    }
    return best;
  }

  // ---------- Phase 4 private builders -----------------------------------

  /** Build {@link SlotAbilityParams} matching the printed
   *  ability for the named slot, using the option overrides
   *  where provided. Returns null when the slot ability can't
   *  be resolved (board lookup miss). */
  private buildSlotAbilityParams(
    heroId: string,
    slotIdx: number,
    options?: {
      targetOverride?: { x: number; y: number };
      recipientOverride?: string;
    },
  ): SlotAbilityParams | null {
    let board;
    try {
      const hero = getHero(heroId);
      board = getDelverBoard(hero.suit);
    } catch {
      return null;
    }
    const slot = board.weaponSlots[slotIdx];
    if (!slot) return null;
    const ability = slot.slotAbility;
    switch (ability.kind) {
      case "damage-any-enemy": {
        const target = options?.targetOverride ?? this.firstLiveEnemyTile();
        if (!target) return null;
        return { kind: "damage-any-enemy", targetX: target.x, targetY: target.y };
      }
      case "bonus-movement-this-turn":
        return { kind: "bonus-movement-this-turn" };
      case "refresh-ap":
        return { kind: "refresh-ap" };
      case "gain-token":
        return { kind: "gain-token", recipientHeroId: options?.recipientOverride ?? heroId };
      case "gain-element":
        return { kind: "gain-element", recipientHeroId: options?.recipientOverride ?? heroId };
      default:
        return null;
    }
  }

  /** Resolve the active wave's board bounds. Per
   *  `data/quest{1,2}.json`, every wave declares `spawn.boardSize`
   *  (typically `{w:5,h:5}`). The lookup falls back to 5×5 when
   *  the encounter is missing — defensive, the scenario should
   *  never call a movement wrapper outside an encounter anyway. */
  private activeBoardBounds(): { w: number; h: number } {
    const enc = this.state.encounter;
    if (!enc) return { w: 5, h: 5 };
    try {
      const quest = getQuestData(enc.questId);
      const wave = quest.waves.find((w) => w.number === enc.waveNumber);
      return wave?.spawn.boardSize ?? { w: 5, h: 5 };
    } catch {
      return { w: 5, h: 5 };
    }
  }

  /** First live enemy on the encounter (in spawn order). Used
   *  as the default target for `damage-any-enemy` slot
   *  abilities when no override is provided. */
  private firstLiveEnemyTile(): { x: number; y: number } | null {
    const enc = this.state.encounter;
    if (!enc) return null;
    for (const e of enc.enemies) {
      if (e.alive) return { x: e.x, y: e.y };
    }
    return null;
  }
}

// Re-export so scenarios can type their swing results.
export type { UseAbilityResult, UseSlotAbilityResult };
