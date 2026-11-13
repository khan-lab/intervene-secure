import { describe, expect, it } from "vitest";
import { MAX_SETS, PALETTE } from "./types";

describe("set palette", () => {
  it("allows 8 sets", () => {
    expect(MAX_SETS).toBe(8);
  });

  it("has a distinct colour for every set, so colours are never cycled", () => {
    expect(PALETTE.length).toBeGreaterThanOrEqual(MAX_SETS);
    expect(new Set(PALETTE.map((c) => c.toLowerCase())).size).toBe(PALETTE.length);
    for (const c of PALETTE) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("keeps slot 1 blue, so the first set looks the same as before", () => {
    expect(PALETTE[0].toLowerCase()).toBe("#2b6fe0");
  });
});
