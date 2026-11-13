import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseIntersectCounts, subsetsFromOverlaps } from "./pipeline";
import { EXTERNAL_ANNOTATIONS } from "./externalAnnotations";
import { buildUniverse, enrichmentCounts, lengthStrata, testableAnnotations, unionEnrichment } from "./subsetEnrichment";
import type { Interval } from "../types";

/**
 * Subset enrichment, input-sets background (docs/methods.md, "Subset
 * enrichment for reference region sets"). Real data: the ENCODE H3K27ac
 * fixtures (heart, lung, liver), their subsets computed with native
 * bedtools exactly as the app computes them, tested against the vendored
 * hg38 CpG islands and VISTA enhancers. Table counts are checked against
 * independent native `bedtools intersect -u` runs, and p-values against
 * R's fisher.test / mantelhaen.test on the same tables.
 */

const iv = (chrom: string, start: number, end: number): Interval => ({ chrom, start, end });

describe("buildUniverse", () => {
  it("concatenates every subset's regions once, remembering which subset each came from", () => {
    const u = buildUniverse([
      { mask: 3, regions: [iv("chr1", 0, 10), iv("chr2", 5, 9)] },
      { mask: 1, regions: [iv("chr1", 100, 150)] },
    ]);
    expect(u.bedText).toBe("chr1\t0\t10\nchr2\t5\t9\nchr1\t100\t150\n");
    expect([...u.owner]).toEqual([3, 3, 1]);
    expect([...u.lengths]).toEqual([10, 4, 50]);
  });
});

describe("lengthStrata", () => {
  it("cuts at the 20/40/60/80th percentiles (inverse ECDF), ties going to the lower stratum", () => {
    // 10 lengths: cut-offs are the 2nd, 4th, 6th, 8th smallest = 2, 4, 6, 8
    expect([...lengthStrata(Int32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))]).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it("never splits equal lengths, so all-equal lengths form one stratum", () => {
    expect(new Set(lengthStrata(Int32Array.from([5, 5, 5, 5, 5, 5]))).size).toBe(1);
  });
});

describe("enrichmentCounts", () => {
  it("builds the 2×2 table for one subset, and per length stratum", () => {
    const owner = Int32Array.from([1, 1, 2, 2, 2, 4]);
    const hits = Uint8Array.from([1, 0, 1, 1, 0, 0]);
    const strata = Uint8Array.from([0, 1, 0, 1, 1, 0]);
    const t = enrichmentCounts(owner, hits, 2, strata);
    expect(t.table).toEqual([2, 1, 1, 2]); // in S hit, in S no hit, rest hit, rest no hit
    expect(t.strata).toEqual([
      [1, 0, 1, 1], // stratum 0: owner 1 hit, owner 2 hit, owner 4 no hit
      [1, 1, 0, 1],
    ]);
  });
});

describe("testableAnnotations", () => {
  it("lists the assembly's reference sets, minus any that is currently an included input set", () => {
    const hg38 = EXTERNAL_ANNOTATIONS.filter((a) => a.assembly === "hg38" && a.path);
    const loaded = [{ fileName: "cpg-islands-hg38.bed", included: true }, { fileName: "vista-enhancers-hg38.bed", included: false }];
    const ids = testableAnnotations("hg38", loaded).map((a) => a.id);
    expect(ids).not.toContain("cpg-islands-hg38");
    expect(ids).toContain("vista-enhancers-hg38"); // loaded but excluded from the analysis: still testable
    expect(ids).toHaveLength(hg38.length - 1);
    expect(testableAnnotations("mm9", []).every((a) => a.assembly === "mm9")).toBe(true);
  });
});

function available(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const hasBedtools = available("bedtools", ["--version"]);
const hasR = available("Rscript", ["--version"]);

describe.skipIf(!hasBedtools)("input-sets enrichment on real ENCODE subsets (native bedtools)", () => {
  const FIXTURES_DIR = join(__dirname, "../../../tests/fixtures/encode");
  const PUBLIC_DIR = join(__dirname, "../../public");
  const files = ["heart_h3k27ac_ENCFF059ERB.subsample.bed", "lung_h3k27ac_ENCFF314QTE.subsample.bed", "liver_h3k27ac_ENCFF805YRQ.subsample.bed"];
  const dir = mkdtempSync(join(tmpdir(), "intervene-enrich-"));
  const sh = (args: string[]) => execFileSync("bedtools", args, { encoding: "utf8", maxBuffer: 1 << 28 });
  const parse = (text: string): Interval[] =>
    text
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [c, s, e] = l.split("\t");
        return iv(c, +s, +e);
      });

  // Subsets exactly as the app computes them (lib/pipeline.ts): sort, pairwise -c, assign.
  const paths = files.map((f, i) => {
    const p = join(dir, `s${i}.bed`);
    writeFileSync(p, sh(["sort", "-i", join(FIXTURES_DIR, f)]));
    return p;
  });
  const sets = paths.map((p, i) => ({ id: `s${i}`, regions: parse(readFileSync(p, "utf8")) }));
  const hits = paths.map((a, i) => paths.map((b, j) => (i === j ? null : parseIntersectCounts(sh(["intersect", "-a", a, "-b", b, "-c"]), sets[i].regions.length))));
  const subsets = subsetsFromOverlaps(sets, hits);

  const universe = buildUniverse(subsets);
  const uPath = join(dir, "universe.bed");
  writeFileSync(uPath, universe.bedText);
  const refs = ["refdata/hg38/external/cpg_islands.bed", "refdata/hg38/external/vista_enhancers.bed"].map((r) => join(PUBLIC_DIR, r));
  const refHits = refs.map((r) => parseIntersectCounts(sh(["intersect", "-a", uPath, "-b", r, "-c"]), universe.owner.length));

  it("the universe holds every subset region exactly once", () => {
    expect(universe.owner.length).toBe(subsets.reduce((n, s) => n + s.nRegions, 0));
  });

  it("table counts match independent native bedtools intersect -u runs, for every subset", () => {
    for (const s of subsets) {
      const sPath = join(dir, `sub${s.mask}.bed`);
      const restPath = join(dir, `rest${s.mask}.bed`);
      const lines = universe.bedText.split("\n").filter(Boolean);
      writeFileSync(sPath, lines.filter((_, i) => universe.owner[i] === s.mask).join("\n") + "\n");
      writeFileSync(restPath, lines.filter((_, i) => universe.owner[i] !== s.mask).join("\n") + "\n");
      refs.forEach((r, k) => {
        const [a, b, c, d] = enrichmentCounts(universe.owner, refHits[k], s.mask).table;
        const count = (p: string) => sh(["intersect", "-u", "-a", p, "-b", r]).split("\n").filter(Boolean).length;
        expect(a).toBe(count(sPath));
        expect(c).toBe(count(restPath));
        expect(a + b).toBe(s.nRegions);
        expect(a + b + c + d).toBe(universe.owner.length);
      });
    }
  });

  it.skipIf(!hasR)("p-values and odds ratios match R (fisher.test; mantelhaen.test over length strata), q matches p.adjust BH", () => {
    const masks = subsets.map((s) => s.mask);
    const annotations = refs.map((_, k) => ({ id: `ref${k}`, hits: refHits[k] }));
    for (const adjust of [false, true]) {
      const cells = unionEnrichment(universe, annotations, masks, adjust);
      const strata = lengthStrata(universe.lengths);
      // One R script for every cell: tables (and strata) as literals.
      const rLines = cells.map((cell) => {
        const t = enrichmentCounts(universe.owner, refHits[+cell.annotationId.slice(3)], cell.mask, strata);
        if (!adjust) {
          const [a, b, c, d] = t.table;
          return `cat(fisher.test(matrix(c(${a},${c},${b},${d}),2))$p.value, "\\n")`;
        }
        const arr = t.strata.flatMap(([a, b, c, d]) => [a, c, b, d]).join(",");
        return `x <- array(c(${arr}), c(2,2,${t.strata.length})); keep <- apply(x, 3, sum) >= 2; r <- mantelhaen.test(x[,,keep,drop=FALSE], correct=TRUE); cat(r$p.value, r$estimate, "\\n")`;
      });
      const out = execFileSync("Rscript", ["-e", `options(digits=15); ${rLines.join("; ")}`], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((l) => l.trim().split(/\s+/).map(Number));
      cells.forEach((cell, i) => {
        const [p, or] = out[i];
        expect(Math.abs(cell.p - p)).toBeLessThanOrEqual(Math.max(1e-12, 1e-8 * p));
        // OR = 0 when the subset never hits the reference set (R agrees).
        if (adjust) expect(Math.abs(cell.oddsRatio - or)).toBeLessThanOrEqual(1e-9 * or);
      });
      const qR = execFileSync("Rscript", ["-e", `options(digits=15); cat(p.adjust(c(${cells.map((c) => c.p).join(",")}), "BH"), sep="\\n")`], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map(Number);
      cells.forEach((cell, i) => expect(Math.abs(cell.q - qR[i])).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * qR[i])));
    }
  });
});
