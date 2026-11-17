/**
 * Extract individual Memory card images from the printed Gone to Gaia
 * `Memory Card Fronts v2 PROOF 1.pdf`.
 *
 * The PDF has 2 single-card pages laid out front-only:
 *   - Page 1: Memory #01 ("REWARD: Gain Quest #10: A Glimpse of the Past.")
 *   - Page 2: Memory #02 ("UPGRADE: Whenever Witness collects a Minion
 *             Part, he deals 1 damage to all adjacent enemies.")
 *
 * Cards are granted by the Ch2 Machinist "Witness records a memory"
 * pages — spending Memory Chip Tokens draws N Memory cards (1:1).
 * The current deck only has 2 distinct cards; the engine draws WITH
 * replacement so a player with 3+ chips can collect duplicates of
 * the same printed face.
 *
 * Run with: node scripts/extractMemoryCardImages.mjs
 *
 * Mirrors the existing `extractLevelUpCardImages.mjs` setup (same
 * mupdf usage, same JPEG quality) so the output visually matches
 * the existing card library.
 */

import * as mupdf from "mupdf";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ASSETS_DIR = resolve(ROOT, "../../ASSETS/Gone to Gaia");
const OUT_DIR = resolve(ROOT, "public/memory-cards");
const SOURCE_PDF = "Memory Card Fronts v2 PROOF 1.pdf";

// Source page is ~250x179 at 1x; 4x lands us at ~999x716 — sharp
// enough that the printed "MEMORY #NN" header and the REWARD /
// UPGRADE callout stay legible in the rewards modal thumbnail
// (~360px wide) without looking pixelated when scaled up.
const RENDER_SCALE = 4;
const JPEG_QUALITY = 85;

const CARDS_TO_EXTRACT = [1, 2];

async function extractOne(doc, cardNumber) {
  const pageIndex = cardNumber - 1;
  const totalPages = doc.countPages();
  if (pageIndex < 0 || pageIndex >= totalPages) {
    throw new Error(`Card ${cardNumber} (page ${pageIndex}) out of range — PDF has ${totalPages} pages`);
  }
  const page = doc.loadPage(pageIndex);
  const matrix = mupdf.Matrix.scale(RENDER_SCALE, RENDER_SCALE);
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
  const jpegBytes = pixmap.asJPEG(JPEG_QUALITY, false);
  const fileName = `memory_${String(cardNumber).padStart(2, "0")}.jpg`;
  const outPath = resolve(OUT_DIR, fileName);
  await writeFile(outPath, jpegBytes);
  const sizeKb = (jpegBytes.length / 1024).toFixed(1);
  console.log(`  wrote ${fileName.padEnd(18)} (${pixmap.getWidth()}x${pixmap.getHeight()}, ${sizeKb} KB)  <- page ${cardNumber} of ${totalPages}`);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const srcPath = resolve(ASSETS_DIR, SOURCE_PDF);
  const bytes = await readFile(srcPath);
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  console.log(`Source: ${srcPath}`);
  console.log(`Output: ${OUT_DIR}`);
  console.log("");
  for (const n of CARDS_TO_EXTRACT) {
    await extractOne(doc, n);
  }
  console.log("");
  console.log(`Done — extracted ${CARDS_TO_EXTRACT.length} Memory card image(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
