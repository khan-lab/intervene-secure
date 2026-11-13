/**
 * The XL-mHG test (Eden, Lipson, Yogev & Yakhini 2007, PLoS Comput Biol
 * 3:e39; Wagner F, arXiv:1507.07905, 2015, and PeerJ Preprints
 * 5:e1962v3, 2017), as used by Cistrome-GO.
 *
 * Ported from the reference implementation in xlmhg (Copyright (c)
 * 2015-2020 Florian Wagner, https://github.com/flo-compbio/xlmhg, commit
 * c29d913, BSD 3-clause; licence text in the repository's LICENSE file):
 * mhg_cython.pyx get_xlmhg_stat and mhg.py get_xlmhg_pval2 ("Algorithm 2"),
 * same recurrences, same tolerance rule. Two changes, neither altering the
 * result:
 *  - hypergeometric terms carry a separate power-of-two exponent. The
 *    compiled xlmhg uses C long double (80-bit) and its float64 Python
 *    fallback returns NaN once P(first n genes all in the term) underflows
 *    — routine for terms of a few hundred genes in a 17,000-gene list.
 *    JavaScript has only float64; exact power-of-two rescaling keeps
 *    xlmhg's own recurrences (and so its 1e-12 tie rule at the observed
 *    cutoff, which log-space sums are too imprecise for) without underflow;
 *  - the dynamic-programming table is kept one anti-diagonal (cutoff) at a
 *    time instead of as a (K+1) × (L+1) matrix (each cutoff only reads the
 *    previous one).
 * Checked against mhg.py, exact BigInt path counting and brute force in
 * xlmhg.test.ts.
 *
 * Conventions as in xlmhg: `indices` are the sorted, distinct 0-based
 * positions of the term's genes in the ranked list of N genes; cutoffs
 * n = 1..L; only cutoffs with at least X term genes above them count.
 */

export const DEFAULT_TOL = 1e-12;

function isEqual(a: number, b: number, tol: number): boolean {
  return a === b || Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b));
}

// Hypergeometric terms are carried as m · 2^e (mantissa m, integer exponent e)
// and rescaled by exact powers of two, so the arithmetic is xlmhg's own
// float recurrences, rounding for rounding, without ever underflowing.
const SHIFT = 512;
const UP = 2 ** SHIFT;
const DOWN = 2 ** -SHIFT;

/** m · 2^e as a double (0 when below the double range — then far below any statistic we compare with). */
function value(m: number, e: number): number {
  if (m === 0) return 0;
  let v = m;
  while (e >= SHIFT) {
    v *= UP;
    e -= SHIFT;
  }
  while (e <= -SHIFT) {
    v *= DOWN;
    e += SHIFT;
    if (v === 0) return 0;
  }
  return v * 2 ** e;
}

/**
 * P(Hyper(N, K, n) ≥ k) given P(Hyper = k) = m · 2^e — xlmhg's get_hgp,
 * summing the upper tail term by term. Stops once the remaining terms are
 * below double resolution (past the mode they fall with a falling ratio).
 */
function hgp(m: number, e: number, k: number, N: number, K: number, n: number): number {
  let p = m;
  let sum = m;
  const top = Math.min(K, n);
  while (k < top) {
    const r = ((n - k) * (K - k)) / ((k + 1) * (N - K - n + k + 1));
    p *= r;
    sum += p;
    k++;
    if (sum > UP) {
      sum *= DOWN;
      p *= DOWN;
      e += SHIFT;
    }
    if (r < 1 && p * (r / (1 - r)) < sum * 1e-18) break;
  }
  return value(sum, e);
}

/** The XL-mHG test statistic and the (first) cutoff at which it is attained. */
export function xlmhgStat(indices: ArrayLike<number>, N: number, X: number, L: number, tol = DEFAULT_TOL): { stat: number; cutoff: number } {
  const K = indices.length;
  if (K === 0 || K === N || K < X) return { stat: 1, cutoff: 0 };
  let stat = 1.1;
  let cutoff = 0;
  let n = 0;
  let k = 0;
  let pm = 1; // f(k; N, K, n) = pm · 2^pe
  let pe = 0;
  for (let i = 0; i < K && indices[i] < L; i++) {
    while (n < indices[i]) {
      // f(k; N,K,n+1) from f(k; N,K,n): one more gene outside the term
      pm *= ((n + 1) * (N - K - n + k)) / ((N - n) * (n - k + 1));
      n++;
      if (pm < DOWN) {
        pm *= UP;
        pe -= SHIFT;
      }
    }
    // f(k+1; N,K,n+1) from f(k; N,K,n): one more term gene
    pm *= ((n + 1) * (K - k)) / ((N - n) * (k + 1));
    k++;
    n++;
    if (pm < DOWN) {
      pm *= UP;
      pe -= SHIFT;
    }
    if (k >= X) {
      const h = hgp(pm, pe, k, N, K, n);
      if (h < stat && !isEqual(h, stat, tol)) {
        stat = h;
        cutoff = n;
      }
    }
  }
  return { stat: Math.min(stat, 1), cutoff };
}

/**
 * The XL-mHG p-value: the probability, over all C(N, K) placements of the
 * term's genes, that some cutoff n ≤ L with ≥ X term genes above it reaches
 * a hypergeometric tail ≤ stat. xlmhg's Algorithm 2.
 */
export function xlmhgPval(N: number, K: number, X: number, L: number, stat: number, tol = DEFAULT_TOL): number {
  if (stat >= 1) return 1;
  if (stat <= 0) return 0;
  const W = N - K;
  // prev[k] / cur[k]: probability of reaching (k term genes, n−k others) at
  // cutoff n−1 / n without having entered the rejection region R.
  let prev = new Float64Array(K + 1);
  let cur = new Float64Array(K + 1);
  prev[0] = 1;
  let pval = 0;
  let sm = 1; // p_start = sm · 2^se
  let se = 0;

  for (let n = 1; n <= L; n++) {
    let k: number;
    if (K >= n) {
      k = n;
      sm *= (K - n + 1) / (N - n + 1);
    } else {
      k = K;
      sm *= n / (n - K);
    }
    if (sm < DOWN) {
      sm *= UP;
      se -= SHIFT;
    } else if (sm > UP) {
      sm *= DOWN;
      se += SHIFT;
    }
    // Along the diagonal: p = f(k; N,K,n), h = P(Hyper ≥ k), both · 2^e.
    let p = sm;
    let h = sm;
    let e = se;
    let w = n - k;
    const inv = 1 / (N - n + 1);
    // The statistic in the same scale as h (exact: powers of two), so the
    // hot loop compares plain doubles; ±Infinity/0 when far out of range,
    // which still orders correctly.
    let sT = value(stat, -e);

    if (k === K && !(h < sT || isEqual(h, sT, tol))) break; // left R for good (or never in it)

    // In R: walk down the diagonal until we leave it.
    while (k >= X && w < W && (h < sT || isEqual(h, sT, tol))) {
      cur[k] = 0;
      if (prev[k - 1] > 0) pval += prev[k - 1] * (K - k + 1) * inv; // paths entering R here for the first time
      p *= (k * (N - K - n + k)) / ((n - k + 1) * (K - k + 1));
      h += p;
      if (h > UP) {
        h *= DOWN;
        p *= DOWN;
        e += SHIFT;
        sT = value(stat, -e);
      }
      w++;
      k--;
    }
    // Outside R: paths come in from the left (one more other gene) and from below (one more term gene).
    while (k >= 0 && w <= W) {
      if (k === 0) cur[0] = prev[0] * (W - w + 1) * inv;
      else if (w === 0) cur[k] = prev[k - 1] * (K - k + 1) * inv;
      else cur[k] = prev[k] * (W - w + 1) * inv + prev[k - 1] * (K - k + 1) * inv;
      w++;
      k--;
    }
    [prev, cur] = [cur, prev];
  }
  return pval;
}

export interface XlmhgResult {
  N: number;
  K: number;
  X: number;
  L: number;
  stat: number;
  /** Cutoff (number of top genes) at which the statistic is attained; 0 if none. */
  cutoff: number;
  /** Term genes above the cutoff. */
  k: number;
  /** k / (K · cutoff / N), as xlmhg reports it; NaN when cutoff = 0. */
  fold: number;
  pval: number;
}

/** xlmhg's get_xlmhg_test_result with exact_pval = "always". */
export function xlmhgTest(N: number, indices: ArrayLike<number>, X = 1, L = N, tol = DEFAULT_TOL): XlmhgResult {
  const K = indices.length;
  let stat = 1;
  let cutoff = 0;
  let pval = 1;
  if (X <= Math.min(K, L)) {
    ({ stat, cutoff } = xlmhgStat(indices, N, X, L, tol));
    pval = stat === 1 ? 1 : stat === 0 ? 0 : xlmhgPval(N, K, X, L, stat, tol);
  }
  let k = 0;
  while (k < K && indices[k] < cutoff) k++;
  return { N, K, X, L, stat, cutoff, k, fold: cutoff > 0 ? k / ((K * cutoff) / N) : NaN, pval };
}
