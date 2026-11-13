import { describe, expect, it } from "vitest";
import { sortIntervals, parseBed, computeSubsets } from "./intervals";

// Small hand-built edge cases for the sweep algorithm's set arithmetic
// (touching/nested/disjoint intervals) — this is not the statistics
// fixture; the real-data correctness check against native bedtools lives
// in differential.test.ts per CLAUDE.md's "real data in fixtures" rule.

describe("parseBed", () => {
  it("skips headers, comments, and malformed lines", () => {
    const text = ["track name=x", "#comment", "chr1\t100\t200", "chr1\tbad\t200", "chr1\t300\t300"].join("\n");
    expect(parseBed(text)).toEqual([{ chrom: "chr1", start: 100, end: 200 }]);
  });
});

describe("sortIntervals", () => {
  it("sorts by chrom then start without merging overlapping or book-ended intervals", () => {
    // asntech/intervene's own genomic_upset() loads each input file raw
    // (BedTool(input_files[i]), no .sort()/.merge() call) — regions are
    // taken as given, only ordered here for determinism/display.
    const sorted = sortIntervals([
      { chrom: "chr1", start: 400, end: 500 },
      { chrom: "chr1", start: 100, end: 200 },
      { chrom: "chr1", start: 150, end: 250 }, // overlaps the previous — kept separate
      { chrom: "chr2", start: 10, end: 20 },
    ]);
    expect(sorted).toEqual([
      { chrom: "chr1", start: 100, end: 200 },
      { chrom: "chr1", start: 150, end: 250 },
      { chrom: "chr1", start: 400, end: 500 },
      { chrom: "chr2", start: 10, end: 20 },
    ]);
  });
});

describe("computeSubsets", () => {
  it("returns no subsets for fewer than two sets", () => {
    expect(computeSubsets([{ id: "a", regions: [{ chrom: "chr1", start: 0, end: 10 }] }])).toEqual([]);
  });

  it("assigns each anchor-set region to the combination whose overlap/non-overlap pattern it satisfies", () => {
    // Mirrors the anchor-set truth-table algorithm in lib/pipeline.ts
    // (a port of asntech/intervene's genomic_upset()): for a mask, take
    // the lowest-indexed included set's own (unfragmented) merged
    // regions, keep those overlapping every other included set and none
    // of the excluded sets. One locus per combination, on its own
    // chromosome, so each is independently verifiable.
    const a = {
      id: "A",
      regions: [
        { chrom: "chr1", start: 100, end: 200 }, // A,B,C all present
        { chrom: "chr2", start: 1000, end: 1100 }, // A only
        { chrom: "chr4", start: 3000, end: 3100 }, // A,C
        { chrom: "chr6", start: 5000, end: 5100 }, // A,B
      ],
    };
    const b = {
      id: "B",
      regions: [
        { chrom: "chr1", start: 100, end: 200 },
        { chrom: "chr3", start: 2000, end: 2100 }, // B only
        { chrom: "chr5", start: 4000, end: 4100 }, // B,C
        { chrom: "chr6", start: 5000, end: 5100 },
      ],
    };
    const c = {
      id: "C",
      regions: [
        { chrom: "chr1", start: 100, end: 200 },
        { chrom: "chr4", start: 3000, end: 3100 },
        { chrom: "chr5", start: 4000, end: 4100 },
        { chrom: "chr7", start: 6000, end: 6100 }, // C only
      ],
    };
    const subsets = computeSubsets([a, b, c]);
    const byMembers = new Map(subsets.map((s) => [s.memberIds.slice().sort().join(","), s]));

    expect(byMembers.get("A")?.regions).toEqual([{ chrom: "chr2", start: 1000, end: 1100 }]);
    expect(byMembers.get("B")?.regions).toEqual([{ chrom: "chr3", start: 2000, end: 2100 }]);
    expect(byMembers.get("C")?.regions).toEqual([{ chrom: "chr7", start: 6000, end: 6100 }]);
    expect(byMembers.get("A,B")?.regions).toEqual([{ chrom: "chr6", start: 5000, end: 5100 }]);
    expect(byMembers.get("A,C")?.regions).toEqual([{ chrom: "chr4", start: 3000, end: 3100 }]);
    expect(byMembers.get("B,C")?.regions).toEqual([{ chrom: "chr5", start: 4000, end: 4100 }]);
    expect(byMembers.get("A,B,C")?.regions).toEqual([{ chrom: "chr1", start: 100, end: 200 }]);
  });

  it("excludes an anchor region entirely if any part of it overlaps an excluded set (no fragmenting)", () => {
    // A is one big region spanning both a B-overlap and a B-free stretch;
    // since membership is per whole input region, not per base pair,
    // "A only" gets nothing here even though part of A's span doesn't
    // touch B.
    const a = { id: "A", regions: [{ chrom: "chr1", start: 0, end: 1000 }] };
    const b = { id: "B", regions: [{ chrom: "chr1", start: 400, end: 500 }] };
    const subsets = computeSubsets([a, b]);
    const byMembers = new Map(subsets.map((s) => [s.memberIds.slice().sort().join(","), s]));

    expect(byMembers.get("A")).toBeUndefined();
    expect(byMembers.get("A,B")?.regions).toEqual([{ chrom: "chr1", start: 0, end: 1000 }]);
    expect(byMembers.get("B")).toBeUndefined(); // B is fully inside A's span
  });

  it("does not merge a set's own overlapping regions before computing combinations (matches genomic_upset's raw BedTool input)", () => {
    // A has two mutually-overlapping regions on its own; B overlaps only
    // the first. Each of A's raw regions must be evaluated independently
    // against B, not pre-merged into one region that would overlap B
    // either entirely or not at all.
    const a = {
      id: "A",
      regions: [
        { chrom: "chr1", start: 100, end: 300 }, // overlaps B
        { chrom: "chr1", start: 200, end: 400 }, // overlaps the region above, but not B
      ],
    };
    const b = { id: "B", regions: [{ chrom: "chr1", start: 100, end: 150 }] };
    const subsets = computeSubsets([a, b]);
    const byMembers = new Map(subsets.map((s) => [s.memberIds.slice().sort().join(","), s]));

    expect(byMembers.get("A")?.regions).toEqual([{ chrom: "chr1", start: 200, end: 400 }]);
    expect(byMembers.get("A,B")?.regions).toEqual([{ chrom: "chr1", start: 100, end: 300 }]);
  });

  it("rejects more than 31 sets", () => {
    const sets = Array.from({ length: 32 }, (_, i) => ({ id: `s${i}`, regions: [] }));
    expect(() => computeSubsets(sets)).toThrow();
  });
});
