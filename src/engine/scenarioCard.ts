/**
 * Scenario Card engine — wave-2+ trigger surface.
 *
 * Lifecycle (rulebook + chapter 2 storybook PROOF 6):
 *
 *   1. `engine/encounter.ts > bootstrapWaveAtNumber` reads the
 *      wave def's optional `scenarioCardOnStart` and, if set
 *      AND the number isn't already in
 *      `state.scenarioCardsResolved`, calls
 *      `startScenarioCard(state, number)`. The bootstrap is
 *      otherwise a no-op for the scenario subsystem.
 *
 *   2. `startScenarioCard` populates `state.currentScenarioCard`
 *      with the card number + null chosenOption + resolved=false.
 *      BoardScreen sees the non-null entry and mounts
 *      `screens/ScenarioCardModal.ts` over the board.
 *
 *   3. Player picks a letter; the modal calls
 *      `chooseScenarioOption(state, "A")`. This flips
 *      `currentScenarioCard.chosenOption` and applies the
 *      chosen option's immediate effects. If the option has an
 *      interactive effect (`die-roll-outcome`, `pick-one-outcome`,
 *      `spend-element-for-shop-products`), `resolved` stays false
 *      and the back-of-card renders the interactive UI.
 *
 *   4. Player completes interactive step (roll, sub-choice, or
 *      element-spend decision). The modal calls the matching
 *      `resolveScenario*` function, which applies the outcome
 *      effects and sets `resolved = true`.
 *
 *   5. Player taps Continue; the modal calls
 *      `closeScenarioCard(state)`. This pushes the card number
 *      onto `state.scenarioCardsResolved` (the printed "discard
 *      the card" step) and nulls `state.currentScenarioCard`. The
 *      board resumes normal play.
 *
 * Card #08 (Friends) auto-skip: if Xavier's opinion is Neutral or
 * worse (`state.favour["xavier"]?.value ?? 0 <= 0`), `startScenarioCard`
 * marks #08 resolved and immediately starts #09 instead.
 */

import type { CampaignState, PendingScenarioDelverPick } from "../state";
import type { RewardEvent } from "../types";
import {
  getScenarioCard,
  type ScenarioCardChoice,
  type ScenarioCardChoiceLetter,
  type ScenarioCardEffect,
} from "../data";
import { logEvent } from "../debug/sessionLog";
import { enqueueSuitConditionRankPicks } from "./suitConditionGrants";
import { enqueueLevelUpDraws } from "./levelUp";
import { runTownVisitAction } from "./townVisit";
import { grantFriendlySpawnCard } from "./friendlyEncounter";
import { grantToken } from "./tokens";

/**
 * Set `state.currentScenarioCard` to a fresh entry for `number`.
 *
 * Card #08 special case: if Xavier's favour is Neutral or worse
 * (value <= 0), the card is auto-discarded and card #09 is started
 * instead (matching the printed "Discard and read next Scenario"
 * condition).
 *
 * Skipped (with a log line) when:
 *   - `state.scenarioCardsResolved` already contains the number.
 *   - `state.currentScenarioCard` already targets the same number.
 *
 * Throws when the catalog has no card with that number.
 */
export function startScenarioCard(state: CampaignState, number: number): void {
  if (state.scenarioCardsResolved.includes(number)) {
    logEvent("engine.scenarioCard.start.skip", { reason: "already-resolved", number });
    return;
  }
  if (state.currentScenarioCard && state.currentScenarioCard.number === number) {
    logEvent("engine.scenarioCard.start.skip", { reason: "already-in-flight", number });
    return;
  }

  // Card #08 (Friends): auto-skip to #09 if Xavier's opinion is Neutral or worse.
  if (number === 8) {
    const xavierFavour = (state.favour["xavier"] as { value?: number } | undefined)?.value ?? 0;
    if (xavierFavour <= 0) {
      state.scenarioCardsResolved.push(8);
      logEvent("engine.scenarioCard.autoSkip", {
        number: 8,
        reason: "xavier-opinion-neutral-or-worse",
        xavierFavour,
      });
      startScenarioCard(state, 9);
      return;
    }
  }

  // Validate against catalog before mutating state.
  const card = getScenarioCard(number);
  state.currentScenarioCard = {
    number,
    chosenOption: null,
    resolved: false,
  };
  logEvent("engine.scenarioCard.start", {
    number,
    name: card.name,
    printedId: card.printedId,
  });
}

/**
 * Apply the player's choice. Runs all of the option's effects;
 * immediate effects mutate state right away. Interactive effects
 * (`die-roll-outcome`, `pick-one-outcome`, `spend-element-for-shop-products`)
 * set a pending field on `currentScenarioCard` and leave
 * `resolved = false` — the back-of-card UI must collect the
 * remaining input before the Continue button becomes available.
 *
 * Returns reward events for the IMMEDIATE effects only.
 * Interactive-outcome reward events are returned by the matching
 * `resolveScenario*` function.
 *
 * Also emits a `scenario-card-resolved` event (always present in
 * the returned batch) so the reward modal always shows a headline
 * confirmation card.
 */
export function chooseScenarioOption(
  state: CampaignState,
  letter: ScenarioCardChoiceLetter,
): RewardEvent[] {
  const current = state.currentScenarioCard;
  if (!current) throw new Error("chooseScenarioOption: no card in-flight");
  if (current.resolved) {
    throw new Error(`chooseScenarioOption: card #${current.number} already resolved`);
  }
  const card = getScenarioCard(current.number);
  const choice = card.choices.find((c) => c.letter === letter);
  if (!choice) {
    throw new Error(`chooseScenarioOption: card #${current.number} has no choice "${letter}"`);
  }

  const events: RewardEvent[] = [];
  for (const effect of choice.effects) {
    events.push(...applyScenarioEffect(state, effect, current.number));
  }

  current.chosenOption = letter;
  // Only mark resolved if no interactive effect is pending.
  const hasPending = !!(
    current.pendingDieRoll ||
    current.pendingSubChoice ||
    current.pendingElementSpend
  );
  current.resolved = !hasPending;

  events.push({
    kind: "scenario-card-resolved",
    cardNumber: current.number,
    headline: `${card.printedId} — ${card.name.toUpperCase()}`,
    chosenOption: letter,
  });
  logEvent("engine.scenarioCard.choose", {
    number: current.number,
    name: card.name,
    chosenOption: letter,
    effectCount: choice.effects.length,
    hasPending,
    rewardEventKinds: events.map((e) => e.kind),
  });
  return events;
}

/**
 * Resolve a pending die-roll-outcome: look up the matching outcome
 * branch, apply its effects, clear `pendingDieRoll`, and set
 * `resolved = true`.
 *
 * Returns the reward events produced by the outcome's sub-effects
 * (empty for most outcomes; the caller accumulates them with any
 * events returned by `chooseScenarioOption` earlier).
 */
export function resolveScenarioDieRoll(
  state: CampaignState,
  roll: number,
): RewardEvent[] {
  const current = state.currentScenarioCard;
  if (!current) throw new Error("resolveScenarioDieRoll: no card in-flight");
  if (!current.pendingDieRoll) throw new Error("resolveScenarioDieRoll: no pending die roll");
  if (!current.chosenOption) throw new Error("resolveScenarioDieRoll: chosenOption is null");

  const card = getScenarioCard(current.number);
  const choice = card.choices.find((c) => c.letter === current.chosenOption)!;
  const dieRollEffect = choice.effects.find((e) => e.kind === "die-roll-outcome");
  if (!dieRollEffect || dieRollEffect.kind !== "die-roll-outcome") {
    throw new Error("resolveScenarioDieRoll: card choice has no die-roll-outcome effect");
  }

  const outcome = dieRollEffect.outcomes.find(
    (o) => roll >= o.minRoll && roll <= o.maxRoll,
  );
  if (!outcome) {
    throw new Error(`resolveScenarioDieRoll: no outcome for roll ${roll}`);
  }

  // Store the rolled value for the UI to show the result.
  current.pendingDieRoll.rolled = roll;

  const events: RewardEvent[] = [];
  for (const subEffect of outcome.effects) {
    events.push(...applyScenarioEffect(state, subEffect, current.number));
  }

  current.pendingDieRoll = undefined;
  // Resolved only if no OTHER pending interaction was spawned by the sub-effects.
  current.resolved = !(current.pendingSubChoice || current.pendingElementSpend);

  logEvent("engine.scenarioCard.resolveDieRoll", {
    number: current.number,
    chosenOption: current.chosenOption,
    roll,
    outcomeLabel: outcome.label,
    subEffectCount: outcome.effects.length,
  });
  return events;
}

/**
 * Resolve a pending pick-one-outcome: apply the chosen option's
 * effects, clear `pendingSubChoice`, and set `resolved = true`.
 */
export function resolveScenarioSubChoice(
  state: CampaignState,
  optionIdx: number,
): RewardEvent[] {
  const current = state.currentScenarioCard;
  if (!current) throw new Error("resolveScenarioSubChoice: no card in-flight");
  if (!current.pendingSubChoice) throw new Error("resolveScenarioSubChoice: no pending sub-choice");
  if (!current.chosenOption) throw new Error("resolveScenarioSubChoice: chosenOption is null");

  const card = getScenarioCard(current.number);
  const choice = card.choices.find((c) => c.letter === current.chosenOption)!;
  const pickEffect = choice.effects.find((e) => e.kind === "pick-one-outcome");
  if (!pickEffect || pickEffect.kind !== "pick-one-outcome") {
    throw new Error("resolveScenarioSubChoice: card choice has no pick-one-outcome effect");
  }

  const option = pickEffect.options[optionIdx];
  if (!option) {
    throw new Error(`resolveScenarioSubChoice: no option at index ${optionIdx}`);
  }

  const events: RewardEvent[] = [];
  for (const subEffect of option.effects) {
    events.push(...applyScenarioEffect(state, subEffect, current.number));
  }

  current.pendingSubChoice = undefined;
  current.resolved = !(current.pendingDieRoll || current.pendingElementSpend);

  logEvent("engine.scenarioCard.resolveSubChoice", {
    number: current.number,
    chosenOption: current.chosenOption,
    optionIdx,
    optionLabel: option.label,
  });
  return events;
}

/**
 * Resolve a pending spend-element-for-shop-products interaction.
 * `heroId = null` means the player chose to skip (no element spent,
 * no shop product added). Otherwise, spends the first available
 * element from the delver's bag and adds the products.
 */
export function resolveScenarioElementSpend(
  state: CampaignState,
  heroId: string | null,
): RewardEvent[] {
  const current = state.currentScenarioCard;
  if (!current) throw new Error("resolveScenarioElementSpend: no card in-flight");
  if (!current.pendingElementSpend) throw new Error("resolveScenarioElementSpend: no pending element spend");

  const { products } = current.pendingElementSpend;
  const events: RewardEvent[] = [];

  if (heroId !== null) {
    // Spend the first available element from the chosen delver's bag.
    const bag = state.elements[heroId];
    if (bag) {
      for (const [elemKey, count] of Object.entries(bag)) {
        if (count && count > 0) {
          bag[elemKey as keyof typeof bag] = (count - 1) as typeof count;
          logEvent("engine.scenarioCard.spendElement", { heroId, element: elemKey });
          break;
        }
      }
    }
    // Add the shop products.
    const added: number[] = [];
    for (const n of products) {
      if (!state.shopProductsAvailable.includes(n)) {
        const allOwned = Object.values(state.shopProductsOwned).flat();
        if (!allOwned.includes(n)) {
          state.shopProductsAvailable.push(n);
          added.push(n);
        }
      }
    }
    logEvent("engine.scenarioCard.elementSpendProducts", {
      heroId,
      products,
      added,
    });
    if (added.length > 0) {
      events.push({ kind: "shop-products-added", productNumbers: added });
    }
  } else {
    logEvent("engine.scenarioCard.elementSpendSkipped", { products });
  }

  current.pendingElementSpend = undefined;
  current.resolved = !(current.pendingDieRoll || current.pendingSubChoice);

  return events;
}

/**
 * Close the in-flight card. Requires `resolved === true` (all
 * interactive effects must have been fully resolved).
 */
export function closeScenarioCard(state: CampaignState): void {
  const current = state.currentScenarioCard;
  if (!current) {
    logEvent("engine.scenarioCard.close.skip", { reason: "no-card-in-flight" });
    return;
  }
  if (!current.resolved) {
    throw new Error(`closeScenarioCard: card #${current.number} is not resolved yet`);
  }
  if (!state.scenarioCardsResolved.includes(current.number)) {
    state.scenarioCardsResolved.push(current.number);
  }
  const closed = current.number;
  state.currentScenarioCard = null;
  logEvent("engine.scenarioCard.close", {
    number: closed,
    resolvedTotal: state.scenarioCardsResolved.length,
  });
}

export function hasScenarioCardBeenResolved(state: CampaignState, number: number): boolean {
  return state.scenarioCardsResolved.includes(number);
}

// ----------------- Effect application -----------------

/**
 * Apply a single auto-applied effect to state. Returns reward events
 * for mutations the rewards modal might surface.
 *
 * Interactive effects (`die-roll-outcome`, `pick-one-outcome`,
 * `spend-element-for-shop-products`) set pending state on
 * `state.currentScenarioCard` and return [] — the actual outcome
 * effects are applied by the `resolveScenario*` functions.
 */
/**
 * Apply a scenario-style effect outside a Scenario Card — used by Ch3+
 * quest End-of-Wave entries ("Delvers gain 2 elements", "heal up to 2
 * HP", "gain a Level card") once the next wave's encounter exists.
 * Interactive kinds (die roll / pick-one / spend-element) need a card in
 * flight and are rejected.
 */
export function applyQuestCarryEffect(state: CampaignState, effect: ScenarioCardEffect): RewardEvent[] {
  if (effect.kind === "die-roll-outcome" || effect.kind === "pick-one-outcome" || effect.kind === "spend-element-for-shop-products") {
    throw new Error(`applyQuestCarryEffect: interactive effect ${effect.kind} needs a scenario card`);
  }
  return applyScenarioEffect(state, effect, 0);
}

function applyScenarioEffect(
  state: CampaignState,
  effect: ScenarioCardEffect,
  cardNumber: number,
): RewardEvent[] {
  switch (effect.kind) {

    case "heal-both-delvers":
    case "heal-both-delvers-full": {
      const events: RewardEvent[] = [];
      for (const heroId of Object.keys(state.loadouts)) {
        const lo = state.loadouts[heroId]!;
        const before = lo.currentHp;
        lo.currentHp = effect.kind === "heal-both-delvers-full"
          ? lo.maxHp
          : Math.min(lo.maxHp, lo.currentHp + effect.amount);
        const after = lo.currentHp;
        logEvent("engine.scenarioCard.heal", { heroId, kind: effect.kind, before, after });
        // Emit a reward event for every NON-NOOP heal so the
        // rewards modal can surface "Mind Delver +1 HP". Skip the
        // no-op case (already at max HP) so the player never sees
        // a "+0 HP" card.
        if (after > before) {
          events.push({
            kind: "delver-healed",
            heroId,
            amount: after - before,
            before,
            after,
          });
        }
      }
      return events;
    }

    case "reduce-max-hp-both": {
      for (const heroId of Object.keys(state.loadouts)) {
        const lo = state.loadouts[heroId]!;
        const beforeMax = lo.maxHp;
        const beforeCurrent = lo.currentHp;
        lo.maxHp = Math.max(1, lo.maxHp - effect.amount);
        if (lo.currentHp > lo.maxHp) lo.currentHp = lo.maxHp;
        logEvent("engine.scenarioCard.maxHpLoss", {
          heroId, amount: effect.amount,
          beforeMax, afterMax: lo.maxHp, beforeCurrent, afterCurrent: lo.currentHp,
        });
      }
      return [];
    }

    case "grant-element-choice-each": {
      const enc = state.encounter;
      if (!enc) return [];
      const heroIds = Object.keys(state.loadouts);
      for (let pick = 0; pick < effect.amount; pick++) {
        for (const heroId of heroIds) {
          enc.pendingElementChoices.push({
            heroId,
            source: { kind: "scenario-card", cardNumber },
          });
          logEvent("engine.scenarioCard.enqueueElementChoice", { heroId, cardNumber, pick });
        }
      }
      return [];
    }

    case "grant-level-up-card": {
      // Mirrors `engine/kills.ts > applyPendingLevelUps`: bump the
      // `levelUpCardsOwed` bookkeeping counter AND enqueue one
      // round of draws per level-up (one per delver, active delver
      // first) onto `encounter.pendingLevelUpDraws`. Without the
      // enqueue step the LevelUpModal never auto-opens after the
      // scenario card closes because the gate watches the per-
      // encounter queue, not the global counter (the counter is a
      // long-running campaign-scope debt tally; the queue is what
      // the UI actually drains).
      const before = state.levelUpCardsOwed;
      state.levelUpCardsOwed += effect.amount;
      let drawsEnqueued = 0;
      if (state.encounter && effect.amount > 0) {
        const all = Object.keys(state.loadouts);
        const active = state.currentDelverId;
        // Active delver draws first so the UI feels natural for the
        // player who triggered the scenario card resolution. Falls
        // back to plain `all` if the active id isn't in the loadouts
        // map (defensive — shouldn't happen).
        const heroIds = all.includes(active)
          ? [active, ...all.filter((id) => id !== active)]
          : all;
        for (let i = 0; i < effect.amount; i++) {
          drawsEnqueued += enqueueLevelUpDraws(state, heroIds);
        }
      }
      logEvent("engine.scenarioCard.grantLevelUp", {
        amount: effect.amount,
        before,
        after: state.levelUpCardsOwed,
        drawsEnqueued,
        hasEncounter: state.encounter !== null,
      });
      return [];
    }

    case "gain-scar-both-delvers": {
      for (const heroId of Object.keys(state.loadouts)) {
        if (!state.scars[heroId]) state.scars[heroId] = [];
        if (!state.scars[heroId]!.includes(effect.keyword)) {
          state.scars[heroId]!.push(effect.keyword);
        }
        logEvent("engine.scenarioCard.gainScar", { heroId, keyword: effect.keyword });
      }
      return [];
    }

    case "grant-equipment-rank-one-delver": {
      const enqueued = enqueueSuitConditionRankPicks(
        state,
        `scenario-card-${cardNumber}-rank`,
        [{ delta: effect.amount, pinnedType: effect.equipmentType }],
      );
      logEvent("engine.scenarioCard.enqueueRankPick", {
        cardNumber, equipmentType: effect.equipmentType, amount: effect.amount,
        pickId: enqueued[0]?.pickId ?? "?",
      });
      return [];
    }

    case "gain-xp": {
      state.xpOnHand += effect.amount;
      state.totalXp += effect.amount;
      logEvent("engine.scenarioCard.gainXp", {
        cardNumber, amount: effect.amount, xpOnHand: state.xpOnHand,
      });
      return [];
    }

    case "lose-hp-both-floor-at-one": {
      for (const heroId of Object.keys(state.loadouts)) {
        const lo = state.loadouts[heroId]!;
        const before = lo.currentHp;
        lo.currentHp = Math.max(1, lo.currentHp - effect.amount);
        logEvent("engine.scenarioCard.loseHpFloor1", {
          heroId, amount: effect.amount, before, after: lo.currentHp,
        });
      }
      return [];
    }

    case "lose-all-elements-both": {
      for (const heroId of Object.keys(state.loadouts)) {
        const bag = state.elements[heroId];
        if (bag) {
          for (const key of Object.keys(bag)) {
            (bag as Record<string, number>)[key] = 0;
          }
        }
        logEvent("engine.scenarioCard.loseAllElements", { heroId });
      }
      return [];
    }

    case "lose-hp-one-delver-floor-at-one": {
      // Queue a delver pick; the actual HP loss is applied when the player
      // chooses via the scenario-delver-pick modal after the card closes.
      const pick: PendingScenarioDelverPick = {
        pickId: `scenario-card-${cardNumber}-lose-hp-${Date.now()}`,
        rewardLabel: `lose ${effect.amount} HP (can't drop below 1)`,
        reward: { kind: "lose-hp-floor-at-one", amount: effect.amount },
        source: `scenario-card-${cardNumber}`,
      };
      state.pendingScenarioDelverPicks.push(pick);
      logEvent("engine.scenarioCard.queueLoseHp", { cardNumber, pickId: pick.pickId });
      return [];
    }

    case "grant-consumable-token-one-delver": {
      const tokenLabel = effect.tokenKind === "prevent-counterattack"
        ? "BLOCK COUNTERATTACK token"
        : `${effect.amount}× ${effect.tokenKind} token`;
      const pick: PendingScenarioDelverPick = {
        pickId: `scenario-card-${cardNumber}-token-${Date.now()}`,
        rewardLabel: `gain ${effect.amount} ${tokenLabel}`,
        reward: { kind: "consumable-token", tokenKind: effect.tokenKind, amount: effect.amount },
        source: `scenario-card-${cardNumber}`,
      };
      state.pendingScenarioDelverPicks.push(pick);
      logEvent("engine.scenarioCard.queueTokenGrant", {
        cardNumber, tokenKind: effect.tokenKind, amount: effect.amount, pickId: pick.pickId,
      });
      return [];
    }

    case "grant-ap-one-delver": {
      const pick: PendingScenarioDelverPick = {
        pickId: `scenario-card-${cardNumber}-ap-${Date.now()}`,
        rewardLabel: `gain +${effect.amount} AP`,
        reward: { kind: "gain-ap", amount: effect.amount },
        source: `scenario-card-${cardNumber}`,
      };
      state.pendingScenarioDelverPicks.push(pick);
      logEvent("engine.scenarioCard.queueApGrant", {
        cardNumber, amount: effect.amount, pickId: pick.pickId,
      });
      return [];
    }

    case "shift-favour-by-scenario": {
      // Delegate to the town-visit shift-favour action so all the same
      // Vera-shield and opinion-card-cascade logic fires uniformly.
      const favEvents = runTownVisitAction(state, {
        kind: "shift-favour",
        characterId: effect.characterId,
        characterName: effect.characterName,
        delta: effect.delta,
      });
      logEvent("engine.scenarioCard.shiftFavour", {
        cardNumber,
        characterId: effect.characterId,
        delta: effect.delta,
      });
      return favEvents;
    }

    case "reveal-quest-or-grant-chip": {
      // Delegate to the town-visit action so the "already owned or
      // completed -> Memory Chip instead" fallback behaves identically.
      const questEvents = runTownVisitAction(state, {
        kind: "reveal-quest-or-grant-chip",
        number: effect.number,
        name: effect.name,
        chipFallback: effect.chipFallback,
      });
      logEvent("engine.scenarioCard.revealQuestOrChip", {
        cardNumber, number: effect.number, chipFallback: effect.chipFallback,
      });
      return questEvents;
    }

    case "add-shop-products": {
      const added: number[] = [];
      for (const n of effect.products) {
        if (!state.shopProductsAvailable.includes(n)) {
          const allOwned = Object.values(state.shopProductsOwned).flat();
          if (!allOwned.includes(n)) {
            state.shopProductsAvailable.push(n);
            added.push(n);
          }
        }
      }
      logEvent("engine.scenarioCard.addShopProducts", {
        cardNumber, requested: effect.products, added,
      });
      if (added.length > 0) {
        return [{ kind: "shop-products-added", productNumbers: added }];
      }
      return [];
    }

    case "grant-friendly-spawn-card": {
      return grantFriendlySpawnCard(state);
    }

    case "die-roll-outcome": {
      // Interactive: set pending state; effects applied by resolveScenarioDieRoll.
      const current = state.currentScenarioCard;
      if (current) {
        current.pendingDieRoll = {
          outcomeLabels: effect.outcomes.map((o) => o.label),
        };
      }
      return [];
    }

    case "pick-one-outcome": {
      // Interactive: set pending state; effects applied by resolveScenarioSubChoice.
      const current = state.currentScenarioCard;
      if (current) {
        current.pendingSubChoice = {
          optionLabels: effect.options.map((o) => o.label),
        };
      }
      return [];
    }

    case "spend-element-for-shop-products": {
      // Interactive: set pending state; effects applied by resolveScenarioElementSpend.
      const current = state.currentScenarioCard;
      if (current) {
        current.pendingElementSpend = { products: effect.products };
      }
      return [];
    }
  }
}

// Re-export the catalog-side types so callers (modal, tests) can
// import everything from this engine module without a separate
// `import` from `data.ts`.
export type { ScenarioCardChoice, ScenarioCardChoiceLetter };

/**
 * Apply a `PendingScenarioDelverPick` for the chosen `heroId`,
 * mutating state in place. Removes the entry from the queue
 * regardless of whether it was found (idempotent).
 *
 * Called by `ScenarioDelverPickModal` after the player taps a
 * delver button; the modal saves state and refreshes the UI.
 */
export function applyScenarioDelverPick(
  state: CampaignState,
  pickId: string,
  heroId: string,
): void {
  const idx = state.pendingScenarioDelverPicks.findIndex((p) => p.pickId === pickId);
  if (idx < 0) return;
  const pick = state.pendingScenarioDelverPicks[idx]!;
  state.pendingScenarioDelverPicks.splice(idx, 1);

  const reward = pick.reward;
  const lo = state.loadouts[heroId];

  switch (reward.kind) {
    case "consumable-token":
      grantToken(state, heroId, reward.tokenKind, reward.amount);
      logEvent("engine.scenarioCard.applyTokenGrant", {
        heroId, tokenKind: reward.tokenKind, amount: reward.amount, pickId,
      });
      break;

    case "gain-ap":
      if (lo) {
        lo.currentAp += reward.amount;
        lo.baseAp += reward.amount;
        logEvent("engine.scenarioCard.applyApGrant", {
          heroId, amount: reward.amount, pickId,
        });
      }
      break;

    case "lose-hp-floor-at-one":
      if (lo) {
        const before = lo.currentHp;
        lo.currentHp = Math.max(1, lo.currentHp - reward.amount);
        logEvent("engine.scenarioCard.applyHpLoss", {
          heroId, amount: reward.amount, before, after: lo.currentHp, pickId,
        });
      }
      break;
  }
}
