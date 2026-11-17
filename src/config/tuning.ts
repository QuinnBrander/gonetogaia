/**
 * Gameplay tuning values.
 *
 * These are *placeholders* informed by the printed delver suit board:
 * "SHOP PRODUCT LIMIT: 6  BASE AP: 3" and the visible HP track (0..21) /
 * movement track (1..6). Other defaults (starting HP, starting movement)
 * need confirmation against the rulebook — flagged below.
 *
 * Edit a single value here rather than scattering numeric literals across
 * the game logic.
 */

export const Tuning = {
  /** Starting current/max HP for a freshly-equipped delver (no passives). */
  startingHp: 6,
  /** Starting movement points per turn. */
  startingMovement: 1,
  /** Base AP regenerated each turn (printed on suit board). */
  baseAp: 3,
  /** Number of printed weapon slots on each suit board. */
  weaponSlotsPerSuit: 6,
  /**
   * Damage value for each printed damage type (DESIGN.md §5.4.1).
   *
   * Matches the LEFT (un-upgraded) diamond on each damage track of the
   * suit board: LIGHT = 1, MEDIUM = 2, HEAVY = 4. Town upgrades
   * advance each cube to its right diamond (LIGHT \u2192 2, MEDIUM \u2192 4,
   * HEAVY \u2192 8); that's out of scope for Quest #1. Once town
   * upgrades come in, this becomes per-Delver state on `DelverLoadout`.
   *
   * Final damage = `card.damageMultiplier * Tuning.damageBase[card.damageType]`.
   * E.g. Ion Cannon Beam (medium, mult 1) = 1 \u00d7 2 = 2 damage.
   */
  damageBase: { light: 1, medium: 2, heavy: 4 } as const,
} as const;
