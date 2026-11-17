/**
 * Extract individual card images from the printed Gone to Gaia equipment PDFs.
 *
 * Each PDF has 70 single-card pages: Suit A (cards 001-070, body deck) and
 * Suit B (cards 071-140, mind deck). For our v1 starter loadouts we only
 * need 6 specific rank-1 cards. Drop more entries into CARDS_TO_EXTRACT
 * to extract additional ones (rank-2+ for level-ups, etc.).
 *
 * Run with: node scripts/extractCardImages.mjs
 */

import * as mupdf from "mupdf";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ASSETS_DIR = resolve(ROOT, "../../ASSETS/Gone to Gaia");
const CARDS_OUT = resolve(ROOT, "public/cards");

// 2x scale balances readability with reasonable file size for in-browser display.
const RENDER_SCALE = 2;
// JPEG quality 85 is the sweet spot used by every other card render in the project.
const JPEG_QUALITY = 85;

/** PDF basename → mupdf Document (cached on first open). */
const docCache = new Map();

async function loadPdf(filename) {
  if (docCache.has(filename)) return docCache.get(filename);
  const path = resolve(ASSETS_DIR, filename);
  const bytes = await readFile(path);
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  docCache.set(filename, doc);
  return doc;
}

/**
 * One job per output card. `pageIndex` is 0-based within the source PDF.
 * Card numbers are 1-based and printed on every card; pageIndex = cardNumber - 1
 * (Suit A starts at 001/page 0; Suit B starts at 071/page 0).
 */
const CARDS_TO_EXTRACT = [
  // --- Body deck (Suit A) ----------------------------------------------
  { pdf: "Equipment Card Front Suit A v5 PROOF 2.pdf", pageIndex: 0,  out: "card_body_gauntlet_r1.jpg", label: "001 Chain Gauntlet R1"   },
  { pdf: "Equipment Card Front Suit A v5 PROOF 2.pdf", pageIndex: 20, out: "card_body_sword_r1.jpg",    label: "021 Soulshift Sword R1" },
  { pdf: "Equipment Card Front Suit A v5 PROOF 2.pdf", pageIndex: 55, out: "card_body_armor_r1.jpg",    label: "056 Exoframe Armor R1"  },
  // --- Mind deck (Suit B) ----------------------------------------------
  { pdf: "Equipment Card Front Suit B v5 PROOF 2.pdf", pageIndex: 5,  out: "card_mind_hammer_r1.jpg",   label: "076 Crash Hammer R1"    },
  { pdf: "Equipment Card Front Suit B v5 PROOF 2.pdf", pageIndex: 10, out: "card_mind_beam_r1.jpg",     label: "081 Ion Cannon Beam R1" },
  { pdf: "Equipment Card Front Suit B v5 PROOF 2.pdf", pageIndex: 40, out: "card_mind_shield_r1.jpg",   label: "111 Sol Shield R1"      },
  // --- Mind deck — Web Shockwave (typo fix; ranks 1-5 from v4 PROOF 3) -
  // v4 PROOF 3 has the corrected attack-pattern artwork (3 N/E/S/W + 1
  // diagonal). Cards 101-105 → pageIndex 30-34 (Suit B starts at 071/p.0).
  { pdf: "Equipment Card Front Suit B v4 PROOF 3.pdf", pageIndex: 30, out: "card_mind_shockwave_r1.jpg", label: "101 North Web Shockwave R1" },
  { pdf: "Equipment Card Front Suit B v4 PROOF 3.pdf", pageIndex: 31, out: "card_mind_shockwave_r2.jpg", label: "102 North Web Shockwave R2" },
  { pdf: "Equipment Card Front Suit B v4 PROOF 3.pdf", pageIndex: 32, out: "card_mind_shockwave_r3.jpg", label: "103 North Web Shockwave R3" },
  { pdf: "Equipment Card Front Suit B v4 PROOF 3.pdf", pageIndex: 33, out: "card_mind_shockwave_r4.jpg", label: "104 North Web Shockwave R4" },
  { pdf: "Equipment Card Front Suit B v4 PROOF 3.pdf", pageIndex: 34, out: "card_mind_shockwave_r5.jpg", label: "105 North Web Shockwave R5" },
];

async function extractOne({ pdf, pageIndex, out, label }) {
  const doc = await loadPdf(pdf);
  const totalPages = doc.countPages();
  if (pageIndex < 0 || pageIndex >= totalPages) {
    throw new Error(`Page ${pageIndex} out of range for ${pdf} (${totalPages} pages)`);
  }
  const page = doc.loadPage(pageIndex);
  const matrix = mupdf.Matrix.scale(RENDER_SCALE, RENDER_SCALE);
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
  const jpegBytes = pixmap.asJPEG(JPEG_QUALITY, false);
  const outPath = resolve(CARDS_OUT, out);
  await writeFile(outPath, jpegBytes);
  const sizeKb = (jpegBytes.length / 1024).toFixed(1);
  console.log(`  wrote ${out.padEnd(32)} (${pixmap.getWidth()}x${pixmap.getHeight()}, ${sizeKb} KB)  <- ${label}`);
}

async function main() {
  await mkdir(CARDS_OUT, { recursive: true });
  console.log(`Source: ${ASSETS_DIR}`);
  console.log(`Output: ${CARDS_OUT}`);
  console.log("");
  for (const job of CARDS_TO_EXTRACT) {
    await extractOne(job);
  }
  console.log("");
  console.log(`Done — extracted ${CARDS_TO_EXTRACT.length} card image(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
