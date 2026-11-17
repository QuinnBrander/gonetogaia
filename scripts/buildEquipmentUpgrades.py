"""Add the Nov 15 Machinist Equipment Upgrade families to
data/equipmentUpgrades.json and copy their card art from the prototype
materials PDF crops.

Usage:
  python -I scripts/buildEquipmentUpgrades.py <G2G root> <extractGameMaterials outdir>

Re-running replaces the families listed in FAMILIES (matched by family id);
the three older families (shock-gauntlet, cyclone-boots,
earths-embrace-shield) are left as they are. Card text is the PDF's
(pages 9 and 11); element icons the text extraction drops were read off
the card art: Engulfing Beam = fire, Sword of Ruin = wind, Precise
Shockwave = radiance, Lunar Trident = void, Overcharger = water.
"""
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(sys.argv[1])
CROPS = Path(sys.argv[2])
X = lambda r: "" if r == 1 else f"{r}x "  # noqa: E731  "2x MEDIUM" style multiplier


def passive(family, typ, name, product, text, effects):
    return dict(family=family, type=typ, category="passive", name=name, product=product,
                text=text, effects=effects)


def weapon(family, typ, name, product, text, damage_type, rng, effects):
    return dict(family=family, type=typ, category="weapon", name=name, product=product,
                text=text, damageType=damage_type, range=rng, effects=effects)


# (family, card name as printed, PDF page, index of rank 1 on that page)
FAMILIES = [
    (passive("living-armor", "Armor", "Living Armor", 33,
             lambda r: f"IMMEDIATELY: Increase max HP to {6 + 3 * r} and current HP by 3. ONGOING: Heal {r} HP at the end of each Wave. When you earn a Level card, delvers on your tile heal {r} HP.",
             lambda r: [{"kind": "set-max-hp", "value": 6 + 3 * r}, {"kind": "modify-current-hp", "delta": 3},
                        {"kind": "heal-at-end-of-wave", "amount": r}, {"kind": "heal-tile-on-level-card", "amount": r}]),
     11, 15),
    (passive("ion-battery", "Battery", "Ion Battery", 35,
             lambda r: "IMMEDIATELY: choose 1 listed reward: Gain 2 AP tokens / Gain 1 AP & 2 Reroll tokens / Gain 1 AP & 1 Block 1 Counterattack token.",
             lambda r: [{"kind": "immediately-equipment-roll"}]),
     11, 25),
    (passive("new-harvester", "Harvester", "New Harvester", 36,
             lambda r: f"ONGOING: You gain a Level {r} boss part token at the end of each Wave (taken from the supply).",
             lambda r: [{"kind": "gain-tokens-at-end-of-wave", "token": "boss-part", "amount": 1, "bossLevel": r}]),
     11, 20),
    (passive("ancient-os", "OS", "Ancient OS", 37,
             lambda r: f"ONGOING: Enemies that grant XP grant {r} additional XP. Both delvers gain {r} element{'s' if r > 1 else ''} at the end of each Wave.",
             lambda r: [{"kind": "bonus-xp-on-kill", "amount": r},
                        {"kind": "gain-element-at-end-of-wave", "amount": r, "recipient": "all-delvers"}]),
     11, 5),
    (passive("overcharger", "Supercharger", "Overcharger", 38,
             lambda r: "IMMEDIATELY: Gain two 2x LIGHT, 2x MEDIUM or 2x HEAVY damage tokens. ONGOING: You may spend 2 Water to increase your base LIGHT, MEDIUM or HEAVY damage.",
             lambda r: [{"kind": "immediately-equipment-roll"}, {"kind": "overcharge-damage", "element": "water", "cost": 2}]),
     11, 10),
    (weapon("engulfing-beam", "Beam", "Engulfing Beam", 39,
            lambda r: f"{X(r)}MEDIUM damage to all targets in any straight line (including diagonals). Spend 1 Fire: {X(r)}LIGHT damage to all enemies. Spend 1 Fire: Block counterattacks.",
            "medium", {"kind": "straight-line", "includeDiagonals": True, "firstTargetOnly": False},
            lambda r: [{"kind": "spend-element-damage-all-enemies", "element": "fire", "cost": 1, "damageType": "light", "multiplier": r},
                       {"kind": "spend-element-block-counterattacks", "element": "fire", "cost": 1}]),
     9, 1),
    (weapon("precise-shockwave", "Shockwave", "Precise Shockwave", 40,
            lambda r: f"{X(r)}LIGHT damage to targets of your choice within 2 tiles. Spend 1 Radiance: Additional {X(r)}HEAVY damage to 1 adjacent target.",
            "light", {"kind": "choose-targets", "maxDistance": 2},
            lambda r: [{"kind": "spend-element-extra-adjacent-damage", "element": "radiance", "cost": 1, "damageType": "heavy", "multiplier": r}]),
     9, 16),
    (weapon("fabled-hammer", "Hammer", "Fabled Hammer", 42,
            lambda r: f"{X(r)}HEAVY damage to enemies between the two delvers. Only useable if delvers are in a straight line to each other.",
            "heavy", {"kind": "between-delvers"},
            lambda r: []),
     9, 26),
    (weapon("sword-of-ruin", "Sword", "Sword of Ruin", 43,
            lambda r: f"{X(r)}MEDIUM damage to an adjacent target. If target dies, gain 1 Wind. Spend 2 Wind: Additional {X(r)}HEAVY damage.",
            "medium", {"kind": "single-adjacent"},
            lambda r: [{"kind": "gain-element-on-kill", "element": "wind", "amount": 1},
                       {"kind": "spend-element-bonus-damage", "element": "wind", "cost": 2, "damageType": "heavy", "multiplier": r}]),
     9, 6),
    (weapon("war-mace", "Mace", "War Mace", 44,
            lambda r: f"Target an adjacent enemy. If a boss, deal {X(r)}HEAVY damage. If a minion, deal {X(r)}LIGHT damage and gain 1 element.",
            "heavy", {"kind": "single-adjacent"},
            lambda r: [{"kind": "minion-damage-override", "damageType": "light", "multiplier": r, "gainElementChoice": 1}]),
     9, 11),
    (weapon("lunar-trident", "Trident", "Lunar Trident", 45,
            lambda r: f"{X(r)}MEDIUM damage to an adjacent target. Spend 2 Void: roll a die and multiply damage by the result.",
            "medium", {"kind": "single-adjacent"},
            lambda r: [{"kind": "spend-element-die-multiplier", "element": "void", "cost": 2}]),
     9, 21),
]

FIRST_CARD_NUMBER = 156


def undouble(text):
    """The PDF prints bold text twice per glyph ("RRaannkk"); undo it per word."""
    out = []
    for w in text.split():
        if len(w) >= 2 and len(w) % 2 == 0 and all(w[i] == w[i + 1] for i in range(0, len(w), 2)):
            w = w[::2]
        out.append(w)
    return " ".join(out)


def main():
    path = ROOT / "data" / "equipmentUpgrades.json"
    entries = json.loads(path.read_text(encoding="utf8"))
    ours = {f[0]["family"] for f in FAMILIES}
    entries = [e for e in entries if e["family"] not in ours]
    index = json.loads((CROPS / "index.json").read_text(encoding="utf8"))
    by_file = {c["file"]: c for c in index}
    out_dir = ROOT / "public" / "equipment-upgrades"
    number = FIRST_CARD_NUMBER
    for spec, page, first in FAMILIES:
        for r in range(1, 6):
            crop = f"p{page:02d}_{first + r - 1:02d}.png"
            text = undouble(by_file[crop]["text"]).replace(" ", "").lower()
            if (spec["name"] + "-Rank").replace(" ", "").lower() not in text:
                raise SystemExit(f"{crop} isn't {spec['name']} (text: {text[:60]})")
            entry = {
                "id": f"upgrade-{spec['family']}-r{r}",
                "family": spec["family"],
                "type": spec["type"],
                "category": spec["category"],
                "rank": r,
                "name": spec["name"],
                "cardNumber": number,
                "image": f"equipment-upgrade-{number}.png",
            }
            if spec["category"] == "weapon":
                entry["damageType"] = spec["damageType"]
                entry["damageMultiplier"] = r
                entry["range"] = spec["range"]
            entry["abilityText"] = spec["text"](r)
            entry["effects"] = spec["effects"](r)
            entries.append(entry)
            img = Image.open(CROPS / crop).convert("RGB")
            img.save(out_dir / entry["image"])
            # The hand / slot UI loads equipment art from public/cards.
            img.save(ROOT / "public" / "cards" / entry["image"])
            number += 1
        print(spec["family"], "->", number - 5, "-", number - 1)
    path.write_text(json.dumps(entries, indent=2, ensure_ascii=False) + "\n", encoding="utf8")


if __name__ == "__main__":
    main()
