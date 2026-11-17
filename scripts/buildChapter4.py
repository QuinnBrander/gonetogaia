"""Build data/chapter4.json (Chapter 4 Town Visit, "The Passing of the Torch")
from the revised Chapter 4 text. Edit this script, not the JSON.

Usage: python -I scripts/buildChapter4.py <G2G root>"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from questPages import add_quest_pages, report_choices  # noqa: E402

T = "CHAPTER 4 - THE PASSING OF THE TORCH"
TV = "CHAPTER 4 - TOWN VISIT"
pages = {}


def page(pid, title, subtitle, text, **kw):
    p = {"title": title, "subtitle": subtitle, "text": text}
    p.update(kw)
    pages[pid] = p


def choice(label, key, nxt, **kw):
    c = {"label": label, "decisionKey": key, "next": nxt}
    c.update(kw)
    return c


def fav(cid, name, delta, **kw):
    a = {"kind": "shift-favour", "characterId": cid, "characterName": name, "delta": delta}
    a.update(kw)
    return a


def rec(key):
    return {"kind": "record-decision", "key": key}


def spend():
    return {"kind": "spend-story-token"}


def chip_or_quest(n, name):
    return {"kind": "reveal-quest-or-grant-chip", "number": n, "name": name, "chipFallback": 1}


def first_unowned(*quests):
    return {"kind": "reveal-first-unowned-quest", "chipFallback": 1,
            "quests": [{"number": n, "name": name} for n, name in quests]}


HUB = "ch4-hub"
FAV_FOOT = "Unless {n}'s opinion is now neutral, gain the matching opinion card."
Q3 = (3, "Xavier's Request")
Q4 = (4, "A Hand Outstretched")
Q5 = (5, "The Rogue Delver")
Q6 = (6, "The Forgotten Vault")
Q7 = (7, "Further Afield")
Q13 = (13, "Underneath the Watchtower")

# ---------------------------------------------------------------- opening
page("ch4-story-so-far", T, "The Story So Far",
     "After returning from a Quest, you partook in the town's annual Memorial Festival. In the midst of the festivities, the power suddenly went out. You discovered the cause of the blackout was a damaged generator, and the culprit a giant creature of unknown origins. Dr Ira believes the attack was caused by creatures known as the Tidekin, an assertion that drew mixed responses.\n\n"
     "The following week, you explored the town, progressing some of your ongoing investigations. Xavier, meanwhile, has posted a standing request for any delver willing to help with his Tidebloom research.",
     image="/story/dr-ira.png",
     # Chapter 5 opens with Dahlia's execution, so every party must have
     # met and rescued her (Quest #03) first: guarantee they own it here,
     # and require it completed before Chapter 5 (ch4-before-chapter-5).
     footnote="Add Quest #03 to your Open Quests. If already owned or completed, instead gain a Memory Chip token.",
     onEnter=[chip_or_quest(*Q3)],
     next="ch4-quest-report-intro")

page("ch4-quest-report-intro", T, "Into the Tide",
     "It is once again time for you to venture into the Tide. You can complete up to 2 Quests from your Open Quests before continuing the story in the Chapter 4 Town Visit.\n\n"
     "If you fail a Quest, you can spend your creature parts at the shops and try again, or continue onto the Town Visit. Uncompleted Quests remain in your Open Quests.\n\n"
     "Choose the Quest you will attempt first. You must attempt at least one Quest before the Town Visit.",
     footnote="Collectively gain 2 Story tokens - one per Quest you can complete before this Town Visit.",
     onEnter=[{"kind": "grant-story-tokens", "amount": 2}],
     choices=report_choices("ch4", choice))

page("ch4-quest-report", T, "Quest Report",
     "Attempt another Quest, or continue to the Town Visit. Each Quest you play spends a Story token.",
     choices=[
         *report_choices("ch4", choice),
         choice("Continue to the Town Visit", "ch4.report.done", "ch4-arrival"),
     ])
add_quest_pages(page, choice, "ch4", T, "ch4-quest-report")

# ---------------------------------------------------------------- arrival
page("ch4-arrival", TV, "Clawprints",
     "As you carefully retrace your steps through the mist, a hulking creature dashes past, using clawed hands to run faster, heedless of your presence. Its warped body is covered in patches of pulsing bioluminescent tissue. Wherever its clawed feet have touched the ground, you find fragments of glowing residue. You reach out an armoured hand to inspect it and instantly it starts eating through the metal. A minute after you wipe it on a nearby kelp, the kelp has withered to nothing.\n\n"
     "Then you realize the significance of the creature's trajectory - it's headed straight for Bird's Nest. Your comm to Bram is dead; the town's satellite must be down. You launch into a sprint.\n\n"
     "When you breach the shore twenty minutes later, it's worse than you thought. Not one, but several pairs of telltale clawprints infect the shoreline. Screams and the smell of burning urge you onward.",
     choices=[
         choice("Both delvers survived", "ch4.arrival.both-survived", "ch4-new-recruits", requireQuestDeaths="none"),
         choice("One or both delvers died", "ch4.arrival.died", "ch4-died", requireQuestDeaths="any"),
     ])
page("ch4-died", TV, "The Fallen",
     "You bring your fallen delvers home to Bird's Nest. Their final words are already recorded in the Graveyard on your Campaign Sheet.",
     footnote="If the delver that died is your last remaining Hero card, don't discard them.",
     choices=[
         choice("Only the Mind delver died", "ch4.arrival.died.mind", "ch4-died-mind", requireQuestDeaths="mind-only"),
         choice("Only the Body delver died", "ch4.arrival.died.body", "ch4-died-body", requireQuestDeaths="body-only"),
         choice("Both delvers died", "ch4.arrival.died.both", "ch4-died-both", requireQuestDeaths="both"),
     ])
for who, picks in (("mind", [{"delta": 1, "pinnedHeroId": "hero-01"}]),
                   ("body", [{"delta": 1, "pinnedHeroId": "hero-02"}]),
                   ("both", [{"delta": 1, "pinnedHeroId": "hero-01"}, {"delta": 1, "pinnedHeroId": "hero-02"}])):
    label = {"mind": "Mind Delver's", "body": "Body Delver's", "both": "Both Delvers'"}[who]
    page(f"ch4-died-{who}", TV, f"{label} Blood-Soaked Suit",
         "Blood seeps into the crevices of the Delversuit, filling it with new power.",
         footnote="Add Rank 1 of any one Equipment to an Equipment Slot of your choice on the Suit Condition sheet.",
         onEnter=[{"kind": "enqueue-suit-condition-rank-picks", "source": f"ch4.arrival.died.{who}", "picks": picks}],
         next="ch4-new-recruits")

page("ch4-new-recruits", TV, "Meet the New Recruits",
     "Two fresh graduates catch up with you on the shore, weapons drawn, faces pale. There's no time for introductions.",
     image="/story/ch2/new-recruits.png",
     footnote="Disciple of the Mind player gains Hero #9. Disciple of the Body player gains Hero #10.",
     onEnter=[{"kind": "unlock-hero-cards", "cardNumbers": [9, 10]}],
     next="ch4-town-square")

# ---------------------------------------------------------------- town square + assault
page("ch4-town-square", "TOWN SQUARE", "Unfolding Disasters",
     "Bird's Nest is a whirlwind of chaos. The screams of fleeing townsfolk and smoke from the fires are all you can focus on. You find Master Bram standing amidst it all, stricken, as if he is unable to move. You try to snap him out of it, with little success. The people of Bird's Nest need you, and with Bram unable to react, it's up to you to take the reins.\n\n"
     "You call loudly over the din, organizing Sam, Xavier and some of the others to action. If you hope to make it out alive, you all must band together. Bram finally seems to be emerging from his state, just as you begin directing everyone to push back against the creatures.",
     image="/story/ch2/master-bram.png", next="ch4-townsfolk")
page("ch4-townsfolk", "TOWN SQUARE", "Assign the Townsfolk",
     "Assign each uninjured townsfolk to an action. Townsfolk who assist with combat give one delver a reward for the coming fight.",
     kind="townsfolk-assignment", next="ch4-assault-intro")
page("ch4-assault-intro", "STORY QUEST: ASSAULT ON BIRD'S NEST", "Defeat All Enemies",
     "The Mistspawn and its Infestation tear through the square. Bram draws his greatsword beside you.\n\n"
     "Enemy abilities: Omen - when an enemy with Omen damages a delver, that delver gains a monster token, and takes 1 extra damage per token every time they take damage for the rest of the wave. Rebirth - when the enemy dies, its tile gets 3 monster tokens; after each hero turn where no enemy died, remove 1 from every tile; when a tile's last token is removed, one of the enemies that died there respawns with 50% health.",
     footnote="Your townsfolk rewards are given out at the start of the fight, for this combat only.",
     startQuest="assault", next="ch4-assault-result")
page("ch4-assault-result", "STORY QUEST: ASSAULT ON BIRD'S NEST", "The Dust Settles",
     "The fighting is over.",
     choices=[
         choice("Continue", "ch4.assault.x1", "ch4-x1", hideIfDecisionMade="ch4.assault.lost"),
         choice("Continue", "ch4.assault.x2", "ch4-x2", hideIfDecisionMade="ch4.assault.won"),
     ])
page("ch4-x1", "STORY QUEST: ASSAULT ON BIRD'S NEST", "Hard Fought",
     "With the final swing of his greatsword, Bram cleaves the last standing creature in two. It collapses in a heap with a gasping growl. Smoke is rising from the put-out fires. In the distance you can hear cries of pain from the injured, but at least for now the danger has passed. Across the square, Sam is kneeling over a fallen delver - her cousin Carlos.\n\n"
     "Master Bram claps you on the shoulder. \"Hard fought, delvers. Thank you for what you did back there. It's been a long time since I've felt that way... I couldn't move. I just kept hearing the screams, the fire. It was just like what happened in Storm's Nest years ago.\" He shakes his head, trying to clear it. \"There's no telling if the threat is truly gone. You should get some rest just in case.\"\n\n"
     "You drag yourself to your quarters and fall into a deep and dreamless sleep. It's late in the afternoon when you come to. You're sorer than you can remember, but you hobble towards the town to help out with the cleanup.",
     image="/story/ch2/master-bram.png",
     footnote="Collectively gain 4 Story tokens - these represent the total number of locations you can visit this Chapter.",
     onEnter=[{"kind": "grant-story-tokens", "amount": 4}], next=HUB)
page("ch4-x2", "STORY QUEST: ASSAULT ON BIRD'S NEST", "Clinically Dead",
     "You stumble, fatigued and injured. One of the mistspawn runs at you on all fours with frightening speed. You swing your weapon in an arc, but you're too slow. Another creature emerges from the burning smoke and before you can react, they swarm you. Everything goes black.\n\n"
     "You awake moments later in intense pain with Elayna's concerned face hovering over you. \"It worked!\" She drops the defibrillator and injects a needle into you. \"I'm not losing you, delver. Hang in there...\" Your vision fades again.\n\n"
     "It's bright when you come to in the Academy infirmary. Arlen is sitting at a nearby desk. \"Welcome back to the world of the living. You were clinically dead for nearly a minute, so count your lucky stars that Elayna is a better nurse than she lets on. And don't worry yourself about those monsters, Bram finished them off. We lost good people, though - Sam's cousin Carlos among them.\"\n\n"
     "The minute Arlen is out of sight, you drag yourself out of bed and hobble towards the town to help out with the cleanup.",
     image="/story/ch2/academy-arlen.png",
     footnote="Collectively gain 4 Story tokens - these represent the total number of locations you can visit this Chapter.",
     onEnter=[{"kind": "grant-story-tokens", "amount": 4}], next=HUB)

page(HUB, TV, "Explore the Town",
     "Choose a location to visit. Each visit spends 1 Story token. Once they're spent, head to the Town Center.",
     choices=[
         choice("Enter the Temple of Gaia", "ch4.hub.temple", "ch4-temple", requireStoryTokens="positive", hideIfDecisionMade="ch4.hub.temple"),
         choice("Visit the Misty Eagle", "ch4.hub.pub", "ch4-pub", requireStoryTokens="positive", hideIfDecisionMade="ch4.hub.pub"),
         choice("Visit the Machinist", "ch4.hub.machinist", "ch4-machinist", requireStoryTokens="positive", hideIfDecisionMade="ch4.hub.machinist"),
         choice("Visit the Library", "ch4.hub.library", "ch4-library", requireStoryTokens="positive", hideIfDecisionMade="ch4.hub.library"),
         choice("Return to the Town Square", "ch4.hub.square", "ch4-square", requireStoryTokens="positive", hideIfDecisionMade="ch4.hub.square"),
         choice("Visit Dahlia's Cave", "ch4.hub.dahlia", "ch4-dahlia", hint="Requires Quest #03 completed",
                requireStoryTokens="positive", hideIfDecisionMade="ch4.hub.dahlia", requireDecision="quest.3.completed"),
         choice("Continue to the Town Center", "ch4.hub.done", "ch4-town-center", requireStoryTokens="zero"),
     ])

# ---------------------------------------------------------------- temple
page("ch4-temple", "TEMPLE OF GAIA", "Demanding Answers",
     "The area around the Temple of Gaia lies in ruins, but the building itself stands miraculously undamaged. Much of the town has packed itself inside, asking for Father Flores and demanding answers for all that has happened over the past month. The Children of Gaia are up on the platform trying to reassure the crowd.\n\n"
     "Down the hall leading to the orphanage, you spot Nurse Elayna in her lab coat assessing some of the children who have undoubtedly lost their parents in the attack.",
     image="/story/father-flores.png", onEnter=[spend()],
     choices=[choice("Attempt to calm the agitated crowd", "ch4.temple.A", "ch4-temple-a", hint="Grants Resources"),
              choice("Question the Children of Gaia", "ch4.temple.B", "ch4-temple-b", hint="Grants Knowledge"),
              choice("Check on Nurse Elayna", "ch4.temple.C", "ch4-temple-c", hint="Grants Wisdom")])
page("ch4-temple-a", "TEMPLE OF GAIA", "The Platform",
     "You climb onto the platform and raise your hands for quiet.",
     dieRoll=[{"min": 1, "max": 1, "label": "1: Simple platitudes", "next": "ch4-temple-a-1"},
              {"min": 2, "max": 5, "label": "2-5: Gaia watches over us", "next": "ch4-temple-a-2"},
              {"min": 6, "max": 6, "label": "6: Together we will rise", "next": "ch4-temple-a-6"}])
page("ch4-temple-a-1", "TEMPLE OF GAIA", "Forced Off",
     "\"E-Everyone, please listen. I know things look bad. Father Flores is missing, the monsters ravaged the town, and we've lost many. But we can't give up.\" The crowd argues back. It's clear this time simple platitudes are not enough. The crowd yells at you until you're forced off the platform.",
     next=HUB)
page("ch4-temple-a-2", "TEMPLE OF GAIA", "A Little Comfort",
     "\"Even now, in our darkest hour, Gaia watches over us. This is just another test that I know we can withstand. You saw how hard we all fought. The delvers will do everything in our power to protect the people of Bird's Nest!\"\n\n"
     "The crowd is slightly comforted by your words. The Children of Gaia are grateful for your help and gift you some resources.",
     footnote="Both delvers gain 2 creature parts.",
     onEnter=[{"kind": "grant-minion-parts", "amount": 2, "to": "all-delvers"}], next=HUB)
page("ch4-temple-a-6", "TEMPLE OF GAIA", "We Endure",
     "\"I see your pain. I feel it too. We've lost so much, but these losses cannot break us. Look around you - every face here is proof that we endure. We must go on to honor those who have fallen. Together we will rise again.\"\n\n"
     "The crowd is comforted by your powerful words. The Children of Gaia are grateful for your help and gift you some resources.",
     footnote="Both delvers gain 4 creature parts.",
     onEnter=[{"kind": "grant-minion-parts", "amount": 4, "to": "all-delvers"}], next=HUB)
page("ch4-temple-b", "TEMPLE OF GAIA", "The Pilgrimage",
     "\"You're telling me with everything that is happening, Father Flores thought it was a good idea to go on a pilgrimage?!\" While the attendants are distracted by the crowd, you pull one aside. \"Father Flores is not on a pilgrimage. Where is he really?\"\n\n"
     "The rattled attendant sighs. \"The truth is Father Flores is on a mission to locate the Brass siblings. Using the footage from the surveillance device, he has worked tirelessly to follow the tracks to the ruins of High Nest.\"\n\n"
     "It's not much to go on, but at least now you have a clue.",
     footnote="If you've completed Quest #05, add Quest #07 (a Memory Chip if already owned). Otherwise add Quest #05 (a Memory Chip if already owned).",
     onEnter=[{"kind": "if", "cond": {"kind": "quest-completed", "number": 5},
               "then": [chip_or_quest(*Q7)], "otherwise": [chip_or_quest(*Q5)]}],
     next=HUB)
page("ch4-temple-c", "TEMPLE OF GAIA", "The Orphanage",
     "You make your way down the hall towards Nurse Elayna.",
     choices=[choice("Continue", "ch4.temple.C.children", "ch4-temple-c-children", hideIfDecisionMade="quest.5.completed"),
              choice("Continue", "ch4.temple.C.janus", "ch4-temple-c-janus", showIfDecision="quest.5.completed")])
page("ch4-temple-c-children", "TEMPLE OF GAIA", "Frightened Children",
     "\"She's just a little scared after everything that happened, but physically she's completely normal.\" Nurse Elayna hands a toddler over to the attendant with a smile and notices you. \"You should be resting,\" she admonishes, but gives you a smile.\n\n"
     "\"The orphanage was not harmed, but the children were frightened. A dozen more were brought here after the attack.\" You offer to spend some time with the older kids to keep them entertained. \"That's a great idea!\"",
     image="/story/ch2/nurse-elayna.png", footnote="Increase Elayna's opinion. " + FAV_FOOT.format(n="Elayna"),
     onEnter=[fav("elayne", "Elayna", 1)], next=HUB)
page("ch4-temple-c-janus", "TEMPLE OF GAIA", "Baby Janus",
     "Nurse Elayna is gently setting a sleeping baby into a crib. Your heart skips a beat when you realize it's baby Janus, the child you found in the ruins of High Nest. \"He's in perfectly good health,\" Elayna tells the attendant.\n\n"
     "Elayna looks down at the crib and strokes his head. \"This little guy's only been here a short while and he's already alone. I'm sure we'll find a home for him... in time.\" You wish you could tell her that baby Janus is her nephew, but you remember your promise to Master Bram. He said the safest place to hide a child is among other children.\n\n"
     "Instead you offer to keep the older kids entertained. Elayna quickly brightens. \"Great idea, delvers!\"",
     image="/story/ch2/nurse-elayna.png", footnote="Increase Elayna's opinion. " + FAV_FOOT.format(n="Elayna"),
     onEnter=[fav("elayne", "Elayna", 1)], next=HUB)

# ---------------------------------------------------------------- misty eagle
page("ch4-pub", "THE MISTY EAGLE", "Us or Them",
     "The pub is thick with pipe smoke, lantern glow and the smell of spilt ale. The battered townsfolk crowd shoulder-to-shoulder, their voices hoarse with anger. A bearded fisherman slams his mug against the wood: \"S'the Tidekin did this! They've always hated us! It's us or them, mark my words!\"\n\n"
     "Headmistress Arlen interrupts. \"Nonsense. I've studied the Tide for decades and the tide-born creatures cannot breathe air. Something about this doesn't add up. They've either evolved at an accelerated pace... or we are being deceived.\"\n\n"
     "Xavier rises shakily. \"We don't know those were Tidekin, and besides, the Tidekin are not our enemies.\" The fisherman chucks a bottle at him, then notices you. \"Yer those delvers fought off the scum, ain't ya! Promise us you'll find 'em in the mist and give 'em hell!\"",
     image="/story/misty-eagle.png", onEnter=[spend()],
     choices=[choice("Swear to get revenge on the Tidekin", "ch4.pub.A", "ch4-pub-a", hint="Grants Resources"),
              choice("Stand with Headmistress Arlen", "ch4.pub.B", "ch4-pub-b", hint="Affects Favor"),
              choice("Defend Xavier and the Tidekin", "ch4.pub.C", "ch4-pub-c", hint="???")])
page("ch4-pub-a", "THE MISTY EAGLE", "Fire and Blood",
     "\"The Tidekin dared to attack our homes, our families! We must answer with fire and blood, or we will never be safe again!\" Many shout their approval and shower you in resources.",
     footnote="Both delvers gain 4 minion parts. Decrease Xavier's opinion. " + FAV_FOOT.format(n="Xavier"),
     onEnter=[{"kind": "grant-minion-parts", "amount": 4, "to": "all-delvers"}, fav("xavier", "Xavier", -1)], next=HUB)
page("ch4-pub-b", "THE MISTY EAGLE", "Something Doesn't Add Up",
     "\"Think! These creatures die on land, yet they lived long enough to raze half our town. We need to investigate before jumping to conclusions. If we charge blindly against the Tidekin, we may strike the wrong enemy - and doom ourselves.\"",
     image="/story/ch2/academy-arlen.png", footnote="Increase Arlen's opinion. " + FAV_FOOT.format(n="Arlen"),
     onEnter=[fav("arlen", "Headmistress Arlen", 1)], next=HUB)
page("ch4-pub-c", "THE MISTY EAGLE", "Whispers",
     "You place a hand on Xavier's trembling frame. \"Xavier is wise. Everything we know about the Tidekin shows that they're peaceful, and we have no evidence that those monsters were Tidekin. Would you condemn an entire people based on whispers?\"",
     image="/story/ch2/academy-xavier.png",
     footnote="Increase Xavier's opinion. Add Quest #03 \"Xavier's Request\" (a Memory Chip if already owned or completed).",
     onEnter=[fav("xavier", "Xavier", 1), chip_or_quest(*Q3)], next=HUB)

# ---------------------------------------------------------------- machinist
page("ch4-machinist", "THE MACHINIST", "Metal Scraps",
     "Half-finished blades clatter onto the ground, their edges dull where Samantha's steady hand once would have perfected them. Witness reaches a tentative hand towards her, but she pulls away. \"I told you to leave me alone! My cousin is dead! Not like you could understand what I'm feeling! You're just a robot... just metal scraps stuck together!\"\n\n"
     "Witness's hand drops. He glides into the corner and shuts down all his lights. Sam sits back down, the fight going out of her. \"Maybe if I hadn't encouraged Carlos to become a delver... Maybe if my weapons were better, none of this would be happening...\"",
     image="/story/ch2/machinist-samantha-witness.png", onEnter=[spend()],
     choices=[choice("Promise justice for the fallen", "ch4.machinist.A", "ch4-machinist-a", hint="Grants Equipment"),
              choice("Help her process her grief", "ch4.machinist.B", "ch4-machinist-b", hint="Affects Favor"),
              choice("Give her space and check on Witness", "ch4.machinist.C", "ch4-machinist-c", hint="???")])
page("ch4-machinist-a", "THE MACHINIST", "Justice",
     "\"Sam, I'm so sorry for your loss. Carlos's death will not be in vain. We will get to the bottom of this. When you feel ready, we could use your help in this fight.\" Sam takes a deep breath and nods. \"Deep down, I know that's what Carlos would want me to do.\"",
     image="/story/ch2/machinist-samantha.png", footnote="Add Shop Product #45 to your Purchasable Products.",
     onEnter=[{"kind": "add-shop-products", "products": [45], "questLabel": "Samantha's Workshop"}], next="ch4-machinist-witness")
page("ch4-machinist-b", "THE MACHINIST", "Not Your Fault",
     "\"How can I face my aunt and cousins now? They must all hate me.\" You grasp her hand. \"Sam, what happened is not your fault. Carlos wanted to be a delver to protect his family.\" She collapses into your arms, and some time passes before her sobs ease. She isn't ready to work yet, but you can feel the bond between you strengthen.",
     image="/story/ch2/machinist-samantha.png", footnote="Increase Samantha's opinion. " + FAV_FOOT.format(n="Samantha"),
     onEnter=[fav("samantha", "Samantha", 1)], next="ch4-machinist-witness")
page("ch4-machinist-c", "THE MACHINIST", "A Strange Device",
     "You ask Witness how he's doing. He gives a sad beep. \"Sam didn't mean what she said. When people grieve, they lose all control.\" Witness gives you a long, knowing look and nods, then digs around in some boxes at the back. He holds a strange device to his chest briefly, looks deep into your eyes, and hands it to you.",
     image="/story/witness.png", footnote="Gain a Memory Chip token.",
     onEnter=[{"kind": "grant-memory-chip", "amount": 1}], next="ch4-machinist-witness")
page("ch4-machinist-witness", "THE MACHINIST", "I'm Sorry",
     "After some time, Samantha kneels down beside Witness. \"I'm sorry,\" she says quietly. Witness beeps and shakes his head. Sam smiles weakly, then pops open a compartment in his chest.\n\n"
     "If you carry any Memory Chips, Witness' eyes blaze with light, projecting an image on the wall. You quickly snap a picture of it.",
     image="/story/ch2/machinist-witness-projecting.png",
     footnote="Spend your Memory Chip tokens and draw that many Memory Fragment cards.",
     onEnter=[{"kind": "convert-memory-chips-to-cards"}], next=HUB)

# ---------------------------------------------------------------- library
page("ch4-library", "LIBRARY", "Rodrigo's Comm",
     "The library is quiet today. Dust motes drift lazily across the dimly lit bookshelves. Rodrigo barely notices you enter. He's staring at his communication device in silence, eyebrows furrowed with worry.",
     image="/story/ch2/library-rodrigo.png", onEnter=[spend()],
     choices=[choice("Search an area you haven't had a chance to yet", "ch4.library.A", "ch4-library-a", hint="???"),
              choice("Ask Rodrigo what he's doing", "ch4.library.B", "ch4-library-b", hint="Affects Favor"),
              choice("Piece together what you've learned", "ch4.library.C", "ch4-library-c", hint="Grants Knowledge")])
page("ch4-library-a", "LIBRARY", "The Stacks",
     "You walk through the stacks, pondering which section could provide useful information.",
     choices=[choice("Creature Archives", "ch4.library.A.creature", "ch4-library-a-creature"),
              choice("Delver Archives", "ch4.library.A.delver", "ch4-library-a-delver"),
              choice("Atlas Archives", "ch4.library.A.atlas", "ch4-library-a-atlas")])
page("ch4-library-a-creature", "LIBRARY", "Creature Archives",
     "A dog-eared bestiary falls open at a page on mist-borne predators, its margins full of a former delver's notes.",
     footnote="Disciple of the Mind player gains Shop Product #46. Disciple of the Body player gains Shop Product #47.",
     onEnter=[{"kind": "grant-shop-product", "product": 46, "to": "hero-01"},
              {"kind": "grant-shop-product", "product": 47, "to": "hero-02"}], next=HUB)
page("ch4-library-a-delver", "LIBRARY", "Delver Archives",
     "Among the delver logs, you find a diary bound in faded leather.",
     footnote="Add Key Item #3. If already owned, instead gain a Memory Chip token.",
     onEnter=[{"kind": "if", "cond": {"kind": "owns-key-item", "number": 3},
               "then": [{"kind": "grant-memory-chip", "amount": 1}],
               "otherwise": [{"kind": "gain-key-item", "number": 3, "name": "Woo's Diary"}]}], next=HUB)
page("ch4-library-a-atlas", "LIBRARY", "Atlas Archives",
     "An old atlas marks a sheltered route through the Tide, and the friendly creatures said to dwell along it.",
     footnote="Add a Friendly Spawn Card to the top of the Spawn Deck.",
     onEnter=[{"kind": "grant-friendly-spawn-card"}], next=HUB)
page("ch4-library-b", "LIBRARY", "Elias",
     "\"Oh, sorry, I didn't see you come in,\" Rodrigo says without looking up. \"I know you delvers have a lot on your plate, so I understand why finding Elias isn't a priority. But I can't just forget about him.\" There's an edge to his voice that wasn't there before his father passed.",
     choices=[choice("\"You're right. We do have a lot on our plate right now.\"", "ch4.library.B.1", "ch4-library-b-1"),
              choice("\"We do, but I haven't forgotten about Elias.\"", "ch4.library.B.2", "ch4-library-b-2")])
page("ch4-library-b-1", "LIBRARY", "Help Yourself",
     "\"I get it,\" he says promptly. \"I was there. I fought beside you. But after losing dad and Vera... I can't bear the thought that Elias might be--\" He trails off, hand gripping his comm tightly. \"I'm going to keep looking. Help yourself to whatever you need.\" Without another word, he walks away.",
     image="/story/ch2/library-rodrigo.png", footnote="Decrease Rodrigo's opinion. " + FAV_FOOT.format(n="Rodrigo"),
     onEnter=[fav("rodrigo", "Rodrigo", -1)], next=HUB)
page("ch4-library-b-2", "LIBRARY", "A Signal",
     "Rodrigo grins. \"I've been sending Elias messages every day since he disappeared. Never get a response, but the other day I swear his comm was active. Almost like he was typing out a response. He's alive, I just know it!\"\n\n"
     "He shows you coordinates on his device. \"Headmistress Arlen triangulated Elias's comm signal to this location. Next time you're out in the Tide, would you mind checking it out?\" There's such hope in his eyes that you can't help but agree.",
     image="/story/ch2/library-rodrigo.png",
     footnote="Increase Rodrigo's opinion. Add Quest #05 (if already owned or completed, Quest #07; if both, a Memory Chip).",
     onEnter=[fav("rodrigo", "Rodrigo", 1), first_unowned(Q5, Q7)], next=HUB)
page("ch4-library-c", "LIBRARY", "Piecing It Together",
     "You spread your notes across a reading table and look for the threads that connect them.",
     footnote="With 4+ clue icons on your Key Items: add Quest #03 (or #07, or #13 - the first you don't own; a Memory Chip if you own them all). With 0-3: gain a Memory Chip token.",
     onEnter=[{"kind": "if", "cond": {"kind": "clues-at-least", "min": 4},
               "then": [first_unowned(Q3, Q7, Q13)],
               "otherwise": [{"kind": "grant-memory-chip", "amount": 1}]}], next=HUB)

# ---------------------------------------------------------------- town square (location)
page("ch4-square", "TOWN SQUARE", "Dr Ira's Rally",
     "A score of people are gathered around a makeshift platform where Dr Ira is speaking and gesturing angrily. Beside her, Master Bram is trying to reason with her. \"Ira, please, stop this.\" She wrenches free of his hand. \"No, Bram! I've kept my silence too long. They deserve to know the threat that YOU have let breach our shores!\"\n\n"
     "\"First the watchtower is set ablaze, then our memorial festival is attacked by a rabid Tidekin, and now this?! Do you know how many civilians I could not save last night? The Tidekin will destroy everything we have built, unless we stop them!\" She turns to the crowd. \"Soon every soul in Bird's Nest must make a choice - unite against the Tidekin, or let them take what little we have left.\"\n\n"
     "Bram seems to teeter on the verge of responding as dead silence hangs in the air.",
     image="/story/dr-ira.png", onEnter=[spend()],
     choices=[choice("Agree with Dr Ira", "ch4.square.A", "ch4-square-a", hint="Affects Favor"),
              choice("Disagree with Dr Ira", "ch4.square.B", "ch4-square-b", hint="Affects Favor"),
              choice("Encourage Master Bram to speak", "ch4.square.C", "ch4-square-c", hint="Affects Favor")])
page("ch4-square-a", "TOWN SQUARE", "We Must Act",
     "\"I have fought many creatures in the Tide. The ones we faced last night were unlike anything else out there. If these truly are the Tidekin, we must act.\" The mob's anger grows. Dr Ira nods at you, grateful for your support, as Master Bram walks away.",
     image="/story/dr-ira.png",
     footnote="Increase Dr Ira's opinion. Decrease Master Bram's opinion. " + FAV_FOOT.format(n="Dr Ira"),
     onEnter=[fav("ira", "Dr Ira", 1), fav("bram", "Master Bram", -1, trackOnly=True)], next=HUB)
page("ch4-square-b", "TOWN SQUARE", "Where Is Your Proof?",
     "You step up to challenge Dr Ira.",
     choices=[choice("Continue", "ch4.square.B.proof", "ch4-square-b-proof", hideIfDecisionMade="quest.4.completed"),
              choice("Continue", "ch4.square.B.met", "ch4-square-b-met", showIfDecision="quest.4.completed")])
SQUARE_B_FOOT = "Each player gains +1 Rank of an Equipment Slot of their choice. Decrease Dr Ira's opinion. " + FAV_FOOT.format(n="Dr Ira")
SQUARE_B_ACTIONS = [{"kind": "enqueue-suit-condition-rank-picks", "source": "ch4.square.B",
                     "picks": [{"delta": 1, "pinnedHeroId": "hero-01"}, {"delta": 1, "pinnedHeroId": "hero-02"}]},
                    fav("ira", "Dr Ira", -1)]
page("ch4-square-b-proof", "TOWN SQUARE", "Where Is Your Proof?",
     "\"The creatures we fought last night are different from what I've seen in the Tide. Dr Ira, you say these are the Tidekin. Where is your proof?\"\n\n"
     "She stumbles over her words, caught off guard, but recovers quickly. \"What more proof do you need? This is the second attack by the same creatures. But this time there were more - a whole troop of them. Mark my words, they will strike again!\"\n\n"
     "The confrontation fills you with vigor.",
     image="/story/dr-ira.png", footnote=SQUARE_B_FOOT, onEnter=SQUARE_B_ACTIONS, next=HUB)
page("ch4-square-b-met", "TOWN SQUARE", "I Have Met the Tidekin",
     "\"I have fought many creatures of the Tide. And I have also met the Tidekin. I've spoken to them. They do not look like the creatures we fought last night, or show the same aggression. I do not believe the Tidekin mean us harm.\"\n\n"
     "The crowd murmurs. You hear many words of doubt, but not the same fervor as before. \"You'll see,\" Dr Ira promises calmly. \"And I hope you'll remember who was trying to protect you, and who led you astray.\"\n\n"
     "The confrontation fills you with vigor.",
     image="/story/dr-ira.png", footnote=SQUARE_B_FOOT, onEnter=SQUARE_B_ACTIONS, next=HUB)
page("ch4-square-c", "TOWN SQUARE", "The Delve Master",
     "You make eye contact with Master Bram and give him a firm nod.\n\n"
     "\"Dr Ira, I've let you rile these people long enough. I am the Delve Master. I was elected by these people to protect all of Bird's Nest. The delvers are doing everything in their power to learn what these creatures are.\" Bram does not falter. \"People of Bird's Nest, trust in the delvers and do not let fear guide your hand.\"\n\n"
     "A ripple goes through the crowd. They still seem agitated, but Bram's words have calmed at least some of them.",
     image="/story/ch2/master-bram.png",
     footnote="Choose a delver to gain a Level 3 Boss part from Bram as thanks. Decrease Dr Ira's opinion. " + FAV_FOOT.format(n="Dr Ira"),
     onEnter=[{"kind": "grant-boss-parts", "level": 3, "amount": 1, "to": "active-delver"}, fav("ira", "Dr Ira", -1)], next=HUB)

# ---------------------------------------------------------------- dahlia's cave
page("ch4-dahlia", "DAHLIA'S CAVE", "Humans. Tidekin. Unite.",
     "The cave glows faintly with strands of kelp-like moss. Dahlia rises from her tidal pool as you approach with Xavier, and listens intently as you describe the monsters that ravaged Bird's Nest, her petal-hair trembling like antennae.\n\n"
     "\"The people of Bird's Nest are growing angrier each day without answers,\" Xavier murmurs. \"Mother, I'm worried they will come after you and the Tidekin.\"\n\n"
     "\"Humans. Tidekin. Unite,\" Dahlia says after a long pause. \"Help them.\" Haltingly, she explains that the Tidekin's settlement is being poisoned by runoff from pipes that drain Bird's Nest into the Tide. \"Stop pipes... elders listen. Elders know truth.\"",
     image="/story/ch2/academy-xavier.png", onEnter=[spend()],
     choices=[choice("Commit to seeking diplomacy with the Tidekin", "ch4.dahlia.A", "ch4-dahlia-a", hint="???"),
              choice("Press Dahlia for more detail", "ch4.dahlia.B", "ch4-dahlia-b", hint="Grants Knowledge"),
              choice("Admire her willingness to trust in you", "ch4.dahlia.C", "ch4-dahlia-c", hint="Affects Favor")])
page("ch4-dahlia-a", "DAHLIA'S CAVE", "Diplomacy",
     "\"If your elders hold the truth, then Bird's Nest must hear it. Let us walk openly together - your people and mine - and find the true source of this.\" Dahlia beams with hope, petals blooming faintly.",
     footnote="Add Quest #04 \"A Hand Outstretched\" (a Memory Chip if already owned or completed).",
     onEnter=[chip_or_quest(*Q4)], next=HUB)
page("ch4-dahlia-b", "DAHLIA'S CAVE", "Made, Not Born",
     "\"You've seen this corruption before - how could these tissues appear in both the Carnatia and these monsters, and why?\"\n\n"
     "Dahlia frowns, plucking a glowing strand of moss between her fingers. \"Not certain... Tissue made. Not born.\" She searches for the words. \"Make puppets... of living. Puppets take my kin.\" She looks away. \"Only guess.\"",
     footnote="Add Key Item #21.",
     onEnter=[{"kind": "gain-key-item", "number": 21, "name": "Bioluminescence"}], next=HUB)
page("ch4-dahlia-c", "DAHLIA'S CAVE", "The Example You Set",
     "\"You amaze me, Dahlia, in your willingness to trust a near stranger, despite everything you've been through. There is danger on all sides, but I do it gladly - to live up to the example you set.\"\n\n"
     "Dahlia's orchid-petals flush with a faint shimmer. She holds your gaze a heartbeat too long before turning away with a small, knowing smile.",
     footnote="Increase Dahlia's opinion. " + FAV_FOOT.format(n="Dahlia"),
     onEnter=[fav("dahlia", "Dahlia", 1)], next=HUB)

# ---------------------------------------------------------------- town center
page("ch4-town-center", "DELVING ACADEMY", "Materials Request",
     "Headmistress Arlen and Rodrigo approach you excitedly. \"Delvers! Rodrigo had a startling insight - I'll let him explain.\"\n\n"
     "\"I've been reading old delving journals in the restricted section, and I finally figured out why delvers are so intent on reaching Gaia! You know that metal cart Witness drags around? When delvers reach Gaia, Witness presents the cart to her, and she performs some kind of alchemical process on it and it starts to glow. It's this very material that all delversuits are made of!\"\n\n"
     "\"I'm going to have a heart to heart with Bram after this,\" Arlen says. \"But could you spare another batch of creature parts? We're so close to understanding.\"\n\n"
     "Donations count towards your RUNNING total across the campaign. Arlen's reaction hints: about 5 - \"You hide your ungratefulness well.\" About 16 - \"You could have spared a few more creature parts, but I suppose beggars can't be choosers.\" About 28 - \"That is very giving of you.\" About 38 - \"You continue to surpass my highest expectations.\"",
     image="/story/ch2/town-center-arlen.png",
     footnote="Shop Products #19-24 are now available. With 2+ clue icons on your Key Items, also #25; with 5+, also #26.",
     onEnter=[{"kind": "add-shop-products", "products": [19, 20, 21, 22, 23, 24]},
              {"kind": "add-shop-products-if-key-items-min", "minKeyItems": 2, "products": [25]},
              {"kind": "add-shop-products-if-key-items-min", "minKeyItems": 5, "products": [26]}],
     next="ch4-shop")
page("ch4-shop", "TOWN CENTER", "Visit the Shops",
     "Each player may purchase products using their minion and/or boss parts. You may convert a Boss part into minion parts at 3 minion parts per level of the Boss part. Check your Opinion cards for discounts or markups.",
     postRewardsText="When everyone is done shopping, click Continue.",
     kind="shop", next="ch4-donation-results")
page("ch4-donation-results", "DELVING ACADEMY", "Experimental Division Results",
     "__arlen-donation-reaction-ch4__",
     image="/story/ch2/town-center-arlen.png",
     footnote="Running total 11-20: one player +1 Armor, other +1 Boots. 21-34: +2 Armor / +2 Boots. 35+: each player +2 Rank of any equipment.",
     onEnter=[{"kind": "resolve-academy-donation", "schedule": "ch4"}], next="ch4-jobs")

# ---------------------------------------------------------------- jobs board
page("ch4-jobs", "TOWN CENTER", "View the Jobs Board",
     "The Jobs Board outside the Academy is crowded with requests. Delvers with Open Quests are paid a retainer for each one they're pursuing.",
     choices=[choice("Collect your retainer", "ch4.jobs.retainer", "ch4-jobs-retainer", requireOpenQuests="positive"),
              choice("Face the board empty-handed", "ch4.jobs.none", "ch4-jobs-roll", requireOpenQuests="zero")])
page("ch4-jobs-retainer", "TOWN CENTER", "Retainer",
     "The Academy clerk tallies up your Open Quests and counts out your pay.",
     footnote="Both delvers gain 1 minion part per Open Quest.",
     onEnter=[{"kind": "grant-minion-parts-per-open-quest", "perQuest": 1, "to": "all-delvers"}], next="ch4-jobs-choice")
page("ch4-jobs-roll", "TOWN CENTER", "No Open Quests",
     "You have no Open Quests to show for yourselves. Headmistress Arlen, pinning up a notice of her own, raises an eyebrow.",
     dieRoll=[{"min": 1, "max": 4, "label": "1-4: Arlen is unimpressed", "next": "ch4-jobs-unimpressed"},
              {"min": 5, "max": 6, "label": "5-6: Arlen shrugs it off", "next": "ch4-jobs-choice"}])
page("ch4-jobs-unimpressed", "TOWN CENTER", "Unimpressed",
     "\"A lacklustre investigation, delvers. Bird's Nest deserves better.\"",
     image="/story/ch2/academy-arlen.png", footnote="Decrease Arlen's opinion.",
     onEnter=[fav("arlen", "Headmistress Arlen", -1)], next="ch4-jobs-choice")
page("ch4-jobs-choice", "TOWN CENTER", "Take a Job",
     "Three requests catch your eye.\n\n"
     "Xavier is soliciting help from a delver. He's been researching a corruption called the Tidebloom that has been spreading, and requests help to collect a sample.\n\n"
     "A Shadow District street urchin is selling a copy of a map - \"Old Aguilar drew it for his delving partner, back before the Tide took her. Leads to a vault in Second Nest.\""
     "\n\nElayna found a door leading to a basement underneath the burned watchtower that gave her the heebie jeebies - she's put in a request for a delver to check it out.",
     choices=[choice("Xavier needs help collecting a Tidebloom sample", "ch4.jobs.A.xavier", "ch4-jobs-a"),
              choice("Buy a street urchin's copy of a map to Second Nest (5 minion parts)", "ch4.jobs.B.fence", "ch4-jobs-b",
                     prePay={"kind": "minion-parts", "amount": 5}),
              choice("Elayna wants a delver to check the watchtower basement", "ch4.jobs.C.elayna", "ch4-jobs-c")])
page("ch4-jobs-a", "TOWN CENTER", "Xavier's Request",
     "You put your name down on Xavier's request.",
     footnote="Add Quest #03. If already owned or completed, instead gain a Memory Chip token.",
     onEnter=[chip_or_quest(*Q3)], next="ch4-before-chapter-5")
page("ch4-jobs-b", "TOWN CENTER", "The Forgotten Vault",
     "You count out the minion parts. The urchin presses the folded map into your hand and vanishes into the crowd.",
     footnote="The paying delver loses 5 minion parts. Add Quest #06. If already owned or completed, instead gain a Memory Chip token.",
     onEnter=[{"kind": "lose-minion-parts", "amount": 5, "to": "active-delver"}, chip_or_quest(*Q6)], next="ch4-before-chapter-5")
page("ch4-jobs-c", "TOWN CENTER", "Underneath the Watchtower",
     "You put your name down on Elayna's request.",
     footnote="Add Quest #13. If already owned or completed, instead gain a Memory Chip token.",
     onEnter=[chip_or_quest(*Q13)], next="ch4-before-chapter-5")

page("ch4-before-chapter-5", "END OF CHAPTER 4", "Before Chapter 5",
     "Before the next chapter begins, Xavier's request must be settled - whatever became of his assistant in the Tide, you need to see it through.",
     footnote="Quest #03 must be completed before Chapter 5. If it isn't, play it now (no Story token needed) and repeat until it's complete.",
     choices=[choice("Play Quest #03 - Xavier's Request", "ch4.before5.q3", "ch4-q3-required",
                     image="/quests/quest-03.jpg", hideIfDecisionMade="quest.3.completed"),
              choice("Continue to Chapter 5", "ch4.before5.done", "ch4-end", requireDecision="quest.3.completed")])
page("ch4-q3-required", "QUEST #03: XAVIER'S REQUEST", "Into the Tide",
     "Xavier needs a Tidebloom sample taken from the infected creatures of the Tide. His assistant will meet you out there. Witness hums beside you, ready to go.",
     image="/story/ch2/academy-xavier.png", startQuest="quest3", next="ch4-before-chapter-5")
page("ch4-end", "END OF CHAPTER 4", "The Passing of the Torch",
     "Smoke still drifts over the rebuilt barricades. Bird's Nest survived the night, but everyone saw Bram freeze - and everyone saw who took the reins.",
     kind="end-town-visit", onEnter=[rec("ch4.completed")])

chapter = {"id": "ch4", "name": "The Passing of the Torch", "startPageId": "ch4-story-so-far", "pages": pages}
out = Path(sys.argv[1]) / "data" / "chapter4.json"
out.write_text(json.dumps(chapter, indent=2, ensure_ascii=False) + "\n", encoding="utf8")
print(len(pages), "pages ->", out)
