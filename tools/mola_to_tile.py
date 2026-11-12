#!/usr/bin/env python3
"""Convert the supplied MOLA MEGDR PDS3 IMG/LBL to a planner-sized terrain tile."""
import argparse
import json
import math
import pathlib
import re
import sys

import numpy as np


def value(label: str, key: str) -> str | None:
    match = re.search(rf"^\s*{re.escape(key)}\s*=\s*(.+?)\s*$", label, re.I | re.M)
    return match.group(1).split("/*", 1)[0].strip().strip('"') if match else None


def number(label: str, key: str) -> float | None:
    raw = value(label, key)
    if raw is None:
        return None
    match = re.match(r"[-+]?\d+(?:\.\d*)?(?:[Ee][-+]?\d+)?", raw)
    return float(match.group()) if match else None


def convert(img_path: pathlib.Path, lbl_path: pathlib.Path, out_path: pathlib.Path, max_cells: int = 250_000) -> dict:
    label = lbl_path.read_text(errors="replace")
    product = value(label, "PRODUCT_ID")
    product = pathlib.Path(product).stem.upper() if product else ""
    if product != "MEGT44N000HB":
        raise ValueError(f"Expected PRODUCT_ID MEGT44N000HB, found {product or 'missing'}.")
    if img_path.stem.upper() != product:
        raise ValueError(f"IMG filename {img_path.name} does not match label PRODUCT_ID {product}.")
    if (value(label, "SAMPLE_TYPE") or "").upper() != "MSB_INTEGER" or number(label, "SAMPLE_BITS") != 16:
        raise ValueError("MOLA label must declare SAMPLE_TYPE=MSB_INTEGER and SAMPLE_BITS=16.")
    if (value(label, "UNIT") or "").upper() != "METER":
        raise ValueError("MOLA label must declare elevation UNIT=METER.")
    if (value(label, "MAP_PROJECTION_TYPE") or "").strip('"').upper() != "SIMPLE CYLINDRICAL":
        raise ValueError("Expected the label's SIMPLE CYLINDRICAL map projection.")
    if (value(label, "POSITIVE_LONGITUDE_DIRECTION") or "").strip('"').upper() != "EAST":
        raise ValueError("Only east-positive longitude is supported for this product.")

    rows, cols = int(number(label, "LINES") or 0), int(number(label, "LINE_SAMPLES") or 0)
    record_bytes = int(number(label, "RECORD_BYTES") or 0)
    map_scale_km = number(label, "MAP_SCALE")
    if not re.search(r"<\s*KM\s*/\s*PIXEL\s*>", value(label, "MAP_SCALE") or "", re.I):
        raise ValueError("MOLA MAP_SCALE must declare KM/PIXEL units in its label.")
    ppd = number(label, "MAP_RESOLUTION")
    radius_km = number(label, "A_AXIS_RADIUS")
    radius_m = radius_km * 1000 if radius_km is not None else None
    min_lat, max_lat = number(label, "MINIMUM_LATITUDE"), number(label, "MAXIMUM_LATITUDE")
    min_lon, max_lon = number(label, "WESTERNMOST_LONGITUDE"), number(label, "EASTERNMOST_LONGITUDE")
    center_lat, center_lon = number(label, "CENTER_LATITUDE"), number(label, "CENTER_LONGITUDE")
    line_offset, sample_offset = number(label, "LINE_PROJECTION_OFFSET"), number(label, "SAMPLE_PROJECTION_OFFSET")
    required = (rows, cols, record_bytes, map_scale_km, ppd, radius_m, min_lat, max_lat, min_lon, max_lon, center_lat, center_lon, line_offset, sample_offset)
    if any(x is None for x in required) or rows < 3 or cols < 3 or max_cells < 9:
        raise ValueError("MOLA PDS label lacks required raster, scale, coverage, radius, or projection-offset metadata.")
    if record_bytes != cols * 2:
        raise ValueError(f"Label RECORD_BYTES={record_bytes} does not equal LINE_SAMPLES × 2 ({cols * 2}).")
    if not math.isclose(map_scale_km * 1000, 2 * math.pi * radius_m / (360 * ppd), rel_tol=0.005):
        raise ValueError("MAP_SCALE is inconsistent with the label's radius and pixels per degree.")
    data_offset = 0
    image_ptr = value(label, "^IMAGE")
    if image_ptr:
        pointer = image_ptr.strip('"() ')
        match = re.search(r",\s*(\d+)\s*$", pointer)
        if match:
            data_offset = (int(match.group(1)) - 1) * record_bytes
        elif re.fullmatch(r"\d+", pointer):
            data_offset = (int(pointer) - 1) * record_bytes
    expected = data_offset + rows * record_bytes
    if img_path.stat().st_size < expected:
        raise ValueError(f"IMG is truncated: {img_path.stat().st_size} bytes; label requires {expected}.")

    factor = max(1, math.ceil(math.sqrt(rows * cols / max_cells)))
    width, height = cols // factor, rows // factor
    if width < 3 or height < 3:
        raise ValueError("Planner grid would be smaller than 3 × 3 cells; increase --max-cells.")
    raster = np.memmap(img_path, dtype=">i2", mode="r", offset=data_offset, shape=(rows, cols))
    elevation = np.full((height, width), np.nan, dtype=np.float32)
    for out_row in range(height):
        block = np.asarray(raster[out_row * factor:(out_row + 1) * factor, :width * factor], dtype=np.float64)
        # Product label specifies no-data behavior via its product definition; -32768 lies
        # outside the stated observed global elevation range and is the MEGDR null bin.
        valid = block != -32768
        grouped_valid = valid.reshape(factor, width, factor)
        count = grouped_valid.sum(axis=(0, 2))
        sums = np.where(valid, block, 0).reshape(factor, width, factor).sum(axis=(0, 2))
        good = count >= math.ceil(factor * factor / 2)
        elevation[out_row, good] = (sums[good] / count[good]).astype(np.float32)

    # MAP_SCALE is rounded in the PDS label; derive pixel spacing from the label's
    # radius and pixels/degree so tile coordinates and cell centres agree exactly.
    cell_m = 2 * math.pi * radius_m / (360 * ppd) * factor
    lat_center = (min_lat + max_lat) / 2
    retained_min_lat = max_lat - height * factor / ppd
    retained_max_lon = min_lon + width * factor / ppd
    # MOLA's simple cylindrical x coordinate is equatorial metres. Keep the source
    # projection convention (x = R·longitude) and retain the latitude for physical
    # distance correction in the terrain algorithms.
    origin_x = (0.5 - sample_offset) / ppd * math.pi / 180 * radius_m
    origin_y = (line_offset - 0.5) / ppd * math.pi / 180 * radius_m
    source = {
        "product_id": product,
        "mission": value(label, "SPACECRAFT_NAME"),
        "instrument": value(label, "INSTRUMENT_NAME"),
        "url": "https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg128/",
        "credit": "NASA / MGS MOLA Science Team / PDS Geosciences Node",
        "processing": [
            f"Decoded {rows} × {cols} SAMPLE_TYPE=MSB_INTEGER, SAMPLE_BITS=16 samples in metres (big-endian signed int16).",
            f"Used label record size {record_bytes} bytes and image offset {data_offset} bytes.",
            f"Derived projected cell spacing from A_AXIS_RADIUS and MAP_RESOLUTION ({ppd} px/degree); MAP_SCALE is rounded in the label and was used as a consistency check.",
            f"Block-averaged {factor} × {factor}; blocks with fewer than half valid samples are no-data.",
            f"Applied line/sample projection offsets ({line_offset}, {sample_offset}) and {ppd} pixels/degree; preserved east-positive coverage.",
            "This derived planner grid has coarser resolution than the source; the source MOLA values are topography above the MOLA areoid.",
        ],
    }
    tile = {
        "format": "mars-survival-tile", "version": 1,
        "name": "MOLA MEGDR median topography — MEGT44N000HB",
        "kind": "derived-from-nasa", "width": width, "height": height,
        "cell_x_m": cell_m, "cell_y_m": cell_m, "elevation_unit": "m",
        "z_scale": 1, "z_offset": 0, "nodata": None,
        "z": [None if not math.isfinite(float(z)) else float(z) for z in elevation.ravel()],
        "geo": {"type": "simple-cylindrical", "radius_m": radius_m,
                "center_lat_deg": center_lat, "center_lon_deg": center_lon,
                "origin_x_m": origin_x, "origin_y_m": origin_y,
                "min_lat_deg": retained_min_lat, "max_lat_deg": max_lat,
                "min_lon_deg": min_lon, "max_lon_deg": retained_max_lon,
                "planetocentric": True},
        "source": source,
        "notes": ["Numerical MOLA topography above the MOLA areoid; not planetary radius. Product bins may be interpolated where observations are sparse, as stated in its label.", "Coordinates use the product's planetocentric latitude and simple cylindrical projection. East-west ground distances and slope are corrected by cos(latitude)."],
        "targets": [],
        "default_route": {
            "start": {"x_m": math.radians(77.1 - min_lon) * radius_m, "y_m": math.radians(max_lat - 18.4) * radius_m},
            # One real planner-cell step east gives a short regional example.
            # It is still too coarse for local EVA planning and is labeled as such.
            "destination": {"x_m": math.radians(77.1 - min_lon) * radius_m + cell_m, "y_m": math.radians(max_lat - 18.4) * radius_m},
        },
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(tile, separators=(",", ":")))
    valid = elevation[np.isfinite(elevation)]
    return {"width": width, "height": height, "factor": factor, "cell_m": cell_m,
            "valid": int(valid.size), "min_m": float(valid.min()), "max_m": float(valid.max()),
            "bytes": out_path.stat().st_size, "lat_center": lat_center}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--img", type=pathlib.Path, required=True)
    parser.add_argument("--lbl", type=pathlib.Path, required=True)
    parser.add_argument("--out", type=pathlib.Path, required=True)
    parser.add_argument("--max-cells", type=int, default=250_000)
    args = parser.parse_args()
    try:
        print(json.dumps(convert(args.img, args.lbl, args.out, args.max_cells), indent=2))
    except (OSError, ValueError) as exc:
        print(f"MOLA conversion failed: {exc}", file=sys.stderr)
        raise SystemExit(2)


if __name__ == "__main__":
    main()
