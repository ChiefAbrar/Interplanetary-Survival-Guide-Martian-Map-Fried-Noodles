import { cellOf, cellCentre, cellSpacingX, elevationAt, getSkyView, horizontalDistance } from "./terrain.js";
import { PARAMS, walkSpeedMS, doseRate } from "./models.js";

export const OBJECTIVES = {
  shortest: { label: "Shortest distance", help: "Minimises 3-D path length." },
  fastest: { label: "Fastest", help: "Minimises estimated walking time (slope-dependent speed)." },
  lowrisk: { label: "Lower risk", help: "Minimises length weighted by slope and by modeled radiation exposure (more open sky costs more)." },
  science: { label: "Science", help: "Fastest cost, reduced near science targets supplied with the dataset." }
};

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const { k, v } = this; let i = k.length; k.push(key); v.push(val);
    while (i) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p; }
  }
  pop() {
    const { k, v } = this, key = k[0], val = v[0], lk = k.pop(), lv = v.pop();
    if (k.length) {
      k[0] = lk; v[0] = lv; let i = 0;
      for (;;) {
        let c = 2 * i + 1; if (c >= k.length) break;
        if (c + 1 < k.length && k[c + 1] < k[c]) c++;
        if (k[i] <= k[c]) break;
        [k[i], k[c]] = [k[c], k[i]]; [v[i], v[c]] = [v[c], v[i]]; i = c;
      }
    }
    return [key, val];
  }
}

const result = (code, message) => ({ ok: false, code, message });

/**
 * Plan a route on the 8-connected grid.
 * @param terrain  from createTerrain()
 * @param startIdx goal cell indices
 * @param opts { objective, maxSlopeDeg, targets:[{name,x,y,radiusM}], params, doseMultiplier }
 */
export function planRoute(terrain, startIdx, goalIdx, opts = {}) {
  const objective = opts.objective || "fastest";
  const maxSlope = opts.maxSlopeDeg ?? PARAMS.maxSlopeDeg.value;
  const p = opts.params || {};
  const targets = opts.targets || [];
  const { width: w, height: h, cellX, cellY, z, slope } = terrain;
  const N = w * h;
  if (!(objective in OBJECTIVES)) return result("objective", `Unknown route objective "${objective}".`);
  if (objective === "science" && !targets.length) return result("no-targets", "This dataset has no science targets, so a science route cannot be calculated.");
  if (startIdx === goalIdx) return result("same-cell", "Start and destination are the same cell.");
  const blocked = i => !Number.isFinite(z[i]) || !Number.isFinite(slope[i]) || slope[i] > maxSlope;
  if (blocked(startIdx)) return result("start-blocked", `The start cell is no-data or steeper than ${maxSlope}°.`);
  if (blocked(goalIdx)) return result("goal-blocked", `The destination cell is no-data or steeper than ${maxSlope}°.`);
  const sv = objective === "lowrisk" ? getSkyView(terrain) : null;
  const rWeight = p.riskDoseWeight ?? PARAMS.riskDoseWeight.value, rRef = p.riskSlopeRefDeg ?? PARAMS.riskSlopeRefDeg.value;
  const reward = p.scienceReward ?? PARAMS.scienceReward.value;
  // proximity (0..1) of every cell to its nearest science target
  let prox = null;
  if (objective === "science") {
    prox = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const c = cellCentre(terrain, i); let m = 0;
      for (const t of targets) { const r = t.radiusM || PARAMS.scienceRadiusM.value; m = Math.max(m, Math.exp(-((Math.hypot(c.x - t.x, c.y - t.y) / r) ** 2))); }
      prox[i] = m;
    }
  }
  const dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1);
  const heap = new MinHeap(); dist[startIdx] = 0; heap.push(0, startIdx);
  const edge = (u, v, dx, dy) => {
    const horiz = horizontalDistance(terrain, dx, dy, (u / w) | 0, (v / w) | 0), dz = z[v] - z[u];
    const len = Math.hypot(horiz, dz), sdeg = Math.atan2(Math.abs(dz), horiz) * 180 / Math.PI;
    return { len, sdeg };
  };
  while (heap.size) {
    const [d, u] = heap.pop();
    if (u === goalIdx) break;
    if (d > dist[u]) continue;
    const ux = u % w, uy = (u / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const x = ux + dx, y = uy + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const v = y * w + x;
      if (blocked(v)) continue;
      if (dx && dy && (blocked(uy * w + x) || blocked(y * w + ux))) continue; // no corner cutting
      const { len, sdeg } = edge(u, v, dx, dy);
      if (sdeg > maxSlope) continue;
      let c;
      if (objective === "shortest") c = len;
      else if (objective === "lowrisk") c = len * (1 + (sdeg / rRef) ** 2 + rWeight * 0.5 * (sv[u] + sv[v])); // sky-view factor is proportional to modeled dose
      else { c = len / walkSpeedMS(sdeg, p); if (objective === "science") c *= 1 - reward * 0.5 * (prox[u] + prox[v]); }
      if (d + c < dist[v]) { dist[v] = d + c; prev[v] = u; heap.push(dist[v], v); }
    }
  }
  if (!Number.isFinite(dist[goalIdx]))
    return result("unreachable", `No path exists between these cells where every step is valid ground with slope ≤ ${maxSlope}°. Raise the slope limit or choose another destination.`);
  const path = []; for (let v = goalIdx; v !== -1; v = prev[v]) path.push(v); path.reverse();
  return { ok: true, objective, path, metrics: pathMetrics(terrain, path, { params: p, targets, doseMultiplier: opts.doseMultiplier ?? 1, maxSlopeDeg: maxSlope }) };
}

/** Distance, time, elevation change, slope, dose and elevation profile for a list of cell indices. */
export function pathMetrics(terrain, path, { params = {}, targets = [], doseMultiplier = 1, maxSlopeDeg = PARAMS.maxSlopeDeg.value } = {}) {
  const { width: w, cellX, cellY, z, slope } = terrain;
  let horizM = 0, lenM = 0, timeS = 0, up = 0, down = 0, maxEdge = 0, maxCell = 0, doseMSv = 0;
  const segments = [], invalidSegments = [], profile = path.length ? [{ s: 0, z: z[path[0]], slope: slope[path[0]] }] : [];
  const hasValidPair = path.slice(1).some((b, k) => {
    const a = path[k], validIndex = i => Number.isInteger(i) && i >= 0 && i < w * terrain.height;
    return validIndex(a) && validIndex(b) && Number.isFinite(z[a]) && Number.isFinite(z[b]) &&
      Number.isFinite(horizontalDistance(terrain, (b % w) - (a % w), ((b / w) | 0) - ((a / w) | 0), (a / w) | 0, (b / w) | 0)) &&
      horizontalDistance(terrain, (b % w) - (a % w), ((b / w) | 0) - ((a / w) | 0), (a / w) | 0, (b / w) | 0) > 0;
  });
  const sv = hasValidPair ? getSkyView(terrain) : null;
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1], b = path[k];
    const validIndex = i => Number.isInteger(i) && i >= 0 && i < w * terrain.height;
    const startValid = validIndex(a) && Number.isFinite(z[a]), endValid = validIndex(b) && Number.isFinite(z[b]);
    const dx = validIndex(a) && validIndex(b) ? (b % w) - (a % w) : NaN;
    const dy = validIndex(a) && validIndex(b) ? ((b / w) | 0) - ((a / w) | 0) : NaN;
    const horiz = startValid && endValid ? horizontalDistance(terrain, dx, dy, (a / w) | 0, (b / w) | 0) : NaN;
    const dz = startValid && endValid ? z[b] - z[a] : NaN;
    const distanceValid = Number.isFinite(horiz) && horiz > 0;
    const isValid = startValid && endValid && distanceValid && Number.isFinite(dz);
    const invalidReason = !validIndex(a) ? "start-cell-out-of-range" : !validIndex(b) ? "end-cell-out-of-range"
      : !Number.isFinite(z[a]) ? "start-no-data" : !Number.isFinite(z[b]) ? "end-no-data"
      : !distanceValid ? "invalid-horizontal-distance" : null;
    const len = isValid ? Math.hypot(horiz, dz) : NaN;
    const signedSlopeDeg = isValid ? Math.atan2(dz, horiz) * 180 / Math.PI : NaN;
    const sdeg = Math.abs(signedSlopeDeg), dt = isValid ? len / walkSpeedMS(sdeg, params) : NaN;
    const start = startValid ? cellCentre(terrain, a) : null, end = endValid ? cellCentre(terrain, b) : null;
    const segment = {
      index: k - 1, startCell: a, endCell: b,
      start: { cell: a, x: start?.x ?? NaN, y: start?.y ?? NaN, elevationM: startValid ? z[a] : NaN },
      end: { cell: b, x: end?.x ?? NaN, y: end?.y ?? NaN, elevationM: endValid ? z[b] : NaN },
      startElevationM: startValid ? z[a] : NaN, endElevationM: endValid ? z[b] : NaN,
      horizontalDistanceM: horiz, elevationChangeM: dz, signedSlopeDeg, absoluteSlopeDeg: sdeg,
      isValid, invalidReason, exceedsSlopeLimit: isValid && sdeg > maxSlopeDeg
    };
    segments.push(segment);
    if (!isValid) { invalidSegments.push(segment); continue; }
    horizM += horiz; lenM += len; timeS += dt;
    if (dz > 0) up += dz; else down -= dz;
    maxEdge = Math.max(maxEdge, sdeg); maxCell = Math.max(maxCell, slope[b]);
    doseMSv += doseRate(0.5 * (sv[a] + sv[b]), doseMultiplier, params) * dt / 86400;
    profile.push({ s: lenM, z: z[b], slope: sdeg });
  }
  if (path.length && Number.isInteger(path[0]) && path[0] >= 0 && path[0] < w * terrain.height && Number.isFinite(slope[path[0]]))
    maxCell = Math.max(maxCell, slope[path[0]]);
  const stops = [];
  for (const t of targets) {
    const r = t.radiusM || PARAMS.scienceRadiusM.value; let best = Infinity, at = 0;
    path.forEach((c, k) => {
      if (!Number.isInteger(c) || c < 0 || c >= w * terrain.height || !Number.isFinite(z[c])) return;
      const q = cellCentre(terrain, c), d = Math.hypot(q.x - t.x, q.y - t.y);
      if (d < best) { best = d; at = profile[k]?.s ?? 0; }
    });
    if (best <= r) stops.push({ name: t.name, offsetM: best, alongM: at });
  }
  const steepestSegment = segments.filter(segment => segment.isValid).reduce((steepest, segment) =>
    !steepest || segment.absoluteSlopeDeg > steepest.absoluteSlopeDeg ? segment : steepest, null);
  return {
    lengthM: lenM, horizontalM: horizM, timeS, ascentM: up, descentM: down,
    netElevationM: path.length && Number.isFinite(z[path[0]]) && Number.isFinite(z[path[path.length - 1]]) ? z[path[path.length - 1]] - z[path[0]] : NaN,
    maxEdgeSlopeDeg: maxEdge, maxCellSlopeDeg: maxCell,
    doseOneWayMSv: doseMSv, profile, scienceStops: stops,
    segments, steepestSegment, overLimitSegments: segments.filter(segment => segment.exceedsSlopeLimit),
    invalidSegments, hasInvalidSegments: invalidSegments.length > 0, slopeLimitDeg: maxSlopeDeg
  };
}

/**
 * Analyze an ordered user-drawn polyline in terrain-local metres.
 * Sampling policy: no more than half the smaller local DEM cell dimension per
 * sample interval. This denser sampling does not add terrain resolution; each
 * elevation still comes from the source grid through elevationAt().
 * @param terrain Terrain returned by createTerrain().
 * @param waypoints Ordered [{x, y}] terrain-local positions in metres.
 * @param options { slopeLimitDeg, sampleSpacingFraction }.
 */
export function analyzeManualRoute(terrain, waypoints, { slopeLimitDeg = PARAMS.maxSlopeDeg.value, sampleSpacingFraction = 0.5, sampleDetailsAt } = {}) {
  const empty = { ok: false, code: "waypoints", message: "A manual route needs at least two waypoints.",
    totalHorizontalDistanceM: 0, totalAscentM: 0, totalDescentM: 0, netElevationChangeM: NaN,
    maximumAbsoluteSlopeDeg: null, steepestSegment: null, samples: [], segments: [], invalidSegments: [],
    overLimitSegments: [], slopeLimitDeg, samplingIntervalM: null,
    samplingPolicy: "At most half the smaller local DEM cell dimension; interpolation does not increase source resolution.",
    terrainCoverageComplete: false, passesSlopeConstraint: false };
  if (!Array.isArray(waypoints) || waypoints.length < 2) return empty;
  if (!(sampleSpacingFraction > 0 && sampleSpacingFraction <= 1))
    return { ...empty, code: "sampling", message: "sampleSpacingFraction must be greater than 0 and at most 1." };
  if (sampleDetailsAt !== undefined && typeof sampleDetailsAt !== "function")
    throw new TypeError("sampleDetailsAt must be a synchronous function when provided.");

  const { width, height, cellX, cellY } = terrain;
  const maxX = width * cellX, maxY = height * cellY;
  const samples = [], segments = [], invalidSegments = [], intervalList = [];
  const finitePoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
  const sampleAt = (x, y, legIndex, fraction, waypointIndex = null) => {
    const inBounds = Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < maxX && y < maxY;
    if (sampleDetailsAt) {
      const details = sampleDetailsAt(x, y);
      if (details && typeof details.then === "function") {
        if (typeof details.catch === "function") details.catch(() => {});
        throw new TypeError("sampleDetailsAt must return sample details synchronously; Promise results are not supported.");
      }
      if (!details || typeof details !== "object" || typeof details.isValid !== "boolean")
        throw new TypeError("sampleDetailsAt must return an object with a boolean isValid field.");
      const valid = details.isValid && Number.isFinite(details.elevationM);
      const sample = { index: samples.length, legIndex, fraction, waypointIndex, x, y,
        elevationM: valid ? details.elevationM : null, isValid: valid,
        invalidReason: valid ? null : details.invalidReason || (details.isValid ? "invalid-sampler-elevation" : "invalid-terrain") };
      for (const key of ["datasetId", "tileId", "sourceRow", "sourceColumn", "nativeSpatialResolutionM", "samplingMethod",
        "localCoordinatesM", "projectedCoordinatesM", "sourcePixelCoordinates", "supportCell"])
        if (Object.hasOwn(details, key)) sample[key] = details[key];
      return sample;
    }
    const elevationM = inBounds ? elevationAt(terrain, x, y) : null;
    return { index: samples.length, legIndex, fraction, waypointIndex, x, y, elevationM,
      isValid: Number.isFinite(elevationM), invalidReason: !inBounds ? "outside-terrain" : !Number.isFinite(elevationM) ? "no-data" : null };
  };

  const first = waypoints[0];
  if (finitePoint(first)) samples.push(sampleAt(first.x, first.y, 0, 0, 0));
  else samples.push({ index: 0, legIndex: 0, fraction: 0, waypointIndex: 0, x: first?.x ?? NaN, y: first?.y ?? NaN,
    elevationM: null, isValid: false, invalidReason: "invalid-coordinate" });

  for (let legIndex = 0; legIndex < waypoints.length - 1; legIndex++) {
    const a = waypoints[legIndex], b = waypoints[legIndex + 1];
    if (!finitePoint(a) || !finitePoint(b)) {
      const endpoint = finitePoint(b)
        ? sampleAt(b.x, b.y, legIndex, 1, legIndex + 1)
        : { index: samples.length, legIndex, fraction: 1, waypointIndex: legIndex + 1, x: b?.x ?? NaN, y: b?.y ?? NaN,
          elevationM: null, isValid: false, invalidReason: "invalid-coordinate" };
      samples.push(endpoint);
      const segment = { index: segments.length, legIndex, start: samples[samples.length - 2], end: endpoint,
        startPosition: { x: samples[samples.length - 2].x, y: samples[samples.length - 2].y },
        endPosition: { x: endpoint.x, y: endpoint.y }, startElevationM: samples[samples.length - 2].elevationM,
        endElevationM: endpoint.elevationM, horizontalDistanceM: NaN, elevationChangeM: NaN,
        signedSlopeDeg: NaN, absoluteSlopeDeg: NaN, isValid: false, invalidReason: "invalid-coordinate",
        exceedsSlopeLimit: false };
      segments.push(segment); invalidSegments.push(segment);
      continue;
    }

    const dxCells = (b.x - a.x) / cellX, dyCells = (b.y - a.y) / cellY;
    const midpointRow = ((a.y + b.y) / 2) / cellY - 0.5;
    const localCellX = cellSpacingX(terrain, midpointRow);
    const localResolution = Math.min(localCellX, cellY);
    const intervalM = localResolution * sampleSpacingFraction;
    intervalList.push(intervalM);
    const legDistanceM = horizontalDistance(terrain, dxCells, dyCells, midpointRow, midpointRow);
    const intervals = Number.isFinite(legDistanceM) && legDistanceM > 0 && Number.isFinite(intervalM) && intervalM > 0
      ? Math.max(1, Math.ceil(legDistanceM / intervalM)) : 1;

    for (let n = 1; n <= intervals; n++) {
      const fraction = n / intervals, x = a.x + (b.x - a.x) * fraction, y = a.y + (b.y - a.y) * fraction;
      samples.push(sampleAt(x, y, legIndex, fraction, n === intervals ? legIndex + 1 : null));
    }
  }

  let totalHorizontalDistanceM = 0, totalAscentM = 0, totalDescentM = 0;
  for (let i = 1; i < samples.length; i++) {
    const start = samples[i - 1], end = samples[i];
    const dxCells = (end.x - start.x) / cellX, dyCells = (end.y - start.y) / cellY;
    const midpointRow = ((start.y + end.y) / 2) / cellY - 0.5;
    const horizontalDistanceM = Number.isFinite(dxCells) && Number.isFinite(dyCells)
      ? horizontalDistance(terrain, dxCells, dyCells, midpointRow, midpointRow) : NaN;
    const distanceValid = Number.isFinite(horizontalDistanceM) && horizontalDistanceM > 0;
    if (Number.isFinite(horizontalDistanceM) && horizontalDistanceM >= 0) totalHorizontalDistanceM += horizontalDistanceM;
    const bothElevationsValid = start.isValid && end.isValid;
    const elevationChangeM = bothElevationsValid ? end.elevationM - start.elevationM : NaN;
    const isValid = bothElevationsValid && distanceValid && Number.isFinite(elevationChangeM);
    const signedSlopeDeg = isValid ? Math.atan2(elevationChangeM, horizontalDistanceM) * 180 / Math.PI : NaN;
    const absoluteSlopeDeg = Math.abs(signedSlopeDeg);
    const invalidReason = !start.isValid ? `start-${start.invalidReason}` : !end.isValid ? `end-${end.invalidReason}`
      : !distanceValid ? "invalid-horizontal-distance" : null;
    const segment = { index: segments.length, legIndex: end.legIndex, start, end,
      startPosition: { x: start.x, y: start.y }, endPosition: { x: end.x, y: end.y },
      startElevationM: start.elevationM, endElevationM: end.elevationM, horizontalDistanceM, elevationChangeM,
      signedSlopeDeg, absoluteSlopeDeg, isValid, invalidReason,
      exceedsSlopeLimit: isValid && absoluteSlopeDeg > slopeLimitDeg };
    segments.push(segment);
    if (!isValid) { invalidSegments.push(segment); continue; }
    if (elevationChangeM > 0) totalAscentM += elevationChangeM;
    else totalDescentM -= elevationChangeM;
  }

  const steepestSegment = segments.filter(segment => segment.isValid).reduce((best, segment) =>
    !best || segment.absoluteSlopeDeg > best.absoluteSlopeDeg ? segment : best, null);
  const validWaypointEndpoints = samples[0]?.isValid && samples.at(-1)?.isValid;
  const overLimitSegments = segments.filter(segment => segment.exceedsSlopeLimit);
  const terrainCoverageComplete = samples.every(sample => sample.isValid);
  return { ok: true, code: null, message: null, totalHorizontalDistanceM, totalAscentM, totalDescentM,
    netElevationChangeM: validWaypointEndpoints ? samples.at(-1).elevationM - samples[0].elevationM : NaN,
    maximumAbsoluteSlopeDeg: steepestSegment?.absoluteSlopeDeg ?? null, steepestSegment, samples, segments,
    invalidSegments, overLimitSegments, slopeLimitDeg,
    samplingIntervalM: intervalList.length ? Math.min(...intervalList) : null,
    samplingPolicy: `At most ${sampleSpacingFraction} of the smaller local DEM cell dimension per sample interval; interpolation does not increase source resolution.`,
    terrainCoverageComplete,
    passesSlopeConstraint: segments.length > 0 && terrainCoverageComplete && overLimitSegments.length === 0 };
}
