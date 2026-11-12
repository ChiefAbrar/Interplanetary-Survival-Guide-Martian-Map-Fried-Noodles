# Implementation status

Last updated: 2026-11-09

## Current architecture

- Existing app: static JavaScript modules served by Rails or exported to `dist/`; no runtime dependencies. Rails now exposes `/`, `/explore`, and `/regions/jezero`; the static export emits matching root, `/explore/`, and `/regions/jezero/` entry documents.
- Terrain and route source of truth: `public/js/terrain.js`, `public/js/routing.js`, `public/js/dem-format.js`.
- Static build source of truth: `app/views/`, `public/`, and `tools/build_dist.py`.
- Test commands: `node --test test/*.test.js`; browser test `python test/ui_test.py` requires Playwright and Chromium.

## Completed and verified

- Existing synthetic terrain demonstration, PDS HiRISE-style float32 import, slope analysis, four route objectives, route metrics, survival assumptions and responsive 2D terrain map are retained.
- Supplied MOLA PDS product `MEGT44N000HB` is validated and decoded as signed big-endian int16 metres from the local source files. The 677 × 331 / 17 × 17 block-averaged derived tile is `public/data/mola-megt44n000hb.json` and loads automatically at app startup.
- MOLA label metadata, simple cylindrical projection, east-positive longitude, planetocentric coverage, PDS offsets and no-data are preserved. Slope and route distances account for east-west ground spacing at latitude.
- Manual `.IMG` + `.LBL` import supports the supplied MOLA product; prior float32 PDS import remains supported.
- Build regenerates the derived MOLA tile when `data/raw/mola/megt44n000hb.img` and `.lbl` are both present. Raw 129 MB IMG is git-ignored; derived tile is a web asset.
- PDS provenance display, implementation notes, data attribution and missing-data messages updated.
- Responsive Liquid Glass inspired interface pass completed: floating header with live MOLA status, anchor-based map/layers/routes/scenario/data rail, frosted map readouts, updated route and profile panels, and responsive mobile navigation. Existing route, layer, import and scenario controls remain connected to their original handlers.
- Elevation profile supports hover inspection of distance, elevation and slope samples; profile redraw includes a route position marker.
- Static exporter reads and writes UTF-8 explicitly so the Unicode interface builds consistently on Windows.
- Added an interactive WebGL Mars sphere using the 3,396,190 m IAU mean-radius coordinate convention. It supports drag rotation, scroll zoom, Shift-drag pan, globe coordinate picking, coordinate search, double-click focus, reset and Jezero fly-to. The MOLA raster planner remains accessible in the Regional terrain planner view.
- Added a WMTS Capabilities parser and Mars-equirectangular tile address calculation. It reads the actual CTX layer format, style, coverage, advertised REST template, CRS, matrix identifiers, origins, tile sizes and matrix dimensions instead of assuming an Earth tile grid.
- Integrated live NASA Mars Trek global CTX imagery. The browser fetched the real capabilities and actual 512 × 512 CTX image tiles from the advertised ArcGIS REST resource, uploaded them to WebGL, and rendered the textured sphere. Zoom changes the matrix level and requests a bounded set of tiles, with a four-request concurrency limit and a 20/32 selected-tile cap.
- Updated the static host CSP to allow only the NASA capabilities and ArcGIS imagery hosts required by this feature; no external scripts or runtime libraries were added.
- Changed the default MOLA sample traverse to one adjacent planner cell (about 7.47 km ground distance at its latitude). The interface explicitly says the ~7.9 km/cell grid is regional context and is not suitable for local EVA hazard routing.
- Downloaded and validated the real HiRISE product `DTEEC_045994_1985_046060_1985_U01` (380,814,764 bytes; SHA-256 `b40739b4d32516ef9b3cd849f519a6a20df9720b5369a9c141047ced27c57654`). Its PDS3 label is attached inside the IMG; there is no detached DTM label on the official archive listing. Verified 14,266 × 6,673 samples, fixed 26,692-byte records, `^IMAGE=2`, `PC_REAL` 32-bit little-endian, missing bit pattern `0xFF7FFFFB`, unscaled float metres, and 70,220,645 finite non-null source samples. Decoded source range −2,679.2019 to −2,388.3052 m agrees with the label's valid range to float precision.
- Transferred the georeference from the official associated `ESP_046060_1985_RED_C_01_ORTHO.LBL` only after verifying its `SOURCE_PRODUCT_ID` names the DTM and its IMAGE dimensions match exactly. It declares Equirectangular planetocentric east-positive mapping, resolution, offsets and standard parallel; the offset-derived DTM footprint is bounded to 77.38530–77.49879°E and 18.30540–18.54840°N.
- Added `tools/hirise_to_tile.py` and build integration. The real dataset generates a checked-in 333 × 713 / 20 × 20 block-derived planner grid (175,551 observed cells, 61,878 no-data cells; about 1.87 MB JSON) at 19.505 m projected x spacing and 20.193 m y spacing. The builder regenerates it from ignored raw IMG plus the small official matching ortho label. Raw IMG is not committed.
- Added a UI control to load the real Jezero terrain, show source/georeference/coverage/processing metadata, compute elevation and slope, and plan within the valid local grid. A generated ~211 m sample traverse lies on valid cells; missing cells remain no-data. The route planner is limited by the 20 m overview, so this does not resolve sub-cell hazards.
- Added equirectangular standard-parallel distance handling, so the local DTM's projected east-west sample spacing is corrected to ground distance at each latitude.
- Retrieved the current official Mars Trek WMTS Capabilities for the controlled Jezero CTX and HiRISE mosaic layers; stored both XML snapshots as test fixtures. Fixed tile addressing to use the global Mars matrix grid independently of regional data coverage and to ignore commented example matrices. Verified live non-transparent CTX and HiRISE PNG responses at Jezero coordinates using matrix IDs, rows and columns derived from these capabilities. Regional image overlays are still not connected to the app.
- Added the first separately addressable product workspace: `/explore` (Rails) and `/explore/` (static export). It reuses the existing NASA CTX globe renderer and application state/modules, with a globe-first immersive layout, route-aware navigation state, and links to mission control, data provenance, and the Jezero field lab. Terrain assets now use root-relative URLs so real MOLA/HiRISE files remain reachable from nested routes. The design follows the supplied dark mission-instrument and immersive Mars imagery references while retaining factual dataset labels.
- Added `/regions/jezero` as a distinct field lab route. It opens the numerical terrain map instead of the globe and automatically loads the verified HiRISE-derived 20 m planner grid; primary navigation and the Explorer link provide direct access. This is the real raster terrain view, not the referenced regional imagery mosaic, which remains future work.

## Partially implemented / limitations

- Source MOLA coverage is 0–90°E and 0–44°N; the generated tile's exact retained footprint is about 0–89.914°E and 0.039–44°N because incomplete edge blocks are dropped. Planner resolution is about 7.872 km per cell; do not use it for local hazards or EVA safety. The label's MOLA areoid-relative elevations are not planetary radius.
- MOLA simple cylindrical distances use a spherical cos(latitude) correction. It is a practical regional approximation, not an ellipsoidal geodesic implementation.
- The globe uses global CTX. Regional planning is a 2D map using MOLA or the local HiRISE DTM; the controlled Jezero CTX and HiRISE image mosaics are not yet connected.
- WMTS high-detail tiles are bounded to matrix levels 0–7 and a small in-memory set. The far-zoom mesh still needs visual/coordinate QA across the full sphere and service edge cases.
- The HiRISE source is sampled to a 20 m planner overview. It does not provide native 1 m route search, local mesh displacement, or sub-cell hazard detection. The sample route is a demonstration, not an astronaut-safety result.
- On fine terrain, the illustrative 2 km sky-view calculation strides by two cells to bound CPU use; it can miss narrow horizons and is not a hazard model.
- No USGS geology, THEMIS, CRISM or MEDA observations are integrated. The planetary science target list remains empty unless a real source is attached to a tile.
- Automated browser checks now run with Playwright and Chromium at 1440 × 900, 1366 × 768 and 390 × 844. Screenshots are written under ignored `tmp/ui-screenshots/`.
- Existing radiation/temperature/dust/consumable values remain labeled models or assumptions.
- Mission control remains the existing planner experience. Dedicated Planner, Science Atlas, Data Observatory, Mission Briefing, persistent cross-page selection and browser-history state are not yet implemented. The app still initializes planner modules on `/explore` because those are coupled to the shared document; later page extraction should lazy-load modules without duplicating the globe renderer.

## Tests performed in this session

- Downloaded the actual HiRISE DTM using `curl --continue-at - --retry 5`; verified the 380,814,764-byte size, embedded PDS record layout, and SHA-256. Retrieved and checked the official matching ortho label for projection offsets.
- Converted the actual DTM: 6,673 × 14,266 native posts → 333 × 713 planner cells at 20 × 20 block averaging; 70,220,645 source samples valid, derivative has 175,551 valid cells and 61,878 explicit no-data cells. Valid source elevations −2,679.2019 to −2,388.3052 m.
- Loaded the real derived tile in Node and verified a geographic coordinate round trip, finite elevation/slope samples, no-data sampling, and a 210.69 m valid route with a peak step slope below 0.4°.
- `python tools/build_dist.py`: succeeded; both actual MOLA and HiRISE derivatives regenerated from the available source files.
- `node --test test/*.test.js`: all 68 tests passed, including the real HiRISE DTM derivative and the official regional WMTS capability snapshots.
- `python -u test/ui_test.py`: all 46 Playwright checks passed, including actual NASA CTX loading, real HiRISE DTM loading, elevation/slope display, a real local traverse, no-data point rejection and laptop/mobile layouts. Screenshots are written to ignored `tmp/ui-screenshots/`, including `jezero-hirise-terrain.png`.
- Direct NASA WMTS verification: center-coordinate regional CTX and HiRISE requests each returned a non-transparent 256 × 256 PNG from the exact capability-derived matrix URL. A neighboring HiRISE tile returned transparent, confirming sparse tile content needs explicit no-image handling.
- Multi-route verification: `python tools/build_dist.py` succeeds and emits root, `/explore/`, and `/regions/jezero/` entry pages. `node --test test/*.test.js`: 68/68 pass. `python -u test/ui_test.py`: 51/51 Playwright checks pass, including live NASA CTX, direct Explorer and Jezero Field Lab URLs, automatic real HiRISE product/grid loading, terrain routes, and desktop/laptop/mobile behavior. Screenshots include `desktop-explorer.png` and `desktop-jezero-field-lab.png` under ignored `tmp/ui-screenshots/`.

## Exact next steps

1. Connect the retrieved Jezero CTX and HiRISE WMTS layers to a coverage-aware local imagery view, align tiles with DTM coordinates and preserve transparent/missing tile behavior.
2. Replace the 20 m DTM route overview with an efficient binary, spatially tiled, multi-resolution representation that lazy-loads finer levels without exceeding browser memory or planner work budgets.
3. Implement local terrain mesh displacement from numerical samples, clearly distinct from a flat orthorectified image overlay.
4. Add actual USGS geology, THEMIS, CRISM footprints and selected MEDA observations only after inspecting their official data products and provenance.
5. Revisit radiation cost assumptions for local Jezero context and keep the non-certified safety wording explicit.
