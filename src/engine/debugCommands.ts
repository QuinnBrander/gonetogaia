/**
 * Debug commands — single-keypress shortcuts for jam-time iteration.
 *
 * These bypass the normal Hero / Parting Shots / End Wave pacing in
 * the smallest, most surgically-correct way possible:
 *   - Run the same `applyKill` the regular kill path uses (so XP,
 *     elements, level-up cards, and per-delver tile-drop tokens all
 *     get credited the same way they would on a real win).
 *   - Auto-pick-up every drop sitting on the board (the "you walked
 *     onto the tile" half of the normal flow).
 *   - Resolve any pending XP → level-ups so the LevelUpModal pops
 *     mid-flow exactly as it would after a real wipe.
 *   - Transition `enc.phase` straight to `parting-shots` with a
 *     fresh cursor; the existing UI then auto-advances to End Wave
 *     because no enemy is alive (see `nextPartingShotEnemy`).
 *
 * What this DOES NOT do:
 *   - Heal delvers / restore AP / refresh tokens. That's the
 *     End Wave's job and we want the player to see the natural
 *     summary panel.
 *   - Touch downed-delver state. If a delver was already dead
 *     before W was pressed, they stay dead and the End-of-Wave
 *     branch will route to the defeat narrative — which is the
 *     correct outcome (you can't "skip-to-win" through a wipe).
 *   - Suppress pending modals (level-up draws, element choices,
 *     equipment rolls). The player resolves them naturally; this
 *     keeps the debug fast-forward consistent with normal flow.
 */

import type { CampaignState, EncounterState } from "../state";
import { creditBossPartDrop } from "../state";
import { applyKill, applyPendingLevelUps } from "./kills";
import { getEnemy } from "../data";
import { logEvent } from "../debug/sessionLog";
import { onDelverDamaged } from "./wave";

export interface DebugWinWaveResult {
  enemiesSlain: number;
  minionPartsCollected: Record<string, number>;
  bossPartsCollected: Record<string, number>;
  levelUpsTriggered: number;
  phaseFrom: EncounterState["phase"];
  phaseTo: EncounterState["phase"];
}

/**
 * "I win" debug command. Slays every alive enemy in the live encounter
 * (firing each enemy's normal `applyKill` so XP, elements, level-up
 * cards, and per-delver tile drops all flow through the regular path),
 * then auto-collects every tile drop sitting on the board and routes
 * the encounter into the Parting Shots phase. The Parting Shots screen
 * sees no living enemies and continues to End Wave on first
 * "Continue" tap; End Wave → Town Visit follows the
 * normal route from there.
 *
 * Returns `null` if there's no encounter, or if the encounter is past
 * the Hero Phase (parting-shots / end-of-wave / completed)
 * — those phases have already moved past the point where "win the
 * wave" is meaningful.
 *
 * Returns a result summary on success; safe to ignore if the caller
 * just wants the side-effects.
 */
export function debugWinWave(state: CampaignState): DebugWinWaveResult | null {
  const enc = state.encounter;
  if (!enc) return null;
  if (enc.phase !== "hero") return null;

  const phaseFrom = enc.phase;
  let enemiesSlain = 0;

  // 1. Apply on-death effects for every alive enemy. `applyKill`
  // pushes per-delver TileDrops (one per drop × living delver) onto
  // `enc.tileDrops`, credits XP to `state.xpOnHand` / `totalXp`,
  // attempts each on-death element grant against the per-element
  // cap-2, and bumps `state.levelUpCardsOwed`. We don't sum dropped
  // counts here — the auto-collect pass below will tally them as
  // it credits the per-delver `minionParts` / `bossParts` bags.
  for (const enemy of enc.enemies) {
    if (!enemy.alive) continue;
    if (enemy.linkedTo) { enemy.alive = false; continue; }
    const card = getEnemy(enemy.cardId);
    applyKill(state, card, { x: enemy.x, y: enemy.y });
    enemy.alive = false;
    enemiesSlain += 1;
  }

  // 2. Auto-pickup every tile drop. Mirrors the credit logic in
  // `engine/movement.ts > collectTileDrops` but for ALL drops
  // regardless of delver position (the "you walked onto every
  // tile" debug shortcut). Any drop pre-existing from earlier
  // turns also gets cleaned up here, which is the right thing for
  // a "skip to end of wave" command.
  const minionPartsCollected: Record<string, number> = {};
  const bossPartsCollected: Record<string, number> = {};
  for (const drop of enc.tileDrops) {
    if (drop.dropId === "minion-part") {
      state.minionParts[drop.heroId] = (state.minionParts[drop.heroId] ?? 0) + 1;
      minionPartsCollected[drop.heroId] = (minionPartsCollected[drop.heroId] ?? 0) + 1;
    } else if (
      drop.dropId === "boss-part" ||
      drop.dropId.startsWith("boss-part-lvl-")
    ) {
      // Level-aware since v58 — see `state.ts > creditBossPartDrop`.
      creditBossPartDrop(state, drop.heroId, drop.dropId);
      bossPartsCollected[drop.heroId] = (bossPartsCollected[drop.heroId] ?? 0) + 1;
    }
    // Anything else (future drop kinds we haven't taught the
    // pickup pass about) gets silently dropped on the floor — the
    // debug command is not the place to invent semantics for an
    // unknown drop ID.
  }
  enc.tileDrops = [];

  // 3. Convert any newly-credited XP into levels (which queues
  // LevelUpModal draws). This is what `endHeroTurn` does after a
  // real kill batch — keeping the same call here means the
  // "fast-forward" landing state is identical to the natural one.
  const levelUpsTriggered = applyPendingLevelUps(state);

  // 4. Phase transition. Parting Shots with no alive enemies will
  // auto-advance to End Wave on the first Continue tap (see
  // `screens/WavePhases.ts > renderPartingShotsBody` no-enemy
  // branch). We deliberately don't jump straight to End Wave
  // because the Parting Shots screen renders the "no surviving
  // enemies to act" beat which makes the W-command's effect
  // visually obvious to the player.
  enc.phase = "parting-shots";
  enc.partingShotCursor = 0;

  logEvent("debug.win-wave", {
    enemiesSlain,
    minionPartsCollected,
    bossPartsCollected,
    levelUpsTriggered,
    phaseFrom,
    phaseTo: enc.phase,
  });

  return {
    enemiesSlain,
    minionPartsCollected,
    bossPartsCollected,
    levelUpsTriggered,
    phaseFrom,
    phaseTo: enc.phase,
  };
}

// --- W / L debug keys -------------------------------------------------------
//
// Bound to the BoardScreen keydown listener. Rules (user calls 2026-11-15):
//   - Only enemies still ALIVE count (already-dead ones left their drops
//     on the board; those are picked up in full on W).
//   - Minion parts: each living delver gets floor(N / 2), where N is the
//     number of `minion-part` drops that delver would have been owed.
//   - W also credits every boss part (pelt) plus XP / elements / Level Up
//     cards exactly as the real kills would (same `applyKill` path).
//   - L knocks ONLY the active delver to 0 HP (one hero card at stake on
//     non-exempt waves) and follows the normal defeat route.
// Both throw outside the Hero Phase — the key handler surfaces the error.

export interface DebugKeyWaveResult {
  /** Minion parts credited per delver by this command. */
  minionPartsCollected: Record<string, number>;
  /** Boss parts credited per delver by this command (W only). */
  bossPartsCollected: Record<string, number>;
}

function requireHeroPhase(state: CampaignState, cmd: string): EncounterState {
  const enc = state.encounter;
  if (!enc) throw new Error(`${cmd}: no wave in progress (no encounter)`);
  if (enc.phase !== "hero") {
    throw new Error(`${cmd}: only works during the Hero Phase (current phase: "${enc.phase}")`);
  }
  return enc;
}

function isBossPartDrop(dropId: string): boolean {
  return dropId === "boss-part" || dropId.startsWith("boss-part-lvl-");
}

function creditMinionParts(state: CampaignState, heroId: string, n: number, into: Record<string, number>): void {
  if (n <= 0) return;
  state.minionParts[heroId] = (state.minionParts[heroId] ?? 0) + n;
  into[heroId] = (into[heroId] ?? 0) + n;
}

/** W key: win the current wave with half minion parts + all boss parts. */
export function debugKeyWinWave(state: CampaignState): DebugKeyWaveResult {
  const enc = requireHeroPhase(state, "debugKeyWinWave");
  const minionPartsCollected: Record<string, number> = {};
  const bossPartsCollected: Record<string, number> = {};

  // 1. Drops already on the board were fairly earned — collect in full.
  for (const drop of enc.tileDrops) {
    if (drop.dropId === "minion-part") {
      creditMinionParts(state, drop.heroId, 1, minionPartsCollected);
    } else if (isBossPartDrop(drop.dropId)) {
      creditBossPartDrop(state, drop.heroId, drop.dropId);
      bossPartsCollected[drop.heroId] = (bossPartsCollected[drop.heroId] ?? 0) + 1;
    } else {
      throw new Error(`debugKeyWinWave: unknown tile drop "${drop.dropId}"`);
    }
  }
  enc.tileDrops = [];

  // 2. Kill every living enemy through the real kill path (XP, XP dice,
  // elements, Level Up cards, boss-slain quest entries, tile drops).
  let enemiesSlain = 0;
  for (const enemy of enc.enemies) {
    if (!enemy.alive) continue;
    if (enemy.linkedTo) { enemy.alive = false; continue; }
    applyKill(state, getEnemy(enemy.cardId), { x: enemy.x, y: enemy.y });
    enemy.alive = false;
    enemiesSlain += 1;
  }

  // 3. Collect the fresh drops: all boss parts, half the minion parts.
  const owedMinion: Record<string, number> = {};
  for (const drop of enc.tileDrops) {
    if (drop.dropId === "minion-part") {
      owedMinion[drop.heroId] = (owedMinion[drop.heroId] ?? 0) + 1;
    } else if (isBossPartDrop(drop.dropId)) {
      creditBossPartDrop(state, drop.heroId, drop.dropId);
      bossPartsCollected[drop.heroId] = (bossPartsCollected[drop.heroId] ?? 0) + 1;
    } else {
      throw new Error(`debugKeyWinWave: unknown tile drop "${drop.dropId}"`);
    }
  }
  enc.tileDrops = [];
  for (const [heroId, n] of Object.entries(owedMinion)) {
    creditMinionParts(state, heroId, Math.floor(n / 2), minionPartsCollected);
  }

  // 4. XP → levels, then the normal post-wipe route (Parting Shots with
  // no survivors → End Wave victory → next wave / quest end).
  const levelUpsTriggered = applyPendingLevelUps(state);
  enc.phase = "parting-shots";
  enc.partingShotCursor = 0;

  logEvent("debug.key-win-wave", { enemiesSlain, minionPartsCollected, bossPartsCollected, levelUpsTriggered });
  return { minionPartsCollected, bossPartsCollected };
}

/** L key: lose the current wave with half minion parts for each delver. */
export function debugKeyLoseWave(state: CampaignState): DebugKeyWaveResult {
  const enc = requireHeroPhase(state, "debugKeyLoseWave");

  // Minion parts the living enemies WOULD drop (per living delver, the
  // same fan-out `applyKill` uses), halved and rounded down.
  let minionDrops = 0;
  for (const enemy of enc.enemies) {
    if (!enemy.alive || enemy.linkedTo) continue;
    for (const dropId of getEnemy(enemy.cardId).onDeath.drops ?? []) {
      if (dropId === "minion-part") minionDrops += 1;
    }
  }
  const minionPartsCollected: Record<string, number> = {};
  for (const heroId of Object.keys(state.loadouts)) {
    if (state.loadouts[heroId]!.currentHp <= 0) continue;
    creditMinionParts(state, heroId, Math.floor(minionDrops / 2), minionPartsCollected);
  }

  // Only the active delver falls → at most one hero card is lost.
  const fallen = state.currentDelverId;
  const lo = state.loadouts[fallen];
  if (!lo) throw new Error(`debugKeyLoseWave: active delver "${fallen}" has no loadout`);
  lo.currentHp = 0;
  if (!onDelverDamaged(state)) {
    throw new Error("debugKeyLoseWave: defeat route did not trigger");
  }

  logEvent("debug.key-lose-wave", { fallen, minionPartsCollected });
  return { minionPartsCollected, bossPartsCollected: {} };
}
