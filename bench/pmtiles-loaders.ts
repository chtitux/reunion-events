/**
 * pmtiles-loaders.ts
 *
 * Four no-worker strategies for loading a PMTiles archive into MapLibre GL JS
 * when the server does NOT support HTTP range requests.
 *
 * All four converge on the same tail:
 *   obtain the whole archive as a `File` -> `new FileSource(file)` -> register
 *   the resulting `PMTiles` instance with the protocol. `File.slice()` reads are
 *   lazy, so even though the whole file lives in storage, only the byte ranges
 *   pmtiles asks for are materialized per tile.
 *
 * Pick ONE loader. Each returns the `url` string you pass to MapLibre's
 * addSource({ type: "vector", url }).
 *
 *   import maplibregl from "maplibre-gl";
 *   const url = await loadViaFetch("/tiles/basemap.pmtiles", "basemap.pmtiles");
 *   map.addSource("basemap", { type: "vector", url });
 *   map.addLayer({ id: "roads", type: "line", source: "basemap",
 *                  "source-layer": "roads", paint: { "line-color": "#888" } });
 *
 * Requires: npm i pmtiles maplibre-gl   (tested against pmtiles v3.x)
 */

import { PMTiles, FileSource, Protocol } from "pmtiles";
import maplibregl from "maplibre-gl";

// ---------------------------------------------------------------------------
// Shared protocol setup + registration
// ---------------------------------------------------------------------------

// One Protocol per page session. addProtocol wires "pmtiles://" URLs to it.
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

/**
 * Wrap a File in a FileSource, register the archive with the protocol, and
 * return the MapLibre source URL to use.
 *
 * IMPORTANT: FileSource.getKey() returns the File's `name`, and the protocol
 * looks archives up by that key. So the MapLibre source `url` must be
 * `pmtiles://<file.name>` — which is exactly what this returns. Keep the name
 * stable and unique per archive.
 */
function registerArchive(file: File): string {
  const archive = new PMTiles(new FileSource(file));
  protocol.add(archive); // reuse THIS instance instead of creating a FetchSource
  return `pmtiles://${file.name}`;
}

/** Small helper: fetch the whole archive as a Blob, throwing on non-2xx. */
async function fetchWholeArchive(url: string): Promise<Blob> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${url}: ${resp.status} ${resp.statusText}`);
  }
  return resp.blob();
}

/**
 * Optional: ask the browser to make this origin's storage persistent so the
 * cached copy (IndexedDB / Cache Storage / OPFS) isn't evicted under storage
 * pressure. Safe to call once at startup. No-op for the plain-fetch loader.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (navigator.storage?.persist) {
    return navigator.storage.persist();
  }
  return false;
}

// ===========================================================================
// SOLUTION 1 — Plain fetch every open (no persistence)
// ===========================================================================
// Downloads the whole file on every app open. Simplest possible; nothing to
// store, invalidate, or evict. Best for small archives (~10 MB) on a local
// server, where the download is effectively instant.

export async function loadViaFetch(url: string, name: string): Promise<string> {
  const blob = await fetchWholeArchive(url);
  const file = new File([blob], name);
  return registerArchive(file);
}

// ===========================================================================
// SOLUTION 2 — IndexedDB blob cache
// ===========================================================================
// First open fetches + stores the Blob; later opens read it back, no
// re-download, works offline. Most portable "cache once" path, no worker.

const IDB_NAME = "pmtiles-cache";
const IDB_STORE = "archives";

function openArchiveDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<Blob | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result as Blob | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, blob: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadViaIndexedDB(url: string, name: string): Promise<string> {
  const db = await openArchiveDB();
  let blob = await idbGet(db, name);
  if (!blob) {
    blob = await fetchWholeArchive(url);
    await idbPut(db, name, blob); // structured-clone write, one-time cost
  }
  const file = new File([blob], name);
  return registerArchive(file);
}

// ===========================================================================
// SOLUTION 3 — Cache Storage API (no Service Worker)
// ===========================================================================
// `window.caches` is usable directly from the page — no SW needed. Cleanest
// "store the HTTP response" model; upgrades naturally if you later add a SW.

const CACHE_NAME = "pmtiles-cache";

export async function loadViaCacheStorage(url: string, name: string): Promise<string> {
  const cache = await caches.open(CACHE_NAME);
  let resp = await cache.match(url);
  if (!resp) {
    // cache.add fetches and stores in one step; then re-read it back out.
    await cache.add(url);
    resp = await cache.match(url);
    if (!resp) throw new Error(`Cache miss after add for ${url}`);
  }
  if (!resp.ok) throw new Error(`Cached response not ok: ${resp.status}`);
  const blob = await resp.blob();
  const file = new File([blob], name);
  return registerArchive(file);
}

// ===========================================================================
// SOLUTION 4 — OPFS via the async main-thread API (no worker)
// ===========================================================================
// Highest storage ceiling; streams the download straight to disk on first
// write (no whole-file buffer in memory). Uses only async main-thread OPFS
// calls — createSyncAccessHandle() (the worker-only one) is NOT used.

export async function loadViaOPFS(url: string, name: string): Promise<string> {
  const root = await navigator.storage.getDirectory();

  let handle: FileSystemFileHandle;
  try {
    // Throws NotFoundError if we haven't cached it yet.
    handle = await root.getFileHandle(name);
  } catch (err) {
    if ((err as DOMException).name !== "NotFoundError") throw err;

    // Not cached: create the file and stream the response body into it.
    handle = await root.getFileHandle(name, { create: true });
    const resp = await fetch(url);
    if (!resp.ok || !resp.body) {
      throw new Error(`Failed to fetch ${url}: ${resp.status}`);
    }
    const writable = await handle.createWritable();
    await resp.body.pipeTo(writable); // streams to disk, closes on completion
  }

  const file = await handle.getFile(); // async, main-thread-safe
  return registerArchive(file);
}
