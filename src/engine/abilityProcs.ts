/**
 * Enemy ability "procs": every time an enemy ability changes what would
 * normally happen (Tough reduces damage, Rotates turns the enemy, Countdown
 * pulls in a counterattack, ...), the engine records it here so the board
 * can float the ability's name over that enemy's tile.
 *
 * In-memory only (not part of the save): a proc is a moment of feedback,
 * not game state. The board drains the queue each render (see
 * `uiState.ts > collectAbilityProcFx`).
 */
import type { EnemyAbility } from "../types";

export type AbilityProcKind = EnemyAbility["kind"];

export interface AbilityProc {
  instanceId: string;
  kind: AbilityProcKind;
  /** Tile the label is drawn on (where the enemy was when it fired). */
  x: number;
  y: number;
}

const MAX_QUEUED = 50;
let queue: AbilityProc[] = [];

/** Record that `enemy`'s `kind` ability just took effect. */
export function recordAbilityProc(
  enemy: { instanceId: string; x: number; y: number },
  kind: AbilityProcKind,
): void {
  queue.push({ instanceId: enemy.instanceId, kind, x: enemy.x, y: enemy.y });
  // Nothing drains the queue when no board is on screen (tests, the Quick
  // Start simulation); keep only the latest procs.
  if (queue.length > MAX_QUEUED) queue.splice(0, queue.length - MAX_QUEUED);
}

/** Return and clear every proc recorded since the last drain. */
export function drainAbilityProcs(): AbilityProc[] {
  const out = queue;
  queue = [];
  return out;
}
