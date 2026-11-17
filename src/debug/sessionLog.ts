/**
 * Session-log: an in-browser playthrough trace for bug reproduction.
 *
 * Goal — when the user reports an intermittent bug ("I tried to use
 * 2 AP to refresh a weapon, sometimes it doesn't work"), they should
 * be able to dump the last N events from their session into the chat
 * and the agent should be able to read EXACTLY what they did:
 *   - which buttons they tapped, in what order
 *   - which engine functions ran, with their inputs
 *   - the engine's accept/reject result
 *   - the relevant state slice BEFORE and AFTER each call
 *
 * That's enough to disambiguate "engine rejected silently" vs "click
 * never reached the handler" vs "result reached the handler but the
 * UI didn't reflect it" — the three buckets every UX-flavoured bug
 * report falls into.
 *
 * Architecture:
 *
 * - In-memory **ring buffer** of {@link LogEntry} (capped at
 *   {@link MAX_ENTRIES} so a long session doesn't OOM the tab).
 * - **Persisted to localStorage** under {@link STORAGE_KEY} on every
 *   `logEvent()` so a hard refresh / accidental tab close doesn't
 *   nuke the trace right when the bug fires.
 * - **Session id** + monotonic timestamps (ms since session start) so
 *   the log reads as a clean timeline rather than wall-clock noise.
 * - **Snapshotters** ({@link snapHeroAp}, {@link snapTurn},
 *   {@link snapSlots}, {@link snapModal}) — pure helpers that pluck
 *   the small state slice each event cares about, so call sites stay
 *   one-liners.
 * - **Subscribers** — the panel UI subscribes via {@link onChange}
 *   so it can re-render reactively when new events arrive.
 *
 * Pure infrastructure — no game-rule knowledge lives here, just a
 * timeline + snapshot helpers. Call sites in `screens/*.ts` and
 * `engine/*.ts` are responsible for choosing what to log.
 */

import type { CampaignState } from "../state";
import type { Element } from "../types";
import type { Modal } from "../uiState";

/** One row in the timeline. */
export interface LogEntry {
  /** ms since the session started (NOT epoch — easier to scan). */
  ts: number;
  /** Dot-separated event type, e.g. `engine.spendApRefreshWeapon`. */
  kind: string;
  /** Event-specific payload. Keep small + serialisable. */
  data: Record<string, unknown>;
}

/** Snapshot of a delver's AP pool. Used by AP-spend traces. */
export interface ApSnapshot {
  currentAp: number;
  baseAp: number;
}

/** Snapshot of a delver's turn-state ephemera. */
export interface TurnSnapshot {
  movementUsed: boolean;
  actionUsed: boolean;
  cardPlaced: { slotIdx: number; cardId: string } | null;
  preparedToRun: boolean;
}

/** Snapshot of a delver's weapon-slot occupancy. */
export type SlotsSnapshot = Array<string | null>;

/** Snapshot of the currently-open modal (kind + key fields). */
export type ModalSnapshot = { kind: string } & Record<string, unknown>;

/** Snapshot of a delver's element bag (sparse — only non-zero entries). */
export type ElementsSnapshot = Partial<Record<Element, number>>;

const STORAGE_KEY = "g2g.sessionLog.v1";
const MAX_ENTRIES = 500;

let entries: LogEntry[] = [];
let sessionStart = performance.now();
let sessionId = nextSessionId();
const subscribers = new Set<() => void>();

restoreFromStorage();

function nextSessionId(): string {
  // Short ID — just enough to disambiguate logs across reloads. Format
  // YYYYMMDD-HHMMSS-rand so sorting by id roughly sorts by recency.
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}

// Guarded localStorage access — the session log lives in a module
// that's imported eagerly from app entry points, but the unit-test
// environment runs the same modules in plain Node where
// `localStorage` doesn't exist. Returning `null` from this getter
// lets every persistence call no-op cleanly in tests without an
// `if (typeof localStorage)` guard at every call site.
function getStorage(): Storage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // Some sandboxes throw on the mere reference (e.g. cross-origin
    // iframes with disabled storage). Treat as "no storage".
  }
  return null;
}

function restoreFromStorage(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as {
      sessionId?: string;
      sessionStart?: number;
      entries?: LogEntry[];
    };
    if (Array.isArray(parsed.entries)) {
      entries = parsed.entries.slice(-MAX_ENTRIES);
    }
    if (typeof parsed.sessionId === "string") {
      sessionId = parsed.sessionId;
    }
    // We can't restore the original `performance.now()` reference
    // across page loads (it resets to 0 per document), so re-anchor
    // the session start to NOW minus the last entry's relative ts.
    // That keeps subsequent timestamps continuous-ish without
    // pretending we recovered the wall-clock time.
    if (entries.length > 0) {
      const lastTs = entries[entries.length - 1]!.ts;
      sessionStart = performance.now() - lastTs;
    }
  } catch {
    // Corrupt entry — wipe and continue with a fresh log.
    entries = [];
  }
}

function persistToStorage(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ sessionId, sessionStart, entries }),
    );
  } catch {
    // Quota / disabled storage — silently fall back to in-memory only.
  }
}

/**
 * Record an event. Keep `data` small (a handful of primitives + at
 * most one nested snapshot object) — the log persists to localStorage
 * on every call and a runaway payload shape would push the quota
 * limit fast.
 */
export function logEvent(kind: string, data: Record<string, unknown> = {}): void {
  const ts = performance.now() - sessionStart;
  entries.push({ ts, kind, data });
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(-MAX_ENTRIES);
  }
  persistToStorage();
  for (const fn of subscribers) fn();
}

/** Return a defensive copy of the current entries (newest last). */
export function getEntries(): LogEntry[] {
  return entries.slice();
}

/** Wipe the log + bump the session id. Used by the panel's Clear button. */
export function clearLog(): void {
  entries = [];
  sessionId = nextSessionId();
  sessionStart = performance.now();
  persistToStorage();
  for (const fn of subscribers) fn();
}

/** Subscribe to log changes (returns an unsubscribe fn). */
export function onChange(fn: () => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

export function getSessionId(): string {
  return sessionId;
}

// --- Snapshot helpers -------------------------------------------------------

export function snapHeroAp(state: CampaignState, heroId: string): ApSnapshot | null {
  const lo = state.loadouts[heroId];
  if (!lo) return null;
  return { currentAp: lo.currentAp, baseAp: lo.baseAp };
}

export function snapTurn(state: CampaignState, heroId: string): TurnSnapshot | null {
  const enc = state.encounter;
  if (!enc) return null;
  const ts = enc.turnState[heroId];
  return {
    movementUsed: ts?.movementUsedThisTurn ?? false,
    actionUsed: ts?.actionUsedThisTurn ?? false,
    cardPlaced: ts?.cardPlacedThisTurn
      ? { slotIdx: ts.cardPlacedThisTurn.slotIdx, cardId: ts.cardPlacedThisTurn.cardId }
      : null,
    preparedToRun: enc.preparedToRun[heroId] ?? false,
  };
}

export function snapSlots(state: CampaignState, heroId: string): SlotsSnapshot | null {
  const lo = state.loadouts[heroId];
  if (!lo) return null;
  return lo.slotCards.slice();
}

export function snapModal(modal: Modal | null): ModalSnapshot | null {
  if (!modal) return null;
  // Modal already serialises cleanly — just clone it as a record.
  return { ...modal } as ModalSnapshot;
}

/**
 * Snapshot a delver's element bag — only entries with a positive count
 * are emitted (so an empty bag serialises as `{}` rather than dragging
 * along six explicit zeros). Critical for diagnosing the
 * "weapon should have auto-refreshed but didn't" class of bug, where
 * the engine's decision hinges on whether the bag has 2 of the slot's
 * printed element at placement time (DESIGN.md §4.3 / `playWeaponCard`).
 */
export function snapElements(state: CampaignState, heroId: string): ElementsSnapshot | null {
  const bag = state.elements[heroId];
  if (!bag) return null;
  const out: ElementsSnapshot = {};
  for (const [k, v] of Object.entries(bag) as Array<[Element, number | undefined]>) {
    if (v !== undefined && v > 0) out[k] = v;
  }
  return out;
}

// --- Formatters -------------------------------------------------------------

/**
 * Serialise the log as JSON Lines (one JSON object per line, newest
 * last). This is the canonical "paste into a bug report" format —
 * every line is independently parseable and grep-friendly.
 */
export function formatJsonl(): string {
  const header = JSON.stringify({ sessionId, kind: "session.header" });
  const body = entries.map((e) => JSON.stringify({
    t: Number(e.ts.toFixed(1)),
    k: e.kind,
    ...(Object.keys(e.data).length > 0 ? { d: e.data } : {}),
  })).join("\n");
  return body ? `${header}\n${body}` : header;
}

/**
 * Serialise as a compact human-readable transcript (each line is a
 * timestamp + event kind + flattened data). Easier on the eye than
 * JSONL when scanning a long log in the panel.
 */
export function formatPlain(): string {
  const lines: string[] = [`# session ${sessionId}`];
  for (const e of entries) {
    const ts = e.ts.toFixed(1).padStart(8, " ");
    const data = formatDataInline(e.data);
    lines.push(`[${ts}ms] ${e.kind}${data ? "  " + data : ""}`);
  }
  return lines.join("\n");
}

function formatDataInline(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    parts.push(`${k}=${formatValueInline(v)}`);
  }
  return parts.join(" ");
}

function formatValueInline(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // Objects / arrays — compact JSON, no whitespace.
  try {
    return JSON.stringify(v);
  } catch {
    return "<unserialisable>";
  }
}

// --- Viewport tracking ------------------------------------------------------
//
// Layout-flavoured bug reports ("the screen briefly shrunk and then
// snapped back") are nearly impossible to reason about without a
// timeline of viewport changes. This installs a SINGLETON `resize`
// listener (debounced so a drag doesn't spam the log) that emits
// `viewport.resize` rows. Pair with the `viewport.initial` event
// fired at install time so the log always anchors to a known
// starting size.
//
// The listener also captures `devicePixelRatio` and the visualViewport
// (mobile keyboard / browser-chrome aware) when available — these
// are the two values most often responsible for "the layout
// flickered" on phones. On desktop they're stable and add no noise.
//
// Single-install guard so reentrant module imports / hot-reload
// don't double-up the listener. The flag lives on `window` rather
// than in module scope because vite's HMR replaces the module
// wholesale on every dev edit — a module-scoped `let` would reset
// to false on each replacement and `installViewportTracker()` would
// re-fire `viewport.initial` once per HMR cycle, polluting the
// session log with bursts of phantom "page loads". The window
// itself isn't replaced by HMR, so a property on it survives.

const VIEWPORT_INSTALLED_KEY = "__g2g_viewportTrackerInstalled";
let lastEmittedSize: { w: number; h: number; vvW: number; vvH: number; dpr: number } | null = null;
let pendingResizeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Install the singleton viewport tracker. Safe to call multiple
 * times — only the first call binds the listener. Call from app
 * entry (`main.ts`) at module load.
 *
 * Emits:
 *   - `viewport.initial` once on install (anchor for the log)
 *   - `viewport.resize` per significant size change, debounced to
 *     {@link debounceMs} (default 200ms — captures the start AND
 *     end of a drag without spamming intermediate frames)
 */
export function installViewportTracker(debounceMs = 200): void {
  if (typeof window === "undefined") return; // SSR / test harness
  const w = window as unknown as Record<string, unknown>;
  if (w[VIEWPORT_INSTALLED_KEY]) return;
  w[VIEWPORT_INSTALLED_KEY] = true;

  const snapshot = (): { w: number; h: number; vvW: number; vvH: number; dpr: number } => ({
    w: window.innerWidth,
    h: window.innerHeight,
    // visualViewport reflects the area NOT covered by mobile chrome
    // / soft keyboards. When it differs from innerWidth/Height,
    // that's usually the real "what the player sees" rectangle.
    vvW: window.visualViewport?.width ?? window.innerWidth,
    vvH: window.visualViewport?.height ?? window.innerHeight,
    dpr: window.devicePixelRatio ?? 1,
  });

  lastEmittedSize = snapshot();
  logEvent("viewport.initial", { ...lastEmittedSize });

  const onResize = (): void => {
    if (pendingResizeTimer) clearTimeout(pendingResizeTimer);
    pendingResizeTimer = setTimeout(() => {
      pendingResizeTimer = null;
      const cur = snapshot();
      // Skip if literally nothing changed (visualViewport scrolls
      // can fire without dimensional change).
      if (
        lastEmittedSize &&
        cur.w === lastEmittedSize.w && cur.h === lastEmittedSize.h &&
        cur.vvW === lastEmittedSize.vvW && cur.vvH === lastEmittedSize.vvH &&
        cur.dpr === lastEmittedSize.dpr
      ) return;
      logEvent("viewport.resize", {
        ...cur,
        dW: cur.w - (lastEmittedSize?.w ?? cur.w),
        dH: cur.h - (lastEmittedSize?.h ?? cur.h),
      });
      lastEmittedSize = cur;
    }, debounceMs);
  };

  window.addEventListener("resize", onResize);
  // visualViewport fires for mobile keyboard / browser-chrome
  // expand/collapse — these are the most common "layout suddenly
  // shifted" culprits on phones, and `window.resize` doesn't
  // always cover them.
  window.visualViewport?.addEventListener("resize", onResize);
  window.visualViewport?.addEventListener("scroll", onResize);
}
