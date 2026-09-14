/**
 * The crop editor's geometry (D-049): naming ratios, reading Custom, the
 * first framing of an upload, how far it may move, and the saved size.
 */
import { describe, expect, it } from "vitest";
import {
  averageEdgeColour,
  clampPlacement,
  containScale,
  coverScale,
  drawRect,
  frameSize,
  initialPlacement,
  outputSize,
  parseCustomRatio,
  ratioLabel,
  zoomAround,
  zoomLimits,
} from "@/lib/images/crop";

describe("naming a ratio", () => {
  it("reduces pixel sizes to the ratio a person writes", () => {
    expect(ratioLabel(1200, 1500)).toBe("4:5");
    expect(ratioLabel(1000, 1250)).toBe("4:5");
    expect(ratioLabel(1920, 1080)).toBe("16:9");
    expect(ratioLabel(1600, 1600)).toBe("1:1");
  });

  it("handles decimals", () => {
    expect(ratioLabel(1.5, 1)).toBe("3:2");
  });

  it("uses a preset's name when a size is within 1% of it", () => {
    expect(ratioLabel(1601, 2000)).toBe("4:5");
  });

  it("falls back to a decimal against one", () => {
    expect(ratioLabel(1910, 1000)).toBe("1.91:1");
    expect(ratioLabel(1000, 1910)).toBe("1:1.91");
  });
});

describe("reading the Custom fields", () => {
  it("accepts small numbers and pixel sizes alike", () => {
    expect(parseCustomRatio("4", "5")).toMatchObject({ ok: true, label: "4:5" });
    expect(parseCustomRatio("1200", "1500")).toMatchObject({ ok: true, label: "4:5" });
    expect(parseCustomRatio("16", "9")).toMatchObject({ ok: true, label: "16:9" });
  });

  it("refuses blanks, zero, negatives and words", () => {
    expect(parseCustomRatio("", "5").ok).toBe(false);
    expect(parseCustomRatio("0", "5").ok).toBe(false);
    expect(parseCustomRatio("-4", "5").ok).toBe(false);
    expect(parseCustomRatio("four", "5").ok).toBe(false);
  });

  it("refuses shapes more extreme than 10:1 and absurd sizes", () => {
    expect(parseCustomRatio("11", "1").ok).toBe(false);
    expect(parseCustomRatio("1", "11").ok).toBe(false);
    expect(parseCustomRatio("200000", "200000").ok).toBe(false);
  });
});

describe("the saved frame", () => {
  it("is 1600 × 2000 for the 4:5 standard", () => {
    expect(frameSize({ width: 4, height: 5 })).toEqual({ width: 1600, height: 2000 });
  });

  it("puts the long edge at 2000 for other shapes", () => {
    expect(frameSize({ width: 16, height: 9 })).toEqual({ width: 2000, height: 1125 });
    expect(frameSize({ width: 1, height: 1 })).toEqual({ width: 2000, height: 2000 });
  });
});

describe("first framing", () => {
  const frame = { width: 1600, height: 2000 };

  it("fills the frame when the photograph is nearly its shape", () => {
    const source = { width: 3000, height: 3600 };
    expect(initialPlacement(source, frame).scale).toBeCloseTo(coverScale(source, frame));
  });

  it("shows the whole of a landscape photograph rather than cutting the product", () => {
    const source = { width: 4000, height: 2250 };
    const placement = initialPlacement(source, frame);
    expect(placement.scale).toBeCloseTo(containScale(source, frame));
    expect(source.width * placement.scale).toBeLessThanOrEqual(frame.width + 0.001);
  });

  it("shows the whole of a tall portrait photograph too", () => {
    const source = { width: 2000, height: 4000 };
    const placement = initialPlacement(source, frame);
    expect(source.height * placement.scale).toBeLessThanOrEqual(frame.height + 0.001);
  });

  it("centres a square photograph", () => {
    expect(initialPlacement({ width: 3000, height: 3000 }, frame)).toMatchObject({ x: 0, y: 0 });
  });
});

describe("moving and zooming", () => {
  const frame = { width: 1600, height: 2000 };
  const source = { width: 3200, height: 4000 };

  it("never drags a covering image far enough to open a gap", () => {
    const scale = coverScale(source, frame);
    const placement = clampPlacement({ scale, x: 5000, y: -5000 }, source, frame);
    expect(placement.x).toBeCloseTo(0);
    expect(placement.y).toBeCloseTo(0);
  });

  it("lets a smaller image move only within the frame", () => {
    const scale = containScale({ width: 4000, height: 2000 }, frame);
    const placement = clampPlacement(
      { scale, x: 0, y: 99_999 },
      { width: 4000, height: 2000 },
      frame,
    );
    expect(placement.y).toBeCloseTo((frame.height - 2000 * scale) / 2);
  });

  it("keeps zoom within its limits", () => {
    const { min, max } = zoomLimits(source, frame);
    expect(clampPlacement({ scale: 0.0001, x: 0, y: 0 }, source, frame).scale).toBe(min);
    expect(clampPlacement({ scale: 99, x: 0, y: 0 }, source, frame).scale).toBe(max);
  });

  it("keeps the point under the cursor still while zooming", () => {
    const start = { scale: coverScale(source, frame), x: 0, y: 0 };
    const point = { x: 200, y: 300 };
    const next = zoomAround(start, start.scale * 2, point, source, frame);
    // The point was 200 right of the centre, and stays put: the image moves away.
    expect(next.x).toBeCloseTo(point.x + (0 - point.x) * 2);
    expect(next.y).toBeCloseTo(point.y + (0 - point.y) * 2);
  });
});

describe("drawing and saving", () => {
  const frame = { width: 1600, height: 2000 };

  it("draws a covering image across the whole output, undistorted", () => {
    const source = { width: 3200, height: 4000 };
    const placement = initialPlacement(source, frame);
    const rect = drawRect(source, frame, placement, 400);
    expect(rect.x).toBeCloseTo(0);
    expect(rect.y).toBeCloseTo(0);
    expect(rect.width / rect.height).toBeCloseTo(source.width / source.height);
  });

  it("saves at 1600 × 2000 when the original is large enough", () => {
    const source = { width: 3200, height: 4000 };
    expect(outputSize(frame, initialPlacement(source, frame))).toEqual(frame);
  });

  it("does not enlarge a small original", () => {
    const source = { width: 800, height: 1000 };
    const placement = initialPlacement(source, frame);
    expect(outputSize(frame, placement)).toEqual({ width: 800, height: 1000 });
  });
});

describe("the colour around the edge", () => {
  function solid(width: number, height: number, rgba: [number, number, number, number]) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
    return data;
  }

  it("reads a plain studio ground", () => {
    expect(averageEdgeColour(solid(8, 8, [240, 240, 240, 255]), 8, 8)).toBe("#f0f0f0");
  });

  it("treats a transparent edge as white", () => {
    expect(averageEdgeColour(solid(8, 8, [0, 0, 0, 0]), 8, 8)).toBe("#ffffff");
  });
});
