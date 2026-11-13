#!/usr/bin/env python3
"""
Build the built-in external annotation region sets under
frontend/public/refdata/<assembly>/external/. One-time preprocessing — not
run by the shipped app or by users. See docs/provenance.md for source URLs,
checksums, licences and the exact filters used; frontend/src/lib/
externalAnnotations.ts is the registry the app reads, kept 1:1 with what this
script writes.

Every source URL below is the provider's own official download location.
Downloads are cached in <scratch_dir> and reused if already present, so a
re-run only re-derives. Every output is plain BED4 (chrom, start, end, name),
sorted by chrom then start, restricted to chromosomes in the assembly's
vendored chrom.sizes, with every interval inside the chromosome — anything
else is dropped and counted in the printed summary.

Sets:
  vista_enhancers     VISTA positive (validated) elements, via UCSC bigBed  hg38 mm10
  cpg_islands         UCSC cpgIslandExt                                     hg38 hg19 mm10 mm9
  encode_ccre_{pls,pels,ctcf}
                      ENCODE V4 cCRE registry (cell-type agnostic), by class:
                      PLS, pELS, CA-CTCF. dELS (1.47M regions on hg38) is not
                      vendored — too large for the browser path.             hg38 mm10
  fantom5_enhancers   FANTOM5 permissive enhancers (original hg19/mm9 release;
                      RIKEN's reprocessed hg38/mm10 release)                 hg38 hg19 mm10 mm9
  clinvar_pathogenic  ClinVar germline P / LP / P-LP with review status of at
                      least "criteria provided"                              hg38 hg19
  gwas_catalog        NHGRI-EBI GWAS Catalog: unique variant positions with a
                      single-SNP association at P <= 5e-8 (GRCh38 mapping)    hg38

Also built here, but not an annotation set (written to <assembly>/blacklist/,
not external/, and read by frontend/src/lib/blacklist.ts):
  blacklist           ENCODE Blacklist v2 (Boyle lab), all regions as given
                      (High Signal Region + Low Mappability). No v2 for mm9.  hg38 hg19 mm10

Usage: python3 frontend/public/refdata/build_external_annotations.py <scratch_dir> [set ...]
  With set names (e.g. `blacklist cpg`), builds only those; default builds all.
Run from the repo root. Requires UCSC `bigBedToBed` (downloaded automatically, macOS arm64 build).
"""
import gzip
import os
import subprocess
import sys
import urllib.request

REFDATA = os.path.join("frontend", "public", "refdata")
UCSC = "https://hgdownload.soe.ucsc.edu"

BIGBEDTOBED_URL = f"{UCSC}/admin/exe/macOSX.arm64/bigBedToBed"
VISTA_POSITIVE_RGB = "34,96,242"
VISTA = {
    "hg38": f"{UCSC}/gbdb/hg38/vistaEnhancers/vistaEnhancers.bb",
    "mm10": f"{UCSC}/gbdb/mm10/vistaEnhancers/vistaEnhancers.bb",
}

CPG = {a: f"{UCSC}/goldenPath/{a}/database/cpgIslandExt.txt.gz" for a in ("hg38", "hg19", "mm10", "mm9")}

ENCODE = "https://www.encodeproject.org/files"
CCRE = {
    # ENCSR800VNX / ENCSR412JPD: "agnostic candidate Cis-Regulatory Elements" (ENCODE v4)
    "hg38": ("ENCFF420VPZ.bed.gz", f"{ENCODE}/ENCFF420VPZ/@@download/ENCFF420VPZ.bed.gz"),
    "mm10": ("ENCFF167FJQ.bed.gz", f"{ENCODE}/ENCFF167FJQ/@@download/ENCFF167FJQ.bed.gz"),
}
CCRE_CLASSES = {"pls": "PLS", "pels": "pELS", "ctcf": "CA-CTCF"}

FANTOM = "https://fantom.gsc.riken.jp/5/datafiles"
FANTOM5 = {
    "hg38": ("F5.hg38.enhancers.bed.gz", f"{FANTOM}/reprocessed/hg38_latest/extra/enhancer/F5.hg38.enhancers.bed.gz"),
    "mm10": ("F5.mm10.enhancers.bed.gz", f"{FANTOM}/reprocessed/mm10_latest/extra/enhancer/F5.mm10.enhancers.bed.gz"),
    "hg19": (
        "human_permissive_enhancers_phase_1_and_2.bed.gz",
        f"{FANTOM}/latest/extra/Enhancers/human_permissive_enhancers_phase_1_and_2.bed.gz",
    ),
    "mm9": (
        "mouse_permissive_enhancers_phase_1_and_2.bed.gz",
        f"{FANTOM}/latest/extra/Enhancers/mouse_permissive_enhancers_phase_1_and_2.bed.gz",
    ),
}

CLINVAR = {
    "hg38": ("clinvar_GRCh38.vcf.gz", "https://ftp.ncbi.nlm.nih.gov/pub/clinvar/vcf_GRCh38/clinvar.vcf.gz"),
    "hg19": ("clinvar_GRCh37.vcf.gz", "https://ftp.ncbi.nlm.nih.gov/pub/clinvar/vcf_GRCh37/clinvar.vcf.gz"),
}
CLINVAR_KEEP = {"Pathogenic", "Likely_pathogenic", "Pathogenic/Likely_pathogenic"}
# ClinVar review status -> stars >= 1. Excludes no_assertion_criteria_provided,
# no_classification_provided, no_classifications_from_unflagged_records.
CLINVAR_REVIEW_OK = {
    "criteria_provided,_single_submitter",
    "criteria_provided,_multiple_submitters,_no_conflicts",
    "reviewed_by_expert_panel",
    "practice_guideline",
}


GWAS_ZIP = ("gwas-catalog-associations-full.zip", "https://ftp.ebi.ac.uk/pub/databases/gwas/releases/latest/gwas-catalog-associations-full.zip")
GWAS_P_MAX = 5e-8

# Same source as the dev branch's refdata/Makefile (BLACKLIST_BASE). The repo
# publishes no checksums; sha256 of what we downloaded is in docs/provenance.md.
BLACKLIST_BASE = "https://github.com/Boyle-Lab/Blacklist/raw/master/lists"
BLACKLIST = {a: (f"{a}-blacklist.v2.bed.gz", f"{BLACKLIST_BASE}/{a}-blacklist.v2.bed.gz") for a in ("hg38", "hg19", "mm10")}


def fetch(scratch, name, url):
    path = os.path.join(scratch, name)
    if not os.path.exists(path):
        print(f"Downloading {url}")
        urllib.request.urlretrieve(url, path)
    return path


def chrom_sizes(assembly):
    sizes = {}
    with open(os.path.join(REFDATA, assembly, f"{assembly}.chrom.sizes")) as fh:
        for line in fh:
            chrom, length = line.split()[:2]
            sizes[chrom] = int(length)
    return sizes


def write_bed(assembly, filename, rows, total, subdir="external"):
    """rows: iterable of (chrom, start, end, name). Keeps only intervals inside the assembly's chrom.sizes."""
    sizes = chrom_sizes(assembly)
    kept = []
    dropped = 0
    for chrom, start, end, name in rows:
        if chrom in sizes and 0 <= start <= end <= sizes[chrom]:
            kept.append((chrom, start, end, name))
        else:
            dropped += 1
    kept.sort(key=lambda r: (r[0], r[1], r[2]))
    out_dir = os.path.join(REFDATA, assembly, subdir)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, filename)
    with open(out_path, "w") as out:
        for chrom, start, end, name in kept:
            out.write(f"{chrom}\t{start}\t{end}\t{name}\n")
    print(f"{assembly} {filename}: {len(kept):,} kept of {total:,} candidates ({dropped:,} outside {assembly} chrom.sizes)")


def build_vista(scratch):
    bigbed_to_bed = fetch(scratch, "bigBedToBed", BIGBEDTOBED_URL)
    os.chmod(bigbed_to_bed, 0o755)
    for assembly, url in VISTA.items():
        bb = fetch(scratch, f"{assembly}_vistaEnhancers.bb", url)
        bed = os.path.join(scratch, f"{assembly}_vistaEnhancers.bed")
        subprocess.run([bigbed_to_bed, bb, bed], check=True)
        rows, total = [], 0
        with open(bed) as fh:
            for line in fh:
                f = line.rstrip("\n").split("\t")
                total += 1
                if len(f) >= 9 and f[8] == VISTA_POSITIVE_RGB:
                    rows.append((f[0], int(f[1]), int(f[2]), f[3]))
        write_bed(assembly, "vista_enhancers.bed", rows, total)


def build_cpg(scratch):
    for assembly, url in CPG.items():
        path = fetch(scratch, f"cpg_{assembly}.txt.gz", url)
        rows, total = [], 0
        with gzip.open(path, "rt") as fh:
            # bin, chrom, chromStart, chromEnd, name ("CpG: 111"), length, cpgNum, gcNum, perCpg, perGc, obsExp
            for line in fh:
                f = line.rstrip("\n").split("\t")
                total += 1
                rows.append((f[1], int(f[2]), int(f[3]), f"CpG:{f[6]}"))
        write_bed(assembly, "cpg_islands.bed", rows, total)


def build_ccre(scratch):
    for assembly, (name, url) in CCRE.items():
        path = fetch(scratch, name, url)
        by_class = {k: [] for k in CCRE_CLASSES}
        totals = {k: 0 for k in CCRE_CLASSES}
        wanted = {v: k for k, v in CCRE_CLASSES.items()}
        with gzip.open(path, "rt") as fh:
            # bed9+: chrom, start, end, accession, score, strand, thickStart, thickEnd, rgb, class
            for line in fh:
                f = line.rstrip("\n").split("\t")
                key = wanted.get(f[9])
                if key:
                    totals[key] += 1
                    by_class[key].append((f[0], int(f[1]), int(f[2]), f[3]))
        for key, rows in by_class.items():
            write_bed(assembly, f"encode_ccre_{key}.bed", rows, totals[key])


def build_fantom5(scratch):
    for assembly, (name, url) in FANTOM5.items():
        path = fetch(scratch, name, url)
        rows, total = [], 0
        with gzip.open(path, "rt") as fh:
            for line in fh:
                if line.startswith("track"):
                    continue
                f = line.rstrip("\n").split("\t")
                total += 1
                rows.append((f[0], int(f[1]), int(f[2]), f[3]))
        write_bed(assembly, "fantom5_enhancers.bed", rows, total)


def info_field(info, key):
    for item in info.split(";"):
        if item.startswith(key + "="):
            return item[len(key) + 1 :]
    return ""


def build_clinvar(scratch):
    for assembly, (name, url) in CLINVAR.items():
        path = fetch(scratch, name, url)
        rows, total = [], 0
        with gzip.open(path, "rt") as fh:
            for line in fh:
                if line.startswith("#"):
                    continue
                total += 1
                chrom, pos, vid, ref, _alt, _q, _f, info = line.rstrip("\n").split("\t")[:8]
                # Primary germline classification = first "|"-separated term.
                if info_field(info, "CLNSIG").split("|")[0] not in CLINVAR_KEEP:
                    continue
                if info_field(info, "CLNREVSTAT") not in CLINVAR_REVIEW_OK:
                    continue
                if chrom == "MT":
                    # hg38 chrM is rCRS (same as GRCh38 MT). hg19's chrM is the older
                    # NC_001807 sequence, so GRCh37 MT coordinates don't apply to it.
                    if assembly == "hg19":
                        continue
                    ucsc = "chrM"
                else:
                    ucsc = f"chr{chrom}"
                # Same interval bedtools uses for VCF: [POS-1, POS-1+len(REF)).
                start = int(pos) - 1
                gene = info_field(info, "GENEINFO").split(":")[0]
                rows.append((ucsc, start, start + len(ref), f"{gene}|{vid}" if gene else vid))
        write_bed(assembly, "clinvar_pathogenic.bed", rows, total)


def build_gwas(scratch):
    import csv
    import io
    import zipfile

    path = fetch(scratch, *GWAS_ZIP)
    with zipfile.ZipFile(path) as zf:
        (member,) = [n for n in zf.namelist() if n.endswith(".tsv")]
        positions = {}
        total = 0
        with zf.open(member) as raw:
            reader = csv.reader(io.TextIOWrapper(raw, encoding="utf-8", newline=""), delimiter="\t")
            ix = {k: i for i, k in enumerate(next(reader))}
            for row in reader:
                total += 1
                chrom, pos, p = row[ix["CHR_ID"]], row[ix["CHR_POS"]], row[ix["P-VALUE"]]
                # No GRCh38 mapping, or a multi-SNP (haplotype / interaction) association.
                if not chrom or not pos.isdigit():
                    continue
                try:
                    if float(p) > GWAS_P_MAX:
                        continue
                except ValueError:
                    continue
                ucsc = "chrM" if chrom == "MT" else f"chr{chrom}"
                snp = row[ix["SNPS"]].strip()
                current = row[ix["SNP_ID_CURRENT"]].strip()
                name = snp if snp.startswith("rs") else (f"rs{current}" if current.isdigit() else f"{ucsc}:{pos}")
                # CHR_POS is 1-based -> one-base BED interval. One region per position.
                positions.setdefault((ucsc, int(pos)), name)
    rows = [(c, p - 1, p, n) for (c, p), n in positions.items()]
    write_bed("hg38", "gwas_catalog.bed", rows, len(rows))
    print(f"  (from {total:,} association rows)")


def build_blacklist(scratch):
    for assembly, (name, url) in BLACKLIST.items():
        rows = []
        with gzip.open(fetch(scratch, name, url), "rt") as fh:
            for line in fh:
                f = line.rstrip("\n").split("\t")
                if len(f) < 3:
                    continue
                rows.append((f[0], int(f[1]), int(f[2]), f[3].replace(" ", "_") if len(f) > 3 else "blacklist"))
        write_bed(assembly, "encode_blacklist_v2.bed", rows, len(rows), subdir="blacklist")


BUILDERS = {
    "vista": build_vista,
    "cpg": build_cpg,
    "ccre": build_ccre,
    "fantom5": build_fantom5,
    "clinvar": build_clinvar,
    "gwas": build_gwas,
    "blacklist": build_blacklist,
}


def main():
    scratch = sys.argv[1]
    only = sys.argv[2:] or list(BUILDERS)
    unknown = [n for n in only if n not in BUILDERS]
    if unknown:
        sys.exit(f"Unknown set(s): {', '.join(unknown)}. Choose from: {', '.join(BUILDERS)}")
    os.makedirs(scratch, exist_ok=True)
    for name in only:
        BUILDERS[name](scratch)


if __name__ == "__main__":
    main()
