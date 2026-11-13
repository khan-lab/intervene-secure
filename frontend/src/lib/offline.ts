import type { OfflineManifest } from "./offlineManifest";

/**
 * Page side of offline mode (service worker: public/sw.js). Registration
 * happens only in production builds; in `vite dev` there is no manifest and
 * every function here reports "not available".
 */

const BASE = import.meta.env.BASE_URL;
const DATA_CACHE = "intervene-data";
const STATE_CACHE = "intervene-state";

export function offlineSupported(): boolean {
  return import.meta.env.PROD && "serviceWorker" in navigator && "caches" in window;
}

export function registerServiceWorker(): void {
  if (!offlineSupported()) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE }).catch((err) => console.warn("Offline mode unavailable:", err));
  });
}

/** True once the app shell is cached and this page is served by the service worker. */
export async function offlineReady(): Promise<boolean> {
  if (!offlineSupported() || !navigator.serviceWorker.controller) return false;
  return (await getManifest()) !== null;
}

/** The manifest the service worker installed (works offline). */
export async function getManifest(): Promise<OfflineManifest | null> {
  if (!offlineSupported()) return null;
  try {
    const cached = await caches.match(`${BASE}offline-manifest.json`, { cacheName: STATE_CACHE });
    return cached ? ((await cached.json()) as OfflineManifest) : null;
  } catch {
    return null;
  }
}

export interface AssemblyOfflineState {
  files: number;
  cachedFiles: number;
  bytes: number;
  cachedBytes: number;
}

function dataFiles(manifest: OfflineManifest, assembly: string) {
  return Object.entries(manifest.data).filter(([, d]) => d.assembly === assembly);
}

export async function assemblyOfflineState(assembly: string): Promise<AssemblyOfflineState | null> {
  const manifest = await getManifest();
  if (!manifest) return null;
  const cache = await caches.open(DATA_CACHE);
  const state: AssemblyOfflineState = { files: 0, cachedFiles: 0, bytes: 0, cachedBytes: 0 };
  for (const [path, d] of dataFiles(manifest, assembly)) {
    state.files++;
    state.bytes += d.bytes;
    if (await cache.match(`${BASE}${path}?v=${d.hash}`)) {
      state.cachedFiles++;
      state.cachedBytes += d.bytes;
    }
  }
  return state;
}

/**
 * Fetch every reference file of an assembly that isn't cached yet; the
 * service worker stores each response. Also asks the browser to keep the
 * cache (persistent storage), so it isn't evicted under storage pressure.
 */
export async function makeAssemblyOffline(assembly: string, onProgress: (done: number, total: number) => void): Promise<void> {
  const manifest = await getManifest();
  if (!manifest) throw new Error("Offline mode is not active yet. Reload the page once and try again.");
  void navigator.storage?.persist?.();
  const cache = await caches.open(DATA_CACHE);
  const todo: string[] = [];
  for (const [path, d] of dataFiles(manifest, assembly)) if (!(await cache.match(`${BASE}${path}?v=${d.hash}`))) todo.push(path);
  let done = 0;
  onProgress(done, todo.length);
  for (const path of todo) {
    const res = await fetch(`${BASE}${path}`);
    if (!res.ok) throw new Error(`Could not download ${path}`);
    await res.arrayBuffer(); // the service worker caches it on the way through
    onProgress(++done, todo.length);
  }
}
