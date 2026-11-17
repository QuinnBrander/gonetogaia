"""
Ad-hoc extractor for Quest #2 enemy card art.

Pulls Venena (#008-014), Ophidian (#015-021), and Sporecloud
(#022-028) from the Minion Monster Cards PDF and Goldmonger (#002),
Hundredeyes (#003), Death Cap (#004) from the Boss Monster Cards
PDF, writing them into `games/G2G/public/cards/` under the same
`enemy_{family}_{NNN}.jpg` convention as the Q1 Crystanid +
Soulhunter art.

Run once from the repo root:
    py -3 games/G2G/tools/extract-q2-enemies.py

Page numbering (1-indexed) inside each printed proof — confirmed
2026-05-18 by cross-referencing the printed `XXX/028` card numbers
with the family ordering Quest #2 calls out:

    Minion Monster Cards Front v3 PROOF 1.pdf
        pages 1..7   -> Crystanid   #001..#007   (already extracted)
        pages 8..14  -> Venena      #008..#014   (Q2 Wave 1)
        pages 15..21 -> Ophidian    #015..#021   (Q2 Wave 2)
        pages 22..28 -> Sporecloud  #022..#028   (Q2 Wave 3)

    Boss Monster Cards Front v2 PROOF 1.pdf
        page 1 -> Soulhunter #001  (already extracted)
        page 2 -> Goldmonger #002  (Q2 Wave 1 boss)
        page 3 -> Hundredeyes #003 (Q2 Wave 2 boss)
        page 4 -> Death Cap  #004  (Q2 Wave 3 boss)

If the PDF's page count changes (a future proof reorders families),
this script will print a loud warning and bail before writing —
we'd rather fail fast than silently dump the wrong art at the
wrong filename.
"""

from pathlib import Path

import pypdfium2 as pdfium

REPO_ROOT = Path(__file__).resolve().parents[3]
ASSETS = REPO_ROOT / "ASSETS" / "Gone to Gaia"
OUT = REPO_ROOT / "games" / "G2G" / "public" / "cards"
OUT.mkdir(parents=True, exist_ok=True)

MINION_PDF = ASSETS / "Minion Monster Cards 80x80mm Front v3 PROOF 1.pdf"
BOSS_PDF = ASSETS / "Boss Monster Cards 80x80mm Front v2 PROOF 1.pdf"


def render_page(pdf_path: Path, page_index_0: int, out_path: Path, scale: float = 3.0) -> None:
    """Render one PDF page to a JPEG at `scale` * 72 DPI."""
    doc = pdfium.PdfDocument(str(pdf_path))
    try:
        page = doc.get_page(page_index_0)
        bitmap = page.render(scale=scale)
        pil = bitmap.to_pil()
        # Match the Q1 Crystanid extracted JPEGs (~243 KB at quality 85).
        pil.convert("RGB").save(out_path, "JPEG", quality=85)
        print(f"  wrote {out_path.name}  ({out_path.stat().st_size // 1024} KB)")
    finally:
        doc.close()


def main() -> None:
    # Minions: pages 8..14 (1-indexed) = page indices 7..13 (0-indexed).
    with pdfium.PdfDocument(str(MINION_PDF)) as doc:
        if len(doc) != 28:
            raise SystemExit(
                f"Minion PDF page count is {len(doc)}; expected 28. "
                "The card ordering may have shifted — re-verify before "
                "running this script."
            )

    print("Venena (#008..#014):")
    for card_num in range(8, 15):
        page_idx_0 = card_num - 1  # 1-indexed -> 0-indexed
        out = OUT / f"enemy_venena_{card_num:03d}.jpg"
        render_page(MINION_PDF, page_idx_0, out)

    print("Ophidian (#015..#021):")
    for card_num in range(15, 22):
        page_idx_0 = card_num - 1  # 1-indexed -> 0-indexed
        out = OUT / f"enemy_ophidian_{card_num:03d}.jpg"
        render_page(MINION_PDF, page_idx_0, out)

    print("Sporecloud (#022..#028):")
    for card_num in range(22, 29):
        page_idx_0 = card_num - 1  # 1-indexed -> 0-indexed
        out = OUT / f"enemy_sporecloud_{card_num:03d}.jpg"
        render_page(MINION_PDF, page_idx_0, out)

    # Bosses: page 2 (1-indexed) = page index 1 (0-indexed).
    with pdfium.PdfDocument(str(BOSS_PDF)) as doc:
        if len(doc) != 4:
            raise SystemExit(
                f"Boss PDF page count is {len(doc)}; expected 4. "
                "The card ordering may have shifted — re-verify before "
                "running this script."
            )

    print("Goldmonger (#002):")
    out = OUT / "enemy_goldmonger_002.jpg"
    render_page(BOSS_PDF, 1, out)

    print("Hundredeyes (#003):")
    out = OUT / "enemy_hundredeyes_003.jpg"
    render_page(BOSS_PDF, 2, out)

    print("Death Cap (#004):")
    out = OUT / "enemy_deathcap_004.jpg"
    render_page(BOSS_PDF, 3, out)

    print("\nDone.")


if __name__ == "__main__":
    main()
