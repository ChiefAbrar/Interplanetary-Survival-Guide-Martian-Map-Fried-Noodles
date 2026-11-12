#!/usr/bin/env python3
"""Read-only verification for a public, immutable CTX tile release."""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

EXPECTED_DATASET = "urn:nasa:pds:mars2020_ctx_basemap_2021:data:m20_ctxdem_mosaic"
EXPECTED_CATALOG_FORMAT = "mars-survival-ctx-tile-catalog"
TILE_ID = re.compile(r"ctx_r\d{3}_c\d{3}\Z")
JSON_TYPES = {"application/json", "application/geo+json"}
SAMPLE_POSITIONS = ((0, 0), (0, 8), (5, 4), (10, 0), (10, 8))


class VerificationError(ValueError):
    pass


def _safe_asset_url(base_url: str, relative: Any) -> str:
    if not isinstance(relative, str) or not relative or "\\" in relative:
        raise VerificationError(f"Unsafe catalog asset path: {relative!r}")
    parsed_relative = urllib.parse.urlsplit(relative)
    if parsed_relative.scheme or parsed_relative.netloc or parsed_relative.query or parsed_relative.fragment:
        raise VerificationError(f"Unexpected URL in catalog asset path: {relative!r}")
    decoded = urllib.parse.unquote(parsed_relative.path)
    path = pathlib.PurePosixPath(decoded)
    if path.is_absolute() or any(part in {".", ".."} for part in path.parts) or len(path.parts) != 1:
        raise VerificationError(f"Unsafe catalog asset path: {relative!r}")
    base = urllib.parse.urlsplit(base_url)
    resolved = urllib.parse.urlsplit(urllib.parse.urljoin(base_url, urllib.parse.quote(decoded, safe="._-")))
    if resolved.scheme != "https" or resolved.netloc != base.netloc or not resolved.path.startswith(base.path):
        raise VerificationError(f"Catalog asset escapes the release origin or path: {relative!r}")
    return urllib.parse.urlunsplit(resolved)


def _request(url: str, timeout: float, *, origin: str | None = None, method: str = "GET", extra_headers: dict[str, str] | None = None):
    headers = {"User-Agent": "Mars-Survival-CTX-Release-Verifier/1.0"}
    if origin:
        headers["Origin"] = origin
    if extra_headers:
        headers.update(extra_headers)
    request = urllib.request.Request(url, headers=headers, method=method)
    return urllib.request.urlopen(request, timeout=timeout)


def _fetch_json(url: str, timeout: float, app_origin: str, expected_asset: str) -> tuple[dict[str, Any], dict[str, str]]:
    with _request(url, timeout, origin=app_origin) as response:
        status = response.status
        headers = {key.lower(): value for key, value in response.headers.items()}
        body = response.read()
    if status != 200:
        raise VerificationError(f"{expected_asset}: expected HTTP 200, received {status}")
    content_type = headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type not in JSON_TYPES:
        raise VerificationError(f"{expected_asset}: expected JSON content type, received {content_type or '(missing)'}")
    try:
        value = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise VerificationError(f"{expected_asset}: invalid JSON ({exc})") from exc
    if not isinstance(value, dict):
        raise VerificationError(f"{expected_asset}: top-level JSON value must be an object")
    _check_cors(headers, app_origin, expected_asset)
    return value, headers


def _check_cors(headers: dict[str, str], app_origin: str, asset: str) -> None:
    allowed = headers.get("access-control-allow-origin", "")
    if allowed not in {app_origin, "*"}:
        raise VerificationError(f"{asset}: Access-Control-Allow-Origin must equal {app_origin!r} or '*'; got {allowed or '(missing)'}")


def _validate_catalog(catalog: dict[str, Any], base_url: str) -> list[dict[str, Any]]:
    if catalog.get("format") != EXPECTED_CATALOG_FORMAT or catalog.get("version") != 2:
        raise VerificationError("catalog.json: unsupported CTX catalog format/version")
    if catalog.get("dataset_id") != EXPECTED_DATASET:
        raise VerificationError("catalog.json: unexpected dataset_id")
    tiling = catalog.get("tiling")
    coverage = catalog.get("coverage_verification")
    tiles = catalog.get("tiles")
    if not isinstance(tiling, dict) or tiling.get("is_partial_selection") is not False:
        raise VerificationError("catalog.json: release is not marked as a complete tile selection")
    if not isinstance(coverage, dict) or coverage.get("complete_source_coverage") is not True or coverage.get("core_pixels_expected") != coverage.get("core_pixels_unique"):
        raise VerificationError("catalog.json: source coverage is incomplete or unverified")
    if not isinstance(tiles, list) or len(tiles) != 99:
        raise VerificationError(f"catalog.json: expected exactly 99 tiles, found {len(tiles) if isinstance(tiles, list) else 'invalid'}")
    seen: set[str] = set()
    normalized = []
    for tile in tiles:
        if not isinstance(tile, dict):
            raise VerificationError("catalog.json: malformed tile record")
        tile_id = tile.get("tile_id")
        if not isinstance(tile_id, str) or not TILE_ID.fullmatch(tile_id) or tile_id in seen:
            raise VerificationError(f"catalog.json: invalid or duplicate tile id {tile_id!r}")
        seen.add(tile_id)
        if tile.get("metadata_file") != f"{tile_id}.json" or tile.get("data_file") != f"{tile_id}.f32":
            raise VerificationError(f"catalog.json: unexpected sidecar or binary filename for {tile_id}")
        normalized.append({"record": tile, "sidecar_url": _safe_asset_url(base_url, tile["metadata_file"]),
                           "binary_url": _safe_asset_url(base_url, tile["data_file"])})
    expected_ids = {f"ctx_r{row:03d}_c{col:03d}" for row in range(11) for col in range(9)}
    if seen != expected_ids:
        raise VerificationError("catalog.json: tile identities do not cover the expected 11 by 9 grid")
    return normalized


def _selected_tiles(tiles: list[dict[str, Any]], full: bool) -> list[dict[str, Any]]:
    if full:
        return tiles
    by_id = {tile["record"]["tile_id"]: tile for tile in tiles}
    return [by_id[f"ctx_r{row:03d}_c{col:03d}"] for row, col in SAMPLE_POSITIONS]


def _verify_binary(tile: dict[str, Any], timeout: float, app_origin: str, *, full: bool) -> None:
    tile_id = tile["record"]["tile_id"]
    sidecar, _ = _fetch_json(tile["sidecar_url"], timeout, app_origin, f"{tile_id}.json")
    data = sidecar.get("data")
    if not isinstance(data, dict) or sidecar.get("tile_id") != tile_id or sidecar.get("catalog_version") != 2:
        raise VerificationError(f"{tile_id}.json: sidecar identity/version/data is invalid")
    record = tile["record"]
    if sidecar.get("dataset_id") != EXPECTED_DATASET or data.get("filename") != record["data_file"]:
        raise VerificationError(f"{tile_id}.json: dataset or binary filename does not match catalog")
    if record.get("width") != sidecar.get("width") or record.get("height") != sidecar.get("height"):
        raise VerificationError(f"{tile_id}.json: dimensions do not match catalog")
    size = data.get("expected_bytes")
    expected_hash = data.get("sha256")
    if not isinstance(size, int) or size <= 0 or not isinstance(expected_hash, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", expected_hash):
        raise VerificationError(f"{tile_id}.json: invalid expected byte size or SHA-256")
    try:
        range_headers = {} if full else {"Range": "bytes=0-0"}
        with _request(tile["binary_url"], timeout, origin=app_origin, extra_headers=range_headers) as response:
            headers = {key.lower(): value for key, value in response.headers.items()}
            allowed_statuses = {200} if full else {200, 206}
            if response.status not in allowed_statuses:
                raise VerificationError(f"{record['data_file']}: expected HTTP {sorted(allowed_statuses)}, received {response.status}")
            content_type = headers.get("content-type", "").split(";", 1)[0].strip().lower()
            if content_type != "application/octet-stream":
                raise VerificationError(f"{record['data_file']}: expected application/octet-stream, received {content_type or '(missing)'}")
            _check_cors(headers, app_origin, record["data_file"])
            if not full:
                response.read(1)
                return
            digest = hashlib.sha256()
            actual_size = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                actual_size += len(chunk)
                digest.update(chunk)
    except urllib.error.HTTPError as exc:
        raise VerificationError(f"{record['data_file']}: HTTP {exc.code}") from exc
    if actual_size != size:
        raise VerificationError(f"{record['data_file']}: expected {size} bytes, received {actual_size}")
    if digest.hexdigest().lower() != expected_hash.lower():
        raise VerificationError(f"{record['data_file']}: SHA-256 mismatch")


def _verify_preflight(base_url: str, timeout: float, app_origin: str) -> None:
    request = urllib.request.Request(base_url + "catalog.json", headers={
        "Origin": app_origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "",
    }, method="OPTIONS")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            headers = {key.lower(): value for key, value in response.headers.items()}
            if response.status not in {200, 204}:
                raise VerificationError(f"catalog.json preflight: expected HTTP 200/204, received {response.status}")
    except urllib.error.HTTPError as exc:
        raise VerificationError(f"catalog.json preflight: HTTP {exc.code}") from exc
    _check_cors(headers, app_origin, "catalog.json preflight")
    methods = {item.strip().upper() for item in headers.get("access-control-allow-methods", "").split(",")}
    if not {"GET", "HEAD"}.issubset(methods):
        raise VerificationError("catalog.json preflight: Access-Control-Allow-Methods must include GET and HEAD")


def verify(base_url: str, app_origin: str, *, full: bool = False, timeout: float = 20.0) -> list[str]:
    base = urllib.parse.urlsplit(base_url)
    origin = urllib.parse.urlsplit(app_origin)
    if base.scheme != "https" or not base.netloc or base.username or base.password or base.query or base.fragment:
        raise VerificationError("--base-url must be an HTTPS release directory URL without credentials, query, or fragment")
    if origin.scheme != "https" or not origin.netloc or origin.username or origin.password or origin.path not in {"", "/"} or origin.query or origin.fragment:
        raise VerificationError("--app-origin must be an exact HTTPS origin without path, query, or fragment")
    normalized_base = base_url.rstrip("/") + "/"
    app_origin = f"{origin.scheme}://{origin.netloc}"
    catalog, _ = _fetch_json(_safe_asset_url(normalized_base, "catalog.json"), timeout, app_origin, "catalog.json")
    tiles = _validate_catalog(catalog, normalized_base)
    failures = []
    try:
        _verify_preflight(normalized_base, timeout, app_origin)
    except (VerificationError, urllib.error.URLError, TimeoutError) as exc:
        failures.append(str(exc))
    selected = _selected_tiles(tiles, full)
    for tile in selected:
        try:
            _verify_binary(tile, timeout, app_origin, full=full)
        except (VerificationError, urllib.error.URLError, TimeoutError, OSError) as exc:
            failures.append(str(exc))
    return failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True, help="Public HTTPS release directory URL, with or without trailing slash.")
    parser.add_argument("--app-origin", required=True, help="Exact deployed application HTTPS origin.")
    parser.add_argument("--full", action="store_true", help="Stream all 99 binaries and verify byte sizes and SHA-256 hashes.")
    parser.add_argument("--timeout", type=float, default=20.0, help="HTTP request timeout in seconds (default: 20).")
    args = parser.parse_args(argv)
    if args.timeout <= 0:
        parser.error("--timeout must be greater than zero")
    try:
        failures = verify(args.base_url, args.app_origin, full=args.full, timeout=args.timeout)
    except (VerificationError, urllib.error.URLError, TimeoutError, OSError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1
    mode = "full" if args.full else "representative"
    count = 99 if args.full else len(SAMPLE_POSITIONS)
    print(f"PASS: public CTX release verified ({mode}; catalog + {count} tile(s) + CORS preflight).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
