/**
 * entry.ts — browser-side benchmark harness.
 *
 * Bundled by esbuild (maplibre-gl aliased to a stub) and loaded into a headless
 * Chromium page by run.mjs. Exposes `window.__bench(cfg)` which the Playwright
 * driver calls. It exercises the REAL loader functions from ./pmtiles-loaders.ts
 * for the acquisition timings, and the REAL pmtiles FileSource for slice reads.
 */

import { FileSource } from "pmtiles";
import {
  loadViaFetch,
  loadViaIndexedDB,
  loadViaCacheStorage,
  loadViaOPFS,
  requestPersistentStorage,
} from "./pmtiles-loaders";

// Must match the constants inside pmtiles-loaders.ts so we clean up / read back
// the exact same storage locations the loaders write to.
const IDB_NAME = "pmtiles-cache";
const IDB_STORE = "archives";
const CACHE_NAME = "pmtiles-cache";

type StrategyKey = "fetch" | "indexeddb" | "cachestorage" | "opfs";

interface Strategy {
  key: StrategyKey;
  label: string;
  load: (url: string, name: string) => Promise<string>;
  /** Read the cached archive back as a File, the way each strategy stores it. */
  getFile: (url: string, name: string) => Promise<File>;
  /** Wipe this strategy's persisted copy so the next open is a true cold open. */
  clear: (name: string) => Promise<void>;
  /** Where the resulting File's bytes physically live once handed to FileSource. */
  backing: "memory" | "disk" | "network";
}

// ---- storage helpers (mirror the loaders, used only to reset / read back) ----

// NOTE: loadViaIndexedDB never closes its DB connection, so deleteDatabase()
// would deadlock against those leaked connections in a tight benchmark loop.
// Clearing the object store's contents gives an equally "cold" next open
// without touching the database itself.
function clearIdbStore(): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(IDB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(IDB_STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

function idbGetBlob(name: string): Promise<Blob | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(IDB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(IDB_STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(name);
      req.onsuccess = () => {
        resolve(req.result as Blob | undefined);
        db.close();
      };
      req.onerror = () => reject(req.error);
    };
  });
}

async function opfsRemove(name: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(name);
  } catch (err) {
    if ((err as DOMException).name !== "NotFoundError") throw err;
  }
}

const STRATEGIES: Strategy[] = [
  {
    key: "fetch",
    label: "Plain fetch (no cache)",
    backing: "network",
    load: loadViaFetch,
    async getFile(url, name) {
      const blob = await (await fetch(url)).blob();
      return new File([blob], name);
    },
    async clear() {
      /* nothing persisted */
    },
  },
  {
    key: "indexeddb",
    label: "IndexedDB blob cache",
    backing: "memory",
    load: loadViaIndexedDB,
    async getFile(_url, name) {
      const blob = await idbGetBlob(name);
      if (!blob) throw new Error("idb: archive not present");
      return new File([blob], name);
    },
    clear: () => clearIdbStore(),
  },
  {
    key: "cachestorage",
    label: "Cache Storage API",
    backing: "memory",
    load: loadViaCacheStorage,
    async getFile(url, name) {
      const cache = await caches.open(CACHE_NAME);
      const resp = await cache.match(url);
      if (!resp) throw new Error("cache: archive not present");
      return new File([await resp.blob()], name);
    },
    async clear() {
      await caches.delete(CACHE_NAME);
    },
  },
  {
    key: "opfs",
    label: "OPFS (streamed to disk)",
    backing: "disk",
    load: loadViaOPFS,
    async getFile(_url, name) {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(name);
      return handle.getFile();
    },
    clear: (name) => opfsRemove(name),
  },
];

// ---------------------------------------------------------------------------

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: s[0],
    median: q(0.5),
    p95: q(0.95),
    max: s[s.length - 1],
    mean: sum / s.length,
  };
}

const now = () => performance.now();

async function timeCold(strat: Strategy, url: string, name: string, reps: number) {
  const t: number[] = [];
  for (let i = 0; i < reps; i++) {
    await strat.clear(name);
    const start = now();
    await strat.load(url, name); // full download + store + build File
    t.push(now() - start);
  }
  return t;
}

async function timeWarm(strat: Strategy, url: string, name: string, reps: number) {
  await strat.load(url, name); // ensure populated
  const t: number[] = [];
  for (let i = 0; i < reps; i++) {
    const start = now();
    await strat.load(url, name); // cache hit path (fetch: re-downloads)
    t.push(now() - start);
  }
  return t;
}

/**
 * Random-access slice reads through the REAL pmtiles FileSource, reproducing
 * the per-tile access pattern (file.slice(off, off+len).arrayBuffer()). This is
 * where a disk-backed OPFS File can diverge from an in-memory Blob-backed File.
 */
async function timeSlices(file: File, reads: number) {
  const src = new FileSource(file);
  const size = file.size;
  const t: number[] = [];
  let bytes = 0;
  for (let i = 0; i < reads; i++) {
    const len = 4096 + Math.floor(Math.random() * 44000); // ~4–48 KB, tile-ish
    const off = Math.floor(Math.random() * Math.max(1, size - len));
    const start = now();
    const { data } = await src.getBytes(off, len);
    t.push(now() - start);
    bytes += (data as ArrayBuffer).byteLength;
  }
  return { t, bytes };
}

interface BenchConfig {
  url: string;
  name: string;
  fileSize: number;
  coldReps: number;
  warmReps: number;
  sliceReads: number;
}

async function bench(cfg: BenchConfig) {
  const persistent = await requestPersistentStorage();
  const results: any[] = [];

  for (const strat of STRATEGIES) {
    console.log(`strategy ${strat.key}: cold…`);
    await strat.clear(cfg.name); // start clean

    const cold = await timeCold(strat, cfg.url, cfg.name, cfg.coldReps);
    console.log(`strategy ${strat.key}: warm…`);
    const warm = await timeWarm(strat, cfg.url, cfg.name, cfg.warmReps);

    // Slice reads on the File as each strategy hands it to FileSource.
    const file = await strat.getFile(cfg.url, cfg.name);
    const slices = await timeSlices(file, cfg.sliceReads);

    results.push({
      key: strat.key,
      label: strat.label,
      backing: strat.backing,
      cold: stats(cold),
      warm: stats(warm),
      slice: stats(slices.t),
      sliceThroughputMBs: slices.bytes / 1e6 / (slices.t.reduce((a, b) => a + b, 0) / 1000),
    });

    await strat.clear(cfg.name); // leave storage clean for the next strategy
  }

  return {
    persistentStorageGranted: persistent,
    userAgent: navigator.userAgent,
    config: cfg,
    results,
  };
}

(window as any).__bench = bench;
(window as any).__benchReady = true;
