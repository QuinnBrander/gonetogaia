/**
 * Seedable RNG for the QA harness. Mulberry32 — fast, good
 * distribution for jam-scale property testing, and trivially
 * reproducible: given the same `seed`, the same sequence of
 * calls produces the same sequence of numbers.
 *
 * NOT a replacement for the production engine's RNG (which still
 * uses `Math.random`); the QA harness needs determinism so a
 * monkey-mode failure can be replayed bit-for-bit by sharing
 * the seed. Production code stays seedless on purpose — players
 * want fresh randomness every run.
 *
 * Usage:
 *
 *   const rng = mulberry32(42);
 *   rng();                  // 0.xxxxxx
 *   rng();                  // 0.yyyyyy
 *   randInt(rng, 0, 5);     // integer in [0, 5)
 *   pickOne(rng, [a, b, c]); // a|b|c
 *
 * Why not import a seeded RNG library? Mulberry32 is 6 lines.
 * Adding a dependency just for QA RNG would be the worst kind
 * of dependency creep.
 */

/** Returns a seeded RNG (callable like `Math.random`). Mulberry32. */
export function mulberry32(seed: number): () => number {
  // Normalise seed to a 32-bit unsigned int so equivalent seeds
  // produce equivalent sequences even when callers pass a
  // non-integer or negative value (e.g. from Date.now()).
  let a = (seed | 0) >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pick an integer in `[min, max)`. `rng()` is consumed exactly
 * once per call. Throws if `max <= min` — callers should clamp
 * upstream rather than relying on a fallback (consistent with
 * the no-fallbacks rule for the rest of the codebase).
 */
export function randInt(rng: () => number, min: number, max: number): number {
  if (max <= min) {
    throw new Error(`randInt: max (${max}) must be > min (${min})`);
  }
  return min + Math.floor(rng() * (max - min));
}

/**
 * Pick a single element from a non-empty array. Throws on empty
 * input — empty arrays are almost always a logic bug at the
 * call site (an "if (arr.length === 0) skip" check the caller
 * forgot), and a fallback would mask it.
 */
export function pickOne<T>(rng: () => number, arr: readonly T[]): T {
  if (arr.length === 0) {
    throw new Error("pickOne: cannot pick from empty array");
  }
  return arr[randInt(rng, 0, arr.length)]!;
}

/**
 * Coin flip: return `true` with probability `p` (default 0.5).
 * Clamps `p` to [0, 1] so callers can't accidentally request
 * impossible probabilities.
 */
export function coinFlip(rng: () => number, p: number = 0.5): boolean {
  if (p <= 0) return false;
  if (p >= 1) return true;
  return rng() < p;
}

/**
 * Shuffle a copy of `arr` in-place using Fisher-Yates with the
 * supplied seeded RNG. Returns the SAME array (mutated). Pass
 * a slice if you need to preserve the input.
 *
 * Parallel to `util/random.ts > shuffle`; intentionally kept
 * separate so QA scenarios can shuffle deterministically without
 * leaking the seeded RNG into production engine paths.
 */
export function shuffleInPlace<T>(rng: () => number, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(rng, 0, i + 1);
    const tmp = arr[i] as T;
    arr[i] = arr[j] as T;
    arr[j] = tmp;
  }
  return arr;
}
