/**
 * Persistent campaign state.
 *
 * Stored in localStorage. Schema-versioned so future shape changes don't
 * crash old saves; bump SCHEMA_VERSION (and the storage key suffix in
 * lockstep) when the shape changes — old saves reset cleanly to a fresh
 * campaign.
 */

import { Tuning } from "./config/tuning";
import type { DamageType, Element, EquipmentCard, EquipmentType } from "./types";
import { ALL_EQUIPMENT_TYPES, EQUIPMENT_RANK_CAP } from "./types";
import {
  getStartingEquipment,
  getHero,
  getEquipmentByTypeSuit,
  getEquipmentByTypeSuitRank,
  getUpgradeEquipment,
  getEquipment,
  getActiveHeroCardStartingEquipment,
  getActiveHeroCardStartingRanks,
  KEY_ITEMS,
} from "./data";

const STORAGE_KEY = "g2g.campaign.v20";
// Exported (intentionally) so unit tests can build minimal v(N-1)
// fixtures and assert the migration bumps the marker correctly.
export const SCHEMA_VERSION = 65;

/**
 * Per-delver in-encounter loadout: which equipment cards sit in which weapon
 * slot, plus current resource trackers. Lives in CampaignState for now;
 * Stage 6 may split encounter-state out of campaign-state.
 */
export interface DelverLoadout {
  heroId: string;
  /** Card id in each printed weapon slot (length = Tuning.weaponSlotsPerSuit). */
  slotCards: (string | null)[];
  /** Current HP. */
  currentHp: number;
  /** Max HP (passive cards like Exoframe Armor can raise this). */
  maxHp: number;
  /**
   * Unified AP pool — spendable RIGHT NOW. Spent by `chargeAp` for
   * the Double-Movement (1) / Refresh-Weapon (2) actions and by
   * any future AP-cost ability. Refreshed to `baseAp` ONLY at the
   * End Wave (`engine/wave.ts > enterEndOfWave` (End Wave refresh)); does NOT
   * refill per-turn (rule unified with the consumable AP token on
   * 2026-05-09 — see `ConsumableTokenKind` jsdoc).
   */
  currentAp: number;
  /**
   * Per-Wave refresh ceiling for `currentAp`. Starts at
   * `Tuning.baseAp` (3); raised mid-quest by Battery's "AP"
   * equipment-roll outcome (`EquipmentRollOutcome.baseApDelta` in
   * `engine/tokens.ts`) and by future level-up cards. Persists for
   * the rest of the quest; reset back to the starter floor at the
   * top of each new quest (per-quest reset is a future hook —
   * today's prototype only ships Q1).
   */
  baseAp: number;
  /** Movement points remaining this turn. */
  currentMovement: number;
  /** Movement points refilled at the start of the delver's turn. */
  baseMovement: number;
}

/**
 * One spawned enemy on the live board. Distinct from the printed
 * `EnemyCard` (which is the static catalog entry in `data/enemies.json`).
 *
 * `instanceId` is stable for the lifetime of the wave so UI elements
 * (damage badges, target highlights) can key off it; multiple instances
 * of the same printed card (e.g. two Crystanid #3s) are unambiguous.
 */
/**
 * Quarter-turn facing of an enemy, in degrees CW from the enemy's
 * printed orientation (0 = as printed; 90 = rotated 90° clockwise;
 * etc.). Modified at runtime by the Slip Strider Boots ONGOING
 * ability ("spend 2 movement to rotate an adjacent enemy"). Affects
 * how the enemy's `counterCommon` / `counterUncommon` offset arrays
 * project onto the board — see `engine/combat.ts > rotateOffset`.
 *
 * Not rotated at spawn; the printed counter pattern lines up with
 * facing 0 by definition.
 */
export type EnemyFacing = 0 | 90 | 180 | 270;

export interface EnemyInstance {
  /** Stable per-wave id (e.g. "minion-3", "boss"). */
  instanceId: string;
  /** Static card id (e.g. "crystanid-005", "soulhunter"). */
  cardId: string;
  /** Current board position. */
  x: number;
  y: number;
  /** Cumulative damage tokens placed on this enemy. Dies at >= card.hp. */
  damageTaken: number;
  /** Convenience flag: `damageTaken < card.hp`. Kept on-state so dead
   *  enemies can be retained for end-of-turn / log purposes if needed. */
  alive: boolean;
  /**
   * Quarter-turn rotation applied to this enemy's counter pattern
   * (and to its on-board card art). Defaults to 0 at spawn; the Slip
   * Strider Boots ONGOING ability cycles it by ±90° per activation.
   * See {@link EnemyFacing}.
   */
  facing: EnemyFacing;
  /** Strength ability monster tokens (Ch3+). Each adds +1 to this
   *  enemy's counterattack damage. Absent = 0. */
  strengthTokens?: number;
  /** Guards ability monster tokens left (Ch3 Golem / Orite). Seeded from
   *  the card on spawn; while > 0 the enemy suffers no damage and each
   *  attack on it removes one. Absent = 0. */
  guardTokens?: number;
  /** Vicious ability monster token (Ch3 Bob the Spider / Diamonid). True
   *  from spawn until an adjacent delver suffers damage; while true,
   *  attacks deal at most 1 damage to it. Absent = false. */
  viciousToken?: boolean;
  /** Ch4 Invulnerable (Spike the Moth): set after it is damaged; the next
   *  delver attack deals no damage and removes it. */
  invulnerableToken?: boolean;
  /** Ch4 Shell: set when its counterattack misses; while set it takes no
   *  damage. Cleared when a counterattack of its lands. */
  shellToken?: boolean;
  /** Second card of a 2-card boss: instance id of the boss's first card.
   *  See `EnemyCard.partOf`. */
  linkedTo?: string;
}

/**
 * Per-Delver per-turn state. Reset at the start of each Hero Phase
 * turn by `engine/turn.ts > startHeroTurn`.
 *
 * The turn structure (DESIGN.md §4, revised 2026-05-21) is:
 *   1. Mandatory turn-start choice — either place a weapon (sets
 *      `cardPlacedThisTurn`) OR Prepare to Run (sets `preparedToRun`).
 *   2. Optional ≤1 movement (sets `movementUsedThisTurn`) AND ≤1
 *      action (sets `actionUsedThisTurn`), in either order.
 *
 * Movement may now be taken BEFORE placement (2026-05-21 refinement):
 * `legalStepDestinations` no longer gates on `cardPlacedThisTurn`.
 * The Action step IS still gated on placement (engine helpers in
 * `useWeaponAbility` / `useSlotAbility` / `stepWitness` / Boots
 * still require it). The BoardScreen End Turn handler surfaces a
 * confirmation modal when movement happened but no card was placed,
 * letting the player either undo the movement (via
 * `undoMovementThisTurn`, which reads {@link movementSnapshot}) and
 * end the turn, or Go Back to keep playing.
 */
export interface HeroTurnState {
  /**
   * Card placed into a slot THIS turn. `null` = haven't placed yet,
   * which means movement and action are both gated. Once set, it is
   * **irreversible** within the same turn (DESIGN.md §4 + §5.2).
   *
   * `autoRefreshedElement`: set to the slot's printed Element if the
   * placement triggered the auto-refresh rule (DESIGN.md §4.3 — slot
   * already had 2 matching elements, so the card returns to hand and
   * those 2 tokens are spent). `null` for a normal placement. The
   * action step still works either way because the gate reads
   * `cardPlacedThisTurn.cardId`, not `loadout.slotCards[slotIdx]`.
   * Tracking the consumed element lets `undoWeaponPlacement` reverse
   * the auto-refresh (restore the 2 tokens) on undo.
   */
  cardPlacedThisTurn: {
    slotIdx: number;
    cardId: string;
    autoRefreshedElement: Element | null;
  } | null;
  /** Has the player used their (≤1) action this turn? Slice 4c hooks here. */
  actionUsedThisTurn: boolean;
  /**
   * Has the player ended their movement session this turn? Latched by
   * `engine/movement.ts > moveDelverStep` (auto when MP hits 0) and by
   * `engine/movement.ts > endMovementStep` (manual disarm after 1+
   * steps). Once `true`, `legalStepDestinations` returns `[]` for the
   * rest of the turn so the player can't re-arm with leftover MP. NOT
   * a derivable signal — `currentMovement` alone is ambiguous because
   * AP-double-movement / `+1 mov` slot abilities can push it above
   * `baseMovement`, and even at MP=0 we need to distinguish "spent it
   * all" from "didn't get any this turn".
   */
  movementUsedThisTurn: boolean;
  /**
   * Number of single-tile movement steps the active delver has taken
   * this turn. Incremented by `engine/movement.ts > moveDelverStep`
   * and reset to 0 in `engine/turn.ts > startHeroTurn`.
   *
   * Used by the BoardScreen to decide whether disarming the movement
   * overlay should be a free toggle (0 steps so far → can re-arm
   * later) or — when 1+ steps have been taken AND MP remains — a
   * NO-OP that keeps the session armed (was previously a forfeit
   * via `endMovementStep`, but stray taps were silently destroying
   * remaining MP — see DESIGN.md §5.1.1). The naive
   * `currentMovement < baseMovement` check would be wrong for this
   * gate because AP-double-movement and `+1 mov` slot abilities can
   * push `currentMovement` above `baseMovement` at the start of the
   * session.
   */
  movementStepsThisTurn: number;
  /**
   * One-shot per turn: has the player spent 1 AP to double their
   * movement budget this turn? (Effective only BEFORE moving — the
   * legalDestinations gate still blocks a second move once
   * `movementUsedThisTurn` is set.)
   */
  apMovementDoubledThisTurn: boolean;
  /**
   * Display only: true when this turn's action was the "+1 movement this
   * turn" slot ability and the delver hadn't moved yet, so the bonus is
   * part of this turn's movement. The movement badge reads it to show the
   * buffed total. It does NOT re-open movement: since 2026-11-17 (designer
   * ruling) movement is one continuous move, so a delver who already
   * stepped loses any remaining movement when they act, this bonus
   * included. Reset to false by `engine/turn.ts > startHeroTurn`.
   */
  actionGrantedExtraMovement: boolean;
  /**
   * One-shot per turn: has the player spent ANY Double Damage token
   * (typed OR universal) this turn? Per rulebook p15: *"No matter
   * the type of double damage token you use, you can only use 1
   * double damage token per turn."* The engine's spend gate
   * (`engine/tokens.ts > canSpendDoubleDamage`) reads this to lock
   * out a second DD spend until the next turn.
   *
   * Reset to false in `engine/turn.ts > startHeroTurn` alongside
   * the other one-shots.
   */
  damage2xUsedThisTurn: boolean;
  /**
   * Tracks which damage types have an active double-damage effect for
   * the rest of this turn. Set by `engine/tokens.ts > spendToken` when
   * a Double Damage token is spent:
   *   - "damage-2x-light"     → doubleDamageActive.light = true
   *   - "damage-2x-medium"    → doubleDamageActive.medium = true
   *   - "damage-2x-heavy"     → doubleDamageActive.heavy = true
   *   - "damage-2x-universal" → doubleDamageActive.universal = true
   *
   * Read by `useWeaponAbility` to apply 2x to ALL attacks of the
   * doubled type this turn — including `freeRepeat` (Soulshift) attacks
   * that don't carry an explicit `spendDoubleDamage` option.
   *
   * Reset to `{}` in `freshTurnState`.
   */
  doubleDamageActive: Partial<Record<string, boolean>>;
  /**
   * Number of 1-tile Witness movement steps the active delver has
   * taken this turn as part of the "Move Witness" Action (Witness
   * Reference Card, rulebook Q2+ companion). Capped at
   * {@link WITNESS_ACTION_STEP_CAP} per turn — the printed card
   * says "up to 2 tiles" per Action and there's only one Action
   * per turn.
   *
   * Behavior:
   *   - Starts at 0 every turn (`freshTurnState`).
   *   - Incremented by `engine/witness.ts > stepWitness` on each
   *     successful step.
   *   - The FIRST step latches `actionUsedThisTurn = true` (the
   *     printed card requires placing a Weapon Card to take this
   *     Action and it consumes the player's single per-turn
   *     Action). Subsequent steps (step 2) bypass the
   *     action-used gate by reading this counter directly.
   *   - Once the counter hits the cap, further `stepWitness`
   *     calls reject — the player must end the Witness move
   *     session (close the modal).
   *
   * Zero on quests without the Witness companion (the gate in
   * `stepWitness` returns early — no encounter mutation).
   */
  witnessStepsThisTurn: number;
  /**
   * Rollback snapshot for the current turn's movement (2026-05-21
   * — added when `legalStepDestinations` was relaxed to allow
   * movement before placement). Set lazily by
   * `engine/movement.ts > moveDelverStep` on the FIRST step of
   * the turn; cleared (back to `null`) by `startHeroTurn` for the
   * new turn.
   *
   * `engine/movement.ts > undoMovementThisTurn` reads this to
   * rewind the delver's position, MP, parts counters, and
   * `tileDrops` back to the turn-start baseline. The
   * `claimedDrops` array accumulates every drop the delver
   * picked up across this turn's movement, so the undo can put
   * them back on the board AND debit the per-hero counters.
   *
   * Powered by the End Turn confirmation modal (BoardScreen):
   * when the player taps End Turn after moving but BEFORE
   * placing a weapon card, the modal surfaces "Undo and submit"
   * (calls this helper, then ends the turn) or "Go Back" (closes
   * the modal). Modal state itself is ephemeral UI state and
   * does NOT persist across a reload — on reload the player sees
   * the normal turn UI again (i.e. defaults to Go Back).
   *
   * `null` whenever the delver hasn't moved this turn yet.
   */
  movementSnapshot: MovementSnapshot | null;
}

/**
 * Captured state at the start of a turn's movement session — used
 * by `undoMovementThisTurn` to rewind. See
 * {@link HeroTurnState.movementSnapshot}.
 */
export interface MovementSnapshot {
  /** Delver's tile BEFORE the first step. */
  startPosition: { x: number; y: number };
  /**
   * `loadout.currentMovement` BEFORE the first step. Preserves any
   * pre-step AP-double-movement / `+1 mov` slot ability boosts so
   * undo restores the full pre-movement MP budget (in case the
   * player chooses to keep playing after Go Back rather than
   * picking Undo + Submit).
   */
  startMovement: number;
  /** `state.minionParts[heroId]` BEFORE the first step. */
  startMinionParts: number;
  /** `state.bossParts[heroId]` (LVL 1 wallet) BEFORE the first step. */
  startBossParts: number;
  /** `state.bossPartsLvl2[heroId]` BEFORE the first step. Optional —
   *  snapshots serialized by pre-v58 builds lack it; undo falls back
   *  to the live value (no lvl-2 pickups existed pre-v58). */
  startBossPartsLvl2?: number;
  /** `state.bossPartsLvl3[heroId]` BEFORE the first step. Same
   *  optionality rationale as `startBossPartsLvl2`. */
  startBossPartsLvl3?: number;
  /** LVL 4 / LVL 5 wallets BEFORE the first step (v61). */
  startBossPartsLvl4?: number;
  startBossPartsLvl5?: number;
  /** `loadout.currentAp` BEFORE the first step. Any AP spent after
   *  moving (AP-double movement, AP abilities) blocks UNDO MOVEMENT.
   *  Missing on snapshots from builds before UNDO MOVEMENT (blocked). */
  startAp?: number;
  /** `cardPlacedThisTurn` BEFORE the first step. A card placed after
   *  moving blocks UNDO MOVEMENT until the placement is undone. */
  startCardPlaced?: HeroTurnState["cardPlacedThisTurn"];
  /** Set when a step revealed or collected something the undo can't
   *  put back (a Friendly Encounter draw or a Memory Fragment). */
  revealed?: "friendly-encounter" | "memory-fragment";
  /**
   * Every TileDrop this delver claimed during this turn's
   * movement, in pickup order. Undo puts these back onto
   * `state.encounter.tileDrops` so the corresponding tiles
   * re-show their pickup tokens.
   */
  claimedDrops: TileDrop[];
}

/**
 * Wave phase machine (DESIGN.md §4 / Player Aid wave structure).
 *
 *   hero          → players alternate turns; transition to
 *                   parting-shots once both Delvers have prepared
 *                   (DESIGN.md §5.7).
 *   parting-shots → every alive enemy resolves its parting shot one
 *                   at a time, in `enemies[]` order.
 *   end-of-wave   → End Wave: the refresh (exhausted weapons → hand,
 *                   AP + consumables refresh, Harvester) runs on
 *                   entry, then narrative routing per quest (e.g. for
 *                   Q1, page1_1 on victory or page1_2 on defeat).
 *                   Reached after the last parting shot, OR via the
 *                   delver-death short-circuit (rulebook p25).
 *                   Effects that need the party to continue (OS /
 *                   Shield elements, Armor heals) apply when the next
 *                   wave is built (`wave.ts > bootstrapNextWave`).
 *   completed     → terminal; quest1Completed has been set, encounter
 *                   is about to be cleared.
 *
 * Transitions live in `engine/wave.ts`.
 */
export type EncounterPhase =
  /**
   * Pre-hero phase that ONLY exists for spawn-deck waves (Q2+).
   * After `buildEncounter` draws a Spawn Card and places the boss
   * + 7 minions at the printed tiles, both delvers start defaulted
   * onto the first compass tile and the phase parks here until
   * the player picks (per delver) which of the 2 compass tiles
   * they actually want. Hand-authored waves (Q1) skip this phase
   * entirely and boot straight into `"hero"`.
   *
   * Engine transitions: `engine/encounter.ts > assignDelverToTile`
   * mutates the per-hero placement; `startWaveAfterPick` flips
   * the phase to `"first-turn-pick"`, which then commits to
   * `"hero"` via `commitFirstTurnPick` once the player picks
   * their starting delver.
   */
  | "delver-spawn-pick"
  /**
   * Pre-hero "who takes the first turn?" picker that runs at the
   * start of EVERY wave (both hand-authored Q1 + spawn-deck Q2+).
   * Spawn-deck waves enter this phase after the player commits
   * compass tiles via `startWaveAfterPick`; hand-authored waves
   * enter it directly out of `buildEncounter` (skipping the
   * compass-tile step since the spawn point is baked into JSON).
   *
   * The phase parks here until the player commits a starting
   * delver via `engine/encounter.ts > commitFirstTurnPick`, which
   * writes `state.currentDelverId`, flips the phase to `"hero"`,
   * and fires `startHeroTurn`. While parked, the FirstTurnPick
   * screen lets the player swap their viewed delver's suit panel
   * (via `uiState > setPeekedDelverId`) to inspect each
   * loadout before locking in.
   */
  | "first-turn-pick"
  | "hero"
  | "parting-shots"
  | "end-of-wave"
  | "completed";

/**
 * Live state of the wave currently being played. `null` between waves.
 *
 * See DESIGN.md §6.1 for the data-model rules. Bootstrapped from
 * `data/quest1.json` via `engine/encounter.ts > ensureEncounter`.
 */
export interface EncounterState {
  questId: string;
  waveNumber: number;
  /** Current tile of each delver, keyed by hero id. */
  delverPositions: Record<string, { x: number; y: number }>;
  /**
   * Witness's current tile (Q2+ companion robot — rulebook Chapter 2:
   * "He's useless in a fight, but he'll haul your gear for you").
   * `null` for quests that don't include Witness (Q1) so the board
   * + spawn-pick UIs can branch on presence without consulting the
   * quest catalog.
   *
   * Witness is intentionally NOT a delver — he doesn't have HP, a
   * turn, or any combat affordance, so the engine's per-hero
   * iteration paths (turnState, combat, movement, level-up) keep
   * `delverPositions` as their hero-only source of truth. Storing
   * his tile here keeps the data model honest about what kind of
   * thing he is: a board fixture that can be repositioned during
   * the spawn-pick phase but has no agency once the wave starts.
   *
   * Seeded by `engine/encounter.ts > buildEncounter` to the first
   * compass tile (mirrors the default delver placement). Reassigned
   * by `assignWitnessToTile` from the DelverSpawnPick screen.
   * Persists across wave transitions inside a quest, since Witness
   * accompanies the delvers all the way through (Q2 W1 -> W2 -> W3).
   */
  witnessPosition: { x: number; y: number } | null;
  /** Ch3+ mid-wave story entry waiting to be shown (set when the wave's
   *  boss dies and the wave declares `onBossSlain`). Absent / null = none. */
  pendingQuestEntry?: { pageId: string; events: import("./types").RewardEvent[] } | null;
  /** All enemies that ever spawned this wave; dead ones flag `alive: false`. */
  enemies: EnemyInstance[];
  /** Per-Delver per-turn state. Reset at the start of each turn. */
  turnState: Record<string, HeroTurnState>;
  /**
   * Per-Delver "I have prepared to run" latch (DESIGN.md §5.7). Once
   * set, sticky for the rest of the wave. Wave-end transition fires
   * when all entries are true (handled in `engine/wave.ts`).
   */
  preparedToRun: Record<string, boolean>;
  /**
   * Current wave phase (DESIGN.md §4). Default `"hero"` on a fresh
   * encounter. Transitions only via `engine/wave.ts` so the rule
   * lives in one place.
   */
  phase: EncounterPhase;
  /**
   * While `phase === "parting-shots"`, the index into `enemies[]`
   * of the next enemy to resolve. Skips dead enemies on resolve;
   * lives on state so a refresh mid-phase resumes cleanly.
   */
  partingShotCursor: number;
  /**
   * What the End Wave refresh did (weapons, consumables, Harvester).
   * Set once by `engine/wave.ts > enterEndOfWave`; its presence is also
   * the latch that stops a second refresh. Kept on the encounter (not
   * uiState) so an online guest sees the same summary as the host.
   * `null` / absent until the wave ends.
   */
  endWaveRefresh?: import("./engine/wave").EndWaveRefreshResult | null;
  /**
   * While `phase === "end-of-wave"`: which page id from
   * `quest.pages` should be shown, and whether the wave was a
   * victory or defeat (quest1Completed is only set on victory).
   * `null` until end-of-wave routing has fired.
   */
  endOfWavePageId: string | null;
  endOfWaveOutcome: "victory" | "defeat" | null;
  /**
   * Level-Up deck for THIS wave. Card numbers (1..28) of base level
   * cards still in the draw pile. Shuffled fresh on encounter init.
   * Drawn from the front; reshuffled from `levelUpDiscard` when empty
   * (rulebook p24).
   */
  levelUpDeck: number[];
  /** Level-Up cards drawn this wave (most recent at the end). */
  levelUpDiscard: number[];
  /**
   * Pending Level-Up draws waiting on a player choice. Each entry is
   * one delver's outstanding draw: they need to pick one of the 3
   * equipment-type choices on the card.
   *
   * Resolved in FIFO order via the LevelUpModal — End Turn is gated
   * until this is empty.
   *
   * Each level-up creates 2 entries (one per delver, in delverOrder),
   * because both players draw their own card per rulebook p24.
   */
  pendingLevelUpDraws: PendingLevelUpDraw[];
  /**
   * Pending element-choice prompts waiting on a player to pick which
   * of the 6 elements they want from a "gain element" effect (see
   * `EquipmentEffect` kinds `gain-element-on-acquire` and
   * `gain-element-at-end-of-wave`). FIFO; each entry is one
   * delver's pending grant.
   *
   * Drives the `element-pick` UI modal. Phase / turn advance gates
   * (End Wave, End Turn) keep this empty before
   * progressing — the player always picks before moving on.
   *
   * Engine: `engine/os.ts > enqueueElementChoice / applyElementChoice`.
   */
  pendingElementChoices: PendingElementChoice[];
  /**
   * Pending equipment die-roll grants waiting on a player to roll
   * (and possibly pick on 5-6) for the resulting consumable tokens.
   * FIFO; each entry is one delver's pending grant for one card.
   *
   * Covers every R1+ passive that prints `IMMEDIATELY: Roll a die`
   * with a tokens-grant table — today Supercharger and Battery,
   * extensible to future cards via the per-card outcome table
   * registry in `engine/tokens.ts`.
   *
   * Drives the `equipment-roll` UI modal. Phase / turn advance
   * gates (End Wave, End Turn) keep this empty before
   * progressing — the player always resolves before moving on,
   * mirroring the element-choice queue.
   *
   * Engine: `engine/tokens.ts > enqueueEquipmentRoll /
   * applyEquipmentRoll`.
   */
  pendingEquipmentRolls: PendingEquipmentRoll[];
  /**
   * Pending XP die rolls from on-death `gainXpDice` rewards
   * (Ophidian 017 / Sporecloud 022 print "Gain 1 [die] XP"). FIFO;
   * one entry per printed die. Enqueued by `engine/kills.ts >
   * applyKill`; resolved by the `xp-roll` UI modal via
   * `engine/kills.ts > applyXpRoll`, which banks the rolled amount
   * into the shared XP pool and resolves any level-ups it triggers.
   *
   * Designer ruling 2026-07-20: the roll must happen IN FRONT OF the
   * player (pre-fix the data flattened the reward to a silent static
   * 1 XP). Phase / turn advance gates keep this empty before
   * progressing, mirroring `pendingEquipmentRolls`.
   */
  pendingXpRolls: PendingXpRoll[];
  /**
   * Pending Opinion-Card rank picks (Xavier Ally / Confidant /
   * Detractor — rulebook p7) waiting on the player to choose a
   * delver + equipment slot for each queued +/- rank bump.
   *
   * Seeded by `engine/opinionGrants.ts > applyOpinionGrantsForQuest`
   * at quest start, gated by `state.opinionGrantsAppliedQuests` for
   * idempotency. FIFO; resolved by `screens/OpinionRankPickModal.ts`
   * via `applyOpinionRankPick`, which folds the bump into
   * `state.temporaryRankBonus` for the duration of the quest.
   *
   * Each entry corresponds to one printed bump on the card:
   *   - Xavier Ally       -> 1 entry,  delta = +1, heroId = null (player picks)
   *   - Xavier Detractor  -> 1 entry,  delta = -1, heroId = null (player picks)
   *   - Xavier Confidant  -> 2 entries, delta = +1, heroId = hero-01 / hero-02
   *     (every delver gets one — the card text reads "Each Delver
   *     starts each Quest with +1 RANK"; we pin the heroId so the
   *     modal can render the "Mind delver picks..." vs "Body
   *     delver picks..." header without ambiguity).
   *
   * Start-Wave / End-Turn / phase advance gates keep this empty
   * before progressing, mirroring `pendingLevelUpDraws` /
   * `pendingElementChoices`.
   */
  pendingOpinionRankPicks: PendingOpinionRankPick[];
  /**
   * Pending CREATURE PART picks (MINION vs BOSS) from Gauntlet
   * `collect-creature-part` swings. FIFO; each entry is one
   * single-token prompt (a `count: 2` swing enqueues 2 entries).
   *
   * Per audit confirmation 2026-05-24: the printed text on every
   * Each Gauntlet rank with this effect ("Collect N CREATURE
   * PART(S) from any tile(s)") prompts the bearer to pluck an
   * existing creature-part DROP TOKEN off the board (one of the
   * per-delver tokens posted by enemy kills). It is NOT a supply
   * credit — the player is targeting a real `tileDrops` entry,
   * which gets removed on pick.
   *
   * Pre-2026-05-24 the engine always granted MINION PART
   * directly. 2026-05-24 added a MINION/BOSS supply-pick flow;
   * 2026-05-25 corrected the design to a board-tile picker per
   * the rules-as-written (the printed wallet credit is whatever
   * subtype was on the tile).
   *
   * Drives the `creature-part-pick` UI modal. Phase / turn advance
   * gates keep this empty before progressing, matching
   * `pendingElementChoices` / `pendingEquipmentRolls`.
   *
   * Engine: `engine/creatureParts.ts > enqueueCreaturePartChoice /
   * applyCreaturePartChoice`.
   */
  pendingCreaturePartChoices: PendingCreaturePartChoice[];
  /**
   * Scorchline Beam (Suit A R2-R5) — pending bonus-swing counter
   * keyed by bearer hero id. Seeded by `useWeaponAbility` on the
   * FIRST (non-freeRepeat) straight-line swing of a Beam card whose
   * rank-correct effects include `repeat-attack` (count = the printed
   * "Repeat N times" value); decremented to 0 by each subsequent
   * freeRepeat swing the player elects to fire. The
   * `beam-repeat-prompt` modal in `screens/ActionResolution.ts` reads
   * this counter to know whether (and how many times) to surface a
   * "Fire Again?" prompt after each swing finalises.
   *
   * Skip semantics: if the player picks "Skip" on the prompt, the
   * counter is forced to 0 — they don't get to bank repeats for
   * later in the turn.
   *
   * Cleared between turns by `engine/turn.ts > startHeroTurn` so a
   * dangling repeat from a prior turn (defensive — should never
   * happen given the prompt is mandatory) doesn't haunt the next
   * one. Cleared between waves implicitly by `buildEncounter`
   * rebuilding the encounter state from scratch.
   *
   * Missing-key reads are 0 (no pending repeats). The counter is
   * only ever set when there's a legitimate Scorchline R2+ swing in
   * flight, so the per-hero index is sparse by design.
   */
  beamRepeatsRemaining: Record<string, number>;
  /**
   * Printed card number of the Spawn Card drawn for this wave
   * (1..14 — see `SpawnCard.number`), or `null` for hand-authored
   * waves that don't use the deck at all (Quest #1). Recorded on
   * `buildEncounter` so a refresh mid-pick doesn't redraw, and so
   * the DelverSpawnPick screen can render the drawn card's art
   * even on re-entry from another screen.
   */
  spawnCardDrawn: number | null;
  /**
   * Memory Fragment tokens currently on the board — populated
   * from the drawn Spawn Card's `memoryFragments[]` at
   * `buildEncounter` time, and intended to be drained by future
   * pickup wiring (a delver walking onto the tile credits
   * `state.memoryChips` and removes the entry). Today this is
   * purely a board-render concern: BoardScreen / DelverSpawnPick
   * / WavePhases paint the "Memory Fragment" icon on each
   * (x, y) so the player can see them. Empty for hand-authored
   * waves (Q1) and for spawn cards whose printed face has no
   * diamond glyph.
   */
  memoryFragments: Array<{ x: number; y: number }>;
  /**
   * Friendly Encounter tokens currently on the board — populated
   * from the drawn Spawn Card's `friendlyEncounters[]` at
   * `buildEncounter` time. Drained when a delver OR Witness steps
   * onto the tile: the entry is spliced out and a card number is
   * pulled from the Friendly Encounter deck and pushed onto
   * `state.pendingFriendlyEncounters` so the BoardScreen can mount
   * `FriendlyEncounterModal` and the player can resolve it.
   * Empty for hand-authored waves (Q1) and for Spawn Cards whose
   * printed face has no friendly-encounter glyph (today: cards
   * #01..#12; cards #13 + #14 are the two friendly spawn cards
   * shuffled in via `state.friendlySpawnDeck`).
   */
  friendlyEncounters: Array<{ x: number; y: number }>;
  /**
   * Monster-part drops sitting on the board waiting to be collected
   * (rulebook p23: *"drops are placed on the enemy's tile and collected
   * by walking onto it"*).
   *
   * Each entry represents ONE owed-to-one-specific-delver part. A
   * Crystanid death with both delvers alive pushes 2 entries (one per
   * hero) on the dying enemy's tile; one delver going down before the
   * kill drops only their living partner's entry.
   *
   * Pickup is fired by `engine/movement.ts > moveDelver` when a delver
   * ENDS their move on a tile that has matching entries: every entry
   * with the matching `heroId` is consumed and credited to either
   * `state.minionParts[heroId]` (for `"minion-part"`) or
   * `state.bossParts[heroId]` (for `"boss-part"` / `"boss-part-lvl-N"`).
   *
   * Q1 caveat (DESIGN.md §3.5.3): pickup ONLY fires on the destination
   * tile of a move, not on tiles walked through. With Movement = 1 in
   * Q1 every move is one step so this is moot, but multi-step movement
   * in future quests will need a path-aware pickup pass.
   */
  tileDrops: TileDrop[];
  /**
   * Countdown pile (Ch3 Timber Fiend / Saplings, v61). Every attack on a
   * Countdown enemy adds one token; at 4+ the pile resets and every living
   * Countdown enemy joins that attack's counterattack.
   */
  countdownTokens: number;
  /**
   * Accurate monster tokens (Ch3 Golem, v61): boss instance id -> the
   * delver whose Delversuit board holds that boss's token. While the
   * attacker holds it, the boss's counterattack always hits them.
   */
  accurateMarks: Record<string, string>;
  /** Omen monster tokens on each delver's board this wave (Ch4, v63). */
  omenTokens: Record<string, number>;
  /** Rebirth monster tokens on tiles where Rebirth enemies died (Ch4, v63). */
  rebirthTiles: RebirthTile[];
  /** Set when any enemy dies; read and cleared after each hero turn (Rebirth). */
  enemyDiedThisHeroTurn: boolean;
  /** Consumable tokens granted "for this combat only" (Ch4 Assault on
   *  Bird's Nest townsfolk). Removed by `clear-combat-only-grants`. */
  combatOnlyTokens: { heroId: string; kind: ConsumableTokenKind; count: number }[];
  /** Ch4 Steals (Ruined Tidekin): the weapon card it holds. The card stays
   *  in its slot and can't be refreshed until returned. */
  stolenWeapon: { heroId: string; cardId: string } | null;
  /** Ch4 Ritual (Winona the Oak): equipment ranks sacrificed this wave. */
  ritualSacrifices: { heroId: string; type: EquipmentType }[];
  /** Delvers who still owe a Ritual sacrifice (drained by a modal). */
  pendingRitualPicks: string[];
  /** Ch4 Corruption (Incomplete Revenant): the corrupted delver. */
  corruption: { bossInstanceId: string; heroId: string } | null;
  /**
   * End of Wave: the option the party picked — an index into Quest #2's
   * `continueChoices`, or into a Ch3+ wave's `eow.victory`. Its result
   * page is showing; Continue applies it. Absent = not picked yet. Kept
   * in the campaign (not the screen) so online both players see the pick.
   */
  eowContinuePick?: number | null;
  /** Ch3+ End of Wave `pickShopProducts` reward: products picked so far
   *  (campaign state for the same online reason). */
  eowShopPicks?: number[];
}

/** A tile holding Rebirth tokens. `deadInstanceIds` respawn one at a time. */
export interface RebirthTile {
  x: number;
  y: number;
  tokens: number;
  deadInstanceIds: string[];
}

/** A single monster-part drop sitting on the board, owed to one delver. */
export interface TileDrop {
  x: number;
  y: number;
  /** The delver who can pick this up (set when the kill is resolved). */
  heroId: string;
  /**
   * Token ID — same shape as `EnemyOnDeath.drops` entries:
   *   - `"minion-part"`        → bumps `state.minionParts[heroId]`
   *   - `"boss-part"`          → bumps `state.bossParts[heroId]`
   *   - `"boss-part-lvl-<N>"`  → bumps `state.bossParts[heroId]`
   */
  dropId: string;
}

/**
 * One delver's outstanding Level-Up draw. Created by
 * `enqueueLevelUpDraws` (called from `applyPendingLevelUps`) and
 * resolved by `applyLevelUpChoice` once the player picks one of the
 * 3 equipment types listed on `cardNumber`.
 */
export interface PendingLevelUpDraw {
  /** Which delver this draw belongs to. */
  heroId: string;
  /** Card number from the level deck (1..28) — already drawn off `levelUpDeck`. */
  cardNumber: number;
}

/**
 * One queued Opinion-Card rank bump waiting on a player's choice.
 * See `EncounterState.pendingOpinionRankPicks` for the lifecycle.
 *
 * `delta` is signed: +1 for Ally / Confidant grants, -1 for
 * Detractor penalties. `heroId` is fixed for Confidant (the card
 * applies to BOTH delvers, one pick per delver) and `null` for
 * Ally / Detractor (the player picks which delver bears the bump).
 *
 * `source` is the catalog id of the opinion card that produced the
 * pick (e.g. `"xavier-ally"`); the modal renders it in the header
 * ("Xavier's favor: +1 RANK") and the rewards modal records it as
 * the originating cause when the bump resolves.
 *
 * `pickId` is stable across re-renders so the modal can disambiguate
 * sibling entries (a Confidant grant produces two `pickId`s, one
 * per delver).
 */
export interface PendingOpinionRankPick {
  pickId: string;
  source: string;
  delta: 1 | -1;
  heroId: string | null;
}

/**
 * One outstanding Suit Condition rank pick. The campaign-level
 * sibling of {@link PendingOpinionRankPick} — the picks live on
 * `state.pendingSuitConditionPicks` (not on `encounter`) because
 * they're granted at town-visit time and persist across encounters
 * if the player closes the tab mid-picker (rulebook p12 — the
 * Suit Condition sheet is "permanent effects that a delver earns
 * throughout the campaign").
 *
 * Bumps land on `state.suitConditionRankBonus[heroId][type]` —
 * the same campaign-permanent table the academy donation has
 * historically written to via `engine/academyDonation.ts >
 * resolveAcademyDonation` — so the rank survives `endQuestReset`
 * and applies to every future quest.
 *
 * `heroId === null` invites the player to pick a delver in step 1
 * of the modal. `pinnedType !== null` skips the equipment-type
 * picker (used for academy donation's 3-5 / 6-9 tiers where the
 * printed rule fixes "+1 OS" / "+1 Battery" but lets the player
 * choose which delver gets which).
 *
 * `pairsWithPickId` is the "OR ELSE" link: when the paired pick
 * resolves first, `applySuitConditionRankPick` rewrites THIS pick's
 * `heroId` to the OTHER delver (so the printed rule "one player ...
 * other player ..." holds without the modal having to know about
 * the pairing). When the paired pick has NOT resolved yet (the
 * player somehow drained this entry first via debug tooling),
 * the rewrite is a no-op and the modal's free hero picker still
 * fires.
 *
 * `source` is a short tag rendered as the modal eyebrow
 * ("Academy donation: small", "Suit's blood-soaked power", etc.)
 * so the player understands what they earned.
 */
export interface PendingSuitConditionRankPick {
  pickId: string;
  source: string;
  delta: 1 | 2;
  heroId: string | null;
  pinnedType: EquipmentType | null;
  /**
   * When set, restricts the player's type choice to this subset.
   * Used by boss-card rank unlocks (e.g. "Improve 1 RIGHT ARM" limits
   * the pick to Sword / Mace / Shield). Not set for open picks or
   * single-type pinned picks (`pinnedType` handles those).
   */
  allowedTypes?: EquipmentType[];
  /**
   * When true, applying this pick increments
   * `state.unlockedForHigherRanks[heroId][type]` by one step (3→4 or 4→5),
   * raising the base-rank ceiling for that type by one rank.
   */
  unlockHigherRanks?: boolean;
  pairsWithPickId?: string;
}

/**
 * What a `PendingScenarioDelverPick` grants (or takes) from the
 * chosen delver once they are picked.
 */
export type ScenarioDelverPickReward =
  | { kind: "consumable-token"; tokenKind: ConsumableTokenKind; amount: number }
  | { kind: "gain-ap"; amount: number }
  | { kind: "lose-hp-floor-at-one"; amount: number };

/**
 * Pending "choose ONE delver" interaction spawned by scenario card effects
 * (`grant-consumable-token-one-delver`, `grant-ap-one-delver`,
 * `lose-hp-one-delver-floor-at-one`). Lives in
 * `CampaignState.pendingScenarioDelverPicks`; drained by the
 * `scenario-delver-pick` modal auto-opened by BoardScreen after the
 * scenario card closes.
 */
export interface PendingScenarioDelverPick {
  pickId: string;
  /** Short human label shown in the picker modal. */
  rewardLabel: string;
  reward: ScenarioDelverPickReward;
  source: string;
}

/**
 * Chapter 2 Town Center "Delving Academy Donation" resolution
 * staging — populated by `engine/academyDonation.ts >
 * resolveAcademyDonation` for the `small`, `medium`, and `large`
 * tiers, drained by `screens/AcademyDonationResolutionModal.ts`.
 *
 * Distinct from `pendingSuitConditionPicks` because the academy
 * donation flow has bespoke multi-step UX:
 *
 *   Phase 1 — assignment
 *     Display the two reward "tickets" side by side. Player assigns
 *     one delver per ticket (swap-able). For the `large` tier the
 *     ticket's `pinnedType` is `null` and the player picks any of
 *     the 14 equipment types via a sub-menu before assigning.
 *
 *   Phase 2 — slot placement
 *     For each delver in turn, render their 3×3 `suitLoadouts`
 *     grid and let the player pick an empty slot. Each placement
 *     appends to `placements`; once the array has one entry per
 *     reward ticket the resolution commits.
 *
 * `null` outside an in-flight resolution. Lives at CAMPAIGN scope
 * (not town-visit scope) so a player who closes the tab mid-flow
 * resumes the modal on next load — `endQuestReset` and
 * `finishTownVisit` do NOT clear it.
 *
 * `tier` is always one of the reward tiers (`small | medium | large`)
 * — `none` does NOT populate this field because there is nothing
 * to resolve.
 */
export interface PendingAcademyDonationResolution {
  tier: "small" | "medium" | "large";
  /** Total minion parts donated across delvers (for display). */
  totalDonated: number;
  /**
   * The two reward tickets. Length is always 2 — both tiers
   * grant exactly two rewards (small / medium: one pinned-type
   * pair; large: two open-type +2 rank picks).
   */
  rewards: [
    PendingAcademyDonationReward,
    PendingAcademyDonationReward,
  ];
  /**
   * Phase 2 placements as the player resolves them. Length 0 at
   * Phase 1 entry; grows to 2 when both delvers have placed their
   * reward into a `suitLoadouts` slot. The resolver commits when
   * `placements.length === rewards.length` and all rewards have
   * an `assignedHeroId` + `chosenType`.
   */
  placements: PendingAcademyDonationPlacement[];
}

export interface PendingAcademyDonationReward {
  /** Equipment-rank delta granted by this ticket. */
  delta: 1 | 2;
  /**
   * Tier-forced equipment type, or `null` for the `large` tier
   * where the player chooses any of the 14 equipment types.
   */
  pinnedType: EquipmentType | null;
  /**
   * Player-chosen equipment type for the `large` tier. For
   * pinned-type rewards (`small | medium`) this mirrors
   * `pinnedType` so downstream code always reads `chosenType` for
   * the effective type. `null` until the player picks (large tier).
   */
  chosenType: EquipmentType | null;
  /**
   * Delver this reward is assigned to. `null` until the player
   * picks one in Phase 1. The assignment toggle in the modal
   * enforces that the two rewards always end up with DIFFERENT
   * heroes (one Mind, one Body) — but storage doesn't enforce it
   * so a mid-flow save reads back exactly what the UI last wrote.
   */
  assignedHeroId: string | null;
}

export interface PendingAcademyDonationPlacement {
  heroId: string;
  type: EquipmentType;
  delta: 1 | 2;
  /** Loadout index (0..2) inside `state.suitLoadouts[heroId]`. */
  loadoutIdx: number;
  /** Slot index (0..2) inside the chosen loadout row. */
  slotIdx: number;
}

/**
 * Consumable token kinds that the engine currently understands.
 *
 * Rulebook p15-16 lists 7 kinds (AP / Reroll / 2xL / 2xM / 2xH /
 * Universal2x / PreventCounter / IgnoreAbility). The AP "token" is
 * **NOT** in this union — it was unified with the suit-board AP
 * track on 2026-05-09 per user direction:
 *
 *   *"There is no real mechanical difference between board AP and
 *   consumable AP — they both refresh at the start of each new
 *   Wave. The only difference is that delvers start with 3 AP at
 *   the start and may get more during the quest via level ups."*
 *
 * Post-unification semantics:
 *   - `loadout.currentAp` is the unified spendable AP pool.
 *   - `loadout.baseAp` is the per-Wave refresh ceiling. Starts at
 *     `Tuning.baseAp` (3); raised mid-quest by Battery's "AP"
 *     equipment-roll outcome (and by future level-up cards), via
 *     `EquipmentRollOutcome.baseApDelta` in `engine/tokens.ts`.
 *   - Refresh: `currentAp = baseAp` happens ONLY at the End Wave
 *     phase (`engine/wave.ts > enterEndOfWave` (End Wave refresh)), NOT at the start of
 *     each Hero turn. Per-turn `startHeroTurn` only refreshes
 *     movement + clears per-turn flags.
 *
 * Granted today by:
 *   - Supercharger (R1) → 3 typed Double Damage kinds.
 *   - Battery (R1)      → `reroll` (Body) / `prevent-counterattack`
 *                          (Mind), plus the `baseApDelta: +1`
 *                          outcome that bumps the unified AP pool.
 *
 * Reserved for future cards: `damage-2x-universal`, `ignore-ability`.
 * Defined here so the bag schema doesn't churn when those cards ship.
 *
 * String values keep the bag round-trippable through `JSON.stringify`
 * for localStorage with no custom (de)serialiser.
 */
export type ConsumableTokenKind =
  | "damage-2x-light"
  | "damage-2x-medium"
  | "damage-2x-heavy"
  | "damage-2x-universal"
  | "reroll"
  | "prevent-counterattack"
  | "ignore-ability";

/**
 * The 3 Double Damage token kinds that can double a typed weapon
 * swing (Light/Medium/Heavy) — i.e. the ones Supercharger grants.
 * The Universal 2x is intentionally NOT in this list because the
 * single-DD-per-turn cap bundles it together (see
 * {@link ALL_DOUBLE_DAMAGE_KINDS}).
 *
 * Order is the canonical UI order (Light → Medium → Heavy).
 */
export const TYPED_DOUBLE_DAMAGE_KINDS = [
  "damage-2x-light",
  "damage-2x-medium",
  "damage-2x-heavy",
] as const satisfies readonly ConsumableTokenKind[];

/**
 * All Double Damage kinds (typed + universal). Used by the per-turn
 * cap check — rulebook p15: *"No matter the type of double damage
 * token you use, you can only use 1 double damage token per turn."*
 */
export const ALL_DOUBLE_DAMAGE_KINDS = [
  ...TYPED_DOUBLE_DAMAGE_KINDS,
  "damage-2x-universal",
] as const satisfies readonly ConsumableTokenKind[];

/**
 * Every defined consumable token kind, in canonical order. Used
 * by `engine/shopGrants.ts` to validate a string `tokenKind` from
 * shop-product data (which is typed loosely there to avoid a
 * circular type ref between `types.ts` and `state.ts`).
 */
export const ALL_CONSUMABLE_TOKEN_KINDS = [
  ...ALL_DOUBLE_DAMAGE_KINDS,
  "reroll",
  "prevent-counterattack",
  "ignore-ability",
] as const satisfies readonly ConsumableTokenKind[];

/**
 * Per-delver consumable token bag. Each kind tracks an Available
 * count (spendable now) and a Spent count (used this wave; refreshed
 * to Available at the End Wave per rulebook p14: *"All Spent
 * consumable tokens flip back to Available."*).
 *
 * Map is sparse: a kind that has never been granted to this delver
 * may be entirely absent from the record. UI renders absent kinds
 * as 0/0 (not as "missing"). Consumers MUST go through the
 * `engine/tokens.ts` helpers (`grantToken`, `spendToken`,
 * `tokenAvailable`, etc.) so the bag's invariants stay enforced
 * (counts ≥ 0; spend requires available > 0).
 */
export type ConsumableTokenBag = Partial<Record<
  ConsumableTokenKind,
  { available: number; spent: number }
>>;

/**
 * One outstanding equipment die-roll grant. Pushed when a card
 * carrying the `immediately-equipment-roll` effect is first gained
 * (R0 → R1) inside `applyLevelUpChoice`; resolved by the
 * `equipment-roll` modal (player rolls + on 5-6 picks one of the
 * card's outcomes). Once resolved, the engine grants the
 * corresponding tokens via `grantToken` and pops the entry.
 *
 * The card-id discriminator drives the per-card outcome table
 * lookup in `engine/tokens.ts > equipmentRollTableForCard`, so
 * Supercharger and Battery (and future cards) all share this one
 * queue + modal scaffold while keeping their distinct grant tables.
 *
 * Like `pendingElementChoices`, this is a FIFO queue and is gated
 * by phase / turn-advance hooks (no End Turn while it's non-empty).
 */
export interface PendingEquipmentRoll {
  /** Which delver receives the tokens. */
  heroId: string;
  /** R1 card id that triggered (e.g. `mind-supercharger-r1`, `body-battery-r1`). */
  cardId: string;
}

/**
 * One outstanding "Gain 1 [die] XP" roll waiting on the player.
 * Created by `applyKill` for enemies printing `onDeath.gainXpDice`
 * (Ophidian 017, Sporecloud 022); resolved by `applyXpRoll` once the
 * player rolls in the `xp-roll` modal. XP is a SHARED pool, so the
 * `heroId` is only "who rolls the die" (the active delver at kill
 * time) — the banked XP benefits both delvers.
 */
export interface PendingXpRoll {
  /** Delver who rolls (the active delver when the enemy died). */
  heroId: string;
  /** Enemy card id that printed the reward (modal header + art). */
  enemyCardId: string;
}

/**
 * One outstanding CREATURE PART pickup waiting on the player to
 * pick MINION or BOSS. Enqueued by `finalizeAttackSession` once
 * per token granted by a `collect-creature-part` effect (so a
 * Surge Claw R3 swing with `count: 2` enqueues TWO entries —
 * each a separate prompt the player resolves independently).
 *
 * `sourceCardId` is captured so the modal header can surface
 * "Surge Claw" vs "Chain Gauntlet" flavour without the modal
 * having to reach back into the (possibly already disposed)
 * attack session.
 *
 * Resolved one-at-a-time by the `creature-part-pick` modal —
 * each pick targets an existing creature-part `tileDrops` entry
 * owed to the bearer (the modal lists every legal tile), removes
 * that drop, and credits `state.minionParts[heroId]` or
 * `state.bossParts[heroId]` per the drop's printed kind. If no
 * eligible drops exist, the modal offers a "Skip" button that
 * drains the head as a no-op. Phase / turn advance gates (End
 * Turn, End Wave) keep this empty before progressing,
 * matching the other post-action queues.
 *
 * Engine: `engine/creatureParts.ts > enqueueCreaturePartChoice /
 * applyCreaturePartChoice`.
 */
export interface PendingCreaturePartChoice {
  heroId: string;
  sourceCardId: string;
}

/**
 * One outstanding element-grant prompt. Pushed by the engine when a
 * "gain element" effect fires (see `EquipmentEffect` kinds), popped
 * when the player picks via the `element-pick` UI modal.
 *
 * `source.kind` distinguishes the trigger so the modal copy can
 * surface useful context ("Elemental OS gained: choose 1 element"
 * vs "End of wave: choose 1 element from your OS"). The card id
 * is included for future per-card art / telemetry; the engine
 * resolver doesn't read it.
 */
export interface PendingElementChoice {
  /** Which delver picks (and receives) the element. */
  heroId: string;
  source:
    | { kind: "os-immediate"; cardId: string }
    | { kind: "end-of-wave"; cardId: string }
    | { kind: "scenario-card"; cardNumber: number }
    /** War Mace: "If a minion, ... gain 1 element." */
    | { kind: "weapon"; cardId: string }
    /** Ch4 Assault on Bird's Nest: a townsfolk assisting with combat. */
    | { kind: "townsfolk"; name: string };
}

/**
 * Resumable progress through a Town Visit storybook chapter. Lives
 * outside `encounter` because it spans the post-wave narrative beat,
 * not a wave. `null` between Town Visits.
 *
 * `pageId` is the key into the chapter JSON's `pages` map (e.g.
 * `"page6"`, `"page10-A1"`, `"page13"`). Resumed by reading
 * `state.townVisit.pageId` on Town Visit screen mount; navigation
 * (linear `next` or choice click) overwrites this in place.
 *
 * `pagesEntered` is the dedupe set for `onEnter` action firing —
 * an action runs at most once per (chapter, page) per visit, so
 * back-and-forth navigation OR a router refresh in the middle of a
 * page doesn't double-grant minion parts / re-record decisions.
 * Set semantics serialised as a string array for round-trip-able
 * JSON without a custom (de)serialiser.
 */
export interface TownVisitState {
  chapterId: import("./types").TownVisitChapterId;
  pageId: string;
  pagesEntered: string[];
  /**
   * Online co-op only: the delver whose player is shopping on the
   * current shop page (each player buys for their own delver, one at a
   * time — host's delver first). `null` / absent = no shop turn (offline,
   * not on a shop page, or both players are done). See
   * `net/roles.ts > actingSeat` and `screens/Shop.ts`.
   */
  shopTurn?: string | null;
  /** Online co-op: delvers who already pressed "Done shopping" on this page. */
  shopDone?: string[];
}

/**
 * One entry in `state.keyItems`. Mirrors the storybook's printed
 * format ("Key Item #3 - Woo's Diary") so the Campaign Sheet can
 * render the printed line without re-deriving the number from a
 * lookup table. Kept inline (not under `data/`) because key items
 * are awarded by chapter actions one at a time; there's no static
 * catalog to enumerate.
 */
export interface KeyItemRecord {
  /** Printed item number (rulebook ordering, 1-N). */
  number: number;
  /** Display name as shown in the storybook reward line. */
  name: string;
  /**
   * Number of clue token icons on this key item card (magnifying-glass
   * symbol). Snapshotted from the catalog at gain time so a future
   * catalog correction doesn't silently shift gate totals mid-campaign.
   * Defaults to 1 for items gained before this field was introduced.
   */
  clues: number;
}

/**
 * One entry in `state.favour`. `name` is the display label; `value`
 * is signed: positive = ally, negative = detractor, 0 = neutral.
 * Magnitude is open-ended for forward-compat; today every shift is
 * ±1 from a single `record-decision`-equivalent beat. Future chapters
 * may grant ±2 etc. without a schema bump.
 */
export interface FavourRecord {
  name: string;
  value: number;
}

/**
 * One entry in `state.revealedQuests` — a quest the campaign
 * has been told about (via a `reveal-quest` action) but hasn't
 * necessarily completed yet. Mirrors `KeyItemRecord`: number
 * comes from the printed quest card, name is captured at reveal
 * time so save data stays stable even if the catalog name later
 * changes. Tracked-only today; future chapters will gate
 * dialogue + add completion records on top of this list.
 */
export interface QuestRecord {
  number: number;
  name: string;
}

/**
 * One entry in `state.opinionCards` — a printed Opinion Card
 * (rulebook p7) the campaign has gained because a `shift-favour`
 * action walked the character's favour value into a NAMED level
 * (DETRACTOR / ALLY / CONFIDANT / NEMESIS — NEUTRAL is not card-
 * granting).
 *
 * `characterName` is captured at gain time so the save's display
 * label stays stable even if the catalog's character name later
 * changes; `level` is the named opinion slot the favour value
 * crossed into. Sticky-only: re-crossing the same level later
 * is a no-op (the engine de-dupes on `(characterId, level)`).
 *
 * `state.opinionCards` is the source of truth for the Campaign
 * Sheet's opinion roster section. The rewards modal renders the
 * matching `opinion-card-gained` event from `data.ts > OPINION_CARDS`
 * only when art is available; entries without art still appear here
 * (so progress stays visible on the sheet) but are silent in the
 * modal until the asset ships.
 */
export interface OpinionCardRecord {
  characterId: string;
  characterName: string;
  level: "nemesis" | "detractor" | "ally" | "confidant";
}

export interface CampaignState {
  version: number;
  /** Per-delver minion parts collected during quests. Keyed by hero id. */
  minionParts: Record<string, number>;
  /**
   * Per-delver LVL 1 boss parts collected (Soulhunter, Goldmonger —
   * drop id `boss-part-lvl-1`, plus the bare legacy `"boss-part"`
   * id). Shop product cost-checks for `bossLvl1` read directly from
   * this counter.
   *
   * LEVEL-AWARE since v58 (2026-07-20, player report: "+2 MEDIUM" /
   * "+4 HEAVY" / Cyclone Boots were unpurchasable because every
   * boss part was credited here regardless of printed level, and
   * `purchaseShopProduct` hard-coded the lvl-2 wallet to 0):
   * lvl-2 and lvl-3 drops now land on `bossPartsLvl2` /
   * `bossPartsLvl3` below — see `bossPartLevelForDropId` /
   * `creditBossPartDrop` for the single routing point.
   */
  bossParts: Record<string, number>;
  /** Per-delver LVL 2 boss parts (Hundredeyes — `boss-part-lvl-2`).
   *  Spent by shop costs with `bossLvl2 > 0` (+2 MEDIUM, +4 HEAVY,
   *  Cyclone Boots). */
  bossPartsLvl2: Record<string, number>;
  /** Per-delver LVL 3 boss parts (Death Cap, Empress Ash, Abomination,
   *  Oblivionwing — `boss-part-lvl-3`). */
  bossPartsLvl3: Record<string, number>;
  /** Per-delver LVL 4 boss parts (Golem — `boss-part-lvl-4`), v61. */
  bossPartsLvl4: Record<string, number>;
  /** Per-delver LVL 5 boss parts (Timber Fiend — `boss-part-lvl-5`), v61. */
  bossPartsLvl5: Record<string, number>;
  /**
   * Per-delver equipment VARIANT families (v58, Machinist Equipment
   * Upgrades — printed cards #141-155): maps an equipment type to
   * the upgrade family that REPLACES it for the quest, e.g.
   * `{ Boots: "cyclone-boots" }`. Every rank-correct card lookup
   * funnels through `getEquipmentCardFor`, which consults this
   * table before falling back to the standard `EQUIPMENT` catalog.
   * Set by `engine/shopGrants.ts` (quest-scope grant from products
   * #32 / #34 / #41); cleared per-quest in `endQuestReset` and
   * re-applied at the next quest bootstrap while the product is
   * owned. Pre-v58 the Machinist purchase was approximated as a
   * +2 rank bump of the STANDARD card, which had the wrong printed
   * abilities entirely.
   */
  equipmentVariants: Record<string, Partial<Record<EquipmentType, string>>>;
  /**
   * Outstanding Suit Condition rank picks queued for the player.
   * Drained one-at-a-time by `screens/SuitConditionRankPickModal.ts`
   * during a town visit; each resolved pick bumps
   * `state.suitConditionRankBonus[heroId][type]`. Empty for fresh
   * campaigns and between picker sessions.
   *
   * Lives at CAMPAIGN scope (not `state.encounter`) because the
   * grants come from town-visit narrative beats — academy
   * donation resolution, "blood-soaked power" on dead-delver
   * branches, future chapters — that happen outside any quest
   * encounter. The picks survive `endQuestReset` and `finishTownVisit`
   * so a partially-completed picker session resumes cleanly if the
   * player reloads mid-flow.
   */
  pendingSuitConditionPicks: PendingSuitConditionRankPick[];
  /**
   * Pending "choose ONE delver" interactions from scenario card effects
   * (`grant-consumable-token-one-delver`, `grant-ap-one-delver`,
   * `lose-hp-one-delver-floor-at-one`). Drained by the
   * `scenario-delver-pick` modal auto-opened by BoardScreen after the
   * scenario card closes. Lives on campaign state (not encounter) so it
   * persists across page reloads.
   */
  pendingScenarioDelverPicks: PendingScenarioDelverPick[];
  /**
   * In-flight Chapter 2 academy-donation resolution, or `null` if
   * no donation is currently being resolved. Populated by
   * `engine/academyDonation.ts > resolveAcademyDonation` for the
   * `small | medium | large` tiers; drained by
   * `screens/AcademyDonationResolutionModal.ts` which calls
   * `commitAcademyDonationResolution` on completion.
   *
   * Lives at CAMPAIGN scope (not town-visit scope) so the modal
   * survives a tab close mid-flow. Cleared by the commit helper
   * when both placements land.
   */
  pendingAcademyDonationResolution: PendingAcademyDonationResolution | null;
  /** Memory chip tokens collected (out of v1 scope but tracked for future). */
  memoryChips: number;
  /**
   * Memory Cards collected across the campaign — one card number per
   * `convert-memory-chips-to-cards` draw. Duplicates ARE allowed
   * (the printed deck only has 2 cards today and the engine draws
   * with replacement, so 3 chips can yield e.g. `[1, 2, 1]`). Each
   * card number resolves to printed art via {@link memoryCardImageOrNull}.
   *
   * Tracked-only today (no spend mechanic) — surfaces on the
   * Campaign Sheet roster and in the rewards modal at draw time.
   * The Ch2 Machinist "Witness records a memory" page is the only
   * grant path in v1; future chapters will use the same action.
   */
  memoryCards: number[];
  /**
   * Scenario card numbers the campaign has already resolved
   * (used + discarded). Append-only across the whole campaign —
   * the printed rulebook says "discard the card" after resolution,
   * and the digital deck mirrors that by skipping any number in
   * this list if a future trigger ever re-references it.
   *
   * Ids match the printed front (`1`..`9` for numbered cards,
   * `100` for "A" / TIDEBLOOM, `101` for "B" / HEIRLOOM — keeps
   * a single integer key without colliding with the numbered
   * range and without a string-discriminator overlay).
   */
  scenarioCardsResolved: number[];
  /**
   * The Scenario Card currently being presented to the player
   * (front + choice picker + back outcome). `null` when no card
   * is active.
   *
   * Lives at CAMPAIGN scope (not `state.encounter`) so a player
   * who reloads mid-modal (after the wave bootstrap fires the
   * trigger but BEFORE they finish picking) resumes on the same
   * card — the next render of the wave's BoardScreen re-opens
   * the picker against this same entry.
   *
   * `chosenOption` is `null` while the player is still on the
   * front; flips to the picked letter ("A" | "B" | "C") once the
   * resolution side is shown. `resolved` flips to `true` AFTER
   * the resolution's effect actions land (so a re-render after
   * effect-apply doesn't double-fire the actions); the modal's
   * Continue button is what actually clears `currentScenarioCard`
   * back to null + pushes the number onto `scenarioCardsResolved`.
   */
  currentScenarioCard: {
    number: number;
    chosenOption: "A" | "B" | "C" | null;
    resolved: boolean;
    /**
     * Set when a `die-roll-outcome` effect is waiting for the player
     * to roll. Stores only the outcome labels (for display); the
     * actual sub-effects are re-derived from the card catalog at
     * resolution time. Cleared (and `resolved` set to true) by
     * `engine/scenarioCard.ts > resolveScenarioDieRoll`.
     */
    pendingDieRoll?: {
      outcomeLabels: string[];
      rolled?: number;
    };
    /**
     * Set when a `pick-one-outcome` effect is waiting for the player
     * to choose. Stores option labels for display only; effects are
     * re-derived from card catalog. Cleared by `resolveScenarioSubChoice`.
     */
    pendingSubChoice?: {
      optionLabels: string[];
    };
    /**
     * Set when a `spend-element-for-shop-products` effect is waiting
     * for the player's decision. Cleared by `resolveScenarioElementSpend`.
     */
    pendingElementSpend?: {
      products: number[];
    };
  } | null;
  /**
   * Friendly Spawn Card numbers the campaign has been granted and
   * which are currently shuffled into the Spawn Deck. Each entry
   * sits alongside the base deck numbers (1..12) in
   * `shuffleSpawnDeck` so a drawn entry has equal probability with
   * any base card. When a friendly spawn card is drawn at wave
   * bootstrap (`engine/encounter.ts > buildEncounter`) the number
   * is consumed (spliced out of this array) so it can't draw twice
   * across the campaign — mirrors the printed "discard the card"
   * rule for one-shot friendly encounter setups.
   *
   * Granted via the `grant-friendly-spawn-card` Town Visit action
   * (chapter 1 Atlas Archives, chapter 2 Xavier's Lecture today;
   * future chapters can re-use the same action).
   */
  friendlySpawnDeck: number[];
  /**
   * Friendly Encounter card numbers drawn (from the printed
   * Friendly Encounter deck — today only card #01 Flambé) but not
   * yet resolved by the player. Pushed by the pickup wiring in
   * `engine/movement.ts > collectFriendlyEncounters` and by
   * `engine/witness.ts > stepWitness` when a delver / Witness
   * steps onto a board tile holding a friendly-encounter token.
   * Drained one-at-a-time by `screens/FriendlyEncounterModal.ts`
   * — the BoardScreen auto-mounts the modal whenever this queue
   * is non-empty and no other modal is active.
   *
   * Lives at CAMPAIGN scope (not on `encounter`) so a player who
   * reloads with an unresolved friendly encounter still gets the
   * modal back on next boot — mirrors the `currentScenarioCard`
   * persistence model for the same reason.
   */
  pendingFriendlyEncounters: number[];
  /** Quest #1 completed flag. */
  quest1Completed: boolean;
  /**
   * Id of the quest that's currently "active" — controls which
   * quest the Story screen renders an intro for and which quest
   * `BoardScreen` builds an encounter from. Starts as `"quest1"`
   * for fresh campaigns; bumped to `"quest2"` after Ch1's Town
   * Visit completes (Phase B auto-progression will wire this up
   * for the real flow). Today, the Title screen's debug
   * "Start from Quest 2" button is the only path that sets it
   * to `"quest2"` — used to test the Q2 intro narrative without
   * re-playing Q1 + Ch1.
   *
   * Must always resolve via `getQuestData(id)` — a stale or
   * misspelled id throws, which is the intended fail-loud
   * behavior (better than silently falling back to Q1 and
   * masking the bug).
   */
  currentQuestId: string;
  /**
   * Chapter 1 Town Visit completion latch. Set by the Shop screen's
   * "Finish Town Visit" button. Drives the End-of-Wave routing
   * decision (first Q1 victory after this is `false` routes into the
   * Town Visit; subsequent Q1 retries skip straight back to title).
   */
  townVisit1Completed: boolean;
  /**
   * Chapter 2 Town Visit completion latch. Set by `finishTownVisit`
   * when the player exits Ch2's "Father Flores's Office" terminal
   * page (rulebook p35 — "END OF CHAPTER 2"). Drives the post-Q2
   * end-of-wave routing decision (a fresh Q2 victory or defeat
   * after this is `true` skips the Ch2 visit and bounces back to
   * title, since the visit has already been completed once and
   * Q3+ aren't shipped yet).
   */
  townVisit2Completed: boolean;
  /** Ch3 completion latch (v59). Mirrors `townVisit2Completed`. */
  townVisit3Completed: boolean;
  /** Ch4 completion latch (v63). */
  townVisit4Completed: boolean;
  /** Ch4 Town Square: townsfolk assigned to "Assist with combat" and the
   *  delver who takes each one's reward (v63). Applied when the Assault
   *  on Bird's Nest encounter is built, then cleared. */
  assaultBonuses: { townsfolkId: string; heroId: string }[];
  /** Story counters (Ch4 Quest #7's Elias conversation dial), keyed by name. */
  storyCounters: Record<string, number>;
  /** Shop products added for one visit only (Quest #7's Elias Scavenge
   *  Shop); unpurchased ones are removed again when it closes. */
  scavengeShopProducts: number[];
  /** Memory Fragment Witness ability used this quest (once per quest). */
  witnessAbilityUsed: boolean;
  /** Quest numbers the party has completed (v59). Completed quests stay
   *  in `revealedQuests`; "Open Quests" = revealed minus completed. */
  completedQuests: number[];
  /** Lettered Scenario Cards placed "on top of the Scenario deck" by the
   *  story (v59) — drawn before the normal deck order once Ch3+ quests
   *  are playable. Index 0 is the top. */
  scenarioDeckTop: number[];
  /** Campaign-lifetime Delving Academy donation total (v59). Ch3+ reads
   *  the RUNNING total for its Experimental Division tiers, while
   *  `academyDonation` stays the per-visit accumulator Ch2 uses. */
  academyDonationLifetime: number;
  /**
   * Shared Story Token pool, used by the Ch2 Town Visit "Burned
   * Watchtower" hub to gate the player's "visit 2 of 3 locations"
   * choice. Granted by the `grant-story-tokens` action (sets the
   * counter outright; not additive), decremented by `spend-story-
   * token` whenever the player enters a location page. The hub
   * page's location buttons render only while `storyTokens > 0`
   * (via `TownVisitChoice.requireStoryTokens: "positive"`); the
   * "Continue to Town Center" button renders only while
   * `storyTokens === 0` (via `requireStoryTokens: "zero"`).
   *
   * Persists across page renders / refresh inside an active visit.
   * `newCampaign()` initialises to 0 — no pool exists until the
   * Ch2 watchtower page fires its grant.
   */
  storyTokens: number;
  /**
   * In-progress Town Visit, if any. `null` between visits. Set when
   * the End-of-Wave screen routes into the Town Visit; cleared by
   * the Shop screen's "Finish Town Visit" handler.
   *
   * Survives `router.refresh()` and screen navigation away/back so
   * the Title's "Continue Town Visit" button can resume mid-chapter.
   */
  townVisit: TownVisitState | null;
  /**
   * Append-only log of every choice the player made during a Town
   * Visit, plus every narrative side-effect that the Plan calls
   * out as "record-decision only" (opinion cards, key items,
   * ultra-level cards, friendly spawn cards, hero unlocks). Future
   * systems (opinion engine, deck builders) will read this to
   * derive their state when they ship; for now it's bookkeeping.
   *
   * Convention: dotted keys scoped to the chapter, e.g.
   *   "ch1.bram.A"                       (chose pub branch)
   *   "ch1.pub.xavier.eyes"              (asked Xavier about eyes)
   *   "ch1.library.creature-archives"
   *   "ch1.shop.bought.product-3.hero-01"
   */
  townDecisions: string[];
  /**
   * Shop product numbers currently for sale. Populated by the
   * `add-shop-products` Town Visit action (Ch1 page13 adds [1..7]).
   * A purchased product is removed from this list AND pushed to the
   * buyer's `shopProductsOwned` entry.
   */
  shopProductsAvailable: number[];
  /**
   * Per-delver list of purchased shop product numbers. Future Quest
   * Bonus / Wave Bonus effects will key off this map; today it's
   * ownership-only (no effects fire — Q2 doesn't exist).
   */
  shopProductsOwned: Record<string, number[]>;
  /**
   * Hero card numbers (from `HERO_CARDS` in data.ts) the campaign
   * has unlocked. Starts as `[1, 2]` on `newCampaign` — the two
   * playable starters. Chapter 1 page 6's `unlock-hero-cards`
   * action adds `[3, 4]` to mirror the rulebook line "Each player
   * gains the card HERO #3 / HERO #4". Read by the Campaign Sheet
   * + the quest-start hero-pick screen; order preserved as the
   * unlock sequence (so the sheet renders cards in unlock order
   * without an extra sort).
   */
  unlockedHeroCards: number[];
  /**
   * Hero card numbers that have been permanently discarded because the
   * delver who held them died during a non-exempt quest wave (any wave
   * except Q1 and Q2 Wave 1). Discarded cards are removed from
   * `unlockedHeroCards` and can never be picked again. Persists across
   * quest resets so the loss is truly permanent.
   */
  discardedHeroCards: number[];
  /**
   * Memorial records for hero cards permanently lost in combat.
   * One entry per card-loss event, ordered chronologically.
   * `finalWords` is the text the player typed at the death prompt
   * (may be empty if they skipped).
   */
  graveyard: Array<{
    heroId: string;
    cardNumber: number;
    cardName: string;
    questId: string;
    waveNumber: number;
    finalWords: string;
  }>;
  /**
   * Which delvers died (dropped to 0 HP at a defeat End of Wave) during
   * the most recent quest. Drives the Town Visit "did any delver die on
   * your last Quest?" pages, which pick the matching branch from this
   * record instead of asking (user request 2026-11-15). Unlike
   * `graveyard`, this also records deaths on card-loss-exempt waves and
   * can say "nobody died".
   *   - Started (empty) when a quest's first wave is built fresh, unless
   *     the record already belongs to this quest and the quest hasn't
   *     ended (a wave retry keeps earlier deaths).
   *   - `ended` is set by `endQuestReset`; the record stays readable for
   *     the Town Visit that follows.
   *   - `null` = no quest recorded yet (fresh campaign, or a save from
   *     before v64): the pages then show every option and the player picks.
   */
  lastQuestDeaths: { questId: string; heroIds: string[]; ended: boolean } | null;
  /**
   * Which hero card NUMBER each delver is currently playing as.
   * Keyed by delver heroId (`"hero-01"` / `"hero-02"`), value is
   * the printed card number from `HERO_CARDS`. Defaults to the
   * starter pairing `{ "hero-01": 1, "hero-02": 2 }` on
   * `newCampaign`. Mutated by `engine/heroPick.ts >
   * commitHeroPick` when the player picks at quest start (added
   * 2026-05-20).
   *
   * Today this field is metadata-only — the gameplay loadout
   * still derives from the fixed `hero-01` / `hero-02` rows in
   * `heroes.json` (cards #3-#6 have art + suit but no playable
   * row yet). The data is wired so the UI can show the picked
   * hero card art at quest start and a future patch can swap
   * starting equipment / hero portrait without another schema
   * bump. The pick must always be a card whose suit matches the
   * delver's suit AND is in `unlockedHeroCards` — the picker
   * screen enforces both.
   */
  activeHeroCardByDelver: Record<string, number>;
  /**
   * Quest-start hero-pick queue. Populated by `engine/heroPick.ts
   * > populatePendingHeroPicks` at the start of a new quest with
   * the heroIds (in pick order) that own 2+ cards of their suit
   * and therefore need to make a choice before the wave bootstraps.
   * Empty (`[]`) most of the time — only non-empty during the
   * brief window between Story-screen exit and DelverSpawnPick
   * entry.
   *
   * `BoardScreen.ts` reads this BEFORE `ensureEncounter`: if
   * non-empty, it renders `HeroPick.ts` for the head of the queue
   * instead of the normal board flow. Each pick pops the head
   * (via `commitHeroPick`) and refreshes; once empty, board
   * rendering proceeds normally. Order is `["hero-01",
   * "hero-02"]` so Mind picks first (matches the suit-board
   * left-to-right convention).
   */
  pendingHeroPickDelvers: string[];
  /**
   * One-shot per-quest gate for the hero-pick queue. Quest ids
   * land here once `populatePendingHeroPicks` has fired for them
   * — re-entering the same quest (e.g. wave 1 defeat → retry)
   * therefore DOES NOT re-prompt; the player keeps the hero they
   * already chose. Mirrors `shopGrantsAppliedQuests` /
   * `opinionGrantsAppliedQuests` so all "fires once per quest"
   * latches share the same idiom.
   *
   * Cleared by nothing today — a true "redo my hero pick" UI
   * would explicitly remove the quest id from this list. Empty
   * `[]` on `newCampaign`.
   */
  heroPicksAppliedQuests: string[];
  /**
   * Campaign-shared key item inventory (rulebook p29 "Key Items").
   * Order preserved as the acquire sequence so the Campaign Sheet
   * renders chronologically without re-sorting. Tracked-only: Q1
   * has no spend mechanic — items accumulate as keepsakes / future
   * gating tokens. Populated by the `gain-key-item` town-visit
   * action; the matching `record-decision` row is ALSO appended
   * to `townDecisions` so the dotted-log view stays consistent.
   */
  keyItems: KeyItemRecord[];
  /**
   * Per-character favour / opinion tracker. Key is a stable id (e.g.
   * "xavier", "vera", "samantha"); value carries the display name
   * (set on first contact via the `shift-favour` action) plus a
   * signed integer where +N = ally / -N = detractor. Tracked-only
   * today: no choice currently gates on favour, but recording the
   * full history lets future chapters branch on it without a save
   * migration. Mirror entries also land in `townDecisions` so the
   * narrative log can replay the player's opinion arc.
   */
  favour: Record<string, FavourRecord>;
  /**
   * Quests the campaign has been told about (via a `reveal-quest`
   * action). Order is insertion = reveal order so the Campaign
   * Sheet renders chronologically without re-sorting. Tracked-only
   * today: Q1 has no quest-state machine, so revealed quests sit
   * as references for the player. Future chapters will gate
   * dialogue + completion on entries in this list. The matching
   * `record-decision` row also lands in `townDecisions` for the
   * dotted log view.
   */
  revealedQuests: QuestRecord[];
  /**
   * Opinion Cards the campaign has gained (rulebook p7 named
   * positions on each character's opinion track). Order preserved
   * as the gain sequence so the Campaign Sheet renders
   * chronologically without re-sorting. Sticky-only: once an entry
   * lands here it never leaves, even if the matching favour value
   * later returns to NEUTRAL or crosses back into a different
   * level. Populated by the `shift-favour` engine path whenever
   * the value walks INTO a named level not already represented for
   * the (characterId, level) pair.
   *
   * The rewards modal renders `opinion-card-gained` events ONLY
   * when art is available (via `data.ts > opinionCardImageOrNull`);
   * this list, however, always tracks every gain so the Campaign
   * Sheet's roster is complete even before all art ships. Adding
   * art for a previously-silent (character, level) pair retroactively
   * lights up the modal reward for any FUTURE shift that crosses
   * the threshold (no engine change needed).
   */
  opinionCards: OpinionCardRecord[];
  /**
   * Number of "Level Up cards owed" — both players each draw 1 card per
   * shared level-up (rulebook p24). We track a single counter that
   * applies to BOTH players; e.g. value 2 means each player still owes
   * themselves 2 cards to draw.
   */
  levelUpCardsOwed: number;
  /**
   * Ultra Level Up card numbers the campaign has earned across town
   * visits (rulebook Ch1 Library "Creature Archives" + future ultra
   * grants). Ultras are NOT in the base level deck — `buildEncounter`
   * shuffles every entry of this array into the per-encounter deck on
   * init so they can surface as future level-ups during quests.
   *
   * Set semantics (no duplicates, no order significance). Values are
   * card numbers from `LEVEL_DECK` whose entries have `isUltra: true`
   * (today: 29..32). Empty array on new campaigns.
   */
  ultraLevelCardsOwned: number[];
  /** Total XP gained so far across the campaign. */
  totalXp: number;
  /**
   * SHARED XP pool. XP is granted to both players from every kill
   * (rulebook p23: "both players immediately gain the amount of XP listed
   * on that enemy's card"). Spent down whenever the party levels up;
   * starts each quest at 0 (rulebook p4 setup step L). See DESIGN.md §3.
   */
  xpOnHand: number;
  /**
   * SHARED current level. Tracked separately from xpOnHand: XP is spent
   * to level up rather than acting as a cumulative threshold (rulebook
   * p24: "Subtract the required amount of XP from the XP Track / Move
   * the Level marker up 1 space"). Starts each quest at 0. See
   * DESIGN.md §3.
   */
  currentLevel: number;
  /**
   * Live wave state. `null` = no wave currently in progress; will be
   * (re)bootstrapped from `data/quest1.json` on next board entry. The
   * resolved minion-assignment lives directly on `enemies[i].cardId`,
   * so there is no parallel `wave1MinionAssignment` array. See
   * DESIGN.md §6.1.
   */
  encounter: EncounterState | null;
  /**
   * Per-Delver element-token bag. Populated by `gain-element` slot
   * abilities (DESIGN.md §5.8). Spending elements (e.g. for Lunar
   * Shield's "spend 1 ELEMENT to block 1 damage") is out of scope for
   * Slice 4c — tokens accumulate but cannot be spent yet.
   */
  elements: Record<string, Partial<Record<Element, number>>>;
  /**
   * Per-Delver consumable token bag. Populated by Supercharger
   * (Double Damage tokens) and Battery (`reroll` Body /
   * `prevent-counterattack` Mind). The AP-token entry was dropped
   * 2026-05-09 (unified with board AP — see
   * {@link ConsumableTokenKind} jsdoc); Battery's "AP" outcome
   * now bumps `loadout.baseAp` directly via
   * `EquipmentRollOutcome.baseApDelta` instead of granting a token.
   * See {@link ConsumableTokenBag} for the shape and
   * {@link ConsumableTokenKind} for the supported kinds.
   *
   * Persists across waves; refreshed at End Wave (spent → available
   * for ALL kinds in one shot). Mutated only via `engine/tokens.ts`
   * helpers so the available/spent invariants stay enforced.
   */
  consumableTokens: Record<string, ConsumableTokenBag>;
  /**
   * Per-delver per-equipment-type rank table (1..5; 0/missing = not
   * owned). Starter equipment begins at R1; everything else at 0.
   * Mutated by `engine/levelUp.ts > applyLevelUpChoice` (+1 per pick,
   * capped at 5) AND by `engine/shopGrants.ts > applyShopGrantsForQuest`
   * (Trident / Supercharger / Boots / Shockwave / Mace / Machinist
   * upgrades from owned shop products).
   *
   * The HAND is computed from this table — any (suit, type) at rank
   * >= 1 appears in the delver's hand at the rank-correct image.
   * Loadouts only ever store R1 ids; rank is consulted separately.
   */
  equipmentRanks: Record<string, Partial<Record<EquipmentType, number>>>;
  /**
   * Per-delver per-equipment-type TEMPORARY rank offset, granted by
   * Opinion Card effects (Xavier Ally / Confidant / Detractor —
   * "Start each Quest with +/- 1 RANK"). Combined with the printed
   * `equipmentRanks` via `getEffectiveEquipmentRank` to produce the
   * rank consumed by combat / boots / OS / UI.
   *
   * Lifecycle:
   *   - Reset to `{}` for every delver at the START of every quest
   *     (`engine/encounter.ts > buildEncounter`).
   *   - Populated during the quest as the player resolves any
   *     `pendingOpinionRankPicks` entries via the
   *     `OpinionRankPickModal` (each pick adds +/- 1 to a chosen
   *     slot).
   *   - Cleared at quest end (`engine/wave.ts > completeWave` on
   *     the final wave) so the bonuses don't leak into a future
   *     quest — Xavier opinion is RE-applied fresh on the next
   *     quest start, not stacked across quests.
   *
   * Read-only via `getEffectiveEquipmentRank(state, heroId, type)`
   * — never query this map directly in combat / UI code so the
   * clamp + base-rank composition stays in one place.
   */
  temporaryRankBonus: Record<string, Partial<Record<EquipmentType, number>>>;
  /**
   * Opinion Cards that have been one-shot redeemed and can never be
   * redeemed again. Format: `"{characterId}-{level}"` (e.g.
   * `"samantha-ally"`). Sticky for the campaign; redemption is
   * permanent.
   *
   * Used by Flores (-1 boss-part on next purchase), Rodrigo
   * (refresh consumables), Elayna (heal both delvers to full),
   * Samantha (auto-shield the next opinion decrease), Vera (one
   * delver gains a Lvl 2 boss part), and Arlen (stubbed — donation
   * system pending). Ids keep the character id, so Elayna is
   * `"elayne-ally"`.
   *
   * Xavier cards (Ally / Confidant / Detractor) do NOT land here —
   * they're recurring quest-start passives that re-fire every quest
   * the card is owned, never "spent" by mechanical use.
   */
  opinionCardsSpent: string[];
  /**
   * Town-visit-scoped latch — true while Flores's Ally effect
   * ("Remove 1 BOSS PART cost from any 1 Shop Product") is armed
   * and waiting to apply to the NEXT shop purchase. Set by the
   * Shop screen's "Arm Flores's discount" button (which also
   * pushes the card id to `opinionCardsSpent`); cleared by the
   * purchase handler after debiting one fewer boss part. Also
   * reset by `finishTownVisit` so an unused armament doesn't leak
   * into a future visit (the spent latch keeps the card from
   * being re-redeemed regardless).
   */
  floresDiscountArmed: boolean;
  /** Town-visit latch for Ira's Ally card ("This town visit, all Shop
   *  Products cost 1 less minion part"), v62. Reset at visit end. */
  iraDiscountActive: boolean;
  /** Dahlia Ally: the consumable token each delver starts quests with
   *  (picked in the Shop's favors panel; Reroll when first gained), v62. */
  dahliaTokenChoice: Record<string, ConsumableTokenKind>;
  /**
   * Set of quest ids for which OPINION-Bonus grants (Xavier picks)
   * have already been enqueued. Used by `engine/opinionGrants.ts >
   * applyOpinionGrantsForQuest` to make the enqueue path
   * idempotent across save loads + page refreshes mid-quest.
   *
   * Parallel to `shopGrantsAppliedQuests`; the two grant systems
   * deliberately run separately so a future change to one's
   * idempotency model doesn't accidentally drag the other along.
   */
  opinionGrantsAppliedQuests: string[];
  /**
   * Quest IDs for which `applyEquipmentRollsForQuest` has already
   * enqueued passive IMMEDIATELY die-rolls (Supercharger / Battery).
   * Clears on quest reset (same pattern as opinionGrantsAppliedQuests)
   * so retries and new quests re-fire the roll.
   */
  equipmentRollsAppliedQuests: string[];
  /**
   * Per-delver running total of minion parts donated to the Delving
   * Academy via Shop Product #8 (`variableMinionParts: true`).
   * Accumulates across multiple sub-purchases within the same town
   * visit so the player can build their donation up to the
   * resolution tier they want; the sum across delvers is what
   * `resolveAcademyDonation` reads to pick a tier (0-2 / 3-5 / 6-9 / 10+).
   *
   * Reset to `0` for every delver on `finishTownVisit` so a future
   * visit starts fresh (the resolution's rank bumps are already
   * baked into `suitConditionRankBonus` and don't need the raw
   * total kept).
   *
   * `0` for any delver who hasn't donated (missing key behaves
   * like 0 — readers always default through `state.academyDonation[heroId] ?? 0`).
   */
  academyDonation: Record<string, number>;
  /**
   * Per-delver PERMANENT equipment-rank bonuses earned from the
   * Suit Condition sheet — currently sourced from:
   *
   *   - Chapter 2 Town Center academy-donation resolution
   *     (`engine/townVisit.ts > resolveAcademyDonation`): 3-5
   *     donated grants +1 OS (Mind) / +1 Battery (Body); 6-9
   *     grants +2 each; 10+ grants +2 OS+Supercharger (Mind) /
   *     +2 Battery+Harvester (Body).
   *
   * Survives quest end (unlike `temporaryRankBonus`) — the printed
   * rule files this on the Suit Condition sheet for "future use",
   * which mechanically means the bumps persist across all future
   * quests in the campaign. Read by `getEffectiveEquipmentRank` /
   * `getEffectiveEquipmentRanks` alongside `temporaryRankBonus`,
   * so combat / UI / abilities all see the boost without each
   * call-site needing its own lookup.
   *
   * Missing entry / missing key is treated as 0 — readers handle
   * the sparse shape gracefully.
   */
  suitConditionRankBonus: Record<string, Partial<Record<EquipmentType, number>>>;
  /**
   * Per-delver per-equipment-type flag that gates level-up cards from
   * raising a type's BASE rank above 3.
   *
   * At the start of a campaign ALL equipment types are locked to a max
   * base rank of 3. When a boss card back is revealed (end of Wave 1 →
   * Wave 2, end of Wave 2 → Wave 3) each delver picks ONE equipment
   * type from the suit part the boss card assigned them; that type is
   * added here, permanently lifting its base-rank ceiling to 5.
   *
   * This only affects the LEVEL-UP cap — `suitConditionRankBonus` and
   * `temporaryRankBonus` can push effective rank above 3 regardless.
   *
   * Missing key = not yet unlocked (base-rank cap = 3).
   */
  unlockedForHigherRanks: Record<string, Partial<Record<EquipmentType, 4 | 5>>>;
  /**
   * Per-delver Suit Condition loadout slots — the physical "Starting
   * Equipment Slots" sheet. Three loadouts per delver, each with up
   * to 3 slots. Each slot records the equipment type and the rank
   * bonus it contributes. At the start of each quest the player
   * chooses ONE loadout to benefit from (out of scope for v1; all
   * bonuses are currently accumulated into suitConditionRankBonus).
   *
   * Filled sequentially as `applySuitConditionRankPick` resolves
   * picks: slot 0 of loadout 0 first, then slot 1, etc.
   *
   * `null` = empty slot. Missing key is treated as three empty
   * loadouts — readers initialise lazily.
   */
  suitLoadouts: Record<string, Array<Array<{ type: EquipmentType; rank: number } | null>>>;
  /**
   * Per-delver list of scar keywords acquired during the campaign.
   * Scars are flavour/mechanical keywords that persist across quests
   * (e.g. "Snowpetal" from Scenario #05 Resolution C).
   * Missing key = no scars yet.
   */
  scars: Record<string, string[]>;
  /**
   * Per-delver flat damage bonus per damage type, accumulated from
   * Quest-Bonus shop cards ("+1 LIGHT damage", "+2 MEDIUM damage",
   * "+4 HEAVY damage"). Read by `engine/combat.ts` on every weapon
   * swing of the matching damage type and added on top of the
   * card's printed damage. Reset to `{}` per delver at quest end
   * (alongside `consumableTokens` / `elements`); re-seeded the
   * next time the player owns the product when entering a new
   * quest.
   *
   * Missing/zero entries mean "no bonus" — the engine treats the
   * absence as +0 rather than throwing.
   */
  shopDamageBonus: Record<string, Partial<Record<DamageType, number>>>;
  /**
   * Set of quest ids for which Quest-Bonus shop grants have already
   * been applied. Used by `engine/shopGrants.ts` to make
   * `applyShopGrantsForQuest` idempotent across save loads + page
   * refreshes mid-Q2.
   *
   * Wave-Bonus grants are NOT tracked here — they're designed to
   * re-fire at every wave start ("Start each Wave with +1 Fire") so
   * tracking would suppress the second wave's bonus.
   */
  shopGrantsAppliedQuests: string[];
  /** Per-delver loadout, keyed by hero id. */
  loadouts: Record<string, DelverLoadout>;
  /**
   * Active delver whose turn it currently is. Drives which suit panel /
   * hero card is shown by default. The peek toggle in the board UI lets
   * the active player view the other delver without flipping this.
   * Stage 4 (hero phase) will own the actual end-turn flow.
   */
  currentDelverId: string;
}

function newLoadout(heroId: string): DelverLoadout {
  return {
    heroId,
    slotCards: Array.from({ length: Tuning.weaponSlotsPerSuit }, () => null),
    currentHp: Tuning.startingHp,
    maxHp: Tuning.startingHp,
    currentAp: Tuning.baseAp,
    baseAp: Tuning.baseAp,
    currentMovement: Tuning.startingMovement,
    baseMovement: Tuning.startingMovement,
  };
}

/**
 * Apply the IMMEDIATELY-tagged effects from each passive in `equipment`
 * onto `loadout`. Fired once when the card is "gained" (DESIGN.md §5.8 +
 * the printed card text "IMMEDIATELY: ..."). For starting equipment this
 * runs at campaign init; future code paths (shop purchase, level-up draw)
 * should call the same helper so the rule has exactly one home.
 *
 * Effects handled here are passive-onset only:
 *   - `set-max-hp`         → overwrite `maxHp`.
 *   - `modify-current-hp`  → adjust `currentHp` (clamped to [0, maxHp]).
 *   - `set-base-movement`  → raise `baseMovement` (Boots; only-up).
 *     Also bumps `currentMovement` to match if the new floor is
 *     higher, so the bearer feels the effect on the very turn the
 *     card is gained instead of waiting until the next turn-start
 *     reset.
 *
 * Any ONGOING / per-turn / per-attack effects (heal-at-end-of-wave,
 * block-on-tile, weapon effects, ...) are intentionally skipped — they
 * fire from their own resolvers, not at gain-time.
 *
 * Order matters: we apply `set-max-hp` first across all cards so that
 * `modify-current-hp` clamps against the post-upgrade ceiling.
 */
export function applyImmediatePassiveEffects(
  loadout: DelverLoadout,
  equipment: readonly EquipmentCard[],
): void {
  for (const card of equipment) {
    if (card.category !== "passive") continue;
    for (const eff of card.effects ?? []) {
      if (eff.kind === "set-max-hp") loadout.maxHp = eff.value;
    }
  }
  for (const card of equipment) {
    if (card.category !== "passive") continue;
    for (const eff of card.effects ?? []) {
      if (eff.kind === "modify-current-hp") {
        loadout.currentHp = Math.max(0, Math.min(loadout.maxHp, loadout.currentHp + eff.delta));
      } else if (eff.kind === "set-base-movement") {
        // Only-up: Boots cards "set" movement to 2, but interpreted as
        // "establish a floor of 2" so a hypothetical future card that
        // grants more movement isn't clobbered by a later Boots gain.
        const next = Math.max(loadout.baseMovement, eff.value);
        if (next > loadout.baseMovement) {
          loadout.baseMovement = next;
          // Pull currentMovement up to match if the floor rose, so the
          // benefit is visible THIS turn (not just from the next
          // turn-start reset). Don't lower an already-higher current.
          if (loadout.currentMovement < loadout.baseMovement) {
            loadout.currentMovement = loadout.baseMovement;
          }
        }
      }
    }
  }
}

/**
 * Re-apply IMMEDIATELY effects from every passive card the delver
 * currently owns at rank ≥ 1 (starter equipment + everything they've
 * unlocked via Level Up).
 *
 * Called by `resetWaveForRetry` so the per-quest baseline (e.g. Boots'
 * baseMovement bump) survives a wave-retry. Also a safe re-init point
 * any time we reset transient stats and want to re-establish passive
 * floors without consulting the level-up history.
 */
/**
 * Effective equipment rank for one (delver, slot) — combines the
 * printed `state.equipmentRanks[heroId][type]` (base, persistent
 * across quests) with `state.temporaryRankBonus[heroId][type]`
 * (Opinion-Card-granted, reset at every quest start), clamped to
 * `[0, EQUIPMENT_RANK_CAP]`.
 *
 * Single source of truth for "what rank is this slot AT for combat
 * / UI / ability triggers?". Every consumer that asks "is the
 * Boots ability active?" / "what is the Gauntlet's damage?" / "is
 * this slot in the player's hand?" must funnel through this helper
 * (or its sibling `getEffectiveEquipmentRanks`) so a temporary
 * Xavier bonus actually affects gameplay rather than just sitting
 * inert on state.
 *
 * Sites that explicitly want RAW rank (level-up writes, shop
 * grants writes, ownership-only ownership checks like
 * `reapplyOwnedPassiveImmediates`) intentionally read
 * `equipmentRanks` directly — those are the inverse of "what is
 * the rank right now" (they are "what is the persistent rank?").
 *
 * The `0` bottom-clamp matters for Xavier Detractor (-1 on a slot
 * already at R1 takes effective rank to 0, which the HandPanel
 * reads as "not in hand" — i.e., the player's punished slot
 * temporarily disappears for the quest).
 */
export function getEffectiveEquipmentRank(
  state: CampaignState,
  heroId: string,
  type: EquipmentType,
): number {
  const base = state.equipmentRanks[heroId]?.[type] ?? 0;
  // Temporary bonus = quest-scoped (Xavier picks); wiped at
  // quest end. Suit-condition bonus = permanent (Chapter 2
  // donation resolution, future death penalties); persists for
  // the rest of the campaign. Both stack additively before clamp.
  const tempBonus = state.temporaryRankBonus[heroId]?.[type] ?? 0;
  const suitBonus = state.suitConditionRankBonus?.[heroId]?.[type] ?? 0;
  // Ch4 Ritual (Winona the Oak): each sacrifice lowers the rank by 1 for the wave.
  const ritual = (state.encounter?.ritualSacrifices ?? []).filter((s) => s.heroId === heroId && s.type === type).length;
  const raw = base + tempBonus + suitBonus - ritual;
  if (raw < 0) return 0;
  if (raw > EQUIPMENT_RANK_CAP) return EQUIPMENT_RANK_CAP;
  return raw;
}

/**
 * Full effective-rank table for one delver — returns a fresh object
 * keyed by every `EquipmentType` that has either a printed rank or
 * a temporary bonus, with the effective rank as the value. Slots
 * with neither base nor bonus are omitted (consistent with how
 * `equipmentRanks` is typed: `Partial<Record<EquipmentType, number>>`
 * where missing keys mean "not owned").
 *
 * Convenience wrapper around `getEffectiveEquipmentRank` for
 * consumers that iterate the whole table (HandPanel, SuitPanel,
 * level-up logic). Always returns a NEW object so callers can't
 * accidentally mutate persistent state.
 */
export function getEffectiveEquipmentRanks(
  state: CampaignState,
  heroId: string,
): Partial<Record<EquipmentType, number>> {
  const base = state.equipmentRanks[heroId] ?? {};
  const tempBonus = state.temporaryRankBonus[heroId] ?? {};
  const suitBonus = state.suitConditionRankBonus?.[heroId] ?? {};
  const keys = new Set<EquipmentType>([
    ...(Object.keys(base) as EquipmentType[]),
    ...(Object.keys(tempBonus) as EquipmentType[]),
    ...(Object.keys(suitBonus) as EquipmentType[]),
  ]);
  const out: Partial<Record<EquipmentType, number>> = {};
  for (const type of keys) {
    out[type] = getEffectiveEquipmentRank(state, heroId, type);
  }
  return out;
}

/**
 * THE rank- and VARIANT-correct equipment card lookup (2026-07-22).
 *
 * Single source of truth for "which printed card governs this
 * delver's (type, rank) right now": if `state.equipmentVariants`
 * maps the type to a Machinist upgrade family (Shock Gauntlet /
 * Cyclone Boots / Earth's Embrace Shield), the upgrade family's
 * rank-correct card is returned; otherwise the standard catalog
 * entry for the hero's suit. Rank is clamped to 1..5.
 *
 * Every effect-bearing consumer (damage, counter-block, shield,
 * end-wave heals/grants, XP bonus, rank-gain immediates, Boots
 * ONGOING) funnels through this so a replaced family actually
 * plays with its printed abilities.
 */
export function getEquipmentCardFor(
  state: CampaignState,
  heroId: string,
  type: EquipmentType,
  rank: number,
): EquipmentCard {
  const hero = getHero(heroId);
  const r = Math.max(1, Math.min(5, rank));
  const family = state.equipmentVariants?.[heroId]?.[type];
  if (family) {
    const up = getUpgradeEquipment(family, hero.suit, r);
    if (up) return up;
  }
  return getEquipmentByTypeSuitRank(hero.suit, type, r);
}

/** The card a placed weapon actually plays as: the hand / slot stores
 *  the R1 standard id, so resolve the effective rank and any Machinist
 *  variant (Fabled Hammer for a Hammer...). Use for names, art, ranges. */
export function getPlayedWeaponCard(state: CampaignState, heroId: string, placedCardId: string): EquipmentCard {
  const placed = getEquipment(placedCardId);
  const rank = getEffectiveEquipmentRanks(state, heroId)[placed.type as EquipmentType] ?? 1;
  return getEquipmentCardFor(state, heroId, placed.type as EquipmentType, rank);
}

export function reapplyOwnedPassiveImmediates(state: CampaignState, heroId: string): void {
  const lo = state.loadouts[heroId];
  if (!lo) return;
  const ranks = state.equipmentRanks[heroId] ?? {};
  const hero = getHero(heroId);
  const owned: EquipmentCard[] = [];
  for (const type of Object.keys(ranks) as EquipmentType[]) {
    const rank = ranks[type] ?? 0;
    if (rank < 1) continue;
    // RANK- and VARIANT-CORRECT card (fixed 2026-07-22): every
    // ranked card re-prints its own IMMEDIATELY line with scaled
    // values (Armor R2 sets max HP to 12, Boots R2 raises the floor
    // to 3), and a Machinist-replaced family applies ITS printed
    // immediates. Falls back to the R1 card if the ranked entry is
    // missing (data gap).
    try {
      owned.push(getEquipmentCardFor(state, heroId, type, rank));
    } catch {
      try {
        owned.push(getEquipmentByTypeSuit(hero.suit, type));
      } catch {
        // (suit, type) pair with no entry at all — should be
        // impossible given the dataset; skip silently so a data gap
        // doesn't crash retry.
      }
    }
  }
  applyImmediatePassiveEffects(lo, owned);
}

/**
 * Build the initial equipment-rank table for a delver: R1 for every
 * type they have a starter card for, 0 (== absent) for everything else.
 * Future ranks are bumped via `engine/levelUp.ts > applyLevelUpChoice`.
 *
 * Exported for `engine/wave.ts > endQuestReset` so the end-of-quest
 * teardown can wipe Level-Up-gained ranks and restore the starting
 * baseline without duplicating the iteration over `ALL_EQUIPMENT_TYPES`.
 */
export function newEquipmentRanks(heroId: string): Partial<Record<EquipmentType, number>> {
  const ranks: Partial<Record<EquipmentType, number>> = {};
  // Initialise every type to 0 to make the rank table self-describing —
  // 0 means "owned at rank 0" === "not owned" === "appears as a +1 RANK
  // gain target on a level card (rather than an upgrade)".
  for (const type of ALL_EQUIPMENT_TYPES) ranks[type] = 0;
  for (const card of getStartingEquipment(heroId)) ranks[card.type] = 1;
  void getHero(heroId); // import-keepalive
  return ranks;
}

/**
 * Card-aware sibling of `newEquipmentRanks`. Reads the picked Hero
 * Card via `state.activeHeroCardByDelver` and stamps its
 * `startingRanks` onto a fresh "everything at 0" table. Used by
 * `endQuestReset` and `commitHeroPick` so the playable hand on the
 * very first turn of a quest reflects the picked card (cards #3-#6
 * differ from the legacy heroId defaults — see
 * `data.ts > HERO_CARD_LOADOUTS`).
 *
 * Falls back to the heroId default at the call inside `newCampaign`
 * (where `state.activeHeroCardByDelver` is still being constructed)
 * via the `getActiveHeroCardNumber` fallback. Card #1 + card #2
 * loadouts mirror the legacy `heroes.json` rows exactly, so this
 * fallback is a true no-op for fresh campaigns.
 */
export function newEquipmentRanksForActiveCard(
  state: CampaignState,
  heroId: string,
): Partial<Record<EquipmentType, number>> {
  const ranks: Partial<Record<EquipmentType, number>> = {};
  for (const type of ALL_EQUIPMENT_TYPES) ranks[type] = 0;
  const starting = getActiveHeroCardStartingRanks(state, heroId);
  for (const [type, rank] of Object.entries(starting)) {
    if (typeof rank === "number" && rank > 0) {
      ranks[type as EquipmentType] = rank;
    }
  }
  return ranks;
}

/**
 * Re-seed a delver's loadout + equipment ranks from their currently
 * active hero card. Called from `commitHeroPick` so the picked card
 * takes effect IMMEDIATELY (the wave hasn't been bootstrapped yet at
 * that point — we just need the ranks table + loadout shape to match
 * the picked card so `ensureEncounter` sees a faithful baseline).
 *
 * Mirrors the relevant subset of `engine/wave.ts > endQuestReset`:
 *   - Wipes rank table → re-seeds from card's `startingRanks`
 *   - Wipes loadout slots, restores baseline HP/AP/movement
 *   - Re-applies IMMEDIATELY passive effects from the card's
 *     starting equipment (e.g. Armor → maxHp +3, Boots → baseMov +1)
 *
 * Does NOT touch: consumables, elements, temporary rank bonuses,
 * shop bonuses, opinion-card grants. Those are quest-scoped and
 * handled by `endQuestReset` / `applyShopGrantsForQuest` /
 * `applyOpinionGrantsForQuest` — re-seeding them here would
 * double-apply on the natural Q-end → picker → wave-bootstrap path.
 */
export function reseedDelverFromActiveHeroCard(state: CampaignState, heroId: string): void {
  state.equipmentRanks[heroId] = newEquipmentRanksForActiveCard(state, heroId);
  const lo = state.loadouts[heroId];
  if (!lo) return;
  lo.baseAp = Tuning.baseAp;
  lo.currentAp = lo.baseAp;
  lo.baseMovement = Tuning.startingMovement;
  lo.currentMovement = lo.baseMovement;
  lo.maxHp = Tuning.startingHp;
  lo.currentHp = lo.maxHp;
  for (let i = 0; i < lo.slotCards.length; i++) lo.slotCards[i] = null;
  applyImmediatePassiveEffects(lo, getActiveHeroCardStartingEquipment(state, heroId));
}

export function newCampaign(): CampaignState {
  const loadouts: Record<string, DelverLoadout> = {
    "hero-01": newLoadout("hero-01"),
    "hero-02": newLoadout("hero-02"),
  };
  // Apply IMMEDIATELY effects from each hero's starting equipment passives
  // (e.g. Body delver's Exoframe Armor → max HP 9, current HP +3).
  for (const heroId of Object.keys(loadouts)) {
    applyImmediatePassiveEffects(loadouts[heroId]!, getStartingEquipment(heroId));
  }
  return {
    version: SCHEMA_VERSION,
    minionParts: { "hero-01": 0, "hero-02": 0 },
    bossParts: { "hero-01": 0, "hero-02": 0 },
    bossPartsLvl2: { "hero-01": 0, "hero-02": 0 },
    bossPartsLvl3: { "hero-01": 0, "hero-02": 0 },
    bossPartsLvl4: { "hero-01": 0, "hero-02": 0 },
    bossPartsLvl5: { "hero-01": 0, "hero-02": 0 },
    equipmentVariants: { "hero-01": {}, "hero-02": {} },
    memoryChips: 0,
    memoryCards: [],
    pendingSuitConditionPicks: [],
    pendingScenarioDelverPicks: [],
    pendingAcademyDonationResolution: null,
    scenarioCardsResolved: [],
    currentScenarioCard: null,
    friendlySpawnDeck: [],
    pendingFriendlyEncounters: [],
    quest1Completed: false,
    currentQuestId: "quest1",
    townVisit1Completed: false,
    townVisit2Completed: false,
    townVisit3Completed: false,
    townVisit4Completed: false,
    assaultBonuses: [],
    storyCounters: {},
    scavengeShopProducts: [],
    witnessAbilityUsed: false,
    completedQuests: [],
    scenarioDeckTop: [],
    academyDonationLifetime: 0,
    storyTokens: 0,
    townVisit: null,
    townDecisions: [],
    shopProductsAvailable: [],
    shopProductsOwned: { "hero-01": [], "hero-02": [] },
    unlockedHeroCards: [1, 2],
    discardedHeroCards: [],
    graveyard: [],
    lastQuestDeaths: null,
    activeHeroCardByDelver: { "hero-01": 1, "hero-02": 2 },
    pendingHeroPickDelvers: [],
    heroPicksAppliedQuests: [],
    keyItems: [],
    favour: {},
    revealedQuests: [],
    opinionCards: [],
    levelUpCardsOwed: 0,
    ultraLevelCardsOwned: [],
    totalXp: 0,
    xpOnHand: 0,
    currentLevel: 0,
    encounter: null,
    elements: { "hero-01": {}, "hero-02": {} },
    consumableTokens: { "hero-01": {}, "hero-02": {} },
    equipmentRanks: {
      "hero-01": newEquipmentRanks("hero-01"),
      "hero-02": newEquipmentRanks("hero-02"),
    },
    temporaryRankBonus: { "hero-01": {}, "hero-02": {} },
    opinionCardsSpent: [],
    floresDiscountArmed: false,
    iraDiscountActive: false,
    dahliaTokenChoice: {},
    opinionGrantsAppliedQuests: [],
    academyDonation: { "hero-01": 0, "hero-02": 0 },
    suitConditionRankBonus: { "hero-01": {}, "hero-02": {} },
    unlockedForHigherRanks: { "hero-01": {}, "hero-02": {} },
    suitLoadouts: {
      "hero-01": [[null, null, null], [null, null, null], [null, null, null]],
      "hero-02": [[null, null, null], [null, null, null], [null, null, null]],
    },
    scars: { "hero-01": [], "hero-02": [] },
    shopDamageBonus: { "hero-01": {}, "hero-02": {} },
    shopGrantsAppliedQuests: [],
    equipmentRollsAppliedQuests: [],
    loadouts,
    currentDelverId: "hero-01",
  };
}

export function loadCampaign(): CampaignState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return newCampaign();
  try {
    const parsed = JSON.parse(raw) as CampaignState;
    if (parsed.version === SCHEMA_VERSION) return parsed;
    // Chained one-step migrations. We migrate forward as far as we
    // can in sequence; anything older than the oldest migrator falls
    // through to a fresh campaign — at the prototype stage we only
    // promise (current - 2) version compatibility.
    let working: unknown = parsed;
    if ((working as { version?: number } | null)?.version === 21) {
      const next = migrateV21ToV22(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 22) {
      const next = migrateV22ToV23(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 23) {
      const next = migrateV23ToV24(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 24) {
      const next = migrateV24ToV25(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 25) {
      const next = migrateV25ToV26(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 26) {
      const next = migrateV26ToV27(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 27) {
      const next = migrateV27ToV28(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 28) {
      const next = migrateV28ToV29(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 29) {
      const next = migrateV29ToV30(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 30) {
      const next = migrateV30ToV31(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 31) {
      const next = migrateV31ToV32(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 32) {
      const next = migrateV32ToV33(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 33) {
      const next = migrateV33ToV34(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 34) {
      const next = migrateV34ToV35(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 35) {
      const next = migrateV35ToV36(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 36) {
      const next = migrateV36ToV37(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 37) {
      const next = migrateV37ToV38(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 38) {
      const next = migrateV38ToV39(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 39) {
      const next = migrateV39ToV40(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 40) {
      const next = migrateV40ToV41(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 41) {
      const next = migrateV41ToV42(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 42) {
      const next = migrateV42ToV43(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 43) {
      const next = migrateV43ToV44(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 44) {
      const next = migrateV44ToV45(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 45) {
      const next = migrateV45ToV46(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 46) {
      const next = migrateV46ToV47(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 47) {
      const next = migrateV47ToV48(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 48) {
      const next = migrateV48ToV49(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 49) {
      const next = migrateV49ToV50(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 50) {
      const next = migrateV50ToV51(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 51) {
      const next = migrateV51ToV52(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 52) {
      const next = migrateV52ToV53(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 53) {
      const next = migrateV53ToV54(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 54) {
      const next = migrateV54ToV55(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 55) {
      const next = migrateV55ToV56(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 56) {
      const next = migrateV56ToV57(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 57) {
      const next = migrateV57ToV58(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 58) {
      const next = migrateV58ToV59(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 59) {
      const next = migrateV59ToV60(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 60) {
      const next = migrateV60ToV61(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 61) {
      const next = migrateV61ToV62(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 62) {
      const next = migrateV62ToV63(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 63) {
      const next = migrateV63ToV64(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as { version?: number } | null)?.version === 64) {
      const next = migrateV64ToV65(working);
      if (!next) return newCampaign();
      working = next;
    }
    if ((working as CampaignState | null)?.version === SCHEMA_VERSION) {
      return working as CampaignState;
    }
    return newCampaign();
  } catch {
    return newCampaign();
  }
}

/**
 * v21 → v22: drop the `ap` consumable-token bag entry on each
 * delver and fold its counts into the now-unified board-AP pool.
 *
 * Mapping rationale:
 *   - `baseAp += availableAp + spentAp` — the "next-End Wave
 *     refresh ceiling" should reflect EVERY AP unit the delver
 *     was entitled to (both Available and Spent would have
 *     refreshed Spent→Available next End Wave in the old model).
 *   - `currentAp += availableAp` — only currently-spendable
 *     tokens contribute to currentAp; spent ones are already
 *     refreshable but don't add to "spendable right now".
 *
 * Also clears any `consumableSpendsThisTurn.ap` latch that may
 * still be lingering on a turnState (now an unknown key under
 * the new union).
 *
 * Defensive: returns `null` if the parsed object doesn't look
 * shaped like a v21 CampaignState — caller falls through to
 * `newCampaign()`.
 *
 * Exported (intentionally) so the unit test in
 * src/__tests__/state.test.ts can exercise the AP-fold math
 * directly without having to mock localStorage / JSON round-trip.
 */
export function migrateV21ToV22(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object" || !s.loadouts || !s.consumableTokens) {
    return null;
  }
  for (const heroId of Object.keys(s.loadouts)) {
    const lo = s.loadouts[heroId];
    if (!lo) continue;
    const bag = s.consumableTokens[heroId] as Record<string, { available: number; spent: number } | undefined> | undefined;
    const apEntry = bag?.["ap"];
    if (apEntry) {
      const avail = Math.max(0, apEntry.available | 0);
      const spent = Math.max(0, apEntry.spent | 0);
      lo.baseAp += avail + spent;
      lo.currentAp += avail;
      delete bag!["ap"];
    }
  }
  // Strip stale per-turn AP latches from any in-progress encounter.
  const enc = s.encounter;
  if (enc?.turnState) {
    for (const heroId of Object.keys(enc.turnState)) {
      const ts = enc.turnState[heroId];
      if (!ts) continue;
      // Old-save field (removed from HeroTurnState in v65).
      const flags = (ts as unknown as { consumableSpendsThisTurn?: Record<string, boolean> }).consumableSpendsThisTurn;
      if (flags && "ap" in flags) delete flags["ap"];
    }
  }
  s.version = 22;
  return s;
}

/**
 * v22 → v23: backfill `movementStepsThisTurn = 0` on every existing
 * `HeroTurnState`. The new field tracks the number of step-by-step
 * movement steps taken this turn (introduced 2026-05-09 alongside
 * the action-gates-movement rule). For an in-progress save we
 * conservatively start the count at 0 — the player loses at most
 * the "free disarm if I haven't stepped yet" affordance for the
 * current turn, which is acceptable since most reloads happen at
 * turn boundaries.
 *
 * Defensive: returns `null` if the parsed object isn't shaped like
 * a v22 CampaignState — caller falls through to `newCampaign()`.
 *
 * Exported for the unit test in src/__tests__/state.test.ts.
 */
export function migrateV22ToV23(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const enc = s.encounter;
  if (enc?.turnState) {
    for (const heroId of Object.keys(enc.turnState)) {
      const ts = enc.turnState[heroId];
      if (!ts) continue;
      if (typeof (ts as { movementStepsThisTurn?: unknown }).movementStepsThisTurn !== "number") {
        ts.movementStepsThisTurn = 0;
      }
    }
  }
  s.version = 23;
  return s;
}

/**
 * v23 -> v24: backfill the Town Visit + Shop fields introduced
 * with Chapter 1's town-visit feature.
 *
 *   townVisit1Completed   -> false
 *   townVisit             -> null
 *   townDecisions         -> []
 *   shopProductsAvailable -> []
 *   shopProductsOwned     -> { "hero-01": [], "hero-02": [] }
 *
 * No state from older versions needs to fold into these — they are
 * pure additions. A pre-v24 save that already cleared Quest 1 will
 * boot with an empty Town Visit history; the Title screen will
 * NOT auto-route them into the visit (the End-of-Wave routing only
 * fires when a victory transition just happened). They can re-enter
 * via the Campaign Sheet's "Resume Town Visit" affordance once the
 * feature is exercised.
 *
 * Defensive: returns `null` if the parsed object isn't shaped like
 * a v23 CampaignState - caller falls through to `newCampaign()`.
 *
 * Exported for the unit test in src/__tests__/state.test.ts.
 */
export function migrateV23ToV24(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (typeof sx.townVisit1Completed !== "boolean") sx.townVisit1Completed = false;
  if (sx.townVisit === undefined) sx.townVisit = null;
  if (!Array.isArray(sx.townDecisions)) sx.townDecisions = [];
  if (!Array.isArray(sx.shopProductsAvailable)) sx.shopProductsAvailable = [];
  if (!sx.shopProductsOwned || typeof sx.shopProductsOwned !== "object") {
    sx.shopProductsOwned = { "hero-01": [], "hero-02": [] };
  } else {
    const owned = sx.shopProductsOwned as Record<string, unknown>;
    if (!Array.isArray(owned["hero-01"])) owned["hero-01"] = [];
    if (!Array.isArray(owned["hero-02"])) owned["hero-02"] = [];
  }
  s.version = 24;
  return s;
}

/**
 * v24 -> v25: backfill `actionGrantedExtraMovement = false` on every
 * existing `HeroTurnState`. The new field is the carve-out for the
 * action-gates-movement rule (DESIGN.md §5.1.2): when the action the
 * player took was specifically `bonus-movement-this-turn`, the
 * granted MP must remain spendable post-action, otherwise the slot
 * ability is dead-on-arrival.
 *
 * For an in-progress save we conservatively backfill `false`. The
 * worst case is a player who used `bonus-movement-this-turn` on the
 * turn the save was taken loses the carve-out for that turn (their
 * granted MP stays forfeit, same as on the buggy version that
 * shipped before this fix). End of turn clears the field naturally
 * via `startHeroTurn`, so the carve-out becomes available next
 * turn.
 *
 * Defensive: returns `null` if the parsed object isn't shaped like
 * a v24 CampaignState — caller falls through to `newCampaign()`.
 *
 * Exported for the unit test in src/__tests__/state.test.ts.
 */
export function migrateV24ToV25(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const enc = s.encounter;
  if (enc?.turnState) {
    for (const heroId of Object.keys(enc.turnState)) {
      const ts = enc.turnState[heroId];
      if (!ts) continue;
      if (typeof (ts as { actionGrantedExtraMovement?: unknown }).actionGrantedExtraMovement !== "boolean") {
        ts.actionGrantedExtraMovement = false;
      }
    }
  }
  s.version = 25;
  return s;
}

/**
 * v25 -> v26: backfill `unlockedHeroCards = [1, 2]` (the two
 * playable starters). New field added 2026-05-18 to track which
 * hero cards the campaign has unlocked via narrative beats (e.g.
 * Chapter 1 page 6 unlocks #3 + #4). Existing saves never saw
 * the page-6 grant under v25 so we don't backfill #3/#4 — only
 * the always-known starters. If the save IS mid- or post-Chapter
 * 1 Town Visit, the player won't see HERO #3/#4 unlocked
 * retroactively; they'd have to restart from before page 6 for
 * the actual grant to fire. Acceptable since v25 was prototype-only.
 *
 * Defensive: returns `null` if the parsed object isn't shaped like
 * a v25 CampaignState — caller falls through to `newCampaign()`.
 *
 * Exported for the unit test in `src/__tests__/townVisit.test.ts`.
 */
export function migrateV25ToV26(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (!Array.isArray(sx.unlockedHeroCards)) {
    sx.unlockedHeroCards = [1, 2];
  }
  s.version = 26;
  return s;
}

/**
 * v26 -> v27: backfill `keyItems = []` and `favour = {}`. New fields
 * added 2026-05-18 alongside the rewards-modal hookup for the
 * remaining five player-visible reward types (memory chips, creature
 * parts, shop products, key items, favour shifts).
 *
 * Existing v26 saves never saw the now-typed favour / key-item
 * actions (they were silent `record-decision` rows under v26 — those
 * dotted-log entries remain in `townDecisions` so the narrative log
 * still replays correctly). We don't backfill from `townDecisions`
 * because the v26 decision-key format was lossy (no display name,
 * no signed delta).
 *
 * Defensive: returns `null` if the parsed object isn't shaped like
 * a v26 CampaignState — caller falls through to `newCampaign()`.
 *
 * Exported for the unit test in `src/__tests__/townVisit.test.ts`.
 */
export function migrateV26ToV27(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (!Array.isArray(sx.keyItems)) {
    sx.keyItems = [];
  }
  if (!sx.favour || typeof sx.favour !== "object" || Array.isArray(sx.favour)) {
    sx.favour = {};
  }
  // Hard-code 27 (not SCHEMA_VERSION) so adding future migrations
  // can't accidentally graduate a v26 save straight to "current"
  // and skip later backfills.
  s.version = 27;
  return s;
}

/**
 * v27 -> v28: backfill `revealedQuests = []`. New field added
 * 2026-05-18 alongside the Quest #2 reveal-as-reward hookup —
 * Chapter 1 page14 emits a `reveal-quest` action whose state
 * impact is to append to this list. Existing v27 saves never
 * saw a typed reveal-quest action (the equivalent narrative beat
 * recorded a silent `ch1.quest2.unlocked` decision key under v27;
 * we leave that dotted-log entry in `townDecisions` so the
 * narrative log still replays correctly, but we don't backfill
 * `revealedQuests` from it — the v27 decision key format was lossy
 * (no display name, no printed quest number).
 *
 * Defensive: returns `null` if the parsed object isn't shaped like
 * a v27 CampaignState — caller falls through to `newCampaign()`.
 * Also defensively converts a pre-existing non-array `revealedQuests`
 * to `[]` so a save corrupted by a previous bad write doesn't
 * propagate the bad shape forward.
 *
 * Exported for the unit test in `src/__tests__/state.test.ts`.
 */
export function migrateV27ToV28(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (!Array.isArray(sx.revealedQuests)) {
    sx.revealedQuests = [];
  }
  // Hard-code 28 (not SCHEMA_VERSION) so adding future migrations
  // can't accidentally graduate a v27 save straight to "current"
  // and skip later backfills.
  s.version = 28;
  return s;
}

/**
 * v28 -> v29: backfill `opinionCards = []`. New field added
 * 2026-05-18 alongside the Opinion Card hook-up — the
 * `shift-favour` engine path now appends one
 * {@link OpinionCardRecord} per NAMED opinion level it walks the
 * favour value INTO. Existing v28 saves never saw a typed
 * opinion-card gain (the matching `record-decision` rows are
 * still appended to `townDecisions` so the narrative log replays
 * correctly), but the gain LIST itself was never tracked, so we
 * conservatively backfill `[]` rather than try to reconstruct
 * from the lossy decision-key history.
 *
 * Practical impact for a player mid-Town-Visit on a v28 save: any
 * favour shifts they already took won't retroactively show up as
 * opinion cards on the Campaign Sheet. New shifts after the
 * migration runs will populate the list normally.
 *
 * Defensive: returns `null` if the parsed object isn't shaped like
 * a v28 CampaignState — caller falls through to `newCampaign()`.
 * Also defensively converts a pre-existing non-array `opinionCards`
 * to `[]` so a save corrupted by a previous bad write doesn't
 * propagate the bad shape forward.
 *
 * Exported for the unit test in `src/__tests__/state.test.ts`.
 */
export function migrateV28ToV29(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (!Array.isArray(sx.opinionCards)) {
    sx.opinionCards = [];
  }
  // Hard-code 29 (not SCHEMA_VERSION) so adding future
  // migrations can't accidentally graduate a v28 save straight
  // to "current" and skip later backfills. Was set to
  // SCHEMA_VERSION up to and including v29-was-current; flipped
  // to a literal on the v30 bump (2026-05-18).
  s.version = 29;
  return s;
}

/**
 * v29 -> v30: backfill `currentQuestId = "quest1"`. New field
 * added 2026-05-18 alongside the Q2 scaffolding — controls which
 * quest's intro Story screen renders and which quest BoardScreen
 * bootstraps an encounter from. Defaulting to `"quest1"` for any
 * existing save is correct because Q2 progression doesn't ship
 * until Phase B; the only way to bump this today is the Title
 * screen's debug "Start from Quest 2" button.
 *
 * Defensive: also coerces any non-string value (corrupted save,
 * test fixture) to `"quest1"` rather than letting an invalid id
 * propagate into Story/Board where `getQuestData` would throw.
 *
 * Exported for the unit test in `src/__tests__/state.test.ts`.
 */
export function migrateV29ToV30(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (typeof sx.currentQuestId !== "string") {
    sx.currentQuestId = "quest1";
  }
  // Hard-code 30 (not SCHEMA_VERSION) so adding future migrations
  // can't accidentally graduate a v29 save straight to "current"
  // and skip later backfills. Flipped from SCHEMA_VERSION on the
  // v31 bump (2026-05-18).
  s.version = 30;
  return s;
}

/**
 * v30 -> v31: backfill `encounter.spawnCardDrawn = null`. New
 * field added 2026-05-18 alongside the Phase B spawn-deck
 * encounter path — records the printed Spawn Card number a wave
 * was bootstrapped from (1..14), or `null` for hand-authored
 * waves (Quest #1).
 *
 * Defensive: only touches `encounter` if it exists. A null
 * encounter (between waves) needs nothing — the field will be
 * set fresh on the next `buildEncounter`. A pre-existing in-
 * progress encounter is assumed to be a hand-authored Q1 wave
 * (since v30 saves can't have been Q2 — the codebase didn't
 * support it yet), so `null` is the correct backfill.
 *
 * Exported for the unit test in `src/__tests__/state.test.ts`.
 */
export function migrateV30ToV31(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  const enc = sx.encounter;
  if (enc && typeof enc === "object") {
    const encx = enc as Record<string, unknown>;
    if (encx.spawnCardDrawn === undefined) {
      encx.spawnCardDrawn = null;
    }
  }
  // Hard-code 31 (not SCHEMA_VERSION) so adding future migrations
  // can't accidentally graduate a v30 save straight to "current"
  // and skip later backfills.
  s.version = 31;
  return s;
}

/**
 * v31 -> v32: backfill `encounter.memoryFragments = []`. New
 * field added 2026-05-18 alongside the Memory Fragment board
 * token surfacing — every Spawn Card with a printed diamond
 * glyph (cards #1, #3, #6, #7, ...) seats a fragment token at
 * that tile when the wave bootstraps.
 *
 * Defensive: only touches `encounter` if it exists. An older
 * v31 encounter could only have been hand-authored (Q1) OR a
 * spawn-deck wave drawn before the field was introduced; in
 * either case the safe backfill is `[]` (Q1 has no fragments;
 * legacy mid-wave Q2 saves just lose the on-board art until
 * the wave restarts, which is fine — pickup isn't wired yet).
 */
export function migrateV31ToV32(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  const enc = sx.encounter;
  if (enc && typeof enc === "object") {
    const encx = enc as Record<string, unknown>;
    if (!Array.isArray(encx.memoryFragments)) {
      encx.memoryFragments = [];
    }
  }
  // Hard-code 32 (not SCHEMA_VERSION) so adding future migrations
  // can't accidentally graduate a v31 save straight to "current"
  // and skip later backfills. Flipped from SCHEMA_VERSION when v33
  // (shop grants) landed.
  s.version = 32;
  return s;
}

/**
 * v32 -> v33: backfill the shop-grant tracking fields introduced
 * with the structured Shop Product Grants pipeline (2026-05-18).
 *
 * Two new fields land on this bump:
 *   - `shopDamageBonus[heroId]: Partial<Record<DamageType, number>>`
 *     Permanent per-quest damage bonus accumulated from "+1 LIGHT" /
 *     "+2 MEDIUM" / "+4 HEAVY" shop cards (Quest-Bonus grants).
 *     Combat reads this on every weapon swing of the matching
 *     damage type. Reset to `{}` per delver at quest end (alongside
 *     `consumableTokens` / `elements` in `endQuestReset`).
 *   - `shopGrantsAppliedQuests: string[]`
 *     Set of quest ids for which Quest-Bonus shop grants have
 *     already been applied. Prevents double-apply when the player
 *     refreshes the page or re-enters the same quest. Wave-Bonus
 *     grants are NOT tracked here — they re-fire at every wave
 *     start by design.
 *
 * Defensive: existing saves with neither field get empty objects /
 * arrays. A v32 save mid-Q2 W1 (before shop grants were a thing)
 * just continues with no shop bonuses applied, which is the same
 * behaviour the player experienced pre-bump — backwards compatible.
 */
export function migrateV32ToV33(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (!sx.shopDamageBonus || typeof sx.shopDamageBonus !== "object") {
    const heroIds = sx.loadouts && typeof sx.loadouts === "object"
      ? Object.keys(sx.loadouts as Record<string, unknown>)
      : ["hero-01", "hero-02"];
    const seed: Record<string, Partial<Record<DamageType, number>>> = {};
    for (const h of heroIds) seed[h] = {};
    sx.shopDamageBonus = seed;
  }
  if (!Array.isArray(sx.shopGrantsAppliedQuests)) {
    sx.shopGrantsAppliedQuests = [];
  }
  // Hard-code 33 (not SCHEMA_VERSION) so adding future migrations
  // can't accidentally graduate a v32 save straight to "current"
  // and skip later backfills. Flipped from SCHEMA_VERSION when v34
  // (Chapter 2 Town Visit fields) landed.
  s.version = 33;
  return s;
}

/**
 * v33 -> v34: backfill Chapter 2 Town Visit support fields
 * (2026-05-18, shipped alongside `data/chapter2.json`):
 *
 *   - `townVisit2Completed: boolean` — Ch2 completion latch. Mirrors
 *     `townVisit1Completed` for the second town visit. Old saves
 *     default to `false`; the Ch2 visit hasn't run yet anyway so
 *     this is correct for every pre-bump campaign state.
 *   - `storyTokens: number` — shared Story Token pool used by the
 *     Ch2 "Burned Watchtower" hub page to gate the player's
 *     "visit 2 of 3 locations" choice. Old saves default to 0 —
 *     no active visit was using the pool pre-bump so the seed
 *     matches reality.
 *
 * Defensive: in-progress saves mid-Q1/Q2 (no Ch2 visit open) just
 * continue with empty defaults. No active visit can have storyTokens
 * mid-flight because the field didn't exist before this bump.
 */
export function migrateV33ToV34(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (typeof sx.townVisit2Completed !== "boolean") sx.townVisit2Completed = false;
  if (typeof sx.storyTokens !== "number") sx.storyTokens = 0;
  // Hard-code 34 (not SCHEMA_VERSION) so adding future migrations
  // can't accidentally graduate a v33 save straight to "current"
  // and skip later backfills. Flipped from SCHEMA_VERSION when v35
  // (Witness companion `witnessPosition` on encounter) landed.
  s.version = 34;
  return s;
}

/**
 * v34 -> v35: backfill `encounter.witnessPosition = null` on every
 * existing save. Field added 2026-05-18 alongside the Q2 Witness
 * companion implementation (rulebook Chapter 2 - "From now on, you
 * won't go alone").
 *
 * Defensive `null` backfill regardless of quest:
 *   - Q1 encounters legitimately have no Witness (rulebook hasn't
 *     introduced him yet) so `null` is the correct steady state.
 *   - Q2 encounters MID-WAVE on a pre-v35 save won't get their
 *     Witness back from this migration alone (`null` is the wrong
 *     value for them), but the player can finish the wave normally
 *     and the next wave bootstrap re-seeds Witness from
 *     `engine/encounter.ts > buildEncounter`. The blast radius is
 *     limited to the in-flight wave, which is acceptable for a
 *     prototype-stage schema bump.
 */
export function migrateV34ToV35(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  const enc = sx.encounter;
  if (enc && typeof enc === "object") {
    const encx = enc as Record<string, unknown>;
    if (encx.witnessPosition === undefined) {
      encx.witnessPosition = null;
    }
  }
  // Hard-code 35 (not SCHEMA_VERSION) so adding future migrations
  // can't accidentally graduate a v34 save straight to "current"
  // and skip later backfills. Flipped from SCHEMA_VERSION when v36
  // (Opinion Card abilities — Xavier rank picks, Samantha/Flores
  // shop discounts, Elayne refresh, Vera shield, opinionCardsSpent
  // tracking) landed.
  s.version = 35;
  return s;
}

/**
 * v35 -> v36: backfill Opinion Card ability support fields
 * (2026-05-19, shipped alongside the Xavier rank-bump,
 * Samantha / Flores shop-discount, Elayne consumable-refresh,
 * and Vera opinion-shield mechanics):
 *
 *   - `temporaryRankBonus: Record<heroId, Partial<Record<EquipmentType, number>>>`
 *     Per-delver per-slot temporary rank offset granted by Xavier's
 *     three opinion cards. Old saves had no Xavier picks resolved
 *     so the safe default is empty per delver.
 *   - `opinionCardsSpent: string[]`
 *     Set of `"{characterId}-{level}"` ids the player has redeemed
 *     for their one-shot ability. Old saves never had any
 *     one-shots; default `[]`.
 *   - `samanthaDiscountActive: boolean` / `floresDiscountArmed: boolean`
 *     Town-visit-scoped redemption latches. Default `false` —
 *     pre-bump saves had no way to set them.
 *   - `opinionGrantsAppliedQuests: string[]`
 *     Idempotency set for `applyOpinionGrantsForQuest`. Default `[]`
 *     — pre-bump saves never enqueued opinion grants, so the next
 *     quest start will correctly enqueue them for the first time.
 *   - `encounter.pendingOpinionRankPicks: PendingOpinionRankPick[]`
 *     Per-encounter queue of unresolved Xavier picks. Default `[]`
 *     for any in-flight encounter — pre-bump encounters can't have
 *     pending picks because the system didn't exist; the next quest
 *     rebuild will seed them via `applyOpinionGrantsForQuest`.
 *
 * Defensive: hero ids are derived from `loadouts` keys when
 * available, falling back to `["hero-01", "hero-02"]` so legacy
 * saves with no loadout map still get a sane backfill (matches the
 * `newCampaign()` hero seeding).
 */
export function migrateV35ToV36(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  const heroIds = sx.loadouts && typeof sx.loadouts === "object"
    ? Object.keys(sx.loadouts as Record<string, unknown>)
    : ["hero-01", "hero-02"];
  if (!sx.temporaryRankBonus || typeof sx.temporaryRankBonus !== "object" || Array.isArray(sx.temporaryRankBonus)) {
    const seed: Record<string, Partial<Record<EquipmentType, number>>> = {};
    for (const h of heroIds) seed[h] = {};
    sx.temporaryRankBonus = seed;
  }
  if (!Array.isArray(sx.opinionCardsSpent)) sx.opinionCardsSpent = [];
  if (typeof sx.samanthaDiscountActive !== "boolean") sx.samanthaDiscountActive = false;
  if (typeof sx.floresDiscountArmed !== "boolean") sx.floresDiscountArmed = false;
  if (!Array.isArray(sx.opinionGrantsAppliedQuests)) sx.opinionGrantsAppliedQuests = [];
  const enc = sx.encounter;
  if (enc && typeof enc === "object") {
    const encx = enc as Record<string, unknown>;
    if (!Array.isArray(encx.pendingOpinionRankPicks)) {
      encx.pendingOpinionRankPicks = [];
    }
  }
  // Hard-code 36 so a subsequent migration step (v36 -> v37) picks
  // this save up correctly in the chained loader. NEVER use
  // `SCHEMA_VERSION` here — that would skip every intermediate
  // migration when SCHEMA_VERSION advances past v36.
  s.version = 36;
  return s;
}

/**
 * v36 -> v37: Backfill the Chapter 2 Town Center Academy-donation
 * fields (`academyDonation`, `suitConditionRankBonus`). Older saves
 * (created before the donation product #8 had a real mechanical
 * effect) get safe defaults — zero donations per delver, no
 * suit-condition bumps. Forward-compatible: any pre-existing
 * value is preserved (e.g. a future hand-edited save).
 *
 * Tied to v37 specifically; the donation engine's reads default
 * through `?? 0` / `?? {}` so the migration is purely opportunistic
 * — even an un-migrated save would behave correctly at runtime,
 * but stamping the schema lets the test suite assert on the
 * post-migration shape.
 */
export function migrateV36ToV37(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  const heroIds = sx.loadouts && typeof sx.loadouts === "object"
    ? Object.keys(sx.loadouts as Record<string, unknown>)
    : ["hero-01", "hero-02"];
  if (!sx.academyDonation || typeof sx.academyDonation !== "object" || Array.isArray(sx.academyDonation)) {
    const seed: Record<string, number> = {};
    for (const h of heroIds) seed[h] = 0;
    sx.academyDonation = seed;
  }
  if (!sx.suitConditionRankBonus || typeof sx.suitConditionRankBonus !== "object" || Array.isArray(sx.suitConditionRankBonus)) {
    const seed: Record<string, Partial<Record<EquipmentType, number>>> = {};
    for (const h of heroIds) seed[h] = {};
    sx.suitConditionRankBonus = seed;
  }
  // Hard-code 37 (not SCHEMA_VERSION) so adding future migrations
  // can't accidentally graduate a v36 save straight to "current"
  // and skip later backfills.
  s.version = 37;
  return s;
}

/**
 * v37 → v38: seed `ultraLevelCardsOwned` (the per-campaign set of
 * earned Ultra Level Up card numbers, surfaced into each encounter's
 * level deck on init). Older saves never tracked Ultras separately
 * from the base deck; default is `[]` (no Ultras owned). Idempotent —
 * if the field is already a valid array it's left untouched.
 */
export function migrateV37ToV38(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (!Array.isArray(sx.ultraLevelCardsOwned)) {
    sx.ultraLevelCardsOwned = [];
  }
  // Hard-code 38 (not SCHEMA_VERSION) so adding future migrations
  // can't accidentally graduate a v37 save straight to "current"
  // and skip later backfills.
  s.version = 38;
  return s;
}

/**
 * v38 → v39: re-number the printed Ultra Level Up cards from the
 * old (incorrect) range 25..28 to the actual PDF range 29..32. The
 * v38 schema confused the "last 4 entries of `levelDeck.json`" with
 * "the Ultra cards"; cards 25..28 are actually still BASE cards
 * (3 types, +1 RANK), while 29..32 are the Ultras (2 types, +2
 * RANKS on a listed type OR +1 RANK on any passive — see
 * `LevelUpDeckCard` jsdoc).
 *
 * Any campaign that earned an "Ultra" under v38 will have card
 * numbers 25..28 stored in `ultraLevelCardsOwned`. That data is now
 * wrong (those numbers belong to base cards which are always in
 * the deck, so leaving them in `ultraLevelCardsOwned` would just
 * double them up). We drop them entirely — the player effectively
 * loses Ultra credits they earned under the buggy version, but they
 * can re-earn the proper Ultras (29..32) by replaying the Ch1
 * Library Creature Archives.
 *
 * Idempotent: filtering 25..28 out of a list that never contained
 * them is a no-op.
 */
export function migrateV38ToV39(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (Array.isArray(sx.ultraLevelCardsOwned)) {
    const cleaned = (sx.ultraLevelCardsOwned as number[]).filter(
      (n) => typeof n === "number" && n >= 29 && n <= 32,
    );
    sx.ultraLevelCardsOwned = cleaned;
  } else {
    sx.ultraLevelCardsOwned = [];
  }
  // Hard-code 39 (not SCHEMA_VERSION) so adding future migrations
  // can't accidentally graduate a v38 save straight to "current"
  // and skip later backfills.
  s.version = 39;
  return s;
}

/**
 * v39 -> v40: backfill `witnessStepsThisTurn = 0` on every existing
 * `HeroTurnState`. The new field tracks how many 1-tile Witness
 * movement steps the active delver has taken this turn as part of
 * the "Move Witness" Action (Witness Reference Card, rulebook Q2+
 * companion). Capped at 2 per turn.
 *
 * For an in-progress save we conservatively start the count at 0
 * — the player loses at most their CURRENT turn's Witness
 * progress; the action-used latch is the real gate so this only
 * matters if they were mid-Witness-action when they saved.
 *
 * Defensive: returns `null` if the parsed object isn't shaped like
 * a campaign so the chained loader falls through to a fresh
 * campaign rather than crashing on a malformed save.
 */
export function migrateV39ToV40(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const enc = (s as unknown as { encounter?: unknown }).encounter as
    | { turnState?: Record<string, unknown> }
    | null
    | undefined;
  if (enc && typeof enc === "object" && enc.turnState && typeof enc.turnState === "object") {
    for (const heroId of Object.keys(enc.turnState)) {
      const ts = enc.turnState[heroId] as Record<string, unknown> | undefined;
      if (!ts) continue;
      if (typeof (ts as { witnessStepsThisTurn?: unknown }).witnessStepsThisTurn !== "number") {
        ts.witnessStepsThisTurn = 0;
      }
    }
  }
  // Hard-code 40 (not SCHEMA_VERSION) so adding future migrations
  // doesn't make this one silently mark old saves as "current"
  // and skip later backfills. Flipped from SCHEMA_VERSION when v41
  // landed.
  (s as { version: number }).version = 40;
  return s;
}

/**
 * v40 -> v41: backfill the new quest-start hero-pick fields:
 *   - `activeHeroCardByDelver: { "hero-01": 1, "hero-02": 2 }`
 *     (starter pairing; players can opt into the picker on the
 *     next quest start)
 *   - `pendingHeroPickDelvers: []`
 *   - `heroPicksAppliedQuests: [<currentQuestId if mid-quest>]`
 *
 * The `heroPicksAppliedQuests` seeding is the subtle bit: a save
 * loaded mid-Q2 already PASSED the natural hero-pick window for
 * Q2 (Story → board on quest start) without ever seeing the
 * picker, so we mark Q2 as "already applied" to suppress a
 * mid-quest prompt that would feel like an out-of-flow popup.
 * Future quests will trigger the picker normally because their
 * ids aren't in the seeded list. The same trick is used by
 * `shopGrants` for similar one-shot-per-quest mechanics.
 *
 * Defensive: returns `null` if the parsed object isn't shaped like
 * a campaign so the chained loader falls through to a fresh
 * campaign rather than crashing on a malformed save.
 */
export function migrateV40ToV41(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (
    !sx.activeHeroCardByDelver
    || typeof sx.activeHeroCardByDelver !== "object"
  ) {
    sx.activeHeroCardByDelver = { "hero-01": 1, "hero-02": 2 };
  }
  if (!Array.isArray(sx.pendingHeroPickDelvers)) {
    sx.pendingHeroPickDelvers = [];
  }
  if (!Array.isArray(sx.heroPicksAppliedQuests)) {
    // Suppress mid-quest prompt for the in-progress quest (the
    // player already passed the natural Story → Board window
    // before this feature shipped). New quests entered after this
    // save was written will trigger the picker normally because
    // their ids aren't in this list.
    const currentQuestId = typeof sx.currentQuestId === "string" ? sx.currentQuestId : null;
    sx.heroPicksAppliedQuests = currentQuestId ? [currentQuestId] : [];
  }
  s.version = 41;
  return s;
}

/**
 * v41 -> v42: backfill `movementSnapshot = null` on every existing
 * `HeroTurnState` (2026-05-21). The new field captures the turn-start
 * position / MP / parts-counter baseline lazily on the first
 * movement step, so `undoMovementThisTurn` can rewind to it when
 * the player picks "Undo and submit" on the End Turn confirmation
 * modal (which fires when movement happened but no card was placed).
 *
 * For an in-progress save we conservatively backfill `null`. The
 * worst case is a player mid-movement when the save was taken
 * loses access to "Undo and submit" for THAT turn — the field
 * fills in normally on their next step.
 *
 * Defensive: returns `null` if the parsed object isn't shaped like
 * a v41 CampaignState — caller falls through to `newCampaign()`.
 *
 * Exported for the unit test in src/__tests__/state.test.ts.
 */
export function migrateV41ToV42(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const enc = s.encounter;
  if (enc?.turnState) {
    for (const heroId of Object.keys(enc.turnState)) {
      const ts = enc.turnState[heroId];
      if (!ts) continue;
      if (!("movementSnapshot" in (ts as object))) {
        (ts as { movementSnapshot: unknown }).movementSnapshot = null;
      }
    }
  }
  s.version = 42;
  return s;
}

/**
 * v42 → v43: seed `memoryCards` (the per-campaign list of Memory
 * Card numbers drawn from spent Memory Chip Tokens). Existing saves
 * predate the Ch2 Machinist "Witness records a memory" page so the
 * starter value is `[]` — the next visit through the new page will
 * populate it. Idempotent against pre-seeded saves (the v42 → v43
 * bump shipped together with the first writer, so any save that
 * already has the array is a forward-compat replay we should
 * preserve as-is).
 */
export function migrateV42ToV43(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (!Array.isArray(sx.memoryCards)) {
    sx.memoryCards = [];
  }
  s.version = 43;
  return s;
}

/**
 * v43 → v44: seed `pendingSuitConditionPicks` (the per-campaign
 * queue of Suit Condition rank picks awaiting player resolution).
 * Existing saves predate the new academy-donation picker + the
 * dead-delver "blood-soaked power" pick on `page22-died`, so the
 * starter value is `[]` — the next visit through either path will
 * populate it.
 *
 * Idempotent against pre-seeded saves (forward-compat replay).
 */
export function migrateV43ToV44(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (!Array.isArray(sx.pendingSuitConditionPicks)) {
    sx.pendingSuitConditionPicks = [];
  }
  // Hard-code 44 (not SCHEMA_VERSION) so adding future migrations
  // beyond v44 doesn't accidentally let this migration set a
  // version newer than the fields it actually backfills, which
  // would let later migrations skip their backfills. Flipped from
  // SCHEMA_VERSION when v45 (Scenario Card resolution state) was
  // added.
  s.version = 44;
  return s;
}

/**
 * v44 → v45: seed Scenario Card resolution state.
 *
 *   - `scenarioCardsResolved` — append-only list of resolved
 *     card numbers (printed: discarded). Empty for pre-v45 saves
 *     (cards weren't tracked before v45, so a Chapter 2 player
 *     reloading into v45 mid-quest gets a clean slate and may
 *     re-draw the same card the storybook is currently asking
 *     them to resolve — that's the expected fail-safe behaviour).
 *   - `currentScenarioCard` — null when no card is in-flight.
 *     The next wave-bootstrap that has `scenarioCardOnStart`
 *     repopulates it.
 *
 * Idempotent against pre-seeded saves (forward-compat replay).
 */
export function migrateV44ToV45(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (!Array.isArray(sx.scenarioCardsResolved)) {
    sx.scenarioCardsResolved = [];
  }
  if (sx.currentScenarioCard === undefined) {
    sx.currentScenarioCard = null;
  }
  // Hard-code 45 (not SCHEMA_VERSION) so adding future migrations
  // doesn't accidentally tag a v45 backfill with a newer schema
  // version than the fields it actually backfills. Flipped from
  // SCHEMA_VERSION when v46 (Friendly Spawn Cards + Friendly
  // Encounter token queue) was added.
  s.version = 45;
  return s;
}

/**
 * v45 -> v46: seed Friendly Spawn Card + Friendly Encounter state.
 *
 *   - `friendlySpawnDeck` -- friendly spawn card numbers (13, 14)
 *     currently shuffled into the spawn deck. Empty for pre-v46
 *     saves (chapter 1 + 2 narrative beats that grant these
 *     cards previously only recorded a `record-decision` flag
 *     and never wired the grant; a player reloading into v46
 *     mid-Ch2 keeps the now-empty deck and will re-grant when
 *     they re-visit the location).
 *   - `pendingFriendlyEncounters` -- friendly encounter card
 *     numbers drawn but not yet resolved. Empty for pre-v46
 *     saves; no pre-existing pickup wiring could have populated
 *     it.
 *   - `encounter.friendlyEncounters` -- token positions on the
 *     board. Backfilled to `[]` on any in-flight encounter so
 *     the board renderer doesn't choke on `undefined.map`. The
 *     player's current wave won't sprout new friendly tokens
 *     mid-wave (no spawn card was drawn against the v46
 *     friendly-encounter wiring); the next wave bootstrap is
 *     where the new system actually kicks in.
 *
 * Idempotent against pre-seeded saves (forward-compat replay).
 */
export function migrateV45ToV46(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (!Array.isArray(sx.friendlySpawnDeck)) {
    sx.friendlySpawnDeck = [];
  }
  if (!Array.isArray(sx.pendingFriendlyEncounters)) {
    sx.pendingFriendlyEncounters = [];
  }
  if (s.encounter) {
    const encx = s.encounter as unknown as Record<string, unknown>;
    if (!Array.isArray(encx.friendlyEncounters)) {
      encx.friendlyEncounters = [];
    }
  }
  s.version = 46;
  return s;
}

/**
 * v46 → v47: seed `unlockedForHigherRanks` — the per-delver per-type
 * flag that gates level-up cards from raising a type's base rank above 3.
 *
 * All equipment types start locked (empty object per delver). A save
 * that already has the field is left as-is (forward-compat replay).
 */
export function migrateV46ToV47(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (!sx.unlockedForHigherRanks || typeof sx.unlockedForHigherRanks !== "object" || Array.isArray(sx.unlockedForHigherRanks)) {
    const seed: Record<string, Record<string, true>> = {};
    for (const heroId of Object.keys(s.loadouts ?? {})) {
      seed[heroId] = {};
    }
    sx.unlockedForHigherRanks = seed;
  }
  s.version = 47;
  return s;
}

/**
 * v47 → v48: change `unlockedForHigherRanks` values from boolean `true`
 * (old schema: "fully unlocked") to the numeric cap `4 | 5`.
 *
 * Old saves with `true` had effectively unlimited rank access (cap = 5),
 * so they migrate to `5`. Already-numeric values are left unchanged.
 */
export function migrateV47ToV48(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const map = s.unlockedForHigherRanks as unknown as Record<string, Record<string, unknown>> | undefined;
  if (map && typeof map === "object") {
    for (const heroId of Object.keys(map)) {
      const heroMap = map[heroId];
      if (heroMap && typeof heroMap === "object") {
        for (const type of Object.keys(heroMap)) {
          if (heroMap[type] === true) {
            // Old boolean → migrate to fully unlocked cap 5.
            (heroMap as Record<string, number>)[type] = 5;
          }
        }
      }
    }
  }
  s.version = 48;
  return s;
}

/**
 * v48 → v49: seed `discardedHeroCards = []` for saves that predate
 * permanent hero-card loss on death. Existing saves have no discards.
 */
export function migrateV49ToV50(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  // Fix in-flight spawn card #13 encounter: the token positions were
  // wrong in the original data (FE at (0,0) instead of (0,3), missing
  // memory fragment at (0,0), minion at (0,3) instead of (4,4)).
  const enc = s.encounter;
  if (enc && enc.spawnCardDrawn === 13) {
    // Fix friendlyEncounters: was at (0,0), should be at (0,3)
    enc.friendlyEncounters = (enc.friendlyEncounters ?? []).filter(
      (fe) => !(fe.x === 0 && fe.y === 0),
    );
    if (!enc.friendlyEncounters.some((fe) => fe.x === 0 && fe.y === 3)) {
      enc.friendlyEncounters.push({ x: 0, y: 3 });
    }
    // Fix memoryFragments: was empty, should have one at (0,0)
    if (!Array.isArray(enc.memoryFragments)) enc.memoryFragments = [];
    if (!enc.memoryFragments.some((mf) => mf.x === 0 && mf.y === 0)) {
      enc.memoryFragments.push({ x: 0, y: 0 });
    }
    // Fix enemy position: minion at (0,3) should be at (4,4)
    const minionAt03 = enc.enemies?.find(
      (e) => e.x === 0 && e.y === 3 && e.alive,
    );
    const enemyAt44 = enc.enemies?.find((e) => e.x === 4 && e.y === 4);
    if (minionAt03 && !enemyAt44) {
      minionAt03.x = 4;
      minionAt03.y = 4;
    }
  }
  if (enc && enc.spawnCardDrawn === 14) {
    // Fix friendlyEncounters: was at (4,4), should be at (4,2)
    enc.friendlyEncounters = (enc.friendlyEncounters ?? []).filter(
      (fe) => !(fe.x === 4 && fe.y === 4),
    );
    if (!enc.friendlyEncounters.some((fe) => fe.x === 4 && fe.y === 2)) {
      enc.friendlyEncounters.push({ x: 4, y: 2 });
    }
    // Fix enemy position: minion misclassified at (4,2) should be at (4,4)
    const minionAt42 = enc.enemies?.find(
      (e) => e.x === 4 && e.y === 2 && e.alive,
    );
    const enemyAt44b = enc.enemies?.find((e) => e.x === 4 && e.y === 4);
    if (minionAt42 && !enemyAt44b) {
      minionAt42.x = 4;
      minionAt42.y = 4;
    }
  }
  s.version = 50;
  return s;
}

export function migrateV48ToV49(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (!Array.isArray(sx.discardedHeroCards)) {
    sx.discardedHeroCards = [];
  }
  s.version = 49;
  return s;
}

/**
 * v50 → v51: seed `suitLoadouts` — the per-delver 3×3 grid of
 * starting equipment slots (physical "Starting Equipment Slots" sheet).
 * Existing saves get three empty loadouts per delver; no bonuses
 * already in `suitConditionRankBonus` are retroactively slotted
 * (the flat bonus map still applies, loadout display starts fresh).
 */
export function migrateV50ToV51(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (!sx.suitLoadouts || typeof sx.suitLoadouts !== "object" || Array.isArray(sx.suitLoadouts)) {
    const heroIds = sx.loadouts && typeof sx.loadouts === "object"
      ? Object.keys(sx.loadouts as Record<string, unknown>)
      : ["hero-01", "hero-02"];
    const seed: Record<string, Array<Array<null>>> = {};
    for (const h of heroIds) seed[h] = [[null, null, null], [null, null, null], [null, null, null]];
    sx.suitLoadouts = seed;
  }
  s.version = 51;
  return s;
}

/**
 * v51 → v52: seed `scars` — per-delver list of keyword strings
 * acquired during the campaign. Existing saves start with no scars.
 */
export function migrateV51ToV52(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (!sx.scars || typeof sx.scars !== "object" || Array.isArray(sx.scars)) {
    const heroIds = sx.loadouts && typeof sx.loadouts === "object"
      ? Object.keys(sx.loadouts as Record<string, unknown>)
      : ["hero-01", "hero-02"];
    const seed: Record<string, string[]> = {};
    for (const h of heroIds) seed[h] = [];
    sx.scars = seed;
  }
  s.version = 52;
  return s;
}

/**
 * v52 → v53: seed `equipmentRollsAppliedQuests = []` for saves that
 * predate per-quest passive equipment-roll tracking (Supercharger /
 * Battery). Existing saves start with an empty ledger — rolls will
 * fire on the next quest start.
 */
export function migrateV52ToV53(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (!Array.isArray(sx.equipmentRollsAppliedQuests)) {
    sx.equipmentRollsAppliedQuests = [];
  }
  s.version = 53;
  return s;
}

/**
 * v53 → v54: seed `graveyard = []` for saves that predate the
 * hero-card graveyard / final-words feature. Existing saves start
 * with an empty memorial — deaths before this version are not
 * retroactively recorded.
 */
export function migrateV53ToV54(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (!Array.isArray(sx.graveyard)) {
    sx.graveyard = [];
  }
  s.version = 54;
  return s;
}

export function migrateV54ToV55(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  // Backfill `clues` on existing KeyItemRecord entries.
  // Look up the catalog to get the correct count; fall back to 1 if
  // the item number isn't in the catalog (e.g. a future item we
  // haven't catalogued yet).
  if (Array.isArray(s.keyItems)) {
    for (const k of s.keyItems as Array<{ number: number; name: string; clues?: number }>) {
      if (typeof k.clues !== "number") {
        const meta = KEY_ITEMS.find((x) => x.number === k.number);
        k.clues = meta?.clues ?? 1;
      }
    }
  }
  s.version = 55;
  return s;
}

/**
 * v55 → v56: seed `pendingScenarioDelverPicks = []` for saves that
 * predate the per-delver-pick queue (added for scenario cards #03-#09
 * effects: consumable tokens, AP grants, HP losses to one chosen delver).
 */
export function migrateV55ToV56(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (!Array.isArray(sx.pendingScenarioDelverPicks)) {
    sx.pendingScenarioDelverPicks = [];
  }
  s.version = 56;
  return s;
}

/**
 * v56 → v57: seed `pendingAcademyDonationResolution = null` for saves
 * that predate the academy-donation resolution staging field (added
 * for the multi-step donation modal — Phase 1 delver assignment +
 * Phase 2 per-delver slot placement).
 */
export function migrateV56ToV57(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (!("pendingAcademyDonationResolution" in sx)) {
    sx.pendingAcademyDonationResolution = null;
  }
  s.version = 57;
  return s;
}

/**
 * v57 → v58: seed the level-aware boss-part wallets
 * (`bossPartsLvl2` / `bossPartsLvl3`) with zeros.
 *
 * Known migration limitation, accepted 2026-07-20: any lvl-2/3 boss
 * parts collected on an OLD save were credited to the flat
 * `bossParts` counter with no level recorded, so they stay there as
 * lvl-1 parts (there is nothing to split them back out by). Fresh
 * pickups route by printed level from v58 on.
 */
export function migrateV57ToV58(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  const heroIds = sx.loadouts && typeof sx.loadouts === "object"
    ? Object.keys(sx.loadouts as Record<string, unknown>)
    : ["hero-01", "hero-02"];
  for (const field of ["bossPartsLvl2", "bossPartsLvl3"] as const) {
    if (!sx[field] || typeof sx[field] !== "object") {
      const seed: Record<string, number> = {};
      for (const h of heroIds) seed[h] = 0;
      sx[field] = seed;
    }
  }
  // Same v58 batch: seed the pending XP-roll queue on any in-flight
  // encounter (the "Gain 1 [die] XP" on-death reward — Ophidian 017 /
  // Sporecloud 022 — became a player-facing roll in this version;
  // pre-v58 it was silently flattened to a static 1 XP).
  const enc = sx.encounter as Record<string, unknown> | null | undefined;
  if (enc && typeof enc === "object" && !Array.isArray(enc.pendingXpRolls)) {
    enc.pendingXpRolls = [];
  }
  // Same v58 batch: seed the equipment-variant table (Machinist
  // Equipment Upgrade replacements). Owners of #32/#34/#41 get the
  // variant re-applied at the next quest bootstrap; the old +2 rank
  // approximation baked into `equipmentRanks` on a legacy save is
  // left as-is (it resets at quest end anyway).
  if (!sx.equipmentVariants || typeof sx.equipmentVariants !== "object") {
    const seed: Record<string, Record<string, never>> = {};
    for (const h of heroIds) seed[h] = {};
    sx.equipmentVariants = seed;
  }
  s.version = 58;
  return s;
}

/**
 * v58 -> v59 (Chapter 3 Town Visit): seed `townVisit3Completed`,
 * `completedQuests`, `scenarioDeckTop`, `academyDonationLifetime`.
 * Lifetime donations start from any per-visit total still on the save.
 */
export function migrateV58ToV59(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (typeof sx.townVisit3Completed !== "boolean") sx.townVisit3Completed = false;
  if (!Array.isArray(sx.completedQuests)) sx.completedQuests = [];
  if (!Array.isArray(sx.scenarioDeckTop)) sx.scenarioDeckTop = [];
  if (typeof sx.academyDonationLifetime !== "number") {
    const per = (sx.academyDonation ?? {}) as Record<string, number>;
    sx.academyDonationLifetime = Object.values(per).reduce((a, b) => a + (b ?? 0), 0);
  }
  s.version = 59;
  return s;
}

/**
 * v59 -> v60 (Nov 15 opinion-card rules): Samantha Ally no longer
 * discounts boss parts (it now shields the next opinion loss, which
 * used to be Vera Ally), so the per-visit `samanthaDiscountActive`
 * latch is dropped. Spent ids are kept as-is: a spent card stays spent.
 */
export function migrateV59ToV60(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  delete (s as unknown as Record<string, unknown>).samanthaDiscountActive;
  s.version = 60;
  return s;
}

/**
 * v60 -> v61 (Chapter 3 Waves 4-5): seed the LVL 4 / LVL 5 boss-part
 * wallets (Golem / Timber Fiend drops) with zeros, and the per-encounter
 * ability state the new enemies use (`countdownTokens`, `accurateMarks`).
 */
export function migrateV60ToV61(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  const heroIds = sx.loadouts && typeof sx.loadouts === "object"
    ? Object.keys(sx.loadouts as Record<string, unknown>)
    : ["hero-01", "hero-02"];
  for (const field of ["bossPartsLvl4", "bossPartsLvl5"] as const) {
    if (!sx[field] || typeof sx[field] !== "object") {
      const seed: Record<string, number> = {};
      for (const h of heroIds) seed[h] = 0;
      sx[field] = seed;
    }
  }
  const enc = sx.encounter as Record<string, unknown> | null | undefined;
  if (enc && typeof enc === "object") {
    if (typeof enc.countdownTokens !== "number") enc.countdownTokens = 0;
    if (!enc.accurateMarks || typeof enc.accurateMarks !== "object") enc.accurateMarks = {};
  }
  s.version = 61;
  return s;
}

/**
 * v61 -> v62 (opinion card rules): one card per character. Older saves
 * kept every card a character ever granted; keep only the card that
 * matches the character's current opinion (dropping all of them when it
 * matches none, e.g. back at Neutral). Adds the Ira Ally visit latch and
 * Dahlia Ally token choice.
 */
export function migrateV61ToV62(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  const cards = Array.isArray(sx.opinionCards) ? (sx.opinionCards as OpinionCardRecord[]) : [];
  const favour = (sx.favour ?? {}) as Record<string, { value: number }>;
  const levelFor = (v: number) => v >= 2 ? "confidant" : v === 1 ? "ally" : v === -1 ? "detractor" : v <= -2 ? "nemesis" : null;
  const kept: OpinionCardRecord[] = [];
  for (const cid of [...new Set(cards.map((c) => c.characterId))]) {
    const mine = cards.filter((c) => c.characterId === cid);
    const want = favour[cid] ? levelFor(favour[cid]!.value) : mine[mine.length - 1]!.level;
    const match = mine.find((c) => c.level === want);
    if (match) kept.push(match);
  }
  sx.opinionCards = kept;
  if (typeof sx.iraDiscountActive !== "boolean") sx.iraDiscountActive = false;
  if (!sx.dahliaTokenChoice || typeof sx.dahliaTokenChoice !== "object") {
    const choice: Record<string, string> = {};
    if (kept.some((c) => c.characterId === "dahlia" && c.level === "ally")) {
      for (const h of Object.keys((sx.loadouts ?? {}) as object)) choice[h] = "reroll";
    }
    sx.dahliaTokenChoice = choice;
  }
  s.version = 62;
  return s;
}

/**
 * v62 -> v63 (Chapter 4): `townVisit4Completed`, `assaultBonuses`, and the
 * Omen / Rebirth / combat-only encounter fields.
 */
export function migrateV62ToV63(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (typeof sx.townVisit4Completed !== "boolean") sx.townVisit4Completed = false;
  if (!Array.isArray(sx.assaultBonuses)) sx.assaultBonuses = [];
  if (!sx.storyCounters || typeof sx.storyCounters !== "object") sx.storyCounters = {};
  if (!Array.isArray(sx.scavengeShopProducts)) sx.scavengeShopProducts = [];
  if (typeof sx.witnessAbilityUsed !== "boolean") sx.witnessAbilityUsed = false;
  const enc = sx.encounter as Record<string, unknown> | null | undefined;
  if (enc && typeof enc === "object") {
    if (!enc.omenTokens || typeof enc.omenTokens !== "object") enc.omenTokens = {};
    if (!Array.isArray(enc.rebirthTiles)) enc.rebirthTiles = [];
    if (typeof enc.enemyDiedThisHeroTurn !== "boolean") enc.enemyDiedThisHeroTurn = false;
    if (!Array.isArray(enc.combatOnlyTokens)) enc.combatOnlyTokens = [];
    if (enc.stolenWeapon === undefined) enc.stolenWeapon = null;
    if (!Array.isArray(enc.ritualSacrifices)) enc.ritualSacrifices = [];
    if (!Array.isArray(enc.pendingRitualPicks)) enc.pendingRitualPicks = [];
    if (enc.corruption === undefined) enc.corruption = null;
  }
  s.version = 63;
  return s;
}

/**
 * v63 -> v64: `lastQuestDeaths` (who died on the last quest). Old saves
 * get `null` = unknown, so the Town Visit death pages ask as before.
 */
export function migrateV63ToV64(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const sx = s as unknown as Record<string, unknown>;
  if (sx.lastQuestDeaths === undefined) sx.lastQuestDeaths = null;
  s.version = 64;
  return s;
}

/**
 * v64 -> v65: the wave has 3 phases (Delver, Parting Shots, End Wave);
 * the Interlude Phase is gone (designer decision 2026-11-17).
 *   - An encounter saved in the old `"interlude"` phase is parked on
 *     `"parting-shots"` with the cursor past the last enemy, so the
 *     Parting Shots screen's Continue enters End Wave. If the old
 *     Interlude had already refreshed weapons / consumables and paid
 *     Harvester, that is recorded as `endWaveRefresh` so End Wave
 *     doesn't do it (or pay Harvester) a second time.
 *   - `interludeApplied` / `interludeResult` are dropped.
 *   - Element picks queued by the old Interlude are dropped: they were
 *     the old timing of Elemental OS, which now queues on the next
 *     wave's board instead.
 */
export function migrateV64ToV65(parsed: unknown): CampaignState | null {
  const s = parsed as CampaignState;
  if (!s || typeof s !== "object") return null;
  const enc = s.encounter as unknown as Record<string, unknown> | null;
  if (enc && typeof enc === "object") {
    const old = enc.interludeResult as
      | { weaponsRefreshed: Array<{ heroId: string; count: number }>; consumableTokensRefreshed: number }
      | null
      | undefined;
    if (enc.phase === "interlude") {
      enc.phase = "parting-shots";
      enc.partingShotCursor = (enc.enemies as unknown[]).length;
      enc.endWaveRefresh = enc.interludeApplied === true && old
        ? { weaponsRefreshed: old.weaponsRefreshed, consumableTokensRefreshed: old.consumableTokensRefreshed, harvesterGrants: [] }
        : null;
    } else if (enc.endWaveRefresh === undefined) {
      enc.endWaveRefresh = null;
    }
    delete enc.interludeApplied;
    delete enc.interludeResult;
    const picks = enc.pendingElementChoices as Array<{ source: { kind: string } }> | undefined;
    if (Array.isArray(picks)) {
      enc.pendingElementChoices = picks.filter((c) => c.source.kind !== "interlude");
    }
  }
  s.version = 65;
  return s;
}

/** Start the death record for `questId` (called when its first wave is
 *  built fresh). Keeps an open record for the same quest so a wave retry
 *  doesn't forget a death that already happened. */
export function beginQuestDeathRecord(state: CampaignState, questId: string): void {
  const rec = state.lastQuestDeaths;
  if (rec && rec.questId === questId && !rec.ended) return;
  state.lastQuestDeaths = { questId, heroIds: [], ended: false };
}

/** Record every delver at 0 HP as having died on `questId`. */
export function recordQuestDeaths(state: CampaignState, questId: string): void {
  if (!state.lastQuestDeaths || state.lastQuestDeaths.questId !== questId || state.lastQuestDeaths.ended) {
    state.lastQuestDeaths = { questId, heroIds: [], ended: false };
  }
  const rec = state.lastQuestDeaths;
  for (const [heroId, lo] of Object.entries(state.loadouts)) {
    if (lo.currentHp <= 0 && !rec.heroIds.includes(heroId)) rec.heroIds.push(heroId);
  }
}

/** Printed boss-part levels (Lvl 1 Soulhunter ... Lvl 5 Timber Fiend). */
export type BossPartLevel = 1 | 2 | 3 | 4 | 5;
export const BOSS_PART_LEVELS: readonly BossPartLevel[] = [1, 2, 3, 4, 5];

/** The per-delver wallet for one boss-part level. Lvl 1 is the original
 *  `bossParts` field; the others are `bossPartsLvlN`. */
export function bossWallet(state: CampaignState, level: BossPartLevel): Record<string, number> {
  switch (level) {
    case 1: return state.bossParts;
    case 2: return state.bossPartsLvl2;
    case 3: return state.bossPartsLvl3;
    case 4: return state.bossPartsLvl4;
    case 5: return state.bossPartsLvl5;
  }
}

/**
 * Printed level of a boss-part drop id: `"boss-part-lvl-<N>"` → N
 * (1..5); the bare legacy `"boss-part"` id counts as 1. Throws on a
 * level outside 1..5. Single source of truth for wallet routing — see
 * {@link creditBossPartDrop}.
 */
export function bossPartLevelForDropId(dropId: string): BossPartLevel {
  if (dropId === "boss-part") return 1;
  const m = /^boss-part-lvl-(\d+)$/.exec(dropId);
  if (!m) throw new Error(`bossPartLevelForDropId: not a boss part drop: ${dropId}`);
  const n = Number(m[1]);
  if (n < 1 || n > 5) throw new Error(`bossPartLevelForDropId: unsupported level ${n}`);
  return n as BossPartLevel;
}

/**
 * Credit ONE boss part of the drop's printed level to `heroId`'s
 * matching wallet. The single routing point for every pickup path
 * (movement, Witness, creature-part slot ability, debug win-wave) —
 * fixes the pre-v58 bug where every boss part landed on the flat
 * lvl-1 counter and lvl-2 shop costs could never be paid.
 */
export function creditBossPartDrop(
  state: CampaignState,
  heroId: string,
  dropId: string,
): void {
  const wallet = bossWallet(state, bossPartLevelForDropId(dropId));
  wallet[heroId] = (wallet[heroId] ?? 0) + 1;
}

/**
 * Total boss parts across every level for one delver. Display-only
 * helper (topbar pill, Campaign Sheet total) — spends must target a
 * specific level's wallet.
 */
export function totalBossParts(state: CampaignState, heroId: string): number {
  return BOSS_PART_LEVELS.reduce((sum, lvl) => sum + (bossWallet(state, lvl)[heroId] ?? 0), 0);
}

export function saveCampaign(state: CampaignState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function clearCampaign(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Parse a raw JSON string (e.g. from a downloaded save file) and
 * run it through the full migration chain, returning a ready-to-use
 * `CampaignState`. Throws if the string is not valid JSON. Returns
 * `null` if the version is unrecognisable (too old / corrupt) and
 * the migration chain would have produced a fresh campaign.
 *
 * Restores the original localStorage entry in all cases so the
 * caller decides whether to commit the result.
 */
export function loadCampaignFromJson(rawJson: string): CampaignState | null {
  const previous = localStorage.getItem(STORAGE_KEY);
  try {
    const probe = JSON.parse(rawJson) as unknown;
    if (!probe || typeof probe !== "object") return null;
    const inputVersion = (probe as Record<string, unknown>).version;
    localStorage.setItem(STORAGE_KEY, rawJson);
    const result = loadCampaign();
    // If the migration chain bailed and returned a fresh campaign,
    // the version would have been coerced to SCHEMA_VERSION — detect
    // this by checking that the input version was recognisable.
    if (typeof inputVersion !== "number") return null;
    return result;
  } finally {
    if (previous !== null) {
      localStorage.setItem(STORAGE_KEY, previous);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }
}
