// Minimal stand-in for `maplibre-gl` used only by the benchmark bundle.
// The four loaders import maplibre-gl solely to call `addProtocol`, which is
// irrelevant to what we time (archive acquisition + slice reads) and would
// otherwise drag WebGL into a headless run. Everything else in the loaders —
// the real `pmtiles` PMTiles/FileSource — runs unmodified.
const maplibregl = {
  addProtocol() {},
  removeProtocol() {},
};
export default maplibregl;
