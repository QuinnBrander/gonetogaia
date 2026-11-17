/**
 * Full-catalog audit of every enemy's counter-attack arrow patterns
 * against the printed card scans in `public/cards/enemy_*.jpg`.
 *
 * Background (player report 2026-07-20): Death Cap's extracted
 * counter offsets bore no resemblance to its card — a player
 * standing in the printed UNCOMMON tiles was hit by a COMMON roll.
 * On 2026-07-20 every one of the 32 cards' frame glyphs was decoded
 * from zoomed crops (WHITE arrows = Common, roll 2-5; BLACK arrows =
 * Uncommon, roll 6; N stacked chevrons in a direction cover
 * distances 1..N) and compared against `data/enemies.json`.
 *
 * Four cards were wrong and have been corrected:
 *   - deathcap-004:   entire pattern rebuilt (see quest2.test.ts)
 *   - ophidian-017:   E common was x1, card prints x2
 *   - sporecloud-024: NW3 was in common; card prints NW x3 all black
 *   - sporecloud-026: same NW3 misfile as 024
 *
 * The table below pins the verified state of ALL 32 enemies. If a
 * re-extraction (or hand edit) drifts from the scans, this points
 * straight at the card to re-check.
 */

import { describe, it, expect } from "vitest";

import { getEnemy } from "../data";

type Off = [number, number];
const VERIFIED: Record<string, { common: Off[]; uncommon: Off[] }> = {
  "crystanid-001": {
    common: [[-2,-2], [-1,-1], [1,-1], [1,0], [-1,1], [1,1], [-2,2], [2,2]],
    uncommon: [[0,-2], [0,-1], [-2,0], [-1,0], [0,1], [0,2]],
  },
  "crystanid-002": {
    common: [[0,-2], [2,-2], [0,-1], [1,-1], [-1,0], [0,1], [1,1], [0,2]],
    uncommon: [[-2,-2], [-1,-1], [1,0], [2,0], [-1,1], [-2,2]],
  },
  "crystanid-003": {
    common: [[2,-2], [0,-1], [1,-1], [-2,0], [-1,0], [1,0], [2,0], [-1,1]],
    uncommon: [[-2,-2], [-1,-1], [0,1], [1,1], [2,2]],
  },
  "crystanid-004": {
    common: [[-2,-2], [-1,-1], [0,-1], [-2,0], [-1,0], [1,0], [-1,1], [0,1], [-2,2], [0,2]],
    uncommon: [[2,-2], [1,-1], [1,1]],
  },
  "crystanid-005": {
    common: [[-1,-1], [1,-1], [-2,0], [-1,0], [0,1], [1,1], [0,2], [2,2]],
    uncommon: [[0,-2], [0,-1], [1,0], [2,0], [-1,1]],
  },
  "crystanid-006": {
    common: [[-2,-2], [0,-2], [-1,-1], [0,-1], [-1,1], [0,1], [1,1], [-2,2]],
    uncommon: [[2,-2], [1,-1], [-2,0], [-1,0], [1,0], [2,0]],
  },
  "crystanid-007": {
    common: [[0,-2], [2,-2], [-1,-1], [0,-1], [1,-1], [-1,0], [-1,1], [-2,2]],
    uncommon: [[1,0], [0,1], [1,1], [0,2], [2,2]],
  },
  "soulhunter-001": {
    common: [[2,-2], [0,-1], [1,-1], [-2,0], [-1,0], [-1,1], [1,1], [-2,2], [2,2]],
    uncommon: [[-2,-2], [-1,-1], [1,0], [2,0], [0,1]],
  },
  "venena-008": {
    common: [[1,-1], [-1,0], [1,0], [2,0], [3,0], [-1,1], [0,1], [0,2], [0,3]],
    uncommon: [[-2,-2], [-1,-1], [0,-1], [1,1], [2,2], [3,3]],
  },
  "venena-009": {
    common: [[-1,-1], [-1,0], [1,0], [-1,1], [1,1], [-2,2], [2,2], [-3,3], [3,3]],
    uncommon: [[0,-2], [0,-1], [1,-1], [0,1], [0,2], [0,3]],
  },
  "venena-010": {
    common: [[-1,-1], [0,-1], [-3,0], [-2,0], [-1,0], [0,1], [1,1], [0,2], [0,3]],
    uncommon: [[2,-2], [1,-1], [1,0], [-1,1], [-2,2], [-3,3]],
  },
  "venena-011": {
    common: [[-3,-3], [-2,-2], [0,-2], [-1,-1], [0,-1], [1,-1], [-1,1], [0,1], [-2,2], [-3,3]],
    uncommon: [[-3,0], [-2,0], [-1,0], [1,0], [2,0], [1,1]],
  },
  "venena-012": {
    common: [[0,-3], [0,-2], [0,-1], [1,-1], [-3,0], [-2,0], [-1,0], [1,0], [-1,1]],
    uncommon: [[-3,-3], [-2,-2], [-1,-1], [0,1], [1,1], [2,2]],
  },
  "venena-013": {
    common: [[-3,-3], [3,-3], [-2,-2], [2,-2], [-1,-1], [1,-1], [-1,0], [1,0], [1,1]],
    uncommon: [[0,-3], [0,-2], [0,-1], [-1,1], [0,1], [0,2]],
  },
  "venena-014": {
    common: [[0,-3], [0,-2], [-1,-1], [0,-1], [1,0], [2,0], [3,0], [0,1], [1,1]],
    uncommon: [[3,-3], [2,-2], [1,-1], [-1,0], [-1,1], [-2,2]],
  },
  "goldmonger-002": {
    common: [[-2,-2], [0,-2], [-1,-1], [0,-1], [-1,0], [1,0], [0,1], [1,1], [0,2]],
    uncommon: [[1,-1], [-1,1], [-2,2]],
  },
  "ophidian-015": {
    common: [[-2,-2], [0,-2], [-1,-1], [0,-1], [-1,1], [1,1], [-2,2], [2,2]],
    uncommon: [[2,-2], [1,-1], [-1,0], [1,0], [2,0], [0,1], [0,2]],
  },
  "ophidian-016": {
    common: [[0,-2], [0,-1], [1,0], [2,0], [0,1], [1,1], [0,2], [2,2]],
    uncommon: [[-2,-2], [-1,-1], [1,-1], [-2,0], [-1,0], [-1,1], [-2,2]],
  },
  "ophidian-017": {
    common: [[2,-2], [1,-1], [-2,0], [-1,0], [1,0], [0,1], [0,2], [2,0]],
    uncommon: [[0,-2], [-1,-1], [0,-1], [-1,1], [1,1], [-2,2], [2,2]],
  },
  "ophidian-018": {
    common: [[-2,-2], [2,-2], [-1,-1], [1,-1], [-2,0], [-1,0], [1,1], [2,2]],
    uncommon: [[0,-1], [1,0], [2,0], [-1,1], [0,1], [-2,2], [0,2]],
  },
  "ophidian-019": {
    common: [[2,-2], [1,-1], [1,0], [2,0], [-1,1], [1,1], [-2,2], [2,2]],
    uncommon: [[-2,-2], [0,-2], [-1,-1], [0,-1], [-2,0], [-1,0], [0,1]],
  },
  "ophidian-020": {
    common: [[-2,-2], [-1,-1], [-2,0], [-1,0], [1,0], [2,0], [-1,1], [-2,2]],
    uncommon: [[0,-2], [2,-2], [0,-1], [1,-1], [0,1], [0,2]],
  },
  "ophidian-021": {
    common: [[-2,-2], [0,-2], [-1,-1], [0,-1], [-1,1], [0,1], [1,1], [-2,2], [0,2]],
    uncommon: [[-2,0], [-1,0], [1,0], [2,0]],
  },
  "hundredeyes-003": {
    common: [[-2,-2], [2,-2], [-1,-1], [1,-1], [-2,0], [-1,0], [0,1], [1,1], [0,2], [2,2]],
    uncommon: [[0,-2], [0,-1], [1,0], [2,0], [-1,1]],
  },
  "sporecloud-022": {
    common: [[-3,-3], [-2,-2], [-1,-1], [0,-1], [-1,1], [0,1], [1,1], [-2,2], [0,2], [2,2], [-3,3], [0,3], [3,3]],
    uncommon: [[-3,0], [-2,0], [-1,0], [1,0], [2,0], [3,0]],
  },
  "sporecloud-023": {
    common: [[-3,-3], [0,-3], [3,-3], [-2,-2], [0,-2], [2,-2], [-1,-1], [0,-1], [1,-1], [-3,0], [-2,0], [-1,0], [-1,1]],
    uncommon: [[1,0], [2,0], [3,0], [0,1], [0,2], [0,3]],
  },
  "sporecloud-024": {
    common: [[0,-3], [0,-2], [0,-1], [1,-1], [-3,0], [-2,0], [-1,0], [1,0], [2,0], [3,0], [0,1], [0,2], [0,3]],
    uncommon: [[-2,-2], [-1,-1], [-1,1], [-2,2], [-3,3], [-3,-3]],
  },
  "sporecloud-025": {
    common: [[-3,-3], [0,-3], [3,-3], [-2,-2], [0,-2], [2,-2], [-1,-1], [0,-1], [1,-1], [-1,1], [0,1], [0,2], [0,3]],
    uncommon: [[-3,0], [-2,0], [-1,0], [1,1], [2,2], [3,3]],
  },
  "sporecloud-026": {
    common: [[0,-3], [0,-2], [0,-1], [1,0], [-1,1], [0,1], [1,1], [-2,2], [0,2], [2,2], [-3,3], [0,3], [3,3]],
    uncommon: [[3,-3], [-2,-2], [2,-2], [-1,-1], [1,-1], [-3,-3]],
  },
  "sporecloud-027": {
    common: [[-3,-3], [-2,-2], [-1,-1], [0,-1], [1,0], [2,0], [3,0], [0,1], [1,1], [0,2], [2,2], [0,3], [3,3]],
    uncommon: [[3,-3], [2,-2], [1,-1], [-1,1], [-2,2], [-3,3]],
  },
  "sporecloud-028": {
    common: [[-3,0], [-2,0], [-1,0], [1,0], [2,0], [3,0], [-1,1], [0,1], [1,1], [-2,2], [2,2], [-3,3], [3,3]],
    uncommon: [[0,-3], [3,-3], [0,-2], [2,-2], [0,-1], [1,-1]],
  },
  "deathcap-004": {
    common: [[-1,-1], [-2,-2], [0,-1], [0,-2], [0,-3], [1,-1], [2,-2], [3,-3], [-1,0], [-2,0], [-3,0], [1,0], [2,0], [3,0]],
    uncommon: [[-1,1], [-2,2], [-3,3], [0,1], [1,1], [2,2], [3,3]],
  },
};

const sortKey = (a: Off, b: Off) => a[0] - b[0] || a[1] - b[1];
const toPairs = (offs: readonly { dx: number; dy: number }[]): Off[] =>
  offs.map((o) => [o.dx, o.dy] as Off).sort(sortKey);

describe("enemy counter-attack patterns match the printed cards (full 2026-07-20 audit)", () => {
  it.each(Object.keys(VERIFIED))("%s", (id) => {
    const e = getEnemy(id);
    const v = VERIFIED[id]!;
    expect(toPairs(e.counterCommon)).toEqual([...v.common].sort(sortKey));
    expect(toPairs(e.counterUncommon)).toEqual([...v.uncommon].sort(sortKey));
    // A tile is either white or black on the printed card, never both.
    const common = new Set(v.common.map(([x, y]) => `${x},${y}`));
    for (const [x, y] of v.uncommon) {
      expect(common.has(`${x},${y}`), `${id} overlap at ${x},${y}`).toBe(false);
    }
  });
});
