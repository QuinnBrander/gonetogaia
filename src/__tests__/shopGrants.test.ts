/**
 * Tests for `engine/shopGrants.ts` — the pipeline that applies
 * owned Shop Product `grants[]` to CampaignState at the right
 * scope boundary (quest start vs every wave).
 *
 * Covers:
 *   - Quest grant kinds: equipment-rank-bump, consumable-tokens,
 *     damage-bonus, equipment-upgrade, donation (no-op).
 *   - Wave grant kind: element-tokens (Fire / Earth / Light+Dark).
 *   - Idempotency via `shopGrantsAppliedQuests` (quest grants).
 *   - Wave grants re-fire across multiple calls (no flag-gate).
 *   - `endQuestReset` wiping `shopDamageBonus` + per-quest fields
 *     while preserving the ownership ledger.
 *   - Integration with `ensureEncounter` end-to-end so a
 *     Q1-completed save with shop purchases sees the bonuses
 *     applied the moment Q2's encounter bootstraps.
 */

import { describe, it, expect } from "vitest";

import { newCampaign, type CampaignState } from "../state";
import {
  applyShopGrantsForQuest,
  applyShopGrantsForWave,
} from "../engine/shopGrants";
import { endQuestReset, resetWaveForRetry } from "../engine/wave";
import { ensureEncounter, type EncounterBuildHooks } from "../engine/encounter";
import { getQuestData } from "../data";

// Pinned hooks for the ensureEncounter integration tests — same
// deterministic-spawn pattern as `encounterSpawnDeck.test.ts`.
const noShuffle = (pool: readonly string[]) => [...pool];
const pinnedHooks: EncounterBuildHooks = {
  assign: noShuffle,
  drawSpawnCardNumber: () => 1,
};

// --- Quest-scope grants --------------------------------------------------

describe("applyShopGrantsForQuest", () => {
  it("bumps the buyer's equipment rank when they own Trident (#1)", () => {
    const state = stateWithOwnedProducts({ "hero-02": [1] });
    applyShopGrantsForQuest(state, "quest2");
    // Body delver doesn't start with Trident — fresh from a `+1`
    // grant they should now be at Rank 1.
    expect(state.equipmentRanks["hero-02"]!.Trident).toBe(1);
  });

  it("bumps existing rank (stacks with a pre-existing rank in the table)", () => {
    const state = stateWithOwnedProducts({ "hero-02": [3] }); // Boots
    // hero-02 doesn't start with Boots (their starters are
    // Gauntlet / Sword / Armor — see data/heroes.json), so we
    // seed R1 manually to exercise the "stacks on top" branch
    // rather than the "first-grant" branch.
    state.equipmentRanks["hero-02"]!.Boots = 1;
    applyShopGrantsForQuest(state, "quest2");
    expect(state.equipmentRanks["hero-02"]!.Boots).toBe(2);
  });

  it("caps equipment rank bumps at the print ceiling (R5)", () => {
    const state = stateWithOwnedProducts({ "hero-02": [3] });
    state.equipmentRanks["hero-02"]!.Boots = 5;
    applyShopGrantsForQuest(state, "quest2");
    expect(state.equipmentRanks["hero-02"]!.Boots).toBe(5);
  });

  it("grants 2 reroll tokens for product #4 (Reroll Tokens x2)", () => {
    const state = stateWithOwnedProducts({ "hero-02": [4] });
    applyShopGrantsForQuest(state, "quest2");
    expect(state.consumableTokens["hero-02"]!.reroll).toEqual({ available: 2, spent: 0 });
  });

  it("grants 1 prevent-counterattack token for product #10", () => {
    const state = stateWithOwnedProducts({ "hero-01": [10] });
    applyShopGrantsForQuest(state, "quest2");
    expect(state.consumableTokens["hero-01"]!["prevent-counterattack"])
      .toEqual({ available: 1, spent: 0 });
  });

  it("adds +1 light damage to shopDamageBonus for product #5", () => {
    const state = stateWithOwnedProducts({ "hero-02": [5] });
    applyShopGrantsForQuest(state, "quest2");
    expect(state.shopDamageBonus["hero-02"]!.light).toBe(1);
  });

  it("adds +2 medium damage for product #9", () => {
    const state = stateWithOwnedProducts({ "hero-02": [9] });
    applyShopGrantsForQuest(state, "quest2");
    expect(state.shopDamageBonus["hero-02"]!.medium).toBe(2);
  });

  it("adds +4 heavy damage for product #13", () => {
    const state = stateWithOwnedProducts({ "hero-02": [13] });
    applyShopGrantsForQuest(state, "quest2");
    expect(state.shopDamageBonus["hero-02"]!.heavy).toBe(4);
  });

  it("stacks damage bonuses across multiple owned products of the same type", () => {
    // Hypothetical: both delvers buy +1 LIGHT (only one each in
    // shop data today, but the grant fan-out doesn't care)
    const state = stateWithOwnedProducts({ "hero-02": [5] });
    applyShopGrantsForQuest(state, "quest2");
    expect(state.shopDamageBonus["hero-02"]!.light).toBe(1);
  });

  it("equipment-upgrade (#32 Earth's Embrace Shield) swaps the Shield family, rank unchanged", () => {
    const state = stateWithOwnedProducts({ "hero-02": [32] });
    state.equipmentRanks["hero-02"]!.Shield = 1; // hero-02 starts at R1 Shield
    applyShopGrantsForQuest(state, "quest2");
    expect(state.equipmentVariants["hero-02"]!.Shield).toBe("earths-embrace-shield");
    expect(state.equipmentRanks["hero-02"]!.Shield).toBe(1);
  });

  it("treats the donation product (#8) as a no-op grant (still records apply)", () => {
    const state = stateWithOwnedProducts({ "hero-02": [8] });
    applyShopGrantsForQuest(state, "quest2");
    // No mechanical state changed.
    expect(state.shopDamageBonus["hero-02"]).toEqual({});
    expect(state.consumableTokens["hero-02"]).toEqual({});
    // Idempotency ledger DID update — the quest was processed.
    expect(state.shopGrantsAppliedQuests).toEqual(["quest2"]);
  });

  it("is idempotent — second call for the same quest is a no-op", () => {
    const state = stateWithOwnedProducts({ "hero-02": [3] });
    applyShopGrantsForQuest(state, "quest2");
    applyShopGrantsForQuest(state, "quest2");
    expect(state.equipmentRanks["hero-02"]!.Boots).toBe(1);
  });

  // Regression (player report 2026-07-20): buying the Boots product
  // put the card in the hand (rank table bump) but never fired the
  // card's IMMEDIATELY `set-base-movement`, so the bearer kept a
  // movement of 1 and the suit-board cube (which faithfully renders
  // `baseMovement`) showed no buff. First-time gain must apply the
  // R1 card's immediates, exactly like the Level-Up path.
  it("FIRST-TIME Boots gain (R0 -> R1) applies the movement floor of 2", () => {
    const state = stateWithOwnedProducts({ "hero-02": [3] });
    const lo = state.loadouts["hero-02"]!;
    expect(lo.baseMovement).toBe(1); // hero-02 has no starter Boots

    applyShopGrantsForQuest(state, "quest2");

    expect(state.equipmentRanks["hero-02"]!.Boots).toBe(1);
    expect(lo.baseMovement).toBe(2);
    // currentMovement pulled up too, so the buff is visible immediately.
    expect(lo.currentMovement).toBe(2);
  });

  it("rank-up of ALREADY-owned Boots (R1 -> R2) fires the R2 tier's immediates (matches Level-Up semantics)", () => {
    const state = stateWithOwnedProducts({ "hero-02": [3] });
    state.equipmentRanks["hero-02"]!.Boots = 1;
    const lo = state.loadouts["hero-02"]!;
    lo.baseMovement = 2; // floor already established at first gain

    applyShopGrantsForQuest(state, "quest2");

    expect(state.equipmentRanks["hero-02"]!.Boots).toBe(2);
    expect(lo.baseMovement).toBe(3); // R2 card raises the floor to 3
  });

  // Machinist purchases are REAL family replacements since
  // 2026-07-22 (printed: "these will replace your current X
  // Equipment") — the delver's rank is unchanged (min 1) and the
  // family swaps via `state.equipmentVariants`. Pre-fix this was
  // approximated as a +2 rank bump of the STANDARD card.
  it("Machinist #34 (Cyclone Boots) swaps the Boots FAMILY, keeps rank, applies the upgrade floor", () => {
    const state = stateWithOwnedProducts({ "hero-02": [34] });
    const lo = state.loadouts["hero-02"]!;

    applyShopGrantsForQuest(state, "quest2");

    expect(state.equipmentVariants["hero-02"]!.Boots).toBe("cyclone-boots");
    expect(state.equipmentRanks["hero-02"]!.Boots).toBe(1); // unowned buyer starts the family at R1
    expect(lo.baseMovement).toBe(2); // Cyclone R1: "Set your movement to 2"
  });

  it("Machinist #34 on a delver who ALREADY owns Boots R2 keeps rank 2 and applies the R2 upgrade card", () => {
    const state = stateWithOwnedProducts({ "hero-02": [34] });
    state.equipmentRanks["hero-02"]!.Boots = 2;
    const lo = state.loadouts["hero-02"]!;
    lo.baseMovement = 3; // standard R2 floor already applied

    applyShopGrantsForQuest(state, "quest2");

    expect(state.equipmentVariants["hero-02"]!.Boots).toBe("cyclone-boots");
    expect(state.equipmentRanks["hero-02"]!.Boots).toBe(2); // rank preserved
    expect(lo.baseMovement).toBe(3); // Cyclone R2 floor 3 (same value, re-affirmed)
  });

  it("does NOT apply wave-scope grants (those go through applyShopGrantsForWave)", () => {
    const state = stateWithOwnedProducts({ "hero-02": [6] }); // +1 Fire each wave
    applyShopGrantsForQuest(state, "quest2");
    expect(state.elements["hero-02"]).toEqual({});
  });
});

// --- Wave-scope grants ---------------------------------------------------

describe("applyShopGrantsForWave", () => {
  it("grants +1 fire element token for product #6", () => {
    const state = stateWithOwnedProducts({ "hero-02": [6] });
    applyShopGrantsForWave(state);
    expect(state.elements["hero-02"]!.fire).toBe(1);
  });

  it("grants +1 earth element token for product #7", () => {
    const state = stateWithOwnedProducts({ "hero-02": [7] });
    applyShopGrantsForWave(state);
    expect(state.elements["hero-02"]!.earth).toBe(1);
  });

  it("grants +1 radiance AND +1 void for product #11 (Light & Dark)", () => {
    const state = stateWithOwnedProducts({ "hero-01": [11] });
    applyShopGrantsForWave(state);
    expect(state.elements["hero-01"]!.radiance).toBe(1);
    expect(state.elements["hero-01"]!.void).toBe(1);
  });

  it("re-fires across multiple wave calls (no flag-gate) but respects the 2-per-element cap", () => {
    const state = stateWithOwnedProducts({ "hero-02": [6] });
    applyShopGrantsForWave(state);
    applyShopGrantsForWave(state);
    expect(state.elements["hero-02"]!.fire).toBe(2);
    // A third wave start would make 3: the overflow is lost (rulebook p16).
    applyShopGrantsForWave(state);
    expect(state.elements["hero-02"]!.fire).toBe(2);
  });

  it("a delver already at the cap gains nothing; the other elements are unaffected", () => {
    const state = stateWithOwnedProducts({ "hero-01": [11] }); // +1 radiance, +1 void
    state.elements["hero-01"] = { radiance: 2 };
    applyShopGrantsForWave(state);
    expect(state.elements["hero-01"]).toEqual({ radiance: 2, void: 1 });
  });

  it("does NOT apply quest-scope grants", () => {
    const state = stateWithOwnedProducts({ "hero-02": [3] }); // Boots (quest-scope)
    applyShopGrantsForWave(state);
    // hero-02 doesn't start with Boots and the wave pass skipped
    // the quest-scope grant — table entry remains undefined.
    expect(state.equipmentRanks["hero-02"]!.Boots ?? 0).toBe(0);
  });
});

// --- Wave-retry interaction ------------------------------------------------

// Regression (found 2026-07-20 alongside the Boots first-gain fix):
// `resetWaveForRetry` used to clear the quest from
// `shopGrantsAppliedQuests`, so the next `ensureEncounter` re-fired
// EVERY quest grant — stacking rank bumps (Boots R1 -> R2 -> ...) and
// damage bonuses (+1 LIGHT -> +2 -> ...) on each retry. Retry must
// re-grant ONLY the wiped consumable-token starters.
describe("wave retry does NOT stack quest grants", () => {
  it("rank bump / damage bonus stay flat across retry; consumable tokens are restored", () => {
    const state = stateWithOwnedProducts({
      "hero-02": [3, 4, 5], // Boots (rank bump) + Reroll x2 (tokens) + +1 LIGHT (damage bonus)
    });
    state.currentQuestId = "quest2";
    const quest2 = getQuestData("quest2");

    ensureEncounter(state, quest2, pinnedHooks);
    expect(state.equipmentRanks["hero-02"]!.Boots).toBe(1);
    expect(state.loadouts["hero-02"]!.baseMovement).toBe(2);
    expect(state.shopDamageBonus["hero-02"]!.light).toBe(1);
    expect(state.consumableTokens["hero-02"]!.reroll?.available).toBe(2);

    // Defeat -> Try Again -> fresh bootstrap.
    resetWaveForRetry(state);
    ensureEncounter(state, quest2, pinnedHooks);

    // NOT stacked:
    expect(state.equipmentRanks["hero-02"]!.Boots).toBe(1);
    expect(state.shopDamageBonus["hero-02"]!.light).toBe(1);
    // Restored (bag was wiped by the retry):
    expect(state.consumableTokens["hero-02"]!.reroll?.available).toBe(2);
    // Boots floor survives the retry via reapplyOwnedPassiveImmediates.
    expect(state.loadouts["hero-02"]!.baseMovement).toBe(2);
    expect(state.loadouts["hero-02"]!.currentMovement).toBe(2);
  });

  it("retry twice — still flat", () => {
    const state = stateWithOwnedProducts({ "hero-02": [3, 5] });
    state.currentQuestId = "quest2";
    const quest2 = getQuestData("quest2");
    ensureEncounter(state, quest2, pinnedHooks);
    resetWaveForRetry(state);
    ensureEncounter(state, quest2, pinnedHooks);
    resetWaveForRetry(state);
    ensureEncounter(state, quest2, pinnedHooks);
    expect(state.equipmentRanks["hero-02"]!.Boots).toBe(1);
    expect(state.shopDamageBonus["hero-02"]!.light).toBe(1);
  });
});

// --- endQuestReset interaction -------------------------------------------

describe("endQuestReset preserves shop ownership while wiping shop-applied state", () => {
  it("resets shopDamageBonus per delver but preserves shopProductsOwned", () => {
    const state = stateWithOwnedProducts({ "hero-02": [5, 9] }); // +1 light, +2 medium
    state.quest1Completed = true; // endQuestReset asserts no quest2 stuff yet
    applyShopGrantsForQuest(state, "quest1");
    expect(state.shopDamageBonus["hero-02"]!.light).toBe(1);
    expect(state.shopDamageBonus["hero-02"]!.medium).toBe(2);
    endQuestReset(state);
    expect(state.shopDamageBonus["hero-02"]).toEqual({});
    expect(state.shopProductsOwned["hero-02"]).toEqual([5, 9]);
  });
});

// --- ensureEncounter wires both scopes -----------------------------------

describe("ensureEncounter applies both quest and wave grants on fresh build", () => {
  it("running ensureEncounter on a Q2 W1 cold-start applies quest + wave grants in one shot", () => {
    const state = stateWithOwnedProducts({
      "hero-02": [3, 6], // Boots (quest-scope) + Fire token (wave-scope)
    });
    state.currentQuestId = "quest2";
    state.encounter = null;
    const quest2 = getQuestData("quest2");
    ensureEncounter(state, quest2, pinnedHooks);
    // hero-02 doesn't start with Boots (Gauntlet / Sword / Armor
    // are the printed starters), so the +1 grant lands them at R1.
    expect(state.equipmentRanks["hero-02"]!.Boots).toBe(1);
    expect(state.elements["hero-02"]!.fire).toBe(1);
    // Idempotency ledger is now stamped.
    expect(state.shopGrantsAppliedQuests).toContain("quest2");
  });

  it("does NOT re-apply quest grants on a second ensureEncounter for the same quest", () => {
    const state = stateWithOwnedProducts({ "hero-02": [3] });
    state.currentQuestId = "quest2";
    state.encounter = null;
    const quest2 = getQuestData("quest2");
    ensureEncounter(state, quest2, pinnedHooks);
    const rankAfterFirst = state.equipmentRanks["hero-02"]!.Boots;
    state.encounter = null; // simulate retry / rebuild
    ensureEncounter(state, quest2, pinnedHooks);
    expect(state.equipmentRanks["hero-02"]!.Boots).toBe(rankAfterFirst);
  });

  it("DOES re-apply wave grants on every fresh encounter build (retry case)", () => {
    const state = stateWithOwnedProducts({ "hero-02": [6] });
    state.currentQuestId = "quest2";
    state.encounter = null;
    const quest2 = getQuestData("quest2");
    ensureEncounter(state, quest2, pinnedHooks);
    expect(state.elements["hero-02"]!.fire).toBe(1);
    state.encounter = null; // simulate retry
    ensureEncounter(state, quest2, pinnedHooks);
    expect(state.elements["hero-02"]!.fire).toBe(2);
  });
});

// --- Helpers --------------------------------------------------------------

/**
 * Spin up a clean campaign and back-fill `shopProductsOwned` so the
 * grant pipeline has something to iterate over. Test scaffolding —
 * sidesteps the `purchaseShopProduct` cost validation path which is
 * a separate concern covered by `townVisit.test.ts`.
 */
function stateWithOwnedProducts(ownership: Record<string, number[]>): CampaignState {
  const state = newCampaign();
  for (const [heroId, nums] of Object.entries(ownership)) {
    state.shopProductsOwned[heroId] = nums;
  }
  return state;
}
