"""Make every quest wave a two-page spread in the Quests #3+ booklet.

Usage: python -I spreads.py <in document.xml> <out document.xml> [img_scale] [entry_sz]

Layout authority is Google Docs, which ignores Word's odd/even section
breaks, so this uses plain page breaks and relies on every wave being
exactly two pages:
- an inline page break at the start of each wave header ("QUEST #NN: ...")
  -> the wave page;
- an inline page break at the start of the wave's first entry heading
  (e.g. "3.1") -> the End of Wave entries on the facing page;
- empty spacer paragraphs right before those breaks are removed;
- shrink to fit: wave-page images scaled by img_scale (default 0.8), and
  resolution-page body text set to entry_sz half-points (default 22 = 11pt)
  where it was the 12pt default.
"""
import re, sys

src, dst = sys.argv[1], sys.argv[2]
IMG = float(sys.argv[3]) if len(sys.argv) > 3 else 0.8
ESZ = sys.argv[4] if len(sys.argv) > 4 else '22'
x = open(src, encoding='utf-8').read()
b0 = x.index('<w:body>') + len('<w:body>')
sect_at = x.rindex('<w:sectPr')
body, tail = x[b0:sect_at], x[sect_at:]

def children(b):
    out, pos = [], 0
    pat = re.compile(r'<w:(p|tbl|sdt)[ >]')
    while True:
        m = pat.search(b, pos)
        if not m:
            return out
        tag, depth = m.group(1), 0
        for mm in re.finditer(rf'<w:{tag}[ >]|</w:{tag}>', b[m.start():]):
            depth += -1 if mm.group(0).startswith('</') else 1
            if depth == 0:
                end = m.start() + mm.end(); break
        out.append(b[m.start():end]); pos = end

def text(c):
    return ''.join(re.findall(r'<w:t[^>]*>([^<]*)</w:t>', c))

def is_blank(c):
    return (c.startswith('<w:p') and not text(c).strip()
            and not re.search(r'<w:drawing|<w:pict|mc:AlternateContent|<w:br |<w:sectPr|<w:object', c))

def page_break_first(p):
    """Put an inline page break at the very start of paragraph p."""
    p = re.sub(r'<w:pageBreakBefore[^>]*/>', '', p)
    m = re.match(r'<w:p[^>]*>(<w:pPr>.*?</w:pPr>)?', p, re.S)
    return p[:m.end()] + '<w:r><w:br w:type="page"/></w:r>' + p[m.end():]

def scale_images(c):
    def sc(m):
        return f'{m.group(1)}cx="{int(int(m.group(2)) * IMG)}" cy="{int(int(m.group(3)) * IMG)}"'
    return re.sub(r'(<(?:wp:extent|a:ext) )cx="(\d+)" cy="(\d+)"', sc, c)

_AFTER_SZ = ('<w:szCs', '<w:highlight', '<w:u ', '<w:u>', '<w:effect', '<w:bdr', '<w:shd', '<w:fitText',
             '<w:vertAlign', '<w:rtl', '<w:cs', '<w:em ', '<w:lang', '<w:eastAsianLayout', '<w:specVanish', '<w:oMath')

def set_size(run):
    if '<w:t' not in run:
        return run
    if re.search(r'<w:sz w:val="(?!24")\d+"/>', run):
        return run                      # explicit non-default size (headings): keep
    run = re.sub(r'<w:sz w:val="24"/>', '', run)
    run = re.sub(r'<w:szCs w:val="24"/>', '', run)
    m = re.match(r'<w:r>(<w:rPr/>|<w:rPr>(.*?)</w:rPr>)', run, re.S)
    new = f'<w:sz w:val="{ESZ}"/><w:szCs w:val="{ESZ}"/>'
    if not m or m.group(1) == '<w:rPr/>':
        rest = run[m.end():] if m else run[len('<w:r>'):]
        return '<w:r><w:rPr>' + new + '</w:rPr>' + rest
    inner = m.group(2)
    cut = min([inner.find(t) for t in _AFTER_SZ if inner.find(t) >= 0] or [len(inner)])
    return '<w:r><w:rPr>' + inner[:cut] + new + inner[cut:] + '</w:rPr>' + run[m.end():]

OPT_TEXT_COL = 6600   # dxa (~4.6in) for the options box's text column

def widen_options(t):
    """Widen the options box's text column (letter column unchanged)."""
    cols = [int(float(v)) for v in re.findall(r'<w:gridCol w:w="([\d.]+)"/>', t)[:2]]
    if len(cols) < 2:
        return t
    letter, old = cols
    total = letter + OPT_TEXT_COL
    t = re.sub(r'(<w:tblGrid>)<w:gridCol w:w="[\d.]+"/><w:gridCol w:w="[\d.]+"/>',
               rf'\1<w:gridCol w:w="{letter}"/><w:gridCol w:w="{OPT_TEXT_COL}"/>', t, count=1)
    t = re.sub(r'(<w:tblGridChange w:id="\d+"><w:tblGrid>)<w:gridCol w:w="[\d.]+"/><w:gridCol w:w="[\d.]+"/>',
               rf'\1<w:gridCol w:w="{letter}"/><w:gridCol w:w="{OPT_TEXT_COL}"/>', t, count=1)
    t = re.sub(r'<w:tblW w:w="[\d.]+" w:type="dxa"/>', f'<w:tblW w:w="{total}" w:type="dxa"/>', t, count=1)
    t = re.sub(rf'<w:tcW w:w="{old}(?:\.0)?" w:type="dxa"/>', f'<w:tcW w:w="{OPT_TEXT_COL}" w:type="dxa"/>', t)
    return t

def small_blank(p):
    """A spacer (empty) paragraph whose line is 6pt: set its paragraph-mark
    size, drop paragraph spacing before/after."""
    p = re.sub(r'<w:spacing [^>]*/>', '', p)
    mark = '<w:rPr><w:sz w:val="12"/><w:szCs w:val="12"/></w:rPr>'
    if '<w:pPr>' not in p:
        return re.sub(r'^(<w:p[^>]*>)', r'\1<w:pPr>' + mark + '</w:pPr>', p)
    pPr = re.search(r'<w:pPr>.*?</w:pPr>', p, re.S).group(0)
    inner = pPr[len('<w:pPr>'):-len('</w:pPr>')]
    inner = re.sub(r'<w:rPr>.*?</w:rPr>|<w:rPr/>', '', inner, flags=re.S)
    # rPr is the last child of pPr apart from sectPr / pPrChange
    cut = min([inner.find(t) for t in ('<w:sectPr', '<w:pPrChange') if inner.find(t) >= 0] or [len(inner)])
    return p.replace(pPr, '<w:pPr>' + inner[:cut] + mark + inner[cut:] + '</w:pPr>', 1)

def shrink_text(c):
    return re.sub(r'<w:r>(?:(?!</w:r>).)*?</w:r>', lambda m: set_size(m.group(0)), c, flags=re.S)

kids = children(body)
assert ''.join(kids).count('<w:t') == body.count('<w:t')

headers = [i for i, c in enumerate(kids) if c.startswith('<w:p') and re.match(r'QUEST #\d+', text(c))
           and any(re.match(r'WAVE \d', text(kids[k])) for k in range(i + 1, min(i + 4, len(kids))))]
firsts = {}
for n, h in enumerate(headers):
    stop = headers[n + 1] if n + 1 < len(headers) else len(kids)
    f = next((k for k in range(h + 1, stop) if kids[k].startswith('<w:p')
              and re.match(r'^\d{1,2}\.\d{1,2}a?$', text(kids[k]).strip())), None)
    if f is not None:
        firsts[h] = (f, stop)

wave_page, entry_page = set(), set()
for h, (f, stop) in firsts.items():
    wave_page.update(range(h, f))
    entry_page.update(range(f, stop))

drop = set()
for i in sorted(set(headers) | {f for f, _ in firsts.values()}):
    k = i - 1
    while k >= 0 and is_blank(kids[k]):
        drop.add(k); k -= 1

# Unneeded empty lines (owner, 2026-11-17).
# - Resolution pages: nothing floats there, so collapse every run of blank
#   paragraphs to a single one.
# - Wave pages: blank lines reserve the space under floating objects (enemy
#   cards, ability / death / options boxes), so keep them - except the block
#   under the enemy-card row, which shrinks with the cards.
prev_blank = False
for i in sorted(entry_page):
    if i in drop:
        continue
    b = is_blank(kids[i])
    if b and prev_blank:
        drop.add(i)
    prev_blank = b
for h, (f, _) in firsts.items():
    card = next((k for k in range(h, f) if '<wp:anchor' in kids[k]), None)
    if card is None:
        continue
    run = []
    k = card + 1
    while k < f and is_blank(kids[k]):
        run.append(k); k += 1
    # The cards shrink by (1 - IMG); the measured gap under them left room
    # for two more lines on top of that.
    for k in run[:min(len(run) - 1, round(len(run) * (1 - IMG)) + 2)]:
        drop.add(k)
    # Blank lines just above the options box reserved room for it while it
    # floated; it's inline now, so they're unneeded.
    opt = next((k for k in range(h, f) if kids[k].startswith('<w:tbl') and re.search(r'CONTINUE|RETREAT', text(kids[k]))), None)
    if opt is not None:
        k = opt - 1
        while k > h and is_blank(kids[k]):
            drop.add(k); k -= 1

# The last divider line on each resolution page separates nothing (the page
# ends there) - drop it and the blank before it.
for h, (f, stop) in firsts.items():
    last_div = next((k for k in range(stop - 1, f, -1) if kids[k].startswith('<w:p')
                     and re.match(r'^_{10,}$', text(kids[k]).strip())), None)
    if last_div is not None and all(is_blank(kids[k]) or k in drop for k in range(last_div + 1, stop)):
        drop.add(last_div)
        k = last_div - 1
        while k > f and is_blank(kids[k]):
            drop.add(k); k -= 1

breaks = set(headers) | {f for f, _ in firsts.values()}

# Non-wave blocks with an odd page count shift every later spread by one
# page. The Quest #07 Conclusion + Secret Town Visit block runs 7 pages, so
# Quest #08's first wave gets a blank page before it (owner, 2026-11-17).
PAD_BEFORE_QUESTS = ('QUEST #08',)
pad_before = {headers[next(n for n, h in enumerate(headers) if text(kids[h]).startswith(q))]
              for q in PAD_BEFORE_QUESTS}
breaks.discard(headers[0])            # the title page already ends with a page break
out = []
for i, c in enumerate(kids):
    if i in drop:
        continue
    if i in wave_page:
        # Keep the floating (text-wrapped) boxes: Google Docs supports them and
        # the wave pages were laid out there. Word places floats differently,
        # so Word page counts are only trusted for the resolution pages.
        c = scale_images(c)
        # The End of Wave options box (A CONTINUE / B RETREAT ...) is the last
        # thing on the page, so it can sit inline under "Choose 1 option".
        # As a floating table Word kept moving it alone onto the next page.
        if c.startswith('<w:tbl') and re.search(r'CONTINUE|RETREAT', text(c)):
            c = re.sub(r'<w:tblpPr [^>]*/>', '', c)
            c = re.sub(r'<w:trHeight [^>]*/>', '', c)     # rows fit their text
            c = widen_options(c)                            # fewer wrapped lines
            c = shrink_text(c)                              # 11pt option text
    if i in entry_page:
        if is_blank(c):
            c = small_blank(c)   # spacer lines: 6pt instead of heading-sized
        c = shrink_text(c)
        c = scale_images(c)   # pictures beside entries: text wraps on a wider line
    if i in pad_before:
        # a blank page so this quest starts on an even (left) page again
        out.append('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
    if i in breaks:
        # Word anchors a floating table (the options box) to the paragraph
        # AFTER it; if that paragraph starts with the page break, the box
        # follows it onto the next page. Give the box its own anchor line.
        if out and out[-1].startswith('<w:tbl'):
            out.append('<w:p><w:pPr><w:rPr><w:sz w:val="12"/><w:szCs w:val="12"/></w:rPr></w:pPr></w:p>')
        c = page_break_first(c)
    out.append(c)

open(dst, 'w', encoding='utf-8', newline='').write(x[:b0] + ''.join(out) + tail)
print(f'waves {len(headers)}, with entries {len(firsts)}, page breaks {len(breaks)}, spacers removed {len(drop)}, img x{IMG}, entry sz {ESZ}')
