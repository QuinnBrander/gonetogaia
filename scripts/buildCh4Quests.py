"""Build data/quest4.json, data/quest7.json and data/quest13.json (the
Chapter 4 quests) from the revised Chapters 3-4 book text. Edit this script,
not the JSON. Quest #7's conclusion and Secret Town Visit live in the
chapter Town Visits (scripts/questPages.py).

Usage: python -I scripts/buildCh4Quests.py <G2G root>"""
import json
import sys
from pathlib import Path

SPAWN = {"kind": "spawn-deck", "boardSize": {"w": 5, "h": 5}, "deck": "base"}
DEFEAT = "The creatures swarm you and you black out. Your Quest is ended."


def minions(prefix, first):
    return [f"{prefix}-{first + i:03d}" for i in range(7)]


def wave(n, goal, boss, mins, q, eow, **kw):
    # No Scenario Deck draws (2026-11-17): the storybook End-of-Wave
    # choices replace them - see SCENARIO_STORYBOOK_SPEC.md.
    w = {"number": n, "goal": goal, "spawn": SPAWN, "bossEnemyId": boss, "minionEnemyIds": mins,
         "endOfWave": {"bothSurvive": f"{q}_w{n}_end", "anyDie": f"{q}_w{n}_defeat"}, "eow": eow}
    w.update(kw)
    return w


def bonus(label, page, item, carry, rewards=None):
    """Key-Item bonus continue option: always shown, only selectable while
    the party owns Key Item #item (the screen leads the label with the lock)."""
    return opt(label, page, "next-wave", carry=carry, rewards=rewards, requireKeyItem=item)


# Bonus rewards favour things Chapters 3-4 can't otherwise grant (the
# Equipment Upgrade Shop Products the Scenario Cards used to give), plus the
# moment's normal continue reward. A product that's already Purchasable or
# owned becomes a Memory Chip token instead.
PRODUCT = lambda n: {"kind": "add-shop-products", "products": [n], "chipFallback": 1}
PRODUCT_NOTE = " to your Purchasable Products (a Memory Chip token if it's already available or owned)."


def opt(label, page, then, carry=None, rewards=None, **kw):
    o = {"label": label, "pageId": page, "then": then}
    if carry:
        o["carryEffects"] = carry
    if rewards:
        o["rewards"] = rewards
    o.update(kw)
    return o


def complete(n, name):
    return {"kind": "complete-quest", "number": n, "name": name}


HEAL = lambda n: {"kind": "heal-both-delvers", "amount": n}
ELEMENTS = lambda n: {"kind": "grant-element-choice-each", "amount": n}
LEVEL = {"kind": "grant-level-up-card", "amount": 1}

# ------------------------------------------------------------------ Quest #4
q4_pages = {
    "wave1_intro": "Dahlia leads you deeper into the Mistwood, her petals glowing faintly as the mist thickens around you.",
    "wave1_intro_ability_name": "Backup, Evasive",
    "wave1_intro_ability_rules": "Backup (Boss): When this boss is damaged by a weapon card, 2 additional enemies also attempt to counterattack.\n\nEvasive (Boss and Minions): These enemies suffer half damage, rounding up, unless both delvers are adjacent to it.",
    "q4_w1_end": "As you continue your trek through the Mistwood, Dahlia stops abruptly and motions silently at a clearing ahead. A troop of primates are poised in the circle, their many tails moving in all directions as if sensing something in the air. At the center of their circle, a larger primate sits with eyes closed in a meditative pose.\n\n\"Very intelligent creatures,\" Dahlia informs you in a quiet voice. \"No harm.\" You need to get past them, but perhaps you do not need to fight.",
    "q4_w1_defeat": DEFEAT,
    # Owner's Quest #4 Wave 1 fix (2026-11-17): results shown on the choice.
    "q4_w1_attack": "You charge into the clearing. You easily cut them down as Dahlia gives you a dark look.\n\nBoth delvers gain 4 elements of their choice.",
    "q4_w1_pass": "These Senselle are said to be able to read minds and thus know imminent danger. Dahlia stands and the petals on her head begin to shine with a beautiful blue light. She calmly walks into the clearing. All the Senselles' tails dart towards her, but the creatures don't move a muscle.\n\nDahlia glides around the circle and reaches the other side, nodding quickly for you to follow. With slow, deliberate movements you edge around the creatures, arms up to show you mean no harm. At last you make it to the other side as 15 pairs of eyes continue to stare at you through the foliage.\n\nBoth delvers heal 3 HP.",
    "q4_w1_retreat": "\"Hurt.\" Dahlia examines your injuries with concern. \"Not safe now. Return again.\" You want to protest that you can continue, but think better of it. You vow to try another day.\n\nYour Quest is ended.",
    "q4_w2_end": "The last of the Squiddies slips back into the mist.",
    "q4_w2_defeat": DEFEAT,
    "q4_tidekin": "The Mistwood grows denser, taller trees obscuring the light of the sun. Dahlia's petals glow ever brighter in the dimness. Ahead, the Tide has transformed the vegetation, warping the trees so their branches swirl and bend in all directions - nature through the lens of someone's dream.\n\nThen, movement. Figures melt out of the trees into the clearing. Tidekin, dozens of them. Some bear petals like Dahlia; others sport gemlike protrusions that make the earth quake as they step toward you. Dahlia steps forward and they all turn towards her without a word, communicating silently.\n\nThe oldest-looking Tidekin, with branch-like hands, points at you. Dahlia shakes her head. \"Afraid,\" she says with sadness. \"Blame humans for trouble.\"\n\nSuddenly several Tidekin make a strange, guttural noise. From behind you, a hulking form emerges. It looks like a Tidekin, but it bears one giant claw and serrated teeth in its gnashing mouth. The Tidekin have already disappeared into the woods. You're left alone to deal with the creature.\n\nDelvers gain 2 elements (your choice). New goal: slay the Ruined Tidekin.",
    "q4_w2_retreat": "\"You hurt.\" Dahlia examines your injuries with concern. She looks around for her kin, but they are gone. \"No help now. We return.\"\n\nYour Quest is ended.",
    "q4_salvio": "As you strike the killing blow against the mutated creature, the remaining Exanimates stop, as if they were electronics whose power had been cut.\n\nDahlia examines the body. There are tears in her eyes. \"Salvio,\" she murmurs. \"Kind friend. Brave helper, missing many moons.\" His tracks, she explains, led directly towards the shores of Bird's Nest.\n\nShe motions to Salvio's wrist, where the scales have been stripped away - he had been restrained and struggled against his shackles. His chest is dotted with small punctures, like those made by the point of a needle. \"Someone hurt Salvio, change him. Why? Why?\" She looks at you for answers, but you have none.\n\nYour Quest is complete! Delvers gain a Level 3 Boss part, Key Item #14 and Dahlia's favour.\n\nA moment later, the Exanimates spring back to life. Return to combat.",
    "q4_w3_end": "With Salvio laid to rest and the threat stopped, Dahlia suggests you head back to town for now and try again with her kin another day. You agree.",
    "q4_w3_defeat": DEFEAT,
}
q4 = {
    "id": "quest4", "name": "A Hand Outstretched", "goal": "Reach the Tidekin Settlement (Wave 3)", "primaryGoalWaveNumber": 3,
    "intro": [],
    "waves": [
        wave(1, "Reach the Tidekin Settlement (Wave 3).", "hugh-112", minions("emberwing", 113), "q4",
             {"defeat": {"pageId": "q4_w1_defeat"}, "victory": [
                 opt("A - Continue: Attack the creatures: both delvers gain 4 ELEMENTS of their choice", "q4_w1_attack", "next-wave", carry=[ELEMENTS(4)]),
                 opt("A - Continue: Find a way to pass without disturbing them: both delvers heal 3 HP", "q4_w1_pass", "next-wave", carry=[HEAL(3)], nextWaveNumber=3),
                 opt("B - Retreat", "q4_w1_retreat", "end-quest")]}),
        wave(2, "Reach the Tidekin Settlement (Wave 3).", "arnold-120", minions("squiddy", 88), "q4",
             {"defeat": {"pageId": "q4_w2_defeat"}, "victory": [
                 opt("A - Continue", "q4_tidekin", "next-wave", carry=[ELEMENTS(2)]),
                 opt("B - Retreat", "q4_w2_retreat", "end-quest"),
                 bonus("C - Tell the elder about the abducted kin: add Shop Product #32 Earth's Embrace Shield to your Purchasable Products, and both delvers gain 2 ELEMENTS of their choice",
                       "q4_tidekin_kin", 10, [ELEMENTS(2)], rewards=[PRODUCT(32)])]}),
        wave(3, "Slay the Ruined Tidekin.", "ruinedtidekin-121", minions("exanimate", 122), "q4",
             {"defeat": {"pageId": "q4_w3_defeat"}, "victory": [opt("Return to Bird's Nest", "q4_w3_end", "end-quest")]},
             onBossSlain={"pageId": "q4_salvio", "rewards": [
                 complete(4, "A Hand Outstretched"),
                 {"kind": "grant-boss-parts", "level": 3, "amount": 1, "to": "all-delvers"},
                 {"kind": "gain-key-item", "number": 14, "name": "Corpse of Ruined Tidekin"},
                 {"kind": "shift-favour", "characterId": "dahlia", "characterName": "Dahlia", "delta": 1}]}),
    ],
    "pages": q4_pages,
}

# ------------------------------------------------------------------ Quest #7
q7 = {
    "id": "quest7", "name": "Further Afield", "goal": "Reach the ruins of High Nest (Wave 3)", "primaryGoalWaveNumber": 3,
    "intro": [],
    "waves": [
        wave(1, "Reach the ruins of High Nest (Wave 3).", "spike-129", minions("emberwing", 113), "q7",
             {"defeat": {"pageId": "q7_w1_defeat"}, "victory": [
                 opt("A - Continue", "q7_w1_continue", "next-wave", carry=[LEVEL]),
                 opt("B - Retreat", "q7_w1_retreat", "end-quest"),
                 bonus("C - Follow Elias's signal notes: add Shop Product #35 Ion Battery to your Purchasable Products, and gain a LEVEL UP card",
                       "q7_w1_notes", 22, [LEVEL], rewards=[PRODUCT(35)])]}),
        wave(2, "Reach the ruins of High Nest (Wave 3).", "anna-130", minions("ophidian", 15), "q7",
             {"defeat": {"pageId": "q7_w2_defeat"}, "victory": [
                 opt("A - Continue", "q7_w2_continue", "next-wave", carry=[HEAL(3)]),
                 opt("B - Retreat", "q7_w2_retreat", "end-quest")]}),
        wave(3, "Survive to the end of Wave 3.", "winona-131", minions("tidegazer", 48), "q7",
             {"defeat": {"pageId": "q7_w3_defeat"}, "victory": [
                 opt("Enter the ruins", "q7_w3_ridge", "end-quest", rewards=[{"kind": "record-decision", "key": "quest.7.reached-high-nest"}])]}),
    ],
    "pages": {
        "wave1_intro": "You follow the signal west through the mist, towards the ruins of High Nest.",
        "wave1_intro_ability_name": "Invulnerable, Evasive",
        "wave1_intro_ability_rules": "Invulnerable (Boss): Starts without a monster token. After being damaged by an attack, place a monster token on it. While it has the token, the next delver attack deals no damage - then remove the token.\n\nEvasive (Boss and Minions): These enemies suffer half damage, rounding up, unless both delvers are adjacent to it.",
        "q7_w1_end": "The last Emberwing gutters out in the mist.",
        "q7_w1_defeat": DEFEAT,
        "q7_w1_continue": "The road to High Nest is wide and full of potholes, with many lanes littered with long-abandoned vehicles. You scavenge some material that could come in handy.\n\nDelvers gain a Level card.",
        "q7_w1_retreat": "The Emberwings leave you scorched and staggering, each step heavier than the last. The path ahead flickers with danger you can't withstand. You turn back, letting the ruins fade into the mist.\n\nYour Quest is ended.",
        "q7_w2_end": "Anna the Snake lies still among the wrecks.",
        "q7_w2_defeat": DEFEAT,
        "q7_w2_continue": "As you begin ascending again, you think back on your history lessons. High Nest was the largest of the seven nests established after the Great Calamity, and the first to fall. Back then it was called First Nest, but almost no one uses that name anymore.\n\nDelvers heal up to 3 HP.",
        "q7_w2_retreat": "The Snatchers' bites leave you bleeding and unsteady, your strength slipping away. Knowing the path ahead offers only more teeth in the dark, you choose survival.\n\nYour Quest is ended.",
        "q7_w3_end": "Winona the Oak crashes down across the road.",
        "q7_w3_defeat": "The swarm crashes over you, and the world fades to black. When you come to, Witness is carrying you. Whatever awaits you in the ruins will wait a little longer.\n\nYour Quest is ended.",
        "q7_w3_ridge": "The entrance to the ruin begins at the apex of a high ridge. Back in Bird's Nest, read \"Quest #07 Conclusion\".",
    },
}

# ------------------------------------------------------------------ Quest #13
q13 = {
    "id": "quest13", "name": "Underneath the Watchtower", "goal": "Explore the hidden basement (Wave 4)", "primaryGoalWaveNumber": 4,
    "intro": [],
    "waves": [
        wave(1, "Explore the hidden basement (Wave 4).", "billy-132", minions("venena", 8), "q13",
             {"defeat": {"pageId": "q13_w1_defeat"}, "victory": [
                 opt("A - Continue", "q13_w1_continue", "next-wave", carry=[ELEMENTS(2)]),
                 opt("B - Retreat", "q13_w1_retreat", "end-quest"),
                 bonus("C - Match the green paint chips: add Shop Product #41 Shock Gauntlet to your Purchasable Products, and both delvers gain 2 ELEMENTS of their choice",
                       "q13_w1_paint", 9, [ELEMENTS(2)], rewards=[PRODUCT(41)])]}),
        wave(2, "Explore the hidden basement (Wave 4).", "laura-133", minions("colibrius", 40), "q13",
             {"defeat": {"pageId": "q13_w2_defeat"}, "victory": [
                 opt("A - Continue", "q13_w2_continue", "next-wave", carry=[HEAL(3)]),
                 opt("B - Retreat", "q13_w2_retreat", "end-quest")]}),
        wave(3, "Explore the hidden basement (Wave 4).", "george-134", minions("blackguard", 64), "q13",
             {"defeat": {"pageId": "q13_w3_defeat"}, "victory": [
                 opt("A - Continue", "q13_w3_continue", "next-wave", carry=[LEVEL]),
                 opt("B - Retreat", "q13_w3_retreat", "end-quest")]}),
        wave(4, "Survive to the end of Wave 4.", "revenant-135", minions("experiment", 136), "q13",
             {"defeat": {"pageId": "q13_w4_defeat"}, "victory": [
                 opt("Return to Bird's Nest", "q13_w4_gone", "end-quest", rewards=[
                     complete(13, "Underneath the Watchtower"),
                     {"kind": "gain-key-item", "number": 20, "name": "The Secret Lab is Gone"}])]}),
    ],
    "pages": {
        "wave1_intro": "You climb down through the green hatch. The air below is stale and still. What's inside, you wonder?",
        "wave1_intro_ability_name": "Double Edged, Fatal Flaw",
        "wave1_intro_ability_rules": "Double Edged (Boss): This boss deals and suffers double damage when its black arrow is targeting a delver.\n\nFatal Flaw (Boss and Minions): These enemies can only be killed in the order specified next to this ability. Enemies with sequential numbers can be killed at the same time. They can still suffer damage in any order - only the final point of damage remains.",
        "q13_w1_end": "Billy the Bear slumps against the scorched wall.",
        "q13_w1_defeat": DEFEAT,
        "q13_w1_continue": "You knew the hatch was there, but no one imagined what lay beneath it - a basement that survived the blaze, crawling with creatures that shouldn't be able to exist in open air. The walls are scorched but intact, the air thick and wrong, carrying a faint chemical sting beneath the smoke. These things aren't wild.\n\nYou tighten your grip on your weapon and push deeper into the dark. Whatever happened here wasn't an accident - and you're about to find out why.\n\nDelvers gain 2 elements (your choice).",
        "q13_w1_retreat": "You never imagined the Watchtower's basement had survived the blaze, let alone that it was full of monsters. Well, that's enough life endangerment for today.\n\nYour Quest is ended.",
        "q13_w2_end": "Laura the Flytrap folds in on itself.",
        "q13_w2_defeat": DEFEAT,
        "q13_w2_continue": "The flytrap's movements linger in your mind - it didn't thrash or lash out blindly, but struck with precision, almost... trained. Even now, you can't shake the feeling that it was following some unseen command. Creatures of the Tide don't behave like that. You press onward, unease settling deep in your chest.\n\nDelvers heal up to 3 HP.",
        "q13_w2_retreat": "The deeper you look, the less any of this feels natural, and that realization unsettles you more than the creatures themselves. Whatever purpose these creatures serve, they're beyond what you can handle.\n\nYour Quest is ended.",
        "q13_w3_end": "George the Ape crashes to the floor.",
        "q13_w3_defeat": DEFEAT,
        "q13_w3_continue": "That Ape had needles falling out of its flesh when it first came running towards you. Someone's been running experiments, but to what end?\n\nGain a Level card.\n\nAs you reach the lowest floor, you gaze on rows upon rows of creatures immersed in pods filled with yellow liquid, neat handwritten labels beneath each. In the center of the room is the corpse of a human suspended in the air, monster parts forcibly grafted in - the metal connections clearly visible. You retch involuntarily. The corpse opens its eyes and glares at you. It reaches a clawed hand to sever the connections holding it to the ceiling, and scuttles toward you.",
        "q13_w3_retreat": "The deeper you go, the more wrong everything feels - needles, containment, tamed monsters. The goosebumps on your arm tell you the worst is just around the corner, so you turn back, leaving the nightmare beneath the Watchtower undisturbed.\n\nYour Quest is ended.",
        "q13_w4_end": "The Incomplete Revenant twitches and goes still.",
        "q13_w4_defeat": DEFEAT,
        "q13_w4_gone": "Many of the creatures in the submerged pods are beginning to wake up. You flee for your lives and slam the door behind you.\n\nYou run back to the town square and collapse, exhausted. When you come to, the first light of a new day is peeking out. You head straight to Master Bram's office and report what you found. He doesn't believe you, but agrees to follow you to the entrance. When you open the door, however, all of the creatures and pods are gone.\n\nBram laughs. \"That was a good prank! I have to hand it to you, you had me a little scared for a moment. I do have to go though, much to do.\" He leaves.\n\nYour Quest is complete! Add Key Item #20.",
    },
}

# ------------------------------------------------- Key-Item bonus pages
# Each bonus page is its moment's continue page with a Key-Item paragraph
# and the bonus result line (the story beat that leads into the next wave
# must stay identical).
def bonus_page(pages, base, new, old_tail, new_tail):
    text = pages[base]
    if old_tail not in text:
        raise SystemExit(f"{base}: expected tail not found: {old_tail!r}")
    pages[new] = text.replace(old_tail, new_tail)


bonus_page(q4_pages, "q4_tidekin", "q4_tidekin_kin",
           "Suddenly several Tidekin make a strange, guttural noise.",
           "You tell the elder what you overheard at the festival: Tidekin taken, held somewhere near Bird's Nest. "
           "The elder's branch-like hand lowers. From the roots at its feet it draws a shield of living stone and "
           "moss, and presses it into your arms.\n\nSuddenly several Tidekin make a strange, guttural noise.")
q4_pages["q4_tidekin_kin"] = q4_pages["q4_tidekin_kin"].replace(
    "Delvers gain 2 elements (your choice). New goal: slay the Ruined Tidekin.",
    "Add Shop Product #32 (Earth's Embrace Shield)" + PRODUCT_NOTE
    + " Delvers gain 2 elements (your choice). New goal: slay the Ruined Tidekin.")
bonus_page(q7["pages"], "q7_w1_continue", "q7_w1_notes",
           "You scavenge some material that could come in handy.\n\nDelvers gain a Level card.",
           "You scavenge some material that could come in handy.\n\n"
           "Elias's distress-signal notes list the frequencies he monitored - and a relay station along this very "
           "road. Inside, still wired to a dead transmitter, sits one of his ion cells, fully charged.\n\n"
           "Add Shop Product #35 (Ion Battery)" + PRODUCT_NOTE + " Delvers gain a Level card.")
bonus_page(q13["pages"], "q13_w1_continue", "q13_w1_paint",
           "You tighten your grip on your weapon and push deeper into the dark.",
           "Back at the hatch frame, flaking green paint catches your eye - the same shade as the chips torn from "
           "the festival generator. Whoever attacked the generator came from down here. Behind the frame you find "
           "their supply crate, and in it a gauntlet wired with prods that still spark.\n\n"
           "You tighten your grip on your weapon and push deeper into the dark.")
q13["pages"]["q13_w1_paint"] = q13["pages"]["q13_w1_paint"].replace(
    "Delvers gain 2 elements (your choice).",
    "Add Shop Product #41 (Shock Gauntlet)" + PRODUCT_NOTE + " Delvers gain 2 elements (your choice).")

# Scenario Cards folded into the continue moments (shared with quests 3, 5, 6
# and the booklet): scripts/storybookChoices.py.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from storybookChoices import apply_to_quest  # noqa: E402
for number, q in ((4, q4), (7, q7), (13, q13)):
    apply_to_quest(q, number)

root = Path(sys.argv[1]) / "data"
for name, q in (("quest4", q4), ("quest7", q7), ("quest13", q13)):
    (root / f"{name}.json").write_text(json.dumps(q, indent=2, ensure_ascii=False) + "\n", encoding="utf8")
    print(name, len(q["waves"]), "waves")
