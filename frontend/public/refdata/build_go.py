#!/usr/bin/env python3
"""
Build the GO data for GREAT-style enrichment (frontend/src/lib/great.ts),
per assembly, under frontend/public/refdata/<assembly>/go/:

  go.json   genes (symbol, chrom, TSS, strand) and GO terms per namespace
            (BP, MF, CC) with the indices of their genes, after
            propagation; terms with 5..2000 genes only (the app applies each
            method's own term-size limits; GREAT 5..1000, Cistrome-GO 11..1999).
  gaps.bed  UCSC assembly gaps on the genome's chromosomes (for the
            binomial test's non-gap genome size).

One-time preprocessing, not run by the app. The null model and every rule
applied here are specified in docs/methods.md ("GO enrichment of selected
subsets"); sources and checksums are in docs/provenance.md.

Sources (official locations only):
  go-basic.obo  http://purl.obolibrary.org/obo/go/go-basic.obo
  GAF           https://current.geneontology.org/annotations/{goa_human,mgi}.gaf.gz
  gaps          https://hgdownload.soe.ucsc.edu/goldenPath/<asm>/database/gap.txt.gz
                (mm9: one chr<N>_gap.txt.gz table per chromosome)
Genes: the already-vendored refdata/<asm>/genes_tss.bed (GENCODE protein-coding).

Usage: python3 frontend/public/refdata/build_go.py <scratch_dir>   (from the repo root)
"""
import gzip
import json
import os
import sys
import urllib.request

REFDATA = os.path.join("frontend", "public", "refdata")
UCSC = "https://hgdownload.soe.ucsc.edu/goldenPath"
OBO_URL = "http://purl.obolibrary.org/obo/go/go-basic.obo"
GAF = {
    "human": ("goa_human.gaf.gz", "https://current.geneontology.org/annotations/goa_human.gaf.gz"),
    "mouse": ("mgi.gaf.gz", "https://current.geneontology.org/annotations/mgi.gaf.gz"),
}
SPECIES = {"hg38": "human", "hg19": "human", "mm10": "mouse", "mm9": "mouse"}
NAMESPACES = {"biological_process": "BP", "molecular_function": "MF", "cellular_component": "CC"}
MIN_GENES, MAX_GENES = 5, 2000


def fetch(scratch, name, url):
    path = os.path.join(scratch, name)
    if not os.path.exists(path):
        print(f"Downloading {url}")
        # purl.obolibrary.org answers 403 to Python's default User-Agent.
        req = urllib.request.Request(url, headers={"User-Agent": "intervene-build-go/1.0 (+https://github.com/khan-lab/intervene-secure)"})
        with urllib.request.urlopen(req) as res, open(path, "wb") as out:
            out.write(res.read())
    return path


def parse_obo(path):
    """term id -> (name, namespace, parents over is_a + part_of); obsolete terms dropped."""
    terms, cur = {}, None
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if line.startswith("["):
                if cur and cur.get("id", "").startswith("GO:") and not cur.get("obsolete"):
                    terms[cur["id"]] = cur
                cur = {"parents": set()} if line == "[Term]" else None
                continue
            if cur is None or ": " not in line:
                continue
            key, val = line.split(": ", 1)
            if key == "id":
                cur["id"] = val
            elif key == "name":
                cur["name"] = val
            elif key == "namespace":
                cur["ns"] = val
            elif key == "is_obsolete" and val == "true":
                cur["obsolete"] = True
            elif key == "is_a":
                cur["parents"].add(val.split()[0])
            elif key == "relationship" and val.startswith("part_of "):
                cur["parents"].add(val.split()[1])
    if cur and cur.get("id", "").startswith("GO:") and not cur.get("obsolete"):
        terms[cur["id"]] = cur
    return terms


def ancestors_fn(terms):
    memo = {}

    def anc(t):
        if t not in memo:
            out = {t}
            for p in terms[t]["parents"]:
                if p in terms:
                    out |= anc(p)
            memo[t] = out
        return memo[t]

    return anc


def read_genes(assembly):
    """GREAT genes: first genes_tss.bed record per symbol, chrM excluded."""
    genes, seen = [], set()
    with open(os.path.join(REFDATA, assembly, "genes_tss.bed")) as fh:
        for line in fh:
            chrom, start, _end, name, _score, strand = line.rstrip("\n").split("\t")[:6]
            symbol = name.split("|")[0]
            if chrom == "chrM" or symbol in seen:
                continue
            seen.add(symbol)
            genes.append([symbol, chrom, int(start), strand])
    return genes


def read_gaf(path, symbols):
    """symbol -> set of directly annotated GO ids. Drops NOT qualifiers and ND evidence."""
    index = {s: i for i, s in enumerate(symbols)}
    synonym_hits = {}
    direct = {}
    kept = dropped_not = dropped_nd = unmatched = 0
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        for line in fh:
            if line.startswith("!"):
                continue
            f = line.rstrip("\n").split("\t")
            if len(f) < 15:
                continue
            if "NOT" in f[3].split("|"):
                dropped_not += 1
                continue
            if f[6] == "ND":
                dropped_nd += 1
                continue
            sym = f[2]
            if sym not in index:
                # A synonym that matches exactly one gene.
                cands = {s for s in f[10].split("|") if s in index}
                if len(cands) != 1:
                    unmatched += 1
                    continue
                sym = cands.pop()
                synonym_hits[f[2]] = sym
            direct.setdefault(sym, set()).add(f[4])
            kept += 1
    print(f"  GAF: {kept:,} annotations kept, {dropped_not:,} NOT, {dropped_nd:,} ND, {unmatched:,} unmatched symbols; {len(synonym_hits):,} symbols matched by synonym")
    return direct


def read_gaf_date(path):
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        for line in fh:
            if not line.startswith("!"):
                break
            if line.lower().startswith(("!date-generated:", "!date:")):
                return line.split(":", 1)[1].strip()
    return None


def read_obo_version(path):
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if line.startswith("data-version:"):
                return line.split(":", 1)[1].strip()
            if line.startswith("[Term]"):
                return None


def write_gaps(scratch, assembly, chroms):
    rows = []
    if assembly == "mm9":
        for c in sorted(chroms):
            path = fetch(scratch, f"mm9_{c}_gap.txt.gz", f"{UCSC}/mm9/database/{c}_gap.txt.gz")
            rows += read_gap_table(path)
    else:
        rows = read_gap_table(fetch(scratch, f"{assembly}_gap.txt.gz", f"{UCSC}/{assembly}/database/gap.txt.gz"))
    rows = sorted((r for r in rows if r[0] in chroms), key=lambda r: (r[0], r[1]))
    out_dir = os.path.join(REFDATA, assembly, "go")
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "gaps.bed"), "w") as out:
        for c, s, e in rows:
            out.write(f"{c}\t{s}\t{e}\n")
    print(f"  gaps: {len(rows):,} on {len(chroms)} chromosomes, {sum(e - s for _, s, e in rows):,} bp")


def read_gap_table(path):
    # UCSC gap table: bin, chrom, chromStart, chromEnd, ix, n, size, type, bridge
    with gzip.open(path, "rt") as fh:
        return [(f[1], int(f[2]), int(f[3])) for f in (l.rstrip("\n").split("\t") for l in fh)]


def main():
    scratch = sys.argv[1]
    os.makedirs(scratch, exist_ok=True)
    obo_path = fetch(scratch, "go-basic.obo", OBO_URL)
    terms = parse_obo(obo_path)
    anc = ancestors_fn(terms)
    obo_version = read_obo_version(obo_path)
    print(f"go-basic.obo {obo_version}: {len(terms):,} terms")

    for assembly, species in SPECIES.items():
        print(assembly)
        genes = read_genes(assembly)
        symbols = [g[0] for g in genes]
        gaf_path = fetch(scratch, *GAF[species])
        direct = read_gaf(gaf_path, symbols)
        by_term = {}
        index = {s: i for i, s in enumerate(symbols)}
        for sym, ids in direct.items():
            full = set()
            for t in ids:
                if t in terms:
                    full |= anc(t)
            for t in full:
                by_term.setdefault(t, set()).add(index[sym])
        out_terms = {ns: [] for ns in NAMESPACES.values()}
        for t, gset in sorted(by_term.items()):
            if MIN_GENES <= len(gset) <= MAX_GENES:
                out_terms[NAMESPACES[terms[t]["ns"]]].append([t, terms[t]["name"], sorted(gset)])
        doc = {
            "source": {
                "obo": OBO_URL,
                "obo_version": obo_version,
                "gaf": GAF[species][1],
                "gaf_date": read_gaf_date(gaf_path),
                "min_genes": MIN_GENES,
                "max_genes": MAX_GENES,
            },
            "genes": genes,
            "terms": out_terms,
        }
        out_dir = os.path.join(REFDATA, assembly, "go")
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "go.json"), "w") as out:
            json.dump(doc, out, separators=(",", ":"))
        n_annot = sum(1 for s in symbols if s in direct)
        print(f"  {len(genes):,} genes ({n_annot:,} with GO annotation); terms tested: " + ", ".join(f"{ns} {len(v):,}" for ns, v in out_terms.items()))
        write_gaps(scratch, assembly, {g[1] for g in genes})


if __name__ == "__main__":
    main()
