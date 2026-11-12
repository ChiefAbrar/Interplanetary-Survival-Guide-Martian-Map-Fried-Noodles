#!/usr/bin/env python3
"""Extract native-resolution windows from the official Jezero CTX DEM GeoTIFF.

The output is a preprocessing format for a future multi-tile loader. It is not
the active browser tile format and is deliberately stored outside public/.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import pathlib
import re
import sys
import tempfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Any

try:
    import numpy as np
    import rasterio
    from rasterio import Affine
    from rasterio.windows import Window
except ImportError as exc:  # pragma: no cover - exercised through CLI in setup checks
    raise SystemExit(
        "CTX extraction requires the pinned development dependencies. Run "
        "python -m pip install -r requirements-dev.txt inside the project .venv."
    ) from exc


ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_MANIFEST = ROOT / "data/sources/ctx-jezero-dem.json"
DEFAULT_LABEL = ROOT / "test/fixtures/ctx_jezero_dem.xml"
PDS_NS = "{http://pds.nasa.gov/pds4/pds/v1}"
CART_NS = "{http://pds.nasa.gov/pds4/cart/v1}"
RAD = math.pi / 180.0
ACTIVE_MAX_CELLS = 250_000
CATALOG_VERSION = 2
DEFAULT_DOWNLOAD_PROVENANCE = ROOT / "data/sources/ctx-jezero-download.json"


class CtxMetadataError(ValueError):
    """Raised when the raster disagrees with its authoritative metadata."""


@dataclass(frozen=True)
class TileWindow:
    tile_row: int
    tile_col: int
    core_row_off: int
    core_col_off: int
    core_height: int
    core_width: int
    row_off: int
    col_off: int
    height: int
    width: int

    @property
    def tile_id(self) -> str:
        return f"ctx_r{self.tile_row:03d}_c{self.tile_col:03d}"

    def core_in_tile(self) -> dict[str, int]:
        return {
            "row_off": self.core_row_off - self.row_off,
            "col_off": self.core_col_off - self.col_off,
            "height": self.core_height,
            "width": self.core_width,
        }


def _require_close(actual: float, expected: float, name: str, *, abs_tol: float = 1e-6) -> None:
    if not math.isclose(float(actual), float(expected), rel_tol=1e-10, abs_tol=abs_tol):
        raise CtxMetadataError(f"{name} mismatch: raster has {actual!r}; metadata expects {expected!r}.")


def _text(parent: ET.Element, path: str) -> str:
    node = parent.find(path.replace("pds:", PDS_NS).replace("cart:", CART_NS))
    if node is None or node.text is None:
        raise CtxMetadataError(f"PDS4 label is missing required field {path}.")
    return node.text.strip()


def read_pds4_reference(label_path: pathlib.Path) -> dict[str, Any]:
    try:
        root = ET.parse(label_path).getroot()
    except (ET.ParseError, OSError) as exc:
        raise CtxMetadataError(f"Could not read PDS4 label {label_path}: {exc}") from exc

    array = root.find(f".//{PDS_NS}Array_3D_Image")
    if array is None:
        raise CtxMetadataError("PDS4 label has no Array_3D_Image.")
    axes = {}
    for axis in array.findall(f"{PDS_NS}Axis_Array"):
        axes[_text(axis, "pds:axis_name")] = int(_text(axis, "pds:elements"))
    try:
        missing = float(_text(array, ".//pds:missing_constant"))
    except ValueError as exc:
        raise CtxMetadataError("PDS4 missing_constant is not numeric.") from exc

    cart = root.find(f".//{CART_NS}Cartography")
    if cart is None:
        raise CtxMetadataError("PDS4 label has no Cartography object.")
    proj = cart.find(f".//{CART_NS}Equirectangular")
    coordinate_rep = cart.find(f".//{CART_NS}Coordinate_Representation")
    geo = cart.find(f".//{CART_NS}Geo_Transformation")
    geodetic = cart.find(f".//{CART_NS}Geodetic_Model")
    if proj is None or coordinate_rep is None or geo is None or geodetic is None:
        raise CtxMetadataError("PDS4 label is missing projection, geotransform, or geodetic model fields.")

    def cnum(parent: ET.Element, tag: str) -> float:
        return float(_text(parent, f"cart:{tag}"))

    bounds = cart.find(f".//{CART_NS}Bounding_Coordinates")
    if bounds is None:
        raise CtxMetadataError("PDS4 label has no geographic bounding coordinates.")
    return {
        "dataset_id": _text(root, ".//pds:logical_identifier"),
        "width": axes.get("Sample"),
        "height": axes.get("Line"),
        "bands": axes.get("Band"),
        "data_type": _text(array, ".//pds:data_type"),
        "nodata": missing,
        "resolution_x": cnum(coordinate_rep, "pixel_resolution_x"),
        "resolution_y": cnum(coordinate_rep, "pixel_resolution_y"),
        "pixel_registration": "upper-left outer corner",
        "transform": (
            cnum(geo, "upperleft_corner_x"),
            cnum(coordinate_rep, "pixel_resolution_x"),
            0.0,
            cnum(geo, "upperleft_corner_y"),
            0.0,
            -cnum(coordinate_rep, "pixel_resolution_y"),
        ),
        "projection": {
            "name": _text(cart, ".//cart:map_projection_name"),
            "standard_parallel": cnum(proj, "standard_parallel_1"),
            "latitude_of_projection_origin": cnum(proj, "latitude_of_projection_origin"),
            "longitude_of_central_meridian": cnum(proj, "longitude_of_central_meridian"),
            "radius": cnum(geodetic, "a_axis_radius"),
            "latitude_type": _text(geodetic, "cart:latitude_type"),
            "longitude_direction": _text(geodetic, "cart:longitude_direction"),
        },
        "coverage": {
            "west": cnum(bounds, "west_bounding_coordinate"),
            "east": cnum(bounds, "east_bounding_coordinate"),
            "north": cnum(bounds, "north_bounding_coordinate"),
            "south": cnum(bounds, "south_bounding_coordinate"),
        },
    }


def verify_manifest_against_label(manifest: dict[str, Any], label: dict[str, Any]) -> None:
    raster = manifest["source_raster"]
    spatial = manifest["spatial"]
    projection = spatial["projection"]
    exact_pairs = [
        (manifest["dataset_id"], label["dataset_id"], "dataset identifier"),
        (raster["width_samples"], label["width"], "sample count"),
        (raster["height_lines"], label["height"], "line count"),
        (raster["bands"], label["bands"], "band count"),
        (raster["data_type"], label["data_type"], "PDS4 data type"),
        (raster["nodata"]["value"], label["nodata"], "no-data value"),
        (spatial["pixel_registration"].split(",", 1)[0], label["pixel_registration"], "pixel registration"),
        (projection["name"], label["projection"]["name"], "projection name"),
        (projection["latitude_type"], label["projection"]["latitude_type"], "latitude type"),
        (projection["longitude_direction"], label["projection"]["longitude_direction"], "longitude direction"),
    ]
    for actual, expected, field in exact_pairs:
        if actual != expected:
            raise CtxMetadataError(f"Normalized manifest {field} differs from the official PDS4 label.")

    numeric_pairs = [
        (spatial["resolution_x_m_per_pixel"], label["resolution_x"], "x pixel resolution"),
        (spatial["resolution_y_m_per_pixel"], label["resolution_y"], "y pixel resolution"),
        (projection["standard_parallel_deg"], label["projection"]["standard_parallel"], "standard parallel"),
        (projection["latitude_of_projection_origin_deg"], label["projection"]["latitude_of_projection_origin"], "projection-origin latitude"),
        (projection["longitude_of_central_meridian_deg"], label["projection"]["longitude_of_central_meridian"], "central meridian"),
        (projection["planetary_radius_m"], label["projection"]["radius"], "planetary radius"),
    ]
    for actual, expected, field in numeric_pairs:
        _require_close(actual, expected, f"Manifest {field}")
    for key, value in label["coverage"].items():
        _require_close(spatial["coverage_deg"][key], value, f"Manifest {key} coverage", abs_tol=1e-9)
    if len(spatial["geotransform_gdal_order"]) != 6 or len(label["transform"]) != 6:
        raise CtxMetadataError("The normalized manifest and PDS4 label must each specify six geotransform values.")
    for actual, expected in zip(spatial["geotransform_gdal_order"], label["transform"]):
        _require_close(actual, expected, "Manifest geotransform")


def _projection_parameters(crs: Any) -> dict[str, Any]:
    if crs is None:
        raise CtxMetadataError("GeoTIFF has no coordinate reference system.")
    if not crs.is_projected:
        raise CtxMetadataError(f"GeoTIFF CRS is not projected: {crs!s}")
    try:
        params = crs.to_dict()
    except Exception as exc:
        raise CtxMetadataError(f"Could not inspect GeoTIFF projection parameters: {exc}") from exc
    if params.get("proj", "").lower() not in {"eqc", "equirectangular"}:
        raise CtxMetadataError(f"GeoTIFF projection is not equirectangular: {params!r}")
    if params.get("units") not in {"m", "metre", "meter"}:
        raise CtxMetadataError(f"GeoTIFF projected coordinate units are not metres: {params.get('units')!r}")
    radius = params.get("R")
    if radius is None:
        a, b = params.get("a"), params.get("b")
        if a is not None and (b is None or math.isclose(float(a), float(b), abs_tol=1e-6)):
            radius = a
    if radius is None:
        # Some GDAL CRS exports preserve the sphere only in WKT.
        wkt = crs.to_wkt()
        match = re.search(r"SPHEROID\[[^,]+,\s*([0-9.eE+-]+)", wkt)
        if match:
            radius = float(match.group(1))
    if radius is None:
        raise CtxMetadataError("Could not determine the planetary radius from the GeoTIFF CRS.")
    return {**params, "radius": float(radius)}


def inspect_and_validate_source(dataset: Any, manifest: dict[str, Any], pds: dict[str, Any]) -> dict[str, Any]:
    verify_manifest_against_label(manifest, pds)
    raster = manifest["source_raster"]
    spatial = manifest["spatial"]
    projection = spatial["projection"]
    if dataset.width != raster["width_samples"] or dataset.height != raster["height_lines"]:
        raise CtxMetadataError(
            f"GeoTIFF dimensions are {dataset.width} × {dataset.height}; PDS4/manifest expect "
            f"{raster['width_samples']} × {raster['height_lines']}."
        )
    if dataset.count != raster["bands"]:
        raise CtxMetadataError(f"GeoTIFF has {dataset.count} bands; expected {raster['bands']}.")
    if dataset.dtypes != ("float32",):
        raise CtxMetadataError(f"GeoTIFF data type is {dataset.dtypes!r}; expected one Float32 band.")
    with pathlib.Path(dataset.name).open("rb") as source_file:
        if source_file.read(2) != b"II":
            raise CtxMetadataError("GeoTIFF byte order is not little-endian as declared by PDS4.")
    if dataset.nodata is None or not math.isclose(dataset.nodata, raster["nodata"]["value"], rel_tol=1e-7):
        raise CtxMetadataError(f"GeoTIFF no-data {dataset.nodata!r} differs from the PDS4 missing constant.")

    transform = dataset.transform
    actual_transform = (transform.c, transform.a, transform.b, transform.f, transform.d, transform.e)
    expected_transform = spatial["geotransform_gdal_order"]
    for name, actual, expected in zip(("origin x", "pixel width", "rotation x", "origin y", "rotation y", "pixel height"), actual_transform, expected_transform):
        _require_close(actual, expected, f"GeoTIFF {name}")
    if not math.isclose(abs(transform.a), spatial["resolution_x_m_per_pixel"], abs_tol=1e-6):
        raise CtxMetadataError("GeoTIFF x pixel spacing disagrees with the PDS4 label.")
    if not math.isclose(abs(transform.e), spatial["resolution_y_m_per_pixel"], abs_tol=1e-6):
        raise CtxMetadataError("GeoTIFF y pixel spacing disagrees with the PDS4 label.")

    params = _projection_parameters(dataset.crs)
    for key, expected in (("lat_0", projection["latitude_of_projection_origin_deg"]),
                          ("lat_ts", projection["standard_parallel_deg"]),
                          ("lon_0", projection["longitude_of_central_meridian_deg"])):
        if key not in params:
            raise CtxMetadataError(f"GeoTIFF CRS does not expose {key}; cannot verify the PDS4 projection.")
        _require_close(params[key], expected, f"GeoTIFF projection {key}")
    _require_close(params["radius"], projection["planetary_radius_m"], "GeoTIFF planetary radius")
    wkt_upper = dataset.crs.to_wkt().upper()
    if not re.search(r'AXIS\s*\[\s*"?EASTING"?\s*,\s*EAST', wkt_upper):
        raise CtxMetadataError("GeoTIFF projected x-axis is not explicitly east-positive.")
    actual_coverage = _geo_bounds(transform, dataset.width, dataset.height, projection)
    for direction, value in actual_coverage.items():
        _require_close(value, spatial["coverage_deg"][direction], f"GeoTIFF {direction} geographic bound", abs_tol=1e-6)

    scales, offsets = tuple(dataset.scales), tuple(dataset.offsets)
    if scales and not math.isclose(scales[0], 1.0, abs_tol=1e-12):
        raise CtxMetadataError(f"GeoTIFF scale {scales[0]} is not identity; PDS4 label gives no scale.")
    if offsets and not math.isclose(offsets[0], 0.0, abs_tol=1e-12):
        raise CtxMetadataError(f"GeoTIFF offset {offsets[0]} is not zero; PDS4 label gives no offset.")
    return {
        "width": dataset.width,
        "height": dataset.height,
        "bands": dataset.count,
        "dtypes": list(dataset.dtypes),
        "byte_order": "little-endian",
        "nodata": dataset.nodata,
        "scales": list(scales),
        "offsets": list(offsets),
        "transform_gdal_order": list(actual_transform),
        "crs_wkt": dataset.crs.to_wkt(),
        "crs_proj_parameters": params,
        "pixel_size_m": [abs(transform.a), abs(transform.e)],
        "bounds_projected": [dataset.bounds.left, dataset.bounds.bottom, dataset.bounds.right, dataset.bounds.top],
    }


def derive_core_side(max_cells: int, halo: int) -> int:
    if max_cells < 1:
        raise ValueError("max-cells must be positive.")
    if halo < 0:
        raise ValueError("halo cannot be negative.")
    output_side = math.isqrt(max_cells)
    core_side = output_side - 2 * halo
    if core_side < 1:
        raise ValueError("Cell budget is too small for the requested halo width.")
    return core_side


def build_windows(width: int, height: int, max_cells: int, halo: int) -> tuple[list[TileWindow], int, int, int]:
    if max_cells > ACTIVE_MAX_CELLS:
        raise ValueError(f"max-cells cannot exceed the active terrain limit of {ACTIVE_MAX_CELLS:,} cells.")
    core_side = derive_core_side(max_cells, halo)
    ncols = math.ceil(width / core_side)
    nrows = math.ceil(height / core_side)
    result = []
    for tile_row in range(nrows):
        core_row = tile_row * core_side
        core_height = min(core_side, height - core_row)
        for tile_col in range(ncols):
            core_col = tile_col * core_side
            core_width = min(core_side, width - core_col)
            row_off = max(0, core_row - halo)
            col_off = max(0, core_col - halo)
            row_end = min(height, core_row + core_height + halo)
            col_end = min(width, core_col + core_width + halo)
            window = TileWindow(tile_row, tile_col, core_row, core_col, core_height, core_width,
                                row_off, col_off, row_end - row_off, col_end - col_off)
            if window.width * window.height > max_cells:
                raise ValueError(f"Derived tile {window.tile_id} exceeds the {max_cells}-cell budget.")
            result.append(window)
    return result, nrows, ncols, core_side


def select_windows(windows: list[TileWindow], nrows: int, ncols: int,
                   tile_rows: tuple[int, int] | None = None,
                   tile_cols: tuple[int, int] | None = None) -> list[TileWindow]:
    row_range = tile_rows or (0, nrows)
    col_range = tile_cols or (0, ncols)
    if not (0 <= row_range[0] < row_range[1] <= nrows):
        raise ValueError(f"tile-rows must be a non-empty half-open range within 0..{nrows}.")
    if not (0 <= col_range[0] < col_range[1] <= ncols):
        raise ValueError(f"tile-cols must be a non-empty half-open range within 0..{ncols}.")
    return [w for w in windows if row_range[0] <= w.tile_row < row_range[1]
            and col_range[0] <= w.tile_col < col_range[1]]


def _neighbors(window: TileWindow, nrows: int, ncols: int, selected_ids: set[str]) -> dict[str, str | None]:
    coords = {"north": (window.tile_row - 1, window.tile_col),
              "south": (window.tile_row + 1, window.tile_col),
              "west": (window.tile_row, window.tile_col - 1),
              "east": (window.tile_row, window.tile_col + 1)}
    result = {}
    for direction, (row, col) in coords.items():
        neighbor = f"ctx_r{row:03d}_c{col:03d}" if 0 <= row < nrows and 0 <= col < ncols else None
        result[direction] = neighbor if neighbor in selected_ids else None
    return result


def _geo_bounds(transform: Any, width: int, height: int, projection: dict[str, Any]) -> dict[str, float]:
    points = [transform @ (0, 0), transform @ (width, 0), transform @ (0, height), transform @ (width, height)]
    radius = projection["planetary_radius_m"]
    lat_origin = projection["latitude_of_projection_origin_deg"]
    lon_origin = projection["longitude_of_central_meridian_deg"]
    parallel = projection["standard_parallel_deg"]
    cos_parallel = math.cos(parallel * RAD)
    coords = [(lat_origin + y / radius / RAD, lon_origin + x / (radius * cos_parallel) / RAD) for x, y in points]
    return {"west": min(lon for _, lon in coords), "east": max(lon for _, lon in coords),
            "south": min(lat for lat, _ in coords), "north": max(lat for lat, _ in coords)}


def _catalog_source_crs(manifest: dict[str, Any], observed: dict[str, Any]) -> dict[str, Any]:
    projection = manifest["spatial"]["projection"]
    match = re.match(r'^(?:PROJCS|PROJCRS)\s*\[\s*"([^"]+)"', observed["crs_wkt"], re.I)
    if not match:
        raise CtxMetadataError("Could not read a projected CRS name from the verified GeoTIFF WKT.")
    return {
        "crs_name": match.group(1),
        "wkt": observed["crs_wkt"],
        "projection_method": projection["name"],
        "planetary_body": "Mars",
        "projection": projection,
        "vertical_reference": {
            **manifest["vertical"],
            "vertical_accuracy_m": None,
            "vertical_accuracy_status": "unknown; no numeric vertical accuracy is published in the inspected metadata",
        },
        "pixel_registration": manifest["spatial"]["pixel_registration"],
        "source_geotransform_gdal_order": observed["transform_gdal_order"],
        "raster_dimensions": {"width": observed["width"], "height": observed["height"]},
        "native_posting_m": observed["pixel_size_m"],
        "verified_properties": ["GeoTIFF embedded CRS", "PDS4 projection and geotransform", "PDS4 raster dimensions and pixel resolution"],
        "unknown_properties": ["complete-mosaic vertical datum/reference surface", "numeric vertical accuracy"],
    }


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _preflight_outputs(output_dir: pathlib.Path, windows: list[TileWindow], overwrite: bool) -> list[pathlib.Path]:
    targets = [output_dir / f"{w.tile_id}.{ext}" for w in windows for ext in ("f32", "json")]
    targets.append(output_dir / "catalog.json")
    existing = [path for path in targets if path.exists()]
    if existing and not overwrite:
        names = ", ".join(path.name for path in existing[:5])
        suffix = " …" if len(existing) > 5 else ""
        raise FileExistsError(f"Refusing to overwrite existing outputs: {names}{suffix}. Pass --overwrite to replace them.")
    return targets


def verify_core_partition(windows: list[TileWindow], source_width: int, source_height: int,
                          full_grid_rows: int, full_grid_cols: int) -> dict[str, Any]:
    area = sum(window.core_width * window.core_height for window in windows)
    for index, first in enumerate(windows):
        for second in windows[index + 1:]:
            row_overlap = max(first.core_row_off, second.core_row_off) < min(
                first.core_row_off + first.core_height, second.core_row_off + second.core_height)
            col_overlap = max(first.core_col_off, second.core_col_off) < min(
                first.core_col_off + first.core_width, second.core_col_off + second.core_width)
            if row_overlap and col_overlap:
                raise ValueError(f"Core windows overlap: {first.tile_id} and {second.tile_id}.")
    complete = len(windows) == full_grid_rows * full_grid_cols
    if complete and area != source_width * source_height:
        raise ValueError("The complete core tiling does not cover every source pixel exactly once.")
    return {"core_pixels_expected": area, "core_pixels_unique": area,
            "complete_source_coverage": complete,
            "verified_by": "pairwise non-overlap check; complete-grid area equals source pixel count"}


def extract_tiles(source_path: pathlib.Path, output_dir: pathlib.Path, manifest: dict[str, Any],
                  pds: dict[str, Any], *, max_cells: int = 250_000, halo: int = 1,
                  tile_rows: tuple[int, int] | None = None, tile_cols: tuple[int, int] | None = None,
                  overwrite: bool = False) -> dict[str, Any]:
    source_path = pathlib.Path(source_path)
    output_dir = pathlib.Path(output_dir)
    with rasterio.open(source_path) as src:
        observed = inspect_and_validate_source(src, manifest, pds)
        all_windows, nrows, ncols, core_side = build_windows(src.width, src.height, max_cells, halo)
        windows = select_windows(all_windows, nrows, ncols, tile_rows, tile_cols)
        partition = verify_core_partition(windows, src.width, src.height, nrows, ncols)
        _preflight_outputs(output_dir, windows, overwrite)
        source_hash = sha256_file(source_path)
        projection = manifest["spatial"]["projection"]
        source_crs = _catalog_source_crs(manifest, observed)
        selected_ids = {window.tile_id for window in windows}
        tile_records = []

        output_dir.mkdir(parents=True, exist_ok=True)
        for tile in windows:
            read_window = Window(tile.col_off, tile.row_off, tile.width, tile.height)
            values = src.read(1, window=read_window, out_dtype="float32")
            invalid = ~np.isfinite(values)
            if src.nodata is not None:
                invalid |= values == np.float32(src.nodata)
            values[invalid] = np.nan
            values = np.asarray(values, dtype="<f4", order="C")

            tile_transform = src.transform @ Affine.translation(tile.col_off, tile.row_off)
            transform_gdal = [tile_transform.c, tile_transform.a, tile_transform.b,
                              tile_transform.f, tile_transform.d, tile_transform.e]
            f32_path = output_dir / f"{tile.tile_id}.f32"
            sidecar_path = output_dir / f"{tile.tile_id}.json"
            values.tofile(f32_path)
            binary_sha = sha256_file(f32_path)
            meta = {
                "format": "mars-survival-ctx-f32-tile",
                "version": 1,
                "catalog_version": CATALOG_VERSION,
                "catalog_source_crs": source_crs,
                "tile_id": tile.tile_id,
                "dataset_id": manifest["dataset_id"],
                "source_raster": {
                    "filename": source_path.name,
                    "size_bytes": source_path.stat().st_size,
                    "sha256": source_hash,
                    "pds4_label_url": manifest["source_metadata_url"],
                    "source_geotransform_gdal_order": observed["transform_gdal_order"],
                    "source_crs_wkt": observed["crs_wkt"],
                },
                "source_window": {"row_off": tile.row_off, "col_off": tile.col_off,
                                  "height": tile.height, "width": tile.width,
                                  "indexing": "zero-based half-open offsets [offset, offset + size)"},
                "core_window": {"row_off": tile.core_row_off, "col_off": tile.core_col_off,
                                 "height": tile.core_height, "width": tile.core_width,
                                 "indexing": "zero-based half-open offsets [offset, offset + size)"},
                "core_window_in_tile": tile.core_in_tile(),
                "width": tile.width,
                "height": tile.height,
                "data": {"filename": f32_path.name, "dtype": "float32", "byte_order": "little-endian",
                         "layout": "row-major", "units": "m", "expected_bytes": tile.width * tile.height * 4,
                         "sha256": binary_sha, "nodata_source_value": manifest["source_raster"]["nodata"]["value"],
                         "nodata_output_value": "IEEE-754 NaN"},
                "georeference": {
                    "transform_gdal_order": transform_gdal,
                    "crs_wkt": observed["crs_wkt"],
                    "projection": projection,
                    "pixel_registration": "upper-left outer corner",
                    "pixel_size_m": [abs(tile_transform.a), abs(tile_transform.e)],
                    "projected_bounds_m": [tile_transform.c,
                        tile_transform.f + tile.height * tile_transform.e,
                        tile_transform.c + tile.width * tile_transform.a,
                        tile_transform.f],
                    "coverage_planetocentric_east_positive_deg": _geo_bounds(tile_transform, tile.width, tile.height, projection),
                },
                "vertical_reference": manifest["vertical"],
                "processing_history": [
                    "Read this raster window from the source GeoTIFF; the full raster was not loaded as an array.",
                    "Preserved valid samples as Float32 and converted the declared source no-data sentinel and non-finite values to IEEE-754 NaN.",
                    f"Extracted source core window with {halo}-cell halo clipped at raster boundaries.",
                    "Wrote row-major little-endian Float32 metres; no interpolation or elevation merging was performed.",
                ],
                "neighbors": _neighbors(tile, nrows, ncols, selected_ids),
            }
            sidecar_path.write_text(json.dumps(meta, indent=2, allow_nan=False) + "\n", encoding="utf-8")
            tile_records.append({
                "tile_id": tile.tile_id,
                "metadata_file": sidecar_path.name,
                "data_file": f32_path.name,
                "source_window": meta["source_window"],
                "core_window": meta["core_window"],
                "width": tile.width,
                "height": tile.height,
                "projected_coverage_m": meta["georeference"]["projected_bounds_m"],
                "geographic_coverage_deg": meta["georeference"]["coverage_planetocentric_east_positive_deg"],
                "neighbors": meta["neighbors"],
            })

        catalog = {
            "format": "mars-survival-ctx-tile-catalog",
            "version": CATALOG_VERSION,
            "dataset_id": manifest["dataset_id"],
            "source_raster": {"filename": source_path.name, "size_bytes": source_path.stat().st_size,
                              "sha256": source_hash, "metadata_url": manifest["source_metadata_url"]},
            "source_grid": {"width": src.width, "height": src.height,
                            "transform_gdal_order": observed["transform_gdal_order"]},
            "source_crs": source_crs,
            "tiling": {"maximum_cells": max_cells, "halo_cells": halo,
                       "maximum_core_width": core_side, "maximum_core_height": core_side,
                       "full_grid_rows": nrows, "full_grid_columns": ncols,
                       "selected_tile_rows_half_open": list(tile_rows or (0, nrows)),
                       "selected_tile_columns_half_open": list(tile_cols or (0, ncols)),
                       "is_partial_selection": len(windows) != len(all_windows)},
            "coverage_verification": partition,
            "tiles": tile_records,
        }
        catalog_path = output_dir / "catalog.json"
        catalog_path.write_text(json.dumps(catalog, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        return catalog


def refresh_metadata_only(source_path: pathlib.Path, output_dir: pathlib.Path, manifest: dict[str, Any],
                          pds: dict[str, Any], expected_source_sha256: str) -> dict[str, Any]:
    """Upgrade catalog/sidecars without writing elevation binaries.

    The expected hash must come from the separately retained download provenance.
    Existing catalog ownership and every sidecar/binary checksum are verified before
    any metadata file is replaced. Temporary files are written beside their targets;
    catalog.json is replaced last so it remains the contract commit point.
    """
    source_path, output_dir = pathlib.Path(source_path), pathlib.Path(output_dir)
    actual_source_hash = sha256_file(source_path)
    if not re.fullmatch(r"[a-fA-F0-9]{64}", str(expected_source_sha256)) or actual_source_hash.lower() != expected_source_sha256.lower():
        raise CtxMetadataError("Raw source GeoTIFF SHA-256 does not match the expected download provenance.")
    catalog_path = output_dir / "catalog.json"
    if not catalog_path.is_file() or catalog_path.is_symlink():
        raise FileNotFoundError("Metadata refresh requires an existing regular catalog.json.")
    old_catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    if old_catalog.get("dataset_id") != manifest["dataset_id"]:
        raise CtxMetadataError("Existing catalog belongs to a different dataset.")
    if old_catalog.get("source_raster", {}).get("sha256") != actual_source_hash:
        raise CtxMetadataError("Existing catalog source checksum differs from the verified raw GeoTIFF.")
    tiling = old_catalog.get("tiling", {})
    max_cells, halo = tiling.get("maximum_cells"), tiling.get("halo_cells")
    if not isinstance(max_cells, int) or not isinstance(halo, int):
        raise CtxMetadataError("Existing catalog is missing valid tiling settings.")

    with rasterio.open(source_path) as src:
        observed = inspect_and_validate_source(src, manifest, pds)
        if old_catalog.get("source_grid", {}).get("width") != src.width or old_catalog.get("source_grid", {}).get("height") != src.height:
            raise CtxMetadataError("Existing catalog raster dimensions differ from the verified source.")
        for actual, expected in zip(old_catalog.get("source_grid", {}).get("transform_gdal_order", []), observed["transform_gdal_order"]):
            _require_close(actual, expected, "Existing catalog source geotransform")
        all_windows, nrows, ncols, _ = build_windows(src.width, src.height, max_cells, halo)
    row_range = tiling.get("selected_tile_rows_half_open", [0, nrows])
    col_range = tiling.get("selected_tile_columns_half_open", [0, ncols])
    windows = select_windows(all_windows, nrows, ncols, tuple(row_range), tuple(col_range))
    if len(old_catalog.get("tiles", [])) != len(windows):
        raise CtxMetadataError("Existing tile count differs from the source grid selection; refusing metadata refresh.")
    verify_core_partition(windows, observed["width"], observed["height"], nrows, ncols)
    by_id = {record.get("tile_id"): record for record in old_catalog["tiles"]}
    if len(by_id) != len(windows) or set(by_id) != {window.tile_id for window in windows}:
        raise CtxMetadataError("Existing tile identifiers do not match the selected source grid.")

    metadata_updates: list[tuple[pathlib.Path, str]] = []
    refreshed_records = []
    for window in windows:
        record = by_id[window.tile_id]
        expected_source = {"row_off": window.row_off, "col_off": window.col_off, "height": window.height, "width": window.width}
        expected_core = {"row_off": window.core_row_off, "col_off": window.core_col_off, "height": window.core_height, "width": window.core_width}
        source_window_record = {key: record.get("source_window", {}).get(key) for key in expected_source}
        core_window_record = {key: record.get("core_window", {}).get(key) for key in expected_core}
        if source_window_record != expected_source or core_window_record != expected_core:
            raise CtxMetadataError(f"Existing core/extraction windows changed for {window.tile_id}; refusing metadata refresh.")
        if record.get("data_file") != f"{window.tile_id}.f32" or record.get("metadata_file") != f"{window.tile_id}.json":
            raise CtxMetadataError(f"Existing filenames are unrelated or invalid for {window.tile_id}.")
        sidecar_path = output_dir / record["metadata_file"]
        binary_path = output_dir / record["data_file"]
        if not sidecar_path.is_file() or sidecar_path.is_symlink() or not binary_path.is_file() or binary_path.is_symlink():
            raise CtxMetadataError(f"Expected regular tile sidecar and binary are missing for {window.tile_id}.")
        metadata = json.loads(sidecar_path.read_text(encoding="utf-8"))
        data = metadata.get("data", {})
        expected_bytes = window.width * window.height * 4
        if data.get("filename") != record["data_file"] or data.get("expected_bytes") != expected_bytes or binary_path.stat().st_size != expected_bytes:
            raise CtxMetadataError(f"Existing binary size/identity is invalid for {window.tile_id}.")
        actual_binary_hash = sha256_file(binary_path)
        if not re.fullmatch(r"[a-fA-F0-9]{64}", str(data.get("sha256", ""))) or actual_binary_hash.lower() != data["sha256"].lower():
            raise CtxMetadataError(f"Existing binary SHA-256 mismatch for {window.tile_id}; refusing metadata refresh.")
        if metadata.get("tile_id") != window.tile_id or metadata.get("dataset_id") != manifest["dataset_id"] or metadata.get("source_raster", {}).get("sha256") != actual_source_hash:
            raise CtxMetadataError(f"Existing sidecar identity/source provenance is invalid for {window.tile_id}.")
        if metadata.get("source_window", {}) != {**expected_source, "indexing": "zero-based half-open offsets [offset, offset + size)"} or \
                metadata.get("core_window", {}) != {**expected_core, "indexing": "zero-based half-open offsets [offset, offset + size)"}:
            raise CtxMetadataError(f"Existing sidecar windows disagree with catalog for {window.tile_id}.")
        expected_tile_transform = [observed["transform_gdal_order"][0] + window.col_off * observed["transform_gdal_order"][1],
            observed["transform_gdal_order"][1], observed["transform_gdal_order"][2],
            observed["transform_gdal_order"][3] + window.row_off * observed["transform_gdal_order"][5],
            observed["transform_gdal_order"][4], observed["transform_gdal_order"][5]]
        geo = metadata.get("georeference", {})
        if len(geo.get("transform_gdal_order", [])) != 6 or any(not math.isclose(a, b, rel_tol=1e-10, abs_tol=1e-6)
                                                                  for a, b in zip(geo["transform_gdal_order"], expected_tile_transform)):
            raise CtxMetadataError(f"Existing tile geotransform is invalid for {window.tile_id}.")
        if geo.get("crs_wkt") != observed["crs_wkt"] or geo.get("projection") != manifest["spatial"]["projection"]:
            raise CtxMetadataError(f"Existing sidecar projection metadata disagrees with verified source for {window.tile_id}.")
        metadata["catalog_version"] = CATALOG_VERSION
        metadata["catalog_source_crs"] = _catalog_source_crs(manifest, observed)
        serialized = json.dumps(metadata, indent=2, allow_nan=False) + "\n"
        metadata_updates.append((sidecar_path, serialized))
        refreshed_records.append(record)

    source_crs = _catalog_source_crs(manifest, observed)
    updated_catalog = dict(old_catalog)
    updated_catalog["version"] = CATALOG_VERSION
    updated_catalog["source_raster"] = {**old_catalog["source_raster"], "filename": source_path.name,
        "size_bytes": source_path.stat().st_size, "sha256": actual_source_hash, "metadata_url": manifest["source_metadata_url"]}
    updated_catalog["source_grid"] = {"width": observed["width"], "height": observed["height"],
        "transform_gdal_order": observed["transform_gdal_order"]}
    updated_catalog["source_crs"] = source_crs
    updated_catalog["tiles"] = refreshed_records
    catalog_text = json.dumps(updated_catalog, indent=2, allow_nan=False) + "\n"

    staged: list[tuple[pathlib.Path, pathlib.Path]] = []
    try:
        for target, content in [*metadata_updates, (catalog_path, catalog_text)]:
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="\n", dir=output_dir,
                                             prefix=".ctx-metadata-", suffix=".tmp", delete=False) as tmp:
                tmp.write(content)
                staged.append((pathlib.Path(tmp.name), target))
        for temporary, target in staged[:-1]:
            os.replace(temporary, target)
        os.replace(staged[-1][0], staged[-1][1])
    finally:
        for temporary, _ in staged:
            if temporary.exists():
                temporary.unlink()
    return updated_catalog


def inspect_source(source_path: pathlib.Path, manifest_path: pathlib.Path, label_path: pathlib.Path) -> dict[str, Any]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    pds = read_pds4_reference(label_path)
    with rasterio.open(source_path) as src:
        observed = inspect_and_validate_source(src, manifest, pds)
    return {"source": str(source_path), "manifest": str(manifest_path), "label": str(label_path),
            "verified_metadata": observed, "full_array_loaded": False}


def parse_pair(values: list[int] | None, flag: str) -> tuple[int, int] | None:
    if values is None:
        return None
    if values[0] < 0 or values[1] <= values[0]:
        raise ValueError(f"{flag} must be a non-empty non-negative half-open range.")
    return values[0], values[1]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=pathlib.Path, required=True, help="Source GeoTIFF path.")
    parser.add_argument("--output-dir", type=pathlib.Path, required=True, help="Output directory for tile binaries, sidecars and catalog.")
    parser.add_argument("--manifest", type=pathlib.Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--label", type=pathlib.Path, default=DEFAULT_LABEL)
    parser.add_argument("--download-provenance", type=pathlib.Path, default=DEFAULT_DOWNLOAD_PROVENANCE,
                        help="Verified download record used to authenticate metadata-only refreshes.")
    parser.add_argument("--max-cells", type=int, default=250_000, help="Maximum cells per extracted tile, including halo.")
    parser.add_argument("--halo", type=int, default=1, help="Cells of context around interior core edges.")
    parser.add_argument("--tile-rows", nargs=2, type=int, metavar=("START", "STOP"), help="Optional half-open output tile-row range.")
    parser.add_argument("--tile-cols", nargs=2, type=int, metavar=("START", "STOP"), help="Optional half-open output tile-column range.")
    parser.add_argument("--dry-run", action="store_true", help="Validate and report metadata and tile plan without writing outputs.")
    parser.add_argument("--overwrite", action="store_true", help="Permit replacing generated files with matching output names.")
    parser.add_argument("--refresh-metadata", action="store_true",
                        help="Upgrade an existing CTX catalog/sidecars without rewriting .f32 elevation binaries.")
    args = parser.parse_args(argv)
    try:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        pds = read_pds4_reference(args.label)
        if args.refresh_metadata:
            if args.overwrite or args.dry_run or args.tile_rows or args.tile_cols:
                raise ValueError("--refresh-metadata cannot be combined with --overwrite, --dry-run, or tile selection flags.")
            provenance = json.loads(args.download_provenance.read_text(encoding="utf-8"))
            if provenance.get("dataset_id") != manifest["dataset_id"] or provenance.get("local_filename") != args.source.name:
                raise CtxMetadataError("Download provenance does not identify this source raster and dataset.")
            result = refresh_metadata_only(args.source, args.output_dir, manifest, pds, provenance.get("local_sha256", ""))
            print(json.dumps({"catalog": str(args.output_dir / "catalog.json"), "catalog_version": result["version"],
                              "metadata_files_refreshed": len(result["tiles"]) + 1,
                              "binary_files_modified": 0, "tile_count": len(result["tiles"])}, indent=2))
            return 0
        with rasterio.open(args.source) as src:
            observed = inspect_and_validate_source(src, manifest, pds)
            all_windows, nrows, ncols, core_side = build_windows(src.width, src.height, args.max_cells, args.halo)
            selected = select_windows(all_windows, nrows, ncols,
                                      parse_pair(args.tile_rows, "--tile-rows"),
                                      parse_pair(args.tile_cols, "--tile-cols"))
            report = {"verified_metadata": observed, "tile_rows": nrows, "tile_columns": ncols,
                      "total_tiles": len(all_windows), "selected_tiles": len(selected),
                      "core_shape_max": [core_side, core_side],
                      "tile_dimensions_max": [max(w.width for w in selected), max(w.height for w in selected)],
                      "core_pixels_selected": sum(w.core_width * w.core_height for w in selected),
                      "full_source_pixels": src.width * src.height}
        if args.dry_run:
            print(json.dumps(report, indent=2))
            return 0
        catalog = extract_tiles(args.source, args.output_dir, manifest, pds,
                                max_cells=args.max_cells, halo=args.halo,
                                tile_rows=parse_pair(args.tile_rows, "--tile-rows"),
                                tile_cols=parse_pair(args.tile_cols, "--tile-cols"),
                                overwrite=args.overwrite)
        report["catalog"] = str(args.output_dir / "catalog.json")
        report["generated_tiles"] = len(catalog["tiles"])
        report["core_pixels_unique"] = catalog["coverage_verification"]["core_pixels_unique"]
        print(json.dumps(report, indent=2))
        return 0
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        print(f"CTX tile extraction failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
