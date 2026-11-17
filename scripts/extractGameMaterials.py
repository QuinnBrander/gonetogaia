"""Crop every card out of the Dextrous print sheet ("Game Materials - All
- <date>.pdf") and label each crop from the PDF text inside it.

Each card on a page is a top-level form XObject, so its bounding box is the
card's exact outline. We render the page at 4x, crop every form object's box,
and read the PDF text inside it. Dextrous fakes bold by printing every
character twice ("KKEEYY IITTEEMM ##77"), so text is de-doubled.

Usage:
  python -I scripts/extractGameMaterials.py <pdf> <out dir>
Writes <out dir>/p<page>_<n>.png plus index.json:
  [{ "file", "page", "n", "size", "text" }]
"""
import json
import re
import sys
from pathlib import Path

import pypdfium2 as pdfium

PDF = sys.argv[1]
OUT = Path(sys.argv[2])
SCALE = 4


def dedouble(t):
    t = t.replace("\r", "").replace("\n", " ")
    pairs = sum(1 for i in range(0, len(t) - 1, 2) if t[i] == t[i + 1])
    return t[::2] if len(t) > 3 and pairs >= 0.6 * (len(t) // 2) else t


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    pdf = pdfium.PdfDocument(PDF)
    index = []
    for pno in range(len(pdf)):
        page = pdf[pno]
        pw, ph = page.get_size()
        boxes = []
        for obj in page.get_objects(max_depth=1):
            if obj.type != 5:  # FPDF_PAGEOBJ_FORM
                continue
            l, b, r, t = obj.get_bounds()
            if r - l > 40 and t - b > 40:
                boxes.append((l, b, r, t))
        if not boxes:
            print(f"page {pno + 1}: no cards")
            continue
        # Some form objects overflow their card (art or text bleeding past
        # the border), which inflates their bounds. Snap every box to the
        # page's standard card size, anchored on the nearest grid column /
        # row taken from the well-formed boxes.
        from collections import Counter
        size = Counter((round(r - l), round(t - b)) for l, b, r, t in boxes).most_common(1)[0][0]
        good = [bx for bx in boxes if (round(bx[2] - bx[0]), round(bx[3] - bx[1])) == size]
        lefts = sorted({round(bx[0], 1) for bx in good})
        tops = sorted({round(bx[3], 1) for bx in good})
        snapped = []
        for l, b, r, t in boxes:
            if (round(r - l), round(t - b)) != size:
                l = min(lefts, key=lambda g: abs(g - l) if l - 2 <= g <= r - size[0] + 2 else 1e9)
                t = min(tops, key=lambda g: abs(g - t) if b + size[1] - 2 <= g <= t + 2 else 1e9)
                r, b = l + size[0], t - size[1]
            snapped.append((l, b, r, t))
        boxes = snapped
        img = page.render(scale=SCALE).to_pil().convert("RGB")
        tp = page.get_textpage()
        boxes.sort(key=lambda bx: (-round(bx[3]), bx[0]))  # rows top-down, then left-right
        for n, (l, b, r, t) in enumerate(boxes):
            crop = img.crop((round(l * SCALE), round((ph - t) * SCALE), round(r * SCALE), round((ph - b) * SCALE)))
            text = tp.get_text_bounded(left=l, right=r, top=t, bottom=b)
            text = " | ".join(dedouble(line) for line in text.splitlines() if line.strip())
            name = f"p{pno + 1:02d}_{n:02d}.png"
            crop.save(OUT / name)
            index.append({"file": name, "page": pno + 1, "n": n, "size": [crop.width, crop.height], "text": text})
        print(f"page {pno + 1}: {len(boxes)} cards")
    (OUT / "index.json").write_text(json.dumps(index, indent=1, ensure_ascii=False), encoding="utf8")


if __name__ == "__main__":
    main()
