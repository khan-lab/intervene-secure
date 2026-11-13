import { describe, expect, it } from "vitest";
import { IncompleteBedtoolsOutputError, generateTruthTable, parseIntersectCounts, subsetsFromOverlaps } from "./pipeline";

/**
 * Pure logic behind the subset engine (see pipeline.ts's module docstring
 * for the full rationale): a direct port of asntech/intervene's own
 * genomic_upset() truth-table over all 2^N-1 non-empty set combinations,
 * each row saying which sets a region must overlap (included) and which
 * it must not overlap (excluded). The actual bedtools chaining is exercised
 * against real bedtools in differential.test.ts; this file covers the
 * truth-table generation itself, which has no bedtools dependency.
 */
describe("generateTruthTable", () => {
  it("produces 2^n - 1 rows for n sets", () => {
    expect(generateTruthTable(1)).toHaveLength(1);
    expect(generateTruthTable(3)).toHaveLength(7);
    expect(generateTruthTable(6)).toHaveLength(63);
  });

  it("each row's included/excluded indices match its mask's bits", () => {
    const rows = generateTruthTable(3);
    const row = rows.find((r) => r.mask === 0b101);
    expect(row?.includedIndices).toEqual([0, 2]);
    expect(row?.excludedIndices).toEqual([1]);
  });

  it("included and excluded indices partition 0..n-1 with no overlap, for every row", () => {
    for (const row of generateTruthTable(4)) {
      const all = [...row.includedIndices, ...row.excludedIndices].sort((a, b) => a - b);
      expect(all).toEqual([0, 1, 2, 3]);
      const intersection = row.includedIndices.filter((i) => row.excludedIndices.includes(i));
      expect(intersection).toEqual([]);
    }
  });

  it("masks are unique and cover every integer from 1 to 2^n - 1", () => {
    const rows = generateTruthTable(4);
    const masks = rows.map((r) => r.mask).sort((a, b) => a - b);
    expect(masks).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });

  it("the all-included row (full mask) has no excluded indices", () => {
    const rows = generateTruthTable(3);
    const fullMask = (1 << 3) - 1;
    const row = rows.find((r) => r.mask === fullMask);
    expect(row?.excludedIndices).toEqual([]);
    expect(row?.includedIndices).toEqual([0, 1, 2]);
  });

  it("a single-bit mask has exactly one included index and the rest excluded", () => {
    const rows = generateTruthTable(3);
    const row = rows.find((r) => r.mask === 0b010);
    expect(row?.includedIndices).toEqual([1]);
    expect(row?.excludedIndices).toEqual([0, 2]);
  });
});

describe("parseIntersectCounts", () => {
  it("turns `bedtools intersect -c` output into one 0/1 overlap flag per A region, in order", () => {
    const text = "chr1\t10\t20\tp1\t0\nchr1\t30\t40\tp2\t3\nchr2\t5\t9\tp3\t1\n";
    expect([...parseIntersectCounts(text, 3)]).toEqual([0, 1, 1]);
  });

  it("throws when the line count doesn't match A — a crashed or truncated bedtools run must never pass as 'no overlap'", () => {
    expect(() => parseIntersectCounts("chr1\t10\t20\t0\n", 2)).toThrow(IncompleteBedtoolsOutputError);
    expect(() => parseIntersectCounts("", 1)).toThrow(IncompleteBedtoolsOutputError);
    expect([...parseIntersectCounts("", 0)]).toEqual([]);
  });
});

describe("subsetsFromOverlaps", () => {
  // Three sets; hits[a][b][i] = does region i of set a overlap set b.
  const sets = [
    { id: "A", regions: [{ chrom: "chr1", start: 0, end: 10 }, { chrom: "chr1", start: 20, end: 30 }, { chrom: "chr1", start: 40, end: 45 }] },
    { id: "B", regions: [{ chrom: "chr1", start: 5, end: 25 }, { chrom: "chr1", start: 100, end: 110 }] },
    { id: "C", regions: [{ chrom: "chr1", start: 22, end: 28 }] },
  ];
  const u8 = (...v: number[]) => Uint8Array.from(v);
  const hits = [
    [null, u8(1, 1, 0), u8(0, 1, 0)],
    [u8(1, 0), null, u8(1, 0)],
    [u8(1), u8(1), null],
  ];

  it("assigns each anchor region to the one mask matching its overlap pattern, anchored on the lowest set in the mask", () => {
    const out = subsetsFromOverlaps(sets, hits);
    const byMask = new Map(out.map((s) => [s.mask, s]));
    // A-region 0 overlaps B only -> A∩B (0b011); region 1 overlaps B and C -> A∩B∩C (0b111); region 2 none -> A only.
    expect(byMask.get(0b011)?.regions).toEqual([sets[0].regions[0]]);
    expect(byMask.get(0b111)?.regions).toEqual([sets[0].regions[1]]);
    expect(byMask.get(0b001)?.regions).toEqual([sets[0].regions[2]]);
    // B-regions overlapping A are counted under A's anchor, never again under B (matches the CLI's chain).
    // B-region 1 overlaps nothing -> B only.
    expect(byMask.get(0b010)?.regions).toEqual([sets[1].regions[1]]);
    // B∩C without A: B-region 0 overlaps A, so it is excluded.
    expect(byMask.has(0b110)).toBe(false);
    // C's only region overlaps A -> no C-anchored subset.
    expect(byMask.has(0b100)).toBe(false);
    expect(byMask.get(0b111)?.memberIds).toEqual(["A", "B", "C"]);
  });

  it("drops empty masks and sorts by region count, largest first", () => {
    const out = subsetsFromOverlaps(sets, hits);
    expect(out.every((s) => s.nRegions > 0)).toBe(true);
    expect(out.map((s) => s.nRegions)).toEqual([...out.map((s) => s.nRegions)].sort((a, b) => b - a));
    expect(out.find((s) => s.mask === 0b011)?.nBp).toBe(10);
  });
});
