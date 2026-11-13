/**
 * Frontend-only data contracts for Phase 2. These mirror the shapes in
 * PLAN.md §4 (backend/app/schemas.py) where a field applies client-side;
 * they are not yet generated from a shared schema because there is no
 * backend call in this phase (§10 Phase 2 is offline-only).
 */

export interface Interval {
  chrom: string;
  start: number;
  end: number;
}

/** One user-loaded region set (a dropped BED/narrowPeak file). */
export interface RegionSet {
  id: string;
  name: string;
  /** 3-char label used in plots — set identity, carried everywhere. */
  code: string;
  color: string;
  /** The originally auto-assigned palette color, kept so a user-picked color can be reset. */
  defaultColor: string;
  fileName: string;
  fileSizeBytes: number;
  /** Sorted (not merged) regions for this set alone — taken as given. */
  regions: Interval[];
  nRegions: number;
  nBp: number;
  /** Whether this set is included in the current subset computation. */
  included: boolean;
}

/** One combinatorial intersection subset, keyed by membership bitmask. */
export interface Subset {
  /** Bitmask over `RegionSet.id` order at computation time. */
  mask: number;
  memberIds: string[];
  label: string;
  code: string;
  degree: number;
  regions: Interval[];
  nRegions: number;
  nBp: number;
}

/** Most region sets that can be compared at once. */
export const MAX_SETS = 8;

/**
 * One colour per set slot, assigned in this fixed order and never cycled
 * (PALETTE.length >= MAX_SETS; see types.test.ts). In the UpSet matrix every
 * set's colour sits side by side, so the palette was chosen to keep *every*
 * pair apart, not just neighbours: checked with the dataviz skill's
 * validate_palette.js (`--mode light --pairs all`, on #fcfcfb and #ffffff),
 * all checks pass — worst pair under protan/deutan simulation ΔE 8.8
 * (coral/teal; target >= 8), worst pair for normal vision ΔE 17.5 (floor 15),
 * every colour >= 3:1 against the plot background, OKLCH lightness and
 * chroma in band. The previous 6-colour palette failed this: olive #5F7A14
 * and orange #C2611A were ΔE 1.3 apart under protanopia. Slot 1 blue is
 * unchanged. Set names and 3-letter codes always accompany the colour.
 * Light theme only (the app never sets data-theme="dark").
 */
export const PALETTE = [
  "#2B6FE0", // blue
  "#A97416", // ochre
  "#049F80", // teal
  "#6C1BB9", // purple
  "#F8546E", // coral
  "#356312", // green
  "#8D3B63", // mauve
  "#AB78C1", // lilac
];
