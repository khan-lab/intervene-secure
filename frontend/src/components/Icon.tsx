/**
 * Small line icons for icon buttons. Inline SVG instead of text glyphs
 * (⬇ ◉ ○ ⧉ ✕ ↺ ✓): each glyph sits on its font's baseline with its own side
 * bearings, so no CSS centres them consistently. Every icon here is drawn on
 * the same 16×16 grid, centred, and inherits the button's text colour.
 */
export type IconName = "download" | "copy" | "check" | "close" | "reset" | "included" | "excluded";

const PATHS: Record<IconName, React.ReactNode> = {
  download: (
    <>
      <path d="M8 2.5v8" />
      <path d="M4.5 7.5 8 11l3.5-3.5" />
      <path d="M3 13.5h10" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5v-.5a1 1 0 0 0-1-1H4a1.5 1.5 0 0 0-1.5 1.5v5.5a1 1 0 0 0 1 1h.5" />
    </>
  ),
  check: <path d="m3.5 8.5 3 3 6-7" />,
  close: (
    <>
      <path d="m4 4 8 8" />
      <path d="m12 4-8 8" />
    </>
  ),
  reset: (
    <>
      <path d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2" />
      <path d="M3.5 2.5v2.8h2.8" />
    </>
  ),
  included: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="2.75" fill="currentColor" stroke="none" />
    </>
  ),
  excluded: <circle cx="8" cy="8" r="5.5" />,
};

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
