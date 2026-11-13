/**
 * Small, dependency-free statistics for the enrichment modules — see
 * docs/methods.md ("Subset enrichment for reference region sets"). Every
 * function matches R's own implementation, checked in stats.test.ts.
 *
 * 2×2 tables are (a, b, c, d) = (foreground & hit, foreground & no hit,
 * background & hit, background & no hit).
 */

/**
 * Two-sided Fisher's exact test p-value, as R's fisher.test: the sum of
 * the hypergeometric probabilities of every table with the observed margins
 * that is no more probable than the observed one (with R's 1e-7 relative
 * tolerance). Densities come from the ratio recurrence in log space, so
 * genome-scale counts stay exact to ~1e-12 and very small p-values
 * underflow only below ~1e-300 (returned as 0).
 */
export function fisherExact(a: number, b: number, c: number, d: number): number {
  const r1 = a + b;
  const r2 = c + d;
  const c1 = a + c;
  const lo = Math.max(0, c1 - r2);
  const hi = Math.min(r1, c1);
  if (hi <= lo) return 1;

  // log P(x) up to a constant, by P(x+1)/P(x) = (r1-x)(c1-x) / ((x+1)(r2-c1+x+1))
  const n = hi - lo + 1;
  const logd = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const x = lo + i - 1;
    logd[i] = logd[i - 1] + Math.log(((r1 - x) * (c1 - x)) / ((x + 1) * (r2 - c1 + x + 1)));
  }
  let max = -Infinity;
  for (let i = 0; i < n; i++) if (logd[i] > max) max = logd[i];
  const obs = logd[a - lo];
  const cut = obs + Math.log1p(1e-7);
  let total = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    const p = Math.exp(logd[i] - max);
    total += p;
    if (logd[i] <= cut) tail += p;
  }
  return Math.min(1, tail / total);
}

/** Sample odds ratio ad/bc; with any zero cell, 0.5 is added to every cell (Haldane–Anscombe). NaN when the foreground or background is empty. */
export function oddsRatio(a: number, b: number, c: number, d: number): number {
  if (a + b === 0 || c + d === 0) return NaN;
  if (a === 0 || b === 0 || c === 0 || d === 0) {
    a += 0.5;
    b += 0.5;
    c += 0.5;
    d += 0.5;
  }
  return (a * d) / (b * c);
}

/**
 * Cochran–Mantel–Haenszel test over 2×2 strata with continuity correction,
 * and the Mantel–Haenszel common odds ratio — as R's mantelhaen.test(x,
 * correct = TRUE) for a 2×2×K table. Strata with fewer than two
 * observations carry no information and are skipped.
 */
export function mantelHaenszel(strata: [number, number, number, number][]): { oddsRatio: number; p: number } {
  let sumA = 0;
  let sumE = 0;
  let sumV = 0;
  let num = 0;
  let den = 0;
  for (const [a, b, c, d] of strata) {
    const n = a + b + c + d;
    if (n < 2) continue;
    const r1 = a + b;
    const r2 = c + d;
    const c1 = a + c;
    const c2 = b + d;
    sumA += a;
    sumE += (r1 * c1) / n;
    sumV += (r1 * r2 * c1 * c2) / (n * n * (n - 1));
    num += (a * d) / n;
    den += (b * c) / n;
  }
  const or = den > 0 ? num / den : num > 0 ? Infinity : NaN;
  if (!(sumV > 0)) return { oddsRatio: or, p: 1 };
  const delta = Math.abs(sumA - sumE);
  const yates = delta >= 0.5 ? 0.5 : 0;
  const stat = (delta - yates) ** 2 / sumV;
  return { oddsRatio: or, p: chiSquare1Upper(stat) };
}

/** Benjamini–Hochberg adjusted p-values, as R's p.adjust(p, "BH"), in input order. */
export function benjaminiHochberg(p: number[]): number[] {
  const n = p.length;
  const order = p.map((_, i) => i).sort((i, j) => p[j] - p[i]); // descending
  const q = new Array<number>(n);
  let running = 1;
  for (let k = 0; k < n; k++) {
    const i = order[k];
    const rank = n - k;
    running = Math.min(running, (p[i] * n) / rank);
    q[i] = Math.min(1, running);
  }
  return q;
}

// ---- chi-square(1) upper tail = Q(1/2, x/2), the regularised upper incomplete gamma ----

const LOG_GAMMA_HALF = 0.5 * Math.log(Math.PI);

function chiSquare1Upper(x: number): number {
  if (!(x > 0)) return 1;
  return gammaQHalf(x / 2);
}

/** Q(0.5, x) to ~1e-15 relative: series for small x, Lentz continued fraction otherwise. */
function gammaQHalf(x: number): number {
  const a = 0.5;
  const prefix = -x + a * Math.log(x) - LOG_GAMMA_HALF;
  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let k = 1; k < 500; k++) {
      term *= x / (a + k);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-16) break;
    }
    return 1 - sum * Math.exp(prefix);
  }
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return Math.exp(prefix) * h;
}

// ---- upper tails of the binomial and hypergeometric (GREAT's two tests) ----

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** log Γ(x) for x > 0 (Lanczos, g = 7): ~1e-15 relative. */
export function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = LANCZOS[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function logChoose(n: number, k: number): number {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/**
 * Sum a unimodal pmf's tail from `start`, walking away from the mode with
 * the term ratio `next(i)` = pmf(i + step) / pmf(i), relative to pmf(start)
 * so it never underflows before the end. Returns log of the tail sum.
 */
function logTail(logStart: number, start: number, end: number, step: 1 | -1, ratio: (i: number) => number): number {
  let sum = 1;
  let term = 1;
  for (let i = start; i !== end; i += step) {
    term *= ratio(i);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return logStart + Math.log(sum);
}

/** P(X ≥ k) for X ~ Binomial(n, p), as R's pbinom(k − 1, n, p, lower.tail = FALSE). */
export function binomialUpper(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n || p <= 0) return 0;
  if (p >= 1) return 1;
  const logPmf = (i: number) => logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log1p(-p);
  const odds = p / (1 - p);
  const mode = Math.floor((n + 1) * p);
  if (k > mode) {
    // Upper tail directly: terms fall away from the mode.
    return Math.exp(logTail(logPmf(k), k, n, 1, (i) => ((n - i) / (i + 1)) * odds));
  }
  // The upper tail is large here; 1 − lower tail is accurate.
  const lower = Math.exp(logTail(logPmf(k - 1), k - 1, 0, -1, (i) => (i / (n - i + 1)) / odds));
  return Math.min(1, Math.max(0, 1 - lower));
}

/**
 * P(X ≥ j) for X ~ Hypergeometric: m draws without replacement from N items
 * of which K are successes — as R's phyper(j − 1, K, N − K, m, lower.tail = FALSE).
 */
export function hypergeometricUpper(j: number, N: number, K: number, m: number): number {
  const lo = Math.max(0, m - (N - K));
  const hi = Math.min(K, m);
  if (j <= lo) return 1;
  if (j > hi) return 0;
  const logPmf = (x: number) => logChoose(K, x) + logChoose(N - K, m - x) - logChoose(N, m);
  const up = (x: number) => ((K - x) * (m - x)) / ((x + 1) * (N - K - m + x + 1));
  const mode = Math.floor(((m + 1) * (K + 1)) / (N + 2));
  if (j > mode) return Math.exp(logTail(logPmf(j), j, hi, 1, up));
  const lower = Math.exp(logTail(logPmf(j - 1), j - 1, lo, -1, (x) => 1 / up(x - 1)));
  return Math.min(1, Math.max(0, 1 - lower));
}
