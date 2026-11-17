/**
 * OS equipment engine — shared queue and resolvers for the two OS
 * cards (Providence OS — Mind, Elemental OS — Body).
 *
 * Providence OS (`bonus-xp-on-kill`) is wired directly into
 * `engine/kills.ts > applyKill` (synchronous +1 XP per kill while
 * any LIVING bearer owns it). It needs no UI prompts, so nothing
 * here.
 *
 * Elemental OS uses a TWO-step pattern:
 *
 *   1. The engine enqueues a {@link PendingElementChoice} via
 *      {@link enqueueElementChoice} when a "gain element" effect
 *      fires (currently `gain-element-on-acquire` from
 *      `engine/levelUp.ts > applyLevelUpChoice` and
 *      `gain-element-at-end-of-wave` from
 *      `engine/wave.ts > applyContinuingEndWaveEffects`, queued on
 *      the next wave's board when the party continues).
 *   2. The UI peeks the queue (`peekNextPendingElementChoice`),
 *      opens the `element-pick` modal, and dispatches the player's
 *      pick via {@link applyElementChoice}, which mutates state
 *      (delegates to `grantElementToDelver` so the per-delver cap
 *      of 2 is enforced exactly once) and pops the queue.
 *
 * Turn advance gates (End Turn,
 * `advanceAfterAction`) all consult {@link hasPendingElementChoices}
 * before progressing — the player always picks before moving on.
 *
 * Dead-delver handling: enqueue helpers SKIP delvers at `currentHp
 * <= 0` (per design decision 2026-05-04). A 0-HP delver flips the
 * encounter into End-of-Wave defeat anyway, but the skip keeps the
 * rule explicit even on transient mid-resolution states.
 */

import type { CampaignState, PendingElementChoice } from "../state";
import { getEffectiveEquipmentRanks, getEquipmentCardFor } from "../state";
import type { Element, EquipmentType } from "../types";
import { getEquipmentByTypeSuit, getEquipmentByTypeSuitRank, getHero } from "../data";
import { grantElementToDelver, type ElementGrantOutcome } from "./kills";

/**
 * True iff `state.encounter.pendingElementChoices` has at least one
 * entry waiting on a player decision. Drives:
 *   - `screens/ActionResolution.advanceAfterAction` (post-action queue)
 *   - `screens/LevelUpModal.onPickChoice` (between Level-Up draws)
 *   - End-Turn button gating (see `BoardScreen.canEndTurn`)
 */
export function hasPendingElementChoices(state: CampaignState): boolean {
  return (state.encounter?.pendingElementChoices.length ?? 0) > 0;
}

/**
 * Head of the pending element-choice queue, or `null` if empty.
 * Mirrors `peekNextPendingDraw` in `engine/levelUp.ts`.
 */
export function peekNextPendingElementChoice(
  state: CampaignState,
): PendingElementChoice | null {
  const enc = state.encounter;
  if (!enc || enc.pendingElementChoices.length === 0) return null;
  return enc.pendingElementChoices[0]!;
}

/**
 * Push a fresh entry onto `pendingElementChoices`. SKIPS the enqueue
 * if the recipient is dead (currentHp <= 0) per design decision
 * 2026-05-04 — see module-level docs.
 *
 * Returns true iff an entry was actually pushed (false on dead-skip
 * or no-encounter), so callers can keep counters in sync.
 */
export function enqueueElementChoice(
  state: CampaignState,
  entry: PendingElementChoice,
): boolean {
  const enc = state.encounter;
  if (!enc) return false;
  const lo = state.loadouts[entry.heroId];
  if (!lo) return false;
  if (lo.currentHp <= 0) return false;
  enc.pendingElementChoices.push(entry);
  return true;
}

/**
 * Resolve the head of the queue with the player's chosen element.
 * Mutates state by:
 *   - granting the element via `grantElementToDelver` (which
 *     enforces the per-element cap of 2 — overflow is silently
 *     discarded per rulebook p17),
 *   - popping the queue (FIFO),
 * and returns a tagged result. The {@link ElementGrantOutcome}
 * inside the success branch lets the UI report whether the token
 * actually landed or was lost to the cap.
 *
 * Out-of-band picks (queue empty) return `{ ok: false }` rather
 * than throw — defensive guard against double-clicks while a
 * modal is closing.
 */
export type ElementChoiceResult =
  | { ok: true; entry: PendingElementChoice; outcome: ElementGrantOutcome }
  | { ok: false; reason: string };

export function applyElementChoice(
  state: CampaignState,
  element: Element,
): ElementChoiceResult {
  const enc = state.encounter;
  if (!enc) return { ok: false, reason: "no active encounter" };
  const entry = enc.pendingElementChoices[0];
  if (!entry) return { ok: false, reason: "no pending element choice" };
  const outcome = grantElementToDelver(state, entry.heroId, element);
  enc.pendingElementChoices.shift();
  return { ok: true, entry, outcome };
}

// --- Elemental OS / Shield ONGOING — end of each wave -----------------

/**
 * Walk every passive card owned (rank ≥ 1) by every LIVING delver
 * and enqueue an element-choice prompt for each
 * `gain-element-at-end-of-wave` effect found. Hero order is the
 * `Object.keys(state.loadouts)` order — stable across renders for a
 * given save.
 *
 *   `recipient: "all-delvers"`  → one prompt per LIVING delver.
 *   `recipient: "bearer"`       → one prompt for the bearer only
 *                                 (skipped if the bearer is dead).
 *
 * Per-delver-per-element cap (2) is enforced at resolve time inside
 * `applyElementChoice` → `grantElementToDelver`, so even a fully
 * capped delver gets a prompt — they'll just see all 6 element
 * buttons disabled (the modal handles cap-disable inline).
 *
 * Called once per wave transition by
 * `wave.ts > applyContinuingEndWaveEffects` (only when the party
 * continues to the next wave), after the next wave's encounter is
 * built, so the prompts open on the new wave's board.
 *
 * Returns the number of prompts actually enqueued.
 */
export function enqueueEndWaveElementChoices(
  state: CampaignState,
): number {
  const enc = state.encounter;
  if (!enc) return 0;
  const heroIds = Object.keys(state.loadouts);
  let added = 0;
  for (const bearerId of heroIds) {
    // Effective ranks so a Xavier bump that lifts a slot from 0->1
    // or 1->2 actually triggers its `gain-element-at-end-of-wave`
    // for the current quest. Detractor bumps that drop a slot to
    // R0 likewise suppress the trigger.
    const ranks = getEffectiveEquipmentRanks(state, bearerId);
    const bearerHero = getHero(bearerId);
    for (const type of Object.keys(ranks) as EquipmentType[]) {
      const rank = ranks[type] ?? 0;
      if (rank < 1) continue;
      let bearerCard;
      try {
        // RANK-CORRECT card (2026-07-22): Elemental OS prints
        // 1/2/3/4/5 end-of-wave element grants per rank — pre-fix this
        // read the R1 card and every rank prompted for exactly 1.
        bearerCard = getEquipmentCardFor(state, bearerId, type, rank);
      } catch {
        continue;
      }
      if (bearerCard.category !== "passive") continue;
      for (const eff of bearerCard.effects ?? []) {
        if (eff.kind !== "gain-element-at-end-of-wave") continue;
        const recipients = eff.recipient === "all-delvers" ? heroIds : [bearerId];
        for (const heroId of recipients) {
          // `enqueueElementChoice` does the alive check internally.
          // Each `amount` unit produces one separate prompt so the
          // player picks one element per token gained (R1 = 1 prompt
          // per recipient; future R2-R5 might bump amount and yield
          // multiple).
          for (let i = 0; i < eff.amount; i++) {
            if (enqueueElementChoice(state, {
              heroId,
              source: { kind: "end-of-wave", cardId: bearerCard.id },
            })) {
              added++;
            }
          }
        }
      }
    }
  }
  return added;
}
