/**
 * Ephemeral UI state — page-session only, never persisted.
 *
 * Consolidates state that the user is "doing right now" but that we don't
 * want to write to localStorage. Two separate modules used to own pieces
 * of this (`screens/heroSelection.ts` and a `let` inside BoardScreen.ts);
 * collecting them here gives one canonical place to look.
 *
 * Add new ephemeral flags here (e.g. hover-precomputed range tiles,
 * animation phase, in-flight modal stack). DO NOT add anything that
 * needs to survive a refresh — that goes on `CampaignState`.
 */

import type {
  AttackSession,
  ShieldChoice,
  ShieldOpportunity,
  WeaponCounterBlockChoice,
} from "./engine/combat";
import type { PartingShotResult } from "./engine/wave";
import type { EncounterState } from "./state";
import type { Element, SlotAbility, WeaponRange } from "./types";
import { clearFreshRolls } from "./ui/dieRollAnimation";
import { drainAbilityProcs, type AbilityProcKind } from "./engine/abilityProcs";

/**
 * Transient banner shown when a weapon was returned to hand outside
 * the normal "use it then it stays exhausted" loop. Two flavors:
 *
 *   - `element-stack` (DESIGN.md §4.3.2): a placement spent 2 stacked
 *     element tokens of the slot's printed element, immediately
 *     refreshing the just-placed card. Banner explains why the card
 *     "snapped back" — without it the player sees a placement that
 *     simultaneously empties the slot and would otherwise look like
 *     a no-op or a bug.
 *
 *   - `ap-spend` (DESIGN.md §4.3.1): the player spent 2 AP via the
 *     AVAILABLE-box menu to recover a previously-exhausted weapon
 *     card. Same banner channel so the player gets explicit
 *     confirmation that "yes, the slot emptied AND 2 AP came off
 *     your pool". Surfaces because refreshing the just-placed slot
 *     also clears `cardPlacedThisTurn`, so without the banner the
 *     player sees the slot empty + new mandatory-placement prompt
 *     and can mistake the back-to-square-one feeling for "nothing
 *     happened, AP wasn't spent".
 *
 * Cleared on End Turn, on next placement, or by the user dismissing
 * the banner.
 */
export type AutoRefreshToast =
  | {
      reason: "element-stack";
      heroId: string;
      cardId: string;
      cardName: string;
      element: Element;
    }
  | {
      reason: "ap-spend";
      heroId: string;
      cardId: string;
      cardName: string;
      apSpent: number;
    };

/**
 * "Armed" ability state — set when the user has picked an ability from
 * the action menu and the UI is now waiting for them to click a target
 * tile on the board. Rendering uses this to paint the target overlay.
 *
 * Cleared when:
 *   - user clicks Cancel ability
 *   - user clicks a target tile and the engine accepts the action
 *   - End Turn / state transition fires
 */
export type ArmedAbility =
  | {
      kind: "weapon";
      slotIdx: number;
      cardId: string;
      rangeKind: WeaponRange["kind"];
      /** For die-roll-fixed: the rolled (and possibly flipped) result. */
      dieRoll?: number;
      /** True if the user paid 1 HP to flip (Hammer's may-reroll-by-suffering). */
      suffered?: boolean;
      /**
       * Mace (both suits R1) `target-filter-or-spend-element`
       * OR-mode pre-commit. When set, the player has chosen to
       * spend 1 of `element` from their bag to BYPASS the card's
       * UNDAMAGED / DAMAGED target filter; the eventual
       * `useWeaponAbility` call forwards this as
       * `WeaponAbilityParams.spendElementForTargetBypass`.
       *
       * The board target overlay reads this too: when set, paint
       * EVERY 8-way adjacent live enemy as a legal target
       * (filter bypassed); when unset on a Mace, paint only those
       * matching the printed filter; for non-Mace single-adjacent
       * weapons the field is simply absent and the overlay paints
       * every adjacent enemy as before.
       */
      spendElementForBypass?: Element;
      /** `choose-targets` (Precise Shockwave): enemy tiles picked so far;
       *  the armed banner's Fire button sends them. */
      chosenTargets?: { x: number; y: number }[];
    }
  | { kind: "slot-damage"; slotIdx: number }
  /**
   * Strider Boots (Body, R1) ONGOING — "spend 2 movement to MOVE an
   * adjacent enemy." Two-phase pick:
   *
   *   Phase A (no `targetEnemyId`): board paints every 8-way adjacent
   *     enemy as a clickable target. Click sets `targetEnemyId` and
   *     re-renders.
   *   Phase B (`targetEnemyId` set): board paints the legal
   *     destination tiles for that enemy (8-way around its current
   *     position, minus off-board / enemy / delver tiles). Click
   *     dispatches `moveAdjacentEnemy` and clears the armed state.
   *
   * Engine: `engine/boots.ts > moveAdjacentEnemy`.
   */
  | {
      kind: "boots-move-enemy";
      /** Set in Phase B. */
      targetEnemyId?: string;
    }
  /**
   * Slip Strider Boots (Mind, R1) ONGOING — "spend 2 movement to
   * ROTATE an adjacent enemy." Single-phase pick:
   *
   *   Phase A: board paints every 8-way adjacent enemy as a clickable
   *     target. Click sets `targetEnemyId` and opens the
   *     `boots-rotate-direction` modal so the player picks 90° / 180° /
   *     270° clockwise.
   *
   * Engine: `engine/boots.ts > rotateAdjacentEnemy`.
   */
  | {
      kind: "boots-rotate-enemy";
      /** Set once an adjacent enemy has been picked; the direction
       *  modal then resolves the activation. */
      targetEnemyId?: string;
    }
  /**
   * Soulshift Sword (Body, R1) bonus-swing target picker. Armed by the
   * `soulshift-roll` modal once the player has rolled 4-6 AND opted
   * to Swing again. Board paints every 8-way adjacent LIVE enemy as
   * a clickable target. Clicking dispatches `useWeaponAbility(...,
   * { freeRepeat: true })` and starts a new attack session.
   *
   * `slotIdx` and `cardId` are captured at arm time so the engine
   * call can use the same slot the original swing used (the placed
   * card is still in that slot — it doesn't auto-refresh between
   * chained swings).
   *
   * Engine: `engine/soulshift.ts > adjacentLiveEnemiesForRepeat`,
   * `engine/turn.ts > useWeaponAbility(..., { freeRepeat: true })`.
   */
  | {
      kind: "soulshift-repeat-target";
      slotIdx: number;
      cardId: string;
    }
  /**
   * Scorchline Beam (Body, R2-R5) bonus-swing target picker. Armed
   * by the `beam-repeat-prompt` modal once the player picks "Fire
   * Again". Board paints every 8-direction straight-line ray from
   * the bearer (matching the printed `straight-line` range — first
   * enemy hit per ray); clicking dispatches `useWeaponAbility(...,
   * { freeRepeat: true })` with `kind: "straight-line"` and starts
   * a new attack session.
   *
   * `slotIdx` and `cardId` are captured at arm time so the engine
   * call uses the same slot the original swing used (the placed
   * card stays in its slot — Beam doesn't auto-refresh between
   * chained swings).
   *
   * Engine: `engine/turn.ts > useWeaponAbility(..., { freeRepeat:
   * true })`. The pending repeat counter on
   * `state.encounter.beamRepeatsRemaining[heroId]` is decremented
   * automatically inside `useWeaponAbility` when a freeRepeat
   * straight-line swing fires; subsequent prompts surface only
   * while it's still > 0.
   */
  | {
      kind: "beam-repeat-target";
      slotIdx: number;
      cardId: string;
    }
  /**
   * Trident pre-attack move (`pre-attack-may-move-adjacent`) — phase A.
   * Board paints every 8-way adjacent LIVE enemy as a clickable
   * target. Click sets the chosen enemy and switches to
   * `trident-pre-move-dest`.
   *
   * `slotIdx` and `cardId` are captured at arm time so the eventual
   * `useWeaponAbility` call uses the right slot when the move is
   * confirmed and the swing fires.
   *
   * Engine: target enumeration uses `adjacentEnemyTargets` from
   * `engine/boots.ts` (8-way to bearer, alive only).
   */
  | {
      kind: "trident-pre-move-target";
      slotIdx: number;
      cardId: string;
    }
  /**
   * Trident pre-attack move (`pre-attack-may-move-adjacent`) — phase B.
   * Board paints every legal destination tile for the chosen enemy.
   * Click dispatches `useWeaponAbility(..., { preAttackMove: ... })`
   * and starts the attack session against the printed pattern (now
   * targeting the enemy's NEW position).
   *
   * Engine: destination enumeration uses
   * `legalMoveDestinationsForEnemy` from `engine/boots.ts` (8-way
   * around the enemy, on-board, not occupied by another enemy or a
   * delver).
   */
  | {
      kind: "trident-pre-move-dest";
      slotIdx: number;
      cardId: string;
      enemyInstanceId: string;
    };

/**
 * Modal currently open, if any. The BoardScreen renders a single
 * modal at a time; it dispatches by `kind`.
 */
export type Modal =
  | { kind: "action-menu"; slotIdx: number }
  | {
      kind: "die-roll";
      slotIdx: number;
      cardId: string;
      mayReroll: boolean;
      /**
       * The ORIGINAL d6 result. Rolled at modal-open time by
       * `onChooseWeaponAbility` — there's no separate "click here to
       * roll" step. Never mutated by the player's later flip choice
       * (the flipped value is derived on-the-fly from `rolled` +
       * `choice` at Confirm). Optional in the type only because the
       * narrow type-guard in `renderDieRollModal` reads it that way;
       * in practice it's always set when the modal is open.
       */
      rolled?: number;
      /**
       * Sticky player choice in the result stage. `"keep"` confirms
       * the rolled value as-is; `"flip"` pays the reroll cost (today
       * only `may-reroll-by-suffering` — i.e. 1 HP per `suffer` count)
       * and submits the flipped value. Defaults to `"keep"` at modal
       * open. The board target preview reads this so the previewed
       * tiles match the current selection. Confirm dispatches the
       * appropriate dieRoll + suffered combo to the engine.
       */
      choice?: "keep" | "flip";
    }
  | {
      kind: "delver-choice";
      slotIdx: number;
      ability:
        | Extract<SlotAbility, { kind: "gain-token" }>
        | Extract<SlotAbility, { kind: "gain-element" }>;
    }
  | {
      kind: "counter-roll";
      /**
       * Two-step state, mirroring `die-roll` (DESIGN.md §5.4.2). When
       * undefined the modal shows a "Roll Die" button; once the player
       * rolls we set this and re-render the modal with the result +
       * per-delver damage breakdown + a Confirm button. (No suffer-to-
       * flip for counter rolls — that effect is weapon-card-specific.)
       */
      rolled?: number;
    }
  /**
   * AP-spend menu (DESIGN.md §4.3 — in-wave AP economy). Opens when
   * the active delver taps the AVAILABLE box on their suit board.
   * Lists every available AP-spend (currently: double movement,
   * refresh weapon).
   */
  | { kind: "ap-spend" }
  /**
   * Slot picker for the "Spend 2 AP → refresh weapon" option. Listed
   * after the player picks Refresh from the AP-spend menu.
   */
  | { kind: "ap-refresh-pick-slot" }
  /**
   * Level-Up draw modal (rulebook p24). Opened by
   * `screens/ActionResolution.ts > advanceAfterAction` whenever an
   * action finalize leaves `state.encounter.pendingLevelUpDraws`
   * non-empty. Reads the head pending-draw entry to decide which
   * delver is choosing and which card was drawn. Closes itself once
   * `applyLevelUpChoice` has popped the queue.
   */
  | { kind: "level-up" }
  /**
   * Opinion-Card rank pick modal (rulebook p7 — Xavier Ally /
   * Confidant / Detractor). Opened by the BoardScreen / DelverSpawnPick
   * render at the start of every quest, as long as
   * `state.encounter.pendingOpinionRankPicks` has entries. Reads
   * the head pending pick to render the appropriate header
   * ("Xavier's favor: +1 RANK") and offers a delver picker (when
   * the pick has `heroId: null`) plus the legal equipment-type
   * grid (filtered by `eligibleEquipmentTypesForPick`).
   *
   * Closes itself once `applyOpinionRankPick` has popped the queue;
   * the next entry (if any) re-opens against the new head pick.
   * Start-Wave + End-Turn gates keep the player from progressing
   * past unresolved picks (mirrors `pendingLevelUpDraws` gating).
   */
  | { kind: "opinion-rank-pick" }
  /**
   * Suit Condition rank pick triggered by a Scenario Card effect
   * (`grant-equipment-rank-one-delver`). Drains
   * `state.pendingSuitConditionPicks` for entries enqueued with the
   * `scenario-card-*-rank` source prefix. Auto-opened by BoardScreen
   * after the scenario-card modal closes, using the same two-step
   * hero→confirm flow used by Academy donations. Dismisses itself
   * (calls `setModal(null)`) when the queue empties.
   */
  | { kind: "suit-condition-rank-pick" }
  /**
   * Scenario Card resolution (rulebook + Ch2 storybook PROOF 6 —
   * "Resolve Scenario Card #N" at Wave 2+ start).
   *
   * Two-step modal:
   *   1. Front of card — narrative + choice buttons (A/B/C).
   *   2. Back of card — resolution text for the chosen option +
   *      a Continue button that closes the card (pushes the
   *      number onto `state.scenarioCardsResolved`, nulls
   *      `state.currentScenarioCard`).
   *
   * The modal is auto-opened by BoardScreen whenever
   * `state.currentScenarioCard` is non-null and no other modal
   * is in flight (mirrors the auto-open pattern for
   * `opinion-rank-pick`). Closes itself by calling
   * `setModal(null)` once the player taps Continue; the
   * encounter resumes normal turn flow on the next render.
   */
  | { kind: "scenario-card" }
  /**
   * Friendly Encounter resolution (Friendly Spawn Cards #13/#14
   * place a Friendly Encounter token on the board; a delver or
   * Witness steps onto the tile and a card from the printed
   * Friendly Encounter deck is drawn).
   *
   * Single-step modal: printed card art + Continue button. The
   * effect is applied manually at the table today (mirrors the
   * MANUAL scenario-card pattern); Continue pops the head of
   * `state.pendingFriendlyEncounters` and chains into
   * `presentRewards` with a `friendly-encounter-resolved` event.
   *
   * Auto-opened by BoardScreen whenever
   * `state.pendingFriendlyEncounters` is non-empty and no other
   * modal is in flight. Mirrors the `scenario-card` auto-open
   * pattern so a reload mid-pickup still surfaces the unresolved
   * encounter on next boot (the queue lives at campaign scope
   * and is persisted).
   */
  | { kind: "friendly-encounter" }
  /**
   * Rules Viewer modal -- opened from the BoardScreen topbar's
   * "RULES" button. Displays one rulebook page image at a time
   * (`/rulebook/rulebook-page-NN.jpg`); the player taps Prev /
   * Next or the page itself to flip. `pageNumber` is 1-based
   * (matches the printed page numbers and the image filename
   * padding) and starts at 1 on first open.
   *
   * Ephemeral by design -- the page cursor lives on uiState (not
   * CampaignState) so a reload resets back to page 1 next time
   * the modal opens. No engine state is mutated; the modal is
   * pure reference + cancel-able.
   */
  | { kind: "rules-viewer"; pageNumber: number }
  /**
   * Sol / Lunar Shield activation prompt (DESIGN.md §5.4.x).
   *
   * Sits BETWEEN the Counterattack Result confirm and the actual HP
   * deduction. Computed via `findShieldOpportunities` after the
   * counter roll — when at least one shield-bearer has an element to
   * spend and a tile-mate (incl. self) about to take damage. Walks
   * the queue one bearer at a time; each prompt offers Skip + one
   * "Spend {element}" button per non-empty element kind in the
   * bearer's bag. Once the cursor passes the last entry, the engine's
   * `applyCounterDamageWithShieldChoices` runs with the recorded
   * choices and the flow proceeds into `finalizeAndAdvance` (which
   * may then open the Level-Up modal as usual).
   *
   * `cursor` indexes into `queue`; choices are keyed by
   * `shieldBearerHeroId`. Skipped opportunities still appear in
   * `choices` (with `kind: "skip"`) so the engine call is total.
   */
  | {
      kind: "shield-prompt";
      counterRoll: number;
      queue: ShieldOpportunity[];
      cursor: number;
      choices: Record<string, ShieldChoice>;
      /**
       * Elements the bearer at `queue[cursor]` has tentatively spent
       * during THIS prompt session, in click order. Each entry maps
       * to one shield activation; the array is finalised into a
       * `ShieldChoice` (`{kind:"spend", elements:pendingSpends}`)
       * when the player clicks "Done". Cleared whenever the cursor
       * advances. Empty array = no spends yet (and clicking "Done"
       * with an empty array is equivalent to "Skip").
       *
       * Lives on the modal (not the engine) because it's mid-prompt
       * UI state — the engine doesn't see a partial choice; it only
       * sees the finalised choice when the queue commits.
       */
      pendingSpends: Element[];
      /**
       * Trident `weapon-counter-block` choice that was made BEFORE
       * the shield queue opened. Carried through so the final
       * `applyCounterDamageWithShieldChoices` call can apply both
       * reductions in one shot. `undefined` when the swing wasn't
       * a Trident swing, or the player skipped the prompt.
       */
      weaponCounterBlock?: WeaponCounterBlockChoice;
    }
  /**
   * Sol / Lunar Shield activation prompt for PARTING SHOTS (rulebook
   * p26 Parting Shots phase, post-2026-05-25).
   *
   * Sits BETWEEN the player clicking "Resolve" on a parting shot
   * and the engine's `resolvePartingShot` call. Computed via
   * `findPartingShotShieldOpportunities` — when at least one
   * shield-bearer has an element to spend AND a tile-mate (incl.
   * self) about to take parting-shot damage > 0. Walks the queue
   * one bearer at a time using the same UI as `shield-prompt`
   * (multi-spend buttons, cap pill at 1, undo, etc.). On commit,
   * the modal calls `resolvePartingShot(state, params)` with
   * `params.shieldChoices` populated; the engine folds the
   * reductions into the damage map BEFORE applying.
   *
   * `partingShotParams` carries the original `chosenDelverId` (for
   * tied `nearest-delver` cases) so the resolve call sees the same
   * targeting decision the player made before the prompt opened.
   */
  | {
      kind: "parting-shot-shield-prompt";
      queue: ShieldOpportunity[];
      cursor: number;
      choices: Record<string, ShieldChoice>;
      pendingSpends: Element[];
      partingShotParams: { chosenDelverId?: string };
    }
  /**
   * Slip Strider Boots (Mind) — rotation picker modal that opens
   * after the player has picked an adjacent enemy to rotate. Three
   * buttons: rotate 90° / 180° / 270° clockwise, plus Cancel.
   * Confirming dispatches `rotateAdjacentEnemy` and closes.
   *
   * The chosen `targetEnemyId` is duplicated here (also lives on the
   * armed state) so the modal renderer doesn't have to walk back to
   * `armedAbility` to find it.
   */
  | {
      kind: "boots-rotate-direction";
      targetEnemyId: string;
    }
  /**
   * Soulshift Sword (Body, R1) post-kill die-roll modal. Two-stage
   * (mirrors `die-roll` and `counter-roll` patterns):
   *
   *   Stage A (`rolled === undefined`)
   *     Single "Roll die" button. Clicking it rolls a d6, sets
   *     `rolled`, and re-opens the same modal in stage B.
   *
   *   Stage B (`rolled` set)
   *     Show the rolled value + outcome:
   *       - 1-3 OR no adjacent live enemies → outcome message + Close
   *         button. Closing returns to the normal turn flow.
   *       - 4-6 with adjacent live enemy → "Skip" + "Swing again"
   *         buttons. Skip closes; Swing again arms the
   *         `soulshift-repeat-target` picker and closes the modal.
   *
   * `slotIdx` and `cardId` are captured at modal-open time and
   * forwarded to the armed state on Swing again so the bonus swing
   * dispatches against the correct (still-placed) weapon slot.
   *
   * Engine: `engine/soulshift.ts > classifySoulshiftRoll`.
   */
  | {
      kind: "soulshift-roll";
      slotIdx: number;
      cardId: string;
      rolled?: number;
    }
  /**
   * Scorchline Beam (Body, R2-R5) "Fire Beam Again?" prompt opened
   * by `advanceAfterAction` while the bearer's
   * `beamRepeatsRemaining` counter is > 0. Two buttons: "Fire" arms
   * the `beam-repeat-target` picker on the board so the player can
   * pick a new straight line; "Skip" forces the counter to 0 and
   * closes (no banking).
   *
   * `slotIdx` and `cardId` are captured at modal-open time and
   * forwarded to the armed picker on Fire so the bonus swing
   * dispatches against the correct (still-placed) weapon slot.
   *
   * `remaining` is a snapshot of `beamRepeatsRemaining[heroId]` at
   * modal-open time so the modal can show "1 of 4 repeats left"
   * without re-reading state at render time. The header copy uses
   * this to surface "Fire Again? (X repeat(s) left)".
   *
   * Engine: `engine/beamRepeat.ts > attackSessionTriggersBeamRepeat`,
   * `clearBeamRepeats` (Skip path).
   */
  | {
      kind: "beam-repeat-prompt";
      slotIdx: number;
      cardId: string;
      remaining: number;
    }
  /**
   * CREATURE PART pickup pick — MINION vs BOSS — opened by
   * `advanceAfterAction` while
   * `state.encounter.pendingCreaturePartChoices` is non-empty.
   * The head entry decides which delver is picking and which
   * weapon's flavour to surface in the header. Two big buttons
   * (MINION PART / BOSS PART). Each pick increments the
   * corresponding wallet, fires the wallet-fly animation, pops
   * the head, and re-runs `advanceAfterAction` so the next
   * pending pick (or the standard end-turn tail) takes over.
   *
   * Cancel-less by design: a queued pickup must resolve before
   * the player can advance the phase. End-Turn / "Continue"
   * gates check `pendingCreaturePartChoices.length === 0`
   * alongside the other queues.
   *
   * The modal reads from the state queue directly — no payload
   * fields needed beyond `kind`. Multiple pending picks open
   * one modal at a time (FIFO).
   */
  | {
      kind: "creature-part-pick";
    }
  /**
   * Element-pick prompt for "gain element" effects (Elemental OS
   * IMMEDIATELY + ONGOING). Reads the head of
   * `state.encounter.pendingElementChoices` to decide which delver
   * is picking and what triggered the prompt; renders a 6-button
   * element grid (one per `Element` value). Buttons for elements at
   * the bag cap (2 of that element) are disabled — silently
   * "gained" tokens still pop the queue per rulebook p17.
   *
   * Cancel-less by design: a queued grant must be resolved before
   * the player can advance the phase. End-Turn / "Continue" buttons
   * gate on `pendingElementChoices.length === 0`.
   *
   * After applying the pick, the next entry in the queue (if any)
   * re-opens this modal. Only when the queue empties does the flow
   * route back to the LevelUpModal queue, the Soulshift roll, the
   * End Wave continue gate, etc.
   *
   * Engine wiring: `engine/os.ts > applyElementChoice`.
   */
  | { kind: "element-pick" }
  /** Ch4 Ritual (Winona the Oak): the attacker picks an equipment to sacrifice. */
  | { kind: "ritual-pick" }
  /**
   * Witness companion "Move Witness up to 2 tiles" Action (Witness
   * Reference Card v2 PROOF 1; engine in `engine/witness.ts`).
   *
   * Opened by the action-menu modal's "Move Witness" option (added
   * 2026-05-19). While open:
   *   - the BoardScreen paints a Witness destination overlay (8-way
   *     legal tiles from `legalWitnessStepDestinations`),
   *   - tapping a tile fires `stepWitness`; the modal re-renders
   *     with the updated step counter + the pickups summary,
   *   - the modal's "Done" button closes itself. No engine state
   *     change on close — the per-turn step counter
   *     (`witnessStepsThisTurn`) and the `actionUsedThisTurn` latch
   *     are already up-to-date from each individual step call.
   *
   * Player can re-open the modal from the action-menu while
   * `witnessStepsThisTurn ∈ (0, WITNESS_ACTION_STEP_CAP)` — i.e.
   * step 2 of the same Action is still spendable after closing
   * the modal post-step-1.
   */
  | { kind: "witness-move" }
  /**
   * Trident `pre-attack-may-move-adjacent` opening prompt — fires
   * when the player picks "Use weapon ability" on a Trident. Three
   * options:
   *
   *   - Skip: don't move, fire the swing immediately at the printed
   *     pattern.
   *   - Pick adjacent enemy: arm the `trident-pre-move-target`
   *     picker and close the modal so the board overlays show.
   *
   * Disabled / auto-skip case: if no live enemy is 8-way adjacent
   * to the bearer, the modal is bypassed entirely (the renderer
   * jumps straight to firing the swing).
   *
   * `slotIdx` + `cardId` carry through to the eventual
   * `useWeaponAbility` call.
   */
  | {
      kind: "trident-pre-move-prompt";
      slotIdx: number;
      cardId: string;
    }
  /**
   * `weapon-counter-block` prompt — fires AFTER the counter roll
   * AND AFTER the per-delver damage breakdown is shown, but BEFORE
   * damage actually lands. Multi-pick: player toggles UP TO `cap`
   * counterattackers (each reduces by the printed block amount),
   * then confirms. Skip = no picks.
   *
   * Auto-skipped at open time when:
   *   - the counter outcome is `miss`, OR
   *   - no counterattacking enemy would actually hit a delver, OR
   *   - the source weapon's `weapon-counter-block.amount` is 0.
   *
   * `rolled` is the d6 result (forwarded to
   * `applyCounterDamageWithShieldChoices` so shield prompts can
   * reuse the same outcome).
   *
   * `cap` mirrors `weapon-counter-block.count` (Trident: 1,
   * Shockwave: 2). Snapshotted at open time so the renderer doesn't
   * have to re-read the source card on every refresh.
   *
   * `picked` is the currently-selected enemyInstanceId list. UI
   * enforces `picked.length <= cap`; clicking a selected enemy
   * deselects it. Confirm dispatches `{ kind: "block",
   * enemyInstanceIds: picked }` (or `{ kind: "skip" }` when empty).
   */
  | {
      kind: "weapon-counter-block-prompt";
      rolled: number;
      cap: number;
      picked: string[];
    }
  /**
   * Equipment IMMEDIATELY die-roll modal. Opened from the
   * post-level-up flow (`advanceAfterAction`) when
   * `state.encounter.pendingEquipmentRolls` is non-empty. Serves
   * every R1+ card carrying the `immediately-equipment-roll`
   * effect — today Supercharger and Battery, extensible to future
   * cards via `engine/tokens.ts > EQUIPMENT_ROLL_TABLES`.
   *
   * Two-stage (mirrors `die-roll` / `counter-roll`):
   *
   *   Stage A (`rolled === undefined`)
   *     Single "Roll die" button. Clicking it rolls a d6, sets
   *     `rolled`, and re-renders. (A Reroll consumable can be
   *     spent here too — see below.)
   *
   *   Stage B (`rolled` set)
   *     Branches on the per-card outcome table looked up via
   *     `equipmentRollTableForCard(cardId)`:
   *       - direct outcome  → show the granted outcome + Confirm.
   *         Confirm dispatches `applyEquipmentRoll` with the
   *         outcome that maps 1:1 to the roll.
   *       - `"choice"`      → show one button per outcome on the
   *         table (e.g. Supercharger: 4 buttons; Battery: 2
   *         buttons). Clicking a button dispatches
   *         `applyEquipmentRoll` with the chosen outcome and
   *         closes.
   *
   * Reroll consumable: a "Reroll (1 token)" button is offered in
   * Stage B when `canSpendReroll(state, heroId).ok`. Clicking it
   * spends the token, re-rolls the die, and re-renders Stage B
   * with the new result. (Per the user's 2026-05-04 ruling: any
   * die roll the player makes can be rerolled.)
   *
   * `heroId` and `cardId` are snapshotted at modal-open time so the
   * renderer can display "<Hero>: rolling for <Card name>" without
   * re-reading the queue (which is consumed on confirm).
   *
   * Cancel-less by design (same as element-pick): a queued roll
   * must be resolved before the player can advance the phase.
   * End-Turn / "Continue" gates check `pendingEquipmentRolls`
   * for emptiness alongside `pendingElementChoices`.
   */
  | {
      kind: "equipment-roll";
      heroId: string;
      cardId: string;
      rolled?: number;
    }
  /**
   * XP die-roll modal — resolves the head of
   * `encounter.pendingXpRolls` (on-death "Gain 1 [die] XP" from
   * Ophidian 017 / Sporecloud 022). Same two-stage Roll → Confirm
   * shape as `equipment-roll`, including the Reroll-token offer in
   * Stage B (2026-05-04 ruling: any player die roll can be
   * rerolled). Confirm banks the roll via
   * `engine/kills.ts > applyXpRoll` (which also resolves any
   * level-ups the XP triggers) and pops the queue.
   *
   * Cancel-less by design: End-Turn / advance gates check
   * `pendingXpRolls` alongside the other queues.
   */
  | {
      kind: "xp-roll";
      heroId: string;
      enemyCardId: string;
      rolled?: number;
    }
  /**
   * Block Counterattack pick modal — opens from the
   * counter-roll modal's "Block 1 counterattack" button.
   * Renders one button per damaged counterattacker (with its name +
   * incoming damage); picking one mutates `phase.damagedEnemies`
   * to drop that enemy entirely from the counter resolution + spends
   * one BLOCK COUNTERATTACK token + latches the per-turn cap +
   * routes back to the counter-roll modal at the same `counterRoll`.
   *
   * `counterRoll` is carried through so the back-button + the
   * post-pick re-render preserve the rolled die without forcing
   * another roll.
   *
   * Cap: 1 prevent spend per delver-turn. The button on the
   * counter-roll modal will be hidden after a spend completes.
   */
  | {
      kind: "prevent-counter-pick";
      counterRoll: number;
      /** Which delver's token is being spent for this prevent. */
      spenderHeroId: string;
    }
  /**
   * Informational acknowledgement shown when a weapon auto-blocked
   * counter damage (e.g. Shift Trident) and there are no shield
   * activations queued. Carries enough data to complete the
   * pending counter resolution when the player taps OK.
   */
  | {
      kind: "weapon-block-info";
      /** The roll value from the counter step. */
      counterRoll: number;
      /** The auto-applied block choice to hand to the engine. */
      weaponCounterBlock: import("./engine/combat").WeaponCounterBlockChoice & { kind: "block" };
      /** Per-enemy block amount (for display). */
      blockAmountPerEnemy: number;
      /** Human-readable source weapon name (e.g. "Shift Trident"). */
      weaponName: string;
    }
  /**
   * Double Damage spend prompt — fires AFTER the player has armed a
   * weapon ability and picked a target tile, but BEFORE the swing
   * actually fires. Renders the printed swing damage, the matching
   * typed DD button (e.g. "Spend 1 x 2x LIGHT (N available)"), the
   * universal DD button (when granted in future), and a "Skip"
   * button.
   *
   * Auto-skipped (modal never opens) when:
   *   - the bearer has no DD tokens of any matching kind, OR
   *   - the bearer has already spent a DD token this turn
   *     (`turnState.damage2xUsedThisTurn`).
   *
   * `slotIdx`/`cardId` capture the placed weapon. The remaining
   * fields (`weaponParams`, `preAttackMove`) are forwarded to the
   * eventual `useWeaponAbility` call so the DD spend joins the
   * already-resolved attack params in one engine call. We snapshot
   * the params here (rather than re-deriving from armed state)
   * because the armed state may be cleared by intermediate
   * affordances; the prompt only lives for one decision tick.
   */
  | {
      kind: "double-damage-prompt";
      slotIdx: number;
      cardId: string;
      damageType: "light" | "medium" | "heavy";
      weaponParams: import("./engine/turn").WeaponAbilityParams;
      preAttackMove?: {
        enemyInstanceId: string;
        toX: number;
        toY: number;
      };
    }
  /**
   * Mace (both suits R1) mode-pick prompt — fires when the player
   * picks "Use weapon ability" on a Mace AND BOTH modes are viable
   * (at least one filter-matching adjacent enemy AND at least one
   * adjacent enemy AND ≥1 element in bag).
   *
   * Two outcomes:
   *   - Default mode: arm the weapon with NO `spendElementForBypass`;
   *     target overlay paints only filter-matching adjacent
   *     enemies (UNDAMAGED for Mind / DAMAGED for Body).
   *   - Spend element: route to {@link mace-element-pick} when
   *     multiple element kinds are in the bag, or arm directly
   *     with the only available element kind. Target overlay then
   *     paints EVERY adjacent enemy.
   *
   * Auto-skip cases (modal never opens — handled in
   * `onChooseWeaponAbility`):
   *   - Only default mode viable → arm default directly.
   *   - Only spend mode viable + 1 element kind → arm spend directly.
   *   - Only spend mode viable + multiple kinds → element-pick modal.
   *   - Neither mode viable → no-op (action-menu pick is swallowed).
   */
  | {
      kind: "mace-mode-pick";
      slotIdx: number;
      cardId: string;
    }
  /** Machinist upgrade weapons: pick which "Spend N [element]" options to
   *  use before the swing (Engulfing Beam, Precise Shockwave, Sword of
   *  Ruin, Lunar Trident). */
  | {
      kind: "weapon-spend-pick";
      slotIdx: number;
      cardId: string;
      /** Lunar Trident: set once the multiplier die is rolled - the modal
       *  shows the result before targeting continues. */
      rolled?: number;
    }
  /**
   * Mace (both suits R1) element-pick prompt — fires when the
   * player has committed to OR-mode AND the bearer has multiple
   * element kinds in their bag (so the engine needs to know WHICH
   * one to spend). One button per available element kind; clicking
   * arms the weapon with `spendElementForBypass = picked` and
   * closes the modal so the target overlay paints every adjacent
   * enemy as legal.
   *
   * Reachable via:
   *   - Direct route from the action-menu when only OR-mode is
   *     viable AND the bag holds >1 element kind.
   *   - "Spend element" button on the {@link mace-mode-pick} modal
   *     when both modes are viable AND the bag holds >1 element
   *     kind (so the player has to disambiguate after committing).
   *
   * If the bag holds exactly 1 element kind both upstream paths
   * skip this modal and arm directly with that kind.
   */
  | {
      kind: "mace-element-pick";
      slotIdx: number;
      cardId: string;
    }
  /**
   * Scenario-Delver pick modal — opened automatically by BoardScreen
   * whenever `state.pendingScenarioDelverPicks` is non-empty and no
   * other modal is in flight. Each pick grants or takes a per-delver
   * resource (consumable token, AP, HP) and requires the player to
   * choose WHICH delver is affected.
   *
   * Drains `state.pendingScenarioDelverPicks` one entry at a time.
   * Closes itself (calls `setModal(null)`) when the queue empties.
   * Cancel-less by design (same as element-pick): unresolved picks
   * must be drained before the board flow continues.
   */
  | { kind: "scenario-delver-pick" }
  /**
   * End-Turn confirmation prompt (2026-05-21). Opens when the player
   * taps End Turn after taking 1+ movement steps but BEFORE placing
   * a weapon card. Two outcomes — the player MUST pick one
   * (cancel-less by design, no Escape / no backdrop dismiss):
   *
   *   - "Undo and submit" — calls
   *     `engine/movement.ts > undoMovementThisTurn` to rewind the
   *     turn's movement to its pre-step baseline (position, MP,
   *     parts counters, tile drops), then commits End Turn.
   *   - "Go Back" — closes the modal, leaves the encounter state
   *     untouched. The player can then place a card, keep moving
   *     (if MP remains), or tap End Turn again to re-open this
   *     prompt.
   *
   * Ephemeral by design: this modal is in-memory `uiState` and is
   * NOT persisted to localStorage. If the app reloads while the
   * prompt is open, the player sees the normal BoardScreen on
   * boot — i.e. the absent modal is equivalent to having picked
   * "Go Back". (The underlying movement state is persisted via
   * `CampaignState`, so the rewind option is still available on
   * the next End Turn tap.)
   */
  | { kind: "end-turn-undo-prompt" };

const state = {
  /**
   * The hero whose suit board + hand are currently being VIEWED on the
   * BoardScreen right column. `null` means "view the active delver"
   * (`state.currentDelverId`); a non-null id means the active player is
   * peeking at the other delver's state via the top-bar button.
   */
  peekedDelverId: null as string | null,

  /**
   * Per-hero "selected hand card" for the click-to-place flow. Both the
   * HandPanel (where you pick) and the SuitPanel (where you drop) read
   * this so they render the highlight + drop-target affordances in sync.
   */
  selectedCardByHero: {} as Record<string, string | null>,

  /**
   * The currently-armed ability — UI is awaiting a target click.
   * Slice 4c (DESIGN.md §5.2). See {@link ArmedAbility}.
   */
  armedAbility: null as ArmedAbility | null,

  /**
   * Two-step movement gate (mirrors `armedAbility` for movement). When
   * `false`, the active delver's tile shows an actionable pulse and
   * the destination overlays are HIDDEN — the player must tap their
   * own tile first to "arm" the move. When `true`, destination tiles
   * become clickable and tapping the source tile again cancels.
   * Cleared on End Turn / hero swap via `clearActionState()`.
   */
  movementArmed: false,

  /**
   * The in-progress attack session (mutated by `resolveAllDamage` and
   * `resolveSharedCounter`). The counter-roll modal reads
   * `session.sharedCounter` to drive its preview + per-delver
   * damage breakdown. Cleared via `clearActionState()` once the
   * action resolves and any pending level-ups are picked.
   */
  attackSession: null as AttackSession | null,

  /**
   * Currently-open modal. `null` means nothing open. Only one modal
   * at a time (DESIGN choice — counter prompts are blocking).
   */
  modal: null as Modal | null,

  /**
   * Resolution log for the Parting Shots Phase. Each
   * {@link PartingShotResult} returned by `resolvePartingShot` is
   * pushed here so the panel can show the full sequence of resolved
   * shots in order. Cleared when leaving the phase.
   */
  partingShotLog: [] as PartingShotResult[],

  /**
   * Most recent auto-refresh-on-placement event (DESIGN.md §4.3).
   * Set by SuitPanel when {@link playWeaponCard} returns
   * `autoRefresh`; consumed by BoardScreen to render a transient
   * banner; cleared on End Turn / next placement / user dismiss.
   */
  lastAutoRefresh: null as AutoRefreshToast | null,
};

// --- Peek (which delver's column is shown on the board) ------------------

export function getPeekedDelverId(): string | null {
  return state.peekedDelverId;
}

export function setPeekedDelverId(id: string | null): void {
  state.peekedDelverId = id;
}

export function clearPeek(): void {
  state.peekedDelverId = null;
}

// --- Hand-card selection -------------------------------------------------

export function getSelectedCard(heroId: string): string | null {
  return state.selectedCardByHero[heroId] ?? null;
}

export function setSelectedCard(heroId: string, cardId: string | null): void {
  state.selectedCardByHero[heroId] = cardId;
}

/**
 * Click semantics for hand cards: clicking the already-selected card
 * deselects it; clicking any other card selects it.
 */
export function toggleSelectedCard(heroId: string, cardId: string): void {
  const cur = state.selectedCardByHero[heroId] ?? null;
  state.selectedCardByHero[heroId] = cur === cardId ? null : cardId;
}

export function clearSelectedCard(heroId: string): void {
  state.selectedCardByHero[heroId] = null;
}

// --- Action-step ephemera (Slice 4c) ------------------------------------

export function getArmedAbility(): ArmedAbility | null {
  return state.armedAbility;
}

export function setArmedAbility(a: ArmedAbility | null): void {
  state.armedAbility = a;
}

export function getMovementArmed(): boolean {
  return state.movementArmed;
}

export function setMovementArmed(v: boolean): void {
  state.movementArmed = v;
}

export function getAttackSession(): AttackSession | null {
  return state.attackSession;
}

export function setAttackSession(s: AttackSession | null): void {
  state.attackSession = s;
}

export function getModal(): Modal | null {
  return state.modal;
}

export function setModal(m: Modal | null): void {
  state.modal = m;
}

// --- Auto-peek to a modal's deciding delver --------------------------

/**
 * Per-delver "decider" of the currently-open modal, or `null` if the
 * modal has no specific delver in mind (or no modal is open).
 *
 * Used by {@link syncAutoPeekToModal} to drive the right-column
 * suit/hand view to the delver whose decision the modal is asking
 * for, so the player can see THAT delver's elements / hand / slots
 * while making the choice. After the modal closes the view returns
 * to the active delver (`state.currentDelverId`).
 *
 * Recognised modals (per design decision 2026-05-09):
 *   - `level-up`        — head of `pendingLevelUpDraws`
 *   - `equipment-roll`  — `modal.heroId`
 *   - `element-pick`    — head of `pendingElementChoices`
 *   - `shield-prompt`   — current cursor entry's `shieldBearerHeroId`
 *
 * All other modals (action-menu, die-roll, counter-roll, ap-spend,
 * trident/mace/boots/soulshift pickers, etc.) are part of the active
 * delver's own action sequence and don't need a peek shift.
 */
export function modalDecider(
  modal: Modal | null,
  enc: EncounterState | null,
): string | null {
  if (!modal) return null;
  switch (modal.kind) {
    case "level-up":
      return enc?.pendingLevelUpDraws[0]?.heroId ?? null;
    case "element-pick":
      return enc?.pendingElementChoices[0]?.heroId ?? null;
    case "equipment-roll":
      return modal.heroId;
    case "xp-roll":
      return modal.heroId;
    case "shield-prompt":
      return modal.queue[modal.cursor]?.shieldBearerHeroId ?? null;
    case "parting-shot-shield-prompt":
      return modal.queue[modal.cursor]?.shieldBearerHeroId ?? null;
    default:
      return null;
  }
}

/**
 * Latch for "the current peek is auto, not manual". When `true`,
 * the next call to {@link syncAutoPeekToModal} that finds NO decider
 * will clear the peek (returning the view to the active delver).
 * When `false`, no auto-peek is currently in effect, so a "no
 * decider" sync is a no-op (manual peek state is preserved).
 */
let autoPeekActive = false;

/**
 * Reactively sync `peekedDelverId` to the currently-open modal's
 * deciding delver. Called once per BoardScreen render BEFORE
 * `peekedDelverId` is read, so the right-column view tracks the
 * modal queue without each individual `setModal(...)` call site
 * needing to thread through the campaign state.
 *
 * Behavior matrix:
 *
 * | newDecider | autoPeekActive | Action                             |
 * |------------|----------------|------------------------------------|
 * | non-null   | (any)          | setPeekedDelverId(newDecider); on  |
 * |            |                | switching deciders mid-queue       |
 * |            |                | (e.g. two delvers' Battery rolls   |
 * |            |                | back-to-back) the peek follows.    |
 * |            |                | Latch goes ON.                     |
 * | null       | true           | clearPeek() — restore view to the  |
 * |            |                | active delver. Latch goes OFF.     |
 * | null       | false          | No-op — manual peek (if any) is    |
 * |            |                | preserved.                         |
 *
 * Side effect: also wipes manual peek when an auto-peek session
 * ends. The user explicitly opted into "always restore to active
 * delver" semantics on 2026-05-09, accepting that a manual peek
 * set BEFORE a per-delver modal opened will not be restored after.
 */
export function syncAutoPeekToModal(
  modal: Modal | null,
  enc: EncounterState | null,
): void {
  const decider = modalDecider(modal, enc);
  if (decider !== null) {
    state.peekedDelverId = decider;
    autoPeekActive = true;
  } else if (autoPeekActive) {
    state.peekedDelverId = null;
    autoPeekActive = false;
  }
}

/**
 * Reset all action-step ephemera — armed ability, attack session,
 * and modal. Called at End Turn / hero swap AND between actions
 * within a turn (via `advanceAfterAction`) so a stale prompt or
 * armed state can't bleed across actions.
 *
 * Intentionally does NOT wipe `lastAutoRefresh`: the REFRESHED
 * banner is a transient toast that lives across the action that
 * generated it until (a) the player makes their next placement
 * (SuitPanel clears it inline), (b) End Turn / hero swap fires
 * (callers wipe it explicitly via `clearLastAutoRefresh`), or (c)
 * the player clicks the dismiss "x" on the banner. Pre-2026-05-09
 * it WAS wiped here, which silently killed the AP-refresh banner
 * because `advanceAfterAction` always calls clearActionState — see
 * the bug-history note on `onApRefreshSlot`.
 */
export function clearActionState(): void {
  state.armedAbility = null;
  state.movementArmed = false;
  state.attackSession = null;
  state.modal = null;
  // Drop the auto-peek latch too AND clear any peek it set.
  //
  // We MUST do the clear here (not leave it to a later
  // `syncAutoPeekToModal`) because `clearActionState` runs BEFORE the
  // next render in `advanceAfterAction`'s default branch — by the
  // time the render's `syncAutoPeekToModal(null, enc)` fires the
  // latch is already `false`, so it would no-op and the peek would
  // stay stuck on the modal's deciding delver.
  //
  // Concrete repro (2026-05-25): at quest start, hero-02 takes the
  // first turn but hero-01 holds Supercharger. The equipment-roll
  // modal opens for hero-01, auto-peek sets `peekedDelverId=hero-01`.
  // After resolving the roll, `advanceAfterAction` falls into the
  // default branch and calls `clearActionState`. Without this peek
  // wipe the right-column view stayed on hero-01 even though
  // hero-02 was the one taking the turn.
  //
  // For End Turn / hero swap callers (`commitManualEndTurn`,
  // `maybeAutoEndTurn`) this is redundant — they explicitly call
  // `clearPeek()` BEFORE clearing action state — but the redundant
  // null-assign is harmless.
  if (autoPeekActive) {
    state.peekedDelverId = null;
  }
  autoPeekActive = false;
}

// --- Wave-phase ephemera (parting shots) --------------------------------

export function getPartingShotLog(): PartingShotResult[] {
  return state.partingShotLog;
}

export function pushPartingShotLog(entry: PartingShotResult): void {
  state.partingShotLog.push(entry);
}

export function clearWavePhaseEphemera(): void {
  state.partingShotLog = [];
}

// --- Auto-refresh toast (DESIGN.md §4.3) -------------------------------

export function getLastAutoRefresh(): AutoRefreshToast | null {
  return state.lastAutoRefresh;
}

export function setLastAutoRefresh(t: AutoRefreshToast | null): void {
  state.lastAutoRefresh = t;
}

export function clearLastAutoRefresh(): void {
  state.lastAutoRefresh = null;
}

// --- Damage / Heal FX (transient board overlay) ------------------------
//
// Pure-UI splash effect that fires whenever a delver or an enemy
// takes damage, OR a delver is healed. Implemented as an HP-diff
// between BoardScreen renders so the engine stays unaware of
// presentation:
//
//   1. At the END of every BoardScreen render the screen calls
//      `snapshotTokenHealth(snap)` with the current set of token
//      HP entries (one per delver + one per alive enemy).
//   2. At the START of the NEXT render the screen calls
//      `detectDamageAndQueueFx(snap)` with the FRESH snapshot. The
//      diff against the previous snapshot drives one
//      `HpFxEvent` per token that lost HP (or vanished from the
//      board entirely while previously holding HP — i.e. died) AND
//      one per delver-token that GAINED hp (heal source — scenario
//      card heal-both-delvers, Sol Shield overblock, etc.).
//   3. The render walks `getActiveDamageFx()` and paints an
//      absolute-positioned `.damage-fx` (kind=damage) or
//      `.heal-fx` (kind=heal) element per active event, anchored
//      to the cell the change landed on. CSS handles the ~600ms
//      animation; expired events are auto-pruned on the next
//      snapshot call.
//
// Key resilience properties:
//   - Engine is untouched. Every HP-mutating site (counterattack,
//     parting shot, slot ability, soulshift, self-suffer, scenario
//     heals, shield overblock, etc.) surfaces an FX automatically.
//   - Multiple renders during the FX window don't duplicate events
//     — the queue is keyed by `(tokenId, startedAt)` and events
//     only get pushed on the snapshot transition, not on every
//     render.
//   - Heal events are scoped to delver tokens only (`id` starts
//     with `delver-`) — enemies rarely heal in this game, and we
//     don't want a stray enemy hp-bookkeeping bump to look like a
//     player-facing reward.
//   - Token-vanish-while-positive-HP is treated as the enemy
//     dying with its remaining HP as the killing blow.
//   - Position carries over from the previous snapshot when the
//     token has disappeared (so the splash lands where the kill
//     happened, not at (0,0)).

export interface TokenHealthSnap {
  /** Stable token id (matches `BoardToken.id`). */
  id: string;
  /** Grid cell — used as the FX anchor. */
  col: number;
  row: number;
  /** Current HP. 0 = dead-but-still-on-board (counter window). */
  hp: number;
}

export interface DamageFxEvent {
  /**
   * `damage` for the original loss-only path (red splash); `heal`
   * for the new HP-gain path (green pulse on the delver tile +
   * heart-marker flash on the topbar).
   */
  kind: "damage" | "heal";
  /** Unique key for React-style render de-dupe (tokenId + ts). */
  id: string;
  tokenId: string;
  amount: number;
  col: number;
  row: number;
  /** `performance.now()` at the moment the diff was detected. */
  startedAt: number;
}

/** Window the splash element stays in the queue / animates for. */
const DAMAGE_FX_DURATION_MS = 650;

let prevTokenSnap: Map<string, TokenHealthSnap> = new Map();
let damageFxQueue: DamageFxEvent[] = [];

/**
 * Diff `current` against the previous snapshot and push a
 * `DamageFxEvent` for every token that lost HP — including kills
 * (token vanishes with positive prior HP) — and a `heal`-kind
 * event for every DELVER token that gained HP. Then update the
 * stored snapshot to `current` so the next render diffs against
 * this baseline.
 *
 * Safe to call on the FIRST render (empty prev → no events fire).
 */
export function detectDamageAndQueueFx(current: TokenHealthSnap[]): void {
  const now = performance.now();
  const newSnap = new Map<string, TokenHealthSnap>();
  for (const t of current) newSnap.set(t.id, t);
  for (const [id, prev] of prevTokenSnap) {
    const cur = newSnap.get(id);
    let damage = 0;
    let heal = 0;
    let pos: { col: number; row: number } = { col: prev.col, row: prev.row };
    if (cur) {
      if (cur.hp < prev.hp) {
        damage = prev.hp - cur.hp;
        pos = { col: cur.col, row: cur.row };
      } else if (cur.hp > prev.hp && id.startsWith("delver-")) {
        // Heal — gate to delver tokens so a stray enemy hp delta
        // (debug, future revival mechanic) can't mistakenly look
        // like a player-facing reward. The same gate also keeps
        // the encounter-bootstrap "snapshot enemies for the first
        // time" path silent.
        heal = cur.hp - prev.hp;
        pos = { col: cur.col, row: cur.row };
      }
    } else if (prev.hp > 0) {
      // Token vanished from the board while still holding HP — the
      // enemy was finalized + removed. Treat the residual HP as
      // the killing blow's damage so the splash lands on the kill
      // tile (the enemy's last known position).
      damage = prev.hp;
    }
    if (damage > 0) {
      damageFxQueue.push({
        kind: "damage",
        id: `${id}@${now}`,
        tokenId: id,
        amount: damage,
        col: pos.col,
        row: pos.row,
        startedAt: now,
      });
    } else if (heal > 0) {
      damageFxQueue.push({
        kind: "heal",
        id: `${id}@${now}`,
        tokenId: id,
        amount: heal,
        col: pos.col,
        row: pos.row,
        startedAt: now,
      });
    }
  }
  prevTokenSnap = newSnap;
}

/**
 * Returns currently-active damage / heal FX events (started within
 * the last `DAMAGE_FX_DURATION_MS`). Side-effect: prunes expired
 * entries from the queue so we don't grow without bound across a
 * long game session.
 */
export function getActiveDamageFx(): DamageFxEvent[] {
  const now = performance.now();
  damageFxQueue = damageFxQueue.filter((e) => now - e.startedAt < DAMAGE_FX_DURATION_MS);
  return damageFxQueue.slice();
}

/**
 * Look up the most recent active heal event for a specific
 * delver-token (id format: `delver-${suit}`). Returns `null` when
 * none is active. Used by `SuitPanel` to pulse the heart marker on
 * the topbar in lockstep with the board splash so the player has
 * TWO visual cues that the heal landed (board tile + topbar pip).
 */
export function getActiveHealForDelver(suit: "mind" | "body"): DamageFxEvent | null {
  const tokenId = `delver-${suit}`;
  const events = getActiveDamageFx();
  let latest: DamageFxEvent | null = null;
  for (const e of events) {
    if (e.kind !== "heal") continue;
    if (e.tokenId !== tokenId) continue;
    if (latest == null || e.startedAt > latest.startedAt) latest = e;
  }
  return latest;
}

/** Returns the splash duration in ms — exported so the renderer can
 *  set CSS variables / animation-delay arithmetic in lockstep. */
export function damageFxDurationMs(): number {
  return DAMAGE_FX_DURATION_MS;
}

/**
 * Reset the diff baseline + drop any in-flight FX. Called on
 * fresh-encounter bootstrap and `clearAllUiState` so a campaign
 * reset doesn't replay damage events from the previous session.
 */
export function clearDamageFxState(): void {
  prevTokenSnap = new Map();
  damageFxQueue = [];
  abilityProcFx = [];
  drainAbilityProcs();
}

// --- Enemy ability-proc labels ---------------------------------------------
// When an enemy ability changes what normally happens, the engine records a
// proc (`engine/abilityProcs.ts`); the board floats the ability's name over
// that enemy's tile for ABILITY_PROC_FX_MS. Same re-render-safe pattern as
// the damage FX: events keep their start time and the renderer sets a
// negative animation-delay.

const ABILITY_PROC_FX_MS = 2200;

export interface AbilityProcFx {
  instanceId: string;
  kind: AbilityProcKind;
  col: number;
  row: number;
  startedAt: number;
  /** 0 for the first label on a tile, 1 for the next, ... (stacked upward). */
  stackIdx: number;
}

let abilityProcFx: AbilityProcFx[] = [];

/** Pull new procs from the engine and return every label still showing. */
export function collectAbilityProcFx(): AbilityProcFx[] {
  const now = performance.now();
  abilityProcFx = abilityProcFx.filter((f) => now - f.startedAt < ABILITY_PROC_FX_MS);
  for (const p of drainAbilityProcs()) {
    // One label per enemy + ability per action (Death Heal fires once
    // per healed neighbour; Countdown can repeat within one attack).
    if (abilityProcFx.some((f) => f.instanceId === p.instanceId && f.kind === p.kind && now - f.startedAt < 400)) continue;
    const stackIdx = abilityProcFx.filter((f) => f.col === p.x && f.row === p.y).length;
    abilityProcFx.push({ instanceId: p.instanceId, kind: p.kind, col: p.x, row: p.y, startedAt: now, stackIdx });
  }
  return abilityProcFx.slice();
}

export function abilityProcFxDurationMs(): number {
  return ABILITY_PROC_FX_MS;
}

/**
 * Wipe ALL ephemeral UI state. Used by the campaign-reset path so the
 * fresh save doesn't inherit a peeked delver / selected card / armed
 * ability / open modal from the previous run.
 */
export function clearAllUiState(): void {
  state.peekedDelverId = null;
  state.selectedCardByHero = {};
  state.lastAutoRefresh = null;
  // `autoPeekActive` is reset inside clearActionState() below; no
  // separate reset needed here.
  clearActionState();
  clearWavePhaseEphemera();
  clearDamageFxState();
  clearFreshRolls();
}
