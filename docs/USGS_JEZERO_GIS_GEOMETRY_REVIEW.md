# USGS Jezero GIS Geometry and Symbology Review

**Inspection date:** 2026-11-12  
**Scope:** In-memory review of the previously verified SIM 3464 FileGDB. No source geometry, application code, or processed dataset was changed. The GIS archive was not downloaded again.

## Invalid GeoUnits geometries

OpenFileGDB FIDs below are layer feature IDs; `ORIG_FID` is retained as a source attribute. The source geometries are MultiPolygons. GEOS reports a self-intersection in the exterior ring (ring index 0) for both records. Ring distance was measured against the reported invalidity coordinate and was effectively zero; the interior rings are not the rings identified by these diagnostics.

| FID / ORIG_FID | Complete source attributes (excluding geometry) | Invalidity |
|---|---|---|
| 666 / 669 | `unit="10"`; `name="Upper etched unit"`; `symbol_noSub="Nue"`; `subscript=null`; `symbol="Nue"`; `ORIG_FID=669`; `SHAPE_Length=19970.275286120108`; `SHAPE_Area=2156657.0778694656`; `Color_ID=74` | Ring Self-intersection at MTM `(-21522.3252644166, 1077592.80853944)` m; exterior ring (index 0). |
| 1155 / 1159 | `unit="10"`; `name="Upper etched unit"`; `symbol_noSub="Nue"`; `subscript=null`; `symbol="Nue"`; `ORIG_FID=1159`; `SHAPE_Length=742636.9475566589`; `SHAPE_Area=260492440.4639951`; `Color_ID=74` | Ring Self-intersection at MTM `(-37977.3708333671, 1085915.33964684)` m; exterior ring (index 0). |

`GEOSMakeValid` was applied in memory only. It returned a single Polygon for each feature and both outputs passed GEOS validity. Areas and perimeters below are GEOS-computed before/after measures in the source projected meter coordinates; floating point differences are far below mapping precision.

| FID | Area before → after (m²) | Area delta (m²) | Perimeter before → after (m) | Parts, vertices, holes before → after |
|---:|---:|---:|---:|---|
| 666 | 2,156,657.0778694698 → 2,156,657.0778694646 | -0.0000000051 | 19,970.27528612013 → 19,970.27528612013 | 1 → 1; 2,816 → 2,817 vertices; 5 → 6 holes |
| 1155 | 260,492,440.46399766 → 260,492,440.46399700 | -0.0000006557 | 742,636.9475566680 → 742,636.9475566678 | 1 → 1; 85,149 → 85,150 vertices; 105 → 106 holes |

Coordinate-sequence comparison found 7 added/6 removed unique vertices for FID 666 and 107 added/106 removed for FID 1155. The largest nearest-coordinate displacement from a removed to an added vertex was respectively 19.9127 m and 95.4616 m. This is a vertex-matching diagnostic, **not** a Hausdorff distance or a certified maximum boundary displacement. A rigorous boundary-distance computation did not complete within the available focused experiment. Area/perimeter stability therefore does not establish that every boundary segment is preserved. The new hole in each repaired geometry is a topological change.

The repaired features retain their source attributes and remain one Upper etched/Nue feature each. That supports retaining the unit identity as a working interpretation, but does not prove the altered local delineation is geologically correct. Do not silently replace the source. Compare each repair with the publication sheet and neighboring contacts; if accepted, store it as a documented, versioned processing override and retain the source geometry unchanged.

## Attribute anomalies

The values below are the complete source attributes other than geometry. Official publication material uses “Upper etched unit (Nue),” “Rugged bright unit (Nrb),” and “crater rim (cr).” The records themselves remain unchanged.

| FID / ORIG_FID | Complete source attributes | Recommendation for display |
|---|---|---|
| 112 / 112 | `unit="5"`; `name="Upper etched unit"`; `symbol_noSub="Nnp"`; `subscript="2"`; `symbol="Nue"`; `ORIG_FID=112`; `SHAPE_Length=2122.7797248993797`; `SHAPE_Area=185554.00975669292`; `Color_ID=74` | Flag internal conflict: the name, final symbol, and Color_ID align with Upper etched/Nue, while unit and symbol components conflict. Display “Upper etched unit · Nue” only as a documented display correction based on the publication; preserve and expose the raw source values. Do not infer a correction to `unit` without authoritative evidence. |
| 561 / 562 | `unit="9"`; `name="Rugged bright unit"`; `symbol_noSub="Nrb"`; `subscript="2"`; `symbol="Nrb"`; `ORIG_FID=562`; `SHAPE_Length=1927.1448970408812`; `SHAPE_Area=199072.90054781263`; `Color_ID=203` | Publication identifies the unit as Nrb without a subscript. Display Nrb and flag the raw `subscript="2"`; do not silently erase it in provenance. |
| 1004 / 914 | `unit="11"`; `name="Crater riim unit"`; `symbol_noSub="cr"`; `subscript=null`; `symbol="cr"`; `ORIG_FID=914`; `SHAPE_Length=206538.83634887057`; `SHAPE_Area=107453355.12247822`; `Color_ID=355` | Display “Crater rim unit” as an explicit spelling correction supported by the publication; preserve the original misspelling in raw attributes/provenance. |

The USGS pamphlet supports the unit-name/symbol pairings above, but does not resolve the anomalous `unit` code or prove which component field was mistyped in FID 112. Treat display normalization as a separate, auditable mapping, never as a rewrite of the source table.

## Symbology evidence

The original archive contains these ArcGIS `.lyr` style files: `LinearFeatures.lyr` (18,432 bytes), `GeoContacts.lyr` (10,240), `GeologicUnits.lyr` (18,944), `SurfaceFeatures.lyr` (12,800), and `LocationFeatures.lyr` (10,240). They are OLE Compound File Binary documents with an internal `Layer` stream. The included README identifies them as symbology definitions. No ArcMap/ArcPy-compatible style reader is available in the existing GIS environment, and the published sheet preview is insufficient for pixel-exact color sampling. **Exact RGB colors, line widths, and dash lengths are therefore unresolved; no palette is proposed here.**

The `Color_ID` values are present in `GeoUnits_v1`, but are category identifiers and not RGB values. The actual category-to-ID mapping observed in the feature records is:

| Color_ID | Unit symbol | Source name |
|---:|---|---|
| 74 | Nue | Upper etched unit |
| 51 | Aeb | Eolian bedform unit |
| 250 | su | Smooth unit, undivided |
| 206 | Nnp2 | Nili Planum 2 unit |
| 203 | Nrb | Rugged bright unit |
| 21 | Nnp1 | Nili Planum 1 unit |
| 480 | ce | Crater ejecta unit |
| 90 | ci | Crater interior unit |
| 355 | cr | Crater rim unit |
| 13 | Njf | Jezero floor unit |
| 55 | Nle | Lower etched unit |
| 504 | Hnpf | Nili Planum fan unit |
| 603 | NHjf2 | Jezero fan 2 unit |
| 600 | NHjf1 | Jezero fan 1 unit |

These IDs are not a color mapping and must not be converted to colors by assumption. Recover colors from the `.lyr` renderer or an authoritative publication legend in a later, reproducible step. `GeoContacts.TYPE` records 1,666 `certain`, 829 `approximate`, and 1 `boundary`. The published map legend defines a solid contact where accurately located and dashed where approximately located. This supports a qualitative solid/dashed distinction; exact stroke pattern and dimensions remain unavailable. `boundary` is a separate source classification, not a confidence level; its precise line style is unresolved.

## Shared-boundary experiment

An in-memory comparison used two valid neighboring source polygons: FID 690 (Eolian bedform/Aeb, Color_ID 51) and FID 768 (Upper etched/Nue, Color_ID 74). Before simplification, both were individually valid, their shared boundary measured 14,375.4061 m, and their overlap area was zero. The same topology-preserving simplification operation was then applied independently to each polygon. Each result remained individually valid, but boundaries stopped matching and the pair developed overlap:

| Independent tolerance | Shared line remaining (m) | Overlap area (m²) | Area delta FID 690 (m²) | Area delta FID 768 (m²) |
|---:|---:|---:|---:|---:|
| 15 m | 10,742.1649 | 2,996.1957 | -15,506.19 | +121,282.65 |
| 30 m | 8,618.3417 | 9,453.6107 | -12,314.94 | +80,746.92 |
| 50 m | 8,292.8047 | 13,661.1507 | +73,723.52 | +180,061.05 |

This pair test directly demonstrates that individual topology preservation is not shared-boundary preservation. Gap area was not measured in this experiment, and these figures are not whole-map statistics. A separate full-coverage audit is required to quantify gaps and overlaps.

The earlier schema report measured polygon-only preliminary payloads (all 1,304 GeoUnits; clipped where valid; two invalid records left unchanged): 26,804,847 raw / 6,404,077 gzip bytes without simplification; 1,739,645 / 439,437 bytes at 15 m; 1,277,741 / 308,718 at 30 m; and 1,004,656 / 230,284 at 50 m. Those measurements used independent per-feature simplification and do not demonstrate adjacency preservation. They are useful only as size baselines. No comparable payload measurement was made for reconstructed shared topology.

### Recommendation

1. First review the invalid source rings against the map and contact linework. Keep source geometries immutable and track any accepted repair as a separate processing decision.
2. Build a planar shared-arc graph from the complete polygon boundary network in the verified source MTM CRS. Node intersections, deduplicate coincident arcs, and preserve junctions, endpoints, holes, and map-boundary intersections. Simplify each unique arc once, then reconstruct polygon faces and reattach original feature attributes. Do not assume `GeoContacts` alone is complete enough to reconstruct every polygon boundary; compare it to the polygon-derived network.
3. Validate all outputs individually and as a coverage: valid polygons, matching shared arc coordinates, no unintended gaps or overlaps, preserved holes/components and feature identities, and documented area/boundary deltas against source. Compare contacts and uncertain boundaries with the source map. Re-run size measurements on this actual output.
4. Use **15 m** as the first shared-arc display simplification candidate. At the publication scale 1:75,000, this is 0.2 mm on the sheet and is less aggressive than 30–50 m. It is a candidate, not yet validated for narrow units or holes; compare it visually and structurally with the unsimplified source before release. Retain the original geometry as the fidelity baseline. Consider a 30 m generalized variant only for a broader-scale view after the same validation. Do not use 50 m as the primary detailed layer based on bytes alone.
5. Export ordinary Mars-coordinate GeoJSON if its duplicated shared-edge coordinates are byte-efficient enough; a custom arc-index format can deduplicate storage but adds client complexity. Whichever representation is selected must preserve exact shared coordinates after serialization/rounding and explicitly identify the Mars 2000 sphere, east-positive longitude, and latitude convention.

## Scientific limitations and references

The source map is an interpreted regional geologic map, not direct live measurements. Its metadata notes approximately 100–200 m registration offsets relative to a later operational CTX mosaic; that does not justify increasing simplification tolerance. It has no structured age, lithology, or confidence fields in the polygon schema. `certain`/`approximate` contact classes describe mapped contact location, not a general confidence or hazard score. Do not present the overlay as route safety or hazard certification.

Unresolved items are exact `.lyr` RGB and line style parameters; the intended corrected source fields for the three anomalous records; whether the two `MakeValid` changes are geologically faithful at the self-crossing locations; certified boundary displacement for those repairs; and whole-map gap/overlap effects and payload size after a shared-arc reconstruction.

- Sun & Stack (2020), *Geologic Map of Jezero Crater and the Nili Planum Region*, USGS SIM 3464, DOI [10.3133/sim3464](https://doi.org/10.3133/sim3464).
- [USGS publication page](https://pubs.usgs.gov/publication/sim3464)
- [Official map sheet](https://pubs.usgs.gov/sim/3464/sim3464.pdf)
- [Official pamphlet](https://pubs.usgs.gov/sim/3464/sim3464_pamphlet.pdf)
- [Official SIM 3464 GIS archive directory](https://pubs.usgs.gov/sim/3464/)
