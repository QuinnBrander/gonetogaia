/**
 * Tests for the two OS equipment cards:
 *
 *   - Providence OS (Mind R1) — `bonus-xp-on-kill`. Adds +1 to the
 *     shared XP pool whenever an enemy that grants XP dies, IFF at
 *     least one LIVING delver owns it. Wired into
 *     `engine/kills.ts > applyKill` via `xpBonusFromPassives`.
 *
 *   - Elemental OS (Body R1) — `gain-element-on-acquire` (IMMEDIATELY)
 *     and `gain-element-at-end-of-wave` (ONGOING). Both effects
 *     enqueue {@link PendingElementChoice} entries on
 *     `state.encounter.pendingElementChoices`; the player picks via
 *     the `element-pick` UI modal, which dispatches
 *     `engine/os.ts > applyElementChoice`.
 *
 * Coverage map:
 *   - Providence:
 *       - alive bearer, +1 fires
 *       - dead bearer, no bonus
 *       - enemy that grants 0 XP — no bonus (gate is conditional)
 *       - bearer at R0 (unowned) — no bonus
 *       - structural detection (no hard-coding of the card id)
 *   - Elemental IMMEDIATELY:
 *       - first-time gain enqueues 1 element pick for the bearer
 *       - rank-up (R1 → R2) does NOT re-enqueue
 *       - dead bearer skipped
 *   - Elemental ONGOING (end of each wave, only when continuing):
 *       - both delvers each get one prompt when bearer owns it
 *       - End Wave alone queues nothing; continuing to the next wave
 *         (`bootstrapNextWave`) queues them on the new wave
 *       - dead delver is skipped
 *       - no enqueue if no delver owns the OS
 *   - applyElementChoice:
 *       - grants the chosen element (cap respected)
 *       - pops the queue
 *       - returns ok=false on empty queue
 */

import { describe, it, expect, beforeEach } from "vitest";

import { newCampaign, type CampaignState } from "../state";
import { QUEST1, getEnemy, getEquipment, getQuestData } from "../data";
import { ensureEncounter } from "../engine/encounter";
import { applyKill, xpBonusFromPassives } from "../engine/kills";
import { applyLevelUpChoice } from "../engine/levelUp";
import {
  applyElementChoice,
  enqueueElementChoice,
  enqueueEndWaveElementChoices,
  hasPendingElementChoices,
  peekNextPendingElementChoice,
} from "../engine/os";
import { bootstrapNextWave, enterEndOfWave } from "../engine/wave";

const noShuffle = (pool: readonly string[]) => [...pool];

function freshState(): CampaignState {
  const s = newCampaign();
  ensureEncounter(s, QUEST1, noShuffle);
  return s;
}

/** Mark Mind delver as owning Providence OS (Mind R1). */
function ownProvidence(s: CampaignState): void {
  s.equipmentRanks["hero-01"] = { ...s.equipmentRanks["hero-01"], OS: 1 };
}

/** Mark Body delver as owning Elemental OS (Body R1). */
function ownElemental(s: CampaignState): void {
  s.equipmentRanks["hero-02"] = { ...s.equipmentRanks["hero-02"], OS: 1 };
}

// --- Providence OS (Mind) — bonus-xp-on-kill ---------------------------

describe("Providence OS — bonus-xp-on-kill", () => {
  // Pick a minion that actually prints XP in `onDeath.gainXp` so the
  // bonus-vs-baseline assertions are meaningful. crystanid-002 grants
  // 1 XP per kill (the unit-test reference card for "kills that grant
  // XP"); crystanid-006 grants 0 XP and only drops elements, so it's
  // used in the negative test below.
  const xpGrantingMinion = () => getEnemy("crystanid-002");
  const noXpMinion = () => getEnemy("crystanid-006");

  it("adds +1 XP when a LIVING bearer owns the OS and the enemy grants XP", () => {
    const s = freshState();
    ownProvidence(s);
    const printedXp = xpGrantingMinion().onDeath.gainXp ?? 0;
    expect(printedXp).toBeGreaterThan(0);

    const r = applyKill(s, xpGrantingMinion(), { x: 0, y: 0 });

    expect(r.xpBonus).toBe(1);
    expect(r.xpGained).toBe(printedXp + 1);
    expect(s.xpOnHand).toBe(printedXp + 1);
    expect(s.totalXp).toBe(printedXp + 1);
  });

  // Rank scaling (2026-07-22, "all equipment fully authored through
  // all ranks" pass): Providence OS prints +1/+2/+3/+4/+5 per rank.
  // Pre-fix `xpBonusFromPassives` read the R1 card and every rank
  // granted +1.
  it("scales the bonus with the OS rank (R3 grants +3)", () => {
    const s = freshState();
    s.equipmentRanks["hero-01"] = { ...s.equipmentRanks["hero-01"], OS: 3 };
    const printedXp = xpGrantingMinion().onDeath.gainXp ?? 0;

    const r = applyKill(s, xpGrantingMinion(), { x: 0, y: 0 });

    expect(r.xpBonus).toBe(3);
    expect(r.xpGained).toBe(printedXp + 3);
  });

  it("does NOT add the bonus when the bearer is dead (currentHp <= 0)", () => {
    const s = freshState();
    ownProvidence(s);
    s.loadouts["hero-01"]!.currentHp = 0;
    const printedXp = xpGrantingMinion().onDeath.gainXp ?? 0;

    const r = applyKill(s, xpGrantingMinion(), { x: 0, y: 0 });

    expect(r.xpBonus).toBe(0);
    expect(r.xpGained).toBe(printedXp);
    expect(s.xpOnHand).toBe(printedXp);
  });

  it("does NOT add the bonus when no delver owns Providence OS", () => {
    const s = freshState();
    // No ownership; OS rank stays at 0 for both delvers.
    const printedXp = xpGrantingMinion().onDeath.gainXp ?? 0;

    const r = applyKill(s, xpGrantingMinion(), { x: 0, y: 0 });

    expect(r.xpBonus).toBe(0);
    expect(r.xpGained).toBe(printedXp);
  });

  it("does NOT add the bonus when the enemy grants 0 XP (gate is conditional)", () => {
    const s = freshState();
    ownProvidence(s);
    // crystanid-006 prints `gainXp: 0` (drops only an element). The
    // passive should NOT slip a bonus in here — card text says
    // "Enemies that grant XP grant 1 additional XP", so 0 stays 0.
    expect(noXpMinion().onDeath.gainXp ?? 0).toBe(0);

    const r = applyKill(s, noXpMinion(), { x: 0, y: 0 });

    expect(r.xpBonus).toBe(0);
    expect(r.xpGained).toBe(0);
    expect(s.xpOnHand).toBe(0);
  });

  it("xpBonusFromPassives returns 0 when printedXp <= 0 even with bearer owning", () => {
    const s = freshState();
    ownProvidence(s);
    expect(xpBonusFromPassives(s, 0)).toBe(0);
    expect(xpBonusFromPassives(s, -3)).toBe(0);
  });

  it("xpBonusFromPassives reads the effect structurally (no card-id hardcode)", () => {
    // Sanity check that our test setup's "ownProvidence" actually
    // wires the structural effect, not a magic id check. If someone
    // ever moves Providence OS off `mind-os-r1` (e.g. card-renumber)
    // this test would still pass, but a typo'd effect kind would
    // fail it — which is the intent.
    const s = freshState();
    ownProvidence(s);
    const card = getEquipment("mind-os-r1");
    expect(card.effects ?? []).toContainEqual({ kind: "bonus-xp-on-kill", amount: 1 });
    expect(xpBonusFromPassives(s, 1)).toBe(1);
  });
});

// --- Elemental OS (Body) — IMMEDIATELY: gain-element-on-acquire --------

describe("Elemental OS — IMMEDIATELY (gain-element-on-acquire)", () => {
  function rigLevelUpOSDraw(s: CampaignState, heroId: string): void {
    // Place an OS-bearing card at the head of the deck and seed
    // exactly one pending draw against it for the body delver.
    // levelUp card #36 is the body-side "Elemental OS" art (matches
    // body-os-r1.cardNumber). Use a real OS-typed card from the
    // deck instead so this stays robust to data churn.
    const enc = s.encounter!;
    enc.pendingLevelUpDraws.push({ heroId, cardNumber: 2 }); // card 2 has OS in its types
  }

  it("first-time gain (R0 -> R1) enqueues 1 element pick for the bearer", () => {
    const s = freshState();
    expect(hasPendingElementChoices(s)).toBe(false);
    rigLevelUpOSDraw(s, "hero-02");

    const r = applyLevelUpChoice(s, "OS");

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.heroId).toBe("hero-02");
      expect(r.newRank).toBe(1);
    }
    expect(hasPendingElementChoices(s)).toBe(true);
    const head = peekNextPendingElementChoice(s)!;
    expect(head.heroId).toBe("hero-02");
    expect(head.source.kind).toBe("os-immediate");
    expect(head.source.kind === "os-immediate" && head.source.cardId).toBe("body-os-r1");
  });

  it("rank-up (R1 -> R2) does NOT re-enqueue an element pick", () => {
    const s = freshState();
    s.equipmentRanks["hero-02"]!.OS = 1;
    rigLevelUpOSDraw(s, "hero-02");

    const r = applyLevelUpChoice(s, "OS");

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.newRank).toBe(2);
    expect(hasPendingElementChoices(s)).toBe(false);
  });

  it("dead bearer is skipped at enqueue time (defensive)", () => {
    const s = freshState();
    s.loadouts["hero-02"]!.currentHp = 0;
    rigLevelUpOSDraw(s, "hero-02");

    applyLevelUpChoice(s, "OS");

    // Rank still bumps (the engine call doesn't itself gate on
    // alive — the post-effect enqueue does), but no pending
    // element choice is created.
    expect(s.equipmentRanks["hero-02"]!.OS).toBe(1);
    expect(hasPendingElementChoices(s)).toBe(false);
  });
});

// --- Elemental OS (Body) — ONGOING: gain-element-at-end-of-wave ------

describe("Elemental OS — ONGOING (end of each wave)", () => {
  it("enqueues 1 element pick for EACH living delver when bearer owns it", () => {
    const s = freshState();
    ownElemental(s);
    expect(hasPendingElementChoices(s)).toBe(false);

    const enqueued = enqueueEndWaveElementChoices(s);

    expect(enqueued).toBe(2);
    const enc = s.encounter!;
    expect(enc.pendingElementChoices.length).toBe(2);
    const heroIds = enc.pendingElementChoices.map((p) => p.heroId);
    expect(new Set(heroIds)).toEqual(new Set(["hero-01", "hero-02"]));
    expect(enc.pendingElementChoices.every((p) => p.source.kind === "end-of-wave")).toBe(true);
  });

  // Rank scaling (2026-07-22): Elemental OS prints 1/2/3/4/5
  // end-of-wave element grants per rank — R2 yields TWO prompts per
  // living delver. Pre-fix the walk read the R1 card at every rank.
  it("R2 Elemental OS enqueues 2 picks per living delver (4 total)", () => {
    const s = freshState();
    s.equipmentRanks["hero-02"] = { ...s.equipmentRanks["hero-02"], OS: 2 };

    const enqueued = enqueueEndWaveElementChoices(s);

    expect(enqueued).toBe(4);
    const perHero = new Map<string, number>();
    for (const p of s.encounter!.pendingElementChoices) {
      perHero.set(p.heroId, (perHero.get(p.heroId) ?? 0) + 1);
    }
    expect(perHero.get("hero-01")).toBe(2);
    expect(perHero.get("hero-02")).toBe(2);
  });

  it("skips a dead delver but still enqueues for the living one", () => {
    const s = freshState();
    ownElemental(s);
    s.loadouts["hero-01"]!.currentHp = 0;

    const enqueued = enqueueEndWaveElementChoices(s);

    expect(enqueued).toBe(1);
    expect(s.encounter!.pendingElementChoices[0]!.heroId).toBe("hero-02");
  });

  it("no-ops when no delver owns Elemental OS", () => {
    const s = freshState();
    // No ownership setup — OS rank is 0 for both.

    const enqueued = enqueueEndWaveElementChoices(s);

    expect(enqueued).toBe(0);
    expect(hasPendingElementChoices(s)).toBe(false);
  });

  it("End Wave alone queues nothing (the party might be leaving the Tide)", () => {
    const s = freshState();
    ownElemental(s);
    enterEndOfWave(s, "victory");
    expect(s.encounter!.pendingElementChoices.length).toBe(0);
  });

  it("continuing to the next wave queues the picks on the NEW wave, once", () => {
    const s = freshState();
    ownElemental(s);
    enterEndOfWave(s, "victory");
    s.encounter = null; // completeWave

    const events = bootstrapNextWave(s, getQuestData("quest2"), 2);

    expect(s.encounter!.waveNumber).toBe(2);
    expect(s.encounter!.pendingElementChoices.map((p) => p.heroId)).toEqual(["hero-01", "hero-02"]);
    expect(events.some((e) => e.kind === "wave-effect" && e.text.startsWith("2 element picks"))).toBe(true);
  });
});

// --- applyElementChoice (queue resolver) -------------------------------

describe("applyElementChoice", () => {
  beforeEach(() => {
    // Fresh state for each test so queues don't leak.
  });

  it("grants the chosen element to the head delver and pops the queue", () => {
    const s = freshState();
    enqueueElementChoice(s, {
      heroId: "hero-01",
      source: { kind: "os-immediate", cardId: "body-os-r1" },
    });
    expect(hasPendingElementChoices(s)).toBe(true);
    expect(s.elements["hero-01"]?.fire ?? 0).toBe(0);

    const r = applyElementChoice(s, "fire");

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry.heroId).toBe("hero-01");
      expect(r.outcome.granted).toBe(true);
      expect(r.outcome.element).toBe("fire");
    }
    expect(s.elements["hero-01"]!.fire).toBe(1);
    expect(hasPendingElementChoices(s)).toBe(false);
  });

  it("respects the per-element cap (overflow lost, but still pops the queue)", () => {
    const s = freshState();
    s.elements["hero-01"] = { water: 2 };
    enqueueElementChoice(s, {
      heroId: "hero-01",
      source: { kind: "end-of-wave", cardId: "body-os-r1" },
    });

    const r = applyElementChoice(s, "water");

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.outcome.granted).toBe(false);
      expect(r.outcome.newTotal).toBe(2);
    }
    // The grant didn't land but the queue still empties — the player
    // doesn't get to re-pick a different element after the fact.
    expect(s.elements["hero-01"]!.water).toBe(2);
    expect(hasPendingElementChoices(s)).toBe(false);
  });

  it("returns ok:false when the queue is empty (defensive double-click)", () => {
    const s = freshState();
    expect(hasPendingElementChoices(s)).toBe(false);

    const r = applyElementChoice(s, "earth");

    expect(r.ok).toBe(false);
  });

  it("processes multiple queued entries FIFO", () => {
    const s = freshState();
    enqueueElementChoice(s, {
      heroId: "hero-01",
      source: { kind: "end-of-wave", cardId: "body-os-r1" },
    });
    enqueueElementChoice(s, {
      heroId: "hero-02",
      source: { kind: "end-of-wave", cardId: "body-os-r1" },
    });

    const r1 = applyElementChoice(s, "wind");
    expect(r1.ok && r1.entry.heroId).toBe("hero-01");
    const r2 = applyElementChoice(s, "void");
    expect(r2.ok && r2.entry.heroId).toBe("hero-02");

    expect(s.elements["hero-01"]!.wind).toBe(1);
    expect(s.elements["hero-02"]!.void).toBe(1);
    expect(hasPendingElementChoices(s)).toBe(false);
  });
});
