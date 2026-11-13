import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { downloadPng, downloadSvg } from "../lib/exportImage";
import { estimateTextWidth, truncateToWidth } from "../lib/textMeasure";
import {
  ANNO_CATEGORIES,
  DISTANCE_BINS,
  annotationStepTotal,
  bucketDistance,
  fetchAndMountAnnotation,
  annotatePeaks,
  type PeakAnno,
} from "../lib/peakAnnotation";
import type { SummaryItem } from "./SummaryPlot";
import { ComputeOverlay, type ComputeProgress } from "./ComputeStatus";

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

// Concrete colors (not CSS vars) so exported standalone SVG/PNG render
// correctly outside this page's stylesheet — same convention as every
// other plot in this app.
const INK = "#101826";
const INK_3 = "#8b97a9";
const LINE_STRONG = "#93989d";
const PAPER = "#ffffff";

// One color per genomic-feature category (distinct from the per-set/item
// PALETTE in types.ts, since here color encodes *category*, not item
// identity) — order matches ANNO_CATEGORIES' priority/display order.
const CATEGORY_COLORS: Record<string, string> = {
  tss: "#7B3FD1",
  core_promoter: "#2B6FE0",
  promoter_proximal: "#5B9BD5",
  "5utr": "#0E8C74",
  first_exon: "#3AA65C",
  other_exon: "#8FBF3F",
  "3utr": "#C2611A",
  first_intron: "#E0A72B",
  other_intron: "#F2C94C",
  downstream: "#BE3466",
  distal_intergenic: "#93989D",
};

const LABEL_FONT_SIZE = 11.5;
const ROW_LABEL_MAX_W = 100;
const ROW_LABEL_GAP = 8;

// Module-level, not component state: this component unmounts whenever
// `view` navigates away from "summary" (App.tsx only renders it on that
// tab), and annotating a set against ~10 reference BEDs plus a priority
// intersect chain plus a closest call is expensive enough that silently
// redoing it every time a user glances at another tab (e.g. to select a
// subset on the UpSet plot) and comes back is a real, noticeable cost —
// unlike a plain useRef/useState pair, which reset on every remount.
// Keyed by (assembly, item id, item version), so this still
// self-invalidates correctly if the same id's content ever changes.
const categoryPathsCache = new Map<string, Record<string, string>>();
const peakAnnoCache = new Map<string, PeakAnno>();

/**
 * ChIPseeker-style region annotation — see lib/peakAnnotation.ts's module
 * docstring and docs/methods.md for the exact category windows, priority
 * order, and distance bins this encodes. `items` uses the same
 * `SummaryItem` shape as SummaryPlot.tsx so this can be pointed at
 * selected subsets later with no changes here — only the caller (App.tsx)
 * needs to build a different items array.
 */
export function RegionAnnotationPlot({ items }: { items: SummaryItem[] }) {
  const assembly = useStore((s) => s.assembly);
  const annoBarRef = useRef<SVGSVGElement | null>(null);
  const distToTssRef = useRef<SVGSVGElement | null>(null);

  const categoryPathsRef = useRef(categoryPathsCache); // shared module-level Map, not a fresh one per mount
  const [peakAnnoState, setPeakAnnoState] = useState<Map<string, PeakAnno>>(() => new Map(peakAnnoCache));
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ComputeProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cacheKey = (item: SummaryItem) => `${assembly}::${item.id}::${item.version}`;
  const itemsKey = items.map((i) => `${i.id}:${i.version}`).join(",");

  useEffect(() => {
    if (items.length < 1) return;
    let cancelled = false;

    (async () => {
      const todo = items.filter((item) => !peakAnnoCache.has(cacheKey(item)));
      if (!todo.length) {
        // A cancelled earlier run may have left the overlay up.
        setLoading(false);
        setProgress(null);
        return;
      }
      let categoryPaths = categoryPathsRef.current.get(assembly);
      // One step per reference file still to load, then 2 intersects per
      // category + 1 closest per item (lib/peakAnnotation.ts).
      const total = annotationStepTotal(todo.length, categoryPaths !== undefined);
      let done = 0;
      const onStep = (label: string) => {
        done++;
        if (!cancelled) setProgress({ done, total, label });
      };
      setLoading(true);
      setError(null);
      setProgress({ done: 0, total, label: categoryPaths ? `${todo[0].name}: starting` : "Loading GENCODE annotation" });
      try {
        if (!categoryPaths) {
          categoryPaths = await fetchAndMountAnnotation(assembly, onStep);
          categoryPathsRef.current.set(assembly, categoryPaths);
        }

        for (const item of todo) {
          if (cancelled) return;
          const key = cacheKey(item);
          const anno = await annotatePeaks(item, categoryPaths, onStep);
          if (cancelled) return;
          peakAnnoCache.set(key, anno);
          setPeakAnnoState((prev) => new Map(prev).set(key, anno));
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setProgress(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // peakAnnoCache (the module-level Map) is read for "already computed?"
    // checks only, see the same note in SummaryPlot.tsx's/PairwiseHeatmap.tsx's effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assembly, itemsKey]);

  if (items.length < 1) {
    return (
      <div className="placeholder">
        <div className="big">Load a region set</div>
        <div className="sm">Region annotation works with just one set — it's per-set, not per-overlap.</div>
      </div>
    );
  }

  const peakAnnoList: (PeakAnno | undefined)[] = items.map((item) => peakAnnoState.get(cacheKey(item)));

  const busy = loading && !error;

  return (
    <div className={`annowrap${busy ? " busy" : ""}`} aria-busy={busy}>
      {busy && <ComputeOverlay label={progress?.label ?? "Annotating regions"} progress={progress} />}
      {error && (
        <div className="rowsplit" style={{ margin: "0 13px 10px", justifyContent: "flex-end" }}>
          <span className="hint error" style={{ margin: 0 }}>
            {error}
          </span>
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, paddingTop: 4 }}>
        <AnnoBarChart items={items} peakAnnoList={peakAnnoList} svgRef={annoBarRef} />
        <DistToTssChart items={items} peakAnnoList={peakAnnoList} svgRef={distToTssRef} />
      </div>
    </div>
  );
}

/** plotAnnoBar: one 100%-stacked horizontal bar per item, segments colored by genomic-feature category. */
function AnnoBarChart({
  items,
  peakAnnoList,
  svgRef,
}: {
  items: SummaryItem[];
  peakAnnoList: (PeakAnno | undefined)[];
  svgRef: React.RefObject<SVGSVGElement | null>;
}) {
  const BAR_W = 260;
  const ROW_H = 26;
  const ROW_GAP = 8;
  const PAD = 10;
  const TOP_PAD = 10;
  const LEGEND_GAP = 18;
  const LEGEND_ROW_H = 16;
  const LEGEND_SWATCH = 9;
  const LEGEND_SWATCH_GAP = 5;
  const LEGEND_FONT_SIZE = 9.5;

  const rowLabelW = Math.min(ROW_LABEL_MAX_W, Math.max(0, ...items.map((i) => estimateTextWidth(i.name, LABEL_FONT_SIZE))));
  const labelW = rowLabelW + ROW_LABEL_GAP;
  const barsAreaW = labelW + BAR_W;
  const legendTextW = Math.max(0, ...ANNO_CATEGORIES.map((c) => estimateTextWidth(c.label, LEGEND_FONT_SIZE)));
  const legendW = LEGEND_SWATCH + LEGEND_SWATCH_GAP + legendTextW;
  const legendX = PAD + barsAreaW + LEGEND_GAP;
  const width = legendX + legendW + PAD;
  const barsH = items.length * (ROW_H + ROW_GAP) - ROW_GAP;
  const legendH = ANNO_CATEGORIES.length * LEGEND_ROW_H;
  const height = TOP_PAD + Math.max(barsH, legendH) + PAD;

  return (
    <div className="heatwrap" style={{ flex: "1 1 500px" }}>
      <svg
        ref={svgRef}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Region annotation category composition"
      >
        <rect x={0} y={0} width={width} height={height} fill={PAPER} />
        {items.map((item, i) => {
          const anno = peakAnnoList[i];
          const y = TOP_PAD + i * (ROW_H + ROW_GAP);
          let x = PAD + labelW;
          return (
            <g key={item.id}>
              <text x={PAD + labelW - ROW_LABEL_GAP} y={y + ROW_H / 2 + 4} textAnchor="end" fontSize={LABEL_FONT_SIZE} fill={INK}>
                <title>{item.name}</title>
                {truncateToWidth(item.name, rowLabelW, LABEL_FONT_SIZE)}
              </text>
              {!anno ? (
                <text x={x} y={y + ROW_H / 2 + 4} fontSize={LABEL_FONT_SIZE} fill={INK_3}>
                  computing…
                </text>
              ) : anno.total === 0 ? (
                <text x={x} y={y + ROW_H / 2 + 4} fontSize={LABEL_FONT_SIZE} fill={INK_3}>
                  no regions
                </text>
              ) : (
                ANNO_CATEGORIES.map((cat) => {
                  const count = anno.categoryCounts[cat.key] ?? 0;
                  if (count === 0) return null;
                  const segW = (count / anno.total) * BAR_W;
                  const seg = (
                    <g key={cat.key}>
                      <title>{`${item.name} — ${cat.label}: ${fmt(count)} (${((count / anno.total) * 100).toFixed(1)}%)`}</title>
                      <rect x={x} y={y} width={segW} height={ROW_H} fill={CATEGORY_COLORS[cat.key]} />
                    </g>
                  );
                  x += segW;
                  return seg;
                })
              )}
            </g>
          );
        })}
        {/* Legend: one category per row, to the right of the bars. */}
        {ANNO_CATEGORIES.map((cat, i) => {
          const y = TOP_PAD + i * LEGEND_ROW_H;
          return (
            <g key={cat.key}>
              <rect x={legendX} y={y} width={LEGEND_SWATCH} height={LEGEND_SWATCH} fill={CATEGORY_COLORS[cat.key]} />
              <text x={legendX + LEGEND_SWATCH + LEGEND_SWATCH_GAP} y={y + LEGEND_SWATCH} fontSize={LEGEND_FONT_SIZE} fill={INK_3}>
                {cat.label}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="plotactions">
        <button className="iconbtn" title="Export SVG" onClick={() => svgRef.current && downloadSvg(svgRef.current, "intervene-anno-bar.svg")}>
          SVG
        </button>
        <button
          className="iconbtn"
          title="Export PNG"
          onClick={() => svgRef.current && void downloadPng(svgRef.current, "intervene-anno-bar.png")}
        >
          PNG
        </button>
      </div>
    </div>
  );
}

/** plotDistToTSS: grouped bar chart, one bar per item per signed-distance-to-TSS bin, y-axis = % of that item's peaks. */
function DistToTssChart({
  items,
  peakAnnoList,
  svgRef,
}: {
  items: SummaryItem[];
  peakAnnoList: (PeakAnno | undefined)[];
  svgRef: React.RefObject<SVGSVGElement | null>;
}) {
  const BAR_W = 8;
  const BAR_GAP = 2;
  const GROUP_GAP = 10;
  const PLOT_H = 180;
  const TOP_PAD = 16;
  const LEFT_PAD = 42;
  const RIGHT_PAD = 14;
  const BOTTOM_PAD = 50;
  const LEGEND_GAP = 18;
  const LEGEND_ROW_H = 16;
  const LEGEND_SWATCH = 9;
  const LEGEND_SWATCH_GAP = 5;
  const LEGEND_FONT_SIZE = 9.5;
  const LEGEND_LABEL_MAX_W = 90;

  const pctFor = (anno: PeakAnno | undefined, binLabel: string): number => {
    if (!anno || anno.total === 0) return 0;
    const count = anno.distances.filter((d) => bucketDistance(d) === binLabel).length;
    return (count / anno.total) * 100;
  };

  const maxPct = Math.max(1, ...DISTANCE_BINS.map((bin) => Math.max(...items.map((_, i) => pctFor(peakAnnoList[i], bin.label)))));
  const groupWidth = items.length * BAR_W + Math.max(0, items.length - 1) * BAR_GAP;
  const plotW = LEFT_PAD + DISTANCE_BINS.length * (groupWidth + GROUP_GAP) - GROUP_GAP + RIGHT_PAD;
  const legendTextW = Math.min(LEGEND_LABEL_MAX_W, Math.max(0, ...items.map((it) => estimateTextWidth(it.name, LEGEND_FONT_SIZE))));
  const legendW = LEGEND_SWATCH + LEGEND_SWATCH_GAP + legendTextW;
  const legendX = plotW + LEGEND_GAP;
  const width = legendX + legendW;
  const height = TOP_PAD + Math.max(PLOT_H, items.length * LEGEND_ROW_H) + BOTTOM_PAD;
  const baseline = TOP_PAD + PLOT_H;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(maxPct * f));

  return (
    <div className="heatwrap" style={{ flex: "1 1 560px" }}>
      <svg ref={svgRef} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Distance to nearest TSS">
        <rect x={0} y={0} width={width} height={height} fill={PAPER} />
        <text
          x={12}
          y={(TOP_PAD + baseline) / 2}
          textAnchor="middle"
          fontSize={11}
          fill={INK_3}
          fontFamily="Inter Tight, sans-serif"
          transform={`rotate(-90 12 ${(TOP_PAD + baseline) / 2})`}
        >
          % of peaks
        </text>
        {yTicks.map((v, i) => {
          const y = baseline - (maxPct > 0 ? (v / maxPct) * PLOT_H : 0);
          return (
            <g key={i}>
              <line x1={LEFT_PAD - 4} y1={y} x2={plotW - RIGHT_PAD} y2={y} stroke="#eef0f3" strokeWidth={1} />
              <text x={LEFT_PAD - 8} y={y + 4} textAnchor="end" fontSize={10} fontFamily="monospace" fill={INK_3}>
                {v}%
              </text>
            </g>
          );
        })}
        <line x1={LEFT_PAD} y1={TOP_PAD} x2={LEFT_PAD} y2={baseline} stroke={LINE_STRONG} strokeWidth={1} />
        <line x1={LEFT_PAD} y1={baseline} x2={plotW - RIGHT_PAD} y2={baseline} stroke={LINE_STRONG} strokeWidth={1} />
        {DISTANCE_BINS.map((bin, g) => {
          const groupX = LEFT_PAD + g * (groupWidth + GROUP_GAP);
          return (
            <g key={bin.label}>
              <text
                x={groupX + groupWidth / 2}
                y={baseline + 12}
                textAnchor="end"
                fontSize={9}
                fontFamily="monospace"
                fill={INK_3}
                transform={`rotate(-40 ${groupX + groupWidth / 2} ${baseline + 12})`}
              >
                {bin.label}
              </text>
              {items.map((item, i) => {
                const pct = pctFor(peakAnnoList[i], bin.label);
                const h = maxPct > 0 ? (pct / maxPct) * PLOT_H : 0;
                const x = groupX + i * (BAR_W + BAR_GAP);
                return (
                  <g key={item.id}>
                    <title>{`${item.name} · ${bin.label} — ${pct.toFixed(1)}%`}</title>
                    <rect x={x} y={baseline - h} width={BAR_W} height={h} fill={item.color} opacity={0.85} />
                  </g>
                );
              })}
            </g>
          );
        })}
        <text
          x={LEFT_PAD + (plotW - LEFT_PAD - RIGHT_PAD) / 2}
          y={height - 6}
          textAnchor="middle"
          fontSize={11}
          fill={INK_3}
          fontFamily="Inter Tight, sans-serif"
        >
          Distance to nearest TSS
        </text>
        {/* Legend: one set per row, to the right of the plot. */}
        {items.map((item, i) => {
          const y = TOP_PAD + i * LEGEND_ROW_H;
          return (
            <g key={item.id}>
              <rect x={legendX} y={y} width={LEGEND_SWATCH} height={LEGEND_SWATCH} fill={item.color} />
              <text x={legendX + LEGEND_SWATCH + LEGEND_SWATCH_GAP} y={y + LEGEND_SWATCH} fontSize={LEGEND_FONT_SIZE} fill={INK_3}>
                <title>{item.name}</title>
                {truncateToWidth(item.name, LEGEND_LABEL_MAX_W, LEGEND_FONT_SIZE)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="plotactions">
        <button className="iconbtn" title="Export SVG" onClick={() => svgRef.current && downloadSvg(svgRef.current, "intervene-dist-to-tss.svg")}>
          SVG
        </button>
        <button
          className="iconbtn"
          title="Export PNG"
          onClick={() => svgRef.current && void downloadPng(svgRef.current, "intervene-dist-to-tss.png")}
        >
          PNG
        </button>
      </div>
    </div>
  );
}
