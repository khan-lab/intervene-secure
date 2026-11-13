import { useRef } from "react";
import { useStore } from "../state/store";
import { downloadPng, downloadSvg } from "../lib/exportImage";
import {
  circleBoundaryPoint,
  circleShape,
  ellipseBoundaryPoint,
  ellipseShape,
  farthestBoundaryPoint,
  labelCentroids,
  layoutVenn2,
  layoutVenn3,
  layoutVenn4,
  type CircleSpec,
  type EllipseSpec,
} from "../lib/venn";
import { truncateToWidth } from "../lib/textMeasure";

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

const WIDTH = 450;
const HEIGHT = 340;
const INK = "#101826";
const ACCENT_INK = "#1b32a8";
const PAPER = "#ffffff";
const SET_LABEL_FONT_SIZE = 12;
// Set-name labels sit at a single middle-anchored point outside each
// shape; capped so a long name can't run off the canvas edge, matching
// the truncate-with-ellipsis pattern used elsewhere (UpSetPlot, SetRail).
const SET_LABEL_MAX_W = 100;

export function VennPlot({ svgRef }: { svgRef?: React.RefObject<SVGSVGElement | null> }) {
  const allSets = useStore((s) => s.sets);
  const sets = allSets.filter((x) => x.included);
  const subsets = useStore((s) => s.subsets);
  const selected = useStore((s) => s.selected);
  const toggleSelected = useStore((s) => s.toggleSelected);
  const localRef = useRef<SVGSVGElement | null>(null);
  const ref = svgRef ?? localRef;

  if (sets.length < 2) {
    return (
      <div className="placeholder">
        <div className="big">Load two or more region sets</div>
        <div className="sm">A Venn diagram needs at least two included sets.</div>
      </div>
    );
  }
  if (sets.length > 4) {
    return (
      <div className="placeholder">
        <div className="big">Venn not available above 4 sets</div>
        <div className="sm">
          With {sets.length} sets a Venn layout would be unreadable. Use the UpSet or Table view for an exact
          reading.
        </div>
      </div>
    );
  }

  const byMask = new Map(subsets.map((s) => [s.mask, s]));
  const sumMask = (masks: number[]) => masks.reduce((total, m) => total + (byMask.get(m)?.nRegions ?? 0), 0);

  let circles: CircleSpec[] | null = null;
  let ellipses: EllipseSpec[] | null = null;
  let proportional = true;
  const canvasHeight = HEIGHT;

  if (sets.length === 2) {
    const overlap = sumMask([3]);
    circles = layoutVenn2([sets[0].nRegions, sets[1].nRegions], overlap, WIDTH, canvasHeight);
  } else if (sets.length === 3) {
    const ab = sumMask([3, 7]);
    const ac = sumMask([5, 7]);
    const bc = sumMask([6, 7]);
    circles = layoutVenn3([sets[0].nRegions, sets[1].nRegions, sets[2].nRegions], { ab, ac, bc }, WIDTH, canvasHeight);
  } else {
    ellipses = layoutVenn4(WIDTH, canvasHeight);
    proportional = false;
  }

  const shapes = circles ? circles.map(circleShape) : ellipses!.map(ellipseShape);
  const labels = labelCentroids(shapes, WIDTH, canvasHeight, 170);
  const centers = circles ?? ellipses!;
  const diagramCenter = {
    x: centers.reduce((total, c) => total + c.cx, 0) / centers.length,
    y: centers.reduce((total, c) => total + c.cy, 0) / centers.length,
  };

  return (
    <div className="vennwrap">
      <div className="hint" style={{ marginBottom: 6 }}>
        {proportional
          ? "Circle area is proportional to overlap counts."
          : "4-set layout is not area-proportional."}
      </div>
      <svg
        ref={ref}
        width={WIDTH}
        height={canvasHeight}
        viewBox={`0 0 ${WIDTH} ${canvasHeight}`}
        role="img"
        aria-label="Venn diagram of region set overlaps"
      >
        <rect x={0} y={0} width={WIDTH} height={canvasHeight} fill={PAPER} />
        {circles &&
          circles.map((c, i) => (
            <circle key={sets[i].id} cx={c.cx} cy={c.cy} r={c.r} fill={sets[i].color} fillOpacity={0.32} stroke={INK} strokeWidth={1} />
          ))}
        {ellipses &&
          ellipses.map((e, i) => (
            <ellipse
              key={sets[i].id}
              cx={e.cx}
              cy={e.cy}
              rx={e.rx}
              ry={e.ry}
              transform={`rotate(${e.rot} ${e.cx} ${e.cy})`}
              fill={sets[i].color}
              fillOpacity={0.28}
              stroke={INK}
              strokeWidth={1}
            />
          ))}
        {sets.map((s, i) => {
          const shape = circles ? circles[i] : ellipses![i];
          // Farthest boundary point from the diagram center, not just the
          // direction to the shape's own center — the classic 4-ellipse
          // layout's inner pair shares one center point (differing only
          // in rotation), so a center-to-center direction would place
          // both of their labels on top of each other.
          const boundaryAt = circles
            ? (t: number) => circleBoundaryPoint(shape as CircleSpec, t)
            : (t: number) => ellipseBoundaryPoint(shape as EllipseSpec, t);
          const farPoint = farthestBoundaryPoint(boundaryAt, diagramCenter);
          const dx = farPoint.x - diagramCenter.x;
          const dy = farPoint.y - diagramCenter.y;
          const dist = Math.hypot(dx, dy);
          const [ux, uy] = dist > 1 ? [dx / dist, dy / dist] : [0, -1];
          const labelX = clamp(farPoint.x + ux * 14, 24, WIDTH - 24);
          const labelY = clamp(farPoint.y + uy * 14, 14, canvasHeight - 6);
          return (
            <text key={s.id} x={labelX} y={labelY} textAnchor="middle" fontSize={SET_LABEL_FONT_SIZE} fontFamily="monospace" fill={INK}>
              <title>{s.name}</title>
              {truncateToWidth(s.name, SET_LABEL_MAX_W, SET_LABEL_FONT_SIZE)}
            </text>
          );
        })}
        {[...labels.entries()].map(([mask, pos]) => {
          const subset = byMask.get(mask);
          if (!subset) return null;
          const isSel = selected.has(mask);
          return (
            <text
              key={mask}
              x={pos.x}
              y={pos.y}
              textAnchor="middle"
              fontSize={13}
              fontWeight={isSel ? 700 : 500}
              fill={isSel ? ACCENT_INK : INK}
              className="selectable"
              style={{ cursor: "pointer" }}
              role="button"
              tabIndex={0}
              aria-pressed={isSel}
              aria-label={`${subset.label}: ${fmt(subset.nRegions)} regions`}
              onClick={() => toggleSelected(mask)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleSelected(mask);
                }
              }}
            >
              {fmt(subset.nRegions)}
            </text>
          );
        })}
      </svg>
      <div className="plotactions">
        <button className="iconbtn" title="Export SVG" onClick={() => ref.current && downloadSvg(ref.current, "intervene-venn.svg")}>
          SVG
        </button>
        <button className="iconbtn" title="Export PNG" onClick={() => ref.current && void downloadPng(ref.current, "intervene-venn.png")}>
          PNG
        </button>
      </div>
    </div>
  );
}
