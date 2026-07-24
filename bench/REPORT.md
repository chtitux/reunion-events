# PMTiles no-worker loader benchmark — 10 MB archive, served locally

Benchmarks the four loaders in `pmtiles-loaders.ts` for loading a 10 MB PMTiles
archive from a server **with no HTTP range support**. All timings are from the
real loader functions and the real `pmtiles` `FileSource`, run in headless
Chromium 141 (Linux). Reproduce with `node bench/run.mjs`.

- **10 MB** archive of incompressible bytes (like already-gzipped tiles).
- Server on `127.0.0.1` that **ignores `Range` and always returns the full 200
  body** (`accept-ranges: none`, `cache-control: no-store`).
- `cold` = first open, storage empty (download + store). `warm` = subsequent
  open (cache hit; plain-fetch re-downloads). Median of 7 cold / 9 warm reps.
- `slice` = median latency of a random ~4–48 KB `FileSource.getBytes()` read —
  the per-tile access pattern — over 600 reads on the resulting `File`.

## Results

### Profile A — raw loopback (the literal "served locally")

| Loader | cold (median) | warm (median) | slice (median) | slice MB/s |
|---|--:|--:|--:|--:|
| **1. Plain fetch** (no cache) | **18 ms** | 16 ms | 0.60 ms | 37 |
| 2. IndexedDB blob cache | 95 ms | **0.80 ms** | 1.00 ms | 24 |
| 3. Cache Storage API | 170 ms | 1.10 ms | 0.60 ms | 41 |
| 4. OPFS (streamed to disk) | 104 ms | 2.00 ms | 0.90 ms | 27 |

### Profile B — same code, response paced to ~40 Mbit/s

| Loader | cold (median) | warm (median) | slice (median) | slice MB/s |
|---|--:|--:|--:|--:|
| 1. Plain fetch (no cache) | 2111 ms | **2140 ms** (every open) | 0.50 ms | 49 |
| 2. IndexedDB blob cache | 2107 ms | **0.80 ms** | 0.50 ms | 47 |
| 3. Cache Storage API | 2147 ms | 1.20 ms | 0.70 ms | 33 |
| 4. OPFS (streamed to disk) | 2104 ms | 1.10 ms | 0.80 ms | 31 |

## What the numbers say

1. **Tile reads are free in all four.** Every strategy serves a random
   `getBytes` in **0.5–1.0 ms**. A disk-backed OPFS `File` is *not* meaningfully
   slower than an in-memory Blob-backed one here, so the shared tail
   (`FileSource` + `File.slice`) never decides the choice — only the
   acquire/cache behavior does.

2. **On a local server, plain fetch wins the first open.** Re-downloading 10 MB
   over loopback costs ~18 ms — *cheaper* than any cache's one-time store write
   (IndexedDB 95 ms, OPFS 104 ms, Cache Storage 170 ms). You reach the ~1 ms
   warm path only after paying that cold penalty, and on loopback plain fetch's
   "cold" (18 ms) already beats the caches' warm-after-cold total. For a 10 MB
   archive on a local server, **Solution 1 (plain fetch) is both the simplest
   and the fastest** — which matches the file's own header comment.

3. **Caching only pays off when the download isn't free.** Throttle to a
   realistic link and the download dominates (~2.1 s). Plain fetch pays it on
   *every* open; the three caches pay it once, then serve every later open in
   ~1 ms — a **~2000× warm-open speedup**, plus offline support. That is the
   entire case for Solutions 2–4.

4. **Among the caches:** IndexedDB and OPFS have the cheapest cold store-write
   (~95–105 ms); Cache Storage is the most expensive (~170 ms). Warm reads are
   ~1–2 ms for all three. OPFS additionally streams the download straight to
   disk (no whole-file buffer in memory) — invisible in these timings but the
   reason to prefer it as archives grow past tens of MB.

## Recommendation

- **This scenario — 10 MB, local server:** use **Solution 1, plain fetch.**
  Nothing to store, invalidate, or evict, and it's the fastest first open.
- **If opens repeat over a real network, or you need offline:** use **Solution 2,
  IndexedDB** — best all-round cache (cheap cold write, ~1 ms warm, most
  portable). Reach for **Solution 4, OPFS** once archives get large enough that
  buffering the whole blob in memory is a concern.

_Numbers are from one headless-Chromium host and will shift with hardware,
browser, and disk; the ordering and the order-of-magnitude gaps are the durable
takeaways. Full stats (min/median/p95) in `results/results.json`._
