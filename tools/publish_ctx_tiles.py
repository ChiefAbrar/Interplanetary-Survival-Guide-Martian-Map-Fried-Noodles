#!/usr/bin/env python3
"""Validate and publish the complete processed CTX collection to S3-compatible storage.

The default is a local dry-run. A remote transfer requires explicit --publish,
an s3:// destination, an endpoint URL, and AWS-compatible credentials.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

ROOT = pathlib.Path(__file__).resolve().parent.parent
OFFICIAL_DATASET_ID = "urn:nasa:pds:mars2020_ctx_basemap_2021:data:m20_ctxdem_mosaic"
TILE_ID = re.compile(r"ctx_r\d{3}_c\d{3}")
SHA256 = re.compile(r"[0-9a-fA-F]{64}")
CACHE_CONTROL = "public, max-age=31536000, immutable"


class PublishError(ValueError):
    pass


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


@dataclass(frozen=True)
class Asset:
    relative_path: str
    path: pathlib.Path
    size_bytes: int
    sha256: str
    content_type: str


def _regular_child(root: pathlib.Path, name: str) -> pathlib.Path:
    if not isinstance(name, str) or pathlib.PurePath(name).name != name or name in {"", ".", ".."}:
        raise PublishError(f"Unsafe CTX asset path in catalog: {name!r}")
    path = root / name
    if path.is_symlink() or not path.is_file():
        raise PublishError(f"Required CTX asset is missing or not a regular file: {path}")
    return path


def validate_collection(source_dir: pathlib.Path, *, require_official: bool = True) -> tuple[list[Asset], str, dict[str, Any]]:
    source_dir = source_dir.resolve()
    catalog_path = _regular_child(source_dir, "catalog.json")
    try:
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PublishError(f"Cannot read CTX catalog: {exc}") from exc
    if catalog.get("format") != "mars-survival-ctx-tile-catalog" or catalog.get("version") != 2:
        raise PublishError("Catalog format/version is not the supported CTX format version 2.")
    if require_official and catalog.get("dataset_id") != OFFICIAL_DATASET_ID:
        raise PublishError("Catalog is not the official Jezero CTX dataset.")
    if catalog.get("tiling", {}).get("is_partial_selection") is not False:
        raise PublishError("Refusing to publish a partial CTX tile selection.")
    coverage = catalog.get("coverage_verification", {})
    if coverage.get("complete_source_coverage") is not True or coverage.get("core_pixels_expected") != coverage.get("core_pixels_unique"):
        raise PublishError("Catalog does not verify complete, non-overlapping source coverage.")
    tiles = catalog.get("tiles")
    if not isinstance(tiles, list) or not tiles:
        raise PublishError("Catalog has no tile records.")
    if require_official and len(tiles) != 99:
        raise PublishError(f"Official collection must contain 99 tiles; found {len(tiles)}.")
    assets = [Asset("catalog.json", catalog_path, catalog_path.stat().st_size,
                    sha256_file(catalog_path), "application/json")]
    seen_ids, seen_files = set(), {"catalog.json"}
    for record in tiles:
        if not isinstance(record, dict):
            raise PublishError("Catalog contains a malformed tile record.")
        tile_id = record.get("tile_id")
        if not isinstance(tile_id, str) or not TILE_ID.fullmatch(tile_id) or tile_id in seen_ids:
            raise PublishError(f"Invalid or duplicate tile identifier: {tile_id!r}")
        seen_ids.add(tile_id)
        sidecar_name, binary_name = record.get("metadata_file"), record.get("data_file")
        if sidecar_name != f"{tile_id}.json" or binary_name != f"{tile_id}.f32":
            raise PublishError(f"Tile {tile_id} has unexpected sidecar or binary names.")
        if sidecar_name in seen_files or binary_name in seen_files:
            raise PublishError(f"Catalog repeats an asset path for {tile_id}.")
        seen_files.update((sidecar_name, binary_name))
        sidecar_path = _regular_child(source_dir, sidecar_name)
        binary_path = _regular_child(source_dir, binary_name)
        try:
            metadata = json.loads(sidecar_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise PublishError(f"Cannot read sidecar for {tile_id}: {exc}") from exc
        if metadata.get("catalog_version") != 2 or metadata.get("tile_id") != tile_id or metadata.get("dataset_id") != catalog.get("dataset_id"):
            raise PublishError(f"Sidecar identity/version mismatch for {tile_id}.")
        catalog_source_hash = catalog.get("source_raster", {}).get("sha256")
        if metadata.get("source_raster", {}).get("sha256") != catalog_source_hash:
            raise PublishError(f"Sidecar source provenance differs from catalog for {tile_id}.")
        data = metadata.get("data", {})
        expected_size, expected_hash = data.get("expected_bytes"), data.get("sha256")
        if not isinstance(expected_size, int) or expected_size <= 0 or binary_path.stat().st_size != expected_size:
            raise PublishError(f"Binary size mismatch for {tile_id}.")
        if not isinstance(expected_hash, str) or not SHA256.fullmatch(expected_hash):
            raise PublishError(f"Sidecar has no valid SHA-256 for {tile_id}.")
        if record.get("width") != metadata.get("width") or record.get("height") != metadata.get("height"):
            raise PublishError(f"Catalog dimensions differ from sidecar for {tile_id}.")
        actual_hash = sha256_file(binary_path)
        if actual_hash.lower() != expected_hash.lower():
            raise PublishError(f"Binary SHA-256 mismatch for {tile_id}.")
        assets.append(Asset(sidecar_name, sidecar_path, sidecar_path.stat().st_size,
                            sha256_file(sidecar_path), "application/json"))
        assets.append(Asset(binary_name, binary_path, expected_size, actual_hash, "application/octet-stream"))
    if require_official and len(seen_ids) != 99:
        raise PublishError(f"Official collection must contain 99 unique tiles; found {len(seen_ids)}.")
    # A publishable directory may contain unrelated non-asset files, but all catalog assets are checked.
    fingerprint = hashlib.sha256()
    for asset in sorted(assets, key=lambda item: item.relative_path):
        fingerprint.update(asset.relative_path.encode("utf-8"))
        fingerprint.update(b"\0")
        fingerprint.update(asset.sha256.encode("ascii"))
        fingerprint.update(b"\n")
    return assets, fingerprint.hexdigest(), catalog


def parse_destination(value: str) -> tuple[str, str]:
    parsed = urlparse(value)
    if parsed.scheme != "s3" or not parsed.netloc:
        raise PublishError("Destination must use s3://bucket/optional/prefix.")
    if parsed.query or parsed.fragment or "@" in parsed.netloc or re.search(r"[\s\\]", value):
        raise PublishError("Destination must be a plain s3://bucket/optional/prefix without credentials or query data.")
    prefix = parsed.path.strip("/")
    return parsed.netloc, prefix


def _aws(args: list[str], endpoint_url: str) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(["aws", "s3api", *args, "--endpoint-url", endpoint_url,
                               "--output", "json"], capture_output=True, text=True)
    except FileNotFoundError as exc:
        raise PublishError("AWS CLI is required for --publish; install it separately and retry.") from exc


def publish(source_dir: pathlib.Path, destination: str, endpoint_url: str, *, do_publish: bool,
            runner=_aws) -> dict[str, Any]:
    assets, fingerprint, catalog = validate_collection(source_dir)
    bucket, prefix = parse_destination(destination)
    public_origin = os.environ.get("CTX_TILE_PUBLIC_BASE_URL", "")
    if public_origin:
        parsed_public = urlparse(public_origin)
        if parsed_public.scheme != "https" or not parsed_public.netloc or parsed_public.username or parsed_public.password or parsed_public.query or parsed_public.fragment:
            raise PublishError("CTX_TILE_PUBLIC_BASE_URL must be an absolute HTTPS base URL without credentials, query, or fragment.")
    release_prefix = "/".join(part for part in (prefix, "releases", fingerprint[:20]) if part)
    counts = {"uploaded": [], "skipped": [], "failed": []}
    plan = []
    ordered_assets = sorted(assets, key=lambda asset: (asset.relative_path == "catalog.json", asset.relative_path))
    for asset in ordered_assets:
        key = "/".join(part for part in (release_prefix, asset.relative_path) if part)
        plan.append({"path": asset.relative_path, "key": key, "size_bytes": asset.size_bytes,
                     "sha256": asset.sha256, "content_type": asset.content_type})
    if not do_publish:
        return {"mode": "dry-run", "dataset_id": catalog["dataset_id"], "tile_count": len(catalog["tiles"]),
                "release_id": fingerprint[:20], "remote_base_key": release_prefix,
                "public_base_url": public_origin.rstrip("/") + "/" + release_prefix + "/" if public_origin else "",
                "planned": plan, "uploaded": [], "skipped": [], "failed": []}
    if not endpoint_url:
        raise PublishError("Set CTX_TILE_ENDPOINT_URL before using --publish.")
    if not os.environ.get("AWS_ACCESS_KEY_ID") or not os.environ.get("AWS_SECRET_ACCESS_KEY"):
        raise PublishError("Set AWS-compatible credentials (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY) before using --publish.")
    actions = []
    for asset, item in zip(ordered_assets, plan):
        key = item["key"]
        head = runner(["head-object", "--bucket", bucket, "--key", key], endpoint_url)
        if head.returncode == 0:
            try:
                existing = json.loads(head.stdout)
            except json.JSONDecodeError:
                counts["failed"].append({"path": asset.relative_path, "error": "Remote HEAD returned invalid JSON"})
                continue
            metadata = {str(k).lower(): str(v) for k, v in existing.get("Metadata", {}).items()}
            if existing.get("ContentLength") == asset.size_bytes and metadata.get("sha256", "").lower() == asset.sha256:
                actions.append((asset, item, "skip"))
            else:
                counts["failed"].append({"path": asset.relative_path, "error": "Immutable release key exists with different size or SHA-256"})
            continue
        error_text = (head.stderr or "").lower()
        if not any(token in error_text for token in ("404", "not found", "nosuchkey", "no such key")):
            counts["failed"].append({"path": asset.relative_path, "error": f"Remote HEAD failed: {head.stderr.strip()}"})
            continue
        actions.append((asset, item, "upload"))
    if counts["failed"]:
        return {"mode": "publish", "dataset_id": catalog["dataset_id"], "tile_count": len(catalog["tiles"]),
                "release_id": fingerprint[:20], "remote_base_key": release_prefix,
                "public_base_url": "", **counts}
    # The catalog is the release's discovery/commit object. Publish it only after
    # every sidecar and binary succeeded or was verified to match.
    actions.sort(key=lambda action: (action[0].relative_path == "catalog.json", action[0].relative_path))
    upload_failures = False
    for asset, item, action in actions:
        if asset.relative_path == "catalog.json" and upload_failures:
            counts["failed"].append({"path": asset.relative_path, "error": "Catalog withheld because one or more release assets failed to upload"})
            continue
        if action == "skip":
            counts["skipped"].append(asset.relative_path)
            continue
        upload = runner(["put-object", "--bucket", bucket, "--key", item["key"], "--body", str(asset.path),
                         "--content-type", asset.content_type, "--cache-control", CACHE_CONTROL,
                         "--metadata", f"sha256={asset.sha256}"], endpoint_url)
        if upload.returncode == 0:
            counts["uploaded"].append(asset.relative_path)
        else:
            upload_failures = True
            counts["failed"].append({"path": asset.relative_path, "error": upload.stderr.strip()})
    public_base = public_origin
    if public_base:
        public_base = parsed_public.geturl().rstrip("/") + "/" + release_prefix + "/"
    return {"mode": "publish", "dataset_id": catalog["dataset_id"], "tile_count": len(catalog["tiles"]),
            "release_id": fingerprint[:20], "remote_base_key": release_prefix,
            "public_base_url": "" if counts["failed"] else public_base, **counts}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=pathlib.Path, default=ROOT / "data/processed/ctx-jezero")
    parser.add_argument("--destination", default=os.environ.get("CTX_TILE_DESTINATION", ""), help="s3://bucket/prefix; required for dry-run and publish.")
    parser.add_argument("--endpoint-url", default=os.environ.get("CTX_TILE_ENDPOINT_URL", ""))
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Validate and print upload plan (the default).")
    mode.add_argument("--publish", action="store_true", help="Actually upload to the configured S3-compatible destination.")
    args = parser.parse_args(argv)
    try:
        if not args.destination:
            raise PublishError("Set CTX_TILE_DESTINATION or pass --destination s3://bucket/prefix.")
        result = publish(args.source_dir, args.destination, args.endpoint_url, do_publish=args.publish)
        print(json.dumps(result, indent=2))
        return 1 if result["failed"] else 0
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        print(f"CTX publish preparation failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
