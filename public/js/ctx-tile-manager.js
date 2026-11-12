import {
  validateCtxTileCatalog, validateCtxTileMetadata, decodeCtxTile, CtxTileFormatError
} from "./ctx-tile-format.js";

export class CtxTileManagerError extends Error {
  constructor(message, code, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CtxTileManagerError";
    this.code = code;
    if (cause !== undefined && this.cause === undefined) this.cause = cause;
  }
}

const positiveLimit = (value, name) => {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new CtxTileManagerError(`${name} must be a positive safe integer.`, "configuration");
  return value;
};

function absoluteBase(value, fallback) {
  const base = new URL(value || fallback, globalThis.location?.href || "http://localhost/");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return base;
}

function responseIsOk(response) {
  return response && (response.ok === true || (response.ok === undefined && response.status >= 200 && response.status < 300));
}

function toHex(bytes) {
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

/** Create a bounded, checksum-verifying loader for the versioned CTX tile collection. */
export function createCtxTerrainManager({
  catalogUrl,
  tileBaseUrl,
  maxCachedTiles = 12,
  maxConcurrentLoads = 4,
  fetchImpl = globalThis.fetch
} = {}) {
  if (typeof catalogUrl !== "string" || !catalogUrl.trim())
    throw new CtxTileManagerError("catalogUrl is required.", "configuration");
  positiveLimit(maxCachedTiles, "maxCachedTiles");
  positiveLimit(maxConcurrentLoads, "maxConcurrentLoads");
  if (typeof fetchImpl !== "function") throw new CtxTileManagerError("A fetch implementation is required.", "configuration");

  let catalogPromise = null, catalog = null, recordById = new Map();
  let activeLoads = 0, cacheGeneration = 0;
  const inFlight = new Map(), cache = new Map(), loadQueue = [];
  const catalogAbsoluteUrl = new URL(catalogUrl, globalThis.location?.href || "http://localhost/");
  const resolvedTileBase = absoluteBase(tileBaseUrl, new URL(".", catalogAbsoluteUrl).href);

  async function fetchResource(url, category) {
    let response;
    try { response = await fetchImpl(url); }
    catch (cause) { throw new CtxTileManagerError(`Network failure loading ${url}.`, category, cause); }
    if (!responseIsOk(response)) {
      const status = response?.status ?? "unknown";
      throw new CtxTileManagerError(`HTTP ${status} loading ${url}.`, category);
    }
    return response;
  }

  function scheduleLoad(task) {
    return new Promise((resolve, reject) => {
      loadQueue.push({ task, resolve, reject });
      pumpQueue();
    });
  }

  function pumpQueue() {
    while (activeLoads < maxConcurrentLoads && loadQueue.length) {
      const item = loadQueue.shift();
      activeLoads++;
      Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => {
        activeLoads--;
        pumpQueue();
      });
    }
  }

  function touchCache(tileId) {
    const tile = cache.get(tileId);
    if (!tile) return null;
    cache.delete(tileId);
    cache.set(tileId, tile);
    return tile;
  }

  function remember(tileId, tile, generation) {
    if (generation !== cacheGeneration) return;
    cache.delete(tileId);
    cache.set(tileId, tile);
    while (cache.size > maxCachedTiles) cache.delete(cache.keys().next().value);
  }

  async function loadCatalog() {
    if (catalog) return catalog;
    if (catalogPromise) return catalogPromise;
    catalogPromise = (async () => {
      const response = await fetchResource(catalogAbsoluteUrl.href, "catalog-load");
      let parsed;
      try { parsed = await response.json(); }
      catch (cause) { throw new CtxTileManagerError("Catalog response is not valid JSON.", "invalid-catalog", cause); }
      try { validateCtxTileCatalog(parsed); }
      catch (cause) {
        const code = cause instanceof CtxTileFormatError ? "invalid-catalog" : "invalid-catalog";
        throw new CtxTileManagerError(`CTX catalog validation failed: ${cause.message}`, code, cause);
      }
      catalog = parsed;
      recordById = new Map(parsed.tiles.map(record => [record.tile_id, record]));
      return catalog;
    })();
    try { return await catalogPromise; }
    catch (error) { catalogPromise = null; throw error; }
  }

  async function digestSha256(buffer) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle || typeof subtle.digest !== "function")
      throw new CtxTileManagerError("Web Crypto SHA-256 is unavailable; refusing to load an unverified tile.", "crypto-unavailable");
    try { return toHex(new Uint8Array(await subtle.digest("SHA-256", buffer))); }
    catch (cause) { throw new CtxTileManagerError("Web Crypto could not compute the CTX tile SHA-256.", "checksum-unavailable", cause); }
  }

  async function performTileLoad(record, generation) {
    const metadataUrl = new URL(record.metadata_file, resolvedTileBase).href;
    const binaryUrl = new URL(record.data_file, resolvedTileBase).href;
    let sidecarResponse, metadata;
    try {
      sidecarResponse = await fetchResource(metadataUrl, "metadata-load");
      try { metadata = await sidecarResponse.json(); }
      catch (cause) { throw new CtxTileManagerError(`Tile metadata ${record.tile_id} is not valid JSON.`, "invalid-metadata", cause); }
      try { validateCtxTileMetadata(metadata, catalog); }
      catch (cause) { throw new CtxTileManagerError(`Tile metadata ${record.tile_id} failed validation: ${cause.message}`, "invalid-metadata", cause); }
    } catch (error) {
      if (error instanceof CtxTileManagerError) throw error;
      throw new CtxTileManagerError(`Could not load metadata for tile ${record.tile_id}.`, "metadata-load", error);
    }

    let buffer;
    try {
      const binaryResponse = await fetchResource(binaryUrl, "binary-load");
      buffer = await binaryResponse.arrayBuffer();
    } catch (error) {
      if (error instanceof CtxTileManagerError) throw error;
      throw new CtxTileManagerError(`Could not load binary data for tile ${record.tile_id}.`, "binary-load", error);
    }
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== metadata.data.expected_bytes)
      throw new CtxTileManagerError(`Tile ${record.tile_id} has ${buffer?.byteLength ?? "invalid"} binary bytes; expected ${metadata.data.expected_bytes}.`, "binary-length");

    const actualHash = await digestSha256(buffer);
    if (actualHash !== metadata.data.sha256.toLowerCase())
      throw new CtxTileManagerError(`SHA-256 mismatch for CTX tile ${record.tile_id}.`, "checksum-mismatch");

    let elevations;
    try { elevations = decodeCtxTile(buffer, metadata); }
    catch (cause) { throw new CtxTileManagerError(`Could not decode binary data for tile ${record.tile_id}: ${cause.message}`, "binary-decode", cause); }
    // Drop the fetched ArrayBuffer reference before the tile enters the cache.
    buffer = null;
    const tile = { tileId: record.tile_id, elevations, metadata };
    remember(record.tile_id, tile, generation);
    return tile;
  }

  async function loadTile(tileId) {
    await loadCatalog();
    if (typeof tileId !== "string" || !recordById.has(tileId))
      throw new CtxTileManagerError(`Unknown CTX tile ID ${JSON.stringify(tileId)}.`, "unknown-tile");
    const cached = touchCache(tileId);
    if (cached) return cached;
    if (inFlight.has(tileId)) return inFlight.get(tileId);
    const record = recordById.get(tileId), generation = cacheGeneration;
    const promise = scheduleLoad(() => performTileLoad(record, generation));
    inFlight.set(tileId, promise);
    try { return await promise; }
    finally { if (inFlight.get(tileId) === promise) inFlight.delete(tileId); }
  }

  function getCachedTile(tileId) {
    return touchCache(tileId);
  }

  function peekCachedTile(tileId) {
    return cache.get(tileId) ?? null;
  }

  function clearCache() {
    cache.clear();
    cacheGeneration++;
  }

  function getCacheStats() {
    let elevationArrayMemoryBytes = 0;
    for (const tile of cache.values()) elevationArrayMemoryBytes += tile.elevations.byteLength;
    return {
      cachedTileCount: cache.size,
      maxCachedTiles,
      inFlightLoadCount: inFlight.size,
      maxConcurrentLoads,
      activeLoadCount: activeLoads,
      queuedLoadCount: loadQueue.length,
      cachedTileIds: [...cache.keys()],
      estimatedElevationArrayMemoryBytes: elevationArrayMemoryBytes
    };
  }

  return { loadCatalog, loadTile, getCachedTile, peekCachedTile, clearCache, getCacheStats };
}
