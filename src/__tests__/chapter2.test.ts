/**
 * Tests for the Chapter 2 Town Visit data + engine wiring.
 *
 * Covers:
 *   - `data/chapter2.json` shape (every page resolves, every choice
 *     `next` points at a real page, every action references valid
 *     hero / shop / key-item ids).
 *   - New `TownVisitAction` kinds: discard-key-item,
 *     grant-minion-parts-floor, grant-story-tokens, spend-story-token,
 *     add-shop-products-if-key-items-min, reveal-quest-or-grant-chip.
 *   - `finishTownVisit` flips `townVisit2Completed` + clears
 *     `storyTokens` for Ch2 (mirrors the Ch1 latch behaviour).
 *   - `getChapter("ch2")` returns the chapter — guards against a
 *     stale `data.ts` dispatch.
 */

import { describe, it, expect } from "vitest";

import { newCampaign, type CampaignState } from "../state";
import {
  startTownVisit,
  setTownVisitPage,
  applyOnEnter,
  finishTownVisit,
  runTownVisitAction,
} from "../engine/townVisit";
import { CHAPTER2, getChapter, getShopProduct, MEMORY_CARDS } from "../data";

function freshState(): CampaignState {
  return newCampaign();
}

// --- Chapter data integrity ------------------------------------------------

describe("chapter2 — data integrity", () => {
  it("getChapter('ch2') returns the CHAPTER2 catalog", () => {
    expect(getChapter("ch2")).toBe(CHAPTER2);
  });

  it("startPageId is page22-entry (the survival branch fork)", () => {
    expect(CHAPTER2.startPageId).toBe("page22-entry");
    expect(CHAPTER2.pages[CHAPTER2.startPageId]).toBeDefined();
  });

  it("every choice's `next` points at a real page", () => {
    for (const [pageId, page] of Object.entries(CHAPTER2.pages)) {
      for (const c of page.choices ?? []) {
        expect(CHAPTER2.pages[c.next], `${pageId} -> ${c.next}`).toBeDefined();
      }
    }
  });

  it("every linear page's `next` points at a real page", () => {
    for (const [pageId, page] of Object.entries(CHAPTER2.pages)) {
      if (!page.next) continue;
      expect(CHAPTER2.pages[page.next], `${pageId} -> ${page.next}`).toBeDefined();
    }
  });

  it("references only known shop product numbers in add-shop-products actions", () => {
    for (const page of Object.values(CHAPTER2.pages)) {
      for (const a of page.onEnter ?? []) {
        if (a.kind === "add-shop-products" || a.kind === "add-shop-products-if-key-items-min") {
          for (const n of a.products) {
            // Throws on unknown.
            expect(() => getShopProduct(n)).not.toThrow();
          }
        }
      }
    }
  });

  it("exactly one terminal page (kind: end-town-visit), and it's Master Bram", () => {
    // The terminal beat moved from Father Flores -> Master Bram
    // (2026-05; the Flores surveillance hand-off became a regular
    // page that auto-advances to Bram's debrief, which now carries
    // the `end-town-visit` kind + the chapter-completion record).
    const terminals = Object.entries(CHAPTER2.pages)
      .filter(([, p]) => p.kind === "end-town-visit")
      .map(([id]) => id);
    expect(terminals).toEqual(["page35b-master-bram"]);
  });

  it("hub page renders BOTH a `requireStoryTokens: positive` set AND a `zero` set", () => {
    const hub = CHAPTER2.pages["page26-location-hub"];
    expect(hub).toBeDefined();
    const positives = (hub!.choices ?? []).filter((c) => c.requireStoryTokens === "positive");
    const zeros = (hub!.choices ?? []).filter((c) => c.requireStoryTokens === "zero");
    expect(positives.length).toBe(3); // Academy, Library, Machinist
    expect(zeros.length).toBe(1); // Continue to Town Center
  });
});

// --- Story token actions ---------------------------------------------------

describe("chapter2 — grant-story-tokens + spend-story-token", () => {
  it("grant-story-tokens SETS the counter and emits one event", () => {
    const s = freshState();
    s.storyTokens = 99; // prove it's a SET, not an add
    startTownVisit(s, "ch2");
    setTownVisitPage(s, "page26-watchtower-resolution");
    const out = applyOnEnter(s);
    expect(out.ran).toBe(true);
    expect(s.storyTokens).toBe(2);
    const events = out.events.filter((e) => e.kind === "story-tokens-granted");
    expect(events).toHaveLength(1);
    if (events[0]!.kind === "story-tokens-granted") {
      expect(events[0]!.amount).toBe(2);
      expect(events[0]!.totalAfter).toBe(2);
    }
  });

  it("spend-story-token decrements and floor-clamps at 0", () => {
    const s = freshState();
    s.storyTokens = 2;
    startTownVisit(s, "ch2");
    setTownVisitPage(s, "page27-academy");
    applyOnEnter(s);
    expect(s.storyTokens).toBe(1);
    // Move to the next page-entry to re-arm onEnter (the engine
    // dedupes per-page-per-visit; jumping fires only fires once).
    setTownVisitPage(s, "page29-library");
    applyOnEnter(s);
    expect(s.storyTokens).toBe(0);
    // Try to spend again — defensive floor at 0.
    setTownVisitPage(s, "page31-machinist");
    applyOnEnter(s);
    expect(s.storyTokens).toBe(0);
  });

  it("spend-story-token emits no reward event (silent bookkeeping)", () => {
    const s = freshState();
    s.storyTokens = 2;
    startTownVisit(s, "ch2");
    setTownVisitPage(s, "page27-academy");
    const out = applyOnEnter(s);
    expect(out.events.find((e) => e.kind === ("story-tokens-granted" as const))).toBeUndefined();
  });
});

// --- discard-key-item ------------------------------------------------------

describe("chapter2 — discard-key-item", () => {
  it("removes the matching key item and emits a key-item-discarded event", () => {
    const s = freshState();
    s.keyItems = [{ number: 1, name: "Surveillance Camera", clues: 1 }, { number: 6, name: "Photo", clues: 1 }];
    startTownVisit(s, "ch2");
    setTownVisitPage(s, "page35-father-flores");
    const out = applyOnEnter(s);
    expect(s.keyItems.map((k) => k.number)).toEqual([6]);
    const discards = out.events.filter((e) => e.kind === "key-item-discarded");
    expect(discards).toHaveLength(1);
    if (discards[0]!.kind === "key-item-discarded") {
      expect(discards[0]!.number).toBe(1);
      expect(discards[0]!.name).toBe("Surveillance Camera");
    }
  });

  it("silently no-ops if the key item isn't owned (no event, no throw)", () => {
    const s = freshState();
    s.keyItems = []; // never granted Key Item #1
    startTownVisit(s, "ch2");
    setTownVisitPage(s, "page35-father-flores");
    const out = applyOnEnter(s);
    expect(s.keyItems).toEqual([]);
    expect(out.events.find((e) => e.kind === "key-item-discarded")).toBeUndefined();
  });
});

// --- grant-minion-parts-floor ---------------------------------------------

describe("chapter2 — grant-minion-parts-floor", () => {
  it("bumps below-floor delvers up to the floor and leaves above-floor delvers alone", () => {
    const s = freshState();
    s.minionParts = { "hero-01": 3, "hero-02": 15 };
    startTownVisit(s, "ch2");
    setTownVisitPage(s, "page33-town-center");
    const out = applyOnEnter(s);
    expect(s.minionParts["hero-01"]).toBe(10);
    expect(s.minionParts["hero-02"]).toBe(15); // untouched
    const ev = out.events.find((e) => e.kind === "creature-parts-changed");
    expect(ev).toBeDefined();
    if (ev?.kind === "creature-parts-changed") {
      expect(ev.recipients.map((r) => r.heroId)).toEqual(["hero-01"]);
      expect(ev.recipients[0]).toMatchObject({ heroId: "hero-01", before: 3, after: 10 });
    }
  });

  it("emits no event when every delver is already at or above the floor", () => {
    const s = freshState();
    s.minionParts = { "hero-01": 10, "hero-02": 12 };
    startTownVisit(s, "ch2");
    setTownVisitPage(s, "page33-town-center");
    const out = applyOnEnter(s);
    // Other actions on the page still produce events (shop products,
    // record-decision), but no creature-parts-changed should fire.
    expect(out.events.find((e) => e.kind === "creature-parts-changed")).toBeUndefined();
    expect(s.minionParts).toEqual({ "hero-01": 10, "hero-02": 12 });
  });
});

// --- add-shop-products-if-key-items-min -----------------------------------

describe("chapter2 — add-shop-products-if-key-items-min", () => {
  it("stocks the products when the campaign owns enough Key Items", () => {
    const s = freshState();
    s.keyItems = [
      { number: 1, name: "Surveillance Camera", clues: 1 },
      { number: 4, name: "Charred Femur", clues: 1 },
    ]; // 2 items — clears the minKeyItems=2 gate for product #13
    startTownVisit(s, "ch2");
    setTownVisitPage(s, "page33-town-center");
    applyOnEnter(s);
    expect(s.shopProductsAvailable).toContain(13);
    expect(s.shopProductsAvailable).not.toContain(14); // 2 < 4 floor
  });

  it("skips silently when the gate isn't met", () => {
    const s = freshState();
    s.keyItems = [{ number: 1, name: "Surveillance Camera", clues: 1 }]; // only 1
    startTownVisit(s, "ch2");
    setTownVisitPage(s, "page33-town-center");
    applyOnEnter(s);
    expect(s.shopProductsAvailable).not.toContain(13);
    expect(s.shopProductsAvailable).not.toContain(14);
    // Base #8-12 should still get stocked by the unconditional
    // add-shop-products action that runs first.
    expect(s.shopProductsAvailable).toContain(8);
    expect(s.shopProductsAvailable).toContain(12);
  });

  it("stocks BOTH #13 and #14 when the player has 4+ Key Items", () => {
    const s = freshState();
    s.keyItems = [
      { number: 1, name: "Surveillance Camera", clues: 1 },
      { number: 2, name: "Abandoned Syringe", clues: 1 },
      { number: 4, name: "Charred Femur", clues: 1 },
      { number: 6, name: "Photo", clues: 1 },
    ];
    startTownVisit(s, "ch2");
    setTownVisitPage(s, "page33-town-center");
    applyOnEnter(s);
    expect(s.shopProductsAvailable).toContain(13);
    expect(s.shopProductsAvailable).toContain(14);
  });
});

// --- reveal-quest-or-grant-chip -------------------------------------------

describe("chapter2 — reveal-quest-or-grant-chip", () => {
  // The `reveal-quest-or-grant-chip` action lives on the Master Bram
  // beat (the chapter-2 terminal) — see the data-integrity test
  // above. Father Flores is now just a hand-off page with a
  // `discard-key-item` action.
  it("reveals the quest when not previously revealed", () => {
    const s = freshState();
    expect(s.revealedQuests).toEqual([]);
    startTownVisit(s, "ch2");
    setTownVisitPage(s, "page35b-master-bram");
    const out = applyOnEnter(s);
    expect(s.revealedQuests.map((q) => q.number)).toContain(5);
    expect(out.events.find((e) => e.kind === "quest-revealed")).toBeDefined();
    expect(out.events.find((e) => e.kind === "memory-chips-granted")).toBeUndefined();
  });

  it("falls back to granting a memory chip when the quest was already revealed", () => {
    const s = freshState();
    s.revealedQuests = [{ number: 5, name: "The Rogue Delver" }];
    const beforeChips = s.memoryChips;
    startTownVisit(s, "ch2");
    setTownVisitPage(s, "page35b-master-bram");
    const out = applyOnEnter(s);
    expect(s.memoryChips).toBe(beforeChips + 1);
    expect(out.events.find((e) => e.kind === "memory-chips-granted")).toBeDefined();
    // Quest list unchanged.
    expect(s.revealedQuests.map((q) => q.number)).toEqual([5]);
  });
});

// --- convert-memory-chips-to-cards ----------------------------------------

describe("chapter2 — convert-memory-chips-to-cards", () => {
  it("spends ALL chips and draws one Memory card per chip", () => {
    const s = freshState();
    s.memoryChips = 3;
    const out = runTownVisitAction(s, { kind: "convert-memory-chips-to-cards" });
    expect(s.memoryChips).toBe(0);
    expect(s.memoryCards).toHaveLength(3);
    const printed = new Set(MEMORY_CARDS.map((c) => c.number));
    for (const n of s.memoryCards) expect(printed.has(n)).toBe(true);
    expect(out).toHaveLength(1);
    const ev = out[0]!;
    expect(ev.kind).toBe("memory-cards-gained");
    if (ev.kind !== "memory-cards-gained") throw new Error("kind mismatch");
    expect(ev.chipsSpent).toBe(3);
    expect(ev.cardNumbers).toHaveLength(3);
    expect(ev.cardNumbers).toEqual(s.memoryCards);
  });

  it("is a silent no-op when the campaign has zero chips", () => {
    const s = freshState();
    expect(s.memoryChips).toBe(0);
    const out = runTownVisitAction(s, { kind: "convert-memory-chips-to-cards" });
    expect(out).toEqual([]);
    expect(s.memoryChips).toBe(0);
    expect(s.memoryCards).toEqual([]);
  });

  it("appends to (does not replace) the existing memoryCards collection", () => {
    const s = freshState();
    s.memoryCards = [2];
    s.memoryChips = 1;
    runTownVisitAction(s, { kind: "convert-memory-chips-to-cards" });
    expect(s.memoryCards).toHaveLength(2);
    expect(s.memoryCards[0]).toBe(2);
  });

  it("fires from page32-machinist-A-witness onEnter", () => {
    const s = freshState();
    s.memoryChips = 2;
    startTownVisit(s, "ch2");
    setTownVisitPage(s, "page32-machinist-A-witness");
    const out = applyOnEnter(s);
    expect(s.memoryChips).toBe(0);
    expect(s.memoryCards).toHaveLength(2);
    expect(out.events.find((e) => e.kind === "memory-cards-gained")).toBeDefined();
  });
});

// --- finishTownVisit for Chapter 2 ----------------------------------------

describe("chapter2 — finishTownVisit", () => {
  it("flips townVisit2Completed and clears the visit", () => {
    const s = freshState();
    s.townVisit2Completed = false;
    startTownVisit(s, "ch2");
    finishTownVisit(s);
    expect(s.townVisit2Completed).toBe(true);
    expect(s.townVisit).toBeNull();
  });

  it("clears storyTokens (visit-scoped pool shouldn't leak)", () => {
    const s = freshState();
    s.storyTokens = 1; // pretend the player exits with a token still owed
    startTownVisit(s, "ch2");
    finishTownVisit(s);
    expect(s.storyTokens).toBe(0);
  });

  it("leaves currentQuestId unchanged (Q3 not shipped yet)", () => {
    const s = freshState();
    s.currentQuestId = "quest2";
    startTownVisit(s, "ch2");
    finishTownVisit(s);
    expect(s.currentQuestId).toBe("quest2");
  });

  it("does NOT touch townVisit1Completed", () => {
    const s = freshState();
    s.townVisit1Completed = true;
    startTownVisit(s, "ch2");
    finishTownVisit(s);
    expect(s.townVisit1Completed).toBe(true);
  });
});
