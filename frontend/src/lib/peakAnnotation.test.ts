import { describe, expect, it, vi } from "vitest";
import {
  ANNO_CATEGORIES,
  ANNOTATE_STEPS_PER_ITEM,
  DISTANCE_BINS,
  annotatePeaks,
  annotationStepTotal,
  bucketDistance,
  parseClosestDistances,
} from "./peakAnnotation";

// Stand-in for the WASM worker (progress-step tests below): every
// intersect/closest returns one real closest line, so each bedtools call
// is counted without running bedtools.
const { execCalls } = vi.hoisted(() => ({ execCalls: [] as string[] }));
vi.mock("./bedtools", () => ({
  mount: vi.fn(async () => {}),
  unmount: vi.fn(async () => {}),
  exec: vi.fn(async (cmd: string) => {
    execCalls.push(cmd);
    return {
      stdout: "chr1\t778470\t778639\tPeak_75098\t58\t.\t3.46069\t5.84601\t3.66472\t134\tchr1\t686653\t686654\t.\t0\t-\t-91817\n",
      stderr: "",
    };
  }),
}));

/**
 * Real captured `bedtools closest -a <peaks> -b <tss_points> -D b -t
 * first` stdout — the first 6 lines (sorted) of the real ENCODE heart
 * H3K27ac fixture against the real hg38 tss_points.bed derived by
 * build_peak_annotation.py (see docs/provenance.md), not synthetic —
 * per CLAUDE.md's fixtures rule.
 */
const REAL_CLOSEST_STDOUT = `chr1\t778470\t778639\tPeak_75098\t58\t.\t3.46069\t5.84601\t3.66472\t134\tchr1\t686653\t686654\t.\t0\t-\t-91817
chr1\t1212680\t1212852\tPeak_56433\t76\t.\t5.27070\t7.63376\t5.33697\t100\tchr1\t1214152\t1214153\t.\t0\t-\t1301
chr1\t1504799\t1504986\tPeak_43941\t94\t.\t4.54215\t9.46317\t7.06110\t77\tchr1\t1512146\t1512147\t.\t0\t+\t-7161
chr1\t1839827\t1839963\tPeak_125155\t35\t.\t3.17060\t3.58338\t1.61197\t43\tchr1\t1840246\t1840247\t.\t0\t-\t284
chr1\t2228763\t2230664\tPeak_13084\t270\t.\t8.65172\t27.08071\t24.01882\t307\tchr1\t2228318\t2228319\t.\t0\t+\t445
chr1\t2545859\t2546147\tPeak_33604\t121\t.\t6.30606\t12.14057\t9.61118\t129\tchr1\t2554243\t2554244\t.\t0\t+\t-8097
`;

describe("parseClosestDistances", () => {
  it("extracts the trailing signed-distance column from real bedtools closest -D b stdout", () => {
    expect(parseClosestDistances(REAL_CLOSEST_STDOUT)).toEqual([-91817, 1301, -7161, 284, 445, -8097]);
  });

  it("ignores blank lines", () => {
    expect(parseClosestDistances("a\tb\t5\n\nc\td\t-3\n")).toEqual([5, -3]);
  });
});

describe("bucketDistance", () => {
  it("buckets the real captured distances into the expected bins", () => {
    expect(bucketDistance(-91817)).toBe(DISTANCE_BINS[1].label);
    expect(bucketDistance(1301)).toBe(DISTANCE_BINS[6].label);
    expect(bucketDistance(-7161)).toBe(DISTANCE_BINS[2].label);
    expect(bucketDistance(284)).toBe(DISTANCE_BINS[5].label);
    expect(bucketDistance(445)).toBe(DISTANCE_BINS[5].label);
    expect(bucketDistance(-8097)).toBe(DISTANCE_BINS[2].label);
  });

  it("handles exact boundary values per the documented (lo, hi] convention", () => {
    expect(bucketDistance(-100000)).toBe(DISTANCE_BINS[0].label); // <= -100000
    expect(bucketDistance(-100001)).toBe(DISTANCE_BINS[0].label);
    expect(bucketDistance(-99999)).toBe(DISTANCE_BINS[1].label); // (-100000,-10000]
    expect(bucketDistance(-10000)).toBe(DISTANCE_BINS[1].label);
    expect(bucketDistance(-9999)).toBe(DISTANCE_BINS[2].label); // (-10000,-5000]
    expect(bucketDistance(-5000)).toBe(DISTANCE_BINS[2].label);
    expect(bucketDistance(-1000)).toBe(DISTANCE_BINS[3].label); // (-5000,-1000]
    expect(bucketDistance(0)).toBe(DISTANCE_BINS[4].label); // (-1000,0]
    expect(bucketDistance(1000)).toBe(DISTANCE_BINS[5].label); // (0,1000]
    expect(bucketDistance(5000)).toBe(DISTANCE_BINS[6].label); // (1000,5000]
    expect(bucketDistance(10000)).toBe(DISTANCE_BINS[7].label); // (5000,10000]
    expect(bucketDistance(100000)).toBe(DISTANCE_BINS[8].label); // (10000,100000]
    expect(bucketDistance(100001)).toBe(DISTANCE_BINS[9].label); // > 100000
  });

  it("has exactly 10 bins covering the full number line with no gaps", () => {
    expect(DISTANCE_BINS).toHaveLength(10);
    for (let d = -200000; d <= 200000; d += 137) {
      expect(() => bucketDistance(d)).not.toThrow();
      expect(DISTANCE_BINS.map((b) => b.label)).toContain(bucketDistance(d));
    }
  });
});

describe("annotation progress steps", () => {
  it("counts one step per reference file to load, and 2 intersects per category + 1 closest per item", () => {
    const files = ANNO_CATEGORIES.filter((c) => c.file).length;
    expect(ANNOTATE_STEPS_PER_ITEM).toBe(2 * files + 1);
    expect(annotationStepTotal(3, false)).toBe(files + 3 * ANNOTATE_STEPS_PER_ITEM);
    expect(annotationStepTotal(3, true)).toBe(3 * ANNOTATE_STEPS_PER_ITEM);
    expect(annotationStepTotal(0, true)).toBe(0);
  });

  it("annotatePeaks reports exactly ANNOTATE_STEPS_PER_ITEM steps, one per bedtools run, with readable labels", async () => {
    execCalls.length = 0;
    const labels: string[] = [];
    const item = { id: "s1", name: "MCF7 only", color: "#000", version: 1, getRawText: async () => "chr1\t1\t2\n" };
    const paths = Object.fromEntries(ANNO_CATEGORIES.filter((c) => c.file).map((c) => [c.key, `/shared/data/${c.file}`]));
    await annotatePeaks(item as never, paths, (label) => labels.push(label));
    expect(labels).toHaveLength(ANNOTATE_STEPS_PER_ITEM);
    expect(execCalls).toHaveLength(ANNOTATE_STEPS_PER_ITEM);
    expect(labels[0]).toBe("MCF7 only: TSS");
    expect(labels.at(-1)).toBe("MCF7 only: distance to nearest TSS");
  });
});
