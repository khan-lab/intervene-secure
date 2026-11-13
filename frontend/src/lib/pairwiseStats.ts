import * as bedtools from "./bedtools";
import type { PipelineSetInput } from "./pipeline";

/**
 * Jaccard/Fisher/Reldist for the Pairwise heatmap's toggle, matching the
 * Intervene CLI's own `intervene pairwise --compute {jaccard,fisher,reldist}`
 * (intervene/modules/pairwise/pairwise.py's `jaccard_of_a`/`fisher_of_a`/
 * `reldist_of_a`), each a real bedtools call per ordered pair.
 *
 * Jaccard used to be derived from the UpSet subsets' base pairs, with no
 * bedtools call. That was only valid while subsets were bp-precise
 * fragments; since subsets became whole regions of each combination's first
 * set (to match the CLI), it over-counted the intersection and could exceed
 * 1 (e.g. 15.6 for MCF7 super-enhancers vs GWAS variants, true value
 * 0.00023). It now runs `bedtools jaccard`, like the CLI.
 *
 * Real output formats below (comment format, column names, bin count/width)
 * were verified against real `bedtools fisher`/`bedtools reldist` runs on
 * real ENCODE fixture data, not assumed — see pairwiseStats.test.ts's
 * fixtures and docs/provenance.md.
 */

const MOUNT_DIR = "/shared/data";

export interface FisherResult {
  twoTailP: number;
  ratio: number;
}

export interface ReldistBin {
  reldist: number;
  count: number;
  total: number;
  fraction: number;
}

export interface ReldistResult {
  bins: ReldistBin[];
  /** Midpoint of the bin where cumulative fraction first reaches 0.5. */
  median: number;
  /** KS test p-value against the uniform-on-[0, range) null bedtools itself documents for reldist (unrelated sets -> uniform reldist). */
  ksP: number;
}

export interface JaccardResult {
  /** Shared base pairs. */
  intersection: number;
  /** Base pairs covered by either set (bedtools merges each set's own overlapping regions). */
  union: number;
  jaccard: number;
  nIntersections: number;
}

export interface GenomeSortedSet {
  id: string;
  sortedPath: string;
}

/**
 * `bedtools fisher` stdout: comment lines (`#...`, including the
 * contingency table) followed by one data row under header
 * `left  right  two-tail  ratio`. We want `two-tail` (matches the CLI's
 * own `fisher_of_a().two_tail`) and `ratio` (odds ratio).
 */
export function parseFisherOutput(stdout: string): FisherResult {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  const headerIdx = lines.findIndex((l) => /^left\s+right\s+two-tail\s+ratio/i.test(l));
  const dataLine = headerIdx >= 0 ? lines[headerIdx + 1] : undefined;
  if (!dataLine) {
    throw new Error("Could not find fisher's exact test data row in bedtools fisher output");
  }
  const cols = dataLine.split(/\s+/);
  const twoTailP = Number(cols[2]);
  // bedtools prints an infinite odds ratio as "inf", and "-nan" when its
  // table degenerates (e.g. ~30 kb regions vs 1-bp variants: overlaps are
  // counted per pair and the "not in -b" column ends up empty).
  const raw = cols[3] ?? "";
  const ratio = /^inf$/i.test(raw) ? Infinity : /^-?nan$/i.test(raw) ? NaN : Number(raw);
  if (!Number.isFinite(twoTailP) || (Number.isNaN(ratio) && !/^-?nan$/i.test(raw))) {
    throw new Error(`Could not parse fisher's exact test values from row: ${dataLine}`);
  }
  return { twoTailP, ratio };
}

/** `bedtools jaccard` stdout: header `intersection  union  jaccard  n_intersections`, then one data row. */
export function parseJaccardOutput(stdout: string): JaccardResult {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim());
  const headerIdx = lines.findIndex((l) => /^intersection\s+union\s+jaccard\s+n_intersections/i.test(l));
  const dataLine = headerIdx >= 0 ? lines[headerIdx + 1] : undefined;
  if (!dataLine) throw new Error("Could not find the data row in bedtools jaccard output");
  const [intersection, union, jaccard, nIntersections] = dataLine.split(/\s+/).map(Number);
  if (![intersection, union, jaccard, nIntersections].every(Number.isFinite)) {
    throw new Error(`Could not parse bedtools jaccard values from row: ${dataLine}`);
  }
  return { intersection, union, jaccard, nIntersections };
}

/**
 * `bedtools reldist` stdout: header `reldist  count  total  fraction`
 * followed by 50 bins, `reldist` = bin lower edge from 0.00 to 0.49 in
 * 0.01 steps (relative distance is symmetric, so bedtools only reports
 * half the [0,1) range).
 */
export function parseReldistOutput(stdout: string): ReldistBin[] {
  const bins: ReldistBin[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim() || /^reldist\s/i.test(line)) continue;
    const [reldistStr, countStr, totalStr, fractionStr] = line.split(/\s+/);
    const reldist = Number(reldistStr);
    const count = Number(countStr);
    const total = Number(totalStr);
    const fraction = Number(fractionStr);
    if (![reldist, count, total, fraction].every(Number.isFinite)) continue;
    bins.push({ reldist, count, total, fraction });
  }
  return bins;
}

/** Weighted median via cumulative fraction: midpoint of the bin where the running total first reaches 0.5. */
export function medianFromReldistBins(bins: ReldistBin[]): number {
  if (!bins.length) return NaN;
  const width = bins.length > 1 ? bins[1].reldist - bins[0].reldist : 0.01;
  let cum = 0;
  for (const bin of bins) {
    cum += bin.fraction;
    if (cum >= 0.5) return bin.reldist + width / 2;
  }
  return bins[bins.length - 1].reldist + width / 2;
}

/**
 * KS test statistic/p-value for the binned reldist distribution against
 * the uniform-on-[0, range) null that bedtools' own docs use to interpret
 * reldist (unrelated sets -> uniform relative distances). `bedtools
 * reldist` only ever gives us this 50-bin summary, never raw per-region
 * values, so we compute the KS statistic directly against the *binned*
 * empirical CDF rather than reconstructing synthetic raw samples (which
 * would introduce a discretization artifact not present in the real
 * data): for each bin's lower edge x_i, compare both the empirical CDF
 * just before that bin (pre-jump) and just after it (post-jump) against
 * the theoretical uniform CDF at x_i, and take the largest absolute
 * difference across all bins as D. p-value via the standard asymptotic
 * Kolmogorov series, p = 2 * sum_{k=1}^{100} (-1)^(k-1) * exp(-2 k^2 N D^2).
 * Cross-checked during development against scipy.stats.kstest on
 * reconstructed raw samples from real data — same qualitative conclusion
 * (reject uniformity), as expected for two related-but-not-identical
 * questions about the same distribution.
 */
export function ksPValueVsUniform(bins: ReldistBin[]): number {
  if (bins.length < 2) return 1;
  const width = bins[1].reldist - bins[0].reldist;
  const range = bins.length * width;
  const n = bins[0].total;

  let cumBefore = 0;
  let d = 0;
  for (const bin of bins) {
    const uniformCdf = bin.reldist / range;
    const cumAfter = cumBefore + bin.fraction;
    d = Math.max(d, Math.abs(cumBefore - uniformCdf), Math.abs(cumAfter - uniformCdf));
    cumBefore = cumAfter;
  }

  let p = 0;
  for (let k = 1; k <= 100; k++) {
    p += (k % 2 === 0 ? -1 : 1) * Math.exp(-2 * k * k * n * d * d);
  }
  return Math.max(0, Math.min(1, 2 * p));
}

/**
 * Mount a chrom.sizes file onto the bedtools virtual filesystem once;
 * returns its mounted path. The mounted filename is keyed by `assembly`
 * (not a fixed name) — mounting a second assembly under the same name
 * would silently overwrite the first assembly's content at that path, so
 * a cache keyed by assembly (as PairwiseHeatmap.tsx/SummaryPlot.tsx both
 * do) would then serve stale genome data after switching back.
 */
export async function mountGenome(assembly: string, chromSizesText: string): Promise<string> {
  const name = `${assembly}.chrom.sizes`;
  await bedtools.mount([{ name, data: chromSizesText }]);
  return `${MOUNT_DIR}/${name}`;
}

/** Fetch (from `public/refdata/<assembly>/<assembly>.chrom.sizes`) and mount an assembly's genome file in one step. */
export async function fetchAndMountGenome(assembly: string): Promise<string> {
  const base = `${window.location.origin}${import.meta.env.BASE_URL}refdata/${assembly}`;
  const res = await fetch(`${base}/${assembly}.chrom.sizes`);
  if (!res.ok) throw new Error(`Could not load ${assembly}.chrom.sizes`);
  return mountGenome(assembly, await res.text());
}

/**
 * Sort one input set with `-g <genome>` — genome-order, not lexicographic.
 * Deliberately separate from lib/pipeline.ts's `sortOne`: verified that
 * plain `bedtools sort` (no `-g`) disagrees with hg38.chrom.sizes' numeric
 * chromosome order (e.g. chr2 vs chr10), which `bedtools fisher -g`
 * requires to match its own genome file's order.
 */
export async function sortForGenome(input: PipelineSetInput, genomePath: string): Promise<GenomeSortedSet> {
  const rawName = `${input.id}.gsort.raw`;
  await bedtools.mount([{ name: rawName, data: await input.file.text() }]);
  const sorted = await bedtools.exec(`bedtools sort -g ${genomePath} -i ${MOUNT_DIR}/${rawName}`);
  const sortedName = `${input.id}.gsorted.bed`;
  await bedtools.mount([{ name: sortedName, data: sorted.stdout }]);
  return { id: input.id, sortedPath: `${MOUNT_DIR}/${sortedName}` };
}

/**
 * `overlapFlags` is the same pre-rendered bedtools flag string as the main
 * pipeline's `overlapFlags` (lib/bedtoolsOptions.ts's resolveOverlapFlags,
 * driven by the "Minimum overlap" dropdown / advanced options field) —
 * `bedtools fisher` accepts the same -f/-F/-r/-s/-S family `bedtools
 * intersect` does, so the same "what counts as an overlap" setting the
 * user picked for the UpSet/Venn subsets applies here too.
 */
export async function computeFisher(
  aPath: string,
  bPath: string,
  genomePath: string,
  overlapFlags = ""
): Promise<FisherResult> {
  const flagPart = overlapFlags ? ` ${overlapFlags}` : "";
  const result = await bedtools.exec(`bedtools fisher -a ${aPath} -b ${bPath} -g ${genomePath}${flagPart}`);
  return parseFisherOutput(result.stdout);
}

export async function computeReldist(aPath: string, bPath: string): Promise<ReldistResult> {
  const result = await bedtools.exec(`bedtools reldist -a ${aPath} -b ${bPath}`);
  const bins = parseReldistOutput(result.stdout);
  return { bins, median: medianFromReldistBins(bins), ksP: ksPValueVsUniform(bins) };
}

/**
 * Sort one set with plain `bedtools sort` (no genome file) for
 * `bedtools jaccard`, which only needs both inputs in the same chromosome
 * order. Unlike sortForGenome, a set whose chromosome names aren't in the
 * selected assembly still works — the CLI's Jaccard needs no genome either.
 */
export async function sortPlain(input: PipelineSetInput): Promise<GenomeSortedSet> {
  const rawName = `${input.id}.jsort.raw`;
  await bedtools.mount([{ name: rawName, data: await input.file.text() }]);
  const sorted = await bedtools.exec(`bedtools sort -i ${MOUNT_DIR}/${rawName}`);
  await bedtools.unmount([rawName]);
  const sortedName = `${input.id}.jsorted.bed`;
  await bedtools.mount([{ name: sortedName, data: sorted.stdout }]);
  return { id: input.id, sortedPath: `${MOUNT_DIR}/${sortedName}` };
}

/**
 * `bedtools jaccard -a A -b B <overlap flags>`, as the CLI's
 * `jaccard_of_a(a, b, u=True, **bedtools_options)`. The CLI's `u=True` adds
 * `-u`, which bedtools jaccard accepts and ignores (verified: identical
 * output), so it is left out. Ordered: with -f/-F/-r the A→B and B→A values
 * differ.
 */
export async function computeJaccard(aPath: string, bPath: string, overlapFlags = ""): Promise<JaccardResult> {
  const flagPart = overlapFlags ? ` ${overlapFlags}` : "";
  const result = await bedtools.exec(`bedtools jaccard -a ${aPath} -b ${bPath}${flagPart}`);
  return parseJaccardOutput(result.stdout);
}
