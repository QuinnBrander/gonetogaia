"""Memory Fragment card images #2-#10 (fronts + backs) for public/memory-cards/.

#6-#10 are the prototype placeholder cards in "Game Materials - All - Nov 15.pdf"
(fronts page 45, backs page 46; crop them with scripts/extractGameMaterials.py).
#3-#5 have no card in the PDF yet, so this draws placeholder cards in the same
layout from the Game Materials workbook text. Replace them when the art lands.

Usage: python -I scripts/buildMemoryFragments.py <extractGameMaterials outdir> <G2G root>
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

CROPS = Path(sys.argv[1])
OUT = Path(sys.argv[2]) / "public" / "memory-cards"
W, H = 961, 693

# Workbook "Memory Fragment Front" reward + "Memory Fragment Back" ability.
TEXT = {
    3: ("Once per quest ability improved! See back of card.", "Witness deals 2 damage to adjacent enemies OR heals 1 HP to adjacent delvers"),
    4: ("Gain Quest #11: The Tablet", "Witness deals 2 damage to adjacent enemies OR heals 1 HP to adjacent delvers"),
    5: ("Once per quest ability improved! See back of card.", "Witness deals 4 damage to adjacent enemies OR heals 2 HP to adjacent delvers"),
}
# PDF crops: fronts in reading order; backs are mirrored per row for duplex printing.
# #2's printed effect changed (graphic-design card: "1 damage when Witness
# collects a Minion Part"), so it uses the prototype card too (page 43/44).
PDF_FRONTS = {2: "p43_16.png", 6: "p45_00.png", 7: "p45_01.png", 8: "p45_02.png", 9: "p45_03.png", 10: "p45_04.png"}
PDF_BACKS = {2: "p44_12.png", 6: "p46_02.png", 7: "p46_01.png", 8: "p46_00.png", 9: "p46_04.png", 10: "p46_03.png"}


def font(size, italic=False, bold=False):
    name = "arialbi.ttf" if (italic and bold) else "ariali.ttf" if italic else "arialbd.ttf" if bold else "arial.ttf"
    return ImageFont.truetype(str(Path("C:/Windows/Fonts") / name), size)


def wrap(draw, text, f, width):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=f) <= width:
            cur = t
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    return lines


def card():
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((6, 6, W - 7, H - 7), radius=36, outline="black", width=12)
    return img, d


def front(n, reward):
    img, d = card()
    d.text((30, 26), f"Memory Fragment #{n}", font=font(30), fill="black")
    # Picture frame placeholder: sun + mountains, like the prototype cards.
    x0, y0, x1, y1 = 200, 110, 760, 470
    d.rectangle((x0, y0, x1, y1), outline=(78, 78, 78), width=10)
    d.ellipse((450, 150, 510, 210), fill=(78, 78, 78))
    d.polygon([(x0 + 10, y1 - 5), (330, 330), (430, 330), (500, 400), (590, 330), (x1 - 10, y1 - 5)], fill=(78, 78, 78))
    for i, line in enumerate(wrap(d, "Art not ready yet.", font(30, italic=True), 480)):
        d.text((240, 230 + i * 38), line, font=font(30, italic=True), fill="black")
    d.text((W // 2, 560), "REWARD:", font=font(32), fill="black", anchor="mm")
    for i, line in enumerate(wrap(d, reward, font(32), W - 80)):
        d.text((W // 2, 615 + i * 40), line, font=font(32), fill="black", anchor="mm")
    return img


def back(n, ability):
    img, d = card()
    d.text((W // 2, 250), f"Memory Fragment #{n}", font=font(48), fill="black", anchor="mm")
    d.text((40, 440), "Once per quest free action:", font=font(30, bold=True), fill="black")
    for i, line in enumerate(wrap(d, ability, font(30), W - 80)):
        d.text((40, 478 + i * 36), line, font=font(30), fill="black")
    return img


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for n, (reward, ability) in TEXT.items():
        front(n, reward).save(OUT / f"memory_{n:02d}.jpg", quality=92)
        back(n, ability).save(OUT / f"memory_{n:02d}_back.jpg", quality=92)
    for n in PDF_FRONTS:
        Image.open(CROPS / PDF_FRONTS[n]).convert("RGB").save(OUT / f"memory_{n:02d}.jpg", quality=92)
        Image.open(CROPS / PDF_BACKS[n]).convert("RGB").save(OUT / f"memory_{n:02d}_back.jpg", quality=92)
    print("memory fragments #2-#10 written to", OUT)


if __name__ == "__main__":
    main()
