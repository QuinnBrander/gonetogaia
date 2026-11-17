/**
 * Scenario contract. A scenario is just a function that drives a
 * `QaSession` through some sequence of actions. The runner
 * doesn't care HOW it drives; the session captures the trace +
 * any invariant violations as a side-effect.
 *
 * Scenarios should:
 *   - Use `session.checkpoint(label)` between phases so bug
 *     reports tell a story rather than dumping raw step ids.
 *   - Tolerate the engine settling into terminal pages
 *     (`session.currentPageHasNext()` returns false and there
 *     are no choices) by checking + breaking out of loops.
 *   - Bounds-check their loops — a `while (true)` that depends
 *     on the engine to make progress will hang the runner if a
 *     bug freezes the page graph.
 *
 * Scenarios should NOT:
 *   - Call `Math.random()` directly. Use `session.rng()` so the
 *     run is reproducible from `(scenarioName, seed)`.
 *   - Mutate `session.state` directly. Go through the action
 *     wrappers so invariants run after every change.
 *   - Throw on engine errors (use `session.expectThrow` when an
 *     error is the test).
 */

import type { QaSession } from "../session";

export interface Scenario {
  /** Stable id used by the CLI + reports
   *  (`--scenario=happyPath`). */
  name: string;
  /** One-line description for `npm run qa --list`. */
  description: string;
  /** Drive the supplied session to completion. Should be
   *  bounded — the runner will hard-abort after `MAX_STEPS` if
   *  a scenario runs away. */
  run(session: QaSession): void;
}

/** Hard cap on actions per scenario run — prevents a buggy
 *  page graph or scenario loop from hanging the harness. */
export const MAX_STEPS = 2000;
