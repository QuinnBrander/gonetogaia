/**
 * One-shot rulebook text dumper. Writes `tools/rulebook-text.txt`
 * so we can grep for the canonical Scenario / Wave / etc. rules
 * without opening the PDF in a viewer.
 */

import * as mupdf from "mupdf";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ASSETS_DIR = resolve(ROOT, "../../ASSETS/Gone to Gaia");
const SRC = "Gone to Gaia - Rulebook - 8.5x11 v1 PROOF 3.pdf";
const OUT = resolve(ROOT, "tools/rulebook-text.txt");

async function main() {
  await mkdir(dirname(OUT), { recursive: true });
  const bytes = await readFile(resolve(ASSETS_DIR, SRC));
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const count = doc.countPages();
  const buf = [];
  for (let i = 0; i < count; i++) {
    const page = doc.loadPage(i);
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
    buf.push(`======== PAGE ${i + 1} ========\n${lines.join("\n")}\n`);
  }
  await writeFile(OUT, buf.join("\n"));
  console.log(`Wrote ${OUT} (${count} pages)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
