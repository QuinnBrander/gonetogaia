/**
 * Chapter 4 Town Square, "Unfolding Disasters" (book p.70): assign each
 * uninjured townsfolk to one of four actions, score the first three for
 * opinion changes, and give each townsfolk on "Assist with combat" a
 * reward for the Assault on Bird's Nest (for that combat only).
 *
 * Reward ruling: the book pairs each combat reward with a bonus type
 * (Sam = Offensive, Elayna = Defensive, the other four = Utility). The
 * Utility rewards are matched to Xavier / Rodrigo / Arlen / Bram in the
 * order the book prints them.
 */
import type { CampaignState, ConsumableTokenKind } from "../state";
import type { RewardEvent } from "../types";
import { runTownVisitAction } from "./townVisit";
import { grantToken } from "./tokens";
import { applyQuestCarryEffect } from "./scenarioCard";
import { logEvent } from "../debug/sessionLog";

export type Talent = "strong" | "resourceful" | "quick" | "smart";
export type Weakness = "slow" | "naive" | "weak" | "unimaginative";
export type TownsfolkActionId = "fire" | "dig" | "first-aid" | "combat";

export type CombatReward =
  | { kind: "tokens"; tokenKind: ConsumableTokenKind; count: number }
  | { kind: "elements"; count: number }
  | { kind: "ap"; amount: number }
  | { kind: "level-cards"; count: number };

export interface Townsfolk {
  id: string;
  name: string;
  image: string;
  talents: Talent[];
  weakness: Weakness;
  bonus: "Offensive" | "Defensive" | "Utility";
  reward: CombatReward;
  rewardText: string;
}

export const TOWNSFOLK: readonly Townsfolk[] = [
  { id: "sam", name: "Sam", image: "/story/townsfolk/sam.png", talents: ["strong", "resourceful"], weakness: "slow",
    bonus: "Offensive", reward: { kind: "tokens", tokenKind: "damage-2x-universal", count: 2 }, rewardText: "2 Universal 2x Damage tokens" },
  { id: "rodrigo", name: "Rodrigo", image: "/story/townsfolk/rodrigo.png", talents: ["quick", "resourceful"], weakness: "naive",
    bonus: "Utility", reward: { kind: "tokens", tokenKind: "reroll", count: 4 }, rewardText: "4 Reroll tokens" },
  { id: "elayna", name: "Elayna", image: "/story/townsfolk/elayna.png", talents: ["smart", "quick"], weakness: "weak",
    bonus: "Defensive", reward: { kind: "tokens", tokenKind: "prevent-counterattack", count: 2 }, rewardText: "2 Block Counterattack tokens" },
  { id: "xavier", name: "Xavier", image: "/story/townsfolk/xavier.png", talents: ["resourceful", "smart"], weakness: "weak",
    bonus: "Utility", reward: { kind: "elements", count: 3 }, rewardText: "3 elements (your choice)" },
  { id: "arlen", name: "Arlen", image: "/story/townsfolk/arlen.png", talents: ["quick", "strong"], weakness: "unimaginative",
    bonus: "Utility", reward: { kind: "level-cards", count: 2 }, rewardText: "2 Level cards" },
  { id: "bram", name: "Bram", image: "/story/townsfolk/bram.png", talents: ["smart", "strong"], weakness: "slow",
    bonus: "Utility", reward: { kind: "ap", amount: 2 }, rewardText: "2 AP" },
];

interface ScoredAction {
  id: Exclude<TownsfolkActionId, "combat">;
  label: string;
  talent: Talent;
  weakness: Weakness;
  /** Score thresholds: success at >= success, failure at <= failure. */
  success: number;
  failure: number;
  characterId: string;
  characterName: string;
}

export const SCORED_ACTIONS: readonly ScoredAction[] = [
  { id: "fire", label: "Put out the fire", talent: "smart", weakness: "naive", success: 2, failure: 0, characterId: "arlen", characterName: "Headmistress Arlen" },
  { id: "dig", label: "Dig out survivors", talent: "strong", weakness: "weak", success: 2, failure: 0, characterId: "rodrigo", characterName: "Rodrigo" },
  { id: "first-aid", label: "Administer first aid", talent: "resourceful", weakness: "unimaginative", success: 4, failure: 2, characterId: "samantha", characterName: "Samantha" },
];

export const ACTION_LABELS: Record<TownsfolkActionId, string> = {
  fire: "Put out the fire",
  dig: "Dig out survivors",
  "first-aid": "Administer first aid",
  combat: "Assist with combat",
};

export function getTownsfolk(id: string): Townsfolk {
  const t = TOWNSFOLK.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown townsfolk "${id}"`);
  return t;
}

/** +2 for the action's talent, 0 for its weakness, 1 otherwise. */
export function townsfolkPoints(t: Townsfolk, action: ScoredAction): number {
  if (t.talents.includes(action.talent)) return 2;
  if (t.weakness === action.weakness) return 0;
  return 1;
}

export type TownsfolkResult = "success" | "partial" | "failure";

export function scoreAction(action: ScoredAction, assigned: readonly string[]): { score: number; result: TownsfolkResult } {
  const score = assigned.reduce((sum, id) => sum + townsfolkPoints(getTownsfolk(id), action), 0);
  const result = score >= action.success ? "success" : score <= action.failure ? "failure" : "partial";
  return { score, result };
}

export interface TownsfolkAssignment {
  townsfolkId: string;
  action: TownsfolkActionId;
  /** Required for "combat": the delver who gains the reward. */
  heroId?: string;
}

/**
 * Commit the Town Square: every townsfolk must be assigned once, and
 * every combat assignment must name a delver. Applies the opinion
 * results and stores the combat rewards on `state.assaultBonuses`.
 */
export function resolveTownsfolkAssignment(
  state: CampaignState,
  assignments: readonly TownsfolkAssignment[],
): RewardEvent[] {
  const ids = assignments.map((a) => a.townsfolkId).sort();
  const want = TOWNSFOLK.map((t) => t.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify(want)) {
    throw new Error(`resolveTownsfolkAssignment: assign each townsfolk exactly once (got ${ids.join(",")})`);
  }
  const events: RewardEvent[] = [];
  for (const action of SCORED_ACTIONS) {
    const assigned = assignments.filter((a) => a.action === action.id).map((a) => a.townsfolkId);
    const { score, result } = scoreAction(action, assigned);
    state.townDecisions.push(`ch4.townsquare.${action.id}.${result}`);
    logEvent("engine.townsfolk.score", { action: action.id, assigned, score, result });
    if (result !== "partial") {
      events.push(...runTownVisitAction(state, {
        kind: "shift-favour", characterId: action.characterId, characterName: action.characterName,
        delta: result === "success" ? 1 : -1,
      }));
    }
  }
  state.assaultBonuses = assignments
    .filter((a) => a.action === "combat")
    .map((a) => {
      if (!a.heroId || !state.loadouts[a.heroId]) {
        throw new Error(`resolveTownsfolkAssignment: ${a.townsfolkId} assists with combat but has no delver`);
      }
      return { townsfolkId: a.townsfolkId, heroId: a.heroId };
    });
  return events;
}

/**
 * Apply `state.assaultBonuses` to a freshly built Assault encounter
 * ("decide now which delver gains each corresponding reward, for this
 * combat only"). Tokens are recorded on `combatOnlyTokens` so they can
 * be removed when the quest ends; AP is current AP only (refreshes away).
 */
export function applyAssaultBonuses(state: CampaignState): RewardEvent[] {
  const enc = state.encounter;
  if (!enc || state.assaultBonuses.length === 0) return [];
  const events: RewardEvent[] = [];
  for (const b of state.assaultBonuses) {
    const t = getTownsfolk(b.townsfolkId);
    const r = t.reward;
    switch (r.kind) {
      case "tokens":
        grantToken(state, b.heroId, r.tokenKind, r.count);
        enc.combatOnlyTokens.push({ heroId: b.heroId, kind: r.tokenKind, count: r.count });
        break;
      case "elements":
        for (let i = 0; i < r.count; i++) {
          enc.pendingElementChoices.push({ heroId: b.heroId, source: { kind: "townsfolk", name: t.name } });
        }
        break;
      case "ap":
        state.loadouts[b.heroId]!.currentAp += r.amount;
        break;
      case "level-cards":
        events.push(...applyQuestCarryEffect(state, { kind: "grant-level-up-card", amount: r.count }));
        break;
    }
    logEvent("engine.townsfolk.assaultBonus", { townsfolk: t.id, heroId: b.heroId, reward: r });
  }
  state.assaultBonuses = [];
  return events;
}

/** End of the Assault: take back combat-only tokens that weren't used. */
export function clearCombatOnlyGrants(state: CampaignState): void {
  const enc = state.encounter;
  if (!enc) return;
  for (const g of enc.combatOnlyTokens) {
    const entry = state.consumableTokens[g.heroId]?.[g.kind];
    if (!entry) continue;
    let left = g.count;
    const fromAvailable = Math.min(left, entry.available);
    entry.available -= fromAvailable;
    left -= fromAvailable;
    entry.spent -= Math.min(left, entry.spent);
  }
  enc.combatOnlyTokens = [];
  for (const lo of Object.values(state.loadouts)) lo.currentAp = Math.min(lo.currentAp, lo.baseAp);
}
