/**
 * Die-roll cycling animation + "result still revealing" gate.
 *
 * Plays a brief "physical die" effect on a single DOM element: the
 * element's text rapidly cycles through random 1..6 faces for ~450 ms
 * and lands on the actual rolled value (the engine's pre-determined
 * result — the cycle is purely cosmetic).
 *
 * ALSO acts as a one-stop "is this die's result safe to reveal yet?"
 * gate via {@link isResultBlocked}. Any UI that depends on the
 * rolled value (target tile previews on the board, Confirm buttons
 * inside the modal, branch-on-outcome modal templates, etc.)
 * SHOULD check this before painting itself, and stay hidden /
 * neutral while the cycle is in flight. The cycle's `onDone`
 * callback fires `router.refresh()` once the result is shown,
 * which re-renders everything with the gate cleared and the
 * result-dependent UI fully populated.
 *
 * Usage from a modal renderer:
 *
 *   const isFreshRoll = consumeFreshRoll("die-roll");
 *   host.innerHTML = `
 *     <h3>...</h3>
 *     <div class="die-roll-result die-roll-result--effective">${rolled}</div>
 *     ${isFreshRoll ? "" : `<button data-confirm>Confirm</button>`}
 *   `;
 *   if (isFreshRoll) {
 *     playDieRollCycle(
 *       host.querySelector(".die-roll-result"),
 *       rolled,
 *       "die-roll",
 *       () => router.refresh(),
 *     );
 *   }
 *
 * The "fresh roll" sentinel must be set at the moment the engine
 * decides the roll (e.g. inside the click handler that calls
 * `setModal({ ..., rolled: rollD6() })`) via {@link markFreshRoll}.
 * Subsequent re-renders of the same modal (e.g. user toggles a
 * Keep/Flip choice) will NOT re-trigger the cycle because
 * `consumeFreshRoll` is one-shot per key.
 *
 * Coupling rule: every `consumeFreshRoll(key) === true` MUST be
 * followed by a `playDieRollCycle(..., key, ...)` or
 * `playDieRollCycleOnAll(..., key, ...)` call in the same render —
 * the consume call pre-bumps the cycling lock so downstream
 * `isResultBlocked` checks within this render still report
 * "blocked" even before the animation actually starts. The matching
 * decrement is handled by `playDieRollCycle*` on completion (or
 * orphan abort if the modal re-renders mid-cycle).
 */

/** ms to spend cycling random faces before landing. */
const CYCLE_DURATION_MS = 450;
/** ms between random-face flips during the cycle. Tuned so the eye
 *  can perceive distinct numbers (faster than ~40 ms blurs into a
 *  blur, slower than ~80 ms looks sluggish). */
const CYCLE_TICK_MS = 55;
/** ms the "land" pulse class stays applied after settling on the
 *  final face. Just long enough for the CSS animation to play. */
const LAND_DURATION_MS = 320;

const freshRolls = new Set<string>();
const cyclingCounts = new Map<string, number>();

function incCycling(key: string): void {
  cyclingCounts.set(key, (cyclingCounts.get(key) ?? 0) + 1);
}
function decCycling(key: string): void {
  const cur = cyclingCounts.get(key) ?? 0;
  if (cur <= 1) cyclingCounts.delete(key);
  else cyclingCounts.set(key, cur - 1);
}

/**
 * Record that the next render of a die-roll surface keyed by `key`
 * should play the cycling animation. Call this at the moment the
 * roll is decided — typically inside the click handler that sets
 * the modal with the new `rolled` value.
 */
export function markFreshRoll(key: string): void {
  freshRolls.add(key);
}

/**
 * Peek-only: is the die-roll result for `key` currently being
 * revealed? Returns `true` when EITHER:
 *   - a fresh roll was marked but no renderer has consumed it yet
 *     (i.e. the cycle hasn't started but is about to), OR
 *   - a cycle for `key` is actively running (post-consume,
 *     pre-completion).
 *
 * Use this in any UI that derives from the rolled value (board
 * target previews, modal confirm buttons, branch-on-outcome
 * templates) so they stay hidden / neutral while the player is
 * still seeing the die spin. The cycle's `onDone` callback fires
 * a router refresh, which re-runs all renderers with the gate
 * cleared.
 */
export function isResultBlocked(key: string): boolean {
  if (freshRolls.has(key)) return true;
  return (cyclingCounts.get(key) ?? 0) > 0;
}

/**
 * One-shot read of the fresh-roll sentinel. Returns `true` exactly
 * once per `markFreshRoll(key)` call; subsequent reads return
 * `false` until the key is re-marked.
 *
 * Side effect on `true` return: pre-bumps the cycling lock so
 * downstream `isResultBlocked(key)` calls within the same render
 * still report "blocked" even before {@link playDieRollCycle}
 * actually starts the animation. The matching decrement is owned
 * by {@link playDieRollCycle} / {@link playDieRollCycleOnAll}, so
 * the renderer MUST follow up with one of those when this returns
 * true (or the lock will leak forever).
 */
export function consumeFreshRoll(key: string): boolean {
  if (!freshRolls.has(key)) return false;
  freshRolls.delete(key);
  incCycling(key);
  return true;
}

/**
 * Drop ALL pending fresh-roll sentinels + cycling locks. Used by
 * the `clearAllUiState` reset path so a session reset doesn't
 * replay an animation on the next opened modal or leave a stale
 * lock blocking the board overlay.
 */
export function clearFreshRolls(): void {
  freshRolls.clear();
  cyclingCounts.clear();
}

/**
 * Play the cycle on a single element keyed by `key`. The element's
 * `textContent` is overwritten with random 1..6 faces every
 * {@link CYCLE_TICK_MS} ms for {@link CYCLE_DURATION_MS} ms total,
 * then settles on `finalValue` and briefly carries a
 * `die-cycling-land` class for the CSS landing flourish.
 *
 * Releases the cycling lock for `key` (matching the bump set by
 * {@link consumeFreshRoll}) on completion, then fires `onDone`.
 * The orphan path (element detached mid-cycle by a re-render)
 * also fires both, so the lock can never leak.
 *
 * If `el` is `null`, no animation runs but the lock is still
 * released and `onDone` still fires (so the renderer can wire
 * `() => router.refresh()` unconditionally).
 */
export function playDieRollCycle(
  el: HTMLElement | null,
  finalValue: number,
  key: string,
  onDone?: () => void,
): void {
  playDieRollCycleAnim(el, finalValue, () => {
    decCycling(key);
    onDone?.();
  });
}

/**
 * Play the cycle on every matching element. Useful when the same
 * roll is surfaced by multiple DOM nodes (e.g. a big result square
 * AND an inline `<strong>` label inside a paragraph) — they all
 * cycle in lockstep and land on the same final value.
 *
 * The cycling lock for `key` is released ONCE — after every per-
 * element cycle has finished — and only then is `onDone` fired.
 * This matches the single bump performed by {@link consumeFreshRoll}.
 */
export function playDieRollCycleOnAll(
  els: ArrayLike<HTMLElement> | NodeListOf<HTMLElement>,
  finalValue: number,
  key: string,
  onDone?: () => void,
): void {
  if (els.length === 0) {
    decCycling(key);
    onDone?.();
    return;
  }
  let remaining = els.length;
  const onEachDone = (): void => {
    remaining--;
    if (remaining === 0) {
      decCycling(key);
      onDone?.();
    }
  };
  for (let i = 0; i < els.length; i++) {
    playDieRollCycleAnim(els[i] ?? null, finalValue, onEachDone);
  }
}

/**
 * Pure animation primitive — runs the cycle and fires `onDone` when
 * settled (or when orphaned by a mid-cycle re-render). Does NOT
 * touch the cycling lock; lock management is owned by
 * {@link playDieRollCycle} / {@link playDieRollCycleOnAll}.
 */
function playDieRollCycleAnim(
  el: HTMLElement | null,
  finalValue: number,
  onDone?: () => void,
): void {
  if (!el) {
    onDone?.();
    return;
  }
  el.classList.remove("die-cycling-land");
  el.classList.add("die-cycling");
  const startedAt = performance.now();
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    onDone?.();
  };
  const tick = (): void => {
    if (!el.isConnected) {
      // Element was replaced by a re-render — stop spinning a
      // detached node. We still fire `finish()` so the lock + the
      // caller's onDone (typically `router.refresh()`) get to run,
      // otherwise the gate would stay stuck on "blocked" forever.
      finish();
      return;
    }
    const elapsed = performance.now() - startedAt;
    if (elapsed >= CYCLE_DURATION_MS) {
      el.textContent = String(finalValue);
      el.classList.remove("die-cycling");
      el.classList.add("die-cycling-land");
      window.setTimeout(() => {
        if (el.isConnected) el.classList.remove("die-cycling-land");
      }, LAND_DURATION_MS);
      finish();
      return;
    }
    el.textContent = String(1 + Math.floor(Math.random() * 6));
    window.setTimeout(tick, CYCLE_TICK_MS);
  };
  // Show a placeholder face IMMEDIATELY so the first paint of the
  // result stage already shows a random face (not the final value
  // briefly visible before the cycle takes over).
  el.textContent = String(1 + Math.floor(Math.random() * 6));
  window.setTimeout(tick, CYCLE_TICK_MS);
}
