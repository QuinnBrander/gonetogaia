/**
 * UI-state contract tests — the bits of `src/uiState.ts` whose
 * shape (and lifecycle) directly back observable in-game UX. This
 * file is intentionally tiny: most of uiState is glue, but a few
 * latches/toasts have caused user-facing regressions when their
 * lifetime gets quietly tightened or loosened, and those need
 * regression coverage at the unit level.
 *
 * Pinned regressions:
 *   - 2026-05-09 "AP-refresh banner never shows": prior to the
 *     fix, `clearActionState` wiped `lastAutoRefresh`, which got
 *     called by `advanceAfterAction` immediately AFTER the
 *     AP-refresh handler set the toast. The banner therefore
 *     vanished within the same event loop tick. The new contract:
 *     `clearActionState` drops only ARMED ephemera (modal,
 *     attack session, armed ability, movement-armed, auto-peek
 *     latch); it does NOT touch the REFRESHED banner. End Turn /
 *     hero swap callers wipe the banner explicitly via
 *     `clearLastAutoRefresh`.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  clearActionState,
  clearLastAutoRefresh,
  getArmedAbility,
  getAttackSession,
  getLastAutoRefresh,
  getModal,
  getPeekedDelverId,
  setArmedAbility,
  setAttackSession,
  setLastAutoRefresh,
  setModal,
  setPeekedDelverId,
  syncAutoPeekToModal,
} from "../uiState";

describe("clearActionState", () => {
  beforeEach(() => {
    // Reset everything so each test starts from a known-clean
    // baseline regardless of prior test order.
    clearActionState();
    clearLastAutoRefresh();
  });

  it("drops armed ability, attack session, and modal", () => {
    setArmedAbility({
      kind: "weapon",
      slotIdx: 0,
      cardId: "mind-hammer-r1",
      rangeKind: "die-roll-fixed",
    });
    setAttackSession({
      attackerId: "hero-01",
      source: { kind: "weapon", slotIdx: 0, cardId: "mind-hammer-r1" },
      damage: 1,
      damageType: null,
      hitTiles: [],
      steps: [],
      sharedCounter: null,
      finalized: false,
      preEffects: [],
      postEffects: [],
      levelUpsApplied: 0,
    });
    setModal({ kind: "ap-spend" });

    clearActionState();

    expect(getArmedAbility()).toBeNull();
    expect(getAttackSession()).toBeNull();
    expect(getModal()).toBeNull();
  });

  // Pinned: the AP-refresh REFRESHED banner must survive
  // `advanceAfterAction` (which calls `clearActionState` between
  // every action). The fix de-bundles toast lifetime from ARMED
  // ephemera lifetime; this test guards against future re-bundling.
  it("does NOT wipe lastAutoRefresh — banner is per-action, not per-armed-ephemera", () => {
    setLastAutoRefresh({
      reason: "ap-spend",
      heroId: "hero-01",
      cardId: "mind-hammer-r1",
      cardName: "Crash Hammer",
      apSpent: 2,
    });

    clearActionState();

    const t = getLastAutoRefresh();
    expect(t).not.toBeNull();
    if (!t) return;
    expect(t.reason).toBe("ap-spend");
    expect(t.cardId).toBe("mind-hammer-r1");
  });

  it("explicit clearLastAutoRefresh DOES wipe the banner (used by End Turn)", () => {
    setLastAutoRefresh({
      reason: "element-stack",
      heroId: "hero-01",
      cardId: "mind-hammer-r1",
      cardName: "Crash Hammer",
      element: "earth",
    });

    clearLastAutoRefresh();

    expect(getLastAutoRefresh()).toBeNull();
  });

  // Pinned regression (2026-05-25): at quest start, the active delver
  // is hero-02 but hero-01 holds Supercharger. The equipment-roll
  // modal opens for hero-01 and `syncAutoPeekToModal` sets
  // `peekedDelverId=hero-01`. After resolving, `advanceAfterAction`
  // falls into its default branch and calls `clearActionState`. Prior
  // to the fix, `clearActionState` dropped the auto-peek latch but
  // did NOT clear the peek itself, so the next render's
  // `syncAutoPeekToModal(null, enc)` saw `autoPeekActive=false` and
  // no-op'd — leaving the right-column view stuck on hero-01 even
  // though hero-02 was the active delver.
  it("clears an auto-set peek when the latch was active (e.g. modal closing via advanceAfterAction)", () => {
    // Simulate the modal lifecycle: a per-delver modal opens for
    // hero-01 (a non-active delver), syncAutoPeekToModal sets the
    // peek and the latch.
    setModal({
      kind: "equipment-roll",
      heroId: "hero-01",
      cardId: "mind-supercharger-r1",
    });
    syncAutoPeekToModal(getModal(), null);
    expect(getPeekedDelverId()).toBe("hero-01");

    clearActionState();

    expect(getModal()).toBeNull();
    expect(getPeekedDelverId()).toBeNull();
  });

  it("does NOT touch a manual peek (one set without an auto-peek session)", () => {
    setPeekedDelverId("hero-02");
    expect(getPeekedDelverId()).toBe("hero-02");

    clearActionState();

    expect(getPeekedDelverId()).toBe("hero-02");
  });
});

describe("AutoRefreshToast — discriminated union shape", () => {
  beforeEach(() => {
    clearLastAutoRefresh();
  });

  it("accepts the element-stack variant (placement triggered auto-refresh)", () => {
    setLastAutoRefresh({
      reason: "element-stack",
      heroId: "hero-01",
      cardId: "mind-hammer-r1",
      cardName: "Crash Hammer",
      element: "earth",
    });
    const t = getLastAutoRefresh();
    expect(t?.reason).toBe("element-stack");
    if (t?.reason === "element-stack") {
      expect(t.element).toBe("earth");
    }
  });

  it("accepts the ap-spend variant (player paid 2 AP via AVAILABLE menu)", () => {
    setLastAutoRefresh({
      reason: "ap-spend",
      heroId: "hero-02",
      cardId: "body-sword-r1",
      cardName: "Soulshift Sword",
      apSpent: 2,
    });
    const t = getLastAutoRefresh();
    expect(t?.reason).toBe("ap-spend");
    if (t?.reason === "ap-spend") {
      expect(t.apSpent).toBe(2);
    }
  });
});
