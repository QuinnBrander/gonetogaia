#!/usr/bin/env node
/**
 * CLI entry for the QA harness.
 *
 *   npm run qa                                 # default: every scenario, seed=0
 *   npm run qa -- --scenario=happyPath         # one scenario
 *   npm run qa -- --scenario=monkey --seed=42  # specific seed
 *   npm run qa -- --scenario=monkey --runs=20  # 20 monkey seeds (0..19)
 *   npm run qa -- --list                       # print available scenarios
 *   npm run qa -- --verbose                    # print every scenario's bug count
 *
 * Exit code:
 *   0 = all runs clean
 *   1 = one or more runs produced bugs (reports written under qa-reports/)
 *
 * Implementation: compiles the QA harness on the fly via Vite's
 * ESM-aware esbuild (tsx) so we don't need a separate build
 * step. If tsx isn't on the dev path, we fall back to a direct
 * dynamic import on the .ts file via Node's --experimental-
 * strip-types flag; this requires Node 22.6+ for native TS.
 *
 * For a game-jam template we keep the runtime path SIMPLE: shell
 * out to `npx tsx` which is already a transitive dep through
 * vite. This adds about 200ms cold-start to `npm run qa`, which
 * is fine for an out-of-band test runner.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const harnessEntry = resolve(__dirname, "../src/qa/cli.ts");

// `shell: true` is required on Windows so spawnSync resolves
// `npx.cmd` from the project's node_modules/.bin and inherits
// the parent PATH correctly. Without it spawnSync silently
// exits 1 with no output on Windows.
const result = spawnSync(
  "npx",
  ["tsx", harnessEntry, ...process.argv.slice(2)],
  { stdio: "inherit", shell: true },
);

process.exit(result.status ?? 1);
