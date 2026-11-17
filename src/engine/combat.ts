/**
 * Combat resolution (DESIGN.md §5.4).
 *
 * Owns:
 *   1. Counter-attack die thresholds (rulebook p23) — exported for tests.
 *   2. Hit-tile computation per `WeaponRange` kind (`computeWeaponHitTiles`).
 *   3. Per-tile damage application (`applyDamageAtTile`).
 *   4. Counter-attack application (`applyCounter`) — caller passes the
 *      d6 value the player physically rolled.
 *   5. A session-based resolver (`buildAttackSession` /
 *      `resolveAllDamage` / `resolveSharedCounter` /
 *      `finalizeAttackSession`) so the UI layer can prompt for a
 *      single shared d6 covering every damaged enemy without
 *      coupling combat to DOM.
 *
 * Counter model (DESIGN.md §5.4 — confirmed by user 2026-05-02):
 *   - All damage is applied first, in hit-tile order.
 *   - Then ONE shared d6 is rolled covering the counter-attacks of
 *     every damaged enemy. Each damaged enemy uses its own
 *     counter-pattern (common vs. uncommon offsets) but shares the
 *     same outcome derived from the single roll.
 *   - If no possible roll outcome could land on a delver (i.e., none
 *     of the damaged enemies' offsets, common or uncommon, intersect
 *     a delver position), the roll is skipped entirely.
 *
 * What this module does NOT own:
 *   - The "use weapon ability" gate (that's `engine/turn.ts >
 *     useWeaponAbility`).
 *   - On-death side-effects (that's `engine/kills.ts > applyKill`).
 *   - XP-to-level resolution (that's `engine/kills.ts >
 *     applyPendingLevelUps`, called once via `finalizeAttackSession`).
 */

import { damageDelverInWave, hasEnemyAbility, onEnemyDiedForRebirth } from "./omenRebirth";
import { LAST_ACT_DAMAGE, SPIKED_DAMAGE, SPIKED_THRESHOLD, backupExtras, clearRitual, evasiveApplies, exhaustOneToken, isMeleeAttack, returnStolenWeapon, stealWeapon } from "./questAbilities";
import type {
  CampaignState,
  EnemyFacing,
  EnemyInstance,
  EncounterState,
} from "../state";
import { getEffectiveEquipmentRank } from "../state";
import type {
  DamageType,
  EnemyAbility,
  EnemyCard,
  EquipmentCard,
  EquipmentEffect,
  WeaponRange,
  Offset,
  Element,
} from "../types";
import { Tuning } from "../config/tuning";
import { ADJACENT_OFFSETS_8WAY } from "../rules";
import { getEnemy, getEquipment, getEquipmentByTypeSuitRank, getHero, getDelverBoard, getQuestData } from "../data";
import { applyKill, applyPendingLevelUps, grantElementToDelver, type KillResult } from "./kills";
import type { BoardBounds } from "./movement";
import { clampDamageForFatalFlaw, isFatalFlawProtected, getEnemyAt, getDelversAt } from "./encounter";
import { getEquipmentCardFor } from "../state";
import { spendToken } from "./tokens";
import { onDelverDamaged } from "./wave";
import { enqueueCreaturePartChoice } from "./creatureParts";
import { logEvent } from "../debug/sessionLog";
import { recordAbilityProc, type AbilityProcKind } from "./abilityProcs";

// --- Counter-attack die thresholds (rulebook p23) ------------------------

export const COUNTER_ROLL = {
  miss:     { min: 1, max: 1 },
  common:   { min: 2, max: 5 },
  uncommon: { min: 6, max: 6 },
} as const;

export type CounterAttackOutcome = "miss" | "common" | "uncommon";

/** Classify a d6 roll into the corresponding counter-attack outcome. */
export function counterAttackOutcomeForRoll(roll: number): CounterAttackOutcome {
  if (roll <= COUNTER_ROLL.miss.max) return "miss";
  if (roll <= COUNTER_ROLL.common.max) return "common";
  return "uncommon";
}

// --- Damage value --------------------------------------------------------

/**
 * Raw damage from `card`'s printed text — `damageMultiplier *
 * Tuning.damageBase[damageType]` — without consulting the delver's
 * upgrade rank.
 *
 * Prefer `effectiveDamageForCard` everywhere except tests that
 * intentionally pin the R1 baseline.
 */
export function damageValueForCard(card: EquipmentCard): number {
  if (!card.damageType || card.damageMultiplier == null) return 0;
  return card.damageMultiplier * Tuning.damageBase[card.damageType];
}

/**
 * Damage dealt by a single attack from `card`, AFTER the active
 * delver's per-equipment-type upgrade rank is applied AND any
 * matching Shop Damage Bonus added on top.
 *
 * The damage multiplier is the one PRINTED on the rank-correct card
 * (`rankedCard.damageMultiplier`), NOT the rank itself. For most
 * weapons the two coincide (R3 Chain Gauntlet prints "3x LIGHT"),
 * but NOT for all — verified against the card JPGs 2026-07-20:
 *
 *   - Hammer (both suits): R1 and R2 both print plain "HEAVY
 *     damage" (R2 only adds the 3-tile line + drops the
 *     suffer-1-to-change-direction cost); the multiplier ramp is
 *     offset one rank (R3 = 2x, R4 = 3x, R5 = 4x).
 *   - Trident (both suits): same offset (R2 = 1x MEDIUM, R3 = 2x,
 *     ...); only the counter-block amount scales 1:1 with rank.
 *
 * Pre-2026-07-20 this computed `rank * damageBase`, which dealt 8
 * with an unbuffed R2 Hammer (player report: should be 4).
 *
 * Volume-scaling weapons (Scorchline Beam R2-R5) fall out naturally:
 * their printed per-swing multiplier stays 1 at every rank and the
 * extra ranks scale via the `repeat-attack` effect (one bonus FREE
 * swing per count) instead — same total ceiling as Ion Cannon at
 * rank N when every repeat connects.
 *
 * Shop Damage Bonus is a flat +N on top of the multiplied damage —
 * owning "+1 LIGHT Damage" (shop product #5) adds +1 to every light
 * swing for the whole quest. See `engine/shopGrants.ts` for the
 * apply path and `state.shopDamageBonus` for the bag.
 *
 * Falls back to the passed card's rank if the rank table is missing
 * the entry — defensive, should never happen in practice (every
 * starter type starts at R1).
 */
export function effectiveDamageForCard(
  state: CampaignState,
  heroId: string,
  card: EquipmentCard,
): number {
  if (!card.damageType || card.damageMultiplier == null) return 0;
  // Effective rank folds in any Opinion-Card temporary bonus
  // (Xavier Ally / Confidant / Detractor) on top of the printed
  // `equipmentRanks` value, so a Xavier bump actually drives damage
  // through the rank-correct card lookup below.
  const effective = getEffectiveEquipmentRank(state, heroId, card.type);
  const rank = effective > 0 ? effective : (card.rank ?? 1);
  // Look up the rank-correct card because the passed-in `card` is
  // typically the R1 placeholder from
  // `state.loadouts[heroId].slotCards[slotIdx]`.
  const rankedCard = getEquipmentCardFor(state, heroId, card.type, rank);
  const multiplier = rankedCard.damageMultiplier ?? card.damageMultiplier;
  // A Machinist upgrade can print a different damage type than the
  // standard card (Lunar Trident MEDIUM vs Trident) - use the ranked card's.
  const damageType = rankedCard.damageType ?? card.damageType;
  // The damage track's bonus raises the BASE value (LIGHT 1 -> 2 etc.), so
  // a 2x card doubles the raised base.
  return multiplier * (Tuning.damageBase[damageType] + shopDamageBonusFor(state, heroId, damageType));
}

/**
 * Damage dealt by a slot-ability `damage-any-enemy` of the given
 * type. Stateless variant — preserves the legacy contract used by
 * tests + any caller that doesn't have a delver context. Prefer
 * `effectiveDamageForType` everywhere the firing delver is known
 * so the Shop Damage Bonus pool feeds through.
 */
export function damageValueForType(
  damageType: keyof typeof Tuning.damageBase,
): number {
  return Tuning.damageBase[damageType];
}

/**
 * Damage dealt by a slot-ability of `damageType`, after the named
 * delver's Shop Damage Bonus is applied. Mirrors
 * `effectiveDamageForCard` for the non-weapon-card damage path so
 * a player who bought "+2 MEDIUM damage" sees the bonus on BOTH
 * weapon swings AND slot-ability medium-typed damage.
 */
export function effectiveDamageForType(
  state: CampaignState,
  heroId: string,
  damageType: keyof typeof Tuning.damageBase,
): number {
  return Tuning.damageBase[damageType] + shopDamageBonusFor(state, heroId, damageType);
}

/**
 * Per-delver Shop Damage Bonus lookup. Returns 0 when no bonus is
 * recorded (missing hero entry, missing damage-type entry, or
 * legacy save loaded before v33).
 */
function shopDamageBonusFor(
  state: CampaignState,
  heroId: string,
  damageType: keyof typeof Tuning.damageBase,
): number {
  const bag = state.shopDamageBonus?.[heroId];
  if (!bag) return 0;
  return bag[damageType] ?? 0;
}

// --- Hit-tile computation ------------------------------------------------

export interface HitTile {
  x: number;
  y: number;
  /** Per-hit damage override (Engulfing Beam's all-enemies LIGHT,
   *  Precise Shockwave's adjacent HEAVY). Absent = `session.damage`. */
  damage?: number;
  /** Damage type of this hit when it differs from the weapon's (read by
   *  Immunity). Absent = `session.damageType`. */
  damageType?: DamageType;
}

export interface ComputeHitTilesArgs {
  range: WeaponRange;
  attackerPos: { x: number; y: number };
  /** The OTHER delver's position, if any (used by `chain` precondition). */
  otherDelverPos: { x: number; y: number } | null;
  encounter: EncounterState;
  board: BoardBounds;
  /** Required for `range.kind === "die-roll-fixed"`. */
  dieRoll?: number;
  /**
   * Required for `single-adjacent`, `straight-line`, and `chain`. The
   * tile the user clicked as the intended target / start of the chain.
   */
  chosenStartTile?: { x: number; y: number };
  /** `choose-targets` (Precise Shockwave): the player's picked tiles. */
  chosenTargets?: { x: number; y: number }[];
}

export type HitTilesResult =
  | { ok: true; tiles: HitTile[] }
  | { ok: false; reason: string };

/**
 * Compute the list of board tiles affected by the given weapon range.
 * Pure function — does not touch state. See DESIGN.md §5.4.3 for the
 * per-kind contract.
 */
export function computeWeaponHitTiles(args: ComputeHitTilesArgs): HitTilesResult {
  const { range, attackerPos, encounter, board } = args;
  switch (range.kind) {
    case "single-adjacent":  return computeSingleAdjacent(args);
    case "straight-line":    return computeStraightLine(args);
    case "die-roll-fixed":   return computeDieRollFixed(args);
    case "chain":            return computeChain(args);
    case "fixed-pattern":    return computeFixedPattern(args);
    case "between-delvers":  return computeBetweenDelvers(args);
    case "choose-targets":   return computeChosenTargets(args, range.maxDistance);
  }
  // Exhaustive — TS will error if a new range.kind is added without a branch.
  void encounter; void board; void attackerPos;
  return { ok: false, reason: `unknown range.kind` };
}

/** Fabled Hammer: enemy tiles strictly between the two delvers, who must
 *  be in a straight line (row, column or diagonal). */
function computeBetweenDelvers(args: ComputeHitTilesArgs): HitTilesResult {
  const { attackerPos, otherDelverPos, encounter } = args;
  if (!otherDelverPos) return { ok: false, reason: "the other delver isn't on the board" };
  const dx = otherDelverPos.x - attackerPos.x;
  const dy = otherDelverPos.y - attackerPos.y;
  if (!(dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy)) || (dx === 0 && dy === 0)) {
    return { ok: false, reason: "the delvers aren't in a straight line to each other" };
  }
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  const tiles: HitTile[] = [];
  for (let i = 1; i < steps; i++) {
    const x = attackerPos.x + Math.sign(dx) * i;
    const y = attackerPos.y + Math.sign(dy) * i;
    if (getEnemyAt(encounter, x, y)) tiles.push({ x, y });
  }
  if (tiles.length === 0) return { ok: false, reason: "no enemies between the delvers" };
  return { ok: true, tiles };
}

/** Precise Shockwave: the player's chosen enemy tiles, each within
 *  `maxDistance` tiles (8-way) of the attacker. */
function computeChosenTargets(args: ComputeHitTilesArgs, maxDistance: number): HitTilesResult {
  const { attackerPos, encounter, chosenTargets } = args;
  if (!chosenTargets || chosenTargets.length === 0) return { ok: false, reason: "no targets chosen" };
  const seen = new Set<string>();
  for (const t of chosenTargets) {
    const k = `${t.x},${t.y}`;
    if (seen.has(k)) return { ok: false, reason: "a target was chosen twice" };
    seen.add(k);
    if (Math.max(Math.abs(t.x - attackerPos.x), Math.abs(t.y - attackerPos.y)) > maxDistance) {
      return { ok: false, reason: `a target is more than ${maxDistance} tiles away` };
    }
    if (!getEnemyAt(encounter, t.x, t.y)) return { ok: false, reason: "no live enemy on a chosen tile" };
  }
  return { ok: true, tiles: chosenTargets.map((t) => ({ x: t.x, y: t.y })) };
}

function computeSingleAdjacent(args: ComputeHitTilesArgs): HitTilesResult {
  const { attackerPos, encounter, chosenStartTile } = args;
  if (!chosenStartTile) return { ok: false, reason: "no target tile chosen" };
  if (!isAdj8(attackerPos, chosenStartTile)) {
    return { ok: false, reason: "target tile not adjacent to attacker" };
  }
  if (!getEnemyAt(encounter, chosenStartTile.x, chosenStartTile.y)) {
    return { ok: false, reason: "no live enemy on target tile" };
  }
  return { ok: true, tiles: [{ ...chosenStartTile }] };
}

function computeStraightLine(args: ComputeHitTilesArgs): HitTilesResult {
  const { range, attackerPos, encounter, board, chosenStartTile } = args;
  if (range.kind !== "straight-line") return { ok: false, reason: "wrong range kind" };
  if (!chosenStartTile) return { ok: false, reason: "no target tile chosen" };

  // Derive the direction from the chosen tile.
  const dx = Math.sign(chosenStartTile.x - attackerPos.x);
  const dy = Math.sign(chosenStartTile.y - attackerPos.y);
  if (dx === 0 && dy === 0) {
    return { ok: false, reason: "target tile is attacker's tile" };
  }
  // Cardinal lines: one of dx/dy is zero. Diagonals: both non-zero AND
  // |Δx| == |Δy|. Anything else isn't on a straight 8-way line.
  const isDiag = dx !== 0 && dy !== 0;
  if (isDiag && !range.includeDiagonals) {
    return { ok: false, reason: "diagonals not allowed for this range" };
  }
  const ddx = Math.abs(chosenStartTile.x - attackerPos.x);
  const ddy = Math.abs(chosenStartTile.y - attackerPos.y);
  if (isDiag && ddx !== ddy) {
    return { ok: false, reason: "target tile not on a straight diagonal" };
  }
  if (!isDiag && ((dx !== 0 && ddy !== 0) || (dy !== 0 && ddx !== 0))) {
    return { ok: false, reason: "target tile not on a straight line" };
  }

  // Walk from attacker outward. firstTargetOnly: the first live enemy in
  // the ray is the hit. Otherwise (Engulfing Beam "all targets in any
  // straight line") every live enemy in the ray is hit.
  const tiles: HitTile[] = [];
  let x = attackerPos.x + dx;
  let y = attackerPos.y + dy;
  while (x >= 0 && y >= 0 && x < board.w && y < board.h) {
    const enemy = getEnemyAt(encounter, x, y);
    if (enemy) {
      tiles.push({ x, y });
      if (range.firstTargetOnly) break;
    }
    x += dx;
    y += dy;
  }
  if (tiles.length === 0) return { ok: false, reason: "no enemy in that direction" };
  return { ok: true, tiles };
}

function computeDieRollFixed(args: ComputeHitTilesArgs): HitTilesResult {
  const { range, attackerPos, board, dieRoll } = args;
  if (range.kind !== "die-roll-fixed") return { ok: false, reason: "wrong range kind" };
  if (dieRoll == null) return { ok: false, reason: "no die roll provided" };
  if (dieRoll < 1 || dieRoll > 6) return { ok: false, reason: `die roll ${dieRoll} out of range` };

  const matched = range.rolls.find((r) => dieRoll >= r.min && dieRoll <= r.max);
  if (!matched) return { ok: false, reason: `no rolls entry covers ${dieRoll}` };

  // Translate offsets to absolute coords, clipping out-of-bounds tiles.
  // (Out-of-bounds tiles are silently dropped — they're effectively misses.)
  const tiles: HitTile[] = [];
  for (const off of matched.tiles) {
    const x = attackerPos.x + off.dx;
    const y = attackerPos.y + off.dy;
    if (x < 0 || y < 0 || x >= board.w || y >= board.h) continue;
    tiles.push({ x, y });
  }
  return { ok: true, tiles };
}

/**
 * `fixed-pattern` (Trident — both suits R1): the card prints a fixed
 * list of `{dx, dy}` offsets relative to the attacker. Every printed
 * tile fires every swing — no targeting picker, no roll. Identical
 * shape to `die-roll-fixed.matched.tiles` but the pattern is locked.
 *
 * Out-of-bounds tiles are silently dropped (matches die-roll-fixed
 * convention — they're effectively misses, the swing still happens).
 * Tiles with no live enemy are still returned and resolved as misses
 * by `resolveAllDamage` (the standard "hit tile with no live enemy
 * is a miss" rule, DESIGN.md §5.4.3).
 *
 * Empty result is allowed — the swing fires but lands no damage.
 * The action is still consumed (matches the standard behavior for
 * die-roll-fixed when every printed offset is off-board).
 *
 * NOTE: `attackerPos` is also dropped from the result if it appears
 * in the pattern (a self-targeting swing would be nonsense). Today
 * no printed Trident pattern includes `(0, 0)` so this is a defensive
 * guard rather than a routine path.
 */
function computeFixedPattern(args: ComputeHitTilesArgs): HitTilesResult {
  const { range, attackerPos, board } = args;
  if (range.kind !== "fixed-pattern") return { ok: false, reason: "wrong range kind" };

  const tiles: HitTile[] = [];
  for (const off of range.tiles) {
    if (off.dx === 0 && off.dy === 0) continue;
    const x = attackerPos.x + off.dx;
    const y = attackerPos.y + off.dy;
    if (x < 0 || y < 0 || x >= board.w || y >= board.h) continue;
    tiles.push({ x, y });
  }
  return { ok: true, tiles };
}

function computeChain(args: ComputeHitTilesArgs): HitTilesResult {
  const { range, attackerPos, encounter, otherDelverPos, chosenStartTile } = args;
  if (range.kind !== "chain") return { ok: false, reason: "wrong range kind" };
  if (!chosenStartTile) return { ok: false, reason: "no chain start tile chosen" };
  const startEnemy = getEnemyAt(encounter, chosenStartTile.x, chosenStartTile.y);
  if (!startEnemy) return { ok: false, reason: "no live enemy on chain start tile" };

  // BFS over enemies connected 8-way starting from `chosenStartTile`.
  const visited = new Set<string>();
  const queue: HitTile[] = [{ x: chosenStartTile.x, y: chosenStartTile.y }];
  const tiles: HitTile[] = [];
  while (queue.length) {
    const cur = queue.shift()!;
    const k = key(cur.x, cur.y);
    if (visited.has(k)) continue;
    visited.add(k);
    tiles.push(cur);
    for (const off of ADJACENT_OFFSETS_8WAY) {
      const nx = cur.x + off.dx;
      const ny = cur.y + off.dy;
      if (visited.has(key(nx, ny))) continue;
      if (getEnemyAt(encounter, nx, ny)) queue.push({ x: nx, y: ny });
    }
  }

  // Precondition: at least one enemy in the chain must be 8-way
  // adjacent to the configured anchor delver.
  //   - "self":  Chain Gauntlet — the attacker must be adjacent.
  //   - "other": Surge Claw     — the OTHER delver must be adjacent.
  if (range.requiresAdjacentTo === "self") {
    const anyAdj = tiles.some((t) => isAdj8(t, attackerPos));
    if (!anyAdj) {
      return { ok: false, reason: "attacker not adjacent to any enemy in chain" };
    }
  } else {
    if (!otherDelverPos) {
      return { ok: false, reason: "no other delver on board for chain precondition" };
    }
    const anyAdj = tiles.some((t) => isAdj8(t, otherDelverPos));
    if (!anyAdj) {
      return { ok: false, reason: "other delver not adjacent to any enemy in chain" };
    }
  }

  return { ok: true, tiles };
}

// --- Per-tile damage -----------------------------------------------------

/**
 * Apply `damage` to whatever live enemy occupies (x, y). Returns the
 * affected enemy and whether it died (HP reached 0). Empty tile = no-op
 * (returns null + killed=false).
 */
export function applyDamageAtTile(
  state: CampaignState,
  x: number,
  y: number,
  damage: number,
): { enemy: EnemyInstance | null; killed: boolean } {
  const enc = state.encounter;
  if (!enc) return { enemy: null, killed: false };
  const enemy = getEnemyAt(enc, x, y);
  if (!enemy) return { enemy: null, killed: false };

  // Fatal Flaw clamp — tier N enemies are pinned at >= 1 HP while
  // any tier-(N-1) enemy is still alive (rulebook p16). The helper
  // is a no-op for non-flaw enemies (Q1) and for flaw enemies whose
  // lower tier is fully cleared, so this is safe to always run.
  const card = getEnemy(enemy.cardId);
  const capped = stoutCappedDamage(card, damage);
  if (capped < damage) recordAbilityProc(enemy, "stout");
  const clamp = clampDamageForFatalFlaw(enc, enemy, capped);
  enemy.damageTaken = clamp.newDamageTaken;
  if (clamp.blocked) {
    recordAbilityProc(enemy, "fatal-flaw");
    logEvent("combat.fatalFlawBlocked", {
      instanceId: enemy.instanceId,
      cardId: enemy.cardId,
      absorbedDamage: clamp.absorbed,
      site: "applyDamageAtTile",
    });
  }
  const killed = enemy.damageTaken >= card.hp;
  if (killed) enemy.alive = false;
  return { enemy, killed };
}

// --- Counter-attacks ----------------------------------------------------

export interface CounterHit {
  heroId: string;
  damage: number;
}

/**
 * Rotate a single offset around (0, 0) by `facing` degrees clockwise.
 *
 * Coordinate convention (matches the rest of this codebase): +x = east
 * (right), +y = south (down). Quarter-turn CW rotation under that
 * convention sends (dx, dy) → (-dy, dx).
 *
 *   facing 0   → (dx,  dy)
 *   facing 90  → (-dy, dx)
 *   facing 180 → (-dx, -dy)
 *   facing 270 → (dy,  -dx)
 *
 * Pure helper, no allocation pooling — caller decides what to do with
 * the returned tuple. Used by every counter-projection site so a
 * Slip-Strider-rotated enemy's pattern lands on the right tiles.
 */
export function rotateOffset(off: Offset, facing: EnemyFacing): Offset {
  // The `+ 0` on each axis canonicalises JS's signed zero: `0 * -1`
  // produces `-0`, which compares equal to `+0` numerically but
  // breaks deep-equality in tests and serialises differently. Forcing
  // `+0` keeps the output canonical for both call sites and tests.
  switch (facing) {
    case 0:   return { dx: off.dx + 0,  dy: off.dy + 0 };
    case 90:  return { dx: -off.dy + 0, dy: off.dx + 0 };
    case 180: return { dx: -off.dx + 0, dy: -off.dy + 0 };
    case 270: return { dx: off.dy + 0,  dy: -off.dx + 0 };
  }
}

/**
 * Counter-pattern offsets for a given (card, facing, outcome). Single
 * accessor so adding a new facing-aware behaviour means changing one
 * place. Returns a fresh array (rotated by `rotateOffset`) — callers
 * must not mutate.
 *
 * `outcome` is restricted to the two strike outcomes; "miss" callers
 * should short-circuit before reaching this function.
 */
export function counterOffsetsFor(
  card: EnemyInstance | string | { cardId: string },
  facing: EnemyFacing,
  outcome: CounterAttackOutcome,
): Offset[] {
  const cardId = typeof card === "string"
    ? card
    : "cardId" in card ? card.cardId : (card as EnemyInstance).cardId;
  const printed = getEnemy(cardId);
  // All-Claw: a roll of 1 is not a miss for this enemy - it fires BOTH
  // printed patterns. Every other enemy hits nothing on a 1.
  const raw: readonly Offset[] = outcome === "miss"
    ? (hasAllClaw(cardId) ? [...printed.counterCommon, ...printed.counterUncommon] : [])
    : outcome === "common"
      ? printed.counterCommon
      : printed.counterUncommon;
  return raw.map((o) => rotateOffset(o, facing));
}

/**
 * Resolve a counter-attack from the just-damaged `enemy` given a
 * physically-rolled `rolled` d6. Mutates state — applies HP loss to
 * any delver on a counter-pattern tile (CHEbyshev offsets from the
 * enemy's tile, rotated by the enemy's current `facing`). Returns
 * the outcome + hits for the resolution log.
 */
export function applyCounter(
  state: CampaignState,
  enemy: EnemyInstance,
  rolled: number,
): { outcome: CounterAttackOutcome; hits: CounterHit[] } {
  const outcome = counterAttackOutcomeForRoll(rolled);
  if (outcome === "miss" && !hasAllClaw(enemy.cardId)) return { outcome, hits: [] };

  const enc = state.encounter;
  if (!enc) return { outcome, hits: [] };
  const card = getEnemy(enemy.cardId);
  const offsets = counterOffsetsFor(enemy, enemy.facing, outcome);
  const damage = enemyCounterDamage(state, card, enemy.instanceId);
  const hits: CounterHit[] = [];

  // Collect unique hero ids hit (a hero standing on multiple offset tiles
  // would only be hit once per offset entry; offsets are distinct tiles
  // by construction). Damage stacks per offset that lands on the hero.
  for (const off of offsets) {
    const tx = enemy.x + off.dx;
    const ty = enemy.y + off.dy;
    const onTile = getDelversAt(enc, tx, ty);
    for (const heroId of onTile) {
      const loadout = state.loadouts[heroId];
      if (!loadout) continue;
      hits.push({ heroId, damage: damageDelverInWave(state, heroId, damage, card) });
    }
  }

  return { outcome, hits };
}

// --- Session-based resolver ---------------------------------------------

export type AttackSource =
  | { kind: "weapon"; slotIdx: number; cardId: string }
  | { kind: "slot"; slotIdx: number; element: Element };

export interface ResolvedAttackStep {
  tile: HitTile;
  /** null if the tile had no live enemy (a miss). */
  enemyInstanceId: string | null;
  /** Damage actually applied (0 on a miss). */
  damageApplied: number;
  killed: boolean;
  /** Populated when `killed === true`. */
  killResult?: KillResult;
  /** Damage the Fatal Flaw clamp held back on this hit (re-applied by the
   *  cascade pass if the lower tiers die in the same attack). */
  flawAbsorbed?: number;
}

/**
 * Snapshot of an enemy that took damage during the damage phase. We
 * snapshot rather than re-look-up because the enemy may be killed +
 * removed (alive=false) before the counter resolves.
 *
 * `facing` is captured at damage time so the counter projects from
 * the orientation the enemy had when it was struck — even if some
 * later effect somehow rotated it before the counter resolved.
 */
export interface DamagedEnemySnapshot {
  instanceId: string;
  cardId: string;
  x: number;
  y: number;
  facing: EnemyFacing;
  /** Extra counterattacker that wasn't hit itself (Countdown / Frenzy
   *  triggers). Its counter uses the same roll, but post-counter
   *  passives (Rotates, Strength, Flees, Teleports, Alert) skip it. */
  bonus?: boolean;
  /** Accurate: the attacker held this boss's monster token when they
   *  struck, so the counterattack always hits them (whatever the roll). */
  accurateTarget?: string;
}

/**
 * The single counter-attack phase that runs after all damage is
 * applied. `anyCanLand` is precomputed at damage time — if false,
 * the UI skips the roll prompt entirely (DESIGN.md §5.4).
 */
export interface SharedCounterPhase {
  damagedEnemies: DamagedEnemySnapshot[];
  /** True iff at least one damaged enemy's common-OR-uncommon pattern lands on a delver. */
  anyCanLand: boolean;
  /** -1 = not yet rolled (or auto-skipped because !anyCanLand). */
  rolled: number;
  outcome: CounterAttackOutcome;
  /** Aggregated counter hits across every damaged enemy for `outcome`. */
  hits: CounterHit[];
  /** Set true after `resolveSharedCounter` (or auto-skip) has applied. */
  resolved: boolean;
  /** The strikes that landed (before shields), by enemy - read by the
   *  Ch4 Shell / Soul Sap / Corruption passives. */
  strikes?: CounterStrike[];
}

export interface AttackSession {
  attackerId: string;
  source: AttackSource;
  damage: number;
  /** Printed damage type of the weapon / slot ability (null = untyped).
   *  Read by the Immunity ability. */
  damageType: DamageType | null;
  /** Engulfing Beam "Spend 1 Fire: Block counterattacks": no enemy
   *  counterattacks this swing. */
  blockCounterattacks?: boolean;
  /** Sword of Ruin "If target dies, gain 1 Wind": granted to the
   *  attacker in `finalizeAttackSession` when any hit enemy died. */
  gainElementOnKill?: { element: Element; amount: number };
  hitTiles: HitTile[];
  /** Per-tile damage outcomes — populated by `resolveAllDamage`. */
  steps: ResolvedAttackStep[];
  /**
   * The shared counter phase — populated by `resolveAllDamage` and
   * mutated by `resolveSharedCounter`. `null` until damage is resolved.
   */
  sharedCounter: SharedCounterPhase | null;
  /** Set true after `finalizeAttackSession` has run (idempotency guard). */
  finalized: boolean;
  /**
   * Auto-applied side-effects collected at session start that should be
   * surfaced in the resolution log (e.g. self-suffer for body-void slot
   * ability, +1 creature part for Surge Claw). Keyed for the UI; engine
   * already mutated state when it set these.
   */
  preEffects: PreEffect[];
  postEffects: PostEffect[];
  /** Number of level-ups produced by `finalizeAttackSession` (caches). */
  levelUpsApplied: number;
}

/**
 * One-shot effect that fired BEFORE the attack's damage was computed
 * (and is recorded on the session for the UI / log to surface).
 *
 *   - `self-suffer`: Hammer's `may-reroll-by-suffering` paid 1 HP to
 *     flip the d6 result. `heroId` is the suffering delver, `amount`
 *     is the HP cost (always 1 today).
 *
 *   - `pre-attack-move-enemy`: Trident's `pre-attack-may-move-adjacent`
 *     pushed an adjacent enemy 1 tile BEFORE damage resolved. The
 *     printed pattern then targeted the enemy's NEW position. The
 *     `heroId` of the bearer who moved it is stamped so the log can
 *     surface "Mind delver moved Crystanid #2 from (1,3) to (2,4)".
 *     The enemy MAY have died on the same swing if the pattern hit
 *     its new tile — that lives on the corresponding `session.steps`
 *     entry, not here.
 */
export type PreEffect =
  | { kind: "self-suffer"; heroId: string; amount: number }
  | {
      kind: "pre-attack-move-enemy";
      heroId: string;
      enemyInstanceId: string;
      from: { x: number; y: number };
      to: { x: number; y: number };
    }
  /**
   * Supercharger / future "double damage" token spend recorded on
   * the session. Fires BEFORE damage is computed (the
   * `useWeaponAbility` resolver doubles the swing damage in the
   * same tick); this entry is the audit trail / log.
   *
   * `tokenKind` distinguishes which kind was spent (typed Light /
   * Medium / Heavy or Universal). UI uses it to surface
   * "Spent 1 x 2x LIGHT token" in the log / damage breakdown.
   */
  | {
      kind: "double-damage-spend";
      heroId: string;
      tokenKind: import("../state").ConsumableTokenKind;
    }
  /**
   * Mace `target-filter-or-spend-element` OR-mode: the bearer
   * spent 1 of `element` from their bag to bypass the card's
   * UNDAMAGED / DAMAGED targeting filter. Element bag is debited
   * inside `useWeaponAbility` BEFORE the AttackSession is built,
   * so this entry is the audit trail / log.
   *
   * Distinct from the Sol/Lunar Shield element spend (which fires
   * during the counter-resolution phase, NOT during weapon-ability
   * resolution) — this one is pre-attack and tied to the WEAPON
   * card, not a passive.
   */
  | {
      kind: "target-bypass-spend-element";
      heroId: string;
      element: import("../types").Element;
    }
  /** Machinist upgrade weapon: elements spent on "Spend N [element]" options. */
  | { kind: "weapon-spend"; heroId: string; element: import("../types").Element; amount: number }
  /** Lunar Trident: the d6 the swing's damage was multiplied by. */
  | { kind: "die-multiplier"; heroId: string; roll: number };

export interface PostEffect {
  kind: "collect-creature-part";
  count: number;
  /**
   * Originating card id (e.g. `mind-gauntlet-r2`,
   * `body-gauntlet-r3`) — captured at session-build time so
   * `finalizeAttackSession` can surface it in the
   * `creature-part-pick` modal header without re-deriving from
   * the (already cleared) hand state. Each `count: N` swing
   * enqueues N picks all carrying the same source id.
   */
  sourceCardId: string;
}

/**
 * Build a fresh, unstarted attack session. Validates inputs but does NOT
 * apply damage / counters. Caller is expected to have already gated via
 * `useWeaponAbility` / equivalent.
 */
export function buildAttackSession(args: {
  attackerId: string;
  source: AttackSource;
  damage: number;
  damageType?: DamageType | null;
  hitTiles: HitTile[];
  blockCounterattacks?: boolean;
  gainElementOnKill?: { element: Element; amount: number };
  preEffects?: PreEffect[];
  postEffects?: PostEffect[];
}): AttackSession {
  return {
    attackerId: args.attackerId,
    source: args.source,
    damage: args.damage,
    damageType: args.damageType ?? null,
    ...(args.blockCounterattacks ? { blockCounterattacks: true } : {}),
    ...(args.gainElementOnKill ? { gainElementOnKill: args.gainElementOnKill } : {}),
    hitTiles: args.hitTiles,
    steps: [],
    sharedCounter: null,
    finalized: false,
    preEffects: args.preEffects ?? [],
    postEffects: args.postEffects ?? [],
    levelUpsApplied: 0,
  };
}

/**
 * Apply damage to every hit tile in order, recording each result in
 * `session.steps`, then build `session.sharedCounter` with a snapshot
 * of every damaged enemy and the precomputed `anyCanLand` flag.
 *
 * On-death side-effects (flipping `enemy.alive = false` and calling
 * `applyKill` for XP / drops / element tokens) are DEFERRED to
 * `finalizeAttackSession` so dying enemies remain visible on the
 * board — and continue to be highlightable as counter-sources — for
 * the full duration of the shared counter-roll prompt. The counter
 * itself does not depend on `alive`: it walks the snapshotted
 * positions stored on `phase.damagedEnemies`.
 *
 * Idempotent on a session that already has its damage resolved
 * (`session.sharedCounter !== null`).
 */
export function resolveAllDamage(
  state: CampaignState,
  session: AttackSession,
): SharedCounterPhase {
  if (session.sharedCounter) return session.sharedCounter;

  const damaged: DamagedEnemySnapshot[] = [];
  const enc = state.encounter;

  // Vicious: a delver who suffered HP as the attack's cost (Hammer
  // reroll, body-void slot) already "suffered damage" before the hit.
  const selfHurt = new Set(session.preEffects.filter((e) => e.kind === "self-suffer" && e.amount > 0).map((e) => e.heroId));
  loseViciousTokensNear(state, selfHurt);

  // Ch4 Hardy counts the distinct enemies this attack targets.
  const targetedEnemyCount = enc
    ? new Set(session.hitTiles.map((t) => getEnemyAt(enc, t.x, t.y)).filter((e) => !!e).map((e) => e!.linkedTo ?? e!.instanceId)).size
    : 0;
  for (const tile of session.hitTiles) {
    // Look up the enemy directly (rather than via `applyDamageAtTile`)
    // because that helper flips `alive = false` on a fatal blow, which
    // would yank the dying token from the board before the counter
    // prompt has a chance to highlight it.
    const hitCard = enc ? getEnemyAt(enc, tile.x, tile.y) : null;
    // 2-card boss: a hit on the 2/2 card damages the boss (1/2 card).
    const enemy = hitCard?.linkedTo
      ? enc!.enemies.find((e) => e.instanceId === hitCard.linkedTo) ?? null
      : hitCard;
    if (!enemy) {
      // Miss tile (empty cell from a die-roll, or chain tile vacated by
      // a prior tile in this same attack). Recorded for the log.
      session.steps.push({
        tile,
        enemyInstanceId: null,
        damageApplied: 0,
        killed: false,
      });
      continue;
    }

    // Primordial gate — see `slotElementForAttackSource` + the
    // Primordial helper below. Q2 W3 Sporeclouds + Death Cap-
    // family ENEMIES only take damage from weapon slots bound
    // to one of their two printed elements. Damage that doesn't
    // match is zeroed BEFORE Fatal Flaw runs, so a no-match
    // strike on a Primordial enemy never trips the flaw clamp
    // either (there's nothing to clamp).
    const card = getEnemy(enemy.cardId);
    const slotElement = slotElementForAttackSource(session.attackerId, session.source);
    const primordialBlocked = isBlockedByPrimordial(card, slotElement);
    const incomingDamage = primordialBlocked ? 0 : incomingAttackDamage(enemy, card, tile.damage ?? session.damage, tile.damageType ?? session.damageType, enc ? { enc, attackerId: session.attackerId } : undefined);
    if (primordialBlocked) {
      recordAbilityProc(enemy, "primordial");
      logEvent("combat.primordialBlocked", {
        instanceId: enemy.instanceId,
        cardId: enemy.cardId,
        slotElement,
        primordialElements: primordialElements(card),
        damage: session.damage,
        site: "resolveAllDamage",
      });
    }

    // Fatal Flaw clamp — see `engine/encounter.ts >
    // clampDamageForFatalFlaw`. The check uses damageTaken to treat
    // enemies that already absorbed lethal damage earlier in THIS
    // same attack batch as effectively dead, so a tier-2 enemy hit by
    // the same shockwave that kills all tier-1 enemies can also be
    // killed in that single batch (sequential tiers may die together).
    // NOTE: this in-loop check is ORDER-DEPENDENT (tile order) — the
    // cascade pass after the loop re-lifts clamps once lower tiers
    // are confirmed dead, making the batch order-independent.
    const clamp = clampDamageForFatalFlaw(enc!, enemy, incomingDamage);
    enemy.damageTaken = clamp.newDamageTaken;
    // Ch4 Hardy: only an attack that also targets 2+ other enemies can
    // take it to 0 HP.
    let hardyAbsorbed = 0;
    if (hasAbility(card, "hardy") && enemy.damageTaken >= card.hp && targetedEnemyCount < 3) {
      hardyAbsorbed = enemy.damageTaken - (card.hp - 1);
      enemy.damageTaken = card.hp - 1;
      recordAbilityProc(enemy, "hardy");
      logEvent("combat.hardyBlocked", { instanceId: enemy.instanceId, targeted: targetedEnemyCount });
    }
    if (clamp.blocked) {
      recordAbilityProc(enemy, "fatal-flaw");
      logEvent("combat.fatalFlawBlocked", {
        instanceId: enemy.instanceId,
        cardId: enemy.cardId,
        absorbedDamage: clamp.absorbed,
        site: "resolveAllDamage",
      });
    }
    const killed = enemy.damageTaken >= card.hp;
    // Note: `enemy.alive` deliberately NOT flipped here, and `applyKill`
    // deliberately NOT called. Both happen in `finalizeAttackSession`.
    // `damageApplied` reflects what HIT the enemy (post-Primordial,
    // post-FF clamps), not `session.damage` — keeps the log honest
    // about what actually happened on the tile.
    session.steps.push({
      tile,
      enemyInstanceId: enemy.instanceId,
      damageApplied: incomingDamage - clamp.absorbed - hardyAbsorbed,
      killed,
      flawAbsorbed: clamp.absorbed,
    });
    // Snapshot the enemy's tile + identity + facing — even on the
    // killing blow it still counters from where it stood (rulebook
    // p22), and the rotation it was wearing at strike time is the
    // one that determines counter direction (Slip Strider Boots
    // rotates can only happen on the bearer's own turn so this is
    // belt-and-braces today, but it future-proofs the snapshot).
    mirrorLinkedDamage(enc!, enemy);
    // Snapshot the card that was actually hit (its own arrows).
    const snap: DamagedEnemySnapshot = {
      instanceId: hitCard!.instanceId,
      cardId: hitCard!.cardId,
      x: hitCard!.x,
      y: hitCard!.y,
      facing: hitCard!.facing,
    };
    if (hasAbility(card, "accurate") && enc?.accurateMarks[enemy.instanceId] === session.attackerId) {
      snap.accurateTarget = session.attackerId;
    }
    damaged.push(snap);
  }

  // Fatal Flaw CASCADE pass — makes the batch ORDER-INDEPENDENT
  // (designer ruling 2026-07-22, playtester report: a Gauntlet chain
  // that hit every enemy on the board only killed the tier-1s).
  //
  // The in-loop clamp above evaluates the flaw ladder at the moment
  // each tile is processed, so whether a tier-2 enemy dies depended
  // on whether the chain happened to walk the tier-1s FIRST. Ruling:
  // damage in one attack is simultaneous — if the attack kills every
  // lower-tier enemy, the higher tiers hit by the same attack die
  // too. So: re-visit every clamped step; if its enemy is no longer
  // protected (all lower-tier blockers now carry lethal damage from
  // this batch), re-apply the absorbed damage. Loop to a fixed point
  // so tier-1 deaths can unlock tier-2, which unlocks tier-3, etc.
  if (enc) {
    const cascadeSlotElement = slotElementForAttackSource(session.attackerId, session.source);
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const step of session.steps) {
        if (step.killed || !step.enemyInstanceId) continue;
        const enemy = enc.enemies.find((e) => e.instanceId === step.enemyInstanceId);
        if (!enemy) continue;
        const card = getEnemy(enemy.cardId);
        // Primordial-zeroed steps also show damageApplied <
        // session.damage but absorbed nothing to the flaw — their
        // incoming was 0 by the element gate, so they never cascade.
        if (isBlockedByPrimordial(card, cascadeSlotElement)) continue;
        // Only steps that were flaw-clamped are candidates: they sit
        // exactly at hp - 1 with absorbed damage unaccounted for. Uses
        // the recorded clamp amount, not `session.damage - applied`:
        // Immunity / Guards / Tough / Stout also lower the applied
        // damage, and that must never be "re-applied" here.
        const absorbed = step.flawAbsorbed ?? 0;
        if (absorbed <= 0) continue;
        if (enemy.damageTaken !== card.hp - 1) continue;
        if (isFatalFlawProtected(enc, enemy)) continue;
        enemy.damageTaken += absorbed;
        mirrorLinkedDamage(enc, enemy);
        step.damageApplied += absorbed;
        step.flawAbsorbed = 0;
        step.killed = enemy.damageTaken >= card.hp;
        logEvent("combat.fatalFlawCascade", {
          instanceId: enemy.instanceId,
          cardId: enemy.cardId,
          reappliedDamage: absorbed,
          killed: step.killed,
          site: "resolveAllDamage",
        });
        progressed = true;
      }
    }
  }

  if (enc && session.source.kind === "weapon") {
    applySpikedAndBackup(state, enc, session, damaged);
  }
  if (enc) {
    addSynchronizedCounterattackers(enc, damaged);
    addCountdownCounterattackers(enc, session, damaged);
    addFrenzyCounterattackers(enc, session, damaged);
    addLinkedBossCards(enc, damaged);
  }
  // Engulfing Beam "Block counterattacks": nobody counterattacks.
  if (session.blockCounterattacks) damaged.length = 0;
  const anyCanLand = couldAnyCounterLand(state, damaged);
  const sharedCounter: SharedCounterPhase = {
    damagedEnemies: damaged,
    anyCanLand,
    rolled: -1,
    outcome: "miss",
    hits: [],
    resolved: false,
  };
  session.sharedCounter = sharedCounter;
  return sharedCounter;
}

/**
 * Apply a single shared d6 to every damaged enemy's counter pattern.
 * Pass `rolled = -1` to skip the roll entirely (used when `anyCanLand`
 * was false — auto-skip).
 *
 * Idempotent: subsequent calls are no-ops.
 *
 * Throws if `resolveAllDamage` hasn't been called first.
 */
export function resolveSharedCounter(
  state: CampaignState,
  session: AttackSession,
  rolled: number,
): SharedCounterPhase {
  const phase = session.sharedCounter;
  if (!phase) throw new Error("resolveSharedCounter: damage phase has not run");
  if (phase.resolved) return phase;

  phase.rolled = rolled;
  phase.outcome = rolled < 0 ? "miss" : counterAttackOutcomeForRoll(rolled);
  phase.hits = [];

  const enc0 = state.encounter;
  if (rolled >= 0) {
    phase.strikes = computeCounterStrikes(state, phase.damagedEnemies, phase.outcome, rolled);
    recordCounterAbilityProcs(state, phase.damagedEnemies, phase.outcome, rolled, phase.strikes);
    for (const strike of phase.strikes) {
      const striker = enc0?.enemies.find((e) => e.instanceId === strike.instanceId);
      const dealt = damageDelverInWave(state, strike.heroId, strike.damage, striker ? getEnemy(striker.cardId) : undefined);
      phase.hits.push({ heroId: strike.heroId, damage: dealt });
    }
  }

  applyPostCounterPassives(state, phase, session.attackerId);
  phase.resolved = true;
  return phase;
}

/** Every "after attempting to counterattack" passive, in printed order. */
function applyPostCounterPassives(state: CampaignState, phase: SharedCounterPhase, attackerId: string): void {
  applyRotatesAbility(state, phase);
  applyAlertAbility(state, phase, attackerId);
  applyStrengthAbility(state, phase);
  applyFleesAbility(state, phase, attackerId);
  applyTeleportsAbility(state, phase);
  applyAccurateAbility(state, phase, attackerId);
  applyViciousLoss(state, phase);
  applyShellSoulSapCorruption(state, phase);
}

/**
 * Ch4 post-counter passives:
 *   - Shell: a counterattack that lands nothing (a miss) gives it its
 *     token; one that lands removes it.
 *   - Soul Sap: a delver it damages also exhausts a consumable token.
 *   - Corruption: a delver it targets becomes the (single) corrupted one.
 */
function applyShellSoulSapCorruption(state: CampaignState, phase: SharedCounterPhase): void {
  const enc = state.encounter;
  if (!enc) return;
  const strikes = phase.strikes ?? [];
  for (const ds of phase.damagedEnemies) {
    const e = enc.enemies.find((x) => x.instanceId === ds.instanceId);
    if (!e || !e.alive) continue;
    const card = getEnemy(e.cardId);
    const mine = strikes.filter((st) => st.instanceId === e.instanceId);
    if (hasAbility(card, "shell")) e.shellToken = mine.length === 0;
    if (hasAbility(card, "soul-sap")) {
      for (const heroId of new Set(mine.map((st) => st.heroId))) {
        if (!phase.hits.some((h) => h.heroId === heroId && h.damage > 0)) continue;
        const kind = exhaustOneToken(state, heroId);
        recordAbilityProc(e, "soul-sap");
        logEvent("combat.soulSap", { heroId, exhausted: kind });
      }
    }
    if (hasAbility(card, "corruption") && mine.length > 0) {
      enc.corruption = { bossInstanceId: e.instanceId, heroId: mine[mine.length - 1]!.heroId };
      recordAbilityProc(e, "corruption");
      logEvent("combat.corruption", { ...enc.corruption });
    }
  }
}

/** Ch4 Spiked (3 back on 8+ weapon damage) and Backup (2 more counterattackers). */
function applySpikedAndBackup(
  state: CampaignState,
  enc: NonNullable<CampaignState["encounter"]>,
  session: AttackSession,
  damaged: DamagedEnemySnapshot[],
): void {
  for (const step of session.steps) {
    if (!step.enemyInstanceId || step.damageApplied < SPIKED_THRESHOLD) continue;
    const e = enc.enemies.find((x) => x.instanceId === step.enemyInstanceId);
    if (!e || !hasAbility(getEnemy(e.cardId), "spiked")) continue;
    damageDelverInWave(state, session.attackerId, SPIKED_DAMAGE, getEnemy(e.cardId));
    recordAbilityProc(e, "spiked");
    logEvent("combat.spiked", { instanceId: e.instanceId, attackerId: session.attackerId });
  }
  const backupHit = damaged.find((d) => !d.bonus && hasAbility(getEnemy(d.cardId), "backup"));
  if (backupHit) {
    recordAbilityProc(backupHit, "backup");
    const extras = backupExtras(enc, session.attackerId, new Set(damaged.map((d) => d.instanceId)));
    for (const e of extras) damaged.push({ instanceId: e.instanceId, cardId: e.cardId, x: e.x, y: e.y, facing: e.facing, bonus: true });
    logEvent("combat.backup", { extras: extras.map((e) => e.instanceId) });
  }
}

/**
 * Rotates ability (rulebook / Q2 W2 storybook): *"These enemies
 * rotate their card 90 degrees clockwise after attempting to
 * counterattack."*
 *
 * Fires for every enemy in `phase.damagedEnemies` that:
 *   - still has the Rotates passive on its card, AND
 *   - is still ALIVE post-damage (a dying enemy has no body to
 *     rotate — the printed text gates on "attempting to counter",
 *     and `finalizeAttackSession` is about to discard it anyway).
 *
 * Bumps `enemy.facing` by 90° CW (0 → 90 → 180 → 270 → 0). The
 * next time this enemy is hit, `counterOffsetsFor` re-evaluates
 * its `counterCommon` / `counterUncommon` patterns against the
 * new facing — same physics as the Slip-Strider Boots manual
 * rotation, just driven by the enemy's own card text.
 *
 * Fires regardless of `phase.outcome` (a "miss" roll still
 * counts as an *attempt* — the enemy rolled and missed, but the
 * dial still ticks). Idempotent within a session because
 * `phase.resolved` short-circuits subsequent
 * `resolveSharedCounter` calls.
 */
/**
 * Look up the element the attack's slot is bound to. Both
 * `weapon` and `slot` attack sources carry a `slotIdx`; the
 * element is fixed by the delver-board layout (see
 * `data/delverBoards.json` — each suit has 6 slots, one per
 * element). Returns `null` for non-slot sources (none today, but
 * future free-fire effects might want this).
 *
 * Pure / no encounter state needed — the slot→element binding is
 * static per suit, not per encounter.
 */
function slotElementForAttackSource(
  attackerId: string,
  source: AttackSource,
): Element | null {
  const suit = getHero(attackerId).suit;
  const board = getDelverBoard(suit);
  const slot = board.weaponSlots[source.slotIdx];
  if (!slot) return null;
  return slot.element;
}

/**
 * Pull the Primordial ability's `elements` whitelist off an
 * enemy card, or `null` if the enemy has no Primordial passive.
 * Helper so the gate + the log row both read from the same
 * source.
 */
function primordialElements(card: EnemyCard): readonly Element[] | null {
  for (const a of card.abilities) {
    if (a.kind === "primordial") return a.elements;
  }
  return null;
}

/**
 * True iff the enemy has Primordial AND the attack's slot
 * element isn't in the Primordial whitelist (or there was no
 * slot element to check at all — a sourceless attack can't
 * satisfy Primordial). False for non-Primordial enemies (i.e.
 * the gate is a no-op for every Q1 + Q2 W1/W2 enemy).
 *
 * Rulebook p20: the slot DOES NOT need to carry an element
 * TOKEN at swing time — only the slot's printed element
 * matters. The token is just a payment for swing economy; the
 * slot-element binding is what unlocks the damage.
 */
function isBlockedByPrimordial(
  card: EnemyCard,
  slotElement: Element | null,
): boolean {
  const allowed = primordialElements(card);
  if (!allowed) return false;
  if (!slotElement) return true;
  return !allowed.includes(slotElement);
}

/** Keep a 2-card boss's 2/2 card at the same damage as its 1/2 card, so
 *  HP readouts and damaged/undamaged targeting see one boss. */
function mirrorLinkedDamage(enc: NonNullable<CampaignState["encounter"]>, boss: EnemyInstance): void {
  for (const part of enc.enemies) {
    if (part.linkedTo === boss.instanceId) part.damageTaken = boss.damageTaken;
  }
}

/**
 * 2-card boss: when either card counterattacks, so does the other card
 * (with its own arrows) — one boss, two cards. Each card counters at most
 * once per roll and kind (normal / bonus).
 */
function addLinkedBossCards(enc: NonNullable<CampaignState["encounter"]>, damaged: DamagedEnemySnapshot[]): void {
  const extra: DamagedEnemySnapshot[] = [];
  for (const ds of damaged) {
    const self = enc.enemies.find((e) => e.instanceId === ds.instanceId);
    if (!self) continue;
    const partners = enc.enemies.filter((e) =>
      e.alive && e.instanceId !== self.instanceId &&
      (e.linkedTo === self.instanceId || e.instanceId === self.linkedTo));
    for (const p of partners) {
      const have = [...damaged, ...extra].some((d) => d.instanceId === p.instanceId && !!d.bonus === !!ds.bonus);
      if (have) continue;
      extra.push({ instanceId: p.instanceId, cardId: p.cardId, x: p.x, y: p.y, facing: p.facing, bonus: ds.bonus });
    }
  }
  // The same card hit twice in one attack (both boss tiles in a chain)
  // still counterattacks once.
  const seen = new Set<string>();
  const all = [...damaged, ...extra];
  damaged.length = 0;
  for (const d of all) {
    const k = `${d.instanceId}|${d.bonus ? 1 : 0}`;
    if (seen.has(k)) continue;
    seen.add(k);
    damaged.push(d);
  }
}

export function hasAbility(card: EnemyCard, kind: EnemyAbility["kind"]): boolean {
  return card.abilities.some((a) => a.kind === kind);
}

/**
 * Damage one attack actually deals to `enemy` before Fatal Flaw, in
 * printed-rule order:
 *   - Immunity: 0 if the attack's damage type matches.
 *   - Guards: while it has monster tokens it suffers no damage; each
 *     attack removes one token (mutates `enemy.guardTokens`).
 *   - Tough: rounds down to the nearest 5.
 *   - Vicious: at most 1 while its monster token is on.
 *   - Stout: capped at the printed maximum.
 */
function incomingAttackDamage(
  enemy: EnemyInstance,
  card: EnemyCard,
  attackDamage: number,
  damageType: DamageType | null,
  ctx?: { enc: NonNullable<CampaignState["encounter"]>; attackerId: string },
): number {
  const immunity = card.abilities.find((a) => a.kind === "immunity");
  if (immunity && immunity.kind === "immunity" && damageType === immunity.damageType) {
    recordAbilityProc(enemy, "immunity");
    logEvent("combat.immunityBlocked", { instanceId: enemy.instanceId, damageType });
    return 0;
  }
  if ((enemy.guardTokens ?? 0) > 0) {
    enemy.guardTokens = enemy.guardTokens! - 1;
    recordAbilityProc(enemy, "guards");
    logEvent("combat.guardsBlocked", { instanceId: enemy.instanceId, tokensLeft: enemy.guardTokens });
    return 0;
  }
  // Ch4 Shell: invulnerable while it holds its monster token.
  if (enemy.shellToken) {
    recordAbilityProc(enemy, "shell");
    logEvent("combat.shellBlocked", { instanceId: enemy.instanceId });
    return 0;
  }
  // Ch4 Invulnerable: the attack after it was damaged deals nothing.
  if (enemy.invulnerableToken) {
    enemy.invulnerableToken = false;
    recordAbilityProc(enemy, "invulnerable");
    logEvent("combat.invulnerableBlocked", { instanceId: enemy.instanceId });
    return 0;
  }
  let damage = attackDamage;
  // Each modifier labels the enemy's tile only when it changed the number.
  const modify = (kind: AbilityProcKind, next: number) => {
    if (next !== damage) recordAbilityProc(enemy, kind);
    damage = next;
  };
  if (ctx && hasAbility(card, "double-edged") && blackArrowOnDelver(ctx.enc, enemy)) modify("double-edged", damage * 2);
  if (ctx && hasAbility(card, "evasive") && evasiveApplies(ctx.enc, enemy)) modify("evasive", Math.ceil(damage / 2));
  if (ctx && hasAbility(card, "brawler") && isMeleeAttack(ctx.enc, ctx.attackerId, enemy)) modify("brawler", Math.ceil(damage / 2));
  if (hasAbility(card, "tough")) modify("tough", Math.floor(damage / 5) * 5);
  if (enemy.viciousToken) modify("vicious", Math.min(damage, 1));
  modify("stout", stoutCappedDamage(card, damage));
  const out = damage;
  if (out > 0 && hasAbility(card, "invulnerable")) enemy.invulnerableToken = true;
  return out;
}

/** Double Edged: a delver stands on one of this enemy's black (roll-6) arrow tiles. */
function blackArrowOnDelver(
  enc: NonNullable<CampaignState["encounter"]>,
  e: { x: number; y: number; facing: EnemyFacing; cardId: string; instanceId: string },
): boolean {
  return counterOffsetsFor(e, e.facing, "uncommon").some((off) => getDelversAt(enc, e.x + off.dx, e.y + off.dy).length > 0);
}

/**
 * Countdown: each attack on a Countdown enemy adds a token to the shared
 * pile. At 4+ the pile resets and every living Countdown enemy also
 * counterattacks ("in addition to normal counterattacks") — added as
 * bonus participants of this attack's shared roll.
 */
function addCountdownCounterattackers(
  enc: NonNullable<CampaignState["encounter"]>,
  session: AttackSession,
  damaged: DamagedEnemySnapshot[],
): void {
  const added = damaged.filter((d) => !d.bonus && hasAbility(getEnemy(d.cardId), "countdown")).length;
  if (added === 0) return;
  enc.countdownTokens += added;
  logEvent("combat.countdownAdded", { added, pile: enc.countdownTokens });
  if (enc.countdownTokens < 4) return;
  enc.countdownTokens = 0;
  for (const e of enc.enemies) {
    if (!e.alive || !hasAbility(getEnemy(e.cardId), "countdown")) continue;
    recordAbilityProc(e, "countdown");
    damaged.push({ instanceId: e.instanceId, cardId: e.cardId, x: e.x, y: e.y, facing: e.facing, bonus: true });
  }
  logEvent("combat.countdownTriggered", { attackerId: session.attackerId });
}

/**
 * Frenzy: if a Frenzy enemy is overkilled (damage beyond what was needed
 * to kill it), every Frenzy enemy also counterattacks — added as bonus
 * participants of this attack's shared roll.
 */
function addFrenzyCounterattackers(
  enc: NonNullable<CampaignState["encounter"]>,
  session: AttackSession,
  damaged: DamagedEnemySnapshot[],
): void {
  const overkilled = session.steps.some((st) => {
    if (!st.killed || !st.enemyInstanceId) return false;
    const e = enc.enemies.find((x) => x.instanceId === st.enemyInstanceId);
    return !!e && hasAbility(getEnemy(e.cardId), "frenzy") && e.damageTaken > getEnemy(e.cardId).hp;
  });
  if (!overkilled) return;
  for (const e of enc.enemies) {
    if (!e.alive || !hasAbility(getEnemy(e.cardId), "frenzy")) continue;
    recordAbilityProc(e, "frenzy");
    damaged.push({ instanceId: e.instanceId, cardId: e.cardId, x: e.x, y: e.y, facing: e.facing, bonus: true });
  }
  logEvent("combat.frenzyTriggered", { attackerId: session.attackerId });
}

/**
 * Accurate: after attempting to counterattack, the boss puts its monster
 * token on the attacking delver's board (moving it off the other delver).
 */
function applyAccurateAbility(state: CampaignState, phase: SharedCounterPhase, attackerId: string): void {
  const enc = state.encounter;
  if (!enc) return;
  for (const ds of phase.damagedEnemies) {
    if (ds.bonus || !hasAbility(getEnemy(ds.cardId), "accurate")) continue;
    enc.accurateMarks[ds.instanceId] = attackerId;
    recordAbilityProc(ds, "accurate");
    logEvent("combat.accurateMark", { instanceId: ds.instanceId, heroId: attackerId });
  }
}

/**
 * Alert: after attempting to counterattack, a surviving Alert enemy turns
 * so its icon (printed north edge) faces the attacking delver. When the
 * delver is on a diagonal, it turns the shorter way (ties: north/south).
 */
function applyAlertAbility(state: CampaignState, phase: SharedCounterPhase, attackerId: string): void {
  const enc = state.encounter;
  if (!enc) return;
  const attacker = enc.delverPositions[attackerId];
  if (!attacker) return;
  for (const ds of phase.damagedEnemies) {
    if (ds.bonus) continue;
    const live = enc.enemies.find((e) => e.instanceId === ds.instanceId);
    if (!live || !live.alive) continue;
    const card = getEnemy(live.cardId);
    if (live.damageTaken >= card.hp || !hasAbility(card, "alert")) continue;
    const dx = attacker.x - live.x;
    const dy = attacker.y - live.y;
    const vertical: EnemyFacing = dy < 0 ? 0 : 180;
    const horizontal: EnemyFacing = dx > 0 ? 90 : 270;
    let target: EnemyFacing;
    if (dx === 0) target = vertical;
    else if (dy === 0) target = horizontal;
    else if (Math.abs(dx) > Math.abs(dy)) target = horizontal;
    else if (Math.abs(dy) > Math.abs(dx)) target = vertical;
    else {
      const turns = (f: EnemyFacing) => Math.min((f - live.facing + 360) % 360, (live.facing - f + 360) % 360);
      target = turns(horizontal) < turns(vertical) ? horizontal : vertical;
    }
    if (target === live.facing) continue;
    recordAbilityProc(live, "alert");
    logEvent("combat.alertAbility", { instanceId: live.instanceId, from: live.facing, to: target });
    live.facing = target;
  }
}

/**
 * Vicious: whenever a delver adjacent to a Vicious enemy suffers damage,
 * that enemy loses its monster token. Checked after each counterattack
 * against the delvers it just hit.
 */
function applyViciousLoss(state: CampaignState, phase: SharedCounterPhase): void {
  const hurt = new Set(phase.hits.filter((h) => h.damage > 0).map((h) => h.heroId));
  loseViciousTokensNear(state, hurt);
}

/** Remove the Vicious token from every enemy adjacent to a hurt delver. */
export function loseViciousTokensNear(state: CampaignState, hurtHeroIds: ReadonlySet<string>): void {
  const enc = state.encounter;
  if (!enc || hurtHeroIds.size === 0) return;
  for (const e of enc.enemies) {
    if (!e.alive || !e.viciousToken) continue;
    for (const heroId of hurtHeroIds) {
      const pos = enc.delverPositions[heroId];
      if (pos && isAdj8(pos, e)) {
        e.viciousToken = false;
        recordAbilityProc(e, "vicious");
        logEvent("combat.viciousTokenLost", { instanceId: e.instanceId, heroId });
        break;
      }
    }
  }
}

/**
 * Counterattack damage for one enemy: printed attack plus any Strength
 * monster tokens it has built up (Ch3 Joyce the Bear).
 */
export function enemyCounterDamage(state: CampaignState, card: EnemyCard, instanceId: string): number {
  const live = state.encounter?.enemies.find((e) => e.instanceId === instanceId);
  return card.attack + (live?.strengthTokens ?? 0);
}

/** Stout: "cannot suffer more than N damage from a single attack". */
export function stoutCappedDamage(card: EnemyCard, damage: number): number {
  const stout = card.abilities.find((a) => a.kind === "stout");
  return stout && stout.kind === "stout" ? Math.min(damage, stout.maxDamage) : damage;
}

/**
 * Strength: after an enemy with the ability counterattacks (any roll but
 * a miss), it gains a monster token, raising its future counter damage
 * by 1. Dying enemies are skipped.
 */
function applyStrengthAbility(state: CampaignState, phase: SharedCounterPhase): void {
  const enc = state.encounter;
  if (!enc || phase.outcome === "miss") return;
  for (const ds of phase.damagedEnemies) {
    if (ds.bonus) continue;
    const live = enc.enemies.find((e) => e.instanceId === ds.instanceId);
    if (!live || !live.alive) continue;
    const card = getEnemy(live.cardId);
    if (live.damageTaken >= card.hp) continue;
    if (!card.abilities.some((a) => a.kind === "strength")) continue;
    live.strengthTokens = (live.strengthTokens ?? 0) + 1;
    recordAbilityProc(live, "strength");
    logEvent("combat.strengthAbility", { instanceId: live.instanceId, tokens: live.strengthTokens });
  }
}

/**
 * Synchronized: when a Synchronized enemy is damaged, it and every enemy
 * connected to it in an (8-way) adjacency chain counterattack. The extra
 * enemies join the shared counter phase as non-damaged participants, so
 * they use the same roll (and Rotates / Strength / Flees still apply).
 */
function addSynchronizedCounterattackers(enc: NonNullable<CampaignState["encounter"]>, damaged: DamagedEnemySnapshot[]): void {
  const seeds = damaged.filter((d) => getEnemy(d.cardId).abilities.some((a) => a.kind === "synchronized"));
  if (seeds.length === 0) return;
  const inPhase = new Set(damaged.map((d) => d.instanceId));
  const queue = seeds.map((d) => ({ x: d.x, y: d.y }));
  const visited = new Set(seeds.map((d) => d.instanceId));
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const other of enc.enemies) {
      if (!other.alive || visited.has(other.instanceId)) continue;
      if (!isAdj8(cur, other)) continue;
      visited.add(other.instanceId);
      queue.push({ x: other.x, y: other.y });
      if (!inPhase.has(other.instanceId)) {
        damaged.push({ instanceId: other.instanceId, cardId: other.cardId, x: other.x, y: other.y, facing: other.facing });
        inPhase.add(other.instanceId);
        recordAbilityProc(other, "synchronized");
        logEvent("combat.synchronizedJoin", { instanceId: other.instanceId, cardId: other.cardId });
      }
    }
  }
}

/**
 * Flees: after attempting to counterattack (any roll), each surviving
 * Flees enemy moves up to 2 tiles (8-way steps through free tiles) to the
 * reachable tile farthest from the attacking delver. The printed rule
 * lets players choose "in an intelligent fashion"; the prototype picks
 * the farthest tile (ties: the shortest move, then board order).
 */
function applyFleesAbility(state: CampaignState, phase: SharedCounterPhase, attackerId: string): void {
  const enc = state.encounter;
  if (!enc) return;
  const attacker = enc.delverPositions[attackerId];
  if (!attacker) return;
  for (const ds of phase.damagedEnemies) {
    if (ds.bonus) continue;
    const live = enc.enemies.find((e) => e.instanceId === ds.instanceId);
    if (!live || !live.alive) continue;
    const card = getEnemy(live.cardId);
    if (live.damageTaken >= card.hp) continue;
    if (!card.abilities.some((a) => a.kind === "flees")) continue;
    const blocked = new Set<string>();
    for (const e of enc.enemies) if (e.alive && e.instanceId !== live.instanceId) blocked.add(key(e.x, e.y));
    for (const pos of Object.values(enc.delverPositions)) if (pos) blocked.add(key(pos.x, pos.y));
    if (enc.witnessPosition) blocked.add(key(enc.witnessPosition.x, enc.witnessPosition.y));
    const board = getQuestData(enc.questId).waves.find((w) => w.number === enc.waveNumber)?.spawn.boardSize;
    if (!board) throw new Error(`applyFleesAbility: no board size for ${enc.questId} wave ${enc.waveNumber}`);
    const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < board.w && y < board.h;
    const dist = (x: number, y: number) => Math.max(Math.abs(x - attacker.x), Math.abs(y - attacker.y));
    let best = { x: live.x, y: live.y, steps: 0 };
    let frontier = [{ x: live.x, y: live.y }];
    const seen = new Set([key(live.x, live.y)]);
    for (let step = 1; step <= 2; step++) {
      const next: { x: number; y: number }[] = [];
      for (const f of frontier) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = f.x + dx;
            const ny = f.y + dy;
            if ((dx === 0 && dy === 0) || !inBounds(nx, ny)) continue;
            const k = key(nx, ny);
            if (seen.has(k) || blocked.has(k)) continue;
            seen.add(k);
            next.push({ x: nx, y: ny });
            if (dist(nx, ny) > dist(best.x, best.y)) best = { x: nx, y: ny, steps: step };
          }
        }
      }
      frontier = next;
    }
    if (best.x === live.x && best.y === live.y) continue;
    logEvent("combat.fleesAbility", { instanceId: live.instanceId, from: { x: live.x, y: live.y }, to: { x: best.x, y: best.y } });
    live.x = best.x;
    live.y = best.y;
    recordAbilityProc(live, "flees");
  }
}

/**
 * Label the counterattack abilities that changed this committed counter:
 * Critical (x2 on a 5), Double-edged (x2 vs a black-arrow delver),
 * All-Claw (fires on a miss) and Omen (a landed strike adds a token).
 * Called only where a counter is actually applied - never from previews.
 */
function recordCounterAbilityProcs(
  state: CampaignState,
  damaged: readonly DamagedEnemySnapshot[],
  outcome: CounterAttackOutcome,
  rolled: number,
  strikes: readonly CounterStrike[],
): void {
  const enc = state.encounter;
  if (!enc) return;
  for (const ds of damaged) {
    const card = getEnemy(ds.cardId);
    const struck = strikes.some((st) => st.instanceId === ds.instanceId && st.damage > 0);
    if (!struck) continue;
    if (rolled === 5 && hasAbility(card, "critical")) recordAbilityProc(ds, "critical");
    if (hasAbility(card, "double-edged") && blackArrowOnDelver(enc, ds)) recordAbilityProc(ds, "double-edged");
    if (outcome === "miss" && hasAbility(card, "all-claw")) recordAbilityProc(ds, "all-claw");
    if (hasAbility(card, "omen")) recordAbilityProc(ds, "omen");
  }
}

/** All-Claw: does this enemy fire both patterns on a roll of 1? */
export function hasAllClaw(cardId: string): boolean {
  return getEnemy(cardId).abilities.some((a) => a.kind === "all-claw");
}

function anyAllClaw(damaged: readonly { cardId: string }[]): boolean {
  return damaged.some((d) => hasAllClaw(d.cardId));
}

/**
 * Death Heal: every Death Heal enemy killed by this attack heals all
 * damage on its 8-adjacent living neighbours - except neighbours that
 * also died in this same attack.
 */
function applyDeathHeal(state: CampaignState, session: AttackSession): void {
  const enc = state.encounter;
  if (!enc) return;
  const killedIds = new Set(session.steps.filter((st) => st.killed && st.enemyInstanceId).map((st) => st.enemyInstanceId!));
  for (const id of killedIds) {
    const dead = enc.enemies.find((e) => e.instanceId === id);
    if (!dead) continue;
    if (!getEnemy(dead.cardId).abilities.some((a) => a.kind === "death-heal")) continue;
    for (const other of enc.enemies) {
      if (!other.alive || killedIds.has(other.instanceId) || other.damageTaken === 0) continue;
      if (!isAdj8(dead, other)) continue;
      recordAbilityProc(dead, "death-heal");
      logEvent("combat.deathHeal", { from: dead.instanceId, healed: other.instanceId, healedDamage: other.damageTaken });
      other.damageTaken = 0;
    }
  }
}

function applyRotatesAbility(state: CampaignState, phase: SharedCounterPhase): void {
  const enc = state.encounter;
  if (!enc) return;
  for (const ds of phase.damagedEnemies) {
    if (ds.bonus) continue;
    const live = enc.enemies.find((e) => e.instanceId === ds.instanceId);
    if (!live || !live.alive) continue;
    // Dying-but-not-yet-flipped check: damageTaken >= hp means
    // `finalizeAttackSession` will mark this enemy dead. Skip the
    // rotation since the body's about to be cleared.
    const card = getEnemy(live.cardId);
    if (live.damageTaken >= card.hp) continue;
    if (!card.abilities.some((a) => a.kind === "rotates")) continue;
    const before = live.facing;
    const after = (((live.facing + 90) % 360) as EnemyFacing);
    live.facing = after;
    recordAbilityProc(live, "rotates");
    logEvent("combat.rotatesAbility", {
      instanceId: live.instanceId,
      cardId: live.cardId,
      from: before,
      to: after,
      counterOutcome: phase.outcome,
    });
  }
}

/**
 * Q2 W3 Death Cap's "Teleports" passive. Rulebook: *"After this
 * boss's counterattack, swap its position with the nearest
 * living minion."* Fires only for enemies in
 * `phase.damagedEnemies` that:
 *   - still have the Teleports passive on their card,
 *   - are still ALIVE post-damage (dying enemies don't teleport
 *     — finalize is about to clear the body anyway), AND
 *   - have at least one OTHER living enemy on the board to
 *     swap with. If no swap target exists, the teleport is a
 *     silent no-op (boss-on-its-own corner case).
 *
 * Swap target selection: smallest Chebyshev distance from the
 * boss's current tile; ties broken by stable enemy-array order
 * (digital prototype auto-picks; rulebook leaves the choice to
 * the player but the engine doesn't open a chooser modal here
 * — the parity loss is minor and the surfaced via the event
 * log if we ever need to revisit).
 *
 * After the swap, the boss's new tile + the minion's new tile
 * are persisted to the live `EnemyInstance` records. The
 * damaged-enemies snapshot is NOT mutated — counters already
 * fired off the pre-teleport positions and the snapshot is the
 * historical record for any retroactive UI rendering.
 */
function applyTeleportsAbility(state: CampaignState, phase: SharedCounterPhase): void {
  const enc = state.encounter;
  if (!enc) return;
  for (const ds of phase.damagedEnemies) {
    const live = enc.enemies.find((e) => e.instanceId === ds.instanceId);
    if (!live || !live.alive) continue;
    const card = getEnemy(live.cardId);
    if (live.damageTaken >= card.hp) continue;
    if (!card.abilities.some((a) => a.kind === "teleports")) continue;

    // Find the nearest living OTHER enemy. Chebyshev distance
    // (matches the rest of the engine — `delverDistances` in
    // wave.ts uses the same metric).
    let target: EnemyInstance | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const other of enc.enemies) {
      if (other.instanceId === live.instanceId) continue;
      if (!other.alive) continue;
      if (other.damageTaken >= getEnemy(other.cardId).hp) continue;
      const d = Math.max(Math.abs(other.x - live.x), Math.abs(other.y - live.y));
      if (d < bestDist) {
        bestDist = d;
        target = other;
      }
    }
    if (!target) {
      logEvent("combat.teleportsAbility.skip", {
        instanceId: live.instanceId,
        cardId: live.cardId,
        reason: "no-living-target",
      });
      continue;
    }

    const fromX = live.x;
    const fromY = live.y;
    const toX = target.x;
    const toY = target.y;
    live.x = toX;
    live.y = toY;
    target.x = fromX;
    target.y = fromY;
    recordAbilityProc(live, "teleports");
    logEvent("combat.teleportsAbility", {
      instanceId: live.instanceId,
      cardId: live.cardId,
      from: { x: fromX, y: fromY },
      to: { x: toX, y: toY },
      swappedWith: { instanceId: target.instanceId, cardId: target.cardId },
      counterOutcome: phase.outcome,
    });
  }
}

/**
 * Compute the set of board tiles a shared counter struck (or WILL
 * strike) for the given outcome — i.e., for each damaged enemy take
 * its outcome-appropriate offsets and translate them by the enemy's
 * snapshotted position, keeping only tiles that are inside the
 * board. Returns an empty array on `miss`.
 *
 * Pure, side-effect free — UI uses this to highlight the strike
 * pattern on the board while the post-roll counter modal is open
 * (the actual `resolveSharedCounter` call doesn't fire until Confirm,
 * so we compute the same tiles eagerly off the rolled outcome).
 * De-duplicates so two enemies hitting the same tile don't render
 * stacked overlays.
 */
export function computeCounterTargetTiles(
  damaged: readonly DamagedEnemySnapshot[],
  outcome: CounterAttackOutcome,
  board: BoardBounds,
): { x: number; y: number }[] {
  if (outcome === "miss" && !anyAllClaw(damaged)) return [];
  const seen = new Set<string>();
  const out: { x: number; y: number }[] = [];
  for (const ds of damaged) {
    const offsets = counterOffsetsFor(ds, ds.facing, outcome);
    for (const off of offsets) {
      const tx = ds.x + off.dx;
      const ty = ds.y + off.dy;
      if (tx < 0 || ty < 0 || tx >= board.w || ty >= board.h) continue;
      const key = `${tx},${ty}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ x: tx, y: ty });
    }
  }
  return out;
}

/**
 * Forecast the per-delver damage a shared counter WOULD apply for
 * the given outcome, without mutating any HP. Returns one entry per
 * heroId who would suffer damage with their total stacked across
 * all damaged enemies' offsets that intersect their tile. Heroes
 * who would not be hit are omitted (caller can render "Missed" if
 * the array is empty or the outcome is `miss`).
 *
 * Pure mirror of the per-hero accounting in `resolveSharedCounter`
 * — kept in sync by construction (same offset traversal).
 */
export function previewCounterHitsByDelver(
  state: CampaignState,
  damaged: readonly DamagedEnemySnapshot[],
  outcome: CounterAttackOutcome,
  /**
   * Optional `weapon-counter-block` reductions to apply BEFORE
   * computing per-hero totals. Each entry says "this enemy's
   * effective `attack` is `max(0, attack - reduction)` for this
   * preview only." Must mirror what
   * {@link applyCounterDamageWithShieldChoices} will actually apply,
   * otherwise the shield prompt's "incoming damage" label would lie
   * about the post-block reality. Multi-pick weapons (Shockwave,
   * count: 2) populate this with multiple entries; single-pick
   * weapons (Trident, count: 1) populate it with one.
   */
  weaponCounterBlockByEnemy?: ReadonlyMap<string, number>,
  /** The rolled d6 when known (Critical doubles white arrows on a 5). */
  rolled?: number,
): { heroId: string; damage: number }[] {
  const totals = new Map<string, number>();
  for (const st of computeCounterStrikes(state, damaged, outcome, rolled, weaponCounterBlockByEnemy)) {
    totals.set(st.heroId, (totals.get(st.heroId) ?? 0) + st.damage);
  }
  return Array.from(totals.entries()).map(([heroId, damage]) => ({ heroId, damage }));
}

/** One enemy's counterattack landing on one delver. */
export interface CounterStrike {
  instanceId: string;
  heroId: string;
  damage: number;
}

/**
 * Spend one of `spenderHeroId`'s Block Counterattack tokens (internal id
 * `prevent-counterattack`) to cancel ONE enemy's counterattack in the
 * shared counter (designer decision 2026-11-17). The enemy leaves
 * `phase.damagedEnemies`, so it deals no damage and none of its "after
 * attempting to counterattack" effects fire (Rotates, Alert, Flees,
 * Accurate, Strength, Teleports, Shell...). Either delver may spend, any
 * number of times (no per-turn cap). Throws when the spender has no
 * token or the enemy isn't counterattacking.
 */
export function blockCounterattack(
  state: CampaignState,
  phase: SharedCounterPhase,
  spenderHeroId: string,
  instanceId: string,
): void {
  const idx = phase.damagedEnemies.findIndex((d) => d.instanceId === instanceId);
  if (idx < 0) throw new Error(`blockCounterattack: ${instanceId} isn't counterattacking`);
  if (!spendToken(state, spenderHeroId, "prevent-counterattack")) {
    throw new Error(`blockCounterattack: ${spenderHeroId} has no Block Counterattack token`);
  }
  phase.damagedEnemies.splice(idx, 1);
  logEvent("combat.blockCounterattack", { spenderHeroId, instanceId });
}

/**
 * Single source of truth for "who does this counterattack hit, for how
 * much". Every resolver and preview goes through here so Accurate /
 * Critical / weapon blocks stay in lockstep across the shield and
 * no-shield paths.
 *
 *   - Pattern hits: the outcome's arrows (All-Claw fires both on a 1).
 *   - Accurate: a snapshot with `accurateTarget` always hits that delver.
 *   - Critical: on a rolled 5 (white arrows) the enemy deals double.
 *   - `blockMap`: weapon-counter-block reduction per enemy.
 *
 * A delver is hit at most once per counterattacking snapshot.
 */
export function computeCounterStrikes(
  state: CampaignState,
  damaged: readonly DamagedEnemySnapshot[],
  outcome: CounterAttackOutcome,
  rolled?: number,
  blockMap?: ReadonlyMap<string, number>,
): CounterStrike[] {
  const enc = state.encounter;
  if (!enc) return [];
  const out: CounterStrike[] = [];
  for (const ds of damaged) {
    const card = getEnemy(ds.cardId);
    let attack = enemyCounterDamage(state, card, ds.instanceId);
    if (rolled === 5 && hasAbility(card, "critical")) attack *= 2;
    if (hasAbility(card, "double-edged") && blackArrowOnDelver(enc, ds)) attack *= 2;
    attack = Math.max(0, attack - (blockMap?.get(ds.instanceId) ?? 0));
    if (attack <= 0) continue;
    const targets = new Set<string>();
    for (const off of counterOffsetsFor(ds, ds.facing, outcome)) {
      for (const heroId of getDelversAt(enc, ds.x + off.dx, ds.y + off.dy)) targets.add(heroId);
    }
    if (ds.accurateTarget && enc.delverPositions[ds.accurateTarget]) targets.add(ds.accurateTarget);
    for (const heroId of targets) {
      if (!state.loadouts[heroId]) continue;
      out.push({ instanceId: ds.instanceId, heroId, damage: attack });
    }
  }
  return out;
}

/** Per-bearer shield-activation cap: one per distinct counterattacking
 *  snapshot that strikes a delver on the bearer's tile. */
function shieldCapsFromStrikes(state: CampaignState, strikes: readonly CounterStrike[]): Map<string, number> {
  const enc = state.encounter!;
  const caps = new Map<string, number>();
  for (const heroId of Object.keys(state.loadouts)) {
    const pos = enc.delverPositions[heroId];
    if (!pos) continue;
    const onTile = new Set(getDelversAt(enc, pos.x, pos.y));
    const sources = new Set(strikes.filter((st) => onTile.has(st.heroId)).map((st) => st.instanceId));
    caps.set(heroId, sources.size);
  }
  return caps;
}

/**
 * True iff at least one of the damaged enemies' counter patterns —
 * across BOTH common and uncommon offsets — could land on a delver
 * given current delver positions. Used to short-circuit the d6 prompt
 * when no roll outcome could matter (DESIGN.md §5.4).
 */
function couldAnyCounterLand(
  state: CampaignState,
  damaged: DamagedEnemySnapshot[],
): boolean {
  const enc = state.encounter;
  if (!enc || damaged.length === 0) return false;
  for (const ds of damaged) {
    if (ds.accurateTarget && enc.delverPositions[ds.accurateTarget]) return true;
    const allOffsets: Offset[] = [
      ...counterOffsetsFor(ds, ds.facing, "common"),
      ...counterOffsetsFor(ds, ds.facing, "uncommon"),
    ];
    for (const off of allOffsets) {
      const tx = ds.x + off.dx;
      const ty = ds.y + off.dy;
      if (getDelversAt(enc, tx, ty).length > 0) return true;
    }
  }
  return false;
}

// --- Sol / Lunar Shield (block-on-tile passive) -------------------------
// Rulebook + extracted card text:
//   "ONGOING: You may spend 1 ELEMENT to have delvers on your tile
//    block 1 damage from a single source, or block N if you spend a
//    {bonusElement}. Heal {healPerOverblock} HP for each overblocked
//    damage."
// Sol Shield (Mind, R1):  bonusElement = "radiance"
// Lunar Shield (Body, R1): bonusElement = "void"
//
// Engine model (decisions confirmed by user 2026-05-03):
//   - "Single source" = the entire shared counter (per_attack semantic):
//     one shield activation per shield, reduces damage from THIS counter.
//   - Scope = tile-mates: block applies to every delver standing on the
//     bearer's tile, independently (each delver blocks min(theirDamage,
//     blockAmount); leftover counts as "overblock" per delver).
//   - Overblock heal goes ONLY to the bearer (clamped at maxHp - no
//     overheal).
//   - Each delver may have at most one shield card "owned" (hand-rank
//     >= 1 of the Shield equipment type). The bearer's element bag is
//     debited by exactly 1 of the chosen element when activated.

/** Per-shield activation opportunity surfaced to the UI before counter
 *  damage is applied. One entry per shield-bearer who has elements AND
 *  has at least one tile-mate (incl. self) about to take damage. */
export interface ShieldOpportunity {
  /** Shield-bearer (delver who owns the Sol/Lunar Shield card). */
  shieldBearerHeroId: string;
  /** Equipment card id, e.g. "mind-shield-r1". Used to look up the
   *  card name + image when rendering the prompt. */
  shieldCardId: string;
  /** Block amount when spending any non-bonus element. */
  baseBlock: number;
  /** Element that grants the bonusBlock when spent. */
  bonusElement: Element;
  /** Block amount when spending the bonusElement specifically. */
  bonusBlock: number;
  /** HP healed to the bearer per overblocked damage (clamped at maxHp). */
  healPerOverblock: number;
  /** Elements currently in the bearer's bag (kinds with count > 0).
   *  The UI offers one "Spend X" button per entry (with bonusElement
   *  flagged separately so the player sees the higher block amount). */
  availableElements: Element[];
  /** Delvers on the bearer's tile (incl. bearer if applicable) who
   *  would take >0 damage from this counter, with their pre-shield
   *  damage. The UI uses this to render the per-delver forecast. */
  protectedDelvers: { heroId: string; incomingDamage: number }[];
  /** Hard cap on shield activations for this opportunity: one
   *  activation per DISTINCT counterattacking enemy whose offsets
   *  land on the bearer's tile with non-zero post-block damage.
   *  Per the rulebook reading "1 shield per enemy counterattack".
   *  Always >= 1 when the opportunity exists at all (a bearer with
   *  no tile-mate-at-risk skips the prompt entirely upstream).
   *  Pre-2026-05-25 this was implicitly 1; multi-spend bumps it to
   *  the actual counterattacker count so the player can react to
   *  every incoming hit but can't spend extra elements past it. */
  maxActivations: number;
}

/** Player choice for one shield opportunity.
 *
 *  `spend` carries an ARRAY of elements — the shield may be activated
 *  multiple times in a single counter resolution, one element spent
 *  per activation, applied in array order. Each element separately
 *  contributes its own `baseBlock` / `bonusBlock` reduction (and
 *  separately accrues overblock toward the bearer's heal, when the
 *  shield ships `healPerOverblock > 0`).
 *
 *  Hard cap (rulebook §): one activation per DISTINCT counterattacker
 *  hitting the bearer's tile with non-zero post-block effective
 *  attack. Surfaced to the UI via `ShieldOpportunity.maxActivations`
 *  so the prompt can disable the Spend buttons once the cap is
 *  reached. Engine TRUNCATES `elements` to the cap defensively
 *  (a stale UI sending too many entries can't over-spend past the
 *  rulebook count). Pre-2026-05-25 the cap was implicitly 1 — the
 *  bearer could only activate the shield once even when multiple
 *  counterattackers were landing damage on their tile. The empty-
 *  array case is identical to `kind: "skip"` (engine accepts both
 *  for caller convenience).
 */
export type ShieldChoice =
  | { kind: "skip" }
  | { kind: "spend"; elements: Element[] };

/**
 * `weapon-counter-block` choice — fires AFTER the counter roll and
 * BEFORE per-hero damage is applied. The player picks UP TO `count`
 * counterattacking enemies (where `count` is the source weapon's
 * `weapon-counter-block.count`); each picked enemy's effective
 * `attack` is reduced by `amount` (clamped at 0) for this counter.
 *
 *   `kind: "skip"`  → declined; counter resolves at full damage.
 *   `kind: "block"` → reduce each `enemyInstanceIds` enemy's
 *                     contribution. Enemies MUST be in
 *                     `session.sharedCounter.damagedEnemies`; any
 *                     unknown id is silently ignored (defensive).
 *                     Length 0 reduces to "skip" semantics.
 *                     Length > `count` is clamped to the printed
 *                     count by taking the first N entries (UI is
 *                     expected to enforce the cap, this is a
 *                     defensive guard against stale state).
 *
 * Per-swing scope: only one prompt per swing. The `count` knob
 * unlocks Shockwave (count: 2) without a second engine pass — the
 * Trident (count: 1) is just a special case.
 *
 * UI wiring: `weapon-counter-block-prompt` opens between counter-
 * roll confirm and the shield-prompt queue; choice flows into
 * `applyCounterDamageWithShieldChoices` as the optional 5th arg.
 */
export type WeaponCounterBlockChoice =
  | { kind: "skip" }
  | { kind: "block"; enemyInstanceIds: string[] };

/**
 * Resolve the RANK-CORRECT card behind the session's source weapon
 * and sum its `weapon-counter-block` effect(s).
 *
 * The slot stores the R1 placeholder id (`slotCards` always
 * references R1 — rank lives in `equipmentRanks`), so reading
 * effects off `session.source.cardId` directly silently pins every
 * weapon to its R1 numbers. That was a live bug (player report
 * 2026-07-20): a Mind Shockwave R2 ("Block 2 damage from 2
 * counterattacks") only blocked 1 per counter because the R1 card
 * ("Block 1 from 2") was consulted. Trident R2-R5 (block = rank,
 * printed) had the same problem. Same bug class — and same fix —
 * as the Hammer R2 range regression (session 20260509-152644) and
 * `effectiveDamageForCard`'s printed-multiplier lookup.
 *
 * Effective rank folds in Opinion-Card temporary bonuses, mirroring
 * `effectiveDamageForCard`; falls back to the placed card's printed
 * rank when the rank table has no entry (defensive).
 */
function weaponCounterBlockEffects(
  state: CampaignState,
  session: AttackSession,
): { amount: number; count: number } {
  if (session.source.kind !== "weapon") return { amount: 0, count: 0 };
  const placed = getEquipment(session.source.cardId);
  let card = placed;
  try {
    const effective = getEffectiveEquipmentRank(state, session.attackerId, placed.type);
    const rank = effective > 0 ? effective : (placed.rank ?? 1);
    card = getEquipmentCardFor(state, session.attackerId, placed.type, rank);
  } catch {
    // Missing ranked card for (suit, type, rank) — data gap; fall
    // back to the placed card so the block still functions at R1
    // strength instead of crashing counter resolution.
  }
  let amount = 0;
  let count = 0;
  for (const eff of card.effects ?? []) {
    if (eff.kind === "weapon-counter-block") {
      amount += eff.amount;
      count += eff.count;
    }
  }
  return { amount, count };
}

/**
 * Public read of the rank-correct block amount — surfaced so the UI
 * can decide whether to open the counter-block prompt at all (skip
 * if amount is 0).
 */
export function sessionWeaponCounterBlockAmount(
  state: CampaignState,
  session: AttackSession,
): number {
  return weaponCounterBlockEffects(state, session).amount;
}

/**
 * Public read of the source weapon's per-swing pick cap. Trident is
 * 1, Shockwave is 2 (at every rank). Used by the UI to size the
 * multi-select prompt and decide when to auto-confirm.
 */
export function sessionWeaponCounterBlockCount(
  state: CampaignState,
  session: AttackSession,
): number {
  return weaponCounterBlockEffects(state, session).count;
}

/**
 * Convert a `WeaponCounterBlockChoice` into the per-enemy block-
 * amount map used by `previewCounterHitsByDelver` and
 * `findShieldOpportunities`. Centralising this here keeps the UI
 * preview and the eventual `applyCounterDamageWithShieldChoices`
 * call in lockstep — same caps (clamp to count), same defensive
 * dedupe behaviour, same amount lookup. Returns an empty map when
 * the source isn't a counter-block weapon or the player skipped.
 */
export function weaponCounterBlockMap(
  state: CampaignState,
  session: AttackSession,
  choice: WeaponCounterBlockChoice | undefined,
): Map<string, number> {
  const map = new Map<string, number>();
  if (!choice || choice.kind === "skip") return map;
  const { amount, count: cap } = weaponCounterBlockEffects(state, session);
  if (amount <= 0 || cap <= 0) return map;
  const picks = choice.enemyInstanceIds.slice(0, cap);
  for (const id of picks) {
    map.set(id, (map.get(id) ?? 0) + amount);
  }
  return map;
}

/**
 * Enumerate the counterattacking enemies that would actually deal
 * damage to at least one delver under the given counter outcome.
 * Used by the UI to decide whether to open the Trident counter-
 * block prompt at all (no eligible enemies = no prompt) and to
 * render one button per enemy.
 *
 * Each entry includes the per-delver damage the enemy would
 * contribute (without any block applied), so the UI can show
 * "Block this enemy: -1 dmg to {Suit} Delver" labels that match
 * the post-block reality once the chosen enemy's effective attack
 * is reduced.
 */
export interface CounterBlockCandidate {
  /** Enemy instance to pass into `WeaponCounterBlockChoice.enemyInstanceId`. */
  enemyInstanceId: string;
  /** Snapshot card id (for name + image lookup). */
  cardId: string;
  /** Pre-block per-hero contributions (heroId → damage). Heroes with
   *  0 contribution are omitted (this enemy doesn't hit them). */
  preBlockDamage: { heroId: string; damage: number }[];
  /** Pre-block attack value (the enemy's printed `attack`). */
  preBlockAttack: number;
}

export function counterBlockCandidates(
  state: CampaignState,
  session: AttackSession,
): CounterBlockCandidate[] {
  const phase = session.sharedCounter;
  if (!phase) return [];
  if (!state.encounter) return [];
  if (sessionWeaponCounterBlockAmount(state, session) <= 0) return [];

  const strikes = computeCounterStrikes(state, phase.damagedEnemies, phase.outcome, phase.rolled);
  const out: CounterBlockCandidate[] = [];
  for (const ds of phase.damagedEnemies) {
    const mine = strikes.filter((st) => st.instanceId === ds.instanceId);
    if (mine.length === 0) continue;
    if (out.some((c) => c.enemyInstanceId === ds.instanceId)) continue;
    out.push({
      enemyInstanceId: ds.instanceId,
      cardId: ds.cardId,
      preBlockDamage: mine.map((st) => ({ heroId: st.heroId, damage: st.damage })),
      preBlockAttack: mine[0]!.damage,
    });
  }
  return out;
}

/** Read a Sol/Lunar Shield's effect (or null if the card isn't a shield). */
function getShieldEffect(cardId: string): Extract<EquipmentEffect, { kind: "block-on-tile" }> | null {
  const card = getEquipment(cardId);
  if (card.type !== "Shield" || !card.effects) return null;
  for (const eff of card.effects) {
    if (eff.kind === "block-on-tile") return eff;
  }
  return null;
}

/** True iff a hero owns a card type at rank >= 1. The shield card id
 *  is `${suit}-shield-r1` for the R1 shield (Sol or Lunar), so we
 *  query `getEffectiveEquipmentRank(state, heroId, "Shield")` so a
 *  Xavier-granted +1 RANK that lifts a delver from R0 to R1 Shield
 *  also turns the parry-on-counter rule on for the quest. */
function ownsShield(state: CampaignState, heroId: string): boolean {
  return getEffectiveEquipmentRank(state, heroId, "Shield") >= 1;
}

/** Resolve the shield card id a hero is currently using at their
 *  EFFECTIVE rank (rank-aware since 2026-07-22 — pre-fix this
 *  hard-returned the R1 id, so Shield R2-R5 block values
 *  (baseBlock 2-5, bonusBlock 3-6) never applied in play). Clamped
 *  to R1 when unowned (callers gate on `ownsShield` first). */
function shieldCardIdForHero(state: CampaignState, heroId: string): string {
  const rank = Math.max(1, getEffectiveEquipmentRank(state, heroId, "Shield"));
  // Variant-aware (2026-07-22): Earth's Embrace Shield replaces the
  // Sol/Lunar family when the Machinist product is owned.
  return getEquipmentCardFor(state, heroId, "Shield", rank).id;
}

/** Pure forecast: which shield activation prompts should the UI show
 *  before applying counter damage?
 *
 *  Returns one entry per eligible shield-bearer (deterministic order:
 *  the shield-bearer's heroId from `Object.keys(state.loadouts)`).
 *  Caller (UI) walks the queue, gathers a `ShieldChoice` for each,
 *  then passes the choices to `applyCounterDamageWithShieldChoices`.
 *
 *  Returns an empty array on `miss` or when no shield-bearer is on a
 *  tile with a damaged delver. */
export function findShieldOpportunities(
  state: CampaignState,
  damaged: readonly DamagedEnemySnapshot[],
  outcome: CounterAttackOutcome,
  /** Same `weapon-counter-block` reductions the eventual
   *  `applyCounterDamageWithShieldChoices` call will use — passed in
   *  so the per-bearer "incoming damage" preview reflects the post-
   *  block reality (a 0-damage tile-mate is silently dropped). */
  weaponCounterBlockByEnemy?: ReadonlyMap<string, number>,
  /** The rolled d6 when known (Critical). */
  rolled?: number,
): ShieldOpportunity[] {
  const enc = state.encounter;
  if (!enc) return [];
  const strikes = computeCounterStrikes(state, damaged, outcome, rolled, weaponCounterBlockByEnemy);
  if (strikes.length === 0) return [];
  const damageByHero = new Map<string, number>();
  for (const st of strikes) damageByHero.set(st.heroId, (damageByHero.get(st.heroId) ?? 0) + st.damage);

  // Cap by bearer = count of DISTINCT counterattackers striking a
  // delver on the bearer's tile ("1 shield per enemy counterattack").
  const capByBearer = shieldCapsFromStrikes(state, strikes);
  return findShieldOpportunitiesForDamageMap(state, damageByHero, capByBearer);
}

/**
 * Apply shield-spend choices to a per-hero damage map, mutating it in
 * place. Used by both counter-damage resolution
 * (`applyCounterDamageWithShieldChoices`) and parting-shot resolution
 * (`engine/wave.ts > resolvePartingShot`) so the bearer-side
 * mechanics (debit element, block per-tile-mate, accrue overblock
 * heal) live in one place and stay in lockstep across damage sources.
 *
 * Caller responsibilities:
 *   - Build `damageByHero` so each entry is the post-pre-block
 *     damage the delver would otherwise take.
 *   - Build `capByBearer` per the source's "1 activation per X"
 *     rule (counter: distinct counterattackers hitting bearer tile;
 *     parting-shot: 1 — single source enemy).
 *   - Caller may over-supply elements; the helper TRUNCATES the
 *     `choice.elements` array to `capByBearer.get(bearerId) ?? 0`
 *     defensively so a stale UI can never over-spend past the cap.
 *
 * Behaviour:
 *   - `kind: "skip"` (or `kind: "spend"` with empty `elements`) is
 *     a no-op for that bearer.
 *   - Each activation looks up the bearer's CURRENT bag count for
 *     the chosen element; a count of 0 silently drops that single
 *     activation but doesn't cascade-fail the rest.
 *   - Each activation applies its own `baseBlock` / `bonusBlock` to
 *     every still-damaged tile-mate on the bearer's tile, with
 *     spillover accruing toward the bearer's overblock-heal pool.
 *   - Tile-mates already reduced to 0 are skipped (no element-to-HP
 *     heal pump beyond genuine block-needed activations).
 *   - The shield card must be currently equipped; a `spend` choice
 *     with no shield is silently dropped.
 */
export function applyShieldChoicesToDamageMap(
  state: CampaignState,
  damageByHero: Map<string, number>,
  choices: Record<string, ShieldChoice>,
  capByBearer: ReadonlyMap<string, number>,
): void {
  const enc = state.encounter;
  if (!enc) return;
  for (const [bearerId, choice] of Object.entries(choices)) {
    if (choice.kind === "skip") continue;
    if (choice.elements.length === 0) continue;
    const cap = capByBearer.get(bearerId) ?? 0;
    if (cap <= 0) continue;
    const shield = getShieldEffect(shieldCardIdForHero(state, bearerId));
    if (!shield) continue;
    const bearerLoadout = state.loadouts[bearerId];
    if (!bearerLoadout) continue;
    const pos = enc.delverPositions[bearerId];
    if (!pos) continue;
    const bag = state.elements[bearerId] ?? {};
    state.elements[bearerId] = bag;
    const elementsToApply = choice.elements.slice(0, cap);
    let overblockTotal = 0;

    for (const element of elementsToApply) {
      const have = bag[element] ?? 0;
      if (have < 1) continue;
      const blockAmount = element === shield.bonusElement
        ? shield.bonusBlock
        : shield.baseBlock;
      bag[element] = have - 1;
      logEvent("engine.spendElement", {
        heroId: bearerId,
        element,
        reason: "shield-block",
        cardId: shieldCardIdForHero(state, bearerId),
        newTotal: have - 1,
      });
      for (const tileMateId of getDelversAt(enc, pos.x, pos.y)) {
        const dmg = damageByHero.get(tileMateId) ?? 0;
        if (dmg <= 0) continue;
        const blocked = Math.min(dmg, blockAmount);
        damageByHero.set(tileMateId, dmg - blocked);
        overblockTotal += blockAmount - blocked;
      }

      // Earth's Embrace Shield (Equipment Upgrade #151-155):
      // "Additionally heal N HP if you spent: [Earth]" — a flat
      // per-activation heal to the bearer when the SPENT element is
      // the card's bonus element. Sol / Lunar shields omit the field
      // (they heal per overblock instead — see below).
      if (element === shield.bonusElement && (shield.healOnBonusElementSpend ?? 0) > 0) {
        bearerLoadout.currentHp = Math.min(
          bearerLoadout.maxHp,
          bearerLoadout.currentHp + shield.healOnBonusElementSpend!,
        );
      }
    }

    if (overblockTotal > 0 && shield.healPerOverblock > 0) {
      const heal = overblockTotal * shield.healPerOverblock;
      bearerLoadout.currentHp = Math.min(
        bearerLoadout.maxHp,
        bearerLoadout.currentHp + heal,
      );
    }
  }
}

/**
 * Find shield-activation opportunities for an arbitrary per-hero
 * damage map. Generic helper used by both
 * `findShieldOpportunities` (counter-attacks; computes caps from
 * the damaged-enemies snapshot) and
 * `findPartingShotShieldOpportunities` (parting shots; passes
 * cap=1 since a parting shot is a single enemy).
 *
 * Returns one entry per shield-bearer who:
 *   - Owns a shield (rank > 0).
 *   - Has at least one element in their bag.
 *   - Stands on a tile with at least one damaged delver
 *     (`damageByHero.get(tileMate) > 0`).
 *   - Has a positive cap (`capByBearer.get(bearerId) > 0`).
 *
 * Order: stable by hero id (matches counter version's deterministic
 * UI order). Empty result when no bearer satisfies all four
 * conditions — callers gate the prompt on a non-empty result.
 */
export function findShieldOpportunitiesForDamageMap(
  state: CampaignState,
  damageByHero: ReadonlyMap<string, number>,
  capByBearer: ReadonlyMap<string, number>,
): ShieldOpportunity[] {
  const enc = state.encounter;
  if (!enc) return [];
  const opportunities: ShieldOpportunity[] = [];
  for (const heroId of Object.keys(state.loadouts).sort()) {
    if (!ownsShield(state, heroId)) continue;
    const bag = state.elements[heroId] ?? {};
    const availableElements: Element[] = (Object.keys(bag) as Element[])
      .filter((el) => (bag[el] ?? 0) > 0)
      .sort();
    if (availableElements.length === 0) continue;
    const cardId = shieldCardIdForHero(state, heroId);
    const shield = getShieldEffect(cardId);
    if (!shield) continue;
    const pos = enc.delverPositions[heroId];
    if (!pos) continue;
    const tileMatesAtRisk: { heroId: string; incomingDamage: number }[] = [];
    for (const candidateId of getDelversAt(enc, pos.x, pos.y)) {
      const d = damageByHero.get(candidateId) ?? 0;
      if (d > 0) tileMatesAtRisk.push({ heroId: candidateId, incomingDamage: d });
    }
    if (tileMatesAtRisk.length === 0) continue;
    const cap = capByBearer.get(heroId) ?? 0;
    if (cap <= 0) continue;

    opportunities.push({
      shieldBearerHeroId: heroId,
      shieldCardId: cardId,
      baseBlock: shield.baseBlock,
      bonusElement: shield.bonusElement,
      bonusBlock: shield.bonusBlock,
      healPerOverblock: shield.healPerOverblock,
      availableElements,
      protectedDelvers: tileMatesAtRisk,
      maxActivations: cap,
    });
  }
  return opportunities;
}

/** Like `resolveSharedCounter` but folds shield activations in BEFORE
 *  the per-delver HP loss is committed.
 *
 *  Algorithm:
 *    1. Recompute per-delver damage from the rolled outcome (mirrors
 *       `previewCounterHitsByDelver` exactly).
 *    2. For each shield activation in `choices` with `kind: "spend"`:
 *       - Look up the shield's block amount (bonusBlock if the chosen
 *         element matches `bonusElement`, else baseBlock).
 *       - Decrement the bearer's element bag by 1 of the chosen element.
 *       - For each delver on the bearer's tile with incoming damage:
 *         their damage is reduced by min(damage, blockAmount); any
 *         leftover counts as "overblock". Sum overblock across the
 *         tile, multiply by healPerOverblock, heal the bearer
 *         (clamped at maxHp).
 *    3. Apply the (possibly reduced) damage to each loadout's
 *       `currentHp` (clamped at 0).
 *    4. Populate `phase.hits` with one entry per (heroId, finalDamage)
 *       where finalDamage > 0. NOTE: this is per-hero totals, NOT the
 *       per-offset entries that the existing `resolveSharedCounter`
 *       emits — callers that need offset-level breakdowns should use
 *       the no-shields path.
 *
 *  Idempotent: subsequent calls are no-ops.
 *
 *  Throws if `resolveAllDamage` hasn't been called first. */
export function applyCounterDamageWithShieldChoices(
  state: CampaignState,
  session: AttackSession,
  rolled: number,
  choices: Record<string, ShieldChoice>,
  weaponCounterBlock?: WeaponCounterBlockChoice,
): SharedCounterPhase {
  const phase = session.sharedCounter;
  if (!phase) throw new Error("applyCounterDamageWithShieldChoices: damage phase has not run");
  if (phase.resolved) return phase;

  phase.rolled = rolled;
  phase.outcome = rolled < 0 ? "miss" : counterAttackOutcomeForRoll(rolled);
  phase.hits = [];

  const enc = state.encounter;
  if (rolled < 0 || !enc) {
    // Auto-skip (nothing could land). Passives still fire on the attempt.
    applyPostCounterPassives(state, phase, session.attackerId);
    phase.resolved = true;
    return phase;
  }

  // `weapon-counter-block`: reduce each chosen counterattacker's
  // effective attack BEFORE per-hero totals are computed, so shield
  // overblock-heals are computed against the post-block damage.
  const blockAmountByEnemy = weaponCounterBlockMap(state, session, weaponCounterBlock);

  // 1. Per-hero totals from the shared strike helper.
  const strikes = computeCounterStrikes(state, phase.damagedEnemies, phase.outcome, rolled, blockAmountByEnemy);
  phase.strikes = strikes;
  recordCounterAbilityProcs(state, phase.damagedEnemies, phase.outcome, rolled, strikes);
  const damageByHero = new Map<string, number>();
  for (const st of strikes) damageByHero.set(st.heroId, (damageByHero.get(st.heroId) ?? 0) + st.damage);

  // 2. Shield activations, capped at one per counterattacker striking
  // the bearer's tile (mirrors `findShieldOpportunities`).
  applyShieldChoicesToDamageMap(state, damageByHero, choices, shieldCapsFromStrikes(state, strikes));

  // 3. Commit final per-hero damage.
  for (const [heroId, finalDamage] of damageByHero.entries()) {
    if (finalDamage <= 0) continue;
    if (!state.loadouts[heroId]) continue;
    const dealt = damageDelverInWave(state, heroId, finalDamage);
    // Omen: one token per Omen enemy whose strike landed on this delver.
    for (const st of strikes) {
      if (st.heroId !== heroId || st.damage <= 0) continue;
      const striker = enc.enemies.find((e) => e.instanceId === st.instanceId);
      if (striker && hasEnemyAbility(getEnemy(striker.cardId), "omen")) {
        enc.omenTokens[heroId] = (enc.omenTokens[heroId] ?? 0) + 1;
      }
    }
    phase.hits.push({ heroId, damage: dealt });
  }

  // 4. Post-counter passives — must fire on the shielded path too.
  applyPostCounterPassives(state, phase, session.attackerId);

  phase.resolved = true;
  return phase;
}

/**
 * Finalize the session — applies post-effects (e.g. Surge Claw's
 * `collect-creature-part`) and runs `applyPendingLevelUps` once.
 * Then performs the rulebook-p26 delver-death short-circuit: if
 * any delver's HP fell to 0 during this attack (self-suffer or
 * counter-attack), flip the encounter into End-of-Wave (defeat)
 * immediately. The UI checks `state.encounter.phase` after the
 * counter-roll modal closes (and after `advanceAfterAction`) to
 * know whether to switch screens.
 *
 * `creaturePartsEnqueued` reports how many CREATURE PART picks
 * the swing pushed onto `pendingCreaturePartChoices` — non-zero
 * for Gauntlet swings carrying `collect-creature-part`. Callers
 * use this to gate the post-finalise wallet-fly animation
 * (deferred to the per-pick modal handler) and to know whether
 * to expect a `creature-part-pick` modal in `advanceAfterAction`.
 *
 * Idempotent (subsequent calls are no-ops).
 */
export function finalizeAttackSession(
  state: CampaignState,
  session: AttackSession,
): { levelUps: number; creaturePartsEnqueued: number } {
  if (session.finalized) return { levelUps: session.levelUpsApplied, creaturePartsEnqueued: 0 };

  let creaturePartsEnqueued = 0;

  // Apply deferred on-death side-effects — flipping `alive = false`
  // (which removes the token from the board) and `applyKill` (which
  // grants XP, drops, and element tokens). We defer these to the
  // finalize step so the dying enemy stays visible on the board for
  // the full duration of the shared counter-roll prompt (rulebook
  // p22-23 — counter happens before the body is cleared).
  const enc = state.encounter;
  if (enc) {
    for (const step of session.steps) {
      if (!step.killed || !step.enemyInstanceId) continue;
      const enemy = enc.enemies.find((e) => e.instanceId === step.enemyInstanceId);
      if (!enemy || !enemy.alive) continue;
      enemy.alive = false;
      step.killResult = applyKill(state, getEnemy(enemy.cardId), { x: enemy.x, y: enemy.y });
      onEnemyDiedForRebirth(state, enemy);
      // Ch4 Last Act: the delver that slayed it suffers 4 damage.
      if (hasAbility(getEnemy(enemy.cardId), "last-act")) {
        damageDelverInWave(state, session.attackerId, LAST_ACT_DAMAGE, getEnemy(enemy.cardId));
        recordAbilityProc(enemy, "last-act");
        logEvent("combat.lastAct", { instanceId: enemy.instanceId, attackerId: session.attackerId });
      }
    }
    // Sword of Ruin: "If target dies, gain 1 Wind."
    if (session.gainElementOnKill && session.steps.some((st) => st.killed)) {
      for (let i = 0; i < session.gainElementOnKill.amount; i++) {
        grantElementToDelver(state, session.attackerId, session.gainElementOnKill.element);
      }
    }
    // 2-card boss: "When destroyed, remove both cards." The 2/2 card has
    // no rewards of its own.
    for (const part of enc.enemies) {
      if (!part.linkedTo || !part.alive) continue;
      const boss = enc.enemies.find((e) => e.instanceId === part.linkedTo);
      if (boss && !boss.alive) part.alive = false;
    }
    applyDeathHeal(state, session);
    applyStealsAndRitual(state, session);
  }

  for (const eff of session.postEffects) {
    if (eff.kind === "collect-creature-part") {
      // Per audit confirmation 2026-05-24: CREATURE PART is a
      // parent type — the player picks MINION or BOSS for each
      // token granted. Enqueue one pick per `count` so a R3
      // Surge Claw swing produces TWO separate prompts (each
      // can independently resolve to MINION or BOSS).
      // Pre-2026-05-24 the engine always credited
      // `state.minionParts[attackerId]` directly here.
      for (let i = 0; i < eff.count; i++) {
        enqueueCreaturePartChoice(state, session.attackerId, eff.sourceCardId);
        creaturePartsEnqueued += 1;
      }
    }
  }
  const levelUps = applyPendingLevelUps(state);
  session.finalized = true;
  session.levelUpsApplied = levelUps;
  onDelverDamaged(state);
  return { levelUps, creaturePartsEnqueued };
}

// --- Internals ----------------------------------------------------------

function isAdj8(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  if (a.x === b.x && a.y === b.y) return false;
  return Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;
}

function key(x: number, y: number): string {
  return `${x},${y}`;
}

/**
 * Ch4 Steals (Ruined Tidekin) and Ritual (Winona the Oak), after a swing:
 *   - Steals: a weapon that damaged it is stolen (the previous one comes
 *     back, exhausted); killing it - or it leaving play - returns it.
 *   - Ritual: a weapon that damaged it (and didn't kill it) costs the
 *     attacker a sacrifice; killing it restores every sacrifice.
 */
function applyStealsAndRitual(state: CampaignState, session: AttackSession): void {
  const enc = state.encounter!;
  const weaponHit = (kind: "steals" | "ritual") => session.source.kind === "weapon" ? session.steps.find((st) => {
    if (!st.enemyInstanceId || st.damageApplied <= 0) return false;
    const e = enc.enemies.find((x) => x.instanceId === st.enemyInstanceId);
    return !!e && hasAbility(getEnemy(e.cardId), kind);
  }) : undefined;
  const stealer = weaponHit("steals");
  if (stealer && session.source.kind === "weapon") {
    const boss = enc.enemies.find((x) => x.instanceId === stealer.enemyInstanceId)!;
    if (boss.alive) {
      stealWeapon(state, session.attackerId, session.source.cardId);
      recordAbilityProc(boss, "steals");
    }
  }
  if (enc.stolenWeapon && !enc.enemies.some((e) => e.alive && hasAbility(getEnemy(e.cardId), "steals"))) {
    returnStolenWeapon(state);
  }
  const ritual = weaponHit("ritual");
  if (ritual) {
    const boss = enc.enemies.find((x) => x.instanceId === ritual.enemyInstanceId)!;
    if (boss.alive) {
      enc.pendingRitualPicks.push(session.attackerId);
      recordAbilityProc(boss, "ritual");
    }
  }
  if ((enc.ritualSacrifices.length > 0 || enc.pendingRitualPicks.length > 0)
      && !enc.enemies.some((e) => e.alive && hasAbility(getEnemy(e.cardId), "ritual"))) {
    clearRitual(state);
  }
}
