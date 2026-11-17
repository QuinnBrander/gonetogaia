/**
 * Shared rule constants & helpers.
 *
 * If a rule is referenced in more than one place (data viewer, combat
 * resolver, movement validator, etc.) it lives here so a future change is a
 * one-line edit.
 */

import type { Offset } from "./types";

/**
 * Adjacency = 8-way throughout Gone to Gaia. Both movement and "adjacent
 * enemy" range clauses on cards use this same set of 8 surrounding tiles
 * (orthogonal + diagonal). Confirmed by user 2026-05-02.
 */
export const ADJACENT_OFFSETS_8WAY: readonly Offset[] = [
  { dx: -1, dy: -1 }, { dx: 0, dy: -1 }, { dx: 1, dy: -1 },
  { dx: -1, dy:  0 },                    { dx: 1, dy:  0 },
  { dx: -1, dy:  1 }, { dx: 0, dy:  1 }, { dx: 1, dy:  1 },
];

/** All 8 unit-direction vectors used by ray-style abilities (Beam, etc). */
export const RAY_DIRECTIONS_8WAY: readonly Offset[] = ADJACENT_OFFSETS_8WAY;

/** The 4 orthogonal-only directions, kept around for any rule that ever needs them. */
export const RAY_DIRECTIONS_4WAY: readonly Offset[] = [
  { dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 },
];
