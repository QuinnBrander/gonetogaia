/**
 * Extract every page of the printed Gone to Gaia rulebook as a
 * JPEG so the in-app Rules Viewer modal can render them like a
 * flipbook.
 *
 * Source : `ASSETS/Gone to Gaia/Gone to Gaia - Rulebook - 8.5x11 v1 PROOF 6.pdf`
 * Output : `public/rulebook/rulebook-page-NN.jpg`
 *
 * Run with: `node scripts/extractRulebookPages.mjs`
 *
 * Renders at 2x scale (rulebook is 8.5x11 so 2x is plenty for a
 * full-screen modal; bumping to 3x triples the file size for
 * little perceived gain). JPEG quality 80 keeps the average page
 * around 250 KB.
 */

import * as mupdf from "mupdf";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ASSETS_DIR = resolve(ROOT, "../../ASSETS/Gone to Gaia");
const OUT_DIR = resolve(ROOT, "public/rulebook");
const PDF_NAME = "Gone to Gaia - Rulebook - 8.5x11 v1 PROOF 6.pdf";

const RENDER_SCALE = 2;
const JPEG_QUALITY = 80;

async function extractImage(doc, pageIndex, outName, totalPages) {
  const page = doc.loadPage(pageIndex);
  const matrix = mupdf.Matrix.scale(RENDER_SCALE, RENDER_SCALE);
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
  const jpegBytes = pixmap.asJPEG(JPEG_QUALITY, false);
  const outPath = resolve(OUT_DIR, outName);
  await writeFile(outPath, jpegBytes);
  const sizeKb = (jpegBytes.length / 1024).toFixed(1);
  console.log(
    `  wrote ${outName.padEnd(28)} (${pixmap.getWidth()}x${pixmap.getHeight()}, ${sizeKb} KB)  <- page ${pageIndex + 1} of ${totalPages}`,
  );
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const pdfPath = resolve(ASSETS_DIR, PDF_NAME);
  const pdfBytes = await readFile(pdfPath);
  const doc = mupdf.Document.openDocument(pdfBytes, "application/pdf");
  const count = doc.countPages();

  console.log(`Source: ${pdfPath}`);
  console.log(`Output: ${OUT_DIR}`);
  console.log(`Page count: ${count}`);
  console.log("");

  console.log("==== Image extraction ====\n");
  for (let i = 0; i < count; i++) {
    const n = i + 1;
    await extractImage(doc, i, `rulebook-page-${String(n).padStart(2, "0")}.jpg`, count);
  }

  console.log("");
  console.log(`Done -- ${count} rulebook page images written to ${OUT_DIR}.`);
  console.log(`Page count constant to use in the viewer: ${count}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
