"""Import the 6 Lieutenants Spawn Cards (#19-24) into data/spawnCards.json
and copy their art to public/spawn-cards/ (2026-11-17).

Layouts come from the workbook's "Spawn Fronts" sheet (rows titled
"Lieutenants Spawn Card", in order). Columns West / LessWest / Middle /
LessEast / East are x = 0..4; the digit after the column name is the row,
y = digit - 1 (north is y = 0). Cell images: boss.jpg, minion.jpg,
lieutenant.jpg, startingpoint.png (delver spawn), circuit.png (Memory
Fragment).

Art: the materials PDF crops p43_00 .. p43_05 (scripts/extractGameMaterials.py),
in the same order as the sheet rows.

Usage:
  python -I scripts/importLieutenantSpawnCards.py <G2G root> <workbook.xlsx> <materials outdir>
Re-running replaces cards #19-24.
"""
import json
import shutil
import sys
from pathlib import Path

from openpyxl import load_workbook

ROOT = Path(sys.argv[1])
WORKBOOK = sys.argv[2]
MATERIALS = Path(sys.argv[3])
FIRST_NUMBER = 19
COLUMNS = ["West", "LessWest", "Middle", "LessEast", "East"]
KINDS = {"boss.jpg": "bosses", "minion.jpg": "minions", "lieutenant.jpg": "lieutenants",
         "startingpoint.png": "delverSpawns", "circuit.png": "memoryFragments"}


def pos_list(ps):
    return "[" + ", ".join(f'{{ "x": {p["x"]}, "y": {p["y"]} }}' for p in ps) + "]"


def card_text(c):
    keys = ["bosses", "minions", "lieutenants", "delverSpawns", "memoryFragments"]
    body = [f'    "number": {c["number"]},', f'    "image": "{c["image"]}",']
    body += [f'    "{k}":{" " * (16 - len(k))}{pos_list(c[k])}' + ("," if i < len(keys) - 1 else "")
             for i, k in enumerate(keys)]
    return "  {\n" + "\n".join(body) + "\n  }"


def main():
    ws = load_workbook(WORKBOOK)["Spawn Fronts"]
    hdr = [c.value for c in ws[1]]
    rows = [r for r in ws.iter_rows(min_row=2, values_only=True) if r[0] == "Lieutenants Spawn Card"]
    if len(rows) != 6:
        raise SystemExit(f"expected 6 Lieutenants Spawn Cards, found {len(rows)}")
    cards = []
    for i, row in enumerate(rows):
        c = {"number": FIRST_NUMBER + i, "image": f"spawn-card-{FIRST_NUMBER + i}.png",
             **{k: [] for k in KINDS.values()}}
        for name, v in zip(hdr, row):
            if not v or name in ("Title", "North", "Frame"):
                continue
            col, digit = name.rstrip("12345"), int(name[-1])
            c[KINDS[v]].append({"x": COLUMNS.index(col), "y": digit - 1})
        for k in c[KINDS["boss.jpg"]], c["minions"], c["lieutenants"], c["delverSpawns"]:
            k.sort(key=lambda p: (p["y"], p["x"]))
        if (len(c["bosses"]), len(c["minions"]), len(c["lieutenants"]), len(c["delverSpawns"])) != (1, 7, 2, 2):
            raise SystemExit(f"card #{c['number']} has an unexpected layout: {c}")
        shutil.copyfile(MATERIALS / f"p43_{i:02d}.png", ROOT / "public" / "spawn-cards" / c["image"])
        cards.append(c)

    path = ROOT / "data" / "spawnCards.json"
    existing = json.loads(path.read_text(encoding="utf8"))
    keep = [c for c in existing if c["number"] < FIRST_NUMBER]
    # Re-emit the kept cards verbatim from the file text so their hand
    # formatting survives; only the Lieutenant cards are generated.
    raw = path.read_bytes().decode("utf8")
    crlf = "\r\n" in raw
    text = raw.replace("\r\n", "\n").rstrip()
    marker = f'\n  {{\n    "number": {FIRST_NUMBER},'
    if marker in text:
        text = text[:text.index(marker)].rstrip().rstrip(",") + "\n]"
    if json.loads(text) != keep:
        raise SystemExit("could not split spawnCards.json cleanly")
    text = text[: text.rindex("]")].rstrip() + ",\n" + ",\n".join(card_text(c) for c in cards) + "\n]\n"
    path.write_bytes((text.replace("\n", "\r\n") if crlf else text).encode("utf8"))
    print("wrote", [c["number"] for c in cards])


if __name__ == "__main__":
    main()
