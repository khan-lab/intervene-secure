import type { Interval } from "../types";

/**
 * Pure-TypeScript interval sweep — the fallback path for browsers where
 * the bedtools WASM worker fails to initialise, and the differential-test
 * oracle checked against real bedtools on every fixture (PLAN.md §2,
 * Decision A). If this ever disagrees with bedtools, bedtools is right —
 * see lib/pipeline.ts and the differential test in
 * lib/intervals.differential.test.ts.
 *
 * No bedtools calls happen here; everything is plain array/sort logic so
 * it can run synchronously without a WASM worker.
 */

const BED_COMMENT_OR_HEADER = /^(track|browser)\b/;

export function parseBed(text: string): Interval[] {
  const out: Interval[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line[0] === "#" || BED_COMMENT_OR_HEADER.test(line)) continue;
    const fields = line.split(/\t|\s+/);
    if (fields.length < 3) continue;
    const start = Number(fields[1]);
    const end = Number(fields[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    out.push({ chrom: fields[0], start, end });
  }
  return out;
}

/**
 * Sort by chrom then start — no merging. asntech/intervene's own
 * genomic_upset() loads each input file as a raw `BedTool(input_files[i])`
 * with no `.sort()`/`.merge()` call; regions are taken as given. Sorting
 * here is just for deterministic ordering (and matches lib/pipeline.ts's
 * `bedtools sort`, which the WASM path keeps for intersect performance) —
 * overlapping or book-ended intervals within one set are kept separate.
 */
export function sortIntervals(intervals: Interval[]): Interval[] {
  return [...intervals].sort((a, b) => (a.chrom === b.chrom ? a.start - b.start : a.chrom < b.chrom ? -1 : 1));
}

export interface SweepInput {
  id: string;
  /** Sorted, but not merged — may contain overlapping regions. */
  regions: Interval[];
}

export interface SweepSubset {
  mask: number;
  memberIds: string[];
  regions: Interval[];
  nRegions: number;
  nBp: number;
}

interface ChromOverlapIndex {
  starts: number[];
  /** prefixMaxEnd[i] = max(ends[0..i]) — lets a range-max query answer "any interval overlap?" in O(log n). */
  prefixMaxEnd: number[];
}

/**
 * Index a (possibly internally-overlapping) region list per chromosome so
 * `overlapsAny` can correctly answer "does any interval here overlap the
 * query" even when the set's own regions overlap each other — a plain
 * "first end > query.start" binary search only works for pre-merged,
 * non-overlapping input, which we can no longer assume.
 */
function buildChromOverlapIndex(regions: Interval[]): Map<string, ChromOverlapIndex> {
  const byChrom = new Map<string, Interval[]>();
  for (const r of regions) {
    const bucket = byChrom.get(r.chrom);
    if (bucket) bucket.push(r);
    else byChrom.set(r.chrom, [r]);
  }

  const index = new Map<string, ChromOverlapIndex>();
  for (const [chrom, bucket] of byChrom) {
    const sorted = [...bucket].sort((a, b) => a.start - b.start);
    const starts = sorted.map((r) => r.start);
    const prefixMaxEnd: number[] = [];
    let maxEnd = -Infinity;
    for (const r of sorted) {
      maxEnd = Math.max(maxEnd, r.end);
      prefixMaxEnd.push(maxEnd);
    }
    index.set(chrom, { starts, prefixMaxEnd });
  }
  return index;
}

/** Does `region` overlap any interval indexed in `chromIndex`? Correct regardless of overlaps within the indexed set. */
function overlapsAny(region: Interval, chromIndex: Map<string, ChromOverlapIndex>): boolean {
  const idx = chromIndex.get(region.chrom);
  if (!idx || !idx.starts.length) return false;

  // Count of indexed intervals with start < region.end (upper bound binary search).
  let lo = 0;
  let hi = idx.starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (idx.starts[mid] < region.end) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return false;
  // Among those, does the largest end exceed region.start?
  return idx.prefixMaxEnd[lo - 1] > region.start;
}

/**
 * Combinatorial subsets via the same anchor-set truth-table algorithm as
 * lib/pipeline.ts's WASM-bedtools path (a port of asntech/intervene's own
 * genomic_upset()): for every non-empty mask over `sets`, take the
 * lowest-indexed included set's own (raw, unmerged) regions, and keep
 * those overlapping every other included set and none of the excluded
 * sets. This is 1bp-default only — bedtools' -f/-r/-F fraction flags have
 * no equivalent here; non-default overlap modes require the WASM path.
 * `sets.length` must be <= 31.
 */
export function computeSubsets(sets: SweepInput[]): SweepSubset[] {
  if (sets.length < 2) return [];
  if (sets.length > 31) {
    throw new Error("computeSubsets supports at most 31 sets (bitmask overflow)");
  }

  const n = sets.length;
  const chromIndexes = sets.map((s) => buildChromOverlapIndex(s.regions));
  const subsets: SweepSubset[] = [];

  for (let mask = 1; mask < 1 << n; mask++) {
    const includedIndices: number[] = [];
    const excludedIndices: number[] = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) includedIndices.push(i);
      else excludedIndices.push(i);
    }

    const anchorIdx = includedIndices[0];
    const otherIncluded = includedIndices.slice(1);

    const regions = sets[anchorIdx].regions.filter(
      (r) =>
        otherIncluded.every((i) => overlapsAny(r, chromIndexes[i])) &&
        excludedIndices.every((i) => !overlapsAny(r, chromIndexes[i]))
    );
    if (!regions.length) continue;

    subsets.push({
      mask,
      memberIds: includedIndices.map((i) => sets[i].id),
      regions,
      nRegions: regions.length,
      nBp: regions.reduce((bp, r) => bp + (r.end - r.start), 0),
    });
  }

  return subsets.sort((a, b) => b.nRegions - a.nRegions);
}
