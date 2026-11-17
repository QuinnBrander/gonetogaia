/**
 * Level-Up engine (rulebook p24, "Resolving Multiple Dead Enemies"
 * step 4 + p4 setup step L).
 *
 * Owns the live mechanics behind the level-up draw modal:
 *
 *   1. Deck management — shuffle on encounter init (handled in
 *      `engine/encounter.ts > buildEncounter`), draw from the top,
 *      reshuffle from discard when the deck empties (rulebook p24
 *      "If the deck runs out, shuffle the discard pile").
 *
 *   2. Enqueue — when `applyPendingLevelUps` (xp.ts via kills.ts)
 *      observes a level-up, this module records ONE pending draw per
 *      delver onto `encounter.pendingLevelUpDraws`. Each pending
 *      draw also pulls one card off the deck immediately so the
 *      printed-card identity is locked in (no peeking).
 *
 *   3. Resolve — `applyLevelUpChoice` consumes the head of the
 *      pending queue, increments the chosen equipment-type's rank
 *      (capped at 5 — rulebook implies print-rank ceiling), and
 *      moves the level card to the discard pile.
 *
 * Important non-goals:
 *   - Does NOT scale passive `IMMEDIATELY` effects (e.g. Exoframe
 *     Armor's max-HP bump on rank-up). That's deferred to a follow-up;
 *     for now the rank table is the single source of truth and any
 *     consumer (combat damage, hand UI) reads it directly.
 *   - Does NOT trigger the modal — that's `screens/ActionResolution.ts >
 *     advanceAfterAction` which checks `pendingLevelUpDraws` once
 *     the action's session has finalized.
 */

import type { CampaignState, EncounterState, PendingLevelUpDraw } from "../state";
import type { EquipmentType, LevelUpDeckCard } from "../types";
import { LEVEL_DECK, getEquipmentByTypeSuit, getEquipmentByTypeSuitRank, getHero } from "../data";
import { applyImmediatePassiveEffects, getEquipmentCardFor } from "../state";
import { shuffle } from "../util/random";
import { enqueueElementChoice } from "./os";
import { enqueueEquipmentRoll, rollCardIdFor } from "./tokens";
import { ALL_EQUIPMENT_TYPES, EQUIPMENT_RANK_CAP, isPassiveEquipmentType } from "../types";

/**
 * Hard ceiling on equipment rank (rulebook prints R1..R5 only).
 * Re-exported from `types.ts` (the actual definition site) so
 * existing `import { EQUIPMENT_RANK_CAP } from "./levelUp"` paths
 * keep working without churn. State-layer code reads the const
 * directly from `types.ts` to avoid a state -> engine upward
 * import.
 */
export { EQUIPMENT_RANK_CAP };

/**
 * Look up the printed `LevelUpDeckCard` for a given card number
 * (1..32). Throws if the number isn't in `LEVEL_DECK` — should
 * never happen because `encounter.levelUpDeck` is populated from
 * `LEVEL_DECK` directly (`buildEncounter`).
 */
export function getLevelUpCard(cardNumber: number): LevelUpDeckCard {
  const c = LEVEL_DECK.find((x) => x.cardNumber === cardNumber);
  if (!c) throw new Error(`No level-up card with number ${cardNumber}`);
  return c;
}

/**
 * Resolve the rank delta a given `type` pick would apply for `card`:
 *
 *   - BASE card: type must be one of `card.types` (3 listed) → +1.
 *   - ULTRA card:
 *     - type in `card.types` (2 listed)             → +2.
 *     - type is a passive equipment (regardless of `card.types`) → +1.
 *     - otherwise                                   → 0 (illegal pick).
 *
 * Returns `0` for illegal picks; callers should reject before
 * applying. Single source of truth for the per-card legal-choice
 * lookup so the modal UI (`screens/LevelUpModal.ts`) and the engine
 * resolver (`applyLevelUpChoice` below) can't drift apart.
 */
export function rankDeltaForLevelUpChoice(
  card: LevelUpDeckCard,
  type: EquipmentType,
): 0 | 1 | 2 {
  if (card.isUltra) {
    if (card.types.includes(type)) return 2;
    if (isPassiveEquipmentType(type)) return 1;
    return 0;
  }
  return card.types.includes(type) ? 1 : 0;
}

/**
 * Draw the top card off `encounter.levelUpDeck`, reshuffling from
 * `levelUpDiscard` if the deck is empty (rulebook p24). Returns
 * `null` if BOTH the deck and the discard are empty (impossible in
 * practice — the deck has 28 cards and a single quest can't level
 * 56 times — but guarded anyway so we never crash).
 */
export function drawNextLevelUpCard(encounter: EncounterState): number | null {
  if (encounter.levelUpDeck.length === 0) {
    if (encounter.levelUpDiscard.length === 0) return null;
    encounter.levelUpDeck = shuffle([...encounter.levelUpDiscard]);
    encounter.levelUpDiscard = [];
  }
  return encounter.levelUpDeck.shift() ?? null;
}

/**
 * Enqueue ONE pending draw per delver (in `delverOrder` — defaults
 * to the campaign's two heroes, hero-01 then hero-02). For each
 * delver, draws a card off the deck immediately and stores it on
 * the pending-draw entry.
 *
 * Called from `applyPendingLevelUps` once per level-up. If the deck
 * runs dry mid-enqueue (defensive — see `drawNextLevelUpCard`), the
 * delver's pending entry is silently skipped.
 *
 * Returns the number of pending draws actually enqueued.
 */
export function enqueueLevelUpDraws(
  state: CampaignState,
  delverOrder: readonly string[],
): number {
  const enc = state.encounter;
  if (!enc) return 0;
  let added = 0;
  for (const heroId of delverOrder) {
    const cardNumber = drawNextLevelUpCard(enc);
    if (cardNumber == null) continue;
    enc.pendingLevelUpDraws.push({ heroId, cardNumber });
    added++;
  }
  return added;
}

/**
 * The next pending Level-Up draw waiting on a player decision. Drives
 * the LevelUpModal — when this returns non-null, the modal opens; End
 * Turn is gated until it returns null.
 */
export function peekNextPendingDraw(
  state: CampaignState,
): PendingLevelUpDraw | null {
  const enc = state.encounter;
  if (!enc || enc.pendingLevelUpDraws.length === 0) return null;
  return enc.pendingLevelUpDraws[0]!;
}

/**
 * Every equipment type the delver could legally gain from `card` right
 * now: the card allows it (`rankDeltaForLevelUpChoice`) and the type is
 * below its cap (R3 until a boss-card reveal unlocks higher ranks).
 */
export function legalLevelUpTypes(
  state: CampaignState,
  heroId: string,
  card: LevelUpDeckCard,
): EquipmentType[] {
  const ranks = state.equipmentRanks[heroId] ?? {};
  return ALL_EQUIPMENT_TYPES.filter((type) =>
    rankDeltaForLevelUpChoice(card, type) > 0
    && (ranks[type] ?? 0) < (state.unlockedForHigherRanks?.[heroId]?.[type] ?? 3));
}

/**
 * Ruling (2026-11-15): a drawn level-up card with no legal pick (every
 * allowed type is capped / locked at R3) is simply discarded — no rank,
 * no redraw. Only allowed when the head draw really has no legal pick.
 */
export function discardUnplayableLevelUpDraw(state: CampaignState): number {
  const enc = state.encounter;
  const pending = enc?.pendingLevelUpDraws[0];
  if (!enc || !pending) throw new Error("discardUnplayableLevelUpDraw: no pending level-up draw");
  const card = getLevelUpCard(pending.cardNumber);
  if (legalLevelUpTypes(state, pending.heroId, card).length > 0) {
    throw new Error(`discardUnplayableLevelUpDraw: level card ${card.cardNumber} still has a legal pick`);
  }
  enc.levelUpDiscard.push(pending.cardNumber);
  enc.pendingLevelUpDraws.shift();
  return pending.cardNumber;
}

/** Outcome of an attempted level-up choice. */
export type LevelUpChoiceResult =
  | {
      ok: true;
      heroId: string;
      type: EquipmentType;
      newRank: number;
      cardNumber: number;
      /** How many ranks were applied: 1 for a base pick or an Ultra
       * "+1 to any passive" pick; 2 for an Ultra pick of one of the
       * printed types. Clamped at the rank cap, so a single +2 pick
       * landing on a R4 type only bumps it to R5 (delta=1 effectively
       * but `delta` here is the PRINTED amount, not the applied one
       * — `newRank - before` gives the applied amount). */
      delta: 1 | 2;
    }
  | { ok: false; reason: string };

/**
 * Apply the active player's choice for the head of the pending
 * queue: bump that delver's rank in `type` by the card-specific
 * delta (see `rankDeltaForLevelUpChoice`), capped at
 * `EQUIPMENT_RANK_CAP`. Discard the level card and pop the queue.
 *
 * `type` MUST be a legal choice for the drawn card (in the printed
 * 3-type list for base cards, or in the printed 2-type list /
 * any passive for Ultras). The modal only offers legal types but
 * the engine still validates and rejects out-of-band picks.
 */
export function applyLevelUpChoice(
  state: CampaignState,
  type: EquipmentType,
): LevelUpChoiceResult {
  const enc = state.encounter;
  if (!enc) return { ok: false, reason: "no active encounter" };
  const pending = enc.pendingLevelUpDraws[0];
  if (!pending) return { ok: false, reason: "no pending level-up draw" };

  const card = getLevelUpCard(pending.cardNumber);
  const delta = rankDeltaForLevelUpChoice(card, type);
  if (delta === 0) {
    return { ok: false, reason: `${type} is not a legal choice on level card ${card.cardNumber}` };
  }

  const ranks = state.equipmentRanks[pending.heroId] ?? {};
  const before = ranks[type] ?? 0;
  // Equipment types start with a max base rank of 3. A type can be
  // leveled above R3 only after it has been unlocked via a boss-card
  // rank reveal (stored in `state.unlockedForHigherRanks`).
  const unlockedCap = state.unlockedForHigherRanks?.[pending.heroId]?.[type];
  const baseRankCap = unlockedCap != null ? unlockedCap : 3;
  if (before >= baseRankCap) {
    const reason = unlockedCap != null
      ? `${type} is already at its unlocked rank (R${unlockedCap})`
      : `${type} is locked to rank 3 — unlock it via a boss-card reveal to reach rank 4+`;
    return { ok: false, reason };
  }
  // Clamp the bump so a R4 + delta=2 lands at R5 (not R6), and so a
  // locked R2 + delta=2 can't jump to R4 (lands at R3 = baseRankCap).
  const after = Math.min(baseRankCap, before + delta);
  ranks[type] = after;
  state.equipmentRanks[pending.heroId] = ranks;

  // Synchronous IMMEDIATELY effects fire once PER TIER GAINED,
  // reading each tier's printed card (designer report 2026-07-22:
  // Armor above R1 gave no max-HP increase because only the R0 -> R1
  // gain ever applied immediates, and always from the R1 card).
  // Every ranked card re-prints its own IMMEDIATELY line — Armor R2
  // sets max HP to 12 and grants +3 current HP, Boots R2 raises the
  // movement floor to 3 — so an Ultra +2 crossing two tiers fires
  // both tiers' effects in ascending order. `set-max-hp` overwrites
  // upward, `set-base-movement` is an only-up floor, and
  // `modify-current-hp` clamps against the freshly-raised ceiling,
  // so ascending application is safe.
  if (after > before) {
    const hero = getHero(pending.heroId);
    const lo = state.loadouts[pending.heroId];
    if (lo) {
      for (let r = before + 1; r <= after; r++) {
        try {
          const rankedCard = getEquipmentCardFor(state, pending.heroId, type, r);
          applyImmediatePassiveEffects(lo, [rankedCard]);
        } catch {
          // Missing ranked card for (suit, type, r) — data gap; the
          // rank bump above still lands so the player isn't stuck
          // with an unresolved level-up draw.
        }
      }
      // `gain-element-on-acquire` is a one-shot async effect — it
      // can't be applied synchronously like max-HP / movement bumps
      // because the player picks WHICH element. FIRST GAIN only
      // (rank-ups of an owned OS don't re-print the acquire text).
      // Enqueue one pending element choice per `amount` unit; the
      // LevelUpModal gates further draws until the queue empties.
      if (before === 0) {
        try {
          const card = getEquipmentByTypeSuit(hero.suit, type);
          for (const eff of card.effects ?? []) {
            if (eff.kind === "gain-element-on-acquire") {
              for (let i = 0; i < eff.amount; i++) {
                enqueueElementChoice(state, {
                  heroId: pending.heroId,
                  source: { kind: "os-immediate", cardId: card.id },
                });
              }
            }
          }
        } catch {
          // Same defensive posture as the ranked-card loop above.
        }
      }
    }
  }

  // Equipment rolls (Supercharger / Battery): the printed IMMEDIATELY
  // roll is granted PER RANK TIER, not just on first gain — every
  // rank of a roll-carrying card gives 1 benefit roll (designer
  // ruling 2026-07-20; every printed rank card R1-R5 carries the
  // roll text). Enqueue one roll per rank actually gained, so:
  //   - base pick, R0 -> R1: 1 roll (unchanged),
  //   - base pick, R1 -> R2: 1 roll (was 0 — user report: rank-up
  //     never prompted),
  //   - Ultra +2, R1 -> R3:  2 rolls (was 0 — the reported case),
  //   - cap-clamped bumps only roll for ranks actually gained
  //     (`after - before`, not `delta`).
  // Same async-prompt pattern as element picks: the post-level-up
  // flow drains the queue before the next pending Level-Up modal
  // opens. The per-card outcome table is looked up at modal time via
  // `equipmentRollTableForCard(card.id)`.
  if (after > before) {
    try {
      // Variant-aware: Ion Battery / Overcharger replace the standard card.
      const rollCardId = rollCardIdFor(state, pending.heroId, type);
      if (rollCardId) {
        for (let i = before; i < after; i++) {
          enqueueEquipmentRoll(state, pending.heroId, rollCardId);
        }
      }
    } catch {
      // Missing R1 card for (suit, type) — data bug; the rank bump
      // above still lands (same defensive posture as the first-gain
      // block).
    }
  }

  // Discard the card and pop the queue.
  enc.levelUpDiscard.push(pending.cardNumber);
  enc.pendingLevelUpDraws.shift();

  return {
    ok: true,
    heroId: pending.heroId,
    type,
    newRank: after,
    cardNumber: pending.cardNumber,
    delta,
  };
}
