import { useStore } from "../state/store";
import { Icon } from "./Icon";

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export function SubsetChips() {
  const subsets = useStore((s) => s.subsets);
  const selected = useStore((s) => s.selected);
  const toggleSelected = useStore((s) => s.toggleSelected);
  const clearSelected = useStore((s) => s.clearSelected);
  const exportSubsetBed = useStore((s) => s.exportSubsetBed);

  const chosen = [...selected].map((m) => subsets.find((s) => s.mask === m)).filter((s) => s !== undefined);

  if (!chosen.length) {
    return <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>Nothing selected yet.</span>;
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
