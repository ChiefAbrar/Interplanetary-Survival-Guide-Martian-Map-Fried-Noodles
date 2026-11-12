import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createLruCache, detailMatrixIndex, MarsGlobe } from "../public/js/mars-globe.js";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("globe matrix selection reaches only matrices advertised by WMTS", () => {
  const matrices = Array.from({ length: 8 }, (_, index) => ({ identifier: String(index) }));
  assert.equal(detailMatrixIndex(matrices, 3.2), 5);
  assert.equal(detailMatrixIndex(matrices, 1.22), 7);
  assert.equal(detailMatrixIndex(matrices.slice(0, 6), 1.22), 5);
  assert.equal(detailMatrixIndex([], 1.22), 0);
});

test("decoded globe image cache is bounded LRU", () => {
  const cache = createLruCache(2);
  cache.set("a", 1).set("b", 2);
  assert.equal(cache.get("a"), 1); // promote a; b is least recently used
  cache.set("c", 3);
  assert.equal(cache.has("a"), true);
  assert.equal(cache.has("b"), false);
  assert.equal(cache.size, 2);
});

test("cancelled globe flights settle and a replacement flight owns the camera", async () => {
  const previousRaf = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  let nextId = 0;
  globalThis.requestAnimationFrame = () => ++nextId;
  globalThis.cancelAnimationFrame = () => {};
  try {
    const globe = Object.create(MarsGlobe.prototype);
    Object.assign(globe, { yaw: 0, pitch: 0, distance: 3.2, flyAnimFrameId: null, flyCancel: null,
      longitude: 0, latitude: 0, draw() {}, scheduleTiles() {} });
    const first = globe.flyTo(77.4, 18.4, 500, 1.45);
    const second = globe.flyTo(77.4, 18.4, 500, 3.2);
    assert.equal(await first, false);
    globe.flyCancel();
    assert.equal(await second, false);
    assert.equal(globe.flyAnimFrameId, null);
  } finally {
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = previousRaf;
    if (previousCancel === undefined) delete globalThis.cancelAnimationFrame; else globalThis.cancelAnimationFrame = previousCancel;
  }
});

test("globe camera flight settles normally and rejects when rendering throws", async () => {
  const previousRaf = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  let callback = null;
  globalThis.requestAnimationFrame = fn => { callback = fn; return 1; };
  globalThis.cancelAnimationFrame = () => {};
  try {
    const globe = Object.create(MarsGlobe.prototype);
    Object.assign(globe, { yaw: 0, pitch: 0, distance: 3.2, longitude: 0, latitude: 0,
      contextLost: false, disposed: false, flyAnimFrameId: null, flyCancel: null, draw() {}, scheduleTiles() {} });
    const done = globe.flyTo(77.4, 18.4, 400, 1.45);
    callback(performance.now() + 401);
    assert.equal(await done, true);

    globe.draw = () => { throw new Error("mock rendering failure"); };
    const failed = globe.flyTo(77.4, 18.4, 400, 1.45);
    callback(performance.now() + 401);
    await assert.rejects(failed, /mock rendering failure/);
    assert.equal(globe.flyAnimFrameId, null);
  } finally {
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = previousRaf;
    if (previousCancel === undefined) delete globalThis.cancelAnimationFrame; else globalThis.cancelAnimationFrame = previousCancel;
  }
});

test("globe keeps fallback startup independent of remote capabilities and avoids duplicate tile fetch", () => {
  const globe = read("../public/js/mars-globe.js");
  const app = read("../public/js/app.js");
  const loadImage = globe.slice(globe.indexOf("  loadImage(url)"), globe.indexOf("  async putBase"));
  assert.match(globe, /async start\(\{ active = true \} = \{\}\)/);
  assert.match(globe, /this\.startAnimationLoop\(\);\s*this\.draw\(\);\s*if \(this\.imageryEnabled\) void this\.loadCapabilities\(\)/);
  assert.doesNotMatch(loadImage, /fetch\(url/);
  assert.match(globe, /createLruCache\(48\)/);
  assert.match(app, /globe\.start\(\{ active: currentPage !== "jezero" \}\)/);
  assert.match(app, /if \(!isGlobe && state\.terrainSource !== "ctx" && !terrainCache\[state\.terrainSource\]\)\s+void loadTerrainSource\(state\.terrainSource\)/);
  assert.doesNotMatch(app, /runImport\(\(\) => fetchTile\(currentPage === "jezero"/);
  assert.doesNotMatch(app, /new Promise\(resolve => requestAnimationFrame\(resolve\)\)/);
  assert.match(app, /await flyPromise/);
  assert.match(app, /document\.addEventListener\("visibilitychange"/);
  assert.match(app, /globe\.cancelFlyTo\(\)/);
  assert.match(globe, /webglcontextlost/);
  assert.match(globe, /webglcontextrestored/);
  const transition = app.slice(app.indexOf("async function setMapView"), app.indexOf('$("view-globe").addEventListener'));
  assert.doesNotMatch(transition, /cancelManualRouteDrawing|state\.routes\s*=|state\.manualRoute\s*=/);
});

test("regional map contains the original USGS visualization without claiming DEM registration", () => {
  const app = read("../public/js/app.js");
  const css = read("../public/css/app.css");
  assert.match(app, /images\/jezero-usgs-ctx-dem\.jpg/);
  assert.match(app, /Image-to-planner registration is unverified/);
  assert.match(app, /USGS visualization is not registered to planner coordinates/);
  assert.match(css, /\.regional-photo[^\n]*object-fit: contain/);
  const sampler = read("../public/js/ctx-terrain-sampler.js");
  assert.match(sampler, /export function createCtxTerrainSampler/);
  assert.match(sampler, /function sampleDetailsAt\(x, y\)/);
  assert.match(app, /state\.terrainSource === "ctx"\) \{ drawCtxMap\(\); return; \}/);
});

test("floating rail is removed while labeled map and data controls remain", () => {
  const view = read("../app/views/home/index.html.erb");
  const css = read("../public/css/app.css");
  assert.doesNotMatch(view, /tool-rail|rail-tool/);
  assert.doesNotMatch(css, /\.tool-rail|\.rail-tool|\.rail-separator/);
  assert.match(view, /id="view-regional"[^>]*>USGS regional image/);
  assert.match(view, /id="view-hirise-detail"[^>]*>HiRISE local detail/);
  assert.match(view, /id="site-search" type="search" list="mars-places"/);
  assert.match(view, /id="view-globe"/);
  assert.match(view, /id="view-terrain"/);
  assert.match(view, /id="open-data-panel"/);
  assert.match(view, /id="layer-controls"/);
});
