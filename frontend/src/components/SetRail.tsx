import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import type { OverlapPreset } from "../lib/bedtoolsOptions";
import { ANNOTATION_CATEGORIES, EXTERNAL_ANNOTATIONS } from "../lib/externalAnnotations";
import { checkAssembly, fittingAssemblies, type ChromSizes } from "../lib/inputValidation";
import { hasBlacklist } from "../lib/blacklist";
import { MAX_SETS } from "../types";
import { Icon } from "./Icon";

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}
function bpfmt(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} Mb`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kb`;
  return `${n} bp`;
}

const ASSEMBLY_LABELS: Record<string, string> = {
  hg38: "GRCh38/hg38",
  hg19: "GRCh37/hg19",
  mm10: "mm10",
  mm9: "mm9",
};

function pct(n: number, total: number): string {
  if (!total) return "0%";
  const p = (100 * n) / total;
  return p > 0 && p < 0.1 ? "<0.1%" : `${p.toFixed(1)}%`;
}

/** The set card's ENCODE problematic-regions line: a count, or what the filter removed. */
function blacklistLine(s: { id: string; contentKey: string; nRegions: number; blacklistHits: number | null }): string | null {
  if (s.blacklistHits === null) return null;
  const filtered = s.contentKey !== s.id;
  const total = filtered ? s.nRegions + s.blacklistHits : s.nRegions;
  if (!total) return null;
  if (filtered) return `Removed ${fmt(s.blacklistHits)} regions (${pct(s.blacklistHits, total)}) overlapping ENCODE problematic regions`;
  return `${fmt(s.blacklistHits)} regions (${pct(s.blacklistHits, total)}) overlap ENCODE problematic regions`;
}

function listChroms(chroms: string[], max = 4): string {
  return chroms.length <= max ? chroms.join(", ") : `${chroms.slice(0, max).join(", ")} +${chroms.length - max} more`;
}

/** Assembly-mismatch warnings for one set (lib/inputValidation.ts). Empty when it fits, or before chrom.sizes have loaded. */
function assemblyWarnings(extents: Record<string, number>, assembly: string, allSizes: Record<string, ChromSizes>): string[] {
  const sizes = allSizes[assembly];
  if (!sizes) return [];
  const fit = checkAssembly(extents, sizes);
  if (fit.fits) return [];
  const label = ASSEMBLY_LABELS[assembly] ?? assembly;
  const out: string[] = [];
  if (fit.ensemblStyle) {
    out.push(`Chromosome names look Ensembl-style (1, 2, X); ${label} uses chr1, chr2, chrX. It won't overlap sets that use chr names, and Pairwise Fisher/Reldist, Summary and annotation won't work until it's renamed.`);
  } else if (fit.unknownChroms.length) {
    out.push(`${fit.unknownChroms.length} chromosome name(s) not in ${label}: ${listChroms(fit.unknownChroms)}.`);
  }
  if (fit.overflowChroms.length) {
    const others = fittingAssemblies(extents, allSizes).filter((a) => a !== assembly);
    out.push(
      `Coordinates run past the end of ${listChroms(fit.overflowChroms)} in ${label} — this file is probably not ${label}.` +
        (others.length ? ` It fits ${others.map((a) => ASSEMBLY_LABELS[a] ?? a).join(", ")}.` : "")
    );
  }
  return out;
}

/** Rows shown before an annotation group starts scrolling. */
const ANNOTATION_ROWS_VISIBLE = 3;

/**
 * One category of the External annotations card. A group with more than
 * ANNOTATION_ROWS_VISIBLE entries is capped at exactly that many rows and
 * scrolls; the cap is measured from the rendered rows (descriptions wrap to
 * different heights as the rail resizes), not a fixed pixel height.
 */
function AnnotationGroup({ category, count, children }: { category: string; count: number; children: React.ReactNode }) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  const [atEnd, setAtEnd] = useState(false);
  const scrolls = count > ANNOTATION_ROWS_VISIBLE;

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!scrolls || !list) return;
    const measure = () => {
      const last = list.children[ANNOTATION_ROWS_VISIBLE - 1] as HTMLElement | undefined;
      if (last) setMaxHeight(last.offsetTop + last.offsetHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    return () => ro.disconnect();
  }, [scrolls, count]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setAtEnd(el.scrollTop + el.clientHeight >= el.scrollHeight - 2);
  };

  return (
    <div className="annogroup">
      <div className="annogroup-hd">
        <span>{category}</span>
        {scrolls && <span className="annogroup-count">{count}</span>}
      </div>
      <div className={scrolls ? `annogroup-wrap scrolls${atEnd ? " at-end" : ""}` : "annogroup-wrap"}>
        <div
          ref={listRef}
          className="annogroup-list"
          style={scrolls && maxHeight !== undefined ? { maxHeight } : undefined}
          onScroll={scrolls ? onScroll : undefined}
        >
          {children}
        </div>
      </div>
      {scrolls && !atEnd && (
        <div className="annogroup-more" aria-hidden="true">
          Scroll for {count - ANNOTATION_ROWS_VISIBLE} more
        </div>
      )}
    </div>
  );
}

export function SetRail() {
  const sets = useStore((s) => s.sets);
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);
  const usedFallback = useStore((s) => s.usedFallback);
  const fallbackOverlapUnsupported = useStore((s) => s.fallbackOverlapUnsupported);
  const addFiles = useStore((s) => s.addFiles);
  const removeSet = useStore((s) => s.removeSet);
  const renameSet = useStore((s) => s.renameSet);
  const setColor = useStore((s) => s.setColor);
  const resetColor = useStore((s) => s.resetColor);
  const toggleIncluded = useStore((s) => s.toggleIncluded);
  const loadExample = useStore((s) => s.loadExample);
  const overlapPreset = useStore((s) => s.overlapPreset);
  const advancedBedtoolsOptions = useStore((s) => s.advancedBedtoolsOptions);
  const setOverlapPreset = useStore((s) => s.setOverlapPreset);
  const setAdvancedBedtoolsOptions = useStore((s) => s.setAdvancedBedtoolsOptions);
  const assembly = useStore((s) => s.assembly);
  const blacklistFilter = useStore((s) => s.blacklistFilter);
  const setBlacklistFilter = useStore((s) => s.setBlacklistFilter);
  const blacklistAvailable = hasBlacklist(assembly);
  const removedTotal = blacklistFilter && blacklistAvailable ? sets.reduce((n, x) => n + (x.contentKey !== x.id ? (x.blacklistHits ?? 0) : 0), 0) : 0;
  const setAssembly = useStore((s) => s.setAssembly);
  const addExternalAnnotation = useStore((s) => s.addExternalAnnotation);
  const notices = useStore((s) => s.notices);
  const progress = useStore((s) => s.progress);
  const dismissNotices = useStore((s) => s.dismissNotices);
  const chromSizes = useStore((s) => s.chromSizes);

  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Local draft so typing doesn't trigger a bedtools recompute on every
  // keystroke; committed to the store (and recomputed) on blur/Enter.
  const [advancedDraft, setAdvancedDraft] = useState(advancedBedtoolsOptions);
  // Which set's name is currently being edited, and its draft value —
  // renameSet() only commits on blur/Enter, matching the advanced-options
  // field's pattern above.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");

  const startEditing = useCallback((id: string, currentName: string) => {
    setEditingId(id);
    setNameDraft(currentName);
  }, []);

  const commitEditing = useCallback(() => {
    if (editingId) renameSet(editingId, nameDraft);
    setEditingId(null);
  }, [editingId, nameDraft, renameSet]);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragOver(false);
      if (e.dataTransfer.files?.length) void addFiles([...e.dataTransfer.files]);
    },
    [addFiles]
  );

  const onFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files?.length) void addFiles([...e.target.files]);
      e.target.value = "";
    },
    [addFiles]
  );

  // If any set doesn't fit the selected assembly but every set fits one
  // other assembly, offer a one-click switch rather than per-set warnings only.
  const misfit = chromSizes[assembly] ? sets.filter((s) => !checkAssembly(s.extents, chromSizes[assembly]).fits) : [];
  const commonFit = misfit.length
    ? sets
        .map((s) => fittingAssemblies(s.extents, chromSizes))
        .reduce((acc, fits) => acc.filter((a) => fits.includes(a)))
        .filter((a) => a !== assembly)
    : [];
  const suggestedAssembly = commonFit[0];

  return (
    <section className="col" aria-label="Data and parameters">
      <div className="eyebrow" style={{ marginBottom: 10 }}>
        Region sets
      </div>

      {!sets.length && <div className="hint">No sets loaded. Intersections need at least two.</div>}
      {sets.map((s) => (
        <div className={`setcard${s.included ? "" : " off"}`} key={s.id}>
          <input
            type="color"
            className="swatch swatch-input"
            value={s.color}
            title="Change color"
            aria-label={`Color for ${s.name}`}
            onChange={(e) => setColor(s.id, e.target.value)}
          />
          <div style={{ minWidth: 0 }}>
            {editingId === s.id ? (
              <input
                className="nm-edit"
                type="text"
                value={nameDraft}
                autoFocus
                onFocus={(e) => e.target.select()}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitEditing}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setEditingId(null);
                }}
              />
            ) : (
              <div
                className="nm"
                title={`${s.name} — click to rename`}
                role="button"
                tabIndex={0}
                aria-label={`Rename ${s.name}`}
                onClick={() => startEditing(s.id, s.name)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    startEditing(s.id, s.name);
                  }
                }}
              >
                {s.name}
              </div>
            )}
            <div className="st">
              <span className="mono">{fmt(s.nRegions)}</span> regions ·{" "}
              <span className="mono">{bpfmt(s.nBp)}</span> · <span className="code">{s.code}</span>
            </div>
            {blacklistLine(s) && (
              <div className="setinfo" title="Regions overlapping the ENCODE problematic regions (v2, Amemiya et al. 2019) for this assembly by at least 1 bp: areas with anomalous signal in most sequencing experiments">
                {blacklistLine(s)}
              </div>
            )}
            {[...s.warnings, ...assemblyWarnings(s.extents, assembly, chromSizes)].map((w) => (
              <div className="setwarn" key={w}>
                {w}
              </div>
            ))}
          </div>
          <div className="acts">
            {s.color !== s.defaultColor && (
              <button className="iconbtn" title="Reset to default color" aria-label={`Reset color for ${s.name}`} onClick={() => resetColor(s.id)}>
                <Icon name="reset" />
              </button>
            )}
            <button
              className="iconbtn"
              title="Include in intersection"
              aria-label={`Include ${s.name} in intersection`}
              aria-pressed={s.included}
              onClick={() => toggleIncluded(s.id)}
            >
              <Icon name={s.included ? "included" : "excluded"} />
            </button>
            <button className="iconbtn" title="Remove set" aria-label={`Remove ${s.name}`} onClick={() => removeSet(s.id)}>
              <Icon name="close" />
            </button>
          </div>
        </div>
      ))}

      <div
        className={`drop${isDragOver ? " over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
      >
        <div>
          <b>Drop BED files</b> or click to browse
        </div>
        <div style={{ fontSize: 11.5, marginTop: 3 }}>.bed · .narrowPeak · .vcf · .gz · up to {MAX_SETS} sets · 100 MB each</div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".bed,.txt,.vcf,.narrowPeak,.broadPeak,.gz"
          hidden
          onChange={onFileInputChange}
        />
      </div>

      <button className="ghost" style={{ width: "100%", marginTop: 8 }} onClick={() => void loadExample()}>
        Load example data
      </button>

      {notices.length > 0 && (
        <div className="notice" role="alert">
          {notices.map((n) => (
            <div key={n}>{n}</div>
          ))}
          <button className="iconbtn" aria-label="Dismiss" title="Dismiss" onClick={dismissNotices}>
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      {(status === "loading-worker" || status === "running") && (
        <p className="status mono">
          {progress?.label ?? "Working"}
          {progress && progress.total > 0 ? ` (${progress.done}/${progress.total})` : ""}…
        </p>
      )}
      {status === "error" && <p className="status mono error">{error}</p>}
      {usedFallback && (
        <p className="status mono warn">
          WASM bedtools unavailable — using the pure-TS fallback (lib/intervals.ts).
          {fallbackOverlapUnsupported && " The requested overlap setting needs WASM bedtools and isn't available in the fallback; showing 1bp-default results instead."}
        </p>
      )}

      <div className="eyebrow" style={{ margin: "20px 0 6px" }}>
        Genome Parameters
      </div>
      <div className="card">
        <div className="bd" style={{ paddingTop: 4 }}>
          <div className="param">
            <span className="k">Select Assembly</span>
            <select value={assembly} onChange={(e) => setAssembly(e.target.value)}>
              <option value="hg38">GRCh38/hg38</option>
              <option value="mm10">mm10</option>
              <option value="hg19">GRCh37/hg19</option>
              <option value="mm9">mm9</option>
            </select>
          </div>
          {suggestedAssembly && (
            <div className="setwarn" style={{ paddingBottom: 6 }}>
              {misfit.length === sets.length ? "None of your sets fit" : `${misfit.length} of your sets don't fit`}{" "}
              {ASSEMBLY_LABELS[assembly] ?? assembly}; all of them fit {ASSEMBLY_LABELS[suggestedAssembly] ?? suggestedAssembly}.{" "}
              <button className="linkbtn" onClick={() => setAssembly(suggestedAssembly)}>
                Switch to {ASSEMBLY_LABELS[suggestedAssembly] ?? suggestedAssembly}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="eyebrow" style={{ margin: "20px 0 6px" }}>
        External annotations
      </div>
      <div className="card">
        <div className="bd" style={{ paddingTop: 4 }}>
          {ANNOTATION_CATEGORIES.map((category) => {
            const items = EXTERNAL_ANNOTATIONS.filter((a) => a.assembly === assembly && a.category === category);
            if (!items.length) return null;
            return (
              <AnnotationGroup key={category} category={category} count={items.length}>
                {items.map((a) => {
                  const added = sets.some((s) => s.fileName === `${a.id}.bed`);
                  return (
                    <div className="param" key={a.id}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, color: "var(--ink)" }}>
                          {a.name}{" "}
                          <a className="annosrc" href={a.sourceUrl} target="_blank" rel="noreferrer" aria-label={`${a.name} source`}>
                            source
                          </a>
                        </div>
                        <div className="hint" style={{ margin: "2px 0 0" }}>
                          {a.description}
                        </div>
                      </div>
                      {a.path ? (
                        <button
                          className="ghost"
                          style={{ flex: "none" }}
                          disabled={added || sets.length >= MAX_SETS}
                          title={added ? "Already added" : sets.length >= MAX_SETS ? `Up to ${MAX_SETS} sets — remove one first` : `Add ${a.name} as a region set`}
                          aria-label={`Add ${a.name}`}
                          onClick={() => void addExternalAnnotation(a)}
                        >
                          {added ? "Added" : "Add"}
                        </button>
                      ) : (
                        <span className="annosoon">{a.unavailableReason}</span>
                      )}
                    </div>
                  );
                })}
              </AnnotationGroup>
            );
          })}
          {!EXTERNAL_ANNOTATIONS.some((a) => a.assembly === assembly) && (
            <div className="hint">No built-in annotation sets for this assembly yet.</div>
          )}
        </div>
      </div>


      <div className="eyebrow" style={{ margin: "20px 0 6px" }}>
        BEDTools Parameters
      </div>
      <div className="card">
        <div className="bd" style={{ paddingTop: 4 }}>
          <div className="param">
            <span className="k">Minimum overlap</span>
            <select
              value={overlapPreset}
              onChange={(e) => setOverlapPreset(e.target.value as OverlapPreset)}
            >
              <option value="1bp">1 bp</option>
              <option value="fraction50">50 % of region</option>
              <option value="reciprocal50">reciprocal 50 %</option>
            </select>
          </div>
          <div className="param" style={{ flexDirection: "column", alignItems: "stretch", gap: 5 }}>
            <span className="k">
              Advanced bedtools options{" "}
              <span
                className="infoicon"
                title="Same syntax as the Intervene CLI's --bedtools-options: comma-separated key=value pairs passed straight through to every pairwise bedtools intersect call (e.g. f=0.5,r=true). When set, this overrides the Minimum overlap dropdown."
              >
                ⓘ
              </span>
            </span>
            <input
              className="param-text"
              type="text"
              placeholder="e.g. f=0.75,s=true"
              value={advancedDraft}
              onChange={(e) => setAdvancedDraft(e.target.value)}
              onBlur={() => setAdvancedBedtoolsOptions(advancedDraft)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
          </div>
          <div className="param" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
            <label className="checkrow">
              <input
                type="checkbox"
                checked={blacklistFilter && blacklistAvailable}
                disabled={!blacklistAvailable}
                onChange={(e) => setBlacklistFilter(e.target.checked)}
              />
              <span className="k">Exclude ENCODE problematic regions</span>
              <span
                className="infoicon"
                title="Drops every region that overlaps the ENCODE problematic regions (v2, Amemiya et al. 2019) by at least 1 bp from each set before anything is computed, like bedtools intersect -v. Off by default so results match the Intervene command-line tool, which doesn't filter."
              >
                ⓘ
              </span>
            </label>
            <div className="hint" style={{ margin: 0 }}>
              {!blacklistAvailable
                ? `No ENCODE problematic-regions list (v2) exists for ${ASSEMBLY_LABELS[assembly] ?? assembly}.`
                : blacklistFilter
                  ? `On: ${fmt(removedTotal)} regions removed across all sets. Results differ from the command-line tool's defaults.`
                  : "Off: regions are used as given, as in the command-line tool."}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
