/**
 * Consumable token engine.
 *
 * Owns the per-delver `state.consumableTokens` bag — the canonical
 * grant / spend / refresh / read API that the UI and other engine
 * modules go through. Going through these helpers (instead of
 * mutating the bag directly) guarantees:
 *
 *   - `available` and `spent` are always >= 0.
 *   - `spendToken` requires `available > 0` (silent no-op + return
 *     `false` otherwise; never goes negative).
 *   - The bag entry exists by the time it's read (sparse-by-default
 *     via `Partial<Record<...>>`, but materialised on first grant).
 *
 * Per-turn spend caps (decided 2026-05-04, mirrors the printed DD
 * cap on rulebook p15: *"No matter the type of double damage token
 * you use, you can only use 1 double damage token per turn."*):
 *
 *   - Double Damage family (typed Light/Medium/Heavy + future
 *     Universal): 1 spend per delver-turn ACROSS the family
 *     (single shared `damage2xUsedThisTurn` flag), enforced by
 *     {@link canSpendDoubleDamage}.
 *   - `reroll` and `prevent-counterattack` (Block Counterattack): NO
 *     per-turn cap (designer decision 2026-11-17) — either delver may
 *     spend them at any time, as often as they have tokens. The gate
 *     is just the bag count ({@link canSpendReroll},
 *     {@link canSpendPreventCounter}).
 *     (AP was unified with the board-AP pool on 2026-05-09 — see
 *     `state.ts > ConsumableTokenKind` jsdoc — so there is no
 *     separate AP-token spend gate any more; AP is paid directly
 *     from `loadout.currentAp` via `engine/turn.ts > chargeAp`.)
 *
 * Damage-doubling is applied to a swing via
 * {@link doubledDamageMultiplier} — the multiplier the swing should
 * use AFTER any DD spend has been recorded. Callers (today
 * `engine/turn.ts > useWeaponAbility`) read the swing's printed
 * `damageMultiplier` and feed it through this helper alongside the
 * (optional) DD kind being spent.
 *
 * Equipment die-roll grant flow (Supercharger, Battery, ...future):
 *   1. `enqueueEquipmentRoll(state, heroId, cardId)` — pushes a
 *      `PendingEquipmentRoll` onto `state.encounter` (called from
 *      `applyLevelUpChoice` when a card carrying the
 *      `immediately-equipment-roll` effect is first gained).
 *   2. UI opens the `equipment-roll` modal, looks up the per-card
 *      outcome table via {@link equipmentRollTableForCard}, captures
 *      the d6 + (on a "choice" face) the player's chosen outcome.
 *   3. `applyEquipmentRoll(state, heroId, outcome)` grants the
 *      tokens and pops the queue.
 *
 * The per-card outcome tables live in {@link EQUIPMENT_ROLL_TABLES}
 * so a single modal scaffold serves every card. Each table maps the
 * 6 d6 faces to either a direct outcome id or `"choice"` (player
 * picks one of the printed outcomes).
 */

import type {
  CampaignState,
  ConsumableTokenBag,
  ConsumableTokenKind,
} from "../state";
import { ALL_DOUBLE_DAMAGE_KINDS, TYPED_DOUBLE_DAMAGE_KINDS, getEquipmentCardFor } from "../state";
import type { EquipmentType } from "../types";
import { getEquipment, getHero } from "../data";
import { logEvent } from "../debug/sessionLog";

// Re-export so callers don't have to dual-import from `state` AND
// here just to talk about token kinds.
export type {
  ConsumableTokenBag,
  ConsumableTokenKind,
  PendingEquipmentRoll,
} from "../state";

// --- Bag basics --------------------------------------------------------

/** Read the current Available count for a kind (0 if the bag has no
 *  entry yet). Pure, never mutates. */
export function tokenAvailable(
  state: CampaignState,
  heroId: string,
  kind: ConsumableTokenKind,
): number {
  return state.consumableTokens[heroId]?.[kind]?.available ?? 0;
}

/** Read the current Spent count for a kind (0 if the bag has no
 *  entry yet). Pure, never mutates. */
export function tokenSpent(
  state: CampaignState,
  heroId: string,
  kind: ConsumableTokenKind,
): number {
  return state.consumableTokens[heroId]?.[kind]?.spent ?? 0;
}

/**
 * Grant `count` tokens of `kind` to the named delver. Tokens land in
 * `available`. No supply check (rulebook supply numbers are
 * tracked physically in the box; the digital prototype is unlimited
 * by design — see DESIGN.md §5.5.2). Negative or zero counts are
 * silent no-ops (defensive).
 *
 * Materialises the bag entry on first grant.
 */
export function grantToken(
  state: CampaignState,
  heroId: string,
  kind: ConsumableTokenKind,
  count: number,
): void {
  if (count <= 0) return;
  const bag = ensureBag(state, heroId);
  const entry = bag[kind] ?? { available: 0, spent: 0 };
  entry.available += count;
  bag[kind] = entry;
}

/**
 * Spend ONE token of `kind` from the named delver's bag. Moves it
 * from `available` → `spent`. Returns `true` on success, `false` if
 * there were no tokens to spend (silent guard — caller is expected
 * to gate via `tokenAvailable` / `canSpend*` first; the boolean
 * lets the caller distinguish a no-op from a successful spend
 * without re-reading state).
 *
 * Side-effects beyond the bag mutation:
 *   - For Double Damage kinds (typed + universal), flips the
 *     SPENDER's `turnState.damage2xUsedThisTurn` flag so subsequent
 *     spend gates close out for the rest of this turn (per the
 *     printed 1-DD-per-turn cap).
 *
 * The per-turn cap is owned by the SPENDER (`heroId` argument),
 * not by `state.currentDelverId`. This matters during interleaved
 * flows like the post-level-up equipment-roll modal: hero-02 may
 * reroll their own first-gain prompt during hero-01's turn — the
 * reroll cap should latch on hero-02's turn state, not hero-01's.
 */
export function spendToken(
  state: CampaignState,
  heroId: string,
  kind: ConsumableTokenKind,
): boolean {
  const bag = state.consumableTokens[heroId];
  const entry = bag?.[kind];
  if (!entry || entry.available <= 0) return false;
  entry.available -= 1;
  entry.spent += 1;
  const ts = state.encounter?.turnState[heroId];
  if (ts) {
    if ((ALL_DOUBLE_DAMAGE_KINDS as readonly string[]).includes(kind)) {
      ts.damage2xUsedThisTurn = true;
      // Record which damage type is now doubled so subsequent attacks
      // (including freeRepeat / Soulshift) automatically get 2x too.
      const typeKey =
        kind === "damage-2x-light"     ? "light" :
        kind === "damage-2x-medium"    ? "medium" :
        kind === "damage-2x-heavy"     ? "heavy" :
        kind === "damage-2x-universal" ? "universal" :
        null;
      if (typeKey) ts.doubleDamageActive[typeKey] = true;
    }
  }
  return true;
}

// --- Double Damage gating ---------------------------------------------

/**
 * Can the named delver spend a Double Damage token of `kind` RIGHT
 * NOW? Combines:
 *   - `tokenAvailable(kind) > 0` — they have one in the bag.
 *   - `!turnState.damage2xUsedThisTurn` — they haven't already
 *     spent a DD token this turn (regardless of which kind).
 *   - The active encounter has a `turnState` entry for them
 *     (out-of-encounter spends are nonsense).
 *
 * Pure check; never mutates. Returns a tagged result so the UI can
 * surface the SPECIFIC reason (tooltip / disabled button title).
 */
export type DoubleDamageSpendCheck =
  | { ok: true }
  | { ok: false; reason: string };

export function canSpendDoubleDamage(
  state: CampaignState,
  heroId: string,
  kind: ConsumableTokenKind,
): DoubleDamageSpendCheck {
  if (!(ALL_DOUBLE_DAMAGE_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: `${kind} is not a Double Damage token` };
  }
  if (tokenAvailable(state, heroId, kind) <= 0) {
    return { ok: false, reason: `no ${kind} tokens available` };
  }
  const ts = state.encounter?.turnState[heroId];
  if (!ts) {
    return { ok: false, reason: "delver has no active turn state" };
  }
  if (ts.damage2xUsedThisTurn) {
    return { ok: false, reason: "already spent a Double Damage token this turn" };
  }
  return { ok: true };
}

/**
 * Compute the post-DD-spend damage multiplier for a swing. Returns
 * the printed `baseMultiplier` doubled when:
 *   - `spentKind === "damage-2x-universal"` (always doubles), OR
 *   - `spentKind` is a typed DD whose `damageType` matches the
 *     swing's printed `damageType` (e.g. `damage-2x-light` only
 *     doubles a Light swing).
 *
 * Otherwise returns `baseMultiplier` unchanged. Mismatched typed
 * spends return the base multiplier rather than throwing — the UI
 * is expected to only surface the matching DD kind, but
 * defense-in-depth is cheap.
 *
 * Pure: doesn't read or mutate state. Called by
 * `engine/turn.ts > useWeaponAbility` AFTER `spendToken` has
 * already committed the bag mutation.
 */
export function doubledDamageMultiplier(
  baseMultiplier: number,
  damageType: "light" | "medium" | "heavy",
  spentKind: ConsumableTokenKind | null,
): number {
  if (spentKind == null) return baseMultiplier;
  if (spentKind === "damage-2x-universal") return baseMultiplier * 2;
  // Typed DDs only double a matching swing.
  const matching: ConsumableTokenKind = (() => {
    switch (damageType) {
      case "light": return "damage-2x-light";
      case "medium": return "damage-2x-medium";
      case "heavy": return "damage-2x-heavy";
    }
  })();
  return spentKind === matching ? baseMultiplier * 2 : baseMultiplier;
}

/**
 * Convenience: which typed DD token kind would double a swing of
 * the given `damageType`? Used by the spend-prompt UI to know which
 * "Spend N x Light" / "Spend N x Medium" / "Spend N x Heavy"
 * button to surface alongside the universal one.
 */
export function typedDoubleDamageKindFor(
  damageType: "light" | "medium" | "heavy",
): ConsumableTokenKind {
  switch (damageType) {
    case "light": return "damage-2x-light";
    case "medium": return "damage-2x-medium";
    case "heavy": return "damage-2x-heavy";
  }
}

// --- Non-DD spend gating (Reroll / Block Counterattack) ------------------

/** Same-shape result type as the DD checker so callers can reuse one
 *  tooltip codepath. */
export type ConsumableSpendCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Can a Reroll token be spent against the next die roll? Used by
 * the counter-roll, equipment-roll, and any future die-roll modal
 * to gate the "Reroll" button. No per-turn cap — players may reroll
 * as many times as they have tokens.
 *
 * Note `heroId` selects the BAG owner (whose token is spent).
 */
export function canSpendReroll(
  state: CampaignState,
  heroId: string,
): ConsumableSpendCheck {
  if (tokenAvailable(state, heroId, "reroll") <= 0) {
    return { ok: false, reason: "no Reroll tokens available" };
  }
  return { ok: true };
}

/**
 * Can a Block Counterattack token be spent on the current
 * counter-attack resolution? Used by the counter-roll modal to
 * surface the "Block 1 counterattack" button. No per-turn cap.
 */
export function canSpendPreventCounter(
  state: CampaignState,
  heroId: string,
): ConsumableSpendCheck {
  if (tokenAvailable(state, heroId, "prevent-counterattack") <= 0) {
    return { ok: false, reason: "no Block Counterattack tokens available" };
  }
  return { ok: true };
}

// --- End Wave refresh -------------------------------------------------

/**
 * Flip every Spent consumable token back to Available across every
 * delver and every kind. Idempotent (if nothing's spent, this is a
 * no-op). Called from the End Wave tick alongside the
 * existing weapon-card refresh, per rulebook p14: *"All Spent
 * consumable tokens flip back to Available."*
 *
 * Doesn't touch turnState flags — the per-turn caps are reset by
 * `startHeroTurn`, which fires one tick after End Wave when the
 * next Hero Phase begins, so the two systems naturally compose.
 */
export function refreshAllSpentTokens(state: CampaignState): void {
  for (const heroId of Object.keys(state.consumableTokens)) {
    const bag = state.consumableTokens[heroId];
    if (!bag) continue;
    for (const kind of Object.keys(bag) as ConsumableTokenKind[]) {
      const entry = bag[kind];
      if (!entry) continue;
      if (entry.spent === 0) continue;
      entry.available += entry.spent;
      entry.spent = 0;
    }
  }
}

// --- Equipment die-roll grant tables ----------------------------------

/**
 * One outcome on an equipment die-roll table. `id` matches the
 * card's printed outcome label (1, 2, 3, 4) so the UI can surface
 * "Option 1" / "Option 2" buttons without any additional mapping.
 */
export interface EquipmentRollOutcome {
  id: number;
  /** Per-kind consumable token count to grant. */
  grants: Partial<Record<ConsumableTokenKind, number>>;
  /**
   * Optional bump to the recipient's `loadout.baseAp` (and an
   * equal top-up to `currentAp` so the +AP is usable THIS wave,
   * not just at the next End Wave refresh).
   *
   * Used by Battery's "AP" outcome (post-2026-05-09 unification —
   * AP is no longer a consumable token, so the printed "gain 1 AP
   * token" is modelled as a permanent (per-quest) +1 to the AP
   * pool). Cleared by per-quest reset hooks (future work — Q1 is
   * the only quest shipped, so the +1 currently lives until the
   * save resets).
   */
  baseApDelta?: number;
  /** Human label for the modal button + log. */
  label: string;
}

/**
 * Per-card mapping of d6 faces (1..6) to an outcome id, OR
 * `"choice"` for faces that prompt the player to pick one of the
 * outcomes manually.
 *
 * Encoded as a tuple indexed [0..5] for cheap and lossless JSON
 * round-tripping. Index 0 = die face 1, index 5 = die face 6.
 */
export type DieFaceMap = readonly [
  number | "choice",
  number | "choice",
  number | "choice",
  number | "choice",
  number | "choice",
  number | "choice",
];

/**
 * The per-card outcome table for an equipment card carrying the
 * `immediately-equipment-roll` effect. The UI looks this up via
 * {@link equipmentRollTableForCard} when the
 * `pendingEquipmentRolls` queue surfaces a roll for this card id.
 */
export interface EquipmentRollTable {
  /** Card id (e.g. `mind-supercharger-r1`) — matches the registry key. */
  cardId: string;
  /** Display label for the modal header. */
  cardName: string;
  /** Outcomes in printed order (player-pick on `"choice"` faces uses this list). */
  outcomes: readonly EquipmentRollOutcome[];
  /** d6 face → outcome id OR `"choice"`. */
  rollMap: DieFaceMap;
  /** "Immediately: choose 1 listed reward" cards (Ion Battery,
   *  Overcharger): no die is rolled - the modal goes straight to the
   *  choice. */
  pickOnly?: boolean;
}

/**
 * Supercharger outcome table (both Mind and Body share the same 4
 * outcomes — Light / Medium / Heavy / one-of-each — and the same
 * 1-4 direct + 5-6 "your choice" mapping).
 *
 * Frozen so a stray engine-side mutation can't shift the table.
 */
const SUPERCHARGER_TABLE_OUTCOMES: readonly EquipmentRollOutcome[] = Object.freeze([
  { id: 1, grants: { "damage-2x-light":  2 }, label: "Two 2x LIGHT damage tokens" },
  { id: 2, grants: { "damage-2x-medium": 2 }, label: "Two 2x MEDIUM damage tokens" },
  { id: 3, grants: { "damage-2x-heavy":  2 }, label: "Two 2x HEAVY damage tokens" },
  {
    id: 4,
    grants: {
      "damage-2x-light":  1,
      "damage-2x-medium": 1,
      "damage-2x-heavy":  1,
    },
    label: "One of each (LIGHT + MEDIUM + HEAVY)",
  },
]);

/**
 * Mind Battery (Core Booster Battery) outcome table.
 * Printed text: *"1-2: gain 1 AP token. 3-4: gain 1
 * BLOCK COUNTERATTACK token. 5-6: choice."*
 *
 * The "AP token" outcome maps to a permanent (per-quest) +1 on the
 * recipient's `loadout.baseAp` rather than a consumable-bag grant
 * (post-2026-05-09 unification — see {@link EquipmentRollOutcome}
 * `baseApDelta` jsdoc).
 */
const MIND_BATTERY_OUTCOMES: readonly EquipmentRollOutcome[] = Object.freeze([
  { id: 1, grants: {}, baseApDelta: 1,              label: "+1 AP token" },
  { id: 2, grants: { "prevent-counterattack": 1 },  label: "1 BLOCK COUNTERATTACK token" },
]);

/**
 * Body Battery (Lucky Battery) outcome table.
 * Printed text: *"1-2: gain 1 AP token. 3-4: gain 2 REROLL tokens.
 * 5-6: choice."*
 *
 * Same "AP → +1 baseAp" mapping as {@link MIND_BATTERY_OUTCOMES}.
 */
const BODY_BATTERY_OUTCOMES: readonly EquipmentRollOutcome[] = Object.freeze([
  { id: 1, grants: {}, baseApDelta: 1, label: "+1 AP token" },
  { id: 2, grants: { "reroll": 2 },    label: "2 REROLL tokens" },
]);

/**
 * Registry of every R1+ equipment card carrying
 * `immediately-equipment-roll`. Looked up by card id at
 * `enqueue` / `apply` time. Add a new entry here when shipping the
 * next die-rolling card; no other code needs to change.
 */
const ION_BATTERY_OUTCOMES: readonly EquipmentRollOutcome[] = Object.freeze([
  { id: 1, grants: {}, baseApDelta: 2, label: "2 AP tokens" },
  { id: 2, grants: { "reroll": 2 }, baseApDelta: 1, label: "1 AP & 2 REROLL tokens" },
  { id: 3, grants: { "prevent-counterattack": 1 }, baseApDelta: 1, label: "1 AP & 1 BLOCK 1 COUNTERATTACK token" },
]);

const OVERCHARGER_OUTCOMES: readonly EquipmentRollOutcome[] = Object.freeze([
  { id: 1, grants: { "damage-2x-light": 2 }, label: "Two 2x LIGHT damage tokens" },
  { id: 2, grants: { "damage-2x-medium": 2 }, label: "Two 2x MEDIUM damage tokens" },
  { id: 3, grants: { "damage-2x-heavy": 2 }, label: "Two 2x HEAVY damage tokens" },
]);

const ALL_CHOICE: DieFaceMap = ["choice", "choice", "choice", "choice", "choice", "choice"];

/** Machinist upgrade cards (Nov 15): "choose 1" Immediately effects. The
 *  upgrade ids are suit-prefixed (`mind-upgrade-...`), one table per suit. */
const UPGRADE_CHOICE_TABLES: Record<string, EquipmentRollTable> = Object.fromEntries(
  (["mind", "body"] as const).flatMap((suit) => [
    [`${suit}-upgrade-ion-battery-r1`, { cardId: `${suit}-upgrade-ion-battery-r1`, cardName: "Ion Battery", outcomes: ION_BATTERY_OUTCOMES, rollMap: ALL_CHOICE, pickOnly: true }],
    [`${suit}-upgrade-overcharger-r1`, { cardId: `${suit}-upgrade-overcharger-r1`, cardName: "Overcharger", outcomes: OVERCHARGER_OUTCOMES, rollMap: ALL_CHOICE, pickOnly: true }],
  ]),
);

export const EQUIPMENT_ROLL_TABLES: Readonly<Record<string, EquipmentRollTable>> = Object.freeze({
  ...UPGRADE_CHOICE_TABLES,
  "mind-supercharger-r1": {
    cardId: "mind-supercharger-r1",
    cardName: "Reflex Supercharger",
    outcomes: SUPERCHARGER_TABLE_OUTCOMES,
    rollMap: [1, 2, 3, 4, "choice", "choice"],
  },
  "body-supercharger-r1": {
    cardId: "body-supercharger-r1",
    cardName: "Spinejack Supercharger",
    outcomes: SUPERCHARGER_TABLE_OUTCOMES,
    rollMap: [1, 2, 3, 4, "choice", "choice"],
  },
  "mind-battery-r1": {
    cardId: "mind-battery-r1",
    cardName: "Core Booster Battery",
    outcomes: MIND_BATTERY_OUTCOMES,
    // 1-2 → outcome 1 (AP), 3-4 → outcome 2 (Prevent), 5-6 → choice.
    rollMap: [1, 1, 2, 2, "choice", "choice"],
  },
  "body-battery-r1": {
    cardId: "body-battery-r1",
    cardName: "Lucky Battery",
    outcomes: BODY_BATTERY_OUTCOMES,
    // 1-2 → outcome 1 (AP), 3-4 → outcome 2 (Reroll), 5-6 → choice.
    rollMap: [1, 1, 2, 2, "choice", "choice"],
  },
});

/**
 * Look up the per-card outcome table for an equipment card id.
 * Returns `null` for cards with no table registered (i.e. cards
 * that don't carry `immediately-equipment-roll`).
 */
export function equipmentRollTableForCard(cardId: string): EquipmentRollTable | null {
  return EQUIPMENT_ROLL_TABLES[cardId] ?? null;
}

/**
 * Translate a d6 result (1-6) against a card's roll map into either
 * the directly-granted outcome OR `"choice"` (player still picks).
 * Returns `null` when the roll is out of the 1-6 range — defensive
 * guard for malformed callers.
 */
export function outcomeForRoll(
  table: EquipmentRollTable,
  roll: number,
): EquipmentRollOutcome | "choice" | null {
  if (roll < 1 || roll > 6) return null;
  const mapped = table.rollMap[roll - 1];
  if (mapped === "choice") return "choice";
  return table.outcomes.find((o) => o.id === mapped) ?? null;
}

// --- Equipment die-roll queue -----------------------------------------

/**
 * Push a new pending equipment die roll for the named delver.
 * Called from `applyLevelUpChoice` the moment a card carrying
 * `immediately-equipment-roll` is gained OR ranked up — one roll per
 * rank tier gained (designer ruling 2026-07-20: every printed rank
 * card R1-R5 carries the roll text, so each rank gives 1 benefit;
 * an Ultra +2 enqueues 2 rolls).
 *
 * Throws when the cardId has no registered roll table — that's a
 * data bug (effect was added to a card without registering its
 * outcomes) and we want to fail loud rather than silently swallow.
 *
 * No-op when `state.encounter` is null (defensive: the player
 * shouldn't be able to gain equipment outside an encounter, but the
 * function refuses silently rather than throwing).
 */
export function enqueueEquipmentRoll(
  state: CampaignState,
  heroId: string,
  cardId: string,
): void {
  const enc = state.encounter;
  if (!enc) return;
  if (!equipmentRollTableForCard(cardId)) {
    throw new Error(
      `enqueueEquipmentRoll: card ${cardId} has no registered roll table`,
    );
  }
  enc.pendingEquipmentRolls.push({ heroId, cardId });
}

/**
 * Enqueue IMMEDIATELY equipment rolls (Supercharger / Battery) for
 * every delver who owns rank ≥ 1 of a roll-carrying equipment at
 * the start of a quest. Idempotent: once `questId` is in
 * `state.equipmentRollsAppliedQuests`, this is a no-op.
 *
 * Must be called AFTER an encounter has been built (the rolls land
 * on `enc.pendingEquipmentRolls`) and AFTER shop quest-grants have
 * been applied (so shop-bought Supercharger/Battery rank bumps are
 * already in `state.equipmentRanks` before we check them).
 *
 * Called from `encounter.ts > ensureEncounter / resetEncounter /
 * bootstrapWaveAtNumber`. The idempotency flag makes waves 2+
 * automatically a no-op within the same quest.
 */
export function applyEquipmentRollsForQuest(
  state: CampaignState,
  questId: string,
): void {
  if (state.equipmentRollsAppliedQuests.includes(questId)) return;
  const enqueued: Array<{ heroId: string; cardId: string }> = [];
  for (const heroId of Object.keys(state.loadouts)) {
    for (const type of Object.keys(state.equipmentRanks[heroId] ?? {}) as EquipmentType[]) {
      // Variant-aware: a Machinist upgrade (Ion Battery, Overcharger)
      // replaces the standard card, so look up the card this delver
      // actually plays for the type.
      const cardId = rollCardIdFor(state, heroId, type);
      if (!cardId) continue;
      const rank = state.equipmentRanks[heroId]?.[type] ?? 0;
      // One roll PER RANK, not per card — every rank tier of a
      // roll-carrying card grants 1 benefit roll (designer ruling
      // 2026-07-20, matching the per-rank enqueue in
      // `levelUp.ts > applyLevelUpChoice`). A picked hero card that
      // starts Battery at R2 (or a shop +1 on top of a starter R1)
      // therefore rolls twice at quest start.
      for (let i = 0; i < rank; i++) {
        enqueueEquipmentRoll(state, heroId, cardId);
        enqueued.push({ heroId, cardId });
      }
    }
  }
  state.equipmentRollsAppliedQuests.push(questId);
  logEvent("engine.equipmentRolls.quest.enqueued", {
    questId,
    count: enqueued.length,
    rolls: enqueued,
  });
}

/**
 * The R1 card id whose roll table applies to `heroId`'s `type` - the
 * Machinist upgrade's when one replaced the standard card - or null when
 * the card has no "Immediately" roll/choice.
 */
export function rollCardIdFor(state: CampaignState, heroId: string, type: EquipmentType): string | null {
  let card;
  try { card = getEquipmentCardFor(state, heroId, type, 1); } catch { return null; }
  if (!(card.effects ?? []).some((e) => e.kind === "immediately-equipment-roll")) return null;
  return equipmentRollTableForCard(card.id) ? card.id : null;
}

/**
 * True iff `state.encounter.pendingEquipmentRolls` has at least
 * one entry waiting on a player decision. Mirrors
 * `hasPendingElementChoices`. Drives:
 *   - `screens/ActionResolution.advanceAfterAction` (post-action queue)
 *   - `screens/LevelUpModal.onPickChoice` (between Level-Up draws)
 *   - End-Turn button gating (see `BoardScreen.canEndTurn`)
 */
export function hasPendingEquipmentRolls(state: CampaignState): boolean {
  return (state.encounter?.pendingEquipmentRolls.length ?? 0) > 0;
}

/**
 * Head of the pending equipment-roll queue, or `null` if empty.
 * Mirrors `peekNextPendingElementChoice`.
 */
export function peekNextPendingEquipmentRoll(
  state: CampaignState,
): import("../state").PendingEquipmentRoll | null {
  const enc = state.encounter;
  if (!enc || enc.pendingEquipmentRolls.length === 0) return null;
  return enc.pendingEquipmentRolls[0]!;
}

/**
 * Resolve the head-of-queue pending equipment roll for `heroId`
 * by granting the tokens listed in `outcome` and popping the entry.
 * Returns the outcome that was applied (for UI / log) or `null` if
 * there was no matching pending entry (defensive: stale UI click
 * after a refresh, etc.).
 *
 * Order: pops the FIRST pending entry for `heroId` (FIFO within the
 * same delver) — multiple cards gained in a single level-up batch
 * resolve oldest-first.
 */
export function applyEquipmentRoll(
  state: CampaignState,
  heroId: string,
  outcome: EquipmentRollOutcome,
): EquipmentRollOutcome | null {
  const enc = state.encounter;
  if (!enc) return null;
  const idx = enc.pendingEquipmentRolls.findIndex((p) => p.heroId === heroId);
  if (idx < 0) return null;
  enc.pendingEquipmentRolls.splice(idx, 1);
  for (const kind of Object.keys(outcome.grants) as ConsumableTokenKind[]) {
    grantToken(state, heroId, kind, outcome.grants[kind] ?? 0);
  }
  // Battery's "AP" outcome (post-2026-05-09 unification): bump
  // baseAp by the delta AND top up currentAp by the same amount so
  // the bonus AP is usable THIS wave (not just at the next
  // End Wave refresh). Mirrors how the old `grants: { "ap": 1 }`
  // path landed an immediately-spendable token.
  if (outcome.baseApDelta && outcome.baseApDelta > 0) {
    const lo = state.loadouts[heroId];
    if (lo) {
      lo.baseAp += outcome.baseApDelta;
      lo.currentAp += outcome.baseApDelta;
    }
  }
  return outcome;
}

// --- Internal ----------------------------------------------------------

function ensureBag(state: CampaignState, heroId: string): ConsumableTokenBag {
  if (!state.consumableTokens[heroId]) state.consumableTokens[heroId] = {};
  return state.consumableTokens[heroId]!;
}

// Import-keepalive for the typed DD list (re-exported elsewhere as
// the canonical source for which kinds are spend-on-attack candidates).
void TYPED_DOUBLE_DAMAGE_KINDS;
