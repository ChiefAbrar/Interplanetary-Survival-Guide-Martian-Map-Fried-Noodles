import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseWmtsCapabilities, wmtsTileUrl } from "../public/js/wmts.js";
import { createOpticalWmtsLayer, JEZERO_OPTICAL_LAYERS, opticalMatrixForViewport, visibleOpticalTiles } from "../public/js/optical-wmts.js";
import { createRegionalViewport, JEZERO_REGIONAL_EXTENT } from "../public/js/map-viewport.js";

const fixture = name => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

test("official CTX optical WMTS is PNG with the source Jezero coverage and regional tiles", () => {
  const layer = JEZERO_OPTICAL_LAYERS.ctx;
  const caps = parseWmtsCapabilities(fixture("mars-trek-jezero-ctx-capabilities.xml"), layer.id);
  assert.deepEqual(caps.bounds, [77.1604655, 18.2110274, 77.6991776, 18.7211945]);
  assert.equal(caps.format, "image/png"); assert.equal(caps.tileMatrices.length, 14);
  const viewport = createRegionalViewport();
  const matrix = opticalMatrixForViewport(caps, viewport, 1200, 800);
  const tiles = visibleOpticalTiles(caps, matrix, viewport, 1200, 800);
  assert.ok(tiles.length > 0 && tiles.length < 64);
  assert.ok(tiles.every(tile => tile.west < caps.bounds[2] && tile.east > caps.bounds[0] && tile.north > caps.bounds[1] && tile.south < caps.bounds[3]));
  assert.match(wmtsTileUrl(caps, tiles[0]), /\.png$/);
});

test("HiRISE optical remains a separate footprint and only covers intersecting viewports", () => {
  const caps = parseWmtsCapabilities(fixture("mars-trek-jezero-hirise-capabilities.xml"), JEZERO_OPTICAL_LAYERS.hirise.id);
  assert.deepEqual(caps.bounds, [77.2229331, 18.3067994, 77.583964, 18.669315]);
  const viewport = createRegionalViewport({ ...JEZERO_REGIONAL_EXTENT, longitude: 78, latitude: 19 });
  assert.deepEqual(visibleOpticalTiles(caps, 17, viewport, 900, 600), []);
  const local = createRegionalViewport({ widthM: 7000, heightM: 5000, longitude: 77.4, latitude: 18.4 });
  assert.ok(visibleOpticalTiles(caps, 17, local, 900, 600).length > 0);
});

test("optical tile loader deduplicates in-flight requests and bounds its decoded image cache", async () => {
  const ctxXml = fixture("mars-trek-jezero-ctx-capabilities.xml"), requested = [], pending = new Set();
  let active = 0, peak = 0;
  const fetchImpl = async url => {
    requested.push(url);
    if (url === JEZERO_OPTICAL_LAYERS.ctx.capabilitiesUrl) return { ok: true, text: async () => ctxXml };
    active++; peak = Math.max(peak, active); pending.add(url);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--; pending.delete(url);
    return { ok: true, blob: async () => ({ url }) };
  };
  const layer = createOpticalWmtsLayer({ fetchImpl, decode: async blob => ({ url: blob.url, close() {} }), maxImages: 2, maxConcurrent: 3 });
  const viewport = createRegionalViewport();
  const context = { drawImage() {} };
  layer.draw(context, "ctx", viewport, 800, 600);
  layer.draw(context, "ctx", viewport, 800, 600);
  for (let i = 0; i < 200 && (layer.pendingCount || requested.length <= 1); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(peak <= 3, `max concurrent requests was ${peak}`);
  const tiles = requested.filter(url => url.includes("/1.0.0//default/"));
  assert.equal(new Set(tiles).size, tiles.length, "concurrent draws must not duplicate a tile request");
  assert.ok(layer.cacheSize <= 2);
  assert.equal(layer.pendingCount, 0);
});
