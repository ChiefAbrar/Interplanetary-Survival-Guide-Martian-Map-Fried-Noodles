#!/usr/bin/env python3
"""Build a display-only, georeferenced regional CTX relief texture from validated tiles."""

from __future__ import annotations

import argparse
import array
import hashlib
import json
import math
import pathlib
import struct
import sys
import zlib

SOURCE_HASH = "ba7f706ea1b5d63a562f28a7dcf7a7f3c79bce7f048e6974b57e8a33c30d1ba2"
OUTPUT_WIDTH = 1024
OUTPUT_HEIGHT = 1162
NODATA = float("nan")
RAMP = [
    [62, 139, 116],
    [104, 160, 111],
    [211, 192, 113],
    [153, 87, 78],
    [91, 48, 45],
]
LIGHTS = [(315, 0.4), (45, 0.2), (225, 0.2), (135, 0.2)]


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def source_grid(data_dir: pathlib.Path):
    catalog_path = data_dir / "catalog.json"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    source = catalog["source_grid"]
    width, height = source["width"], source["height"]
    if catalog.get("dataset_id") != "urn:nasa:pds:mars2020_ctx_basemap_2021:data:m20_ctxdem_mosaic":
        raise ValueError("Unexpected CTX catalog dataset identity.")
    if not catalog.get("coverage_verification", {}).get("complete_source_coverage"):
        raise ValueError("CTX catalog does not verify complete source coverage.")
    if catalog["source_raster"]["sha256"] != SOURCE_HASH:
        raise ValueError("CTX source raster checksum differs from the audited product.")

    values = array.array("f", [NODATA]) * (width * height)
    covered = 0
    for record in catalog["tiles"]:
        meta_path = data_dir / record["metadata_file"]
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        if meta.get("dataset_id") != catalog["dataset_id"] or meta["data"]["dtype"] != "float32":
            raise ValueError(f"Invalid tile metadata for {record['tile_id']}.")
        tile_path = data_dir / record["data_file"]
        binary = tile_path.read_bytes()
        if len(binary) != meta["data"]["expected_bytes"] or hashlib.sha256(binary).hexdigest() != meta["data"]["sha256"]:
            raise ValueError(f"Tile size or checksum failure for {record['tile_id']}.")
        tile = array.array("f")
        tile.frombytes(binary)
        if sys.byteorder != "little":
            tile.byteswap()
        tile_width, tile_height = meta["width"], meta["height"]
        if len(tile) != tile_width * tile_height:
            raise ValueError(f"Tile dimensions do not match for {record['tile_id']}.")
        core, inside = meta["core_window"], meta["core_window_in_tile"]
        if core != record["core_window"]:
            raise ValueError(f"Catalog and tile core windows differ for {record['tile_id']}.")
        for row in range(core["height"]):
            source_start = (inside["row_off"] + row) * tile_width + inside["col_off"]
            target_start = (core["row_off"] + row) * width + core["col_off"]
            values[target_start:target_start + core["width"]] = tile[source_start:source_start + core["width"]]
        covered += core["width"] * core["height"]
    if covered != width * height:
        raise ValueError(f"Tile cores cover {covered} of {width * height} source cells.")
    return values, width, height, source, catalog


def downsample(values: array.array, source_width: int, source_height: int):
    coarse = array.array("f", [NODATA]) * (OUTPUT_WIDTH * OUTPUT_HEIGHT)
    for y in range(OUTPUT_HEIGHT):
        y0 = y * source_height // OUTPUT_HEIGHT
        y1 = max(y0 + 1, (y + 1) * source_height // OUTPUT_HEIGHT)
        for x in range(OUTPUT_WIDTH):
            x0 = x * source_width // OUTPUT_WIDTH
            x1 = max(x0 + 1, (x + 1) * source_width // OUTPUT_WIDTH)
            total = 0.0
            count = 0
            for row in range(y0, min(y1, source_height)):
                start = row * source_width + x0
                for value in values[start:start + min(x1, source_width) - x0]:
                    if math.isfinite(value):
                        total += value
                        count += 1
            if count:
                coarse[y * OUTPUT_WIDTH + x] = total / count
    return coarse


def display_range(values: array.array):
    finite = sorted(value for value in values if math.isfinite(value))
    if not finite:
        raise ValueError("CTX raster contains no valid elevation samples.")
    return finite[int(0.02 * (len(finite) - 1))], finite[int(0.98 * (len(finite) - 1))]


def geographic_bounds(source: dict, projection: dict):
    transform = source["transform_gdal_order"]
    x_origin, x_pixel, x_skew, y_origin, y_skew, y_pixel = transform
    if x_skew != 0 or y_skew != 0 or projection.get("name") != "Equirectangular":
        raise ValueError("Cannot derive raster bounds from this unsupported transform/projection.")
    radius = projection["planetary_radius_m"]
    standard_parallel = math.radians(projection["standard_parallel_deg"])
    latitude_origin = projection["latitude_of_projection_origin_deg"]
    longitude_origin = projection["longitude_of_central_meridian_deg"]
    width, height = source["width"], source["height"]
    west = longitude_origin + math.degrees(x_origin / (radius * math.cos(standard_parallel)))
    east = longitude_origin + math.degrees((x_origin + width * x_pixel) / (radius * math.cos(standard_parallel)))
    north = latitude_origin + math.degrees(y_origin / radius)
    south = latitude_origin + math.degrees((y_origin + height * y_pixel) / radius)
    return {"west": west, "east": east, "south": south, "north": north}


def interpolate(value: float, low: float, high: float):
    position = max(0.0, min(1.0, (value - low) / max(high - low, 1e-9))) * (len(RAMP) - 1)
    index = min(len(RAMP) - 2, int(position))
    fraction = position - index
    return [RAMP[index][channel] + (RAMP[index + 1][channel] - RAMP[index][channel]) * fraction for channel in range(3)]


def hillshade(values: array.array, index: int, dx_cell: float, dy_cell: float):
    row, col = divmod(index, OUTPUT_WIDTH)
    centre = values[index]

    def sample(x, y):
        value = values[max(0, min(OUTPUT_HEIGHT - 1, y)) * OUTPUT_WIDTH + max(0, min(OUTPUT_WIDTH - 1, x))]
        return value if math.isfinite(value) else centre

    dx = (sample(col + 1, row) - sample(col - 1, row)) / (2 * dx_cell)
    dy = (sample(col, row + 1) - sample(col, row - 1)) / (2 * dy_cell)
    slope = math.atan(math.hypot(dx, dy))
    aspect = math.atan2(dy, -dx)
    illumination = 0.0
    zenith = math.radians(45)
    for azimuth, weight in LIGHTS:
        angle = math.radians(azimuth)
        illumination += weight * (math.cos(zenith) * math.cos(slope) + math.sin(zenith) * math.sin(slope) * math.cos(angle - aspect))
    return max(0.58, min(1.12, 0.7 + 0.6 * illumination))


def png_chunk(name: bytes, payload: bytes) -> bytes:
    body = name + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def render_png(values: array.array, source: dict, target: pathlib.Path):
    low, high = display_range(values)
    transform = source["transform_gdal_order"]
    dx_cell = abs(transform[1] * source["width"] / OUTPUT_WIDTH)
    dy_cell = abs(transform[5] * source["height"] / OUTPUT_HEIGHT)
    raw = bytearray()
    for row in range(OUTPUT_HEIGHT):
        raw.append(0)  # PNG filter: None
        for col in range(OUTPUT_WIDTH):
            index = row * OUTPUT_WIDTH + col
            elevation = values[index]
            if not math.isfinite(elevation):
                raw.extend((0, 0, 0, 0))
                continue
            shade = hillshade(values, index, dx_cell, dy_cell)
            color = interpolate(elevation, low, high)
            raw.extend((*[max(0, min(255, round(channel * shade))) for channel in color], 255))
    header = struct.pack(">IIBBBBB", OUTPUT_WIDTH, OUTPUT_HEIGHT, 8, 6, 0, 0, 0)
    image = b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", header) + png_chunk(b"IDAT", zlib.compress(raw, 9)) + png_chunk(b"IEND", b"")
    target.write_bytes(image)
    return low, high


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tiles", type=pathlib.Path, default=pathlib.Path("data/processed/ctx-jezero"))
    parser.add_argument("--output", type=pathlib.Path, default=pathlib.Path("public/data/jezero-ctx-relief.png"))
    parser.add_argument("--metadata", type=pathlib.Path, default=pathlib.Path("public/data/jezero-ctx-relief.json"))
    args = parser.parse_args()

    values, width, height, source, catalog = source_grid(args.tiles)
    coarse = downsample(values, width, height)
    low, high = render_png(coarse, source, args.output)
    spatial = catalog["source_crs"]["projection"]
    bounds = geographic_bounds(source, spatial)
    metadata = {
        "format": "mars-survival-ctx-display-relief",
        "version": 1,
        "image": args.output.name,
        "dimensions_pixels": [OUTPUT_WIDTH, OUTPUT_HEIGHT],
        "source_dataset_id": catalog["dataset_id"],
        "source_raster_sha256": SOURCE_HASH,
        "source_raster_dimensions_pixels": [width, height],
        "source_raster_transform_gdal_order": source["transform_gdal_order"],
        "source_crs": spatial,
        "coverage_planetocentric_east_positive_deg": bounds,
        "display_pixel_size_projected_m": [source["transform_gdal_order"][1] * width / OUTPUT_WIDTH, abs(source["transform_gdal_order"][5]) * height / OUTPUT_HEIGHT],
        "display_elevation_percentile_range_m": [low, high],
        "display_color_ramp_rgb": RAMP,
        "display_hillshade": {"method": "four-direction weighted multidirectional hillshade", "lights_azimuth_weight": LIGHTS, "illumination_range": [0.58, 1.12]},
        "source_nodata": "transparent; no elevation interpolated into missing cells",
        "data_role": "visual texture only; image colors are never elevation samples or route-analysis inputs",
        "attribution": "USGS Astrogeology Science Center; Mars 2020 Science Investigation CTX DEM Mosaic (Calef product record; source mosaic citation in DATA_SOURCES.md). Public domain.",
        "source_metadata": catalog["source_raster"].get("metadata_url") or "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/CTX/ScienceInvestigationMaps_JPL/M20_JezeroCrater_CTXDEM_20m.xml",
        "visual_reference": "USGS Jezero Crater rendered CTX DEM image; reference JPEG has no map georeferencing and was not used as a map texture.",
        "visual_reference_url": "https://www.usgs.gov/media/images/jezero-crater-0",
        "visual_reference_image_url": "https://d9-wret.s3.us-west-2.amazonaws.com/assets/palladium/production/s3fs-public/media/images/M20_JezeroCrater_CTXDEM_mosaic_20m.jpg",
    }
    metadata["image_size_bytes"] = args.output.stat().st_size
    metadata["image_sha256"] = sha256(args.output)
    args.metadata.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {args.output} ({OUTPUT_WIDTH}x{OUTPUT_HEIGHT}, {args.output.stat().st_size} bytes); source grid {width}x{height}; display range {low:.2f}..{high:.2f} m.")


if __name__ == "__main__":
    main()
