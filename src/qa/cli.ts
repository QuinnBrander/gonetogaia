/**
 * `cli.ts` — the TypeScript half of `scripts/qa.mjs`. Parses
 * argv, dispatches to scenarios, prints a summary, and writes
 * bug reports for failing runs.
 *
 * Kept separate from `runner.ts` so the runner can be imported
 * by the vitest smoke test without dragging in `process.argv`
 * + console output.
 */

import { runScenarioToReports } from "./runner";
import { SCENARIOS, findScenario } from "./scenarios";

interface CliArgs {
  scenario: string | null;
  seed: number | null;
  runs: number;
  list: boolean;
  verbose: boolean;
  alwaysWrite: boolean;
  reportsDir: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    scenario: null,
    seed: null,
    runs: 1,
    list: false,
    verbose: false,
    alwaysWrite: false,
    reportsDir: null,
  };
  for (const arg of argv) {
    if (arg === "--list") out.list = true;
    else if (arg === "--verbose" || arg === "-v") out.verbose = true;
    else if (arg === "--always-write") out.alwaysWrite = true;
    else if (arg.startsWith("--scenario=")) out.scenario = arg.slice("--scenario=".length);
    else if (arg.startsWith("--seed=")) out.seed = Number(arg.slice("--seed=".length));
    else if (arg.startsWith("--runs=")) out.runs = Number(arg.slice("--runs=".length));
    else if (arg.startsWith("--reports-dir=")) out.reportsDir = arg.slice("--reports-dir=".length);
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.warn(`[qa] unknown argument: ${arg} (ignored)`);
    }
  }
  if (out.runs < 1) out.runs = 1;
  return out;
}

function printHelp(): void {
  console.log(`gone-to-gaia QA harness

Usage:
  npm run qa                                 # run every scenario once (seed=0)
  npm run qa -- --scenario=NAME              # run one scenario
  npm run qa -- --scenario=NAME --seed=N     # specific seed
  npm run qa -- --scenario=NAME --runs=N     # N seeds (0..N-1)
  npm run qa -- --list                       # print scenarios + descriptions
  npm run qa -- --verbose                    # print bug count per run
  npm run qa -- --always-write               # write report even on clean runs

Bug reports are written to ./qa-reports/ as markdown + JSON.
Exit code is 0 on a clean run, 1 if any scenario produced bugs.
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    console.log("Available scenarios:");
    for (const s of SCENARIOS) {
      console.log(`  - ${s.name.padEnd(20)} ${s.description}`);
    }
    process.exit(0);
  }

  const toRun = args.scenario
    ? [findScenario(args.scenario)]
    : SCENARIOS.slice();
  if (toRun.some((s) => !s)) {
    console.error(`[qa] unknown scenario: ${args.scenario}`);
    console.error("[qa] try: npm run qa -- --list");
    process.exit(2);
  }

  const reportsDir = args.reportsDir ?? undefined;
  let totalBugs = 0;
  let totalRuns = 0;

  for (const scenario of toRun) {
    if (!scenario) continue;
    for (let i = 0; i < args.runs; i++) {
      const seed = args.seed !== null ? args.seed : i;
      totalRuns++;
      const { session, mdPath, jsonPath } = await runScenarioToReports(scenario, {
        seed,
        reportsDir,
        alwaysWrite: args.alwaysWrite,
      });
      totalBugs += session.bugs.length;
      const status = session.bugs.length === 0 ? "OK" : `${session.bugs.length} BUG(S)`;
      if (args.verbose || session.bugs.length > 0) {
        console.log(
          `[qa] ${scenario.name.padEnd(20)} seed=${seed.toString().padEnd(6)} actions=${session.trace.length.toString().padEnd(4)} ${status}` +
            (mdPath ? ` -> ${mdPath}` : ""),
        );
      }
      if (mdPath && !args.verbose) {
        console.log(`[qa] report: ${mdPath}`);
        if (jsonPath) console.log(`[qa] report: ${jsonPath}`);
      }
    }
  }

  const summary = totalBugs === 0
    ? `[qa] ${totalRuns} run(s), 0 bugs - all clean`
    : `[qa] ${totalRuns} run(s), ${totalBugs} bug(s) - see qa-reports/`;
  console.log(summary);
  process.exit(totalBugs === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[qa] harness crashed:", err);
  process.exit(2);
});
