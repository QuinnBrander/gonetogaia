/**
 * Extract Scenario card images and per-card text from the printed
 * Gone to Gaia scenario card PDFs:
 *
 *   - `Scenario Cards Front v4 PROOF 2.pdf`  -> printed effect text
 *   - `Scenario Cards Back v4 PROOF 2.pdf`   -> shared card back
 *
 * Scenario cards trigger at the start of Wave 2+ in each quest
 * (first occurrence: Ch2 quest). The deck is shuffled; one card
 * is drawn face-up to set a wave-wide modifier.
 *
 * Outputs:
 *   - `public/scenario-cards/scenario_front_NN.jpg` per front page
 *   - `public/scenario-cards/scenario_back.jpg`     (page 1 of back PDF)
 *   - Console: per-page text dump so the engine catalog can be
 *     populated by hand from the printed copy.
 *
 * Run with: node scripts/extractScenarioCards.mjs
 *
 * Mirrors `extractMemoryCardImages.mjs` for image render quality.
 */

import * as mupdf from "mupdf";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ASSETS_DIR = resolve(ROOT, "../../ASSETS/Gone to Gaia");
const OUT_DIR = resolve(ROOT, "public/scenario-cards");
const FRONTS_PDF = "Scenario Cards Front v4 PROOF 2.pdf";
const BACKS_PDF = "Scenario Cards Back v4 PROOF 2.pdf";

const RENDER_SCALE = 4;
const JPEG_QUALITY = 85;

async function dumpPageText(doc, pageIndex, label) {
  const page = doc.loadPage(pageIndex);
  // mupdf-js's text extraction API: structuredText -> walk blocks.
  const stext = page.toStructuredText("preserve-whitespace");
  const json = JSON.parse(stext.asJSON());
  const lines = [];
  for (const block of json.blocks ?? []) {
    if (block.type !== "text") continue;
    for (const line of block.lines ?? []) {
      const txt = (line.text ?? "").trim();
      if (txt) lines.push(txt);
    }
  }
  console.log(`---- ${label} (page ${pageIndex + 1}) ----`);
  console.log(lines.join("\n"));
  console.log("");
}

async function extractImage(doc, pageIndex, outName, totalPages) {
  const page = doc.loadPage(pageIndex);
  const matrix = mupdf.Matrix.scale(RENDER_SCALE, RENDER_SCALE);
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
  const jpegBytes = pixmap.asJPEG(JPEG_QUALITY, false);
  const outPath = resolve(OUT_DIR, outName);
  await writeFile(outPath, jpegBytes);
  const sizeKb = (jpegBytes.length / 1024).toFixed(1);
  console.log(`  wrote ${outName.padEnd(26)} (${pixmap.getWidth()}x${pixmap.getHeight()}, ${sizeKb} KB)  <- page ${pageIndex + 1} of ${totalPages}`);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  // ---- Fronts -----------------------------------------------------------
  const frontsPath = resolve(ASSETS_DIR, FRONTS_PDF);
  const frontsBytes = await readFile(frontsPath);
  const fronts = mupdf.Document.openDocument(frontsBytes, "application/pdf");
  const frontsCount = fronts.countPages();
  console.log(`Source (fronts): ${frontsPath}`);
  console.log(`Output: ${OUT_DIR}`);
  console.log(`Fronts page count: ${frontsCount}`);
  console.log("");

  console.log("==== Per-page text dump (fronts) ====\n");
  for (let i = 0; i < frontsCount; i++) {
    await dumpPageText(fronts, i, `scenario front #${String(i + 1).padStart(2, "0")}`);
  }

  console.log("==== Image extraction (fronts) ====\n");
  for (let i = 0; i < frontsCount; i++) {
    const n = i + 1;
    await extractImage(fronts, i, `scenario_front_${String(n).padStart(2, "0")}.jpg`, frontsCount);
  }

  // ---- Backs ------------------------------------------------------------
  const backsPath = resolve(ASSETS_DIR, BACKS_PDF);
  const backsBytes = await readFile(backsPath);
  const backs = mupdf.Document.openDocument(backsBytes, "application/pdf");
  const backsCount = backs.countPages();
  console.log("");
  console.log(`Source (backs): ${backsPath}`);
  console.log(`Backs page count: ${backsCount}`);
  console.log("");

  console.log("==== Per-page text dump (backs) ====\n");
  for (let i = 0; i < backsCount; i++) {
    await dumpPageText(backs, i, `scenario back #${String(i + 1).padStart(2, "0")}`);
  }

  console.log("==== Image extraction (backs) ====\n");
  for (let i = 0; i < backsCount; i++) {
    const n = i + 1;
    await extractImage(backs, i, `scenario_back_${String(n).padStart(2, "0")}.jpg`, backsCount);
  }

  console.log("");
  console.log(`Done — ${frontsCount} fronts + 1 back image written.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
