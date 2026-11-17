/**
 * Fly creature-part token images from a source screen position to the
 * topbar wallet pill (minion or boss).
 *
 * Each token is an absolutely-positioned <img> that transitions to the
 * wallet's center and fades out on arrival. Tokens are staggered so they
 * look like a stream rather than a single burst. A brief "bump" scale pop
 * on the wallet pill punctuates the arrival.
 *
 * Usage — from a board tile:
 *   flyTilePickupsToWallet(result.to.x, result.to.y, minionCount, bossCount, suit);
 *
 * Usage — from a DOM element (e.g. the die result box):
 *   flyFromElementToWallet(dieEl, count, "minion", iconSrc);
 */

import { cellCenterPct } from "../board/tideBoard";

export type PartKind = "minion" | "boss";

const FLY_MS = 480;
const STAGGER_MS = 75;

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Fly all creature-part pickups from the center of board tile (tileX, tileY)
 * to the matching topbar wallet pill(s). Fire-and-forget.
 *
 * @param tileX      - board column (0-based x)
 * @param tileY      - board row    (0-based y)
 * @param minionCount - number of minion-part tokens picked up
 * @param bossCount   - number of boss-part tokens picked up
 * @param suit        - the viewed delver's suit (selects the token icon color)
 */
export function flyTilePickupsToWallet(
  tileX: number,
  tileY: number,
  minionCount: number,
  bossCount: number,
  suit: "mind" | "body",
): void {
  const src = tileCenterFixed(tileX, tileY);
  if (!src) return;
  if (minionCount > 0) {
    const icon = suit === "mind" ? "/tokens/minion-mind.webp" : "/tokens/minion-body.webp";
    flyFromPoint(src, minionCount, "minion", icon);
  }
  if (bossCount > 0) {
    const icon = suit === "mind" ? "/tokens/boss-lvl-1-mind.webp" : "/tokens/boss-lvl-1-body.webp";
    flyFromPoint(src, bossCount, "boss", icon);
  }
}

/**
 * Fly `count` token images from the center of `sourceEl` to the topbar
 * wallet for `kind`. Returns a Promise that resolves once all tokens have
 * arrived (caller can await before updating wallet state, or fire-and-forget).
 */
export async function flyFromElementToWallet(
  sourceEl: HTMLElement | null,
  count: number,
  kind: PartKind,
  iconSrc: string,
): Promise<void> {
  if (!sourceEl || count <= 0) return;
  const r = sourceEl.getBoundingClientRect();
  const src = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  return flyFromPointAsync(src, count, kind, iconSrc);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function tileCenterFixed(tileX: number, tileY: number): { x: number; y: number } | null {
  const frame = document.querySelector<HTMLElement>("[data-board-frame]");
  if (!frame) return null;
  const rect = frame.getBoundingClientRect();
  try {
    const pct = cellCenterPct(tileX, tileY);
    return {
      x: rect.left + rect.width  * pct.left / 100,
      y: rect.top  + rect.height * pct.top  / 100,
    };
  } catch {
    return null;
  }
}

/** Fire-and-forget wrapper around flyFromPointAsync. */
function flyFromPoint(
  src: { x: number; y: number },
  count: number,
  kind: PartKind,
  iconSrc: string,
): void {
  void flyFromPointAsync(src, count, kind, iconSrc);
}

function flyFromPointAsync(
  src: { x: number; y: number },
  count: number,
  kind: PartKind,
  iconSrc: string,
): Promise<void> {
  const target = document.querySelector<HTMLElement>(`[data-parts-wallet="${kind}"]`);
  if (!target) return Promise.resolve();

  const tgtRect = target.getBoundingClientRect();
  const tgtCx = tgtRect.left + tgtRect.width  / 2;
  const tgtCy = tgtRect.top  + tgtRect.height / 2;

  const flyOne = (delay: number): Promise<void> => new Promise(resolve => {
    window.setTimeout(() => {
      const img = document.createElement("img");
      img.src = iconSrc;
      img.draggable = false;
      img.style.cssText = `
        position:fixed;
        left:${src.x - 16}px;
        top:${src.y - 16}px;
        width:32px; height:32px;
        border-radius:50%;
        pointer-events:none;
        z-index:99999;
        transition:
          left ${FLY_MS}ms cubic-bezier(.3,.8,.3,1),
          top ${FLY_MS}ms cubic-bezier(.3,.8,.3,1),
          transform ${FLY_MS}ms ease,
          opacity ${FLY_MS}ms ease;
      `;
      document.body.appendChild(img);
      void img.offsetWidth; // force layout before transition
      img.style.left      = `${tgtCx - 16}px`;
      img.style.top       = `${tgtCy - 16}px`;
      img.style.transform = "scale(0.5)";
      img.style.opacity   = "0";
      window.setTimeout(() => { img.remove(); resolve(); }, FLY_MS + 60);
    }, delay);
  });

  // Bump the wallet pill once the last token arrives
  const lastArrival = (count - 1) * STAGGER_MS + FLY_MS;
  window.setTimeout(() => bumpWallet(target), lastArrival);

  return Promise.all(
    Array.from({ length: count }, (_, i) => flyOne(i * STAGGER_MS)),
  ).then(() => undefined);
}

function bumpWallet(el: HTMLElement): void {
  el.classList.remove("parts-pill-bump");
  void el.offsetWidth;
  el.classList.add("parts-pill-bump");
  window.setTimeout(() => el.classList.remove("parts-pill-bump"), 500);
}
