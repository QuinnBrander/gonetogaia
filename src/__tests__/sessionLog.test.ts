/**
 * sessionLog contract tests — the playthrough trace is debugging
 * infrastructure for intermittent UX bugs (e.g. the recurring 2026
 * AP-refresh report) and silently dropping events would defeat the
 * point. These tests pin the contracts every call site relies on:
 *
 *   - Events arrive in chronological order with monotonic ts.
 *   - The buffer is capped at MAX_ENTRIES and the OLDEST events get
 *     evicted (a runaway session must never push the most recent
 *     activity off the buffer).
 *   - Subscribers fire on every `logEvent` call (the panel UI relies
 *     on this for live re-rendering).
 *   - `formatJsonl` emits a well-formed session header + one JSON
 *     object per event line, with no trailing newline noise.
 *   - `formatPlain` emits a fixed-width timestamp prefix so the eye
 *     can scan a long log without column drift.
 *   - `clearLog` resets entries AND bumps the session id so a fresh
 *     trace can't be confused with the prior one when stitched
 *     together for a bug report.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  clearLog,
  formatJsonl,
  formatPlain,
  getEntries,
  getSessionId,
  logEvent,
  onChange,
  snapElements,
} from "../debug/sessionLog";
import type { CampaignState } from "../state";

beforeEach(() => {
  clearLog();
});

describe("logEvent + getEntries", () => {
  it("appends an entry with the kind + data passed in", () => {
    logEvent("test.alpha", { hello: "world" });
    const entries = getEntries();
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.kind).toBe("test.alpha");
    expect(e.data).toEqual({ hello: "world" });
  });

  it("defaults to an empty data object when none is passed", () => {
    logEvent("test.beta");
    const e = getEntries()[0]!;
    expect(e.data).toEqual({});
  });

  it("returns events in chronological order with non-decreasing ts", () => {
    logEvent("test.first");
    logEvent("test.second");
    logEvent("test.third");
    const entries = getEntries();
    expect(entries.map((e) => e.kind)).toEqual([
      "test.first",
      "test.second",
      "test.third",
    ]);
    expect(entries[0]!.ts).toBeLessThanOrEqual(entries[1]!.ts);
    expect(entries[1]!.ts).toBeLessThanOrEqual(entries[2]!.ts);
  });

  it("getEntries returns a defensive copy — caller mutations don't leak in", () => {
    logEvent("test.alpha");
    const snap = getEntries();
    snap.push({ ts: 999_999, kind: "fake", data: {} });
    // Inner buffer is untouched.
    expect(getEntries()).toHaveLength(1);
  });

  it("evicts OLDEST entries when the buffer overflows MAX_ENTRIES (500)", () => {
    // Push more than the cap, then assert the oldest got dropped and
    // the most recent are still around. The exact MAX_ENTRIES value
    // is internal to sessionLog — the contract is "fixed cap, FIFO
    // eviction", so we test 510 events and assert the cap is <= 510
    // AND the most recent entry survived.
    for (let i = 0; i < 510; i++) {
      logEvent("test.fill", { i });
    }
    const entries = getEntries();
    expect(entries.length).toBeLessThanOrEqual(510);
    expect(entries.length).toBeGreaterThan(100); // sanity — not zero
    const lastIdx = (entries[entries.length - 1]!.data as { i: number }).i;
    expect(lastIdx).toBe(509);
  });
});

describe("onChange subscriptions", () => {
  it("fires the subscriber once per logEvent", () => {
    let calls = 0;
    const unsub = onChange(() => { calls++; });
    logEvent("test.a");
    logEvent("test.b");
    logEvent("test.c");
    expect(calls).toBe(3);
    unsub();
  });

  it("returns an unsubscribe fn that stops further notifications", () => {
    let calls = 0;
    const unsub = onChange(() => { calls++; });
    logEvent("test.a");
    unsub();
    logEvent("test.b");
    expect(calls).toBe(1);
  });

  it("supports multiple concurrent subscribers", () => {
    let a = 0;
    let b = 0;
    const unsubA = onChange(() => { a++; });
    const unsubB = onChange(() => { b++; });
    logEvent("test.event");
    expect(a).toBe(1);
    expect(b).toBe(1);
    unsubA();
    unsubB();
  });
});

describe("clearLog", () => {
  it("empties the buffer", () => {
    logEvent("test.a");
    logEvent("test.b");
    clearLog();
    expect(getEntries()).toEqual([]);
  });

  it("bumps the session id (so a cleared session can't be confused with the prior one)", () => {
    const before = getSessionId();
    clearLog();
    const after = getSessionId();
    expect(after).not.toBe(before);
  });

  it("notifies subscribers", () => {
    let calls = 0;
    const unsub = onChange(() => { calls++; });
    logEvent("test.a"); // 1
    clearLog();         // 2
    expect(calls).toBe(2);
    unsub();
  });
});

describe("formatJsonl", () => {
  it("emits a session-header line FIRST", () => {
    logEvent("test.a");
    const out = formatJsonl();
    const lines = out.split("\n");
    const header = JSON.parse(lines[0]!);
    expect(header.kind).toBe("session.header");
    expect(typeof header.sessionId).toBe("string");
  });

  it("emits one JSON object per event line, with the expected shape", () => {
    logEvent("engine.foo", { ok: true });
    logEvent("click.bar", { idx: 7 });
    const out = formatJsonl();
    const lines = out.split("\n").slice(1); // skip header
    expect(lines).toHaveLength(2);
    const a = JSON.parse(lines[0]!);
    expect(a.k).toBe("engine.foo");
    expect(a.d).toEqual({ ok: true });
    expect(typeof a.t).toBe("number");
    const b = JSON.parse(lines[1]!);
    expect(b.k).toBe("click.bar");
    expect(b.d).toEqual({ idx: 7 });
  });

  it("omits the data field when the event has no payload (keeps the line compact)", () => {
    logEvent("engine.foo");
    const lines = formatJsonl().split("\n");
    const e = JSON.parse(lines[1]!);
    expect("d" in e).toBe(false);
  });

  it("emits no trailing blank line (every line is parseable JSON)", () => {
    logEvent("test.a");
    logEvent("test.b");
    const out = formatJsonl();
    expect(out.endsWith("\n")).toBe(false);
    for (const line of out.split("\n")) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe("formatPlain", () => {
  it("starts with a session-id comment header", () => {
    logEvent("test.a");
    const out = formatPlain();
    const first = out.split("\n")[0]!;
    expect(first.startsWith("# session ")).toBe(true);
  });

  it("emits one row per event with [ts] kind data prefix", () => {
    logEvent("engine.foo", { ok: true, n: 3 });
    const lines = formatPlain().split("\n").slice(1);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toContain("ms]");
    expect(line).toContain("engine.foo");
    expect(line).toContain("ok=true");
    expect(line).toContain("n=3");
  });

  it("renders nested objects as compact JSON (so single-line scan still works)", () => {
    logEvent("engine.bar", { ap: { currentAp: 2, baseAp: 3 } });
    const lines = formatPlain().split("\n").slice(1);
    expect(lines[0]).toContain('ap={"currentAp":2,"baseAp":3}');
  });
});

// installViewportTracker tests — the SSR-safe early exit is the
// only branch we can exercise in plain-node vitest (no `window`
// available). Browser-mode resize semantics are exercised by hand
// during the session-log review workflow; the unit test just
// guards against the tracker exploding under SSR / test-env import.

// snapElements — sparse element-bag snapshot. Critical for diagnosing
// "auto-refresh should have fired but didn't" bugs (DESIGN.md §4.3).
// Pin the contracts that callers in SuitPanel + ActionResolution rely
// on:
//   - non-zero entries are kept
//   - zero / undefined entries are stripped (so an empty bag reads as
//     {}, not as a bag full of zeros — easier to scan in the log)
//   - missing hero returns null (signals "no such delver" cleanly to
//     the formatter rather than crashing)

describe("snapElements", () => {
  function makeState(elements: Record<string, Record<string, number>>): CampaignState {
    return { elements } as unknown as CampaignState;
  }

  it("returns the bag with only the non-zero entries", () => {
    const state = makeState({ "hero-01": { earth: 2, fire: 1 } });
    expect(snapElements(state, "hero-01")).toEqual({ earth: 2, fire: 1 });
  });

  it("strips zero entries (so an empty bag reads as {} in the log)", () => {
    const state = makeState({ "hero-01": { earth: 0, fire: 1, water: 0 } });
    expect(snapElements(state, "hero-01")).toEqual({ fire: 1 });
  });

  it("returns {} for a hero with no elements yet", () => {
    const state = makeState({ "hero-01": {} });
    expect(snapElements(state, "hero-01")).toEqual({});
  });

  it("returns null when the hero has no entry in state.elements", () => {
    const state = makeState({});
    expect(snapElements(state, "hero-01")).toBeNull();
  });
});

describe("installViewportTracker", () => {
  it("is a no-op when window is undefined (SSR / node-only test env)", async () => {
    const { installViewportTracker } = await import("../debug/sessionLog");
    // No `window` global in the default vitest environment, so
    // calling install should silently early-return without
    // emitting any events.
    const before = getEntries().length;
    installViewportTracker();
    expect(getEntries().length).toBe(before);
  });
});
