import test from "node:test";
import assert from "node:assert/strict";
import { createCtxTerrainManager, CtxTileManagerError } from "../public/js/ctx-tile-manager.js";
import { CTX_TILE_CATALOG_FORMAT, CTX_TILE_FORMAT } from "../public/js/ctx-tile-format.js";

const catalogUrl = "https://fixture.test/catalog/catalog.json";
const tileBaseUrl = "https://fixture.test/assets/ctx/";
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
async function sha256(buffer) { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))); }
function sourceCrs(width, height) {
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
async function fixtures(count = 3) {
  const width = count, height = 1;
  const catalog = { format: CTX_TILE_CATALOG_FORMAT, version: 2, dataset_id: "urn:test:ctx-manager",
    source_raster: { filename: "source.tif", size_bytes: 64, sha256: "b".repeat(64), metadata_url: "https://fixture.test/source.xml" },
    source_grid: { width, height, transform_gdal_order: [1000, 20, 0, 2000, 0, -20] }, source_crs: sourceCrs(width, height),
    tiling: { maximum_cells: 250000, halo_cells: 0, maximum_core_width: 1, maximum_core_height: 1,
      full_grid_rows: 1, full_grid_columns: count, selected_tile_rows_half_open: [0, 1],
      selected_tile_columns_half_open: [0, count], is_partial_selection: false },
    coverage_verification: { core_pixels_expected: count, core_pixels_unique: count, complete_source_coverage: false }, tiles: [] };
  const sidecars = new Map(), binaries = new Map();
  for (let col = 0; col < count; col++) {
    const tileId = `ctx_r000_c${String(col).padStart(3, "0")}`, filename = `${tileId}.f32`;
    const record = { tile_id: tileId, metadata_file: `${tileId}.json`, data_file: filename,
      source_window: { row_off: 0, col_off: col, height: 1, width: 1 },
      core_window: { row_off: 0, col_off: col, height: 1, width: 1 }, width: 1, height: 1,
      projected_coverage_m: [1000 + col * 20, 1980, 1020 + col * 20, 2000], neighbors: {} };
    catalog.tiles.push(record);
    const buffer = new ArrayBuffer(4); new DataView(buffer).setFloat32(0, col + 0.25, true);
    const hash = await sha256(buffer);
    const metadata = { format: CTX_TILE_FORMAT, version: 1, catalog_version: 2, catalog_source_crs: JSON.parse(JSON.stringify(catalog.source_crs)),
      tile_id: tileId, dataset_id: catalog.dataset_id,
      source_raster: { filename: "source.tif", size_bytes: 64, sha256: catalog.source_raster.sha256,
        pds4_label_url: "https://fixture.test/source.xml", source_geotransform_gdal_order: [...catalog.source_grid.transform_gdal_order],
        source_crs_wkt: catalog.source_crs.wkt },
      source_window: { ...record.source_window, indexing: "zero-based half-open offsets [offset, offset + size)" },
      core_window: { ...record.core_window, indexing: "zero-based half-open offsets [offset, offset + size)" },
      core_window_in_tile: { row_off: 0, col_off: 0, height: 1, width: 1 }, width: 1, height: 1,
      data: { filename, dtype: "float32", byte_order: "little-endian", layout: "row-major", units: "m", expected_bytes: 4,
        sha256: hash, nodata_source_value: -3.4028234663852886e+38, nodata_output_value: "IEEE-754 NaN" },
      georeference: { transform_gdal_order: [1000 + col * 20, 20, 0, 2000, 0, -20], crs_wkt: catalog.source_crs.wkt,
        projection: { ...catalog.source_crs.projection }, pixel_registration: "upper-left outer corner", pixel_size_m: [20, 20],
        projected_bounds_m: record.projected_coverage_m, coverage_planetocentric_east_positive_deg: {} },
      vertical_reference: { units: "m", reference: "unknown" }, processing_history: [], neighbors: {} };
    sidecars.set(record.metadata_file, metadata); binaries.set(filename, buffer);
  }
  return { catalog, sidecars, binaries };
}
function responseJson(value, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => value }; }
function responseBuffer(value, status = 200) { return { ok: status >= 200 && status < 300, status, arrayBuffer: async () => value.slice(0) }; }
function mockFetch(data, { beforeFetch = async () => {}, overrides = {} } = {}) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    await beforeFetch(String(url));
    if (Object.hasOwn(overrides, url)) return overrides[url](url);
    if (url === catalogUrl) return responseJson(data.catalog);
    const file = String(url).split("/").at(-1);
    if (data.sidecars.has(file)) return responseJson(data.sidecars.get(file));
    if (data.binaries.has(file)) return responseBuffer(data.binaries.get(file));
    return responseJson({}, 404);
  };
  return { fetchImpl, calls };
}
const managerFor = (data, options = {}) => {
  const mocked = mockFetch(data, options);
  return { ...mocked, manager: createCtxTerrainManager({ catalogUrl, tileBaseUrl, fetchImpl: mocked.fetchImpl, ...options }) };
};
const codeIs = code => error => error instanceof CtxTileManagerError && error.code === code;

test("loads and validates the catalog once, without eagerly requesting tiles", async () => {
  const data = await fixtures(99), { manager, calls } = managerFor(data);
  const [a, b] = await Promise.all([manager.loadCatalog(), manager.loadCatalog()]);
  assert.equal(a, b); assert.equal(a.tiles.length, 99);
  assert.deepEqual(calls, [catalogUrl]);
  assert.equal(manager.getCacheStats().maxCachedTiles, 12);
  assert.equal(manager.getCacheStats().maxConcurrentLoads, 4);
});
test("loads one tile with configured sidecar and binary URLs, SHA-256, and decoded elevations", async () => {
  const data = await fixtures(), { manager, calls } = managerFor(data);
  const tile = await manager.loadTile("ctx_r000_c001");
  assert.equal(tile.elevations[0], 1.25);
  assert.equal(tile.metadata.tile_id, "ctx_r000_c001");
  assert.equal(tile.metadata.dataset_id, "urn:test:ctx-manager");
  assert.deepEqual(calls, [catalogUrl, `${tileBaseUrl}ctx_r000_c001.json`, `${tileBaseUrl}ctx_r000_c001.f32`]);
});
test("shares catalog request and one in-flight tile request among duplicate callers", async () => {
  const data = await fixtures(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { manager, calls } = managerFor(data, { beforeFetch: async url => { if (url.endsWith(".json") && !url.endsWith("catalog.json")) await gate; } });
  const requests = [manager.loadTile("ctx_r000_c000"), manager.loadTile("ctx_r000_c000"), manager.loadTile("ctx_r000_c000")];
  await new Promise(resolve => setTimeout(resolve, 0));
  release();
  const [a, b, c] = await Promise.all(requests);
  assert.equal(a, b); assert.equal(b, c);
  assert.equal(calls.filter(url => url.endsWith("ctx_r000_c000.json")).length, 1);
  assert.equal(calls.filter(url => url.endsWith("ctx_r000_c000.f32")).length, 1);
});
test("rejects tile checksum mismatch and wrong binary length without caching", async () => {
  const data = await fixtures();
  data.binaries.set("ctx_r000_c000.f32", new ArrayBuffer(8));
  const first = managerFor(data);
  await assert.rejects(first.manager.loadTile("ctx_r000_c000"), codeIs("binary-length"));
  assert.equal(first.manager.getCacheStats().cachedTileCount, 0);
  data.binaries.set("ctx_r000_c000.f32", new Uint8Array([0, 0, 128, 63]).buffer);
  data.sidecars.get("ctx_r000_c000.json").data.sha256 = "0".repeat(64);
  const second = managerFor(data);
  await assert.rejects(second.manager.loadTile("ctx_r000_c000"), codeIs("checksum-mismatch"));
  assert.equal(second.manager.getCacheStats().cachedTileCount, 0);
});
test("reports unknown IDs and invalid sidecar metadata distinctly", async () => {
  const data = await fixtures(), { manager } = managerFor(data);
  await assert.rejects(manager.loadTile("ctx_r999_c999"), codeIs("unknown-tile"));
  const invalidData = await fixtures(); invalidData.sidecars.get("ctx_r000_c000.json").tile_id = "ctx_r000_c999";
  const invalid = managerFor(invalidData).manager;
  await assert.rejects(invalid.loadTile("ctx_r000_c000"), codeIs("invalid-metadata"));
  assert.equal(invalid.getCacheStats().cachedTileCount, 0);
});
test("categorizes HTTP and network failures and permits retry after failure", async () => {
  const data = await fixtures(); let failOnce = true;
  const url = `${tileBaseUrl}ctx_r000_c000.json`;
  const { manager } = managerFor(data, { overrides: { [url]: async () => {
    if (failOnce) { failOnce = false; throw new Error("offline"); }
    return responseJson(data.sidecars.get("ctx_r000_c000.json"));
  } } });
  await assert.rejects(manager.loadTile("ctx_r000_c000"), codeIs("metadata-load"));
  assert.equal(manager.getCacheStats().inFlightLoadCount, 0);
  assert.equal((await manager.loadTile("ctx_r000_c000")).elevations[0], 0.25);
  const notFound = managerFor(data, { overrides: { [url]: async () => responseJson({}, 404) } }).manager;
  await assert.rejects(notFound.loadTile("ctx_r000_c000"), e => e instanceof CtxTileManagerError && e.code === "metadata-load" && /404/.test(e.message));
});
test("binary HTTP and network failures use the binary-load category", async () => {
  const data = await fixtures(), binaryUrl = `${tileBaseUrl}ctx_r000_c000.f32`;
  const missing = managerFor(data, { overrides: { [binaryUrl]: async () => responseBuffer(new ArrayBuffer(0), 404) } }).manager;
  await assert.rejects(missing.loadTile("ctx_r000_c000"), e => e instanceof CtxTileManagerError && e.code === "binary-load" && /404/.test(e.message));
  const offline = managerFor(data, { overrides: { [binaryUrl]: async () => { throw new Error("offline"); } } }).manager;
  await assert.rejects(offline.loadTile("ctx_r000_c000"), codeIs("binary-load"));
});
test("catalog failures are retryable and invalid catalog JSON/structure is categorized", async () => {
  const data = await fixtures(); let once = true;
  const { manager } = managerFor(data, { overrides: { [catalogUrl]: async () => {
    if (once) { once = false; throw new Error("temporary"); }
    return responseJson(data.catalog);
  } } });
  await assert.rejects(manager.loadCatalog(), codeIs("catalog-load"));
  assert.equal((await manager.loadCatalog()).tiles.length, 3);
  const bad = await fixtures(); bad.catalog.version = 999;
  await assert.rejects(managerFor(bad).manager.loadCatalog(), codeIs("invalid-catalog"));
});
test("different tile requests respect the configured concurrent-load bound", async () => {
  const data = await fixtures(6); let active = 0, maximum = 0;
  const { manager } = managerFor(data, { maxConcurrentLoads: 2, beforeFetch: async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
  } });
  await Promise.all(data.catalog.tiles.map(tile => manager.loadTile(tile.tile_id)));
  assert.ok(maximum <= 2, `observed ${maximum} concurrent requests`);
  assert.equal(manager.getCacheStats().maxConcurrentLoads, 2);
});
test("LRU access order evicts the least recently used completed tile and reloads evicted tiles", async () => {
  const data = await fixtures(3), { manager, calls } = managerFor(data, { maxCachedTiles: 2 });
  await manager.loadTile("ctx_r000_c000"); await manager.loadTile("ctx_r000_c001");
  await manager.loadTile("ctx_r000_c000"); // refresh c000; c001 becomes least recent
  await manager.loadTile("ctx_r000_c002");
  assert.deepEqual(manager.getCacheStats().cachedTileIds, ["ctx_r000_c000", "ctx_r000_c002"]);
  const before = calls.filter(url => url.endsWith("ctx_r000_c001.f32")).length;
  await manager.loadTile("ctx_r000_c001");
  assert.equal(calls.filter(url => url.endsWith("ctx_r000_c001.f32")).length, before + 1);
  assert.deepEqual(manager.getCacheStats().cachedTileIds, ["ctx_r000_c002", "ctx_r000_c001"]);
});
test("cache hits avoid requests, stats report memory, and clearCache leaves active loads safe", async () => {
  const data = await fixtures(2), { manager, calls } = managerFor(data, { maxCachedTiles: 2 });
  await manager.loadTile("ctx_r000_c000"); const requestCount = calls.length;
  await manager.loadTile("ctx_r000_c000");
  let stats = manager.getCacheStats();
  assert.equal(calls.length, requestCount); assert.equal(stats.cachedTileCount, 1);
  assert.equal(stats.estimatedElevationArrayMemoryBytes, 4); assert.deepEqual(stats.cachedTileIds, ["ctx_r000_c000"]);
  let release; const gate = new Promise(resolve => { release = resolve; });
  const pendingManager = managerFor(data, { beforeFetch: async url => { if (url.endsWith("ctx_r000_c001.json")) await gate; } }).manager;
  const pending = pendingManager.loadTile("ctx_r000_c001");
  await new Promise(resolve => setTimeout(resolve, 0));
  pendingManager.clearCache();
  release(); await pending;
  assert.equal(pendingManager.getCacheStats().cachedTileCount, 0);
  manager.clearCache(); stats = manager.getCacheStats();
  assert.equal(stats.cachedTileCount, 0); assert.equal(stats.estimatedElevationArrayMemoryBytes, 0);
});
test("getCachedTile returns only cached tiles, refreshes LRU order, and never fetches", async () => {
  const data = await fixtures(2), { manager, calls } = managerFor(data, { maxCachedTiles: 2 });
  assert.equal(manager.getCachedTile("ctx_r000_c000"), null);
  await manager.loadTile("ctx_r000_c000");
  const count = calls.length, tile = manager.getCachedTile("ctx_r000_c000");
  assert.equal(tile.tileId, "ctx_r000_c000");
  assert.equal(calls.length, count);
  assert.deepEqual(manager.getCacheStats().cachedTileIds, ["ctx_r000_c000"]);
});
test("peekCachedTile inspects cached DEM data without changing its LRU position", async () => {
  const data = await fixtures(2), { manager } = managerFor(data, { maxCachedTiles: 2 });
  await manager.loadTile("ctx_r000_c000"); await manager.loadTile("ctx_r000_c001");
  assert.equal(manager.peekCachedTile("ctx_r000_c000").tileId, "ctx_r000_c000");
  assert.deepEqual(manager.getCacheStats().cachedTileIds, ["ctx_r000_c000", "ctx_r000_c001"]);
});
test("cache configuration requires positive safe integer limits", async () => {
  const data = await fixtures(); const { fetchImpl } = mockFetch(data);
  for (const options of [{ maxCachedTiles: 0 }, { maxCachedTiles: 1.5 }, { maxConcurrentLoads: -1 }, { maxConcurrentLoads: Number.MAX_SAFE_INTEGER + 1 }])
    assert.throws(() => createCtxTerrainManager({ catalogUrl, fetchImpl, ...options }), codeIs("configuration"));
});
test("loading selected tiles from a 99-tile catalog never requests the remaining tiles", async () => {
  const data = await fixtures(99), { manager, calls } = managerFor(data);
  await Promise.all([manager.loadTile("ctx_r000_c000"), manager.loadTile("ctx_r000_c001")]);
  assert.equal(calls.length, 5); // catalog plus metadata and binary for two requested IDs
  assert.ok(calls.every(url => !/ctx_r\d{3}_c00[2-9]\.json$/.test(url)));
  assert.equal(manager.getCacheStats().cachedTileCount, 2);
});
