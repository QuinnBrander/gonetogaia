# Chapter 3 & 4 Draft — Story Review + Reward Proposals

Source: `NEW Rising Tide Book CLEAN 6.25.26 Chapter 3 and 4.docx` (first draft), compared against the shipped prototype (`data/chapter1.json`, `data/chapter2.json`, `data/quest1.json`, `data/quest2.json`, `src/data.ts` catalogs).

---

## Status — added to the game (2026-11-15)

- **Key items now follow the Game Materials workbook.** Its existing #7–#24 text is canon. I kept most of it as written and merged in plot fixes for #9, #11, #13, #14, #17, #18, #19 and #21. "Part 2" below is the superseded first draft. #25 was dropped, because the workbook's #7 "You Found Elias Brass" covers that moment. #7 is no longer "Mr. Aguilar's Map", so issue A1 is resolved.
- **Key items** #7–#21, #23 and #24 are in `KEY_ITEMS` in `src/data.ts`.
- **Scenario D "Open Hand"** (stored as number 103) is placed on top of the Scenario deck when players finish Quest #3 Wave 3: Dahlia watched the fight and reaches out to them. It is a second route into Quest #4 besides Dahlia's Cave. Choice A uses a new scenario effect, `reveal-quest-or-grant-chip`, which adds Quest #4, or gives 1 Memory Chip if the players already own or completed it. The card front reads "Discard this card and draw the next Scenario if this is Chapter 5 or later", because Dahlia is executed at the start of Chapter 5. That discard is printed text only; the game has no Chapter 5 yet. Tests are in `scenarioCard.test.ts`.
- **Scenario cards** #10–#17, Scenario C and Scenario D (stored as number 102) are in `SCENARIO_CARDS`. Every choice auto-applies its effects using the existing effect kinds.
- The "flagged" effects below were swapped for existing ones. Ira, Elias and Dahlia opinion changes use `shift-favour-by-scenario` with the new character ids `ira`, `elias` and `dahlia`. Their opinion cards (all four levels) are cropped from the prototype PDF and registered in `OPINION_CARDS`.
- **Art** for key items #7–21, #23, #24 and scenario cards #10–17, C and D is cropped from the prototype materials PDF by `scripts/extractGameMaterials.py` + `scripts/applyGameMaterials.py` (see README "Chapter 3 notes").
- **Not wired up yet**, because the chapter content doesn't exist in the game: the Chapter 3/4 town visits and quests that hand these out, and Scenario C's placement on top of the deck.
- Scenario B's "revenge for my mom" line (A9) is unchanged, because it is printed on the existing card art.

## Part 1 — Plot inconsistencies & issues

### A. Contradicts what the Ch1–2 prototype already says

| # | Issue | Where | Suggested fix |
|---|---|---|---|
| A1 | **Key Item #7 is double-booked.** The game's #7 is *Mr. Aguilar's Map* (card art already exists). The draft gives #7 to Elias at the end of Quest #7. | Q7 resolution | Give Elias's reward a new number (proposed **#25**, below). Grant *Mr. Aguilar's Map* (#7) where Rodrigo hands over his father's map (Ch2 Library C, alongside Quest #6). |
| A2 | **Rodrigo sells the map he already gave away.** In Ch2 he *gives* you his father's map to Second Nest (reveals Quest #6). Ch3 and Ch4 Jobs Boards have him *selling* it for 5 minion parts, after his father has died. | Ch3/Ch4 Jobs Board B | Keep Quest #6 on both job boards as a second way to get it, but change who's offering it. Option 1 (keeps the 5-part cost): a Shadow District fence sells a copy Mr. Aguilar made for an old delving partner. Option 2 (free): Rodrigo pins his dad's map up himself, saying "Dad would want it used." Either way, use the book's usual fallback: "If already owned or completed, instead gain a Memory Chip token." No conditional appearance. |
| A3 | **Quest #6 has three names and two locations.** The game calls it "The Forgotten Vault". The draft calls it "Second Nest Ruins" and "Storm Nest Ruins". Ch2 says the map leads to Second Nest, but Q6's wave text is set at Storm Nest. Bram also mentions "Storm's Nest". | Q6, Ch4 Jobs Board, X.1 | Pick one quest title and one location. |
| A4 | **Quest #5's card calls Vera "deceased".** Quest #5 is revealed in Ch2, while Vera is still officially missing, so it can be played *before* Ch3 announces her body was found. | Q5 card summary | Change it to "tracks made by Vera Brass's delversuit". |
| A5 | **The disciples are wrong.** The game's heroes are Mind (#1) and Body (#2). Ch3 says "Disciple of the **Soul** player – gain Hero #8", and Ch4 Library A uses "Disciple of the Soul" for Shop Product #47. | Ch3 New Recruits, Ch4 Library A | Use **Body**, unless a Soul suit is coming. |
| A6 | **"Damage tokens" should be Story tokens.** Ch2 uses **Story tokens** to count location visits. Ch3 says "Collectively gain 4 damage tokens", and every location says "Discard 1 damage token". Ch4 never says how many tokens you get. | Ch3/Ch4 Explore the Town | Rename them to Story tokens and give Ch4 a count. |
| A7 | **Xavier "introduces" Tidebloom twice.** In Ch2 (Academy B with Key Item #2) and on the Jobs Board he has already named the Tidebloom. In Ch3 at Dahlia's Cave A he presents it as a new discovery ("I've been calling it Tidebloom"). | Ch3 Dahlia's Cave A | Reword it as a confirmation, e.g. "This is the Tidebloom I told you about, but at a scale I've never seen". |
| A8 | **Quest #3's goal is never completed.** The quest is "collect a Tidebloom sample". In 3.4 you rescue Dahlia but never collect a sample. | Q3 3.4 | Make the Key Item #12 reward the sample (see Part 2). |
| A9 | **Scenario Card B (Heirloom, already in the game) contradicts Ch3/4.** Xavier says "getting revenge for my mom… back when she was human", which implies she's dead. In Ch3/4 Dahlia is alive and you visit her. | `src/data.ts` Scenario B | Change it to "about what you did for my mom… something she owned back when she was human". |
| A10 | **Vera's Ally opinion card needs retiring.** Ch3 says to cross out Vera's section of the Campaign Sheet, but the game hands out a Vera Ally card in Ch1 and has "Vera-shield" logic. | Ch3 Story So Far | Decide what happens to an owned Vera card. It could convert to a memento or be discarded with a small compensation. |
| A11 | **Elayna vs Elayne.** The game's opinion card id/name is `elayne` / "Elayne". Every text in the book says Elayna. | `src/data.ts` OPINION_CARDS | Pick one spelling. |
| A12 | **The surveillance footage is misdescribed.** Ch4 Temple B says Flores used "footage from the watchtower fire". The device was the perimeter camera from Quest #2, and Bram told you it showed nothing. | Ch4 Temple B | Use "the surveillance device's footage". This also confirms Flores lied to Bram, which is a nice beat. |

### B. Inconsistencies inside the Ch3–4 draft

| # | Issue | Where |
|---|---|---|
| B1 | **Who believes what about the Tidekin.** Dahlia's Cave B says you heard Tidekin stories "that all sounded like pure legend". Flores says Bird's Nest has had "peaceful, if distant, relations with the Tidekin for generations". Ira says Tidekin killed her parents at the Burning Fields. The fisherman says "they've always hated us". The town needs one shared common knowledge. A good option is "legend to most people, known to the elders". |
| B2 | **Bram switches sides.** In Ch3 Part 3 it's Bram who declares "The Tidekin are upon us. I warned Father Flores". Ch4's Story So Far credits Ira with that claim, and in Ch4 Town Square Bram is the moderate holding Ira back. Either give the Ch3 line to Ira or show Bram changing his mind. |
| B3 | **Did you know about the basement?** Ch3 Crypt A has you remember "a hatch leading to the basement" with the same green paint. Quest #13 2nd wave text says "You had no idea the Watchtower even had a basement". The Q13 card also says "a secret basement in the basement". |
| B4 | **Dahlia's face.** In Q3 3.4 a crimson bloom grows "where her nose and eyes should be… if she even has any". In Ch3 Cave she has a "delicate nose and mouth" and "deep blue eyes". |
| B5 | **Dahlia's speech.** She speaks in stilted fragments everywhere except Ch4 Cave B ("I cannot be certain… but I suspect that these tissues have been engineered…"). |
| B6 | **Ch4 Dahlia's Cave is unfinished.** The intro stops mid-sentence ("If you could"). Options A and C mention "your elders" and the information they hold, which nothing has set up. Option B says "carnation", probably meaning Carnatia. |
| B7 | **Janus's age and timing.** In Ch4 Temple C Janus is "just a few days old", but Quest #5 can be completed between Ch2 and Ch3, which makes him weeks old. Elias also calls him **"James"** twice in the Secret Town Visit. |
| B8 | **Janus is hidden in Flores's orphanage.** Bram is told to hide the baby, and Elias says Flores will kill him. Bram then places him in the Children of Gaia orphanage, run by Flores's followers and tended by his own aunt. This works if it's deliberate (Bram is suspect), but then the book should call attention to it. Otherwise it reads as a plot hole. |
| B9 | **Was Janus left behind or kept?** In the Q7 conclusion Elias says "Margaret said she would protect him". In the Secret Town Visit he says "I left a kid behind in my rush for the exit". |
| B10 | **High Nest vs First Nest.** Q7's card says Vera's suit is at High Nest, but the goal is "Reach the ruins of First Nest". The conclusion takes place at High Nest and the Secret Town Visit at First Nest. 7.5 says High Nest "had another name" and was the first to fall, while 11.5 says Second Nest was the last to fall. A short canon list of the seven Nests would settle this. |
| B11 | **Bram calls the lab a prank.** At the end of Q13 he laughs off a creature lab under his own watchtower, even though in Ch3 he told you the fire and the generator "must be connected". This makes sense if Bram is complicit. If he isn't, it's out of character. |
| B12 | **Carlos's death is never shown.** Ch4 Machinist ("My cousin is dead!") is the first mention. The Ch4 attack (Town Square, X.1/X.2) should include the beat where Carlos falls. |
| B13 | **Everyone limps.** Bram "limps up to the podium" in Ch3 Part 2, and Flores has a mystery limp in Ch3 Temple. If Flores's limp is a clue (he fought Margaret), Bram's limp muddies it. |
| B14 | **Titles drift.** "Master Bram" becomes "Delvemaster Bram" and "Delve Master". "Headmistress Arlen" becomes "Professor Arlen". Bram is described as a professor in Q1, yet Arlen runs the Academy. |
| B15 | **Witness's movement keeps changing.** In Q2 he floats and hovers. In the draft he glides, rolls, stomps, "starts walking" and grinds a rock "beneath him". He also drags a "metal cart" that hasn't been mentioned before. |
| B16 | **Xavier's face markings.** He has glowing blue face markings in the mist (Q2 page2_7, Ch3 Cave). Ch1's pub description only mentions his mismatched eyes. Either the markings only show in the mist, or Ch1 should mention them. |

### C. Branching / rules bugs (mechanical, but they break the story)

- **Q7 7.7 / 7.8 are swapped.** "If delvers die" leads to the success text, and "both survive" leads to the blackout text.
- **Q4 4.2:** choosing "Attack the creatures" goes to 4.3, which ends the quest. The trailing "OPTION / Delvers heal up to 2 HP" is orphaned.
- **Q4 4.6** (retreat) says "Your Quest is complete!" This lets players claim in Ch4 Town Square B that they've "spoken to the Tidekin" without reaching 4.5.
- **The Soothsayer bosses** (Carnatia, Ruined Tidekin, Unknown Warden, Perfected Revenant) kill both delvers at the end of the wave. That makes the "both survive / continue / retreat" branches after them unreachable (4.9, 3.6/3.7, 8.11).
- **Shop gating overlaps:** Ch2 already gates #13 (2+ clues) and #14 (4+). Ch3 then adds #13–18 and gates #19 on **2–4** clues, so 5+ gets only #20 and not #19. Ch4 adds #19–24, overlapping again. "2–4" should probably be "2+".
- **Key Item #3 (Woo's Diary)** is offered again in Ch4 Library A, with no fallback if you already own it.
- **Ch3 Jobs Board:** Samantha penalises you for having no open quests, but Ch4 uses Arlen. Ch4's version also leaves out "Roll a die".
- Typos worth catching: "Xander" (should be Xavier), "Examinates" (Exanimates), "TIKEKIN", "curtm", "Elia's", "she has to be one of us to make it" (Bram's funeral line is garbled), "the sight" (site).

---

## Part 2 — Key Item proposals (Ch3 & Ch4)

The **clue count** feeds the existing shop and quest gates: 2+/4+ in Ch2, 2–4/5+ in Ch3, and "4+" at Ch3 Academy A and Ch4 Library C. Town-visit evidence is worth 1 clue and major revelations 2, so a thorough player crosses 5+ around the end of Ch3.

### Granted during the Ch3 / Ch4 Town Visits

| # | Name | Source | Clues | Card text |
|---|---|---|---|---|
| 8 | **Corroded Vial** | Ch3 Festival Part 2 B | 1 | *The glass is pitted where the purple liquid ate through it. Whatever bled on the generator wasn't any blood you know.* |
| 9 | **Green Paint Chips** | Ch3 Festival Part 2 A | 1 | *Flakes of bright green paint pried from the claw marks. You've seen this exact shade somewhere before.* |
| 10 | **Overheard Argument** | Ch3 Festival Part 1 B | 1 | *"Their accusations that we've abducted their kin are troubling." Abducted? Flores waved it away a little too quickly.* |
| 21 | **Dahlia's Theory** | Ch4 Dahlia's Cave B | 1 | *"Engineered. Puppets." If she's right, these attacks weren't made by the Tidekin. They were done to them.* |

### Granted by quests that open in Ch3 / Ch4

| # | Name | Source | Clues | Card text |
|---|---|---|---|---|
| 12 | **Tidebloom Sample** | Q3 (slay the Carnatia) | 1 | *A crimson bloom cut from the Carnatia's tendrils, still pulsing in its jar. Dahlia called the attack "wrong". Xavier will want this.* (Fixes A8.) |
| 14 | **Salvio's Scales** | Q4 (slay the Ruined Tidekin) | 2 | *Scales rubbed raw where shackles held him. Needle marks across his chest. Salvio didn't turn into a monster. Someone made him one.* |
| 11 | **Janus's Name Tag** | Q5 (High Nest) | 2 | *"Janus", hand-stitched in crude fibres. The mist won't settle on it. You promised Bram you'd tell no one.* |
| 25 | **A Child's Drawing** *(was #7)* | Q7 (Elias) | 1 | *Three children, a robot and a glowing sun, drawn in charcoal. Savannah pressed it into your hand: "So you don't forget us."* |
| 13 | **Elias's Confession** | Q7 Secret Town Visit | 2 | *A lab beneath the watchtower. A creature in a tank. A figure in a lab coat. And Margaret's last warning: Flores is a "Warden".* |
| 20 | **Specimen Label** | Q13 (Underneath the Watchtower) | 2 | *Peeled from an empty pod: "Subject V.: graft stable." By morning the pods were gone, but the neat handwriting remains.* (Gives the player proof after Bram's "prank" line and points toward Ira and Vera's Revenant.) |

### Later-chapter items (they appear in the draft's Q8–Q14 and are drafted here for completeness)

| # | Name | Source | Clues | Card text |
|---|---|---|---|---|
| 15 | **Shard of the Orb** | Q8 The Bridge | 2 | *A fragment of the Warden's floating orb. It hums at the same pitch as Witness.* |
| 16 | **Warden's Wing** | Q9 Sins of the Father | 1 | *Witness wears it pinned to his chest like a war medal. From every feather, Flores's eyes stare back.* |
| 17 | **Gabriel's Diary** | Q10 A Glimpse of the Past | 2 | *"Property of Gabriel", with a dinosaur drawn beside the name. The handwriting belongs to a frightened child.* |
| 18 | **The Tablet Rubbing** | Q11 The Tablet | 2 | *"Gaia honoured her disciple Gabriel… and he refused. And the Ark sailed."* |
| 19 | **Ark Transmission** | Q12 The Ark | 2 | *"ETA 15 Earth years. Try not to die before then. Ark out."* |
| 23 | **Ira in Chains** | Q14, Ira saved | 1 | *Locked in the Valiant's engine room, still screaming that you've doomed everyone.* |
| 24 | **Ira's Whistle** | Q14, Ira abandoned | 1 | *The silver whistle she used to command her "children". It lay in the wreckage.* |

---

## Part 3 — Scenario Card proposals (Ch3 & Ch4 quests)

**Why new cards:** the Ch3/Ch4 quests call "Draw the top card from the Scenario Deck" at the start of up to 13 waves (Q3 ×3, Q4 ×2, Q5 ×2, Q6 ×3, Q7 ×2, Q13 ×3). After Ch2 the printed deck only has #03–#09 left, and its theme is snowy. The cards below are themed on the Ch3/4 plot. Every effect uses the existing `ScenarioCardEffect` union, so they can be wired in without engine changes. **Flagged** effects would need a new effect kind or a new opinion character.

### #10 — Lantern
*A paper festival lantern drifts through the mist, its candle still burning. A name is written on its side: someone set it loose for the Memorial.*
- **A. Follow it.** It leads you to a sheltered hollow. Roll a die. **1–2:** something was already sheltering there, and each delver loses 2 HP (can't go below 1). **3–6:** a previous delver's cache. Gain a Level card.
- **B. Let it drift and say the name aloud.** A moment of peace. Both delvers heal 2 HP.
- **C. Salvage the candle.** The wax is laced with creature oil. Choose one delver to gain +1 Rank of Battery.

### #11 — Runoff
*A rusted pipe juts out of a cliff face, spilling black sludge into the Tide. The plants around it have withered to husks. The pipe runs uphill, toward Bird's Nest.*
- **A. Seal it.** You hammer it shut, but the fumes sting. Each delver loses 1 HP (can't go below 1). Add a Friendly Spawn Card to the Spawn Deck.
- **B. Follow the pipe.** It ends at a sealed grate stamped with a green hatch. Gain a Level card. *(Optional: also grant a Memory Chip. **Flagged:** needs a `grant-memory-chip` scenario effect.)*
- **C. Leave it.** It isn't your mission. Delvers gain 1 Element of their choice.

### #12 — Clawprints
*Huge, fresh prints, each with a deep gouge where a single claw drags. Bioluminescent residue glows in every one. They're headed toward the coast.*
- **A. Track it.** Roll a die. **1–3:** it was waiting for you, and one delver loses 3 HP (can't go below 1). **4–6:** you catch it sleeping and strike first. One delver gains a Universal 2× Damage token.
- **B. Cover your trail.** One delver gains 1 AP.
- **C. Take a cast of the print for Xavier.** Increase Xavier's opinion.

### #13 — Take Something, Leave Something
*A delvers' waystation hides behind a fallen wall: two bedrolls, a firepit, and a box marked "Take something, leave something."*
- **A. Take something.** Gain a Level card. Each delver loses 1 Element (**flagged:** there's only `lose-all-elements-both` today. Alternatively, use "reduce max HP by 1".)
- **B. Leave something.** You leave a ration and a note. Rest easy. Both delvers heal 3 HP.
- **C. Carve your names on the wall.** Delvers gain 1 Element of their choice.

### #14 — Siren Song
*A low, beautiful humming rolls through the mist. Through the kelp you see them: Sirens, swaying in a circle. Dr Ira's notes called them docile.*
- **A. Listen.** It's like being sung to sleep. Both delvers heal 2 HP.
- **B. Plug your ears and push on.** One delver gains 1 AP.
- **C. Capture one for Dr Ira's research.** It screams the whole way. Delvers reduce their max HP by 1, and you gain Shop Product #__ (TBD). (**Flagged:** "Increase Dr Ira's opinion" needs an `ira` opinion character.)

### #15 — Static
*Witness stops dead. His eyes flicker and project a blurry image of a cold room and a small bed. Then he whirs and carries on as if nothing happened.*
- **A. Wait with him.** Witness's lights steady. Both delvers heal 1 HP and gain 1 Element of their choice.
- **B. Tap the side of his head.** The projection snaps off and a spare part drops out. Choose one delver to gain +1 Rank of OS.
- **C. Keep moving.** Gain 2 XP.

### #16 — Puppet
*One of the creatures stands perfectly still in a clearing. A metal port sits in the back of its neck, with a needle still in it.*
- **A. Pull the needle.** It collapses, then looks at you with clear eyes before fleeing. One delver loses 2 HP (can't go below 1). Add a Friendly Spawn Card to the Spawn Deck.
- **B. Put it out of its misery.** Delvers gain 1 Element of their choice.
- **C. Pocket the needle as evidence.** Gain a Prevent Counterattack token (one delver). (**Flagged:** a key-item grant would need a `gain-key-item` scenario effect.)

### #17 — Small Footprints
*Tiny bare footprints cross the mud, and the mist curls away from each one as if repelled.*
- **A. Follow them.** They end at an empty camp with a child's toy left behind. Add a Friendly Spawn Card to the Spawn Deck.
- **B. Brush them away so no one else can follow.** Increase Elias's opinion. (**Flagged:** needs an `elias` opinion character. Alternatively, use "Gain 2 XP".)
- **C. Mark them on your map.** Gain a Level card.

### Lettered card proposal — Scenario C, "Elders"
Placed on top of the deck from **Ch4 Dahlia's Cave A** ("Commit to seeking diplomacy"), mirroring how Ch3 Cave A places Scenario A.

*Branch-like fingers part the mist. A Tidekin elder blocks your path, watching you without a sound.*
- **A. Lower your weapons.** The elder touches your helmet, and a vision of a pipe pouring black sludge fills your mind. Both delvers heal 2 HP. Increase Dahlia's opinion (**flagged:** `dahlia` id).
- **B. Offer a creature part as a gift.** The elder takes it and vanishes. Gain Shop Product #__ (TBD, a Tidekin-made item).
- **C. Raise your weapons.** The elder is gone before you blink. Delvers gain 2 Elements of their choice, and reduce max HP by 1.

---

## Engine / data follow-ups this would need

- New `KEY_ITEMS` entries: #8–#21, #23–#25 (plus card art).
- New `SCENARIO_CARDS` entries #10–#17 and Scenario C (number 102), plus art.
- Opinion characters that Ch3/4 shift but the game doesn't have yet: **elayna** (vs. the existing `elayne`), **flores** (has an ally card only), **ira**, **bram**, **rodrigo**, **dahlia**, **elias**. Detractor/Ally cards for each.
- Possible new scenario effect kinds: `grant-memory-chip`, `gain-key-item`, `lose-element-each`.
