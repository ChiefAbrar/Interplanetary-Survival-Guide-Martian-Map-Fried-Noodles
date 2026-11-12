import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JEZERO_CTX_RELIEF_BOUNDS } from "../public/js/map-viewport.js";

const metadata = JSON.parse(readFileSync(new URL("../public/data/jezero-ctx-relief.json", import.meta.url), "utf8"));
const image = readFileSync(new URL("../public/data/jezero-ctx-relief.png", import.meta.url));

test("regional CTX relief is a georeferenced display product, not elevation input", () => {
  assert.equal(metadata.format, "mars-survival-ctx-display-relief");
  assert.deepEqual(metadata.dimensions_pixels, [1024, 1162]);
  assert.deepEqual(metadata.source_raster_dimensions_pixels, [4456, 5067]);
  assert.equal(metadata.source_raster_sha256, "ba7f706ea1b5d63a562f28a7dcf7a7f3c79bce7f048e6974b57e8a33c30d1ba2");
  assert.equal(metadata.source_crs.name, "Equirectangular");
  assert.equal(metadata.source_crs.standard_parallel_deg, 18.4663);
  assert.equal(metadata.source_crs.latitude_type, "Planetocentric");
  assert.equal(metadata.source_crs.longitude_direction, "Positive East");
  assert.deepEqual(metadata.coverage_planetocentric_east_positive_deg, JEZERO_CTX_RELIEF_BOUNDS);
  assert.match(metadata.data_role, /never elevation samples or route-analysis inputs/);
  assert.match(metadata.visual_reference, /no map georeferencing/);
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual([...image.subarray(16, 24)], [0, 0, 4, 0, 0, 0, 4, 138]);
});
