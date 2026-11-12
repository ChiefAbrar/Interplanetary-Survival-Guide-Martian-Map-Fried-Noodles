// Terrain model. All distances are in metres, elevations in metres, slopes in degrees.
// Raster convention: row 0 is the northern edge, column 0 the western edge.
// Local coordinates: x grows east, y grows south, both measured from the north-west corner
// of the raster footprint (so cell (i, j) has its centre at ((i+.5)*cellX, (j+.5)*cellY)).

export class TerrainError extends Error {
  constructor(message, code = "terrain") { super(message); this.name = "TerrainError"; this.code = code; }
}

const RAD = Math.PI / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * @param {object} o
 * @param {number} o.width  columns
 * @param {number} o.height rows
 * @param {number} o.cellX  east-west pixel spacing (m)
 * @param {number} o.cellY  north-south pixel spacing (m)
 * @param {ArrayLike<number>} o.z elevations in metres; non-finite values mean "no data"
 * @param {object} [o.geo] optional equirectangular georeference, see tileCoordinates()
 * @param {object} [o.meta] free-form provenance
 */
export function createTerrain({ width, height, cellX, cellY = cellX, z, geo = null, meta = {} }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 3)
    throw new TerrainError("Raster must be at least 3 × 3 cells.", "dimensions");
  if (!(cellX > 0) || !(cellY > 0)) throw new TerrainError("Pixel spacing must be a positive number of metres.", "spacing");
  if (z.length !== width * height)
    throw new TerrainError(`Elevation array has ${z.length} values but ${width} × ${height} = ${width * height} were expected.`, "length");
  const Z = new Float32Array(width * height);
  let min = Infinity, max = -Infinity, valid = 0;
  for (let i = 0; i < Z.length; i++) {
    const v = Number(z[i]);
    if (Number.isFinite(v)) { Z[i] = v; valid++; if (v < min) min = v; if (v > max) max = v; }
    else Z[i] = NaN;
  }
  if (valid === 0) throw new TerrainError("The raster contains no valid elevation values.", "no-data");
  const t = {
    width, height, cellX, cellY, z: Z, geo, meta,
    widthM: width * cellX, heightM: height * cellY,
    min, max, validCount: valid, invalidCount: Z.length - valid,
    slope: null, skyView: null
  };
  t.slope = computeSlope(t);
  return t;
}

const at = (t, i, j) => t.z[j * t.width + i];

/** Horn-style slope (degrees) using real cell spacing. One-sided differences at borders or next to no-data. */
export function computeSlope(t) {
  const { width: w, height: h, cellX, cellY } = t;
  const out = new Float32Array(w * h);
  const ok = (i, j) => i >= 0 && j >= 0 && i < w && j < h && Number.isFinite(t.z[j * w + i]);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (!ok(i, j)) { out[j * w + i] = NaN; continue; }
    // d/dx: weighted over rows j-1, j, j+1 with weights 1,2,1
    let sx = 0, wx = 0, sy = 0, wy = 0;
    for (let k = -1; k <= 1; k++) {
      const wt = k === 0 ? 2 : 1, j2 = j + k;
      const dxm = cellSpacingX(t, j2);
      if (ok(i + 1, j2) && ok(i - 1, j2)) { sx += wt * (at(t, i + 1, j2) - at(t, i - 1, j2)) / (2 * dxm); wx += wt; }
      else if (ok(i + 1, j2) && ok(i, j2)) { sx += wt * (at(t, i + 1, j2) - at(t, i, j2)) / dxm; wx += wt; }
      else if (ok(i - 1, j2) && ok(i, j2)) { sx += wt * (at(t, i, j2) - at(t, i - 1, j2)) / dxm; wx += wt; }
      const i2 = i + k;
      if (ok(i2, j + 1) && ok(i2, j - 1)) { sy += wt * (at(t, i2, j + 1) - at(t, i2, j - 1)) / (2 * cellY); wy += wt; }
      else if (ok(i2, j + 1) && ok(i2, j)) { sy += wt * (at(t, i2, j + 1) - at(t, i2, j)) / cellY; wy += wt; }
      else if (ok(i2, j - 1) && ok(i2, j)) { sy += wt * (at(t, i2, j) - at(t, i2, j - 1)) / cellY; wy += wt; }
    }
    if (!wx || !wy) { out[j * w + i] = NaN; continue; }
    // y runs southwards in the raster, but only the magnitude matters for slope
    out[j * w + i] = Math.atan(Math.hypot(sx / wx, sy / wy)) / RAD;
  }
  return out;
}

/**
 * Sky-view factor: 1 - mean(sin^2(horizon elevation)) over 8 azimuths, searching up to maxRadiusM.
 * 1 = flat open ground, lower values = more of the sky blocked by terrain. Distances are physical.
 */
export function computeSkyView(t, maxRadiusM = 2000) {
  const { width: w, height: h, cellX, cellY } = t;
  const out = new Float32Array(w * h);
  const minCos = t.geo?.type === "simple-cylindrical" || t.geo?.type === "equirectangular"
    ? Math.min(...[0, h - 1].map(row => cellSpacingX(t, row) / cellX)) : 1;
  const baseStep = Math.min(cellX * minCos, cellY);
  // A 2 km horizon at 1 m posting would otherwise inspect hundreds of
  // millions of samples. On fine rasters, stride by two cells for this
  // illustrative sky-view model; route safety still does not follow from it.
  const step = baseStep < 50 ? baseStep * 2 : baseStep;
  const nSteps = Math.max(1, Math.min(200, Math.floor(maxRadiusM / step)));
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const z0 = t.z[j * w + i];
    if (!Number.isFinite(z0)) { out[j * w + i] = NaN; continue; }
    let acc = 0;
    for (let d = 0; d < 8; d++) {
      const ux = Math.cos(d * Math.PI / 4), uy = Math.sin(d * Math.PI / 4);
      let m = 0; // horizon elevation angle, never below horizontal
      for (let k = 1; k <= nSteps; k++) {
        const dist = k * step, row = clamp(Math.round(j), 0, h - 1);
        const dxm = cellSpacingX(t, row);
        const x = i + (ux * dist) / dxm, y = j + (uy * dist) / cellY;
        const xi = Math.round(x), yi = Math.round(y);
        if (xi < 0 || yi < 0 || xi >= w || yi >= h) break;
        const zz = t.z[yi * w + xi];
        if (!Number.isFinite(zz)) continue;
        m = Math.max(m, Math.atan2(zz - z0, dist));
      }
      acc += Math.sin(m) ** 2;
    }
    out[j * w + i] = 1 - acc / 8;
  }
  return out;
}

export function getSkyView(t) { if (!t.skyView) t.skyView = computeSkyView(t); return t.skyView; }

export const cellIndex = (t, i, j) => j * t.width + i;
export const cellOf = (t, idx) => [idx % t.width, (idx / t.width) | 0];
/** Local metric position of the centre of a cell. */
export const cellCentre = (t, idx) => { const [i, j] = cellOf(t, idx); return { x: (i + .5) * t.cellX, y: (j + .5) * t.cellY }; };
export function cellSpacingX(t, row) {
  if (t.geo?.type !== "simple-cylindrical" && t.geo?.type !== "equirectangular") return t.cellX;
  const lat = localToLatLon(t, 0, (row + .5) * t.cellY).lat;
  const standardParallel = t.geo.type === "equirectangular" ? t.geo.standardParallelDeg : 0;
  return t.cellX * Math.cos(lat * RAD) / Math.cos(standardParallel * RAD);
}
/** Ground distance between grid positions, accounting for latitude on a simple cylindrical planetary raster. */
export function horizontalDistance(t, dx, dy, rowA, rowB = rowA) {
  const xSpacing = cellSpacingX(t, (rowA + rowB) / 2);
  const x = dx * xSpacing;
  return Math.hypot(x, dy * t.cellY);
}
/** Cell containing local position (x, y) in metres, or -1 if outside the footprint. */
export function cellAt(t, x, y) {
  const i = Math.floor(x / t.cellX), j = Math.floor(y / t.cellY);
  return i < 0 || j < 0 || i >= t.width || j >= t.height ? -1 : j * t.width + i;
}

/** Bilinear elevation at a local position, null if any support cell is no-data or outside. */
export function elevationAt(t, x, y) {
  const gx = x / t.cellX - .5, gy = y / t.cellY - .5;
  const i0 = Math.floor(gx), j0 = Math.floor(gy);
  if (i0 < 0 || j0 < 0 || i0 + 1 >= t.width || j0 + 1 >= t.height) {
    const c = cellAt(t, x, y); if (c < 0) return null; const v = t.z[c]; return Number.isFinite(v) ? v : null;
  }
  const fx = gx - i0, fy = gy - j0;
  const a = at(t, i0, j0), b = at(t, i0 + 1, j0), c = at(t, i0, j0 + 1), d = at(t, i0 + 1, j0 + 1);
  if (![a, b, c, d].every(Number.isFinite)) return null;
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/**
 * Latitude/longitude of a local position when the terrain carries an equirectangular georeference:
 * geo = { radiusM, centerLatDeg, centerLonDeg, originXM, originYM, standardParallelDeg? }
 * originXM/originYM are the projected coordinates (east, north, metres from the projection origin)
 * of the north-west corner of the raster.
 */
export function localToLatLon(t, x, y) {
  const g = t.geo; if (!g) return null;
  const px = g.originXM + x, py = g.originYM - y;
  const lat = g.centerLatDeg + (py / g.radiusM) / RAD;
  const cosLat0 = g.type === "simple-cylindrical" ? 1 : Math.cos((g.standardParallelDeg ?? g.centerLatDeg) * RAD);
  const lon = g.centerLonDeg + (px / (g.radiusM * cosLat0)) / RAD;
  return { lat, lon };
}
export function latLonToLocal(t, lat, lon) {
  const g = t.geo; if (!g) return null;
  const cosLat0 = g.type === "simple-cylindrical" ? 1 : Math.cos((g.standardParallelDeg ?? g.centerLatDeg) * RAD);
  const px = (lon - g.centerLonDeg) * RAD * g.radiusM * cosLat0;
  const py = (lat - g.centerLatDeg) * RAD * g.radiusM;
  return { x: px - g.originXM, y: g.originYM - py };
}
