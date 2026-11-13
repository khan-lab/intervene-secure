/**
 * Heuristic text-width estimate for sizing SVG label columns (e.g.
 * UpSetPlot's set-name column) without a DOM/canvas dependency — this
 * app's plots are pure SVG rendered synchronously, and the test suite
 * runs in Node with no canvas (vitest.config.ts: `environment: "node"`).
 * Not pixel-perfect for a proportional font, but good enough to size a
 * label column to its actual content and decide when to truncate.
 */
const AVG_CHAR_WIDTH_FACTOR = 0.56;

export function estimateTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * AVG_CHAR_WIDTH_FACTOR;
}

/** Trim `text` with a trailing ellipsis until it fits within `maxWidth` at `fontSize`, per estimateTextWidth. */
export function truncateToWidth(text: string, maxWidth: number, fontSize: number): string {
  if (estimateTextWidth(text, fontSize) <= maxWidth) return text;
  const ellipsis = "…";
  let end = text.length;
  while (end > 0 && estimateTextWidth(text.slice(0, end) + ellipsis, fontSize) > maxWidth) {
    end--;
  }
  return end > 0 ? text.slice(0, end) + ellipsis : ellipsis;
}

/** Monospace digits are wider than the proportional average above. */
const MONO_CHAR_WIDTH_FACTOR = 0.62;

function compactCount(n: number): string {
  const trim = (x: string) => x.replace(/\.0$/, "");
  if (n < 1000) return String(n);
  if (n < 10_000) return `${trim((n / 1000).toFixed(1))}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${trim((n / 1e6).toFixed(1))}M`;
}

/**
 * A count label for a fixed-width slot (e.g. an UpSet bar): the full
 * comma-grouped number when it fits `maxWidth` in a monospace font,
 * otherwise a compact form (1.2k, 298k, 1.5M). Callers keep the full number
 * in the tooltip / accessible label.
 */
export function fitCount(n: number, maxWidth: number, fontSize: number): string {
  const full = n.toLocaleString("en-US");
  return full.length * fontSize * MONO_CHAR_WIDTH_FACTOR <= maxWidth ? full : compactCount(n);
}
