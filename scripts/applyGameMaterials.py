"""Copy prototype card crops (from extractGameMaterials.py) into public/
under the filenames the game catalogs already reference.

Per the design team's direction: Chapter 1-2 cards keep their graphic-design
art; Chapter 3-4 cards use the prototype materials until final art exists.
So this only writes the Chapter 3-4 cards listed below, plus opinion cards
for character/level pairs that have no art yet.

Usage:
  python -I scripts/applyGameMaterials.py <crops dir> <G2G root> <fixed quest PDF crops dir>
Prints every file written and fails loudly if an expected card is missing.
"""
import json
import re
import sys
from pathlib import Path

from PIL import Image

CROPS = Path(sys.argv[1])
ROOT = Path(sys.argv[2])
# Crops of "Quest Cards - Nov 15 fixed.pdf" (extractGameMaterials output):
# the fixed Quest #6 "The Forgotten Vault" and #13 "hidden lab" fronts.
QUEST_CROPS = Path(sys.argv[3])
INDEX = json.loads((CROPS / "index.json").read_text(encoding="utf8"))
QUEST_INDEX = json.loads((QUEST_CROPS / "index.json").read_text(encoding="utf8"))


def undouble(text):
    """Token-wise: 'KKEEYY' -> 'KEY', '##1111' -> '#11'; normal words stay."""
    out = []
    for w in text.split():
        if len(w) >= 2 and len(w) % 2 == 0 and all(w[i] == w[i + 1] for i in range(0, len(w), 2)):
            out.append(w[::2])
        else:
            out.append(w)
    return " ".join(out)


def norm(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def squash(s):
    return re.sub(r"(.)\1+", r"\1", norm(s))


def cards(page):
    return [c for c in INDEX if c["page"] == page]


def save(card, dest, size=None):
    img = Image.open(CROPS / card["file"]).convert("RGB")
    if size:
        img = img.resize(size, Image.LANCZOS)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.suffix == ".png":
        img.save(dest)
    else:
        img.save(dest, quality=92)
    print("wrote", dest.relative_to(ROOT), "<-", card["file"])


def main():
    written = 0

    # --- Key items #7-#24 (fronts on page 13), matched by printed title.
    titles = {
        7: "You Found Elias Brass", 8: "Melted Vial", 9: "Green Paint Chips", 10: "Abducted Tidekin",
        11: "Baby Janus", 12: "Dahlia is Free", 13: "Many Revelations", 14: "Corpse of Ruined Tidekin",
        15: "A Strange New World", 16: "A Warden Unmasked", 17: "Gabriel's Diary", 18: "The Tablet",
        19: "Signal Received", 20: "The Secret Lab is Gone", 21: "Bioluminescence",
        23: "You saved Dr Ira", 24: "You didn't save Dr Ira",
    }
    by_title = {norm(undouble(c["text"]).split(" | ")[0]): c for c in cards(13)}
    for n, title in titles.items():
        card = by_title.get(norm(title))
        if not card:
            raise SystemExit(f"key item #{n} '{title}' not found on page 13")
        save(card, ROOT / "public" / "key-items" / f"key-item-{n:02d}.jpg")
        written += 1

    # --- Shop products (fronts on pages 13/15/17), matched by "Shop Product #N".
    wanted_shop = {15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 33, 35, 36, 37, 38, 39, 40, 42, 43, 44, 45, 46, 47}
    found_shop = {}
    for page in (13, 15, 17):
        for c in cards(page):
            m = re.search(r"Shop ?Product #(\d+)", undouble(c["text"]))
            if m and int(m.group(1)) in wanted_shop:
                found_shop[int(m.group(1))] = c
    missing = wanted_shop - set(found_shop)
    if missing:
        raise SystemExit(f"shop products not found: {sorted(missing)}")
    for n, c in sorted(found_shop.items()):
        save(c, ROOT / "public" / "shop-products" / f"shop-product-{n:02d}.jpg")
        written += 1

    # --- Heroes #7-#10 (page 39 fronts run #3..#13 in reading order).
    heroes = cards(39)
    for n in (7, 8, 9, 10):
        save(heroes[n - 3], ROOT / "public" / "heroes" / f"hero-{n:02d}.jpg")
        written += 1

    # --- Quests #4, #6, #7, #13 (page 1 fronts of the fixed quest PDF).
    # #6 is a Ch2 quest but its title/location changed, so it uses the prototype card too.
    wanted = {4, 6, 7, 8, 9, 13}
    for c in (q for q in QUEST_INDEX if q["page"] == 1):
        m = re.match(r"Quest #(\d+)", undouble(c["text"]))
        if m and int(m.group(1)) in wanted:
            img = Image.open(QUEST_CROPS / c["file"]).convert("RGB")
            img.save(ROOT / "public" / "quests" / f"quest-{int(m.group(1)):02d}.jpg", quality=92)
            wanted.discard(int(m.group(1)))
            written += 1
    if wanted:
        raise SystemExit(f"quest fronts missing from fixed quest PDF: {sorted(wanted)}")

    # --- Boss card backs for Ch3 bosses (pages 32/34/36 hold the backs; the
    # first text segment is the art id). Keyed to public/boss-card-backs.
    # Hundredeyes (Ch2) uses the PDF back too: its suit line changed to Left Arm.
    backs = {"snakebossA": "hundredeyes", "snakebossB": "gerald", "snakebossD": "carnatia", "treebossA": "empressash",
             "golembossA": "golem", "treebossD": "abomination", "apebossA": "timberfiend",
             "snakebossG": "mindslayer", "whalebossA-L": "oblivionwing",
             # Chapter 4 quests (#4, #7, #13)
             "snakebossH": "arnold", "mushroombossC": "ruinedtidekin", "snakebossC": "anna", "treebossB": "winona",
             "snakebossE": "laura", "treebossE": "george", "revenantbossB": "revenant"}
    for art_id, name in backs.items():
        hits = [c for c in INDEX if c["page"] in (32, 34, 36) and undouble(c["text"]).split(" | ")[0].strip() == art_id]
        if len(hits) != 1:
            raise SystemExit(f"boss card back {art_id}: matched {[c['file'] for c in hits]}")
        save(hits[0], ROOT / "public" / "boss-card-backs" / f"{name}-back.png")
        written += 1

    # --- Scenario cards #10-#17, C, D: fronts by position, backs by "Scenario X Answer".
    fronts = {"s10": cards(51)[11]}
    for i, key in enumerate(["s11", "s12", "s13", "s14", "s15", "s16", "s17", "c", "d"]):
        fronts[key] = cards(53)[i]
    for key, c in fronts.items():
        save(c, ROOT / "public" / "scenario-cards" / f"scenario_front_{key}.jpg")
        written += 1
    backs = {}
    for page in (52, 54):
        for c in cards(page):
            m = re.match(r"Scenario (\w+) ?Answer", undouble(c["text"]).replace(" ", "").replace("Scenario", "Scenario "))
            if m:
                backs[m.group(1)] = c
    for label, key in [("10", "s10"), ("11", "s11"), ("12", "s12"), ("13", "s13"), ("14", "s14"),
                       ("15", "s15"), ("16", "s16"), ("17", "s17"), ("C", "c"), ("D", "d")]:
        if label not in backs:
            raise SystemExit(f"scenario back {label} not found")
        save(backs[label], ROOT / "public" / "scenario-cards" / f"scenario_back_{key}.jpg")
        written += 1

    # --- Opinion cards with no art yet (pages 17 + 19 fronts).
    ids = {"xavier": "xavier", "arlen": "arlen", "flores": "flores", "ira": "ira", "elayna": "elayne",
           "rodrigo": "rodrigo", "samantha": "samantha", "dahlia": "dahlia", "elias": "elias", "vera": "vera"}
    levels = {"nemesis", "detractor", "ally", "confidant"}
    # Ch1/2 opinion cards whose printed effect changed in the Nov 15 PDF:
    # Elayna Ally is now Med Kit, Samantha Ally is now Popular (the old
    # Vera shield), Vera Ally is now Gift (Lvl 2 boss part).
    CHANGED_OPINIONS = {("elayne", "ally"), ("samantha", "ally"), ("vera", "ally")}
    new_opinions = []
    for page in (17, 19):
        for c in cards(page):
            parts = [p.strip() for p in undouble(c["text"]).split(" | ")]
            if len(parts) < 2:
                continue
            # Collapse repeated letters on both sides: the PDF half-doubles
            # some names ("Arrlleenn", "Allllyy").
            who, level = squash(parts[0]), squash(parts[1])
            ids_sq = {squash(k): v for k, v in ids.items()}
            levels_sq = {squash(lv): lv for lv in levels}
            if who in ids_sq and level in levels_sq:
                cid = ids_sq[who]
                level = levels_sq[level]
                dest = ROOT / "public" / "opinion-cards" / f"opinion-{cid}-{level}.png"
                # Chapter 1-2 graphic-design art stays, except for cards whose
                # effect changed in the Nov 15 materials (see CHANGED_OPINIONS).
                if dest.exists() and (cid, level) not in CHANGED_OPINIONS:
                    continue
                save(c, dest)
                new_opinions.append((cid, parts[0], level))
                written += 1
    (CROPS / "new_opinions.json").write_text(json.dumps(new_opinions), encoding="utf8")
    print(f"{written} files written; {len(new_opinions)} new opinion cards")


if __name__ == "__main__":
    main()
