# Tighter base prose for the three resolution pages that overflowed.
# Imported by booklet34.py before the Key Item bonuses are added.
# Each entry takes the prototype's (game's) tighter wording.
import re

def curly(t):
    t = re.sub(r"(\w)'", "\\1\u2019", t).replace("'", "\u2019")
    out, opening = [], True
    for ch in t:
        if ch == '"':
            out.append('\u201c' if opening else '\u201d')
            opening = not opening
        else:
            out.append(ch)
    return ''.join(out).replace('...', '\u2026')

PROSE = {
    '3.2': [
        "You hear Xavier's voice through your comms. \"You're approaching the location now, just over this ridge. My assistant will help you collect the sample. She is... altered. But don't let that alarm you.\"",
        "You crest the ridge. Below, the land is overtaken by a dense growth of roiling ivy - and in one section, purple vines with bright orange flowers. \"What do you mean Dahlia isn't there?\" Xavier says, panic rising in his voice.",
        "The darker vines are taut, packed as if to contain something - and you realize they are not vines but tentacles. At their center a humanoid creature is trapped, a bright crimson bloom sprouting where her nose and eyes should be. She lies motionless, but her chest rises and falls. You fire your beam at the creature's glassy, gray eye, and the mass comes alive, tentacles thrashing furiously.",
    ],
    '4.5': [
        "The Mistwood grows denser, taller trees obscuring the light of the sun. Dahlia's petals glow ever brighter in the dimness. Ahead, the Tide has transformed the vegetation, warping the trees so their branches swirl and bend in all directions - nature through the lens of someone's dream.",
        "Then, movement. Figures melt out of the trees into the clearing. Tidekin, dozens of them. Some bear petals like Dahlia; others sport gemlike protrusions that make the earth quake as they step toward you. Dahlia steps forward and they all turn towards her without a word, communicating silently.",
        "The oldest-looking Tidekin, with branch-like hands, points at you. Dahlia shakes her head. \"Afraid,\" she says with sadness. \"Blame humans for trouble.\"",
        "Suddenly several Tidekin make a strange, guttural noise. From behind you, a hulking form emerges. It looks like a Tidekin, but it bears one giant claw and serrated teeth in its gnashing mouth. The Tidekin have already disappeared into the woods. You're left alone to deal with the creature.",
    ],
    '5.2': [
        "The tracks wind west through the mist, streaked with fresh blood - proof you're close. Whatever left them is hurt... and dangerous. A few steps ahead you stumble across a journal. Could Vera Brass have dropped this, or left it purposely? You rifle through the pages, finding many mundane musings from the days before the fire at the watchtower.",
        "The last entry is scrawled in black charcoal. \"I don't care if you're a friend wanting to help or a foe coming to take me back. I won't go. There is something rotten in Bird's Nest. Trust no one. Do not pursue.\" You press on, following the trail into the unknown.",
    ],
}
