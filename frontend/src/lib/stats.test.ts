import { describe, expect, it } from "vitest";
import { benjaminiHochberg, binomialUpper, fisherExact, hypergeometricUpper, mantelHaenszel, oddsRatio } from "./stats";

/**
 * Expected values are R 4.6.1's own output (fisher.test, mantelhaen.test
 * with correct = TRUE, p.adjust(method = "BH")), computed once and pasted
 * here so the tests run without R. Tables are (a, b, c, d) =
 * (in S & hit, in S & no hit, rest & hit, rest & no hit).
 */

const close = (actual: number, expected: number, rel = 1e-9) => {
  if (expected === 0) expect(actual).toBe(0);
  else expect(Math.abs(actual - expected) / expected).toBeLessThan(rel);
};

describe("fisherExact (two-sided, as R's fisher.test)", () => {
  const cases: [number, number, number, number, number][] = [
    [3, 1, 1, 3, 0.485714285714286], // Fisher's tea-tasting example
    [10, 2, 3, 15, 0.000536724119143436],
    [0, 5, 12, 3, 0.00361197110423117],
    [1, 9, 11, 3, 0.00275945618522008],
    [120, 880, 3000, 96000, 4.66863197625117e-36], // genome-scale counts
    [5, 995, 250, 48750, 1],
    [40, 60, 40, 60, 1],
    [0, 0, 5, 5, 1], // empty foreground
  ];
  for (const [a, b, c, d, p] of cases) {
    it(`(${a}, ${b}, ${c}, ${d}) -> p = ${p}`, () => close(fisherExact(a, b, c, d), p, 1e-8));
  }

  it("never returns a p-value above 1", () => {
    for (let a = 0; a <= 6; a++) for (let c = 0; c <= 6; c++) expect(fisherExact(a, 6 - a, c, 6 - c)).toBeLessThanOrEqual(1);
  });
});

describe("oddsRatio", () => {
  it("is the sample odds ratio ad/bc", () => close(oddsRatio(10, 2, 3, 15), (10 * 15) / (2 * 3)));
  it("adds 0.5 to every cell when any cell is zero (Haldane–Anscombe)", () => close(oddsRatio(0, 5, 12, 3), (0.5 * 3.5) / (5.5 * 12.5)));
  it("is NaN for an all-zero foreground or background", () => expect(oddsRatio(0, 0, 5, 5)).toBeNaN());
});

describe("mantelHaenszel (as R's mantelhaen.test, correct = TRUE)", () => {
  it("three strata", () => {
    const r = mantelHaenszel([
      [10, 20, 5, 40],
      [8, 25, 6, 50],
      [3, 30, 9, 60],
    ]);
    close(r.p, 0.055686755027392);
    close(r.oddsRatio, 2.0460395847105);
  });

  it("five strata with zero cells", () => {
    const r = mantelHaenszel([
      [2, 30, 1, 90],
      [1, 40, 0, 100],
      [0, 50, 2, 80],
      [4, 20, 3, 70],
      [6, 10, 1, 60],
    ]);
    close(r.p, 6.6977277997862e-5);
    close(r.oddsRatio, 5.56290595934337);
  });

  it("skips strata with fewer than two regions, and gives p = 1 / NaN OR with nothing to test", () => {
    const one = mantelHaenszel([
      [10, 20, 5, 40],
      [1, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    const ref = mantelHaenszel([[10, 20, 5, 40]]);
    close(one.p, ref.p);
    const none = mantelHaenszel([[0, 0, 0, 0]]);
    expect(none.p).toBe(1);
    expect(none.oddsRatio).toBeNaN();
  });
});

describe("benjaminiHochberg (as R's p.adjust 'BH')", () => {
  it("matches R, in input order", () => {
    const q = benjaminiHochberg([0.01, 0.04, 0.03, 0.005, 0.5, 0.2, 0.04]);
    const expected = [0.035, 0.056, 0.056, 0.035, 0.5, 0.233333333333333, 0.056];
    q.forEach((v, i) => close(v, expected[i], 1e-12));
  });

  it("handles an empty list and caps at 1", () => {
    expect(benjaminiHochberg([])).toEqual([]);
    expect(benjaminiHochberg([0.9, 1])).toEqual([1, 1]);
  });
});

describe("binomialUpper: P(X >= k), X ~ Binomial(n, p), as R's pbinom(k - 1, n, p, lower.tail = FALSE)", () => {
  const cases: [number, number, number, number][] = [
    [0, 100, 0.1, 1],
    [5, 100, 0.01, 0.00343232158775453],
    [30, 929, 0.012, 1.81113350216556e-6],
    [250, 929, 0.05, 1.30419213562093e-107],
    [1, 1, 0.5, 0.5],
    [929, 929, 0.3, 0], // 0.3^929 underflows in R too
    [12, 40000, 0.0001, 0.000914555700862221],
    [3000, 40000, 0.05, 3.87989111448504e-102],
  ];
  for (const [k, n, p, expected] of cases) it(`k=${k} n=${n} p=${p}`, () => close(binomialUpper(k, n, p), expected, 1e-8));
  it("handles p = 0 and p = 1", () => {
    expect(binomialUpper(1, 10, 0)).toBe(0);
    expect(binomialUpper(0, 10, 0)).toBe(1);
    expect(binomialUpper(10, 10, 1)).toBe(1);
  });
});

describe("hypergeometricUpper: P(X >= j) drawing m of N with K successes, as R's phyper(j - 1, K, N - K, m, lower.tail = FALSE)", () => {
  const cases: [number, number, number, number, number][] = [
    [0, 20067, 50, 800, 1],
    [10, 20067, 50, 800, 2.31392136264538e-5],
    [40, 20067, 300, 1200, 1.66450107913122e-6],
    [5, 100, 10, 10, 0.00067162774826505],
    [10, 100, 10, 10, 5.77690423453387e-14],
    [150, 20067, 1000, 2500, 0.00825732393887563],
  ];
  for (const [j, N, K, m, expected] of cases) it(`j=${j} N=${N} K=${K} m=${m}`, () => close(hypergeometricUpper(j, N, K, m), expected, 1e-8));
  it("is 0 when j exceeds what is possible", () => expect(hypergeometricUpper(11, 100, 10, 50)).toBe(0));
});
