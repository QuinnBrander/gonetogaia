/**
 * Encounter — live, mutable wave state.
 *
 * The static spawn data in `data/quest1.json` only describes the INITIAL
 * board layout. Once a wave starts, the live state of the board (where
 * each delver actually IS now, what damage each enemy has taken, who's
 * dead) lives on `state.encounter`.
 *
 * This module owns:
 *   1. Bootstrapping: turn `quest.spawn` + a (random) minion-id
 *      assignment into a full `EncounterState`.
 *   2. Spatial lookups: given a tile, what's on it.
 *   3. Instance lookups: given an instanceId, find the enemy.
 *
 * Movement / combat / kills mutate the encounter; this file does not.
 *
 * See DESIGN.md §6.1 for the data-model rules.
 */

import { applyAssaultBonuses } from "./townsfolk";
import { beginQuestDeathRecord } from "../state";
import type {
  CampaignState,
  EncounterState,
  EnemyInstance,
  HeroTurnState,
} from "../state";
import type { EnemyCard, Quest, QuestWaveSpawn, SpawnCard } from "../types";
import {
  drawSpawnCard,
  ENEMIES,
  FRIENDLY_SPAWN_CARD_NUMBERS,
  getEnemy,
  getQuestWave,
  getSpawnCard,
  isFriendlySpawnCardNumber,
  LEVEL_DECK,
  lieutenantEnemyIdFor,
  shuffleSpawnDeck,
  shuffleSpawnDeckWithFriendly,
  SCENARIO_CARDS,
  SPAWN_CARDS,
} from "../data";
import { shuffle } from "../util/random";
import { applyShopGrantsForQuest, applyShopGrantsForWave } from "./shopGrants";
import { applyOpinionGrantsForQuest } from "./opinionGrants";
import { applyEquipmentRollsForQuest } from "./tokens";
import { startScenarioCard } from "./scenarioCard";
import { logEvent } from "../debug/sessionLog";
import { holdsOpinionCard } from "./opinionEffects";

/**
 * Strategy for picking which printed minion card ends up at each spawn
 * slot. Pulled out so tests can pass a deterministic version.
 *
 * Default = Fisher-Yates shuffle of the quest's minion pool.
 */
export type MinionAssignmentFn = (pool: readonly string[]) => string[];

const defaultMinionAssignment: MinionAssignmentFn = (pool) =>
  shuffle([...pool]);

/**
 * Strategy for picking which Spawn Card a spawn-deck wave bootstraps
 * from. Returns the drawn card's printed number (1..14). Pulled out
 * so tests can pin a specific card without seeding `Math.random`.
 *
 * Default = shuffle + draw via `data.ts` helpers (uses `Math.random`).
 */
export type SpawnCardDrawFn = () => number;

const defaultSpawnCardDraw: SpawnCardDrawFn = () => {
  // Base-only draw -- kept as the back-compat default for tests
  // / call sites that don't have a CampaignState in hand. The
  // production call path in `ensureEncounter` / `resetEncounter`
  // / `bootstrapWaveAtNumber` upgrades to `makeStateSpawnCardDraw`
  // so the campaign's `friendlySpawnDeck` participates in the
  // shuffle.
  const pile = shuffleSpawnDeck();
  const { card } = drawSpawnCard(pile);
  return card.number;
};

/**
 * State-aware default draw that mixes the campaign's owned
 * friendly spawn cards (`state.friendlySpawnDeck`) into the
 * base shuffle. Used by every production bootstrap path so a
 * granted friendly spawn card actually has a chance to draw.
 *
 * The draw doesn't itself consume the friendly entry; that's
 * `bootstrapWaveAtNumber`'s job after the build (so a test that
 * pins the draw deterministically still drives the consume
 * step via the same code path).
 */
function makeStateSpawnCardDraw(state: CampaignState): SpawnCardDrawFn {
  return () => {
    // A storybook Lieutenant challenge put a card on top: draw it.
    if (state.lieutenantSpawnOnTop !== null) return state.lieutenantSpawnOnTop;
    const withFriendly = shuffleSpawnDeckWithFriendly(state.friendlySpawnDeck);
    // Owned friendly cards sit on top; Lieutenants Spawn Cards the campaign
    // has added are shuffled in with the base cards.
    const friendly = withFriendly.slice(0, state.friendlySpawnDeck.length);
    const rest = shuffle([...withFriendly.slice(state.friendlySpawnDeck.length), ...state.lieutenantSpawnDeck]);
    const { card } = drawSpawnCard([...friendly, ...rest]);
    return card.number;
  };
}

/** Clear the Lieutenant on-top slot once a wave has drawn that card. */
function consumeLieutenantSpawnOnTop(state: CampaignState): void {
  const onTop = state.lieutenantSpawnOnTop;
  if (onTop === null || state.encounter?.spawnCardDrawn !== onTop) return;
  state.lieutenantSpawnOnTop = null;
  logEvent("engine.consumeLieutenantSpawnOnTop", { drawn: onTop });
}

/**
 * Optional injectable hooks for `ensureEncounter` / `resetEncounter`
 * / `buildEncounter`. Tests can pin minion assignment + spawn-card
 * draw deterministically without monkey-patching globals.
 */
export interface EncounterBuildHooks {
  assign?: MinionAssignmentFn;
  drawSpawnCardNumber?: SpawnCardDrawFn;
}

/**
 * Upgrade a hooks bag so its `drawSpawnCardNumber` defaults to the
 * state-aware draw (base shuffle + `state.friendlySpawnDeck`).
 * Leaves an explicit `drawSpawnCardNumber` override intact so tests
 * can still pin a specific card without losing the deterministic
 * draw path.
 */
function withStateAwareSpawnDraw(
  state: CampaignState,
  hooks: EncounterBuildHooks,
): EncounterBuildHooks {
  if (hooks.drawSpawnCardNumber !== undefined) return hooks;
  return { ...hooks, drawSpawnCardNumber: makeStateSpawnCardDraw(state) };
}

/**
 * If the just-built encounter drew a friendly spawn card, consume
 * it from `state.friendlySpawnDeck` so it can't draw twice in the
 * same campaign (mirrors the printed "discard the card" rule for
 * one-shot friendly encounter setups). Safe to call when the
 * encounter is null OR drew a base card -- both branches short-
 * circuit.
 */
function consumeDrawnFriendlySpawnCard(state: CampaignState): void {
  const enc = state.encounter;
  if (!enc) return;
  const drawn = enc.spawnCardDrawn;
  if (drawn === null) return;
  if (!isFriendlySpawnCardNumber(drawn)) return;
  const before = state.friendlySpawnDeck.slice();
  const idx = state.friendlySpawnDeck.indexOf(drawn);
  if (idx < 0) {
    // The card was drawn but not in the campaign's friendly deck.
    // Defensive: a hook test that pins `drawSpawnCardNumber` to a
    // friendly card without granting it via `state.friendlySpawnDeck`
    // would land here. Log + leave the deck alone so the test sees
    // the predictable "drawn but not owned" state.
    logEvent("engine.consumeFriendlySpawnCard.skip", {
      reason: "not-in-deck",
      drawn,
      friendlySpawnDeck: before,
    });
    return;
  }
  state.friendlySpawnDeck = [...before.slice(0, idx), ...before.slice(idx + 1)];
  logEvent("engine.consumeFriendlySpawnCard", {
    drawn,
    friendlySpawnDeckBefore: before,
    friendlySpawnDeckAfter: state.friendlySpawnDeck.slice(),
  });
}

/**
 * Make sure `state.encounter` exists for the given quest. If
 * `state.encounter` is already populated and looks consistent with
 * the quest (same questId, same waveNumber, same expected board
 * shape), leaves it alone so a page refresh / reload preserves the
 * in-progress wave. Otherwise builds a fresh `EncounterState` from
 * the quest's spawn data.
 *
 * `assign` legacy parameter shape kept for back-compat with
 * existing call sites (most pass only the quest). Pass a full
 * {@link EncounterBuildHooks} object to also pin the spawn-card
 * draw deterministically.
 *
 * Mutates `state` and returns the live encounter for convenience.
 */
export function ensureEncounter(
  state: CampaignState,
  quest: Quest,
  hooksOrAssign: EncounterBuildHooks | MinionAssignmentFn = {},
): EncounterState {
  const hooks = withStateAwareSpawnDraw(
    state,
    typeof hooksOrAssign === "function" ? { assign: hooksOrAssign } : hooksOrAssign,
  );
  // Apply Quest-Bonus shop grants BEFORE the early-return below: a
  // save loaded mid-quest (where the encounter is still consistent
  // and we'd return `existing` straight away) still needs grants
  // applied if they haven't been yet. The flag-gate inside
  // `applyShopGrantsForQuest` makes this idempotent — second call
  // for the same questId is a no-op.
  applyShopGrantsForQuest(state, quest.id);
  const existing = state.encounter;
  if (existing && isConsistent(existing, quest, Object.keys(state.loadouts))) {
    // Opinion grants run AFTER the encounter exists (their queue
    // lives on `encounter.pendingOpinionRankPicks`), and they're
    // idempotent via `opinionGrantsAppliedQuests` so this is a
    // no-op for an in-progress quest that already enqueued its
    // picks. Re-fire path matters only for a save loaded mid-quest
    // before opinion-grant support shipped.
    applyOpinionGrantsForQuest(state, quest.id);
    return existing;
  }
  const fresh = buildEncounter(quest, Object.keys(state.loadouts), hooks, 1, state.ultraLevelCardsOwned, dahliaMinLieutenants(state));
  state.encounter = fresh;
  // A quest starts: the once-per-quest Witness ability is available again.
  state.witnessAbilityUsed = false;
  beginQuestDeathRecord(state, quest.id);
  consumeDrawnFriendlySpawnCard(state);
  consumeLieutenantSpawnOnTop(state);
  // Wave-Bonus shop grants fire at every fresh wave build. NOT
  // gated — wave bonuses re-trigger every wave per their printed
  // text ("Start EACH wave with +1 Fire Element Token"). The
  // gate-by-rebuild is correct: a consistent existing encounter
  // already had wave bonuses applied when it was first built.
  applyShopGrantsForWave(state);
  applyOpinionGrantsForQuest(state, quest.id);
  applyEquipmentRollsForQuest(state, quest.id);
  // Ch4 Assault on Bird's Nest: townsfolk assisting with combat.
  if (quest.id === "assault") applyAssaultBonuses(state);
  return fresh;
}

/**
 * Force a clean rebuild of the encounter (used when starting a new
 * wave or restarting the quest). Use sparingly — most callers want
 * `ensureEncounter` so they don't blow away in-progress state.
 */
export function resetEncounter(
  state: CampaignState,
  quest: Quest,
  hooksOrAssign: EncounterBuildHooks | MinionAssignmentFn = {},
): EncounterState {
  const hooks = withStateAwareSpawnDraw(
    state,
    typeof hooksOrAssign === "function" ? { assign: hooksOrAssign } : hooksOrAssign,
  );
  // Same shop-grant order as `ensureEncounter`: quest grants first
  // (idempotent), then build the fresh encounter, then wave grants.
  applyShopGrantsForQuest(state, quest.id);
  state.encounter = buildEncounter(quest, Object.keys(state.loadouts), hooks, 1, state.ultraLevelCardsOwned, dahliaMinLieutenants(state));
  consumeDrawnFriendlySpawnCard(state);
  consumeLieutenantSpawnOnTop(state);
  applyShopGrantsForWave(state);
  applyOpinionGrantsForQuest(state, quest.id);
  applyEquipmentRollsForQuest(state, quest.id);
  return state.encounter;
}

/**
 * Bootstrap a fresh encounter at a SPECIFIC wave number on the
 * given quest. Used by the W1 → W2 (and future W2 → W3) end-of-
 * wave transition: the UI hands us the next wave's number after
 * the player resolves any between-wave choices (page 2.3's
 * element grant, the post-W2 Return/FollowShouts split), and we
 * build the new encounter so the next BoardScreen render lands
 * in the `delver-spawn-pick` phase.
 *
 * Wave-Bonus shop grants re-apply (per-wave is the contract);
 * Quest-Bonus grants stay idempotent (already applied at quest
 * start). Caller is responsible for having cleared the old
 * encounter via `completeWave` before this fires — otherwise
 * we'd silently stomp an in-progress wave.
 */
export function bootstrapWaveAtNumber(
  state: CampaignState,
  quest: Quest,
  waveNumber: number,
  hooksOrAssign: EncounterBuildHooks | MinionAssignmentFn = {},
): EncounterState {
  const hooks = withStateAwareSpawnDraw(
    state,
    typeof hooksOrAssign === "function" ? { assign: hooksOrAssign } : hooksOrAssign,
  );
  applyShopGrantsForQuest(state, quest.id);
  state.encounter = buildEncounter(quest, Object.keys(state.loadouts), hooks, waveNumber, state.ultraLevelCardsOwned, dahliaMinLieutenants(state));
  consumeDrawnFriendlySpawnCard(state);
  consumeLieutenantSpawnOnTop(state);
  applyShopGrantsForWave(state);
  applyOpinionGrantsForQuest(state, quest.id);
  applyEquipmentRollsForQuest(state, quest.id);
  // Scenario Card trigger — fired AFTER buildEncounter so the
  // board is fully set up before the modal mounts. The trigger
  // is gated by:
  //   - The wave def must declare `scenarioCardOnStart`. Wave 1
  //     never triggers (rulebook: deck not used during Ch1, and
  //     no quest data sets W1's `scenarioCardOnStart`).
  //   - `startScenarioCard` itself short-circuits when the
  //     number is already in `state.scenarioCardsResolved` (the
  //     printed "discard the card" rule survives across waves)
  //     OR when the same number is already in-flight (a debug
  //     re-bootstrap of the same wave shouldn't wipe a partial
  //     pick).
  const waveDef = quest.waves.find((w) => w.number === waveNumber);
  if (waveDef?.scenarioCardOnStart !== undefined) {
    startScenarioCard(state, waveDef.scenarioCardOnStart);
  } else if (waveDef?.scenarioCardDraw) {
    const drawn = drawScenarioCard(state);
    if (drawn !== null) startScenarioCard(state, drawn);
  }
  logEvent("engine.bootstrapWaveAtNumber", {
    questId: quest.id,
    waveNumber,
    phase: state.encounter.phase,
    scenarioCardOnStart: waveDef?.scenarioCardOnStart ?? null,
  });
  return state.encounter;
}

// --- 2-card bosses (Ch3 Oblivionwing) -----------------------------------

/** The second card of a 2-card boss (the card whose `partOf` is
 *  `bossCardId`), or null for an ordinary 1-card boss. */
export function bossPartCardFor(bossCardId: string): EnemyCard | null {
  return ENEMIES.find((c) => c.partOf === bossCardId) ?? null;
}

/** True for either card of a 2-card boss. Such cards can't be moved or
 *  rotated (the two cards must stay side by side). */
export function isMultiCardBoss(encounter: EncounterState, enemy: EnemyInstance): boolean {
  return !!enemy.linkedTo || encounter.enemies.some((e) => e.linkedTo === enemy.instanceId);
}

/**
 * "During spawn, place the 2/2 card to the east of the 1/2 card, shuffling
 * cards around as needed." The boss keeps its printed tile unless it is on
 * the east edge (then it shifts one tile west). Any minion sitting on the
 * two boss tiles moves to the nearest tile that is free and isn't a
 * delver / Witness / token tile.
 */
function attachBossPart(resolved: ResolvedSpawn, partCardId: string, board: { w: number; h: number }): void {
  const boss = resolved.enemyPlacements.find((p) => p.instanceId === "boss")!;
  const origin = { x: boss.x, y: boss.y };
  const reserved = new Set<string>([
    ...Object.values(resolved.delverPositions).map((p) => `${p.x},${p.y}`),
    ...(resolved.witnessPosition ? [`${resolved.witnessPosition.x},${resolved.witnessPosition.y}`] : []),
    ...resolved.memoryFragments.map((p) => `${p.x},${p.y}`),
    ...resolved.friendlyEncounters.map((p) => `${p.x},${p.y}`),
    ...(resolved.spawnCardDrawn != null ? getSpawnCard(resolved.spawnCardDrawn).delverSpawns.map((p) => `${p.x},${p.y}`) : []),
  ]);
  // Anchor the 1/2 card on the printed tile if the 2/2 card fits east of
  // it; otherwise on the nearest tile where both cards fit.
  let anchor: { x: number; y: number; d: number } | null = null;
  for (let y = 0; y < board.h; y++) {
    for (let x = 0; x + 1 < board.w; x++) {
      if (reserved.has(`${x},${y}`) || reserved.has(`${x + 1},${y}`)) continue;
      const d = Math.max(Math.abs(x - origin.x), Math.abs(y - origin.y));
      if (!anchor || d < anchor.d) anchor = { x, y, d };
    }
  }
  if (!anchor) throw new Error("attachBossPart: no room for a 2-card boss");
  boss.x = anchor.x;
  boss.y = anchor.y;
  const bossTiles = [{ x: boss.x, y: boss.y }, { x: boss.x + 1, y: boss.y }];
  const occupied = () => new Set(resolved.enemyPlacements.map((p) => `${p.x},${p.y}`));
  const isBossTile = (x: number, y: number) => bossTiles.some((t) => t.x === x && t.y === y);
  for (const p of resolved.enemyPlacements) {
    if (p.instanceId === "boss" || !isBossTile(p.x, p.y)) continue;
    const taken = occupied();
    let best: { x: number; y: number; d: number } | null = null;
    for (let y = 0; y < board.h; y++) {
      for (let x = 0; x < board.w; x++) {
        const k = `${x},${y}`;
        if (taken.has(k) || reserved.has(k) || isBossTile(x, y)) continue;
        const d = Math.max(Math.abs(x - origin.x), Math.abs(y - origin.y));
        if (!best || d < best.d) best = { x, y, d };
      }
    }
    if (!best) throw new Error("attachBossPart: no free tile to move a minion off the boss tiles");
    p.x = best.x;
    p.y = best.y;
  }
  resolved.enemyPlacements.push({ instanceId: "boss-part", cardId: partCardId, x: boss.x + 1, y: boss.y });
}

// --- Spatial lookups -----------------------------------------------------

/** Find the live enemy on tile (x, y), or `null` if none. Skips dead enemies. */
export function getEnemyAt(
  encounter: EncounterState,
  x: number,
  y: number,
): EnemyInstance | null {
  for (const e of encounter.enemies) {
    if (e.alive && e.x === x && e.y === y) return e;
  }
  return null;
}

/** Get a delver's current tile, or `null` if the hero isn't on the board. */
export function getDelverAt(
  encounter: EncounterState,
  heroId: string,
): { x: number; y: number } | null {
  return encounter.delverPositions[heroId] ?? null;
}

/** Hero ids of all delvers currently standing on tile (x, y). */
export function getDelversAt(
  encounter: EncounterState,
  x: number,
  y: number,
): string[] {
  const ids: string[] = [];
  for (const [heroId, pos] of Object.entries(encounter.delverPositions)) {
    if (pos.x === x && pos.y === y) ids.push(heroId);
  }
  return ids;
}

/** Look up a specific enemy instance (alive or dead) by its stable id. */
export function getEnemyInstance(
  encounter: EncounterState,
  instanceId: string,
): EnemyInstance | null {
  for (const e of encounter.enemies) {
    if (e.instanceId === instanceId) return e;
  }
  return null;
}

// --- Internal ------------------------------------------------------------

/**
 * Resolved spawn data — the variant-agnostic shape consumed by the
 * lower half of `buildEncounter`. Both `hand-authored` and
 * `spawn-deck` spawn variants funnel through this so the rest of
 * the encounter setup (enemy placement, level-up deck, phase
 * bootstrap) stays a single code path.
 */
interface ResolvedSpawn {
  delverPositions: Record<string, { x: number; y: number }>;
  enemyPlacements: Array<{ instanceId: string; cardId: string; x: number; y: number }>;
  /** Initial phase. Hand-authored (Q1) lands directly in
   *  `"first-turn-pick"` (no compass-tile picker); spawn-deck (Q2+)
   *  lands in `"delver-spawn-pick"` first and walks to
   *  `"first-turn-pick"` via `startWaveAfterPick`. Both kinds then
   *  reach `"hero"` via `commitFirstTurnPick`. */
  initialPhase: "delver-spawn-pick" | "first-turn-pick";
  /** Card number drawn from the deck, or `null` for hand-authored. */
  spawnCardDrawn: number | null;
  /** Tile positions of Memory Fragment tokens placed on the board
   *  at wave start. Empty for hand-authored variants (Q1) and for
   *  Spawn Cards with no printed diamond glyph. */
  memoryFragments: Array<{ x: number; y: number }>;
  /** Tile positions of Friendly Encounter tokens placed on the
   *  board at wave start. Empty for hand-authored waves (Q1)
   *  and for non-Friendly Spawn Cards (#01..#12). Populated only
   *  when the drawn card is a Friendly Spawn Card (#13, #14). */
  friendlyEncounters: Array<{ x: number; y: number }>;
  /** Witness's starting tile, or `null` if the quest doesn't ship
   *  with the Witness companion. See `hasWitness` for the
   *  per-quest gate. */
  witnessPosition: { x: number; y: number } | null;
}

/**
 * Does this quest ship with the Witness companion (Q2+ per the
 * Chapter 2 storybook reveal)? Single source of truth so the spawn
 * resolver, the picker UI, and any future "is Witness on the
 * board?" check stay in sync without scattered string equality.
 *
 * Today: `quest2` only. Future Chapter 3+ quests will likely
 * also include him — adding their ids here is the only change
 * needed to switch them on (the rest of the engine + UI already
 * branch on `encounter.witnessPosition != null`).
 */
export function hasWitness(quest: Quest): boolean {
  return quest.id !== "quest1";
}

function buildEncounter(
  quest: Quest,
  heroIds: string[],
  hooks: EncounterBuildHooks,
  waveNumber: number = 1,
  ultraOwned: readonly number[] = [],
  minLieutenants: number = 0,
): EncounterState {
  const wave = getQuestWave(quest, waveNumber);
  const assign = hooks.assign ?? defaultMinionAssignment;
  const drawSpawnCardNumber = hooks.drawSpawnCardNumber ?? defaultSpawnCardDraw;

  const resolved = resolveSpawn(
    wave.spawn,
    heroIds,
    wave.bossEnemyId,
    wave.minionEnemyIds,
    assign,
    drawSpawnCardNumber,
    hasWitness(quest),
  );

  const partCard = bossPartCardFor(wave.bossEnemyId);
  if (partCard) attachBossPart(resolved, partCard.id, wave.spawn.boardSize);
  topUpLieutenants(resolved, wave.bossEnemyId, minLieutenants, wave.spawn.boardSize);
  const enemies: EnemyInstance[] = resolved.enemyPlacements.map((p) =>
    makeInstance(p.instanceId, p.cardId, p.x, p.y),
  );
  if (partCard) {
    const part = enemies.find((e) => e.cardId === partCard.id)!;
    part.linkedTo = "boss";
  }

  // Initialize per-Delver per-turn state and prepared-to-run latches.
  // Both start "fresh" — placement still required before movement/action.
  const turnState: Record<string, HeroTurnState> = {};
  const preparedToRun: Record<string, boolean> = {};
  for (const heroId of heroIds) {
    turnState[heroId] = freshTurnState();
    preparedToRun[heroId] = false;
  }

  // Shuffle the 24 base level-up cards once per encounter (rulebook
  // p24), plus any Ultra Level Up cards the campaign owns (rulebook:
  // Ch1 Library "Creature Archives" grants 2; future chapters add
  // more). Cards flagged `isUltra` are EXCLUDED from the base deck —
  // their inclusion is gated on `state.ultraLevelCardsOwned`. The
  // owned-set is intersected with the printed Ultra card numbers so
  // a stale save (e.g. a number the dataset no longer recognizes)
  // can't smuggle a phantom card into the deck. Drawn from the
  // front; reshuffled from `levelUpDiscard` if the party manages to
  // drain the whole deck.
  const printedUltras = new Set(LEVEL_DECK.filter((c) => c.isUltra).map((c) => c.cardNumber));
  const baseDeck = LEVEL_DECK.filter((c) => !c.isUltra).map((c) => c.cardNumber);
  const ownedUltras = ultraOwned.filter((n) => printedUltras.has(n));
  const levelUpDeck = shuffle([...baseDeck, ...ownedUltras]);

  logEvent("engine.buildEncounter", {
    questId: quest.id,
    waveNumber,
    spawnKind: wave.spawn.kind,
    spawnCardDrawn: resolved.spawnCardDrawn,
    initialPhase: resolved.initialPhase,
    enemyCount: enemies.length,
  });

  return {
    questId: quest.id,
    waveNumber,
    delverPositions: resolved.delverPositions,
    witnessPosition: resolved.witnessPosition,
    enemies,
    turnState,
    preparedToRun,
    phase: resolved.initialPhase,
    partingShotCursor: 0,
    endWaveRefresh: null,
    endOfWavePageId: null,
    endOfWaveOutcome: null,
    levelUpDeck,
    levelUpDiscard: [],
    pendingLevelUpDraws: [],
    pendingElementChoices: [],
    pendingEquipmentRolls: [],
    pendingXpRolls: [],
    pendingOpinionRankPicks: [],
    pendingCreaturePartChoices: [],
    beamRepeatsRemaining: {},
    tileDrops: [],
    countdownTokens: 0,
    accurateMarks: {},
    omenTokens: {},
    rebirthTiles: [],
    enemyDiedThisHeroTurn: false,
    combatOnlyTokens: [],
    stolenWeapon: null,
    ritualSacrifices: [],
    pendingRitualPicks: [],
    corruption: null,
    spawnCardDrawn: resolved.spawnCardDrawn,
    memoryFragments: resolved.memoryFragments,
    friendlyEncounters: resolved.friendlyEncounters,
  };
}

/**
 * Fan out by spawn variant to produce a uniform `ResolvedSpawn`.
 * Keeps the variant-specific quirks (compass-tile picker, deck
 * draw) bundled here so `buildEncounter` reads top-down.
 *
 * `hand-authored` (Q1 style) — every position is baked into JSON.
 * Both delvers default to `delverStart` (spawn-stacking allowed,
 * DESIGN.md §5.1) and the wave boots straight into `"hero"`.
 *
 * `spawn-deck` (Q2+ style) — draw one Spawn Card from the base
 * deck, place the boss + 7 minions at the card's printed marker
 * tiles, and default BOTH delvers to the first of the 2 compass
 * tiles. The wave parks in `"delver-spawn-pick"` until the
 * picker UI calls `assignDelverToTile` + `startWaveAfterPick`.
 */
function resolveSpawn(
  spawn: QuestWaveSpawn,
  heroIds: string[],
  bossEnemyId: string,
  minionEnemyIds: readonly string[],
  assign: MinionAssignmentFn,
  drawSpawnCardNumber: SpawnCardDrawFn,
  includeWitness: boolean,
): ResolvedSpawn {
  switch (spawn.kind) {
    case "hand-authored": {
      const delverPositions: Record<string, { x: number; y: number }> = {};
      for (const heroId of heroIds) {
        delverPositions[heroId] = { x: spawn.delverStart.x, y: spawn.delverStart.y };
      }
      const placements: ResolvedSpawn["enemyPlacements"] = [
        { instanceId: "boss", cardId: bossEnemyId, x: spawn.boss.x, y: spawn.boss.y },
      ];
      const minionPool = assign(minionEnemyIds);
      spawn.minions.forEach((pos, idx) => {
        const cardId = minionPool[idx] ?? minionEnemyIds[idx]!;
        placements.push({ instanceId: `minion-${idx}`, cardId, x: pos.x, y: pos.y });
      });
      // Hand-authored quests don't currently ship with Witness
      // (Q1 only), so we honor the `includeWitness` flag but
      // default him to the delver start tile if a future
      // hand-authored quest opts in. Same compass-A semantics
      // as the spawn-deck branch — keeps the picker's "tap to
      // reposition" flow consistent across spawn kinds.
      const witnessPosition = includeWitness
        ? { x: spawn.delverStart.x, y: spawn.delverStart.y }
        : null;
      return {
        delverPositions,
        enemyPlacements: placements,
        // Hand-authored waves skip the compass-tile picker (spawn
        // tile is baked into JSON) but still go through the
        // "who takes the first turn?" picker — that runs at the
        // start of every wave regardless of spawn shape so the
        // player can review each delver's suit board before
        // locking in their turn-1 hero.
        initialPhase: "first-turn-pick",
        spawnCardDrawn: null,
        memoryFragments: [],
        friendlyEncounters: [],
        witnessPosition,
      };
    }
    case "spawn-deck": {
      const cardNumber = drawSpawnCardNumber();
      const card = getSpawnCard(cardNumber);
      assertSpawnCardShape(card, minionEnemyIds.length);
      // Default both delvers onto the FIRST compass tile. The
      // DelverSpawnPick screen lets the user keep them stacked
      // OR split them onto compass tile B; both stacking and
      // splitting are legal per rulebook (the printed cards
      // explicitly show "free pick per delver").
      const defaultTile = card.delverSpawns[0]!;
      const delverPositions: Record<string, { x: number; y: number }> = {};
      for (const heroId of heroIds) {
        delverPositions[heroId] = { x: defaultTile.x, y: defaultTile.y };
      }
      const placements: ResolvedSpawn["enemyPlacements"] = [
        { instanceId: "boss", cardId: bossEnemyId, x: card.bosses[0]!.x, y: card.bosses[0]!.y },
      ];
      const minionPool = assign(minionEnemyIds);
      card.minions.forEach((pos, idx) => {
        const cardId = minionPool[idx] ?? minionEnemyIds[idx]!;
        placements.push({ instanceId: `minion-${idx}`, cardId, x: pos.x, y: pos.y });
      });
      // Lieutenants Spawn Cards: one Lieutenant per printed tile, at the
      // level of the wave's boss.
      (card.lieutenants ?? []).forEach((pos, idx) => {
        placements.push({
          instanceId: `lieutenant-${idx}`,
          cardId: lieutenantEnemyIdFor(bossLevelOf(bossEnemyId), idx),
          x: pos.x,
          y: pos.y,
        });
      });
      // Memory Fragment tokens (if any) land on the printed
      // diamond tiles. Stored on the encounter so pickup wiring
      // (future slice) can drain them as delvers walk onto each
      // tile and bump `state.memoryChips`. For now they're a
      // visible, non-interactive board token: BoardScreen +
      // DelverSpawnPick + WavePhases paint a "Memory Fragment"
      // icon at each (x, y) so the player knows the diamond
      // glyph from the printed card has actually been honoured.
      // Hand-authored quests stay at `[]` (no spawn card = no
      // diamond glyph to surface).
      const memoryFragments = card.memoryFragments.map((m) => ({ x: m.x, y: m.y }));
      // Friendly Encounter tokens (only on Friendly Spawn Cards
      // #13 + #14 today). Empty array for every base spawn card.
      // Pickup wiring lives in `engine/friendlyEncounter.ts >
      // collectFriendlyEncountersAt`, called from both
      // `moveDelverStep` and `stepWitness` when a mover lands on
      // a token tile.
      const friendlyEncounters = (card.friendlyEncounters ?? []).map((f) => ({ x: f.x, y: f.y }));
      // Witness defaults to compass tile A (same as both delvers)
      // for the same reason — the picker re-prompts the player to
      // place him deliberately, so the engine just needs a valid
      // tile so the board can render him before commit.
      const witnessPosition = includeWitness
        ? { x: defaultTile.x, y: defaultTile.y }
        : null;
      return {
        delverPositions,
        enemyPlacements: placements,
        initialPhase: "delver-spawn-pick",
        spawnCardDrawn: card.number,
        memoryFragments,
        friendlyEncounters,
        witnessPosition,
      };
    }
  }
}

/**
 * Dahlia's Detractor / Nemesis cards: "Each wave of combat must contain at
 * least 1 / 2 Lieutenants - if it wouldn't, add one to a tile of your
 * choice, matching the level of the enemies." Returns the minimum for the
 * held card (0 without one).
 */
export function dahliaMinLieutenants(state: CampaignState): number {
  if (holdsOpinionCard(state, "dahlia", "nemesis")) return 2;
  if (holdsOpinionCard(state, "dahlia", "detractor")) return 1;
  return 0;
}

/** Instance-id prefix of the Lieutenants Dahlia's cards add. */
const DAHLIA_LIEUTENANT_PREFIX = "dahlia-lieutenant-";

/**
 * Add Lieutenants until the wave has `min` of them. Players choose the tile
 * at the table; the prototype takes the free tile nearest the boss (ties:
 * board order), never a delver / Witness / spawn / token tile.
 */
function topUpLieutenants(resolved: ResolvedSpawn, bossEnemyId: string, min: number, board: { w: number; h: number }): void {
  const have = resolved.enemyPlacements.filter((p) => getEnemy(p.cardId).kind === "lieutenant").length;
  if (have >= min) return;
  const boss = resolved.enemyPlacements.find((p) => p.instanceId === "boss")!;
  const reserved = new Set<string>([
    ...Object.values(resolved.delverPositions).map((p) => `${p.x},${p.y}`),
    ...(resolved.witnessPosition ? [`${resolved.witnessPosition.x},${resolved.witnessPosition.y}`] : []),
    ...resolved.memoryFragments.map((p) => `${p.x},${p.y}`),
    ...resolved.friendlyEncounters.map((p) => `${p.x},${p.y}`),
    ...(resolved.spawnCardDrawn != null ? getSpawnCard(resolved.spawnCardDrawn).delverSpawns.map((p) => `${p.x},${p.y}`) : []),
  ]);
  const level = bossLevelOf(bossEnemyId);
  for (let slot = have; slot < min; slot++) {
    const taken = new Set(resolved.enemyPlacements.map((p) => `${p.x},${p.y}`));
    let best: { x: number; y: number; d: number } | null = null;
    for (let y = 0; y < board.h; y++) {
      for (let x = 0; x < board.w; x++) {
        const k = `${x},${y}`;
        if (taken.has(k) || reserved.has(k)) continue;
        const d = Math.max(Math.abs(x - boss.x), Math.abs(y - boss.y));
        if (!best || d < best.d) best = { x, y, d };
      }
    }
    if (!best) throw new Error("topUpLieutenants: no free tile for a Lieutenant");
    resolved.enemyPlacements.push({
      instanceId: `${DAHLIA_LIEUTENANT_PREFIX}${slot}`,
      cardId: lieutenantEnemyIdFor(level, slot),
      x: best.x,
      y: best.y,
    });
    logEvent("engine.dahliaLieutenant", { slot, level, x: best.x, y: best.y });
  }
}

/** Printed level of a wave boss ("boss-lvl-N" -> N). */
function bossLevelOf(bossEnemyId: string): number {
  const kind = getEnemy(bossEnemyId).kind;
  const m = /^boss-lvl-(\d)$/.exec(kind);
  if (!m) throw new Error(`bossLevelOf: ${bossEnemyId} is not a boss (kind ${kind})`);
  return Number(m[1]);
}

/**
 * Defensive check: the engine assumes every Spawn Card carries
 * exactly 1 boss + 7 minion + 2 delver-spawn markers (already
 * enforced by `src/__tests__/spawnCards.test.ts` for the shipped
 * `SPAWN_CARDS` catalog). If a quest's `minionEnemyIds` count
 * doesn't match the card's printed minion-tile count, the
 * assignment-by-index loop above would silently leave tiles or
 * pool entries unused — bail loudly instead. Pinned in code so a
 * future quest that authors more / fewer minions per wave gets
 * an immediate, named error pointing at the exact mismatch.
 */
function assertSpawnCardShape(card: SpawnCard, expectedMinionCount: number): void {
  if (card.bosses.length !== 1) {
    throw new Error(`Spawn card #${card.number} has ${card.bosses.length} boss tiles, expected 1`);
  }
  if (card.minions.length !== expectedMinionCount) {
    throw new Error(
      `Spawn card #${card.number} has ${card.minions.length} minion tiles but the wave provides ` +
        `${expectedMinionCount} minion ids — mismatch.`,
    );
  }
  if (card.delverSpawns.length !== 2) {
    throw new Error(
      `Spawn card #${card.number} has ${card.delverSpawns.length} delver-spawn tiles, expected 2 ` +
        `(the printed compass-star pair).`,
    );
  }
}

// --- Delver placement (spawn-deck waves only) ----------------------------

/**
 * Move one delver onto a chosen compass tile during the
 * `"delver-spawn-pick"` phase. Idempotent — safe to call from the
 * picker UI on every radio-button change.
 *
 * Throws if the encounter isn't in the pick phase, the target
 * tile isn't one of the drawn card's printed compass tiles, or
 * the heroId isn't part of the encounter. The intent is fail-loud:
 * the picker UI builds its buttons from the same source data so a
 * mismatch here is a real bug worth surfacing.
 */
export function assignDelverToTile(
  state: CampaignState,
  heroId: string,
  x: number,
  y: number,
): void {
  const enc = state.encounter;
  if (!enc) throw new Error("assignDelverToTile: no encounter");
  if (enc.phase !== "delver-spawn-pick") {
    throw new Error(
      `assignDelverToTile: phase is "${enc.phase}", expected "delver-spawn-pick"`,
    );
  }
  if (enc.spawnCardDrawn == null) {
    throw new Error("assignDelverToTile: no spawn card drawn — pick phase only valid for spawn-deck encounters");
  }
  if (!(heroId in enc.delverPositions)) {
    throw new Error(`assignDelverToTile: unknown heroId "${heroId}"`);
  }
  const card = getSpawnCard(enc.spawnCardDrawn);
  const isCompass = card.delverSpawns.some((t) => t.x === x && t.y === y);
  if (!isCompass) {
    throw new Error(
      `assignDelverToTile: tile (${x}, ${y}) is not a printed compass tile for spawn card #${card.number}`,
    );
  }
  enc.delverPositions[heroId] = { x, y };
  logEvent("engine.assignDelverToTile", {
    heroId,
    x,
    y,
    spawnCardNumber: card.number,
  });
}

/**
 * Move the Witness companion onto a chosen compass tile during
 * the `"delver-spawn-pick"` phase. Mirrors `assignDelverToTile`
 * one-for-one — same phase gate, same tile validation, same
 * idempotency — except Witness has a single `witnessPosition`
 * slot rather than a per-hero map.
 *
 * Throws if the encounter has no Witness (Q1 / non-Q2+), isn't
 * in the pick phase, the tile isn't one of the drawn card's
 * printed compass tiles, or has no drawn card. Fail-loud matches
 * `assignDelverToTile` — the picker UI gates the button on the
 * same compass-tile invariants, so anything that gets here
 * out-of-bounds is a real bug.
 */
export function assignWitnessToTile(
  state: CampaignState,
  x: number,
  y: number,
): void {
  const enc = state.encounter;
  if (!enc) throw new Error("assignWitnessToTile: no encounter");
  if (enc.phase !== "delver-spawn-pick") {
    throw new Error(
      `assignWitnessToTile: phase is "${enc.phase}", expected "delver-spawn-pick"`,
    );
  }
  if (enc.spawnCardDrawn == null) {
    throw new Error("assignWitnessToTile: no spawn card drawn — pick phase only valid for spawn-deck encounters");
  }
  if (enc.witnessPosition == null) {
    throw new Error("assignWitnessToTile: encounter has no Witness (witnessPosition is null)");
  }
  const card = getSpawnCard(enc.spawnCardDrawn);
  const isCompass = card.delverSpawns.some((t) => t.x === x && t.y === y);
  if (!isCompass) {
    throw new Error(
      `assignWitnessToTile: tile (${x}, ${y}) is not a printed compass tile for spawn card #${card.number}`,
    );
  }
  enc.witnessPosition = { x, y };
  logEvent("engine.assignWitnessToTile", {
    x,
    y,
    spawnCardNumber: card.number,
  });
}

/**
 * Transition from `"delver-spawn-pick"` into `"first-turn-pick"`,
 * the second-stage picker where the player picks WHICH delver takes
 * the first turn (after having placed both delvers on compass tiles
 * in stage one).
 *
 * Called by the DelverSpawnPick screen's "Start Wave" button.
 * Idempotent on already-running waves (no-op if
 * `phase !== "delver-spawn-pick"`) so a double-click can't skip
 * the first-turn picker.
 *
 * `onStartHeroTurn` is kept as a parameter for backward source
 * compatibility with the screen + QA session call sites; it is
 * intentionally NOT invoked here anymore — the hero turn doesn't
 * begin until the player commits a starting delver via
 * `commitFirstTurnPick`. The callers that wire it in haven't
 * changed signature; the unused-arg keeps them compiling without
 * coordinated edits.
 */
export function startWaveAfterPick(
  state: CampaignState,
  _onStartHeroTurn: (state: CampaignState) => void,
): void {
  const enc = state.encounter;
  if (!enc) return;
  if (enc.phase !== "delver-spawn-pick") return;
  enc.phase = "first-turn-pick";
  logEvent("engine.startWaveAfterPick", {
    delverPositions: enc.delverPositions,
    witnessPosition: enc.witnessPosition,
    spawnCardDrawn: enc.spawnCardDrawn,
    nextPhase: enc.phase,
  });
}

/**
 * Transition from `"first-turn-pick"` into `"hero"`, writing the
 * chosen `heroId` to `state.currentDelverId` and firing the first
 * hero turn via the injected `onStartHeroTurn` hook.
 *
 * Called by the FirstTurnPick screen's "Take first turn" button.
 * Idempotent on already-running waves (no-op if
 * `phase !== "first-turn-pick"`) so a stray double-click can't
 * fire `startHeroTurn` twice — which would burn an AP refresh and
 * wipe a freshly-set `turnState` mid-decision.
 *
 * Throws on unknown `heroId` (defensive — the picker UI only ever
 * commits a delver from `state.loadouts`, but throwing rather than
 * silently no-op'ing makes upstream bugs loud).
 */
export function commitFirstTurnPick(
  state: CampaignState,
  heroId: string,
  onStartHeroTurn: (state: CampaignState) => void,
): void {
  const enc = state.encounter;
  if (!enc) return;
  if (enc.phase !== "first-turn-pick") return;
  if (!state.loadouts[heroId]) {
    throw new Error(`commitFirstTurnPick: unknown hero "${heroId}"`);
  }
  state.currentDelverId = heroId;
  enc.phase = "hero";
  logEvent("engine.commitFirstTurnPick", {
    heroId,
    delverPositions: enc.delverPositions,
  });
  onStartHeroTurn(state);
}

/** Re-export so screens can render the drawn card's art without re-importing data.ts directly. */
export { SPAWN_CARDS, getSpawnCard };

// --- Fatal Flaw (rulebook p16) -------------------------------------------

/**
 * Fatal Flaw tier of `enemy`, or `null` if the enemy has no
 * `fatal-flaw` ability. Tier = `level` value on the ability entry
 * — Q2 W1 ships Venena (tier 1) and Goldmonger (tier 2); future
 * waves push this up to tier 3 for the Wave 3 boss.
 *
 * Pure lookup; safe to call every render.
 */
export function getFatalFlawTier(card: import("../types").EnemyCard): number | null {
  for (const a of card.abilities) {
    if (a.kind === "fatal-flaw") return a.level;
  }
  return null;
}

/**
 * Is `enemy` currently protected by Fatal Flaw — i.e. does the
 * rulebook prevent its HP from being reduced below 1 right now?
 *
 * The rule (rulebook p16): *"A tier-N enemy CAN'T be reduced
 * below 1 HP while any tier-(N-1)-or-lower enemy is still alive.
 * Sequential numbers can die in the same turn — N and N+1 aren't
 * gated against each other."*
 *
 * In code: this enemy has tier `N` (`fatal-flaw` ability), AND
 * there exists at least one OTHER alive enemy on the encounter
 * whose Fatal Flaw tier is `< N`. Enemies without the ability
 * (Q1 Crystanids / Soulhunter — `getFatalFlawTier` returns
 * `null`) DON'T count as lower-tier blockers; the rule is
 * about the Fatal Flaw ladder specifically, not about all
 * enemies on the board.
 *
 * Enemies without a Fatal Flaw of their own are never protected
 * (so Q1 enemies + future no-flaw mooks behave as before).
 */
export function isFatalFlawProtected(
  encounter: EncounterState,
  enemy: EnemyInstance,
): boolean {
  const myTier = getFatalFlawTier(getEnemy(enemy.cardId));
  if (myTier == null) return false;
  for (const other of encounter.enemies) {
    if (!other.alive) continue;
    if (other.instanceId === enemy.instanceId) continue;
    const otherCard = getEnemy(other.cardId);
    // Treat enemies that have already absorbed lethal damage in this
    // same attack batch as dead — alive is deferred to finalizeAttackSession
    // so the counter prompt can still paint the dying token, but for the
    // Fatal Flaw ladder check they count as gone.
    if (other.damageTaken >= otherCard.hp) continue;
    const tier = getFatalFlawTier(otherCard);
    if (tier == null) continue;
    if (tier < myTier) return true;
  }
  return false;
}

/**
 * Apply a proposed `damageTaken` increment to `enemy`, clamping
 * to `maxHp - 1` if Fatal Flaw currently protects it. Returns
 * the resolved new `damageTaken` value plus a `blocked` flag
 * the caller can use to surface the rule to the player (e.g.
 * log a `combat.fatalFlawBlocked` event).
 *
 * `proposedDelta` is the damage the caller WANTED to apply
 * (i.e. `session.damage` per tile, NOT the post-clamp number).
 * Splitting the clamp out as a pure helper means every damage
 * site — `applyDamageAtTile`, `resolveAllDamage`, future
 * abilities — funnels through the same rule without copy-pasting
 * the "Math.min(damageTaken + delta, maxHp - 1)" logic.
 *
 * Pure (no encounter mutation). The caller writes the returned
 * value back onto `enemy.damageTaken`.
 */
export function clampDamageForFatalFlaw(
  encounter: EncounterState,
  enemy: EnemyInstance,
  proposedDelta: number,
): { newDamageTaken: number; blocked: boolean; absorbed: number } {
  const card = getEnemy(enemy.cardId);
  const wouldKill = enemy.damageTaken + proposedDelta >= card.hp;
  if (!wouldKill || !isFatalFlawProtected(encounter, enemy)) {
    return { newDamageTaken: enemy.damageTaken + proposedDelta, blocked: false, absorbed: 0 };
  }
  const clampedDamageTaken = Math.max(enemy.damageTaken, card.hp - 1);
  const absorbed = (enemy.damageTaken + proposedDelta) - clampedDamageTaken;
  return { newDamageTaken: clampedDamageTaken, blocked: true, absorbed };
}

/** A pristine `HeroTurnState`: nothing placed, nothing used. */
export function freshTurnState(): HeroTurnState {
  return {
    cardPlacedThisTurn: null,
    actionUsedThisTurn: false,
    movementUsedThisTurn: false,
    movementStepsThisTurn: 0,
    apMovementDoubledThisTurn: false,
    actionGrantedExtraMovement: false,
    damage2xUsedThisTurn: false,
    doubleDamageActive: {},
    witnessStepsThisTurn: 0,
    movementSnapshot: null,
  };
}

function makeInstance(
  instanceId: string,
  cardId: string,
  x: number,
  y: number,
): EnemyInstance {
  // facing 0 = "as printed on the card" — counter pattern offsets in
  // `data/enemies.json` are authored against this orientation.
  const inst: EnemyInstance = { instanceId, cardId, x, y, damageTaken: 0, alive: true, facing: 0 };
  // On-spawn monster tokens (Ch3 Guards / Vicious).
  for (const ab of getEnemy(cardId).abilities) {
    if (ab.kind === "guards") inst.guardTokens = ab.tokens;
    if (ab.kind === "vicious") inst.viciousToken = true;
  }
  return inst;
}

/**
 * Sanity check: an existing encounter is "consistent" with the quest if
 *   - it's for the same quest,
 *   - its enemy count matches the quest's spawn (boss + minions),
 *   - every enemy's cardId is recognised by `data.ts > getEnemy`,
 *   - every hero in the campaign has a position.
 *
 * If anything looks off (e.g. data file changed, hero list grew), we
 * rebuild rather than try to migrate.
 */
function isConsistent(
  encounter: EncounterState,
  quest: Quest,
  heroIds: string[],
): boolean {
  if (encounter.questId !== quest.id) return false;
  // Look up the wave the encounter is FROM, not just `waves[0]` —
  // mid-quest a Q2 encounter could be at wave 2 or 3.
  let wave;
  try {
    wave = getQuestWave(quest, encounter.waveNumber);
  } catch {
    return false;
  }
  // Expected enemy count: hand-authored knows it from the JSON;
  // spawn-deck spawns are always 1 boss + 7 minions per the
  // SpawnCard invariants (enforced by spawnCards.test.ts).
  let drawnLieutenants = 0;
  if (wave.spawn.kind === "spawn-deck" && typeof encounter.spawnCardDrawn === "number") {
    try { drawnLieutenants = getSpawnCard(encounter.spawnCardDrawn).lieutenants?.length ?? 0; } catch { return false; }
  }
  const expectedEnemyCount =
    (wave.spawn.kind === "hand-authored"
      ? 1 + wave.spawn.minions.length
      : 1 + 7 + drawnLieutenants) + (bossPartCardFor(wave.bossEnemyId) ? 1 : 0)
    + encounter.enemies.filter((e) => e.instanceId.startsWith(DAHLIA_LIEUTENANT_PREFIX)).length;
  if (encounter.enemies.length !== expectedEnemyCount) return false;
  // Spawn-deck encounters MUST carry their drawn card number so a
  // refresh can re-render the picker / topbar without re-drawing.
  // Hand-authored encounters MUST have it null — anything else is
  // schema drift worth rebuilding through.
  if (wave.spawn.kind === "spawn-deck") {
    if (typeof encounter.spawnCardDrawn !== "number") return false;
    // The drawn card must still resolve in the catalog (defends
    // against a `data/spawnCards.json` edit that retired a number).
    try { getSpawnCard(encounter.spawnCardDrawn); } catch { return false; }
  } else {
    if (encounter.spawnCardDrawn != null) return false;
  }
  // Every hero must have a position, a turnState entry, and a preparedToRun
  // entry. Old saves predating these fields will be rebuilt cleanly.
  if (!encounter.turnState || !encounter.preparedToRun) return false;
  for (const heroId of heroIds) {
    if (!encounter.delverPositions[heroId]) return false;
    if (!encounter.turnState[heroId]) return false;
    if (encounter.preparedToRun[heroId] === undefined) return false;
  }
  for (const e of encounter.enemies) {
    try { getEnemy(e.cardId); } catch { return false; }
  }
  // Phase-machine fields (DESIGN.md §4 / state.ts EncounterPhase) are
  // required from schema v14 onward. Defensive: any missing field
  // forces a rebuild rather than risk an inconsistent in-progress
  // wave (which would silently fall through phase checks).
  if (typeof encounter.phase !== "string") return false;
  if (typeof encounter.partingShotCursor !== "number") return false;
  // Level-up deck/draw fields (added with the level-up flow). Old
  // encounters without these get rebuilt rather than risk an
  // undefined-property crash inside `applyPendingLevelUps`.
  if (!Array.isArray(encounter.levelUpDeck)) return false;
  if (!Array.isArray(encounter.levelUpDiscard)) return false;
  if (!Array.isArray(encounter.pendingLevelUpDraws)) return false;
  // Memory Fragment tile-token list. Old encounters predating the
  // field get rebuilt rather than risk the renderer crashing on a
  // `.map` of undefined. The values themselves are derived from
  // the drawn spawn card at build time — `isConsistent` doesn't
  // need to re-validate the positions against the card here
  // because any drift would have already been caught by the
  // `spawnCardDrawn`-resolves check above.
  if (!Array.isArray(encounter.memoryFragments)) return false;
  return true;
}


/**
 * "Draw the top card from the Scenario Deck" (Ch3+ quests). Cards the
 * story placed on top (`state.scenarioDeckTop`) come first; otherwise the
 * deck runs in printed order — the lowest-numbered printed card (#01-#99)
 * that hasn't been resolved yet. Returns null when the deck is exhausted.
 */
export function drawScenarioCard(state: CampaignState): number | null {
  const top = state.scenarioDeckTop.shift();
  if (top !== undefined) {
    logEvent("engine.drawScenarioCard", { source: "deck-top", cardNumber: top });
    return top;
  }
  const next = SCENARIO_CARDS
    .map((c) => c.number)
    .filter((n) => n < 100 && !state.scenarioCardsResolved.includes(n))
    .sort((a, b) => a - b)[0];
  logEvent("engine.drawScenarioCard", { source: "deck", cardNumber: next ?? null });
  return next ?? null;
}
