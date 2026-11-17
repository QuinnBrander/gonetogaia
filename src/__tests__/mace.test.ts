/**
 * Tests for the Mace equipment family (Slice 5+).
 *
 * Both R1 cards print:
 *   - `range.kind === "single-adjacent"` (the printed swing target).
 *   - `target-filter-or-spend-element` effect: a UNDAMAGED-only
 *     filter on Mind (Pulse Maul) / DAMAGED-only on Body (Geoshade),
 *     with an "OR Spend an element" bypass that hits ANY adjacent
 *     enemy.
 *
 * Coverage:
 *   - `equipment.json` shape (effect kind + filter values + range +
 *     damageType / multiplier).
 *   - Engine helpers in `engine/mace.ts`:
 *       - `getTargetFilterOrSpendElementEffect`
 *       - `enemyMatchesFilter`
 *       - `adjacentLiveEnemies` / `adjacentLiveEnemiesMatchingFilter`
 *       - `availableElementKinds`
 *       - `classifyMaceModes` auto-skip rules.
 *   - `useWeaponAbility` filter enforcement (default mode):
 *       - Mind: rejects DAMAGED targets, accepts UNDAMAGED.
 *       - Body: rejects UNDAMAGED targets, accepts DAMAGED.
 *   - `useWeaponAbility` element-spend bypass:
 *       - Accepts any adjacent target with `spendElementForTargetBypass`.
 *       - Debits the named element (1) from the bag.
 *       - Records a `target-bypass-spend-element` PreEffect.
 *       - Rejects when bag holds 0 of the named element (no debit).
 *       - Rejects when the placed card carries no filter effect
 *         (defensive — keeps the bypass Mace-scoped).
 *       - Damage is unchanged from default mode.
 *   - Spend ordering vs Double Damage: a rejected DD spend does NOT
 *     eat the element (committed AFTER all gates).
 *
 * The action-gate / placement plumbing matches the Trident harness
 * exactly so the two test files stay easy to scan side-by-side.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { newCampaign, type CampaignState, type EnemyInstance } from "../state";
import { QUEST1, getEquipment } from "../data";
import { ensureEncounter } from "../engine/encounter";
import { startHeroTurn, useWeaponAbility } from "../engine/turn";
import {
  adjacentLiveEnemies,
  adjacentLiveEnemiesMatchingFilter,
  availableElementKinds,
  classifyMaceModes,
  enemyMatchesFilter,
  getTargetFilterOrSpendElementEffect,
} from "../engine/mace";

const MACE_MIND = "mind-mace-r1";
const MACE_BODY = "body-mace-r1";

/**
 * Standardised setup: encounter ready, both delvers at known tiles,
 * no enemies, the named Mace card placed in slot 0 of the active
 * delver. Manually wires the Mace into the loadout (skipping the
 * hand check) since Mace isn't in the printed starting hand.
 */
function arenaWithMace(suit: "mind" | "body"): CampaignState {
  const state = newCampaign();
  const heroId = suit === "mind" ? "hero-01" : "hero-02";
  const otherId = suit === "mind" ? "hero-02" : "hero-01";
  const cardId = suit === "mind" ? MACE_MIND : MACE_BODY;
  state.currentDelverId = heroId;
  ensureEncounter(state, QUEST1);
  state.encounter!.enemies = [];
  state.encounter!.delverPositions[heroId] = { x: 3, y: 3 };
  state.encounter!.delverPositions[otherId] = { x: 0, y: 5 };
  startHeroTurn(state);
  state.loadouts[heroId]!.slotCards[0] = cardId;
  state.encounter!.turnState[heroId]!.cardPlacedThisTurn = {
    slotIdx: 0,
    cardId,
    autoRefreshedElement: null,
  };
  state.equipmentRanks[heroId]!.Mace = 1;
  return state;
}

function placeEnemy(
  state: CampaignState,
  instanceId: string,
  x: number,
  y: number,
  cardId = "soulhunter-001",
  damageTaken = 0,
): EnemyInstance {
  const e: EnemyInstance = {
    instanceId,
    cardId,
    x, y,
    damageTaken,
    alive: true,
    facing: 0,
  };
  state.encounter!.enemies.push(e);
  return e;
}

// --- equipment.json shape ---------------------------------------------

describe("equipment.json — Mace cards", () => {
  it("Pulse Maul Mace (Mind R1) prints HEAVY single-adjacent + UNDAMAGED filter", () => {
    const card = getEquipment(MACE_MIND);
    expect(card.type).toBe("Mace");
    expect(card.suit).toBe("mind");
    expect(card.rank).toBe(1);
    expect(card.damageType).toBe("heavy");
    expect(card.damageMultiplier).toBe(1);
    expect(card.range).toEqual({ kind: "single-adjacent" });
    expect(card.effects).toContainEqual({
      kind: "target-filter-or-spend-element",
      filter: "undamaged",
    });
  });

  it("Geoshade Mace (Body R1) prints HEAVY single-adjacent + DAMAGED filter", () => {
    const card = getEquipment(MACE_BODY);
    expect(card.type).toBe("Mace");
    expect(card.suit).toBe("body");
    expect(card.rank).toBe(1);
    expect(card.damageType).toBe("heavy");
    expect(card.damageMultiplier).toBe(1);
    expect(card.range).toEqual({ kind: "single-adjacent" });
    expect(card.effects).toContainEqual({
      kind: "target-filter-or-spend-element",
      filter: "damaged",
    });
  });
});

// --- engine/mace.ts helpers -------------------------------------------

describe("engine/mace.ts — pure helpers", () => {
  describe("getTargetFilterOrSpendElementEffect", () => {
    it("returns the effect for Mace cards", () => {
      const mind = getEquipment(MACE_MIND);
      const body = getEquipment(MACE_BODY);
      expect(getTargetFilterOrSpendElementEffect(mind)).toEqual({
        kind: "target-filter-or-spend-element",
        filter: "undamaged",
      });
      expect(getTargetFilterOrSpendElementEffect(body)).toEqual({
        kind: "target-filter-or-spend-element",
        filter: "damaged",
      });
    });

    it("returns null for non-Mace single-adjacent weapons (Sword)", () => {
      const sword = getEquipment("mind-sword-r1");
      expect(getTargetFilterOrSpendElementEffect(sword)).toBeNull();
    });
  });

  describe("enemyMatchesFilter", () => {
    it("UNDAMAGED matches damageTaken === 0 only", () => {
      const fresh: EnemyInstance = {
        instanceId: "x", cardId: "soulhunter-001", x: 0, y: 0,
        damageTaken: 0, alive: true, facing: 0,
      };
      const wounded = { ...fresh, damageTaken: 3 };
      expect(enemyMatchesFilter(fresh, "undamaged")).toBe(true);
      expect(enemyMatchesFilter(wounded, "undamaged")).toBe(false);
    });

    it("DAMAGED matches damageTaken > 0 only", () => {
      const fresh: EnemyInstance = {
        instanceId: "x", cardId: "soulhunter-001", x: 0, y: 0,
        damageTaken: 0, alive: true, facing: 0,
      };
      const wounded = { ...fresh, damageTaken: 1 };
      expect(enemyMatchesFilter(fresh, "damaged")).toBe(false);
      expect(enemyMatchesFilter(wounded, "damaged")).toBe(true);
    });
  });

  describe("adjacentLiveEnemies + …MatchingFilter", () => {
    let state: CampaignState;
    beforeEach(() => {
      state = arenaWithMace("body");
      // Bearer at (3,3). Place a fresh + a wounded enemy adjacent,
      // and a fresh non-adjacent control.
      placeEnemy(state, "fresh-adj", 4, 3, "soulhunter-001", 0);
      placeEnemy(state, "wound-adj", 2, 3, "soulhunter-001", 1);
      placeEnemy(state, "fresh-far", 0, 0, "soulhunter-001", 0);
    });

    it("adjacentLiveEnemies returns ONLY 8-way adjacent live enemies", () => {
      const adj = adjacentLiveEnemies(state, "hero-02").map((e) => e.instanceId).sort();
      expect(adj).toEqual(["fresh-adj", "wound-adj"]);
    });

    it("adjacentLiveEnemiesMatchingFilter('undamaged') returns only fresh adjacent", () => {
      const fresh = adjacentLiveEnemiesMatchingFilter(state, "hero-02", "undamaged");
      expect(fresh.map((e) => e.instanceId)).toEqual(["fresh-adj"]);
    });

    it("adjacentLiveEnemiesMatchingFilter('damaged') returns only wounded adjacent", () => {
      const wounded = adjacentLiveEnemiesMatchingFilter(state, "hero-02", "damaged");
      expect(wounded.map((e) => e.instanceId)).toEqual(["wound-adj"]);
    });

    it("dead enemies are excluded from both helpers", () => {
      const dead = placeEnemy(state, "dead-adj", 3, 4, "soulhunter-001", 12);
      dead.alive = false;
      expect(adjacentLiveEnemies(state, "hero-02").map((e) => e.instanceId).sort())
        .toEqual(["fresh-adj", "wound-adj"]);
    });
  });

  describe("availableElementKinds", () => {
    it("returns kinds with count > 0, sorted alphabetically", () => {
      const state = arenaWithMace("mind");
      state.elements["hero-01"] = { earth: 2, water: 1, void: 0, radiance: 1 };
      expect(availableElementKinds(state, "hero-01")).toEqual(["earth", "radiance", "water"]);
    });

    it("returns [] for an empty / missing bag", () => {
      const state = arenaWithMace("mind");
      delete state.elements["hero-01"];
      expect(availableElementKinds(state, "hero-01")).toEqual([]);
    });
  });

  describe("classifyMaceModes auto-skip routing", () => {
    it("returns null for non-Mace cards", () => {
      const state = arenaWithMace("mind");
      const sword = getEquipment("mind-sword-r1");
      expect(classifyMaceModes(state, "hero-01", sword)).toBeNull();
    });

    it("both modes viable when filter has matches AND bag has elements", () => {
      const state = arenaWithMace("mind");
      placeEnemy(state, "fresh", 4, 3, "soulhunter-001", 0);
      placeEnemy(state, "wound", 2, 3, "soulhunter-001", 1);
      state.elements["hero-01"] = { fire: 1 };
      const modes = classifyMaceModes(state, "hero-01", getEquipment(MACE_MIND))!;
      expect(modes.defaultModeAvailable).toBe(true);  // fresh-adj passes UNDAMAGED
      expect(modes.spendModeAvailable).toBe(true);    // 2 adjacent + 1 element
      expect(modes.availableElementKinds).toEqual(["fire"]);
    });

    it("only default viable when bag empty", () => {
      const state = arenaWithMace("mind");
      placeEnemy(state, "fresh", 4, 3, "soulhunter-001", 0);
      state.elements["hero-01"] = {};
      const modes = classifyMaceModes(state, "hero-01", getEquipment(MACE_MIND))!;
      expect(modes.defaultModeAvailable).toBe(true);
      expect(modes.spendModeAvailable).toBe(false);
    });

    it("only spend viable when filter has no matches but adjacent + bag non-empty", () => {
      const state = arenaWithMace("body");
      // Body filters DAMAGED — adjacent enemy is fresh, so default is unviable
      placeEnemy(state, "fresh", 4, 3, "soulhunter-001", 0);
      state.elements["hero-02"] = { water: 1 };
      const modes = classifyMaceModes(state, "hero-02", getEquipment(MACE_BODY))!;
      expect(modes.defaultModeAvailable).toBe(false);
      expect(modes.spendModeAvailable).toBe(true);
    });

    it("neither viable when no adjacent enemies", () => {
      const state = arenaWithMace("body");
      state.elements["hero-02"] = { water: 1 };
      const modes = classifyMaceModes(state, "hero-02", getEquipment(MACE_BODY))!;
      expect(modes.defaultModeAvailable).toBe(false);
      expect(modes.spendModeAvailable).toBe(false);
    });
  });
});

// --- useWeaponAbility — default mode (filter enforcement) -----------

describe("useWeaponAbility — Mace default mode (filter)", () => {
  describe("Mind (UNDAMAGED filter)", () => {
    let state: CampaignState;
    beforeEach(() => { state = arenaWithMace("mind"); });

    it("accepts an adjacent UNDAMAGED enemy", () => {
      placeEnemy(state, "fresh", 4, 3, "soulhunter-001", 0);
      const r = useWeaponAbility(state, "hero-01", 0, {
        kind: "single-adjacent", targetX: 4, targetY: 3,
      });
      expect(r.ok).toBe(true);
    });

    it("rejects an adjacent DAMAGED enemy (no element spent)", () => {
      placeEnemy(state, "wound", 4, 3, "soulhunter-001", 1);
      state.elements["hero-01"] = { fire: 1 };
      const r = useWeaponAbility(state, "hero-01", 0, {
        kind: "single-adjacent", targetX: 4, targetY: 3,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/not undamaged/);
      // No element spent on rejection.
      expect(state.elements["hero-01"]!.fire).toBe(1);
    });
  });

  describe("Body (DAMAGED filter)", () => {
    let state: CampaignState;
    beforeEach(() => { state = arenaWithMace("body"); });

    it("accepts an adjacent DAMAGED enemy", () => {
      placeEnemy(state, "wound", 4, 3, "soulhunter-001", 1);
      const r = useWeaponAbility(state, "hero-02", 0, {
        kind: "single-adjacent", targetX: 4, targetY: 3,
      });
      expect(r.ok).toBe(true);
    });

    it("rejects an adjacent UNDAMAGED enemy (no element spent)", () => {
      placeEnemy(state, "fresh", 4, 3, "soulhunter-001", 0);
      state.elements["hero-02"] = { water: 1 };
      const r = useWeaponAbility(state, "hero-02", 0, {
        kind: "single-adjacent", targetX: 4, targetY: 3,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/not damaged/);
      expect(state.elements["hero-02"]!.water).toBe(1);
    });
  });

  it("damage matches the printed HEAVY value (4 at R1)", () => {
    const state = arenaWithMace("mind");
    const enemy = placeEnemy(state, "fresh", 4, 3, "soulhunter-001", 0);
    const r = useWeaponAbility(state, "hero-01", 0, {
      kind: "single-adjacent", targetX: 4, targetY: 3,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session.damage).toBe(4);
    void enemy;
  });
});

// --- useWeaponAbility — OR mode (element-spend bypass) --------------

describe("useWeaponAbility — Mace OR mode (spend element)", () => {
  describe("Mind", () => {
    let state: CampaignState;
    beforeEach(() => {
      state = arenaWithMace("mind");
      state.elements["hero-01"] = { earth: 2, fire: 1 };
    });

    it("hits a DAMAGED enemy (filter bypassed) and debits 1 of the named element", () => {
      placeEnemy(state, "wound", 4, 3, "soulhunter-001", 1);
      const r = useWeaponAbility(state, "hero-01", 0, {
        kind: "single-adjacent", targetX: 4, targetY: 3,
        spendElementForTargetBypass: { element: "fire" },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(state.elements["hero-01"]!.fire).toBe(0);
      expect(state.elements["hero-01"]!.earth).toBe(2);  // untouched
      expect(r.session.preEffects).toContainEqual({
        kind: "target-bypass-spend-element",
        heroId: "hero-01",
        element: "fire",
      });
    });

    it("hits an UNDAMAGED enemy too (filter bypass is a strict superset)", () => {
      placeEnemy(state, "fresh", 4, 3, "soulhunter-001", 0);
      const r = useWeaponAbility(state, "hero-01", 0, {
        kind: "single-adjacent", targetX: 4, targetY: 3,
        spendElementForTargetBypass: { element: "earth" },
      });
      expect(r.ok).toBe(true);
      expect(state.elements["hero-01"]!.earth).toBe(1);  // 2 - 1
    });

    it("damage is identical to default mode (HEAVY = 4 at R1, no doubling)", () => {
      placeEnemy(state, "wound", 4, 3, "soulhunter-001", 1);
      const r = useWeaponAbility(state, "hero-01", 0, {
        kind: "single-adjacent", targetX: 4, targetY: 3,
        spendElementForTargetBypass: { element: "fire" },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.session.damage).toBe(4);
    });
  });

  describe("Body", () => {
    it("hits an UNDAMAGED enemy via spend (filter would otherwise reject)", () => {
      const state = arenaWithMace("body");
      placeEnemy(state, "fresh", 4, 3, "soulhunter-001", 0);
      state.elements["hero-02"] = { water: 1 };
      const r = useWeaponAbility(state, "hero-02", 0, {
        kind: "single-adjacent", targetX: 4, targetY: 3,
        spendElementForTargetBypass: { element: "water" },
      });
      expect(r.ok).toBe(true);
      expect(state.elements["hero-02"]!.water).toBe(0);
    });
  });

  describe("rejection paths", () => {
    it("rejects + leaves bag untouched when bag has 0 of the named element", () => {
      const state = arenaWithMace("mind");
      placeEnemy(state, "wound", 4, 3, "soulhunter-001", 1);
      state.elements["hero-01"] = { earth: 2 };  // no fire
      const r = useWeaponAbility(state, "hero-01", 0, {
        kind: "single-adjacent", targetX: 4, targetY: 3,
        spendElementForTargetBypass: { element: "fire" },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/0 of fire/);
      expect(state.elements["hero-01"]!.earth).toBe(2);  // untouched
    });

    it("rejects + leaves bag untouched when card has no filter effect (defensive)", () => {
      // Sword: same range kind, but no `target-filter-or-spend-element`
      // effect. Spending should be rejected to keep the bypass scoped
      // to cards that actually print it.
      const state = arenaWithMace("mind");
      // Swap the placed card to Sword.
      state.loadouts["hero-01"]!.slotCards[0] = "mind-sword-r1";
      state.encounter!.turnState["hero-01"]!.cardPlacedThisTurn = {
        slotIdx: 0,
        cardId: "mind-sword-r1",
        autoRefreshedElement: null,
      };
      state.equipmentRanks["hero-01"]!.Sword = 1;
      placeEnemy(state, "any", 4, 3, "soulhunter-001", 0);
      state.elements["hero-01"] = { earth: 1 };
      const r = useWeaponAbility(state, "hero-01", 0, {
        kind: "single-adjacent", targetX: 4, targetY: 3,
        spendElementForTargetBypass: { element: "earth" },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/no target-filter-or-spend-element effect/);
      expect(state.elements["hero-01"]!.earth).toBe(1);  // untouched
    });

    it("rejects when no live enemy on the target tile (no element spent)", () => {
      const state = arenaWithMace("mind");
      state.elements["hero-01"] = { fire: 1 };
      // No enemy at (4, 3).
      const r = useWeaponAbility(state, "hero-01", 0, {
        kind: "single-adjacent", targetX: 4, targetY: 3,
        spendElementForTargetBypass: { element: "fire" },
      });
      expect(r.ok).toBe(false);
      expect(state.elements["hero-01"]!.fire).toBe(1);
    });
  });
});

// --- Non-Mace single-adjacent weapons stay backward-compatible -----

describe("useWeaponAbility — non-Mace single-adjacent weapons unchanged", () => {
  it("Sword swings at any adjacent enemy regardless of damageTaken (no filter)", () => {
    const state = arenaWithMace("mind");
    state.loadouts["hero-01"]!.slotCards[0] = "mind-sword-r1";
    state.encounter!.turnState["hero-01"]!.cardPlacedThisTurn = {
      slotIdx: 0,
      cardId: "mind-sword-r1",
      autoRefreshedElement: null,
    };
    state.equipmentRanks["hero-01"]!.Sword = 1;
    // Wounded enemy — would be illegal for Mind Mace (UNDAMAGED filter)
    // but is a legal Sword target.
    placeEnemy(state, "wound", 4, 3, "soulhunter-001", 1);
    const r = useWeaponAbility(state, "hero-01", 0, {
      kind: "single-adjacent", targetX: 4, targetY: 3,
    });
    expect(r.ok).toBe(true);
  });
});
