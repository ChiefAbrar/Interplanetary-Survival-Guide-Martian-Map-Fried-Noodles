import hashlib
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import Mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import publish_ctx_tiles as publisher


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


class PublishCtxTilesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self._make_complete_dataset()

    def tearDown(self):
        self.temp.cleanup()

    def _make_complete_dataset(self):
        tile_records = []
        coverage_pixels = 99
        for index in range(99):
            tile_id = f"ctx_r{index // 9:03d}_c{index % 9:03d}"
            binary = f"{index:04d}".encode()
            (self.root / f"{tile_id}.f32").write_bytes(binary)
            sidecar = {
                "format": "mars-survival-ctx-f32-tile", "version": 1,
                "catalog_version": 2, "tile_id": tile_id,
                "dataset_id": publisher.OFFICIAL_DATASET_ID,
                "source_raster": {"sha256": "a" * 64},
                "width": 1, "height": 1,
                "data": {"filename": f"{tile_id}.f32", "expected_bytes": len(binary), "sha256": digest(binary)},
            }
            (self.root / f"{tile_id}.json").write_text(json.dumps(sidecar), encoding="utf-8")
            tile_records.append({"tile_id": tile_id, "metadata_file": f"{tile_id}.json", "data_file": f"{tile_id}.f32",
                                 "width": 1, "height": 1})
        catalog = {
            "format": "mars-survival-ctx-tile-catalog", "version": 2,
            "dataset_id": publisher.OFFICIAL_DATASET_ID,
            "source_raster": {"sha256": "a" * 64},
            "tiling": {"is_partial_selection": False},
            "coverage_verification": {"complete_source_coverage": True,
                                       "core_pixels_expected": coverage_pixels,
                                       "core_pixels_unique": coverage_pixels},
            "tiles": tile_records,
        }
        (self.root / "catalog.json").write_text(json.dumps(catalog), encoding="utf-8")

    def test_dry_run_plans_catalog_sidecars_and_binaries_without_remote_calls(self):
        calls = []

        def no_network(*args):
            calls.append(args)
            raise AssertionError("Dry-run must not invoke the remote runner")

        report = publisher.publish(self.root, "s3://demo-bucket/jezero", "https://objects.example.test",
                                   do_publish=False, runner=no_network)
        self.assertEqual(report["mode"], "dry-run")
        self.assertEqual(report["tile_count"], 99)
        self.assertEqual(len(report["planned"]), 199)
        self.assertEqual(calls, [])
        self.assertTrue(report["remote_base_key"].startswith("jezero/releases/"))
        self.assertEqual(report["uploaded"], [])
        self.assertEqual(report["skipped"], [])
        self.assertEqual(report["failed"], [])

    def test_partial_dataset_is_rejected(self):
        catalog_path = self.root / "catalog.json"
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        catalog["tiling"]["is_partial_selection"] = True
        catalog_path.write_text(json.dumps(catalog), encoding="utf-8")
        with self.assertRaisesRegex(publisher.PublishError, "partial"):
            publisher.validate_collection(self.root)

    def test_binary_checksum_is_verified_before_publish(self):
        binary = next(self.root.glob("ctx_r*.f32"))
        binary.write_bytes(b"changed")
        with self.assertRaisesRegex(publisher.PublishError, "size mismatch|SHA-256 mismatch"):
            publisher.validate_collection(self.root)

    def test_unknown_or_unsafe_catalog_asset_names_are_rejected(self):
        catalog_path = self.root / "catalog.json"
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        catalog["tiles"][0]["data_file"] = "../outside.f32"
        catalog_path.write_text(json.dumps(catalog), encoding="utf-8")
        with self.assertRaisesRegex(publisher.PublishError, "unexpected|Unsafe"):
            publisher.validate_collection(self.root)

    def test_catalog_must_contain_exact_official_tile_count(self):
        catalog_path = self.root / "catalog.json"
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        catalog["tiles"].pop()
        catalog_path.write_text(json.dumps(catalog), encoding="utf-8")
        with self.assertRaisesRegex(publisher.PublishError, "99"):
            publisher.validate_collection(self.root)

    def test_dry_run_rejects_non_https_public_origin(self):
        with unittest.mock.patch.dict("os.environ", {"CTX_TILE_PUBLIC_BASE_URL": "http://terrain.example.test"}, clear=True):
            with self.assertRaisesRegex(publisher.PublishError, "HTTPS"):
                publisher.publish(self.root, "s3://demo-bucket/jezero", "", do_publish=False)

    def test_publish_preflight_error_does_not_upload_any_asset(self):
        calls = []

        def runner(args, endpoint):
            calls.append(args[0])
            if args[0] == "head-object" and args[args.index("--key") + 1].endswith("catalog.json"):
                return __import__("subprocess").CompletedProcess(args, 1, "", "AccessDenied")
            return __import__("subprocess").CompletedProcess(args, 255, "", "404 Not Found")

        with unittest.mock.patch.dict("os.environ", {"AWS_ACCESS_KEY_ID": "test", "AWS_SECRET_ACCESS_KEY": "test"}, clear=True):
            report = publisher.publish(self.root, "s3://demo-bucket/jezero", "https://objects.example.test",
                                       do_publish=True, runner=runner)
        self.assertTrue(report["failed"])
        self.assertNotIn("put-object", calls)

    def test_catalog_is_published_last_and_withheld_if_payload_upload_fails(self):
        uploaded = []

        def runner(args, endpoint):
            operation = args[0]
            key = args[args.index("--key") + 1]
            if operation == "head-object":
                return __import__("subprocess").CompletedProcess(args, 255, "", "404 Not Found")
            uploaded.append(key)
            if key.endswith("ctx_r000_c000.f32"):
                return __import__("subprocess").CompletedProcess(args, 1, "", "upload failed")
            return __import__("subprocess").CompletedProcess(args, 0, "{}", "")

        with unittest.mock.patch.dict("os.environ", {"AWS_ACCESS_KEY_ID": "test", "AWS_SECRET_ACCESS_KEY": "test"}, clear=True):
            report = publisher.publish(self.root, "s3://demo-bucket/jezero", "https://objects.example.test",
                                       do_publish=True, runner=runner)
        self.assertEqual(uploaded[-1].endswith("catalog.json"), False)
        self.assertTrue(any(item["path"] == "catalog.json" for item in report["failed"]))
        self.assertEqual(report["public_base_url"], "")

    def test_actual_publish_refuses_missing_credentials_before_remote_operations(self):
        runner = Mock(side_effect=AssertionError("must fail before any request"))
        with unittest.mock.patch.dict("os.environ", {}, clear=True):
            with self.assertRaisesRegex(publisher.PublishError, "credentials"):
                publisher.publish(self.root, "s3://demo-bucket/jezero", "https://objects.example.test",
                                  do_publish=True, runner=runner)
        runner.assert_not_called()

    def test_publish_preflights_all_keys_before_first_upload(self):
        calls = []

        def runner(args, endpoint):
            calls.append(args[0])
            if args[0] == "head-object":
                key = args[args.index("--key") + 1]
                if key.endswith("ctx_r000_c001.json"):
                    returntype = 1
                    return __import__("subprocess").CompletedProcess(args, returntype, "", "AccessDenied")
                return __import__("subprocess").CompletedProcess(args, 255, "", "404 Not Found")
            raise AssertionError("No upload is allowed after a preflight failure")

        with unittest.mock.patch.dict("os.environ", {"AWS_ACCESS_KEY_ID": "test", "AWS_SECRET_ACCESS_KEY": "test"}, clear=True):
            report = publisher.publish(self.root, "s3://demo-bucket/jezero", "https://objects.example.test",
                                       do_publish=True, runner=runner)
        self.assertTrue(report["failed"])
        self.assertNotIn("put-object", calls)


if __name__ == "__main__":
    unittest.main()
