import test from "node:test";
import assert from "node:assert/strict";
import { parseWmtsCapabilities, wmtsTileAt, wmtsTileUrl } from "../public/js/wmts.js";
import { MARS_MEAN_RADIUS_M, marsLatLonToUnit } from "../public/js/mars-globe.js";

// Reduced from the live NASA Mars Trek CTX Capabilities document verified in browser.
const capabilitiesXml = `<Capabilities xmlns="http://www.opengis.net/wmts/1.0" xmlns:ows="http://www.opengis.net/ows/1.1">
  <Contents><Layer><ows:Title>CTX Global BETA Uncontrolled 5m Caltech</ows:Title><ows:Identifier>CTX_beta01_uncontrolled_5m_Caltech</ows:Identifier>
  <ows:BoundingBox crs="urn:ogc:def:crs:EPSG::104905"><ows:LowerCorner>-180 -90</ows:LowerCorner><ows:UpperCorner>180 90</ows:UpperCorner></ows:BoundingBox>
  <Style isDefault="true"><ows:Identifier>default</ows:Identifier></Style><Format>image/png</Format>
  <TileMatrixSetLink><TileMatrixSet>default028mm</TileMatrixSet></TileMatrixSetLink>
  <ResourceURL format="image/png" resourceType="tile" template="https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX/MapServer/tile/{TileMatrix}/{TileRow}/{TileCol}" />
  </Layer><TileMatrixSet><ows:Identifier>default028mm</ows:Identifier><ows:SupportedCRS>urn:ogc:def:crs:EPSG::104905</ows:SupportedCRS>
  <TileMatrix><ows:Identifier>0</ows:Identifier><TopLeftCorner>-180 90</TopLeftCorner><TileWidth>512</TileWidth><TileHeight>512</TileHeight><MatrixWidth>2.0</MatrixWidth><MatrixHeight>1.0</MatrixHeight></TileMatrix>
  <TileMatrix><ows:Identifier>1</ows:Identifier><TopLeftCorner>-180 90</TopLeftCorner><TileWidth>512</TileWidth><TileHeight>512</TileHeight><MatrixWidth>4.0</MatrixWidth><MatrixHeight>2.0</MatrixHeight></TileMatrix>
  </TileMatrixSet></Contents></Capabilities>`;

test("parses NASA Mars WMTS layer, CRS, default style, matrix dimensions, and tile resource", () => {
  const caps = parseWmtsCapabilities(capabilitiesXml, "CTX_beta01_uncontrolled_5m_Caltech");
  assert.equal(caps.crs, "urn:ogc:def:crs:EPSG::104905");
  assert.deepEqual(caps.bounds, [-180, -90, 180, 90]);
  assert.equal(caps.style, "default");
  assert.equal(caps.matrixSetId, "default028mm");
  assert.deepEqual(caps.tileMatrices.map(m => [m.identifier, m.tileWidth, m.tileHeight, m.matrixWidth, m.matrixHeight]), [["0", 512, 512, 2, 1], ["1", 512, 512, 4, 2]]);
});

test("WMTS tile addressing follows the published Mars equirectangular matrix extents", () => {
  const caps = parseWmtsCapabilities(capabilitiesXml, "CTX_beta01_uncontrolled_5m_Caltech");
  assert.deepEqual(wmtsTileAt(caps, 0, -90, 0), { row: 0, col: 0, west: -180, east: 0, north: 90, south: -90, matrix: "0", matrixIndex: 0 });
  assert.deepEqual(wmtsTileAt(caps, 0, 90, 0), { row: 0, col: 1, west: 0, east: 180, north: 90, south: -90, matrix: "0", matrixIndex: 0 });
  const tile = wmtsTileAt(caps, 1, 90, 0);
  assert.equal(tile.row, 1); assert.equal(tile.col, 3);
  assert.equal(wmtsTileUrl(caps, tile), "https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX/MapServer/tile/1/1/3");
  assert.equal(wmtsTileAt(caps, 0, 450, 0).col, 1, "east longitude wraps at 360 degrees");
});

test("rejects absent layer and non-Mars matrix sets instead of guessing tile math", () => {
  assert.throws(() => parseWmtsCapabilities(capabilitiesXml, "not-a-layer"), /not found/);
  assert.throws(() => parseWmtsCapabilities(capabilitiesXml.replace("EPSG::104905", "EPSG::3857"), "CTX_beta01_uncontrolled_5m_Caltech"), /coverage bounding box/);
});

test("Mars globe maps planetocentric longitude and latitude to the IAU mean-radius sphere", () => {
  assert.equal(MARS_MEAN_RADIUS_M, 3396190);
  assert.deepEqual(marsLatLonToUnit(0, 0), [0, 0, 1]);
  const east = marsLatLonToUnit(90, 0);
  assert.ok(Math.abs(east[0] - 1) < 1e-12 && Math.abs(east[2]) < 1e-12);
});
