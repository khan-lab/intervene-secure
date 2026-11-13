/**
 * Circle/ellipse geometry for the Venn view.
 *
 * 2- and 3-set layouts are area-proportional: each circle's area is
 * proportional to its set's region count, and circle *distance* is solved
 * numerically so the lens (intersection) area matches the real overlap
 * region count. For 3 sets this is the standard "pairwise distance +
 * triangulate" approximation (not every possible size combination has an
 * exact 3-circle solution — see `layoutVenn3`'s doc comment) rather than a
 * full optimizer, which is a deliberate scope trade-off: it is exact for
 * pairwise relationships and visually close for the triple, without a new
 * dependency.
 *
 * 4-set layouts use a fixed, numerically-verified 4-ellipse arrangement
 * (all 15 non-empty combinations proven present by grid sampling — see
 * `frontend/src/lib/venn.test.ts`). Four convex shapes cannot in general
 * be made exactly area-proportional for every combination, so this is
 * explicitly schematic, not proportional — the UI labels it as such.
 */

export interface CircleSpec {
  cx: number;
  cy: number;
  r: number;
}

export interface EllipseSpec {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** rotation in degrees */
  rot: number;
}

export interface Shape {
  contains(x: number, y: number): boolean;
}

export function circleShape(c: CircleSpec): Shape {
  return { contains: (x, y) => (x - c.cx) ** 2 + (y - c.cy) ** 2 <= c.r * c.r };
}

export function ellipseShape(e: EllipseSpec): Shape {
  const rad = (-e.rot * Math.PI) / 180;
  const cosT = Math.cos(rad);
  const sinT = Math.sin(rad);
  return {
    contains: (x, y) => {
      const dx = x - e.cx;
      const dy = y - e.cy;
      const xl = dx * cosT - dy * sinT;
      const yl = dx * sinT + dy * cosT;
      return (xl * xl) / (e.rx * e.rx) + (yl * yl) / (e.ry * e.ry) <= 1;
    },
  };
}

export interface Point {
  x: number;
  y: number;
}

export function circleBoundaryPoint(c: CircleSpec, t: number): Point {
  return { x: c.cx + c.r * Math.cos(t), y: c.cy + c.r * Math.sin(t) };
}

/** Forward rotation (local ellipse point -> world point) — matches the SVG `rotate(e.rot)` transform used to render it. */
export function ellipseBoundaryPoint(e: EllipseSpec, t: number): Point {
  const rad = (e.rot * Math.PI) / 180;
  const lx = e.rx * Math.cos(t);
  const ly = e.ry * Math.sin(t);
  return {
    x: e.cx + lx * Math.cos(rad) - ly * Math.sin(rad),
    y: e.cy + lx * Math.sin(rad) + ly * Math.cos(rad),
  };
}

/**
 * The point on a shape's boundary farthest from `from`, sampled at `n`
 * angles. Used to place a set-name label outside its shape even when two
 * shapes share the same center (as the classic 4-ellipse layout's inner
 * pair does — same (x,y), different rotation only): a direction computed
 * from "shape center minus diagram center" alone would be identical for
 * both and put their labels on top of each other, but the farthest
 * *boundary* point differs because it depends on each ellipse's own
 * rotation, not just its center.
 */
export function farthestBoundaryPoint(boundaryAt: (t: number) => Point, from: Point, n = 72): Point {
  let best = boundaryAt(0);
  let bestDistSq = (best.x - from.x) ** 2 + (best.y - from.y) ** 2;
  for (let i = 1; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    const p = boundaryAt(t);
    const distSq = (p.x - from.x) ** 2 + (p.y - from.y) ** 2;
    if (distSq > bestDistSq) {
      bestDistSq = distSq;
      best = p;
    }
  }
  return best;
}

/** Area of the lens where two circles of radius r1, r2 with center distance d overlap. */
export function circleIntersectionArea(r1: number, r2: number, d: number): number {
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) return Math.PI * Math.min(r1, r2) ** 2;
  const r1sq = r1 * r1;
  const r2sq = r2 * r2;
  const alpha = Math.acos(clamp((d * d + r1sq - r2sq) / (2 * d * r1), -1, 1)) * 2;
  const beta = Math.acos(clamp((d * d + r2sq - r1sq) / (2 * d * r2), -1, 1)) * 2;
  return 0.5 * r1sq * (alpha - Math.sin(alpha)) + 0.5 * r2sq * (beta - Math.sin(beta));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Binary search for the center distance `d` between two circles (radius
 * r1, r2) whose lens area matches `targetArea`. Intersection area is
 * monotonically non-increasing in `d`, so bisection converges reliably.
 */
export function solveDistanceForArea(r1: number, r2: number, targetArea: number): number {
  const maxArea = Math.PI * Math.min(r1, r2) ** 2;
  const target = clamp(targetArea, 0, maxArea);
  let lo = Math.abs(r1 - r2);
  let hi = r1 + r2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const area = circleIntersectionArea(r1, r2, mid);
    if (area > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface FitResult<T extends { cx: number; cy: number }> {
  shapes: T[];
}

/** Uniformly translate + scale a set of circles/ellipses to fit within a canvas, preserving proportions. */
export function fitToCanvas<T extends { cx: number; cy: number }>(
  shapes: T[],
  getRadius: (s: T) => number,
  width: number,
  height: number,
  margin: number
): T[] {
  const minX = Math.min(...shapes.map((s) => s.cx - getRadius(s)));
  const maxX = Math.max(...shapes.map((s) => s.cx + getRadius(s)));
  const minY = Math.min(...shapes.map((s) => s.cy - getRadius(s)));
  const maxY = Math.max(...shapes.map((s) => s.cy + getRadius(s)));
  const bboxW = maxX - minX || 1;
  const bboxH = maxY - minY || 1;
  const targetW = width - margin * 2;
  const targetH = height - margin * 2;
  const scale = Math.min(targetW / bboxW, targetH / bboxH);
  const bcx = (minX + maxX) / 2;
  const bcy = (minY + maxY) / 2;
  const ccx = width / 2;
  const ccy = height / 2;
  return shapes.map((s) => ({
    ...s,
    cx: (s.cx - bcx) * scale + ccx,
    cy: (s.cy - bcy) * scale + ccy,
  }));
}

/** Area-proportional 2-circle layout. Sizes and overlap are region counts (or any consistent area unit). */
export function layoutVenn2(sizes: [number, number], overlap: number, width: number, height: number, margin = 30): CircleSpec[] {
  const maxSize = Math.max(sizes[0], sizes[1], 1);
  const maxRadiusPx = Math.min(width, height) / 2 - margin;
  const scale = maxRadiusPx / Math.sqrt(maxSize / Math.PI);
  const r1 = scale * Math.sqrt(Math.max(sizes[0], 0) / Math.PI);
  const r2 = scale * Math.sqrt(Math.max(sizes[1], 0) / Math.PI);
  const targetAreaPx = overlap * scale * scale;
  const d = solveDistanceForArea(r1, r2, targetAreaPx);
  const raw: (CircleSpec & { r: number })[] = [
    { cx: -d / 2, cy: 0, r: r1 },
    { cx: d / 2, cy: 0, r: r2 },
  ];
  return fitToCanvas(raw, (s) => s.r, width, height, margin);
}

/**
 * Area-proportional-ish 3-circle layout. `pairwise` is the true |A∩B|,
 * |A∩C|, |B∩C| region counts (regardless of the third set — i.e. summed
 * over every subset whose mask includes both members). Circle radii are
 * always exactly proportional to each set's total size. Pairwise
 * distances are each solved exactly for their two-circle overlap, then
 * triangulated by side length — this does not additionally force the
 * *triple* overlap area to match exactly (a true 3-circle solution for
 * an arbitrary triple size does not always exist), so the triple region
 * is visually approximate.
 */
export function layoutVenn3(
  sizes: [number, number, number],
  pairwise: { ab: number; ac: number; bc: number },
  width: number,
  height: number,
  margin = 30
): CircleSpec[] {
  const maxSize = Math.max(...sizes, 1);
  const maxRadiusPx = Math.min(width, height) / 2 - margin - 20;
  const scale = maxRadiusPx / Math.sqrt(maxSize / Math.PI);
  const r = sizes.map((s) => scale * Math.sqrt(Math.max(s, 0) / Math.PI)) as [number, number, number];

  const dAB = solveDistanceForArea(r[0], r[1], pairwise.ab * scale * scale);
  const dAC = solveDistanceForArea(r[0], r[2], pairwise.ac * scale * scale);
  const dBC = solveDistanceForArea(r[1], r[2], pairwise.bc * scale * scale);

  // Place A at origin, B at (dAB, 0), then triangulate C from (dAC, dBC).
  const ax = 0;
  const ay = 0;
  const bx = dAB;
  const by = 0;
  let cx = dAB > 0 ? (dAB * dAB + dAC * dAC - dBC * dBC) / (2 * dAB) : 0;
  let cySq = dAC * dAC - cx * cx;
  if (cySq < 0) cySq = 0; // triangle inequality violated (approximate input) — clamp instead of NaN
  const cy = Math.sqrt(cySq);

  const raw: (CircleSpec & { r: number })[] = [
    { cx: ax, cy: ay, r: r[0] },
    { cx: bx, cy: by, r: r[1] },
    { cx, cy, r: r[2] },
  ];
  return fitToCanvas(raw, (s) => s.r, width, height, margin);
}

/**
 * Classic 4-ellipse Venn layout, ported from the actual, widely-used
 * source: `draw.quad.venn`'s `ellipse.positions` in the VennDiagram R
 * package (Chen & Boutros, "VennDiagram: a package for the generation of
 * highly-customizable Venn and Euler diagrams in R", BMC Bioinformatics
 * 2011) — the origin of this shape as it appears across countless
 * genomics papers. Values below are copied directly (x, y, semi-major a,
 * semi-minor b, rotation-in-degrees, each in a [0,1] unit square). R's
 * grid graphics use a bottom-left, y-up origin; ours (SVG) is top-left,
 * y-down, so `y` and `rotation` are both flipped when mapping in.
 *
 * NOT area proportional; sizes here don't affect the shapes at all.
 *
 * Critical detail verified numerically (grid flood-fill at resolutions
 * from 120 to 900 — see venn.test.ts), not just assumed from the source:
 * these parameters only produce all 15 combinations as *connected* single
 * regions at their natural aspect ratio (~400:450, i.e. noticeably taller
 * than wide) or taller. Squished into a wider-than-tall box, two of the
 * regions pinch into disconnected slivers — which is exactly what this
 * app's previous 400x340 (wider-than-tall) canvas did, and why labels
 * rendered in visibly wrong spots (`labelCentroids` places a label at the
 * *average* of a region's sample points, which lands in the gap between
 * pieces if the region is scattered). So this function fits the diagram
 * into (width, height) via one UNIFORM scale that preserves the verified
 * 400:450 aspect ratio — never stretching x and y independently.
 *
 * The fit is against the ellipses' own tight (rotation-aware) bounding
 * box, not the full 400x450 coordinate square — the R package's own
 * layout leaves a fair amount of dead space inside that square (its
 * label positions span roughly y=0.28-0.77, not the full 0-1), so fitting
 * to the raw square instead of the actual drawn extent left the diagram
 * looking much smaller than the 2/3-set circle views for no reason.
 */
export function layoutVenn4(width: number, height: number, margin = 24): EllipseSpec[] {
  const NATURAL_W = 400;
  const NATURAL_H = 450;

  // x, y, a (semi-major), b (semi-minor), rotation (degrees) — verbatim
  // from VennDiagram::draw.quad.venn's ellipse.positions.
  const rEllipses = [
    { x: 0.65, y: 0.47, a: 0.35, b: 0.2, rot: 45 },
    { x: 0.35, y: 0.47, a: 0.35, b: 0.2, rot: 135 },
    { x: 0.5, y: 0.57, a: 0.33, b: 0.15, rot: 45 },
    { x: 0.5, y: 0.57, a: 0.35, b: 0.15, rot: 135 },
  ];

  // Natural-space ellipse centers/axes (y flipped, rotation flipped —
  // R's y-up sense to our y-down sense), before fitting to the canvas.
  const naturalEllipses = rEllipses.map((e) => ({
    cx: e.x * NATURAL_W,
    cy: (1 - e.y) * NATURAL_H,
    rx: e.a * NATURAL_W,
    ry: e.b * NATURAL_H,
    rot: -e.rot,
  }));

  // Tight rotation-aware bounding box of the union, so the fit uses the
  // diagram's actual drawn extent rather than the whole coordinate square.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const e of naturalEllipses) {
    const rad = (e.rot * Math.PI) / 180;
    const halfW = Math.sqrt((e.rx * Math.cos(rad)) ** 2 + (e.ry * Math.sin(rad)) ** 2);
    const halfH = Math.sqrt((e.rx * Math.sin(rad)) ** 2 + (e.ry * Math.cos(rad)) ** 2);
    minX = Math.min(minX, e.cx - halfW);
    maxX = Math.max(maxX, e.cx + halfW);
    minY = Math.min(minY, e.cy - halfH);
    maxY = Math.max(maxY, e.cy + halfH);
  }
  const bboxW = maxX - minX;
  const bboxH = maxY - minY;
  const bboxCx = (minX + maxX) / 2;
  const bboxCy = (minY + maxY) / 2;

  const scale = Math.min((width - margin * 2) / bboxW, (height - margin * 2) / bboxH);
  const ccx = width / 2;
  const ccy = height / 2;

  return naturalEllipses.map((e) => ({
    cx: ccx + (e.cx - bboxCx) * scale,
    cy: ccy + (e.cy - bboxCy) * scale,
    rx: e.rx * scale,
    ry: e.ry * scale,
    rot: e.rot,
  }));
}

/**
 * For each non-empty combination mask (bit i = inside shapes[i]), the
 * centroid of sampled points that fall in exactly that combination. Used
 * to place subset-count labels without hardcoding per-layout positions.
 * Cheap: a few tens of thousands of point-in-shape tests, run once per
 * render via useMemo.
 */
export function labelCentroids(shapes: Shape[], width: number, height: number, sampleN = 160): Map<number, { x: number; y: number }> {
  const sums = new Map<number, { x: number; y: number; n: number }>();
  for (let i = 0; i <= sampleN; i++) {
    const x = (i / sampleN) * width;
    for (let j = 0; j <= sampleN; j++) {
      const y = (j / sampleN) * height;
      let mask = 0;
      for (let k = 0; k < shapes.length; k++) {
        if (shapes[k].contains(x, y)) mask |= 1 << k;
      }
      if (mask === 0) continue;
      const entry = sums.get(mask) ?? { x: 0, y: 0, n: 0 };
      entry.x += x;
      entry.y += y;
      entry.n += 1;
      sums.set(mask, entry);
    }
  }
  const out = new Map<number, { x: number; y: number }>();
  for (const [mask, e] of sums) out.set(mask, { x: e.x / e.n, y: e.y / e.n });
  return out;
}
