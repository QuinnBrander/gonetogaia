/**
 * Tests for the Chapter 1 Town Visit + Shop engine.
 *
 * Covers:
 *   - Page navigation (linear next + branching choices)
 *   - onEnter actions: minion-part grants, decision recording,
 *     shop-product population, memory chip increments
 *   - applyOnEnter dedupe (each page entered once per visit)
 *   - Shop transactions: purchase debits + atomicity, double-buy
 *     guard, can't-afford guard, sold-out guard
 *   - Boss -> minion conversion (3-for-1) + insufficient guard
 *   - Inter-delver transfers (minion + boss) + invariants
 *   - Schema migration v23 -> v24 backfills new fields
 */

import { describe, it, expect } from "vitest";

import {
  newCampaign,
  migrateV23ToV24,
  SCHEMA_VERSION,
  type CampaignState,
} from "../state";
import {
  startTownVisit,
  applyOnEnter,
  advanceTownVisitPage,
  chooseTownVisitOption,
  finishTownVisit,
  setTownVisitPage,
  currentTownVisitPage,
  purchaseShopProduct,
  convertBossPartToMinion,
  transferMinionParts,
  transferBossParts,
  otherHeroId,
} from "../engine/townVisit";
import { CHAPTER1 } from "../data";

function freshState(): CampaignState {
  return newCampaign();
}

// --- Page navigation ------------------------------------------------------

describe("townVisit — startTownVisit + currentTownVisitPage", () => {
  it("startTownVisit anchors at the chapter's startPageId", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    expect(s.townVisit).not.toBeNull();
    expect(s.townVisit!.chapterId).toBe("ch1");
    expect(s.townVisit!.pageId).toBe("page6");
    expect(s.townVisit!.pagesEntered).toEqual([]);
  });

  it("startTownVisit is idempotent (no-op if already in a visit)", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    s.townVisit!.pageId = "page9"; // simulate mid-visit
    startTownVisit(s, "ch1");
    expect(s.townVisit!.pageId).toBe("page9");
  });

  it("currentTownVisitPage returns null when no visit is active", () => {
    const s = freshState();
    expect(currentTownVisitPage(s)).toBeNull();
  });

  it("currentTownVisitPage resolves the page from chapter data", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    const ctx = currentTownVisitPage(s);
    expect(ctx).not.toBeNull();
    expect(ctx!.page.title).toContain("CHAPTER 1");
  });
});

describe("townVisit — advanceTownVisitPage", () => {
  it("follows page.next on a linear page", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    expect(s.townVisit!.pageId).toBe("page6");
    advanceTownVisitPage(s);
    expect(s.townVisit!.pageId).toBe("page7");
  });

  it("no-op on a page that has no next (e.g. choice page)", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    setTownVisitPage(s, "page7"); // choice page
    advanceTownVisitPage(s);
    expect(s.townVisit!.pageId).toBe("page7");
  });
});

describe("townVisit — chooseTownVisitOption", () => {
  it("records the decision and navigates to the choice's next page", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    setTownVisitPage(s, "page7");
    chooseTownVisitOption(s, "ch1.bram.A.pub");
    expect(s.townVisit!.pageId).toBe("page9");
    expect(s.townDecisions).toContain("ch1.bram.A.pub");
  });

  it("library branch routes to page11", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    setTownVisitPage(s, "page7");
    chooseTownVisitOption(s, "ch1.bram.B.library");
    expect(s.townVisit!.pageId).toBe("page11");
  });

  it("ignores an unknown decision key (no-op, no decision recorded)", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    setTownVisitPage(s, "page7");
    chooseTownVisitOption(s, "ch1.bram.X.nonsense");
    expect(s.townVisit!.pageId).toBe("page7");
    expect(s.townDecisions).toEqual([]);
  });
});

// --- onEnter actions ------------------------------------------------------

describe("townVisit — applyOnEnter", () => {
  it("page6 records the heroes-3-4 unlock decision and unlocks hero cards", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    const result = applyOnEnter(s);
    expect(result.ran).toBe(true);
    expect(s.townDecisions).toContain("ch1.dr-ira.heroes-3-4-unlocked");
    // The mechanical unlock — page6 now actually adds #3 and #4 to
    // the campaign's unlocked-hero-cards list.
    expect(s.unlockedHeroCards.sort()).toEqual([1, 2, 3, 4]);
  });

  it("page6 emits a hero-cards-unlocked reward event with NEW unlocks only", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    const result = applyOnEnter(s);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual({ kind: "hero-cards-unlocked", cardNumbers: [3, 4] });
  });

  it("page6 hero-card unlock filters out already-unlocked cards in the event", () => {
    const s = freshState();
    s.unlockedHeroCards = [1, 2, 3]; // #3 was already unlocked by some prior path
    startTownVisit(s, "ch1");
    const result = applyOnEnter(s);
    expect(s.unlockedHeroCards.sort()).toEqual([1, 2, 3, 4]);
    // Only #4 is "newly unlocked" so only #4 appears in the event.
    expect(result.events).toEqual([{ kind: "hero-cards-unlocked", cardNumbers: [4] }]);
  });

  it("page7 grants 4 minion parts to BOTH delvers", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    setTownVisitPage(s, "page7");
    applyOnEnter(s);
    expect(s.minionParts["hero-01"]).toBe(4);
    expect(s.minionParts["hero-02"]).toBe(4);
  });

  it("page7 emits a creature-parts-changed gain event with both recipients", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    setTownVisitPage(s, "page7");
    const result = applyOnEnter(s);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual({
      kind: "creature-parts-changed",
      partKind: "minion",
      direction: "gain",
      recipients: [
        { heroId: "hero-01", before: 0, after: 4 },
        { heroId: "hero-02", before: 0, after: 4 },
      ],
    });
  });

  it("page10-A3 grants a memory chip", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    setTownVisitPage(s, "page10-A3");
    applyOnEnter(s);
    expect(s.memoryChips).toBe(1);
  });

  it("page10-A3 emits a memory-chips-granted reward event with totalAfter", () => {
    const s = freshState();
    s.memoryChips = 2; // already had 2 chips coming in
    startTownVisit(s, "ch1");
    setTownVisitPage(s, "page10-A3");
    const result = applyOnEnter(s);
    expect(result.events).toContainEqual({
      kind: "memory-chips-granted",
      amount: 1,
      totalAfter: 3,
    });
  });

  it("page10-C2 debits 1 minion part from the active delver (clamped >= 0)", () => {
    const s = freshState();
    s.minionParts["hero-01"] = 2;
    s.currentDelverId = "hero-01";
    startTownVisit(s, "ch1");
    setTownVisitPage(s, "page10-C2");
    applyOnEnter(s);
    expect(s.minionParts["hero-01"]).toBe(1);
  });

  it("page10-C2 emits a creature-parts-changed loss event AND a favour-shifted ally event AND a cascaded opinion-card-gained event", () => {
    // Page 10-C2 was migrated from `record-decision` to the typed
    // `shift-favour` + `lose-minion-parts` pair on 2026-05-18 — this
    // test pins all three events as a multi-action canary. The
    // opinion-card-gained event is the downstream consequence of
    // the favour shift crossing NEUTRAL -> ALLY (Samantha gains
    // her ALLY opinion card, art bundled).
    const s = freshState();
    s.minionParts["hero-01"] = 2;
    s.currentDelverId = "hero-01";
    startTownVisit(s, "ch1");
    setTownVisitPage(s, "page10-C2");
    const result = applyOnEnter(s);
    expect(result.events).toEqual([
      {
        kind: "creature-parts-changed",
        partKind: "minion",
        direction: "loss",
        recipients: [{ heroId: "hero-01", before: 2, after: 1 }],
      },
      {
        kind: "favour-shifted",
        characterId: "samantha",
        characterName: "Samantha",
        delta: 1,
        totalAfter: 1,
      },
      {
        kind: "opinion-card-gained",
        characterId: "samantha",
        characterName: "Samantha",
        level: "ally",
      },
    ]);
    expect(s.favour["samantha"]).toEqual({ name: "Samantha", value: 1 });
    expect(s.opinionCards).toEqual([
      { characterId: "samantha", characterName: "Samantha", level: "ally" },
    ]);
  });

  it("lose-minion-parts clamps at zero AND suppresses the reward event for no-op clamp", () => {
    const s = freshState();
    s.minionParts["hero-01"] = 0;
    s.currentDelverId = "hero-01";
    startTownVisit(s, "ch1");
    setTownVisitPage(s, "page10-C2");
    const result = applyOnEnter(s);
    expect(s.minionParts["hero-01"]).toBe(0);
    // The lose-minion-parts clamp-to-zero produced an empty
    // recipients array which gets filtered out before the event is
    // emitted (no "-0" card in the modal). The favour shift +
    // its cascaded opinion-card-gain still fire normally.
    expect(result.events.some((e) => e.kind === "creature-parts-changed")).toBe(false);
    expect(result.events.some((e) => e.kind === "favour-shifted")).toBe(true);
    expect(result.events.some((e) => e.kind === "opinion-card-gained")).toBe(true);
  });

  it("page12-B (Library Delver Archives) grants Key Item #3 Woo's Diary", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    setTownVisitPage(s, "page12-B");
    const result = applyOnEnter(s);
    // `clues` was added to `KeyItemRecord` (2026-05; see state.ts
    // migrateV54ToV55). The catalog has Woo's Diary at clues: 1.
    expect(s.keyItems).toEqual([{ number: 3, name: "Woo's Diary", clues: 1 }]);
    expect(result.events).toContainEqual({
      kind: "key-item-gained",
      number: 3,
      name: "Woo's Diary",
    });
    // record-decision row is still appended for the dotted-log
    // backward-compat path.
    expect(s.townDecisions).toContain("ch1.library.delver-archives.key-item-3");
  });

  it("gain-key-item is idempotent on re-grant (same number = skip silently)", () => {
    const s = freshState();
    s.keyItems = [{ number: 3, name: "Woo's Diary", clues: 1 }];
    startTownVisit(s, "ch1");
    setTownVisitPage(s, "page12-B");
    const result = applyOnEnter(s);
    expect(s.keyItems).toEqual([{ number: 3, name: "Woo's Diary", clues: 1 }]); // unchanged
    expect(result.events.some((e) => e.kind === "key-item-gained")).toBe(false);
  });

  it("page10-A1 (Xavier detractor) shifts favour, records the decision, AND cascades Xavier's DETRACTOR opinion card", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    setTownVisitPage(s, "page10-A1");
    const result = applyOnEnter(s);
    expect(s.favour["xavier"]).toEqual({ name: "Xavier", value: -1 });
    expect(result.events).toEqual([
      {
        kind: "favour-shifted",
        characterId: "xavier",
        characterName: "Xavier",
        delta: -1,
        totalAfter: -1,
      },
      {
        kind: "opinion-card-gained",
        characterId: "xavier",
        characterName: "Xavier",
        level: "detractor",
      },
    ]);
    expect(s.townDecisions).toContain("ch1.opinion.xavier.detractor");
    expect(s.opinionCards).toEqual([
      { characterId: "xavier", characterName: "Xavier", level: "detractor" },
    ]);
  });

  it("favour stacks across multiple shifts; moving back to NEUTRAL returns the card to the box", () => {
    const s = freshState();
    s.favour["xavier"] = { name: "Xavier", value: -1 };
    // The Xavier DETRACTOR card was already earned on the prior
    // shift; this second shift walks the value from -1 back to 0
    // (NEUTRAL), which by design grants no new opinion card.
    s.opinionCards = [
      { characterId: "xavier", characterName: "Xavier", level: "detractor" },
    ];
    startTownVisit(s, "ch1");
    setTownVisitPage(s, "page10-A2"); // Xavier ally (+1)
    const result = applyOnEnter(s);
    expect(s.favour["xavier"]).toEqual({ name: "Xavier", value: 0 });
    expect(result.events).toContainEqual({
      kind: "favour-shifted",
      characterId: "xavier",
      characterName: "Xavier",
      delta: 1,
      totalAfter: 0,
    });
    expect(result.events.some((e) => e.kind === "opinion-card-gained")).toBe(false);
    // Rulebook p27: you hold the card for the CURRENT opinion only, and
    // NEUTRAL has no card - the Detractor card goes back to the box.
    expect(s.opinionCards).toEqual([]);
    expect(result.events).toContainEqual({
      kind: "opinion-card-discarded", characterId: "xavier", characterName: "Xavier", level: "detractor",
    });
  });

  // Engine-level coverage for the opinion-card cascade. The chapter-1
  // pages above (page10-A1 / page10-C2 / page10-A2) cover the
  // ±1-from-NEUTRAL cases; these tests pin the forward-compat
  // behaviour (multi-level cascade, art-availability gate, idempotency
  // on re-cross) that no current chapter exercises but the engine
  // must support so future chapters can author larger shifts /
  // graduate art-less characters in place without re-touching
  // engine code.
  it("ALLY -> CONFIDANT: the Ally card is returned and the Confidant card taken", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    setTownVisitPage(s, "page10-A1"); // any page with onEnter
    // Drop the page's authored actions on the floor — we want to
    // drive `shift-favour` directly through `applyOnEnter` via a
    // synthetic page entry. Easiest path: shift before the page is
    // marked entered, by injecting via the chapter data is
    // impractical, so we exercise the engine by simulating two
    // sequential +1 shifts on the same character (Xavier from
    // NEUTRAL through ALLY to CONFIDANT). Same end state as a
    // hypothetical single +2; this is the only path the chapter
    // data exposes today.
    s.favour["xavier"] = { name: "Xavier", value: 1 };
    s.opinionCards.push({
      characterId: "xavier",
      characterName: "Xavier",
      level: "ally",
    });
    // Now visit page10-A2 (Xavier +1) — this carries the value
    // from +1 to +2 (ALLY -> CONFIDANT). The cascade emits exactly
    // one opinion-card-gained for CONFIDANT (ALLY already owned).
    s.townVisit!.pagesEntered = [];
    setTownVisitPage(s, "page10-A2");
    const result = applyOnEnter(s);
    expect(s.favour["xavier"]).toEqual({ name: "Xavier", value: 2 });
    expect(s.opinionCards).toEqual([
      { characterId: "xavier", characterName: "Xavier", level: "confidant" },
    ]);
    expect(result.events.filter((e) => e.kind === "opinion-card-gained")).toEqual([
      {
        kind: "opinion-card-gained",
        characterId: "xavier",
        characterName: "Xavier",
        level: "confidant",
      },
    ]);
  });

  it("re-crossing ALLY after NEUTRAL takes a fresh Ally card (one card per character)", () => {
    // ALLY -> NEUTRAL returns the card; NEUTRAL -> ALLY takes it again.
    const s = freshState();
    s.favour["xavier"] = { name: "Xavier", value: 1 };
    s.opinionCards = [
      { characterId: "xavier", characterName: "Xavier", level: "ally" },
    ];
    startTownVisit(s, "ch1");
    setTownVisitPage(s, "page10-A1"); // Xavier delta=-1 → 0 (NEUTRAL)
    applyOnEnter(s);
    expect(s.favour["xavier"].value).toBe(0);
    expect(s.opinionCards).toHaveLength(0);

    s.townVisit!.pagesEntered = [];
    setTownVisitPage(s, "page10-A2"); // Xavier delta=+1 → +1 (ALLY)
    const result = applyOnEnter(s);
    expect(s.favour["xavier"].value).toBe(1);
    expect(s.opinionCards).toEqual([{ characterId: "xavier", characterName: "Xavier", level: "ally" }]);
    expect(result.events.some((e) => e.kind === "opinion-card-gained")).toBe(true);
  });

  it("opinion-card cascade: state.opinionCards tracks gains AND opinion-card-gained event fires regardless of art availability", () => {
    // page10-C1 (Samantha delta=-1) now lands the player on the
    // SAMANTHA DETRACTOR card — both the state record AND the
    // printed art ship together (added 2026-05-24 alongside the
    // detractor-card-blocks-Machinist penalty engine). The test
    // exercises the same "ledger + event" invariant that the
    // 2026-05-19 fix introduced: even when the (character, level)
    // pair has no art the event STILL fires (the RewardsModal
    // renders a stylised placeholder), so the cascade never
    // silently swallows a gain.
    const s = freshState();
    startTownVisit(s, "ch1");
    setTownVisitPage(s, "page10-C1"); // Samantha delta=-1 → -1 (DETRACTOR)
    const result = applyOnEnter(s);
    expect(s.favour["samantha"]?.value).toBe(-1);
    expect(s.opinionCards).toEqual([
      { characterId: "samantha", characterName: "Samantha", level: "detractor" },
    ]);
    expect(result.events.some((e) => e.kind === "favour-shifted")).toBe(true);
    expect(result.events.some((e) => e.kind === "opinion-card-gained")).toBe(true);
  });

  // Pre-pay metadata for the Pub's "Buy her a drink" branch.
  // The choice is tagged with `prePay: { kind: "minion-parts", amount: 1 }`
  // so the TownVisit UI mounts a "Who pays?" modal when both delvers
  // can afford the cost, lets the player pick the payer, then sets
  // `state.currentDelverId` to them before the engine navigates to
  // page10-C2. Engine itself doesn't change — the page's
  // `lose-minion-parts to: "active-delver"` action debits whoever
  // currentDelverId points at when the action fires.
  it("page10-C 'Buy her a drink' choice carries prePay metadata for the payer-pick modal", () => {
    const buyChoice = CHAPTER1.pages["page10-C"]!.choices!
      .find((c) => c.decisionKey === "ch1.pub.C.2.samantha-drink");
    expect(buyChoice).toBeDefined();
    expect(buyChoice!.prePay).toEqual({ kind: "minion-parts", amount: 1 });
    // The clarify branch has no cost so it should NOT carry prePay
    // metadata (a stray field there would falsely gate the button).
    const clarifyChoice = CHAPTER1.pages["page10-C"]!.choices!
      .find((c) => c.decisionKey === "ch1.pub.C.1.samantha-clarify");
    expect(clarifyChoice!.prePay).toBeUndefined();
  });

  it("page10-C2 debits whichever delver currentDelverId points at when entered (covers payer-pick flow)", () => {
    // The UI flips currentDelverId to the picked payer before
    // navigating to page10-C2 — this test pins that the engine
    // honours currentDelverId at that moment for the actual debit
    // (`to: "active-delver"`). Two passes: hero-01 picked / hero-02
    // picked.
    for (const payerId of ["hero-01", "hero-02"] as const) {
      const s = freshState();
      s.minionParts["hero-01"] = 2;
      s.minionParts["hero-02"] = 2;
      s.currentDelverId = payerId;
      startTownVisit(s, "ch1");
      setTownVisitPage(s, "page10-C2");
      applyOnEnter(s);
      const other = payerId === "hero-01" ? "hero-02" : "hero-01";
      expect(s.minionParts[payerId]).toBe(1);
      expect(s.minionParts[other]).toBe(2);
    }
  });

  it("page13 (shop) populates shopProductsAvailable with [1..7] AND emits shop-products-added (no quest label, no completion records)", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    setTownVisitPage(s, "page13");
    const result = applyOnEnter(s);
    expect(s.shopProductsAvailable.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // Completion + Quest #2 reveal records now live on page14 (the
    // terminal narrative beat) so the shop scene doesn't pre-spoil
    // Quest #2 via the rewards modal's quest label. The shop scene
    // is purely "buy stuff"; the narrative beat is separate.
    expect(s.townDecisions).not.toContain("ch1.quest2.unlocked");
    expect(s.townDecisions).not.toContain("ch1.completed");
    expect(result.events).toContainEqual({
      kind: "shop-products-added",
      productNumbers: [1, 2, 3, 4, 5, 6, 7],
      questLabel: undefined,
    });
  });

  it("page13 -> page14: shop's `next` advances to the Quest #2 reveal page", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    setTownVisitPage(s, "page13");
    applyOnEnter(s);
    advanceTownVisitPage(s);
    expect(s.townVisit?.pageId).toBe("page14");
  });

  it("page14 (end-town-visit) records ch1.quest2.unlocked + ch1.completed AND emits a quest-revealed event for #2 (no shop UI)", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    setTownVisitPage(s, "page14");
    const result = applyOnEnter(s);
    expect(s.townDecisions).toContain("ch1.quest2.unlocked");
    expect(s.townDecisions).toContain("ch1.completed");
    // Quest #2 — The Surveillance Device is now the page's
    // headline reward, presented as the printed quest card in the
    // rewards modal.
    expect(s.revealedQuests).toEqual([
      { number: 2, name: "The Surveillance Device" },
    ]);
    expect(result.events).toEqual([
      { kind: "quest-revealed", number: 2, name: "The Surveillance Device" },
    ]);
    // Sanity: the page itself does not have shop semantics — no
    // products are added, no shop-products-added event is emitted.
    expect(s.shopProductsAvailable).toEqual([]);
  });

  it("reveal-quest is idempotent — re-revealing the same quest number is a no-op and emits no second event", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    // First reveal via the page14 path.
    setTownVisitPage(s, "page14");
    const first = applyOnEnter(s);
    expect(first.events).toContainEqual({
      kind: "quest-revealed",
      number: 2,
      name: "The Surveillance Device",
    });
    expect(s.revealedQuests).toHaveLength(1);

    // Simulate a future chapter that tries to re-grant the same
    // quest (no real chapter does this today, but the engine
    // should silently de-dupe). We invoke the engine directly
    // via runAction-equivalent behaviour by re-entering page14
    // after a forced re-eligibility — easiest path is to clear
    // `pagesEntered` so `applyOnEnter` runs the actions again.
    s.townVisit!.pagesEntered = [];
    const second = applyOnEnter(s);
    expect(s.revealedQuests).toHaveLength(1);
    expect(second.events.some((e) => e.kind === "quest-revealed")).toBe(false);
  });

  it("dedupe: applyOnEnter on the same page twice only fires actions once", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    setTownVisitPage(s, "page7");
    expect(applyOnEnter(s).ran).toBe(true);
    const second = applyOnEnter(s);
    expect(second.ran).toBe(false);
    expect(second.events).toEqual([]);
    // Both delvers still have only the single 4-grant, not 8.
    expect(s.minionParts["hero-01"]).toBe(4);
    expect(s.minionParts["hero-02"]).toBe(4);
  });

  it("dedupe: navigating away and back fires only once total", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    setTownVisitPage(s, "page7");
    applyOnEnter(s);
    setTownVisitPage(s, "page9");
    applyOnEnter(s);
    setTownVisitPage(s, "page7");
    applyOnEnter(s);
    expect(s.minionParts["hero-01"]).toBe(4);
  });

  it("add-shop-products skips already-owned products on re-add", () => {
    const s = freshState();
    s.shopProductsOwned["hero-01"] = [3];
    startTownVisit(s, "ch1");
    setTownVisitPage(s, "page13");
    applyOnEnter(s);
    expect(s.shopProductsAvailable).not.toContain(3);
    expect(s.shopProductsAvailable.sort((a, b) => a - b)).toEqual([1, 2, 4, 5, 6, 7]);
  });

  it("page12-C (Atlas Archives) grants a Friendly Spawn Card + records the decision", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    // page12-C used to be a pure record-decision page (no typed
    // action for the spawn-deck grant), but with v46 the
    // `grant-friendly-spawn-card` action now wires the grant
    // through the engine. The first grant always picks #13 from
    // the printed pool (FRIENDLY_SPAWN_CARD_NUMBERS in order).
    setTownVisitPage(s, "page12-C");
    const result = applyOnEnter(s);
    expect(result.ran).toBe(true);
    expect(result.events).toHaveLength(1);
    const ev = result.events[0]!;
    expect(ev.kind).toBe("friendly-spawn-card-gained");
    if (ev.kind !== "friendly-spawn-card-gained") throw new Error("kind mismatch");
    expect(ev.cardNumber).toBe(13);
    expect(ev.deckSize).toBe(1);
    expect(s.friendlySpawnDeck).toEqual([13]);
    expect(s.townDecisions).toContain("ch1.library.atlas-archives.friendly-spawn");
  });

  it("page12-A (Creature Archives) grants 2 Ultra Level Up cards + records the decision", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    setTownVisitPage(s, "page12-A");
    const result = applyOnEnter(s);
    expect(result.ran).toBe(true);
    // Exactly one reward event (the ultra grant); the record-decision
    // action intentionally doesn't emit a player-facing reward.
    expect(result.events).toHaveLength(1);
    const ev = result.events[0]!;
    expect(ev.kind).toBe("ultra-level-cards-gained");
    if (ev.kind !== "ultra-level-cards-gained") throw new Error("kind mismatch");
    expect(ev.cardNumbers).toHaveLength(2);
    // Both granted numbers should be printed Ultras (29..32).
    for (const n of ev.cardNumbers) {
      expect(n).toBeGreaterThanOrEqual(29);
      expect(n).toBeLessThanOrEqual(32);
    }
    expect(s.ultraLevelCardsOwned).toEqual(ev.cardNumbers);
    expect(s.townDecisions).toContain("ch1.library.creature-archives.ultra-cards");
  });
});

// --- Shop transactions ----------------------------------------------------

describe("townVisit — purchaseShopProduct", () => {
  it("debits the cost and moves the product from available -> owned", () => {
    const s = freshState();
    s.shopProductsAvailable = [3]; // Boots (6 minion)
    s.minionParts["hero-01"] = 6;
    const result = purchaseShopProduct(s, "hero-01", 3);
    expect(result).toBeNull();
    expect(s.minionParts["hero-01"]).toBe(0);
    expect(s.shopProductsAvailable).toEqual([]);
    expect(s.shopProductsOwned["hero-01"]).toEqual([3]);
    expect(s.townDecisions).toContain("ch1.shop.bought.product-3.hero-01");
  });

  it("rejects when product is not available (no mutation)", () => {
    const s = freshState();
    s.minionParts["hero-01"] = 100;
    const result = purchaseShopProduct(s, "hero-01", 3);
    expect(result).toEqual({ code: "not-available" });
    expect(s.minionParts["hero-01"]).toBe(100);
    expect(s.shopProductsOwned["hero-01"]).toEqual([]);
  });

  it("rejects when delver can't afford minion-part cost (no mutation)", () => {
    const s = freshState();
    s.shopProductsAvailable = [1]; // Trident (7 minion)
    s.minionParts["hero-01"] = 6;
    const result = purchaseShopProduct(s, "hero-01", 1);
    expect(result).toEqual({ code: "insufficient-minion" });
    expect(s.minionParts["hero-01"]).toBe(6);
    expect(s.shopProductsAvailable).toEqual([1]);
  });

  it("rejects when delver can't afford boss-lvl-1 cost (no mutation)", () => {
    const s = freshState();
    s.shopProductsAvailable = [5]; // +1 Light (12 minion + 1 boss-lvl-1)
    s.minionParts["hero-01"] = 12;
    s.bossParts["hero-01"] = 0;
    const result = purchaseShopProduct(s, "hero-01", 5);
    expect(result).toEqual({ code: "insufficient-boss-lvl-1" });
    expect(s.minionParts["hero-01"]).toBe(12);
  });

  it("debits both minion AND boss parts when both are required", () => {
    const s = freshState();
    s.shopProductsAvailable = [5];
    s.minionParts["hero-01"] = 12;
    s.bossParts["hero-01"] = 1;
    const result = purchaseShopProduct(s, "hero-01", 5);
    expect(result).toBeNull();
    expect(s.minionParts["hero-01"]).toBe(0);
    expect(s.bossParts["hero-01"]).toBe(0);
    expect(s.shopProductsOwned["hero-01"]).toEqual([5]);
  });

  it("rejects when delver already owns the product", () => {
    const s = freshState();
    s.shopProductsAvailable = [3];
    s.shopProductsOwned["hero-01"] = [3];
    s.minionParts["hero-01"] = 100;
    const result = purchaseShopProduct(s, "hero-01", 3);
    expect(result).toEqual({ code: "already-owned" });
  });

  // Level-aware wallets (v58, player report 2026-07-20): bossLvl2
  // costs read the Hundredeyes wallet. Pre-fix `boss2` was
  // hard-coded to 0, so "+2 MEDIUM" / "+4 HEAVY" / Cyclone Boots
  // could never be bought, and lvl-1 parts could not stand in.
  it("rejects bossLvl2 cost when the delver has NO lvl-2 parts (lvl-1 parts don't substitute)", () => {
    const s = freshState();
    s.shopProductsAvailable = [9]; // +2 MEDIUM: 15 minion + 1 boss-lvl-2
    s.minionParts["hero-01"] = 100;
    s.bossParts["hero-01"] = 100; // lvl-1 hoard is irrelevant
    const result = purchaseShopProduct(s, "hero-01", 9);
    expect(result).toEqual({ code: "insufficient-boss-lvl-2" });
  });

  it("accepts + debits a bossLvl2 cost from the lvl-2 wallet (+4 HEAVY finally purchasable)", () => {
    const s = freshState();
    s.shopProductsAvailable = [13]; // +4 HEAVY: 18 minion + 1 boss-lvl-2
    s.minionParts["hero-01"] = 18;
    s.bossParts["hero-01"] = 2;      // untouched by the purchase
    s.bossPartsLvl2["hero-01"] = 1;  // Hundredeyes part pays the cost
    const result = purchaseShopProduct(s, "hero-01", 13);
    expect(result).toBeNull();
    expect(s.minionParts["hero-01"]).toBe(0);
    expect(s.bossParts["hero-01"]).toBe(2);
    expect(s.bossPartsLvl2["hero-01"]).toBe(0);
    expect(s.shopProductsOwned["hero-01"]).toEqual([13]);
  });
});

// --- Conversion + transfers -----------------------------------------------

describe("townVisit — convertBossPartToMinion", () => {
  it("converts 1 boss-lvl-1 into 3 minion parts", () => {
    const s = freshState();
    s.bossParts["hero-01"] = 2;
    s.minionParts["hero-01"] = 1;
    expect(convertBossPartToMinion(s, "hero-01")).toBe(true);
    expect(s.bossParts["hero-01"]).toBe(1);
    expect(s.minionParts["hero-01"]).toBe(4);
  });

  it("returns false (and no-ops) when delver has 0 boss parts", () => {
    const s = freshState();
    s.bossParts["hero-01"] = 0;
    s.minionParts["hero-01"] = 5;
    expect(convertBossPartToMinion(s, "hero-01")).toBe(false);
    expect(s.minionParts["hero-01"]).toBe(5);
  });

  // Printed Ch2 rate: 3 minion parts PER LEVEL of the converted Boss
  // part (player report 2026-07-20: the Lvl 2 / Lvl 3 options were
  // missing from the town visit entirely).
  it("converts 1 boss-lvl-2 into 6 minion parts (own wallet, lvl-1 untouched)", () => {
    const s = freshState();
    s.bossParts["hero-01"] = 1;
    s.bossPartsLvl2["hero-01"] = 2;
    expect(convertBossPartToMinion(s, "hero-01", 2)).toBe(true);
    expect(s.bossPartsLvl2["hero-01"]).toBe(1);
    expect(s.bossParts["hero-01"]).toBe(1); // untouched
    expect(s.minionParts["hero-01"]).toBe(6);
  });

  it("converts 1 boss-lvl-3 into 9 minion parts", () => {
    const s = freshState();
    s.bossPartsLvl3["hero-01"] = 1;
    expect(convertBossPartToMinion(s, "hero-01", 3)).toBe(true);
    expect(s.bossPartsLvl3["hero-01"]).toBe(0);
    expect(s.minionParts["hero-01"]).toBe(9);
  });

  it("rejects a lvl-2 convert when only lvl-1 parts are held", () => {
    const s = freshState();
    s.bossParts["hero-01"] = 5;
    expect(convertBossPartToMinion(s, "hero-01", 2)).toBe(false);
    expect(s.bossParts["hero-01"]).toBe(5);
    expect(s.minionParts["hero-01"]).toBe(0);
  });
});

describe("townVisit — transferMinionParts / transferBossParts", () => {
  it("moves N minion parts between delvers", () => {
    const s = freshState();
    s.minionParts["hero-01"] = 5;
    s.minionParts["hero-02"] = 1;
    expect(transferMinionParts(s, "hero-01", "hero-02", 3)).toBe(true);
    expect(s.minionParts["hero-01"]).toBe(2);
    expect(s.minionParts["hero-02"]).toBe(4);
  });

  it("rejects amount <= 0", () => {
    const s = freshState();
    s.minionParts["hero-01"] = 5;
    expect(transferMinionParts(s, "hero-01", "hero-02", 0)).toBe(false);
    expect(transferMinionParts(s, "hero-01", "hero-02", -1)).toBe(false);
    expect(s.minionParts["hero-01"]).toBe(5);
  });

  it("rejects when sender doesn't have enough", () => {
    const s = freshState();
    s.minionParts["hero-01"] = 2;
    expect(transferMinionParts(s, "hero-01", "hero-02", 3)).toBe(false);
    expect(s.minionParts["hero-01"]).toBe(2);
  });

  it("rejects same-delver transfer", () => {
    const s = freshState();
    s.minionParts["hero-01"] = 5;
    expect(transferMinionParts(s, "hero-01", "hero-01", 1)).toBe(false);
  });

  it("transferBossParts moves N boss-lvl-1 parts between delvers", () => {
    const s = freshState();
    s.bossParts["hero-01"] = 2;
    s.bossParts["hero-02"] = 0;
    expect(transferBossParts(s, "hero-01", "hero-02", 1)).toBe(true);
    expect(s.bossParts["hero-01"]).toBe(1);
    expect(s.bossParts["hero-02"]).toBe(1);
  });
});

describe("townVisit — otherHeroId", () => {
  it("returns the partner delver", () => {
    expect(otherHeroId("hero-01")).toBe("hero-02");
    expect(otherHeroId("hero-02")).toBe("hero-01");
  });
});

// --- Lifecycle ------------------------------------------------------------

describe("townVisit — finishTownVisit", () => {
  it("flips townVisit1Completed and clears the visit", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    expect(s.townVisit1Completed).toBe(false);
    finishTownVisit(s);
    expect(s.townVisit1Completed).toBe(true);
    expect(s.townVisit).toBeNull();
  });

  it("is a no-op when there is no active visit", () => {
    const s = freshState();
    finishTownVisit(s);
    expect(s.townVisit1Completed).toBe(false);
  });

  it("auto-advances currentQuestId to quest2 when finishing chapter 1", () => {
    const s = freshState();
    startTownVisit(s, "ch1");
    expect(s.currentQuestId).toBe("quest1");
    finishTownVisit(s);
    // Drives the Story screen's Q2 intro on next navigation.
    expect(s.currentQuestId).toBe("quest2");
  });

  it("is idempotent on currentQuestId when already past Q1 (debug-jump path)", () => {
    const s = freshState();
    s.currentQuestId = "quest2";
    startTownVisit(s, "ch1");
    finishTownVisit(s);
    expect(s.currentQuestId).toBe("quest2");
  });
});

// --- Schema migration -----------------------------------------------------

describe("migrateV23ToV24 — Town Visit + Shop fields backfill", () => {
  it("backfills all five new fields with their default values", () => {
    const save = {
      version: 23,
      minionParts: { "hero-01": 5, "hero-02": 3 },
      bossParts: { "hero-01": 1, "hero-02": 0 },
      memoryChips: 2,
      quest1Completed: true,
      encounter: null,
    };
    const out = migrateV23ToV24(save) as CampaignState;
    // migrateV23ToV24 only steps the schema to 24; the chained loader
    // (`loadCampaign`) calls migrateV24ToV25 next to reach SCHEMA_VERSION.
    expect(out.version).toBe(24);
    expect(out.townVisit1Completed).toBe(false);
    expect(out.townVisit).toBeNull();
    expect(out.townDecisions).toEqual([]);
    expect(out.shopProductsAvailable).toEqual([]);
    expect(out.shopProductsOwned).toEqual({ "hero-01": [], "hero-02": [] });
    // Pre-existing fields are preserved untouched.
    expect(out.minionParts["hero-01"]).toBe(5);
    expect(out.bossParts["hero-01"]).toBe(1);
    expect(out.memoryChips).toBe(2);
    expect(out.quest1Completed).toBe(true);
  });

  it("does NOT clobber an already-present townVisit value", () => {
    const save = {
      version: 23,
      townVisit: { chapterId: "ch1", pageId: "page9", pagesEntered: ["page6"] },
      townDecisions: ["ch1.bram.A.pub"],
    };
    const out = migrateV23ToV24(save) as CampaignState;
    expect(out.townVisit).not.toBeNull();
    expect(out.townVisit!.pageId).toBe("page9");
    expect(out.townDecisions).toEqual(["ch1.bram.A.pub"]);
  });

  it("backfills shopProductsOwned for both heroes if the map exists but is missing entries", () => {
    const save = {
      version: 23,
      shopProductsOwned: { "hero-01": [3] }, // hero-02 missing
    };
    const out = migrateV23ToV24(save) as CampaignState;
    expect(out.shopProductsOwned["hero-01"]).toEqual([3]);
    expect(out.shopProductsOwned["hero-02"]).toEqual([]);
  });

  it("returns null on malformed input (caller falls through to newCampaign)", () => {
    expect(migrateV23ToV24(null)).toBeNull();
  });
});
