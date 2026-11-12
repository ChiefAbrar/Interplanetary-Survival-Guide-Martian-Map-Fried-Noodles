# USGS Jezero GIS Source Audit

**Audit date:** 2026-11-12  
**Scope:** Official SIM 3464 source archive and its documented metadata. This is a source audit only; no browser layer or processed overlay was produced.

## Retrieval and preservation

The official directory listed `sim3464_database.zip` (333 MB), `sim3464_metadata.txt` (20 KB), `sim3464_metadata.xml` (20 KB), and `sim3464_readme.txt` (3.8 KB). These exact listed files were downloaded from:

- Archive: <https://pubs.usgs.gov/sim/3464/sim3464_database.zip>
- Text metadata: <https://pubs.usgs.gov/sim/3464/sim3464_metadata.txt>
- XML metadata: <https://pubs.usgs.gov/sim/3464/sim3464_metadata.xml>
- README: <https://pubs.usgs.gov/sim/3464/sim3464_readme.txt>

The files are in the Git-ignored `tmp/usgs-jezero-gis-audit/` directory. The source ZIP is unchanged.

| File | Downloaded bytes |
|---|---:|
| `sim3464_database.zip` | 349,336,873 |
| `sim3464_metadata.txt` | 20,767 |
| `sim3464_metadata.xml` | 20,924 |
| `sim3464_readme.txt` | 3,914 |

**ZIP SHA-256:** `A88BD53A5573743CC4A20036C10E585106D08A433AD2F34AF269E9CEA1529F87`  
The official directory reports 333 MB (334 MiB); the downloaded archive is 349,336,873 bytes. The ZIP contains 181 entries (including directory entries) and 514,926,981 bytes uncompressed. D: had approximately 71 GB free before retrieval.

## Archive inventory

The ZIP contains the `sim3464_JezeroNili_FINAL/` project directory, an ArcMap `.mxd`, embedded metadata, five `.lyr` symbology files, two `.prj` definitions, one file geodatabase, and regional raster source/reference layers. The archive contains **no Shapefile feature layers**: the only `.prj` files are under `CoordinateSystems/`, not shapefile sidecars. The separately published FGDC metadata describes a `Jezero_GeoUnits.shp Attribute Table`; that name does not mean a Shapefile is present in this ZIP.

The README identifies one geodatabase feature dataset, `Mars2000Sphere_MTM_Clon77_5E`, in `Geodatabase/Nili.gdb`, with these 14 feature classes:

| Feature class | README geometry/role |
|---|---|
| `Anno_68_69` | Relationship file |
| `CrossSections` | Polyline |
| `Figures` | Polygon |
| `FiguresAnno` | Annotation |
| `GeoContacts` | Polyline |
| `GeoUnits_v1` | Polygon |
| `GeoUnitsAnno` | Annotation |
| `LandingEllipse` | Polygon |
| `LinearFeatures` | Polyline |
| `LocationFeatures` | Point |
| `MapBoundary` | Polygon |
| `megabreccia_fig2` | Point |
| `Nomenclature` | Annotation |
| `SurfaceFeatures` | Polygon |

The useful likely browser content is `GeoUnits_v1` for mapped unit polygons, `GeoContacts` for unit boundaries/contact linework, and possibly selected `LinearFeatures`, `SurfaceFeatures`, and `LocationFeatures` after inspecting their schemas and map roles. Annotation and figure classes are cartographic support and should not be added wholesale to an interactive layer.

The ZIP also contains:

- `CoordinateSystems/MTM_clon77_5E.prj` and `Mars2000_Sphere.prj`.
- Symbology files: `LinearFeatures.lyr`, `GeoContacts.lyr`, `GeologicUnits.lyr`, `SurfaceFeatures.lyr`, and `LocationFeatures.lyr`.
- CTX mosaic: `Nili_CTX_Mosaic_Beta01_Feb2018_MTM.tif` (about 75.8 MB; README identifies a 6 m/pixel mosaic).
- Four CTX stereo ortho/DTM rasters (6 m ortho and 20 m DTM products, plus overviews).
- HRSC source DEM, clipped DEM, and hillshade rasters.
- THEMIS daytime and nighttime controlled IR rasters.

The ZIP has 20 `.gdbtable` files totaling 28,893,717 bytes and 10 `.tif` files totaling 403,189,308 bytes. Those byte totals describe archive contents, not the extracted browser layer.

## Projection and geographic reference

The archive's `MTM_clon77_5E.prj` contains:

```text
PROJCS["MTM_clon77.5E",
 GEOGCS["Mars_2000_(Sphere)",
  DATUM["Mars_2000_(Sphere)",SPHEROID["Mars_2000_(Sphere)",3396190.0,0.0]],
  PRIMEM["Reference_Meridian",0.0],UNIT["Degree",0.0174532925199433]],
 PROJECTION["Transverse_Mercator"],
 PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],
 PARAMETER["Central_Meridian",77.5],PARAMETER["Scale_Factor",1.0],
 PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]
```

The accompanying FGDC metadata independently reports Transverse Mercator, central meridian 77.5, latitude of origin 0, scale factor 1, false easting/northing 0, coordinate units meters, datum/ellipsoid `Mars_2000_(Sphere)`, and semimajor axis 3,396,190 m. The separate `Mars2000_Sphere.prj` confirms a spherical body with zero flattening. Metadata bounding coordinates are 76.8–77.8° E and 17.7–18.7° N.

- **Projection:** spherical Mars Transverse Mercator (MTM), central meridian 77.5°, origin latitude 0°, scale 1, zero false offsets.
- **Body/datum:** Mars 2000 sphere, radius 3,396,190 m (inverse flattening 0).
- **Units and coordinate pair:** projected meters; MTM map coordinates are x/easting then y/northing. The metadata describes coordinate pairs and the `.prj` is an x/y projected CRS.
- **Longitude:** east-positive is supported by the metadata's 77.5° E central meridian and east-longitude footprint.
- **Latitude:** the `.prj`/FGDC files do not include an explicit planetocentric/planetographic flag. On a sphere the two latitude values coincide, so this distinction does not change the numeric conversion. Record the source convention as *not explicitly tagged*, rather than inferring a non-spherical datum.
- **Axis order:** the archive defines projected coordinate pairs but does not provide a separate formal axis-order clause. A converter should read the WKT as x/easting, y/northing and assert that order with control checks.

No ArcGIS, GDAL/OGR, `pyproj`, Shapely, or Python Shapefile reader was installed in the available environment. The file geodatabase's feature geometry, feature counts, coordinate extents, and field schemas could therefore not be decoded or independently transformed here. No dependencies were installed. A forward/inverse control-point check against the publication map was not feasible with the available local tools. The CRS parameters above are directly verified from both `.prj` and FGDC metadata; control-point validation remains outstanding.

## Project coordinate compatibility and conversion

Mars Survival's current raster georeferences use other Mars projections/radii:

- The HiRISE Jezero grid is equirectangular, planetocentric, radius 3,394,839.813 m, center longitude 77.44° E, standard parallel 15°.
- The MOLA grid is simple cylindrical, planetocentric, radius 3,396,000 m, east-positive.
- `public/js/terrain.js` exports `localToLatLon()` and `latLonToLocal()` for those terrain grids; `public/js/app.js` selects the active geometry with `activeMapGeometry()`. CTX geometry is obtained from the sampler.

Do not treat USGS MTM x/y as if it were a terrain grid's local x/y, and do not substitute Earth/WGS84 or an unrelated USGS ArcGIS annotation-service CRS. Convert the official spherical MTM coordinates to Mars 2000 longitude/latitude using the exact archive CRS, then project that geographic position into whichever active terrain grid is displayed. A browser-ready vector should declare an explicit longitude/latitude order and convention (prefer `[east longitude, planetocentric latitude]`) and keep the source CRS and conversion provenance alongside the asset. The target map transform must use the selected raster's documented radius, center, and standard parallel rather than reusing the source MTM coordinates.

The application functions to integrate against, if implementation proceeds, are `activeMapGeometry()`, `drawMap()`, `drawCtxMap()`, and `terrainPointFromEvent()` in `public/js/app.js`, plus the geographic transform helpers in `public/js/terrain.js`. Draw the geology as a separate canvas overlay after the base raster/tile footprint and before route/marker strokes. `drawCtxMap()` currently takes an early-return path from `drawMap()`, so that path also needs the independent overlay. Do not fold geology into elevation/slope `layerImage()`; its visibility should be independent of selected elevation and imagery.

## Documented geology attributes and useful display fields

The downloaded FGDC text metadata documents a table named `Jezero_GeoUnits.shp Attribute Table` and these fields (types/widths are not described there):

| Field | Metadata description | Use |
|---|---|---|
| `unit` | Unit number | Stable compact code/feature identity where unique. |
| `name` | Unit name | Primary human-readable inspector label. |
| `symbol` | Abbreviated unit name | Map label, including unit subscripts encoded in the symbol. |
| `symbol_noS` | Unit symbol without subscript | Base symbol when a simpler legend label is needed. |
| `subscript` | Subscript for unit symbol | Separate display of symbol suffix. |
| `FID`, `OBJECTID`, `ORIG_FID` | Feature IDs | Internal/source bookkeeping; avoid presenting as geology. |
| `Shape`, `SHAPE_Leng`, `SHAPE_Area` | Geometry/derived shape values | Not interpretive geology; omit from normal inspector. |

Metadata lists unit names including Jezero floor, Jezero fan 1/2, crater rim/interior/ejecta, upper/lower etched, eolian bedform, smooth undivided, Nili Planum units and Nili fan. It also lists unit codes/symbols; preserve source spelling and symbols unless checked against the map legend (the metadata contains the spelling `Crater riim unit`). The documented GeoUnits attributes do not supply explicit age, lithology, or confidence fields. Do not synthesize those values from labels; link to the official map/pamphlet unit descriptions if richer geology is needed. Attribute schemas and relationships for the remaining geodatabase classes are unresolved pending a FileGDB-capable inspection.

For the initial browser layer, use unit fill colors keyed to the official map's unit symbol, subtle translucent fills so terrain/imagery remains legible, and crisp contacts on top. A feature inspector should show the source symbol, exact unit name, source citation, and a note that boundaries/units are mapped geological interpretations. Do not style confidence or age classes unless the official source attributes/pamphlet support those classifications.

## Footprint, clipping, simplification, and output size

The publication covers exactly 1° × 1° (about 60 × 60 km), 76.8–77.8° E and 17.7–18.7° N. It is a **Jezero and Nili Planum regional map**, not a Jezero-crater-only map. Keep that full published map extent for the regional layer. Use the geodatabase `MapBoundary` polygon as the authoritative clip if a tighter raster/browser footprint is needed; do not clip by an approximate rectangular bounding box alone.

Recommended preprocessing after a FileGDB reader is available:

1. Read and validate `GeoUnits_v1`, `GeoContacts`, and needed line/point classes in the source MTM CRS; inventory their field types, domains, feature counts, geometry validity, and extents.
2. Clip with the actual `MapBoundary` geometry while preserving holes and multipart features.
3. Simplify in the verified projected meters, topology-preserving and consistently across shared boundaries. A 5–10 m tolerance is a reasonable first visual trial against the 6 m/pixel source CTX mosaic, not an accepted final value. Compare both tolerances to the publication map; protect narrow units, small polygons, holes, and contact topology.
4. Transform only after clipping/simplification, with the verified spherical Mars MTM inverse transform; test round trips and named geographic control locations.
5. Export polygon `MultiPolygon` geometries with only useful source attributes. GeoJSON is compatible with the existing plain browser/Canvas stack and preserves rings and multipart polygon geometry; keep linework as separate features or a separate file. Do not flatten polygon holes. Consider a gzip-served GeoJSON asset and fetch it only when the layer is selected.

**Size assessment:** the entire geodatabase has 28,893,717 bytes of `.gdbtable` content before the archive's indexes/metadata, but a final layer size cannot be measured from that total. No FileGDB-capable reader was available to count vertices, clip, or trial-simplify; a specific GeoJSON/gzip size estimate would be speculative. Measure actual feature/vertex counts and both raw/gzip output sizes in the preprocessing trial before setting a release budget. The full 349 MB archive is not appropriate for browser delivery.

## Registration and interpretation cautions

The README and FGDC metadata say the map was made on a semi-controlled CTX mosaic before the controlled surface-operations mosaic was released; random offsets of about 100–200 m from the surface-operations CTX mosaic are expected. Coordinate math alone will not eliminate that source registration offset. Verify overlay alignment against the map's own base mosaic and independent recognizable features; document the offset when comparing to later operational imagery or rover products.

This layer is a regional geological interpretation based on image texture, tone, morphology, margins, location, and stratigraphic relations, not direct live measurements. The official description states that CTX at 6 m/pixel was the primary base; THEMIS night IR, terrain models, HRSC, and HiRISE also aided unit interpretation.

## Attribution and use

Required project citation:

> Sun, V.Z., and Stack, K.M., 2020, *Geologic map of Jezero crater and the Nili Planum region, Mars*: U.S. Geological Survey Scientific Investigations Map 3464, pamphlet 14 p., 1 sheet, scale 1:75,000, https://doi.org/10.3133/sim3464.

The USGS publication/media page identifies the map as Public Domain. The pamphlet qualifies that most of the product is public domain and that any copyrighted material is identified in its text; no specific third-party restriction was found in the downloaded README or metadata. Retain the author/source citation and check the pamphlet's item-specific notices before redistributing any embedded imagery or non-geology raster from the archive. The archive README itself requests the original citation. The metadata's access constraint is `None`; it also carries a no-warranty statement.

## Outstanding items before implementation

- Inspect the actual FileGDB schemas, field types, class-level metadata, feature/vertex counts, extents, and unit/description-table relationships with a compatible GIS reader.
- Verify how the ArcGIS FileGDB stores each class CRS and any layer-specific differences from the README's common Mars MTM feature dataset.
- Establish independent forward/inverse control points and compare transformed polygons to the publication sheet and its own CTX base mosaic.
- Measure clipping and 5 m/10 m topology-preserving simplification outputs, including raw and gzip sizes; test holes, multipart features, shared boundaries, narrow units, and antimeridian/longitude handling (the supplied footprint is far from the antimeridian).
- Confirm any symbol colors/labels against the official map sheet rather than relying only on ArcMap `.lyr` files.
- Preserve the stated 100–200 m source mosaic registration caveat in layer metadata and UI attribution.

## References

- [Official USGS SIM 3464 page](https://www.usgs.gov/maps/geologic-map-jezero-crater-and-nili-planum-region-mars)
- [Official GIS archive directory](https://pubs.usgs.gov/sim/3464/)
- [Official publication record and citation](https://pubs.usgs.gov/publication/sim3464)
- [SIM 3464 pamphlet](https://pubs.usgs.gov/sim/3464/sim3464_pamphlet.pdf)
