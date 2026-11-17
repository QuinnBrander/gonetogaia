/**
 * Scenario registry. The CLI + smoke test import from here so
 * adding a new scenario is one-line: write the scenario module,
 * add it here.
 */

import {
  edgeCaseDonationScenario,
  edgeCaseOpinionScenario,
  edgeCaseRoundtripScenario,
  edgeCaseWaveLifecycleScenario,
} from "./edgeCases";
import { happyPathScenario } from "./happyPath";
import { monkeyScenario } from "./monkey";
import { combatBruteScenario } from "./combatBrute";
import { combatMonkeyScenario } from "./combatMonkey";
import { combatMoverScenario } from "./combatMover";
import { combatRunAwayScenario } from "./combatRunAway";
import { combatSlotAbilityScenario } from "./combatSlotAbility";
import { combatTokenSpenderScenario } from "./combatTokenSpender";
import { quest2FullrunScenario } from "./quest2Fullrun";
import type { Scenario } from "./types";

export const SCENARIOS: ReadonlyArray<Scenario> = [
  happyPathScenario,
  monkeyScenario,
  quest2FullrunScenario,
  combatRunAwayScenario,
  combatBruteScenario,
  combatMonkeyScenario,
  combatMoverScenario,
  combatSlotAbilityScenario,
  combatTokenSpenderScenario,
  edgeCaseDonationScenario,
  edgeCaseOpinionScenario,
  edgeCaseRoundtripScenario,
  edgeCaseWaveLifecycleScenario,
];

export function findScenario(name: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.name === name);
}
