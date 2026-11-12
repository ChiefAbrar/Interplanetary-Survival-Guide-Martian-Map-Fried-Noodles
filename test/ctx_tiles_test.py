import json
import pathlib
import struct
import sys
import tempfile
import unittest

import numpy as np
import rasterio
from affine import Affine
from rasterio.crs import CRS

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import ctx_to_tiles


NODATA = -3.4028234663852886e38
PROJECTION = {
    "name": "Equirectangular",
    "latitude_of_projection_origin_deg": 0.0,
    "standard_parallel_deg": 18.4663,
    "longitude_of_central_meridian_deg": 0.0,
    "planetary_radius_m": 3396190.0,
    "latitude_type": "Planetocentric",
    "longitude_direction": "Positive East",
    "horizontal_coordinate_units": "m",
}


def manifest_and_pds(width, height, transform):
    transform_tuple = (transform.c, transform.a, transform.b, transform.f, transform.d, transform.e)
    bounds = {
        "west": transform.c / (3396190 * np.cos(np.radians(18.4663))) * 180 / np.pi,
        "east": (transform.c + width * transform.a) / (3396190 * np.cos(np.radians(18.4663))) * 180 / np.pi,
        "north": transform.f / 3396190 * 180 / np.pi,
        "south": (transform.f + height * transform.e) / 3396190 * 180 / np.pi,
        "latitude_type": "Planetocentric",
        "longitude_direction": "Positive East",
    }
    label = {
        "dataset_id": "urn:test:ctx-synthetic",
        "width": width,
        "height": height,
        "bands": 1,
        "data_type": "IEEE754LSBSingle",
        "nodata": NODATA,
        "resolution_x": 20.0,
        "resolution_y": 20.0,
        "pixel_registration": "upper-left outer corner",
        "transform": transform_tuple,
        "projection": {
            "name": "Equirectangular",
            "standard_parallel": 18.4663,
            "latitude_of_projection_origin": 0.0,
            "longitude_of_central_meridian": 0.0,
            "radius": 3396190.0,
            "latitude_type": "Planetocentric",
            "longitude_direction": "Positive East",
        },
        "coverage": {key: bounds[key] for key in ("west", "east", "south", "north")},
    }
    manifest = {
        "dataset_id": label["dataset_id"],
        "source_metadata_url": "https://example.test/ctx.xml",
        "source_raster": {"width_samples": width, "height_lines": height, "bands": 1,
                           "data_type": "IEEE754LSBSingle", "nodata": {"value": NODATA}},
        "spatial": {"resolution_x_m_per_pixel": 20.0, "resolution_y_m_per_pixel": 20.0,
                    "pixel_registration": "upper-left outer corner, synthetic fixture",
                    "geotransform_gdal_order": list(transform_tuple), "coverage_deg": bounds,
                    "projection": PROJECTION},
        "vertical": {"datum": "unknown synthetic fixture", "reference": "synthetic values"},
    }
    return manifest, label


class CtxTileExtractorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.source = self.root / "synthetic.tif"
        self.transform = Affine(20, 0, 1000, 0, -20, 2000)
        self.values = np.arange(42, dtype=np.float32).reshape(6, 7) + np.float32(123.25)
        self.values[2, 2] = np.float32(NODATA)
        self.crs = CRS.from_proj4(
            "+proj=eqc +lat_ts=18.4663 +lat_0=0 +lon_0=0 +R=3396190 +units=m +no_defs"
        )
        with rasterio.open(self.source, "w", driver="GTiff", width=7, height=6, count=1,
                           dtype="float32", crs=self.crs, transform=self.transform,
                           nodata=NODATA) as dst:
            dst.write(self.values, 1)
        self.manifest, self.pds = manifest_and_pds(7, 6, self.transform)
        self.output = self.root / "tiles"

    def generate(self, **kwargs):
        return ctx_to_tiles.extract_tiles(self.source, self.output, self.manifest, self.pds,
                                          max_cells=25, halo=1, **kwargs)

    def test_windowed_native_float_little_endian_nodata_transform_and_core_metadata(self):
        catalog = self.generate()
        self.assertEqual(len(catalog["tiles"]), 6)
        tile = json.loads((self.output / "ctx_r000_c000.json").read_text())
        raw = (self.output / tile["data"]["filename"]).read_bytes()
        self.assertEqual(len(raw), tile["data"]["expected_bytes"])
        self.assertEqual(raw[:4], struct.pack("<f", float(self.values[0, 0])))
        data = np.fromfile(self.output / tile["data"]["filename"], dtype="<f4").reshape(tile["height"], tile["width"])
        self.assertEqual(data[0, 0], self.values[0, 0])
        self.assertTrue(np.isnan(data[2, 2]), "declared source no-data sentinel becomes NaN")
        self.assertEqual(tile["georeference"]["transform_gdal_order"], [1000, 20, 0, 2000, 0, -20])
        self.assertEqual(catalog["version"], ctx_to_tiles.CATALOG_VERSION)
        self.assertEqual(catalog["source_crs"]["projection"]["planetary_radius_m"], 3396190.0)
        self.assertEqual(tile["catalog_source_crs"], catalog["source_crs"])
        self.assertEqual(tile["core_window"], {"row_off": 0, "col_off": 0, "height": 3, "width": 3,
                                               "indexing": "zero-based half-open offsets [offset, offset + size)"})
        self.assertEqual(tile["core_window_in_tile"], {"row_off": 0, "col_off": 0, "height": 3, "width": 3})

    def test_core_windows_cover_each_source_cell_once_and_fit_cell_budget(self):
        catalog = self.generate()
        counts = np.zeros((6, 7), dtype=np.uint8)
        for tile in catalog["tiles"]:
            core = tile["core_window"]
            counts[core["row_off"]:core["row_off"] + core["height"],
                  core["col_off"]:core["col_off"] + core["width"]] += 1
            self.assertLessEqual(tile["width"] * tile["height"], 25)
        self.assertTrue(np.all(counts == 1))
        self.assertTrue(catalog["coverage_verification"]["complete_source_coverage"])
        self.assertEqual(catalog["coverage_verification"]["core_pixels_unique"], 42)

    def test_neighbor_halos_share_identical_valid_source_samples_and_edge_windows_clip(self):
        catalog = self.generate()
        first = json.loads((self.output / "ctx_r000_c000.json").read_text())
        right = json.loads((self.output / "ctx_r000_c001.json").read_text())
        first_values = np.fromfile(self.output / first["data"]["filename"], dtype="<f4").reshape(first["height"], first["width"])
        right_values = np.fromfile(self.output / right["data"]["filename"], dtype="<f4").reshape(right["height"], right["width"])
        first_window, right_window = first["source_window"], right["source_window"]
        shared_cols = range(max(first_window["col_off"], right_window["col_off"]),
                            min(first_window["col_off"] + first_window["width"], right_window["col_off"] + right_window["width"]))
        shared_rows = range(max(first_window["row_off"], right_window["row_off"]),
                            min(first_window["row_off"] + first_window["height"], right_window["row_off"] + right_window["height"]))
        checked_valid = False
        for row in shared_rows:
            for col in shared_cols:
                a = first_values[row - first_window["row_off"], col - first_window["col_off"]]
                b = right_values[row - right_window["row_off"], col - right_window["col_off"]]
                if np.isfinite(self.values[row, col]) and self.values[row, col] != np.float32(NODATA):
                    self.assertEqual(a, b)
                    self.assertEqual(a, self.values[row, col])
                    checked_valid = True
        self.assertTrue(checked_valid)
        edge = json.loads((self.output / "ctx_r001_c002.json").read_text())
        self.assertEqual(edge["source_window"], {"row_off": 2, "col_off": 5, "height": 4, "width": 2,
                                                  "indexing": "zero-based half-open offsets [offset, offset + size)"})
        self.assertLessEqual(edge["width"] * edge["height"], 25)

    def test_existing_outputs_are_not_overwritten_without_explicit_permission(self):
        self.generate()
        target = self.output / "ctx_r000_c000.f32"
        before = target.read_bytes()
        with self.assertRaisesRegex(FileExistsError, "--overwrite"):
            self.generate()
        self.assertEqual(target.read_bytes(), before)
        self.generate(overwrite=True)

    def test_source_metadata_mismatch_fails_clearly(self):
        with rasterio.open(self.source) as src:
            wrong_manifest, wrong_label = manifest_and_pds(8, 6, self.transform)
            with self.assertRaisesRegex(ctx_to_tiles.CtxMetadataError, "dimensions"):
                ctx_to_tiles.inspect_and_validate_source(src, wrong_manifest, wrong_label)

    def test_official_manifest_matches_the_checked_in_pds4_fixture(self):
        manifest = json.loads((ROOT / "data/sources/ctx-jezero-dem.json").read_text(encoding="utf-8"))
        pds = ctx_to_tiles.read_pds4_reference(ROOT / "test/fixtures/ctx_jezero_dem.xml")
        ctx_to_tiles.verify_manifest_against_label(manifest, pds)
        self.assertEqual(pds["width"], 4456)
        self.assertEqual(pds["height"], 5067)
        self.assertEqual(pds["nodata"], NODATA)

    def test_vertical_neighbor_halos_share_valid_source_samples(self):
        catalog = self.generate()
        upper = json.loads((self.output / "ctx_r000_c000.json").read_text())
        lower = json.loads((self.output / "ctx_r001_c000.json").read_text())
        upper_values = np.fromfile(self.output / upper["data"]["filename"], dtype="<f4").reshape(upper["height"], upper["width"])
        lower_values = np.fromfile(self.output / lower["data"]["filename"], dtype="<f4").reshape(lower["height"], lower["width"])
        uw, lw = upper["source_window"], lower["source_window"]
        shared_rows = range(max(uw["row_off"], lw["row_off"]), min(uw["row_off"] + uw["height"], lw["row_off"] + lw["height"]))
        shared_cols = range(max(uw["col_off"], lw["col_off"]), min(uw["col_off"] + uw["width"], lw["col_off"] + lw["width"]))
        for row in shared_rows:
            for col in shared_cols:
                expected = self.values[row, col]
                if np.isfinite(expected) and expected != np.float32(NODATA):
                    a = upper_values[row - uw["row_off"], col - uw["col_off"]]
                    b = lower_values[row - lw["row_off"], col - lw["col_off"]]
                    self.assertEqual(a, b)
                    self.assertEqual(a, expected)
                    return
        self.fail("No valid sample was present in the shared vertical halo region.")

    def test_default_ctx_grid_is_99_tiles_with_498_core_and_500_output_side(self):
        windows, nrows, ncols, core = ctx_to_tiles.build_windows(4456, 5067, 250_000, 1)
        self.assertEqual((nrows, ncols, len(windows)), (11, 9, 99))
        self.assertEqual(core, 498)
        self.assertEqual(max(max(w.width, w.height) for w in windows), 500)
        partition = ctx_to_tiles.verify_core_partition(windows, 4456, 5067, nrows, ncols)
        self.assertEqual(partition["core_pixels_unique"], 4456 * 5067)
        self.assertTrue(partition["complete_source_coverage"])
        with self.assertRaisesRegex(ValueError, "active terrain limit"):
            ctx_to_tiles.build_windows(10, 10, 250_001, 1)

    def test_metadata_only_refresh_preserves_binary_bytes_and_upgrades_catalog_contract(self):
        catalog = self.generate()
        binaries_before = {record["data_file"]: (self.output / record["data_file"]).read_bytes() for record in catalog["tiles"]}
        legacy_catalog = dict(catalog, version=1)
        legacy_catalog.pop("source_crs")
        (self.output / "catalog.json").write_text(json.dumps(legacy_catalog), encoding="utf-8")
        for record in catalog["tiles"]:
            sidecar_path = self.output / record["metadata_file"]
            sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
            sidecar.pop("catalog_version")
            sidecar.pop("catalog_source_crs")
            sidecar_path.write_text(json.dumps(sidecar), encoding="utf-8")
        source_hash = ctx_to_tiles.sha256_file(self.source)
        updated = ctx_to_tiles.refresh_metadata_only(self.source, self.output, self.manifest, self.pds, source_hash)
        self.assertEqual(updated["version"], 2)
        self.assertEqual(len(updated["tiles"]), len(catalog["tiles"]))
        self.assertEqual({record["tile_id"] for record in updated["tiles"]}, {record["tile_id"] for record in catalog["tiles"]})
        for name, original in binaries_before.items():
            self.assertEqual((self.output / name).read_bytes(), original)
        refreshed = json.loads((self.output / "ctx_r000_c000.json").read_text(encoding="utf-8"))
        self.assertEqual(refreshed["catalog_version"], 2)

    def test_metadata_only_refresh_rejects_wrong_source_hash_and_corrupt_tile_checksum(self):
        catalog = self.generate()
        source_hash = ctx_to_tiles.sha256_file(self.source)
        with self.assertRaisesRegex(ctx_to_tiles.CtxMetadataError, "source GeoTIFF SHA-256"):
            ctx_to_tiles.refresh_metadata_only(self.source, self.output, self.manifest, self.pds, "0" * 64)
        binary = self.output / catalog["tiles"][0]["data_file"]
        binary.write_bytes(binary.read_bytes()[:-4])
        with self.assertRaisesRegex(ctx_to_tiles.CtxMetadataError, "binary size/identity"):
            ctx_to_tiles.refresh_metadata_only(self.source, self.output, self.manifest, self.pds, source_hash)


if __name__ == "__main__":
    unittest.main()
