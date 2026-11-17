/**
 * Chapter 4 Town Visit ("The Passing of the Torch") and its Town Square
 * story quest, "Assault on Bird's Nest".
 *
 * Covers the chapter4.json page graph, the townsfolk assignment scoring
 * and combat rewards, Omen / Rebirth, the Ch4 donation schedule and the
 * v62 -> v63 migration.
 */
import { describe, it, expect } from "vitest";

import { migrateV62ToV63, newCampaign, type CampaignState } from "../state";
import { finishTownVisit, runTownVisitAction, startTownVisit } from "../engine/townVisit";
import { donationRewardsForTier, donationTierForTotal } from "../engine/academyDonation";
import { ensureEncounter } from "../engine/encounter";
import { endHeroTurn, startHeroTurn } from "../engine/turn";
import {
  applyAssaultBonuses,
  clearCombatOnlyGrants,
  resolveTownsfolkAssignment,
  scoreAction,
  SCORED_ACTIONS,
  type TownsfolkAssignment,
} from "../engine/townsfolk";
import { damageDelverInWave, onEnemyDiedForRebirth, tickRebirthAfterHeroTurn } from "../engine/omenRebirth";
import {
  CHAPTER4,
  getChapter,
  getEnemy,
  getHeroCard,
  getKeyItem,
  getQuest,
  getQuestData,
  getScenarioCard,
  getShopProduct,
  HERO_CARD_LOADOUTS,
  MEMORY_CARDS,
  QUEST_ASSAULT,
  getEquipmentByTypeSuitRank,
} from "../data";
import type { TownVisitAction } from "../types";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { effectiveDamageForCard, effectiveDamageForType } from "../engine/combat";
import { useWitnessAbility, witnessAbility, witnessAbilityBlocker } from "../engine/witnessAbility";

function allActions(actions: TownVisitAction[] | undefined): TownVisitAction[] {
  const out: TownVisitAction[] = [];
  for (const a of actions ?? []) {
    out.push(a);
    if (a.kind === "if") out.push(...allActions(a.then), ...allActions(a.otherwise));
  }
  return out;
}

const ALL_COMBAT: TownsfolkAssignment[] = [
  { townsfolkId: "sam", action: "combat", heroId: "hero-02" },
  { townsfolkId: "rodrigo", action: "combat", heroId: "hero-01" },
  { townsfolkId: "elayna", action: "combat", heroId: "hero-01" },
  { townsfolkId: "xavier", action: "combat", heroId: "hero-02" },
  { townsfolkId: "arlen", action: "combat", heroId: "hero-01" },
  { townsfolkId: "bram", action: "combat", heroId: "hero-02" },
];

describe("chapter4 - data integrity", () => {
  it("getChapter('ch4') returns CHAPTER4 and the start page exists", () => {
    expect(getChapter("ch4")).toBe(CHAPTER4);
    expect(CHAPTER4.pages[CHAPTER4.startPageId]).toBeDefined();
  });

  it("every next / choice / die-roll target is a real page; one way forward per page", () => {
    for (const [id, page] of Object.entries(CHAPTER4.pages)) {
      if (page.next) expect(CHAPTER4.pages[page.next], `${id} -> ${page.next}`).toBeDefined();
      for (const c of page.choices ?? []) expect(CHAPTER4.pages[c.next], `${id} -> ${c.next}`).toBeDefined();
      for (const o of page.dieRoll ?? []) expect(CHAPTER4.pages[o.next], `${id} -> ${o.next}`).toBeDefined();
      const ways = [page.next, page.choices?.length, page.dieRoll?.length, page.kind === "end-town-visit"].filter(Boolean).length;
      expect(ways, id).toBe(1);
      if (page.startQuest) expect(() => getQuestData(page.startQuest!)).not.toThrow();
    }
  });

  it("every referenced catalog entry exists", () => {
    for (const page of Object.values(CHAPTER4.pages)) {
      for (const a of allActions(page.onEnter)) {
        switch (a.kind) {
          case "add-shop-products":
          case "add-shop-products-if-key-items-min":
            for (const n of a.products) expect(() => getShopProduct(n)).not.toThrow();
            break;
          case "grant-shop-product": expect(() => getShopProduct(a.product)).not.toThrow(); break;
          case "gain-key-item": expect(() => getKeyItem(a.number)).not.toThrow(); break;
          case "reveal-quest-or-grant-chip": expect(() => getQuest(a.number)).not.toThrow(); break;
          case "reveal-first-unowned-quest": for (const q of a.quests) expect(() => getQuest(q.number)).not.toThrow(); break;
          case "place-scenario-card-on-top": expect(() => getScenarioCard(a.cardNumber)).not.toThrow(); break;
          case "unlock-hero-cards":
            for (const n of a.cardNumbers) {
              expect(() => getHeroCard(n)).not.toThrow();
              expect(HERO_CARD_LOADOUTS[n], `loadout #${n}`).toBeDefined();
            }
            break;
          default: break;
        }
      }
    }
  });

  it("the Assault quest uses Mistspawn + 7 Infestations with Omen and Rebirth", () => {
    const w = QUEST_ASSAULT.waves[0]!;
    expect(getEnemy(w.bossEnemyId!).name).toBe("Mistspawn");
    expect(w.minionEnemyIds).toHaveLength(7);
    for (const id of [w.bossEnemyId!, ...w.minionEnemyIds!]) {
      expect(getEnemy(id).abilities.map((a) => a.kind).sort()).toEqual(["omen", "rebirth"]);
    }
  });
});

describe("chapter4 - townsfolk assignment", () => {
  it("scores 2 for the talent, 0 for the weakness, 1 otherwise", () => {
    const fire = SCORED_ACTIONS.find((a) => a.id === "fire")!;
    expect(scoreAction(fire, ["elayna"])).toEqual({ score: 2, result: "success" }); // Smart
    expect(scoreAction(fire, ["rodrigo"])).toEqual({ score: 0, result: "failure" }); // Naive
    expect(scoreAction(fire, ["sam"])).toEqual({ score: 1, result: "partial" });
    const aid = SCORED_ACTIONS.find((a) => a.id === "first-aid")!;
    expect(scoreAction(aid, ["sam", "rodrigo"]).result).toBe("success"); // 2 + 2
    expect(scoreAction(aid, ["sam", "arlen"]).result).toBe("failure"); // 2 + 0
  });

  it("applies opinion results and stores combat rewards", () => {
    const s = newCampaign();
    resolveTownsfolkAssignment(s, [
      { townsfolkId: "elayna", action: "fire" },
      { townsfolkId: "bram", action: "dig" },
      { townsfolkId: "rodrigo", action: "first-aid" },
      { townsfolkId: "xavier", action: "first-aid" },
      { townsfolkId: "sam", action: "combat", heroId: "hero-02" },
      { townsfolkId: "arlen", action: "combat", heroId: "hero-01" },
    ]);
    expect(s.favour.arlen?.value).toBe(1);
    expect(s.favour.rodrigo?.value).toBe(1);
    expect(s.favour.samantha?.value).toBe(1);
    expect(s.assaultBonuses).toEqual([{ townsfolkId: "sam", heroId: "hero-02" }, { townsfolkId: "arlen", heroId: "hero-01" }]);
    expect(s.townDecisions).toContain("ch4.townsquare.fire.success");
  });

  it("an empty action is a failure (opinion -1)", () => {
    const s = newCampaign();
    resolveTownsfolkAssignment(s, ALL_COMBAT);
    expect(s.favour.arlen?.value).toBe(-1);
    expect(s.favour.rodrigo?.value).toBe(-1);
    expect(s.favour.samantha?.value).toBe(-1);
  });

  it("rejects missing townsfolk and combat without a delver", () => {
    const s = newCampaign();
    expect(() => resolveTownsfolkAssignment(s, ALL_COMBAT.slice(1))).toThrow();
    expect(() => resolveTownsfolkAssignment(s, [{ townsfolkId: "sam", action: "combat" }, ...ALL_COMBAT.slice(1)])).toThrow();
  });

  it("combat rewards land when the Assault starts and tokens are taken back at the end", () => {
    const s = newCampaign();
    resolveTownsfolkAssignment(s, ALL_COMBAT);
    const apBefore = s.loadouts["hero-02"]!.currentAp;
    ensureEncounter(s, QUEST_ASSAULT, (pool) => [...pool]);
    expect(s.assaultBonuses).toEqual([]);
    expect(s.consumableTokens["hero-02"]!["damage-2x-universal"]!.available).toBe(2);
    expect(s.consumableTokens["hero-01"]!["reroll"]!.available).toBe(4);
    expect(s.consumableTokens["hero-01"]!["prevent-counterattack"]!.available).toBe(2);
    expect(s.encounter!.pendingElementChoices.filter((c) => c.heroId === "hero-02")).toHaveLength(3);
    expect(s.loadouts["hero-02"]!.currentAp).toBe(apBefore + 2);
    expect(s.encounter!.pendingLevelUpDraws.length).toBeGreaterThan(0);
    s.consumableTokens["hero-01"]!["reroll"]!.available -= 1;
    s.consumableTokens["hero-01"]!["reroll"]!.spent += 1;
    clearCombatOnlyGrants(s);
    expect(s.consumableTokens["hero-01"]!["reroll"]).toEqual({ available: 0, spent: 0 });
    expect(s.consumableTokens["hero-02"]!["damage-2x-universal"]!.available).toBe(0);
    expect(s.loadouts["hero-02"]!.currentAp).toBe(s.loadouts["hero-02"]!.baseAp);
    expect(applyAssaultBonuses(s)).toEqual([]);
  });
});

function assaultArena(): CampaignState {
  const s = newCampaign();
  ensureEncounter(s, QUEST_ASSAULT, (pool) => [...pool]);
  s.encounter!.phase = "hero";
  startHeroTurn(s);
  return s;
}

describe("chapter4 - Omen", () => {
  it("an Omen hit adds a token; each token adds 1 to later damage; 0 damage adds nothing", () => {
    const s = assaultArena();
    const mist = getEnemy("mistspawn-104");
    const hp0 = s.loadouts["hero-01"]!.currentHp;
    expect(damageDelverInWave(s, "hero-01", 2, mist)).toBe(2);
    expect(s.encounter!.omenTokens["hero-01"]).toBe(1);
    expect(damageDelverInWave(s, "hero-01", 1)).toBe(2);
    expect(s.encounter!.omenTokens["hero-01"]).toBe(1);
    expect(damageDelverInWave(s, "hero-01", 0, mist)).toBe(0);
    expect(s.loadouts["hero-01"]!.currentHp).toBe(hp0 - 4);
  });
});

describe("chapter4 - Rebirth", () => {
  it("3 tokens on death; quiet hero turns tick down; respawns at 50% health", () => {
    const s = assaultArena();
    const enc = s.encounter!;
    const victim = enc.enemies.find((e) => e.cardId.startsWith("infestation"))!;
    victim.alive = false;
    onEnemyDiedForRebirth(s, victim);
    expect(enc.rebirthTiles).toEqual([{ x: victim.x, y: victim.y, tokens: 3, deadInstanceIds: [victim.instanceId] }]);
    // The kill turn itself doesn't tick.
    tickRebirthAfterHeroTurn(s);
    expect(enc.rebirthTiles[0]!.tokens).toBe(3);
    tickRebirthAfterHeroTurn(s);
    tickRebirthAfterHeroTurn(s);
    expect(enc.rebirthTiles[0]!.tokens).toBe(1);
    const back = tickRebirthAfterHeroTurn(s);
    expect(back.map((e) => e.instanceId)).toEqual([victim.instanceId]);
    expect(victim.alive).toBe(true);
    expect(victim.damageTaken).toBe(3); // 6 HP -> 50%
    expect(enc.rebirthTiles).toEqual([]);
  });

  it("a kill on any turn stops that turn's tick; endHeroTurn runs the tick", () => {
    const s = assaultArena();
    const enc = s.encounter!;
    const victim = enc.enemies.find((e) => e.cardId.startsWith("infestation"))!;
    victim.alive = false;
    onEnemyDiedForRebirth(s, victim);
    endHeroTurn(s);
    expect(enc.rebirthTiles[0]!.tokens).toBe(3);
    endHeroTurn(s);
    expect(enc.rebirthTiles[0]!.tokens).toBe(2);
  });

  it("waits while the tile is occupied", () => {
    const s = assaultArena();
    const enc = s.encounter!;
    const victim = enc.enemies.find((e) => e.cardId.startsWith("infestation"))!;
    victim.alive = false;
    onEnemyDiedForRebirth(s, victim);
    enc.enemyDiedThisHeroTurn = false;
    enc.delverPositions["hero-01"] = { x: victim.x, y: victim.y };
    for (let i = 0; i < 4; i++) tickRebirthAfterHeroTurn(s);
    expect(victim.alive).toBe(false);
    enc.delverPositions["hero-01"] = { x: (victim.x + 2) % 5, y: (victim.y + 2) % 5 };
    tickRebirthAfterHeroTurn(s);
    expect(victim.alive).toBe(true);
  });
});

describe("chapter4 - donations, finish, migration", () => {
  it("Ch4 tiers use the running total: 11 / 21 / 35, Armor + Boots", () => {
    expect(donationTierForTotal(10, "ch4")).toBe("none");
    expect(donationTierForTotal(11, "ch4")).toBe("small");
    expect(donationTierForTotal(21, "ch4")).toBe("medium");
    expect(donationTierForTotal(35, "ch4")).toBe("large");
    expect(donationRewardsForTier("medium", "ch4")).toEqual([{ delta: 2, pinnedType: "Armor" }, { delta: 2, pinnedType: "Boots" }]);
  });

  it("finishing the visit sets townVisit4Completed", () => {
    const s = newCampaign();
    startTownVisit(s, "ch4");
    finishTownVisit(s);
    expect(s.townVisit4Completed).toBe(true);
  });

  it("Bram's opinion is tracked without a card", () => {
    const s = newCampaign();
    runTownVisitAction(s, { kind: "shift-favour", characterId: "bram", characterName: "Master Bram", delta: -1, trackOnly: true });
    expect(s.favour.bram?.value).toBe(-1);
    expect(s.opinionCards.some((c) => c.characterId === "bram")).toBe(false);
  });

  it("v62 -> v63 seeds the Ch4 fields", () => {
    const s = newCampaign() as unknown as Record<string, unknown>;
    delete s.townVisit4Completed;
    delete s.assaultBonuses;
    s.version = 62;
    const out = migrateV62ToV63(s)!;
    expect(out.version).toBe(63);
    expect(out.townVisit4Completed).toBe(false);
    expect(out.assaultBonuses).toEqual([]);
  });

  it("Shimmering / Volcanic Delversuits are suit-locked", () => {
    expect(getShopProduct(23).onlySuit).toBe("mind");
    expect(getShopProduct(24).onlySuit).toBe("body");
  });
});

describe("Memory Fragments #1-10 (ordered deck)", () => {
  it("every card's front (and back, when it has one) is on disk", () => {
    for (const c of MEMORY_CARDS) {
      expect(existsSync(join(__dirname, "../../public/memory-cards", c.image)), c.image).toBe(true);
      if (c.backImage) expect(existsSync(join(__dirname, "../../public/memory-cards", c.backImage)), c.backImage).toBe(true);
    }
    expect(MEMORY_CARDS.map((c) => c.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("draws continue in order and stop at #10, leaving unspent chips", () => {
    const s = newCampaign();
    s.memoryCards = [1, 2];
    s.memoryChips = 3;
    runTownVisitAction(s, { kind: "convert-memory-chips-to-cards" });
    expect(s.memoryCards).toEqual([1, 2, 3, 4, 5]);
    expect(s.memoryChips).toBe(0);
    s.memoryChips = 7;
    runTownVisitAction(s, { kind: "convert-memory-chips-to-cards" });
    expect(s.memoryCards.slice(-5)).toEqual([6, 7, 8, 9, 10]);
    expect(s.memoryChips).toBe(2);
    expect(runTownVisitAction(s, { kind: "convert-memory-chips-to-cards" })).toEqual([]);
  });
});

describe("Damage track bonus raises the base", () => {
  it("a 2x card doubles the raised base (LIGHT 1 -> 2: 2x LIGHT deals 4, not 3)", () => {
    const s = newCampaign();
    s.equipmentRanks["hero-01"]!.Gauntlet = 2; // Mind Gauntlet R2 = 2x LIGHT
    const gauntlet = getEquipmentByTypeSuitRank("mind", "Gauntlet", 1);
    expect(effectiveDamageForCard(s, "hero-01", gauntlet)).toBe(2);
    s.shopDamageBonus["hero-01"] = { light: 1 };
    expect(effectiveDamageForType(s, "hero-01", "light")).toBe(2);
    expect(effectiveDamageForCard(s, "hero-01", gauntlet)).toBe(4);
  });
});

describe("Memory Fragment Witness ability", () => {
  function board(fragments: number[]): CampaignState {
    const s = newCampaign();
    s.memoryCards = fragments;
    ensureEncounter(s, QUEST_ASSAULT, (pool) => [...pool]);
    const enc = s.encounter!;
    enc.phase = "hero";
    enc.witnessPosition = { x: 2, y: 2 };
    enc.enemies = [
      { instanceId: "boss", cardId: "mistspawn-104", x: 2, y: 1, damageTaken: 0, alive: true, facing: 0 },
      { instanceId: "m1", cardId: "infestation-105", x: 3, y: 3, damageTaken: 0, alive: true, facing: 0 },
      { instanceId: "far", cardId: "infestation-106", x: 0, y: 0, damageTaken: 0, alive: true, facing: 0 },
    ];
    enc.delverPositions["hero-01"] = { x: 2, y: 2 };
    enc.delverPositions["hero-02"] = { x: 4, y: 4 };
    return s;
  }

  it("the best fragment drawn sets the strength; #1 alone gives none", () => {
    expect(witnessAbility(board([1]))).toBeNull();
    expect(witnessAbility(board([1, 2]))).toEqual({ fragment: 2, damage: 2, heal: 0 });
    expect(witnessAbility(board([1, 2, 3, 4, 5, 6, 7]))).toEqual({ fragment: 7, damage: 6, heal: 3 });
  });

  it("damages every adjacent enemy once per quest, with kill rewards", () => {
    const s = board([1, 2, 3, 4, 5, 6, 7]);
    const r = useWitnessAbility(s, "damage");
    expect(r.hit.map((h) => h.instanceId).sort()).toEqual(["boss", "m1"]);
    expect(s.encounter!.enemies.find((e) => e.instanceId === "m1")!.alive).toBe(false); // 6 HP
    expect(s.encounter!.enemies.find((e) => e.instanceId === "far")!.damageTaken).toBe(0);
    expect(s.encounter!.rebirthTiles).toHaveLength(1); // the kill still triggers Rebirth
    expect(witnessAbilityBlocker(s, "damage")).toBe("already used this quest");
    expect(() => useWitnessAbility(s, "heal")).toThrow();
  });

  it("heals delvers on and next to Witness; #2 can't heal", () => {
    const s = board([1, 2, 3, 4, 5]);
    s.loadouts["hero-01"]!.currentHp = 1;
    s.loadouts["hero-02"]!.currentHp = 1;
    const r = useWitnessAbility(s, "heal");
    expect(r.healed).toEqual([{ heroId: "hero-01", amount: 2 }]);
    expect(s.loadouts["hero-02"]!.currentHp).toBe(1);
    expect(witnessAbilityBlocker(board([1, 2]), "heal")).toBe("this fragment's ability can't heal");
  });

  it("comes back when a new quest starts", () => {
    const s = board([1, 2]);
    useWitnessAbility(s, "damage");
    s.encounter = null;
    ensureEncounter(s, QUEST_ASSAULT, (pool) => [...pool]);
    expect(s.witnessAbilityUsed).toBe(false);
  });
});
