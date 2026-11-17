/**
 * Bug report serialisation — turns a `QaSession`'s captured bugs
 * into reproducer artifacts. Writes two files per failing run:
 *
 *   - `<reportsDir>/<timestamp>_<scenario>_<seed>.md`
 *     Human-readable triage view. Includes the scenario name +
 *     seed (for one-line reproduction), the list of violations
 *     grouped by invariant id, and a numbered action trace
 *     leading to each violation. Markdown so it renders cleanly
 *     in GitHub issues / VS Code preview.
 *
 *   - `<reportsDir>/<timestamp>_<scenario>_<seed>.json`
 *     Machine-readable snapshot. Includes the full session
 *     trace, bugs, and the FINAL campaign state. Used by the
 *     test suite to assert "no new bugs since baseline" and
 *     by any future regression-replay tooling.
 *
 * Reports are written via Node `fs` APIs, NOT browser localStorage,
 * because the QA runner runs from the CLI (`npm run qa`) or
 * vitest. The runner module guards the `fs` import so the file
 * can still be imported by browser code without crashing the
 * bundler — see `runner.ts > writeBugReport`.
 */

import type { QaSession, SessionBug, TraceEntry } from "./session";

/**
 * Build the markdown view of a failing session. Pure function —
 * doesn't write to disk; the runner is responsible for that.
 *
 * Layout:
 *   1. Header (scenario, seed, run timestamp, summary count).
 *   2. "How to reproduce" with the one-line CLI invocation.
 *   3. Bug summary table (id, message, triggered at step).
 *   4. Detailed bug sections — one per violation with a slice
 *      of the trace ending at the triggering step.
 *   5. Full action trace as an appendix.
 */
export function buildMarkdownReport(session: QaSession, runStartedAt: Date): string {
  const lines: string[] = [];
  lines.push(`# QA bug report — \`${session.scenarioName}\``);
  lines.push("");
  lines.push(`- **Scenario**: \`${session.scenarioName}\``);
  lines.push(`- **Seed**: \`${session.seed}\``);
  lines.push(`- **Run started**: ${runStartedAt.toISOString()}`);
  lines.push(`- **Total actions**: ${session.trace.length}`);
  lines.push(`- **Bugs found**: ${session.bugs.length}`);
  lines.push("");

  lines.push("## Reproduce");
  lines.push("");
  lines.push("```bash");
  lines.push(`npm run qa -- --scenario=${session.scenarioName} --seed=${session.seed}`);
  lines.push("```");
  lines.push("");

  if (session.bugs.length === 0) {
    lines.push("## No bugs found");
    lines.push("");
    lines.push("This report was written because the runner asked for a snapshot, not because anything failed.");
    return lines.join("\n");
  }

  // Group bugs by invariant id so the triager can scan for
  // recurring patterns. Within each group, sort by triggering
  // step.
  const byId = new Map<string, SessionBug[]>();
  for (const b of session.bugs) {
    const arr = byId.get(b.violation.invariantId) ?? [];
    arr.push(b);
    byId.set(b.violation.invariantId, arr);
  }

  lines.push("## Bugs summary");
  lines.push("");
  lines.push("| Invariant | Count | First step |");
  lines.push("|---|---|---|");
  for (const [id, bugs] of byId) {
    const firstStep = Math.min(...bugs.map((b) => b.triggeringStep));
    lines.push(`| \`${id}\` | ${bugs.length} | ${firstStep} |`);
  }
  lines.push("");

  lines.push("## Bug details");
  lines.push("");
  let bugIdx = 0;
  for (const [id, bugs] of byId) {
    lines.push(`### \`${id}\` (${bugs.length} occurrence${bugs.length === 1 ? "" : "s"})`);
    lines.push("");
    for (const bug of bugs) {
      bugIdx++;
      lines.push(`#### Bug ${bugIdx} — step ${bug.triggeringStep}`);
      lines.push("");
      lines.push(`- **Message**: ${bug.violation.message}`);
      lines.push(`- **Path**: \`${bug.violation.path}\``);
      if (bug.violation.expected !== undefined) {
        lines.push(`- **Expected**: \`${bug.violation.expected}\``);
      }
      if (bug.violation.observed !== undefined) {
        lines.push(`- **Observed**: \`${jsonInline(bug.violation.observed)}\``);
      }
      lines.push("");
      lines.push(`**Action that triggered**:`);
      lines.push("");
      lines.push(formatTraceEntryAsListItem(bug.triggeringAction));
      lines.push("");
      lines.push(`**Trace leading up to step ${bug.triggeringStep}** (last 10 actions):`);
      lines.push("");
      const start = Math.max(0, bug.triggeringStep - 9);
      const slice = session.trace.slice(start, bug.triggeringStep + 1);
      for (const entry of slice) {
        lines.push(formatTraceEntryAsListItem(entry));
      }
      lines.push("");
    }
  }

  lines.push("## Full action trace");
  lines.push("");
  lines.push("<details><summary>Click to expand</summary>");
  lines.push("");
  for (const entry of session.trace) {
    lines.push(formatTraceEntryAsListItem(entry));
  }
  lines.push("");
  lines.push("</details>");

  return lines.join("\n");
}

/** Format one trace entry as a markdown list item. */
function formatTraceEntryAsListItem(entry: TraceEntry): string {
  const cp = entry.checkpoint ? ` **[${entry.checkpoint}]**` : "";
  return `- \`${entry.step.toString().padStart(4, "0")}\` **${entry.kind}**${cp} ${jsonInline(entry.payload)}`;
}

/** Compact JSON for inline trace lines. Caps long strings at 200
 *  chars to keep the report readable. */
function jsonInline(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    if (s.length > 200) return s.slice(0, 197) + "...";
    return s;
  } catch {
    return "[unserialisable]";
  }
}

/**
 * Machine-readable JSON payload for the `.json` report sibling.
 * Includes the full state so a future replay tool can diff
 * against a fresh re-run.
 */
export function buildJsonReport(session: QaSession, runStartedAt: Date): unknown {
  return {
    scenarioName: session.scenarioName,
    seed: session.seed,
    runStartedAt: runStartedAt.toISOString(),
    trace: session.trace,
    bugs: session.bugs,
    expectedThrows: session.expectedThrows,
    finalState: session.state,
  };
}

/**
 * Slug used for filenames. Sortable + scrape-friendly.
 * E.g. `2026-05-19T12-00-00_happyPath_42`.
 */
export function reportFilenameBase(session: QaSession, runStartedAt: Date): string {
  const iso = runStartedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safeName = session.scenarioName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${iso}_${safeName}_${session.seed}`;
}
