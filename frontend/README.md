# Intervene: frontend

The browser app (Vite + React + TypeScript). See the
[repository README](../README.md) for what it does, how to run it, and how to
cite it.

```sh
npm ci
npm run dev      # http://localhost:5173/intervene-secure/
npm test         # Vitest
npm run lint     # oxlint
npm run build    # type-check + static build to dist/
```

- `src/lib/`: the bedtools WebAssembly wrapper (`bedtools.ts`), the subset
  pipeline (`pipeline.ts`), pairwise statistics, region annotation and input
  validation. Each module has its tests next to it (`*.test.ts`).
- `src/components/`: one component per view or panel.
- `public/wasm/`: vendored bedtools 2.31.0 + Aioli from biowasm; not built here.
- `public/refdata/`: reference data and the scripts that build it; see
  `../docs/provenance.md`.
