import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCtxTerrainSampler, CtxTerrainSamplerError } from "../public/js/ctx-terrain-sampler.js";
import { createCtxTerrainManager } from "../public/js/ctx-tile-manager.js";
import { CTX_TILE_CATALOG_FORMAT, CTX_TILE_FORMAT } from "../public/js/ctx-tile-format.js";

const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
async function digest(buffer) { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))); }
function makeCrs(width, height) {
  return { crs_name: "Fixture_Mars", wkt: "PROJCS[\"Fixture_Mars\",GEOGCS[\"Mars\",DATUM[\"Mars\",SPHEROID[\"Mars Sphere\",3396190,0]]],PROJECTION[\"Equirectangular\"],PARAMETER[\"standard_parallel_1\",18.4663],PARAMETER[\"central_meridian\",0],AXIS[\"Easting\",EAST]]",
    projection_method: "Equirectangular", planetary_body: "Mars",
    projection: { name: "Equirectangular", latitude_of_projection_origin_deg: 0, standard_parallel_deg: 18.4663,
      longitude_of_central_meridian_deg: 0, planetary_radius_m: 3396190, latitude_type: "Planetocentric",
      longitude_direction: "Positive East", horizontal_coordinate_units: "m" },
    vertical_reference: { units: "m", datum: "unknown", reference: "unknown", vertical_accuracy_m: null,
      vertical_accuracy_status: "unknown" }, pixel_registration: "upper-left outer corner",
    source_geotransform_gdal_order: [1000, 20, 0, 2000, 0, -20], raster_dimensions: { width, height },
    native_posting_m: [20, 20], verified_properties: ["PDS4"], unknown_properties: ["vertical datum", "vertical accuracy"] };
}
async function makeFixture({ halo = 1, nodata = null, missingOwnership = false, duplicateOwnership = false } = {}) {
  const width = 4, height = 4, sourceValues = Array.from({ length: 16 }, (_, index) => {
    const row = Math.floor(index / width), col = index % width;
    return 100 * row + 10 * col + 1;
  });
  if (nodata) sourceValues[nodata.row * width + nodata.column] = NaN;
  const source_grid = { width, height, transform_gdal_order: [1000, 20, 0, 2000, 0, -20] };
  const catalog = { format: CTX_TILE_CATALOG_FORMAT, version: 2, dataset_id: "urn:test:ctx-sampler",
    source_raster: { filename: "source.tif", size_bytes: 64, sha256: "b".repeat(64), metadata_url: "https://fixture.test/source.xml" },
    source_grid, source_crs: makeCrs(width, height),
    tiling: { maximum_cells: 250000, halo_cells: halo, maximum_core_width: 2, maximum_core_height: 2,
      full_grid_rows: 2, full_grid_columns: 2, selected_tile_rows_half_open: [0, 2], selected_tile_columns_half_open: [0, 2], is_partial_selection: false },
    coverage_verification: { core_pixels_expected: 16, core_pixels_unique: 16, complete_source_coverage: true }, tiles: [] };
  const tiles = new Map();
  for (let tileRow = 0; tileRow < 2; tileRow++) for (let tileCol = 0; tileCol < 2; tileCol++) {
    const tileId = `ctx_r${String(tileRow).padStart(3, "0")}_c${String(tileCol).padStart(3, "0")}`;
    let core = { row_off: tileRow * 2, col_off: tileCol * 2, height: 2, width: 2 };
    if (missingOwnership && tileCol === 1) core = { ...core, col_off: core.col_off + 1, width: 1 };
    if (duplicateOwnership && tileCol === 1) core = { ...core, col_off: core.col_off - 1 };
    const rowOff = halo ? Math.max(0, tileRow * 2 - 1) : tileRow * 2;
    let colOff = halo ? Math.max(0, tileCol * 2 - 1) : tileCol * 2;
    let tileHeight = halo ? Math.min(height, tileRow * 2 + 3) - rowOff : 2;
    let tileWidth = halo ? Math.min(width, tileCol * 2 + 3) - colOff : 2;
    if (missingOwnership && tileCol === 1) { colOff = core.col_off - halo; tileWidth = 4 - colOff; }
    const source_window = { row_off: rowOff, col_off: colOff, height: tileHeight, width: tileWidth };
    const record = { tile_id: tileId, metadata_file: `${tileId}.json`, data_file: `${tileId}.f32`, source_window, core_window: core,
      width: tileWidth, height: tileHeight,
      projected_coverage_m: [1000 + colOff * 20, 2000 - (rowOff + tileHeight) * 20,
        1000 + (colOff + tileWidth) * 20, 2000 - rowOff * 20], neighbors: {} };
    catalog.tiles.push(record);
    const buffer = new ArrayBuffer(tileWidth * tileHeight * 4), view = new DataView(buffer);
    for (let row = 0; row < tileHeight; row++) for (let col = 0; col < tileWidth; col++)
      view.setFloat32((row * tileWidth + col) * 4, sourceValues[(rowOff + row) * width + colOff + col], true);
    if (nodata && nodata.row >= rowOff && nodata.row < rowOff + tileHeight && nodata.column >= colOff && nodata.column < colOff + tileWidth)
      view.setFloat32(((nodata.row - rowOff) * tileWidth + nodata.column - colOff) * 4, NaN, true);
    const hash = await digest(buffer);
    const metadata = { format: CTX_TILE_FORMAT, version: 1, catalog_version: 2, catalog_source_crs: JSON.parse(JSON.stringify(catalog.source_crs)),
      tile_id: tileId, dataset_id: catalog.dataset_id,
      source_raster: { filename: "source.tif", size_bytes: 64, sha256: catalog.source_raster.sha256,
        pds4_label_url: "https://fixture.test/source.xml", source_geotransform_gdal_order: [...source_grid.transform_gdal_order],
        source_crs_wkt: catalog.source_crs.wkt },
      source_window: { ...source_window, indexing: "zero-based half-open offsets [offset, offset + size)" },
      core_window: { ...core, indexing: "zero-based half-open offsets [offset, offset + size)" },
      core_window_in_tile: { row_off: core.row_off - rowOff, col_off: core.col_off - colOff, height: core.height, width: core.width },
      width: tileWidth, height: tileHeight,
      data: { filename: record.data_file, dtype: "float32", byte_order: "little-endian", layout: "row-major", units: "m",
        expected_bytes: buffer.byteLength, sha256: hash, nodata_source_value: -3.4028234663852886e+38, nodata_output_value: "IEEE-754 NaN" },
      georeference: { transform_gdal_order: [1000 + colOff * 20, 20, 0, 2000 - rowOff * 20, 0, -20],
        crs_wkt: catalog.source_crs.wkt, projection: { ...catalog.source_crs.projection }, pixel_registration: "upper-left outer corner",
        pixel_size_m: [20, 20], projected_bounds_m: record.projected_coverage_m, coverage_planetocentric_east_positive_deg: {} },
      vertical_reference: { units: "m", reference: "unknown" }, processing_history: [], neighbors: {} };
    tiles.set(tileId, { tileId, elevations: new Float32Array(buffer), metadata });
  }
  if (missingOwnership || duplicateOwnership) catalog.coverage_verification.complete_source_coverage = false;
  return { catalog, tiles, loadCalls: [], failOnce: new Set() };
}
function makeManager(fixture, maxCachedTiles = 12) {
  const cache = new Map();
  const manager = {
    async loadCatalog() { return fixture.catalog; },
    async loadTile(tileId) {
      fixture.loadCalls.push(tileId);
      if (fixture.failOnce.has(tileId)) { fixture.failOnce.delete(tileId); throw Object.assign(new Error("temporary fetch failure"), { code: "binary-load" }); }
      const tile = fixture.tiles.get(tileId);
      if (!tile) throw new Error(`unknown ${tileId}`);
      cache.delete(tileId); cache.set(tileId, tile);
      while (cache.size > maxCachedTiles) cache.delete(cache.keys().next().value);
      return tile;
    },
    getCachedTile(tileId) {
      const tile = cache.get(tileId);
      if (!tile) return null;
      cache.delete(tileId); cache.set(tileId, tile);
      return tile;
    },
    getCacheStats() { return { maxCachedTiles, cachedTileIds: [...cache.keys()] }; },
    evict(tileId) { cache.delete(tileId); }
  };
  return manager;
}
const codeIs = code => error => error instanceof CtxTerrainSamplerError && error.code === code;
const setup = async options => {
  const fixture = await makeFixture(options), manager = makeManager(fixture, options?.capacity ?? 12);
  const sampler = createCtxTerrainSampler({ manager, catalog: fixture.catalog });
  await sampler.loadCatalog();
  return { fixture, manager, sampler };
};

test("maps northwest-origin projected coordinates to source cells and includes first/last cells", async () => {
  const { sampler, manager } = await setup();
  await sampler.ensureTilesForPath([{ x: 10, y: 10 }, { x: 70, y: 70 }]);
  const first = sampler.sampleDetailsAt(10, 10), last = sampler.sampleDetailsAt(70, 70);
  assert.deepEqual([first.sourceRow, first.sourceColumn], [0, 0]);
  assert.deepEqual([last.sourceRow, last.sourceColumn], [3, 3]);
  assert.equal(first.elevationM, 1); assert.equal(last.elevationM, 331);
  assert.deepEqual([sampler.cellX, sampler.cellY, sampler.width, sampler.height], [20, 20, 4, 4]);
  assert.deepEqual([sampler.geo.originXM, sampler.geo.originYM, sampler.geo.radiusM], [1000, 2000, 3396190]);
  assert.ok(manager.getCachedTile("ctx_r000_c000"));
});
test("outside coordinates are reported without clamping or loading another tile", async () => {
  const { sampler, fixture } = await setup();
  const outside = sampler.sampleDetailsAt(-0.1, 12);
  assert.equal(outside.invalidReason, "outside-mosaic-coverage");
  assert.equal(sampler.elevationAt(80, 20), null);
  assert.equal(fixture.loadCalls.length, 0);
});
test("uses unique deterministic core ownership and rejects missing or duplicate ownership", async () => {
  const { sampler } = await setup();
  assert.equal(sampler.getTileOwner(1, 1), "ctx_r000_c000");
  assert.equal(sampler.getTileOwner(1, 2), "ctx_r000_c001");
  assert.throws(() => sampler.getTileOwner(4, 0), codeIs("source-index-out-of-bounds"));
  const missing = await setup({ missingOwnership: true });
  assert.throws(() => missing.sampler.getTileOwner(0, 2), codeIs("missing-core-ownership"));
  await assert.rejects(setup({ duplicateOwnership: true }), codeIs("invalid-catalog"));
});
test("single-tile samples and bilinear interpolation match terrain.elevationAt conventions", async () => {
  const { sampler } = await setup();
  await sampler.ensureTilesForPath([{ x: 10, y: 10 }, { x: 11, y: 11 }]);
  const sample = sampler.sampleDetailsAt(40, 20);
  assert.equal(sample.isValid, true);
  assert.equal(sample.elevationM, 66);
  assert.equal(sample.samplingMethod, "bilinear");
  assert.equal(sample.tileId, "ctx_r000_c000");
});
test("horizontal, vertical, and corner boundaries use the owning tile halo without seams", async () => {
  const { sampler } = await setup();
  await sampler.ensureTilesForPath([{ x: 39, y: 39 }, { x: 41, y: 41 }]);
  const horizontal = sampler.sampleDetailsAt(40, 20);
  const vertical = sampler.sampleDetailsAt(20, 40);
  const corner = sampler.sampleDetailsAt(40, 40);
  assert.equal(horizontal.tileId, "ctx_r000_c000"); assert.equal(horizontal.elevationM, 66);
  assert.equal(vertical.tileId, "ctx_r000_c000"); assert.equal(vertical.elevationM, 156);
  assert.equal(corner.tileId, "ctx_r000_c000"); assert.equal(corner.elevationM, 166);
  assert.deepEqual([horizontal.sourceRow, horizontal.sourceColumn], [0, 1]);
});
test("returns invalid no-data support and detects missing halo support cells", async () => {
  const noData = await setup({ nodata: { row: 1, column: 2 } });
  await noData.sampler.ensureTilesForPath([{ x: 40, y: 20 }, { x: 41, y: 20 }]);
  const invalid = noData.sampler.sampleDetailsAt(40, 20);
  assert.equal(invalid.isValid, false); assert.equal(invalid.invalidReason, "source-no-data-support"); assert.equal(invalid.elevationM, null);
  const noHalo = await setup({ halo: 0 });
  await noHalo.manager.loadTile("ctx_r000_c000");
  assert.equal(noHalo.sampler.sampleDetailsAt(40, 20).invalidReason, "missing-adjacent-support-cells");
});
test("distinguishes required tiles that are not loaded from terrain no-data", async () => {
  const { sampler } = await setup();
  assert.throws(() => sampler.sampleDetailsAt(10, 10), codeIs("tile-not-loaded"));
});
test("sample results retain dataset, tile, source cell, resolution, and projected provenance", async () => {
  const { sampler } = await setup();
  await sampler.ensureTilesForPath([{ x: 10, y: 10 }, { x: 11, y: 11 }]);
  const result = sampler.sampleDetailsAt(10, 10);
  assert.equal(result.datasetId, "urn:test:ctx-sampler");
  assert.equal(result.tileId, "ctx_r000_c000");
  assert.deepEqual(result.nativeSpatialResolutionM, { x: 20, y: 20 });
  assert.deepEqual(result.projectedCoordinatesM, { x: 1010, y: 1990 });
});
test("ownership lookup uses prebuilt row spans rather than rescanning catalog tiles", async () => {
  const { sampler } = await setup();
  const before = sampler.getOwnershipIndexStats();
  for (let n = 0; n < 50; n++) sampler.getTileOwner(n % 4, (n * 3) % 4);
  assert.deepEqual(sampler.getOwnershipIndexStats(), before);
  assert.deepEqual(before, { sourceRowsIndexed: 4, coreRowSpans: 8 });
});
test("route corridor selection loads diagonal owners only, not the enclosing rectangle", async () => {
  const { sampler, fixture } = await setup();
  const result = await sampler.ensureTilesForPath([{ x: 10, y: 10 }, { x: 70, y: 70 }]);
  assert.deepEqual(new Set(result.requiredTileIds), new Set(["ctx_r000_c000", "ctx_r001_c001"]));
  assert.equal(result.requiredTileCount, 2);
  assert.equal(result.loadedTileCount, 2);
  assert.equal(result.cachedTileCount, 0);
  assert.equal(result.skippedTileCount, 2);
  assert.deepEqual(new Set(fixture.loadCalls), new Set(result.requiredTileIds));
});
test("route preload rejects a working set larger than cache capacity", async () => {
  const { sampler, fixture } = await setup({ capacity: 1 });
  await assert.rejects(sampler.ensureTilesForPath([{ x: 10, y: 10 }, { x: 70, y: 70 }]), codeIs("cache-capacity"));
  assert.equal(fixture.loadCalls.length, 0);
});
test("route preload retries failed tiles and reports cache hits on a later call", async () => {
  const { sampler, fixture } = await setup(); fixture.failOnce.add("ctx_r000_c000");
  await assert.rejects(sampler.ensureTilesForPath([{ x: 10, y: 10 }, { x: 11, y: 11 }]), codeIs("tile-load-failed"));
  assert.throws(() => sampler.sampleDetailsAt(10, 10), codeIs("tile-load-failed"));
  const retry = await sampler.ensureTilesForPath([{ x: 10, y: 10 }, { x: 11, y: 11 }]);
  assert.equal(retry.loadedTileCount, 1);
  const cached = await sampler.ensureTilesForPath([{ x: 10, y: 10 }, { x: 11, y: 11 }]);
  assert.equal(cached.cachedTileCount, 1); assert.equal(cached.loadedTileCount, 0);
});
test("sampling is unchanged after manager eviction and tile reload", async () => {
  const { sampler, manager } = await setup();
  await sampler.ensureTilesForPath([{ x: 39, y: 39 }, { x: 41, y: 41 }]);
  const before = sampler.sampleDetailsAt(40, 40).elevationM;
  manager.evict("ctx_r000_c000");
  assert.throws(() => sampler.sampleDetailsAt(40, 40), codeIs("tile-not-loaded"));
  await manager.loadTile("ctx_r000_c000");
  assert.equal(sampler.sampleDetailsAt(40, 40).elevationM, before);
});
const realTileDirectory = fileURLToPath(new URL("../data/processed/ctx-jezero/", import.meta.url));
test("optional real CTX horizontal, vertical, and corner halo smoke test", { skip: !existsSync(`${realTileDirectory}/catalog.json`) }, async t => {
  const server = createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, "http://localhost").pathname.slice(1));
    if (!/^(catalog\.json|ctx_r\d{3}_c\d{3}\.(json|f32))$/.test(name)) { res.writeHead(404).end(); return; }
    try {
      const bytes = readFileSync(`${realTileDirectory}/${name}`);
      res.writeHead(200, { "Content-Type": name.endsWith(".json") ? "application/json" : "application/octet-stream" }).end(bytes);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const manager = createCtxTerrainManager({ catalogUrl: `${base}catalog.json`, tileBaseUrl: base });
  const sampler = createCtxTerrainSampler({ manager });
  const catalog = await sampler.loadCatalog();
  const find = id => catalog.tiles.find(tile => tile.tile_id === id);
  const tl = find("ctx_r000_c000"), tr = find("ctx_r000_c001"), bl = find("ctx_r001_c000"), br = find("ctx_r001_c001");
  await Promise.all([tl, tr, bl, br].map(tile => manager.loadTile(tile.tile_id)));
  const colBoundary = tr.core_window.col_off, rowBoundary = bl.core_window.row_off;
  let horizontal = null, vertical = null, corner = null;
  for (let row = 4; row < rowBoundary - 2 && !horizontal; row++) {
    const candidate = sampler.sampleDetailsAt(colBoundary * 20, (row + 0.5) * 20);
    if (candidate.isValid) horizontal = candidate;
  }
  for (let col = 4; col < colBoundary - 2 && !vertical; col++) {
    const candidate = sampler.sampleDetailsAt((col + 0.5) * 20, rowBoundary * 20);
    if (candidate.isValid) vertical = candidate;
  }
  for (let offset = 0; offset < 20 && !corner; offset++) {
    const candidate = sampler.sampleDetailsAt(colBoundary * 20 + offset * 0.01, rowBoundary * 20 + offset * 0.01);
    if (candidate.isValid) corner = candidate;
  }
  assert.ok(horizontal, "found valid bilinear support across horizontal neighboring tiles");
  assert.ok(vertical, "found valid bilinear support across vertical neighboring tiles");
  assert.ok(corner, "found valid bilinear support at the four-tile corner");
  assert.equal(horizontal.datasetId, catalog.dataset_id);
  assert.equal(vertical.datasetId, catalog.dataset_id);
  assert.equal(corner.datasetId, catalog.dataset_id);
});
