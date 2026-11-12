import { parseWmtsCapabilities, wmtsTileAt, wmtsTileUrl } from "./wmts.js";
import { localToLatLon, latLonToLocal } from "./terrain.js";

export const JEZERO_OPTICAL_LAYERS = Object.freeze({
  ctx: Object.freeze({
    label: "CTX optical · 6 m/pixel",
    id: "JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0",
    capabilitiesUrl: "https://trek.nasa.gov/tiles/Mars/EQ/JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0/1.0.0/WMTSCapabilities.xml",
    attribution: "NASA/JPL-Caltech/MSSS · NASA Mars Trek"
  }),
  hirise: Object.freeze({
    label: "HiRISE optical · 25 cm/pixel",
    id: "JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first_dd",
    capabilitiesUrl: "https://trek.nasa.gov/tiles/Mars/EQ/JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first_dd/1.0.0/WMTSCapabilities.xml",
    attribution: "NASA/JPL-Caltech/University of Arizona · NASA Mars Trek"
  })
});

export function opticalMatrixForViewport(capabilities, viewport, pixelWidth, pixelHeight) {
  const center = localToLatLon(viewport, viewport.widthM / 2, viewport.heightM / 2);
  const cosLat = Math.cos((center?.lat || 0) * Math.PI / 180);
  const target = Math.max(viewport.widthM / pixelWidth, viewport.heightM / pixelHeight);
  let best = 0, bestError = Infinity;
  capabilities.tileMatrices.forEach((matrix, index) => {
    const pixelX = 2 * Math.PI * 3396190 * cosLat / (matrix.matrixWidth * matrix.tileWidth);
    const pixelY = Math.PI * 3396190 / (matrix.matrixHeight * matrix.tileHeight);
    const error = Math.abs(Math.log(Math.max(pixelX, pixelY) / target));
    if (error < bestError) { best = index; bestError = error; }
  });
  return best;
}

export function visibleOpticalTiles(capabilities, matrixIndex, viewport, pixelWidth, pixelHeight) {
  const corners = [[0, 0], [viewport.widthM, 0], [viewport.widthM, viewport.heightM], [0, viewport.heightM]]
    .map(([x, y]) => localToLatLon(viewport, x, y)).filter(Boolean);
  if (corners.length !== 4) return [];
  const west = Math.min(...corners.map(p => p.lon)), east = Math.max(...corners.map(p => p.lon));
  const south = Math.min(...corners.map(p => p.lat)), north = Math.max(...corners.map(p => p.lat));
  const [coverageWest, coverageSouth, coverageEast, coverageNorth] = capabilities.bounds;
  if (east <= coverageWest || west >= coverageEast || north <= coverageSouth || south >= coverageNorth) return [];
  const matrix = capabilities.tileMatrices[matrixIndex];
  if (!matrix) return [];
  const spanLon = 360 / matrix.matrixWidth, spanLat = 180 / matrix.matrixHeight;
  const left = Math.max(west, coverageWest), right = Math.min(east, coverageEast);
  const bottom = Math.max(south, coverageSouth), top = Math.min(north, coverageNorth);
  const start = wmtsTileAt(capabilities, matrixIndex, left, top);
  const end = wmtsTileAt(capabilities, matrixIndex, right, bottom);
  const tiles = [];
  for (let row = Math.min(start.row, end.row); row <= Math.max(start.row, end.row); row++) {
    for (let col = Math.min(start.col, end.col); col <= Math.max(start.col, end.col); col++) {
      const tile = { row, col, matrix: matrix.identifier, matrixIndex,
        west: matrix.topLeft[0] + col * spanLon, east: matrix.topLeft[0] + (col + 1) * spanLon,
        north: matrix.topLeft[1] - row * spanLat, south: matrix.topLeft[1] - (row + 1) * spanLat };
      if (tile.east > left && tile.west < right && tile.north > bottom && tile.south < top) tiles.push(tile);
    }
  }
  // A pathological zoom/viewport must not start an unbounded request burst.
  return tiles.length > 64 ? tiles.slice(0, 64) : tiles;
}

export function createOpticalWmtsLayer({ fetchImpl = globalThis.fetch, decode = async blob => createImageBitmap(blob), maxImages = 48, maxConcurrent = 4 } = {}) {
  const capsPromises = new Map(), capsReady = new Set(), images = new Map(), pending = new Map(), failures = new Set(), lastResults = new Map(), queue = [];
  let active = 0;
  const pump = () => {
    while (active < maxConcurrent && queue.length) {
      const job = queue.shift(); active++;
      job().finally(() => { active--; pump(); });
    }
  };
  function loadCapabilities(key) {
    if (!capsPromises.has(key)) {
      const layer = JEZERO_OPTICAL_LAYERS[key];
      const promise = fetchImpl(layer.capabilitiesUrl, { mode: "cors", credentials: "omit" })
        .then(response => { if (!response.ok) throw new Error(`NASA Mars Trek capabilities returned HTTP ${response.status}.`); return response.text(); })
        .then(xml => parseWmtsCapabilities(xml, layer.id));
      capsPromises.set(key, promise);
    }
    return capsPromises.get(key);
  }
  function request(key, tile, onUpdate) {
    const url = wmtsTileUrl(key, tile);
    if (images.has(url)) { const image = images.get(url); images.delete(url); images.set(url, image); return; }
    if (pending.has(url) || failures.has(url)) return;
    const promise = new Promise(resolve => {
      queue.push(async () => {
        try {
          const response = await fetchImpl(url, { mode: "cors", credentials: "omit" });
          if (!response.ok) throw new Error(`Tile returned HTTP ${response.status}.`);
          const image = await decode(await response.blob());
          images.set(url, image);
          while (images.size > maxImages) { const [oldUrl, old] = images.entries().next().value; images.delete(oldUrl); old.close?.(); }
          resolve(image);
        } catch (error) { failures.add(url); onUpdate?.(error); resolve(null); }
        finally { pending.delete(url); onUpdate?.(); }
      });
      pump();
    });
    pending.set(url, promise);
  }
  function draw(context, key, viewport, pixelWidth, pixelHeight, onUpdate) {
    if (!key || !JEZERO_OPTICAL_LAYERS[key]) return { state: "off", drawn: 0, attribution: "" };
    const layer = JEZERO_OPTICAL_LAYERS[key];
    const drawFor = (capabilities, level) => {
      const tiles = visibleOpticalTiles(capabilities, level, viewport, pixelWidth, pixelHeight);
      let drawn = 0;
      for (const tile of tiles) {
        const url = wmtsTileUrl(capabilities, tile), image = images.get(url);
        if (!image) { request(capabilities, tile, onUpdate); continue; }
        images.delete(url); images.set(url, image);
        const nw = latLonToLocal(viewport, tile.north, tile.west), se = latLonToLocal(viewport, tile.south, tile.east);
        if (!nw || !se) continue;
        const x = nw.x / viewport.widthM * pixelWidth, y = nw.y / viewport.heightM * pixelHeight;
        const w = (se.x - nw.x) / viewport.widthM * pixelWidth, h = (se.y - nw.y) / viewport.heightM * pixelHeight;
        context.drawImage(image, x, y, w, h); drawn++;
      }
      return { tiles: tiles.length, drawn };
    };
    const wasReady = capsReady.has(key);
    const promise = loadCapabilities(key).then(capabilities => {
      capsReady.add(key);
      const finest = opticalMatrixForViewport(capabilities, viewport, pixelWidth, pixelHeight);
      const coarse = Math.max(0, finest - 2);
      const coarseStatus = drawFor(capabilities, coarse);
      const fineStatus = coarse === finest ? coarseStatus : drawFor(capabilities, finest);
      const drawn = coarseStatus.drawn + (coarse === finest ? 0 : fineStatus.drawn);
      const failed = [...failures].filter(url => url.includes(`/${layer.id}/1.0.0/`)).length;
      const total = coarseStatus.tiles + (coarse === finest ? 0 : fineStatus.tiles);
      const state = failed && !drawn ? "unavailable" : failed ? "partial" : drawn === total && total ? "ready" : "loading";
      const result = { state, drawn, failed, attribution: layer.attribution, coverage: capabilities.bounds,
        ...(failed ? { error: `${failed} visible map tile${failed === 1 ? "" : "s"} could not be loaded.` } : {}) };
      lastResults.set(key, result); return result;
    }).catch(error => {
      const result = { state: "unavailable", drawn: 0, attribution: layer.attribution, error: error.message };
      lastResults.set(key, result); return result;
    });
    // The capability request is intentionally lazy and completion triggers a redraw.
    if (!wasReady) void promise.then(onUpdate);
    return lastResults.get(key) || { state: "loading", drawn: 0, attribution: layer.attribution };
  }
  return { draw, loadCapabilities, get cacheSize() { return images.size; }, get pendingCount() { return pending.size; } };
}
