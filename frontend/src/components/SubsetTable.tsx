import { useStore } from "../state/store";
import { Icon } from "./Icon";

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}
function bpfmt(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} Mb`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kb`;
  return `${n} bp`;
}

export function SubsetTable() {
  const subsets = useStore((s) => s.subsets);
  const selected = useStore((s) => s.selected);
  const toggleSelected = useStore((s) => s.toggleSelected);
  const exportSubsetBed = useStore((s) => s.exportSubsetBed);

  if (!subsets.length) {
    return (
      <div className="placeholder">
        <div className="big">Load two or more region sets</div>
        <div className="sm">Every combination of overlap becomes a row here, with exact counts.</div>
      </div>
    );
  }

  return (
    <div style={{ padding: "4px 13px 13px", overflowX: "auto" }}>
      <table className="subtable" aria-label="Intersection subsets — Enter or Space toggles selection">
        <thead>
          <tr>
            <th>Subset</th>
            <th>Members</th>
            <th>Degree</th>
            <th>Regions</th>
            <th>bp</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {subsets.map((s) => (
            <tr
              key={s.mask}
              className={selected.has(s.mask) ? "sel" : ""}
              onClick={() => toggleSelected(s.mask)}
              style={{ cursor: "pointer" }}
              tabIndex={0}
              aria-selected={selected.has(s.mask)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return; // let the download button handle its own keys
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleSelected(s.mask);
                }
              }}
            >
              <td className="mono">{s.code}</td>
              <td>{s.label}</td>
              <td className="mono">{s.degree}</td>
              <td className="mono">{fmt(s.nRegions)}</td>
              <td className="mono">{bpfmt(s.nBp)}</td>
              <td>
                <button
                  className="iconbtn"
                  title={`Download ${s.code || s.mask}.bed`}
                  aria-label={`Download ${s.label} as BED`}
                  onClick={(e) => {
                    e.stopPropagation();
                    exportSubsetBed(s.mask);
                  }}
                >
                  <Icon name="download" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
