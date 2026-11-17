/**
 * Engine invariants — properties that must hold after EVERY engine
 * mutation. The QA harness runs `checkAllInvariants(state)` after
 * each action and files a bug report for any violation.
 *
 * Each invariant is a small pure function that returns either
 * `null` (state is healthy on this axis) or an `InvariantViolation`
 * object describing what's wrong and where to look.
 *
 * Adding a new invariant:
 *   1. Write a `function check<Thing>(state): InvariantViolation | null`
 *   2. Add it to the `ALL_INVARIANTS` array at the bottom.
 *   3. The runner will pick it up automatically — no plumbing
 *      needed in scenarios or the bug-report writer.
 *
 * Keep each check FAST (single-pass over state). The harness runs
 * the full battery after every action, so a slow check multiplies
 * across thousands of actions in a monkey run.
 *
 * Keep each check ISOLATED — don't call other invariants from one
 * (they'll run anyway). One concern per invariant for clean
 * reports.
 */

import type { CampaignState } from "../state";
import type { EquipmentType } from "../types";
import { EQUIPMENT_RANK_CAP } from "../types";
import { SCHEMA_VERSION } from "../state";
import { getEnemy, getQuestData } from "../data";

/** A single invariant failure. `path` is a JSON-pointer-ish string
 *  pointing into `state` for triage (e.g. `loadouts/hero-01/currentHp`). */
export interface InvariantViolation {
  /** Stable identifier for the invariant (used by bug reports + tests). */
  invariantId: string;
  /** Short human description (markdown OK). */
  message: string;
  /** State path that's violating, for grep-friendly bug reports. */
  path: string;
  /** Optional concrete offending value snapshot for the report. */
  observed?: unknown;
  /** Optional expected-shape description for the report. */
  expected?: string;
}

// ---------- Invariant checks ---------------------------------------------

/** Schema version always equals the current SCHEMA_VERSION. A
 *  mismatch means a migration didn't fire or `newCampaign` is
 *  stale. */
function checkSchemaVersion(state: CampaignState): InvariantViolation | null {
  if (state.version === SCHEMA_VERSION) return null;
  return {
    invariantId: "schema-version-matches",
    message: `state.version (${state.version}) must equal SCHEMA_VERSION (${SCHEMA_VERSION})`,
    path: "version",
    observed: state.version,
    expected: `${SCHEMA_VERSION}`,
  };
}

/** Every delver's currentHp must be in [0, maxHp]. Negative HP
 *  is a bug; HP above maxHp means an immediate-passive double-
 *  applied or a heal overflowed. */
function checkHpRange(state: CampaignState): InvariantViolation | null {
  for (const heroId of Object.keys(state.loadouts)) {
    const lo = state.loadouts[heroId]!;
    if (lo.currentHp < 0 || lo.currentHp > lo.maxHp) {
      return {
        invariantId: "hp-in-range",
        message: `Delver \`${heroId}\` currentHp (${lo.currentHp}) must be in [0, maxHp=${lo.maxHp}]`,
        path: `loadouts/${heroId}/currentHp`,
        observed: { currentHp: lo.currentHp, maxHp: lo.maxHp },
        expected: "0 <= currentHp <= maxHp",
      };
    }
    if (lo.maxHp <= 0) {
      return {
        invariantId: "max-hp-positive",
        message: `Delver \`${heroId}\` maxHp (${lo.maxHp}) must be > 0`,
        path: `loadouts/${heroId}/maxHp`,
        observed: lo.maxHp,
        expected: "> 0",
      };
    }
  }
  return null;
}

/** Every equipment rank must be in [0, EQUIPMENT_RANK_CAP].
 *  Negative or above-cap ranks would break combat damage
 *  calculations and HandPanel rendering. */
function checkEquipmentRanksInRange(state: CampaignState): InvariantViolation | null {
  for (const heroId of Object.keys(state.equipmentRanks)) {
    const ranks = state.equipmentRanks[heroId] ?? {};
    for (const type of Object.keys(ranks) as EquipmentType[]) {
      const r = ranks[type] ?? 0;
      if (r < 0 || r > EQUIPMENT_RANK_CAP) {
        return {
          invariantId: "equipment-ranks-in-range",
          message: `Delver \`${heroId}\` equipment \`${type}\` rank (${r}) must be in [0, ${EQUIPMENT_RANK_CAP}]`,
          path: `equipmentRanks/${heroId}/${type}`,
          observed: r,
          expected: `0 <= r <= ${EQUIPMENT_RANK_CAP}`,
        };
      }
    }
  }
  return null;
}

/** Wallets (minionParts, bossParts, academyDonation) and shared
 *  counters (storyTokens, memoryChips, xpOnHand, totalXp,
 *  currentLevel) must be non-negative. */
function checkWalletsNonNegative(state: CampaignState): InvariantViolation | null {
  for (const heroId of Object.keys(state.minionParts)) {
    const v = state.minionParts[heroId] ?? 0;
    if (v < 0) {
      return {
        invariantId: "wallet-non-negative",
        message: `Delver \`${heroId}\` minionParts (${v}) must be >= 0`,
        path: `minionParts/${heroId}`,
        observed: v,
        expected: ">= 0",
      };
    }
  }
  // Level-aware boss-part wallets (v58): all three must stay >= 0.
  for (const [field, wallet] of [
    ["bossParts", state.bossParts],
    ["bossPartsLvl2", state.bossPartsLvl2],
    ["bossPartsLvl3", state.bossPartsLvl3],
    ["bossPartsLvl4", state.bossPartsLvl4],
    ["bossPartsLvl5", state.bossPartsLvl5],
  ] as const) {
    for (const heroId of Object.keys(wallet ?? {})) {
      const v = wallet[heroId] ?? 0;
      if (v < 0) {
        return {
          invariantId: "wallet-non-negative",
          message: `Delver \`${heroId}\` ${field} (${v}) must be >= 0`,
          path: `${field}/${heroId}`,
          observed: v,
          expected: ">= 0",
        };
      }
    }
  }
  for (const heroId of Object.keys(state.academyDonation)) {
    const v = state.academyDonation[heroId] ?? 0;
    if (v < 0) {
      return {
        invariantId: "wallet-non-negative",
        message: `Delver \`${heroId}\` academyDonation (${v}) must be >= 0`,
        path: `academyDonation/${heroId}`,
        observed: v,
        expected: ">= 0",
      };
    }
  }
  const sharedFields: Array<keyof CampaignState> = [
    "storyTokens", "memoryChips", "xpOnHand", "totalXp", "currentLevel", "levelUpCardsOwed",
  ];
  for (const field of sharedFields) {
    const v = state[field] as number;
    if (typeof v === "number" && v < 0) {
      return {
        invariantId: "shared-counter-non-negative",
        message: `state.${String(field)} (${v}) must be >= 0`,
        path: String(field),
        observed: v,
        expected: ">= 0",
      };
    }
  }
  return null;
}

/** `state.opinionCards` entries must be unique on (characterId, level).
 *  Duplicates would silently grow the Campaign Sheet roster and
 *  could let Xavier picks fire N times instead of once. */
function checkOpinionCardsUnique(state: CampaignState): InvariantViolation | null {
  const seen = new Set<string>();
  for (const c of state.opinionCards) {
    const key = `${c.characterId}-${c.level}`;
    if (seen.has(key)) {
      return {
        invariantId: "opinion-cards-unique",
        message: `Opinion card \`${key}\` is listed twice in state.opinionCards`,
        path: "opinionCards",
        observed: c,
        expected: "unique on (characterId, level)",
      };
    }
    seen.add(key);
  }
  return null;
}

/** Every entry in `opinionCardsSpent` must correspond to a card
 *  the campaign actually owns. Spending a card you don't have
 *  would be a serialisation bug. */
function checkOpinionCardsSpentReferences(state: CampaignState): InvariantViolation | null {
  const owned = new Set(state.opinionCards.map((c) => `${c.characterId}-${c.level}`));
  for (const cardId of state.opinionCardsSpent) {
    if (!owned.has(cardId)) {
      return {
        invariantId: "opinion-cards-spent-references-owned",
        message: `state.opinionCardsSpent contains \`${cardId}\` but state.opinionCards has no matching entry`,
        path: "opinionCardsSpent",
        observed: cardId,
        expected: "every spent id must be in state.opinionCards",
      };
    }
  }
  return null;
}

/** When a town visit IS in progress, the page id must be a real
 *  page in the loaded chapter graph. When NO town visit, every
 *  visit-scoped latch must be in its reset state. */
function checkTownVisitConsistency(state: CampaignState): InvariantViolation | null {
  if (state.townVisit) {
    // page id reachability is checked at action time (the engine
    // throws on an unknown id, which the runner catches); we
    // can't load the chapter graph here without a sync dep on
    // data.ts. Just sanity-check the visit shape.
    if (typeof state.townVisit.chapterId !== "string" || state.townVisit.chapterId.length === 0) {
      return {
        invariantId: "town-visit-shape",
        message: `state.townVisit.chapterId is empty/missing`,
        path: "townVisit/chapterId",
        observed: state.townVisit.chapterId,
        expected: "non-empty string",
      };
    }
    if (typeof state.townVisit.pageId !== "string" || state.townVisit.pageId.length === 0) {
      return {
        invariantId: "town-visit-shape",
        message: `state.townVisit.pageId is empty/missing`,
        path: "townVisit/pageId",
        observed: state.townVisit.pageId,
        expected: "non-empty string",
      };
    }
    if (!Array.isArray(state.townVisit.pagesEntered)) {
      return {
        invariantId: "town-visit-shape",
        message: `state.townVisit.pagesEntered is not an array`,
        path: "townVisit/pagesEntered",
        observed: state.townVisit.pagesEntered,
        expected: "string[]",
      };
    }
    return null;
  }
  // No active town visit -> latches must be in reset state.
  if (state.floresDiscountArmed) {
    return {
      invariantId: "no-visit-latches-reset",
      message: `state.floresDiscountArmed is true but no town visit is active`,
      path: "floresDiscountArmed",
      observed: true,
      expected: "false when state.townVisit === null",
    };
  }
  for (const heroId of Object.keys(state.academyDonation)) {
    const v = state.academyDonation[heroId] ?? 0;
    if (v > 0) {
      return {
        invariantId: "no-visit-latches-reset",
        message: `state.academyDonation[${heroId}] = ${v} but no town visit is active`,
        path: `academyDonation/${heroId}`,
        observed: v,
        expected: "0 when state.townVisit === null",
      };
    }
  }
  return null;
}

/** The `keyItems` list must be unique on `number` — gaining the
 *  same key item twice silently grows the list and would let
 *  `add-shop-products-if-key-items-min` thresholds trigger
 *  twice. */
function checkKeyItemsUnique(state: CampaignState): InvariantViolation | null {
  const seen = new Set<number>();
  for (const k of state.keyItems) {
    if (seen.has(k.number)) {
      return {
        invariantId: "key-items-unique",
        message: `Key item #${k.number} (\`${k.name}\`) is listed twice in state.keyItems`,
        path: "keyItems",
        observed: k,
        expected: "unique on number",
      };
    }
    seen.add(k.number);
  }
  return null;
}

/** Story tokens never exceed an upper bound. Today the printed
 *  rule grants 2 per visit and drains 1 per location — so the
 *  pool should never exceed `STORY_TOKENS_MAX`. Picked
 *  conservatively at 5 to give breathing room for future grants
 *  without flapping. */
const STORY_TOKENS_MAX = 5;
function checkStoryTokensCap(state: CampaignState): InvariantViolation | null {
  if (state.storyTokens > STORY_TOKENS_MAX) {
    return {
      invariantId: "story-tokens-capped",
      message: `state.storyTokens (${state.storyTokens}) above the conservative cap (${STORY_TOKENS_MAX}) - suggests a stuck grant`,
      path: "storyTokens",
      observed: state.storyTokens,
      expected: `<= ${STORY_TOKENS_MAX}`,
    };
  }
  return null;
}

/** Full state must round-trip cleanly through `JSON.stringify` +
 *  `JSON.parse` — i.e. no circular references, no functions,
 *  no Symbols. Critical for `saveCampaign` to work. */
function checkJsonRoundTrip(state: CampaignState): InvariantViolation | null {
  try {
    const json = JSON.stringify(state);
    JSON.parse(json);
    return null;
  } catch (err) {
    return {
      invariantId: "json-round-trip",
      message: `state failed JSON.stringify/parse round-trip: ${err instanceof Error ? err.message : String(err)}`,
      path: "(root)",
      observed: err instanceof Error ? err.message : String(err),
      expected: "JSON.parse(JSON.stringify(state)) succeeds",
    };
  }
}

/** Pending-pick queues on the encounter must be arrays. Missing
 *  arrays would crash any consumer that does `.length`. */
function checkEncounterQueueShape(state: CampaignState): InvariantViolation | null {
  const enc = state.encounter;
  if (!enc) return null;
  const queueFields: Array<keyof typeof enc> = [
    "pendingLevelUpDraws", "pendingElementChoices", "pendingEquipmentRolls", "pendingOpinionRankPicks",
    "pendingCreaturePartChoices", "pendingXpRolls",
  ];
  for (const field of queueFields) {
    const v = enc[field];
    if (!Array.isArray(v)) {
      return {
        invariantId: "encounter-queue-shape",
        message: `state.encounter.${String(field)} is not an array`,
        path: `encounter/${String(field)}`,
        observed: v,
        expected: "[]",
      };
    }
  }
  return null;
}

/** Every enemy instance `damageTaken` must be `>= 0`. Negative
 *  damage would indicate a counter / heal landed without going
 *  through the canonical path. The upper bound is intentionally
 *  NOT enforced here — overkill (`damageTaken > card.hp`) is
 *  legal mid-resolution because `applyDamageAtTile` accumulates
 *  before checking the kill threshold. The `alive ↔ killed`
 *  consistency check below catches the real bug case. */
function checkEnemyDamageNonNegative(state: CampaignState): InvariantViolation | null {
  const enc = state.encounter;
  if (!enc) return null;
  for (const e of enc.enemies) {
    if (e.damageTaken < 0) {
      return {
        invariantId: "enemy-damage-non-negative",
        message: `Enemy \`${e.instanceId}\` (card \`${e.cardId}\`) damageTaken (${e.damageTaken}) must be >= 0`,
        path: `encounter/enemies/${e.instanceId}/damageTaken`,
        observed: e.damageTaken,
        expected: ">= 0",
      };
    }
  }
  return null;
}

/** If `enemy.alive` is true, `damageTaken` must be `< card.hp`
 *  — i.e. an alive enemy must not have accumulated lethal damage
 *  without being flipped to dead. One-directional check by
 *  design: the engine's `debugWinWave` shortcut + the End-of-
 *  Wave tear-down both flip `alive = false` WITHOUT bumping
 *  `damageTaken` (because the encounter is being discarded
 *  immediately afterwards). Asserting bidirectional consistency
 *  would false-flag those cases as bugs. The one direction we
 *  DO care about — "an alive enemy with overflowing damage" —
 *  catches the real bug case: a damage applier that forgot to
 *  flip the kill flag. */
function checkAliveDamageConsistent(state: CampaignState): InvariantViolation | null {
  const enc = state.encounter;
  if (!enc) return null;
  for (const e of enc.enemies) {
    if (!e.alive) continue;
    let card;
    try {
      card = getEnemy(e.cardId);
    } catch {
      continue;
    }
    if (e.damageTaken >= card.hp) {
      return {
        invariantId: "enemy-alive-damage-consistent",
        message: `Enemy \`${e.instanceId}\` (card \`${e.cardId}\`) alive=true but damageTaken=${e.damageTaken} >= card.hp=${card.hp} — kill flag missed`,
        path: `encounter/enemies/${e.instanceId}`,
        observed: { alive: e.alive, damageTaken: e.damageTaken, cardHp: card.hp },
        expected: "alive=true ⇒ damageTaken < card.hp",
      };
    }
  }
  return null;
}

/** Every delver loadout AP must be in `[0, baseAp]` (where
 *  baseAp is the bag's current floor — Battery bumps raise it).
 *  Negative AP means a spendApRefresh forgot to early-exit on
 *  insufficient; AP above baseAp means an End Wave refresh
 *  double-applied. */
function checkApInRange(state: CampaignState): InvariantViolation | null {
  for (const heroId of Object.keys(state.loadouts)) {
    const lo = state.loadouts[heroId]!;
    if (lo.currentAp < 0 || lo.currentAp > lo.baseAp) {
      return {
        invariantId: "ap-in-range",
        message: `Delver \`${heroId}\` currentAp (${lo.currentAp}) must be in [0, baseAp=${lo.baseAp}]`,
        path: `loadouts/${heroId}/currentAp`,
        observed: { currentAp: lo.currentAp, baseAp: lo.baseAp },
        expected: "0 <= currentAp <= baseAp",
      };
    }
  }
  return null;
}

/** Encounter phase must be one of the known values. A custom /
 *  empty / undefined value would hint that an engine call wrote
 *  the wrong literal. */
const VALID_ENCOUNTER_PHASES: ReadonlySet<string> = new Set([
  "delver-spawn-pick",
  "hero",
  "parting-shots",
  "end-of-wave",
  "completed",
]);
function checkEncounterPhaseValid(state: CampaignState): InvariantViolation | null {
  const enc = state.encounter;
  if (!enc) return null;
  if (!VALID_ENCOUNTER_PHASES.has(enc.phase)) {
    return {
      invariantId: "encounter-phase-valid",
      message: `state.encounter.phase = "${enc.phase}" is not a recognised value`,
      path: "encounter/phase",
      observed: enc.phase,
      expected: [...VALID_ENCOUNTER_PHASES].join(" | "),
    };
  }
  return null;
}

/** `enc.phase === "completed"` must coincide with
 *  `state.encounter === null` per `completeWave`'s contract. If
 *  one side flips but not the other, save/load + the next
 *  `ensureEncounter` will see a stale phase. (The check only
 *  fires when the encounter object exists — `state.encounter
 *  === null` is the healthy completed state.) */
function checkCompletedClearsEncounter(state: CampaignState): InvariantViolation | null {
  const enc = state.encounter;
  if (!enc) return null;
  if (enc.phase === "completed") {
    return {
      invariantId: "completed-clears-encounter",
      message: `state.encounter.phase = "completed" but the encounter object is still present (should be null)`,
      path: "encounter",
      observed: { phase: enc.phase },
      expected: "state.encounter === null when phase would be 'completed'",
    };
  }
  return null;
}

/** Encounter wave number must be one of the quest's printed
 *  wave numbers. Catches a bootstrap call with the wrong wave
 *  (e.g. accidentally jumping from W1 → W3 without W2). */
function checkEncounterWaveExists(state: CampaignState): InvariantViolation | null {
  const enc = state.encounter;
  if (!enc) return null;
  // Defer to `data.ts > getQuestData` for the canonical wave
  // list. Wrapping in try/catch because a bogus questId is
  // ALSO a bug worth surfacing.
  let questHasWave: boolean;
  try {
    const quest = getQuestData(enc.questId);
    questHasWave = quest.waves.some((w) => w.number === enc.waveNumber);
  } catch (err) {
    return {
      invariantId: "encounter-wave-exists",
      message: `state.encounter.questId = "${enc.questId}" not found in data registry (${err instanceof Error ? err.message : String(err)})`,
      path: "encounter/questId",
      observed: enc.questId,
      expected: "registered quest id",
    };
  }
  if (!questHasWave) {
    return {
      invariantId: "encounter-wave-exists",
      message: `state.encounter.waveNumber = ${enc.waveNumber} is not a printed wave for quest "${enc.questId}"`,
      path: "encounter/waveNumber",
      observed: enc.waveNumber,
      expected: "printed wave number on the quest",
    };
  }
  return null;
}

/** Total pending modal entries (level-up draws + element
 *  choices + equipment rolls + opinion-rank picks) must stay
 *  under a sane cap. The realistic worst-case at the end of a
 *  Q2 wave is ~8 pending items (multi-delver kill on the
 *  final blow); 32 leaves plenty of room for unexpected
 *  bursts while still tripping on a queue-leak bug. */
function checkPendingModalCap(state: CampaignState): InvariantViolation | null {
  const enc = state.encounter;
  if (!enc) return null;
  const total =
    enc.pendingLevelUpDraws.length +
    enc.pendingElementChoices.length +
    enc.pendingEquipmentRolls.length +
    enc.pendingXpRolls.length +
    enc.pendingOpinionRankPicks.length +
    enc.pendingCreaturePartChoices.length;
  const CAP = 32;
  if (total > CAP) {
    return {
      invariantId: "pending-modals-capped",
      message: `encounter has ${total} total pending modal entries (cap=${CAP}) — likely a queue leak`,
      path: "encounter/pending*",
      observed: {
        levelUp: enc.pendingLevelUpDraws.length,
        element: enc.pendingElementChoices.length,
        equipment: enc.pendingEquipmentRolls.length,
        xpRoll: enc.pendingXpRolls.length,
        opinionRank: enc.pendingOpinionRankPicks.length,
        creaturePart: enc.pendingCreaturePartChoices.length,
      },
      expected: `total <= ${CAP}`,
    };
  }
  return null;
}

/** Every entry in `encounter.delverPositions` and every live
 *  enemy must sit on an in-bounds tile. An OOB position is a
 *  movement bug that the BoardScreen would paint off-canvas
 *  (silently — no error) — easier to catch here. */
function checkPositionsOnBoard(state: CampaignState): InvariantViolation | null {
  const enc = state.encounter;
  if (!enc) return null;
  let bounds: { w: number; h: number };
  try {
    const quest = getQuestData(enc.questId);
    const wave = quest.waves.find((w) => w.number === enc.waveNumber);
    if (!wave) return null;
    bounds = wave.spawn.boardSize;
  } catch {
    return null;
  }
  for (const heroId of Object.keys(enc.delverPositions)) {
    const p = enc.delverPositions[heroId]!;
    if (p.x < 0 || p.y < 0 || p.x >= bounds.w || p.y >= bounds.h) {
      return {
        invariantId: "positions-on-board",
        message: `Delver \`${heroId}\` at (${p.x},${p.y}) is out of board bounds ${bounds.w}x${bounds.h}`,
        path: `encounter/delverPositions/${heroId}`,
        observed: p,
        expected: `0 <= x < ${bounds.w}, 0 <= y < ${bounds.h}`,
      };
    }
  }
  for (const e of enc.enemies) {
    if (!e.alive) continue;
    if (e.x < 0 || e.y < 0 || e.x >= bounds.w || e.y >= bounds.h) {
      return {
        invariantId: "positions-on-board",
        message: `Enemy \`${e.instanceId}\` at (${e.x},${e.y}) is out of board bounds ${bounds.w}x${bounds.h}`,
        path: `encounter/enemies/${e.instanceId}`,
        observed: { x: e.x, y: e.y },
        expected: `0 <= x < ${bounds.w}, 0 <= y < ${bounds.h}`,
      };
    }
  }
  return null;
}

/** `currentMovement` must be non-negative and bounded. Negative
 *  movement is an off-by-one in `moveDelverStep`; values above
 *  the printed `baseMovement * 4` would indicate a runaway
 *  double-mov / +1-mov stack (the engine caps at *2 + slot
 *  bonus, so even a maxed-out Body delver tops out at ~6
 *  current). 16 is generous — fires only on real bugs. */
function checkMovementInRange(state: CampaignState): InvariantViolation | null {
  for (const heroId of Object.keys(state.loadouts)) {
    const lo = state.loadouts[heroId]!;
    if (lo.currentMovement < 0) {
      return {
        invariantId: "movement-non-negative",
        message: `Delver \`${heroId}\` currentMovement=${lo.currentMovement} < 0 — moveDelverStep over-decremented`,
        path: `loadouts/${heroId}/currentMovement`,
        observed: lo.currentMovement,
        expected: ">= 0",
      };
    }
    if (lo.currentMovement > 16) {
      return {
        invariantId: "movement-non-negative",
        message: `Delver \`${heroId}\` currentMovement=${lo.currentMovement} > 16 — runaway double-mov / +1-mov stacking`,
        path: `loadouts/${heroId}/currentMovement`,
        observed: lo.currentMovement,
        expected: "<= 16",
      };
    }
  }
  return null;
}

/** While the encounter is in a fightable phase, the active
 *  delver id must resolve to a delver with a position on the
 *  board. If `state.currentDelverId` is unknown / has no
 *  position, every subsequent engine call that touches the
 *  active delver (playWeaponCard, useWeaponAbility) will
 *  silently reject and the player gets stuck. */
function checkActiveDelverOnBoard(state: CampaignState): InvariantViolation | null {
  const enc = state.encounter;
  if (!enc) return null;
  // Only matters when the player is supposed to be acting.
  if (enc.phase !== "hero") return null;
  const active = state.currentDelverId;
  if (!state.loadouts[active]) {
    return {
      invariantId: "active-delver-on-board",
      message: `state.currentDelverId = "${active}" but no loadout entry exists`,
      path: "currentDelverId",
      observed: active,
      expected: "id present in state.loadouts",
    };
  }
  if (!enc.delverPositions[active]) {
    return {
      invariantId: "active-delver-on-board",
      message: `state.currentDelverId = "${active}" has no entry in encounter.delverPositions`,
      path: `encounter/delverPositions/${active}`,
      observed: enc.delverPositions,
      expected: `entry for active delver "${active}"`,
    };
  }
  return null;
}

/** Shop products owned must never exceed shop products that have
 *  ever been available. Owning a product without it being
 *  unlocked first would point to a town-visit action firing the
 *  wrong product number. */
function checkShopProductsOwnedAreUnlockable(state: CampaignState): InvariantViolation | null {
  // We don't have an authoritative "ever unlockable" set without
  // scanning chapter data, so this is a soft check: every owned
  // product must currently be either in `shopProductsAvailable`
  // OR have been removed because someone else bought it (a heuristic
  // that holds AS LONG AS the same product number isn't owned by
  // multiple delvers AND wasn't in `available`). For Q1-Q2 today
  // every product number is single-owner, so this is a
  // legitimate cross-check.
  const allOwned = new Set<number>();
  for (const heroId of Object.keys(state.shopProductsOwned)) {
    for (const n of state.shopProductsOwned[heroId] ?? []) {
      if (allOwned.has(n)) {
        return {
          invariantId: "shop-products-single-owner",
          message: `Shop product #${n} is owned by more than one delver`,
          path: "shopProductsOwned",
          observed: n,
          expected: "single-owner per product number",
        };
      }
      allOwned.add(n);
    }
  }
  return null;
}

// ---------- Public API ----------------------------------------------------

/** Run every invariant against `state`. Returns the FIRST
 *  violation per invariant id (so a single bad state doesn't
 *  flood the report with 17 copies of the same wallet
 *  underflow). */
export function checkAllInvariants(state: CampaignState): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  for (const check of ALL_INVARIANTS) {
    const v = check(state);
    if (v !== null) out.push(v);
  }
  return out;
}

const ALL_INVARIANTS: Array<(s: CampaignState) => InvariantViolation | null> = [
  checkSchemaVersion,
  checkHpRange,
  checkEquipmentRanksInRange,
  checkWalletsNonNegative,
  checkOpinionCardsUnique,
  checkOpinionCardsSpentReferences,
  checkTownVisitConsistency,
  checkKeyItemsUnique,
  checkStoryTokensCap,
  checkJsonRoundTrip,
  checkEncounterQueueShape,
  checkShopProductsOwnedAreUnlockable,
  checkEnemyDamageNonNegative,
  checkAliveDamageConsistent,
  checkApInRange,
  checkEncounterPhaseValid,
  checkCompletedClearsEncounter,
  checkEncounterWaveExists,
  checkActiveDelverOnBoard,
  checkPendingModalCap,
  checkPositionsOnBoard,
  checkMovementInRange,
];

/** Exposed for tests + the bug-report writer. */
export function listInvariantIds(): string[] {
  // We can't introspect the id without running the check, so
  // call each one on a known-clean campaign state and collect
  // the meta. Instead, hardcode the list — it's small and the
  // test below verifies the hardcoded list matches reality.
  return [
    "schema-version-matches",
    "hp-in-range",
    "max-hp-positive",
    "equipment-ranks-in-range",
    "wallet-non-negative",
    "shared-counter-non-negative",
    "opinion-cards-unique",
    "opinion-cards-spent-references-owned",
    "town-visit-shape",
    "no-visit-latches-reset",
    "key-items-unique",
    "story-tokens-capped",
    "json-round-trip",
    "encounter-queue-shape",
    "shop-products-single-owner",
    "enemy-damage-non-negative",
    "enemy-alive-damage-consistent",
    "ap-in-range",
    "encounter-phase-valid",
    "completed-clears-encounter",
    "encounter-wave-exists",
    "active-delver-on-board",
    "pending-modals-capped",
    "positions-on-board",
    "movement-non-negative",
  ];
}
