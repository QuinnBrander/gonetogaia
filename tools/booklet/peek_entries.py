"""Print each storybook-choice moment's continue entry from a booklet
document.xml, and whether its split sentence is found. Usage:
python -I peek_entries.py <document.xml>"""
import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from storybookChoices import MOMENTS  # noqa: E402

x = open(sys.argv[1], encoding='utf-8').read()
ms = list(re.finditer(r'<w:p[ >].*?</w:p>', x, flags=re.S))
T = [''.join(re.findall(r'<w:t[^>]*>([^<]*)</w:t>', m.group(0))) for m in ms]

def norm(s):
    return s.replace('’', "'").replace('“', '"').replace('”', '"').replace('…', '...')

def entry_for(q, w):
    """Entry id the wave's CONTINUE row points at."""
    hdr = [i for i, t in enumerate(T) if t.startswith(f'QUEST #{q:02d}:')]
    for h in hdr:
        if T[h + 1].strip().startswith(f'WAVE {w}'):
            for k in range(h, h + 200):
                if T[k].strip() == 'CONTINUE':
                    m = re.search(r'Go to entry ([\d.]+)', T[k + 1])
                    return m.group(1)
    return None

for m in MOMENTS:
    e = entry_for(m['quest'], m['wave'])
    i = next(k for k, t in enumerate(T) if t.strip() == e)
    j = next(k for k in range(i + 1, len(T)) if T[k].startswith('____') or re.match(r'^\d+\.\d+a?$', T[k].strip()))
    body = [t for t in T[i + 1:j] if t.strip()]
    split = m.get('split')
    found = any(split and norm(split)[:25] in norm(t) for t in body) if split else None
    print(f"== Q{m['quest']} W{m['wave']} -> {e}  split={split!r} found={found}")
    for t in body:
        print('   |', t[:150])
