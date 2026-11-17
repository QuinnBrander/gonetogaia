/**
 * Chapter 4 quests #4 "A Hand Outstretched", #7 "Further Afield" and
 * #13 "Underneath the Watchtower": quest data + the 13 new enemy abilities
 * (engine/questAbilities.ts + combat.ts hooks).
 */
import { describe, it, expect } from "vitest";

import { getEffectiveEquipmentRank, newCampaign, type CampaignState, type EnemyInstance } from "../state";
import { QUEST1, QUEST4, QUEST7, QUEST13, getEnemy, getQuest } from "../data";
import type { EquipmentType } from "../types";
import { ensureEncounter } from "../engine/encounter";
import { endHeroTurn, playWeaponCard, spendApRefreshWeapon, startHeroTurn, useWeaponAbility, type UseWeaponAbilityOptions, type WeaponAbilityParams } from "../engine/turn";
import { blockCounterattack, finalizeAttackSession, resolveAllDamage, resolveSharedCounter, type AttackSession } from "../engine/combat";
import { sacrificeToRitual } from "../engine/questAbilities";
import { runTownVisitAction } from "../engine/townVisit";
import { grantToken } from "../engine/tokens";

function arena(type: EquipmentType = "Sword", rank = 1, family?: string): CampaignState {
  const s = newCampaign();
  ensureEncounter(s, QUEST1, (pool) => [...pool]);
  s.encounter!.enemies = [];
  s.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
  s.encounter!.delverPositions["hero-02"] = { x: 4, y: 4 };
  s.equipmentRanks["hero-01"]![type] = rank;
  if (family) s.equipmentVariants["hero-01"]![type] = family;
  startHeroTurn(s);
  return s;
}

function spawn(s: CampaignState, cardId: string, x = 2, y = 1, id = `e-${x}-${y}`): EnemyInstance {
  const e: EnemyInstance = { instanceId: id, cardId, x, y, damageTaken: 0, alive: true, facing: 0 };
  s.encounter!.enemies.push(e);
  return e;
}

function swing(s: CampaignState, slot = 0, card = "mind-sword-r1",
  params: WeaponAbilityParams = { kind: "single-adjacent", targetX: 2, targetY: 1 }, opts: UseWeaponAbilityOptions = {}): AttackSession {
  expect(playWeaponCard(s, "hero-01", slot, card).ok).toBe(true);
  const r = useWeaponAbility(s, "hero-01", slot, params, opts);
  if (!r.ok) throw new Error(r.reason);
  return r.session;
}

function resolve(s: CampaignState, sess: AttackSession, roll = -1): void {
  resolveAllDamage(s, sess);
  resolveSharedCounter(s, sess, roll);
  finalizeAttackSession(s, sess);
}

describe("Chapter 4 quest data", () => {
  it("every wave's enemies and End-of-Wave pages exist", () => {
    for (const q of [QUEST4, QUEST7, QUEST13]) {
      expect(() => getQuest(Number(q.id.replace("quest", "")))).not.toThrow();
      for (const w of q.waves) {
        expect(() => getEnemy(w.bossEnemyId)).not.toThrow();
        for (const m of w.minionEnemyIds!) expect(() => getEnemy(m)).not.toThrow();
        const eow = w.eow!;
        expect(q.pages[eow.defeat.pageId], `${q.id} ${eow.defeat.pageId}`).toBeDefined();
        expect(q.pages[w.endOfWave.bothSurvive]).toBeDefined();
        for (const o of eow.victory) {
          expect(q.pages[o.pageId], `${q.id} ${o.pageId}`).toBeDefined();
          if (o.then === "next-wave") {
            const target = o.nextWaveNumber ?? w.number + 1;
            expect(q.waves.some((x) => x.number === target), `${q.id} -> wave ${target}`).toBe(true);
          }
        }
        if (w.onBossSlain) expect(q.pages[w.onBossSlain.pageId]).toBeDefined();
      }
    }
  });

  it("Quest #4's 'pass without disturbing them' skips to Wave 3", () => {
    const pass = QUEST4.waves[0]!.eow!.victory.find((o) => o.label.includes("pass"))!;
    expect(pass.nextWaveNumber).toBe(3);
  });
});

describe("Evasive / Brawler / Double Edged", () => {
  it("Evasive halves (round up) unless both delvers are adjacent", () => {
    const s = arena();
    const e = spawn(s, "emberwing-113");
    e.damageTaken = 0;
    resolve(s, swing(s));
    expect(e.damageTaken).toBe(1); // MEDIUM 2 -> 1
    const t = arena();
    const f = spawn(t, "hugh-112");
    t.encounter!.delverPositions["hero-02"] = { x: 3, y: 1 };
    resolve(t, swing(t));
    expect(f.damageTaken).toBe(3); // MEDIUM 2 + the Flicker Blade's LIGHT 1 (delvers adjacent), not halved
  });

  it("Brawler halves melee attacks", () => {
    const s = arena();
    const e = spawn(s, "george-134");
    resolve(s, swing(s));
    expect(e.damageTaken).toBe(1);
  });

  it("Double Edged doubles damage both ways while its black arrow is on a delver", () => {
    const s = arena();
    const e = spawn(s, "billy-132"); // black arrow (0,+1) covers the attacker at (2,2)
    const sess = swing(s);
    resolveAllDamage(s, sess);
    expect(e.damageTaken).toBe(4);
    const hp = s.loadouts["hero-01"]!.currentHp;
    resolveSharedCounter(s, sess, 6);
    expect(hp - s.loadouts["hero-01"]!.currentHp).toBe(getEnemy("billy-132").attack * 2);
  });
});

describe("Hardy / Invulnerable / Shell / Spiked / Last Act", () => {
  it("Hardy: a single-target attack can't finish it", () => {
    const s = arena();
    const e = spawn(s, "arnold-120");
    e.damageTaken = 39;
    resolve(s, swing(s));
    expect(e.alive).toBe(true);
    expect(e.damageTaken).toBe(39);
  });

  it("Hardy: an attack that also targets two others can", () => {
    const s = arena("Shockwave", 1, "precise-shockwave");
    const e = spawn(s, "arnold-120");
    e.damageTaken = 39;
    spawn(s, "squiddy-088", 0, 0);
    spawn(s, "squiddy-089", 4, 0);
    const sess = swing(s, 0, "mind-shockwave-r1", { kind: "choose-targets", targets: [{ x: 2, y: 1 }, { x: 0, y: 0 }, { x: 4, y: 0 }] });
    resolve(s, sess);
    expect(e.alive).toBe(false);
  });

  it("Invulnerable: the attack after it was damaged deals nothing", () => {
    const s = arena();
    const e = spawn(s, "spike-129");
    s.encounter!.delverPositions["hero-02"] = { x: 3, y: 1 };
    resolve(s, swing(s, 0));
    expect(e.damageTaken).toBe(3); // MEDIUM 2 + Flicker Blade LIGHT 1 (delvers adjacent, so not Evasive)
    expect(e.invulnerableToken).toBe(true);
    s.loadouts["hero-01"]!.slotCards[0] = null;
    startHeroTurn(s);
    resolve(s, swing(s, 1));
    expect(e.damageTaken).toBe(3);
    expect(e.invulnerableToken).toBe(false);
  });

  it("Shell: a missed counterattack gives it a token; with it, it takes no damage", () => {
    const s = arena();
    const e = spawn(s, "experiment-136");
    const sess = swing(s, 0);
    resolveAllDamage(s, sess);
    resolveSharedCounter(s, sess, 1); // miss
    finalizeAttackSession(s, sess);
    expect(e.shellToken).toBe(true);
    const before = e.damageTaken;
    s.loadouts["hero-01"]!.slotCards[0] = null;
    startHeroTurn(s);
    resolve(s, swing(s, 1));
    expect(e.damageTaken).toBe(before);
  });

  it("Spiked: 8+ weapon damage deals 3 back", () => {
    const s = arena("Trident", 3, "lunar-trident");
    spawn(s, "exanimate-122");
    s.elements["hero-01"] = { void: 2 };
    const hp = s.loadouts["hero-01"]!.currentHp;
    const sess = swing(s, 0, "mind-trident-r1", { kind: "single-adjacent", targetX: 2, targetY: 1 },
      { spends: ["spend-element-die-multiplier"], dieMultiplierRoll: 4 });
    resolveAllDamage(s, sess);
    expect(hp - s.loadouts["hero-01"]!.currentHp).toBe(3);
  });

  it("Last Act: the slayer suffers 4", () => {
    const s = arena();
    const e = spawn(s, "anna-130");
    e.damageTaken = 38;
    const hp = s.loadouts["hero-01"]!.currentHp;
    resolve(s, swing(s));
    expect(e.alive).toBe(false);
    expect(hp - s.loadouts["hero-01"]!.currentHp).toBe(4);
  });
});

describe("Steals / Ritual", () => {
  it("Steals: the weapon stays exhausted and can't be refreshed; killing it returns it", () => {
    const s = arena();
    const e = spawn(s, "ruinedtidekin-121");
    resolve(s, swing(s));
    expect(s.encounter!.stolenWeapon).toEqual({ heroId: "hero-01", cardId: "mind-sword-r1" });
    expect(spendApRefreshWeapon(s, "hero-01", 0).ok).toBe(false);
    e.damageTaken = 59;
    s.encounter!.turnState["hero-01"]!.actionUsedThisTurn = false;
    s.encounter!.turnState["hero-01"]!.cardPlacedThisTurn = null;
    resolve(s, swing(s, 1, "mind-beam-r1", { kind: "straight-line", targetX: 2, targetY: 1 }));
    expect(e.alive).toBe(false);
    expect(s.encounter!.stolenWeapon).toBeNull();
  });

  it("Ritual: a sacrifice lowers the rank until the boss dies", () => {
    const s = arena();
    const e = spawn(s, "winona-131");
    resolve(s, swing(s));
    expect(s.encounter!.pendingRitualPicks).toEqual(["hero-01"]);
    sacrificeToRitual(s, "hero-01", "Sword");
    expect(getEffectiveEquipmentRank(s, "hero-01", "Sword")).toBe(0);
    e.damageTaken = 59;
    s.encounter!.turnState["hero-01"]!.actionUsedThisTurn = false;
    s.encounter!.turnState["hero-01"]!.cardPlacedThisTurn = null;
    resolve(s, swing(s, 1, "mind-beam-r1", { kind: "straight-line", targetX: 2, targetY: 1 }));
    expect(e.alive).toBe(false);
    expect(getEffectiveEquipmentRank(s, "hero-01", "Sword")).toBe(1);
  });
});

describe("Soul Sap / Corruption / Backup", () => {
  it("Soul Sap: a delver it damages exhausts a consumable token", () => {
    const s = arena();
    spawn(s, "laura-133");
    grantToken(s, "hero-01", "reroll", 1);
    resolve(s, swing(s), 3);
    expect(s.consumableTokens["hero-01"]!["reroll"]).toEqual({ available: 0, spent: 1 });
  });

  it("Corruption: the targeted delver suffers 1 at the end of each turn while the boss lives", () => {
    const s = arena();
    spawn(s, "revenant-135");
    resolve(s, swing(s), 3);
    expect(s.encounter!.corruption).toEqual({ bossInstanceId: "e-2-1", heroId: "hero-01" });
    const hp = s.loadouts["hero-01"]!.currentHp;
    endHeroTurn(s);
    expect(hp - s.loadouts["hero-01"]!.currentHp).toBe(1);
  });

  it("Backup: two more enemies (nearest the attacker) join the counterattack", () => {
    const s = arena();
    spawn(s, "hugh-112");
    spawn(s, "emberwing-113", 1, 3, "near");
    spawn(s, "emberwing-114", 3, 3, "near2");
    spawn(s, "emberwing-115", 0, 4, "far");
    const sess = swing(s);
    const phase = resolveAllDamage(s, sess);
    expect(phase.damagedEnemies.filter((d) => d.bonus).map((d) => d.instanceId).sort()).toEqual(["near", "near2"]);
  });
});

describe("Quest #7 Town Visit helpers", () => {
  it("story counters and the scavenge shop", () => {
    const s = newCampaign();
    runTownVisitAction(s, { kind: "set-story-counter", key: "k", value: 0 });
    runTownVisitAction(s, { kind: "adjust-story-counter", key: "k", delta: 2 });
    expect(s.storyCounters.k).toBe(2);
    s.shopProductsAvailable = [33];
    s.shopProductsOwned["hero-01"] = [34];
    runTownVisitAction(s, { kind: "open-scavenge-shop", products: [32, 33, 34, 35] });
    expect(s.shopProductsAvailable.sort()).toEqual([32, 33, 35]);
    s.shopProductsAvailable = s.shopProductsAvailable.filter((n) => n !== 32);
    runTownVisitAction(s, { kind: "close-scavenge-shop" });
    expect(s.shopProductsAvailable).toEqual([33]);
  });
});

describe("Block Counterattack cancels the whole counterattack (designer decision 2026-11-17)", () => {
  it("a blocked counterattack deals no damage AND its side effects don't fire (no Rotates turn)", () => {
    const s = arena();
    const e = spawn(s, "ophidian-015"); // Rotates
    grantToken(s, "hero-02", "prevent-counterattack", 1);
    const hp = s.loadouts["hero-01"]!.currentHp;
    const sess = swing(s);
    const phase = resolveAllDamage(s, sess);
    // The OTHER delver spends during hero-01's turn (any delver, any time).
    blockCounterattack(s, phase, "hero-02", e.instanceId);
    resolveSharedCounter(s, sess, 6);
    finalizeAttackSession(s, sess);
    expect(s.loadouts["hero-01"]!.currentHp).toBe(hp);
    expect(e.facing).toBe(0);
    expect(s.consumableTokens["hero-02"]!["prevent-counterattack"]).toEqual({ available: 0, spent: 1 });
  });

  it("an unblocked Rotates enemy still turns (control)", () => {
    const s = arena();
    const e = spawn(s, "ophidian-015");
    const sess = swing(s);
    resolveAllDamage(s, sess);
    resolveSharedCounter(s, sess, 6);
    finalizeAttackSession(s, sess);
    expect(e.facing).toBe(90);
  });

  it("throws without a token, or for an enemy that isn't counterattacking", () => {
    const s = arena();
    const e = spawn(s, "ophidian-015");
    const sess = swing(s);
    const phase = resolveAllDamage(s, sess);
    expect(() => blockCounterattack(s, phase, "hero-01", e.instanceId)).toThrow(/no Block Counterattack token/);
    grantToken(s, "hero-01", "prevent-counterattack", 1);
    expect(() => blockCounterattack(s, phase, "hero-01", "nobody")).toThrow(/isn't counterattacking/);
  });
});
