"""Fold the Scenario Card choices into the Quests #3+ booklet's continue
entries, the same way as Quest #2 and the owner's Quest #4 Wave 1 fix.

Usage: python -I storychoices_doc.py <in document.xml> <out document.xml>

Runs on the OWNER'S current booklet (it keeps their edits). For every moment
in scripts/storybookChoices.py:
- the continue entry keeps its story; the scenario scene, a "Choose one:"
  box (the owner's 4.2 layout: bold option + result, then its resolution)
  and the rest of the story follow; the old fixed-reward line is removed
  (each option carries it);
- the Key Item bonus is the last row of that box.
Also removes the earlier attempt: the C rows on the wave pages and the
separate "Xa" bonus entries (Quest #8's doc-only 8.2a is left alone).
New text is highlighted green.
"""
import re
import sys
from pathlib import Path
from xml.sax.saxutils import escape

sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import storybookChoices as sc  # noqa: E402
from fitprose import curly  # noqa: E402  (tools/booklet)

src, dst = sys.argv[1], sys.argv[2]
x = open(src, encoding='utf-8').read()
P_RE = re.compile(r'<w:p[ >].*?</w:p>', re.S)
HL = '<w:highlight w:val="green"/>'
GAME_MOMENTS = {(m['quest'], m['wave']): m for m in sc.MOMENTS}

def paras():
    return list(P_RE.finditer(x))

def text(p):
    return ''.join(re.findall(r'<w:t[^>]*>([^<]*)</w:t>', p))

def unesc(s):
    return s.replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"').replace('&apos;', "'").replace('&amp;', '&')

def norm(s):
    return (unesc(s).replace('’', "'").replace('‘', "'").replace('“', '"').replace('”', '"')
            .replace('…', '...').strip())

def run(t, bold=False, hl=True, sz='22'):
    rpr = ('<w:b/><w:bCs/>' if bold else '') + (HL if hl else '') + f'<w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/>'
    return f'<w:r><w:rPr>{rpr}</w:rPr><w:t xml:space="preserve">{escape(t)}</w:t></w:r>'

def para(*runs, ppr=''):
    return f'<w:p>{ppr}{"".join(runs)}</w:p>'

BLANK = '<w:p><w:pPr><w:rPr><w:sz w:val="12"/><w:szCs w:val="12"/></w:rPr></w:pPr></w:p>'

def choose_table(rows):
    """rows: [(letter, head, result, resolution)] in the owner's 4.2 layout."""
    trs = []
    for letter, head, result, res in rows:
        cell = (para(run(head, bold=True), run(' ' + result)) + BLANK + para(run(res)))
        trs.append('<w:tr><w:trPr><w:cantSplit/></w:trPr>'
                   f'<w:tc><w:tcPr><w:tcW w:w="420" w:type="dxa"/></w:tcPr>{para(run(letter))}</w:tc>'
                   f'<w:tc><w:tcPr><w:tcW w:w="7980" w:type="dxa"/></w:tcPr>{cell}</w:tc></w:tr>')
    borders = ''.join(f'<w:{s} w:val="single" w:sz="8" w:space="0" w:color="000000"/>'
                      for s in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'))
    return ('<w:tbl><w:tblPr><w:tblW w:w="8400" w:type="dxa"/><w:tblInd w:w="0" w:type="dxa"/>'
            f'<w:tblBorders>{borders}</w:tblBorders><w:tblLayout w:type="fixed"/>'
            '<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/>'
            '<w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>'
            '<w:tblGrid><w:gridCol w:w="420"/><w:gridCol w:w="7980"/></w:tblGrid>' + ''.join(trs) + '</w:tbl>')

# --------------------------------------------- 1. remove the earlier attempt
# C rows on the wave pages
n_rows = 0
for t in re.findall(r'<w:tr[ >](?:(?!</w:tr>).)*?\[REQUIRES KEY ITEM #(?:\d+)\].*?</w:tr>', x, re.S):
    x = x.replace(t, '', 1); n_rows += 1
# Xa entries: heading "N.Na" through the paragraph before the next heading/divider-led entry
n_entries = 0
while True:
    ps = paras()
    T = [text(m.group(0)).strip() for m in ps]
    i = next((k for k, t in enumerate(T) if re.match(r'^\d+\.\d+a$', t)), None)
    if i is None:
        break
    j = next(k for k in range(i + 1, len(T)) if re.match(r'^\d+\.\d+a?$', T[k]) or T[k].startswith('QUEST #'))
    # keep the divider that separated the previous entry from the next one
    end = j - 1
    while end > i and not T[end].startswith('____'):
        end -= 1
    x = x[:ps[i].start()] + x[ps[end].end():] if end > i else x[:ps[i].start()] + x[ps[j].start():]
    n_entries += 1
print(f'removed {n_rows} wave-page C rows and {n_entries} Xa entries')

# Booklet bug: Quest #10 Wave 3's continue-only block was labelled "10.9 only:"
# (10.9 is the Retreat entry; Continue goes to 10.8).
if '10.9 only:' in x:
    x = x.replace('>10.9 only:<', '>10.8 only:<', 1)
    print('fixed label: "10.9 only:" -> "10.8 only:"')

# ----------------------------------------------- 2. bonus row texts (short)
BONUS_TEXT = sc.BONUS   # shared with the game (scripts/storybookChoices.py)

def doc_result(effects, rewards):
    parts = []
    for r in rewards:
        if r['kind'] == 'add-shop-products':
            n = r['products'][0]
            parts.append(f'add Shop Product #{n} ({sc.PRODUCT_NAMES[n]}) to your Purchasable Products'
                         + (' (a Memory Chip token if already available or owned)' if r.get('chipFallback') else ''))
        elif r['kind'] == 'reveal-quest-or-grant-chip':
            parts.append(sc.reward_text(r) + ' (a Memory Chip token if already owned or completed)')
    parts += [sc.effect_text(e) for e in effects]
    s = ', '.join(parts[:-1]) + (', and ' if len(parts) > 1 else '') + parts[-1]
    return sc.sentence(s)

def game_bonus(qn, wave):
    import json
    q = json.loads((Path(__file__).resolve().parents[2] / 'data' / f'quest{qn}.json').read_text(encoding='utf8'))
    w = next(w for w in q['waves'] if w['number'] == wave)
    return next((c for c in w['eow']['victory'] if c.get('requireKeyItem')), None)

# ------------------------------------------- 3. rebuild the continue entries
OLD_REWARD = re.compile(r'^(Delvers |Gain )?(gain|heal)\b.*(Level card|elements|HP)\b.*\.?$', re.I)

def entry_for(q, w):
    T = [text(m.group(0)) for m in paras()]
    for h, t in enumerate(T):
        if t.startswith(f'QUEST #{q:02d}:') and T[h + 1].strip().startswith(f'WAVE {w}'):
            for k in range(h, h + 300):
                if T[k].strip() == 'CONTINUE':
                    return re.search(r'Go to entry ([\d.]+)', T[k + 1]).group(1)
    raise SystemExit(f'no CONTINUE entry for Q{q} W{w}')

done = 0
for m in sc.MOMENTS + sc.DOC_MOMENTS:
    e = m.get('entry') or entry_for(m['quest'], m['wave'])
    ps = paras()
    T = [text(p.group(0)) for p in ps]
    i = next(k for k, t in enumerate(T) if t.strip() == e)
    j = next(k for k in range(i + 1, len(T)) if T[k].startswith(('____', 'QUEST #'))
             or re.match(r'^\d+\.\d+a?$', T[k].strip()))
    rng = list(range(i + 1, j))
    # (a) drop the old fixed reward line(s)
    old = [k for k in rng if OLD_REWARD.match(norm(T[k])) and 'Shop Product' not in T[k]]
    # (b) where the scene goes: before the split sentence, else before the
    #     first reward / goal / closing line
    insert_at, split_off = None, None
    if m.get('split'):
        key = norm(m['split'])[:25]
        k = next(k for k in rng if key in norm(T[k]))
        pos = norm(T[k]).index(key)
        insert_at = k
        if pos > 0:
            split_off = pos
    else:
        story = [k for k in rng if T[k].strip() and k not in old and '<w:numPr>' not in ps[k].group(0)
                 and not norm(T[k]).startswith(('Continue', 'Rewards'))]
        insert_at = story[-1] + 1
    rows = []
    for n, (label, res, effects, rewards) in enumerate(sc.option_list(m)):
        own = [r for r in rewards if r not in m.get('rewards', [])]
        rows.append((sc.LETTERS[n], sc.sentence(label), doc_result(effects, own), res))
    b = game_bonus(m['quest'], m['wave']) if m.get('bonus') else None
    if b:
        head, story = BONUS_TEXT[m['bonus']]
        rows.append((sc.LETTERS[len(rows)], f'[REQUIRES KEY ITEM #{m["bonus"]}] {head}.',
                     doc_result(b.get('carryEffects', []), b.get('rewards', [])), story))
    if m.get('bonus_doc'):
        bd = m['bonus_doc']
        b = bd
        rows.append((sc.LETTERS[len(rows)], f'[REQUIRES KEY ITEM #{bd["item"]}] {bd["head"]}.',
                     doc_result(sc.merged(m['keep'], bd['effects']), bd['rewards']), bd['story']))
    rows = [(l, curly(h), curly(r), curly(s)) for l, h, r, s in rows]
    block = ''
    if m['scene']:
        block += para(run(curly(m['scene']), sz='22')) + BLANK
    block += para(run('Choose one:', sz='22')) + choose_table(rows)
    # apply edits from the bottom up so offsets stay valid
    pieces = []
    for k in sorted(set(old), reverse=True):
        pieces.append((ps[k].start(), ps[k].end(), ''))
    target = ps[insert_at]
    if split_off is not None:
        p = target.group(0)
        full = unesc(T[insert_at])
        cut = full.index(next(s for s in [m['split'], curly(m['split'])] if s in full))
        tpl_rpr = re.search(r'<w:r>(<w:rPr>.*?</w:rPr>)?', p, re.S).group(1) or ''
        ppr = (re.search(r'<w:pPr>.*?</w:pPr>', p, re.S) or [''])
        ppr = ppr.group(0) if hasattr(ppr, 'group') else ''
        mk = lambda t: f'<w:p>{ppr}<w:r>{tpl_rpr}<w:t xml:space="preserve">{escape(t)}</w:t></w:r></w:p>'
        new = mk(full[:cut].rstrip()) + block + mk(full[cut:])
        pieces.append((target.start(), target.end(), new))
    else:
        pieces.append((target.start(), target.start(), block))
    for s0, e0, rep in sorted(pieces, key=lambda t: t[0], reverse=True):
        x = x[:s0] + rep + x[e0:]
    done += 1
    print(f"entry {e}: {len(rows)} choices{' (+ Key Item bonus)' if b else ''}, removed {len(old)} old reward line(s)")

open(dst, 'w', encoding='utf-8', newline='').write(x)
print(f'{done} continue entries rebuilt')
