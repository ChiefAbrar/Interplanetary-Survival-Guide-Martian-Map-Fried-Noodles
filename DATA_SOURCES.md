# Data sources and processing

The MOLA source below was inspected directly from the supplied PDS label and the dataset was decoded locally. The global Viking VIS image layer is distinct from numerical elevation products. Other links describe planned or reference datasets and are not evidence that those layers are integrated.

## Used by the application

### Mars globe imagery: NASA Mars Trek Viking VIS Global Color Mosaic (integrated)
- Layer: `Mars_Viking_MDIM21_ClrMosaic_global_232m`
- Catalog: [NASA Mars Trek WMTS catalog](https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars)
- Capabilities: `https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/WMTSCapabilities.xml`
- Instrument / Mission: Viking Orbiter Visual Imaging Subsystem (VIS) / USGS Astrogeology Science Center MDIM 2.1 Colorized Global Mosaic.
- Format: `image/jpeg`, TileMatrixSet: `default028mm`, CRS: `urn:ogc:def:crs:EPSG::104905` (Mars Equirectangular).
- Resolution: Nominal source resolution approximately 232 m/pixel (zoom matrices 0–7; matrix 0 has 2 columns × 1 row of 256×256 tiles).
- Tile ResourceURL: `https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0//{Style}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.jpg`
- CORS: Verified live with `Access-Control-Allow-Origin: *` headers, enabling direct browser WebGL texture upload without proxying.
- Planetary geometry: Rendered on an oblate Mars reference ellipsoid (equatorial radius: 3,396,190 m; polar radius: 3,376,200 m; axis ratio: ~0.994114) with planetocentric latitude and east-positive longitude.
- Credit: NASA / JPL-Caltech / USGS Astrogeology Science Center / NASA Mars Trek service.

### Regional CTX and HiRISE imagery and metadata (integrated / planned)
- Regional CTX global WMTS (`CTX_beta01_uncontrolled_5m_Caltech`) and controlled Jezero mosaics (`JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0`, `JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first_dd`).
- Note: CTX orbital optical photomosaics are visual imagery products and are distinct from numeric elevation surfaces (DEMs/DTMs). High-resolution CTX elevation models and HiRISE terrain models are handled as separate scientific products.

### MOLA MEGDR median topography (integrated)
- Product: `MEGT44N000HB` (PDS label: `data/raw/mola/megt44n000hb.lbl`)
- Archive: [NASA PDS Geosciences Node MEGDR 128 px/degree products](https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg128/)
- Mission / instrument: Mars Global Surveyor / Mars Orbiter Laser Altimeter (MOLA)
- Label-declared raster: 11,520 samples × 5,632 lines; signed 16-bit MSB integer; metre elevations; 0.463 km/pixel; simple cylindrical; east-positive; planetocentric; 0–90°E and 0–44°N. The downsampled tile crops incomplete 17-pixel edge blocks and records its smaller retained footprint (~0–89.91°E, ~0.04–44°N).
- Product measures median topography above the MOLA areoid. It is not a planetary-radius image or shaded-relief product.
- Processing: `tools/mola_to_tile.py` validates product ID, sample type, dimensions, line size, units, projection and coverage. It reads signed big-endian values from the actual IMG, treats −32768 as no-data, block-averages 17 × 17 cells, then writes the planner tile `public/data/mola-megt44n000hb.json`. The checked-in derived tile contains about 224,000 valid cells at 7.871 km projected spacing. The build regenerates it from the local raw pair when both source files exist.
- Coordinate handling: projected x follows the product's simple cylindrical convention; latitude/longitude conversion uses the label's radius, projection centre, and coverage. Terrain slope and route horizontal distances correct east-west spacing by cos(latitude). This is a regional projection correction, not a full ellipsoidal geodesic solver.
- Credit: NASA / MGS MOLA Science Team / PDS Geosciences Node.

### Terrain: HiRISE digital terrain model (integrated)
- Product: `DTEEC_045994_1985_046060_1985_U01` (stereo pair ESP_045994_1985 / ESP_046060_1985), now downloaded, validated and integrated as a planner-sized derivative.
- Mission / instrument: Mars Reconnaissance Orbiter, HiRISE
- Product page and source IMG: [HiRISE Jezero DTM](https://hirise.lpl.arizona.edu/dtm/ESP_045994_1985)
- Credit: NASA/JPL-Caltech/University of Arizona
- Source files: `data/raw/hirise/DTEEC_045994_1985_046060_1985_U01.IMG` (380,814,764 bytes, excluded from Git) and the associated original orthomosaic label `data/raw/hirise/ESP_046060_1985_RED_C_01_ORTHO.LBL`. HiRISE stores this DTM label attached at the start of its IMG; there is no detached DTM `.LBL` in the official directory. SHA-256 of the downloaded IMG: `b40739b4d32516ef9b3cd849f519a6a20df9720b5369a9c141047ced27c57654`.
- Attached DTM label: 14,266 lines × 6,673 samples, one band, 32-bit `PC_REAL` (little-endian IEEE float), fixed 26,692-byte records, 14,267 total records, `^IMAGE=2` (26,692-byte data offset). File size matches that record structure exactly. The missing bit pattern is `0xFF7FFFFB`; linear scaling is 1.0 with 0 m offset. Decoded source samples span −2,679.2019 to −2,388.3052 m, within the label's −2,679.20 to −2,388.31 m valid range (differences under 0.01 m are float representation precision). 70,220,645 source samples are finite and non-null.
- The DTM's attached label ends after its `IMAGE` object and has no projection object. The map transform comes from the official `ESP_046060_1985_RED_C_01_ORTHO.LBL`: its `SOURCE_PRODUCT_ID` names this DTM, its 6,673 × 14,266 image dimensions match exactly, and it declares Equirectangular, planetocentric, east-positive coordinates, 58,684.0491709 pixels/degree, 1.0096633268711 m/pixel, a 3,394,839.8133163 m map radius, 15° standard parallel, centre longitude 77.44°E, and line/sample projection offsets 1,088,495.5 / 3,210.5. Its reported longitude/latitude bounding coordinates contain the offset-derived raster footprint.
- Processing: `tools/hirise_to_tile.py` verifies the attached record and image layout, PDS type, no-data bit pattern, elevation units/datum, source product ID, hash and the matching ortho label before deriving `public/data/jezero-hirise-tile.json`. It block-averages 20 × 20 source posts; blocks with fewer than half valid source pixels remain no-data. Derivative: 333 × 713 cells, 175,551 valid overview cells, projected cell size 19.505 × 20.193 m, about 18.5 m east-west ground spacing near 18.4°N. Offset-derived footprint: about 77.38530–77.49879°E, 18.30540–18.54840°N. The builder regenerates this derivative when both local source files are present.
- Used for elevation, computed slope, routes, route metrics and elevation profiles only inside its valid local raster. The built-in sample traverse is about 211 m on valid cells. The planner grid is about 20 m, not the native 1 m posting; this does not resolve sub-cell hazards and is not an astronaut safety assessment. Elevations are metres above the Mars 2000 equipotential surface (areoid), not radius.

### Radiation reference: Curiosity RAD
- Value: 0.64 mSv/day surface dose equivalent rate (galactic cosmic rays), Gale Crater
- Reference: Hassler et al. 2014, Science 343, 1244797, https://doi.org/10.1126/science.1244797 (number quoted from memory; re-check)
- Used for: baseline of the modeled radiation layer and route dose. Scaled by sky-view factor (1 − mean sin² of horizon elevation over 8 azimuths, 2 km search) and a scenario multiplier (1.0 or an arbitrary 1.5).
- Limit: not measured at Jezero; ignores atmosphere, ground albedo and solar particle events.

### Mars local time: Mars24 algorithm
- Allison and McEwen 2000; NASA GISS tool https://www.giss.nasa.gov/tools/mars24/
- Used for: the "computed time at Jezero now" button (longitude 77.4° E). The small TT−UT term is omitted.

## CTX terrain product: integrated with limitations

### Mars 2020 Science Investigation CTX DEM Mosaic (processed tiles; manual-route UI)
- Product: `Mars 2020 Science Investigation CTX DEM Mosaic`; PDS4 LID `urn:nasa:pds:mars2020_ctx_basemap_2021:data:m20_ctxdem_mosaic`.
- Mission / instrument: Mars Reconnaissance Orbiter / Context Camera (CTX). Product publisher: USGS Astrogeology Science Center. Publication date: 2021-10-14.
- Official source raster: [20 m GeoTIFF](https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/ScienceInvestigationMaps_JPL/M20_JezeroCrater_CTXDEM_20m.tif). Its small PDS4 XML sidecar was retrieved from [the official USGS-hosted metadata URL](https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/CTX/ScienceInvestigationMaps_JPL/M20_JezeroCrater_CTXDEM_20m.xml) and retained as `test/fixtures/ctx_jezero_dem.xml`; normalized fields are in `data/sources/ctx-jezero-dem.json`. The source GeoTIFF is retained under `data/raw/ctx-jezero/` and the processed, checksummed 99-tile collection under `data/processed/ctx-jezero/`.
- PDS4 label raster: 4,456 samples × 5,067 lines, one band, `IEEE754LSBSingle` (little-endian float32), 20 m × 20 m. The label's missing constant is `−3.4028234663852886e+38`. It provides no valid elevation minimum/maximum, and no scale or offset fields were found in the label.
- Projection: Equirectangular, projection origin latitude 0°, standard parallel 18.4663°, central meridian 0°, spherical radius 3,396,190 m, planetocentric latitude, positive-east longitude, projected metres. PDS4 gives upper-left corner x/y ≈ 4,328,999.999999998 / 1,143,420.000000003 m. Interpreted as an outer corner, the GDAL-order transform is approximately `[4329000, 20, 0, 1143420, 0, -20]`; cell centers are offset half a pixel inward. Bounds from the label are 76.997437–78.582563°E, 17.580520–19.290187°N (planetocentric).
- Vertical reference: the PDS4 sidecar does not state an explicit complete-mosaic vertical datum/reference surface. The USGS product record says added DEMs were vertically localized to the MOLA dataset; its scope and exact operation across mosaic components are not further specified. The record says horizontal positioning is accurate to a control net but gives no numeric horizontal or vertical error bound. Treat the exact vertical datum, numeric accuracy, and valid elevation range as unknown pending stronger source documentation.
- Citation / use: PDS4 cites Mangold et al. (2021), [doi:10.1126/science.abl4051](https://doi.org/10.1126/science.abl4051). The USGS product record lists Fred Calef as primary author, states public domain, and requests citation of authors. The product record describes a 20 m/pixel stereo mosaic including the original TRN DEM and added Ames Stereo Pipeline DEMs; it says added DEMs were localized vertically to MOLA and some horizontal georeferencing was done in ArcGIS Pro.
- The browser tile manager validates the catalog, sidecar metadata, binary size and per-tile SHA-256; the sampler supports manual drawn-route elevation analysis. Automatic CTX Dijkstra routing is not implemented. Do not merge CTX elevations with HiRISE values until overlap and vertical-reference behavior are checked against source data. The existing HiRISE source has a 3,394,839.8133163 m projection radius and its DTM label declares metres above the Mars 2000 equipotential surface; the CTX label radius is 3,396,190 m. Both use equirectangular projection, planetocentric latitude, east-positive longitude and 20 m grid spacing, but different radii/standard parallels require preserving each product's own georeference. CTX directly declares an upper-left corner; the existing HiRISE converter derives the northwest grid corner from PDS3 line/sample projection offsets with a half-pixel adjustment. Equivalent registration and pixel-level alignment have not been established. The existing HiRISE planner footprint (77.385300–77.498789°E, 18.305400–18.548396°N) lies within the CTX bounds; approximate overlap is 0.113489° longitude × 0.242996° latitude, or about 6.4 × 14.4 km near 18.43°N.

### USGS Jezero geology (optional regional overlay)

- Source: Sun & Stack (2020), *Geologic Map of Jezero Crater and the Nili Planum Region*, USGS SIM 3464, [DOI 10.3133/sim3464](https://doi.org/10.3133/sim3464); [USGS publication page](https://pubs.usgs.gov/publication/sim3464).
- The browser loads `public/data/jezero-geology.json` only when the Geology overlay is selected. `tools/process_jezero_geology.py` rebuilds it from the already retrieved official `sim3464_database.zip` and extracted `Nili.gdb`; the processor verifies the archive SHA-256 against the audited source hash.
- The asset contains 1,304 interpreted map units, 2,496 source contact features and the separate source map boundary. Coordinates are east-positive longitude and planetocentric latitude on the Mars 2000 sphere (3,396,190 m), not Earth/WGS84 coordinates. Original source attributes are retained; documented display corrections are separate.
- The 15 m unit-boundary simplification uses shared-coverage topology and is accepted only after validity, coverage, hole, unit-identity, gap/union and boundary-distance checks. Source GeoContacts are clipped but not simplified. The two audited invalid source polygons have separate MakeValid processing overrides recorded in the asset; those repairs retain a scientific boundary-fidelity limitation.
- This is regional interpreted geology at 1:75,000. The publication reports approximately 100–200 m registration offsets relative to the later operational CTX mosaic. Application visualization colors do not reproduce the unverified `.lyr` RGB styles. This overlay is contextual, not a route-safety or hazard layer.

Perseverance MEDA weather data (https://pds-geosciences.wustl.edu/missions/mars2020/meda.htm), InSight observations, THEMIS, CRISM, GRS and REMS are not currently loaded. Temperature, pressure and dust opacity are scenarios, not current Jezero weather or fits to MEDA or InSight observations. The controlled Jezero CTX and HiRISE optical mosaics are not yet rendered in the application; current global imagery is Viking VIS. Their official WMTS documents were retrieved and stored as parser fixtures:

- CTX `JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0`: bounds 77.1604655–77.6991776°E, 18.2110274–18.7211945°N.
- HiRISE `JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first_dd`: bounds 77.2229331–77.583964°E, 18.3067994–18.669315°N.
- Both advertise image/png, style `default`, Mars CRS 104905, `default028mm`, and 256 × 256 tiles. CTX advertises matrices 0–13; HiRISE 0–17. Comments in the XML contain alternate sample matrices; those are not live entries and are ignored by the parser.
- Current capabilities URLs use `https://trek.nasa.gov/tiles/Mars/EQ/{layer-id}/1.0.0/WMTSCapabilities.xml`. The advertised REST template includes a double slash before the style component; preserve the template as given.
- Verified live image responses at Jezero: CTX matrix 13 row 3258 column 11714 returned a 33,590-byte non-transparent 256 × 256 PNG; HiRISE matrix 17 row 52137 column 187432 returned a 43,332-byte non-transparent 256 × 256 PNG. A neighboring advertised HiRISE matrix-17 tile was transparent despite being in the layer bbox, so inspect actual tile alpha and keep missing imagery transparent. The region layers still need UI integration and alignment against DTM coordinates.

## Synthetic data (not NASA)
`public/data/test-terrain.json` and `test/fixtures/*` are generated by `tools/make_test_dem.py` and `tools/pds_to_tile.py`. They contain no NASA data and exist for testing and demonstration.
