import { useCallback, useEffect, useRef, useState } from "react";
import { SetRail } from "./components/SetRail";
import { UpSetPlot } from "./components/UpSetPlot";
import { VennPlot } from "./components/VennPlot";
import { PairwiseHeatmap } from "./components/PairwiseHeatmap";
import { SubsetTable } from "./components/SubsetTable";
import { SummaryPlot, type SummaryItem } from "./components/SummaryPlot";
import { RegionAnnotationPlot } from "./components/RegionAnnotationPlot";
import { GeneListPanel } from "./components/GeneListPanel";
import { SubsetEnrichmentPanel } from "./components/SubsetEnrichmentPanel";
import { GoEnrichmentPanel } from "./components/GoEnrichmentPanel";
import { OfflineBadge } from "./components/OfflineStatus";
import { SubsetChips } from "./components/SubsetChips";
import { SubsetRegionsTable } from "./components/SubsetRegionsTable";
import { HelpPage } from "./components/HelpPage";
import { ComputeStatus } from "./components/ComputeStatus";
import { COPYRIGHT_YEAR, LAB_NAME, LAB_URL, LICENSE_URL, SOURCE_CODE_URL } from "./siteLinks";
import { useStore, type View } from "./state/store";
import { subsetToBedText } from "./lib/pipeline";
import { PALETTE, type Subset } from "./types";
import "./styles/tokens.css";
import "./App.css";
import { Icon } from "./components/Icon";

const VIEWS: { id: View; label: string }[] = [
  { id: "upset", label: "UpSet" },
  { id: "venn", label: "Venn" },
  { id: "pairwise", label: "Pairwise" },
  { id: "table", label: "Table" },
  { id: "summary", label: "Set Summary" },
];

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}
function bpfmt(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} Mb`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kb`;
  return `${n} bp`;
}

/** Read `#view=upset&sel=3,5` from the URL on first load. */
function parseHash(): { view?: View; selMasks: number[] } {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const view = params.get("view") as View | null;
  const sel = params.get("sel");
  return {
    view: view && (view === "help" || VIEWS.some((v) => v.id === view)) ? view : undefined,
    selMasks: sel ? sel.split(",").map(Number).filter(Number.isFinite) : [],
  };
}

function App() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const sets = useStore((s) => s.sets);
  const subsets = useStore((s) => s.subsets);
  const selected = useStore((s) => s.selected);
  const toggleSelected = useStore((s) => s.toggleSelected);
  const exportSelectedBedZip = useStore((s) => s.exportSelectedBedZip);
  const exportSubsetBed = useStore((s) => s.exportSubsetBed);
  const status = useStore((s) => s.status);
  const busy = status === "loading-worker" || status === "running";

  const appliedInitialSelection = useRef(false);
  // Where "Back to workspace" returns to from the help page.
  const lastWorkspaceView = useRef<View>("upset");
  if (view !== "help") lastWorkspaceView.current = view;
  // Which subset's regions were just copied, so the button can briefly
  // confirm success — cleared after a short timeout, not tied to any
  // store state since it's purely transient UI feedback.
  const [copiedMask, setCopiedMask] = useState<number | null>(null);

  const copySubsetToClipboard = useCallback(async (subset: Subset) => {
    try {
      await navigator.clipboard.writeText(subsetToBedText(subset));
      setCopiedMask(subset.mask);
      setTimeout(() => setCopiedMask((m) => (m === subset.mask ? null : m)), 1500);
    } catch (err) {
      console.warn("Could not copy to clipboard", err);
    }
  }, []);

  // Restore view + selection from a shared URL. Sets/regions are never
  // uploaded or persisted, so this only restores the *analysis config*
  // (which view, which subset masks) — reload the same files (or "Load
  // example") to see it populated again.
  useEffect(() => {
    const { view: initialView, selMasks } = parseHash();
    if (initialView) setView(initialView);
    if (selMasks.length) {
      // Applied once subsets exist — see the effect below.
      (window as unknown as { __pendingSel?: number[] }).__pendingSel = selMasks;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (appliedInitialSelection.current || !subsets.length) return;
    const pending = (window as unknown as { __pendingSel?: number[] }).__pendingSel;
    if (pending?.length) {
      for (const mask of pending) {
        if (subsets.some((s) => s.mask === mask)) toggleSelected(mask);
      }
    }
    appliedInitialSelection.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subsets]);

  useEffect(() => {
    const params = new URLSearchParams();
    params.set("view", view);
    if (selected.size) params.set("sel", [...selected].join(","));
    window.history.replaceState(null, "", `#${params.toString()}`);
  }, [view, selected]);

  const selectedSubsets = [...selected].map((m) => subsets.find((s) => s.mask === m)).filter((s) => s !== undefined);

  const setSummaryItems: SummaryItem[] = sets
    .filter((s) => s.included)
    // version = contentKey: the filtered and unfiltered versions of a set are cached separately.
    .map((s) => ({ id: s.id, version: s.contentKey, name: s.name, color: s.color, getRawText: () => s.file.text() }));

  // Subsets (unlike sets) get recomputed under a new mask -> content
  // mapping whenever the overlap setting changes, so the cache key needs
  // more than the mask to stay correct (see SummaryItem.version's doc).
  // Colors come from the shared PALETTE by selection order, not from any
  // one member set's color — a subset can span multiple sets.
  const selectedSubsetSummaryItems: SummaryItem[] = selectedSubsets.map((s, i) => ({
    id: String(s.mask),
    version: `${s.mask}:${s.nRegions}:${s.nBp}`,
    name: s.label,
    color: PALETTE[i % PALETTE.length],
    getRawText: () => Promise.resolve(subsetToBedText(s)),
  }));

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <h1><img src="logo.svg" width="100" alt="Intervene Web" /></h1>
          <span className="eyebrow">A secure platform for in-browser genomic intersections, annotation and enrichment without data upload</span>
        </div>
        <nav className="topnav" aria-label="Site">
          <OfflineBadge
            onOpenHelp={() => {
              setView("help");
              requestAnimationFrame(() => document.getElementById("offline")?.scrollIntoView());
            }}
          />
          <button className="ghost" aria-pressed={view === "help"} onClick={() => setView(view === "help" ? lastWorkspaceView.current : "help")}>
            Help
          </button>
          <a
            className="ghost"
            href="#view=help"
            onClick={(e) => {
              e.preventDefault();
              setView("help");
              requestAnimationFrame(() => document.getElementById("cite")?.scrollIntoView());
            }}
          >
            Cite
          </a>
        </nav>
      </header>

      {view === "help" ? (
        <HelpPage onBack={() => setView(lastWorkspaceView.current)} />
      ) : (
      <main className="work">
        <SetRail />

        <section className="col mid" aria-label="Intersections">
          <div className="rowsplit">
            <div className="tabs" role="tablist">
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  className="tab"
                  role="tab"
                  aria-selected={view === v.id}
                  onClick={() => setView(v.id)}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <button className="ghost" disabled={!selected.size} onClick={() => void exportSelectedBedZip()}>
              Export selected subsets
            </button>
          </div>

          <div className={`card plotcard${busy ? " busy" : ""}`} aria-busy={busy}>
            <ComputeStatus />
            <div className="hd">
              <div className="eyebrow">
                {view === "summary"
                  ? "Summary — per-set interval statistics (bedtools summary)"
                  : "Intersections — click a bar to select a subset"}
              </div>
            </div>
            {view === "upset" && <UpSetPlot />}
            {view === "venn" && <VennPlot />}
            {view === "pairwise" && <PairwiseHeatmap />}
            {view === "table" && <SubsetTable />}
            {view === "summary" && <SummaryPlot items={setSummaryItems} />}
          </div>

          {view === "summary" && (
            <div className="card">
              <div className="hd">
                <div className="eyebrow">Region annotation — bedtools intersect/closest vs. GENCODE</div>
              </div>
              <RegionAnnotationPlot items={setSummaryItems} />
            </div>
          )}

          {/* Selection is about intersection subsets: not shown with the per-set Summary. */}
          {view !== "summary" && (
            <div className="card">
              <div className="bd">
                <div className="eyebrow" style={{ marginBottom: 9 }}>
                  Selection
                </div>
                <SubsetChips />
              </div>
            </div>
          )}

          {view !== "summary" && selectedSubsets.length > 0 && (
            <div className="card">
              <div className="hd">
                <div className="eyebrow">Summary of selected subsets (bedtools summary)</div>
              </div>
              <SummaryPlot items={selectedSubsetSummaryItems} />
            </div>
          )}

          {view !== "summary" && selectedSubsets.length > 0 && (
            <div className="card">
              <div className="hd">
                <div className="eyebrow">Region annotation of selected subsets — bedtools intersect/closest vs. GENCODE</div>
              </div>
              <RegionAnnotationPlot items={selectedSubsetSummaryItems} />
            </div>
          )}

          {view !== "summary" && selectedSubsets.length > 0 && (
            <div className="card">
              <div className="hd">
                <div className="eyebrow">Enrichment of selected subsets — reference region sets</div>
              </div>
              <div className="bd">
                <SubsetEnrichmentPanel />
              </div>
            </div>
          )}

          {view !== "summary" && selectedSubsets.length > 0 && (
            <div className="card">
              <div className="hd">
                <div className="eyebrow">GO enrichment of selected subsets — GREAT-like or Cistrome-GO-like</div>
              </div>
              <div className="bd">
                <GoEnrichmentPanel />
              </div>
            </div>
          )}

          {view !== "summary" && selectedSubsets.length > 0 && (
            <div className="card">
              <div className="hd">
                <div className="eyebrow">Genes near the selected subsets — nearest to TSS</div>
              </div>
              <GeneListPanel items={selectedSubsetSummaryItems} />
            </div>
          )}
        </section>

        <section className="col" aria-label="Selected subset details">
          <div className="eyebrow" style={{ marginBottom: 10 }}>
            Selected subsets
          </div>
          {!selectedSubsets.length && (
            <div className="placeholder">
              <div className="big">Nothing selected</div>
              <div className="sm">
                Pick one or more subsets from the plot, the Venn diagram or the table to see their regions here.
              </div>
            </div>
          )}
          {selectedSubsets.map((s) => (
            <div className="card" key={s.mask} style={{ marginBottom: 10 }}>
              <div className="bd">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <div className="nm" style={{ fontSize: 13.5, fontWeight: 500 }}>
                    {s.label}
                  </div>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button
                      className="iconbtn"
                      title={copiedMask === s.mask ? "Copied!" : "Copy BED to clipboard"}
                      aria-label={`Copy ${s.label} as BED`}
                      onClick={() => void copySubsetToClipboard(s)}
                    >
                      <Icon name={copiedMask === s.mask ? "check" : "copy"} />
                    </button>
                    <button className="iconbtn" title={`Download ${s.code || s.mask}.bed`} aria-label={`Download ${s.label} as BED`} onClick={() => exportSubsetBed(s.mask)}>
                      <Icon name="download" />
                    </button>
                    <button className="iconbtn" title={`Close ${s.label}`} aria-label={`Deselect ${s.label}`} onClick={() => toggleSelected(s.mask)}>
                      <Icon name="close" />
                    </button>
                  </div>
                </div>
                <div className="mono" style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>
                  {fmt(s.nRegions)} regions · {bpfmt(s.nBp)}
                </div>
                <SubsetRegionsTable subset={s} />
              </div>
            </div>
          ))}
        </section>
      </main>
      )}

      <footer className="bot">
        <div className="foot-notes">
          <span className="free">
            <span className="dot" aria-hidden="true" />
            Intervene is open to all without anylogin.
          </span>
          <span className="foot-private">Your files never leave your browser.</span>
        </div>
        <nav className="foot-links" aria-label="About this site">
          <a
            href="#view=help"
            onClick={(e) => {
              e.preventDefault();
              setView("help");
              requestAnimationFrame(() => document.getElementById("cite")?.scrollIntoView());
            }}
          >
            How to cite
          </a>
          <a href={SOURCE_CODE_URL} target="_blank" rel="noreferrer">
          Source code
          </a>
          <a href={LICENSE_URL} target="_blank" rel="noreferrer">
          MIT licence
          </a>
          <span>
            © {COPYRIGHT_YEAR}{" "}
            <a href={LAB_URL} target="_blank" rel="noreferrer">
            {LAB_NAME}
            </a>
          </span>
        </nav>
      </footer>
    </div>
  );
}

export default App;

