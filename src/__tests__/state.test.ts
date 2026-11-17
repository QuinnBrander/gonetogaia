/**
 * Tests for src/state.ts campaign initialization, especially the
 * IMMEDIATELY-effect application from starting passives (DESIGN.md §5.8).
 */

import { describe, it, expect } from "vitest";

import {
  newCampaign,
  applyImmediatePassiveEffects,
  migrateV21ToV22,
  migrateV22ToV23,
  migrateV24ToV25,
  migrateV25ToV26,
  migrateV26ToV27,
  migrateV27ToV28,
  migrateV28ToV29,
  migrateV29ToV30,
  migrateV30ToV31,
  migrateV31ToV32,
  migrateV32ToV33,
  migrateV33ToV34,
  migrateV41ToV42,
  migrateV42ToV43,
  migrateV43ToV44,
  migrateV44ToV45,
  migrateV45ToV46,
  migrateV57ToV58,
  bossPartLevelForDropId,
  creditBossPartDrop,
  totalBossParts,
  SCHEMA_VERSION,
  type CampaignState,
  type DelverLoadout,
} from "../state";
import { Tuning } from "../config/tuning";
import { getEquipment } from "../data";

describe("newCampaign — starting passive IMMEDIATELY effects", () => {
  it("Mind delver (hero-01) has no IMMEDIATELY HP effects from starters", () => {
    const s = newCampaign();
    const lo = s.loadouts["hero-01"]!;
    expect(lo.maxHp).toBe(Tuning.startingHp);
    expect(lo.currentHp).toBe(Tuning.startingHp);
  });

  it("Body delver (hero-02) gets Exoframe Armor's set-max-hp + modify-current-hp", () => {
    const s = newCampaign();
    const lo = s.loadouts["hero-02"]!;
    // Exoframe Armor R1: max HP -> 9, current HP +3.
    expect(lo.maxHp).toBe(9);
    expect(lo.currentHp).toBe(9); // 6 base + 3 delta = 9, capped at the new max of 9
  });
});

describe("applyImmediatePassiveEffects", () => {
  function freshLoadout(): DelverLoadout {
    return {
      heroId: "test",
      slotCards: [],
      currentHp: Tuning.startingHp,
      maxHp: Tuning.startingHp,
      currentAp: Tuning.baseAp,
      baseAp: Tuning.baseAp,
      currentMovement: Tuning.startingMovement,
      baseMovement: Tuning.startingMovement,
    };
  }

  it("set-max-hp runs before modify-current-hp so the +3 clamps to the new ceiling", () => {
    const lo = freshLoadout();
    const exo = getEquipment("body-armor-r1");
    applyImmediatePassiveEffects(lo, [exo]);
    expect(lo.maxHp).toBe(9);
    expect(lo.currentHp).toBe(9);
  });

  it("ignores weapon cards entirely", () => {
    const lo = freshLoadout();
    const hammer = getEquipment("mind-hammer-r1"); // weapon
    applyImmediatePassiveEffects(lo, [hammer]);
    expect(lo.maxHp).toBe(Tuning.startingHp);
    expect(lo.currentHp).toBe(Tuning.startingHp);
  });

  it("ignores ONGOING-only passives (e.g. Sol Shield: block-on-tile)", () => {
    const lo = freshLoadout();
    const sol = getEquipment("mind-shield-r1");
    applyImmediatePassiveEffects(lo, [sol]);
    expect(lo.maxHp).toBe(Tuning.startingHp);
    expect(lo.currentHp).toBe(Tuning.startingHp);
  });

  it("clamps modify-current-hp to [0, maxHp]", () => {
    const lo = freshLoadout();
    lo.currentHp = lo.maxHp; // already at cap
    const exo = getEquipment("body-armor-r1");
    applyImmediatePassiveEffects(lo, [exo]);
    // Started at 6/6; now 9/9 (set max → 9; +3 clamped to 9).
    expect(lo.currentHp).toBe(9);
  });

  it("set-base-movement (Slip Strider Boots, Mind) raises baseMovement to 2 and bumps currentMovement to match", () => {
    const lo = freshLoadout();
    expect(lo.baseMovement).toBe(1);
    expect(lo.currentMovement).toBe(1);
    const boots = getEquipment("mind-boots-r1");
    applyImmediatePassiveEffects(lo, [boots]);
    expect(lo.baseMovement).toBe(2);
    expect(lo.currentMovement).toBe(2);
  });

  it("set-base-movement (Strider Boots, Body) same behavior at the body suit", () => {
    const lo = freshLoadout();
    const boots = getEquipment("body-boots-r1");
    applyImmediatePassiveEffects(lo, [boots]);
    expect(lo.baseMovement).toBe(2);
    expect(lo.currentMovement).toBe(2);
  });

  it("set-base-movement is only-up: a higher existing baseMovement is preserved", () => {
    const lo = freshLoadout();
    lo.baseMovement = 3;
    lo.currentMovement = 3;
    const boots = getEquipment("mind-boots-r1");
    applyImmediatePassiveEffects(lo, [boots]);
    expect(lo.baseMovement).toBe(3);
    expect(lo.currentMovement).toBe(3);
  });

  it("set-base-movement does NOT lower currentMovement that has already been spent", () => {
    const lo = freshLoadout();
    // Player spent their 1 movement this turn.
    lo.currentMovement = 0;
    const boots = getEquipment("mind-boots-r1");
    applyImmediatePassiveEffects(lo, [boots]);
    // baseMovement bumps to 2; currentMovement gets pulled UP to match
    // (max(0, 2) = 2). The movementUsedThisTurn gate still prevents a
    // second move this turn — that's a turn-state concern, not a stat
    // concern.
    expect(lo.baseMovement).toBe(2);
    expect(lo.currentMovement).toBe(2);
  });

  it("idempotent: re-applying the same boots card a second time is a no-op", () => {
    const lo = freshLoadout();
    const boots = getEquipment("mind-boots-r1");
    applyImmediatePassiveEffects(lo, [boots]);
    applyImmediatePassiveEffects(lo, [boots]);
    expect(lo.baseMovement).toBe(2);
    expect(lo.currentMovement).toBe(2);
  });
});

// AP unification migration (2026-05-09): v21 → v22 folds banked
// consumable AP tokens into the unified board-AP pool. Mapping:
//   baseAp += availableAp + spentAp
//   currentAp += availableAp
// Anything older than v21 is intentionally NOT covered (we
// fall through to a fresh campaign at the call-site).
describe("migrateV21ToV22 — AP fold", () => {
  /** Build a minimal v21-shaped CampaignState fixture. */
  function v21Save(opts: {
    h1Avail?: number;
    h1Spent?: number;
    h2Avail?: number;
    h2Spent?: number;
    h1Base?: number;
    h1Cur?: number;
    h2Base?: number;
    h2Cur?: number;
  }): unknown {
    const {
      h1Avail = 0, h1Spent = 0, h2Avail = 0, h2Spent = 0,
      h1Base = 3, h1Cur = 3, h2Base = 3, h2Cur = 3,
    } = opts;
    return {
      version: 21,
      loadouts: {
        "hero-01": { heroId: "hero-01", slotCards: [], currentHp: 6, maxHp: 6, currentAp: h1Cur, baseAp: h1Base, currentMovement: 1, baseMovement: 1 },
        "hero-02": { heroId: "hero-02", slotCards: [], currentHp: 9, maxHp: 9, currentAp: h2Cur, baseAp: h2Base, currentMovement: 1, baseMovement: 1 },
      },
      consumableTokens: {
        "hero-01": { ap: { available: h1Avail, spent: h1Spent } },
        "hero-02": { ap: { available: h2Avail, spent: h2Spent } },
      },
      encounter: null,
    };
  }

  it("folds available + spent AP tokens into baseAp; only available adds to currentAp", () => {
    const save = v21Save({ h1Avail: 2, h1Spent: 1, h1Base: 3, h1Cur: 2 });
    const out = migrateV21ToV22(save) as CampaignState;
    // v21 → v22 only bumps to 22; the chained loadCampaign() driver
    // hops onward to the current SCHEMA_VERSION via migrateV22ToV23.
    expect(out.version).toBe(22);
    const lo = out.loadouts["hero-01"]!;
    // baseAp: 3 + (2 available + 1 spent) = 6
    expect(lo.baseAp).toBe(6);
    // currentAp: 2 + 2 available = 4
    expect(lo.currentAp).toBe(4);
    // The bag entry for "ap" is gone.
    expect((out.consumableTokens["hero-01"] as Record<string, unknown>).ap).toBeUndefined();
  });

  it("treats both delvers independently (no cross-talk)", () => {
    const save = v21Save({
      h1Avail: 1, h1Spent: 0, h1Base: 3, h1Cur: 3,
      h2Avail: 0, h2Spent: 2, h2Base: 3, h2Cur: 1,
    });
    const out = migrateV21ToV22(save) as CampaignState;
    const lo1 = out.loadouts["hero-01"]!;
    const lo2 = out.loadouts["hero-02"]!;
    expect(lo1.baseAp).toBe(4);   // 3 + 1
    expect(lo1.currentAp).toBe(4); // 3 + 1
    expect(lo2.baseAp).toBe(5);   // 3 + 2
    expect(lo2.currentAp).toBe(1); // 1 + 0 (spent doesn't top up currentAp)
  });

  it("no-op when there's no `ap` bag entry (fresh delver mid-quest, never gained AP token)", () => {
    const out = migrateV21ToV22({
      version: 21,
      loadouts: {
        "hero-01": { heroId: "hero-01", slotCards: [], currentHp: 6, maxHp: 6, currentAp: 2, baseAp: 3, currentMovement: 1, baseMovement: 1 },
        "hero-02": { heroId: "hero-02", slotCards: [], currentHp: 9, maxHp: 9, currentAp: 3, baseAp: 3, currentMovement: 1, baseMovement: 1 },
      },
      consumableTokens: { "hero-01": {}, "hero-02": {} },
      encounter: null,
    }) as CampaignState;
    expect(out.version).toBe(22);
    expect(out.loadouts["hero-01"]!.baseAp).toBe(3);
    expect(out.loadouts["hero-01"]!.currentAp).toBe(2);
  });

  it("strips stale `consumableSpendsThisTurn.ap` latches from any in-progress encounter", () => {
    const save = {
      version: 21,
      loadouts: {
        "hero-01": { heroId: "hero-01", slotCards: [], currentHp: 6, maxHp: 6, currentAp: 3, baseAp: 3, currentMovement: 1, baseMovement: 1 },
        "hero-02": { heroId: "hero-02", slotCards: [], currentHp: 9, maxHp: 9, currentAp: 3, baseAp: 3, currentMovement: 1, baseMovement: 1 },
      },
      consumableTokens: { "hero-01": {}, "hero-02": {} },
      encounter: {
        turnState: {
          "hero-01": { consumableSpendsThisTurn: { ap: true, reroll: true } },
          "hero-02": { consumableSpendsThisTurn: { ap: true } },
        },
      },
    };
    const out = migrateV21ToV22(save) as CampaignState;
    // `consumableSpendsThisTurn` is an old-save field (gone from
    // HeroTurnState since v65), so read it through a cast.
    type OldTurnState = { consumableSpendsThisTurn: Record<string, boolean> };
    const ts1 = (out.encounter!.turnState["hero-01"] as unknown as OldTurnState).consumableSpendsThisTurn;
    const ts2 = (out.encounter!.turnState["hero-02"] as unknown as OldTurnState).consumableSpendsThisTurn;
    expect(ts1.ap).toBeUndefined();
    expect(ts1.reroll).toBe(true); // unrelated flags survive
    expect(ts2.ap).toBeUndefined();
  });

  it("returns null on malformed input (caller falls through to newCampaign)", () => {
    expect(migrateV21ToV22(null)).toBeNull();
    expect(migrateV21ToV22({})).toBeNull();
    expect(migrateV21ToV22({ version: 21, loadouts: null })).toBeNull();
  });
});

// movementStepsThisTurn backfill (2026-05-09): v22 → v23 adds the
// per-turn step counter to every existing HeroTurnState. The counter
// is what the BoardScreen reads to decide whether disarming the
// movement overlay is a free toggle (0 steps) or a session-ending
// commit (1+ steps). For an in-progress save we conservatively start
// at 0 — the player loses at most the "free disarm if I haven't
// stepped yet" affordance for the current turn.
describe("migrateV22ToV23 — movementStepsThisTurn backfill", () => {
  it("backfills movementStepsThisTurn = 0 on every turnState entry", () => {
    const save = {
      version: 22,
      encounter: {
        turnState: {
          "hero-01": {
            cardPlacedThisTurn: { slotIdx: 0, cardId: "x", autoRefreshedElement: null },
            actionUsedThisTurn: false,
            movementUsedThisTurn: false,
            apMovementDoubledThisTurn: false,
            damage2xUsedThisTurn: false,
          },
          "hero-02": {
            cardPlacedThisTurn: null,
            actionUsedThisTurn: true,
            movementUsedThisTurn: true,
            apMovementDoubledThisTurn: false,
            damage2xUsedThisTurn: false,
          },
        },
      },
    };
    const out = migrateV22ToV23(save) as CampaignState;
    // v22 -> v23 only bumps to 23; the chained loadCampaign() driver
    // hops onward to the current SCHEMA_VERSION via migrateV23ToV24.
    expect(out.version).toBe(23);
    expect(out.encounter!.turnState["hero-01"]!.movementStepsThisTurn).toBe(0);
    expect(out.encounter!.turnState["hero-02"]!.movementStepsThisTurn).toBe(0);
  });

  it("does NOT clobber an already-present movementStepsThisTurn value", () => {
    const save = {
      version: 22,
      encounter: {
        turnState: {
          "hero-01": {
            cardPlacedThisTurn: null,
            actionUsedThisTurn: false,
            movementUsedThisTurn: false,
            apMovementDoubledThisTurn: false,
            damage2xUsedThisTurn: false,
            movementStepsThisTurn: 3,
          },
        },
      },
    };
    const out = migrateV22ToV23(save) as CampaignState;
    expect(out.encounter!.turnState["hero-01"]!.movementStepsThisTurn).toBe(3);
  });

  it("is a no-op (and bumps version) when there's no encounter in progress", () => {
    const save = { version: 22, encounter: null };
    const out = migrateV22ToV23(save) as CampaignState;
    expect(out.version).toBe(23);
    expect(out.encounter).toBeNull();
  });

  it("returns null on malformed input (caller falls through to newCampaign)", () => {
    expect(migrateV22ToV23(null)).toBeNull();
  });
});

// v24 -> v25 backfills `actionGrantedExtraMovement = false` on every
// existing turnState entry. This is the carve-out flag for the
// action-gates-movement rule (DESIGN.md §5.1.2): when the action the
// player took was specifically `bonus-movement-this-turn`, the granted
// MP must remain spendable. For an in-progress save we conservatively
// default to false — the player loses at most the carve-out for the
// turn the save was taken on.
describe("migrateV24ToV25 — actionGrantedExtraMovement backfill", () => {
  it("backfills actionGrantedExtraMovement = false on every turnState entry", () => {
    const save = {
      version: 24,
      encounter: {
        turnState: {
          "hero-01": {
            cardPlacedThisTurn: { slotIdx: 0, cardId: "x", autoRefreshedElement: null },
            actionUsedThisTurn: false,
            movementUsedThisTurn: false,
            movementStepsThisTurn: 0,
            apMovementDoubledThisTurn: false,
            damage2xUsedThisTurn: false,
          },
          "hero-02": {
            cardPlacedThisTurn: null,
            actionUsedThisTurn: true,
            movementUsedThisTurn: true,
            movementStepsThisTurn: 1,
            apMovementDoubledThisTurn: false,
            damage2xUsedThisTurn: false,
          },
        },
      },
    };
    const out = migrateV24ToV25(save) as CampaignState;
    // v24 -> v25 only bumps to 25; the chained loadCampaign() driver
    // hops onward to SCHEMA_VERSION via migrateV25ToV26.
    expect(out.version).toBe(25);
    expect(out.encounter!.turnState["hero-01"]!.actionGrantedExtraMovement).toBe(false);
    expect(out.encounter!.turnState["hero-02"]!.actionGrantedExtraMovement).toBe(false);
  });

  it("does NOT clobber an already-present actionGrantedExtraMovement value", () => {
    const save = {
      version: 24,
      encounter: {
        turnState: {
          "hero-01": {
            cardPlacedThisTurn: null,
            actionUsedThisTurn: false,
            movementUsedThisTurn: false,
            movementStepsThisTurn: 0,
            apMovementDoubledThisTurn: false,
            actionGrantedExtraMovement: true,
            damage2xUsedThisTurn: false,
          },
        },
      },
    };
    const out = migrateV24ToV25(save) as CampaignState;
    expect(out.encounter!.turnState["hero-01"]!.actionGrantedExtraMovement).toBe(true);
  });

  it("is a no-op (and bumps version) when there's no encounter in progress", () => {
    const save = { version: 24, encounter: null };
    const out = migrateV24ToV25(save) as CampaignState;
    expect(out.version).toBe(25);
    expect(out.encounter).toBeNull();
  });

  it("returns null on malformed input (caller falls through to newCampaign)", () => {
    expect(migrateV24ToV25(null)).toBeNull();
  });
});

// v25 -> v26 backfills `unlockedHeroCards = [1, 2]` (the two playable
// starters). New field added 2026-05-18 to track which hero cards the
// campaign has unlocked via narrative beats. Existing v25 saves never
// fired Chapter 1 page 6's `unlock-hero-cards` action, so we only
// backfill the always-known starters — players mid- or post-Ch1 Town
// Visit on a v25 save won't see HERO #3/#4 retroactively unlocked
// without restarting from before page 6.
describe("migrateV25ToV26 — unlockedHeroCards backfill", () => {
  it("backfills unlockedHeroCards = [1, 2] on a fresh-looking v25 save", () => {
    const save = { version: 25, encounter: null };
    const out = migrateV25ToV26(save) as CampaignState;
    // v25 -> v26 only bumps to 26; the chained loadCampaign() driver
    // hops onward to SCHEMA_VERSION via migrateV26ToV27.
    expect(out.version).toBe(26);
    expect(out.unlockedHeroCards).toEqual([1, 2]);
  });

  it("does NOT clobber an already-present unlockedHeroCards list", () => {
    const save = { version: 25, encounter: null, unlockedHeroCards: [1, 2, 3, 4] };
    const out = migrateV25ToV26(save) as CampaignState;
    expect(out.unlockedHeroCards).toEqual([1, 2, 3, 4]);
  });

  it("returns null on malformed input (caller falls through to newCampaign)", () => {
    expect(migrateV25ToV26(null)).toBeNull();
  });
});

// v26 -> v27: backfill `keyItems = []` and `favour = {}`. Added 2026-05-18
// alongside the rest of the rewards hookup (memory chips, creature parts,
// shop products, key items, favour). Existing v26 saves never authored
// favour / key-item actions (they were silent record-decisions), so no
// data is reconstructed from `townDecisions` — only the empty containers
// are added so the new fields exist before the engine touches them.
describe("migrateV26ToV27 — keyItems + favour backfill", () => {
  it("backfills keyItems = [] and favour = {} on a fresh-looking v26 save", () => {
    const save = { version: 26, encounter: null };
    const out = migrateV26ToV27(save) as CampaignState;
    // v26 -> v27 only bumps to 27; the chained loadCampaign() driver
    // hops onward to SCHEMA_VERSION via migrateV27ToV28.
    expect(out.version).toBe(27);
    expect(out.keyItems).toEqual([]);
    expect(out.favour).toEqual({});
  });

  it("does NOT clobber pre-existing keyItems / favour entries (forward-compat)", () => {
    const save = {
      version: 26,
      encounter: null,
      keyItems: [{ number: 3, name: "Woo's Diary" }],
      favour: { xavier: { name: "Xavier", value: 1 } },
    };
    const out = migrateV26ToV27(save) as CampaignState;
    expect(out.keyItems).toEqual([{ number: 3, name: "Woo's Diary" }]);
    expect(out.favour).toEqual({ xavier: { name: "Xavier", value: 1 } });
  });

  it("replaces non-object / array-shaped favour values defensively", () => {
    // Garbage favour (someone hand-edited their save) gets reset to {}
    // so the engine's `state.favour[id]` indexing doesn't throw at
    // runtime on legitimate v27 actions.
    const save = { version: 26, encounter: null, favour: ["nope"] };
    const out = migrateV26ToV27(save) as CampaignState;
    expect(out.favour).toEqual({});
  });

  it("returns null on malformed input (caller falls through to newCampaign)", () => {
    expect(migrateV26ToV27(null)).toBeNull();
  });
});

// v27 -> v28 backfills `revealedQuests = []`. New field added 2026-05-18
// alongside the Quest #2 reveal-as-reward hookup — page14 of Chapter 1
// emits a `reveal-quest` action whose state impact is to append to this
// list. Existing v27 saves never saw a typed reveal-quest action (the
// equivalent narrative beat recorded a silent `ch1.quest2.unlocked`
// decision key); we leave that dotted-log entry in `townDecisions` but
// don't reconstruct `revealedQuests` from it (the key format is lossy).
describe("migrateV27ToV28 — revealedQuests backfill", () => {
  it("backfills revealedQuests = [] on a fresh-looking v27 save", () => {
    const save = { version: 27, encounter: null };
    const out = migrateV27ToV28(save) as CampaignState;
    // v27 -> v28 only bumps to 28; the chained loadCampaign() driver
    // hops onward to SCHEMA_VERSION via migrateV28ToV29.
    expect(out.version).toBe(28);
    expect(out.revealedQuests).toEqual([]);
  });

  it("does NOT clobber a pre-existing revealedQuests list (forward-compat)", () => {
    const save = {
      version: 27,
      encounter: null,
      revealedQuests: [{ number: 2, name: "The Surveillance Device" }],
    };
    const out = migrateV27ToV28(save) as CampaignState;
    expect(out.revealedQuests).toEqual([
      { number: 2, name: "The Surveillance Device" },
    ]);
  });

  it("replaces non-array revealedQuests defensively", () => {
    // Garbage shape (corrupt save / hand-edit) gets reset to [] so
    // the engine's `state.revealedQuests.some(...)` doesn't throw
    // at runtime on legitimate v28 actions.
    const save = { version: 27, encounter: null, revealedQuests: { 2: "nope" } };
    const out = migrateV27ToV28(save) as CampaignState;
    expect(out.revealedQuests).toEqual([]);
  });

  it("returns null on malformed input (caller falls through to newCampaign)", () => {
    expect(migrateV27ToV28(null)).toBeNull();
  });
});

// v28 -> v29 backfills `opinionCards = []`. New field added 2026-05-18
// alongside the Opinion Card hook-up — the `shift-favour` engine path
// now appends one `OpinionCardRecord` per NAMED level (DETRACTOR /
// ALLY / CONFIDANT / NEMESIS) the favour value crosses INTO. Existing
// v28 saves never tracked the gain list (the matching dotted-log
// rows in `townDecisions` are lossy), so we backfill `[]` and let
// future shifts populate the list normally.
describe("migrateV28ToV29 — opinionCards backfill", () => {
  it("backfills opinionCards = [] and bumps version to 29 (next migrator hops onward)", () => {
    const save = { version: 28, encounter: null };
    const out = migrateV28ToV29(save) as CampaignState;
    // v28 -> v29 only bumps to 29 (literal); chained loadCampaign()
    // continues to SCHEMA_VERSION via migrateV29ToV30. The literal
    // here ensures a future migrator (v29 -> v30 etc.) can't be
    // silently skipped if migrateV28ToV29 keeps using SCHEMA_VERSION.
    expect(out.version).toBe(29);
    expect(out.opinionCards).toEqual([]);
  });

  it("does NOT clobber a pre-existing opinionCards list (forward-compat)", () => {
    const save = {
      version: 28,
      encounter: null,
      opinionCards: [
        { characterId: "xavier", characterName: "Xavier", level: "ally" },
      ],
    };
    const out = migrateV28ToV29(save) as CampaignState;
    expect(out.opinionCards).toEqual([
      { characterId: "xavier", characterName: "Xavier", level: "ally" },
    ]);
  });

  it("replaces non-array opinionCards defensively", () => {
    // Garbage shape (corrupt save / hand-edit) gets reset to [] so
    // the engine's `state.opinionCards.some(...)` doesn't throw at
    // runtime on legitimate v29 actions.
    const save = { version: 28, encounter: null, opinionCards: { xavier: "ally" } };
    const out = migrateV28ToV29(save) as CampaignState;
    expect(out.opinionCards).toEqual([]);
  });

  it("returns null on malformed input (caller falls through to newCampaign)", () => {
    expect(migrateV28ToV29(null)).toBeNull();
  });
});

// v29 -> v30 backfills `currentQuestId = "quest1"`. New field added
// 2026-05-18 alongside the Q2 scaffolding — controls which quest's
// intro the Story screen renders and which quest BoardScreen builds
// an encounter for. Defaulting to `"quest1"` is correct because Q2
// progression doesn't ship until Phase B; the only path that sets
// `"quest2"` today is the Title's "Start from Quest 2 (debug)" button.
describe("migrateV29ToV30 — currentQuestId backfill", () => {
  it("backfills currentQuestId = 'quest1' on a fresh-looking v29 save", () => {
    const save = { version: 29, encounter: null };
    const out = migrateV29ToV30(save) as CampaignState;
    // v29->v30 graduates the save to exactly 30 (not SCHEMA_VERSION) so
    // future migrations chain step-wise. The full migration cascade is
    // exercised by the `loadCampaign` round-trip tests below.
    expect(out.version).toBe(30);
    expect(out.currentQuestId).toBe("quest1");
  });

  it("does NOT clobber a pre-existing currentQuestId (forward-compat)", () => {
    const save = { version: 29, encounter: null, currentQuestId: "quest2" };
    const out = migrateV29ToV30(save) as CampaignState;
    expect(out.currentQuestId).toBe("quest2");
  });

  it("replaces non-string currentQuestId defensively", () => {
    // Corrupt save / hand-edit: anything other than a string id
    // resets to "quest1" so Story / BoardScreen's `getQuestData`
    // lookup doesn't throw at runtime on a legitimate v30 path.
    const save = { version: 29, encounter: null, currentQuestId: 7 };
    const out = migrateV29ToV30(save) as CampaignState;
    expect(out.currentQuestId).toBe("quest1");
  });

  it("returns null on malformed input (caller falls through to newCampaign)", () => {
    expect(migrateV29ToV30(null)).toBeNull();
  });
});

// v30 -> v31 backfills `encounter.spawnCardDrawn = null`. New field
// added 2026-05-18 alongside the Phase B spawn-deck encounter path —
// records the Spawn Card a wave was bootstrapped from (1..14), or
// `null` for hand-authored waves (Q1).
describe("migrateV30ToV31 — spawnCardDrawn backfill", () => {
  it("graduates a fresh-looking v30 save to 31 (next migrator hops onward)", () => {
    const save = { version: 30, encounter: null };
    const out = migrateV30ToV31(save) as CampaignState;
    // v30 -> v31 only bumps to 31 (literal); chained loadCampaign()
    // continues to SCHEMA_VERSION via migrateV31ToV32. The literal
    // here ensures a future migrator can't be silently skipped.
    expect(out.version).toBe(31);
  });

  it("leaves encounter alone when there's no in-progress encounter", () => {
    const save = { version: 30, encounter: null };
    const out = migrateV30ToV31(save) as CampaignState;
    expect(out.encounter).toBeNull();
  });

  it("backfills spawnCardDrawn = null on an existing encounter", () => {
    // A v30 encounter could only have been hand-authored (Q1), so
    // `null` is the correct backfill — Q2/spawn-deck didn't ship
    // until v31.
    const save = {
      version: 30,
      encounter: { questId: "quest1", waveNumber: 1, enemies: [] },
    };
    const out = migrateV30ToV31(save) as CampaignState;
    expect((out.encounter as unknown as { spawnCardDrawn: number | null })?.spawnCardDrawn).toBeNull();
  });

  it("does NOT clobber a pre-existing spawnCardDrawn (forward-compat)", () => {
    const save = {
      version: 30,
      encounter: { questId: "quest2", waveNumber: 1, enemies: [], spawnCardDrawn: 7 },
    };
    const out = migrateV30ToV31(save) as CampaignState;
    expect((out.encounter as unknown as { spawnCardDrawn: number | null })?.spawnCardDrawn).toBe(7);
  });

  it("returns null on malformed input (caller falls through to newCampaign)", () => {
    expect(migrateV30ToV31(null)).toBeNull();
  });
});

// v31 -> v32 backfills `encounter.memoryFragments = []`. New field
// added 2026-05-18 alongside the Memory Fragment board-token
// surfacing — every Spawn Card with a printed diamond glyph seats
// one fragment at that tile on wave bootstrap. Backfill keeps
// existing in-progress encounters renderable (the render branch
// `.map`s `encounter.memoryFragments` and would throw otherwise).
describe("migrateV31ToV32 — memoryFragments backfill", () => {
  it("graduates a fresh-looking v31 save to v32 (one step at a time)", () => {
    const save = { version: 31, encounter: null };
    const out = migrateV31ToV32(save) as CampaignState;
    // Hard-coded `32` (not SCHEMA_VERSION) — each migration
    // graduates exactly one version so future migrations don't
    // accidentally let a v31 save skip later backfills.
    expect(out.version).toBe(32);
  });

  it("leaves encounter alone when there's no in-progress encounter", () => {
    const save = { version: 31, encounter: null };
    const out = migrateV31ToV32(save) as CampaignState;
    expect(out.encounter).toBeNull();
  });

  it("backfills memoryFragments = [] on an existing encounter", () => {
    const save = {
      version: 31,
      encounter: { questId: "quest1", waveNumber: 1, enemies: [] },
    };
    const out = migrateV31ToV32(save) as CampaignState;
    expect((out.encounter as unknown as { memoryFragments: unknown })?.memoryFragments).toEqual([]);
  });

  it("does NOT clobber a pre-existing memoryFragments list (forward-compat)", () => {
    const save = {
      version: 31,
      encounter: {
        questId: "quest2",
        waveNumber: 1,
        enemies: [],
        memoryFragments: [{ x: 3, y: 0 }],
      },
    };
    const out = migrateV31ToV32(save) as CampaignState;
    expect((out.encounter as unknown as { memoryFragments: Array<{ x: number; y: number }> }).memoryFragments)
      .toEqual([{ x: 3, y: 0 }]);
  });

  it("resets a non-array memoryFragments value defensively", () => {
    const save = {
      version: 31,
      encounter: {
        questId: "quest2",
        waveNumber: 1,
        enemies: [],
        memoryFragments: "garbage",
      },
    };
    const out = migrateV31ToV32(save) as CampaignState;
    expect((out.encounter as unknown as { memoryFragments: unknown }).memoryFragments).toEqual([]);
  });

  it("returns null on malformed input (caller falls through to newCampaign)", () => {
    expect(migrateV31ToV32(null)).toBeNull();
  });
});

// v32 -> v33 backfills the Shop Product Grant pipeline's two
// persistent fields:
//   - `shopDamageBonus[heroId]` — per-damage-type bonus accumulated
//     from "+1 LIGHT" / "+2 MEDIUM" / "+4 HEAVY" Quest-Bonus cards.
//     Combat reads this on every matching swing.
//   - `shopGrantsAppliedQuests` — idempotency ledger so reloading
//     mid-Q2 doesn't re-apply the same Trident rank bump etc.
describe("migrateV32ToV33 — shop-grant fields backfill", () => {
  // Note: this migration NO LONGER lands the save on SCHEMA_VERSION
  // directly — v34 (Chapter 2 town visit fields) shipped after v33
  // and pinned this step to "v33 produces a v33 save". The chained
  // `loadCampaign` flow then runs v33 -> v34 next. Asserting on the
  // hard-coded `33` here protects us from a future schema bump
  // silently bypassing the v33->v34 backfill.
  it("graduates a fresh-looking v32 save to v33 (one step at a time)", () => {
    const save = { version: 32, encounter: null, loadouts: { "hero-01": {}, "hero-02": {} } };
    const out = migrateV32ToV33(save) as CampaignState;
    expect(out.version).toBe(33);
  });

  it("seeds shopDamageBonus = {} for every loadout hero on a save with no prior field", () => {
    const save = { version: 32, encounter: null, loadouts: { "hero-01": {}, "hero-02": {} } };
    const out = migrateV32ToV33(save) as CampaignState;
    expect(out.shopDamageBonus).toEqual({ "hero-01": {}, "hero-02": {} });
  });

  it("falls back to the two stock hero ids when the save has no loadouts (extra-defensive — should never happen)", () => {
    const save = { version: 32, encounter: null };
    const out = migrateV32ToV33(save) as CampaignState;
    expect(Object.keys(out.shopDamageBonus).sort()).toEqual(["hero-01", "hero-02"]);
  });

  it("seeds shopGrantsAppliedQuests = [] when absent", () => {
    const save = { version: 32, encounter: null, loadouts: { "hero-01": {} } };
    const out = migrateV32ToV33(save) as CampaignState;
    expect(out.shopGrantsAppliedQuests).toEqual([]);
  });

  it("does NOT clobber a pre-existing shopDamageBonus (forward-compat)", () => {
    const save = {
      version: 32,
      encounter: null,
      loadouts: { "hero-01": {}, "hero-02": {} },
      shopDamageBonus: { "hero-01": { light: 1 }, "hero-02": {} },
    };
    const out = migrateV32ToV33(save) as CampaignState;
    expect(out.shopDamageBonus).toEqual({ "hero-01": { light: 1 }, "hero-02": {} });
  });

  it("does NOT clobber a pre-existing shopGrantsAppliedQuests (forward-compat)", () => {
    const save = {
      version: 32,
      encounter: null,
      loadouts: { "hero-01": {} },
      shopGrantsAppliedQuests: ["quest2"],
    };
    const out = migrateV32ToV33(save) as CampaignState;
    expect(out.shopGrantsAppliedQuests).toEqual(["quest2"]);
  });

  it("returns null on malformed input (caller falls through to newCampaign)", () => {
    expect(migrateV32ToV33(null)).toBeNull();
  });
});

// v33 -> v34 backfills the two Chapter 2 Town Visit support fields:
//   - `townVisit2Completed: boolean` — Ch2 completion latch.
//   - `storyTokens: number` — Story Token pool for the Ch2
//     "Burned Watchtower" hub page's "visit 2 of 3" gate.
describe("migrateV33ToV34 — Chapter 2 Town Visit fields backfill", () => {
  it("graduates a fresh-looking v33 save to v34 (chained migration step)", () => {
    // Asserts v34 specifically (not SCHEMA_VERSION) because this
    // migration is only one rung of the chain — the loader will
    // re-enter `migrateV34ToV35` afterwards to take it to the
    // current head. If we asserted SCHEMA_VERSION here, every
    // future migration bump would falsely break this step.
    const save = { version: 33, encounter: null };
    const out = migrateV33ToV34(save) as CampaignState;
    expect(out.version).toBe(34);
  });

  it("seeds townVisit2Completed = false on a save with no prior field", () => {
    const save = { version: 33, encounter: null };
    const out = migrateV33ToV34(save) as CampaignState;
    expect(out.townVisit2Completed).toBe(false);
  });

  it("seeds storyTokens = 0 on a save with no prior field", () => {
    const save = { version: 33, encounter: null };
    const out = migrateV33ToV34(save) as CampaignState;
    expect(out.storyTokens).toBe(0);
  });

  it("does NOT clobber a pre-existing townVisit2Completed (forward-compat)", () => {
    const save = { version: 33, encounter: null, townVisit2Completed: true };
    const out = migrateV33ToV34(save) as CampaignState;
    expect(out.townVisit2Completed).toBe(true);
  });

  it("does NOT clobber a pre-existing storyTokens (forward-compat)", () => {
    const save = { version: 33, encounter: null, storyTokens: 2 };
    const out = migrateV33ToV34(save) as CampaignState;
    expect(out.storyTokens).toBe(2);
  });

  it("returns null on malformed input (caller falls through to newCampaign)", () => {
    expect(migrateV33ToV34(null)).toBeNull();
  });
});

// v41 -> v42 backfills `movementSnapshot = null` on every existing
// HeroTurnState. Powers the "Undo and submit" branch of the End Turn
// confirmation modal that surfaces when a turn ends with movement-
// but-no-placement (2026-05-21).
describe("migrateV41ToV42 — movementSnapshot backfill", () => {
  it("backfills movementSnapshot = null on every turnState entry", () => {
    const save = {
      version: 41,
      encounter: {
        turnState: {
          "hero-01": {
            cardPlacedThisTurn: null,
            actionUsedThisTurn: false,
            movementUsedThisTurn: false,
            movementStepsThisTurn: 0,
            apMovementDoubledThisTurn: false,
            actionGrantedExtraMovement: false,
            damage2xUsedThisTurn: false,
            witnessStepsThisTurn: 0,
          },
          "hero-02": {
            cardPlacedThisTurn: null,
            actionUsedThisTurn: true,
            movementUsedThisTurn: true,
            movementStepsThisTurn: 1,
            apMovementDoubledThisTurn: false,
            actionGrantedExtraMovement: false,
            damage2xUsedThisTurn: false,
            witnessStepsThisTurn: 0,
          },
        },
      },
    };
    const out = migrateV41ToV42(save) as CampaignState;
    expect(out.version).toBe(42);
    expect(out.encounter!.turnState["hero-01"]!.movementSnapshot).toBeNull();
    expect(out.encounter!.turnState["hero-02"]!.movementSnapshot).toBeNull();
  });

  it("does NOT clobber an already-present movementSnapshot value (forward-compat)", () => {
    const existingSnap = {
      startPosition: { x: 1, y: 2 },
      startMovement: 2,
      startMinionParts: 0,
      startBossParts: 0,
      claimedDrops: [],
    };
    const save = {
      version: 41,
      encounter: {
        turnState: {
          "hero-01": {
            cardPlacedThisTurn: null,
            actionUsedThisTurn: false,
            movementUsedThisTurn: false,
            movementStepsThisTurn: 1,
            apMovementDoubledThisTurn: false,
            actionGrantedExtraMovement: false,
            damage2xUsedThisTurn: false,
            witnessStepsThisTurn: 0,
            movementSnapshot: existingSnap,
          },
        },
      },
    };
    const out = migrateV41ToV42(save) as CampaignState;
    expect(out.encounter!.turnState["hero-01"]!.movementSnapshot).toEqual(existingSnap);
  });

  it("is a no-op (and bumps version) when there's no encounter in progress", () => {
    const save = { version: 41, encounter: null };
    const out = migrateV41ToV42(save) as CampaignState;
    expect(out.version).toBe(42);
    expect(out.encounter).toBeNull();
  });

  it("returns null on malformed input (caller falls through to newCampaign)", () => {
    expect(migrateV41ToV42(null)).toBeNull();
  });
});

// v42 -> v43 seeds `memoryCards: []` (the per-campaign list of
// Memory Card numbers drawn from spent Memory Chip Tokens). Existing
// saves predate the Ch2 Machinist "Witness records a memory" page,
// so the starter value is empty; the first visit through the new
// page will populate it.
describe("migrateV42ToV43 — memoryCards seed", () => {
  it("seeds memoryCards = [] when absent", () => {
    const save = { version: 42 };
    const out = migrateV42ToV43(save) as CampaignState;
    expect(out.version).toBe(43);
    expect(out.memoryCards).toEqual([]);
  });

  it("preserves a pre-existing memoryCards array (forward-compat replay)", () => {
    const save = { version: 42, memoryCards: [1, 2, 1] };
    const out = migrateV42ToV43(save) as CampaignState;
    expect(out.memoryCards).toEqual([1, 2, 1]);
  });

  it("returns null on malformed input (caller falls through to newCampaign)", () => {
    expect(migrateV42ToV43(null)).toBeNull();
  });
});

// v43 -> v44 seeds `pendingSuitConditionPicks: []` (the per-campaign
// queue of Suit Condition rank picks awaiting player resolution).
// Existing saves predate the academy-donation picker rework + the
// dead-delver "blood-soaked power" pick on `page22-died`, so the
// starter value is empty; the first visit through either path will
// populate it.
describe("migrateV43ToV44 — pendingSuitConditionPicks seed", () => {
  it("seeds pendingSuitConditionPicks = [] when absent", () => {
    const save = { version: 43 };
    const out = migrateV43ToV44(save) as CampaignState;
    // Hard-code 44 (not SCHEMA_VERSION) so future bumps don't
    // silently regress this — v44->v45 (Scenario Card state) is
    // what actually graduates the save onwards. Chained migration
    // coverage lives in loadCampaign tests.
    expect(out.version).toBe(44);
    expect(out.pendingSuitConditionPicks).toEqual([]);
  });

  it("preserves a pre-existing pendingSuitConditionPicks array (forward-compat replay)", () => {
    const existing = [{
      pickId: "academy-donation-small-os",
      source: "academy-donation-small",
      delta: 1,
      heroId: null,
      pinnedType: "OS",
    }];
    const save = { version: 43, pendingSuitConditionPicks: existing };
    const out = migrateV43ToV44(save) as CampaignState;
    expect(out.pendingSuitConditionPicks).toEqual(existing);
  });

  it("returns null on malformed input (caller falls through to newCampaign)", () => {
    expect(migrateV43ToV44(null)).toBeNull();
  });
});

// v44 -> v45 seeds Scenario Card resolution state: an empty
// `scenarioCardsResolved` list (printed: discard the card after
// resolution; the digital deck mirrors that by skipping any
// number in this list if a future trigger ever re-references it),
// and `currentScenarioCard = null` (no card in-flight at migration
// time; the next wave-bootstrap with `scenarioCardOnStart`
// repopulates it).
describe("migrateV44ToV45 — Scenario Card state seed", () => {
  it("seeds scenarioCardsResolved = [] and currentScenarioCard = null when absent", () => {
    const save = { version: 44 };
    const out = migrateV44ToV45(save) as CampaignState;
    // v44→v45 hard-codes 45 (not SCHEMA_VERSION) so chained
    // migrations (v45→v46+) still fire on a save that lands
    // here from an older starting point.
    expect(out.version).toBe(45);
    expect(out.scenarioCardsResolved).toEqual([]);
    expect(out.currentScenarioCard).toBeNull();
  });

  it("preserves a pre-existing scenarioCardsResolved array (forward-compat replay)", () => {
    const save = { version: 44, scenarioCardsResolved: [1, 2] };
    const out = migrateV44ToV45(save) as CampaignState;
    expect(out.scenarioCardsResolved).toEqual([1, 2]);
  });

  it("preserves a pre-existing currentScenarioCard object (forward-compat replay)", () => {
    const existing = { number: 1, chosenOption: "A" as const, resolved: false };
    const save = { version: 44, currentScenarioCard: existing };
    const out = migrateV44ToV45(save) as CampaignState;
    expect(out.currentScenarioCard).toEqual(existing);
  });

  it("returns null on malformed input (caller falls through to newCampaign)", () => {
    expect(migrateV44ToV45(null)).toBeNull();
  });
});

// v45 -> v46: seed `friendlySpawnDeck = []`,
// `pendingFriendlyEncounters = []`, and
// `encounter.friendlyEncounters = []` (when an encounter is in
// flight). All three default to empty for pre-v46 saves -- no
// pre-existing pickup wiring could have populated them, and the
// chapter narrative grants only fire on a fresh visit.
describe("migrateV45ToV46 — Friendly Spawn Card + Friendly Encounter state seed", () => {
  it("seeds friendlySpawnDeck = [] and pendingFriendlyEncounters = [] when absent", () => {
    const save = { version: 45 };
    const out = migrateV45ToV46(save) as CampaignState;
    expect(out.version).toBe(46);
    expect(out.friendlySpawnDeck).toEqual([]);
    expect(out.pendingFriendlyEncounters).toEqual([]);
  });

  it("preserves a pre-existing friendlySpawnDeck (forward-compat replay)", () => {
    const save = { version: 45, friendlySpawnDeck: [13] };
    const out = migrateV45ToV46(save) as CampaignState;
    expect(out.friendlySpawnDeck).toEqual([13]);
  });

  it("preserves a pre-existing pendingFriendlyEncounters (forward-compat replay)", () => {
    const save = { version: 45, pendingFriendlyEncounters: [1] };
    const out = migrateV45ToV46(save) as CampaignState;
    expect(out.pendingFriendlyEncounters).toEqual([1]);
  });

  it("backfills encounter.friendlyEncounters = [] when an encounter is in flight", () => {
    const save = {
      version: 45,
      encounter: { questId: "quest1", waveNumber: 1 },
    };
    const out = migrateV45ToV46(save) as CampaignState;
    expect(out.encounter?.friendlyEncounters).toEqual([]);
  });

  it("preserves a pre-existing encounter.friendlyEncounters (forward-compat replay)", () => {
    const tokens = [{ x: 0, y: 0 }];
    const save = {
      version: 45,
      encounter: { questId: "quest1", waveNumber: 1, friendlyEncounters: tokens },
    };
    const out = migrateV45ToV46(save) as CampaignState;
    expect(out.encounter?.friendlyEncounters).toEqual(tokens);
  });

  it("returns null on malformed input (caller falls through to newCampaign)", () => {
    expect(migrateV45ToV46(null)).toBeNull();
  });
});

// --- Level-aware boss-part wallets (v58, 2026-07-20) ------------------------
//
// Player report: every boss dropped what the wallet treated as a
// lvl-1 part, so shop products costing lvl-2 parts (+2 MEDIUM,
// +4 HEAVY, Cyclone Boots) were unpurchasable. Drop ids were always
// correct (Hundredeyes prints boss-part-lvl-2, Death Cap lvl-3);
// only the wallet was flat.

describe("bossPartLevelForDropId", () => {
  it("parses the level out of boss-part-lvl-N (1..5, v61)", () => {
    expect(bossPartLevelForDropId("boss-part-lvl-1")).toBe(1);
    expect(bossPartLevelForDropId("boss-part-lvl-2")).toBe(2);
    expect(bossPartLevelForDropId("boss-part-lvl-3")).toBe(3);
    expect(bossPartLevelForDropId("boss-part-lvl-4")).toBe(4);
    expect(bossPartLevelForDropId("boss-part-lvl-5")).toBe(5);
  });

  it("throws on levels outside 1..5 and on non-boss drops", () => {
    expect(() => bossPartLevelForDropId("boss-part-lvl-6")).toThrow();
    expect(() => bossPartLevelForDropId("minion-part")).toThrow();
  });

  it("bare legacy \"boss-part\" counts as level 1", () => {
    expect(bossPartLevelForDropId("boss-part")).toBe(1);
  });
});

describe("creditBossPartDrop routes to the level-matched wallet", () => {
  it("lvl-1 -> bossParts, lvl-2 -> bossPartsLvl2, lvl-3 -> bossPartsLvl3", () => {
    const s = newCampaign();
    creditBossPartDrop(s, "hero-01", "boss-part-lvl-1"); // Soulhunter / Goldmonger
    creditBossPartDrop(s, "hero-01", "boss-part-lvl-2"); // Hundredeyes
    creditBossPartDrop(s, "hero-01", "boss-part-lvl-2");
    creditBossPartDrop(s, "hero-01", "boss-part-lvl-3"); // Death Cap
    expect(s.bossParts["hero-01"]).toBe(1);
    expect(s.bossPartsLvl2["hero-01"]).toBe(2);
    expect(s.bossPartsLvl3["hero-01"]).toBe(1);
    // Other delver untouched.
    expect(s.bossPartsLvl2["hero-02"]).toBe(0);
    expect(totalBossParts(s, "hero-01")).toBe(4);
  });
});

describe("migrateV57ToV58", () => {
  it("seeds zeroed lvl-2 / lvl-3 wallets keyed by the save's loadout heroes", () => {
    const legacy = { ...newCampaign(), version: 57 } as unknown as Record<string, unknown>;
    delete legacy.bossPartsLvl2;
    delete legacy.bossPartsLvl3;
    const out = migrateV57ToV58(legacy)!;
    expect(out.version).toBe(58);
    expect(out.bossPartsLvl2).toEqual({ "hero-01": 0, "hero-02": 0 });
    expect(out.bossPartsLvl3).toEqual({ "hero-01": 0, "hero-02": 0 });
  });

  it("does not clobber wallets that already exist", () => {
    const s = { ...newCampaign(), version: 57 };
    s.bossPartsLvl2 = { "hero-01": 3, "hero-02": 0 };
    const out = migrateV57ToV58(s)!;
    expect(out.bossPartsLvl2["hero-01"]).toBe(3);
  });

  it("returns null for garbage input", () => {
    expect(migrateV57ToV58(null)).toBeNull();
  });
});
