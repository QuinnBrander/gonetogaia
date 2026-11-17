# G2G — Design Document

**Source of truth.** This document captures the canonical rules of the
prototype, derived from the printed rulebook and storybook in
`ASSETS/Gone to Gaia/`. When the rules and a chat instruction conflict, the
rules win — flag the conflict back to the user before implementing.

When something here is wrong or incomplete, fix the doc *first*, then change
the code. Every gameplay-shaping change should leave a paper trail here.

Page references below are to `Gone to Gaia - Rulebook - 8.5x11 v1 PROOF 3.pdf`.
(PROOF 6 is the current rulebook; most rules moved one page earlier, e.g.
Parting Shots / End of Wave are on p25.)

> **Designer decisions 2026-11-17 (override older text below where it
> disagrees):**
> 1. **The wave has 3 phases: Delver (Hero) Phase → Parting Shots → End
>    Wave.** There is no Interlude Phase (Nov 15 player aid). See §4.
> 2. **Harvester pays at End Wave** — every wave end, defeat included
>    (living bearers only). **Elemental OS** gives its elements at the end
>    of the wave, as the card says. Armor heals, Sol / Lunar Shield
>    element gains and the Elayna / Rodrigo opinion penalties (printed
>    "Interlude") apply at End Wave **only when the party continues** to
>    the next wave. See §4.2.
> 3. **Block Counterattack** (was "Prevent Counter"; internal token id is
>    still `prevent-counterattack`) cancels one enemy's counterattack
>    completely, side effects included (no Rotates / Alert / Flees ...).
>    See §5.5.2.
> 4. **No per-turn cap** on Reroll or Block Counterattack. Double Damage
>    keeps its printed 1-per-turn cap. See §5.5.2.

---

## 1. Scope of this prototype

- **Audience:** designer-side digital playtest tool for Quest #1 only.
- **Mode:** hot-seat 2-player co-op (Disciple of the Mind + Disciple of
  the Body). No solo mode, no chapter 2+, no town visits, no shop.
- **UI bias:** mechanical accuracy and easy data editing over polish.
- **Quest #1 goal (rulebook p8 / storybook ch1):** *"Survive to the end of Wave 1."*

Anything outside this scope (chapters 2+, scars, witness, memory chips,
shop, fundraising, opinion cards) is **explicitly out of scope** unless we
expand the doc to cover it.

---

## 2. Resource model — per-delver vs shared

This is where conversational instructions have led to bugs in the past, so
it's the most important table in the doc.

| Resource | Scope | Source |
|---|---|---|
| HP (current + max) | **Per-delver** | p14 ("Tracking HP") |
| Movement value | **Per-delver** | p13 |
| Damage values (Light / Medium / Heavy) | **Per-delver** | p13–14 |
| AP tokens (current + base) | **Per-delver** | p15 |
| Element tokens | **Per-delver**, capped at 2 per element | p17 |
| Weapon slots (6) | **Per-delver** | p13, 17 |
| Loadout (cards in slots, hand) | **Per-delver** | p13 |
| Minion Parts | **Per-delver** (each player gets their own copy of any drop; dead delvers skipped — see §3.5) | p23 |
| Boss Parts | **Per-delver** (level-keyed dropId, flat counter — see §3.5) | p23 |
| Memory Chips | **Shared** (single counter) — we **deviate** from the rulebook (p29 says per-delver). User decision 2026-05-18: shared is simpler for the digital prototype and there's no Q1 spend mechanic to disambiguate yet. Revisit if a per-delver spend lands. | p29 |
| Consumable tokens (reroll / Block Counterattack / 2× damage / ignore ability) | **Per-delver** | p15–16 |
| Scars | **Per-delver** | p12 (out of Q1 scope) |
| **XP** | **SHARED** | p23: *"both players immediately gain the amount of XP listed on that enemy's card"* |
| **Level** | **SHARED** | p24: single Level Track on the Birds Nest display |
| Level Up Cards owed | Per-delver count (each player draws their own card per level-up) | p24 |
| Wave / quest state (active wave, spawn layout) | **Shared** | p10 |

**Default rule of thumb:** if a resource lives on a Delver Suit Board, it's
per-delver. If it lives on the Birds Nest Display or the Tide Board, it's
shared.

---

## 3. XP and leveling

### 3.1 XP gain

- XP is granted by **enemy death**, *after* the dying enemy's
  Counter Attack has resolved (p23).
- Both players gain the listed XP into the **single shared XP pool**.
- The XP pool starts each quest at 0 (p4, setup step L).

### 3.2 Leveling up

- Players start each quest at **Level 0** with **0 XP**.
- Level is tracked separately from XP. **XP is *spent* to level up**, not
  accumulated as a running cumulative threshold (p24: *"Subtract the
  required amount of XP from the XP Track / Move the Level marker up
  1 space"*).
- Per the printed XP/Level board, the cost to advance is:

  | From → To | XP cost |
  |---|---|
  | Level 0 → 1 | 1 |
  | Level 1 → 2 | 3 |
  | Level 2 → 3 | 5 |
  | Level N − 1 → N | **2N − 1** |

- When players level up, **each player draws 1 Level Up Card** and
  chooses 1 reward (p24). The prototype models the **base** (28-card)
  level deck in full — see §3.4. Ultra cards (printed cards 29–32)
  are unlocked later in the campaign and are excluded from the deck
  for the current implementation.
- **Ruling (2026-11-15):** a drawn Level Up Card with no legal pick
  (every type it allows is maxed or locked at R3) is simply discarded,
  with no rank and no redraw (`discardUnplayableLevelUpDraw`; the modal
  shows a "Discard card" button).
- If a single attack grants enough XP to level multiple times,
  **resolve one level-up at a time** (p24). Each level-up enqueues
  ONE pending draw per delver onto
  `state.encounter.pendingLevelUpDraws`, in `delverOrder` (hero-01
  then hero-02). End Turn / phase advance is **gated** on the queue
  being empty.

### 3.3 Auto-level vs. manual

For this playtest tool we **auto-level** as soon as `xpOnHand >= cost`,
in the same call to `applyPendingLevelUps`. Each level-up:
1. spends the cost out of `xpOnHand`,
2. increments `currentLevel` by 1,
3. increments the bookkeeping `levelUpCardsOwed` counter, and
4. pushes 2 entries onto `encounter.pendingLevelUpDraws` (one per
   delver, in hero-id order), each pre-locked to a card drawn off
   `encounter.levelUpDeck`.

### 3.4 Level-Up draw flow (rulebook p24)

**Data**: `data/levelDeck.json` lists all 28 base level cards. Each
entry has a `cardNumber` (1..28), an `image` (`/levelup/levelup_NN.jpg`),
and a `types` array of exactly 3 `EquipmentType` strings — the three
choices printed on the card.

**Deck management** (`engine/levelUp.ts`):
- The deck is **shuffled fresh per encounter** in
  `buildEncounter` (encounter-scoped, not campaign-scoped). It lives
  on `encounter.levelUpDeck` as a `number[]` of card numbers.
- `drawNextLevelUpCard` pops off the front. If the deck is empty,
  it reshuffles `encounter.levelUpDiscard` and pulls from there
  (rulebook p24 — defensive: 28 cards is more than enough for one
  quest, but the path is implemented).

**Pending queue** (`encounter.pendingLevelUpDraws`):
- Each pending entry is `{ heroId, cardNumber }`. The card is
  *already drawn* — locking the printed identity prevents weirdness
  if the deck shape changes mid-resolution.
- The UI's `LevelUpModal` (`screens/LevelUpModal.ts`) reads the
  HEAD of this queue. After a pick, the queue pops; if the next
  entry is non-empty the modal stays open and re-renders against
  the new head; otherwise the modal closes and the post-action
  cleanup runs (clear action state + maybe-auto-end-turn — the
  same tail `ActionResolution.advanceAfterAction` runs for actions
  that didn't trigger any level-ups).

**Equipment ranks** (`state.equipmentRanks`):
- Per-delver per-`EquipmentType` rank table. R0 = not owned,
  R1..R5 = owned at that rank. Initialized in `state.ts >
  newEquipmentRanks` from the hero's starting equipment list (R1
  for each starter type, 0 elsewhere).
- `applyLevelUpChoice` validates that the chosen `type` is one of
  the 3 printed on the drawn card and that the delver isn't at the
  cap, then bumps `equipmentRanks[heroId][type]` by +1.
- The hand (`screens/HandPanel.ts`) and the slot art
  (`screens/SuitPanel.ts > buildSlotEl`) consult this table to
  render the rank-correct card image via
  `data.ts > imageForRank(suit, type, rank)`.
- Combat damage scales by the rank table via
  `engine/combat.ts > effectiveDamageForCard` — R3 Chain Gauntlet
  deals 3× LIGHT, etc.

**Trigger / gate**:
- The modal opens off `ActionResolution.advanceAfterAction` (the
  shared post-action tail) whenever `hasPendingLevelUpDraws(state)`
  is true after an attack session finalizes — there is no longer
  an "Action resolved" intermediate modal between the action and
  the level-up flow.
- A pulsing pill in the BoardScreen turn indicator surfaces the
  pending count even if the user dismisses the modal — clicking it
  re-opens.
- End Turn is **disabled** while any pending draw remains.

### 3.5 Monster Parts (rulebook p23 "Gaining XP and Monster Parts")

When an enemy dies, its on-death rewards (printed on the card) are
applied by `engine/kills.ts > applyKill` AFTER the dying enemy's
Counter Attack has resolved. The reward bundle is:

1. **XP** → SHARED `state.xpOnHand` / `state.totalXp` (see §3.1).
   Static amounts bank immediately; the "Gain 1 [die] XP" variant
   (`onDeath.gainXpDice` — Ophidian 017, Sporecloud 022) instead
   enqueues a PLAYER-FACING d6 roll on `encounter.pendingXpRolls`
   (designer ruling 2026-07-20: the roll happens in front of the
   user via the `xp-roll` modal; `applyXpRoll` banks the result and
   resolves any level-ups it affords).
2. **Monster Parts (drops)** → placed on the dying enemy's tile as
   `EncounterState.tileDrops` entries; PICKED UP later when a delver
   walks onto the tile (§3.5.3 covers the deferred-pickup model).
3. **Element tokens** → PER-DELVER, capped at 2 per element (§5.4.x).
4. **Level Up cards** (printed "Gain a LEVEL UP card", every quest
   boss) → bookkeeping increment (§3.4) AND one interactive
   LevelUpModal draw enqueued PER DELVER per card (active delver
   first) on `encounter.pendingLevelUpDraws` — the same queue the
   XP-threshold path uses, so the modal + End Turn gating apply
   unchanged. (Fixed 2026-07-20; previously bookkeeping-only, so
   boss kills silently skipped the printed reward.)

#### 3.5.1 Per-delver drop semantics

Per the rulebook (p23) and §2 of this doc, **every drop in the
enemy's `onDeath.drops` array is owed ONCE per LIVING delver**. So a
Crystanid that prints `["minion-part"]` produces TWO `TileDrop`
entries (one owed to Mind delver, one to Body delver) on the dying
enemy's tile — a single shared physical drop on the tabletop becomes
two per-delver claimable tokens in the prototype.

Iteration order in `applyKill`:

```
for (dropId of enemy.onDeath.drops ?? []) {
  for (heroId of heroIds) {
    if (loadout dead) continue;            // §3.5.3 dead-delver skip
    enc.tileDrops.push({ x, y, heroId, dropId })
    dropsByPlayer[heroId][dropId]++        // UI-facing per-drop log
  }
}
```

`KillResult.dropsByPlayer` always has an entry per hero (empty `{}`
if that delver received nothing — including the dead-delver case),
so the UI can iterate consistently. Dropped IDs are stored verbatim
on the `TileDrop` — counter routing (which dropId bumps which
counter) happens at PICKUP time in `moveDelverStep > collectTileDrops`,
not at kill time (see §3.5.3).

#### 3.5.2 dropId conventions (data → engine)

The engine recognises three drop ID shapes today (routing happens
at PICKUP in `moveDelverStep > collectTileDrops`, NOT at kill time):

| dropId                  | Bumps                | Notes |
|-------------------------|----------------------|-------|
| `"minion-part"`         | `state.minionParts`  | All Q1 minions (Crystanid 1–7). |
| `"boss-part"`           | `state.bossParts`    | Bare/level-less form, forward-compat for a future generic boss-part. |
| `"boss-part-lvl-<N>"`   | `state.bossParts`    | **Level-keyed** form. The `<N>` is the boss's level (matches `EnemyKind = "boss-lvl-<N>"`). The level lives in the dropId so the UI can route to the right per-level token art (`/tokens/boss-lvl-N-{suit}.webp`). State stores a flat per-hero count — Quest 1 only ships the lvl-1 art. |

Anything else that appears in `drops` is still placed on the tile
(so it doesn't get silently dropped) and reported in
`KillResult.dropsByPlayer` / `MoveResult.pickups`, but does **not**
bump either dedicated counter at pickup time. The UI can surface
"you picked up an unknown token" if it ever wants to.

The strict `boss-part-lvl-` prefix (rather than `boss-part`) was
chosen on 2026-05-04 to avoid silently crediting unrelated ids like a
hypothetical `"boss-part-shard"` — see the regression tests in
`__tests__/movement.test.ts > moveDelverStep — per-step pickup` and
`> collectTileDrops`.

Quest 1 wiring:

- All 7 Crystanid minions print `"drops": ["minion-part"]` →
  one `TileDrop` placed per living delver per kill on the dying
  enemy's tile.
- Soulhunter (level-1 boss) prints `"drops": ["boss-part-lvl-1"]` →
  one `TileDrop` placed per living delver on the boss's tile,
  plus `gainLevelUpCards: 1` for the printed "gain a LEVEL UP
  card" reward (which is NOT a tile drop — it bumps the bookkeeping
  counter immediately AND enqueues one LevelUpModal draw per delver,
  active first; see §3.5 item 4).

#### 3.5.3 Deferred pickup model (wired 2026-05-04)

Drops live on `EncounterState.tileDrops` between the kill and the
collect, mirroring the rulebook's tabletop flow ("drops are placed
on the dying enemy's tile, picked up by walking onto it"). Each
entry is `{ x, y, heroId, dropId }` — one entry per (drop × living
delver), so each delver has their OWN claimable token sitting on
the tile.

**Placement** (`engine/kills.ts > applyKill`):

- Called from `engine/combat.ts > finalizeAttackSession` once the
  shared counter has resolved and the enemy's `alive` flag flips
  to `false`. The dying enemy's `(x, y)` is forwarded as the
  third argument so `applyKill` can anchor the drops at the kill
  tile (the static `EnemyCard` doesn't carry a position).
- For each `dropId` × each LIVING delver, pushes one `TileDrop`.
  Dead delvers (currentHp ≤ 0) are skipped — see §3.5.4.

**Pickup** (`engine/movement.ts > moveDelverStep` →
`collectTileDrops`):

- After `delverPositions[heroId]` is updated, scans
  `enc.tileDrops` for entries with `(x, y) === destination` and
  `heroId === moving delver`. Matched entries are removed and
  the corresponding counter is bumped (`minionParts` or
  `bossParts` per §3.5.2).
- Does NOT cross hero boundaries: a delver only claims drops
  owed to THEM (`heroId` field on the `TileDrop`). The other
  delver's pile sits untouched until they walk onto the tile
  themselves.
- Returns the picked-up entries on `MoveResult.pickups` so the
  UI can surface a "+1 minion part" toast / animation.

**Per-step pickup (DESIGN.md §5.1.1, 2026-05-09)**: pickup fires
on EVERY step's destination tile, not just the final tile of a
movement session. With step-by-step movement (the only model
since the 2026-05-09 refactor) a delver walking from `(0,0)` →
`(1,1)` → `(2,2)` claims drops on both `(1,1)` AND `(2,2)`.
Doubling back over a tile that has already been cleared yields
an empty pickup result for that step. Regression coverage in
`__tests__/movement.test.ts > moveDelverStep — per-step pickup`.

**Surge Claw `collect-creature-part`**: this Slice-5 weapon
post-effect bumps `state.minionParts` directly without consulting
`tileDrops` — a "remote pickup" that bypasses the on-tile pile.
This is an intentional carve-out (the printed effect text reads
"collect a part from any tile / this tile" — i.e. the effect IS
the pickup, no walk required); the implementation predates the
deferred-pickup model and stays as-is. A future R2+ Surge Claw
that explicitly draws from on-board piles can switch to
consuming `tileDrops` entries instead.

#### 3.5.4 Dead-delver skip (design decision 2026-05-04)

A delver at `currentHp <= 0` does **not** have a `TileDrop`
created for them when an enemy dies. This mirrors the
dead-bearer gating used by other "the delver needs to be
functional" effects:

- Harvester `gain-tokens-at-end-of-wave` (§4.2)
- Providence OS `bonus-xp-on-kill`
- Sol / Lunar Shield `gain-element-at-end-of-wave`

The alive delver still gets their token on the tile. If both
delvers are downed, no `TileDrop` lands — but the
wave-end-on-death short-circuit (§5.9.5) will already have
triggered the loss flow before any further kills are processed
in practice.

**Revival doesn't retroactively grant skipped parts**: if a
delver is downed when the kill happens and revives later (e.g.
healed back above 0 HP), the parts they were skipped on are
gone — no `TileDrop` was ever created for them. This is a
deliberate simplification (matching the tabletop "you weren't
there to grab it" intuition); revisit if Q2+ ships an
"unconscious but still entitled" rule.

XP is **not** subject to this skip: it's a SHARED pool and lands
unconditionally even if every delver is currently at 0 HP (it's
spent later, after revival on the retry flow).

#### 3.5.5 UI surfacing

**Campaign sheet** (`screens/CampaignSheet.ts`) renders the
per-suit token art for each delver's two CLAIMED counters
(post-pickup):

| Counter              | Mind delver art            | Body delver art            |
|----------------------|----------------------------|----------------------------|
| `state.minionParts`  | `/tokens/minion-mind.webp` | `/tokens/minion-body.webp` |
| `state.bossParts`    | `/tokens/boss-lvl-1-mind.webp` | `/tokens/boss-lvl-1-body.webp` |

The art is **suit-keyed**, not delver-keyed: the same icon family is
reused if a future delver shares the suit. The boss-part art is
hardcoded to `lvl-1` for Q1 since that's the only level shipped; later
quests will need a `level → art` lookup once `state.bossParts` either
gains a per-level breakdown or the encounter records the boss level
that produced each drop.

**Tide board** (`screens/BoardScreen.ts > renderTokens`) renders
each `TileDrop` as a small token CENTRED on its tile. Multiple
drops on the same tile fan-out horizontally and SYMMETRICALLY
around the centre (so 1 drop sits dead-centre, 2 drops sit edge-
to-edge across centre, 3 drops put one centre + one each side,
etc.) so each delver's pile reads independently. Drops only
appear AFTER the enemy is dead — `enemy.alive` gates the enemy
render path so the centre real estate is free by the time the
drop tokens land. Art is resolved by
`board/tideBoard.ts > dropArtFor(dropId, suit)`:

- `minion-part` → `/tokens/minion-{suit}.webp`
- `boss-part-lvl-N` → `/tokens/boss-lvl-N-{suit}.webp`
- `boss-part` (bare) → `/tokens/boss-lvl-1-{suit}.webp` (no
  level info → defaults to lvl-1 which is the only art shipped)

The drop's outer rim brightens to gold (`.board-token--drop-active`)
when the matching delver is the active turn — a small affordance
that says "this is yours to grab".

---

## 4. Turn / wave structure (p3, p25–26; 3 phases per designer decision 2026-11-17)

Each Wave proceeds through **3 phases** in order (Nov 15 player aid —
the rulebook's Interlude Phase is gone):

1. **Delver Phase** (called Hero Phase in the code and rulebook) —
   players alternate turns until both have *Prepared to Run*. Each turn
   proceeds in two stages:
     1. **Mandatory turn-start choice**: either (a) exhaust one Weapon
        Card from hand into an empty Weapon Slot ("**placement**"), or
        (b) declare **Prepare to Run** (§5.7).
     2. **Optional follow-ups** (only if option (a) was taken): up to 1
        Movement step **and** up to 1 Action step, in either order. The
        Action is one of {use the placed Weapon Card's printed ability,
        use the placed Slot's printed ability, move Witness} — pick
        exactly one. A turn may also end here with neither follow-up taken.
   Placement is **irreversible** within the same turn (cannot un-place
   or swap to a different card). *Confirmed by user 2026-05-02.*
2. **Parting Shots Phase** — every enemy still on the board resolves
   its Parting Shot ability one at a time; then enemies and uncollected
   items are removed.
3. **End Wave Phase** — first the **End Wave refresh** (§4.2): spent
   consumables and exhausted weapons refresh, AP refills, Harvester
   pays. Then the wave's End-of-Wave entry from the storybook is read
   and the party either leaves the Tide (retreat, quest complete,
   defeat) or **continues**: the "if continuing" effects apply (§4.2),
   the next wave is set up (spawn card, starting tiles, boss card back
   Suit Condition pick, new enemy abilities).

A wave also ends immediately if any Delver dies (p25: *"the current
Phase immediately ends and both players proceed directly to the End of
Wave Phase"*). The End Wave refresh still runs (so Harvester pays its
living bearers on a defeat too).

### 4.1 Per-turn refresh (start of a Delver's turn)

At the **start** of a Delver's Hero Phase turn:
- `currentMovement` is reset to `baseMovement` (= `Tuning.startingMovement`
  unless modified by a passive).
- `currentAp` is **NOT** reset per-turn (AP unification, 2026-05-09).
  AP is now a per-Wave pool that refreshes at End Wave (§4.2). The
  per-turn flags (`apMovementDoubledThisTurn`, `damage2xUsedThisTurn`,
  `consumableSpendsThisTurn`) DO clear per turn, so each turn the
  player can spend a fresh once-per-turn cap of consumables; only
  the AP currency itself persists.
- Exhausted Weapon Cards do **NOT** refresh per-turn — they refresh at
  End Wave (§4.2) or via the in-wave refresh costs in §4.3. *Confirmed
  by user 2026-05-02.*

> **AP unification (2026-05-09).** The old design had two AP buckets:
> a per-turn-refreshing "board AP" (`loadout.currentAp` reset to
> `baseAp` here) and a per-Wave-refreshing "AP consumable token" granted
> by Battery. Mechanically these were identical — both refreshed during
> Interlude in the consumable-token model — except for the per-turn
> top-up the board pool got. Per user direction, both are now the same
> single per-Wave pool (`loadout.currentAp` / `loadout.baseAp`). The
> `"ap"` `ConsumableTokenKind` was deleted, `engine/turn.ts` no longer
> refreshes `currentAp` here, and Battery's "+1 AP" outcome bumps
> `baseAp` directly (see §5.4 Battery — AP outcome). A v21→v22 schema
> migration in `state.ts > migrateV21ToV22` folds banked AP tokens
> from in-progress saves into `baseAp` (`available + spent`) and
> `currentAp` (`available`).

### 4.2 End Wave refresh + "if continuing" effects (designer decision 2026-11-17)

**End Wave refresh — every wave end, victory or defeat.** Runs inside
`engine/wave.ts > enterEndOfWave` (private `applyEndWaveRefresh`):

- All exhausted Weapon Cards return to the owner's hand.
- **`currentAp` resets to `baseAp` for both delvers** (per-Wave AP,
  AP unification 2026-05-09). Quest-long `baseAp` bumps (Battery's
  "+1 AP for the rest of the quest") are honored automatically.
- All Spent consumable tokens flip back to Available across **both
  delvers and all kinds** (`refreshAllSpentTokens`).
- **Harvester** (`gain-tokens-at-end-of-wave`, "You gain N minion part
  tokens at the end of each wave") pays every **living** bearer —
  also on a defeat. New Harvester pays a boss part of its rank's level.

The result is stored on the encounter as `enc.endWaveRefresh`
(`EndWaveRefreshResult`: weapons refreshed per delver, consumable count,
Harvester lines). Its presence is also the **latch**: a second
`enterEndOfWave` doesn't refresh or pay again. Every End of Wave screen
shows it as an "End Wave" card (`WavePhases.ts > renderEndWaveRefreshHtml`),
which also works for an online guest because it's on the synced state.

**"If continuing" effects — only when the party goes on to the next
wave** (End Wave step A, "Gain End of Wave passive equipment
benefits"). They're pointless when leaving the Tide because HP and
elements reset at the end of a quest. `engine/wave.ts >
applyContinuingEndWaveEffects`, called by `bootstrapNextWave` (every
"Continue → Wave N" path uses it: Q2 continue choices, the data-driven
Ch3+ End of Wave, Quick Start and the QA harness), in this order:

1. Elayna / Rodrigo opinion penalties (cards print "at the start of
   each Interlude Phase"): Elayna Detractor / Nemesis — each delver
   loses 2 / all elements; Rodrigo Detractor / Nemesis — lose 2 / all
   XP on hand.
2. Armor heals (`heal-at-end-of-wave`, R1 = 1 HP ... R5 = 5 HP, read
   off the rank-correct card; clamped to `maxHp`).
3. Elemental OS (both delvers) and Sol / Lunar Shield (bearer)
   element picks (`gain-element-at-end-of-wave`), queued on the **new**
   wave's `pendingElementChoices`. The board opens the element-pick
   modal when the wave's Delver Phase starts, and End Turn waits for it.

It returns `RewardEvent`s (`kind: "wave-effect"`, one plain line each)
that the End of Wave screen adds to the rewards modal shown before the
next wave.

**Save migration (v64 → v65, `state.ts > migrateV64ToV65`).** An
encounter saved in the old `"interlude"` phase is parked on
`"parting-shots"` with the cursor past the last enemy, so the Parting
Shots screen's Continue enters End Wave. If the old Interlude had
already refreshed, that is recorded as `endWaveRefresh` so End Wave
doesn't refresh (or pay Harvester) twice. Old-timing OS element picks
are dropped; `interludeApplied` / `interludeResult` are removed.

### 4.3 In-wave Weapon refresh (mid-Hero-Phase)

After a Weapon Card is played and its ability resolves, it becomes
**exhausted** and stays exhausted for the rest of the wave by default.
It is **not** refreshed automatically at the start of the owner's next
turn. *Confirmed by user 2026-05-02.*

There are **two** ways to refresh a Weapon mid-wave:

#### 4.3.1 Spend 2 AP — refresh ONE exhausted weapon

Active delver pays **2 AP** from their own pool. Picks any one of their
own occupied slots (does not have to be this turn's just-placed slot;
may even be the just-placed slot, in which case the placement latch
also clears so the player can place again). Card returns to hand;
slot empties. *Confirmed by user 2026-05-02.* Implemented in
`engine/turn.ts > spendApRefreshWeapon`.

#### 4.3.2 Auto-refresh on placement — spend 2 matching Elements

Each Weapon Slot has a printed Element symbol and an "element well"
above it that holds **up to 2 element tokens of that element**
(rulebook p17: *"Weapon slots are composed of 6 distinct sections that
can contain 2 element tokens and a weapon card."*). Element tokens
are auto-routed to the matching slot when gained — the per-element cap
of 2 per delver (rulebook p17 — *"any earned beyond that cannot be
gained"*) is the same as the per-slot well capacity, since each
element appears on exactly one slot per board.

When a player places a weapon into a slot whose well **already holds
2 matching elements**, the placement immediately:

1. Spends both element tokens (returned to the community supply).
2. Refreshes the just-placed weapon back to the player's hand
   (`loadout.slotCards[slotIdx] = null`).
3. **Still satisfies the mandatory placement** for the turn: the
   `cardPlacedThisTurn` latch stays set, with
   `autoRefreshedElement` recording which element was consumed (so
   `undoWeaponPlacement` can restore the 2 tokens on undo).

The player may then take their normal Action step — **both** the
weapon's ability and the slot's ability remain available because the
action gate (`engine/turn.ts > checkActionGate` and the body of
`useWeaponAbility` / `useSlotAbility`) reads the placed card from
`cardPlacedThisTurn.cardId`, not from `loadout.slotCards[slotIdx]`.
*Confirmed by user 2026-05-02 (option a-both-abilities).*

The rulebook is silent on the exact ordering for this combined
"spend 2 elements to refresh" path; this auto-on-placement model is
the natural reading of the visual stacking on the printed board
combined with the spend-2-elements-to-refresh entitlement, and is
mechanically clean (no separate "spend elements" UI flow needed).

Implementation lives in `engine/turn.ts > playWeaponCard`. The
returned `TurnActionResult.autoRefresh` field surfaces the event for
the UI; `screens/SuitPanel.ts` stashes the most recent occurrence on
`uiState.lastAutoRefresh` and `screens/BoardScreen.ts` renders a
transient "REFRESHED" banner above the board.

##### Symmetric counterpart: auto-refresh on element GAIN (2026-05-09)

The "2 matching elements + placed weapon = consume both, return weapon
to hand" rule is **order-independent**: it must fire whether the 2nd
token arrives BEFORE placement (handled in `playWeaponCard`) or AFTER
placement (handled in `engine/kills.ts > grantElementToDelver` via
the `maybeAutoRefreshOnElementGain` helper). Without the gain-time
path, this state was reachable: place the Beam in the mind earth slot
with earth=1, then have the OTHER delver kill a Crystanid (which
grants +1 earth to BOTH delvers) — your earth bag goes to 2 with the
Beam still occupying the slot, an illegal state under the printed
board's well capacity (2). User repro 2026-05-09.

The gain-time path runs after every successful (non-cap-overflow)
grant and is scoped strictly to the gaining delver's bag/slots. If
the affected slot was placed by the bearer THIS turn, the latch's
`autoRefreshedElement` is upgraded from `null` to the consumed
element so `undoWeaponPlacement` continues to restore the spent
tokens correctly. Logged as `engine.spendElement` with
`reason: "weapon-auto-refresh-on-gain"` (vs the placement path's
`"weapon-auto-refresh"`) to keep the two triggers distinguishable
in the session trace.

The gain-time path does NOT currently push to `uiState.lastAutoRefresh`
— the banner channel is owned by `SuitPanel.handleSlotClick` and the
2 AP refresh flow, both UI-side. Surfacing the gain-time refresh in
the banner would require either a UI dependency in the engine layer
(rejected — would create a cycle) or a small drained queue on the
encounter state. Deferred until user reports the silent state-change
is confusing; today the player just sees their weapon back in hand
+ 2 elements gone on the next render.

The same banner channel is reused by the AP-spend refresh path
(§4.3.1, `screens/ActionResolution.ts > onApRefreshSlot`). The toast
is a discriminated union (`reason: "element-stack" | "ap-spend"`) so
the banner reads "spent 2 X elements" or "spent 2 AP" depending on
which currency funded the refresh. **Toast lifetime is per-action**:
it survives `clearActionState` (which fires between every action via
`advanceAfterAction`), and is wiped only by (a) the next placement
that does NOT itself auto-refresh (cleared inline in
`SuitPanel.handleSlotClick`), (b) End Turn / hero swap
(`BoardScreen` end-turn handler and `turnFlow.maybeAutoEndTurn` both
call `clearLastAutoRefresh` explicitly), or (c) the player clicking
the banner's dismiss button. **Bug history (2026-05-09)**:
`clearActionState` originally wiped `lastAutoRefresh`, which
silently killed the AP-refresh banner because `advanceAfterAction`
calls `clearActionState` immediately after the toast is set. The
user reported "I picked the slot, the card is still in its slot,
and 2 AP isn't spent" — the engine call had always succeeded
(see `__tests__/turn.test.ts > USER REPRO 2026-05-09`), but
without the banner the player saw the refreshed slot empty + new
mandatory-placement prompt and assumed nothing had happened. Fix
covered by `__tests__/uiState.test.ts > clearActionState does NOT
wipe lastAutoRefresh`.

#### 4.3.3 Cap interaction — overflow is LOST

Per rulebook p17, the per-element cap of 2 is also the per-slot well
cap. When `gainElements` (from `applyKill`) or a `gain-element` slot
ability would push a delver over 2 of an element, the **excess token
is lost** ("any earned beyond that cannot be gained"). The shared
helper is `engine/kills.ts > grantElementToDelver`; it returns
`granted: false` so the UI can report the overflow.

---

## 5. Combat rules (Quest #1 subset)

### 5.1 Movement

- Up to the Delver's printed Movement value per turn (p19).
- **8-way movement**: orthogonal *or* diagonal (p19: *"orthogonally or
  diagonally"*).
- Each step costs 1 movement (Chebyshev metric) — diagonals do **not**
  cost √2.
- Enemy tiles are **fully blocking** — cannot move through, cannot
  end on. *Confirmed by user 2026-05-02.*
- Stacking with the OTHER delver is allowed (you may end your turn on
  a tile already occupied by the other delver). The spawn explicitly
  starts both delvers on the same tile (p10). *Confirmed by user
  2026-05-02.*
- Picking up Minion Parts / Memory Chips happens automatically when a
  Delver lands on their tile (p19). A player only collects parts that
  belong to *them* (p19).

#### 5.1.1 Step-by-step movement model (2026-05-09)

Movement is committed **one tile at a time**, not as a pre-planned
multi-step destination. The player taps their delver to arm a movement
session, then taps any 8-way adjacent walkable tile to step onto it,
spending 1 MP and triggering pickup on the new tile. They may keep
stepping (including doubling back over previously-visited tiles) until
either MP is exhausted or they explicitly end the session.

Why: lets the player optimise a path through creature-part drops and
react to what they uncover en route, instead of pre-committing to
a destination they might regret.

Session lifecycle:

1. **Arm** — tap delver. Adjacent legal destinations highlight; a
   floating "moves left" badge anchors to the delver tile.
2. **Step** — tap an adjacent tile. Engine calls
   `moveDelverStep`, decrements MP by 1, fires `collectTileDrops`
   on the new tile. Adjacency recomputes from the new position; the
   badge updates. The session **stays armed** as long as MP > 0.
3. **End** — either:
   - **Auto** when MP hits 0: engine latches
     `movementUsedThisTurn = true` inside `moveDelverStep`. UI sees
     the latch on the next render and drops the armed flag.
   - **Implicit** by taking the action **AFTER a step has already
     been taken** (rule refined 2026-05-18: see "Action interaction"
     below; only REMAINING MP is forfeit when the action interrupts
     a partially-stepped session) or by ending the turn.
   - **Manual disarm with 0 steps taken** — tapping the delver is a
     free disarm; re-arming this turn is allowed.

   Tapping the delver during a partial-step session that still has
   MP remaining is intentionally a **NO-OP** as of the 2026-05-09
   playtest (was previously a `endMovementStep` forfeit, but stray
   reflex taps were silently destroying remaining moves). The
   implicit ends above are the only paths that commit position
   mid-session.

One movement session per turn. Once the session ends (either path),
no further movement this turn — even with MP remaining, the
`movementUsedThisTurn` gate inside `legalStepDestinations` returns
[].

Action interaction (rule refined twice on 2026-05-18 — see "Bug
history" below):

The Action only forfeits **remaining** MP — i.e., MP left over
from a partially-stepped movement session that the action interrupts.
A delver who hasn't moved at all this turn keeps their full pool of
fresh MP, which the action does NOT consume. And any MP the player
acquires AFTER the action (e.g., by spending 1 AP for double-mov, or
from the `bonus-movement-this-turn` slot ability when they haven't
moved yet) is fully spendable, regardless of whether they later
take a step or two. This restores the rulebook's "either order"
intent: move-then-action, action-then-move, or action-then-buy-MP-
then-move are all legal.

Cases:

- **Move-only**: same as before — step until MP = 0 or end the
  turn.
- **Action-only**: same as before — never arm movement.
- **Move-then-action**: same as before — finish stepping (or
  partial-step then take the action, which forfeits whatever MP
  remained from the in-progress session).
- **Action-then-move**: legal. Take the action first, then arm a
  full fresh-MP session and step until MP = 0 or end the turn.
- **Action → AP-double-mov → move**: legal. The AP spend bumps MP
  AFTER the action, and the resulting MP is fully spendable across
  any number of steps. (USER REPRO 2026-05-18 part 4.)
- **Split sequence (move-then-action-then-move)**: blocked — the
  REMAINING MP from the pre-action session is forfeit, mirroring
  the player's intuition that "I committed my action mid-walk so
  the walk is over". **No exceptions** (designer ruling 2026-11-17),
  not even the `bonus-movement-this-turn` slot ability (see below).

Mechanism (where the rule lives):

The "did the action interrupt an in-progress movement session"
check is captured at the moment the action fires, inside
`turn.ts > endMovementSessionIfActionInterruptsIt` (called from
both `useWeaponAbility` and `useSlotAbility` right after
`actionUsedThisTurn` latches). When the helper sees
`movementStepsThisTurn > 0 && !movementUsedThisTurn`, it latches `movementUsedThisTurn =
true` — i.e., the action ends the in-progress session. Downstream
gates (`legalStepDestinations`, `BoardScreen` mirror,
cheatsheet) then read the single canonical signal
`movementUsedThisTurn` and don't need to second-guess timing.

This is the third iteration of the rule and the first one that has
the temporal context it needs. The first two attempts tried to
encode the timing inside `legalStepDestinations` itself (just from
the current snapshot of `actionUsedThisTurn` +
`movementStepsThisTurn`), but those snapshots
can't distinguish "stepped before action, now trying to continue"
(forfeit) from "stepped after action with fresh MP" (legal) — both
look identical at gate time.

Movement and Action remain otherwise independent — neither is
required, and placement still gates both.

##### `bonus-movement-this-turn` slot ability: no carve-out (§5.1.2, designer ruling 2026-11-17)

Movement is one continuous move: you can't move, use an ability and
then move again. The `+1 mov this turn` slot ability (Mind earth slot /
Body wind slot, doubled to +2 by AP-double-movement) follows the same
rule as every other action:

- **Hasn't moved yet** → the bonus joins this turn's fresh movement
  pool, spendable after the action (place + AP-double + slot = 4 MP from
  a base of 1).
- **Already stepped** → the action ends the movement
  (`endMovementSessionIfActionInterruptsIt` latches
  `movementUsedThisTurn`), so the bonus is lost.

`HeroTurnState.actionGrantedExtraMovement` is now **display only**: set
by `slotAbilities.ts > resolveBonusMovement` only when
`movementStepsThisTurn === 0`, it lets the suit panel's movement badge
show the buffed total (`SuitPanel.ts > computeTotalMovementThisTurn`).
It no longer clears `movementUsedThisTurn` or skips the latch.

History: from 2026-05-09 to 2026-11-17 this ability was a carve-out
(it re-opened movement after the bearer had moved). The designer
removed it to match the rulebook. Tests: `turn.test.ts > +1 movement
slot ability — movement stays one continuous move`,
`slotAbilities.test.ts > does NOT re-open movement that already ended`.

##### Bug history — action-gates-movement (DESIGN.md §5.1.1)

- **Pre-2026-05-18**: strict rule `actionUsedThisTurn → all movement
  blocked`. Silently blocked the Body delver from moving on turns
  they hadn't moved yet (Chain Gauntlet swing → end turn forced).
- **2026-05-18 part 2**: relaxed `legalStepDestinations` gate to
  `actionUsedThisTurn && movementStepsThisTurn > 0 &&
  !actionGrantedExtraMovement → []`. Fixed the strict-block bug but
  introduced a new one: the gate fired against
  action-then-AP-double-mov-then-step sequences because the
  `stepsThisTurn > 0` snapshot couldn't tell "stepped before action"
  from "stepped after action with fresh MP" (USER REPRO 2026-05-18
  part 4).
- **2026-05-18 part 4 (current)**: moved the check into the action
  helpers (`turn.ts > endMovementSessionIfActionInterruptsIt`) where
  the temporal context is available; `legalStepDestinations` reverts
  to a single `movementUsedThisTurn` read. Test:
  `__tests__/turn.test.ts > USER REPRO 2026-05-18 part 4 — action →
  AP-double-mov → step → step`.

Pickup (per-step, not per-session): every successful
`moveDelverStep` calls `collectTileDrops` on the destination tile,
so a delver with Movement = 2 walking across a tile with their
drop on the way to a different tile picks the drop up en route. A
delver doubling back over a tile they already cleared sees an
empty pickup result (the drops were already removed from
`encounter.tileDrops`).

#### 5.1.2 Engine surface

| Function | Purpose |
|----------|---------|
| `legalStepDestinations(state, heroId, board)` | The 8-way adjacent walkable tiles right now. Turn-state gates: placement, not Prepared-to-Run, not movement-locked (`movementUsedThisTurn`), MP > 0. Returns `cost: 1` per entry for symmetry. The action-gates-REMAINING-movement rule is captured AT THE ACTION (single source of truth in `turn.ts > endMovementSessionIfActionInterruptsIt`), so `legalStepDestinations` itself doesn't inspect `actionUsedThisTurn` — see §5.1.1 "Action interaction" + "Bug history" for why two earlier attempts to gate at this layer shipped bugs. |
| `moveDelverStep(state, heroId, x, y, board)` | One step. Validates against `legalStepDestinations`, mutates `delverPositions[heroId]`, decrements `currentMovement`, increments `movementStepsThisTurn` (per-turn counter, see below), fires per-tile pickup, latches `movementUsedThisTurn = true` ONLY when MP hits 0. Returns `{ ok, from, to, movementRemaining, sessionEnded, pickups }`. |
| `endMovementStep(state, heroId)` | Explicit "I'm done moving" latch. Sets `movementUsedThisTurn = true` without touching `currentMovement`. Idempotent. UI calls this on disarm-after-1+-steps. |
| `collectTileDrops(state, heroId, x, y)` | Single-tile pickup helper. Exposed for tests and any future "land on tile via non-movement means" caller. |
| `chebyshevDistance`, `isAdjacent8` | Pure utilities (king-move distance + adjacency predicate). |

The previous `legalDestinations` (BFS over the obstacle graph) and
`moveDelver` (multi-step move in one call) were deleted as part of
this change — no production caller after the per-step refactor.
Tests now cover `legalStepDestinations`, `moveDelverStep`,
`endMovementStep`, multi-step pickup including doubling-back, the
`movementStepsThisTurn` counter, and the action-gates-movement rule.

#### 5.1.3 `movementStepsThisTurn` counter (2026-05-09)

`HeroTurnState.movementStepsThisTurn: number` — incremented by
`moveDelverStep` on every successful step, reset to 0 by
`startHeroTurn`. The `BoardScreen` reads this to decide whether
disarming the movement overlay is a free toggle (0 steps so far,
re-armable later in the turn) or — when the player has already
stepped and MP remains — a no-op that keeps the session armed
(see §5.1.1 step 3 for the "manual forfeit" history).

Why a separate counter (instead of computing
`hasStepped = currentMovement < baseMovement` on the fly):
**`baseMovement` is not the right baseline.** AP-double-movement
(`engine/turn.ts > spendApDoubleMovement`) and the `+1 mov` slot
ability (`engine/slotAbilities.ts > resolveBonusMovement`) both push
`currentMovement` above `baseMovement` at the start of the session,
so the naive comparison reports "no steps yet" even after the player
has already moved. The 2026-05-09 movement playtest log
(session `20260509-152644-4tyt`) caught this: a Mind delver with
AP-doubled MP (`baseMovement=2`, started at 4) showed
`hasSteppedThisTurn=false` after the first step, which would have
incorrectly let the player re-arm a fresh movement session
post-action.

Schema: added in v23 (`migrateV22ToV23` in `state.ts` backfills 0
on every existing turnState; safe because step-by-step movement
only reads it within a single turn).

### 5.2 Action

A turn cannot have an Action step until the player has performed the
mandatory **Placement** of a Weapon Card into an empty Weapon Slot
(see §4 stage 1). Placement is itself a precondition, **not** the
Action — Action remains optional even after placing.

The Action step (when taken) is exactly **one** of:
- the **Weapon Card's** ability (printed on the card just placed), or
- the **Weapon Slot's** ability (printed at the bottom of the slot
  the card was placed into).

You may use *one* of these per turn — never both. The placed card
becomes **exhausted** regardless of which (if either) ability you
chose; placing the card and using its ability are not the same act.
Choosing "neither ability" is legal and the placed card is still
exhausted. *Confirmed by user 2026-05-02.*

Movement and Action are independent and may be taken in either order
post-placement (see §4). A turn with no follow-up at all (placement
only) is legal and ends with the End Turn button — this is **distinct
from Prepare to Run** (see §5.7).

#### 5.2.1 Action-step gates and contract

Both ability paths share the same gate:

```
cardPlacedThisTurn !== null      // Placement has happened (§4 stage 1)
&& !actionUsedThisTurn           // ≤ 1 Action per turn
&& !preparedToRun[heroId]        // Prepared-to-Run delvers can only End Turn
&& heroId === currentDelverId    // Only the active delver may act
```

The two engine-public entry points (the *only* call sites the UI uses):

- `useWeaponAbility(state, heroId, slotIdx, params)` — runs the
  printed Weapon Card ability of the card placed this turn.
- `useSlotAbility(state, heroId, slotIdx, params)` — runs the printed
  Slot ability of the slot the card was placed into.

Both succeed → set `actionUsedThisTurn = true` and return a small
per-action result describing what happened (a `{ summary, detail }`
log for non-damage paths, or an `AttackSession` for damage paths).
Both reject (no-op + reason string) on any gate failure. Internally:

- `useWeaponAbility` builds an `AttackSession` and the UI drives
  `resolveAllDamage` → optional shared counter-roll prompt →
  `resolveSharedCounter` → `finalizeAttackSession`. See §5.4.2 for
  the two-phase damage / shared-counter loop.
- `useSlotAbility` dispatches to `engine/slotAbilities.ts > resolveSlotAbility`
  (see §5.8).

Both wrappers call `engine/kills.ts > applyPendingLevelUps(state)`
once at the end (per §5.6 + the auto-level-up choice — XP is spent
immediately on every kill, no "level up later" UX).

### 5.3 "Adjacent" definition

For *all* gameplay (movement, weapon range patterns, counter-attack
range), **"adjacent" = 8-way** (the 8 surrounding cells). Confirmed by
user clarification + consistent with the printed range diagrams.
Implemented in `src/rules.ts` as `ADJACENT_OFFSETS_8WAY`.

### 5.4 Damage and counter-attacks

- Each time an enemy is damaged, place damage tokens equal to the
  damage dealt; if total damage on the card == its HP, the enemy dies
  (p22).
- **Every** instance of damage triggers a Counter Attack — even the
  killing blow (p22). *Confirmed by user 2026-05-02.*
- Counter Attack resolution per d6 (p23):
  - **1** — miss
  - **2–5** — Common Counter Attack range (white arrows on purple)
  - **6** — Uncommon Counter Attack range (black arrows on green)
- **Diagonal arrows have identical semantics to orthogonal arrows.**
  N stacked arrows in a direction = an N-tile line in that direction,
  same for cardinal and diagonal directions. *Confirmed by user
  2026-05-02.*
- Arrows: each arrow = one space hit in that direction; multiple arrows
  in a row = consecutive spaces hit (p23).
- A Delver in a hit space takes damage equal to the enemy's printed
  attack value, **even on the other player's turn** (p23).
- **Multi-target attacks: ONE shared d6 covers EVERY damaged enemy's
  counter-attack** (i.e., all damaged enemies share the same outcome —
  miss / common / uncommon — but each still applies its own
  counter-pattern from its own tile). *Confirmed by user 2026-05-02.*
- **The shared roll is auto-skipped when no possible outcome could
  land on a delver** — i.e., when none of the damaged enemies'
  common-OR-uncommon offsets intersect a current delver position.
  *Confirmed by user 2026-05-02.*

#### 5.4.1 Damage formula

```
damage = card.damageMultiplier * Tuning.damageBase[card.damageType]
```

`Tuning.damageBase = { light: 1, medium: 2, heavy: 4 }` matches the
LEFT (un-upgraded) diamond on each damage track of the suit board.
Town upgrades advance each cube to its right diamond
(`light \u2192 2`, `medium \u2192 4`, `heavy \u2192 8`); that's out of
scope for Quest #1. Once town upgrades come in, this becomes
per-Delver state on `DelverLoadout` instead of a global.

All r1 weapons have `damageMultiplier: 1`, so r1 attack damage equals
the base value:

- **Mind deck** (Suit B): *Ion Cannon Beam* (medium) = 2,
  *Crash Hammer* (heavy) = 4.
- **Body deck** (Suit A): *Soulshift Sword* (medium) = 2,
  *Chain Gauntlet* (light) = 1.

#### 5.4.2 Damage-then-shared-counter resolution

The `AttackSession` lifecycle (in `engine/combat.ts`) runs in two
phases per attack:

1. **Damage phase** — `resolveAllDamage(state, session)`:
   1. For each hit tile, in order: apply damage to any live enemy on
      that tile. If the enemy's HP reaches 0 the step is flagged
      `killed: true`, but the body is **NOT** removed yet and
      `applyKill` is **NOT** called. Both side-effects are deferred
      to `finalizeAttackSession` so dying enemies remain on the
      board (and visually highlightable as counter-sources) for the
      entire duration of the shared counter-roll prompt.
   2. Snapshot every damaged enemy (instanceId, cardId, x, y) into
      `session.sharedCounter.damagedEnemies` — even killed enemies
      counter from where they stood (rulebook p22).
   3. Precompute `session.sharedCounter.anyCanLand`: true iff at
      least one damaged enemy's counter-pattern (common ∪ uncommon)
      intersects a current delver position.

2. **Shared counter phase** — `resolveSharedCounter(state, session, rolled)`:
   - **If `!anyCanLand`** (auto-skip): caller passes `rolled = -1`,
     no roll prompt is shown, no damage is applied. The skip is
     recorded as a single `counter-shared` log entry with
     `skipped: true`.
   - **Otherwise**: caller prompts the user for ONE d6, then passes
     `rolled` (1–6). The outcome (miss / common / uncommon, per
     `COUNTER_ROLL`) is applied to **every** damaged enemy's
     pattern simultaneously. Each enemy emits zero or more
     `CounterHit`s into `session.sharedCounter.hits`, aggregated.

3. Then `finalizeAttackSession(state, session)`:
   1. Walks every `killed: true` step, flips `enemy.alive = false`
      (which removes the body from the board), and calls
      `engine/kills.ts > applyKill` (drops, shared XP, element
      grants, level-up cards owed). Storing `step.killResult` on the
      step is also done here.
   2. Applies post-effects (e.g. `collect-creature-part`).
   3. Runs `applyPendingLevelUps` once — the just-granted XP is
      already on `state.xpOnHand` by this point.

The deferred kill ordering is what lets the UI keep a red
"counter-source" highlight ring on every dying enemy for the entire
counter-roll modal, then remove them all at once on Confirm.

The single shared prompt is blocking — only one d6 per attack — and
the skip optimization avoids interrupting the player when the roll
could not possibly matter.

#### 5.4.3 Hit-tile computation per WeaponRange kind

| `range.kind`        | Targeting input from UI                 | Hit tiles |
|---|---|---|
| `single-adjacent`   | `chosenStartTile` (an enemy adjacent to attacker) | `[chosenStartTile]` if it is in fact 8-way adjacent and contains a live enemy |
| `straight-line`     | `chosenDirection` (one of 4 cardinal + 4 diagonal if `includeDiagonals`) | First live enemy in that ray from attacker; `firstTargetOnly` is the only mode in v1 |
| `die-roll-fixed`    | `dieRoll` (1–6). Optional Hammer effect: `may-reroll-by-suffering` lets the player suffer 1 HP to flip the result before locking it in. | Translates the matching `rolls[i].tiles` offsets to absolute board coords (clipped to the board) |
| `chain`             | `chosenStartTile` (any live enemy) plus the `requiresAdjacentTo` precondition | BFS over enemies connected 8-way starting from `chosenStartTile`. **Precondition** depends on `range.requiresAdjacentTo`: `"self"` (Chain Gauntlet) — the **attacker** must be 8-way-adjacent to at least one enemy in the chain; `"other"` (Surge Claw) — the **other delver** must be 8-way-adjacent to at least one enemy in the chain. Failing the precondition rejects the ability (`ok: false`). |

Edge cases:
- A hit tile with no live enemy is a *miss* — no damage, no counter.
- The `single-adjacent` start tile must be a live enemy AND 8-way
  adjacent to the attacker.
- The `chain` start tile must be a live enemy. The "adjacency to
  attacker" requirement only applies to the `"self"` variant via the
  precondition above.

##### `repeat-on-kill` (Soulshift Sword) — wired 2026-05-04

Soulshift Sword's printed text says: *"If the target dies, roll a die.
On a result of 4-6, repeat if able."* Implemented in
`src/engine/soulshift.ts` via the following pipeline:

1. The original swing runs through the standard
   {@link AttackSession} → counter prompt → finalize chain.
2. After `finalizeAttackSession`, `advanceAfterAction` checks
   `attackSessionTriggersSoulshiftRoll(state, session)`. True iff:
   - source is a weapon AND that card has a `repeat-on-kill` effect,
   - at least one `session.steps[i].killed` is true,
   - encounter is still in the `hero` phase (the delver-death short-
     circuit suppresses the bonus swing if a counter blow flipped us
     into End-of-Wave),
   - **AND** at least one LIVE enemy is 8-way-adjacent to the bearer's
     CURRENT tile. The card's "repeat if able" wording means a roll
     with zero adjacent live enemies is a guaranteed no-op
     (`classifySoulshiftRoll` would always return `no-repeat`); we
     short-circuit at the trigger so the player doesn't get a wasted
     die-roll modal. (User report 2026-05-09 — last adjacent
     Crystanid died, modal still asked for a roll.)
3. If pending Level-Up draws were also queued by the kill, the
   Level-Up modal opens FIRST. Only when the queue empties does
   `LevelUpModal.onPickChoice` re-enter `advanceAfterAction`, which
   then opens the Soulshift roll modal.
4. The Soulshift modal is two-stage: roll button → result. On a
   1-3 the player sees a single Continue button and the flow falls
   back to the normal end-of-action tail. (The "4-6 but no adjacent
   live enemies" case is now suppressed at the trigger — see #2 —
   so the modal never opens for it.) On a 4-6 WITH adjacent live
   targets, the player can choose Skip (decline the bonus swing —
   design decision 2026-05-04: optional) or Swing again (arm a
   target picker that highlights every live 8-way-adjacent enemy).
5. Picking a target dispatches
   `useWeaponAbility(..., { freeRepeat: true })`. The `freeRepeat`
   flag relaxes ONLY the `actionUsedThisTurn` half of the action
   gate (placement / phase / not-prepared-to-run still apply), and
   leaves `actionUsedThisTurn = true` after the bonus swing — so
   the chain still counts as ONE consumed action no matter how
   long it runs. One-shot post-effects (`collect-creature-part`)
   are also skipped on the bonus swing.
6. The bonus swing is a fresh `AttackSession` that re-enters the
   same pipeline. If it ALSO kills, the `advanceAfterAction` check
   fires again — chains have no engine-side cap; they're bounded
   only by adjacent live enemies and 4-6 rolls.

Per-swing counter timing: each swing has its own counter prompt;
the dying-blow counter resolves BEFORE the player even knows
whether they'll get to swing again. (Decision 2026-05-04 — the
alternative was deferring all counters to a single combined prompt
at the end of the chain.)

##### OS equipment — wired 2026-05-04

The two starter OS cards landed together via three new
`EquipmentEffect` kinds and one new pending-prompt queue
(`pendingElementChoices` on `EncounterState`).

**Providence OS (Mind R1)** — `bonus-xp-on-kill { amount: 1 }`.
Card text: *"ONGOING: Enemies that grant XP grant 1 additional XP."*
Wired into `engine/kills.ts > applyKill` via
`xpBonusFromPassives(state, printedXp)` — sums every
`bonus-xp-on-kill.amount` contributed by passives owned (rank ≥ 1)
by every LIVING delver. Design decisions:
- **Alive-gate (decision 2026-05-04)**: a downed bearer (HP ≤ 0)
  can't run their passive scan. Mirrors the rulebook's "the passive
  needs the delver to be functional" reading and is consistent with
  how movement / action gates work for a dead delver.
- **Conditional gate**: bonus is 0 unless `printedXp > 0`. Card text
  says *"Enemies that **grant XP** grant 1 additional XP"* — the
  bonus is conditional on the underlying grant.
- **Stacking** (forward-compat): bonuses sum across delvers, so a
  hypothetical state where both delvers each own a passive carrying
  this effect would credit each of them. Today only the Mind delver
  can own Providence so the practical ceiling is +1.

**Elemental OS (Body R1)** — IMMEDIATELY +
ONGOING. Card text: *"IMMEDIATELY: Gain 1 ELEMENT. ONGOING: Both
delvers gain 1 element at the end of each wave."* Implemented
via two new effects + an async pending-prompt queue.

- `gain-element-on-acquire { amount: 1 }`: fires only on first-time
  gain (R0 → R1) of the bearing card from `engine/levelUp.ts >
  applyLevelUpChoice`. Rank-ups (R1 → R2) intentionally don't
  re-trigger. Async because the player picks WHICH element — the
  effect enqueues a `PendingElementChoice` rather than mutating the
  element bag synchronously. Skipped for dead bearers
  (defensive — they shouldn't be picking a level-up while dead).
  NOT re-applied on `resetWaveForRetry` (the IMMEDIATELY grant is
  one-shot per quest gain, not a per-wave stat floor like Boots'
  `set-base-movement`), so the resolver lives outside
  `applyImmediatePassiveEffects`.
- `gain-element-at-end-of-wave { amount: 1, recipient:
  "all-delvers" }`: fires once per wave transition, **only when the
  party continues to the next wave** (§4.2, `bootstrapNextWave`),
  enqueuing one prompt per living delver in `Object.keys(state.loadouts)`
  order on the new wave's encounter. The
  `recipient: "bearer"` form is forward-compat for hypothetical
  R2-R5 variants. Dead delvers are skipped at enqueue time
  (decision 2026-05-04 — *"Skip dead delvers. A dead delver flips
  the encounter into End-of-Wave defeat anyway"*).

**Pending prompt queue** — `state.encounter.pendingElementChoices: PendingElementChoice[]`.
- Populated by `engine/os.ts > enqueueElementChoice`, drained by
  `applyElementChoice` (delegates to `grantElementToDelver` so the
  per-element cap of 2 is enforced exactly once — overflow is
  silently lost per rulebook p17). Entries carry the
  `source.kind` (`"os-immediate"` | `"end-of-wave"` | ...) so the modal
  copy can surface useful context.
- UI: new `element-pick` modal kind in `uiState.ts`, rendered by
  `screens/ActionResolution.ts > renderElementPickModal`. 6-button
  grid (one per `Element` value); buttons at the per-delver cap of
  2 are disabled. Cancel-less by design — once a grant is queued,
  it must resolve before any phase-advance gate.
- **Turn advance gates** call `hasPendingElementChoices` and refuse
  to advance while non-empty: End Turn (`BoardScreen`) and
  `maybeAutoEndTurn` (`turnFlow.ts`). (The old Interlude "Continue"
  gate is gone with the Interlude; the end-of-wave picks now open on
  the next wave's board.) Dead delvers are skipped (decision
  2026-05-04).
- **Post-action queue precedence** (`advanceAfterAction`): element
  picks → level-up draws → soulshift roll → end-turn. Decision
  2026-05-04: *"Pop the element-pick modal INSIDE the Level-Up
  flow before moving on to the next pending Level-Up draw"* — so
  even mid-multi-level-up, an Elemental OS gain pops its prompt
  before the next draw's modal opens. `LevelUpModal.onPickChoice`
  always delegates to `advanceAfterAction` to enforce this.

##### Trident equipment — wired 2026-05-03

Both Trident R1 cards (Mind: Golden Trident; Body: Shift Trident)
ship the same three engine pieces that compose into a single
weapon-ability swing:

```
[1] Optional pre-attack move (8-way to bearer, 1 tile, free)
[2] Damage on the printed fixed-pattern tiles (no targeting picker)
[3] Optional post-attack-counter block (-1 from one chosen counterattacker)
```

Per user 2026-05-03: *"NORTH applies to the targetting direction of
the attack, not the block damage ability. So the ability has 3 parts:
you can move an adjacent enemy, then you target tiles for damage,
then you block a counterattack."* The `NORTH:` label is the
direction-name of the printed pattern (the suit board has no compass
slots) — at R1 the pattern is fixed and not rotated by placement.

**Targeting** — `range.kind: "fixed-pattern"` with a printed
`tiles: Offset[]`. New `computeFixedPattern` branch in
`engine/combat.ts > computeWeaponHitTiles` translates each printed
offset into an absolute tile from the bearer's position, silently
clipping out-of-bounds tiles (matches `die-roll-fixed`'s "miss tile"
behavior). The swing fires regardless of whether any printed tile
has a live enemy — empty tiles become miss steps. The action is
still consumed.

User-confirmed offsets (2026-05-03):
- **Shift Trident (Body, R1) NORTH**: `(-1, 0)` 1W, `(-2, 0)` 2W,
  `(0, +1)` 1S.
- **Golden Trident (Mind, R1) NORTH**: `(-1, -1)` NW, `(+1, -1)` NE,
  `(+2, -2)` 2NE.

The action menu opens this swing without arming any picker — the
pattern is fully determined by the printed offsets + bearer
position. If the card carries `pre-attack-may-move-adjacent` AND
there is at least one adjacent live enemy **with at least one
legal destination tile to be pushed to**, the trident-pre-move
prompt opens FIRST (Skip / Pick); otherwise the swing fires
immediately. The "has a legal destination" gate
(`legalMoveDestinationsForEnemy(...).length > 0` checked over every
adjacent enemy) was tightened 2026-05-09 so a fully boxed-in
adjacent enemy doesn't trigger a misleading prompt that arms the
picker but produces an empty destination overlay.

**Pre-attack move** — `pre-attack-may-move-adjacent { range: 1 }`
fires BEFORE damage resolves so the printed pattern targets the
enemy's NEW position (you can pull an enemy INTO a strike tile or
push them OUT of one). Adjacency is to the BEARER (8-way), matching
the Boots `move-adjacent-enemy` convention. Destinations follow the
shared `legalMoveDestinationsForEnemy` helper (8-way around the
enemy, on-board, not occupied by another enemy or a delver — the
bearer's own tile counts as occupied). The move is recorded as a
`pre-attack-move-enemy` PreEffect on the session for log /
replay. Free — no movement / AP cost.

UI flow: prompt modal → `trident-pre-move-target` armed (board
paints adjacent enemies) → click enemy → `trident-pre-move-dest`
armed (board paints legal dest tiles) → click dest → swing fires.
Cancel during either picker phase clears the armed state without
consuming the action; the player can re-click the slot.

Engine-level rejections (UI is expected to never trigger these; they
exist for defense-in-depth):
- placed card has no `pre-attack-may-move-adjacent` effect →
  `"placed card has no pre-attack move effect"`.
- target enemy missing or dead → `"pre-attack move target enemy not
  found or dead"`.
- target not 8-way-adjacent to bearer → `"pre-attack move target
  enemy not 8-way adjacent to bearer"`.
- destination not in `legalMoveDestinationsForEnemy` →
  `"pre-attack move destination is not a legal tile"`.

**Post-attack counter block** — `weapon-counter-block { amount: 1,
count: 1 }`. After the counter rolls (and BEFORE the
shield-prompt queue opens, BEFORE damage actually lands), the
player may pick ONE counterattacker whose effective `attack` drops
by `amount` (clamped at 0) for this counter only. New per-swing
choice; threaded into `applyCounterDamageWithShieldChoices` as a
fifth optional `weaponCounterBlock?: WeaponCounterBlockChoice`
parameter. Decisions:

- **"1 counterattack" = the entire contribution from one chosen
  counterattacker.** User 2026-05-03 picked *"Player chooses WHICH
  counterattacker's damage to reduce by 1"*. The reduction reduces
  the enemy's `attack` value for damage application across all
  delvers it would hit — so a 2-attack Soulhunter that would hit
  both delvers on the bearer's tile becomes a 1-attack hit on both.
- **Block-then-shield ordering.** The Trident block is applied
  BEFORE Sol/Lunar Shield activations, so an element is only spent
  if the free block alone wasn't enough. Shield "incoming damage"
  previews (`previewCounterHitsByDelver` / `findShieldOpportunities`)
  accept an optional `weaponCounterBlock` arg so the per-bearer
  totals reflect the post-block reality.
- **Per-swing scope.** Only one block per swing, regardless of how
  many enemies counterattacked. (Card text: *"Block 1 damage from
  1 counterattack."*) Bonus swings via `repeat-on-kill` would each
  get their own block — today no Trident has `repeat-on-kill` so
  this is theoretical.
- **Free.** No element / AP cost. Distinct from Sol/Lunar Shield's
  `block-on-tile` which costs an element and is bearer-tile-scoped.

UI flow: counter roll → if `sessionWeaponCounterBlockAmount > 0`
AND `counterBlockCandidates.length > 0`, route through
`weaponCounterBlockDecision(candidates, cap)`:

- `candidates.length > cap` → open the `weapon-counter-block-prompt`
  (originally `trident-counter-block-prompt`, renamed when
  Shockwave shipped — see §5.4 Shockwave) with one button per
  counterattacker (showing the per-delver pre-block damage and
  the post-block projection); player picks `cap` or skips →
  `proceedToShieldsOrApply` opens shield prompts (with the
  weapon-block carried through) or applies damage directly.
- `candidates.length <= cap` → AUTO-APPLY the block to all
  candidates (no prompt). The printed text "Block 1 damage from 1
  counterattack" is mandatory phrasing, not a "may", so when
  there's no decision to make (1 candidate at cap=1, or N
  candidates ≤ cap=2 for Shockwave) the engine just applies the
  block automatically and proceeds straight to the shield queue.
  This matches the player's expected "ask ONLY when there's a
  multi-enemy decision" mental model and was added 2026-05-09
  after a Trident gameplay review noted the pre-fix prompt was
  firing for single-counterattacker swings.

The legacy `resolveSharedCounter`-fast-path is bypassed when a
weapon block is in play (the per-offset hit emission can't
represent the reduced-attack semantics; the per-hero rollup in
`applyCounterDamageWithShieldChoices` is used instead).

Auto-skipped entirely when the counter outcome is `miss` or no
counterattacker would deal damage to a delver — the dispatch
helper returns `{ kind: "skip" }` and the no-block path runs.

The dispatch helper is pure and unit-tested (see
`__tests__/trident.test.ts > weaponCounterBlockDecision`) so the
routing rules can be pinned without standing up the whole UI.

##### Shockwave equipment — wired 2026-05-03

Both Shockwave R1 cards (Mind: Web Sockwave; Body: Overload
Shockwave) reuse the Trident's `fixed-pattern` range and its
`weapon-counter-block` effect, but with two key differences:

1. **No pre-attack move.** Shockwave doesn't carry
   `pre-attack-may-move-adjacent`, so the swing fires immediately
   from the slot menu (no pre-move prompt).
2. **Block count: 2.** `weapon-counter-block { amount: 1, count: 2 }`
   — the player picks UP TO 2 different counterattackers (each
   reduced by 1 attack) instead of 1.

**Targeting** — `range.kind: "fixed-pattern"`. User-confirmed
offsets (2026-05-03):
- **Web Sockwave (Mind, R1) NORTH**: 4 cardinals at distance 1
  (`(0,-1)`, `(+1,0)`, `(0,+1)`, `(-1,0)`) + 4 diagonals as 3-tile
  rays (NE: `(+1,-1)`, `(+2,-2)`, `(+3,-3)`; SE/SW/NW analogous).
  16 printed tiles total; off-board ones clip silently.
- **Overload Shockwave (Body, R1) NORTH**: 4 diagonals at distance 1
  (`(+1,-1)`, `(+1,+1)`, `(-1,+1)`, `(-1,-1)`) + 4 cardinals as
  3-tile rays (N: `(0,-1)`, `(0,-2)`, `(0,-3)`; S/E/W analogous).
  Mirror-rotation of the Mind card. 16 tiles total; off-board ones
  clip silently.

LIGHT damage = 1 per swing per live enemy hit. The damage doesn't
care about elements / shielding — every printed tile resolves
independently in `resolveAllDamage`.

**Multi-pick counter-block** — the engine refactor for Shockwave
generalised `WeaponCounterBlockChoice` from a single
`enemyInstanceId` to an `enemyInstanceIds: string[]` list, and
added a `weapon-counter-block.count` knob. The Trident is now just
the count-1 special case.

Engine surface:
- `sessionWeaponCounterBlockCount(session)` — public read of the
  source weapon's pick cap (1 for Trident, 2 for Shockwave, 0 for
  everything else). UI uses this to size the prompt.
- `weaponCounterBlockMap(session, choice)` — the single helper that
  turns a `WeaponCounterBlockChoice` into the per-enemy block-amount
  map used by both `previewCounterHitsByDelver` /
  `findShieldOpportunities` (preview) and
  `applyCounterDamageWithShieldChoices` (consumer). Centralising
  this guarantees the shield-prompt "incoming damage" preview always
  matches what the engine eventually applies. Caps to `count`,
  silently clamps excess picks, dedupes-by-id-with-stacking
  (defensive: duplicate picks compound the reduction — UI shouldn't
  send dupes but if it does, the player gets the bigger block).

UI changes:
- The counter-block prompt was renamed
  `trident-counter-block-prompt → weapon-counter-block-prompt`
  (since both Trident and Shockwave use it now).
- The prompt converted from instant-resolve single-pick to
  multi-select with explicit Confirm + Skip buttons. Each candidate
  is a toggle button; selected enemies show a `✓` mark and the
  "X → Y" damage projection. At-cap unselected buttons disable
  themselves (the player must deselect to free a slot). Confirm is
  disabled until at least one enemy is picked; Skip is always
  available.
- The cap displays in the prompt title/subline: "Block 1
  counterattack?" (Trident) vs. "Block up to 2 counterattacks?"
  (Shockwave). The running tally ("1/2 picked") shows the player
  how many slots remain.

**Shield-block ordering.** Same as Trident — Shockwave block
applies BEFORE shield activations, so the shield-prompt "incoming
damage" reflects the post-block reality. A 2-attack counterattacker
both blocked and overblocked by Sol Shield (radiance) would
overblock against the post-block 1, healing 1 HP for the bearer.

Auto-skipped when the counter outcome is `miss` or no
counterattacker would deal damage to a delver — same as Trident.

**Multi-spend (post-2026-05-25).** Sol / Lunar Shield's
`block-on-tile` ability may be activated MULTIPLE times in a single
counter resolution — one element spent per activation, capped at
ONE ACTIVATION PER ENEMY COUNTERATTACK landing on the bearer's
tile (rulebook reading: "1 shield per counterattack"). The cap is
exposed via `ShieldOpportunity.maxActivations` =
`count(distinct counterattackers whose offsets land on bearer's
tile with non-zero post-block effective attack)`. Examples:

- 1 enemy counterattacking the bearer's tile → cap 1.
- 2 enemies both hitting the bearer's tile → cap 2 (the user-
  reported scenario "two counterattacks for 1 damage each → spend
  2 elements → both blocked").
- 1 enemy hitting the bearer's tile via 3 different offsets → still
  cap 1 (same enemy = one counterattack).
- 2 enemies hitting, but Trident blocks one of them down to 0
  effective attack → cap 1 (the silenced enemy doesn't count).

The shield-prompt UI accumulates spends in `pendingSpends: Element[]`;
`Done` commits them as a single
`ShieldChoice = { kind: "spend", elements: [...] }`. Spend buttons
disable when `pendingSpends.length >= maxActivations`. The engine
loops over `elements` in order, TRUNCATING the array to
`maxActivations` first (defensive against stale UI), then applying
each activation's `baseBlock` / `bonusBlock` to every still-damaged
tile-mate and accruing overblock (clamped at the bearer's `maxHp`)
as each activation's surplus spills past the remaining damage. A
spend that lands on already-zeroed tile-mates is wasted — it does
not contribute to the heal pump (skip-0-damage rule, identical to
the pre-2026-05-25 single-spend pathway). See
`__tests__/combat.test.ts` "applyCounterDamageWithShieldChoices —
multi-spend" + "ShieldOpportunity.maxActivations" for the
regression suite.

**Parting-shot interception (post-2026-05-25).** Sol / Lunar Shield
also intercepts damage from the **Parting Shots** phase (rulebook
p26), not just hero-phase counterattacks. The same `ShieldOpportunity`
shape and `ShieldChoice` data model are reused; the only difference
is the cap rule:

- Cap = **1 per parting shot** (one parting shot is from a single
  enemy = one "counterattack source"). Even if the parting shot
  damages BOTH delvers (`all-delvers` / `delvers-within` /
  damage-and-side-effect combos like Goldmonger 2 dmg + drain XP),
  the bearer can only activate the shield ONCE — that one activation
  protects every tile-mate on their tile.
- No-damage parting shots (`all-delvers-lose-xp`,
  `all-delvers-lose-elements` alone) skip the prompt entirely
  (`findPartingShotShieldOpportunities` returns `[]`).
- Side-effect clauses on damage-and-X parting shots (XP drain /
  consumable discard / element drain) are **unconditional** and
  fire regardless of whether the shield blocked the damage —
  matches the printed text "3 Damage & lose ALL Elements" rather
  than "if damaged, lose elements". The shield protects HP, not
  the bag / pool.

UI flow:
1. Player taps "Resolve" on a parting shot.
2. `WavePhases.onResolvePartingShot` calls
   `findPartingShotShieldOpportunities(state, params)` — same
   generic helper as counter shielding (cap=1 per bearer).
3. If non-empty, `parting-shot-shield-prompt` modal opens, walking
   the queue with the same multi-spend UI (cap pill stays at 1/1).
4. On Done/Skip, the modal calls
   `resolvePartingShot(state, { ...params, shieldChoices })` —
   the engine folds the reductions into the damage map BEFORE
   committing damage and side effects.
5. If no shield opportunities, `resolvePartingShot` is called
   directly (legacy fast-path, unchanged).

Engine API:
- `computePartingShotDamageMap(state, enemy, card, params)` — pure
  preview of would-be damage per delver. Stays in lockstep with
  `applyPartingShot`'s per-variant damage logic.
- `findPartingShotShieldOpportunities(state, params)` — wraps
  `computePartingShotDamageMap` + `findShieldOpportunitiesForDamageMap`.
- `resolvePartingShot(state, { ..., shieldChoices? })` — the
  shield-aware resolve path. Backward-compatible: omitting
  `shieldChoices` leaves the legacy behaviour exactly as it was.

Test coverage: `__tests__/wave.test.ts` "Parting Shots — Sol /
Lunar Shield interception" pins (a) opportunity-finding gates
correctly, (b) base/bonus block reduces damage as expected, (c)
overblock-heal fires for the bearer, (d) cap=1 truncates over-spend,
(e) side-effect clauses still fire post-shield, (f) legacy path
unchanged when `shieldChoices` is omitted.

Test coverage (`__tests__/shockwave.test.ts`, 23 tests):
- Both cards' `range.tiles` match the printed offsets exactly
  (catches data drift at PR time).
- Both carry `weapon-counter-block { amount: 1, count: 2 }` and
  NOT `pre-attack-may-move-adjacent`.
- `computeWeaponHitTiles` produces the expected on-board tile list
  with cardinal/diagonal rays clipped at exactly the right edges
  (mid-board + corner positions covered).
- `useWeaponAbility` damages every enemy on a printed tile and
  records empty tiles as miss steps (Soulhunter-on-LIGHT survives;
  no kills in the multi-block fixture).
- `weaponCounterBlockMap` covers skip / undefined / 1-pick /
  2-pick / excess (3 picks capped to 2) / duplicate (stacking) /
  non-Shockwave source (cap=0 returns empty map).
- End-to-end multi-block: 2 Soulhunters on Shockwave NW+NE
  diagonals, both hitting the bearer at `(2,2)` on a "common"
  roll. Skip → 4 dmg; 1 pick → 3 dmg; 2 picks → 2 dmg; excess
  picks → same as 2 picks; multi-delver tile-mate → both delvers
  see the post-block totals; non-Shockwave source → block ignored.

##### Mace equipment — wired 2026-05-04

Both R1 Mace cards (Mind: Pulse Maul; Body: Geoshade) ride the
existing `single-adjacent` `WeaponRange.kind` for HEAVY damage
(base 4 × multiplier 1) and add a new `EquipmentEffect`:
`target-filter-or-spend-element`. Two cards, two filters, one
shared OR-bypass:

- **Pulse Maul Mace (Mind, R1)** — *"HEAVY damage to an adjacent
  UNDAMAGED enemy. OR Spend an element to deal HEAVY to an
  adjacent enemy."*  → `filter: "undamaged"`.
- **Geoshade Mace (Body, R1)** — *"HEAVY damage to an adjacent
  DAMAGED enemy. OR Spend an element to deal HEAVY to an adjacent
  enemy."* → `filter: "damaged"`.

**Engine model** (decisions confirmed by user 2026-05-04):
- Default mode targets only adjacent live enemies whose
  `damageTaken` matches the printed filter (UNDAMAGED → 0;
  DAMAGED → > 0).
- OR mode lets the player spend ANY 1 element from their bag
  (player-pick across element kinds — same rules as Sol/Lunar
  Shield's "spend 1 ELEMENT" wording). Filter is then fully
  bypassed; ANY 8-way adjacent live enemy is a legal target. The
  OR-mode is a strict superset of default mode (the same legal
  filter targets are still hittable).
- Damage is identical in both modes — the printed text only
  changes targeting, not the swing damage.
- Element bag debit is committed inside `useWeaponAbility` AFTER
  every other rejection gate has passed (the Double Damage spend
  validation in particular). A wasted-spend prompt that bounces
  on DD does NOT eat an element. The debit + a
  `target-bypass-spend-element` PreEffect entry happen in the same
  tick once everything is green.
- Cards without the `target-filter-or-spend-element` effect (Sword,
  Soulshift Sword, etc.) ignore `spendElementForTargetBypass`
  entirely — passing it on a non-Mace single-adjacent card is a
  hard reject (defensive — keeps the bypass scoped to cards that
  actually print it).

**`WeaponAbilityParams` extension.** The `single-adjacent` variant
gained an optional `spendElementForTargetBypass: { element }`. All
existing tests + call sites compile unchanged because the field is
optional; the engine defaults to default-mode behaviour when it's
absent.

**`PreEffect` extension.** Added
`{ kind: "target-bypass-spend-element"; heroId; element }`. The UI
surfaces this in the action log so the player sees which element
was burned.

**Helpers** (`engine/mace.ts`):
- `getTargetFilterOrSpendElementEffect(card)` — single source of
  truth for "is this a Mace?". Returns the effect object or null.
- `enemyMatchesFilter(enemy, filter)` — pure boolean.
- `adjacentLiveEnemies(state, heroId)` / `…MatchingFilter(state,
  heroId, filter)` — spatial helpers used by both the UI overlay
  and the modal-routing logic.
- `availableElementKinds(state, heroId)` — sorted list of element
  kinds the bearer can spend.
- `classifyMaceModes(state, heroId, card)` — single source of truth
  for the auto-skip routing decision: returns
  `{ defaultModeAvailable, spendModeAvailable, availableElementKinds, … }`.

**UI flow** (`screens/ActionResolution.ts`):

The action-menu's "Use weapon ability" branch was extended with a
Mace-specific sub-flow. After classifying the modes:

| Default viable? | Spend viable? | Element kinds | UI route |
|-----------------|---------------|---------------|----------|
| ✓               | ✓             | n/a           | open `mace-mode-pick` modal |
| ✓               | ✗             | n/a           | arm default directly |
| ✗               | ✓             | 1             | arm spend with that element directly |
| ✗               | ✓             | ≥2            | open `mace-element-pick` modal |
| ✗               | ✗             | n/a           | no-op (close menu, refresh) |

The two modals:
- `mace-mode-pick` — two buttons (Default mode showing the legal
  target count; Spend element showing either "spend 1 X" when
  there's a single kind in the bag, or "spend any 1 element"
  when there are multiple). Cancel returns to the action menu.
- `mace-element-pick` — one button per available element kind
  (sorted alphabetically — matches Sol/Lunar Shield's prompt
  convention). Each shows the bag count. Back returns to
  `mace-mode-pick`.

The target overlay reads the armed state's `spendElementForBypass`
to decide which subset of adjacent enemies to paint:
- Mace, no spend → only filter-matching enemies are lit.
- Mace, with spend → ALL 8-way adjacent live enemies are lit.
- Non-Mace single-adjacent → ALL adjacent enemies (unchanged).

The cancel banner's `describeArmed` text surfaces the active mode
("Pulse Maul Mace: pick an adjacent UNDAMAGED enemy." vs "Pulse
Maul Mace: pick ANY adjacent enemy (will spend 1 fire).") so the
player remembers (a) why some adjacent tiles aren't lit, or (b)
that an element WILL be spent on click.

**Interaction with Double Damage tokens.** Mace's HEAVY damage type
qualifies for `damage-2x-heavy` and `damage-2x-universal` tokens.
The DD prompt opens AFTER the Mace mode/element pick AND AFTER
the target click — same flow as every other weapon. Spend ordering
inside `useWeaponAbility` validates DD before debiting the element
so a wasted-spend prompt that bounces on DD doesn't eat the
element. (Element debit + DD spend both push their own PreEffect
entries; the action log surfaces both.)

**Interaction with Reroll / Block Counterattack tokens.** No special
interaction — Mace doesn't roll a die, so Reroll has no swing-
phase target on the placement. Counterattacks following a Mace
swing route through the standard counter-roll modal where Reroll
and Block Counterattack are available as usual.

Test coverage (`__tests__/mace.test.ts`, 30 tests):
- Both cards' shape: `target-filter-or-spend-element` with the
  expected `filter` value, plus damageType / multiplier / range.
- All `engine/mace.ts` helpers: filter membership, adjacency
  filtering (with dead enemies excluded), element bag enumeration
  + sort order, and every branch of `classifyMaceModes`.
- `useWeaponAbility` default mode: Mind accepts UNDAMAGED /
  rejects DAMAGED; Body accepts DAMAGED / rejects UNDAMAGED. No
  element spent on rejection. Damage = printed HEAVY (4) at R1.
- `useWeaponAbility` OR mode: Mind+Body accept any-adjacent with
  spend, debit exactly 1 of the named element, push the
  `target-bypass-spend-element` PreEffect, and damage stays at 4
  (no doubling).
- Rejection paths leave the bag untouched: 0-of-named-element,
  no-effect-on-card (defensive Sword test), no-enemy-on-tile.
- Non-Mace regression: Sword still swings at any adjacent enemy
  regardless of damageTaken (no filter applied).

##### Harvester equipment — wired 2026-05-04

Both R1 Harvester cards (Mind: Dragonfly Model; Body: Beetle Model)
are passives that print:

> *"Ongoing: You gain 2 minion part tokens at the end of each wave
> (taken from the supply)."* (Nov 15 card text; older cards said
> "during the Interlude Phase".)

Engine support is a single new `EquipmentEffect` kind:

```ts
{ kind: "gain-tokens-at-end-of-wave";
  token: "creature-part" | "boss-part";
  amount: number;
  bossLevel?: 1 | 2 | 3 | 4 | 5 }   // New Harvester
```

The `token` discriminator mirrors the slot ability `gain-token`
shape so the same string IDs flow through both surfaces:
- `"creature-part"` → bumps `state.minionParts[bearerId]`
- `"boss-part"`     → bumps `state.bossParts[bearerId]`

Both R1 Harvesters print `{ token: "creature-part", amount: 2 }`.
The discriminator gives free forward-compat for hypothetical R2-R5
or Boss-Part Harvesters; no engine change required when those land.

**Engine model** (decisions confirmed by user 2026-05-04):
- **Bearer-only.** No `recipient` enum — the printed text says
  "YOU gain". Other delvers do not benefit. If a future card
  needs all-delvers semantics we'll extend the shape (the path
  Elemental OS took with `gain-element-at-end-of-wave`).
- **Pays at End Wave, every wave end, defeat included** (designer
  decision 2026-11-17).
- **Walks the effective equipment ranks** (not just starting
  equipment) so a Harvester acquired mid-quest via Level Up
  correctly fires from the next wave end onward. Iteration shape
  mirrors `enqueueEndWaveElementChoices`.
- **Skips dead delvers** (`currentHp ≤ 0`). Same convention as
  `enqueueElementChoice`. A delver who dropped during the wave
  doesn't get Harvester tokens for it; the living delver does.
- **No supply tracking.** The "from supply" parenthetical on the
  printed cards is a tabletop bookkeeping note; the prototype
  treats the supply as infinite. (If a future quest introduces a
  shared supply pool we'd cap here.)
- **Idempotent.** The End Wave refresh is latched by
  `enc.endWaveRefresh`, so a second `enterEndOfWave` can't double-grant.
  The next wave is a fresh encounter, so its end grants again.
- **Shown on the End of Wave screen.** Each payout is a line in
  `endWaveRefresh.harvesterGrants` ("Dragonfly Model Harvester: +2
  minion parts"), rendered in the "End Wave" card. (Before
  2026-11-17 the grant was silent.)

**Implementation** — `engine/wave.ts > applyHarvesterGrants`, called
from the End Wave refresh. Resolves the rank- and variant-correct card
with `getEquipmentCardFor(state, bearerId, type, rank)`.

**No UI changes** — both Harvester cards are passives with no
slot ability and no in-wave activation surface. The hand / sheet
already render them as standard passives via the Level Up modal
and the campaign sheet.

Test coverage (`__tests__/harvester.test.ts`, 17 tests):
- Both cards' shape: `gain-tokens-at-end-of-wave` with token
  `"creature-part"` and amount 2.
- Engine grant: bearer-only +2 (Mind on hero-01 / Body on hero-02
  in isolation; both delvers + both Harvesters independently);
  rank 0 doesn't fire; counts STACK on existing values rather
  than replacing.
- Dead-delver skip (on a defeat): bearer at currentHp = 0 / < 0
  doesn't grant; the surviving delver's Harvester still fires; a
  living bearer is paid on a defeat.
- Idempotency: a second `enterEndOfWave` doesn't double-grant; the
  next wave's end DOES grant again.
- Mid-quest acquisition: rank flips 0 → 1 between waves, and the
  NEXT wave end correctly fires.
- Timing: Harvester pays at End Wave while Armor heals only via
  `applyContinuingEndWaveEffects`.

##### "IMMEDIATELY: Roll a die" passives (Supercharger / Battery / future) — wired 2026-05-03 / refactored 2026-05-04

Several R1+ passives print *"IMMEDIATELY: Roll a die. 1-X: gain ...
5-6: choice."* Today's bearers are **Supercharger** (Mind: Reflex;
Body: Spinejack) and **Battery** (Mind: Core Booster; Body: Lucky)
— see the entries below for each card's printed outcomes. All four
share one engine + one UI scaffold via the generic
`immediately-equipment-roll` effect kind, and a per-card outcome
table registered in `engine/tokens.ts > EQUIPMENT_ROLL_TABLES`.

**Common engine surface (`engine/tokens.ts`):**
- `EQUIPMENT_ROLL_TABLES: Record<cardId, EquipmentRollTable>` —
  per-card outcome registry. Each entry pairs a printed outcome
  list (`outcomes: EquipmentRollOutcome[]`, each with an `id`,
  `grants` map, and human `label`) with a 6-element
  `rollMap: (number | "choice")[]` that maps d6 face → outcome id
  (or `"choice"`). New cards just add an entry; no other code
  changes.
- `equipmentRollTableForCard(cardId)` — registry lookup; returns
  `null` for cards without a table (used by the modal as a
  data-bug guard).
- `outcomeForRoll(table, roll)` — translates a d6 against one
  table to a direct outcome OR `"choice"` OR `null` (out-of-range).
- `enqueueEquipmentRoll(state, heroId, cardId)` — pushes a
  `PendingEquipmentRoll { heroId, cardId }` onto
  `state.encounter.pendingEquipmentRolls`. Called from
  `applyLevelUpChoice` once PER RANK GAINED (designer ruling
  2026-07-20: every printed rank card R1-R5 carries the roll
  text, so each rank gives 1 benefit — an Ultra +2 enqueues 2
  rolls; pre-fix only first-gain enqueued and rank-ups silently
  granted nothing). Throws if the card has no registered table
  — that's a data bug we want to fail loud.
- `applyEquipmentRoll(state, heroId, outcome)` — grants the
  tokens via `grantToken` and pops the head of the queue.
- `hasPendingEquipmentRolls` / `peekNextPendingEquipmentRoll` —
  queue read helpers used by the End-Turn gate.

**UI flow (single modal serves every card).** On first-gain inside
the Level-Up modal, the post-pick advance gate
(`advanceAfterAction`) sees the new entry on
`pendingEquipmentRolls` and opens the `equipment-roll` modal:

1. Stage A: "Roll die" button. Rolls a d6.
2. Stage B (direct outcome): shows the granted outcome + Confirm.
3. Stage B ("choice" face): shows one button per outcome on the
   card's printed table (Supercharger: 4 buttons; Battery: 2);
   player picks one.

A **Reroll** button appears in Stage B whenever the bearer holds a
Reroll token (no per-turn cap, see §5.5.2). Clicking it spends the token and re-rolls the die in
place — the new roll re-enters Stage B and may land on a direct
outcome or another `"choice"`.

Cancel-less by design — same rationale as element-pick. The End-Turn
gate checks
`hasPendingEquipmentRolls` alongside the existing
`hasPendingElementChoices` gate so the queue must drain before the
turn flips.

##### Supercharger — Double Damage outcome table

| Die face | Outcome | Grants |
|----------|---------|--------|
| 1 | "Two 2x LIGHT damage tokens" | 2× `damage-2x-light` |
| 2 | "Two 2x MEDIUM damage tokens" | 2× `damage-2x-medium` |
| 3 | "Two 2x HEAVY damage tokens" | 2× `damage-2x-heavy` |
| 4 | "One of each" | 1× each (Light / Medium / Heavy) |
| 5-6 | Player picks any of outcomes 1-4 | — |

Both Mind and Body Supercharger share this exact table.

Spending one DD token on a swing doubles its damage; the player is
capped at **1 DD spend per turn ACROSS the family** (rulebook p15:
*"No matter the type of double damage token you use, you can only
use 1 double damage token per turn."*) — single
`damage2xUsedThisTurn` flag, set by `spendToken` on any DD kind.
See §5.5.2 for the multiplier math + spend-time UI.

**Test coverage (`__tests__/supercharger.test.ts`, 40 tests):**
- equipment.json shape: both R1 cards have
  `effects: [{ kind: "immediately-equipment-roll" }]`.
- bag CRUD: `tokenAvailable` / `tokenSpent` defaults, `grantToken`
  add semantics, `spendToken` available→spent move + true/false
  return.
- `canSpendDoubleDamage`: ok / no-token / already-spent /
  already-spent-different-type / non-DD-kind.
- `doubledDamageMultiplier`: null / typed-match / typed-mismatch /
  universal.
- Supercharger outcome table values + `outcomeForRoll`
  for rolls 0..7 (in-range + out-of-range).
- Queue ops: empty / push / FIFO peek / no-encounter no-op.
- `applyEquipmentRoll`: grants outcome 1 (two Light); outcome 4
  (one of each); returns null for missing entry; FIFO drain across
  multi-stacked rolls.
- `applyLevelUpChoice` enqueues one roll PER RANK gained (first
  gain AND rank-ups; Ultra +2 = two rolls — ruling 2026-07-20).
- `useWeaponAbility(..., { spendDoubleDamage })`: doubles damage +
  consumes token + latches per-turn cap; universal works on any
  type; mismatch / no-token / cap-already-latched all REJECT and
  preserve the token.
- End Wave `refreshAllSpentTokens` flips Spent → Available across
  both delvers; idempotent; surfaces a count in
  `enc.endWaveRefresh`.
- The Double Damage per-turn cap resets on `startHeroTurn` (so a
  fresh turn can spend again).

##### Battery — AP / Reroll / Block Counterattack outcome tables — wired 2026-05-04 (AP unified 2026-05-09)

Both Battery R1 cards are **passives** that fire the shared
`immediately-equipment-roll` effect once per rank gained (first
gain and every rank-up — ruling 2026-07-20). Unlike
Supercharger, the two Battery cards have **different** outcome
tables — same engine plumbing, different printed grants:

**Mind Battery (Core Booster Battery, card #136)**

> *Roll a die. 1-2: gain 1 AP token. 3-4: gain 1 PREVENT-1-COUNTERATTACK
> token. 5-6: choice.*

| Die face | Outcome | Grants |
|----------|---------|--------|
| 1-2 | "+1 AP for the rest of the quest" | `baseApDelta: 1` |
| 3-4 | "1 BLOCK COUNTERATTACK token" | 1× `prevent-counterattack` |
| 5-6 | Player picks one of the above | — |

**Body Battery (Lucky Battery, card #66)**

> *Roll a die. 1-2: gain 1 AP token. 3-4: gain 2 REROLL tokens.
> 5-6: choice.*

| Die face | Outcome | Grants |
|----------|---------|--------|
| 1-2 | "+1 AP for the rest of the quest" | `baseApDelta: 1` |
| 3-4 | "2 REROLL tokens" | 2× `reroll` |
| 5-6 | Player picks one of the above | — |

**5-6 = choice** matches the standard reading: player picks ONE
of the two printed outcomes (NOT both). *Confirmed by user
2026-05-04.*

> **AP outcome — quest-long pool bump (AP unification 2026-05-09).**
> Originally Battery's "+1 AP" outcome granted 1 `ap` consumable
> token. Per user direction 2026-05-09 *("The battery gives +1 AP
> for the rest of the quest. This AP will then obey the normal
> consumable logic of refreshing at the end of each wave.")*, AP
> was unified into the single `loadout.currentAp` / `loadout.baseAp`
> pool (§5.5). The AP outcome now sets
> `EquipmentRollOutcome.baseApDelta = 1` instead of granting a
> consumable; `applyEquipmentRoll` adds the delta to BOTH `baseAp`
> (so it persists for the rest of the quest, refilling at every
> End Wave — §4.2) AND `currentAp` (so the +1 AP is usable THIS
> wave, not just at the next End Wave refresh). At end-of-quest
> all card-based upgrades reset (`baseAp` returns to
> `Tuning.baseAp`); this is the same scope as every other
> equipment grant.

**Spend wiring (full economy this slice):**
- AP — handled by the unified pool in §5.5; no longer a consumable
  token. Battery's "+1 AP" outcome bumps `baseAp` directly (above).
- `reroll` token — Reroll button on the counter-roll modal AND the
  equipment-roll modal (Stage B). Spending re-rolls the most
  recent d6 in place; the modal re-renders with the new value.
  No per-turn cap (`canSpendReroll` only checks the bag).
  *User 2026-05-04: any die roll the player makes can be
  rerolled.*
- `prevent-counterattack` token (shown as **Block Counterattack**) —
  "Block 1 counterattack" button on the counter-roll modal Stage B,
  one per delver holding a token. Opens the `prevent-counter-pick`
  sub-modal listing each counterattacker whose offsets currently land
  on a delver tile. Picking one calls `combat.ts > blockCounterattack`,
  which drops the entry from `phase.damagedEnemies` so that enemy
  contributes nothing to the counter resolution, side effects
  included; no per-turn cap. The cascade
  through downstream computations (block candidates, shield
  opportunities, board highlights) is automatic because they all
  read off `phase.damagedEnemies`.

**Test coverage (`__tests__/battery.test.ts`):**
- equipment.json shape: both R1 cards have
  `effects: [{ kind: "immediately-equipment-roll" }]`.
- `EQUIPMENT_ROLL_TABLES` per-card entries: outcomes + grants +
  `baseApDelta` + rollMap match the printed tables;
  `equipmentRollTableForCard` returns null for non-die-roll cards.
- `outcomeForRoll` for both Mind + Body Battery (1-2 / 3-4 / 5-6
  / out-of-range).
- `applyEquipmentRoll` for Battery: AP-bump (Mind & Body —
  `lo.baseAp` and `lo.currentAp` both increment, no consumable
  token granted) and Prevent / Reroll-x2 outcomes; FIFO drain
  across multi-stacked rolls; `enqueueEquipmentRoll` throws on
  cards without a registered table.
- `applyLevelUpChoice` enqueues one roll PER RANK gained (first
  gain AND rank-ups; Ultra +2 = two rolls — ruling 2026-07-20).
- **Quest-long AP bump persists across waves**: after Battery's
  AP outcome bumps `baseAp` by 1, the End Wave refresh refreshes
  `currentAp` to the *new, bumped* `baseAp` (not the original
  `Tuning.baseAp`).
- `canSpendReroll` / `canSpendPreventCounter` ok / no-token /
  still-ok-after-spending paths.
- Kind independence: spending DD doesn't block Reroll / Block
  Counterattack and vice versa.
- End Wave refresh covers all consumable kinds (Reroll / Block
  Counterattack spent → available) and reports the count in
  `enc.endWaveRefresh`. AP is refreshed in the same refresh but as a
  direct `currentAp = baseAp` write (§4.2).
- No per-turn cap: one delver can spend several of each kind in a
  turn, and the other delver can spend theirs during this delver's
  turn. The DD 1-per-turn cap still applies and resets on a new turn.

### 5.5 AP economy (Quest #1 subset)

- Playing a Weapon Card to attack does **NOT** cost AP. *Confirmed by
  user 2026-05-02.*
- AP is spent on the in-wave **Double Movement** (1 AP),
  **Refresh Weapon** (2 AP), and **Refresh ALL Weapons** (5 AP)
  actions (§5.5.1, §4.3.1; the 5 AP option landed 2026-07-22 per
  the printed AP table). Other rulebook
  consumables (reroll, Block Counterattack, double damage, ignore-ability)
  are consumable tokens and do **not** cost AP — see §5.5.2.
- AP refreshes per **Wave** at End Wave (§4.2), **not** per turn.
  *Unified with the consumable-AP-token model 2026-05-09 per user
  direction:* delvers start with `Tuning.baseAp` (= 3) AP at the
  beginning of the quest and may gain more for the rest of the quest
  via level-up rewards (e.g. Battery's "+1 AP for the rest of the
  quest" outcome bumps `baseAp` directly — see §5.4 Battery — AP
  outcome). At each End Wave `currentAp` tops up to the *current*
  `baseAp`, so any quest-long bumps are honored automatically.

#### 5.5.1 In-turn AP spends (prototype subset)

The active delver can spend AP at any point during their turn (before
or after placement) by tapping the AVAILABLE box on their suit board.
Three options are wired (the 5 AP refresh-all was missing until a
player report 2026-07-22):

| Cost | Effect |
|------|--------|
| **1 AP** | **Double movement this turn.** Multiplicative — `currentMovement` is multiplied by 2 immediately, AND any subsequent `+N movement this turn` slot ability gained this turn is also doubled (`+N` becomes `+N*2`). Once-per-turn (`apMovementDoubledThisTurn` latch). Cannot be spent after movement has been used. |
| **2 AP** | **Refresh 1 weapon card.** Returns one exhausted weapon card from a slot back to the hand for use on a future turn. If the refreshed slot is the just-placed slot, `cardPlacedThisTurn` is also cleared. |

The doubling rule is order-independent: `(base + slot_bonus) * 2`
holds whether AP-double or the +mov slot ability is used first.
*Confirmed by user 2026-05-02.*

#### 5.5.2 Consumable tokens (rulebook p15-16)

Consumable tokens live in the per-delver `consumableTokens` bag.
They are granted by equipment passives (Supercharger / Battery
today; see §5.4) and **persist across turns** until spent. Spent
tokens flip back to Available during the **End Wave refresh**
(§4.2 — every spent token of every kind, across both delvers),
alongside the per-Wave `currentAp` refresh (§4.2).

> **AP unification (2026-05-09).** AP is no longer a `ConsumableTokenKind`.
> The unified AP pool lives on `loadout.currentAp` / `loadout.baseAp`
> (§5.5) and refreshes at End Wave. Battery's "+1 AP" outcome bumps
> `baseAp` directly via `EquipmentRollOutcome.baseApDelta` (see §5.4
> Battery — AP outcome). The `migrateV21ToV22` schema migration in
> `state.ts` folds banked `"ap"` tokens from in-progress saves into
> `baseAp` (`available + spent`) and `currentAp` (`available`).

**Token kinds (state-side):**

| Kind | Where granted | Spend trigger | Effect | Per-turn cap |
|------|---------------|---------------|--------|--------------|
| `damage-2x-light` | Supercharger roll 1 / 4 / 5-6-pick | While attacking with a Light weapon | Double the **total** damage of this swing (printed damage + Flicker-Blade-style adjacency bonuses, all composed first then doubled — see §5.4.6) | (shared DD cap) |
| `damage-2x-medium` | Supercharger roll 2 / 4 / 5-6-pick | Medium weapon swing | Double total swing damage (post-2026-05-25 ordering) | (shared DD cap) |
| `damage-2x-heavy` | Supercharger roll 3 / 4 / 5-6-pick | Heavy weapon swing | Double total swing damage (post-2026-05-25 ordering) | (shared DD cap) |
| `damage-2x-universal` | *(reserved — no source yet)* | Any weapon swing | Double total swing damage (post-2026-05-25 ordering) | (shared DD cap) |
| `reroll` | Body Battery roll 3-4 / 5-6-pick | After ANY player-rolled die (counter, equipment-roll, future) | Re-roll the most recent die | none |
| `prevent-counterattack` | Mind Battery roll 3-4 / 5-6-pick | After counter-roll, before damage application | **Block Counterattack**: pick 1 counterattacker; its whole counterattack is cancelled (no damage, no Rotates / Alert / Flees ...) | none |
| `ignore-ability` | *(reserved — no source yet)* | Targeting | Ignore an enemy keyword for this swing | TBD |

`damage-2x-universal` and `ignore-ability` are reserved enum
members + bag slots so future cards don't require schema churn.
They will not appear on the suit board until something can grant
them.

**Per-turn caps (rulebook p15 + designer decision 2026-11-17):**

The Double Damage family has a single shared per-turn cap
(`damage2xUsedThisTurn: boolean`) — typed AND universal share one
spend per delver-turn, per the rulebook quote: *"No matter the
type of double damage token you use, you can only use 1 double
damage token per turn."*

**Reroll and Block Counterattack have no per-turn cap** (designer
decision 2026-11-17, matching the rulebook's "at any time, even if it
isn't their turn"). Either delver may spend them whenever they're
offered, as often as they have tokens; the only gate is the bag count.
(The old per-kind `consumableSpendsThisTurn` latch was removed from
`HeroTurnState` in v65.) The DD cap follows the **spender** (`heroId`
arg of `spendToken`), not the active delver.

**AP cost gate (`engine/turn.ts > chargeAp`):**

Used by `spendApDoubleMovement` (1 AP) and
`spendApRefreshWeapon` (2 AP). Simple subtract: if
`loadout.currentAp >= cost`, deduct and return `true`; else
return `false`. (No board-vs-token mixing math after the AP
unification — `currentAp` is the only AP pool.)

**Damage-doubling math (`engine/tokens.ts::doubledDamageMultiplier`):**

The token multiplies the **base weapon damage**, *before* slot
bonuses or other modifiers, then the rest of the damage chain
proceeds as normal:

```
final = (base * mult) + slotBonus + soulshiftBonus + ... - block
```

Confirmed via tests: a Mind Hammer (`base=4`) with Light DD spent →
multiplier null (mismatch, REJECT); with Heavy DD spent → 8 base;
with Universal DD → 8 base regardless of weapon type.

**Reroll spend flow.** A "Reroll (N available)" button
appears in the post-roll stage of the `counter-roll` modal AND
the `equipment-roll` modal whenever the bearer holds a Reroll
token. Click → `spendToken("reroll")` +
re-roll the d6 + re-render the modal at the same stage with the
new value. The new roll could land on the same outcome — or a
different one; `outcomeForRoll` re-evaluates either way. (No
"reroll cancel" — once spent, the new roll IS the result; you
can't keep the old one.)

**Block Counterattack spend flow** (designer decision 2026-11-17). A
"Block 1 counterattack (N available)" button appears in the
counter-roll modal post-roll stage for each delver holding a token
(either delver, on any turn), when at least one counterattack would
land. Click → opens the `prevent-counter-pick` sub-modal listing each
counterattacker whose offsets currently land on a delver tile.
Picking one → `combat.ts > blockCounterattack(state, phase, spender,
instanceId)`: spends the token and splices the enemy out of
`phase.damagedEnemies`. That cancels its counterattack **completely**:
no damage, and none of its "after attempting to counterattack" effects
(Rotates, Alert, Flees, Accurate, Strength, Teleports, Shell ...).
Because every downstream computation (block candidates, shield
opportunities, board highlights, post-counter abilities) reads off
`phase.damagedEnemies`, the cascade is automatic. One token = one
enemy's counterattack. (2026-11-15 to 2026-11-17 a block let the side
effects fire; that ruling is reversed.)

**Storage shape (`CampaignState.consumableTokens`):**

```ts
type ConsumableTokenBag = Partial<Record<ConsumableTokenKind, {
  available: number;
  spent: number;
}>>;

consumableTokens: Record<HeroId, ConsumableTokenBag>;
```

Sparse on purpose: only kinds that have ever been granted
materialize an entry. `tokenAvailable` / `tokenSpent` default to 0
for missing keys so reads are safe everywhere.

**Double Damage spend flow (attack-time UI gate, `ActionResolution.ts`):**

After targets are locked but before `useWeaponAbility` fires, the
`promptDoubleDamageOrFire` helper checks
`canSpendDoubleDamage(state, heroId, kind)` for each typed +
universal kind and either:

1. opens the `double-damage-prompt` modal if any are eligible
   (player can pick one or skip), or
2. dispatches the swing immediately if none are eligible
   (no token / cap latched).

Soulshift bonus swings (auto-fired follow-ups) **bypass the
prompt** — they would force an extra modal between every chained
target and the cap is already latched anyway.

**Suit-board surface (`SuitPanel.ts > buildResourceBadgeRow`):**

The AVAILABLE and SPENT boxes each render a SINGLE horizontal row
of icon+count badges containing every spendable resource the
delver currently carries:

```
[AP-bolt xN] [2x-light xN] [2x-medium xN] [2x-heavy xN] [reroll xN] [block-counterattack xN]
```

Order is stable left-to-right: AP first, then the 3 Double Damage
typed kinds (Supercharger family — Light → Medium → Heavy), then
the 2 surviving Battery kinds (Reroll → Block Counterattack). AP is
ALWAYS visible (it's the universal resource); consumable kinds
appear once the delver has gained them at least once and stay
visible at dimmed `x0` thereafter so the layout doesn't shift
mid-wave as the player spends/refills. The same row layout
mirrors into the SPENT box, reading each entry's `spent` count
instead of `available`.

Pre-2026-05-09 AP rendered as `buildApDotRow` — one yellow
lightning-bolt glyph PER AP — which made AP visually dominate the
box (a 3-AP delver got 3 large bolts) and pushed consumable
badges into a cramped second row at a noticeably smaller size.
The unified `buildResourceBadgeRow` renders AP as one icon +
integer count using the same 20px `.consumable-icon` container
as every other badge, satisfying the player's "all icons same
size, no overlap, full use of available space" request. The row
flex-wraps when the player owns the full 6-kind inventory so
nothing overflows into the printed AVAILABLE / SPENT word at the
top of the box.

Display metadata (icon path, label, "where do I spend this?"
tooltip) for asset-backed kinds lives in
`data.ts > CONSUMABLE_TOKEN_DISPLAY` so the SuitPanel badge row,
the AP-spend menu's bag info section, and any future spend-prompt
all read from one source. AP has no asset entry — its icon is
the inline lightning-bolt at `data.ts > AP_BOLT_SVG_INNER`,
painted yellow (lit) in the AVAILABLE row and muted grey in the
SPENT row via the `.consumable-badge--ap` modifier. Every badge
wraps its `<img>` / `<svg>` in a fixed-size `.consumable-icon`
container so all kinds visually align at the same footprint
regardless of source-asset aspect ratio.

**AP-spend menu — "Consumables in your bag" info section
(`ActionResolution.ts > renderApSpendModal`):**

The AVAILABLE-box menu shows the two AP-spend buttons (Double
movement / Refresh weapon card) AT THE TOP, followed by a
read-only **Consumables in your bag** section listing every kind
with `tokenAvailable() > 0`. Each row is a disabled
`.action-option` button — the consumables are reactive (spent in
their own moment: DD during a swing, Reroll on a die roll,
Block Counterattack during a counterattack, AP as auto top-up to AP
costs), so the row's tooltip surfaces *where* each token is
actually spent rather than offering a from-menu spend. The list
is hidden entirely when the bag is empty so a starter-deck delver
sees the unchanged 2-button menu. Order matches the SuitPanel
badge row (DD Light → Medium → Heavy → AP → Reroll →
Block Counterattack).

### 5.6 XP at end of multi-kill resolution

After all enemies from one attack are resolved (counter + drops), check
for level-ups *once* (p24): spend XP one level at a time until below
the next threshold.

### 5.7 Prepare to Run (wave-end trigger)

Prepare to Run is the **automatic alternative** to the mandatory
Placement at the start of each turn (§4 stage 1). A Delver auto-
prepares the moment a fresh turn begins and they have **no playable
weapon cards in hand** (i.e., every weapon card is already exhausted
in a slot). The latch is sticky *as long as the hand has no playable
weapon*; the moment a 2-AP refresh restores one (whether mid-turn
or via the next-turn self-heal), the latch clears automatically —
see "Escape hatch" below. *Confirmed by user 2026-05-02: there is no
manual "Prepare to Run" button; the latch is purely auto-detected.*

A Delver who has prepared to run still alternates turns with the other
Delver (they may be waiting for the other player to also prepare).
On those turns the only available choices are **`spendApRefreshWeapon`**
(the escape hatch) and **End Turn** — they cannot place, move, or
use a weapon / slot ability while the latch is set. (Movement is gated
on placement having happened; placement is locked out by the
prepared-to-run latch — see §5.2 for the action gate.)

##### Escape hatch: 2-AP refresh (refined 2026-05-18)

`spendApRefreshWeapon` is **legal even while `preparedToRun` is
true** (user repro 2026-05-18: pre-fix the gate Catch-22'd the
player — the very call that would have un-stuck them was rejected
because they were stuck). The refresh:

- Removes a card from the chosen weapon slot (returns it to the
  conceptual hand, via the loadout / `equipmentRanks` indirection).
- Spends 2 AP.
- **Re-evaluates the latch in place**: if `hasPlayableWeaponInHand`
  returns true (which it always will when refresh restores any
  weapon), `preparedToRun[heroId]` is cleared immediately. The
  player can then complete the SAME turn normally — mandatory
  placement → optional movement / action. This mirrors the
  `startHeroTurn` self-heal at lines 116-118 of `engine/turn.ts`
  (the latch's only legitimate raison d'être is "no playable weapon
  in hand"; the moment that precondition stops being true the latch
  has no reason to persist).

This matches the rulebook intent: a player who burned their last
weapon and didn't plan ahead can still recover by spending 2 AP at
the start of their prepared-to-run turn, then taking that turn as
if they'd just placed the refreshed weapon directly. The only state
in which the latch becomes truly permanent for the wave is
"prepared-to-run AND `currentAp < 2` AND no future AP gain coming"
— and even then the OTHER delver may still be playing, so the wave
continues until both delvers are prepared (§5.9 transition).

> **Bug history (fixed 2026-05-18, two-part).** First repro: the
> refresh gate itself rejected with "delver has prepared to run".
> Fixed by removing the `preparedToRun` check from
> `spendApRefreshWeapon`. Second repro (same session, exposed by
> the first fix): the latch was kept sticky for the current turn,
> so the subsequent `playWeaponCard` to place the refreshed weapon
> still rejected with "delver has prepared to run". Fixed by
> re-evaluating the latch inside `spendApRefreshWeapon` and clearing
> it the moment the hand has a playable weapon again. Both legs
> covered by the `USER REPRO 2026-05-18` test in
> `src/__tests__/turn.test.ts`.

The Hero Phase ends — and the wave advances to the Parting Shots
Phase (§5.9) — the moment both Delvers have prepared. The transition
fires from `engine/turn.ts > endHeroTurn` via
`engine/wave.ts > maybeEnterPartingShotsAfterTurn`; if `bothPrepared`
returns true, `EncounterState.phase` flips from `"hero"` to
`"parting-shots"` and `BoardScreen` swaps the right column to
`screens/WavePhases.ts > renderPartingShots` on the next render.

State shape:
- `EncounterState.preparedToRun: Record<heroId, boolean>` — sticky.

Implementation:
- `engine/turn.ts > startHeroTurn` runs the auto-prepare check after
  refreshing movement and creating a fresh `turnState`. The check
  uses `hasPlayableWeaponInHand` (private helper) which walks
  **`state.equipmentRanks[heroId]`** (every owned type at rank ≥ 1,
  resolved to its suit-specific card via `getEquipmentByTypeSuit`)
  against `loadout.slotCards`. This MUST mirror HandPanel's hand
  definition and `playWeaponCard`'s ownership check — see the bug
  history note below.
- Self-healing clear: if `preparedToRun[heroId] === true` BUT
  `hasPlayableWeaponInHand` returns true, `startHeroTurn` clears the
  latch. After the 2026-05-18 fix this is the **primary recovery
  path** for the escape hatch above: a player who refreshed a
  weapon during a prepared-to-run turn will land here on their
  next turn-start and be un-latched automatically. It ALSO catches
  any save still stuck in the pre-2026-05-09 bad state (where
  `hasPlayableWeaponInHand` mistakenly walked starting equipment
  only). Tests that want to force the parting-shots transition via
  `prepareToRun` must also exhaust the hand to satisfy this
  invariant — see `wave.test.ts > endHeroTurn fires the transition
  when both delvers are now prepared`.

> **Bug history (fixed 2026-05-09).** Before the widening,
> `hasPlayableWeaponInHand` walked `getStartingEquipment(heroId)`
> only — the same starting-equipment-only scope bug `playWeaponCard`
> had before its 2026-05-04 fix. User repro: with Hammer + Beam
> (starting weapons) placed and Mace (level-up acquired) still in
> hand, `startHeroTurn` auto-latched `preparedToRun = true`.
> Subsequent `playWeaponCard` calls then rejected silently with
> `"delver has prepared to run"`, and tapping any empty slot was a
> no-op. Both code paths now agree on a single owned-equipment
> definition (walk `equipmentRanks`, not the printed starting deck),
> and a self-heal in `startHeroTurn` unsticks any save in the bad
> state on next turn.
- `engine/turn.ts > prepareToRun` remains as a low-level primitive
  for tests and future wave-end automation, but is no longer wired
  to a UI button.

### 5.8 Slot abilities

Each Weapon Slot on the suit board prints an alternative **Slot
Ability** that the active delver may use *instead* of the placed
Weapon Card's printed ability (see §5.2 — pick exactly one). Slot
abilities are tied to the slot's printed **Element** symbol, not the
card placed in it; the card just exhausts.

Slot abilities are modelled as a tagged union in `src/types.ts`:

```ts
export type SlotAbility =
  | { kind: "damage-any-enemy"; damageType: DamageType; selfSuffer?: number }
  | { kind: "bonus-movement-this-turn"; amount: number }
  | { kind: "refresh-ap"; amount: number }
  | { kind: "gain-token"; token: "creature-part" | "boss-part" }
  | { kind: "gain-element"; element: Element };
```

The structured form lives on `WeaponSlotOverlay.slotAbility` in
`data/delverBoards.json`; the human-readable text stays on
`WeaponSlotOverlay.slotAbilityText` for the action modal.

#### 5.8.1 Per-suit per-element table

| Element | Mind suit | Body suit |
|---|---|---|
| radiance | `damage-any-enemy` (light) | `gain-element` (void) |
| void     | `gain-element` (earth)     | `damage-any-enemy` (medium, selfSuffer 1) |
| earth    | `bonus-movement-this-turn` (1) | `gain-element` (wind) |
| fire     | `refresh-ap` (1)           | `gain-element` (water) |
| wind     | `gain-element` (fire)      | `bonus-movement-this-turn` (1) |
| water    | `gain-element` (radiance)  | `refresh-ap` (1) |

(Earlier drafts of this table listed `gain-token` (creature-part /
boss-part) for the radiance/void rows; that mismatched the printed
card art and was fixed on 2026-05-09 — see
`data/delverBoards.json` and the slot-ability test header. The
`gain-token` kind stays in the {@link SlotAbility} union for
future cards that ARE wired to grant parts; no Quest 1 slot uses
it today.)

#### 5.8.2 Resolution by kind

Resolved by `engine/slotAbilities.ts > resolveSlotAbility(state,
heroId, slotIdx, params)`:

- `damage-any-enemy`: requires `params.targetX/targetY` pointing at a
  *live* enemy (any tile on the board, no range restriction). If
  `selfSuffer` is set, the attacker loses that much HP **before**
  damage is dealt. Then runs the AttackSession lifecycle (§5.4.2):
  damage → shared counter (single d6, auto-skipped when no possible
  outcome could land) → kill side-effects → finalize.
- `bonus-movement-this-turn`: bumps the active delver's
  `currentMovement` by `amount`. (Movement gating already re-reads
  `currentMovement`, so the new movement budget is immediately
  usable for the same turn.)
- `refresh-ap`: bumps `currentAp` by `amount`, capped at `baseAp`.
- `gain-token`: requires `params.recipientHeroId`. Increments
  `state.minionParts[recipient]` (for `creature-part`) or
  `state.bossParts[recipient]` (for `boss-part`).
- `gain-element`: requires `params.recipientHeroId`. Increments
  `state.elements[recipient][element]` by 1.

The resolver mutates `state` directly and returns a small
`{ summary, detail }` log object the wrapper passes back to the UI
(used today only for diagnostic logging — no user-facing modal
surfaces it). The `useSlotAbility` wrapper (§5.2.1) handles gating
and `actionUsedThisTurn` latching.

### 5.9 Parting Shots Phase (rulebook p26)

Once both Delvers have prepared (§5.7), the Hero Phase ends and every
**alive** enemy resolves its Parting Shot Ability **one at a time, in
spawn order** (rulebook p26: *"Resolve each enemy's Parting Shot
Ability one at a time"*). Dead enemies — including any killed during
the same turn that triggered the Hero Phase exit — are skipped (p26:
*"discard all enemies and any uncollected items remaining on the
board"* happens after this phase, but parting-shot text only fires for
survivors).

#### 5.9.1 Default scope: both delvers

Per rulebook p26: *"Unless an ability states otherwise, a Parting Shot
Ability affects both Delvers regardless of their position on the
board."* So a card whose printed text reads simply *"1 Damage."* hits
**both** delvers for 1 — distance and line-of-sight are irrelevant.
Only ability text that says otherwise (e.g. *"to nearest Delver"*,
*"within 2 tiles"*) narrows the scope.

#### 5.9.2 Structured PartingShot tagged union

The four printed patterns we observed across the Quest #1 enemy set
are encoded as a tagged union on `EnemyCard.partingShot`
(`src/types.ts`):

```ts
type PartingShot =
  | { kind: "all-delvers";    damage: number }
  | { kind: "nearest-delver"; damage: number }
  | { kind: "delvers-within"; damage: number; range: number };
```

| Printed text | `kind` | Notes |
|---|---|---|
| *"1 Damage."* / *"2 Damage."* | `all-delvers` | Default p26 scope |
| *"2 Damage to nearest Delver."* | `nearest-delver` | Chebyshev distance; tie ⇒ active player chooses |
| *"2 Damage to any Delver within 2 tiles."* | `delvers-within` | Chebyshev range; everyone in range eats it |

All three pattern resolvers live in `engine/wave.ts > applyPartingShot`.
The original printed sentence is preserved on
`EnemyCard.partingShotText` for the UI (so the player can still read
the actual rulebook text, not just our paraphrased kind tag).

#### 5.9.3 Tie-break: active player picks

For `nearest-delver` parting shots when multiple delvers tie on
Chebyshev distance, the **active player** picks which delver eats the
damage (rulebook p26 default for "active player tiebreaker"). The
engine surfaces this via:

- `partingShotNeedsChoice(enc, enemy, card): boolean` — pure check the
  UI calls before invoking `resolvePartingShot`.
- `resolvePartingShot(state, { chosenDelverId })` — accepts the
  chosen hero id; ignored if no tie exists.

The UI (`screens/WavePhases.ts > renderPartingShots`) renders a
chooser button per tied delver instead of the single Resolve button
when the engine reports a tie. Non-tie shots resolve with a single
Resolve click.

#### 5.9.4 One-at-a-time cursor + auto-advance to End Wave

`EncounterState.partingShotCursor` is the index into `enemies[]` of
the next enemy to resolve. `nextPartingShotEnemy` walks forward,
skipping dead enemies, and returns `null` when the cursor exits the
list — at which point `resolvePartingShot` automatically enters End
Wave (`enterEndOfWave(state, "victory")`, which runs the End Wave
refresh). Each `resolvePartingShot`
call increments the cursor by exactly one enemy and returns a
`PartingShotResult` for the UI's running log:

```ts
interface PartingShotResult {
  enemyInstanceId; enemyCardId;
  hits: Array<{ heroId; damage }>;
  chosenDelverId: string | null;  // for tie resolutions
  delverDied: boolean;             // short-circuit signal
}
```

#### 5.9.5 Death short-circuit (rulebook p26)

Per p26: *"If a Delver dies at any point, the current Phase
immediately ends and both players proceed directly to the End of Wave
Phase."* This applies inside Parting Shots too — a parting shot that
drops a delver to 0 HP ends the phase mid-list and jumps straight to
End of Wave (§5.10) with `endOfWaveOutcome = "defeat"`. The remaining
unresolved enemies do **not** get to fire.

Implementation: `resolvePartingShot` calls
`onDelverDamaged(state)` after applying every hit; that helper checks
every loadout's `currentHp <= 0` and, if any hit zero, immediately
calls `enterEndOfWave(state, "defeat")`. The same helper is wired
into `engine/combat.ts > finalizeAttackSession` so a counter-attack
that kills a delver mid-Hero-Phase also short-circuits.

### 5.10 End of Wave Phase + retry

The End of Wave Phase reads the wave's storybook entry and routes to
one of two narrative pages based on the survival outcome (Q1 wave 1
data in `data/quest1.json > wave1.endOfWave`):

| Outcome | Page id | Trigger |
|---|---|---|
| `"victory"` | `bothSurvive` (= `page1_1`) | Both delvers alive after the last parting shot → `resolvePartingShot` |
| `"defeat"`  | `anyDie` (= `page1_2`)      | Any delver hit 0 HP at any point → `onDelverDamaged` short-circuit |

Victory also flips `state.quest1Completed = true` so the Title screen
and Campaign Sheet can show "Quest 1 cleared".

`enterEndOfWave(state, outcome)` performs the actual transition:
sets `enc.phase = "end-of-wave"`, populates `endOfWavePageId` and
`endOfWaveOutcome`, and marks every enemy `alive = false` (per p26's
*"discard all enemies and any uncollected items remaining on the
board"* — even if Parting Shots was short-circuited, the wave is
ending and the board clears).

The UI (`screens/WavePhases.ts > renderEndOfWave`) renders the
storybook page text and offers buttons sized to the outcome AND
whether the player is on their first quest clear vs a replay:

- **Victory · first clear** (`!townVisit1Completed`) → "Continue →
  Chapter 1: Town Visit" (primary; calls `completeWave` then
  `endQuestReset`, anchors `state.townVisit = { chapterId: "ch1",
  pageId: "page6", pagesEntered: [] }`, routes to the `townVisit`
  screen — see §5.10.1) and "View Campaign Sheet" (peek-only side
  trip; calls `completeWave` only and routes to the Campaign Sheet
  without resetting).
- **Victory · replay** (`townVisit1Completed === true`) → "Finish
  Quest → Return to Title" (still runs `endQuestReset` so the player
  loses their per-quest gains every time, matching the rulebook
  reset row) and "View Campaign Sheet".
- **Defeat** → "Try Again" (calls `resetWaveForRetry`) and "Return
  to Title". No `endQuestReset` on defeat — the player keeps every
  per-quest gain so a near-miss isn't grind-erasing.

`resetWaveForRetry` rebuilds the wave from scratch: drops the
encounter (next render rebootstraps via `ensureEncounter`), restores
each delver's `currentHp = maxHp / currentAp = baseAp / currentMovement
= baseMovement`, clears all `slotCards` to `null`, and re-applies any
IMMEDIATELY-tagged passives (e.g. Exoframe Armor's `+3 currentHp`).
**Shared XP / level / parts / `quest1Completed` are NOT reset on
retry** — the rulebook is silent on retry semantics, and we keep
accrued progress to avoid grinding it away on a near-miss death.
(Open to revisit if the live playtest finds this too forgiving.)

#### 5.10.1 `endQuestReset` — quest-end teardown (2026-05-09)

End-of-Quest is its own concept distinct from End-of-Wave: a quest
can span multiple waves (Q1 happens to be 1, but Q2+ won't), and
the rulebook's per-quest reset row applies once at the END of the
LAST wave. For Q1 the End-of-Wave (victory) screen doubles as the
End-of-Quest stage, calling `endQuestReset(state)` before routing
into the Town Visit.

`endQuestReset` divides campaign state into two buckets:

| Bucket | Outcome on `endQuestReset` |
|---|---|
| **Campaign-level (preserved)** — `minionParts`, `bossParts`, `memoryChips`, `quest1Completed`, `townVisit1Completed`, `townVisit`, `townDecisions`, `shopProductsAvailable`, `shopProductsOwned` | **Untouched.** These are the persistent ledger that survives quest boundaries. Parts and chips are the currency the player spends in the Town Visit shop; completion flags drive narrative routing. |
| **Quest-level (cleared)** — `equipmentRanks`, `xpOnHand`, `totalXp`, `currentLevel`, `levelUpCardsOwed`, `consumableTokens`, `elements`, `loadouts.*` (HP/AP/MP/baseAp/baseMov/slotCards), `encounter`, `currentDelverId` | **Reset.** Equipment ranks rebuild via `newEquipmentRanks` (R1 starter only, 0 elsewhere). Loadout fields snap back to `Tuning.startingHp / baseAp / startingMovement`, then starter-equipment IMMEDIATELY passives re-apply (Exoframe `maxHp = 9`, Boots `baseMovement = 2` floor). Element + consumable bags become fresh empty objects. `currentDelverId` snaps back to `hero-01`. |

Loadout reset uses the SAME helper-shape as `newCampaign` so a
quest-end delver is byte-identical to a fresh campaign delver
*minus* the campaign-level keepers. This means a Battery / Boots
upgrade gained mid-quest is genuinely undone (the rank is gone, AND
the bumped `baseAp` / `baseMovement` is back to baseline).

`endQuestReset` is a pure mutator — it does NOT navigate. The UI
calls `goTo({ name: "townVisit" })` separately so the routing is
explicit at the call site (and reusable by future "abandon quest"
flows that don't go via End-of-Wave).

The Town Visit anchor (`state.townVisit = { chapterId, pageId,
pagesEntered }`) is set OUTSIDE `endQuestReset` so the engine
function stays narrative-agnostic — the End-of-Wave screen owns
which chapter / page to drop the player into.

---

## 6. Quest #1 setup (rulebook p4 + storybook ch1 p4)

- 5×5 Tide board.
- Players each start with: 6 HP / 6 max HP, 1 Movement, Light/Med/Heavy
  damage cubes at the lowest slot (1 / 1 / 1 by default), 3 AP, hero's
  starting equipment (3 cards) — see hero card.
- Spawn layout from storybook ch1 page 4 (extracted as
  `public/cards/storybook_ch1_page4.jpg`):
  - 2 Delver tiles (both at the same tile in our calibration).
  - 1 Boss tile (Soulhunter).
  - 7 Minion tiles (random Crystanid 1–7 assignment, fixed once per
    quest as part of `state.encounter.enemies`; see §6.1).
- Wave goal: *"Survive to the end of Wave 1."*
- Soulhunter death drops *LVL 1 BOSS PART* (per-living-delver — see
  §3.5) and grants the printed "gain a LEVEL UP card" reward: a
  `Level Up cards owed` increment plus one interactive Level-Up draw
  per delver (§3.5 item 4). Drop ID in data is `"boss-part-lvl-1"`.

### 6.1 Encounter state (live, mutable)

The static spawn data in `data/quest1.json` describes the **initial**
layout only. While a wave is in progress, the *live* state of the board
lives on `CampaignState.encounter` (typed as `EncounterState | null`):

```
EncounterState {
  questId:          "quest-1"
  waveNumber:       1
  delverPositions:  Record<heroId, { x, y }>
  enemies: Array<{
    instanceId:     stable id, e.g. "minion-3" or "boss"
    cardId:         e.g. "crystanid-005" (resolved minion assignment lives here)
    x, y:           current position
    damageTaken:    cumulative damage tokens placed on the card
    alive:          false once damageTaken >= card.hp
  }>
  turnState: Record<heroId, {
    cardPlacedThisTurn:  {
      slotIdx, cardId,
      autoRefreshedElement: Element | null            // §4.3.2 — set when placement spent 2 elements
    } | null                                          // §4 stage 1; irreversible once set
    actionUsedThisTurn:  boolean                     // §5.2 — set by useWeaponAbility / useSlotAbility
    movementUsedThisTurn: boolean                    // §5.1
    apMovementDoubledThisTurn: boolean               // §5.5 — AP-bought-2nd-step latch
  }>
  preparedToRun: Record<heroId, boolean>             // §5.7 sticky latch

  // Wave phase machine (§5.9 / §5.10) ---------------------------
  phase:                "delver-spawn-pick" | "first-turn-pick" | "hero"
                      | "parting-shots" | "end-of-wave" | "completed"
  partingShotCursor:    number                       // §5.9.4 — index into enemies[]
  endWaveRefresh:       EndWaveRefreshResult | null  // §4.2 — End Wave refresh summary + latch
  endOfWavePageId:      string | null                // §5.10 — quest1 page id
  endOfWaveOutcome:     "victory" | "defeat" | null  // §5.10

  // Level-Up draw flow (§3.4) ----------------------------------
  levelUpDeck:          number[]                     // shuffled card numbers (1..28), drawn from front
  levelUpDiscard:       number[]                     // resolved level cards, reshuffled when deck empties
  pendingLevelUpDraws:  Array<{                      // FIFO queue, gates End Turn
    heroId: string
    cardNumber: number                               // pre-drawn card identity
  }>
}
```

The campaign-scoped (rather than encounter-scoped) sibling field is:

```
CampaignState.equipmentRanks: Record<heroId, Partial<Record<EquipmentType, number>>>
```

Each entry is 0 (not owned) or 1..5 (owned at that rank). Initialized
from each hero's starting equipment in `state.ts > newEquipmentRanks`.
Bumped by `engine/levelUp.ts > applyLevelUpChoice`. Read by
`HandPanel`, `SuitPanel`, and `engine/combat.ts > effectiveDamageForCard`.

Schema version: **16** (was 15 — bumped to invalidate localStorage
saves that predate the rank table + level-up deck fields).

#### 6.1.1 Phase machine

Every wave runs through a strict linear phase sequence:

```
delver-spawn-pick ─► first-turn-pick ─► hero ──► parting-shots ──► end-of-wave ──► completed
                                         │                            ▲   (End Wave refresh
                                         └── delver dies (any phase) ─┘    runs on entry)
```

| Transition | Trigger | Owner |
|---|---|---|
| `hero → parting-shots` | Both delvers prepared (§5.7) at end of any turn | `maybeEnterPartingShotsAfterTurn` (called by `endHeroTurn`) |
| `parting-shots → end-of-wave (victory)` | `nextPartingShotEnemy` returns null after the last alive enemy resolves (End Wave refresh runs on entry) | `resolvePartingShot` → `enterEndOfWave` |
| `end-of-wave → next wave` (continue) | UI's "Continue → Wave N" button | `completeWave` + `bootstrapNextWave` (builds the wave + "if continuing" effects, §4.2) |
| *any* `→ end-of-wave (defeat)` | Any delver hits 0 HP | `onDelverDamaged` (called from `combat.finalizeAttackSession`, `wave.resolvePartingShot`, and any future damage path) |
| `end-of-wave → completed` (+ Town Visit anchor on first clear) | UI's "Continue → Chapter 1: Town Visit" button (victory · `!townVisit1Completed`) | `completeWave` + `endQuestReset` (§5.10.1) + sets `state.townVisit`, then `goTo({name: "townVisit"})` |
| `end-of-wave → completed` (replay) | UI's "Finish Quest → Return to Title" button (victory · `townVisit1Completed`) | `completeWave` + `endQuestReset`, then `goTo({name: "title"})` (player keeps shop ownership but loses per-quest gains again) |
| `end-of-wave → (rebuilt fresh)` | UI's "Try Again" button (defeat) | `resetWaveForRetry` (drops encounter; next render bootstraps); NO `endQuestReset` on defeat |

The phase value is the single switch the UI uses to decide which
right-column screen to render in `BoardScreen` — `hero` keeps the
Hero-Phase controls (movement / action / end turn), all other phases
hand off to `screens/WavePhases.ts > renderWavePhaseScreen`.

Rules:
- `encounter === null` means "no wave currently in progress"; a fresh
  quest bootstraps it from `quest1.spawn` on first board render via
  `engine/encounter.ts > ensureEncounter`.
- Once the wave ends (or quest restarts), `encounter` is reset to
  `null` so the next entry rebuilds it cleanly.
- The previous `state.wave1MinionAssignment` field is **gone** — the
  resolved crystanid id for each spawn slot lives directly on its
  `EnemyInstance.cardId`. One source of truth, no parallel arrays.
- `BoardScreen.renderTokens` reads from `encounter` (alive enemies +
  current delver positions), not from `quest1.spawn`. The spawn data
  is only consumed by `ensureEncounter`.

### 6.2 Right-column view + auto-peek to deciding delver

The right column of the BoardScreen renders ONE delver's suit board
+ hand at a time. Which delver is shown is governed by two pieces
of `uiState`:

| Source            | Set by                            | Beats |
|-------------------|-----------------------------------|-------|
| auto-peek (modal) | `syncAutoPeekToModal` on render   | manual peek + active delver |
| manual peek       | "See other Delver" topbar button  | active delver |
| active delver     | `state.currentDelverId` (default) | — |

**Auto-peek** (wired 2026-05-09): when a modal opens that asks for
a decision from a SPECIFIC delver, the right column automatically
switches to that delver so the player can see THAT delver's
elements / hand / slot state while making the choice.

Recognised "per-delver" modals (see `uiState.modalDecider`):

| Modal kind          | Decider                                          |
|---------------------|--------------------------------------------------|
| `level-up`          | `pendingLevelUpDraws[0].heroId`                  |
| `equipment-roll`    | `modal.heroId` (Supercharger / Battery die-pick) |
| `element-pick`      | `pendingElementChoices[0].heroId`                |
| `shield-prompt`     | `queue[cursor].shieldBearerHeroId`               |

All other modals (action-menu, die-roll, counter-roll, ap-spend,
trident/mace/boots/soulshift pickers, weapon-counter-block, etc.)
are part of the active delver's own action sequence — peek doesn't
shift for them.

**Implementation**: `syncAutoPeekToModal(modal, encounter)` runs once
per BoardScreen render, BEFORE the wave-phase router check, BEFORE
`peekedDelverId` is read for the right-column view. It mutates
`peekedDelverId` reactively:

- New decider exists → `setPeekedDelverId(decider)` and latch ON.
  When two queued per-delver modals fire back-to-back for DIFFERENT
  delvers (e.g. both delvers' Battery rolls at the same quest start),
  the peek follows the head of the queue — no flicker between them.
- New decider is null AND latch is ON → `clearPeek()` (return view
  to the active delver) and latch OFF.
- New decider is null AND latch is OFF → no-op (manual peek, if
  any, is preserved).

**Restore semantics** (design decision 2026-05-09): when the modal
queue empties, the view ALWAYS returns to the active delver
(`state.currentDelverId`) — NOT to whatever the user was manually
peeking at before the modal opened. This is a deliberate
simplification; if the user wants to re-peek they hit the topbar
button again. Mid-attack auto-peek (shield-prompt) is part of the
action's blocking flow so the player sees the shield bearer's
elements during the spend choice.

`clearActionState` (called on End Turn / hero swap AND between
actions via `advanceAfterAction`) drops the latch too so the next
phase starts with a clean peek slate; for End Turn the explicit
`clearPeek()` in the turn-flow helpers handles the view reset, and
for the in-turn `advanceAfterAction` path `clearActionState` itself
also wipes the peek when the latch was active (otherwise the peek
would stay stuck on the modal's deciding delver — repro 2026-05-25,
Quest 2 first turn with hero-02 active and hero-01 holding
Supercharger).

---

## 7. Map of code → rules

### 7.1 Module layers

The codebase is split into four layers; UI may depend down, never up.

```
data/*.json   ──► src/data.ts
                     ▲
src/types.ts ────────┘
                     ▲
src/config/tuning.ts │      src/rules.ts
                     ▼      ▼
                  src/state.ts (persisted CampaignState)
                     ▲
                     │
              ┌──────┴──────┐
              │             │
        src/engine/*    src/uiState.ts (ephemeral)
              ▲             ▲
              └──────┬──────┘
                     │
              src/screens/*  +  src/board/*  +  src/main.ts (router)
```

- **`src/engine/`** — pure game-rule functions. No DOM, no router, no
  persistence side-effects. Mutates / returns `CampaignState` (or
  fragments of it) and returns plain result objects. Tested via
  `vitest`. Currently:
  - `loadout.ts`   — slot place/remove/swap rules
  - `kills.ts`     — `applyKill` (XP, drops, level-up cards) +
    `applyPendingLevelUps`
  - `encounter.ts` — `ensureEncounter` bootstrap from quest spawn data;
    spatial lookup helpers (`getEnemyAt`, `getDelverAt`)
  - `turn.ts`      — `startHeroTurn` / `endHeroTurn` (refresh
    movement + AP + reset turnState per §4.1); `playWeaponCard`
    (mandatory turn-start placement per §4 stage 1); `prepareToRun`
    (sticky latch per §5.7); `useWeaponAbility` / `useSlotAbility`
    (Action step gates per §5.2.1)
  - `combat.ts`    — Weapon-card ability resolver:
    `computeWeaponHitTiles` per `WeaponRange` kind (§5.4.3),
    `applyDamageAtTile`, `applyCounter` (low-level primitive),
    `AttackSession` lifecycle (`buildAttackSession` /
    `resolveAllDamage` / `resolveSharedCounter` /
    `finalizeAttackSession`) per §5.4.2
  - `slotAbilities.ts` — Slot-ability resolver: `resolveSlotAbility`
    dispatch on `SlotAbility.kind` (§5.8)
  - `movement.ts`  — Movement step (per-tile, DESIGN.md §5.1.1):
    `chebyshevDistance`, `isAdjacent8`, `legalStepDestinations`,
    `moveDelverStep`, `endMovementStep`, `collectTileDrops`
  - `wave.ts`      — Wave phase machine (§5.9 + §5.10):
    `maybeEnterPartingShotsAfterTurn`, `nextPartingShotEnemy`,
    `partingShotNeedsChoice`, `resolvePartingShot`, `enterEndOfWave`
    (End Wave refresh), `applyContinuingEndWaveEffects`,
    `bootstrapNextWave`, `completeWave`,
    `resetWaveForRetry`, `onDelverDamaged` (death short-circuit)
- **`src/uiState.ts`** — page-session ephemeral UI state (peeked
  delver, selected hand card). Never persisted. Single canonical home;
  do NOT add new module-scoped UI `let`s in screen files.
- **`src/state.ts`** — the persisted `CampaignState` (localStorage,
  versioned). Anything that needs to survive a refresh goes here.
- **`src/screens/*`, `src/board/*`** — render + dispatch only. They
  read from state/uiState and call into engine functions; they do not
  encode rules themselves.

### 7.2 Rule → file index

| Rule | File | Notes |
|---|---|---|
| 8-way adjacency | `src/rules.ts`, re-exported by `src/engine/movement.ts` | `ADJACENT_OFFSETS_8WAY`, `isAdjacent8` |
| Movement step (per-tile step-by-step, enemies block, doubling-back allowed) | `src/engine/movement.ts` | `legalStepDestinations`, `moveDelverStep`, `endMovementStep`; floating "moves left" badge owned by `screens/BoardScreen.ts > renderMovementOverlay`; tested in `src/__tests__/movement.test.ts`; DESIGN.md §5.1.1 |
| Slot place / remove (low-level mutators) | `src/engine/loadout.ts` | `placeCardInSlot`, `removeCardFromSlot`. All gated callers (`playWeaponCard`, `spendApRefreshWeapon`, `undoWeaponPlacement`) live in `src/engine/turn.ts`. The previous `resolveSlotClick` "swap / free-remove" helper was removed 2026-05-18 after a user repro where clicking a placed weapon returned it to hand without spending AP (see `screens/SuitPanel.ts > handleSlotClick`) |
| On-death rewards (XP, drops, LevelUp cards, **element grants with per-element cap of 2**) | `src/engine/kills.ts` | `applyKill`, `applyPendingLevelUps`, `grantElementToDelver`; rulebook p17 + p23 |
| In-wave Weapon refresh — 2 AP path | `src/engine/turn.ts > spendApRefreshWeapon` | DESIGN.md §4.3.1 |
| In-wave Weapon refresh — 2 matching elements (auto-on-placement) | `src/engine/turn.ts > playWeaponCard` | Reads slot's printed `element` from `data/delverBoards.json`, uses `ELEMENT_CAP_PER_DELVER` from `engine/kills.ts`. Sets `cardPlacedThisTurn.autoRefreshedElement` so `undoWeaponPlacement` can roll back the spent tokens. DESIGN.md §4.3.2 |
| Auto-refresh banner UI | `src/screens/BoardScreen.ts > renderAutoRefreshBanner` | Driven by `uiState.lastAutoRefresh` (discriminated union: `reason: "element-stack" \| "ap-spend"`). Populated by `screens/SuitPanel.ts > handleSlotClick` (placement-stack auto-refresh) and `screens/ActionResolution.ts > onApRefreshSlot` (2 AP refresh). Wiped on next placement, End Turn, hero swap (auto- or manual), or banner dismiss — NOT wiped by `clearActionState` (see §4.3.2 bug history). Tests: `__tests__/uiState.test.ts` |
| Element well rendering above weapon slots | `src/screens/SuitPanel.ts > buildSlotElementTokens` | Uses `data.ELEMENT_IMAGE` lookup → `/tokens/{element}.webp`; pulses when both wells full |
| AVAILABLE / SPENT box resource badges (AP + consumables) | `src/screens/SuitPanel.ts > buildResourceBadgeRow` | Single unified row per box. AP rendered as one icon + integer count using `data.AP_BOLT_SVG_INNER` (yellow lit / grey spent), followed by visible consumable kinds in stable order (Supercharger DD → Battery family). Uniform 20px `.consumable-icon` container, flex-wraps so the full 6-kind inventory (3 DD + 2 Battery + AP) fits without overlapping the printed AVAILABLE / SPENT label. Replaces the pre-2026-05-09 split where AP rendered as N stacked bolt glyphs in its own `buildApDotRow`; see §5.5.2 for the visual rationale. |
| Counter-attack die thresholds (1 / 2-5 / 6) | `src/engine/combat.ts` | `counterAttackOutcomeForRoll`, rulebook p23 |
| Encounter bootstrap + spatial lookups | `src/engine/encounter.ts` | `ensureEncounter`, `getEnemyAt`, `getDelverAt`, `getEnemyInstance` |
| Per-turn refresh + active-delver swap | `src/engine/turn.ts` | `startHeroTurn` (refreshes movement + clears per-turn flags; AP is per-Wave now — see §4.1), `endHeroTurn`, `flipActiveDelver`; rulebook p19 + DESIGN.md §4.1 |
| Per-Wave AP refresh | `src/engine/wave.ts > enterEndOfWave` (End Wave refresh) | `currentAp = baseAp` for both delvers at End Wave (AP unification 2026-05-09 — was previously per-turn); DESIGN.md §4.2 + §5.5 |
| AP-bumping equipment outcomes (Battery's "+1 AP for the rest of the quest") | `src/engine/tokens.ts > applyEquipmentRoll` | `EquipmentRollOutcome.baseApDelta` adds to BOTH `loadout.baseAp` (persistence) and `loadout.currentAp` (usable this wave); DESIGN.md §5.4 Battery |
| AP-token v21→v22 schema migration | `src/state.ts > migrateV21ToV22` | Folds banked `"ap"` consumable counts into `baseAp` (`available + spent`) and `currentAp` (`available`) on first load of a pre-unification save; DESIGN.md §4.1 |
| Mandatory turn-start placement | `src/engine/turn.ts` | `playWeaponCard`; DESIGN.md §4 stage 1 + §5.2 |
| Prepare to Run (sticky latch) | `src/engine/turn.ts` | `prepareToRun`; DESIGN.md §5.7 |
| Action step (weapon-ability) | `src/engine/turn.ts` + `src/engine/combat.ts` | `useWeaponAbility` builds an `AttackSession`; UI drives the session lifecycle (§5.4.2). DESIGN.md §5.2 + §5.4 |
| Shared counter-attack roll | `src/engine/combat.ts` | `resolveAllDamage` precomputes `anyCanLand`; `resolveSharedCounter` applies one shared d6 to every damaged enemy. DESIGN.md §5.4 |
| Action step (slot-ability) | `src/engine/turn.ts` + `src/engine/slotAbilities.ts` | `useSlotAbility` wrapper → `resolveSlotAbility`; DESIGN.md §5.2 + §5.8 |
| Wave phase transitions (Delver/Hero → Parting Shots → End Wave) | `src/engine/wave.ts` | Owned by `EncounterState.phase`; DESIGN.md §5.9 + §5.10 + §6.1.1 |
| End-of-Quest reset (campaign vs quest split) | `src/engine/wave.ts > endQuestReset` | Clears equipment ranks / XP / level / level-up-owed / consumable + element bags / loadout state; preserves parts / memory chips / completion flags / town visit shop. Called by End-of-Wave (victory) before routing to the Town Visit; DESIGN.md §5.10.1 |
| Town Visit anchor (chapter / page / pages-entered) | `src/state.ts > TownVisitState` + `src/screens/TownVisit.ts` (stub) | Set by End-of-Wave (victory) handler; rendered by parallel-agent Town Visit work. Title screen surfaces a "Continue Town Visit" button when `state.townVisit !== null`; DESIGN.md §5.10.1 |
| Parting Shot patterns (`all-delvers` / `nearest-delver` / `delvers-within`) | `data/enemies.json` (`partingShot`) + `src/engine/wave.ts` (`applyPartingShot`) | Tagged union per §5.9.2; rulebook p26 |
| Delver death short-circuit | `src/engine/wave.ts` | `onDelverDamaged` invoked from `combat.finalizeAttackSession` and `wave.resolvePartingShot`; rulebook p26 |
| End Wave refresh (weapons, AP, consumables, Harvester) + "if continuing" effects (OS / Shield elements, Armor heals, opinion penalties) | `src/engine/wave.ts` | `enterEndOfWave` stores `enc.endWaveRefresh` (also the latch); `applyContinuingEndWaveEffects` via `bootstrapNextWave` (§4.2) |
| Block Counterattack | `src/engine/combat.ts > blockCounterattack` | Cancels one enemy's whole counterattack, side effects included; no per-turn cap (§5.5.2) |
| End-of-Wave page routing | `src/engine/wave.ts` + `data/quest1.json` (`wave1.endOfWave`) | `enterEndOfWave(state, "victory" | "defeat")` selects between `bothSurvive` / `anyDie`; DESIGN.md §5.10 |
| Wave-phase UI (Parting Shots / End of Wave + End Wave card) | `src/screens/WavePhases.ts` | Dispatched by `BoardScreen` when `phase !== "hero"` |
| Story intro narrative + "begin quest" flow | `src/screens/Story.ts` + `data/quest1.json` (`intro` + `pages.wave1_intro`) | Routed from Title's "Begin Quest #1" on a fresh campaign |
| Campaign Sheet (XP, level, parts, level-ups owed, loadout summary) | `src/screens/CampaignSheet.ts` | Reachable from Title and from End-of-Wave (victory) |
| Damage formula | `src/engine/combat.ts` + `src/config/tuning.ts` | `damage = damageMultiplier * Tuning.damageBase[damageType]`; DESIGN.md §5.4.1. Use `effectiveDamageForCard(state, heroId, card)` for the rank-scaled value — it reads the PRINTED multiplier off the rank-correct card, NOT the rank itself (fixed 2026-07-20: Hammer + Trident print an offset ramp where R2 = 1x and R3 = 2x, unlike Gauntlet et al. where R3 = 3x). |
| Equipment ranks (per delver, per type) | `state.CampaignState.equipmentRanks` | R0 = not owned, R1..R5 = owned at that rank. Initialized from starter equipment; bumped by `engine/levelUp.ts > applyLevelUpChoice`. Read by HandPanel, SuitPanel, and combat damage scaling. |
| Base equipment catalog (all 140 printed cards) | `data/equipment.json` | Full R1..R5 entries for the 14 types × 2 suits printed in Suit A + Suit B PDFs. Since 2026-07-22 the engine resolves the RANK-CORRECT entry via `getEquipmentByTypeSuitRank(suit, type, rank)` wherever effects matter — per-tier IMMEDIATELYs on rank gains (level-up, shop grants), retry/reset re-application, end-of-wave heals, counter-blocks — so the R2-R5 entries are live gameplay data that mirror the printed text + numerically scale relevant `effects` (Shield `baseBlock` = rank, Boots `set-base-movement.value` = rank+1, Armor `set-max-hp.value` = 6+3·rank, Trident `weapon-counter-block.amount` = rank, Shockwave block = rank, OS xp/element grants = rank, Harvester pickups = 2·rank, Chain Gauntlet adds creature-part at R2+, Surge Claw bumps creature-part 1→2 at R2+, Flicker Blade combo bonus = rank, Hammer drops `may-reroll-by-suffering` at R2+ for the printed "Choose 1"). Damage is computed engine-side as `rankedCard.damageMultiplier · Tuning.damageBase[damageType]` in `effectiveDamageForCard` — the printed multiplier on the rank-correct entry IS the source of truth (fixed 2026-07-20; Hammer/Trident print an offset ramp where R2 = 1x). Beam `Repeat N times` is preserved in `abilityText` but has no structured effect kind today. Source PDFs: `ASSETS/Gone to Gaia/Equipment Card Front Suit A v5 PROOF 2.pdf` (Body, cards 001-070), `Suit B v5 PROOF 2.pdf` (Mind, cards 071-140). |
| Level-Up draw flow (rulebook p24) | `src/engine/levelUp.ts` + `src/screens/LevelUpModal.ts` + `data/levelDeck.json` | 28 base level cards. `enqueueLevelUpDraws` (called from `applyPendingLevelUps`) pushes 1 entry per delver onto `encounter.pendingLevelUpDraws`; modal opens via `ActionResolution.advanceAfterAction` once the action's session has finalized; `applyLevelUpChoice` validates the pick, bumps the rank table, discards the card. End Turn gated on empty queue. DESIGN.md §3.4 |
| Rank-derived card image | `src/data.ts > imageForRank(suit, type, rank)` | Filename convention: `card_{suit}_{type-lower}_r{rank}.jpg`; matches the output of `tools/pdf-extract/batch_equipment.mjs`. Consumed by HandPanel + SuitPanel slot art. |
| Hit-tile computation per range kind | `src/engine/combat.ts` | `computeWeaponHitTiles`; DESIGN.md §5.4.3 |
| Slot-ability data per element | `data/delverBoards.json` | `WeaponSlotOverlay.slotAbility`; DESIGN.md §5.8.1 |
| Per-delver element bag | `state.CampaignState.elements` | `Record<heroId, Partial<Record<Element, number>>>`; capped at 2 per element per delver (rulebook p17 — overflow LOST). Each element value is 1:1 with the matching weapon slot's element well. Populated by `engine/slotAbilities.ts > resolveGainElement` (slot ability) AND `engine/kills.ts > applyKill` (on-death `gainElements`); both go through `grantElementToDelver` |
| Live encounter state | `state.CampaignState.encounter` | `EncounterState`; bootstrapped from `quest1.spawn` |
| Tile centres on board | `data/tideTiles.json` | Generated from `tools/pdf-extract/detect_tiles_from_annotation.mjs`; consumed via `src/board/tideBoard.ts` |
| Per-delver state | `state.CampaignState.loadouts` | HP/AP/Movement/slot cards |
| Shared XP / Level | `state.CampaignState.{xpOnHand, currentLevel}` | **single value, not per-delver** |
| XP cost table | `src/xp.ts` | `xpCostForNextLevel(level)`; tested in `src/__tests__/xp.test.ts` |
| Ephemeral UI state | `src/uiState.ts` | `peekedDelverId`, `selectedCardByHero` |
| Right-column view + auto-peek to deciding delver | `src/uiState.ts > modalDecider`, `syncAutoPeekToModal`; `src/screens/BoardScreen.ts > renderBoardScreen` | DESIGN.md §6.2 |
| Quest #1 spawn | `data/quest1.json` | Per storybook ch1 p4 |
| Hero starting loadout | `data/heroes.json` + `Tuning` | `startingHp`, `startingMovement`, `baseAp` |
| Suit board overlay coords | `data/delverBoards.json` | HP track, movement, damage, AP, slots |
| Enemy data | `data/enemies.json` | HP, attack, counter patterns, on-death drops |
| Tuning constants | `src/config/tuning.ts` | Centralised mutable numbers |
| Session log (playthrough trace for bug repro) | `src/debug/sessionLog.ts` + `src/debug/SessionLogPanel.ts` | Ring buffer (cap 500) of `{ts, kind, data}`; persisted to `localStorage["g2g.sessionLog.v1"]`; live-rendered into a floating panel toggled via `~` or the topbar "Log" button. Call sites: `screens/BoardScreen.ts` (turn start, End Turn, Peek, movement), `screens/SuitPanel.ts` (slot click + `engine.playWeaponCard` trace + AVAILABLE box), `screens/ActionResolution.ts` (modal open/close + every AP-spend / refresh / weapon-ability dispatch + `state.after-advance`), `screens/HandPanel.ts` (card select/deselect), `screens/turnFlow.ts` (auto-end-turn). See §7.3 for rationale + format. Tests: `src/__tests__/sessionLog.test.ts` |

---

## 7.3 Session-log debug infrastructure

### Why it exists

Intermittent UX bugs ("sometimes the AP-refresh doesn't take, but
not always") are nearly impossible to diagnose from a verbal repro.
The session log captures every player click + every engine call
that resulted from it (with before/after state snapshots) into a
ring buffer that the player can copy-paste back to the agent.

The trace turns "I clicked refresh and 2 AP wasn't spent" into a
specific timeline:

```
[ 12345.6ms] click.ap-spend.refresh   heroId=hero-01 ap={"currentAp":3,"baseAp":3}
[ 12345.7ms] modal.open               kind=ap-refresh-pick-slot
[ 12891.2ms] click.ap-refresh-pick-slot  slotIdx=1  ap={"currentAp":3,"baseAp":3}
[ 12891.3ms] engine.spendApRefreshWeapon  result=ok  apBefore=...  apAfter=...
```

…which is enough to disambiguate "engine ran and rejected" vs
"engine ran and succeeded but UI lied" vs "click never reached the
handler".

### Files

| File | Role |
|------|------|
| `src/debug/sessionLog.ts` | Ring buffer (cap 500), localStorage persistence, snapshot helpers (`snapHeroAp`, `snapTurn`, `snapSlots`, `snapModal`, `snapElements`), JSONL + plain-text formatters |
| `src/debug/SessionLogPanel.ts` | Floating panel UI; mounted into BoardScreen via `mountSessionLogPanel`; subscribes to `onChange` for live re-render |
| `src/screens/BoardScreen.ts` | Owns the topbar "Log" button + the singleton `keydown` listener that toggles the panel via `~` |
| `src/engine/kills.ts` | Engine-side log row: `engine.grantElement` inside `grantElementToDelver` (the single grant point — covers on-kill grants AND slot-ability `gain-element`). Logs both successful grants and cap-overflow discards |
| `src/engine/turn.ts` | Engine-side log rows: `engine.spendElement` for the auto-refresh element-stack consume in `playWeaponCard`, `engine.spendElement` for the Mace `target-bypass` debit, `engine.grantElement` (`reason: undo-auto-refresh`) for the placement-undo restore |
| `src/engine/combat.ts` | Engine-side log row: `engine.spendElement` for shield element spend in `applySharedCounter` |

### Persistence + session id

- Buffer persists to `localStorage["g2g.sessionLog.v1"]` after every
  `logEvent`, so a hard refresh / accidental tab close doesn't lose
  the trace right when the bug fires.
- Session id is `YYYYMMDD-HHMMSS-rand4` — short enough to reference
  in a bug report, sortable by recency, and stable across reloads.
- `clearLog` bumps the session id so a cleared trace can't be
  confused with the prior one if both end up in the same paste.

### Singleton keydown listener

Pre-singleton, BoardScreen attached a fresh `keydown` listener every
render and never removed any of them. For Escape-close that was a
benign no-op on the second-and-after invocations (modal already
hidden), but for the `~` TOGGLE it would flip state N times per
keypress (where N = render count), netting out to "no effect" or
"chaotic effect" depending on parity. Fix: install the listener
once, store the latest router/modalLayer in a module-scoped ref,
and have the listener close over the ref (always acts on the
latest BoardScreen state).

### Element-bag tracing (added 2026-05-09)

Bug class motivating this: *"I had 2 earth elements above the trident
slot, placed the trident, but it didn't auto-refresh."* Without
element-bag visibility in the trace, the engine's `engine.playWeaponCard
autoRefresh=null` row is impossible to disambiguate from "user
mistakenly thought they had 2 earth" vs. "engine had a state-tracking
bug that lost an element somewhere upstream."

Added rows + snapshot:

- `snapElements(state, heroId)` — sparse element-bag snapshot helper
  (only non-zero entries; `null` if the hero isn't in `state.elements`).
- `engine.playWeaponCard` now carries `elementsBefore` + `elementsAfter`
  on every call so the auto-refresh decision is fully self-contained.
- `engine.useWeaponAbility` now carries `elementsBefore` +
  `elementsAfter` so element-spending weapon flows (Mace) are visible.
- `engine.grantElement` — fires inside `grantElementToDelver` for both
  successful grants AND cap-overflow discards, with `granted: true|false`
  and `newTotal`. Single source of truth — covers on-kill grants
  (`applyKill`), slot-ability `gain-element` (`resolveGainElement`),
  Operating System rebroadcast (`engine/os.ts`), AND placement-undo
  restores (`reason: undo-auto-refresh`).
- `engine.spendElement` — fires at every element-debit site:
  `weapon-auto-refresh` (turn.ts placement consume), `mace-target-bypass`
  (turn.ts mace debit), `shield-block` (combat.ts shield resolution).
- `state.after-advance` and `turn.start-{fresh-encounter,next}` now
  carry an `elements` snapshot too, so any cross-event state drift in
  the bag is auditable.

### Coverage in `src/__tests__/sessionLog.test.ts`

Pinned contracts (silent regressions in any of these would defeat
the point of the log):

- Events arrive in chronological order with monotonic timestamps.
- Buffer evicts OLDEST events when it overflows (recent activity is
  never the thing that gets dropped).
- `getEntries` returns a defensive copy.
- `onChange` fires once per event and per `clearLog`, supports
  multiple subscribers, returns a working unsubscribe.
- `formatJsonl` emits `session.header` first, one JSON object per
  line, no trailing blank line.
- `formatPlain` renders nested objects as compact JSON so a single
  `[ts] kind k=v k=v` row is always one terminal line.
- `snapElements` strips zero entries, returns `{}` for an empty bag,
  returns `null` for a missing-hero key.

---

## 8. Process notes for future changes

1. **Read this doc before writing code.** If the change touches a
   gameplay rule, find the rule in §3–§5; if it's missing, add it
   citing the rulebook page first.
2. **Conversational corrections amend the doc.** When the user
   clarifies or corrects a rule (e.g. *"XP is shared"*), update the
   relevant §2/§3/etc. entry in the same change set as the code fix.
3. **Resource scope is the most error-prone area.** Every new state
   field must be tagged per-delver vs shared in §2 the moment it's
   added.
4. **Schema bumps** (`SCHEMA_VERSION` in `src/state.ts`) on any change
   to `CampaignState` shape; localStorage will reset cleanly.
5. **Out of scope reminder.** Don't sneak chapter 2+ / shop / scar /
   witness / memory-chip features in unless §1 has been expanded to
   cover them.

## Storybook continue choices (Scenario Cards in the storybook) — trial, 2026-11-17

Full rules, process and lessons for rolling this out to the other quests:
[SCENARIO_STORYBOOK_SPEC.md](SCENARIO_STORYBOOK_SPEC.md).

Quest #2 no longer draws Scenario Cards at wave start (`scenarioCardOnStart`
removed). Instead, the End-of-Wave victory page offers the card's options as
"continue to the next wave" choices with their results printed on the button
(`wave.continueChoices` in `data/quest2.json`; each result is a
`QuestEowChoice` with `pageId` prose + `carryEffects` applied once the next
wave is set up). They replace the old fixed bonus (e.g. "gain 3 elements").

- 2 default choices + bonus on text-heavy waves, 3 + bonus on lighter ones.
- Bonus option: `requireKeyItem: N` — always shown, selectable only while the
  party owns Key Item #N (pays off optional Key Items). Also supported on Ch3+
  `eow.victory` choices.
- Results are visible, so no option has a downside; options also absorb the old
  fixed bonus they replace (Q2 W1 used to grant 3 elements each).
- Quest #2: Wave 1 → Scenario #01 Sparkle, buffed: A Leave it alone (heal 3 +
  2 elements), B Follow it (Level card + 1 element), C (Woo's Diary, Key Item
  #3) heal to full + 4 elements (each delver). Wave 2 → Return to Town + Scenario #02 Cold
  B (heal 4) / C (Level card) per the owner's doc edit; no Key-Item bonus.
- No quest draws Scenario Cards any more (Ch3+ `scenarioCardDraw` removed) and
  nothing seeds the deck. Ch3–4 quests each gained a Key-Item bonus continue
  option; Key Item #12 Dahlia is Free opens Quest #4 (replacing Scenario D).
