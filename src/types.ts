/**
 * Shared types for Gone to Gaia Quest #1 prototype.
 *
 * These types define the shape of every JSON file under `data/` and are the
 * canonical contract for both data extraction and gameplay code.
 *
 * Keep this file authoritative. If a JSON file disagrees, fix the JSON.
 */

// --- Suits / elements -----------------------------------------------------

export type Suit = "mind" | "body";

/**
 * Six element types per the rulebook page 17.
 * Slot-icon mapping pending visual confirmation; defaulting to a guess.
 */
export type Element = "earth" | "wind" | "fire" | "water" | "void" | "radiance";

// --- Damage / range -------------------------------------------------------

export type DamageType = "light" | "medium" | "heavy";

/** Offset in board cells from an origin (delver or enemy). */
export interface Offset {
  dx: number;
  dy: number;
}

/**
 * Tagged union describing how a weapon's range is computed.
 * Adding a new range type means: add a new variant here, handle it in the
 * combat resolver, and add a renderer for it in the Equipment card UI.
 */
export type WeaponRange =
  | { kind: "single-adjacent" }
  | { kind: "fixed-pattern"; tiles: Offset[] }
  | { kind: "die-roll-fixed"; rolls: Array<{ min: number; max: number; tiles: Offset[] }> }
  | { kind: "straight-line"; includeDiagonals: boolean; firstTargetOnly: boolean }
  /**
   * Chain damage. Player picks one starting enemy tile; the BFS includes all
   * 8-way connected enemies. The precondition for the chain to be valid:
   *   - "self":  the ATTACKER must be 8-way-adjacent to at least one enemy
   *              in the chain. (Suit A — Chain Gauntlet)
   *   - "other": the OTHER delver must be 8-way-adjacent to at least one
   *              enemy in the chain. (Suit B — Surge Claw)
   */
  | { kind: "chain"; requiresAdjacentTo: "self" | "other" }
  /** Fabled Hammer: every enemy on the tiles strictly between the two
   *  delvers. Only usable when the delvers are in a straight line
   *  (row, column or diagonal) to each other. */
  | { kind: "between-delvers" }
  /** Precise Shockwave: "targets of your choice within N tiles" - the
   *  player picks any number of enemies within N tiles (8-way steps). */
  | { kind: "choose-targets"; maxDistance: number };

// --- Equipment ------------------------------------------------------------

export type EquipmentCategory = "weapon" | "passive";

/**
 * Hard ceiling on equipment rank (rulebook prints R1..R5 only).
 * Lives in `types.ts` so `state.ts > getEffectiveEquipmentRank`
 * can clamp without an upward dependency on `engine/levelUp.ts`.
 * Re-exported from `engine/levelUp.ts` for back-compat with the
 * pre-Opinion-Card import paths.
 */
export const EQUIPMENT_RANK_CAP = 5;

export type EquipmentType =
  | "Gauntlet" | "Hammer" | "Beam" | "Boots" | "Shield" | "OS"
  | "Trident" | "Sword" | "Mace" | "Armor" | "Harvester" | "Battery"
  | "Shockwave" | "Supercharger";

/**
 * The 14 base equipment types in print-deck order. Used by the
 * level-up flow + UI tabs so iteration order is stable.
 */
export const ALL_EQUIPMENT_TYPES: readonly EquipmentType[] = [
  "Gauntlet", "Hammer", "Beam", "Trident", "Sword", "Mace",
  "Shockwave", "OS", "Shield", "Boots", "Supercharger", "Armor",
  "Harvester", "Battery",
] as const;

/**
 * Subset of `ALL_EQUIPMENT_TYPES` whose `EquipmentCard.category` is
 * `"passive"` in both suits (Mind + Body always agree on category
 * per `data/equipment.json`). Source of truth for the "any PASSIVE
 * equipment" alternative on Ultra Level Up cards (see
 * `LevelUpDeckCard.isUltra` jsdoc + `engine/levelUp.ts >
 * applyLevelUpChoice`).
 *
 * Kept in `types.ts` (not derived at runtime from the equipment
 * catalogue) so the Ultra-pick UI in `screens/LevelUpModal.ts`
 * doesn't need to inspect both suits' R1 cards just to enumerate
 * the choice list — and the order matches the print-deck order
 * inside the wider `ALL_EQUIPMENT_TYPES` list.
 */
export const PASSIVE_EQUIPMENT_TYPES: readonly EquipmentType[] = [
  "OS", "Shield", "Boots", "Supercharger", "Armor", "Harvester", "Battery",
] as const;

/**
 * The 5 physical suit parts as defined on the printed Suit Condition Sheet.
 * Each part is associated with 2-3 equipment types.
 */
export type SuitPart = "left-arm" | "right-arm" | "body" | "legs" | "helmet";

/**
 * Maps each suit part to the equipment types that belong to it,
 * broken out per suit because Left Arm and Right Arm differ between
 * Mind and Body (the other three parts are identical for both suits).
 *
 * Source: Suit Condition Sheet 8.5x11 v1 PROOF 2.
 *
 * Mind:
 *   Left Arm  → Sword, Mace, Shield
 *   Right Arm → Gauntlet, Hammer, Trident
 *   Body      → Armor, Supercharger, Battery
 *   Legs      → Harvester, Shockwave, Boots
 *   Helmet    → OS, Beam
 *
 * Body:
 *   Left Arm  → Gauntlet, Hammer, Trident
 *   Right Arm → Sword, Mace, Shield
 *   Body      → Armor, Supercharger, Battery
 *   Legs      → Harvester, Shockwave, Boots
 *   Helmet    → OS, Beam
 */
export const SUIT_PART_EQUIPMENT_TYPES_BY_SUIT: Readonly<Record<"mind" | "body", Readonly<Record<SuitPart, readonly EquipmentType[]>>>> = {
  mind: {
    "left-arm":  ["Sword", "Mace", "Shield"],
    "right-arm": ["Gauntlet", "Hammer", "Trident"],
    "body":      ["Armor", "Supercharger", "Battery"],
    "legs":      ["Harvester", "Shockwave", "Boots"],
    "helmet":    ["OS", "Beam"],
  },
  body: {
    "left-arm":  ["Gauntlet", "Hammer", "Trident"],
    "right-arm": ["Sword", "Mace", "Shield"],
    "body":      ["Armor", "Supercharger", "Battery"],
    "legs":      ["Harvester", "Shockwave", "Boots"],
    "helmet":    ["OS", "Beam"],
  },
} as const;

/** Human-readable display label for each suit part. */
export const SUIT_PART_LABEL: Readonly<Record<SuitPart, string>> = {
  "left-arm":  "Left Arm",
  "right-arm": "Right Arm",
  "body":      "Body",
  "legs":      "Legs",
  "helmet":    "Helmet",
} as const;

/** True iff `type` is in `PASSIVE_EQUIPMENT_TYPES`. Both suits
 * agree on this categorisation per `data/equipment.json`. */
export function isPassiveEquipmentType(type: EquipmentType): boolean {
  return (PASSIVE_EQUIPMENT_TYPES as readonly EquipmentType[]).includes(type);
}

/**
 * Static description of a Level Up Card from `data/levelDeck.json`.
 *
 * Two card subtypes (see PDF `Level Up Cards Front v2 PROOF 1.pdf`):
 *
 *   - BASE level cards (`isUltra` omitted/false, today cards 1..28):
 *     "Gain +1 RANK in one of the following: [3 equipment types]".
 *     `types.length === 3`.
 *
 *   - ULTRA level cards (`isUltra: true`, today cards 29..32):
 *     "Gain +1 RANK for any PASSIVE equipment, OR
 *      Gain +2 RANKS in one of the following: [2 equipment types]".
 *     `types.length === 2`. The Ultra path opens up more choices
 *     (the 2 listed types at +2 PLUS any of the 7 passive types at
 *     +1) so the player can either deepen a weapon or broaden their
 *     passive lineup — see `engine/levelUp.ts > applyLevelUpChoice`
 *     for the rank-delta resolution and `screens/LevelUpModal.ts`
 *     for the choice-rendering split.
 */
export interface LevelUpDeckCard {
  /** Card number printed on the card (1..32). */
  cardNumber: number;
  /** Path inside `public/levelup/` to the rendered card image. */
  image: string;
  /** Equipment-type choices printed on this card. Base cards print
   * 3 types (any of them = +1 RANK). Ultra cards print 2 types (any
   * of them = +2 RANKS); the additional "+1 RANK for any PASSIVE"
   * option isn't part of this list — it's derived at modal time
   * from the equipment catalogue. */
  types: EquipmentType[];
  /** True for the Ultra Level Up cards (today 29..32). Drives
   * (a) exclusion from the default per-encounter deck (Ultras are
   * NOT shuffled in by default — players acquire them as rewards,
   * see `state.ultraLevelCardsOwned`), and
   * (b) the +2 rank delta on the printed-type pick + the "any
   * passive at +1" alternative inside the LevelUpModal. Omit (or
   * false) for base cards. */
  isUltra?: boolean;
}

export interface EquipmentCard {
  id: string;
  type: EquipmentType;
  category: EquipmentCategory;
  rank: 1 | 2 | 3 | 4 | 5;
  suit: Suit;
  name: string;
  cardNumber: number;
  /** Path inside `public/cards/` to the rendered card image. */
  image: string;
  /** For weapons only. */
  damageType?: DamageType;
  /** For weapons only. e.g. 1, 2, 3 (multiplier on the damage value). */
  damageMultiplier?: number;
  /** Full printed ability text from the card. */
  abilityText: string;
  /** For weapons only. */
  range?: WeaponRange;
  /** Free-form structured effects the resolver knows how to apply. */
  effects?: EquipmentEffect[];
}

/**
 * Effects that go beyond raw damage. Each one is a small tagged record the
 * combat resolver pattern-matches on. Add new kinds as we encounter them.
 */
export type EquipmentEffect =
  | { kind: "collect-creature-part"; count: number; from: "any-tile" | "this-tile" }
  | { kind: "additional-damage-if-delvers-adjacent"; damageType: DamageType; multiplier: number }
  | { kind: "may-reroll-by-suffering"; suffer: number }
  | { kind: "set-max-hp"; value: number }
  | { kind: "modify-current-hp"; delta: number }
  | { kind: "heal-at-end-of-wave"; amount: number }
  /**
   * "IMMEDIATELY: Set your movement to 2." (Boots, both suits R1.)
   * Applied at gain-time by `applyImmediatePassiveEffects` and re-
   * applied on `resetWaveForRetry`. Implemented as `baseMovement =
   * max(baseMovement, value)` so it can only raise the floor — that
   * keeps it forward-safe if a future card grants higher movement.
   *
   * Per design decision: this persists for the rest of the QUEST.
   * Quest-end teardown (when implemented for multi-quest play)
   * should reset `baseMovement` to `Tuning.startingMovement` and
   * let the IMMEDIATELY effect re-apply during quest setup.
   */
  | { kind: "set-base-movement"; value: number }
  /**
   * "ONGOING: You may spend 1 ELEMENT to have delvers on your tile
   * block 1 damage from a single source, or block N if you spend a
   * {bonusElement}. Heal {healPerOverblock} HP for each overblocked
   * damage."
   *
   * Used by Sol Shield (Mind, bonusElement = "radiance") and Lunar
   * Shield (Body, bonusElement = "void"). The shield-bearer is the
   * delver who owns this card; activation can be offered any time
   * incoming damage is about to land on a delver standing on the
   * bearer's tile (rulebook + extracted card text). One activation
   * per shield, per damage event ("single source"), reducing each
   * tile-mate's incoming damage independently. Overblock heal goes
   * to the bearer only and is clamped at maxHp like every other heal.
   *
   * Engine wiring: see `engine/combat.ts > findShieldOpportunities`
   * + `applyCounterDamageWithShieldChoices`.
   */
  | {
      kind: "block-on-tile";
      baseBlock: number;
      bonusElement: Element;
      bonusBlock: number;
      healPerOverblock: number;
      /**
       * Earth's Embrace Shield (Equipment Upgrade #151-155): flat
       * "Additionally heal N HP if you spent: [bonusElement]" — a
       * per-activation heal to the bearer when the SPENT element is
       * the bonus element, replacing the Sol/Lunar overblock heal
       * (those cards set `healPerOverblock` and omit this field).
       */
      healOnBonusElementSpend?: number;
    }
  /**
   * Soulshift Sword: after each enemy this weapon kills, roll a d6 — on
   * a result in [rollMin..rollMax] the attack repeats once on a new
   * adjacent target (player's choice). May chain repeatedly while rolls
   * keep landing in range AND a new adjacent target exists.
   *
   * Engine wiring: see `engine/soulshift.ts` and DESIGN.md §5.4 for the
   * full pipeline. The chain is bounded only by adjacent live enemies
   * and the 4-6 roll probability.
   */
  | { kind: "repeat-on-kill"; rollMin: number; rollMax: number }
  /**
   * Providence OS (Mind R1): "ONGOING: Enemies that grant XP grant
   * 1 additional XP." On every enemy death whose printed `gainXp > 0`,
   * the shared XP pool is bumped by `amount` IFF at least one LIVING
   * delver owns a passive carrying this effect. The alive-only gate
   * is per design decision 2026-05-04 — a downed bearer can't run
   * their passive scan.
   *
   * Engine: see `engine/kills.ts > applyKill`. Only fires when XP
   * was already going to be granted; an `onDeath.gainXp` of 0 short-
   * circuits and no bonus is added (passive is conditional on the
   * underlying grant).
   */
  | { kind: "bonus-xp-on-kill"; amount: number }
  /**
   * Elemental OS (Body R1) IMMEDIATELY: "Gain 1 ELEMENT." Player
   * picks WHICH element. Fires only on first-time gain (R0 → R1) of
   * the bearing card; rank-ups don't re-trigger. The grant is
   * enqueued on `state.encounter.pendingElementChoices` so the UI
   * can prompt with a 6-element picker. Cap-overflow (delver already
   * has 2 of every element) silently discards per the standard
   * `grantElementToDelver` rules.
   *
   * Engine wiring: see `engine/levelUp.ts > applyLevelUpChoice` for
   * the enqueue point and `engine/os.ts > applyElementChoice` for the
   * resolve point. NOT wired through `applyImmediatePassiveEffects`
   * (that helper handles synchronous, idempotent effects only — this
   * one needs an async UI prompt and is one-shot, so re-applying it
   * on wave-retry would be a bug).
   */
  | { kind: "gain-element-on-acquire"; amount: number }
  /**
   * Elemental OS (Body R1) ONGOING: "Both delvers gain 1 ELEMENT
   * at the end of each wave." Fires once per wave transition, only
   * when the party continues to the next wave (the picks open on the
   * new wave's board). Each living delver gets one pending element-pick
   * prompt enqueued in hero order. Dead delvers are skipped per design
   * decision 2026-05-04.
   *
   *   `recipient: "all-delvers"`  → both delvers (Elemental OS)
   *   `recipient: "bearer"`        → bearer only (forward-compat for
   *                                  hypothetical R2-R5 variants)
   *
   * Engine wiring: see `engine/wave.ts > applyContinuingEndWaveEffects`.
   */
  | { kind: "gain-element-at-end-of-wave"; amount: number; recipient: "bearer" | "all-delvers" }
  /**
   * Trident (both suits R1) pre-attack effect: *"May move an adjacent
   * enemy 1 tile."* Optional, free, fires BEFORE damage resolves so the
   * moved enemy's new position is what gets hit by the printed
   * `fixed-pattern`. Adjacency is to the BEARER (8-way), matching the
   * Boots `move-adjacent-enemy` convention. Destination follows the
   * standard `legalMoveDestinationsForEnemy` rules (8-way, on-board,
   * not occupied by another enemy or a delver — the bearer's own tile
   * counts as occupied).
   *
   * `range: 1` is forward-compat for hypothetical R2-R5 variants that
   * might let the player push 2 tiles; today every printed Trident is
   * `range: 1`.
   *
   * Engine wiring: `engine/turn.ts > useWeaponAbility` accepts an
   * optional `preAttackMove: { enemyId, dest }` and applies it before
   * `computeWeaponHitTiles` runs.
   */
  | { kind: "pre-attack-may-move-adjacent"; range: number }
  /**
   * Trident (both suits R1) post-attack effect: *"Block 1 damage from
   * 1 counterattack."* Player picks ONE of the just-counterattacking
   * enemies after the counter roll and reduces its damage
   * contribution by `amount` (clamped at 0). The reduction applies
   * to every delver that enemy would hit — i.e., the chosen enemy's
   * effective `attack` for this counter is `max(0, attack - amount)`.
   *
   * `count: 1` means the player makes ONE such pick per swing
   * (matches the printed "1 counterattack"). `amount: 1` is the
   * damage reduction per pick.
   *
   * Free — no element / AP cost. Distinct from the Sol/Lunar Shield
   * `block-on-tile` effect which costs an element and is bearer-tile-
   * scoped; this one is per-swing and tied to the WEAPON card, not
   * the bearer's loadout.
   *
   * Engine wiring: extra param on
   * `applyCounterDamageWithShieldChoices` (per-counterattacker
   * reduction applied BEFORE shield activations so the shield's
   * overblock heals are computed against the post-block damage).
   */
  | { kind: "weapon-counter-block"; amount: number; count: number }
  /**
   * Shock Gauntlet (Equipment Upgrade #141-145): *"If you're at or
   * below 50% HP, deal additional Nx MEDIUM damage to that chain."*
   * Folded into the swing damage inside `engine/turn.ts >
   * useWeaponAbility` (mirrors `additional-damage-if-delvers-
   * adjacent`), gated on
   * `currentHp <= maxHp * thresholdPercent / 100`.
   */
  | { kind: "additional-damage-if-low-hp"; damageType: DamageType; multiplier: number; thresholdPercent: number }
  /**
   * Cyclone Boots (Equipment Upgrade #146-150): overrides the Boots
   * ONGOING — costs `cost` movement (standard Boots hard-code 2)
   * and unlocks BOTH modes regardless of suit (`canMove` = Strider-
   * style move, `canRotate` = Slip-Strider-style rotate). Read by
   * `engine/boots.ts` via the variant-aware card resolver.
   */
  | { kind: "boots-ongoing-override"; cost: number; canMove: boolean; canRotate: boolean }
  /**
   * IMMEDIATELY: Roll a die — generic die-roll-grants-tokens marker
   * for any R1+ passive that prints a *"Roll a die. 1-X: gain ...
   * 5-6: choice."* table. Fires only on first-time gain (R0 -> R1)
   * of the bearing card; rank-ups don't re-trigger.
   *
   * Today's bearers:
   *   - Supercharger (both suits R1) — Double Damage tokens.
   *   - Battery (both suits R1) — AP / Reroll / Block Counterattack.
   *
   * The PER-CARD outcome table lives in `engine/tokens.ts >
   * EQUIPMENT_ROLL_TABLES`, keyed by card id. This effect is JUST
   * the trigger flag — the roll is enqueued on
   * `state.encounter.pendingEquipmentRolls` so the UI can prompt
   * with a generic die-roll modal that looks up the table at modal
   * time. R2+ versions of these cards (and any future die-rolling
   * cards) just need an entry in the registry; no new effect kind
   * is required.
   *
   * Engine wiring: see `engine/levelUp.ts > applyLevelUpChoice` for
   * the enqueue point and `engine/tokens.ts > applyEquipmentRoll`
   * for the resolve point. NOT wired through
   * `applyImmediatePassiveEffects` (synchronous-only helper; this
   * one needs an async UI prompt and is one-shot).
   */
  | { kind: "immediately-equipment-roll" }
  /**
   * Harvester (both suits R1) ONGOING: *"You gain {amount} {token}
   * tokens at the end of each wave (taken from supply)."*
   *
   * Bearer-only by definition (the printed text says "YOU gain").
   * No `recipient` enum yet — extend the shape if a future card
   * grants to all delvers, mirroring the path
   * `gain-element-at-end-of-wave` took.
   *
   * `token` mirrors the slot ability `gain-token` discriminator
   * (`"creature-part"` → `state.minionParts[bearerId]`;
   *  `"boss-part"`     → `state.bossParts[bearerId]`). Both R1
   * Harvester cards print `"creature-part"` (a.k.a. MINION PART);
   * the discriminator gives forward-compat for hypothetical
   * Boss-Part Harvesters.
   *
   * Engine wiring: `engine/wave.ts > applyHarvesterGrants` (part of
   * the End Wave refresh, every wave end incl. defeat) walks every
   * owned passive (rank ≥ 1) on every LIVING delver and bumps the
   * appropriate per-delver counter. Dead delvers (currentHp ≤ 0)
   * are skipped per design decision 2026-05-04 — same convention
   * as `gain-element-at-end-of-wave`. No supply tracking (the
   * "from supply" parenthetical in the printed text is a tabletop
   * artefact; the prototype treats the supply as infinite).
   *
   * Idempotent at the call site: the End Wave refresh is latched by
   * `enc.endWaveRefresh`.
   */
  | {
      kind: "gain-tokens-at-end-of-wave";
      token: "creature-part" | "boss-part";
      amount: number;
      /** For `boss-part`: the boss-part level granted (New Harvester R1-R5
       *  prints Level 1-5). Absent = Level 1. */
      bossLevel?: 1 | 2 | 3 | 4 | 5;
    }
  /** Living Armor: "When you earn a Level card, delvers on your tile
   *  heal N HP." */
  | { kind: "heal-tile-on-level-card"; amount: number }
  /** Machinist upgrade weapons (Nov 15). Each "Spend N [element]: X"
   *  is an option the player picks before the swing (`spends`). */
  /** Engulfing Beam: "Spend 1 Fire: Nx LIGHT damage to all enemies." */
  | { kind: "spend-element-damage-all-enemies"; element: Element; cost: number; damageType: DamageType; multiplier: number }
  /** Engulfing Beam: "Spend 1 Fire: Block counterattacks." */
  | { kind: "spend-element-block-counterattacks"; element: Element; cost: number }
  /** Precise Shockwave: "Spend 1 Radiance: Additional Nx HEAVY damage to
   *  1 adjacent target." */
  | { kind: "spend-element-extra-adjacent-damage"; element: Element; cost: number; damageType: DamageType; multiplier: number }
  /** Sword of Ruin: "Spend 2 Wind: Additional Nx HEAVY damage." */
  | { kind: "spend-element-bonus-damage"; element: Element; cost: number; damageType: DamageType; multiplier: number }
  /** Lunar Trident: "Spend 2 Void: roll a die and multiply damage by the result." */
  | { kind: "spend-element-die-multiplier"; element: Element; cost: number }
  /** Sword of Ruin: "If target dies, gain 1 Wind." */
  | { kind: "gain-element-on-kill"; element: Element; amount: number }
  /** War Mace: the printed damage is for a boss; "If a minion, deal Nx
   *  LIGHT damage and gain 1 element" (of the bearer's choice). */
  | { kind: "minion-damage-override"; damageType: DamageType; multiplier: number; gainElementChoice: number }
  /** Overcharger ONGOING: "You may spend 2 [element] to increase your
   *  base LIGHT, MEDIUM or HEAVY damage" — each spend is +1 to one
   *  damage type's base for this delver, for the rest of the quest. */
  | { kind: "overcharge-damage"; element: Element; cost: number }
  /**
   * Mace (both suits R1) targeting filter + element-spend bypass:
   *   *"HEAVY damage to an adjacent {filter} enemy. OR Spend an
   *    element to deal HEAVY to an adjacent enemy."*
   *
   *   - `filter: "undamaged"` (Mind R1): default mode requires the
   *     adjacent target to have `damageTaken === 0`.
   *   - `filter: "damaged"` (Body R1): default mode requires the
   *     adjacent target to have `damageTaken > 0`.
   *
   * The OR-mode lets the player spend ANY one element from their
   * bag (player-pick across element kinds) to bypass the filter and
   * hit ANY 8-way adjacent live enemy. Damage is identical in both
   * modes (per the printed text — only targeting changes).
   *
   * Engine wiring: `engine/turn.ts > useWeaponAbility` accepts
   * `WeaponAbilityParams.spendElementForTargetBypass` on the
   * `single-adjacent` variant. When unset, the engine enforces the
   * filter against the target enemy's `damageTaken`. When set, the
   * engine debits 1 of the named element from the bearer's bag and
   * skips the filter check. Records a
   * `target-bypass-spend-element` PreEffect on the session for the
   * audit trail.
   *
   * UI wiring: see `screens/ActionResolution.ts >
   * renderMaceModePickModal` + `renderMaceElementPickModal`. The
   * mode-pick modal opens when the player picks "Use weapon
   * ability" on a Mace AND both modes are viable; auto-skips
   * straight to default arming when no element / no spend candidate,
   * and straight to spend arming (with auto-pick of the only
   * element kind, or the element-pick modal when multiple kinds
   * are available) when no filter-matching adjacent enemy exists.
   * If neither mode is viable the click is a no-op (the player
   * sees the action menu close without arming and can re-pick).
   */
  | { kind: "target-filter-or-spend-element"; filter: "undamaged" | "damaged" }
  /**
   * Scorchline Beam (Suit A, R2-R5) — *"Repeat {count} times.
   * (Can be a different straight line.)"*
   *
   * After the printed `straight-line` swing's attack session
   * finalises (damage, counter-roll, kills + level-ups all
   * resolved), the bearer gets `count` additional FREE swings of
   * the same weapon. Each repeat:
   *   - is its own self-contained {@link AttackSession} — damage →
   *     shared counter-roll prompt → finalize. The pipeline mirrors
   *     Soulshift Sword's `repeat-on-kill` chain (per-link counter
   *     timing).
   *   - lets the player pick a NEW straight-line target (any of the
   *     8 ray directions, including diagonals — same picker as the
   *     R1 swing). Direction choices across repeats are independent.
   *   - is FREE — no AP, no element token, no movement, no fresh
   *     action gate. Routes through
   *     `useWeaponAbility(..., { freeRepeat: true })` (see
   *     `engine/turn.ts > UseWeaponAbilityOptions`).
   *   - is OPTIONAL — the player can skip remaining repeats at any
   *     prompt (e.g. when the board has no live enemies left or
   *     they want to bank counter-attack risk). Skipping clears the
   *     pending counter for the rest of the turn.
   *   - DOES re-trigger counter-attacks. Each repeat fires the
   *     counter-roll modal independently; a repeat that lands on a
   *     target with a `rotates` ability re-evaluates the counter
   *     pattern against the new facing.
   *
   * Death short-circuit: if a counter-blow flips the encounter into
   * `end-of-wave` mid-chain, `attackSessionTriggersBeamRepeat`
   * returns false and the queue is suppressed (matches the
   * Soulshift convention).
   *
   * Today's bearers:
   *   - Scorchline Beam R2 (count: 1) -> 2 total swings
   *   - Scorchline Beam R3 (count: 2) -> 3 total swings
   *   - Scorchline Beam R4 (count: 3) -> 4 total swings
   *   - Scorchline Beam R5 (count: 4) -> 5 total swings
   *
   * Suit B's Ion Cannon Beam scales by damage instead and does NOT
   * carry this effect — only Suit A repeats. (Audit confirmation
   * 2026-05-24.)
   *
   * Engine wiring: `engine/turn.ts > useWeaponAbility` reads the
   * effect on the FIRST (non-freeRepeat) straight-line swing and
   * seeds `state.encounter.beamRepeatsRemaining[heroId]` with
   * `count`; each subsequent freeRepeat decrements that counter.
   * `screens/ActionResolution.ts > advanceAfterAction` checks the
   * counter post-finalise and opens the `beam-repeat-prompt` modal
   * while it's > 0.
   */
  | { kind: "repeat-attack"; count: number };

// --- Enemies --------------------------------------------------------------

/** `lieutenant`: Lieutenant - Lvl N cards, placed by the Lieutenants Spawn
 *  Cards (#19-24) at the wave's level. Not a boss (no suit condition,
 *  no boss card back). */
export type EnemyKind = "minion" | "boss-lvl-1" | "boss-lvl-2" | "boss-lvl-3" | "boss-lvl-4" | "boss-lvl-5" | "lieutenant";

export interface EnemyOnDeath {
  /** Token IDs dropped on the enemy's tile (collected by walking onto it). */
  drops: string[];
  /** Static XP both delvers gain (in addition to anything from drops). */
  gainXp?: number;
  /**
   * Number of d6 to roll for XP — the printed "Gain 1 [die] XP"
   * reward (Ophidian 017, Sporecloud 022). Each die is rolled BY THE
   * PLAYER via the `xp-roll` modal (designer ruling 2026-07-20: the
   * roll must happen in front of the user, not silently). `applyKill`
   * enqueues one pending roll per die on `encounter.pendingXpRolls`;
   * `applyXpRoll` banks the rolled amount into the shared XP pool
   * and resolves any level-ups it triggers.
   */
  gainXpDice?: number;
  /** Element tokens both delvers immediately gain. */
  gainElements?: Element[];
  /** "Gain N elements" (Lieutenant B cards): each living delver picks N
   *  elements of their choice (queued on `pendingElementChoices`). */
  gainElementChoice?: number;
  /** "Gain a LEVEL UP card" (printed on every quest boss). Bumps the
   *  `levelUpCardsOwed` bookkeeping counter AND enqueues one
   *  interactive LevelUpModal draw per delver per card — see
   *  `engine/kills.ts > applyKill` step 4. (Pre-2026-07-20 this was
   *  bookkeeping-only and the printed reward was silently lost.) */
  gainLevelUpCards?: number;
}

export interface EnemyCard {
  id: string;
  kind: EnemyKind;
  family: string;
  cardNumber: number;
  name: string;
  hp: number;
  attack: number;
  /** Path inside `public/cards/` to the rendered card image. */
  image: string;
  /** Free-form printed ability text from the card (often empty). */
  abilityText: string;
  /** Free-form printed parting-shot text (kept verbatim for the UI). */
  partingShotText: string;
  /**
   * Structured form of the printed parting-shot text. See
   * {@link PartingShot} for the supported patterns. Resolved by
   * `engine/wave.ts > resolveNextPartingShot` during the Parting
   * Shots Phase.
   */
  partingShot: PartingShot;
  /**
   * Passive abilities printed on the card under the art (Fatal
   * Flaw, Rotates, Primordial, Teleports — see {@link EnemyAbility}).
   * Defaults to `[]` for cards with no printed ability text
   * (Crystanid / Soulhunter for Q1). Engine consumers should
   * iterate with `for (const ab of card.abilities) switch (ab.kind)`
   * so adding a new ability variant is a compile-time fan-out.
   */
  abilities: EnemyAbility[];
  /** Tiles hit by Common counter (rolled 2-5). Offsets from this enemy. */
  counterCommon: Offset[];
  /** Tiles hit by Uncommon counter (rolled 6). Offsets from this enemy. */
  counterUncommon: Offset[];
  onDeath: EnemyOnDeath;
  /**
   * Second card of a 2-card boss (Ch3 Oblivionwing 2/2): the id of the
   * boss's first card. Spawned east of it, it shares the first card's HP
   * (damage to it lands on the first card), counterattacks with its own
   * arrows whenever the boss does, has no parting shot or rewards, and
   * is removed when the boss dies.
   */
  partOf?: string;
}

/**
 * Structured form of a printed Parting Shot ability.
 *
 * Per rulebook p26: *"Unless an ability states otherwise, a Parting
 * Shot Ability affects both Delvers regardless of their position."*
 * That default is encoded here as `"all-delvers"` rather than a
 * positional rule.
 *
 * The four printed Q1 patterns map to the union as:
 *   - `"1 Damage."`                                   → `{ kind: "all-delvers", damage: 1 }`
 *   - `"2 Damage."` (Soulhunter)                       → `{ kind: "all-delvers", damage: 2 }`
 *   - `"2 Damage to nearest Delver."`                  → `{ kind: "nearest-delver", damage: 2 }`
 *   - `"2 Damage to any Delver within 2 tiles."`       → `{ kind: "delvers-within", damage: 2, range: 2 }`
 *
 * Range is Chebyshev (8-way), matching every other range rule in
 * this prototype (DESIGN.md §5.3).
 */
/**
 * Structured form of the printed parting-shot text. Each variant
 * maps cleanly to a single printed pattern observed on the enemy
 * card front:
 *
 *   "1 Damage."                                  → all-delvers
 *   "2 Damage to nearest Delver."                → nearest-delver
 *   "2 Damage to any Delver within 2 tiles."     → delvers-within
 *   "Lose 2 XP on hand."                         → all-delvers-lose-xp
 *   "Lose ALL Elements."                         → all-delvers-lose-elements
 *   "2 Damage & lose ALL XP on hand."            → all-delvers-damage-and-lose-xp
 *   "3 Damage & lose ALL Elements."              → all-delvers-damage-and-lose-elements
 *
 * The XP/element variants take an `amount` of `"all"` or a
 * positive number — keeps the JSON ergonomic without forcing
 * sentinel values like `999`. When the engine sees `"all"` it
 * floors the affected pool to 0; numeric amounts subtract and
 * clamp at 0 (you can't go negative on either resource).
 *
 * Q2 Wave 1 introduces the lose-xp / lose-elements / damage+xp combo
 * variants for the first time (Venena 011, 012 + Goldmonger).
 * Q2 Wave 2 adds the damage+elements combo for Hundredeyes
 * ("3 Damage & lose ALL Elements"). Q1 enemies only use the
 * three damage-only variants.
 */
export type PartingShot =
  | { kind: "all-delvers"; damage: number }
  | { kind: "nearest-delver"; damage: number }
  | { kind: "delvers-within"; damage: number; range: number }
  | { kind: "all-delvers-lose-xp"; amount: number | "all" }
  | { kind: "all-delvers-lose-elements"; amount: number | "all" }
  | { kind: "all-delvers-damage-and-lose-xp"; damage: number; amount: number | "all" }
  | { kind: "all-delvers-damage-and-lose-elements"; damage: number; amount: number | "all" }
  /**
   * Q2 W3 (Death Cap) — every delver takes `damage` AND auto-
   * discards `count` consumable token(s) from their bag. Discard
   * picks the SHALLOWEST stack first to minimise the dial-back on
   * the player's strongest stockpile (rulebook p20 leaves the
   * choice to the player; the digital prototype auto-picks to keep
   * the EOW flow modal-free).
   */
  | { kind: "all-delvers-damage-and-discard-consumable"; damage: number; count: number };

/**
 * Persistent ability printed on the enemy card front under the
 * art (e.g. "Fatal Flaw: 1", "Rotates", "Primordial",
 * "Teleports"). Distinct from {@link PartingShot} — abilities are
 * passive engine-enforced rules that apply across the wave,
 * whereas parting shots only fire when the enemy dies.
 *
 * Authored as a tagged union so the engine can fan out via a
 * `switch (ab.kind)` exhaustiveness check. Q2 ships the four
 * abilities the printed cards call out; future quests add new
 * variants at the bottom.
 *
 *   `fatal-flaw`  — Q2 W1+: enemies in the same `level` form a
 *                   "tier"; tier N enemies CAN'T be reduced below
 *                   1 HP while any tier-(N-1)-or-lower enemy is
 *                   still alive (rulebook p16). Sequential
 *                   numbers can die in the same turn — N and N+1
 *                   aren't gated against each other.
 *   `rotates`     — Q2 W2+: after THIS enemy's counterattack
 *                   pass, rotate `enemy.facing` 90° clockwise.
 *                   `counterCommon` / `counterUncommon` offsets
 *                   are then re-evaluated against the new facing.
 *   `primordial`  — Q2 W3+: damage to this enemy is only applied
 *                   when the source weapon is exhausted into a
 *                   weapon slot bound to one of `elements`. The
 *                   slot does NOT need to carry an element token
 *                   at swing time (rulebook p20) — only the slot
 *                   identity matters.
 *   `teleports`   — Q2 W3 (Death Cap): after this boss's
 *                   counterattack pass, swap its tile with the
 *                   nearest LIVING minion. Ties are player choice.
 */
export type EnemyAbility =
  | { kind: "fatal-flaw"; level: number }
  | { kind: "rotates" }
  | { kind: "primordial"; elements: Element[] }
  | { kind: "teleports" }
  /** Ch3 Joyce the Bear: "Each time the enemy counterattacks, afterwards
   *  add a monster token to its tile. Add its count of monster tokens to
   *  its damage." Tracked as `EnemyInstance.strengthTokens`. */
  | { kind: "strength" }
  /** Ch3 Gerald the Snake: "This boss cannot suffer more than N damage
   *  from a single attack" (printed N = 8). */
  | { kind: "stout"; maxDamage: number }
  /** Ch3 Tidal Cerberus / Fleetfoot: "After attempting to counterattack,
   *  if the enemy isn't dead, they move 2 tiles away from the attacking
   *  delver if possible." Resolved automatically (farthest free tile). */
  | { kind: "flees" }
  /** Ch3 Carnatia: "This boss kills both delvers if not defeated by the
   *  end of the wave." */
  | { kind: "soothsayer" }
  /** Ch3 Carnatia / Colibrius: "When damaged, afterwards it and all
   *  enemies connected to it in a chain deal a counterattack." */
  | { kind: "synchronized" }
  /** Ch3 Empress Ash: "When the counterattack die is rolled, on a roll of
   *  1 it counterattacks with both white and black arrows" (common +
   *  uncommon patterns) instead of missing. */
  | { kind: "all-claw" }
  /** Ch3 Empress Ash / Tidegazer: "When this enemy dies, it heals all
   *  damage on all adjacent enemies, unless they also just died." */
  | { kind: "death-heal" }
  /** Ch3 Abomination / Blackguard: "immune to one damage type: light,
   *  medium or heavy damage, as specified on their card". */
  | { kind: "immunity"; damageType: DamageType }
  /** Ch3 Golem / Orite: "On spawn, these enemies start with the specified
   *  number of monster tokens. They suffer no damage while they have any
   *  monster tokens. Each attack removes 1 monster token." Tracked as
   *  `EnemyInstance.guardTokens`. */
  | { kind: "guards"; tokens: number }
  /** Ch3 Timber Fiend / Sapling: "damage from delver attacks rounds down
   *  to the nearest 5". */
  | { kind: "tough" }
  /** Ch3 Golem: "After attempting to counterattack, this boss applies a
   *  monster token to the attacking delver's board. If a delver with that
   *  token attacks this boss, its counterattack always hits." Tracked as
   *  `EncounterState.accurateMarks[bossInstanceId] = heroId`. */
  | { kind: "accurate" }
  /** Ch3 Timber Fiend / Sapling: every attack on one adds a token to a
   *  shared countdown pile; at 4+ the pile resets and every Countdown
   *  enemy also counterattacks (`EncounterState.countdownTokens`). */
  | { kind: "countdown" }
  /** Ch3 Bob the Spider / Diamonid: "On spawn, starts with a monster
   *  token. Whenever an adjacent delver suffers damage, remove it. While
   *  it has a monster token, attacks deal a maximum of 1 damage to it."
   *  Tracked as `EnemyInstance.viciousToken`. */
  | { kind: "vicious" }
  /** Ch3 Mindslayer / Squiddy: "After attempting to counterattack, rotate
   *  its card so the side with this icon is facing the attacking delver."
   *  The printed icon is on the card's north edge (facing 0). */
  | { kind: "alert" }
  /** Ch3 Oblivionwing: "When rolling a counterattack die, if you roll a
   *  5, the white arrows deal double damage." */
  | { kind: "critical" }
  /** Ch3 Oblivionwing / Nightswiper: "If this enemy is overkilled,
   *  afterwards all enemies with this ability attempt to counterattack." */
  | { kind: "frenzy" }
  /** Ch4 Mistspawn / Infestation: a delver damaged by it gains an Omen
   *  token; each token adds 1 to every later damage this wave
   *  (`EncounterState.omenTokens`, engine/omenRebirth.ts). */
  | { kind: "omen" }
  /** Ch4 Mistspawn / Infestation: on death, 3 tokens on its tile; after
   *  each hero turn with no kills, remove 1; at 0 it respawns with 50%
   *  health (`EncounterState.rebirthTiles`). */
  | { kind: "rebirth" }
  // Chapter 4 quests #4 / #7 / #13 (engine/questAbilities.ts; rule text
  // in EnemyAbilitiesModal.ts).
  | { kind: "backup" }
  | { kind: "evasive" }
  | { kind: "hardy" }
  | { kind: "steals" }
  | { kind: "spiked" }
  | { kind: "invulnerable" }
  | { kind: "last-act" }
  | { kind: "ritual" }
  | { kind: "double-edged" }
  | { kind: "soul-sap" }
  | { kind: "brawler" }
  | { kind: "corruption" }
  | { kind: "shell" }
  /** Lieutenants: "After attempting to counterattack, it moves one tile
   *  closer to its assailant. If it can't move closer, it rotates so that
   *  one of its blue arrows is targeting the attacking hero." Players
   *  decide ties; the prototype picks the first option in board order. */
  | { kind: "aggressive" };

// --- Heroes ---------------------------------------------------------------

export interface HeroCard {
  id: string;
  number: number;
  name: string;
  suit: Suit;
  /** Path inside `public/heroes/` to the rendered hero card image. */
  heroCardImage: string;
  startingEquipment: string[]; // EquipmentCard ids
}

// --- Spawn (shared by Quest 1 hard-coded layout + Spawn Deck cards) -------

export interface SpawnEntry {
  /** Position on the 5x5 grid. (0,0) = top-left (north-west). */
  x: number;
  y: number;
}

/**
 * One card in the Spawn Deck — a 5x5 grid of pre-printed marker
 * positions used to bootstrap a wave's board state when the quest
 * draws from the Spawn Deck instead of hand-authoring a layout.
 * Q1 still uses the hand-authored `Wave1Spawn` for narrative
 * reasons; Q2+ will pull a card via `drawSpawnCard` and read its
 * marker arrays.
 *
 * Card invariants (verified by the unit test in
 * `src/__tests__/spawnCards.test.ts`):
 *   - Always exactly 1 entry in `bosses` (the printed red X).
 *   - Always exactly 7 entries in `minions` (the printed white X-es).
 *   - Always exactly 2 entries in `delverSpawns` (the printed
 *     compass-star tiles — players pick which delver lands on
 *     which; both MAY end up on the same tile per the rulebook).
 *   - 0 or 1 entries in `memoryFragments` (the printed diamond
 *     glyph — a Memory Fragment token placed on the tile and
 *     collected by walking onto it, feeding the shared
 *     `state.memoryChips` pool).
 *   - No two markers share a coordinate.
 *
 * Orientation: cards are ALWAYS drawn as printed (NORTH = `y === 0`).
 * Rotation is intentionally out of scope today; if a future rule
 * needs it, store the rotation on the encounter's spawn-draw entry
 * rather than mutating these `(x, y)` positions in place.
 *
 * The printed deck has 14 cards (`XX/14` on each); the base game
 * ships only the 12 in this catalog. Numbers 13-14 are reserved
 * for future quest-specific cards (e.g. a Quest #2 unique spawn).
 */
export interface SpawnCard {
  /** Printed card number (1..14; only 1..12 ship in the base set today). */
  number: number;
  /** Path under `/public/spawn-cards/` (e.g. "spawn-card-01.png"). */
  image: string;
  bosses: SpawnEntry[];
  minions: SpawnEntry[];
  delverSpawns: SpawnEntry[];
  /** Memory Fragment token spawn(s). Empty when the card has no
   *  printed diamond glyph; one entry when it does. */
  memoryFragments: SpawnEntry[];
  /**
   * Friendly Encounter token spawn(s) — populated on Friendly
   * Spawn Cards (today: printed cards #13 and #14, shuffled into
   * the deck via the `grant-friendly-spawn-card` Town Visit
   * action). Optional + defaults to `[]` on every base spawn card
   * (#01..#12) so existing JSON entries don't need migration.
   * Each entry places one token on the board at wave bootstrap;
   * pickup is fired when a delver OR Witness steps onto the
   * tile (see `engine/movement.ts > collectFriendlyEncounters`
   * and `engine/witness.ts > stepWitness`).
   */
  friendlyEncounters?: SpawnEntry[];
  /** Lieutenant tiles - populated on the Lieutenants Spawn Cards (#19-24).
   *  Each places a Lieutenant matching the wave's boss level. */
  lieutenants?: SpawnEntry[];
}

// --- Quests ---------------------------------------------------------------

/**
 * How a wave's board state is populated when the encounter starts.
 *
 *   `hand-authored` — every position is baked into the JSON. Used
 *                     by Quest #1 (single narrative-driven layout)
 *                     and as a fallback for any future quest that
 *                     wants a fixed scripted board.
 *
 *   `spawn-deck`    — at wave start, the engine draws one card
 *                     from the named deck (`SPAWN_CARDS` for the
 *                     base set) and uses the card's printed
 *                     marker positions for the minion / boss /
 *                     delver-spawn / memory-fragment tiles. Used
 *                     by Quest #2+ per rulebook p21.
 *
 * Both variants carry `boardSize` so consumers that just need
 * the grid dimensions (movement, range checks, snapshotting)
 * don't have to narrow the discriminant. The variant-specific
 * fields (`delverStart` / `boss` / `minions` for hand-authored,
 * `deck` for spawn-deck) only need narrowing in encounter setup.
 */
export type QuestWaveSpawn =
  | {
      kind: "hand-authored";
      boardSize: { w: number; h: number };
      /** Both delvers spawn on this tile. */
      delverStart: SpawnEntry;
      /** Boss spawn position. */
      boss: SpawnEntry;
      /** Minion spawn positions. */
      minions: SpawnEntry[];
    }
  | {
      kind: "spawn-deck";
      boardSize: { w: number; h: number };
      /** Which deck to draw from. Only "base" ships today; quest-
       *  specific decks will add new ids when their cards arrive. */
      deck: "base";
    };

export interface QuestWave {
  /** 1-based wave number, matches the printed booklet. Required
   *  so `state.encounter.waveNumber` lines up with `quest.waves[i]`
   *  by content and not just index — easier debugging. */
  number: number;
  /** One-liner shown in the board topbar (e.g. "Reach the end of Wave 1"). */
  goal: string;
  spawn: QuestWaveSpawn;
  /** Boss enemy id placed at the wave's printed boss tile. */
  bossEnemyId: string;
  /** Pool of minion enemy ids the encounter builder shuffles +
   *  assigns to the 7 printed minion tiles. */
  minionEnemyIds: string[];
  endOfWave: {
    /** Page id (from `Quest.pages`) shown on both-survive. */
    bothSurvive: string;
    /** Page id shown when one or both delvers died. */
    anyDie: string;
  };
  /**
   * Scenario Card number to resolve at the START of this wave, if
   * any. Mirrors the printed storybook instruction "Resolve
   * Scenario Card #N" that appears at the top of Wave 2+ pages.
   *
   * When set, `bootstrapWaveAtNumber` populates
   * `state.currentScenarioCard` so the next render of BoardScreen
   * mounts `screens/ScenarioCardModal.ts` over the board. The
   * modal drains by setting `currentScenarioCard` back to `null`
   * and pushing the card number onto `state.scenarioCardsResolved`
   * (the printed "discard the card" step).
   *
   * Idempotent: if the wave's `scenarioCardOnStart` already lives
   * in `state.scenarioCardsResolved`, the trigger short-circuits
   * (a wave re-bootstrap from a debug command / save reload
   * doesn't re-prompt for a card the player already resolved).
   *
   * Per the rulebook, Wave 1 NEVER triggers a Scenario card — the
   * deck is "not used during Chapter 1" and the printed Chapter 2
   * triggers all sit at Wave 2 / Wave 3 start. This field is
   * therefore expected to be `undefined` on every Wave 1 entry.
   */
  scenarioCardOnStart?: number;
  /**
   * Ch3+ quests: "Draw the top card from the Scenario Deck and resolve
   * it" at wave start. Draws `state.scenarioDeckTop[0]` if the story
   * placed a card there, otherwise the lowest-numbered printed card not
   * yet resolved. Mutually exclusive with `scenarioCardOnStart`.
   */
  scenarioCardDraw?: boolean;
  /**
   * Ch3+: story entry that fires mid-wave the moment this wave's boss
   * dies (e.g. Quest #3 "IF YOU SLAY THE CARNATIA -> 3.4"). Rewards are
   * applied at the kill; the board then shows the entry and the wave
   * carries on.
   */
  onBossSlain?: { pageId: string; rewards?: TownVisitAction[] };
  /**
   * Ch3+ quests: data-driven End of Wave (replaces the hand-coded Q1 /
   * Q2 branches). Absent = legacy handling.
   */
  eow?: QuestWaveEow;
  /**
   * Quest #2 (legacy End of Wave): the storybook "continue to the next
   * wave" options on the victory page — they replace the Scenario Card
   * drawn at the next wave's start. Each has visible results
   * (`carryEffects`, applied once the next wave is set up) and may be a
   * Key-Item bonus (`requireKeyItem`). All use `then: "next-wave"`.
   */
  continueChoices?: QuestEowChoice[];
}

/** One printed End-of-Wave option ("A - CONTINUE / B - RETREAT"). */
export interface QuestEowChoice {
  label: string;
  /** Entry text (key into `Quest.pages`) shown after picking. */
  pageId: string;
  /** Campaign rewards (complete-quest, shop products, key items, favour...). */
  rewards?: TownVisitAction[];
  /** In-encounter effects applied once the NEXT wave is set up
   *  (elements of your choice, heal, Level card). */
  carryEffects?: import("./data").ScenarioCardEffect[];
  /** "Shop Products #32-45: choose any N products to add to your
   *  Purchasable Products" (the Gaia wave). The End of Wave screen shows
   *  a picker; products already available or owned can't be picked, and
   *  each pick that can't be made becomes a Memory Chip token. */
  pickShopProducts?: { from: number[]; count: number };
  /** Bonus option: shown on every playthrough but only selectable while
   *  the party owns this Key Item (pays off optional Key Items). */
  requireKeyItem?: number;
  then: "next-wave" | "end-quest";
  /** With `then: "next-wave"`: jump to this wave instead of the next one
   *  (Quest #4 "Find a way to pass" skips Wave 2). */
  nextWaveNumber?: number;
}

export interface QuestWaveEow {
  /** "If one or both delvers die" entry — always ends the quest. */
  defeat: { pageId: string; rewards?: TownVisitAction[] };
  /** End-of-wave options when both delvers survive. */
  victory: QuestEowChoice[];
}

export interface Quest {
  id: string;
  name: string;
  /**
   * Quest intro narrative, broken into one entry per Story-screen
   * page. Each entry is shown as its own page so that long monologues
   * don't overflow the viewport (Story.ts renders one entry at a
   * time with a Next button).
   */
  intro: string[];
  /**
   * Printed PRIMARY quest goal — the headline objective that, when
   * met, marks the quest as "completed" in the rulebook sense
   * (Surveillance Device retrieved / buoy reached / etc.). Shown in
   * the board topbar while the player is on any wave at or before
   * `primaryGoalWaveNumber`. Quests with a single wave (Q1) print
   * the wave goal verbatim here.
   */
  goal: string;
  /**
   * The wave number (1-based, matches `QuestWave.number`) that
   * completes the PRIMARY goal — i.e. once `encounter.waveNumber`
   * exceeds this, the topbar swaps to `bonusGoal`. For Q2 this is
   * `2` (Wave 2 ends with Key Item #1, the Surveillance Device);
   * for Q1 it's `1` (the only wave IS the goal).
   *
   * MUST reference a wave that exists in `waves[]` — `getQuestWave`
   * lookups in the topbar helper assume this.
   */
  primaryGoalWaveNumber: number;
  /**
   * Optional printed BONUS quest goal — only set on quests that
   * have post-primary waves (Q2 has Wave 3 as bonus territory).
   * Shown in the topbar when `encounter.waveNumber >
   * primaryGoalWaveNumber`. Quests without bonus content (Q1)
   * leave this `undefined`; the topbar helper then keeps showing
   * `goal` even on the (non-existent) post-primary path so a
   * future single-wave quest doesn't fall through to an empty
   * label.
   */
  bonusGoal?: string;
  /** Wave specs in printed order. `waves[i]` corresponds to wave
   *  `i + 1`; the engine's `state.encounter.waveNumber` is 1-based. */
  waves: QuestWave[];
  /** Free-form narrative pages keyed by id, reachable via end-of-wave routing. */
  pages: Record<string, string>;
}

// --- Delver Board (UI overlay coords + slot abilities) -------------------

/** Percentage-based positions on the suit-board background image. */
export interface PercentRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A 1D track laid out horizontally (HP, Movement). */
export interface TrackOverlay {
  /** Starting cell percentage X (left edge of the first cell). */
  x0: number;
  /** Ending cell percentage X (right edge of the last cell). */
  x1: number;
  /** Vertical center percentage Y of the track. */
  y: number;
  /** Number of cells (HP track has 22 for 0..21, Movement 6 for 1..6). */
  cells: number;
}

export interface DamageOverlay {
  /** Percentage X of the base value cube. */
  baseX: number;
  /** Percentage X of the shop-bonus (+1) cube (lock column). */
  shopBonusX: number;
  /** Percentage X of the town-upgraded value cube. */
  upgradedX: number;
  y: number;
}

/**
 * Structured form of a Weapon Slot's printed alternative ability.
 *
 * One per slot per suit (12 total). Each kind is dispatched by
 * `engine/slotAbilities.ts > resolveSlotAbility`. See DESIGN.md §5.8
 * for the per-element table.
 *
 * Ability data lives on `WeaponSlotOverlay.slotAbility`; the
 * human-readable card text stays on `slotAbilityText` for the action
 * modal.
 */
export type SlotAbility =
  /**
   * "Deal LIGHT damage to any enemy." (mind-radiance)
   * "Suffer 1 damage and deal MEDIUM damage to any enemy." (body-void)
   * `selfSuffer` is applied to the attacking delver BEFORE damage is
   * dealt.
   */
  | { kind: "damage-any-enemy"; damageType: DamageType; selfSuffer?: number }
  /** "+1 to MOVEMENT this turn." (mind-earth, body-wind) */
  | { kind: "bonus-movement-this-turn"; amount: number }
  /** "REFRESH 1 AP." (mind-fire, body-water) */
  | { kind: "refresh-ap"; amount: number }
  /**
   * "Choose a delver to gain: BOSS PART." (mind-void)
   * "Choose a delver to gain: CREATURE PART." (body-radiance)
   * The recipient delver id is supplied at call time via
   * `SlotAbilityParams`.
   */
  | { kind: "gain-token"; token: "creature-part" | "boss-part" }
  /**
   * "Choose a delver to gain: <ELEMENT>." (mind-wind/water,
   * body-earth/fire). Recipient supplied at call time.
   */
  | { kind: "gain-element"; element: Element };

export interface WeaponSlotOverlay {
  rect: PercentRect;
  /** The element symbol printed on the slot. */
  element: Element;
  /** Printed alternative ability when used as a slot ability. */
  slotAbilityText: string;
  /** Structured form of the printed ability — see {@link SlotAbility}. */
  slotAbility: SlotAbility;
}

export interface DelverBoardOverlay {
  suit: Suit;
  background: string; // /suits/body.jpg or /suits/mind.jpg
  hpTrack: TrackOverlay;
  movementTrack: TrackOverlay;
  damageLight: DamageOverlay;
  damageMedium: DamageOverlay;
  damageHeavy: DamageOverlay;
  weaponSlots: WeaponSlotOverlay[]; // length 6
  available: PercentRect;
  spent: PercentRect;
  apTokens: { x: number; y: number; max: number }; // count of starting AP positions
}

// --- Town Visit (storybook chapter) --------------------------------------

/**
 * One on-enter side-effect listed on a Town Visit page. The reducer
 * in `engine/townVisit.ts` is the single dispatch point — adding a
 * new variant means adding a case there.
 *
 *   record-decision     - append `key` to `state.townDecisions`.
 *                         Silent; never emits a RewardEvent.
 *   grant-minion-parts  - bump `state.minionParts[heroId]`.
 *   lose-minion-parts   - debit `state.minionParts[heroId]` (clamped >= 0).
 *   grant-memory-chip   - bump `state.memoryChips`.
 *   add-shop-products   - push numbers onto `state.shopProductsAvailable`.
 *                         `questLabel` (optional) is a short banner shown in
 *                         the rewards modal next to the product list ("Quest
 *                         #2 - The Surveillance Device unlocked"). When
 *                         omitted the modal just shows the product list.
 *   unlock-hero-cards   - push numbers onto `state.unlockedHeroCards`
 *                         (HERO #3, HERO #4 etc become known to the
 *                         campaign; no playable-swap UI yet, just
 *                         ownership tracking + visual reward).
 *   gain-key-item       - append `{ number, name }` to `state.keyItems`
 *                         (campaign-shared inventory; rulebook p29's
 *                         "Key Item" cards). Tracked-only — Q1 has no
 *                         spend mechanic yet.
 *   shift-favour        - bump (or debit) `state.favour[characterId].value`,
 *                         creating the entry with the supplied display
 *                         name on first contact. Tracked-only — Q1 has
 *                         no favour-driven branch yet; future chapters
 *                         will gate choices on favour thresholds. ALSO
 *                         appends one entry to `state.opinionCards` for
 *                         every NAMED level (rulebook p7 — DETRACTOR /
 *                         ALLY / CONFIDANT / NEMESIS) the shift newly
 *                         crosses INTO, and emits an
 *                         `opinion-card-gained` reward event per
 *                         crossed level (gated on art availability
 *                         per `opinionCardImageOrNull`). Sticky
 *                         under the hood — re-crossing the same
 *                         level later is a no-op for both lists.
 *   reveal-quest        - append `{ number, name }` to `state.revealedQuests`
 *                         (campaign-shared "open quests" list). Tracked-
 *                         only — Q1 has no quest-state machine yet;
 *                         future chapters will use this list to gate
 *                         quest-start dialogue + completion rewards.
 *
 * `to: "all-delvers" | "active-delver"` selects the recipient(s) for
 * per-hero deltas. `"active-delver"` reads `state.currentDelverId`.
 */
export type TownVisitAction =
  | { kind: "record-decision"; key: string }
  | { kind: "grant-minion-parts"; amount: number; to: "all-delvers" | "active-delver" }
  | { kind: "lose-minion-parts"; amount: number; to: "all-delvers" | "active-delver" }
  | { kind: "grant-memory-chip"; amount: number }
  | {
      kind: "add-shop-products";
      products: number[];
      questLabel?: string;
      /** Memory Chip tokens granted per product that can't be added
       *  (already Purchasable or owned). Absent = skipped silently. */
      chipFallback?: number;
    }
  | { kind: "unlock-hero-cards"; cardNumbers: number[] }
  | { kind: "gain-key-item"; number: number; name: string }
  | { kind: "reveal-quest"; number: number; name: string }
  | {
      kind: "shift-favour";
      /** Stable id used as the key in `state.favour` (e.g. "xavier"). */
      characterId: string;
      /** Display name shown in the rewards modal + Campaign Sheet. */
      characterName: string;
      /** +1 ally / -1 detractor. Larger magnitudes are legal future-proofing. */
      delta: number;
      /** Track the opinion value only - for characters with no printed
       *  opinion cards (Ch4 Master Bram). */
      trackOnly?: boolean;
    }
  /**
   * Discard a previously-gained Key Item from the campaign sheet
   * (rulebook flow: e.g. Ch2's "Father Flores's Office" page where
   * the player hands over Key Item #1, the Surveillance Camera).
   * Idempotent: silently skips if the campaign doesn't currently own
   * the item (defensive — a page that fires this before the item is
   * granted should be a data bug, not a runtime crash).
   */
  | { kind: "discard-key-item"; number: number }
  /**
   * Top up `to` delvers to AT LEAST `floor` minion parts. Used by
   * Ch2's "Town Center" page ("If either player is in possession of
   * less than 10 minion parts, increase their count to 10").
   * Delvers already at or above `floor` are untouched. Emits one
   * `creature-parts-changed` event per recipient who actually moved.
   */
  | { kind: "grant-minion-parts-floor"; floor: number; to: "all-delvers" | "active-delver" }
  /**
   * Set the shared `storyTokens` counter to `amount` (collectively
   * gained, not per-delver). Used by Ch2's "Burned Watchtower"
   * resolution page ("Collectively gain 2 Story tokens"). NOTE:
   * this is an absolute SET, not an additive grant — a chapter
   * authoring a second "gain N tokens" page would overwrite the
   * prior pool. Today only one page fires this per visit.
   */
  | { kind: "grant-story-tokens"; amount: number }
  /**
   * Decrement the shared `storyTokens` counter by 1, floor-clamped
   * at 0. Fired by each Ch2 location's entry page (Academy /
   * Library / Machinist) so visiting two-of-three drains the pool.
   * Silent no-op when the counter is already 0 — the hub-page
   * choice gating (`requireStoryTokens`) should prevent that path,
   * but the floor clamp is the safety net.
   */
  | { kind: "spend-story-token" }
  /**
   * Add `products` to the shop only if the campaign owns at least
   * `minKeyItems` distinct Key Items. Used by Ch2's "Town Center"
   * page (Shop Product #13 unlocks at 2+ icons, #14 at 4+). When
   * the gate isn't met, the action silently no-ops (no reward
   * event) — the player just doesn't see the conditional products.
   */
  | { kind: "add-shop-products-if-key-items-min"; minKeyItems: number; products: number[]; questLabel?: string }
  /**
   * Branch on prior `revealedQuests` state: if the quest with the
   * given `number` was already revealed earlier in the campaign,
   * grant `chipFallback` Memory Chip Tokens instead. Otherwise reveal
   * the quest. Used by Ch2's "Father Flores's Office" page to
   * resolve Quest #05's reveal — players who already discovered it
   * via the Academy branch get a chip in compensation.
   */
  | { kind: "reveal-quest-or-grant-chip"; number: number; name: string; chipFallback: number }
  /**
   * Chapter 2 Town Center: resolve the accumulated academy donation
   * (Shop Product #8) by reading `state.academyDonation` per
   * delver, summing across the party, and granting tiered
   * `suitConditionRankBonus` bumps via
   * `engine/townVisit.ts > resolveAcademyDonation`.
   *
   * Fires once at `page34-town-center-resolution` onEnter. Safe to
   * re-fire (idempotent against `pagesEntered` dedupe + the
   * resolution helper's own one-shot guard — see jsdoc on
   * `resolveAcademyDonation`). Emits a single
   * `academy-donation-resolved` reward event whose `tier` tells
   * the modal which row of the printed Suit Condition sheet was
   * matched.
   */
  | { kind: "resolve-academy-donation"; schedule?: "ch2" | "ch3" | "ch4" }
  /** Ch4 Assault on Bird's Nest end: remove unused "for this combat only"
   *  townsfolk tokens and AP (engine/townsfolk.ts). */
  | { kind: "clear-combat-only-grants" }
  /** Story counters (Ch4 Quest #7's Elias conversation dial). */
  | { kind: "set-story-counter"; key: string; value: number }
  | { kind: "adjust-story-counter"; key: string; delta: number }
  /** Quest #7 Elias' Scavenge Shop: add these products (those nobody owns
   *  and that aren't already for sale) for this visit only. */
  | { kind: "open-scavenge-shop"; products: number[] }
  /** Remove the scavenge-shop products nobody bought. */
  | { kind: "close-scavenge-shop" }
  /**
   * Grant `amount` Ultra Level Up card numbers to the campaign by
   * appending them to `state.ultraLevelCardsOwned`. The engine
   * picks `amount` numbers at random from the printed Ultras
   * (`LEVEL_DECK` entries with `isUltra: true`, today 29..32)
   * that the campaign doesn't already own.
   *
   * If fewer than `amount` Ultras remain unowned, the engine
   * grants all that are left and emits a single event for the
   * partial batch — no error, no padding (printing more copies of
   * a card the player already has would just be noise). The
   * action is a silent no-op (no event) when every printed Ultra
   * is already owned.
   *
   * Used by Ch1 Library "Creature Archives" (page12-A) — the page
   * footnote prints "Shuffle two Ultra Level cards into the Level
   * deck". The shuffle-in itself doesn't happen here: it's deferred
   * to the next `buildEncounter` call, which reads
   * `state.ultraLevelCardsOwned` and merges it with the base deck.
   */
  | { kind: "grant-ultra-level-cards"; amount: number }
  /**
   * Convert ALL of `state.memoryChips` into Memory Cards in one
   * shot — spends the whole chip pool to zero and draws one Memory
   * card per chip spent from the printed pool (`MEMORY_CARDS`).
   *
   * Draws happen WITH REPLACEMENT — the printed deck only has 2
   * distinct cards in v1, so a player with 3+ chips will see
   * duplicates of the same printed face. Each drawn card number is
   * appended (in draw order) to `state.memoryCards`. Duplicates
   * accumulate in that array — the Campaign Sheet roster reads
   * `state.memoryCards.length` as the total cards drawn and
   * de-dupes the printed-face grid against `MEMORY_CARDS` itself.
   *
   * Silent no-op (returns `[]`, no event) when `state.memoryChips`
   * is 0 — the Ch2 Machinist "Witness records a memory" page that
   * fires this action still renders its narrative beat so the
   * player reads the moment; the modal just doesn't open over an
   * empty grant.
   *
   * Used by Ch2 Machinist outcome pages (page32-machinist-{A,B,C}-
   * witness). Future chapters with the same "snap a photo of
   * Witness's projection" beat can reuse the action verbatim.
   */
  | { kind: "convert-memory-chips-to-cards" }
  /**
   * Enqueue one or more Suit Condition rank picks onto
   * `state.pendingSuitConditionPicks`. The town-visit flow blocks
   * page navigation until the queue is drained via the
   * `SuitConditionRankPickModal`, which calls
   * `engine/suitConditionGrants.ts > applySuitConditionRankPick`
   * to fold each resolved pick into
   * `state.suitConditionRankBonus[heroId][type]`.
   *
   * Each pick spec is converted to a `PendingSuitConditionRankPick`
   * with a unique `pickId` namespaced by the page id + a per-action
   * index, so re-firing the action (page re-entry — `applyOnEnter`
   * dedupes by `pagesEntered`, so this is defence-in-depth) is
   * idempotent.
   *
   * `pinnedHeroId` skips the picker's step 1 (used for academy
   * donation's 10+ tier — "each player +2 any equipment" enqueues
   * 2 picks, one pinned to each delver).
   *
   * `pinnedType` skips the picker's step 2 (used for the printed
   * "+1 OS" / "+1 Battery" branches of the small / medium tiers
   * — type is fixed by the rule, hero is the player's choice).
   *
   * `pairWithIndex` links two picks in the same action so the
   * SECOND auto-pins to the OTHER delver once the FIRST resolves
   * (printed: "one player +1 OS, OTHER player +1 Battery"). Pair
   * indices are interpreted relative to the action's own `picks`
   * array (0-based), and the engine rewrites the matching
   * `pendingSuitConditionPicks` entry's `pairsWithPickId` to the
   * resolved pickId at enqueue time so the link is stable across
   * saves.
   */
  | {
      kind: "enqueue-suit-condition-rank-picks";
      source: string;
      picks: Array<{
        delta: 1 | 2;
        pinnedHeroId?: string;
        pinnedType?: EquipmentType;
        pairWithIndex?: number;
      }>;
    }
  /**
   * Grant ONE Friendly Spawn Card to the campaign by appending a
   * card number (drawn at random from the printed pool that the
   * campaign doesn't already own) to `state.friendlySpawnDeck`.
   *
   * The printed pool today is `[13, 14]`. If both are already in
   * the deck, this is a silent no-op (no event, no append) — the
   * printed game ships only those two friendly spawn cards and
   * the storybook never instructs a third grant.
   *
   * The grant doesn't reshuffle the deck — the next wave that
   * draws a spawn card (`engine/encounter.ts > buildEncounter`)
   * will pick from base 1..12 + every entry in
   * `friendlySpawnDeck` with equal probability. When a friendly
   * spawn card draws, the engine removes it from
   * `friendlySpawnDeck` (one-shot per the printed "discard the
   * card" rule).
   *
   * Used by Chapter 1's Library "Atlas Archives" page and
   * Chapter 2's Academy "Xavier's Lecture" page.
   */
  | { kind: "grant-friendly-spawn-card" }
  /**
   * Storybook Lieutenant challenge (Quests #4+, continue into Wave 3+):
   * place the next Lieutenants Spawn Card not yet in the campaign deck on
   * top of the Spawn Deck. It is fought next wave and stays in the deck
   * for the rest of the campaign. Once all six are in, one of those is
   * placed on top instead.
   */
  | { kind: "lieutenant-challenge" }
  /**
   * Conditional block (Ch3+). Runs `then` when `cond` holds, else
   * `otherwise`. Keeps branching data-driven instead of adding a
   * bespoke action per printed "If you have…" clause.
   */
  | { kind: "if"; cond: TownVisitCondition; then: TownVisitAction[]; otherwise?: TownVisitAction[] }
  /** Mark a quest as completed (stamps `state.completedQuests` and the
   *  `quest.<n>.completed` decision). Also reveals it if it wasn't. */
  | { kind: "complete-quest"; number: number; name: string }
  /** Grant boss parts of a given printed level ("Delvers gain a Level 2 Boss Pelt"). */
  | { kind: "grant-boss-parts"; level: 1 | 2 | 3 | 4 | 5; amount: number; to: "all-delvers" | "active-delver" }
  /** Remove an owned Opinion Card (Ch3: Vera's Ally card once she is crossed out). */
  | { kind: "discard-opinion-card"; characterId: string; level: "nemesis" | "detractor" | "ally" | "confidant" }
  /**
   * Reveal the first quest in `quests` the campaign doesn't already
   * own or have completed; if every one is owned, grant `chipFallback`
   * Memory Chips (Ch3 Academy A / Ch4 Library C quest chains).
   */
  | { kind: "reveal-first-unowned-quest"; quests: Array<{ number: number; name: string }>; chipFallback: number }
  /** Give a shop product for free (Ch3 Machinist "If Samantha's opinion is Ally or better, gain the product instead"). */
  | { kind: "grant-shop-product"; product: number; to: "active-delver" | "hero-01" | "hero-02" }
  /** Put a lettered Scenario Card on top of the Scenario deck (Ch3 Dahlia's Cave A, Quest #3 Wave 3). */
  | { kind: "place-scenario-card-on-top"; cardNumber: number }
  /** Jobs Board: each recipient gains `perQuest` minion parts per Open (revealed, not completed) Quest. */
  | { kind: "grant-minion-parts-per-open-quest"; perQuest: number; to: "all-delvers" };

/** Predicates for the `if` Town Visit action. */
export type TownVisitCondition =
  | { kind: "decision-made"; key: string }
  | { kind: "quest-completed"; number: number }
  | { kind: "favour-at-least"; characterId: string; min: number }
  | { kind: "clues-at-least"; min: number }
  | { kind: "owns-opinion-card"; characterId: string; level: "nemesis" | "detractor" | "ally" | "confidant" }
  | { kind: "open-quests-at-least"; min: number }
  | { kind: "owns-key-item"; number: number }
  | { kind: "story-counter-at-least"; key: string; min: number };

/**
 * "Something visible just happened" — emitted by the town-visit
 * engine alongside every on-enter mutation so the UI can present
 * each grant/loss as a card or token in the rewards modal.
 *
 * One action can produce zero, one, or many events (e.g. a future
 * "grant per recipient" might want one event per recipient). Today
 * every action emits at most one event; the presenter
 * (`screens/RewardsModal.ts`) renders each event as one or more
 * `<article class="reward-card">`s based on its kind.
 *
 * NOTE: `record-decision` deliberately does NOT emit a reward
 * event — by design, narrative decisions are invisible bookkeeping,
 * not player-facing rewards. A page that ONLY contains
 * `record-decision` actions (e.g. a future logging-only beat) will
 * return `[]` and skip the modal entirely.
 *
 * RECIPIENT shape (`{ heroId, before, after }[]`) is reused by
 * minion + future boss-part variants so the modal renderer has
 * one shape to handle, and a single "no-op grant" filter
 * (`emittedRecipients.length === 0`) suppresses cards where every
 * recipient was already at the floor for a lose-action.
 */
export type RewardEvent =
  /** A plain line for a between-wave effect (Armor heal, opinion
   *  penalty, queued element picks) — `wave.ts >
   *  applyContinuingEndWaveEffects`. */
  | { kind: "wave-effect"; text: string }
  | {
      kind: "hero-cards-unlocked";
      /** Hero card numbers that JUST became unlocked on this page
       * (filtered to exclude any already-unlocked cards — re-entry
       * of the same page would emit `[]`, but `applyOnEnter`'s
       * page-dedupe already prevents that path). */
      cardNumbers: number[];
    }
  | {
      kind: "memory-chips-granted";
      /** Net delta added to `state.memoryChips`. Always > 0 (we
       * suppress the event for amount <= 0). */
      amount: number;
      /** Total chip count AFTER the grant. Lets the modal show
       * "+1 → 3" without re-reading state at render time. */
      totalAfter: number;
    }
  | {
      kind: "creature-parts-changed";
      /** "minion" | "boss-lvl-1" — which token type changed. Only
       * minion ships today; boss-lvl-1 is reserved for future
       * grants. */
      partKind: "minion" | "boss-lvl-1" | "boss-lvl-2" | "boss-lvl-3" | "boss-lvl-4" | "boss-lvl-5";
      /** "gain" | "loss" — drives the modal's `+N` vs `-N` styling
       * (green pill vs red pill) and the verb ("gained" vs
       * "lost"). */
      direction: "gain" | "loss";
      /** Per-recipient breakdown. `before` + `after` are the
       * actual stored counts, so the modal can show "Mind: 0 → 4"
       * style chips. Recipients with `after === before` are
       * filtered out before the event is emitted (no-op floor
       * clamp on a lose-action). */
      recipients: { heroId: string; before: number; after: number }[];
    }
  | {
      kind: "shop-products-added";
      /** Shop product numbers newly added to `shopProductsAvailable`
       * (filtered to exclude any already-available / already-owned). */
      productNumbers: number[];
      /** Optional "Quest #N - <Name> unlocked" banner text. Set by
       * the chapter author on the action; omitted for plain shop
       * stock additions. */
      questLabel?: string;
      /**
       * Set when the products were unlocked by the clue-token gate
       * (`add-shop-products-if-key-items-min`). Carries the player's
       * total clue count and the threshold that was met, so the
       * rewards modal can explain why the item was added.
       */
      clueUnlockContext?: { clues: number; threshold: number };
    }
  | {
      kind: "key-item-gained";
      number: number;
      name: string;
    }
  | {
      kind: "favour-shifted";
      characterId: string;
      characterName: string;
      delta: number;
      /** Favour value AFTER the shift. Used for the trailing
       * "now at +2" line in the modal card. */
      totalAfter: number;
    }
  | {
      /**
       * Player crossed the favour threshold for a named opinion
       * level (rulebook p7 — *NEMESIS | DETRACTOR | ALLY |
       * CONFIDANT*) and "gained" the corresponding Opinion Card.
       *
       * Emitted by the favour engine as a downstream consequence
       * of a `shift-favour` action whenever the value walks INTO
       * a named slot it wasn't already in (NEUTRAL crossings are
       * silent). A single shift can emit multiple events when it
       * spans multiple thresholds in one go (e.g. delta = +2 from
       * NEUTRAL = ALLY + CONFIDANT). Sticky: once an opinion
       * card is in `state.opinionCards`, re-crossing the same
       * level later does NOT re-emit.
       *
       * The event is ONLY emitted when art is available for the
       * (characterId, level) pair per
       * `opinionCardImageOrNull` — state.opinionCards is still
       * populated for missing-art pairs so the Campaign Sheet's
       * opinion roster stays complete; the modal just doesn't
       * surface a card it can't render. Adding art retroactively
       * lights up the visual reward for any future shift that
       * crosses that threshold (no engine change needed).
       */
      kind: "opinion-card-gained";
      characterId: string;
      characterName: string;
      level: "nemesis" | "detractor" | "ally" | "confidant";
    }
  | { kind: "quest-completed"; number: number; name: string }
  | { kind: "scenario-card-placed"; cardNumber: number }
  | { kind: "opinion-card-discarded"; characterId: string; characterName: string; level: string }
  | { kind: "shop-product-granted"; productNumber: number; heroId: string }
  | {
      kind: "quest-revealed";
      /** Printed quest number (e.g. 2 for "The Surveillance Device"). */
      number: number;
      /** Quest name as stored at reveal time — source of truth even
       * if the catalog's display name later changes. */
      name: string;
    }
  | {
      /**
       * The campaign was awarded `amount` shared Story Tokens. The
       * Story Token pool lives on `state.storyTokens` and gates
       * the Ch2 "Burned Watchtower" hub page's location choices
       * (each visit decrements; when 0 the player MUST continue).
       */
      kind: "story-tokens-granted";
      amount: number;
      /** Counter value AFTER the grant — lets the modal show
       * "+2 Story Tokens (now 2)" without re-reading state at
       * render time. */
      totalAfter: number;
    }
  | {
      /**
       * A previously-owned Key Item was removed from the campaign
       * sheet (e.g. Ch2's "Father Flores's Office" page where the
       * delvers hand over Key Item #1, the Surveillance Camera).
       * Carries the same (number, name) pair as the matching
       * `key-item-gained` so the modal renderer can reuse the
       * key-item card art.
       */
      kind: "key-item-discarded";
      number: number;
      name: string;
    }
  | {
      /**
       * A delver's equipment slot rank was temporarily bumped by
       * an Opinion Card effect (Xavier Ally / Confidant / Detractor —
       * "+/- 1 RANK at each Quest start"). Emitted by
       * `engine/opinionGrants.ts > applyOpinionRankPick` when the
       * player resolves a pending pick. Distinct from
       * `level-up-resolved` because the bump is TEMPORARY (lives on
       * `state.temporaryRankBonus`, wiped at quest end) — the
       * rewards modal should signal that distinction in its
       * eyebrow ("Opinion: Xavier's favor" vs "Leveled Up").
       *
       * `direction` carries the printed sign so the renderer can
       * style positive bumps green and negative bumps red without
       * inspecting `delta`.
       */
      kind: "opinion-rank-bumped";
      heroId: string;
      equipmentType: EquipmentType;
      /** Effective rank BEFORE the bump (printed rank + prior bonus). */
      effectiveBefore: number;
      /** Effective rank AFTER the bump, clamped to [1, EQUIPMENT_RANK_CAP]. */
      effectiveAfter: number;
      /** Signed delta the bump asked for — `+1` for Ally/Confidant,
       *  `-1` for Detractor. May differ from `effectiveAfter - effectiveBefore`
       *  when the bump was clamped (e.g. -1 on a slot already at R1). */
      delta: 1 | -1;
      /** Catalog id of the originating Opinion Card
       *  (`"xavier-ally"` / `"xavier-confidant"` / `"xavier-detractor"`). */
      source: string;
    }
  | {
      /**
       * A one-shot Opinion Card was redeemed for its printed effect
       * (Flores / Elayna / Rodrigo / Vera / Arlen — and conceptually
       * also Samantha's auto-shield, but that one emits the dedicated
       * `opinion-card-shielded-decrease` event below). Emitted by
       * the Shop / BoardScreen redeem button handlers; the card
       * is appended to `state.opinionCardsSpent` and rendered
       * with a "Redeemed" overlay on the Campaign Sheet from
       * then on.
       *
       * `summary` is a one-line description of what just happened
       * ("Both delvers healed to full",
       * "All spent consumable tokens refreshed", etc.) so the
       * modal can render a meaningful card without each call site
       * having to author per-card render branches.
       */
      kind: "opinion-card-redeemed";
      characterId: string;
      characterName: string;
      level: "nemesis" | "detractor" | "ally" | "confidant";
      summary: string;
    }
  | {
      /** Arlen Detractor / Nemesis cap: a new Ally / Confidant card wasn't
       *  taken because the player already holds `limit` such cards. */
      kind: "opinion-card-blocked";
      characterId: string;
      characterName: string;
      level: "nemesis" | "detractor" | "ally" | "confidant";
      limit: number;
    }
  | {
      /**
       * Samantha's Ally card ("Popular") auto-fired: the player was
       * about to lose opinion with someone and her "next loss, don't"
       * effect prevented the shift. Emitted by the favour engine
       * (`engine/townVisit.ts > shift-favour`) when a negative
       * delta is intercepted; the card is appended to
       * `state.opinionCardsSpent` in the same step.
       *
       * The shielded character is reported in
       * `shieldedCharacterName` so the modal can read
       * "Samantha shielded Xavier's opinion of you" without the
       * renderer having to look up the original target.
       */
      kind: "opinion-card-shielded-decrease";
      /** Character whose opinion would have decreased. */
      shieldedCharacterId: string;
      shieldedCharacterName: string;
      /** The signed delta that was prevented (always < 0). */
      preventedDelta: number;
    }
  | {
      /**
       * Chapter 2 Town Center Academy-donation resolution.
       * Emitted once when `resolve-academy-donation` runs at
       * `page34-town-center-resolution` and applies suit-condition
       * rank bumps based on the total donation tier.
       *
       * `tier` is the resolution tier the engine landed on:
       *   - "none"   for 0-2 donated (no grant fires; modal still
       *              shows the card so the player sees their
       *              donation was recorded but didn't reach a tier).
       *   - "small"  for 3-5 (+1 OS / +1 Battery).
       *   - "medium" for 6-9 (+2 OS / +2 Battery).
       *   - "large"  for 10+ (+2 OS+Supercharger / +2 Battery+Harvester).
       *
       * `grants` enumerates every (heroId, type, delta) the
       * engine applied to `suitConditionRankBonus`, so the modal
       * can render a per-delver summary instead of recomputing
       * the tier mapping. Empty array for `tier === "none"`.
       */
      kind: "academy-donation-resolved";
      /** Which chapter's printed table was used (absent = Ch2). */
      schedule?: "ch2" | "ch3" | "ch4";
      totalDonated: number;
      tier: "none" | "small" | "medium" | "large";
      grants: ReadonlyArray<{
        heroId: string;
        equipmentType: EquipmentType;
        delta: number;
      }>;
    }
  | {
      /**
       * The campaign earned one or more Ultra Level Up cards
       * (rulebook Ch1 Library "Creature Archives" — page12-A
       * grants 2 of the printed Ultras). The renderer displays
       * the printed card art for each entry; once acknowledged,
       * subsequent `buildEncounter` calls shuffle the cards into
       * the level deck so they can surface as future level-ups
       * during quests.
       *
       * `cardNumbers` is the actual list appended to
       * `state.ultraLevelCardsOwned` (filtered to exclude any the
       * campaign already owned). The action is suppressed entirely
       * when the filtered list is empty.
       */
      kind: "ultra-level-cards-gained";
      cardNumbers: number[];
    }
  | {
      /**
       * The campaign spent `chipsSpent` Memory Chip Tokens and
       * drew `cardNumbers.length` Memory Cards from the printed
       * pool. Always emitted as a single event per
       * `convert-memory-chips-to-cards` action — never split per
       * card, so the modal can render the full draw as a single
       * row even when chips > distinct cards (duplicates collapse
       * visually but appear N times in `cardNumbers` to mirror
       * the actual `state.memoryCards` mutation).
       *
       * Invariants:
       *   - `chipsSpent === cardNumbers.length` (1:1 by design).
       *   - `chipsSpent > 0` (action returns `[]` and emits no
       *     event for zero-chip enters — the empty modal would
       *     just confuse the player).
       *   - Every entry in `cardNumbers` is a `number` field from
       *     `MEMORY_CARDS` (the action draws ONLY from the
       *     printed catalog, so a UI lookup via
       *     `memoryCardImageOrNull` always succeeds at render
       *     time).
       */
      kind: "memory-cards-gained";
      /** Chips that were debited from `state.memoryChips`
       *  (always equals `cardNumbers.length`). */
      chipsSpent: number;
      /** Card numbers appended to `state.memoryCards` in draw
       *  order. May contain duplicates when the campaign's chip
       *  count exceeds `MEMORY_CARDS.length`. */
      cardNumbers: number[];
    }
  | {
      /**
       * A Suit Condition rank pick was resolved — folded `delta`
       * onto `state.suitConditionRankBonus[heroId][equipmentType]`.
       * Emitted by `engine/suitConditionGrants.ts >
       * applySuitConditionRankPick` once per resolved pick so the
       * post-picker rewards modal can show one card per bump.
       *
       * `effectiveBefore` / `effectiveAfter` are computed via
       * `getEffectiveEquipmentRank` so the modal can render
       * "R3 -> R5" with the printed + temp + suit sum already
       * combined. `delta` is the signed value the engine
       * actually added (always positive for v1 — all suit-
       * condition grants are bonuses), separate from
       * `effectiveAfter - effectiveBefore` which would lose
       * meaning under a future cap-clamp scenario.
       *
       * `source` is the `PendingSuitConditionRankPick.source`
       * tag the grant was enqueued with — used by the modal as
       * the eyebrow ("Academy donation: small" / "Suit's
       * blood-soaked power" / ...).
       */
      kind: "suit-condition-rank-bumped";
      heroId: string;
      equipmentType: EquipmentType;
      effectiveBefore: number;
      effectiveAfter: number;
      delta: 1 | 2;
      source: string;
      /** True for boss-card rank unlocks — no rank bonus was applied,
       *  only `unlockedForHigherRanks` was set. Used by the modal to
       *  display "RN access unlocked" rather than a rank-bump copy. */
      unlockOnly?: boolean;
      /** The specific rank cap that was just unlocked (4 or 5).
       *  Only present when `unlockOnly` is true. */
      unlockedCap?: 4 | 5;
    }
  | {
      /**
       * A Scenario Card was resolved — the player picked option
       * `chosenOption` on card `cardNumber`, and the option's
       * mechanical effects (HP heal, element grants, level-up
       * cards, etc.) have already landed via separate, granular
       * reward events emitted in the same batch. This event is
       * the headline "you resolved card #N" card the modal
       * surfaces alongside the per-effect cards.
       *
       * `headline` carries the printed eyebrow ("SCENARIO #01 -
       * SPARKLE" / "SCENARIO A - TIDEBLOOM") so the modal can
       * render the moment without re-reading the catalog. The
       * art (front + back JPEGs) lives in
       * `public/scenario-cards/scenario_{front|back}_NN.jpg` and
       * is looked up via `data.ts > scenarioCardArt`.
       *
       * Emitted by `engine/scenarioCard.ts > resolveScenarioCard`
       * AFTER the chosen option's effect actions run, so the
       * follow-on `level-up-card-granted` / `hp-changed` / etc.
       * events appear ALONGSIDE this header card.
       */
      kind: "scenario-card-resolved";
      cardNumber: number;
      headline: string;
      chosenOption: "A" | "B" | "C";
    }
  | {
      /**
       * A Friendly Spawn Card was granted to the campaign — the
       * card number now lives in `state.friendlySpawnDeck` and
       * will participate in the next spawn deck shuffle.
       *
       * `cardNumber` is the printed number (13 or 14 today);
       * `image` is the asset path under `/spawn-cards/` so the
       * rewards modal can render the printed card art.
       * `deckSize` is `friendlySpawnDeck.length` AFTER the grant
       * so the modal can show "1 / 2 friendly cards in deck".
       */
      kind: "friendly-spawn-card-gained";
      cardNumber: number;
      image: string;
      deckSize: number;
    }
  | {
      /** A Lieutenant challenge put Lieutenants Spawn Card `cardNumber`
       *  on top of the Spawn Deck. `added` is false when it was already in
       *  the campaign deck (all six in). `deckSize` = Lieutenant cards in
       *  the deck after the challenge. */
      kind: "lieutenant-spawn-card-on-top";
      cardNumber: number;
      image: string;
      added: boolean;
      deckSize: number;
    }
  | {
      /**
       * A Friendly Encounter card was drawn + resolved (the
       * delver / Witness stepped onto the token tile and the
       * player closed `FriendlyEncounterModal`). `cardNumber`
       * is the printed friendly-encounter card number (today
       * only #01 -- Flambe).
       *
       * The printed mechanical effect is currently applied
       * manually at the table (the modal shows the printed art
       * + a Continue button); future cards with auto-applied
       * effects can chain follow-on reward events the same way
       * scenario cards do.
       */
      kind: "friendly-encounter-resolved";
      cardNumber: number;
      name: string;
      image: string;
    }
  | {
      /**
       * A delver's `currentHp` was raised by an engine-applied
       * heal effect. Today the only emitter is
       * `engine/scenarioCard.ts > applyScenarioEffect` for the
       * `heal-both-delvers` effect (Sparkle option A and any
       * future scenario cards that grant flat HP healing).
       *
       * No-op heals (delver already at `maxHp`, so
       * `before === after`) are filtered out at the emit site so
       * the rewards modal never shows a "+0 HP" card.
       *
       * `before` and `after` are the actual `loadout.currentHp`
       * values bracketing the mutation, so the modal can render
       * "3 → 4" without re-reading state. `amount` is the
       * EFFECTIVE delta (`after - before`), which can be less
       * than the heal effect's printed amount when the delver
       * was 1 HP below `maxHp` and a +2 heal clamped to +1.
       */
      kind: "delver-healed";
      heroId: string;
      amount: number;
      before: number;
      after: number;
    };

/**
 * One choice button on a Town Visit page. `next` is the page id to
 * advance to; `decisionKey` is appended to `state.townDecisions` on
 * click. `hint` is a small italic label shown below the choice
 * (e.g. "Affects Favor", "Grants Wisdom") matching the printed
 * keyword on the storybook card.
 */
/** Who died on the last quest — see `engine/townVisit.ts > lastQuestDeathOutcome`. */
export type QuestDeathOutcome = "none" | "mind-only" | "body-only" | "both";

export interface TownVisitChoice {
  label: string;
  decisionKey: string;
  hint?: string;
  next: string;
  /** Card art shown on the choice button (Quest Report quest cards).
   *  Any visible choice with an image switches the row to a card grid. */
  image?: string;
  /**
   * Optional "who pays?" prompt fired by the UI when the player
   * clicks this choice, BEFORE the engine navigates to `next`.
   * Used for narrative beats that cost a per-delver resource and
   * could legitimately be paid by either delver (e.g. the Pub's
   * "Buy her a drink" branch — either Mind or Body can pony up
   * the minion part).
   *
   * Pre-pay flow (driven by `screens/TownVisit.ts > onChoice`):
   *   1. Compute eligible delvers — those with at least `amount`
   *      of the requested resource. Today only `"minion-parts"`
   *      is supported; future resources (boss-parts, memory
   *      chips) extend the union without an engine change.
   *   2. 0 eligible: button is rendered DISABLED with a hint
   *      explaining nobody can afford. The click is a no-op so
   *      the player can pick a different branch.
   *   3. 1 eligible: silently flip `state.currentDelverId` to
   *      the lone payer and navigate — no modal needed when
   *      there's no choice to make.
   *   4. 2+ eligible: mount the payer-pick modal
   *      (`PayerPickModal.ts`). On selection, flip
   *      `currentDelverId` and navigate. On cancel (Escape /
   *      backdrop), abort — the player stays on the parent
   *      choice page and can pick again.
   *
   * The downstream `next` page is expected to use `to:
   * "active-delver"` for its debit action so the chosen payer
   * is the delver actually debited. Engine state (the eventual
   * `lose-minion-parts` action) is unchanged — the prePay flow
   * is a pure UI concern that uses `currentDelverId` as the
   * "who's the focused payer right now?" signal.
   */
  prePay?: { kind: "minion-parts"; amount: number };
  /**
   * Optional "hide this button when the player has already made a
   * specific decision" gate. The renderer suppresses the choice
   * entirely if `state.townDecisions` includes `hideIfDecisionMade`.
   * Used by Ch2's "Burned Watchtower" hub page to hide already-
   * visited location buttons (Academy / Library / Machinist) on
   * the player's second pass through.
   */
  hideIfDecisionMade?: string;
  /** Hide the choice UNLESS this decision was made (Ch4: "If you have
   *  completed Quest #5" variants of a page). */
  showIfDecision?: string;
  /**
   * Optional "only show this button when story tokens match" gate.
   * `"zero"` shows the button only when `state.storyTokens === 0`
   * (used by the Ch2 hub page's "Continue to Town Center" choice —
   * appears only after the player has spent both Story Tokens).
   * `"positive"` shows only when `state.storyTokens > 0` (used by
   * the location buttons themselves — they vanish once the pool
   * empties so the player can't burn a token they don't have).
   */
  requireStoryTokens?: "zero" | "positive";
  /**
   * Show this button only when it matches who died on the last quest
   * (`state.lastQuestDeaths`, see `lastQuestDeathOutcome`), so the
   * "did any delver die?" pages pick their branch from what actually
   * happened instead of asking (user request 2026-11-15):
   *   - `"none"`: nobody died.   - `"any"`: at least one delver died.
   *   - `"mind-only"` / `"body-only"` / `"both"`: exactly those died.
   * When no quest has been recorded yet (`null` — fresh campaign or a
   * pre-v64 save) the gate is open and every option shows, so the
   * player picks as before.
   */
  requireQuestDeaths?: QuestDeathOutcome | "any";
  /**
   * Show this button only when `state.townDecisions` (or
   * `state.campaignDecisions`) already contains the key. Ch3's
   * "See what Xavier is up to" hub button uses
   * `"quest.3.completed"` (stamped by the `complete-quest` action).
   */
  requireDecision?: string;
  /** Show this button only when the campaign owns at least one of
   *  these Key Items (Ch3 Dahlia's Cave A: "Requires Key Item #4 or #8"). */
  requireKeyItemAny?: number[];
  /** Show only when this quest is in `revealedQuests` (Ch3 Quest Report). */
  requireQuestRevealed?: number;
  /** Show only when the party has no Open Quests (`"zero"`) or at least
   *  one (`"positive"`) — Ch3 Jobs Board. Open = revealed, not completed. */
  requireOpenQuests?: "zero" | "positive";
}

/** One outcome bracket of a page-level die roll (see `TownVisitPage.dieRoll`). */
export interface TownVisitDieOutcome {
  min: number;
  max: number;
  /** Short label shown next to the result, e.g. "1: You bump into someone". */
  label: string;
  next: string;
}

/**
 * One Town Visit page. Either `next` (linear narrative — render a
 * Continue button) or `choices` (branching — render N buttons), but
 * never both. `kind: "shop"` swaps the choice/next UI for the Shop
 * sub-screen render path; the page's `text` becomes the shop intro
 * blurb at the top. `kind: "end-town-visit"` marks a terminal
 * narrative page — has no `next`/`choices`, and the action renderer
 * mounts a "Finish Town Visit" button that calls `finishTownVisit`
 * and routes to title.
 */
export interface TownVisitPage {
  title: string;
  subtitle?: string;
  text: string;
  /**
   * Optional replacement for `text` rendered AFTER the page's
   * Collect Rewards gate has been dismissed. Lets a single page
   * carry both the "here's what just happened + what you earned"
   * intro prose (shown alongside the Collect Rewards button on
   * first entry) AND a leaner "here's what to do now" instruction
   * (shown alongside the actual interaction UI — shop grid,
   * picker, etc. — after the rewards modal closes).
   *
   * Used today by Ch1 page13 (Visit the Shops): the long
   * "Shop Products #1-7 are now available..." rules intro plays
   * once with the rewards card; the post-rewards render swaps in
   * the short "When you are done shopping, click Continue." line
   * so the shop UI doesn't compete for vertical space against
   * already-read rules text. Pages WITHOUT this field render
   * `text` in both states (the default — no behavioural change
   * for any existing page).
   *
   * Resolution mirrors `layoutBackground` / `layoutImage`: the
   * post-rewards swap fires on the SAME re-render the layout
   * switch fires on, so a page that defines both gets a
   * consistent "before/after rewards" treatment in a single beat.
   */
  postRewardsText?: string;
  /** Optional small italic note rendered after the body text. */
  footnote?: string;
  /** Optional speaker portrait beside the text (path under /public). */
  image?: string;
  /**
   * Optional override for the focal image used by an alternate
   * `layout`. Today only consumed by `layout: "image-choices"` (the
   * "pick a place" prompt that follows the rewards beat): when set,
   * the image-focus screen renders THIS image large and centred
   * instead of `image`. Useful when the small portrait that
   * accompanies the body text (e.g. a speaker like Bram in his
   * office) is wrong for the choice prompt, which often calls for
   * a wider establishing shot (e.g. a town map with labelled
   * locations). Path is served from `/public` like `image`. Falls
   * back to `image` when unset, so existing pages don't need to
   * declare both.
   */
  layoutImage?: string;
  /**
   * Optional centred decorative chapter-frame illustration rendered
   * ABOVE the storybook card (intrinsic aspect ratio, no stretch).
   * Used on chapter intro pages to set the scene before the prose.
   * Path is served from `/public` like `image`.
   */
  decoration?: string;
  /**
   * Optional per-page background illustration that REPLACES the
   * default `/story/storybook-bg.png` porthole painting for this
   * page only. Rendered at the same `center / 50% auto no-repeat`
   * treatment as the global background (aspect-ratio preserved,
   * filling ~50% of the screen width) so swapping the asset
   * doesn't change the sizing convention — only the artwork
   * behind the storybook card. Use when a chapter intro wants
   * a scene-specific backdrop (e.g. Ch1 page6's foliage frame)
   * without changing how every other story screen feels.
   * Path is served from `/public` like `image` / `decoration`.
   */
  pageBackground?: string;
  /**
   * Optional background override that takes effect ONLY when the
   * page renders in `layout: "image-choices"` mode (i.e. after the
   * Collect Rewards gate has been dismissed). When set:
   *   - Replaces `pageBackground` (and the default storybook bg)
   *     for the image-choices render only — the pre-rewards
   *     standard-layout render still uses `pageBackground`.
   *   - Suppresses the centred focal `<figure>` from the image-
   *     choices markup — the background IS the focal art at that
   *     point, so duplicating it as a small centred image would
   *     just compete with itself.
   * Use when a page wants different backdrop art for "you're
   * reading the narrative" vs "you're picking where to go next"
   * (e.g. Ch1 page7's Bram-portrait-while-reading vs the labelled
   * Bird's Nest map for the actual pub/library choice prompt).
   * Path is served from `/public` like `image` / `pageBackground`.
   */
  layoutBackground?: string;
  /** Side-effects fired exactly once when the page is first entered. */
  onEnter?: TownVisitAction[];
  /** Linear next-page id. Mutually exclusive with `choices`. */
  next?: string;
  /**
   * "Roll a die" page: renders a Roll button; the d6 result picks the
   * matching outcome bracket and navigates to its `next`. Mutually
   * exclusive with `next` / `choices`. Used by Ch3's eavesdrop /
   * sneak / jobs-board rolls.
   */
  dieRoll?: TownVisitDieOutcome[];
  /**
   * Ch3+: launch a playable Quest from this page. Renders a "Descend
   * into the Tide" button that moves the visit on to `next` (where it
   * resumes when the quest ends) and opens the quest's Story intro.
   */
  startQuest?: string;
  /** Branching choice list. Mutually exclusive with `next`. */
  choices?: TownVisitChoice[];
  /** Page renderer override.
   *   - `"shop"` swaps in the Shop sub-screen (wallets + product
   *     grid + Continue/Finish button driven by `next`).
   *   - `"end-town-visit"` marks a terminal narrative page; the
   *     action renderer mounts a "Finish Town Visit" button instead
   *     of the defensive "Return to Title" fallback. Use when a
   *     narrative beat is the final step of the visit and shouldn't
   *     advance further (no `next`, no `choices`).
   *   - omitted (default) is a normal narrative page: `next` renders
   *     Continue, `choices` renders branch buttons.
   */
  kind?: "shop" | "end-town-visit" | "townsfolk-assignment";
  /**
   * Optional layout override that changes how the page is composed.
   * Defaults to the standard storybook article + side portrait
   * layout. Other values:
   *
   *   - `"image-choices"`: suppresses the storybook article (title,
   *     eyebrow, body text, footnote) entirely and renders the page
   *     `image` LARGE and CENTERED with the navigation row
   *     (`choices` / `next`) below it. Use on pages whose narrative
   *     has already been delivered by an upstream Story screen or a
   *     prior page in the same visit — i.e. the page exists purely
   *     as a "where do you go next?" choice prompt and would
   *     otherwise repeat content the player just read.
   *     The page must still carry `image` (the focal art) and one
   *     of `choices` / `next` for the layout to make sense; missing
   *     `image` falls back to the standard layout with a warning
   *     logged to the session log.
   *     The typewriter is skipped on this layout (there's no body
   *     text to reveal), so `onEnter` rewards still fire and gate
   *     the navigation row exactly as they would on a normal page.
   */
  layout?: "image-choices";
}

export type TownVisitChapterId = "ch1" | "ch2" | "ch3" | "ch4";

export interface TownVisitChapter {
  id: TownVisitChapterId;
  name: string;
  startPageId: string;
  pages: Record<string, TownVisitPage>;
}

// --- Shop ----------------------------------------------------------------

/**
 * A printed Shop Card. Cost is split across the part denominations
 * the shop deals in. `variableMinionParts: true` flags the donation
 * card (#08) — its cost is set by the player at purchase time.
 *
 * `category` mirrors the rulebook taxonomy:
 *   - "Quest Bonus"       - applies at the start of each Quest.
 *   - "Wave Bonus"        - applies at the start of each Wave.
 *   - "Equipment Upgrade" - replaces an existing Equipment deck (Machinist).
 *   - "Delving Academy"   - donation; flavor only.
 */
export interface ShopProductCost {
  minionParts: number;
  bossLvl1: number;
  bossLvl2: number;
  /** LVL 3 boss parts (Ch3+ products like #43 Sword of Ruin). Optional — absent = 0. */
  bossLvl3?: number;
  /** LVL 4 boss parts (#30, #38, #45). Optional — absent = 0. */
  bossLvl4?: number;
  variableMinionParts?: boolean;
}

/**
 * Structured form of a shop product's mechanical effect. Each
 * variant maps to one engine mutation; a single product can
 * declare multiple grants (the donation card declares none).
 *
 * `scope` decides WHEN the grant fires:
 *   - `"quest"`  - applied once per quest, the first time the
 *                  player enters that quest's encounter. Idempotent
 *                  via `state.shopGrantsAppliedQuests`.
 *   - `"wave"`   - applied at the start of EVERY wave (Q2 W1, W2,
 *                  W3 ..., AND on every wave retry). The product's
 *                  `effectText` reads "Start each Wave with ...".
 *
 * The variants:
 *   `equipment-rank-bump`  Add `amount` ranks to the buyer's
 *                          `state.equipmentRanks[heroId][type]`,
 *                          capped at 5 per rulebook p24. Hand
 *                          panel auto-picks up the new rank.
 *   `consumable-tokens`    Add `amount` available tokens of
 *                          `tokenKind` to the buyer's
 *                          `state.consumableTokens[heroId]` bag.
 *   `damage-bonus`         Add `amount` to the buyer's
 *                          per-damage-type bonus pool (new in
 *                          schema v33: `state.shopDamageBonus`).
 *                          Combat consumes it on every weapon
 *                          swing of that damage type.
 *   `element-tokens`       Add `amount` element tokens of
 *                          `element` to `state.elements[heroId]`.
 *                          Used by Wave-Bonus products.
 *   `equipment-upgrade`    Approximation of the physical Machinist
 *                          card-swap mechanic (no digital deck of
 *                          rank-2 cards exists yet): grant the
 *                          buyer +`bonusRanks` ranks in `type`.
 *                          When the physical Equipment Upgrade
 *                          Deck gets digitised, swap this variant
 *                          for `equipment-replace`.
 *   `donation`             No mechanical effect. Present so the
 *                          donation product (#8) can have an
 *                          empty `grants: []` and still type-check
 *                          as "intentionally side-effect free"
 *                          rather than "forgot to author grants".
 */
export type ShopProductGrant =
  | { kind: "equipment-rank-bump"; scope: "quest"; equipmentType: EquipmentType; amount: number }
  | { kind: "consumable-tokens"; scope: "quest"; tokenKind: string; amount: number }
  | { kind: "damage-bonus"; scope: "quest"; damageType: DamageType; amount: number }
  | { kind: "element-tokens"; scope: "wave"; element: Element; amount: number }
  | { kind: "equipment-upgrade"; scope: "quest"; equipmentType: EquipmentType; bonusRanks: number }
  | { kind: "donation"; scope: "quest" };

export interface ShopProduct {
  number: number;
  name: string;
  location: string;
  category: "Quest Bonus" | "Wave Bonus" | "Equipment Upgrade" | "Delving Academy";
  cost: ShopProductCost;
  effectText: string;
  /**
   * Structured grants applied by the engine when this product is
   * owned. See {@link ShopProductGrant} for the variant menu and
   * when each scope fires. An empty array means "no mechanical
   * effect" (currently only the donation product).
   */
  grants: ShopProductGrant[];
  /** "Only [Mind/Body] can purchase" (Ch4 #23 / #24 Delversuits). */
  onlySuit?: Suit;
}
