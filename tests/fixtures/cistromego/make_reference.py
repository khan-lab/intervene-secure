"""
Reference values for frontend/src/lib/cistromeGo.test.ts and xlmhg.test.ts,
computed with the ORIGINAL code:
  - Cistrome-GO rpscore.py / corelib.py / file_check.py at commit 6b7f003
    (minimal Python 3 syntax port in ./cistromego_py3, diff in README of
    the fixture), run on the real ENCODE fixtures with the package's data;
  - xlmhg mhg.py (pure Python reference implementation, commit c29d913,
    BSD-3) for the XL-mHG statistic and p-value (Algorithm 2).
Usage: CGO_DATA=<cistromego/data> python run_ref.py <xlmhg_dir> <fixtures_dir> <out.json>
"""
import importlib.util
import json
import os
import random
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "cistromego_py3"))
import rpscore  # noqa: E402
from corelib import readCoordinate, readJson  # noqa: E402
from file_check import readPeaks  # noqa: E402

xl_dir, fx_dir, out_path = sys.argv[1:4]
spec = importlib.util.spec_from_file_location("mhg", os.path.join(xl_dir, "xlmhg", "mhg.py"))
mhg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mhg)

CONFIGS = [
    ("heart_h3k27ac_ENCFF059ERB.subsample.bed", "1000", "auto"),
    ("liver_h3k27ac_ENCFF805YRQ.subsample.bed", "all", "50k"),
    ("lung_h3k27ac_ENCFF314QTE.subsample.bed", "10000", "0.5k"),
]
random.seed(7)
genes_list = readCoordinate("hg38")
go = readJson("hg_bp_symbol_dedup.json")
out = {"go_genes_bp": sorted(go["genes"]), "configs": []}

for fname, peakn, decay_opt in CONFIGS:
    path = os.path.join(fx_dir, fname)
    # Exactly calcRPscore(), with the intermediate values kept.
    peaks_list, peaks_list_top = readPeaks(path, peakn)
    prop = rpscore.propCalc(genes_list, peaks_list)
    if decay_opt == "auto":
        decay = 1000 if max(prop.values()) >= 0.2 else 10000
    else:
        decay = float(decay_opt[:-1]) * 1000
    D, _ = rpscore.peaksInRange(genes_list, peaks_list_top, decay)
    _, res = rpscore.getRP(D, "hg38", decay)
    scores = res["scores"]

    # Raw (unnormalised) RP per symbol, max over transcripts, as getRP does.
    sym_ref = readJson("hg38_symbol_refseq.json")
    raw = {s: max(sum(2.0 ** (-x / decay) for x in D[r]) for r in refs) for s, refs in sym_ref.items()}
    keep = sorted(s for s in raw if raw[s] > 0)
    if len(keep) > 3000:  # fixture size: the 500 highest plus a sample of the rest
        top = sorted(keep, key=lambda s: -raw[s])[:500]
        keep = sorted(set(top) | set(random.sample(keep, 1500)))
    others = random.sample(sorted(s for s in raw if raw[s] == 0), 200)

    # XL-mHG on the package's own (deduplicated) BP terms, 0-based ranks.
    genes_go = sorted(set(go["genes"]) & set(scores))
    order = sorted(genes_go, key=lambda s: (-scores[s], s))
    pos = {s: i for i, s in enumerate(order)}
    N = len(order)
    maxL = len(set(go["genes"]) & set(res["genes"]))
    L = min(2000, maxL)
    terms = sorted(t for t, g in go["ontology"].items() if 10 < len(g) < 2000)
    tests = []
    for t in terms:
        idx = sorted({pos[s] for s in go["ontology"][t]})
        v = np.zeros(N, dtype=np.uint8)
        v[idx] = 1
        stat, cutoff = mhg.get_xlmhg_stat(v, 1, L)
        pval = mhg.get_xlmhg_pval2(N, len(idx), 1, L, float(stat))
        tests.append({"term": t, "indices": idx, "stat": float(stat), "cutoff": int(cutoff), "pval": float(pval)})
    # Keep every significant-ish term plus a spread of the rest (fixture size).
    tests.sort(key=lambda r: r["pval"])
    chosen = tests[:25] + random.sample(tests[25:], 35)

    out["configs"].append({
        "file": fname,
        "peakn": peakn,
        "decay_option": decay_opt,
        "promoter_fraction": {str(k): v for k, v in sorted(prop.items())},
        "decay": decay,
        "n_peaks_used": len(peaks_list_top),
        "adj_rp": {s: scores[s] for s in keep + sorted(others)},
        "raw_rp": {s: raw[s] for s in keep},
        "n_positive": len(res["genes"]),
        "ranked_top": order[:L],
        "N": N,
        "L": L,
        "mhg": chosen,
    })
    print(fname, "decay", decay, "peaks", len(peaks_list_top), "rp>0", len(keep), "N", N, "L", L, "min p", tests[0]["pval"])

# Constructed index sets on a Cistrome-GO-sized list: tiny p-values (precision) and edge cases.
extra = []
N = 16990
for K, L, idx in [
    (11, 2000, list(range(11))),
    (20, 2000, sorted(random.sample(range(100), 20))),
    (40, 1500, sorted(random.sample(range(300), 25) + random.sample(range(300, N), 15))),
    (500, 2000, sorted(random.sample(range(N), 500))),
    (1999, 2000, sorted(random.sample(range(N), 1999))),
    (12, 50, sorted(random.sample(range(60, N), 12))),
    (3, 2000, [0, 1, N - 1]),
]:
    v = np.zeros(N, dtype=np.uint8)
    v[idx] = 1
    stat, cutoff = mhg.get_xlmhg_stat(v, 1, L)
    pval = mhg.get_xlmhg_pval2(N, len(idx), 1, L, float(stat))
    extra.append({"N": N, "L": L, "indices": idx, "stat": float(stat), "cutoff": int(cutoff), "pval": float(pval)})
    print("extra K", len(idx), "L", L, "stat", stat, "p", pval)
out["extra_mhg"] = extra

with open(out_path, "w") as f:
    json.dump(out, f, separators=(",", ":"))
