/**
 * Boots ONGOING ability engine.
 *
 * Two cards, two ONGOING effects with the same activation pattern:
 *
 *   - Strider Boots (Body, R1) — "ONGOING: You may spend 2 movement to
 *     MOVE an adjacent enemy." Implemented here as
 *     {@link moveAdjacentEnemy}.
 *   - Slip Strider Boots (Mind, R1) — "ONGOING: You may spend 2 movement
 *     to ROTATE an adjacent enemy." Phase 3 work; see TODO at the bottom.
 *
 * Activation rules (per design decision 2026-05-03, refined 2026-05-04):
 *   - Bearer must own Boots at rank ≥ 1 (suit-correct R1 card id).
 *   - Activation gated on `currentMovement >= 2` AND
 *     `!turnState.movementUsedThisTurn` — i.e. the bearer hasn't yet
 *     issued a normal MOVE order this turn (Boots and a normal move
 *     are mutually-exclusive in the move-step gating direction; once
 *     a delver moves they can't pivot to Boots, but Boots itself
 *     does NOT close out the move step).
 *   - Spending the ability decrements `currentMovement` by 2 but
 *     does NOT set `movementUsedThisTurn`. Rationale: the printed
 *     card text says "spend 2 movement", which we read as "spend 2
 *     movement POINTS from the pool" rather than "use up your one
 *     movement step". With Boots' baseMovement of 2 the practical
 *     effect is the same (2 points = whole pool), but a delver who
 *     buffed up to 4 movement (e.g. AP-spend "Double Movement" or a
 *     +1 movement slot ability) can use Boots, then either use it
 *     AGAIN or issue a normal move with the remaining points.
 *   - The IMMEDIATELY effect ("Set your movement to 2") is wired in
 *     `state.ts > applyImmediatePassiveEffects` so the bearer always
 *     has a 2-movement floor to spend.
 *
 * Move semantics (Strider Boots):
 *   - Target enemy must be 8-way adjacent to the bearer.
 *   - Destination tile must be (a) within board bounds, (b) NOT
 *     occupied by another enemy, and (c) NOT occupied by any delver.
 *   - The 8 candidate destinations are every tile within 1 of the
 *     enemy's CURRENT position (offset list = ADJACENT_OFFSETS_8WAY,
 *     enemy stays put if no offset is supplied — caller must pass a
 *     non-zero offset).
 *   - The enemy may be moved off-bearer-adjacent: the rule only
 *     constrains the START position relative to the bearer, not the
 *     end. (The card text specifies "adjacent" once, applied to the
 *     trigger; the destination is unconstrained beyond board/occupancy.)
 */

import type { CampaignState, EnemyFacing, EnemyInstance } from "../state";
import { getEffectiveEquipmentRank, getEquipmentCardFor } from "../state";
import type { BoardBounds } from "./movement";
import { ADJACENT_OFFSETS_8WAY } from "../rules";
import { getEnemyAt, getDelverAt, getEnemyInstance, isMultiCardBoss } from "./encounter";
import { getHero } from "../data";

/** Movement cost of one STANDARD Boots ONGOING activation. Cyclone
 *  Boots (Machinist Equipment Upgrade) override this to 1 via the
 *  `boots-ongoing-override` effect — always read the live cost via
 *  {@link bootsOngoingCost}. */
export const BOOTS_ONGOING_COST = 2;

/** The `boots-ongoing-override` effect on the bearer's live Boots
 *  card (variant + rank aware), or null for standard Boots. */
function bootsOngoingOverride(state: CampaignState, heroId: string) {
  const rank = getEffectiveEquipmentRank(state, heroId, "Boots");
  if (rank < 1) return null;
  try {
    const card = getEquipmentCardFor(state, heroId, "Boots", rank);
    for (const eff of card.effects ?? []) {
      if (eff.kind === "boots-ongoing-override") return eff;
    }
  } catch { /* data gap */ }
  return null;
}

/** Live movement cost of one Boots ONGOING activation (2 standard,
 *  1 with Cyclone Boots). */
export function bootsOngoingCost(state: CampaignState, heroId: string): number {
  return bootsOngoingOverride(state, heroId)?.cost ?? BOOTS_ONGOING_COST;
}

/** Which ONGOING modes the bearer's live Boots card allows.
 *  Standard: Strider (Body) moves, Slip Strider (Mind) rotates.
 *  Cyclone Boots: BOTH, regardless of suit. */
export function bootsModes(
  state: CampaignState,
  heroId: string,
): { canMove: boolean; canRotate: boolean } {
  const ov = bootsOngoingOverride(state, heroId);
  if (ov) return { canMove: ov.canMove, canRotate: ov.canRotate };
  const suit = getHero(heroId).suit;
  return { canMove: suit === "body", canRotate: suit === "mind" };
}

/**
 * Suit-correct Boots R1 card id. The IMMEDIATELY hook applies the same
 * floor for both, but the ONGOING text differs (Mind = rotate, Body =
 * move) so the engine still keys off suit when checking ownership.
 */
function bootsCardIdForSuit(suit: "mind" | "body"): string {
  return suit === "mind" ? "mind-boots-r1" : "body-boots-r1";
}

/** Does the given delver own a Boots card at rank ≥ 1?
 *  Reads EFFECTIVE rank so a temporary Xavier bump (0 -> 1) also
 *  flips ownership ON for the quest's duration, and a Detractor
 *  bump (1 -> 0) flips it OFF (the Boots ONGOING + immediate
 *  +movement floor stop applying until the bonus clears at quest
 *  end). Matches the same effective-rank gate used by combat's
 *  `ownsShield` and the HandPanel's hand composition. */
export function ownsBoots(state: CampaignState, heroId: string): boolean {
  return getEffectiveEquipmentRank(state, heroId, "Boots") >= 1;
}

/**
 * Convenience: id of the Boots card the given delver owns (whichever
 * suit they are). Returns `null` if they don't own Boots.
 */
export function bootsCardIdForHero(state: CampaignState, heroId: string): string | null {
  if (!ownsBoots(state, heroId)) return null;
  return bootsCardIdForSuit(getHero(heroId).suit);
}

/**
 * Can the bearer activate the Boots ONGOING right now? Pure check —
 * does NOT mutate. Used by both the engine validators below and the
 * UI gate for showing/arming the ability.
 *
 * Returns a tagged result so the UI can surface the SPECIFIC reason
 * the ability is unavailable (tooltip text). The engine functions
 * call this and short-circuit on `ok: false`.
 */
export type BootsActivationCheck =
  | { ok: true }
  | { ok: false; reason: string };

export function canActivateBootsOngoing(
  state: CampaignState,
  heroId: string,
): BootsActivationCheck {
  const enc = state.encounter;
  if (!enc) return { ok: false, reason: "no active encounter" };
  if (!ownsBoots(state, heroId)) return { ok: false, reason: "delver does not own Boots" };
  const lo = state.loadouts[heroId];
  if (!lo) return { ok: false, reason: "delver has no loadout" };
  const cost = bootsOngoingCost(state, heroId);
  if (lo.currentMovement < cost) {
    return { ok: false, reason: `needs ${cost} movement (has ${lo.currentMovement})` };
  }
  const ts = enc.turnState[heroId];
  if (!ts) return { ok: false, reason: "delver has no turn state" };
  if (ts.cardPlacedThisTurn === null) {
    return { ok: false, reason: "must place a weapon this turn first" };
  }
  if (ts.movementUsedThisTurn) {
    return { ok: false, reason: "movement already used this turn" };
  }
  if (enc.preparedToRun[heroId]) {
    return { ok: false, reason: "already prepared to run" };
  }
  if (!getDelverAt(enc, heroId)) {
    return { ok: false, reason: "delver not on the board" };
  }
  return { ok: true };
}

/**
 * Every enemy 8-way adjacent to the given bearer that is a legal
 * trigger target for the Boots ONGOING. The ability's other
 * preconditions (ownership, movement budget, turn-state) are NOT
 * checked here — call `canActivateBootsOngoing` for that. This is
 * the spatial half only.
 */
export function adjacentEnemyTargets(
  state: CampaignState,
  heroId: string,
): EnemyInstance[] {
  const enc = state.encounter;
  if (!enc) return [];
  const pos = getDelverAt(enc, heroId);
  if (!pos) return [];
  const out: EnemyInstance[] = [];
  for (const off of ADJACENT_OFFSETS_8WAY) {
    const e = getEnemyAt(enc, pos.x + off.dx, pos.y + off.dy);
    if (e) out.push(e);
  }
  return out;
}

/**
 * Tiles a given adjacent enemy could be moved to. 8-way around the
 * enemy's current position, excluding off-board, enemy-occupied, and
 * delver-occupied tiles.
 *
 * Pure helper — does NOT mutate. Used both by the UI (highlight legal
 * destination tiles) and by `moveAdjacentEnemy` (revalidation).
 */
export function legalMoveDestinationsForEnemy(
  state: CampaignState,
  enemyInstanceId: string,
  board: BoardBounds,
): { x: number; y: number }[] {
  const enc = state.encounter;
  if (!enc) return [];
  const enemy = getEnemyInstance(enc, enemyInstanceId);
  if (!enemy || !enemy.alive) return [];
  // A 2-card boss's cards must stay side by side.
  if (isMultiCardBoss(enc, enemy)) return [];
  const out: { x: number; y: number }[] = [];
  for (const off of ADJACENT_OFFSETS_8WAY) {
    const nx = enemy.x + off.dx;
    const ny = enemy.y + off.dy;
    if (nx < 0 || ny < 0 || nx >= board.w || ny >= board.h) continue;
    if (getEnemyAt(enc, nx, ny)) continue;
    // Delver-occupied tiles are blocked too (rules: enemies and
    // delvers can't share a tile post-spawn — see DESIGN.md §5.1).
    let delverHere = false;
    for (const pos of Object.values(enc.delverPositions)) {
      if (pos.x === nx && pos.y === ny) { delverHere = true; break; }
    }
    if (delverHere) continue;
    out.push({ x: nx, y: ny });
  }
  return out;
}

export type MoveEnemyResult =
  | { ok: true; from: { x: number; y: number }; to: { x: number; y: number }; enemyInstanceId: string }
  | { ok: false; reason: string };

/**
 * Strider Boots (Body) ONGOING: spend 2 movement to move an adjacent
 * enemy by 1 tile (8-way) into a legal destination. Mutates state.
 *
 * Validation chain:
 *   1. `canActivateBootsOngoing` (suit-agnostic — the IMMEDIATELY
 *      and ONGOING gates are the same).
 *   2. Bearer must be the BODY suit (this is the body-only ability).
 *   3. Target enemy must be alive, 8-way adjacent to the bearer.
 *   4. Destination (toX, toY) must be in
 *      `legalMoveDestinationsForEnemy`.
 *
 * On success: enemy.x/y updated, `currentMovement -= 2`. Bearer's
 * position is unchanged. `movementUsedThisTurn` is NOT latched —
 * see module-level docs: Boots spends movement POINTS, not the
 * once-per-turn movement step.
 */
export function moveAdjacentEnemy(
  state: CampaignState,
  heroId: string,
  enemyInstanceId: string,
  toX: number,
  toY: number,
  board: BoardBounds,
): MoveEnemyResult {
  const check = canActivateBootsOngoing(state, heroId);
  if (!check.ok) return { ok: false, reason: check.reason };

  if (!bootsModes(state, heroId).canMove) {
    return { ok: false, reason: "this delver's Boots cannot MOVE enemies (Strider / Cyclone only)" };
  }

  const enc = state.encounter!;
  const lo = state.loadouts[heroId]!;
  const bearerPos = getDelverAt(enc, heroId)!;

  const enemy = getEnemyInstance(enc, enemyInstanceId);
  if (!enemy || !enemy.alive) {
    return { ok: false, reason: "target enemy not found or dead" };
  }

  // Adjacency check between bearer and enemy's CURRENT position.
  const dx = enemy.x - bearerPos.x;
  const dy = enemy.y - bearerPos.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) !== 1) {
    return { ok: false, reason: "target enemy is not 8-way adjacent to the delver" };
  }

  const legal = legalMoveDestinationsForEnemy(state, enemyInstanceId, board);
  const dest = legal.find((t) => t.x === toX && t.y === toY);
  if (!dest) {
    return { ok: false, reason: "destination is not a legal move target" };
  }

  // Mutate. Spend movement POINTS but leave the move-step flag alone
  // so a delver with leftover movement (e.g. buffed via AP-spend or a
  // bonus-movement slot ability) can still use it on a normal move,
  // or call Boots again.
  const from = { x: enemy.x, y: enemy.y };
  enemy.x = toX;
  enemy.y = toY;
  lo.currentMovement -= bootsOngoingCost(state, heroId);

  return { ok: true, from, to: { x: toX, y: toY }, enemyInstanceId };
}

// --- Slip Strider Boots (Mind) ONGOING: rotate adjacent enemy ---------

/**
 * Player-chosen rotation amount for one Slip Strider activation. The
 * card lets the bearer rotate an adjacent enemy by 90°, 180°, or
 * 270° clockwise (player's choice) for a single 2-movement spend.
 * 270° CW is equivalent to 90° CCW, so the three values cover every
 * non-trivial reorientation. (0° / 360° is omitted — there's no
 * reason to spend movement to leave facing unchanged.)
 *
 * Per design clarification 2026-05-24: the activation cost is 2
 * movement REGARDLESS of rotation amount — the player isn't paying
 * per quarter-turn. With the Boots-mandated movement floor of 2 a
 * single rotate is always affordable; a buffed bearer (≥4 movement)
 * can chain a second rotate on a different enemy in the same turn.
 */
export type RotateAmount = 90 | 180 | 270;

export type RotateEnemyResult =
  | { ok: true; enemyInstanceId: string; from: EnemyFacing; to: EnemyFacing; amount: RotateAmount }
  | { ok: false; reason: string };

/**
 * Apply a 90° / 180° / 270° clockwise rotation to the bearer's
 * chosen adjacent enemy. Mutates the enemy's `facing` field and
 * spends 2 movement (single fixed cost — see {@link RotateAmount}).
 * Same gating as the Body sibling (see `moveAdjacentEnemy`) and same
 * point-vs-step semantics: `movementUsedThisTurn` is NOT latched, so
 * a buffed delver with leftover movement can keep using the ability
 * or fall back to a normal move.
 *
 * Validation chain mirrors `moveAdjacentEnemy`:
 *   1. `canActivateBootsOngoing` (suit-agnostic budget / placement /
 *      ownership gate).
 *   2. Bearer must be the MIND suit (this is the mind-only ability).
 *   3. Target enemy must be alive AND 8-way adjacent to the bearer.
 *
 * The new facing is computed modulo 360 so it always lands on one of
 * the four canonical {0, 90, 180, 270} values.
 */
export function rotateAdjacentEnemy(
  state: CampaignState,
  heroId: string,
  enemyInstanceId: string,
  amount: RotateAmount,
): RotateEnemyResult {
  const check = canActivateBootsOngoing(state, heroId);
  if (!check.ok) return { ok: false, reason: check.reason };

  if (!bootsModes(state, heroId).canRotate) {
    return { ok: false, reason: "this delver's Boots cannot ROTATE enemies (Slip Strider / Cyclone only)" };
  }

  const enc = state.encounter!;
  const lo = state.loadouts[heroId]!;
  const bearerPos = getDelverAt(enc, heroId)!;

  const enemy = getEnemyInstance(enc, enemyInstanceId);
  if (!enemy || !enemy.alive) {
    return { ok: false, reason: "target enemy not found or dead" };
  }

  const dx = enemy.x - bearerPos.x;
  const dy = enemy.y - bearerPos.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) !== 1) {
    return { ok: false, reason: "target enemy is not 8-way adjacent to the delver" };
  }
  if (isMultiCardBoss(enc, enemy)) {
    return { ok: false, reason: "a 2-card boss can't be rotated" };
  }

  const from = enemy.facing;
  const next = ((from + amount) % 360) as EnemyFacing;
  enemy.facing = next;
  lo.currentMovement -= bootsOngoingCost(state, heroId);

  return { ok: true, enemyInstanceId, from, to: next, amount };
}
