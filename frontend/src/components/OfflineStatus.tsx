import { useCallback, useEffect, useState } from "react";
import { assemblyOfflineState, makeAssemblyOffline, offlineReady, offlineSupported, type AssemblyOfflineState } from "../lib/offline";
import { Icon } from "./Icon";

const ASSEMBLIES: [string, string][] = [
  ["hg38", "Human hg38 (GRCh38)"],
  ["hg19", "Human hg19 (GRCh37)"],
  ["mm10", "Mouse mm10 (GRCm38)"],
  ["mm9", "Mouse mm9 (NCBI37)"],
];

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Re-checks readiness when the service worker takes over and when the connection changes. */
function useOfflineState() {
  const [ready, setReady] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    if (!offlineSupported()) return;
    const check = () => void offlineReady().then(setReady);
    const net = () => setOnline(navigator.onLine);
    check();
    navigator.serviceWorker.addEventListener("controllerchange", check);
    void navigator.serviceWorker.ready.then(() => setTimeout(check, 500));
    window.addEventListener("online", net);
    window.addEventListener("offline", net);
    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", check);
      window.removeEventListener("online", net);
      window.removeEventListener("offline", net);
    };
  }, []);
  return { ready, online };
}

/** Header badge: "Works offline" once the app is cached, "Offline" with no connection. */
export function OfflineBadge({ onOpenHelp }: { onOpenHelp: () => void }) {
  const { ready, online } = useOfflineState();
  if (!ready && online) return null;
  return (
    <button
      className={`offlinebadge${online ? "" : " off"}`}
      onClick={onOpenHelp}
      title={
        online
          ? "Intervene is cached in this browser and works with no network connection. Click for details."
          : "No network connection. Intervene is running from this browser's cache; your files never leave it either way."
      }
    >
      <Icon name={online ? "check" : "close"} size={12} />
      {online ? "Works offline" : "Offline"}
    </button>
  );
}

/** Help-page section: status and per-assembly "make available offline". */
export function OfflinePanel() {
  const { ready, online } = useOfflineState();
  const [states, setStates] = useState<Record<string, AssemblyOfflineState | null>>({});
  const [busy, setBusy] = useState<{ assembly: string; done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const entries = await Promise.all(ASSEMBLIES.map(async ([a]) => [a, await assemblyOfflineState(a)] as const));
    setStates(Object.fromEntries(entries));
  }, []);
  useEffect(() => {
    if (ready) void refresh();
  }, [ready, refresh]);

  if (!offlineSupported()) {
    return <p className="hint">Offline mode is available in the published app (not in this development build).</p>;
  }
  if (!ready) {
    return <p className="hint">Preparing offline mode… It is ready after the page has loaded once; reload if this message stays.</p>;
  }

  const download = async (assembly: string) => {
    setError(null);
    setBusy({ assembly, done: 0, total: 0 });
    try {
      await makeAssemblyOffline(assembly, (done, total) => setBusy({ assembly, done, total }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  return (
    <div className="offlinepanel">
      <p>
        <strong>The app itself is cached{online ? "" : " and running offline now"}.</strong> Loading files, intersections, UpSet,
        Venn, Pairwise and exports work with no connection. Reference data (annotation, nearest genes, problematic regions,
        built-in reference sets) is cached per assembly the first time you use it, or all at once here:
      </p>
      <table className="subtable" aria-label="Reference data available offline">
        <tbody>
          {ASSEMBLIES.map(([a, label]) => {
            const s = states[a];
            const complete = s && s.cachedFiles === s.files;
            const mine = busy?.assembly === a;
            return (
              <tr key={a}>
                <td>{label}</td>
                <td className="mono">{s ? `${mb(s.cachedBytes)} of ${mb(s.bytes)}` : "…"}</td>
                <td style={{ textAlign: "right" }}>
                  {complete ? (
                    <span className="setinfo" style={{ margin: 0 }}>
                      Available offline
                    </span>
                  ) : (
                    <button className="ghost" disabled={!online || busy !== null} onClick={() => void download(a)}>
                      {mine ? `Downloading ${busy.done} of ${busy.total}…` : "Make available offline"}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {error && <p className="hint error">{error}</p>}
      <p className="hint">
        To check that nothing is sent anywhere, turn off your network (or use your browser's developer tools → Network →
        Offline), reload, and use Intervene as usual.
      </p>
    </div>
  );
}
