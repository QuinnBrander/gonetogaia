/**
 * Tests for src/engine/turn.ts.
 *
 * Covers DESIGN.md §4.1 (per-turn refresh) and the active-delver swap.
 *
 * Notably we ASSERT that the previous delver's resources are NOT reset by
 * `endHeroTurn` — only the new active delver gets refreshed. (Their old
 * unspent movement stays on their loadout but is irrelevant until their
 * next turn comes around again, when they too will be refreshed.)
 *
 * AP unification (2026-05-09): `currentAp` is NO LONGER refreshed
 * per-turn. The unified AP pool refills only at Interlude
 * (`engine/wave.ts > runInterlude`); see `runInterlude` tests for
 * the per-Wave assertion. `startHeroTurn` only resets movement +
 * the per-turn flags now.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { newCampaign, type CampaignState } from "../state";
import { QUEST1 } from "../data";
import { ensureEncounter } from "../engine/encounter";
import {
  flipActiveDelver,
  startHeroTurn,
  endHeroTurn,
  applyDeferredAutoRefreshes,
  playWeaponCard,
  prepareToRun,
  spendApDoubleMovement,
  spendApRefreshWeapon,
  spendApRefreshAllWeapons,
  undoWeaponPlacement,
  useWeaponAbility,
  useSlotAbility,
} from "../engine/turn";
import { legalStepDestinations, moveDelverStep } from "../engine/movement";

let state: CampaignState;
beforeEach(() => {
  state = newCampaign();
  // Tighten the test invariants by spending the active delver's resources
  // down to 0 so a "did we refresh?" assertion is unambiguous.
  state.loadouts["hero-01"]!.currentMovement = 0;
  state.loadouts["hero-01"]!.currentAp = 0;
  state.loadouts["hero-02"]!.currentMovement = 0;
  state.loadouts["hero-02"]!.currentAp = 0;
});

describe("flipActiveDelver", () => {
  it("swaps hero-01 -> hero-02", () => {
    state.currentDelverId = "hero-01";
    flipActiveDelver(state);
    expect(state.currentDelverId).toBe("hero-02");
  });

  it("swaps hero-02 -> hero-01", () => {
    state.currentDelverId = "hero-02";
    flipActiveDelver(state);
    expect(state.currentDelverId).toBe("hero-01");
  });

  it("does not refresh resources by itself", () => {
    state.currentDelverId = "hero-01";
    flipActiveDelver(state);
    expect(state.loadouts["hero-02"]!.currentMovement).toBe(0);
    expect(state.loadouts["hero-02"]!.currentAp).toBe(0);
  });
});

describe("startHeroTurn", () => {
  it("refreshes the ACTIVE delver's movement to base value (AP is per-Wave, not per-turn)", () => {
    state.currentDelverId = "hero-01";
    const h1 = state.loadouts["hero-01"]!;
    h1.currentAp = 0; // pre-condition: AP burned down from a prior turn
    startHeroTurn(state);

    expect(h1.currentMovement).toBe(h1.baseMovement);
    // AP unification: currentAp is NOT touched by startHeroTurn. The
    // pool carries across turns and only refills at Interlude.
    expect(h1.currentAp).toBe(0);
  });

  it("does NOT refresh the other delver's resources", () => {
    state.currentDelverId = "hero-01";
    startHeroTurn(state);
    expect(state.loadouts["hero-02"]!.currentMovement).toBe(0);
    expect(state.loadouts["hero-02"]!.currentAp).toBe(0);
  });

  it("refreshes only after a flip when the active delver changes", () => {
    state.currentDelverId = "hero-02";
    startHeroTurn(state);
    expect(state.loadouts["hero-02"]!.currentMovement).toBe(
      state.loadouts["hero-02"]!.baseMovement,
    );
    expect(state.loadouts["hero-01"]!.currentMovement).toBe(0);
  });
});

describe("endHeroTurn", () => {
  it("flips the active delver AND refreshes the new delver's MOVEMENT (AP untouched)", () => {
    state.currentDelverId = "hero-01";
    state.loadouts["hero-02"]!.currentAp = 0;
    endHeroTurn(state);

    expect(state.currentDelverId).toBe("hero-02");
    const h2 = state.loadouts["hero-02"]!;
    expect(h2.currentMovement).toBe(h2.baseMovement);
    // AP is per-Wave now — endHeroTurn must NOT refill AP.
    expect(h2.currentAp).toBe(0);
  });

  it("does NOT touch the now-inactive delver's resources", () => {
    state.currentDelverId = "hero-01";
    state.loadouts["hero-01"]!.currentMovement = 0;
    state.loadouts["hero-01"]!.currentAp = 0;

    endHeroTurn(state);

    // Old delver's resources stay where they were until their next turn.
    expect(state.loadouts["hero-01"]!.currentMovement).toBe(0);
    expect(state.loadouts["hero-01"]!.currentAp).toBe(0);
  });

  it("two consecutive endHeroTurn calls return us to the original delver, MOVEMENT-refreshed", () => {
    state.currentDelverId = "hero-01";
    endHeroTurn(state); // -> hero-02 active, movement refreshed
    endHeroTurn(state); // -> hero-01 active, movement refreshed

    const h1 = state.loadouts["hero-01"]!;
    expect(state.currentDelverId).toBe("hero-01");
    expect(h1.currentMovement).toBe(h1.baseMovement);
    // currentAp deliberately unchecked here — the pre-test setup zeroed
    // it; AP is now per-Wave, so it stays at 0 across the turn flips.
    expect(h1.currentAp).toBe(0);
  });
});

// --- Slice 4b.2: per-turn turnState reset ---------------------------------

describe("startHeroTurn (with encounter) — turnState reset", () => {
  it("clears the active delver's turnState (placement, action, movement flags)", () => {
    state.currentDelverId = "hero-01";
    ensureEncounter(state, QUEST1);
    // Pretend the previous turn placed a card and used everything.
    state.encounter!.turnState["hero-01"] = {
      cardPlacedThisTurn: { slotIdx: 0, cardId: "mind-hammer-r1", autoRefreshedElement: null },
      actionUsedThisTurn: true,
      movementUsedThisTurn: true,
      movementStepsThisTurn: 4,
      apMovementDoubledThisTurn: true,
      actionGrantedExtraMovement: true,
      damage2xUsedThisTurn: true,
      doubleDamageActive: {},
      witnessStepsThisTurn: 2,
      movementSnapshot: {
        startPosition: { x: 0, y: 0 },
        startMovement: 2,
        startMinionParts: 0,
        startBossParts: 0,
        claimedDrops: [],
      },
    };

    startHeroTurn(state);

    expect(state.encounter!.turnState["hero-01"]).toEqual({
      cardPlacedThisTurn: null,
      actionUsedThisTurn: false,
      movementUsedThisTurn: false,
      movementStepsThisTurn: 0,
      apMovementDoubledThisTurn: false,
      actionGrantedExtraMovement: false,
      damage2xUsedThisTurn: false,
      // Per-type Double Damage latch — empty at turn start.
      doubleDamageActive: {},
      witnessStepsThisTurn: 0,
      movementSnapshot: null,
    });
  });

  it("does NOT reset the other delver's turnState", () => {
    state.currentDelverId = "hero-01";
    ensureEncounter(state, QUEST1);
    state.encounter!.turnState["hero-02"] = {
      cardPlacedThisTurn: { slotIdx: 1, cardId: "body-sword-r1", autoRefreshedElement: null },
      actionUsedThisTurn: true,
      movementUsedThisTurn: true,
      movementStepsThisTurn: 2,
      apMovementDoubledThisTurn: false,
      actionGrantedExtraMovement: false,
      damage2xUsedThisTurn: false,
      doubleDamageActive: {},
      witnessStepsThisTurn: 1,
      movementSnapshot: null,
    };

    startHeroTurn(state); // hero-01 is active

    expect(state.encounter!.turnState["hero-02"]).toEqual({
      cardPlacedThisTurn: { slotIdx: 1, cardId: "body-sword-r1", autoRefreshedElement: null },
      actionUsedThisTurn: true,
      movementUsedThisTurn: true,
      movementStepsThisTurn: 2,
      apMovementDoubledThisTurn: false,
      actionGrantedExtraMovement: false,
      damage2xUsedThisTurn: false,
      doubleDamageActive: {},
      witnessStepsThisTurn: 1,
      movementSnapshot: null,
    });
  });
});

// --- DESIGN.md §5.7: auto-prepare-to-run on empty hand -------------------

describe("startHeroTurn — auto Prepare to Run when hand is empty", () => {
  it("does NOT auto-prepare on a fresh campaign (hand has 3 weapons)", () => {
    state.currentDelverId = "hero-01";
    ensureEncounter(state, QUEST1);

    startHeroTurn(state);

    expect(state.encounter!.preparedToRun["hero-01"]).toBe(false);
  });

  it("auto-prepares when every starting weapon is already in a slot", () => {
    state.currentDelverId = "hero-01";
    ensureEncounter(state, QUEST1);
    // Manually exhaust all 3 of Mind's weapon cards into slots 0..2.
    const lo = state.loadouts["hero-01"]!;
    lo.slotCards[0] = "mind-hammer-r1";
    lo.slotCards[1] = "mind-shield-r1";
    lo.slotCards[2] = "mind-beam-r1";

    startHeroTurn(state);

    expect(state.encounter!.preparedToRun["hero-01"]).toBe(true);
  });

  it("does NOT auto-prepare when at least one weapon is still in hand", () => {
    state.currentDelverId = "hero-01";
    ensureEncounter(state, QUEST1);
    const lo = state.loadouts["hero-01"]!;
    lo.slotCards[0] = "mind-hammer-r1";
    lo.slotCards[1] = "mind-shield-r1";
    // mind-beam-r1 still in hand.

    startHeroTurn(state);

    expect(state.encounter!.preparedToRun["hero-01"]).toBe(false);
  });

  it("only checks the active delver, not the other one", () => {
    state.currentDelverId = "hero-01";
    ensureEncounter(state, QUEST1);
    // Exhaust hero-02's BOTH starting weapons (gauntlet + sword);
    // armor is a passive and doesn't count.
    const lo2 = state.loadouts["hero-02"]!;
    lo2.slotCards[0] = "body-gauntlet-r1";
    lo2.slotCards[1] = "body-sword-r1";

    startHeroTurn(state); // hero-01 is active

    expect(state.encounter!.preparedToRun["hero-01"]).toBe(false);
    expect(state.encounter!.preparedToRun["hero-02"]).toBe(false); // not yet checked
  });

  it("Body delver auto-prepares once both weapon cards are exhausted (passive armor doesn't count)", () => {
    state.currentDelverId = "hero-02";
    ensureEncounter(state, QUEST1);
    const lo = state.loadouts["hero-02"]!;
    lo.slotCards[0] = "body-gauntlet-r1";
    lo.slotCards[1] = "body-sword-r1";

    startHeroTurn(state);

    expect(state.encounter!.preparedToRun["hero-02"]).toBe(true);
  });

  it("is idempotent — an already-prepared delver with NO playable weapons stays prepared", () => {
    state.currentDelverId = "hero-01";
    ensureEncounter(state, QUEST1);
    state.encounter!.preparedToRun["hero-01"] = true;
    // Exhaust ALL playable weapons so the latch is genuinely correct.
    const lo = state.loadouts["hero-01"]!;
    lo.slotCards[0] = "mind-hammer-r1";
    lo.slotCards[1] = "mind-shield-r1";
    lo.slotCards[2] = "mind-beam-r1";

    startHeroTurn(state);

    expect(state.encounter!.preparedToRun["hero-01"]).toBe(true);
  });

  // Regression for the 2026-05-09 user repro: with Hammer + Beam
  // (starting) placed and Mace (level-up acquired) still in hand,
  // `hasPlayableWeaponInHand` was reading `getStartingEquipment` only
  // and falsely returning false, so `startHeroTurn` auto-latched
  // `preparedToRun`. Subsequent `playWeaponCard` calls then rejected
  // silently (`prepared to run`), and tapping any empty slot was a
  // no-op. The fix widens `hasPlayableWeaponInHand` to walk
  // `state.equipmentRanks[heroId]` (mirrors `playWeaponCard` and
  // HandPanel) and adds a self-healing clear of stale latches.
  it("does NOT auto-prepare when a level-up acquired weapon (Mace) is still in hand", () => {
    state.currentDelverId = "hero-01";
    ensureEncounter(state, QUEST1);
    // Player gained Mace via level-up earlier this quest.
    state.equipmentRanks["hero-01"]!.Mace = 1;
    // All starting weapons are exhausted (Hammer + Beam — Shield is
    // a passive and never enters the hand as a playable card).
    const lo = state.loadouts["hero-01"]!;
    lo.slotCards[0] = "mind-hammer-r1";
    lo.slotCards[1] = "mind-beam-r1";
    // Mace is NOT placed, so it's still in hand.

    startHeroTurn(state);

    expect(state.encounter!.preparedToRun["hero-01"]).toBe(false);
  });

  // Self-healing path for in-progress saves stuck in the bad state.
  // A delver flagged `preparedToRun = true` BUT with at least one
  // playable weapon still in hand is an impossible state under the
  // corrected logic — only the pre-2026-05-09 buggy auto-latch could
  // produce it. `startHeroTurn` clears the latch so the player can
  // resume play from the broken save.
  it("self-heals a stale preparedToRun latch when a level-up weapon is still in hand", () => {
    state.currentDelverId = "hero-01";
    ensureEncounter(state, QUEST1);
    state.equipmentRanks["hero-01"]!.Mace = 1;
    const lo = state.loadouts["hero-01"]!;
    lo.slotCards[0] = "mind-hammer-r1";
    lo.slotCards[1] = "mind-beam-r1";
    // Simulate the in-progress save state from the user's repro:
    // latch was incorrectly set on a prior turn before the fix.
    state.encounter!.preparedToRun["hero-01"] = true;

    startHeroTurn(state);

    expect(state.encounter!.preparedToRun["hero-01"]).toBe(false);
  });
});

// --- Slice 4b.2: playWeaponCard (mandatory turn-start placement) ---------

describe("playWeaponCard", () => {
  beforeEach(() => {
    state.currentDelverId = "hero-01";
    ensureEncounter(state, QUEST1);
    startHeroTurn(state); // fresh turnState for hero-01
  });

  it("places the card in the slot and latches cardPlacedThisTurn", () => {
    const r = playWeaponCard(state, "hero-01", 0, "mind-hammer-r1");

    expect(r.ok).toBe(true);
    expect(state.loadouts["hero-01"]!.slotCards[0]).toBe("mind-hammer-r1");
    expect(state.encounter!.turnState["hero-01"]!.cardPlacedThisTurn).toEqual({
      slotIdx: 0,
      cardId: "mind-hammer-r1",
      autoRefreshedElement: null,
    });
  });

  it("rejects a second placement on the same turn (irreversible)", () => {
    playWeaponCard(state, "hero-01", 0, "mind-hammer-r1");
    const r = playWeaponCard(state, "hero-01", 1, "mind-beam-r1");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/already placed/i);
    // First placement still in place; second card not added anywhere.
    expect(state.loadouts["hero-01"]!.slotCards[1]).toBeNull();
  });

  it("rejects placing into an occupied slot", () => {
    state.loadouts["hero-01"]!.slotCards[0] = "mind-beam-r1";

    const r = playWeaponCard(state, "hero-01", 0, "mind-hammer-r1");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/occupied/i);
    expect(state.loadouts["hero-01"]!.slotCards[0]).toBe("mind-beam-r1");
  });

  it("rejects when the caller is not the active delver", () => {
    const r = playWeaponCard(state, "hero-02", 0, "body-gauntlet-r1");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/active delver/i);
  });

  it("rejects when the delver has prepared to run", () => {
    state.encounter!.preparedToRun["hero-01"] = true;

    const r = playWeaponCard(state, "hero-01", 0, "mind-hammer-r1");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/prepared to run/i);
  });

  it("rejects a passive card (only weapons can be played as a turn action)", () => {
    const r = playWeaponCard(state, "hero-01", 0, "mind-shield-r1");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/not a weapon/i);
    expect(state.loadouts["hero-01"]!.slotCards[0]).toBeNull();
  });

  it("rejects a wrong-suit card (not in hero's hand)", () => {
    // body-sword-r1 is the Body suit; hero-01 is Mind.
    const r = playWeaponCard(state, "hero-01", 0, "body-sword-r1");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/not in hero's hand/i);
  });

  it("rejects a same-suit but UNOWNED weapon (rank 0)", () => {
    // mind-trident-r1 is the right suit for hero-01 but they don't
    // own it (Trident isn't in the printed starting hand and we
    // didn't level it up in this fixture).
    expect(state.equipmentRanks["hero-01"]!.Trident ?? 0).toBe(0);
    const r = playWeaponCard(state, "hero-01", 0, "mind-trident-r1");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/not in hero's hand/i);
  });

  // Regression for the 2026-05-04 silent-no-op bug: HandPanel renders
  // any card with `equipmentRanks[type] >= 1` as a clickable hand
  // card, but the placement validator was checking the (narrower)
  // printed starting equipment list and silently rejecting every
  // level-up acquired weapon (Trident, Mace, Shockwave, …). The fix
  // widens the validator to use the same `equipmentRanks` ownership
  // check HandPanel uses. This test pins the new behaviour: a
  // level-up acquired Trident MUST be playable into a slot.
  it("ACCEPTS a level-up acquired weapon (Trident), regression for the silent-no-op bug", () => {
    state.equipmentRanks["hero-01"]!.Trident = 1;

    const r = playWeaponCard(state, "hero-01", 0, "mind-trident-r1");

    expect(r.ok).toBe(true);
    expect(state.loadouts["hero-01"]!.slotCards[0]).toBe("mind-trident-r1");
    expect(state.encounter!.turnState["hero-01"]!.cardPlacedThisTurn).toEqual({
      slotIdx: 0,
      cardId: "mind-trident-r1",
      autoRefreshedElement: null,
    });
  });

  it("ACCEPTS every level-up acquired weapon family (Mace, Shockwave) for the suit hero", () => {
    // Mace (Mind variant).
    state.equipmentRanks["hero-01"]!.Mace = 1;
    const rMace = playWeaponCard(state, "hero-01", 0, "mind-mace-r1");
    expect(rMace.ok).toBe(true);
    expect(state.loadouts["hero-01"]!.slotCards[0]).toBe("mind-mace-r1");

    // Reset for the next placement (the action gate rejects a 2nd
    // placement on the same turn, which is correct — we just want
    // to exercise the per-card hand check).
    state.encounter!.turnState["hero-01"]!.cardPlacedThisTurn = null;
    state.loadouts["hero-01"]!.slotCards[0] = null;

    // Shockwave (Mind variant).
    state.equipmentRanks["hero-01"]!.Shockwave = 1;
    const rShock = playWeaponCard(state, "hero-01", 0, "mind-shockwave-r1");
    expect(rShock.ok).toBe(true);
    expect(state.loadouts["hero-01"]!.slotCards[0]).toBe("mind-shockwave-r1");
  });
});

// --- Auto-refresh on placement (DESIGN.md §4.3, rulebook p17) -----------
//
// When the slot already has 2 of its printed element stacked above it,
// placing a weapon there immediately refreshes the weapon (back to
// hand) and spends both element tokens. The placement still satisfies
// the mandatory turn-start step: `cardPlacedThisTurn` stays set so the
// player can still take their action this turn.
//
// Mind suit slot 2 = earth (per data/delverBoards.json).

describe("playWeaponCard \u2014 auto-refresh on placement", () => {
  beforeEach(() => {
    state.currentDelverId = "hero-01";
    ensureEncounter(state, QUEST1);
    startHeroTurn(state);
  });

  it("with 2 earth elements above the earth slot \u2192 elements consumed + refresh queued; card stays placed until end of turn", () => {
    state.elements["hero-01"] = { earth: 2 };
    const r = playWeaponCard(state, "hero-01", 2, "mind-hammer-r1");

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.autoRefresh).toEqual({
      slotIdx: 2, element: "earth", cardId: "mind-hammer-r1",
    });
    // 2026-05-21: with deferred auto-refresh, the card STAYS in the
    // slot for the rest of the turn (so the slot doesn't look
    // mysteriously empty + so the UI can paint a "WILL AUTO REFRESH"
    // banner). Both earth tokens are still spent immediately.
    expect(state.loadouts["hero-01"]!.slotCards[2]).toBe("mind-hammer-r1");
    expect(state.elements["hero-01"]!.earth).toBe(0);
    // Mandatory placement is satisfied AND records the refunded element
    // so undo can restore the 2 tokens (and `endHeroTurn` can clear
    // the slot when the deferred refresh fires).
    expect(state.encounter!.turnState["hero-01"]!.cardPlacedThisTurn).toEqual({
      slotIdx: 2, cardId: "mind-hammer-r1", autoRefreshedElement: "earth",
    });
  });

  it("queued auto-refresh fires at end of turn -- card clears from slot once endHeroTurn runs", () => {
    state.elements["hero-01"] = { earth: 2 };
    playWeaponCard(state, "hero-01", 2, "mind-hammer-r1");
    expect(state.loadouts["hero-01"]!.slotCards[2]).toBe("mind-hammer-r1");

    endHeroTurn(state);

    // Active delver flipped, so the previous hero's loadout is now
    // the "other" delver's. Their slot is empty (card returned to
    // hand) and the elements stay spent (the spend wasn't reverted).
    expect(state.loadouts["hero-01"]!.slotCards[2]).toBeNull();
    expect(state.elements["hero-01"]!.earth).toBe(0);
  });

  it("queued auto-refresh is idempotent -- a second applyDeferredAutoRefreshes is a no-op", () => {
    state.elements["hero-01"] = { earth: 2 };
    playWeaponCard(state, "hero-01", 2, "mind-hammer-r1");

    applyDeferredAutoRefreshes(state);
    expect(state.loadouts["hero-01"]!.slotCards[2]).toBeNull();

    // Re-running shouldn't crash or further mutate -- the slot is
    // already clear and the latch's `autoRefreshedElement` is the
    // only signal we look at (we don't re-spend tokens).
    applyDeferredAutoRefreshes(state);
    expect(state.loadouts["hero-01"]!.slotCards[2]).toBeNull();
    expect(state.elements["hero-01"]!.earth).toBe(0);
  });

  it("with 1 earth element above the earth slot \u2192 NO auto-refresh (cap not met)", () => {
    state.elements["hero-01"] = { earth: 1 };
    const r = playWeaponCard(state, "hero-01", 2, "mind-hammer-r1");

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.autoRefresh).toBeUndefined();
    // Card stays in slot, element untouched, latch records normal placement.
    expect(state.loadouts["hero-01"]!.slotCards[2]).toBe("mind-hammer-r1");
    expect(state.elements["hero-01"]!.earth).toBe(1);
    expect(state.encounter!.turnState["hero-01"]!.cardPlacedThisTurn).toEqual({
      slotIdx: 2, cardId: "mind-hammer-r1", autoRefreshedElement: null,
    });
  });

  it("with 2 earth elements but placing into a NON-earth slot \u2192 NO auto-refresh", () => {
    // Mind slot 0 = radiance — 2 earth elements should not trigger.
    state.elements["hero-01"] = { earth: 2 };
    const r = playWeaponCard(state, "hero-01", 0, "mind-hammer-r1");

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.autoRefresh).toBeUndefined();
    expect(state.loadouts["hero-01"]!.slotCards[0]).toBe("mind-hammer-r1");
    expect(state.elements["hero-01"]!.earth).toBe(2); // untouched
  });

  it("after auto-refresh, the action step is still available (slot ability + weapon ability both work)", () => {
    state.elements["hero-01"] = { earth: 2 };
    const place = playWeaponCard(state, "hero-01", 2, "mind-hammer-r1");
    expect(place.ok).toBe(true);

    // Slot 2 = bonus-movement-this-turn for Mind. The action gate
    // reads `cardPlacedThisTurn`, NOT `slotCards[i]`, so this works
    // even though the card is back in hand.
    const startMov = state.loadouts["hero-01"]!.currentMovement;
    const action = useSlotAbility(state, "hero-01", 2, { kind: "bonus-movement-this-turn" });
    expect(action.ok).toBe(true);
    expect(state.loadouts["hero-01"]!.currentMovement).toBe(startMov + 1);
    expect(state.encounter!.turnState["hero-01"]!.actionUsedThisTurn).toBe(true);
  });

  it("undo after auto-refresh \u2192 restores the 2 spent element tokens AND clears the placement latch", () => {
    state.elements["hero-01"] = { earth: 2 };
    playWeaponCard(state, "hero-01", 2, "mind-hammer-r1");
    expect(state.elements["hero-01"]!.earth).toBe(0);

    const undo = undoWeaponPlacement(state, "hero-01");
    expect(undo.ok).toBe(true);
    // Both tokens restored to the bag (capping back at 2), card stays
    // in hand (was already in hand after the auto-refresh), latch
    // cleared so the player can place again.
    expect(state.elements["hero-01"]!.earth).toBe(2);
    expect(state.loadouts["hero-01"]!.slotCards[2]).toBeNull();
    expect(state.encounter!.turnState["hero-01"]!.cardPlacedThisTurn).toBeNull();
  });
});

// --- undoWeaponPlacement (flexibility before commit) --------------------

describe("undoWeaponPlacement", () => {
  beforeEach(() => {
    state.currentDelverId = "hero-01";
    ensureEncounter(state, QUEST1);
    startHeroTurn(state);
  });

  it("clears the slot AND the per-turn placement latch", () => {
    playWeaponCard(state, "hero-01", 0, "mind-hammer-r1");
    expect(state.loadouts["hero-01"]!.slotCards[0]).toBe("mind-hammer-r1");
    expect(state.encounter!.turnState["hero-01"]!.cardPlacedThisTurn).not.toBeNull();

    const r = undoWeaponPlacement(state, "hero-01");

    expect(r.ok).toBe(true);
    expect(state.loadouts["hero-01"]!.slotCards[0]).toBeNull();
    expect(state.encounter!.turnState["hero-01"]!.cardPlacedThisTurn).toBeNull();
  });

  it("allows a fresh placement (different slot OR different card) after undo", () => {
    playWeaponCard(state, "hero-01", 0, "mind-hammer-r1");
    undoWeaponPlacement(state, "hero-01");

    // Same card, different slot.
    const r1 = playWeaponCard(state, "hero-01", 1, "mind-hammer-r1");
    expect(r1.ok).toBe(true);
    expect(state.loadouts["hero-01"]!.slotCards[0]).toBeNull();
    expect(state.loadouts["hero-01"]!.slotCards[1]).toBe("mind-hammer-r1");

    // Undo again, then place a different card entirely.
    undoWeaponPlacement(state, "hero-01");
    const r2 = playWeaponCard(state, "hero-01", 2, "mind-beam-r1");
    expect(r2.ok).toBe(true);
    expect(state.loadouts["hero-01"]!.slotCards[2]).toBe("mind-beam-r1");
  });

  it("rejects when no card has been placed this turn", () => {
    const r = undoWeaponPlacement(state, "hero-01");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no card placed/i);
  });

  it("rejects after the action step has been used (locked in)", () => {
    playWeaponCard(state, "hero-01", 2, "mind-hammer-r1"); // slot 2 = earth (+1 movement)
    const used = useSlotAbility(state, "hero-01", 2, { kind: "bonus-movement-this-turn" });
    expect(used.ok).toBe(true);

    const r = undoWeaponPlacement(state, "hero-01");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/after using an action/i);
    // Slot is still occupied; latch is still set.
    expect(state.loadouts["hero-01"]!.slotCards[2]).toBe("mind-hammer-r1");
    expect(state.encounter!.turnState["hero-01"]!.cardPlacedThisTurn).not.toBeNull();
  });

  // 2026-05-22: undo is intentionally allowed AFTER movement so the
  // "movement-before-card" flow (2026-05-21) actually buys the player
  // flexibility. Movement that already happened stays committed; only
  // the card placement is unwound. Without this allowance, a player
  // who walked then placed would be locked into their first card
  // choice even though they haven't attacked yet.
  it("allows undo after the movement step has been used (movement stays committed; placement unwinds)", () => {
    playWeaponCard(state, "hero-01", 0, "mind-hammer-r1");
    state.encounter!.turnState["hero-01"]!.movementUsedThisTurn = true;

    const r = undoWeaponPlacement(state, "hero-01");
    expect(r.ok).toBe(true);
    expect(state.loadouts["hero-01"]!.slotCards[0]).toBeNull();
    expect(state.encounter!.turnState["hero-01"]!.cardPlacedThisTurn).toBeNull();
    expect(state.encounter!.turnState["hero-01"]!.movementUsedThisTurn).toBe(true);
  });

  it("rejects when called on the inactive delver", () => {
    playWeaponCard(state, "hero-01", 0, "mind-hammer-r1");
    const r = undoWeaponPlacement(state, "hero-02");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/active delver/i);
  });

  it("does not consume the player's mandatory turn-start choice — they may still Prepare to Run", () => {
    playWeaponCard(state, "hero-01", 0, "mind-hammer-r1");
    const undo = undoWeaponPlacement(state, "hero-01");
    expect(undo.ok).toBe(true);

    const prep = prepareToRun(state, "hero-01");
    expect(prep.ok).toBe(true);
    expect(state.encounter!.preparedToRun["hero-01"]).toBe(true);
  });
});

// --- Slice 4b.2: prepareToRun --------------------------------------------

describe("prepareToRun", () => {
  beforeEach(() => {
    state.currentDelverId = "hero-01";
    ensureEncounter(state, QUEST1);
    startHeroTurn(state);
  });

  it("latches the per-delver flag on success", () => {
    const r = prepareToRun(state, "hero-01");

    expect(r.ok).toBe(true);
    expect(state.encounter!.preparedToRun["hero-01"]).toBe(true);
  });

  it("does NOT latch the other delver's flag", () => {
    prepareToRun(state, "hero-01");
    expect(state.encounter!.preparedToRun["hero-02"]).toBe(false);
  });

  it("rejects when the delver has already prepared", () => {
    prepareToRun(state, "hero-01");
    const r = prepareToRun(state, "hero-01");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/already prepared/i);
  });

  it("rejects when the delver has already placed a card this turn", () => {
    playWeaponCard(state, "hero-01", 0, "mind-hammer-r1");

    const r = prepareToRun(state, "hero-01");

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/cannot prepare/i);
    expect(state.encounter!.preparedToRun["hero-01"]).toBe(false);
  });
});

// --- Slice 4c: useWeaponAbility / useSlotAbility gating ------------------

describe("useWeaponAbility / useSlotAbility — Action gate (DESIGN.md §5.2.1)", () => {
  beforeEach(() => {
    state.currentDelverId = "hero-01";
    ensureEncounter(state, QUEST1);
    startHeroTurn(state);
    // Move hero-02 well clear of any hero-01 counter pattern offsets.
    state.encounter!.delverPositions["hero-02"] = { x: 0, y: 4 };
  });

  it("rejects useWeaponAbility before any card has been placed", () => {
    const r = useWeaponAbility(state, "hero-01", 0, {
      kind: "die-roll-fixed", dieRoll: 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no card placed/i);
  });

  it("rejects useSlotAbility before any card has been placed", () => {
    const r = useSlotAbility(state, "hero-01", 2, { kind: "bonus-movement-this-turn" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no card placed/i);
  });

  it("happy path: useSlotAbility (bonus-movement) succeeds and latches actionUsedThisTurn", () => {
    playWeaponCard(state, "hero-01", 2, "mind-hammer-r1"); // place into slot 2 (earth=+1mov)
    const startMov = state.loadouts["hero-01"]!.currentMovement;
    const r = useSlotAbility(state, "hero-01", 2, { kind: "bonus-movement-this-turn" });
    expect(r.ok).toBe(true);
    expect(state.loadouts["hero-01"]!.currentMovement).toBe(startMov + 1);
    expect(state.encounter!.turnState["hero-01"]!.actionUsedThisTurn).toBe(true);
  });

  it("rejects a second action after one has been taken (you can only pick ONE)", () => {
    playWeaponCard(state, "hero-01", 2, "mind-hammer-r1");
    const r1 = useSlotAbility(state, "hero-01", 2, { kind: "bonus-movement-this-turn" });
    expect(r1.ok).toBe(true);

    // Try the weapon ability now — same slot.
    const r2 = useWeaponAbility(state, "hero-01", 2, {
      kind: "die-roll-fixed", dieRoll: 1,
    });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toMatch(/already used/i);

    // Try the slot ability again.
    const r3 = useSlotAbility(state, "hero-01", 2, { kind: "bonus-movement-this-turn" });
    expect(r3.ok).toBe(false);
  });

  it("rejects when slotIdx doesn't match the placed slot (wrong slot)", () => {
    playWeaponCard(state, "hero-01", 0, "mind-hammer-r1"); // placed in 0
    const r = useSlotAbility(state, "hero-01", 2, { kind: "bonus-movement-this-turn" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/not this turn's placed slot/i);
  });

  it("rejects when the delver has prepared to run", () => {
    prepareToRun(state, "hero-01");
    const r = useSlotAbility(state, "hero-01", 0, { kind: "damage-any-enemy", targetX: 0, targetY: 0 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no card placed|prepared to run/i);
  });

  it("rejects when called on the inactive delver", () => {
    playWeaponCard(state, "hero-01", 2, "mind-hammer-r1");
    const r = useSlotAbility(state, "hero-02", 2, { kind: "bonus-movement-this-turn" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/not the active delver/i);
  });

  it("happy path: useWeaponAbility (Crash Hammer W=roll 2) returns a session and latches the action", () => {
    playWeaponCard(state, "hero-01", 0, "mind-hammer-r1");
    // Spawn an enemy to the WEST of hero-01 (which is at default spawn).
    const pos = state.encounter!.delverPositions["hero-01"]!;
    state.encounter!.enemies = [{
      instanceId: "c-test",
      cardId: "crystanid-001",
      x: pos.x - 1, y: pos.y,
      damageTaken: 0,
      alive: true,
      facing: 0,
    }];

    const r = useWeaponAbility(state, "hero-01", 0, {
      kind: "die-roll-fixed", dieRoll: 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session.hitTiles).toEqual([{ x: pos.x - 1, y: pos.y }]);
    expect(state.encounter!.turnState["hero-01"]!.actionUsedThisTurn).toBe(true);
  });

  it("useWeaponAbility rejection (e.g. invalid die roll) does NOT latch actionUsedThisTurn", () => {
    playWeaponCard(state, "hero-01", 0, "mind-hammer-r1");
    const r = useWeaponAbility(state, "hero-01", 0, {
      kind: "die-roll-fixed", dieRoll: 99,
    });
    expect(r.ok).toBe(false);
    expect(state.encounter!.turnState["hero-01"]!.actionUsedThisTurn).toBe(false);
  });

  // Regression for session 20260509-152644-4tyt: a level-up-bumped Crash
  // Hammer (R2) was firing the R1 single-tile range because the engine
  // read `card.range` from the R1 placeholder stored in the slot. Swing
  // should follow the rank-correct 3-tile line.
  it("REGRESSION: Crash Hammer R2 hits 3 tiles in a line (rank-correct range, not R1 placeholder)", () => {
    state.equipmentRanks["hero-01"]!.Hammer = 2;
    const pos = { x: 0, y: 4 };
    state.encounter!.delverPositions["hero-01"] = pos;
    state.encounter!.delverPositions["hero-02"] = { x: 4, y: 0 };
    playWeaponCard(state, "hero-01", 0, "mind-hammer-r1");

    // EAST = roll 4-6 → tiles (1,4), (2,4), (3,4). All on-board for a 5x5
    // board so the swing should report 3 hit tiles.
    const r = useWeaponAbility(state, "hero-01", 0, {
      kind: "die-roll-fixed", dieRoll: 5,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session.hitTiles).toEqual([
      { x: 1, y: 4 },
      { x: 2, y: 4 },
      { x: 3, y: 4 },
    ]);
  });
});

// --- AP spend (DESIGN.md §4.3) -------------------------------------------

describe("spendApDoubleMovement", () => {
  beforeEach(() => {
    state.currentDelverId = "hero-01";
    ensureEncounter(state, QUEST1);
    startHeroTurn(state);
    // Reset AP & movement to base so test starting state is unambiguous.
    const lo = state.loadouts["hero-01"]!;
    lo.currentAp = lo.baseAp;
    lo.currentMovement = lo.baseMovement;
  });

  it("happy path BEFORE placement: spends 1 AP, MULTIPLIES currentMovement by 2, latches one-shot flag", () => {
    const lo = state.loadouts["hero-01"]!;
    const startAp = lo.currentAp;
    const startMov = lo.currentMovement;

    const r = spendApDoubleMovement(state, "hero-01");

    expect(r.ok).toBe(true);
    expect(lo.currentAp).toBe(startAp - 1);
    // True doubling, not + baseMovement (DESIGN.md §5.5.1).
    expect(lo.currentMovement).toBe(startMov * 2);
    expect(state.encounter!.turnState["hero-01"]!.apMovementDoubledThisTurn).toBe(true);
  });

  it("happy path AFTER placement: same multiplicative effect, placement state untouched", () => {
    playWeaponCard(state, "hero-01", 0, "mind-hammer-r1");
    const lo = state.loadouts["hero-01"]!;
    const startAp = lo.currentAp;
    const startMov = lo.currentMovement;

    const r = spendApDoubleMovement(state, "hero-01");

    expect(r.ok).toBe(true);
    expect(lo.currentAp).toBe(startAp - 1);
    expect(lo.currentMovement).toBe(startMov * 2);
    expect(state.encounter!.turnState["hero-01"]!.cardPlacedThisTurn).not.toBeNull();
  });

  it("rejects a second double on the same turn", () => {
    expect(spendApDoubleMovement(state, "hero-01").ok).toBe(true);

    const r = spendApDoubleMovement(state, "hero-01");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/already doubled/i);
  });

  it("rejects after movement has already been used this turn", () => {
    state.encounter!.turnState["hero-01"]!.movementUsedThisTurn = true;

    const r = spendApDoubleMovement(state, "hero-01");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/movement already used/i);
  });

  it("rejects when not enough AP", () => {
    state.loadouts["hero-01"]!.currentAp = 0;

    const r = spendApDoubleMovement(state, "hero-01");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/not enough ap/i);
  });

  it("rejects when called on inactive delver", () => {
    const r = spendApDoubleMovement(state, "hero-02");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/active delver/i);
  });

  it("rejects when delver has prepared to run", () => {
    state.encounter!.preparedToRun["hero-01"] = true;
    const r = spendApDoubleMovement(state, "hero-01");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/prepared to run/i);
  });
});

// Rulebook AP table: "5 AP: Spending 5 AP allows a player to refresh
// all Weapon Cards." Missing pre-2026-07-22 (player report) — the AP
// menu only offered Double Movement (1 AP) and single refresh (2 AP).
describe("spendApRefreshAllWeapons", () => {
  beforeEach(() => {
    state.currentDelverId = "hero-01";
    ensureEncounter(state, QUEST1);
    startHeroTurn(state);
    const lo = state.loadouts["hero-01"]!;
    lo.baseAp = 6;
    lo.currentAp = 6;
  });

  it("refreshes EVERY occupied slot for 5 AP", () => {
    const lo = state.loadouts["hero-01"]!;
    lo.slotCards[0] = "mind-hammer-r1";
    lo.slotCards[1] = "mind-shield-r1";
    lo.slotCards[4] = "mind-beam-r1";

    const r = spendApRefreshAllWeapons(state, "hero-01");

    expect(r.ok).toBe(true);
    expect(lo.currentAp).toBe(1); // 6 - 5
    expect(lo.slotCards.every((s) => s === null)).toBe(true);
  });

  it("clears cardPlacedThisTurn when the just-placed slot is among the refreshed", () => {
    playWeaponCard(state, "hero-01", 0, "mind-hammer-r1");
    const r = spendApRefreshAllWeapons(state, "hero-01");
    expect(r.ok).toBe(true);
    expect(state.encounter!.turnState["hero-01"]!.cardPlacedThisTurn).toBeNull();
  });

  it("rejects with fewer than 5 AP (no mutation)", () => {
    const lo = state.loadouts["hero-01"]!;
    lo.currentAp = 4;
    lo.slotCards[1] = "mind-shield-r1";
    const r = spendApRefreshAllWeapons(state, "hero-01");
    expect(r.ok).toBe(false);
    expect(lo.currentAp).toBe(4);
    expect(lo.slotCards[1]).toBe("mind-shield-r1");
  });

  it("rejects when no slot holds a card", () => {
    const r = spendApRefreshAllWeapons(state, "hero-01");
    expect(r.ok).toBe(false);
    expect(state.loadouts["hero-01"]!.currentAp).toBe(6); // untouched
  });

  it("rejects for the non-active delver", () => {
    state.loadouts["hero-02"]!.slotCards[0] = "body-sword-r1";
    state.loadouts["hero-02"]!.currentAp = 6;
    const r = spendApRefreshAllWeapons(state, "hero-02");
    expect(r.ok).toBe(false);
  });

  it("clears a prepared-to-run latch when the refresh restores a playable weapon", () => {
    const lo = state.loadouts["hero-01"]!;
    // Simulate the lockout: every weapon exhausted into slots, latch set.
    lo.slotCards[0] = "mind-hammer-r1";
    state.encounter!.preparedToRun["hero-01"] = true;

    const r = spendApRefreshAllWeapons(state, "hero-01");

    expect(r.ok).toBe(true);
    expect(state.encounter!.preparedToRun["hero-01"]).toBe(false);
  });
});

describe("spendApRefreshWeapon", () => {
  beforeEach(() => {
    state.currentDelverId = "hero-01";
    ensureEncounter(state, QUEST1);
    startHeroTurn(state);
    const lo = state.loadouts["hero-01"]!;
    lo.currentAp = lo.baseAp;
  });

  it("happy path BEFORE placement: refresh a slot from a prior turn", () => {
    // Pretend slot 1 has an exhausted card from a prior turn.
    state.loadouts["hero-01"]!.slotCards[1] = "mind-shield-r1";
    const startAp = state.loadouts["hero-01"]!.currentAp;

    const r = spendApRefreshWeapon(state, "hero-01", 1);

    expect(r.ok).toBe(true);
    expect(state.loadouts["hero-01"]!.currentAp).toBe(startAp - 2);
    expect(state.loadouts["hero-01"]!.slotCards[1]).toBeNull();
    // No placement happened this turn — latch stays null.
    expect(state.encounter!.turnState["hero-01"]!.cardPlacedThisTurn).toBeNull();
  });

  it("happy path AFTER placement: refresh a non-just-placed slot — slot empties, card returns to hand, latch untouched", () => {
    playWeaponCard(state, "hero-01", 0, "mind-hammer-r1");
    // Pretend slot 1 has a card from a prior turn.
    state.loadouts["hero-01"]!.slotCards[1] = "mind-shield-r1";
    const startAp = state.loadouts["hero-01"]!.currentAp;

    const r = spendApRefreshWeapon(state, "hero-01", 1);

    expect(r.ok).toBe(true);
    expect(state.loadouts["hero-01"]!.currentAp).toBe(startAp - 2);
    expect(state.loadouts["hero-01"]!.slotCards[1]).toBeNull();
    // Just-placed latch should still point to slot 0.
    expect(state.encounter!.turnState["hero-01"]!.cardPlacedThisTurn).toEqual({
      slotIdx: 0, cardId: "mind-hammer-r1", autoRefreshedElement: null,
    });
  });

  it("refreshing the just-placed slot also clears cardPlacedThisTurn", () => {
    playWeaponCard(state, "hero-01", 0, "mind-hammer-r1");

    const r = spendApRefreshWeapon(state, "hero-01", 0);

    expect(r.ok).toBe(true);
    expect(state.loadouts["hero-01"]!.slotCards[0]).toBeNull();
    expect(state.encounter!.turnState["hero-01"]!.cardPlacedThisTurn).toBeNull();
  });

  it("rejects when slot is empty", () => {
    playWeaponCard(state, "hero-01", 0, "mind-hammer-r1");
    const r = spendApRefreshWeapon(state, "hero-01", 3); // slot 3 is empty
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/slot is empty/i);
  });

  it("rejects when not enough AP", () => {
    playWeaponCard(state, "hero-01", 0, "mind-hammer-r1");
    state.loadouts["hero-01"]!.currentAp = 1;

    const r = spendApRefreshWeapon(state, "hero-01", 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/not enough ap/i);
  });

  it("rejects on slotIdx out of range", () => {
    playWeaponCard(state, "hero-01", 0, "mind-hammer-r1");
    const r = spendApRefreshWeapon(state, "hero-01", 99);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/out of range/i);
  });

  // Regression for the 2026-05-09 user repro (refresh-weapon UX bug).
  // Scenario captured from screenshot:
  //   - Mind delver active, Battery acquired via level-up earlier
  //     (equipmentRanks.Battery = 1) — Battery is a passive so it
  //     stays in hand and doesn't change anything about the AP-refresh
  //     contract.
  //   - Crash Hammer just placed THIS turn into slot 1 (void), the
  //     mandatory placement for the turn.
  //   - currentAp = 3 (full), baseAp = 3.
  //   - Player picks "Refresh weapon" -> "Slot 2: Crash Hammer".
  // Expected: AP drops by 2, slot 1 empties, Crash Hammer goes back to
  // hand (well, the loadout side: slot is null — hand renders from
  // equipmentRanks - placed). The just-placed latch clears so the
  // player has to do their mandatory placement again.
  // This ALSO confirms the engine does NOT silently reject when
  // Battery is owned (testing-out-the-only-thing-that-changed-in-the-
  // user's-state hypothesis).
  it("USER REPRO 2026-05-09: refresh just-placed Crash Hammer with Battery owned", () => {
    state.equipmentRanks["hero-01"]!.Battery = 1;
    const r1 = playWeaponCard(state, "hero-01", 1, "mind-hammer-r1");
    expect(r1.ok).toBe(true);
    expect(state.encounter!.turnState["hero-01"]!.cardPlacedThisTurn).toEqual({
      slotIdx: 1, cardId: "mind-hammer-r1", autoRefreshedElement: null,
    });
    const startAp = state.loadouts["hero-01"]!.currentAp;
    expect(startAp).toBeGreaterThanOrEqual(2);

    const r2 = spendApRefreshWeapon(state, "hero-01", 1);

    expect(r2.ok).toBe(true);
    if (!r2.ok) return; // narrow for reason inspection on failure
    expect(state.loadouts["hero-01"]!.currentAp).toBe(startAp - 2);
    expect(state.loadouts["hero-01"]!.slotCards[1]).toBeNull();
    expect(state.encounter!.turnState["hero-01"]!.cardPlacedThisTurn).toBeNull();
  });

  // USER REPRO 2026-05-18 (two-part): Mind delver exhausted all 3
  // weapons into slots over several turns, auto-latched
  // preparedToRun on the next turn-start, then opened the AP-spend
  // menu and tried to refresh Surge Claw (slot 1) by spending 2 AP.
  //
  // Part 1 (initial repro): the engine rejected with "delver has
  // prepared to run", leaving the player permanently locked out for
  // the wave. Fixed by removing the `preparedToRun` gate from
  // `spendApRefreshWeapon`.
  //
  // Part 2 (regression after Part 1's fix): the refresh succeeded
  // but the latch was kept sticky for the rest of the turn, so the
  // subsequent `playWeaponCard` to place the refreshed Crash Hammer
  // STILL rejected with "delver has prepared to run". Fixed by
  // re-evaluating the latch inside `spendApRefreshWeapon` — the
  // moment the hand has a playable weapon again, the latch's only
  // raison d'être stops being true so we clear it in place.
  //
  // This test exercises BOTH legs of the fix end-to-end:
  //   1. Refresh succeeds while preparedToRun.
  //   2. Latch clears immediately (mid-turn) because the hand now
  //      has a playable weapon.
  //   3. `playWeaponCard` for the just-refreshed card succeeds on
  //      the same turn.
  it("USER REPRO 2026-05-18: prepared-to-run escape hatch — refresh + immediate mid-turn placement on the same turn", () => {
    // Mirror the user's exact end-state: Mind delver owns Hammer +
    // Beam (starting weapons) and picked up Surge Claw (Gauntlet)
    // via a level-up earlier in the wave. All three are placed in
    // slots, so the hand has no playable weapon when the next turn
    // starts — auto-prepare-to-run latches.
    state.equipmentRanks["hero-01"]!.Gauntlet = 1;
    const lo = state.loadouts["hero-01"]!;
    lo.slotCards[0] = "mind-hammer-r1";
    lo.slotCards[1] = "mind-gauntlet-r1";
    lo.slotCards[2] = "mind-beam-r1";
    // Re-run startHeroTurn so the auto-prepare check fires against
    // the now-empty playable hand.
    startHeroTurn(state);
    expect(state.encounter!.preparedToRun["hero-01"]).toBe(true);
    // Top up AP so the test is about the gate, not the cost.
    lo.currentAp = lo.baseAp;
    const startAp = lo.currentAp;

    // Part 1: Refresh must succeed even though preparedToRun is true.
    const r = spendApRefreshWeapon(state, "hero-01", 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return; // narrow for reason inspection on failure
    expect(lo.currentAp).toBe(startAp - 2);
    expect(lo.slotCards[1]).toBeNull();

    // Part 2: Latch clears IMMEDIATELY (mid-turn) because the hand
    // now has a playable weapon (Surge Claw came back).
    expect(state.encounter!.preparedToRun["hero-01"]).toBe(false);

    // Part 3: The just-refreshed card can be placed normally on the
    // SAME turn — the mandatory placement that the auto-prepare
    // displaced is now available again.
    const place = playWeaponCard(state, "hero-01", 3, "mind-gauntlet-r1");
    expect(place.ok).toBe(true);
    expect(state.loadouts["hero-01"]!.slotCards[3]).toBe("mind-gauntlet-r1");
    expect(state.encounter!.turnState["hero-01"]!.cardPlacedThisTurn).toEqual({
      slotIdx: 3, cardId: "mind-gauntlet-r1", autoRefreshedElement: null,
    });
  });

  // Defensive: if the refresh somehow leaves the hand still empty
  // (e.g., the only remaining playable weapon is itself the slot
  // we're refreshing into — impossible today because we just
  // emptied a slot, but worth pinning down the contract), the latch
  // must stay set so we don't accidentally unlock the player into
  // a state where placement would itself reject.
  it("prepared-to-run latch stays set after refresh when hand is STILL empty afterwards", () => {
    const lo = state.loadouts["hero-01"]!;
    // Starting equipment for hero-01 is hammer + beam + shield.
    // Place both weapons; only passives remain. No level-up grants.
    lo.slotCards[0] = "mind-hammer-r1";
    lo.slotCards[1] = "mind-beam-r1";
    startHeroTurn(state);
    expect(state.encounter!.preparedToRun["hero-01"]).toBe(true);
    lo.currentAp = lo.baseAp;

    // Refresh hammer — now slot 0 is empty AND hammer is back in
    // hand. So the hand DOES have a playable weapon → latch clears.
    // (This is the normal escape-hatch case; the "still empty"
    // branch is unreachable in real play because refresh always
    // restores at least one weapon. We keep this test as a
    // documented invariant so future contributors don't naively
    // strip the `hasPlayableWeaponInHand` check from the clear.)
    const r = spendApRefreshWeapon(state, "hero-01", 0);
    expect(r.ok).toBe(true);
    expect(state.encounter!.preparedToRun["hero-01"]).toBe(false);
  });
});

// --- AP-double + bonus-movement interaction (DESIGN.md §5.5.1) -----------
// User-reported: spending 1 AP to double + using +1 movement slot ability
// should yield 4 total movement for a delver with baseMovement = 1.
// The doubling must apply to BOTH the base AND the slot bonus,
// regardless of order.

describe("AP-double interaction with +movement slot ability (order-independent)", () => {
  beforeEach(() => {
    state.currentDelverId = "hero-01";
    ensureEncounter(state, QUEST1);
    startHeroTurn(state);
    const lo = state.loadouts["hero-01"]!;
    lo.currentAp = lo.baseAp;
    // Force baseMovement = 1 for an unambiguous (1+1)*2 = 4 check.
    lo.baseMovement = 1;
    lo.currentMovement = 1;
  });

  it("AP-double FIRST then +1 mov slot ability → currentMovement = 4", () => {
    const lo = state.loadouts["hero-01"]!;

    expect(spendApDoubleMovement(state, "hero-01").ok).toBe(true);
    expect(lo.currentMovement).toBe(2); // 1 * 2

    playWeaponCard(state, "hero-01", 2, "mind-hammer-r1"); // earth slot
    const r = useSlotAbility(state, "hero-01", 2, { kind: "bonus-movement-this-turn" });
    expect(r.ok).toBe(true);
    expect(lo.currentMovement).toBe(4); // 2 + (1*2 doubled)
  });

  it("+1 mov slot ability FIRST then AP-double → currentMovement = 4", () => {
    const lo = state.loadouts["hero-01"]!;

    playWeaponCard(state, "hero-01", 2, "mind-hammer-r1"); // earth slot
    const r = useSlotAbility(state, "hero-01", 2, { kind: "bonus-movement-this-turn" });
    expect(r.ok).toBe(true);
    expect(lo.currentMovement).toBe(2); // 1 + 1 (no doubling yet)

    expect(spendApDoubleMovement(state, "hero-01").ok).toBe(true);
    expect(lo.currentMovement).toBe(4); // 2 * 2
  });

  it("only AP-double (no slot bonus) → currentMovement = 2", () => {
    const lo = state.loadouts["hero-01"]!;
    expect(spendApDoubleMovement(state, "hero-01").ok).toBe(true);
    expect(lo.currentMovement).toBe(2);
  });

  it("only +1 mov slot ability (no AP-double) → currentMovement = 2", () => {
    const lo = state.loadouts["hero-01"]!;
    playWeaponCard(state, "hero-01", 2, "mind-hammer-r1");
    const r = useSlotAbility(state, "hero-01", 2, { kind: "bonus-movement-this-turn" });
    expect(r.ok).toBe(true);
    expect(lo.currentMovement).toBe(2);
  });
});

// --- +1 movement slot ability (DESIGN.md §5.1.2) --------------------------
// Movement is one continuous move (designer ruling 2026-11-17). The +1
// movement slot ability helps a delver who hasn't moved yet: they act,
// then move with the bonus. A delver who already stepped loses their
// remaining movement when they act, this ability included, so they
// can't move, act and move again.

describe("+1 movement slot ability — movement stays one continuous move (DESIGN.md §5.1.2)", () => {
  beforeEach(() => {
    state.currentDelverId = "hero-01";
    ensureEncounter(state, QUEST1);
    startHeroTurn(state);
    const lo = state.loadouts["hero-01"]!;
    lo.currentAp = lo.baseAp;
    // Force baseMovement = 1 to mirror the user repro exactly.
    lo.baseMovement = 1;
    lo.currentMovement = 1;
    // Clear surrounding board so adjacency tests aren't blocked by enemies.
    state.encounter!.enemies = [];
  });

  it("place + AP-double + +1 mov slot ability → 4 MP usable post-action (user repro)", () => {
    const lo = state.loadouts["hero-01"]!;
    const board = QUEST1.waves[0]!.spawn.boardSize;
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };

    playWeaponCard(state, "hero-01", 2, "mind-hammer-r1"); // earth slot
    expect(spendApDoubleMovement(state, "hero-01").ok).toBe(true);
    expect(lo.currentMovement).toBe(2);

    const r = useSlotAbility(state, "hero-01", 2, { kind: "bonus-movement-this-turn" });
    expect(r.ok).toBe(true);
    expect(lo.currentMovement).toBe(4); // 2 + (1 doubled by AP)
    const ts = state.encounter!.turnState["hero-01"]!;
    expect(ts.actionUsedThisTurn).toBe(true);
    expect(ts.actionGrantedExtraMovement).toBe(true);
    expect(ts.movementUsedThisTurn).toBe(false);

    // No step was taken before the action, so the whole pool is still
    // one fresh move after it.
    expect(legalStepDestinations(state, "hero-01", board).length).toBeGreaterThan(0);
    // And the player can actually take all 4 steps.
    expect(moveDelverStep(state, "hero-01", 3, 3, board).ok).toBe(true);
    expect(moveDelverStep(state, "hero-01", 3, 4, board).ok).toBe(true);
    expect(moveDelverStep(state, "hero-01", 4, 4, board).ok).toBe(true);
    const final = moveDelverStep(state, "hero-01", 3, 3, board);
    expect(final.ok).toBe(true);
    if (!final.ok) return;
    // 4th step exhausts MP and auto-latches the session.
    expect(final.sessionEnded).toBe(true);
    expect(lo.currentMovement).toBe(0);
    expect(state.encounter!.turnState["hero-01"]!.movementUsedThisTurn).toBe(true);
  });

  it("place + +1 mov slot ability (no AP-double) → 2 MP usable post-action", () => {
    const lo = state.loadouts["hero-01"]!;
    const board = QUEST1.waves[0]!.spawn.boardSize;
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };

    playWeaponCard(state, "hero-01", 2, "mind-hammer-r1");
    const r = useSlotAbility(state, "hero-01", 2, { kind: "bonus-movement-this-turn" });
    expect(r.ok).toBe(true);
    expect(lo.currentMovement).toBe(2);

    expect(legalStepDestinations(state, "hero-01", board).length).toBeGreaterThan(0);
    expect(moveDelverStep(state, "hero-01", 3, 3, board).ok).toBe(true);
    expect(moveDelverStep(state, "hero-01", 4, 4, board).ok).toBe(true);
    expect(lo.currentMovement).toBe(0);
  });

  it("moved-to-zero THEN took +1 mov slot ability → the bonus can't be used", () => {
    const lo = state.loadouts["hero-01"]!;
    const board = QUEST1.waves[0]!.spawn.boardSize;
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };

    playWeaponCard(state, "hero-01", 2, "mind-hammer-r1");
    expect(moveDelverStep(state, "hero-01", 3, 3, board).ok).toBe(true);
    expect(lo.currentMovement).toBe(0);
    expect(state.encounter!.turnState["hero-01"]!.movementUsedThisTurn).toBe(true);

    const r = useSlotAbility(state, "hero-01", 2, { kind: "bonus-movement-this-turn" });
    expect(r.ok).toBe(true);
    expect(state.encounter!.turnState["hero-01"]!.movementUsedThisTurn).toBe(true);
    expect(state.encounter!.turnState["hero-01"]!.actionGrantedExtraMovement).toBe(false);
    expect(legalStepDestinations(state, "hero-01", board)).toEqual([]);
  });

  it("moved part-way THEN took +1 mov slot ability → can't move, act and move again", () => {
    const lo = state.loadouts["hero-01"]!;
    lo.baseMovement = 2;
    lo.currentMovement = 2;
    const board = QUEST1.waves[0]!.spawn.boardSize;
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };

    playWeaponCard(state, "hero-01", 2, "mind-hammer-r1");
    expect(moveDelverStep(state, "hero-01", 3, 3, board).ok).toBe(true);
    expect(lo.currentMovement).toBe(1);

    const r = useSlotAbility(state, "hero-01", 2, { kind: "bonus-movement-this-turn" });
    expect(r.ok).toBe(true);
    expect(state.encounter!.turnState["hero-01"]!.movementUsedThisTurn).toBe(true);
    expect(legalStepDestinations(state, "hero-01", board)).toEqual([]);
    expect(moveDelverStep(state, "hero-01", 4, 4, board).ok).toBe(false);
  });

  it("a different action (damage-any-enemy) also ends a movement in progress", () => {
    // Use an action that grants no movement — confirm the display
    // flag stays false and the action-gates-REMAINING-movement gate fires
    // when there's a partial-step session in flight (refined rule,
    // 2026-05-18).
    const lo = state.loadouts["hero-01"]!;
    // Give 2 MP so we can step once and still have a remaining
    // point to forfeit.
    lo.baseMovement = 2;
    lo.currentMovement = 2;
    const board = QUEST1.waves[0]!.spawn.boardSize;
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.encounter!.enemies = [
      { instanceId: "e-1", cardId: "crystanid-001", x: 4, y: 4, damageTaken: 0, alive: true, facing: 0 },
    ];

    // Mind radiance slot 0 = damage-any-enemy.
    playWeaponCard(state, "hero-01", 0, "mind-hammer-r1");
    // Step once so movementStepsThisTurn = 1 and there's a
    // remaining MP point. The refined gate only fires when there
    // is "remaining" MP to forfeit.
    expect(moveDelverStep(state, "hero-01", 3, 3, board).ok).toBe(true);
    expect(lo.currentMovement).toBe(1);
    expect(state.encounter!.turnState["hero-01"]!.movementStepsThisTurn).toBe(1);

    const r = useSlotAbility(state, "hero-01", 0, {
      kind: "damage-any-enemy", targetX: 4, targetY: 4,
    });
    expect(r.ok).toBe(true);
    const ts = state.encounter!.turnState["hero-01"]!;
    expect(ts.actionUsedThisTurn).toBe(true);
    expect(ts.actionGrantedExtraMovement).toBe(false);

    // Remaining MP from the partial-step session is forfeit.
    expect(legalStepDestinations(state, "hero-01", board)).toEqual([]);
  });

  it("scope check: action-then-move is now legal when no step was taken pre-action (refined 2026-05-18)", () => {
    // Same scope-check setup but WITHOUT a pre-action step.
    // The refined rule allows the fresh MP pool to be spent
    // post-action, since there's no "remaining" MP to forfeit
    // (movementStepsThisTurn is still 0).
    const lo = state.loadouts["hero-01"]!;
    lo.currentMovement = 1;
    const board = QUEST1.waves[0]!.spawn.boardSize;
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
    state.encounter!.enemies = [
      { instanceId: "e-1", cardId: "crystanid-001", x: 4, y: 4, damageTaken: 0, alive: true, facing: 0 },
    ];

    playWeaponCard(state, "hero-01", 0, "mind-hammer-r1");
    const r = useSlotAbility(state, "hero-01", 0, {
      kind: "damage-any-enemy", targetX: 4, targetY: 4,
    });
    expect(r.ok).toBe(true);
    const ts = state.encounter!.turnState["hero-01"]!;
    expect(ts.actionUsedThisTurn).toBe(true);
    expect(ts.actionGrantedExtraMovement).toBe(false);
    expect(ts.movementStepsThisTurn).toBe(0);

    // Fresh MP pool is still spendable post-action.
    expect(legalStepDestinations(state, "hero-01", board).length).toBeGreaterThan(0);
    expect(moveDelverStep(state, "hero-01", 3, 3, board).ok).toBe(true);
    expect(lo.currentMovement).toBe(0);
  });

  it("startHeroTurn next turn clears actionGrantedExtraMovement back to false", () => {
    playWeaponCard(state, "hero-01", 2, "mind-hammer-r1");
    expect(useSlotAbility(state, "hero-01", 2, { kind: "bonus-movement-this-turn" }).ok).toBe(true);
    expect(state.encounter!.turnState["hero-01"]!.actionGrantedExtraMovement).toBe(true);

    // Simulate next turn (refresh the same hero — the test fixture
    // stays simpler than going through end/flip/start).
    startHeroTurn(state);
    expect(state.encounter!.turnState["hero-01"]!.actionGrantedExtraMovement).toBe(false);
  });
});

// --- USER REPRO 2026-05-18 part 4: action → AP-double-mov → step → step
// User log shows (Mind hero, slot 3 = void Crash Hammer):
//   [8880912] click slot 3 -> action-menu opens (slot ability path)
//   [8882343] state.after-advance: ap=1 (slot ability granted +1 AP),
//             actionUsed=true, cardPlaced=slot 3
//   [8884469] click ap-spend.double-mov -> ap=0, currentMovement bumped to 2
//   [8885592] click.movement-source -> armed=true, movesLeft=2
//   [8887409] step 1 -> movementRemaining=1, sessionEnded=false
//   User tried to step a 2nd time and was blocked.
//
// Root cause: the previous (2026-05-18 part 2) refinement put the
// "action-gates-REMAINING-movement" gate into `legalStepDestinations`
// as `actionUsedThisTurn && movementStepsThisTurn > 0 &&
// !actionGrantedExtraMovement → []`. That fired here because
// `actionUsedThisTurn = true` (from the slot ability) and
// `movementStepsThisTurn = 1` (from the step the user just took
// AFTER the action). The gate couldn't tell "stepped before action"
// from "stepped after action with fresh MP" — both look the same to
// it.
//
// Fix (this part 4 refinement): move the "did the action interrupt
// movement" check into the action helper itself
// (`turn.ts > endMovementSessionIfActionInterruptsIt`), where it has
// the temporal context. The helper auto-latches
// `movementUsedThisTurn = true` ONLY when steps were taken BEFORE the
// action. `legalStepDestinations` reverts to a simple
// `movementUsedThisTurn` read.
describe("USER REPRO 2026-05-18 part 4 — action → AP-double-mov → step → step", () => {
  beforeEach(() => {
    state.currentDelverId = "hero-01";
    ensureEncounter(state, QUEST1);
    startHeroTurn(state);
    const lo = state.loadouts["hero-01"]!;
    lo.currentAp = lo.baseAp; // 3 AP
    lo.baseMovement = 1;
    lo.currentMovement = 1;
    state.encounter!.enemies = [];
    state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
  });

  it("place + slot ability (action) + AP-double-mov + step → can still take the second step", () => {
    const lo = state.loadouts["hero-01"]!;
    const board = QUEST1.waves[0]!.spawn.boardSize;

    // Place Crash Hammer in slot 3 (void); the void slot is
    // "refresh-ap" — taking it grants +1 AP. The exact slot ability
    // doesn't matter for the repro; what matters is that the action
    // fires WITHOUT moving first (steps=0 at action time).
    expect(playWeaponCard(state, "hero-01", 3, "mind-hammer-r1").ok).toBe(true);
    const r1 = useSlotAbility(state, "hero-01", 3, { kind: "refresh-ap" });
    expect(r1.ok).toBe(true);
    const ts = state.encounter!.turnState["hero-01"]!;
    expect(ts.actionUsedThisTurn).toBe(true);
    expect(ts.movementStepsThisTurn).toBe(0);
    // CRITICAL: the action helper saw steps=0 → no auto-latch.
    expect(ts.movementUsedThisTurn).toBe(false);

    // Now spend 1 AP to double movement. MP goes 1 → 2.
    expect(spendApDoubleMovement(state, "hero-01").ok).toBe(true);
    expect(lo.currentMovement).toBe(2);

    // Step 1 of 2.
    const step1 = moveDelverStep(state, "hero-01", 3, 3, board);
    expect(step1.ok).toBe(true);
    if (!step1.ok) return;
    expect(step1.movementRemaining).toBe(1);
    expect(step1.sessionEnded).toBe(false);
    expect(ts.movementStepsThisTurn).toBe(1);

    // Step 2 of 2 — the regression. Before this fix, the gate fired
    // here because actionUsed=true AND steps=1, ignoring that the
    // step was taken AFTER the action with fresh MP.
    expect(legalStepDestinations(state, "hero-01", board).length).toBeGreaterThan(0);
    const step2 = moveDelverStep(state, "hero-01", 4, 4, board);
    expect(step2.ok).toBe(true);
    if (!step2.ok) return;
    expect(step2.movementRemaining).toBe(0);
    expect(step2.sessionEnded).toBe(true);
    expect(lo.currentMovement).toBe(0);
    expect(ts.movementUsedThisTurn).toBe(true); // auto-latched on MP=0
  });

  it("inverse: move 1 step THEN action → remaining MP IS forfeit (action helper auto-latches)", () => {
    // Mirror case to confirm the rule still fires in the
    // pre-action-stepped scenario. The action helper should now
    // auto-latch `movementUsedThisTurn = true`, making the rule
    // visible to every downstream gate (legalStepDestinations,
    // BoardScreen mirror, cheatsheet).
    const lo = state.loadouts["hero-01"]!;
    lo.baseMovement = 2;
    lo.currentMovement = 2;
    const board = QUEST1.waves[0]!.spawn.boardSize;
    state.encounter!.enemies = [
      { instanceId: "e-1", cardId: "crystanid-001", x: 4, y: 4, damageTaken: 0, alive: true, facing: 0 },
    ];

    // Place Crash Hammer in slot 0 (radiance = damage-any-enemy
    // slot ability for the Mind delver — gives us a non-bonus-mov
    // action to use).
    expect(playWeaponCard(state, "hero-01", 0, "mind-hammer-r1").ok).toBe(true);

    // Step 1 — movement session in progress.
    expect(moveDelverStep(state, "hero-01", 3, 3, board).ok).toBe(true);
    const ts = state.encounter!.turnState["hero-01"]!;
    expect(ts.movementStepsThisTurn).toBe(1);
    expect(ts.movementUsedThisTurn).toBe(false);
    expect(lo.currentMovement).toBe(1);

    // Action interrupts the session. Helper should auto-latch.
    const r = useSlotAbility(state, "hero-01", 0, {
      kind: "damage-any-enemy", targetX: 4, targetY: 4,
    });
    expect(r.ok).toBe(true);
    expect(ts.actionUsedThisTurn).toBe(true);
    expect(ts.actionGrantedExtraMovement).toBe(false); // no bonus movement
    expect(ts.movementUsedThisTurn).toBe(true);        // <-- auto-latched

    // Remaining MP is forfeit at every layer.
    expect(legalStepDestinations(state, "hero-01", board)).toEqual([]);
    expect(moveDelverStep(state, "hero-01", 2, 4, board).ok).toBe(false);
  });

  it("useWeaponAbility also auto-latches when it interrupts mid-movement", () => {
    // Same as the inverse case above but driving the action through
    // useWeaponAbility instead of useSlotAbility, to confirm both
    // action entry points carry the helper.
    const lo = state.loadouts["hero-01"]!;
    lo.baseMovement = 2;
    lo.currentMovement = 2;
    const board = QUEST1.waves[0]!.spawn.boardSize;

    // Place Crash Hammer in slot 0; Crash Hammer is die-roll-fixed.
    expect(playWeaponCard(state, "hero-01", 0, "mind-hammer-r1").ok).toBe(true);

    // Step 1 — movement session in progress.
    expect(moveDelverStep(state, "hero-01", 3, 3, board).ok).toBe(true);
    const ts = state.encounter!.turnState["hero-01"]!;
    expect(ts.movementStepsThisTurn).toBe(1);
    expect(ts.movementUsedThisTurn).toBe(false);

    // Use the weapon. Crash Hammer is die-roll-fixed (rolls 1-3 hit
    // a west fan, 4-6 hit east). Roll 2 to hit empty tiles to the
    // west — no enemies needed.
    const r = useWeaponAbility(state, "hero-01", 0, {
      kind: "die-roll-fixed", dieRoll: 2,
    });
    expect(r.ok).toBe(true);
    expect(ts.actionUsedThisTurn).toBe(true);
    expect(ts.movementUsedThisTurn).toBe(true); // auto-latched
    expect(legalStepDestinations(state, "hero-01", board)).toEqual([]);
  });
});
