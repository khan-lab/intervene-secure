import type { GoData, GoNamespace } from "./great";
import { benjaminiHochberg } from "./stats";
import { xlmhgTest } from "./xlmhg";

/**
 * Cistrome-GO solo mode (Li S, Wan C, Zheng R, et al. NAR 2019;47:W206),
 * ported from the package (https://github.com/changxinw/Cistrome-GO,
 * commit 6b7f003, MIT): rpscore.py (peak selection, promoter fraction and
 * automatic half-decay distance, regulatory potential, background
 * adjustment) and enrichment.py (gene ranking, XL-mHG per term, BH).
 * Specified in docs/methods.md ("GO enrichment of selected subsets —
 * Cistrome-GO-like"); shown to users as "Cistrome-GO-like": the approach,
 * reimplemented, not a copy of the tool. Checked against the package's own code on real ENCODE
 * peaks in cistromeGo.test.ts.
 *
 * Three deliberate differences from the package, all documented in
 * docs/methods.md:
 *  - every peak within 15 × decay of a TSS counts. The package's sweep
 *    (peaksInRange) drops the downstream peaks of transcripts at the end of
 *    the last chromosome with peaks (in practice the end of chrX) — a
 *    bookkeeping slip; cistromeGo.test.ts reproduces it exactly to show it
 *    is the only difference in RP;
 *  - gene ranks are 0-based positions for XL-mHG (the package passes
 *    1-based ranks where xlmhg expects 0-based indices, which shifts every
 *    gene down one place);
 *  - GO annotation is the app's current GO release (go.json) mapped onto
 *    the package's gene symbols, with the package's redundancy filter
 *    (Jaccard > 0.85) applied at run time, instead of its 2018 GO files.
 *
 * Data: refdata/<assembly>/cistromego/rp_model.json, built by
 * public/refdata/build_cistromego.py from the package's own files.
 */

export interface RpModel {
  source?: Record<string, unknown>;
  /** Gene symbols, sorted. */
  symbols: string[];
  /** Background RP per symbol (median scaled RP over Cistrome DB ChIP-seq), for half-decay ≤ 1 kb and > 1 kb. */
  bg1k: number[];
  bg10k: number[];
  /** RefSeq transcript TSSs per chromosome, sorted: [position, symbol index]. */
  tss: Record<string, [number, number][]>;
}

export interface CgoPeak {
  chrom: string;
  start: number;
  end: number;
  /** Column 5 of the BED/narrowPeak line, when there is one. */
  score?: number;
}

export interface CistromeGoSettings {
  /** Half-decay distance in bp, or "auto" (1 kb if promoter-type, else 10 kb). */
  decay: "auto" | number;
  /** Peaks used for RP: the top N by score (when every peak has one), or all. */
  topPeaks: number | "all";
  /** Term size limits (genes in the ranked list), inclusive. The package keeps 10 < size < 2000. */
  minGenes: number;
  maxGenes: number;
  /** Upper limit for XL-mHG's L. */
  maxL: number;
  /** Drop a term whose genes overlap a larger kept term with Jaccard > 0.85. */
  dedup: boolean;
  /** FDR below which a term is called enriched (go.cistrome.org reports FDR < 0.2). */
  qThreshold: number;
}

/** The package's defaults (README / opt_validator.py / enrichment.py; FDR display cut from the paper). */
export const CISTROMEGO_DEFAULTS: CistromeGoSettings = {
  decay: "auto",
  topPeaks: 10_000,
  minGenes: 11,
  maxGenes: 1999,
  maxL: 2000,
  dedup: true,
  qThreshold: 0.2,
};

/** Half-decay choices offered by the package (-d): auto, 0.5k, 1k, 10k, 50k, 100k, 500k. */
export const DECAY_CHOICES: ("auto" | number)[] = ["auto", 500, 1000, 10_000, 50_000, 100_000, 500_000];

const PROMOTER_TOPS = [2000, 5000, 10_000, 1_000_000] as const;
const PROMOTER_DISTANCE = 1000;
const PROMOTER_THRESHOLD = 0.2;
const DEDUP_JACCARD = 0.85;

const centre = (p: CgoPeak) => (p.start + p.end) / 2;

/**
 * Cistrome-GO's readPeaks: with a score on every peak, peaks sorted by
 * score (highest first, ties in file order) and the top N used; otherwise
 * every peak, in file order.
 */
export function selectPeaks(peaks: CgoPeak[], top: number | "all"): { ordered: CgoPeak[]; used: CgoPeak[]; scored: boolean } {
  const scored = peaks.length > 0 && peaks.every((p) => p.score !== undefined && Number.isFinite(p.score));
  if (!scored) return { ordered: peaks, used: peaks, scored };
  const ordered = peaks
    .map((p, i) => [p, i] as const)
    .sort((a, b) => b[0].score! - a[0].score! || a[1] - b[1])
    .map(([p]) => p);
  return { ordered, used: top === "all" ? ordered : ordered.slice(0, top), scored };
}

function lowerBound(arr: [number, number][], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid][0] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * propCalc: for the top 2,000, 5,000, 10,000 and all peaks (in `ordered`),
 * the share whose centre is within 1 kb of the nearest transcript TSS.
 * Peaks on chromosomes without a TSS count in the denominator.
 */
export function promoterFractions(ordered: CgoPeak[], model: RpModel): Record<number, number> {
  const near = ordered.map((p) => {
    const t = model.tss[p.chrom];
    if (!t?.length) return false;
    const c = centre(p);
    const i = lowerBound(t, c);
    const d = Math.min(i < t.length ? t[i][0] - c : Infinity, i > 0 ? c - t[i - 1][0] : Infinity);
    return d <= PROMOTER_DISTANCE;
  });
  const out: Record<number, number> = {};
  for (const top of PROMOTER_TOPS) {
    const n = Math.min(top, near.length);
    let k = 0;
    for (let i = 0; i < n; i++) if (near[i]) k++;
    out[top] = n ? k / n : 0;
  }
  return out;
}

/** "auto": 1 kb when any promoter fraction reaches 20% (promoter-type), else 10 kb. */
export function chooseDecay(option: "auto" | number, fractions: Record<number, number>): number {
  if (option !== "auto") return option;
  return Math.max(...Object.values(fractions)) >= PROMOTER_THRESHOLD ? 1000 : 10_000;
}

/**
 * Raw regulatory potential per symbol: for each transcript, Σ 2^(−d/decay)
 * over peaks whose centre is within d ≤ 15 × decay of its TSS; a symbol
 * takes its highest-scoring transcript.
 */
export function regulatoryPotential(used: CgoPeak[], model: RpModel, decay: number): Float64Array {
  const rp = new Float64Array(model.symbols.length);
  const pad = 15 * decay;
  const byChrom = new Map<string, number[]>();
  for (const p of used) {
    const list = byChrom.get(p.chrom);
    if (list) list.push(centre(p));
    else byChrom.set(p.chrom, [centre(p)]);
  }
  for (const [chrom, centres] of byChrom) {
    const tss = model.tss[chrom];
    if (!tss) continue;
    centres.sort((a, b) => a - b);
    let lo = 0;
    for (const [pos, sym] of tss) {
      while (lo < centres.length && centres[lo] < pos - pad) lo++;
      let s = 0;
      for (let i = lo; i < centres.length && centres[i] <= pos + pad; i++) s += 2 ** (-Math.abs(centres[i] - pos) / decay);
      if (s > rp[sym]) rp[sym] = s;
    }
  }
  return rp;
}

/** Min-max scale to [0, 1], then subtract the gene's background RP (1 kb table for decay ≤ 1 kb, else 10 kb). */
export function adjustRp(raw: Float64Array, model: RpModel, decay: number): Float64Array {
  let min = Infinity;
  let max = -Infinity;
  for (const v of raw) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const gap = max - min;
  const bg = decay <= 1000 ? model.bg1k : model.bg10k;
  return raw.map((v, i) => (gap > 0 ? (v - min) / gap : 0) - bg[i]);
}

export interface GeneRanking {
  /** Symbol indices, highest adjusted RP first (ties by symbol). */
  order: number[];
  N: number;
  /** Genes in the list with adjusted RP > 0. */
  nPositive: number;
  /** XL-mHG's L: min(maxL, nPositive). */
  L: number;
}

/** Rank the namespace's genes by adjusted RP. */
export function rankGenes(adj: Float64Array, universe: number[], maxL: number): GeneRanking {
  const order = [...universe].sort((a, b) => adj[b] - adj[a] || a - b);
  const nPositive = order.filter((g) => adj[g] > 0).length;
  return { order, N: order.length, nPositive, L: Math.min(maxL, nPositive) };
}

type Term = [string, string, number[]];

/**
 * Cistrome-GO's redundancy filter: going from the largest term down (ties
 * by GO id), a term is dropped when its genes have Jaccard index > the
 * threshold with a term already kept. Returns kept terms in input order.
 */
export function dedupTerms(terms: Term[], threshold = DEDUP_JACCARD): Term[] {
  const order = terms.map((_, i) => i).sort((a, b) => terms[b][2].length - terms[a][2].length || (terms[a][0] < terms[b][0] ? -1 : 1));
  const keep = new Uint8Array(terms.length);
  const geneToKept = new Map<number, number[]>();
  const shared = new Map<number, number>();
  for (const t of order) {
    const genes = terms[t][2];
    shared.clear();
    for (const g of genes) for (const k of geneToKept.get(g) ?? []) shared.set(k, (shared.get(k) ?? 0) + 1);
    let redundant = false;
    for (const [k, inter] of shared) {
      if (inter / (genes.length + terms[k][2].length - inter) > threshold) {
        redundant = true;
        break;
      }
    }
    if (redundant) continue;
    keep[t] = 1;
    for (const g of genes) {
      const list = geneToKept.get(g);
      if (list) list.push(t);
      else geneToKept.set(g, [t]);
    }
  }
  return terms.filter((_, i) => keep[i]);
}

export interface PreparedCistromeGo {
  model: RpModel;
  /** Symbol indices of the genes annotated in the namespace (the ranked list). */
  universe: (ns: GoNamespace) => number[];
  /** The namespace's terms as symbol indices, after the redundancy filter (if on) and size limits. */
  terms: (ns: GoNamespace, settings: Pick<CistromeGoSettings, "minGenes" | "maxGenes" | "dedup">) => Term[];
}

/** Map the GO release onto the gene model's symbols. */
export function prepareCistromeGo(model: RpModel, go: GoData): PreparedCistromeGo {
  const symIndex = new Map(model.symbols.map((s, i) => [s, i]));
  const goToModel = go.genes.map(([sym]) => symIndex.get(sym) ?? -1);
  const mapped = new Map<GoNamespace, Term[]>();
  const deduped = new Map<GoNamespace, Term[]>();
  const universes = new Map<GoNamespace, number[]>();
  const mappedTerms = (ns: GoNamespace): Term[] => {
    let m = mapped.get(ns);
    if (!m) {
      m = go.terms[ns].map(([id, name, genes]): Term => [id, name, [...new Set(genes.map((g) => goToModel[g]).filter((g) => g >= 0))].sort((a, b) => a - b)]);
      mapped.set(ns, m);
    }
    return m;
  };
  return {
    model,
    universe: (ns) => {
      let u = universes.get(ns);
      if (!u) {
        u = [...new Set(mappedTerms(ns).flatMap((t) => t[2]))].sort((a, b) => a - b);
        universes.set(ns, u);
      }
      return u;
    },
    terms: (ns, s) => {
      let base = mappedTerms(ns);
      if (s.dedup) {
        let d = deduped.get(ns);
        if (!d) {
          d = dedupTerms(base);
          deduped.set(ns, d);
        }
        base = d;
      }
      return base.filter((t) => t[2].length >= s.minGenes && t[2].length <= s.maxGenes);
    },
  };
}

export interface CgoRow {
  id: string;
  name: string;
  /** Ranked genes, term genes among them, XL-mHG L. */
  N: number;
  K: number;
  L: number;
  /** Top genes at the XL-mHG cutoff, and term genes among them. */
  cutoff: number;
  k: number;
  /** k / (K · cutoff / N). */
  fold: number;
  stat: number;
  p: number;
  q: number;
  /** The term's genes above the cutoff, highest adjusted RP first. */
  leadGenes: string[];
}

export interface CistromeGoResult {
  scored: boolean;
  nPeaksUsed: number;
  fractions: Record<number, number>;
  decay: number;
  ranking: GeneRanking;
  rows: CgoRow[];
}

function setup(prepared: PreparedCistromeGo, peaks: CgoPeak[], ns: GoNamespace, settings: CistromeGoSettings) {
  const { model } = prepared;
  const sel = selectPeaks(peaks, settings.topPeaks);
  const fractions = promoterFractions(sel.ordered, model);
  const decay = chooseDecay(settings.decay, fractions);
  const adj = adjustRp(regulatoryPotential(sel.used, model, decay), model, decay);
  const ranking = rankGenes(adj, prepared.universe(ns), settings.maxL);
  const pos = new Int32Array(model.symbols.length).fill(-1);
  ranking.order.forEach((g, i) => (pos[g] = i));
  const terms = prepared.terms(ns, settings);
  const testTerm = ([id, name, genes]: Term): Omit<CgoRow, "q"> => {
    const idx = Int32Array.from(genes, (g) => pos[g]).sort();
    const r = xlmhgTest(ranking.N, idx, 1, ranking.L);
    const leadGenes = Array.from(idx.subarray(0, r.k), (i) => model.symbols[ranking.order[i]]);
    return { id, name, N: ranking.N, K: r.K, L: ranking.L, cutoff: r.cutoff, k: r.k, fold: r.fold, stat: r.stat, p: r.pval, leadGenes };
  };
  const finish = (partial: Omit<CgoRow, "q">[]): CistromeGoResult => {
    const q = benjaminiHochberg(partial.map((r) => r.p));
    return { scored: sel.scored, nPeaksUsed: sel.used.length, fractions, decay, ranking, rows: partial.map((r, i) => ({ ...r, q: q[i] })) };
  };
  return { terms, testTerm, finish };
}

/** The whole Cistrome-GO solo-mode analysis of one region set for one GO namespace. */
export function cistromeGoTest(prepared: PreparedCistromeGo, peaks: CgoPeak[], ns: GoNamespace, settings: CistromeGoSettings): CistromeGoResult {
  const { terms, testTerm, finish } = setup(prepared, peaks, ns, settings);
  return finish(terms.map(testTerm));
}

/**
 * The same analysis, yielding to the event loop every `sliceMs` so a page
 * stays responsive (XL-mHG p-values for thousands of terms take seconds),
 * and reporting how many terms are done.
 */
export async function cistromeGoTestAsync(
  prepared: PreparedCistromeGo,
  peaks: CgoPeak[],
  ns: GoNamespace,
  settings: CistromeGoSettings,
  onProgress?: (done: number, total: number) => void,
  sliceMs = 40
): Promise<CistromeGoResult> {
  const { terms, testTerm, finish } = setup(prepared, peaks, ns, settings);
  const partial: Omit<CgoRow, "q">[] = [];
  let t0 = performance.now();
  for (const term of terms) {
    partial.push(testTerm(term));
    if (performance.now() - t0 > sliceMs) {
      onProgress?.(partial.length, terms.length);
      await new Promise((r) => setTimeout(r, 0));
      t0 = performance.now();
    }
  }
  onProgress?.(terms.length, terms.length);
  return finish(partial);
}
