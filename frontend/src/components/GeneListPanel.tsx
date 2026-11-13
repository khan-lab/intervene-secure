import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import {
  fetchAndMountGeneTss,
  computeGeneAssociations,
  uniqueGeneNames,
  type RegionGeneAssociation,
} from "../lib/geneList";
import type { SummaryItem } from "./SummaryPlot";
import { Icon } from "./Icon";

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

// Module-level, not component state: this panel unmounts whenever
// `selectedSubsets` empties out or `view` navigates to "summary" (App.tsx
// only renders it when a subset is selected on a non-Summary tab) — see
// the same note in SummaryPlot.tsx/RegionAnnotationPlot.tsx for why a
// plain useRef/useState pair would silently redo the bedtools closest
// call every time.
const geneTssPathCache = new Map<string, string>(); // assembly -> mounted path
const associationsCache = new Map<string, RegionGeneAssociation[]>(); // cacheKey -> associations

/**
 * "Nearest gene by TSS" panel — see lib/geneList.ts's module docstring and
 * docs/methods.md. Same `items: SummaryItem[]` shape as SummaryPlot/
 * RegionAnnotationPlot, so this works unchanged for whole sets or
 * selected subsets depending on what the caller passes in.
 */
export function GeneListPanel({ items }: { items: SummaryItem[] }) {
  const assembly = useStore((s) => s.assembly);
  const geneTssPathRef = useRef(geneTssPathCache);
  const [associationsState, setAssociationsState] = useState<Map<string, RegionGeneAssociation[]>>(
    () => new Map(associationsCache)
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const cacheKey = (item: SummaryItem) => `${assembly}::${item.id}::${item.version}`;
  const itemsKey = items.map((i) => `${i.id}:${i.version}`).join(",");

  useEffect(() => {
    if (items.length < 1) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        let geneTssPath = geneTssPathRef.current.get(assembly);
        if (!geneTssPath) {
          geneTssPath = await fetchAndMountGeneTss(assembly);
          geneTssPathRef.current.set(assembly, geneTssPath);
        }

        for (const item of items) {
          if (cancelled) return;
          const key = cacheKey(item);
          if (associationsCache.has(key)) continue;
          const associations = await computeGeneAssociations(item, geneTssPath);
          if (cancelled) return;
          associationsCache.set(key, associations);
          setAssociationsState((prev) => new Map(prev).set(key, associations));
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // associationsCache (the module-level Map) is read for "already
    // computed?" checks only, see the same note in SummaryPlot.tsx's effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assembly, itemsKey]);

  if (items.length < 1) return null;

  const copyGenes = async (item: SummaryItem, genes: string[]) => {
    try {
      await navigator.clipboard.writeText(genes.join("\n"));
      setCopiedId(item.id);
      setTimeout(() => setCopiedId((id) => (id === item.id ? null : id)), 1500);
    } catch (err) {
      console.warn("Could not copy to clipboard", err);
    }
  };

  const downloadGenes = (item: SummaryItem, genes: string[]) => {
    const blob = new Blob([genes.join("\n") + (genes.length ? "\n" : "")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${item.name}.genes.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      {(error || loading) && (
        <div className="rowsplit" style={{ margin: "0 13px 10px", justifyContent: "flex-end" }}>
          {error ? (
            <span className="hint error" style={{ margin: 0 }}>
              {error}
            </span>
          ) : (
            <span className="hint" style={{ margin: 0 }}>
              finding nearest genes…
            </span>
          )}
        </div>
      )}

      <div className="statcards">
        {items.map((item) => {
          const associations = associationsState.get(cacheKey(item));
          const genes = associations ? uniqueGeneNames(associations) : undefined;
          return (
            <div className="statcard" key={item.id} style={{ flexBasis: 260 }}>
              <div className="statcard-hd">
                <span className="swatch" style={{ background: item.color }} />
                <span>{item.name}</span>
              </div>
              <div className="hint" style={{ margin: "0 0 6px" }}>
                Nearest TSS · protein-coding · no distance cutoff
              </div>
              {!genes ? (
                <div className="mono statcard-body hint">computing…</div>
              ) : (
                <>
                  <div className="mono statcard-body" style={{ marginBottom: 6 }}>
                    {fmt(genes.length)} genes
                  </div>
                  <div className="regions-scroll" style={{ maxHeight: 160 }}>
                    <div className="mono" style={{ padding: "6px 8px", fontSize: 11.5, lineHeight: 1.7 }}>
                      {genes.map((g) => (
                        <div key={g}>{g}</div>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 4, marginTop: 8, justifyContent: "flex-end" }}>
                    <button
                      className="iconbtn"
                      title={copiedId === item.id ? "Copied!" : "Copy gene list to clipboard"}
                      onClick={() => void copyGenes(item, genes)}
                    >
                      <Icon name={copiedId === item.id ? "check" : "copy"} />
                    </button>
                    <button className="iconbtn" title={`Download ${item.name}.genes.txt`} onClick={() => downloadGenes(item, genes)}>
                      <Icon name="download" />
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
