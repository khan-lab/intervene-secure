# Cistrome-GO reference values

`reference_hg38_bp.json` holds values computed by the **original code** on
the real ENCODE fixtures in `../encode/`, for
`frontend/src/lib/cistromeGo.test.ts` and `frontend/src/lib/xlmhg.test.ts`.
Made 2026-11-13 by `make_reference.py` (in this directory, exactly as run):

```
CGO_DATA=<Cistrome-GO clone>/cistromego/data \
  python -I make_reference.py <xlmhg clone> tests/fixtures/encode out.json
```

then NaN replaced by `null` (strict JSON). Python 3.14, numpy 2.5.4.

- **Cistrome-GO**: github.com/changxinw/Cistrome-GO, commit
  `6b7f0036090fb512a0c47d56914b72ff5c81b101` (MIT). The package is Python 2.7;
  `rpscore.py`, `corelib.py` and `file_check.py` were given the minimal
  Python 3 syntax changes in `cistromego_py3.diff` (print, `iteritems`,
  `list(dict.keys())` where the loop pops from the dict, `//`, file mode
  `"rU"`, data path) — no change to any computation.
- **xlmhg**: github.com/flo-compbio/xlmhg, commit
  `c29d913386443396254774b8cff5cff2b5731323` (BSD 3-clause), the pure-Python
  reference implementation `xlmhg/mhg.py` (`get_xlmhg_stat`,
  `get_xlmhg_pval2`), float64. Where its running probability leaves the
  normal double range it loses precision or returns NaN; the tests use exact
  BigInt path counting for those cases instead (see xlmhg.test.ts).

Contents: for each of three runs (heart: top 1,000 peaks, auto decay;
liver: all peaks, 50 kb; lung: top 10,000, 0.5 kb) the promoter fractions,
chosen decay, peaks used, raw RP of every gene with RP > 0 (liver: the 500
highest plus a sample of 1,500), adjusted RP of those genes plus 200 genes
with RP 0, the number of positive genes, the top-L ranking over the
package's BP gene list (`go_genes_bp`), and XL-mHG results for 60 of the
package's BP terms (the 25 smallest p-values plus 35 at random, seed 7).
Plus seven constructed index sets on a 16,990-gene list (`extra_mhg`).

The package's own GO files (2018) are used only here, as data for the
reference run; the app uses the current GO release.
