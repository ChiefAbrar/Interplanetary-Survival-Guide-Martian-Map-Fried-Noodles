import { cellSpacingX, latLonToLocal, localToLatLon } from "./terrain.js";

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const DEG = Math.PI / 180;
// Recovered from the pre-4F.1 renderer: neutral gray-brown terrain, not the
// later orange-heavy ramp. Values affect display pixels only.
export const NEUTRAL_ELEVATION_RAMP = [
  [58, 56, 52],
  [128, 122, 112],
  [226, 219, 204]
];

export function robustDisplayRange(values, lowerPercentile = 0.02, upperPercentile = 0.98) {
  if (!(lowerPercentile >= 0 && lowerPercentile < upperPercentile && upperPercentile <= 1)) {
    throw new RangeError("Display percentiles must satisfy 0 ≤ lower < upper ≤ 1.");
  }
  const finite = [];
  for (const value of values) if (Number.isFinite(value)) finite.push(value);
  if (!finite.length) return { low: 0, high: 1, validCount: 0 };
  finite.sort((a, b) => a - b);
  const at = percentile => finite[Math.min(finite.length - 1, Math.floor(percentile * (finite.length - 1)))];
  const low = at(lowerPercentile), high = at(upperPercentile);
  return high > low ? { low, high, validCount: finite.length } : { low: finite[0], high: finite.at(-1) || finite[0] + 1, validCount: finite.length };
}

function interpolateRamp(ramp, value) {
  const p = clamp(value, 0, 1) * (ramp.length - 1), index = Math.min(ramp.length - 2, Math.floor(p)), f = p - index;
  return ramp[index].map((channel, i) => channel + (ramp[index + 1][i] - channel) * f);
}

function gradientAt(terrain, i, j) {
  const { width, height, z, cellY } = terrain;
  const centreIndex = j * width + i, centre = z[centreIndex];
  const sample = (x, y) => {
    const xx = clamp(x, 0, width - 1), yy = clamp(y, 0, height - 1), value = z[yy * width + xx];
    return Number.isFinite(value) ? value : centre;
  };
  const dx = (sample(i + 1, j) - sample(i - 1, j)) / (2 * cellSpacingX(terrain, j));
  const dy = (sample(i, j + 1) - sample(i, j - 1)) / (2 * cellY);
  return { dx, dy };
}

export function multidirectionalHillshade(terrain, i, j) {
  const { dx, dy } = gradientAt(terrain, i, j);
  return multidirectionalHillshadeFromGradient(dx, dy);
}

export function multidirectionalHillshadeFromGradient(dx, dy) {
  const slope = Math.atan(Math.hypot(dx, dy)), aspect = Math.atan2(dy, -dx);
  const lights = [
    { azimuth: 315, weight: 0.4 },
    { azimuth: 45, weight: 0.2 },
    { azimuth: 225, weight: 0.2 },
    { azimuth: 135, weight: 0.2 }
  ];
  const zenith = 45 * DEG;
  let illumination = 0;
  for (const light of lights) {
    const azimuth = light.azimuth * DEG;
    illumination += light.weight * (Math.cos(zenith) * Math.cos(slope) + Math.sin(zenith) * Math.sin(slope) * Math.cos(azimuth - aspect));
  }
  return clamp(0.7 + 0.6 * illumination, 0.58, 1.12);
}

export function renderElevationPixels(terrain, { noDataColor = [76, 78, 72], range = null } = {}) {
  range ||= robustDisplayRange(terrain.z);
  const pixels = new Uint8ClampedArray(terrain.width * terrain.height * 4);
  const span = range.high - range.low || 1;
  for (let j = 0; j < terrain.height; j++) for (let i = 0; i < terrain.width; i++) {
    const index = j * terrain.width + i, offset = index * 4, elevation = terrain.z[index];
    if (!Number.isFinite(elevation)) {
      pixels[offset] = noDataColor[0]; pixels[offset + 1] = noDataColor[1]; pixels[offset + 2] = noDataColor[2]; pixels[offset + 3] = 255;
      continue;
    }
    const color = interpolateRamp(NEUTRAL_ELEVATION_RAMP, (elevation - range.low) / span), shade = multidirectionalHillshade(terrain, i, j);
    pixels[offset] = clamp(color[0] * shade, 0, 255);
    pixels[offset + 1] = clamp(color[1] * shade, 0, 255);
    pixels[offset + 2] = clamp(color[2] * shade, 0, 255);
    pixels[offset + 3] = 255;
  }
  return { data: pixels, low: range.low, high: range.high, validCount: range.validCount };
}

/** Return catalog tiles whose actual core footprint intersects a map viewport. */
export function visibleCtxTileRecords(catalog, source, viewport) {
  if (!catalog?.tiles || !source?.geo || !viewport?.geo) return [];
  return catalog.tiles.filter(record => {
    const core = record.core_window, x0 = core.col_off * source.cellX, y0 = core.row_off * source.cellY;
    const points = [[x0, y0], [x0 + core.width * source.cellX, y0],
      [x0 + core.width * source.cellX, y0 + core.height * source.cellY], [x0, y0 + core.height * source.cellY]]
      .map(([x, y]) => {
        const ll = localToLatLon(source, x, y);
        return ll && latLonToLocal(viewport, ll.lat, ll.lon);
      }).filter(Boolean);
    if (points.length !== 4) return false;
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    return Math.max(...xs) > 0 && Math.min(...xs) < viewport.widthM &&
      Math.max(...ys) > 0 && Math.min(...ys) < viewport.heightM;
  });
}

/** A small deterministic sample from the visible tiles keeps one shared display stretch. */
export function ctxDisplayRange(tiles, stride = 16) {
  const samples = [];
  for (const tile of tiles) {
    const { metadata, elevations } = tile;
    const core = metadata.core_window_in_tile;
    const count = core.width * core.height;
    const step = Math.max(stride, Math.ceil(count / 20000));
    for (let index = 0; index < count; index += step) {
      const row = Math.floor(index / core.width), col = index - row * core.width;
      const value = elevations[(core.row_off + row) * metadata.width + core.col_off + col];
      if (Number.isFinite(value)) samples.push(value);
    }
  }
  return robustDisplayRange(samples);
}

/** Render one non-overlapping CTX core. The validated halo supplies cross-tile neighbors. */
export function renderCtxCorePixels(tile, range, cellX = 20, cellY = 20, { noDataColor = [76, 78, 72] } = {}) {
  const { metadata, elevations } = tile;
  const core = metadata.core_window, inside = metadata.core_window_in_tile;
  const width = core.width, height = core.height, output = new Uint8ClampedArray(width * height * 4);
  const span = range.high - range.low || 1, widthIn = metadata.width, heightIn = metadata.height;
  const at = (row, col, center) => {
    const r = Math.max(0, Math.min(heightIn - 1, row)), c = Math.max(0, Math.min(widthIn - 1, col));
    const value = elevations[r * widthIn + c];
    return Number.isFinite(value) ? value : center;
  };
  for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
    const r = inside.row_off + row, c = inside.col_off + col, value = elevations[r * widthIn + c], offset = (row * width + col) * 4;
    if (!Number.isFinite(value)) {
      output[offset] = noDataColor[0]; output[offset + 1] = noDataColor[1]; output[offset + 2] = noDataColor[2]; output[offset + 3] = 255;
      continue;
    }
    const left = at(r, c - 1, value), right = at(r, c + 1, value);
    const up = at(r - 1, c, value), down = at(r + 1, c, value);
    const dx = (right - left) / (2 * cellX), dy = (down - up) / (2 * cellY);
    const color = interpolateRamp(NEUTRAL_ELEVATION_RAMP, (value - range.low) / span);
    const shade = multidirectionalHillshadeFromGradient(dx, dy);
    output[offset] = clamp(color[0] * shade, 0, 255);
    output[offset + 1] = clamp(color[1] * shade, 0, 255);
    output[offset + 2] = clamp(color[2] * shade, 0, 255);
    output[offset + 3] = 255;
  }
  return { width, height, data: output };
}

export function mapPixelFromEvent(event, rect, terrain, backingWidth, backingHeight) {
  if (!rect?.width || !rect?.height || !backingWidth || !backingHeight) return null;
  const canvasX = (event.clientX - rect.left) / rect.width * backingWidth;
  const canvasY = (event.clientY - rect.top) / rect.height * backingHeight;
  const x = canvasX / backingWidth * terrain.widthM;
  const y = canvasY / backingHeight * terrain.heightM;
  if (x < 0 || y < 0 || x >= terrain.widthM || y >= terrain.heightM) return null;
  return { x, y, canvasX, canvasY };
}

export function fitMapCssSize(terrain, parentWidth, viewportWidth, viewportHeight) {
  const maxHeight = Math.max(280, Math.min(viewportHeight * (viewportWidth < 760 ? .58 : .68), viewportWidth < 760 ? 620 : 760));
  const aspect = terrain.heightM / terrain.widthM;
  const width = Math.min(parentWidth, maxHeight / aspect);
  return { width, height: width * aspect, maxHeight };
}

