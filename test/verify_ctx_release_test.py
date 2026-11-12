import hashlib
import importlib.util
import json
import pathlib
import sys
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("verify_ctx_release", ROOT / "tools/verify_ctx_release.py")
verify_ctx_release = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = verify_ctx_release
SPEC.loader.exec_module(verify_ctx_release)


class Response:
    def __init__(self, body=b"", headers=None, status=200):
        self.body = body
        self.headers = headers or {}
        self.status = status
        self.offset = 0

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, size=-1):
        if size < 0:
            return self.body[self.offset:]
        value = self.body[self.offset:self.offset + size]
        self.offset += len(value)
        return value


class VerifyCtxReleaseTests(unittest.TestCase):
    def setUp(self):
        self.base = "https://terrain.example.test/releases/r1/"
        self.origin = "https://mars.example.test"
        self.binary = b"little-endian-f32-test"
        self.hash = hashlib.sha256(self.binary).hexdigest()
        self.catalog = {
            "format": "mars-survival-ctx-tile-catalog", "version": 2,
            "dataset_id": verify_ctx_release.EXPECTED_DATASET,
            "tiling": {"is_partial_selection": False},
            "coverage_verification": {"complete_source_coverage": True,
                                      "core_pixels_expected": 99, "core_pixels_unique": 99},
            "tiles": [],
        }
        self.sidecars = {}
        for row in range(11):
            for col in range(9):
                tile_id = f"ctx_r{row:03d}_c{col:03d}"
                self.catalog["tiles"].append({"tile_id": tile_id, "metadata_file": f"{tile_id}.json",
                                               "data_file": f"{tile_id}.f32", "width": 2, "height": 2})
                self.sidecars[tile_id] = {
                    "catalog_version": 2, "tile_id": tile_id,
                    "dataset_id": verify_ctx_release.EXPECTED_DATASET, "width": 2, "height": 2,
                    "data": {"filename": f"{tile_id}.f32", "expected_bytes": len(self.binary), "sha256": self.hash},
                }
        self.json_headers = {"Content-Type": "application/json", "Access-Control-Allow-Origin": self.origin,
                             "Access-Control-Allow-Methods": "GET, HEAD"}
        self.binary_headers = {"Content-Type": "application/octet-stream", "Access-Control-Allow-Origin": self.origin,
                               "Access-Control-Allow-Methods": "GET, HEAD"}

    def _mock_request(self, url, timeout, *, origin=None, method="GET", extra_headers=None):
        if method == "OPTIONS":
            return Response(headers={"Access-Control-Allow-Origin": self.origin,
                                     "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS"}, status=204)
        if url.endswith("catalog.json"):
            body, headers = json.dumps(self.catalog).encode(), self.json_headers
        elif url.endswith(".json"):
            tile_id = pathlib.PurePosixPath(url).stem
            body, headers = json.dumps(self.sidecars[tile_id]).encode(), self.json_headers
        else:
            body, headers = self.binary, self.binary_headers
        return Response(body, headers)

    def test_representative_release_verifies_catalog_sidecars_and_preflight(self):
        with patch.object(verify_ctx_release, "_request", side_effect=self._mock_request) as request, \
             patch.object(verify_ctx_release, "_verify_preflight", return_value=None):
            self.assertEqual(verify_ctx_release.verify(self.base, self.origin), [])
        binary_requests = [call for call in request.call_args_list if call.args[0].endswith(".f32")]
        self.assertEqual(len(binary_requests), 5)
        self.assertTrue(all(call.kwargs["extra_headers"] == {"Range": "bytes=0-0"} for call in binary_requests))

    def test_full_release_checks_every_binary_hash_and_size(self):
        with patch.object(verify_ctx_release, "_request", side_effect=self._mock_request), \
             patch.object(verify_ctx_release, "_verify_preflight", return_value=None):
            failures = verify_ctx_release.verify(self.base, self.origin, full=True)
        self.assertEqual(failures, [])

    def test_rejects_traversal_and_unexpected_url_paths(self):
        for path in ("../outside.json", "/outside.json", "https://evil.test/x.json", "ctx\\tile.json"):
            with self.subTest(path=path), self.assertRaises(verify_ctx_release.VerificationError):
                verify_ctx_release._safe_asset_url(self.base, path)

    def test_rejects_incomplete_or_wrong_catalog(self):
        self.catalog["tiling"]["is_partial_selection"] = True
        with self.assertRaisesRegex(verify_ctx_release.VerificationError, "complete"):
            verify_ctx_release._validate_catalog(self.catalog, self.base)

    def test_binary_checksum_mismatch_is_reported(self):
        self.sidecars["ctx_r000_c000"]["data"]["sha256"] = "0" * 64
        tile = verify_ctx_release._selected_tiles(verify_ctx_release._validate_catalog(self.catalog, self.base), False)[0]
        with patch.object(verify_ctx_release, "_request", side_effect=self._mock_request):
            with self.assertRaisesRegex(verify_ctx_release.VerificationError, "SHA-256"):
                verify_ctx_release._verify_binary(tile, 1, self.origin, full=True)

    def test_catalog_requires_json_content_type_and_matching_cors(self):
        with patch.object(verify_ctx_release, "_request", return_value=Response(
            json.dumps(self.catalog).encode(), {"Content-Type": "text/plain", "Access-Control-Allow-Origin": self.origin}
        )):
            with self.assertRaisesRegex(verify_ctx_release.VerificationError, "content type"):
                verify_ctx_release._fetch_json(self.base + "catalog.json", 1, self.origin, "catalog.json")
        with patch.object(verify_ctx_release, "_request", return_value=Response(
            json.dumps(self.catalog).encode(), {"Content-Type": "application/json", "Access-Control-Allow-Origin": "https://wrong.example"}
        )):
            with self.assertRaisesRegex(verify_ctx_release.VerificationError, "Access-Control-Allow-Origin"):
                verify_ctx_release._fetch_json(self.base + "catalog.json", 1, self.origin, "catalog.json")


if __name__ == "__main__":
    unittest.main()
