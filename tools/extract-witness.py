"""
Ad-hoc extractor for the Witness Reference card art.

Pulls the single-page `Witness Reference v2 PROOF 1.pdf` proof and
writes it to `games/G2G/public/cards/witness_reference.jpg` so the
in-game Q2 spawn-pick tray (and any future Witness inspector UI)
can render the printed card alongside the W token.

Run once from the repo root:
    py -3 games/G2G/tools/extract-witness.py
"""

from pathlib import Path

import pypdfium2 as pdfium

REPO_ROOT = Path(__file__).resolve().parents[3]
ASSETS = REPO_ROOT / "ASSETS" / "Gone to Gaia"
OUT = REPO_ROOT / "games" / "G2G" / "public" / "cards"
OUT.mkdir(parents=True, exist_ok=True)

WITNESS_PDF = ASSETS / "Witness Reference v2 PROOF 1.pdf"


def render_page(pdf_path: Path, page_index_0: int, out_path: Path, scale: float = 3.0) -> None:
    doc = pdfium.PdfDocument(str(pdf_path))
    try:
        page = doc.get_page(page_index_0)
        bitmap = page.render(scale=scale)
        pil = bitmap.to_pil()
        # Match the quality settings used for enemy card art (~243 KB
        # @ q85) so the Witness tile blends in with the rest of the
        # `/public/cards/` set when the UI shows them side-by-side.
        pil.convert("RGB").save(out_path, "JPEG", quality=85)
        print(f"  wrote {out_path.name}  ({out_path.stat().st_size // 1024} KB)")
    finally:
        doc.close()


def main() -> None:
    # Proof ships as a 2-page PDF: page 1 is the card FRONT, page 2
    # is the card BACK. We only need the front for the in-game tile
    # render; the back is left in the proof for print pipeline use.
    with pdfium.PdfDocument(str(WITNESS_PDF)) as doc:
        if len(doc) != 2:
            raise SystemExit(
                f"Witness PDF page count is {len(doc)}; expected 2. "
                "The proof shape may have shifted - re-verify before "
                "running this script."
            )
    print("Witness Reference card (front):")
    out = OUT / "witness_reference.jpg"
    render_page(WITNESS_PDF, 0, out)
    print("\nDone.")


if __name__ == "__main__":
    main()
