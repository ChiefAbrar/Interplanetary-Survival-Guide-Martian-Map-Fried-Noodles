import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTile } from "../public/js/dem-format.js";
import { cellAt, elevationAt, latLonToLocal, localToLatLon } from "../public/js/terrain.js";
import { planRoute } from "../public/js/routing.js";

const path = new URL("../public/data/jezero-hirise-tile.json", import.meta.url);

test("real Jezero HiRISE DTM derivative preserves provenance, geometry, samples, slope and a local route", () => {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(doc.source.product_id, "DTEEC_045994_1985_046060_1985_U01");
  assert.equal(doc.source.sha256, "b40739b4d32516ef9b3cd849f519a6a20df9720b5369a9c141047ced27c57654");
  assert.ok(doc.source.processing.some(s => s.includes("PC_REAL 32-bit little-endian")));
  assert.ok(doc.source.processing.some(s => s.includes("Mars 2000 equipotential")));
  assert.ok(doc.source.processing.some(s => s.includes("IMAGE dimensions match exactly")));
  assert.equal(doc.width, 333); assert.equal(doc.height, 713);
  assert.ok(doc.width * doc.height <= 250_000);
  assert.ok(doc.cell_x_m > 19 && doc.cell_x_m < 20);
  assert.ok(doc.cell_y_m > 20 && doc.cell_y_m < 21);
  assert.ok(doc.geo.min_lon_deg > 77.38 && doc.geo.max_lon_deg < 77.50);
  assert.ok(doc.geo.min_lat_deg > 18.30 && doc.geo.max_lat_deg < 18.55);

  const terrain = parseTile(JSON.stringify(doc));
  assert.ok(terrain.validCount > 170_000 && terrain.invalidCount > 0);
  assert.ok(terrain.min > -2679.3 && terrain.max < -2388.2);
  assert.equal(terrain.geo.type, "equirectangular");
  const center = localToLatLon(terrain, terrain.widthM / 2, terrain.heightM / 2);
  assert.ok(center.lat > 18.4 && center.lat < 18.5);
  assert.ok(center.lon > 77.4 && center.lon < 77.5);
  const reverse = latLonToLocal(terrain, center.lat, center.lon);
  assert.ok(Math.abs(reverse.x - terrain.widthM / 2) < 1e-6);
  assert.ok(Math.abs(reverse.y - terrain.heightM / 2) < 1e-6);

  const { start, destination } = doc.default_route;
  const startIndex = cellAt(terrain, start.x_m, start.y_m);
  const goalIndex = cellAt(terrain, destination.x_m, destination.y_m);
  assert.ok(startIndex >= 0 && goalIndex >= 0 && startIndex !== goalIndex);
  assert.ok(Number.isFinite(elevationAt(terrain, start.x_m, start.y_m)));
  assert.ok(Number.isFinite(terrain.slope[startIndex]));
  const route = planRoute(terrain, startIndex, goalIndex, { objective: "fastest", maxSlopeDeg: 25 });
  assert.equal(route.ok, true, route.message);
  assert.ok(route.metrics.lengthM > 150 && route.metrics.lengthM < 400);

  const noDataIndex = terrain.z.findIndex(v => !Number.isFinite(v));
  assert.ok(noDataIndex >= 0, "real DTM retains unsupported source gaps as no-data");
  const x = ((noDataIndex % terrain.width) + 0.5) * terrain.cellX;
  const y = (Math.floor(noDataIndex / terrain.width) + 0.5) * terrain.cellY;
  assert.equal(elevationAt(terrain, x, y), null);
});
