#!/usr/bin/env python3
"""Build the static application into dist without deleting unrelated assets."""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

ROOT = pathlib.Path(__file__).resolve().parent.parent
MANIFEST_PATH = ROOT / "tools/dist_manifest.json"
LAYOUT_PATH = ROOT / "app/views/layouts/application.html.erb"


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _render_pages(dist_stage: pathlib.Path, tile_base_url: str, pages: list[str]) -> list[str]:
    layout = LAYOUT_PATH.read_text(encoding="utf-8")
    view = (ROOT / "app/views/home/index.html.erb").read_text(encoding="utf-8")
    if layout.count("<%= yield %>") != 1:
        raise ValueError("Rails layout must contain exactly one yield placeholder.")
    if tile_base_url:
        parsed = urlsplit(tile_base_url)
        if (parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password
                or parsed.query or parsed.fragment or re.search(r"[\s<>\"']", tile_base_url)):
            raise ValueError("CTX_TILE_BASE_URL must be an absolute HTTPS directory URL without credentials, query, or fragment.")
    rendered = layout.replace("<%= yield %>", view)
    rendered = re.sub(r'(<meta name="ctx-tile-base-url" content=")[^"]*(">)',
                      lambda match: match.group(1) + html.escape(tile_base_url, quote=True) + match.group(2),
                      rendered)
    if pages != ["index.html", "explore/index.html", "regions/jezero/index.html"]:
        raise ValueError("The entry page list must contain the supported static app routes.")
    for relative in pages:
        destination = dist_stage / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(rendered, encoding="utf-8", newline="\n")
    # Return an independent list. build() extends generated assets afterward;
    # returning the manifest's entry_pages list would mutate the page list too.
    return list(pages)


def _copy_public_assets(stage: pathlib.Path, manifest: dict) -> list[str]:
    public = ROOT / "public"
    expected = set(manifest["public_assets"])
    actual = {p.relative_to(public).as_posix() for p in public.rglob("*") if p.is_file()}
    missing = expected - actual
    if missing:
        raise ValueError("Manifest refers to missing public assets: " + ", ".join(sorted(missing)))
    unlisted = actual - expected
    for relative in manifest["public_assets"]:
        source, target = public / relative, stage / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    preserved = set(manifest.get("preserved_dist_assets", []))
    for relative in sorted(unlisted):
        if relative not in preserved:
            raise ValueError("Public asset is not classified in tools/dist_manifest.json: " + relative)
        target = stage / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(public / relative, target)
    return list(manifest["public_assets"])


def _validate_stage(stage: pathlib.Path, generated: list[str], entry_pages: list[str]) -> None:
    names = set(generated)
    for page in entry_pages:
        if page not in names or not (stage / page).is_file():
            raise ValueError(f"Required entry page missing from staged build: {page}")
    for page in entry_pages:
        document = (stage / page).read_text(encoding="utf-8")
        for ref in re.findall(r'(?:src|href)="(/(?:js|css|data)/[^"?#]+)', document):
            relative = ref.lstrip("/")
            if relative not in names or not (stage / relative).is_file():
                raise ValueError(f"HTML reference {ref} in {page} has no staged asset.")
    for module_path in [p for p in generated if p.startswith("js/") and p.endswith(".js")]:
        source = (stage / module_path).read_text(encoding="utf-8")
        for specifier in re.findall(r'\bfrom\s*["\'](\.[^"\']+)["\']|\bimport\s*["\'](\.[^"\']+)["\']', source):
            relative_specifier = next(value for value in specifier if value)
            resolved = pathlib.PurePosixPath(module_path).parent.joinpath(relative_specifier)
            normalized = pathlib.PurePosixPath(os.path.normpath(str(resolved)).replace("\\", "/"))
            asset_path = normalized.as_posix()
            if asset_path not in names or not (stage / asset_path).is_file():
                raise ValueError(f"Local JavaScript import {relative_specifier} in {module_path} is not staged.")


def build(dist_dir: pathlib.Path, tile_base_url: str | None = None, *, replace_file=os.replace) -> dict:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    if manifest.get("version") != 1:
        raise ValueError("Unsupported dist asset manifest version.")
    generated_paths = set(manifest["entry_pages"]) | set(manifest["public_assets"])
    preserved_paths = set(manifest.get("preserved_dist_assets", []))
    if generated_paths & preserved_paths:
        raise ValueError("A dist path cannot be both generated and preserved.")
    tile_base_url = os.environ.get("CTX_TILE_BASE_URL", "").strip() if tile_base_url is None else tile_base_url.strip()
    dist_dir = dist_dir.resolve()
    dist_dir.parent.mkdir(parents=True, exist_ok=True)
    stage_root = pathlib.Path(tempfile.mkdtemp(prefix=".mars-dist-stage-", dir=dist_dir.parent))
    try:
        generated = _render_pages(stage_root, tile_base_url, manifest["entry_pages"])
        for page in manifest["entry_pages"]:
            page_path = stage_root / page
            if not page_path.is_file() or page_path.read_bytes()[:15].lower() != b"<!doctype html>":
                raise ValueError(f"Staged entry page is not rendered HTML: {page_path}")
        generated.extend(_copy_public_assets(stage_root, manifest))
        _validate_stage(stage_root, generated, manifest["entry_pages"])
        records = []
        for relative in sorted(set(generated)):
            source = stage_root / relative
            records.append({"path": relative, "size_bytes": source.stat().st_size, "sha256": sha256(source)})
        manifest_relative = manifest["generated_manifest"]
        generated_manifest = {"version": manifest["version"], "files": records}
        manifest_temp = stage_root / manifest_relative
        manifest_temp.write_text(json.dumps(generated_manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
        # Preflight all generated paths before touching dist. Never follow or replace symlinks.
        destinations = [dist_dir / record["path"] for record in records] + [dist_dir / manifest_relative]
        if manifest_relative in preserved_paths:
            raise ValueError("Generated manifest path cannot also be preserved.")
        for target in destinations:
            if target.is_symlink() or (target.exists() and not target.is_file()):
                raise ValueError(f"Refusing to replace non-regular generated destination: {target}")
            parent = target.parent
            while parent != dist_dir.parent and parent != dist_dir:
                if parent.is_symlink():
                    raise ValueError(f"Refusing to write through symlinked directory: {parent}")
                parent = parent.parent
        preserved_sources = []
        for relative in sorted(preserved_paths):
            source = ROOT / "public" / relative
            target = dist_dir / relative
            if not source.is_file() or source.is_symlink():
                raise ValueError(f"Preserved public asset is missing or not a regular file: {source}")
            if target.is_symlink() or (target.exists() and not target.is_file()):
                raise ValueError(f"Refusing to copy preserved asset over non-regular destination: {target}")
            if not target.exists():
                preserved_sources.append((source, target))
        for target in destinations:
            target.parent.mkdir(parents=True, exist_ok=True)
        for source, target in preserved_sources:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        # Keep byte-for-byte backups until every generated file, including the
        # manifest commit record, has been replaced. Roll back on any failure.
        promotion = [(stage_root / record["path"], dist_dir / record["path"]) for record in records]
        promotion.append((manifest_temp, dist_dir / manifest_relative))
        backups: dict[pathlib.Path, pathlib.Path | None] = {}
        replaced: list[pathlib.Path] = []
        try:
            for _, target in promotion:
                if target.exists():
                    backup = stage_root / ".rollback" / target.relative_to(dist_dir)
                    backup.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(target, backup)
                    backups[target] = backup
                else:
                    backups[target] = None
            for source, target in promotion:
                with tempfile.NamedTemporaryFile(dir=target.parent, prefix=f".{target.name}.", suffix=".build-tmp", delete=False) as stream:
                    temporary = pathlib.Path(stream.name)
                    with source.open("rb") as input_stream:
                        shutil.copyfileobj(input_stream, stream)
                replace_file(temporary, target)
                replaced.append(target)
        except BaseException:
            for target in reversed(replaced):
                backup = backups[target]
                if backup is None:
                    target.unlink(missing_ok=True)
                else:
                    with tempfile.NamedTemporaryFile(dir=target.parent, prefix=f".{target.name}.", suffix=".rollback-tmp", delete=False) as stream:
                        rollback_temp = pathlib.Path(stream.name)
                        with backup.open("rb") as input_stream:
                            shutil.copyfileobj(input_stream, stream)
                    os.replace(rollback_temp, target)
            raise
        return generated_manifest
    finally:
        shutil.rmtree(stage_root, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist-dir", type=pathlib.Path, default=ROOT / "dist", help="Output directory (defaults to repository dist/).")
    parser.add_argument("--tile-base-url", default=None, help="Override CTX_TILE_BASE_URL for this build.")
    args = parser.parse_args(argv)
    try:
        result = build(args.dist_dir, args.tile_base_url)
        print(f"Built {len(result['files'])} manifest-listed files into {args.dist_dir} without deleting other assets.")
        return 0
    except (OSError, ValueError, subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        print(f"Static build failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
