/**
 * Fixed-aspect stage scaler.
 *
 * The game UI is designed against a fixed 3538×2211 px stage
 * (see `#app-stage` in `styles.css`). This module computes the
 * uniform scale factor needed to fit that stage inside the
 * current viewport — preserving aspect ratio with letterboxing
 * — and writes it to the `--stage-scale` CSS variable on
 * `:root`. The CSS rule for `#app-stage` reads the variable via
 * `transform: scale(var(--stage-scale))` and applies the actual
 * scaling.
 *
 * Why a CSS variable instead of inline style on `#app-stage`:
 *   - One variable update is cheaper than mutating an element
 *     style every resize (no style recalc on the stage element
 *     itself; only the transform recomposites).
 *   - Other rules can read the same variable if they ever need
 *     to compensate (e.g. an overlay that intentionally uses
 *     viewport units would multiply by `var(--stage-scale)` to
 *     match the design pixel scale).
 *
 * Called once from `main.ts > installStageScaler()` at boot. A
 * `resize` listener (plus an `orientationchange` listener for
 * mobile) recomputes the scale on viewport change. The resize
 * handler is debounced lightly via `requestAnimationFrame` to
 * coalesce the burst of events Chrome / Safari fire while the
 * user is dragging the window edge.
 */

export const DESIGN_WIDTH = 3538;
export const DESIGN_HEIGHT = 2211;

/**
 * Compute the largest scale factor that lets a (`DESIGN_WIDTH`
 * × `DESIGN_HEIGHT`) rectangle fit inside (`viewportW` ×
 * `viewportH`). Returns 1 for a perfectly-sized viewport; less
 * than 1 when the viewport is smaller; greater than 1 when the
 * viewport is larger (no upper cap — sharp on retina + 4K
 * displays is the point).
 *
 * Exported for tests; the runtime caller is `applyStageScale`
 * below.
 */
export function computeStageScale(viewportW: number, viewportH: number): number {
  if (viewportW <= 0 || viewportH <= 0) return 1;
  return Math.min(viewportW / DESIGN_WIDTH, viewportH / DESIGN_HEIGHT);
}

/**
 * Read the current `window` size, compute the scale, and write
 * it to the `--stage-scale` CSS variable on the document root.
 * No-op when `document` is unavailable (defensive — `main.ts`
 * only ever calls this in a browser, but the module is
 * importable from vitest scenarios).
 */
export function applyStageScale(): void {
  if (typeof document === "undefined") return;
  const scale = computeStageScale(window.innerWidth, window.innerHeight);
  document.documentElement.style.setProperty("--stage-scale", String(scale));
}

/**
 * Install the resize listener that keeps `--stage-scale` in
 * sync with the current viewport. Idempotent — calling more
 * than once is harmless (subsequent calls re-attach the same
 * listener; the duplicate is a no-op because the handler reads
 * the same global state).
 *
 * Returns a cleanup function for tests / hot-reload that want
 * to detach the listener.
 */
export function installStageScaler(): () => void {
  applyStageScale();
  let frame: number | null = null;
  const onResize = (): void => {
    // rAF-debounce so a burst of resize events (Chrome fires
    // ~60 per drag) collapses into a single repaint. Cancelling
    // the pending frame on each new event is the canonical
    // pattern; the final frame writes the latest scale.
    if (frame !== null) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = null;
      applyStageScale();
    });
  };
  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", onResize);
  return () => {
    window.removeEventListener("resize", onResize);
    window.removeEventListener("orientationchange", onResize);
    if (frame !== null) cancelAnimationFrame(frame);
  };
}
