# Scientific Dataset Integration Audit and Plan

**Audit date:** 12 November 2026  
**Scope:** read-only inspection of the current application, local data and provenance, test sources, and official data references. No application code or dataset was changed. This plan is the only requested new file.

## Summary

The project has a real browser globe and local terrain planner, but the available sources do not all have the same status or role:

- The globe loads the global Viking VIS color mosaic as a streamed NASA Mars Trek WMTS image layer.
- The automatic 2D elevation, slope, route, warning, and profile calculations operate on one loaded numeric terrain grid. The home/explore entry path loads the local MOLA derivative; `/regions/jezero` loads the HiRISE DTM derivative.
- The CTX DEM has now been downloaded, converted into a validated 99-tile collection, and implemented in the CTX tile manager and sampler. However, the active `app/views/home/index.html.erb` does not contain the `terrain-source` controls, `ctx-terrain-status`, or retry control expected by `public/js/app.js` and `test/ui_test.py`. The production view therefore cannot select CTX or initialize that analysis flow. Treat it as **data and code present, UI integration currently broken/unavailable**, not as a working user-facing layer.
- CTX/HiRISE optical mosaic capabilities fixtures and parser tests exist, but the browser does not select or display those regional optical WMTS layers.
- The current dataset table and terrain controls are long and partly stale. They expose a synthetic terrain loader and raw-file uploader to every user. The displayed `DATASETS` entry grouping also says CTX is not integrated even though the storage and analysis code have since been added.
- There are no local THEMIS, TES, CRISM, MEDA, RAD observation, or geologic-map files in `data/sources/`, `data/processed/`, or `public/data/`. RAD and Mars24 have different roles: RAD is only a Gale reference constant in the model; Mars local mean solar time is calculated from the computer clock and Jezero longitude.

Do not present optical brightness as elevation, a processed/qualitative thermal mosaic as calibrated temperature, TES thermal inertia as a live thermal observation, MEDA as current Jezero weather, Gale RAD as a Jezero measurement, or scenario values as observations.

## Current architecture and runtime behavior

`app/views/home/index.html.erb` is used for the main page and is also rendered for the `/explore` and `/regions/jezero` Rails routes. The view has one globe canvas, one terrain canvas, route controls, assumptions, science targets, and an open-ended `panel-data` disclosure. Static pages are generated from this same Rails view by `tools/build_dist.py` for `index.html`, `explore/index.html`, and `regions/jezero/index.html`.

`public/js/app.js` imports the terrain parser, model, route planner, Mars globe, and CTX manager/sampler. `public/js/mars-globe.js` requests and parses Viking WMTS capabilities, then fetches image tiles and draws them in WebGL. The globe imagery is visual context only. The 2D renderer draws elevation, computed slope, or a modeled dose visualization for the active numeric grid.

Terrain startup is route-dependent: the main/explore pages load `public/data/mola-megt44n000hb.json`; the Jezero route loads `public/data/jezero-hirise-tile.json`. MOLA and HiRISE feed the ordinary automatic route planner. `public/js/ctx-tile-manager.js` and `ctx-terrain-sampler.js` implement bounded, on-demand CTX tile loading/checksum verification and manual drawn-route sampling, but the active view omits the source selector and supporting elements. The Rails `/ctx-terrain/:file` controller serves `data/processed/ctx-jezero/` locally. Production is expected to use `CTX_TILE_BASE_URL`; static output and Vercel CSP use the same variable. No processed CTX tiles are copied into `public/` or `dist/`.

The existing terrain-source UI and JavaScript are inconsistent with each other and the checked-in UI tests. The plan should first resolve that wiring and confirm the intended CTX-versus-HiRISE workflow before claiming CTX is available. The safe static build should remain the current build path; this audit did not run it or alter the existing Vercel/Render configuration.

## Dataset inventory

| Source | Genuine current status | Product, coverage, scale, coordinates | Access, attribution, and suitability |
|---|---|---|---|
| **1. Viking VIS global imagery** | **Integrated and loaded on the globe.** Runtime WMTS capabilities and image requests are in `mars-globe.js`; current layer constant is `Mars_Viking_MDIM21_ClrMosaic_global_232m`. | Viking Orbiter VIS / USGS Astrogeology MDIM 2.1 global color mosaic; nominal ~232 m/pixel; near-global image context. Mars Equirectangular WMTS, Mars CRS 104905 in the application parser. | Streamed from NASA Mars Trek WMTS, not a local image. Preserve NASA/JPL-Caltech/USGS Astrogeology/Mars Trek credit. Read the current capabilities document rather than hardcoding a made-up tile URL. Appropriate global imagery baseline; not a DEM. [NASA Mars Trek API](https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars). |
| **2. MOLA MEGDR** | **Integrated, locally present, automatically used** on main/explore entry. Raw IMG/LBL, converter, provenance, and derived JSON exist. | `MEGT44N000HB`, MGS MOLA MEGDR median topography. Source raster 11,520 × 5,632 signed 16-bit MSB, 128 px/degree (~463 m/pixel at equator), coverage 0–90°E, 0–44°N. The browser derivative block-averages 17 × 17 postings to ~7.87 km projected cells (latitude-dependent east-west ground distance); it contains about 224k valid cells. Simple cylindrical, planetocentric, positive east; elevation relative to the MOLA areoid. | PDS Geosciences Node source; local raw pair totals ~129.77 MB; derived browser JSON is ~4.11 MB. Credit MGS MOLA Science Team/PDS Geosciences Node. Excellent regional low-resolution fallback, too coarse for local hazard detail. Do not describe its limited source tile as global. [PDS MOLA archive](https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg128/), [MOLA product overview](https://pds-geosciences.wustl.edu/missions/mgs/mola.html). |
| **3. Jezero HiRISE DTM** | **Integrated, locally present, automatically used** on `/regions/jezero`; can also be loaded by the current public terrain controls. Source IMG/label, converter, validation, tests, and derivative exist. | `DTEEC_045994_1985_046060_1985_U01`; local footprint about 6.4 × 14.4 km at Jezero (roughly 77.3853–77.4988°E, 18.3054–18.5484°N). The attached DTM is about 1 m posting; browser derivative 333 × 713 cells at ~19.5 × 20.2 m. Equirectangular, planetocentric, positive east; elevations declared above Mars 2000 equipotential/areoid. | Official source DTM is about 381 MB and the planner JSON about 1.87 MB. Current raw IMG and matching orthomosaic label are local. Credit NASA/JPL-Caltech/University of Arizona. Retain no-data and source/datum limitations; 20 m overview is not sub-cell hazard data. [HiRISE DTM product page](https://hirise.lpl.arizona.edu/dtm/dtm.php?ID=ESP_046060_1985). |
| **4. Jezero CTX DEM** | **Source downloaded and processing verified; modules/storage exist; active UI integration unavailable** because current HTML omits CTX selection/status controls. Not the CTX optical mosaic. | `Mars 2020 Science Investigation CTX DEM Mosaic`, PDS4 LID `urn:nasa:pds:mars2020_ctx_basemap_2021:data:m20_ctxdem_mosaic`. Downloaded GeoTIFF 4,456 × 5,067 float32, 20 m posting, ~76.9974–78.5826°E and 17.5805–19.2902°N. Equirectangular, standard parallel 18.4663°, planetocentric, east-positive, 3,396,190 m sphere. Vertical datum and numeric accuracy for the full mosaic are unresolved in inspected metadata. | Original GeoTIFF is 90,345,300 bytes. Processed collection is 99 tiles (11 × 9), 22,578,552 core pixels, about 90,996,256 binary bytes and 91,571,994 bytes including sidecars/catalog. `data/sources/ctx-jezero-tiles-validation.json` records complete coverage, all tile checksums, matching halos, and successful source/core checks. Local Rails controller or immutable external release is the intended delivery; production requires `CTX_TILE_BASE_URL`. Catalog says MOLA localization for added DEMs but scope is not precise. Do not merge with HiRISE values until vertical/registration checks. USGS record states public domain and requests citation. [USGS product record](https://astrogeology.usgs.gov/search/map/mars_2020_science_investigation_ctx_dem_mosaic), [official PDS4 label](https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/CTX/ScienceInvestigationMaps_JPL/M20_JezeroCrater_CTXDEM_20m.xml), [source TIFF](https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/ScienceInvestigationMaps_JPL/M20_JezeroCrater_CTXDEM_20m.tif). |
| **5. CTX optical mosaics** | **External WMTS metadata fixtures and parser tests exist; not rendered in current UI.** | `JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0`, Jezero footprint ~77.1605–77.6992°E, 18.2110–18.7212°N; nominal 6 m/pixel. Fixture advertises 256 px PNG tiles, Mars CRS 104905, `default028mm`, levels 0–13. | NASA Mars Trek WMTS capabilities and direct image tiles are cited/tested in fixtures; there is no local mosaic download or data conversion. A useful regional optical background to pair with current DEMs. Resolve live service policy/CORS and visually verify the requested tile footprint/alpha before release. Credit the source mission/service. [NASA Mars Trek catalog](https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars), [CTX WMTS capabilities](https://trek.nasa.gov/tiles/Mars/EQ/JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0/1.0.0/WMTSCapabilities.xml). |
| **6. HiRISE optical mosaics** | **External WMTS metadata fixture and parser test exist; not rendered in current UI.** | `JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first_dd`; advertised footprint ~77.2229–77.5840°E, 18.3068–18.6693°N; product name indicates 25 cm nominal imagery. Fixture advertises PNG/Mars CRS 104905, `default028mm`, levels 0–17. Actual tiles can be transparent within the advertised bounding box. | Stream selectively at high zoom as imagery only; never treat it as topography. No local mosaic copy. Credit NASA/JPL-Caltech/University of Arizona/Mars Trek as product metadata requires. Check CORS, alpha, and image/DEM registration. [NASA Mars Trek catalog](https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars), [HiRISE WMTS capabilities](https://trek.nasa.gov/tiles/Mars/EQ/JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first_dd/1.0.0/WMTSCapabilities.xml). |
| **7. USGS Jezero geology** | **Not locally present or integrated.** A precise USGS source product is identifiable. | Sun & Stack, *Geologic map of Jezero crater and the Nili Planum region*, SIM 3464 (2020), 1:75,000, about 1° × 1° / ~60 × 60 km; mapping base CTX ~6 m/pixel. GIS shapefiles were digitized in a Transverse Mercator projection centered 77.3°E, planetocentric latitude, east-positive. | Official GIS ZIP download is listed as 333 MB; PDF ~35 MB. Do not ship the full database. Clip/reproject only relevant unit polygons and required attributes for a compact vector overlay; expected clipped size is not yet measured. USGS lists public domain. The publication is a geologic interpretation, not live sensor data. No WMTS endpoint was identified in this project or the product listing. [USGS map page](https://www.usgs.gov/maps/geologic-map-jezero-crater-and-nili-planum-region-mars), [SIM 3464 GIS database directory](https://pubs.usgs.gov/sim/3464/), [pamphlet](https://pubs.usgs.gov/sim/3464/sim3464_pamphlet.pdf). |
| **8. THEMIS day/night thermal imagery** | **Not local or integrated.** A controlled global mosaic source and possible NASA Mars Trek catalogue layers exist. | THEMIS/2001 Mars Odyssey controlled IR day and night mosaics: global map products for roughly ±65° latitude, ~100 m/pixel, simple cylindrical 0–360° longitude, planetocentric. | USGS Astrogeology warns its blended controlled mosaics are qualitative 8-bit imagery; use for regional visual context only, not quantitative temperature or thermal inertia. USGS controlled-products documentation and NASA Mars Trek catalogue are available; no THEMIS layer URL is currently implemented or validated in the app. Use a current capabilities document or process official raster assets; do not infer a tile URL from a layer name. Attribution to NASA/JPL/ASU/USGS and exact product metadata; confirm redistribution terms. Potentially useful day/night context, but imagery is too coarse for local route cells. [USGS THEMIS controlled mosaics](https://stac.astrogeology.usgs.gov/docs/data/mars/themis_controlled_mosaics/), [USGS THEMIS 100 m day mosaic record](https://astrogeology.usgs.gov/search/map/mars_odyssey_themis_ir_day_global_mosaic_100m_v12), [NASA Mars Trek catalog](https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars). |
| **9. TES thermal inertia** | **Not local or integrated.** This is a derived global physical-property raster, not an image layer already present. | MGS TES global day/night thermal inertia maps from observations acquired Feb 1999–Apr 2004. PDS3 labels declare 7,200 × 3,600 signed 16-bit MSB simple-cylindrical grids, 20 px/degree (~2.96 km/pixel at equator), global −180 to 180° longitude and ±90° latitude, planetocentric/east-positive. Values 5–5,000 J/(m² K √s); interpolation masks flag infilled values. | PDS ZIP is listed as 66.4 MB; each raw map is 51.84 MB, each mask 25.92 MB (155.52 MB uncompressed for day/night maps and masks). A regional/downsampled, mask-aware derivative could be a coarse scientific overlay or comparison chart, but it cannot imply current temperature. This is too coarse for route risk and should not enter route costs. PDS PDS3 ingestion/resampling is required; cite Putzig & Mellon/PDS and preserve masks. [PDS TES thermal inertia archive](https://pds-geosciences.wustl.edu/missions/mgs/tes-timap.html), [day map label](https://pds-geosciences.wustl.edu/mgs/mgs-m-tes-5-timap-v1/mgst_9001/data/global_ti_day_2007.lbl), [night map label](https://pds-geosciences.wustl.edu/mgs/mgs-m-tes-5-timap-v1/mgst_9001/data/global_ti_night_2007.lbl). |
| **10. CRISM mineralogical products** | **Not local or integrated.** Current “science targets” are tile metadata and not CRISM detections. | MRO CRISM targeted MTRDR/TER/TRDR/MRDR products are observation-specific hyperspectral cubes or projected products; footprints and pixel scale vary by observation/mode. MTRDRs are map-projected using Mars terrain models; no one universal global color layer should be assumed. | PDS Geosciences Node, Mars Orbital Data Explorer, and CRISM analysis tools are official access routes. Select one or a few Jezero observations and derived summary parameter/classification products. Raw hyperspectral cubes and processing software (hundreds of MB for tools alone) are too costly/complex for the first public release. Mineral classes require expert interpretation, versioned algorithms and uncertainty/coverage layers. Credit CRISM/JHUAPL/NASA/PDS; verify archive reuse/redistribution terms. [PDS CRISM archive and product descriptions](https://pds-geosciences.wustl.edu/missions/mro/crism.htm). |
| **11. Perseverance MEDA observations** | **Not local or integrated.** Current temperature, pressure, dust, and consumables displays are explicit scenarios; no MEDA file is read. | Surface observations at Jezero, organized in PDS4 bundles by sol and collection. PDS lists raw, calibrated, partially processed, and derived environmental products; variables include atmospheric/meteorological observations. This is a time series at instrument/rover location, not a map raster. | PDS Atmospheres node provides PDS4 labels, collection inventories, and products; Mars 2020 data are released on a schedule (the current mission page lists Release 16 through sol 1859, August 2026). Parse only selected variables and sols, retain quality flags, timestamps/sol, units, calibration level, gaps, and release ID. Display as a chart and clearly label acquired/archived time; never say “current weather” merely because a value is recent. No useful full-bundle size was established; do not download it wholesale. Credit Mars 2020/MEDA/PDS. [PDS Mars 2020 archive](https://pds-geosciences.wustl.edu/missions/mars2020/), [MEDA PDS4 bundle](https://pds-atmospheres.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda/), [latest release listing](https://pds-geosciences.wustl.edu/missions/mars2020/). |
| **12. Curiosity RAD Gale reference** | **Reference only, not local time-series integration or a map layer.** The model uses a fixed 0.64 mSv/day baseline in a simplified illustrative dose calculation. | Hassler et al. reported a Gale surface GCR dose-equivalent rate of 0.64 ± 0.12 mSv/day for the first ~300 sols; it is a historical site/instrument measurement, not Jezero radiation. | Keep only as a cited context value with uncertainty, location, instrument, and observation period. Do not call the app layer measured radiation; it is a modeled scalar scaled by a simplified terrain sky-view factor and arbitrary scenario multiplier. Prefer a reference panel, not a map layer. Recheck product/metric terminology before changing the display. [Hassler et al. 2014, DOI 10.1126/science.1244797](https://doi.org/10.1126/science.1244797). |
| **13. Mars24 local solar time** | **Calculation already present.** `models.js` computes local mean solar time from the computer’s UTC timestamp and longitude; no Mars24 service or dataset is queried. | Scalar time calculation at Jezero longitude; no spatial coverage, pixel resolution, map coordinates, or downloaded data. The current implementation is explicitly “Mars24-style” and omits the small TT−UT correction. | Keep in assumptions/context panel, not a dataset/map layer. Label it an approximate local mean solar-time calculation rather than true local solar time unless the algorithm is updated to include equation-of-time/true-solar terms and validated against NASA GISS examples. Cite Allison & McEwen and document time-scale/accuracy limits. [NASA GISS Mars24 algorithm](https://www.giss.nasa.gov/tools/mars24/help/algorithm.html), [technical notes](https://www.giss.nasa.gov/tools/mars24/help/notes.html). |

## Source and provenance discrepancies to resolve

1. `DATA_SOURCES.md` still says the CTX GeoTIFF was not downloaded and that its tiles are not integrated. The current working tree has the 90.3 MB source GeoTIFF, download provenance, a complete processed 99-tile collection, tile-validation provenance, and CTX manager/sampler implementation. The prose must be updated before it is used as the user-facing source of truth.
2. The `DATASETS` table in `public/js/app.js` groups several different optical/thermal/mineral/geology products together and claims the CTX DEM is not integrated. It also omits individually meaningful status and coverage distinctions.
3. The active Rails view contains no `input[name="terrain-source"]`, `#ctx-terrain-status`, or `#retry-ctx-analysis`, despite JavaScript and UI tests expecting them. CTX is not currently selectable through this page. Confirm expected automatic planner behavior and restore coherent view-to-module wiring in a later implementation stage.
4. The old overview labels route/profile elevation “metres areoid” in one location, but CTX source metadata states the complete-mosaic vertical reference is unknown. Keep per-product vertical-reference text and never display a generic datum claim for CTX.
5. The Viking WMTS layer string in code is `Mars_Viking_MDIM21_ClrMosaic_global_232m`; the current catalog lists related `..._np` and `..._sp` layers. Use the exact current GetCapabilities document and verify its CRS/format/coverage, rather than relying on a copied layer ID or stale fixture.
6. `CTX_TERRAIN_HOSTING.md` describes CTX hosted/local release behavior and correctly distinguishes the external data host, but this is not evidence that a production bucket, public release, or production CTX URL exists.

## Recommended layer and information architecture

### Compact map layer selector

Use one selector with three clear groups and a single active layer at a time:

**Imagery**
- Viking VIS global — available; ~232 m/pixel; global context.
- Jezero CTX optical mosaic — available from NASA Mars Trek; nominal 6 m/pixel; regional image coverage.
- Jezero HiRISE optical mosaic — available from NASA Mars Trek; nominal 25 cm product scale; smaller regional footprint and transparent holes.

**Elevation**
- HiRISE DTM — available; 20 m planner grid; ~6.4 × 14.4 km; default at Jezero if selected.
- MOLA MEGDR — available; ~7.87 km derived planner cells; broader 0–90°E, 0–44°N tile.
- CTX DEM mosaic — locally processed, but UI unavailable until controls are wired and production hosting is configured; 20 m posting, ~77 × 84 km full source extent. Expose as a separate elevation source with explicit unknown vertical datum. Keep manual-route versus automatic route capabilities clear.
- Slope — derived from the active elevation dataset, with its source visible.

**Scientific context**
- Jezero geological units — planned, regional vector overlay.
- THEMIS daytime/nighttime — planned qualitative thermal imagery toggles; never show °C from mosaicked 8-bit brightness.
- TES thermal inertia — later optional low-resolution property layer; preserve day/night and interpolation-mask semantics.
- CRISM derived mineral classes — later selected-coverage polygons/summary overlay with uncertainty and observation footprint; not raw cube display.

Each option should show human-readable name, resolution, coverage, data role, and state: **Available**, **Loading**, **Unavailable**, or **Not configured**. The state must describe the actual request/result, not imply the data are currently drawn. Layer selection should not silently swap the active DEM or route geometry. If imagery overlays an active DEM, use explicit opacity controls and provide a legend/source credit.

### Data & Sources disclosure

Replace the large metadata table with a short disclosure organized by the currently visible layer and the active terrain source. Show product/instrument, resolution, coverage, observation/product role, last verified status, source link, attribution, and one or two important limitations. Put complete processing, checksum, CRS, georeferencing, citation and license notes in nested “Technical details” disclosures or the repository documentation. Keep scenario/model values in the assumptions area, not in the dataset availability list.

### Synthetic loader and raw-file uploader

Remove the synthetic terrain button and generic `.IMG/.LBL/.JSON` uploader from the ordinary public workflow. They create ambiguity and risk loading a test/synthetic or incompatible source into a public planner. Preserve `tools/make_test_dem.py`, test fixtures, parser/import modules, and unit tests. If manual import is required for developers, gate it behind a development-only switch or a separate local-only utility; tests should call parser/import code directly rather than requiring a public-facing control. A synthetic tile may remain available to automated tests but must not be mistaken for an operational dataset.

## Practical integration priorities

### P0 — Correct the live inventory and resolve the CTX view mismatch

- Reconcile the view with the CTX source controls expected by `app.js` and the UI tests.
- Decide whether CTX is an alternate terrain dataset for manual route analysis only or should support automatic routing too; do not imply the latter without implementing it.
- Keep HiRISE as the local, fine-resolution planner source; keep MOLA as broad lower-resolution context; document CTX's separate geometry/vertical uncertainties.
- Correct the data inventory and make per-layer loading/configuration/unavailable states truthful.

### P1 — Pair imagery and elevation without conflating them

- Add the regional CTX optical WMTS as a Jezero image backdrop, then HiRISE optical imagery at higher zoom. Preserve transparent missing image tiles.
- Keep elevation and slope calculated from selected DTM/DEM pixels; imagery affects appearance only.
- Add a footprint/coverage outline so users can understand that each image or elevation layer covers a different area.
- Validate product registration against source transforms. Do not make CTX DEM and HiRISE DTM cell values interchangeable because their radii, standard parallels, offsets and vertical references differ.

### P2 — Add geologic context

- Acquire the 333 MB SIM 3464 GIS bundle only for processing, not as a public web asset.
- Inspect its GIS layers, attribute schema, map CRS and metadata; clip required unit polygons and descriptions to the Jezero map area; transform carefully to the Mars view CRS; record source ZIP hash, software, date and conversion steps.
- Compare boundaries to the published map and CTX base. Provide unit name, interpretation, scale, and a link to the map pamphlet. Geologic units provide interpreted context, not a direct sensor observation or route hazard score.

### P3 — Add thermal context in two distinct forms

- First add THEMIS day/night mosaic imagery as qualitative overlay/context. Avoid numeric temperature legends or claims that brightness is calibrated temperature.
- Separately evaluate TES thermal inertia as a derived physical-property layer. Downsample/clip to Jezero, retain day/night variants and interpolation mask, and show its ~3 km posting. Do not add it to route costs in the initial release.

### P4 — Add mineralogical evidence as selected products

- Identify CRISM observations intersecting the Jezero footprint using PDS/ODE, then select small, well-documented MTRDR/summary-parameter products and derive named mineral-class coverage only with a published, documented classification method.
- Show observation boundaries, acquisition/processing version, no-coverage, confidence/quality, and non-detection/unknown semantics. Do not ship full raw cubes or report a mineral as present based only on a colour palette.

### P5 — Add MEDA time-series context and review reference calculations

- Select MEDA calibrated/derived environmental series and release range. Build a compact chart by sol/local time for temperature, pressure, wind/dust measures as appropriate, with units, flags, temporal gaps, release identifier, and the latest archived sol.
- Explicitly distinguish rover-measured archived observations from current Earth time and from scenario controls. Avoid a “live weather” label.
- Cite the RAD reference as 0.64 ± 0.12 mSv/day, first ~300 sols at Gale in Hassler et al. (2014), and leave the simplified dose rendering marked modeled/reference-only. Remove “to be re-checked” only after source audit and terminology review.
- Keep Mars24 time as a derived scalar. Decide whether the UI needs LMST or LTST; if it needs true solar time, update/validate the algorithm against NASA GISS worked examples and cite the actual time-scale assumptions.

## Download, storage, and runtime estimates

- Existing deployed/public assets include the ~4.1 MB MOLA JSON and ~1.87 MB HiRISE planner JSON. These are already in `public/data/` and are separately copied by the static manifest.
- Existing source material in this working tree: MOLA IMG 129.76 MB; HiRISE IMG 380.81 MB plus label; CTX DEM GeoTIFF 90.35 MB. The processed CTX collection is 91.57 MB for all 99 tiles, so serving it externally rather than shipping it in the app image is appropriate. Route access should stay bounded by the existing tile cache and request concurrency controls.
- SIM 3464 GIS database is 333 MB. Process locally; publish only a measured clipped/converted overlay, not the archive.
- TES archive ZIP is 66.4 MB; its day/night images and interpolation masks total about 155.52 MB uncompressed. Process a selected regional derivative, not the entire PDS archive into the static bundle.
- THEMIS global mosaics and individual observations are not included locally. Request only the required tiles or clip/convert the regional context asset. The final asset size depends on selected bands, resolution, encoding and compression; measure before approving a hosted copy.
- CRISM and MEDA holdings are product collections rather than single compact map files. No defensible application-asset estimate was obtained; select products/sols first and measure the actual downloads.
- Browser performance targets for a future release: no whole-source raster or GIS archive requests in the browser; request visible WMTS tiles only; lazy-load catalog/overlays; limit concurrent requests and cache; avoid decoding full-resolution hyperspectral cubes; report when external imagery fails.

## Attribution, licensing, and scientific validation

- Keep the original product identifiers, PDS LIDs, mission/instrument, authors/citations, source links, processing history, data versions/releases, checksums where available, coordinate reference, pixel registration, vertical reference and no-data masks.
- PDS/NASA access is not a blanket substitute for checking each product’s citation and redistribution terms. Retain source attribution and verify the specific product/service policy before caching or re-hosting any source.
- USGS states SIM 3464 and the CTX DEM product record are public domain/request citation; retain authorship and source attribution nonetheless.
- Treat data roles as **observed/archived**, **derived**, **modeled**, **reference**, or **assumed**. Do not flatten these categories into one “active data” status.
- Terrain validation: compare tile values, edge/halo ownership, no-data, coordinate transforms and vertical-reference notes to source metadata; test route analysis under each DEM separately. Reject cross-dataset elevation comparisons until datum/registration is proven.
- Imagery validation: parse current GetCapabilities; validate format, CRS, matrix set, bounds, and resource URL; test returned dimensions, opacity and CORS at known Jezero coordinates; preserve transparent holes and attribution.
- Geological/CRISM validation: match displayed polygons/classes to official product attributes/algorithms and footprints; visually compare with published map/observations; include data absence and confidence information.
- Thermal validation: test day/night labels, band/product IDs, interpolation masks and units. Do not infer a temperature from a qualitative 8-bit mosaic.
- MEDA validation: verify variable definitions, calibration level, units, sol/time conversion, quality flags, gaps, archive release and selected-summary calculations against PDS labels/readme. Do not extrapolate rover readings spatially across Jezero.
- Time validation: use NASA GISS Mars24 worked examples and distinguish local mean from local true solar time, Earth UT/UTC/TT handling, east/west longitude convention and limitations.

## Staged implementation sequence

1. **Inventory/UI wiring repair:** restore coherent CTX controls or truthfully mark CTX unavailable; reconcile source manifests, UI tests, and current documentation. Confirm the exact supported route modes.
2. **Layer selector foundation:** make one compact selector grouped by imagery/elevation/context, with accurate coverage/resolution and real loading/error/unconfigured states. Add source-specific compact details and nested provenance.
3. **Regional optical context:** integrate CTX then HiRISE Mars Trek image tiles over the existing globe/terrain views; validate capabilities, CORS, boundaries and opacity. No DEM/route changes in this stage.
4. **Geology overlay:** clip/reproject SIM 3464 polygons, serve a measured small derivative and show interpreted unit name/source/caveat.
5. **Thermal context:** add qualitative THEMIS day/night imagery; separately assess a masked regional TES thermal-inertia derivative after measuring assets and validating projection/resampling.
6. **Mineral products:** define limited Jezero CRISM products and a reproducible summary/class layer with uncertainty and footprints.
7. **MEDA and references:** chart archived MEDA summaries, correct the RAD reference wording/value/source, validate Mars24 local-time semantics. Keep all time-series/scalar data out of map layers unless georeferenced by the product.
8. **Public workflow cleanup:** remove synthetic/raw-file import controls from public views while retaining test generators, import/parser tests, and a developer-only local path.

## Relevant existing test coverage (inspected, not run)

- `test/hirise-data.test.js`, `test/dem-format.test.js`, `test/terrain.test.js`, `test/routing.test.js`: terrain parse, coordinate conversion, no-data, slope and route behavior.
- `test/ctx-metadata.test.js`, `test/ctx-tile-format.test.js`, `test/ctx-tile-manager.test.js`, `test/ctx-terrain-sampler.test.js`, `test/publish_ctx_tiles_test.py`, `test/verify_ctx_release_test.py`: CTX metadata integrity, tile layout, lazy/cache behavior, publication safety and release verification.
- `test/wmts.test.js`, `test/regional-wmts.test.js`, and capabilities XML fixtures: WMTS parsing/addressing, regional footprints and exact sample tiles. These tests do not render the regional optical mosaics in the UI.
- `test/ui_test.py`: expects CTX terrain-source controls/status elements not present in the active view. Run it only after resolving the mismatch; no tests were run for this read-only audit.
- Future tests should cover per-layer truthful status, hidden/unavailable states, source-specific coverage, opacity/legend/attribution, no-data/transparent imagery, CTX selection, and correct product-role labels. Keep scenario and scientific data tests deterministic with fixtures and pinned source metadata.

## Official reference links

- [NASA Mars Trek WMTS API/catalog](https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars)
- [PDS MOLA MEGDR archive](https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg128/)
- [HiRISE Jezero DTM product](https://hirise.lpl.arizona.edu/dtm/dtm.php?ID=ESP_046060_1985)
- [USGS Jezero CTX DEM product](https://astrogeology.usgs.gov/search/map/mars_2020_science_investigation_ctx_dem_mosaic)
- [USGS Jezero/Nili Planum Geologic Map SIM 3464](https://www.usgs.gov/maps/geologic-map-jezero-crater-and-nili-planum-region-mars)
- [USGS THEMIS controlled mosaic documentation](https://stac.astrogeology.usgs.gov/docs/data/mars/themis_controlled_mosaics/)
- [PDS MGS TES thermal inertia maps](https://pds-geosciences.wustl.edu/missions/mgs/tes-timap.html)
- [PDS MRO CRISM products](https://pds-geosciences.wustl.edu/missions/mro/crism.htm)
- [PDS Mars 2020/MEDA archive](https://pds-geosciences.wustl.edu/missions/mars2020/)
- [NASA GISS Mars24 algorithm](https://www.giss.nasa.gov/tools/mars24/help/algorithm.html)
- [Hassler et al. 2014 RAD paper DOI](https://doi.org/10.1126/science.1244797)

## Stage 4E.2 implementation update

The active workspace now exposes independent globe imagery and elevation selectors. Viking VIS remains the only rendered imagery layer; turning it off changes only the globe display. MOLA and HiRISE load their existing numerical grids for automatic routes. CTX restores the existing catalog, checksum-validated tile manager and manual drawn-route sampling controls; CTX is not used for automatic Dijkstra routes. The current automatic route grid and its route results remain available while CTX is selected.

CTX tiles load on demand, and the interface shows the catalog's loading, ready, failure and retry states. Production CTX availability still depends on the deployment's `CTX_TILE_BASE_URL`; no cloud settings or release objects were changed by this UI work. CTX's unresolved full-mosaic vertical reference is shown in the interface. MOLA and HiRISE values are not combined.

The large terrain metadata table, synthetic terrain loader and raw file uploader were removed from the public view. Their datasets, parsers, processing tools and tests remain in the repository. Regional CTX and HiRISE optical WMTS fixtures still do not constitute rendered layers; the interface identifies them as not integrated. Geology, THEMIS, TES, CRISM and MEDA remain future products; RAD remains a Gale reference and Mars24 a calculation.
