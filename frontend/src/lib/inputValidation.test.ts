import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_FILE_BYTES,
  SUPPORTED_ASSEMBLIES,
  InputValidationError,
  checkAssembly,
  checkFileSize,
  fittingAssemblies,
  normalizeRegionText,
  parseChromSizes,
} from "./inputValidation";

const FIXTURES_DIR = join(__dirname, "../../../tests/fixtures/encode");
const REFDATA_DIR = join(__dirname, "../../public/refdata");

const heart = readFileSync(join(FIXTURES_DIR, "heart_h3k27ac_ENCFF059ERB.subsample.bed"), "utf8");
const chromSizes = Object.fromEntries(
  SUPPORTED_ASSEMBLIES.map((a) => [a, parseChromSizes(readFileSync(join(REFDATA_DIR, a, `${a}.chrom.sizes`), "utf8"))])
);

describe("checkFileSize", () => {
  it("accepts files at the limit and rejects files over it", () => {
    expect(checkFileSize(MAX_FILE_BYTES)).toBeNull();
    expect(checkFileSize(MAX_FILE_BYTES + 1)).toMatch(/100 MB/);
  });
});

describe("normalizeRegionText on a real ENCODE narrowPeak file", () => {
  const out = normalizeRegionText(heart);

  it("keeps every line, verbatim, with nothing skipped", () => {
    expect(out.format).toBe("bed");
    expect(out.nRegions).toBe(2000);
    expect(out.nSkipped).toBe(0);
    expect(out.bedText).toBe(heart.endsWith("\n") ? heart : heart + "\n");
  });

  it("records the maximum end coordinate per chromosome", () => {
    const chr1Ends = heart
      .split("\n")
      .filter((l) => l.startsWith("chr1\t"))
      .map((l) => Number(l.split("\t")[2]));
    expect(out.extents.chr1).toBe(Math.max(...chr1Ends));
    expect(Object.keys(out.extents).sort()).toContain("chrX");
  });
});

describe("normalizeRegionText line handling", () => {
  it("skips headers and comments silently, reports malformed lines with line numbers", () => {
    const text = [
      "track name=peaks",
      "browser position chr1:1-1000",
      "# a comment",
      "chr1\t100\t200",
      "chr1\t300", // too few columns
      "chr1\tabc\t400", // non-integer
      "chr1\t-5\t10", // negative start
      "chr1\t500\t450", // end before start
      "chr2\t10\t20",
      "",
    ].join("\n");
    const out = normalizeRegionText(text);
    expect(out.nRegions).toBe(2);
    expect(out.nSkipped).toBe(4);
    expect(out.skippedExamples.map((s) => s.line)).toEqual([5, 6, 7, 8]);
    expect(out.skippedExamples[0].reason).toMatch(/3 columns/);
    expect(out.bedText).toBe("chr1\t100\t200\nchr2\t10\t20\n");
  });

  it("keeps zero-length intervals (bedtools accepts them) but counts them", () => {
    const out = normalizeRegionText("chr1\t100\t100\nchr1\t200\t300\n");
    expect(out.nRegions).toBe(2);
    expect(out.nZeroLength).toBe(1);
  });

  it("converts space-delimited lines to tabs, since bedtools needs tabs", () => {
    const out = normalizeRegionText("chr1 100 200 peakA\nchr1\t300\t400\n");
    expect(out.bedText).toBe("chr1\t100\t200\tpeakA\nchr1\t300\t400\n");
    expect(out.nWhitespaceConverted).toBe(1);
  });

  it("handles Windows line endings", () => {
    const out = normalizeRegionText("chr1\t100\t200\r\nchr1\t300\t400\r\n");
    expect(out.bedText).toBe("chr1\t100\t200\nchr1\t300\t400\n");
  });

  it("throws when nothing valid is left, naming the first problem", () => {
    expect(() => normalizeRegionText("chr1\tx\ty\n")).toThrow(InputValidationError);
    expect(() => normalizeRegionText("chr1\tx\ty\n")).toThrow(/line 1/);
    expect(() => normalizeRegionText("# only a comment\n")).toThrow(/No regions/);
  });

  it("throws when the region count is over the limit", () => {
    const text = "chr1\t1\t2\nchr1\t3\t4\nchr1\t5\t6\n";
    expect(() => normalizeRegionText(text, { maxRegions: 2 })).toThrow(/more than 2 regions/);
    expect(normalizeRegionText(text, { maxRegions: 3 }).nRegions).toBe(3);
  });
});

describe("normalizeRegionText VCF conversion", () => {
  const vcf = [
    "##fileformat=VCFv4.2",
    "##INFO=<ID=END,Number=1,Type=Integer,Description=\"End position\">",
    "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO",
    "chr1\t1000\trs1\tA\tG\t50\tPASS\t.",
    "chr1\t2000\t.\tACGT\tA\t50\tPASS\t.",
    "chr2\t5000\tsv1\tN\t<DEL>\t50\tPASS\tSVTYPE=DEL;END=5600",
    "",
  ].join("\n");

  it("detects VCF from its header and converts to 0-based half-open BED4", () => {
    const out = normalizeRegionText(vcf);
    expect(out.format).toBe("vcf");
    expect(out.nRegions).toBe(3);
    // SNV: POS 1000 (1-based) -> [999, 1000). Deletion: REF length 4 -> [1999, 2003).
    // Symbolic SV with INFO END -> [4999, 5600).
    expect(out.bedText).toBe("chr1\t999\t1000\trs1\nchr1\t1999\t2003\t.\nchr2\t4999\t5600\tsv1\n");
  });

  it("detects VCF from the file name when the header is missing", () => {
    const out = normalizeRegionText("chr1\t1000\trs1\tA\tG\t50\tPASS\t.\n", { fileName: "calls.vcf" });
    expect(out.format).toBe("vcf");
    expect(out.bedText).toBe("chr1\t999\t1000\trs1\n");
  });
});

describe("assembly checks on a real hg38 file", () => {
  const { extents } = normalizeRegionText(heart);

  it("fits hg38 cleanly", () => {
    const fit = checkAssembly(extents, chromSizes.hg38);
    expect(fit).toEqual({ unknownChroms: [], overflowChroms: [], ensemblStyle: false, fits: true });
  });

  it("overflows hg19 on chromosomes that grew between assemblies", () => {
    const fit = checkAssembly(extents, chromSizes.hg19);
    expect(fit.fits).toBe(false);
    expect(fit.unknownChroms).toEqual([]);
    expect(fit.overflowChroms).toEqual(expect.arrayContaining(["chr5", "chr17", "chr18", "chr20"]));
  });

  it("reports human-only chromosomes as unknown on mouse assemblies", () => {
    const fit = checkAssembly(extents, chromSizes.mm10);
    expect(fit.fits).toBe(false);
    expect(fit.unknownChroms).toEqual(["chr20", "chr21", "chr22"]);
    expect(fit.overflowChroms).toContain("chr1");
  });

  it("detects Ensembl-style names (1, 2, X) against a UCSC-style assembly", () => {
    const ensembl = normalizeRegionText(heart.replace(/^chr/gm, ""));
    const fit = checkAssembly(ensembl.extents, chromSizes.hg38);
    expect(fit.fits).toBe(false);
    expect(fit.ensemblStyle).toBe(true);
  });

  it("lists hg38 as the only supported assembly the file fits", () => {
    expect(fittingAssemblies(extents, chromSizes)).toEqual(["hg38"]);
  });
});

describe("parseChromSizes", () => {
  it("parses the vendored hg38 file", () => {
    expect(chromSizes.hg38.chr1).toBe(248956422);
    expect(chromSizes.hg38.chrM).toBe(16569);
  });
});
