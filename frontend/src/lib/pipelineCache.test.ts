import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeSubsetsViaBedtools, forgetSet, type PipelineSetInput } from "./pipeline";

/**
 * Cache keying in computeSubsetsViaBedtools: a set's content can change
 * (ENCODE blacklist filter on/off), so results are cached per content key,
 * not per set id. bedtools is replaced by a tiny in-memory stand-in:
 * `sort` returns the mounted text, `intersect -c` counts 1 bp overlaps.
 */

const { fs, calls } = vi.hoisted(() => ({ fs: new Map<string, string>(), calls: [] as string[] }));
vi.mock("./bedtools", () => ({
  reset: vi.fn(async () => {}),
  mount: vi.fn(async (files: { name: string; data: string }[]) => {
    for (const f of files) fs.set(`/shared/data/${f.name}`, f.data);
  }),
  unmount: vi.fn(async (names: string[]) => {
    for (const n of names) fs.delete(`/shared/data/${n}`);
  }),
  exec: vi.fn(async (cmd: string) => {
    calls.push(cmd);
    const rows = (path: string) =>
      fs
        .get(path)!
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split("\t"));
    const sort = cmd.match(/^bedtools sort -i (\S+)$/);
    if (sort) return { stdout: fs.get(sort[1])!, stderr: "" };
    const inter = cmd.match(/^bedtools intersect -a (\S+) -b (\S+) -c$/)!;
    const b = rows(inter[2]);
    const out = rows(inter[1]).map((r) => {
      const n = b.filter((q) => q[0] === r[0] && +q[1] < +r[2] && +r[1] < +q[2]).length;
      return [...r, n].join("\t");
    });
    return { stdout: out.join("\n") + "\n", stderr: "" };
  }),
}));

const file = (text: string) => ({ text: async () => text }) as unknown as File;
const A_ALL = "chr1\t0\t100\nchr1\t1000\t1100\n"; // second region is the "blacklisted" one
const A_FILTERED = "chr1\t0\t100\n";
const B = "chr1\t50\t60\nchr1\t1050\t1060\n";

const run = (aText: string, aKey?: string) => {
  const inputs: PipelineSetInput[] = [
    { id: "set-a", name: "A", file: file(aText), key: aKey },
    { id: "set-b", name: "B", file: file(B) },
  ];
  return computeSubsetsViaBedtools(inputs);
};

describe("computeSubsetsViaBedtools cache keys", () => {
  beforeEach(() => {
    forgetSet("set-a");
    forgetSet("set-b");
    calls.length = 0;
  });

  it("recomputes when the same set id comes with a different content key", async () => {
    const all = await run(A_ALL);
    expect(all.sets[0].nRegions).toBe(2);
    expect(all.subsets.find((s) => s.mask === 0b11)?.nRegions).toBe(2);

    const filtered = await run(A_FILTERED, "set-a~bl-hg38");
    expect(filtered.sets[0].nRegions).toBe(1);
    expect(filtered.subsets.find((s) => s.mask === 0b11)?.nRegions).toBe(1);
    // Subsets still name the set by its id, not its content key.
    expect(filtered.subsets.every((s) => s.memberIds.every((id) => id === "set-a" || id === "set-b"))).toBe(true);
  });

  it("serves both versions from cache afterwards, with no bedtools runs", async () => {
    await run(A_ALL);
    await run(A_FILTERED, "set-a~bl-hg38");
    calls.length = 0;
    expect((await run(A_ALL)).sets[0].nRegions).toBe(2);
    expect((await run(A_FILTERED, "set-a~bl-hg38")).sets[0].nRegions).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("forgetSet drops every version of a set's content", async () => {
    await run(A_ALL);
    await run(A_FILTERED, "set-a~bl-hg38");
    forgetSet("set-a");
    calls.length = 0;
    await run(A_FILTERED, "set-a~bl-hg38");
    expect(calls.some((c) => c.startsWith("bedtools sort"))).toBe(true);
  });
});
