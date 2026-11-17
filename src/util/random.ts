/**
 * Tiny RNG helpers. Math.random() is fine for prototype playtest randomness
 * (dice rolls, minion id assignment, etc.) — we don't need cryptographic or
 * seeded determinism for v1.
 */

/** Fisher-Yates shuffle. Mutates and returns the input array. */
export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i] as T;
    arr[i] = arr[j] as T;
    arr[j] = tmp;
  }
  return arr;
}

/** Roll a single d6 (inclusive 1..6). */
export function rollD6(): number {
  return 1 + Math.floor(Math.random() * 6);
}
