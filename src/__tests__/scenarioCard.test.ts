/**
 * Scenario Card engine — coverage for `engine/scenarioCard.ts`
 * and the wave-start trigger wiring in `engine/encounter.ts`.
 *
 * Covers:
 *   - `startScenarioCard`: happy path, idempotency vs already-
 *     resolved, idempotency vs already-in-flight, throw on
 *     unknown id.
 *   - `chooseScenarioOption`: happy path for #01 (heal-both),
 *     happy path for #02 (max-HP loss + level-up grant), throws
 *     on no card in-flight, throws on double-resolve, throws on
 *     unknown letter.
 *   - Auto-applied effects: heal clamped at maxHp; max-HP loss
 *     clamps current HP and floors maxHp at 1; element grant
 *     adds to bag; level-up grant bumps the campaign counter.
 *   - `closeScenarioCard`: appends to `scenarioCardsResolved`,
 *     nulls `currentScenarioCard`, idempotent against already-
 *     cleared state, throws on unresolved card.
 *   - `bootstrapWaveAtNumber`: wave 1 never triggers (no
 *     `scenarioCardOnStart`); Q2 wave 2 sets card #1; a wave
 *     re-bootstrap doesn't reset a partial pick; a wave whose
 *     card has already been resolved doesn't re-trigger.
 */

import { describe, it, expect } from "vitest";
import { newCampaign, type CampaignState } from "../state";
import {
  chooseScenarioOption,
  closeScenarioCard,
  hasScenarioCardBeenResolved,
  resolveScenarioDieRoll,
  resolveScenarioElementSpend,
  startScenarioCard,
} from "../engine/scenarioCard";
import { bootstrapWaveAtNumber, ensureEncounter } from "../engine/encounter";
import { QUEST1, QUEST2 } from "../data";

function freshState(): CampaignState {
  return newCampaign();
}

/**
 * Test helper — campaign + a deterministic Q1W1 encounter so the
 * scenario-card level-up tests can assert
 * `encounter.pendingLevelUpDraws` mutations. The level-up deck
 * shuffle is replaced with an identity callback so the per-test
 * deck order is stable across runs.
 */
function freshStateWithEncounter(): CampaignState {
  const s = newCampaign();
  ensureEncounter(s, QUEST1, (pool) => [...pool]);
  return s;
}

// ---------- startScenarioCard --------------------------------------------

describe("startScenarioCard", () => {
  it("populates currentScenarioCard on the happy path", () => {
    const s = freshState();
    startScenarioCard(s, 1);
    expect(s.currentScenarioCard).toEqual({
      number: 1,
      chosenOption: null,
      resolved: false,
    });
  });

  it("is a no-op when the card number is already in scenarioCardsResolved", () => {
    const s = freshState();
    s.scenarioCardsResolved.push(1);
    startScenarioCard(s, 1);
    expect(s.currentScenarioCard).toBeNull();
  });

  it("is a no-op when the same card is already in-flight (debug re-bootstrap)", () => {
    const s = freshState();
    startScenarioCard(s, 1);
    s.currentScenarioCard!.chosenOption = "A";
    s.currentScenarioCard!.resolved = true;
    // Re-fire — should not wipe the partial pick.
    startScenarioCard(s, 1);
    expect(s.currentScenarioCard).toEqual({
      number: 1,
      chosenOption: "A",
      resolved: true,
    });
  });

  it("throws when the card number isn't in the catalog", () => {
    const s = freshState();
    expect(() => startScenarioCard(s, 9999)).toThrow(/unknown card number/);
    expect(s.currentScenarioCard).toBeNull();
  });
});

// ---------- chooseScenarioOption — error paths ---------------------------

describe("chooseScenarioOption — error paths", () => {
  it("throws when no card is in-flight", () => {
    const s = freshState();
    expect(() => chooseScenarioOption(s, "A")).toThrow(/no card in-flight/);
  });

  it("throws on double-resolve", () => {
    const s = freshState();
    startScenarioCard(s, 1);
    chooseScenarioOption(s, "A");
    expect(() => chooseScenarioOption(s, "B")).toThrow(/already resolved/);
  });

  it("throws on an unknown letter for the in-flight card", () => {
    const s = freshState();
    startScenarioCard(s, 1);
    expect(() =>
      chooseScenarioOption(s, "Z" as unknown as "A"),
    ).toThrow(/has no choice "Z"/);
  });
});

// ---------- chooseScenarioOption — Card #01 (Sparkle) --------------------

describe("chooseScenarioOption — Card #01 (Sparkle)", () => {
  it("A (Leave alone): heals both delvers by 1 HP (clamped at maxHp)", () => {
    const s = freshState();
    s.loadouts["hero-01"]!.currentHp = 3;
    s.loadouts["hero-02"]!.currentHp = 5;
    const initialMax = s.loadouts["hero-02"]!.maxHp;
    startScenarioCard(s, 1);
    const events = chooseScenarioOption(s, "A");
    expect(s.loadouts["hero-01"]!.currentHp).toBe(4);
    // Hero-02 was at 5; if maxHp >= 6 the heal lands at 6,
    // otherwise the clamp keeps it at maxHp.
    expect(s.loadouts["hero-02"]!.currentHp).toBe(Math.min(initialMax, 6));
    expect(events.at(-1)).toMatchObject({
      kind: "scenario-card-resolved",
      cardNumber: 1,
      chosenOption: "A",
    });
  });

  it("A: heal does NOT push current HP past maxHp", () => {
    const s = freshState();
    s.loadouts["hero-01"]!.currentHp = s.loadouts["hero-01"]!.maxHp;
    startScenarioCard(s, 1);
    chooseScenarioOption(s, "A");
    expect(s.loadouts["hero-01"]!.currentHp).toBe(s.loadouts["hero-01"]!.maxHp);
  });

  it("A: emits a `delver-healed` reward event per healed delver (so the rewards modal surfaces +1 HP)", () => {
    const s = freshState();
    s.loadouts["hero-01"]!.currentHp = 3;
    s.loadouts["hero-02"]!.currentHp = 5;
    const max02 = s.loadouts["hero-02"]!.maxHp;
    startScenarioCard(s, 1);
    const events = chooseScenarioOption(s, "A");
    const heals = events.filter((e) => e.kind === "delver-healed");
    expect(heals).toHaveLength(2);
    expect(heals).toContainEqual({
      kind: "delver-healed",
      heroId: "hero-01",
      amount: 1,
      before: 3,
      after: 4,
    });
    const expectedAfter02 = Math.min(max02, 6);
    expect(heals).toContainEqual({
      kind: "delver-healed",
      heroId: "hero-02",
      amount: expectedAfter02 - 5,
      before: 5,
      after: expectedAfter02,
    });
  });

  it("A: SUPPRESSES `delver-healed` for delvers already at maxHp (no `+0 HP` cards in the modal)", () => {
    const s = freshState();
    s.loadouts["hero-01"]!.currentHp = s.loadouts["hero-01"]!.maxHp;
    s.loadouts["hero-02"]!.currentHp = 1;
    startScenarioCard(s, 1);
    const events = chooseScenarioOption(s, "A");
    const heals = events.filter((e) => e.kind === "delver-healed");
    // Only hero-02 should produce a heal event; hero-01 was a no-op.
    expect(heals).toHaveLength(1);
    expect(heals[0]).toMatchObject({ heroId: "hero-02", amount: 1, before: 1, after: 2 });
  });

  it("B (Try to capture): reduces max HP for both delvers by 1 and clamps current HP", () => {
    const s = freshState();
    const beforeMax01 = s.loadouts["hero-01"]!.maxHp;
    const beforeMax02 = s.loadouts["hero-02"]!.maxHp;
    s.loadouts["hero-01"]!.currentHp = beforeMax01;
    s.loadouts["hero-02"]!.currentHp = beforeMax02;
    startScenarioCard(s, 1);
    chooseScenarioOption(s, "B");
    expect(s.loadouts["hero-01"]!.maxHp).toBe(beforeMax01 - 1);
    expect(s.loadouts["hero-02"]!.maxHp).toBe(beforeMax02 - 1);
    expect(s.loadouts["hero-01"]!.currentHp).toBe(beforeMax01 - 1);
    expect(s.loadouts["hero-02"]!.currentHp).toBe(beforeMax02 - 1);
  });

  it("B: maxHp is floored at 1 (defensive — printed cards don't go past -1)", () => {
    const s = freshState();
    s.loadouts["hero-01"]!.maxHp = 1;
    s.loadouts["hero-01"]!.currentHp = 1;
    startScenarioCard(s, 1);
    chooseScenarioOption(s, "B");
    expect(s.loadouts["hero-01"]!.maxHp).toBe(1);
    expect(s.loadouts["hero-01"]!.currentHp).toBe(1);
  });

  it("C (Follow it): enqueues 1 element-of-choice pick per delver onto the encounter queue", () => {
    // `grant-element-choice-each` doesn't auto-grant a default element
    // — it stages a `PendingElementChoice` for each delver so the
    // ElementPickModal can prompt the player to pick which element.
    // Without an active encounter the effect is a silent no-op
    // (defensive guard in `applyScenarioEffect`).
    const s = freshStateWithEncounter();
    const enc = s.encounter!;
    const queueBefore = enc.pendingElementChoices.length;
    startScenarioCard(s, 1);
    chooseScenarioOption(s, "C");
    const enqueued = enc.pendingElementChoices.slice(queueBefore);
    // amount=1 × 2 delvers = 2 pending picks.
    expect(enqueued.length).toBe(2);
    expect(enqueued.map((p) => p.heroId).sort()).toEqual(["hero-01", "hero-02"]);
    for (const pick of enqueued) {
      expect(pick.source).toEqual({ kind: "scenario-card", cardNumber: 1 });
    }
  });

  it("C (Follow it): leaves existing element bags untouched (picks go through the modal, not the engine)", () => {
    // Sanity guard that the staging path NEVER mutates `state.elements`
    // directly — the bag only changes once `applyElementChoice` runs
    // (separate test surface in `__tests__/levelUp.test.ts` + others).
    const s = freshStateWithEncounter();
    s.elements["hero-01"] = { earth: 2, fire: 1 };
    startScenarioCard(s, 1);
    chooseScenarioOption(s, "C");
    expect(s.elements["hero-01"]?.earth).toBe(2);
    expect(s.elements["hero-01"]?.fire).toBe(1);
  });

  it("C (Follow it) without an encounter: silently no-ops (no queue, no element mutation)", () => {
    const s = freshState();
    expect(s.encounter).toBeNull();
    startScenarioCard(s, 1);
    chooseScenarioOption(s, "C");
    expect(s.elements["hero-01"]?.earth ?? 0).toBe(0);
    expect(s.elements["hero-02"]?.earth ?? 0).toBe(0);
  });
});

// ---------- chooseScenarioOption — Card #02 (Cold) -----------------------

describe("chooseScenarioOption — Card #02 (Cold)", () => {
  it("A (Warm up): heals both delvers by 2 HP", () => {
    const s = freshState();
    s.loadouts["hero-01"]!.currentHp = 1;
    s.loadouts["hero-02"]!.currentHp = 2;
    startScenarioCard(s, 2);
    chooseScenarioOption(s, "A");
    expect(s.loadouts["hero-01"]!.currentHp).toBe(3);
    expect(s.loadouts["hero-02"]!.currentHp).toBe(4);
  });

  it("B (Search inside): bumps the shared LEVEL UP card counter by 1 (no encounter -> no queue enqueue)", () => {
    // Without an active encounter the staging queue can't be
    // touched; the campaign-scope counter still bumps so a future
    // encounter can drain the debt some other way (today: never —
    // this branch is only exercised by older saves loaded outside
    // a wave; in production the scenario card only fires mid-wave
    // so `state.encounter` is always populated).
    const s = freshState();
    const before = s.levelUpCardsOwed;
    startScenarioCard(s, 2);
    chooseScenarioOption(s, "B");
    expect(s.levelUpCardsOwed).toBe(before + 1);
    expect(s.encounter).toBeNull();
  });

  it("B (Search inside): bumps the counter AND enqueues 1 round of pending Level-Up draws (one per delver) when in an encounter", () => {
    // Mirrors `engine/kills.ts > applyPendingLevelUps`: each
    // amount=1 grants one level-up event = one draw per delver.
    // The BoardScreen auto-open hook then mounts the LevelUpModal.
    const s = freshStateWithEncounter();
    const enc = s.encounter!;
    const before = s.levelUpCardsOwed;
    const queueBefore = enc.pendingLevelUpDraws.length;
    startScenarioCard(s, 2);
    chooseScenarioOption(s, "B");
    expect(s.levelUpCardsOwed).toBe(before + 1);
    // 2 draws enqueued (one per delver), in active-delver-first order.
    expect(enc.pendingLevelUpDraws.length).toBe(queueBefore + 2);
    const enqueued = enc.pendingLevelUpDraws.slice(queueBefore);
    const active = s.currentDelverId;
    const other = Object.keys(s.loadouts).find((id) => id !== active)!;
    expect(enqueued[0]!.heroId).toBe(active);
    expect(enqueued[1]!.heroId).toBe(other);
    // Each draw locked to a real base level-up card number.
    for (const draw of enqueued) {
      expect(draw.cardNumber).toBeGreaterThanOrEqual(1);
    }
  });

  it("C (Search outside): reduces max HP for both delvers by 1 (Sword bump is MANUAL)", () => {
    const s = freshState();
    const beforeMax01 = s.loadouts["hero-01"]!.maxHp;
    const beforeMax02 = s.loadouts["hero-02"]!.maxHp;
    startScenarioCard(s, 2);
    chooseScenarioOption(s, "C");
    expect(s.loadouts["hero-01"]!.maxHp).toBe(beforeMax01 - 1);
    expect(s.loadouts["hero-02"]!.maxHp).toBe(beforeMax02 - 1);
    // Sword rank bump is intentionally NOT auto-applied (out of
    // scope for v1 — the picker would need a sword-availability
    // filter). Equipment ranks should be untouched.
    expect(s.equipmentRanks["hero-01"]!.Sword).toBe(0);
  });
});

// ---------- chooseScenarioOption — option-A smoke (no-loadout-mutation) --

describe("chooseScenarioOption — option-A smoke sweep (no loadout mutation)", () => {
  // Cards whose option-A flips to resolved=true AND leaves
  // loadouts (HP) + the level-up counter untouched. Anything with
  // interactive effects (#7 die-roll, #101 element-spend), grant-
  // level-up-card effects (#4), or HP mutations (#1, #2) lives in
  // its own dedicated describe block above/below.
  it.each([3, 5, 6, 8, 9, 100])(
    "card #%d option A: resolves cleanly without touching HP or levelUpCardsOwed",
    (cardNumber) => {
      const s = freshState();
      const before01Hp = s.loadouts["hero-01"]!.currentHp;
      const before02Hp = s.loadouts["hero-02"]!.currentHp;
      const beforeLevelUps = s.levelUpCardsOwed;
      startScenarioCard(s, cardNumber);
      const events = chooseScenarioOption(s, "A");
      expect(s.currentScenarioCard?.chosenOption).toBe("A");
      expect(s.currentScenarioCard?.resolved).toBe(true);
      expect(s.loadouts["hero-01"]!.currentHp).toBe(before01Hp);
      expect(s.loadouts["hero-02"]!.currentHp).toBe(before02Hp);
      expect(s.levelUpCardsOwed).toBe(beforeLevelUps);
      // Always at least the headline reward event in the batch
      // so the post-Continue rewards modal renders SOMETHING.
      expect(events.at(-1)?.kind).toBe("scenario-card-resolved");
    },
  );
});

// ---------- chooseScenarioOption — Card #04 (Outpost) -------------------

describe("chooseScenarioOption — Card #04 (Outpost)", () => {
  it("A (Lie to Arlen): grants 2 LEVEL UP cards AND drops Arlen's favour by 1", () => {
    // Card #04-A's effects: `grant-level-up-card amount=2` +
    // `shift-favour-by-scenario arlen -1`. Each amount=1 of the
    // level-up grant enqueues one round of draws (one per delver),
    // so amount=2 should land 4 entries on the encounter queue
    // AND bump the campaign-scope `levelUpCardsOwed` debt by 2.
    const s = freshStateWithEncounter();
    const enc = s.encounter!;
    const beforeLevelUps = s.levelUpCardsOwed;
    const beforeArlen = s.favour["arlen"]?.value ?? 0;
    const queueBefore = enc.pendingLevelUpDraws.length;
    startScenarioCard(s, 4);
    chooseScenarioOption(s, "A");
    expect(s.currentScenarioCard?.resolved).toBe(true);
    expect(s.levelUpCardsOwed).toBe(beforeLevelUps + 2);
    expect(enc.pendingLevelUpDraws.length).toBe(queueBefore + 4);
    expect(s.favour["arlen"]?.value ?? 0).toBe(beforeArlen - 1);
  });

  it("A without an encounter: still bumps the counter and favour, just no queue draws", () => {
    // Matches the kills.ts behavior — the counter accumulates even
    // when no encounter is around to host the per-wave queue.
    const s = freshState();
    expect(s.encounter).toBeNull();
    const beforeLevelUps = s.levelUpCardsOwed;
    startScenarioCard(s, 4);
    chooseScenarioOption(s, "A");
    expect(s.levelUpCardsOwed).toBe(beforeLevelUps + 2);
    expect(s.favour["arlen"]?.value ?? 0).toBe(-1);
  });
});

// ---------- chooseScenarioOption — Card #07 (Directions) ----------------

describe("chooseScenarioOption — Card #07 (Directions, interactive)", () => {
  it("A (Tell Samantha): leaves the card unresolved with a pendingDieRoll", () => {
    // `die-roll-outcome` is interactive — `resolved` must stay false
    // until `resolveScenarioDieRoll` runs.
    const s = freshState();
    startScenarioCard(s, 7);
    chooseScenarioOption(s, "A");
    expect(s.currentScenarioCard?.chosenOption).toBe("A");
    expect(s.currentScenarioCard?.resolved).toBe(false);
    expect(s.currentScenarioCard?.pendingDieRoll).toBeTruthy();
    expect(s.currentScenarioCard?.pendingDieRoll?.outcomeLabels.length).toBeGreaterThan(0);
  });

  it("A + roll 4-6 (good outcome): resolves and grants 1 LEVEL UP card", () => {
    const s = freshStateWithEncounter();
    const enc = s.encounter!;
    const beforeLevelUps = s.levelUpCardsOwed;
    const queueBefore = enc.pendingLevelUpDraws.length;
    startScenarioCard(s, 7);
    chooseScenarioOption(s, "A");
    resolveScenarioDieRoll(s, 4);
    expect(s.currentScenarioCard?.resolved).toBe(true);
    expect(s.currentScenarioCard?.pendingDieRoll).toBeFalsy();
    expect(s.levelUpCardsOwed).toBe(beforeLevelUps + 1);
    expect(enc.pendingLevelUpDraws.length).toBe(queueBefore + 2);
  });

  it("A + roll 1-2 (bad outcome): resolves and shifts Samantha's favour -1", () => {
    const s = freshState();
    const beforeSamantha = s.favour["samantha"]?.value ?? 0;
    startScenarioCard(s, 7);
    chooseScenarioOption(s, "A");
    resolveScenarioDieRoll(s, 1);
    expect(s.currentScenarioCard?.resolved).toBe(true);
    expect(s.favour["samantha"]?.value ?? 0).toBe(beforeSamantha - 1);
  });
});

// ---------- chooseScenarioOption — Card #101 (Heirloom) -----------------

describe("chooseScenarioOption — Card B / #101 (Heirloom, interactive)", () => {
  it("A (Lead us to the OS): leaves the card unresolved with a pendingElementSpend", () => {
    const s = freshState();
    startScenarioCard(s, 101);
    chooseScenarioOption(s, "A");
    expect(s.currentScenarioCard?.chosenOption).toBe("A");
    expect(s.currentScenarioCard?.resolved).toBe(false);
    expect(s.currentScenarioCard?.pendingElementSpend).toBeTruthy();
    expect(s.currentScenarioCard?.pendingElementSpend?.products).toEqual([37]);
  });

  it("A + spend an element: resolves and adds Shop Product #37", () => {
    const s = freshState();
    s.elements["hero-01"] = { fire: 1 };
    startScenarioCard(s, 101);
    chooseScenarioOption(s, "A");
    resolveScenarioElementSpend(s, "hero-01");
    expect(s.currentScenarioCard?.resolved).toBe(true);
    expect(s.currentScenarioCard?.pendingElementSpend).toBeFalsy();
    expect(s.elements["hero-01"]?.fire ?? 0).toBe(0);
    expect(s.shopProductsAvailable).toContain(37);
  });

  it("A + skip (heroId=null): resolves WITHOUT adding the shop product or spending an element", () => {
    const s = freshState();
    s.elements["hero-01"] = { fire: 1 };
    startScenarioCard(s, 101);
    chooseScenarioOption(s, "A");
    resolveScenarioElementSpend(s, null);
    expect(s.currentScenarioCard?.resolved).toBe(true);
    expect(s.elements["hero-01"]?.fire).toBe(1);
    expect(s.shopProductsAvailable).not.toContain(37);
  });
});

// ---------- closeScenarioCard --------------------------------------------

describe("closeScenarioCard", () => {
  it("appends the card number to scenarioCardsResolved and nulls currentScenarioCard", () => {
    const s = freshState();
    startScenarioCard(s, 1);
    chooseScenarioOption(s, "A");
    closeScenarioCard(s);
    expect(s.currentScenarioCard).toBeNull();
    expect(s.scenarioCardsResolved).toEqual([1]);
  });

  it("does not double-push the number if it's somehow already in scenarioCardsResolved", () => {
    const s = freshState();
    startScenarioCard(s, 1);
    chooseScenarioOption(s, "A");
    // Force the duplicate scenario (defensive — shouldn't happen
    // in practice because `startScenarioCard` early-returns when
    // the number is already in scenarioCardsResolved).
    s.scenarioCardsResolved.push(1);
    closeScenarioCard(s);
    expect(s.scenarioCardsResolved).toEqual([1]);
  });

  it("throws when the card is not resolved yet", () => {
    const s = freshState();
    startScenarioCard(s, 1);
    expect(() => closeScenarioCard(s)).toThrow(/not resolved yet/);
  });

  it("is a no-op when no card is in-flight", () => {
    const s = freshState();
    closeScenarioCard(s);
    expect(s.scenarioCardsResolved).toEqual([]);
  });
});

// ---------- hasScenarioCardBeenResolved ----------------------------------

describe("hasScenarioCardBeenResolved", () => {
  it("returns false for an unresolved card", () => {
    const s = freshState();
    expect(hasScenarioCardBeenResolved(s, 1)).toBe(false);
  });

  it("returns true after a full lifecycle", () => {
    const s = freshState();
    startScenarioCard(s, 1);
    chooseScenarioOption(s, "A");
    closeScenarioCard(s);
    expect(hasScenarioCardBeenResolved(s, 1)).toBe(true);
  });
});

// ---------- bootstrapWaveAtNumber + scenario trigger ---------------------

describe("bootstrapWaveAtNumber — scenario card trigger", () => {
  // Quest #2's Scenario Cards moved into its storybook End of Wave
  // (`continueChoices`), so no shipped quest sets `scenarioCardOnStart`
  // today. The trigger is exercised on a copy of Quest #2 that does.
  const TRIGGER_QUEST = {
    ...QUEST2,
    waves: QUEST2.waves.map((w) => (w.number === 2 ? { ...w, scenarioCardOnStart: 1 }
      : w.number === 3 ? { ...w, scenarioCardOnStart: 2 } : w)),
  };

  it("Quest #2 no longer draws Scenario Cards at wave start", () => {
    for (const n of [1, 2, 3]) {
      const s = freshState();
      bootstrapWaveAtNumber(s, QUEST2, n);
      expect(s.currentScenarioCard).toBeNull();
    }
  });

  it("does NOT trigger a scenario card on a wave without scenarioCardOnStart", () => {
    const s = freshState();
    bootstrapWaveAtNumber(s, TRIGGER_QUEST, 1);
    expect(s.currentScenarioCard).toBeNull();
  });

  it("triggers the wave's Scenario Card at wave start", () => {
    const s = freshState();
    bootstrapWaveAtNumber(s, TRIGGER_QUEST, 2);
    expect(s.currentScenarioCard).toEqual({ number: 1, chosenOption: null, resolved: false });
    const s3 = freshState();
    bootstrapWaveAtNumber(s3, TRIGGER_QUEST, 3);
    expect(s3.currentScenarioCard).toEqual({ number: 2, chosenOption: null, resolved: false });
  });

  it("does NOT re-trigger a card that has already been resolved", () => {
    const s = freshState();
    s.scenarioCardsResolved.push(1);
    bootstrapWaveAtNumber(s, TRIGGER_QUEST, 2);
    expect(s.currentScenarioCard).toBeNull();
  });

  it("does NOT wipe a partial pick on a debug re-bootstrap of the same wave", () => {
    const s = freshState();
    bootstrapWaveAtNumber(s, TRIGGER_QUEST, 2);
    s.currentScenarioCard!.chosenOption = "A";
    s.currentScenarioCard!.resolved = true;
    bootstrapWaveAtNumber(s, TRIGGER_QUEST, 2);
    expect(s.currentScenarioCard).toEqual({ number: 1, chosenOption: "A", resolved: true });
  });
});

// ---------- Scenario D "Open Hand" — second route into Quest #4 -----------

describe("Scenario D (Open Hand) reveal-quest-or-grant-chip", () => {
  it("choice A adds Quest #4 to the Open Quests", () => {
    const s = freshState();
    startScenarioCard(s, 103);
    chooseScenarioOption(s, "A");
    expect(s.revealedQuests.some((q) => q.number === 4)).toBe(true);
    expect(s.memoryChips).toBe(0);
  });

  it("choice A grants a Memory Chip instead when Quest #4 is already owned", () => {
    const s = freshState();
    s.revealedQuests.push({ number: 4, name: "A Hand Outstretched" });
    startScenarioCard(s, 103);
    chooseScenarioOption(s, "A");
    expect(s.revealedQuests.filter((q) => q.number === 4)).toHaveLength(1);
    expect(s.memoryChips).toBe(1);
  });
});
