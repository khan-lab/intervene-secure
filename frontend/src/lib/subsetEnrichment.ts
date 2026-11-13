import * as bedtools from "./bedtools";
import { EXTERNAL_ANNOTATIONS, type ExternalAnnotation } from "./externalAnnotations";
import { parseIntersectCounts } from "./pipeline";
import { benjaminiHochberg, fisherExact, mantelHaenszel, oddsRatio } from "./stats";
import type { Interval } from "../types";

/**
 * Subset enrichment for the built-in reference region sets — the null
 * models are specified in docs/methods.md ("Subset enrichment for
 * reference region sets"); this file implements exactly that.
 *
 * Input-sets background: the universe is every region assigned to some
 * subset (each input locus once). One `bedtools intersect -c` per
 * reference set flags which universe regions hit it; every (subset,
 * reference set) 2×2 table then comes from those flags in plain JS, so the
 * number of bedtools runs doesn't grow with the number of subsets.
 *
 * There is deliberately no whole-genome background here: `bedtools
 * fisher`, the obvious candidate, degenerates when interval sizes differ
 * greatly (subset peaks of ~30 kb vs 1-bp variants) — see
 * docs/methods.md.
 */

const MOUNT_DIR = "/shared/data";
const LENGTH_STRATA = 5;

export interface EnrichmentUniverse {
  /** BED lines, one per universe region, grouped by subset. */
  bedText: string;
  /** Mask of the subset each universe region belongs to. */
  owner: Int32Array;
  lengths: Int32Array;
}

export interface EnrichmentCell {
  mask: number;
  annotationId: string;
  /** 2×2 table: in S & hit, in S & no hit, rest & hit, rest & no hit. */
  table: [number, number, number, number];
  oddsRatio: number;
  p: number;
  /** Benjamini–Hochberg over every cell of the same run. */
  q: number;
}

export function buildUniverse(subsets: { mask: number; regions: Interval[] }[]): EnrichmentUniverse {
  const n = subsets.reduce((k, s) => k + s.regions.length, 0);
  const owner = new Int32Array(n);
  const lengths = new Int32Array(n);
  const lines: string[] = [];
  let i = 0;
  for (const s of subsets) {
    for (const r of s.regions) {
      owner[i] = s.mask;
      lengths[i] = r.end - r.start;
      lines.push(`${r.chrom}\t${r.start}\t${r.end}`);
      i++;
    }
  }
  return { bedText: lines.length ? lines.join("\n") + "\n" : "", owner, lengths };
}

/**
 * Length stratum (0..k−1) of each region. Cut-off j (1..k−1) is the
 * ⌈j/k · N⌉-th smallest length (inverse ECDF); a region's stratum is the
 * number of cut-offs strictly below its length, so equal lengths share a
 * stratum.
 */
export function lengthStrata(lengths: Int32Array, k = LENGTH_STRATA): Uint8Array {
  const n = lengths.length;
  const out = new Uint8Array(n);
  if (!n) return out;
  const sorted = Int32Array.from(lengths).sort();
  const cuts: number[] = [];
  for (let j = 1; j < k; j++) cuts.push(sorted[Math.ceil((j / k) * n) - 1]);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const c of cuts) if (lengths[i] > c) s++;
    out[i] = s;
  }
  return out;
}

type Table = [number, number, number, number];

/** The 2×2 table for subset `mask` against one reference set's hit flags, and the same table per stratum when `strata` is given. */
export function enrichmentCounts(owner: Int32Array, hits: Uint8Array, mask: number, strata?: Uint8Array): { table: Table; strata: Table[] } {
  const table: Table = [0, 0, 0, 0];
  const per: Table[] = [];
  for (let i = 0; i < owner.length; i++) {
    const cell = (owner[i] === mask ? 0 : 2) + (hits[i] ? 0 : 1);
    table[cell]++;
    if (strata) {
      const s = strata[i];
      while (per.length <= s) per.push([0, 0, 0, 0]);
      per[s][cell]++;
    }
  }
  return { table, strata: per };
}

/** Reference sets that can be tested for this assembly: available files, minus any that is currently an included input set (the subsets are defined by it). */
export function testableAnnotations(assembly: string, loaded: { fileName: string; included: boolean }[]): ExternalAnnotation[] {
  const inUse = new Set(loaded.filter((s) => s.included).map((s) => s.fileName));
  return EXTERNAL_ANNOTATIONS.filter((a) => a.assembly === assembly && a.path && !inUse.has(`${a.id}.bed`));
}

/** Input-sets background: every (subset, reference set) cell, BH-adjusted together. */
export function unionEnrichment(
  universe: EnrichmentUniverse,
  annotations: { id: string; hits: Uint8Array }[],
  masks: number[],
  adjustForLength: boolean
): EnrichmentCell[] {
  const strata = adjustForLength ? lengthStrata(universe.lengths) : undefined;
  const cells: Omit<EnrichmentCell, "q">[] = [];
  for (const mask of masks) {
    for (const a of annotations) {
      const t = enrichmentCounts(universe.owner, a.hits, mask, strata);
      if (adjustForLength) {
        const mh = mantelHaenszel(t.strata);
        cells.push({ mask, annotationId: a.id, table: t.table, oddsRatio: mh.oddsRatio, p: mh.p });
      } else {
        const [x, y, z, w] = t.table;
        cells.push({ mask, annotationId: a.id, table: t.table, oddsRatio: oddsRatio(x, y, z, w), p: fisherExact(x, y, z, w) });
      }
    }
  }
  const q = benjaminiHochberg(cells.map((c) => c.p));
  return cells.map((c, i) => ({ ...c, q: q[i] }));
}

// ---- bedtools glue (runs against the WASM worker) ----

const annotationTextCache = new Map<string, string>();

async function annotationText(a: ExternalAnnotation): Promise<string> {
  const cached = annotationTextCache.get(a.id);
  if (cached !== undefined) return cached;
  const res = await fetch(`${window.location.origin}${import.meta.env.BASE_URL}${a.path}`);
  if (!res.ok) throw new Error(`Could not load ${a.name}`);
  const text = await res.text();
  annotationTextCache.set(a.id, text);
  return text;
}

export type StepCallback = (label: string) => void;

/** Hit flags of every universe region against each reference set: one `bedtools intersect -c` per set. */
export async function universeHits(
  universe: EnrichmentUniverse,
  annotations: ExternalAnnotation[],
  onStep?: StepCallback
): Promise<{ id: string; hits: Uint8Array }[]> {
  // Download every reference set at once (cached after the first run) rather than one per bedtools step.
  await Promise.all(annotations.map(annotationText));
  const uName = "enrichment.universe.bed";
  await bedtools.mount([{ name: uName, data: universe.bedText }]);
  const out: { id: string; hits: Uint8Array }[] = [];
  try {
    for (const a of annotations) {
      const name = `enrichment.ref.${a.id}.bed`;
      await bedtools.mount([{ name, data: await annotationText(a) }]);
      try {
        const res = await bedtools.exec(`bedtools intersect -a ${MOUNT_DIR}/${uName} -b ${MOUNT_DIR}/${name} -c`);
        out.push({ id: a.id, hits: parseIntersectCounts(res.stdout, universe.owner.length) });
      } finally {
        await bedtools.unmount([name]);
      }
      onStep?.(a.name);
    }
  } finally {
    await bedtools.unmount([uName]);
  }
  return out;
}
