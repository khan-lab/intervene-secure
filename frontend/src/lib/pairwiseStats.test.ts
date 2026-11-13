import { describe, expect, it } from "vitest";
import { medianFromReldistBins, parseFisherOutput, parseJaccardOutput, parseReldistOutput, ksPValueVsUniform } from "./pairwiseStats";

/**
 * Real captured `bedtools fisher`/`bedtools reldist` stdout (heart vs. lung
 * H3K27ac ENCODE fixtures already in tests/fixtures/encode/, hg38), not
 * synthetic — per CLAUDE.md's fixtures rule. Captured while researching
 * this feature: `bedtools fisher -a heart.sorted.bed -b lung.sorted.bed -g
 * hg38.chrom.sizes` / `bedtools reldist -a heart.sorted.bed -b
 * lung.sorted.bed`, both sorted with `-g hg38.chrom.sizes` first.
 */
const REAL_FISHER_STDOUT = `# Number of query intervals: 2000
# Number of db intervals: 2000
# Number of overlaps: 20
# Number of possible intervals (estimated): 3087729
# phyper(20 - 1, 2000, 3087729 - 2000, 2000, lower.tail=F)
# Contingency Table Of Counts
#_________________________________________
#           |  in -b       | not in -b    |
#     in -a | 20           | 1980         |
# not in -a | 1980         | 3083749      |
#_________________________________________
# p-values for fisher's exact test
left\tright\ttwo-tail\tratio
1\t1.7981e-17\t1.7981e-17\t15.732
`;

const REAL_RELDIST_STDOUT = `reldist\tcount\ttotal\tfraction
0.00\t144\t1963\t0.073
0.01\t89\t1963\t0.045
0.02\t72\t1963\t0.037
0.03\t72\t1963\t0.037
0.04\t50\t1963\t0.025
0.05\t45\t1963\t0.023
0.06\t59\t1963\t0.030
0.07\t51\t1963\t0.026
0.08\t52\t1963\t0.026
0.09\t44\t1963\t0.022
0.10\t34\t1963\t0.017
0.11\t44\t1963\t0.022
0.12\t40\t1963\t0.020
0.13\t41\t1963\t0.021
0.14\t43\t1963\t0.022
0.15\t38\t1963\t0.019
0.16\t33\t1963\t0.017
0.17\t40\t1963\t0.020
0.18\t39\t1963\t0.020
0.19\t28\t1963\t0.014
0.20\t40\t1963\t0.020
0.21\t33\t1963\t0.017
0.22\t24\t1963\t0.012
0.23\t35\t1963\t0.018
0.24\t41\t1963\t0.021
0.25\t35\t1963\t0.018
0.26\t22\t1963\t0.011
0.27\t23\t1963\t0.012
0.28\t30\t1963\t0.015
0.29\t30\t1963\t0.015
0.30\t33\t1963\t0.017
0.31\t33\t1963\t0.017
0.32\t22\t1963\t0.011
0.33\t24\t1963\t0.012
0.34\t31\t1963\t0.016
0.35\t34\t1963\t0.017
0.36\t37\t1963\t0.019
0.37\t27\t1963\t0.014
0.38\t26\t1963\t0.013
0.39\t27\t1963\t0.014
0.40\t27\t1963\t0.014
0.41\t31\t1963\t0.016
0.42\t25\t1963\t0.013
0.43\t30\t1963\t0.015
0.44\t32\t1963\t0.016
0.45\t30\t1963\t0.015
0.46\t19\t1963\t0.010
0.47\t34\t1963\t0.017
0.48\t31\t1963\t0.016
0.49\t39\t1963\t0.020
`;

describe("parseFisherOutput", () => {
  it("parses the two-tail p-value and odds ratio from real bedtools fisher stdout", () => {
    const result = parseFisherOutput(REAL_FISHER_STDOUT);
    expect(result.twoTailP).toBeCloseTo(1.7981e-17, 25);
    expect(result.ratio).toBeCloseTo(15.732, 3);
  });

  it("ignores comment lines regardless of how many precede the data row", () => {
    const minimal = "left\tright\ttwo-tail\tratio\n0.5\t0.5\t0.9\t1.0\n";
    expect(parseFisherOutput(minimal)).toEqual({ twoTailP: 0.9, ratio: 1.0 });
  });
});

describe("parseReldistOutput", () => {
  it("parses all 50 real bins from real bedtools reldist stdout", () => {
    const bins = parseReldistOutput(REAL_RELDIST_STDOUT);
    expect(bins).toHaveLength(50);
    expect(bins[0]).toEqual({ reldist: 0, count: 144, total: 1963, fraction: 0.073 });
    expect(bins[49]).toEqual({ reldist: 0.49, count: 39, total: 1963, fraction: 0.02 });
  });
});

describe("medianFromReldistBins", () => {
  it("returns the midpoint of the bin where cumulative fraction first reaches 0.5, on real data", () => {
    // Verified by hand against the real cumulative fractions: crosses 0.5
    // inside the reldist=0.17 bin (cum reaches 0.482 at 0.17's upper edge,
    // 0.502 at 0.18's) — bin width 0.01, so midpoint is 0.175.
    const bins = parseReldistOutput(REAL_RELDIST_STDOUT);
    expect(medianFromReldistBins(bins)).toBeCloseTo(0.175, 6);
  });

  it("returns the single bin's midpoint when all mass is in one bin", () => {
    expect(medianFromReldistBins([{ reldist: 0.2, count: 10, total: 10, fraction: 1 }])).toBeCloseTo(0.205, 6);
  });
});

describe("ksPValueVsUniform", () => {
  it("rejects uniformity (very small p-value) for the real, visibly-skewed reldist data", () => {
    const bins = parseReldistOutput(REAL_RELDIST_STDOUT);
    const p = ksPValueVsUniform(bins);
    // Cross-checked against a scipy.stats.kstest run on reconstructed
    // samples during development: same conclusion (overwhelming rejection
    // of uniformity), though not numerically identical, since scipy's
    // exact-sample KS test and this binned-boundary approximation are
    // answering slightly different questions (see ksPValueVsUniform's
    // own doc comment) — both correctly reject at any reasonable alpha.
    expect(p).toBeLessThan(1e-20);
  });

  it("does not reject a genuinely uniform binned distribution", () => {
    const n = 50;
    const uniformBins = Array.from({ length: n }, (_, i) => ({
      reldist: i * 0.01,
      count: 20,
      total: n * 20,
      fraction: 1 / n,
    }));
    expect(ksPValueVsUniform(uniformBins)).toBeGreaterThan(0.05);
  });

  it("rejects a distribution concentrated entirely in one extreme bin", () => {
    const n = 50;
    const bins = Array.from({ length: n }, (_, i) => ({
      reldist: i * 0.01,
      count: i === 0 ? 1000 : 0,
      total: 1000,
      fraction: i === 0 ? 1 : 0,
    }));
    expect(ksPValueVsUniform(bins)).toBeLessThan(0.001);
  });
});

/** Real `bedtools jaccard -a heart.bed -b lung.bed` stdout (ENCODE fixtures, plain `bedtools sort`), bedtools 2.31.1. */
const REAL_JACCARD_STDOUT = `intersection\tunion\tjaccard\tn_intersections
11097\t2063638\t0.0053774\t20
`;

describe("parseJaccardOutput", () => {
  it("parses intersection, union, Jaccard and intersection count from real bedtools jaccard stdout", () => {
    expect(parseJaccardOutput(REAL_JACCARD_STDOUT)).toEqual({
      intersection: 11097,
      union: 2063638,
      jaccard: 0.0053774,
      nIntersections: 20,
    });
  });

  it("throws when the data row is missing", () => {
    expect(() => parseJaccardOutput("intersection\tunion\tjaccard\tn_intersections\n")).toThrow();
    expect(() => parseJaccardOutput("")).toThrow();
  });
});

/**
 * Real `bedtools fisher -g hg38.chrom.sizes` stdout for three VISTA hg38
 * enhancers against themselves (every A interval overlaps B, no off-diagonal
 * counts): bedtools prints the odds ratio as `inf`.
 */
const REAL_FISHER_INF_STDOUT = `# Number of query intervals: 3
# Number of db intervals: 3
# Number of overlaps: 3
# Number of possible intervals (estimated): 1224862
# phyper(3 - 1, 3, 1224862 - 3, 3, lower.tail=F)
# Contingency Table Of Counts
#_________________________________________
#           |  in -b       | not in -b    |
#     in -a | 3            | 0            |
# not in -a | 0            | 1224859      |
#_________________________________________
# p-values for fisher's exact test
left	right	two-tail	ratio
1	3.2651e-18	3.2651e-18	inf
`;

describe("parseFisherOutput with an infinite odds ratio", () => {
  it("reads bedtools' `inf` ratio as Infinity", () => {
    expect(parseFisherOutput(REAL_FISHER_INF_STDOUT)).toEqual({ twoTailP: 3.2651e-18, ratio: Infinity });
  });

  it("still rejects a row that isn't numbers", () => {
    expect(() => parseFisherOutput(REAL_FISHER_INF_STDOUT.replace("3.2651e-18\tinf", "x\ty"))).toThrow();
  });
});

/**
 * Real `bedtools fisher` stdout where its model breaks down: 929 ~30 kb
 * regions (the hg38 example's "HepG2 only" subset) against 332,526 1-bp
 * GWAS Catalog positions. Overlaps are counted per pair (5,005 > 929), the
 * "possible intervals" estimate equals the db count, and the ratio is
 * printed as `-nan`.
 */
const REAL_FISHER_NAN_STDOUT = `# Number of query intervals: 929
# Number of db intervals: 332526
# Number of overlaps: 5005
# Number of possible intervals (estimated): 332526
# phyper(5005 - 1, 929, 332526 - 929, 332526, lower.tail=F)
# Contingency Table Of Counts
#_________________________________________
#           |  in -b       | not in -b    |
#     in -a | 5005         | 0            |
# not in -a | 327521       | 0            |
#_________________________________________
# p-values for fisher's exact test
left	right	two-tail	ratio
1	1	1	-nan
`;

describe("parseFisherOutput when bedtools can't estimate the odds ratio", () => {
  it("reads `-nan` as NaN instead of failing", () => {
    const r = parseFisherOutput(REAL_FISHER_NAN_STDOUT);
    expect(r.twoTailP).toBe(1);
    expect(r.ratio).toBeNaN();
  });
});
