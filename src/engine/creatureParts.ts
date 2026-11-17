/**
 * Gauntlet `collect-creature-part` engine — CREATURE PART pickup
 * pending-pick queue.
 *
 * Printed text (per audit confirmation 2026-05-24, corrected
 * 2026-05-25 to match the rules-as-written):
 *   Body Gauntlet R2-R5 (Chain Gauntlet):
 *     "Collect 1 CREATURE PART from any tile."
 *   Mind Gauntlet R1-R5 (Surge Claw):
 *     "Collect 1 CREATURE PART from any tile." (R1)
 *     "Collect 2 CREATURE PARTS from any tiles."  (R2-R5)
 *
 * Resolution model — corrected 2026-05-25:
 *   - "From any tile" is literal: the player picks an existing
 *     CREATURE PART drop token sitting on the board and claims it
 *     without having to walk onto the tile. It is NOT a free
 *     wallet credit drawn from supply.
 *   - The drop must be owed to the gauntlet bearer (matches the
 *     standard per-delver `tileDrops` ownership model used by
 *     `engine/movement.ts > collectTileDrops`). Each enemy kill
 *     pushes one drop per LIVING delver onto the tile, so the
 *     bearer's drops stack alongside (not on top of) the other
 *     delver's drops.
 *   - The picked drop's printed kind decides which wallet gets
 *     credited:
 *       `minion-part`              → `state.minionParts[heroId] += 1`
 *       `boss-part` / `boss-part-lvl-<N>` → `state.bossParts[heroId] += 1`
 *     The player doesn't choose MINION vs BOSS — that's already
 *     determined by what was actually killed. (Pre-2026-05-25 the
 *     UI prompted MINION/BOSS as if creature parts were granted
 *     from supply, which was wrong.)
 *
 * Per-token vs batch
 *   A `count: N` swing enqueues N independent picks. Each picks
 *   from any tile that has at least 1 eligible drop owed to the
 *   bearer. If between picks no eligible drops remain, the
 *   modal auto-skips the remaining picks (the clause is "from
 *   any tile" — when there ARE no tiles, it does nothing).
 *
 * Pre-2026-05-24 behaviour
 *   `finalizeAttackSession` always granted N MINION PARTs to
 *   `state.minionParts[attackerId]` directly (no tile awareness).
 *   2026-05-24 added a MINION/BOSS supply-pick UI; 2026-05-25
 *   corrected the design to a board-tile picker per the
 *   rules-as-written.
 *
 * UI integration: `screens/ActionResolution.ts >
 * advanceAfterAction` opens the `creature-part-pick` modal while
 * the queue has entries. End Turn / End Wave gates
 * include `hasPendingCreaturePartChoices` alongside the other
 * post-action queues.
 */

import type { CampaignState, PendingCreaturePartChoice, TileDrop } from "../state";
import { creditBossPartDrop } from "../state";

/**
 * Push a single CREATURE PART pick onto the queue. Called once
 * per token granted by a `collect-creature-part` effect — a
 * `count: 2` swing calls this twice.
 *
 * `sourceCardId` is recorded so the modal can surface the
 * weapon's name in its header without reaching back into the
 * (likely already-finalised + cleared) attack session.
 *
 * No-op when no encounter is active (defensive — the only
 * caller is `finalizeAttackSession` which always runs inside an
 * encounter, but harness setups occasionally drive
 * `finalizeAttackSession` against a state with `encounter =
 * null` and we'd rather no-op than crash).
 */
export function enqueueCreaturePartChoice(
  state: CampaignState,
  heroId: string,
  sourceCardId: string,
): void {
  const enc = state.encounter;
  if (!enc) return;
  enc.pendingCreaturePartChoices.push({ heroId, sourceCardId });
}

/**
 * Tiles that carry at least one creature-part drop owed to
 * `heroId`. Used by the modal to:
 *   - paint highlight markers on every legal tile,
 *   - decide whether to auto-skip the head pick (no eligible
 *     tiles → nothing to claim).
 *
 * Multi-drop tiles (e.g. a kill stack from two enemies dying on
 * the same tile across separate swings) appear once per drop —
 * the modal collapses duplicates by `(x, y)` for the highlight
 * pass but still claims a single drop on click.
 *
 * Returns drops in their original `tileDrops` insertion order so
 * tests + the QA harness can pin a deterministic "first
 * available" pick.
 */
export function availableCreaturePartDropsForHero(
  state: CampaignState,
  heroId: string,
): readonly TileDrop[] {
  const enc = state.encounter;
  if (!enc) return [];
  return enc.tileDrops.filter(
    (d) => d.heroId === heroId && isCreaturePartDrop(d.dropId),
  );
}

/**
 * Claim ONE creature-part drop owed to `heroId` from tile
 * (x, y), credit the corresponding wallet, and pop the head of
 * `pendingCreaturePartChoices`. Returns `{ ok: false, reason }` when:
 *   - No encounter is active.
 *   - The queue is empty.
 *   - The head's `heroId` doesn't match the caller's `heroId`
 *     (defensive — the modal always passes the head's heroId,
 *     but we guard against rare race conditions where two clicks
 *     fire for different heroes between renders).
 *   - The named tile has no eligible drop owed to the bearer.
 *
 * Multi-drop tiles claim the FIRST eligible drop (insertion
 * order). Each click consumes one drop + one queue entry — a
 * `count: 2` swing requires two clicks.
 */
export function applyCreaturePartChoice(
  state: CampaignState,
  heroId: string,
  x: number,
  y: number,
): { ok: true; dropId: string } | { ok: false; reason: string } {
  const enc = state.encounter;
  if (!enc) return { ok: false, reason: "no encounter" };
  const head = enc.pendingCreaturePartChoices[0];
  if (!head) return { ok: false, reason: "no pending creature-part picks" };
  if (head.heroId !== heroId) {
    return { ok: false, reason: `head pick is for ${head.heroId}, not ${heroId}` };
  }
  const idx = enc.tileDrops.findIndex(
    (d) => d.x === x && d.y === y && d.heroId === heroId && isCreaturePartDrop(d.dropId),
  );
  if (idx < 0) {
    return {
      ok: false,
      reason: `no creature-part drop owed to ${heroId} at (${x},${y})`,
    };
  }
  const [drop] = enc.tileDrops.splice(idx, 1);
  if (!drop) return { ok: false, reason: "splice returned no drop" };
  if (drop.dropId === "minion-part") {
    state.minionParts[heroId] = (state.minionParts[heroId] ?? 0) + 1;
  } else {
    // Level-aware since v58 — see `state.ts > creditBossPartDrop`.
    creditBossPartDrop(state, heroId, drop.dropId);
  }
  enc.pendingCreaturePartChoices.shift();
  return { ok: true, dropId: drop.dropId };
}

/**
 * Pop the head pick WITHOUT crediting any wallet. Used by the
 * modal when there are no eligible drops on the board (the
 * "from any tile" clause is unfulfillable, so the pick lapses).
 *
 * Returns `{ ok: false, reason }` on the same defensive paths as
 * `applyCreaturePartChoice` (no encounter / empty queue / wrong
 * hero); succeeds with `{ ok: true }` on a clean skip.
 */
export function skipCreaturePartChoice(
  state: CampaignState,
  heroId: string,
): { ok: true } | { ok: false; reason: string } {
  const enc = state.encounter;
  if (!enc) return { ok: false, reason: "no encounter" };
  const head = enc.pendingCreaturePartChoices[0];
  if (!head) return { ok: false, reason: "no pending creature-part picks" };
  if (head.heroId !== heroId) {
    return { ok: false, reason: `head pick is for ${head.heroId}, not ${heroId}` };
  }
  enc.pendingCreaturePartChoices.shift();
  return { ok: true };
}

/**
 * True iff `state.encounter.pendingCreaturePartChoices` has at
 * least one entry. Mirrors `hasPendingElementChoices`. Drives:
 *   - `screens/ActionResolution.advanceAfterAction` (post-action queue)
 *   - End-Turn button gating in `BoardScreen`
 *   - End Wave gate in `WavePhases`
 */
export function hasPendingCreaturePartChoices(state: CampaignState): boolean {
  return (state.encounter?.pendingCreaturePartChoices.length ?? 0) > 0;
}

/**
 * Read-only peek at the head pick (FIFO). Used by the
 * `creature-part-pick` modal renderer to look up which delver is
 * picking and which weapon flavour to surface in the header.
 * Returns `null` when the queue is empty.
 */
export function peekNextPendingCreaturePartChoice(
  state: CampaignState,
): PendingCreaturePartChoice | null {
  const enc = state.encounter;
  if (!enc || enc.pendingCreaturePartChoices.length === 0) return null;
  return enc.pendingCreaturePartChoices[0]!;
}

/**
 * `dropId` taxonomy gate — true for any creature-part subtype
 * (minion or boss-leveled). Mirrors the credit branching in
 * `engine/movement.ts > collectTileDrops` so both pickup paths
 * agree on what counts as a CREATURE PART.
 */
function isCreaturePartDrop(dropId: string): boolean {
  return (
    dropId === "minion-part" ||
    dropId === "boss-part" ||
    dropId.startsWith("boss-part-lvl-")
  );
}
