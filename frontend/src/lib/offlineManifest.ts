/**
 * Offline mode: which built files the service worker (public/sw.js) caches.
 * Paths are relative to the site root (the Vite `base`).
 *
 * - "shell": cached on the first visit — the app, bedtools WebAssembly,
 *   example data and chromosome sizes (~5 MB). Enough to load files and
 *   compute intersections with no network.
 * - "data": per-assembly reference data (annotation, TSS, problematic
 *   regions, built-in reference sets, GO, Cistrome-GO gene model; 20–70 MB per assembly) — cached the
 *   first time the app uses it, or all at once from the Help page.
 * - null: never cached (build inputs such as GENCODE GTFs and scripts, the
 *   service worker and its manifest themselves).
 *
 * Allow-list, not deny-list, so a new stray file in public/ can't silently
 * bloat the cache. Used by the manifest plugin in vite.config.ts.
 */

export type OfflineKind = "shell" | "data" | null;

const ASSEMBLY = "(hg38|hg19|mm10|mm9)";
const SHELL: RegExp[] = [
  /^index\.html$/,
  /^assets\/[^/]+\.(js|css|svg|png|woff2?)$/,
  /^wasm\/(bedtools|aioli)\/[^/]+$/,
  /^(favicon|icons|logo)\.(svg|png)$/,
  /^examples\/[^/]+(\/[^/]+)?\.bed$/,
  new RegExp(`^refdata/${ASSEMBLY}/\\1\\.chrom\\.sizes$`),
];
const DATA: RegExp[] = [
  new RegExp(`^refdata/${ASSEMBLY}/anno/[^/]+\\.bed$`),
  new RegExp(`^refdata/${ASSEMBLY}/genes_tss\\.bed$`),
  new RegExp(`^refdata/${ASSEMBLY}/blacklist/[^/]+\\.bed$`),
  new RegExp(`^refdata/${ASSEMBLY}/external/[^/]+\\.bed$`),
  new RegExp(`^refdata/${ASSEMBLY}/go/(go\\.json|gaps\\.bed)$`),
  new RegExp(`^refdata/${ASSEMBLY}/cistromego/rp_model\\.json$`),
];

export function classifyOfflineFile(path: string): OfflineKind {
  if (SHELL.some((r) => r.test(path))) return "shell";
  if (DATA.some((r) => r.test(path))) return "data";
  return null;
}

/** The assembly a data file belongs to, e.g. "refdata/hg38/anno/x.bed" -> "hg38". */
export function dataAssembly(path: string): string | null {
  return path.match(new RegExp(`^refdata/${ASSEMBLY}/`))?.[1] ?? null;
}

export interface OfflineManifest {
  /** Changes whenever any listed file changes; names the shell cache. */
  version: string;
  /** path -> short content hash. */
  shell: Record<string, string>;
  data: Record<string, { hash: string; bytes: number; assembly: string }>;
}
