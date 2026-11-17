/**
 * Boss card backs (the between-wave "improve a suit part" step). Every
 * Level 2+ boss that leads a wave after Wave 1 needs a printed back with
 * one suit part per delver, and its image must exist.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BOSS_CARD_BACKS } from "../screens/WavePhases";
import { QUEST_DATA, getEnemy } from "../data";

describe("boss card backs", () => {
  it("cover every Level 2+ boss that leads a later wave", () => {
    for (const quest of QUEST_DATA) {
      for (const wave of quest.waves) {
        if (wave.number === 1) continue;
        const boss = getEnemy(wave.bossEnemyId);
        if (boss.kind === "boss-lvl-1") continue;
        expect(BOSS_CARD_BACKS.some((b) => b.bossEnemyId === wave.bossEnemyId), `${quest.id} wave ${wave.number} ${wave.bossEnemyId}`).toBe(true);
      }
    }
  });

  it("every back's image is on disk and names one part per delver", () => {
    for (const back of BOSS_CARD_BACKS) {
      expect(existsSync(join(__dirname, "../../public", back.image)), back.image).toBe(true);
      expect(back.suitParts).toHaveLength(2);
    }
  });
});
