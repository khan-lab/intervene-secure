import { describe, expect, it } from "vitest";
import { parseBedtoolsOptions, presetToOptions, renderBedtoolsFlags, resolveOverlapFlags } from "./bedtoolsOptions";

/**
 * Mirrors asntech/intervene's own `helpers.py::map_bedtools_options()` —
 * a comma-separated `key=value` string (e.g. "f=0.5,r=true") parsed into
 * bedtools intersect flags. Matching that parsing exactly is the point:
 * the "Advanced bedtools options" field is meant to accept the same
 * syntax as the CLI's own `--bedtools-options`.
 */

describe("parseBedtoolsOptions", () => {
  it("parses bare keys as boolean flags", () => {
    expect(parseBedtoolsOptions("s")).toEqual({ s: true });
  });

  it("parses key=value pairs", () => {
    expect(parseBedtoolsOptions("f=0.75")).toEqual({ f: "0.75" });
  });

  it("parses key=true/True as boolean, matching the CLI's own case handling", () => {
    expect(parseBedtoolsOptions("r=true")).toEqual({ r: true });
    expect(parseBedtoolsOptions("r=True")).toEqual({ r: true });
  });

  it("parses multiple comma-separated options in order", () => {
    expect(parseBedtoolsOptions("f=0.75,r=true,s")).toEqual({ f: "0.75", r: true, s: true });
  });

  it("returns an empty object for empty or whitespace-only input", () => {
    expect(parseBedtoolsOptions("")).toEqual({});
    expect(parseBedtoolsOptions("   ")).toEqual({});
  });

  it("trims whitespace around keys and values", () => {
    expect(parseBedtoolsOptions(" f = 0.5 , r=true ")).toEqual({ f: "0.5", r: true });
  });

  it("ignores empty entries from trailing/double commas", () => {
    expect(parseBedtoolsOptions("f=0.5,,r=true,")).toEqual({ f: "0.5", r: true });
  });
});

describe("renderBedtoolsFlags", () => {
  it("renders single-character keys with one dash", () => {
    expect(renderBedtoolsFlags({ f: "0.5" })).toBe("-f 0.5");
  });

  it("renders boolean flags with no value", () => {
    expect(renderBedtoolsFlags({ r: true })).toBe("-r");
  });

  it("renders multi-character keys with two dashes", () => {
    expect(renderBedtoolsFlags({ nonamecheck: true })).toBe("--nonamecheck");
  });

  it("joins multiple flags with a single space, preserving key order", () => {
    expect(renderBedtoolsFlags({ f: "0.5", r: true })).toBe("-f 0.5 -r");
  });

  it("returns an empty string for no options", () => {
    expect(renderBedtoolsFlags({})).toBe("");
  });
});

describe("presetToOptions", () => {
  it("1bp preset (bedtools intersect's own default) carries no extra flags", () => {
    expect(presetToOptions("1bp")).toEqual({});
  });

  it("fraction50 preset maps to -f 0.50", () => {
    expect(presetToOptions("fraction50")).toEqual({ f: "0.50" });
  });

  it("reciprocal50 preset maps to -f 0.50 -r", () => {
    expect(presetToOptions("reciprocal50")).toEqual({ f: "0.50", r: true });
  });
});

describe("resolveOverlapFlags", () => {
  it("uses the preset's flags when the advanced options string is empty", () => {
    expect(resolveOverlapFlags("reciprocal50", "")).toBe("-f 0.50 -r");
    expect(resolveOverlapFlags("1bp", "")).toBe("");
  });

  it("advanced options override the preset entirely when non-empty", () => {
    expect(resolveOverlapFlags("1bp", "f=0.75,s=true")).toBe("-f 0.75 -s");
  });

  it("whitespace-only advanced options falls back to the preset", () => {
    expect(resolveOverlapFlags("fraction50", "   ")).toBe("-f 0.50");
  });
});
