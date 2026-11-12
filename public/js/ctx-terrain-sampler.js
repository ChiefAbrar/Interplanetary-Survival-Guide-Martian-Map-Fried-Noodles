import { validateCtxTileCatalog } from "./ctx-tile-format.js";
import { cellSpacingX, horizontalDistance } from "./terrain.js";

export class CtxTerrainSamplerError extends Error {
  constructor(message, code, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CtxTerrainSamplerError";
    this.code = code;
    if (cause !== undefined && this.cause === undefined) this.cause = cause;
  }
}

const finitePoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y);
const keyJson = value => JSON.stringify(value, (key, item) => {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  return Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]]));
});

/**
 * Create a synchronous, core-owned CTX sampler over the manager's bounded tile cache.
 * Coordinates are local projected metres from the source raster's northwest outer corner.
 */
export function createCtxTerrainSampler({ manager, catalog = null } = {}) {
  if (!manager || typeof manager.loadCatalog !== "function" || typeof manager.loadTile !== "function" ||
      typeof manager.getCachedTile !== "function" || typeof manager.getCacheStats !== "function")
    throw new CtxTerrainSamplerError("A CTX tile manager with catalog, load, cache lookup and stats methods is required.", "configuration");
  if (catalog) {
    try { validateCtxTileCatalog(catalog); }
    catch (cause) { throw new CtxTerrainSamplerError(`Invalid CTX sampler catalog: ${cause.message}`, "invalid-catalog", cause); }
  }

  let activeCatalog = null, initializePromise = null;
  let width = 0, height = 0, cellX = 0, cellY = 0, widthM = 0, heightM = 0, geo = null;
  let ownershipRows = null, ownershipSpanCount = 0;
  const recentLoadFailures = new Map();

  function buildIndex(sourceCatalog) {
    activeCatalog = sourceCatalog;
    const grid = sourceCatalog.source_grid, transform = grid.transform_gdal_order, crs = sourceCatalog.source_crs;
    width = grid.width; height = grid.height;
    cellX = transform[1]; cellY = Math.abs(transform[5]);
    widthM = width * cellX; heightM = height * cellY;
    geo = { type: "equirectangular", radiusM: crs.projection.planetary_radius_m,
      centerLatDeg: crs.projection.latitude_of_projection_origin_deg,
      centerLonDeg: crs.projection.longitude_of_central_meridian_deg,
      originXM: transform[0], originYM: transform[3], standardParallelDeg: crs.projection.standard_parallel_deg };
    ownershipRows = Array.from({ length: height }, () => []);
    ownershipSpanCount = 0;
    for (const tile of sourceCatalog.tiles) {
      const core = tile.core_window;
      const span = { startColumn: core.col_off, endColumn: core.col_off + core.width, tileId: tile.tile_id };
      for (let row = core.row_off; row < core.row_off + core.height; row++) {
        ownershipRows[row].push(span);
        ownershipSpanCount++;
      }
    }
    for (let row = 0; row < ownershipRows.length; row++) {
      const spans = ownershipRows[row];
      spans.sort((a, b) => a.startColumn - b.startColumn);
      for (let i = 1; i < spans.length; i++) {
        if (spans[i - 1].endColumn > spans[i].startColumn)
          throw new CtxTerrainSamplerError(`Source row ${row} has duplicate core ownership.`, "duplicate-core-ownership");
      }
    }
  }

  async function loadCatalog() {
    if (activeCatalog) return activeCatalog;
    if (initializePromise) return initializePromise;
    initializePromise = (async () => {
      let fetched;
      try { fetched = await manager.loadCatalog(); }
      catch (cause) { throw new CtxTerrainSamplerError(`Could not load the CTX catalog: ${cause.message}`, "catalog-load-failed", cause); }
      try { validateCtxTileCatalog(fetched); }
      catch (cause) { throw new CtxTerrainSamplerError(`Invalid CTX sampler catalog: ${cause.message}`, "invalid-catalog", cause); }
      if (catalog && keyJson(catalog) !== keyJson(fetched))
        throw new CtxTerrainSamplerError("The supplied CTX catalog differs from the tile manager catalog.", "catalog-mismatch");
      buildIndex(catalog || fetched);
      return activeCatalog;
    })();
    try { return await initializePromise; }
    catch (error) { initializePromise = null; throw error; }
  }

  function assertReady() {
    if (!activeCatalog) throw new CtxTerrainSamplerError("Load the CTX catalog before sampling.", "catalog-not-loaded");
  }

  function getTileOwner(sourceRow, sourceColumn) {
    assertReady();
    if (!Number.isInteger(sourceRow) || !Number.isInteger(sourceColumn) || sourceRow < 0 || sourceColumn < 0 || sourceRow >= height || sourceColumn >= width)
      throw new CtxTerrainSamplerError(`Source cell (${sourceRow}, ${sourceColumn}) is outside the raster.`, "source-index-out-of-bounds");
    const spans = ownershipRows[sourceRow];
    let lo = 0, hi = spans.length - 1, found = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, span = spans[mid];
      if (sourceColumn < span.startColumn) hi = mid - 1;
      else if (sourceColumn >= span.endColumn) lo = mid + 1;
      else {
        if (found) throw new CtxTerrainSamplerError(`Source cell (${sourceRow}, ${sourceColumn}) has multiple core owners.`, "duplicate-core-ownership");
        found = span.tileId;
        break;
      }
    }
    if (!found) throw new CtxTerrainSamplerError(`No tile core owns source cell (${sourceRow}, ${sourceColumn}).`, "missing-core-ownership");
    return found;
  }

  function positionSupport(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= widthM || y >= heightM)
      return { outside: true };
    const gridX = x / cellX - 0.5, gridY = y / cellY - 0.5;
    const column0 = Math.floor(gridX), row0 = Math.floor(gridY);
    // Match terrain.elevationAt's single containing-cell fallback at any outer raster edge.
    if (column0 < 0 || row0 < 0 || column0 + 1 >= width || row0 + 1 >= height) {
      const column = Math.floor(x / cellX), row = Math.floor(y / cellY);
      return { outside: false, fallback: true, sourceRow: row, sourceColumn: column,
        support: [{ row, column }], fractionX: null, fractionY: null };
    }
    const fx = gridX - column0, fy = gridY - row0;
    return { outside: false, fallback: false, sourceRow: row0, sourceColumn: column0, fractionX: fx, fractionY: fy,
      support: [
        { row: row0, column: column0 },
        { row: row0, column: column0 + 1 },
        { row: row0 + 1, column: column0 },
        { row: row0 + 1, column: column0 + 1 }
      ] };
  }

  function ownerForPosition(x, y) {
    const location = positionSupport(x, y);
    if (location.outside) return { outside: true, location };
    return { outside: false, location, tileId: getTileOwner(location.sourceRow, location.sourceColumn) };
  }

  function sampleDetailsAt(x, y) {
    assertReady();
    const projectedX = activeCatalog.source_grid.transform_gdal_order[0] + x;
    const projectedY = activeCatalog.source_grid.transform_gdal_order[3] - y;
    const location = positionSupport(x, y);
    const base = { isValid: false, elevationM: null, invalidReason: null, datasetId: activeCatalog.dataset_id,
      tileId: null, sourceRow: null, sourceColumn: null, nativeSpatialResolutionM: { x: cellX, y: cellY },
      samplingMethod: location.fallback ? "containing-cell-edge-fallback" : "bilinear",
      localCoordinatesM: { x, y }, projectedCoordinatesM: { x: projectedX, y: projectedY },
      sourcePixelCoordinates: Number.isFinite(x) && Number.isFinite(y) ? { column: x / cellX - 0.5, row: y / cellY - 0.5 } : null };
    if (location.outside) return { ...base, invalidReason: "outside-mosaic-coverage" };
    const tileId = getTileOwner(location.sourceRow, location.sourceColumn);
    const tile = manager.getCachedTile(tileId);
    if (!tile) {
      if (recentLoadFailures.has(tileId))
        throw new CtxTerrainSamplerError(`Tile ${tileId} failed to load or verify; retry ensureTilesForPath() before sampling.`, "tile-load-failed", recentLoadFailures.get(tileId));
      throw new CtxTerrainSamplerError(`Tile ${tileId} is required for this sample but is not loaded.`, "tile-not-loaded");
    }
    const metadata = tile.metadata, sourceWindow = metadata.source_window, elevations = tile.elevations;
    const values = [];
    for (const cell of location.support) {
      const localRow = cell.row - sourceWindow.row_off, localColumn = cell.column - sourceWindow.col_off;
      if (localRow < 0 || localColumn < 0 || localRow >= metadata.height || localColumn >= metadata.width ||
          localRow >= elevations.length / metadata.width)
        return { ...base, tileId, sourceRow: location.sourceRow, sourceColumn: location.sourceColumn,
          invalidReason: "missing-adjacent-support-cells" };
      const value = elevations[localRow * metadata.width + localColumn];
      if (!Number.isFinite(value)) return { ...base, tileId, sourceRow: location.sourceRow, sourceColumn: location.sourceColumn,
        invalidReason: "source-no-data-support", supportCell: { row: cell.row, column: cell.column } };
      values.push(value);
    }
    const elevationM = location.fallback ? values[0]
      : (values[0] * (1 - location.fractionX) + values[1] * location.fractionX) * (1 - location.fractionY) +
        (values[2] * (1 - location.fractionX) + values[3] * location.fractionX) * location.fractionY;
    return { ...base, isValid: true, elevationM, invalidReason: null, tileId,
      sourceRow: location.sourceRow, sourceColumn: location.sourceColumn };
  }

  function elevationAt(x, y) {
    const sample = sampleDetailsAt(x, y);
    return sample.isValid ? sample.elevationM : null;
  }

  function samplePositionsForPath(waypoints, sampleSpacingFraction) {
    if (!Array.isArray(waypoints)) throw new CtxTerrainSamplerError("waypoints must be an ordered array.", "invalid-waypoints");
    if (!(Number.isFinite(sampleSpacingFraction) && sampleSpacingFraction > 0 && sampleSpacingFraction <= 1))
      throw new CtxTerrainSamplerError("sampleSpacingFraction must be greater than 0 and at most 1.", "invalid-sampling-interval");
    if (waypoints.length < 2) return { points: [], skippedSampleCount: 0 };
    const points = [], add = point => { if (finitePoint(point)) points.push({ x: point.x, y: point.y }); };
    let skippedSampleCount = 0;
    add(waypoints[0]);
    if (!finitePoint(waypoints[0])) skippedSampleCount++;
    for (let leg = 0; leg < waypoints.length - 1; leg++) {
      const a = waypoints[leg], b = waypoints[leg + 1];
      if (!finitePoint(a) || !finitePoint(b)) {
        if (finitePoint(b)) add(b); else skippedSampleCount++;
        continue;
      }
      const dxCells = (b.x - a.x) / cellX, dyCells = (b.y - a.y) / cellY;
      const midpointRow = ((a.y + b.y) / 2) / cellY - 0.5;
      const intervalM = Math.min(cellSpacingX(geometry(), midpointRow), cellY) * sampleSpacingFraction;
      const legDistanceM = horizontalDistance(geometry(), dxCells, dyCells, midpointRow, midpointRow);
      const intervals = Number.isFinite(legDistanceM) && legDistanceM > 0 && Number.isFinite(intervalM) && intervalM > 0
        ? Math.max(1, Math.ceil(legDistanceM / intervalM)) : 1;
      for (let n = 1; n <= intervals; n++) {
        const fraction = n / intervals;
        add({ x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction });
      }
    }
    return { points, skippedSampleCount };
  }

  const geometry = () => ({ width, height, cellX, cellY, widthM, heightM, geo });

  async function ensureTilesForPath(waypoints, { sampleSpacingFraction = 0.5 } = {}) {
    await loadCatalog();
    const { points, skippedSampleCount } = samplePositionsForPath(waypoints, sampleSpacingFraction);
    const required = new Set(); let outsideSampleCount = 0;
    for (const point of points) {
      const ownership = ownerForPosition(point.x, point.y);
      if (ownership.outside) { outsideSampleCount++; continue; }
      required.add(ownership.tileId);
    }
    const requiredTileIds = [...required];
    const capacity = manager.getCacheStats().maxCachedTiles;
    if (!Number.isSafeInteger(capacity) || capacity <= 0)
      throw new CtxTerrainSamplerError("Tile manager did not report a valid cache capacity.", "manager-configuration");
    if (requiredTileIds.length > capacity)
      throw new CtxTerrainSamplerError(`Route requires ${requiredTileIds.length} tiles but the manager cache holds only ${capacity}.`, "cache-capacity");

    const alreadyCached = new Set();
    // Refresh required hits first so unrelated old cache entries are preferentially evicted.
    for (const tileId of requiredTileIds) if (manager.getCachedTile(tileId)) alreadyCached.add(tileId);
    const loadIds = requiredTileIds.filter(tileId => !alreadyCached.has(tileId));
    try {
      await Promise.all(loadIds.map(async tileId => {
        recentLoadFailures.delete(tileId);
        try { await manager.loadTile(tileId); }
        catch (cause) { recentLoadFailures.set(tileId, cause); throw cause; }
      }));
    } catch (cause) {
      throw new CtxTerrainSamplerError(`Could not load all route corridor tiles: ${cause.message}`, "tile-load-failed", cause);
    }
    const missingAfterLoad = requiredTileIds.filter(tileId => !manager.getCachedTile(tileId));
    if (missingAfterLoad.length)
      throw new CtxTerrainSamplerError(`Required route tiles did not remain in the bounded cache: ${missingAfterLoad.join(", ")}.`, "cache-capacity");
    for (const tileId of loadIds) recentLoadFailures.delete(tileId);
    const skippedTileCount = activeCatalog.tiles.length - requiredTileIds.length;
    return { requiredTileCount: requiredTileIds.length, loadedTileCount: loadIds.length,
      cachedTileCount: alreadyCached.size, skippedTileCount, skippedSampleCount: skippedSampleCount + outsideSampleCount,
      outsideSampleCount, requiredTileIds };
  }

  function getOwnershipIndexStats() {
    assertReady();
    return { sourceRowsIndexed: ownershipRows.length, coreRowSpans: ownershipSpanCount };
  }

  return {
    loadCatalog, ensureTilesForPath, getTileOwner, sampleDetailsAt, elevationAt, getOwnershipIndexStats,
    get width() { return width; }, get height() { return height; }, get cellX() { return cellX; }, get cellY() { return cellY; },
    get widthM() { return widthM; }, get heightM() { return heightM; }, get geo() { return geo; },
    get datasetId() { return activeCatalog?.dataset_id ?? null; }
  };
}
