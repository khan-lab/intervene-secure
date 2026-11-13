import { describe, expect, it } from "vitest";
import { estimateTextWidth, fitCount, truncateToWidth } from "./textMeasure";

describe("estimateTextWidth", () => {
  it("returns 0 for an empty string", () => {
    expect(estimateTextWidth("", 12)).toBe(0);
  });

  it("grows with text length", () => {
    expect(estimateTextWidth("abcdef", 12)).toBeGreaterThan(estimateTextWidth("abc", 12));
  });

  it("grows with font size", () => {
    expect(estimateTextWidth("abc", 20)).toBeGreaterThan(estimateTextWidth("abc", 10));
  });
});

describe("truncateToWidth", () => {
  it("returns the original text unchanged when it already fits", () => {
    const text = "lung";
    expect(truncateToWidth(text, estimateTextWidth(text, 12) + 10, 12)).toBe(text);
  });

  it("trims long text to fit, ending with an ellipsis", () => {
    const text = "heart_h3k27ac_very_long_sample_name";
    const maxWidth = 60;
    const result = truncateToWidth(text, maxWidth, 12);
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBeLessThan(text.length);
    expect(estimateTextWidth(result, 12)).toBeLessThanOrEqual(maxWidth);
  });

  it("trims more aggressively as maxWidth shrinks (monotonic)", () => {
    const text = "heart_h3k27ac_very_long_sample_name";
    const wide = truncateToWidth(text, 80, 12);
    const narrow = truncateToWidth(text, 30, 12);
    expect(narrow.length).toBeLessThanOrEqual(wide.length);
  });

  it("degrades to a bare ellipsis rather than throwing when maxWidth is tiny", () => {
    const result = truncateToWidth("anything", 0.001, 12);
    expect(result).toBe("…");
  });

  it("leaves an already-empty string empty", () => {
    expect(truncateToWidth("", 50, 12)).toBe("");
  });
});

describe("fitCount", () => {
  it("keeps the full, comma-grouped count when it fits", () => {
    expect(fitCount(446, 40, 11)).toBe("446");
    expect(fitCount(298054, 200, 11)).toBe("298,054");
  });

  it("switches to a compact form when the full count is too wide", () => {
    expect(fitCount(1242, 31, 11)).toBe("1.2k");
    expect(fitCount(3626, 31, 11)).toBe("3.6k");
    expect(fitCount(2000, 31, 11)).toBe("2k");
    expect(fitCount(48510, 31, 11)).toBe("49k");
    expect(fitCount(298054, 31, 11)).toBe("298k");
    expect(fitCount(1469205, 31, 11)).toBe("1.5M");
  });
});
