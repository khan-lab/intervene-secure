# Fixture provenance

Real, subsampled ENCODE peak data per CLAUDE.md ("real data in fixtures, not
synthetic"). ENCODE's Data Use Policy permits free download, analysis, and
publication without restriction (citation requested, not required) —
https://www.encodeproject.org/help/citing-encode/. No entry needed in
docs/licences.md.

All three are H3K27ac ChIP-seq pseudoreplicated narrowPeak calls, GRCh38,
Roadmap Epigenomics project, downloaded 2026-07-28.

| Fixture | Experiment | File | Biosample | Original peaks | Subsample |
|---|---|---|---|---|---|
| `heart_h3k27ac_ENCFF059ERB.subsample.bed` | [ENCSR150QXE](https://www.encodeproject.org/experiments/ENCSR150QXE/) | [ENCFF059ERB](https://www.encodeproject.org/files/ENCFF059ERB/) | heart left ventricle tissue, male adult (34y) | 76,164 | every 38th, sorted, 2000 lines |
| `lung_h3k27ac_ENCFF314QTE.subsample.bed` | [ENCSR540ADS](https://www.encodeproject.org/experiments/ENCSR540ADS/) | [ENCFF314QTE](https://www.encodeproject.org/files/ENCFF314QTE/) | lung tissue, female adult (30y) | 104,589 | every 52nd, sorted, 2000 lines |
| `liver_h3k27ac_ENCFF805YRQ.subsample.bed` | [ENCSR230IMS](https://www.encodeproject.org/experiments/ENCSR230IMS/) | [ENCFF805YRQ](https://www.encodeproject.org/files/ENCFF805YRQ/) | liver tissue, male adult (31y) | 67,419 | every 33rd, sorted, 2000 lines |

Subsampling: `bedtools`-sorted, then every Nth line taken deterministically
(`awk 'NR%N==1'`) so re-running the download + subsample steps is
reproducible. Not a random sample — a systematic thin-out preserving
original ordering/spread across the genome.

Full (non-subsampled) files were used for the Phase 1 browser benchmark; see
`docs/benchmarks.md` for why they were not committed as fixtures (size) and
why the 1M/5M-region tiers could not be reached with real peak data.

Citation (per ENCODE's request): ENCODE Consortium, portal
https://www.encodeproject.org/. Accessions above.
