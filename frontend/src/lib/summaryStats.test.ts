import { describe, expect, it } from "vitest";
import { parseSummaryOutput, filterCanonicalChromosomes, sortChromosomesNaturally, getAggregateRow } from "./summaryStats";

/**
 * Real captured `bedtools summary -i -g` stdout (heart H3K27ac ENCODE
 * fixture already in tests/fixtures/encode/, against the vendored
 * hg38.chrom.sizes) — not synthetic, per CLAUDE.md's fixtures rule.
 *
 * Deliberately includes real quirks discovered while researching this
 * feature, not sanitized away:
 *  - bedtools' own row order is DESCENDING chrom_length, not chromosome
 *    number order (chrX sits between chr7 and chr8; chr11 before chr10).
 *  - Per-chromosome rows with num_ivls > 0 have a trailing tab (11 fields
 *    when split on \t); rows with num_ivls === 0 (mean=-1) and the final
 *    "all" row do not (10 fields). parseSummaryOutput must handle both.
 *  - A handful of real chrUn_/alt scaffold rows are included so
 *    filterCanonicalChromosomes has real junk to filter out, not an
 *    invented case.
 */
const REAL_SUMMARY_STDOUT = `chrom\tchrom_length\tnum_ivls\ttotal_ivl_bp\tchrom_frac_genome\tfrac_all_ivls\tfrac_all_bp\tmin\tmax\tmean
chr1\t248956422\t199\t106080\t0.077573770\t0.099500000\t0.108066038\t136\t4168\t533.065326633\t
chr2\t242193529\t144\t64718\t0.075466481\t0.072000000\t0.065929655\t135\t2811\t449.430555556\t
chr3\t198295559\t126\t54730\t0.061788059\t0.063000000\t0.055754659\t149\t2022\t434.365079365\t
chr4\t190214555\t70\t33469\t0.059270052\t0.035000000\t0.034095609\t138\t1694\t478.128571429\t
chr5\t181538259\t101\t47181\t0.056566555\t0.050500000\t0.048064326\t145\t1691\t467.138613861\t
chr6\t170805979\t102\t40537\t0.053222422\t0.051000000\t0.041295937\t135\t1263\t397.421568627\t
chr7\t159345973\t92\t46203\t0.049651532\t0.046000000\t0.047068016\t145\t4668\t502.206521739\t
chrX\t156040895\t39\t18728\t0.048621684\t0.019500000\t0.019078627\t141\t2356\t480.205128205\t
chr8\t145138636\t82\t41802\t0.045224586\t0.041000000\t0.042584620\t147\t2376\t509.780487805\t
chr9\t138394717\t88\t40378\t0.043123209\t0.044000000\t0.041133960\t136\t2005\t458.840909091\t
chr11\t135086622\t102\t53973\t0.042092421\t0.051000000\t0.054983487\t148\t2142\t529.147058824\t
chr10\t133797422\t106\t46040\t0.041690712\t0.053000000\t0.046901964\t140\t1847\t434.339622642\t
chr12\t133275309\t103\t53247\t0.041528024\t0.051500000\t0.054243894\t148\t1977\t516.961165049\t
chr13\t114364328\t43\t19292\t0.035635442\t0.021500000\t0.019653186\t138\t1411\t448.651162791\t
chr14\t107043718\t63\t31668\t0.033354371\t0.031500000\t0.032260891\t151\t2112\t502.666666667\t
chr15\t101991189\t73\t29949\t0.031780024\t0.036500000\t0.030509707\t149\t1535\t410.260273973\t
chr16\t90338345\t79\t40067\t0.028149047\t0.039500000\t0.040817137\t141\t3344\t507.177215190\t
chr17\t83257441\t114\t72889\t0.025942667\t0.057000000\t0.074253633\t141\t2681\t639.377192982\t
chr18\t80373285\t40\t13933\t0.025043976\t0.020000000\t0.014193855\t137\t735\t348.325000000\t
chr20\t64444167\t59\t29331\t0.020080530\t0.029500000\t0.029880137\t147\t2219\t497.135593220\t
chr19\t58617616\t97\t53944\t0.018265002\t0.048500000\t0.054953944\t140\t2872\t556.123711340\t
chrY\t57227415\t0\t0\t0.017831821\t0.000000000\t0.000000000\t-1\t-1\t-1
chr22\t50818468\t59\t32137\t0.015834820\t0.029500000\t0.032738671\t155\t3358\t544.694915254\t
chr21\t46709983\t19\t11326\t0.014554633\t0.009500000\t0.011538046\t182\t1917\t596.105263158\t
chrM\t16569\t0\t0\t0.000005163\t0.000000000\t0.000000000\t-1\t-1\t-1
chrUn_KI270442v1\t392061\t0\t0\t0.000122165\t0.000000000\t0.000000000\t-1\t-1\t-1
chrUn_KI270743v1\t210658\t0\t0\t0.000065640\t0.000000000\t0.000000000\t-1\t-1\t-1
chrUn_KI270747v1\t198735\t0\t0\t0.000061925\t0.000000000\t0.000000000\t-1\t-1\t-1
all\t3209286105\t2000\t981622\t1.0\t1.0\t1.0\t135\t4668\t490.811000000
`;

describe("parseSummaryOutput", () => {
  it("parses all real rows, including trailing-tab and no-trailing-tab variants", () => {
    const rows = parseSummaryOutput(REAL_SUMMARY_STDOUT);
    // 25 canonical + 3 junk + 1 "all" = 29 data rows (header excluded).
    expect(rows).toHaveLength(29);
  });

  it("correctly parses a row with a trailing tab (has intervals)", () => {
    const rows = parseSummaryOutput(REAL_SUMMARY_STDOUT);
    const chr1 = rows.find((r) => r.chrom === "chr1")!;
    expect(chr1).toEqual({
      chrom: "chr1",
      chromLength: 248956422,
      numIvls: 199,
      totalIvlBp: 106080,
      chromFracGenome: 0.07757377,
      fracAllIvls: 0.0995,
      fracAllBp: 0.108066038,
      min: 136,
      max: 4168,
      mean: 533.065326633,
    });
  });

  it("correctly parses a zero-interval row (no trailing tab, -1 sentinels)", () => {
    const rows = parseSummaryOutput(REAL_SUMMARY_STDOUT);
    const chrY = rows.find((r) => r.chrom === "chrY")!;
    expect(chrY.numIvls).toBe(0);
    expect(chrY.min).toBe(-1);
    expect(chrY.max).toBe(-1);
    expect(chrY.mean).toBe(-1);
  });

  it("correctly parses the final 'all' aggregate row (no trailing tab, has intervals)", () => {
    const rows = parseSummaryOutput(REAL_SUMMARY_STDOUT);
    const all = rows.find((r) => r.chrom === "all")!;
    expect(all).toEqual({
      chrom: "all",
      chromLength: 3209286105,
      numIvls: 2000,
      totalIvlBp: 981622,
      chromFracGenome: 1.0,
      fracAllIvls: 1.0,
      fracAllBp: 1.0,
      min: 135,
      max: 4668,
      mean: 490.811,
    });
  });
});

describe("filterCanonicalChromosomes", () => {
  it("keeps exactly the real chr1-22/X/Y/M rows and drops junk scaffolds and the 'all' row", () => {
    const rows = parseSummaryOutput(REAL_SUMMARY_STDOUT);
    const canonical = filterCanonicalChromosomes(rows);
    expect(canonical).toHaveLength(25); // chr1-22, chrX, chrY, chrM
    expect(canonical.some((r) => r.chrom === "all")).toBe(false);
    expect(canonical.some((r) => r.chrom.startsWith("chrUn_"))).toBe(false);
  });
});

describe("sortChromosomesNaturally", () => {
  it("re-sorts bedtools' own descending-length real order into chr1..chr22, chrX, chrY, chrM", () => {
    const rows = parseSummaryOutput(REAL_SUMMARY_STDOUT);
    const canonical = filterCanonicalChromosomes(rows);
    // Sanity check on the fixture itself: bedtools' real order is NOT
    // already chromosome-number order (chrX appears before chr8).
    expect(canonical.map((r) => r.chrom).indexOf("chrX")).toBeLessThan(canonical.map((r) => r.chrom).indexOf("chr8"));

    const sorted = sortChromosomesNaturally(canonical);
    expect(sorted.map((r) => r.chrom)).toEqual([
      "chr1", "chr2", "chr3", "chr4", "chr5", "chr6", "chr7", "chr8", "chr9", "chr10",
      "chr11", "chr12", "chr13", "chr14", "chr15", "chr16", "chr17", "chr18", "chr19", "chr20",
      "chr21", "chr22", "chrX", "chrY", "chrM",
    ]);
  });
});

describe("getAggregateRow", () => {
  it("finds the real 'all' row", () => {
    const rows = parseSummaryOutput(REAL_SUMMARY_STDOUT);
    const all = getAggregateRow(rows);
    expect(all?.chrom).toBe("all");
    expect(all?.numIvls).toBe(2000);
    expect(all?.totalIvlBp).toBe(981622);
    expect(all?.mean).toBeCloseTo(490.811, 3);
  });

  it("returns undefined when there's no 'all' row", () => {
    expect(getAggregateRow([])).toBeUndefined();
  });
});
