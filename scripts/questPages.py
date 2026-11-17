"""Town Visit pages shared by the Chapter 3 and Chapter 4 builders: the
Quest Report "play" entries for the Chapter 3-4 quests, and Quest #07's
conclusion (the Elias conversation) and Secret Town Visit.

Each chapter's JSON is separate, so page ids repeat across chapters; the
decision keys (global) are the same on purpose - Quest #07 can only be
concluded once."""

PLAYABLE = [
    # number, name, quest id, flavour line, image
    (3, "Xavier's Request", "quest3", "Xavier needs a Tidebloom sample taken from the infected creatures of the Tide. His assistant will meet you out there.", "/story/ch2/academy-xavier.png"),
    (4, "A Hand Outstretched", "quest4", "Dahlia waits at the edge of the Mistwood, petals glowing faintly, ready to lead you to her kin.", "/quests/quest-04.jpg"),
    (5, "The Rogue Delver", "quest5", "The tracks matching Vera Brass' delversuit head west, deeper into the Tide.", "/story/ch2/master-bram.png"),
    (6, "The Forgotten Vault", "quest6", "Mr. Aguilar's map is a tangle of scribbles and crosses leading into the ruins of Second Nest.", "/story/ch2/library-rodrigo.png"),
    (7, "Further Afield", "quest7", "The signal from Vera Brass' delversuit points west, to the ruins of High Nest.", "/quests/quest-07.jpg"),
    (13, "Underneath the Watchtower", "quest13", "A green hatch lies hidden beneath the burned watchtower.", "/quests/quest-13.jpg"),
]
DIAL = "q7.elias-dial"


def report_choices(prefix, choice):
    """One quest-card choice per PLAYABLE quest. Used by both the
    "Into the Tide" intro (the party must attempt at least one Quest
    before the Town Visit, so the intro has no Continue) and the Quest
    Report page the party returns to after each quest."""
    return [choice(f"Play Quest #{n:02d} - {name}", f"{prefix}.report.q{n}.play", f"{prefix}-q{n}-play",
                   image=f"/quests/quest-{n:02d}.jpg",
                   requireStoryTokens="positive", requireQuestRevealed=n, hideIfDecisionMade=f"quest.{n}.completed")
            for n, name, *_ in PLAYABLE]


def add_quest_pages(page, choice, prefix, title, report):
    """Play pages for every PLAYABLE quest + Quest #07's conclusion and
    Secret Town Visit. `report` is the chapter's Quest Report page id."""
    for n, name, qid, text, img in PLAYABLE:
        page(f"{prefix}-q{n}-play", f"QUEST #{n:02d}: {name.upper()}", "Into the Tide",
             text + " Witness hums beside you, ready to go.", image=img,
             onEnter=[{"kind": "spend-story-token"}], startQuest=qid,
             next=f"{prefix}-q7-return" if n == 7 else report)

    def adj(d):
        return {"kind": "adjust-story-counter", "key": DIAL, "delta": d}

    def fav(d):
        return {"kind": "shift-favour", "characterId": "elias", "characterName": "Elias Brass", "delta": d}

    T = "QUEST #07 CONCLUSION"
    p = f"{prefix}-q7"
    page(f"{p}-return", title, "Back from the Tide", "You make your way back to Bird's Nest.",
         choices=[choice("Read the Quest #07 Conclusion", "q7.conclusion.read", f"{p}-conclusion",
                         showIfDecision="quest.7.reached-high-nest", hideIfDecisionMade="quest.7.completed"),
                  choice("Return to the Quest Report", "q7.return.report", report, hideIfDecisionMade="quest.7.reached-high-nest")])
    page(f"{p}-conclusion", T, "Further Afield",
         "You pass through the silent, mighty ruins of High Nest, the city that fell from the sky. Your tracking signal points straight through a reinforced metal door. \"Hello? Is anyone in here? We mean no harm.\"\n\n"
         "A machine powers up and a red glow lights the room. A large robot is aiming a laser gun straight at you. \"YOU ARE NOT WELCOME HERE. YOU HAVE 10 SECONDS TO EVACUATE. TEN. NINE...\" Witness moves fearlessly towards it; several beeps and whirrs pass between them, and the robot lowers its weapon and steps away from the door.\n\n"
         "\"Damn it all! I knew I couldn't trust that bloody robot!\" A bespectacled man hides behind a desk, aiming a shaking weapon at you. \"Elias? You're Elias Brass, right?\" \"No, I'm not! Just leave and pretend you never saw me!\"\n\n"
         "\"Mr. Elias? I'm scared...\" Two children peek out from behind the desk, a girl of about 4 and a boy of around 9. You assure him you're here to help, and tell him about Margaret Woo and Baby Janus. He slowly lowers his weapon. \"So she didn't make it... Wait! Baby Janus! I left him with Margaret.\" You tell him Janus is in the care of Master Bram, and his eyes narrow. \"Can we really trust Bram, or anyone from Bird's Nest?\"\n\n"
         "You have so many questions and not a lot of time. Better make it count.",
         image="/quests/quest-07.jpg",
         footnote="One player converses with Elias. A hidden dial (starting at 0) tracks how much he opens up.",
         onEnter=[{"kind": "set-story-counter", "key": DIAL, "value": 0}],
         choices=[choice("\"I know you've been through a lot, but I need answers. What happened at the watchtower exactly?\"", "q7.talk.start.A", f"{p}-talk-1"),
                  choice("\"You need to start explaining some things. What did Vera tell you when you found her?\"", "q7.talk.start.B", f"{p}-talk-2")])
    talk = {
        1: (1, "Elias sighs deeply. \"Margaret Woo was trying to contact the delvers. She got me instead. I tried to alert Vera, but we were attacked by some monster and I couldn't do anything except run. I left my sister behind...\"",
            [("\"You're not a delver. It would've been foolish to stay. You mentioned a monster... What did it look like?\"", 4),
             ("\"Your sister was trying to save your life. She wanted you to escape. Did you see anything else?\"", 5)]),
        2: (-1, "\"She wasn't making a lot of sense. She said 20 years ago when she made it to Gaia, she was taken to another place. Eden, she called it. But she said it wasn't what was promised, and that's why she escaped.\"",
            [("\"And the children? Where did they come from? Did she take them from Eden?\"", 6),
             ("\"What was wrong with Eden? Why did Margaret want to escape?\"", 7)]),
        3: (0, "Elias takes a deep breath, relieved. \"Look, I'm not trying to be difficult. After all that's happened, my head's all scrambled. I don't know who to trust.\"",
            [("\"It's alright, I understand. Can you at least tell me about what happened at the watchtower?\"", 1),
             ("\"Listen, I'll do whatever I can to help you. I swear I only want to help.\"", 9)]),
        4: (-2, "Elias frowns slightly. \"I didn't see much through the smoke. It was huge though, with a giant clawed arm. Vera was fighting it and I swear I saw someone---\" He trails off, falling silent.",
            [("\"Saw who?! Spit it out!\"", 8),
             ("\"What else did you see? Please, anything you remember could help us.\"", 5)]),
        5: (2, "\"Someone in a lab coat. I couldn't see their face through the smoke. I think this person is the one that let that creature loose, the one who set fire to the watchtower.\" He looks around like he's suddenly afraid. \"Look, whoever killed Margaret Woo must still be looking for the children. Can you help us?\"",
            [("\"I'll help in any way we can.\"", 9),
             ("\"I wish I could, but I have other responsibilities I cannot abandon. Bird's Nest is counting on me.\"", 10)]),
        6: (-1, "Suspicion flashes across Elias's features. \"I don't know. And even if I did, I wouldn't tell you.\" He fears for the children's safety and doesn't fully trust you yet.",
            [("\"These children may have been kidnapped for all we know. Now tell me where they came from!\"", 8),
             ("\"Fine. I won't press you if you're not ready to talk about that.\"", 3)]),
        7: (1, "\"I don't know, but she referred to Eden as a prison a few times. I think that robot out there was some kind of guard that Margaret reprogrammed to protect them. Whoever was chasing us was willing to kill her to keep her silent.\" He looks around like he's suddenly afraid. \"Look, whoever killed Margaret Woo must still be looking for the children. Can you help us?\"",
            [("\"Of course. I'll help in any way we can.\"", 9),
             ("\"I wish I could, but I have other responsibilities I cannot abandon. Bird's Nest is counting on me.\"", 10)]),
        8: (0, "Elias glares at you. \"I don't know, ok?! Whatever answers you're looking for, I don't have them.\" He puts his arms around the two children. \"Right now all I care about is taking care of Oscar and Savannah. I can't protect baby Janus anymore, but I'm not letting anyone from Bird's Nest near these two.\"", []),
        9: (2, "\"Thank you.\" Elias's words come out in a long exhale. \"When I saw you were a delver, I allowed myself to hope... I hoped you'd be a friend, not a foe.\"", []),
        10: (-1, "Elias's shoulders slump. \"I understand. We'll manage... somehow.\"", []),
    }
    for n, (delta, text, opts) in talk.items():
        actions = [adj(delta)] if delta else []
        foot = None
        if n == 5:
            actions.append(fav(1))
            foot = "Increase Elias Brass's opinion and gain the Elias Ally opinion card."
        if n == 8:
            actions.append(fav(-1))
            foot = "Decrease Elias Brass's opinion and gain the Elias Detractor opinion card."
        kw = {"onEnter": actions} if actions else {}
        if foot:
            kw["footnote"] = foot
        if opts:
            kw["choices"] = [choice(label, f"q7.talk.{n}.{'AB'[i]}", f"{p}-talk-{to}") for i, (label, to) in enumerate(opts)]
        else:
            kw["next"] = f"{p}-resolution"
        page(f"{p}-talk-{n}", T, "Elias Brass", text, image="/quests/quest-07.jpg", **kw)
    page(f"{p}-resolution", T, "Resolution",
         "Your Quest is complete!",
         footnote="Add Key Item #7.",
         onEnter=[{"kind": "complete-quest", "number": 7, "name": "Further Afield"},
                  {"kind": "gain-key-item", "number": 7, "name": "You Found Elias Brass"},
                  {"kind": "if", "cond": {"kind": "story-counter-at-least", "key": DIAL, "min": 4},
                   "then": [{"kind": "record-decision", "key": "q7.elias.trusts"}]}],
         choices=[choice("Continue", "q7.resolution.trusted", f"{p}-trusted", showIfDecision="q7.elias.trusts"),
                  choice("Continue", "q7.resolution.cold", f"{p}-cold", hideIfDecisionMade="q7.elias.trusts")])
    page(f"{p}-trusted", T, "A Safe Cave",
         "\"When the coast is clear, we're gonna head into the Tide,\" Elias says, looking out into the darkness. \"On my way here, I found a cave that should be safe for us to hide in.\" He looks at Oscar and Savannah. \"I don't know how to explain it, but these children... they can repel the Tide somehow.\" You explain that baby Janus had the same ability, and he nods.\n\n"
         "He turns back to you with a steely gaze. \"You better make sure baby Janus is taken care of. Master Bram was always good to me and Vera. I'm going to choose to believe he'll do the right thing.\"",
         footnote="Continue from a Secret Town Visit.", next=f"{p}-hideout-1")
    page(f"{p}-cold", T, "Good Luck",
         "Elias gives you a cold look and starts responding to your questions with shrugs. Whatever he knows, he doesn't trust you enough to tell you.\n\n"
         "When you tell him you need to head out, he nods curtly. \"Good luck. We'll wait til the coast is clear and then head into the Tide. I ran across a cave that should be safe for us to hide in. Go, we'll be fine. That robot will protect us.\" You bid them good luck and depart.",
         next=report)

    S = "SECRET TOWN VISIT - IN THE RUINS OF HIGH NEST"
    page(f"{p}-hideout-1", S, "Elias' Secret Hideout: Part 1",
         "The ruins of High Nest - First Nest, they called it once - are an endless mess of broken stone and twisted beams, covered with moss, grass and flowers. Elias has set up camp in what was once a grocery store. Savannah hums a nursery rhyme while Oscar runs around with a toy airplane, going \"BRUMMMMMMMM\".\n\n"
         "\"I'm famished, aren't you? Could you help me gather supplies for dinner?\" You nod and scour the shelves.",
         choices=[choice("A bag of dried lentils, half full but sealed", "q7.hideout.A", f"{p}-hideout-1a", hint="???"),
                  choice("A tin of mystery stew with a rust-spotted lid", "q7.hideout.B", f"{p}-hideout-1b", hint="???"),
                  choice("A box of powdered milk, damp around the corners", "q7.hideout.C", f"{p}-hideout-1c", hint="???")])
    page(f"{p}-hideout-1a", S, "Lentils",
         "After simmering, the lentils soften into a rich, filling base. You top it off with scavenged seaweed and Tidegazer meat. It's the best meal you've had in days - warm, nourishing, and most of all, safe.",
         footnote="Each player gains +1 Rank of an Equipment Slot of their choice.",
         onEnter=[{"kind": "enqueue-suit-condition-rank-picks", "source": "q7.hideout.A",
                   "picks": [{"delta": 1, "pinnedHeroId": "hero-01"}, {"delta": 1, "pinnedHeroId": "hero-02"}]}],
         next=f"{p}-hideout-2")
    page(f"{p}-hideout-1b", S, "Mystery Stew",
         "The mystery stew is edible but bland. It fills your bellies, but no one is excited for seconds.",
         footnote="Choose a player to gain +1 Rank of an Equipment Slot of their choice.",
         onEnter=[{"kind": "enqueue-suit-condition-rank-picks", "source": "q7.hideout.B", "picks": [{"delta": 1}]}],
         next=f"{p}-hideout-2")
    page(f"{p}-hideout-1c", S, "Powdered Milk",
         "Within an hour, stomachs cramp and nausea spreads through the group. The milk had long since spoiled. Only after 48 hours of suffering do you begin to feel human again.",
         footnote="Both delvers lose 3 minion parts.",
         onEnter=[{"kind": "lose-minion-parts", "amount": 3, "to": "all-delvers"}],
         next=f"{p}-hideout-2")
    page(f"{p}-hideout-2", S, "Elias' Secret Hideout: Part 2",
         "After spending some quality time with Elias and the toddlers, he begins to loosen up. You wait until the kids are napping, crack open a couple of bottles of water, and ask him the question that's been on your mind.",
         choices=[choice("Press for more information about the children", "q7.hideout2.A", f"{p}-hideout-2a", hint="Grants Knowledge"),
                  choice("Press for more information about why Elias is so adamant on becoming Janus' guardian", "q7.hideout2.B", f"{p}-hideout-2b", hint="Grants Knowledge")])
    story = ("\"Alright, I'll tell you. I used to spend most of my free time at my post at the watchtower. One day, I received a radio transmission from Margaret Woo - the famous delver that reached Gaia 20 years ago and disappeared. She claimed she was on the run with some kids, that she'd been abducted all this time but found a way to escape, some wild accusations about Father Flores - then the transmission cut out. I told people about it, but no one believed me. Except for my sister Vera.\n\n"
             "So I went to find Margaret Woo. And I did find her, but I must have been followed, because Father Flores was hot on my trail. Margaret said he was a Warden. I don't know what she meant by that, but she asked me to take the kids while she dealt with Flores. And again, like the coward I am, I let her die while I ran away. I even left a kid behind in my rush for the exit. And that's why we're here.\"\n\n")
    page(f"{p}-hideout-2a", S, "Where She Crossed Over",
         story + "\"As for your question, I don't know where the children came from exactly, but Woo showed me where she crossed over - she said we should meet there if she survived.\"",
         footnote="Add Quest #08 \"The Bridge\" (a Memory Chip if already owned or completed). Add Key Item #13.",
         onEnter=[{"kind": "reveal-quest-or-grant-chip", "number": 8, "name": "The Bridge", "chipFallback": 1},
                  {"kind": "gain-key-item", "number": 13, "name": "Many Revelations"}],
         next=f"{p}-scavenge")
    page(f"{p}-hideout-2b", S, "Not Human",
         story + "\"As for your question, if Father Flores realizes Janus is at Bird's Nest, he'll kill him. For a brief moment I saw Flores' true face as he was slaughtering Margaret. Whatever he is, he's not human.\"",
         footnote="Add Quest #09 \"Sins of the Father\" (a Memory Chip if already owned or completed). Add Key Item #13.",
         onEnter=[{"kind": "reveal-quest-or-grant-chip", "number": 9, "name": "Sins of the Father", "chipFallback": 1},
                  {"kind": "gain-key-item", "number": 13, "name": "Many Revelations"}],
         next=f"{p}-scavenge")
    page(f"{p}-scavenge", S, "Elias' Scavenge Shop",
         "Shop Products #32-45 that nobody owns and that aren't already in your Purchasable Products are for sale during this Secret Town Visit only. There is only one of each product. You may convert a Boss part into minion parts at 3 minion parts per level of the Boss part.",
         postRewardsText="When everyone is done shopping, click Continue. Unbought scavenge products go back to the box.",
         onEnter=[{"kind": "open-scavenge-shop", "products": list(range(32, 46))}],
         kind="shop", next=f"{p}-scavenge-close")
    page(f"{p}-scavenge-close", S, "End of Secret Town Visit",
         "You bid Elias, Oscar and Savannah farewell. When you're ready, choose any Open Quest to attempt.",
         footnote="This Town Visit isn't marked on your Campaign Sheet.",
         onEnter=[{"kind": "close-scavenge-shop"}], next=report)
