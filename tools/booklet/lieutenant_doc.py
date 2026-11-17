"""Add the Lieutenant challenge row to the Quests #3+ booklet (2026-11-17).

Usage: python -I lieutenant_doc.py <in document.xml> <out document.xml>

Runs on the current booklet (the output of storychoices_doc.py + spreads.py,
with any owner edits). For every moment that scripts/storybookChoices.py marks
`lieutenant_eligible` (Quest #4+, continuing into Wave 3 or later), it finds
the entry's "Choose one:" box and inserts the "Challenge the Lieutenant" row
before the Key Item bonus row (or at the end), re-lettering the rows after it.
Same row layout as storychoices_doc.py; new text is highlighted cyan.
Idempotent: a box that already has the row is left alone.
"""
import re
import sys
from pathlib import Path
from xml.sax.saxutils import escape

sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import storybookChoices as sc  # noqa: E402
from fitprose import curly  # noqa: E402

src, dst = sys.argv[1], sys.argv[2]
x = open(src, encoding='utf-8').read()
P_RE = re.compile(r'<w:p[ >].*?</w:p>', re.S)
TR_RE = re.compile(r'<w:tr[ >].*?</w:tr>', re.S)
HL = '<w:highlight w:val="cyan"/>'
BLANK = '<w:p><w:pPr><w:rPr><w:sz w:val="12"/><w:szCs w:val="12"/></w:rPr></w:pPr></w:p>'
# The booklet spells out the "all six already in" case once per row.
FALLBACK = '; if all 6 are in, put one of them on top'


def text(p):
    return ''.join(re.findall(r'<w:t[^>]*>([^<]*)</w:t>', p))


def run(t, bold=False):
    rpr = ('<w:b/><w:bCs/>' if bold else '') + HL + '<w:sz w:val="22"/><w:szCs w:val="22"/>'
    return f'<w:r><w:rPr>{rpr}</w:rPr><w:t xml:space="preserve">{escape(t)}</w:t></w:r>'


def row(letter, head, result, res):
    cell = f'<w:p>{run(head, bold=True)}{run(" " + result)}</w:p>' + BLANK + f'<w:p>{run(res)}</w:p>'
    return ('<w:tr><w:trPr><w:cantSplit/></w:trPr>'
            f'<w:tc><w:tcPr><w:tcW w:w="420" w:type="dxa"/></w:tcPr><w:p>{run(letter)}</w:p></w:tc>'
            f'<w:tc><w:tcPr><w:tcW w:w="7980" w:type="dxa"/></w:tcPr>{cell}</w:tc></w:tr>')


def relabel(tr, letter):
    """Replace the letter in a row's first cell."""
    return re.sub(r'(<w:tc>.*?<w:t[^>]*>)[A-G](</w:t>)', lambda m: m.group(1) + letter + m.group(2), tr, count=1, flags=re.S)


def entry_for(q, w):
    T = [text(m.group(0)) for m in P_RE.finditer(x)]
    for h, t in enumerate(T):
        if t.startswith(f'QUEST #{q:02d}:') and T[h + 1].strip().startswith(f'WAVE {w}'):
            for k in range(h, h + 300):
                if T[k].strip() == 'CONTINUE':
                    return re.search(r'Go to entry ([\d.]+)', T[k + 1]).group(1)
    raise SystemExit(f'no CONTINUE entry for Q{q} W{w}')


def lieutenant_row_parts(m, level):
    label, res, effects, rewards = sc.option_list(m, level)[-1]
    assert label == sc.LIEUTENANT_LABEL
    own = [r for r in rewards if r not in m.get('rewards', [])]
    result = sc.sentence(sc.result_phrase(effects, own))
    lt = sc.reward_text(sc.LT_CHALLENGE)
    for form in (lt, lt[0].upper() + lt[1:]):
        result = result.replace(form, form[:-1] + FALLBACK + ')')
    assert FALLBACK in result, result
    return sc.sentence(label), curly(result), curly(res)


GAME_LEVELS = {}
for m in sc.MOMENTS:
    if sc.lieutenant_eligible(m):
        import json
        q = json.loads((Path(__file__).resolve().parents[2] / 'data' / f'quest{m["quest"]}.json').read_text(encoding='utf8'))
        GAME_LEVELS[(m['quest'], m['wave'])] = sc.next_wave_boss_level(q, m['wave'])

done = skipped = 0
for m in [m for m in sc.MOMENTS + sc.DOC_MOMENTS if sc.lieutenant_eligible(m)]:
    e = m.get('entry') or entry_for(m['quest'], m['wave'])
    ps = list(P_RE.finditer(x))
    T = [text(p.group(0)).strip() for p in ps]
    i = next(k for k, t in enumerate(T) if t == e)
    c = next(k for k in range(i + 1, len(T)) if T[k] == 'Choose one:')
    if any(T[k] == e2 for k in range(i + 1, c) for e2 in [f'{m["quest"]}.{n}' for n in range(1, 30)] if e2 != e):
        raise SystemExit(f'entry {e}: the next "Choose one:" belongs to another entry')
    t0 = x.index('<w:tbl>', ps[c].end())
    t1 = x.index('</w:tbl>', t0) + len('</w:tbl>')
    tbl = x[t0:t1]
    rows = TR_RE.findall(tbl)
    if any(sc.LIEUTENANT_LABEL in text(r) for r in rows):
        skipped += 1
        continue
    at = next((n for n, r in enumerate(rows) if '[REQUIRES KEY ITEM' in text(r)), len(rows))
    head, result, res = lieutenant_row_parts(m, GAME_LEVELS.get((m['quest'], m['wave'])))
    new_rows = rows[:at] + [row(sc.LETTERS[at], head, result, res)] + \
        [relabel(r, sc.LETTERS[n + 1]) for n, r in enumerate(rows[at:], start=at)]
    body_start = tbl.index(rows[0])
    body_end = tbl.rindex(rows[-1]) + len(rows[-1])
    x = x[:t0] + tbl[:body_start] + ''.join(new_rows) + tbl[body_end:] + x[t1:]
    done += 1
    print(f'entry {e}: Lieutenant row {sc.LETTERS[at]} ({len(new_rows)} rows)')

open(dst, 'w', encoding='utf-8', newline='').write(x)
print(f'{done} boxes updated, {skipped} already had the row')
