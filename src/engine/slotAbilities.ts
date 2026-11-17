/**
 * Slot-ability resolver (DESIGN.md §5.8).
 *
 * Dispatches on `SlotAbility.kind`. Each kind validates its own
 * inputs, mutates `state` directly, and returns a `SlotAbilityResult`
 * for the modal display.
 *
 * Two of the five kinds (`damage-any-enemy`) actually deal damage to
 * an enemy, so they share the same per-tile resolution loop as a
 * weapon attack — the dispatcher returns a session for the UI to step
 * through (one counter-roll prompt). The other four kinds resolve in
 * a single mutation, no prompts.
 *
 * Gating (placement done, !actionUsed, !preparedToRun, currentDelver)
 * is handled by `engine/turn.ts > useSlotAbility` — this module assumes
 * the caller has already validated.
 */

import { damageDelverInWave } from "./omenRebirth";
import type { CampaignState } from "../state";
import type { Element, SlotAbility } from "../types";
import { getDelverBoard } from "../data";
import { getHero } from "../data";
import {
  buildAttackSession,
  effectiveDamageForType,
  type AttackSession,
  type PreEffect,
} from "./combat";
import { getEnemyAt } from "./encounter";
import { grantElementToDelver } from "./kills";

/**
 * Per-kind input the caller (UI or test) provides at use-time.
 */
export type SlotAbilityParams =
  | { kind: "damage-any-enemy"; targetX: number; targetY: number }
  | { kind: "bonus-movement-this-turn" }
  | { kind: "refresh-ap" }
  | { kind: "gain-token"; recipientHeroId: string }
  | { kind: "gain-element"; recipientHeroId: string };

/**
 * Result of resolving a slot ability. Damage abilities return a session
 * (UI must step it once, prompting for a counter roll). All other
 * kinds return `applied` with a brief log.
 */
export type SlotAbilityResult =
  | { kind: "damage-session"; session: AttackSession }
  | { kind: "applied"; log: SlotAbilityLog };

export interface SlotAbilityLog {
  /** Short human-readable summary for the resolution modal. */
  summary: string;
  /** Structured detail for tests / future analytics. */
  detail: SlotAbilityDetail;
}

export type SlotAbilityDetail =
  | { kind: "bonus-movement-this-turn"; heroId: string; amount: number; newCurrentMovement: number }
  | { kind: "refresh-ap"; heroId: string; amount: number; newCurrentAp: number }
  | { kind: "gain-token"; recipientHeroId: string; token: "creature-part" | "boss-part"; newTotal: number }
  | { kind: "gain-element"; recipientHeroId: string; element: Element; newTotal: number };

export type ResolveSlotAbilityResult =
  | { ok: true; result: SlotAbilityResult }
  | { ok: false; reason: string };

/**
 * Top-level resolver. Reads `SlotAbility` from the appropriate suit
 * board, validates `params.kind` matches the printed ability kind,
 * then dispatches.
 */
export function resolveSlotAbility(
  state: CampaignState,
  heroId: string,
  slotIdx: number,
  params: SlotAbilityParams,
): ResolveSlotAbilityResult {
  const hero = getHero(heroId);
  const board = getDelverBoard(hero.suit);
  const slot = board.weaponSlots[slotIdx];
  if (!slot) return { ok: false, reason: `slotIdx ${slotIdx} out of range` };
  const ability = slot.slotAbility;
  if (ability.kind !== params.kind) {
    return {
      ok: false,
      reason: `slot ability kind mismatch: printed=${ability.kind} requested=${params.kind}`,
    };
  }

  switch (ability.kind) {
    case "damage-any-enemy": {
      if (params.kind !== "damage-any-enemy") return { ok: false, reason: "unreachable" };
      return resolveDamageAnyEnemy(state, heroId, slotIdx, ability, params);
    }
    case "bonus-movement-this-turn": {
      return resolveBonusMovement(state, heroId, ability);
    }
    case "refresh-ap": {
      return resolveRefreshAp(state, heroId, ability);
    }
    case "gain-token": {
      if (params.kind !== "gain-token") return { ok: false, reason: "unreachable" };
      return resolveGainToken(state, ability, params);
    }
    case "gain-element": {
      if (params.kind !== "gain-element") return { ok: false, reason: "unreachable" };
      return resolveGainElement(state, ability, params);
    }
  }
}

// --- Per-kind resolvers --------------------------------------------------

function resolveDamageAnyEnemy(
  state: CampaignState,
  heroId: string,
  slotIdx: number,
  ability: Extract<SlotAbility, { kind: "damage-any-enemy" }>,
  params: Extract<SlotAbilityParams, { kind: "damage-any-enemy" }>,
): ResolveSlotAbilityResult {
  const enc = state.encounter;
  if (!enc) return { ok: false, reason: "no encounter" };
  const enemy = getEnemyAt(enc, params.targetX, params.targetY);
  if (!enemy) return { ok: false, reason: "no live enemy on target tile" };

  const hero = getHero(heroId);
  const slotElement = getDelverBoard(hero.suit).weaponSlots[slotIdx]!.element;

  // Self-suffer is applied BEFORE damage is dealt (body-void slot).
  // Clamp to 0; we don't model defeat in 4c, just clamp HP.
  const preEffects: PreEffect[] = [];
  if (ability.selfSuffer && ability.selfSuffer > 0) {
    const loadout = state.loadouts[heroId];
    if (loadout) {
      damageDelverInWave(state, heroId, ability.selfSuffer);
      preEffects.push({ kind: "self-suffer", heroId, amount: ability.selfSuffer });
    }
  }

  const session = buildAttackSession({
    attackerId: heroId,
    source: { kind: "slot", slotIdx, element: slotElement },
    damage: effectiveDamageForType(state, heroId, ability.damageType),
    damageType: ability.damageType,
    hitTiles: [{ x: params.targetX, y: params.targetY }],
    preEffects,
  });
  return { ok: true, result: { kind: "damage-session", session } };
}

function resolveBonusMovement(
  state: CampaignState,
  heroId: string,
  ability: Extract<SlotAbility, { kind: "bonus-movement-this-turn" }>,
): ResolveSlotAbilityResult {
  const loadout = state.loadouts[heroId];
  if (!loadout) return { ok: false, reason: "no loadout for delver" };
  // If AP-double is active for this turn, the +N is doubled too — the
  // "doubling" applies to ALL movement gained this turn (DESIGN.md
  // §4.3). Order-independent: AP-then-slot and slot-then-AP both
  // converge on the same final budget.
  const ts = state.encounter?.turnState[heroId] ?? null;
  const multiplier = ts?.apMovementDoubledThisTurn ? 2 : 1;
  const granted = ability.amount * multiplier;
  loadout.currentMovement += granted;
  // No carve-out (designer ruling 2026-11-17): movement is one
  // continuous move. If the delver has already stepped this turn,
  // taking this ability as the action ends the movement like any other
  // action (`turn.ts > endMovementSessionIfActionInterruptsIt`), so the
  // bonus only helps a delver who hasn't moved yet. The flag below is
  // display only (the movement badge's total).
  if (ts && ts.movementStepsThisTurn === 0) ts.actionGrantedExtraMovement = true;
  // Note: this can take currentMovement above baseMovement for the
  // remainder of THIS turn. `startHeroTurn` will reset to baseMovement
  // next turn; intentional, this is a one-turn bonus.
  return {
    ok: true,
    result: {
      kind: "applied",
      log: {
        summary: multiplier === 2
          ? `+${granted} movement this turn (+${ability.amount} doubled by AP)`
          : `+${granted} movement this turn`,
        detail: {
          kind: "bonus-movement-this-turn",
          heroId,
          amount: granted,
          newCurrentMovement: loadout.currentMovement,
        },
      },
    },
  };
}

function resolveRefreshAp(
  state: CampaignState,
  heroId: string,
  ability: Extract<SlotAbility, { kind: "refresh-ap" }>,
): ResolveSlotAbilityResult {
  const loadout = state.loadouts[heroId];
  if (!loadout) return { ok: false, reason: "no loadout for delver" };
  // Cap at baseAp — refresh shouldn't exceed your printed budget.
  const newCurrentAp = Math.min(loadout.baseAp, loadout.currentAp + ability.amount);
  const actuallyRefreshed = newCurrentAp - loadout.currentAp;
  loadout.currentAp = newCurrentAp;
  return {
    ok: true,
    result: {
      kind: "applied",
      log: {
        summary: actuallyRefreshed > 0
          ? `Refreshed ${actuallyRefreshed} AP`
          : `AP already at base (${loadout.baseAp})`,
        detail: {
          kind: "refresh-ap",
          heroId,
          amount: actuallyRefreshed,
          newCurrentAp,
        },
      },
    },
  };
}

function resolveGainToken(
  state: CampaignState,
  ability: Extract<SlotAbility, { kind: "gain-token" }>,
  params: Extract<SlotAbilityParams, { kind: "gain-token" }>,
): ResolveSlotAbilityResult {
  if (!state.loadouts[params.recipientHeroId]) {
    return { ok: false, reason: `unknown recipientHeroId: ${params.recipientHeroId}` };
  }
  let newTotal: number;
  if (ability.token === "creature-part") {
    state.minionParts[params.recipientHeroId] =
      (state.minionParts[params.recipientHeroId] ?? 0) + 1;
    newTotal = state.minionParts[params.recipientHeroId]!;
  } else {
    state.bossParts[params.recipientHeroId] =
      (state.bossParts[params.recipientHeroId] ?? 0) + 1;
    newTotal = state.bossParts[params.recipientHeroId]!;
  }
  return {
    ok: true,
    result: {
      kind: "applied",
      log: {
        summary: `${pretty(ability.token)} \u2192 delver ${params.recipientHeroId}`,
        detail: {
          kind: "gain-token",
          recipientHeroId: params.recipientHeroId,
          token: ability.token,
          newTotal,
        },
      },
    },
  };
}

function resolveGainElement(
  state: CampaignState,
  ability: Extract<SlotAbility, { kind: "gain-element" }>,
  params: Extract<SlotAbilityParams, { kind: "gain-element" }>,
): ResolveSlotAbilityResult {
  if (!state.loadouts[params.recipientHeroId]) {
    return { ok: false, reason: `unknown recipientHeroId: ${params.recipientHeroId}` };
  }
  // Cap of 2 enforced by `grantElementToDelver` (rulebook p17). If
  // overflow, the slot ability still "succeeds" (the player chose it),
  // but the token is silently discarded — same wording as on-death
  // gains.
  const grant = grantElementToDelver(state, params.recipientHeroId, ability.element);
  const summary = grant.granted
    ? `+1 ${ability.element} element \u2192 delver ${params.recipientHeroId}`
    : `${ability.element} bag full - token lost (delver ${params.recipientHeroId})`;
  return {
    ok: true,
    result: {
      kind: "applied",
      log: {
        summary,
        detail: {
          kind: "gain-element",
          recipientHeroId: params.recipientHeroId,
          element: ability.element,
          newTotal: grant.newTotal,
        },
      },
    },
  };
}

function pretty(token: "creature-part" | "boss-part"): string {
  return token === "creature-part" ? "+1 CREATURE PART" : "+1 BOSS PART";
}
