/**
 * Debug "Quick Start Chapter N": build a campaign save as if an average
 * party had played up to the start of Chapter 2, 3 or 4.
 *
 * The simulated party:
 *   - beats every quest on the first try (always takes "Continue", always
 *     kills the boss, never loses a delver),
 *   - kills roughly 60% of the minions and picks up roughly 85% of the
 *     drops, so parts and XP land at an "average" amount,
 *   - makes random choices everywhere else (Town Visit options, level-up
 *     cards, element / rank picks, Scenario cards, hero cards),
 *   - in Ch3 plays the quests it has from the Quest Report (up to 2),
 *   - spends its parts in every shop on random affordable products,
 *     converting boss parts to minion parts when that unlocks a purchase,
 *     and donates a few leftover minion parts to the Academy.
 *
 * Everything runs through the real engine functions, so the save is
 * consistent with normal play. No UI is involved.
 */
import { bossWallet, creditBossPartDrop, getEffectiveEquipmentRank, getEffectiveEquipmentRanks, newCampaign, type BossPartLevel, type CampaignState } from "../state";
import { ALL_EQUIPMENT_TYPES, EQUIPMENT_RANK_CAP, SUIT_PART_EQUIPMENT_TYPES_BY_SUIT, type Element, type EquipmentType, type Quest } from "../types";
import { getEnemy, getHero, getKeyItem, getQuestData, getScenarioCard, getShopProduct, getSpawnCard } from "../data";
import { assignDelverToTile, assignWitnessToTile, commitFirstTurnPick, ensureEncounter, startWaveAfterPick } from "../engine/encounter";
import { startHeroTurn } from "../engine/turn";
import { applyKill, applyPendingLevelUps, applyXpRoll, grantElementToDelver, peekNextPendingXpRoll } from "../engine/kills";
import { bootstrapNextWave, completeWave, endQuestReset, resolvePartingShot } from "../engine/wave";
import {
  advanceTownVisitPage,
  applyOnEnter,
  chooseTownVisitOption,
  convertBossPartToMinion,
  currentTownVisitPage,
  eligibleShopProductPicks,
  finishTownVisit,
  purchaseShopProduct,
  resolveShopProductPicks,
  resolveTownVisitDieRoll,
  runTownVisitAction,
  shopPurchaseError,
  startTownVisit,
  townVisitChoiceGated,
  visibleTownVisitChoices,
} from "../engine/townVisit";
import { commitAcademyDonationResolution, donateToAcademy, recordAcademyDonationPlacement } from "../engine/academyDonation";
import { applyOpinionRankPick, eligibleEquipmentTypesForPick } from "../engine/opinionGrants";
import { applyLevelUpChoice, discardUnplayableLevelUpDraw, getLevelUpCard, legalLevelUpTypes, peekNextPendingDraw } from "../engine/levelUp";
import { applyElementChoice, peekNextPendingElementChoice } from "../engine/os";
import { applyEquipmentRoll, equipmentRollTableForCard, outcomeForRoll, peekNextPendingEquipmentRoll } from "../engine/tokens";
import { applyCreaturePartChoice, availableCreaturePartDropsForHero, peekNextPendingCreaturePartChoice, skipCreaturePartChoice } from "../engine/creatureParts";
import { applyScenarioDelverPick, applyQuestCarryEffect, chooseScenarioOption, closeScenarioCard, resolveScenarioDieRoll, resolveScenarioElementSpend, resolveScenarioSubChoice } from "../engine/scenarioCard";
import { applySuitConditionRankPick, applySuitConditionRankPickToSlot, eligibleEquipmentTypesForSuitConditionPick, enqueueSuitConditionRankPicks, peekNextSuitConditionRankPick } from "../engine/suitConditionGrants";
import { commitHeroPick, ownedHeroCardNumbersForSuit, populatePendingHeroPicks } from "../engine/heroPick";
import { resolveTownsfolkAssignment, TOWNSFOLK, type TownsfolkActionId } from "../engine/townsfolk";
import { ritualOptions, sacrificeToRitual } from "../engine/questAbilities";
import { BOSS_CARD_BACKS } from "../screens/WavePhases";
import { logEvent } from "./sessionLog";

export type QuickStartChapter = 2 | 3 | 4;
type Rng = () => number;

const MINION_KILL_RATE = 0.6;
const DROP_PICKUP_RATE = 0.85;
const ELEMENTS: Element[] = ["earth", "wind", "fire", "water", "void", "radiance"];

const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
const d6 = (rng: Rng) => 1 + Math.floor(rng() * 6);
const heroIds = (s: CampaignState) => Object.keys(s.loadouts);

// ------------------------------------------------------------------ queues

/** Find the first empty Suit Condition slot (loadout 0-2, slot 0-2) for a delver. */
function emptySuitSlot(s: CampaignState, heroId: string): { loadoutIdx: number; slotIdx: number } | null {
  const lo = s.suitLoadouts[heroId] ?? [];
  for (let l = 0; l < 3; l++) for (let k = 0; k < 3; k++) if (!lo[l]?.[k]) return { loadoutIdx: l, slotIdx: k };
  return null;
}

function drainSuitConditionPicks(s: CampaignState, rng: Rng): void {
  const assigned = new Map<string, string>();
  for (let i = 0; i < 20; i++) {
    const p = peekNextSuitConditionRankPick(s);
    if (!p) return;
    let heroId = p.heroId ?? pick(rng, heroIds(s));
    const partner = p.pairsWithPickId ? assigned.get(p.pairsWithPickId) : undefined;
    if (!p.heroId && partner) heroId = heroIds(s).find((h) => h !== partner) ?? heroId;
    const types = eligibleEquipmentTypesForSuitConditionPick(s, p, heroId, ALL_EQUIPMENT_TYPES);
    if (types.length === 0) {
      s.pendingSuitConditionPicks.shift();
      continue;
    }
    const type = pick(rng, types);
    const slot = p.unlockHigherRanks ? null : emptySuitSlot(s, heroId);
    if (slot) applySuitConditionRankPickToSlot(s, p.pickId, heroId, type, slot.loadoutIdx, slot.slotIdx);
    else applySuitConditionRankPick(s, p.pickId, heroId, type);
    assigned.set(p.pickId, heroId);
  }
}

function resolveAcademyDonation(s: CampaignState, rng: Rng): void {
  const res = s.pendingAcademyDonationResolution;
  if (!res) return;
  const order = [...heroIds(s)].sort(() => rng() - 0.5);
  res.rewards.forEach((r, i) => {
    const heroId = order[i % order.length]!;
    r.assignedHeroId = heroId;
    r.chosenType = r.pinnedType ?? pick(rng, ALL_EQUIPMENT_TYPES.filter((t) => getEffectiveEquipmentRank(s, heroId, t) < EQUIPMENT_RANK_CAP));
  });
  const taken = new Set<string>();
  for (const r of res.rewards) {
    const heroId = r.assignedHeroId!;
    const lo = s.suitLoadouts[heroId] ?? [];
    let placed = false;
    for (let l = 0; l < 3 && !placed; l++) for (let k = 0; k < 3 && !placed; k++) {
      const key = `${heroId}:${l}:${k}`;
      if (lo[l]?.[k] || taken.has(key)) continue;
      recordAcademyDonationPlacement(s, heroId, r.chosenType!, l, k);
      taken.add(key);
      placed = true;
    }
    if (!placed) throw new Error(`quickStart: no free Suit Condition slot for ${heroId}`);
  }
  commitAcademyDonationResolution(s);
}

function resolveScenarioCard(s: CampaignState, rng: Rng): void {
  const cur = s.currentScenarioCard;
  if (!cur) return;
  if (!cur.chosenOption) {
    chooseScenarioOption(s, pick(rng, getScenarioChoiceLetters(cur.number)));
  }
  for (let i = 0; i < 6; i++) {
    const c = s.currentScenarioCard;
    if (!c || c.resolved) break;
    if (c.pendingDieRoll) resolveScenarioDieRoll(s, d6(rng));
    else if (c.pendingSubChoice) resolveScenarioSubChoice(s, Math.floor(rng() * c.pendingSubChoice.optionLabels.length));
    else if (c.pendingElementSpend) resolveScenarioElementSpend(s, null);
  }
  closeScenarioCard(s);
}

function getScenarioChoiceLetters(n: number): ("A" | "B" | "C")[] {
  return getScenarioCard(n).choices.map((c) => c.letter);
}

/** Resolve every in-quest and town player-choice queue at random. */
function drainQueues(s: CampaignState, rng: Rng): void {
  for (let guard = 0; guard < 200; guard++) {
    const enc = s.encounter;
    if (s.currentScenarioCard) { resolveScenarioCard(s, rng); continue; }
    if (s.pendingScenarioDelverPicks.length > 0) {
      applyScenarioDelverPick(s, s.pendingScenarioDelverPicks[0]!.pickId, pick(rng, heroIds(s)));
      continue;
    }
    if (enc && enc.pendingOpinionRankPicks.length > 0) {
      const p = enc.pendingOpinionRankPicks[0]!;
      const order = p.heroId ? [p.heroId] : [...heroIds(s)].sort(() => rng() - 0.5);
      const choice = order.map((h) => ({ h, types: eligibleEquipmentTypesForPick(s, p, h, ALL_EQUIPMENT_TYPES) })).find((x) => x.types.length > 0);
      if (choice) applyOpinionRankPick(s, p.pickId, choice.h, pick(rng, choice.types));
      else enc.pendingOpinionRankPicks.shift();
      continue;
    }
    if (enc && enc.pendingRitualPicks.length > 0) {
      const h = enc.pendingRitualPicks[0]!;
      const opts = ritualOptions(s, h, getEffectiveEquipmentRanks(s, h));
      if (opts.length) sacrificeToRitual(s, h, pick(rng, opts));
      else enc.pendingRitualPicks.shift();
      continue;
    }
    const draw = enc ? peekNextPendingDraw(s) : null;
    if (draw) {
      const legal = legalLevelUpTypes(s, draw.heroId, getLevelUpCard(draw.cardNumber));
      if (legal.length === 0) { discardUnplayableLevelUpDraw(s); continue; }
      const res = applyLevelUpChoice(s, pick(rng, legal));
      if (!res.ok) throw new Error(`quickStart: level-up rejected: ${res.reason}`);
      continue;
    }
    const el = enc ? peekNextPendingElementChoice(s) : null;
    if (el) {
      const bag = s.elements[el.heroId] ?? {};
      const open = ELEMENTS.filter((e) => (bag[e] ?? 0) < 2);
      applyElementChoice(s, pick(rng, open.length ? open : ELEMENTS));
      continue;
    }
    const roll = enc ? peekNextPendingEquipmentRoll(s) : null;
    if (roll) {
      const table = equipmentRollTableForCard(roll.cardId);
      if (!table) throw new Error(`quickStart: no equipment roll table for ${roll.cardId}`);
      let outcome = table.pickOnly ? null : outcomeForRoll(table, d6(rng));
      if (outcome === "choice" || outcome === null) outcome = pick(rng, table.outcomes);
      applyEquipmentRoll(s, roll.heroId, outcome);
      continue;
    }
    if (enc && peekNextPendingXpRoll(s)) { applyXpRoll(s, d6(rng)); continue; }
    const part = enc ? peekNextPendingCreaturePartChoice(s) : null;
    if (part) {
      const drops = availableCreaturePartDropsForHero(s, part.heroId);
      if (drops[0]) applyCreaturePartChoice(s, part.heroId, drops[0].x, drops[0].y);
      else skipCreaturePartChoice(s, part.heroId);
      continue;
    }
    if (s.pendingSuitConditionPicks.length > 0) { drainSuitConditionPicks(s, rng); continue; }
    if (s.pendingAcademyDonationResolution) { resolveAcademyDonation(s, rng); continue; }
    return;
  }
  const enc = s.encounter;
  throw new Error(`quickStart: pending choices never drained (${JSON.stringify({
    scenario: s.currentScenarioCard, delverPicks: s.pendingScenarioDelverPicks,
    opinion: enc?.pendingOpinionRankPicks, ritual: enc?.pendingRitualPicks,
    draw: enc ? peekNextPendingDraw(s) : null, element: enc ? peekNextPendingElementChoice(s) : null,
    roll: enc ? peekNextPendingEquipmentRoll(s) : null, part: enc ? peekNextPendingCreaturePartChoice(s) : null,
    suit: s.pendingSuitConditionPicks[0], academy: s.pendingAcademyDonationResolution,
  })})`);
}

// ------------------------------------------------------------------ quests

function prepareQuestStart(s: CampaignState, quest: Quest, rng: Rng): void {
  s.currentQuestId = quest.id;
  s.encounter = null;
  populatePendingHeroPicks(s, quest.id);
  while (s.pendingHeroPickDelvers.length > 0) {
    const heroId = s.pendingHeroPickDelvers[0]!;
    commitHeroPick(s, heroId, pick(rng, ownedHeroCardNumbersForSuit(s, getHero(heroId).suit)));
  }
}

function setUpWave(s: CampaignState, rng: Rng): void {
  drainQueues(s, rng);
  const enc = s.encounter!;
  if (enc.phase === "delver-spawn-pick" && enc.spawnCardDrawn != null) {
    const tiles = getSpawnCard(enc.spawnCardDrawn).delverSpawns;
    for (const h of Object.keys(enc.delverPositions)) { const t = pick(rng, tiles); assignDelverToTile(s, h, t.x, t.y); }
    if (enc.witnessPosition) { const t = pick(rng, tiles); assignWitnessToTile(s, t.x, t.y); }
    startWaveAfterPick(s, startHeroTurn);
  }
  commitFirstTurnPick(s, pick(rng, heroIds(s)), startHeroTurn);
  drainQueues(s, rng);
}

/** The fight: the boss always falls, ~60% of minions die, ~85% of drops
 *  get picked up; survivors are left behind (no parting shots). */
function fightWave(s: CampaignState, rng: Rng): void {
  const enc = s.encounter!;
  for (const e of enc.enemies) {
    if (!e.alive || e.linkedTo) continue;
    const isBoss = getEnemy(e.cardId).kind !== "minion";
    if (!isBoss && rng() > MINION_KILL_RATE) continue;
    e.alive = false;
    for (const part of enc.enemies) if (part.linkedTo === e.instanceId) part.alive = false;
    applyKill(s, getEnemy(e.cardId), { x: e.x, y: e.y });
    enc.pendingQuestEntry = undefined;
    drainQueues(s, rng);
  }
  for (const drop of enc.tileDrops) {
    if (rng() > DROP_PICKUP_RATE) continue;
    if (drop.dropId === "minion-part") s.minionParts[drop.heroId] = (s.minionParts[drop.heroId] ?? 0) + 1;
    else creditBossPartDrop(s, drop.heroId, drop.dropId);
  }
  enc.tileDrops = [];
  applyPendingLevelUps(s);
  drainQueues(s, rng);
  for (const e of enc.enemies) e.alive = false;
  enc.phase = "parting-shots";
  enc.partingShotCursor = 0;
  resolvePartingShot(s);
  if (enc.endOfWaveOutcome !== "victory") throw new Error(`quickStart: ${enc.questId} wave ${enc.waveNumber} ended in ${enc.endOfWaveOutcome}`);
}

/** Between waves: the upcoming boss's card back ("improve one X"). */
function bossCardBackPicks(s: CampaignState, quest: Quest, nextWave: number, rng: Rng): void {
  const boss = quest.waves.find((w) => w.number === nextWave)?.bossEnemyId;
  const back = BOSS_CARD_BACKS.find((b) => b.bossEnemyId === boss);
  if (!back) return;
  heroIds(s).forEach((heroId, i) => {
    const part = back.suitParts[i]!;
    enqueueSuitConditionRankPicks(s, `quickstart-boss-w${nextWave}-${heroId}`, [{
      delta: 1, pinnedHeroId: heroId,
      allowedTypes: [...SUIT_PART_EQUIPMENT_TYPES_BY_SUIT[getHero(heroId).suit][part]] as EquipmentType[],
      unlockHigherRanks: true,
    }]);
  });
  drainQueues(s, rng);
}

function grantKeyItem(s: CampaignState, number: number, name: string): void {
  if (!s.keyItems.some((k) => k.number === number)) s.keyItems.push({ number, name, clues: getKeyItem(number).clues });
}

function simulateQuest(s: CampaignState, quest: Quest, rng: Rng): void {
  prepareQuestStart(s, quest, rng);
  ensureEncounter(s, quest);
  let waveNumber = 1;
  for (let guard = 0; guard < 10; guard++) {
    setUpWave(s, rng);
    fightWave(s, rng);
    const wave = quest.waves.find((w) => w.number === waveNumber)!;
    let next: number | null = null;
    if (quest.id === "quest1") {
      next = null;
    } else if (quest.id === "quest2") {
      if (waveNumber === 1) {
        // Page 2.3: each delver picks up to 3 elements.
        for (const h of heroIds(s)) for (let i = 0; i < 3; i++) {
          const bag = s.elements[h] ?? {};
          const open = ELEMENTS.filter((e) => (bag[e] ?? 0) < 2);
          if (open.length) grantElementToDelver(s, h, pick(rng, open));
        }
        next = 2;
      } else if (waveNumber === 2) {
        grantKeyItem(s, 1, "Surveillance Camera");
        next = 3; // follow the shouts
      } else {
        grantKeyItem(s, 1, "Surveillance Camera");
        grantKeyItem(s, 2, "Abandoned Syringe");
      }
    } else {
      const eow = wave.eow;
      if (!eow) throw new Error(`quickStart: ${quest.id} wave ${waveNumber} has no End-of-Wave data`);
      const option = eow.victory.find((o) => o.then === "next-wave") ?? eow.victory[0]!;
      for (const a of option.rewards ?? []) runTownVisitAction(s, a);
      if (option.pickShopProducts) {
        const eligible = eligibleShopProductPicks(s, option.pickShopProducts.from).sort(() => rng() - 0.5);
        resolveShopProductPicks(s, option.pickShopProducts.from, option.pickShopProducts.count,
          eligible.slice(0, Math.min(option.pickShopProducts.count, eligible.length)), quest.name);
      }
      drainQueues(s, rng);
      if (option.then === "next-wave") {
        next = option.nextWaveNumber ?? waveNumber + 1;
        completeWave(s);
        bootstrapNextWave(s, quest, next);
        for (const effect of option.carryEffects ?? []) applyQuestCarryEffect(s, effect);
        bossCardBackPicks(s, quest, next, rng);
        waveNumber = next;
        continue;
      }
    }
    if (next === null) {
      completeWave(s);
      endQuestReset(s);
      logEvent("debug.quickStart.questDone", { questId: quest.id });
      return;
    }
    completeWave(s);
    bootstrapNextWave(s, quest, next);
    bossCardBackPicks(s, quest, next, rng);
    waveNumber = next;
  }
  throw new Error(`quickStart: ${quest.id} never ended`);
}

// ------------------------------------------------------------------ town visits

/** Spend parts on random affordable products; convert boss parts when that
 *  unlocks a purchase; donate a few leftovers to the Academy. */
function shopSpree(s: CampaignState, rng: Rng): void {
  for (let guard = 0; guard < 80; guard++) {
    const options: { heroId: string; n: number }[] = [];
    for (const heroId of heroIds(s)) for (const n of s.shopProductsAvailable) {
      if (getShopProduct(n).cost.variableMinionParts) continue;
      if (!shopPurchaseError(s, heroId, n)) options.push({ heroId, n });
    }
    if (options.length > 0) {
      const o = pick(rng, options);
      const err = purchaseShopProduct(s, o.heroId, o.n);
      if (err) throw new Error(`quickStart: purchase #${o.n} rejected: ${err.code}`);
      continue;
    }
    // Would converting one boss part (lowest level first) let someone buy?
    let converted = false;
    for (const heroId of [...heroIds(s)].sort(() => rng() - 0.5)) {
      for (const level of [1, 2, 3, 4, 5] as BossPartLevel[]) {
        if ((bossWallet(s, level)[heroId] ?? 0) < 1) continue;
        const trial = structuredClone(s);
        convertBossPartToMinion(trial, heroId, level);
        const unlocks = trial.shopProductsAvailable.some((n) => !getShopProduct(n).cost.variableMinionParts && !shopPurchaseError(trial, heroId, n));
        if (unlocks) { convertBossPartToMinion(s, heroId, level); converted = true; }
        break;
      }
      if (converted) break;
    }
    if (!converted) break;
  }
  // Nothing left to buy: donate most leftovers, keep a couple.
  for (const heroId of heroIds(s)) {
    const spare = (s.minionParts[heroId] ?? 0) - Math.floor(rng() * 3);
    if (spare > 0) donateToAcademy(s, heroId, spare);
  }
}

function assignTownsfolk(s: CampaignState, rng: Rng): void {
  const actions: TownsfolkActionId[] = ["fire", "dig", "first-aid", "combat"];
  resolveTownsfolkAssignment(s, TOWNSFOLK.map((t) => {
    const action = pick(rng, actions);
    return action === "combat" ? { townsfolkId: t.id, action, heroId: pick(rng, heroIds(s)) } : { townsfolkId: t.id, action };
  }));
}

/** Walk the active Town Visit to its end page with random choices. */
function walkTownVisit(s: CampaignState, rng: Rng): void {
  for (let guard = 0; guard < 600; guard++) {
    const ctx = currentTownVisitPage(s);
    if (!ctx) return;
    applyOnEnter(s);
    drainQueues(s, rng);
    const page = ctx.page;
    if (page.kind === "end-town-visit") return;
    if (page.kind === "shop") { shopSpree(s, rng); drainQueues(s, rng); advanceTownVisitPage(s); continue; }
    if (page.kind === "townsfolk-assignment") { assignTownsfolk(s, rng); advanceTownVisitPage(s); continue; }
    if (page.startQuest) {
      advanceTownVisitPage(s);
      simulateQuest(s, getQuestData(page.startQuest), rng);
      continue;
    }
    if (page.dieRoll) { resolveTownVisitDieRoll(s, d6(rng)); continue; }
    const keys = new Set(visibleTownVisitChoices(s).map((c) => c.decisionKey));
    let choices = (page.choices ?? []).filter((c) => keys.has(c.decisionKey) && !townVisitChoiceGated(s, c));
    // Pre-paid options need a delver who can pay.
    choices = choices.filter((c) => !c.prePay || heroIds(s).some((h) => (s.minionParts[h] ?? 0) >= c.prePay!.amount));
    if (choices.length > 0) {
      const play = choices.filter((c) => /\.report\.q\d+\.play$/.test(c.decisionKey));
      const choice = play.length > 0 ? pick(rng, play) : pick(rng, choices);
      if (choice.prePay) s.currentDelverId = pick(rng, heroIds(s).filter((h) => (s.minionParts[h] ?? 0) >= choice.prePay!.amount));
      chooseTownVisitOption(s, choice.decisionKey);
      continue;
    }
    if (page.next) { advanceTownVisitPage(s); continue; }
    throw new Error(`quickStart: stuck on Town Visit page "${ctx.visit.pageId}"`);
  }
  throw new Error("quickStart: Town Visit never ended");
}

function playTownVisit(s: CampaignState, visit: CampaignState["townVisit"], rng: Rng): void {
  s.townVisit = visit;
  walkTownVisit(s, rng);
  finishTownVisit(s);
}

// ------------------------------------------------------------------ entry

/** Simulate an average party up to the start of `chapter`. */
export function simulateCampaignTo(chapter: QuickStartChapter, rng: Rng = Math.random): CampaignState {
  const s = newCampaign();
  // Chapter 1: Quest #1, then the Ch1 Town Visit (from page 6, as after a Q1 win).
  simulateQuest(s, getQuestData("quest1"), rng);
  playTownVisit(s, { chapterId: "ch1", pageId: "page6", pagesEntered: [] }, rng);
  if (chapter === 2) return s; // Quest #2's intro is next
  // Chapter 2: Quest #2, then the Ch2 Town Visit (the "both survived" entry).
  simulateQuest(s, getQuestData("quest2"), rng);
  playTownVisit(s, { chapterId: "ch2", pageId: "page22-both-survived", pagesEntered: [] }, rng);
  if (chapter === 3) {
    startTownVisit(s, "ch3");
    return s;
  }
  // Chapter 3: Quest Report (quests) + Town Visit.
  startTownVisit(s, "ch3");
  walkTownVisit(s, rng);
  finishTownVisit(s);
  startTownVisit(s, "ch4");
  return s;
}
