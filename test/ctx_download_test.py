import hashlib
import http.server
import json
import pathlib
import sys
import tempfile
import threading
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import download_ctx


class RangeHandler(http.server.BaseHTTPRequestHandler):
    payload = b"0123456789abcdef"
    etag = '"fixture-etag"'
    mode = "valid"
    requests = []
    fail_once = set()
    fail_range = None
    head_requests = 0
    head_failures = 0
    fail_start = None
    active = 0
    maximum_active = 0
    completed_ranges = []
    state_lock = threading.Lock()

    def log_message(self, *_args):
        pass

    def do_HEAD(self):
        RangeHandler.head_requests += 1
        if RangeHandler.head_failures > 0:
            RangeHandler.head_failures -= 1
            self.send_response(503)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(self.payload)))
        self.send_header("ETag", self.etag)
        self.send_header("Last-Modified", "Wed, 11 Nov 2026 00:00:00 GMT")
        self.send_header("Content-Type", "image/tiff")
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()

    def do_GET(self):
        with RangeHandler.state_lock:
            RangeHandler.active += 1
            RangeHandler.maximum_active = max(RangeHandler.maximum_active, RangeHandler.active)
        try:
            self._handle_range()
        finally:
            with RangeHandler.state_lock:
                RangeHandler.active -= 1

    def _handle_range(self):
        header = self.headers.get("Range", "")
        RangeHandler.requests.append(header)
        try:
            start, end = map(int, header.removeprefix("bytes=").split("-"))
        except ValueError:
            self.send_error(400)
            return
        if (RangeHandler.mode == "transient" and header not in RangeHandler.fail_once) or (
            RangeHandler.mode in {"fail-selected", "concurrent-fail"} and header == RangeHandler.fail_range
        ):
            RangeHandler.fail_once.add(header)
            self.send_response(503)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        interrupted = RangeHandler.mode == "interrupted" and header not in RangeHandler.fail_once
        if interrupted:
            RangeHandler.fail_once.add(header)
        if RangeHandler.mode == "etag-change" and len(RangeHandler.requests) > 1:
            etag = '"changed-etag"'
        elif RangeHandler.mode == "concurrent-etag-change" and start >= (RangeHandler.fail_start or 0):
            etag = '"changed-etag"'
        else:
            etag = RangeHandler.etag
        body = self.payload[start:end + 1]
        if RangeHandler.mode == "out-of-order":
            time.sleep(max(0.0, (len(self.payload) - start) / 4 * 0.03))
        content_range = f"bytes {start}-{end}/{len(self.payload)}"
        if RangeHandler.mode == "bad-range":
            content_range = f"bytes {start + 1}-{end}/{len(self.payload)}"
        if RangeHandler.mode in {"short-body", "interrupted"} and (RangeHandler.mode != "interrupted" or interrupted):
            body = body[:-1]
        self.send_response(206)
        self.send_header("Content-Length", str(end - start + 1) if interrupted else str(len(body)))
        self.send_header("Content-Range", content_range)
        self.send_header("ETag", etag)
        self.send_header("Last-Modified", "Wed, 11 Nov 2026 00:00:00 GMT")
        self.end_headers()
        try:
            self.wfile.write(body)
            if interrupted:
                self.close_connection = True
            RangeHandler.completed_ranges.append(header)
        except (BrokenPipeError, ConnectionResetError):
            pass


class CtxDownloadTest(unittest.TestCase):
    def setUp(self):
        RangeHandler.payload = b"0123456789abcdef"
        RangeHandler.etag = '"fixture-etag"'
        RangeHandler.mode = "valid"
        RangeHandler.requests = []
        RangeHandler.fail_once = set()
        RangeHandler.fail_range = None
        RangeHandler.head_requests = 0
        RangeHandler.head_failures = 0
        RangeHandler.fail_start = None
        RangeHandler.active = 0
        RangeHandler.maximum_active = 0
        RangeHandler.completed_ranges = []
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), RangeHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)
        self.url = f"http://127.0.0.1:{self.server.server_port}/fixture.tif"
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.output = self.root / "fixture.tif"
        self.work = self.root / ".fixture.tif.download-work"
        self.provenance = self.root / "provenance.json"

    def close_server(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()

    @staticmethod
    def fake_validator(path):
        return {"synthetic": True, "length": pathlib.Path(path).stat().st_size}

    def run_download(self, **kwargs):
        defaults = {"url": self.url, "output": self.output, "chunk_size": 4,
                    "timeout": 3, "retries": 1, "work_dir": self.work,
                    "provenance_path": self.provenance, "validator": self.fake_validator,
                    "sleep": lambda _seconds: None}
        defaults.update(kwargs)
        return download_ctx.download_file(**defaults)

    def test_valid_ranges_assemble_and_record_local_hash(self):
        result = self.run_download()
        self.assertEqual(self.output.read_bytes(), RangeHandler.payload)
        self.assertEqual(result["sha256"], hashlib.sha256(RangeHandler.payload).hexdigest())
        self.assertEqual(self.provenance.is_file(), True)
        self.assertFalse(self.work.exists())

    def test_concurrent_ranges_finish_out_of_order_and_assemble_exact_sha256(self):
        RangeHandler.payload = bytes(range(40))
        RangeHandler.mode = "out-of-order"
        result = self.run_download(chunk_size=4, workers=4)
        self.assertEqual(RangeHandler.maximum_active, 4)
        self.assertNotEqual(RangeHandler.completed_ranges, RangeHandler.requests)
        self.assertEqual(self.output.read_bytes(), RangeHandler.payload)
        self.assertEqual(result["sha256"], hashlib.sha256(RangeHandler.payload).hexdigest())

    def test_concurrent_manifest_updates_are_serialized_and_successful_chunks_survive_worker_failure(self):
        RangeHandler.payload = bytes(range(40))
        RangeHandler.mode = "concurrent-fail"
        RangeHandler.fail_range = "bytes=4-7"
        with self.assertRaisesRegex(download_ctx.DownloadError, "failed after 1 attempts"):
            self.run_download(chunk_size=4, workers=4, retries=0)
        state = json.loads((self.work / "download.json").read_text())
        completed = list(state["completed_chunks"].values())
        self.assertEqual(len(completed), 9)
        self.assertTrue(all(record["completion_status"] == "complete" for record in completed))
        self.assertTrue(all(record["actual_size"] == record["expected_size"] == 4 for record in completed))
        self.assertFalse(self.output.exists())

    def test_concurrent_etag_change_invalidates_session_without_assembling(self):
        RangeHandler.payload = bytes(range(40))
        RangeHandler.mode = "concurrent-etag-change"
        RangeHandler.fail_start = 8
        with self.assertRaisesRegex(download_ctx.ObjectChangedError, "Remote object changed"):
            self.run_download(chunk_size=4, workers=4, retries=0)
        state = json.loads((self.work / "download.json").read_text())
        self.assertIn("session_invalidated", state)
        self.assertFalse(self.output.exists())
        self.assertGreater(len(state["completed_chunks"]), 0)

    def test_resume_partially_completed_concurrent_session_schedules_only_missing_ranges(self):
        RangeHandler.payload = bytes(range(40))
        RangeHandler.mode = "concurrent-fail"
        RangeHandler.fail_range = "bytes=4-7"
        with self.assertRaises(download_ctx.DownloadError):
            self.run_download(chunk_size=4, workers=4, retries=0)
        RangeHandler.mode = "valid"
        RangeHandler.requests = []
        result = self.run_download(chunk_size=4, workers=4)
        self.assertNotIn("bytes=0-3", RangeHandler.requests)
        self.assertEqual(self.output.read_bytes(), RangeHandler.payload)
        self.assertEqual(result["sha256"], hashlib.sha256(RangeHandler.payload).hexdigest())

    def test_transient_head_failure_is_retried(self):
        RangeHandler.head_failures = 1
        metadata = download_ctx.remote_metadata(
            self.url, 3, retries=1, sleep=lambda _seconds: None
        )
        self.assertEqual(metadata["content_length"], len(RangeHandler.payload))
        self.assertEqual(RangeHandler.head_requests, 2)

    def test_invalid_content_range_is_rejected_and_chunks_are_retained(self):
        RangeHandler.mode = "bad-range"
        with self.assertRaisesRegex(download_ctx.DownloadError, "invalid Content-Range"):
            self.run_download(retries=0)
        self.assertTrue(self.work.exists())
        self.assertFalse(self.output.exists())

    def test_incorrect_response_size_is_rejected(self):
        RangeHandler.mode = "short-body"
        with self.assertRaisesRegex(download_ctx.DownloadError, "declared .* bytes; expected"):
            self.run_download(retries=0)
        self.assertFalse(self.output.exists())

    def test_interrupted_transfer_is_retried(self):
        RangeHandler.mode = "transient"
        result = self.run_download(retries=1)
        self.assertEqual(self.output.read_bytes(), RangeHandler.payload)
        self.assertGreater(len(RangeHandler.requests), 4)
        self.assertEqual(result["size_bytes"], len(RangeHandler.payload))

    def test_interrupted_connection_is_retried_without_marking_short_chunk_complete(self):
        RangeHandler.mode = "interrupted"
        result = self.run_download(retries=1)
        self.assertEqual(self.output.read_bytes(), RangeHandler.payload)
        self.assertGreater(len(RangeHandler.requests), 4)
        self.assertEqual(result["size_bytes"], len(RangeHandler.payload))

    def test_changed_etag_is_rejected(self):
        RangeHandler.mode = "etag-change"
        with self.assertRaisesRegex(download_ctx.DownloadError, "Remote object changed"):
            self.run_download(retries=0)
        self.assertFalse(self.output.exists())

    def test_resume_reuses_valid_chunks(self):
        RangeHandler.mode = "fail-selected"
        RangeHandler.fail_range = "bytes=4-7"
        with self.assertRaises(download_ctx.DownloadError):
            self.run_download(retries=0)
        self.assertTrue((self.work / download_ctx._chunk_name(0, 3)).is_file())
        RangeHandler.mode = "valid"
        RangeHandler.requests = []
        self.run_download()
        self.assertEqual(self.output.read_bytes(), RangeHandler.payload)
        self.assertNotIn("bytes=0-3", RangeHandler.requests)

    def test_corrupted_chunk_is_redownloaded(self):
        RangeHandler.mode = "fail-selected"
        RangeHandler.fail_range = "bytes=4-7"
        with self.assertRaises(download_ctx.DownloadError):
            self.run_download(retries=0)
        first_chunk = self.work / download_ctx._chunk_name(0, 3)
        first_chunk.write_bytes(b"bad!")
        RangeHandler.mode = "valid"
        RangeHandler.requests = []
        self.run_download()
        self.assertIn("bytes=0-3", RangeHandler.requests)
        self.assertEqual(self.output.read_bytes(), RangeHandler.payload)

    def test_changed_resume_metadata_is_rejected(self):
        RangeHandler.mode = "fail-selected"
        RangeHandler.fail_range = "bytes=4-7"
        with self.assertRaises(download_ctx.DownloadError):
            self.run_download(retries=0)
        RangeHandler.etag = '"new-object"'
        RangeHandler.mode = "valid"
        with self.assertRaisesRegex(download_ctx.DownloadError, "differ from the existing resume manifest"):
            self.run_download()

    def test_existing_output_is_protected_unless_overwrite_is_explicit(self):
        self.output.write_bytes(b"keep-existing")
        with self.assertRaisesRegex(FileExistsError, "Refusing to overwrite"):
            self.run_download()
        self.assertEqual(self.output.read_bytes(), b"keep-existing")

    def test_failed_overwrite_attempt_preserves_existing_output(self):
        self.output.write_bytes(b"valid-existing-dataset")
        RangeHandler.mode = "bad-range"
        with self.assertRaises(download_ctx.DownloadError):
            self.run_download(overwrite=True, retries=0)
        self.assertEqual(self.output.read_bytes(), b"valid-existing-dataset")


if __name__ == "__main__":
    unittest.main()
