/**
 * Tests for src/engine/creatureParts.ts and the post-effect path
 * `finalizeAttackSession` rides into the pending-pick queue when
 * a Gauntlet swing carries `collect-creature-part`.
 *
 * Covers:
 *   - `enqueueCreaturePartChoice` pushes one entry per call.
 *   - `applyCreaturePartChoice(state, heroId, x, y)` claims one
 *     creature-part drop owed to the bearer at (x, y), credits
 *     the matching wallet (MINION → minionParts; BOSS / boss-lvl-N
 *     → bossParts), pops the queue head, and rejects when:
 *       - The head's heroId doesn't match.
 *       - The named tile has no eligible drop owed to the bearer.
 *       - The queue is empty / no encounter.
 *   - `skipCreaturePartChoice` drains the head as a no-op (used
 *     by the modal when no eligible drops exist).
 *   - `availableCreaturePartDropsForHero` filters tileDrops down
 *     to creature-part subtypes owed to the bearer (excludes
 *     other delvers' drops + non-part drops).
 *   - `hasPendingCreaturePartChoices` /
 *     `peekNextPendingCreaturePartChoice` mirror the queue.
 *   - End-to-end via `finalizeAttackSession`:
 *       - A `collect-creature-part` post-effect with `count: 2`
 *         enqueues 2 picks (NOT a single batch grant).
 *       - The wallet counters are NOT mutated at finalize time
 *         — the player's pick is the only path to a credit.
 *   - `useWeaponAbility` integration: a Gauntlet R2 swing seeds
 *     the queue with 1 pick on the body suit and 2 picks on the
 *     mind suit (matches the printed counts).
 */

import { describe, it, expect, beforeEach } from "vitest";

import { bossWallet, newCampaign, type CampaignState, type EnemyInstance } from "../state";
import { QUEST1 } from "../data";
import { ensureEncounter } from "../engine/encounter";
import { startHeroTurn, useWeaponAbility, playWeaponCard } from "../engine/turn";
import {
  buildAttackSession,
  finalizeAttackSession,
} from "../engine/combat";
import {
  applyCreaturePartChoice,
  availableCreaturePartDropsForHero,
  enqueueCreaturePartChoice,
  hasPendingCreaturePartChoices,
  peekNextPendingCreaturePartChoice,
  skipCreaturePartChoice,
} from "../engine/creatureParts";

/**
 * Encounter set up with both delvers placed at known tiles and
 * no enemies. Caller plugs Gauntlet (or whatever) into a slot
 * via the existing `playWeaponCard` primitive — `equipmentRanks`
 * is bumped per-test.
 */
function emptyArena(): CampaignState {
  const state = newCampaign();
  ensureEncounter(state, QUEST1);
  state.encounter!.phase = "hero";
  state.encounter!.enemies = [];
  state.encounter!.delverPositions["hero-01"] = { x: 1, y: 1 };
  state.encounter!.delverPositions["hero-02"] = { x: 5, y: 5 };
  return state;
}

function placeEnemy(state: CampaignState, instanceId: string, x: number, y: number): EnemyInstance {
  const e: EnemyInstance = {
    instanceId,
    cardId: "crystanid-001",
    x, y,
    damageTaken: 0,
    alive: true,
    facing: 0,
  };
  state.encounter!.enemies.push(e);
  return e;
}

function pushDrop(
  state: CampaignState,
  heroId: string,
  dropId: string,
  x: number,
  y: number,
): void {
  state.encounter!.tileDrops.push({ x, y, heroId, dropId });
}

// --- queue mutators --------------------------------------------------

describe("enqueueCreaturePartChoice", () => {
  let s: CampaignState;
  beforeEach(() => { s = emptyArena(); });

  it("pushes one entry per call (no de-duplication)", () => {
    enqueueCreaturePartChoice(s, "hero-01", "mind-gauntlet-r2");
    enqueueCreaturePartChoice(s, "hero-01", "mind-gauntlet-r2");
    expect(s.encounter!.pendingCreaturePartChoices).toHaveLength(2);
    expect(s.encounter!.pendingCreaturePartChoices.every(
      (p) => p.heroId === "hero-01" && p.sourceCardId === "mind-gauntlet-r2",
    )).toBe(true);
  });

  it("captures `heroId` and `sourceCardId` verbatim", () => {
    enqueueCreaturePartChoice(s, "hero-02", "body-gauntlet-r5");
    expect(s.encounter!.pendingCreaturePartChoices[0]).toEqual({
      heroId: "hero-02",
      sourceCardId: "body-gauntlet-r5",
    });
  });

  it("is a no-op when there's no encounter (defensive)", () => {
    s.encounter = null;
    enqueueCreaturePartChoice(s, "hero-01", "mind-gauntlet-r1");
    expect(s.encounter).toBeNull();
  });
});

// --- availableCreaturePartDropsForHero -------------------------------

describe("availableCreaturePartDropsForHero", () => {
  let s: CampaignState;
  beforeEach(() => { s = emptyArena(); });

  it("returns drops owed to the bearer, excluding the other delver's", () => {
    pushDrop(s, "hero-01", "minion-part", 2, 2);
    pushDrop(s, "hero-01", "boss-part", 3, 3);
    pushDrop(s, "hero-02", "minion-part", 4, 4);
    const got = availableCreaturePartDropsForHero(s, "hero-01");
    expect(got.map((d) => `${d.x},${d.y},${d.dropId}`)).toEqual([
      "2,2,minion-part",
      "3,3,boss-part",
    ]);
  });

  it("includes leveled boss-part subtypes (boss-part-lvl-N)", () => {
    pushDrop(s, "hero-01", "boss-part-lvl-2", 0, 0);
    pushDrop(s, "hero-01", "boss-part-lvl-3", 1, 1);
    const got = availableCreaturePartDropsForHero(s, "hero-01");
    expect(got).toHaveLength(2);
  });

  it("excludes non-creature-part drops (defensive — placeholder for future drop kinds)", () => {
    pushDrop(s, "hero-01", "minion-part", 0, 0);
    pushDrop(s, "hero-01", "key-item-1", 1, 1);
    const got = availableCreaturePartDropsForHero(s, "hero-01");
    expect(got).toHaveLength(1);
    expect(got[0]!.dropId).toBe("minion-part");
  });

  it("returns [] for no-encounter state", () => {
    s.encounter = null;
    expect(availableCreaturePartDropsForHero(s, "hero-01")).toEqual([]);
  });
});

// --- applyCreaturePartChoice ----------------------------------------

describe("applyCreaturePartChoice", () => {
  let s: CampaignState;
  beforeEach(() => {
    s = emptyArena();
    enqueueCreaturePartChoice(s, "hero-01", "mind-gauntlet-r2");
  });

  it("credits MINION wallet when the picked tile carries minion-part, pops the head, and removes the drop", () => {
    pushDrop(s, "hero-01", "minion-part", 2, 2);
    const before = s.minionParts["hero-01"] ?? 0;
    const r = applyCreaturePartChoice(s, "hero-01", 2, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dropId).toBe("minion-part");
    expect(s.minionParts["hero-01"]).toBe(before + 1);
    expect(s.encounter!.pendingCreaturePartChoices).toHaveLength(0);
    expect(s.encounter!.tileDrops).toHaveLength(0);
  });

  it("credits BOSS wallet when the picked tile carries boss-part", () => {
    pushDrop(s, "hero-01", "boss-part", 3, 3);
    const before = s.bossParts["hero-01"] ?? 0;
    const r = applyCreaturePartChoice(s, "hero-01", 3, 3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dropId).toBe("boss-part");
    expect(s.bossParts["hero-01"]).toBe(before + 1);
  });

  it("credits the matching level's BOSS wallet for boss-part-lvl-<N> subtypes (v58+)", () => {
    pushDrop(s, "hero-01", "boss-part-lvl-2", 0, 0);
    const lvl1Before = s.bossParts["hero-01"] ?? 0;
    const lvl2Before = bossWallet(s, 2)["hero-01"] ?? 0;
    const r = applyCreaturePartChoice(s, "hero-01", 0, 0);
    expect(r.ok).toBe(true);
    expect(bossWallet(s, 2)["hero-01"]).toBe(lvl2Before + 1);
    expect(s.bossParts["hero-01"] ?? 0).toBe(lvl1Before);
  });

  it("rejects when the picked tile has no drop owed to the bearer (no mutation)", () => {
    // Only the OTHER delver has a drop here.
    pushDrop(s, "hero-02", "minion-part", 4, 4);
    const r = applyCreaturePartChoice(s, "hero-01", 4, 4);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no creature-part drop/);
    // Queue + drops unchanged.
    expect(s.encounter!.pendingCreaturePartChoices).toHaveLength(1);
    expect(s.encounter!.tileDrops).toHaveLength(1);
  });

  it("rejects when the queue head is for a different hero (defensive)", () => {
    pushDrop(s, "hero-02", "minion-part", 4, 4);
    const r = applyCreaturePartChoice(s, "hero-02", 4, 4);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/head pick is for hero-01/);
    expect(s.encounter!.pendingCreaturePartChoices).toHaveLength(1);
    expect(s.encounter!.tileDrops).toHaveLength(1);
  });

  it("rejects when the queue is empty", () => {
    s.encounter!.pendingCreaturePartChoices = [];
    pushDrop(s, "hero-01", "minion-part", 2, 2);
    const r = applyCreaturePartChoice(s, "hero-01", 2, 2);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no pending creature-part picks/);
  });

  it("multi-drop tile: each pick consumes one drop (FIFO)", () => {
    pushDrop(s, "hero-01", "minion-part", 2, 2);
    pushDrop(s, "hero-01", "boss-part", 2, 2);
    enqueueCreaturePartChoice(s, "hero-01", "mind-gauntlet-r2");
    expect(s.encounter!.pendingCreaturePartChoices).toHaveLength(2);

    const r1 = applyCreaturePartChoice(s, "hero-01", 2, 2);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.dropId).toBe("minion-part");
    expect(s.minionParts["hero-01"]).toBe(1);
    expect(s.bossParts["hero-01"] ?? 0).toBe(0);
    expect(s.encounter!.tileDrops).toHaveLength(1);
    expect(s.encounter!.pendingCreaturePartChoices).toHaveLength(1);

    const r2 = applyCreaturePartChoice(s, "hero-01", 2, 2);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.dropId).toBe("boss-part");
    expect(s.bossParts["hero-01"]).toBe(1);
    expect(s.encounter!.tileDrops).toHaveLength(0);
    expect(s.encounter!.pendingCreaturePartChoices).toHaveLength(0);
  });
});

// --- skipCreaturePartChoice -----------------------------------------

describe("skipCreaturePartChoice", () => {
  let s: CampaignState;
  beforeEach(() => {
    s = emptyArena();
    enqueueCreaturePartChoice(s, "hero-01", "mind-gauntlet-r2");
  });

  it("drains the head with no wallet credit and no tileDrop mutation", () => {
    const beforeMinion = s.minionParts["hero-01"] ?? 0;
    const beforeBoss = s.bossParts["hero-01"] ?? 0;
    const r = skipCreaturePartChoice(s, "hero-01");
    expect(r.ok).toBe(true);
    expect(s.encounter!.pendingCreaturePartChoices).toHaveLength(0);
    expect(s.minionParts["hero-01"] ?? 0).toBe(beforeMinion);
    expect(s.bossParts["hero-01"] ?? 0).toBe(beforeBoss);
  });

  it("rejects when the queue head is for a different hero", () => {
    const r = skipCreaturePartChoice(s, "hero-02");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/head pick is for hero-01/);
    expect(s.encounter!.pendingCreaturePartChoices).toHaveLength(1);
  });

  it("rejects when the queue is empty", () => {
    s.encounter!.pendingCreaturePartChoices = [];
    const r = skipCreaturePartChoice(s, "hero-01");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no pending creature-part picks/);
  });
});

// --- hasPendingCreaturePartChoices / peekNext ------------------------

describe("hasPendingCreaturePartChoices + peekNextPendingCreaturePartChoice", () => {
  let s: CampaignState;
  beforeEach(() => { s = emptyArena(); });

  it("empty queue → has=false, peek=null", () => {
    expect(hasPendingCreaturePartChoices(s)).toBe(false);
    expect(peekNextPendingCreaturePartChoice(s)).toBeNull();
  });

  it("non-empty queue → has=true, peek returns the head", () => {
    enqueueCreaturePartChoice(s, "hero-01", "mind-gauntlet-r2");
    expect(hasPendingCreaturePartChoices(s)).toBe(true);
    expect(peekNextPendingCreaturePartChoice(s)).toEqual({
      heroId: "hero-01",
      sourceCardId: "mind-gauntlet-r2",
    });
  });

  it("survives no-encounter state (defensive)", () => {
    s.encounter = null;
    expect(hasPendingCreaturePartChoices(s)).toBe(false);
    expect(peekNextPendingCreaturePartChoice(s)).toBeNull();
  });
});

// --- finalizeAttackSession integration -------------------------------

describe("finalizeAttackSession enqueues creature-part picks", () => {
  let s: CampaignState;
  beforeEach(() => { s = emptyArena(); });

  it("a `collect-creature-part` post-effect with count=N enqueues N picks (no direct wallet credit)", () => {
    const session = buildAttackSession({
      attackerId: "hero-01",
      source: { kind: "weapon", slotIdx: 1, cardId: "mind-gauntlet-r1" },
      damage: 1,
      hitTiles: [{ x: 2, y: 1 }],
      postEffects: [
        { kind: "collect-creature-part", count: 2, sourceCardId: "mind-gauntlet-r2" },
      ],
    });
    const beforeMinion = s.minionParts["hero-01"] ?? 0;
    const beforeBoss = s.bossParts["hero-01"] ?? 0;
    const r = finalizeAttackSession(s, session);
    expect(r.creaturePartsEnqueued).toBe(2);
    // Wallets MUST stay flat at finalize time — the picks haven't
    // been resolved yet.
    expect(s.minionParts["hero-01"] ?? 0).toBe(beforeMinion);
    expect(s.bossParts["hero-01"] ?? 0).toBe(beforeBoss);
    expect(s.encounter!.pendingCreaturePartChoices).toHaveLength(2);
    expect(s.encounter!.pendingCreaturePartChoices.every(
      (p) => p.heroId === "hero-01" && p.sourceCardId === "mind-gauntlet-r2",
    )).toBe(true);
  });

  it("returns 0 enqueued when the session has no creature-part post-effects", () => {
    const session = buildAttackSession({
      attackerId: "hero-01",
      source: { kind: "weapon", slotIdx: 0, cardId: "mind-hammer-r1" },
      damage: 1,
      hitTiles: [{ x: 2, y: 1 }],
      postEffects: [],
    });
    const r = finalizeAttackSession(s, session);
    expect(r.creaturePartsEnqueued).toBe(0);
    expect(s.encounter!.pendingCreaturePartChoices).toHaveLength(0);
  });

  it("idempotent re-finalize doesn't re-enqueue (no double-spend on a re-run)", () => {
    const session = buildAttackSession({
      attackerId: "hero-01",
      source: { kind: "weapon", slotIdx: 1, cardId: "mind-gauntlet-r1" },
      damage: 1,
      hitTiles: [{ x: 2, y: 1 }],
      postEffects: [
        { kind: "collect-creature-part", count: 1, sourceCardId: "mind-gauntlet-r1" },
      ],
    });
    finalizeAttackSession(s, session);
    expect(s.encounter!.pendingCreaturePartChoices).toHaveLength(1);
    finalizeAttackSession(s, session);
    expect(s.encounter!.pendingCreaturePartChoices).toHaveLength(1);
  });
});

// --- useWeaponAbility integration ------------------------------------

describe("useWeaponAbility seeds creature-part picks via Gauntlet", () => {
  it("Mind Gauntlet R1 (Surge Claw) — count=1 → 1 pending pick", () => {
    const s = emptyArena();
    s.currentDelverId = "hero-01";
    s.equipmentRanks["hero-01"]!.Gauntlet = 1;
    startHeroTurn(s);
    const placed = playWeaponCard(s, "hero-01", 0, "mind-gauntlet-r1");
    expect(placed.ok).toBe(true);
    // Surge Claw needs the OTHER delver adjacent to a chain
    // start (range `chain` with `requiresAdjacentTo: "other"`).
    // Park hero-02 adjacent to the target.
    s.encounter!.delverPositions["hero-02"] = { x: 2, y: 1 };
    placeEnemy(s, "victim", 2, 2);

    const r = useWeaponAbility(
      s, "hero-01", 0,
      { kind: "chain", targetX: 2, targetY: 2 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    finalizeAttackSession(s, r.session);
    expect(s.encounter!.pendingCreaturePartChoices).toHaveLength(1);
    expect(s.encounter!.pendingCreaturePartChoices[0]!.sourceCardId).toBe("mind-gauntlet-r1");
  });

  it("Mind Gauntlet R2 (Surge Claw) — count=2 → 2 pending picks", () => {
    const s = emptyArena();
    s.currentDelverId = "hero-01";
    s.equipmentRanks["hero-01"]!.Gauntlet = 2;
    startHeroTurn(s);
    const placed = playWeaponCard(s, "hero-01", 0, "mind-gauntlet-r1");
    expect(placed.ok).toBe(true);
    s.encounter!.delverPositions["hero-02"] = { x: 2, y: 1 };
    placeEnemy(s, "victim", 2, 2);

    const r = useWeaponAbility(
      s, "hero-01", 0,
      { kind: "chain", targetX: 2, targetY: 2 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    finalizeAttackSession(s, r.session);
    expect(s.encounter!.pendingCreaturePartChoices).toHaveLength(2);
    expect(s.encounter!.pendingCreaturePartChoices.every(
      (p) => p.sourceCardId === "mind-gauntlet-r2",
    )).toBe(true);
  });

  it("Body Gauntlet R1 (Chain Gauntlet) — no `collect-creature-part` effect at R1 → 0 pending picks", () => {
    const s = emptyArena();
    s.currentDelverId = "hero-02";
    startHeroTurn(s);
    const placed = playWeaponCard(s, "hero-02", 0, "body-gauntlet-r1");
    expect(placed.ok).toBe(true);
    placeEnemy(s, "victim", 5, 6);

    const r = useWeaponAbility(
      s, "hero-02", 0,
      { kind: "chain", targetX: 5, targetY: 6 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    finalizeAttackSession(s, r.session);
    expect(s.encounter!.pendingCreaturePartChoices).toHaveLength(0);
  });

  it("Body Gauntlet R2 (Chain Gauntlet) — count=1 → 1 pending pick", () => {
    const s = emptyArena();
    s.currentDelverId = "hero-02";
    s.equipmentRanks["hero-02"]!.Gauntlet = 2;
    startHeroTurn(s);
    const placed = playWeaponCard(s, "hero-02", 0, "body-gauntlet-r1");
    expect(placed.ok).toBe(true);
    placeEnemy(s, "victim", 5, 6);

    const r = useWeaponAbility(
      s, "hero-02", 0,
      { kind: "chain", targetX: 5, targetY: 6 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    finalizeAttackSession(s, r.session);
    expect(s.encounter!.pendingCreaturePartChoices).toHaveLength(1);
    expect(s.encounter!.pendingCreaturePartChoices[0]!.sourceCardId).toBe("body-gauntlet-r2");
  });

  it("freeRepeat swings DO NOT re-enqueue (same as collect-creature-part's existing once-per-ability rule)", () => {
    const s = emptyArena();
    s.currentDelverId = "hero-01";
    s.equipmentRanks["hero-01"]!.Gauntlet = 1;
    startHeroTurn(s);
    const placed = playWeaponCard(s, "hero-01", 0, "mind-gauntlet-r1");
    expect(placed.ok).toBe(true);
    s.encounter!.delverPositions["hero-02"] = { x: 2, y: 1 };
    placeEnemy(s, "v1", 2, 2);

    const first = useWeaponAbility(
      s, "hero-01", 0,
      { kind: "chain", targetX: 2, targetY: 2 },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    finalizeAttackSession(s, first.session);
    expect(s.encounter!.pendingCreaturePartChoices).toHaveLength(1);

    s.encounter!.pendingCreaturePartChoices = [];

    placeEnemy(s, "v2", 0, 1);
    const repeat = useWeaponAbility(
      s, "hero-01", 0,
      { kind: "chain", targetX: 0, targetY: 1 },
      { freeRepeat: true },
    );
    expect(repeat.ok).toBe(true);
    if (!repeat.ok) return;
    finalizeAttackSession(s, repeat.session);
    expect(s.encounter!.pendingCreaturePartChoices).toHaveLength(0);
  });
});

// --- end-to-end: queue + board drops → claim from any tile -----------

describe("end-to-end: gauntlet swing → queue + board drops → bearer claims from any tile", () => {
  it("Surge Claw R1 swing followed by a board drop → bearer can claim from a remote tile (the 'from any tile' clause)", () => {
    const s = emptyArena();
    s.currentDelverId = "hero-01";
    s.equipmentRanks["hero-01"]!.Gauntlet = 1;
    startHeroTurn(s);
    const placed = playWeaponCard(s, "hero-01", 0, "mind-gauntlet-r1");
    expect(placed.ok).toBe(true);
    s.encounter!.delverPositions["hero-02"] = { x: 2, y: 1 };
    placeEnemy(s, "victim", 2, 2);

    const r = useWeaponAbility(
      s, "hero-01", 0,
      { kind: "chain", targetX: 2, targetY: 2 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    finalizeAttackSession(s, r.session);

    // Simulate a pre-existing drop on a tile far from the bearer
    // — the gauntlet's "from any tile" clause should let the
    // bearer pluck it without movement.
    pushDrop(s, "hero-01", "minion-part", 6, 6);

    expect(s.encounter!.pendingCreaturePartChoices).toHaveLength(1);
    const drops = availableCreaturePartDropsForHero(s, "hero-01");
    expect(drops).toHaveLength(1);

    const claim = applyCreaturePartChoice(s, "hero-01", 6, 6);
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(claim.dropId).toBe("minion-part");
    expect(s.minionParts["hero-01"]).toBe(1);
    expect(s.encounter!.pendingCreaturePartChoices).toHaveLength(0);
    // Drop was removed from the board.
    expect(s.encounter!.tileDrops).toHaveLength(0);
  });

  it("Chain Gauntlet R2 swing with no eligible drops → skip drains the queue (no wallet movement)", () => {
    const s = emptyArena();
    s.currentDelverId = "hero-02";
    s.equipmentRanks["hero-02"]!.Gauntlet = 2;
    startHeroTurn(s);
    const placed = playWeaponCard(s, "hero-02", 0, "body-gauntlet-r1");
    expect(placed.ok).toBe(true);
    // No enemies → 0-hit chain swing (allowed for collect-clause
    // weapons via `useWeaponAbility`'s canCollectWithoutAttack guard).
    s.encounter!.enemies = [];

    const r = useWeaponAbility(
      s, "hero-02", 0,
      { kind: "chain", targetX: 5, targetY: 6 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    finalizeAttackSession(s, r.session);

    expect(s.encounter!.pendingCreaturePartChoices).toHaveLength(1);
    const drops = availableCreaturePartDropsForHero(s, "hero-02");
    expect(drops).toHaveLength(0);

    const beforeMinion = s.minionParts["hero-02"] ?? 0;
    const beforeBoss = s.bossParts["hero-02"] ?? 0;
    const skip = skipCreaturePartChoice(s, "hero-02");
    expect(skip.ok).toBe(true);
    expect(s.encounter!.pendingCreaturePartChoices).toHaveLength(0);
    expect(s.minionParts["hero-02"] ?? 0).toBe(beforeMinion);
    expect(s.bossParts["hero-02"] ?? 0).toBe(beforeBoss);
  });
});
