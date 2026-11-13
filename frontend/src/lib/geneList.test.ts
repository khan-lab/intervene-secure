import { describe, expect, it } from "vitest";
import { parseClosestGeneAssociations, uniqueGeneNames } from "./geneList";

/**
 * Real captured `bedtools closest -d -t all -a <peaks> -b genes_tss.bed`
 * stdout — the real ENCODE heart H3K27ac fixture against the real hg38
 * genes_tss.bed derived by build_peak_annotation.py, not synthetic — per
 * CLAUDE.md's fixtures rule. Includes a genuine 3-way tie (Peak_1249
 * spans all three genes' TSS, so all three are equally "nearest" at
 * distance 0) captured from the real 2000-region fixture, not invented.
 */
const REAL_CLOSEST_STDOUT = `chr1\t778470\t778639\tPeak_75098\t58\t.\t3.46069\t5.84601\t3.66472\t134\tchr1\t686653\t686654\tOR4F16|ENSG00000284662.2\t0\t-\t91817
chr2\t95165086\t95165693\tPeak_1249\t797\t.\t17.95232\t79.74434\t75.29480\t441\tchr2\t95165390\t95165391\tENSG00000289685|ENSG00000289685.2\t0\t-\t0
chr2\t95165086\t95165693\tPeak_1249\t797\t.\t17.95232\t79.74434\t75.29480\t441\tchr2\t95165431\t95165432\tZNF2|ENSG00000275111.7\t0\t+\t0
chr2\t95165086\t95165693\tPeak_1249\t797\t.\t17.95232\t79.74434\t75.29480\t441\tchr2\t95165671\t95165672\tZNF514|ENSG00000144026.16\t0\t-\t0
`;

describe("parseClosestGeneAssociations", () => {
  it("parses a real non-tied line into a structured region-gene association", () => {
    const result = parseClosestGeneAssociations(REAL_CLOSEST_STDOUT);
    expect(result[0]).toEqual({
      region: { chrom: "chr1", start: 778470, end: 778639 },
      geneName: "OR4F16",
      geneId: "ENSG00000284662.2",
      strand: "-",
      distance: 91817,
    });
  });

  it("preserves every tied gene as a separate association (real 3-way tie, -t all)", () => {
    const result = parseClosestGeneAssociations(REAL_CLOSEST_STDOUT);
    const tied = result.filter((r) => r.region.chrom === "chr2" && r.region.start === 95165086);
    expect(tied).toHaveLength(3);
    expect(tied.map((r) => r.geneName).sort()).toEqual(["ENSG00000289685", "ZNF2", "ZNF514"]);
    expect(tied.every((r) => r.distance === 0)).toBe(true);
    // Real data can have gene_name fall back to the Ensembl ID for
    // otherwise-unnamed loci — confirmed real, not a parsing artifact.
    expect(tied.find((r) => r.geneName === "ENSG00000289685")?.geneId).toBe("ENSG00000289685.2");
  });

  it("ignores blank lines", () => {
    expect(parseClosestGeneAssociations("\n\n")).toEqual([]);
  });
});

describe("uniqueGeneNames", () => {
  it("dedupes and alphabetically sorts gene names from real associations", () => {
    const associations = parseClosestGeneAssociations(REAL_CLOSEST_STDOUT);
    expect(uniqueGeneNames(associations)).toEqual(["ENSG00000289685", "OR4F16", "ZNF2", "ZNF514"]);
  });

  it("dedupes a gene appearing near multiple regions down to one entry", () => {
    const associations = [
      { region: { chrom: "chr1", start: 0, end: 10 }, geneName: "FOO", geneId: "ENSG1", strand: "+", distance: 5 },
      { region: { chrom: "chr1", start: 100, end: 110 }, geneName: "FOO", geneId: "ENSG1", strand: "+", distance: 50 },
      { region: { chrom: "chr1", start: 200, end: 210 }, geneName: "BAR", geneId: "ENSG2", strand: "-", distance: 1 },
    ];
    expect(uniqueGeneNames(associations)).toEqual(["BAR", "FOO"]);
  });

  it("returns an empty list for no associations", () => {
    expect(uniqueGeneNames([])).toEqual([]);
  });
});
