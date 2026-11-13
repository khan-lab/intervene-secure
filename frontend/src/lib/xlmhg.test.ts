import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hypergeometricUpper } from "./stats";
import { xlmhgPval, xlmhgStat, xlmhgTest } from "./xlmhg";

/**
 * XL-mHG test (Eden et al. 2007; Wagner 2015), as Cistrome-GO uses it
 * (X = 1, L = min(2000, genes with a positive adjusted RP)).
 *
 * Three independent references:
 *  1. xlmhg's own pure-Python implementation (mhg.py, commit c29d913, BSD-3)
 *     on Cistrome-GO's real rankings of the ENCODE fixtures —
 *     tests/fixtures/cistromego/reference_hg38_bp.json, made by
 *     make_reference.py there. Only where float64 mhg.py's arithmetic stays
 *     in the normal double range: its running P(first n genes all in the
 *     term) reaches 1/C(N, K) (or the L-step analogue), which for a
 *     126-gene term in a 16,990-gene list is ~1e-323 — subnormal, so it
 *     loses precision (and with it the tie at the observed cutoff), and
 *     below that it returns NaN (stored as null). The compiled xlmhg uses
 *     80-bit long double and our port rescales by powers of two; neither
 *     has the problem. Those cases are checked against (2).
 *  2. Exact path counting with BigInt (Eden's original formulation: the
 *     p-value is the fraction of all C(N,K) placements whose path enters the
 *     rejection region within the first L cutoffs), membership decided with
 *     stats.ts hypergeometricUpper (checked against R's phyper).
 *  3. Brute-force enumeration of every placement for small lists.
 */

interface RefMhg {
  term?: string;
  N?: number;
  L?: number;
  indices: number[];
  stat: number;
  cutoff: number;
  pval: number | null;
}
const REF = JSON.parse(readFileSync(join(__dirname, "../../../tests/fixtures/cistromego/reference_hg38_bp.json"), "utf8")) as {
  configs: { file: string; N: number; L: number; mhg: RefMhg[] }[];
  extra_mhg: RefMhg[];
};

/** log10 of the smallest value float64 mhg.py's p_start recurrence reaches. */
function minLog10PStart(N: number, K: number, L: number): number {
  let s = 0;
  for (let n = 1; n <= Math.min(K, L); n++) s += Math.log10((K - n + 1) / (N - n + 1));
  return s;
}
/** Whether float64 mhg.py stays in the normal double range for this test. */
const float64Reliable = (N: number, K: number, L: number) => minLog10PStart(N, K, L) > -307;

const rel = (a: number, b: number) => (a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)));
const isEqual = (a: number, b: number, tol = 1e-12) => a === b || Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b));

/** The XL-mHG statistic straight from its definition: min over cutoffs n ≤ L with k ≥ X of P(Hyper ≥ k). */
function naiveStat(N: number, indices: number[], X: number, L: number): { stat: number; cutoff: number } {
  const K = indices.length;
  let stat = 1;
  let cutoff = 0;
  let k = 0;
  for (const i of indices) {
    if (i >= L) break;
    k++;
    if (k < X) continue;
    const p = hypergeometricUpper(k, N, K, i + 1);
    if (p < stat && !isEqual(p, stat)) {
      stat = p;
      cutoff = i + 1;
    }
  }
  return { stat, cutoff };
}

function binom(n: number, k: number): bigint {
  if (k < 0 || k > n) return 0n;
  k = Math.min(k, n - k);
  let r = 1n;
  for (let i = 1; i <= k; i++) r = (r * BigInt(n - k + i)) / BigInt(i);
  return r;
}

function bigRatio(a: bigint, b: bigint): number {
  if (a === 0n) return 0;
  const shift = b.toString(2).length - a.toString(2).length + 80;
  const q = shift >= 0 ? (a << BigInt(shift)) / b : a / (b << BigInt(-shift));
  return Number(q) * 2 ** -shift;
}

/**
 * Exact XL-mHG p-value by counting lattice paths that never enter R in the
 * first L steps. R membership uses stats.ts's tail (an independent
 * computation), so ties — the observed cutoff's tail equals the statistic
 * by definition — are decided with a looser 1e-9 tolerance.
 */
function exactPval(N: number, K: number, X: number, L: number, stat: number): number {
  if (stat >= 1) return 1;
  const W = N - K;
  // R at cutoff n is {k >= kMin[n]} (the tail probability falls as k rises), restricted to k >= X and w < W.
  const kMin = new Array<number>(L + 1).fill(Infinity);
  for (let n = 1; n <= L; n++) {
    let lo = Math.max(X, n - W + 1, 0);
    let hi = Math.min(n, K);
    if (lo > hi) continue;
    const inR = (k: number) => {
      const p = hypergeometricUpper(k, N, K, n);
      return p < stat || isEqual(p, stat, 1e-9);
    };
    if (!inR(hi)) continue;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (inR(mid)) hi = mid;
      else lo = mid + 1;
    }
    kMin[n] = lo;
  }
  let cnt: bigint[] = [1n];
  for (let n = 1; n <= L; n++) {
    const next: bigint[] = new Array(Math.min(n, K) + 1).fill(0n);
    for (let k = 0; k < cnt.length; k++) {
      if (cnt[k] === 0n) continue;
      if (n - 1 - k < W) next[k] += cnt[k]; // a zero
      if (k < K) next[k + 1] += cnt[k]; // a one
    }
    for (let k = kMin[n]; k < next.length; k++) next[k] = 0n;
    cnt = next;
  }
  let avoid = 0n;
  cnt.forEach((c, k) => {
    if (c) avoid += c * binom(N - L, K - k);
  });
  const total = binom(N, K);
  return bigRatio(total - avoid, total);
}

describe("xlmhgStat", () => {
  it("matches xlmhg mhg.py on Cistrome-GO's real rankings (3 fixtures × 60 terms) and on constructed lists", () => {
    const cases = [...REF.configs.flatMap((c) => c.mhg.map((m) => ({ ...m, N: c.N, L: c.L }))), ...REF.extra_mhg];
    expect(cases.length).toBe(187);
    for (const m of cases) {
      const r = xlmhgStat(m.indices, m.N!, 1, m.L!);
      expect(r.cutoff).toBe(m.cutoff);
      expect(rel(r.stat, m.stat)).toBeLessThan(1e-9);
    }
  });

  it("matches the statistic computed from its definition", () => {
    for (const c of REF.configs)
      for (const m of c.mhg.slice(0, 20)) {
        const naive = naiveStat(c.N, m.indices, 1, c.L);
        const r = xlmhgStat(m.indices, c.N, 1, c.L);
        expect(r.cutoff).toBe(naive.cutoff);
        expect(rel(r.stat, naive.stat)).toBeLessThan(1e-9);
      }
  });
});

describe("xlmhgPval", () => {
  const ALL = [...REF.configs.flatMap((c) => c.mhg.map((m) => ({ ...m, N: c.N, L: c.L }))), ...REF.extra_mhg];

  it("matches xlmhg mhg.py (Algorithm 2) wherever float64 mhg.py stays in the normal range", () => {
    const ok = ALL.filter((m) => float64Reliable(m.N!, m.indices.length, m.L!));
    expect(ok.length).toBeGreaterThan(140);
    for (const m of ok) expect(rel(xlmhgPval(m.N!, m.indices.length, 1, m.L!, m.stat), m.pval!)).toBeLessThan(1e-9);
  });

  it("gives the exact p-value where float64 mhg.py loses precision or underflows (terms of 120+ genes)", () => {
    const rest = ALL.filter((m) => !float64Reliable(m.N!, m.indices.length, m.L!));
    expect(rest.every((m) => m.indices.length >= 120)).toBe(true);
    expect(rest.filter((m) => m.pval === null).length).toBe(27); // NaN in float64 mhg.py
    // BigInt path counting costs O(L·K) big-number additions: the smallest few per source.
    const underflow = [
      ...REF.configs.flatMap((c) =>
        rest
          .filter((m) => m.N === c.N && m.L === c.L && c.mhg.some((x) => x.term === m.term))
          .sort((a, b) => a.indices.length - b.indices.length)
          .slice(0, 3)
      ),
      ...REF.extra_mhg.filter((m) => m.pval === null && m.indices.length <= 500),
    ];
    expect(underflow.length).toBe(10);
    for (const m of underflow) {
      const p = xlmhgPval(m.N!, m.indices.length, 1, m.L!, m.stat);
      expect(Number.isFinite(p)).toBe(true);
      expect(rel(p, exactPval(m.N!, m.indices.length, 1, m.L!, m.stat))).toBeLessThan(1e-9);
    }
  }, 60_000);

  it("matches exact path counting on smaller lists, tiny p-values included", () => {
    for (const m of REF.extra_mhg.filter((x) => x.pval !== null && x.pval < 1)) {
      expect(rel(xlmhgPval(m.N!, m.indices.length, 1, m.L!, m.stat), exactPval(m.N!, m.indices.length, 1, m.L!, m.stat))).toBeLessThan(1e-9);
    }
  });

  it("equals the fraction of all placements at least as extreme (brute force, N = 12, K = 4)", () => {
    const N = 12;
    const K = 4;
    const all: number[][] = [];
    for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) for (let c = b + 1; c < N; c++) for (let d = c + 1; d < N; d++) all.push([a, b, c, d]);
    expect(all.length).toBe(495);
    for (const [X, L] of [
      [1, 12],
      [1, 6],
      [2, 8],
    ]) {
      const stats = all.map((ix) => naiveStat(N, ix, X, L).stat);
      for (const ix of [all[0], all[37], all[200], all[494]]) {
        const s = naiveStat(N, ix, X, L).stat;
        const expected = stats.filter((t) => t < s || isEqual(t, s)).length / all.length;
        expect(rel(xlmhgPval(N, K, X, L, s), s >= 1 ? 1 : expected)).toBeLessThan(1e-12);
      }
    }
  });
});

describe("xlmhgTest", () => {
  it("reports cutoff, k above it, fold enrichment k / (K·cutoff/N), and the p-value", () => {
    const m = REF.extra_mhg[2];
    const r = xlmhgTest(m.N!, m.indices, 1, m.L!);
    expect(r.cutoff).toBe(m.cutoff);
    expect(r.K).toBe(m.indices.length);
    expect(r.k).toBe(m.indices.filter((i) => i < m.cutoff).length);
    expect(r.fold).toBeCloseTo(r.k / ((r.K * r.cutoff) / m.N!), 12);
    expect(rel(r.pval, m.pval!)).toBeLessThan(1e-9);
  });

  it("special cases: no genes, X above min(K, L), and every gene in the list", () => {
    expect(xlmhgTest(100, [], 1, 50)).toMatchObject({ stat: 1, cutoff: 0, pval: 1, k: 0 });
    expect(xlmhgTest(100, [0, 1, 2], 4, 50)).toMatchObject({ stat: 1, pval: 1 });
    expect(xlmhgTest(100, [5, 6], 1, 0)).toMatchObject({ stat: 1, pval: 1 });
    expect(xlmhgTest(3, [0, 1, 2], 1, 3)).toMatchObject({ stat: 1, pval: 1 });
    expect(Number.isNaN(xlmhgTest(100, [], 1, 50).fold)).toBe(true);
  });
});
