# G2G — Gone to Gaia (Quest #1 Playtest Prototype)

Hot-seat 2-player digital recreation of **Gone to Gaia, Quest #1: Reach the Buoy**, intended for designer-side playtesting without a printed copy.

## Quick start

```bash
cd games/G2G
npm install      # already done if you cloned with deps
npm run dev      # then open http://localhost:5173
```

## Build / preview

```bash
npm run build         # type-check + Vite production build into dist/
npm run preview       # serve the production build
npm run build:single  # single-file HTML build into dist-single/
```

## Packaging the portable .exe

```bash
npm run package:exe   # tsc + vite build (mode=portable) + electron-builder
```

The packaged `release/GonetoGaia.exe` is a single-file portable Windows
build (no installer, double-click to run).

### Fresh-state-on-build (don't break this)

Every `npm run package:exe` injects a unique build ID into the bundle
(`__G2G_BUILD_ID__ = "exe-<timestamp>"`) via Vite's `define`. On boot,
`src/build/buildIdGuard.ts` compares the bundled ID against one stored
in localStorage and clears `g2g.campaign.v20` + `g2g.sessionLog.v1`
on mismatch, so every freshly-distributed .exe starts the recipient on
a clean campaign.

After the first launch the new build ID is recorded, so subsequent
launches of the SAME .exe keep the player's save (cross-session
progress works as expected).

Dev (`vite`) and the regular `npm run build` (Cloudflare web deploy)
keep the constant `__G2G_BUILD_ID__ = "dev"` so HMR reloads and live
deploys never wipe a player's browser save.

The gate is `mode === "portable"` inside `vite.config.ts` — if you
ever rename the mode or split the script, also update the guard or web
deploys will start wiping saves on every push. See `vite.config.ts`
header comment for the contract.

## Project layout

```
games/G2G/
├─ index.html
├─ data/                    # hand-editable game data (the source of truth)
│  ├─ heroes.json           # Hero #01 (Mind), Hero #02 (Body)
│  ├─ equipment.json        # 6 starting equipment cards
│  ├─ enemies.json          # Crystanid 001-007 + Soulhunter 001
│  ├─ quest1.json           # Quest #1 spawn + narrative
│  ├─ elements.json         # 6 element types
│  └─ delverBoards.json     # slot abilities + UI overlay coords (placeholder)
├─ public/                  # static assets shipped 1:1 to /
│  ├─ board/tide.jpg        # Quest board background
│  ├─ suits/{mind,body}.jpg # Delver suit board backgrounds
│  ├─ xp/track.jpg          # XP/Level track background
│  ├─ cards/                # Extracted equipment + enemy + storybook page JPGs
│  └─ tokens/               # Token images
├─ src/
│  ├─ main.ts               # Entry + screen router
│  ├─ types.ts              # Canonical TypeScript types for all data
│  ├─ data.ts               # JSON imports + lookup helpers
│  ├─ state.ts              # CampaignState + localStorage persistence
│  ├─ styles.css            # All CSS
│  └─ screens/
│     ├─ Title.ts           # Landing
│     └─ DataViewer.ts      # Stage 1 verification screen (debug)
└─ vite.config.ts
```

## Where source data came from

All gameplay data was extracted from rulebook PDFs in `ASSETS/Gone to Gaia/`. The PDF text was read directly; image-only diagrams (spawn layout, weapon range patterns, enemy counter arrows) were extracted as JPGs with `tools/pdf-extract/extract.mjs` (Node + `pdfjs-dist` + `@napi-rs/canvas`) and visually decoded into `data/*.json`.

Re-extract a page like this:

```bash
cd tools/pdf-extract
node extract.mjs "../../ASSETS/Gone to Gaia/Gone to Gaia - Storybook - Chapter 1 PROOF 4.pdf" 4 out.jpg 4
```

## Stage progress

- [x] **Stage 0** — Vite + TS scaffold, builds clean
- [x] **Stage 1** — Data layer + DataViewer (verify all extracted gameplay values against printed cards in the browser)
- [x] **Stage 2** — Tide Board with `tide.jpg` background + Quest #1 spawn rendered
- [x] **Stage 3** — Two Delver Panels with suit JPG backgrounds + click-to-play card into slot
- [x] **Stage 4** — Hero Phase mechanics (movement, action, damage, counter-attack)
- [x] **Stage 5** — Parting Shots, End Wave (was Interlude + End of Wave), End-of-Wave routing
- [x] **Stage 6** — CampaignState + persistence + Campaign Sheet
- [x] **Stage 7** — Story polish + level-up-cards-owed bookkeeping
- [x] **Stage 8** — Equipment ranks + interactive Level Up draw flow (28 base level cards, +1 RANK pick-1-of-3 modal)
- [x] **Chapter 3 Town Visit** — `data/chapter3.json` ("The Memorial Festival"), reached from the end of Chapter 2 (or **Continue → Chapter 3** on Title for saves that already finished Ch2). Quests #3/#5/#6 aren't playable yet, so the chapter opens with a **Quest Report** page where players record which quests they completed at the table (2 max, tracked with Story tokens). See "Chapter 3 notes" below.

### Wave structure and token rules (designer decisions 2026-11-17, state v65)

- **3 phases per wave: Delver (Hero) Phase → Parting Shots → End Wave.** The Interlude Phase is gone (Nov 15 player aid). The last parting shot goes straight to the End of Wave screen.
- **End Wave refresh, every wave end (defeat too):** weapons back to hand, AP refilled, spent consumables refreshed, and **Harvester** pays its living bearers. It runs inside `enterEndOfWave` and is stored on `encounter.endWaveRefresh` (that's also the latch); every End of Wave screen shows it in an "End Wave" card.
- **Only when continuing to the next wave:** Elayna / Rodrigo Detractor / Nemesis penalties, Armor heals, then the Elemental OS (both delvers) and Sol / Lunar Shield (bearer) element picks, which open on the next wave's board. All "Continue → Wave N" paths call `wave.ts > bootstrapNextWave`, which builds the wave and applies these; the lines show in the rewards popup (`RewardEvent` kind `wave-effect`).
- **Block Counterattack** is the new name for the Prevent Counter token everywhere players see it (the internal id stays `prevent-counterattack` so saves keep working). It cancels one enemy's counterattack **completely**: no damage, no Rotates / Alert / Flees / Accurate / Strength / Teleports / Shell. Engine: `combat.ts > blockCounterattack`.
- **No per-turn cap on Reroll or Block Counterattack** (either delver, any time, as many as they hold). Double Damage keeps its 1-per-turn cap.
- Card text in `data/equipment.json` / `equipmentUpgrades.json` now says "at the end of each wave" (Nov 15 wording); effect kinds are `heal-at-end-of-wave`, `gain-element-at-end-of-wave`, `gain-tokens-at-end-of-wave`.
- Saves: `migrateV64ToV65` moves a wave saved mid-Interlude onto the Parting Shots "Continue" beat without refreshing twice. Tests: `endWaveMigration.test.ts`, `wave.test.ts`, `harvester.test.ts`, `os.test.ts`, `ch4Quests.test.ts` (Block), `battery.test.ts` (no cap). Details: DESIGN.md §4.2 and §5.5.2.

### Opinion card effects (Nov 15 cards, state v60)

The effects were updated to match the Nov 15 prototype PDF. The art for these cards is the PDF version too.

- **Samantha Ally ("Popular")**: the next opinion loss doesn't happen. It fires automatically on any negative `shift-favour`, including from scenario cards. This used to be Vera Ally's effect.
- **Vera Ally ("Gift")**: in the Shop's favors panel, choose a delver to gain 1 Lvl 2 boss part.
- **Elayna Ally ("Med Kit")**: the BoardScreen top-bar button heals both delvers to full. Downed delvers are not revived; that's Shop #55's job.
- **Rodrigo Ally ("Elemental Kit")**: the BoardScreen top-bar button refreshes every spent consumable token. This used to be Elayna Ally's effect.
- The old Samantha Ally boss-part discount is gone. v60 drops its `samanthaDiscountActive` latch.
- Elayna's character id stays `elayne` so saves keep working; every string players see says "Elayna".

### Opinion cards: one per character, every printed effect (state v62)

- **One card per character** (rulebook p27: "If players already have an Opinion Card for that character, return the previous card to the box"). After any opinion change you hold only the card for the new level; Neutral has none. A returned card's redeemed flag is cleared, so a later card of that level comes back fresh. v62 collapses older saves (which kept every card) to the card matching each current opinion.
- `src/engine/opinionEffects.ts` holds every ongoing rule. `holdsOpinionCard` = owned and not discarded.
  - **Shop:** Ira Confidant -1 / Ally -1 for one visit (Shop favor) / Detractor +1 / Nemesis +2 minion parts on everything; Flores Detractor +1 / Nemesis +2 on the Equipment Market; Samantha Nemesis blocks the Machinist; Flores Confidant lets missing boss parts be paid with 3 minion parts per level (`planShopPayment`, used by both Buy and the Shop's button states via `shopPurchaseError`). Price changes show as pills on the product.
  - **End Wave, when continuing to the next wave** (the cards say "start of each Interlude"): Elayna Detractor - each delver loses 2 elements (the prototype takes them from the largest stacks); Nemesis - all. Rodrigo Detractor - 2 XP on hand; Nemesis - all. Shown in the Interlude summary.
  - **Quest start:** Xavier Nemesis - each delver one rank down (same pick flow as his other cards). Dahlia Confidant - both delvers +1 Universal 2x Damage and +1 Block Counterattack token. Dahlia Ally - each delver +1 token of their choice (picked in the Shop; Reroll when the card is first taken). Re-granted after a wave retry.
  - **Memory Chips:** every gain goes through `gainMemoryChips`; Elias Nemesis blocks them. Elias Detractor loses 1 chip the moment it's taken. Elias Ally / Confidant: Shop favor, pay 3 minion parts for 1 chip.
  - **Arlen:** Detractor / Nemesis cap Ally + Confidant cards at 2 / 1 - a card over the cap isn't taken (rewards modal says so). Confidant: Academy donations always resolve at the best tier; Ally: the next one does, then it's discarded. ("Best equipment result" is read as the top donation tier.)
  - **Confidant one-shots:** Elayna (Med Kit), Rodrigo (Elemental Kit) and Samantha (Popular) Confidant cards print the same effect as their Ally cards and use the same buttons / shield.
- **Not in the prototype yet:** Dahlia Detractor / Nemesis add Lieutenants to every wave; there are no Lieutenant enemies in the game, so the Campaign Sheet marks them "apply at the table". The "Go on a date (Dating Sim Expansion)" option on Confidant cards isn't offered.

### "Did any delver die?" pages pick the branch themselves

The Ch2/Ch3/Ch4 Town Visit arrival pages ("Both delvers survived" / "One or both delvers died") and their "The Fallen" follow-ups (Mind / Body / both) no longer ask. Each choice has `requireQuestDeaths` (`none` / `any` / `mind-only` / `body-only` / `both`), and only the button matching the last quest shows, under the page's normal text. The record is `state.lastQuestDeaths` (schema **v64**): `enterEndOfWave` adds every 0-HP delver on a defeat, a quest's first fresh wave build starts a new record (`beginQuestDeathRecord`; a wave retry keeps the open one), and `endQuestReset` marks it ended. `null` (fresh campaign or a pre-v64 save) shows every option. Engine: `lastQuestDeathOutcome` / `questDeathsMatch` in `engine/townVisit.ts`; tests in `questDeaths.test.ts`. This replaces the old graveyard-based `requireGraveyardDeaths`, which missed deaths on card-loss-exempt waves and couldn't say "nobody died".

### End of a chapter: continue or stop for now

The last Town Visit page of Chapters 1-3 (`kind: "end-town-visit"`) offers two buttons: **Continue** (Quest 2 intro / Chapter 3 / Chapter 4) and **Stop for now**. Both run `finishTownVisit`. Stop for now then returns to Title, whose main button already resumes from that state ("Continue → Quest 2 Intro" / "→ Chapter 3" / "→ Chapter 4"). Chapter 4 is the last chapter, so it keeps its end overlay (download progress + return to title). Code: `TownVisit.ts`, the end-town-visit branch.

### Chapter 3 notes

- **Engine additions** (all data-driven from the chapter JSON):
  - New Town Visit actions: `if` (conditions: decision made, quest completed, favour, clue count, owns opinion card, open quests), `complete-quest`, `grant-boss-parts`, `discard-opinion-card`, `reveal-first-unowned-quest`, `grant-shop-product`, `place-scenario-card-on-top`, and `grant-minion-parts-per-open-quest`.
  - New choice gates: `requireDecision`, `requireKeyItemAny`, `requireQuestRevealed`, `requireOpenQuests`.
  - Pages can declare `dieRoll` brackets, which render a "Roll a die" button.
- **State v59:** `completedQuests` (Open Quests = revealed minus completed), `scenarioDeckTop`, `townVisit3Completed`, and `academyDonationLifetime`. Ch3's Experimental Division tiers read the **running** donation total (6 / 13 / 22) and grant OS + Supercharger ranks.
- **Shop:** products can now cost Level 3 boss parts (`cost.bossLvl3`, e.g. #43 Sword of Ruin).
- **Card art for Chapters 3–4** comes from the prototype materials PDF (`Game Materials/Game Materials - All - Nov 15.pdf`):
  - `python -I scripts/extractGameMaterials.py <pdf> <outdir>` crops every card and writes `index.json`.
  - `python -I scripts/applyGameMaterials.py <outdir> . <quest-fix outdir>` copies the Ch3/4 cards into `public/` (key items, shop, heroes, scenarios, opinion cards). Quest fronts #4, #6, #7 and #13 come from `Game Materials/Quest Cards - Nov 15 fixed.pdf` (extract it the same way); #6 uses the prototype card because its title and location changed.
  - Key item #22 has no PDF card; `public/key-items/key-item-22.jpg` is an unused leftover placeholder.
- **Not automated yet:**
  - Machinist upgrades #36, #39, #40 and #43 have `grants: []`; their Equipment Upgrade cards aren't digitised.
  - #20's ongoing element rule isn't applied automatically.
  - `scenarioDeckTop` is used by Quest #6 Wave 2's Scenario draw. Story-placed cards come first, then the printed deck in order.

### Chapter 3 quests

- **All three Chapter 3 quests are playable from the Quest Report** ("Play Quest #03 / #05 / #06"). The Town Visit waits on the Quest Report while a quest runs, and you return there when it ends (complete, retreated or defeated).
- **Quest #3 "Xavier's Request" (Waves 1-5):**
  - Wave 1: Tidal Cerberus and Fleetfoots, all with Flees.
  - Wave 2: the Carnatia (Soothsayer, Synchronized) and Colibrius (Synchronized). Slaying the Carnatia fires entry 3.4 mid-wave through `wave.onBossSlain` (quest complete, Level 2 boss parts, Key Item #12, Xavier +1).
  - Wave 3: Empress Ash (All-Claw, Death Heal) and Tidegazers (Death Heal). Both Continue and Retreat put Scenario D (Open Hand) on top of the Scenario deck.
  - Wave 4: Golem (Accurate, Guards 2) and Orites (Guards 1). Wave 5: the Gaia wave (below).
- **Quest #6 "The Forgotten Vault" (Waves 1-5):** Waves 1-2 as before (Wave 2 completes the quest either way and adds #43). Wave 3: Abomination and Blackguards (Immunity). Wave 4: Golem and Orites. Wave 5: the Gaia wave.
- **The Gaia wave** (book page 206, Wave 5 of Quests #3 and #6): Timber Fiend and Saplings (Countdown, Tough). Surviving it shows a picker: choose 2 of Shop Products #32-45 (`pickShopProducts` on the eow option). Products already for sale or owned can't be picked; each pick that can't be made becomes a Memory Chip token. The book's Simple Town Visit afterwards is covered by returning to the Chapter 3 Quest Report.
- **Quest #5 "The Rogue Delver" (Waves 1-3):** Bob the Spider + Diamonids (Vicious), Mindslayer + Squiddies (Alert), Oblivionwing + Nightswipers (Critical, Frenzy). Wave 3 grants Key Item #11 and completes the quest.
- **Late-wave abilities** (rule text in `EnemyAbilitiesModal.ts`, engine in `combat.ts`):
  - Immunity (by the attack's damage type, now carried on `AttackSession.damageType`), Guards (`EnemyInstance.guardTokens`), Tough (round down to 5), Vicious (`viciousToken`, at most 1 damage; lost when an adjacent delver is hurt, including self-damage to power an attack), Stout. All in `incomingAttackDamage`.
  - Accurate: `EncounterState.accurateMarks[boss] = heroId`. The marked attacker is always hit by that boss's counter.
  - Critical: a rolled 5 doubles that enemy's counter damage.
  - Alert: after its counter it turns its north edge (the icon) to the attacker; on a diagonal it turns the shorter way.
  - Countdown (`EncounterState.countdownTokens`, shown in the board top bar) and Frenzy add extra counterattackers. **Prototype simplification:** they join the attack's shared counter roll as `bonus` participants instead of rolling a second die (confirmed by the user 2026-11-15).
  - Every counter preview and resolver goes through `computeCounterStrikes`, so Accurate / Critical / weapon blocks stay in sync on the shield and no-shield paths.
  - Guards / Vicious / Accurate tokens show as small badges on the enemy card.
- **Boss card backs** (between-wave "improve one suit part" step): every Level 2+ Ch3 boss uses its PDF back (Gerald, Carnatia, Empress Ash, Golem, Abomination, Timber Fiend, Mindslayer, Oblivionwing). The first printed line (blue icon) is the Mind delver, the second the Body delver. Level 1 bosses only lead Wave 1 and print no Suit Condition line. `bossCardBacks.test.ts` checks every later-wave Level 2+ boss has one.
- **2-card bosses (Oblivionwing):** the 2/2 card is its own enemy card with `partOf` set, spawned east of the 1/2 card as instance `boss-part` with `linkedTo: "boss"`. If the 2/2 can't fit east of the printed tile, the boss moves to the nearest tile where both fit, and minions are moved off. Damage to either card lands on the 1/2 card (the 2/2 mirrors its damage). Both cards counterattack with their own arrows whenever either is attacked. Both are removed when it dies, and only the 1/2 card gives rewards and a parting shot. Boots can't move or rotate either card. This ruling isn't in the rulebook; confirmed by the user 2026-11-15.
- **Boss parts Lvl 4 / Lvl 5 (state v61):** `bossPartsLvl4` / `bossPartsLvl5` wallets for the Golem / Timber Fiend drops. Use `bossWallet(state, level)` for any per-level access. Shop costs support `bossLvl4` (#30, #38, #45). Token art for both levels is cropped from the PDF (`public/tokens/boss-lvl-{4,5}-{mind,body}.webp`).
- **Shop products #33, #35-40, #42-45** (Machinist upgrades) are in `shopProducts.json` with PDF art and real `equipment-upgrade` grants. See "Equipment upgrades" below.
- **Data-driven End of Wave:**
  - Ch3+ quest waves declare `eow` in their quest JSON: a defeat page plus victory options. Each option has its page, campaign `rewards` (Town Visit actions), `carryEffects` (scenario effects applied to the next wave) and `then: next-wave | end-quest`. `WavePhases.renderGenericEndOfWave` renders it.
  - `scenarioCardDraw: true` draws from the Scenario deck at wave start.
- **Enemies:**
  - `scripts/importEnemiesFromWorkbook.py` imports enemy cards from the Game Materials workbook (stats, parting shots, on-death effects, and counter arrows: Blue = common, Red = uncommon; on the printed cards these are purple and green). Card art is copied from the prototype PDF crops; each `SPEC` entry names its crop as `card=(page, index)`. Usage: `python -I scripts/importEnemiesFromWorkbook.py . <workbook.xlsx> <extractGameMaterials outdir>`. "Hard" enemy variants in the PDF are intentionally not supported.
  - The book's "Snatcher" is the game's existing **Ophidian** card (identical stats).
- **New abilities:**
  - `strength` (Joyce the Bear) and `stout` (Gerald the Snake).
  - `flees`: automatic, to the free tile farthest from the attacker, up to 2 steps.
  - `synchronized`: every enemy in the 8-adjacent chain joins the shared counter roll.
  - `soothsayer`: a wave ending with the boss alive becomes a defeat with both delvers at 0 HP.
  - `all-claw`: on a roll of 1 this enemy fires both arrow sets. `counterOffsetsFor` accepts "miss" for this, and every miss guard checks `anyAllClaw`.
  - `death-heal`: an enemy killed in an attack fully heals its 8-adjacent survivors, except those that died in the same attack. It's applied in `finalizeAttackSession`.
- `scripts/buildChapter3.py` generates `data/chapter3.json`. Edit the script, not the JSON.

### Equipment upgrades (Machinist, Shop #33-45)

- **Data:** `scripts/buildEquipmentUpgrades.py <root> <crops>` generates `data/equipmentUpgrades.json` (11 families x 5 ranks, card numbers 156-210; it leaves the older Shock Gauntlet / Cyclone Boots / Earth's Embrace Shield entries alone) and copies the art to `public/cards/equipment-upgrade-NNN.png`. Edit the script, not the JSON. Buying a product sets `state.equipmentVariants[hero][Type] = family` (`UPGRADE_FAMILY_BY_PRODUCT` in `data.ts`).
- **One lookup:** `getEquipmentCardFor(state, hero, type, rank)` returns the variant card when one is set. The hand and slots still store the standard R1 id. For a placed weapon use `getPlayedWeaponCard(state, hero, placedCardId)` (state.ts): it gives the rank- and variant-correct card for names, art, ranges, effects and targeting. The slot art and tooltip, the action menu, the auto-refresh toast, the targeting overlay and banner, and the engine's Mace filter check all use it.
- **Passives** (`upgradePassives.test.ts`): Living Armor heals on Level cards (`kills.ts > applyLevelCardHeals`); Ion Battery / Overcharger "choose 1" use pick-only roll tables (`tokens.ts`); New Harvester grants a boss part of the rank's level at the interlude; Ancient OS reuses the existing OS effects; Overcharger's Ongoing "spend 2 Water to increase your base damage" is a set of top-bar "LIGHT 2 / MEDIUM 4 / HEAVY 8" buttons (`engine/overcharger.ts`): a spend raises that type to its upgraded value on the Delversuit damage track for the rest of the quest, unless already increased - the same per-quest `shopDamageBonus` the "+1 LIGHT / +2 MEDIUM / +4 HEAVY" shop products set, so the board's damage cube moves to the upgraded diamond (designer ruling).
- **Weapons** (`upgradeWeapons.test.ts`, UI in `ActionResolution.ts`):
  - Engulfing Beam: hits every enemy in the chosen line (`firstTargetOnly: false`). Fire spends: LIGHT to all enemies (extra hits; Double Damage doesn't double them) and/or block counterattacks.
  - Precise Shockwave: `choose-targets` range. Tap enemies within 2 tiles (they get `.board-target--chosen`), then "Fire (N)" in the banner. Radiance spend: extra HEAVY on 1 adjacent enemy, picked by compass direction in the spend prompt.
  - Fabled Hammer: `between-delvers` range, no target pick. The action menu disables it when the delvers aren't lined up.
  - Sword of Ruin: a kill gains 1 Wind; 2 Wind adds HEAVY.
  - War Mace: HEAVY on a boss; LIGHT + 1 element choice on a minion. It has no UNDAMAGED filter (unlike the standard Mace).
  - Lunar Trident: 2 Void rolls a die that multiplies the damage. The die is rolled and shown before targeting and stays fixed for the rest of the turn, so backing out can't reroll it.
  - Spend options ("Spend N element: ...") open the `weapon-spend-pick` modal first when any is affordable. The picks ride along in `pendingWeaponSpend` to `dispatchWeaponAbility` (`UseWeaponAbilityOptions.spends / extraTarget / dieMultiplierRoll`).
- **Rulings confirmed by the user (2026-11-15):** Overcharger's Immediately gives two 2x damage tokens and its Ongoing spend raises one base damage to its upgraded value for the quest; Engulfing Beam's "LIGHT to all enemies" are extra hits that Double Damage doesn't double. Still open: shop #40 is named "Precise Grenade" but its cards say "Precise Shockwave".

### Chapter 4 (Town Visit + "Assault on Bird's Nest")

- **Data:** `scripts/buildChapter4.py` generates `data/chapter4.json` (edit the script, not the JSON). It's reached from the end of Ch3 ("Continue to Chapter 4") or from Title ("Continue -> Chapter 4"). State v63: `townVisit4Completed`, `assaultBonuses`, and per-encounter `omenTokens`, `rebirthTiles`, `enemyDiedThisHeroTurn`, `combatOnlyTokens`.
- **Quest Report:** Quests #3, #4, #5, #6, #7 and #13 are playable from both the Ch3 and Ch4 Quest Reports (shared pages in `scripts/questPages.py`).
- **Must attempt a Quest first (general rule):** the "Into the Tide" intro page shows the playable Quests as card buttons (`image` on a Town Visit choice switches the row to a card grid) and has no way to the Town Visit; "Continue to the Town Visit" is only on the Quest Report page you return to after a Quest (complete, retreated or defeated). Generated by `report_choices` in `scripts/questPages.py`; tests: `questReport.test.ts`.
- **Town Square (page kind `townsfolk-assignment`, `screens/TownsfolkAssignment.ts`, `engine/townsfolk.ts`):** assign Sam, Rodrigo, Elayna, Xavier, Arlen and Bram to Put out the fire / Dig out survivors / Administer first aid / Assist with combat. Each townsfolk scores 2 with the action's talent, 0 with its weakness, 1 otherwise; the first three actions shift Arlen / Rodrigo / Samantha's opinion. Townsfolk on combat give the chosen delver a reward for the Assault only. **Ruling:** the book pairs rewards by bonus type (Sam Offensive = 2 Universal 2x Damage, Elayna Defensive = 2 Block Counterattack); the four Utility rewards go Xavier = 3 elements, Rodrigo = 4 Rerolls, Arlen = 2 Level cards, Bram = 2 AP. Unused tokens and extra AP are removed when the Assault ends (`clear-combat-only-grants`); elements and Level cards stay.
- **Story quest "Assault on Bird's Nest"** (`data/questAssault.json`, id `assault`, one wave): Mistspawn (#104) + 7 Infestations (#105-111), imported from the workbook. The book prints no layout, so it uses the base Spawn Deck. Victory records `ch4.assault.won` -> X.1, any death records `ch4.assault.lost` -> X.2; both continue the visit with 4 Story tokens. Non-numbered quests display their name (`questDisplayLabel`).
- **New abilities** (`engine/omenRebirth.ts`): Omen (a delver hit by an Omen enemy gains a token; +1 damage per token to every later damage this wave, via `damageDelverInWave`, which every in-wave HP loss now goes through) and Rebirth (3 tokens on the death tile; after each hero turn with no kills, remove 1; at 0 one enemy that died there respawns with 50% health; **ruling:** an occupied tile waits until it's clear). Omen counts show in the board top bar; Rebirth counts show as red discs on tiles.
- **Other engine additions:** `shift-favour` `trackOnly` (Master Bram has no printed opinion cards), choice gate `showIfDecision`, condition `owns-key-item`, `grant-shop-product` to a specific delver, `onlySuit` on shop products (#23 Mind / #24 Body), Ch4 donation schedule (running total 11 / 21 / 35: Armor + Boots, then +2 of your choice).
- **Shop:** #21 (Gauntlet + Battery), #22 (Hammer + Shield), #25 (Shockwave + Supercharger) grant +1 rank in both types; #26, #46, #47 give a Universal 2x Damage token at quest start. #23 Shimmering / #24 Volcanic Delversuits are purchasable but **not automated** (the flipped Delversuit boards aren't built).
- **Heroes #9 / #10** (unlocked at the Ch4 arrival): Mind = Mace 2 / Gauntlet 1 / Supercharger 1; Body = Sword 2 / Hammer 1 / Boots 1. Art via `applyGameMaterials.py`.
- **Memory Fragments #1-10** are an ordered deck: each chip draws the next card, stopping after #10 (unspent chips stay on hand). #3-#10 are placeholder cards from `scripts/buildMemoryFragments.py <extract outdir> .`: #6-#10 are the prototype PDF cards (fronts p45, backs p46), #3-#5 are drawn in the same layout from the workbook text ("Art not ready yet") until the art lands. The draw shows each card's front and back. #2's old graphic-design card printed a different effect, so #2 also uses the prototype card.
- **Witness ability** (`engine/witnessAbility.ts`, top-bar "Witness: N damage / heal M" buttons): the backs of #2-#10 give "once per quest, free action: Witness deals N damage to adjacent enemies OR heals M HP to adjacent delvers"; the best fragment drawn sets N/M (#2 2/-, #3-4 2/1, #5-6 4/2, #7 6/3, #8 8/4, #9-10 10/5). `state.witnessAbilityUsed` resets when a quest starts or ends. **Rulings (confirmed by the user 2026-11-15):** Witness's damage is not a delver attack (no counterattack, ignores Evasive / Immunity / Guards / Shell etc.; Fatal Flaw still applies); kills give normal rewards; healing reaches delvers on Witness's tile too. The "Gain Quest #N" rewards (#1, #4, #6, #10) aren't applied - those quests aren't built.
- **Damage track:** a damage bonus (shop "+1 LIGHT / +2 MEDIUM / +4 HEAVY" or Overcharger) raises the BASE value, so weapon damage is `multiplier x (base + bonus)` - a 2x LIGHT card deals 4 once LIGHT is raised to 2.
- **Not done yet:** the flipped Delversuits #23/#24 (skipped until their assets are ready - user decision); Quests #8 / #9 (revealed by Quest #7's Secret Town Visit, not playable); Memory Fragment "Gain Quest #N" rewards (Quests #9-#12 aren't built).

### Chapter 4 quests (#4, #7, #13)

- **Data:** `scripts/buildCh4Quests.py` generates `data/quest4.json`, `quest7.json` and `quest13.json` from the book (edit the script). New enemies (cards #112-142: Hugh, Emberwings, Arnold, Ruined Tidekin, Exanimates, Spike, Anna, Winona, Billy, Laura, George, Incomplete Revenant, Experiments) come from the workbook via `importEnemiesFromWorkbook.py`; Venena, Snatcher (= Ophidian), Squiddy, Tidegazer, Colibrius and Blackguard are reused. Boss card backs for the seven Level 2+ bosses are PDF crops.
- **Quest #4:** W1 Hugh + Emberwings; its End of Wave flattens 4.2's two choices into "attack the creatures" (Wave 2) and "pass without disturbing them" (`nextWaveNumber: 3`, skips Wave 2 with the 4.5 element reward). W3 slaying the Ruined Tidekin fires 4.7 mid-wave (quest complete, Lvl 3 boss parts, Key Item #14, Dahlia +1).
- **Quest #7:** surviving Wave 3 records `quest.7.reached-high-nest`; back in town the Quest #07 Conclusion runs: the Elias conversation (a hidden dial, `storyCounters["q7.elias-dial"]`; 4+ = trusted), quest complete + Key Item #7, then (trusted only) the Secret Town Visit: hideout dinner, Quest #8 or #9 + Key Item #13, and Elias' Scavenge Shop (`open-scavenge-shop` / `close-scavenge-shop`: #32-45 that nobody owns, this visit only). Re-entering a conversation node doesn't re-apply its dial change (town pages run `onEnter` once).
- **Quest #13:** four waves ending with Key Item #20 and quest complete.
- **New abilities** (`engine/questAbilities.ts` + hooks in `combat.ts`, `turn.ts`, `kills.ts`; rule text in `EnemyAbilitiesModal.ts`; board badges I / S / C / W): Backup, Evasive, Hardy, Steals, Spiked, Invulnerable, Last Act, Ritual (sacrifice modal `ritual-pick`; ranks come back when Winona dies), Double Edged, Soul Sap, Brawler, Corruption (ticks at the end of every hero turn), Shell. **Rulings:** Backup's extra counterattackers are the 2 living enemies nearest the attacker; Brawler's "melee" = attacker adjacent; Shell's "miss" = none of its arrows hit; Double Edged checks whether a delver stands on its black-arrow tiles; Steals keeps the stolen card in its slot (so it is exhausted and can't be refreshed) - "can't be ranked up" isn't enforced.

## Undo movement

Once the active delver has stepped this turn, an **UNDO MOVEMENT** button floats at the bottom of the board until End Turn. It puts the delver back where this turn's movement started (MP, picked-up parts and tile drops restored), and the delver can move again. It is greyed out (tap it to see why) once anything besides steps happened after moving: an action, an AP spend (e.g. AP-double movement), a card placed after moving (use Undo placement first), or a step that revealed a Friendly Encounter or collected a Memory Fragment. The End Turn "moved without playing a card" prompt follows the same rule and offers "End turn anyway" when undo is blocked. Engine: `movementUndoBlockedReason` / `undoMovementThisTurn` in `src/engine/movement.ts`; tests in `movement.test.ts`.

## Enemy ability labels

When an enemy ability changes what would normally happen, its name floats over that enemy's tile for about 2 seconds (purple pill, stacked if several fire on one tile), so players can see why a result differs (e.g. TOUGH when a hit is rounded down, ROTATES after a counterattack, COUNTDOWN when extra enemies counterattack). The engine calls `recordAbilityProc(enemy, kind)` (`src/engine/abilityProcs.ts`, in-memory only, not saved) at the moment an ability takes effect - damage modifiers only when they changed the number, counterattack abilities (Critical, Double-edged, All-Claw, Omen) only where a counter is actually applied, never in previews. `uiState.ts > collectAbilityProcFx` drains it and `BoardScreen > renderAbilityProcFx` draws it in the board FX layer; names come from `enemyAbilityLabel` (`EnemyAbilitiesModal.ts`, the same text as the Enemy Abilities panel). New ability code should call `recordAbilityProc` where it changes the outcome. Tests: `abilityProcs.test.ts`.

## Multiplayer (online co-op groundwork)

Two players, two screens: one plays Mind (`hero-01`), the other plays Body (`hero-02`).

**How to play.** On the title screen, one player taps **HOST GAME** and gets a 4-digit code. The other taps **JOIN GAME** and types the code. When the host taps Start (new campaign), Upload Progress, or a Quick Start Chapter button, they pick **Mind** or **Body**, and the guest gets the other one. Continuing a saved campaign asks only if no role has been picked yet in this session.

**Who can act** (design owner, 2026-11-15). One player acts at a time; `src/net/roles.ts > actingSeat` decides who, in this order:
1. A relayed **Shield prompt** (Sol / Lunar Shield during a counterattack or Parting Shots): the shield bearer's player answers it. The flow owner's client relays the open prompt in the snapshot (`promptJson`). The bearer's client shows it, records the answer and hands it back (cursor past the last bearer). The owner's client then finishes the attack, because it holds the attack session (`ActionResolution.ts > finishShieldPrompt` / `finishPartingShotShieldPrompt`, `isRelayedPromptOwner`).
2. A **queued choice for one delver**: hero-card pick, opinion rank pick, ritual, element pick, equipment / XP roll, suit-condition (rank / boss-card) pick, level-up card, creature part. That delver's player makes it on their own screen (`pendingChoiceOwner`). A queued choice only steers who acts where its prompt is actually shown: the board for most (element picks included), the spawn / first-turn screens for opinion picks, the End of Wave / next-wave start / Town Visit for suit picks. Otherwise a pending level-up could block the End of Wave buttons. While the flow owner is mid-flow (`busy`: an attack or other non-choice modal is open, or an ability is armed), queued choices wait. The player who resolves a choice during the other's flow stops there (`advanceAfterAction` checks `onlineIsActorNow`). The flow owner's client continues once the state arrives: BoardScreen's `REMOTE_APPLIED_EVENT` listener, and the suit-condition picker overlay redraws / finishes the same way.
3. **Turns for each player's own delver** (online only): in a Town Visit shop each player buys for their own delver (host's delver first, then "Done shopping", `townVisit.shopTurn` / `shopDone`), and the Q2 W1 End of Wave element picker works the same way ("Done picking", `encounter.eowPickTurn` / `eowPickDone`; the picks live in `encounter.eowElementPicks` so both screens show them). Controls marked `data-delver-only="hero-0X"` never show for the other player.
4. A wave's **hero phase**: the player whose delver's turn it is.
5. Everything else (story pages, shared choices such as spawn placement / first-turn pick / scenario cards / payer picks, phases, title-screen campaign actions): the **host**.

The watching player sees **"[Mind player is choosing]"** (or Body) as a banner at the top centre, and every game-changing button is hidden (`body.online-watching` rules in `src/net/online.css`). Look-only controls stay (peek, Rules, Enemy Abilities, Shop Products, See Equipment, viewers, Back to title). During the other delver's hero turn, its turn controls stay hidden even while this player answers a choice for their own delver (`body.online-not-my-turn`). If a watcher still manages to change the game, the change is undone and a toast says who is choosing. The status pill shows the code, your role and whether the other player is connected. A guest's title screen only has GO TO GAME, the Campaign Sheet, Download Progress and LEAVE ONLINE GAME. Firebase aborts a push transaction with `"set"` when another write lands mid-way; `pushSnapshot` retries that (up to 3 times).

**Sync model: full-state snapshots.** Each accepted change publishes the whole `CampaignState` (as a JSON string) plus the publisher's game screen (`board` / `story` / `townVisit`) and story page, with a revision number. The other client replaces its copy and redraws. Things kept only in temporary UI state (dice animations, a half-finished attack, open modals) aren't sent; the watcher sees the result once it's saved. Writes are compare-and-set on the revision; if both clients write at once, the loser shows an error and reloads the shared state.

**Reconnect.** Each tab keeps `{code, clientId, seat}` in `sessionStorage` and also in `localStorage` (key `g2g.net.session`). A refresh rejoins automatically and lands on the shared screen. After the browser was closed, the title shows **REJOIN GAME 1234**. That button is refused while the seat is still active in another window (heartbeat newer than 7 s). Sessions last until the host taps END ONLINE GAME. If the host drops, the session stays and the guest sees "disconnected". A guest who leaves (or whose host ends the game) gets their own single-player save back, because guests never write the campaign save on their own device.

**Transports** (`src/net/netConfig.ts > NET_TRANSPORT`):
- `"firebase"` (default): Firebase project `gone-to-gaia`, using the Realtime Database at `/rooms/{code}` with anonymous sign-in. It works between two computers, and also between two tabs. The config is in `FIREBASE_CONFIG`. Firebase web config values are public by design; access is controlled by the database rules below. Implementation: `src/net/firebaseTransport.ts`. Every write that has to be consistent is a transaction. `stateJson` stays a string, because RTDB drops empty arrays and nulls. Presence uses the server clock and `onDisconnect`, so a closed tab shows "disconnected" within a few seconds. Setup errors get a plain message telling you what to fix: "Anonymous sign-in is turned off" or "rules refused access".
- `"local"`: rooms live in `localStorage` (`g2g.net.room.<code>`, presence in `g2g.net.presence.<code>.<clientId>`), with a `BroadcastChannel` to notify other tabs. It only works with two tabs on one computer, but needs no internet. The unit tests use it.

**Firebase console setup** (already done for `gone-to-gaia`):
1. **Security → Authentication → Sign-in method → Anonymous → Enable.**
2. **Databases & Storage → Realtime Database**, created in locked mode.
3. In its **Rules** tab, paste the rules below and publish. They let any signed-in player read and write rooms; tighten them later if needed.
```json
{ "rules": { "rooms": { "$code": { ".read": "auth != null", ".write": "auth != null" } } } }
```

Rooms are never deleted automatically; ended rooms just have `ended: true`. You can clear them from the console now and then. Not tested yet: the packaged Electron `.exe` and the Android build (Firebase over `file://`).

**Code map.** `src/net/types.ts` holds the room model and the `RoomTransport` interface. `roles.ts` decides who may act. `session.ts` is `OnlineSession`, the DOM-free core (authority, publish/apply, rejoin). `onlineController.ts` is the browser glue and router hooks. `onlineHud.ts` and `onlineDialogs.ts` hold the pill, toasts, Join dialog and role picker, styled by `online.css`. Router hooks are in `src/main.ts` (`commit()`), title buttons in `screens/Title.ts`, and story page sync in `screens/Story.ts` (`getStoryPage` / `setStoryPage` / `onStoryPageTurn`). Tests: `src/__tests__/online.test.ts`.

**Testing two players on one computer:** open the game in two tabs. HOST in one, JOIN in the other.

## Reporting bugs (session log)

Intermittent UX bugs are hard to reproduce verbally. The prototype
records every player click + every engine call (with before/after
state snapshots) into an in-browser session log so you can paste an
exact timeline into a bug report.

**To use:**

1. Play normally — the log records in the background, capped at the
   last 500 events and persisted to `localStorage` so a refresh
   doesn't lose the trace.
2. When something looks wrong, hit `~` (tilde / backtick) **or**
   click the purple **Log** button in the topbar to open the
   floating panel.
3. Click **Copy JSONL** (machine-parseable, one JSON object per
   line — preferred for the agent) or **Copy text** (compact human
   transcript).
4. Paste the result into the bug report. The agent can read it
   directly to see what was clicked, what the engine returned, and
   how state changed step-by-step.

**Example:** for the recurring "AP-refresh sometimes doesn't take"
bug, the trace will include:

```
click.ap-spend.refresh        ap={"currentAp":3,"baseAp":3}
modal.open                    kind=ap-refresh-pick-slot
click.ap-refresh-pick-slot    slotIdx=1 ap={"currentAp":3,"baseAp":3}
engine.spendApRefreshWeapon   result=ok apBefore={"currentAp":3,...} apAfter={"currentAp":1,...}
state.after-advance           ap={"currentAp":1,...}
```

…which is enough to disambiguate "engine rejected silently" vs
"engine succeeded but UI lied" vs "click never reached the
handler". See `DESIGN.md` §7.3 for the full architecture.

## Layout — fixed 3538×2211 stage

Every screen is designed against a fixed **3538×2211 px** canvas
(16:10 aspect ratio). At runtime the entire app is wrapped in
`#app-stage` (sized to the design dimensions) which is uniformly
scaled by CSS `transform: scale(var(--stage-scale))` to fit the
current viewport while preserving aspect ratio. Letterboxing is
solid black bars top/bottom or left/right.

This means:
- The layout looks visually identical regardless of window /
  monitor / phone size — no element resizes relative to another
  when the window changes.
- Content longer than 2211 px (campaign sheet, story, etc.)
  scrolls inside the stage via an internal scrollbar on `#app`.
- Touch / click targets shrink with the rest of the UI on small
  viewports (intentional trade-off — see
  `src/layout/stageScale.ts` for details).

The implementation is a single CSS variable + a `resize`
listener:

```
#app-stage { transform: scale(var(--stage-scale, 1)); }
```

```typescript
// src/layout/stageScale.ts
export function computeStageScale(viewportW: number, viewportH: number): number {
  return Math.min(viewportW / 3538, viewportH / 2211);
}
```

To author new screens, simply use raw `px` (or `em`/`rem`) and
treat the canvas as if it were a 3538×2211 monitor. Existing
`vw`/`vh`/`clamp()`/`@media` rules still work but reference the
ACTUAL viewport (not the design size), so they drift slightly
with window size — migrating those off responsive units is a
future cleanup tracked in `styles.css > "Fixed-aspect stage"`.

## Automated QA harness

An engine-driven property-test runner lives in `src/qa/` and is invoked via:

```bash
npm run qa                                # run every scenario once
npm run qa -- --scenario=monkey --runs=50 # 50 seeded random walks
npm run qa -- --list                      # show available scenarios
```

The harness drives `engine/townVisit.ts`, `engine/academyDonation.ts`,
and the opinion-card redemption paths via `QaSession` (no DOM), and
runs a battery of state invariants after every action — HP range,
equipment-rank cap, wallet non-negativity, town-visit latch resets,
JSON round-trip, etc. Failures are written to `qa-reports/<ts>_<name>_<seed>.md`
with a reproducer command.

The same scenarios are also enforced as vitest tests
(`src/__tests__/qa.test.ts`), so `npm test` catches regressions in CI.

See [QA_HARNESS.md](./QA_HARNESS.md) for the full architecture,
invariant catalogue, and instructions for adding new scenarios.

## Debug: Quick Start

The Title screen has **Quick Start Chapter 2 / 3 / 4** buttons. Each one replaces the current save (after a confirm) with a campaign simulated by `src/debug/quickStart.ts` (`simulateCampaignTo`) through the real engine: an average party that beats every quest first try (boss always dies, ~60% of minions, ~85% of drops picked up), makes random choices in every Town Visit, Scenario card, level-up and picker, plays the Ch3 Quest Report quests, and spends its parts in each shop on random products (converting a boss part only when that unlocks a purchase), keeping 0-2 minion parts. Ch2 opens Quest #2's intro; Ch3 / Ch4 open that chapter's Town Visit. If the simulation ever hits a dead end it shows the error and leaves the save untouched. Tests: `src/__tests__/quickStart.test.ts`.

## Debug Keys

| Key | Action |
|-----|--------|
| `~` / `` ` `` | Toggle session log panel (also Log button in topbar). |
| `W`           | **Win the wave.** Kills every living enemy through the normal `applyKill` path, so XP, XP dice, elements and Level Up cards are credited exactly as for real kills. Drops already on the board are collected in full. Of the fresh drops, each delver gets **every boss part** and **half their minion parts, rounded down** (7 minions → 3 each). Then the normal win route: Parting Shots (no survivors) → End Wave victory → next wave or end of quest. Logged as `debug.key-win-wave`. |
| `L`           | **Lose the wave.** Each living delver gets half the minion parts the living enemies would drop, rounded down (no boss parts, no XP). Only the **active delver** drops to 0 HP, so at most one hero card is lost (Q1 and Q2 W1 are exempt as usual). Then the normal defeat End of Wave. Logged as `debug.key-lose-wave`. |

W/L rules (both): only enemies still alive count. Hero Phase only: pressing either key during a quest outside the Hero Phase shows an alert with the error (zero fallbacks). Ignored while typing in an input, with Ctrl/Alt/Meta held, on key repeat, and when no quest encounter exists (title / town). The handler is a singleton installed on the first board render, so on a fresh page load the keys do nothing until the board has been shown once. Engine: `debugKeyWinWave` / `debugKeyLoseWave` in `src/engine/debugCommands.ts` (tests in `debugCommands.test.ts`); key handler in `BoardScreen.ts > installBoardKeydownListener`, which commits via `router.save()` so the online gate applies. The older `debugWinWave` (full parts, returns `null` instead of throwing) remains for the QA harness only.
