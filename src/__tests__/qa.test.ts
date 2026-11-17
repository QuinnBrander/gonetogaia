/**
 * Smoke test for the QA harness. Two layers:
 *
 *   1. Self-test: inject a known fault and assert the harness
 *      catches it. If THIS fails, every other QA result is
 *      meaningless because the invariant pipeline is broken.
 *
 *   2. Property tests: run each shipped scenario through the
 *      harness and assert ZERO bugs. The monkey scenario runs
 *      with 25 different seeds so a regression in a state path
 *      that only surfaces at certain seeds still bites.
 *
 * Why not just call `runScenarioInMemory` in every test? Because
 * the harness IS a test of the test harness — keeping the
 * self-test colocated with the property test means breaking the
 * fault-detection path is loud (the self-test starts passing
 * with 0 bugs caught, which it asserts against).
 */

import { describe, expect, it } from "vitest";
import { runScenarioInMemory } from "../qa/runner";
import {
  edgeCaseDonationScenario,
  edgeCaseOpinionScenario,
  edgeCaseRoundtripScenario,
  edgeCaseWaveLifecycleScenario,
} from "../qa/scenarios/edgeCases";
import { combatBruteScenario } from "../qa/scenarios/combatBrute";
import { combatMonkeyScenario } from "../qa/scenarios/combatMonkey";
import { combatMoverScenario } from "../qa/scenarios/combatMover";
import { combatRunAwayScenario } from "../qa/scenarios/combatRunAway";
import { combatSlotAbilityScenario } from "../qa/scenarios/combatSlotAbility";
import { combatTokenSpenderScenario } from "../qa/scenarios/combatTokenSpender";
import { happyPathScenario } from "../qa/scenarios/happyPath";
import { monkeyScenario } from "../qa/scenarios/monkey";
import { quest2FullrunScenario } from "../qa/scenarios/quest2Fullrun";
import type { Scenario } from "../qa/scenarios/types";

describe("QA harness self-test", () => {
  it("catches an injected wallet underflow", () => {
    const buggy: Scenario = {
      name: "self-test-wallet-underflow",
      description: "Intentionally violates wallet-non-negative.",
      run(session) {
        session.startTownVisit("ch1");
        session.applyOnEnter();
        // Direct mutation - then a no-op logged action so the
        // invariant pass fires against the corrupted state.
        session.state.minionParts["hero-01"] = -1;
        session.applyAction({ kind: "record-decision", key: "qa.self-test" });
      },
    };
    const session = runScenarioInMemory(buggy, { seed: 0 });
    expect(session.bugs.length).toBeGreaterThan(0);
    expect(session.bugs.some((b) => b.violation.invariantId === "wallet-non-negative")).toBe(true);
  });

  it("catches an injected story-tokens cap breach", () => {
    const buggy: Scenario = {
      name: "self-test-story-tokens-cap",
      description: "Intentionally violates story-tokens-capped.",
      run(session) {
        session.startTownVisit("ch1");
        session.applyOnEnter();
        session.state.storyTokens = 999;
        session.applyAction({ kind: "record-decision", key: "qa.self-test-story-tokens" });
      },
    };
    const session = runScenarioInMemory(buggy, { seed: 0 });
    expect(session.bugs.some((b) => b.violation.invariantId === "story-tokens-capped")).toBe(true);
  });

  it("catches an injected alive-enemy with lethal damage", () => {
    const buggy: Scenario = {
      name: "self-test-alive-damage-overflow",
      description: "Intentionally violates enemy-alive-damage-consistent.",
      run(session) {
        session.state.quest1Completed = true;
        session.state.currentQuestId = "quest2";
        session.bootstrapWave("quest2", 1);
        session.drainOpinionPicks();
        session.autoPlaceSpawns();
        session.startWaveAfterPick();
        // Crank up boss damageTaken past its hp without flipping
        // alive — the bug shape we're checking for.
        const enc = session.state.encounter!;
        const boss = enc.enemies.find((e) => e.instanceId === "boss")!;
        boss.damageTaken = 999;
        boss.alive = true;
        // Trigger an invariant pass via a no-op action (no wave is
        // at End Wave, so completeWave does nothing).
        session.completeWave();
      },
    };
    const session = runScenarioInMemory(buggy, { seed: 0 });
    expect(session.bugs.some((b) => b.violation.invariantId === "enemy-alive-damage-consistent")).toBe(true);
  });

  it("catches an injected schema-version mismatch", () => {
    const buggy: Scenario = {
      name: "self-test-schema-version",
      description: "Intentionally violates schema-version-matches.",
      run(session) {
        session.startTownVisit("ch1");
        session.applyOnEnter();
        session.state.version = 1 as never;
        session.applyAction({ kind: "record-decision", key: "qa.self-test-schema" });
      },
    };
    const session = runScenarioInMemory(buggy, { seed: 0 });
    expect(session.bugs.some((b) => b.violation.invariantId === "schema-version-matches")).toBe(true);
  });
});

describe("QA scenarios — no invariant violations", () => {
  it("happyPath at seed 0", () => {
    const session = runScenarioInMemory(happyPathScenario, { seed: 0 });
    expectClean(session.bugs, "happyPath", 0);
  });

  it("edge-donation at seed 0", () => {
    const session = runScenarioInMemory(edgeCaseDonationScenario, { seed: 0 });
    expectClean(session.bugs, "edge-donation", 0);
  });

  it("edge-opinion at seed 0", () => {
    const session = runScenarioInMemory(edgeCaseOpinionScenario, { seed: 0 });
    expectClean(session.bugs, "edge-opinion", 0);
  });

  it("edge-roundtrip at seed 0", () => {
    const session = runScenarioInMemory(edgeCaseRoundtripScenario, { seed: 0 });
    expectClean(session.bugs, "edge-roundtrip", 0);
  });

  it("edge-wave-lifecycle at seed 0", () => {
    const session = runScenarioInMemory(edgeCaseWaveLifecycleScenario, { seed: 0 });
    expectClean(session.bugs, "edge-wave-lifecycle", 0);
  });

  it("quest2-fullrun at seed 0", () => {
    const session = runScenarioInMemory(quest2FullrunScenario, { seed: 0 });
    expectClean(session.bugs, "quest2-fullrun", 0);
  });

  it("combat-run-away at seed 0", () => {
    const session = runScenarioInMemory(combatRunAwayScenario, { seed: 0 });
    expectClean(session.bugs, "combat-run-away", 0);
  });

  it("combat-brute at seed 0", () => {
    const session = runScenarioInMemory(combatBruteScenario, { seed: 0 });
    expectClean(session.bugs, "combat-brute", 0);
  });

  it("combat-mover at seed 0", () => {
    const session = runScenarioInMemory(combatMoverScenario, { seed: 0 });
    expectClean(session.bugs, "combat-mover", 0);
  });

  it("combat-slot-ability at seed 0", () => {
    const session = runScenarioInMemory(combatSlotAbilityScenario, { seed: 0 });
    expectClean(session.bugs, "combat-slot-ability", 0);
  });

  it("combat-token-spender at seed 0", () => {
    const session = runScenarioInMemory(combatTokenSpenderScenario, { seed: 0 });
    expectClean(session.bugs, "combat-token-spender", 0);
  });

  // Property test — town-visit monkey across a fan of seeds.
  // 25 is a pragmatic balance: enough to surface seed-specific
  // regressions (in practice almost all bugs we've seen
  // reproduce at seed < 10) without dominating the test suite
  // wall-clock.
  for (let seed = 0; seed < 25; seed++) {
    it(`monkey at seed ${seed}`, () => {
      const session = runScenarioInMemory(monkeyScenario, { seed });
      expectClean(session.bugs, "monkey", seed);
    });
  }

  // Property test — combat monkey. Same 25-seed budget as the
  // town-visit monkey. Each seed bootstraps Q2 W1 and drives
  // random hero-phase actions; this exercises placement,
  // attacks, prepareToRun, parting shots, and the
  // end-of-wave transitions against a Q2 spawn-deck wave with
  // Fatal Flaw / Primordial / Rotates / Teleports enemies.
  for (let seed = 0; seed < 25; seed++) {
    it(`combat-monkey at seed ${seed}`, () => {
      const session = runScenarioInMemory(combatMonkeyScenario, { seed });
      expectClean(session.bugs, "combat-monkey", seed);
    });
  }
});

/** Helper: assert a session is clean, with a helpful message
 *  pointing at the seed for reproduction. */
function expectClean(bugs: ReadonlyArray<{ violation: { invariantId: string; message: string } }>, scenario: string, seed: number): void {
  if (bugs.length === 0) return;
  const summary = bugs
    .map((b) => `  - [${b.violation.invariantId}] ${b.violation.message}`)
    .join("\n");
  throw new Error(
    `QA scenario "${scenario}" (seed=${seed}) produced ${bugs.length} invariant violation(s):\n${summary}\n\nReproduce with: npm run qa -- --scenario=${scenario} --seed=${seed}`,
  );
}
