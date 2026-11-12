#!/usr/bin/env python3
"""Resumably download and validate the official Jezero CTX DEM GeoTIFF."""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import http.client
import json
import os
import pathlib
import re
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_URL = (
    "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/CTX/"
    "ScienceInvestigationMaps_JPL/M20_JezeroCrater_CTXDEM_20m.tif"
)
DEFAULT_OUTPUT = ROOT / "data/raw/ctx-jezero/M20_JezeroCrater_CTXDEM_20m.tif"
DEFAULT_MANIFEST = ROOT / "data/sources/ctx-jezero-dem.json"
DEFAULT_LABEL = ROOT / "test/fixtures/ctx_jezero_dem.xml"
DEFAULT_PROVENANCE = ROOT / "data/sources/ctx-jezero-download.json"
DEFAULT_CHUNK_SIZE = 256 * 1024
DEFAULT_WORKERS = 4
DEFAULT_TIMEOUT = 60.0
DEFAULT_RETRIES = 4
CHUNK_SCHEMA = 1


class DownloadError(RuntimeError):
    """Raised when a source response or local download fails validation."""


class IncompleteResponse(Exception):
    """Transiently truncated range body; safe to retry without completing a chunk."""

    def __init__(self, message: str, bytes_transferred: int = 0):
        super().__init__(message)
        self.bytes_transferred = bytes_transferred


class ObjectChangedError(DownloadError):
    """The remote object no longer matches the active resume session."""


class ProbeRequestLimit(DownloadError):
    """Raised internally when a bounded probe has used its request budget."""


def _atomic_json(path: pathlib.Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with pathlib.Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _header(response: Any, name: str) -> str | None:
    value = response.headers.get(name)
    return value.strip() if value else None


def remote_metadata(
    url: str,
    timeout: float,
    open_url: Callable = urllib.request.urlopen,
    *,
    retries: int = 0,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    request = urllib.request.Request(url, method="HEAD", headers={"Accept-Encoding": "identity"})
    for attempt in range(retries + 1):
        try:
            with open_url(request, timeout=timeout) as response:
                if response.status != 200:
                    if response.status in {408, 429, 500, 502, 503, 504}:
                        raise IncompleteResponse(f"HEAD returned transient HTTP {response.status}.")
                    raise DownloadError(f"HEAD returned HTTP {response.status}; expected 200.")
                length_text = _header(response, "Content-Length")
                if not length_text or not length_text.isdigit() or int(length_text) <= 0:
                    raise DownloadError("HEAD response has no valid positive Content-Length.")
                info = {
                    "content_length": int(length_text),
                    "etag": _header(response, "ETag"),
                    "last_modified": _header(response, "Last-Modified"),
                    "content_type": _header(response, "Content-Type"),
                    "accept_ranges": _header(response, "Accept-Ranges"),
                    "content_encoding": _header(response, "Content-Encoding"),
                }
            break
        except DownloadError:
            raise
        except IncompleteResponse as exc:
            failure = exc
        except urllib.error.HTTPError as exc:
            if exc.code not in {408, 429, 500, 502, 503, 504}:
                raise DownloadError(f"HEAD request failed with HTTP {exc.code}: {exc.reason}") from exc
            failure: Exception = exc
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError) as exc:
            failure = exc
        except Exception as exc:
            raise DownloadError(f"HEAD request failed: {exc}") from exc
        if attempt >= retries:
            raise DownloadError(f"HEAD request failed after {retries + 1} attempts: {failure}") from failure
        sleep(min(0.5 * (2**attempt), 8.0))
    if not info["etag"] and not info["last_modified"]:
        raise DownloadError("HEAD response lacks ETag and Last-Modified; no stable validator is available.")
    return info


def _validator_headers(metadata: dict[str, Any]) -> dict[str, str]:
    if metadata.get("etag"):
        return {"If-Match": metadata["etag"]}
    if metadata.get("last_modified"):
        return {"If-Unmodified-Since": metadata["last_modified"]}
    return {}


def _check_response_validator(response: Any, expected: dict[str, Any]) -> None:
    key = "etag" if expected.get("etag") else "last_modified"
    label = "ETag" if key == "etag" else "Last-Modified"
    observed = _header(response, label)
    if observed != expected.get(key):
        raise ObjectChangedError(f"Remote object changed or omitted {label} during download.")


def _is_timeout(exc: BaseException) -> bool:
    return (
        isinstance(exc, TimeoutError)
        or isinstance(getattr(exc, "reason", None), TimeoutError)
        or "timed out" in str(exc).lower()
    )


def _chunk_specs(size: int, chunk_size: int) -> list[tuple[int, int]]:
    return [(start, min(start + chunk_size - 1, size - 1)) for start in range(0, size, chunk_size)]


def _chunk_name(start: int, end: int) -> str:
    return f"chunk_{start:012d}_{end:012d}.bin"


def _valid_chunk(path: pathlib.Path, record: dict[str, Any], start: int, end: int) -> bool:
    try:
        expected_size = end - start + 1
        return (
            record.get("start") == start
            and record.get("end") == end
            and record.get("filename") == path.name
            and record.get("size", expected_size) == expected_size
            and record.get("expected_size", expected_size) == expected_size
            and record.get("actual_size", record.get("size", expected_size)) == expected_size
            and record.get("completion_status", "complete") == "complete"
            and path.is_file()
            and path.stat().st_size == expected_size
            and sha256_file(path) == record.get("sha256")
        )
    except OSError:
        return False


def _download_chunk(
    url: str,
    start: int,
    end: int,
    target: pathlib.Path,
    metadata: dict[str, Any],
    *,
    timeout: float,
    retries: int,
    open_url: Callable,
    sleep: Callable[[float], None],
    on_attempt: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    expected_size = end - start + 1
    range_pattern = re.compile(r"bytes\s+(\d+)-(\d+)/(\d+)", re.IGNORECASE)
    for attempt in range(retries + 1):
        attempt_started = time.monotonic()
        request_headers = {
            "Range": f"bytes={start}-{end}",
            "Accept-Encoding": "identity",
            **_validator_headers(metadata),
        }
        request = urllib.request.Request(url, headers=request_headers)
        try:
            with open_url(request, timeout=timeout) as response:
                if response.status != 206:
                    raise DownloadError(f"Range {start}-{end} returned HTTP {response.status}; expected 206.")
                content_range = _header(response, "Content-Range") or ""
                match = range_pattern.fullmatch(content_range)
                if not match or tuple(map(int, match.groups())) != (start, end, metadata["content_length"]):
                    raise DownloadError(
                        f"Range {start}-{end} returned invalid Content-Range {content_range!r}."
                    )
                _check_response_validator(response, metadata)
                content_length = _header(response, "Content-Length")
                if content_length is not None and content_length != str(expected_size):
                    raise DownloadError(
                        f"Range {start}-{end} declared {content_length} bytes; expected {expected_size}."
                    )
                try:
                    body = response.read(expected_size + 1)
                except http.client.IncompleteRead as exc:
                    raise IncompleteResponse(
                        f"Range {start}-{end} connection ended after {len(exc.partial)} bytes.",
                        len(exc.partial),
                    ) from exc
                if len(body) < expected_size:
                    raise IncompleteResponse(
                        f"Range {start}-{end} delivered {len(body)} bytes; expected {expected_size}.",
                        len(body),
                    )
                if len(body) > expected_size:
                    raise DownloadError(f"Range {start}-{end} delivered more than {expected_size} bytes.")
            temporary = target.with_name(target.name + ".tmp")
            with temporary.open("wb") as stream:
                stream.write(body)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, target)
            if on_attempt:
                on_attempt({"attempt": attempt, "success": True, "bytes": len(body),
                            "seconds": time.monotonic() - attempt_started,
                            "error": None, "timeout": False})
            return {
                "start": start,
                "end": end,
                "filename": target.name,
                "size": expected_size,
                "expected_size": expected_size,
                "actual_size": len(body),
                "completion_status": "complete",
                "sha256": hashlib.sha256(body).hexdigest(),
            }
        except ObjectChangedError as exc:
            if on_attempt:
                on_attempt({"attempt": attempt, "success": False, "bytes": 0,
                            "seconds": time.monotonic() - attempt_started,
                            "error": str(exc), "timeout": False})
            raise
        except urllib.error.HTTPError as exc:
            if exc.code == 412:
                changed = ObjectChangedError(f"Remote object no longer matches If-Match for range {start}-{end}.")
                if on_attempt:
                    on_attempt({"attempt": attempt, "success": False, "bytes": 0,
                                "seconds": time.monotonic() - attempt_started,
                                "error": str(changed), "timeout": False})
                raise changed from exc
            if exc.code not in {408, 429, 500, 502, 503, 504}:
                if on_attempt:
                    on_attempt({"attempt": attempt, "success": False, "bytes": 0,
                                "seconds": time.monotonic() - attempt_started,
                                "error": str(exc), "timeout": False})
                raise DownloadError(f"Range {start}-{end} failed with HTTP {exc.code}: {exc.reason}") from exc
            failure: Exception = exc
        except IncompleteResponse as exc:
            failure = exc
        except DownloadError as exc:
            if on_attempt:
                on_attempt({"attempt": attempt, "success": False, "bytes": 0,
                            "seconds": time.monotonic() - attempt_started,
                            "error": str(exc), "timeout": False})
            raise
        except DownloadError:
            raise
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError) as exc:
            failure = exc
        if on_attempt:
            on_attempt({"attempt": attempt, "success": False,
                        "bytes": getattr(failure, "bytes_transferred", 0),
                        "seconds": time.monotonic() - attempt_started,
                        "error": str(failure),
                        "timeout": _is_timeout(failure)})
        if attempt >= retries:
            raise DownloadError(f"Range {start}-{end} failed after {retries + 1} attempts: {failure}") from failure
        sleep(min(0.5 * (2**attempt), 8.0))
    raise AssertionError("unreachable")


def validate_geotiff(path: pathlib.Path) -> dict[str, Any]:
    try:
        import rasterio
    except ImportError as exc:
        raise DownloadError("GeoTIFF verification requires the already installed Rasterio dependency.") from exc
    sys.path.insert(0, str(ROOT / "tools"))
    import ctx_to_tiles

    manifest = json.loads(DEFAULT_MANIFEST.read_text(encoding="utf-8"))
    pds = ctx_to_tiles.read_pds4_reference(DEFAULT_LABEL)
    try:
        with rasterio.open(path) as dataset:
            observed = ctx_to_tiles.inspect_and_validate_source(dataset, manifest, pds)
            if dataset.scales != (1.0,) or dataset.offsets != (0.0,):
                raise DownloadError(
                    f"GeoTIFF scale/offset are {dataset.scales!r}/{dataset.offsets!r}; expected identity/zero."
                )
            return {
                "width": observed["width"],
                "height": observed["height"],
                "bands": observed["bands"],
                "data_type": observed["dtypes"][0],
                "byte_order": observed["byte_order"],
                "pixel_size_m": observed["pixel_size_m"],
                "projection": "Equirectangular",
                "latitude_type": "Planetocentric",
                "longitude_direction": "Positive East",
                "planetary_radius_m": observed["crs_proj_parameters"]["radius"],
                "geotransform_gdal_order": observed["transform_gdal_order"],
                "pds4_tiepoint_xy_m": [pds["transform"][0], pds["transform"][3]],
                "nodata": observed["nodata"],
                "scales": observed["scales"],
                "offsets": observed["offsets"],
                "crs_proj_parameters": observed["crs_proj_parameters"],
            }
    except DownloadError:
        raise
    except Exception as exc:
        raise DownloadError(f"GeoTIFF metadata validation failed: {exc}") from exc


def _validate_local_file(path: pathlib.Path, validator: Callable[[pathlib.Path], dict[str, Any]]) -> tuple[str, dict[str, Any]]:
    if not path.is_file():
        raise DownloadError(f"Output file does not exist: {path}")
    metadata = validator(path)
    return sha256_file(path), metadata


def download_file(
    url: str,
    output: pathlib.Path,
    *,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    timeout: float = DEFAULT_TIMEOUT,
    retries: int = DEFAULT_RETRIES,
    workers: int = DEFAULT_WORKERS,
    overwrite: bool = False,
    work_dir: pathlib.Path | None = None,
    provenance_path: pathlib.Path = DEFAULT_PROVENANCE,
    open_url: Callable = urllib.request.urlopen,
    sleep: Callable[[float], None] = time.sleep,
    validator: Callable[[pathlib.Path], dict[str, Any]] = validate_geotiff,
) -> dict[str, Any]:
    output = pathlib.Path(output)
    work_dir = pathlib.Path(work_dir) if work_dir else output.parent / f".{output.name}.download-work"
    manifest_path = work_dir / "download.json"
    if chunk_size < 1 or timeout <= 0 or retries < 0 or workers < 1:
        raise ValueError("chunk-size, timeout and workers must be positive; retries cannot be negative.")
    if output.exists() and not overwrite:
        raise FileExistsError(f"Refusing to overwrite existing output {output}; pass --overwrite to replace it.")

    remote = remote_metadata(url, timeout, open_url, retries=retries, sleep=sleep)
    if remote["content_length"] <= 0:
        raise DownloadError("Remote object size must be known and positive.")

    if manifest_path.exists():
        try:
            state = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise DownloadError(f"Cannot read resume manifest {manifest_path}: {exc}") from exc
        expected_fields = ("url", "total_length", "etag", "last_modified")
        current = {
            "url": url,
            "total_length": remote["content_length"],
            "etag": remote["etag"],
            "last_modified": remote["last_modified"],
        }
        if state.get("session_invalidated"):
            raise DownloadError(f"Resume session was invalidated: {state['session_invalidated']}")
        if state.get("schema_version") != CHUNK_SCHEMA:
            raise DownloadError("Existing resume manifest has an unsupported schema version.")
        changed = [key for key in expected_fields if state.get(key) != current[key]]
        if changed:
            state["session_invalidated"] = "Remote object metadata changed: " + ", ".join(changed)
            _atomic_json(manifest_path, state)
            raise DownloadError("Remote object or chunk settings differ from the existing resume manifest.")
        chunks = state.get("completed_chunks", {})
        if not isinstance(chunks, dict):
            raise DownloadError("Resume manifest completed_chunks field is invalid.")
    else:
        state = {
            "schema_version": CHUNK_SCHEMA,
            "url": url,
            "total_length": remote["content_length"],
            "etag": remote["etag"],
            "last_modified": remote["last_modified"],
            "content_type": remote["content_type"],
            "accept_ranges": remote["accept_ranges"],
            "chunk_size": chunk_size,
            "completed_chunks": {},
        }
        chunks = state["completed_chunks"]
    # Chunk size can be changed on resume: only exact matching ranges are reused;
    # other saved chunk files remain untouched and are ignored by this session.
    state["chunk_size"] = chunk_size
    work_dir.mkdir(parents=True, exist_ok=True)
    specs = _chunk_specs(remote["content_length"], chunk_size)
    total_chunks = len(specs)
    pending: list[tuple[int, int, str, pathlib.Path]] = []
    for start, end in specs:
        name = _chunk_name(start, end)
        path = work_dir / name
        record = chunks.get(name)
        if record and _valid_chunk(path, record, start, end):
            continue
        chunks.pop(name, None)
        pending.append((start, end, name, path))
    _atomic_json(manifest_path, state)

    failures: list[BaseException] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers, thread_name_prefix="ctx-range") as pool:
        future_chunks = {
            pool.submit(
                _download_chunk, url, start, end, path, remote,
                timeout=timeout, retries=retries, open_url=open_url, sleep=sleep,
            ): (start, end, name)
            for start, end, name, path in pending
        }
        for completed_count, future in enumerate(concurrent.futures.as_completed(future_chunks), start=1):
            start, end, name = future_chunks[future]
            try:
                chunks[name] = future.result()
                _atomic_json(manifest_path, state)  # Serialized by this coordinator thread.
                print(f"Downloaded range {start}-{end} ({completed_count}/{len(pending)} complete).", file=sys.stderr)
            except BaseException as exc:
                failures.append(exc)
                if isinstance(exc, ObjectChangedError):
                    state["session_invalidated"] = str(exc)
    if failures:
        _atomic_json(manifest_path, state)
        raise failures[0]

    assembling = work_dir / (output.name + ".assembling")
    digest = hashlib.sha256()
    written = 0
    with assembling.open("wb") as target:
        for start, end in specs:
            name = _chunk_name(start, end)
            path = work_dir / name
            record = chunks.get(name, {})
            if not _valid_chunk(path, record, start, end):
                raise DownloadError(f"Chunk {name} failed its local size or SHA-256 check before assembly.")
            with path.open("rb") as source:
                while True:
                    block = source.read(1024 * 1024)
                    if not block:
                        break
                    target.write(block)
                    digest.update(block)
                    written += len(block)
        target.flush()
        os.fsync(target.fileno())
    if written != remote["content_length"] or assembling.stat().st_size != remote["content_length"]:
        raise DownloadError(
            f"Assembled file has {assembling.stat().st_size} bytes; expected {remote['content_length']}."
        )
    verified_metadata = validator(assembling)
    full_hash = digest.hexdigest()
    output.parent.mkdir(parents=True, exist_ok=True)
    os.replace(assembling, output)
    record = {
        "dataset_id": json.loads(DEFAULT_MANIFEST.read_text(encoding="utf-8"))["dataset_id"],
        "original_official_url": url,
        "retrieved_at_utc": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "remote": {
            "content_length": remote["content_length"],
            "etag": remote["etag"],
            "last_modified": remote["last_modified"],
            "content_type": remote["content_type"],
            "accept_ranges": remote["accept_ranges"],
        },
        "local_filename": output.name,
        "local_sha256": full_hash,
        "sha256_statement": "SHA-256 computed locally; it is not a publisher-provided checksum.",
        "verified_tiff_metadata": verified_metadata,
        "verification_result": "passed",
        "metadata_note": (
            "USGS product catalog lists a 3,396,160 m radius, while the PDS4 label and embedded "
            "GeoTIFF CRS specify a 3,396,190 m sphere; this catalog discrepancy remains unresolved."
        ),
    }
    _atomic_json(pathlib.Path(provenance_path), record)
    # Remove only this downloader's completed temporary workspace.
    for child in work_dir.iterdir():
        child.unlink()
    work_dir.rmdir()
    return {"output": str(output), "size_bytes": written, "sha256": full_hash,
            "verified_tiff_metadata": verified_metadata, "provenance": str(provenance_path)}


def probe_source(
    url: str = DEFAULT_URL,
    *,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    workers: int = DEFAULT_WORKERS,
    max_ranges: int = 8,
    duration_limit: float = 120.0,
    timeout: float = DEFAULT_TIMEOUT,
    retries: int = DEFAULT_RETRIES,
    open_url: Callable = urllib.request.urlopen,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    """Measure a small parallel sample without retaining raster bytes."""
    if chunk_size < 1 or workers < 1 or not 1 <= max_ranges <= 8:
        raise ValueError("Probe requires positive chunk size/workers and at most eight range requests.")
    if not 0 < duration_limit <= 120 or timeout <= 0 or retries < 0:
        raise ValueError("Probe duration must be at most 120 seconds; timeout/retries must be non-negative.")
    started = time.monotonic()
    deadline = started + duration_limit
    lock = threading.Lock()
    stats: dict[str, Any] = {
        "head_requests": 0, "head_timeouts": 0, "head_elapsed_seconds": [],
        "requested_ranges": set(),
    }
    range_attempts: list[dict[str, Any]] = []

    def measured_open(request: urllib.request.Request, timeout: float):
        is_range = request.get_header("Range") is not None
        with lock:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Probe duration limit reached before request started.")
            if is_range:
                if stats.get("range_requests", 0) >= max_ranges:
                    raise ProbeRequestLimit(f"Probe stopped at {max_ranges} HTTP range requests.")
                stats["range_requests"] = stats.get("range_requests", 0) + 1
                stats["requested_ranges"].add(request.get_header("Range"))
            else:
                stats["head_requests"] += 1
            request_timeout = min(timeout, remaining)
        request_started = time.monotonic()
        try:
            return open_url(request, timeout=request_timeout)
        except Exception as exc:
            elapsed = time.monotonic() - request_started
            with lock:
                if not is_range:
                    stats["head_elapsed_seconds"].append(elapsed)
                    if _is_timeout(exc):
                        stats["head_timeouts"] += 1
            raise

    head_timeout = min(timeout, max(1.0, duration_limit / 4))
    try:
        remote = remote_metadata(
            url, head_timeout, measured_open, retries=min(retries, 1), sleep=sleep
        )
    except Exception as exc:
        elapsed = time.monotonic() - started
        return {
            "url": url, "head_error": str(exc), "range_requests": 0,
            "head_requests": stats["head_requests"], "head_timeouts": stats["head_timeouts"],
            "head_retries": max(0, stats["head_requests"] - 1),
            "successful_ranges": 0, "range_retries": 0, "range_timeouts": 0,
            "transferred_bytes": 0, "average_response_seconds": None,
            "elapsed_seconds": elapsed, "effective_throughput_bytes_per_second": 0,
            "full_download_estimate_seconds": None,
        }

    specs = _chunk_specs(remote["content_length"], chunk_size)[:max_ranges]
    with tempfile.TemporaryDirectory(prefix="ctx-range-probe-") as temp_name:
        temp_dir = pathlib.Path(temp_name)

        def record_attempt(event: dict[str, Any]) -> None:
            with lock:
                range_attempts.append(event)

        failures: list[str] = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers, thread_name_prefix="ctx-probe") as pool:
            futures = {
                pool.submit(
                    _download_chunk, url, start, end,
                    temp_dir / _chunk_name(start, end), remote,
                    timeout=timeout, retries=retries, open_url=measured_open,
                    sleep=sleep, on_attempt=record_attempt,
                ): (start, end)
                for start, end in specs
            }
            for future in concurrent.futures.as_completed(futures):
                try:
                    future.result()
                except BaseException as exc:
                    failures.append(str(exc))

    elapsed = time.monotonic() - started
    successful = [event for event in range_attempts if event["success"]]
    transferred = sum(event["bytes"] for event in range_attempts)
    throughput = transferred / elapsed if elapsed > 0 else 0.0
    return {
        "url": url,
        "remote_content_length": remote["content_length"],
        "etag": remote["etag"],
        "chunk_size": chunk_size,
        "workers": workers,
        "range_limit": max_ranges,
        "range_requests": stats.get("range_requests", 0),
        "successful_ranges": len(successful),
        "average_response_seconds": (
            sum(event["seconds"] for event in successful) / len(successful) if successful else None
        ),
        "transferred_bytes": transferred,
        "elapsed_seconds": elapsed,
        "effective_throughput_bytes_per_second": throughput,
        "range_retries": stats.get("range_requests", 0) - len(stats["requested_ranges"]),
        "range_timeouts": sum(1 for event in range_attempts if event["timeout"]),
        "head_requests": stats["head_requests"],
        "head_retries": max(0, stats["head_requests"] - 1),
        "head_timeouts": stats["head_timeouts"],
        "full_download_estimate_seconds": (
            remote["content_length"] / throughput if throughput > 0 else None
        ),
        "range_failures": failures,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--output", type=pathlib.Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--chunk-size", type=int, default=DEFAULT_CHUNK_SIZE)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument("--retries", type=int, default=DEFAULT_RETRIES)
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    parser.add_argument("--dry-run", action="store_true", help="Inspect remote HEAD metadata without downloading.")
    parser.add_argument("--overwrite", action="store_true", help="Permit replacing an existing output after verification.")
    parser.add_argument("--verify-only", action="store_true", help="Verify an existing output without network access.")
    parser.add_argument("--provenance", type=pathlib.Path, default=DEFAULT_PROVENANCE)
    args = parser.parse_args(argv)
    try:
        if args.verify_only:
            digest, metadata = _validate_local_file(args.output, validate_geotiff)
            print(json.dumps({"output": str(args.output), "size_bytes": args.output.stat().st_size,
                              "sha256": digest, "verified_tiff_metadata": metadata}, indent=2))
            return 0
        remote = remote_metadata(args.url, args.timeout, retries=args.retries)
        if args.dry_run:
            print(json.dumps({"url": args.url, **remote, "chunk_size": args.chunk_size,
                              "workers": args.workers,
                              "chunks": len(_chunk_specs(remote["content_length"], args.chunk_size))}, indent=2))
            return 0
        result = download_file(args.url, args.output, chunk_size=args.chunk_size,
                               timeout=args.timeout, retries=args.retries, workers=args.workers,
                               overwrite=args.overwrite,
                               provenance_path=args.provenance)
        print(json.dumps(result, indent=2))
        return 0
    except (OSError, ValueError, DownloadError, json.JSONDecodeError) as exc:
        print(f"CTX download failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
