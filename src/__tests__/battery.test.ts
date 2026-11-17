/**
 * Tests for the Battery equipment family + the consumable token
 * kinds it underwrites: Reroll / Block Counterattack (rulebook
 * p15-16; DESIGN.md §5.4 Battery + §5.5.2 Consumable tokens).
 *
 * Both Battery R1 cards (Mind: Core Booster Battery; Body: Lucky
 * Battery) ship the same engine piece:
 *   - `effects: [{ kind: "immediately-equipment-roll" }]`
 * but with DIFFERENT per-card outcome tables (Mind grants AP or
 * Block Counterattack; Body grants AP or Reroll). The 5-6 die face is
 * "your choice" between the two printed outcomes for that card
 * (matches the Supercharger pattern).
 *
 * AP unification (2026-05-09): Battery's "AP" outcome no longer
 * grants an AP consumable token (the kind doesn't exist any more
 * — see `state.ts > ConsumableTokenKind` jsdoc). Instead it
 * permanently bumps the recipient's `loadout.baseAp` (and tops up
 * `currentAp` so the bonus is usable THIS wave) via
 * `EquipmentRollOutcome.baseApDelta`. The +1 then naturally
 * refreshes every Wave at End Wave alongside the rest of the AP
 * pool.
 *
 * Coverage:
 *   1. equipment.json shape — both R1 cards have the new effect kind.
 *   2. EQUIPMENT_ROLL_TABLES entries for both Battery cards (right
 *      grants, right rollMap).
 *   3. `outcomeForRoll` correctly maps 1-2 / 3-4 / 5-6 for both.
 *   4. `applyEquipmentRoll` for Battery grants the right kinds AND
 *      bumps baseAp/currentAp for the AP outcome.
 *   5. `applyLevelUpChoice` enqueues one roll PER RANK gained
 *      (first gain AND rank-ups; Ultra +2 = two rolls).
 *   6. Reroll spend gating (`canSpendReroll`, no per-turn cap).
 *   7. Block Counterattack spend gating (`canSpendPreventCounter`,
 *      no per-turn cap).
 *   8. Per-kind independence — the DD cap doesn't latch the others
 *      and vice versa.
 *   9. End Wave refresh covers Reroll / Block Counterattack.
 *  10. No per-turn cap on Reroll / Block Counterattack (designer
 *      decision 2026-11-17), for either delver.
 */

import { describe, it, expect } from "vitest";

import {
  newCampaign,
  type CampaignState,
} from "../state";
import { QUEST1, getEquipment } from "../data";
import { ensureEncounter } from "../engine/encounter";
import {
  endHeroTurn,
  startHeroTurn,
} from "../engine/turn";
import { enterEndOfWave } from "../engine/wave";
import { applyLevelUpChoice } from "../engine/levelUp";
import {
  applyEquipmentRoll,
  applyEquipmentRollsForQuest,
  canSpendDoubleDamage,
  canSpendPreventCounter,
  canSpendReroll,
  enqueueEquipmentRoll,
  EQUIPMENT_ROLL_TABLES,
  equipmentRollTableForCard,
  grantToken,
  hasPendingEquipmentRolls,
  outcomeForRoll,
  peekNextPendingEquipmentRoll,
  refreshAllSpentTokens,
  spendToken,
  tokenAvailable,
  tokenSpent,
} from "../engine/tokens";

const BATTERY_MIND = "mind-battery-r1";
const BATTERY_BODY = "body-battery-r1";

// =====================================================================
// Per-rank benefit rolls (designer ruling 2026-07-20)
//
// Regression for the user report: "+1 Battery from an Ultra Level
// card didn't ask for a dice roll". Every printed rank card R1-R5
// carries the IMMEDIATELY roll text, so EACH rank gained grants one
// benefit roll — rank-ups included, and an Ultra +2 grants two.
// Pre-fix, only the first gain (R0 -> R1) ever enqueued a roll.
// =====================================================================

/** Standard test arena: encounter ready, both delvers placed, no enemies. */
function arena(): CampaignState {
  const state = newCampaign();
  ensureEncounter(state, QUEST1);
  state.encounter!.enemies = [];
  state.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
  state.encounter!.delverPositions["hero-02"] = { x: 0, y: 0 };
  startHeroTurn(state);
  return state;
}

// =====================================================================
// 1. Equipment data shape
// =====================================================================

describe("Battery equipment data", () => {
  it("Mind (Core Booster) Battery R1 carries `immediately-equipment-roll`", () => {
    const card = getEquipment(BATTERY_MIND);
    expect(card.category).toBe("passive");
    expect(card.type).toBe("Battery");
    expect(card.suit).toBe("mind");
    expect(card.effects ?? []).toEqual([{ kind: "immediately-equipment-roll" }]);
  });

  it("Body (Lucky) Battery R1 carries `immediately-equipment-roll`", () => {
    const card = getEquipment(BATTERY_BODY);
    expect(card.category).toBe("passive");
    expect(card.type).toBe("Battery");
    expect(card.suit).toBe("body");
    expect(card.effects ?? []).toEqual([{ kind: "immediately-equipment-roll" }]);
  });
});

// =====================================================================
// 2. EQUIPMENT_ROLL_TABLES entries for Battery
// =====================================================================

describe("EQUIPMENT_ROLL_TABLES — Battery entries", () => {
  it("Mind Battery: 2 outcomes (+1 baseAp, Block Counterattack); 1-2 → +AP, 3-4 → Prevent, 5-6 → choice", () => {
    const t = EQUIPMENT_ROLL_TABLES[BATTERY_MIND];
    expect(t).toBeDefined();
    expect(t!.outcomes).toHaveLength(2);
    // Outcome 1 is the +1 baseAp bump (no consumable grants).
    expect(t!.outcomes[0]!.grants).toEqual({});
    expect(t!.outcomes[0]!.baseApDelta).toBe(1);
    // Outcome 2 stays a normal consumable grant.
    expect(t!.outcomes[1]!.grants).toEqual({ "prevent-counterattack": 1 });
    expect(t!.outcomes[1]!.baseApDelta).toBeUndefined();
    expect(t!.rollMap).toEqual([1, 1, 2, 2, "choice", "choice"]);
  });

  it("Body Battery: 2 outcomes (+1 baseAp, Reroll x2); 1-2 → +AP, 3-4 → Reroll, 5-6 → choice", () => {
    const t = EQUIPMENT_ROLL_TABLES[BATTERY_BODY];
    expect(t).toBeDefined();
    expect(t!.outcomes).toHaveLength(2);
    expect(t!.outcomes[0]!.grants).toEqual({});
    expect(t!.outcomes[0]!.baseApDelta).toBe(1);
    expect(t!.outcomes[1]!.grants).toEqual({ "reroll": 2 });
    expect(t!.outcomes[1]!.baseApDelta).toBeUndefined();
    expect(t!.rollMap).toEqual([1, 1, 2, 2, "choice", "choice"]);
  });

  it("equipmentRollTableForCard returns null for cards without a table", () => {
    expect(equipmentRollTableForCard("mind-hammer-r1")).toBeNull();
    expect(equipmentRollTableForCard("body-sword-r1")).toBeNull();
  });
});

// =====================================================================
// 3. outcomeForRoll across the printed mapping
// =====================================================================

describe("outcomeForRoll for Battery", () => {
  it("Mind Battery: rolls 1, 2 → AP-bump outcome; 3, 4 → Prevent outcome", () => {
    const t = equipmentRollTableForCard(BATTERY_MIND)!;
    expect(outcomeForRoll(t, 1)).toEqual(t.outcomes[0]); // +1 baseAp
    expect(outcomeForRoll(t, 2)).toEqual(t.outcomes[0]);
    expect(outcomeForRoll(t, 3)).toEqual(t.outcomes[1]); // Prevent
    expect(outcomeForRoll(t, 4)).toEqual(t.outcomes[1]);
  });

  it("Mind Battery: rolls 5, 6 return 'choice'", () => {
    const t = equipmentRollTableForCard(BATTERY_MIND)!;
    expect(outcomeForRoll(t, 5)).toBe("choice");
    expect(outcomeForRoll(t, 6)).toBe("choice");
  });

  it("Body Battery: rolls 1, 2 → AP-bump outcome; 3, 4 → Reroll outcome", () => {
    const t = equipmentRollTableForCard(BATTERY_BODY)!;
    expect(outcomeForRoll(t, 1)).toEqual(t.outcomes[0]);
    expect(outcomeForRoll(t, 2)).toEqual(t.outcomes[0]);
    expect(outcomeForRoll(t, 3)).toEqual(t.outcomes[1]); // Reroll x2
    expect(outcomeForRoll(t, 4)).toEqual(t.outcomes[1]);
  });

  it("Body Battery: out-of-range rolls return null (defensive)", () => {
    const t = equipmentRollTableForCard(BATTERY_BODY)!;
    expect(outcomeForRoll(t, 0)).toBeNull();
    expect(outcomeForRoll(t, 7)).toBeNull();
  });
});

// =====================================================================
// 4. applyEquipmentRoll for Battery grants the right kinds (and bumps AP)
// =====================================================================

describe("applyEquipmentRoll for Battery", () => {
  it("Mind Battery outcome 1 (AP): bumps baseAp AND currentAp by 1", () => {
    const state = arena();
    const lo = state.loadouts["hero-01"]!;
    const startBase = lo.baseAp;
    const startCur = lo.currentAp;

    enqueueEquipmentRoll(state, "hero-01", BATTERY_MIND);
    const t = equipmentRollTableForCard(BATTERY_MIND)!;
    applyEquipmentRoll(state, "hero-01", t.outcomes[0]!);

    expect(lo.baseAp).toBe(startBase + 1);
    expect(lo.currentAp).toBe(startCur + 1);
    // No consumable side-effects.
    expect(tokenAvailable(state, "hero-01", "prevent-counterattack")).toBe(0);
    expect(hasPendingEquipmentRolls(state)).toBe(false);
  });

  it("Mind Battery outcome 2 (Prevent): grants 1 Block Counterattack token, AP untouched", () => {
    const state = arena();
    const lo = state.loadouts["hero-01"]!;
    const startBase = lo.baseAp;
    const startCur = lo.currentAp;

    enqueueEquipmentRoll(state, "hero-01", BATTERY_MIND);
    const t = equipmentRollTableForCard(BATTERY_MIND)!;
    applyEquipmentRoll(state, "hero-01", t.outcomes[1]!);

    expect(tokenAvailable(state, "hero-01", "prevent-counterattack")).toBe(1);
    expect(lo.baseAp).toBe(startBase);
    expect(lo.currentAp).toBe(startCur);
  });

  it("Body Battery outcome 1 (AP): bumps baseAp AND currentAp by 1", () => {
    const state = arena();
    const lo = state.loadouts["hero-02"]!;
    const startBase = lo.baseAp;
    const startCur = lo.currentAp;

    enqueueEquipmentRoll(state, "hero-02", BATTERY_BODY);
    const t = equipmentRollTableForCard(BATTERY_BODY)!;
    applyEquipmentRoll(state, "hero-02", t.outcomes[0]!);

    expect(lo.baseAp).toBe(startBase + 1);
    expect(lo.currentAp).toBe(startCur + 1);
    expect(tokenAvailable(state, "hero-02", "reroll")).toBe(0);
  });

  it("Body Battery outcome 2 (Reroll): grants TWO Reroll tokens", () => {
    const state = arena();
    enqueueEquipmentRoll(state, "hero-02", BATTERY_BODY);
    const t = equipmentRollTableForCard(BATTERY_BODY)!;
    applyEquipmentRoll(state, "hero-02", t.outcomes[1]!);
    expect(tokenAvailable(state, "hero-02", "reroll")).toBe(2);
  });

  it("two Battery rolls stacked drain in FIFO order", () => {
    const state = arena();
    const lo = state.loadouts["hero-01"]!;
    const startBase = lo.baseAp;

    enqueueEquipmentRoll(state, "hero-01", BATTERY_MIND);
    enqueueEquipmentRoll(state, "hero-01", BATTERY_MIND);
    expect(state.encounter!.pendingEquipmentRolls).toHaveLength(2);
    const t = equipmentRollTableForCard(BATTERY_MIND)!;
    applyEquipmentRoll(state, "hero-01", t.outcomes[0]!); // +1 AP
    applyEquipmentRoll(state, "hero-01", t.outcomes[1]!); // Prevent
    expect(state.encounter!.pendingEquipmentRolls).toHaveLength(0);
    expect(lo.baseAp).toBe(startBase + 1);
    expect(tokenAvailable(state, "hero-01", "prevent-counterattack")).toBe(1);
  });

  it("AP-bump outcome persists across waves (End Wave refresh hits the new ceiling)", () => {
    const state = arena();
    const lo = state.loadouts["hero-01"]!;
    const startBase = lo.baseAp;

    enqueueEquipmentRoll(state, "hero-01", BATTERY_MIND);
    const t = equipmentRollTableForCard(BATTERY_MIND)!;
    applyEquipmentRoll(state, "hero-01", t.outcomes[0]!);
    expect(lo.baseAp).toBe(startBase + 1);

    // Burn down currentAp; End Wave should refresh to the BUMPED baseAp.
    lo.currentAp = 0;
    enterEndOfWave(state, "victory");

    expect(lo.currentAp).toBe(startBase + 1);
    expect(lo.baseAp).toBe(startBase + 1);
  });

  it("enqueueEquipmentRoll throws on a card with no registered table (data bug guard)", () => {
    const state = arena();
    expect(() => enqueueEquipmentRoll(state, "hero-01", "mind-hammer-r1"))
      .toThrowError(/no registered roll table/);
  });
});

// =====================================================================
// 5. applyLevelUpChoice triggers the queue (Battery first-gain)
// =====================================================================

describe("applyLevelUpChoice — Battery first-gain enqueue", () => {
  it("first-time gain (R0 -> R1) enqueues a pending equipment roll for Battery", () => {
    const state = arena();
    // levelup_01 has Battery in its 3 choices.
    state.encounter!.pendingLevelUpDraws = [
      { heroId: "hero-01", cardNumber: 1 },
    ];
    expect(hasPendingEquipmentRolls(state)).toBe(false);

    const r = applyLevelUpChoice(state, "Battery");

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.newRank).toBe(1);
    const head = peekNextPendingEquipmentRoll(state);
    expect(head).toEqual({ heroId: "hero-01", cardId: BATTERY_MIND });
  });

  it("rank-up (R1 -> R2) ALSO enqueues one roll (designer ruling 2026-07-20: 1 benefit per rank)", () => {
    const state = arena();
    // Pre-bump to R1 so the next pick is a rank-up, not a first-gain.
    state.equipmentRanks["hero-01"]!.Battery = 1;
    state.encounter!.pendingLevelUpDraws = [
      { heroId: "hero-01", cardNumber: 1 },
    ];

    const r = applyLevelUpChoice(state, "Battery");

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.newRank).toBe(2);
    expect(peekNextPendingEquipmentRoll(state)).toEqual({
      heroId: "hero-01",
      cardId: BATTERY_MIND,
    });
    expect(state.encounter!.pendingEquipmentRolls).toHaveLength(1);
  });
});

// =====================================================================
// 6. Reroll spend gating
// =====================================================================

describe("canSpendReroll", () => {
  it("returns ok=false when no Reroll tokens", () => {
    const state = arena();
    const r = canSpendReroll(state, "hero-01");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no Reroll tokens/);
  });

  it("returns ok=true when at least one available + cap not latched", () => {
    const state = arena();
    grantToken(state, "hero-01", "reroll", 2);
    expect(canSpendReroll(state, "hero-01").ok).toBe(true);
  });

  it("returns ok=true even after spending one this turn (no per-turn cap on Rerolls)", () => {
    // Reroll has NO per-turn cap (nor does Block Counterattack —
    // designer decision 2026-11-17). Players may reroll as many
    // times as they have tokens.
    const state = arena();
    grantToken(state, "hero-01", "reroll", 2);
    expect(spendToken(state, "hero-01", "reroll")).toBe(true);
    const r = canSpendReroll(state, "hero-01");
    expect(r.ok).toBe(true);
    // Token bag: 1 spent, 1 still available (the cap-removed branch
    // would happily let the player spend the second one too).
    expect(tokenAvailable(state, "hero-01", "reroll")).toBe(1);
    expect(tokenSpent(state, "hero-01", "reroll")).toBe(1);
  });

  it("returns ok=false once all Reroll tokens have been spent (the bag empties)", () => {
    // The only gate that ever flips Reroll back to not-spendable is
    // running out of tokens. Spend both, then the check fails on
    // `tokenAvailable <= 0`.
    const state = arena();
    grantToken(state, "hero-01", "reroll", 2);
    expect(spendToken(state, "hero-01", "reroll")).toBe(true);
    expect(spendToken(state, "hero-01", "reroll")).toBe(true);
    const r = canSpendReroll(state, "hero-01");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no Reroll tokens/);
    expect(tokenAvailable(state, "hero-01", "reroll")).toBe(0);
    expect(tokenSpent(state, "hero-01", "reroll")).toBe(2);
  });
});

// =====================================================================
// 7. Block Counterattack spend gating
// =====================================================================

describe("canSpendPreventCounter", () => {
  it("returns ok=false when no tokens", () => {
    const state = arena();
    const r = canSpendPreventCounter(state, "hero-01");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no Block Counterattack tokens/);
  });

  it("returns ok=true when at least one available + cap not latched", () => {
    const state = arena();
    grantToken(state, "hero-01", "prevent-counterattack", 1);
    expect(canSpendPreventCounter(state, "hero-01").ok).toBe(true);
  });

  it("returns ok=true after spending one this turn (no per-turn cap)", () => {
    const state = arena();
    grantToken(state, "hero-01", "prevent-counterattack", 2);
    expect(spendToken(state, "hero-01", "prevent-counterattack")).toBe(true);
    const r = canSpendPreventCounter(state, "hero-01");
    expect(r.ok).toBe(true);
  });

  it("returns ok=false when no tokens are available", () => {
    const state = arena();
    const r = canSpendPreventCounter(state, "hero-01");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no Block Counterattack tokens available/);
  });
});

// =====================================================================
// 8. Per-kind independence
// =====================================================================

describe("Spending one kind doesn't block the others", () => {
  it("spending Reroll does NOT block subsequent Prevent / DD spends", () => {
    const state = arena();
    grantToken(state, "hero-01", "reroll", 1);
    grantToken(state, "hero-01", "prevent-counterattack", 1);
    grantToken(state, "hero-01", "damage-2x-light", 1);

    expect(spendToken(state, "hero-01", "reroll")).toBe(true);

    expect(canSpendPreventCounter(state, "hero-01").ok).toBe(true);
    expect(canSpendDoubleDamage(state, "hero-01", "damage-2x-light").ok).toBe(true);
    expect(canSpendReroll(state, "hero-01").ok).toBe(false); // the only Reroll is spent
  });

  it("spending DD does NOT block Reroll / Prevent spends", () => {
    const state = arena();
    grantToken(state, "hero-01", "damage-2x-light", 1);
    grantToken(state, "hero-01", "reroll", 1);

    expect(spendToken(state, "hero-01", "damage-2x-light")).toBe(true);
    // DD cap (across the family) latched.
    expect(state.encounter!.turnState["hero-01"]!.damage2xUsedThisTurn).toBe(true);

    // Other kinds unaffected.
    expect(canSpendReroll(state, "hero-01").ok).toBe(true);
  });
});

// =====================================================================
// 9. End Wave refresh covers the surviving Battery kinds
// =====================================================================

describe("End Wave refreshes Battery-granted token kinds", () => {
  it("Reroll / Block Counterattack spent tokens flip back to available", () => {
    const state = arena();
    grantToken(state, "hero-01", "reroll", 3);
    grantToken(state, "hero-01", "prevent-counterattack", 1);

    spendToken(state, "hero-01", "reroll");
    spendToken(state, "hero-01", "prevent-counterattack");

    expect(tokenAvailable(state, "hero-01", "reroll")).toBe(2);
    expect(tokenSpent(state, "hero-01", "reroll")).toBe(1);
    expect(tokenAvailable(state, "hero-01", "prevent-counterattack")).toBe(0);
    expect(tokenSpent(state, "hero-01", "prevent-counterattack")).toBe(1);

    refreshAllSpentTokens(state);

    expect(tokenAvailable(state, "hero-01", "reroll")).toBe(3);
    expect(tokenSpent(state, "hero-01", "reroll")).toBe(0);
    expect(tokenAvailable(state, "hero-01", "prevent-counterattack")).toBe(1);
    expect(tokenSpent(state, "hero-01", "prevent-counterattack")).toBe(0);
  });

  it("the End Wave refresh reports the count of refreshed tokens (across kinds)", () => {
    const state = arena();
    grantToken(state, "hero-01", "reroll", 1);
    grantToken(state, "hero-02", "prevent-counterattack", 1);
    spendToken(state, "hero-01", "reroll");
    spendToken(state, "hero-02", "prevent-counterattack");

    enterEndOfWave(state, "victory");

    expect(state.encounter!.endWaveRefresh!.consumableTokensRefreshed).toBe(2);
  });
});

// =====================================================================
// 10. No per-turn cap on Reroll / Block Counterattack
// =====================================================================

describe("No per-turn cap on Reroll / Block Counterattack (designer decision 2026-11-17)", () => {
  it("one delver can spend several of each kind in the same turn", () => {
    const state = arena();
    grantToken(state, "hero-01", "reroll", 3);
    grantToken(state, "hero-01", "prevent-counterattack", 3);
    for (let i = 0; i < 3; i++) {
      expect(canSpendReroll(state, "hero-01").ok).toBe(true);
      expect(spendToken(state, "hero-01", "reroll")).toBe(true);
      expect(canSpendPreventCounter(state, "hero-01").ok).toBe(true);
      expect(spendToken(state, "hero-01", "prevent-counterattack")).toBe(true);
    }
    expect(canSpendReroll(state, "hero-01").ok).toBe(false); // bag empty
    expect(canSpendPreventCounter(state, "hero-01").ok).toBe(false);
  });

  it("the other delver can spend their own tokens during this delver's turn", () => {
    const state = arena();
    expect(state.currentDelverId).toBe("hero-01");
    grantToken(state, "hero-02", "reroll", 2);
    expect(spendToken(state, "hero-02", "reroll")).toBe(true);
    expect(canSpendReroll(state, "hero-02").ok).toBe(true);
    expect(spendToken(state, "hero-02", "reroll")).toBe(true);
  });

  it("the Double Damage 1-per-turn cap still applies and resets on a new turn", () => {
    const state = arena();
    grantToken(state, "hero-01", "damage-2x-light", 2);
    expect(spendToken(state, "hero-01", "damage-2x-light")).toBe(true);
    expect(canSpendDoubleDamage(state, "hero-01", "damage-2x-light").ok).toBe(false);
    endHeroTurn(state);
    endHeroTurn(state);
    expect(state.currentDelverId).toBe("hero-01");
    expect(canSpendDoubleDamage(state, "hero-01", "damage-2x-light").ok).toBe(true);
  });
});

// =====================================================================
// Per-rank benefit rolls — see header note above the constants.
// =====================================================================

describe("equipment rolls are granted PER RANK gained", () => {
  it("first gain (R0 -> R1) via Level-Up enqueues exactly one roll", () => {
    const state = arena();
    state.encounter!.pendingEquipmentRolls = [];
    // Card 1 lists [Gauntlet, Battery, Harvester].
    state.encounter!.pendingLevelUpDraws.push({ heroId: "hero-02", cardNumber: 1 });
    const r = applyLevelUpChoice(state, "Battery");
    expect(r.ok).toBe(true);
    expect(state.encounter!.pendingEquipmentRolls).toEqual([
      { heroId: "hero-02", cardId: BATTERY_BODY },
    ]);
  });

  it("Ultra passive pick (+1) on owned Battery enqueues one roll (the reported case)", () => {
    const state = arena();
    state.encounter!.pendingEquipmentRolls = [];
    state.equipmentRanks["hero-02"]!.Battery = 1;
    // Card 32 is an Ultra listing [Hammer, Trident]; Battery is legal
    // as the "+1 any passive" pick.
    state.encounter!.pendingLevelUpDraws.push({ heroId: "hero-02", cardNumber: 32 });
    const r = applyLevelUpChoice(state, "Battery");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.newRank).toBe(2);
    expect(state.encounter!.pendingEquipmentRolls).toHaveLength(1);
  });

  it("Ultra printed-type +2 (Supercharger, R0 -> R2) enqueues TWO rolls", () => {
    const state = arena();
    state.encounter!.pendingEquipmentRolls = [];
    // Card 30 is an Ultra listing [Boots, Supercharger] — printed
    // types bump +2.
    state.encounter!.pendingLevelUpDraws.push({ heroId: "hero-01", cardNumber: 30 });
    const r = applyLevelUpChoice(state, "Supercharger");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.newRank).toBe(2);
    expect(state.encounter!.pendingEquipmentRolls).toEqual([
      { heroId: "hero-01", cardId: "mind-supercharger-r1" },
      { heroId: "hero-01", cardId: "mind-supercharger-r1" },
    ]);
  });

  it("quest-start re-fire enqueues one roll PER OWNED RANK (Battery R2 = 2 rolls)", () => {
    const state = arena();
    state.encounter!.pendingEquipmentRolls = [];
    state.equipmentRanks["hero-02"]!.Battery = 2;
    applyEquipmentRollsForQuest(state, "per-rank-refire-test");
    const rolls = state.encounter!.pendingEquipmentRolls.filter(
      (p) => p.cardId === BATTERY_BODY,
    );
    expect(rolls).toHaveLength(2);
  });
});
