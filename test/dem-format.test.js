import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTile, parsePdsLabel, readPdsDownsampled, readMolaDownsampled, loadDemFiles, ImportError, LIMITS } from "../public/js/dem-format.js";
import { cellAt, cellCentre, localToLatLon, latLonToLocal, TerrainError } from "../public/js/terrain.js";
import { planRoute } from "../public/js/routing.js";

const read = p => readFileSync(new URL(p, import.meta.url));
const testTile = () => parseTile(readFileSync(new URL("../public/data/test-terrain.json", import.meta.url), "utf8"));
const fileLike = (name, buf) => Object.assign(new Blob([buf]), { name });

test("bundled test tile keeps its physical scale and footprint", () => {
  const t = testTile();
  assert.equal(t.width, 100); assert.equal(t.height, 80);
  assert.equal(t.cellX, 25); assert.equal(t.widthM, 2500); assert.equal(t.heightM, 2000);
  assert.equal(t.meta.kind, "synthetic-test");
  assert.equal(t.geo, null);
});

test("z_scale and the no-data sentinel are applied (no -32768 leaks into the range)", () => {
  const t = testTile();
  assert.equal(t.invalidCount, 36);          // 6 × 6 patch
  assert.ok(t.min > -100 && t.max < 200, `range ${t.min}..${t.max}`);
  assert.ok(Number.isNaN(t.z[38 * 100 + 25]));
});

test("markers placed in metres land on the intended cell after load", () => {
  const t = testTile();
  const c = cellAt(t, 300, 500);
  assert.deepEqual(cellCentre(t, c), { x: 312.5, y: 512.5 });
  for (const tg of t.meta.targets) assert.ok(cellAt(t, tg.x, tg.y) >= 0, tg.name);
});

test("loading a different tile replaces the footprint and scale", () => {
  const raw = JSON.parse(readFileSync(new URL("../public/data/test-terrain.json", import.meta.url), "utf8"));
  const small = { ...raw, width: 10, height: 8, cell_x_m: 4, cell_y_m: 4, z: raw.z.slice(0, 80), targets: [] };
  const t = parseTile(JSON.stringify(small));
  assert.equal(t.widthM, 40); assert.equal(t.heightM, 32); assert.equal(t.meta.targets.length, 0);
});

test("malformed tiles produce specific error codes", () => {
  const raw = JSON.parse(readFileSync(new URL("../public/data/test-terrain.json", import.meta.url), "utf8"));
  const code = (obj, text) => { try { parseTile(text ?? JSON.stringify(obj)); } catch (e) { assert.ok(e instanceof TerrainError); return e.code; } return "none"; };
  assert.equal(code(null, "{not json"), "malformed");
  assert.equal(code({ ...raw, format: "x" }), "format");
  assert.equal(code({ ...raw, version: 9 }), "version");
  assert.equal(code({ ...raw, elevation_unit: "ft" }), "units");
  assert.equal(code({ ...raw, cell_x_m: 0 }), "spacing");
  assert.equal(code({ ...raw, z: raw.z.slice(1) }), "length");
  assert.equal(code({ ...raw, z_scale: 0 }), "scaling");
  assert.equal(code({ ...raw, targets: [{ name: "x" }] }), "targets");
  assert.equal(code({ ...raw, geo: { type: "utm" } }), "geo");
  assert.equal(code({ ...raw, z: raw.z.map(() => raw.nodata) }), "no-data");
  assert.equal(code({ ...raw, width: 5000, height: 5000, z: [] }), "too-large");
});

test("oversize files are refused before parsing", () => {
  assert.throws(() => parseTile("{}", { sizeBytes: LIMITS.maxTileBytes + 1 }), e => e.code === "too-large" && /MB/.test(e.message));
});

test("MOLA MEGDR label and signed big-endian int16 reader preserve values, no-data, and coverage", async () => {
  const lbl = `PDS_VERSION_ID = PDS3\nPRODUCT_ID = "MEGT44N000HB.IMG"\nSPACECRAFT_NAME = "MARS GLOBAL SURVEYOR"\nINSTRUMENT_NAME = "MARS ORBITER LASER ALTIMETER"\nLINES = 4\nLINE_SAMPLES = 4\nSAMPLE_TYPE = MSB_INTEGER\nSAMPLE_BITS = 16\nUNIT = METER\nRECORD_BYTES = 8\nMAP_SCALE = 17.453 <KM/PIXEL>\nMAP_RESOLUTION = 1 <PIXEL/DEGREE>\nA_AXIS_RADIUS = 1000 <KM>\nMAP_PROJECTION_TYPE = "SIMPLE CYLINDRICAL"\nPOSITIVE_LONGITUDE_DIRECTION = "EAST"\nCENTER_LATITUDE = 0 <DEGREE>\nCENTER_LONGITUDE = 2 <DEGREE>\nMINIMUM_LATITUDE = -2 <DEGREE>\nMAXIMUM_LATITUDE = 2 <DEGREE>\nWESTERNMOST_LONGITUDE = 0 <DEGREE>\nEASTERNMOST_LONGITUDE = 4 <DEGREE>\nCOORDINATE_SYSTEM_NAME = "PLANETOCENTRIC"\nLINE_PROJECTION_OFFSET = 2.5\nSAMPLE_PROJECTION_OFFSET = 2.5\nEND\n`;
  const meta = parsePdsLabel(lbl);
  assert.equal(meta.isMola, true); assert.equal(meta.sampleBits, 16); assert.equal(meta.mapScaleM, 17453);
  assert.equal(meta.geo.type, "simple-cylindrical"); assert.equal(meta.geo.planetocentric, true);
  const raw = Buffer.alloc(4 * 4 * 2);
  [11, 12, 13, 14, 21, -32768, 23, 24, 31, 32, 33, 34, 41, 42, 43, 44].forEach((v, i) => raw.writeInt16BE(v, i * 2));
  const t = await readMolaDownsampled(fileLike("mola.img", raw), meta, { maxCells: 16 });
  assert.deepEqual(Array.from(t.z.slice(0, 4)), [11, 12, 13, 14]);
  assert.ok(Number.isNaN(t.z[5])); assert.ok(Math.abs(t.cellX - 17453) < 1);
  assert.equal(t.meta.source.product_id, "MEGT44N000HB.IMG");
  assert.equal(t.geo.type, "simple-cylindrical");
  const imported = await loadDemFiles([fileLike("MEGT44N000HB.IMG", raw), fileLike("MEGT44N000HB.LBL", Buffer.from(lbl))]);
  assert.equal(imported.terrain.meta.source.instrument, "MARS ORBITER LASER ALTIMETER");
  await assert.rejects(loadDemFiles([fileLike("wrong.img", raw), fileLike("MEGT44N000HB.LBL", Buffer.from(lbl))]), e => e.code === "product-mismatch");
});

test("bundled real MOLA tile is numerical, georeferenced, and preserves limited product coverage", () => {
  const t = parseTile(readFileSync(new URL("../public/data/mola-megt44n000hb.json", import.meta.url), "utf8"));
  assert.equal(t.meta.source.product_id, "MEGT44N000HB");
  assert.equal(t.meta.source.mission, "MARS GLOBAL SURVEYOR");
  assert.equal(t.meta.source.instrument, "MARS ORBITER LASER ALTIMETER");
  assert.equal(t.geo.type, "simple-cylindrical"); assert.equal(t.geo.planetocentric, true);
  assert.equal(t.geo.minLonDeg, 0); assert.ok(Math.abs(t.geo.maxLonDeg - 677 * 17 / 128) < 1e-9);
  assert.ok(Math.abs(t.geo.minLatDeg - (44 - 331 * 17 / 128)) < 1e-9); assert.equal(t.geo.maxLatDeg, 44);
  assert.ok(t.max > 1000 && t.min < -1000); assert.ok(t.width * t.height <= 250000);
  const firstCell = localToLatLon(t, t.cellX / 2, t.cellY / 2);
  assert.ok(Math.abs(firstCell.lon - 17 / (2 * 128)) < 1e-6, `first tile column longitude ${firstCell.lon}`);
  assert.ok(Math.abs(firstCell.lat - (44 - 17 / (2 * 128))) < 1e-6, `first tile row latitude ${firstCell.lat}`);
  const { start, goal } = t.meta.defaultRoute;
  const route = planRoute(t, cellAt(t, start.x, start.y), cellAt(t, goal.x, goal.y), { objective: "shortest", maxSlopeDeg: 25 });
  assert.ok(route.ok); assert.ok(route.metrics.lengthM < 8000, `default MOLA sample is ${route.metrics.lengthM} m`);
});

test("PDS label: scale, sentinel and georeference are read", () => {
  const m = parsePdsLabel(read("fixtures/pds_fixture.LBL").toString());
  assert.equal(m.lines, 40); assert.equal(m.samples, 60); assert.equal(m.mapScaleM, 2);
  assert.equal(m.productId, "FIXTURE_PRODUCT"); assert.equal(m.mission, "FIXTURE_MISSION"); assert.equal(m.instrument, "FIXTURE_INSTRUMENT");
  assert.equal(m.littleEndian, true);
  assert.ok(m.missing < -3.4e38 || m.missing === -3.4028226550889045e+38 || m.missing < -1e38);
  assert.equal(m.radiusM, 3396190);
  assert.ok(m.geo && m.geo.originXM === -500.5 * 2 && m.geo.originYM === 1100.5 * 2);
});

test("PDS reader output matches the independent Python converter cell for cell", async () => {
  const meta = parsePdsLabel(read("fixtures/pds_fixture.LBL").toString());
  const t = await readPdsDownsampled(fileLike("f.IMG", read("fixtures/pds_fixture.IMG")), meta, { maxCells: 600 });
  const py = parseTile(read("fixtures/pds_fixture.tile.json").toString());
  assert.equal(t.width, py.width); assert.equal(t.height, py.height);
  assert.equal(t.cellX, py.cellX); assert.equal(t.cellX, 4);   // 2 m native × factor 2
  for (let i = 0; i < t.z.length; i++) {
    if (Number.isNaN(py.z[i])) assert.ok(Number.isNaN(t.z[i]), `cell ${i}`);
    else assert.ok(Math.abs(t.z[i] - py.z[i]) < 0.006, `cell ${i}: ${t.z[i]} vs ${py.z[i]}`);
  }
  assert.ok(t.max < 200 && t.min > 0, "the -3.4e38 missing constant must not enter the range");
  assert.deepEqual(t.geo, py.geo);
});

test("PDS georeference: a point can be converted to latitude/longitude and back", async () => {
  const meta = parsePdsLabel(read("fixtures/pds_fixture.LBL").toString());
  const t = await readPdsDownsampled(fileLike("f.IMG", read("fixtures/pds_fixture.IMG")), meta, { maxCells: 600 });
  const ll = localToLatLon(t, 50, 30), b = latLonToLocal(t, ll.lat, ll.lon);
  assert.ok(Math.abs(b.x - 50) < 1e-6 && Math.abs(b.y - 30) < 1e-6);
  // sample offset 500 px at 2 m/px → projection origin 1000 m west of the corner, so the corner is west of 77°E
  assert.ok(localToLatLon(t, 0, 0).lon < 77);
});

test("PDS import fails clearly on truncated data, missing scale, missing label and wrong sample type", async () => {
  const lbl = read("fixtures/pds_fixture.LBL").toString(), img = read("fixtures/pds_fixture.IMG");
  const meta = parsePdsLabel(lbl);
  await assert.rejects(readPdsDownsampled(fileLike("f.IMG", img.subarray(0, 1000)), meta), e => e.code === "truncated");
  assert.throws(() => parsePdsLabel(lbl.replace(/MAP_SCALE.*\n/, "")), e => e.code === "scale");
  assert.throws(() => parsePdsLabel("LINES = 3"), e => e.code === "label");
  assert.throws(() => parsePdsLabel(lbl.replace("SAMPLE_BITS = 32", "SAMPLE_BITS = 16")), e => e.code === "format");
});

test("loadDemFiles: tile, PDS pair, missing label, unsupported type and empty selection", async () => {
  const tile = readFileSync(new URL("../public/data/test-terrain.json", import.meta.url));
  const { terrain } = await loadDemFiles([fileLike("t.json", tile)]);
  assert.equal(terrain.width, 100);
  const pds = await loadDemFiles([fileLike("a.IMG", read("fixtures/pds_fixture.IMG")), fileLike("a.LBL", read("fixtures/pds_fixture.LBL"))]);
  assert.equal(pds.terrain.meta.name, "a.IMG");
  assert.equal(pds.terrain.meta.source.product_id, "FIXTURE_PRODUCT");
  assert.equal(pds.terrain.meta.source.mission, "FIXTURE_MISSION");
  assert.equal(pds.terrain.meta.source.instrument, "FIXTURE_INSTRUMENT");
  assert.match(pds.terrain.meta.source.processing.join(" "), /Block-averaged/);
  await assert.rejects(loadDemFiles([fileLike("a.IMG", read("fixtures/pds_fixture.IMG"))]), e => e.code === "label");
  await assert.rejects(loadDemFiles([fileLike("a.tif", "II*")]), e => e.code === "unsupported" && /GeoTIFF/.test(e.message));
  await assert.rejects(loadDemFiles([]), e => e.code === "none");
});

test("a large PDS raster is read in strips and downsampled to the planner budget", async () => {
  const lines = 1200, samples = 1500, buf = Buffer.alloc(lines * samples * 4);
  for (let j = 0; j < lines; j++) for (let i = 0; i < samples; i++) buf.writeFloatLE(j * 0.5, (j * samples + i) * 4); // slope 0.5 in y at 1 m/px → 26.57°
  const meta = { lines, samples, mapScaleM: 1, littleEndian: true, recordBytes: 0, imageRecord: null, scalingFactor: 1, offset: 0, missing: null, geo: null };
  const t = await readPdsDownsampled(fileLike("big.IMG", buf), meta, { maxCells: 20000 });
  assert.ok(t.width * t.height <= 20000);
  const f = t.meta.downsampleFactor; assert.ok(f >= 9);
  assert.equal(t.cellX, f);
  const mid = t.slope[(t.height >> 1) * t.width + (t.width >> 1)];
  assert.ok(Math.abs(mid - Math.atan(0.5) * 180 / Math.PI) < 0.01, `slope ${mid}`);
});
