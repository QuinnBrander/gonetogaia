"""
Ad-hoc text extractor for the Chapter 2 storybook PDF.

Pulls page-by-page text from
`ASSETS/Gone to Gaia/Gone to Gaia - Storybook - Chapter 2 PROOF 4.pdf`
and prints it with page separators so we can copy the right
chunks into `data/chapter2.json`.

Run once from the repo root:
    py -3 games/G2G/tools/extract-ch2-text.py
"""

import sys
from pathlib import Path

import pypdfium2 as pdfium

# Windows terminals default to cp1252; force UTF-8 so the smart-
# quotes / curly apostrophes / em-dashes in the storybook PDF don't
# blow up the print loop.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO_ROOT = Path(__file__).resolve().parents[3]
ASSETS = REPO_ROOT / "ASSETS" / "Gone to Gaia"
PDF = ASSETS / "Gone to Gaia - Storybook - Chapter 2 PROOF 4.pdf"


def main() -> None:
    if not PDF.exists():
        raise SystemExit(f"PDF not found: {PDF}")
    doc = pdfium.PdfDocument(str(PDF))
    try:
        print(f"Chapter 2 storybook  {len(doc)} pages")
        for i in range(len(doc)):
            page = doc.get_page(i)
            textpage = page.get_textpage()
            text = textpage.get_text_bounded()
            print(f"\n\n======== PAGE {i + 1} ========\n")
            print(text)
    finally:
        doc.close()


if __name__ == "__main__":
    main()
