import { memo, useRef, useState } from "react";
import { useStore, type LoadedSet } from "../state/store";
import { downloadPng, downloadSvg } from "../lib/exportImage";
import { estimateTextWidth, truncateToWidth } from "../lib/textMeasure";
import { parseChromSizes } from "../lib/inputValidation";
import {
  GO_NAMESPACES,
  GREAT_DEFAULTS,
  assignRegions,
  greatTest,
  inputsGoTest,
  prepareGreat,
  type GoData,
  type GoNamespace,
  type GreatSettings,
  type PreparedGreat,
} from "../lib/great";
import {
  CISTROMEGO_DEFAULTS,
  DECAY_CHOICES,
  cistromeGoTestAsync,
  prepareCistromeGo,
  type CgoPeak,
  type CistromeGoSettings,
  type PreparedCistromeGo,
  type RpModel,
} from "../lib/cistromeGo";
import type { Subset } from "../types";
import { PALETTE } from "../types";
import { ComputeOverlay, type ComputeProgress } from "./ComputeStatus";
import { Icon } from "./Icon";

type Method = "great" | "cistromego";
type GoBackground = "inputs" | "genome";
/** GREAT's settings plus the background it is tested against (a setting, default genome as in GREAT). */
type GreatUi = GreatSettings & { background: GoBackground };
const GREAT_UI_DEFAULTS: GreatUi = { ...GREAT_DEFAULTS, background: "genome" };

interface Row {
  id: string;
  name: string;
  /** q of the test that ranks terms (binomial for genome, Fisher for input sets, XL-mHG for Cistrome-GO). */
  q: number;
  fold: number;
  detail: string;
  genes?: string[];
  significant: boolean;
  tsv: (string | number)[];
}

interface SubsetResult {
  mask: number;
  label: string;
  color: string;
  rows: Row[];
  summary: string;
}

interface Result {
  key: string;
  method: Method;
  background: GoBackground;
  ns: GoNamespace;
  qThreshold: number;
  tsvHead: string[];
  subsets: SubsetResult[];
}

const INK = "#101826";
const INK_3 = "#8b97a9";
const PAPER = "#ffffff";
const TABLE_ROWS = 100;

const base = (assembly: string) => `${window.location.origin}${import.meta.env.BASE_URL}refdata/${assembly}`;

// Downloads and prepared data survive remounts (GO 2 MB, Cistrome-GO gene model 0.6 MB, gzipped).
const goCache = new Map<string, Promise<{ go: GoData; sizes: Record<string, number>; gaps: string }>>();
const greatCache = new Map<string, Promise<PreparedGreat>>();
const cgoCache = new Map<string, Promise<PreparedCistromeGo>>();

function cached<T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
  let p = cache.get(key);
  if (!p) {
    p = make();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}

function loadGo(assembly: string) {
  return cached(goCache, assembly, async () => {
    const [goRes, gapsRes, sizesRes] = await Promise.all([fetch(`${base(assembly)}/go/go.json`), fetch(`${base(assembly)}/go/gaps.bed`), fetch(`${base(assembly)}/${assembly}.chrom.sizes`)]);
    if (!goRes.ok || !gapsRes.ok || !sizesRes.ok) throw new Error(`Could not load GO data for ${assembly}`);
    return { go: (await goRes.json()) as GoData, sizes: parseChromSizes(await sizesRes.text()), gaps: await gapsRes.text() };
  });
}

function loadGreat(assembly: string, s: GreatSettings) {
  return cached(greatCache, [assembly, s.upstream, s.downstream, s.maxExtension].join("|"), async () => {
    const { go, sizes, gaps } = await loadGo(assembly);
    return prepareGreat(go, sizes, gaps, s);
  });
}

function loadCistromeGo(assembly: string) {
  return cached(cgoCache, assembly, async () => {
    const [{ go }, res] = await Promise.all([loadGo(assembly), fetch(`${base(assembly)}/cistromego/rp_model.json`)]);
    if (!res.ok) throw new Error(`Could not load the Cistrome-GO gene model for ${assembly}`);
    return prepareCistromeGo((await res.json()) as RpModel, go);
  });
}

/**
 * The subset's regions as Cistrome-GO peaks. Regions come from the
 * combination's first set; column 5 of that set's file is the peak score
 * when every line has a numeric one (narrowPeak), as Cistrome-GO requires.
 */
async function subsetPeaks(subset: Subset, sets: LoadedSet[]): Promise<CgoPeak[]> {
  const set = sets.find((x) => x.id === subset.memberIds[0]);
  if (!set) return subset.regions;
  const scores = new Map<string, number[]>();
  for (const line of (await set.file.text()).split("\n")) {
    if (!line) continue;
    const f = line.split("\t");
    const score = f.length >= 5 && f[4] !== "" ? Number(f[4]) : NaN;
    if (!Number.isFinite(score)) return subset.regions;
    const key = `${f[0]}\t${f[1]}\t${f[2]}`;
    const list = scores.get(key);
    if (list) list.push(score);
    else scores.set(key, [score]);
  }
  return subset.regions.map((r) => ({ ...r, score: scores.get(`${r.chrom}\t${r.start}\t${r.end}`)?.shift() }));
}

/** The term's page in AmiGO, the Gene Ontology Consortium's browser. Opened in a new tab without a referrer: only the GO id leaves the page. */
const amigoUrl = (id: string) => `https://amigo.geneontology.org/amigo/term/${id}`; // ids are GO:nnnnnnn (great.test.ts checks the data)
const fmtP = (p: number) => (p === 0 ? "<1e-300" : p < 0.001 ? p.toExponential(1) : p.toPrecision(2));
const fmtFold = (f: number) => (!Number.isFinite(f) ? (f > 0 ? "∞" : "n/a") : f >= 10 ? f.toFixed(0) : f.toFixed(2));
const fmtKb = (bp: number) => (bp >= 1000 ? `${(bp / 1000).toLocaleString()} kb` : `${bp} bp`);
const negLog10 = (q: number) => Math.min(300, q > 0 ? -Math.log10(q) : 300);
const nextFrame = () => new Promise((r) => setTimeout(r, 0));
const nsLabel = (ns: GoNamespace) => GO_NAMESPACES.find((n) => n.id === ns)!.label;

// Choices and results survive remounts within the session.
const saved = {
  method: "great" as Method,
  ns: "BP" as GoNamespace,
  great: { ...GREAT_UI_DEFAULTS },
  cgo: { ...CISTROMEGO_DEFAULTS },
  results: new Map<Method, Result>(),
};

export function GoEnrichmentPanel() {
  const allSubsets = useStore((s) => s.subsets);
  const selected = useStore((s) => s.selected);
  const assembly = useStore((s) => s.assembly);
  const sets = useStore((s) => s.sets);
  const mainStatus = useStore((s) => s.status);
  const [method, setMethodState] = useState<Method>(saved.method);
  const [ns, setNsState] = useState<GoNamespace>(saved.ns);
  const [great, setGreatState] = useState<GreatUi>(saved.great);
  const [cgo, setCgoState] = useState<CistromeGoSettings>(saved.cgo);
  const [result, setResult] = useState<Result | null>(saved.results.get(saved.method) ?? null);
  const [activeMask, setActiveMask] = useState<number | null>(null);
  const [progress, setProgress] = useState<ComputeProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setMethod = (m: Method) => {
    saved.method = m;
    setMethodState(m);
    setResult(saved.results.get(m) ?? null);
  };
  const setNs = (n: GoNamespace) => setNsState((saved.ns = n));
  const setGreat = (s: GreatUi) => setGreatState((saved.great = s));
  const background = great.background;
  const setCgo = (s: CistromeGoSettings) => setCgoState((saved.cgo = s));

  const chosen = [...selected].map((m) => allSubsets.find((s) => s.mask === m)).filter((s) => s !== undefined);
  const universeSig = allSubsets.map((s) => `${s.mask}:${s.nRegions}:${s.nBp}`).join(",");
  const settings = method === "great" ? great : cgo;
  const key = [method, ns, assembly, chosen.map((s) => s.mask).join("|"), universeSig, JSON.stringify(settings), sets.map((s) => s.contentKey).join(",")].join("#");
  const stale = result !== null && result.key !== key;
  const busy = progress !== null;
  const active = result?.subsets.find((s) => s.mask === activeMask) ?? result?.subsets[0] ?? null;

  const run = async () => {
    if (!chosen.length) return;
    setError(null);
    const total = chosen.length + 1;
    const label = method === "great" ? `Loading GO annotation for ${assembly}` : `Loading GO annotation and the Cistrome-GO gene model for ${assembly}`;
    setProgress({ done: 0, total, label, unit: "steps" });
    try {
      const out: SubsetResult[] = [];
      let tsvHead: string[];
      const q = settings.qThreshold;
      if (method === "great") {
        const prepared = await loadGreat(assembly, great);
        const nTerms = prepared.data.terms[ns].filter((t) => t[2].length >= great.minGenes && t[2].length <= great.maxGenes).length;
        let universeGenes: (number[] | null)[] | null = null;
        let owner: Int32Array | null = null;
        if (background === "inputs") {
          owner = Int32Array.from(allSubsets.flatMap((s) => s.regions.map(() => s.mask)));
          universeGenes = assignRegions(
            allSubsets.flatMap((s) => s.regions),
            prepared
          );
        }
        tsvHead =
          background === "genome"
            ? ["subset", "go_id", "term", "regions_hit", "regions", "genome_fraction", "binom_fold", "binom_p", "binom_q", "genes_hit", "genes_selected", "term_genes", "genes", "hyper_fold", "hyper_p", "hyper_q", "significant"]
            : ["subset", "go_id", "term", "term_genes", "subset_hit", "subset_no_hit", "rest_hit", "rest_no_hit", "odds_ratio", "p", "q", "significant"];
        for (const [i, s] of chosen.entries()) {
          setProgress({ done: i + 1, total, unit: "steps", label: `${s.label}: testing ${nTerms.toLocaleString()} GO terms` });
          await nextFrame();
          let rows: Row[];
          let n = 0;
          if (background === "genome") {
            rows = greatTest(prepared, assignRegions(s.regions, prepared), ns, great).map((r) => {
              n = r.n;
              return {
                id: r.id,
                name: r.name,
                q: r.binomQ,
                fold: r.binomFold,
                significant: r.significant,
                detail: `${r.k.toLocaleString()} of ${r.n.toLocaleString()} regions (expected ${(r.n * r.fraction).toFixed(1)}) · binomial q ${fmtP(r.binomQ)} · ${r.j} of ${r.m.toLocaleString()} genes, hypergeometric q ${fmtP(r.hyperQ)}`,
                tsv: [r.id, r.name, r.k, r.n, r.fraction, r.binomFold, r.binomP, r.binomQ, r.j, r.m, r.K, r.N, r.hyperFold, r.hyperP, r.hyperQ, r.significant ? "yes" : "no"],
              };
            });
          } else {
            rows = inputsGoTest(prepared, universeGenes!, owner!, s.mask, ns, great).map((r) => {
              const [a, b, c, d] = r.table;
              const significant = r.q < q && r.oddsRatio > 1;
              return {
                id: r.id,
                name: r.name,
                q: r.q,
                fold: r.oddsRatio,
                significant,
                detail: `${a.toLocaleString()} of ${(a + b).toLocaleString()} subset regions vs ${c.toLocaleString()} of ${(c + d).toLocaleString()} other regions · odds ratio ${fmtFold(r.oddsRatio)} · q ${fmtP(r.q)}`,
                tsv: [r.id, r.name, r.K, a, b, c, d, r.oddsRatio, r.p, r.q, significant ? "yes" : "no"],
              };
            });
          }
          // Enriched terms first, by q; depletion is reported in the TSV but not ranked here.
          rows.sort((x, y) => Number(y.fold > 1) - Number(x.fold > 1) || x.q - y.q);
          const nSig = rows.filter((r) => r.significant).length;
          const rule = `${fmtKb(great.upstream)} up, ${fmtKb(great.downstream)} down, up to ${fmtKb(great.maxExtension)}`;
          const summary =
            background === "genome"
              ? `${nSig} significant term${nSig === 1 ? "" : "s"} (binomial and hypergeometric q < ${q}, fold ≥ ${great.minFold}) · ${n.toLocaleString()} regions · domains ${rule}`
              : `${nSig} significant term${nSig === 1 ? "" : "s"} (q < ${q}, enriched) · ${s.nRegions.toLocaleString()} subset regions vs ${(owner!.length - s.nRegions).toLocaleString()} others · domains ${rule}`;
          out.push({ mask: s.mask, label: s.label, color: PALETTE[i % PALETTE.length], rows, summary });
        }
      } else {
        const prepared = await loadCistromeGo(assembly);
        setProgress({ done: 0, total: chosen.length, unit: "subsets done", label: `Preparing ${nsLabel(ns).toLowerCase()} terms${cgo.dedup ? " (removing redundant terms)" : ""}` });
        await nextFrame();
        prepared.terms(ns, cgo); // warm the redundancy filter (cached per namespace) while the label above shows
        tsvHead = ["subset", "go_id", "term", "term_genes", "ranked_genes", "L", "cutoff", "term_genes_above_cutoff", "fold", "mhg_stat", "p", "q", "significant", "leading_genes"];
        for (const [i, s] of chosen.entries()) {
          setProgress({ done: i, total: chosen.length, unit: "subsets done", label: `${s.label}: regulatory potential and gene ranking` });
          await nextFrame();
          const res = await cistromeGoTestAsync(prepared, await subsetPeaks(s, sets), ns, cgo, (d, n) =>
            setProgress({ done: i + d / n, total: chosen.length, unit: "subsets done", label: `${s.label}: XL-mHG test, ${d.toLocaleString()} of ${n.toLocaleString()} GO terms` })
          );
          const rows: Row[] = res.rows
            .map((r) => ({
              id: r.id,
              name: r.name,
              q: r.q,
              fold: r.fold,
              significant: r.q < q,
              genes: r.leadGenes,
              detail: `${r.k} of ${r.K} term genes in the top ${r.cutoff.toLocaleString()} of ${r.N.toLocaleString()} genes · XL-mHG p ${fmtP(r.p)} · q ${fmtP(r.q)}`,
              tsv: [r.id, r.name, r.K, r.N, r.L, r.cutoff, r.k, r.fold, r.stat, r.p, r.q, r.q < q ? "yes" : "no", r.leadGenes.join(",")],
            }))
            .sort((x, y) => x.q - y.q || y.fold - x.fold);
          const nSig = rows.filter((r) => r.significant).length;
          const auto = cgo.decay === "auto" ? ` (auto: ${Math.round(100 * Math.max(...Object.values(res.fractions)))}% of peaks within 1 kb of a TSS)` : "";
          const peaks = res.scored ? `top ${res.nPeaksUsed.toLocaleString()} peaks by score` : `all ${res.nPeaksUsed.toLocaleString()} regions (no score column)`;
          const summary = `${nSig} term${nSig === 1 ? "" : "s"} with q < ${q} · half-decay ${fmtKb(res.decay)}${auto} · ${peaks} · ${res.ranking.nPositive.toLocaleString()} genes with adjusted RP > 0 · L = ${res.ranking.L.toLocaleString()}`;
          out.push({ mask: s.mask, label: s.label, color: PALETTE[i % PALETTE.length], rows, summary });
        }
      }
      const r: Result = { key, method, background, ns, qThreshold: q, tsvHead, subsets: out };
      saved.results.set(method, r);
      setResult(r);
      if (!out.some((s) => s.mask === activeMask)) setActiveMask(out[0]?.mask ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(null);
    }
  };


  return (
    <div className={`annowrap${busy ? " busy" : ""}`} aria-busy={busy} style={{ minHeight: 120 }}>
      {busy && <ComputeOverlay label={progress.label} progress={progress} />}
      <div className="rowsplit" style={{ marginBottom: 10, gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <div className="tabs" role="tablist" aria-label="GO enrichment method">
            <button className="tab" role="tab" aria-selected={method === "great"} onClick={() => setMethod("great")}>
              GREAT-like
            </button>
            <button className="tab" role="tab" aria-selected={method === "cistromego"} onClick={() => setMethod("cistromego")}>
              Cistrome-GO-like
            </button>
          </div>
          <div className="tabs" role="tablist" aria-label="GO namespace">
            {GO_NAMESPACES.map((n) => (
              <button key={n.id} className="tab" role="tab" aria-selected={ns === n.id} onClick={() => setNs(n.id)}>
                {n.label}
              </button>
            ))}
          </div>
        </div>
        <button className="ghost" disabled={busy || mainStatus === "running" || !chosen.length} onClick={() => void run()}>
          {result ? "Run again" : "Run GO enrichment"}
        </button>
      </div>
      <div className="hint" style={{ margin: "0 0 10px" }}>
        {method === "great" ? (
          <>
            GREAT-like: follows GREAT's approach, reimplemented here. Regions are linked to genes with its basal-plus-extension rule ({fmtKb(great.upstream)} up, {fmtKb(great.downstream)} down, extended up to {fmtKb(great.maxExtension)}).{" "}
            {background === "inputs"
              ? "Each subset is compared with all other regions of this analysis (Fisher's exact test)."
              : "Each subset is compared with the whole genome: GREAT's binomial test over regions and hypergeometric test over genes."}
          </>
        ) : (
          <>
            Cistrome-GO-like: follows the Cistrome-GO approach, reimplemented here (differences are listed in Help). Every gene gets a regulatory potential from the subset's regions near its TSS (exponential decay with distance), adjusted for its typical
            score across Cistrome DB ChIP-seq data; genes are ranked by it and each GO term is tested with the XL-mHG test. Peak scores come from column 5 of the
            first set's file.
          </>
        )}{" "}
        Reference data is downloaded once (GO about 2 MB{method === "cistromego" ? ", gene model 0.6 MB" : ""}). Nothing is uploaded.
      </div>
      {method === "great" ? <GreatSettingsForm value={great} onChange={setGreat} /> : <CistromeGoSettingsForm value={cgo} onChange={setCgo} />}
      {error && <div className="hint error">{error}</div>}
      {stale && !busy && (
        <div className="setinfo" style={{ marginBottom: 8 }}>
          Settings or selection changed since this result. Press Run again to update it.
        </div>
      )}
      {result && active && <ResultView result={result} active={active} stale={stale} onSelect={setActiveMask} />}
    </div>
  );
}

const fileStem = (r: Result) => `intervene-go-${r.ns}-${r.method === "great" ? `greatlike-${r.background}` : "cistromegolike"}`;
const exportTsv = (r: Result, only?: SubsetResult) => {
  const lines = (only ? [only] : r.subsets).flatMap((s) => s.rows.map((row) => [s.label, ...row.tsv].join("\t")));
  const blob = new Blob([[r.tsvHead.join("\t"), ...lines].join("\n") + "\n"], { type: "text/tab-separated-values" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${fileStem(r)}${only ? `-${only.label.replace(/[^\w.-]+/g, "_")}` : ""}.tsv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

const methodLabel = (r: Result) => (r.method === "cistromego" ? "Cistrome-GO-like (XL-mHG)" : r.background === "genome" ? "GREAT-like, vs. genome" : "GREAT-like, vs. input sets");

/** The finished result: one tab per subset, each with its own chart, table and downloads. Memoised so progress updates during a run don't re-render it. */
const ResultView = memo(function ResultView({ result, active, stale, onSelect }: { result: Result; active: SubsetResult; stale: boolean; onSelect: (mask: number) => void }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  return (
    <div className={stale ? "stale" : undefined}>
      <div className="tabs wrap" role="tablist" aria-label="Subset" style={{ marginBottom: 8 }}>
        {result.subsets.map((s) => {
          const nSig = s.rows.filter((r) => r.significant).length;
          return (
            <button key={s.mask} className="tab" role="tab" aria-selected={s.mask === active.mask} onClick={() => onSelect(s.mask)} title={`${nSig} significant term${nSig === 1 ? "" : "s"}`}>
              <span className="swatch" style={{ background: s.color, marginRight: 6 }} />
              {s.label}
              <span className="tabcount">{nSig}</span>
            </button>
          );
        })}
      </div>
      <div className="setinfo" style={{ margin: "0 0 8px" }}>
        {active.summary}
      </div>
      <GoBarChart
        subset={active}
        title={`${active.label} — ${nsLabel(result.ns)}, ${methodLabel(result)}`}
        metric={result.method === "cistromego" ? "XL-mHG" : result.background === "genome" ? "binomial" : "Fisher"}
        foldLabel={result.method === "great" && result.background === "inputs" ? "odds ratio" : "fold"}
        qThreshold={result.qThreshold}
        svgRef={svgRef}
      />
      <div className="plotactions">
        <button className="iconbtn" title={`Download all terms for ${active.label} as TSV`} aria-label={`Download GO results for ${active.label} as TSV`} onClick={() => exportTsv(result, active)}>
          <Icon name="download" />
        </button>
        <button className="iconbtn" title="Download all terms for every subset as one TSV" onClick={() => exportTsv(result)}>
          TSV (all)
        </button>
        <button className="iconbtn" title="Export SVG" onClick={() => svgRef.current && downloadSvg(svgRef.current, `${fileStem(result)}.svg`)}>
          SVG
        </button>
        <button className="iconbtn" title="Export PNG" onClick={() => svgRef.current && void downloadPng(svgRef.current, `${fileStem(result)}.png`)}>
          PNG
        </button>
      </div>
      <div className="regions-scroll" style={{ maxHeight: 320, marginTop: 8 }}>
        <table className="subtable" aria-label={`GO terms for ${active.label}`}>
          <thead>
            <tr>
              <th>Term</th>
              <th>{result.method === "great" && result.background === "inputs" ? "Odds ratio" : "Fold"}</th>
              <th>q</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {active.rows.slice(0, TABLE_ROWS).map((r) => (
              <tr key={r.id}>
                <td>
                  {r.name}{" "}
                  <a className="golink" href={amigoUrl(r.id)} target="_blank" rel="noopener noreferrer" title={`Open ${r.id} in AmiGO (new tab)`}>
                    {r.id}
                  </a>
                </td>
                <td className="mono">{fmtFold(r.fold)}</td>
                <td className="mono" style={{ whiteSpace: "nowrap" }}>
                  {fmtP(r.q)}
                  {r.significant ? " *" : ""}
                </td>
                <td className="setinfo">
                  {r.detail}
                  {r.genes && r.genes.length > 0 && (
                    <>
                      <br />
                      <span className="mono" title={r.genes.join(", ")}>
                        {r.genes.slice(0, 12).join(", ")}
                        {r.genes.length > 12 ? ` … +${r.genes.length - 12}` : ""}
                      </span>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="setinfo">
        {active.rows.length > TABLE_ROWS ? `First ${TABLE_ROWS} of ${active.rows.length.toLocaleString()} terms; the TSV has all of them.` : `${active.rows.length.toLocaleString()} terms.`} * q &lt;{" "}
        {result.qThreshold}
        {result.method === "great" && result.background === "genome" ? " for both tests and fold above the minimum" : ""}.
      </div>
    </div>
  );
});

/* ---------- settings ---------- */

function NumField(props: { label: string; value: number; def: number; scale?: number; unit?: string; min: number; max: number; step?: number; help?: string; onChange: (v: number) => void }) {
  const { label, value, def, scale = 1, unit, min, max, step = 1, help, onChange } = props;
  const shown = String(+(value / scale).toPrecision(6));
  const [text, setText] = useState(shown);
  const [prevShown, setPrevShown] = useState(shown);
  if (shown !== prevShown) {
    // value changed from outside (e.g. reset): show it
    setPrevShown(shown);
    setText(shown);
  }
  const commit = () => {
    const v = Number(text) * scale;
    if (text.trim() !== "" && Number.isFinite(v) && v >= min && v <= max) onChange(v);
    else setText(shown);
  };
  const changed = value !== def;
  return (
    <label className="param" title={help}>
      <span className="k">
        {label}
        {changed && <span className="changed"> · default {String(+(def / scale).toPrecision(6))}</span>}
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <input
          className="param-text"
          type="number"
          inputMode="decimal"
          min={min / scale}
          max={max / scale}
          step={step}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          style={{ width: 84 }}
          aria-label={label}
        />
        <span className="setinfo" style={{ margin: 0, minWidth: 34 }}>
          {unit ?? ""}
        </span>
      </span>
    </label>
  );
}

function SettingsShell({ nChanged, onReset, children }: { nChanged: number; onReset: () => void; children: React.ReactNode }) {
  return (
    <details className="gosettings">
      <summary>
        Settings <span className="setinfo">{nChanged ? `· ${nChanged} changed from the defaults` : "· defaults"}</span>
      </summary>
      <div className="gosettings-grid">{children}</div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
        <button className="ghost" disabled={!nChanged} onClick={onReset}>
          Reset to defaults
        </button>
      </div>
    </details>
  );
}

const countChanged = <T extends object>(v: T, d: T) => (Object.keys(d) as (keyof T)[]).filter((k) => v[k] !== d[k]).length;

function GreatSettingsForm({ value, onChange }: { value: GreatUi; onChange: (s: GreatUi) => void }) {
  const d = GREAT_UI_DEFAULTS;
  const set = (patch: Partial<GreatUi>) => onChange({ ...value, ...patch });
  return (
    <SettingsShell nChanged={countChanged(value, d)} onReset={() => onChange({ ...d })}>
      <label className="param" title="Genome: GREAT's binomial test over regions and hypergeometric test over genes, against the whole genome. Input sets: Fisher's exact test of the subset's regions against all other regions of this analysis.">
        <span className="k">
          Background{value.background !== d.background && <span className="changed"> · default genome</span>}
        </span>
        <select value={value.background} onChange={(e) => set({ background: e.target.value as GoBackground })} aria-label="Background">
          <option value="genome">Genome</option>
          <option value="inputs">Input sets</option>
        </select>
      </label>
      <NumField label="Basal domain upstream" unit="kb" scale={1000} step={0.5} value={value.upstream} def={d.upstream} min={0} max={100_000} onChange={(v) => set({ upstream: Math.round(v) })} help="Basal regulatory domain: this far upstream of each TSS, regardless of other genes." />
      <NumField label="Basal domain downstream" unit="kb" scale={1000} step={0.5} value={value.downstream} def={d.downstream} min={0} max={100_000} onChange={(v) => set({ downstream: Math.round(v) })} help="Basal regulatory domain: this far downstream of each TSS." />
      <NumField label="Maximum extension" unit="kb" scale={1000} step={50} value={value.maxExtension} def={d.maxExtension} min={0} max={5_000_000} onChange={(v) => set({ maxExtension: Math.round(v) })} help="Each domain extends to the nearest other gene's basal domain, but no further than this from its TSS in each direction." />
      <NumField label="Smallest term" unit="genes" value={value.minGenes} def={d.minGenes} min={1} max={value.maxGenes} onChange={(v) => set({ minGenes: Math.round(v) })} help="Terms with fewer annotated genes are not tested (and not counted in the FDR correction)." />
      <NumField label="Largest term" unit="genes" value={value.maxGenes} def={d.maxGenes} min={value.minGenes} max={2000} onChange={(v) => set({ maxGenes: Math.round(v) })} help="Terms with more annotated genes are not tested. The bundled GO data holds terms of up to 2,000 genes." />
      <NumField label="q-value threshold" step={0.01} value={value.qThreshold} def={d.qThreshold} min={0.0001} max={1} onChange={(v) => set({ qThreshold: v })} help="Benjamini–Hochberg q below which a term is called significant." />
      {value.background === "genome" && (
        <NumField label="Minimum region fold" step={0.5} value={value.minFold} def={d.minFold} min={0} max={100} onChange={(v) => set({ minFold: v })} help="GREAT's second filter: binomial fold enrichment at least this." />
      )}
    </SettingsShell>
  );
}

function CistromeGoSettingsForm({ value, onChange }: { value: CistromeGoSettings; onChange: (s: CistromeGoSettings) => void }) {
  const d = CISTROMEGO_DEFAULTS;
  const set = (patch: Partial<CistromeGoSettings>) => onChange({ ...value, ...patch });
  const TOPS: (number | "all")[] = [1000, 2000, 5000, 10_000, 15_000, 20_000, "all"];
  return (
    <SettingsShell nChanged={countChanged(value, d)} onReset={() => onChange({ ...d })}>
      <label className="param" title="Distance at which a region's contribution to a gene's regulatory potential halves. Auto: 1 kb when at least 20% of the top peaks lie within 1 kb of a TSS (promoter-type), else 10 kb.">
        <span className="k">
          Half-decay distance{value.decay !== d.decay && <span className="changed"> · default auto</span>}
        </span>
        <select value={String(value.decay)} onChange={(e) => set({ decay: e.target.value === "auto" ? "auto" : Number(e.target.value) })}>
          {DECAY_CHOICES.map((c) => (
            <option key={String(c)} value={String(c)}>
              {c === "auto" ? "Auto (1 or 10 kb)" : fmtKb(c)}
            </option>
          ))}
        </select>
      </label>
      <label className="param" title="Regions used for the regulatory potential: the top N by score (column 5), when every region has one; otherwise all regions.">
        <span className="k">
          Peaks used{value.topPeaks !== d.topPeaks && <span className="changed"> · default top 10,000</span>}
        </span>
        <select value={String(value.topPeaks)} onChange={(e) => set({ topPeaks: e.target.value === "all" ? "all" : Number(e.target.value) })}>
          {TOPS.map((t) => (
            <option key={String(t)} value={String(t)}>
              {t === "all" ? "All" : `Top ${t.toLocaleString()}`}
            </option>
          ))}
        </select>
      </label>
      <NumField label="Smallest term" unit="genes" value={value.minGenes} def={d.minGenes} min={1} max={value.maxGenes} onChange={(v) => set({ minGenes: Math.round(v) })} help="Cistrome-GO tests terms with more than 10 and fewer than 2,000 genes." />
      <NumField label="Largest term" unit="genes" value={value.maxGenes} def={d.maxGenes} min={value.minGenes} max={2000} onChange={(v) => set({ maxGenes: Math.round(v) })} help="The bundled GO data holds terms of up to 2,000 genes." />
      <NumField label="XL-mHG L (at most)" unit="genes" step={100} value={value.maxL} def={d.maxL} min={1} max={30_000} onChange={(v) => set({ maxL: Math.round(v) })} help="Only cutoffs within the top L ranked genes are considered; L is also capped at the number of genes with a positive adjusted RP." />
      <NumField label="q-value threshold" step={0.05} value={value.qThreshold} def={d.qThreshold} min={0.0001} max={1} onChange={(v) => set({ qThreshold: v })} help="go.cistrome.org reports terms with FDR < 0.2." />
      <label className="param" title="Of two terms whose gene sets have Jaccard index > 0.85, keep only the larger, as Cistrome-GO does.">
        <span className="k">
          Remove redundant terms (Jaccard &gt; 0.85){value.dedup !== d.dedup && <span className="changed"> · default on</span>}
        </span>
        <input type="checkbox" checked={value.dedup} onChange={(e) => set({ dedup: e.target.checked })} style={{ accentColor: "var(--accent)" }} />
      </label>
    </SettingsShell>
  );
}

/* ---------- chart ---------- */

/** Top enriched terms of one subset: bars of −log10 q in the subset's colour, term names direct-labelled. */
function GoBarChart(props: { subset: SubsetResult; title: string; metric: string; foldLabel: string; qThreshold: number; svgRef: React.RefObject<SVGSVGElement | null> }) {
  const { subset, title, metric, foldLabel, qThreshold, svgRef } = props;
  const TOP = 15;
  const LABEL_W = 280;
  const BAR_MAX = 240;
  const ROW = 18;
  const PAD = 10;
  const HEAD = 22;
  const top = subset.rows.filter((r) => r.fold > 1).slice(0, TOP);
  const max = Math.max(1, negLog10(qThreshold) * 1.15, ...top.map((r) => negLog10(r.q)));
  const footer = `Bar: −log₁₀ q (${metric}); dashed line q = ${qThreshold}; label: ${foldLabel}. Faded: not significant.`;
  const height = PAD + HEAD + Math.max(1, top.length) * ROW + 30;
  const width = Math.max(PAD + LABEL_W + 8 + BAR_MAX + 60, PAD + estimateTextWidth(footer, 10) + PAD, PAD + 14 + estimateTextWidth(title, 11.5) + PAD);
  const x0 = PAD + LABEL_W + 8;
  const thresholdX = x0 + (negLog10(qThreshold) / max) * BAR_MAX;
  return (
    <div className="heatwrap">
      <svg ref={svgRef} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Top GO terms for ${subset.label}`}>
        <rect x={0} y={0} width={width} height={height} fill={PAPER} />
        <line x1={thresholdX} x2={thresholdX} y1={PAD + HEAD - 4} y2={height - 26} stroke={INK_3} strokeDasharray="3 3" strokeWidth={1} />
        <rect x={PAD} y={PAD + 2} width={9} height={9} rx={2} fill={subset.color} />
        <text x={PAD + 14} y={PAD + 11} fontSize={11.5} fill={INK} fontWeight={500}>
          {title}
        </text>
        {!top.length && (
          <text x={PAD} y={PAD + HEAD + 12} fontSize={11} fill={INK_3}>
            No enriched terms
          </text>
        )}
        {top.map((r, i) => {
          const ry = PAD + HEAD + i * ROW;
          const w = Math.max(2, (negLog10(r.q) / max) * BAR_MAX);
          return (
            <g key={r.id}>
              <title>{`${r.name} (${r.id})\n${r.detail}${r.genes?.length ? `\n${r.genes.slice(0, 20).join(", ")}` : ""}`}</title>
              <text x={PAD + LABEL_W} y={ry + 12} textAnchor="end" fontSize={11} fill={INK}>
                {truncateToWidth(r.name, LABEL_W - 4, 11)}
              </text>
              <rect x={x0} y={ry + 3} width={w} height={ROW - 6} rx={2} fill={subset.color} opacity={r.significant ? 0.9 : 0.4} />
              <text x={x0 + 4 + w} y={ry + 12} fontSize={10} fontFamily="monospace" fill={INK_3}>
                {fmtFold(r.fold)}×
              </text>
            </g>
          );
        })}
        <text x={PAD} y={height - 8} fontSize={10} fill={INK_3}>
          {footer}
        </text>
      </svg>
    </div>
  );
}
