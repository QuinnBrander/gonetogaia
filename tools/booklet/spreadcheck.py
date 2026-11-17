import re,sys
sys.stdout.reconfigure(encoding='utf-8')
rows=[]
for l in open(sys.argv[1],encoding='utf-8-sig').read().splitlines():
    if '\t' in l and l.split('\t')[0].isdigit():
        p,t=l.split('\t',1); rows.append((int(p),t))
out=[];cur=None;q=None
for p,t in rows:
    if t.startswith('LAST '):
        if cur: cur['last']=p
        continue
    m=re.match(r'QUEST #(\d+)',t)
    if m:
        if cur: out.append(cur)
        q=m.group(1); cur=None; continue
    m=re.match(r'WAVE (\d)',t)
    if m: cur={'q':q,'w':m.group(1),'wave':p,'box':[],'first':None,'last':None}; continue
    if cur is None: continue
    if t.startswith(('END OF WAVE','IF ONE OR BOTH')): cur['box'].append(p)
    if re.match(r'^\d{1,2}\.\d{1,2}a?$',t) and cur['first'] is None: cur['first']=p
if cur: out.append(cur)
ok=0
for w in out:
    probs=[]
    if w['wave']%2: probs.append('wave on odd page')
    if w['first'] and w['first']!=w['wave']+1: probs.append(f"entries start p{w['first']} (wave page runs long)")
    if w['first'] and w['last'] and w['last']>w['first']: probs.append(f"entries spill to p{w['last']}")
    if probs: print(f"Q{w['q']} W{w['w']} wave p{w['wave']}: "+'; '.join(probs))
    else: ok+=1
print(f'{ok}/{len(out)} waves are clean spreads')
