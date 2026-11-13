import { benjaminiHochberg, binomialUpper, fisherExact, hypergeometricUpper, oddsRatio } from "./stats";

/**
 * GREAT-style GO enrichment, implemented exactly as specified in
 * docs/methods.md ("GO enrichment of selected subsets — GREAT-like"): basal-plus-
 * extension regulatory domains, regions reduced to their left-median base,
 * GREAT's binomial (regions, non-gap genome) and hypergeometric (genes)
 * tests, or a Fisher test against the analysis's other regions. Pure
 * TypeScript — no bedtools — so it is fully testable in Node; checked
 * against native bedtools and R in great.test.ts / stats.test.ts.
 *
 * Data: refdata/<assembly>/go/go.json and gaps.bed, built by
 * public/refdata/build_go.py.
 */

export type GoNamespace = "BP" | "MF" | "CC";
export const GO_NAMESPACES: { id: GoNamespace; label: string }[] = [
  { id: "BP", label: "Biological process" },
  { id: "MF", label: "Molecular function" },
  { id: "CC", label: "Cellular component" },
];

/** [symbol, chrom, 0-based TSS base, strand] */
export type GreatGene = [string, string, number, string];

export interface GoData {
  source?: Record<string, string | number | null>;
  genes: GreatGene[];
  /** Per namespace: [GO id, name, gene indices]. */
  terms: Record<GoNamespace, [string, string, number[]][]>;
}

export interface Domain {
  chrom: string;
  start: number;
  end: number;
}

/** GREAT's basal-plus-extension rule: basal domain upstream/downstream of the TSS, extension cap each way. */
export interface GreatRule {
  upstream: number;
  downstream: number;
  maxExtension: number;
}

export interface GreatSettings extends GreatRule {
  /** Term size limits (genes annotated), inclusive. */
  minGenes: number;
  maxGenes: number;
  /** A term is significant when both q-values are below this (genome background), or q is (input sets)… */
  qThreshold: number;
  /** …and, against the genome, the binomial fold enrichment is at least this. */
  minFold: number;
}

/** GREAT's defaults (McLean et al. 2010; great.stanford.edu): 5 kb up, 1 kb down, 1 Mb; q < 0.05, fold ≥ 2. Terms of 5–1,000 genes. */
export const GREAT_DEFAULTS: GreatSettings = {
  upstream: 5000,
  downstream: 1000,
  maxExtension: 1_000_000,
  minGenes: 5,
  maxGenes: 1000,
  qThreshold: 0.05,
  minFold: 2,
};

const termsInRange = <T extends [string, string, number[]]>(terms: T[], s: Pick<GreatSettings, "minGenes" | "maxGenes">) =>
  terms.map((t, i) => [t, i] as const).filter(([t]) => t[2].length >= s.minGenes && t[2].length <= s.maxGenes);

/** GREAT reduces a region to its left-median base (0-based). */
export function leftMedian(start: number, end: number): number {
  return end - start <= 1 ? start : start + Math.floor((end - start - 1) / 2);
}

/** Basal-plus-extension domain of every gene (same order as `genes`). Genes on chromosomes without a size get an empty domain. */
export function regulatoryDomains(genes: GreatGene[], chromSizes: Record<string, number>, rule: GreatRule = GREAT_DEFAULTS): Domain[] {
  const { upstream: UPSTREAM, downstream: DOWNSTREAM, maxExtension: MAX_EXTENSION } = rule;
  const out: Domain[] = genes.map(([, chrom]) => ({ chrom, start: 0, end: 0 }));
  const byChrom = new Map<string, number[]>();
  genes.forEach(([, chrom], i) => {
    if (chromSizes[chrom] === undefined) return;
    const list = byChrom.get(chrom);
    if (list) list.push(i);
    else byChrom.set(chrom, [i]);
  });

  for (const [chrom, idx] of byChrom) {
    const len = chromSizes[chrom];
    const clip = (x: number) => Math.min(len, Math.max(0, x));
    const bs = new Map<number, number>();
    const be = new Map<number, number>();
    for (const i of idx) {
      const [, , t, strand] = genes[i];
      bs.set(i, clip(strand === "-" ? t - DOWNSTREAM : t - UPSTREAM));
      be.set(i, clip(strand === "-" ? t + UPSTREAM + 1 : t + DOWNSTREAM + 1));
    }

    // Left limit: max basal end among genes whose basal starts strictly before this one's.
    const left = new Map<number, number>();
    const byStart = [...idx].sort((a, b) => bs.get(a)! - bs.get(b)!);
    let runMax = 0;
    for (let g = 0; g < byStart.length; ) {
      let h = g;
      while (h < byStart.length && bs.get(byStart[h]) === bs.get(byStart[g])) h++;
      for (let x = g; x < h; x++) left.set(byStart[x], runMax);
      for (let x = g; x < h; x++) runMax = Math.max(runMax, be.get(byStart[x])!);
      g = h;
    }
    // Right limit: min basal start among genes whose basal ends strictly after this one's.
    const right = new Map<number, number>();
    const byEnd = [...idx].sort((a, b) => be.get(b)! - be.get(a)!);
    let runMin = len;
    for (let g = 0; g < byEnd.length; ) {
      let h = g;
      while (h < byEnd.length && be.get(byEnd[h]) === be.get(byEnd[g])) h++;
      for (let x = g; x < h; x++) right.set(byEnd[x], runMin);
      for (let x = g; x < h; x++) runMin = Math.min(runMin, bs.get(byEnd[x])!);
      g = h;
    }

    for (const i of idx) {
      const t = genes[i][2];
      out[i] = {
        chrom,
        start: Math.min(bs.get(i)!, Math.max(left.get(i)!, t - MAX_EXTENSION, 0)),
        end: Math.max(be.get(i)!, Math.min(right.get(i)!, t + MAX_EXTENSION + 1, len)),
      };
    }
  }
  return out;
}

export interface PreparedGreat {
  data: GoData;
  domains: Domain[];
  /** Chromosomes of the genome (those with genes and a size). */
  chroms: Set<string>;
  /** Non-gap genome size. */
  genomeBp: number;
  nGenes: number;
  /** Union of the term's domains minus gaps, in bp (cached). */
  termBp: (ns: GoNamespace, id: string) => number;
  /** For each gene, the indices (into data.terms[ns]) of its terms. */
  geneTerms: (ns: GoNamespace) => number[][];
}

export function prepareGreat(data: GoData, chromSizes: Record<string, number>, gapsText: string, rule: GreatRule = GREAT_DEFAULTS): PreparedGreat {
  const domains = regulatoryDomains(data.genes, chromSizes, rule);
  const chroms = new Set(data.genes.map((g) => g[1]).filter((c) => chromSizes[c] !== undefined));

  // Gaps: merged per chromosome, with prefix sums for "gap bp inside [s, e)".
  const raw = new Map<string, [number, number][]>();
  for (const line of gapsText.split("\n")) {
    if (!line) continue;
    const [c, s, e] = line.split("\t");
    if (!chroms.has(c)) continue;
    const list = raw.get(c) ?? [];
    list.push([+s, +e]);
    raw.set(c, list);
  }
  const gaps = new Map<string, { starts: number[]; ends: number[]; cum: number[] }>();
  for (const [c, list] of raw) {
    list.sort((a, b) => a[0] - b[0]);
    const starts: number[] = [];
    const ends: number[] = [];
    for (const [s, e] of list) {
      if (ends.length && s <= ends[ends.length - 1]) ends[ends.length - 1] = Math.max(ends[ends.length - 1], e);
      else {
        starts.push(s);
        ends.push(e);
      }
    }
    const cum = [0];
    for (let i = 0; i < starts.length; i++) cum.push(cum[i] + ends[i] - starts[i]);
    gaps.set(c, { starts, ends, cum });
  }
  const gapBpIn = (c: string, s: number, e: number): number => {
    const g = gaps.get(c);
    if (!g || s >= e) return 0;
    // first gap ending after s
    let lo = 0;
    let hi = g.starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (g.ends[mid] <= s) lo = mid + 1;
      else hi = mid;
    }
    let bp = 0;
    for (let i = lo; i < g.starts.length && g.starts[i] < e; i++) bp += Math.min(e, g.ends[i]) - Math.max(s, g.starts[i]);
    return bp;
  };

  let genomeBp = 0;
  for (const c of chroms) genomeBp += chromSizes[c] - gapBpIn(c, 0, chromSizes[c]);

  const termBpCache = new Map<string, number>();
  const termIndex = new Map<string, number[]>();
  for (const ns of GO_NAMESPACES) for (const [id, , genes] of data.terms[ns.id]) termIndex.set(`${ns.id}:${id}`, genes);
  const termBp = (ns: GoNamespace, id: string): number => {
    const key = `${ns}:${id}`;
    const cached = termBpCache.get(key);
    if (cached !== undefined) return cached;
    const ivs = (termIndex.get(key) ?? []).map((g) => domains[g]).filter((d) => d.end > d.start && chroms.has(d.chrom));
    ivs.sort((a, b) => (a.chrom < b.chrom ? -1 : a.chrom > b.chrom ? 1 : a.start - b.start));
    let bp = 0;
    let cur: Domain | null = null;
    const flush = () => {
      if (cur) bp += cur.end - cur.start - gapBpIn(cur.chrom, cur.start, cur.end);
    };
    for (const d of ivs) {
      if (cur && d.chrom === cur.chrom && d.start <= cur.end) cur.end = Math.max(cur.end, d.end);
      else {
        flush();
        cur = { ...d };
      }
    }
    flush();
    termBpCache.set(key, bp);
    return bp;
  };

  const geneTermsCache = new Map<GoNamespace, number[][]>();
  const geneTerms = (ns: GoNamespace): number[][] => {
    let out = geneTermsCache.get(ns);
    if (!out) {
      out = data.genes.map(() => []);
      data.terms[ns].forEach(([, , genes], t) => {
        for (const g of genes) out![g].push(t);
      });
      geneTermsCache.set(ns, out);
    }
    return out;
  };

  return { data, domains, chroms, genomeBp, nGenes: data.genes.length, termBp, geneTerms };
}

/**
 * The genes each region selects: those whose domain contains its
 * left-median base, ascending. null for a region on a chromosome outside
 * the genome (not counted).
 */
export function assignRegions(regions: { chrom: string; start: number; end: number }[], prepared: PreparedGreat): (number[] | null)[] {
  const out: (number[] | null)[] = regions.map((r) => (prepared.chroms.has(r.chrom) ? [] : null));
  const domainsByChrom = new Map<string, number[]>();
  prepared.domains.forEach((d, i) => {
    if (d.end <= d.start) return;
    const list = domainsByChrom.get(d.chrom) ?? [];
    list.push(i);
    domainsByChrom.set(d.chrom, list);
  });
  const regionsByChrom = new Map<string, number[]>();
  regions.forEach((r, i) => {
    if (out[i] === null) return;
    const list = regionsByChrom.get(r.chrom) ?? [];
    list.push(i);
    regionsByChrom.set(r.chrom, list);
  });
  for (const [chrom, ridx] of regionsByChrom) {
    const dom = (domainsByChrom.get(chrom) ?? []).sort((a, b) => prepared.domains[a].start - prepared.domains[b].start);
    const mids = ridx.map((i) => [leftMedian(regions[i].start, regions[i].end), i] as const).sort((a, b) => a[0] - b[0]);
    let next = 0;
    let active: number[] = [];
    for (const [m, i] of mids) {
      while (next < dom.length && prepared.domains[dom[next]].start <= m) active.push(dom[next++]);
      active = active.filter((d) => prepared.domains[d].end > m);
      out[i] = [...active].sort((a, b) => a - b);
    }
  }
  return out;
}

export interface GreatRow {
  id: string;
  name: string;
  /** Regions counted, and those selecting ≥ 1 gene of the term. */
  n: number;
  k: number;
  /** Fraction of the non-gap genome in the term's domains. */
  fraction: number;
  binomP: number;
  binomFold: number;
  binomQ: number;
  /** Genes: all, annotated to the term, selected, selected and annotated. */
  N: number;
  K: number;
  m: number;
  j: number;
  hyperP: number;
  hyperFold: number;
  hyperQ: number;
  /** GREAT's filter: both q below the threshold (default 0.05) and binomial fold ≥ the minimum (default 2). */
  significant: boolean;
}

/** Background "genome": GREAT's binomial and hypergeometric tests for every term of a namespace. */
export function greatTest(
  prepared: PreparedGreat,
  regionGenes: (number[] | null)[],
  ns: GoNamespace,
  settings: Pick<GreatSettings, "minGenes" | "maxGenes" | "qThreshold" | "minFold"> = GREAT_DEFAULTS
): GreatRow[] {
  const terms = prepared.data.terms[ns];
  const geneTerms = prepared.geneTerms(ns);
  const k = new Int32Array(terms.length);
  const stamp = new Int32Array(terms.length).fill(-1);
  const selected = new Set<number>();
  let n = 0;
  regionGenes.forEach((genes, r) => {
    if (!genes) return;
    n++;
    for (const g of genes) {
      selected.add(g);
      for (const t of geneTerms[g]) {
        if (stamp[t] !== r) {
          stamp[t] = r;
          k[t]++;
        }
      }
    }
  });
  const j = new Int32Array(terms.length);
  for (const g of selected) for (const t of geneTerms[g]) j[t]++;
  const N = prepared.nGenes;
  const m = selected.size;

  const rows = termsInRange(terms, settings).map(([[id, name, genes], t]): Omit<GreatRow, "binomQ" | "hyperQ" | "significant"> => {
    const fraction = prepared.termBp(ns, id) / prepared.genomeBp;
    const K = genes.length;
    return {
      id,
      name,
      n,
      k: k[t],
      fraction,
      binomP: binomialUpper(k[t], n, fraction),
      binomFold: n * fraction > 0 ? k[t] / (n * fraction) : NaN,
      N,
      K,
      m,
      j: j[t],
      hyperP: hypergeometricUpper(j[t], N, K, m),
      hyperFold: m > 0 ? j[t] / ((m * K) / N) : NaN,
    };
  });
  const bq = benjaminiHochberg(rows.map((r) => r.binomP));
  const hq = benjaminiHochberg(rows.map((r) => r.hyperP));
  return rows.map((r, i) => ({
    ...r,
    binomQ: bq[i],
    hyperQ: hq[i],
    significant: bq[i] < settings.qThreshold && hq[i] < settings.qThreshold && r.binomFold >= settings.minFold,
  }));
}

export interface InputsGoRow {
  id: string;
  name: string;
  /** Genes annotated to the term. */
  K: number;
  /** In subset & selects a term gene, in subset & not, rest & selects, rest & not. */
  table: [number, number, number, number];
  oddsRatio: number;
  p: number;
  q: number;
}

/** Background "input sets": Fisher's exact test per term, subset regions vs the analysis's other regions. */
export function inputsGoTest(
  prepared: PreparedGreat,
  universeGenes: (number[] | null)[],
  owner: Int32Array,
  mask: number,
  ns: GoNamespace,
  settings: Pick<GreatSettings, "minGenes" | "maxGenes"> = GREAT_DEFAULTS
): InputsGoRow[] {
  const terms = prepared.data.terms[ns];
  const geneTerms = prepared.geneTerms(ns);
  const inS = new Int32Array(terms.length);
  const inRest = new Int32Array(terms.length);
  const stamp = new Int32Array(terms.length).fill(-1);
  let nS = 0;
  let nRest = 0;
  universeGenes.forEach((genes, r) => {
    const mine = owner[r] === mask;
    if (mine) nS++;
    else nRest++;
    for (const g of genes ?? []) {
      for (const t of geneTerms[g]) {
        if (stamp[t] === r) continue;
        stamp[t] = r;
        if (mine) inS[t]++;
        else inRest[t]++;
      }
    }
  });
  const rows = termsInRange(terms, settings).map(([[id, name, genes], t]): Omit<InputsGoRow, "q"> => {
    const table: [number, number, number, number] = [inS[t], nS - inS[t], inRest[t], nRest - inRest[t]];
    return { id, name, K: genes.length, table, oddsRatio: oddsRatio(...table), p: fisherExact(...table) };
  });
  const q = benjaminiHochberg(rows.map((r) => r.p));
  return rows.map((r, i) => ({ ...r, q: q[i] }));
}
