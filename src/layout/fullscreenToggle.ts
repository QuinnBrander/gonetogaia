/**
 * Fullscreen toggle button.
 *
 * Mounts a small fixed-position button in the bottom-right of
 * the viewport (OUTSIDE the scaled `#app-stage`, so it stays a
 * constant pixel size regardless of the design-canvas scale).
 * Clicking it requests / exits browser fullscreen via the
 * standard Fullscreen API. The icon swaps between an
 * "enter-fullscreen" (corners pointing outward) and an
 * "exit-fullscreen" (corners pointing inward) state via a
 * `fullscreenchange` listener so it stays in sync if the user
 * exits via `Esc` or a system gesture.
 *
 * Why a JS-mounted button instead of an HTML element:
 *   - The viewport-shell is part of `index.html`, but the
 *     button's icon swap + click handler need TypeScript to
 *     hook up. Centralising the whole component in one module
 *     keeps the HTML clean and the toggle self-contained.
 *
 * Why bottom-right (not top-right):
 *   - The session-log debug panel (`debug/SessionLogPanel.ts`)
 *     already lives at top-right with high z-index when open.
 *     Bottom-right keeps the two from stacking on each other.
 *
 * Caveats:
 *   - `document.fullscreenEnabled` can be false on iOS Safari
 *     for the document element (only `<video>` supports it
 *     historically). The button still mounts so the user gets
 *     a hint, but clicks fail silently — the catch on the
 *     promise logs to the session log for triage rather than
 *     throwing.
 *   - Browser permission policies (e.g. embedded iframes) can
 *     also block the request; same silent-log behaviour.
 */

import { logEvent } from "../debug/sessionLog";

/** SVG path data for the enter-fullscreen icon — four
 *  corner-brackets pointing outward from the centre. Drawn at
 *  a 24×24 viewBox; the host button scales it via CSS. */
const ENTER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M3 8 V3 H8" />
  <path d="M16 3 H21 V8" />
  <path d="M21 16 V21 H16" />
  <path d="M8 21 H3 V16" />
</svg>`;

/** SVG path data for the exit-fullscreen icon — four
 *  corner-brackets pointing inward. */
const EXIT_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M8 3 V8 H3" />
  <path d="M21 8 H16 V3" />
  <path d="M16 21 V16 H21" />
  <path d="M3 16 H8 V21" />
</svg>`;

/** True when the document is currently in fullscreen mode.
 *  Uses the standard API with a graceful fall to the webkit
 *  alias for older Safari. */
function isFullscreen(): boolean {
  if (typeof document === "undefined") return false;
  // `webkitFullscreenElement` lives on the same `document`
  // object as `fullscreenElement` on legacy Safari. Cast via
  // unknown so the union of types stays narrow.
  const doc = document as Document & { webkitFullscreenElement?: Element | null };
  return !!(doc.fullscreenElement ?? doc.webkitFullscreenElement);
}

/** Toggle fullscreen on the document root. Returns the
 *  promise from the underlying API so callers can await it for
 *  tests; the runtime click handler discards it. */
function toggleFullscreen(): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve();
  const docEl = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void>;
  };
  const docAny = document as Document & {
    webkitExitFullscreen?: () => Promise<void>;
  };
  if (isFullscreen()) {
    const exit = docAny.exitFullscreen?.bind(docAny) ?? docAny.webkitExitFullscreen?.bind(docAny);
    if (!exit) return Promise.resolve();
    return exit().catch((err: unknown) => {
      logEvent("fullscreen.exit-failed", { err: String(err) });
    });
  }
  const enter = docEl.requestFullscreen?.bind(docEl) ?? docEl.webkitRequestFullscreen?.bind(docEl);
  if (!enter) {
    logEvent("fullscreen.unsupported", {});
    return Promise.resolve();
  }
  return enter().catch((err: unknown) => {
    logEvent("fullscreen.enter-failed", { err: String(err) });
  });
}

/** Mount the floating fullscreen button into `document.body`.
 *  Idempotent — calling more than once is a no-op (the second
 *  call sees the existing element and bails). Returns a
 *  cleanup function for tests / hot-reload that detaches the
 *  button + listener. */
export function installFullscreenButton(): () => void {
  if (typeof document === "undefined") return () => {};
  const existing = document.getElementById("fullscreen-toggle");
  if (existing) return () => {}; // idempotent

  const btn = document.createElement("button");
  btn.id = "fullscreen-toggle";
  btn.className = "fullscreen-toggle";
  btn.type = "button";
  btn.title = "Toggle fullscreen (F11 also works)";
  btn.setAttribute("aria-label", "Toggle fullscreen");
  btn.innerHTML = ENTER_SVG;

  const sync = (): void => {
    const fs = isFullscreen();
    btn.innerHTML = fs ? EXIT_SVG : ENTER_SVG;
    btn.setAttribute("aria-pressed", String(fs));
    btn.title = fs ? "Exit fullscreen (Esc also works)" : "Toggle fullscreen (F11 also works)";
  };
  sync();

  btn.addEventListener("click", () => {
    logEvent("click.fullscreen-toggle", { willEnter: !isFullscreen() });
    void toggleFullscreen();
  });

  document.addEventListener("fullscreenchange", sync);
  // Webkit alias for legacy Safari — same handler, both names
  // fire identically when the user is in / out of fullscreen.
  document.addEventListener("webkitfullscreenchange", sync);

  document.body.appendChild(btn);
  logEvent("fullscreen.button-mounted", {});

  return () => {
    document.removeEventListener("fullscreenchange", sync);
    document.removeEventListener("webkitfullscreenchange", sync);
    btn.remove();
  };
}
