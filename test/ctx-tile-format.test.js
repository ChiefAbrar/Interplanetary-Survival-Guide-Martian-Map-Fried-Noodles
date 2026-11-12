import test from "node:test";
import assert from "node:assert/strict";
import {
  validateCtxTileCatalog, validateCtxTileMetadata, decodeCtxTile, CtxTileFormatError,
  validateCtxTileCollection, CTX_TILE_CATALOG_FORMAT, CTX_TILE_FORMAT
} from "../public/js/ctx-tile-format.js";

const digest = "a".repeat(64);
function makeSourceCrs(grid) {
  return {
    crs_name: "Test_Mars_Projection",
    wkt: "PROJCS[\"Test_Mars_Projection\",GEOGCS[\"Mars\",DATUM[\"Mars\",SPHEROID[\"Mars Sphere\",3396190,0]]],PROJECTION[\"Equirectangular\"],PARAMETER[\"standard_parallel_1\",18.4663],PARAMETER[\"latitude_of_projection_origin\",0],PARAMETER[\"central_meridian\",0],AXIS[\"Easting\",EAST]]",
    projection_method: "Equirectangular", planetary_body: "Mars",
    projection: { name: "Equirectangular", latitude_of_projection_origin_deg: 0, standard_parallel_deg: 18.4663,
      longitude_of_central_meridian_deg: 0, planetary_radius_m: 3396190, latitude_type: "Planetocentric",
      longitude_direction: "Positive East", horizontal_coordinate_units: "m" },
    vertical_reference: { units: "m", datum: "unknown / not stated", reference: "unknown", vertical_accuracy_m: null,
      vertical_accuracy_status: "unknown; not published" },
    pixel_registration: "upper-left outer corner",
    source_geotransform_gdal_order: [...grid.transform_gdal_order],
    raster_dimensions: { width: grid.width, height: grid.height }, native_posting_m: [20, 20],
    verified_properties: ["GeoTIFF", "PDS4"], unknown_properties: ["vertical datum", "vertical accuracy"]
  };
}
function makeCatalog() {
  const sourceGrid = { width: 6, height: 4, transform_gdal_order: [1000, 20, 0, 2000, 0, -20] };
  const core = { row_off: 0, col_off: 0, height: 4, width: 3 };
  const sourceWindow = { row_off: 0, col_off: 0, height: 4, width: 4 };
  return {
    format: CTX_TILE_CATALOG_FORMAT, version: 2, dataset_id: "urn:test:ctx:jezero",
    source_raster: { filename: "source.tif", size_bytes: 4096, sha256: digest, metadata_url: "https://example.test/metadata.xml" },
    source_grid: sourceGrid,
    source_crs: makeSourceCrs(sourceGrid),
    tiling: { maximum_cells: 250000, halo_cells: 1, maximum_core_width: 3, maximum_core_height: 4,
      full_grid_rows: 1, full_grid_columns: 2, selected_tile_rows_half_open: [0, 1], selected_tile_columns_half_open: [0, 2], is_partial_selection: false },
    coverage_verification: { core_pixels_expected: 24, core_pixels_unique: 24, complete_source_coverage: true },
    tiles: [{ tile_id: "ctx_r000_c000", metadata_file: "ctx_r000_c000.json", data_file: "ctx_r000_c000.f32",
      source_window: sourceWindow, core_window: core, width: 4, height: 4,
      projected_coverage_m: [1000, 1920, 1080, 2000], neighbors: { north: null, south: null, west: null, east: "ctx_r000_c001" } },
    { tile_id: "ctx_r000_c001", metadata_file: "ctx_r000_c001.json", data_file: "ctx_r000_c001.f32",
      source_window: { row_off: 0, col_off: 2, height: 4, width: 4 },
      core_window: { row_off: 0, col_off: 3, height: 4, width: 3 }, width: 4, height: 4,
      projected_coverage_m: [1040, 1920, 1120, 2000], neighbors: { north: null, south: null, west: "ctx_r000_c000", east: null } }]
  };
}
function makeMetadata(catalog = makeCatalog()) {
  const record = catalog.tiles[0];
  return {
    format: CTX_TILE_FORMAT, version: 1, catalog_version: 2, catalog_source_crs: JSON.parse(JSON.stringify(catalog.source_crs)),
    tile_id: record.tile_id, dataset_id: catalog.dataset_id,
    source_raster: { filename: catalog.source_raster.filename, size_bytes: catalog.source_raster.size_bytes,
      sha256: catalog.source_raster.sha256, pds4_label_url: "https://example.test/metadata.xml",
      source_geotransform_gdal_order: [...catalog.source_grid.transform_gdal_order], source_crs_wkt: catalog.source_crs.wkt },
    source_window: { ...record.source_window, indexing: "zero-based half-open offsets [offset, offset + size)" },
    core_window: { ...record.core_window, indexing: "zero-based half-open offsets [offset, offset + size)" },
    core_window_in_tile: { row_off: 0, col_off: 0, height: 4, width: 3 }, width: 4, height: 4,
    data: { filename: record.data_file, dtype: "float32", byte_order: "little-endian", layout: "row-major", units: "m",
      expected_bytes: 64, sha256: digest, nodata_source_value: -3.4028234663852886e+38, nodata_output_value: "IEEE-754 NaN" },
    georeference: { transform_gdal_order: [1000, 20, 0, 2000, 0, -20], crs_wkt: catalog.source_crs.wkt,
      projection: { ...catalog.source_crs.projection }, pixel_registration: "upper-left outer corner",
      pixel_size_m: [20, 20], projected_bounds_m: [1000, 1920, 1080, 2000],
      coverage_planetocentric_east_positive_deg: { west: 0, east: 1, south: 0, north: 1 } },
    vertical_reference: { units: "m", reference: "test; datum unknown" },
    processing_history: ["synthetic"], neighbors: { north: null, south: null, west: null, east: "ctx_r000_c001" }
  };
}
const expectCode = (fn, code) => assert.throws(fn, e => e instanceof CtxTileFormatError && e.code === code);

test("accepts a valid catalog with non-overlapping cores and halo windows", () => {
  assert.equal(validateCtxTileCatalog(makeCatalog()).tiles.length, 2);
});
test("rejects unsupported catalog format and duplicate IDs", () => {
  const badFormat = makeCatalog(); badFormat.format = "other";
  expectCode(() => validateCtxTileCatalog(badFormat), "format");
  const badVersion = makeCatalog(); badVersion.version = 1;
  expectCode(() => validateCtxTileCatalog(badVersion), "version");
  const duplicate = makeCatalog(); duplicate.tiles[1].tile_id = duplicate.tiles[0].tile_id;
  expectCode(() => validateCtxTileCatalog(duplicate), "duplicate-tile");
});
test("rejects out-of-range core windows and invalid extraction or halo windows", () => {
  const outside = makeCatalog(); outside.tiles[0].core_window.col_off = 5;
  expectCode(() => validateCtxTileCatalog(outside), "window-bounds");
  const badHalo = makeCatalog(); badHalo.tiles[0].source_window.width = 6; badHalo.tiles[0].width = 6;
  expectCode(() => validateCtxTileCatalog(badHalo), "halo");
  const badExtract = makeCatalog(); badExtract.tiles[0].source_window.width = 3;
  expectCode(() => validateCtxTileCatalog(badExtract), "dimensions");
});
test("rejects duplicate core ownership and invalid dimensions/cell counts", () => {
  const overlap = makeCatalog(); overlap.tiles[1].core_window.col_off = 2;
  expectCode(() => validateCtxTileCatalog(overlap), "duplicate-core-ownership");
  const invalidDim = makeCatalog(); invalidDim.tiles[0].width = 0;
  expectCode(() => validateCtxTileCatalog(invalidDim), "cell-limit");
  const huge = makeCatalog(); huge.tiles[0].width = 501; huge.tiles[0].height = 500;
  expectCode(() => validateCtxTileCatalog(huge), "cell-limit");
});
test("rejects incomplete required catalog fields and inconsistent source offsets", () => {
  const missing = makeCatalog(); delete missing.source_grid.transform_gdal_order;
  expectCode(() => validateCtxTileCatalog(missing), "georeference");
  const badOffset = makeCatalog(); badOffset.tiles[1].projected_coverage_m[0] += 20;
  expectCode(() => validateCtxTileCatalog(badOffset), "georeference");
});
test("catalog records complete CRS values and explicit unknown vertical datum and accuracy", () => {
  const catalog = makeCatalog();
  assert.equal(validateCtxTileCatalog(catalog).source_crs.projection.planetary_radius_m, 3396190);
  assert.equal(catalog.source_crs.projection.standard_parallel_deg, 18.4663);
  assert.equal(catalog.source_crs.projection.latitude_of_projection_origin_deg, 0);
  assert.equal(catalog.source_crs.projection.latitude_type, "Planetocentric");
  assert.equal(catalog.source_crs.projection.longitude_direction, "Positive East");
  assert.equal(catalog.source_crs.vertical_reference.datum, "unknown / not stated");
  assert.equal(catalog.source_crs.vertical_reference.vertical_accuracy_m, null);
  const noCrs = makeCatalog(); delete noCrs.source_crs;
  expectCode(() => validateCtxTileCatalog(noCrs), "metadata");
  const badWkt = makeCatalog(); badWkt.source_crs.wkt = "";
  expectCode(() => validateCtxTileCatalog(badWkt), "crs");
});
test("rejects metadata/catalog identity, bytes, checksum, and geotransform inconsistencies", () => {
  const catalog = makeCatalog();
  let meta = makeMetadata(catalog); delete meta.data.layout;
  expectCode(() => validateCtxTileMetadata(meta, catalog), "encoding");
  meta = makeMetadata(catalog); meta.data.expected_bytes--;
  expectCode(() => validateCtxTileMetadata(meta, catalog), "byte-length");
  meta = makeMetadata(catalog); meta.data.sha256 = "xyz";
  expectCode(() => validateCtxTileMetadata(meta, catalog), "checksum");
  meta = makeMetadata(catalog); meta.georeference.transform_gdal_order[0] += 1;
  expectCode(() => validateCtxTileMetadata(meta, catalog), "georeference");
  meta = makeMetadata(catalog); meta.georeference.transform_gdal_order[0] += 20;
  expectCode(() => validateCtxTileMetadata(meta, catalog), "georeference");
  meta = makeMetadata(catalog); meta.georeference.projection.planetary_radius_m = 3396160;
  expectCode(() => validateCtxTileMetadata(meta, catalog), "projection-mismatch");
  meta = makeMetadata(catalog); meta.tile_id = "ctx_r000_c999";
  expectCode(() => validateCtxTileMetadata(meta, catalog), "tile-id-mismatch");
  meta = makeMetadata(catalog); delete meta.vertical_reference;
  expectCode(() => validateCtxTileMetadata(meta, catalog), "vertical-reference");
});
test("complete tile collection requires each sidecar and consistent CRS metadata", () => {
  const catalog = makeCatalog(), metadata = catalog.tiles.map(() => makeMetadata(catalog));
  metadata[1].tile_id = catalog.tiles[1].tile_id;
  metadata[1].source_window = { ...catalog.tiles[1].source_window, indexing: "zero-based half-open offsets [offset, offset + size)" };
  metadata[1].core_window = { ...catalog.tiles[1].core_window, indexing: "zero-based half-open offsets [offset, offset + size)" };
  metadata[1].core_window_in_tile = { row_off: 0, col_off: 1, height: 4, width: 3 };
  metadata[1].width = 4; metadata[1].height = 4;
  metadata[1].data = { ...metadata[1].data, filename: "ctx_r000_c001.f32", expected_bytes: 64 };
  metadata[1].georeference = { ...metadata[1].georeference, transform_gdal_order: [1040, 20, 0, 2000, 0, -20],
    projected_bounds_m: [1040, 1920, 1120, 2000] };
  metadata[1].neighbors = { north: null, south: null, west: "ctx_r000_c000", east: null };
  assert.equal(validateCtxTileCollection(catalog, metadata), true);
  metadata[1].catalog_source_crs = { ...catalog.source_crs, projection: { ...catalog.source_crs.projection, planetary_radius_m: 3396160 } };
  expectCode(() => validateCtxTileCollection(catalog, metadata), "crs-mismatch");
});
test("decodes little-endian Float32 values, preserves NaN, and retains metadata", () => {
  const metadata = makeMetadata();
  const buffer = new ArrayBuffer(metadata.data.expected_bytes), view = new DataView(buffer);
  const values = [1.25, -17.5, NaN, 3.75, ...Array(12).fill(0)];
  values.forEach((value, i) => view.setFloat32(i * 4, value, true));
  const decoded = decodeCtxTile(buffer, metadata);
  assert.ok(decoded instanceof Float32Array);
  assert.deepEqual(Array.from(decoded.slice(0, 2)), [1.25, -17.5]);
  assert.ok(Number.isNaN(decoded[2]));
  assert.equal(decoded.metadata, metadata);
});
test("rejects truncated, oversized, misdeclared, and invalid-dimension buffers", () => {
  const metadata = makeMetadata(), buffer = new ArrayBuffer(64);
  expectCode(() => decodeCtxTile(new ArrayBuffer(60), metadata), "byte-length");
  expectCode(() => decodeCtxTile(new ArrayBuffer(68), metadata), "byte-length");
  expectCode(() => decodeCtxTile(buffer, { ...metadata, width: 0 }), "dimensions");
  expectCode(() => decodeCtxTile(buffer, { ...metadata, width: 501, height: 500 }), "cell-limit");
  expectCode(() => decodeCtxTile(buffer, { ...metadata, data: { ...metadata.data, byte_order: "big-endian" } }), "encoding");
});
