"""Build data/chapter3.json (Chapter 3 Town Visit, "The Memorial Festival")
from the revised Chapter 3 text. Edit this script, not the JSON.

Usage: python -I scripts/buildChapter3.py <G2G root>"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from questPages import add_quest_pages, report_choices  # noqa: E402

T = "CHAPTER 3 - THE MEMORIAL FESTIVAL"
TV = "CHAPTER 3 - TOWN VISIT"
pages = {}


def page(pid, title, subtitle, text, **kw):
    p = {"title": title, "subtitle": subtitle, "text": text}
    p.update(kw)
    pages[pid] = p


def choice(label, key, nxt, **kw):
    c = {"label": label, "decisionKey": key, "next": nxt}
    c.update(kw)
    return c


def fav(cid, name, delta):
    return {"kind": "shift-favour", "characterId": cid, "characterName": name, "delta": delta}


def rec(key):
    return {"kind": "record-decision", "key": key}


def spend():
    return {"kind": "spend-story-token"}


def chip_or_quest(n, name):
    return {"kind": "reveal-quest-or-grant-chip", "number": n, "name": name, "chipFallback": 1}


BACK = "Return to the town"
HUB = "ch3-hub"
FAV_FOOT = "Unless {n}'s opinion is now neutral, gain the matching opinion card."

# ---------------------------------------------------------------- opening
page("ch3-story-so-far", T, "The Story So Far",
     "A few weeks have passed since the watchtower burned down. In the process of clearing out its remnants, the badly burned body of Vera Brass is found. All of Bird's Nest mourns her passing.\n\n"
     "\"I can't believe she's gone,\" says Master Bram at her funeral. \"I really thought she would be the one to reach Gaia.\"\n\n"
     "No other bodies were found at the site, leaving the location of Vera's brother Elias a mystery. Her delversuit is also still missing, adding weight to the theory that Elias may have run off into the Tide with it.\n\n"
     "With the watchtower cleared, rebuilding efforts begin. It will be months before it is fully functional, but enough has been restored for delving to commence once more.",
     image="/story/ch2/master-bram.png",
     footnote="Vera Brass is crossed off the Campaign Sheet. If you still hold the Vera Ally opinion card, discard it.",
     onEnter=[
         {"kind": "discard-opinion-card", "characterId": "vera", "level": "ally"},
         rec("ch3.story-so-far.vera-crossed-out"),
     ],
     next="ch3-quest-report-intro")

page("ch3-quest-report-intro", T, "Into the Tide",
     "It is once again time for you to venture into the Tide. You can complete up to 2 Quests from your Open Quests before continuing the story in the Chapter 3 Town Visit.\n\n"
     "Choose the Quest you will attempt first. You must attempt at least one Quest before the Town Visit.",
     footnote="Collectively gain 2 Story tokens - one per Quest you can complete before this Town Visit.",
     onEnter=[{"kind": "grant-story-tokens", "amount": 2}],
     choices=report_choices("ch3", choice))

page("ch3-quest-report", T, "Quest Report",
     "Attempt another Quest, or continue to the Town Visit. Each Quest you play spends a Story token.",
     choices=[
         *report_choices("ch3", choice),
         choice("Continue to the Town Visit", "ch3.report.done", "ch3-arrival"),
     ])

add_quest_pages(page, choice, "ch3", T, "ch3-quest-report")

# ---------------------------------------------------------------- arrival
page("ch3-arrival", TV, "The Festival Begins",
     "It's evening when you ascend from the mist. Off in the distance you hear the low thumping of a bass drum. Aid is provided to you quickly and efficiently as you are waved forward to the festival that has already begun.",
     choices=[
         choice("Both delvers survived", "ch3.arrival.both-survived", "ch3-new-recruits", requireQuestDeaths="none"),
         choice("One or both delvers died", "ch3.arrival.died", "ch3-died", requireQuestDeaths="any"),
     ])

page("ch3-died", TV, "The Fallen",
     "You bring your fallen delvers home to Bird's Nest. Their final words are already recorded in the Graveyard on your Campaign Sheet.",
     footnote="If the delver that died is your last remaining Hero card, don't discard them.",
     choices=[
         choice("Only the Mind delver died", "ch3.arrival.died.mind", "ch3-died-mind", requireQuestDeaths="mind-only"),
         choice("Only the Body delver died", "ch3.arrival.died.body", "ch3-died-body", requireQuestDeaths="body-only"),
         choice("Both delvers died", "ch3.arrival.died.both", "ch3-died-both", requireQuestDeaths="both"),
     ])
for who, picks in (("mind", [{"delta": 1, "pinnedHeroId": "hero-01"}]),
                   ("body", [{"delta": 1, "pinnedHeroId": "hero-02"}]),
                   ("both", [{"delta": 1, "pinnedHeroId": "hero-01"}, {"delta": 1, "pinnedHeroId": "hero-02"}])):
    label = {"mind": "Mind Delver's", "body": "Body Delver's", "both": "Both Delvers'"}[who]
    page(f"ch3-died-{who}", TV, f"{label} Blood-Soaked Suit",
         "Blood seeps into the crevices of the Delversuit, filling it with new power.",
         footnote="Add Rank 1 of any one Equipment to an Equipment Slot of your choice on the Suit Condition sheet.",
         onEnter=[{"kind": "enqueue-suit-condition-rank-picks", "source": f"ch3.arrival.died.{who}", "picks": picks}],
         next="ch3-new-recruits")

page("ch3-new-recruits", TV, "Meet the New Recruits",
     "As you make your way to the courtyard, two fresh graduates fall in step beside you, eager to see their first Memorial Festival as delvers.",
     image="/story/ch2/new-recruits.png",
     footnote="Disciple of the Mind player gains Hero #7. Disciple of the Body player gains Hero #8.",
     onEnter=[{"kind": "unlock-hero-cards", "cardNumbers": [7, 8]}],
     next="ch3-festival-1")

# ---------------------------------------------------------------- festival part 1
page("ch3-festival-1", "THE MEMORIAL FESTIVAL - PART 1", "A Night to Remember",
     "The courtyard is lit with hanging lanterns and string lights, enveloping the people of Bird's Nest in a warm glow. Joyful music plays as people dance on the cobbled yard, sharing food and drinks.\n\n"
     "Elayna Woo is at the bar, swirling a drink in her hand. Her eyes have a faraway look to them, and they seem to be brimming with tears.\n\n"
     "While Father Flores is helping serve food for the guests, Dr Ira is talking to him in a frantic whisper. You wonder why she seems so agitated.\n\n"
     "Xavier is intently looking at a potted plant that seems to be glowing and swaying slightly to the music.\n\n"
     "At the nearby tables, Samantha is playing cards with one of her delver cousins. \"Hey, you two! Care for a game of cards? Carlos here isn't giving me much of a challenge.\"",
     pageBackground="/story/ch2/town-center-skyline.png",
     choices=[
         choice("Check on Elayna", "ch3.f1.A.elayna", "ch3-f1-a", hint="Affects Favor"),
         choice("Attempt to eavesdrop on Flores and Ira's conversation", "ch3.f1.B.eavesdrop", "ch3-f1-b", hint="Grants Knowledge"),
         choice("Accept Samantha's challenge", "ch3.f1.C.samantha", "ch3-f1-c", hint="Affects Favor"),
         choice("Hang out with Xavier", "ch3.f1.D.xavier", "ch3-f1-d", hint="Affects Favor"),
     ])
page("ch3-f1-a", "THE MEMORIAL FESTIVAL", "Elayna",
     "Elayna frantically wipes at her eyes when she notices you approach.\n\n"
     "\"We're here to honor all the delvers who made it to Gaia,\" she says quietly. \"Y'know... I was only 7 when Margaret went into the Tide for the last time. I made her promise she'd return. But she never did. Maybe she had no choice. Or maybe salvation was better than coming home to an annoying little sister.\"\n\n"
     "There's a bitterness in her voice you've never heard before. After a moment, she gives you a sad smile, grateful for your listening ear.",
     image="/story/ch2/nurse-elayna.png", footnote="Increase Elayna's opinion. " + FAV_FOOT.format(n="Elayna"),
     onEnter=[fav("elayne", "Elayna", 1)], next="ch3-festival-2")
page("ch3-f1-b", "THE MEMORIAL FESTIVAL", "Eavesdropping",
     "You're not hungry, but if you pretend to get some food maybe you can overhear Father Flores and Dr Ira's conversation.",
     dieRoll=[{"min": 1, "max": 1, "label": "1: Too eager", "next": "ch3-f1-b-fail"},
              {"min": 2, "max": 6, "label": "2-6: You overhear them", "next": "ch3-f1-b-success"}])
page("ch3-f1-b-fail", "THE MEMORIAL FESTIVAL", "Too Eager",
     "You inch along the line, eyes focused on the pair. But you're too eager and bump into the person in front of you, dropping your plate and making a mess. An irritated Dr Ira reprimands you. \"Be more careful, delvers! We don't have food to spare here, as you well know.\"",
     image="/story/dr-ira.png", footnote="The active delver loses 2 minion parts.",
     onEnter=[{"kind": "lose-minion-parts", "amount": 2, "to": "active-delver"}], next="ch3-festival-2")
page("ch3-f1-b-success", "THE MEMORIAL FESTIVAL", "Abducted Kin",
     "As you inch along, you overhear Dr Ira saying, \"Flores, burying your head in the sand will solve nothing. The Tidekin threat draws nearer every day. By the time they're at our doorstep, it'll be too late!\"\n\n"
     "Flores quietly but firmly responds, \"You exaggerate as always, Doctor. We've maintained peaceful, if distant, relations with the Tidekin for generations and this situation will be no different. Their accusations that we've abducted their kin are troubling, of course, but cooler heads will prevail. Now, if you'll excuse me...\" Father Flores disappears into the crowd.",
     image="/story/father-flores.png", footnote="Add Key Item #10.",
     onEnter=[{"kind": "gain-key-item", "number": 10, "name": "Abducted Tidekin"}], next="ch3-festival-2")
page("ch3-f1-c", "THE MEMORIAL FESTIVAL", "Speed",
     "Samantha challenges you to a game of Speed, which she proceeds to trounce you at repeatedly.\n\n"
     "\"How on earth did you manage to survive all those monsters when you can't even escape my hand!\" she playfully taunts.",
     image="/story/ch2/machinist-samantha.png", footnote="Increase Samantha's opinion. " + FAV_FOOT.format(n="Samantha"),
     onEnter=[fav("samantha", "Samantha", 1)], next="ch3-festival-2")
page("ch3-f1-d", "THE MEMORIAL FESTIVAL", "Tidal Plant Morphology",
     "\"Excellent. I planted this flower in the Tide weeks ago. Now look at how it reacts to music. It's moving! The fascinating thing is--\" Xavier proceeds to regale you with details about the strange and wonderful world of tidal plant morphology.",
     image="/story/ch2/academy-xavier.png", footnote="Increase Xavier's opinion. " + FAV_FOOT.format(n="Xavier"),
     onEnter=[fav("xavier", "Xavier", 1)], next="ch3-festival-2")

# ---------------------------------------------------------------- festival part 2
page("ch3-festival-2", "THE MEMORIAL FESTIVAL - PART 2", "Lights Out",
     "Master Bram steps up to the podium and smiles at his audience as the music dies down.\n\n"
     "\"I want to thank everyone for being here. Tonight, we honor the delvers who journeyed through the Tide, faced insurmountable odds, and reached Gaia. Though they left us... ascended for the survival of our people, their presence is felt still. To Margaret Woo, Jonah Stone, and every other delver that came before them - we honor you with this work of art.\"\n\n"
     "Bram pulls a woolen tarp off a giant sculpted-metal canvas: armored delvers stand triumphantly in the foreground, the Gaia monolith behind them. \"We raise a glass to you.\" Glasses clink - and suddenly all the lights go out, not just in the courtyard but across all of Bird's Nest. \"Oh no, my dad!\" Rodrigo's voice rings out in the darkness.\n\n"
     "Master Bram lights a lantern and the crowd calms down a little. \"Sam, you know what to do. Delvers, give her a hand.\" Witness's eyes light your path down to the nearest generator. Sparks fly from giant claw marks torn into its casing, and a purple substance sizzles on its side.\n\n"
     "\"I don't like this,\" Sam says quietly. While she starts the repairs, you look for clues.",
     image="/story/ch2/master-bram.png",
     choices=[
         choice("Examine the claw marks more closely", "ch3.f2.A.claws", "ch3-f2-a", hint="Grants Knowledge"),
         choice("Examine the substance", "ch3.f2.B.substance", "ch3-f2-b", hint="Grants Knowledge"),
     ])
page("ch3-f2-a", "THE MEMORIAL FESTIVAL", "Claw Marks",
     "The giant claws ripped a chunk out of the generator's outer protector. Your eyes zero in on a bright green speck - paint chips. The color is familiar, but right now you cannot place it.",
     footnote="Add Key Item #9.", onEnter=[{"kind": "gain-key-item", "number": 9, "name": "Green Paint Chips"}], next="ch3-festival-3")
page("ch3-f2-b", "THE MEMORIAL FESTIVAL", "The Substance",
     "Smoke rises from drops of purple liquid on the ground. You uncork a small glass vial from your utility belt and take a sample, but the liquid burns a hole through the glass. You store the remnants for later.",
     footnote="Add Key Item #8.", onEnter=[{"kind": "gain-key-item", "number": 8, "name": "Melted Vial"}], next="ch3-festival-3")

# ---------------------------------------------------------------- festival part 3
page("ch3-festival-3", "THE MEMORIAL FESTIVAL - PART 3", "The Culprit",
     "\"Here goes nothing...\" Sam murmurs. Light returns to Bird's Nest. Nearby, Witness lets out a piercing beep - you find a hulking creature collapsed on the ground, smoke rising from its slimy form. With Witness's help, you drag it to the courtyard.\n\n"
     "Bram studies the creature in grim silence. \"Gaia protect us...\" Dr Ira whispers, looking at it in horror. \"I was afraid of this... I warned Father Flores. The Tidekin are upon us.\" The crowd begins clamoring for answers.\n\n"
     "\"The Tidekin are not known to be aggressive.\" Xavier's calm voice lingers in the air.\n\n"
     "Ira's eyes flash over to him. \"Tell that to the people that were killed in the Burning Fields, like my parents. I know you have a soft spot for the creatures of the Tide, Xavier. But open your eyes!\"\n\n"
     "Bram steps in between them. \"Now's not the time, and nobody should jump to conclusions. The celebration is clearly over. Dr Ira, I suspect you have patients to attend to.\" He turns to the crowd. \"Trust me, the delvers will get to the bottom of this.\"",
     image="/story/dr-ira.png", next="ch3-bram-comm")
page("ch3-bram-comm", TV, "A Comm from Master Bram",
     "Nearly a week has gone by, but the ripples from the outage are still felt throughout Bird's Nest. You receive a comm from Bram early in the morning.\n\n"
     "\"You did great work on the night of the outage, delvers. The fire at the watchtower and the generator attack... they must be connected. But we won't find the answers sitting around. Dr Ira's performing an autopsy on the creature you found. I'm meeting Headmistress Arlen at the Delving Academy to see if we can make sense of this. We'll speak later.\"\n\n"
     "With some time on your hands, you wonder how you can help.",
     image="/story/ch2/master-bram.png",
     footnote="Collectively gain 4 Story tokens - these represent the total number of locations you can visit this Chapter.",
     onEnter=[{"kind": "grant-story-tokens", "amount": 4}], next=HUB)

page(HUB, TV, "Explore the Town",
     "Choose a location to visit. Each visit spends 1 Story token. Once they're spent, head to the Town Center.",
     layout=None,
     choices=[
         choice("Meet Doctor Ira at the Crypt", "ch3.hub.crypt", "ch3-crypt", requireStoryTokens="positive", hideIfDecisionMade="ch3.hub.crypt"),
         choice("Join the congregation at the Temple of Gaia", "ch3.hub.temple", "ch3-temple", requireStoryTokens="positive", hideIfDecisionMade="ch3.hub.temple"),
         choice("Explore the Shadow District", "ch3.hub.shadow", "ch3-shadow", requireStoryTokens="positive", hideIfDecisionMade="ch3.hub.shadow"),
         choice("Visit the Machinist", "ch3.hub.machinist", "ch3-machinist", requireStoryTokens="positive", hideIfDecisionMade="ch3.hub.machinist"),
         choice("Visit Bram at the Academy", "ch3.hub.academy", "ch3-academy", requireStoryTokens="positive", hideIfDecisionMade="ch3.hub.academy"),
         choice("See what Xavier is up to", "ch3.hub.dahlia", "ch3-dahlia", hint="Requires Quest #03 completed",
                requireStoryTokens="positive", hideIfDecisionMade="ch3.hub.dahlia", requireDecision="quest.3.completed"),
         choice("Continue to the Town Center", "ch3.hub.done", "ch3-town-center", requireStoryTokens="zero"),
     ])
del pages[HUB]["layout"]

# ---------------------------------------------------------------- crypt
page("ch3-crypt", "THE CRYPT", "Dr Ira's Autopsy",
     "The crypt is a mortuary built into the caverns at the base of Bird's Nest. Dr Ira sighs when she sees you, but softens when you tell her Bram didn't send you. The creature is so massive her assistants made a table from a concrete slab.\n\n"
     "\"Its heart seems to have stopped, possibly from electrocution after it attacked the generator. It once stood on two powerful legs and used its giant claws for movement as well.\"\n\n"
     "You ask whether it's connected to the watchtower. \"Almost certainly. When I did the autopsy on Vera Brass, I found that she did not die from smoke inhalation. She died from blood loss, and her body had giant gashes consistent with this creature's physiology.\"",
     image="/story/dr-ira.png", onEnter=[spend()],
     choices=[choice("Examine the body", "ch3.crypt.A", "ch3-crypt-a", hint="Grants Knowledge"),
              choice("Examine Dr Ira's notes", "ch3.crypt.B", "ch3-crypt-b", hint="Grants Wisdom")])
page("ch3-crypt-a", "THE CRYPT", "Green Paint",
     "Examining the creature's claws you see green paint flakes, and your mind flashes with a memory: at the watchtower, there's a hatch leading to the basement in the exact same color. When Dr Ira notices this, she quickly covers the creature. \"Sorry delvers, if you'll excuse me, I have more work to do.\"",
     footnote="Add Quest #13 \"Underneath the Watchtower\". If already owned or completed, instead gain a Memory Chip token.",
     onEnter=[chip_or_quest(13, "Underneath the Watchtower")], next=HUB)
page("ch3-crypt-b", "THE CRYPT", "Dr Ira's Notes",
     "While Dr Ira is busy packing up her samples, you glance at her notes. \"Internal physiology resembles Sirens, which are docile creatures. These Tidekin - assuredly not.\"",
     footnote="Add a Friendly Spawn Card to the Spawn Deck.",
     onEnter=[{"kind": "grant-friendly-spawn-card"}], next=HUB)

# ---------------------------------------------------------------- temple
page("ch3-temple", "THE TEMPLE OF GAIA", "A Troubled Sermon",
     "A bell is ringing as you arrive. The temple is adorned with wooden carvings lit by flickering candlelight - one depicts a city on fire, another a monolith holding back a giant wave.\n\n"
     "Father Flores climbs the podium. He hasn't been seen since the power outage, and he looks tired and disheveled, a rarity for someone so put-together. Most concerning, he seems to have been injured and walks with a limp.\n\n"
     "By an altar away from the crowd, Rodrigo is quietly praying, face wet with tears.",
     image="/story/father-flores.png", onEnter=[spend()],
     choices=[choice("Go to the front row and listen", "ch3.temple.A", "ch3-temple-a", hint="Affects Favor"),
              choice("Sneak into the back room while the Father is distracted", "ch3.temple.B", "ch3-temple-b", hint="???"),
              choice("Pray with Rodrigo", "ch3.temple.C", "ch3-temple-c", hint="Affects Favor")])
page("ch3-temple-a", "THE TEMPLE OF GAIA", "The Story of Eleanor",
     "\"What is being done about those creatures?\" someone cries out. \"The delvers have their suits. What chance do the rest of us stand?!\"\n\n"
     "\"You are not in danger,\" Father Flores responds, exasperated. \"Your fear only betrays your lack of faith. Recall the story of Eleanor, Gaia's most faithful - not a fighter, not a delver, but a simple farmer. She knew her duty and fulfilled it without question, and Gaia saved her.\"\n\n"
     "He notices you listening intently and gives you an approving nod.",
     image="/story/father-flores.png", footnote="Increase Father Flores' opinion. " + FAV_FOOT.format(n="Flores"),
     onEnter=[fav("flores", "Father Flores", 1)], next=HUB)
page("ch3-temple-b", "THE TEMPLE OF GAIA", "The Back Room",
     "While Father Flores struggles to give his sermon, you edge towards the back room.",
     dieRoll=[{"min": 1, "max": 1, "label": "1: You knock over a candelabra", "next": "ch3-temple-b-fail"},
              {"min": 2, "max": 6, "label": "2-6: You slip inside", "next": "ch3-temple-b-success"}])
page("ch3-temple-b-fail", "THE TEMPLE OF GAIA", "Caught",
     "In your rush, you knock over a candelabra, which clatters on the tiles. Father Flores hurries over despite his injuries. \"I will not hazard a guess as to what you think you are doing - I have too much on my hands. You must leave. Now.\"",
     image="/story/father-flores.png", footnote="Decrease Father Flores' opinion. " + FAV_FOOT.format(n="Flores"),
     onEnter=[fav("flores", "Father Flores", -1)], next=HUB)
page("ch3-temple-b-success", "THE TEMPLE OF GAIA", "The Brass Dossier",
     "The back room where Father Flores lives is plain and unadorned. Behind the shelves of a cabinet you find a dossier labelled \"Brass\".\n\n"
     "If you've completed Quest #05, the dossier's notes track Vera Brass' movements - including an active tracking device. Her delversuit was last seen far to the west near the ruins of High Nest. You take the folder and quickly leave.",
     footnote="If you've completed Quest #05: add Quest #07 \"Further Afield\" (or a Memory Chip if already owned). Otherwise: gain a Memory Chip token.",
     onEnter=[{"kind": "if", "cond": {"kind": "quest-completed", "number": 5},
               "then": [chip_or_quest(7, "Further Afield")],
               "otherwise": [{"kind": "grant-memory-chip", "amount": 1}]}],
     next=HUB)
page("ch3-temple-c", "THE TEMPLE OF GAIA", "Rodrigo",
     "Rodrigo is deep in mourning and can't even muster his usual smile. You offer your condolences.\n\n"
     "\"When you and Sam got the generator running again, I hoped not too much time had passed. But by the time we made it to the clinic and turned the ventilator back on, my dad--\" He trails off. You put an arm around him and stay with him for some time.",
     image="/story/ch2/library-rodrigo.png", footnote="Increase Rodrigo's opinion. " + FAV_FOOT.format(n="Rodrigo"),
     onEnter=[fav("rodrigo", "Rodrigo", 1)], next=HUB)

# ---------------------------------------------------------------- shadow district
page("ch3-shadow", "SHADOW DISTRICT", "Forgotten",
     "The Shadow District sits beneath the shade of the mountain. Many failed delvers retreated here, welcomed by others who didn't fit the mold. The power outage lasted days here - further proof, to its people, that they are often forgotten.\n\n"
     "Some folks are looting a store; you can hear shouting and furniture being tossed. Elayna kneels beside an injured teen while a man yells at her to help his mother. A disheveled woman shouts about mysterious sounds from the sewers.",
     onEnter=[spend()],
     choices=[choice("Break up the brawl", "ch3.shadow.A", "ch3-shadow-a", hint="Grants Wisdom"),
              choice("Help Nurse Elayna", "ch3.shadow.B", "ch3-shadow-b", hint="Affects Favor"),
              choice("Speak to the ranting woman", "ch3.shadow.C", "ch3-shadow-c", hint="Grants Knowledge")])
page("ch3-shadow-a", "SHADOW DISTRICT", "The Brawl",
     "You rush inside and pull two men off each other. The older man accuses the younger of being a thief, so you restrain the latter and call for backup.",
     footnote="Shuffle 2 Ultra Level Cards into the Level Deck.",
     onEnter=[{"kind": "grant-ultra-level-cards", "amount": 2}], next=HUB)
page("ch3-shadow-b", "SHADOW DISTRICT", "A Helping Hand",
     "You hurry to where the man's injured mother is lying on the floor, carry her to a bed, and help set her twisted ankle. Elayna finishes tending to her. \"Thanks, delvers. I've been at this all week! I can finally take a little break.\"",
     image="/story/ch2/nurse-elayna.png", footnote="Increase Elayna's opinion. " + FAV_FOOT.format(n="Elayna"),
     onEnter=[fav("elayne", "Elayna", 1)], next=HUB)
page("ch3-shadow-c", "SHADOW DISTRICT", "Strange Noises",
     "\"Strange noises near the sewers! I've been hearing them for days! But they suddenly stopped when the power went out... Something's not right!\" You enter the sewer gate she indicated. It leads through a sloped tunnel for what feels like ages, until at last you reach a green door.",
     footnote="Add Quest #13 \"Underneath the Watchtower\". If already owned or completed, instead gain a Memory Chip token.",
     onEnter=[chip_or_quest(13, "Underneath the Watchtower")], next=HUB)

# ---------------------------------------------------------------- machinist
page("ch3-machinist", "MACHINIST", "Shelved Prototypes",
     "Samantha is scowling and bouncing a ball against a wall. \"That power outage was one giant pain in my neck! I've been going to every generator on Bird's Nest, checking and repairing them. Had to get my cousin Carlos to help or I'd never finish.\"\n\n"
     "Witness lets out a sad whirr. \"It's ok, lil guy. I just need something else to do around here.\" You look around at her shelved prototypes:\n\n"
     "Flaming Projectile Prototype - energy requirements impractical. Heat Seeking Experiment - too dangerous to safely test. Synthetic Harvester - untestable in lab setting.",
     image="/story/ch2/machinist-samantha-witness.png", onEnter=[spend()],
     footnote="If Samantha's opinion is Ally or better, you gain the product for free instead of adding it to the shop.",
     choices=[choice("Tell her the Flaming Projectile prototype shows promise", "ch3.machinist.A", "ch3-machinist-a", hint="Grants Equipment"),
              choice("Show enthusiasm for her Heat Seeking experiment", "ch3.machinist.B", "ch3-machinist-b", hint="Grants Equipment"),
              choice("Offer to help test her Synthetic Harvester", "ch3.machinist.C", "ch3-machinist-c", hint="Grants Equipment")])
for letter, prod, quote in (("a", 39, "\"You really think so? Alright, I'll finish it then!\""),
                            ("b", 40, "\"Might be a little risky, but if you think it might help, I'll give it a shot!\""),
                            ("c", 36, "\"You'd do that for me? Well then, time to give this baby a tune up!\"")):
    page(f"ch3-machinist-{letter}", "MACHINIST", "Back to the Workbench", quote,
         image="/story/ch2/machinist-samantha.png",
         footnote=f"Add Shop Product #{prod} to your Purchasable Products. If Samantha's opinion is Ally or better, gain the product instead.",
         onEnter=[{"kind": "if", "cond": {"kind": "favour-at-least", "characterId": "samantha", "min": 1},
                   "then": [{"kind": "grant-shop-product", "product": prod, "to": "active-delver"}],
                   "otherwise": [{"kind": "add-shop-products", "products": [prod], "questLabel": "Samantha's Workshop"}]}],
         next="ch3-machinist-witness")
page("ch3-machinist-witness", "MACHINIST", "Witness Records a Memory",
     "Samantha pops open a compartment in Witness' chest, revealing a complex web of circuits and wires. As she scribbles notes, you notice several blackened circuits.\n\n"
     "If you carry any Memory Chips, Witness' eyes blaze with light, projecting an image on the wall. \"Whoa, what the heck is that?\" Samantha exclaims. Thinking quickly, you snap a photo.",
     image="/story/ch2/machinist-witness-projecting.png",
     footnote="Spend your Memory Chip tokens and draw that many Memory Fragment cards.",
     onEnter=[{"kind": "convert-memory-chips-to-cards"}], next=HUB)

# ---------------------------------------------------------------- academy
page("ch3-academy", "ACADEMY CAMPUS", "A Heated Exchange",
     "Despite the chaos of the power outage, the delving students go about their studies. When you arrive at Headmistress Arlen's office, she and Master Bram are arguing just outside her door. It looks quite heated, which is concerning - the pair are old friends.",
     image="/story/ch2/academy-arlen.png", onEnter=[spend()],
     choices=[choice("Interrupt the conversation", "ch3.academy.A", "ch3-academy-a", hint="Grants Knowledge"),
              choice("Eavesdrop on their conversation", "ch3.academy.B", "ch3-academy-b", hint="Affects Favor"),
              choice("Sneak into Arlen's office", "ch3.academy.C", "ch3-academy-c", hint="Grants Power")])
page("ch3-academy-a", "ACADEMY CAMPUS", "What We Know",
     "\"Vera Brass graduated top of her class. Full honors. But she still died.\" Arlen's voice is full of grief and rage. \"What are we doing here, Bram? Sending these kids to their death! And for what?!\"\n\n"
     "\"Every delver matters to me, Arlen. You know this is the only way--\" You interrupt and Bram cuts himself short. \"Ah, delvers... I assume you're here to go over what we know so far.\"",
     image="/story/ch2/master-bram.png",
     footnote="With 4+ clue icons on your Key Items: add Quest #03 (or #13, or #07 - the first you don't own; a Memory Chip if you own them all). With 0-3: gain a Memory Chip token.",
     onEnter=[{"kind": "if", "cond": {"kind": "clues-at-least", "min": 4},
               "then": [{"kind": "reveal-first-unowned-quest", "chipFallback": 1, "quests": [
                   {"number": 3, "name": "Xavier's Request"},
                   {"number": 13, "name": "Underneath the Watchtower"},
                   {"number": 7, "name": "Further Afield"}]}],
               "otherwise": [{"kind": "grant-memory-chip", "amount": 1}]}],
     next=HUB)
page("ch3-academy-b", "ACADEMY CAMPUS", "Overheard",
     "\"Vera Brass of all people? Gone, just like that.\" Arlen's voice is full of emotion. \"How many delvers have we lost this year? And Father Flores hasn't said a thing about our fallen delvers. He wants to run the Academy like he runs the Children of Gaia - just moving parts in a machine.\"\n\n"
     "Master Bram pinches the bridge of his nose. \"Now I see it. Ira's been whispering in your ear again. We can't afford to--\"\n\n"
     "They finally notice you listening. Headmistress Arlen glares at you and you excuse yourself.",
     image="/story/ch2/academy-arlen.png", footnote="Decrease Arlen's opinion. " + FAV_FOOT.format(n="Arlen"),
     onEnter=[fav("arlen", "Headmistress Arlen", -1)], next=HUB)
page("ch3-academy-c", "ACADEMY CAMPUS", "Vera's Reports",
     "While Bram and Arlen are in a heated exchange, you skirt along the wall behind them and slip into the headmistress's office. On the table are reports Vera Brass submitted on her last run into the Tide, spattered with what appear to be tears. You glean useful information for your next run.",
     footnote="One player: +1 Armor Rank. One player: +1 Harvester Rank (Suit Condition sheet).",
     onEnter=[{"kind": "enqueue-suit-condition-rank-picks", "source": "ch3.academy.C",
               "picks": [{"delta": 1, "pinnedType": "Armor"}, {"delta": 1, "pinnedType": "Harvester"}]}],
     next=HUB)

# ---------------------------------------------------------------- dahlia's cave
page("ch3-dahlia", "DAHLIA'S CAVE", "Xavier's Mother",
     "You send Xavier a comm about the struggle you faced alongside Dahlia. \"Thank you, delvers. After what happened during the power outage, I'm worried about my mother. We should go see her.\"\n\n"
     "Astonishingly, Xavier survives contact with the mist without a delversuit, though he winces, the blue markings on his face glowing bright. In a cave above the mist, Dahlia kneels serenely in a tidal pool, her orchid-petal hair shifting faintly with each breath.\n\n"
     "\"The burned watchtower, the damaged generator, and the trouble you and mother faced... I have a feeling it's all connected. Do you have any physical evidence? I have an electron microscope we could put to use.\"",
     image="/story/ch2/academy-xavier.png", onEnter=[spend()],
     choices=[choice("Show Xavier the evidence you've assembled so far", "ch3.dahlia.A", "ch3-dahlia-a",
                     hint="Requires Key Item #4 or #8", requireKeyItemAny=[4, 8]),
              choice("Ask Dahlia what the Tidekin are like", "ch3.dahlia.B", "ch3-dahlia-b", hint="Grants Knowledge")])
page("ch3-dahlia-a", "DAHLIA'S CAVE", "Tidebloom",
     "Xavier spends an hour meticulously studying your clues.\n\n"
     "\"Look here, do you see this fungal pattern? This is the Tidebloom I told you about. I believe it's the reason creatures have become more aggressive lately. Until now, though, I've only had scraps to study - this quantity of bloom changes everything.\"\n\n"
     "He stares off into the distance. \"Could the creature that attacked the generator have been mutated by this Tidebloom?\"",
     image="/story/ch2/academy-xavier.png",
     footnote="Increase Xavier's opinion. " + FAV_FOOT.format(n="Xavier"),
     onEnter=[fav("xavier", "Xavier", 1)], next=HUB)
page("ch3-dahlia-b", "DAHLIA'S CAVE", "Not Tidekin",
     "Did the Tidekin attack Bird's Nest?\n\n"
     "\"Of course they didn't!\" Xavier responds, but his mother stands and he falls quiet. \"Not Tidekin,\" Dahlia says simply. Her hand is slender, not clawed like the creature you saw. \"We help. Tidekin... p-protect life. No hurt. No hurt.\"\n\n"
     "\"My mother lived in Bird's Nest years ago,\" Xavier explains. \"When my father was lost in the Tide, she went searching for him, not knowing she was pregnant with me. The Tide doesn't just kill humans - it changes them. She has become a Tidekin, but she is still my mother. The Tidekin are not violent. Somehow, we need to make the people of Bird's Nest understand.\"",
     footnote="Add Quest #04 \"A Hand Outstretched\". If already owned or completed, instead gain a Memory Chip token.",
     onEnter=[chip_or_quest(4, "A Hand Outstretched")], next=HUB)

# ---------------------------------------------------------------- town center
page("ch3-town-center", "TOWN CENTER", "Delving Academy Materials Request",
     "\"Delvers, we've learned much from our previous experiments. It appears that the glow emanating from delversuits is reactive in nature - we've observed the energy within organic particulates transferring into delversuit metals, but more investigation is needed. Can we count on your support?\"\n\n"
     "Donations count towards your RUNNING total across the campaign. Arlen's reaction hints: about 3 - \"What goes around comes around, you know.\" About 8 - \"We'll have to make do with this.\" About 16 - \"Our next set of experiments are off to a strong start thanks to you.\" About 24 - \"This... this is remarkably generous!\"",
     image="/story/ch2/town-center-arlen.png",
     footnote="Shop Products #13-18 are now available. With 2+ clue icons on your Key Items, also #19; with 5+, also #20.",
     onEnter=[{"kind": "add-shop-products", "products": [8, 13, 14, 15, 16, 17, 18]},
              {"kind": "add-shop-products-if-key-items-min", "minKeyItems": 2, "products": [19]},
              {"kind": "add-shop-products-if-key-items-min", "minKeyItems": 5, "products": [20]}],
     next="ch3-shop")
page("ch3-shop", "TOWN CENTER", "Visit the Shops",
     "Each player may purchase products using their minion and/or boss parts. You may convert a Boss part into minion parts at 3 minion parts per level of the Boss part. Check your Opinion cards for discounts or markups.",
     postRewardsText="When everyone is done shopping, click Continue.",
     kind="shop", next="ch3-donation-results")
page("ch3-donation-results", "TOWN CENTER", "Experimental Division Results",
     "__arlen-donation-reaction-ch3__",
     image="/story/ch2/town-center-arlen.png",
     footnote="Running total 6-12: one player +1 OS, other +1 Supercharger. 13-21: +2 OS / +2 Supercharger. 22+: each player +2 Rank of any equipment.",
     onEnter=[{"kind": "resolve-academy-donation", "schedule": "ch3"}], next="ch3-jobs")

# ---------------------------------------------------------------- jobs board
page("ch3-jobs", "TOWN CENTER", "View the Jobs Board",
     "The Jobs Board outside the Academy is crowded with requests. Delvers with Open Quests are paid a retainer for each one they're pursuing.",
     choices=[choice("Collect your retainer", "ch3.jobs.retainer", "ch3-jobs-retainer", requireOpenQuests="positive"),
              choice("Face the board empty-handed", "ch3.jobs.none", "ch3-jobs-roll", requireOpenQuests="zero")])
page("ch3-jobs-retainer", "TOWN CENTER", "Retainer",
     "The Academy clerk tallies up your Open Quests and counts out your pay.",
     footnote="Both delvers gain 1 minion part per Open Quest.",
     onEnter=[{"kind": "grant-minion-parts-per-open-quest", "perQuest": 1, "to": "all-delvers"}], next="ch3-jobs-choice")
page("ch3-jobs-roll", "TOWN CENTER", "No Open Quests",
     "You have no Open Quests to show for yourselves. Samantha, posting a request of her own, raises an eyebrow.",
     dieRoll=[{"min": 1, "max": 4, "label": "1-4: Samantha is unimpressed", "next": "ch3-jobs-unimpressed"},
              {"min": 5, "max": 6, "label": "5-6: Samantha shrugs it off", "next": "ch3-jobs-choice"}])
page("ch3-jobs-unimpressed", "TOWN CENTER", "Unimpressed",
     "\"Lacklustre investigating, delvers. Bird's Nest deserves better.\"",
     image="/story/ch2/machinist-samantha.png", footnote="Decrease Samantha's opinion.",
     onEnter=[fav("samantha", "Samantha", -1)], next="ch3-jobs-choice")
page("ch3-jobs-choice", "TOWN CENTER", "Take a Job",
     "Two requests catch your eye.\n\n"
     "Xavier is soliciting help from a delver. He's been researching a corruption called the Tidebloom that has been spreading, and requests help to collect a sample.\n\n"
     "A Shadow District street urchin is selling a copy of a map - \"Old Aguilar drew it for his delving partner, back before the Tide took her. Leads to a vault in Second Nest.\"",
     choices=[choice("Xavier needs help collecting a Tidebloom sample", "ch3.jobs.A.xavier", "ch3-jobs-a"),
              choice("Buy a street urchin's copy of a map to Second Nest (5 minion parts)", "ch3.jobs.B.fence", "ch3-jobs-b",
                     prePay={"kind": "minion-parts", "amount": 5})])
page("ch3-jobs-a", "TOWN CENTER", "Xavier's Request",
     "You put your name down on Xavier's request.",
     footnote="Add Quest #03. If already owned or completed, instead gain a Memory Chip token.",
     onEnter=[chip_or_quest(3, "Xavier's Request")], next="ch3-end")
page("ch3-jobs-b", "TOWN CENTER", "The Forgotten Vault",
     "You count out the minion parts. The urchin presses the folded map into your hand and vanishes into the crowd.",
     footnote="The paying delver loses 5 minion parts. Add Quest #06 \"The Forgotten Vault\". If already owned or completed, instead gain a Memory Chip token.",
     onEnter=[{"kind": "lose-minion-parts", "amount": 5, "to": "active-delver"}, chip_or_quest(6, "The Forgotten Vault")], next="ch3-end")

page("ch3-end", "END OF CHAPTER 3", "The Memorial Festival",
     "The festival lanterns have long since gone dark, but the questions they lit remain. Somewhere beneath Bird's Nest, something is waiting.",
     kind="end-town-visit", onEnter=[rec("ch3.completed")])

chapter = {"id": "ch3", "name": "The Memorial Festival", "startPageId": "ch3-story-so-far", "pages": pages}
out = Path(sys.argv[1]) / "data" / "chapter3.json"
out.write_text(json.dumps(chapter, indent=2, ensure_ascii=False) + "\n", encoding="utf8")
print(len(pages), "pages ->", out)
