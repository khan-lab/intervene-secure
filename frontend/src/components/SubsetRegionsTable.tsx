import type { Subset } from "../types";

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** Scrollable table of a subset's actual genomic regions (chrom/start/end/length), for the Selected subsets detail panel. */
export function SubsetRegionsTable({ subset }: { subset: Subset }) {
  return (
    <div className="regions-scroll">
      <table className="subtable">
        <thead>
          <tr>
            <th>Chrom</th>
            <th>Start</th>
            <th>End</th>
            <th>Length</th>
          </tr>
        </thead>
        <tbody>
          {subset.regions.map((r, i) => (
            <tr key={`${r.chrom}:${r.start}-${r.end}:${i}`}>
              <td className="mono">{r.chrom}</td>
              <td className="mono">{fmt(r.start)}</td>
              <td className="mono">{fmt(r.end)}</td>
              <td className="mono">{fmt(r.end - r.start)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
