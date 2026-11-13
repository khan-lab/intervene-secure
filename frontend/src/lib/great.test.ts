import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GREAT_DEFAULTS, assignRegions, leftMedian, prepareGreat, regulatoryDomains, greatTest, inputsGoTest, type GoData, type GreatGene } from "./great";
import { normalizeRegionText, parseChromSizes } from "./inputValidation";
import { binomialUpper, hypergeometricUpper } from "./stats";

/**
 * GREAT-style GO enrichment (docs/methods.md, "GO enrichment of selected
 * subsets"). Domains are checked against a direct, unoptimised reading of
 * the rule on real hg38 genes; region→gene assignment and term genome
 * fractions against native bedtools; counts against bedtools on the real
 * ENCODE fixture with the vendored hg38 GO data.
 */

const PUBLIC = join(__dirname, "../../public");
const read = (p: string) => readFileSync(join(PUBLIC, p), "utf8");
const sizes = parseChromSizes(read("refdata/hg38/hg38.chrom.sizes"));
const go = JSON.parse(read("refdata/hg38/go/go.json")) as GoData;
const gapsText = read("refdata/hg38/go/gaps.bed");

describe("leftMedian (GREAT maps a region to its left-median base)", () => {
  it("is the start for 1- and 2-bp regions, and the middle (left of centre) otherwise", () => {
    expect(leftMedian(100, 101)).toBe(100);
    expect(leftMedian(100, 102)).toBe(100);
    expect(leftMedian(100, 103)).toBe(101);
    expect(leftMedian(100, 104)).toBe(101);
    expect(leftMedian(100, 100)).toBe(100); // zero-length: its position
  });
});

describe("regulatoryDomains: basal plus extension", () => {
  it("hand-worked example: three genes on one chromosome", () => {
    const genes: GreatGene[] = [
      ["A", "chrT", 100_000, "+"], // basal [95000, 101001)
      ["B", "chrT", 200_000, "-"], // basal [199000, 205001)
      ["C", "chrT", 3_000_000, "+"], // basal [2995000, 3001001)
    ];
    const d = regulatoryDomains(genes, { chrT: 5_000_000 });
    expect(d[0]).toEqual({ chrom: "chrT", start: 0, end: 199_000 }); // left: chromosome start; right: B's basal
    expect(d[1]).toEqual({ chrom: "chrT", start: 101_001, end: 1_200_001 }); // right capped at TSS + 1 Mb
    expect(d[2]).toEqual({ chrom: "chrT", start: 2_000_000, end: 4_000_001 }); // both sides capped at 1 Mb
  });

  it("does not extend over an overlapping neighbour's basal domain", () => {
    const d = regulatoryDomains(
      [
        ["A", "chrT", 100_000, "+"],
        ["B", "chrT", 102_000, "+"], // basal [97000, 103001) overlaps A's
      ],
      { chrT: 300_000 }
    );
    expect(d[0]).toEqual({ chrom: "chrT", start: 0, end: 101_001 }); // A keeps its basal on the right
    expect(d[1]).toEqual({ chrom: "chrT", start: 97_000, end: 300_000 }); // B keeps its basal on the left
  });

  it("matches a direct O(n²) reading of the rule on every real hg38 gene of chr21 and chrY", () => {
    for (const rule of [GREAT_DEFAULTS, { upstream: 2000, downstream: 500, maxExtension: 50_000 }, { upstream: 20_000, downstream: 20_000, maxExtension: 0 }]) {
      for (const chrom of ["chr21", "chrY"]) {
        const genes = go.genes.filter((g) => g[1] === chrom);
        const fast = regulatoryDomains(genes, sizes, rule);
        const len = sizes[chrom];
        const { upstream: up, downstream: down, maxExtension: ext } = rule;
        const basal = genes.map(([, , t, s]) => (s === "+" ? [t - up, t + down + 1] : [t - down, t + up + 1]).map((x) => Math.min(len, Math.max(0, x))));
        genes.forEach(([, , t], i) => {
          let left = 0;
          let right = len;
          basal.forEach((b, j) => {
            if (j === i) return;
            if (b[0] < basal[i][0]) left = Math.max(left, b[1]);
            if (b[1] > basal[i][1]) right = Math.min(right, b[0]);
          });
          const start = Math.min(basal[i][0], Math.max(left, t - ext, 0));
          const end = Math.max(basal[i][1], Math.min(right, t + ext + 1, len));
          expect(fast[i]).toEqual({ chrom, start, end });
        });
      }
    }
  });

  it("settings: basal upstream/downstream and maximum extension are parameters", () => {
    const genes: GreatGene[] = [
      ["A", "chrT", 100_000, "+"],
      ["B", "chrT", 200_000, "-"],
    ];
    const d = regulatoryDomains(genes, { chrT: 5_000_000 }, { upstream: 10_000, downstream: 2000, maxExtension: 30_000 });
    expect(d[0]).toEqual({ chrom: "chrT", start: 70_000, end: 130_001 }); // basal [90000, 102001), ±30 kb from the TSS
    expect(d[1]).toEqual({ chrom: "chrT", start: 170_000, end: 230_001 }); // − strand basal [198000, 210001)
  });
});

function available(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!available("bedtools"))("GREAT on real data vs native bedtools", () => {
  const dir = mkdtempSync(join(tmpdir(), "intervene-great-"));
  const sh = (args: string[]) => execFileSync("bedtools", args, { encoding: "utf8", maxBuffer: 1 << 28 });
  const prepared = prepareGreat(go, sizes, gapsText);
  const domainsPath = join(dir, "domains.bed");
  writeFileSync(domainsPath, prepared.domains.map((d, i) => `${d.chrom}\t${d.start}\t${d.end}\t${i}`).join("\n") + "\n");
  const fixture = normalizeRegionText(readFileSync(join(__dirname, "../../../tests/fixtures/encode/heart_h3k27ac_ENCFF059ERB.subsample.bed"), "utf8")).bedText;
  const regions = fixture
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [chrom, s, e] = l.split("\t");
      return { chrom, start: +s, end: +e };
    });
  const regionGenes = assignRegions(regions, prepared);
  const midPath = join(dir, "mid.bed");
  writeFileSync(midPath, regions.map((r, i) => `${r.chrom}\t${leftMedian(r.start, r.end)}\t${leftMedian(r.start, r.end) + 1}\t${i}`).join("\n") + "\n");

  it("assigns each region's left-median base to exactly the genes bedtools finds", () => {
    const expected = new Map<number, number[]>();
    for (const line of sh(["intersect", "-a", midPath, "-b", domainsPath, "-wa", "-wb"]).split("\n").filter(Boolean)) {
      const f = line.split("\t");
      const r = +f[3];
      expected.set(r, [...(expected.get(r) ?? []), +f[7]]);
    }
    regions.forEach((_, i) => expect(regionGenes[i] ?? []).toEqual((expected.get(i) ?? []).sort((a, b) => a - b)));
  });

  const someTerms = go.terms.BP.filter((_, i) => i % 400 === 0).slice(0, 12);

  it("term genome fraction = union of the term's domains minus gaps, as bedtools merge + subtract compute it", () => {
    const gapsPath = join(dir, "gaps.bed");
    writeFileSync(gapsPath, gapsText);
    const genomeBp = Object.entries(sizes)
      .filter(([c]) => prepared.chroms.has(c))
      .reduce((n, [, l]) => n + l, 0);
    const gapBp = gapsText
      .split("\n")
      .filter(Boolean)
      .reduce((n, l) => {
        const [, s, e] = l.split("\t");
        return n + (+e - +s);
      }, 0);
    expect(prepared.genomeBp).toBe(genomeBp - gapBp);
    for (const [id, , genes] of someTerms) {
      const p = join(dir, "term.bed");
      writeFileSync(p, genes.map((g) => `${prepared.domains[g].chrom}\t${prepared.domains[g].start}\t${prepared.domains[g].end}`).join("\n") + "\n");
      const sorted = writeAndReturn(join(dir, "term.sorted.bed"), sh(["sort", "-i", p]));
      const merged = writeAndReturn(join(dir, "term.merged.bed"), sh(["merge", "-i", sorted]));
      const ungapped = sh(["subtract", "-a", merged, "-b", gapsPath]);
      const bp = ungapped
        .split("\n")
        .filter(Boolean)
        .reduce((n, l) => {
          const [, s, e] = l.split("\t");
          return n + (+e - +s);
        }, 0);
      expect(prepared.termBp("BP", id)).toBe(bp);
    }
  });

  it("binomial and hypergeometric inputs match independent counts; p-values follow", () => {
    const rows = greatTest(prepared, regionGenes, "BP");
    const n = regionGenes.filter((g) => g !== null).length;
    const selected = new Set(regionGenes.flatMap((g) => g ?? []));
    for (const [id, , genes] of someTerms) {
      const row = rows.find((r) => r.id === id)!;
      const termGenes = new Set(genes);
      const k = regionGenes.filter((g) => g && g.some((x) => termGenes.has(x))).length;
      const j = [...selected].filter((g) => termGenes.has(g)).length;
      expect(row.k).toBe(k);
      expect(row.n).toBe(n);
      expect(row.j).toBe(j);
      expect(row.m).toBe(selected.size);
      expect(row.binomP).toBe(binomialUpper(k, n, prepared.termBp("BP", id) / prepared.genomeBp));
      expect(row.hyperP).toBe(hypergeometricUpper(j, prepared.nGenes, genes.length, selected.size));
    }
    // Every term within GREAT's default size limits is tested, hit or not.
    expect(rows).toHaveLength(go.terms.BP.filter((t) => t[2].length >= 5 && t[2].length <= 1000).length);
    expect(go.terms.BP.some((t) => t[2].length > 1000)).toBe(true); // go.json also serves Cistrome-GO (up to 2,000)
    expect(rows.every((r) => r.binomQ >= r.binomP && r.hyperQ >= r.hyperP)).toBe(true);
  });

  it("input-sets background: a subset tested against the rest of a universe gives a Fisher table over regions", () => {
    // Universe: the fixture split in two halves; "subset" = mask 1 (first half).
    const owner = Int32Array.from(regions.map((_, i) => (i < regions.length / 2 ? 1 : 2)));
    const rows = inputsGoTest(prepared, regionGenes, owner, 1, "BP");
    const [id, , genes] = someTerms[0];
    const termGenes = new Set(genes);
    const hit = (i: number) => (regionGenes[i] ?? []).some((g) => termGenes.has(g));
    const row = rows.find((r) => r.id === id)!;
    const a = regions.filter((_, i) => owner[i] === 1 && hit(i)).length;
    const c = regions.filter((_, i) => owner[i] === 2 && hit(i)).length;
    expect(row.table).toEqual([a, regions.filter((_, i) => owner[i] === 1).length - a, c, regions.filter((_, i) => owner[i] === 2).length - c]);
  });

  it("settings: term-size limits choose the terms tested (and so the BH family); significance uses q and fold cut-offs", () => {
    const narrow = greatTest(prepared, regionGenes, "BP", { ...GREAT_DEFAULTS, minGenes: 20, maxGenes: 200 });
    expect(narrow.every((r) => r.K >= 20 && r.K <= 200)).toBe(true);
    expect(narrow).toHaveLength(go.terms.BP.filter((t) => t[2].length >= 20 && t[2].length <= 200).length);
    const loose = greatTest(prepared, regionGenes, "BP", { ...GREAT_DEFAULTS, qThreshold: 1.01, minFold: 0 });
    expect(loose.every((r) => r.significant)).toBe(true);
    const owner = Int32Array.from(regions.map((_, i) => (i % 2 ? 1 : 2)));
    expect(inputsGoTest(prepared, regionGenes, owner, 1, "BP", { ...GREAT_DEFAULTS, minGenes: 500 }).every((r) => r.K >= 500)).toBe(true);
  });
});

function writeAndReturn(path: string, text: string): string {
  writeFileSync(path, text);
  return path;
}

describe("vendored GO data", () => {
  for (const asm of ["hg38", "hg19", "mm10", "mm9"]) {
    it(`${asm}: genes are valid, every term has 5–2,000 genes with valid indices, and gaps fit the assembly`, () => {
      const data = JSON.parse(read(`refdata/${asm}/go/go.json`)) as GoData;
      const s = parseChromSizes(read(`refdata/${asm}/${asm}.chrom.sizes`));
      for (const [, chrom, tss, strand] of data.genes) {
        expect(s[chrom]).toBeGreaterThan(tss);
        expect(strand === "+" || strand === "-").toBe(true);
      }
      expect(new Set(data.genes.map((g) => g[0])).size).toBe(data.genes.length);
      for (const ns of ["BP", "MF", "CC"] as const) {
        expect(data.terms[ns].length).toBeGreaterThan(500);
        for (const [id, , genes] of data.terms[ns]) {
          expect(id).toMatch(/^GO:\d{7}$/);
          expect(genes.length).toBeGreaterThanOrEqual(5);
          expect(genes.length).toBeLessThanOrEqual(2000);
          expect(genes.every((g) => g >= 0 && g < data.genes.length)).toBe(true);
        }
      }
      for (const line of read(`refdata/${asm}/go/gaps.bed`).split("\n").filter(Boolean)) {
        const [c, st, e] = line.split("\t");
        expect(+e).toBeLessThanOrEqual(s[c]);
        expect(+st).toBeLessThan(+e);
      }
    });
  }
});
