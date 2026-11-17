/**
 * Town Visit engine.
 *
 * Owns the post-wave narrative state machine + Shop transactions.
 * The UI (`screens/TownVisit.ts`, `screens/Shop.ts`) calls these
 * helpers and then hands control back to the router for re-render
 * and persist; nothing here touches the DOM.
 *
 * Page navigation invariants:
 *   - `state.townVisit` is `null` between visits and an object during one.
 *   - On entering a page for the first time within a single visit,
 *     `applyOnEnter` runs that page's `onEnter` actions exactly once;
 *     subsequent re-renders / refreshes of the same page are no-ops.
 *     The dedupe key is `pagesEntered: string[]` on the visit.
 *
 * Shop transaction invariants (see Plan):
 *   - `purchaseShopProduct` debits the buyer's parts (minion + boss-lvl-1)
 *     and atomically removes the product from `shopProductsAvailable`
 *     while pushing it to `shopProductsOwned[heroId]`. Fails (returns
 *     false, no mutation) if the buyer can't afford OR the product is
 *     already gone.
 *   - `convertBossPart` debits 1 boss-lvl-1 and credits 3 minion parts
 *     to the same delver. Fails if the delver has 0 boss parts.
 *   - `transferMinionParts` moves N parts between delvers; fails if the
 *     sender doesn't have enough OR `amount <= 0`.
 *   - `finishTownVisit` flips `townVisit1Completed = true` and clears
 *     `state.townVisit`. The encounter has already been cleared by the
 *     End-of-Wave routing path.
 */

import { clearCombatOnlyGrants } from "./townsfolk";
import { bossWallet, type BossPartLevel, type CampaignState } from "../state";
import type { QuestDeathOutcome, RewardEvent, TownVisitAction, TownVisitChapter, TownVisitChoice, TownVisitCondition } from "../types";
import { getChapter, getHero, getScenarioCard, getShopProduct, HEROES, KEY_ITEMS, LEVEL_DECK, MEMORY_CARDS, opinionCardImageOrNull, opinionLevelsCrossed } from "../data";
import { logEvent } from "../debug/sessionLog";
import { resolveAcademyDonation } from "./academyDonation";
import { enqueueSuitConditionRankPicks } from "./suitConditionGrants";
import { grantFriendlySpawnCard } from "./friendlyEncounter";
import { isShopProductBlockedBySamanthaDetractor } from "./opinionPenalty";
import { floresPaysBossPartsInMinion, gainMemoryChips, heldPositiveCardCount, holdsOpinionCard, isShopProductBlockedBySamanthaNemesis, opinionLevelForValue, opinionShopMinionAdjust, positiveCardLimit } from "./opinionEffects";
import { shuffle } from "../util/random";

/**
 * Snapshot of every wallet + shop ledger field — small, JSON-clean,
 * cheap to compute. Emitted alongside every engine event in this
 * module so a single log row tells you what the player's economy
 * looked like at the moment of the event without forcing the reader
 * to scan back through history.
 *
 * NOTE: kept inline (rather than promoted to `debug/sessionLog.ts`)
 * because every field here is town-visit-specific. Promoting it
 * would force `sessionLog` to import shop data which would create a
 * weird "infrastructure depends on game data" cycle.
 */
function snapWallets(state: CampaignState): {
  minion: Record<string, number>;
  boss: Record<string, number>;
  bossLvl2: Record<string, number>;
  bossLvl3: Record<string, number>;
  bossLvl4: Record<string, number>;
  bossLvl5: Record<string, number>;
  available: number[];
  owned: Record<string, number[]>;
  memoryChips: number;
} {
  return {
    minion: { ...state.minionParts },
    boss: { ...state.bossParts },
    bossLvl2: { ...state.bossPartsLvl2 },
    bossLvl3: { ...state.bossPartsLvl3 },
    bossLvl4: { ...state.bossPartsLvl4 },
    bossLvl5: { ...state.bossPartsLvl5 },
    available: state.shopProductsAvailable.slice(),
    owned: Object.fromEntries(
      Object.entries(state.shopProductsOwned).map(([k, v]) => [k, v.slice()]),
    ),
    memoryChips: state.memoryChips,
  };
}

function snapVisit(state: CampaignState): { chapterId: string; pageId: string; pagesEntered: number } | null {
  const v = state.townVisit;
  if (!v) return null;
  return { chapterId: v.chapterId, pageId: v.pageId, pagesEntered: v.pagesEntered.length };
}

/** Begin a chapter's town visit. Idempotent — no-op if already in one. */
export function startTownVisit(state: CampaignState, chapterId: TownVisitChapter["id"]): void {
  if (state.townVisit) {
    logEvent("engine.startTownVisit.skip", { reason: "already-in-visit", visit: snapVisit(state) });
    return;
  }
  const chapter = getChapter(chapterId);
  state.townVisit = {
    chapterId,
    pageId: chapter.startPageId,
    pagesEntered: [],
  };
  logEvent("engine.startTownVisit", {
    chapterId,
    startPageId: chapter.startPageId,
    wallets: snapWallets(state),
  });
}

/**
 * Resolve the current page from the active visit + chapter data.
 * Returns `null` if there is no active visit OR the recorded
 * `pageId` doesn't exist in the chapter (defensive — the latter
 * would be a data bug).
 */
export function currentTownVisitPage(state: CampaignState) {
  const visit = state.townVisit;
  if (!visit) return null;
  const chapter = getChapter(visit.chapterId);
  const page = chapter.pages[visit.pageId];
  if (!page) return null;
  return { chapter, page, visit };
}

/**
 * Filter a page's choices down to the ones the screen would
 * actually render given the current campaign state. Applies the
 * same gating logic as `screens/TownVisit.ts > renderTownVisit`:
 *
 *   - `hideIfDecisionMade`: hide the choice if the recorded
 *     decision key is already in `state.townDecisions`.
 *   - `requireStoryTokens: "positive"`: hide when
 *     `storyTokens <= 0`.
 *   - `requireStoryTokens: "zero"`: hide when `storyTokens > 0`.
 *
 * Exported for the QA harness (so the chapter walker doesn't
 * click invisible buttons) AND as a future call site for the
 * screen — today the screen open-codes the same logic inline,
 * which is a future refactor target.
 *
 * Returns an empty array when there's no active visit or no
 * page choices.
 */
export function visibleTownVisitChoices(
  state: CampaignState,
): ReadonlyArray<{ readonly decisionKey: string; readonly next?: string }> {
  const ctx = currentTownVisitPage(state);
  if (!ctx) return [];
  const choices = ctx.page.choices ?? [];
  return choices.filter((c) => {
    if (c.hideIfDecisionMade && state.townDecisions.includes(c.hideIfDecisionMade)) {
      return false;
    }
    if (c.showIfDecision && !state.townDecisions.includes(c.showIfDecision)) return false;
    if (c.requireStoryTokens === "positive" && state.storyTokens <= 0) return false;
    if (c.requireStoryTokens === "zero" && state.storyTokens > 0) return false;
    if (!questDeathsMatch(state, c)) return false;
    return true;
  });
}

/**
 * Who died on the last quest, from `state.lastQuestDeaths` (recorded by
 * `enterEndOfWave` on a defeat). `null` = no quest recorded yet (fresh
 * campaign / pre-v64 save) — the death gates then stay open.
 */
export function lastQuestDeathOutcome(state: CampaignState): QuestDeathOutcome | null {
  const rec = state.lastQuestDeaths;
  if (!rec) return null;
  const mindDied = rec.heroIds.includes("hero-01");
  const bodyDied = rec.heroIds.includes("hero-02");
  if (mindDied && bodyDied) return "both";
  if (mindDied) return "mind-only";
  if (bodyDied) return "body-only";
  return "none";
}

/** Does `choice.requireQuestDeaths` (if any) match the last quest? Open
 *  (true) when the choice has no gate or no quest has been recorded. */
export function questDeathsMatch(state: CampaignState, choice: TownVisitChoice): boolean {
  const required = choice.requireQuestDeaths;
  if (!required) return true;
  const outcome = lastQuestDeathOutcome(state);
  if (outcome === null) return true;
  if (required === "any") return outcome !== "none";
  return required === outcome;
}

/**
 * Result of an `applyOnEnter` call.
 *
 * `ran`     - did the action loop actually execute (i.e. is this
 *             the first time the current page has been entered
 *             during this visit)? Drives the caller's "persist?"
 *             decision: every first-entry persists, every
 *             subsequent re-render skips.
 * `events`  - player-visible RewardEvents emitted by the actions
 *             that ran. Empty when `ran=false` AND when `ran=true`
 *             with only silent bookkeeping (record-decision)
 *             actions. Drives "show rewards modal?".
 */
export interface ApplyOnEnterResult {
  ran: boolean;
  events: RewardEvent[];
}

/**
 * Fire the current page's `onEnter` actions exactly once per visit.
 * Idempotent: if the page id is already in `pagesEntered`, returns
 * `{ ran: false, events: [] }` and skips. Otherwise returns the
 * `RewardEvent[]` produced by the actions that ran — used by the
 * UI to show the rewards modal.
 *
 * The UI's render loop calls this on every render, but the dedupe
 * means side-effects (minion-part grants, decision recording, shop
 * product population, hero-card unlocks) only happen once per
 * page-entry.
 *
 * Pre-2026-05-18 this returned a bare `boolean` (whether anything
 * ran). The richer `{ ran, events }` shape was added so the rewards
 * modal can render the per-action events while the caller still
 * has a clean "first entry?" signal for its persist decision.
 */
export function applyOnEnter(state: CampaignState): ApplyOnEnterResult {
  const ctx = currentTownVisitPage(state);
  if (!ctx) return { ran: false, events: [] };
  const { page, visit } = ctx;
  if (visit.pagesEntered.includes(visit.pageId)) {
    logEvent("engine.applyOnEnter.skip", {
      reason: "already-entered",
      pageId: visit.pageId,
    });
    return { ran: false, events: [] };
  }
  visit.pagesEntered.push(visit.pageId);
  const actions = page.onEnter ?? [];
  logEvent("engine.applyOnEnter", {
    pageId: visit.pageId,
    pageKind: page.kind,
    actionCount: actions.length,
    actionKinds: actions.map((a) => a.kind),
    walletsBefore: snapWallets(state),
  });
  const events: RewardEvent[] = [];
  for (const action of actions) {
    const ev = runAction(state, action);
    if (ev) events.push(...ev);
  }
  logEvent("engine.applyOnEnter.done", {
    pageId: visit.pageId,
    rewardEventCount: events.length,
    rewardEventKinds: events.map((e) => e.kind),
    walletsAfter: snapWallets(state),
  });
  return { ran: true, events };
}

/**
 * Apply a single on-enter action's side-effects and return any
 * player-visible RewardEvents it produced (empty array if the
 * action is silent bookkeeping like `record-decision`).
 *
 * Returning `RewardEvent[]` (vs the older `void`) lets `applyOnEnter`
 * collect every grant from a multi-action page (e.g. page 6 grants
 * heroes #3+#4 AND records a decision; only the unlock surfaces).
 */
/**
 * Apply a single `TownVisitAction` against the campaign state and
 * return the `RewardEvent[]` it produced. Exported primarily so
 * unit tests can exercise individual actions (especially
 * `shift-favour` -> Vera Ally shield interception) without
 * round-tripping through `startTownVisit` + a custom chapter
 * graph. Production callers should normally use `applyOnEnter`
 * which fires the current page's full action list with the
 * "already-entered" dedupe.
 */
export function runTownVisitAction(state: CampaignState, action: TownVisitAction): RewardEvent[] {
  return runAction(state, action);
}

/**
 * Sum of all clue token icons across the campaign's currently-owned
 * Key Items. Used to gate conditional shop products (#13 unlocks at
 * 2+ clues, #14 at 4+) and displayed on the Campaign Sheet.
 *
 * Reads `clues` directly off each `KeyItemRecord` (snapshotted at
 * gain time) so a mid-campaign catalog correction doesn't silently
 * shift gate totals.
 */
export function totalKeyItemClues(state: CampaignState): number {
  return state.keyItems.reduce((sum, k) => sum + (k.clues ?? 1), 0);
}

/** Open Quests = revealed quests the party hasn't completed yet. */
export function openQuestCount(state: CampaignState): number {
  return state.revealedQuests.filter((q) => !state.completedQuests.includes(q.number)).length;
}

/** Evaluate an `if` action's predicate. */
export function evaluateTownVisitCondition(state: CampaignState, cond: TownVisitCondition): boolean {
  switch (cond.kind) {
    case "decision-made": return state.townDecisions.includes(cond.key);
    case "quest-completed": return state.completedQuests.includes(cond.number);
    case "favour-at-least": return (state.favour[cond.characterId]?.value ?? 0) >= cond.min;
    case "clues-at-least": return totalKeyItemClues(state) >= cond.min;
    case "owns-opinion-card": return state.opinionCards.some(
      (c) => c.characterId === cond.characterId && c.level === cond.level,
    );
    case "open-quests-at-least": return openQuestCount(state) >= cond.min;
    case "owns-key-item": return state.keyItems.some((k) => k.number === cond.number);
    case "story-counter-at-least": return (state.storyCounters[cond.key] ?? 0) >= cond.min;
  }
}

function runAction(state: CampaignState, action: TownVisitAction): RewardEvent[] {
  switch (action.kind) {
    case "record-decision": {
      state.townDecisions.push(action.key);
      logEvent("engine.onEnter.record-decision", { key: action.key });
      return [];
    }
    case "grant-minion-parts": {
      const recipients = action.to === "all-delvers"
        ? Object.keys(state.minionParts)
        : [state.currentDelverId];
      const breakdown: { heroId: string; before: number; after: number }[] = [];
      for (const heroId of recipients) {
        const before = state.minionParts[heroId] ?? 0;
        const after = before + action.amount;
        state.minionParts[heroId] = after;
        breakdown.push({ heroId, before, after });
      }
      logEvent("engine.onEnter.grant-minion-parts", {
        amount: action.amount,
        to: action.to,
        recipients,
      });
      // Suppress the visual if amount is non-positive (defensive —
      // data should never author this, but a zero-amount grant
      // would be a confusing "+0" card in the modal).
      if (action.amount <= 0 || breakdown.length === 0) return [];
      return [{
        kind: "creature-parts-changed",
        partKind: "minion",
        direction: "gain",
        recipients: breakdown,
      }];
    }
    case "lose-minion-parts": {
      const recipients = action.to === "all-delvers"
        ? Object.keys(state.minionParts)
        : [state.currentDelverId];
      const breakdown: { heroId: string; before: number; after: number }[] = [];
      for (const heroId of recipients) {
        const before = state.minionParts[heroId] ?? 0;
        const after = Math.max(0, before - action.amount);
        state.minionParts[heroId] = after;
        // Only emit a card for recipients who ACTUALLY lost a part —
        // a clamp-to-zero "you tried to lose 1 but had 0" is silent.
        if (after !== before) breakdown.push({ heroId, before, after });
      }
      logEvent("engine.onEnter.lose-minion-parts", {
        amount: action.amount,
        to: action.to,
        recipients,
        emittedRecipients: breakdown.map((b) => b.heroId),
      });
      if (breakdown.length === 0) return [];
      return [{
        kind: "creature-parts-changed",
        partKind: "minion",
        direction: "loss",
        recipients: breakdown,
      }];
    }
    case "grant-memory-chip": {
      // Elias Nemesis blocks every gain (see `gainMemoryChips`).
      const gained = gainMemoryChips(state, action.amount);
      logEvent("engine.onEnter.grant-memory-chip", {
        amount: action.amount,
        gained,
        memoryChipsAfter: state.memoryChips,
      });
      if (gained <= 0) return [];
      return [{
        kind: "memory-chips-granted",
        amount: gained,
        totalAfter: state.memoryChips,
      }];
    }
    case "add-shop-products": {
      const added: number[] = [];
      const skipped: number[] = [];
      for (const n of action.products) {
        // Defensive: also skip already-owned products so a re-entry
        // (data bug or future "second town visit re-adds same set"
        // scenario) doesn't resurrect a sold-out card.
        if (state.shopProductsAvailable.includes(n)) { skipped.push(n); continue; }
        const allOwned = Object.values(state.shopProductsOwned).flat();
        if (allOwned.includes(n)) { skipped.push(n); continue; }
        state.shopProductsAvailable.push(n);
        added.push(n);
      }
      logEvent("engine.onEnter.add-shop-products", {
        requested: action.products,
        added,
        skipped,
        availableAfter: state.shopProductsAvailable.slice(),
        questLabel: action.questLabel ?? null,
      });
      const events: RewardEvent[] = added.length === 0 ? [] : [{
        kind: "shop-products-added",
        productNumbers: added,
        questLabel: action.questLabel,
      }];
      if (action.chipFallback && skipped.length > 0) {
        events.push(...runAction(state, { kind: "grant-memory-chip", amount: action.chipFallback * skipped.length }));
      }
      return events;
    }
    case "unlock-hero-cards": {
      // Filter to NEW unlocks so a re-entry (data bug — `pagesEntered`
      // already prevents this) wouldn't double-add the same card to
      // the list. Order preserved per request-order so the rewards
      // modal renders them left-to-right as authored.
      const newlyUnlocked: number[] = [];
      for (const n of action.cardNumbers) {
        if (state.unlockedHeroCards.includes(n)) continue;
        state.unlockedHeroCards.push(n);
        newlyUnlocked.push(n);
      }
      logEvent("engine.onEnter.unlock-hero-cards", {
        requested: action.cardNumbers,
        newlyUnlocked,
        unlockedAfter: state.unlockedHeroCards.slice(),
      });
      if (newlyUnlocked.length === 0) return [];
      return [{ kind: "hero-cards-unlocked", cardNumbers: newlyUnlocked }];
    }
    case "gain-key-item": {
      // Idempotent: if the campaign already owns this key item number,
      // skip silently (no modal card). The narrative pages have a
      // separate `record-decision` row that already tracks the "you
      // visited the page" beat for the dotted log.
      const already = state.keyItems.some((k) => k.number === action.number);
      if (already) {
        logEvent("engine.onEnter.gain-key-item.skip", {
          reason: "already-owned",
          number: action.number,
          name: action.name,
        });
        return [];
      }
      state.keyItems.push({ number: action.number, name: action.name, clues: KEY_ITEMS.find((x) => x.number === action.number)?.clues ?? 1 });
      logEvent("engine.onEnter.gain-key-item", {
        number: action.number,
        name: action.name,
        keyItemsAfter: state.keyItems.map((k) => k.number),
      });
      return [{ kind: "key-item-gained", number: action.number, name: action.name }];
    }
    case "shift-favour": {
      const existing = state.favour[action.characterId];
      const before = existing?.value ?? 0;
      // Samantha Ally Opinion Card "Popular" (Nov 15 cards; this
      // was Vera Ally's printed text before): "The next time you
      // would lose Opinion with someone, don't."
      // We intercept ANY negative delta when the card is owned
      // and not yet spent — sticky one-shot, marks itself spent
      // and emits a `opinion-card-shielded-decrease` reward
      // event so the modal can call out what happened. Re-storing
      // the character name (no-op for opinion value) keeps the
      // favour ledger's name slot fresh on the same code path as
      // a normal shift would.
      // Samantha's Confidant card prints the same "Popular" effect.
      const samanthaCard = holdsOpinionCard(state, "samantha", "confidant") ? "confidant"
        : holdsOpinionCard(state, "samantha", "ally") ? "ally" : null;
      if (action.delta < 0 && samanthaCard) {
        state.favour[action.characterId] = {
          name: action.characterName,
          value: before,
        };
        state.opinionCardsSpent.push(`samantha-${samanthaCard}`);
        logEvent("engine.onEnter.shift-favour.samanthaShielded", {
          characterId: action.characterId,
          characterName: action.characterName,
          preventedDelta: action.delta,
          favourValue: before,
        });
        return [{
          kind: "opinion-card-shielded-decrease",
          shieldedCharacterId: action.characterId,
          shieldedCharacterName: action.characterName,
          preventedDelta: action.delta,
        }];
      }
      const after = before + action.delta;
      // Always store the latest name — if a chapter changes how a
      // character is addressed later in the campaign, the most
      // recent shift wins. Cheap and the alternative (rejecting
      // name changes) would be surprising.
      state.favour[action.characterId] = {
        name: action.characterName,
        value: after,
      };
      logEvent("engine.onEnter.shift-favour", {
        characterId: action.characterId,
        characterName: action.characterName,
        delta: action.delta,
        before,
        after,
      });
      // Suppress the modal card for a no-op shift (`delta === 0`);
      // legal future-proofing but useless to surface today.
      if (action.delta === 0) return [];
      const events: RewardEvent[] = [{
        kind: "favour-shifted",
        characterId: action.characterId,
        characterName: action.characterName,
        delta: action.delta,
        totalAfter: after,
      }];
      if (!action.trackOnly) events.push(...updateOpinionCard(state, action.characterId, action.characterName, before, after));
      return events;
    }
    case "reveal-quest": {
      // Idempotent — if the campaign already has this quest revealed,
      // skip silently (no reward card). Matches `gain-key-item`'s
      // behavior so re-entering a page (impossible today thanks to
      // `pagesEntered` dedupe, but defensive against future
      // re-render paths) doesn't double-grant the visual reward.
      const already = state.revealedQuests.some((q) => q.number === action.number);
      if (already) {
        logEvent("engine.onEnter.reveal-quest.skip", {
          reason: "already-revealed",
          number: action.number,
          name: action.name,
        });
        return [];
      }
      state.revealedQuests.push({ number: action.number, name: action.name });
      logEvent("engine.onEnter.reveal-quest", {
        number: action.number,
        name: action.name,
        revealedQuestsAfter: state.revealedQuests.map((q) => q.number),
      });
      return [{ kind: "quest-revealed", number: action.number, name: action.name }];
    }
    case "discard-key-item": {
      // Defensive — silently no-op if the campaign doesn't currently
      // hold the item. Pages that fire this action are responsible
      // for sequencing it after the matching `gain-key-item` (e.g.
      // Ch2 hands over Key Item #1 in Father Flores's Office; the
      // grant lives on the Q2 W2/W3 victory path).
      const idx = state.keyItems.findIndex((k) => k.number === action.number);
      if (idx < 0) {
        logEvent("engine.onEnter.discard-key-item.skip", {
          reason: "not-owned",
          number: action.number,
        });
        return [];
      }
      const [removed] = state.keyItems.splice(idx, 1);
      logEvent("engine.onEnter.discard-key-item", {
        number: action.number,
        name: removed!.name,
        keyItemsAfter: state.keyItems.map((k) => k.number),
      });
      return [{ kind: "key-item-discarded", number: action.number, name: removed!.name }];
    }
    case "grant-minion-parts-floor": {
      const recipients = action.to === "all-delvers"
        ? Object.keys(state.minionParts)
        : [state.currentDelverId];
      const breakdown: { heroId: string; before: number; after: number }[] = [];
      for (const heroId of recipients) {
        const before = state.minionParts[heroId] ?? 0;
        if (before >= action.floor) continue;
        const after = action.floor;
        state.minionParts[heroId] = after;
        breakdown.push({ heroId, before, after });
      }
      logEvent("engine.onEnter.grant-minion-parts-floor", {
        floor: action.floor,
        to: action.to,
        recipients,
        bumped: breakdown.map((b) => b.heroId),
      });
      if (breakdown.length === 0) return [];
      return [{
        kind: "creature-parts-changed",
        partKind: "minion",
        direction: "gain",
        recipients: breakdown,
      }];
    }
    case "grant-story-tokens": {
      // Absolute SET (not additive) — the field's jsdoc spells this
      // out. Today only the Ch2 watchtower-resolution page calls
      // this; chaining multiple grants in a single visit would
      // overwrite the prior pool, which is intentional (the storybook
      // never asks for cumulative grants).
      const before = state.storyTokens;
      state.storyTokens = action.amount;
      logEvent("engine.onEnter.grant-story-tokens", {
        amount: action.amount,
        before,
        after: state.storyTokens,
      });
      if (action.amount <= 0) return [];
      return [{
        kind: "story-tokens-granted",
        amount: action.amount,
        totalAfter: state.storyTokens,
      }];
    }
    case "spend-story-token": {
      // Floor-clamped at 0. Defensive against a UI gate slip — if
      // `requireStoryTokens: "positive"` is missing from a choice,
      // we just no-op instead of going negative.
      const before = state.storyTokens;
      if (before <= 0) {
        logEvent("engine.onEnter.spend-story-token.skip", {
          reason: "no-tokens",
        });
        return [];
      }
      state.storyTokens = before - 1;
      logEvent("engine.onEnter.spend-story-token", {
        before,
        after: state.storyTokens,
      });
      // No reward event — token spending is silent bookkeeping.
      // The visible reward is the page the player just walked
      // into; surfacing a "-1 Story Token" card would just clutter
      // the rewards modal.
      return [];
    }
    case "add-shop-products-if-key-items-min": {
      // Conditional shop stocking — used by Ch2 Town Center for
      // tier-gated products (#13 unlocks at 2+ clue tokens, #14 at
      // 4+). The threshold is compared against the SUM of clue icons
      // across all owned Key Items (not just key item count), allowing
      // items with more than one clue icon to count for more.
      // Silently no-op when the gate isn't met.
      const haveClues = totalKeyItemClues(state);
      if (haveClues < action.minKeyItems) {
        logEvent("engine.onEnter.add-shop-products-if-key-items-min.skip", {
          reason: "below-threshold",
          haveClues,
          need: action.minKeyItems,
          productsConsidered: action.products,
        });
        return [];
      }
      // Threshold met — delegate to the shared add-shop-products
      // path so dedupe + reward-event shape stay identical, then
      // annotate each resulting event with clue context so the
      // rewards modal can surface why the product was unlocked.
      const events = runAction(state, {
        kind: "add-shop-products",
        products: action.products,
        ...(action.questLabel !== undefined ? { questLabel: action.questLabel } : {}),
      });
      return events.map((e) =>
        e.kind === "shop-products-added"
          ? { ...e, clueUnlockContext: { clues: haveClues, threshold: action.minKeyItems } }
          : e,
      );
    }
    case "resolve-academy-donation": {
      // Defer to the dedicated module so the tier / grant table
      // lives next to the donation accumulator helpers. The
      // helper is idempotent against `state.townDecisions` so a
      // double-fire (page re-entry, hot-reload) is safe.
      const event = resolveAcademyDonation(state, action.schedule ?? "ch2");
      return [event];
    }
    case "grant-ultra-level-cards": {
      // Pick `amount` random Ultras from the printed pool that the
      // campaign doesn't already own. Partial grants are fine — if
      // every Ultra is already owned the action silently no-ops (no
      // duplicate copies in the deck; the player just sees no card).
      const printedUltras = LEVEL_DECK.filter((c) => c.isUltra).map((c) => c.cardNumber);
      const ownedSet = new Set(state.ultraLevelCardsOwned);
      const candidates = printedUltras.filter((n) => !ownedSet.has(n));
      if (candidates.length === 0 || action.amount <= 0) {
        logEvent("engine.onEnter.grant-ultra-level-cards.skip", {
          reason: candidates.length === 0 ? "all-owned" : "non-positive-amount",
          amountRequested: action.amount,
          ownedBefore: state.ultraLevelCardsOwned.slice(),
        });
        return [];
      }
      const picked = shuffle([...candidates]).slice(0, Math.min(action.amount, candidates.length));
      // Push in sorted order so saves / logs are stable (the shuffle
      // above only randomized WHICH ones, not the storage order).
      const granted = [...picked].sort((a, b) => a - b);
      state.ultraLevelCardsOwned = [...state.ultraLevelCardsOwned, ...granted].sort((a, b) => a - b);
      logEvent("engine.onEnter.grant-ultra-level-cards", {
        amountRequested: action.amount,
        granted,
        ownedAfter: state.ultraLevelCardsOwned.slice(),
      });
      return [{ kind: "ultra-level-cards-gained", cardNumbers: granted }];
    }
    case "set-story-counter": {
      state.storyCounters[action.key] = action.value;
      logEvent("engine.onEnter.set-story-counter", { key: action.key, value: action.value });
      return [];
    }
    case "adjust-story-counter": {
      state.storyCounters[action.key] = (state.storyCounters[action.key] ?? 0) + action.delta;
      logEvent("engine.onEnter.adjust-story-counter", { key: action.key, value: state.storyCounters[action.key] });
      return [];
    }
    case "open-scavenge-shop": {
      const owned = new Set(Object.values(state.shopProductsOwned).flat());
      const added = action.products.filter((n) => !owned.has(n) && !state.shopProductsAvailable.includes(n));
      for (const n of added) getShopProduct(n);
      state.shopProductsAvailable.push(...added);
      state.scavengeShopProducts = added;
      logEvent("engine.onEnter.open-scavenge-shop", { added });
      return [];
    }
    case "close-scavenge-shop": {
      const unsold = state.scavengeShopProducts.filter((n) => state.shopProductsAvailable.includes(n));
      state.shopProductsAvailable = state.shopProductsAvailable.filter((n) => !unsold.includes(n));
      state.scavengeShopProducts = [];
      logEvent("engine.onEnter.close-scavenge-shop", { removed: unsold });
      return [];
    }
    case "clear-combat-only-grants": {
      clearCombatOnlyGrants(state);
      return [];
    }
    case "convert-memory-chips-to-cards": {
      // Spend the chips, drawing 1 Memory Fragment per chip. Ordered deck: continue after the highest card drawn so far, and
      // stop at the last card (unspent chips stay on hand).
      const nextIdx = MEMORY_CARDS.findIndex((c) => c.number > Math.max(0, ...state.memoryCards));
      const remaining = nextIdx < 0 ? 0 : MEMORY_CARDS.length - nextIdx;
      const chipsSpent = Math.min(state.memoryChips, remaining);
      if (chipsSpent <= 0) {
        logEvent("engine.onEnter.convert-memory-chips-to-cards.skip", {
          reason: state.memoryChips <= 0 ? "no-chips" : "deck-empty",
          chipsAvailable: state.memoryChips,
          memoryCardsBefore: state.memoryCards.slice(),
        });
        return [];
      }
      const drawn: number[] = [];
      for (let i = 0; i < chipsSpent; i++) drawn.push(MEMORY_CARDS[nextIdx + i]!.number);
      state.memoryChips -= chipsSpent;
      state.memoryCards = [...state.memoryCards, ...drawn];
      logEvent("engine.onEnter.convert-memory-chips-to-cards", {
        chipsSpent,
        drawn,
        memoryChipsAfter: state.memoryChips,
        memoryCardsAfter: state.memoryCards.slice(),
      });
      return [{
        kind: "memory-cards-gained",
        chipsSpent,
        cardNumbers: drawn,
      }];
    }
    case "enqueue-suit-condition-rank-picks": {
      // Lift the storybook spec into the engine queue. The
      // post-rewards Town Visit flow drains the queue via the
      // SuitConditionRankPickModal; per-pick `suit-condition-rank-
      // bumped` events are emitted by the modal as each pick
      // resolves, NOT here, so this case returns no immediate
      // reward events.
      enqueueSuitConditionRankPicks(state, action.source, action.picks, action.source);
      return [];
    }
    case "grant-friendly-spawn-card": {
      // Defer to the dedicated module. Idempotent vs. already-
      // owned cards (silent no-op when both #13 + #14 are in
      // `state.friendlySpawnDeck`).
      return grantFriendlySpawnCard(state);
    }
    case "if": {
      const holds = evaluateTownVisitCondition(state, action.cond);
      logEvent("engine.onEnter.if", { cond: action.cond, holds });
      const branch = holds ? action.then : (action.otherwise ?? []);
      return branch.flatMap((a) => runAction(state, a));
    }
    case "complete-quest": {
      const events: RewardEvent[] = [];
      if (!state.revealedQuests.some((q) => q.number === action.number)) {
        state.revealedQuests.push({ number: action.number, name: action.name });
      }
      if (state.completedQuests.includes(action.number)) {
        logEvent("engine.onEnter.complete-quest.skip", { reason: "already-completed", number: action.number });
        return [];
      }
      state.completedQuests.push(action.number);
      state.townDecisions.push(`quest.${action.number}.completed`);
      logEvent("engine.onEnter.complete-quest", { number: action.number, completedQuests: [...state.completedQuests] });
      events.push({ kind: "quest-completed", number: action.number, name: action.name });
      return events;
    }
    case "grant-boss-parts": {
      const wallet = bossWallet(state, action.level);
      const recipients = action.to === "all-delvers"
        ? Object.keys(state.minionParts)
        : [state.currentDelverId];
      const breakdown: { heroId: string; before: number; after: number }[] = [];
      for (const heroId of recipients) {
        const before = wallet[heroId] ?? 0;
        wallet[heroId] = before + action.amount;
        breakdown.push({ heroId, before, after: before + action.amount });
      }
      logEvent("engine.onEnter.grant-boss-parts", { level: action.level, amount: action.amount, to: action.to });
      return [{
        kind: "creature-parts-changed",
        partKind: `boss-lvl-${action.level}` as const,
        direction: "gain",
        recipients: breakdown,
      }];
    }
    case "discard-opinion-card": {
      const idx = state.opinionCards.findIndex(
        (c) => c.characterId === action.characterId && c.level === action.level,
      );
      if (idx < 0) {
        logEvent("engine.onEnter.discard-opinion-card.skip", { reason: "not-owned", ...action });
        return [];
      }
      // A one-shot card already redeemed ("Discard once redeemed") is
      // already gone from the table — drop the record silently so the
      // rewards modal doesn't report discarding it a second time.
      const held = holdsOpinionCard(state, action.characterId, action.level);
      const [card] = state.opinionCards.splice(idx, 1);
      const cardId = `${action.characterId}-${action.level}`;
      state.opinionCardsSpent = state.opinionCardsSpent.filter((id) => id !== cardId);
      logEvent("engine.onEnter.discard-opinion-card", { characterId: action.characterId, level: action.level, held });
      if (!held) return [];
      return [{
        kind: "opinion-card-discarded",
        characterId: action.characterId,
        characterName: card!.characterName,
        level: action.level,
      }];
    }
    case "reveal-first-unowned-quest": {
      const target = action.quests.find((q) => !state.revealedQuests.some((r) => r.number === q.number));
      if (!target) {
        logEvent("engine.onEnter.reveal-first-unowned-quest.fallback", { chipFallback: action.chipFallback });
        return runAction(state, { kind: "grant-memory-chip", amount: action.chipFallback });
      }
      return runAction(state, { kind: "reveal-quest", number: target.number, name: target.name });
    }
    case "grant-shop-product": {
      const heroId = action.to === "active-delver" ? state.currentDelverId : action.to;
      const owned = state.shopProductsOwned[heroId] ?? [];
      const ownedByAnyone = Object.values(state.shopProductsOwned).some((list) => list.includes(action.product));
      if (ownedByAnyone) {
        logEvent("engine.onEnter.grant-shop-product.skip", { reason: "already-owned", product: action.product });
        return [];
      }
      getShopProduct(action.product); // throws on an unknown number (data bug)
      owned.push(action.product);
      state.shopProductsOwned[heroId] = owned;
      state.shopProductsAvailable = state.shopProductsAvailable.filter((n) => n !== action.product);
      logEvent("engine.onEnter.grant-shop-product", { product: action.product, heroId });
      return [{ kind: "shop-product-granted", productNumber: action.product, heroId }];
    }
    case "place-scenario-card-on-top": {
      getScenarioCard(action.cardNumber); // throws on an unknown card (data bug)
      state.scenarioDeckTop = [action.cardNumber, ...state.scenarioDeckTop.filter((n) => n !== action.cardNumber)];
      logEvent("engine.onEnter.place-scenario-card-on-top", { cardNumber: action.cardNumber, deckTop: [...state.scenarioDeckTop] });
      return [{ kind: "scenario-card-placed", cardNumber: action.cardNumber }];
    }
    case "grant-minion-parts-per-open-quest": {
      const open = openQuestCount(state);
      logEvent("engine.onEnter.grant-minion-parts-per-open-quest", { open, perQuest: action.perQuest });
      if (open === 0) return [];
      return runAction(state, { kind: "grant-minion-parts", amount: open * action.perQuest, to: action.to });
    }
    case "reveal-quest-or-grant-chip": {
      // Branch on prior reveal: if the quest is already in
      // `revealedQuests`, grant `chipFallback` Memory Chip Tokens
      // instead (mirrors the storybook's "If you've already
      // discovered Quest #N, gain a Memory Chip Token instead").
      const already = state.revealedQuests.some((q) => q.number === action.number);
      if (already) {
        logEvent("engine.onEnter.reveal-quest-or-grant-chip.fallback", {
          number: action.number,
          name: action.name,
          chipFallback: action.chipFallback,
        });
        return runAction(state, { kind: "grant-memory-chip", amount: action.chipFallback });
      }
      return runAction(state, { kind: "reveal-quest", number: action.number, name: action.name });
    }
  }
}

/**
 * Set the current page id. No-op if there is no active visit OR
 * the destination page doesn't exist. The next `applyOnEnter` call
 * (typically from the UI's render loop) will fire the destination's
 * `onEnter` actions.
 */
export function setTownVisitPage(state: CampaignState, pageId: string): void {
  const visit = state.townVisit;
  if (!visit) {
    logEvent("engine.setTownVisitPage.skip", { reason: "no-visit", pageId });
    return;
  }
  const chapter = getChapter(visit.chapterId);
  if (!chapter.pages[pageId]) {
    logEvent("engine.setTownVisitPage.skip", { reason: "unknown-page", pageId, fromPageId: visit.pageId });
    return;
  }
  const fromPageId = visit.pageId;
  visit.pageId = pageId;
  // Online shop turns belong to one shop page.
  delete visit.shopTurn;
  delete visit.shopDone;
  logEvent("engine.setTownVisitPage", {
    fromPageId,
    toPageId: pageId,
    chapterId: visit.chapterId,
  });
}

/**
 * Take a choice on the current page. Records the decision key and
 * navigates to the choice's `next` page. No-op if there is no active
 * visit, no current page, or the decision key doesn't match any
 * choice on the current page.
 */
export function chooseTownVisitOption(state: CampaignState, decisionKey: string): void {
  const ctx = currentTownVisitPage(state);
  if (!ctx) {
    logEvent("engine.chooseTownVisitOption.skip", { reason: "no-page", decisionKey });
    return;
  }
  const choice = (ctx.page.choices ?? []).find((c) => c.decisionKey === decisionKey);
  if (!choice) {
    logEvent("engine.chooseTownVisitOption.skip", {
      reason: "unknown-key",
      decisionKey,
      pageId: ctx.visit.pageId,
      availableKeys: (ctx.page.choices ?? []).map((c) => c.decisionKey),
    });
    return;
  }
  state.townDecisions.push(decisionKey);
  logEvent("engine.chooseTownVisitOption", {
    decisionKey,
    fromPageId: ctx.visit.pageId,
    toPageId: choice.next,
  });
  setTownVisitPage(state, choice.next);
}

/**
 * Resolve a `dieRoll` page with the rolled value: record the roll as a
 * decision (`<pageId>.roll.<n>`) and move to the matching bracket's page.
 * Throws when no bracket covers the roll (data bug in the chapter JSON).
 */
export function resolveTownVisitDieRoll(state: CampaignState, roll: number): void {
  const ctx = currentTownVisitPage(state);
  if (!ctx || !ctx.page.dieRoll) {
    logEvent("engine.resolveTownVisitDieRoll.skip", { reason: "no-die-roll-page", roll });
    return;
  }
  const outcome = ctx.page.dieRoll.find((o) => roll >= o.min && roll <= o.max);
  if (!outcome) throw new Error(`No die-roll bracket for ${roll} on page ${ctx.visit.pageId}`);
  state.townDecisions.push(`${ctx.visit.pageId}.roll.${roll}`);
  logEvent("engine.resolveTownVisitDieRoll", { pageId: ctx.visit.pageId, roll, toPageId: outcome.next });
  setTownVisitPage(state, outcome.next);
}

/** True when a choice's `requireDecision` / `requireKeyItemAny` gates hide it. */
export function townVisitChoiceGated(
  state: CampaignState,
  choice: {
    requireDecision?: string;
    requireKeyItemAny?: number[];
    requireQuestRevealed?: number;
    requireOpenQuests?: "zero" | "positive";
  },
): boolean {
  if (choice.requireDecision && !state.townDecisions.includes(choice.requireDecision)) return true;
  if (choice.requireKeyItemAny && !choice.requireKeyItemAny.some((n) => state.keyItems.some((k) => k.number === n))) return true;
  if (choice.requireQuestRevealed !== undefined
    && !state.revealedQuests.some((q) => q.number === choice.requireQuestRevealed)) return true;
  if (choice.requireOpenQuests === "zero" && openQuestCount(state) > 0) return true;
  if (choice.requireOpenQuests === "positive" && openQuestCount(state) === 0) return true;
  return false;
}

/** Advance from a linear (non-choice) page to its `next` page. */
export function advanceTownVisitPage(state: CampaignState): void {
  const ctx = currentTownVisitPage(state);
  if (!ctx) {
    logEvent("engine.advanceTownVisitPage.skip", { reason: "no-page" });
    return;
  }
  const next = ctx.page.next;
  if (!next) {
    logEvent("engine.advanceTownVisitPage.skip", { reason: "no-next", pageId: ctx.visit.pageId });
    return;
  }
  logEvent("engine.advanceTownVisitPage", {
    fromPageId: ctx.visit.pageId,
    toPageId: next,
  });
  setTownVisitPage(state, next);
}

/** End the visit. Flips the chapter completion latch + clears the visit.
 *
 * For Chapter 1 specifically, also advances the active Quest pointer
 * from `"quest1"` to `"quest2"` so the Story screen's
 * `currentQuestId`-keyed page builder renders the Q2 intro on the
 * next navigation. Idempotent — if the player already debug-jumped
 * to Q2 (`Title.ts > jumpToQuest`), `currentQuestId` is already
 * `"quest2"` and this is a no-op. The caller is responsible for the
 * actual navigation (`router.goTo({ name: "story" })`) — keeping
 * engine + UI separated.
 *
 * For Chapter 2 specifically, flips `townVisit2Completed` and
 * clears `storyTokens` (the pool is visit-scoped and shouldn't
 * leak forward to Ch3+). The active Quest pointer is left
 * unchanged because Q3 isn't shipped yet — the post-Ch2 routing
 * just bounces back to title; future work will bump it to
 * `"quest3"` here once that quest exists. */
export function finishTownVisit(state: CampaignState): void {
  if (!state.townVisit) {
    logEvent("engine.finishTownVisit.skip", { reason: "no-visit" });
    return;
  }
  const chapterId = state.townVisit.chapterId;
  const visitedPages = state.townVisit.pagesEntered.length;
  if (chapterId === "ch1") {
    state.townVisit1Completed = true;
    state.currentQuestId = "quest2";
  }
  if (chapterId === "ch3") {
    state.townVisit3Completed = true;
    state.storyTokens = 0;
  }
  if (chapterId === "ch4") {
    state.townVisit4Completed = true;
    state.storyTokens = 0;
  }
  if (chapterId === "ch2") {
    state.townVisit2Completed = true;
    // Story Token pool is visit-scoped — wipe it so a re-entry
    // (debug or future Ch3+ flow) doesn't inherit a stale value.
    // Defensive clear: 0 is the same as the visit-end state anyway
    // because the hub-page choice gating drains it to 0 before the
    // player can reach the terminal page.
    state.storyTokens = 0;
  }
  // Opinion-Card per-visit latch reset at every town visit end,
  // regardless of chapter. `floresDiscountArmed` is only meaningful
  // inside a visit (it modifies the next shop purchase) so leaking
  // it would mis-apply on a future visit.
  state.floresDiscountArmed = false;
  state.iraDiscountActive = false;
  // Per-delver academy-donation accumulator is visit-scoped — the
  // RESOLUTION's rank bumps already landed on `suitConditionRankBonus`
  // (permanent) via `resolveAcademyDonation`, so wiping the raw
  // total here just keeps the "running total" UI clean for a
  // future visit. Idempotent against `state.townDecisions`
  // resolution marker means resetting the total doesn't risk a
  // double-resolve on re-entry.
  for (const heroId of Object.keys(state.academyDonation)) {
    state.academyDonation[heroId] = 0;
  }
  state.townVisit = null;
  logEvent("engine.finishTownVisit", {
    chapterId,
    visitedPages,
    nextQuestId: state.currentQuestId,
    wallets: snapWallets(state),
  });
}

// --- Opinion cards: one per character -------------------------------------

/**
 * Rulebook p27: "record the new opinion on the Campaign Sheet and take the
 * corresponding Opinion Card. If players already have an Opinion Card for
 * that character, return the previous card to the box." So after a shift
 * the player holds exactly the card for the new level (none at Neutral).
 *
 *   - A card returned to the box is removed (and its redeemed flag cleared,
 *     so a later card of the same level comes back fresh).
 *   - Arlen Detractor / Nemesis cap Ally + Confidant cards at 2 / 1: a new
 *     positive card that would break the cap isn't taken (the opinion
 *     still moves).
 *   - Elias Detractor ("Lose 1 Memory Chip token on hand if possible.
 *     Discard once redeemed.") resolves the moment it's taken.
 *   - Dahlia Ally starts both delvers on a Reroll token choice (changeable
 *     in the Shop).
 */
function updateOpinionCard(
  state: CampaignState,
  characterId: string,
  characterName: string,
  before: number,
  after: number,
): RewardEvent[] {
  const oldLevel = opinionLevelForValue(before);
  const newLevel = opinionLevelForValue(after);
  if (oldLevel === newLevel && state.opinionCards.some((c) => c.characterId === characterId)) return [];
  const events: RewardEvent[] = [];
  for (const old of state.opinionCards.filter((c) => c.characterId === characterId)) {
    const held = holdsOpinionCard(state, characterId, old.level);
    state.opinionCards = state.opinionCards.filter((c) => c !== old);
    state.opinionCardsSpent = state.opinionCardsSpent.filter((id) => id !== `${characterId}-${old.level}`);
    if (held) events.push({ kind: "opinion-card-discarded", characterId, characterName: old.characterName, level: old.level });
  }
  if (!newLevel) return events;
  const limit = positiveCardLimit(state);
  if ((newLevel === "ally" || newLevel === "confidant") && limit !== null && heldPositiveCardCount(state) >= limit) {
    logEvent("engine.onEnter.opinion-card.blocked-by-arlen", { characterId, level: newLevel, limit });
    events.push({ kind: "opinion-card-blocked", characterId, characterName, level: newLevel, limit });
    return events;
  }
  state.opinionCards.push({ characterId, characterName, level: newLevel });
  logEvent("engine.onEnter.opinion-card.gained", { characterId, characterName, level: newLevel });
  events.push({ kind: "opinion-card-gained", characterId, characterName, level: newLevel });
  if (characterId === "elias" && newLevel === "detractor") {
    const lost = state.memoryChips > 0 ? 1 : 0;
    state.memoryChips -= lost;
    state.opinionCardsSpent.push("elias-detractor");
    events.push({
      kind: "opinion-card-redeemed", characterId, characterName, level: "detractor",
      summary: lost ? "Lost 1 Memory Chip token." : "No Memory Chip token to lose.",
    });
  }
  if (characterId === "dahlia" && newLevel === "ally") {
    for (const heroId of Object.keys(state.loadouts)) {
      if (!state.dahliaTokenChoice[heroId]) state.dahliaTokenChoice[heroId] = "reroll";
    }
  }
  return events;
}

// --- "Choose N Shop Products" rewards (the Gaia wave) ----------------------

/** Products from `from` that can still be added: not already for sale
 *  and not owned by either delver. */
export function eligibleShopProductPicks(state: CampaignState, from: readonly number[]): number[] {
  const owned = new Set(Object.values(state.shopProductsOwned).flat());
  return from.filter((n) => !state.shopProductsAvailable.includes(n) && !owned.has(n));
}

/**
 * Resolve a "choose `count` of `from`" reward. `picks` must be distinct
 * eligible products, exactly `min(count, eligible)` of them. Each pick
 * that couldn't be made (fewer eligible products than `count`) becomes a
 * Memory Chip token instead.
 */
export function resolveShopProductPicks(
  state: CampaignState,
  from: readonly number[],
  count: number,
  picks: readonly number[],
  questLabel: string,
): RewardEvent[] {
  const eligible = eligibleShopProductPicks(state, from);
  const need = Math.min(count, eligible.length);
  if (new Set(picks).size !== picks.length || picks.length !== need || picks.some((n) => !eligible.includes(n))) {
    throw new Error(`resolveShopProductPicks: invalid picks ${JSON.stringify(picks)} (need ${need} of ${JSON.stringify(eligible)})`);
  }
  const events = runTownVisitAction(state, { kind: "add-shop-products", products: [...picks], questLabel });
  const shortfall = count - need;
  if (shortfall > 0) events.push(...runTownVisitAction(state, { kind: "grant-memory-chip", amount: shortfall }));
  return events;
}

// --- Opinion-Card redemptions (Shop-scoped) -------------------------------

/**
 * Discriminated reason a one-shot Opinion-Card redemption rejected.
 * Returned by `redeemVeraAlly` / `redeemFloresAlly` instead of
 * throwing so the UI can surface a friendly error and stay on the
 * shop screen.
 */
export interface OpinionRedemptionError {
  code: "card-not-owned" | "already-spent" | "already-active" | "no-town-visit";
}

/**
 * Common preflight for the one-shot opinion-card redemption helpers
 * below. Verifies:
 *   - The player is currently inside a town visit (the latches only
 *     make sense in-visit).
 *   - The named card is in `state.opinionCards` (favor crossed the
 *     threshold at some point this campaign).
 *   - The card hasn't already been redeemed (`opinionCardsSpent`).
 *
 * Returns `null` on success; an `OpinionRedemptionError` on
 * failure. Callers pass the catalog id (`"vera-ally"`,
 * `"flores-ally"`, etc.); the helper splits it on the first dash
 * to look up the underlying `(characterId, level)` pair.
 */
function preflightOpinionRedemption(
  state: CampaignState,
  cardId: string,
): OpinionRedemptionError | null {
  if (!state.townVisit) return { code: "no-town-visit" };
  if (state.opinionCardsSpent.includes(cardId)) {
    return { code: "already-spent" };
  }
  const dashIdx = cardId.indexOf("-");
  if (dashIdx < 0) return { code: "card-not-owned" };
  const characterId = cardId.slice(0, dashIdx);
  const level = cardId.slice(dashIdx + 1);
  const owned = state.opinionCards.some(
    (c) => c.characterId === characterId && c.level === level,
  );
  if (!owned) return { code: "card-not-owned" };
  return null;
}

/**
 * Redeem the Vera Ally Opinion Card "Gift" (Nov 15 cards): "Choose a
 * delver to gain a Level 2 Boss part. Discard once redeemed." Credits
 * one Lvl 2 boss part to `heroId`'s wallet and marks the card spent.
 * Redeemed from the Shop's favors panel, so it needs a town visit.
 */
export function redeemVeraAlly(state: CampaignState, heroId: string): OpinionRedemptionError | null {
  const err = preflightOpinionRedemption(state, "vera-ally");
  if (err) return err;
  if (!(heroId in state.bossPartsLvl2)) {
    throw new Error(`redeemVeraAlly: unknown heroId ${heroId}`);
  }
  state.bossPartsLvl2[heroId] = (state.bossPartsLvl2[heroId] ?? 0) + 1;
  state.opinionCardsSpent.push("vera-ally");
  logEvent("engine.opinionRedeem.vera", {
    heroId,
    bossPartsLvl2After: state.bossPartsLvl2[heroId],
    chapterId: state.townVisit?.chapterId,
  });
  return null;
}

/**
 * Redeem Ira's Ally card "Influential": "This town visit, all Shop
 * Products cost 1 less minion part. Discard once redeemed."
 */
export function redeemIraAlly(state: CampaignState): OpinionRedemptionError | null {
  const err = preflightOpinionRedemption(state, "ira-ally");
  if (err) return err;
  state.iraDiscountActive = true;
  state.opinionCardsSpent.push("ira-ally");
  logEvent("engine.opinionRedeem.ira", { chapterId: state.townVisit?.chapterId });
  return null;
}

/**
 * Redeem Elias's Ally or Confidant card: "You may spend 3 minion parts to
 * gain 1 Memory Chip token. Discard once redeemed." `heroId` pays.
 */
export function redeemEliasCard(
  state: CampaignState,
  heroId: string,
  level: "ally" | "confidant",
): OpinionRedemptionError | { code: "insufficient-minion" } | null {
  const err = preflightOpinionRedemption(state, `elias-${level}`);
  if (err) return err;
  if ((state.minionParts[heroId] ?? 0) < 3) return { code: "insufficient-minion" };
  state.minionParts[heroId] = (state.minionParts[heroId] ?? 0) - 3;
  const gained = gainMemoryChips(state, 1);
  state.opinionCardsSpent.push(`elias-${level}`);
  logEvent("engine.opinionRedeem.elias", { heroId, level, gained });
  return null;
}

/**
 * Redeem the Flores Ally Opinion Card: arm the per-visit
 * `floresDiscountArmed` flag (removes one boss part from the
 * NEXT shop purchase that has one) and mark the card permanently
 * spent.
 *
 * Returns `null` on success; an `OpinionRedemptionError` on
 * failure. A second call when already-armed returns `already-active`
 * — the player must apply the existing armament (or finish the
 * visit) before re-redeeming, and re-redemption is impossible
 * anyway because the card is one-shot.
 */
export function redeemFloresAlly(state: CampaignState): OpinionRedemptionError | null {
  const err = preflightOpinionRedemption(state, "flores-ally");
  if (err) return err;
  if (state.floresDiscountArmed) {
    return { code: "already-active" };
  }
  state.floresDiscountArmed = true;
  state.opinionCardsSpent.push("flores-ally");
  logEvent("engine.opinionRedeem.flores", {
    chapterId: state.townVisit?.chapterId,
  });
  return null;
}

// --- Shop transactions ----------------------------------------------------

export interface PurchaseError {
  code:
    | "not-available"
    | "already-owned"
    | "insufficient-minion"
    | "insufficient-boss-lvl-1"
    | "insufficient-boss-lvl-2"
    | "insufficient-boss-lvl-3"
    | "insufficient-boss-lvl-4"
    /** Samantha Detractor opinion card is owned and unresolved, and
     *  this product is hosted by the Machinist. The player must
     *  pay Samantha 1 LVL 1 BOSS PART (via
     *  `engine/opinionPenalty.ts > resolveSamanthaDetractor`) before
     *  any Machinist purchase will succeed. */
    | "samantha-detractor-blocked"
    /** Samantha Nemesis: Machinist products are unpurchasable. */
    | "samantha-nemesis-blocked"
    /** The product prints "Only [suit] can purchase". */
    | "wrong-suit";
}

/**
 * Effective post-discount cost for a Shop Product, accounting for:
 *
 *   - Flores Ally: "Remove 1 BOSS PART cost from any 1 Shop
 *     Product" -> while `floresDiscountArmed`, the NEXT purchase
 *     debits one fewer boss part. We prefer to strip a Lvl-2 part
 *     when one is on the product (higher-value to the player);
 *     fall back to a Lvl-1 if that's all the product asks for.
 *     Pure minion-only products silently consume no Flores
 *     discount (and the arm latch stays armed for a later
 *     purchase) since the card text is specifically "BOSS PART".
 *
 * The adjustment is applied to a fresh `EffectiveCost` (the
 * printed `product.cost` is never mutated) so callers (cost render,
 * affordability preview, debit step) all see the same numbers.
 */
export interface EffectiveCost {
  minionParts: number;
  bossLvl1: number;
  bossLvl2: number;
  bossLvl3: number;
  bossLvl4: number;
  /** Opinion cards that changed the minion price (e.g. "Ira -1"). */
  opinionLabels: string[];
  /** Whether the Flores discount actually removed a boss part
   *  from this product. False for minion-only products (where the
   *  arm latch silently passes through) and for any call when the
   *  Flores latch isn't currently armed. */
  floresApplied: boolean;
}

export function effectiveShopProductCost(
  state: CampaignState,
  productNumber: number,
): EffectiveCost {
  const product = getShopProduct(productNumber);
  const opinion = opinionShopMinionAdjust(state, product);
  const minion = Math.max(0, product.cost.minionParts + opinion.delta);
  let lvl1 = product.cost.bossLvl1;
  let lvl2 = product.cost.bossLvl2;
  let lvl3 = product.cost.bossLvl3 ?? 0;
  let lvl4 = product.cost.bossLvl4 ?? 0;
  let floresApplied = false;
  if (state.floresDiscountArmed) {
    if (lvl4 > 0) {
      lvl4 -= 1;
      floresApplied = true;
    } else if (lvl3 > 0) {
      lvl3 -= 1;
      floresApplied = true;
    } else if (lvl2 > 0) {
      lvl2 -= 1;
      floresApplied = true;
    } else if (lvl1 > 0) {
      lvl1 -= 1;
      floresApplied = true;
    }
    // No boss part to remove -> latch stays armed for a later
    // purchase. Mirror of the card text: "any 1 Shop Product" is
    // satisfied by a future product that has a boss part to remove.
  }
  return {
    minionParts: minion,
    opinionLabels: opinion.labels,
    bossLvl1: lvl1,
    bossLvl2: lvl2,
    bossLvl3: lvl3,
    bossLvl4: lvl4,
    floresApplied,
  };
}

/**
 * How `heroId` would pay `cost`: boss parts per level (1-4) from their
 * wallets and minion parts. With Flores's Confidant card, each missing
 * boss part may be paid with 3 minion parts per boss level instead.
 * Returns the matching insufficient-* error when they can't pay.
 */
export function planShopPayment(
  state: CampaignState,
  heroId: string,
  cost: EffectiveCost,
): { minion: number; boss: [number, number, number, number]; minionForBoss: number } | { error: PurchaseError } {
  const need = [cost.bossLvl1, cost.bossLvl2, cost.bossLvl3, cost.bossLvl4];
  const boss: [number, number, number, number] = [0, 0, 0, 0];
  let minionForBoss = 0;
  const flores = floresPaysBossPartsInMinion(state);
  for (let i = 0; i < 4; i++) {
    const level = (i + 1) as 1 | 2 | 3 | 4;
    const have = bossWallet(state, level)[heroId] ?? 0;
    const short = Math.max(0, need[i]! - have);
    if (short > 0 && !flores) return { error: { code: `insufficient-boss-lvl-${level}` } };
    boss[i] = need[i]! - short;
    minionForBoss += short * 3 * level;
  }
  const minion = cost.minionParts + minionForBoss;
  if ((state.minionParts[heroId] ?? 0) < minion) return { error: { code: "insufficient-minion" } };
  return { minion, boss, minionForBoss };
}

/** Purchase gate without buying: the error `purchaseShopProduct` would
 *  return, or null if `heroId` can buy it now. Used by the Shop UI. */
export function shopPurchaseError(state: CampaignState, heroId: string, productNumber: number): PurchaseError | null {
  if (!state.shopProductsAvailable.includes(productNumber)) return { code: "not-available" };
  if ((state.shopProductsOwned[heroId] ?? []).includes(productNumber)) return { code: "already-owned" };
  const product = getShopProduct(productNumber);
  if (product.onlySuit && getHero(heroId).suit !== product.onlySuit) return { code: "wrong-suit" };
  if (isShopProductBlockedBySamanthaDetractor(state, productNumber)) return { code: "samantha-detractor-blocked" };
  if (isShopProductBlockedBySamanthaNemesis(state, product.location)) return { code: "samantha-nemesis-blocked" };
  const plan = planShopPayment(state, heroId, effectiveShopProductCost(state, productNumber));
  return "error" in plan ? plan.error : null;
}

/**
 * Attempt to buy a shop product for `heroId`. Returns `null` on
 * success (state mutated) or `PurchaseError` on failure (state
 * untouched). All checks run before any mutation so the call is
 * atomic — a partial debit on a failed purchase would be a bug.
 */
export function purchaseShopProduct(
  state: CampaignState,
  heroId: string,
  productNumber: number,
): PurchaseError | null {
  if (!state.shopProductsAvailable.includes(productNumber)) {
    logEvent("engine.purchaseShopProduct.reject", { reason: "not-available", heroId, productNumber });
    return { code: "not-available" };
  }
  const owned = state.shopProductsOwned[heroId] ?? [];
  if (owned.includes(productNumber)) {
    logEvent("engine.purchaseShopProduct.reject", { reason: "already-owned", heroId, productNumber });
    return { code: "already-owned" };
  }
  const product = getShopProduct(productNumber);
  // Donation product (#8 — variableMinionParts) goes through
  // `engine/academyDonation.ts > donateToAcademy` instead, which
  // accumulates rather than completing a fixed-cost purchase.
  // Defensive: short-circuit here so a stray Buy click on the
  // donation product (from a future bug, or a test) doesn't
  // accidentally mark it as "owned" and remove it from the
  // available list, which would softlock the donation row.
  if (product.cost.variableMinionParts) {
    logEvent("engine.purchaseShopProduct.reject", { reason: "donation-product", heroId, productNumber });
    return { code: "not-available" };
  }
  if (product.onlySuit && getHero(heroId).suit !== product.onlySuit) {
    logEvent("engine.purchaseShopProduct.reject", { reason: "wrong-suit", heroId, productNumber });
    return { code: "wrong-suit" };
  }
  // Samantha Detractor PENALTY gate — checked BEFORE cost reads so
  // the player gets a specific "the Machinist won't sell to you"
  // rejection rather than a misleading "insufficient parts" error
  // when they have plenty of parts but the card is unresolved. The
  // `isShopProductBlockedBySamanthaDetractor` predicate is product-
  // location-scoped (only Machinist-hosted products gate today —
  // #32, #34, #41 in `data/shopProducts.json`).
  if (isShopProductBlockedBySamanthaDetractor(state, productNumber)) {
    logEvent("engine.purchaseShopProduct.reject", {
      reason: "samantha-detractor-blocked",
      heroId, productNumber, productLocation: product.location,
    });
    return { code: "samantha-detractor-blocked" };
  }
  if (isShopProductBlockedBySamanthaNemesis(state, product.location)) {
    logEvent("engine.purchaseShopProduct.reject", { reason: "samantha-nemesis-blocked", heroId, productNumber });
    return { code: "samantha-nemesis-blocked" };
  }
  const cost = effectiveShopProductCost(state, productNumber);
  const plan = planShopPayment(state, heroId, cost);
  if ("error" in plan) {
    logEvent("engine.purchaseShopProduct.reject", { reason: plan.error.code, heroId, productNumber, cost });
    return plan.error;
  }
  state.minionParts[heroId] = (state.minionParts[heroId] ?? 0) - plan.minion;
  for (const level of [1, 2, 3, 4] as const) {
    const wallet = bossWallet(state, level);
    wallet[heroId] = (wallet[heroId] ?? 0) - plan.boss[level - 1]!;
  }
  // Flores's "remove 1 BOSS PART cost from any 1 Shop Product" is
  // a one-shot — clear the armed latch the moment a purchase
  // actually consumed it. Pure minion-only purchases leave the
  // latch armed (matches the card text "any 1 Shop Product" which
  // is satisfied only when a boss part is actually removed).
  if (cost.floresApplied) {
    state.floresDiscountArmed = false;
  }
  if (!state.shopProductsOwned[heroId]) state.shopProductsOwned[heroId] = [];
  state.shopProductsOwned[heroId].push(productNumber);
  state.shopProductsAvailable = state.shopProductsAvailable.filter((n) => n !== productNumber);
  state.townDecisions.push(`ch1.shop.bought.product-${productNumber}.${heroId}`);
  logEvent("engine.purchaseShopProduct", {
    heroId,
    productNumber,
    productName: product.name,
    cost: { minion: cost.minionParts, bossLvl1: cost.bossLvl1, bossLvl2: cost.bossLvl2, bossLvl3: cost.bossLvl3, bossLvl4: cost.bossLvl4 },
    paid: plan,
    walletsAfter: snapWallets(state),
  });
  return null;
}

/**
 * Convert 1 Boss Part of the given level into Minion Parts for the
 * same delver, at the printed rate of **3 minion parts per level of
 * the Boss part** (Ch2 town-visit text: "At any time, you may
 * convert a Boss part into minion parts at the rate of 3 minion
 * parts per level of the Boss part") — LVL 1 → 3, LVL 2 → 6,
 * LVL 3 → 9. Returns `true` on success, `false` if the delver has
 * no boss parts of that level (no-op).
 *
 * `level` defaults to 1 for backward compatibility with the Ch1
 * shop's original single-level button. The LVL 2 / LVL 3 options
 * were MISSING pre-2026-07-20 (player report) — the converter and
 * its UI predate the level-aware wallets.
 */
export function convertBossPartToMinion(
  state: CampaignState,
  heroId: string,
  level: BossPartLevel = 1,
): boolean {
  const wallet = bossWallet(state, level);
  const boss = wallet[heroId] ?? 0;
  if (boss < 1) {
    logEvent("engine.convertBossPartToMinion.reject", { reason: "no-boss-parts", heroId, level });
    return false;
  }
  const minionGained = 3 * level;
  wallet[heroId] = boss - 1;
  state.minionParts[heroId] = (state.minionParts[heroId] ?? 0) + minionGained;
  logEvent("engine.convertBossPartToMinion", {
    heroId,
    level,
    minionGained,
    bossAfter: wallet[heroId],
    minionAfter: state.minionParts[heroId],
  });
  return true;
}

/**
 * Transfer `amount` minion parts from `fromHeroId` to `toHeroId`.
 * Returns `true` on success, `false` if `amount <= 0`, the sender
 * has insufficient parts, or the two hero ids are the same.
 */
export function transferMinionParts(
  state: CampaignState,
  fromHeroId: string,
  toHeroId: string,
  amount: number,
): boolean {
  if (amount <= 0) {
    logEvent("engine.transferMinionParts.reject", { reason: "non-positive-amount", amount });
    return false;
  }
  if (fromHeroId === toHeroId) {
    logEvent("engine.transferMinionParts.reject", { reason: "same-hero", fromHeroId, toHeroId });
    return false;
  }
  const have = state.minionParts[fromHeroId] ?? 0;
  if (have < amount) {
    logEvent("engine.transferMinionParts.reject", {
      reason: "insufficient", fromHeroId, toHeroId, amount, have,
    });
    return false;
  }
  state.minionParts[fromHeroId] = have - amount;
  state.minionParts[toHeroId] = (state.minionParts[toHeroId] ?? 0) + amount;
  logEvent("engine.transferMinionParts", {
    fromHeroId, toHeroId, amount,
    fromAfter: state.minionParts[fromHeroId],
    toAfter: state.minionParts[toHeroId],
  });
  return true;
}

/**
 * Transfer `amount` LVL 1 boss parts from `fromHeroId` to
 * `toHeroId`. Mirrors `transferMinionParts` for boss parts so the
 * Shop UI can offer a symmetrical trade affordance.
 */
export function transferBossParts(
  state: CampaignState,
  fromHeroId: string,
  toHeroId: string,
  amount: number,
): boolean {
  if (amount <= 0) {
    logEvent("engine.transferBossParts.reject", { reason: "non-positive-amount", amount });
    return false;
  }
  if (fromHeroId === toHeroId) {
    logEvent("engine.transferBossParts.reject", { reason: "same-hero", fromHeroId, toHeroId });
    return false;
  }
  const have = state.bossParts[fromHeroId] ?? 0;
  if (have < amount) {
    logEvent("engine.transferBossParts.reject", {
      reason: "insufficient", fromHeroId, toHeroId, amount, have,
    });
    return false;
  }
  state.bossParts[fromHeroId] = have - amount;
  state.bossParts[toHeroId] = (state.bossParts[toHeroId] ?? 0) + amount;
  logEvent("engine.transferBossParts", {
    fromHeroId, toHeroId, amount,
    fromAfter: state.bossParts[fromHeroId],
    toAfter: state.bossParts[toHeroId],
  });
  return true;
}

/**
 * Convenience for the UI: pick the "other" hero id for a given hero.
 * Defaults to the first non-matching id in HEROES; returns `null` if
 * there's only one hero in the data set (defensive — Q1 always has 2).
 */
export function otherHeroId(heroId: string): string | null {
  const other = HEROES.find((h) => h.id !== heroId);
  return other?.id ?? null;
}
