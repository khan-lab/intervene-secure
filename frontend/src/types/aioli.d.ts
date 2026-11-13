// Minimal ambient types for the vendored Aioli UMD bundle
// (frontend/public/wasm/aioli/aioli.js). We don't take the full
// @biowasm/aioli npm dependency because that would pull in its own
// asset-fetch logic; we load the vendored script directly and only
// need the surface area we actually call.

export interface AioliToolConfig {
  tool: string;
  version: string;
  program?: string;
  urlPrefix?: string;
  loading?: "eager" | "lazy";
  reinit?: boolean;
}

export interface AioliExecResult {
  stdout: string;
  stderr: string;
}

export interface AioliMountFile {
  name: string;
  data?: string | Blob;
  url?: string;
}

export interface AioliInstance {
  exec(command: string, args?: string[]): Promise<string | AioliExecResult>;
  mount(
    files: File[] | FileList | AioliMountFile[] | AioliMountFile
  ): Promise<unknown>;
  ls(path: string): Promise<unknown>;
  cd(path: string): Promise<unknown>;
  pwd(): Promise<string>;
  mkdir(path: string): Promise<unknown>;
  download(path: string): Promise<string>;
  fs: {
    unlink(path: string): Promise<unknown>;
    stat(path: string): Promise<unknown>;
  };
  stdin?: string;
  // Aioli spins up a Comlink-wrapped Worker per instance; exposed so we
  // can terminate it explicitly instead of waiting on GC.
  worker?: Worker;
  tools?: unknown[];
}

export interface AioliConstructorOptions {
  printInterleaved?: boolean;
  debug?: boolean;
}

declare global {
  interface Window {
    Aioli?: new (
      tools: (string | AioliToolConfig)[],
      options?: AioliConstructorOptions
    ) => AioliInstance;
  }
}
