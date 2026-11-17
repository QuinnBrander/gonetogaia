/**
 * Extract individual Level-Up card images from the printed Gone to Gaia
 * `Level Up Cards Front v2 PROOF 1.pdf`.
 *
 * The PDF has 32 single-card pages laid out front-only:
 *   - Pages 1..28 are BASE Level cards ("Gain +1 RANK in one of: A / B / C").
 *   - Pages 29..32 are ULTRA Level cards ("Gain +1 RANK for any PASSIVE
 *     equipment, OR Gain +2 RANKS in one of: A / B").
 *
 * Cards 1..28 were extracted in an earlier pass and live at
 * `public/levelup/levelup_NN.jpg` (NN = 01..28). This script extracts the
 * 4 Ultra pages (29..32) so they paint the correct printed Ultra art
 * inside the LevelUpModal + RewardsModal (previously the modals were
 * pointed at the OLD base-card art for those numbers, so the Ultra
 * gameplay payload didn't match what the player saw).
 *
 * Run with: node scripts/extractLevelUpCardImages.mjs
 *
 * Mirrors the existing `extractCardImages.mjs` setup (same mupdf usage,
 * same 2x scale, same JPEG quality) so the new images visually match the
 * existing card-image library.
 */

import * as mupdf from "mupdf";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ASSETS_DIR = resolve(ROOT, "../../ASSETS/Gone to Gaia");
const OUT_DIR = resolve(ROOT, "public/levelup");
const SOURCE_PDF = "Level Up Cards Front v2 PROOF 1.pdf";

// The level-up PDF source pages are physically smaller than the
// equipment-card PDF pages, so a flat 2x scale renders them at
// 233x358 instead of the ~356x546 the rest of the levelup library
// uses (cards 1..28). 3x lands us at ~349x537 — visually consistent
// with the existing library and keeps file sizes ~50 KB / card.
const RENDER_SCALE = 3;
const JPEG_QUALITY = 85;

// 1-based card numbers we want extracted on THIS run. Cards 1..28 are
// already on disk from a previous pass — re-extracting them would just
// rewrite identical bytes, so we narrow to the 4 Ultras. Add more numbers
// here if a future PDF rev changes the printed art.
const CARDS_TO_EXTRACT = [29, 30, 31, 32];

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
  const fileName = `levelup_${String(cardNumber).padStart(2, "0")}.jpg`;
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
  console.log(`Done — extracted ${CARDS_TO_EXTRACT.length} Ultra Level card image(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
