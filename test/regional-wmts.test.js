import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseWmtsCapabilities, wmtsContains, wmtsTileAt, wmtsTileUrl } from "../public/js/wmts.js";

const caps = (name, layer) => parseWmtsCapabilities(
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"), layer);

test("official Jezero CTX Capabilities provide coverage and un-commented 256-pixel Mars matrices", () => {
  const c = caps("mars-trek-jezero-ctx-capabilities.xml", "JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0");
  assert.deepEqual(c.bounds, [77.1604655, 18.2110274, 77.6991776, 18.7211945]);
  assert.equal(c.format, "image/png"); assert.equal(c.style, "default");
  assert.equal(c.crs, "urn:ogc:def:crs:EPSG::104905");
  assert.equal(c.matrixSetId, "default028mm"); assert.equal(c.tileMatrices.length, 14);
  assert.equal(c.tileMatrices.at(-1).identifier, "13");
  assert.ok(c.tileMatrices.every(m => m.tileWidth === 256 && m.tileHeight === 256));
  assert.equal(wmtsContains(c, 77.4, 18.4), true);
  assert.equal(wmtsContains(c, 0, 0), false);
  const tile = wmtsTileAt(c, 13, 77.4, 18.4);
  assert.deepEqual([tile.row, tile.col], [3258, 11714]);
  assert.deepEqual([tile.west, tile.east, tile.north, tile.south], [77.3876953125, 77.40966796875, 18.4130859375, 18.39111328125]);
  assert.equal(wmtsTileUrl(c, tile), "https://trek.nasa.gov/tiles/Mars/EQ/JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0/1.0.0//default/default028mm/13/3258/11714.png");
});

test("official Jezero HiRISE Capabilities use their separate footprint and level-17 matrix", () => {
  const c = caps("mars-trek-jezero-hirise-capabilities.xml", "JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first_dd");
  assert.deepEqual(c.bounds, [77.2229331, 18.3067994, 77.583964, 18.669315]);
  assert.equal(c.crs, "urn:ogc:def:crs:EPSG::104905");
  assert.equal(c.matrixSetId, "default028mm"); assert.equal(c.tileMatrices.length, 18);
  assert.equal(c.tileMatrices.at(-1).identifier, "17");
  const tile = wmtsTileAt(c, 17, 77.4, 18.4);
  assert.deepEqual([tile.row, tile.col], [52137, 187432]);
  assert.equal(wmtsContains(c, 77.4, 18.4), true);
  assert.equal(wmtsContains(c, 77.65, 18.4), false);
  assert.match(wmtsTileUrl(c, tile), /\/17\/52137\/187432\.png$/);
});
