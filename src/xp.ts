/**
 * Shared XP / Level helpers.
 *
 * See DESIGN.md §3 for the full rule. Summary:
 *
 *   - There is ONE shared XP pool and ONE shared Level for the party
 *     (rulebook p23 / p24). Both fields live on `CampaignState`.
 *   - Players START each quest at Level 0 with 0 XP on hand.
 *   - XP is SPENT to level up; it is NOT a cumulative threshold.
 *   - Cost to advance from level N-1 to level N is `2N - 1`:
 *
 *         0 -> 1 :  1 XP
 *         1 -> 2 :  3 XP
 *         2 -> 3 :  5 XP
 *         N-1 -> N : 2N - 1 XP
 *
 *   - When the party levels up, EACH player draws 1 Level Up Card
 *     (rulebook p24). The prototype tracks that with
 *     `state.levelUpCardsOwed` (incremented by 1 per level-up).
 */

/** XP cost to advance from `currentLevel` to `currentLevel + 1`. */
export function xpCostForNextLevel(currentLevel: number): number {
  const nextLevel = Math.max(0, currentLevel) + 1;
  return 2 * nextLevel - 1;
}

/** True if the party currently has enough XP on hand to level up once. */
export function canLevelUp(xpOnHand: number, currentLevel: number): boolean {
  return xpOnHand >= xpCostForNextLevel(currentLevel);
}

/** XP still needed to reach the next level (0 if a level-up is ready). */
export function xpToNextLevel(xpOnHand: number, currentLevel: number): number {
  return Math.max(0, xpCostForNextLevel(currentLevel) - xpOnHand);
}

/**
 * Apply as many level-ups as the current XP pool allows. Returns the
 * updated `xpOnHand` / `currentLevel` plus how many level-ups happened
 * (so the caller can bump `levelUpCardsOwed` accordingly per design
 * doc §3.2).
 *
 * Resolves one level-up at a time as the rulebook prescribes (p24).
 */
export function resolvePendingLevelUps(
  xpOnHand: number,
  currentLevel: number,
): { xpOnHand: number; currentLevel: number; levelUps: number } {
  let xp = xpOnHand;
  let lvl = currentLevel;
  let levelUps = 0;
  while (canLevelUp(xp, lvl)) {
    xp -= xpCostForNextLevel(lvl);
    lvl += 1;
    levelUps += 1;
  }
  return { xpOnHand: xp, currentLevel: lvl, levelUps };
}
