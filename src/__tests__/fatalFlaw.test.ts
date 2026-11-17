/**
 * Tests for the Fatal Flaw ability (rulebook p16) — Q2 W1+
 * mechanic that pins a tier-N enemy at >= 1 HP for as long as
 * ANY tier-(N-1)-or-lower enemy is still alive. Q2 W1 ships
 * Venena (tier 1) and Goldmonger (tier 2), so Goldmonger is
 * unkillable until all 7 Venena have been cleared.
 *
 * Covers three layers:
 *   - Pure helpers (`getFatalFlawTier`, `isFatalFlawProtected`,
 *     `clampDamageForFatalFlaw`)
 *   - Engine damage path (`applyDamageAtTile`,
 *     `resolveAllDamage`) — protected enemies pin at 1 HP and
 *     stay alive even on otherwise-fatal hits.
 *   - BoardToken populationd (`buildEncounterTokens` emits
 *     `fatalFlawTier` + `fatalFlawProtected` so renderers can
 *     stamp the L1/L2 pip + lock glow).
 *
 * Q1 regression — `Crystanid`/`Soulhunter` have no `fatal-flaw`
 * ability, so existing combat tests should be unaffected.
 */

import { describe, it, expect } from "vitest";

import { newCampaign, type CampaignState } from "../state";
import { QUEST1, QUEST2, getEnemy } from "../data";
import {
  clampDamageForFatalFlaw,
  ensureEncounter,
  getFatalFlawTier,
  isFatalFlawProtected,
  type EncounterBuildHooks,
} from "../engine/encounter";
import { applyDamageAtTile, resolveAllDamage, buildAttackSession } from "../engine/combat";
import { buildEncounterTokens } from "../board/tideBoard";

const noShuffle = (pool: readonly string[]) => [...pool];

function pinnedHooks(spawnCardNumber: number = 1): EncounterBuildHooks {
  return {
    assign: noShuffle,
    drawSpawnCardNumber: () => spawnCardNumber,
  };
}

function freshState(): CampaignState {
  return newCampaign();
}

// --- Helpers ------------------------------------------------------------

describe("getFatalFlawTier", () => {
  // Q2 W1 ships a 4-tier ladder (per the printed enemy cards):
  //   tier 1 = Venena 008, 009
  //   tier 2 = Venena 010, 011
  //   tier 3 = Venena 012, 013, Goldmonger
  //   tier 4 = Venena 014
  it("returns the level for the lowest-tier Venenas (008/009 = tier 1)", () => {
    expect(getFatalFlawTier(getEnemy("venena-008"))).toBe(1);
    expect(getFatalFlawTier(getEnemy("venena-009"))).toBe(1);
  });

  it("returns the level for Goldmonger (shares tier 3 with Venena 012/013)", () => {
    expect(getFatalFlawTier(getEnemy("goldmonger-002"))).toBe(3);
    expect(getFatalFlawTier(getEnemy("venena-012"))).toBe(3);
    expect(getFatalFlawTier(getEnemy("venena-013"))).toBe(3);
  });

  it("returns the level for the top-of-ladder Venena 014 (tier 4)", () => {
    expect(getFatalFlawTier(getEnemy("venena-014"))).toBe(4);
  });

  it("returns null for Q1 enemies that don't carry the ability", () => {
    expect(getFatalFlawTier(getEnemy("crystanid-001"))).toBeNull();
    expect(getFatalFlawTier(getEnemy("soulhunter-001"))).toBeNull();
  });
});

// Convenience finders for Q2 W1's tier ladder. The `pinnedHooks`
// minion-pool order keeps `venena-008..014` mapped 1:1 onto
// `minion-0..minion-6`, so these stay stable across test runs.
function tier1(enc: ReturnType<typeof ensureEncounter>) {
  return enc.enemies.filter((e) => e.cardId === "venena-008" || e.cardId === "venena-009");
}
function tier2(enc: ReturnType<typeof ensureEncounter>) {
  return enc.enemies.filter((e) => e.cardId === "venena-010" || e.cardId === "venena-011");
}
function tier3Minions(enc: ReturnType<typeof ensureEncounter>) {
  return enc.enemies.filter((e) => e.cardId === "venena-012" || e.cardId === "venena-013");
}
function tier4(enc: ReturnType<typeof ensureEncounter>) {
  return enc.enemies.filter((e) => e.cardId === "venena-014");
}
function boss(enc: ReturnType<typeof ensureEncounter>) {
  return enc.enemies.find((e) => e.instanceId === "boss")!;
}

describe("isFatalFlawProtected", () => {
  it("Goldmonger (tier 3) is PROTECTED at wave start (tiers 1+2 alive)", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    expect(isFatalFlawProtected(enc, boss(enc))).toBe(true);
  });

  it("Goldmonger STAYS protected with only tier 1 cleared (tier 2 still alive)", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    for (const e of tier1(enc)) e.alive = false;
    expect(isFatalFlawProtected(enc, boss(enc))).toBe(true);
  });

  it("Goldmonger becomes UNPROTECTED once tiers 1+2 are all cleared", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    for (const e of [...tier1(enc), ...tier2(enc)]) e.alive = false;
    expect(isFatalFlawProtected(enc, boss(enc))).toBe(false);
  });

  it("Same-tier siblings DON'T block each other (Venena 012 vs 013 vs Goldmonger)", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    for (const e of [...tier1(enc), ...tier2(enc)]) e.alive = false;
    // tier 3 has 3 members alive: Goldmonger + venena-012 + venena-013.
    // None should be gating any of the others.
    for (const t3 of [boss(enc), ...tier3Minions(enc)]) {
      expect(isFatalFlawProtected(enc, t3)).toBe(false);
    }
  });

  it("Tier 1 (Venena 008/009) is NEVER protected — nothing is lower-tier", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    for (const t1 of tier1(enc)) {
      expect(isFatalFlawProtected(enc, t1)).toBe(false);
    }
  });

  it("Tier 4 (Venena 014) requires tiers 1+2+3 ALL cleared (including Goldmonger)", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    const v14 = tier4(enc)[0]!;
    // Even with tiers 1+2 cleared, Goldmonger (tier 3) still protects 014.
    for (const e of [...tier1(enc), ...tier2(enc)]) e.alive = false;
    expect(isFatalFlawProtected(enc, v14)).toBe(true);
    // Drop the remaining tier-3 siblings, INCLUDING Goldmonger.
    for (const e of [...tier3Minions(enc), boss(enc)]) e.alive = false;
    expect(isFatalFlawProtected(enc, v14)).toBe(false);
  });

  it("Q1 enemies (no Fatal Flaw) are NEVER protected", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST1, noShuffle);
    for (const e of enc.enemies) {
      expect(isFatalFlawProtected(enc, e)).toBe(false);
    }
  });

  it("does NOT count the enemy itself as a blocker (self-tier guard)", () => {
    // Defensive — if we accidentally included the enemy in the
    // alive-scan, a same-tier enemy would protect itself if its
    // own tier counted as "< its own". The exclusion happens via
    // an `instanceId` match in `isFatalFlawProtected`.
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    for (const t1 of tier1(enc)) {
      expect(isFatalFlawProtected(enc, t1)).toBe(false);
    }
  });
});

describe("clampDamageForFatalFlaw", () => {
  it("tier-1 (always-unprotected) Venena takes the full damage delta", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    const v1 = tier1(enc)[0]!;
    const card = getEnemy(v1.cardId);
    const out = clampDamageForFatalFlaw(enc, v1, 999);
    expect(out.newDamageTaken).toBe(999);
    expect(out.blocked).toBe(false);
    expect(out.absorbed).toBe(0);
    // Sanity — 999 >> Venena HP, so the caller's killed check
    // would correctly flag it dead.
    expect(out.newDamageTaken).toBeGreaterThanOrEqual(card.hp);
  });

  it("protected Goldmonger gets pinned at maxHp - 1 on otherwise-fatal damage", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    const b = boss(enc);
    const card = getEnemy(b.cardId);
    const out = clampDamageForFatalFlaw(enc, b, card.hp + 5);
    expect(out.newDamageTaken).toBe(card.hp - 1);
    expect(out.blocked).toBe(true);
    expect(out.absorbed).toBe(card.hp + 5 - (card.hp - 1));
  });

  it("protected Goldmonger takes NORMAL (non-clamped) damage on a non-fatal hit", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    const b = boss(enc);
    const out = clampDamageForFatalFlaw(enc, b, 1);
    expect(out.newDamageTaken).toBe(1);
    expect(out.blocked).toBe(false);
  });
});

// --- applyDamageAtTile (single-tile damage path) ------------------------

describe("applyDamageAtTile — Fatal Flaw enforcement", () => {
  it("protected Goldmonger survives an otherwise-fatal single hit (pinned at 1 HP, alive)", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    const b = boss(enc);
    const card = getEnemy(b.cardId);
    const result = applyDamageAtTile(state, b.x, b.y, 999);
    expect(result.killed).toBe(false);
    expect(result.enemy).toBe(b);
    expect(b.alive).toBe(true);
    expect(b.damageTaken).toBe(card.hp - 1);
  });

  it("Goldmonger (tier 3) becomes killable once tiers 1+2 are all cleared", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    for (const e of [...tier1(enc), ...tier2(enc)]) e.alive = false;
    const b = boss(enc);
    const card = getEnemy(b.cardId);
    const result = applyDamageAtTile(state, b.x, b.y, 999);
    expect(result.killed).toBe(true);
    expect(b.alive).toBe(false);
    expect(b.damageTaken).toBeGreaterThanOrEqual(card.hp);
  });

  it("Tier 2 Venena (010) is pinned at 1 HP while tier 1 (008/009) lives", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    const v10 = tier2(enc)[0]!;
    const card = getEnemy(v10.cardId);
    const result = applyDamageAtTile(state, v10.x, v10.y, 999);
    expect(result.killed).toBe(false);
    expect(v10.alive).toBe(true);
    expect(v10.damageTaken).toBe(card.hp - 1);
  });

  it("Q1 regression — Crystanid takes a normal fatal hit (no clamp)", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST1, noShuffle);
    const minion = enc.enemies.find((e) => e.instanceId === "minion-0")!;
    const card = getEnemy(minion.cardId);
    const result = applyDamageAtTile(state, minion.x, minion.y, card.hp + 10);
    expect(result.killed).toBe(true);
    expect(minion.alive).toBe(false);
  });
});

// --- resolveAllDamage (multi-tile attack-session path) ------------------

// Minimal AttackSource the engine accepts. The synthesized session
// never actually fires counters / kills, so the slot/card ids only
// need to be syntactically valid.
const TEST_SOURCE = { kind: "weapon" as const, slotIdx: 0, cardId: "weapon-test" };

describe("resolveAllDamage — Fatal Flaw enforcement", () => {
  it("protected Goldmonger survives an attack-session fatal hit (step.killed = false)", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    const b = boss(enc);
    const card = getEnemy(b.cardId);
    const session = buildAttackSession({
      attackerId: "hero-01",
      source: TEST_SOURCE,
      damage: card.hp + 5,
      hitTiles: [{ x: b.x, y: b.y }],
    });
    resolveAllDamage(state, session);
    const step = session.steps[0]!;
    expect(step.killed).toBe(false);
    expect(b.damageTaken).toBe(card.hp - 1);
    // `damageApplied` reflects what actually landed (post-clamp),
    // not the raw `session.damage`.
    expect(step.damageApplied).toBe(card.hp - 1);
  });

  it("multi-tile shockwave through the last alive tier-2 Venena -> Goldmonger kills BOTH (chain-through)", () => {
    // Chain-through behaviour (combat.ts > resolveAllDamage + the
    // `damageTaken >= hp` short-circuit in `isFatalFlawProtected`):
    // when an in-flight attack lethals the last lower-tier blocker
    // earlier in the batch, the Fatal Flaw ladder check treats
    // them as gone — so a higher-tier enemy hit later in the same
    // session can also die. `enemy.alive` is still deferred to
    // finalize (so the counter-prompt can still paint the dying
    // token), but the ladder check uses `damageTaken >= hp` as the
    // truth source.
    //
    // Setup: clear tier 1 entirely + kill one of the two tier-2s
    // so the only blocker is the Venena we're about to lethal in
    // the SAME session.
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    for (const e of tier1(enc)) e.alive = false;
    const t2 = tier2(enc);
    t2[1]!.alive = false;
    const lastT2 = t2[0]!;
    const b = boss(enc);
    const bossCard = getEnemy(b.cardId);
    const venenaCard = getEnemy(lastT2.cardId);
    const session = buildAttackSession({
      attackerId: "hero-01",
      source: TEST_SOURCE,
      damage: Math.max(venenaCard.hp, bossCard.hp) + 5,
      hitTiles: [
        { x: lastT2.x, y: lastT2.y },
        { x: b.x, y: b.y },
      ],
    });
    resolveAllDamage(state, session);
    const venenaStep = session.steps[0]!;
    const bossStep = session.steps[1]!;
    expect(venenaStep.killed).toBe(true);
    expect(lastT2.damageTaken).toBeGreaterThanOrEqual(venenaCard.hp);
    expect(bossStep.killed).toBe(true);
    expect(b.damageTaken).toBeGreaterThanOrEqual(bossCard.hp);
  });

  it("with tiers 1+2 already alive=false, an attack on Goldmonger lands the kill", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    for (const e of [...tier1(enc), ...tier2(enc)]) e.alive = false;
    const b = boss(enc);
    const card = getEnemy(b.cardId);
    const session = buildAttackSession({
      attackerId: "hero-01",
      source: TEST_SOURCE,
      damage: card.hp + 5,
      hitTiles: [{ x: b.x, y: b.y }],
    });
    resolveAllDamage(state, session);
    const step = session.steps[0]!;
    expect(step.killed).toBe(true);
    expect(b.damageTaken).toBeGreaterThanOrEqual(card.hp);
  });

  // Regression (playtester report 2026-07-22): a Gauntlet chain that
  // hit EVERY enemy on the board only killed the tier-1s. The
  // in-loop ladder check is tile-order-dependent — if a tier-2 enemy
  // is processed BEFORE the tier-1s in the same batch, it was pinned
  // at 1 HP even though the same attack killed all its blockers.
  // Designer ruling: damage in one attack is simultaneous — the
  // cascade pass re-lifts the clamp once the batch lethals every
  // lower tier, regardless of tile order.
  it("REVERSED ORDER: tier-2 hit BEFORE the last tier-1 still dies (order-independent cascade)", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    for (const e of tier1(enc)) e.alive = false;
    const t2 = tier2(enc);
    t2[1]!.alive = false;
    const lastT2 = t2[0]!;
    const b = boss(enc);
    const bossCard = getEnemy(b.cardId);
    const venenaCard = getEnemy(lastT2.cardId);
    const session = buildAttackSession({
      attackerId: "hero-01",
      source: TEST_SOURCE,
      damage: Math.max(venenaCard.hp, bossCard.hp) + 5,
      // BOSS FIRST — the order that used to leave it pinned at 1 HP.
      hitTiles: [
        { x: b.x, y: b.y },
        { x: lastT2.x, y: lastT2.y },
      ],
    });
    resolveAllDamage(state, session);
    const bossStep = session.steps[0]!;
    const venenaStep = session.steps[1]!;
    expect(venenaStep.killed).toBe(true);
    expect(bossStep.killed).toBe(true);
    expect(b.damageTaken).toBeGreaterThanOrEqual(bossCard.hp);
  });

  it("REVERSED ORDER: full-board sweep kills every tier in one attack (the playtester's Gauntlet chain)", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    // Hit EVERY alive enemy, deliberately ordered highest tier first.
    const alive = enc.enemies.filter((e) => e.alive);
    const tiers = new Map(alive.map((e) => [e.instanceId, getFatalFlawTier(getEnemy(e.cardId)) ?? 0]));
    const ordered = [...alive].sort((a, b2) => tiers.get(b2.instanceId)! - tiers.get(a.instanceId)!);
    const maxHp = Math.max(...alive.map((e) => getEnemy(e.cardId).hp));
    const session = buildAttackSession({
      attackerId: "hero-01",
      source: TEST_SOURCE,
      damage: maxHp + 5,
      hitTiles: ordered.map((e) => ({ x: e.x, y: e.y })),
    });
    resolveAllDamage(state, session);
    for (const step of session.steps) {
      expect(step.killed, `step for ${step.enemyInstanceId}`).toBe(true);
    }
  });

  it("NO cascade when a lower-tier blocker SURVIVES the batch (tier-2 stays pinned)", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    // Tier 1 has two members; hit only ONE of them plus a tier-2.
    const [t1a] = tier1(enc);
    const t2a = tier2(enc)[0]!;
    const t2card = getEnemy(t2a.cardId);
    const session = buildAttackSession({
      attackerId: "hero-01",
      source: TEST_SOURCE,
      damage: t2card.hp + 5,
      hitTiles: [
        { x: t2a.x, y: t2a.y },
        { x: t1a!.x, y: t1a!.y },
      ],
    });
    resolveAllDamage(state, session);
    // The un-hit tier-1 sibling still blocks: tier-2 pinned at 1 HP.
    expect(session.steps[0]!.killed).toBe(false);
    expect(t2a.damageTaken).toBe(t2card.hp - 1);
  });

  it("same-tier siblings hit in the same session BOTH die (no mutual protection)", () => {
    // tier-2 Venena 010 + 011 are same-tier, so neither protects
    // the other — a single shockwave hitting both should kill
    // both (provided tier 1 is already cleared so the post-kill
    // bookkeeping is sane).
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    for (const e of tier1(enc)) e.alive = false;
    const [t2a, t2b] = tier2(enc);
    const card = getEnemy(t2a!.cardId);
    const session = buildAttackSession({
      attackerId: "hero-01",
      source: TEST_SOURCE,
      damage: card.hp + 5,
      hitTiles: [
        { x: t2a!.x, y: t2a!.y },
        { x: t2b!.x, y: t2b!.y },
      ],
    });
    resolveAllDamage(state, session);
    expect(session.steps[0]!.killed).toBe(true);
    expect(session.steps[1]!.killed).toBe(true);
  });
});

// --- buildEncounterTokens — badge data plumbing -------------------------

describe("buildEncounterTokens — Fatal Flaw token fields", () => {
  it("Q2 W1 boss token carries tier 3 + protected=true at wave start", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    const tokens = buildEncounterTokens(enc);
    const bossTok = tokens.find((t) => t.id === "boss")!;
    expect(bossTok.fatalFlawTier).toBe(3);
    expect(bossTok.fatalFlawProtected).toBe(true);
  });

  it("Tier-1 Venena tokens (008/009) at wave start: tier=1, protected=false", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    const tokens = buildEncounterTokens(enc);
    const t1Toks = tokens.filter((t) => t.cardId === "venena-008" || t.cardId === "venena-009");
    expect(t1Toks.length).toBe(2);
    for (const t of t1Toks) {
      expect(t.fatalFlawTier).toBe(1);
      expect(t.fatalFlawProtected).toBe(false);
    }
  });

  it("Tier-2 Venena tokens (010/011) at wave start: tier=2, protected=true (tier 1 alive)", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    const tokens = buildEncounterTokens(enc);
    const t2Toks = tokens.filter((t) => t.cardId === "venena-010" || t.cardId === "venena-011");
    expect(t2Toks.length).toBe(2);
    for (const t of t2Toks) {
      expect(t.fatalFlawTier).toBe(2);
      expect(t.fatalFlawProtected).toBe(true);
    }
  });

  it("Tier-4 Venena 014 carries tier=4 + protected=true at wave start", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    const tokens = buildEncounterTokens(enc);
    const t4 = tokens.find((t) => t.cardId === "venena-014")!;
    expect(t4.fatalFlawTier).toBe(4);
    expect(t4.fatalFlawProtected).toBe(true);
  });

  it("Boss flips to protected=false once tiers 1+2 are fully cleared", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST2, pinnedHooks(1));
    for (const e of [...tier1(enc), ...tier2(enc)]) e.alive = false;
    const tokens = buildEncounterTokens(enc);
    const bossTok = tokens.find((t) => t.id === "boss")!;
    expect(bossTok.fatalFlawProtected).toBe(false);
  });

  it("Q1 enemy tokens carry fatalFlawTier=null + fatalFlawProtected=false", () => {
    const state = freshState();
    const enc = ensureEncounter(state, QUEST1, noShuffle);
    const tokens = buildEncounterTokens(enc).filter((t) => t.kind === "boss" || t.kind === "minion");
    for (const t of tokens) {
      expect(t.fatalFlawTier).toBeNull();
      expect(t.fatalFlawProtected).toBe(false);
    }
  });
});
