#!/usr/bin/env python3
"""Validate the real attached-label Jezero HiRISE DTM and derive a planner tile."""
import argparse
import hashlib
import json
import math
import pathlib
import re
import sys

import numpy as np


PRODUCT = "DTEEC_045994_1985_046060_1985_U01"
ORTHO_PRODUCT = "ESP_046060_1985_RED_C_01_ORTHO"


def value(label: str, key: str) -> str | None:
    match = re.search(rf"^\s*{re.escape(key)}\s*=\s*(.+?)\s*$", label, re.I | re.M)
    return match.group(1).split("/*", 1)[0].strip().strip('"') if match else None


def number(label: str, key: str) -> float | None:
    raw = value(label, key)
    if raw is None:
        return None
    match = re.match(r"[-+]?\d+(?:\.\d*)?(?:[Ee][-+]?\d+)?", raw)
    return float(match.group()) if match else None


def section(label: str, name: str) -> str:
    match = re.search(rf"OBJECT\s*=\s*{name}\b([\s\S]*?)END_OBJECT\s*=\s*{name}\b", label, re.I)
    if not match:
        raise ValueError(f"Associated ortho label has no {name} object.")
    return match.group(1)


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def pds_label(path: pathlib.Path) -> tuple[str, int]:
    with path.open("rb") as f:
        header = f.read(1_000_000)
    match = re.search(rb"(?im)^\s*END\s*(?:\r?\n|$)", header)
    if not match:
        raise ValueError("Attached PDS label END statement was not found in the first MB.")
    return header[:match.end()].decode("ascii", "strict"), match.end()


def convert(img_path: pathlib.Path, ortho_label_path: pathlib.Path, out_path: pathlib.Path,
            max_cells: int = 250_000) -> dict:
    img_label, label_bytes = pds_label(img_path)
    product = value(img_label, "PRODUCT_ID")
    if product != PRODUCT or img_path.stem.upper() != PRODUCT:
        raise ValueError(f"Expected attached PRODUCT_ID {PRODUCT}, found {product or 'missing'}.")
    rows, cols = int(number(img_label, "LINES") or 0), int(number(img_label, "LINE_SAMPLES") or 0)
    record_bytes, records = int(number(img_label, "RECORD_BYTES") or 0), int(number(img_label, "FILE_RECORDS") or 0)
    pointer = int(number(img_label, "^IMAGE") or 0)
    if not rows or not cols or record_bytes != cols * 4 or records != rows + pointer - 1:
        raise ValueError("PDS record structure does not match one 32-bit sample per raster cell and the attached label record.")
    if int(number(img_label, "SAMPLE_BITS") or 0) != 32 or (value(img_label, "SAMPLE_TYPE") or "").upper() != "PC_REAL":
        raise ValueError("Expected HiRISE SAMPLE_BITS=32 and SAMPLE_TYPE=PC_REAL (little-endian IEEE float32).")
    if number(img_label, "BANDS") != 1 or number(img_label, "OFFSET") != 0 or number(img_label, "SCALING_FACTOR") != 1:
        raise ValueError("Unexpected band count or elevation scaling in the attached DTM label.")
    if not re.search(r"Pixel values in this file represent elevations in\s+meters above the martian equipotential surface", img_label, re.I):
        raise ValueError("The attached label does not declare the supported elevation reference and units.")
    pointer_bytes = (pointer - 1) * record_bytes
    required_bytes = pointer_bytes + rows * record_bytes
    if img_path.stat().st_size != required_bytes:
        raise ValueError(f"IMG byte count {img_path.stat().st_size} does not equal the PDS record structure ({required_bytes}).")

    ortho = ortho_label_path.read_text(encoding="ascii", errors="strict")
    source_ids = re.search(r"SOURCE_PRODUCT_ID\s*=\s*\(([^)]*)\)", ortho, re.I | re.S)
    if value(ortho, "PRODUCT_ID") != ORTHO_PRODUCT or not source_ids or PRODUCT not in source_ids.group(1):
        raise ValueError("Associated ortho label does not identify this DTM as its source product.")
    proj = section(ortho, "IMAGE_MAP_PROJECTION")
    ortho_image = section(ortho, "IMAGE")
    if (value(proj, "MAP_PROJECTION_TYPE") or "").upper() != "EQUIRECTANGULAR":
        raise ValueError("Associated ortho does not declare EQUIRECTANGULAR projection.")
    if (value(proj, "COORDINATE_SYSTEM_NAME") or "").upper() != "PLANETOCENTRIC" or (value(proj, "POSITIVE_LONGITUDE_DIRECTION") or "").upper() != "EAST":
        raise ValueError("Associated ortho coordinate system is not east-positive planetocentric.")
    if int(number(ortho_image, "LINES") or 0) != rows or int(number(ortho_image, "LINE_SAMPLES") or 0) != cols:
        raise ValueError("Associated ortho dimensions differ from the DTM; cannot transfer its map geometry safely.")
    if source_ids.group(1).count(PRODUCT) != 1:
        raise ValueError("Associated ortho SOURCE_PRODUCT_ID must link to the DTM exactly once.")

    ppd = number(proj, "MAP_RESOLUTION")
    scale_m = number(proj, "MAP_SCALE")
    radius_km = number(proj, "A_AXIS_RADIUS")
    std_parallel = number(proj, "CENTER_LATITUDE")
    center_lon = number(proj, "CENTER_LONGITUDE")
    line_offset, sample_offset = number(proj, "LINE_PROJECTION_OFFSET"), number(proj, "SAMPLE_PROJECTION_OFFSET")
    min_lat, max_lat = number(proj, "MINIMUM_LATITUDE"), number(proj, "MAXIMUM_LATITUDE")
    min_lon, max_lon = number(proj, "WESTERNMOST_LONGITUDE"), number(proj, "EASTERNMOST_LONGITUDE")
    if any(x is None for x in (ppd, scale_m, radius_km, std_parallel, center_lon, line_offset, sample_offset, min_lat, max_lat, min_lon, max_lon)):
        raise ValueError("Associated ortho map label is missing scale, radius, projection offsets, or coverage.")
    radius_m = radius_km * 1000
    projected_m_per_px = radius_m * math.pi / (180 * ppd)
    if not math.isclose(projected_m_per_px, scale_m, rel_tol=1e-5):
        raise ValueError("MAP_SCALE conflicts with the associated label radius and MAP_RESOLUTION.")

    factor = max(1, math.ceil(math.sqrt(rows * cols / max_cells)))
    width, height = cols // factor, rows // factor
    if width < 3 or height < 3 or width * height > max_cells:
        raise ValueError("Planner-sized derivative dimensions are invalid.")
    raster = np.memmap(img_path, dtype="<f4", mode="r", offset=pointer_bytes, shape=(rows, cols))
    bit_view = raster.view(np.uint32)
    missing_match = re.fullmatch(r"16#([0-9A-Fa-f]{8})#", value(img_label, "MISSING_CONSTANT") or "")
    if not missing_match:
        raise ValueError("Attached PDS label has no supported 32-bit hexadecimal MISSING_CONSTANT.")
    missing_bits = np.uint32(int(missing_match.group(1), 16))
    elevation = np.full((height, width), np.nan, dtype=np.float32)
    threshold = math.ceil(factor * factor / 2)
    for out_row in range(height):
        block = np.asarray(raster[out_row * factor:(out_row + 1) * factor, :width * factor], dtype=np.float64)
        bits = np.asarray(bit_view[out_row * factor:(out_row + 1) * factor, :width * factor])
        valid = (bits != missing_bits) & np.isfinite(block)
        grouped_valid = valid.reshape(factor, width, factor)
        count = grouped_valid.sum(axis=(0, 2))
        sums = np.where(valid, block, 0).reshape(factor, width, factor).sum(axis=(0, 2))
        good = count >= threshold
        elevation[out_row, good] = (sums[good] / count[good]).astype(np.float32)

    x_cell = projected_m_per_px * math.cos(math.radians(std_parallel)) * factor
    y_cell = projected_m_per_px * factor
    # The PDS map offsets locate the projection origin relative to pixel centres.
    origin_x = (0.5 - sample_offset) * projected_m_per_px * math.cos(math.radians(std_parallel))
    origin_y = (line_offset - 0.5) * projected_m_per_px
    retained_west = center_lon + origin_x / (radius_m * math.cos(math.radians(std_parallel))) * 180 / math.pi
    retained_east = retained_west + width * factor / ppd
    retained_north = (line_offset - 0.5) / ppd
    retained_south = retained_north - height * factor / ppd
    geo = {"type": "equirectangular", "radius_m": radius_m, "center_lat_deg": 0,
           "center_lon_deg": center_lon, "origin_x_m": origin_x, "origin_y_m": origin_y,
           "standard_parallel_deg": std_parallel, "min_lat_deg": retained_south,
           "max_lat_deg": retained_north, "min_lon_deg": retained_west,
           "max_lon_deg": retained_east, "planetocentric": True}

    # Offer a short, real-data sample only when a continuous observed segment is
    # available below the current 25° planner slope limit. Otherwise leave point
    # selection to the user rather than inventing target coordinates.
    default_route = None
    gradients_y = np.gradient(elevation.astype(np.float64), axis=0) / y_cell
    gradients_x = np.gradient(elevation.astype(np.float64), axis=1)
    row_lat = retained_north - (np.arange(height) + 0.5) * factor / ppd
    ground_dx = x_cell * np.cos(np.radians(row_lat)) / math.cos(math.radians(std_parallel))
    slope = np.degrees(np.arctan(np.hypot(gradients_x / ground_dx[:, None], gradients_y)))
    segment = min(12, max(2, width // 4))
    best = None
    for row in range(1, height - 1):
        eligible = np.isfinite(elevation[row]) & np.isfinite(slope[row]) & (slope[row] <= 25)
        for col in range(1, width - segment - 1):
            run = eligible[col:col + segment]
            if len(run) == segment and bool(np.all(run)):
                score = float(np.mean(slope[row, col:col + segment]))
                if best is None or score < best[0]:
                    best = (score, row, col)
    if best:
        _, row, col = best
        default_route = {"start": {"x_m": (col + 0.5) * x_cell, "y_m": (row + 0.5) * y_cell},
                         "destination": {"x_m": (col + segment - 0.5) * x_cell, "y_m": (row + 0.5) * y_cell}}

    valid = elevation[np.isfinite(elevation)]
    if valid.size == 0:
        raise ValueError("Decoded DTM contains no valid terrain samples.")
    declared_min, declared_max = number(img_label, "VALID_MINIMUM"), number(img_label, "VALID_MAXIMUM")
    raw_valid_min, raw_valid_max = float(np.min(valid)), float(np.max(valid))
    # Validate the raw source samples (including valid pixels in cropped edge strips),
    # separately from the block-averaged planner values.
    source_valid_count = 0
    source_min, source_max = math.inf, -math.inf
    for row in range(0, rows, 256):
        values = np.asarray(raster[row:min(rows, row + 256), :], dtype=np.float32)
        bits = np.asarray(bit_view[row:min(rows, row + 256), :])
        good = (bits != missing_bits) & np.isfinite(values)
        if np.any(good):
            source_valid_count += int(good.sum())
            source_min = min(source_min, float(values[good].min()))
            source_max = max(source_max, float(values[good].max()))
    if source_min < declared_min - 0.05 or source_max > declared_max + 0.05:
        raise ValueError(f"Decoded source elevations {source_min:.2f}..{source_max:.2f} m exceed attached-label range {declared_min}..{declared_max} m.")

    source_hash = sha256(img_path)
    source = {"product_id": PRODUCT, "mission": value(img_label, "INSTRUMENT_HOST_NAME"),
              "instrument": value(img_label, "INSTRUMENT_NAME"),
              "sha256": source_hash,
              "url": "https://hirise.lpl.arizona.edu/dtm/ESP_045994_1985",
              "credit": "NASA/JPL-Caltech/University of Arizona",
              "processing": [
                  f"Parsed attached PDS3 label ({label_bytes} bytes), {rows} × {cols} IMAGE, one PC_REAL 32-bit little-endian band.",
                  f"Verified fixed {record_bytes}-byte records, ^IMAGE={pointer}, {records} records and exact {required_bytes}-byte file size.",
                  f"Decoded elevation metres above Mars 2000 equipotential surface; missing float bit pattern 0x{int(missing_bits):08X}; raw retained values fall within attached-label VALID_MINIMUM/MAXIMUM ({declared_min}..{declared_max} m).",
                  f"Transferred equirectangular planetocentric map geometry from matching {ORTHO_PRODUCT} label; its SOURCE_PRODUCT_ID names this DTM and IMAGE dimensions match exactly.",
                  f"Block-averaged {factor} × {factor} source pixels to {x_cell:.3f} m projected × {y_cell:.3f} m north-south cells ({x_cell * math.cos(math.radians(18.4)):.3f} m east-west ground spacing at 18.4°N). Blocks with fewer than half valid samples remain no-data.",
              ]}
    tile = {"format": "mars-survival-tile", "version": 1,
            "name": "Jezero HiRISE DTM — DTEEC_045994_1985_046060_1985_U01 (planner overview)",
            "kind": "derived-from-nasa", "width": width, "height": height,
            "cell_x_m": x_cell, "cell_y_m": y_cell, "elevation_unit": "m", "z_scale": 1,
            "z_offset": 0, "nodata": None,
            "z": [None if not math.isfinite(float(z)) else round(float(z), 2) for z in elevation.ravel()],
            "geo": geo, "source": source,
            "notes": ["Derived from the 1 m/pixel source DTM; this route-planner overview is about 20 m per cell and does not resolve metre-scale or sub-cell hazards.",
                      "Elevations are metres above the Mars 2000 equipotential surface (areoid), not radius.",
                      "The matching HiRISE ortho label supplies the equirectangular offsets because the attached DTM label itself contains no IMAGE_MAP_PROJECTION object."],
            "targets": [], "default_route": default_route}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(tile, separators=(",", ":")), encoding="utf-8")
    return {"product_id": PRODUCT, "source_bytes": img_path.stat().st_size,
            "sha256": source_hash,
            "source_width": cols, "source_height": rows, "label_bytes": label_bytes,
            "data_offset": pointer_bytes, "data_records": records - pointer + 1,
            "sample_type": value(img_label, "SAMPLE_TYPE"), "sample_bits": int(number(img_label, "SAMPLE_BITS")),
            "byte_order": "little-endian", "missing_bits": f"0x{int(missing_bits):08X}",
            "source_valid_range_m": [declared_min, declared_max],
            "source_sample_range_m": [source_min, source_max], "source_valid_samples": source_valid_count,
            "overview_valid_cells": int(valid.size), "overview_nodata_cells": int(elevation.size - valid.size),
            "projection": "EQUIRECTANGULAR", "coordinate_system": "PLANETOCENTRIC east-positive",
            "footprint": [retained_west, retained_south, retained_east, retained_north],
            "factor": factor, "width": width, "height": height,
            "cell_x_projected_m": x_cell, "cell_y_m": y_cell,
            "approx_ground_dx_at_18_4N_m": x_cell * math.cos(math.radians(18.4)),
            "source_valid": source_valid_count, "source_min_m": source_min, "source_max_m": source_max,
            "overview_valid": int(valid.size), "min_m": float(valid.min()), "max_m": float(valid.max()),
            "bytes": out_path.stat().st_size}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--img", type=pathlib.Path, required=True)
    parser.add_argument("--ortho-label", type=pathlib.Path, required=True)
    parser.add_argument("--out", type=pathlib.Path, required=True)
    parser.add_argument("--max-cells", type=int, default=250_000)
    args = parser.parse_args()
    try:
        print(json.dumps(convert(args.img, args.ortho_label, args.out, args.max_cells), indent=2))
    except (OSError, ValueError) as exc:
        print(f"HiRISE conversion failed: {exc}", file=sys.stderr)
        raise SystemExit(2)


if __name__ == "__main__":
    main()
