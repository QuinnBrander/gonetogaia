/**
 * Phase A scaffolding tests for Quest #2.
 *
 * These cover the *data* and *type* foundation we just laid in:
 *   - types.ts  (EnemyAbility union, PartingShot variants,
 *                QuestWaveSpawn discriminated union, QuestWave)
 *   - data.ts   (QUEST2 export, getQuestData / getQuestWave
 *                helpers, QUEST_DATA list)
 *   - data/enemies.json   (Venena 008-014 + Goldmonger 002,
 *                          their Fatal-Flaw tiers + parting shots)
 *   - data/quest2.json    (3-wave structure, spawn-deck variants,
 *                          end-of-wave routing pages)
 *
 * Phase B will layer engine + UI tests on top (spawn-deck
 * encounter builder, delver-spawn picker mutation, Fatal Flaw
 * kill-order enforcement, Retreat/Continue routing). Don't add
 * those here — keep this file focused on the static-data
 * invariants so any future regression points straight at the
 * authored data (not engine code).
 */

import { describe, it, expect } from "vitest";

import {
  QUEST1,
  QUEST2,
  QUEST_DATA,
  getQuestData,
  getQuestWave,
  getEnemy,
} from "../data";
import type { EnemyAbility } from "../types";

describe("QUEST_DATA catalog", () => {
  it("contains the shipped quests in story order", () => {
    expect(QUEST_DATA.map((q) => q.id)).toEqual(["quest1", "quest2", "quest3", "quest5", "quest6", "assault", "quest4", "quest7", "quest13"]);
  });

  it("getQuestData returns the right quest by id", () => {
    expect(getQuestData("quest1")).toBe(QUEST1);
    expect(getQuestData("quest2")).toBe(QUEST2);
  });

  it("getQuestData throws on an unknown id", () => {
    expect(() => getQuestData("quest99")).toThrow(/unknown quest id/);
  });
});

describe("getQuestWave", () => {
  it("returns wave 1 for quest1", () => {
    const w = getQuestWave(QUEST1, 1);
    expect(w.number).toBe(1);
    expect(w.spawn.kind).toBe("hand-authored");
  });

  it("returns wave 1, 2, 3 for quest2", () => {
    expect(getQuestWave(QUEST2, 1).number).toBe(1);
    expect(getQuestWave(QUEST2, 2).number).toBe(2);
    expect(getQuestWave(QUEST2, 3).number).toBe(3);
  });

  it("throws when asked for a wave that doesn't exist", () => {
    expect(() => getQuestWave(QUEST1, 2)).toThrow(/no wave 2/);
    expect(() => getQuestWave(QUEST2, 4)).toThrow(/no wave 4/);
  });
});

describe("QUEST2 structure", () => {
  it("has a real (non-empty) intro narrative", () => {
    expect(QUEST2.intro.length).toBeGreaterThan(0);
    for (const page of QUEST2.intro) {
      expect(page.length).toBeGreaterThan(20);
    }
  });

  it("ships 3 waves, all spawn-deck-based with a 5x5 board", () => {
    expect(QUEST2.waves).toHaveLength(3);
    for (const w of QUEST2.waves) {
      expect(w.spawn.kind).toBe("spawn-deck");
      expect(w.spawn.boardSize).toEqual({ w: 5, h: 5 });
      // Every wave still names 1 boss + 7 minion ids — the
      // engine relies on the minion pool length matching the
      // spawn card's 7 printed minion tiles.
      expect(w.minionEnemyIds).toHaveLength(7);
      expect(w.bossEnemyId.length).toBeGreaterThan(0);
    }
  });

  it("wave 1 routes end-of-wave to the authored pages", () => {
    const w1 = getQuestWave(QUEST2, 1);
    // Both pages must exist in the quest's narrative-page bank.
    expect(QUEST2.pages[w1.endOfWave.bothSurvive]).toBeDefined();
    expect(QUEST2.pages[w1.endOfWave.anyDie]).toBeDefined();
  });

  it("wave 1 references only enemy ids that exist in the catalog", () => {
    const w1 = getQuestWave(QUEST2, 1);
    // Boss must resolve.
    expect(() => getEnemy(w1.bossEnemyId)).not.toThrow();
    // All minions must resolve.
    for (const id of w1.minionEnemyIds) {
      expect(() => getEnemy(id)).not.toThrow();
    }
  });

  it("wave 2 references only enemy ids that exist in the catalog", () => {
    // Wave 2 is now wired: boss + minions must resolve. This
    // replaces the earlier "TBD" guard which required Phase C
    // wiring to fail loudly; the Wave 2 implementation ships
    // Hundredeyes + 7 Ophidians, so resolution is the new
    // success criterion.
    const w2 = getQuestWave(QUEST2, 2);
    expect(() => getEnemy(w2.bossEnemyId)).not.toThrow();
    for (const id of w2.minionEnemyIds) {
      expect(() => getEnemy(id)).not.toThrow();
    }
  });

  it("wave 2 routes end-of-wave to the authored pages", () => {
    const w2 = getQuestWave(QUEST2, 2);
    expect(QUEST2.pages[w2.endOfWave.bothSurvive]).toBeDefined();
    expect(QUEST2.pages[w2.endOfWave.anyDie]).toBeDefined();
  });

  it("wave 3 references only enemy ids that exist in the catalog", () => {
    // Wave 3 ships Sporecloud (7 minions) + Death Cap (boss).
    // Mirrors the W1 + W2 resolution guards; replaces the
    // earlier "TBD" fail-loud guard which required Wave 3
    // wiring to throw.
    const w3 = getQuestWave(QUEST2, 3);
    expect(() => getEnemy(w3.bossEnemyId)).not.toThrow();
    for (const id of w3.minionEnemyIds) {
      expect(() => getEnemy(id)).not.toThrow();
    }
  });

  it("wave 3 routes end-of-wave to the authored pages", () => {
    const w3 = getQuestWave(QUEST2, 3);
    expect(QUEST2.pages[w3.endOfWave.bothSurvive]).toBeDefined();
    expect(QUEST2.pages[w3.endOfWave.anyDie]).toBeDefined();
  });
});

describe("Q2 Wave 1 enemy data (Venena + Goldmonger)", () => {
  const venenaIds = [
    "venena-008", "venena-009", "venena-010", "venena-011",
    "venena-012", "venena-013", "venena-014",
  ];

  it("ships all 7 Venena cards (numbers 8..14)", () => {
    for (const id of venenaIds) {
      const e = getEnemy(id);
      expect(e.kind).toBe("minion");
      expect(e.family).toBe("Venena");
      expect(e.hp).toBe(3);
      expect(e.attack).toBe(1);
    }
  });

  it("ships Goldmonger as a level-1 boss", () => {
    const g = getEnemy("goldmonger-002");
    expect(g.kind).toBe("boss-lvl-1");
    expect(g.family).toBe("Goldmonger");
    expect(g.hp).toBe(16);
    expect(g.attack).toBe(2);
    expect(g.onDeath.drops).toContain("boss-part-lvl-1");
  });

  it("every Q2 W1 enemy has exactly one Fatal Flaw ability with the printed tier", () => {
    // Tiers transcribed from the printed cards. If a tier here
    // disagrees with the source PDF, fix the JSON — this test
    // exists to make that mistake loud.
    const expectedTier: Record<string, number> = {
      "venena-008": 1, "venena-009": 1,                       // FF tier 1
      "venena-010": 2, "venena-011": 2,                       // FF tier 2
      "venena-012": 3, "venena-013": 3, "goldmonger-002": 3,  // FF tier 3
      "venena-014": 4,                                         // FF tier 4
    };
    for (const [id, tier] of Object.entries(expectedTier)) {
      const e = getEnemy(id);
      const ff = e.abilities.find((a): a is Extract<EnemyAbility, { kind: "fatal-flaw" }> => a.kind === "fatal-flaw");
      expect(ff, `${id} should carry a fatal-flaw ability`).toBeDefined();
      expect(ff!.level, `${id} fatal-flaw tier`).toBe(tier);
    }
  });

  it("Venena 011 carries the lose-xp parting shot (new Q2 variant)", () => {
    const e = getEnemy("venena-011");
    expect(e.partingShot.kind).toBe("all-delvers-lose-xp");
    if (e.partingShot.kind === "all-delvers-lose-xp") {
      expect(e.partingShot.amount).toBe(2);
    }
  });

  it("Venena 012 carries the lose-elements parting shot (amount=all)", () => {
    const e = getEnemy("venena-012");
    expect(e.partingShot.kind).toBe("all-delvers-lose-elements");
    if (e.partingShot.kind === "all-delvers-lose-elements") {
      expect(e.partingShot.amount).toBe("all");
    }
  });

  it("Goldmonger carries the damage+lose-xp combo parting shot", () => {
    const g = getEnemy("goldmonger-002");
    expect(g.partingShot.kind).toBe("all-delvers-damage-and-lose-xp");
    if (g.partingShot.kind === "all-delvers-damage-and-lose-xp") {
      expect(g.partingShot.damage).toBe(2);
      expect(g.partingShot.amount).toBe("all");
    }
  });

  it("Q1 enemies still have empty abilities arrays (backfilled, not retro-modeled)", () => {
    // Crystanid + Soulhunter print no Fatal Flaw / Rotates /
    // Primordial / Teleports text on their cards. The Phase A
    // backfill set abilities to [] for all 8 — confirm we
    // didn't accidentally retro-add anything.
    for (const id of [
      "crystanid-001", "crystanid-002", "crystanid-003",
      "crystanid-004", "crystanid-005", "crystanid-006",
      "crystanid-007", "soulhunter-001",
    ]) {
      expect(getEnemy(id).abilities).toEqual([]);
    }
  });
});

describe("Q2 Wave 2 enemy data (Ophidian + Hundredeyes)", () => {
  const ophidianIds = [
    "ophidian-015", "ophidian-016", "ophidian-017", "ophidian-018",
    "ophidian-019", "ophidian-020", "ophidian-021",
  ];

  it("ships all 7 Ophidian cards (numbers 15..21)", () => {
    for (const id of ophidianIds) {
      const e = getEnemy(id);
      expect(e.kind).toBe("minion");
      expect(e.family).toBe("Ophidian");
      // Printed: 6 HP / 2 ATK / Rotates. All 7 share the same line.
      expect(e.hp).toBe(6);
      expect(e.attack).toBe(2);
    }
  });

  it("ships Hundredeyes as a level-2 boss", () => {
    const h = getEnemy("hundredeyes-003");
    expect(h.kind).toBe("boss-lvl-2");
    expect(h.family).toBe("Hundredeyes");
    expect(h.hp).toBe(24);
    expect(h.attack).toBe(3);
    expect(h.onDeath.drops).toContain("boss-part-lvl-2");
  });

  it("every Q2 W2 enemy carries exactly the Rotates ability (no other passives)", () => {
    for (const id of [...ophidianIds, "hundredeyes-003"]) {
      const e = getEnemy(id);
      expect(e.abilities.length, `${id} should have exactly 1 passive ability`).toBe(1);
      expect(e.abilities[0]!.kind, `${id} ability kind`).toBe("rotates");
    }
  });

  it("Ophidian 017 + 019 carry the lose-elements parting shot (amount=all)", () => {
    // Both cards print "Lose ALL Elements." (Ophidian 019 prefixes
    // it with "Delver's" but the mechanic is identical — drain
    // every delver's bag).
    for (const id of ["ophidian-017", "ophidian-019"]) {
      const e = getEnemy(id);
      expect(e.partingShot.kind).toBe("all-delvers-lose-elements");
      if (e.partingShot.kind === "all-delvers-lose-elements") {
        expect(e.partingShot.amount).toBe("all");
      }
    }
  });

  it("Ophidian 018 carries the lose-xp parting shot (amount=3)", () => {
    const e = getEnemy("ophidian-018");
    expect(e.partingShot.kind).toBe("all-delvers-lose-xp");
    if (e.partingShot.kind === "all-delvers-lose-xp") {
      expect(e.partingShot.amount).toBe(3);
    }
  });

  it("Hundredeyes carries the damage+lose-elements combo parting shot", () => {
    const h = getEnemy("hundredeyes-003");
    expect(h.partingShot.kind).toBe("all-delvers-damage-and-lose-elements");
    if (h.partingShot.kind === "all-delvers-damage-and-lose-elements") {
      // Printed: "3 Damage & lose ALL Elements."
      expect(h.partingShot.damage).toBe(3);
      expect(h.partingShot.amount).toBe("all");
    }
  });

  it("every Q2 W2 enemy has non-empty counter patterns", () => {
    // Defensive: an empty counter pattern would make the
    // Rotates ability mechanically pointless. The printed
    // cards all show chevrons on the border, so we expect at
    // least one common + one uncommon entry per enemy.
    for (const id of [...ophidianIds, "hundredeyes-003"]) {
      const e = getEnemy(id);
      expect(e.counterCommon.length, `${id} counterCommon`).toBeGreaterThan(0);
      expect(e.counterUncommon.length, `${id} counterUncommon`).toBeGreaterThan(0);
    }
  });
});

describe("Q2 Wave 3 enemy data (Sporecloud + Death Cap)", () => {
  const sporecloudIds = [
    "sporecloud-022", "sporecloud-023", "sporecloud-024", "sporecloud-025",
    "sporecloud-026", "sporecloud-027", "sporecloud-028",
  ];

  it("ships all 7 Sporecloud cards (numbers 22..28)", () => {
    for (const id of sporecloudIds) {
      const e = getEnemy(id);
      expect(e.kind).toBe("minion");
      expect(e.family).toBe("Sporecloud");
      // Printed: 12 HP / 2 ATK / Primordial.
      expect(e.hp).toBe(12);
      expect(e.attack).toBe(2);
    }
  });

  it("ships Death Cap as a level-3 boss", () => {
    const d = getEnemy("deathcap-004");
    expect(d.kind).toBe("boss-lvl-3");
    expect(d.family).toBe("Death Cap");
    expect(d.hp).toBe(50);
    expect(d.attack).toBe(3);
    expect(d.onDeath.drops).toContain("boss-part-lvl-3");
  });

  it("every Sporecloud carries exactly one Primordial ability with two elements", () => {
    // The printed cards each call out exactly two of the six
    // elements (rulebook p20). The engine's Primordial gate
    // uses `elements.includes(slotElement)`; both elements
    // need to be present + distinct or the gate would silently
    // narrow.
    for (const id of sporecloudIds) {
      const e = getEnemy(id);
      expect(e.abilities.length, `${id} ability count`).toBe(1);
      const ab = e.abilities[0]!;
      expect(ab.kind, `${id} ability kind`).toBe("primordial");
      if (ab.kind === "primordial") {
        expect(ab.elements.length, `${id} primordial element count`).toBe(2);
        expect(new Set(ab.elements).size, `${id} primordial elements distinct`).toBe(2);
      }
    }
  });

  // Regression (player report 2026-07-20): a Beam exhausted onto a
  // VOID slot failed to damage Sporecloud 028, whose card prints
  // Primordial fire + void — the extraction had recorded fire +
  // radiance, so the engine's Primordial gate zeroed a legal hit.
  // Full family audit against the card JPGs found THREE distinct
  // icon misreads (radiance star -> wind on 023; wind spiral ->
  // void on 024/025; void crescent -> radiance on 027/028). This
  // pins the whole verified table, including the 027/028 on-death
  // element drops which carried the same misread.
  it("every Sporecloud's Primordial elements match the printed card", () => {
    const printed: Record<string, string[]> = {
      "sporecloud-022": ["water", "fire"],
      "sporecloud-023": ["radiance", "fire"],
      "sporecloud-024": ["wind", "water"],
      "sporecloud-025": ["wind", "fire"],
      "sporecloud-026": ["earth", "fire"],
      "sporecloud-027": ["earth", "void"],
      "sporecloud-028": ["fire", "void"],
    };
    for (const [id, elements] of Object.entries(printed)) {
      const ab = getEnemy(id).abilities[0]!;
      expect(ab.kind, id).toBe("primordial");
      if (ab.kind === "primordial") {
        expect([...ab.elements].sort(), `${id} primordial`).toEqual([...elements].sort());
      }
    }
  });

  it("Sporecloud 027/028 on-death element drops match the printed cards", () => {
    expect(getEnemy("sporecloud-027").onDeath.gainElements).toEqual(["earth", "void"]);
    expect(getEnemy("sporecloud-028").onDeath.gainElements).toEqual(["fire", "void"]);
  });

  it("Death Cap carries exactly the Teleports ability (no Primordial)", () => {
    const d = getEnemy("deathcap-004");
    expect(d.abilities.length).toBe(1);
    expect(d.abilities[0]!.kind).toBe("teleports");
  });

  // Regression (player report 2026-07-20): a player standing in Death
  // Cap's printed UNCOMMON tiles was hit by a COMMON roll — the
  // extracted counter offsets bore no resemblance to the card. This
  // pins the pattern decoded from 4x zoom crops of the card's edge
  // glyphs (WHITE = common 2-5, BLACK = uncommon 6; N stacked
  // chevrons in a direction cover distances 1..N):
  //   WHITE: NW x2, N x3, NE x3, W x3, E x3
  //   BLACK: SW x3, S x1, SE x3
  it("Death Cap counter patterns match the printed card arrows", () => {
    const d = getEnemy("deathcap-004");
    const sort = (a: { dx: number; dy: number }[]) =>
      [...a].sort((p, q) => p.dx - q.dx || p.dy - q.dy);
    expect(sort(d.counterCommon)).toEqual(sort([
      { dx: -1, dy: -1 }, { dx: -2, dy: -2 },                       // NW x2
      { dx: 0, dy: -1 }, { dx: 0, dy: -2 }, { dx: 0, dy: -3 },      // N x3
      { dx: 1, dy: -1 }, { dx: 2, dy: -2 }, { dx: 3, dy: -3 },      // NE x3
      { dx: -1, dy: 0 }, { dx: -2, dy: 0 }, { dx: -3, dy: 0 },      // W x3
      { dx: 1, dy: 0 }, { dx: 2, dy: 0 }, { dx: 3, dy: 0 },         // E x3
    ]));
    expect(sort(d.counterUncommon)).toEqual(sort([
      { dx: -1, dy: 1 }, { dx: -2, dy: 2 }, { dx: -3, dy: 3 },      // SW x3
      { dx: 0, dy: 1 },                                              // S x1
      { dx: 1, dy: 1 }, { dx: 2, dy: 2 }, { dx: 3, dy: 3 },         // SE x3
    ]));
    // The two patterns must not overlap — a tile is either white or
    // black on the printed card, never both.
    const commonKeys = new Set(d.counterCommon.map((o) => `${o.dx},${o.dy}`));
    for (const o of d.counterUncommon) {
      expect(commonKeys.has(`${o.dx},${o.dy}`), `overlap at ${o.dx},${o.dy}`).toBe(false);
    }
  });

  it("Death Cap carries the damage+discard-consumable combo parting shot", () => {
    const d = getEnemy("deathcap-004");
    expect(d.partingShot.kind).toBe("all-delvers-damage-and-discard-consumable");
    if (d.partingShot.kind === "all-delvers-damage-and-discard-consumable") {
      // Printed: "4 Damage & Discard 1 Consumable."
      expect(d.partingShot.damage).toBe(4);
      expect(d.partingShot.count).toBe(1);
    }
  });

  it("Sporecloud 024 carries the lose-elements parting shot (amount=all)", () => {
    const e = getEnemy("sporecloud-024");
    expect(e.partingShot.kind).toBe("all-delvers-lose-elements");
    if (e.partingShot.kind === "all-delvers-lose-elements") {
      expect(e.partingShot.amount).toBe("all");
    }
  });

  it("Sporecloud 025 carries the lose-xp parting shot (amount=4)", () => {
    const e = getEnemy("sporecloud-025");
    expect(e.partingShot.kind).toBe("all-delvers-lose-xp");
    if (e.partingShot.kind === "all-delvers-lose-xp") {
      expect(e.partingShot.amount).toBe(4);
    }
  });

  it("Sporecloud 026 + 027 carry the delvers-within parting shot (range=2)", () => {
    for (const [id, dmg] of [["sporecloud-026", 2], ["sporecloud-027", 4]] as const) {
      const e = getEnemy(id);
      expect(e.partingShot.kind).toBe("delvers-within");
      if (e.partingShot.kind === "delvers-within") {
        expect(e.partingShot.range).toBe(2);
        expect(e.partingShot.damage).toBe(dmg);
      }
    }
  });

  it("every Q2 W3 enemy has non-empty counter patterns", () => {
    for (const id of [...sporecloudIds, "deathcap-004"]) {
      const e = getEnemy(id);
      expect(e.counterCommon.length, `${id} counterCommon`).toBeGreaterThan(0);
      expect(e.counterUncommon.length, `${id} counterUncommon`).toBeGreaterThan(0);
    }
  });
});

// --- Venena on-death element drops (player report 2026-07-20) --------------
//
// The PDF extraction misread the printed RADIANCE star icon as a WIND
// spiral on Venena 012 + 013, so players were granted wind ("air")
// where the card displays radiance. Mapping below verified against
// the card JPGs (designer-confirmed):
//   008 = earth + fire, 012 = water + radiance, 013 = radiance + earth.
describe("Venena on-death element drops match the printed cards", () => {
  it.each([
    ["venena-008", ["earth", "fire"]],
    ["venena-012", ["water", "radiance"]],
    ["venena-013", ["radiance", "earth"]],
  ])("%s grants %j", (id, elements) => {
    expect(getEnemy(id as string).onDeath.gainElements).toEqual(elements);
  });

  it("the other Venenas grant XP, not elements", () => {
    for (const id of ["venena-009", "venena-010", "venena-011", "venena-014"]) {
      expect(getEnemy(id).onDeath.gainElements ?? [], id).toEqual([]);
      expect(getEnemy(id).onDeath.gainXp, id).toBeGreaterThan(0);
    }
  });
});
