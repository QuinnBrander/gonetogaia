# Spec: Scenario Card choices → storybook End-of-Wave choices

**Audience:** the coding agent (Claude) rolling this change out to the remaining quests.
**Status:** trial. Quest #2 is done (2026-11-17) and is the reference
implementation. Chapters 3–4 quests got Key Item bonuses and lost their deck
draws the same day (§8).
Owner decisions below come from the design owner. Don't re-ask them; ask only about
the open questions at the end.

---

## 1. What the change is

Scenario Cards are no longer drawn as separate cards at the start of a wave. Their
options move into the storybook End-of-Wave (EOW) page as the **"continue to the
next wave" choices**. These choices **replace the small fixed bonus** that the
continue option used to give (for example "Delvers gain 3 elements" or "Delvers
heal 2 HP").

Designer intent (verbatim summary):
- Results are **no longer hidden**. This is partly for space, and partly because
  quests are hard: a badly hurt party can pick the heal, a party low on elements
  can pick elements, and a healthy party can go for an extra thing.
- We lose the ability to seed Scenario Cards onto the deck from storybook choices.
  That's accepted as a small loss.
- **Key Items get paid off:** a bonus option that can only be picked if the party
  owns a specific, thematically tied Key Item. It gives the best result, which
  adds replayability.

---

## 2. Rules (hard requirements)

1. **Visible results.** Every choice's button shows its mechanical result, e.g.
   "A - Leave the entity alone: both delvers heal 3 HP and gain 2 ELEMENTS of
   their choice". After picking, the result prose page shows, then a
   Continue → Wave N button.
2. **No negative options.** The player can see the results, so a choice with any
   downside will never be picked. That includes max HP loss, HP loss, losing
   elements, a die roll that can hurt, or bad favour. Drop such options, or turn
   them into positive ones with rewritten prose. A test enforces this (see §5).
3. **Absorb the old bonus. Never make the game harder.** Every default choice must
   be worth at least the old fixed continue bonus plus a reward of its own. Read
   the old bonus from the **storybook doc**, not just the code (see Lesson L3).
   - Quest #2 W1: the old bonus was 3 elements each. New options: heal 3 + 2
     elements / Level card + 1 element / bonus heal to full + 4 elements.
   - Quest #2 W2: the old bonus was "Delvers heal 2 HP" on Follow the shouts. New
     options: heal 4 / Level card + heal 2.
4. **Choice count follows the page's text length.** A text-heavy page gets 2
   default choices; a lighter page gets 3. The Key-Item bonus is extra on top
   (2+1 or 3+1). Quest #2 ended up 2+1 (W1, after the owner cut one option) and
   2+0 (W2).
5. **Not every moment has a bonus.** The owner decides per moment. Quest #2: W1
   has the Woo's Diary bonus, W2 has none. Ask if it's unclear; don't assume
   every continue moment gets one.
6. **Bonus gate:**
   - `requireKeyItem: N`. The bonus shows on every playthrough but is disabled
     until the party owns Key Item #N.
   - The **lock leads the label, right after the letter**:
     "C - 🔒 Requires Key Item #3 Woo's Diary: Follow Woo's directions: …"
     (it becomes 🔑 once owned). The renderer (`eowChoiceLabelHtml`) inserts the
     lock automatically, so the data label is just "C - Follow Woo's directions: …".
   - In the storybook doc, write it as
     "C: [REQUIRES KEY ITEM #N: NAME] OPTION TEXT. Result."
7. **The Key Item must be obtainable BEFORE the moment it gates,** must be
   optional (not granted on every path), and must fit the theme.
   - Check what's actually reachable. When the owner first asked for "a couple of
     optional Key Items" in Chapter 1, only one existed (#3 Woo's Diary).
   - Never assume. List the candidate items with where they come from, and ask.
8. **The bonus is the best option.**
   - **Reward choice (owner, 2026-11-17):** the best candidates for a bonus are
     rewards that **Chapters 3–4 can't otherwise grant**. Above all, these are the
     Equipment Upgrade Shop Products (#32–45) that only Scenario Cards used to hand
     out, or that only come from the random Gaia / Scavenge picks.
   - **Always add another benefit** (healing, elements or a Level card). Use the
     moment's normal continue reward, so the bonus is never worse than plain
     Continue.
   - **Shop Products:** use
     `{"kind": "add-shop-products", "products": [N], "chipFallback": 1}`. A product
     that's already Purchasable or owned turns into a Memory Chip, so the bonus
     never comes up empty.
   - **Unclaimed upgrades:** before picking, check which upgrades nothing in
     Chapters 3–4 grants directly. After this pass, only #37 Ancient OS,
     #38 Overcharger and #44 War Mace are left unclaimed.
   - Quest #2's bonus (heal to full + 4 elements) predates this rule.
9. **Keep Retreat / Return to Town** options as they were (usually "A - Return" /
   "B - Retreat"). Only the *continue* option is split into choices. Re-letter so
   the options read A, B, C… in display order.
10. **Option letters are sequential after edits.** When an option is cut,
    re-letter the rest and keep the data labels, the doc and the result entries
    in sync.
11. **Scenario prose comes from the card.** Reuse the card's narrative and
    resolution text, lightly edited. When a reward changes, add a line of prose
    that justifies it (for example, Follow it now finds "the gear of a delver who
    followed it long ago" to explain its Level card).

---

## 3. Data shapes and code (where things live)

| What | Where |
|---|---|
| Choice type | `QuestEowChoice` in `src/types.ts`: `label`, `pageId`, `carryEffects`, `rewards`, `requireKeyItem`, `then`, `nextWaveNumber` |
| Quest #2 (legacy EOW) choices | `QuestWave.continueChoices` in `data/quest2.json`; rendered by `renderQ2ContinueChoicesHtml` / `wireQ2ContinueChoices` in `src/screens/WavePhases.ts` |
| Ch3+ (data-driven EOW) choices | `wave.eow.victory[]` in `data/questN.json`; rendered by `renderGenericEndOfWave`. This screen already supports `requireKeyItem` and the lock label |
| Ch3/Ch4 quest JSON builders | `scripts/buildCh4Quests.py` (quests 4, 7, 13) and others. **Edit the builder AND the JSON**, or a rebuild reverts the change. Grep `scripts/` for the page ids first |
| Effects applied after the next wave is set up | `applyQuestCarryEffect` in `src/engine/scenarioCard.ts`. Interactive effects (`die-roll-outcome`, `pick-one-outcome`, `spend-element-for-shop-products`) are **rejected**; use immediate effects only |
| Effect kinds available | `heal-both-delvers {amount}`, `heal-both-delvers-full`, `grant-element-choice-each {amount}`, `grant-level-up-card {amount}`, `grant-ap-one-delver`, `grant-consumable-token-one-delver`, `grant-equipment-rank-one-delver`, `gain-xp`, `add-shop-products`, `grant-friendly-spawn-card`, `shift-favour-by-scenario`, … (the `ScenarioCardEffect` union in `src/data.ts`) |
| Campaign rewards on a choice | `rewards: TownVisitAction[]` (key items, complete-quest, reveal-quest…) |
| Wave-start card draws to remove | `scenarioCardOnStart: N` (fixed card, Quest #2 style) and `scenarioCardDraw: true` (deck draw, Ch3+). Remove from the wave that the new choices lead into |
| Picked-choice state | Ch3+: `genericEowPick` (module-local, NOT synced online). Quest #2: `enc.eowContinuePick` (synced for co-op) |
| Scenario Card catalog | `SCENARIO_CARDS` in `src/data.ts` (narratives, choices, effects) |
| Key Items catalog | `KEY_ITEMS` in `src/data.ts`; ownership is `state.keyItems` |
| Design summary | `DESIGN.md` → "Storybook continue choices" |

### Shape of one converted Ch3+ wave

```jsonc
"eow": {
  "defeat": { "pageId": "qN_wX_defeat" },
  "victory": [
    { "label": "A - <continue 1>: both delvers heal 3 HP and gain 2 ELEMENTS of their choice",
      "pageId": "qN_wX_A", "carryEffects": [ ... ], "then": "next-wave" },
    { "label": "B - <continue 2>: gain a LEVEL UP card, and ...",
      "pageId": "qN_wX_B", "carryEffects": [ ... ], "then": "next-wave" },
    { "label": "C - <bonus>: ...", "requireKeyItem": 7,
      "pageId": "qN_wX_C", "carryEffects": [ ... ], "then": "next-wave" },
    { "label": "D - Retreat", "pageId": "qN_wX_retreat", "then": "end-quest" }
  ]
}
```

Then remove `scenarioCardDraw` / `scenarioCardOnStart` from wave X+1.

---

## 4. Process, per quest

1. **Read the storybook doc** for the quest (the owner supplies the current
   `.docx`) and the quest JSON. For each "continue onto the next wave" moment,
   record:
   - the old fixed bonus,
   - the Scenario Card that's drawn at the next wave (fixed number, or a deck draw),
   - how much prose the page has.
2. **Pick the card for each moment.** A fixed number is easy. For deck draws
   (`scenarioCardDraw`), the card used to vary, so a specific card must now be
   assigned to each moment. Propose one by theme and ask (open question Q1).
3. **Find candidate Key Items** for any bonus the owner wants. Check:
   - what's reachable before the moment,
   - that it's optional,
   - that it fits the theme.
   Present the list and confirm.
4. **Draft the choices:**
   - 2 or 3 defaults by text length (rule 4), each worth at least the old bonus
     plus its own reward,
   - no negatives,
   - an optional bonus.
   Show the owner a table of old vs new before writing, if the numbers aren't
   already agreed.
5. **Write the data:**
   - choices + result pages,
   - append the card narrative to the victory page prose,
   - delete the old bonus line from the page,
   - remove the wave-start card draw,
   - update the builder script if one exists.
6. **Code** only if a new effect kind is needed: add it to the
   `ScenarioCardEffect` union and to `applyScenarioEffect`.
7. **Tests** (see §5). Then run `npx tsc --noEmit -p .`, `npx vitest run`, and
   `npm run build`.
8. **Update the storybook doc copy** (§6) and note the change in `DESIGN.md`.
9. **Report:**
   - say what isn't verified (browser play),
   - flag options that now look dominated or pointless,
   - say whether the doc's page layout was checked.

---

## 5. Tests to add / keep

In `src/__tests__/playtestFixesNov17.test.ts` (or a per-quest file):
- the choice count per moment, and which choice carries `requireKeyItem`;
- every `pageId` exists, and every choice uses `then: "next-wave"`;
- **no negative effects in any continue choice** (`reduce-max-hp-both`,
  `lose-hp-both-floor-at-one`, `lose-hp-one-delver-floor-at-one`,
  `lose-all-elements-both`; extend the list when new negative kinds appear);
- the bonus applies what it says (apply its `carryEffects` on a bootstrapped
  next wave, then check HP and `pendingElementChoices`);
- `bootstrapWaveAtNumber` no longer starts a Scenario Card for the converted waves.

`src/__tests__/scenarioCard.test.ts` covers the trigger mechanism on a
**test copy** of Quest #2 that still sets `scenarioCardOnStart`. Leave the
mechanism in place; other content may still use it.

---

## 6. Updating the storybook .docx

- Never edit the owner's original. Write a copy into the project folder:
  `<original name> - storybook choices.docx`.
- Method (docx skill):
  1. unzip with Python's `zipfile` (no `unzip` / `zip` binaries on this machine),
  2. run `merge_runs.py`,
  3. edit `word/document.xml` by paragraph index,
  4. re-zip with Python, keeping the original entry order and skipping folder entries,
  5. run `validate.py --original` with `PYTHONIOENCODING=utf-8`.
- Copy the formatting of the neighbouring paragraphs:
  - body text: colour `222222`;
  - bullets: reuse that section's `numId` (Quest #2 used 7 in 2.3 and 2 in 2.5);
  - spacing: the doc's empty spacer paragraphs;
  - dividers: the underscore line.
- **Layout for a choice moment (the owner's own edit of the Chapter 2 pass):**
  1. The scene prose, kept short. Cut lead-in sentences that only repeat the
     previous page, and mention any location an option refers to *before* the
     choice (the 2.5 lodge moved into the intro paragraph).
  2. "CHOOSE 1 OPTION:"
  3. One line per option: **bold head** + result + where to go next, e.g.
     "B: WARM UP IN THE LODGE, THEN FOLLOW THE SHOUTS (continue onto Wave 3).
     Delvers heal 4 HP. Continue onto the next page." /
     "A: RETURN TO TOWN. Continue from page 24."
  4. A short divider, then the page's closing line.
  - **No per-option result entries** in the doc: no result prose, no bullet
    lists, no separate record-keeping entry for Return to Town. The option line
    *is* the result. The game may still show a short result page after a pick.
  - Option heads put the action first ("Search the lodge, then follow the
    shouts"), not the shared part.
- Remove the "Draw the top card from the Scenario Deck and resolve it." line from
  the wave page, but **keep the empty paragraph** so the page layout doesn't shift.
- Use curly quotes (’ “ ”) and em dashes to match the doc.
- **Rendering:** LibreOffice isn't installed, and Word COM `ExportAsFixedFormat`
  hung (likely a hidden dialog, which may leave a `WINWORD.EXE` running). Verify
  by reading the text back from the XML, and tell the owner that the page layout
  wasn't checked. Expanded sections can push the wave page onto the next page.

---

## 7. Lessons from the Quest #2 back-and-forth

- **L1 – Rewards were too low at first.** The first pass copied the Scenario Card
  rewards as-is (heal 1, 1 element) after deleting the old "3 elements" bonus,
  which made the game harder. Always add the old bonus into every option (rule 3).
- **L2 – Negative options are dead weight once results are visible.** "Try to
  capture it: −1 max HP" was first buffed into a positive, then the owner cut it
  entirely and moved its reward (Level card) onto "Follow it". Prefer fewer, clearly
  different options over rescuing a weak one.
- **L3 – The code and the doc can disagree about the old bonus.** The game had no
  bonus on Q2 W2 → W3. The doc had "Delvers heal 2 HP" on Follow the shouts. The
  doc is the source of truth for what the player used to get; fold that in and
  tell the owner the game was missing it.
- **L4 – Lock placement.** The owner wants the requirement and the key **first**,
  not as a trailing note. On screen: right after the letter. In the doc:
  "[REQUIRES KEY ITEM #N: NAME]" before the option text.
- **L5 – Don't invent Key Items.** The request assumed several optional Chapter 1
  Key Items, but only one existed. Asking turned "two bonuses with two items" into
  "one bonus on W1, none on W2". When the design depends on content that may not
  exist, check and ask.
- **L6 – Restate ambiguous answers as concrete layouts.** A short answer ("wave 2
  has the bonus option, wave 3 has none") was ambiguous. A follow-up question with
  three explicit layouts settled it in one round.
- **L7 – Keep the legacy flow working.** Quest #2's hand-coded EOW (defeat retry
  pages, the Key Item #1 collect step, `routeToCh2OrTitle`) was kept, and the
  choices were layered on top rather than converting it to `eow`. That conversion
  would have changed defeat behaviour (the generic defeat always ends the quest).
- **L8 – Online co-op.** Store the pick in the encounter state so the watching
  player sees it (`eowContinuePick`). The Ch3+ `genericEowPick` is module-local
  and doesn't sync. Fix that when converting Ch3+ quests if co-op matters there.
- **L10 – The owner trims for page space.** Their edit of the Chapter 2 doc cut:
  - the result entries,
  - a redundant lead-in sentence,
  - the extra +2 HP I'd added to "Search the lodge".
  Write the doc lean from the start (§6). Treat the owner's doc edits as the
  source of truth: diff them, explain them back, and sync the game to them.
- **L9 – Escaping in shell-driven edits.** The Bash tool collapsed `\\u2192` to an
  actual arrow inside Python heredocs, and one script died on a bad `\u` escape.
  Use the Edit tool for TypeScript containing `\uXXXX` escapes or emoji, and
  Python raw strings for search text.

---

## 8. Chapters 3–4 decisions (first pass - see 8a for the correction)

The owner's answers to the earlier open questions:
- **Deck draws: removed.** No Chapter 3–4 wave draws a Scenario Card any more.
  The Ch3+ continue moments keep their existing single "A - Continue {bonus}" +
  "B - Retreat". No card choices were added there.
- **Seeded cards:** all `place-scenario-card-on-top` actions were removed:
  - Chapter 3 Dahlia's Cave A (Scenario A),
  - Chapter 4 Dahlia's Cave A (Scenario C),
  - Quest #3 Wave 3 (Scenario D).

  The Quest #4 route that Scenario D gave is now a **Key Item bonus**
  (Key Item #12 Dahlia is Free → Quest #3 W3 → W4).
- **Bonus Key Items: my choice.** One bonus per quest (two in Quest #3, the
  second being the Quest #4 route). Each is the old continue bonus plus a strong
  extra. Each uses an optional item that fits the theme, and mutually exclusive
  items (#4/#5, #8/#9) add replay value.

| Quest · moment | Gate | Bonus (C) = unreachable reward + the moment's continue reward |
|---|---|---|
| #3 W1→W2 | #2 Abandoned Syringe (Q2 bonus W3) | Shop Product **#33 Living Armor** + 2 elements |
| #3 W3→W4 | #12 Dahlia is Free (Q3 W2 boss) | **Quest #4** (Memory Chip if owned) + Level card |
| #4 W2→W3 | #10 Abducted Tidekin (Ch3 festival) | **#32 Earth's Embrace Shield** + 2 elements |
| #5 W1→W2 | #4 Charred Femur (Ch2 watchtower B) | **#34 Cyclone Boots** + Level card |
| #6 W4→W5 | #3 Woo's Diary (Ch1 / Ch4 library) | **#42 Fabled Hammer** + heal 4 |
| #7 W1→W2 | #22 Elias's Distress Signal Notes (Ch2 library A) | **#35 Ion Battery** + Level card |
| #13 W1→W2 | #9 Green Paint Chips (Ch3 festival) | **#41 Shock Gauntlet** + 2 elements |

Products: each bonus page says "Add Shop Product #N (Name) to your Purchasable
Products (a Memory Chip token if it's already available or owned)."

How they're built:
- Each bonus page is its moment's continue page with a Key Item paragraph and the
  bonus result line. The story beat into the next wave stays the same.
- Quests 3, 5 and 6: edit `data/questN.json` directly (no builder).
- Quests 4, 7 and 13: `scripts/buildCh4Quests.py` (`bonus()` and `bonus_page()`;
  `wave()` no longer emits `scenarioCardDraw`).
- Chapter 3/4 town visits: `scripts/buildChapter3.py` / `buildChapter4.py` and
  their JSON. The builders were checked to reproduce the JSON before and after.
- Tests: `playtestFixesNov17.test.ts` (no draws or seeds anywhere, bonus counts,
  bonuses are positive), plus the updated quest3/quest6/gaiaWaves tests.

**Story flow rule (owner, 2026-11-17):** a bonus page is the continue page plus
new story. Read every bonus page end to end and fix the flow. Insert the Key Item
paragraph where it makes sense in time, not just before the reward line. Fixes
made in the first review:
- **Q3 W1:** the syringe detour moved before the Carnatia fight.
- **Q3 W3:** Dahlia now steps out before you push on. "Dahlia watched the whole
  fight" was also moved before "push deeper" in the base 3.9 page, since the
  Scenario D line it set up is gone.
- **Q5:** restored the dropped closing line, and the femur matches Chapter 2.
- **Q7:** removed "Rodrigo's copy" (never established).
- **Q13:** the paint is spotted at the hatch before going deeper.

**Key Item #5 payoff (doc only):** Quest #8 "The Bridge" W1→W2 (entry 8.2a).
- Gate: #5 Dr Ira's Testimony.
- Reward: #38 Overcharger + heal up to 2 HP.
- Story: a comm relay and a supercharger core at the mouth of the anomaly hint
  at Ira's late-night comms.
- Quest #8 isn't in the prototype yet. Add it when that quest is built.

## 8a. Correction: Scenario Cards ARE folded into every Chapter 3–4 continue moment

**My first Chapter 3–4 pass was wrong.** I removed the deck draws and added Key
Item bonuses, but did not integrate the cards. The owner's terse answer "remove
this" to "which card should each moment show?" meant *remove the deck*, not
*remove the cards*. Their Quest #4 Wave 1 fix showed the pattern.

**The pattern (same as Quest #2 and the owner's 4.2):**
- The wave page keeps **A Continue / B Retreat**.
- The **continue entry** keeps its story, then gets the Scenario Card scene, then a
  **"Choose one:"** box. Each row is a bold option name plus its result, then its
  resolution.
- After the box comes the rest of the story, any goal line, and the closing
  "Continue…" line.
- The entry's old fixed reward is removed. Every option keeps it, so the game is
  never harder.
- **Story flow:** the scene goes where it makes sense in time (`split`), e.g.
  before the fight starts.
- **Count:** 2 options on long entries, 3 on short ones.
- **Key Item bonus:** the **last row of that box**, not a C row on the wave page,
  and not a separate "Xa" entry.
- **Quest choice:** where the quest already has a story choice, use it (as the
  owner did for Quest #4 W1, and Quest #6 W2's "Take something, leave something"
  note).

**Single source:** `scripts/storybookChoices.py` lists all 16 moments (card,
scene, split, options, kept reward, bonus).
- **Game:** `applyStorybookChoices.py` (quests 3, 5, 6) and `buildCh4Quests.py`
  (quests 4, 7, 13) turn each option into an "A - Continue: <option>: <result>"
  End-of-Wave choice. Its page is story + scene + resolution + rest + reward lines.
- **Booklet:** `tools/booklet/storychoices_doc.py` rewrites the continue entries.
  It runs on the **owner's current booklet** and leaves their edits in place.

**Card assignment (each used once):**

| Moment | Card | Moment | Card |
|---|---|---|---|
| Q3 W1→2 | #03 Bud | Q6 W1→2 | #10 Lantern |
| Q3 W2→3 | C Elders | Q6 W2→3 | #13 Waystation (the quest's own note) |
| Q3 W3→4 | #15 Static | Q6 W3→4 | #09 Trails (#42 Fabled Hammer) |
| Q3 W4→5 | #14 Siren Song | Q6 W4→5 | #04 Outpost |
| Q4 W1→2 | owner's attack/pass | Q7 W1→2 | #08 Friends |
| Q4 W2→3 | #16 Puppet | Q7 W2→3 | #07 Directions |
| Q5 W1→2 | #12 Clawprints | Q13 W1→2 | #11 Runoff |
| Q5 W2→3 | #17 Small Footprints | Q13 W2→3 | A Tidebloom (#37 Ancient OS) |
| | | Q13 W3→4 | (quest choice: syringes / ledger) |

- **Not used:** #05 Snowpetal, #06 Lift (snowy Chapter 2 settings), B Heirloom,
  D Open Hand (its Quest #4 route is now Key Item #12).
- **Cards #01–#02** are Quest #2's.
- **Changes made to fit:** the Woo's Diary bonus moved from #42 to **#44 War Mace**,
  because Trails gives #42. Downsides were dropped from every card option, and
  dice rolls became their good result.
- **Doc-only quests #8, #10–#12** (owner: "do #8–#12") are in `DOC_MOMENTS`:
  11 continue moments.
  - **Cards:** #05 Snowpetal (8.2) and #06 Lift (8.5) suit the bridge world's
    "bitterly cold" setting, and B Heirloom suits 10.2. The other moments use the
    quest's own scene for the choice.
  - **Bonus:** Key Item #5's Overcharger bonus is now the last row of 8.2's box.
  - **Quest #9** is a single wave, so it has no continue moment.
  - **Booklet bug fixed:** Quest #10 W3's continue-only block was labelled
    "10.9 only:" (10.9 is Retreat). It's now "10.8 only:".
  - **Quest #14** (owner: "do #14"; no retreat): 14.2 and 14.4 run straight into
    a fight, so the choice is the party's reaction in the heartbeat before it.
    - 14.2: crates (heal) / spare cells (AP) / call to the trapped Tidekin (Dahlia).
    - 14.4: call Vera's name (Elias) / steel yourselves (elements).
    - 29 continue entries in total now carry storybook choices.
- **Flow review of the new entries found:**
  - 12.5's scene had frost where the text says "it's not even cold here";
  - 11.8's choice referred to the Cypress before it was introduced.

  Both are fixed. Read every rebuilt entry end to end.

**Lessons:**
- **L11:** "remove this" and similar short answers can name a different target than
  the question. Restate the plan in one line before a large change.
- **L12:** when the owner fixes one example by hand, diff it first. It's the spec.

## 8b. The board-game booklet (Nov 17 2026 copy)

`Rising Tide Booklet - Nov 17 2026/` in the G2G folder holds Chapter 1–4 `.docx`
files:
- **Chapter 1:** the owner's Chapter 1 doc, with the Story Phase "Resolve the
  next Scenario Card" step removed.
- **Chapter 2:** the owner's edited storybook-choices doc.
- **Chapters 3 and 4:** split from `Rising Tide - Chapters 3-4 (Revised).docx`.
  Chapter 3 = revision notes + Chapter 3 town visit + **all quest pages (#3–#13)**;
  Chapter 4 = revision notes + Chapter 4 town visit.

Every change in this pass is highlighted **green** (the earlier pass used yellow).
Page-number references are not updated yet. That's agreed for later.
- **Scenario Deck:** all draw lines are emptied (kept as blank paragraphs for
  layout), and the Scenario A and D seeds are removed. The booklet's Chapter 4
  Dahlia page never seeded Scenario C.
- **Session story fixes carried over:**
  - Father Flores (candelabra),
  - Rodrigo's "Oh no, my dad!",
  - Xavier's "Wait, really?" sentence removed,
  - Vera's journal "finding … from the days before",
  - Bram's funeral line,
  - Vera's Ally footnote,
  - the "Master's Bram's" typo.
- **Not carried over:** the Bram lantern line (the booklet's wording was already
  different and clear) and the quest-card description removal (that was
  prototype only, at the owner's request).
- **Bonus options:** a C row is added to each wave's options table (copied from
  the B row), plus an "Xa" entry after entry X: instruction → Key Item story →
  "finish entry X, but take these rewards instead" → reward bullets → the
  original closing line. This avoids reprinting long entries and keeps the story
  in the same order as the game.
- **Lock labels:** they use the printed Key Item **card names** (`KEY_ITEMS`):
  #4 Large Bone, #5 Dr Ira's Testimony, #22 Distress Signal. Some Chapter 2 town
  pages call them Charred Femur / Dr Ira's Account / Elias's Distress Signal Notes.
- **Tooling:**
  - The script is `booklet34.py` (scratchpad; it re-runs from the unpacked
    original).
  - Insert `<w:highlight>` at its schema position inside `<w:rPr>`, and handle a
    self-closing `<w:rPr/>`. Getting this wrong made Word validation fail.
  - Some validator errors already existed in the source files (missing
    `pgMar/@gutter`, a duplicate bookmark id in Chapter 1). Use `--original`
    to separate them from new ones.

## 8d. Quest page layout: two-page spreads (owner, 2026-11-17)

**Rule:** every quest wave is a two-page spread. The **wave page** (header, goal,
enemy cards, abilities, death box, End of Wave options) sits on the **even (left)**
page. Its **End of Wave entries** (died / continue / retreat / bonus) sit on the
facing **odd (right)** page.

- **Separate booklet.** Quests #3+ have their own `Quests 3+.docx`. Page 1 is a title
  page, so the first wave page lands on page 2.
- **Layout authority is Google Docs.** I can't render it here; the owner checks the
  final fit there. Word (via COM) is the stand-in for measuring.
  - Word's numbers are reliable for the resolution pages (plain text).
  - Word places floating boxes differently from Docs, so wave pages are only
    approximate.
- **LibreOffice is useless for this booklet.** It renders even the untouched
  original with waves on odd pages and boxes adrift.
- **The original booklet didn't meet the rule in Word either.** Waves started
  mid-page, and the options box landed on the next page.
- **What `tools/booklet/spreads.py` does (shrink first, owner's choice):**
  - an inline page break at the start of each wave header and each first entry
    (Google Docs ignores Word's odd/even section breaks, so parity relies on each
    wave being exactly two pages);
  - spacer lines dropped before those breaks;
  - wave-page card images at 80%, with the blank block under the card row trimmed
    to match;
  - the options box made inline, 11 pt, rows sized to their text, and wider. As a
    floating table, Word kept moving it alone onto the next page;
  - on resolution pages: 11 pt text, 80% pictures, blank runs collapsed to one 6 pt
    spacer, and the final divider dropped.
- **Gotchas found:**
  - Blank lines on wave pages reserve space for floating cards and boxes.
    Collapsing them made the boxes overlap the cards, so keep them.
  - Word anchors a floating table to the paragraph *after* it. A page break at the
    start of that paragraph drags the table onto the next page, so give it a spacer.
  - The emptied "Draw the top card…" line sat in its own bordered box. Remove the
    whole table, not just its text.
- **Prose trims (only where a page still overflowed):**
  - entries 3.2, 4.5 and 5.2 now use the prototype's tighter wording;
  - the bonus entries were shortened;
  - the C option labels became "[REQUIRES KEY ITEM #N] SHORT ACTION".
- **Status in Word:**
  - All 40 resolution pages fit on one page.
  - 35/40 wave pages fit. #4 W2, #6 W4, #7 W1, #8 W1 and #9 overflow 1–3 lines
    because of Word's float placement. Check those in Docs.
  - The Quest #7 Conclusion and Secret Town Visit block is 7 pages, so a blank
    page now precedes Quest #8 (`PAD_BEFORE_QUESTS` in `spreads.py`; owner's
    choice). Quest #8 W1 starts on an even page again. If that block's length
    changes in Docs, revisit the padding.

## 8c. Campaign continuity gates

- **Quest #03 before Chapter 5 (owner, 2026-11-17).** Chapter 5 opens with
  Dahlia's execution, so the party must have met and rescued her (Quest #03).
  Before this fix, all six routes to Quest #03 were optional choices. Chapter 4's
  Jobs Board route also comes after the Quest Report, too late to play it.
  - **Game:** `ch4-story-so-far` always grants Quest #03 (Memory Chip if already
    owned or completed).
  - **Game:** every Chapter 4 ending goes to `ch4-before-chapter-5`. It offers
    "Play Quest #03" (hidden once `quest.3.completed`, no Story token, loops back)
    and "Continue to Chapter 5" (shown only once `quest.3.completed`).
  - **Booklet (Chapter 4):** the same grant after The Story So Far, and a
    "Before Chapter 5:" requirement before the final check-off.
  - This is a *requirement*, not an optional branch, so it doesn't break the
    "no only-if options" rule.
  - Check the same thing for any later chapter that depends on a quest having
    been played.

## 8e. Lieutenant challenge (owner, 2026-11-17)

The six Lieutenants Spawn Cards had no way into the deck once Scenario 9's
"dangerous road" (a downside) was dropped. Owner decisions:
- **Where:** every Quest #4+ continue moment that leads into Wave 3 or later
  (8 game moments, 8 booklet-only). `lieutenant_eligible()` in
  `scripts/storybookChoices.py`; the option is appended by `option_list()`,
  so the game builders and the booklet both get it.
- **What:** the next Lieutenants Spawn Card goes on top of the Spawn Deck and
  stays in the deck for the rest of the campaign (once all six are in, one of
  them goes on top). Reward: the moment's continue reward + a Level card + a
  boss part of the next wave's level for each delver.
- **Booklet:** `tools/booklet/lieutenant_doc.py` adds the row to the existing
  boxes (before the Key Item row, re-lettering it), highlighted **cyan**. It
  wrote `Quests 3+ - storybook choices + Lieutenants.docx`; the original copy
  is unchanged.
- **Layout (Word):** with the row, entry 4.5 (four options) spills onto a
  second page. The prose was shortened once to fix 6.5. 4.5 still needs a
  trim, to be checked in Google Docs.

## 9. Open questions for the owner

- **Q7 – Vera's fate (owner: fix later).** Quest #14's 14.4 calls the Revenant
  "the delver Vera Brass that died in the Watchtower blaze". Quest #5 and its
  Charred Femur bonus suggest she survived. If Ira captured her afterwards, 14.4
  should say she was taken, not that she died.
- **Q6 – Quest pages split.** Chapter 3's file carries every quest page; should
  some quests (e.g. #8–#12) move to the Chapter 4 file or a later chapter?
- **Q5 – Lost seed rewards.** Chapter 3 Dahlia's Cave A used to also seed Scenario
  A (Shop Product #33, now the Quest #3 W1 bonus). Chapter 4 Dahlia's Cave A
  seeded Scenario C (Elders). Those pages now give only their other rewards
  (Xavier opinion / Quest #4). Should anything replace them?
- **Q4 – Pre-existing bug, unrelated to this change.** Vicious + Scorchline Beam
  repeat damage. The owner is investigating; don't touch it unless asked.
