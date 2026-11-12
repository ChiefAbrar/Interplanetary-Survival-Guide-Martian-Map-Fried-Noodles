import test from "node:test";
import assert from "node:assert/strict";
import { createTerrain } from "../public/js/terrain.js";
import { ctxDisplayRange, fitMapCssSize, mapPixelFromEvent, multidirectionalHillshade, NEUTRAL_ELEVATION_RAMP, renderCtxCorePixels, renderElevationPixels, robustDisplayRange, visibleCtxTileRecords } from "../public/js/terrain-rendering.js";
import { createRegionalViewport } from "../public/js/map-viewport.js";

test("display percentile range excludes non-finite cells and limits outlier influence", () => {
  const values = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10000, NaN]);
  const range = robustDisplayRange(values, .1, .9);
  assert.equal(range.low, 1);
  assert.equal(range.high, 9);
  assert.equal(range.validCount, 10);
  assert.deepEqual(robustDisplayRange([NaN, Infinity]), { low: 0, high: 1, validCount: 0 });
});

test("elevation pixels retain explicit no-data appearance without changing source elevations", () => {
  const source = [0, 1, 2, 1, NaN, 1, 0, 1, 2];
  const terrain = createTerrain({ width: 3, height: 3, cellX: 10, cellY: 10, z: source });
  const before = [...terrain.z];
  const result = renderElevationPixels(terrain);
  const nodata = 4 * 4;
  assert.deepEqual([...result.data.slice(nodata, nodata + 4)], [76, 78, 72, 255]);
  assert.deepEqual([...terrain.z], before);
  assert.equal(result.validCount, 8);
  assert.ok(result.data[3] > 0);
});

test("default elevation display restores the saved neutral terrain ramp", () => {
  assert.deepEqual(NEUTRAL_ELEVATION_RAMP, [[58, 56, 52], [128, 122, 112], [226, 219, 204]]);
  const terrain = createTerrain({ width: 3, height: 3, cellX: 10, cellY: 10, z: [0, 0, 0, 0, 1, 2, 2, 2, 2] });
  const rendered = renderElevationPixels(terrain);
  const pixel = [...rendered.data.slice((4 * 4), (4 * 4) + 3)];
  assert.ok(pixel[0] - pixel[2] < 25, "terrain should remain neutral gray-brown rather than orange");
});

test("regional CTX selection loads only tile cores intersecting the viewport", () => {
  const viewport = createRegionalViewport(), source = { cellX: 1_000, cellY: 1_000, geo: viewport.geo };
  const record = (row, col) => ({ tile_id: `${row}-${col}`, core_window: { row_off: row, col_off: col, width: 10, height: 10 } });
  const records = [record(0, 0), record(0, 40), record(25, 0)];
  assert.deepEqual(visibleCtxTileRecords({ tiles: records }, source, viewport).map(tile => tile.tile_id), ["0-0"]);
});

test("adjacent CTX core pixels use halo samples for matching seam illumination", () => {
  const makeTile = (tileId, sourceCol, coreCol) => {
    const elevations = new Float32Array(12);
    const columns = [0, 5, 5, 10];
    for (let row = 0; row < 4; row++) for (let col = 0; col < 3; col++)
      elevations[row * 3 + col] = columns[sourceCol + col] + row * 2;
    return { tileId, elevations, metadata: { width: 3, height: 4,
      source_window: { row_off: 0, col_off: sourceCol, width: 3, height: 4 },
      core_window: { row_off: 1, col_off: sourceCol + coreCol, width: 2, height: 2 },
      core_window_in_tile: { row_off: 1, col_off: coreCol, width: 2, height: 2 } } };
  };
  const west = makeTile("west", 0, 0), east = makeTile("east", 1, 1);
  const range = ctxDisplayRange([west, east]);
  const westPixels = renderCtxCorePixels(west, range, 20, 20);
  const eastPixels = renderCtxCorePixels(east, range, 20, 20);
  const westSeamPixel = [...westPixels.data.slice((0 * westPixels.width + 1) * 4, (0 * westPixels.width + 1) * 4 + 4)];
  const eastSeamPixel = [...eastPixels.data.slice((0 * eastPixels.width) * 4, (0 * eastPixels.width) * 4 + 4)];
  assert.deepEqual(westSeamPixel, eastSeamPixel);
});

test("multidirectional hillshade is bounded and finite on slopes with no-data neighbors", () => {
  const terrain = createTerrain({ width: 3, height: 3, cellX: 10, cellY: 10, z: [0, 2, 4, 1, 3, 5, NaN, 4, 6] });
  const shade = multidirectionalHillshade(terrain, 1, 1);
  assert.ok(Number.isFinite(shade));
  assert.ok(shade >= .58 && shade <= 1.12);
});

test("event coordinates remain aligned with a DPR-backed canvas after CSS fitting", () => {
  const terrain = { widthM: 1200, heightM: 2400 };
  const rect = { left: 100, top: 50, width: 300, height: 600 };
  const centre = mapPixelFromEvent({ clientX: 250, clientY: 350 }, rect, terrain, 600, 1200);
  assert.deepEqual(centre, { x: 600, y: 1200, canvasX: 300, canvasY: 600 });
  assert.equal(mapPixelFromEvent({ clientX: 400, clientY: 350 }, rect, terrain, 600, 1200), null);
});

test("map workspace fitting preserves the source aspect ratio within desktop and mobile bounds", () => {
  const terrain = { widthM: 1000, heightM: 2100 };
  for (const [vw, vh, parent] of [[1440, 900, 1000], [390, 844, 370]]) {
    const fitted = fitMapCssSize(terrain, parent, vw, vh);
    assert.ok(fitted.width <= parent);
    assert.ok(fitted.height <= fitted.maxHeight + 1e-8);
    assert.ok(Math.abs(fitted.height / fitted.width - 2.1) < 1e-12);
  }
});

