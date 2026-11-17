/**
 * Enemy ability procs: the engine records an ability only when it
 * actually changed the outcome, so the board can float its name over
 * the enemy's tile (`uiState.ts > collectAbilityProcFx`).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { newCampaign, type CampaignState, type EnemyInstance } from "../state";
import { QUEST1 } from "../data";
import { ensureEncounter } from "../engine/encounter";
import { playWeaponCard, startHeroTurn, useWeaponAbility } from "../engine/turn";
import { counterAttackOutcomeForRoll, finalizeAttackSession, previewCounterHitsByDelver, resolveAllDamage, resolveSharedCounter, type AttackSession } from "../engine/combat";
import { drainAbilityProcs } from "../engine/abilityProcs";
import { enemyAbilityLabel } from "../screens/EnemyAbilitiesModal";

function arena(): CampaignState {
  const s = newCampaign();
  ensureEncounter(s, QUEST1, (pool) => [...pool]);
  s.encounter!.enemies = [];
  s.encounter!.delverPositions["hero-01"] = { x: 2, y: 2 };
  s.encounter!.delverPositions["hero-02"] = { x: 4, y: 4 };
  s.equipmentRanks["hero-01"]!.Sword = 1;
  startHeroTurn(s);
  return s;
}

function spawn(s: CampaignState, cardId: string): EnemyInstance {
  const e: EnemyInstance = { instanceId: "target", cardId, x: 2, y: 1, damageTaken: 0, alive: true, facing: 0 };
  s.encounter!.enemies.push(e);
  return e;
}

function swing(s: CampaignState): AttackSession {
  expect(playWeaponCard(s, "hero-01", 0, "mind-sword-r1").ok).toBe(true);
  const r = useWeaponAbility(s, "hero-01", 0, { kind: "single-adjacent", targetX: 2, targetY: 1 });
  if (!r.ok) throw new Error(r.reason);
  return r.session;
}

const kinds = () => drainAbilityProcs().map((p) => `${p.instanceId}:${p.kind}@${p.x},${p.y}`);

beforeEach(() => { drainAbilityProcs(); });

describe("enemy ability procs", () => {
  it("Rotates is recorded on the enemy's tile when it turns after a counterattack", () => {
    const s = arena();
    spawn(s, "ophidian-015"); // Rotates
    const sess = swing(s);
    resolveAllDamage(s, sess);
    expect(kinds()).toEqual([]);
    resolveSharedCounter(s, sess, 6);
    finalizeAttackSession(s, sess);
    expect(kinds()).toEqual(["target:rotates@2,1"]);
  });

  it("Tough is recorded only when it reduced the damage", () => {
    const s = arena();
    const e = spawn(s, "sapling-072"); // Countdown, Tough
    const sess = swing(s);
    resolveAllDamage(s, sess);
    expect(e.damageTaken).toBe(0); // a small hit rounds down to 0
    expect(kinds()).toContain("target:tough@2,1");
  });

  it("an enemy with no abilities records nothing", () => {
    const s = arena();
    spawn(s, "crystanid-001");
    const sess = swing(s);
    resolveAllDamage(s, sess);
    resolveSharedCounter(s, sess, 6);
    finalizeAttackSession(s, sess);
    expect(kinds()).toEqual([]);
  });

  it("counter previews never record procs", () => {
    const s = arena();
    spawn(s, "oblivionwing-095"); // Critical, Frenzy
    const sess = swing(s);
    const phase = resolveAllDamage(s, sess);
    drainAbilityProcs();
    previewCounterHitsByDelver(s, phase.damagedEnemies, counterAttackOutcomeForRoll(5), undefined, 5);
    expect(kinds()).toEqual([]);
  });

  it("Critical is recorded when a 5 doubles a landed counterattack", () => {
    const s = arena();
    spawn(s, "oblivionwing-095"); // Critical, Frenzy
    const sess = swing(s);
    resolveAllDamage(s, sess);
    drainAbilityProcs();
    resolveSharedCounter(s, sess, 5);
    const procs = kinds();
    if (s.loadouts["hero-01"]!.currentHp < s.loadouts["hero-01"]!.maxHp) expect(procs).toContain("target:critical@2,1");
    else expect(procs).not.toContain("target:critical@2,1");
  });

  it("every ability kind has a display label", () => {
    for (const k of ["tough", "rotates", "countdown", "critical", "fatal-flaw", "shell", "last-act", "soothsayer"] as const) {
      expect(enemyAbilityLabel(k).length).toBeGreaterThan(0);
    }
  });
});
