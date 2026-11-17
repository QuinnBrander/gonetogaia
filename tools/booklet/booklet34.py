"""Nov 17 2026 pass on the Rising Tide Chapters 3-4 booklet.

Usage: python -I booklet34.py <unpacked dir> <out-ch3 document.xml> <out-ch4 document.xml>
Reads <unpacked>/word/document.xml (runs already merged), applies the
session's story fixes + storybook-choice changes (highlighted green), and
writes two split document.xml files.
"""
import re, sys
from xml.sax.saxutils import escape

src, out3, out4, out_q = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
x = open(src + '/word/document.xml', encoding='utf-8').read()

P_RE = re.compile(r'<w:p[ >].*?</w:p>', re.S)
HL = '<w:highlight w:val="green"/>'

def paras():
    return list(P_RE.finditer(x))

def text_of(p):
    return ''.join(re.findall(r'<w:t[^>]*>([^<]*)</w:t>', p))

def unesc(s):
    return s.replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"').replace('&apos;', "'").replace('&amp;', '&')

def find(pred, start=0):
    for i, m in enumerate(paras()):
        if i >= start and pred(unesc(text_of(m.group(0)))):
            return i
    raise SystemExit('paragraph not found')

def idx_text(t, start=0):
    return find(lambda s: s.strip() == t, start)

def idx_contains(t, start=0):
    return find(lambda s: t in s, start)

def get(i):
    return paras()[i]

def set_para(i, new):
    global x
    m = get(i)
    x = x[:m.start()] + new + x[m.end():]

def insert_after(i, new):
    global x
    m = get(i)
    x = x[:m.end()] + new + x[m.end():]

# rPr children that must come AFTER <w:highlight> (schema order).
_AFTER_HL = ('<w:u ', '<w:u>', '<w:effect', '<w:bdr', '<w:shd', '<w:fitText', '<w:vertAlign',
             '<w:rtl', '<w:cs', '<w:em ', '<w:lang', '<w:eastAsianLayout', '<w:specVanish', '<w:oMath')

def hl_rpr(rpr):
    """Return rpr (a full <w:rPr>...</w:rPr> or <w:rPr/>) with a green highlight
    at its schema position (replacing any existing highlight)."""
    if rpr in ('<w:rPr/>', '<w:rPr></w:rPr>'):
        return '<w:rPr>' + HL + '</w:rPr>'
    inner = rpr[len('<w:rPr>'):-len('</w:rPr>')]
    inner = re.sub(r'<w:highlight [^>]*/>', '', inner)
    cut = min([inner.find(t) for t in _AFTER_HL if inner.find(t) >= 0] or [len(inner)])
    return '<w:rPr>' + inner[:cut] + HL + inner[cut:] + '</w:rPr>'

def add_hl(run):
    """Green-highlight one <w:r> run."""
    m = re.match(r'<w:r>(<w:rPr/>|<w:rPr>.*?</w:rPr>)', run, re.S)
    if m:
        return '<w:r>' + hl_rpr(m.group(1)) + run[m.end():]
    return run.replace('<w:r>', '<w:r><w:rPr>' + HL + '</w:rPr>', 1)

def hl_all_runs(xml):
    return re.sub(r'<w:r>(?:(?!</w:r>).)*?</w:r>', lambda m: add_hl(m.group(0)), xml, flags=re.S)

def replace_in(i, old, new, highlight=True):
    """Replace `old` with `new` inside one run of paragraph i."""
    p = get(i).group(0)
    runs = list(re.finditer(r'<w:r>(?:(?!</w:r>).)*?</w:r>', p, re.S))
    for r in runs:
        rt = re.search(r'(<w:t[^>]*>)([^<]*)(</w:t>)', r.group(0))
        if rt and old in unesc(rt.group(2)):
            nt = escape(unesc(rt.group(2)).replace(old, new))
            run = r.group(0).replace(rt.group(0), rt.group(1) + nt + rt.group(3))
            if highlight:
                run = add_hl(run)
            set_para(i, p[:r.start()] + run + p[r.end():])
            return
    raise SystemExit(f'text not in a single run of paragraph {i}: {old!r}')

def strip_runs(i):
    """Empty a paragraph's text but keep it (page layout)."""
    p = get(i).group(0)
    set_para(i, re.sub(r'<w:r>(?:(?!</w:r>).)*?</w:r>', '', p, flags=re.S))

def remove_para(i):
    set_para(i, '')

def retext(template, text, highlight=True):
    """Copy a template paragraph, replace all its text with one run."""
    runs = list(re.finditer(r'<w:r>(?:(?!</w:r>).)*?</w:r>', template, re.S))
    first = next(r.group(0) for r in runs if '<w:t' in r.group(0))
    rpr = re.match(r'<w:r>(<w:rPr/>|<w:rPr>.*?</w:rPr>)', first, re.S)
    rpr = rpr.group(1) if rpr else '<w:rPr/>'
    if highlight:
        rpr = hl_rpr(rpr)
    elif rpr == '<w:rPr/>':
        rpr = ''
    run = f'<w:r>{rpr}<w:t xml:space="preserve">{escape(text)}</w:t></w:r>'
    body = re.sub(r'<w:r>(?:(?!</w:r>).)*?</w:r>', '', template, flags=re.S)
    body = re.sub(r' w14:paraId="[^"]*"', '', body)
    return body.replace('</w:p>', run + '</w:p>', 1)

def empty_para(template):
    body = re.sub(r'<w:r>(?:(?!</w:r>).)*?</w:r>', '', template, flags=re.S)
    return re.sub(r' w14:paraId="[^"]*"', '', body)

# ------------------------------------------------------------ story fixes
replace_in(idx_contains('Father hurries over'), 'Father hurries over', 'Father Flores hurries over')
replace_in(idx_contains('Doctor Ira, my dad!'), 'Doctor Ira, my dad!', 'Oh no, my dad!')
replace_in(idx_contains('Wait, really?'), '“Wait, really?” When Xavier realizes you’re not joking, his mouth twitches into a smile. ', '')
replace_in(idx_contains('You rifle through the pages, many mundane'),
           'You rifle through the pages, many mundane musings from before the days before the fire',
           'You rifle through the pages, finding many mundane musings from the days before the fire')
replace_in(idx_contains('one of us to make it'), 'I really thought she was going to be one of us to make it.', 'I really thought she would be the one to reach Gaia.')
replace_in(idx_contains('If you have the Vera Ally opinion card'),
           'If you have the Vera Ally opinion card, discard it and gain a Level card - Vera would want you to keep fighting.',
           'If you still hold the Vera Ally opinion card, discard it.')
replace_in(idx_contains('Master’s Bram’s lantern'), 'Master’s Bram’s lantern', 'Master Bram’s lantern')

# ------------------------------------------------- Scenario Deck: removed
n = 0
DRAW = 'Draw the top card from the Scenario Deck and resolve it.'
while True:
    try:
        i = idx_text(DRAW)
    except SystemExit:
        break
    m = get(i)
    ts, te = x.rfind('<w:tbl>', 0, m.start()), x.rfind('</w:tbl>', 0, m.start())
    if ts > te:
        # the line sits in its own bordered box: remove the whole table
        end = x.find('</w:tbl>', m.start()) + len('</w:tbl>')
        assert unesc(text_of(x[ts:end])).strip() == DRAW, 'table holds more than the draw line'
        x = x[:ts] + x[end:]
    else:
        remove_para(i)
    n += 1
print('scenario draw lines removed:', n)
remove_para(idx_text('Add Scenario Card A to the top of the Scenario Deck.'))
# Quest #3 3.9 / 3.10: drop the Scenario D sentence; move Dahlia before you push on
for _ in range(2):
    i = idx_contains('Scenario Card D')
    t = unesc(text_of(get(i).group(0)))
    m = re.search(r'\s*Add Scenario Card D to the top of the Scenario Deck\.?', t)
    replace_in(i, m.group(0), '')
i = idx_contains('push deeper into the unknown. From the treeline, Dahlia watched the whole fight.')
replace_in(i, 'Exhausted but resolute, you steel yourselves and push deeper into the unknown. From the treeline, Dahlia watched the whole fight.',
           'From the treeline, Dahlia watched the whole fight. Exhausted but resolute, you steel yourselves and push deeper into the unknown.')

# ------------------------------------------- tighter base prose (page fit)
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
from fitprose import PROSE, curly

def replace_entry_prose(entry, prose):
    """Replace entry X's prose paragraphs (before its first bullet) with
    `prose`, keeping any picture anchored in the old paragraphs."""
    global x
    h = idx_text(entry, idx_contains('QUEST #03:'))
    k = h + 1
    while '<w:numPr>' not in get(k).group(0):
        k += 1
    old = [get(j).group(0) for j in range(h + 1, k)]
    tpl = next(p for p in old if text_of(p).strip() and '<w:drawing>' not in p)
    blank = next(p for p in old if not text_of(p).strip() and '<w:drawing>' not in p)
    pics = ''.join(re.findall(r'<w:r>(?:(?!</w:r>).)*?<w:drawing>.*?</w:r>', ''.join(old), re.S))
    paras = [retext(tpl, curly(t)) for t in prose]
    if pics:
        paras[0] = paras[0].replace('</w:p>', pics + '</w:p>', 1)
    E = empty_para(blank)
    start, end = get(h + 1).start(), get(k - 1).end()
    x = x[:start] + E + E.join(paras) + E + x[end:]

for entry, prose in PROSE.items():
    replace_entry_prose(entry, prose)

# ------------------------------------------------------ Key Item bonuses
PROD = ' to your Purchasable Products (a Memory Chip token if already available or owned).'
BONUSES = [
    # entry, key head (table), instruction, story, finish-line, reward bullets
    ('3.2', '[REQUIRES KEY ITEM #2] COMPARE THE SYRINGE',
     'Read the first paragraph of entry 3.2, then this:',
     'On the climb, the corroded tree’s purple mist returns - and the residue in the strangers’ syringe matches it. You follow the blight to the remains of a humanoid, half coral and half human, Tidebloom dripping from every pore and still wearing a striking piece of armor.',
     'Now finish entry 3.2, but take these rewards instead:',
     ['Add Shop Product #33 (Living Armor)' + PROD, 'Delvers gain 2 elements (your choice).', 'New goal: slay the Carnatia!']),
    ('3.9', '[REQUIRES KEY ITEM #12] WALK WITH DAHLIA',
     'Read entry 3.9 up to “Dahlia watched the whole fight.” Then read this:',
     'She steps out, one slender hand held open toward you, and bows deeply. “You. Saved me. Strong… and kind.” Her petals dim. “Tidekin… afraid. Kin taken,” she says slowly. “You… help? Come. Meet.” Then she melts back into the mist.',
     'Now finish entry 3.9, but take these rewards instead:',
     ['Delvers gain a Level card.', 'Add Quest #04 - “A Hand Outstretched” - to your Open Quests. If already owned or completed, instead gain a Memory Chip token.']),
    ('4.5', '[REQUIRES KEY ITEM #10] TELL THE ELDER',
     'Read entry 4.5 up to “Blame humans for trouble.”, then this:',
     'You tell the elder what you overheard at the festival: Tidekin taken, held near Bird’s Nest. Its branch-like hand lowers, and it presses a shield of living stone and moss into your arms.',
     'Now finish entry 4.5, but take these rewards instead:',
     ['Add Shop Product #32 (Earth’s Embrace Shield)' + PROD, 'Delvers gain 2 elements (your choice).', 'New goal: slay the Ruined Tidekin.']),
    ('5.2', '[REQUIRES KEY ITEM #4] COMPARE THE TRAIL',
     'Read entry 5.2 up to the journal’s last entry, then this:',
     'You think of the femur from the watchtower rubble. If that body was never Vera’s, she’s alive - and under a rock you find a stash she left behind: delver boots humming with wind, wrapped in her old cloak.',
     'Now finish entry 5.2, but take these rewards instead:',
     ['Add Shop Product #34 (Cyclone Boots)' + PROD, 'Delvers gain a Level card.']),
    ('6.11', '[REQUIRES KEY ITEM #3] FOLLOW WOO’S NOTES',
     'Read entry 6.11, then this:',
     'And you’re not walking blind: Margaret Woo’s diary describes this last stretch. “A ridge of broken towers, then the light.” Her notes mark a sheltered gap through the rubble, and a cache wedged beneath a fallen beam, still sealed after twenty years. Inside lies a warhammer of the old world, its head etched with the names of delvers long gone.',
     'Take these rewards instead of entry 6.11’s:',
     ['Add Shop Product #42 (Fabled Hammer)' + PROD, 'Delvers heal 4 HP.']),
    ('7.2', '[REQUIRES KEY ITEM #22] FOLLOW ELIAS’S NOTES',
     'Read entry 7.2, then this:',
     'Elias’s distress-signal notes list the frequencies he monitored - and a relay station along this very road. Inside, still wired to a dead transmitter, sits one of his ion cells, fully charged.',
     'Take these rewards instead of entry 7.2’s:',
     ['Add Shop Product #35 (Ion Battery)' + PROD, 'Delvers gain a Level card.']),
    ('13.2', '[REQUIRES KEY ITEM #9] MATCH THE PAINT',
     'Read the first paragraph of entry 13.2. Then read this:',
     'Back at the hatch frame, flaking green paint catches your eye - the same shade as the chips torn from the festival generator. Whoever attacked the generator came from down here. Behind the frame you find their supply crate, and in it a gauntlet wired with prods that still spark.',
     'Now finish entry 13.2, but take these rewards instead:',
     ['Add Shop Product #41 (Shock Gauntlet)' + PROD, 'Delvers gain 2 elements (your choice).']),
    ('8.2', '[REQUIRES KEY ITEM #5] RECALL IRA’S STORY',
     'Read the first paragraph of entry 8.2, but stop before you jump in. Then read this:',
     'Dr Ira told you she had made late-night comms the night of the fire. Here, at the mouth of the anomaly, a battered comm relay still hums - and wedged behind it is a supercharger core rigged to run hot against the cold. Someone has been coming here, and talking to Bird’s Nest.',
     'Now finish entry 8.2, but take these rewards instead:',
     ['Add Shop Product #38 (Overcharger)' + PROD, 'Delvers heal up to 2 HP.']),
]

for entry, head, instr, story, finish, rewards in BONUSES:
    new_id = entry + 'a'
    # -- options table: copy the last row (B RETREAT) as row C
    go = idx_text(f'Go to entry {entry} on the next page.')
    m = get(go)
    tstart = x.rfind('<w:tbl>', 0, m.start())
    tend = x.find('</w:tbl>', m.start())
    rows = list(re.finditer(r'<w:tr>.*?</w:tr>', x[tstart:tend], re.S))
    last = rows[-1].group(0)
    texts = [unesc(t) for t in re.findall(r'<w:t[^>]*>([^<]*)</w:t>', last)]
    assert texts[0] == 'B' and texts[1].startswith('RETREAT'), (entry, texts)
    row = last
    for old, new in [(texts[0], 'C'), (texts[1], head), (texts[2], f'Go to entry {new_id} on the next page.')]:
        row = row.replace(f'>{escape(old)}</w:t>', f'>{escape(new)}</w:t>', 1)
    row = hl_all_runs(row)
    row = re.sub(r' w14:paraId="[^"]*"', '', row)
    ins = tstart + rows[-1].end()
    x = x[:ins] + row + x[ins:]
    # -- entry Xa after entry X's divider
    h = idx_text(entry, go + 1)
    end = find(lambda s: s.startswith('____'), h + 1)
    seg = [get(k).group(0) for k in range(h, end + 1)]
    heading = seg[0]
    body = next(p for p in seg[1:] if text_of(p).strip() and '<w:numPr>' not in p)
    bullet = next(p for p in seg if '<w:numPr>' in p)
    closing = next(p for p in reversed(seg[:-1]) if text_of(p).strip())
    blank = next(p for p in seg if not text_of(p).strip())
    divider = seg[-1]
    E = empty_para(blank)
    block = (E + retext(heading, new_id) + E + retext(body, instr) + E + retext(body, story) + E
             + retext(body, finish) + ''.join(retext(bullet, r) for r in rewards) + E
             + retext(closing, unesc(text_of(closing))) + E + empty_para(divider).replace('</w:p>', '', 1)
             + re.search(r'<w:r>(?:(?!</w:r>).)*?</w:r>', divider, re.S).group(0) + '</w:p>')
    insert_after(end, block)
    print('bonus', new_id, 'added')

# ------------------------------------ Chapter 5 needs Quest #03 completed
# Chapter 5 opens with Dahlia's execution, so every party must have met and
# rescued her. Chapter 4 now grants Quest #03 up front (fallback chip) and
# requires it completed before Chapter 5.
def insert_before(i, new):
    global x
    m = get(i)
    x = x[:m.start()] + new + x[m.start():]

c4 = idx_text('CHAPTER 4: THE PASSING OF THE TORCH')
q3_bullet = get(idx_contains('Add Quest #03 - “Xavier’s Request” - to your Open Quests. If already owned or completed', c4)).group(0)
sofar = idx_contains('After returning from a Quest, you partook', c4)
sofar_p = get(sofar).group(0)
insert_after(sofar, empty_para(sofar_p)
             + retext(sofar_p, 'Xavier, meanwhile, has posted a standing request for any delver willing to help with his Tidebloom research.')
             + retext(q3_bullet, 'Add Quest #03 - “Xavier’s Request” - to your Open Quests. If already owned or completed, instead gain a Memory Chip token.'))
end4 = idx_contains('check off that you’ve completed Chapter 4’s Town Visit', c4)
label_tpl = get(idx_contains('If you have at least one Open Quest:', c4)).group(0)
insert_before(end4, retext(label_tpl, 'Before Chapter 5:')
              + retext(q3_bullet, 'Quest #03 must be completed before you begin Chapter 5. If it isn’t, play it now - it doesn’t use a Story token - and repeat until it’s complete.')
              + empty_para(label_tpl))

# ------------------------------------------------------- revision notes
i = idx_contains('Vera’s Ally opinion card had no rule')
replace_in(i, 'If you have it, discard it and gain a Level card.', 'If you still hold it, discard it.')
i = idx_contains('New Scenario Cards. #10-#17')
note = get(i).group(0)
set_para(i, retext(note, 'Scenario Cards (Nov 17 2026). Quests no longer draw from the Scenario Deck, and no entry places a card on top of it. Instead, several End of Wave choices gain a C option that needs a specific Key Item and pays it off with an Equipment Upgrade Shop Product (or Quest #04) plus the usual Continue reward. Key Item #12 “Dahlia is Free” now opens Quest #04 (Quest #3, entry 3.9a), replacing Scenario D.'))
i = idx_contains('This version of Chapters 3 and 4 applies fixes')
intro = get(i).group(0)
insert_after(i, empty_para(intro) + retext(intro,
    'Nov 17 2026 pass (highlighted in green): story fixes carried over from the digital prototype '
    '(Father Flores, Rodrigo’s “Oh no, my dad!”, Xavier’s flower scene, Bram’s funeral line, '
    'Vera’s Ally card, Vera’s journal); Scenario Deck draws removed; Key Item bonus options added at '
    '3.2a, 3.9a, 4.5a, 5.2a, 6.11a, 7.2a, 8.2a and 13.2a; Chapter 4 now grants Quest #03 at the start and requires it '
    'completed before Chapter 5 (which opens with Dahlia’s execution). Page references are not yet updated. '
    'This booklet is split into Chapter 3 (town visit), Chapter 4 (town visit) and Quests #03 and up (all quest pages).'))

# ------------------------------------------------------------- split
body_start = x.index('<w:body>') + len('<w:body>')
sect = x.rindex('<w:sectPr')
body = x[body_start:sect]

def children(b):
    out, pos = [], 0
    pat = re.compile(r'<w:(p|tbl|sdt)[ >]')
    while pos < len(b):
        m = pat.search(b, pos)
        if not m:
            break
        tag = m.group(1)
        depth, j = 0, m.start()
        opener = re.compile(rf'<w:{tag}[ >]|</w:{tag}>')
        for mm in opener.finditer(b, m.start()):
            depth += 1 if not mm.group(0).startswith('</') else -1
            if depth == 0:
                j = mm.end(); break
        out.append(b[m.start():j]); pos = j
    return out

kids = children(body)
assert ''.join(kids).count('<w:t') == body.count('<w:t'), 'child split lost text'
def kid_idx(text):
    for k, c in enumerate(kids):
        if text in unesc(text_of(c)):
            return k
    raise SystemExit(text)
k_ch3 = kid_idx('THE MEMORIAL FESTIVAL')       # title page before CHAPTER 3
k_ch4 = kid_idx('CHAPTER 4: THE PASSING OF THE TORCH')
k_q = kid_idx('QUEST #03: XAVIER’S REQUEST')
notes, ch3, ch4, quests = kids[:k_ch3], kids[k_ch3:k_ch4], kids[k_ch4:k_q], kids[k_q:]
head, tail = x[:body_start], x[sect:]
open(out3, 'w', encoding='utf-8', newline='').write(head + ''.join(notes + ch3) + tail)
open(out4, 'w', encoding='utf-8', newline='').write(head + ''.join(notes + ch4) + tail)
# Quests #3+ get their own booklet. Page 1 is a title page (a right-hand,
# odd page) so the first wave page lands on page 2: every wave is an
# even (wave) + odd (resolutions) spread.
title_tpl = next(c for c in kids if 'CHAPTER 3: THE MEMORIAL FESTIVAL' in unesc(text_of(c)))
title = retext(title_tpl, 'RISING TIDE - QUESTS #03 AND UP', highlight=False)
sub = retext(notes[1], 'Quest pages for Chapters 3 and up. Each wave is a two-page spread: the wave on the left (even) page, its End of Wave entries on the right (odd) page.', highlight=False)
page_break = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
open(out_q, 'w', encoding='utf-8', newline='').write(head + title + sub + page_break + ''.join(quests) + tail)
print('split: notes', len(notes), 'ch3', len(ch3), 'ch4', len(ch4), 'quests', len(quests))
