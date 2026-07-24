/**
 * run.mjs — benchmark driver.
 *
 *   1. Bundles entry.ts (real loaders + real pmtiles, maplibre stubbed).
 *   2. Generates a 10 MB archive of incompressible bytes.
 *   3. Serves page + bundle + archive from 127.0.0.1 with NO range support
 *      (Range headers are ignored; every archive GET returns the full 200 body).
 *   4. Drives headless Chromium through each loader and collects timings.
 *
 * Two server profiles are exercised:
 *   - "loopback"  : raw localhost throughput (the literal "served locally")
 *   - "40mbit"    : response paced to ~40 Mbit/s, to show where caching pays off
 */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "results");
mkdirSync(outDir, { recursive: true });
const LOG = join(outDir, "progress.log");
writeFileSync(LOG, "");
function log(...a) {
  const line = a.join(" ");
  console.log(line);
  appendFileSync(LOG, line + "\n"); // unbuffered progress, survives block-buffering
}
process.on("uncaughtException", (e) => {
  appendFileSync(LOG, "UNCAUGHT: " + (e.stack || e) + "\n");
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  appendFileSync(LOG, "UNHANDLED: " + ((e && e.stack) || e) + "\n");
  process.exit(1);
});
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ARCHIVE_NAME = "basemap.pmtiles";

const PROFILES = [
  { key: "loopback", label: "Raw loopback", bytesPerSec: 0 },
  { key: "40mbit", label: "~40 Mbit/s throttle", bytesPerSec: (40 * 1_000_000) / 8 },
];

const CONFIG = { coldReps: 7, warmReps: 9, sliceReads: 600 };

// --- 1. bundle the browser harness --------------------------------------------
log("• bundling harness (esbuild)…");
const bundled = await build({
  entryPoints: [join(__dirname, "entry.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  write: false,
  alias: { "maplibre-gl": join(__dirname, "stub-maplibre.js") },
});
const BUNDLE_JS = bundled.outputFiles[0].text;

// --- 2. the 10 MB archive (random => incompressible, like real gzipped tiles) -
log(`• generating ${FILE_SIZE / 1024 / 1024} MB archive…`);
const ARCHIVE = randomBytes(FILE_SIZE);

const PAGE_HTML = `<!doctype html><meta charset=utf-8><title>pmtiles bench</title>
<body><script src="/bundle.js"></script>`;

// --- 3. local server, no range support ----------------------------------------
let currentRate = 0; // bytes/sec; 0 = unthrottled. Mutated per profile.

function serveThrottled(res, buf, bytesPerSec) {
  // Pace the body in chunks so total send time ≈ size / rate. Range is ignored.
  const CHUNK = 64 * 1024;
  const perChunkMs = (CHUNK / bytesPerSec) * 1000;
  let off = 0;
  const pump = () => {
    if (off >= buf.length) return res.end();
    const end = Math.min(off + CHUNK, buf.length);
    res.write(buf.subarray(off, end));
    off = end;
    setTimeout(pump, perChunkMs);
  };
  pump();
}

const server = createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE_HTML);
  } else if (url === "/bundle.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    res.end(BUNDLE_JS);
  } else if (url === "/" + ARCHIVE_NAME) {
    // Deliberately NO range support: never emit 206, advertise none.
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(ARCHIVE.length),
      "accept-ranges": "none",
      "cache-control": "no-store", // force real network each fetch; isolate loader caches
    });
    if (req.method === "HEAD") return res.end();
    if (currentRate > 0) serveThrottled(res, ARCHIVE, currentRate);
    else res.end(ARCHIVE);
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;
log(`• serving at ${origin} (no range support)`);

// --- 4. drive Chromium --------------------------------------------------------
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--no-sandbox"],
});

const runs = {};
try {
  for (const profile of PROFILES) {
    currentRate = profile.bytesPerSec;
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("console", (m) => log("  [page]", m.text()));
    page.on("pageerror", (e) => log("  [pageerror]", e.message));

    log(`\n=== profile: ${profile.label} ===`);
    await page.goto(origin, { waitUntil: "load" });
    await page.waitForFunction("window.__benchReady === true", { timeout: 20000 });

    const result = await page.evaluate(
      (cfg) => window.__bench(cfg),
      {
        url: `${origin}/${ARCHIVE_NAME}`,
        name: ARCHIVE_NAME,
        fileSize: FILE_SIZE,
        ...CONFIG,
      }
    );
    runs[profile.key] = { profile, ...result };
    printProfile(profile, result);
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}

// --- 5. persist -------------------------------------------------------------
const payload = {
  generatedAt: new Date().toISOString(),
  fileSizeBytes: FILE_SIZE,
  archiveName: ARCHIVE_NAME,
  config: CONFIG,
  runs,
};
writeFileSync(join(outDir, "results.json"), JSON.stringify(payload, null, 2));
log(`\n• wrote ${join("bench", "results", "results.json")}`);

// --- helpers ----------------------------------------------------------------
function ms(x) {
  return x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
}
function printProfile(profile, result) {
  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  log(
    `  ${pad("loader", 24)} ${padL("cold(md)", 10)} ${padL("warm(md)", 10)} ` +
      `${padL("slice(md)", 10)} ${padL("slice MB/s", 11)}`
  );
  for (const r of result.results) {
    log(
      `  ${pad(r.label, 24)} ${padL(ms(r.cold.median) + "ms", 10)} ` +
        `${padL(ms(r.warm.median) + "ms", 10)} ${padL(ms(r.slice.median) + "ms", 10)} ` +
        `${padL(r.sliceThroughputMBs.toFixed(1), 11)}`
    );
  }
}
