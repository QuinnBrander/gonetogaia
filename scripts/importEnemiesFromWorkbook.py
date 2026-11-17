"""Import enemy cards from the "Gone to Gaia - Game Materials" workbook
into data/enemies.json, and copy their card art from the prototype
materials PDF crops (made by scripts/extractGameMaterials.py).

The workbook's Enemy Minion Front / Enemy Boss Lieutenant Front sheets
carry HP, Damage, parting shots, on-death effects and the counterattack
arrows (Blue = common / roll 2-5, Red = uncommon / roll 6; offsets are
1..3 tiles out in each of 8 directions, y grows southwards). Abilities
are authored by hand in SPEC below because the printed text needs
structured parameters the engine understands.

Card art: each SPEC entry names its PDF crop either as card=(page, index),
i.e. pNN_MM.png in the extractGameMaterials output, or as art="oriteA1", the
art id printed on the card (looked up in index.json; must be unique). Pick
the card by its printed display name + stats, not by the art id alone
(e.g. Fleetfoot prints "houndA1", Nightswiper prints "tidegazerB1").

abilities="auto" parses the workbook's Abilities cell (see AUTO_ABILITIES).
"Hard" variants in the PDF are not supported by the game and not imported.

Usage:
  python -I scripts/importEnemiesFromWorkbook.py <G2G root> <workbook.xlsx> <materials outdir> [id prefix]
Re-running replaces the entries listed in SPEC (matched by id). The optional
id prefix limits the run to matching SPEC ids (e.g. "lieutenant-").
"""
import json
import re
import sys
from pathlib import Path

from openpyxl import load_workbook
from PIL import Image

ROOT = Path(sys.argv[1])
WORKBOOK = sys.argv[2]
MATERIALS = Path(sys.argv[3])
CARD_SIZE = 681  # matches the other enemy card JPGs in public/cards

# id, workbook sheet, OLDNAME, row index within that OLDNAME (0-based),
# kind, display name/family, cardNumber, abilities
SPEC = [
    dict(id="joyce-029", sheet="Enemy Boss Lieutenant Front", old="JOYCE THE BEAR", row=0,
         kind="boss-lvl-1", name="Joyce the Bear", cardNumber=29, card=(31, 19),
         abilities=[{"kind": "strength"}, {"kind": "fatal-flaw", "level": 3}]),
    dict(id="gerald-030", sheet="Enemy Boss Lieutenant Front", old="GERALD THE SNAKE", row=0,
         kind="boss-lvl-2", name="Gerald the Snake", cardNumber=30, card=(33, 1),
         abilities=[{"kind": "stout", "maxDamage": 8}, {"kind": "rotates"}]),
    # Quest #03 "Xavier's Request" (Chapter 3)
    dict(id="cerberus-031", sheet="Enemy Boss Lieutenant Front", old="TIDAL CERBERUS", row=0,
         kind="boss-lvl-1", name="Tidal Cerberus", cardNumber=31, card=(31, 11), abilities=[{"kind": "flees"}]),
    *[dict(id=f"fleetfoot-{32 + i:03d}", sheet="Enemy Minion Front", old="Fleetfoot", row=i,
           kind="minion", name="Fleetfoot", cardNumber=32 + i, card=(21, 14 + i), abilities=[{"kind": "flees"}]) for i in range(7)],
    dict(id="carnatia-039", sheet="Enemy Boss Lieutenant Front", old="CARNATIA", row=0,
         kind="boss-lvl-2", name="Carnatia", cardNumber=39, card=(33, 3),
         abilities=[{"kind": "soothsayer"}, {"kind": "synchronized"}]),
    *[dict(id=f"colibrius-{40 + i:03d}", sheet="Enemy Minion Front", old="Colibrius", row=i,
           kind="minion", name="Colibrius", cardNumber=40 + i, card=(25, 1 + i), abilities=[{"kind": "synchronized"}]) for i in range(7)],
    dict(id="empressash-047", sheet="Enemy Boss Lieutenant Front", old="EMPRESS ASH", row=0,
         kind="boss-lvl-3", name="Empress Ash", cardNumber=47, card=(35, 1),
         abilities=[{"kind": "all-claw"}, {"kind": "death-heal"}]),
    *[dict(id=f"tidegazer-{48 + i:03d}", sheet="Enemy Minion Front", old="Tidegazer", row=i,
           kind="minion", name="Tidegazer", cardNumber=48 + i, card=(27, 12 + i), abilities=[{"kind": "death-heal"}]) for i in range(7)],
    # Quest #03 Wave 4 + Quest #06 Wave 4: Golem + Orites (Accurate, Guards)
    dict(id="golem-055", sheet="Enemy Boss Lieutenant Front", old="GOLEM", row=0,
         kind="boss-lvl-4", name="Golem", cardNumber=55, art="golembossA", abilities="auto"),
    *[dict(id=f"orite-{56 + i:03d}", sheet="Enemy Minion Front", old="Orite", row=i,
           kind="minion", name="Orite", cardNumber=56 + i, art=f"oriteA{i + 1}", abilities="auto") for i in range(7)],
    # Quest #06 Wave 3: Abomination + Blackguards (Immunity)
    dict(id="abomination-063", sheet="Enemy Boss Lieutenant Front", old="ABOMINATION", row=0,
         kind="boss-lvl-3", name="Abomination", cardNumber=63, art="treebossD", abilities="auto"),
    *[dict(id=f"blackguard-{64 + i:03d}", sheet="Enemy Minion Front", old="Blackguard", row=i,
           kind="minion", name="Blackguard", cardNumber=64 + i, art=f"sporecloudB{i + 1}", abilities="auto") for i in range(7)],
    # The Gaia wave (book page 206): Timber Fiend + Saplings (Countdown, Tough)
    dict(id="timberfiend-071", sheet="Enemy Boss Lieutenant Front", old="TIMBERFIEND", row=0,
         kind="boss-lvl-5", name="Timber Fiend", cardNumber=71, art="apebossA", abilities="auto"),
    *[dict(id=f"sapling-{72 + i:03d}", sheet="Enemy Minion Front", old="Sapling", row=i,
           kind="minion", name="Sapling", cardNumber=72 + i, art=f"experimentA{i + 1}", abilities="auto") for i in range(7)],
    # Quest #05 "The Rogue Delver"
    dict(id="bob-079", sheet="Enemy Boss Lieutenant Front", old="BOB THE SPIDER", row=0,
         kind="boss-lvl-1", name="Bob the Spider", cardNumber=79, art="spiderbossB", abilities="auto"),
    *[dict(id=f"diamonid-{80 + i:03d}", sheet="Enemy Minion Front", old="Diamonid", row=i,
           kind="minion", name="Diamonid", cardNumber=80 + i, art=f"crystanidB{i + 1}", abilities="auto") for i in range(7)],
    dict(id="mindslayer-087", sheet="Enemy Boss Lieutenant Front", old="MINDSLAYER", row=0,
         kind="boss-lvl-2", name="Mindslayer", cardNumber=87, art="snakebossG", abilities="auto"),
    *[dict(id=f"squiddy-{88 + i:03d}", sheet="Enemy Minion Front", old="Squiddy", row=i,
           kind="minion", name="Squiddy", cardNumber=88 + i, art=f"squiddyA{i + 1}", abilities="auto") for i in range(7)],
    dict(id="oblivionwing-095", sheet="Enemy Boss Lieutenant Front", old="OBLIVIONWING 1/2", row=0,
         kind="boss-lvl-3", name="Oblivionwing", cardNumber=95, art="whalebossA-L", abilities="auto"),
    # 2-card boss: the 2/2 card prints only arrows. It is placed east of
    # the 1/2 card, shares its HP and is removed with it (`partOf`).
    dict(id="oblivionwing-096", sheet="Enemy Boss Lieutenant Front", old="OBLIVIONWING 2/2", row=0,
         kind="boss-lvl-3", name="Oblivionwing", cardNumber=96, art="whalebossA-R", abilities=[],
         part_of="oblivionwing-095"),
    *[dict(id=f"nightswiper-{97 + i:03d}", sheet="Enemy Minion Front", old="Nightswiper", row=i,
           kind="minion", name="Nightswiper", cardNumber=97 + i, art=f"tidegazerB{i + 1}", abilities="auto") for i in range(7)],
    # Chapter 4 story quest "Assault on Bird's Nest" (Town Square)
    dict(id="mistspawn-104", sheet="Enemy Boss Lieutenant Front", old="MISTSPAWN", row=0,
         kind="boss-lvl-2", name="Mistspawn", cardNumber=104, art="snakebossL", abilities="auto"),
    *[dict(id=f"infestation-{105 + i:03d}", sheet="Enemy Minion Front", old="Infestation", row=i,
           kind="minion", name="Infestation", cardNumber=105 + i, art=f"ophidianB{i + 1}", abilities="auto") for i in range(7)],
    # Quest #04 "A Hand Outstretched"
    dict(id="hugh-112", sheet="Enemy Boss Lieutenant Front", old="HUGH THE MOTH", row=0,
         kind="boss-lvl-1", name="Hugh the Moth", cardNumber=112, art="spiderbossD", abilities="auto"),
    *[dict(id=f"emberwing-{113 + i:03d}", sheet="Enemy Minion Front", old="Emberwing", row=i,
           kind="minion", name="Emberwing", cardNumber=113 + i, art=f"emberwingB{i + 1}", abilities="auto") for i in range(7)],
    dict(id="arnold-120", sheet="Enemy Boss Lieutenant Front", old="ARNOLD THE OCTOPUS", row=0,
         kind="boss-lvl-2", name="Arnold the Octopus", cardNumber=120, art="snakebossH", abilities="auto"),
    dict(id="ruinedtidekin-121", sheet="Enemy Boss Lieutenant Front", old="RUINED TIDEKIN", row=0,
         kind="boss-lvl-3", name="Ruined Tidekin", cardNumber=121, art="mushroombossC", abilities="auto"),
    *[dict(id=f"exanimate-{122 + i:03d}", sheet="Enemy Minion Front", old="Exanimate", row=i,
           kind="minion", name="Exanimate", cardNumber=122 + i, art=f"tidegazerC{i + 1}", abilities="auto") for i in range(7)],
    # Quest #07 "Further Afield"
    dict(id="spike-129", sheet="Enemy Boss Lieutenant Front", old="SPIKE THE MOTH", row=0,
         kind="boss-lvl-1", name="Spike the Moth", cardNumber=129, art="spiderbossE", abilities="auto"),
    dict(id="anna-130", sheet="Enemy Boss Lieutenant Front", old="ANNA THE SNAKE", row=0,
         kind="boss-lvl-2", name="Anna the Snake", cardNumber=130, art="snakebossC", abilities="auto"),
    dict(id="winona-131", sheet="Enemy Boss Lieutenant Front", old="WINONA THE OAK", row=0,
         kind="boss-lvl-3", name="Winona the Oak", cardNumber=131, art="treebossB", abilities="auto"),
    # Quest #13 "Underneath the Watchtower"
    dict(id="billy-132", sheet="Enemy Boss Lieutenant Front", old="BILLY THE BEAR", row=0,
         kind="boss-lvl-1", name="Billy the Bear", cardNumber=132, art="bearbossC", abilities="auto"),
    dict(id="laura-133", sheet="Enemy Boss Lieutenant Front", old="LAURA THE FLYTRAP", row=0,
         kind="boss-lvl-2", name="Laura the Flytrap", cardNumber=133, art="snakebossE", abilities="auto"),
    dict(id="george-134", sheet="Enemy Boss Lieutenant Front", old="GEORGE THE APE", row=0,
         kind="boss-lvl-3", name="George the Ape", cardNumber=134, art="treebossE", abilities="auto"),
    dict(id="revenant-135", sheet="Enemy Boss Lieutenant Front", old="INCOMPLETE REVENANT", row=0,
         kind="boss-lvl-4", name="Incomplete Revenant", cardNumber=135, art="revenantbossB", abilities="auto"),
    *[dict(id=f"experiment-{136 + i:03d}", sheet="Enemy Minion Front", old="Experiment", row=i,
           kind="minion", name="Experiment", cardNumber=136 + i, art=f"oriteB{i + 1}", abilities="auto") for i in range(7)],
    # Lieutenants (2026-11-17): placed by the Lieutenants Spawn Cards #19-24
    # at the wave's level. Two printed cards per level (A = "to nearest
    # delver" parting shot + XP, B = all-delvers shot + 3 elements); Lvl 5
    # has one card. Ids are lieutenant-l<level><a|b>.
    *[dict(id=f"lieutenant-l{lvl}{ab}", sheet="Enemy Boss Lieutenant Front", old=f"Lieutenant - Lvl {lvl}", row=r,
           kind="lieutenant", name=f"Lieutenant - Lvl {lvl}", cardNumber=143 + 2 * (lvl - 1) + r, card=card,
           abilities=[{"kind": "aggressive"}])
      for lvl, ab, r, card in [(1, "a", 0, (31, 22)), (1, "b", 1, (31, 23)), (2, "a", 0, (33, 13)), (2, "b", 1, (33, 14)),
                               (3, "a", 0, (35, 6)), (3, "b", 1, (35, 7)), (4, "a", 0, (35, 13)), (4, "b", 1, (35, 14)),
                               (5, "a", 0, (35, 16))]],
]


def auto_abilities(text):
    """Structured abilities from the workbook's printed Abilities cell."""
    out = []
    for part in [t.strip() for t in (text or "").split(",") if t.strip()]:
        low = part.lower()
        m = re.fullmatch(r"(light|medium|heavy) immune", low)
        g = re.fullmatch(r"guards: (\d+)", low)
        ff = re.fullmatch(r"fatal flaw: (\d+)", low)
        if m:
            out.append({"kind": "immunity", "damageType": m.group(1)})
        elif g:
            out.append({"kind": "guards", "tokens": int(g.group(1))})
        elif ff:
            out.append({"kind": "fatal-flaw", "level": int(ff.group(1))})
        elif low in ("accurate", "countdown", "tough", "vicious", "alert", "critical", "frenzy", "omen", "rebirth",
                     "backup", "evasive", "hardy", "steals", "spiked", "soothsayer", "invulnerable", "rotates",
                     "ritual", "brawler", "corruption", "shell", "synchronized"):
            out.append({"kind": low})
        elif low in ("last act", "death heal", "double edged", "soul sap"):
            out.append({"kind": low.replace(" ", "-")})
        else:
            raise ValueError(f"unhandled ability {part!r}")
    return out


def find_art(art_id):
    index = json.loads((MATERIALS / "index.json").read_text(encoding="utf8"))
    # Enemy fronts are on the odd pages 21-35; even pages hold the "Hard"
    # variants and the boss card backs, which repeat the art id.
    hits = [c["file"] for c in index
            if 21 <= c["page"] <= 35 and c["page"] % 2 == 1 and c["text"].split("|")[0].strip() == art_id]
    if len(hits) != 1:
        raise SystemExit(f"art id {art_id!r} matched {hits}")
    return MATERIALS / hits[0]

DIRS = {
    "North": (0, -1), "Northeast": (1, -1), "East": (1, 0), "Southeast": (1, 1),
    "South": (0, 1), "Southwest": (-1, 1), "West": (-1, 0), "Northwest": (-1, -1),
}
ELEMENT_WORDS = ["earth", "wind", "fire", "water", "void", "radiance"]


def parse_arrows(d):
    common, uncommon = [], []
    for name, (dx, dy) in DIRS.items():
        for step in (1, 2, 3):
            v = d.get(f"{name}{step}")
            if not v:
                continue
            off = {"dx": dx * step, "dy": dy * step}
            if "Blue" in v:
                common.append(off)
            elif "Red" in v:
                uncommon.append(off)
            else:
                raise ValueError(f"unknown arrow {v}")
    key = lambda o: (o["dy"], o["dx"])
    return sorted(common, key=key), sorted(uncommon, key=key)


def parse_parting(t1, t2):
    t1 = (t1 or "").strip().lower()
    t2 = (t2 or "").strip().lower()
    m = re.fullmatch(r"(\d+) damage", t1)
    if m and not t2:
        return {"kind": "all-delvers", "damage": int(m.group(1))}, f"{m.group(1)} Damage."
    if m and t2 == "lose all xp on-hand":
        return ({"kind": "all-delvers-damage-and-lose-xp", "damage": int(m.group(1)), "amount": "all"},
                f"{m.group(1)} Damage & lose ALL XP on hand.")
    if m and t2 == "lose all elements":
        return ({"kind": "all-delvers-damage-and-lose-elements", "damage": int(m.group(1)), "amount": "all"},
                f"{m.group(1)} Damage & lose ALL Elements.")
    if m and t2 == "discard 1 consumable":
        return ({"kind": "all-delvers-damage-and-discard-consumable", "damage": int(m.group(1)), "count": 1},
                f"{m.group(1)} Damage & Discard 1 Consumable.")
    m2 = re.fullmatch(r"lose (\d+) xp on-hand", t1)
    if m2 and not t2:
        return {"kind": "all-delvers-lose-xp", "amount": int(m2.group(1))}, f"Lose {m2.group(1)} XP on hand."
    if t1 == "lose all elements" and not t2:
        return {"kind": "all-delvers-lose-elements", "amount": "all"}, "Lose ALL Elements."
    if t1 == "delvers lose all elements" and not t2:
        return {"kind": "all-delvers-lose-elements", "amount": "all"}, "Delvers lose ALL Elements."
    m = re.fullmatch(r"(\d+) damage to nearest delver", t1)
    if m:
        return {"kind": "nearest-delver", "damage": int(m.group(1))}, f"{m.group(1)} Damage to nearest Delver."
    m = re.fullmatch(r"(\d+) damage (?:if|to delvers) within (\d+) tiles", t1)
    if m:
        return ({"kind": "delvers-within", "damage": int(m.group(1)), "range": int(m.group(2))},
                f"{m.group(1)} Damage to any Delver within {m.group(2)} tiles.")
    raise ValueError(f"unhandled parting shot: {t1!r} / {t2!r}")


def parse_death(e1, e2):
    out = {"drops": []}
    e1 = (e1 or "").lower()
    m = re.fullmatch(r"drops lvl (\d) boss part", e1)
    if m:
        out["drops"].append(f"boss-part-lvl-{m.group(1)}")
    elif e1 == "drops minion part":
        out["drops"].append("minion-part")
    elif re.fullmatch(r"drops (\d+) minion parts", e1):
        out["drops"].extend(["minion-part"] * int(re.fullmatch(r"drops (\d+) minion parts", e1).group(1)))
    elif e1 == "read quest index":
        # Story bosses (e.g. Carnatia): the quest entry grants the reward.
        return out
    else:
        raise ValueError(f"unhandled death drop {e1!r}")
    e2 = (e2 or "").lower()
    if e2 == "gain a level card":
        out["gainLevelUpCards"] = 1
    elif re.fullmatch(r"gain (\d+) xp", e2):
        out["gainXp"] = int(re.fullmatch(r"gain (\d+) xp", e2).group(1))
    elif re.fullmatch(r"gain (\d+) elements", e2):
        # Lieutenant B cards: "Gain 3 elements" = each delver picks.
        out["gainElementChoice"] = int(re.fullmatch(r"gain (\d+) elements", e2).group(1))
    elif e2 == "gain 1d6 xp":
        out["gainXpDice"] = 1
    elif e2.startswith("gain {various/"):
        # Printed icons: moon = void, sun = radiance.
        alias = {"moon": "void", "sun": "radiance"}
        out["gainElements"] = [alias.get(w, w) for w in re.findall(r"various/(\w+)\.png", e2)]
    elif e2:
        raise ValueError(f"unhandled death effect {e2!r}")
    return out


def main():
    wb = load_workbook(WORKBOOK, data_only=True)
    enemies_path = ROOT / "data" / "enemies.json"
    enemies = json.loads(enemies_path.read_text(encoding="utf8"))
    by_id = {e["id"]: e for e in enemies}
    only = sys.argv[4] if len(sys.argv) > 4 else ""
    for spec in SPEC:
        if not spec["id"].startswith(only):
            continue
        ws = wb[spec["sheet"]]
        hdr = [c.value for c in ws[1]]
        rows = [dict(zip(hdr, r)) for r in ws.iter_rows(min_row=2, values_only=True) if r[0] == spec["old"]]
        d = rows[spec["row"]]
        common, uncommon = parse_arrows(d)
        if "part_of" in spec:
            # Second card of a 2-card boss: stats, parting shot and drops
            # live on the first card. Copy them so the engine has values,
            # but it never treats this card as its own enemy.
            main = by_id[spec["part_of"]]
            d = {**d, "HP": main["hp"], "Damage": main["attack"]}
        if "part_of" in spec:
            ps, ps_text = by_id[spec["part_of"]]["partingShot"], by_id[spec["part_of"]]["partingShotText"]
        else:
            ps, ps_text = parse_parting(d.get("Parting Shot 1 Text"), d.get("Parting Shot 2 Text"))
        family = spec["name"]
        image = f"enemy_{spec['id'].split('-')[0]}_{spec['cardNumber']:03d}.jpg"
        entry = {
            "id": spec["id"], "kind": spec["kind"], "family": family, "cardNumber": spec["cardNumber"],
            "name": spec["name"], "hp": int(d["HP"]), "attack": int(d["Damage"]), "image": image,
            "abilityText": d.get("Abilities") or "", "partingShotText": ps_text, "partingShot": ps,
            "abilities": auto_abilities(d.get("Abilities")) if spec["abilities"] == "auto" else spec["abilities"],
            "counterCommon": common, "counterUncommon": uncommon,
            "onDeath": {"drops": []} if "part_of" in spec else parse_death(d.get("DeathEffect1"), d.get("DeathEffect2")),
        }
        if "part_of" in spec:
            entry["partOf"] = spec["part_of"]
        by_id[spec["id"]] = entry
        crop = find_art(spec["art"]) if "art" in spec else MATERIALS / f"p{spec['card'][0]:02d}_{spec['card'][1]:02d}.png"
        Image.open(crop).convert("RGB").resize((CARD_SIZE, CARD_SIZE), Image.LANCZOS).save(ROOT / "public" / "cards" / image, quality=92)
        print("imported", spec["id"], entry["hp"], entry["attack"], len(common), len(uncommon))
    # Keep the file's existing order; new ids are appended.
    ordered = [by_id[e["id"]] for e in enemies] + [e for i, e in by_id.items() if i not in {x["id"] for x in enemies}]
    enemies_path.write_text(json.dumps(ordered, indent=2, ensure_ascii=False) + "\n", encoding="utf8")


if __name__ == "__main__":
    main()
