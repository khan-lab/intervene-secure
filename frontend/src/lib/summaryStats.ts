import * as bedtools from "./bedtools";

/**
 * `bedtools summary` support for the Summary tab (per-set, descriptive
 * interval statistics — see docs/methods.md, which notes this module has
 * no null model, unlike pairwiseStats.ts's Fisher/Reldist). Reference:
 * https://bedtools.readthedocs.io/en/latest/content/tools/summary.html
 *
 * Real output format below (column order, the descending-chrom_length row
 * order, the -1 empty-chromosome sentinel, and an inconsistent trailing
 * tab on per-chromosome rows with intervals) was verified against a real
 * `bedtools summary -i -g` run on a real ENCODE fixture, not assumed from
 * the docs — see summaryStats.test.ts's fixture.
 */

const MOUNT_DIR = "/shared/data";

export interface SummaryRow {
  chrom: string;
  chromLength: number;
  numIvls: number;
  totalIvlBp: number;
  chromFracGenome: number;
  fracAllIvls: number;
  fracAllBp: number;
  /** -1 when the chromosome has zero intervals. */
  min: number;
  max: number;
  mean: number;
}

/** Only the "real" chromosomes, not alt/random/Un scaffolds — matches all four vendored assemblies (hg38, hg19, mm10, mm9). */
const CANONICAL_CHROM_RE = /^chr([0-9]+|[XYM])$/;

/**
 * `bedtools summary` stdout: header row, then one row per chromosome *in
 * the genome file* (in descending chrom_length order, not chromosome
 * number order), then a final `chrom === "all"` aggregate row. Per-row
 * field count is inconsistent — rows with `num_ivls > 0` have an extra
 * trailing tab (11 fields when split on \t) that zero-interval rows and
 * the final "all" row don't, so we always take just the first 10 fields
 * rather than relying on a fixed split length.
 */
export function parseSummaryOutput(stdout: string): SummaryRow[] {
  const rows: SummaryRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("chrom\t")) continue;
    const fields = line.split("\t").slice(0, 10);
    if (fields.length < 10) continue;
    const [chrom, chromLength, numIvls, totalIvlBp, chromFracGenome, fracAllIvls, fracAllBp, min, max, mean] = fields;
    rows.push({
      chrom,
      chromLength: Number(chromLength),
      numIvls: Number(numIvls),
      totalIvlBp: Number(totalIvlBp),
      chromFracGenome: Number(chromFracGenome),
      fracAllIvls: Number(fracAllIvls),
      fracAllBp: Number(fracAllBp),
      min: Number(min),
      max: Number(max),
      mean: Number(mean),
    });
  }
  return rows;
}

export function filterCanonicalChromosomes(rows: SummaryRow[]): SummaryRow[] {
  return rows.filter((r) => CANONICAL_CHROM_RE.test(r.chrom));
}

const CHROM_SORT_SUFFIX_ORDER: Record<string, number> = { X: 1, Y: 2, M: 3 };

/** bedtools' own row order is descending chrom_length, not chromosome number — re-sort to chr1..chr22, chrX, chrY, chrM for a readable chart. */
export function sortChromosomesNaturally(rows: SummaryRow[]): SummaryRow[] {
  const rank = (chrom: string): number => {
    const suffix = chrom.slice(3);
    if (suffix in CHROM_SORT_SUFFIX_ORDER) return 1000 + CHROM_SORT_SUFFIX_ORDER[suffix];
    return Number(suffix);
  };
  return [...rows].sort((a, b) => rank(a.chrom) - rank(b.chrom));
}

export function getAggregateRow(rows: SummaryRow[]): SummaryRow | undefined {
  return rows.find((r) => r.chrom === "all");
}

/** `genomePath` is the same mounted chrom.sizes path `mountGenome` (lib/pairwiseStats.ts) produces for the Pairwise Fisher/Reldist toggle — reused as-is, no second genome-mount helper needed. No sort step is needed first: verified empirically that `bedtools summary` produces identical output on unsorted input. */
export async function computeSummary(rawPath: string, genomePath: string): Promise<SummaryRow[]> {
  const result = await bedtools.exec(`bedtools summary -i ${rawPath} -g ${genomePath}`);
  return parseSummaryOutput(result.stdout);
}

/** Mount a set's raw file text onto the bedtools virtual filesystem for `computeSummary`. */
export async function mountRawForSummary(id: string, text: string): Promise<string> {
  const name = `${id}.summary.raw`;
  await bedtools.mount([{ name, data: text }]);
  return `${MOUNT_DIR}/${name}`;
}
