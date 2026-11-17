"""Apply the storybook continue choices (scripts/storybookChoices.py) to the
hand-authored quest JSON files (quests 3, 5, 6). Quests 4, 7 and 13 get the
same treatment inside scripts/buildCh4Quests.py.

Usage: python -I scripts/applyStorybookChoices.py <G2G root>
Idempotent: each run regenerates the options from the base continue page.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from storybookChoices import apply_to_quest  # noqa: E402

root = Path(sys.argv[1]) / "data"
for n in (3, 5, 6):
    path = root / f"quest{n}.json"
    raw = path.read_text(encoding="utf8")
    q = apply_to_quest(json.loads(raw), n)
    nl = "\r\n" if "\r\n" in raw else "\n"
    path.write_text(json.dumps(q, indent=2, ensure_ascii=False).replace("\n", nl) + nl, encoding="utf8")
    print(f"quest{n}: storybook choices applied")
