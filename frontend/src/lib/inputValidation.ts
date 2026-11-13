/**
 * Input checks run on every file before it reaches bedtools (PLAN.md §8,
 * "Validation and safety"). Everything here is pure — no Aioli/WASM, no
 * fetch — so it is unit-tested directly in inputValidation.test.ts against
 * the real ENCODE fixtures and the vendored chrom.sizes files.
 *
 * Two jobs:
 *
 * 1. `normalizeRegionText` turns an uploaded file into clean, tab-separated
 *    BED text that every downstream consumer (lib/pipeline.ts, Pairwise,
 *    Summary, annotation, gene list) reads instead of the raw upload. Valid
 *    BED lines pass through verbatim, all columns intact. Malformed lines
 *    are dropped and reported, never silently. VCF records are converted
 *    to BED4 here, because every consumer parses columns 2–3 as start/end,
 *    which in a VCF are POS and ID.
 *
 * 2. `checkAssembly` / `fittingAssemblies` compare a file's chromosome names
 *    and maximum coordinates against the vendored chrom.sizes files to catch
 *    the most common user error — a file on a different assembly than the
 *    one selected (PLAN.md §8: "detect it heuristically (chromosome length
 *    overflow) and say so"). Overlaps between the user's own sets are still
 *    correct when the assembly is wrong; what breaks is anything that reads
 *    a genome file or reference annotation (Fisher, reldist, Summary, region
 *    annotation, nearest gene), so these are warnings, not rejections.
 */

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_REGIONS = 2_000_000;
/** Assemblies with a vendored `public/refdata/<a>/<a>.chrom.sizes`. Same list as SetRail's Assembly dropdown. */
export const SUPPORTED_ASSEMBLIES = ["hg38", "hg19", "mm10", "mm9"] as const;

export type InputFormat = "bed" | "vcf";
export type ChromSizes = Record<string, number>;

export class InputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputValidationError";
  }
}

export interface SkippedLine {
  /** 1-based line number in the original file. */
  line: number;
  reason: string;
}

export interface NormalizedInput {
  format: InputFormat;
  /** Tab-separated BED, one region per line, trailing newline. */
  bedText: string;
  nRegions: number;
  /** Maximum end coordinate seen per chromosome — all the assembly check needs. */
  extents: Record<string, number>;
  nSkipped: number;
  /** First few skipped lines, for the error/warning message. */
  skippedExamples: SkippedLine[];
  nZeroLength: number;
  nWhitespaceConverted: number;
}

const MAX_SKIPPED_EXAMPLES = 5;
const UINT = /^\d+$/;
const NEG_INT = /^-\d+$/;

export function checkFileSize(bytes: number, max = MAX_FILE_BYTES): string | null {
  if (bytes <= max) return null;
  const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;
  return `is ${mb(bytes)}; the limit is ${mb(max)}. Large files are better handled by the Intervene command-line tool.`;
}

function isHeader(line: string): boolean {
  return line[0] === "#" || line.startsWith("track") || line.startsWith("browser");
}

function looksLikeVcf(lines: string[], fileName?: string): boolean {
  if (fileName && /\.vcf(\.gz)?$/i.test(fileName)) return true;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("##fileformat=VCF") || line.startsWith("#CHROM\tPOS")) return true;
    if (!isHeader(line)) return false; // first data line reached with no VCF header
  }
  return false;
}

/** BED line -> fields or a reason it is invalid. Keeps every column. */
function parseBedLine(line: string): { fields: string[]; converted: boolean } | { reason: string } {
  let fields = line.split("\t");
  let converted = false;
  if (fields.length < 3 && /\s/.test(line)) {
    fields = line.trim().split(/\s+/);
    converted = fields.length >= 3;
  }
  if (fields.length < 3) return { reason: "needs at least 3 columns (chrom, start, end)" };
  const [, start, end] = fields;
  if (NEG_INT.test(start)) return { reason: "start is negative" };
  if (!UINT.test(start) || !UINT.test(end)) return { reason: "start and end must be whole numbers" };
  if (Number(end) < Number(start)) return { reason: "end is before start" };
  return { fields, converted };
}

/** VCF data line -> BED4 fields, using bedtools' own convention: [POS-1, POS-1+len(REF)), or INFO END for symbolic alleles. */
function parseVcfLine(line: string): { fields: string[] } | { reason: string } {
  const cols = line.split("\t");
  if (cols.length < 5) return { reason: "VCF record needs at least 5 columns (CHROM, POS, ID, REF, ALT)" };
  const [chrom, pos, id, ref, alt] = cols;
  if (!UINT.test(pos) || Number(pos) < 1) return { reason: "VCF POS must be a positive whole number" };
  if (!ref) return { reason: "VCF REF is empty" };
  const start = Number(pos) - 1;
  let end = start + ref.length;
  if (alt.startsWith("<")) {
    const m = /(?:^|;)END=(\d+)/.exec(cols[7] ?? "");
    if (m && Number(m[1]) >= start) end = Number(m[1]);
  }
  return { fields: [chrom, String(start), String(end), id || "."] };
}

export function normalizeRegionText(
  text: string,
  opts: { maxRegions?: number; fileName?: string } = {}
): NormalizedInput {
  const maxRegions = opts.maxRegions ?? MAX_REGIONS;
  const lines = text.split(/\r?\n/);
  const format: InputFormat = looksLikeVcf(lines, opts.fileName) ? "vcf" : "bed";

  const out: string[] = [];
  const extents: Record<string, number> = {};
  const skippedExamples: SkippedLine[] = [];
  let nSkipped = 0;
  let nZeroLength = 0;
  let nWhitespaceConverted = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || isHeader(line)) continue;

    const parsed = format === "vcf" ? parseVcfLine(line) : parseBedLine(line);
    if ("reason" in parsed) {
      nSkipped++;
      if (skippedExamples.length < MAX_SKIPPED_EXAMPLES) skippedExamples.push({ line: i + 1, reason: parsed.reason });
      continue;
    }
    if ("converted" in parsed && parsed.converted) nWhitespaceConverted++;

    if (out.length >= maxRegions) {
      throw new InputValidationError(
        `has more than ${maxRegions.toLocaleString("en-US")} regions, the browser limit. Use the Intervene command-line tool for files this large.`
      );
    }

    const { fields } = parsed;
    const chrom = fields[0];
    const start = Number(fields[1]);
    const end = Number(fields[2]);
    if (end === start) nZeroLength++;
    if (!(chrom in extents) || end > extents[chrom]) extents[chrom] = end;
    out.push(fields.join("\t"));
  }

  if (!out.length) {
    const first = skippedExamples[0];
    throw new InputValidationError(
      first ? `has no valid regions (line ${first.line}: ${first.reason}).` : "No regions found — the file is empty or only has header lines."
    );
  }

  return {
    format,
    bedText: out.join("\n") + "\n",
    nRegions: out.length,
    extents,
    nSkipped,
    skippedExamples,
    nZeroLength,
    nWhitespaceConverted,
  };
}

export function parseChromSizes(text: string): ChromSizes {
  const sizes: ChromSizes = {};
  for (const line of text.split(/\r?\n/)) {
    const [chrom, len] = line.split("\t");
    if (chrom && UINT.test(len ?? "")) sizes[chrom] = Number(len);
  }
  return sizes;
}

export interface AssemblyFit {
  /** Chromosomes in the file that the assembly doesn't have. */
  unknownChroms: string[];
  /** Chromosomes where the file has a coordinate past the assembly's chromosome end. */
  overflowChroms: string[];
  /** Most unknown names become known with a "chr" prefix (Ensembl "1" vs UCSC "chr1"). */
  ensemblStyle: boolean;
  fits: boolean;
}

const natural = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

export function checkAssembly(extents: Record<string, number>, sizes: ChromSizes): AssemblyFit {
  const unknownChroms: string[] = [];
  const overflowChroms: string[] = [];
  for (const [chrom, maxEnd] of Object.entries(extents)) {
    const len = sizes[chrom];
    if (len === undefined) unknownChroms.push(chrom);
    else if (maxEnd > len) overflowChroms.push(chrom);
  }
  const ucscName = (c: string) => (c === "MT" ? "chrM" : `chr${c}`);
  const nEnsembl = unknownChroms.filter((c) => !c.startsWith("chr") && sizes[ucscName(c)] !== undefined).length;
  return {
    unknownChroms: unknownChroms.sort(natural),
    overflowChroms: overflowChroms.sort(natural),
    ensemblStyle: nEnsembl > 0 && nEnsembl * 2 >= unknownChroms.length,
    fits: unknownChroms.length === 0 && overflowChroms.length === 0,
  };
}

/** Supported assemblies that a file fits with no unknown chromosomes and no coordinate past a chromosome end. */
export function fittingAssemblies(extents: Record<string, number>, allSizes: Record<string, ChromSizes>): string[] {
  return SUPPORTED_ASSEMBLIES.filter((a) => allSizes[a] && checkAssembly(extents, allSizes[a]).fits);
}
