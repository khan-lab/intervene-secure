<p align="left">
  <img src="frontend/public/logo.png" alt="Intervene logo" width="220">
</p>

> ### A secure platform for in-browser genomic intersections, annotation and enrichment without data upload

[![Deploy](https://github.com/khan-lab/intervene-secure/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/khan-lab/intervene-secure/actions/workflows/deploy.yml)
[![Web app](https://img.shields.io/website?url=https%3A%2F%2Fkhan-lab.github.io%2Fintervene-secure%2F&label=web%20app&up_message=online&down_message=offline)](https://khan-lab.github.io/intervene-secure/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![bedtools 2.31 (WebAssembly)](https://img.shields.io/badge/bedtools-2.31%20%C2%B7%20WebAssembly-654ff0.svg)](https://bedtools.readthedocs.io/)
[![No data upload](https://img.shields.io/badge/data-never%20uploaded-success.svg)](#built-for-patient-and-sensitive-data)
[![Cite: BMC Bioinformatics 2017](https://img.shields.io/badge/cite-10.1186%2Fs12859--017--1708--7-informational.svg)](https://doi.org/10.1186/s12859-017-1708-7)

**Available: <https://khan-lab.github.io/intervene-secure/>**

Intervene Secure intersects 2–8 BED, narrowPeak or VCF files with
[bedtools 2.31](https://bedtools.readthedocs.io/) compiled to WebAssembly,
then annotates the input sets and their intersection subsets and tests them
for enrichment. Everything runs in your browser tab: no file is uploaded,
so it can be used for patient variants, clinical sequencing calls and other
restricted data.

## Built for patient and sensitive data

- **Files are never uploaded.** The site is static files; there is no
  application server to receive them.
- **No login, no account, no server-side storage.**
- **Works offline** once the app (4.4 MB) and an assembly's reference data
  (27–76 MB) are cached.


## Features

**Intersection**
- UpSet plot, Venn diagram (2–4 sets), pairwise heatmap (Jaccard, Fisher,
  reldist) and a subset table.
- Overlap of 1 bp, 50 %, reciprocal 50 %, or any bedtools options.
- Optional removal of ENCODE problematic regions.

**Annotation** (each input set, and any subset you select)
- Per-chromosome counts and lengths (`bedtools summary`).
- Genomic features (promoter, UTR, exon, intron, intergenic) and distance
  to the nearest TSS, from GENCODE.
- Closest genes, ready to copy or download.

**Enrichment** (selected subsets)
- Bundled reference sets (ENCODE cCREs, FANTOM5 and VISTA enhancers, CpG
  islands, ClinVar, GWAS Catalog): Fisher or length-stratified CMH test.
- Gene Ontology with two methods, each reimplemented to run in the browser
  with editable settings:
  - **GREAT-like:** regulatory domains; genome or input-set background;
  - **Cistrome-GO-like:** regulatory-potential ranking and XL-mHG test.

**Downloads:** subsets as BED or ZIP, gene lists, every plot as SVG/PNG,
and enrichment results as TSV.

Assemblies: hg38, hg19, mm10, mm9. Limits: 8 sets, 100 MB and 2,000,000
regions per file. Statistics and their null models are in
[`docs/methods.md`](docs/methods.md); reference data sources, versions and
checksums in [`docs/provenance.md`](docs/provenance.md).

## How intersections are computed

For each combination of sets, Intervene keeps the regions of the first set
that overlap every other member (`bedtools intersect -u`) and no non-member
(`bedtools intersect -v`), the same definition as the CLI. In the browser,
each ordered pair of sets is compared once with `bedtools intersect -c`
(56 runs instead of 1,785 for eight sets), with identical results.

## Running it locally

Requires [Node.js](https://nodejs.org/) 20.19+ or 22.12+.

```sh
git clone https://github.com/khan-lab/intervene-secure.git
cd intervene-secure/frontend
npm ci
npm run dev        # http://localhost:5173/intervene-secure/
```

`npm test` runs the test suite (differential tests need a native `bedtools`
2.31 on your `PATH`), `npm run lint` lints, and `npm run build` writes the
static site to `dist/`, deployable on any static host. Pushes to `main`
deploy to GitHub Pages.

## Citation

If you use Intervene for your work, please cite:

> Khan A, Mathelier A. Intervene: a tool for intersection and visualization of
> multiple gene or genomic region sets. *BMC Bioinformatics*. 2017;18:287.
> [doi:10.1186/s12859-017-1708-7](https://doi.org/10.1186/s12859-017-1708-7)

Intersections are computed with BEDTools:

> Quinlan AR, Hall IM. BEDTools: a flexible suite of utilities for comparing
> genomic features. *Bioinformatics*. 2010;26(6):841–842.
> [doi:10.1093/bioinformatics/btq033](https://doi.org/10.1093/bioinformatics/btq033)

For GO enrichment, please also cite the method you ran:

> McLean CY, Bristor D, Hiller M, et al. GREAT improves functional
> interpretation of cis-regulatory regions. *Nat Biotechnol*.
> 2010;28:495–501.
> [doi:10.1038/nbt.1630](https://doi.org/10.1038/nbt.1630)

> Li S, Wan C, Zheng R, Fan J, Dong X, Meyer CA, Liu XS. Cistrome-GO: a web
> server for functional enrichment analysis of transcription factor ChIP-seq
> peaks. *Nucleic Acids Res*. 2019;47(W1):W206–W211.
> [doi:10.1093/nar/gkz332](https://doi.org/10.1093/nar/gkz332)


> Intervene Secure is developed and maintained by the [CBCRG Lab](https://khanlab.bio).
