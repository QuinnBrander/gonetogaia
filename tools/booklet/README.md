# Rising Tide booklet tools (Nov 17 2026)

Rebuild the board-game booklet copies in `../../Rising Tide Booklet - Nov 17 2026/`
from the source `Rising Tide - Chapters 3-4 (Revised).docx`. See
`SCENARIO_STORYBOOK_SPEC.md` §8b and §8d for what they do and why.

1. Unzip the source docx to `<work>/unpacked` (Python `zipfile`) and run the docx
   skill's `merge_runs.py` on it.
2. `python -I booklet34.py <copy of unpacked> ch3.xml ch4.xml quests.xml`: story fixes,
   Scenario Deck removal, Key Item bonuses, the Quest #03 gate, and the 3-way split.
   Imports `fitprose.py` (tighter base prose for over-full resolution pages).
3. `python -I spreads.py quests.xml quests_spread.xml`: two-page spreads per wave
   (page breaks, shrink to fit, spacer clean-up). See its docstring.
4. `python -I pack.py <source.docx> <document.xml> <out.docx>`: re-zip (run inside
   the work dir, which holds `work/`). Validate with the docx skill's
   `validate.py --original`.
5. Measure in Word (a stand-in; Google Docs is the layout authority):
   `pagemap2.ps1 -Src <docx> -OutFile pages.txt`, then `python -I spreadcheck.py pages.txt`.
   `exportpages.ps1 -Src <docx> -From N -To M -Out x.pdf` renders a page range for
   a visual check.
