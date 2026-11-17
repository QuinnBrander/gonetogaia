/**
 * Full-catalog audit of every enemy's element-bearing data against
 * the printed card scans in `public/cards/enemy_*.jpg`.
 *
 * Background: the PDF extraction misread element icons on SEVEN
 * cards (found via player reports 2026-07-20):
 *   - radiance star  -> wind    (venena-012/013 drops, sporecloud-023 primordial)
 *   - wind spiral    -> void    (sporecloud-024/025 primordial)
 *   - void crescent  -> radiance (sporecloud-027/028 primordial + drops)
 *
 * On 2026-07-20 every one of the 32 enemy card scans was viewed and
 * compared against `data/enemies.json`. The tables below pin that
 * verified state. If a future re-extraction (or hand edit) changes
 * any of these values, this test points straight at the card that
 * needs re-checking against its JPG.
 *
 * Icon legend (see data/elements.json iconHints):
 *   earth = brown pebble | wind = green spiral | fire = flame
 *   water = teardrop | void = purple crescent | radiance = white star
 */

import { describe, it, expect } from "vitest";

import { getEnemy } from "../data";
import type { Element } from "../types";

/** Verified on-death element drops (both delvers gain each listed element). */
const VERIFIED_ELEMENT_DROPS: Record<string, Element[]> = {
  "crystanid-001": ["earth", "wind"],
  "crystanid-005": ["wind", "void"],
  "crystanid-006": ["radiance", "earth"],
  "venena-008": ["earth", "fire"],
  "venena-012": ["water", "radiance"],
  "venena-013": ["radiance", "earth"],
  "ophidian-016": ["fire", "water"],
  "ophidian-018": ["fire", "earth"],
  "ophidian-020": ["water", "wind"],
  "sporecloud-026": ["earth", "fire"],
  "sporecloud-027": ["earth", "void"],
  "sporecloud-028": ["fire", "void"],
};

/** Verified on-death STATIC XP grants (shared pool). */
const VERIFIED_XP_DROPS: Record<string, number> = {
  "crystanid-002": 1,
  "crystanid-003": 2,
  "crystanid-004": 1,
  "crystanid-007": 1,
  "venena-009": 1,
  "venena-010": 2,
  "venena-011": 1,
  "venena-014": 1,
  "ophidian-015": 1,
  "ophidian-019": 3,
  "ophidian-021": 3,
  "sporecloud-023": 3,
  "sporecloud-024": 3,
  "sporecloud-025": 3,
};

/** Verified on-death XP DIE rewards — cards print "Gain 1 [die] XP",
 *  i.e. the player rolls a d6 in front of everyone (designer ruling
 *  2026-07-20; pre-fix the data flattened these to a silent 1 XP). */
const VERIFIED_XP_DICE: Record<string, number> = {
  "ophidian-017": 1,
  "sporecloud-022": 1,
};

/** Verified Primordial whitelists (Sporeclouds only; no other enemy prints it). */
const VERIFIED_PRIMORDIAL: Record<string, Element[]> = {
  "sporecloud-022": ["water", "fire"],
  "sporecloud-023": ["radiance", "fire"],
  "sporecloud-024": ["wind", "water"],
  "sporecloud-025": ["wind", "fire"],
  "sporecloud-026": ["earth", "fire"],
  "sporecloud-027": ["earth", "void"],
  "sporecloud-028": ["fire", "void"],
};

/** Bosses: no elements or XP printed — boss part + level up card only. */
const BOSS_IDS = ["soulhunter-001", "goldmonger-002", "hundredeyes-003", "deathcap-004"];

describe("enemy on-death element drops match the printed cards (full 2026-07-20 audit)", () => {
  it.each(Object.entries(VERIFIED_ELEMENT_DROPS))("%s grants %j", (id, elements) => {
    const e = getEnemy(id);
    expect([...(e.onDeath.gainElements ?? [])].sort()).toEqual([...elements].sort());
    expect(e.onDeath.gainXp ?? 0, `${id} should not also grant XP`).toBe(0);
  });

  it.each(Object.entries(VERIFIED_XP_DROPS))("%s grants %d XP (no elements)", (id, xp) => {
    const e = getEnemy(id);
    expect(e.onDeath.gainXp).toBe(xp);
    expect(e.onDeath.gainXpDice ?? 0, `${id} should not also grant dice XP`).toBe(0);
    expect(e.onDeath.gainElements ?? [], `${id} should not also grant elements`).toEqual([]);
  });

  it.each(Object.entries(VERIFIED_XP_DICE))("%s grants %d die of XP (player-rolled, no static XP)", (id, dice) => {
    const e = getEnemy(id);
    expect(e.onDeath.gainXpDice).toBe(dice);
    expect(e.onDeath.gainXp ?? 0, `${id} dice XP must not ALSO bank a static amount`).toBe(0);
    expect(e.onDeath.gainElements ?? []).toEqual([]);
  });
});

describe("Sporecloud Primordial whitelists match the printed cards (full 2026-07-20 audit)", () => {
  it.each(Object.entries(VERIFIED_PRIMORDIAL))("%s is vulnerable to %j", (id, elements) => {
    const ab = getEnemy(id).abilities.find((a) => a.kind === "primordial");
    expect(ab, `${id} missing primordial`).toBeDefined();
    if (ab?.kind === "primordial") {
      expect([...ab.elements].sort()).toEqual([...elements].sort());
    }
  });

  it("no enemy outside the Sporecloud family prints Primordial", () => {
    for (const id of [...Object.keys(VERIFIED_ELEMENT_DROPS), ...Object.keys(VERIFIED_XP_DROPS), ...Object.keys(VERIFIED_XP_DICE), ...BOSS_IDS]) {
      if (id.startsWith("sporecloud-")) continue;
      const abilities = getEnemy(id).abilities.filter((a) => a.kind === "primordial");
      expect(abilities, `${id} unexpectedly prints primordial`).toEqual([]);
    }
  });
});

describe("bosses grant boss part + level up card, never elements or XP", () => {
  it.each(BOSS_IDS)("%s", (id) => {
    const e = getEnemy(id);
    expect(e.onDeath.gainElements ?? []).toEqual([]);
    expect(e.onDeath.gainXp ?? 0).toBe(0);
    expect(e.onDeath.gainLevelUpCards).toBe(1);
    expect(e.onDeath.drops.some((d) => d.startsWith("boss-part-lvl-"))).toBe(true);
  });
});
