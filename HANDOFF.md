# G2G handoff: Chapter 3 work (session ending 2026-11-15)

Read this first in a new session. All work below is **uncommitted** in the working tree. The repo also has many unrelated pre-existing modifications, such as line-ending churn, so stage carefully.

## Ground rules from the user
- **Board-game first.** Avoid "only appears if…" branches. Always offer the option and give a fallback: "If already owned or completed, instead gain a Memory Chip token." Quests should be reachable by several routes.
- **Art sources:** Chapters 1–2 keep the graphic-design art, unless a card's *content* changed significantly. Chapters 3–4 use the **prototype materials** from `Game Materials/Game Materials - All - Nov 15.pdf`. Mixing the two is intended.
- Don't start or stop `npm run dev`. For browser checks I used `npm run build:single`-style builds (`npx vite build --config vite.singlefile.config.ts`) served by the `g2g-build-preview` config in `.claude/launch.json` on port 4179. Seed saves came from a tsx script (see "How I tested").
- Zero fallbacks in code: fail loudly.

## Movement is one continuous move, no +1 movement carve-out (2026-11-17) - DONE, nothing committed

Designer ruling: you can't move, use an ability and then move again, not even with the "+1 movement this turn" slot ability. `resolveBonusMovement` no longer clears `movementUsedThisTurn`, and `endMovementSessionIfActionInterruptsIt` has no exception, so a delver who already stepped loses the rest of their movement (bonus included) when they act. A delver who hasn't moved yet still gets the bonus after the action. `actionGrantedExtraMovement` is now display only (movement badge total), set only when no step was taken. DESIGN.md §5.1.2 rewritten; tests in `turn.test.ts`, `slotAbilities.test.ts`, `movement.test.ts`. 1991 tests pass, `npm run qa` clean. Not browser-checked (engine rule; the UI only reads `movementUsedThisTurn`).

## Player aid on the first-turn pick screen (2026-11-17) - DONE, nothing committed

The "Delver Phase" player aid now also shows on the "Choose who goes first" screen, beside the hand, as on the board. It moved to `screens/CombatRulesPanel.ts` (`renderCombatRulesPanel`, used by BoardScreen and FirstTurnPick; nothing is highlighted before turn 1). The "Choose who goes first" box no longer floats over the screen centre (it covered the aid): it sits above the hand cards in `.first-turn-pick-hand-col`. Browser-checked at 1600x1000: aid visible, See other board and "Body Player Goes First" work.

## Defeat flow: no duplicate final words / blood text (2026-11-17) - DONE, nothing committed

The game already asks for final words in the "Hero Fallen" popup when a quest is lost, but the Ch3 / Ch4 Town Visit "The Fallen" page then told players to write them in the Graveyard again, and repeated "Blood seeps into the crevices..." that the next "Blood-Soaked Suit" (reward) page prints. "The Fallen" now reads "You bring your fallen delvers home to Bird's Nest. Their final words are already recorded in the Graveyard on your Campaign Sheet." (`buildChapter3.py` / `buildChapter4.py`, regenerated; both reproduced the old JSON before the edit, ch3 differing only in line endings, kept LF). Ch2's death-page footnote no longer says to discard the card and record final words (the game does both). Browser-checked: Quick Start Ch3 → Quest #5 → L → Hero Fallen popup → Quest Report → Town Visit → The Fallen → Blood-Soaked Suit (blood line once) → New Recruits.

## Rules decisions applied (2026-11-17) - DONE, nothing committed

From a review of the Rulebook (PROOF 6) against the design, the designer decided: **3-phase waves** (Delver, Parting Shots, End Wave; no Interlude), **Harvester and Elemental OS at the end of the wave** (Harvester on every wave end including defeat, living bearers only; OS, Armor heals, Shield elements and Elayna / Rodrigo penalties only when continuing to the next wave), **Prevent Counter renamed to Block Counterattack, and it cancels the counterattack's side effects**, and **no per-turn cap on Reroll / Block Counterattack**. Summary in README "Wave structure and token rules"; rules in DESIGN.md (decision block at the top, §4.2, §5.5.2). State **v65** (`migrateV64ToV65`). Tests 1989 pass, `npm run qa` clean, single-file build OK.
- **Browser-checked** (single-file build, Quick Start Ch2, Mind given Harvester R1, Body Elemental OS R1 and 2 HP down): W on Q2 W1 → Parting Shots → End of Wave shows the new "End Wave" card (weapons, AP, "Mind: Dragonfly Model Harvester: +2 minion parts"); a reload doesn't pay Harvester twice; Body HP unchanged until continuing; option B → rewards popup shows "Body: Exoframe Armor heals 1 HP (8/9)" and "2 element picks from Elemental OS / Shield"; after the boss card-back picks and spawn, the Wave 2 board opens the element picks ("Elemental OS - end of wave"). No console errors.
- **Not browser-checked:** the Block Counterattack picker (needs a landing counterattack while holding a token; covered by `ch4Quests.test.ts`) and Harvester on a defeat (covered by `harvester.test.ts`).
- **Fixed:** the "Start each Wave with +1 X Element" shop products (#6, #7, #11; `shopGrants.ts`, case `element-tokens`) ignored the 2-per-element cap, so Quick Start saves could show 3/2. They now grant through `grantElementToDelver`, so overflow is lost like any other element gain (`shopGrants.test.ts`). Saves that already hold 3 keep them until spent or the quest ends.

## Online co-op (2026-11-15) - DONE, running on Firebase

The title screen has HOST GAME / JOIN GAME with a 4-digit code. The host picks Mind or Body at Start, Upload Progress or Quick Start, and the guest gets the other. Refresh and REJOIN reconnect to the same session. Full design, decisions and code map: README "Multiplayer". Design decisions agreed with the user: **full-state snapshots** (no action replay), the **watcher can only look** (state changes get rolled back with a toast), the **host drives** everything except the turn owner's hero phase, and the plan is **Realtime Database + anonymous auth**, with sessions kept until the host ends them.

- **Firebase is live** (`NET_TRANSPORT = "firebase"`, project `gone-to-gaia`, Realtime Database plus anonymous sign-in; `firebase` npm package 13.3.0). Browser-checked over Firebase with two tabs: host, join, story page following, board following, the watcher shown as watching, guest refresh rejoining onto the board, closing the guest tab showing "disconnected" on the host (onDisconnect), REJOIN from a new tab, and END ONLINE GAME. `"local"` mode still exists for offline two-tab testing and the unit tests.
- Tests: `src/__tests__/online.test.ts` (22). Browser-checked on the single-file build with two tabs: host, join, refresh-rejoin for both seats, role pick on Quick Start Ch2, story/board following, guest actions refused while the host drives, turn hand-off Mind (guest) → Body (host) on End Turn, host refused during Mind's turn, END ONLINE GAME returns the guest to the title.
- Known gaps / next steps: (1) test on two real computers, and in the packaged .exe / Android build (Firebase over `file://` is untested); tighten the DB rules to room members only. (2) Per-delver choices that happen outside the hero phase (hero card pick, Town Visit shopping, level-ups between turns) are host-only for now. If players want each to choose for their own delver, `roles.ts > actingSeat` is the one place to change. (3) There's no "take over the disconnected player's turn" button; the host waits for the guest to rejoin. (4) The watcher sees results, not animations or dice mid-attack. (5) Screens that mutate state while rendering are silently discarded on the watching client (logged as `online.rejected` kind `render`). That's by design, since the acting client's copy is authoritative.

## W / L debug keys (2026-11-15) - DONE

During a quest's Hero Phase, **W** wins the wave and **L** loses it. Details are in the README "Debug Keys" section. User rulings: only living enemies count. Each delver gets half their minion parts, rounded down. W also gives all boss parts plus the XP and level-ups the kills would have given. L drops **only the active delver** to 0 HP, so at most one hero card is lost. Engine: `debugKeyWinWave` / `debugKeyLoseWave` (`src/engine/debugCommands.ts`, 9 tests). Browser-checked on the single-file build with Quick Start Ch2, Q2 W1:
- W: 7 minions → 3 parts each, +1 boss part each, XP 5 with level-ups, then Parting Shots → End of Wave → "Continue → Wave 2" (the Interlude is gone since 2026-11-17).
- L: Mind at 0 HP, Body untouched, 3 minion parts each, defeat page.
- An L press during Parting Shots alerts, and W typed in an input is ignored.

## Suit Condition picker shows the rank reached (2026-11-15) - DONE

The user asked for the Suit Condition rank picker (Blood-Soaked Delversuit, Scenario Card and Boss Card picks) to say what rank the bonus reaches. Every type button, the chosen/pinned headline and the placement header now show it: "R1 → R2", "not owned → R1", and "max R3 → R4" for boss-card unlocks (which raise the cap). The rank shown is the delver's current effective rank, so it depends on the active hero card. The Academy Donation placement step already showed "R2 → R3" and is unchanged. Engine: `previewSuitConditionPick` in `engine/suitConditionGrants.ts` (3 tests, checked against what apply actually lands on). UI: `rankPreviewLabel` in `SuitConditionRankPickModal.ts` + `.suit-condition-rank-preview` CSS. Browser-checked all three pick kinds on the single-file build.

## Jobs Board: context before the choice (2026-11-15) - DONE

The Ch3/Ch4 Town Center "Take a Job" page now describes every request (Xavier's Tidebloom sample, the Second Nest map, and in Ch4 Elayna's watchtower basement) BEFORE the buttons. Before, each description only appeared after the player had chosen. The result pages keep their title + rules footnote with a short outcome line. The map seller is now a "street urchin" (was "fence"); decision keys `ch3/ch4.jobs.B.fence` are unchanged so saves still match. Edited in `buildChapter3.py` / `buildChapter4.py` (both reproduced the old JSON exactly before the edit), then regenerated. Browser-checked the Ch3 page.

## Online co-op: each player chooses for their own delver (2026-11-15) - DONE (partly browser-checked)

User request: hide host-only buttons on the non-host's screen; the non-host makes choices that only affect their delver (story or combat); the watching player sees "[Mind/Body player is choosing]". User calls: both state-queued choices AND on-screen combat (Shield) prompts; each player buys for their own delver in the shop; banner at the top centre. Design + code map: README Multiplayer "Who can act". Tests: `online.test.ts` (31, 7 new), all 1967 pass, `npm run qa` clean.
- **Browser-checked** (two tabs over Firebase, Quick Start Ch2): guest's story / spawn / parting-shot / interlude buttons hidden with the banner; hero-card pick Mind → Body hand-off; Body's Supercharger roll made on the guest's screen during Mind's turn, then back to Mind; Q2 W1 element picker turns (both picks synced); boss-card unlock picks per delver (Body's on the guest's screen) → back to the host's Wave 2 spawn.
- **Not browser-checked yet:** the relayed Shield prompts (needs a counterattack or parting shot with a shield bearer on the other delver's tile), shop turns (needs a Town Visit shop online), and the level-up resume after an attack (`REMOTE_APPLIED_EVENT` listener in BoardScreen). These are covered by unit tests of the rules only.
- Still host-only by choice: spawn placement, first-turn pick, scenario cards, payer picks, Graveyard final words, Academy donation assignment.

## Death pages decided by the game, schema v64 (2026-11-15) - DONE

The user said not to ask "did any delver die on your last Quest?" or "which delver died?", because the game knows. New `state.lastQuestDeaths` (**schema v64**, `migrateV63ToV64` → `null`) records 0-HP delvers at every defeat End of Wave. The Ch2/3/4 arrival + "The Fallen" choices carry `requireQuestDeaths`, so only the matching button shows. The question footnotes were removed (`buildChapter3/4.py` regenerated, and they reproduced the old JSON byte-for-byte before the edit; `chapter2.json` was edited by hand). Behaviour change: Ch2 "page22-died" used to auto-skip; now every death page shows its text with the one matching button. Details in README. Tests: `questDeaths.test.ts` (12), 1960 pass, `npm run qa` clean. Browser-checked Ch3 arrival with no deaths and with a Mind death.

## Chapter end: Continue or "Stop for now" (2026-11-15) - DONE

The end page of Chapters 1-3 now has a "Stop for now" button next to the Continue button. It finishes the chapter and returns to Title, which shows "Continue → (next chapter)". Chapter 4 keeps its existing end overlay. README "End of a chapter". Browser-checked on the single-file build (Quick Start Ch3, jumped to `ch3-end`): Stop for now → Title "Continue → Chapter 4", which survives a reload and opens the Ch4 Story So Far.

## Spawn-pick: 3 units on one tile fit immediately (2026-11-15) - DONE

Placing Mind, Body and Witness on the same spawn tile used to fan them in a row wider than the tile until Start Wave. The cause was that the spawn-pick screen (and the WavePhases board) had an old copy of the layout. `humanoidStackOffset` (2 side by side, 3 in a triangle) moved from `BoardScreen.ts` to `board/tideBoard.ts`, and all three screens now use it. Browser-checked on the single-file build (Quick Start Ch2, all three on one tile).

## Hand layer tabs + SUPERCHARGER button fit (2026-11-15) - DONE

- **Hand tabs:** when a delver has more than 8 equipment cards outside their slots, tabs ("Cards 1–8" / "Cards 9–11") sit ABOVE the hand grid and switch between layers. The old `‹ 1/2 ›` pager was below the grid and fell off the screen. A short last layer is padded with invisible `.hand-card--spacer` cards so the tabs don't move when switching. Code: `HandPanel.ts` (layer tabs), `.hand-tabs` / `.hand-tab` CSS (the `.hand-pager` CSS was removed).
- **SUPERCHARGER** overflowed its button in the type picker (boss-card unlocks, other suit-condition picks and Academy Donation). `.academy-donation-resolution-type-pick-grid` columns are now at least 150px, and the buttons use `nowrap`.
- Browser-checked on the single-file build with a crafted Q2 W1 save: 11 cards, tabs both ways, the tabs stay in place, and no button overflows at desktop or phone width.

## Session 4 - DONE: Quick Start Chapter 2 / 3 / 4 (debug menu)

Title screen buttons "Quick Start Chapter 2/3/4" replace the save with a simulated average party (README "Debug: Quick Start"). Tested: `src/__tests__/quickStart.test.ts` (8 seeds x 3 chapters, deterministic because `Math.random` is stubbed with the seeded RNG; checks flags, invariants, JSON round-trip), a 600-seed stress run, and all three buttons browser-checked on the single-file build (Ch2 -> Quest #2 intro, Ch3/Ch4 -> "The Story So Far").

- `src/debug/quickStart.ts` `simulateCampaignTo(chapter, rng)`: Q1 -> Ch1 visit (from `page6`) -> [Ch2] -> Q2 -> Ch2 visit (`page22-both-survived`) -> [Ch3: `startTownVisit("ch3")`] -> Ch3 visit incl. Quest Report quests -> [Ch4: `startTownVisit("ch4")`]. Real engine calls only; random choices; boss always dies, ~60% minions, ~85% drops; shops: random affordable buys, boss->minion conversion only when it unlocks a buy, leftovers donated keeping 0-2.
- Fixes found by the tests: boss card-back picks are `unlockHigherRanks` (no slot); level-up picks come from every legal type (Ultra "+1 any passive", R3 lock respected).
- **Ruling (user, 2026-11-15): a level-up card with no legal pick is just discarded** (no rank, no redraw). It happens when every type the card allows is maxed / locked at R3. Engine: `legalLevelUpTypes` + `discardUnplayableLevelUpDraw` in `engine/levelUp.ts` (throws if a legal pick exists). The Level-Up modal shows a note + "Discard card" button in that case (browser-checked with a crafted Q1 save); the sim uses the same call. Tests in `levelUp.test.ts`; 600-seed sim stress run has no failures now.

**Quest Report rule (user, 2026-11-15, general):** you must attempt at least one Quest before the Town Visit. The Ch3/Ch4 "Into the Tide" intro now shows the playable Quests as card buttons (new optional `image` on `TownVisitChoice`, card grid CSS `.town-choices--cards`) with no Continue; "Continue to the Town Visit" is only on the Quest Report page reached after a Quest. Changed in the generators (`scripts/questPages.py` `report_choices`, `buildChapter3.py`, `buildChapter4.py`, run with the repo root as argument) and regenerated JSON. Tests: `questReport.test.ts` (reachability: no path from the chapter start to the report/arrival without a quest). Browser-checked via Quick Start Ch3.

**UNDO MOVEMENT (user request, 2026-11-15):** board button (floating bottom-centre of `.board-frame`; the topbar had no room) available after any step until End Turn. New `MovementSnapshot` fields `startAp`, `startCardPlaced`, `revealed` (optional - snapshots from older builds are reported as not undoable); `movementUndoBlockedReason` is the single rule, `undoMovementThisTurn` throws when blocked. End Turn undo prompt shows "End turn anyway" when blocked. Tests 1906 pass, `npm run qa` clean; browser-checked undo, blocked alert and "End turn anyway" on a crafted Q1 save.

**Also done this session (all tests passed: 1866):** Overcharger Ongoing = raise base damage to upgraded value for the quest + damage formula `multiplier x (base + bonus)`; Memory Fragments #2-10 (placeholders) + Witness once-per-quest ability (rulings confirmed); 5 stale tests fixed; Xavier picker and Suit Condition/donation pickers enlarged; Prevent 1 Counterattack now blocks (Rotates etc. still trigger). Nothing committed.

Gotchas: the Bash tool collapses doubled backslashes in heredocs (use chr(92) or write Python edit scripts with the Write tool into the scratchpad and run them); some files have CRLF - the helper `$TEMP/edt.py` (copy in scratchpad) tries both line endings.

## Session 3 (2026-11-15) - read this first

Still all **uncommitted**. Tests: **all 1861 pass** (the 5 old failures were stale tests, updated end of session 3 - see below). `npm run qa` clean. State schema **v63**.

### Done (tested + browser-verified)
- Machinist weapon upgrades: every weapon flow verified in the browser; War Mace targeting bug fixed (see "Done: Machinist Equipment Upgrades" below).
- **Chapter 4 Town Visit** (README "Chapter 4"): arrival, Heroes #9/#10, Town Square townsfolk assignment, the one-wave story quest "Assault on Bird's Nest" (Mistspawn + Infestations, Omen + Rebirth), X.1/X.2, all six locations, donation (ch4 schedule), shop #19-26 (+#45-47), Jobs Board. Played through end to end in the browser from a seeded save (Ch3 completed).
- Ch3 fix: Jobs Board B (fence's map) never took the 5 minion parts.

### Also done in session 3 (later)
- **Quests #4, #7, #13** playable from the Ch3 and Ch4 Quest Reports, with all 13 new enemy abilities, Quest #7's Elias conversation + Secret Town Visit + scavenge shop, Quest #8/#9 cards. Browser-checked: Quest Report, Quest #13 launch, the whole Quest #7 conclusion / Secret Town Visit, and the Ritual prompt. Tests: `ch4Quests.test.ts`. See README "Chapter 4 quests".

### Also done (end of session 3)
- Overcharger Ongoing fixed per the designer: 2 Water raises LIGHT/MEDIUM/HEAVY to its upgraded value (2/4/8) for the quest, if not already raised; the suit panel's damage cube moves. Damage now multiplies the raised base (`multiplier x (base + bonus)`), which also corrects the shop damage products on 2x+ cards.
- Memory Fragments #3-10 added as placeholder cards (ordered deck, front + back shown). See README "Chapter 4".

- The 5 long-standing test failures were stale tests, each written before a deliberate engine change, now updated: Boots move/rotate reasons are card-based (Cyclone Boots); Lvl 2 boss parts credit the Lvl 2 wallet (v58); XP rolls can buy level-ups that spend XP (check `totalXp`); #32 Earth's Embrace Shield swaps the Shield family instead of a +2 rank bump.

- **[Reversed 2026-11-17: Block Counterattack now cancels completely, see the top of this file.]** ~~Prevent 1 Counterattack now blocks instead of cancelling~~ (designer ruling): the prevented enemy stays in the counterattack with `DamagedEnemySnapshot.blocked = true`, deals no damage, and its "after attempting to counterattack" effects (Rotates, Alert, Flees, Strength, Accurate...) still trigger. Shell treats a blocked counterattack as not a miss.
- Popups enlarged: Xavier's +1 Rank picker (stage-pixel sizing, 2 rows of 7 cards) and the Suit Condition / Academy donation pickers (`zoom: 1.5`).

### Next steps
1. Flipped Delversuits #23/#24: skipped until the assets are ready (user decision). They're purchasable but do nothing.
2. Memory Fragment Witness ability is live (README "Chapter 4"); the "Gain Quest #N" rewards aren't applied (Quests #9-#12 not built). Swap in real art for #3-#10 when it lands (re-run `scripts/buildMemoryFragments.py` after replacing the sources). Rulings confirmed by the user: Witness damage ignores attack modifiers and causes no counterattack (Fatal Flaw still applies); healing includes Witness's own tile.
3. Rulings to confirm: townsfolk Utility reward mapping; "for this combat only" keeps elements and Level cards; Rebirth on an occupied tile waits; Assault uses the base Spawn Deck; the Ch4 quest ability rulings in README "Chapter 4 quests".
4. Invented filler: the short `*_end` lines between each fight and its End-of-Wave choice in quests #4/#7/#13 (the book has none), like the Ch3 quests.
5. Shop #40's name ("Precise Grenade" vs cards' "Precise Shockwave") still open.
6. No full Ch3 -> Ch4 playthrough of every wave yet.

Gotcha: the Bash tool collapses a doubled backslash to a single one inside heredocs - use `chr(92)` in Python edit scripts.

## Session 2 (2026-11-15) — read this first

Everything below is still **uncommitted**. Test suite (1823 tests at the time): 5 failures that predated this work (boots x2, creatureParts, kills applyXpRoll, shopGrants #32) - fixed in session 3. `npm run qa` is clean. State schema is now **v62**.

### Done this session (tested)
- **Opinion cards:** all Nov 15 effects (`src/engine/opinionEffects.ts`), one card per character (rulebook p27), Samantha/Vera/Elayna/Rodrigo ally swap, Elayna spelling. See README "Opinion cards".
- **Chapter 3 quests fully playable:** Quest #3 W1-5, Quest #5 W1-3, Quest #6 W1-5 (W5 = Gaia wave with "choose 2 of #32-45" picker). 9 new enemy abilities, 2-card Oblivionwing, Lvl 4/5 boss parts, 48 new enemies + PDF art. See README "Chapter 3 quests".
- **Boss card backs** for all Lvl 2+ Ch3 bosses; Hundredeyes switched to the PDF's Left Arm (user decision).
- **Workbook / PDF:** user fixed Quest #6/#13 cards (`Game Materials/Quest Cards - Nov 15 fixed.pdf`), used by `applyGameMaterials.py` (3rd arg = crops of that PDF).

### Done: Machinist Equipment Upgrades (#33, #35-40, #42-45)
All 11 families are in, tested and browser-verified (session 3, 2026-11-15). See README "Equipment upgrades".
- Each weapon flow was driven in the browser from a seeded Q1 board: Fabled Hammer, Engulfing Beam (both Fire spends), Precise Shockwave (2 picked targets + Radiance HEAVY), Sword of Ruin (Wind spend + Wind on kill), War Mace (minion element pick; HEAVY on a damaged boss), Lunar Trident (Void die x damage).
- Bugs fixed while verifying: the engine's Mace UNDAMAGED check used the standard card, so War Mace couldn't hit damaged enemies (fixed in `turn.ts`, regression test added); the targeting overlay and banner had the same problem. Slot art/tooltips and the auto-refresh toast now show the upgrade (new `getPlayedWeaponCard` in `state.ts`). The element pick for War Mace said "Interlude Phase". The Engulfing Beam banner now says the whole line is hit. The Lunar Trident die no longer rerolls if you back out of targeting.
- Rulings confirmed by the user: Overcharger's Ongoing spend raises one base damage to its upgraded value (LIGHT 2 / MEDIUM 4 / HEAVY 8) for the quest, if not already raised; Engulfing Beam's "LIGHT to all enemies" are extra hits (Double Damage doesn't double them). Still open: shop #40 is named "Precise Grenade" but its cards say "Precise Shockwave".
- Seed for browser checks (faster than clicking through the Q1 story): `newCampaign()`, set `equipmentRanks`/`equipmentVariants` for hero-01, elements at most 2 each (the cap), `ensureEncounter(QUEST1)`, set delver positions, `commitFirstTurnPick(s, "hero-01", startHeroTurn)`. Title → Continue goes straight to the board. Place cards in slot 6 (water) so the auto-refresh doesn't eat the elements you want to spend.

### Other open items
- Lieutenants (Dahlia Detractor/Nemesis, Lieutenant spawn cards) aren't in the game.
- Shop #20's ongoing element rule isn't automated.
- Invented placeholder text: Wave 1 intros of Quests #3/#5/#6, short `*_end` lines on new waves, shop #20's name.
- No full Chapter 3 playthrough yet. Chapter 4 Town Visit and Quests #4/#7/#13 done.
- Opinion rulings awaiting confirmation: Elayna Detractor = each delver loses 2 (largest stacks); Arlen cap refuses the new card; Arlen "best result" = top donation tier; Dahlia Ally token picked in Shop (Reroll default).

## Done (working, tested)
- **Story docs:**
  - `CH3_CH4_STORY_REVIEW.md` covers the plot issues and fixes.
  - `Rising Tide - Chapters 3-4 (Revised).docx` is the revised book with a preface and yellow highlights. It's built by a scratch script and not in the repo. To regenerate, re-apply its edits to the original docx in Downloads.
  - `~/Downloads/Gone to Gaia - Game Materials.xlsx` was updated with yellow highlights.
- **Chapter 3 Town Visit:**
  - `data/chapter3.json` is **generated by `scripts/buildChapter3.py`**. Edit the script, not the JSON.
  - It's reached from the end of Ch2, or via **Continue → Chapter 3** on Title.
  - Engine additions are documented in README "Chapter 3 notes": `if`/conditions, `complete-quest`, `grant-boss-parts`, `discard-opinion-card`, `reveal-first-unowned-quest`, `grant-shop-product`, `place-scenario-card-on-top`, `grant-minion-parts-per-open-quest`, `dieRoll` pages, choice gates and `startQuest` pages.
  - State is v59: `completedQuests`, `scenarioDeckTop`, `townVisit3Completed`, `academyDonationLifetime`. Ch3 donation tiers use the running total.
  - Shop costs can include Lvl 3 boss parts.
- **Playable Chapter 3 quests** (launched from the Ch3 Quest Report; the visit resumes there when the quest ends):
  - Quest #6 (`data/quest6.json`): Waves 1–2. Waves 3–4 aren't built.
  - Quest #3 (`data/quest3.json`): Waves 1–3. Surviving Wave 3 puts Scenario D on top of the deck. Wave 4 isn't built.
  - Quest #5 is still "recorded at the table" on the Quest Report.
  - **Data-driven end of wave:** `wave.eow` holds the defeat page plus victory choices (rewards, carryEffects, next-wave or end-quest). `wave.onBossSlain` handles mid-wave story entries. `scenarioCardDraw` draws from the Scenario deck.
  - **New enemy abilities:**
    - strength
    - stout
    - flees (automatic, to the farthest free tile)
    - synchronized
    - soothsayer
    - all-claw (`counterOffsetsFor` accepts "miss")
    - death-heal
  - Rule text for each is in `EnemyAbilitiesModal.ts`.
  - **Enemies come from the workbook** via `scripts/importEnemiesFromWorkbook.py`. Abilities are authored in its `SPEC`. The book's "Snatcher" is the existing Ophidian card.
- **Scenario cards #10–17, C (102) and D "Open Hand" (103)** are in `SCENARIO_CARDS`. Key items #7–24 are in `KEY_ITEMS`; the workbook text is canon.
- **Tests:** `chapter3`, `quest3` and `quest6` test files are new. The 5 failures that predated this work (boots ×2, creatureParts, kills applyXpRoll, shopGrants #32) were fixed in session 3. `npm run qa` is clean.

## In progress when the session ended: prototype materials → game assets
- `scripts/extractGameMaterials.py <pdf> <outdir>` crops every card. Each card is a top-level PDF form object; crops are snapped to the page's card size. It writes `index.json` with de-doubled text (Dextrous prints bold text twice).
- `scripts/applyGameMaterials.py <outdir> <G2G root>` copies Ch3/4 cards into `public/`. **Already run and written:**
  - key items #7–21, #23, #24
  - shop #15–20, #36, #39, #40, #43
  - heroes #7–8
  - quests #4, #7, #13
  - scenario fronts and backs for #10–17, C and D
  - **28 new opinion-card PNGs** in `public/opinion-cards/`, for every character/level pair that had no art (Ira, Elias, Dahlia, Rodrigo, plus missing levels for Arlen, Flores, Elayna (id `elayne`), Samantha and Xavier)
- **Next steps:**
  - **Done (2026-11-15, follow-up session):** opinion cards registered in `OPINION_CARDS`; placeholder generators and `scripts/placeholder-assets/` deleted; enemy art for joyce/gerald/cerberus/fleetfoot/carnatia/colibrius/empressash/tidegazer is now the PDF crops (stats and arrows checked against the workbook, all match). **User decision: don't implement "Hard" enemy variants for now.**
  4. **Ch1/2 content diff: done 2026-11-15.** Matches: key items #1-6, heroes #1-6, shop #1-14 (only #6/#7/#11 say "start of quest and end of each wave" instead of "start each wave"), scenarios #1-4 and #6-9/A/B, and every Q1/Q2 enemy (stats, parting shots, drops). **Significant changes, waiting on the user:**
     - **Opinion cards: done (state v60).** Samantha Ally now has the shield, Vera Ally the Lvl 2 boss part gift, Elayna Ally the Med Kit and Rodrigo Ally the token refresh. The PDF art is in for the three changed cards. See README "Opinion card effects".
     - **Quest #1:** the PDF calls it "Graduation" (Bram's delver-tag rite; goal "Reach the buoy"; reward "Knowledge of a job well done"). The game says "Reach the Buoy" with a "Creature parts" reward.
     - **Scenario #5 C, option B:** the PDF says 'Aesthetic: write "Snowpetal" in the Gossip Mill (Campaign Sheet)'. The game has "Fashion: add Snowpetal to scars", and has no Gossip Mill.
  5. **Other new material in the PDF, not yet used:**
    - memory fragments #3–10 with backs (pages 43–46); the game has #1–2 only
    - friendly encounters Gloomie, Crustache, Hogatha, Nether and Prick (page 43); the game has Flambé only
    - Lieutenant spawn cards
    - ultra/base level cards
    - shop #21–55 (delversuits, Rose Gauntlet, one-quest-use items, …)
    - quest cards #8–14
    - heroes #9–13
  6. **Quest #6 / #13 card text:** fixed in the workbook's Quest Fronts sheet (yellow) on 2026-11-15: "The Forgotten Vault" in Second Nest, and #13 now says "a hidden lab beneath the burned watchtower". The PDF (and the in-game `quest-13` crop) still show the old text until the cards are re-exported. The Quest #6 card in use is still the old graphic-design `quest-06.jpg`.

## Remaining gameplay work
- **Done 2026-11-15 (follow-up session):** Quest #3 Waves 4-5, Quest #6 Waves 3-5 (Wave 5 = the Gaia wave) and Quest #5 Waves 1-3 are playable, with all their abilities, Lvl 4/5 boss parts (v61), the 2-card Oblivionwing, the "choose 2 of #32-45" Gaia reward and the missing Machinist products. See README "Chapter 3 quests".
- **Done 2026-11-15:** every printed opinion card effect except Dahlia Detractor / Nemesis (needs Lieutenants), plus one-card-per-character (state v62). See README "Opinion cards".
- **Opinion rulings to confirm:** Elayna Detractor's "2 elements are lost" = each delver loses 2, from their largest stacks; Arlen's cap refuses the new card rather than letting the player choose which to return; Arlen's "best equipment result" = top Academy donation tier; Dahlia Ally's token is picked ahead of time in the Shop (Reroll by default).
- **Lieutenants** (Dahlia Detractor / Nemesis, Lieutenant spawn cards, workbook "Lieutenant - Lvl N" enemies) aren't in the game.
- **Rulings confirmed by the user (2026-11-15):**
  - Countdown / Frenzy extra counterattacks share the attack's counter roll instead of rolling again.
  - Oblivionwing: both cards counterattack when either is hit; damage to either card hurts the boss.
  - Quest #5 Wave 1 prints "IF BOTH DELVERS DIE" (other waves say "one or both"); the game ends the wave on any death, like every other wave.
- **Boss card backs: done 2026-11-15.** All 8 Level 2+ Ch3 bosses use their PDF backs (`BOSS_CARD_BACKS` in `WavePhases.ts`, art via `applyGameMaterials.py`). Level 1 backs print no Suit Condition line. Hundredeyes (Ch2) now uses its PDF back too ("improve one Left Arm" for both delvers; the old graphic-design card said Right Arm) - user decision 2026-11-15.
- **#20's** ongoing element rule isn't automated.
- **Chapter 4:** Town Visit and Quests #4/#7/#13 done (session 3).
- **Invented flavour lines to replace with real text:** quest6 `wave1_intro`, quest3 `wave1_intro`, quest5 `wave1_intro` (spider + Diamonids), the short `*_end` lines on the new waves (the book has no text between the fight and the A/B choice), and shop #20's name "Element Overflow".

## How I tested in the browser
1. Write a tsx script (temporarily under `src/__seed_tmp__/`) that builds a state with `newCampaign()`, `startTownVisit` and `ensureEncounter`/`bootstrapWaveAtNumber`, and prints JSON.
2. Copy the JSON into `dist-single/seed.json`, build with `npx vite build --config vite.singlefile.config.ts`, and `preview_start` `g2g-build-preview`.
3. In the page: `localStorage.setItem('g2g.campaign.v20', await (await fetch('/seed.json')).text()); location.reload()`.
4. To skip a fight, edit the save: set the enemies' `alive=false`, set `encounter.phase='end-of-wave'` and set `endOfWaveOutcome`/`endOfWavePageId`.
5. Afterwards, delete the seed file and the temp folder, and stop the server.
