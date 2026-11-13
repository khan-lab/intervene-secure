import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CISTROMEGO_DEFAULTS,
  adjustRp,
  chooseDecay,
  cistromeGoTest,
  cistromeGoTestAsync,
  dedupTerms,
  prepareCistromeGo,
  promoterFractions,
  rankGenes,
  regulatoryPotential,
  selectPeaks,
  type CgoPeak,
  type RpModel,
} from "./cistromeGo";
import type { GoData } from "./great";
import { benjaminiHochberg } from "./stats";
import { xlmhgTest } from "./xlmhg";

/**
 * Cistrome-GO solo mode (Li et al. 2019, NAR 47:W206; docs/methods.md,
 * "GO enrichment of selected subsets — Cistrome-GO-like").
 *
 * Reference: the Cistrome-GO package's own code (rpscore.py at commit
 * 6b7f003, minimal Python 3 syntax port — tests/fixtures/cistromego/
 * cistromego_py3.diff) run on the three real ENCODE fixtures with three
 * different settings, against the vendored gene model built from the same
 * package files (public/refdata/<asm>/cistromego/rp_model.json).
 */

const PUBLIC = join(__dirname, "../../public");
const FIXTURES = join(__dirname, "../../../tests/fixtures");
const model = JSON.parse(readFileSync(join(PUBLIC, "refdata/hg38/cistromego/rp_model.json"), "utf8")) as RpModel;

interface RefConfig {
  file: string;
  peakn: string;
  decay_option: string;
  promoter_fraction: Record<string, number>;
  decay: number;
  n_peaks_used: number;
  adj_rp: Record<string, number>;
  raw_rp: Record<string, number>;
  n_positive: number;
  ranked_top: string[];
  N: number;
  L: number;
}
const REF = JSON.parse(readFileSync(join(FIXTURES, "cistromego/reference_hg38_bp.json"), "utf8")) as { go_genes_bp: string[]; configs: RefConfig[] };

/** A narrowPeak/BED file as Cistrome-GO reads it: column 5 is the score when every line has one. */
function readPeaks(file: string): CgoPeak[] {
  return readFileSync(join(FIXTURES, "encode", file), "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const f = l.split("\t");
      return { chrom: f[0], start: +f[1], end: +f[2], score: f.length >= 5 ? Number(f[4]) : undefined };
    });
}
const symIndex = new Map(model.symbols.map((s, i) => [s, i]));

/**
 * Brute-force RP straight from the definition: per transcript, Σ 2^(−d/decay)
 * over peak centres within 15 × decay of its TSS; per symbol the max.
 *
 * quirk = true reproduces the package's peaksInRange exactly: its forward
 * sweep holds each gene until a later peak is out of range, and a gene still
 * held when the sweep ends is re-initialised by the reverse sweep, losing
 * the peaks downstream of its TSS. That happens to a transcript when no peak
 * lies more than 15 × decay past it on its chromosome and no peak lies on a
 * chromosome sorting after it (Python string order) — i.e. only at the end
 * of the last chromosome with peaks. We do not reproduce it
 * (docs/methods.md); the tests pin down that it is the only difference.
 */
function naiveRp(peaks: CgoPeak[], decay: number, quirk: boolean): Float64Array {
  const pad = 15 * decay;
  const out = new Float64Array(model.symbols.length);
  const centres = new Map<string, number[]>();
  for (const p of peaks) {
    const list = centres.get(p.chrom) ?? [];
    list.push((p.start + p.end) / 2);
    centres.set(p.chrom, list);
  }
  const chroms = [...centres.keys()];
  for (const [chrom, list] of Object.entries(model.tss)) {
    const cs = centres.get(chrom) ?? [];
    const laterChrom = chroms.some((c) => c > chrom);
    for (const [pos, sym] of list) {
      const held = quirk && !laterChrom && !cs.some((c) => c > pos + pad);
      let s = 0;
      for (const c of cs) {
        const d = Math.abs(c - pos);
        if (d > pad) continue;
        if (held && c > pos) continue; // downstream peaks lost
        s += 2 ** (-d / decay);
      }
      if (s > out[sym]) out[sym] = s;
    }
  }
  return out;
}
/** Genes whose RP the package's quirk changes, per fixture (pinned so a change in either side is noticed). */
const QUIRK_AFFECTED: Record<string, number> = {
  "heart_h3k27ac_ENCFF059ERB.subsample.bed": 2, // PNCK, SLC6A8 (end of chrX)
  "liver_h3k27ac_ENCFF805YRQ.subsample.bed": 6, // CNKSR2, KLHL34, MBTPS2, SMPX, SMS, YY2 (chrX, 50 kb decay)
  "lung_h3k27ac_ENCFF314QTE.subsample.bed": 0,
};

describe("against the Cistrome-GO package on real ENCODE peaks", () => {
  for (const ref of REF.configs) {
    describe(`${ref.file}, top peaks ${ref.peakn}, decay ${ref.decay_option}`, () => {
      const peaks = readPeaks(ref.file);
      const top = ref.peakn === "all" ? "all" : Number(ref.peakn);
      const sel = selectPeaks(peaks, top);
      const fractions = promoterFractions(sel.ordered, model);
      const decay = chooseDecay(ref.decay_option === "auto" ? "auto" : Number(ref.decay_option.slice(0, -1)) * 1000, fractions);
      const raw = regulatoryPotential(sel.used, model, decay);
      const adj = adjustRp(raw, model, decay);

      it("uses the same peaks, promoter fractions and half-decay distance", () => {
        expect(sel.scored).toBe(true);
        expect(sel.used.length).toBe(ref.n_peaks_used);
        for (const [n, f] of Object.entries(ref.promoter_fraction)) expect(fractions[Number(n)]).toBe(f);
        expect(decay).toBe(ref.decay);
      });

      const withQuirk = naiveRp(sel.used, decay, true);
      const naive = naiveRp(sel.used, decay, false);
      const affected = model.symbols.filter((_, i) => withQuirk[i] !== naive[i]);

      it("our RP equals the model's definition, computed by brute force", () => {
        raw.forEach((v, i) => expect(Math.abs(v - naive[i])).toBeLessThanOrEqual(1e-12 * Math.max(1, v)));
      });

      it("the package's RP is that definition with its end-of-sweep quirk, for every gene", () => {
        const positive = model.symbols.filter((_, i) => withQuirk[i] > 0);
        if (ref.file.startsWith("heart") || ref.file.startsWith("lung")) expect(positive.sort()).toEqual(Object.keys(ref.raw_rp).sort());
        for (const [s, v] of Object.entries(ref.raw_rp)) expect(withQuirk[symIndex.get(s)!]).toBeCloseTo(v, 12);
      });

      it("the package's adjusted RP (min-max scaled, minus the Cistrome DB background) and ranking follow", () => {
        const adjQ = adjustRp(withQuirk, model, decay);
        for (const [s, v] of Object.entries(ref.adj_rp)) expect(Math.abs(adjQ[symIndex.get(s)!] - v)).toBeLessThan(1e-12);
        expect(Array.from(adjQ).filter((v) => v > 0).length).toBe(ref.n_positive);
        const universe = REF.go_genes_bp.map((s) => symIndex.get(s)).filter((i) => i !== undefined);
        const r = rankGenes(adjQ, universe, CISTROMEGO_DEFAULTS.maxL);
        expect(r.N).toBe(ref.N);
        expect(r.L).toBe(ref.L);
        expect(r.order.slice(0, r.L).map((i) => model.symbols[i])).toEqual(ref.ranked_top);
        // Our port without the quirk: the same everywhere except the affected genes.
        const diff = model.symbols.filter((_, i) => Math.abs(adj[i] - adjQ[i]) > 1e-12 && !affected.includes(model.symbols[i]));
        if (adj.indexOf(Math.max(...adj)) === adjQ.indexOf(Math.max(...adjQ))) expect(diff).toEqual([]);
      });

      it("the quirk only touches genes at the end of the last chromosome with peaks", () => {
        const last = [...new Set(sel.used.map((p) => p.chrom))].sort().pop()!;
        const where = new Map<number, string>();
        for (const [c, l] of Object.entries(model.tss)) for (const [, sym] of l) if (!where.has(sym) || c === last) where.set(sym, c);
        expect(affected.every((s) => where.get(symIndex.get(s)!) === last)).toBe(true);
        expect(affected.length).toBe(QUIRK_AFFECTED[ref.file]);
      });
    });
  }
});

describe("hand-worked model", () => {
  // Two genes; A has two transcripts (TSS 10,000 and 50,000), B one (TSS 30,000).
  const tiny: RpModel = {
    symbols: ["A", "B"],
    bg1k: [0.1, 0.0],
    bg10k: [0.2, 0.05],
    tss: {
      chrT: [
        [10_000, 0],
        [30_000, 1],
        [50_000, 0],
      ],
    },
  };
  const peaks: CgoPeak[] = [
    { chrom: "chrT", start: 9_900, end: 10_100, score: 5 }, // centre 10,000: 0 from A1
    { chrom: "chrT", start: 11_000, end: 11_001, score: 9 }, // centre 11,000.5
    { chrom: "chrT", start: 48_000, end: 48_000, score: 1 }, // centre 48,000
    { chrom: "chrU", start: 1, end: 3 }, // no TSS on chrU
  ];

  it("scored peaks are taken in score order; without a score on every peak, all peaks in file order", () => {
    expect(selectPeaks(peaks, 2)).toMatchObject({ scored: false });
    expect(selectPeaks(peaks, 2).used).toHaveLength(4);
    const scored = peaks.slice(0, 3);
    const s = selectPeaks(scored, 2);
    expect(s.scored).toBe(true);
    expect(s.used.map((p) => p.score)).toEqual([9, 5]);
    expect(s.ordered.map((p) => p.score)).toEqual([9, 5, 1]);
  });

  it("promoter fraction: share of peaks within 1 kb of the nearest TSS, best over the top 2,000/5,000/10,000/all", () => {
    const f = promoterFractions(peaks, tiny);
    // centre 10,000: 0 from A ✓; 11,000.5: 1,000.5 > 1 kb; 48,000: 2 kb from A's 2nd TSS; chrU: no TSS (still counted).
    expect(f[2000]).toBe(1 / 4);
    expect(f[1000000]).toBe(1 / 4);
  });

  it("RP = Σ 2^(−d/decay) over peaks within 15 × decay of the TSS; a gene takes its best transcript", () => {
    const raw = regulatoryPotential(peaks.slice(0, 3), tiny, 1000);
    const a1 = 2 ** 0 + 2 ** (-1000.5 / 1000); // 48,000 is 38 kb away > 15 kb
    const a2 = 2 ** (-2000 / 1000); // only 48,000 within 15 kb of 50,000
    expect(raw[0]).toBeCloseTo(Math.max(a1, a2), 14);
    expect(raw[1]).toBe(0); // 30,000: nearest peak 18 kb away
    const raw10 = regulatoryPotential(peaks.slice(0, 3), tiny, 10_000);
    expect(raw10[1]).toBeCloseTo(2 ** (-18_000 / 10_000) + 2 ** (-18_999.5 / 10_000) + 2 ** (-20_000 / 10_000), 14);
  });

  it("adjusted RP: min-max scale, then subtract the 1 kb background for decay ≤ 1 kb, else the 10 kb one", () => {
    const raw = Float64Array.from([3, 1]);
    expect(Array.from(adjustRp(raw, tiny, 1000))).toEqual([1 - 0.1, 0 - 0.0]);
    expect(Array.from(adjustRp(raw, tiny, 500))).toEqual([1 - 0.1, 0 - 0.0]);
    expect(Array.from(adjustRp(raw, tiny, 50_000))).toEqual([1 - 0.2, 0 - 0.05]);
  });

  it("auto decay: 1 kb when any promoter fraction reaches 20%, else 10 kb", () => {
    expect(chooseDecay("auto", { 2000: 0.1, 5000: 0.2, 10000: 0.1, 1000000: 0.1 })).toBe(1000);
    expect(chooseDecay("auto", { 2000: 0.19, 5000: 0.1, 10000: 0.1, 1000000: 0.1 })).toBe(10_000);
    expect(chooseDecay(50_000, { 2000: 0.9, 5000: 0.9, 10000: 0.9, 1000000: 0.9 })).toBe(50_000);
  });
});

describe("dedupTerms (Cistrome-GO's redundancy filter: Jaccard > 0.85 keeps the larger term)", () => {
  it("drops a term too similar to a larger kept one, keeps the rest", () => {
    const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
    const terms: [string, string, number[]][] = [
      ["GO:1", "big", range(0, 100)],
      ["GO:2", "almost big", range(0, 90)], // J = 0.90 with GO:1 → dropped
      ["GO:3", "overlapping", range(0, 85)], // J = 0.85 with GO:1 → kept (not > 0.85)
      ["GO:4", "other", range(200, 220)],
      ["GO:5", "same as other", range(200, 220)], // J = 1 with GO:4; same size: lower id kept
    ];
    expect(dedupTerms(terms, 0.85).map((t) => t[0])).toEqual(["GO:1", "GO:3", "GO:4"]);
  });
});

describe("end to end on the vendored GO data", () => {
  const go = JSON.parse(readFileSync(join(PUBLIC, "refdata/hg38/go/go.json"), "utf8")) as GoData;
  const prepared = prepareCistromeGo(model, go);

  it("maps GO genes onto the gene model by symbol (most of them)", () => {
    const u = prepared.universe("BP");
    expect(u.length).toBeGreaterThan(15_000);
    expect(u.every((i) => i >= 0 && i < model.symbols.length)).toBe(true);
  });

  it("tests every kept term with XL-mHG (X = 1, L = min(2000, positive genes)) and BH-adjusts", () => {
    const peaks = readPeaks("heart_h3k27ac_ENCFF059ERB.subsample.bed");
    const res = cistromeGoTest(prepared, peaks, "BP", CISTROMEGO_DEFAULTS);
    expect(res.decay).toBe(1000);
    expect(res.nPeaksUsed).toBe(2000);
    const rank = new Map<number, number>(res.ranking.order.map((g, i) => [g, i]));
    const terms = new Map(prepared.terms("BP", CISTROMEGO_DEFAULTS).map((t) => [t[0], t]));
    expect(res.rows.length).toBe(terms.size);
    for (const row of res.rows.slice(0, 40)) {
      const genes = terms.get(row.id)![2];
      expect(genes.length).toBeGreaterThanOrEqual(CISTROMEGO_DEFAULTS.minGenes);
      expect(genes.length).toBeLessThanOrEqual(CISTROMEGO_DEFAULTS.maxGenes);
      const idx = genes.map((g) => rank.get(g)!).sort((a, b) => a - b);
      const x = xlmhgTest(res.ranking.N, idx, 1, res.ranking.L);
      expect(row.p).toBe(x.pval);
      expect(row.cutoff).toBe(x.cutoff);
      expect(row.K).toBe(genes.length);
      // Leading genes: the term's genes above the cutoff, highest adjusted RP first.
      expect(row.leadGenes).toEqual(idx.filter((i) => i < x.cutoff).map((i) => model.symbols[res.ranking.order[i]]));
      expect(row.leadGenes).toHaveLength(row.k);
    }
    const q = benjaminiHochberg(res.rows.map((r) => r.p));
    res.rows.forEach((r, i) => expect(r.q).toBe(q[i]));
  }, 60_000);

  it("the asynchronous version (yields to the page between slices) gives identical results", async () => {
    const peaks = readPeaks("lung_h3k27ac_ENCFF314QTE.subsample.bed");
    const settings = { ...CISTROMEGO_DEFAULTS, decay: 10_000 };
    const sync = cistromeGoTest(prepared, peaks, "MF", settings);
    const seen: number[] = [];
    const async_ = await cistromeGoTestAsync(prepared, peaks, "MF", settings, (d) => seen.push(d), 5);
    expect(async_).toEqual(sync);
    expect(seen[seen.length - 1]).toBe(sync.rows.length);
    expect(seen.length).toBeGreaterThan(1);
  }, 60_000);

  it("term-size limits and the redundancy filter are settings", () => {
    const all = prepared.terms("BP", { ...CISTROMEGO_DEFAULTS, dedup: false });
    const dedup = prepared.terms("BP", CISTROMEGO_DEFAULTS);
    expect(dedup.length).toBeLessThan(all.length);
    const narrow = prepared.terms("BP", { ...CISTROMEGO_DEFAULTS, dedup: false, minGenes: 50, maxGenes: 100 });
    expect(narrow.every((t) => t[2].length >= 50 && t[2].length <= 100)).toBe(true);
  });
});
