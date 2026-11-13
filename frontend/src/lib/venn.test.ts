import { describe, expect, it } from "vitest";
import {
  circleIntersectionArea,
  solveDistanceForArea,
  layoutVenn2,
  layoutVenn3,
  layoutVenn4,
  labelCentroids,
  circleShape,
  ellipseShape,
  circleBoundaryPoint,
  ellipseBoundaryPoint,
  farthestBoundaryPoint,
} from "./venn";

describe("circleIntersectionArea", () => {
  it("is 0 when circles don't touch", () => {
    expect(circleIntersectionArea(10, 10, 25)).toBe(0);
  });

  it("is the full smaller circle's area when one contains the other", () => {
    const area = circleIntersectionArea(20, 10, 5);
    expect(area).toBeCloseTo(Math.PI * 10 * 10, 5);
  });

  it("is the full circle's area for concentric equal circles (d=0)", () => {
    const area = circleIntersectionArea(10, 10, 0);
    expect(area).toBeCloseTo(Math.PI * 10 * 10, 5);
  });

  it("matches a known half-overlap case symmetrically", () => {
    // Two equal circles, centers separated by exactly one radius: known
    // closed-form area to sanity-check against (standard lens formula).
    const r = 10;
    const d = r;
    const area = circleIntersectionArea(r, r, d);
    const expected = 2 * r * r * Math.acos(d / (2 * r)) - (d / 2) * Math.sqrt(4 * r * r - d * d);
    expect(area).toBeCloseTo(expected, 5);
  });
});

describe("solveDistanceForArea", () => {
  it("round-trips: solving for an area produced by a known distance recovers that distance", () => {
    const r1 = 40;
    const r2 = 30;
    const d = 35;
    const area = circleIntersectionArea(r1, r2, d);
    const solved = solveDistanceForArea(r1, r2, area);
    expect(solved).toBeCloseTo(d, 1);
  });

  it("returns near r1+r2 for a zero target area", () => {
    const solved = solveDistanceForArea(20, 15, 0);
    expect(solved).toBeCloseTo(35, 1);
  });

  it("returns near |r1-r2| for the maximum possible overlap", () => {
    const r1 = 20;
    const r2 = 15;
    const maxArea = Math.PI * Math.min(r1, r2) ** 2;
    const solved = solveDistanceForArea(r1, r2, maxArea);
    expect(solved).toBeCloseTo(5, 1);
  });
});

describe("layoutVenn2", () => {
  it("produces circles with area proportional to input sizes", () => {
    const circles = layoutVenn2([100, 400], 20, 400, 300);
    // set 2 is 4x the size of set 1 -> radius should be 2x (area ~ r^2)
    expect(circles[1].r / circles[0].r).toBeCloseTo(2, 1);
  });

  it("fits within the given canvas bounds", () => {
    const circles = layoutVenn2([100, 100], 30, 400, 300, 20);
    for (const c of circles) {
      expect(c.cx - c.r).toBeGreaterThanOrEqual(-1);
      expect(c.cx + c.r).toBeLessThanOrEqual(401);
      expect(c.cy - c.r).toBeGreaterThanOrEqual(-1);
      expect(c.cy + c.r).toBeLessThanOrEqual(301);
    }
  });
});

describe("layoutVenn3", () => {
  it("produces 3 circles proportional to sizes", () => {
    const circles = layoutVenn3([100, 100, 400], { ab: 10, ac: 10, bc: 10 }, 420, 340);
    expect(circles).toHaveLength(3);
    expect(circles[2].r / circles[0].r).toBeCloseTo(2, 1);
  });

  it("does not produce NaN even for inconsistent (triangle-inequality-violating) pairwise input", () => {
    const circles = layoutVenn3([100, 100, 100], { ab: 5, ac: 90, bc: 90 }, 420, 340);
    for (const c of circles) {
      expect(Number.isFinite(c.cx)).toBe(true);
      expect(Number.isFinite(c.cy)).toBe(true);
      expect(Number.isFinite(c.r)).toBe(true);
    }
  });
});

/**
 * Count 4-connected components per mask value in a sampled grid (flood
 * fill / BFS). Presence alone ("some sample point has this mask") is not
 * enough for a usable Venn diagram: `labelCentroids` places a label at
 * the *average* position of a region's sample points, which lands in
 * empty space if the region is scattered into multiple disconnected
 * pieces — exactly the bug the previous hand-tuned layoutVenn4
 * parameters had (4 of the 15 combinations split into 2-4 pieces each,
 * invisible to a presence-only check but very visible as misplaced
 * labels on screen).
 */
function countConnectedComponentsByMask(shapes: { contains(x: number, y: number): boolean }[], width: number, height: number, n: number): Map<number, number> {
  const grid = new Int32Array(n * n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * width;
    for (let j = 0; j < n; j++) {
      const y = (j / (n - 1)) * height;
      let mask = 0;
      for (let k = 0; k < shapes.length; k++) if (shapes[k].contains(x, y)) mask |= 1 << k;
      grid[i * n + j] = mask;
    }
  }
  const visited = new Uint8Array(n * n);
  const compCountByMask = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const idx = i * n + j;
      const mask = grid[idx];
      if (mask === 0 || visited[idx]) continue;
      const stack = [idx];
      visited[idx] = 1;
      while (stack.length) {
        const cur = stack.pop()!;
        const ci = Math.floor(cur / n);
        const cj = cur % n;
        for (const [ni, nj] of [
          [ci - 1, cj],
          [ci + 1, cj],
          [ci, cj - 1],
          [ci, cj + 1],
        ]) {
          if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
          const nidx = ni * n + nj;
          if (visited[nidx] || grid[nidx] !== mask) continue;
          visited[nidx] = 1;
          stack.push(nidx);
        }
      }
      compCountByMask.set(mask, (compCountByMask.get(mask) ?? 0) + 1);
    }
  }
  return compCountByMask;
}

describe("layoutVenn4 — all 15 combinations must be present AND connected", () => {
  it("every one of the 15 non-empty boolean combinations occurs somewhere in the canvas", () => {
    const width = 400;
    const height = 400;
    const ellipses = layoutVenn4(width, height);
    const shapes = ellipses.map(ellipseShape);
    const centroids = labelCentroids(shapes, width, height, 200);
    for (let mask = 1; mask < 16; mask++) {
      expect(centroids.has(mask), `mask ${mask} should be a non-empty region`).toBe(true);
    }
  });

  it("every combination is a single connected region, not scattered pieces, at the app's actual canvas size", () => {
    // 400x340 matches VennPlot.tsx's WIDTH/HEIGHT. Checked at two
    // resolutions since a Cartesian grid can occasionally clip a single
    // thin-but-connected neck at one specific sampling rate — real
    // disconnection shows up consistently across resolutions, aliasing
    // doesn't.
    for (const n of [150, 450]) {
      const ellipses = layoutVenn4(400, 340);
      const shapes = ellipses.map(ellipseShape);
      const components = countConnectedComponentsByMask(shapes, 400, 340, n);
      for (let mask = 1; mask < 16; mask++) {
        expect(components.get(mask), `mask ${mask} at resolution ${n} should be present`).toBeGreaterThan(0);
        expect(components.get(mask), `mask ${mask} at resolution ${n} should be a single connected region, not split`).toBe(1);
      }
    }
  });
});

describe("labelCentroids", () => {
  it("finds the centroid of two identical non-overlapping circles at their own centers", () => {
    const shapes = [circleShape({ cx: 50, cy: 100, r: 20 }), circleShape({ cx: 150, cy: 100, r: 20 })];
    const centroids = labelCentroids(shapes, 200, 200, 100);
    expect(centroids.get(1)?.x).toBeCloseTo(50, 0);
    expect(centroids.get(2)?.x).toBeCloseTo(150, 0);
    expect(centroids.has(3)).toBe(false); // no overlap between them
  });

  it("finds a combined region for fully overlapping identical circles", () => {
    const shapes = [circleShape({ cx: 100, cy: 100, r: 30 }), circleShape({ cx: 100, cy: 100, r: 30 })];
    const centroids = labelCentroids(shapes, 200, 200, 100);
    expect(centroids.get(3)?.x).toBeCloseTo(100, 0);
    expect(centroids.has(1)).toBe(false);
    expect(centroids.has(2)).toBe(false);
  });
});

describe("circleBoundaryPoint / ellipseBoundaryPoint / farthestBoundaryPoint", () => {
  it("circleBoundaryPoint(t=0) is at the rightmost point of the circle", () => {
    const p = circleBoundaryPoint({ cx: 10, cy: 20, r: 5 }, 0);
    expect(p.x).toBeCloseTo(15, 5);
    expect(p.y).toBeCloseTo(20, 5);
  });

  it("ellipseBoundaryPoint respects rotation", () => {
    // An axis-aligned (rot=0) ellipse at t=0 sits at (cx+rx, cy).
    const unrotated = ellipseBoundaryPoint({ cx: 0, cy: 0, rx: 10, ry: 4, rot: 0 }, 0);
    expect(unrotated.x).toBeCloseTo(10, 5);
    expect(unrotated.y).toBeCloseTo(0, 5);
    // Rotated 90 degrees, the same parametric point moves to (0, rx).
    const rotated = ellipseBoundaryPoint({ cx: 0, cy: 0, rx: 10, ry: 4, rot: 90 }, 0);
    expect(rotated.x).toBeCloseTo(0, 5);
    expect(rotated.y).toBeCloseTo(10, 5);
  });

  it("farthestBoundaryPoint finds the point on a circle diametrically opposite `from`", () => {
    const boundaryAt = (t: number) => circleBoundaryPoint({ cx: 0, cy: 0, r: 10 }, t);
    const far = farthestBoundaryPoint(boundaryAt, { x: -100, y: 0 });
    expect(far.x).toBeCloseTo(10, 0);
    expect(far.y).toBeCloseTo(0, 0);
  });

  it("distinguishes two ellipses that share the same center but differ in rotation", () => {
    // This is exactly the classic 4-ellipse layout's inner pair: same
    // (cx,cy), rotation +45 vs +135 — a naive center-to-center direction
    // would place both labels at the identical spot.
    const e1 = { cx: 0, cy: 0, rx: 20, ry: 8, rot: 45 };
    const e2 = { cx: 0, cy: 0, rx: 20, ry: 8, rot: 135 };
    const from = { x: 0, y: -1000 }; // far above, outside both ellipses
    const far1 = farthestBoundaryPoint((t) => ellipseBoundaryPoint(e1, t), from);
    const far2 = farthestBoundaryPoint((t) => ellipseBoundaryPoint(e2, t), from);
    const dist = Math.hypot(far1.x - far2.x, far1.y - far2.y);
    expect(dist).toBeGreaterThan(5); // meaningfully different positions, not overlapping labels
  });
});
