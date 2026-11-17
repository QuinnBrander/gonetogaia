/**
 * Enemy abilities for the Chapter 4 quests: #4 "A Hand Outstretched",
 * #7 "Further Afield" and #13 "Underneath the Watchtower". Rule text is in
 * `screens/EnemyAbilitiesModal.ts`; this module holds the engine side and
 * is called from `engine/combat.ts` / `engine/turn.ts`.
 *
 * Prototype rulings (confirm with the designer):
 *   - Backup: the 2 extra counterattackers are picked automatically - the
 *     2 living enemies nearest the attacker (ties: board order).
 *   - Brawler: a "melee attack" is one made while the attacker stands
 *     next to the boss (8-way). Half damage rounds up, like Evasive.
 *   - Shell: "misses" = none of its arrows hit a delver this counterattack.
 *   - Corruption ticks at the end of every hero turn.
 *   - Double Edged: "its black arrow is targeting a delver" = a delver
 *     stands on one of its black (roll-6) arrow tiles right now.
 */
import type { CampaignState, EnemyInstance } from "../state";
import type { EnemyAbility, EnemyCard, EquipmentType } from "../types";
import { getEnemy, getHero, getEquipmentByTypeSuit } from "../data";
import { logEvent } from "../debug/sessionLog";
import { recordAbilityProc } from "./abilityProcs";
import { damageDelverInWave } from "./omenRebirth";

type Enc = NonNullable<CampaignState["encounter"]>;

export function cardHas(card: EnemyCard, kind: EnemyAbility["kind"]): boolean {
  return card.abilities.some((a) => a.kind === kind);
}

function adj8(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return !(a.x === b.x && a.y === b.y) && Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;
}

/** Evasive: true when the enemy suffers half damage (not both delvers adjacent). */
export function evasiveApplies(enc: Enc, enemy: EnemyInstance): boolean {
  const positions = Object.values(enc.delverPositions);
  return !(positions.length >= 2 && positions.every((p) => adj8(p, enemy)));
}

/** Brawler: the attack is a melee attack (attacker adjacent to the boss). */
export function isMeleeAttack(enc: Enc, attackerId: string, enemy: EnemyInstance): boolean {
  const pos = enc.delverPositions[attackerId];
  return !!pos && adj8(pos, enemy);
}

/** Exhaust one available consumable token (Soul Sap). Returns the kind, or null. */
export function exhaustOneToken(state: CampaignState, heroId: string): string | null {
  const bag = state.consumableTokens[heroId] ?? {};
  for (const [kind, entry] of Object.entries(bag)) {
    if (entry && entry.available > 0) {
      entry.available -= 1;
      entry.spent += 1;
      return kind;
    }
  }
  return null;
}

/** Spiked: "Deals 3 damage back each time it suffers 8 or more damage from a weapon card." */
export const SPIKED_THRESHOLD = 8;
export const SPIKED_DAMAGE = 3;
/** Last Act: "the delver that slayed it suffers 4 damage". */
export const LAST_ACT_DAMAGE = 4;

/** Backup: 2 extra living enemies nearest the attacker, not already counterattacking. */
export function backupExtras(enc: Enc, attackerId: string, exclude: ReadonlySet<string>): EnemyInstance[] {
  const pos = enc.delverPositions[attackerId];
  if (!pos) return [];
  return enc.enemies
    .filter((e) => e.alive && !exclude.has(e.instanceId) && !e.linkedTo)
    .map((e, i) => ({ e, i, d: Math.max(Math.abs(e.x - pos.x), Math.abs(e.y - pos.y)) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .slice(0, 2)
    .map((x) => x.e);
}

// --- Steals (Ruined Tidekin) -----------------------------------------------
// The stolen card stays in its slot (so it is out of the hand), and while
// stolen it can't be refreshed. Returning it just clears the mark - the
// card is still in the slot, i.e. "returned weapons are exhausted".

export function isStolenCard(state: CampaignState, heroId: string, cardId: string): boolean {
  const s = state.encounter?.stolenWeapon;
  return !!s && s.heroId === heroId && s.cardId === cardId;
}

export function stealWeapon(state: CampaignState, heroId: string, cardId: string): void {
  const enc = state.encounter!;
  if (enc.stolenWeapon) logEvent("engine.steals.returned", { ...enc.stolenWeapon });
  enc.stolenWeapon = { heroId, cardId };
  logEvent("engine.steals.stolen", { heroId, cardId });
}

export function returnStolenWeapon(state: CampaignState): void {
  const enc = state.encounter;
  if (!enc?.stolenWeapon) return;
  logEvent("engine.steals.returned", { ...enc.stolenWeapon });
  enc.stolenWeapon = null;
}

// --- Ritual (Winona the Oak) -----------------------------------------------

/** Ranks currently sacrificed to Ritual for one delver's equipment type. */
export function ritualPenalty(state: CampaignState, heroId: string, type: EquipmentType): number {
  return (state.encounter?.ritualSacrifices ?? []).filter((s) => s.heroId === heroId && s.type === type).length;
}

/** Equipment types the delver can sacrifice (effective rank 1+). */
export function ritualOptions(state: CampaignState, heroId: string, effective: Partial<Record<EquipmentType, number>>): EquipmentType[] {
  return (Object.keys(effective) as EquipmentType[]).filter((t) => (effective[t] ?? 0) >= 1);
}

export function sacrificeToRitual(state: CampaignState, heroId: string, type: EquipmentType): void {
  const enc = state.encounter!;
  const idx = enc.pendingRitualPicks.indexOf(heroId);
  if (idx < 0) throw new Error(`sacrificeToRitual: no Ritual pick pending for ${heroId}`);
  enc.pendingRitualPicks.splice(idx, 1);
  enc.ritualSacrifices.push({ heroId, type });
  // A rank-1 card that hits 0 leaves the hand; if it sits in a slot it
  // stays there (exhausted) and simply can't come back until restored.
  logEvent("engine.ritual.sacrifice", { heroId, type, card: getEquipmentByTypeSuit(getHero(heroId).suit, type).id });
}

export function clearRitual(state: CampaignState): void {
  const enc = state.encounter;
  if (!enc) return;
  enc.ritualSacrifices = [];
  enc.pendingRitualPicks = [];
}

// --- Corruption (Incomplete Revenant) ---------------------------------------

/** End of each hero turn: the corrupted delver suffers 1 (boss alive) or
 *  the tokens are removed (boss dead). Returns true if damage was dealt. */
export function tickCorruption(state: CampaignState): boolean {
  const enc = state.encounter;
  const c = enc?.corruption;
  if (!enc || !c) return false;
  const boss = enc.enemies.find((e) => e.instanceId === c.bossInstanceId);
  if (!boss || !boss.alive) {
    enc.corruption = null;
    return false;
  }
  damageDelverInWave(state, c.heroId, 1);
  recordAbilityProc(boss, "corruption");
  logEvent("engine.corruption.tick", { heroId: c.heroId });
  return true;
}

export function enemyCardOf(enemy: EnemyInstance): EnemyCard {
  return getEnemy(enemy.cardId);
}
