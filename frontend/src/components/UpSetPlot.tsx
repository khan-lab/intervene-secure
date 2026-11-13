import { useRef } from "react";
import { useStore } from "../state/store";
import { downloadPng, downloadSvg } from "../lib/exportImage";
import { estimateTextWidth, fitCount, truncateToWidth } from "../lib/textMeasure";

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}
function bpfmt(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} Mb`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kb`;
  return `${n} bp`;
}

// Rendered as plain SVG (rather than HTML/CSS bars) so "Export SVG"/"Export
// PNG" can serialize this exact plot. Concrete hex colors are used instead
// of CSS custom properties, since an exported standalone SVG file has no
// access to this page's :root variables.
const INK = "#101826";
const INK_3 = "#8b97a9";
const LINE_STRONG = "#93989d";
const PAPER = "#ffffff";

const BAR_W = 25;
const GAP = 8;
const PLOT_H = 200;
const TOP_PAD = 20;
const ROW_H = 20;
const DOT_R = 5;
const RIGHT_PAD = 14;
const BOTTOM_PAD = 10;
const Y_TICKS = 4;

// Classic UpSetR/ComplexUpset layout: a horizontal "Set Size" bar chart
// sits to the LEFT of the set-name row labels, bars anchored flush against
// the label column and growing further left for bigger sets, with each
// bar's own count just outside its (variable-position) left tip.
const SET_NUM_FONT_SIZE = 9.5;
const SET_BAR_MAX_W = 50;
const SET_BAR_H = 12;
const SET_BAR_GAP = 6;
const LABEL_FONT_SIZE = 11.5;
const LABEL_MAX_W = 100; // cap — a longer name is truncated with an ellipsis rather than growing the column further
const LABEL_GAP = 10;
const BAR_LABEL_FONT_SIZE = 11;

export function UpSetPlot({ svgRef }: { svgRef?: React.RefObject<SVGSVGElement | null> }) {
  const allSets = useStore((s) => s.sets);
  const sets = allSets.filter((x) => x.included);
  const subsets = useStore((s) => s.subsets);
  const selected = useStore((s) => s.selected);
  const toggleSelected = useStore((s) => s.toggleSelected);
  const upsetSort = useStore((s) => s.upsetSort);
  const upsetMinSize = useStore((s) => s.upsetMinSize);
  const setUpsetSort = useStore((s) => s.setUpsetSort);
  const setUpsetMinSize = useStore((s) => s.setUpsetMinSize);
  const localRef = useRef<SVGSVGElement | null>(null);
  const ref = svgRef ?? localRef;

  if (!subsets.length) {
    return (
      <div className="placeholder">
        <div className="big">Load two or more region sets</div>
        <div className="sm">Every combination of overlap becomes a bar. Click one to carry it into export.</div>
      </div>
    );
  }

  const toolbar = (
    <div className="rowsplit" style={{ marginBottom: 10 }}>
      <div className="tabs" role="tablist" aria-label="UpSet sort">
        <button className="tab" role="tab" aria-selected={upsetSort === "size"} onClick={() => setUpsetSort("size")}>
          Size
        </button>
        <button className="tab" role="tab" aria-selected={upsetSort === "degree"} onClick={() => setUpsetSort("degree")}>
          Degree
        </button>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ink-3)" }}>
        Min size
        <input
          className="param-text"
          type="number"
          min={0}
          value={upsetMinSize}
          onChange={(e) => setUpsetMinSize(Number(e.target.value))}
          style={{ width: 64 }}
        />
      </label>
    </div>
  );

  // subsets is already sorted by nRegions descending (lib/pipeline.ts) —
  // that's "size" order for free; "degree" re-sorts ascending (single-set
  // bars first), nRegions descending as the tiebreak within a degree.
  const filtered = subsets.filter((s) => s.nRegions >= upsetMinSize);
  const ordered = upsetSort === "degree" ? [...filtered].sort((a, b) => a.degree - b.degree || b.nRegions - a.nRegions) : filtered;

  if (!ordered.length) {
    return (
      <div className="plotwrap">
        {toolbar}
        <div className="placeholder">
          <div className="big">No bars at this size</div>
          <div className="sm">Lower the minimum subset size to see results.</div>
        </div>
      </div>
    );
  }

  // Every subset at or above Min size is drawn; a wide plot scrolls sideways (.upset-scroll).
  const shown = ordered;
  const max = Math.max(...shown.map((s) => s.nRegions));
  const maxSetSize = Math.max(...sets.map((s) => s.nRegions), 1);
  // Size the label column to the longest set name actually loaded, capped
  // at LABEL_MAX_W — short names (e.g. "A", "B") no longer waste a fixed
  // 90px of empty margin, and a name longer than the cap is truncated
  // (with a full-name tooltip) instead of growing the column further.
  const labelW = Math.min(LABEL_MAX_W, Math.max(0, ...sets.map((s) => estimateTextWidth(s.name, LABEL_FONT_SIZE))));
  // Room for the widest set-size count past the longest bar (counts can be 7+ digits for reference sets).
  const setNumPad = 10 + Math.max(...sets.map((s) => s.nRegions.toLocaleString("en-US").length)) * SET_NUM_FONT_SIZE * 0.62;
  const SET_BAR_RIGHT = setNumPad + SET_BAR_MAX_W; // bars anchor flush here
  const labelRight = SET_BAR_RIGHT + SET_BAR_GAP + labelW; // set-name text ends here
  const leftMargin = labelRight + LABEL_GAP; // where the intersection-size axis/bars start
  const axisX = leftMargin - 4;
  const width = leftMargin + shown.length * (BAR_W + GAP) - GAP + RIGHT_PAD;
  const height = TOP_PAD + PLOT_H + 14 + sets.length * ROW_H + BOTTOM_PAD;
  const baseline = TOP_PAD + PLOT_H;
  const axisTitleY = (TOP_PAD + baseline) / 2;
  const yTickValues = Array.from({ length: Y_TICKS + 1 }, (_, i) => Math.round((max * i) / Y_TICKS));
  const firstRowY = baseline + 22;

  // The left block — y-axis, set-size bars and set names — is drawn in the
  // main SVG (so exports are one complete image) and again in a pinned
  // overlay (.upset-pin, position: sticky) so it stays visible while the bars
  // scroll sideways. The overlay sits exactly on top of the original, so at
  // scrollLeft 0 the two coincide.
  const leftBlock = (
    <>
      <text
        x={14}
        y={axisTitleY}
        textAnchor="middle"
        fontSize={11}
        fill={INK_3}
        fontFamily="Inter Tight, sans-serif"
        transform={`rotate(-90 14 ${axisTitleY})`}
      >
        Intersection Size
      </text>
      {yTickValues.map((v) => {
        const y = baseline - (max > 0 ? (v / max) * PLOT_H : 0);
        return (
          <g key={v}>
            <line x1={axisX - 4} y1={y} x2={axisX} y2={y} stroke={LINE_STRONG} strokeWidth={1} />
            <text x={axisX - 8} y={y + 4} textAnchor="end" fontSize={10} fontFamily="monospace" fill={INK_3}>
              {fmt(v)}
            </text>
          </g>
        );
      })}
      <line x1={axisX} y1={TOP_PAD} x2={axisX} y2={baseline} stroke={LINE_STRONG} strokeWidth={1} />
      <text x={SET_BAR_RIGHT} y={firstRowY - 12} textAnchor="end" fontSize={10} fill={INK_3} fontFamily="Inter Tight, sans-serif">
        Set Size
      </text>
      {sets.map((set, r) => {
        const rowY = firstRowY + r * ROW_H;
        const barLen = (set.nRegions / maxSetSize) * SET_BAR_MAX_W;
        const barX = SET_BAR_RIGHT - barLen;
        return (
          <g key={set.id}>
            <title>{`${set.name} — ${fmt(set.nRegions)} regions, ${bpfmt(set.nBp)}`}</title>
            <rect x={barX} y={rowY - SET_BAR_H / 2} width={barLen} height={SET_BAR_H} rx={2} fill={set.color} opacity={0.75} />
            <text x={barX - 4} y={rowY + 4} textAnchor="end" fontSize={SET_NUM_FONT_SIZE} fontFamily="monospace" fill={INK_3}>
              {fmt(set.nRegions)}
            </text>
            <text x={labelRight} y={rowY + 4} textAnchor="end" fontSize={LABEL_FONT_SIZE} fill={INK_3}>
              {truncateToWidth(set.name, labelW, LABEL_FONT_SIZE)}
            </text>
          </g>
        );
      })}
    </>
  );

  return (
    <div className="plotwrap">
      {toolbar}
      {/* scroll-padding keeps a keyboard-focused bar clear of the pinned left block */}
      <div className="upset-scroll" style={{ scrollPaddingLeft: leftMargin }}>
        <div className="upset-track">
          <div className="upset-pin" aria-hidden="true">
            <svg width={leftMargin} height={height} viewBox={`0 0 ${leftMargin} ${height}`}>
              <rect x={0} y={0} width={leftMargin} height={height} fill={PAPER} />
              {leftBlock}
            </svg>
          </div>
          <svg ref={ref} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="UpSet plot">
            <rect x={0} y={0} width={width} height={height} fill={PAPER} />
            {leftBlock}
            <line x1={axisX} y1={baseline} x2={width - RIGHT_PAD} y2={baseline} stroke={LINE_STRONG} strokeWidth={1} />
            {shown.map((s, i) => {
              const isSel = selected.has(s.mask);
              const h = Math.max(4, Math.round((s.nRegions / max) * PLOT_H));
              const fill = s.degree === 1 ? (sets.find((set) => set.id === s.memberIds[0])?.color ?? LINE_STRONG) : LINE_STRONG;
              const x = leftMargin + i * (BAR_W + GAP);
              return (
                <g
                  key={s.mask}
                  className="selectable"
                  style={{ cursor: "pointer" }}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isSel}
                  aria-label={`${s.label}: ${fmt(s.nRegions)} regions, ${bpfmt(s.nBp)}`}
                  onClick={() => toggleSelected(s.mask)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleSelected(s.mask);
                    }
                  }}
                >
                  <title>{`${s.label} — ${fmt(s.nRegions)} regions, ${bpfmt(s.nBp)}`}</title>
                  <text x={x + BAR_W / 2} y={baseline - h - 6} textAnchor="middle" fontSize={11} fontFamily="monospace" fill={INK}>
                    {fitCount(s.nRegions, BAR_W + GAP - 2, BAR_LABEL_FONT_SIZE)}
                  </text>
                  <rect
                    x={x}
                    y={baseline - h}
                    width={BAR_W}
                    height={h}
                    fill={fill}
                    opacity={isSel ? 1 : 0.72}
                    stroke={isSel ? INK : "none"}
                    strokeWidth={isSel ? 1.5 : 0}
                  />
                  {sets.map((set, r) => (
                    <circle
                      key={set.id}
                      cx={x + BAR_W / 2}
                      cy={firstRowY + r * ROW_H}
                      r={DOT_R}
                      fill={s.memberIds.includes(set.id) ? set.color : "#e3e7ee"}
                    />
                  ))}
                </g>
              );
            })}
          </svg>
        </div>
      </div>
      <div className="plotactions">
        <button className="iconbtn" title="Export SVG" onClick={() => ref.current && downloadSvg(ref.current, "intervene-upset.svg")}>
          SVG
        </button>
        <button
          className="iconbtn"
          title="Export PNG"
          onClick={() => ref.current && void downloadPng(ref.current, "intervene-upset.png")}
        >
          PNG
        </button>
      </div>
    </div>
  );
}
