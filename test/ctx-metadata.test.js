import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(`${root}/data/sources/ctx-jezero-dem.json`, "utf8"));
const label = readFileSync(`${root}/test/fixtures/ctx_jezero_dem.xml`, "utf8");
const hirise = JSON.parse(readFileSync(`${root}/public/data/jezero-hirise-tile.json`, "utf8"));
const xmlValue = (tag, within = label) => {
  const match = within.match(new RegExp(`<(?:(?:\\w+):)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:(?:\\w+):)?${tag}\\s*>`, "i"));
  return match?.[1].trim() ?? null;
};
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} differs from ${expected}`);

test("CTX manifest is grounded in the official PDS4 sidecar and keeps source facts distinct", () => {
  assert.equal(xmlValue("logical_identifier"), manifest.dataset_id);
  assert.equal(xmlValue("title"), manifest.product_title);
  assert.equal(manifest.source_metadata_url, "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/CTX/ScienceInvestigationMaps_JPL/M20_JezeroCrater_CTXDEM_20m.xml");
  assert.equal(manifest.source_raster_url.endsWith("M20_JezeroCrater_CTXDEM_20m.tif"), true);
  assert.equal(manifest.source_raster.width_samples, Number(xmlValue("elements", label.slice(label.indexOf("<axis_name>Sample")))));
  assert.equal(manifest.source_raster.height_lines, Number(xmlValue("elements", label.slice(label.indexOf("<axis_name>Line")))));
  assert.equal(manifest.source_raster.bands, Number(xmlValue("elements", label.slice(label.indexOf("<axis_name>Band")))));
  assert.equal(manifest.source_raster.data_type, xmlValue("data_type"));
  assert.equal(manifest.source_raster.nodata.value, Number(xmlValue("missing_constant")));
  assert.equal(manifest.spatial.resolution_x_m_per_pixel, Number(xmlValue("pixel_resolution_x")));
  assert.equal(manifest.spatial.resolution_y_m_per_pixel, Number(xmlValue("pixel_resolution_y")));
  assert.equal(manifest.spatial.projection.standard_parallel_deg, Number(xmlValue("standard_parallel_1")));
  assert.equal(manifest.spatial.projection.planetary_radius_m, Number(xmlValue("a_axis_radius")));
  assert.equal(manifest.spatial.projection.latitude_type, xmlValue("latitude_type"));
  assert.equal(manifest.spatial.projection.longitude_direction, xmlValue("longitude_direction"));
  assert.equal(manifest.spatial.projection.horizontal_coordinate_units, "m");
  near(manifest.spatial.geotransform_gdal_order[0], Number(xmlValue("upperleft_corner_x")));
  near(manifest.spatial.geotransform_gdal_order[3], Number(xmlValue("upperleft_corner_y")));
  assert.match(manifest.source_raster.valid_data_range_m, /unknown/i);
  assert.match(manifest.vertical.datum, /unknown/i);
  assert.match(manifest.vertical.reference, /does not identify an explicit vertical datum/i);
  assert.match(manifest.accuracy.vertical, /unknown/i);
  assert.match(manifest.citation.usage_constraint, /public domain/i);
});

test("CTX provenance and geometry are not substituted with the existing HiRISE tile", () => {
  assert.notEqual(manifest.dataset_id, hirise.source.product_id);
  assert.match(manifest.dataset_id, /mars2020_ctx_basemap_2021/);
  assert.equal(manifest.spatial.projection.planetary_radius_m, 3396190);
  assert.equal(hirise.geo.radius_m, 3394839.8133163);
  assert.notDeepEqual(manifest.spatial.coverage_deg, {
    west: hirise.geo.min_lon_deg,
    east: hirise.geo.max_lon_deg,
    south: hirise.geo.min_lat_deg,
    north: hirise.geo.max_lat_deg,
    latitude_type: "Planetocentric",
    longitude_direction: "Positive East"
  });
});
