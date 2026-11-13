/*
 * Intervene offline service worker.
 *
 * Makes the app usable with no network after the first visit. It never
 * sees user data: uploaded files are read by the page with the File API
 * and never fetched. It only caches this site's own static files, listed
 * with content hashes in offline-manifest.json (written at build time;
 * which files qualify is defined in src/lib/offlineManifest.ts):
 *
 *   shell  cached at install: app, bedtools WebAssembly, examples,
 *          chromosome sizes. Cache name carries the manifest version, so a
 *          new deploy installs a fresh copy and the old one is deleted.
 *   data   per-assembly reference data, cached the first time the app
 *          fetches it (or from the Help page), keyed by content hash, so
 *          unchanged files survive deploys and changed ones are refetched.
 *
 * Navigations are network-first (you get updates when online) and fall
 * back to the cached app. Everything else listed is cache-first. Anything
 * not listed is passed through untouched.
 */

// Replaced with the manifest version at build time (vite.config.ts), so every
// deploy changes this file's bytes and browsers install the new worker.
const VERSION = "__OFFLINE_VERSION__";
const BASE = new URL(self.registration.scope).pathname; // e.g. /intervene-secure/
const MANIFEST = "offline-manifest.json";
const STATE_CACHE = "intervene-state";
const DATA_CACHE = "intervene-data";
const shellCache = (v) => `intervene-shell-${v}`;

let manifestMemo = null;

async function currentManifest() {
  if (manifestMemo) return manifestMemo;
  const state = await caches.open(STATE_CACHE);
  const res = await state.match(BASE + MANIFEST);
  manifestMemo = res ? await res.json() : null;
  return manifestMemo;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const res = await fetch(BASE + MANIFEST, { cache: "no-store" });
      if (!res.ok) throw new Error(`offline manifest: HTTP ${res.status}`);
      const manifest = await res.clone().json();
      if (VERSION !== "__OFFLINE_VERSION__" && manifest.version !== VERSION) {
        // The site was redeployed between this worker's download and now; the next update installs the newer one.
        console.info(`Intervene offline: worker ${VERSION}, manifest ${manifest.version}`);
      }
      const shell = await caches.open(shellCache(manifest.version));
      await shell.addAll(Object.keys(manifest.shell).map((p) => new Request(BASE + p, { cache: "reload" })));
      // Only now, with the shell complete, does this version become current.
      const state = await caches.open(STATE_CACHE);
      await state.put(BASE + MANIFEST, res);
      manifestMemo = manifest;
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const manifest = await currentManifest();
      if (manifest) {
        for (const name of await caches.keys()) {
          if (name.startsWith("intervene-shell-") && name !== shellCache(manifest.version)) await caches.delete(name);
        }
        const wanted = new Set(Object.entries(manifest.data).map(([p, d]) => `${BASE}${p}?v=${d.hash}`));
        const data = await caches.open(DATA_CACHE);
        for (const req of await data.keys()) {
          const u = new URL(req.url);
          if (!wanted.has(u.pathname + u.search)) await data.delete(req);
        }
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;
  const path = url.pathname.slice(BASE.length);
  event.respondWith(respond(req, path));
});

async function respond(req, path) {
  const manifest = await currentManifest();
  if (!manifest) return fetch(req);

  if (req.mode === "navigate" || path === "" || path === "index.html") {
    try {
      return await fetch(req);
    } catch {
      const cached = await caches.match(BASE + "index.html", { cacheName: shellCache(manifest.version) });
      return cached ?? Response.error();
    }
  }

  if (path === MANIFEST) {
    try {
      return await fetch(req, { cache: "no-store" });
    } catch {
      return (await caches.match(BASE + MANIFEST, { cacheName: STATE_CACHE })) ?? Response.error();
    }
  }

  if (path in manifest.shell) {
    const cached = await caches.match(BASE + path, { cacheName: shellCache(manifest.version) });
    return cached ?? fetch(req);
  }

  const data = manifest.data[path];
  if (data) {
    const key = `${BASE}${path}?v=${data.hash}`;
    const cache = await caches.open(DATA_CACHE);
    const cached = await cache.match(key);
    if (cached) return cached;
    const res = await fetch(req);
    if (res.ok) await cache.put(key, res.clone());
    return res;
  }

  return fetch(req);
}
