import * as bedtools from "./bedtools";
import { parseIntersectCounts } from "./pipeline";

/**
 * ENCODE Blacklist v2 (Amemiya, Kundaje & Boyle, Sci Rep 2019): regions
 * with anomalous, unstructured signal in sequencing experiments regardless
 * of cell type or assay. Vendored per assembly by
 * public/refdata/build_external_annotations.py (`blacklist`), source and
 * checksums in docs/provenance.md. There is no v2 list for mm9.
 *
 * Two uses, both per set:
 *   1. Quality check, always on: how many of the set's regions overlap the
 *      blacklist. Nothing about the set changes.
 *   2. Filter, off by default: drop those regions before anything else is
 *      computed — the same as `bedtools intersect -v -a set -b blacklist`,
 *      which is how peak-calling pipelines apply it. Off by default so the
 *      results match the Intervene CLI, which doesn't filter.
 *
 * Both come from one `bedtools intersect -c` per set. Overlap is always
 * plain 1 bp, independent of the user's Minimum overlap setting — that
 * setting defines overlap between the user's own sets, while the
 * blacklist is applied as pipelines apply it.
 */

export const BLACKLIST_ASSEMBLIES = ["hg38", "hg19", "mm10"] as const;

/** Regions in each vendored list (checked against the files in blacklist.test.ts). */
export const BLACKLIST_REGION_COUNTS: Record<(typeof BLACKLIST_ASSEMBLIES)[number], number> = {
  hg38: 636,
  hg19: 834,
  mm10: 3435,
};

const MOUNT_DIR = "/shared/data";

export function hasBlacklist(assembly: string): boolean {
  return (BLACKLIST_ASSEMBLIES as readonly string[]).includes(assembly);
}

/** Relative to BASE_URL / the public directory. */
export function blacklistPath(assembly: string): string {
  return `refdata/${assembly}/blacklist/encode_blacklist_v2.bed`;
}

export interface BlacklistSplit {
  /** Regions overlapping the blacklist by at least 1 bp. */
  nHits: number;
  nKept: number;
  /** The regions that don't overlap it, as BED lines in input order. */
  keptText: string;
}

/**
 * Split BED text by per-region hit flags (one per non-empty line, in
 * order, as `bedtools intersect -c` reports them). Throws if they don't
 * line up.
 */
export function splitByBlacklistHits(bedText: string, hits: Uint8Array): BlacklistSplit {
  const lines = bedText.split("\n").filter((l) => l.length > 0);
  if (lines.length !== hits.length) {
    throw new Error(`Blacklist check returned ${hits.length} results for ${lines.length} regions`);
  }
  const kept: string[] = [];
  let nHits = 0;
  for (let i = 0; i < lines.length; i++) {
    if (hits[i]) nHits++;
    else kept.push(lines[i]);
  }
  return { nHits, nKept: kept.length, keptText: kept.length ? kept.join("\n") + "\n" : "" };
}

const mountedLists = new Map<string, string>();

/** Fetch and mount an assembly's blacklist once; returns its mounted path. */
export async function mountBlacklist(assembly: string): Promise<string> {
  const cached = mountedLists.get(assembly);
  if (cached) return cached;
  const res = await fetch(`${window.location.origin}${import.meta.env.BASE_URL}${blacklistPath(assembly)}`);
  if (!res.ok) throw new Error(`Could not load the ${assembly} ENCODE blacklist`);
  const name = `${assembly}.blacklist.bed`;
  await bedtools.mount([{ name, data: await res.text() }]);
  const path = `${MOUNT_DIR}/${name}`;
  mountedLists.set(assembly, path);
  return path;
}

/** One 0/1 flag per region of `bedText`: does it overlap the mounted blacklist by ≥ 1 bp. */
export async function blacklistHits(id: string, bedText: string, blacklistMountPath: string): Promise<Uint8Array> {
  const name = `${id}.blacklist-check.bed`;
  await bedtools.mount([{ name, data: bedText }]);
  try {
    const out = await bedtools.exec(`bedtools intersect -a ${MOUNT_DIR}/${name} -b ${blacklistMountPath} -c`);
    const nRegions = bedText.split("\n").filter((l) => l.length > 0).length;
    return parseIntersectCounts(out.stdout, nRegions);
  } finally {
    await bedtools.unmount([name]);
  }
}
