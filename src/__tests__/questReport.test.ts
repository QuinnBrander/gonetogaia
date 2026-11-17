/**
 * Quest Report ("Into the Tide", Ch3 + Ch4). General rule: the party
 * must attempt at least one Quest before the Town Visit, so the intro
 * page offers only quest cards; "Continue to the Town Visit" lives on
 * the Quest Report page the party returns to after a quest.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { CHAPTER3, CHAPTER4 } from "../data";
import type { TownVisitChapter } from "../types";

const CASES: [string, TownVisitChapter][] = [["ch3", CHAPTER3], ["ch4", CHAPTER4]];

describe.each(CASES)("%s Quest Report", (ch, chapter) => {
  const intro = chapter.pages[`${ch}-quest-report-intro`]!;
  const report = chapter.pages[`${ch}-quest-report`]!;

  it("the intro offers only quest cards, never a way to the Town Visit", () => {
    expect(intro.next).toBeUndefined();
    expect(intro.choices!.length).toBeGreaterThan(0);
    for (const c of intro.choices!) {
      expect(c.decisionKey).toMatch(new RegExp(`^${ch}\\.report\\.q\\d+\\.play$`));
      expect(chapter.pages[c.next]!.startQuest).toBeDefined();
      expect(c.image).toMatch(/^\/quests\/quest-\d+\.jpg$/);
      expect(existsSync(`public${c.image}`), c.image).toBe(true);
    }
  });

  it("the report page (reached only from a quest) has the same quest cards plus Continue", () => {
    const quests = report.choices!.filter((c) => c.decisionKey !== `${ch}.report.done`);
    expect(quests.map((c) => [c.decisionKey, c.image])).toEqual(intro.choices!.map((c) => [c.decisionKey, c.image]));
    expect(report.choices!.some((c) => c.decisionKey === `${ch}.report.done`)).toBe(true);
    // Walk from the chapter start without ever entering a quest: neither
    // the report page nor the Town Visit arrival may be reachable.
    const seen = new Set<string>();
    const stack = [chapter.startPageId];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const p = chapter.pages[id]!;
      if (p.startQuest) continue;
      for (const n of [p.next, ...(p.choices ?? []).map((c) => c.next), ...(p.dieRoll ?? []).map((o) => o.next)]) if (n) stack.push(n);
    }
    expect(seen.has(`${ch}-quest-report-intro`)).toBe(true);
    expect(seen.has(`${ch}-quest-report`)).toBe(false);
    expect(seen.has(`${ch}-arrival`)).toBe(false);
  });
});
