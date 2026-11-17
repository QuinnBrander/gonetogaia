/**
 * Chapter 4 "Assault on Bird's Nest" enemy abilities (Mistspawn and
 * Infestation).
 *
 * OMEN: "When a hero is damaged by an enemy with this ability,
 * afterwards, place a monster token on their Delversuit board. Each
 * time they take damage from now on, they take 1 extra damage for each
 * monster token they have for the remainder of the Wave. Clear these
 * monster tokens at the end of the Wave."
 *   -> `EncounterState.omenTokens[heroId]`. Every place a delver loses
 *      HP during a wave goes through `damageDelverInWave`. Fully blocked
 *      damage (0 after shields) adds nothing.
 *
 * REBIRTH: "When the enemy dies, place 3 monster tokens on its tile.
 * After each hero turn where no enemies died, remove 1 monster token
 * from all tiles. Once a tile has its last monster token removed,
 * respawn one of these dead enemies on this tile with 50% health."
 *   -> `EncounterState.rebirthTiles`. Kills set
 *      `EncounterState.enemyDiedThisHeroTurn`; `endHeroTurn` calls
 *      `tickRebirthAfterHeroTurn`. Ruling: if the tile is occupied when
 *      its last token goes, the respawn waits (tokens stay at 0) until
 *      the tile is clear after a later hero turn.
 */
import type { CampaignState, EnemyInstance } from "../state";
import type { EnemyCard } from "../types";
import { getEnemy } from "../data";
import { logEvent } from "../debug/sessionLog";
import { recordAbilityProc } from "./abilityProcs";

export const REBIRTH_TOKENS = 3;

export function hasEnemyAbility(card: EnemyCard, kind: "omen" | "rebirth"): boolean {
  return (card.abilities ?? []).some((a) => a.kind === kind);
}

export function omenTokensFor(state: CampaignState, heroId: string): number {
  return state.encounter?.omenTokens?.[heroId] ?? 0;
}

/**
 * Apply `base` damage to a delver during a wave: adds the Omen extra
 * (+1 per token) when any damage lands, then places an Omen token if
 * the source enemy has Omen. Returns the HP actually taken (before the
 * 0 floor), so callers can report the real number.
 */
export function damageDelverInWave(
  state: CampaignState,
  heroId: string,
  base: number,
  source?: EnemyCard,
): number {
  const lo = state.loadouts[heroId];
  if (!lo || base <= 0) return 0;
  const total = base + omenTokensFor(state, heroId);
  lo.currentHp = Math.max(0, lo.currentHp - total);
  const enc = state.encounter;
  if (enc && source && hasEnemyAbility(source, "omen")) {
    enc.omenTokens[heroId] = (enc.omenTokens[heroId] ?? 0) + 1;
    logEvent("engine.omen.token", { heroId, source: source.id, tokens: enc.omenTokens[heroId] });
  }
  return total;
}

/** Called from `applyKill` for every enemy that dies. */
export function onEnemyDiedForRebirth(state: CampaignState, enemy: EnemyInstance): void {
  const enc = state.encounter;
  if (!enc) return;
  enc.enemyDiedThisHeroTurn = true;
  if (!hasEnemyAbility(getEnemy(enemy.cardId), "rebirth")) return;
  const tile = enc.rebirthTiles.find((t) => t.x === enemy.x && t.y === enemy.y);
  if (tile) {
    tile.tokens = REBIRTH_TOKENS;
    tile.deadInstanceIds.push(enemy.instanceId);
  } else {
    enc.rebirthTiles.push({ x: enemy.x, y: enemy.y, tokens: REBIRTH_TOKENS, deadInstanceIds: [enemy.instanceId] });
  }
  recordAbilityProc(enemy, "rebirth");
  logEvent("engine.rebirth.tokens", { instanceId: enemy.instanceId, x: enemy.x, y: enemy.y });
}

function tileOccupied(state: CampaignState, x: number, y: number): boolean {
  const enc = state.encounter!;
  if (enc.enemies.some((e) => e.alive && e.x === x && e.y === y)) return true;
  return Object.values(enc.delverPositions).some((p) => p.x === x && p.y === y);
}

/** After a hero turn: tick every Rebirth tile and respawn where due. */
export function tickRebirthAfterHeroTurn(state: CampaignState): EnemyInstance[] {
  const enc = state.encounter;
  if (!enc) return [];
  const respawned: EnemyInstance[] = [];
  const quiet = !enc.enemyDiedThisHeroTurn;
  enc.enemyDiedThisHeroTurn = false;
  for (const tile of enc.rebirthTiles) {
    if (quiet && tile.tokens > 0) tile.tokens -= 1;
    if (tile.tokens > 0 || tileOccupied(state, tile.x, tile.y)) continue;
    const id = tile.deadInstanceIds.shift()!;
    const enemy = enc.enemies.find((e) => e.instanceId === id)!;
    const card = getEnemy(enemy.cardId);
    enemy.alive = true;
    enemy.x = tile.x;
    enemy.y = tile.y;
    enemy.damageTaken = Math.floor(card.hp / 2);
    respawned.push(enemy);
    recordAbilityProc(enemy, "rebirth");
    logEvent("engine.rebirth.respawn", { instanceId: id, x: tile.x, y: tile.y, damageTaken: enemy.damageTaken });
  }
  enc.rebirthTiles = enc.rebirthTiles.filter((t) => t.deadInstanceIds.length > 0);
  return respawned;
}
