/**
 * Tests for src/engine/kills.ts.
 *
 * Covers:
 *   - rulebook p23: on-death `Gain <element>` rewards apply to BOTH delvers
 *   - rulebook p17: per-element cap of 2 per delver — overflow LOST
 *   - rulebook p23: drops + XP + level-up cards bookkeeping
 *   - per-delver minion-part / boss-part drops (DESIGN.md §3.5 — both
 *     minion parts and boss parts are PER-DELVER, "each player gets
 *     their own copy of any drop")
 *   - DEFERRED PICKUP MODEL (DESIGN.md §3.5, wired 2026-05-04):
 *       drops created by `applyKill` go onto `state.encounter.tileDrops`
 *       and DO NOT bump the per-hero counters. The counters bump in
 *       `engine/movement.ts > moveDelver` when a delver ends a move on
 *       a tile holding a matching drop. These tests assert the
 *       PLACEMENT side (drops land on the tile, dead delvers skipped,
 *       counters unchanged); pickup is exercised in
 *       `__tests__/movement.test.ts`.
 *   - dead-delver skip for drops (design decision 2026-05-04 — a delver
 *     at currentHp ≤ 0 does NOT receive minion-part / boss-part drops,
 *     mirroring Harvester / Providence). No `TileDrop` is created for
 *     them; revival doesn't retroactively grant skipped parts.
 *   - boss-part dropId conventions: bare `"boss-part"` and the
 *     level-keyed `"boss-part-lvl-N"` form both target
 *     `state.bossParts` (the level lives in the dropId for UI art
 *     lookup but isn't broken out in state for v1)
 *
 * The single source of truth for the cap is `grantElementToDelver`,
 * shared with `engine/slotAbilities.ts > resolveGainElement` so a slot
 * ability that grants an element behaves identically.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { newCampaign, type CampaignState } from "../state";
import { QUEST1, getEnemy } from "../data";
import { ensureEncounter } from "../engine/encounter";
import type { EnemyCard } from "../types";
import { applyKill, applyXpRoll, grantElementToDelver, ELEMENT_CAP_PER_DELVER } from "../engine/kills";
import { xpToNextLevel } from "../xp";
import { freshTurnState } from "../engine/encounter";

const noShuffle = (pool: readonly string[]) => [...pool];

/** Position passed to applyKill for tests that don't care about the tile. */
const AT = { x: 0, y: 0 };

let state: CampaignState;
beforeEach(() => {
  state = newCampaign();
  // applyKill needs `state.encounter` to exist so it can push TileDrops.
  // (Pure-XP / pure-element assertions don't read tileDrops, but having
  // the encounter present matches every real call path.)
  ensureEncounter(state, QUEST1, noShuffle);
});

describe("grantElementToDelver — single source of truth for the cap", () => {
  it("grants +1 when below the cap and reports `granted: true`", () => {
    const r = grantElementToDelver(state, "hero-01", "earth");
    expect(r.granted).toBe(true);
    expect(r.newTotal).toBe(1);
    expect(state.elements["hero-01"]!.earth).toBe(1);
  });

  it("caps at 2 (rulebook p17): the third grant is LOST", () => {
    grantElementToDelver(state, "hero-01", "earth");
    grantElementToDelver(state, "hero-01", "earth");
    const r = grantElementToDelver(state, "hero-01", "earth");
    expect(r.granted).toBe(false);
    expect(r.newTotal).toBe(ELEMENT_CAP_PER_DELVER);
    expect(state.elements["hero-01"]!.earth).toBe(ELEMENT_CAP_PER_DELVER);
  });

  it("tracks elements independently per delver and per element type", () => {
    grantElementToDelver(state, "hero-01", "earth");
    grantElementToDelver(state, "hero-02", "earth");
    grantElementToDelver(state, "hero-01", "radiance");
    expect(state.elements["hero-01"]!.earth).toBe(1);
    expect(state.elements["hero-01"]!.radiance).toBe(1);
    expect(state.elements["hero-02"]!.earth).toBe(1);
    expect(state.elements["hero-02"]!.radiance).toBeUndefined();
  });
});

// --- Auto-refresh on element gain (DESIGN.md §4.3.2) -------------------
//
// User repro 2026-05-09: Mind delver placed Beam in the earth slot
// (slot 2) with earth=1; later, while the OTHER delver was active,
// a kill granted +1 earth to both delvers. The mind delver ended up
// in an illegal state — earth=2 + Beam still in slot 2 — because
// the auto-refresh only fired at PLACEMENT time, not at GAIN time.
// The rule "2 matching elements + placed weapon = consume both,
// return weapon to hand" must be order-independent: it fires
// whether the 2nd token arrives before or after placement.
//
// Mind suit slot 2 = earth (per data/delverBoards.json), so "place
// mind-hammer-r1 in slot 2 + earth at cap" is the canonical setup.

describe("grantElementToDelver — auto-refresh-on-gain (DESIGN.md §4.3.2)", () => {
  it("placed weapon + 1 matching element + GAIN matching element \u2192 weapon refreshes, both tokens spent", () => {
    state.loadouts["hero-01"]!.slotCards[2] = "mind-hammer-r1";
    state.elements["hero-01"] = { earth: 1 };

    const r = grantElementToDelver(state, "hero-01", "earth");

    // `newTotal` reports the count immediately AFTER the grant
    // landed (1 → 2), NOT after the auto-refresh consumed the pair
    // (2 → 0). Conflating the two would give callers the contradictory
    // `granted: true, newTotal: 0` that hides the actual gain in
    // post-mortem logs and UI breakdowns.
    expect(r.granted).toBe(true);
    expect(r.newTotal).toBe(ELEMENT_CAP_PER_DELVER);
    // Slot empty + 0 earth: the printed-board well capacity is
    // restored, weapon is back in hand for next placement.
    expect(state.loadouts["hero-01"]!.slotCards[2]).toBeNull();
    expect(state.elements["hero-01"]!.earth).toBe(0);
  });

  it("placed weapon + 0 matching elements + GAIN matching element \u2192 NO auto-refresh (cap not met)", () => {
    state.loadouts["hero-01"]!.slotCards[2] = "mind-hammer-r1";
    state.elements["hero-01"] = { earth: 0 };

    grantElementToDelver(state, "hero-01", "earth");

    expect(state.loadouts["hero-01"]!.slotCards[2]).toBe("mind-hammer-r1");
    expect(state.elements["hero-01"]!.earth).toBe(1);
  });

  it("placed weapon in NON-matching slot + cap reached \u2192 NO auto-refresh on the unrelated slot", () => {
    // Slot 0 = radiance for Mind. Earth grants must not refresh it.
    state.loadouts["hero-01"]!.slotCards[0] = "mind-hammer-r1";
    state.elements["hero-01"] = { earth: 1 };

    grantElementToDelver(state, "hero-01", "earth");

    expect(state.loadouts["hero-01"]!.slotCards[0]).toBe("mind-hammer-r1");
    expect(state.elements["hero-01"]!.earth).toBe(ELEMENT_CAP_PER_DELVER);
  });

  it("cap-overflow grant (already at 2) does NOT trigger a fresh auto-refresh", () => {
    // Auto-refresh is keyed off a SUCCESSFUL grant. If the bag is
    // already at 2 when the call comes in, `grantElementToDelver`
    // returns `granted: false` before bumping anything — so a
    // placed weapon in the matching slot stays put and the slot
    // is unaffected. (This is the no-op case; the cap-overflow
    // path itself is the bug-class the auto-refresh prevents
    // from ever being reached on a SUCCESSFUL grant.)
    state.loadouts["hero-01"]!.slotCards[2] = "mind-hammer-r1";
    state.elements["hero-01"] = { earth: ELEMENT_CAP_PER_DELVER };

    const r = grantElementToDelver(state, "hero-01", "earth");

    expect(r.granted).toBe(false);
    expect(state.loadouts["hero-01"]!.slotCards[2]).toBe("mind-hammer-r1");
    expect(state.elements["hero-01"]!.earth).toBe(ELEMENT_CAP_PER_DELVER);
  });

  it("scoped strictly to the gaining delver \u2014 OTHER delver's matching slot is NOT touched", () => {
    // Both delvers happen to have a weapon in the same slot index +
    // 1 earth each. A grant to hero-01 should ONLY refresh hero-01's
    // slot; hero-02's stays put.
    state.loadouts["hero-01"]!.slotCards[2] = "mind-hammer-r1";
    state.loadouts["hero-02"]!.slotCards[2] = "body-hammer-r1";
    state.elements["hero-01"] = { earth: 1 };
    state.elements["hero-02"] = { earth: 1 };

    grantElementToDelver(state, "hero-01", "earth");

    expect(state.loadouts["hero-01"]!.slotCards[2]).toBeNull();
    expect(state.elements["hero-01"]!.earth).toBe(0);
    expect(state.loadouts["hero-02"]!.slotCards[2]).toBe("body-hammer-r1");
    expect(state.elements["hero-02"]!.earth).toBe(1);
  });

  it("upgrades cardPlacedThisTurn.autoRefreshedElement so undo restores the spent tokens", () => {
    // Bearer placed the card THIS turn (latch records slotIdx + cardId
    // with autoRefreshedElement: null because placement-time bag was 1).
    // A subsequent gain that fires the auto-refresh must upgrade the
    // latch to reflect the consumed element so undoWeaponPlacement
    // (which reads autoRefreshedElement to decide whether to restore
    // 2 tokens vs pop the card back) stays correct.
    state.loadouts["hero-01"]!.slotCards[2] = "mind-hammer-r1";
    state.elements["hero-01"] = { earth: 1 };
    const ts = freshTurnState();
    ts.cardPlacedThisTurn = {
      slotIdx: 2,
      cardId: "mind-hammer-r1",
      autoRefreshedElement: null,
    };
    state.encounter!.turnState["hero-01"] = ts;

    grantElementToDelver(state, "hero-01", "earth");

    expect(state.encounter!.turnState["hero-01"]!.cardPlacedThisTurn).toEqual({
      slotIdx: 2,
      cardId: "mind-hammer-r1",
      autoRefreshedElement: "earth",
    });
  });

  it("kill-drop scenario: applyKill on Crystanid (gains earth) refreshes a placed weapon in matching slot", () => {
    // End-to-end coverage of the user's actual repro path: a kill's
    // on-death element grants flow through grantElementToDelver, so
    // the auto-refresh fires inside applyKill without any special
    // wiring at the caller.
    state.loadouts["hero-01"]!.slotCards[2] = "mind-hammer-r1"; // mind earth slot
    state.loadouts["hero-02"]!.slotCards[2] = "body-hammer-r1"; // body earth slot
    state.elements["hero-01"] = { earth: 1 };
    state.elements["hero-02"] = { earth: 1 };

    applyKill(state, getEnemy("crystanid-006"), AT);

    // Both delvers had earth=1 + a placed weapon in their earth slot.
    // The Crystanid grants +1 earth to BOTH, so both auto-refresh.
    expect(state.loadouts["hero-01"]!.slotCards[2]).toBeNull();
    expect(state.loadouts["hero-02"]!.slotCards[2]).toBeNull();
    expect(state.elements["hero-01"]!.earth).toBe(0);
    expect(state.elements["hero-02"]!.earth).toBe(0);
  });
});

describe("applyKill — Crystanid #006 (Gain Radiance + Earth per delver)", () => {
  // crystanid-006 is the printed Quest #1 / Wave 1 minion whose
  // on-death rewards each delver with 1 Radiance + 1 Earth (matches
  // the card art and the user-supplied screenshot). Element rewards
  // are NOT subject to the deferred-pickup model — they apply
  // immediately at kill time (rulebook p23 + p17). The minion-part
  // drop on the same kill goes to `tileDrops`; we don't assert it
  // here because the dedicated drop tests below cover that path.
  const crystanid = () => getEnemy("crystanid-006");

  it("grants +1 Radiance AND +1 Earth to each delver (rulebook p23)", () => {
    const r = applyKill(state, crystanid(), AT);
    expect(state.elements["hero-01"]!.radiance).toBe(1);
    expect(state.elements["hero-01"]!.earth).toBe(1);
    expect(state.elements["hero-02"]!.radiance).toBe(1);
    expect(state.elements["hero-02"]!.earth).toBe(1);
    // Result surfaces both the printed reward AND the per-delver
    // landed/lost breakdown so the UI can report overflow.
    expect(r.elementsGranted).toEqual(crystanid().onDeath.gainElements);
    expect(r.elementGrants.every((g) => g.granted)).toBe(true);
  });

  it("respects the per-delver cap of 2 — third kill is a complete LOSS", () => {
    applyKill(state, crystanid(), AT);
    applyKill(state, crystanid(), AT); // both delvers now at Radiance=2, Earth=2
    const r = applyKill(state, crystanid(), AT); // third kill — every grant LOST
    expect(state.elements["hero-01"]!.radiance).toBe(ELEMENT_CAP_PER_DELVER);
    expect(state.elements["hero-01"]!.earth).toBe(ELEMENT_CAP_PER_DELVER);
    expect(state.elements["hero-02"]!.radiance).toBe(ELEMENT_CAP_PER_DELVER);
    expect(state.elements["hero-02"]!.earth).toBe(ELEMENT_CAP_PER_DELVER);
    // Every per-delver grant on the 3rd kill should be `granted: false`
    // — that's the UI signal for "bag full, overflow lost".
    expect(r.elementGrants.every((g) => !g.granted)).toBe(true);
  });

  it("does NOT mix grants across delvers — partial cap on one delver only blocks that delver", () => {
    state.elements["hero-01"] = { earth: 2 };
    const r = applyKill(state, crystanid(), AT);
    expect(state.elements["hero-01"]!.earth).toBe(2);    // still capped
    expect(state.elements["hero-01"]!.radiance).toBe(1); // free room
    expect(state.elements["hero-02"]!.earth).toBe(1);    // unaffected
    expect(state.elements["hero-02"]!.radiance).toBe(1);
    const earthForH1 = r.elementGrants.find(
      (g) => g.heroId === "hero-01" && g.element === "earth",
    )!;
    expect(earthForH1.granted).toBe(false);
  });

  it("XP from on-death goes into the SHARED xpOnHand pool (DESIGN.md §2)", () => {
    const before = state.xpOnHand;
    const r = applyKill(state, crystanid(), AT);
    expect(state.xpOnHand).toBe(before + r.xpGained);
  });
});

// --- minion-part drops (deferred pickup) -----------------------------

describe("applyKill — minion-part drops land on tileDrops, NOT counters", () => {
  // crystanid-002 is the simplest 'minion-part only' case (no on-death
  // elements; just XP + the part), so the per-hero math isn't masked by
  // the element accounting.
  const minion = () => getEnemy("crystanid-002");

  it("places one TileDrop per LIVING delver on the dying enemy's tile", () => {
    const at = { x: 2, y: 3 };
    const r = applyKill(state, minion(), at);

    // Counters do NOT bump on death — pickup is deferred to moveDelver.
    expect(state.minionParts["hero-01"]).toBe(0);
    expect(state.minionParts["hero-02"]).toBe(0);
    expect(state.bossParts["hero-01"]).toBe(0);
    expect(state.bossParts["hero-02"]).toBe(0);

    // Both delvers are alive → 2 TileDrops (one per hero), both at the
    // dying enemy's tile, both with `dropId === "minion-part"`.
    expect(state.encounter!.tileDrops).toHaveLength(2);
    expect(state.encounter!.tileDrops).toContainEqual({
      x: 2, y: 3, heroId: "hero-01", dropId: "minion-part",
    });
    expect(state.encounter!.tileDrops).toContainEqual({
      x: 2, y: 3, heroId: "hero-02", dropId: "minion-part",
    });

    // dropsByPlayer mirrors what was OWED to each delver (i.e. what
    // TileDrops were created for them). Same per-hero map shape as
    // before the deferred-pickup refactor.
    expect(r.dropsByPlayer["hero-01"]).toEqual({ "minion-part": 1 });
    expect(r.dropsByPlayer["hero-02"]).toEqual({ "minion-part": 1 });
  });

  it("stacks across multiple kills on the SAME tile (3 kills → 6 entries)", () => {
    const at = { x: 1, y: 1 };
    applyKill(state, minion(), at);
    applyKill(state, minion(), at);
    applyKill(state, minion(), at);

    // 3 kills × 2 living delvers = 6 TileDrops, all at (1,1).
    expect(state.encounter!.tileDrops).toHaveLength(6);
    expect(state.encounter!.tileDrops.every((d) => d.x === 1 && d.y === 1)).toBe(true);
    // 3 owed to each delver.
    expect(state.encounter!.tileDrops.filter((d) => d.heroId === "hero-01")).toHaveLength(3);
    expect(state.encounter!.tileDrops.filter((d) => d.heroId === "hero-02")).toHaveLength(3);
    // Counters still untouched (waiting on pickup).
    expect(state.minionParts["hero-01"]).toBe(0);
    expect(state.minionParts["hero-02"]).toBe(0);
  });

  it("kills on DIFFERENT tiles produce independent piles", () => {
    applyKill(state, minion(), { x: 0, y: 0 });
    applyKill(state, minion(), { x: 4, y: 4 });

    expect(state.encounter!.tileDrops).toHaveLength(4);
    expect(state.encounter!.tileDrops.filter((d) => d.x === 0 && d.y === 0)).toHaveLength(2);
    expect(state.encounter!.tileDrops.filter((d) => d.x === 4 && d.y === 4)).toHaveLength(2);
  });

  it("SKIPS a downed delver — only the alive delver's TileDrop is placed", () => {
    state.loadouts["hero-01"]!.currentHp = 0;
    const at = { x: 2, y: 2 };

    const r = applyKill(state, minion(), at);

    // Only hero-02's drop lands on the tile.
    expect(state.encounter!.tileDrops).toHaveLength(1);
    expect(state.encounter!.tileDrops[0]).toEqual({
      x: 2, y: 2, heroId: "hero-02", dropId: "minion-part",
    });
    // Counters untouched on both heroes (hero-02's bumps later, when
    // they walk onto the tile).
    expect(state.minionParts["hero-01"]).toBe(0);
    expect(state.minionParts["hero-02"]).toBe(0);
    // dropsByPlayer reflects the skip — dead delver gets an empty record.
    expect(r.dropsByPlayer["hero-01"]).toEqual({});
    expect(r.dropsByPlayer["hero-02"]).toEqual({ "minion-part": 1 });
  });

  it("places NOTHING if BOTH delvers are downed", () => {
    state.loadouts["hero-01"]!.currentHp = 0;
    state.loadouts["hero-02"]!.currentHp = 0;

    const r = applyKill(state, minion(), AT);

    expect(state.encounter!.tileDrops).toHaveLength(0);
    expect(state.minionParts["hero-01"]).toBe(0);
    expect(state.minionParts["hero-02"]).toBe(0);
    expect(r.dropsByPlayer["hero-01"]).toEqual({});
    expect(r.dropsByPlayer["hero-02"]).toEqual({});
  });
});

// --- boss-part drops (deferred pickup, level-keyed in dropId) -------

describe("applyKill — boss-part drops land on tileDrops, NOT counters", () => {
  // soulhunter-001 is the Quest 1 level-1 boss. Its on-death drop is
  // `"boss-part-lvl-1"` (level encoded in the dropId so the UI can
  // pick the right token art; the state counter is flat).
  const boss = () => getEnemy("soulhunter-001");

  it("Quest 1 boss data declares the level-keyed dropId", () => {
    // Regression for the original "lvl-1-boss-part" prefix-mismatch bug.
    expect(boss().onDeath.drops).toEqual(["boss-part-lvl-1"]);
    expect(boss().kind).toBe("boss-lvl-1");
  });

  it("places one boss-part TileDrop per LIVING delver on the boss tile", () => {
    const at = { x: 4, y: 0 };
    const r = applyKill(state, boss(), at);

    expect(state.bossParts["hero-01"]).toBe(0);
    expect(state.bossParts["hero-02"]).toBe(0);
    expect(state.minionParts["hero-01"]).toBe(0);

    expect(state.encounter!.tileDrops).toHaveLength(2);
    expect(state.encounter!.tileDrops).toContainEqual({
      x: 4, y: 0, heroId: "hero-01", dropId: "boss-part-lvl-1",
    });
    expect(state.encounter!.tileDrops).toContainEqual({
      x: 4, y: 0, heroId: "hero-02", dropId: "boss-part-lvl-1",
    });

    // dropsByPlayer keeps the literal dropId so the UI can route to
    // the right per-level token art (lvl-1 in Q1).
    expect(r.dropsByPlayer["hero-01"]).toEqual({ "boss-part-lvl-1": 1 });
    expect(r.dropsByPlayer["hero-02"]).toEqual({ "boss-part-lvl-1": 1 });
  });

  it("also bumps the gainLevelUpCards bookkeeping (printed reward)", () => {
    const before = state.levelUpCardsOwed;
    const r = applyKill(state, boss(), AT);
    expect(state.levelUpCardsOwed).toBe(before + 1);
    expect(r.levelUpCardsAdded).toBe(1);
  });

  // Regression (user report 2026-07-20): the printed "Gain a LEVEL UP
  // card" boss reward only bumped the bookkeeping counter — no
  // interactive draw was ever enqueued, so defeating the Soulhunter
  // never opened the Level Up modal and the reward was silently lost.
  // All four bosses print gainLevelUpCards: 1; the draws must land on
  // the SAME queue the XP-threshold path uses.
  it("enqueues one interactive Level-Up draw PER DELVER (active first) for the printed reward", () => {
    const enc = state.encounter!;
    expect(enc.pendingLevelUpDraws).toHaveLength(0);

    const r = applyKill(state, boss(), AT);

    expect(r.levelUpDrawsEnqueued).toBe(2);
    expect(enc.pendingLevelUpDraws).toHaveLength(2);
    // Active delver draws first, then the other delver — mirrors
    // `applyPendingLevelUps` and the scenario-card grant path.
    expect(enc.pendingLevelUpDraws[0]!.heroId).toBe(state.currentDelverId);
    const other = Object.keys(state.loadouts).find((id) => id !== state.currentDelverId)!;
    expect(enc.pendingLevelUpDraws[1]!.heroId).toBe(other);
    // Each pending entry carries an actual card drawn off the deck.
    for (const draw of enc.pendingLevelUpDraws) {
      expect(typeof draw.cardNumber).toBe("number");
    }
  });

  it("enqueues draws for BOTH delvers even when one is downed (matches the XP level-up path, unlike drops)", () => {
    state.loadouts["hero-02"]!.currentHp = 0;
    const r = applyKill(state, boss(), AT);
    expect(r.levelUpDrawsEnqueued).toBe(2);
    expect(state.encounter!.pendingLevelUpDraws).toHaveLength(2);
  });

  it("minions (no printed gainLevelUpCards) enqueue NO draws", () => {
    const r = applyKill(state, getEnemy("crystanid-001"), AT);
    expect(r.levelUpDrawsEnqueued).toBe(0);
    expect(state.encounter!.pendingLevelUpDraws).toHaveLength(0);
  });

  it("every boss in the dataset prints gainLevelUpCards: 1 (data regression guard)", () => {
    for (const id of ["soulhunter-001", "goldmonger-002", "hundredeyes-003", "deathcap-004"]) {
      expect(getEnemy(id).onDeath.gainLevelUpCards, id).toBe(1);
    }
  });

  it("SKIPS a downed delver — only the alive delver's TileDrop is placed", () => {
    state.loadouts["hero-02"]!.currentHp = 0;

    const r = applyKill(state, boss(), AT);

    expect(state.encounter!.tileDrops).toHaveLength(1);
    expect(state.encounter!.tileDrops[0]!.heroId).toBe("hero-01");
    expect(state.encounter!.tileDrops[0]!.dropId).toBe("boss-part-lvl-1");
    expect(state.bossParts["hero-01"]).toBe(0); // pickup hasn't happened yet
    expect(r.dropsByPlayer["hero-01"]).toEqual({ "boss-part-lvl-1": 1 });
    expect(r.dropsByPlayer["hero-02"]).toEqual({});
  });

  it("places drops even for unrelated dropIds (forward-compat) — TileDrop just records the literal id", () => {
    // Note: counter routing for "minion-part" / "boss-part(-lvl-N)"
    // happens at PICKUP time in moveDelver — the kill-side path
    // doesn't switch on the dropId at all; it just records the
    // literal id verbatim. So ANY drop on the enemy card produces
    // a TileDrop, regardless of whether the engine recognises the id
    // for counter-routing.
    const weird: EnemyCard = {
      ...boss(),
      onDeath: { ...boss().onDeath, drops: ["mystery-token"] },
    };

    const r = applyKill(state, weird, AT);

    expect(state.encounter!.tileDrops).toHaveLength(2);
    expect(state.encounter!.tileDrops.every((d) => d.dropId === "mystery-token")).toBe(true);
    expect(r.dropsByPlayer["hero-01"]).toEqual({ "mystery-token": 1 });
  });
});

// --- XP die rolls ("Gain 1 [die] XP") ---------------------------------

// Regression (player report 2026-07-20): Ophidian 017 / Sporecloud
// 022 print "Gain 1 [die] XP" — the player rolls a d6 in front of
// everyone. Pre-fix the data flattened this to a silent static 1 XP
// and no roll ever happened.
describe("applyKill — on-death gainXpDice enqueues a player-facing roll", () => {
  it("banks NO immediate XP and enqueues one pending roll per die", () => {
    const before = state.xpOnHand;
    const r = applyKill(state, getEnemy("ophidian-017"), AT);
    expect(r.xpGained).toBe(0);
    expect(r.xpRollsEnqueued).toBe(1);
    expect(state.xpOnHand).toBe(before); // nothing banked yet
    expect(state.encounter!.pendingXpRolls).toHaveLength(1);
    expect(state.encounter!.pendingXpRolls[0]!.enemyCardId).toBe("ophidian-017");
    expect(state.encounter!.pendingXpRolls[0]!.heroId).toBe(state.currentDelverId);
  });

  it("static-XP enemies enqueue no rolls", () => {
    const r = applyKill(state, getEnemy("crystanid-002"), AT);
    expect(r.xpRollsEnqueued).toBe(0);
    expect(state.encounter!.pendingXpRolls).toHaveLength(0);
  });
});

describe("applyXpRoll", () => {
  it("banks the rolled amount into the shared pool and pops the queue", () => {
    applyKill(state, getEnemy("sporecloud-022"), AT);
    const totalBefore = state.totalXp;
    const r = applyXpRoll(state, 5);
    expect(r).not.toBeNull();
    expect(r!.rolled).toBe(5);
    expect(r!.xpGained).toBe(5);
    // The 5 XP is banked; any level-ups it affords then spend from xpOnHand
    // (covered by the next test), so check the lifetime total.
    expect(state.totalXp).toBe(totalBefore + 5);
    expect(state.encounter!.pendingXpRolls).toHaveLength(0);
  });

  it("resolves level-ups the rolled XP affords (draws enqueued per delver)", () => {
    applyKill(state, getEnemy("ophidian-017"), AT);
    // Park the pool 1 XP short of the next level threshold so any
    // roll crosses it.
    state.xpOnHand = Math.max(0, xpToNextLevel(0, state.currentLevel) - 1);
    const r = applyXpRoll(state, 6);
    expect(r!.levelUps).toBeGreaterThanOrEqual(1);
    expect(state.encounter!.pendingLevelUpDraws.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects out-of-range rolls and an empty queue", () => {
    expect(applyXpRoll(state, 4)).toBeNull(); // nothing pending
    applyKill(state, getEnemy("ophidian-017"), AT);
    expect(applyXpRoll(state, 0)).toBeNull();
    expect(applyXpRoll(state, 7)).toBeNull();
    expect(state.encounter!.pendingXpRolls).toHaveLength(1); // still pending
  });
});

// --- dropsByPlayer shape ---------------------------------------------

describe("applyKill — KillResult.dropsByPlayer shape", () => {
  it("always includes an entry per hero (empty object if no drops)", () => {
    const noDrops: EnemyCard = {
      ...getEnemy("crystanid-002"),
      onDeath: { drops: [], gainXp: 1 },
    };

    const r = applyKill(state, noDrops, AT);

    expect(Object.keys(r.dropsByPlayer).sort()).toEqual(["hero-01", "hero-02"]);
    expect(r.dropsByPlayer["hero-01"]).toEqual({});
    expect(r.dropsByPlayer["hero-02"]).toEqual({});
    expect(state.encounter!.tileDrops).toHaveLength(0);
  });
});
