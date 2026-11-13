import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXTERNAL_ANNOTATIONS } from "./externalAnnotations";
import { SUPPORTED_ASSEMBLIES, checkAssembly, normalizeRegionText, parseChromSizes } from "./inputValidation";

/**
 * The registry is hand-maintained and must stay 1:1 with what
 * build_external_annotations.py vendors (a static site can't list its own
 * files). These tests read the real vendored files — no fixtures.
 */

const PUBLIC_DIR = join(__dirname, "../../public");
const available = EXTERNAL_ANNOTATIONS.filter((a) => a.path);
const placeholders = EXTERNAL_ANNOTATIONS.filter((a) => !a.path);

describe("external annotation registry", () => {
  it("has unique ids", () => {
    const ids = EXTERNAL_ANNOTATIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only uses supported assemblies, and every entry has a category", () => {
    for (const a of EXTERNAL_ANNOTATIONS) {
      expect(SUPPORTED_ASSEMBLIES).toContain(a.assembly);
      expect(a.category).toBeTruthy();
    }
  });

  it("lists every vendored external file, and nothing that isn't vendored", () => {
    const vendored = SUPPORTED_ASSEMBLIES.flatMap((asm) => {
      const dir = join(PUBLIC_DIR, "refdata", asm, "external");
      return existsSync(dir)
        ? readdirSync(dir)
            .filter((f) => f.endsWith(".bed"))
            .map((f) => `refdata/${asm}/external/${f}`)
        : [];
    });
    expect(available.map((a) => a.path).sort()).toEqual(vendored.sort());
  });

  it("gives every dataset a 3-letter code that no other dataset on the same assembly uses", () => {
    for (const asm of SUPPORTED_ASSEMBLIES) {
      const codes = EXTERNAL_ANNOTATIONS.filter((a) => a.assembly === asm).map((a) => a.code);
      expect(new Set(codes).size).toBe(codes.length);
      for (const c of codes) expect(c).toMatch(/^[A-Z0-9]{3}$/);
    }
  });

  it("marks placeholders with a reason instead of a file", () => {
    for (const a of placeholders) expect(a.unavailableReason).toBeTruthy();
  });
});

describe.each(available.map((a) => [a.id, a] as const))("%s", (_id, a) => {
  const text = readFileSync(join(PUBLIC_DIR, a.path!), "utf8");
  const parsed = normalizeRegionText(text);
  const sizes = parseChromSizes(readFileSync(join(PUBLIC_DIR, "refdata", a.assembly, `${a.assembly}.chrom.sizes`), "utf8"));

  it("parses with no skipped lines and stays under the browser region limit", () => {
    expect(parsed.nSkipped).toBe(0);
    expect(parsed.nRegions).toBeGreaterThan(0);
  });

  it("fits its own assembly", () => {
    expect(checkAssembly(parsed.extents, sizes)).toMatchObject({ fits: true });
  });

  it("states its region count in the description, matching the file", () => {
    expect(a.description).toContain(parsed.nRegions.toLocaleString("en-US"));
  });
});
