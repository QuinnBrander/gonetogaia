/**
 * Tests for src/engine/slotAbilities.ts.
 *
 * Covers DESIGN.md §5.8 — one happy path + one rejection path per
 * `SlotAbility.kind` actively wired in Quest 1. Slot ↔ ability
 * mapping per the Mind/Body tables in §5.8.1:
 *
 *   Mind: 0=radiance(damage-light), 1=void(gain earth), 2=earth(+1 mov),
 *         3=fire(+1 ap), 4=wind(gain fire), 5=water(gain radiance)
 *   Body: 0=radiance(gain void), 1=void(damage-medium selfSuffer 1),
 *         2=earth(gain wind), 3=fire(gain water), 4=wind(+1 mov),
 *         5=water(+1 ap)
 *
 * `gain-token` (creature-part / boss-part) stays in the SlotAbility
 * union for future cards but no Quest 1 slot wires it today, so it
 * has no slot-grounded happy path here. (Engine plumbing still
 * exists in `engine/slotAbilities.ts > applyGainToken`.)
 *
 * Gating (turnState / preparedToRun / etc.) is `useSlotAbility`'s
 * responsibility and is exercised in `turn.test.ts`.
 */

import { describe, it, expect } from "vitest";

import { newCampaign, type CampaignState, type EnemyInstance } from "../state";
import { QUEST1 } from "../data";
import { ensureEncounter } from "../engine/encounter";
import { resolveSlotAbility } from "../engine/slotAbilities";
import { resolveAllDamage, resolveSharedCounter, finalizeAttackSession } from "../engine/combat";

function freshState(): CampaignState {
  const state = newCampaign();
  ensureEncounter(state, QUEST1);
  state.encounter!.enemies = [];
  return state;
}

function spawnCrystanid(state: CampaignState, x: number, y: number): EnemyInstance {
  const e: EnemyInstance = {
    instanceId: `c-${x}-${y}`,
    cardId: "crystanid-001",
    x, y,
    damageTaken: 0,
    alive: true,
    facing: 0,
  };
  state.encounter!.enemies.push(e);
  return e;
}

// --- damage-any-enemy ---------------------------------------------------

describe("resolveSlotAbility — damage-any-enemy (Mind radiance)", () => {
  it("returns a session targeting the chosen enemy with light damage (1)", () => {
    const state = freshState();
    spawnCrystanid(state, 4, 4);
    const r = resolveSlotAbility(state, "hero-01", 0, {
      kind: "damage-any-enemy", targetX: 4, targetY: 4,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.kind).toBe("damage-session");
    if (r.result.kind !== "damage-session") return;
    expect(r.result.session.damage).toBe(1);
    expect(r.result.session.hitTiles).toEqual([{ x: 4, y: 4 }]);
    expect(r.result.session.preEffects).toEqual([]); // no selfSuffer on Mind radiance
  });

  it("rejects when no live enemy on the target tile", () => {
    const state = freshState();
    const r = resolveSlotAbility(state, "hero-01", 0, {
      kind: "damage-any-enemy", targetX: 4, targetY: 4,
    });
    expect(r.ok).toBe(false);
  });

  it("Body void: applies selfSuffer BEFORE damage and records preEffect", () => {
    const state = freshState();
    spawnCrystanid(state, 0, 0);
    const startHp = state.loadouts["hero-02"]!.currentHp;
    const r = resolveSlotAbility(state, "hero-02", 1, {
      kind: "damage-any-enemy", targetX: 0, targetY: 0,
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.result.kind !== "damage-session") return;
    // Self-suffer applied immediately to attacker.
    expect(state.loadouts["hero-02"]!.currentHp).toBe(startHp - 1);
    expect(r.result.session.preEffects).toEqual([
      { kind: "self-suffer", heroId: "hero-02", amount: 1 },
    ]);
    // Damage value is MEDIUM = 2 (per Tuning.damageBase / suit board).
    expect(r.result.session.damage).toBe(2);
  });
});

// --- bonus-movement-this-turn ------------------------------------------

describe("resolveSlotAbility — bonus-movement-this-turn", () => {
  it("Mind earth: +1 currentMovement (above baseMovement is OK for this turn)", () => {
    const state = freshState();
    const start = state.loadouts["hero-01"]!.currentMovement;
    const r = resolveSlotAbility(state, "hero-01", 2, { kind: "bonus-movement-this-turn" });
    expect(r.ok).toBe(true);
    if (!r.ok || r.result.kind !== "applied") return;
    expect(state.loadouts["hero-01"]!.currentMovement).toBe(start + 1);
    expect(r.result.log.detail.kind).toBe("bonus-movement-this-turn");
  });

  it("Mind earth: with apMovementDoubledThisTurn → +2 instead of +1 (DESIGN.md §5.5.1)", () => {
    const state = freshState();
    state.encounter!.turnState["hero-01"]!.apMovementDoubledThisTurn = true;
    const start = state.loadouts["hero-01"]!.currentMovement;
    const r = resolveSlotAbility(state, "hero-01", 2, { kind: "bonus-movement-this-turn" });
    expect(r.ok).toBe(true);
    if (!r.ok || r.result.kind !== "applied") return;
    expect(state.loadouts["hero-01"]!.currentMovement).toBe(start + 2);
    expect(r.result.log.summary).toMatch(/doubled by AP/i);
  });

  // `actionGrantedExtraMovement` is display only (the movement badge's
  // total). It is set only when the delver hasn't moved yet, because
  // movement is one continuous move (designer ruling 2026-11-17).
  it("Mind earth: sets the display flag when the delver hasn't moved yet", () => {
    const state = freshState();
    expect(state.encounter!.turnState["hero-01"]!.actionGrantedExtraMovement).toBe(false);
    const r = resolveSlotAbility(state, "hero-01", 2, { kind: "bonus-movement-this-turn" });
    expect(r.ok).toBe(true);
    expect(state.encounter!.turnState["hero-01"]!.actionGrantedExtraMovement).toBe(true);
  });

  // No carve-out (designer ruling 2026-11-17): a delver whose movement
  // already ended doesn't get it back from this ability.
  it("Mind earth: does NOT re-open movement that already ended", () => {
    const state = freshState();
    const ts = state.encounter!.turnState["hero-01"]!;
    ts.movementUsedThisTurn = true;
    ts.movementStepsThisTurn = 1;
    const r = resolveSlotAbility(state, "hero-01", 2, { kind: "bonus-movement-this-turn" });
    expect(r.ok).toBe(true);
    expect(ts.movementUsedThisTurn).toBe(true);
    expect(ts.actionGrantedExtraMovement).toBe(false);
  });

  // Body wind slot is the symmetric +1 mov slot for the other delver.
  it("Body wind: +1 currentMovement and sets the display flag (symmetric to Mind earth)", () => {
    const state = freshState();
    const start = state.loadouts["hero-02"]!.currentMovement;
    const r = resolveSlotAbility(state, "hero-02", 4, { kind: "bonus-movement-this-turn" });
    expect(r.ok).toBe(true);
    expect(state.loadouts["hero-02"]!.currentMovement).toBe(start + 1);
    expect(state.encounter!.turnState["hero-02"]!.actionGrantedExtraMovement).toBe(true);
  });
});

// --- refresh-ap --------------------------------------------------------

describe("resolveSlotAbility — refresh-ap", () => {
  it("Mind fire: +1 currentAp, capped at baseAp", () => {
    const state = freshState();
    const lo = state.loadouts["hero-01"]!;
    lo.currentAp = lo.baseAp - 1;
    const r = resolveSlotAbility(state, "hero-01", 3, { kind: "refresh-ap" });
    expect(r.ok).toBe(true);
    expect(state.loadouts["hero-01"]!.currentAp).toBe(lo.baseAp);
  });

  it("Body water: refresh is a no-op when already at baseAp", () => {
    const state = freshState();
    const lo = state.loadouts["hero-02"]!;
    lo.currentAp = lo.baseAp;
    const r = resolveSlotAbility(state, "hero-02", 5, { kind: "refresh-ap" });
    expect(r.ok).toBe(true);
    expect(state.loadouts["hero-02"]!.currentAp).toBe(lo.baseAp);
    if (r.ok && r.result.kind === "applied" && r.result.log.detail.kind === "refresh-ap") {
      expect(r.result.log.detail.amount).toBe(0);
    }
  });
});

// --- gain-element ------------------------------------------------------

describe("resolveSlotAbility — gain-element", () => {
  it("Mind void: +1 earth element to chosen recipient", () => {
    const state = freshState();
    const r = resolveSlotAbility(state, "hero-01", 1, {
      kind: "gain-element", recipientHeroId: "hero-02",
    });
    expect(r.ok).toBe(true);
    expect(state.elements["hero-02"]?.earth).toBe(1);
    expect(state.elements["hero-01"]?.earth).toBeUndefined();
  });

  it("Body radiance: +1 void element to chosen recipient (data fix 2026-05-09)", () => {
    // Card art shows a VOID swirl in the slot's OR panel — the
    // earlier delverBoards.json wired this slot to a creature-part
    // grant by mistake. Both directions of the recipient choice
    // are exercised so a future regression that re-routes the
    // grant to the wrong delver fails fast.
    const state = freshState();
    const r1 = resolveSlotAbility(state, "hero-02", 0, {
      kind: "gain-element", recipientHeroId: "hero-02",
    });
    expect(r1.ok).toBe(true);
    expect(state.elements["hero-02"]?.void).toBe(1);
    expect(state.elements["hero-01"]?.void).toBeUndefined();
    // Re-route to the OTHER delver — recipient is the player's
    // choice, not always self.
    const r2 = resolveSlotAbility(state, "hero-02", 0, {
      kind: "gain-element", recipientHeroId: "hero-01",
    });
    expect(r2.ok).toBe(true);
    expect(state.elements["hero-01"]?.void).toBe(1);
  });

  it("Mind wind: +1 fire element to chosen recipient", () => {
    const state = freshState();
    const r = resolveSlotAbility(state, "hero-01", 4, {
      kind: "gain-element", recipientHeroId: "hero-01",
    });
    expect(r.ok).toBe(true);
    expect(state.elements["hero-01"]?.fire).toBe(1);
  });

  it("stacks with previous gains", () => {
    const state = freshState();
    resolveSlotAbility(state, "hero-01", 4, { kind: "gain-element", recipientHeroId: "hero-02" });
    resolveSlotAbility(state, "hero-01", 4, { kind: "gain-element", recipientHeroId: "hero-02" });
    expect(state.elements["hero-02"]?.fire).toBe(2);
  });

  it("Body earth: +1 wind element", () => {
    const state = freshState();
    const r = resolveSlotAbility(state, "hero-02", 2, {
      kind: "gain-element", recipientHeroId: "hero-02",
    });
    expect(r.ok).toBe(true);
    expect(state.elements["hero-02"]?.wind).toBe(1);
  });

  it("rejects unknown recipientHeroId (validated by gain-element handler)", () => {
    const state = freshState();
    const r = resolveSlotAbility(state, "hero-02", 0, {
      kind: "gain-element", recipientHeroId: "hero-ZZ",
    });
    expect(r.ok).toBe(false);
  });
});

// --- Validation rejections --------------------------------------------

describe("resolveSlotAbility — validation rejections", () => {
  it("rejects when params.kind doesn't match the printed slot kind", () => {
    const state = freshState();
    // Mind slot 2 is bonus-movement, not refresh-ap.
    const r = resolveSlotAbility(state, "hero-01", 2, { kind: "refresh-ap" });
    expect(r.ok).toBe(false);
  });

  it("rejects out-of-range slotIdx", () => {
    const state = freshState();
    const r = resolveSlotAbility(state, "hero-01", 99, {
      kind: "bonus-movement-this-turn",
    });
    expect(r.ok).toBe(false);
  });
});

// --- Integration with the AttackSession path --------------------------

describe("damage-any-enemy ↔ AttackSession", () => {
  it("the returned session can be damage-resolved + counter-resolved + finalized to apply the damage", () => {
    const state = freshState();
    const enemy = spawnCrystanid(state, 4, 4);
    state.encounter!.delverPositions["hero-01"] = { x: 0, y: 0 };
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };

    const r = resolveSlotAbility(state, "hero-01", 0, {
      kind: "damage-any-enemy", targetX: 4, targetY: 4,
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.result.kind !== "damage-session") return;
    const session = r.result.session;

    const phase = resolveAllDamage(state, session);
    expect(session.steps).toHaveLength(1);
    expect(session.steps[0]!.damageApplied).toBe(1);
    expect(enemy.damageTaken).toBe(1);
    expect(enemy.alive).toBe(true); // 1/2 HP
    // Hero-01 is far away so no counter pattern can land — auto-skip.
    expect(phase.anyCanLand).toBe(false);

    resolveSharedCounter(state, session, -1); // skipped
    finalizeAttackSession(state, session);
  });
});
