/**
 * Kill resolution — what happens when an enemy dies.
 *
 * Per the rulebook (p23 "Gaining XP and Monster Parts"):
 *
 *   1. The dying enemy's Counter Attack has already been resolved by the
 *      caller (this module assumes the death is already final).
 *   2. Both players gain the listed XP. XP is a SHARED pool (DESIGN.md §2).
 *   3. On-death rewards (drops + element gains + level-up cards owed)
 *      are applied. Drops are placed on the enemy's tile and collected
 *      later by walking onto it; v1 just records the count per player.
 *   4. After ALL kills from a single attack are resolved, the caller
 *      should run `resolvePendingLevelUps` from xp.ts to spend XP into
 *      levels (rulebook p24 "Resolving Multiple Dead Enemies" step 4).
 *
 * Multi-kill ordering (rulebook p24): the CALLER is responsible for
 * iterating through dead enemies one at a time in the right order:
 *   - roll + apply each enemy's counter-attack first (combat.ts will own
 *     this once written),
 *   - then resolve on-death drops one card at a time (this module),
 *   - then check for level-ups (xp.ts).
 *
 * Today this is the single entry point for kill bookkeeping.
 */

import { isStolenCard } from "./questAbilities";
import type { CampaignState } from "../state";
import { getEffectiveEquipmentRanks, getEquipmentCardFor } from "../state";
import type { EnemyCard, Element, EquipmentType } from "../types";
import { resolvePendingLevelUps } from "../xp";
import { enqueueLevelUpDraws } from "./levelUp";
import { enqueueElementChoice } from "./os";
import { getDelverBoard, getEquipmentByTypeSuit, getEquipmentByTypeSuitRank, getHero, getQuestData } from "../data";
import { runTownVisitAction } from "./townVisit";
import { logEvent } from "../debug/sessionLog";

/**
 * Cap for element tokens per delver per element type.
 * Rulebook p17: *"Players can only hold 2 of each element token, so any
 * earned beyond that cannot be gained."*
 */
export const ELEMENT_CAP_PER_DELVER = 2;

/** What actually happened when one element grant was attempted. */
export interface ElementGrantOutcome {
  heroId: string;
  element: Element;
  /** Did the token actually land? `false` means cap-overflow → discarded. */
  granted: boolean;
  /** New per-element count for this delver after the attempt. */
  newTotal: number;
}

/**
 * Grant `+1 element` to a single delver, enforcing the per-element cap of
 * 2 (rulebook p17). If the delver is already at the cap, the token is
 * silently discarded (rulebook says it "cannot be gained").
 *
 * Single source of truth — used by `applyKill` (on-death `gainElements`)
 * AND by `engine/slotAbilities.ts > resolveGainElement` (slot-ability
 * `gain-element` kind).
 */
export function grantElementToDelver(
  state: CampaignState,
  heroId: string,
  element: Element,
): ElementGrantOutcome {
  const bag = state.elements[heroId] ?? {};
  const before = bag[element] ?? 0;
  if (before >= ELEMENT_CAP_PER_DELVER) {
    state.elements[heroId] = bag;
    // Log the cap-overflow attempt too — silent discards are the kind
    // of thing that produces "I should have had 2 of X by now" bug
    // reports, so the trace needs to show that the system *saw* the
    // grant and dropped it on cap.
    logEvent("engine.grantElement", { heroId, element, granted: false, newTotal: before });
    return { heroId, element, granted: false, newTotal: before };
  }
  bag[element] = before + 1;
  state.elements[heroId] = bag;
  // Snapshot the post-grant count BEFORE the auto-refresh check —
  // `newTotal` is the "what landed" signal that UI breakdowns use
  // (e.g., "Earth 1 → 2"). If the auto-refresh fires immediately
  // afterwards and drains the bag back to 0, that's a SEPARATE
  // state mutation; conflating it into `newTotal` would produce
  // the surprising `granted: true, newTotal: 0` result that
  // looks like a contradiction to a caller logging the grant.
  const newTotal = bag[element]!;
  logEvent("engine.grantElement", { heroId, element, granted: true, newTotal });
  // DESIGN.md §4.3.2 (auto-refresh-on-element-gain, 2026-05-09): the
  // placement-time auto-refresh in `engine/turn.ts > playWeaponCard`
  // is symmetric with this gain-time path. The rule "2 matching
  // elements + placed weapon = consume both, return weapon to hand"
  // is order-independent: it must fire whether the 2nd token arrives
  // BEFORE placement (handled there) or AFTER placement (handled
  // here). User repro 2026-05-09: placed beam in mind earth slot
  // with earth=1, then earth was granted on the OTHER delver's
  // turn (kill drop) and the slot kept the weapon + 2 earth tokens
  // — an illegal state the printed-board well capacity (2) forbids.
  // Calling unconditionally after a successful grant covers all
  // entry points (applyKill, slotAbilities resolveGainElement,
  // shieldQueue elements, etc.) without re-plumbing each call site.
  maybeAutoRefreshOnElementGain(state, heroId, element);
  return { heroId, element, granted: true, newTotal };
}

/**
 * Symmetric counterpart to the placement-time auto-refresh in
 * `engine/turn.ts > playWeaponCard`: if the just-completed grant
 * brings this delver to {@link ELEMENT_CAP_PER_DELVER} of `element`
 * AND a weapon is currently sitting in the matching printed slot,
 * the rule fires NOW — both tokens are spent and the weapon returns
 * to the delver's hand. See DESIGN.md §4.3.2.
 *
 * Scoped strictly to `heroId`: only that delver's bag/slots are read
 * or mutated, so a kill-drop that grants `+1 earth` to BOTH delvers
 * during one delver's turn produces an independent decision per
 * delver (each may or may not auto-refresh).
 *
 * `cardPlacedThisTurn.autoRefreshedElement`: if the affected slot
 * was placed THIS turn by THIS delver, the latch is upgraded from
 * `null` to `element` so a subsequent `undoWeaponPlacement`
 * restores the 2 spent tokens (mirroring the placement-time path).
 * For the more common case — the gain fires on the OTHER delver's
 * turn or after this delver has used their action — undo is already
 * gated off by `actionUsedThisTurn`, so the latch upgrade is a
 * no-op. (Movement is NOT a gate as of 2026-05-22; the latch upgrade
 * is still correct for the active-delver-before-action case, which
 * now includes "after movement, before action".)
 *
 * No-ops when:
 *   - bag isn't yet at cap (e.g., 0 → 1 grants),
 *   - the printed matching slot is empty (no placed weapon),
 *   - or the loadout is missing (defensive).
 */
function maybeAutoRefreshOnElementGain(
  state: CampaignState,
  heroId: string,
  element: Element,
): void {
  const bag = state.elements[heroId] ?? {};
  if ((bag[element] ?? 0) < ELEMENT_CAP_PER_DELVER) return;
  const loadout = state.loadouts[heroId];
  if (!loadout) return;
  const board = getDelverBoard(getHero(heroId).suit);
  // Each element appears on exactly one weapon slot per board, so the
  // first match is the only match — no need to keep scanning.
  for (let slotIdx = 0; slotIdx < board.weaponSlots.length; slotIdx++) {
    const slot = board.weaponSlots[slotIdx];
    if (!slot || slot.element !== element) continue;
    const cardId = loadout.slotCards[slotIdx];
    if (!cardId) return;
    // Ch4 Steals: the stolen card can't be refreshed.
    if (isStolenCard(state, heroId, cardId)) return;
    bag[element] = (bag[element] ?? 0) - ELEMENT_CAP_PER_DELVER;
    state.elements[heroId] = bag;
    loadout.slotCards[slotIdx] = null;
    // If THIS delver placed THIS slot's card on THIS turn, upgrade
    // the latch so undo restores the now-spent elements.
    const ts = state.encounter?.turnState[heroId];
    if (ts?.cardPlacedThisTurn?.slotIdx === slotIdx) {
      ts.cardPlacedThisTurn.autoRefreshedElement = element;
    }
    logEvent("engine.spendElement", {
      heroId,
      element,
      reason: "weapon-auto-refresh-on-gain",
      cardId,
      slotIdx,
      newTotal: bag[element],
    });
    return;
  }
}

/** Per-kill accounting summary the UI can use for toasts / logs. */
export interface KillResult {
  enemyId: string;
  /** Total XP credited to the shared pool — INCLUDES any Providence
   *  OS bonus (`bonus-xp-on-kill`). See `xpBonusFromPassives` for
   *  the breakdown. */
  xpGained: number;
  /** Bonus XP added on top of the printed `enemy.onDeath.gainXp` by
   *  passive equipment (currently: Providence OS). 0 if no living
   *  bearer owns a `bonus-xp-on-kill` passive, or if the enemy
   *  granted no XP to begin with (the bonus is conditional on the
   *  underlying grant). Useful for UI toasts that want to break
   *  out "+1 (Providence OS)" alongside the printed amount. */
  xpBonus: number;
  /** Per-player drops added; key = drop token id. */
  dropsByPlayer: Record<string, Record<string, number>>;
  /** Element tokens the enemy *printed* as on-death rewards (both
   *  delvers attempt to gain). Includes elements that were dropped due
   *  to the per-delver cap of 2 — see `elementGrants` for the
   *  per-delver landed/lost breakdown. */
  elementsGranted: string[];
  /** Per-delver, per-element outcome of the on-death element grants
   *  (one entry per (heroId, element)). Lets the UI report which
   *  tokens actually landed vs which overflowed past the cap. */
  elementGrants: ElementGrantOutcome[];
  /** Player-facing XP die rolls enqueued from `onDeath.gainXpDice`
   *  ("Gain 1 [die] XP" — Ophidian 017 / Sporecloud 022). Resolved
   *  later via {@link applyXpRoll} once the player rolls in the
   *  `xp-roll` modal; NOT included in `xpGained`. */
  xpRollsEnqueued: number;
  /** Number of "Level Up cards owed" added to each player. */
  levelUpCardsAdded: number;
  /** Interactive Level-Up draws actually enqueued onto
   *  `encounter.pendingLevelUpDraws` for the printed
   *  `gainLevelUpCards` reward (one per card × delver — see
   *  `applyKill` step 4). Normally `levelUpCardsAdded × 2`; lower if
   *  the deck ran dry mid-enqueue. */
  levelUpDrawsEnqueued: number;
}

/**
 * Sum of `bonus-xp-on-kill` amounts contributed by every LIVING
 * delver who owns a passive equipment carrying that effect (currently
 * only Providence OS — Mind R1, +1).
 *
 *   alive gate (per design decision 2026-05-04): a downed bearer
 *     can't run their passive scan — `currentHp <= 0` disables the
 *     bonus. Mirrors the rulebook's general "the passive needs the
 *     delver to be functional" read; consistent with how a 0-HP
 *     delver's other on-state effects (movement, action) are gated.
 *
 *   stacking: bonuses sum across delvers, so a hypothetical state
 *     where both delvers own a `bonus-xp-on-kill` passive (e.g. a
 *     future R2 Providence on body-side) would credit each of them.
 *     Today only the Mind delver can own Providence so the practical
 *     ceiling is +1.
 *
 *   short-circuit: returns 0 if `printedXp <= 0`. Card text says
 *     "Enemies that grant XP grant 1 additional XP" — the bonus is
 *     conditional on the enemy being an XP source to begin with.
 */
export function xpBonusFromPassives(
  state: CampaignState,
  printedXp: number,
): number {
  if (printedXp <= 0) return 0;
  let bonus = 0;
  for (const heroId of Object.keys(state.loadouts)) {
    const lo = state.loadouts[heroId];
    if (!lo || lo.currentHp <= 0) continue;
    // Effective ranks so a Xavier +1 bump that lifts a Harvester
    // from R0 -> R1 actually fires its `bonus-xp-on-kill` passive
    // for the duration of the quest.
    const ranks = getEffectiveEquipmentRanks(state, heroId);
    const hero = getHero(heroId);
    for (const type of Object.keys(ranks) as EquipmentType[]) {
      const rank = ranks[type] ?? 0;
      if (rank < 1) continue;
      // RANK-CORRECT card (2026-07-22): Providence OS prints
      // +1/+2/+3/+4/+5 bonus XP per rank — pre-fix this read the R1
      // card and every rank granted +1.
      try {
        const card = getEquipmentCardFor(state, heroId, type, rank);
        if (card.category !== "passive") continue;
        for (const eff of card.effects ?? []) {
          if (eff.kind === "bonus-xp-on-kill") {
            bonus += eff.amount;
          }
        }
      } catch {
        // (suit, type) pair without a known R1 card — should be
        // impossible given the dataset, but skip silently if so to
        // avoid crashing kill resolution on a data bug.
      }
    }
  }
  return bonus;
}

/**
 * Apply the on-death effects of a single enemy to `state`. Mutates state
 * in place. Does NOT trigger level-ups — the caller resolves all kills
 * first, then calls `applyPendingLevelUps` once.
 *
 * `at` is the dying enemy's tile, used to anchor on-board drops. Caller
 * is responsible for sourcing it from the live `EnemyInstance` (the
 * static `EnemyCard` doesn't carry a position).
 */
export function applyKill(
  state: CampaignState,
  enemy: EnemyCard,
  at: { x: number; y: number },
): KillResult {
  const heroIds = Object.keys(state.loadouts);

  queueBossSlainEntry(state, enemy);

  // 1. XP — shared pool, SAME number to a single shared field. Adds
  // any `bonus-xp-on-kill` from passive equipment owned by a LIVING
  // delver (Providence OS today; see `xpBonusFromPassives` for the
  // alive-gate + stacking rationale). The bonus is conditional on
  // the enemy granting XP to begin with — `xpBonusFromPassives`
  // returns 0 when `printedXp <= 0` so non-XP minions don't get a
  // backdoor bonus.
  const printedXp = enemy.onDeath.gainXp ?? 0;
  const xpBonus = xpBonusFromPassives(state, printedXp);
  const xpGained = printedXp + xpBonus;
  state.xpOnHand += xpGained;
  state.totalXp  += xpGained;

  // 1b. XP DIE rolls — the printed "Gain 1 [die] XP" reward
  // (`onDeath.gainXpDice`; Ophidian 017 / Sporecloud 022). The roll
  // must happen IN FRONT OF the player (designer ruling 2026-07-20 —
  // pre-fix the data flattened this to a silent static 1 XP), so
  // nothing is banked here: one pending roll per printed die goes
  // onto `enc.pendingXpRolls` and the `xp-roll` modal resolves each
  // via `applyXpRoll`. The active delver rolls; XP stays a shared
  // pool.
  const xpDice = enemy.onDeath.gainXpDice ?? 0;
  let xpRollsEnqueued = 0;
  if (xpDice > 0 && state.encounter) {
    for (let i = 0; i < xpDice; i++) {
      state.encounter.pendingXpRolls.push({
        heroId: state.currentDelverId,
        enemyCardId: enemy.id,
      });
      xpRollsEnqueued++;
    }
    logEvent("engine.applyKill.xpRollsEnqueued", {
      enemyId: enemy.id,
      dice: xpDice,
    });
  }

  // 2. Drops — placed on the dying enemy's tile (rulebook p23: drops
  // sit on the tile and are *collected by walking onto it*). The
  // counter on `state.minionParts` / `state.bossParts` does NOT bump
  // here — it bumps in `engine/movement.ts > moveDelver` when the
  // owning delver ends a move on the tile.
  //
  // Per rulebook p23 / DESIGN.md §2, drops are PER-DELVER: every
  // entry in `enemy.onDeath.drops` is owed ONCE PER LIVING DELVER.
  // We push one `TileDrop` per (dropId × living delver) so each
  // delver has their own claimable token sitting on the tile.
  //
  // Drop ID conventions (mirrored by `moveDelver` pickup + the
  // CampaignSheet art lookup):
  //   - `"minion-part"`        → `state.minionParts[heroId] += 1`
  //   - `"boss-part"`          → `state.bossParts[heroId] += 1` (legacy bare id = lvl 1)
  //   - `"boss-part-lvl-<N>"`  → LEVEL-MATCHED wallet via
  //                              `state.ts > creditBossPartDrop` (v58):
  //                              lvl-1 → `bossParts`, lvl-2 → `bossPartsLvl2`,
  //                              lvl-3 → `bossPartsLvl3`. Level routing is what
  //                              lets shop products priced in lvl-2 parts
  //                              (+2 MEDIUM, +4 HEAVY, Cyclone Boots) be paid.
  //
  // Dead-delver skip (design decision 2026-05-04): a delver at
  // `currentHp <= 0` does NOT receive drops, mirroring the
  // dead-bearer gating used by Harvester / Providence / Sol-Lunar
  // Shield. No `TileDrop` is created for them — even if they revive
  // later, parts they were skipped on don't appear retroactively.
  // The alive delver still gets their token.
  //
  // The `dropsByPlayer` map records what was OWED to each living
  // delver (i.e. what TileDrops were created for them) — useful for
  // the UI's per-kill toast. Dead delvers get an empty record.
  const dropsByPlayer: Record<string, Record<string, number>> = {};
  for (const heroId of heroIds) dropsByPlayer[heroId] = {};
  const enc = state.encounter;
  for (const dropId of enemy.onDeath.drops ?? []) {
    for (const heroId of heroIds) {
      const lo = state.loadouts[heroId];
      if (!lo || lo.currentHp <= 0) continue;
      if (enc) enc.tileDrops.push({ x: at.x, y: at.y, heroId, dropId });
      dropsByPlayer[heroId]![dropId] = (dropsByPlayer[heroId]![dropId] ?? 0) + 1;
    }
  }

  // 3. Element tokens — both delvers gain (rulebook p23 + p17). The
  // per-element cap of 2 is enforced inside `grantElementToDelver`;
  // any overflow is silently discarded per p17. The per-delver
  // landed/lost breakdown lives on `result.elementGrants` so the UI
  // can show e.g. "Mind delver: +1 Earth (Body delver: Earth full,
  // overflow lost)".
  const elementsGranted = (enemy.onDeath.gainElements ?? []).map(String);
  const elementGrants: ElementGrantOutcome[] = [];
  for (const element of (enemy.onDeath.gainElements ?? [])) {
    for (const heroId of heroIds) {
      elementGrants.push(grantElementToDelver(state, heroId, element));
    }
  }

  // 3b. "Gain N elements" (Lieutenant B cards): each living delver picks
  // N elements of their choice, through the shared element-choice queue.
  for (let i = 0; i < (enemy.onDeath.gainElementChoice ?? 0); i++) {
    for (const heroId of heroIds) {
      enqueueElementChoice(state, { heroId, source: { kind: "enemy-kill", enemyName: enemy.name } });
    }
  }

  // 4. Level Up cards — the printed "Gain a LEVEL UP card" reward
  // (every quest boss: Soulhunter / Goldmonger / Hundredeyes / Death
  // Cap). Two effects:
  //   a. `state.levelUpCardsOwed` — the campaign-sheet bookkeeping
  //      counter (each player draws their own card, so one printed
  //      card = 1 on the shared counter, same convention as the XP
  //      path in `applyPendingLevelUps`).
  //   b. The ACTUAL interactive draws: one pending LevelUpModal draw
  //      per delver per printed card, pushed onto
  //      `encounter.pendingLevelUpDraws` — the same queue the
  //      XP-threshold path (`applyPendingLevelUps`) and scenario-card
  //      `grant-level-up` effects use, so the existing modal + End
  //      Turn gating pick it up with no extra wiring. Active delver
  //      draws first, mirroring both existing callers.
  //
  // (b) was MISSING pre-2026-07-20 — `gainLevelUpCards` only bumped
  // the bookkeeping counter ("bookkeeping only for v1"), so defeating
  // a boss never actually gave the players their Level Up draws.
  // User report: Soulhunter kill granted no level. Both delvers get a
  // draw regardless of downed state, matching `applyPendingLevelUps`
  // (the dead-delver skip applies to drops/elements, not level-ups).
  const levelUpCardsAdded = enemy.onDeath.gainLevelUpCards ?? 0;
  state.levelUpCardsOwed += levelUpCardsAdded;
  let levelUpDrawsEnqueued = 0;
  if (levelUpCardsAdded > 0) {
    const heroOrder = heroIds.includes(state.currentDelverId)
      ? [state.currentDelverId, ...heroIds.filter((id) => id !== state.currentDelverId)]
      : heroIds;
    for (let i = 0; i < levelUpCardsAdded; i++) {
      levelUpDrawsEnqueued += enqueueLevelUpDraws(state, heroOrder);
    }
    logEvent("engine.applyKill.levelUpCards", {
      enemyId: enemy.id,
      cardsPrinted: levelUpCardsAdded,
      drawsEnqueued: levelUpDrawsEnqueued,
    });
  }

  return {
    enemyId: enemy.id,
    xpGained,
    xpBonus,
    xpRollsEnqueued,
    dropsByPlayer,
    elementsGranted,
    elementGrants,
    levelUpCardsAdded,
    levelUpDrawsEnqueued,
  };
}

// --- XP die rolls (on-death `gainXpDice`) ----------------------------------

/** True iff at least one "Gain 1 [die] XP" roll awaits the player.
 *  Gates End Turn / auto-advance alongside the other pending queues. */
export function hasPendingXpRolls(state: CampaignState): boolean {
  return (state.encounter?.pendingXpRolls.length ?? 0) > 0;
}

/** Head of the pending XP-roll queue, or `null` if empty. Drives the
 *  `xp-roll` modal (who rolls + which enemy card to show). */
export function peekNextPendingXpRoll(
  state: CampaignState,
): import("../state").PendingXpRoll | null {
  const enc = state.encounter;
  if (!enc || enc.pendingXpRolls.length === 0) return null;
  return enc.pendingXpRolls[0]!;
}

/** Outcome summary of one resolved XP die roll. */
export interface XpRollResult {
  /** The face the player rolled (1-6). */
  rolled: number;
  /** Providence OS "+1 XP when an enemy grants XP" bonus, if a
   *  living bearer owns it — the die IS an XP grant, so the passive
   *  applies exactly as it does to printed static XP. */
  xpBonus: number;
  /** Total banked into the shared pool (`rolled + xpBonus`). */
  xpGained: number;
  /** Level-ups the banked XP immediately triggered (each one already
   *  enqueued its per-delver Level-Up draws). */
  levelUps: number;
}

/**
 * Bank one player-rolled XP die: pops the head of
 * `pendingXpRolls`, credits `rolled` (+ any Providence OS bonus) to
 * the shared XP pool, and immediately resolves any level-ups the new
 * XP affords (same `applyPendingLevelUps` the kill path uses, so
 * Level-Up draws queue exactly as if the XP had been printed).
 *
 * Returns `null` when the queue is empty (defensive — the modal
 * shouldn't be open) or the roll is out of the d6 range.
 */
export function applyXpRoll(
  state: CampaignState,
  rolled: number,
): XpRollResult | null {
  const enc = state.encounter;
  if (!enc || enc.pendingXpRolls.length === 0) return null;
  if (!Number.isInteger(rolled) || rolled < 1 || rolled > 6) return null;
  const head = enc.pendingXpRolls.shift()!;
  const xpBonus = xpBonusFromPassives(state, rolled);
  const xpGained = rolled + xpBonus;
  state.xpOnHand += xpGained;
  state.totalXp  += xpGained;
  const levelUps = applyPendingLevelUps(state);
  logEvent("engine.applyXpRoll", {
    heroId: head.heroId,
    enemyCardId: head.enemyCardId,
    rolled,
    xpBonus,
    xpGained,
    levelUps,
    remaining: enc.pendingXpRolls.length,
  });
  return { rolled, xpBonus, xpGained, levelUps };
}

/**
 * Spend XP from `state.xpOnHand` to advance `state.currentLevel` as many
 * times as possible. Each level-up:
 *   1. adds 1 to the bookkeeping `state.levelUpCardsOwed` counter, AND
 *   2. enqueues 2 pending Level-Up draws onto
 *      `state.encounter.pendingLevelUpDraws` — one per delver, in
 *      hero-id order — drawing one card off the deck per entry
 *      (rulebook p24 "each player draws 1 Level Up Card").
 *
 * The pending queue is what the LevelUpModal reads from. End Turn /
 * advance-phase is gated on the queue being empty.
 *
 * Returns the number of level-ups that occurred.
 */
export function applyPendingLevelUps(state: CampaignState): number {
  const r = resolvePendingLevelUps(state.xpOnHand, state.currentLevel);
  state.xpOnHand     = r.xpOnHand;
  state.currentLevel = r.currentLevel;
  state.levelUpCardsOwed += r.levelUps;
  if (r.levelUps > 0 && state.encounter) {
    // Active delver draws first, then the other delver.
    const all = Object.keys(state.loadouts);
    const heroIds = [
      state.currentDelverId,
      ...all.filter((id) => id !== state.currentDelverId),
    ];
    for (let i = 0; i < r.levelUps; i++) enqueueLevelUpDraws(state, heroIds);
    // Living Armor: "When you earn a Level card, delvers on your tile
    // heal N HP." Every delver earns one card per level-up.
    for (let i = 0; i < r.levelUps; i++) applyLevelCardHeals(state);
  }
  return r.levelUps;
}


/** One Level card earned by each delver: Living Armor bearers heal the
 *  living delvers on their tile (themselves included). */
function applyLevelCardHeals(state: CampaignState): void {
  const enc = state.encounter;
  if (!enc) return;
  for (const bearerId of Object.keys(state.loadouts)) {
    const ranks = getEffectiveEquipmentRanks(state, bearerId);
    const rank = ranks.Armor ?? 0;
    if (rank < 1) continue;
    const card = getEquipmentCardFor(state, bearerId, "Armor", rank);
    const heal = (card.effects ?? []).find((e) => e.kind === "heal-tile-on-level-card");
    if (!heal || heal.kind !== "heal-tile-on-level-card") continue;
    const pos = enc.delverPositions[bearerId];
    if (!pos) continue;
    for (const [heroId, p] of Object.entries(enc.delverPositions)) {
      if (p.x !== pos.x || p.y !== pos.y) continue;
      const lo = state.loadouts[heroId];
      if (!lo || lo.currentHp <= 0) continue;
      lo.currentHp = Math.min(lo.maxHp, lo.currentHp + heal.amount);
    }
    logEvent("engine.livingArmor.levelCardHeal", { bearerId, amount: heal.amount });
  }
}

/**
 * Ch3+ `onBossSlain`: when the wave's boss dies, apply the entry's
 * rewards immediately and park the entry on the encounter for the board
 * to present. Fires at most once per wave (the boss only dies once).
 */
function queueBossSlainEntry(state: CampaignState, enemy: EnemyCard): void {
  const enc = state.encounter;
  if (!enc) return;
  const wave = getQuestData(enc.questId).waves.find((w) => w.number === enc.waveNumber);
  if (!wave?.onBossSlain || wave.bossEnemyId !== enemy.id) return;
  const events = (wave.onBossSlain.rewards ?? []).flatMap((a) => runTownVisitAction(state, a));
  enc.pendingQuestEntry = { pageId: wave.onBossSlain.pageId, events };
  logEvent("engine.kills.bossSlainEntry", { questId: enc.questId, wave: enc.waveNumber, pageId: wave.onBossSlain.pageId });
}
