/**
 * QA runner — orchestrates scenario execution + bug-report
 * serialisation. Has TWO entry points:
 *
 *   `runScenarioInMemory(scenario, opts)`
 *     Runs a scenario, returns the `QaSession` (with `state`,
 *     `trace`, `bugs`). No file I/O — usable from vitest.
 *
 *   `runScenarioToReports(scenario, opts)`
 *     Same, but also writes a markdown + JSON bug report when
 *     the run has any bugs (or when `opts.alwaysWrite` is set).
 *     Uses dynamic `import("node:fs")` so this module stays
 *     bundler-safe when imported by browser code.
 *
 * The runner doesn't validate scenarios — it just runs them and
 * captures the side-effects via the session. Scenarios are
 * responsible for being deterministic + bounded.
 */

import type { Scenario } from "./scenarios/types";
import {
  buildJsonReport,
  buildMarkdownReport,
  reportFilenameBase,
} from "./bugReport";
import { QaSession } from "./session";

export interface RunOptions {
  /** RNG seed for the session. Default: `Date.now() & 0xffff` so
   *  ad-hoc runs are differentiated but still recorded. */
  seed?: number;
  /** Throw a JS error after running the scenario if the run
   *  produced any bugs. Used by vitest smoke tests so a bad
   *  invariant fails CI. */
  throwOnBug?: boolean;
}

export interface ReportOptions extends RunOptions {
  /** Directory to write reports under. Default: `./qa-reports/`
   *  relative to the CWD when running via `npm run qa`. */
  reportsDir?: string;
  /** Write a report even if the run was clean. Useful for
   *  golden-trace baselines. */
  alwaysWrite?: boolean;
}

/** Run a scenario and return the session. Pure in-memory — no
 *  file I/O. */
export function runScenarioInMemory(
  scenario: Scenario,
  opts: RunOptions = {},
): QaSession {
  const seed = opts.seed ?? (Date.now() & 0xffff);
  const session = new QaSession({ seed, scenarioName: scenario.name });
  try {
    scenario.run(session);
  } catch (err) {
    // The session has already recorded a synthetic
    // "engine-threw" bug via `session.safely`, so we just log
    // for visibility. We DON'T re-throw here — the test/CLI
    // path decides what to do based on `session.bugs`.
    // eslint-disable-next-line no-console
    console.error(`[qa] scenario "${scenario.name}" (seed=${seed}) threw:`, err);
  }
  if (opts.throwOnBug && session.bugs.length > 0) {
    const summary = session.bugs
      .map((b) => `  - [${b.violation.invariantId}] ${b.violation.message}`)
      .join("\n");
    throw new Error(
      `QA scenario "${scenario.name}" (seed=${seed}) produced ${session.bugs.length} invariant violation(s):\n${summary}`,
    );
  }
  return session;
}

/** Run a scenario AND write markdown + JSON reports on bugs.
 *  Returns the `{ session, mdPath, jsonPath }` (paths are null
 *  when no report was written). */
export async function runScenarioToReports(
  scenario: Scenario,
  opts: ReportOptions = {},
): Promise<{ session: QaSession; mdPath: string | null; jsonPath: string | null }> {
  const runStartedAt = new Date();
  const session = runScenarioInMemory(scenario, opts);
  const shouldWrite = opts.alwaysWrite || session.bugs.length > 0;
  if (!shouldWrite) return { session, mdPath: null, jsonPath: null };

  // Dynamic import so this module is importable from browser
  // code without bundling Node `fs`. The browser caller would
  // never set `alwaysWrite=true` AND have bugs, but the
  // dynamic import is the belt-and-braces fix.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = opts.reportsDir ?? path.resolve(process.cwd(), "qa-reports");
  fs.mkdirSync(dir, { recursive: true });
  const base = reportFilenameBase(session, runStartedAt);
  const mdPath = path.join(dir, `${base}.md`);
  const jsonPath = path.join(dir, `${base}.json`);
  fs.writeFileSync(mdPath, buildMarkdownReport(session, runStartedAt), "utf-8");
  fs.writeFileSync(jsonPath, JSON.stringify(buildJsonReport(session, runStartedAt), null, 2), "utf-8");
  return { session, mdPath, jsonPath };
}
