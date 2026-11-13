import { useStore } from "../state/store";

export interface ComputeProgress {
  done: number;
  total: number;
  label: string;
  /** What `done`/`total` count; "bedtools steps" when omitted. */
  unit?: string;
}

/**
 * The "working" overlay: spinner, current step, and a progress bar of
 * finished bedtools steps. Drawn inside a positioned container whose other
 * children are dimmed while it shows (`.plotcard.busy`, `.annowrap.busy`
 * in App.css), so the previous result stays visible until the new one lands.
 */
export function ComputeOverlay({ label, progress }: { label: string; progress?: ComputeProgress | null }) {
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null;
  return (
    <div className="computing" role="status" aria-live="polite">
      <div className="computing-box">
        <span className="spinner" aria-hidden="true" />
        <div style={{ minWidth: 0 }}>
          <div className="computing-label">{label}…</div>
          {pct !== null && progress ? (
            <>
              <div className="progressbar" aria-hidden="true">
                <div style={{ width: `${pct}%` }} />
              </div>
              <div className="computing-sub">
                <span className="mono">
                  {Math.floor(progress.done)} of {progress.total}
                </span>{" "}
                {progress.unit ?? "bedtools steps"} · running in your browser
              </div>
            </>
          ) : (
            <div className="computing-sub">Running in your browser — nothing is uploaded</div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Overlay shown on the plot card while files are read or overlaps are
 * computed. Progress comes from lib/pipeline.ts: one step per bedtools sort
 * or pairwise comparison still to run.
 */
export function ComputeStatus() {
  const status = useStore((s) => s.status);
  const progress = useStore((s) => s.progress);
  if (status !== "loading-worker" && status !== "running") return null;
  const label = progress?.label ?? (status === "loading-worker" ? "Starting bedtools" : "Computing overlaps");
  return <ComputeOverlay label={label} progress={progress} />;
}
