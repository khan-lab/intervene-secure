/**
 * Registry of built-in external annotation region sets — small,
 * locally-vendored BED files (see docs/provenance.md for source/licence
 * details) that a user can add as a region set with one click, exactly
 * like an uploaded file. Filtered by the currently selected assembly and
 * grouped by `category` in `SetRail.tsx`'s External annotations card.
 *
 * Hand-maintained and kept 1:1 with what
 * `public/refdata/build_external_annotations.py` writes under
 * `public/refdata/<assembly>/external/` — there is no way to list a static
 * site's own files at runtime. `externalAnnotations.test.ts` enforces the
 * 1:1 match, that every file parses cleanly and fits its assembly, and that
 * each description's region count matches its file. Adding a dataset: build
 * the file, add one entry here, add a docs/provenance.md row.
 *
 * An entry with no `path` is a placeholder: listed but not addable, with
 * `unavailableReason` shown instead.
 */
export type AnnotationCategory = "Regulatory elements" | "Genomic features" | "Variants and disease";

export const ANNOTATION_CATEGORIES: AnnotationCategory[] = ["Regulatory elements", "Genomic features", "Variants and disease"];

export interface ExternalAnnotation {
  id: string;
  assembly: string;
  category: AnnotationCategory;
  name: string;
  /** Short set name shown in plots once added (the full name is too long for UpSet/Venn labels). */
  setName: string;
  /** 3-letter set code — distinct per dataset, since codes identify sets in every plot. */
  code: string;
  description: string;
  /** Relative to BASE_URL, e.g. "refdata/hg38/external/vista_enhancers.bed". Absent for placeholders. */
  path?: string;
  sourceUrl: string;
  /** Shown instead of the Add button when there is no `path`. */
  unavailableReason?: string;
}

const UCSC_DB = "https://hgdownload.soe.ucsc.edu/goldenPath";
const FANTOM = "https://fantom.gsc.riken.jp/5/datafiles";

const CPG: [string, string][] = [
  ["hg38", "27,949"],
  ["hg19", "27,718"],
  ["mm10", "16,009"],
  ["mm9", "15,991"],
];

const CCRE: { assembly: string; annotation: string; counts: [string, string, string] }[] = [
  { assembly: "hg38", annotation: "ENCSR800VNX", counts: ["47,532", "249,464", "126,034"] },
  { assembly: "mm10", annotation: "ENCSR412JPD", counts: ["27,332", "111,218", "45,933"] },
];

const FANTOM5: [string, string, string][] = [
  ["hg38", "63,285", `${FANTOM}/reprocessed/hg38_latest/extra/enhancer/`],
  ["hg19", "65,423", `${FANTOM}/latest/extra/Enhancers/`],
  ["mm10", "49,797", `${FANTOM}/reprocessed/mm10_latest/extra/enhancer/`],
  ["mm9", "44,459", `${FANTOM}/latest/extra/Enhancers/`],
];

export const EXTERNAL_ANNOTATIONS: ExternalAnnotation[] = [
  // ---- Regulatory elements ----
  {
    id: "vista-enhancers-hg38",
    assembly: "hg38",
    category: "Regulatory elements",
    name: "VISTA enhancers",
    setName: "VISTA",
    code: "VIS",
    description: "2,143 experimentally validated developmental enhancers (positive elements only).",
    path: "refdata/hg38/external/vista_enhancers.bed",
    sourceUrl: "https://enhancer.lbl.gov/",
  },
  {
    id: "vista-enhancers-mm10",
    assembly: "mm10",
    category: "Regulatory elements",
    name: "VISTA enhancers",
    setName: "VISTA",
    code: "VIS",
    description: "2,149 experimentally validated developmental enhancers (positive elements only).",
    path: "refdata/mm10/external/vista_enhancers.bed",
    sourceUrl: "https://enhancer.lbl.gov/",
  },
  ...CCRE.flatMap(({ assembly, annotation, counts: [pls, pels, ctcf] }): ExternalAnnotation[] => [
    {
      id: `encode-ccre-pls-${assembly}`,
      assembly,
      category: "Regulatory elements",
      name: "ENCODE cCREs: promoter-like",
      setName: "cCRE-PLS",
      code: "PLS",
      description: `${pls} promoter-like elements (PLS), ENCODE V4 registry, all cell types.`,
      path: `refdata/${assembly}/external/encode_ccre_pls.bed`,
      sourceUrl: `https://www.encodeproject.org/annotations/${annotation}/`,
    },
    {
      id: `encode-ccre-pels-${assembly}`,
      assembly,
      category: "Regulatory elements",
      name: "ENCODE cCREs: proximal enhancer-like",
      setName: "cCRE-pELS",
      code: "PEL",
      description: `${pels} enhancer-like elements within 2 kb of a TSS (pELS), ENCODE V4 registry.`,
      path: `refdata/${assembly}/external/encode_ccre_pels.bed`,
      sourceUrl: `https://www.encodeproject.org/annotations/${annotation}/`,
    },
    {
      id: `encode-ccre-ctcf-${assembly}`,
      assembly,
      category: "Regulatory elements",
      name: "ENCODE cCREs: CTCF-bound",
      setName: "cCRE-CTCF",
      code: "CTC",
      description: `${ctcf} accessible CTCF-bound elements (CA-CTCF), ENCODE V4 registry.`,
      path: `refdata/${assembly}/external/encode_ccre_ctcf.bed`,
      sourceUrl: `https://www.encodeproject.org/annotations/${annotation}/`,
    },
  ]),
  ...FANTOM5.map(
    ([assembly, count, url]): ExternalAnnotation => ({
      id: `fantom5-enhancers-${assembly}`,
      assembly,
      category: "Regulatory elements",
      name: "FANTOM5 enhancers",
      setName: "FANTOM5",
      code: "F5E",
      description: `${count} transcribed enhancers defined by bidirectional CAGE (FANTOM5 permissive set).`,
      path: `refdata/${assembly}/external/fantom5_enhancers.bed`,
      sourceUrl: url,
    })
  ),
 

  // ---- Genomic features ----
  ...CPG.map(
    ([assembly, count]): ExternalAnnotation => ({
      id: `cpg-islands-${assembly}`,
      assembly,
      category: "Genomic features",
      name: "CpG islands",
      setName: "CpG islands",
      code: "CPG",
      description: `${count} CpG islands (UCSC track), primary chromosomes and assembled contigs.`,
      path: `refdata/${assembly}/external/cpg_islands.bed`,
      sourceUrl: `${UCSC_DB}/${assembly}/database/cpgIslandExt.txt.gz`,
    })
  ),

  // ---- Variants and disease ----
  {
    id: "clinvar-pathogenic-hg38",
    assembly: "hg38",
    category: "Variants and disease",
    name: "ClinVar pathogenic variants",
    setName: "ClinVar P/LP",
    code: "CLV",
    description: "337,757 germline pathogenic / likely pathogenic variants with review criteria provided.",
    path: "refdata/hg38/external/clinvar_pathogenic.bed",
    sourceUrl: "https://ftp.ncbi.nlm.nih.gov/pub/clinvar/vcf_GRCh38/",
  },
  {
    id: "clinvar-pathogenic-hg19",
    assembly: "hg19",
    category: "Variants and disease",
    name: "ClinVar pathogenic variants",
    setName: "ClinVar P/LP",
    code: "CLV",
    description: "337,605 germline pathogenic / likely pathogenic variants with review criteria provided.",
    path: "refdata/hg19/external/clinvar_pathogenic.bed",
    sourceUrl: "https://ftp.ncbi.nlm.nih.gov/pub/clinvar/vcf_GRCh37/",
  },
  {
    id: "gwas-catalog-hg38",
    assembly: "hg38",
    category: "Variants and disease",
    name: "GWAS Catalog associations",
    setName: "GWAS Catalog",
    code: "GWA",
    description: "332,526 variant positions with a genome-wide significant (P ≤ 5×10⁻⁸) single-SNP association.",
    path: "refdata/hg38/external/gwas_catalog.bed",
    sourceUrl: "https://www.ebi.ac.uk/gwas/docs/file-downloads",
  },
  {
    id: "fine-mapping-hg38",
    assembly: "hg38",
    category: "Variants and disease",
    name: "Fine-mapping regions",
    setName: "Fine-mapping",
    code: "FMR",
    description: "144 fine-mapping regions for hg38 (lifted over from hg19).",
    path: "refdata/hg38/external/fine_mapping_regions.bed",
    sourceUrl: "https://doi.org/10.1038/s41588-019-0537-1",
  },
  {
    id: "fine-mapping-hg19",
    assembly: "hg19",
    category: "Variants and disease",
    name: "Fine-mapping regions",
    setName: "Fine-mapping",
    code: "FMR",
    description: "152 fine-mapping regions for hg19.",
    path: "refdata/hg19/external/fine_mapping_regions.bed",
    sourceUrl: "https://doi.org/10.1038/s41588-019-0537-1",
  },
];
