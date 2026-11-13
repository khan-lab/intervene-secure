#!/usr/bin/env python3
"""
Derive small per-assembly peak-annotation reference BED files from the
vendored GENCODE GTFs, for the Summary tab's plotAnnoBar/plotDistToTSS
features (frontend/src/lib/peakAnnotation.ts). One-time preprocessing —
not run by the shipped app or by users. See docs/methods.md for the exact
category-window definitions this encodes, and docs/provenance.md for
source URLs/checksums.

Scope: protein-coding transcripts only (gene_type == transcript_type ==
"protein_coding"), per the project's own decision documented in
docs/methods.md.

Also emits `<out_dir>/genes_tss.bed` — one row per protein-coding *gene*
(not transcript, unlike tss_points.bed above), built directly from the
GTF's own `gene` feature rows, for the "Nearest gene by TSS" gene panel
(frontend/src/lib/geneList.ts). Kept separate from tss_points.bed: that
one is transcript-level and anonymous (feeds Region annotation's
distance-to-TSS histogram, which only needs a signed distance, not
identity); this one is gene-level and named (chrom, TSS, gene_name,
gene_id, strand — name column is "gene_name|gene_id", matching this
repo's own gtf_to_gene_bed.sh convention), and is never merged, since the
gene panel needs to keep each gene's identity.

Usage: python3 build_peak_annotation.py <assembly> <gtf.gz> <out_dir>
Run once per assembly (hg38, hg19, mm10, mm9); requires native `bedtools`
on PATH (used only here, to `merge` each category's intervals — not a
runtime dependency of the app).
"""
import gzip
import os
import re
import subprocess
import sys
from collections import defaultdict

CORE_PROMOTER_BP = 1000
PROMOTER_PROXIMAL_BP = 3000
DOWNSTREAM_BP = 3000

def parse_attributes(attr_str):
    # GTF attributes are `key "value";` for strings but `key value;` (no
    # quotes) for numeric ones like exon_number — a quoted-only regex
    # silently returns nothing for exon_number, which (having a default of
    # 0 as a fallback) then made every exon look like "the first exon".
    # Verified against a real CDS row before trusting this parser.
    attrs = {}
    for part in attr_str.strip().split(";"):
        part = part.strip()
        if not part:
            continue
        key, _, val = part.partition(" ")
        if key and key not in attrs:  # keep first occurrence (some tags repeat)
            attrs[key] = val.strip().strip('"')
    return attrs


def main():
    assembly, gtf_path, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    anno_dir = os.path.join(out_dir, "anno")
    os.makedirs(anno_dir, exist_ok=True)

    transcripts = {}  # tid -> (chrom, strand, start, end)  [BED 0-based half-open]
    exons = defaultdict(list)  # tid -> [(start, end, exon_number)]
    cds = defaultdict(list)
    utrs = defaultdict(list)
    genes = []  # [(chrom, strand, start, end, gene_name, gene_id)]

    opener = gzip.open if gtf_path.endswith(".gz") else open
    with opener(gtf_path, "rt") as f:
        for line in f:
            if line.startswith("#"):
                continue
            fields = line.rstrip("\n").split("\t")
            if len(fields) < 9:
                continue
            chrom, _source, feature, start, end, _score, strand, _frame, attr_str = fields
            if feature not in ("gene", "transcript", "exon", "CDS", "UTR"):
                continue
            attrs = parse_attributes(attr_str)
            if attrs.get("gene_type") != "protein_coding":
                continue
            start_i, end_i = int(start) - 1, int(end)  # GTF 1-based closed -> BED 0-based half-open
            if feature == "gene":
                genes.append((chrom, strand, start_i, end_i, attrs.get("gene_name", ""), attrs.get("gene_id", "")))
                continue
            if attrs.get("transcript_type") != "protein_coding":
                continue
            tid = attrs.get("transcript_id")
            if not tid:
                continue
            if feature == "transcript":
                transcripts[tid] = (chrom, strand, start_i, end_i)
            else:
                exon_number = int(attrs.get("exon_number", 0))
                (exons if feature == "exon" else cds if feature == "CDS" else utrs)[tid].append(
                    (start_i, end_i, exon_number)
                )

    out = {
        name: []
        for name in (
            "core_promoter", "promoter_proximal", "5utr", "first_exon", "other_exon",
            "3utr", "first_intron", "other_intron", "downstream", "tss_points",
        )
    }

    for tid, (chrom, strand, start, end) in transcripts.items():
        tss, tes = (start, end) if strand == "+" else (end, start)

        # TSS point (1bp), with strand — input to `bedtools closest -D b`.
        if strand == "+":
            out["tss_points"].append((chrom, tss, tss + 1, strand))
        else:
            out["tss_points"].append((chrom, max(0, tss - 1), tss, strand))

        # Core promoter / promoter-proximal windows are symmetric around
        # the TSS point itself, so — unlike downstream below — there is no
        # strand-dependent direction to apply here.
        core_lo, core_hi = max(0, tss - CORE_PROMOTER_BP), tss + CORE_PROMOTER_BP
        prox_lo, prox_hi = max(0, tss - PROMOTER_PROXIMAL_BP), tss + PROMOTER_PROXIMAL_BP
        out["core_promoter"].append((chrom, core_lo, core_hi))
        out["promoter_proximal"].append((chrom, prox_lo, core_lo))  # upstream ring
        out["promoter_proximal"].append((chrom, core_hi, prox_hi))  # downstream ring

        # Downstream window past the TES, strand-aware direction.
        if strand == "+":
            out["downstream"].append((chrom, tes, tes + DOWNSTREAM_BP))
        else:
            out["downstream"].append((chrom, max(0, tes - DOWNSTREAM_BP), tes))

        # First/other coding exon: exon_number is already assigned in
        # transcript (5'->3') order by GENCODE regardless of genomic
        # strand (verified on real data), and is reliably present on CDS
        # rows in every vendored GTF, so no strand handling is needed here.
        t_cds = cds.get(tid, [])
        if t_cds:
            min_cds_en = min(en for _, _, en in t_cds)
            for s, e, en in t_cds:
                out["first_exon" if en == min_cds_en else "other_exon"].append((chrom, s, e))

            # 5'/3' UTR: classified by genomic position relative to the
            # CDS span (strand-aware), NOT by exon_number — verified that
            # older GENCODE releases (hg19 v19, mm9 M1) omit exon_number on
            # UTR rows entirely (100% missing on both), which silently
            # miscategorized every UTR as 5' in an earlier version of this
            # script (exon_number defaulted to 0, always < any real
            # min_cds_en). Position + strand is present on every row in
            # every GENCODE release, so it doesn't have this failure mode.
            cds_min_start = min(s for s, _, _ in t_cds)
            cds_max_end = max(e for _, e, _ in t_cds)
            for s, e, _en in utrs.get(tid, []):
                if e <= cds_min_start:
                    out["5utr" if strand == "+" else "3utr"].append((chrom, s, e))
                elif s >= cds_max_end:
                    out["3utr" if strand == "+" else "5utr"].append((chrom, s, e))
                # Otherwise the UTR interval overlaps the CDS span itself —
                # not expected for valid annotation, skipped rather than
                # guessed.

        # Introns: gaps between consecutive exons, sorted genomically.
        # "First" = the intron adjacent to the transcript's first exon
        # (exon_number's minimum) — using exon_number, not genomic
        # position, keeps this correct for both strands.
        t_exons = sorted(exons.get(tid, []), key=lambda x: x[0])
        if len(t_exons) > 1:
            min_exon_number = min(en for _, _, en in t_exons)
            for i in range(len(t_exons) - 1):
                intron_start, intron_end = t_exons[i][1], t_exons[i + 1][0]
                if intron_end <= intron_start:
                    continue
                is_first = min(t_exons[i][2], t_exons[i + 1][2]) == min_exon_number
                out["first_intron" if is_first else "other_intron"].append((chrom, intron_start, intron_end))

    for name, rows in out.items():
        path = os.path.join(anno_dir, f"{name}.bed")
        rows.sort()
        with open(path, "w") as fh:
            for row in rows:
                if len(row) == 4:
                    chrom, s, e, strand = row
                    fh.write(f"{chrom}\t{s}\t{e}\t.\t0\t{strand}\n")
                elif row[2] > row[1]:
                    chrom, s, e = row
                    fh.write(f"{chrom}\t{s}\t{e}\n")

        if name != "tss_points":
            # Safe to merge: classification only needs "does a peak
            # overlap any interval in this category," not per-transcript
            # identity — and it keeps these reference files much smaller.
            merged = subprocess.run(["bedtools", "merge", "-i", path], capture_output=True, text=True, check=True)
            with open(path, "w") as fh:
                fh.write(merged.stdout)

        print(f"{assembly}: {name}.bed — {sum(1 for _ in open(path))} intervals")

    # Gene-level TSS points, named, never merged — see module docstring.
    gene_tss_rows = []
    for chrom, strand, start, end, gene_name, gene_id in genes:
        tss = start if strand == "+" else end
        if strand == "+":
            tss_start, tss_end = tss, tss + 1
        else:
            tss_start, tss_end = max(0, tss - 1), tss
        gene_tss_rows.append((chrom, tss_start, tss_end, gene_name, gene_id, strand))

    gene_tss_rows.sort()
    gene_tss_path = os.path.join(out_dir, "genes_tss.bed")
    with open(gene_tss_path, "w") as fh:
        for chrom, s, e, gene_name, gene_id, strand in gene_tss_rows:
            fh.write(f"{chrom}\t{s}\t{e}\t{gene_name}|{gene_id}\t0\t{strand}\n")
    print(f"{assembly}: genes_tss.bed — {len(gene_tss_rows)} genes")


if __name__ == "__main__":
    main()
