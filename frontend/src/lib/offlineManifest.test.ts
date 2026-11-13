import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyOfflineFile, dataAssembly } from "./offlineManifest";

/**
 * Which built files the service worker caches (public/sw.js, manifest
 * written by the vite plugin in vite.config.ts): the app shell up front,
 * reference data when used or on request, and nothing else — in particular
 * never the raw GENCODE GTFs or build scripts that sit in public/refdata.
 */

describe("classifyOfflineFile", () => {
  const cases: [string, ReturnType<typeof classifyOfflineFile>][] = [
    ["index.html", "shell"],
    ["assets/index-3f9a2c1b.js", "shell"],
    ["assets/index-77aa01.css", "shell"],
    ["wasm/bedtools/bedtools.wasm", "shell"],
    ["wasm/bedtools/bedtools.data", "shell"],
    ["wasm/aioli/aioli.js", "shell"],
    ["favicon.svg", "shell"],
    ["logo.png", "shell"],
    ["examples/hg38_ses/MCF7.bed", "shell"],
    ["refdata/hg38/hg38.chrom.sizes", "shell"],
    ["refdata/mm9/mm9.chrom.sizes", "shell"],
    ["refdata/hg38/anno/tss_points.bed", "data"],
    ["refdata/hg38/genes_tss.bed", "data"],
    ["refdata/hg19/blacklist/encode_blacklist_v2.bed", "data"],
    ["refdata/mm10/external/cpg_islands.bed", "data"],
    ["refdata/hg38/go/go.json", "data"],
    ["refdata/mm9/go/gaps.bed", "data"],
    ["refdata/hg19/cistromego/rp_model.json", "data"],
    ["refdata/build_cistromego.py", null],
    ["refdata/build_go.py", null],
    ["refdata/hg38/gencode.v50.annotation.gtf.gz", null],
    ["refdata/build_external_annotations.py", null],
    ["refdata/__pycache__/build_peak_annotation.cpython-314.pyc", null],
    ["refdata/gtf_to_gene_bed.sh", null],
    ["refdata/hg38.gencode.v50.genes.bed", null],
    ["refdata/chm132.0/hs1.chrom.sizes", null],
    ["sw.js", null],
    ["offline-manifest.json", null],
  ];
  for (const [path, kind] of cases) it(`${path} -> ${kind}`, () => expect(classifyOfflineFile(path)).toBe(kind));
});

describe("dataAssembly", () => {
  it("names the assembly a data file belongs to", () => {
    expect(dataAssembly("refdata/hg38/external/gwas_catalog.bed")).toBe("hg38");
    expect(dataAssembly("refdata/mm9/anno/3utr.bed")).toBe("mm9");
    expect(dataAssembly("assets/x.js")).toBeNull();
  });
});

describe("the real public/ directory", () => {
  const PUBLIC = join(__dirname, "../../public");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : [relative(PUBLIC, p)];
    });
  const files = walk(PUBLIC);

  it("caches every reference file the app fetches, for every assembly", () => {
    for (const asm of ["hg38", "hg19", "mm10", "mm9"]) {
      expect(classifyOfflineFile(`refdata/${asm}/${asm}.chrom.sizes`)).toBe("shell");
      const data = files.filter((f) => classifyOfflineFile(f) === "data" && dataAssembly(f) === asm);
      expect(data.some((f) => f.includes("/anno/"))).toBe(true);
      expect(data).toContain(`refdata/${asm}/genes_tss.bed`);
      expect(data).toContain(`refdata/${asm}/go/go.json`);
      expect(data).toContain(`refdata/${asm}/go/gaps.bed`);
      expect(data).toContain(`refdata/${asm}/cistromego/rp_model.json`);
    }
  });

  it("keeps the app shell small enough to cache on the first visit (< 10 MB)", () => {
    const shell = files.filter((f) => classifyOfflineFile(f) === "shell");
    const bytes = shell.reduce((n, f) => n + statSync(join(PUBLIC, f)).size, 0);
    expect(bytes).toBeLessThan(10 * 1024 * 1024);
  });
});
