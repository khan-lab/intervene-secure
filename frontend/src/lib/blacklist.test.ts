import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BLACKLIST_ASSEMBLIES, BLACKLIST_REGION_COUNTS, blacklistHits, blacklistPath, hasBlacklist, splitByBlacklistHits } from "./blacklist";
import { checkAssembly, normalizeRegionText, parseChromSizes } from "./inputValidation";
import { parseIntersectCounts } from "./pipeline";

/**
 * ENCODE Blacklist v2 (lib/blacklist.ts): the vendored files, the pure
 * split of a set into blacklisted / kept regions, and — against native
 * bedtools on the real ENCODE fixtures — that the split is exactly what
 * `bedtools intersect -v` keeps and `-u` counts.
 */

// Stand-in for the WASM worker, for checking the command blacklistHits runs.
const { calls } = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("./bedtools", () => ({
  mount: vi.fn(async () => {}),
  unmount: vi.fn(async () => {}),
  exec: vi.fn(async (cmd: string) => {
    calls.push(cmd);
    return { stdout: "chr1\t10\t20\t0\nchr1\t100\t200\t2\nchr2\t5\t6\t0\n", stderr: "" };
  }),
}));

const PUBLIC_DIR = join(__dirname, "../../public");
const FIXTURES_DIR = join(__dirname, "../../../tests/fixtures/encode");
const FIXTURES = [
  "heart_h3k27ac_ENCFF059ERB.subsample.bed",
  "lung_h3k27ac_ENCFF314QTE.subsample.bed",
  "liver_h3k27ac_ENCFF805YRQ.subsample.bed",
];

function bedtoolsAvailable(): boolean {
  try {
    execFileSync("bedtools", ["--version"]);
    return true;
  } catch {
    return false;
  }
}
const describeIfBedtools = bedtoolsAvailable() ? describe : describe.skip;

describe("vendored ENCODE blacklist v2 files", () => {
  it("exists for hg38, hg19 and mm10 only — the Boyle lab publishes no v2 list for mm9", () => {
    expect([...BLACKLIST_ASSEMBLIES]).toEqual(["hg38", "hg19", "mm10"]);
    expect(hasBlacklist("mm9")).toBe(false);
    expect(hasBlacklist("hg38")).toBe(true);
  });

  for (const assembly of BLACKLIST_ASSEMBLIES) {
    it(`${assembly}: parses cleanly, has the documented region count, and fits the assembly`, () => {
      const path = join(PUBLIC_DIR, blacklistPath(assembly));
      expect(existsSync(path)).toBe(true);
      const n = normalizeRegionText(readFileSync(path, "utf8"));
      expect(n.nSkipped).toBe(0);
      expect(n.nRegions).toBe(BLACKLIST_REGION_COUNTS[assembly]);
      const sizes = parseChromSizes(readFileSync(join(PUBLIC_DIR, "refdata", assembly, `${assembly}.chrom.sizes`), "utf8"));
      expect(checkAssembly(n.extents, sizes).fits).toBe(true);
    });
  }
});

describe("splitByBlacklistHits", () => {
  const text = "chr1\t10\t20\nchr1\t100\t200\tpeak2\nchr2\t5\t6\n";

  it("keeps regions with no blacklist overlap, in input order, and counts the rest", () => {
    const split = splitByBlacklistHits(text, Uint8Array.from([0, 1, 0]));
    expect(split.nHits).toBe(1);
    expect(split.nKept).toBe(2);
    expect(split.keptText).toBe("chr1\t10\t20\nchr2\t5\t6\n");
  });

  it("returns an empty text when every region is blacklisted", () => {
    expect(splitByBlacklistHits(text, Uint8Array.from([1, 1, 1]))).toEqual({ nHits: 3, nKept: 0, keptText: "" });
  });

  it("refuses a hit array that doesn't line up with the regions", () => {
    expect(() => splitByBlacklistHits(text, Uint8Array.from([0, 1]))).toThrow();
  });
});

describe("blacklistHits", () => {
  it("runs one bedtools intersect -c with plain 1 bp overlap (never the user's overlap options)", async () => {
    calls.length = 0;
    const hits = await blacklistHits("set-1", "chr1\t10\t20\nchr1\t100\t200\nchr2\t5\t6\n", "/shared/data/hg38.blacklist.bed");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^bedtools intersect -a \S+ -b \/shared\/data\/hg38\.blacklist\.bed -c$/);
    expect([...hits]).toEqual([0, 1, 0]);
  });
});

describeIfBedtools("blacklist split vs native bedtools (real ENCODE fixtures, hg38 blacklist v2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "intervene-blacklist-"));
  const bl = join(PUBLIC_DIR, blacklistPath("hg38"));

  for (const name of FIXTURES) {
    it(`${name}: kept regions = intersect -v, count = intersect -u`, () => {
      // Exactly what the app works on: the cleaned upload.
      const clean = normalizeRegionText(readFileSync(join(FIXTURES_DIR, name), "utf8")).bedText;
      const path = join(dir, name);
      writeFileSync(path, clean);
      const run = (...args: string[]) => execFileSync("bedtools", ["intersect", "-a", path, "-b", bl, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });

      const nRegions = clean.split("\n").filter(Boolean).length;
      const split = splitByBlacklistHits(clean, parseIntersectCounts(run("-c"), nRegions));

      expect(split.keptText).toBe(run("-v"));
      expect(split.nHits).toBe(run("-u").split("\n").filter(Boolean).length);
      expect(split.nHits + split.nKept).toBe(nRegions);
      expect(split.nHits).toBeGreaterThan(0); // real peak files do hit the blacklist — the check isn't vacuous
    });
  }
});
