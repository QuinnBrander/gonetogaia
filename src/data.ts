/** * Data loader. * * All gameplay data lives in `data/*.json`. We import the JSON modules at * build time (Vite handles `?json` natively for `.json` extensions thanks to * `resolveJsonModule` in tsconfig.json) and re-export them with the proper * TypeScript types, plus small lookup helpers. * * If the JSON shape ever drifts from src/types.ts the cast on import will be * the first place an error surfaces; that's intentional. */
import type { HeroCard, EquipmentCard, EnemyCard, Quest, Element, DelverBoardOverlay, Suit, EquipmentType, LevelUpDeckCard, TownVisitChapter, ShopProduct, SpawnCard, } from "./types";
import type { CampaignState, ConsumableTokenKind } from "./state";
import heroesJson from "../data/heroes.json";
import equipmentJson from "../data/equipment.json";
import enemiesJson from "../data/enemies.json";
import quest1Json from "../data/quest1.json";
import quest2Json from "../data/quest2.json";
import quest3Json from "../data/quest3.json";
import quest5Json from "../data/quest5.json";
import quest6Json from "../data/quest6.json";
import questAssaultJson from "../data/questAssault.json";
import quest4Json from "../data/quest4.json";
import quest7Json from "../data/quest7.json";
import quest13Json from "../data/quest13.json";
import elementsJson from "../data/elements.json";
import delverBoardsJson from "../data/delverBoards.json";
import levelDeckJson from "../data/levelDeck.json";
import chapter1Json from "../data/chapter1.json";
import chapter2Json from "../data/chapter2.json";
import chapter3Json from "../data/chapter3.json";
import chapter4Json from "../data/chapter4.json";
import shopProductsJson from "../data/shopProducts.json";
import spawnCardsJson from "../data/spawnCards.json";
import equipmentUpgradesJson from "../data/equipmentUpgrades.json";
export const HEROES = heroesJson as readonly HeroCard[];
export const EQUIPMENT = equipmentJson as readonly EquipmentCard[];

/**
 * Equipment Upgrade deck (Machinist purchases — printed cards
 * #141-155, scans in `public/equipment-upgrades/`). Three families
 * of five ranks that REPLACE a standard equipment family for the
 * quest: Shock Gauntlet (#141-145 → Gauntlet), Cyclone Boots
 * (#146-150 → Boots), Earth's Embrace Shield (#151-155 → Shield).
 *
 * The printed cards are suit-agnostic; the loader expands each JSON
 * entry into one `EquipmentCard` PER SUIT (id prefix `mind-` /
 * `body-`) so every suit-keyed lookup works unchanged. They are
 * deliberately NOT merged into `EQUIPMENT` — that would collide
 * with the standard cards in the `(suit, type, rank)` key space.
 * Resolution goes through `state.ts > getEquipmentCardFor`, which
 * consults `state.equipmentVariants` first.
 */
type UpgradeJsonEntry = Omit<EquipmentCard, "suit"> & { family: string };
export const UPGRADE_EQUIPMENT: readonly (EquipmentCard & { family: string })[] =
  (equipmentUpgradesJson as UpgradeJsonEntry[]).flatMap((entry) =>
    (["mind", "body"] as const).map((suit) => ({
      ...entry,
      suit,
      id: `${suit}-${entry.id}`,
    })),
  );

/** Machinist shop product number → upgrade family id. */
const UPGRADE_FAMILY_BY_PRODUCT: ReadonlyMap<number, string> = new Map([
  [41, "shock-gauntlet"],
  [34, "cyclone-boots"],
  [32, "earths-embrace-shield"],
  [33, "living-armor"],
  [35, "ion-battery"],
  [36, "new-harvester"],
  [37, "ancient-os"],
  [38, "overcharger"],
  [39, "engulfing-beam"],
  [40, "precise-shockwave"],
  [42, "fabled-hammer"],
  [43, "sword-of-ruin"],
  [44, "war-mace"],
  [45, "lunar-trident"],
]);
export function upgradeFamilyForProduct(productNumber: number): string | null {
  return UPGRADE_FAMILY_BY_PRODUCT.get(productNumber) ?? null;
}

/** Rank-correct card of an upgrade family for one suit, or null if
 *  the family / rank has no entry (defensive — data gap). */
export function getUpgradeEquipment(
  family: string,
  suit: Suit,
  rank: number,
): EquipmentCard | null {
  return UPGRADE_EQUIPMENT.find(
    (e) => e.family === family && e.suit === suit && e.rank === rank,
  ) ?? null;
}
export const ENEMIES = enemiesJson as readonly EnemyCard[];
export const QUEST1 = quest1Json as Quest;
/** * Quest #2 — "The Surveillance Device" (rulebook p15-21). * * Three waves of escalating difficulty, plus a Retreat/Continue * branch after Wave 1 when a delver falls. Wave 1 ships with * fully transcribed Venena + Goldmonger enemy data and uses the * base Spawn Deck (rulebook p21). Waves 2 + 3 are JSON stubs: * their `bossEnemyId` / `minionEnemyIds` carry `TBD-` prefixes * so any attempt to spawn them throws a "card not found" in * `getEnemy` rather than silently building a broken encounter — * intentional fail-loud guard until Phase B/C wire those waves' * enemy data (Ophidians + Hundredeyes for W2, Sporeclouds + * Death Cap for W3). */
export const QUEST2 = quest2Json as Quest;
/** * All quests in story order. New quests append to this list. * Distinct from the `QUESTS` (`QuestMeta[]`) collection further * down — that one holds poker-card metadata used by the town- * visit reward popup; `QUEST_DATA` here is the full encounter + * narrative data used by the engine. */
export const QUEST3 = quest3Json as Quest;
export const QUEST5 = quest5Json as Quest;
export const QUEST6 = quest6Json as Quest;
/** Ch4 Town Square story quest (one wave), launched from the Ch4 Town Visit. */
export const QUEST_ASSAULT = questAssaultJson as Quest;
/** "Quest #3" for numbered quests, the quest's name for story quests (Ch4 Assault). */
export function questDisplayLabel(questId: string): string {
  const m = /^quest(\d+)$/.exec(questId);
  return m ? `Quest #${m[1]}` : getQuestData(questId).name;
}
/** Chapter 4 quests (data from scripts/buildCh4Quests.py). */
export const QUEST4 = quest4Json as Quest;
export const QUEST7 = quest7Json as Quest;
export const QUEST13 = quest13Json as Quest;
export const QUEST_DATA: readonly Quest[] = [QUEST1, QUEST2, QUEST3, QUEST5, QUEST6, QUEST_ASSAULT, QUEST4, QUEST7, QUEST13];
/** * Look up a Quest by its `id` (e.g. "quest1", "quest2"). Throws * on an unknown id — routers should never hit this with a stale * id and the thrown error keeps typos obvious in the session log. */
export function getQuestData(id: string): Quest { for (const q of QUEST_DATA) {
    if (q.id === id)
        return q;
} throw new Error(`getQuestData: unknown quest id "${id}"`); }
/** * Look up a wave on a quest by its 1-based number. Throws if * the quest doesn't carry that wave — mirrors `getEnemy` / * `getHero` / `getSpawnCard` for a uniform "look up by id" * surface. */
export function getQuestWave(quest: Quest, waveNumber: number): import("./types").QuestWave { for (const w of quest.waves) {
    if (w.number === waveNumber)
        return w;
} throw new Error(`getQuestWave: quest "${quest.id}" has no wave ${waveNumber} ` + `(waves: ${quest.waves.map((w) => w.number).join(", ")})`); }
/** * Topbar goal label for the active wave: prints the QUEST's * printed `goal` while the player is on a wave at or before * `quest.primaryGoalWaveNumber`, then swaps to `bonusGoal` once * they push past the primary goal wave (e.g. Q2 entering Wave 3). * * Quests that omit `bonusGoal` (single-wave quests like Q1) keep * showing the primary `goal` even on the (theoretical) post- * primary path — defensive, since the primary goal text is the * only label we know is meaningful. The topbar therefore always * renders something printed-rulebook-accurate rather than the * legacy per-wave `"Reach the end of Wave N"` placeholder, which * lied to the player on Q2 Wave 1 (the quest goal is wave 2's * completion, not wave 1's). * * Used by `BoardScreen.ts` to fill the `.board-topbar-goal` * trailing caption. The wave-number itself is rendered separately * by the caller (e.g. "Quest #2, Wave 1") so this returns just the * objective sentence. */
export function activeQuestGoalText(quest: Quest, currentWaveNumber: number): string { if (quest.bonusGoal && currentWaveNumber > quest.primaryGoalWaveNumber) {
    return quest.bonusGoal;
} return quest.goal; }
export const ELEMENTS = elementsJson as ReadonlyArray<{
    id: Element;
    name: string;
    iconHint: string;
    image: string;
}>;
export const LEVEL_DECK = levelDeckJson as readonly LevelUpDeckCard[];
export const CHAPTER1 = chapter1Json as TownVisitChapter;
export const CHAPTER2 = chapter2Json as TownVisitChapter;
export const CHAPTER3 = chapter3Json as TownVisitChapter;
export const CHAPTER4 = chapter4Json as TownVisitChapter;
export const SHOP_PRODUCTS = shopProductsJson as readonly ShopProduct[];
/** * Base Spawn Deck — 12 of the 14 printed Spawn Cards. Drawn at * the start of (most) waves to determine enemy + delver placement * (rulebook p21 — Quest #1 is the carve-out and ships a hand- * authored layout). Numbers 13-14 are reserved for future * quest-specific cards; the catalog can grow without touching * any consumer code because everything keys off * `SpawnCard.number`. * * See `SpawnCard` jsdoc (types.ts) for the per-card invariants * enforced by `src/__tests__/spawnCards.test.ts` — 1 boss + 7 * minions + 2 delver-spawn compasses + 0/1 memory-fragment * tokens, no overlapping markers, NORTH-up always. */
export const SPAWN_CARDS = spawnCardsJson as readonly SpawnCard[];
/** Lookup a Spawn Card by its printed number. Throws if missing — *  callers should pass a number that's been validated as in the *  deck (via {@link shuffleSpawnDeck} / {@link drawSpawnCard}). */
export function getSpawnCard(number: number): SpawnCard { const c = SPAWN_CARDS.find((x) => x.number === number); if (!c)
    throw new Error(`Unknown spawn card number: ${number}`); return c; }
/** * Return a freshly shuffled list of spawn-card numbers (the "draw * pile"). Uses an injected RNG so the caller — typically the * encounter-setup engine — controls determinism (seeded RNG for * tests / replays, `Math.random` for live play). The returned * array is a fresh copy; mutating it is safe. * * The pile is the full base deck (`SPAWN_CARDS`'s numbers). When * the campaign starts adding quest-specific cards, the caller can * filter the catalog before shuffling — keep this helper * deck-agnostic. */
export function shuffleSpawnDeck(rng: () => number = Math.random): number[] {
    const pile = SPAWN_CARDS
        .filter((c) => !FRIENDLY_SPAWN_CARD_NUMBERS.includes(c.number))
        .map((c) => c.number);
    for (let i = pile.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = pile[i]!;
        pile[i] = pile[j]!;
        pile[j] = tmp;
    }
    return pile;
}
    /** * Pop the top card off a shuffled deck. Returns the resolved * {@link SpawnCard} plus the remaining pile (also a fresh copy — * the input is not mutated, so the caller can hold both before / * after states for undo, replays, or step-back UI). * * Throws if `remaining` is empty — the rulebook says to reshuffle * the discard pile back into the draw pile rather than running * out, and that reshuffle is the caller's responsibility (we * stay deck-agnostic here). */
    export function drawSpawnCard(remaining: readonly number[]): {
        card: SpawnCard;
        remaining: number[];
    } {
        if (remaining.length === 0) {
            throw new Error("drawSpawnCard: empty pile \u2014 reshuffle the discard first.");
        }
        const top = remaining[0]!;
        const rest = remaining.slice(1);
        return { card: getSpawnCard(top), remaining: rest };
    }
        /** * Printed shop-product numbers we have card art for. Mirrors the * pages extracted from `ASSETS/Gone to Gaia/Shop Cards Front v3 * PROOF 1.pdf` on 2026-05-18 — pages 1..14 are printed cards #1..14, * pages 15..17 are #32, #34, #41 (the proof skips the rest of the * range). Anything not in this set has no art file on disk and * `shopProductImageOrNull` returns `null` so callers can render a * graceful fallback instead of a 404'd `<img>`. * * This is intentionally a code-side allowlist rather than an * `image` field on `ShopProduct` in `data/shopProducts.json`: * - The image path follows a strict convention (`shop-product-NN.jpg`), *   so it's derivable from the number, not a free-form string. * - The JSON is what the rules author touches; the catalog of *   what art has shipped is a code/asset-pipeline concern that *   belongs next to the other "is this art bundled?" lookups *   (`keyItemImageOrNull` above). */
        const SHOP_PRODUCT_IMAGE_NUMBERS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 46, 47, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45,]);
        /** Best-effort image lookup for a shop product. Returns `null` for any *  number we don't have card art for; the caller should fall back to *  a text-only presentation in that case. */
        export function shopProductImageOrNull(number: number): string | null { return SHOP_PRODUCT_IMAGE_NUMBERS.has(number) ? `shop-product-${String(number).padStart(2, "0")}.jpg` : null; }
        /** * Machinist (Ch2 page 31) shop products grant 5 Equipment Upgrade * cards each — the printed shop card text reads "Find the 5 matching * Equipment cards in the Equipment Upgrade Deck. These will replace * your current X Equipment." This map is the static lookup of those * 5 card numbers per shop product. Extracted from * `ASSETS/Gone to Gaia/Equipment Card Front Upgrades v2 PROOF 1.pdf` * (15 pages, 5 per product, in the order Gauntlet -> Boots -> Shield). * The card numbers (141..155) follow the printed cards' top-right * numbers in that PDF. * * Returns `null` for shop products that don't grant equipment * upgrades — callers should fall back to the compact thumbnail * presentation in that case. */
        const EQUIPMENT_UPGRADE_CARDS_BY_SHOP_PRODUCT: ReadonlyMap<number, readonly number[]> = new Map([[41, [141, 142, 143, 144, 145]], [34, [146, 147, 148, 149, 150]], [32, [151, 152, 153, 154, 155]], [33, [156, 157, 158, 159, 160]], [35, [161, 162, 163, 164, 165]], [36, [166, 167, 168, 169, 170]], [37, [171, 172, 173, 174, 175]], [38, [176, 177, 178, 179, 180]], [39, [181, 182, 183, 184, 185]], [40, [186, 187, 188, 189, 190]], [42, [191, 192, 193, 194, 195]], [43, [196, 197, 198, 199, 200]], [44, [201, 202, 203, 204, 205]], [45, [206, 207, 208, 209, 210]],]);
        export function equipmentUpgradeCardsForShopProduct(number: number): readonly number[] | null { return EQUIPMENT_UPGRADE_CARDS_BY_SHOP_PRODUCT.get(number) ?? null; }
        /** Public path (relative to `public/`) for a printed Equipment Upgrade card. */
        export function equipmentUpgradeImage(cardNumber: number): string { return `equipment-upgrade-${cardNumber}.png`; }
        /** Lookup a Shop Product by its printed number. Throws if missing. */
        export function getShopProduct(number: number): ShopProduct { const p = SHOP_PRODUCTS.find((x) => x.number === number); if (!p)
            throw new Error(`Unknown shop product number: ${number}`); return p; }
        /** Lookup a Town Visit chapter by id. Throws if missing. */
        export function getChapter(id: TownVisitChapter["id"]): TownVisitChapter { if (id === "ch1")
            return CHAPTER1; if (id === "ch2")
            return CHAPTER2; if (id === "ch3")
            return CHAPTER3; if (id === "ch4")
            return CHAPTER4; throw new Error(`Unknown town visit chapter id: ${id}`); }
        /** * Roster of all hero cards in the campaign — superset of `HEROES` * (which is just the two PLAYABLE-instance hero rows used by board * gameplay). HERO_CARDS includes every card the campaign can unlock * via narrative beats (e.g. Chapter 1 page 6 unlocks #3 + #4 as * future picks). Tracked but not yet selectable; future quests * will read from `state.unlockedHeroCards` to gate roster choice. * * Suits alternate mind/body across the printed sequence (matches * the `Hero Card Front v3 PROOF 1.pdf` proof: odd-numbered cards are * Mind, even-numbered are Body — confirmed visually by the cyan-vs- * orange frame treatment + suit glyph in the upper-right of each card). * * Kept inline (not a JSON file) because the metadata is tiny and * the two playable rows in `heroes.json` already carry all the * board-gameplay fields (`startingEquipment`, `heroCardImage`). * HERO_CARDS is the lighter "campaign card" view — number, name, * suit, image — so the rewards modal + Campaign Sheet have one * consistent shape regardless of whether the card is playable yet. * * Images for all six cards were extracted from * `ASSETS/Gone to Gaia/Hero Card Front v3 PROOF 1.pdf` (one card * per page, page N -> hero-NN.jpg) via pypdfium2. To re-render: *   python -m pip install pypdfium2 *   python tools/extract-hero-cards.py     # NOTE: script not committed, *                                          # invoked ad-hoc during the *                                          # 2026-05-18 art hook-up. * * Cards #5 + #6 are NOT yet unlocked by any chapter's onEnter * actions — they show up in the Campaign Sheet as locked entries * so the player has a visible "more to come" hint. When future * chapters add `unlock-hero-cards` actions for them, no change is * needed here. */
        export interface HeroCardMeta {
            number: number;
            name: string;
            suit: Suit; /** Path under `/public/heroes/` (e.g. "hero-01.jpg"). Required   * — every card in HERO_CARDS ships with art today. */
            image: string;
        }
        export const HERO_CARDS: readonly HeroCardMeta[] = Object.freeze([{ number: 1, name: "Hero #01", suit: "mind", image: "hero-01.jpg" }, { number: 2, name: "Hero #02", suit: "body", image: "hero-02.jpg" }, { number: 3, name: "Hero #03", suit: "mind", image: "hero-03.jpg" }, { number: 4, name: "Hero #04", suit: "body", image: "hero-04.jpg" }, { number: 5, name: "Hero #05", suit: "mind", image: "hero-05.jpg" }, { number: 6, name: "Hero #06", suit: "body", image: "hero-06.jpg" }, { number: 7, name: "Hero #07", suit: "mind", image: "hero-07.jpg" }, { number: 8, name: "Hero #08", suit: "body", image: "hero-08.jpg" }, { number: 9, name: "Hero #09", suit: "mind", image: "hero-09.jpg" }, { number: 10, name: "Hero #10", suit: "body", image: "hero-10.jpg" },]);
        export function getHeroCard(number: number): HeroCardMeta { const c = HERO_CARDS.find((h) => h.number === number); if (!c)
            throw new Error(`Unknown hero card number: ${number}`); return c; }
        /** * Static catalog of every Key Item the campaign can grant, keyed by * printed item number. The chapter data (`data/chapter1.json`) * authors `gain-key-item { number, name }` for each beat — the * `name` it writes is the source of truth at grant time and is * what gets stored in `state.keyItems`, so historic saves keep * the as-written display string even if the catalog name later * changes. The catalog's job is the image lookup + a backup * display name for any UI that needs to render a key item the * player hasn't acquired yet (Campaign Sheet "yet to acquire" * teases, future "all key items" gallery, etc.). * * Images extracted from `ASSETS/Gone to Gaia/Key Item Cards Front * v2 PROOF 2.pdf` (one card per page) on 2026-05-18. Card #22 * (Distress Signal) is the outlier number in the proof — the rest * line up with their page order. Re-extract via the pypdfium2 * one-liner in this file's git history. * * Throws on lookup of an unknown number (defensive — every shipped * key item must appear here; a missing entry is a data bug). */
        export interface KeyItemMeta {
            number: number;
            name: string; /** Path under `/public/key-items/` (e.g. "key-item-03.jpg"). */
            image: string; /**   * Number of clue token icons printed on this key item card (the   * magnifying-glass symbol). Used to gate conditional shop products   * (#13 at 2+ total clues, #14 at 4+) and displayed on the Campaign   * Sheet. Defaults to 1 for all current items.   */
            clues: number;
        }
        export const KEY_ITEMS: readonly KeyItemMeta[] = Object.freeze([{ number: 1, name: "Surveillance Camera", image: "key-item-01.jpg", clues: 1 }, { number: 2, name: "Abandoned Syringe", image: "key-item-02.jpg", clues: 1 }, { number: 3, name: "Woo's Diary", image: "key-item-03.jpg", clues: 1 }, { number: 4, name: "Large Bone", image: "key-item-04.jpg", clues: 1 }, { number: 5, name: "Dr Ira's Testimony", image: "key-item-05.jpg", clues: 1 }, { number: 6, name: "Good Friends Picture", image: "key-item-06.jpg", clues: 1 }, { number: 7, name: "You Found Elias Brass", image: "key-item-07.jpg", clues: 1 }, { number: 8, name: "Melted Vial", image: "key-item-08.jpg", clues: 1 }, { number: 9, name: "Green Paint Chips", image: "key-item-09.jpg", clues: 1 }, { number: 10, name: "Abducted Tidekin", image: "key-item-10.jpg", clues: 1 }, { number: 11, name: "Baby Janus", image: "key-item-11.jpg", clues: 1 }, { number: 12, name: "Dahlia is Free", image: "key-item-12.jpg", clues: 1 }, { number: 13, name: "Many Revelations", image: "key-item-13.jpg", clues: 2 }, { number: 14, name: "Corpse of Ruined Tidekin", image: "key-item-14.jpg", clues: 1 }, { number: 15, name: "A Strange New World", image: "key-item-15.jpg", clues: 2 }, { number: 16, name: "A Warden Unmasked", image: "key-item-16.jpg", clues: 2 }, { number: 17, name: "Gabriel's Diary", image: "key-item-17.jpg", clues: 1 }, { number: 18, name: "The Tablet", image: "key-item-18.jpg", clues: 2 }, { number: 19, name: "Signal Received", image: "key-item-19.jpg", clues: 2 }, { number: 20, name: "The Secret Lab is Gone", image: "key-item-20.jpg", clues: 1 }, { number: 21, name: "Bioluminescence", image: "key-item-21.jpg", clues: 2 }, { number: 22, name: "Distress Signal", image: "key-item-22.jpg", clues: 1 }, { number: 23, name: "You saved Dr Ira", image: "key-item-23.jpg", clues: 1 }, { number: 24, name: "You didn't save Dr Ira", image: "key-item-24.jpg", clues: 0 },]);
        export function getKeyItem(number: number): KeyItemMeta { const k = KEY_ITEMS.find((x) => x.number === number); if (!k)
            throw new Error(`Unknown key item number: ${number}`); return k; }
        /** * Static catalog of every Quest card the campaign can reveal, * keyed by printed quest number. The chapter data authors * `reveal-quest { number, name }` for each beat; the `name` it * writes is the source of truth at reveal time and is what gets * stored in `state.revealedQuests`, so historic saves keep the * as-written display string even if the catalog name later * changes. The catalog's job is the image lookup + a backup * display name for any UI that wants to render a quest the * player hasn't revealed yet. * * Images extracted from `ASSETS/Gone to Gaia/Quest Card Front * v4 PROOF 1.pdf` (one card per page) on 2026-05-18. Six quests * in the proof — numbers 1, 2, 3, 5, 6, 10 (the printed sequence * skips a few). Re-extract via the pypdfium2 one-liner in this * file's git history. * * Throws on lookup of an unknown number (defensive — every shipped * quest must appear here; a missing entry is a data bug). */
        export interface QuestMeta {
            number: number;
            name: string; /** Path under `/public/quests/` (e.g. "quest-02.jpg"). */
            image: string;
        }
        export const QUESTS: readonly QuestMeta[] = Object.freeze([{ number: 1, name: "Reach the Buoy", image: "quest-01.jpg" }, { number: 2, name: "The Surveillance Device", image: "quest-02.jpg" }, { number: 3, name: "Xavier's Request", image: "quest-03.jpg" }, { number: 4, name: "A Hand Outstretched", image: "quest-04.jpg" }, { number: 5, name: "The Rogue Delver", image: "quest-05.jpg" }, { number: 6, name: "The Forgotten Vault", image: "quest-06.jpg" }, { number: 7, name: "Further Afield", image: "quest-07.jpg" }, { number: 8, name: "The Bridge", image: "quest-08.jpg" }, { number: 9, name: "Sins of the Father", image: "quest-09.jpg" }, { number: 10, name: "A Glimpse of the Past", image: "quest-10.jpg" }, { number: 13, name: "Underneath the Watchtower", image: "quest-13.jpg" },]);
        export function getQuest(number: number): QuestMeta { const q = QUESTS.find((x) => x.number === number); if (!q)
            throw new Error(`Unknown quest number: ${number}`); return q; }
        /** Best-effort image lookup. Returns `null` for unknown numbers so *  callers can render a graceful fallback instead of throwing. Use *  for save-data render paths where a future-chapter quest could *  legitimately predate the catalog entry. */
        export function questImageOrNull(number: number): string | null { return QUESTS.find((x) => x.number === number)?.image ?? null; }
        /** Best-effort image lookup. Returns `null` for an unknown number so *  callers can render a graceful fallback instead of throwing. Use *  for save-data render paths where a future-chapter key item number *  could legitimately predate the catalog entry. */
        export function keyItemImageOrNull(number: number): string | null { return KEY_ITEMS.find((x) => x.number === number)?.image ?? null; }
        /** Best-effort image lookup for a printed Level Up card (1..28). *  Returns `null` for an unknown number so the RewardsModal can *  render a graceful placeholder. Path is the bare filename inside *  `public/levelup/` (callers prefix with `/levelup/`). */
        export function levelUpCardImageOrNull(cardNumber: number): string | null { return LEVEL_DECK.find((c) => c.cardNumber === cardNumber)?.image ?? null; }
        /** * Static catalog of every printed Memory Card. Drawn by the Ch2 * Machinist "Witness records a memory" pages when the player spends * Memory Chip Tokens — one card per chip spent (with replacement, * so duplicates are expected when the player has more chips than * the deck has distinct cards). * * Source pack (extracted 2026-05-21): *   - `ASSETS/Gone to Gaia/Memory Card Fronts v2 PROOF 1.pdf` *   - Page 1: Memory #01 — "REWARD: Gain Quest #10: A Glimpse of the Past." *   - Page 2: Memory #02 — "UPGRADE: Whenever Witness collects a *                          Minion Part, he deals 1 damage to all *                          adjacent enemies." * * Today both cards are TRACKED-ONLY — the printed effects are not * yet wired into the runtime (no Quest #10 catalog, no Witness- * adjacent damage trigger). The grant flow exists so playtesters * see the printed art at draw time + can verify the spend math; the * effects will plug into existing systems in a future pass without * an engine change to this catalog. * * Filenames follow `memory_NN.jpg` and live under * `/public/memory-cards/`. Adding a future Memory card: extract the * new page via `scripts/extractMemoryCardImages.mjs`, drop the * resulting jpg in `public/memory-cards/`, and append an entry * here — no engine change needed (the engine reads `MEMORY_CARDS` * to size its random-draw pool). */
        export interface MemoryCardMeta {
            number: number; /** Short human label used for log lines + a11y alt text. */
            name: string; /** Path under `/public/memory-cards/` (e.g. "memory_01.jpg"). */
            image: string; /** Card back (the Witness ability), when the card has one. */
            backImage?: string;
        }
        /** Ordered Memory Fragment deck (draws go #1, #2, ... and stop at #10).
         *  #3-#10 are placeholder cards (scripts/buildMemoryFragments.py):
         *  #6-#10 from the prototype PDF, #3-#5 drawn from the workbook text. */
        export const MEMORY_CARDS: readonly MemoryCardMeta[] = Object.freeze([
            { number: 1, name: "A Glimpse of the Past", image: "memory_01.jpg" },
            { number: 2, name: "Witness: 2 damage", image: "memory_02.jpg", backImage: "memory_02_back.jpg" },
            { number: 3, name: "Witness: 2 damage or heal 1", image: "memory_03.jpg", backImage: "memory_03_back.jpg" },
            { number: 4, name: "The Tablet", image: "memory_04.jpg", backImage: "memory_04_back.jpg" },
            { number: 5, name: "Witness: 4 damage or heal 2", image: "memory_05.jpg", backImage: "memory_05_back.jpg" },
            { number: 6, name: "Sins of the Father", image: "memory_06.jpg", backImage: "memory_06_back.jpg" },
            { number: 7, name: "Witness: 6 damage or heal 3", image: "memory_07.jpg", backImage: "memory_07_back.jpg" },
            { number: 8, name: "Witness: 8 damage or heal 4", image: "memory_08.jpg", backImage: "memory_08_back.jpg" },
            { number: 9, name: "Witness: 10 damage or heal 5", image: "memory_09.jpg", backImage: "memory_09_back.jpg" },
            { number: 10, name: "The Ark", image: "memory_10.jpg", backImage: "memory_10_back.jpg" },
        ]);
        export function memoryCardBackImageOrNull(cardNumber: number): string | null { return MEMORY_CARDS.find((c) => c.number === cardNumber)?.backImage ?? null; }
        /** Best-effort image lookup for a printed Memory card. Returns *  `null` for an unknown number so the RewardsModal can render a *  graceful placeholder. Path is the bare filename inside *  `public/memory-cards/` (callers prefix with `/memory-cards/`). */
        export function memoryCardImageOrNull(cardNumber: number): string | null { return MEMORY_CARDS.find((c) => c.number === cardNumber)?.image ?? null; }
        /** Best-effort name lookup for a Memory card — mirrors *  {@link memoryCardImageOrNull} so callers (logs, Campaign Sheet *  roster) can render a label without resolving the catalog entry *  themselves. */
        export function memoryCardNameOrNull(cardNumber: number): string | null { return MEMORY_CARDS.find((c) => c.number === cardNumber)?.name ?? null; } // ---------- Scenario Cards (Wave 2+ trigger deck) ----------/** * Static catalog for the printed Scenario Card deck (PROOF 2 set — * `Scenario Cards Front v4 PROOF 2.pdf` + `... Back v4 PROOF 2.pdf`). * * Per the rulebook: 40 cards exist in the full game (only 11 are * printed in PROOF 2 — #01..#09 numbered plus A/B lettered). The * deck is not used during Chapter 1. The Chapter 2 storybook * triggers `Scenario Card #01` at Wave 2 start and `#02` at Wave 3 * start (PROOF 6 pages 6 & 8). * * Trigger flow: *   1. `engine/encounter.ts > bootstrapWaveAtNumber` reads the *      wave's `scenarioCardOnStart` and, if set + not already in *      `state.scenarioCardsResolved`, sets `state.currentScenarioCard`. *   2. BoardScreen sees the non-null `currentScenarioCard` and *      mounts `screens/ScenarioCardModal.ts` over the board. *   3. The modal shows the front art + narrative + choice buttons, *      then flips to the back art + chosen-option resolution text. *   4. `engine/scenarioCard.ts > resolveScenarioCard` auto-applies *      the chosen option's `effects` (today: only cards #01 + #02 *      have non-empty effect lists — the rest are MANUAL: the *      player applies the printed resolution themselves, the *      engine just records the choice). *   5. Modal Continue button clears `currentScenarioCard` to null, *      appends the card number to `state.scenarioCardsResolved` *      (matches the printed "discard the card" step), and the *      board resumes normal play. * * Lettered cards A / B are stored as numbers 100 / 101 so the * single integer key in `scenarioCardsResolved` doesn't need a * string-discriminator overlay AND can't collide with the * numbered range (which today caps at 9 but may grow as more * cards print). */
        export type ScenarioCardChoiceLetter = "A" | "B" | "C";
        /** One programmatic effect applied when a scenario choice is *  resolved. Effects are intentionally a small closed union so the *  engine doesn't have to evaluate arbitrary expressions; each *  variant maps to one or two lines in *  `engine/scenarioCard.ts > applyScenarioEffect`. Out-of-scope *  effects (opinion shifts that depend on which character is the *  co-pilot today, dice rolls, "choose a delver to spend an *  ELEMENT") are left to MANUAL resolution by the player today — *  the modal shows the printed resolution text either way, but *  manual choices leave state untouched. */
        export type ScenarioCardEffect = {
            kind: "heal-both-delvers";
            amount: number;
        } | {
            /** Both delvers heal to their max HP. */
            kind: "heal-both-delvers-full";
        } | {
            kind: "reduce-max-hp-both";
            amount: number;
        } | {
            kind: "grant-element-choice-each";
            amount: number;
        } | {
            kind: "grant-level-up-card";
            amount: number;
        } | {
            kind: "gain-scar-both-delvers";
            keyword: string;
        } /**   * "Choose ONE delver to gain +N RANK of <type>."   * Enqueues a suit-condition rank pick (open hero, pinned type) into the   * campaign-level `pendingSuitConditionPicks` queue. The   * `suit-condition-rank-pick` modal drains it after the scenario card   * is closed, using the same two-step hero→type flow that Academy   * donation and blood-soaked picks use, but with the type pre-pinned   * so only the hero-chooser step is shown.   */ | {
            kind: "grant-equipment-rank-one-delver";
            equipmentType: EquipmentType;
            amount: 1 | 2;
        } /** Gain shared campaign XP. */ | {
            kind: "gain-xp";
            amount: number;
        } /** Each delver loses `amount` HP, but cannot drop below 1. */ | {
            kind: "lose-hp-both-floor-at-one";
            amount: number;
        } /** One chosen delver loses `amount` HP (floor at 1). Queues a delver pick. */ | {
            kind: "lose-hp-one-delver-floor-at-one";
            amount: number;
        } /** One chosen delver gains `amount` consumable tokens of `tokenKind`. Queues a delver pick. */ | {
            kind: "grant-consumable-token-one-delver";
            tokenKind: ConsumableTokenKind;
            amount: number;
        } /**   * One chosen delver gains +`amount` AP (adds to both baseAp and currentAp).   * AP tokens were unified with baseAp in 2026-05-09; this is the modern equivalent.   * Queues a delver pick.   */ | {
            kind: "grant-ap-one-delver";
            amount: number;
        } /** Both delvers lose all their elements. */ | {
            kind: "lose-all-elements-both";
        } /**   * Shift an NPC's favour (opinion) by `delta` and grant the matching opinion card   * if a named threshold was crossed. Reuses the same Vera-shield + cascade logic   * as the town-visit `shift-favour` action.   */ | {
            kind: "shift-favour-by-scenario";
            characterId: string;
            characterName: string;
            delta: number;
        } /** Add specific shop product numbers to the campaign's available products. */ | {
            kind: "add-shop-products";
            products: number[];
        } /** Grant a Friendly Spawn card to the Spawn Deck. */ | {
            kind: "grant-friendly-spawn-card";
        } /**   * Roll a d6; apply the effects in the matching outcome bracket.   * Renders a "Roll Die" button in the scenario-card back UI; Continue   * is blocked until the player rolls and the effects are applied.   */ | {
            kind: "die-roll-outcome";
            outcomes: Array<{
                minRoll: number;
                maxRoll: number; /** Short label shown in the die-roll UI (e.g. "1-2: Lose 1 HP"). */
                label: string;
                effects: ScenarioCardEffect[];
            }>;
        } /**   * Player picks one of two (or more) outcome options.   * Renders sub-choice buttons in the scenario-card back UI before   * the Continue button is available.   */ | {
            kind: "pick-one-outcome";
            options: Array<{
                label: string;
                effects: ScenarioCardEffect[];
            }>;
        } /**   * One chosen delver may optionally spend 1 ELEMENT; if they do,   * the listed shop products are added to the available pool.   * Renders a delver picker + "Skip" in the scenario-card back UI.   */ | {
            kind: "spend-element-for-shop-products";
            products: number[];
        } /**   * Add a Quest to the Open Quests. If the campaign already has it   * (owned or completed), grant `chipFallback` Memory Chip tokens   * instead. Gives quests a second route in via the Scenario deck.   */ | {
            kind: "reveal-quest-or-grant-chip";
            number: number;
            name: string;
            chipFallback: number;
        };
        export interface ScenarioCardChoice {
            letter: ScenarioCardChoiceLetter; /** Front-of-card choice button copy. */
            label: string; /** Back-of-card resolution narrative + mechanical summary. */
            resolutionText: string; /** Engine effects to auto-apply on this choice. Empty array =   *  MANUAL (printed effect text is shown; engine doesn't mutate   *  state — player handles it). */
            effects: ScenarioCardEffect[];
        }
        export interface ScenarioCard {
            number: number; /** Printed deck-position eyebrow (e.g. "SCENARIO #01" / "SCENARIO A"). */
            printedId: string; /** Short card name (e.g. "Sparkle"). */
            name: string; /** Front art file under `/public/scenario-cards/`. */
            frontImage: string; /** Back art file under `/public/scenario-cards/`. */
            backImage: string; /** Narrative copy on the front. */
            narrative: string; /** Available choices (always 2 or 3, depending on the printed card). */
            choices: ScenarioCardChoice[];
        }
        export const SCENARIO_CARDS: readonly ScenarioCard[] = Object.freeze([{ number: 1, printedId: "SCENARIO #01", name: "Sparkle", frontImage: "scenario_front_01.jpg", backImage: "scenario_back_01.jpg", narrative: "You descend down a hill, your boots sinking into lilac-colored snow. A sudden gust swirls snow into the night air \u2014 it glimmers like dancing lanternbugs. The glimmer floats past you and you swear you can hear faint giggling.", choices: [{ letter: "A", label: "Leave the entity alone.", resolutionText: "The giggling is too ominous, best to leave it alone. Both Delvers heal 1 HP.", effects: [{ kind: "heal-both-delvers", amount: 1 }], }, { letter: "B", label: "Try to capture it.", resolutionText: "You attempt to neutralize the entity with your beam. Instead, it unleashes a shriek and the earth begins to shake, triggering an avalanche. You barely make it out alive. Delvers reduce their max HP by 1.", effects: [{ kind: "reduce-max-hp-both", amount: 1 }], }, { letter: "C", label: "Follow it.", resolutionText: "You follow the entity to a clearing where the glimmer coalesces into the shape of a pixie. All at once, the little creature rushes toward you! Panicked, you flail backwards. Quickly rising, the figure is gone, but your suits are filled with new power. Delvers gain 1 ELEMENT of their choice.", effects: [{ kind: "grant-element-choice-each", amount: 1 }], },], }, { number: 2, printedId: "SCENARIO #02", name: "Cold", frontImage: "scenario_front_02.jpg", backImage: "scenario_back_02.jpg", narrative: "The temperature is dropping rapidly and you start shivering uncontrollably. Thankfully, you spot an abandoned ski lodge half-buried in the snow. It's in good condition \u2014 the doors are reinforced, and the chimney appears to have been well used.", choices: [{ letter: "A", label: "Go inside and warm up.", resolutionText: "You find an old shag rug in front of a fireplace. You throw a log on the fire and catch your bearings. Both Delvers heal 2 HP.", effects: [{ kind: "heal-both-delvers", amount: 2 }], }, { letter: "B", label: "Search inside for loot.", resolutionText: "You give the ski lodge a thorough search, eventually uncovering a stash of equipment left by a previous delver. Delvers gain a LEVEL UP card.", effects: [{ kind: "grant-level-up-card", amount: 1 }], }, { letter: "C", label: "Search the area outside the lodge.", resolutionText: "The point of a blade is sticking out of the snow. It's still sharp. Frostbite begins to nip at your extremities. Choose one Delver to gain +2 RANK of SWORD. Delvers reduce their max HP by 1.", effects: [{ kind: "reduce-max-hp-both", amount: 1 }, { kind: "grant-equipment-rank-one-delver", equipmentType: "Sword", amount: 2 },], },], }, { number: 3, printedId: "SCENARIO #03", name: "Bud", frontImage: "scenario_front_03.jpg", backImage: "scenario_back_03.jpg", narrative: "Your way is obstructed by a field of turquoise plants. Their bulbous buds expand and contract as if breathing. A closer inspection reveals that a viscous liquid moves inside each translucent bud.", choices: [{ letter: "A", label: "Capture some of the liquid in a vial, then detour around the field.", resolutionText: "You succeed in collecting the sap in a vial, but not before spilling some of it on your Gauntlet. It seeps through, paralyzing you briefly. Hmm. This could come in handy. Choose a Delver to gain 1 BLOCK COUNTERATTACK token.", effects: [{ kind: "grant-consumable-token-one-delver", tokenKind: "prevent-counterattack", amount: 1 }], }, { letter: "B", label: "Use your sword like a scythe to clear a path to move through.", resolutionText: "Your sweep causes many of the buds to burst open, covering you both in a sticky substance that seeps into your delversuits. You black out for a minute, and when you come to, your head aches terribly. Each Delver loses 2 HP \u2014 you can't drop below 1 HP this way.", effects: [{ kind: "lose-hp-both-floor-at-one", amount: 2 }], }, { letter: "C", label: "Gently step around each plant as you pass through the field.", resolutionText: "Threading a careful path through the field sharpens your awareness of the here and now. Choose a Delver to gain 1 AP token.", effects: [{ kind: "grant-ap-one-delver", amount: 1 }], },], }, { number: 4, printedId: "SCENARIO #04", name: "Outpost", frontImage: "scenario_front_04.jpg", backImage: "scenario_back_04.jpg", narrative: "You hear Headmistress Arlen's voice through your comms. \"Delvers, would you mind taking a detour to visit a nearby outpost? Don't ask how, but I happen to know of a cache of equipment hidden there that my students would benefit from greatly.\"", choices: [{ letter: "A", label: "Go, but keep what you find and report finding nothing to Arlen.", resolutionText: "\"What do you mean they weren't there? Are you lying to me, delvers?\" Both Delvers gain a LEVEL UP card. Decrease Headmistress Arlen's opinion (campaign sheet). Unless Arlen's opinion is now neutral, gain the matching opinion card.", effects: [{ kind: "grant-level-up-card", amount: 2 }, { kind: "shift-favour-by-scenario", characterId: "arlen", characterName: "Arlen", delta: -1 },], }, { letter: "B", label: "Go and give what you find to Arlen.", resolutionText: "You find a cache of equipment, which you dutifully hand over to Witness for delivery to Arlen. Increase Headmistress Arlen's opinion (campaign sheet). Unless Arlen's opinion is now neutral, gain the matching opinion card.", effects: [{ kind: "shift-favour-by-scenario", characterId: "arlen", characterName: "Arlen", delta: 1 },], }, { letter: "C", label: "Decline to take the detour and continue on your mission.", resolutionText: "You tell Arlen that you can't afford to deviate from your mission, which she grudgingly accepts. Delvers gain 2 ELEMENTS of their choice.", effects: [{ kind: "grant-element-choice-each", amount: 2 }], },], }, { number: 5, printedId: "SCENARIO #05", name: "Snowpetal", frontImage: "scenario_front_05.jpg", backImage: "scenario_back_05.jpg", narrative: "You come across a single Snowpetal \u2014 a flower that thrives in extreme cold. They are incredibly rare and highly valued for their aesthetic and medicinal properties. Their fragile composition, however, makes harvesting them a meticulous art.", choices: [{ letter: "A", label: "Cup the petals and detach the head.", resolutionText: "You remove the head of the flower but it quickly wilts. Live and learn, I guess. Gain 1 XP.", effects: [{ kind: "gain-xp", amount: 1 }], }, { letter: "B", label: "Send Elayna a comm for help.", resolutionText: "\"Snowpetals? I, um, I think grab them from under the petals and twist...\" She doesn't sound sure, but you follow her instructions. The twisting works, but it causes the flower to disintegrate. No effect.", effects: [], }, { letter: "C", label: "Scoop the entire flower out of the ground, preserving its roots.", resolutionText: "The flower survives the operation. How will you use it? Choose 1 option below.", effects: [{ kind: "pick-one-outcome", options: [{ label: "A: Medicinal \u2014 Delvers gain 2 HP", effects: [{ kind: "heal-both-delvers", amount: 2 }], }, { label: "B: Fashion \u2014 Add \"Snowpetal\" to scars", effects: [{ kind: "gain-scar-both-delvers", keyword: "Snowpetal" }], },], },], },], }, { number: 6, printedId: "SCENARIO #06", name: "Lift", frontImage: "scenario_front_06.jpg", backImage: "scenario_back_06.jpg", narrative: "Your path leads down jagged, steep cliffs. Nearby, you notice an old ski lift \u2014 it looks just like it did in your history textbook. Despite the brutal climate, the lift remains relatively intact. Empty chairlifts swing in the frigid air.", choices: [{ letter: "A", label: "Ask Witness for help with the generator, then ride the lift down.", resolutionText: "Witness beeps excitedly before releasing an electrical pulse into the generator. As if by magic, the ski lift hums to life. As you safely descend on a chairlift, you're struck by the stark beauty of the frozen mountain. Gain 2 XP.", effects: [{ kind: "gain-xp", amount: 2 }], }, { letter: "B", label: "Scavenge parts, then attempt to ride the power-less chairlift down.", resolutionText: "You find a handful of useful components you can repurpose in the old machine. The lift flies down the hill and you land with a crash. Delvers gain a LEVEL UP card. Choose a delver to lose 1 HP \u2014 you can't drop below 1 HP this way.", effects: [{ kind: "grant-level-up-card", amount: 1 }, { kind: "lose-hp-one-delver-floor-at-one", amount: 1 },], }, { letter: "C", label: "Ignore the ski lift and find your own way down the mountain.", resolutionText: "The descent is treacherous. Roll a die.", effects: [{ kind: "die-roll-outcome", outcomes: [{ minRoll: 1, maxRoll: 2, label: "1\u20132: Choose a delver to lose 1 HP (can't drop below 1 HP this way).", effects: [{ kind: "lose-hp-one-delver-floor-at-one", amount: 1 }], }, { minRoll: 3, maxRoll: 6, label: "3\u20136: Gain 1 XP.", effects: [{ kind: "gain-xp", amount: 1 }], },], },], },], }, { number: 7, printedId: "SCENARIO #07", name: "Directions", frontImage: "scenario_front_07.jpg", backImage: "scenario_back_07.jpg", narrative: "Samantha is in charge of guiding you through the Tide but she's backseat driving. \"Careful with that suspension hook \u2014 remember to always lift from the ventrical. Also I noticed that your flick capacitor is a bit overactive today so easy on the release valve. Oh and...\" It's constant.", choices: [{ letter: "A", label: "Tell Samantha she's distracting you and that she should stick to giving directions.", resolutionText: "You're not sure how Samantha will react. Roll a die.", effects: [{ kind: "die-roll-outcome", outcomes: [{ minRoll: 1, maxRoll: 2, label: "1\u20132: She's offended. Decrease Samantha's opinion. Unless her opinion is now neutral, gain the matching opinion card.", effects: [{ kind: "shift-favour-by-scenario", characterId: "samantha", characterName: "Samantha", delta: -1 },], }, { minRoll: 3, maxRoll: 6, label: "3\u20136: She takes it well and focuses on offering useful advice. Delvers gain a LEVEL UP card.", effects: [{ kind: "grant-level-up-card", amount: 1 }], },], },], }, { letter: "B", label: "Let her continue.", resolutionText: "Trying to follow Samantha's convoluted advice leads you to accidentally release the power stored in your suits. She is embarrassed and promises to make it up to you. Delvers lose all ELEMENTS. Increase Samantha's opinion. Unless her opinion is now neutral, gain the matching opinion card.", effects: [{ kind: "lose-all-elements-both" }, { kind: "shift-favour-by-scenario", characterId: "samantha", characterName: "Samantha", delta: 1 },], },], }, { number: 8, printedId: "SCENARIO #08", name: "Friends", frontImage: "scenario_front_08.jpg", backImage: "scenario_back_08.jpg", narrative: "Xavier is your co-pilot today. \"Do you see that mound off in the distance? A friend of mine lives there, you should pop in and say hello for me.\" (This card auto-skips to #09 if Xavier's opinion is Neutral or worse.)", choices: [{ letter: "A", label: "Go to the mound.", resolutionText: "It appears Xavier's friend was a massive creature of the Tide. Luckily this one is friendly. Add a Friendly Spawn card to the top of the Spawn deck.", effects: [{ kind: "grant-friendly-spawn-card" }], }, { letter: "B", label: "Don't go to the mound and check your equipment instead.", resolutionText: "Your equipment check pays off. Delvers gain a LEVEL UP card.", effects: [{ kind: "grant-level-up-card", amount: 1 }], },], }, { number: 9, printedId: "SCENARIO #09", name: "Trails", frontImage: "scenario_front_09.jpg", backImage: "scenario_back_09.jpg", narrative: "Your path diverges. The right trail ascends steeply, while the left path delves ever deeper into the Tide. At the Delving Academy, you were taught that higher paths are safer, but less trodden paths sometimes reward bold adventurers.", choices: [{ letter: "A", label: "Take the safer path.", resolutionText: "You decide that the Tide is already dangerous enough without making it worse. Delvers gain 2 ELEMENTS of their choice.", effects: [{ kind: "grant-element-choice-each", amount: 2 }], }, { letter: "B", label: "Tread the more dangerous road.", resolutionText: "Is it madness or inspiration that has led you down this path, you wonder? In the dark you can hear the calls of ferocious monsters but just as you are about to turn back you catch the glint of a rusted warhammer in the underbrush. Shuffle 2 Lieutenant Spawn Cards into the Spawn Deck (apply at the table). Add Shop Product #42 to your Purchaseable Products.", effects: [{ kind: "add-shop-products", products: [42] },], },], }, { number: 100, printedId: "SCENARIO A", name: "Tidebloom", frontImage: "scenario_front_10.jpg", backImage: "scenario_back_10.jpg", narrative: "While passing through an unfamiliar track of land, you notice the telltale signs of Tidebloom that has infected a patch of moss. The moss leads down into a narrow cave.", choices: [{ letter: "A", label: "Enter the cave.", resolutionText: "Inside the cave, you find the twisted remains of a humanoid \u2014 half coral, half human, but with a rash of toxic Tidebloom dripping from every pore. You can't help but notice that it's sporting a striking piece of armour. Gain Shop Product #33.", effects: [{ kind: "add-shop-products", products: [33] }], }, { letter: "B", label: "Collect a sample and move on.", resolutionText: "Collecting the Tidebloom sample provides a needed moment of respite. Both Delvers heal 1 HP.", effects: [{ kind: "heal-both-delvers", amount: 1 }], },], }, { number: 101, printedId: "SCENARIO B", name: "Heirloom", frontImage: "scenario_front_11.jpg", backImage: "scenario_back_11.jpg", narrative: "You hear Xavier's voice through your comms. \"Hey, I was thinking about what you said earlier, about getting revenge for my mom. There's something she used to own back when she was human \u2014 an ancient OS. It might be broken though. Do you want to see it?\"", choices: [{ letter: "A", label: "Of course, lead us to it.", resolutionText: "Xavier leads you to an alcove. Inside, you find the ancient OS stashed away. You flip the switch to turn it on but nothing happens. \"Try zapping it with one of your elements!\" Choose a delver to spend an ELEMENT. If they do, gain Shop Product #37.", effects: [{ kind: "spend-element-for-shop-products", products: [37] }], }, { letter: "B", label: "Sorry Xavier, but we can't afford the delay right now.", resolutionText: "Your unwavering commitment to your quest fills you with new vigor. Delvers gain a LEVEL UP card.", effects: [{ kind: "grant-level-up-card", amount: 1 }], },], }, { number: 10, printedId: "SCENARIO #10", name: "Lantern", frontImage: "scenario_front_s10.jpg", backImage: "scenario_back_s10.jpg", narrative: "A paper festival lantern drifts through the mist, its candle still burning. A name is written on its side — someone set it loose for the Memorial.", choices: [{ letter: "A", label: "Follow it.", resolutionText: "It leads you to a sheltered hollow. Roll a die. 1–2: something was already sheltering there — each Delver loses 2 HP (can't drop below 1). 3–6: a previous delver's cache. Gain a LEVEL UP card.", effects: [{ kind: "die-roll-outcome", outcomes: [{ minRoll: 1, maxRoll: 2, label: "1-2: Each Delver loses 2 HP", effects: [{ kind: "lose-hp-both-floor-at-one", amount: 2 }] }, { minRoll: 3, maxRoll: 6, label: "3-6: Gain a LEVEL UP card", effects: [{ kind: "grant-level-up-card", amount: 1 }] }] }] }, { letter: "B", label: "Let it drift and say the name aloud.", resolutionText: "You watch it go until the mist swallows its glow. A moment of peace. Both Delvers heal 2 HP.", effects: [{ kind: "heal-both-delvers", amount: 2 }] }, { letter: "C", label: "Salvage the candle.", resolutionText: "The wax is laced with creature oil — it still holds a charge. Choose one Delver to gain +1 RANK of BATTERY.", effects: [{ kind: "grant-equipment-rank-one-delver", equipmentType: "Battery", amount: 1 }] }] }, { number: 11, printedId: "SCENARIO #11", name: "Runoff", frontImage: "scenario_front_s11.jpg", backImage: "scenario_back_s11.jpg", narrative: "A rusted pipe juts from the cliff face, spilling black sludge into the Tide. The plants around it have withered to husks. The pipe runs uphill — toward Bird's Nest.", choices: [{ letter: "A", label: "Seal it.", resolutionText: "You hammer the pipe shut, but the fumes sting your lungs. Each Delver loses 1 HP (can't drop below 1). The creatures nearby seem calmer already. Add a Friendly Spawn Card to the Spawn Deck.", effects: [{ kind: "lose-hp-both-floor-at-one", amount: 1 }, { kind: "grant-friendly-spawn-card" }] }, { letter: "B", label: "Follow the pipe.", resolutionText: "It ends at a sealed grate stamped with a familiar green hatch. Someone left tools behind. Gain a LEVEL UP card.", effects: [{ kind: "grant-level-up-card", amount: 1 }] }, { letter: "C", label: "Leave it.", resolutionText: "It isn't your mission — not today. Delvers gain 1 ELEMENT of their choice.", effects: [{ kind: "grant-element-choice-each", amount: 1 }] }] }, { number: 12, printedId: "SCENARIO #12", name: "Clawprints", frontImage: "scenario_front_s12.jpg", backImage: "scenario_back_s12.jpg", narrative: "Huge, fresh prints — each with a deep gouge where a single claw drags. Bioluminescent residue glows in every one. They're headed for the coast.", choices: [{ letter: "A", label: "Track it.", resolutionText: "Roll a die. 1–3: it was waiting for you — choose a Delver to lose 3 HP (can't drop below 1). 4–6: you catch it sleeping and strike first. Choose a Delver to gain 1 UNIVERSAL 2X DAMAGE token.", effects: [{ kind: "die-roll-outcome", outcomes: [{ minRoll: 1, maxRoll: 3, label: "1-3: One Delver loses 3 HP", effects: [{ kind: "lose-hp-one-delver-floor-at-one", amount: 3 }] }, { minRoll: 4, maxRoll: 6, label: "4-6: One Delver gains a Universal 2x Damage token", effects: [{ kind: "grant-consumable-token-one-delver", tokenKind: "damage-2x-universal", amount: 1 }] }] }] }, { letter: "B", label: "Cover your trail.", resolutionText: "You double back over rock so nothing can follow you home. Choose a Delver to gain 1 AP token.", effects: [{ kind: "grant-ap-one-delver", amount: 1 }] }, { letter: "C", label: "Take a cast of the print for Xavier.", resolutionText: "\"This is extraordinary,\" Xavier crackles over the comms. Increase Xavier's opinion (campaign sheet). Unless his opinion is now neutral, gain the matching opinion card.", effects: [{ kind: "shift-favour-by-scenario", characterId: "xavier", characterName: "Xavier", delta: 1 }] }] }, { number: 13, printedId: "SCENARIO #13", name: "Waystation", frontImage: "scenario_front_s13.jpg", backImage: "scenario_back_s13.jpg", narrative: "Behind a fallen wall you find a delvers' waystation: two bedrolls, a firepit, and a box with a note — \"Take something, leave something.\"", choices: [{ letter: "A", label: "Take something.", resolutionText: "Inside the box is a well-kept tool kit. You feel a twinge of guilt leaving nothing behind. Gain a LEVEL UP card.", effects: [{ kind: "grant-level-up-card", amount: 1 }] }, { letter: "B", label: "Leave something.", resolutionText: "You leave a ration and a note for whoever comes next, then rest by the fire. Both Delvers heal 3 HP.", effects: [{ kind: "heal-both-delvers", amount: 3 }] }, { letter: "C", label: "Carve your names on the wall.", resolutionText: "Among hundreds of names, yours now stand too. You don't feel so alone. Delvers gain 1 ELEMENT of their choice.", effects: [{ kind: "grant-element-choice-each", amount: 1 }] }] }, { number: 14, printedId: "SCENARIO #14", name: "Siren Song", frontImage: "scenario_front_s14.jpg", backImage: "scenario_back_s14.jpg", narrative: "A low, beautiful humming rolls through the mist. Through the kelp you see them — Sirens, swaying in a circle. Dr Ira's notes called them docile.", choices: [{ letter: "A", label: "Listen.", resolutionText: "It's like being sung to sleep. Your wounds ache a little less. Both Delvers heal 2 HP.", effects: [{ kind: "heal-both-delvers", amount: 2 }] }, { letter: "B", label: "Plug your ears and push on.", resolutionText: "You march past with grim focus. Choose a Delver to gain 1 AP token.", effects: [{ kind: "grant-ap-one-delver", amount: 1 }] }, { letter: "C", label: "Capture one for Dr Ira's research.", resolutionText: "It screams the whole way back to the path. Delvers reduce their max HP by 1. Choose a Delver to gain +2 RANK of HARVESTER. Increase Dr Ira's opinion (campaign sheet).", effects: [{ kind: "reduce-max-hp-both", amount: 1 }, { kind: "grant-equipment-rank-one-delver", equipmentType: "Harvester", amount: 2 }, { kind: "shift-favour-by-scenario", characterId: "ira", characterName: "Dr Ira", delta: 1 }] }] }, { number: 15, printedId: "SCENARIO #15", name: "Static", frontImage: "scenario_front_s15.jpg", backImage: "scenario_back_s15.jpg", narrative: "Witness stops dead. His eyes flicker and project a blurry image — a cold room, a small bed. Then he whirs and carries on as if nothing happened.", choices: [{ letter: "A", label: "Wait with him.", resolutionText: "You sit beside him until his lights steady. Both Delvers heal 1 HP and gain 1 ELEMENT of their choice.", effects: [{ kind: "heal-both-delvers", amount: 1 }, { kind: "grant-element-choice-each", amount: 1 }] }, { letter: "B", label: "Tap the side of his head.", resolutionText: "The projection snaps off and a spare circuit board drops out. Choose a Delver to gain +1 RANK of OS.", effects: [{ kind: "grant-equipment-rank-one-delver", equipmentType: "OS", amount: 1 }] }, { letter: "C", label: "Keep moving.", resolutionText: "Whatever that was, it can wait. Gain 2 XP.", effects: [{ kind: "gain-xp", amount: 2 }] }] }, { number: 16, printedId: "SCENARIO #16", name: "Puppet", frontImage: "scenario_front_s16.jpg", backImage: "scenario_back_s16.jpg", narrative: "One of the creatures stands perfectly still in a clearing. A metal port is set into the back of its neck, a needle still inside.", choices: [{ letter: "A", label: "Pull the needle.", resolutionText: "It thrashes, then looks at you with clear eyes before fleeing into the mist. Choose a Delver to lose 2 HP (can't drop below 1). Add a Friendly Spawn Card to the Spawn Deck.", effects: [{ kind: "lose-hp-one-delver-floor-at-one", amount: 2 }, { kind: "grant-friendly-spawn-card" }] }, { letter: "B", label: "Put it out of its misery.", resolutionText: "It doesn't resist. Its energy flows into your suits. Delvers gain 1 ELEMENT of their choice.", effects: [{ kind: "grant-element-choice-each", amount: 1 }] }, { letter: "C", label: "Pocket the needle as evidence.", resolutionText: "The tip is coated in a paralytic. It could come in handy. Choose a Delver to gain 1 BLOCK COUNTERATTACK token.", effects: [{ kind: "grant-consumable-token-one-delver", tokenKind: "prevent-counterattack", amount: 1 }] }] }, { number: 17, printedId: "SCENARIO #17", name: "Small Footprints", frontImage: "scenario_front_s17.jpg", backImage: "scenario_back_s17.jpg", narrative: "Tiny bare footprints cross the mud. The mist curls away from each one, as if repelled.", choices: [{ letter: "A", label: "Follow them.", resolutionText: "They end at an empty camp. A child's toy has been left behind, and the creatures nearby are strangely gentle. Add a Friendly Spawn Card to the Spawn Deck.", effects: [{ kind: "grant-friendly-spawn-card" }] }, { letter: "B", label: "Brush them away so no one else can follow.", resolutionText: "Whoever they belong to, they deserve a head start. Increase Elias's opinion (campaign sheet).", effects: [{ kind: "shift-favour-by-scenario", characterId: "elias", characterName: "Elias Brass", delta: 1 }] }, { letter: "C", label: "Mark them on your map.", resolutionText: "Someone at the Academy will want to see this. Gain a LEVEL UP card.", effects: [{ kind: "grant-level-up-card", amount: 1 }] }] }, { number: 102, printedId: "SCENARIO C", name: "Elders", frontImage: "scenario_front_c.jpg", backImage: "scenario_back_c.jpg", narrative: "Branch-like fingers part the mist. A Tidekin elder blocks your path, watching you without a sound.", choices: [{ letter: "A", label: "Lower your weapons.", resolutionText: "The elder touches your helmet and a vision floods your mind — a pipe pouring black sludge into the Tide. Both Delvers heal 2 HP. Increase Dahlia's opinion (campaign sheet).", effects: [{ kind: "heal-both-delvers", amount: 2 }, { kind: "shift-favour-by-scenario", characterId: "dahlia", characterName: "Dahlia", delta: 1 }] }, { letter: "B", label: "Offer a creature part as a gift.", resolutionText: "The elder accepts it and vanishes. Later, you notice the creatures of the Tide give you a wider berth. Add a Friendly Spawn Card to the Spawn Deck.", effects: [{ kind: "grant-friendly-spawn-card" }] }, { letter: "C", label: "Raise your weapons.", resolutionText: "The elder is gone before you blink, and the mist turns cold and heavy. Delvers gain 2 ELEMENTS of their choice. Delvers reduce their max HP by 1.", effects: [{ kind: "grant-element-choice-each", amount: 2 }, { kind: "reduce-max-hp-both", amount: 1 }] }] }, { number: 103, printedId: "SCENARIO D", name: "Open Hand", frontImage: "scenario_front_d.jpg", backImage: "scenario_back_d.jpg", narrative: "Discard this card and draw the next Scenario if this is Chapter 5 or later. — Dahlia steps out from behind the kelp, one slender hand held open toward you. She bows deeply. \"You. Saved me. Strong... and kind.\"", choices: [{ letter: "A", label: "Listen to what she has to say.", resolutionText: "\"Tidekin... afraid. Kin taken,\" she says slowly. \"You... help? Come. Meet.\" Add Quest #04 \"A Hand Outstretched\" to your Open Quests. If already owned or completed, instead gain a Memory Chip token.", effects: [{ kind: "reveal-quest-or-grant-chip", number: 4, name: "A Hand Outstretched", chipFallback: 1 }] }, { letter: "B", label: "Walk with her a while.", resolutionText: "She leads you along a hidden path through the kelp, then melts back into the mist. The way ahead is quiet and safe. Both Delvers heal 2 HP.", effects: [{ kind: "heal-both-delvers", amount: 2 }] }, { letter: "C", label: "Tell her you can't stay.", resolutionText: "She nods, presses a smooth, warm stone into your palm, and is gone. It thrums like a heartbeat. Delvers gain 1 ELEMENT of their choice.", effects: [{ kind: "grant-element-choice-each", amount: 1 }] }] },]);
        /** Best-effort catalog lookup by stable scenario number. Returns *  `null` for an unknown id so callers (Campaign Sheet roster, *  debug overlays) can render a graceful placeholder. */
        export function scenarioCardOrNull(cardNumber: number): ScenarioCard | null { return SCENARIO_CARDS.find((c) => c.number === cardNumber) ?? null; }
        /** Strict catalog lookup — throws on unknown id. Used by the engine *  bootstrap path where a missing card is a real data bug (the *  quest references a card the catalog doesn't have). */
        export function getScenarioCard(cardNumber: number): ScenarioCard { const card = scenarioCardOrNull(cardNumber); if (!card) {
            throw new Error(`getScenarioCard: unknown card number ${cardNumber}`);
        } return card; } // ============================================================// Friendly Spawn Cards + Friendly Encounter deck// ============================================================/** * Printed Friendly Spawn Card numbers. The base spawn deck (1..12) * is everything that ships in the box; #13 and #14 are the two * Friendly Spawn Cards that get shuffled in via the * `grant-friendly-spawn-card` Town Visit action and live in * `state.friendlySpawnDeck` until they're drawn. */
        export const FRIENDLY_SPAWN_CARD_NUMBERS: readonly number[] = Object.freeze([13, 14]);
        /** True iff `cardNumber` is one of the printed Friendly Spawn Cards. */
        export function isFriendlySpawnCardNumber(cardNumber: number): boolean { return FRIENDLY_SPAWN_CARD_NUMBERS.includes(cardNumber); }
        /** * Pick the next Friendly Spawn Card number to grant. Walks * `FRIENDLY_SPAWN_CARD_NUMBERS` in printed order and returns the * first entry not yet in `ownedNumbers`. Returns `null` when the * campaign already owns every printed friendly spawn card (today * that means both #13 and #14 are already in * `state.friendlySpawnDeck`). * * Order is deterministic (not random) so a fresh campaign always * grants #13 first, then #14 — keeps the chapter-1 grant * predictable for tests and so the player's first friendly card * is the same across saves. */
        export function nextFriendlySpawnCardNumber(ownedNumbers: readonly number[]): number | null { for (const n of FRIENDLY_SPAWN_CARD_NUMBERS) {
            if (!ownedNumbers.includes(n))
                return n;
        } return null; }
        /** * One printed Friendly Encounter card — the resolution drawn when * a delver or Witness steps onto a Friendly Encounter token tile. * * Today the printed deck ships only ONE card (#01, "Flambe"), so * the draw is trivial: pick #01 every time. The catalog is shaped * to grow (multiple cards, optional random draw) so future * chapters can add cards without touching the engine wiring. * * Mechanical effects are intentionally MANUAL today: the modal * shows the printed art + a Continue button; the player applies * the printed effect at the table (mirrors how Scenario Cards * #03-#09 are handled). Adding auto-applied effects later means * adding an `effects` array on this interface and a matching * `applyFriendlyEncounterEffect` switch in * `engine/friendlyEncounter.ts`. */
        export interface FriendlyEncounterCard {
            number: number; /** Printed deck-position eyebrow (e.g. "FRIENDLY ENCOUNTER #01"). */
            printedId: string; /** Short card name (e.g. "Flambe"). */
            name: string; /** Front art file under `/public/friendly-encounter-cards/`. */
            frontImage: string;
        }
        export const FRIENDLY_ENCOUNTER_CARDS: readonly FriendlyEncounterCard[] = Object.freeze([{ number: 1, printedId: "FRIENDLY ENCOUNTER #01", name: "Flambe", frontImage: "friendly-monster-front-01.png", },]);
        /** Best-effort catalog lookup. Returns `null` for unknown ids. */
        export function friendlyEncounterCardOrNull(cardNumber: number): FriendlyEncounterCard | null { return FRIENDLY_ENCOUNTER_CARDS.find((c) => c.number === cardNumber) ?? null; }
        /** Strict catalog lookup — throws on unknown id. */
        export function getFriendlyEncounterCard(cardNumber: number): FriendlyEncounterCard { const card = friendlyEncounterCardOrNull(cardNumber); if (!card) {
            throw new Error(`getFriendlyEncounterCard: unknown card number ${cardNumber}`);
        } return card; }
        /** * Draw a Friendly Encounter card number from the printed deck. * Uses an injected RNG so the engine can pass `Math.random` for * live play and tests can pin a specific card without seeding * the global RNG. * * Today the printed deck has 1 card so this always returns #01; * future cards just need a catalog entry and this helper picks * uniformly from the catalog. * * Throws if the catalog is empty (config bug — the engine should * never call this when no friendly-encounter cards are printed). */
        export function drawFriendlyEncounterCard(rng: () => number = Math.random): number { if (FRIENDLY_ENCOUNTER_CARDS.length === 0) {
            throw new Error("drawFriendlyEncounterCard: empty catalog");
        } const idx = Math.floor(rng() * FRIENDLY_ENCOUNTER_CARDS.length); return FRIENDLY_ENCOUNTER_CARDS[idx]!.number; }
        /** * Shuffle the spawn deck the engine will draw from, INCLUDING any * friendly spawn cards the campaign currently owns. Wraps * `shuffleSpawnDeck` and merges in `friendlyOwned` before the * Fisher-Yates so every entry (base + friendly) has equal draw * probability. * * Returns a freshly shuffled array; mutating it is safe. */
        export function shuffleSpawnDeckWithFriendly(friendlyOwned: readonly number[], rng: () => number = Math.random): number[] {
            const base = SPAWN_CARDS.filter((c) => !FRIENDLY_SPAWN_CARD_NUMBERS.includes(c.number)).map((c) => c.number);
            for (let i = base.length - 1; i > 0; i--) {
                const j = Math.floor(rng() * (i + 1));
                const tmp = base[i]!;
                base[i] = base[j]!;
                base[j] = tmp;
            }
            return [...friendlyOwned, ...base];
        }
            /** * The five named positions on the printed Opinion track (rulebook p7 * Campaign Sheet — *"NEMESIS | DETRACTOR | NEUTRAL | ALLY | * CONFIDANT"*). Used by the favour engine to translate the signed * integer favour value into a named level and by the Opinion Card * catalog to key art by (character, level). * * Mapping (one integer per level — matches the 5-position printed * track): *   value <= -2  -> "nemesis" *   value === -1 -> "detractor" *   value ===  0 -> "neutral" *   value ===  1 -> "ally" *   value >=  2  -> "confidant" * * Only the four NAMED levels (excluding `neutral`) appear in * `OpinionLevel` because crossing into NEUTRAL grants no opinion * card — it's the "no relationship card" position. */
            export type OpinionLevel = "nemesis" | "detractor" | "ally" | "confidant";
            /** * Static catalog of every Opinion Card the campaign can grant, * keyed by `(characterId, level)`. Cards represent the named * positions on each character's opinion track (rulebook p7); each * character can have up to 4 cards (one per named level), but the * proof set only ships art for some pairs today. * * Source pack (extracted 2026-05-18): *   - `ASSETS/Gone to Gaia/Opinion Card Front {1..8}.png` *   - Pages 1..3: Xavier (Detractor / Confidant / Ally) *   - Pages 4..8: Arlen / Flores / Elayna / Samantha / Vera — Ally only. * * Character IDs match the keys used by `shift-favour` actions in * `data/chapter1.json` (`xavier`, `vera`, `samantha`, `flores`, * `elayne` (Elayna; id kept for saves), `arlen`). The `characterName` here is the display label * used for cards the player hasn't met yet (future "all opinion * cards" gallery); the per-gain display name stored in * `state.opinionCards` is the one captured at gain time from the * `shift-favour` action so historic saves keep the as-written * label even if the catalog later changes. * * Filenames follow `opinion-{characterId}-{level}.png` and live * under `/public/opinion-cards/`. New characters / levels: drop the * art file in place AND add an entry here — no engine change * needed. The favour engine ALWAYS records the gain in state; it * just gates the modal event emission on whether art is available * via {@link opinionCardImageOrNull}, so adding art to a new * (character, level) pair retroactively lights up the visual * reward for any future shift that crosses that threshold. */
            export interface OpinionCardMeta {
                characterId: string;
                characterName: string;
                level: OpinionLevel; /** Path under `/public/opinion-cards/` (e.g. "opinion-xavier-ally.png"). */
                image: string;
            }
            export const OPINION_CARDS: readonly OpinionCardMeta[] = Object.freeze([{ characterId: "xavier", characterName: "Xavier", level: "detractor", image: "opinion-xavier-detractor.png" }, { characterId: "xavier", characterName: "Xavier", level: "confidant", image: "opinion-xavier-confidant.png" }, { characterId: "xavier", characterName: "Xavier", level: "ally", image: "opinion-xavier-ally.png" }, { characterId: "arlen", characterName: "Arlen", level: "ally", image: "opinion-arlen-ally.png" }, { characterId: "flores", characterName: "Flores", level: "ally", image: "opinion-flores-ally.png" }, { characterId: "elayne", characterName: "Elayna", level: "ally", image: "opinion-elayne-ally.png" }, { characterId: "samantha", characterName: "Samantha", level: "ally", image: "opinion-samantha-ally.png" }, { characterId: "samantha", characterName: "Samantha", level: "detractor", image: "opinion-samantha-detractor.png" }, { characterId: "vera", characterName: "Vera", level: "ally", image: "opinion-vera-ally.png" },{ characterId: "arlen", characterName: "Arlen", level: "confidant", image: "opinion-arlen-confidant.png" }, { characterId: "arlen", characterName: "Arlen", level: "detractor", image: "opinion-arlen-detractor.png" }, { characterId: "arlen", characterName: "Arlen", level: "nemesis", image: "opinion-arlen-nemesis.png" }, { characterId: "dahlia", characterName: "Dahlia", level: "ally", image: "opinion-dahlia-ally.png" }, { characterId: "dahlia", characterName: "Dahlia", level: "confidant", image: "opinion-dahlia-confidant.png" }, { characterId: "dahlia", characterName: "Dahlia", level: "detractor", image: "opinion-dahlia-detractor.png" }, { characterId: "dahlia", characterName: "Dahlia", level: "nemesis", image: "opinion-dahlia-nemesis.png" }, { characterId: "elayne", characterName: "Elayna", level: "confidant", image: "opinion-elayne-confidant.png" }, { characterId: "elayne", characterName: "Elayna", level: "detractor", image: "opinion-elayne-detractor.png" }, { characterId: "elayne", characterName: "Elayna", level: "nemesis", image: "opinion-elayne-nemesis.png" }, { characterId: "elias", characterName: "Elias", level: "ally", image: "opinion-elias-ally.png" }, { characterId: "elias", characterName: "Elias", level: "confidant", image: "opinion-elias-confidant.png" }, { characterId: "elias", characterName: "Elias", level: "detractor", image: "opinion-elias-detractor.png" }, { characterId: "elias", characterName: "Elias", level: "nemesis", image: "opinion-elias-nemesis.png" }, { characterId: "flores", characterName: "Flores", level: "confidant", image: "opinion-flores-confidant.png" }, { characterId: "flores", characterName: "Flores", level: "detractor", image: "opinion-flores-detractor.png" }, { characterId: "flores", characterName: "Flores", level: "nemesis", image: "opinion-flores-nemesis.png" }, { characterId: "ira", characterName: "Ira", level: "ally", image: "opinion-ira-ally.png" }, { characterId: "ira", characterName: "Ira", level: "confidant", image: "opinion-ira-confidant.png" }, { characterId: "ira", characterName: "Ira", level: "detractor", image: "opinion-ira-detractor.png" }, { characterId: "ira", characterName: "Ira", level: "nemesis", image: "opinion-ira-nemesis.png" }, { characterId: "rodrigo", characterName: "Rodrigo", level: "ally", image: "opinion-rodrigo-ally.png" }, { characterId: "rodrigo", characterName: "Rodrigo", level: "confidant", image: "opinion-rodrigo-confidant.png" }, { characterId: "rodrigo", characterName: "Rodrigo", level: "detractor", image: "opinion-rodrigo-detractor.png" }, { characterId: "rodrigo", characterName: "Rodrigo", level: "nemesis", image: "opinion-rodrigo-nemesis.png" }, { characterId: "samantha", characterName: "Samantha", level: "confidant", image: "opinion-samantha-confidant.png" }, { characterId: "samantha", characterName: "Samantha", level: "nemesis", image: "opinion-samantha-nemesis.png" }, { characterId: "xavier", characterName: "Xavier", level: "nemesis", image: "opinion-xavier-nemesis.png" }, ]);
            /** Best-effort image lookup for an Opinion Card. Returns `null` when *  no art ships for the requested (character, level) pair so callers *  can render a graceful fallback (or, in the engine's case, *  suppress the rewards-modal event entirely while still tracking *  the gain in `state.opinionCards`). */
            export function opinionCardImageOrNull(characterId: string, level: OpinionLevel): string | null { return OPINION_CARDS.find((c) => c.characterId === characterId && c.level === level)?.image ?? null; }
            /** * Enumerate the NAMED opinion levels that a favour shift from * `before` to `after` crosses INTO (i.e. that the value newly * reaches as it walks toward `after`). Used by the favour engine * to grant one opinion card per newly-entered level on a single * shift. * * Crossing rules: *   - Upward (after > before): record every level whose entry *     value is in `(before, after]`. So 0 -> +1 records ALLY; *     0 -> +2 records ALLY then CONFIDANT; +1 -> +2 records *     CONFIDANT only. *   - Downward (after < before): symmetric for DETRACTOR / *     NEMESIS. 0 -> -1 records DETRACTOR; 0 -> -2 records *     DETRACTOR then NEMESIS. *   - Crossing NEUTRAL emits no card (NEUTRAL is the "no *     relationship" position): -1 -> +1 records ALLY only; *     +1 -> -1 records DETRACTOR only. * * Order is the order the levels are entered (innermost first for * each direction), so the rewards modal renders cards in the * narrative order the player crossed them. */
            export function opinionLevelsCrossed(before: number, after: number): OpinionLevel[] { if (after === before)
                return []; const out: OpinionLevel[] = []; if (after > before) {
                if (before < 1 && after >= 1)
                    out.push("ally");
                if (before < 2 && after >= 2)
                    out.push("confidant");
            }
            else {
                if (before > -1 && after <= -1)
                    out.push("detractor");
                if (before > -2 && after <= -2)
                    out.push("nemesis");
            } return out; }
            /** Map element id → token image filename (relative to /tokens/). */
            export const ELEMENT_IMAGE: Readonly<Record<Element, string>> = Object.freeze(Object.fromEntries(ELEMENTS.map((e) => [e.id, e.image])) as Record<Element, string>);
            export const DELVER_BOARDS = delverBoardsJson as readonly DelverBoardOverlay[];
            export interface ConsumableTokenDisplay {
                image: string | null;
                label: string;
                spendContextHint: string;
            }
            export const CONSUMABLE_TOKEN_DISPLAY: Readonly<Record<ConsumableTokenKind, ConsumableTokenDisplay>> = Object.freeze({
                "damage-2x-light": { image: "/tokens/2x-light.webp", label: "2x Light", spendContextHint: "Spent during a Light-damage swing to double its damage (max 1 Double Damage token per turn)." },
                "damage-2x-medium": { image: "/tokens/2x-medium.webp", label: "2x Medium", spendContextHint: "Spent during a Medium-damage swing to double its damage (max 1 Double Damage token per turn)." },
                "damage-2x-heavy": { image: "/tokens/2x-heavy.webp", label: "2x Heavy", spendContextHint: "Spent during a Heavy-damage swing to double its damage (max 1 Double Damage token per turn)." },
                "damage-2x-universal": { image: "/tokens/2x-light.webp", label: "2x Damage", spendContextHint: "Spent during any swing to double its damage (max 1 Double Damage token per turn)." },
                "reroll": { image: "/tokens/reroll.webp", label: "Reroll", spendContextHint: "Spent during any die roll you make to re-roll the result (max 1 per turn)." },
                "prevent-counterattack": { image: "/tokens/prevent-counterattack.webp", label: "Block Counterattack", spendContextHint: "Spent during an enemy counterattack to negate one attacker's damage (max 1 per turn)." },
                "ignore-ability": { image: null, label: "Ignore Ability", spendContextHint: "Reserved (no granter ships today)." },
            });
            export const AP_BOLT_SVG_INNER = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M14 2 L4 13.5 L10.5 13.5 L9.5 22 L20 10.5 L13 10.5 Z"/></svg>';
            export function consumableIconInnerHtml(kind: ConsumableTokenKind, alt?: string): string {
                const meta = CONSUMABLE_TOKEN_DISPLAY[kind];
                const a = (alt ?? meta.label).replace(/"/g, "&quot;");
                if (meta.image) {
                    return `<img src="${meta.image}" alt="${a}" draggable="false" />`;
                }
                return "";
            }
    export function getHero(id: string): HeroCard {
        const h = HEROES.find((x) => x.id === id);
        if (!h) throw new Error(`Unknown hero id: ${id}`);
        return h;
    }
    export function getEquipment(id: string): EquipmentCard { const e = EQUIPMENT.find((x) => x.id === id) ?? UPGRADE_EQUIPMENT.find((x) => x.id === id); if (!e)
        throw new Error(`Unknown equipment id: ${id}`); return e; }
    export function getEnemy(id: string): EnemyCard { const e = ENEMIES.find((x) => x.id === id); if (!e)
        throw new Error(`Unknown enemy id: ${id}`); return e; }
    export function getDelverBoard(suit: Suit): DelverBoardOverlay { const b = DELVER_BOARDS.find((x) => x.suit === suit); if (!b)
        throw new Error(`No delver board overlay for suit: ${suit}`); return b; }
    /** All equipment IDs from a hero's starting loadout, resolved to objects. */
    export function getStartingEquipment(heroId: string): EquipmentCard[] { return getHero(heroId).startingEquipment.map(getEquipment); }
    /** * Per-printed-Hero-Card starting loadout. Keyed by `HeroCardMeta.number` * so the picker (which speaks card numbers, not heroId aliases) can * resolve directly. Source of truth for "what does Hero #N start with?" * — replaces `heroes.json > startingEquipment` for any code path that * has access to `CampaignState.activeHeroCardByDelver`. * * Faithful to the printed Hero Card art * (`ASSETS/Gone to Gaia/Hero Card Front v3 PROOF 1.pdf`): *   - Each card lists 2-3 weapon rows *   - The filled rank dot count is the STARTING rank for that type *     (cards #5 + #6 each print one weapon at 2 filled dots → starts *     at rank 2 in lieu of a third weapon slot) * * Cards #1 + #2 intentionally mirror the legacy `heroes.json` rows * (Mind = Beam r1 / Hammer r1 / Shield r1; Body = Gauntlet r1 / Sword * r1 / Armor r1) so existing campaigns + every pre-existing test * fixture see identical starting state. The printed card #2 art does * show GAUNTLET with 2 filled dots, but we keep r1 here to avoid a * gameplay shift for players who never engage the picker; if you * want strict print fidelity, bump `2.startingRanks.Gauntlet` to 2. * * For cards that print fewer than `weaponSlotsPerSuit` weapon rows, * the missing slots stay at rank 0 — the equipment never appears in * the player's hand. This is the strategic tradeoff: card #5 trades * a third weapon for an upgraded TRIDENT, etc. */
    export interface HeroCardLoadout {
        startingEquipmentIds: string[]; /** Per-equipment-type starting rank for this card. Types absent   *  from this map are NOT owned at quest start (rank 0). */
        startingRanks: Partial<Record<EquipmentType, number>>;
    }
    export const HERO_CARD_LOADOUTS: Readonly<Record<number, HeroCardLoadout>> = Object.freeze({
        1: {
            startingEquipmentIds: ["mind-beam-r1", "mind-hammer-r1", "mind-shield-r1"],
            startingRanks: { Beam: 1, Hammer: 1, Shield: 1 },
        },
        2: {
            startingEquipmentIds: ["body-gauntlet-r1", "body-sword-r1", "body-armor-r1"],
            startingRanks: { Gauntlet: 1, Sword: 1, Armor: 1 },
        },
        3: {
            startingEquipmentIds: ["mind-shockwave-r1", "mind-sword-r1", "mind-supercharger-r1"],
            startingRanks: { Shockwave: 1, Sword: 1, Supercharger: 1 },
        },
        4: {
            startingEquipmentIds: ["body-trident-r1", "body-mace-r1", "body-battery-r1"],
            startingRanks: { Trident: 1, Mace: 1, Battery: 1 },
        },
        5: {
            startingEquipmentIds: ["mind-trident-r1", "mind-mace-r1"],
            startingRanks: { Trident: 2, Mace: 1 },
        },
        6: {
            startingEquipmentIds: ["body-shockwave-r1", "body-beam-r1"],
            startingRanks: { Shockwave: 2, Beam: 1 },
        },
        // #7 / #8 (Ch3 recruits) — from the Game Materials workbook's
        // Hero Fronts sheet; card art is a placeholder until it's ready.
        7: {
            startingEquipmentIds: ["mind-shockwave-r1", "mind-sword-r1", "mind-harvester-r1"],
            startingRanks: { Shockwave: 1, Sword: 1, Harvester: 1 },
        },
        8: {
            startingEquipmentIds: ["body-trident-r1", "body-hammer-r1", "body-os-r1"],
            startingRanks: { Trident: 1, Hammer: 1, OS: 1 },
        },
        // #9 / #10 (Ch4 recruits) — printed on the prototype hero cards.
        9: {
            startingEquipmentIds: ["mind-mace-r1", "mind-gauntlet-r1", "mind-supercharger-r1"],
            startingRanks: { Mace: 2, Gauntlet: 1, Supercharger: 1 },
        },
        10: {
            startingEquipmentIds: ["body-sword-r1", "body-hammer-r1", "body-boots-r1"],
            startingRanks: { Sword: 2, Hammer: 1, Boots: 1 },
        },
    });
    export function getActiveHeroCardNumber(state: CampaignState, heroId: string): number {
        const picked = state.activeHeroCardByDelver[heroId];
        if (typeof picked === "number") return picked;
        return getHero(heroId).number;
    }
    /** Per-hero-card starting equipment, resolved to card objects. *  Drop-in replacement for `getStartingEquipment(heroId)` in any *  code path that has access to `CampaignState`. */
    export function getActiveHeroCardStartingEquipment(state: CampaignState, heroId: string): EquipmentCard[] { const n = getActiveHeroCardNumber(state, heroId); const loadout = HERO_CARD_LOADOUTS[n]; if (!loadout) {
        throw new Error(`getActiveHeroCardStartingEquipment: no HERO_CARD_LOADOUTS entry for card #${n} (heroId=${heroId})`);
    } return loadout.startingEquipmentIds.map(getEquipment); }
    /** Per-hero-card starting rank map. Types not in the picked card's *  loadout stay at 0 (= not owned). Used by `state.ts > *  newEquipmentRanksForActiveCard` to re-seed `state.equipmentRanks` *  when a wave or quest starts under a freshly-picked card. */
    export function getActiveHeroCardStartingRanks(state: CampaignState, heroId: string): Readonly<Partial<Record<EquipmentType, number>>> { const n = getActiveHeroCardNumber(state, heroId); const loadout = HERO_CARD_LOADOUTS[n]; if (!loadout) {
        throw new Error(`getActiveHeroCardStartingRanks: no HERO_CARD_LOADOUTS entry for card #${n} (heroId=${heroId})`);
    } return loadout.startingRanks; }
    /** * Look up the canonical R1 EquipmentCard for a (suit, type) pair. * Throws if no matching entry exists in `data/equipment.json` — every * (suit, type) pair MUST have an R1 card present (28 total entries). * * Loadouts only ever store R1 ids; the actual rank is read from * `state.equipmentRanks`. The image shown to the player is derived * via `imageForRank` so they see the correct rank-N art. */
    export function getEquipmentByTypeSuit(suit: Suit, type: EquipmentType): EquipmentCard { const e = EQUIPMENT.find((x) => x.suit === suit && x.type === type && x.rank === 1); if (!e)
        throw new Error(`No R1 equipment for suit=${suit} type=${type}`); return e; }
    /** * Returns the equipment card for the given suit/type at the specified rank. * Falls back to R1 if no card exists at that rank. */
    export function getEquipmentByTypeSuitRank(suit: Suit, type: EquipmentType, rank: number): EquipmentCard { const e = EQUIPMENT.find((x) => x.suit === suit && x.type === type && x.rank === rank); if (e)
        return e; return getEquipmentByTypeSuit(suit, type); }
    /** * Image filename inside `public/cards/` for the given (suit, type, rank). * Convention: `card_{suit}_{type-lower}_r{rank}.jpg` — matches the output * of `tools/pdf-extract/batch_equipment.mjs`. Used by Hand / SuitPanel / * level-up modal to show the rank-correct art for a card the player owns. */
    export function imageForRank(suit: Suit, type: EquipmentType, rank: number): string { return `card_${suit}_${type.toLowerCase()}_r${rank}.jpg`; }
