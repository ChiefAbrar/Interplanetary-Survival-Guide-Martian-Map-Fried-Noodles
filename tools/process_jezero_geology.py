#!/usr/bin/env python3
"""Build the Mars-coordinate USGS SIM 3464 overlay from the audited local FileGDB.

Requires the ignored GIS environment used for the source audit (Pyogrio and
Shapely 2.1+). The original FileGDB and ZIP are read-only inputs. No source
attributes are corrected by this processor.
"""
from __future__ import annotations

import argparse
import hashlib
import gzip
import json
import math
import pathlib
import sys
from datetime import date

import numpy as np
import pyogrio
import pyogrio.raw as raw
import shapely
from shapely import coverage_is_valid, coverage_simplify, from_wkb, make_valid
from shapely.geometry import mapping, shape
from shapely import union_all

ROOT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_GDB = ROOT / "tmp/usgs-geology-tooling/extracted/sim3464_JezeroNili_FINAL/Geodatabase/Nili.gdb"
DEFAULT_ARCHIVE = ROOT / "tmp/usgs-jezero-gis-audit/sim3464_database.zip"
DEFAULT_OUTPUT = ROOT / "public/data/jezero-geology.json"
EXPECTED_ARCHIVE_SHA256 = "A88BD53A5573743CC4A20036C10E585106D08A433AD2F34AF269E9CEA1529F87"
RADIUS_M = 3_396_190.0
CENTRAL_MERIDIAN_DEG = 77.5
INVALID_FIDS = {666, 1155}
DISPLAY_CORRECTIONS = {
    "112": {"name": "Upper etched unit", "symbol": "Nue", "note": "Publication pairing; conflicting raw fields retained."},
    "561": {"name": "Rugged bright unit", "symbol": "Nrb", "note": "Publication symbol; raw subscript retained."},
    "1004": {"name": "Crater rim unit", "symbol": "cr", "note": "Publication spelling; source spelling retained."},
}


def sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest().upper()


def inverse_mars_tm(x: float, y: float) -> tuple[float, float]:
    """Inverse spherical Transverse Mercator, returning east longitude, planetocentric latitude."""
    xx, d = x / RADIUS_M, y / RADIUS_M
    lon = math.radians(CENTRAL_MERIDIAN_DEG) + math.atan2(math.sinh(xx), math.cos(d))
    lat = math.asin(math.sin(d) / math.cosh(xx))
    return math.degrees(lon), math.degrees(lat)


def forward_mars_tm(lon_deg: float, lat_deg: float) -> tuple[float, float]:
    """Forward spherical Transverse Mercator, used to validate rounded output coordinates."""
    delta = math.radians(lon_deg - CENTRAL_MERIDIAN_DEG)
    lat = math.radians(lat_deg)
    x = RADIUS_M * math.atanh(math.cos(lat) * math.sin(delta))
    y = RADIUS_M * math.atan2(math.tan(lat), math.cos(delta))
    return x, y


def verify_projection() -> None:
    controls = [
        (0.0, 0.0, 77.5, 0.0),
        (-39528.906, 1049235.563, 76.8, 17.7),
        (16843.742, 1108450.982, 77.8, 18.7),
    ]
    for x, y, expected_lon, expected_lat in controls:
        lon, lat = inverse_mars_tm(x, y)
        if abs(lon - expected_lon) > 2e-5 or abs(lat - expected_lat) > 2e-5:
            raise RuntimeError(f"Mars TM inverse failed audited control ({x}, {y}) -> ({lon}, {lat}).")


def python_value(value):
    if hasattr(value, "item"):
        value = value.item()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def read_layer(gdb: pathlib.Path, layer: str):
    info = pyogrio.read_info(str(gdb), layer=layer)
    meta, fids, wkbs, columns = raw.read(str(gdb), layer=layer, return_fids=True)
    names = meta["fields"]
    records = []
    for i, (fid, wkb) in enumerate(zip(fids, wkbs)):
        attrs = {name: python_value(columns[j][i]) for j, name in enumerate(names)}
        records.append((int(fid), from_wkb(wkb), attrs))
    return info, records


def polygonal(geometry):
    if geometry.geom_type in ("Polygon", "MultiPolygon"):
        return geometry
    if geometry.geom_type == "GeometryCollection":
        pieces = [g for g in geometry.geoms if g.geom_type in ("Polygon", "MultiPolygon") and not g.is_empty]
        return union_all(pieces) if pieces else shapely.GeometryCollection()
    return shapely.GeometryCollection()


def hole_count(geometry) -> int:
    if geometry.geom_type == "Polygon":
        return len(geometry.interiors)
    if geometry.geom_type == "MultiPolygon":
        return sum(len(p.interiors) for p in geometry.geoms)
    return 0


def polygon_count(geometry) -> int:
    if geometry.geom_type == "Polygon":
        return 1
    if geometry.geom_type == "MultiPolygon":
        return len(geometry.geoms)
    return 0


def vertex_count(geometry) -> int:
    return int(shapely.get_num_coordinates(geometry))


def convert_coordinates(coords):
    if not coords:
        return []
    first = coords[0]
    if isinstance(first, (int, float, np.integer, np.floating)):
        lon, lat = inverse_mars_tm(float(coords[0]), float(coords[1]))
        return [round(lon, 6), round(lat, 6)]
    return [convert_coordinates(child) for child in coords]


def geometry_json(geometry):
    obj = mapping(geometry)
    if "coordinates" in obj:
        obj = {"type": obj["type"], "coordinates": convert_coordinates(obj["coordinates"])}
    else:
        obj = {"type": obj["type"], "geometries": [geometry_json(g) for g in geometry.geoms]}
    return obj


def projected_output_geometry(geometry_object):
    def convert(coords):
        if not coords:
            return []
        first = coords[0]
        if isinstance(first, (int, float)):
            return list(forward_mars_tm(float(coords[0]), float(coords[1])))
        return [convert(child) for child in coords]
    if "coordinates" in geometry_object:
        return shape({"type": geometry_object["type"], "coordinates": convert(geometry_object["coordinates"])})
    return shape({"type": geometry_object["type"], "geometries": [projected_output_geometry(g).__geo_interface__ for g in geometry_object["geometries"]]})


def load_and_process(gdb: pathlib.Path, tolerance: float):
    info, unit_records = read_layer(gdb, "GeoUnits_v1")
    contact_info, contact_records = read_layer(gdb, "GeoContacts")
    boundary_info, boundary_records = read_layer(gdb, "MapBoundary")
    if len(boundary_records) != 1:
        raise RuntimeError("Expected exactly one MapBoundary feature.")
    crs = info.get("crs") or ""
    normalized_crs = crs.lower().replace(" ", "")
    if "3396190" not in normalized_crs or "77.5" not in normalized_crs or "transverse_mercator" not in normalized_crs:
        raise RuntimeError("GeoUnits_v1 CRS does not match the audited Mars sphere / central-meridian-77.5 Transverse Mercator.")
    verify_projection()
    boundary = boundary_records[0][1]
    if not boundary.is_valid:
        raise RuntimeError("Source MapBoundary is invalid.")

    processed = []
    repairs = []
    for fid, source_geometry, attrs in unit_records:
        geometry = source_geometry
        if fid in INVALID_FIDS:
            geometry = make_valid(source_geometry)
            if not geometry.is_valid:
                raise RuntimeError(f"Documented MakeValid override failed for GeoUnits_v1 FID {fid}.")
            repairs.append({
                "source_fid": fid,
                "orig_fid": attrs.get("ORIG_FID"),
                "method": "Shapely/GEOS MakeValid applied to this feature only",
                "source_geometry_preserved": True,
                "source_geometry_valid": bool(source_geometry.is_valid),
                "repaired_geometry_valid": bool(geometry.is_valid),
                "source_type": source_geometry.geom_type,
                "repaired_type": geometry.geom_type,
                "source_area_m2": float(source_geometry.area),
                "repaired_area_m2": float(geometry.area),
                "area_delta_m2": float(geometry.area - source_geometry.area),
                "source_perimeter_m": float(source_geometry.length),
                "repaired_perimeter_m": float(geometry.length),
                "source_vertices": vertex_count(source_geometry),
                "repaired_vertices": vertex_count(geometry),
                "source_holes": hole_count(source_geometry),
                "repaired_holes": hole_count(geometry),
                "review_note": "Source self-intersection override from geometry review; semantic boundary fidelity remains a limitation.",
            })
        elif not source_geometry.is_valid:
            raise RuntimeError(f"Unexpected invalid GeoUnits_v1 feature FID {fid}; only the two audited IDs may be repaired.")
        geometry = polygonal(geometry.intersection(boundary))
        if geometry.is_empty or geometry.geom_type not in ("Polygon", "MultiPolygon") or not geometry.is_valid:
            raise RuntimeError(f"Clip produced an empty, non-polygonal, or invalid result for GeoUnits_v1 FID {fid}.")
        processed.append((fid, attrs, geometry))

    original_geometries = np.asarray([record[2] for record in processed], dtype=object)
    original_valid = bool(coverage_is_valid(original_geometries))
    original_union = union_all(original_geometries)
    original_gap_area = float(boundary.difference(original_union).area)
    original_holes = sum(hole_count(geometry) for geometry in original_geometries)
    original_parts = sum(polygon_count(geometry) for geometry in original_geometries)

    candidate_geometries = np.asarray(
        coverage_simplify(original_geometries, tolerance, simplify_boundary=False), dtype=object
    ) if tolerance > 0 else original_geometries
    candidate_union = union_all(candidate_geometries)
    candidate_gap_area = float(boundary.difference(candidate_union).area)
    candidate_holes = sum(hole_count(geometry) for geometry in candidate_geometries)
    candidate_parts = sum(polygon_count(geometry) for geometry in candidate_geometries)
    candidate_valid = bool(coverage_is_valid(candidate_geometries))
    feature_valid = bool(np.all(shapely.is_valid(candidate_geometries)))
    identity_preserved = len(candidate_geometries) == len(processed) and all(not g.is_empty for g in candidate_geometries)
    holes_preserved = candidate_holes == original_holes
    parts_preserved = candidate_parts == original_parts
    gap_delta = abs(candidate_gap_area - original_gap_area)
    union_change = float(original_union.symmetric_difference(candidate_union).area)
    max_boundary_distance = float(np.max(shapely.hausdorff_distance(
        shapely.boundary(original_geometries), shapely.boundary(candidate_geometries)
    ))) if tolerance > 0 else 0.0
    checks = {
        "source_coverage_valid": original_valid,
        "candidate_coverage_valid": candidate_valid,
        "all_features_valid": feature_valid,
        "all_feature_ids_retained": identity_preserved,
        "polygon_parts_preserved": parts_preserved,
        "holes_preserved": holes_preserved,
        "map_boundary_gap_delta_m2": gap_delta,
        "union_symmetric_difference_m2": union_change,
        "max_discrete_boundary_hausdorff_m": max_boundary_distance,
    }
    acceptable = (
        original_valid and candidate_valid and feature_valid and identity_preserved and parts_preserved and holes_preserved
        and gap_delta <= 1e-3 and union_change <= 1e-3 and max_boundary_distance <= tolerance + 1e-6
    )
    chosen_geometries = candidate_geometries if tolerance == 0 or acceptable else original_geometries
    chosen_tolerance = tolerance if tolerance == 0 or acceptable else 0.0
    if not original_valid:
        raise RuntimeError("Repaired/clipped source polygons do not form a valid shared coverage; refusing to emit overlay.")
    if tolerance > 0 and not acceptable:
        print("15 m coverage simplification rejected; retaining clipped unsimplified shared geometry.", file=sys.stderr)

    units = []
    for (fid, attrs, _), geometry in zip(processed, chosen_geometries):
        display = {"name": attrs.get("name"), "symbol": attrs.get("symbol")}
        correction = DISPLAY_CORRECTIONS.get(str(fid))
        if correction:
            display = {"name": correction["name"], "symbol": correction["symbol"], "correction_note": correction["note"]}
        px, py = geometry.representative_point().coords[0]
        label_point = [round(value, 6) for value in inverse_mars_tm(px, py)]
        units.append({
            "source_fid": fid,
            "source_attributes": attrs,
            "display": display,
            "label_point": label_point,
            "geometry": geometry_json(geometry),
            "processing": {"clipped_to_map_boundary": True, "simplification_tolerance_m": chosen_tolerance,
                           "geometry_override": "make_valid" if fid in INVALID_FIDS else None},
        })

    contacts = []
    for fid, geometry, attrs in contact_records:
        clipped = geometry.intersection(boundary)
        if clipped.is_empty:
            continue
        contacts.append({"source_fid": fid, "source_attributes": attrs, "geometry": geometry_json(clipped)})

    boundary_geom = boundary_records[0][1]
    metadata = {
        "publication": "Sun & Stack (2020), USGS SIM 3464, DOI 10.3133/sim3464",
        "source_archive": "sim3464_database.zip",
        "source_archive_url": "https://pubs.usgs.gov/sim/3464/sim3464_database.zip",
        "source_archive_sha256": EXPECTED_ARCHIVE_SHA256,
        "source_layers": ["GeoUnits_v1", "GeoContacts", "MapBoundary"],
        "source_crs_wkt": crs,
        "coordinate_reference": {
            "body": "Mars", "datum": "Mars 2000 sphere", "sphere_radius_m": RADIUS_M,
            "projection": "Transverse Mercator", "central_meridian_east_deg": CENTRAL_MERIDIAN_DEG,
            "latitude_of_origin_deg": 0, "scale_factor": 1, "false_easting_m": 0, "false_northing_m": 0,
            "output_units": "degrees", "coordinate_order": ["east_positive_longitude", "planetocentric_latitude"],
            "not_wgs84": True,
        },
        "retrieval_and_citation": "https://pubs.usgs.gov/sim/3464/",
        "processing_date_utc": date.today().isoformat(),
        "processor": {"script": "tools/process_jezero_geology.py", "python": sys.version.split()[0],
                      "pyogrio": pyogrio.__version__, "gdal": pyogrio.__gdal_version__,
                      "shapely": shapely.__version__, "geos": shapely.geos_version_string},
        "clipping": "Intersection with the source MapBoundary feature in source MTM meters.",
        "invalid_geometry_overrides": repairs,
        "attribute_display_corrections": DISPLAY_CORRECTIONS,
        "simplification": {
            "requested_candidate_tolerance_m": tolerance,
            "selected_tolerance_m": chosen_tolerance,
            "algorithm": "Shapely/GEOS coverage_simplify across the complete polygon coverage; external boundaries preserved.",
            "candidate_accepted": tolerance == 0 or acceptable,
            "candidate_checks": checks,
            "decision": "accepted" if tolerance == 0 or acceptable else "rejected; emitted clipped unsimplified coverage",
        },
        "contact_geometry": "GeoContacts clipped to MapBoundary and retained without simplification.",
        "units": "source MTM geometry in meters; contact classification is source TYPE, not a general confidence score.",
    }
    payload = {
        "schema": "mars-survival.usgs-sim3464-geology/1",
        "metadata": metadata,
        "units": units,
        "contacts": contacts,
        "map_boundary": {"label": "USGS SIM 3464 map boundary", "geometry": geometry_json(boundary_geom)},
    }
    serialized_units = np.asarray([projected_output_geometry(feature["geometry"]) for feature in units], dtype=object)
    if len(serialized_units) != len(unit_records) or not np.all(shapely.is_valid(serialized_units)) or not coverage_is_valid(serialized_units):
        raise RuntimeError("Rounded Mars-coordinate output failed polygon validity or shared-coverage validation.")
    if sum(hole_count(g) for g in serialized_units) != sum(hole_count(g) for g in chosen_geometries):
        raise RuntimeError("Rounded Mars-coordinate output lost polygon holes.")
    summary = {
        "unit_count": len(units), "contact_feature_count": len(contacts), "unit_vertices": sum(vertex_count(g) for g in chosen_geometries),
        "unit_holes": sum(hole_count(g) for g in chosen_geometries), "unit_parts": sum(polygon_count(g) for g in chosen_geometries),
        "invalid_repairs": len(repairs), "source_coverage_valid": original_valid,
        "serialized_output_valid": True, "serialized_output_coverage_valid": True,
        "gap_area_m2_before_simplification": original_gap_area, "gap_area_m2_after_candidate": candidate_gap_area,
        "simplification": metadata["simplification"], "repairs": repairs,
    }
    return payload, summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gdb", type=pathlib.Path, default=DEFAULT_GDB)
    parser.add_argument("--archive", type=pathlib.Path, default=DEFAULT_ARCHIVE)
    parser.add_argument("--output", type=pathlib.Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--tolerance-m", type=float, default=15.0)
    parser.add_argument("--dry-run", action="store_true", help="process and report without writing the output payload")
    parser.add_argument("--force", action="store_true", help="allow replacing an existing output payload")
    args = parser.parse_args()
    if not args.gdb.is_dir() or not args.archive.is_file():
        raise SystemExit("The audited local GDB or source archive is missing; no download is attempted.")
    digest = sha256(args.archive)
    if digest != EXPECTED_ARCHIVE_SHA256:
        raise SystemExit(f"Source archive SHA-256 mismatch: {digest}")
    if args.tolerance_m < 0:
        raise SystemExit("Tolerance must be zero or greater.")
    payload, summary = load_and_process(args.gdb, args.tolerance_m)
    encoded = (json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
    summary["payload_bytes"] = len(encoded)
    summary["gzip_bytes_level_9"] = len(gzip.compress(encoded, compresslevel=9, mtime=0))
    summary["payload_sha256"] = hashlib.sha256(encoded).hexdigest().upper()
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    if args.dry_run:
        print("Dry run only; no payload was written.")
        return 0
    if args.output.exists() and not args.force:
        raise SystemExit(f"Refusing to overwrite existing output: {args.output}; pass --force only after backing it up.")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_name(args.output.name + ".processing-tmp")
    temporary.write_bytes(encoded)
    temporary.replace(args.output)
    print(f"Wrote {args.output} ({len(encoded)} bytes).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

