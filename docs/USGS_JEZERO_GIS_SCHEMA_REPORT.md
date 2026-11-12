# USGS Jezero GIS Schema and Geometry Report

**Inspection date:** 2026-11-12  
**Scope:** Local inspection of the already downloaded official SIM 3464 geodatabase. No application overlay or processed release asset was created.

## Source and tool verification

The source ZIP at `tmp/usgs-jezero-gis-audit/sim3464_database.zip` was checked before inspection. Its SHA-256 matches the prior audit: `A88BD53A5573743CC4A20036C10E585106D08A433AD2F34AF269E9CEA1529F87`. The ZIP passed 7-Zip integrity testing. The archive was not downloaded again.

No GIS reader was initially installed. Pyogrio was installed into a new ignored environment at `tmp/usgs-geology-tooling/venv/`; its bundled GDAL 3.12.4 reports the `OpenFileGDB` driver. Only the inner `Geodatabase/Nili.gdb` (30,952,029 bytes) was extracted to the same ignored temporary area. No project environment, requirements, lockfile, source data, or application file was changed. The project's pre-existing staged, modified, deleted, and untracked state was preserved.

## Feature-class inventory

GDAL OpenFileGDB exposes 13 spatial layers. The README's fourteenth item, `Anno_68_69`, is identified there as a relationship file and is not exposed as a normal spatial layer by this reader. No standalone nonspatial geology-description table was exposed. Counts below are the actual feature counts reported by OpenFileGDB; extents are source MTM x/y meters.

| Layer | Geometry | Features | Extent xmin, ymin, xmax, ymax (m) |
|---|---|---:|---|
| `MapBoundary` | MultiPolygon | 1 | -39528.9, 1049162.1, 16940.7, 1108513.8 |
| `Nomenclature` | MultiPolygon | 10 | -33901.0, 1056865.7, 14983.9, 1105972.0 |
| `CrossSections` | MultiLineString | 2 | -15939.2, 1064890.1, 10589.8, 1100300.0 |
| `Figures` | MultiPolygon | 12 | -39457.0, 1053978.0, 10709.4, 1107905.0 |
| `FiguresAnno` | MultiPolygon | 17 | -38567.0, 1053317.6, 10996.8, 1107444.3 |
| `GeoContacts` | MultiLineString | 2,496 | -39529.4, 1049162.1, 16941.2, 1108513.8 |
| `SurfaceFeatures` | MultiPolygon | 285 | -39523.6, 1049162.2, 16850.6, 1108511.1 |
| `LinearFeatures` | MultiLineString | 382 | -39490.3, 1049238.4, 16911.1, 1108474.0 |
| `LocationFeatures` | Point | 341 | -39310.4, 1049239.9, 16709.9, 1108326.6 |
| `GeoUnitsAnno` | MultiPolygon | 1,294 | -39480.0, 1049176.8, 16910.2, 1108513.8 |
| `LandingEllipse` | MultiPolygon | 1 | -8183.5, 1090585.4, 293.8, 1098585.4 |
| `megabreccia_fig2` | Point | 361 | -36407.1, 1049239.9, 1734.6, 1100931.1 |
| `GeoUnits_v1` | MultiPolygon | 1,304 | -39529.4, 1049162.1, 16941.2, 1108513.8 |

The common layer extent is consistent with the published regional footprint. `MapBoundary` is one valid polygon with 403 vertices and should be used as the exact clip geometry. Its stored `LAT_MIN`, `LAT_MAX`, `LON_MIN`, `LON_MAX`, `CLON`, `SP_1`, and `SP_2` fields decode as null/NaN; use its geometry and CRS instead of those attributes.

## Relevant schemas and source values

GDAL field types below are the actual FileGDB types. `OFTInteger` is a 32-bit integer, `OFTInteger` with `OFSTInt16` is a 16-bit subtype, `OFTReal` is floating point, and `OFTString` is text. Widths and coded-value domains were not exposed by the reader.

| Layer | Complete fields and types |
|---|---|
| `GeoUnits_v1` | `unit` String; `name` String; `symbol_noSub` String; `subscript` String; `symbol` String; `ORIG_FID` Integer; `SHAPE_Length` Real; `SHAPE_Area` Real; `Color_ID` Integer/Int16. |
| `GeoContacts` | `TYPE` String; `SHAPE_Length` Real. |
| `LinearFeatures` | `TYPE` String; `SHAPE_Length` Real. |
| `SurfaceFeatures` | `TYPE` String; `SHAPE_Length` Real; `SHAPE_Area` Real. |
| `LocationFeatures` | `TYPE` String. |
| `MapBoundary` | `Shape_Length` Real; `Shape_Area` Real; `QUAD_NAME` String; `LAT_MIN`, `LAT_MAX`, `LON_MIN`, `LON_MAX`, `CLON`, `SP_1`, `SP_2` Real. The latter geographic fields are null in its single record. |
| `LandingEllipse` | `name` String; `SHAPE_Length` Real; `SHAPE_Area` Real. |

The actual polygon field is spelled `symbol_noSub`; the external FGDC text metadata spells it `symbol_noS`. `GeoUnits_v1` also contains `Color_ID`, which is absent from that metadata. There are 14 string `unit` codes (`0`–`13`) across 1,304 polygon features, and 15 distinct source `name` strings because one name has a source spelling anomaly. No age, lithology, or confidence field is present in the GeoUnits schema.

Observed GeoUnits symbol/name counts include: `Aeb` Eolian bedform unit 475; `Nue` Upper etched unit 269; `Nnp1` Nili Planum 1 unit 156; `Nnp2` Nili Planum 2 unit 128; `Nrb` Rugged bright unit 70; `cr` Crater rim unit 63; `su` Smooth unit, undivided 53; `Nle` Lower etched unit 20; `ce` Crater ejecta unit 15; `NHjf2` Jezero fan 2 unit 15; `Njf` Jezero floor unit 13; `ci` Crater interior unit 9; `NHjf1` Jezero fan 1 unit 9; and `Hnpf` Nili Planum fan unit 8. One additional feature is named `Crater riim unit` with symbol `cr`; preserve the source text or correct it only with a documented source check.

Three records need attribute review before a user-facing inspector is built: one `Upper etched unit` polygon has `unit=5`, `symbol_noSub=Nnp`, `subscript=2`, but `symbol=Nue`; one `Rugged bright unit` has `subscript=2` while `symbol=Nrb`; and one `Crater rim` name is misspelled `Crater riim`. One other Upper etched feature has an empty-string subscript while the other equivalent records use null. Do not join descriptions or derive displayed labels from `unit` alone until these inconsistencies are resolved against the published map.

The useful linework classifications are real source attributes:

- `GeoContacts.TYPE`: `certain` 1,666; `approximate` 829; `boundary` 1. This is the source's mapped contact classification, not a numeric confidence score.
- `LinearFeatures.TYPE`: `ridge crest (type 1), certain` 176; `lineament` 98; `crest of crater rim` 66; `delta lobe front` 32; `channel (fluvial)` 6; `crest of buried crater` 4.
- `SurfaceFeatures.TYPE`: `dark-colored mantling material` 256; `ridged` 29.
- `LocationFeatures.TYPE`: `small crater` 341.

`GeoUnitsAnno` stores cartographic annotation fields (`TextString`, `SymbolID`, `AnnotationClassID`, font/style/placement fields), not a geology-description table. `Nomenclature` is also cartographic annotation. OpenFileGDB did not expose a standalone description table or a safe GeoUnits-to-description join. The README's `Anno_68_69` relationship item should not be mistaken for an age/lithology table. The relationship metadata and any annotation joins need separate ArcGIS/FileGDB catalog review if they become necessary.

## Verified CRS and transformation

The actual WKT returned for each spatial layer is consistent. The core parameters are:

```text
PROJCS["MTM_clon77.5E",
 GEOGCS["Mars_2000_(Sphere)",
  DATUM["Mars_2000_(Sphere)",
   SPHEROID["Mars_2000_(Sphere)",3396190,0],AUTHORITY["ESRI","106971"]],
  PRIMEM["Reference_Meridian",0],UNIT["Degree",0.0174532925199433]],
 PROJECTION["Transverse_Mercator"],
 PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",77.5],
 PARAMETER["scale_factor",1],PARAMETER["false_easting",0],
 PARAMETER["false_northing",0],UNIT["Meter",1],
 AXIS["Easting",EAST],AXIS["Northing",NORTH]]
```

This verifies Mars 2000 sphere radius 3,396,190 m, central meridian 77.5°, latitude of origin 0°, scale 1, false easting/northing 0, units meters, and x/easting then y/northing axis order. The official metadata identifies the footprint as east longitude 76.8–77.8° and latitude 17.7–18.7°. The CRS name and metadata therefore support east-positive longitude. The files do not explicitly mark the latitude convention; on the specified sphere, planetocentric and planetographic latitudes coincide numerically.

GDAL/PROJ transformations were tested with traditional GIS axis order and an explicit Mars 2000 spherical geographic CRS. Representative geographic → MTM → geographic tests were:

| Input (east longitude, latitude) | Projected MTM (x, y m) | Round-trip error |
|---|---|---|
| (77.5°, 0°) | (0.000, 0.000) | 0° |
| (76.8°, 17.7°) | (-39528.906, 1049235.563) | < 2×10⁻¹⁴° |
| (77.8°, 18.7°) | (16843.742, 1108450.982) | < 2×10⁻¹⁴° |
| (77.3°, 18.2°) | (-11261.880, 1078805.634) | < 2×10⁻¹⁴° |

The projected edge examples fall within the actual `MapBoundary` extent and correspond to the published lon/lat footprint. This checks projection math and axis order; round trips do **not** establish absolute registration accuracy. The published source notes random offsets of about 100–200 m relative to the later controlled surface-operations CTX mosaic.

The application grids use different projections/radii: HiRISE equirectangular with radius 3,394,839.813 m and 15° standard parallel, and MOLA simple cylindrical with radius 3,396,000 m. Do not draw source MTM x/y as application local x/y. Preserve the source CRS in processing metadata, transform source x/y to Mars east longitude/latitude, then map that position through the active grid's georeference (`localToLatLon()` / `latLonToLocal()` in `public/js/terrain.js`; active geometry selection and `drawMap()` / `drawCtxMap()` in `public/js/app.js`). A custom Mars-coordinate JSON needs an explicit Mars CRS/convention field; do not label these coordinates as Earth WGS84 GeoJSON.

## Geometry complexity and validity

GEOS validity checks were run on WKB geometries decoded by the OpenFileGDB driver. Results for the main map layers:

| Layer | Geometry count | Components/parts | Holes | Vertices | Invalid geometries |
|---|---:|---:|---:|---:|---:|
| `GeoUnits_v1` | 1,304 | 1,304 polygon parts | 738 | 1,342,139 | 2 |
| `GeoContacts` | 2,496 | MultiLineString | — | 672,680 | 0 |
| `SurfaceFeatures` | 285 | 286 polygon parts | 154 | 206,439 | 1 |
| `LinearFeatures` | 382 | MultiLineString | — | 5,273 | 0 |
| `MapBoundary` | 1 | 1 polygon part | 0 | 403 | 0 |

The two invalid `GeoUnits_v1` rings report self-intersections at source MTM coordinates approximately (-21,522.325, 1,077,592.809) m and (-37,977.371, 1,085,915.340) m. The one invalid `SurfaceFeatures` ring reports a self-intersection near (9,132.236, 1,107,241.589) m. Do not silently repair or drop these; compare each to the published sheet/source GIS and record any repair. The other exposed spatial layers passed GEOS validity checks.

GDAL emitted an `organizePolygons()` warning for a feature with over 100 parts while reading. Thus these validity/count summaries describe the OpenFileGDB-decoded geometry representation; the multipart organization and the three invalid source features should be independently reviewed before geometry is edited. GeoUnits include 738 interior rings, so polygon holes must be retained.

## Processing feasibility and measured preliminary payload

The published map extent is regional Jezero plus Nili Planum, approximately 1° × 1°; it should not be reduced to the crater alone. Clip with the actual valid `MapBoundary` geometry, not a rectangular geographic bbox. `GeoUnits_v1` is already almost exactly coextensive with that boundary, but the boundary remains the authoritative clip. Two invalid unit features could not be safely clipped in the temporary measurement and were kept unchanged; all other unit polygons intersected without clip failure.

A temporary in-memory GeoJSON-style size trial used the 1,304 GeoUnits, `unit`, `name`, `symbol_noSub`, `subscript`, `symbol`, and `Color_ID` properties, the map-boundary intersection for valid features, an explicit Mars 2000 coordinate-system marker, GDAL MTM inverse conversion, five decimal degree coordinate rounding, and gzip level 9. No payload file was written. The two invalid source features were left unsimplified. Measured results:

| Per-feature topology-preserving simplification tolerance | Vertices after clip/simplify | Raw JSON bytes | Gzip bytes | Holes retained |
|---:|---:|---:|---:|---:|
| 0 m (clipped only where valid) | 1,342,309 | 26,804,847 | 6,404,077 | 738 |
| 15 m | 74,911 | 1,739,645 | 439,437 | 738 |
| 30 m | 51,554 | 1,277,741 | 308,718 | 738 |
| 50 m | 37,742 | 1,004,656 | 230,284 | 738 |

These are preliminary polygon-only sizes, not release outputs. The trial uses topology-preserving simplification on each polygon independently; this does not guarantee that adjacent polygons retain identical shared boundary arcs. Production preprocessing should simplify a shared topology/contact network and rebuild the polygons, or otherwise prove shared-edge equality, then compare features and areas to the source map. Invalid polygons require a reviewed remedy before clipping/simplification. Linework would be additional payload; it is not included in the table.

At the publication scale 1:75,000, 15 m corresponds to 0.2 mm on the printed map, 30 m to 0.4 mm, and 50 m to about 0.67 mm. A sensible next visual comparison is 15 m for detailed regional views and 30–50 m for broader views, with topology shared across units. Choose by map scale and feature preservation, not by the smaller byte count alone. The 100–200 m offset against the later operational CTX mosaic is a separate registration limitation, not a reason to simplify boundaries by that amount. When displaying this interpretation over that later mosaic, keep the offset/source note visible and do not imply positional precision at route-hazard scale.

## Recommendation and remaining uncertainties

- Use `GeoUnits_v1` polygons with source labels/symbols, plus `GeoContacts` as separate linework. `GeoContacts.TYPE` distinguishes certain and approximate contacts; render this distinction without presenting it as a general confidence score.
- Consider `LinearFeatures` and selected `SurfaceFeatures` as optional overlays; their source `TYPE` values are usable, but they are geological/cartographic context. Do not add annotation, figures, landing ellipse, or all point features by default.
- Preserve `unit`, `name`, source symbols/subscript, and optionally `Color_ID`; verify color mapping against the supplied `.lyr` symbology/publication sheet. There are no age/lithology/confidence fields and no description table safe to join. Resolve the attribute outliers before presenting a polished inspector.
- Clip with `MapBoundary`; retain multipart geometry and all interior rings. Establish a shared-boundary simplification pipeline and test topological equality before export.
- Serve a compact Mars-specific geometry payload lazily only when selected, independently of elevation/imagery. Label it as interpreted geology, not a direct measurement, route-safety layer, or guarantee.

Remaining uncertainty is the exact relationship-class/annotation linkage behind README item `Anno_68_69`, the intended corrections for the anomalous GeoUnits rows and invalid rings, and color-ID-to-symbol mapping. No absolute registration validation against a later operational image is possible from round-trip math; the 100–200 m source registration caveat remains.

## References

- [Official USGS SIM 3464 page](https://www.usgs.gov/maps/geologic-map-jezero-crater-and-nili-planum-region-mars)
- [Official GIS archive and metadata directory](https://pubs.usgs.gov/sim/3464/)
- [USGS publication record and citation](https://pubs.usgs.gov/publication/sim3464)
