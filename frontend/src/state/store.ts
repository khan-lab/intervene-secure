import { create } from "zustand";
import * as intervals from "../lib/intervals";
import { computeSubsetsViaBedtools, forgetSet, subsetToBedText, type PipelineProgress } from "../lib/pipeline";
import { resolveOverlapFlags, type OverlapPreset } from "../lib/bedtoolsOptions";
import { MAX_SETS, PALETTE, type Interval, type RegionSet, type Subset } from "../types";
import type { ExternalAnnotation } from "../lib/externalAnnotations";
import { blacklistHits, hasBlacklist, mountBlacklist, splitByBlacklistHits } from "../lib/blacklist";
import {
  InputValidationError,
  SUPPORTED_ASSEMBLIES,
  checkFileSize,
  normalizeRegionText,
  parseChromSizes,
  type ChromSizes,
  type InputFormat,
} from "../lib/inputValidation";

export type View = "upset" | "venn" | "pairwise" | "table" | "summary" | "help";
export type ComputeStatus = "idle" | "loading-worker" | "running" | "done" | "error";
/** Matches the Intervene CLI's own `intervene pairwise --compute {jaccard,fisher,reldist}`. */
export type PairwiseStat = "jaccard" | "fisher" | "reldist";

export interface LoadedSet extends RegionSet {
  /**
   * What every analysis reads: the checked, cleaned upload
   * (lib/inputValidation.ts; tab-separated BED, VCF already converted), or,
   * with the ENCODE blacklist filter on, that minus its blacklisted
   * regions. Never the raw upload.
   */
  file: File;
  /** The checked, cleaned upload, unfiltered — `file` when the blacklist filter is off. */
  cleanFile: File;
  /** Identifies `file`'s content for result caches: the set id, or `${id}~bl-${assembly}` when filtered. */
  contentKey: string;
  /** Regions of `cleanFile` overlapping the selected assembly's ENCODE blacklist (≥ 1 bp); null when that assembly has none or the check failed. */
  blacklistHits: number | null;
  format: InputFormat;
  /** Max end coordinate per chromosome, for the assembly check. */
  extents: Record<string, number>;
  /** Non-fatal problems found while checking the file (skipped lines, conversions). */
  warnings: string[];
}

interface StoreState {
  sets: LoadedSet[];
  subsets: Subset[];
  selected: Set<number>;
  view: View;
  status: ComputeStatus;
  error: string | null;
  /** What the app is doing right now, for the progress indicator; null when idle. `total` is 0 for steps without a count (reading a file). */
  progress: PipelineProgress | null;
  /** Non-fatal messages from the last load — files rejected, sets over the 6-set cap. */
  notices: string[];
  /** Vendored chrom.sizes per supported assembly, fetched once on first load (a few KB each). */
  chromSizes: Record<string, ChromSizes>;
  /** True if the last computation fell back to the pure-TS path because the WASM worker failed. */
  usedFallback: boolean;
  /** True if the fallback ran while a non-default overlap mode was requested — the TS fallback only supports the 1bp default. */
  fallbackOverlapUnsupported: boolean;

  overlapPreset: OverlapPreset;
  advancedBedtoolsOptions: string;
  /** hg38 (default), hg19, mm10, or mm9 — see docs/provenance.md for vendored chrom.sizes. Used by the Pairwise Fisher/Reldist toggle only; the overlap pipeline itself doesn't need a genome. */
  assembly: string;
  pairwiseStat: PairwiseStat;
  /** Drop regions overlapping the ENCODE blacklist from every set before analysis. Off by default, to match the CLI. */
  blacklistFilter: boolean;
  /** UpSet chart sort key — pure client-side reordering of already-computed subsets, no recompute involved. */
  upsetSort: "size" | "degree";
  /** UpSet chart minimum subset size — bars below this are hidden. */
  upsetMinSize: number;

  /** `meta[i]`, when given, overrides the name/code derived from `files[i]`'s file name (used for built-in annotation sets). */
  addFiles: (files: File[], meta?: ({ name: string; code: string } | undefined)[]) => Promise<void>;
  loadChromSizes: () => Promise<void>;
  dismissNotices: () => void;
  removeSet: (id: string) => void;
  renameSet: (id: string, name: string) => void;
  setColor: (id: string, color: string) => void;
  resetColor: (id: string) => void;
  toggleIncluded: (id: string) => void;
  toggleSelected: (mask: number) => void;
  clearSelected: () => void;
  setView: (view: View) => void;
  loadExample: () => Promise<void>;
  addExternalAnnotation: (annotation: ExternalAnnotation) => Promise<void>;
  exportSelectedBedZip: () => Promise<void>;
  exportSubsetBed: (mask: number) => void;
  setOverlapPreset: (preset: OverlapPreset) => void;
  setAdvancedBedtoolsOptions: (value: string) => void;
  setAssembly: (assembly: string) => void;
  setPairwiseStat: (stat: PairwiseStat) => void;
  setBlacklistFilter: (on: boolean) => void;
  setUpsetSort: (sort: "size" | "degree") => void;
  setUpsetMinSize: (size: number) => void;
}

function labelSubsets(raw: { mask: number; memberIds: string[]; regions: Interval[]; nRegions: number; nBp: number }[], sets: LoadedSet[]): Subset[] {
  const byId = new Map(sets.map((s) => [s.id, s]));
  return raw.map((s) => {
    const members = s.memberIds.map((id) => byId.get(id)).filter((s): s is LoadedSet => Boolean(s));
    return {
      mask: s.mask,
      memberIds: s.memberIds,
      label: members.length === 1 ? `${members[0].name} only` : members.map((m) => m.name).join(" ∩ "),
      code: members.map((m) => m.code).join("·"),
      degree: members.length,
      regions: s.regions,
      nRegions: s.nRegions,
      nBp: s.nBp,
    };
  });
}

/** Fill region counts for sets that have none yet (excluded sets, or sets whose content just changed). */
function withCounts(sets: LoadedSet[]): Promise<LoadedSet[]> {
  return Promise.all(
    sets.map(async (s) => {
      if (s.nRegions > 0 || s.regions.length > 0) return s;
      const regions = intervals.sortIntervals(intervals.parseBed(await s.file.text()));
      return { ...s, regions, nRegions: regions.length, nBp: regions.reduce((bp, r) => bp + (r.end - r.start), 0) };
    })
  );
}

// ---- ENCODE blacklist (lib/blacklist.ts) ----

/** Per (set id, assembly): the blacklist hit flags of the set's clean file. */
const blacklistCache = new Map<string, Uint8Array | null>();
/** Per (set id, assembly): the filtered file, built on first use. */
const filteredFileCache = new Map<string, File>();
const blKey = (id: string, assembly: string) => `${id}~bl-${assembly}`;

function forgetBlacklist(id: string): void {
  for (const m of [blacklistCache, filteredFileCache]) for (const k of m.keys()) if (k.startsWith(`${id}~`)) m.delete(k);
}

/**
 * Count each set's regions in the assembly's blacklist (one bedtools
 * intersect -c per set not yet checked for this assembly). Never blocks
 * loading: if the check fails, the set just shows no count.
 */
async function checkBlacklist(sets: LoadedSet[], assembly: string, onProgress?: (p: PipelineProgress) => void): Promise<LoadedSet[]> {
  if (!hasBlacklist(assembly)) return sets.map((s) => ({ ...s, blacklistHits: null }));
  const todo = sets.filter((s) => !blacklistCache.has(blKey(s.id, assembly)));
  let done = 0;
  for (const s of todo) {
    onProgress?.({ done, total: todo.length, label: `Checking ${s.name} against ENCODE problematic regions` });
    try {
      const path = await mountBlacklist(assembly);
      blacklistCache.set(blKey(s.id, assembly), await blacklistHits(s.id, await s.cleanFile.text(), path));
    } catch (err) {
      console.warn(`ENCODE problematic-regions check failed for ${s.name}`, err);
      blacklistCache.set(blKey(s.id, assembly), null);
    }
    done++;
  }
  return sets.map((s) => {
    const hits = blacklistCache.get(blKey(s.id, assembly));
    return { ...s, blacklistHits: hits ? hits.reduce((n, h) => n + h, 0) : null };
  });
}

/**
 * Point each set's `file` at its filtered or clean version. A set whose
 * content changes loses its stale region counts (recompute refills them).
 */
async function applyBlacklistFilter(sets: LoadedSet[], on: boolean, assembly: string): Promise<LoadedSet[]> {
  return Promise.all(
    sets.map(async (s) => {
      const key = blKey(s.id, assembly);
      const hits = on ? blacklistCache.get(key) : null;
      let file = s.cleanFile;
      let contentKey = s.id;
      if (hits) {
        let filtered = filteredFileCache.get(key);
        if (!filtered) {
          filtered = new File([splitByBlacklistHits(await s.cleanFile.text(), hits).keptText], s.cleanFile.name, { type: "text/plain" });
          filteredFileCache.set(key, filtered);
        }
        file = filtered;
        contentKey = key;
      }
      if (contentKey === s.contentKey) return s;
      return { ...s, file, contentKey, regions: [], nRegions: 0, nBp: 0 };
    })
  );
}

async function recompute(
  sets: LoadedSet[],
  overlapFlags: string,
  onProgress?: (p: PipelineProgress) => void
): Promise<{ sets: LoadedSet[]; subsets: Subset[]; usedFallback: boolean; fallbackOverlapUnsupported: boolean }> {
  const included = sets.filter((s) => s.included);

  if (included.length < 2) {
    // Still need per-set counts for the rail even with 0-1 active sets.
    return { sets: await withCounts(sets), subsets: [], usedFallback: false, fallbackOverlapUnsupported: false };
  }

  try {
    const result = await computeSubsetsViaBedtools(
      included.map((s) => ({ id: s.id, name: s.name, file: s.file, key: s.contentKey })),
      overlapFlags,
      onProgress
    );
    const byId = new Map(result.sets.map((r) => [r.id, r]));
    const updatedSets = await withCounts(
      sets.map((s) => {
        const r = byId.get(s.id);
        return r ? { ...s, regions: r.regions, nRegions: r.nRegions, nBp: r.nBp } : s;
      })
    );
    return {
      sets: updatedSets,
      subsets: labelSubsets(result.subsets, updatedSets),
      usedFallback: false,
      fallbackOverlapUnsupported: false,
    };
  } catch (err) {
    console.warn("bedtools WASM pipeline failed, falling back to pure-TS lib/intervals.ts", err);
    const withRegions = await Promise.all(
      included.map(async (s) => {
        const regions = intervals.sortIntervals(intervals.parseBed(await s.file.text()));
        return { ...s, regions, nRegions: regions.length, nBp: regions.reduce((bp, r) => bp + (r.end - r.start), 0) };
      })
    );
    const updatedSets = sets.map((s) => withRegions.find((r) => r.id === s.id) ?? s);
    // The TS fallback only implements the 1bp default (no -f/-r/-F equivalent).
    const raw = intervals.computeSubsets(withRegions.map((s) => ({ id: s.id, regions: s.regions })));
    return {
      sets: updatedSets,
      subsets: labelSubsets(raw, updatedSets),
      usedFallback: true,
      fallbackOverlapUnsupported: overlapFlags !== "",
    };
  }
}

const EXTENSION = /\.(bed|txt|vcf|narrowPeak|broadPeak|bedGraph)(\.gz)?$/i;

async function readUploadText(file: File): Promise<string> {
  if (!/\.gz$/i.test(file.name)) return file.text();
  // Browser-native gzip, no dependency: ENCODE and most pipelines ship .bed.gz.
  const stream = file.stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Check one upload and replace it with the cleaned BED text
 * (lib/inputValidation.ts). Returns a rejection message instead when the
 * file can't be used at all.
 */
async function prepareUpload(
  file: File
): Promise<{ ok: true; file: File; format: InputFormat; extents: Record<string, number>; warnings: string[] } | { ok: false; message: string }> {
  const tooBig = checkFileSize(file.size);
  if (tooBig) return { ok: false, message: `${file.name} ${tooBig}` };
  let text: string;
  try {
    text = await readUploadText(file);
  } catch {
    return { ok: false, message: `${file.name} could not be read${/\.gz$/i.test(file.name) ? " — is it really gzip-compressed?" : "."}` };
  }
  const tooBigUnzipped = checkFileSize(text.length);
  if (tooBigUnzipped) return { ok: false, message: `${file.name} (uncompressed) ${tooBigUnzipped}` };

  try {
    const n = normalizeRegionText(text, { fileName: file.name });
    const warnings: string[] = [];
    if (n.format === "vcf") warnings.push(`VCF converted to BED: ${plural(n.nRegions, "record")}, 0-based, spanning REF (or INFO END for symbolic alleles).`);
    if (n.nSkipped) {
      const ex = n.skippedExamples[0];
      warnings.push(`Skipped ${plural(n.nSkipped, "malformed line")} — e.g. line ${ex.line}: ${ex.reason}.`);
    }
    if (n.nWhitespaceConverted) warnings.push(`${plural(n.nWhitespaceConverted, "space-separated line")} converted to tabs.`);
    if (n.nZeroLength) warnings.push(`${plural(n.nZeroLength, "zero-length interval")} (start = end) kept as-is.`);
    const cleaned = new File([n.bedText], file.name.replace(/\.gz$/i, ""), { type: "text/plain" });
    return { ok: true, file: cleaned, format: n.format, extents: n.extents, warnings };
  } catch (err) {
    if (err instanceof InputValidationError) return { ok: false, message: `${file.name} ${err.message}` };
    throw err;
  }
}

let nextId = 0;

export const useStore = create<StoreState>((set, get) => {
  /** Recompute subsets for `sets` and keep only selections that still exist. */
  const rerunWith = async (sets: LoadedSet[]) => {
    try {
      set({ sets, status: "running" });
      const flags = resolveOverlapFlags(get().overlapPreset, get().advancedBedtoolsOptions);
      const result = await recompute(sets, flags, (p) => set({ progress: p }));
      const stillValid = new Set([...get().selected].filter((m) => result.subsets.some((s) => s.mask === m)));
      set({ ...result, selected: stillValid, status: "done", progress: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), status: "error", progress: null });
    }
  };

  return {
  sets: [],
  subsets: [],
  selected: new Set(),
  view: "upset",
  status: "idle",
  error: null,
  progress: null,
  notices: [],
  chromSizes: {},
  usedFallback: false,
  fallbackOverlapUnsupported: false,
  overlapPreset: "1bp",
  advancedBedtoolsOptions: "",
  assembly: "hg38",
  pairwiseStat: "jaccard",
  blacklistFilter: false,
  upsetSort: "size",
  upsetMinSize: 0,

  addFiles: async (files, meta) => {
    if (!files.length) return;
    set({ status: "loading-worker", error: null, notices: [] });
    void get().loadChromSizes();
    const existing = get().sets;
    const room = Math.max(0, MAX_SETS - existing.length);
    const notices: string[] = [];
    if (files.length > room) {
      notices.push(
        `Intervene compares up to ${MAX_SETS} sets; ${plural(files.length - room, "file")} not added (${files
          .slice(room)
          .map((f) => f.name)
          .join(", ")}).`
      );
    }

    const newSets: LoadedSet[] = [];
    for (const [i, file] of files.slice(0, room).entries()) {
      set({ progress: { done: 0, total: 0, label: `Checking ${file.name}` } });
      const prepared = await prepareUpload(file);
      if (!prepared.ok) {
        notices.push(prepared.message);
        continue;
      }
      const cleanName = meta?.[i]?.name ?? file.name.replace(EXTENSION, "");
      const defaultColor = PALETTE[(existing.length + newSets.length) % PALETTE.length];
      const id = `set-${nextId++}`;
      newSets.push({
        id,
        name: cleanName,
        code: meta?.[i]?.code ?? cleanName.slice(0, 3).toUpperCase(),
        color: defaultColor,
        defaultColor,
        fileName: file.name,
        fileSizeBytes: file.size,
        regions: [],
        nRegions: 0,
        nBp: 0,
        included: true,
        file: prepared.file,
        cleanFile: prepared.file,
        contentKey: id,
        blacklistHits: null,
        format: prepared.format,
        extents: prepared.extents,
        warnings: prepared.warnings,
      });
    }

    if (!newSets.length) {
      set({ notices, status: existing.length ? "done" : "idle", progress: null });
      return;
    }
    try {
      set({ status: "running", notices });
      const { assembly, blacklistFilter } = get();
      const checked = await checkBlacklist(newSets, assembly, (p) => set({ progress: p }));
      const merged = [...existing, ...(await applyBlacklistFilter(checked, blacklistFilter, assembly))];
      const flags = resolveOverlapFlags(get().overlapPreset, get().advancedBedtoolsOptions);
      const { sets, subsets, usedFallback, fallbackOverlapUnsupported } = await recompute(merged, flags, (p) => set({ progress: p }));
      set({ sets, subsets, usedFallback, fallbackOverlapUnsupported, status: "done", progress: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), status: "error", progress: null });
    }
  },

  loadChromSizes: async () => {
    const missing = SUPPORTED_ASSEMBLIES.filter((a) => !get().chromSizes[a]);
    if (!missing.length) return;
    const loaded = await Promise.all(
      missing.map(async (a) => {
        try {
          const res = await fetch(`${window.location.origin}${import.meta.env.BASE_URL}refdata/${a}/${a}.chrom.sizes`);
          return res.ok ? ([a, parseChromSizes(await res.text())] as const) : null;
        } catch {
          return null; // the assembly check is advisory — never block loading on it
        }
      })
    );
    const add = Object.fromEntries(loaded.filter((x) => x !== null));
    set({ chromSizes: { ...get().chromSizes, ...add } });
  },

  dismissNotices: () => set({ notices: [] }),

  removeSet: (id) => {
    void (async () => {
      const remaining = get().sets.filter((s) => s.id !== id);
      forgetSet(id);
      forgetBlacklist(id);
      set({ status: "running" });
      const flags = resolveOverlapFlags(get().overlapPreset, get().advancedBedtoolsOptions);
      const { sets, subsets, usedFallback, fallbackOverlapUnsupported } = await recompute(remaining, flags, (p) => set({ progress: p }));
      const stillValid = new Set([...get().selected].filter((m) => subsets.some((s) => s.mask === m)));
      set({ sets, subsets, usedFallback, fallbackOverlapUnsupported, selected: stillValid, status: "done", progress: null });
    })();
  },

  renameSet: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    set((state) => {
      const sets = state.sets.map((s) => (s.id === id ? { ...s, name: trimmed } : s));
      // Cheap relabel, no bedtools recompute: mask/regions/memberIds are
      // unchanged, only the display name feeding subset labels/codes.
      const subsets = labelSubsets(state.subsets, sets);
      return { sets, subsets };
    });
  },

  setColor: (id, color) => {
    // No relabel needed (unlike renameSet) — Subset carries a code/label
    // derived from names, never a color; every consumer (UpSetPlot,
    // VennPlot) looks up sets.find(...)?.color live off this array.
    set((state) => ({ sets: state.sets.map((s) => (s.id === id ? { ...s, color } : s)) }));
  },

  resetColor: (id) => {
    set((state) => ({ sets: state.sets.map((s) => (s.id === id ? { ...s, color: s.defaultColor } : s)) }));
  },

  toggleIncluded: (id) => {
    void (async () => {
      const toggled = get().sets.map((s) => (s.id === id ? { ...s, included: !s.included } : s));
      set({ sets: toggled, status: "running" });
      const flags = resolveOverlapFlags(get().overlapPreset, get().advancedBedtoolsOptions);
      const { sets, subsets, usedFallback, fallbackOverlapUnsupported } = await recompute(toggled, flags, (p) => set({ progress: p }));
      const stillValid = new Set([...get().selected].filter((m) => subsets.some((s) => s.mask === m)));
      set({ sets, subsets, usedFallback, fallbackOverlapUnsupported, selected: stillValid, status: "done", progress: null });
    })();
  },

  setOverlapPreset: (preset) => {
    set({ overlapPreset: preset });
    void (async () => {
      set({ status: "running" });
      const flags = resolveOverlapFlags(preset, get().advancedBedtoolsOptions);
      const { sets, subsets, usedFallback, fallbackOverlapUnsupported } = await recompute(get().sets, flags, (p) => set({ progress: p }));
      const stillValid = new Set([...get().selected].filter((m) => subsets.some((s) => s.mask === m)));
      set({ sets, subsets, usedFallback, fallbackOverlapUnsupported, selected: stillValid, status: "done", progress: null });
    })();
  },

  setAdvancedBedtoolsOptions: (value) => {
    set({ advancedBedtoolsOptions: value });
    void (async () => {
      set({ status: "running" });
      const flags = resolveOverlapFlags(get().overlapPreset, value);
      const { sets, subsets, usedFallback, fallbackOverlapUnsupported } = await recompute(get().sets, flags, (p) => set({ progress: p }));
      const stillValid = new Set([...get().selected].filter((m) => subsets.some((s) => s.mask === m)));
      set({ sets, subsets, usedFallback, fallbackOverlapUnsupported, selected: stillValid, status: "done", progress: null });
    })();
  },

  setAssembly: (assembly) => {
    set({ assembly });
    void (async () => {
      if (!get().sets.length) return;
      set({ status: "running", error: null });
      const checked = await checkBlacklist(get().sets, assembly, (p) => set({ progress: p }));
      if (!get().blacklistFilter) {
        // Counts only — the sets' content, and so every result, is unchanged.
        set({ sets: checked, status: "done", progress: null });
        return;
      }
      await rerunWith(await applyBlacklistFilter(checked, true, assembly));
    })();
  },

  setPairwiseStat: (stat) => set({ pairwiseStat: stat }),

  setBlacklistFilter: (on) => {
    set({ blacklistFilter: on });
    void (async () => {
      if (!get().sets.length) return;
      set({ status: "running", error: null });
      const { assembly } = get();
      const checked = await checkBlacklist(get().sets, assembly, (p) => set({ progress: p }));
      await rerunWith(await applyBlacklistFilter(checked, on, assembly));
    })();
  },

  setUpsetSort: (sort) => set({ upsetSort: sort }),

  setUpsetMinSize: (size) => set({ upsetMinSize: Math.max(0, size) }),

  toggleSelected: (mask) => {
    const selected = new Set(get().selected);
    if (selected.has(mask)) selected.delete(mask);
    else selected.add(mask);
    set({ selected });
  },

  clearSelected: () => set({ selected: new Set() }),

  setView: (view) => set({ view }),

  loadExample: async () => {
    set({ status: "loading-worker", error: null });
    try {
      const base = `${window.location.origin}${import.meta.env.BASE_URL}examples/hg38_ses`;
      const files = await Promise.all(
        ["MCF7.bed", "GM12878.bed", "K562.bed", "HepG2.bed"].map(async (name) => {
          const res = await fetch(`${base}/${name}`);
          if (!res.ok) throw new Error(`Could not load example file ${name}`);
          const blob = await res.blob();
          return new File([blob], name, { type: "text/plain" });
        })
      );
      // The example sets are hg38. Set the assembly explicitly so a user
      // who had switched to another one doesn't run Fisher/Reldist,
      // Summary or annotation against the wrong genome file.
      set({ sets: [], subsets: [], selected: new Set(), assembly: "hg38" });
      await get().addFiles(files);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), status: "error", progress: null });
    }
  },

  addExternalAnnotation: async (annotation) => {
    if (!annotation.path) return; // placeholder entry — nothing to load
    set({ status: "loading-worker", error: null, progress: { done: 0, total: 0, label: `Downloading ${annotation.name}` } });
    try {
      const url = `${window.location.origin}${import.meta.env.BASE_URL}${annotation.path}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Could not load ${annotation.name}`);
      const blob = await res.blob();
      const file = new File([blob], `${annotation.id}.bed`, { type: "text/plain" });
      // addFiles() is additive (appends to the existing set list) and
      // already enforces the 6-set cap — same as any drag-and-dropped
      // file, no separate capacity logic needed here.
      await get().addFiles([file], [{ name: annotation.setName, code: annotation.code }]);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), status: "error", progress: null });
    }
  },

  exportSelectedBedZip: async () => {
    const { subsets, selected, sets } = get();
    const chosen = subsets.filter((s) => selected.has(s.mask));
    if (!chosen.length) return;
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    const byId = new Map(sets.map((s) => [s.id, s]));
    for (const s of chosen) {
      zip.file(`${s.code || s.mask}.bed`, subsetToBedText(s));
    }
    const memberNames = (ids: string[]) => ids.map((id) => byId.get(id)?.name ?? id).join(", ");
    const readme = [
      "# Intervene subset export",
      "",
      "Each .bed file is one combinatorial intersection subset, computed client-side",
      "with bedtools 2.31.0 (WASM) — see docs/provenance.md. No data left this browser.",
      ...(get().blacklistFilter && hasBlacklist(get().assembly)
        ? [
            "",
            `ENCODE problematic-regions filter ON: regions overlapping the ENCODE problematic regions v2 (${get().assembly}) by at least 1 bp`,
            "were removed from every input set before intersecting (bedtools intersect -v).",
          ]
        : []),
      "",
      ...chosen.map((s) => `- ${s.code || s.mask}.bed — ${s.label} (${memberNames(s.memberIds)}): ${s.nRegions} regions, ${s.nBp} bp`),
      "",
    ].join("\n");
    zip.file("README.md", readme);
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "intervene-subsets.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  exportSubsetBed: (mask) => {
    const s = get().subsets.find((x) => x.mask === mask);
    if (!s) return;
    const blob = new Blob([subsetToBedText(s)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${s.code || s.mask}.bed`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  };
});
