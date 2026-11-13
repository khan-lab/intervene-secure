#!/usr/bin/env python3
"""
Build the Cistrome-GO gene model (frontend/src/lib/cistromeGo.ts), per
assembly, under frontend/public/refdata/<assembly>/cistromego/:

  rp_model.json  symbols; each symbol's background regulatory potential
                 for the 1 kb and 10 kb half-decay distances; and every
                 RefSeq transcript TSS (chrom -> [[tss, symbol index], ...],
                 sorted), exactly as the Cistrome-GO package uses them.

The background RP of a gene is the median of its min-max-scaled RP over
the Cistrome DB ChIP-seq datasets (8,470 human, 6,243 mouse; Li et al.
2019, NAR 47:W206). It cannot be recomputed here, so it is taken
verbatim from the Cistrome-GO package (MIT licence, Copyright (c) 2018
Changson One), pinned to one commit. Nothing is re-derived or filtered:
the app's port must reproduce the package's RP scores, and
cistromeGo.test.ts checks that against the package's own code.

One-time preprocessing, not run by the app. Model and rules:
docs/methods.md ("GO enrichment of selected subsets — Cistrome-GO-like");
sources and checksums: docs/provenance.md.

Source (the repository named in the request, pinned):
  https://github.com/changxinw/Cistrome-GO  commit 6b7f0036090fb512a0c47d56914b72ff5c81b101
    cistromego/data/<asm>_nodup.refseq        RefSeq transcripts (col 7 = TSS)
    cistromego/data/<asm>_symbol_refseq.json  symbol -> transcripts
    cistromego/data/<hg|mm>_decay{1k,10k}_bgrp.json  background RP per symbol

Usage: python3 frontend/public/refdata/build_cistromego.py <scratch_dir>   (from the repo root)
"""
import hashlib
import json
import os
import sys
import urllib.request

REFDATA = os.path.join("frontend", "public", "refdata")
REPO = "https://github.com/changxinw/Cistrome-GO"
COMMIT = "6b7f0036090fb512a0c47d56914b72ff5c81b101"
RAW = f"https://raw.githubusercontent.com/changxinw/Cistrome-GO/{COMMIT}/cistromego/data"
SPECIES = {"hg38": "hg", "hg19": "hg", "mm10": "mm", "mm9": "mm"}


def fetch(scratch, name):
    path = os.path.join(scratch, name)
    if not os.path.exists(path):
        url = f"{RAW}/{name}"
        print(f"Downloading {url}")
        req = urllib.request.Request(url, headers={"User-Agent": "intervene-build-cistromego/1.0 (+https://github.com/khan-lab/intervene-secure)"})
        with urllib.request.urlopen(req) as res, open(path, "wb") as out:
            out.write(res.read())
    return path


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    scratch = sys.argv[1]
    os.makedirs(scratch, exist_ok=True)
    for assembly, sp in SPECIES.items():
        names = [f"{assembly}_nodup.refseq", f"{assembly}_symbol_refseq.json", f"{sp}_decay1k_bgrp.json", f"{sp}_decay10k_bgrp.json"]
        paths = {n: fetch(scratch, n) for n in names}
        refseq, sym_ref, bg1k, bg10k = (paths[n] for n in names)

        transcripts = {}
        with open(refseq) as f:
            for line in f:
                # id, chrom, strand, txStart, txEnd, symbol, TSS
                fields = line.rstrip("\n").split("\t")
                transcripts[fields[0]] = (fields[1], int(fields[6]))
        symbol_refs = json.load(open(sym_ref))
        b1 = json.load(open(bg1k))
        b10 = json.load(open(bg10k))

        symbols = sorted(symbol_refs)
        index = {s: i for i, s in enumerate(symbols)}
        tss = {}
        for s in symbols:
            for ref in symbol_refs[s]:
                chrom, pos = transcripts[ref]  # KeyError = package data inconsistent: stop
                tss.setdefault(chrom, []).append([pos, index[s]])
        for chrom in tss:
            tss[chrom].sort()
        n_tss = sum(len(v) for v in tss.values())
        assert n_tss == len(transcripts), "every transcript belongs to exactly one symbol"

        doc = {
            "source": {
                "repository": REPO,
                "commit": COMMIT,
                "licence": "MIT, Copyright (c) 2018 Changson One",
                "files": {n: sha256(paths[n]) for n in names},
            },
            "symbols": symbols,
            "bg1k": [b1[s] for s in symbols],
            "bg10k": [b10[s] for s in symbols],
            "tss": dict(sorted(tss.items())),
        }
        out_dir = os.path.join(REFDATA, assembly, "cistromego")
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "rp_model.json"), "w") as out:
            json.dump(doc, out, separators=(",", ":"))
        print(f"{assembly}: {len(symbols):,} symbols, {n_tss:,} transcript TSSs on {len(tss)} chromosomes")


if __name__ == "__main__":
    main()
