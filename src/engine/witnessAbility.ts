/**
 * Memory Fragment Witness ability (card backs #2-#10, Game Materials
 * workbook): "Once per quest free action: Witness deals N damage to
 * adjacent enemies OR heals M HP to adjacent delvers." Each later fragment
 * improves it, so the highest fragment the party has drawn sets N / M.
 *
 * Prototype rulings (confirm with the designer):
 *   - Witness's damage isn't a delver attack: no counterattack, and it
 *     ignores attack modifiers (Evasive, Immunity, Guards, Shell...).
 *     Fatal Flaw still applies (it governs kill order). Kills give their
 *     normal rewards.
 *   - "Adjacent" = the 8 tiles around Witness; for healing, delvers on
 *     Witness's own tile count too.
 *   - "Once per quest": `state.witnessAbilityUsed`, cleared when a quest
 *     starts (Wave 1 is built) and when it ends.
 */
import type { CampaignState } from "../state";
import { getEnemy } from "../data";
import { clampDamageForFatalFlaw } from "./encounter";
import { applyKill, applyPendingLevelUps } from "./kills";
import { onEnemyDiedForRebirth } from "./omenRebirth";
import { logEvent } from "../debug/sessionLog";

/** Card back of each fragment: [damage, heal]. #1 has no ability. */
const FRAGMENT_ABILITY: Record<number, { damage: number; heal: number }> = {
  2: { damage: 2, heal: 0 },
  3: { damage: 2, heal: 1 },
  4: { damage: 2, heal: 1 },
  5: { damage: 4, heal: 2 },
  6: { damage: 4, heal: 2 },
  7: { damage: 6, heal: 3 },
  8: { damage: 8, heal: 4 },
  9: { damage: 10, heal: 5 },
  10: { damage: 10, heal: 5 },
};

/** The party's Witness ability (best fragment drawn), or null before #2. */
export function witnessAbility(state: CampaignState): { fragment: number; damage: number; heal: number } | null {
  const best = Math.max(0, ...state.memoryCards.filter((n) => FRAGMENT_ABILITY[n]));
  return best ? { fragment: best, ...FRAGMENT_ABILITY[best]! } : null;
}

export type WitnessAbilityMode = "damage" | "heal";

/** Why the ability can't be used right now, or null if it can. */
export function witnessAbilityBlocker(state: CampaignState, mode: WitnessAbilityMode): string | null {
  const ability = witnessAbility(state);
  if (!ability) return "no Memory Fragment with a Witness ability";
  if (mode === "heal" && ability.heal <= 0) return "this fragment's ability can't heal";
  const enc = state.encounter;
  if (!enc || enc.phase !== "hero") return "only during the Delver Phase";
  if (!enc.witnessPosition) return "Witness isn't on the board";
  if (state.witnessAbilityUsed) return "already used this quest";
  return null;
}

function adjacent(a: { x: number; y: number }, b: { x: number; y: number }, includeSame: boolean): boolean {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  if (dx === 0 && dy === 0) return includeSame;
  return dx <= 1 && dy <= 1;
}

export interface WitnessAbilityResult {
  mode: WitnessAbilityMode;
  amount: number;
  hit: { instanceId: string; damage: number; killed: boolean }[];
  healed: { heroId: string; amount: number }[];
}

export function useWitnessAbility(state: CampaignState, mode: WitnessAbilityMode): WitnessAbilityResult {
  const blocker = witnessAbilityBlocker(state, mode);
  if (blocker) throw new Error(`useWitnessAbility: ${blocker}`);
  const ability = witnessAbility(state)!;
  const enc = state.encounter!;
  const at = enc.witnessPosition!;
  const result: WitnessAbilityResult = { mode, amount: mode === "damage" ? ability.damage : ability.heal, hit: [], healed: [] };
  state.witnessAbilityUsed = true;

  if (mode === "heal") {
    for (const [heroId, pos] of Object.entries(enc.delverPositions)) {
      const lo = state.loadouts[heroId];
      if (!lo || !adjacent(pos, at, true)) continue;
      const before = lo.currentHp;
      lo.currentHp = Math.min(lo.maxHp, lo.currentHp + ability.heal);
      result.healed.push({ heroId, amount: lo.currentHp - before });
    }
  } else {
    // A 2-card boss takes the hit once, on its 1/2 card.
    const targets = new Map<string, (typeof enc.enemies)[number]>();
    for (const e of enc.enemies) {
      if (!e.alive || !adjacent(e, at, false)) continue;
      const boss = e.linkedTo ? enc.enemies.find((x) => x.instanceId === e.linkedTo) : e;
      if (boss?.alive) targets.set(boss.instanceId, boss);
    }
    for (const enemy of targets.values()) {
      const card = getEnemy(enemy.cardId);
      const clamp = clampDamageForFatalFlaw(enc, enemy, ability.damage);
      enemy.damageTaken = clamp.newDamageTaken;
      for (const part of enc.enemies) if (part.linkedTo === enemy.instanceId) part.damageTaken = enemy.damageTaken;
      const killed = enemy.damageTaken >= card.hp;
      if (killed) {
        enemy.alive = false;
        for (const part of enc.enemies) if (part.linkedTo === enemy.instanceId) part.alive = false;
        applyKill(state, card, { x: enemy.x, y: enemy.y });
        onEnemyDiedForRebirth(state, enemy);
      }
      result.hit.push({ instanceId: enemy.instanceId, damage: ability.damage - clamp.absorbed, killed });
    }
    applyPendingLevelUps(state);
  }
  logEvent("engine.witnessAbility", { fragment: ability.fragment, ...result });
  return result;
}
