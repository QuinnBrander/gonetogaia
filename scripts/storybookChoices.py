"""Storybook continue choices for the Chapter 3-4 quests (2026-11-17).

The Scenario Card a wave used to draw at its start is folded into the
*continue* entry leading into that wave - the same pattern as Quest #2
(see SCENARIO_STORYBOOK_SPEC.md). Each continue moment becomes a
"Choose one" whose options show their results, keep the old fixed continue
reward (so the game is never harder), and have no downside. Optional Key
Item bonus options (requireKeyItem) are part of the same choice.

Shared by:
- scripts/applyStorybookChoices.py (quests 3, 5, 6 - hand-authored JSON)
- scripts/buildCh4Quests.py (quests 4, 7, 13)
- tools/booklet/storychoices_doc.py (the board-game booklet)

Each MOMENT:
  base     - the continue page id; its text, minus `old_reward`, is the story.
  split    - optional sentence the scenario is inserted BEFORE (story-flow:
             the scene must happen before the fight starts, etc.). Text from
             `split` on is `after` (it follows the choice).
  old_reward - the fixed reward line in the base page (removed; each option
             keeps it as effects).
  goal     - optional trailing line kept on every option ("New goal: ...").
  scene    - the scenario narrative (from the card, adapted to the place).
  options  - (label, resolution, extra effects, extra rewards).
  keep     - effects every option keeps (the old continue reward).
  rewards  - campaign rewards every option keeps (e.g. Quest #6 completion).
  bonus    - existing Key Item bonus option id (kept, listed after options).
"""

HEAL = lambda n: {"kind": "heal-both-delvers", "amount": n}
EL = lambda n: {"kind": "grant-element-choice-each", "amount": n}
LEVEL = {"kind": "grant-level-up-card", "amount": 1}
XP = lambda n: {"kind": "gain-xp", "amount": n}
AP = {"kind": "grant-ap-one-delver", "amount": 1}
FRIENDLY = {"kind": "grant-friendly-spawn-card"}
TOKEN = lambda k: {"kind": "grant-consumable-token-one-delver", "tokenKind": k, "amount": 1}
RANK = lambda t, n: {"kind": "grant-equipment-rank-one-delver", "equipmentType": t, "amount": n}
FAV = lambda cid, name, d: {"kind": "shift-favour-by-scenario", "characterId": cid, "characterName": name, "delta": d}
PRODUCT = lambda n: {"kind": "add-shop-products", "products": [n], "chipFallback": 1}

# Lieutenant challenge (2026-11-17): every continue moment of Quest #4+ that
# leads into Wave 3 or later gets one more option. It keeps the moment's
# continue reward, adds a Level card and a boss part of the next wave's
# level for each delver, and puts the next Lieutenants Spawn Card (#19-24)
# on top of the Spawn Deck - it stays in the deck for the rest of the
# campaign (engine/lieutenants.ts). Listed before the Key Item bonus.
LIEUTENANT_LABEL = "Challenge the Lieutenant"
LIEUTENANT_RES = ("Word of your victories has spread. A Lieutenant steps out of the mist and raises its "
                  "weapon in challenge. You accept.")
LT_CHALLENGE = {"kind": "lieutenant-challenge"}
BOSS_PARTS = lambda level: {"kind": "grant-boss-parts", "level": level, "amount": 1, "to": "all-delvers"}

def lieutenant_eligible(m):
    return m["quest"] >= 4 and m["wave"] >= 2

def lieutenant_option(level):
    """`level`: the next wave's boss level (game quests), or None in the
    booklet-only quests (the text then says "of the next wave's level")."""
    return (LIEUTENANT_LABEL, LIEUTENANT_RES, [LEVEL], [LT_CHALLENGE, BOSS_PARTS(level)])

PRODUCT_NAMES = {32: "Earth's Embrace Shield", 33: "Living Armor", 34: "Cyclone Boots", 35: "Ion Battery",
                 37: "Ancient OS", 38: "Overcharger", 41: "Shock Gauntlet", 42: "Fabled Hammer",
                 43: "Sword of Ruin", 44: "War Mace"}

MOMENTS = [
    # ------------------------------------------------------------ Quest #3
    dict(quest=3, wave=1, base="q3_w1_continue", split="You crest the ridge.",
         old_reward="Delvers gain 2 elements (your choice).", goal="New goal: slay the Carnatia!",
         card="#03 Bud", keep=[EL(2)], bonus=2,
         scene="On the climb, your way is blocked by a field of turquoise plants. Their bulbous buds expand and contract as if breathing, a viscous liquid moving inside each one.",
         options=[
             ("Capture some of the liquid in a vial", "You collect the sap in a vial, but not before spilling some on your gauntlet. It seeps through and paralyzes you briefly. This could come in handy.", [TOKEN("prevent-counterattack")], []),
             ("Step carefully between the plants", "Threading a careful path through the field sharpens your awareness of the here and now.", [AP], []),
         ]),
    dict(quest=3, wave=2, base="q3_w2_continue",
         old_reward="Delvers heal up to 2 HP.", card="C Elders", keep=[HEAL(2)],
         scene="As you set off, branch-like fingers part the mist. A Tidekin elder blocks your path, watching you without a sound.",
         options=[
             ("Lower your weapons", "The elder touches your helmet and a vision floods your mind - a pipe pouring black sludge into the Tide. Then it is gone.", [HEAL(2), FAV("dahlia", "Dahlia", 1)], []),
             ("Offer a creature part as a gift", "The elder accepts it and vanishes. Later, you notice the creatures of the Tide give you a wider berth.", [FRIENDLY], []),
         ]),
    dict(quest=3, wave=3, base="q3_w3_continue",
         old_reward="Delvers gain a Level card.", card="#15 Static", keep=[LEVEL], bonus=12,
         scene="A few steps on, Witness stops dead. His eyes flicker and project a blurry image - a cold room, a small bed. Then he whirs and carries on as if nothing happened.",
         options=[
             ("Wait with him", "You sit beside him until his lights steady.", [HEAL(1), EL(1)], []),
             ("Tap the side of his head", "The projection snaps off and a spare circuit board drops out.", [RANK("OS", 1)], []),
             ("Keep moving", "Whatever that was, it can wait.", [XP(2)], []),
         ]),
    dict(quest=3, wave=4, base="q3_w4_continue", split="The air crackles with danger",
         old_reward="Delvers heal up to 4 HP.", card="#14 Siren Song", keep=[HEAL(4)],
         scene="A low, beautiful humming rolls through the mist. Through the kelp you see them - Sirens, swaying in a circle. Dr Ira's notes called them docile.",
         options=[
             ("Listen", "It's like being sung to sleep. Your wounds ache a little less.", [HEAL(2)], []),
             ("Plug your ears and push on", "You march past with grim focus.", [AP], []),
             ("Capture one for Dr Ira's research", "It screams the whole way back to the path, but its song still hums in your suit.", [RANK("Harvester", 1), FAV("ira", "Dr Ira", 1)], []),
         ]),
    # ------------------------------------------------------------ Quest #4
    dict(quest=4, wave=2, base="q4_tidekin", split="Suddenly several Tidekin make a strange, guttural noise.",
         old_reward="Delvers gain 2 elements (your choice).", goal="New goal: slay the Ruined Tidekin.",
         card="#16 Puppet", keep=[EL(2)], bonus=10,
         scene="Before Dahlia can say more, you notice one creature at the edge of the clearing standing perfectly still. A metal port is set into the back of its neck, a needle still inside.",
         options=[
             ("Pull the needle", "It thrashes, then looks at you with clear eyes before fleeing into the mist.", [FRIENDLY], []),
             ("Pocket the needle as evidence", "The tip is coated in a paralytic. It could come in handy.", [TOKEN("prevent-counterattack")], []),
         ]),
    # ------------------------------------------------------------ Quest #5
    dict(quest=5, wave=1, base="q5_w1_continue", split="You press on, following the trail into the unknown.",
         old_reward="Delvers gain a Level card.", card="#12 Clawprints", keep=[LEVEL], bonus=4,
         scene="Beside Vera's tracks run huge, fresh prints - each with a deep gouge where a single claw drags. Bioluminescent residue glows in every one.",
         options=[
             ("Track the prints a while", "You catch the creature sleeping in a hollow and slip past, learning exactly where to strike next time.", [TOKEN("damage-2x-universal")], []),
             ("Take a cast of the print for Xavier", "\"This is extraordinary,\" Xavier crackles over the comms.", [FAV("xavier", "Xavier", 1)], []),
         ]),
    dict(quest=5, wave=2, base="q5_w2_continue", split="Whoever you're pursuing must be inside.",
         old_reward="Delvers heal up to 3 HP.", card="#17 Small Footprints", keep=[HEAL(3)],
         scene="Near the base of the skyscraper, tiny bare footprints cross the mud. The mist curls away from each one, as if repelled.",
         options=[
             ("Follow them", "They end at an empty camp. A child's toy has been left behind, and the creatures nearby are strangely gentle.", [FRIENDLY], []),
             ("Brush them away so no one else can follow", "Whoever they belong to, they deserve a head start.", [FAV("elias", "Elias Brass", 1)], []),
             ("Mark them on your map", "Someone at the Academy will want to see this.", [LEVEL], []),
         ]),
    # ------------------------------------------------------------ Quest #6
    dict(quest=6, wave=1, base="q6_w1_continue", split="You ready yourselves and move in.",
         old_reward="Delvers gain 2 elements (your choice).", card="#10 Lantern", keep=[EL(2)],
         scene="Through the downpour drifts a paper festival lantern, its candle sheltered under the folds. A name is written on its side - someone set it loose for the Memorial.",
         options=[
             ("Follow it", "It leads you to a sheltered doorway and a previous delver's cache.", [LEVEL], []),
             ("Let it drift and say the name aloud", "You watch it go until the rain swallows its glow. A moment of peace.", [HEAL(2)], []),
             ("Salvage the candle", "The wax is laced with creature oil - it still holds a charge.", [RANK("Battery", 1)], []),
         ]),
    dict(quest=6, wave=2, base="q6_w2_continue", split="You decide to rest for a bit",
         old_reward="Add Shop Product #43 to your Purchasable Products. Your Quest is complete!\n\nYou're determined to carry on. This time you'll reach Gaia. Delvers gain a Level card.",
         card="#13 Waystation", keep=[LEVEL],
         rewards=[{"kind": "complete-quest", "number": 6, "name": "The Forgotten Vault"},
                  {"kind": "add-shop-products", "products": [43], "questLabel": "The Forgotten Vault"}],
         after_extra="You're determined to carry on. This time you'll reach Gaia.",
         scene="",
         options=[
             ("Take something", "Inside the container is a well-kept tool kit. You feel a twinge of guilt leaving nothing behind.", [LEVEL], []),
             ("Leave something", "You leave a ration and a note for whoever comes next.", [HEAL(3)], []),
         ]),
    dict(quest=6, wave=3, base="q6_w3_continue",
         old_reward="Delvers gain a Level card.", card="#09 Trails", keep=[LEVEL],
         scene="Your path diverges. One trail climbs steeply; the other delves ever deeper into the ruins. At the Academy you were taught that higher paths are safer - but less trodden paths sometimes reward bold delvers.",
         options=[
             ("Take the safer path", "The ruins are dangerous enough without making it worse.", [EL(2)], []),
             ("Tread the more dangerous road", "In the dark you hear ferocious monsters, but just as you're about to turn back you catch the glint of a rusted warhammer in the rubble.", [], [PRODUCT(42)]),
         ]),
    dict(quest=6, wave=4, base="q6_w4_continue",
         old_reward="Delvers heal 4 HP.", card="#04 Outpost", keep=[HEAL(4)], bonus=3,
         scene="Headmistress Arlen's voice comes through your comms. \"Delvers, would you mind a small detour? There's a cache of equipment hidden nearby that my students would benefit from greatly.\"",
         options=[
             ("Go, and give what you find to Arlen", "You find the cache and dutifully hand it to Witness for delivery to Arlen.", [FAV("arlen", "Arlen", 1)], []),
             ("Decline and stay on your mission", "Arlen grudgingly accepts. The focus does you good.", [EL(2)], []),
         ]),
    # ------------------------------------------------------------ Quest #7
    dict(quest=7, wave=1, base="q7_w1_continue", split="You scavenge some material that could come in handy.",
         old_reward="Delvers gain a Level card.", card="#08 Friends", keep=[LEVEL], bonus=22,
         scene="Xavier is your co-pilot today. \"Do you see that mound off in the distance? A friend of mine lives there - you should pop in and say hello for me.\"",
         options=[
             ("Go to the mound", "It appears Xavier's friend is a massive creature of the Tide. Luckily, this one is friendly.", [FRIENDLY], []),
             ("Skip the mound and scavenge the vehicles", "Your search of the abandoned cars pays off.", [LEVEL], []),
         ]),
    dict(quest=7, wave=2, base="q7_w2_continue",
         old_reward="Delvers heal up to 3 HP.", card="#07 Directions", keep=[HEAL(3)],
         scene="Samantha is guiding you through the comms, but she's backseat driving. \"Careful with that suspension hook - always lift from the ventrical. And your flick capacitor is a bit overactive today, so easy on the release valve. Oh, and...\" It's constant.",
         options=[
             ("Ask her to stick to giving directions", "She takes it well and focuses on offering useful advice.", [LEVEL], []),
             ("Let her continue", "Her advice is convoluted, but she's trying so hard. She promises to make it up to you.", [FAV("samantha", "Samantha", 1)], []),
         ]),
    # ----------------------------------------------------------- Quest #13
    dict(quest=13, wave=1, base="q13_w1_continue", split="You tighten your grip on your weapon",
         old_reward="Delvers gain 2 elements (your choice).", card="#11 Runoff", keep=[EL(2)], bonus=9,
         scene="A rusted pipe juts from the scorched wall, spilling black sludge into a drain. The pipe runs up through the ceiling - toward Bird's Nest.",
         options=[
             ("Seal it", "You hammer the pipe shut. The creatures nearby seem calmer already.", [FRIENDLY], []),
             ("Follow the pipe", "It ends at a sealed grate. Someone left tools behind.", [LEVEL], []),
             ("Leave it", "It isn't your mission - not today.", [EL(1)], []),
         ]),
    dict(quest=13, wave=2, base="q13_w2_continue",
         old_reward="Delvers heal up to 3 HP.", card="A Tidebloom", keep=[HEAL(3)],
         scene="Moss creeps out from under a side door, bright with the telltale signs of Tidebloom. The door opens onto a narrow storeroom.",
         options=[
             ("Enter the storeroom", "Inside, under a tarp crusted with bloom, sits an old operating system - still wired for a delversuit.", [], [PRODUCT(37)]),
             ("Collect a sample and move on", "Collecting the sample gives you a needed moment of respite.", [HEAL(1)], []),
         ]),
    dict(quest=13, wave=3, base="q13_w3_continue", split="As you reach the lowest floor",
         old_reward="Gain a Level card.", card="(quest choice)", keep=[LEVEL],
         scene="On a steel bench lie a dozen loaded syringes beside a ledger of neat handwritten notes.",
         options=[
             ("Pocket the syringes", "The liquid inside is a paralytic. It could come in handy.", [TOKEN("prevent-counterattack")], []),
             ("Read the ledger", "Dates, doses, creature numbers. Whoever wrote this has done it many times before.", [XP(2)], []),
         ]),
]

# Key Item bonus rows: (option, resolution). Shared by the game (bonus page =
# story + scene + this + rest of story) and the booklet (last row of the box).
BONUS = {
    2: ("Compare the syringe to the bloom",
        "Among the buds drifts the corroded tree's purple mist - and the residue in the strangers' syringe matches it. You follow the blight to the remains of a humanoid, half coral and half human, Tidebloom dripping from every pore and still wearing a striking piece of armor."),
    12: ("Walk with Dahlia",
         "Dahlia steps out of the mist, one slender hand held open toward you, and bows deeply. \"You. Saved me. Strong... and kind.\" Her petals dim. \"Tidekin... afraid. Kin taken,\" she says slowly. \"You... help? Come. Meet.\" Then she melts back into the mist."),
    10: ("Tell the elder about the abducted kin",
         "You tell the elder what you overheard at the festival: Tidekin taken, held near Bird's Nest. Its branch-like hand lowers, and it presses a shield of living stone and moss into your arms."),
    4: ("Compare the trail to the femur",
        "You think of the femur from the watchtower rubble. If that body was never Vera's, she's alive - and under a rock you find a stash she left behind: delver boots humming with wind, wrapped in her old cloak."),
    3: ("Follow Woo's notes",
        "Margaret Woo's diary describes this last stretch: \"a ridge of broken towers, then the light.\" Her notes mark a cache wedged beneath a fallen beam, still sealed after twenty years. Inside lies a war mace of the old world, its haft etched with the names of delvers long gone."),
    22: ("Follow Elias's signal notes",
         "Elias's distress-signal notes list the frequencies he monitored - and a relay station along this very road. Inside, still wired to a dead transmitter, sits one of his ion cells, fully charged."),
    9: ("Match the green paint chips",
        "At the hatch frame, flaking green paint catches your eye - the same shade as the chips torn from the festival generator. Whoever attacked the generator came from down here. Behind the frame sits their supply crate, and in it a gauntlet wired with prods that still spark."),
}

# Booklet-only quests (#8, #10-#12: not in the prototype yet). Same rules.
# `entry` names the continue entry (Quest #10 W3's continue part is the
# "10.8 only:" block - the booklet mislabelled it "10.9 only:", see
# storychoices_doc.py). `bonus_doc` is a Key Item bonus defined here because
# there is no game data to read it from.
DOC_MOMENTS = [
    dict(quest=8, wave=1, entry="8.2", split="Then you see them",
         old_reward="Delvers heal up to 2 HP.", card="#05 Snowpetal", keep=[HEAL(2)],
         scene="At your feet, against all odds, grows a single Snowpetal - a flower that thrives in extreme cold. They are incredibly rare and highly valued, but their fragile composition makes harvesting them a meticulous art.",
         options=[
             ("Cup the petals and detach the head", "The head of the flower wilts in your hand. Live and learn.", [XP(1)], []),
             ("Scoop out the entire flower, roots and all", "It survives the operation. You brew its petals into a warming draught.", [HEAL(2)], []),
         ],
         bonus_doc=dict(item=5, head="Recall Dr Ira's testimony",
                        story="Dr Ira told you she had made late-night comms the night of the fire. Here, at the mouth of the anomaly, a battered comm relay still hums - and wedged behind it is a supercharger core rigged to run hot against the cold. Someone has been coming here, and talking to Bird's Nest.",
                        effects=[], rewards=[PRODUCT(38)])),
    dict(quest=8, wave=2, entry="8.5", split="After several minutes, an enormous blue bird",
         old_reward="Delvers gain 2 elements (your choice).", card="#06 Lift", keep=[EL(2)],
         scene="Your path leads down jagged, frozen cliffs. Nearby you notice an old chairlift - earth machinery, here of all places. Empty chairs swing in the frigid air.",
         options=[
             ("Ask Witness for help with the generator", "Witness beeps excitedly and pulses power into the generator. As you ride down, you're struck by the stark beauty of this world.", [XP(2)], []),
             ("Scavenge parts, then find your own way down", "You find a handful of components you can repurpose.", [LEVEL], []),
         ]),
    dict(quest=8, wave=3, entry="8.8", split="You're surprised to hear a voice behind you.",
         old_reward="Delvers gain a Level card.", card="(quest choice)", keep=[LEVEL],
         scene="You circle the smooth walls, looking for any way in.",
         options=[
             ("Search the walls for a seam", "Your fingers find a hairline crack - and a faint hum of power behind it.", [AP], []),
             ("Rest in the building's shadow", "Out of the glare, you catch your breath for the first time since the bridge.", [HEAL(3)], []),
         ]),
    dict(quest=10, wave=1, entry="10.2",
         old_reward="Delvers gain 2 elements (your choice).", card="B Heirloom", keep=[EL(2)],
         scene="Xavier's voice comes through your comms. \"I was thinking about what you said, about getting revenge for my mom. There's something she used to own back when she was human - an ancient OS. It might be broken, though. Do you want to see it?\"",
         options=[
             ("Of course, lead us to it", "In an alcove you find the ancient OS. You zap it with an element and it flickers to life.", [RANK("OS", 1)], []),
             ("Sorry Xavier, we can't afford the delay", "Your unwavering commitment to your quest fills you with new vigor.", [LEVEL], []),
         ]),
    dict(quest=10, wave=2, entry="10.5", split="You enter.",
         old_reward="Delvers gain a Level card.", card="(quest choice)", keep=[LEVEL],
         scene="Spores drift lazily from the doorway. Going in will mean going through them.",
         options=[
             ("Burn a path through the spores", "The spores pop and blacken. Whatever waits inside, you'll face it with your blood up.", [TOKEN("damage-2x-universal")], []),
             ("Hold your breath and slip inside", "You move in perfect silence.", [AP], []),
         ]),
    dict(quest=10, wave=3, entry="10.8 only:",
         old_reward="Delvers gain a Level card.", card="(quest choice)", keep=[LEVEL],
         scene="You look again at Gabriel's pages before you put them away.",
         options=[
             ("Keep Gabriel's pages close", "You read them again by Witness' light. Whoever Gabriel was, you won't forget him.", [XP(2)], []),
             ("Leave a note in the safe for whoever comes next", "\"Gabriel was here. So were we.\" It feels right.", [HEAL(3)], []),
         ]),
    dict(quest=11, wave=1, entry="11.2",
         old_reward="Delvers heal up to 2 HP.", card="(quest choice)", keep=[HEAL(2)],
         scene="Witness pauses at a fork, his lights flickering as if weighing a memory.",
         options=[
             ("Let Witness lead at his own pace", "He chooses without hesitation, and the path hums with stored power.", [EL(1)], []),
             ("Tune his new circuit while he thinks", "A quick adjustment, and his lights steady - and so do you.", [AP], []),
             ("Take a short ration break", "You eat in silence while Witness hums to himself.", [HEAL(2)], []),
         ]),
    dict(quest=11, wave=2, entry="11.5",
         old_reward="Delvers gain a Level card.", card="(quest choice)", keep=[LEVEL],
         scene="At the edge of the ruins, the old outer defenses lie in pieces.",
         options=[
             ("Search the fallen defenses for salvage", "A shield plate, still sound after all these years.", [RANK("Shield", 1)], []),
             ("Read the evacuation notices", "Names, dates, orders to leave. You understand Second Nest a little better.", [XP(2)], []),
         ]),
    dict(quest=11, wave=3, entry="11.8",
         old_reward="Delvers gain 2 elements (your choice).", card="(quest choice)", keep=[EL(2)],
         scene="Before you face it, you study the great tree.",
         options=[
             ("Circle around to find its weak side", "You learn exactly where to strike.", [TOKEN("damage-2x-universal")], []),
             ("Gather fallen needles for a fire", "A small fire and a few minutes of warmth.", [HEAL(3)], []),
         ]),
    dict(quest=12, wave=1, entry="12.2",
         old_reward="Delvers gain a Level card.", card="(quest choice)", keep=[LEVEL],
         scene="Witness pulls further and further ahead.",
         options=[
             ("Keep pace with him", "You push yourselves to match him, step for step.", [AP], []),
             ("Call out for him to slow down", "He waits for you with a sheepish beep, and you catch your breath.", [HEAL(3)], []),
             ("Follow his tracks at your own pace", "Along the way you gather what the Tide has left behind.", [EL(2)], []),
         ]),
    dict(quest=12, wave=2, entry="12.5", split="An oddly shaped building lays ahead.",
         old_reward="Delvers gain 2 elements (your choice).", card="(quest choice)", keep=[EL(2)],
         scene="Steam vents hiss between the ruined towers, crusted with glittering mineral deposits.",
         options=[
             ("Rest by a steam vent", "The warmth seeps into your joints.", [HEAL(3)], []),
             ("Scrape the mineral crust from the vents", "It hums with stored power.", [EL(1)], []),
         ]),
    # Quest #14 (no retreat): both continue entries run straight into a fight,
    # so the choice is the party's reaction in the heartbeat before it.
    dict(quest=14, wave=1, entry="14.2",
         old_reward="Delvers gain a Level card.", card="(quest choice)", keep=[LEVEL],
         scene="You have a heartbeat to act.",
         options=[
             ("Dive behind the cargo crates", "Splinters fly as the puppet's first blow lands where you stood.", [HEAL(3)], []),
             ("Grab the spare cells from a weapon rack", "You slam a fresh cell into your suit as it lurches toward you.", [AP], []),
             ("Call out to the Tidekin trapped inside", "For a moment it falters, as if something inside it heard you.", [FAV("dahlia", "Dahlia", 1)], []),
         ]),
    dict(quest=14, wave=2, entry="14.4",
         old_reward="Delvers heal up to 3 HP", card="(quest choice)", keep=[HEAL(3)],
         scene="It turns toward you, and for a moment you can't move.",
         options=[
             ("Call Vera's name", "Her eyes flicker - just once - then go dark. Elias deserves to know she fought it.", [FAV("elias", "Elias Brass", 1)], []),
             ("Steel yourselves for what you must do", "You know what she would want.", [EL(2)], []),
         ]),
]

# Quest #4 Wave 1: the owner's own fix (attack / pass), already a story choice.
Q4_W1 = dict(
    attack=("Attack the creatures", "You easily cut them down as Dahlia gives you a dark look.", [EL(4)]),
    passby=("Find a way to pass without disturbing them", None, [HEAL(3)]),
)

# --------------------------------------------------------------- wording
TOKEN_NAMES = {"prevent-counterattack": "BLOCK COUNTERATTACK", "damage-2x-universal": "UNIVERSAL 2X DAMAGE"}

def effect_text(e):
    k = e["kind"]
    if k == "heal-both-delvers": return f"both delvers heal {e['amount']} HP"
    if k == "heal-both-delvers-full": return "both delvers heal to full HP"
    if k == "grant-element-choice-each":
        return f"both delvers gain {e['amount']} ELEMENT{'S' if e['amount'] > 1 else ''} of their choice"
    if k == "grant-level-up-card":
        return "gain a LEVEL UP card" if e["amount"] == 1 else f"gain {e['amount']} LEVEL UP cards"
    if k == "gain-xp": return f"gain {e['amount']} XP"
    if k == "grant-ap-one-delver": return "one delver gains 1 AP token"
    if k == "grant-friendly-spawn-card": return "add a Friendly Spawn card to the Spawn deck"
    if k == "grant-consumable-token-one-delver": return f"one delver gains 1 {TOKEN_NAMES[e['tokenKind']]} token"
    if k == "grant-equipment-rank-one-delver": return f"one delver gains +{e['amount']} RANK of {e['equipmentType'].upper()}"
    if k == "shift-favour-by-scenario": return f"increase {e['characterName']}'s opinion"
    raise ValueError(k)

def reward_text(r):
    if r["kind"] == "add-shop-products":
        n = r["products"][0]
        return f"add Shop Product #{n} {PRODUCT_NAMES[n]} to your Purchasable Products"
    if r["kind"] == "complete-quest":
        return "your Quest is complete"
    if r["kind"] == "reveal-quest-or-grant-chip":
        return f"add Quest #{r['number']:02d} “{r['name']}” to your Open Quests"
    if r["kind"] == "lieutenant-challenge":
        return "put the next Lieutenants Spawn Card on top of the Spawn Deck (it stays in the deck for the campaign)"
    if r["kind"] == "grant-boss-parts":
        lvl = f"a Level {r['level']} boss part" if r["level"] else "a boss part of the next wave's level"
        return f"each delver gains {lvl}"
    raise ValueError(r["kind"])

def merged(keep, extra):
    """extra + keep (the option's own reward reads first), folding same-kind
    heals / elements / level cards / XP together."""
    out = [dict(e) for e in extra]
    for e in keep:
        same = next((o for o in out if o["kind"] == e["kind"] and e["kind"] in
                     ("heal-both-delvers", "grant-element-choice-each", "grant-level-up-card", "gain-xp")), None)
        if same:
            same["amount"] += e["amount"]
        else:
            out.append(dict(e))
    return out

SHOWN_REWARDS = ("add-shop-products", "reveal-quest-or-grant-chip", "lieutenant-challenge", "grant-boss-parts")
LABEL_REWARDS = ("add-shop-products", "lieutenant-challenge", "grant-boss-parts")

def result_phrase(effects, rewards):
    parts = [reward_text(r) for r in rewards if r["kind"] in SHOWN_REWARDS] + [effect_text(e) for e in effects]
    return ", ".join(parts[:-1]) + (", and " if len(parts) > 1 else "") + parts[-1]

def sentence(p):
    return p[0].upper() + p[1:] + "."

LETTERS = "ABCDEFG"

def story_parts(m, base_text):
    """(before, after) story around the scenario, with the old reward removed."""
    assert m["old_reward"] in base_text, (m["base"], m["old_reward"])
    text = base_text.replace(m["old_reward"], "")
    if m.get("goal"):
        text = text.replace(m["goal"], "")
    text = "\n\n".join(p.strip() for p in text.split("\n\n") if p.strip())
    if m.get("split"):
        i = text.index(m["split"])
        before, after = text[:i].strip(), text[i:].strip()
    else:
        before, after = text, ""
    if m.get("after_extra"):
        after = (after + "\n\n" + m["after_extra"]).strip()
    return before, after

def option_list(m, lieutenant_level=None):
    """[(label, resolution, effects, rewards)] with the kept reward folded in.
    Eligible moments end with the Lieutenant challenge."""
    opts = list(m["options"])
    if lieutenant_eligible(m):
        opts.append(lieutenant_option(lieutenant_level))
    return [(label, res, merged(m["keep"], extra), list(m.get("rewards", [])) + list(rew))
            for label, res, extra, rew in opts]

def reward_lines(effects, rewards, goal=None):
    lines = [sentence(reward_text(r)) for r in rewards if r["kind"] in SHOWN_REWARDS]
    lines += [sentence(effect_text(e)) for e in effects]
    if any(r["kind"] == "complete-quest" for r in rewards):
        lines.append("Your Quest is complete!")
    if goal:
        lines.append(goal)
    return lines

def game_choices(m, pages, lieutenant_level=None):
    """Victory choices + new pages for one moment (game). Returns the list of
    continue choices; the caller keeps Retreat and the Key Item bonus."""
    before, after = story_parts(m, pages[m["base"]])
    out = []
    for i, (label, res, effects, rewards) in enumerate(option_list(m, lieutenant_level)):
        pid = f"{m['base']}_{LETTERS[i].lower()}"
        body = [before]
        if m["scene"]:
            body.append(m["scene"])
        body.append(res)
        if after:
            body.append(after)
        body.append(" ".join(reward_lines(effects, rewards, m.get("goal"))))
        pages[pid] = "\n\n".join(body)
        c = {"label": f"A - Continue: {label}: {result_phrase(effects, [r for r in rewards if r['kind'] in LABEL_REWARDS])}",
             "pageId": pid, "then": "next-wave", "carryEffects": effects}
        if rewards:
            c["rewards"] = rewards
        out.append(c)
    return out

def next_wave_boss_level(q, wave):
    """Printed level of the boss of the wave after `wave` (boss-lvl-N)."""
    import json
    from pathlib import Path
    enemies = json.loads((Path(__file__).resolve().parents[1] / "data" / "enemies.json").read_text(encoding="utf8"))
    nxt = next(w for w in q["waves"] if w["number"] == wave + 1)
    kind = next(e["kind"] for e in enemies if e["id"] == nxt["bossEnemyId"])
    assert kind.startswith("boss-lvl-"), (nxt["bossEnemyId"], kind)
    return int(kind[-1])

def apply_to_quest(q, number):
    """Rebuild every continue moment of quest `number` in quest dict `q`.
    Idempotent: options are regenerated from the base continue page."""
    for m in [m for m in MOMENTS if m["quest"] == number]:
        w = next(w for w in q["waves"] if w["number"] == m["wave"])
        vic = w["eow"]["victory"]
        retreat = [c for c in vic if c["then"] == "end-quest"]
        bonus = [c for c in vic if c.get("requireKeyItem")]
        before, after = story_parts(m, q["pages"][m["base"]])
        for b in bonus:
            # The bonus is one more way to continue at the same moment: its page
            # follows the card's scene, exactly like the booklet's last row.
            head, res = BONUS[b["requireKeyItem"]]
            effects, rewards = b.get("carryEffects", []), b.get("rewards", [])
            body = [before] + ([m["scene"]] if m["scene"] else []) + [res] + ([after] if after else [])
            body.append(" ".join(reward_lines(effects, rewards, m.get("goal"))))
            q["pages"][b["pageId"]] = "\n\n".join(body)
            b["label"] = f"A - Continue: {head}: {result_phrase(effects, rewards)}"
        level = next_wave_boss_level(q, m["wave"]) if lieutenant_eligible(m) else None
        w["eow"]["victory"] = game_choices(m, q["pages"], level) + bonus + retreat
    return q
