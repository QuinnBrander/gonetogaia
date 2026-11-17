// Quick trace inspector — counts page-revisits in a QA report
// to find walker cycles.
import { readFileSync } from "node:fs";
const path = process.argv[2];
if (!path) {
  console.error("Usage: node scripts/inspect-trace.mjs <report.json>");
  process.exit(1);
}
const report = JSON.parse(readFileSync(path, "utf-8"));
const pageVisits = new Map();
for (const entry of report.trace) {
  if (entry.kind === "setPage") {
    const id = entry.payload.pageId;
    pageVisits.set(id, (pageVisits.get(id) ?? 0) + 1);
  } else if (entry.kind === "startTownVisit") {
    pageVisits.set("(visit-start)", (pageVisits.get("(visit-start)") ?? 0) + 1);
  } else if (entry.kind === "choose") {
    const k = `choose:${entry.payload.decisionKey}`;
    pageVisits.set(k, (pageVisits.get(k) ?? 0) + 1);
  }
}
console.log("Most revisited (top 25):");
const sorted = [...pageVisits.entries()].sort((a, b) => b[1] - a[1]);
for (const [id, count] of sorted.slice(0, 25)) {
  console.log(`  ${String(count).padStart(4)}x  ${id}`);
}
console.log(`\nTotal trace entries: ${report.trace.length}`);
console.log(`Total bugs: ${report.bugs.length}`);
console.log(`\nCheckpoints in order:`);
for (const entry of report.trace) {
  if (entry.checkpoint) console.log(`  step ${entry.step}: ${entry.checkpoint}`);
}
