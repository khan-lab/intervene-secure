import * as bedtools from "./bedtools";
import type { SummaryItem } from "../components/SummaryPlot";

/**
 * "Nearest gene by TSS" — for each region in a set, find every equally-
 * nearest protein-coding gene's TSS via `bedtools closest -d -t all`
 * (unsigned distance, every tie kept, no distance cutoff). See
 * docs/methods.md for why this is a descriptive assignment, not a
 * statistical test, and docs/provenance.md for how `genes_tss.bed` (built
 * by frontend/public/refdata/build_peak_annotation.py) was derived.
 *
 * Structured region→gene associations are preserved (not just a flat name
 * list) so this data can later feed a background gene universe for
 * GO/pathway enrichment (genes near any input region, not genome-wide) —
 * not built yet, but the shape doesn't need to change to support it.
 */

const MOUNT_DIR = "/shared/data";

export interface RegionGeneAssociation {
  region: { chrom: string; start: number; end: number };
  geneName: string;
  geneId: string;
  strand: string;
  distance: number;
}

/** Fetch + mount `genes_tss.bed` for an assembly; returns its mounted path. */
export async function fetchAndMountGeneTss(assembly: string): Promise<string> {
  const base = `${window.location.origin}${import.meta.env.BASE_URL}refdata/${assembly}`;
  const res = await fetch(`${base}/genes_tss.bed`);
  if (!res.ok) throw new Error(`Could not load ${assembly}/genes_tss.bed`);
  const mountName = `${assembly}.genes_tss.bed`;
  await bedtools.mount([{ name: mountName, data: await res.text() }]);
  return `${MOUNT_DIR}/${mountName}`;
}

export async function mountRawRegions(id: string, text: string): Promise<string> {
  const name = `${id}.genelist.raw`;
  await bedtools.mount([{ name, data: text }]);
  return `${MOUNT_DIR}/${name}`;
}

/**
 * `bedtools closest -d -t all` stdout: A's columns (variable width) then
 * B's fixed 6 columns (chrom, start, end, "geneName|geneId", score,
 * strand) then a trailing unsigned-distance column — read from the end so
 * this doesn't care how many columns A itself has (BED3, BED6, or the
 * 10-column narrowPeak-like shape this app's fixtures use). `-t all`
 * means a region with N equally-near genes produces N output lines, all
 * kept here as separate associations (not deduped yet).
 */
export function parseClosestGeneAssociations(stdout: string): RegionGeneAssociation[] {
  const out: RegionGeneAssociation[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.split("\t");
    if (fields.length < 10) continue;
    const n = fields.length;
    const distance = Number(fields[n - 1]);
    const strand = fields[n - 2];
    const name = fields[n - 4];
    const [geneName, geneId] = name.split("|");
    if (!Number.isFinite(distance) || !geneName) continue;
    out.push({
      region: { chrom: fields[0], start: Number(fields[1]), end: Number(fields[2]) },
      geneName,
      geneId: geneId ?? "",
      strand,
      distance,
    });
  }
  return out;
}

export async function computeGeneAssociations(item: SummaryItem, geneTssPath: string): Promise<RegionGeneAssociation[]> {
  const rawPath = await mountRawRegions(item.id, await item.getRawText());
  const result = await bedtools.exec(`bedtools closest -d -t all -a ${rawPath} -b ${geneTssPath}`);
  return parseClosestGeneAssociations(result.stdout);
}

/** Deduplicated, alphabetically sorted gene symbols — what the gene panel displays/exports. The structured associations stay the source of truth. */
export function uniqueGeneNames(associations: RegionGeneAssociation[]): string[] {
  return [...new Set(associations.map((a) => a.geneName))].sort((a, b) => a.localeCompare(b));
}
