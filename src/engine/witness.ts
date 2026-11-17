/**
 * Witness companion Action (Witness Reference Card v2 PROOF 1):
 *
 *   "Gain the Witness miniature. During Wave Setup, place Witness on
 *    the same tile as one or both Delvers. Players gain the following
 *    Action during their turn:
 *      Move Witness up to 2 tiles, collecting any Minion Parts on
 *      those tiles. Players must still place a Weapon Card into an
 *      available Weapon Slot to take this Action."
 *
 * Wired into the existing per-turn Action model (DESIGN.md §5.2):
 *   - Placement (mandatory turn-start) is gated by `cardPlacedThisTurn`
 *     — unchanged. The Witness Action just consumes the SAME single
 *     per-turn Action slot as the weapon-ability / slot-ability path.
 *   - First successful step latches `actionUsedThisTurn = true`. Step 2
 *     (if taken) bypasses the action-used gate by reading
 *     `witnessStepsThisTurn` directly — both steps form ONE Action.
 *   - First step also calls `endMovementSessionIfActionInterruptsIt`
 *     (DESIGN.md §5.1 — an action mid-movement-session forfeits
 *     remaining MP). Subsequent steps don't re-fire that latch (the
 *     session has either already ended or already been forfeit).
 *
 * Pickup semantics (extended per user request 2026-05-19):
 *   - Minion-part / boss-part drops at the destination tile are
 *     collected REGARDLESS of which delver owned the drop (rulebook
 *     says "Minion Parts"; we generalise to all tile drops because
 *     Witness "haul your gear for you" canonically covers both delvers
 *     — quest2.json page2_4 explicitly shows him collecting items for
 *     downed delvers). Each drop credits its OWN heroId's wallet
 *     (`state.minionParts[ownerHeroId] += 1` etc.) rather than the
 *     mover's wallet — Witness is a courier, not a thief.
 *   - Memory Fragment tokens at the destination tile are claimed and
 *     credit `state.memoryChips` (the shared chip counter). Memory
 *     Fragments are un-owned so there's no per-delver routing.
 *
 * NOT implemented here (intentionally):
 *   - The "If you fall in the mist he'll bring your bodies home"
 *     death-recovery flow — that's narrative-only today (quest2.json
 *     page2_4) and would be a separate engine path.
 *   - Pre-Wave-Setup placement (covered by `assignWitnessToTile` in
 *     `engine/encounter.ts`).
 *
 * Public API consumers:
 *   - `screens/ActionResolution.ts` (action-menu "Move Witness" button).
 *   - `screens/BoardScreen.ts` (destination overlay during the
 *     `"witness-move"` modal — paints tiles returned by
 *     `legalWitnessStepDestinations`, calls `stepWitness` on tap).
 */

import type { CampaignState, HeroTurnState } from "../state";
import { creditBossPartDrop } from "../state";
import type { BoardBounds, ReachableTile } from "./movement";
import { ADJACENT_OFFSETS_8WAY } from "../rules";
import { getEnemyAt } from "./encounter";
import { collectFriendlyEncountersAt, collectMemoryFragmentsAt } from "./friendlyEncounter";
import { endMovementSessionIfActionInterruptsIt } from "./turn";
import { logEvent } from "../debug/sessionLog";

/**
 * Hard cap on Witness movement steps per Action. Printed on the
 * Witness Reference Card ("Move Witness up to 2 tiles"). Exported
 * so the UI can show "0 / 2", "1 / 2", "2 / 2" without hard-coding
 * the number.
 */
export const WITNESS_ACTION_STEP_CAP = 2;

/**
 * The 8-way adjacent walkable tiles Witness can step onto right now.
 * Always cost-1. Same per-tile filters as delver movement
 * (`engine/movement.ts > legalStepDestinations`): out-of-bounds and
 * enemy-occupied tiles are skipped. Delver tiles are INCLUDED —
 * Witness can share a tile with either or both delvers (rulebook:
 * "place Witness on the same tile as one or both Delvers").
 *
 * Returns an empty array if:
 *   - the encounter doesn't carry a Witness (`witnessPosition` null,
 *     i.e. Q1 / non-Q2+),
 *   - the witness step cap has been hit this turn (no more steps
 *     available for the current Action),
 *   - there's no live encounter / board.
 *
 * Note: this does NOT inspect `cardPlacedThisTurn` or
 * `actionUsedThisTurn` — those gates fire INSIDE `stepWitness` because
 * the legal-destinations layer is also used by the action-menu
 * preview ("which tiles would Witness be able to reach if I picked
 * Move Witness right now?"). The preview is meaningful even before
 * the first step latches `actionUsedThisTurn`, and the engine still
 * enforces the gate on the actual step call.
 */
export function legalWitnessStepDestinations(
  state: CampaignState,
  board: BoardBounds,
): ReachableTile[] {
  const enc = state.encounter;
  if (!enc || enc.witnessPosition == null) return [];
  const heroId = state.currentDelverId;
  const ts = enc.turnState[heroId];
  if (!ts) return [];
  if ((ts.witnessStepsThisTurn ?? 0) >= WITNESS_ACTION_STEP_CAP) return [];

  const start = enc.witnessPosition;
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

/**
 * What `stepWitness` will/did pick up at a given tile. Returned by
 * `stepWitness` on success and used by `getWitnessPickupsAt` for
 * pre-step preview / tooltip rendering. Empty fields mean nothing
 * of that kind was on the tile.
 */
export interface WitnessStepPickups {
  /** Per-owner-heroId count of minion-part drops claimed at this
   *  tile. Sparse — only keys with > 0 are present. Each credit
   *  lands on `state.minionParts[ownerHeroId]`. */
  minionParts: Record<string, number>;
  /** Per-owner-heroId count of boss-part drops claimed at this tile
   *  (any `boss-part*` dropId variant — see
   *  `engine/movement.ts > collectTileDrops` for the full match
   *  pattern). Sparse. */
  bossParts: Record<string, number>;
  /** Memory Fragment tokens claimed at this tile — always 0 or 1
   *  in practice (Spawn Cards print at most 1 fragment per tile),
   *  but typed as a count for forward-compat. Each credit lands on
   *  `state.memoryChips`. */
  memoryFragments: number;
}

/** True iff `pickups` claimed at least one thing. Centralised so the
 *  modal / log don't each re-derive the "did Witness collect anything
 *  this step?" predicate. */
export function witnessPickupsHasAny(p: WitnessStepPickups): boolean {
  if (p.memoryFragments > 0) return true;
  for (const k of Object.keys(p.minionParts)) if (p.minionParts[k]! > 0) return true;
  for (const k of Object.keys(p.bossParts)) if (p.bossParts[k]! > 0) return true;
  return false;
}

/**
 * Snapshot of what Witness WOULD pick up at (x, y) without mutating
 * anything. Used by the BoardScreen overlay to colour-flag tiles that
 * carry a drop / memory fragment, and by the action-menu tooltip to
 * preview "tap to grab a creature part" vs "tap to step onto empty
 * tile". Does NOT inspect the action-step gate — pure tile scan.
 */
export function getWitnessPickupsAt(
  state: CampaignState,
  x: number,
  y: number,
): WitnessStepPickups {
  const enc = state.encounter;
  const out: WitnessStepPickups = {
    minionParts: {},
    bossParts: {},
    memoryFragments: 0,
  };
  if (!enc) return out;
  for (const drop of enc.tileDrops) {
    if (drop.x !== x || drop.y !== y) continue;
    if (drop.dropId === "minion-part") {
      out.minionParts[drop.heroId] = (out.minionParts[drop.heroId] ?? 0) + 1;
    } else if (drop.dropId === "boss-part" || drop.dropId.startsWith("boss-part-lvl-")) {
      out.bossParts[drop.heroId] = (out.bossParts[drop.heroId] ?? 0) + 1;
    }
  }
  for (const mf of enc.memoryFragments) {
    if (mf.x === x && mf.y === y) out.memoryFragments += 1;
  }
  return out;
}

/** Result of a {@link stepWitness} call. */
export type WitnessStepResult =
  | {
      ok: true;
      from: { x: number; y: number };
      to: { x: number; y: number };
      /** Steps used (1..WITNESS_ACTION_STEP_CAP) after this step. */
      stepsUsed: number;
      /** Steps remaining for the current Action (cap - stepsUsed). */
      stepsRemaining: number;
      /** True iff this step latched `actionUsedThisTurn = true`
       * (i.e. it was the FIRST step of the action). Step 2 keeps the
       * flag set without re-latching. */
      latchedAction: boolean;
      /** Pickups claimed at the destination tile. Each `minionParts` /
       * `bossParts` credit was applied to its OWN heroId's wallet,
       * NOT the mover's. Memory fragments credit `state.memoryChips`. */
      pickups: WitnessStepPickups;
    }
  | { ok: false; reason: string };

/**
 * Move Witness one 8-way step to (toX, toY) and claim every pickup
 * on the destination tile (minion-part / boss-part drops for either
 * delver + Memory Fragment tokens). Mutates `encounter.witnessPosition`,
 * `encounter.tileDrops`, `encounter.memoryFragments`,
 * `state.minionParts[ownerHeroId]`, `state.bossParts[ownerHeroId]`,
 * and `state.memoryChips`.
 *
 * Gates (return `{ok: false, reason}` and DO NOT mutate):
 *   - encounter has no Witness (Q1 / non-Q2+),
 *   - no `cardPlacedThisTurn` (a Weapon Card must be placed first
 *     per the printed card text),
 *   - `actionUsedThisTurn` AND this would be the FIRST step (the
 *     player already used their per-turn Action on something else),
 *   - `witnessStepsThisTurn` already at the cap (can't take a 3rd
 *     step within the same Action),
 *   - destination not in `legalWitnessStepDestinations` (OOB,
 *     enemy-occupied, or not 8-way-adjacent to Witness).
 *
 * Pickup is fired AT the destination tile only — `Move Witness up
 * to 2 tiles, collecting any Minion Parts on those tiles` reads
 * "tiles he occupies after stepping". Witness's starting tile is
 * not re-scanned (drops there were presumably claimed when a delver
 * passed through earlier, or will be claimed by a delver later).
 */
export function stepWitness(
  state: CampaignState,
  heroId: string,
  toX: number,
  toY: number,
  board: BoardBounds,
): WitnessStepResult {
  const enc = state.encounter;
  if (!enc) return { ok: false, reason: "no-encounter" };
  if (enc.witnessPosition == null) return { ok: false, reason: "no-witness-on-board" };
  const ts = enc.turnState[heroId];
  if (!ts) return { ok: false, reason: "no-turn-state-for-delver" };
  if (ts.cardPlacedThisTurn === null) return { ok: false, reason: "no-card-placed-this-turn" };
  const stepsUsedBefore = ts.witnessStepsThisTurn ?? 0;
  if (stepsUsedBefore >= WITNESS_ACTION_STEP_CAP) {
    return { ok: false, reason: "witness-step-cap-reached" };
  }
  // First step is gated by the normal action-used check — the printed
  // card consumes the player's single per-turn Action. Subsequent
  // steps bypass the check by reading `witnessStepsThisTurn` instead
  // (the action latch is already set from step 1; both steps belong
  // to the same Action).
  if (stepsUsedBefore === 0 && ts.actionUsedThisTurn) {
    return { ok: false, reason: "action-already-used-this-turn" };
  }
  // Destination must be 8-way-adjacent + OOB-safe + enemy-free. Reuse
  // `legalWitnessStepDestinations` so the single source of truth for
  // "where can Witness step" lives in one place.
  const reachable = legalWitnessStepDestinations(state, board);
  const dest = reachable.find((t) => t.x === toX && t.y === toY);
  if (!dest) return { ok: false, reason: "destination-not-reachable" };

  const from = { x: enc.witnessPosition.x, y: enc.witnessPosition.y };
  enc.witnessPosition = { x: toX, y: toY };
  ts.witnessStepsThisTurn = stepsUsedBefore + 1;

  // Drain the destination tile's pickups. Per-owner crediting keeps
  // each drop on the wallet of the delver who's owed it (matches
  // `engine/movement.ts > collectTileDrops` ownership semantics).
  const pickups: WitnessStepPickups = { minionParts: {}, bossParts: {}, memoryFragments: 0 };
  const remainingDrops: typeof enc.tileDrops = [];
  for (const drop of enc.tileDrops) {
    if (drop.x === toX && drop.y === toY) {
      if (drop.dropId === "minion-part") {
        state.minionParts[drop.heroId] = (state.minionParts[drop.heroId] ?? 0) + 1;
        pickups.minionParts[drop.heroId] = (pickups.minionParts[drop.heroId] ?? 0) + 1;
        continue;
      }
      if (drop.dropId === "boss-part" || drop.dropId.startsWith("boss-part-lvl-")) {
        // Level-aware since v58 — see `state.ts > creditBossPartDrop`.
        // `pickups.bossParts` stays a flat per-hero count (display only).
        creditBossPartDrop(state, drop.heroId, drop.dropId);
        pickups.bossParts[drop.heroId] = (pickups.bossParts[drop.heroId] ?? 0) + 1;
        continue;
      }
    }
    remainingDrops.push(drop);
  }
  enc.tileDrops = remainingDrops;

  pickups.memoryFragments += collectMemoryFragmentsAt(state, toX, toY);

  // Friendly Encounter tokens (Spawn Cards #13, #14). Witness
  // can pick them up just like a delver -- the modal then opens
  // automatically via BoardScreen's auto-mount on the next render.
  collectFriendlyEncountersAt(state, toX, toY);

  // First step latches the per-turn action. Step 2 doesn't re-latch
  // (it's already true) and doesn't re-fire the movement-session
  // forfeit (the first step already did that — or it was a no-op
  // because no session was in progress).
  let latchedAction = false;
  if (stepsUsedBefore === 0) {
    ts.actionUsedThisTurn = true;
    endMovementSessionIfActionInterruptsIt(ts);
    latchedAction = true;
  }

  const stepsRemaining = WITNESS_ACTION_STEP_CAP - ts.witnessStepsThisTurn;

  logEvent("engine.stepWitness", {
    heroId,
    from,
    to: { x: toX, y: toY },
    stepsUsed: ts.witnessStepsThisTurn,
    stepsRemaining,
    latchedAction,
    pickedUpMinionParts: sumValues(pickups.minionParts),
    pickedUpBossParts: sumValues(pickups.bossParts),
    pickedUpMemoryFragments: pickups.memoryFragments,
  });

  return {
    ok: true,
    from,
    to: { x: toX, y: toY },
    stepsUsed: ts.witnessStepsThisTurn,
    stepsRemaining,
    latchedAction,
    pickups,
  };
}

/** True iff the current delver can ENTER the "Move Witness" Action
 * right now (i.e. the action-menu button should be enabled). Mirrors
 * the gates inside `stepWitness` BEFORE the destination check. */
export function canBeginWitnessAction(state: CampaignState): boolean {
  const enc = state.encounter;
  if (!enc || enc.witnessPosition == null) return false;
  const ts = enc.turnState[state.currentDelverId];
  if (!ts) return false;
  if (ts.cardPlacedThisTurn === null) return false;
  if (ts.actionUsedThisTurn) {
    // Special case: the player already TOOK a Witness step this turn
    // (the action latch is set, but witnessStepsThisTurn > 0 — they
    // still have 1 step left in the cap). Re-entering the modal to
    // take step 2 must remain legal.
    if ((ts.witnessStepsThisTurn ?? 0) > 0
      && (ts.witnessStepsThisTurn ?? 0) < WITNESS_ACTION_STEP_CAP) {
      return true;
    }
    return false;
  }
  return true;
}

/** Tiny helper to sum a sparse Record<string, number>. Kept local
 *  rather than importing a util shim so the engine module stays
 *  cheap to read end-to-end. */
function sumValues(rec: Record<string, number>): number {
  let total = 0;
  for (const v of Object.values(rec)) total += v;
  return total;
}

/** Re-export so callers don't need a deep import of `HeroTurnState`
 *  just to type a `ts.witnessStepsThisTurn` accessor. */
export type { HeroTurnState };
