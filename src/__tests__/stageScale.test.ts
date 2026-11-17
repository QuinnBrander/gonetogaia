/**
 * Unit tests for the fixed-aspect stage scaler.
 *
 * The actual `applyStageScale` / `installStageScaler` side
 * effects (mutating `:root` style + attaching resize listeners)
 * aren't covered here — they touch real DOM globals and are
 * exercised by the running app. What IS worth pinning is the
 * pure arithmetic in `computeStageScale`, because a wrong-axis
 * `Math.min` (e.g. swapping width/height inputs) would silently
 * letterbox the wrong way and we'd only notice when something
 * looked off on a non-standard monitor.
 */

import { describe, expect, it } from "vitest";
import {
  computeStageScale,
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
} from "../layout/stageScale";

describe("computeStageScale", () => {
  it("returns 1 when the viewport matches the design exactly", () => {
    expect(computeStageScale(DESIGN_WIDTH, DESIGN_HEIGHT)).toBe(1);
  });

  it("scales down uniformly on a viewport smaller than design", () => {
    // Half-size: every pixel of design is rendered at 0.5
    // device pixels. Both axes constrain identically (same
    // aspect ratio) so the min picks 0.5.
    expect(computeStageScale(DESIGN_WIDTH / 2, DESIGN_HEIGHT / 2)).toBe(0.5);
  });

  it("scales up on a viewport larger than design", () => {
    // 2x: hi-DPI / 4K monitor. No upper cap — sharper is the point.
    expect(computeStageScale(DESIGN_WIDTH * 2, DESIGN_HEIGHT * 2)).toBe(2);
  });

  it("fits by width when the viewport is NARROWER aspect than design", () => {
    // 4:3 (1600x1200): aspect 1.333 < design 3538/2211 = 1.6
    //   → fit-by-width constrains. scale = 1600 / 3538.
    const scale = computeStageScale(1600, 1200);
    expect(scale).toBeCloseTo(1600 / DESIGN_WIDTH, 6);
    expect(scale).toBeLessThan(1200 / DESIGN_HEIGHT);
  });

  it("fits by height on 16:9 (WIDER aspect than 16:10 design)", () => {
    // 1920x1080: aspect 1.778 > 1.6 → fit-by-height.
    const scale = computeStageScale(1920, 1080);
    expect(scale).toBeCloseTo(1080 / DESIGN_HEIGHT, 6);
    expect(scale).toBeLessThan(1920 / DESIGN_WIDTH);
  });

  it("clamps to width on a viewport with WIDER aspect than design", () => {
    // 21:9 ultrawide (3440x1440):
    //   aspect = 3440 / 1440 ≈ 2.389
    //   Viewport is WIDER aspect than design → fit-by-height
    //   constrains. scale = 1440 / 2211.
    const scale = computeStageScale(3440, 1440);
    expect(scale).toBeCloseTo(1440 / DESIGN_HEIGHT, 6);
    expect(scale).toBeLessThan(3440 / DESIGN_WIDTH);
  });

  it("defaults to 1 on a zero / negative viewport (defensive)", () => {
    expect(computeStageScale(0, 1000)).toBe(1);
    expect(computeStageScale(1000, 0)).toBe(1);
    expect(computeStageScale(-1, -1)).toBe(1);
  });
});
