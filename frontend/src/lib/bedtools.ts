import type { AioliExecResult, AioliInstance, AioliMountFile } from "../types/aioli";

/**
 * Thin wrapper around the vendored Aioli/bedtools WebAssembly bundle.
 *
 * All interval arithmetic runs client-side against the real bedtools
 * 2.31.0 binary (biowasm build) so the browser and the CLI agree by
 * construction. See docs/provenance.md for the vendored asset checksums.
 */

const BEDTOOLS_VERSION = "2.31.0";
// Aioli spins up bedtools inside a Worker (via a blob: URL), which has no
// document base URL to resolve relative importScripts() calls against —
// so these must be absolute. Computed lazily (not at module load) so this
// module can be imported outside a browser (e.g. lib/pipeline.ts's pure
// parser is unit-tested under Node in lib/differential.test.ts).
function bedtoolsUrlPrefix(): string {
  return `${window.location.origin}${import.meta.env.BASE_URL}wasm/bedtools`;
}
function aioliScriptUrl(): string {
  return `${window.location.origin}${import.meta.env.BASE_URL}wasm/aioli/aioli.js`;
}

let scriptLoadPromise: Promise<void> | null = null;
let cli: AioliInstance | null = null;
let initPromise: Promise<AioliInstance> | null = null;

function loadAioliScript(): Promise<void> {
  if (window.Aioli) return Promise.resolve();
  if (scriptLoadPromise) return scriptLoadPromise;

  const src = aioliScriptUrl();
  scriptLoadPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load vendored Aioli script from ${src}`));
    document.head.appendChild(script);
  });

  return scriptLoadPromise;
}

/**
 * Initialise (or return the already-initialised) bedtools worker. Safe to
 * call repeatedly; the underlying Aioli instance is memoised.
 */
export async function init(): Promise<AioliInstance> {
  if (cli) return cli;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await loadAioliScript();
    if (!window.Aioli) {
      throw new Error("Aioli did not attach itself to window after script load");
    }

    const instance = new window.Aioli(
      [
        {
          tool: "bedtools",
          version: BEDTOOLS_VERSION,
          urlPrefix: bedtoolsUrlPrefix(),
        },
      ],
      { printInterleaved: false }
    );

    cli = instance;
    return instance;
  })();

  try {
    return await initPromise;
  } catch (err) {
    // Allow a retry on the next call instead of caching the failure.
    initPromise = null;
    throw err;
  }
}

// The Aioli worker keeps one bedtools WASM instance alive and calls its
// Emscripten `callMain()` entry point again for every exec() — cheap, but
// it means bedtools' own internal static/global option-parsing state is
// never reset between commands. Confirmed by direct repro: a `bedtools
// summary` call followed by an unrelated `bedtools closest -d -t all` call
// (real sequence: SummaryPlot then GeneListPanel computing for the same
// selected subset) makes the *second* command misparse its own argv —
// bedtools prints its full usage text and a "-fu or -fd" flag error for
// flags neither call ever passed. It's deterministic (not a race — calls
// are also serialized below to rule that out) and does not self-heal on
// retry within the same worker instance; the only fix available from this
// wrapper's side is detecting the corrupted-output signature and
// recovering by terminating + reinitializing the worker, then remounting
// everything from `mountMirror` before retrying the one failed call.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(run: () => Promise<T>): Promise<T> {
  const result = queue.then(run, run);
  queue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

// name -> data, mirroring every string-backed mount so a corrupted worker
// can be fully reconstructed. Every mount() call site in this app passes
// {name, data: <string>} (never a raw File/FileList/url mount), so this
// covers all of them; anything else is silently not mirrored (recovery
// just won't restore it, since the wrapper has no way to re-read it).
const mountMirror = new Map<string, string>();

function mirrorMounts(files: File[] | FileList | AioliMountFile[] | AioliMountFile): void {
  const list = Array.isArray(files) ? files : files instanceof FileList ? Array.from(files) : [files];
  for (const f of list) {
    if ("data" in f && typeof f.data === "string") mountMirror.set(f.name, f.data);
  }
}

/** Terminate the worker and drop the cached instance so init() starts fresh. */
export async function teardown(): Promise<void> {
  if (cli?.worker) {
    cli.worker.terminate();
  }
  cli = null;
  initPromise = null;
}

async function recoverAndRemount(): Promise<AioliInstance> {
  await teardown();
  const instance = await init();
  const files = [...mountMirror.entries()].map(([name, data]) => ({ name, data }));
  if (files.length) await instance.mount(files);
  return instance;
}

/** True when bedtools printed its own usage/help text instead of running — the corrupted-argv-parsing signature described above. */
function looksCorrupted(result: AioliExecResult): boolean {
  return result.stdout.length === 0 && result.stderr.includes("Usage:") && result.stderr.includes("*****ERROR");
}

/** Mount dropped/selected files (or remote URLs) onto the virtual filesystem. */
export function mount(files: File[] | FileList | AioliMountFile[] | AioliMountFile): Promise<void> {
  return enqueue(async () => {
    const instance = await init();
    await instance.mount(files);
    mirrorMounts(files);
  });
}

/**
 * Replace the worker with a fresh one, remounting everything still in the
 * mirror. The worker reuses a single bedtools instance for every command
 * (see the note above `queue`), and bedtools does not free all of its heap
 * between runs, so WebAssembly memory only ever grows. Measured: after one
 * 5-set computation including ClinVar (338k regions), every later bedtools
 * call in the same worker aborted, even on a 28k-region set, while the same
 * call on a fresh worker succeeded. lib/pipeline.ts calls this at the start
 * of every subset computation — its heaviest workload — so each one begins
 * with an empty heap. Cheap: the wasm binary is already in the HTTP cache.
 */
export function reset(): Promise<void> {
  return enqueue(async () => {
    if (cli) await recoverAndRemount();
  });
}

/**
 * Delete mounted files (by mount name) from the worker's filesystem and from
 * the recovery mirror. Without this every intermediate `intersect` output
 * stays in memory for the life of the page: one 6-set computation mounts
 * 63 masks × up to 5 steps, and after a few large sets the worker runs out
 * of memory and every later bedtools call aborts.
 */
export function unmount(names: string[]): Promise<void> {
  return enqueue(async () => {
    for (const name of names) mountMirror.delete(name);
    if (!cli) return;
    for (const name of names) {
      try {
        await cli.fs.unlink(`/shared/data/${name}`);
      } catch {
        // Already gone (e.g. after a worker recovery) — nothing to free.
      }
    }
  });
}

async function execOnce(instance: AioliInstance, command: string): Promise<AioliExecResult> {
  const result = await instance.exec(command);
  if (typeof result === "string") {
    // Defensive: only happens if printInterleaved somehow ends up true.
    return { stdout: result, stderr: "" };
  }
  return result;
}

/**
 * Run a bedtools command, e.g. `exec("bedtools sort -i /data/foo.bed")`.
 * Returns stdout/stderr separately (printInterleaved is disabled in init()).
 * Calls are serialized against each other and against mount(), and a
 * corrupted-state result is retried once against a freshly recovered
 * worker — see the note above `queue`.
 */
export function exec(command: string): Promise<AioliExecResult> {
  return enqueue(async () => {
    const instance = await init();
    let result: AioliExecResult;
    try {
      result = await execOnce(instance, command);
    } catch {
      // A crashed WebAssembly instance (e.g. out of memory) is unusable — start over once.
      return execOnce(await recoverAndRemount(), command);
    }
    if (!looksCorrupted(result)) return result;
    const fresh = await recoverAndRemount();
    return execOnce(fresh, command);
  });
}
