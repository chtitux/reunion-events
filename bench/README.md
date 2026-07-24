# pmtiles-loader-bench

Reproducible benchmark of the four no-worker PMTiles loading strategies in
`pmtiles-loaders.ts`, against a **10 MB archive served locally with no HTTP
range support**.

See **[REPORT.md](./REPORT.md)** for results and the recommendation.

## Run it

```bash
cd bench
npm install            # playwright-core, pmtiles, esbuild
node run.mjs           # ~2–3 min (the throttled profile does ~40 full downloads)
```

Output: a summary table on stdout, live progress in `results/progress.log`, and
full stats in `results/results.json`.

## How it works

- **`pmtiles-loaders.ts`** — the four loaders under test, verbatim.
- **`entry.ts`** — browser harness. Calls the *real* loader functions for the
  cold/warm acquisition timings and the *real* `pmtiles` `FileSource` for the
  random slice (per-tile) reads. `maplibre-gl` is aliased to `stub-maplibre.js`
  at bundle time — the loaders only use it for `addProtocol`, which is
  irrelevant to what's measured and would otherwise drag WebGL into a headless
  run. Nothing else in the loaders is modified.
- **`run.mjs`** — bundles the harness (esbuild), generates the 10 MB archive,
  serves page + bundle + archive from `127.0.0.1` while **ignoring `Range`**
  (always full 200 body), and drives headless Chromium through each loader.

Two server profiles run back to back: raw loopback (the literal "served
locally") and a ~40 Mbit/s throttle, so the results show both the local-only
case and where caching starts to pay off.

Uses the environment's preinstalled Chromium
(`/opt/pw-browsers/chromium-1194/...`); adjust `CHROME` in `run.mjs` elsewhere.
