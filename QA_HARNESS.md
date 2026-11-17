# QA Harness — automated playtest + bug detection

The QA harness is an **engine-driven** test runner that plays through
the campaign (Ch1 + Ch2 town visits, shop, opinion-card flows, Academy
donations) and checks state invariants after every action. Failing runs
write a markdown + JSON bug report to `qa-reports/` with a numbered
trace so the failure is reproducible from `(scenario, seed)`.

It is **NOT** a browser/Playwright runner — it drives the same engine
functions the screens use. That keeps it fast (full suite under 3s),
deterministic (seeded RNG), and bundler-safe (no DOM, no Node deps
leaked into the web build).

## Quick start

```bash
npm run qa                                # every scenario, seed=0
npm run qa -- --scenario=monkey --runs=50 # 50 seeded monkey runs
npm run qa -- --list                      # list scenarios
npm run qa -- --verbose                   # print per-run status
```

CI gate: the vitest suite (`npm test`) includes `src/__tests__/qa.test.ts`
which runs `happyPath` + all edge cases + 25 monkey seeds and fails on
any invariant violation.

## What it covers today

| Scenario              | Coverage                                                  |
|-----------------------|-----------------------------------------------------------|
| `happyPath`           | Deterministic walk of Ch1 + Ch2, Q2 opinion grants, donation, opinion redemptions |
| `monkey`              | Seeded-random walk of Ch1 + Ch2 with noisy side-actions (random donations, random shop buys, redeem attempts) |
| `quest2-fullrun`      | Bootstrap Q2 W1 → W2 → W3 via `debugWinWave` (full kill / parting-shot / interlude / end-of-wave pipeline), then walk Ch2 |
| `combat-run-away`     | Both delvers `prepareToRun` on turn 1 → parting-shots → interlude → completed (no combat, exercises the retreat path) |
| `combat-brute`        | Hand-drive Q2 W1 hero turns: place a weapon every turn, swing at adjacent enemies with `single-adjacent` weapons (real `playWeaponCard` + `useWeaponAbility` + `resolveAllDamage` + `finalizeAttackSession`) |
| `combat-monkey`       | Seeded-random hero-phase actions (25-seed property test): mix of `prepareToRun`, placement+swing with random counter rolls, and pass-turn |
| `combat-mover`        | Walk toward nearest enemy via `moveDelverStep` before swinging (exercises the movement engine + `endMovementStep` latch + `tileDrops` claim) |
| `combat-slot-ability` | Place a card every turn and fire the printed SLOT ABILITY instead of the weapon range (covers every `damage-any-enemy`/`bonus-movement`/`refresh-ap`/`gain-element` dispatch path) |
| `combat-token-spender`| Spend 1 AP for double-movement before placing, spend 2 AP to refresh the placed slot when no swing is possible (exercises the AP economy) |
| `edge-donation`       | Donate `0`, `-1`, `> wallet`, `=== wallet`, unknown hero, no visit |
| `edge-opinion`        | Double-redeem Samantha/Flores, redeem without ownership, redeem with no visit |
| `edge-roundtrip`      | Serialise + parse the campaign, assert invariants still hold |
| `edge-wave-lifecycle` | Phase-transition calls out of order, duplicate calls, missing-encounter calls |

**Phases 3 (tactical combat) and 4 (movement / slot abilities /
AP economy) are complete.** Every BoardScreen action the player
can take is now exercised by some scenario. Future work
("Future extensions" at the bottom) covers attack range kinds
beyond `single-adjacent` (Hammer / Beam / Trident / Shockwave
swings) and the deferred AP-spend-conservation invariant.

## Invariants

Every action wrapper on `QaSession` runs `checkAllInvariants(state)`
after mutating state. The current invariants live in
`src/qa/invariants.ts`:

Campaign / shared state:
- `schema-version-matches` — `state.version === SCHEMA_VERSION`
- `hp-in-range` / `max-hp-positive` — every delver's HP is sane
- `equipment-ranks-in-range` — `0 <= rank <= 5`
- `wallet-non-negative` / `shared-counter-non-negative` — no underflows
- `opinion-cards-unique` — no duplicate `(characterId, level)` rows
- `opinion-cards-spent-references-owned` — `opinionCardsSpent` ⊆ `opinionCards`
- `town-visit-shape` — chapterId / pageId / pagesEntered well-formed
- `no-visit-latches-reset` — `floresDiscountArmed`, `academyDonation` all reset when no visit is active
- `key-items-unique` — `keyItems` unique by `number`
- `story-tokens-capped` — soft cap at 5 (catches stuck grants)
- `json-round-trip` — full state survives `JSON.stringify` + `JSON.parse`
- `encounter-queue-shape` — pending pick / draw / roll queues are arrays
- `shop-products-single-owner` — no product number owned by 2 delvers

Combat / encounter state:
- `enemy-damage-non-negative` — `damageTaken >= 0` for every instance
- `enemy-alive-damage-consistent` — `alive=true ⇒ damageTaken < card.hp` (one-directional; the engine's tear-down paths flip `alive=false` without bumping damage)
- `ap-in-range` — `0 <= currentAp <= baseAp`
- `encounter-phase-valid` — `enc.phase` is one of the 6 known values
- `completed-clears-encounter` — `phase === "completed"` ⇒ `state.encounter === null`
- `encounter-wave-exists` — `(questId, waveNumber)` is a real wave
- `active-delver-on-board` — during `phase === "hero"`, `state.currentDelverId` is a known delver with a position on the board (catches stranded-active-id bugs that would silently no-op every subsequent `playWeaponCard` / `useWeaponAbility`)
- `pending-modals-capped` — total entries across all 4 pending queues (level-up draws + element choices + equipment rolls + opinion-rank picks) stays under 32; catches queue-leak bugs that would lock the modal stack forever
- `positions-on-board` — every delver position AND every live enemy sits inside the wave's printed `boardSize` rectangle; catches movement bugs that would paint a token off-canvas (silent — no error in the renderer)
- `movement-non-negative` — `0 <= currentMovement <= 16`; catches over-decrement in `moveDelverStep` and runaway double-mov / +1-mov stacking

**Adding an invariant:** write a `function check<Thing>(state):
InvariantViolation | null`, push it onto `ALL_INVARIANTS` at the bottom
of `src/qa/invariants.ts`, and add the id to `listInvariantIds()`. The
runner picks it up automatically.

## Scenarios

A scenario is just `{ name, description, run(session) }`. The runner
calls `run`, and the session captures the trace + invariant
violations.

```typescript
import type { Scenario } from "../qa/scenarios/types";

export const mySendario: Scenario = {
  name: "my-thing",
  description: "What this scenario probes.",
  run(session) {
    session.startTownVisit("ch1");
    session.applyOnEnter();
    session.choose("ch1.bram.A.pub");
    session.checkpoint("entered pub");
    // ... more actions ...
    if (session.state.townVisit) session.finishTownVisit();
  },
};
```

**Register** by adding the scenario to `src/qa/scenarios/index.ts`.

**Rules of thumb:**

- Use `session.rng()` (NOT `Math.random()`) so monkey runs are
  reproducible from the seed.
- Bound your loops. The runner hard-aborts after `MAX_STEPS = 2000`
  actions, but tight inner loops still waste budget.
- Use `session.checkpoint("label")` between phases so bug reports
  tell a story.
- Use `session.expectThrow("reason")` to silence a known-rejection
  call. Without it, the harness records the throw as a bug.

## Bug reports

When a scenario produces any bugs, the runner writes both files:

- `qa-reports/<timestamp>_<scenario>_<seed>.md` — human view with
  per-invariant summary, action trace leading to each failure, and
  a full trace appendix.
- `qa-reports/<timestamp>_<scenario>_<seed>.json` — machine view
  with the full session (trace + bugs + final state) for replay
  tooling.

The directory is `.gitignore`'d. Open the markdown report in VS Code
preview / GitHub to triage.

**Reproducing a flaky monkey failure:**

```bash
# bug report header tells you the seed
npm run qa -- --scenario=monkey --seed=NNN --always-write
```

`--always-write` forces a report even when the second run is clean,
which sometimes happens if a non-determinism bug has slipped into
the engine (a real finding — should be triaged as a P0 because the
harness can no longer reliably reproduce).

## Phase 3 — tactical combat (shipped)

The Phase 2 `debugWinWave` shortcut covers the wave LIFECYCLE but
skips the hand-driven hero loop. Phase 3 closes that gap by
wrapping the per-turn engine APIs and adding scenarios that drive
them directly.

**Wrappers added to `QaSession`:**
- `prepareDelverToRun(heroId)` — wraps `engine/turn.ts > prepareToRun`
- `playWeapon(heroId, slotIdx, cardId)` — wraps `playWeaponCard`
- `useWeaponAbility(heroId, slotIdx, params)` — returns the built
  `AttackSession` (caller picks the counter roll)
- `resolveAttackSession(session, counterRoll)` — drives
  `resolveAllDamage` → `resolveSharedCounter` → `finalizeAttackSession`
- `endHeroTurn()` — flips active delver, runs the bothPrepared check
- `drainPendingModals(maxIters)` — auto-resolves Xavier picks,
  level-up draws, element choices, and equipment-roll prompts
  with deterministic defaults
- `firstPlayableWeapon(heroId)` — pure read helper that mirrors
  the engine's hand definition (`equipmentRanks[]` ≥ 1, not
  already placed) so a scenario can pick a card to play in 1 line
- `adjacentLiveEnemy(heroId)` — pure 8-way scan; returns the
  first live enemy tile suitable for a `single-adjacent` swing
- `placedWeaponRangeKind(heroId, slotIdx)` — pure read; lets a
  scenario decide whether to call `useWeaponAbility` with
  `single-adjacent` vs. `die-roll-fixed` vs. `fixed-pattern`

**Scenarios added:**
- `combat-run-away` — both delvers prepare-to-run on turn 1,
  exercising the bothPrepared → parting-shots flip without any
  combat damage.
- `combat-brute` — primitive tactical AI: place a weapon every
  turn, swing at adjacent enemies when the placed weapon is
  `single-adjacent`. Real `applyKill` + `applyPendingLevelUps`
  fire as enemies die.
- `combat-monkey` — seeded random hero-phase actions (mix of
  prepare / play+swing / pass) with random counter rolls 1..6.
  25 seeds run as a property test in the vitest smoke suite.

## Phase 4 — movement / slot abilities / AP economy (shipped)

Closes the Phase 3 gap where every tactical scenario stayed on
the spawn tile and never spent an AP token.

**Wrappers added to `QaSession`:**
- `legalMovementTiles(heroId)` — pure read of `legalStepDestinations`
- `moveStep(heroId, toX, toY)` — wraps `moveDelverStep` (8-way
  single-step + tile-drop claim)
- `endMovementStep(heroId)` — wraps the explicit "I'm done
  stepping" latch
- `spendApDoubleMovement(heroId)` — wraps `spendApDoubleMovement`
- `spendApRefreshWeapon(heroId, slotIdx)` — wraps `spendApRefreshWeapon`
- `useSlotAbility(heroId, slotIdx, options?)` — wraps
  `useSlotAbility`; auto-builds matching {@link SlotAbilityParams}
  from the printed `delverBoards.json` entry (target / recipient
  overrides supported)
- `useSlotAbilityAndResolve(heroId, slotIdx, counterRoll?, options?)`
  — convenience wrapper: drives `useSlotAbility` AND resolves
  the returned `damage-session` (if any) through
  `resolveSharedCounter` + `finalizeAttackSession`
- Read helpers: `nearestLiveEnemy(heroId)` (any range),
  `bestStepToward(heroId, x, y)` (closest 1-step destination by
  Chebyshev distance)

**Scenarios added:**
- `combat-mover` (`combatMover.ts`) — walk toward nearest enemy
  via `moveDelverStep` before swinging.
- `combat-slot-ability` (`combatSlotAbility.ts`) — fire the
  printed SLOT ABILITY every turn instead of the weapon range.
- `combat-token-spender` (`combatTokenSpender.ts`) — spend 1 AP
  on double-movement before every placement; spend 2 AP to
  refresh the placed slot when no swing is possible.

**Invariants added:**
- `pending-modals-capped` — total pending entries across all 4
  modal queues ≤ 32.
- `positions-on-board` — every delver / live enemy sits inside
  the wave's `boardSize`.
- `movement-non-negative` — `0 ≤ currentMovement ≤ 16`.

### Future extensions

- **Attack range kinds beyond `single-adjacent`** — `combat-brute`
  / `combat-mover` only swing when the placed weapon is
  `single-adjacent`. Adding wrappers for `die-roll-fixed`
  (Hammer), `chain` (Gauntlet), `straight-line` (Beam),
  `fixed-pattern` (Trident), and the Trident `preAttackMove`
  variant would catch bugs in `computeWeaponHitTiles` for each
  shape. A `combat-rangekinds` scenario that places one of each
  weapon type sequentially is the lowest-friction way to land
  this.
- **Double-damage token spend on `useWeaponAbility`** — Q2's
  shop grants Double Damage tokens. A `combat-dd-spender`
  scenario that passes `spendDoubleDamage` to every swing would
  exercise `canSpendDoubleDamage` + the typed/universal
  matching gate + the post-spend `actionUsedThisTurn` interaction.
- **Tactical invariants (deferred):**
  - **wave-bounded turn count** — `enc.partingShotCursor` /
    a future `enc.heroTurnCount` ≤ some sane bound; catches
    infinite-loop bugs in `endHeroTurn` (today, scenarios
    bound the loop themselves rather than the invariant).
  - **counter-damage conservation** — sum of counter-attack
    damage attributed in `session.steps` matches the per-delver
    HP loss observed by `onDelverDamaged`; catches orphan
    damage (would manifest as ghost-HP-loss with no source).
  - **AP spent matches AP debited** — wraps `chargeAp` with an
    audit log and asserts `before - after === expected`;
    catches off-by-ones in `spendApDoubleMovement` /
    `spendApRefreshWeapon` / the Battery AP top-up. Requires
    instrumenting `chargeAp` (which is currently a private
    function), so deferred until there's a concrete bug to
    repro.
- **Element bag overflow guard** — the engine caps element
  tokens at 2 per kind per delver via `grantElementToDelver`,
  but the invariant pipeline doesn't enforce that cap
  independently. Adding `checkElementBagCap(state)` would
  catch a path that bypasses the helper.

## Triage workflow

1. `npm run qa -- --verbose` (or open a CI failure).
2. Find the failing `(scenario, seed)`.
3. Open the matching `qa-reports/*.md`.
4. Look at the **action that triggered** the violation — usually
   the bug is in the engine call immediately above the violation.
5. Read the **trace leading up to step N** to recover the campaign
   state shape.
6. Reproduce with `npm run qa -- --scenario=NAME --seed=N --always-write`
   while iterating on the fix.
7. After fixing, add the failing seed to
   `src/__tests__/qa.test.ts > "monkey at seed N"` as a regression
   guard (or simply increase the seed-fan range if N < 25).

## Architecture

```
src/qa/
├── seededRandom.ts       — mulberry32 + helpers (pickOne, coinFlip, randInt)
├── invariants.ts         — all the property checks
├── session.ts            — QaSession: state + RNG + trace + auto-invariants
├── runner.ts             — runScenarioInMemory + runScenarioToReports
├── bugReport.ts          — markdown + JSON serialisers
├── cli.ts                — argv parsing for `npm run qa`
└── scenarios/
    ├── types.ts                — Scenario contract + MAX_STEPS
    ├── index.ts                — registry
    ├── happyPath.ts            — deterministic Ch1+Ch2 walk
    ├── monkey.ts               — seeded-random Ch1+Ch2 walk
    ├── quest2Fullrun.ts        — Q2 W1→W2→W3 via debugWinWave (Phase 2)
    ├── combatRunAway.ts        — both delvers prepareToRun (Phase 3)
    ├── combatBrute.ts          — primitive tactical AI (Phase 3)
    ├── combatMonkey.ts         — seeded-random hero phase (Phase 3)
    ├── combatMover.ts          — walk before swinging (Phase 4)
    ├── combatSlotAbility.ts    — fire slot abilities (Phase 4)
    ├── combatTokenSpender.ts   — spend AP every turn (Phase 4)
    └── edgeCases.ts            — surgical edge tests

scripts/qa.mjs            — Node entry that shells to tsx
```

`session.ts` exports action wrappers for:
- Town visit / shop / opinion redemption / donation (Phase 1)
- Wave lifecycle: `bootstrapWave`, `autoPlaceSpawns`,
  `startWaveAfterPick`, `winWaveViaDebug`, `resolveAllPartingShots`,
  `continueToWave` (next wave + End Wave "if continuing" effects),
  `completeWave`, `endQuestReset`,
  `drainOpinionPicks`, `grantQuest2KeyItem` (Phase 2)
- Tactical combat: `prepareDelverToRun`, `playWeapon`,
  `useWeaponAbility`, `resolveAttackSession`, `endHeroTurn`,
  `drainPendingModals`, plus read helpers `firstPlayableWeapon`,
  `adjacentLiveEnemy`, `placedWeaponRangeKind` (Phase 3)
- Movement / slot abilities / AP economy: `legalMovementTiles`,
  `moveStep`, `endMovementStep`, `spendApDoubleMovement`,
  `spendApRefreshWeapon`, `useSlotAbility`,
  `useSlotAbilityAndResolve`, plus read helpers
  `nearestLiveEnemy`, `bestStepToward` (Phase 4)

The runner imports engine functions directly — it never touches the
DOM, localStorage, or the router. That keeps the harness portable
across CI runners and importable from non-vitest contexts (e.g.
future replay tooling that re-runs a JSON bug report).
