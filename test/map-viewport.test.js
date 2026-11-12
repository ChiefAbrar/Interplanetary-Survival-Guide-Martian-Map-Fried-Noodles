import test from "node:test";
import assert from "node:assert/strict";
import { createTerrain, localToLatLon } from "../public/js/terrain.js";
import { JEZERO_CTX_RELIEF_BOUNDS, JEZERO_REGIONAL_EXTENT, createRegionalViewport, sourceLocalToViewport, viewportLocalToSource, viewportPixelToSource } from "../public/js/map-viewport.js";
import { fitMapCssSize } from "../public/js/terrain-rendering.js";

const radiusM = 3_396_190;
function makeHiRiseGrid() {
  const widthM = 12_000, heightM = 14_000, centerLat = 18.4, centerLon = 77.4;
  return createTerrain({ width: 12, height: 14, cellX: 1_000, cellY: 1_000, z: new Float32Array(168),
    geo: { type: "equirectangular", radiusM, centerLatDeg: 0, centerLonDeg: centerLon,
      originXM: -widthM / 2, originYM: radiusM * centerLat * Math.PI / 180 + heightM / 2,
      standardParallelDeg: 15, planetocentric: true } });
}

test("regional CTX rover-sector view is landscape while HiRISE keeps its local footprint", () => {
  const regional = createRegionalViewport();
  const hirise = makeHiRiseGrid();
  assert.ok(regional.widthM > regional.heightM);
  assert.equal(regional.widthM, 120_000);
  assert.equal(regional.heightM, 105_000);
  assert.ok(hirise.heightM > hirise.widthM);
  const fitted = fitMapCssSize(regional, 1300, 1440, 900);
  assert.ok(Math.abs(fitted.width / fitted.height - regional.widthM / regional.heightM) < 1e-12);
  assert.equal(regional.geo.centerLonDeg, JEZERO_REGIONAL_EXTENT.longitude);
  assert.equal(regional.geo.centerLatDeg, JEZERO_REGIONAL_EXTENT.latitude);
  assert.ok(JEZERO_CTX_RELIEF_BOUNDS.east > JEZERO_CTX_RELIEF_BOUNDS.west);
  assert.ok(JEZERO_CTX_RELIEF_BOUNDS.north > JEZERO_CTX_RELIEF_BOUNDS.south);
});

test("regional/source geographic transforms round-trip without changing source coordinates", () => {
  const regional = createRegionalViewport(), hirise = makeHiRiseGrid();
  const sourcePoint = { x: 3_750, y: 8_125 };
  const geographic = localToLatLon(hirise, sourcePoint.x, sourcePoint.y);
  const overviewPoint = sourceLocalToViewport(hirise, sourcePoint.x, sourcePoint.y, regional);
  const restored = viewportLocalToSource(regional, overviewPoint.x, overviewPoint.y, hirise);
  assert.ok(Math.abs(restored.x - sourcePoint.x) < 1e-6);
  assert.ok(Math.abs(restored.y - sourcePoint.y) < 1e-6);
  const center = viewportPixelToSource(600, 450, 1200, 900, regional, hirise);
  const centerLatLon = localToLatLon(hirise, center.x, center.y);
  assert.ok(Math.abs(centerLatLon.lat - JEZERO_REGIONAL_EXTENT.latitude) < 1e-8);
  assert.ok(Math.abs(centerLatLon.lon - JEZERO_REGIONAL_EXTENT.longitude) < 1e-8);
  assert.ok(Number.isFinite(geographic.lat));
});
