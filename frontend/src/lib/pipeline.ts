import * as bedtools from "./bedtools";
import type { Interval } from "../types";
import type { SweepSubset } from "./intervals";

/**
 * Subset computation with real bedtools (PLAN.md §2, Decision A / §10
 * Phase 2), producing exactly what asntech/intervene's own CLI produces
 * (intervene/modules/upset/upset.py::genomic_upset()): for every non-empty
 * combination of sets, the regions of the combination's first set that
 * overlap every other included set (`intersect -u`) and no excluded set
 * (`intersect -v`), with the same overlap flags (`-f`/`-r`/`-F`/`-s`...) on
 * every comparison — see lib/bedtoolsOptions.ts for the flag parsing that
 * mirrors intervene/helpers.py::map_bedtools_options().
 *
 * How it's computed differs from the CLI, for speed. The CLI chains
 * pairwise `-u`/`-v` calls per combination: (2^n−1)·(n−1) bedtools runs,
 * 1,785 for 8 sets, each re-reading both files in full. Instead we run
 * `bedtools intersect -a A -b B -c <flags>` once per ordered pair of sets:
 * n·(n−1) runs, 56 for 8 sets. `-c` reports, for every A region, the number
 * of B regions overlapping it under the same flags, so "count > 0" is
 * exactly what `-u` keeps and "count = 0" is exactly what `-v` keeps. Each
 * region's subset then follows from its yes/no pattern across the other
 * sets (`subsetsFromOverlaps`, plain JS). The result is identical, region
 * for region — verified against the CLI's own chain with native bedtools on
 * real data under 1 bp, `-f 0.50` and `-f 0.50 -r` in differential.test.ts.
 *
 * Per-pair results are cached by (set A, set B, flags), and set files never
 * change once loaded, so adding a set only compares the new set against the
 * others, and including/excluding a set needs no bedtools call at all.
 *
 * `-c` must report exactly one line per A region. `parseIntersectCounts`
 * checks that, so a crashed or truncated bedtools run (e.g. out of
 * WebAssembly memory) is detected and retried on a fresh worker instead of
 * silently reading as "no overlap".
 *
 * lib/intervals.ts is the pure-TS fallback used only if the WASM worker
 * fails to initialise, and only supports the 1bp default overlap mode.
 */

const MOUNT_DIR = "/shared/data";

export interface PipelineSetInput {
  id: string;
  name: string;
  file: File;
  /**
   * Identifies `file`'s content for the caches; defaults to `id`. A set's
   * content changes when the ENCODE blacklist filter is switched on, so
   * the store passes a different key for the filtered version
   * (`contentKey()` in state/store.ts) — both stay cached.
   */
  key?: string;
}

export interface PipelineSetResult {
  id: string;
  /** Sorted, but not merged — regions are taken as given (matches asntech/intervene's own genomic_upset(), which loads each input raw). */
  regions: Interval[];
  nRegions: number;
  nBp: number;
}

export interface PipelineResult {
  sets: PipelineSetResult[];
  subsets: SweepSubset[];
}

export interface PipelineProgress {
  done: number;
  total: number;
  label: string;
}

export interface TruthTableRow {
  mask: number;
  /** Indices (into the ordered set list) that a region must overlap. */
  includedIndices: number[];
  /** Indices that a region must NOT overlap. */
  excludedIndices: number[];
}

export class IncompleteBedtoolsOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompleteBedtoolsOutputError";
  }
}

function sumBp(regions: Interval[]): number {
  let bp = 0;
  for (const r of regions) bp += r.end - r.start;
  return bp;
}

function parseBedText(text: string): Interval[] {
  const out: Interval[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const [chrom, startStr, endStr] = line.split("\t");
    const start = Number(startStr);
    const end = Number(endStr);
    if (!chrom || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push({ chrom, start, end });
  }
  return out;
}

/**
 * All 2^n - 1 non-empty combinations of n sets, matching
 * genomic_upset()'s `itertools.product("01", repeat=N)`. `mask` uses the
 * same bit convention as everywhere else in this codebase (`1 << i`).
 * Kept as the reference definition of the CLI's algorithm (used by the
 * differential test's native ground truth).
 */
export function generateTruthTable(n: number): TruthTableRow[] {
  const rows: TruthTableRow[] = [];
  for (let mask = 1; mask < 1 << n; mask++) {
    const includedIndices: number[] = [];
    const excludedIndices: number[] = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) includedIndices.push(i);
      else excludedIndices.push(i);
    }
    rows.push({ mask, includedIndices, excludedIndices });
  }
  return rows;
}

/**
 * `bedtools intersect -c` output -> one 0/1 "overlaps B" flag per A region,
 * in A's order. Reads only the last column, without splitting whole lines
 * (outputs can be hundreds of thousands of lines). Throws unless there is
 * exactly one line per A region.
 */
export function parseIntersectCounts(text: string, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let i = 0;
  let pos = 0;
  while (pos < text.length) {
    let nl = text.indexOf("\n", pos);
    if (nl === -1) nl = text.length;
    let end = nl;
    if (end > pos && text.charCodeAt(end - 1) === 13) end--; // \r
    if (end > pos) {
      const tab = text.lastIndexOf("\t", end - 1);
      if (tab < pos || i >= expected) {
        throw new IncompleteBedtoolsOutputError(`bedtools returned unexpected output (line ${i + 1} of ${expected})`);
      }
      out[i++] = Number(text.slice(tab + 1, end)) > 0 ? 1 : 0;
    }
    pos = nl + 1;
  }
  if (i !== expected) {
    throw new IncompleteBedtoolsOutputError(`bedtools returned ${i} of ${expected} expected lines`);
  }
  return out;
}

/**
 * The CLI's subsets from per-pair overlap flags. `hits[a][b][i]` = does
 * region i of set a overlap set b (null on the diagonal). A region of set a
 * belongs to the combination anchored on a whose members are a plus every
 * set it overlaps — unless it overlaps a set listed before a, in which case
 * every a-anchored combination excludes it (that set would have to be in
 * the combination, making it the anchor instead), exactly as the CLI's
 * `-v` step does. Subsets come out in truth-table order, then stably sorted
 * by region count, largest first — the same order as the chain.
 */
export function subsetsFromOverlaps(
  sets: { id: string; regions: Interval[] }[],
  hits: (Uint8Array | null)[][]
): SweepSubset[] {
  const n = sets.length;
  const byMask = new Map<number, Interval[]>();
  for (let a = 0; a < n; a++) {
    const regions = sets[a].regions;
    regionLoop: for (let i = 0; i < regions.length; i++) {
      let mask = 1 << a;
      for (let b = 0; b < n; b++) {
        if (b === a || !hits[a][b]![i]) continue;
        if (b < a) continue regionLoop;
        mask |= 1 << b;
      }
      const bucket = byMask.get(mask);
      if (bucket) bucket.push(regions[i]);
      else byMask.set(mask, [regions[i]]);
    }
  }

  const subsets: SweepSubset[] = [];
  for (let mask = 1; mask < 1 << n; mask++) {
    const regions = byMask.get(mask);
    if (!regions) continue;
    const memberIds: string[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) memberIds.push(sets[i].id);
    subsets.push({ mask, memberIds, regions, nRegions: regions.length, nBp: sumBp(regions) });
  }
  return subsets.sort((x, y) => y.nRegions - x.nRegions);
}

// ---- caches (set content is immutable once loaded; ids are never reused) ----

const sortedCache = new Map<string, { text: string; regions: Interval[] }>();
const hitCache = new Map<string, Uint8Array>();
const hitKey = (a: string, b: string, flags: string) => `${a}\u0000${b}\u0000${flags}`;

/** Cache key of a set's (possibly filtered) content: the set id, or the id plus a `~suffix`. */
const keyOf = (s: PipelineSetInput) => s.key ?? s.id;
const belongsTo = (key: string, id: string) => key === id || key.startsWith(`${id}~`);

/** Drop a removed set's cached sorts and overlap results, for every version of its content. */
export function forgetSet(id: string): void {
  for (const key of sortedCache.keys()) if (belongsTo(key, id)) sortedCache.delete(key);
  for (const key of hitCache.keys()) {
    const [a, b] = key.split("\u0000");
    if (belongsTo(a, id) || belongsTo(b, id)) hitCache.delete(key);
  }
}

/**
 * Sort every input with real bedtools (no merge — regions are taken as
 * given), compare every ordered pair with `intersect -c`, and derive every
 * non-empty combination's subset. Runs entirely against the vendored WASM
 * bedtools; nothing is uploaded. `overlapFlags` is a pre-rendered flag
 * string (lib/bedtoolsOptions.ts's resolveOverlapFlags), applied to every
 * comparison like the CLI's `--bedtools-options`.
 */
export async function computeSubsetsViaBedtools(
  inputs: PipelineSetInput[],
  overlapFlags = "",
  onProgress?: (p: PipelineProgress) => void
): Promise<PipelineResult> {
  const toSort = inputs.filter((s) => !sortedCache.has(keyOf(s)));
  const pairs: [PipelineSetInput, PipelineSetInput][] = [];
  if (inputs.length >= 2) {
    for (const a of inputs) for (const b of inputs) if (a !== b && !hitCache.has(hitKey(keyOf(a), keyOf(b), overlapFlags))) pairs.push([a, b]);
  }
  const total = toSort.length + pairs.length;
  let done = 0;
  const report = (label: string) => onProgress?.({ done, total, label });

  if (total > 0) {
    // Fresh WebAssembly heap for every batch of work — see bedtools.reset().
    await bedtools.reset();
    const mounted: string[] = [];
    try {
      for (const input of toSort) {
        report(`Sorting ${input.name}`);
        const rawName = `${keyOf(input)}.raw`;
        await bedtools.mount([{ name: rawName, data: await input.file.text() }]);
        const sorted = await bedtools.exec(`bedtools sort -i ${MOUNT_DIR}/${rawName}`);
        await bedtools.unmount([rawName]);
        sortedCache.set(keyOf(input), { text: sorted.stdout, regions: parseBedText(sorted.stdout) });
        done++;
      }

      const sortedName = (id: string) => `${id}.sorted.bed`;
      const needed = new Set(pairs.flatMap(([a, b]) => [keyOf(a), keyOf(b)]));
      for (const id of needed) {
        await bedtools.mount([{ name: sortedName(id), data: sortedCache.get(id)!.text }]);
        mounted.push(sortedName(id));
      }

      const flagPart = overlapFlags ? ` ${overlapFlags}` : "";
      for (const [a, b] of pairs) {
        report(`Comparing ${a.name} with ${b.name}`);
        const cmd = `bedtools intersect -a ${MOUNT_DIR}/${sortedName(keyOf(a))} -b ${MOUNT_DIR}/${sortedName(keyOf(b))} -c${flagPart}`;
        const expected = sortedCache.get(keyOf(a))!.regions.length;
        let hits: Uint8Array;
        try {
          hits = parseIntersectCounts((await bedtools.exec(cmd)).stdout, expected);
        } catch (err) {
          if (!(err instanceof IncompleteBedtoolsOutputError)) throw err;
          // Most likely the worker ran out of memory mid-batch: retry once on a fresh one.
          await bedtools.reset();
          hits = parseIntersectCounts((await bedtools.exec(cmd)).stdout, expected);
        }
        hitCache.set(hitKey(keyOf(a), keyOf(b), overlapFlags), hits);
        done++;
      }
    } finally {
      await bedtools.unmount(mounted);
    }
  }

  report("Building subsets");
  const sets = inputs.map((s) => {
    const { regions } = sortedCache.get(keyOf(s))!;
    return { id: s.id, regions, nRegions: regions.length, nBp: sumBp(regions) };
  });
  if (sets.length < 2) return { sets, subsets: [] };
  const hits = inputs.map((a) => inputs.map((b) => (a === b ? null : hitCache.get(hitKey(keyOf(a), keyOf(b), overlapFlags))!)));
  return { sets, subsets: subsetsFromOverlaps(sets, hits) };
}

/** Render one subset's regions back to BED text for export. */
export function subsetToBedText(subset: SweepSubset): string {
  return subset.regions.map((r) => `${r.chrom}\t${r.start}\t${r.end}`).join("\n") + (subset.regions.length ? "\n" : "");
}
