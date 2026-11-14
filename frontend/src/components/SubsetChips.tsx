import type { ReactNode } from "react";
import { useStore, type View } from "../state/store";
import { Icon } from "./Icon";

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** How to select on each view; the current view's way is listed first. */
const HOW: { view: View; text: ReactNode }[] = [
  { view: "upset", text: <><b>UpSet:</b> click a bar or its column of dots.</> },
  { view: "venn", text: <><b>Venn:</b> click a number inside the diagram.</> },
  { view: "table", text: <><b>Table:</b> click a row.</> },
];

function EmptyHint({ view, hasSubsets }: { view: View; hasSubsets: boolean }) {
  if (!hasSubsets) {
    return <div className="selhint">Nothing selected yet. Load your files or the example data; subsets can then be selected here.</div>;
  }
  const ordered = [...HOW].sort((a, b) => Number(b.view === view) - Number(a.view === view));
  return (
    <div className="selhint">
      <div className="selhint-lead">
        Nothing selected yet. Select one or more intersection subsets to annotate, test for enrichment and export them.
      </div>
      {view === "pairwise" && <div>The pairwise heatmap compares whole sets; switch to UpSet, Venn or Table to select subsets.</div>}
      <ul>
        {ordered.map((h) => (
          <li key={h.view} className={h.view === view ? "here" : undefined}>
            {h.text}
          </li>
        ))}
      </ul>
      <div>Click again to deselect; each click adds a subset, so several can be compared.</div>
    </div>
  );
}

export function SubsetChips({ view }: { view: View }) {
  const subsets = useStore((s) => s.subsets);
  const selected = useStore((s) => s.selected);
  const toggleSelected = useStore((s) => s.toggleSelected);
  const clearSelected = useStore((s) => s.clearSelected);
  const exportSubsetBed = useStore((s) => s.exportSubsetBed);

  const chosen = [...selected].map((m) => subsets.find((s) => s.mask === m)).filter((s) => s !== undefined);

  if (!chosen.length) {
    return <EmptyHint view={view} hasSubsets={subsets.length > 0} />;
  }

  return (
    <div className="chips">
      {chosen.map((s) => (
        <span className="chip on" key={s.mask}>
          {s.label} <span className="mono" style={{ fontSize: 11 }}>{fmt(s.nRegions)}</span>
          <button
            className="x"
            aria-label={`Download ${s.code || s.mask}.bed`}
            title={`Download ${s.code || s.mask}.bed`}
            onClick={() => exportSubsetBed(s.mask)}
          >
            <Icon name="download" size={12} />
          </button>
          <button className="x" aria-label={`Deselect ${s.label}`} onClick={() => toggleSelected(s.mask)}>
            <Icon name="close" size={12} />
          </button>
        </span>
      ))}
      <button className="chip" onClick={clearSelected}>
        Clear all
      </button>
    </div>
  );
}
