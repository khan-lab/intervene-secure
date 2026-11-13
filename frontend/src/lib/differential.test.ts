import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeSubsets, sortIntervals, parseBed } from "./intervals";
import { generateTruthTable, parseIntersectCounts, subsetsFromOverlaps } from "./pipeline";
import { parseFisherOutput, parseJaccardOutput, parseReldistOutput, medianFromReldistBins, ksPValueVsUniform } from "./pairwiseStats";
import { parseSummaryOutput, filterCanonicalChromosomes, getAggregateRow } from "./summaryStats";
import { ANNO_CATEGORIES, parseClosestDistances } from "./peakAnnotation";
import { parseClosestGeneAssociations } from "./geneList";
import type { Interval } from "../types";

/**
 * Differential test (PLAN.md §2 / §10 Phase 2, extended for the
 * truth-table + pairwise-intersect-chain algorithm — see lib/pipeline.ts's
 * module docstring): compare both the pure-TS fallback (lib/intervals.ts)
 * and the WASM-bedtools primary path's algorithm against native bedtools
 * itself, on the same real ENCODE fixtures used elsewhere in this repo. If
 * bedtools and the TS fallback disagree, bedtools is right (PLAN.md §2,
 * Decision A).
 *
 * This shells out to the system `bedtools` binary (brew-installed on this
 * machine) rather than the vendored WASM build, because vitest runs in
 * Node, not a browser — the WASM path itself is exercised manually / via
 * browser automation. Native and vendored builds are both bedtools 2.31.x;
 * a version note is kept in docs/provenance.md.
 *
 * `nativeTruthTableSubsets` below re-implements the exact chaining
 * lib/pipeline.ts's `computeRowSubset` does against the WASM binary, but
 * shelling out to native bedtools instead — this is ground truth for
 * "what the primary path's algorithm produces," independent of any WASM
 * plumbing bugs.
 */

const FIXTURES_DIR = join(__dirname, "../../../tests/fixtures/encode");
const FIXTURE_FILES = [
  "heart_h3k27ac_ENCFF059ERB.subsample.bed",
  "lung_h3k27ac_ENCFF314QTE.subsample.bed",
  "liver_h3k27ac_ENCFF805YRQ.subsample.bed",
];
const GENOME_FILE = join(__dirname, "../../public/refdata/hg38/hg38.chrom.sizes");

function bedtoolsAvailable(): boolean {
  try {
    execFileSync("bedtools", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

const hasBedtools = bedtoolsAvailable();
const describeIfBedtools = hasBedtools ? describe : describe.skip;

interface NativeSubset {
  mask: number;
  memberIds: string[];
  regions: Interval[];
  nRegions: number;
  nBp: number;
}

function parseBedTextLocal(text: string): Interval[] {
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

/** Native-bedtools ground truth for the truth-table + pairwise intersect chain algorithm. */
function nativeTruthTableSubsets(sortedPaths: string[], ids: string[], dir: string, flags: string[]): NativeSubset[] {
  const truthTable = generateTruthTable(ids.length);
  const subsets: NativeSubset[] = [];
  let step = 0;

  for (const row of truthTable) {
    let currentPath = sortedPaths[row.includedIndices[0]];
    let currentText = "";

    for (const i of row.includedIndices.slice(1)) {
      currentText = execFileSync("bedtools", ["intersect", "-a", currentPath, "-b", sortedPaths[i], "-u", ...flags], {
        encoding: "utf8",
      });
      currentPath = join(dir, `mask${row.mask}_s${step++}.bed`);
      writeFileSync(currentPath, currentText);
    }
    for (const i of row.excludedIndices) {
      currentText = execFileSync("bedtools", ["intersect", "-a", currentPath, "-b", sortedPaths[i], "-v", ...flags], {
        encoding: "utf8",
      });
      currentPath = join(dir, `mask${row.mask}_s${step++}.bed`);
      writeFileSync(currentPath, currentText);
    }

    const regions = parseBedTextLocal(currentText);
    if (!regions.length) continue;
    subsets.push({
      mask: row.mask,
      memberIds: row.includedIndices.map((i) => ids[i]),
      regions,
      nRegions: regions.length,
      nBp: regions.reduce((bp, r) => bp + (r.end - r.start), 0),
    });
  }

  return subsets.sort((a, b) => b.nRegions - a.nRegions);
}

describeIfBedtools("differential test: lib/intervals.ts and lib/pipeline.ts's algorithm vs native bedtools", () => {
  const dir = mkdtempSync(join(tmpdir(), "intervene-diff-"));
  const ids = FIXTURE_FILES.map((f) => f.split("_")[0]); // heart, lung, liver

  // Sort (no merge — regions are taken as given) each real fixture with
  // native bedtools, exactly as lib/pipeline.ts does via the WASM binary.
  const sortedPaths = FIXTURE_FILES.map((file, i) => {
    const raw = readFileSync(join(FIXTURES_DIR, file), "utf8");
    const sorted = execFileSync("bedtools", ["sort", "-i", "/dev/stdin"], { input: raw, encoding: "utf8" });
    const sortedPath = join(dir, `${ids[i]}.sorted.bed`);
    writeFileSync(sortedPath, sorted);
    return sortedPath;
  });

  function summarize(subsets: { mask: number; nRegions: number; nBp: number }[]) {
    return new Map(subsets.map((s) => [s.mask, { nRegions: s.nRegions, nBp: s.nBp }]));
  }

  it("native truth-table ground truth produces at least one non-empty subset with valid intervals", () => {
    const groundTruth = nativeTruthTableSubsets(sortedPaths, ids, dir, []);
    expect(groundTruth.length).toBeGreaterThan(0);
    expect(groundTruth.every((s) => s.nRegions > 0)).toBe(true);
    for (const s of groundTruth) {
      expect(s.regions.every((r) => r.end > r.start)).toBe(true);
    }
  });

  it("lib/intervals.ts's pure-TS anchor-set sweep agrees with native bedtools under the 1bp default", () => {
    const setsInput = sortedPaths.map((path, i) => ({
      id: ids[i],
      regions: sortIntervals(parseBed(readFileSync(path, "utf8"))),
    }));

    const tsSubsets = computeSubsets(setsInput);
    const bedtoolsSubsets = nativeTruthTableSubsets(sortedPaths, ids, dir, []);

    const tsSummary = summarize(tsSubsets);
    const bedtoolsSummary = summarize(bedtoolsSubsets);

    expect(new Set(tsSummary.keys())).toEqual(new Set(bedtoolsSummary.keys()));
    for (const [mask, expected] of bedtoolsSummary) {
      expect(tsSummary.get(mask), `mask ${mask}`).toEqual(expected);
    }
  });

  it("a reciprocal 50% overlap threshold (-f 0.50 -r) never grows the all-sets-included combination", () => {
    // A stricter -f/-r threshold makes "overlap" harder to satisfy. That's
    // strictly monotonic (fewer-or-equal regions survive) only for a mask
    // built entirely from -u (must-overlap) chain steps — i.e. the mask
    // with every set included and none excluded. For any mask with at
    // least one excluded set, a stricter overlap threshold makes the -v
    // (must-NOT-overlap) step *easier* to satisfy, so region counts can
    // go up, not down — this invariant does not hold there, so this test
    // is deliberately scoped to just the all-included mask.
    const fullMask = (1 << ids.length) - 1;
    const defaultSubsets = nativeTruthTableSubsets(sortedPaths, ids, dir, []);
    const reciprocalSubsets = nativeTruthTableSubsets(sortedPaths, ids, dir, ["-f", "0.50", "-r"]);

    const defaultFull = defaultSubsets.find((s) => s.mask === fullMask);
    const reciprocalFull = reciprocalSubsets.find((s) => s.mask === fullMask);

    expect(defaultFull).toBeDefined();
    const reciprocalCount = reciprocalFull?.nRegions ?? 0;
    expect(reciprocalCount).toBeLessThanOrEqual(defaultFull!.nRegions);
    expect(reciprocalCount).toBeLessThan(defaultFull!.nRegions); // real fixtures: threshold should bite at least once
  });
});

/** The pairwise-count algorithm lib/pipeline.ts actually runs: n·(n−1) `intersect -c` calls instead of the chain's (2^n−1)·(n−1). */
function nativePairwiseCountSubsets(sortedPaths: string[], ids: string[], flags: string[]) {
  const sets = sortedPaths.map((p, i) => ({ id: ids[i], regions: parseBedTextLocal(readFileSync(p, "utf8")) }));
  const hits = sortedPaths.map((a, i) =>
    sortedPaths.map((b, j) =>
      i === j
        ? null
        : parseIntersectCounts(execFileSync("bedtools", ["intersect", "-a", a, "-b", b, "-c", ...flags], { encoding: "utf8" }), sets[i].regions.length)
    )
  );
  return subsetsFromOverlaps(sets, hits);
}

describeIfBedtools("differential test: pairwise-count algorithm vs the CLI's intersect chain, native bedtools", () => {
  const dir = mkdtempSync(join(tmpdir(), "intervene-diff-counts-"));
  const sortInto = (raw: string, name: string) => {
    const path = join(dir, name);
    writeFileSync(path, execFileSync("bedtools", ["sort", "-i", "/dev/stdin"], { input: raw, encoding: "utf8" }));
    return path;
  };
  const encodeIds = FIXTURE_FILES.map((f) => f.split("_")[0]);
  const encodePaths = FIXTURE_FILES.map((f, i) => sortInto(readFileSync(join(FIXTURES_DIR, f), "utf8"), `${encodeIds[i]}.sorted.bed`));
  // The 5-set example shipped with the app — exercises all 31 combinations.
  const EXAMPLE_DIR = join(__dirname, "../../public/examples/hg38_ses");
  const exampleIds = ["MCF7", "GM12878", "K562", "HepG2", "H1"];
  const examplePaths = exampleIds.map((id) => sortInto(readFileSync(join(EXAMPLE_DIR, `${id}.bed`), "utf8"), `${id}.sorted.bed`));

  const cases: [string, string[], string[]][] = [
    ["ENCODE fixtures (3 sets)", encodePaths, encodeIds],
    ["hg38 example (5 sets)", examplePaths, exampleIds],
  ];
  const flagSets: [string, string[]][] = [
    ["1 bp", []],
    ["-f 0.50", ["-f", "0.50"]],
    ["-f 0.50 -r", ["-f", "0.50", "-r"]],
  ];

  for (const [label, paths, ids] of cases) {
    for (const [flagLabel, flags] of flagSets) {
      it(`${label}, ${flagLabel}: identical masks and identical regions`, () => {
        const chain = nativeTruthTableSubsets(paths, ids, dir, flags);
        const counts = nativePairwiseCountSubsets(paths, ids, flags);
        expect(counts.map((s) => s.mask)).toEqual(chain.map((s) => s.mask));
        for (const c of chain) {
          const got = counts.find((s) => s.mask === c.mask)!;
          expect(got.memberIds, `mask ${c.mask}`).toEqual(c.memberIds);
          expect(got.regions, `mask ${c.mask}`).toEqual(c.regions);
          expect(got.nBp, `mask ${c.mask}`).toBe(c.nBp);
        }
      });
    }
  }
});

describeIfBedtools("differential test: lib/pairwiseStats.ts parsers vs native bedtools fisher/reldist", () => {
  const dir = mkdtempSync(join(tmpdir(), "intervene-diff-pairwise-"));
  const ids = FIXTURE_FILES.map((f) => f.split("_")[0]); // heart, lung, liver

  // Genome-aware sort (-g), deliberately not lib/pipeline.ts's plain
  // `bedtools sort` — `bedtools fisher -g` requires genome-order input,
  // which is not the same as lexicographic order (e.g. chr2 vs chr10).
  const sortedPaths = FIXTURE_FILES.map((file, i) => {
    const raw = readFileSync(join(FIXTURES_DIR, file), "utf8");
    const sorted = execFileSync("bedtools", ["sort", "-g", GENOME_FILE, "-i", "/dev/stdin"], {
      input: raw,
      encoding: "utf8",
    });
    const sortedPath = join(dir, `${ids[i]}.gsorted.bed`);
    writeFileSync(sortedPath, sorted);
    return sortedPath;
  });

  it("parseFisherOutput correctly parses real native `bedtools fisher -g` stdout", () => {
    const stdout = execFileSync(
      "bedtools",
      ["fisher", "-a", sortedPaths[0], "-b", sortedPaths[1], "-g", GENOME_FILE],
      { encoding: "utf8" }
    );
    // Ground truth pulled directly from the same native stdout being parsed
    // — this is a parser-correctness check against real output shape, not
    // a re-assertion of a hardcoded historical p-value (which would drift
    // if the fixtures or bedtools version ever change).
    const dataLine = stdout
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.startsWith("#"))
      .at(-1)!;
    const [, , expectedTwoTail, expectedRatio] = dataLine.split(/\s+/).map(Number);

    const parsed = parseFisherOutput(stdout);
    expect(parsed.twoTailP).toBe(expectedTwoTail);
    expect(parsed.ratio).toBe(expectedRatio);
    expect(parsed.twoTailP).toBeGreaterThanOrEqual(0);
    expect(parsed.twoTailP).toBeLessThanOrEqual(1);
  });

  it("parseReldistOutput correctly parses real native `bedtools reldist` stdout into 50 bins summing to ~1", () => {
    const stdout = execFileSync("bedtools", ["reldist", "-a", sortedPaths[0], "-b", sortedPaths[1]], {
      encoding: "utf8",
    });
    const bins = parseReldistOutput(stdout);
    expect(bins).toHaveLength(50);
    expect(bins.every((b) => b.total === bins[0].total)).toBe(true);
    const totalFraction = bins.reduce((sum, b) => sum + b.fraction, 0);
    expect(totalFraction).toBeCloseTo(1, 1);

    // medianFromReldistBins/ksPValueVsUniform must run end-to-end on real
    // native output without throwing and produce values in valid ranges —
    // exact numeric parity with the earlier hand/scipy validation is
    // covered by pairwiseStats.test.ts's fixture-based tests.
    const median = medianFromReldistBins(bins);
    expect(median).toBeGreaterThanOrEqual(0);
    expect(median).toBeLessThan(0.5);
    const ksP = ksPValueVsUniform(bins);
    expect(ksP).toBeGreaterThanOrEqual(0);
    expect(ksP).toBeLessThanOrEqual(1);
  });
});

describeIfBedtools("differential test: lib/summaryStats.ts parser vs native bedtools summary", () => {
  it("parseSummaryOutput + filterCanonicalChromosomes agree with real native `bedtools summary -i -g` on the real fixture", () => {
    const raw = readFileSync(join(FIXTURES_DIR, FIXTURE_FILES[0]), "utf8");
    const dir = mkdtempSync(join(tmpdir(), "intervene-diff-summary-"));
    const rawPath = join(dir, "heart.raw.bed");
    writeFileSync(rawPath, raw);

    const stdout = execFileSync("bedtools", ["summary", "-i", rawPath, "-g", GENOME_FILE], { encoding: "utf8" });
    const rows = parseSummaryOutput(stdout);
    const canonical = filterCanonicalChromosomes(rows);
    const all = getAggregateRow(rows);

    // Ground truth pulled directly from the same native stdout being
    // parsed, not a hardcoded historical number (which would drift if the
    // fixture or bedtools version changes) — this checks the parser
    // against real output shape, matching this file's other cases.
    const nativeChr1Line = stdout.split(/\r?\n/).find((l) => l.startsWith("chr1\t"))!;
    const [, chromLength, numIvls, totalIvlBp] = nativeChr1Line.split("\t").map(Number);
    const parsedChr1 = canonical.find((r) => r.chrom === "chr1")!;
    expect(parsedChr1.chromLength).toBe(chromLength);
    expect(parsedChr1.numIvls).toBe(numIvls);
    expect(parsedChr1.totalIvlBp).toBe(totalIvlBp);

    const nativeAllLine = stdout.split(/\r?\n/).filter((l) => l.trim()).at(-1)!;
    const [, , nativeAllNumIvls] = nativeAllLine.split("\t").map(Number);
    expect(all?.chrom).toBe("all");
    expect(all?.numIvls).toBe(nativeAllNumIvls);

    // No alt/random/Un scaffold rows should survive the canonical filter,
    // and every canonical row bedtools printed should be present.
    expect(canonical.every((r) => /^chr([0-9]+|[XYM])$/.test(r.chrom))).toBe(true);
    const nativeCanonicalCount = stdout
      .split(/\r?\n/)
      .filter((l) => /^chr([0-9]+|[XYM])\t/.test(l)).length;
    expect(canonical).toHaveLength(nativeCanonicalCount);
  });
});

describe("differential test: lib/peakAnnotation.ts's classification chain vs native bedtools", () => {
  const ANNO_DIR = join(__dirname, "../../public/refdata/hg38/anno");

  it("classifyPeaks's intersect -u/-v priority chain partitions a real fixture into exactly one category per peak", () => {
    const rawPath = join(FIXTURES_DIR, FIXTURE_FILES[0]);
    const totalPeaks = readFileSync(rawPath, "utf8").split(/\r?\n/).filter((l) => l.trim()).length;

    // Re-implements lib/peakAnnotation.ts's classifyPeaks against native
    // bedtools, since that module depends on the WASM/Aioli runtime
    // (window), not available under vitest's Node environment — same
    // reasoning as nativeTruthTableSubsets above for lib/pipeline.ts.
    let remainingPath = rawPath;
    const counts: Record<string, number> = {};
    let step = 0;
    const dir = mkdtempSync(join(tmpdir(), "intervene-diff-anno-"));

    for (const cat of ANNO_CATEGORIES) {
      if (!cat.file) continue;
      const catPath = join(ANNO_DIR, cat.file);
      const hits = execFileSync("bedtools", ["intersect", "-u", "-a", remainingPath, "-b", catPath], { encoding: "utf8" });
      counts[cat.key] = hits.split(/\r?\n/).filter((l) => l.trim()).length;

      const remaining = execFileSync("bedtools", ["intersect", "-v", "-a", remainingPath, "-b", catPath], {
        encoding: "utf8",
      });
      remainingPath = join(dir, `remaining_${step++}.bed`);
      writeFileSync(remainingPath, remaining);
    }
    counts.distal_intergenic = readFileSync(remainingPath, "utf8").split(/\r?\n/).filter((l) => l.trim()).length;

    const sumOfCategories = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(sumOfCategories).toBe(totalPeaks);
    // At least one real peak actually landed in a gene-proximal category
    // (not everything fell through to distal intergenic) — a sanity check
    // that the reference BEDs and chain are doing real work, not silently
    // matching nothing.
    expect(counts.distal_intergenic).toBeLessThan(totalPeaks);
    expect(counts.distal_intergenic).toBeGreaterThan(0);
  });

  it("parseClosestDistances agrees with real native `bedtools closest -D b` stdout on a real fixture", () => {
    const rawPath = join(FIXTURES_DIR, FIXTURE_FILES[0]);
    const tssPath = join(ANNO_DIR, "tss_points.bed");
    const stdout = execFileSync("bedtools", ["closest", "-a", rawPath, "-b", tssPath, "-D", "b", "-t", "first"], {
      encoding: "utf8",
    });
    const distances = parseClosestDistances(stdout);
    const totalPeaks = readFileSync(rawPath, "utf8").split(/\r?\n/).filter((l) => l.trim()).length;
    expect(distances).toHaveLength(totalPeaks);
    expect(distances.every(Number.isFinite)).toBe(true);
  });
});

describe("differential test: lib/geneList.ts's parser vs native bedtools closest -d -t all", () => {
  it("parseClosestGeneAssociations agrees with real native bedtools output, including real ties, on a real fixture", () => {
    const rawPath = join(FIXTURES_DIR, FIXTURE_FILES[0]);
    const genesPath = join(__dirname, "../../public/refdata/hg38/genes_tss.bed");
    const stdout = execFileSync("bedtools", ["closest", "-d", "-t", "all", "-a", rawPath, "-b", genesPath], {
      encoding: "utf8",
    });
    const associations = parseClosestGeneAssociations(stdout);

    const nativeLines = stdout.split(/\r?\n/).filter((l) => l.trim());
    expect(associations).toHaveLength(nativeLines.length);
    expect(associations.every((a) => Number.isFinite(a.distance) && a.distance >= 0)).toBe(true);
    expect(associations.every((a) => a.geneName.length > 0)).toBe(true);

    // A real region has more than one output line specifically because
    // bedtools found a genuine tie (-t all) — confirms ties survive the
    // parser rather than being silently collapsed to one.
    const byRegion = new Map<string, number>();
    for (const a of associations) {
      const key = `${a.region.chrom}:${a.region.start}-${a.region.end}`;
      byRegion.set(key, (byRegion.get(key) ?? 0) + 1);
    }
    expect([...byRegion.values()].some((count) => count > 1)).toBe(true);
  });
});

describeIfBedtools("differential test: Jaccard via native bedtools jaccard (as the CLI's `intervene pairwise --compute jaccard`)", () => {
  const dir = mkdtempSync(join(tmpdir(), "intervene-diff-jaccard-"));
  const sortInto = (raw: string, name: string) => {
    const path = join(dir, name);
    writeFileSync(path, execFileSync("bedtools", ["sort", "-i", "/dev/stdin"], { input: raw, encoding: "utf8", maxBuffer: 1 << 30 }));
    return path;
  };
  const jaccard = (a: string, b: string, flags: string[] = []) =>
    parseJaccardOutput(execFileSync("bedtools", ["jaccard", "-a", a, "-b", b, ...flags], { encoding: "utf8" }));
  const heart = sortInto(readFileSync(join(FIXTURES_DIR, FIXTURE_FILES[0]), "utf8"), "heart.bed");
  const lung = sortInto(readFileSync(join(FIXTURES_DIR, FIXTURE_FILES[1]), "utf8"), "lung.bed");
  const PUBLIC = join(__dirname, "../../public");
  const mcf7Raw = readFileSync(join(PUBLIC, "examples/hg38_ses/MCF7.bed"), "utf8");
  const gwasRaw = readFileSync(join(PUBLIC, "refdata/hg38/external/gwas_catalog.bed"), "utf8");
  const mcf7 = sortInto(mcf7Raw, "mcf7.bed");
  const gwas = sortInto(gwasRaw, "gwas.bed");

  it("parses real native output, and Jaccard = intersection / union, within [0, 1]", () => {
    for (const flags of [[], ["-f", "0.50"], ["-f", "0.50", "-r"]]) {
      const j = jaccard(heart, lung, flags);
      expect(j.jaccard).toBeGreaterThanOrEqual(0);
      expect(j.jaccard).toBeLessThanOrEqual(1);
      expect(j.jaccard).toBeCloseTo(j.intersection / j.union, 6);
    }
  });

  it("is exactly 1 for a set against itself even when the set's own regions overlap (ClinVar)", () => {
    const clinvar = sortInto(readFileSync(join(PUBLIC, "refdata/hg38/external/clinvar_pathogenic.bed"), "utf8"), "clinvar.bed");
    expect(jaccard(clinvar, clinvar).jaccard).toBe(1);
  });

  it("regression: MCF7 super-enhancers vs GWAS variants — the old subset-derived formula exceeds 1, bedtools jaccard does not", () => {
    // The old Pairwise view summed bp of subsets containing both sets. Subsets
    // hold whole anchor-set regions, so a 20 kb super-enhancer touching one
    // 1-bp SNP counted 20 kb as shared.
    const sets = [mcf7, gwas].map((p, i) => ({ id: String(i), regions: parseBedTextLocal(readFileSync(p, "utf8")) }));
    const hits = sets.map((a, i) =>
      sets.map((_b, k) =>
        i === k
          ? null
          : parseIntersectCounts(execFileSync("bedtools", ["intersect", "-a", [mcf7, gwas][i], "-b", [mcf7, gwas][k], "-c"], { encoding: "utf8", maxBuffer: 1 << 30 }), a.regions.length)
      )
    );
    const bp = (rs: Interval[]) => rs.reduce((s, r) => s + r.end - r.start, 0);
    const inter = subsetsFromOverlaps(sets, hits)
      .filter((s) => s.memberIds.length === 2)
      .reduce((s, x) => s + x.nBp, 0);
    const oldFormula = inter / (bp(sets[0].regions) + bp(sets[1].regions) - inter);
    expect(oldFormula < 0 || oldFormula > 1).toBe(true);

    const j = jaccard(mcf7, gwas);
    expect(j.jaccard).toBeGreaterThan(0);
    expect(j.jaccard).toBeLessThan(0.001);
    expect(j.jaccard).toBeCloseTo(j.intersection / j.union, 6);
  });
});
