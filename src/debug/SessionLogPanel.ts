/**
 * SessionLogPanel — togglable floating overlay showing the current
 * session's event log. Mounted once per BoardScreen render and
 * subscribed to {@link onChange} so it re-renders reactively when
 * new events arrive.
 *
 * Usage:
 *   - Press `~` (backtick / tilde — uncommon, no gameplay collision)
 *     to open / close.
 *   - Topbar "Log" button does the same thing for touch users.
 *
 * Inside the panel:
 *   - Header: session id + entry count + total runtime.
 *   - Body: scrolling list of `[ts] kind  k=v k=v` rows (newest at
 *     the BOTTOM so the timeline reads top-to-bottom and a player
 *     scrolling for the most recent event lands at the natural
 *     read-position after auto-scroll).
 *   - Footer: Copy JSON / Copy text / Clear / Close buttons.
 *
 * The panel is intentionally independent of game state — it reads
 * only from the session log module — so it can survive any UI
 * re-render without losing scroll position or open/closed state.
 */

import {
  clearLog,
  formatJsonl,
  formatPlain,
  getEntries,
  getSessionId,
  logEvent,
  onChange,
} from "./sessionLog";

let panelOpen = false;
let mountedRoot: HTMLDivElement | null = null;
let unsubscribe: (() => void) | null = null;

export function isSessionLogPanelOpen(): boolean {
  return panelOpen;
}

export function toggleSessionLogPanel(): void {
  panelOpen = !panelOpen;
  // Re-render the panel into its existing mount point if any.
  if (mountedRoot) renderInto(mountedRoot);
}

/**
 * Mount (or re-mount) the panel into a host element. Called once per
 * BoardScreen render so the panel survives screen rebuilds without
 * the caller having to remember to re-subscribe.
 */
export function mountSessionLogPanel(host: HTMLDivElement): void {
  mountedRoot = host;
  renderInto(host);
  if (unsubscribe) unsubscribe();
  unsubscribe = onChange(() => {
    if (mountedRoot) renderInto(mountedRoot);
  });
}

// --- Global mount (every screen) -------------------------------------------
//
// Pre-2026-05-18 the panel was only mounted by `BoardScreen.ts` — its
// host element lived inside the BoardScreen DOM tree and was wiped
// the moment the player navigated to TownVisit / Story / Title.
// During those screens the `~` keybind appeared to do nothing
// (the panel still toggled internally, but its mount node was
// detached). That made the session log useless for diagnosing
// town-visit and storybook bugs — the exact screens where layout
// and narrative bugs cluster.
//
// `installGlobalSessionLogPanel()` fixes that by attaching the
// panel host directly to `document.body` (above every screen via a
// high z-index in `styles.css .dbg-log-panel`) AND installing the
// `~` keybind on `document` once at app load. The panel now follows
// the player across every screen with no per-screen wiring required.
//
// BoardScreen's local mount + keybind installer continue to exist
// for backwards compatibility (the topbar "Log" button still works),
// but they're idempotent — the singleton flags below guarantee no
// double-mount / double-keybind.

const GLOBAL_INSTALLED_KEY = "__g2g_globalSessionLogInstalled";

/**
 * Install the session log panel globally:
 *
 *   1. Append a `<div data-global-session-log-mount>` to `document.body`
 *      and `mountSessionLogPanel` into it (so the panel is reachable
 *      from any screen, not just BoardScreen).
 *   2. Bind `~` (backtick / tilde) on `document` to toggle the panel
 *      and emit a `debug.toggle-log-panel` event.
 *
 * Idempotent — safe to call multiple times. Call from app entry
 * (`main.ts`) once at module load.
 */
export function installGlobalSessionLogPanel(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const w = window as unknown as Record<string, unknown>;
  if (w[GLOBAL_INSTALLED_KEY]) return;
  w[GLOBAL_INSTALLED_KEY] = true;

  const host = document.createElement("div");
  host.setAttribute("data-global-session-log-mount", "");
  document.body.appendChild(host);
  mountSessionLogPanel(host);

  document.addEventListener("keydown", (e) => {
    if (e.key !== "`" && e.key !== "~") return;
    if (e.target instanceof HTMLInputElement) return;
    if (e.target instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    logEvent("debug.toggle-log-panel", { source: "global-keybind" });
    toggleSessionLogPanel();
  });
}

function renderInto(host: HTMLDivElement): void {
  if (!panelOpen) {
    host.innerHTML = "";
    host.setAttribute("hidden", "");
    return;
  }
  host.removeAttribute("hidden");

  const entries = getEntries();
  const sessionId = getSessionId();
  const total = entries.length;
  const runtimeMs = entries.length > 0 ? entries[entries.length - 1]!.ts : 0;
  const runtimeSec = (runtimeMs / 1000).toFixed(1);

  // Render newest at the BOTTOM so auto-scroll-to-end shows the most
  // recent event without the player having to scroll.
  const rowsHtml = entries.map((e) => {
    const ts = e.ts.toFixed(0).padStart(6, " ");
    const dataParts: string[] = [];
    for (const [k, v] of Object.entries(e.data)) {
      dataParts.push(`<span class="dbg-log-kv"><span class="dbg-log-k">${escapeHtml(k)}=</span><span class="dbg-log-v">${escapeHtml(formatValue(v))}</span></span>`);
    }
    const dataHtml = dataParts.length > 0 ? `<span class="dbg-log-data">${dataParts.join(" ")}</span>` : "";
    return `<div class="dbg-log-row dbg-log-row--${escapeHtml(e.kind.split(".")[0] ?? "")}">
      <span class="dbg-log-ts">${ts}</span>
      <span class="dbg-log-kind">${escapeHtml(e.kind)}</span>
      ${dataHtml}
    </div>`;
  }).join("");

  host.innerHTML = `
    <div class="dbg-log-panel">
      <div class="dbg-log-header">
        <strong>Session log</strong>
        <span class="dbg-log-meta">${escapeHtml(sessionId)} - ${total} event${total === 1 ? "" : "s"} - ${runtimeSec}s</span>
        <button class="btn btn--small btn--ghost" data-dbg-action="close" title="Close (~)">x</button>
      </div>
      <div class="dbg-log-body" data-dbg-body>
        ${rowsHtml || `<div class="dbg-log-empty">No events yet. Play the game and they'll show up here.</div>`}
      </div>
      <div class="dbg-log-footer">
        <button class="btn btn--small btn--ghost" data-dbg-action="copy-text" title="Copy as plain text">Copy text</button>
        <button class="btn btn--small btn--ghost" data-dbg-action="copy-json" title="Copy as JSONL (paste back to the agent)">Copy JSONL</button>
        <button class="btn btn--small btn--ghost" data-dbg-action="clear" title="Wipe the log + start a fresh session id">Clear</button>
      </div>
    </div>
  `;

  // Auto-scroll to the bottom on every render so the player sees the
  // latest event without manual scrolling.
  const body = host.querySelector<HTMLDivElement>("[data-dbg-body]");
  if (body) body.scrollTop = body.scrollHeight;

  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-dbg-action]")) {
    btn.addEventListener("click", () => onAction(btn.dataset.dbgAction!));
  }
}

function onAction(action: string): void {
  switch (action) {
    case "close":
      panelOpen = false;
      if (mountedRoot) renderInto(mountedRoot);
      return;
    case "copy-text":
      copyToClipboard(formatPlain(), "Plain-text log copied");
      return;
    case "copy-json":
      copyToClipboard(formatJsonl(), "JSONL log copied");
      return;
    case "clear":
      // Clear without a confirm prompt — the panel itself is a debug
      // affordance, an accidental wipe is recoverable by replaying.
      clearLog();
      return;
  }
}

function copyToClipboard(text: string, successMsg: string): void {
  // navigator.clipboard is best-effort — fall back to a hidden
  // textarea + execCommand if it's unavailable (older Safari).
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => flashToast(successMsg))
      .catch(() => fallbackCopy(text, successMsg));
    return;
  }
  fallbackCopy(text, successMsg);
}

function fallbackCopy(text: string, successMsg: string): void {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    // execCommand is deprecated but still works as a fallback.
    document.execCommand("copy");
    flashToast(successMsg);
  } catch {
    flashToast("Copy failed - select-all + Cmd/Ctrl+C in the panel");
  }
  document.body.removeChild(ta);
}

function flashToast(msg: string): void {
  const t = document.createElement("div");
  t.className = "dbg-log-toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.remove(); }, 1600);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatValue(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "<unserialisable>";
  }
}
