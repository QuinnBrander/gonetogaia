/**
 * Kill-feedback fly animations -- visual confirmation when an
 * enemy dies. Two effects per kill:
 *
 *   1. "[N] XP" text flies from the dying enemy's tile up to the
 *      topbar `.xp-pill-value` (the "XP On Hand" counter).
 *   2. One element-token icon per UNIQUE granted element flies
 *      from the same tile to its matching slot on a delver's
 *      suit board (`.suit-slot--el-<element>`).
 *
 * Element-grant deduplication: `applyKill` grants every printed
 * `gainElements` entry to BOTH delvers (capped per delver at 2 --
 * see `engine/kills.ts`). If we naively animated every grant we'd
 * show two flying earth tokens for one kill, which looks like a
 * bug. Per the design ask "just do it for one delver so we don't
 * double up", we show ONE fly per element type per kill, picking
 * the first delver whose grant actually landed (so an overflowed
 * mind grant gracefully falls back to the body delver's slot if
 * THAT one landed).
 *
 * Lifecycle:
 *   - Caller invokes `snapshotKillSites(session, root)` BEFORE
 *     `finalizeAttackSession` runs. At that point the dying
 *     enemies are still alive=true so their `.board-tile` is
 *     still in the DOM -- we capture each tile's viewport rect
 *     keyed by `enemyInstanceId`.
 *   - Caller runs `finalizeAttackSession(state, session)` and
 *     whatever refresh / modal advance is next. The tile
 *     elements may now be torn down.
 *   - Caller invokes `playKillAnimations(seeds, session)` inside
 *     a `requestAnimationFrame` so the new (enemy-removed) DOM
 *     is already painted. The flying tokens spawn at the
 *     captured source coords (using `position: fixed`, so they
 *     don't care that the tile is gone) and animate toward the
 *     live target elements (XP HUD / suit slot) which DO need
 *     to be in the current DOM.
 *
 * Spawn pattern: each token is an absolutely-positioned div
 * appended to `document.body` (NOT the stage), so the animation
 * sits above the `transform: scale(var(--stage-scale))` layer
 * and uses true viewport pixels. The fly itself is a CSS
 * transition on `left`/`top`/`opacity` -- no JS tween loop --
 * which keeps the animation cost in the compositor.
 */

import type { AttackSession } from "../engine/combat";
import { ELEMENT_IMAGE, getHero } from "../data";
import type { Element } from "../types";

/** Captured source rect for one killed enemy. */
export interface KillAnimSeed {
  enemyInstanceId: string;
  /** Viewport-space center of the dying tile (snapshotted before
   *  `finalizeAttackSession` removes the body). */
  fromX: number;
  fromY: number;
}

/**
 * Walk `session.steps` for killed enemies and capture each tile's
 * viewport rect via `data-enemy-instance` (stamped in
 * `BoardScreen > placeEnemyTile`). Must be called BEFORE
 * `finalizeAttackSession` runs -- once `enemy.alive = false`
 * fires the tile will be removed on the next render.
 */
export function snapshotKillSites(session: AttackSession): KillAnimSeed[] {
  const seeds: KillAnimSeed[] = [];
  for (const step of session.steps) {
    if (!step.killed || !step.enemyInstanceId) continue;
    const tileEl = document.querySelector<HTMLElement>(
      `[data-enemy-instance="${cssEscape(step.enemyInstanceId)}"]`,
    );
    if (!tileEl) continue;
    const r = tileEl.getBoundingClientRect();
    seeds.push({
      enemyInstanceId: step.enemyInstanceId,
      fromX: r.left + r.width / 2,
      fromY: r.top + r.height / 2,
    });
  }
  return seeds;
}

/**
 * Spawn the fly-up XP labels + fly-to-slot element icons for
 * every killed enemy in `session`. Idempotent w.r.t. its own
 * spawn (each call creates a fresh set of DOM nodes that self-
 * remove on transition-end / timeout); safe to no-op if `seeds`
 * is empty.
 */
export function playKillAnimations(
  seeds: KillAnimSeed[],
  session: AttackSession,
): void {
  if (seeds.length === 0) return;
  for (const seed of seeds) {
    const step = session.steps.find(
      (s) => s.enemyInstanceId === seed.enemyInstanceId,
    );
    if (!step || !step.killResult) continue;
    const kill = step.killResult;

    // --- XP fly: source -> first `.xp-pill-value` (the "XP On Hand"
    // counter, which is the first .xp-pill in the topbar group).
    if (kill.xpGained > 0) {
      const xpTarget = document.querySelector<HTMLElement>(
        ".board-topbar-xp .xp-pill .xp-pill-value",
      );
      if (xpTarget) {
        spawnFlyToken({
          kind: "xp",
          fromX: seed.fromX,
          fromY: seed.fromY,
          target: xpTarget,
          html: `+${kill.xpGained} XP`,
        });
      }
    }

    // --- Element fly: dedupe by element, prefer the first delver
    // whose grant actually landed (avoid empty animation for a
    // grant that overflowed the per-delver cap of 2).
    const seenElements = new Set<string>();
    for (const grant of kill.elementGrants) {
      if (!grant.granted) continue;
      if (seenElements.has(grant.element)) continue;
      seenElements.add(grant.element);
      const hero = getHero(grant.heroId);
      const slotEl = document.querySelector<HTMLElement>(
        `.suit-panel--${hero.suit} .suit-slot--el-${grant.element}`,
      );
      if (!slotEl) continue;
      const iconFile = ELEMENT_IMAGE[grant.element as Element];
      spawnFlyToken({
        kind: "element",
        fromX: seed.fromX,
        fromY: seed.fromY,
        target: slotEl,
        html: `<img src="/tokens/${iconFile}" alt="" draggable="false" />`,
      });
    }
  }
}

interface FlyTokenOpts {
  kind: "xp" | "element";
  fromX: number;
  fromY: number;
  target: HTMLElement;
  /** Inline HTML for the token body (text for XP, <img> for element). */
  html: string;
}

/**
 * Append a fly token to `<body>`, position it at `from`, then
 * trigger a CSS transition to the target's center on the next
 * frame. Self-removes once the transition resolves (or after a
 * conservative 1500ms timeout in case `transitionend` doesn't
 * fire -- e.g. the user navigated away).
 */
function spawnFlyToken(opts: FlyTokenOpts): void {
  const el = document.createElement("div");
  el.className = `fly-token fly-token--${opts.kind}`;
  el.innerHTML = opts.html;
  el.style.left = `${opts.fromX}px`;
  el.style.top = `${opts.fromY}px`;
  document.body.appendChild(el);

  // Two rAFs: the first commits the starting position so the
  // browser has a "from" frame; the second changes left/top so
  // the CSS transition runs from the committed start state to
  // the target state. Without the double rAF the browser
  // sometimes collapses both writes into a single layout pass
  // and the transition never animates.
  const targetRect = opts.target.getBoundingClientRect();
  const toX = targetRect.left + targetRect.width / 2;
  const toY = targetRect.top + targetRect.height / 2;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.style.left = `${toX}px`;
      el.style.top = `${toY}px`;
      el.classList.add("fly-token--travelling");
    });
  });

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    el.remove();
  };
  // Fire cleanup on the SECOND transitionend (the fade-out runs
  // after the position transition). Belt-and-braces timeout
  // guards against orphaned tokens if the user navigates away
  // mid-flight -- the timeout matches the total animation
  // duration (1.0s travel + 0.35s fade) + small buffer.
  el.addEventListener(
    "transitionend",
    (ev) => {
      if (ev.propertyName === "opacity") cleanup();
    },
    { passive: true },
  );
  window.setTimeout(cleanup, 1700);
}

/**
 * Minimal subset of `CSS.escape` we need (digits / letters / dash
 * / underscore are safe; everything else gets backslash-escaped).
 * `CSS.escape` exists in every modern browser but TS lib targets
 * sometimes lag behind, so this keeps the call site dependency-
 * free.
 */
function cssEscape(value: string): string {
  if (typeof window !== "undefined" && (window as { CSS?: { escape?: (s: string) => string } }).CSS?.escape) {
    return (window as unknown as { CSS: { escape: (s: string) => string } }).CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}
