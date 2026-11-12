/** Browser-side validation and decoding for the preprocessed Jezero CTX tile format. */

export const CTX_TILE_CATALOG_FORMAT = "mars-survival-ctx-tile-catalog";
export const CTX_TILE_FORMAT = "mars-survival-ctx-f32-tile";
export const CTX_TILE_VERSION = 2;
export const CTX_TILE_SIDECAR_VERSION = 1;
export const MAX_CTX_TILE_CELLS = 250_000;

export class CtxTileFormatError extends Error {
  constructor(message, code = "ctx-tile-format") {
    super(message);
    this.name = "CtxTileFormatError";
    this.code = code;
  }
}

const fail = (message, code) => { throw new CtxTileFormatError(message, code); };
const finite = value => typeof value === "number" && Number.isFinite(value);
const positiveInt = value => Number.isInteger(value) && value > 0;
const sha256 = value => typeof value === "string" && /^[a-f\d]{64}$/i.test(value);
const safeFilename = value => typeof value === "string" && value.length > 0 &&
  !/[\\/\0]/.test(value) && value !== "." && value !== "..";
const canonicalJson = value => JSON.stringify(value, (key, item) => {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  return Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]]));
});

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object.`, "metadata");
}

function requireWindow(value, name, gridWidth, gridHeight) {
  requireObject(value, name);
  const { row_off: row, col_off: col, height, width } = value;
  if (![row, col].every(v => Number.isInteger(v) && v >= 0) || !positiveInt(width) || !positiveInt(height))
    fail(`${name} must have non-negative integer offsets and positive integer dimensions.`, "window");
  if (col + width > gridWidth || row + height > gridHeight)
    fail(`${name} extends outside the ${gridWidth} × ${gridHeight} source grid.`, "window-bounds");
  return { row, col, width, height };
}

function sameNumber(a, b, tolerance = 1e-6) {
  return finite(a) && finite(b) && Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
}

function validateTransform(transform, name) {
  if (!Array.isArray(transform) || transform.length !== 6 || !transform.every(finite))
    fail(`${name} must contain six finite GDAL geotransform values.`, "georeference");
}

function validateSourceCrs(crs, grid) {
  requireObject(crs, "Catalog source_crs");
  if (typeof crs.crs_name !== "string" || !crs.crs_name || typeof crs.wkt !== "string" || !crs.wkt ||
      crs.projection_method !== "Equirectangular" || crs.planetary_body !== "Mars")
    fail("Catalog source_crs requires the verified CRS name, WKT, Equirectangular method, and planetary body.", "crs");
  const p = crs.projection;
  requireObject(p, "Catalog source_crs.projection");
  if (p.name !== crs.projection_method || !finite(p.planetary_radius_m) || p.planetary_radius_m <= 0 ||
      !finite(p.standard_parallel_deg) || !finite(p.latitude_of_projection_origin_deg) || !finite(p.longitude_of_central_meridian_deg) ||
      p.latitude_type !== "Planetocentric" || p.longitude_direction !== "Positive East" || p.horizontal_coordinate_units !== "m")
    fail("Catalog source_crs projection parameters or coordinate conventions are invalid.", "crs");
  if (!crs.wkt.includes(crs.crs_name) || !/Equirectangular/i.test(crs.wkt) || !/AXIS\s*\[\s*\"?EASTING\"?\s*,\s*EAST/i.test(crs.wkt))
    fail("Catalog source_crs WKT is missing the declared projection name or east-positive projected axis.", "crs-wkt");
  const wktNumber = (pattern, name) => {
    const match = crs.wkt.match(pattern);
    if (!match || !sameNumber(Number(match[1]), p[name])) fail(`Catalog source_crs WKT disagrees with projection.${name}.`, "crs-wkt");
  };
  wktNumber(/SPHEROID\s*\[\s*\"[^\"]+\"\s*,\s*([\d.eE+-]+)/i, "planetary_radius_m");
  wktNumber(/PARAMETER\s*\[\s*\"standard_parallel_1\"\s*,\s*([\d.eE+-]+)/i, "standard_parallel_deg");
  const originMatch = crs.wkt.match(/PARAMETER\s*\[\s*\"(?:latitude_of_projection_origin|latitude_of_origin)\"\s*,\s*([\d.eE+-]+)/i);
  if (originMatch) {
    if (!sameNumber(Number(originMatch[1]), p.latitude_of_projection_origin_deg)) fail("Catalog source CRS WKT disagrees with projection.latitude_of_projection_origin_deg.", "crs-wkt");
  } else if (!sameNumber(p.latitude_of_projection_origin_deg, 0)) {
    fail("Catalog source CRS WKT omits a non-zero latitude of origin.", "crs-wkt");
  }
  wktNumber(/PARAMETER\s*\[\s*\"central_meridian\"\s*,\s*([\d.eE+-]+)/i, "longitude_of_central_meridian_deg");
  if (crs.vertical_reference?.units !== "m" || typeof crs.vertical_reference.datum !== "string" ||
      !/unknown/i.test(crs.vertical_reference.datum) || crs.vertical_reference.vertical_accuracy_m !== null ||
      typeof crs.vertical_reference.vertical_accuracy_status !== "string" || !/unknown/i.test(crs.vertical_reference.vertical_accuracy_status))
    fail("Catalog source_crs must preserve metre vertical units while marking datum and numeric accuracy unknown.", "vertical-reference");
  if (typeof crs.pixel_registration !== "string" || !/upper-left outer corner/i.test(crs.pixel_registration))
    fail("Catalog source_crs pixel_registration is missing or unsupported.", "registration");
  validateTransform(crs.source_geotransform_gdal_order, "Catalog source_crs.source_geotransform_gdal_order");
  if (!crs.source_geotransform_gdal_order.every((v, i) => sameNumber(v, grid.transform_gdal_order[i])))
    fail("Catalog source CRS geotransform differs from source_grid.", "georeference");
  if (crs.raster_dimensions?.width !== grid.width || crs.raster_dimensions?.height !== grid.height ||
      !Array.isArray(crs.native_posting_m) || crs.native_posting_m.length !== 2 ||
      !sameNumber(crs.native_posting_m[0], Math.abs(grid.transform_gdal_order[1])) ||
      !sameNumber(crs.native_posting_m[1], Math.abs(grid.transform_gdal_order[5])))
    fail("Catalog source CRS raster dimensions or native posting differ from source_grid.", "georeference");
  if (!Array.isArray(crs.verified_properties) || !crs.verified_properties.length || !Array.isArray(crs.unknown_properties) ||
      !crs.unknown_properties.some(value => /vertical datum/i.test(value)) || !crs.unknown_properties.some(value => /vertical accuracy/i.test(value)))
    fail("Catalog source_crs must distinguish verified from unknown properties.", "crs");
}

/** Validate the catalog and return it unchanged for convenient composition. */
export function validateCtxTileCatalog(catalog) {
  requireObject(catalog, "CTX tile catalog");
  if (catalog.format !== CTX_TILE_CATALOG_FORMAT) fail(`Unsupported CTX catalog format ${JSON.stringify(catalog.format)}.`, "format");
  if (catalog.version !== CTX_TILE_VERSION) fail(`Unsupported CTX catalog version ${JSON.stringify(catalog.version)}.`, "version");
  if (typeof catalog.dataset_id !== "string" || !catalog.dataset_id.trim()) fail("Catalog dataset_id is required.", "dataset");

  const source = catalog.source_raster, grid = catalog.source_grid, tiling = catalog.tiling;
  requireObject(source, "Catalog source_raster");
  if (!safeFilename(source.filename) || !positiveInt(source.size_bytes) || !sha256(source.sha256) || typeof source.metadata_url !== "string" || !source.metadata_url)
    fail("Catalog source_raster requires a filename, positive size_bytes, SHA-256, and metadata_url.", "source-raster");
  requireObject(grid, "Catalog source_grid");
  if (!positiveInt(grid.width) || !positiveInt(grid.height)) fail("Catalog source_grid width and height must be positive integers.", "dimensions");
  validateTransform(grid.transform_gdal_order, "Catalog source_grid.transform_gdal_order");
  const tr = grid.transform_gdal_order;
  if (tr[1] <= 0 || tr[5] >= 0 || !sameNumber(tr[2], 0) || !sameNumber(tr[4], 0))
    fail("Catalog grid must use north-up, unrotated pixels with positive x and negative y spacing.", "georeference");
  validateSourceCrs(catalog.source_crs, grid);
  requireObject(tiling, "Catalog tiling");
  if (!positiveInt(tiling.maximum_cells) || tiling.maximum_cells > MAX_CTX_TILE_CELLS || !Number.isInteger(tiling.halo_cells) || tiling.halo_cells < 0 ||
      !positiveInt(tiling.full_grid_rows) || !positiveInt(tiling.full_grid_columns))
    fail("Catalog tiling limits, halo, and full grid dimensions are invalid.", "tiling");
  for (const key of ["selected_tile_rows_half_open", "selected_tile_columns_half_open"]) {
    const range = tiling[key];
    const limit = key.includes("rows") ? tiling.full_grid_rows : tiling.full_grid_columns;
    if (!Array.isArray(range) || range.length !== 2 || !Number.isInteger(range[0]) || !Number.isInteger(range[1]) || range[0] < 0 || range[1] <= range[0] || range[1] > limit)
      fail(`Catalog tiling.${key} must be a valid half-open grid range.`, "tiling");
  }
  if (typeof tiling.is_partial_selection !== "boolean") fail("Catalog tiling.is_partial_selection must be boolean.", "tiling");
  if (!Array.isArray(catalog.tiles) || !catalog.tiles.length) fail("Catalog tiles must be a non-empty array.", "tiles");

  const ids = new Set(), gridCells = new Set(), cores = [];
  for (const [index, tile] of catalog.tiles.entries()) {
    requireObject(tile, `Catalog tile ${index}`);
    if (typeof tile.tile_id !== "string" || !/^ctx_r\d{3}_c\d{3}$/.test(tile.tile_id)) fail(`Catalog tile ${index} has an invalid tile_id.`, "tile-id");
    if (ids.has(tile.tile_id)) fail(`Duplicate tile ID ${tile.tile_id}.`, "duplicate-tile");
    ids.add(tile.tile_id);
    const match = /^ctx_r(\d{3})_c(\d{3})$/.exec(tile.tile_id);
    const tileRow = Number(match[1]), tileCol = Number(match[2]);
    if (tileRow >= tiling.full_grid_rows || tileCol >= tiling.full_grid_columns) fail(`Tile ${tile.tile_id} is outside the declared tile grid.`, "tile-grid");
    const rowRange = tiling.selected_tile_rows_half_open, colRange = tiling.selected_tile_columns_half_open;
    if (tileRow < rowRange[0] || tileRow >= rowRange[1] || tileCol < colRange[0] || tileCol >= colRange[1])
      fail(`Tile ${tile.tile_id} is outside the selected tile ranges.`, "tile-grid");
    const gridKey = `${tileRow}:${tileCol}`;
    if (gridCells.has(gridKey)) fail(`Duplicate tile-grid position ${gridKey}.`, "duplicate-tile");
    gridCells.add(gridKey);
    if (!safeFilename(tile.metadata_file) || !safeFilename(tile.data_file) || tile.metadata_file !== `${tile.tile_id}.json` || tile.data_file !== `${tile.tile_id}.f32`)
      fail(`Tile ${tile.tile_id} filenames must follow the <tile_id>.json and <tile_id>.f32 convention.`, "filename");
    if (!positiveInt(tile.width) || !positiveInt(tile.height) || tile.width * tile.height > tiling.maximum_cells || tile.width * tile.height > MAX_CTX_TILE_CELLS)
      fail(`Tile ${tile.tile_id} dimensions exceed the catalog cell limit or are invalid.`, "cell-limit");
    const src = requireWindow(tile.source_window, `Tile ${tile.tile_id} source_window`, grid.width, grid.height);
    const core = requireWindow(tile.core_window, `Tile ${tile.tile_id} core_window`, grid.width, grid.height);
    if (tile.width !== src.width || tile.height !== src.height) fail(`Tile ${tile.tile_id} dimensions disagree with source_window.`, "dimensions");
    if (core.row < src.row || core.col < src.col || core.row + core.height > src.row + src.height || core.col + core.width > src.col + src.width)
      fail(`Tile ${tile.tile_id} core_window is not contained in its extraction window.`, "core-window");
    const allowedHalo = tiling.halo_cells;
    if (core.row - src.row > allowedHalo || core.col - src.col > allowedHalo || src.row + src.height - core.row - core.height > allowedHalo || src.col + src.width - core.col - core.width > allowedHalo)
      fail(`Tile ${tile.tile_id} extraction window exceeds the declared halo.`, "halo");
    const expectedOriginX = tr[0] + src.col * tr[1], expectedOriginY = tr[3] + src.row * tr[5];
    if (!Array.isArray(tile.projected_coverage_m) || tile.projected_coverage_m.length !== 4 || !tile.projected_coverage_m.every(finite) ||
        !sameNumber(tile.projected_coverage_m[0], expectedOriginX) || !sameNumber(tile.projected_coverage_m[3], expectedOriginY) ||
        !sameNumber(tile.projected_coverage_m[2], expectedOriginX + src.width * tr[1]) || !sameNumber(tile.projected_coverage_m[1], expectedOriginY + src.height * tr[5]))
      fail(`Tile ${tile.tile_id} projected_coverage_m disagrees with source_grid and source_window.`, "georeference");
    cores.push({ id: tile.tile_id, ...core });
  }

  const expectedTileCount = (tiling.selected_tile_rows_half_open[1] - tiling.selected_tile_rows_half_open[0]) *
    (tiling.selected_tile_columns_half_open[1] - tiling.selected_tile_columns_half_open[0]);
  if (catalog.tiles.length !== expectedTileCount) fail(`Catalog has ${catalog.tiles.length} tiles; selected grid ranges require ${expectedTileCount}.`, "tile-count");

  for (let i = 0; i < cores.length; i++) for (let j = i + 1; j < cores.length; j++) {
    const a = cores[i], b = cores[j];
    if (a.col < b.col + b.width && b.col < a.col + a.width && a.row < b.row + b.height && b.row < a.row + a.height)
      fail(`Core ownership overlaps between ${a.id} and ${b.id}.`, "duplicate-core-ownership");
  }
  const coverage = catalog.coverage_verification;
  if (coverage !== undefined) {
    requireObject(coverage, "Catalog coverage_verification");
    if (coverage.complete_source_coverage === true) {
      const area = cores.reduce((sum, core) => sum + core.width * core.height, 0);
      if (area !== grid.width * grid.height || coverage.core_pixels_expected !== grid.width * grid.height || coverage.core_pixels_unique !== area)
        fail("Catalog claims complete source coverage but core windows do not partition the full raster.", "core-coverage");
    }
  }
  return catalog;
}

/** Validate one sidecar against its catalog entry and return the metadata unchanged. */
export function validateCtxTileMetadata(metadata, catalog) {
  validateCtxTileCatalog(catalog);
  requireObject(metadata, "CTX tile metadata");
  if (metadata.format !== CTX_TILE_FORMAT) fail(`Unsupported CTX tile format ${JSON.stringify(metadata.format)}.`, "format");
  if (metadata.version !== CTX_TILE_SIDECAR_VERSION) fail(`Unsupported CTX tile version ${JSON.stringify(metadata.version)}.`, "version");
  if (metadata.catalog_version !== CTX_TILE_VERSION || canonicalJson(metadata.catalog_source_crs) !== canonicalJson(catalog.source_crs))
    fail("Tile sidecar catalog CRS contract does not match catalog version 2.", "crs-mismatch");
  if (metadata.dataset_id !== catalog.dataset_id) fail("Tile dataset_id does not match the catalog.", "dataset");
  const record = catalog.tiles.find(tile => tile.tile_id === metadata.tile_id);
  if (!record) fail(`Tile metadata ID ${JSON.stringify(metadata.tile_id)} is not present in the catalog.`, "tile-id-mismatch");
  if (metadata.metadata_file && metadata.metadata_file !== record.metadata_file) fail(`Tile ${record.tile_id} metadata filename does not match its catalog record.`, "filename");
  const { width, height } = metadata;
  if (!positiveInt(width) || !positiveInt(height)) fail("Tile width and height must be positive integers.", "dimensions");
  if (width * height > MAX_CTX_TILE_CELLS || width * height > catalog.tiling.maximum_cells) fail(`Tile has ${width * height} cells; maximum is ${Math.min(MAX_CTX_TILE_CELLS, catalog.tiling.maximum_cells)}.`, "cell-limit");
  if (width !== record.width || height !== record.height) fail("Tile dimensions differ from the catalog record.", "dimensions");
  const grid = catalog.source_grid, source = catalog.source_raster;
  if (!metadata.source_raster || metadata.source_raster.filename !== source.filename || metadata.source_raster.size_bytes !== source.size_bytes || metadata.source_raster.sha256 !== source.sha256)
    fail("Tile source_raster identity or checksum differs from the catalog.", "source-raster");
  if (!Array.isArray(metadata.source_raster.source_geotransform_gdal_order) || metadata.source_raster.source_geotransform_gdal_order.length !== 6 ||
      !metadata.source_raster.source_geotransform_gdal_order.every((v, i) => sameNumber(v, grid.transform_gdal_order[i])))
    fail("Tile source geotransform differs from catalog.source_grid.", "georeference");
  if (typeof metadata.source_raster.source_crs_wkt !== "string" || !metadata.source_raster.source_crs_wkt)
    fail("Tile source_raster.source_crs_wkt is required to preserve the source projection.", "projection");
  const sourceWindow = requireWindow(metadata.source_window, "Tile source_window", grid.width, grid.height);
  const coreWindow = requireWindow(metadata.core_window, "Tile core_window", grid.width, grid.height);
  const localCore = metadata.core_window_in_tile;
  requireObject(localCore, "Tile core_window_in_tile");
  if (!["row_off", "col_off", "height", "width"].every(key => Number.isInteger(localCore[key])) ||
      localCore.row_off !== coreWindow.row - sourceWindow.row || localCore.col_off !== coreWindow.col - sourceWindow.col ||
      localCore.height !== coreWindow.height || localCore.width !== coreWindow.width)
    fail("Tile core_window_in_tile is inconsistent with its source and core windows.", "core-window");
  for (const key of ["row_off", "col_off", "height", "width"]) {
    if (metadata.source_window[key] !== record.source_window[key] || metadata.core_window[key] !== record.core_window[key])
      fail(`Tile ${key} windows differ from catalog record.`, "window-mismatch");
  }
  const data = metadata.data;
  requireObject(data, "Tile data");
  if (!safeFilename(data.filename) || data.filename !== record.data_file) fail("Tile data filename is missing or differs from the catalog record.", "filename");
  if (data.dtype !== "float32" || data.byte_order !== "little-endian" || data.layout !== "row-major" || data.units !== "m")
    fail("Tile data must declare little-endian row-major Float32 values in metres.", "encoding");
  if (data.expected_bytes !== width * height * 4) fail(`Tile expected_bytes must equal ${width * height * 4}.`, "byte-length");
  if (!sha256(data.sha256)) fail("Tile data.sha256 must be a 64-character hexadecimal SHA-256 digest.", "checksum");
  if (!finite(data.nodata_source_value) || data.nodata_output_value !== "IEEE-754 NaN") fail("Tile no-data conventions are missing or unsupported.", "nodata");

  const geo = metadata.georeference;
  requireObject(geo, "Tile georeference");
  validateTransform(geo.transform_gdal_order, "Tile georeference.transform_gdal_order");
  const catalogTransform = grid.transform_gdal_order, expectedTransform = [
    catalogTransform[0] + sourceWindow.col * catalogTransform[1], catalogTransform[1], catalogTransform[2],
    catalogTransform[3] + sourceWindow.row * catalogTransform[5], catalogTransform[4], catalogTransform[5]
  ];
  if (!geo.transform_gdal_order.every((v, i) => sameNumber(v, expectedTransform[i]))) fail("Tile georeference transform is inconsistent with source offset.", "georeference");
  if (!Array.isArray(geo.pixel_size_m) || geo.pixel_size_m.length !== 2 || !sameNumber(geo.pixel_size_m[0], Math.abs(catalogTransform[1])) || !sameNumber(geo.pixel_size_m[1], Math.abs(catalogTransform[5])))
    fail("Tile pixel_size_m differs from catalog source resolution.", "georeference");
  if (!finite(geo.projection?.planetary_radius_m) || !finite(geo.projection?.standard_parallel_deg) ||
      geo.projection.latitude_type !== "Planetocentric" || geo.projection.longitude_direction !== "Positive East" || geo.projection.horizontal_coordinate_units !== "m")
    fail("Tile projection metadata is missing required planetary/equirectangular parameters.", "projection");
  if (canonicalJson(geo.projection) !== canonicalJson(catalog.source_crs.projection))
    fail("Tile projection parameters differ from catalog.source_crs.", "projection-mismatch");
  if (typeof geo.crs_wkt !== "string" || !geo.crs_wkt || geo.crs_wkt !== metadata.source_raster.source_crs_wkt || geo.projection.name !== "Equirectangular")
    fail("Tile CRS must preserve the source WKT and declare its Equirectangular projection.", "projection");
  if (!metadata.vertical_reference || metadata.vertical_reference.units !== "m" || typeof metadata.vertical_reference.reference !== "string")
    fail("Tile vertical_reference must preserve its units and reference description.", "vertical-reference");
  return metadata;
}

/** Validate every sidecar in a complete selected tile collection and cross-check shared CRS values. */
export function validateCtxTileCollection(catalog, metadataCollection) {
  validateCtxTileCatalog(catalog);
  if (!Array.isArray(metadataCollection) || metadataCollection.length !== catalog.tiles.length)
    fail(`Tile metadata collection must contain exactly ${catalog.tiles.length} sidecars.`, "tile-count");
  const seen = new Set();
  for (const metadata of metadataCollection) {
    validateCtxTileMetadata(metadata, catalog);
    if (seen.has(metadata.tile_id)) fail(`Duplicate sidecar ${metadata.tile_id} in tile collection.`, "duplicate-tile");
    seen.add(metadata.tile_id);
  }
  if (catalog.tiles.some(tile => !seen.has(tile.tile_id))) fail("Tile metadata collection is missing one or more catalog tiles.", "tile-count");
  return true;
}

const nativeLittleEndian = (() => {
  const bytes = new Uint8Array(new Uint16Array([1]).buffer);
  return bytes[0] === 1;
})();

/** Decode one validated tile. The returned Float32Array has a non-enumerable metadata property. */
export function decodeCtxTile(buffer, metadata) {
  requireObject(metadata, "CTX tile metadata");
  const data = metadata.data;
  if (!positiveInt(metadata.width) || !positiveInt(metadata.height)) fail("Tile width and height must be positive integers.", "dimensions");
  if (metadata.width * metadata.height > MAX_CTX_TILE_CELLS) fail(`Tile exceeds the ${MAX_CTX_TILE_CELLS}-cell limit.`, "cell-limit");
  if (!data || data.dtype !== "float32" || data.byte_order !== "little-endian" || data.layout !== "row-major") fail("Unsupported CTX binary encoding.", "encoding");
  const expected = metadata.width * metadata.height * 4;
  if (data.expected_bytes !== expected) fail(`Tile metadata expected_bytes must equal ${expected}.`, "byte-length");
  if (!(buffer instanceof ArrayBuffer)) fail("CTX tile data must be supplied as an ArrayBuffer.", "buffer");
  if (buffer.byteLength !== expected) fail(`CTX tile buffer has ${buffer.byteLength} bytes; exactly ${expected} are required.`, "byte-length");
  let elevations;
  if (nativeLittleEndian) elevations = new Float32Array(buffer.slice(0));
  else {
    elevations = new Float32Array(metadata.width * metadata.height);
    const view = new DataView(buffer);
    for (let i = 0; i < elevations.length; i++) elevations[i] = view.getFloat32(i * 4, true);
  }
  Object.defineProperty(elevations, "metadata", { value: metadata, enumerable: false });
  return elevations;
}
