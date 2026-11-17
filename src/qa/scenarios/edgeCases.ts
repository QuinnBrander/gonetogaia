/**
 * Edge-case scenarios — surgical tests of state transitions that
 * have historically been bug magnets:
 *
 *   - Zero / over-donate: amount = 0, amount > wallet,
 *     amount === wallet exactly, donate outside a town visit.
 *   - Double-redeem opinion cards: spend Samantha twice in one
 *     visit, spend Rodrigo/Elayna before owning them, spend Vera
 *     after favour has already dropped.
 *   - Migration round-trip: load a fresh campaign, mutate +
 *     re-load via `JSON.parse(JSON.stringify(state))`, assert
 *     all invariants still hold.
 *
 * Each scenario is short (~10-30 actions) and intentionally
 * deterministic — no RNG. If one of these scenarios EVER fires
 * a bug report, treat it as a P0: these are the contracts the
 * whole engine assumes.
 */

import type { QaSession } from "../session";
import type { Scenario } from "./types";

/** Donate edge cases on a fresh Ch1 visit. */
export const edgeCaseDonationScenario: Scenario = {
  name: "edge-donation",
  description: "Zero, over, exact, and outside-visit donations.",
  run(session) {
    // 1) Donate outside a visit — must reject `no-town-visit`.
    session.checkpoint("donate before any visit");
    session.expectThrow("donate must require an active town visit");
    session.donate("hero-01", 1);

    // 2) Start a visit, hand-grant some parts via the engine,
    //    then try the edge cases.
    session.startTownVisit("ch1");
    session.applyOnEnter();
    // Grant a known wallet so we can hit "exact" cleanly.
    session.applyAction({ kind: "grant-minion-parts", amount: 5, to: "all-delvers" });

    session.checkpoint("donate amount=0 — should reject invalid-amount");
    session.expectThrow("amount=0 is invalid");
    session.donate("hero-01", 0);

    session.checkpoint("donate amount=-1 — should reject invalid-amount");
    session.expectThrow("amount=-1 is invalid");
    session.donate("hero-01", -1);

    session.checkpoint("donate amount > wallet — should reject insufficient-minion-parts");
    session.expectThrow("amount > wallet is insufficient");
    session.donate("hero-01", 99);

    session.checkpoint("donate to unknown hero — should reject hero-not-found");
    session.expectThrow("unknown hero is rejected");
    session.donate("hero-bogus", 1);

    session.checkpoint("donate exactly wallet — should succeed and zero the wallet");
    session.donate("hero-01", 5);
    // Wallet must now be 0; donation accumulator must be 5.
    // The wallet-non-negative invariant catches under-zero on
    // the next action automatically.

    session.checkpoint("donate after wallet=0 — should reject insufficient-minion-parts");
    session.expectThrow("post-zero wallet is insufficient");
    session.donate("hero-01", 1);

    if (session.state.townVisit) session.finishTownVisit();
  },
};

/** Opinion-card double-redeem + sequencing tests. */
export const edgeCaseOpinionScenario: Scenario = {
  name: "edge-opinion",
  description: "Double-redeem, redeem-without-token, redeem-without-ownership.",
  run(session) {
    // No visit, no cards owned -> all redeems must reject
    // cleanly (no-town-visit fires first).
    session.checkpoint("redeem with no visit");
    session.expectThrow("no visit -> vera rejects");
    session.redeemVera("hero-01");
    session.expectThrow("no visit -> flores rejects");
    session.redeemFlores();
    session.expectThrow("no rodrigo card -> rodrigo rejects");
    session.redeemRodrigo();
    session.expectThrow("no elayna card -> elayna rejects");
    session.redeemElayna();

    // Open a visit, hand-grant Vera-Ally + Flores-Ally,
    // then exercise double-redeem.
    session.startTownVisit("ch1");
    session.applyOnEnter();
    // Push the cards directly — the chapter-driven path adds
    // them by stepping into Samantha's pub branch, but the
    // edge case is "second redeem in same visit", which the
    // walking path doesn't normally test.
    session.state.opinionCards.push({ characterId: "vera", characterName: "Vera Brass", level: "ally" });
    session.state.opinionCards.push({ characterId: "flores",   characterName: "Father Flores", level: "ally" });

    session.checkpoint("first vera redeem — should succeed");
    session.redeemVera("hero-01");
    session.checkpoint("second vera redeem — should reject already-spent");
    session.expectThrow("vera is already spent");
    session.redeemVera("hero-02");

    session.checkpoint("first flores redeem — should succeed");
    session.redeemFlores();
    session.checkpoint("second flores redeem — should reject already-spent");
    session.expectThrow("flores is already spent this visit");
    session.redeemFlores();

    // Elayna heals to full — we don't own her card, so it should
    // reject `card-not-owned` first.
    session.checkpoint("elayna redeem before owning her card");
    session.expectThrow("elayna not owned");
    session.redeemElayna();

    if (session.state.townVisit) session.finishTownVisit();
  },
};

/** Wave-lifecycle edge cases — calling phase-transition
 *  functions out of order, on a missing encounter, or twice.
 *  Every one of these must be a clean no-op (no invariant
 *  violation, no engine throw). The engine's "skip when wrong
 *  phase" pattern is the contract; this scenario asserts it
 *  end-to-end. */
export const edgeCaseWaveLifecycleScenario: Scenario = {
  name: "edge-wave-lifecycle",
  description: "Phase-transition calls out of order, duplicate calls, missing-encounter calls.",
  run(session) {
    // 1) Every wave call on a fresh campaign (no encounter)
    //    must be a clean no-op.
    session.checkpoint("wave calls with no encounter");
    session.completeWave();
    session.endQuestReset();
    session.resolveAllPartingShots();
    session.winWaveViaDebug();
    session.startWaveAfterPick();

    // 2) Bootstrap Q2 W1 and call functions in WRONG order.
    session.checkpoint("Q2 W1 bootstrap with out-of-order phase calls");
    session.state.quest1Completed = true;
    session.state.currentQuestId = "quest2";
    session.bootstrapWave("quest2", 1);
    session.drainOpinionPicks();

    // Try transition functions before they're valid:
    session.completeWave();        // phase is delver-spawn-pick — no-op (only valid in end-of-wave)
    session.winWaveViaDebug();     // phase isn't hero yet — no-op

    // Now the real flow.
    session.autoPlaceSpawns();
    session.startWaveAfterPick();

    // Call startWaveAfterPick a SECOND time — engine should
    // no-op since phase isn't delver-spawn-pick anymore.
    session.startWaveAfterPick();

    session.winWaveViaDebug();

    // Call winWaveViaDebug AGAIN after phase moved to
    // parting-shots — engine should return null + no-op.
    session.winWaveViaDebug();

    // 3) Drain + complete — the normal order, with extra
    //    duplicate calls after each.
    session.resolveAllPartingShots();
    session.resolveAllPartingShots(); // phase moved to end-of-wave — no-op
    session.completeWave();
    session.completeWave();        // encounter cleared — no-op
    session.endQuestReset();
    session.endQuestReset();       // idempotent
  },
};

/** Serialise / deserialise the campaign + re-run invariants. */
export const edgeCaseRoundtripScenario: Scenario = {
  name: "edge-roundtrip",
  description: "Serialise + parse + assert invariants still hold on the rehydrated state.",
  run(session) {
    session.startTownVisit("ch1");
    session.applyOnEnter();
    session.applyAction({ kind: "grant-minion-parts", amount: 4, to: "all-delvers" });
    session.applyAction({ kind: "grant-story-tokens", amount: 2 });

    // Round-trip the state through JSON and replace the live
    // pointer. The next invariant pass MUST still find a clean
    // state — if any field becomes undefined / wrong-typed,
    // the wallet / queue / town-visit checks fire.
    const json = JSON.stringify(session.state);
    const parsed = JSON.parse(json);
    // Recording first so the trace shows the snapshot point.
    session.checkpoint("roundtrip — replacing state with JSON-parsed copy");
    // Mutate the session's state pointer in place.
    Object.assign(session.state, parsed);
    // Run a no-op action so invariants fire against the new state.
    session.applyAction({ kind: "record-decision", key: "qa.roundtrip" });

    if (session.state.townVisit) session.finishTownVisit();
  },
};
