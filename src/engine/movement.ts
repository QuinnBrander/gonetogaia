/**
 * Movement step engine (rulebook p19, DESIGN.md §5.1).
 *
 * One Hero Phase turn = Movement step + Action step (either order).
 * The Movement step is now **step-by-step** (DESIGN.md §5.1 — change
 * 2026-05-09): the player commits one tile at a time, spending 1
 * movement point per step, until they either run out of MP or
 * explicitly end the session. This lets them pick a path that
 * collects creature parts en route and double back if needed,
 * instead of pre-committing to a single multi-step destination.
 *
 * This file owns:
 *
 *   1. `legalStepDestinations(state, heroId, board)` — the 8-way
 *      adjacent walkable tiles from the delver's current position.
 *      Same turn-state gates as before (post-placement, not Prepared
 *      to Run, not already movement-locked, has MP left).
 *   2. `moveDelverStep(state, heroId, x, y, board)` — validates the
 *      target is in `legalStepDestinations`, moves the delver one
 *      tile, decrements `currentMovement` by 1, fires per-tile
 *      pickup, and latches `movementUsedThisTurn = true` ONLY when
 *      MP hits 0 (auto-end of the movement session).
 *   3. `endMovementStep(state, heroId)` — explicit "I'm done moving"
 *      latch. Called by the UI when the player disarms after taking
 *      1+ steps (so they can't re-arm with leftover MP this turn).
 *      Idempotent.
 *   4. `collectTileDrops(state, heroId, x, y)` — single-tile pickup
 *      (used by `moveDelverStep` and exported for any future caller
 *      that lands a delver on a tile via non-movement means).
 *   5. Pure utilities: `chebyshevDistance`, `isAdjacent8`.
 *
 * Step semantics (DESIGN.md §5.1):
 *   - 8-way adjacency. Diagonals cost 1, same as orthogonals.
 *   - Enemy tiles are walls (cannot end on, cannot pass through).
 *   - The OTHER delver's tile is fine (stacking allowed).
 *   - Out-of-bounds is a wall.
 *   - Doubling back is legal — every step is independent and a tile
 *     the delver previously visited this turn is just another
 *     adjacent walkable tile.
 *   - Pickup fires at the END of each step (every tile the delver
 *     lands on), not just the final destination of the movement
 *     session.
 */

import type { CampaignState, TileDrop } from "../state";
import { creditBossPartDrop } from "../state";
import { ADJACENT_OFFSETS_8WAY } from "../rules";
import { getEnemyAt } from "./encounter";
import { collectFriendlyEncountersAt, collectMemoryFragmentsAt } from "./friendlyEncounter";

/** Bounds of the playable grid. (5x5 for Quest #1.) */
export interface BoardBounds {
  w: number;
  h: number;
}

/** A reachable tile and the cost to step onto it (always 1 for
 *  step-by-step movement; the field is kept for symmetry with the
 *  earlier multi-step API and for any future caller that wants to
 *  surface the cost in the UI). */
export interface ReachableTile {
  x: number;
  y: number;
  /** Number of 8-way steps to reach. Always 1 for step-by-step. */
  cost: number;
}

/** True if (ax, ay) is within one tile of (bx, by) via 8-way adjacency. */
export function isAdjacent8(ax: number, ay: number, bx: number, by: number): boolean {
  if (ax === bx && ay === by) return false;
  return Math.abs(ax - bx) <= 1 && Math.abs(ay - by) <= 1;
}

/** Chebyshev (king-move) distance — the lower bound on 8-way path length
 *  in an empty grid. Useful for cheap range checks (e.g. counter-attack
 *  arrows). */
export function chebyshevDistance(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/** Re-export for callers that just want adjacency offsets. */
export { ADJACENT_OFFSETS_8WAY };

// --- Movement step (single-tile, step-by-step) --------------------------

/**
 * The 8-way adjacent walkable tiles the given hero can step onto right
 * now. Always cost-1. Used by the BoardScreen overlay every render.
 *
 * Returns an empty array if any of the following turn-state gates fail
 * (DESIGN.md §4 + §5.7) — UI should treat the result as authoritative:
 *   - no encounter / no loadout / hero off the board,
 *   - `currentMovement <= 0` (no MP left),
 *   - `preparedToRun[heroId]` (Prepared-to-Run delvers can't move),
 *   - `movementUsedThisTurn` (the movement session has been ended,
 *     either auto on MP-exhausted, via `endMovementStep`, or via the
 *     action-gates-REMAINING-movement auto-latch in
 *     `turn.ts > endMovementSessionIfActionInterruptsIt` — called from
 *     `useWeaponAbility` / `useSlotAbility` whenever an action fires
 *     mid-session).
 *
 * Placement gate (2026-05-21): movement is NO LONGER gated on
 * `cardPlacedThisTurn !== null`. The new turn flow allows the player
 * to step before exhausting a card. The Action step (useWeaponAbility
 * / useSlotAbility / Witness move / Boots move-enemy) is STILL gated
 * on a placement having happened — those gates live in their
 * respective action helpers. End Turn surfaces a confirmation modal
 * (UI layer) when movement happened but no card was placed, offering
 * "Undo and submit" (rewind via `undoMovementThisTurn`) or "Go Back".
 *
 * Note: this function intentionally does NOT inspect `actionUsedThisTurn`
 * directly. The "action ends in-progress
 * movement" rule is captured at the moment the action fires (single
 * source of truth: the action helpers) and the result is reflected
 * here via `movementUsedThisTurn`. Two earlier attempts to gate this
 * inside `legalStepDestinations` shipped bugs because the gate didn't
 * have enough information to distinguish "stepped before action"
 * (forfeit remaining) from "stepped after action with fresh MP"
 * (still spendable — see USER REPRO 2026-05-18 part 4 in turn.test.ts:
 * action → AP-double-mov → step → step). The action-helper auto-latch
 * has the temporal context the gate lacks.
 *
 * Per-tile filters:
 *   - out-of-bounds → skipped,
 *   - enemy-occupied → skipped (DESIGN.md §5.1, confirmed 2026-05-02).
 *
 * The OTHER delver's tile is INCLUDED — stacking is allowed.
 */
export function legalStepDestinations(
  state: CampaignState,
  heroId: string,
  board: BoardBounds,
): ReachableTile[] {
  const enc = state.encounter;
  const loadout = state.loadouts[heroId];
  if (!enc || !loadout) return [];
  const start = enc.delverPositions[heroId];
  if (!start) return [];
  if (loadout.currentMovement <= 0) return [];

  if (enc.preparedToRun[heroId]) return [];
  const ts = enc.turnState[heroId];
  if (!ts) return [];
  if (ts.movementUsedThisTurn) return [];

  const out: ReachableTile[] = [];
  for (const off of ADJACENT_OFFSETS_8WAY) {
    const nx = start.x + off.dx;
    const ny = start.y + off.dy;
    if (nx < 0 || ny < 0 || nx >= board.w || ny >= board.h) continue;
    if (getEnemyAt(enc, nx, ny)) continue;
    out.push({ x: nx, y: ny, cost: 1 });
  }
  return out;
}

export type MoveResult =
  | {
      ok: true;
      from: { x: number; y: number };
      to: { x: number; y: number };
      /** MP remaining after the step. When 0, the movement session
       *  has auto-ended (`movementUsedThisTurn` is now `true`). */
      movementRemaining: number;
      /** True iff this step exhausted MP and latched
       *  `movementUsedThisTurn = true`. The UI uses this to decide
       *  whether to drop the armed flag and stop painting the
       *  destination ring. */
      sessionEnded: boolean;
      /**
       * Monster-part drops the moving delver claimed by ending their
       * step on the destination tile. Empty if the tile had no entries
       * matching this hero. Each entry was REMOVED from
       * `state.encounter.tileDrops` AND credited to the corresponding
       * counter (`state.minionParts[heroId]` for `"minion-part"`,
       * `state.bossParts[heroId]` for `"boss-part"` /
       * `"boss-part-lvl-N"`). Pickup fires on EVERY step, not just the
       * final tile of the movement session (DESIGN.md §5.1).
       */
      pickups: TileDrop[];
    }
  | { ok: false; reason: string };

/**
 * Apply a single 8-way step to the hero. Mutates
 * `state.encounter.delverPositions[heroId]`, decrements
 * `currentMovement` by 1, and (when MP hits 0) latches
 * `movementUsedThisTurn = true` so the next render hides the
 * destination ring and the auto-end-turn check can fire.
 *
 * Pickup: every successful step's destination tile is checked for
 * `tileDrops` matching this delver — those drops are claimed and
 * credited (DESIGN.md §3.5 / §5.1). Doubling back over a tile the
 * player previously visited this turn is fine; pickup just yields
 * an empty array for that step (the drops were claimed already).
 *
 * Returns `{ok: false, reason}` (and does NOT mutate) if the
 * destination isn't in `legalStepDestinations`.
 */
export function moveDelverStep(
  state: CampaignState,
  heroId: string,
  toX: number,
  toY: number,
  board: BoardBounds,
): MoveResult {
  const enc = state.encounter;
  const loadout = state.loadouts[heroId];
  if (!enc || !loadout) return { ok: false, reason: "no-encounter-or-hero" };
  const from = enc.delverPositions[heroId];
  if (!from) return { ok: false, reason: "hero-not-on-board" };

  // Single source of truth for "is this step legal" — picks up every
  // gate (prepared-to-run / movement-locked / MP > 0) and every
  // per-tile filter (OOB / enemy-blocker) without duplicating the
  // predicate at the engine boundary. NOTE: placement is no longer
  // a gate (2026-05-21) — movement may precede placement.
  const reachable = legalStepDestinations(state, heroId, board);
  const dest = reachable.find((t) => t.x === toX && t.y === toY);
  if (!dest) return { ok: false, reason: "destination-not-reachable" };

  const ts = enc.turnState[heroId];

  // Capture the movement-undo snapshot on the FIRST step of the turn.
  // Powers the "Undo and submit" path on the End Turn confirmation
  // modal (BoardScreen) — when the player taps End Turn after moving
  // but before placing a weapon, `undoMovementThisTurn` reads this
  // snapshot to rewind position / MP / parts-counter / tileDrops back
  // to the pre-movement baseline. Captured lazily (not in
  // `startHeroTurn`) so non-moving turns don't allocate a snapshot
  // they'd never use.
  if (ts && ts.movementSnapshot === null) {
    ts.movementSnapshot = {
      startPosition: { x: from.x, y: from.y },
      startMovement: loadout.currentMovement,
      startMinionParts: state.minionParts[heroId] ?? 0,
      startBossParts: state.bossParts[heroId] ?? 0,
      startBossPartsLvl2: state.bossPartsLvl2[heroId] ?? 0,
      startBossPartsLvl3: state.bossPartsLvl3[heroId] ?? 0,
      startBossPartsLvl4: state.bossPartsLvl4[heroId] ?? 0,
      startBossPartsLvl5: state.bossPartsLvl5[heroId] ?? 0,
      startAp: loadout.currentAp,
      startCardPlaced: ts.cardPlacedThisTurn ? { ...ts.cardPlacedThisTurn } : null,
      claimedDrops: [],
    };
  }

  enc.delverPositions[heroId] = { x: toX, y: toY };
  loadout.currentMovement -= 1;

  // Bump the per-turn step counter regardless of whether MP is now
  // exhausted. The BoardScreen reads this to decide whether disarming
  // the movement overlay should be a free toggle (0 steps so far) or
  // a session-ending commit via `endMovementStep` (1+ steps). Can't
  // be derived from `currentMovement` alone because AP-double-movement
  // and `+1 mov` slot abilities push the starting MP above
  // `baseMovement`.
  if (ts) ts.movementStepsThisTurn = (ts.movementStepsThisTurn ?? 0) + 1;

  // Latch the movement-used flag ONLY when MP hits 0 (auto-end of the
  // movement session). With MP remaining, the player can keep
  // stepping; `legalStepDestinations` will recompute fresh adjacency
  // from the new position on the next render.
  let sessionEnded = false;
  if (loadout.currentMovement === 0) {
    if (ts) ts.movementUsedThisTurn = true;
    sessionEnded = true;
  }

  const pickups = collectTileDrops(state, heroId, toX, toY);
  if (ts && ts.movementSnapshot && pickups.length > 0) {
    ts.movementSnapshot.claimedDrops.push(...pickups);
  }

  // Memory fragment tokens — mirrors the Witness pickup in
  // `engine/witness.ts > stepWitness`. Drains any fragments on
  // the destination tile and credits them to the campaign wallet.
  const fragmentsBefore = enc.memoryFragments?.length ?? 0;
  collectMemoryFragmentsAt(state, toX, toY);
  if (ts?.movementSnapshot && (enc.memoryFragments?.length ?? 0) < fragmentsBefore) {
    ts.movementSnapshot.revealed = "memory-fragment";
  }

  // Friendly Encounter tokens (Spawn Cards #13, #14). When a
  // delver lands on a tile holding one, the engine drains it
  // and queues a Friendly Encounter card draw onto
  // `state.pendingFriendlyEncounters`. BoardScreen's auto-mount
  // pops it via the FriendlyEncounterModal on the next render.
  // Mirror the Witness pickup wiring in `engine/witness.ts >
  // stepWitness` so behavior stays symmetric across mover types.
  if (collectFriendlyEncountersAt(state, toX, toY).length > 0 && ts?.movementSnapshot) {
    ts.movementSnapshot.revealed = "friendly-encounter";
  }

  return {
    ok: true,
    from: { x: from.x, y: from.y },
    to: { x: toX, y: toY },
    movementRemaining: loadout.currentMovement,
    sessionEnded,
    pickups,
  };
}

/**
 * Why UNDO MOVEMENT is not available right now for `heroId` — or
 * `null` when it is. Undo is allowed any time before End Turn as long
 * as nothing but steps happened since the first step:
 *   - no action taken this turn,
 *   - no AP spent since moving (AP-double movement, AP abilities),
 *   - no card placed since moving (undo the placement first),
 *   - no step revealed a Friendly Encounter or collected a Memory
 *     Fragment (those can't be put back).
 */
export function movementUndoBlockedReason(state: CampaignState, heroId: string): string | null {
  const enc = state.encounter;
  const ts = enc?.turnState[heroId];
  const snap = ts?.movementSnapshot;
  const loadout = state.loadouts[heroId];
  if (!enc || !ts || !snap || !loadout || ts.movementStepsThisTurn === 0) return "You haven't moved this turn.";
  if (snap.startAp === undefined || snap.startCardPlaced === undefined) {
    return "This movement was made on an older version of the game and can't be undone.";
  }
  if (ts.actionUsedThisTurn) return "You've already taken an action after moving.";
  if (snap.revealed === "friendly-encounter") return "Your movement revealed a Friendly Encounter.";
  if (snap.revealed === "memory-fragment") return "Your movement collected a Memory Fragment.";
  if (JSON.stringify(ts.cardPlacedThisTurn) !== JSON.stringify(snap.startCardPlaced)) {
    return "You placed a card after moving. Undo the placement first.";
  }
  if (loadout.currentAp !== snap.startAp) return "You spent AP after moving.";
  return null;
}

/**
 * Rewind THIS turn's movement: restore the delver's position, MP,
 * parts counters, and the encounter's `tileDrops` to the pre-step
 * baseline captured by {@link HeroTurnState.movementSnapshot}.
 *
 * Wired to the End Turn confirmation modal's "Undo and submit"
 * branch (`BoardScreen.ts`): when the player taps End Turn after
 * moving 1+ tiles but BEFORE placing a weapon card, the modal
 * offers either "Undo and submit" (call this, then end the turn)
 * or "Go Back" (close the modal, leave state untouched).
 *
 * Resets:
 *   - `enc.delverPositions[heroId]` → snapshot.startPosition
 *   - `loadout.currentMovement`     → snapshot.startMovement
 *   - `state.minionParts[heroId]`   → snapshot.startMinionParts
 *   - `state.bossParts[heroId]`     → snapshot.startBossParts
 *   - `enc.tileDrops`               ← snapshot.claimedDrops (re-pushed)
 *   - `ts.movementStepsThisTurn`    → 0
 *   - `ts.movementUsedThisTurn`     → false
 *   - `ts.movementSnapshot`         → null (next step recaptures)
 *
 * Idempotent (snapshot=null path is a silent no-op) so callers can
 * safely invoke this without first checking whether the delver
 * actually moved. Returns `true` when a rewind happened, `false`
 * when there was nothing to undo.
 *
 * Intentionally does NOT touch `ts.cardPlacedThisTurn` /
 * `ts.actionUsedThisTurn` — the End Turn modal only fires when no
 * card has been placed (and thus no action could have been taken).
 * If a future caller wants to invoke this mid-turn after a
 * placement, the placement / action latches stay intact by design.
 *
 * Restored tile drops keep their original `heroId` ownership, so a
 * re-step over the same tile will re-pick them up just like the
 * first time.
 */
export function undoMovementThisTurn(
  state: CampaignState,
  heroId: string,
): boolean {
  const enc = state.encounter;
  if (!enc) return false;
  const ts = enc.turnState[heroId];
  if (!ts) return false;
  const snap = ts.movementSnapshot;
  if (!snap) return false;
  const loadout = state.loadouts[heroId];
  if (!loadout) return false;
  const blocked = movementUndoBlockedReason(state, heroId);
  if (blocked) throw new Error(`undoMovementThisTurn: ${blocked}`);

  enc.delverPositions[heroId] = { x: snap.startPosition.x, y: snap.startPosition.y };
  loadout.currentMovement = snap.startMovement;
  state.minionParts[heroId] = snap.startMinionParts;
  state.bossParts[heroId] = snap.startBossParts;
  // Legacy snapshots (pre-v58 in-flight saves) lack the per-level
  // fields — fall back to the live value (no lvl-2/3 pickups could
  // have happened on a pre-v58 build anyway).
  state.bossPartsLvl2[heroId] = snap.startBossPartsLvl2 ?? state.bossPartsLvl2[heroId] ?? 0;
  state.bossPartsLvl3[heroId] = snap.startBossPartsLvl3 ?? state.bossPartsLvl3[heroId] ?? 0;
  state.bossPartsLvl4[heroId] = snap.startBossPartsLvl4 ?? state.bossPartsLvl4[heroId] ?? 0;
  state.bossPartsLvl5[heroId] = snap.startBossPartsLvl5 ?? state.bossPartsLvl5[heroId] ?? 0;
  if (snap.claimedDrops.length > 0) {
    enc.tileDrops.push(...snap.claimedDrops);
  }
  ts.movementStepsThisTurn = 0;
  ts.movementUsedThisTurn = false;
  ts.movementSnapshot = null;
  return true;
}

/**
 * Explicit "I'm done with my movement step" latch. Called by the
 * UI when the player disarms after taking 1+ steps (so the engine
 * knows not to allow re-arming with whatever MP remains).
 *
 * Idempotent: safe to call multiple times, including when the
 * session has already auto-ended via MP-exhaustion in
 * `moveDelverStep`. Returns silently if there's no encounter / no
 * turn-state for this hero (treat-as-no-op).
 *
 * Does NOT touch `currentMovement` — leftover MP is intentionally
 * forfeit by the player's choice to stop. Future
 * "spend-MP-on-something-else" features (e.g. an ability that
 * costs MP) would still see whatever's left, but no further
 * moveDelverStep call will succeed because the gate inside
 * `legalStepDestinations` reads `movementUsedThisTurn`.
 */
export function endMovementStep(state: CampaignState, heroId: string): void {
  const ts = state.encounter?.turnState[heroId];
  if (!ts) return;
  ts.movementUsedThisTurn = true;
}

/**
 * Pick up every `tileDrops` entry on (x, y) owed to `heroId`. Removes
 * matching entries from `state.encounter.tileDrops` and credits the
 * corresponding per-hero counter. Returns the picked-up entries (empty
 * array if none).
 *
 * Exported for tests and for any future caller that needs to fire
 * pickup independently of a movement step (e.g. a teleport-ish
 * ability). The standard movement path is `moveDelverStep`, which
 * calls this internally on every step's destination tile.
 */
export function collectTileDrops(
  state: CampaignState,
  heroId: string,
  x: number,
  y: number,
): TileDrop[] {
  const enc = state.encounter;
  if (!enc) return [];
  const claimed: TileDrop[] = [];
  const remaining: TileDrop[] = [];
  for (const drop of enc.tileDrops) {
    if (drop.x === x && drop.y === y && drop.heroId === heroId) {
      claimed.push(drop);
    } else {
      remaining.push(drop);
    }
  }
  if (claimed.length === 0) return [];
  enc.tileDrops = remaining;
  for (const drop of claimed) {
    if (drop.dropId === "minion-part") {
      state.minionParts[heroId] = (state.minionParts[heroId] ?? 0) + 1;
    } else if (drop.dropId === "boss-part" || drop.dropId.startsWith("boss-part-lvl-")) {
      // Level-aware since v58: lvl-2/3 parts land on their own
      // wallets so lvl-2 shop costs are payable. See
      // `state.ts > creditBossPartDrop`.
      creditBossPartDrop(state, heroId, drop.dropId);
    }
  }
  return claimed;
}
