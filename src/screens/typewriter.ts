/**
 * Shared typewriter helpers for narrative storybook text.
 *
 * Originally lived inside `Story.ts` (Quest intro). Lifted into its
 * own module 2026-05-09 so the same reveal can drive every screen
 * that paints narrative into `.storybook-text` — End-of-Wave page
 * (`screens/WavePhases.ts`) and Town Visit pages (`screens/TownVisit.ts`).
 *
 * Pairs with the `.storybook-text .tt-char` CSS in `styles.css`:
 *   - `.tt-char` starts at opacity 0 (text takes layout space, just
 *     invisible — so nothing reflows when the reveal completes).
 *   - `.tt-char--revealed` sets opacity 1.
 *
 * Reveal pace is wall-clock-based (`performance.now()`), not per-tick,
 * so a tab refocus / brief stall doesn't permanently shift the
 * timeline — when the interval next fires, it catches up to the
 * elapsed-clock-derived target index in one batch.
 *
 * Module-singleton design: only one typewriter is "active" at a time
 * (only one screen is rendered at a time). The active reference is
 * tracked here so handlers from any screen can:
 *   - `getActiveTypewriter()` to query "still typing?" / `.skip()`
 *   - `withTypewriterSkipFirst(handler)` to wrap a button click so
 *     the FIRST click skips the reveal instead of advancing — same
 *     UX the original Story.ts had on its Next button.
 */

export const TYPEWRITER_CHARS_PER_SECOND = 35;
const MS_PER_CHAR = 1000 / TYPEWRITER_CHARS_PER_SECOND;

export interface Typewriter {
  /** Reveal every remaining char immediately + cancel the interval. */
  skip(): void;
  /** True once every char is revealed (or there were no chars). */
  isComplete(): boolean;
  /** Cancel the interval without revealing remaining chars. Used
   *  when the host screen unmounts mid-reveal. */
  stop(): void;
  /** `performance.now()` reading captured at the start of the
   *  typewriter's life. Used by skip-on-click helpers to reject
   *  click events dispatched BEFORE this typewriter existed (see
   *  bubble-race note in `wireSkipOnClick`). */
  startedAt: number;
}

let activeTimer: number | null = null;
let activeTypewriter: Typewriter | null = null;

function clearActiveTimer(): void {
  if (activeTimer !== null) {
    window.clearInterval(activeTimer);
    activeTimer = null;
  }
}

/**
 * Cancel any in-flight typewriter and clear the active reference.
 * Call from screen-mount and screen-unmount paths so a stale
 * interval can't keep firing against detached DOM.
 */
export function stopActiveTypewriter(): void {
  clearActiveTimer();
  activeTypewriter = null;
}

/**
 * The currently-running typewriter, if any. `null` when no narrative
 * page is mounted or the most recent one has finished AND been
 * cleared. Use `isComplete()` to differentiate "still typing" from
 * "done" without nulling the reference.
 */
export function getActiveTypewriter(): Typewriter | null {
  return activeTypewriter;
}

/**
 * Start revealing every `<span class="tt-char">` inside `container`
 * one at a time. Replaces any previously-active typewriter (one
 * narrative screen at a time, by construction).
 *
 * The interval self-cancels if `container` is removed from the DOM
 * (host.isConnected check), so callers don't need to thread teardown
 * — though they SHOULD call `stopActiveTypewriter` on screen unmount
 * to free the reference promptly.
 *
 * `onComplete` (optional, added 2026-05-18) fires exactly once when
 * the reveal finishes — whether the finish came from the natural
 * tick, an explicit `.skip()`, or there were zero chars to reveal
 * (in which case the callback fires on a microtask so the caller
 * always sees `startTypewriter` return before the callback runs).
 * Never fires if `.stop()` is called (host unmounted before
 * completion) — stop is "abandon the reveal", not "finish it".
 * Used by TownVisit to defer rendering navigation buttons until the
 * dialogue has finished revealing, so a player can't tap "Check out
 * the Misty Eagle Pub" before reading why it matters.
 */
export function startTypewriter(
  container: HTMLElement,
  onComplete?: () => void,
): Typewriter {
  // Defensive: if a previous typewriter is still running (e.g. host
  // re-rendered without an explicit stop), kill it first so we don't
  // have two intervals competing over different span lists.
  clearActiveTimer();

  const chars = Array.from(container.querySelectorAll<HTMLSpanElement>(".tt-char"));
  let revealed = 0;
  let complete = chars.length === 0;
  let onCompleteFired = false;
  // Captured at the very start so every code path (zero-char,
  // tick, skip) reports a consistent epoch. Used by the skip-on-
  // click helpers to reject clicks that bubbled from BEFORE this
  // typewriter was created (see `wireSkipOnClick` bubble-race note).
  const startedAt = performance.now();

  const fireOnComplete = () => {
    if (onCompleteFired) return;
    onCompleteFired = true;
    if (onComplete) onComplete();
  };

  const revealUpTo = (target: number) => {
    while (revealed < target && revealed < chars.length) {
      chars[revealed]!.classList.add("tt-char--revealed");
      revealed += 1;
    }
  };

  if (complete) {
    const tw: Typewriter = {
      skip() {},
      stop() {},
      isComplete: () => true,
      startedAt,
    };
    activeTypewriter = tw;
    // Defer so `startTypewriter` returns first, matching the
    // ordering of the natural / skip completion paths (which always
    // fire async via the interval / user click).
    if (typeof queueMicrotask === "function") queueMicrotask(fireOnComplete);
    else Promise.resolve().then(fireOnComplete);
    return tw;
  }

  const tick = () => {
    if (!container.isConnected) {
      // Host detached — the host screen unmounted without calling
      // stopActiveTypewriter. Self-clean and bail. Do NOT fire
      // onComplete: the reveal was abandoned, not finished.
      clearActiveTimer();
      return;
    }
    const elapsed = performance.now() - startedAt;
    const target = Math.min(chars.length, Math.floor(elapsed / MS_PER_CHAR));
    revealUpTo(target);
    if (revealed >= chars.length) {
      complete = true;
      clearActiveTimer();
      fireOnComplete();
    }
  };
  activeTimer = window.setInterval(tick, MS_PER_CHAR);

  const tw: Typewriter = {
    skip() {
      clearActiveTimer();
      revealUpTo(chars.length);
      complete = true;
      fireOnComplete();
    },
    stop() {
      clearActiveTimer();
      // Intentionally do not fire onComplete — caller wants to
      // tear down, not gate work on a finished reveal.
    },
    isComplete: () => complete,
    startedAt,
  };
  activeTypewriter = tw;
  return tw;
}

/**
 * Build the inner HTML for narrative text where each character is
 * wrapped in `<span class="tt-char">`. Paragraph breaks (`\n\n+`)
 * become `<p>` boundaries, single newlines become `<br>` — so word-
 * wrap, line height, and final paragraph layout are byte-identical
 * to a non-typewriter render of the same text.
 *
 * Splits by Unicode code point so surrogate pairs (e.g. emoji) stay
 * as a single span. Each character is HTML-escaped individually so
 * `&`, `<`, `>`, `"` don't break the markup.
 */
export function formatNarrativeWithTypewriterSpans(text: string): string {
  return text
    .split(/\n\n+/)
    .map((para) => {
      const lines = para.split("\n").map(charsToSpans);
      return `<p>${lines.join("<br>")}</p>`;
    })
    .join("");
}

function charsToSpans(line: string): string {
  return Array.from(line)
    .map((ch) => `<span class="tt-char">${escapeHtml(ch)}</span>`)
    .join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Wrap a click handler so the FIRST click while the typewriter is
 * still revealing skips the reveal instead of firing the action.
 * The user's next click then proceeds normally. Mirrors the Story
 * screen's Next-button UX so a hasty click-through doesn't blow
 * past unread text.
 *
 * Use on every button that would advance away from the current
 * narrative page (Continue, choice buttons, retry, etc.). Buttons
 * that DON'T advance (e.g. open a campaign-sheet side trip) can
 * skip this wrapping if the typewriter doesn't matter to them, but
 * applying it uniformly is simpler and never wrong.
 */
export function withTypewriterSkipFirst<E extends Event>(
  handler: (ev: E) => void,
): (ev: E) => void {
  return (ev) => {
    const tw = activeTypewriter;
    // Same bubble-race guard as `wireSkipOnClick` — see note there.
    // An event dispatched BEFORE this typewriter existed is from a
    // prior page transition still propagating; treat as "already
    // past the reveal" and run the wrapped handler normally.
    if (tw && !tw.isComplete() && ev.timeStamp >= tw.startedAt) {
      tw.skip();
      return;
    }
    handler(ev);
  };
}

/**
 * Wire any element so a click anywhere inside it skips the active
 * typewriter (without doing anything else). Returns a no-op if the
 * element doesn't exist so callers can spread it across optional
 * renders without null-checking.
 *
 * Typically called with the full screen wrap (e.g. `.screen--story`)
 * so a player can tap *anywhere* on the page to fast-forward — not
 * just on the storybook card itself. Empty background, portrait,
 * decoration, etc. all become tap-to-skip surfaces. Broadened from
 * `.storybook-page`-only on 2026-05-18 after a UX request.
 *
 * Click bubbles up, so this coexists fine with per-button click
 * handlers (which typically wrap their action in
 * `withTypewriterSkipFirst`); both fire skip during the reveal but
 * `.skip()` is idempotent via the `onCompleteFired` latch.
 *
 * Bubble-race guard (added 2026-05-18): a click on a navigation
 * button (Continue, choice, modal Continue with auto-advance) runs
 * a handler that synchronously renders the next page and starts a
 * fresh typewriter — and THEN the same click event continues
 * bubbling up through the previous wrap, where this listener still
 * lives. Without a guard, the listener would read the new
 * `activeTypewriter` (just started, not complete) and skip it
 * immediately, so every post-navigation page reveals instantly.
 * We reject any click whose `event.timeStamp` predates the active
 * typewriter's `startedAt` — those events are from a prior page
 * transition's bubble path, not a player choice to skip THIS reveal.
 */
export function wireSkipOnClick(target: HTMLElement | null): void {
  if (!target) return;
  target.addEventListener("click", (ev) => {
    const tw = activeTypewriter;
    if (!tw || tw.isComplete()) return;
    if (ev.timeStamp < tw.startedAt) return;
    tw.skip();
  });
}

/**
 * @deprecated Use `wireSkipOnClick` instead — it's the same function
 * but the broader name reflects that callers now pass the whole
 * screen wrap (not just `.storybook-page`). Kept as a re-export so
 * any external code that imported the old name still works.
 */
export const wireStorybookSkipOnClick = wireSkipOnClick;
