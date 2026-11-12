import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { analyzeManualRoute, planRoute, OBJECTIVES, pathMetrics } from "../public/js/routing.js";
import { parseTile } from "../public/js/dem-format.js";
import { cellAt, createTerrain } from "../public/js/terrain.js";
import { walkSpeedMS } from "../public/js/models.js";
import { createCtxTerrainManager } from "../public/js/ctx-tile-manager.js";
import { createCtxTerrainSampler } from "../public/js/ctx-terrain-sampler.js";
import { grid, idx, DEG } from "./helpers.js";

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
const V0 = 2.5 / 3.6;
const testTile = () => parseTile(readFileSync(new URL("../public/data/test-terrain.json", import.meta.url), "utf8"));

test("flat ground: distance and time follow the real pixel spacing", () => {
  const t = grid(21, 11, 10, 10, () => 0);
  const r = planRoute(t, idx(t, 0, 5), idx(t, 20, 5), { objective: "shortest" });
  assert.ok(r.ok);
  near(r.metrics.lengthM, 200); near(r.metrics.horizontalM, 200);
  near(r.metrics.timeS, 200 / V0, 1e-6);
  assert.equal(r.metrics.ascentM, 0); assert.equal(r.metrics.maxEdgeSlopeDeg, 0);
  near(r.metrics.profile.at(-1).s, r.metrics.lengthM);
});

test("anisotropic cells: east-west and north-south legs use their own spacing", () => {
  const t = grid(11, 11, 10, 30, () => 0);
  const r = planRoute(t, idx(t, 0, 0), idx(t, 10, 10), { objective: "shortest" });
  near(r.metrics.lengthM, Math.hypot(100, 300), 1e-6); // ten identical diagonal steps of hypot(10 m, 30 m)
});

test("a uniform 10° climb: length is 3-D, ascent is the height gained, time uses the slope speed", () => {
  const t = grid(21, 5, 10, 10, x => Math.tan(10 * DEG) * x);
  const r = planRoute(t, idx(t, 0, 2), idx(t, 20, 2), { objective: "fastest" });
  assert.ok(r.ok); const m = r.metrics;
  near(m.horizontalM, 200); near(m.lengthM, 200 / Math.cos(10 * DEG), 1e-3);
  near(m.ascentM, 200 * Math.tan(10 * DEG), 1e-3); near(m.descentM, 0); near(m.netElevationM, m.ascentM, 1e-3);
  near(m.maxEdgeSlopeDeg, 10, 1e-3);
  near(m.timeS, m.lengthM / walkSpeedMS(10), 1e-3);
  assert.ok(m.timeS > 200 / V0);
});

test("descent and ascent are tracked separately", () => {
  const t = grid(21, 5, 10, 10, x => 20 * Math.sin(Math.PI * x / 200));
  const r = planRoute(t, idx(t, 0, 2), idx(t, 20, 2), { objective: "shortest" });
  assert.ok(r.metrics.ascentM > 15 && r.metrics.descentM > 15);
  near(r.metrics.netElevationM, t.z[idx(t, 20, 2)] - t.z[idx(t, 0, 2)], 1e-4);
});

test("segment diagnostics describe a flat path and use the supplied slope limit", () => {
  const t = grid(5, 5, 10, 20, () => 7);
  const path = [idx(t, 1, 1), idx(t, 2, 1), idx(t, 2, 2)];
  const m = pathMetrics(t, path, { maxSlopeDeg: 12 });
  assert.equal(m.slopeLimitDeg, 12);
  assert.equal(m.segments.length, 2);
  assert.equal(m.segments[0].index, 0);
  assert.deepEqual(m.segments[0].start, { cell: path[0], x: 15, y: 30, elevationM: 7 });
  assert.deepEqual(m.segments[0].end, { cell: path[1], x: 25, y: 30, elevationM: 7 });
  near(m.segments[0].horizontalDistanceM, 10);
  near(m.segments[0].elevationChangeM, 0);
  near(m.segments[0].signedSlopeDeg, 0);
  near(m.segments[0].absoluteSlopeDeg, 0);
  assert.equal(m.segments[0].exceedsSlopeLimit, false);
  assert.equal(m.steepestSegment.index, 0);
  assert.deepEqual(m.overLimitSegments, []);
});

test("segment diagnostics preserve uphill/downhill signs and cumulative coordinates", () => {
  const t = grid(5, 5, 10, 10, (_x, _y, i) => i === 2 ? 10 : 0);
  const path = [idx(t, 1, 1), idx(t, 2, 1), idx(t, 3, 1)];
  const m = pathMetrics(t, path, { maxSlopeDeg: 45 });
  assert.equal(m.segments.length, 2);
  near(m.segments[0].elevationChangeM, 10);
  near(m.segments[0].signedSlopeDeg, Math.atan2(10, 10) / DEG);
  near(m.segments[1].elevationChangeM, -10);
  near(m.segments[1].signedSlopeDeg, Math.atan2(-10, 10) / DEG);
  near(m.segments[1].absoluteSlopeDeg, 45);
  assert.equal(m.steepestSegment.index, 0);
  assert.equal(m.ascentM, 10);
  assert.equal(m.descentM, 10);
});

test("segment diagnostics calculate diagonal distance from both cell spacings", () => {
  const t = grid(5, 5, 10, 30, () => 0);
  const path = [idx(t, 1, 1), idx(t, 2, 2)];
  const m = pathMetrics(t, path);
  near(m.segments[0].horizontalDistanceM, Math.hypot(10, 30));
  near(m.horizontalM, Math.hypot(10, 30));
});

test("a manually supplied over-limit segment is analyzed although Dijkstra rejects it", () => {
  const t = grid(5, 5, 10, 10, x => x === 15 ? 10 : 0);
  const start = idx(t, 1, 1), end = idx(t, 2, 1), path = [start, end];
  assert.equal(planRoute(t, start, end, { objective: "shortest", maxSlopeDeg: 25 }).ok, false);
  const m = pathMetrics(t, path, { maxSlopeDeg: 25 });
  assert.equal(m.segments.length, 1);
  assert.equal(m.overLimitSegments.length, 1);
  assert.equal(m.overLimitSegments[0].index, 0);
  near(m.overLimitSegments[0].absoluteSlopeDeg, 45);
  assert.equal(m.overLimitSegments[0].exceedsSlopeLimit, true);
});

test("empty and single-cell paths return consistent segment diagnostics", () => {
  const t = grid(5, 5, 10, 10, () => 4);
  const empty = pathMetrics(t, [], { maxSlopeDeg: 17 });
  assert.deepEqual(empty.segments, []);
  assert.equal(empty.steepestSegment, null);
  assert.deepEqual(empty.overLimitSegments, []);
  assert.equal(empty.slopeLimitDeg, 17);
  assert.deepEqual(empty.profile, []);
  const one = pathMetrics(t, [idx(t, 2, 2)]);
  assert.deepEqual(one.segments, []);
  assert.equal(one.steepestSegment, null);
  assert.deepEqual(one.overLimitSegments, []);
  assert.equal(one.profile.length, 1);
});

test("a manually supplied path touching no-data returns non-finite segment metrics without throwing", () => {
  const z = new Float32Array(25).fill(0); z[2 * 5 + 2] = NaN;
  const t = createTerrain({ width: 5, height: 5, cellX: 10, cellY: 10, z });
  const m = pathMetrics(t, [idx(t, 1, 2), idx(t, 2, 2)], { maxSlopeDeg: 25 });
  assert.equal(m.segments.length, 1);
  assert.ok(Number.isNaN(m.segments[0].endElevationM));
  assert.ok(Number.isNaN(m.segments[0].elevationChangeM));
  assert.ok(Number.isNaN(m.segments[0].signedSlopeDeg));
  assert.equal(m.segments[0].exceedsSlopeLimit, false);
  assert.equal(m.overLimitSegments.length, 0);
  assert.equal(m.invalidSegments.length, 1);
  assert.equal(m.hasInvalidSegments, true);
  assert.equal(m.steepestSegment, null);
});

test("non-finite elevation values and out-of-range cells are explicitly invalid", () => {
  const z = new Float32Array(25).fill(0); z[2 * 5 + 2] = Infinity;
  const t = createTerrain({ width: 5, height: 5, cellX: 10, cellY: 10, z });
  const nonFinite = pathMetrics(t, [idx(t, 1, 2), idx(t, 2, 2)]).segments[0];
  assert.equal(nonFinite.isValid, false);
  assert.equal(nonFinite.invalidReason, "end-no-data");
  assert.equal(nonFinite.exceedsSlopeLimit, false);
  const outOfRange = pathMetrics(t, [idx(t, 1, 2), 25]).segments[0];
  assert.equal(outOfRange.isValid, false);
  assert.equal(outOfRange.invalidReason, "end-cell-out-of-range");
  assert.equal(outOfRange.exceedsSlopeLimit, false);
});

test("zero horizontal distance is invalid and is not treated as a slope pass", () => {
  const t = grid(5, 5, 10, 10, () => 2);
  const segment = pathMetrics(t, [idx(t, 2, 2), idx(t, 2, 2)]).segments[0];
  assert.equal(segment.horizontalDistanceM, 0);
  assert.equal(segment.isValid, false);
  assert.equal(segment.invalidReason, "invalid-horizontal-distance");
  assert.equal(segment.exceedsSlopeLimit, false);
});

test("mixed route separates valid, over-limit and invalid segments", () => {
  const z = new Float32Array(25).fill(0); z[idx({ width: 5 }, 2, 1)] = 10; z[2 * 5 + 3] = NaN;
  const t = createTerrain({ width: 5, height: 5, cellX: 10, cellY: 10, z });
  const path = [idx(t, 1, 1), idx(t, 2, 1), idx(t, 2, 2), idx(t, 3, 2)];
  const m = pathMetrics(t, path, { maxSlopeDeg: 25 });
  assert.deepEqual(m.segments.map(s => s.isValid), [true, true, false]);
  assert.equal(m.overLimitSegments.length, 2);
  assert.deepEqual(m.overLimitSegments.map(s => s.index), [0, 1]);
  assert.equal(m.invalidSegments.length, 1);
  assert.equal(m.hasInvalidSegments, true);
  assert.equal(m.steepestSegment.index, 0);
  assert.ok(m.invalidSegments.every(s => !s.exceedsSlopeLimit));
});

test("route containing only invalid segments has no steepest segment", () => {
  const z = new Float32Array(25).fill(0); z[2 * 5 + 2] = NaN;
  const t = createTerrain({ width: 5, height: 5, cellX: 10, cellY: 10, z });
  const m = pathMetrics(t, [idx(t, 1, 2), idx(t, 2, 2), idx(t, 3, 2)]);
  assert.equal(m.invalidSegments.length, 2);
  assert.equal(m.hasInvalidSegments, true);
  assert.equal(m.steepestSegment, null);
});

test("valid route legacy metrics are unchanged by segment diagnostics", () => {
  const t = grid(5, 5, 10, 10, (_x, _y, i) => i % 5);
  const path = [idx(t, 1, 1), idx(t, 2, 1), idx(t, 3, 1)];
  const m = pathMetrics(t, path, { maxSlopeDeg: 25 });
  near(m.lengthM, 2 * Math.hypot(10, 1));
  near(m.horizontalM, 20);
  near(m.ascentM, 2);
  near(m.descentM, 0);
  near(m.netElevationM, 2);
  near(m.maxEdgeSlopeDeg, Math.atan2(1, 10) / DEG);
  near(m.timeS, m.lengthM / walkSpeedMS(Math.atan2(1, 10) / DEG));
  assert.equal(m.profile.length, 3);
  assert.equal(m.invalidSegments.length, 0);
  assert.equal(m.hasInvalidSegments, false);
});

test("manual flat route samples at half-cell intervals and reports its geometry", () => {
  const t = grid(8, 6, 10, 10, () => 12);
  const a = analyzeManualRoute(t, [{ x: 15, y: 25 }, { x: 35, y: 25 }], { slopeLimitDeg: 20 });
  assert.equal(a.ok, true);
  assert.equal(a.samples.length, 5);
  assert.equal(a.segments.length, 4);
  near(a.samplingIntervalM, 5);
  near(a.totalHorizontalDistanceM, 20);
  near(a.totalAscentM, 0); near(a.totalDescentM, 0); near(a.netElevationChangeM, 0);
  assert.equal(a.maximumAbsoluteSlopeDeg, 0);
  assert.equal(a.terrainCoverageComplete, true);
  assert.equal(a.passesSlopeConstraint, true);
  assert.match(a.samplingPolicy, /half|0.5/);
});

test("single-grid manual route retains its established numeric metrics without a callback", () => {
  const t = grid(8, 6, 10, 10, () => 12);
  const a = analyzeManualRoute(t, [{ x: 15, y: 25 }, { x: 35, y: 25 }], { slopeLimitDeg: 20 });
  assert.deepEqual({ samples: a.samples.length, segments: a.segments.length, distance: a.totalHorizontalDistanceM,
    ascent: a.totalAscentM, descent: a.totalDescentM, net: a.netElevationChangeM, slope: a.maximumAbsoluteSlopeDeg,
    coverage: a.terrainCoverageComplete, passes: a.passesSlopeConstraint },
  { samples: 5, segments: 4, distance: 20, ascent: 0, descent: 0, net: 0, slope: 0, coverage: true, passes: true });
  assert.equal(a.samples.some(sample => "datasetId" in sample), false);
});

test("callback-backed analysis uses elevations and retains cross-tile sample provenance", () => {
  const t = grid(8, 6, 10, 10, () => 9999);
  const callback = (x, y) => ({ isValid: true, elevationM: x, invalidReason: null,
    datasetId: "urn:test:ctx", tileId: x < 25 ? "ctx_r000_c000" : "ctx_r000_c001",
    sourceRow: Math.floor(y / 10), sourceColumn: Math.floor(x / 10),
    nativeSpatialResolutionM: { x: 10, y: 10 }, samplingMethod: "bilinear",
    projectedCoordinatesM: { x: 1000 + x, y: 2000 - y } });
  const a = analyzeManualRoute(t, [{ x: 15, y: 25 }, { x: 35, y: 25 }], { slopeLimitDeg: 20, sampleDetailsAt: callback });
  assert.equal(a.samples[0].elevationM, 15);
  assert.equal(a.samples.at(-1).elevationM, 35);
  assert.deepEqual(new Set(a.samples.map(sample => sample.tileId)), new Set(["ctx_r000_c000", "ctx_r000_c001"]));
  assert.equal(a.samples[0].datasetId, "urn:test:ctx");
  assert.deepEqual(a.samples[0].nativeSpatialResolutionM, { x: 10, y: 10 });
  assert.deepEqual(a.samples[0].projectedCoordinatesM, { x: 1015, y: 1975 });
  assert.equal(a.segments[0].start, a.samples[0]);
  assert.equal(a.segments.at(-1).end, a.samples.at(-1));
  assert.ok(a.overLimitSegments.length > 0);
  assert.equal(a.invalidSegments.length, 0);
});

test("callback invalid reasons survive and invalid samples do not fabricate slopes", () => {
  const t = grid(8, 6, 10, 10, () => 500);
  const callback = (x, y) => x === 25
    ? { isValid: false, elevationM: 0, invalidReason: "source-no-data-support", datasetId: "urn:test:ctx", tileId: "ctx_r000_c000" }
    : { isValid: true, elevationM: x, invalidReason: null, datasetId: "urn:test:ctx", tileId: x < 25 ? "ctx_r000_c000" : "ctx_r000_c001" };
  const a = analyzeManualRoute(t, [{ x: 15, y: 25 }, { x: 35, y: 25 }], { slopeLimitDeg: 20, sampleDetailsAt: callback });
  const invalidSample = a.samples.find(sample => !sample.isValid);
  assert.equal(invalidSample.invalidReason, "source-no-data-support");
  assert.equal(invalidSample.elevationM, null);
  assert.ok(a.invalidSegments.length > 0);
  assert.ok(a.invalidSegments.every(segment => Number.isNaN(segment.signedSlopeDeg) && Number.isNaN(segment.absoluteSlopeDeg) && !segment.exceedsSlopeLimit));
  assert.ok(a.overLimitSegments.length > 0);
  assert.ok(a.overLimitSegments.every(segment => segment.isValid && segment.exceedsSlopeLimit));
  assert.equal(a.terrainCoverageComplete, false);
  assert.equal(a.passesSlopeConstraint, false);
});

test("sampling callback failures propagate and Promise results are rejected synchronously", () => {
  const t = grid(8, 6, 10, 10, () => 0), waypoints = [{ x: 15, y: 25 }, { x: 35, y: 25 }];
  const failure = new Error("CTX tile integrity failure");
  assert.throws(() => analyzeManualRoute(t, waypoints, { sampleDetailsAt: () => { throw failure; } }), error => error === failure);
  assert.throws(() => analyzeManualRoute(t, waypoints, { sampleDetailsAt: () => Promise.resolve({ isValid: true, elevationM: 0 }) }),
    error => error instanceof TypeError && /synchronously/.test(error.message));
  assert.throws(() => analyzeManualRoute(t, waypoints, { sampleDetailsAt: () => ({ isValid: "yes", elevationM: 0 }) }),
    error => error instanceof TypeError && /boolean isValid/i.test(error.message));
});

test("callback analysis does not initiate asynchronous tile fetching", () => {
  const t = grid(8, 6, 10, 10, () => 0), waypoints = [{ x: 15, y: 25 }, { x: 35, y: 25 }];
  let callbackCalls = 0, tileFetches = 0;
  const sampleDetailsAt = (x, y) => {
    callbackCalls++;
    assert.equal(tileFetches, 0);
    return { isValid: true, elevationM: x, tileId: "preloaded-tile" };
  };
  analyzeManualRoute(t, waypoints, { sampleDetailsAt });
  assert.equal(callbackCalls, 5);
  assert.equal(tileFetches, 0);
});

test("manual uphill and downhill routes report signed slopes and cumulative elevation", () => {
  const uphill = grid(8, 6, 10, 10, x => 2 * x);
  const up = analyzeManualRoute(uphill, [{ x: 15, y: 25 }, { x: 45, y: 25 }], { slopeLimitDeg: 60 });
  near(up.totalAscentM, 60); near(up.totalDescentM, 0); near(up.netElevationChangeM, 60);
  assert.ok(up.segments.every(segment => segment.signedSlopeDeg > 0));
  near(up.maximumAbsoluteSlopeDeg, Math.atan2(10, 5) / DEG);

  const down = analyzeManualRoute(uphill, [{ x: 45, y: 25 }, { x: 15, y: 25 }], { slopeLimitDeg: 60 });
  near(down.totalAscentM, 0); near(down.totalDescentM, 60); near(down.netElevationChangeM, -60);
  assert.ok(down.segments.every(segment => segment.signedSlopeDeg < 0));
});

test("manual route preserves corners and waypoint order across multiple legs", () => {
  const t = grid(8, 8, 10, 10, () => 0);
  const a = analyzeManualRoute(t, [{ x: 15, y: 15 }, { x: 35, y: 15 }, { x: 35, y: 35 }]);
  near(a.totalHorizontalDistanceM, 40);
  const corner = a.samples.findIndex(sample => sample.waypointIndex === 1);
  assert.ok(corner >= 0);
  assert.deepEqual({ x: a.samples[corner].x, y: a.samples[corner].y }, { x: 35, y: 15 });
  assert.equal(a.samples[corner - 1].legIndex, 0);
  assert.equal(a.samples[corner + 1].legIndex, 1);
});

test("manual diagonal leg uses planetary horizontal distance and half-cell sampling", () => {
  const t = grid(8, 8, 10, 10, () => 0);
  const a = analyzeManualRoute(t, [{ x: 15, y: 15 }, { x: 35, y: 35 }]);
  near(a.totalHorizontalDistanceM, Math.hypot(20, 20));
  assert.equal(a.samples.length, 7);
  assert.ok(a.segments.every(segment => Math.abs(segment.horizontalDistanceM - Math.hypot(20 / 6, 20 / 6)) < 1e-6));
});

test("manual route samples intermediate terrain and detects a slope hidden by equal endpoint heights", () => {
  const t = grid(9, 6, 10, 10, (_x, _y, i) => i === 3 ? 10 : 0);
  const a = analyzeManualRoute(t, [{ x: 15, y: 25 }, { x: 65, y: 25 }], { slopeLimitDeg: 20 });
  near(a.samples[0].elevationM, a.samples.at(-1).elevationM);
  assert.ok(a.samples.length > 2);
  assert.ok(a.overLimitSegments.length > 0);
  assert.ok(a.overLimitSegments.some(segment => segment.absoluteSlopeDeg > 20));
  assert.equal(a.passesSlopeConstraint, false);
});

test("manual route crossing no-data preserves invalid samples and does not bridge the gap", () => {
  const z = new Float32Array(9 * 6).fill(0);
  for (let j = 0; j < 6; j++) z[j * 9 + 4] = NaN;
  const t = createTerrain({ width: 9, height: 6, cellX: 10, cellY: 10, z });
  const a = analyzeManualRoute(t, [{ x: 15, y: 25 }, { x: 65, y: 25 }], { slopeLimitDeg: 25 });
  assert.ok(a.samples.some(sample => !sample.isValid && sample.invalidReason === "no-data"));
  assert.ok(a.invalidSegments.length > 0);
  assert.equal(a.terrainCoverageComplete, false);
  assert.equal(a.passesSlopeConstraint, false);
  assert.ok(a.invalidSegments.every(segment => !segment.exceedsSlopeLimit));
  near(a.totalHorizontalDistanceM, 50); // Geometry is known even where elevation coverage is missing.
});

test("manual route reports out-of-coverage start and end samples explicitly", () => {
  const t = grid(6, 6, 10, 10, () => 3);
  const startOutside = analyzeManualRoute(t, [{ x: -2, y: 15 }, { x: 25, y: 15 }]);
  assert.equal(startOutside.samples[0].invalidReason, "outside-terrain");
  assert.ok(startOutside.invalidSegments.some(segment => segment.invalidReason === "start-outside-terrain"));
  assert.equal(startOutside.terrainCoverageComplete, false);
  const endOutside = analyzeManualRoute(t, [{ x: 15, y: 15 }, { x: 62, y: 15 }]);
  assert.equal(endOutside.samples.at(-1).invalidReason, "outside-terrain");
  assert.ok(endOutside.invalidSegments.some(segment => segment.invalidReason === "end-outside-terrain"));
});

test("manual route handles a very short leg and rejects fewer than two waypoints clearly", () => {
  const t = grid(6, 6, 10, 10, x => x);
  const short = analyzeManualRoute(t, [{ x: 15, y: 15 }, { x: 16, y: 15 }]);
  assert.equal(short.samples.length, 2);
  assert.equal(short.segments.length, 1);
  near(short.totalHorizontalDistanceM, 1);
  const tooShort = analyzeManualRoute(t, [{ x: 15, y: 15 }]);
  assert.equal(tooShort.ok, false);
  assert.equal(tooShort.code, "waypoints");
  assert.equal(tooShort.passesSlopeConstraint, false);
});

test("manual analysis does not change automatic Dijkstra route metrics", () => {
  const t = grid(8, 6, 10, 10, x => x);
  const start = idx(t, 1, 2), goal = idx(t, 5, 2);
  const before = planRoute(t, start, goal, { objective: "shortest", maxSlopeDeg: 25 });
  analyzeManualRoute(t, [{ x: 15, y: 25 }, { x: 55, y: 25 }], { slopeLimitDeg: 25 });
  const after = planRoute(t, start, goal, { objective: "shortest", maxSlopeDeg: 25 });
  assert.deepEqual(after, before);
});

test("a wall with no gap makes the destination unreachable and returns no path", () => {
  const t = grid(21, 11, 10, 10, x => (x > 95 && x < 115 ? 500 : 0));
  const r = planRoute(t, idx(t, 2, 5), idx(t, 18, 5), { objective: "fastest" });
  assert.equal(r.ok, false); assert.equal(r.code, "unreachable"); assert.equal(r.path, undefined);
  assert.match(r.message, /No path exists/);
});

test("a gap in the wall is found, and raising the slope limit opens the direct line", () => {
  const wall = (x, y) => (x > 95 && x < 115 && (y < 20 || y > 40) ? 30 : 0);
  const t = grid(21, 11, 10, 10, wall);
  const detour = planRoute(t, idx(t, 2, 0), idx(t, 18, 0), { objective: "shortest", maxSlopeDeg: 25 });
  assert.equal(detour.ok, false); // start is on the northern segment, wall is 30 m high over 10 m: blocked all along y<20
  const t2 = grid(21, 11, 10, 10, (x, y) => (x > 95 && x < 115 && (y < 20 || y > 60) ? 30 : 0));
  const d = planRoute(t2, idx(t2, 2, 5), idx(t2, 18, 5), { objective: "shortest", maxSlopeDeg: 25 });
  assert.ok(d.ok);
  assert.ok(d.metrics.lengthM >= 160 - 1e-6);
});

test("slope limit is configurable and its rejection explains itself", () => {
  const t = grid(21, 5, 10, 10, x => Math.tan(30 * DEG) * x);
  const strict = planRoute(t, idx(t, 0, 2), idx(t, 20, 2), { objective: "fastest", maxSlopeDeg: 25 });
  assert.equal(strict.ok, false); assert.match(strict.message, /25°/);
  const loose = planRoute(t, idx(t, 0, 2), idx(t, 20, 2), { objective: "fastest", maxSlopeDeg: 35 });
  assert.ok(loose.ok);
});

test("start or destination on prohibited or no-data ground is rejected, not drawn as a one-point route", () => {
  const z = new Float32Array(81).fill(0); z[40] = NaN;
  const t = createTerrain({ width: 9, height: 9, cellX: 5, cellY: 5, z });
  assert.equal(planRoute(t, 40, 0, { objective: "fastest" }).code, "start-blocked");
  assert.equal(planRoute(t, 0, 40, { objective: "fastest" }).code, "goal-blocked");
  assert.equal(planRoute(t, 4, 4, { objective: "fastest" }).code, "same-cell");
});

test("routes never cross no-data cells", () => {
  const z = new Float32Array(15 * 7).fill(0); for (let j = 0; j < 6; j++) z[j * 15 + 7] = NaN;
  const t = createTerrain({ width: 15, height: 7, cellX: 5, cellY: 5, z });
  const r = planRoute(t, 3 * 15, 3 * 15 + 14, { objective: "shortest" });
  assert.ok(r.ok); assert.ok(r.path.every(c => Number.isFinite(t.z[c])));
  assert.ok(r.metrics.lengthM > 70);
});

test("objectives are distinct: shortest is never longer, fastest is never slower, lower risk is never steeper on average", () => {
  const t = testTile();
  const s = cellAt(t, 312, 512), g = cellAt(t, 2262, 512);
  const out = Object.fromEntries(["shortest", "fastest", "lowrisk"].map(o => [o, planRoute(t, s, g, { objective: o })]));
  for (const r of Object.values(out)) assert.ok(r.ok, r.message);
  assert.ok(out.shortest.metrics.lengthM <= out.fastest.metrics.lengthM + 1e-6);
  assert.ok(out.shortest.metrics.lengthM <= out.lowrisk.metrics.lengthM + 1e-6);
  assert.ok(out.fastest.metrics.timeS <= out.shortest.metrics.timeS + 1e-6);
  assert.ok(out.fastest.metrics.timeS <= out.lowrisk.metrics.timeS + 1e-6);
  // the escarpment forces every route through the pass (y = 1250–1700 m)
  for (const r of Object.values(out)) assert.ok(r.metrics.lengthM > 2000, `length ${r.metrics.lengthM}`);
});

test("on the test tile the pass makes the route much longer than the straight line (physical distance, not cells)", () => {
  const t = testTile();
  const r = planRoute(t, cellAt(t, 312, 512), cellAt(t, 2262, 512), { objective: "shortest" });
  assert.ok(r.metrics.horizontalM > 2300 && r.metrics.horizontalM < 3500, `${r.metrics.horizontalM}`); // straight line is 1950 m
});

test("science objective needs targets, passes closer to them, and is never faster than the fastest route", () => {
  const t = grid(41, 21, 10, 10, () => 0);
  const s = idx(t, 1, 10), g = idx(t, 39, 10);
  const none = planRoute(t, s, g, { objective: "science", targets: [] });
  assert.equal(none.ok, false); assert.equal(none.code, "no-targets");
  const targets = [{ name: "T", x: 205, y: 185, radiusM: 100 }]; // 80 m off the straight line
  const f = planRoute(t, s, g, { objective: "fastest", targets });
  const sc = planRoute(t, s, g, { objective: "science", targets });
  assert.ok(f.ok && sc.ok);
  assert.equal(f.metrics.scienceStops.length, 1); assert.equal(sc.metrics.scienceStops.length, 1);
  assert.ok(sc.metrics.scienceStops[0].offsetM < f.metrics.scienceStops[0].offsetM - 10, "science route should pass clearly closer");
  assert.ok(sc.metrics.timeS >= f.metrics.timeS - 1e-6);
  assert.ok(sc.metrics.lengthM > f.metrics.lengthM);
});

test("recalculation: changing start, destination or terrain changes the result", () => {
  const t = testTile(), g = cellAt(t, 2262, 512);
  const a = planRoute(t, cellAt(t, 312, 512), g, { objective: "fastest" });
  const b = planRoute(t, cellAt(t, 312, 1200), g, { objective: "fastest" });
  const c = planRoute(t, cellAt(t, 312, 512), cellAt(t, 2262, 1500), { objective: "fastest" });
  assert.notEqual(a.metrics.lengthM, b.metrics.lengthM);
  assert.notEqual(a.metrics.lengthM, c.metrics.lengthM);
  const flat = grid(100, 80, 25, 25, () => 0);
  const d = planRoute(flat, cellAt(flat, 312, 512), g, { objective: "fastest" });
  assert.ok(d.metrics.lengthM < a.metrics.lengthM);
});

test("route dose uses a longer exposure for a slower route and scales with the scenario multiplier", () => {
  const t = grid(21, 5, 10, 10, () => 0);
  const base = planRoute(t, idx(t, 0, 2), idx(t, 20, 2), { objective: "shortest", doseMultiplier: 1 });
  const high = planRoute(t, idx(t, 0, 2), idx(t, 20, 2), { objective: "shortest", doseMultiplier: 1.5 });
  near(high.metrics.doseOneWayMSv / base.metrics.doseOneWayMSv, 1.5, 1e-9);
  near(base.metrics.doseOneWayMSv, 0.64 * (base.metrics.timeS / 86400), 0.64 * base.metrics.timeS / 86400 * 0.01); // sky view ≈ 1 on flat ground
});

test("unknown objective is reported", () => {
  const t = grid(5, 5, 1, 1, () => 0);
  assert.equal(planRoute(t, 0, 24, { objective: "teleport" }).code, "objective");
  assert.deepEqual(Object.keys(OBJECTIVES), ["shortest", "fastest", "lowrisk", "science"]);
});

const realCtxDirectory = fileURLToPath(new URL("../data/processed/ctx-jezero/", import.meta.url));
test("optional local CTX route analysis crosses a real tile boundary", { skip: !existsSync(`${realCtxDirectory}/catalog.json`) }, async t => {
  const server = createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, "http://localhost").pathname.slice(1));
    if (!/^(catalog\.json|ctx_r\d{3}_c\d{3}\.(json|f32))$/.test(name)) { res.writeHead(404).end(); return; }
    try {
      const bytes = readFileSync(`${realCtxDirectory}/${name}`);
      res.writeHead(200, { "Content-Type": name.endsWith(".json") ? "application/json" : "application/octet-stream" }).end(bytes);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const manager = createCtxTerrainManager({ catalogUrl: `${base}catalog.json`, tileBaseUrl: base });
  const sampler = createCtxTerrainSampler({ manager });
  const catalog = await sampler.loadCatalog();
  const rightTile = catalog.tiles.find(tile => tile.tile_id === "ctx_r000_c001");
  const boundaryX = rightTile.core_window.col_off * 20;
  const y = 1000;
  const waypoints = [{ x: boundaryX - 50, y }, { x: boundaryX + 50, y }];
  await sampler.ensureTilesForPath(waypoints);
  const analysis = analyzeManualRoute(sampler, waypoints, { sampleDetailsAt: (x, py) => sampler.sampleDetailsAt(x, py) });
  assert.equal(analysis.ok, true);
  assert.ok(analysis.samples.some(sample => sample.tileId === "ctx_r000_c000"));
  assert.ok(analysis.samples.some(sample => sample.tileId === "ctx_r000_c001"));
  assert.equal(analysis.samples[0].datasetId, catalog.dataset_id);
});
