# Mars Survival UI Redesign Plan

Status: design proposal only. Stage 4C's implementation was rolled back at the user's request; the original shared dark interface and route structure were restored from the saved deployment snapshot. Factual source corrections were retained.

## Audit basis and limits

This plan uses the project guide and evidence in `README.md`, `DATA_SOURCES.md`, `TESTING.md`, `IMPLEMENTATION_STATUS.md`, and `DESIGN_REFERENCE_STUDY.md`, plus the current routes, Rails template, JavaScript, CSS, built assets, and saved screenshots under `tmp/ui-screenshots/`. The root, Explorer, Jezero, and mobile captures show the current combined interface. Some saved reference captures are not useful for visual comparison (for example, the Mars Trek and USGS captures show loading states, and the MMGIS capture shows a 404); the written reference study records the useful interaction patterns it observed. Cargo.site is a composition and editorial reference only, not a source to copy.

The user-provided Stage 4C brief identifies this as a NASA Space Apps Challenge 2026, Challenge 11 project. Content changes remain grounded in repository source material and avoid operational claims.

## 1. Current page and route inventory

| URL | Current behavior | Finding |
|---|---|---|
| `/` | `HomeController#index`; shared page defaults to the 3D globe and mission-control styling. It also contains the 2D map, route planner, profile, survival arithmetic, assumptions, science targets, and data panels. | Too many roles on one long page. The editorial briefing, globe, and route cards compete for the first screen. |
| `/explore` | `HomeController#explore` renders the same `index` template; JavaScript sets an Explorer class and CSS hides some planner sections. | A second URL for substantially the same globe experience. The page still shares and initializes the planner document and code. |
| `/regions/jezero` | `HomeController#jezero` renders the same template; JavaScript selects 2D and loads the HiRISE terrain. | The most task-focused route, but it inherits shared controls, explanatory content, and below-map panels. It is a long map/planner page. |
| `/up` | Rails health endpoint. | Operational route; not a navigation page. |
| `/ctx-terrain/:file` | Local Rails endpoint for the ignored processed CTX terrain collection. | Development/data endpoint; not a visitor-facing page and not part of the static export. |

`tools/build_dist.py` emits static entry documents for `/`, `/explore/`, and `/regions/jezero/`. The Rails controller and static exporter use the same template and public assets, while route-specific behavior is selected in `public/js/app.js`. The application is not a generic server-rendered multi-page product: its planner calculations and map interactions run in browser JavaScript.

The current worktree also contains a pre-existing deletion of `vercel.json` and an untracked `vercel.mjs`. Keep the Vercel/static path separate from the UI redesign and verify its recognized project configuration before relying on it; this plan does not change either file.

### Strongest current experience problems

- The home page stacks a mission brief, a small globe in a large black canvas, route alternatives, profile, and survival/assumption panels. The map is visually prominent but the page does not lead a first-time visitor through a clear story.
- Explorer is a filtered version of the same document. It still loads planner modules and initializes the globe even when another route is selected.
- Jezero is more focused, but the tall, narrow HiRISE footprint, route form, profile, warnings, survival arithmetic, assumptions, science targets, and provenance compete for attention. The mobile screenshot makes this a very long scroll with small controls and dense labels.
- Repeated translucent rounded panels create a dashboard/template feel. Tiny uppercase labels and small body text further make the interface read as an instrument console instead of a public-facing science story.
- The home briefing uses operational language such as “readiness,” “telemetry,” and “NOMINAL,” although the app has no mission telemetry or readiness data. Remove that framing; it can imply capabilities the prototype does not have.
- Imagery attribution is inconsistent: `public/js/mars-globe.js` requests `Mars_Viking_MDIM21_ClrMosaic_global_232m` and reports Viking VIS, while `README.md` describes the global imagery as CTX. The header can also report MOLA as loaded while the globe displays Viking imagery. Resolve labels from the active source and align project copy with the actual WMTS product before presenting scientific claims.
- The project says no science targets are integrated, yet the route comparison includes a Science objective and a separate Science targets panel. Keep the honest unavailable/empty state; do not add or imply observations without sourced locations.
- The main factual distinctions—Viking optical imagery versus elevation, the coarse MOLA footprint, the 20 m HiRISE derivative, Gale-based RAD reference, models, and assumptions—are present in the repo but are buried in README text or collapsed panels. Put the relevant caveat next to the map layer or result it qualifies.
- Existing accessibility foundations include a skip link, visible keyboard focus, labeled map controls, status regions, some keyboard map behavior, and CSS `prefers-reduced-motion`. Canvas-only geographic interaction still needs a non-pointer path and accessible equivalent. Current controls and labels are often small on mobile. The globe’s JavaScript animation loop is continuous; the CSS reduced-motion rule alone does not pause that loop.

## 2. Recommended final structure and navigation

Use **three visitor-facing pages** with one persistent, plain-language navigation:

1. **Expedition** — `/`. Combine the short mission orientation with the global planetary map. The map remains the main feature and appears in the first viewport; there is no separate landing page that hides it.
2. **Jezero Field Lab** — `/regions/jezero`. Combine regional terrain inspection and traverse planning. This is the one place for route editing, comparisons, profile, and the local terrain source choice.
3. **Data & Method** — `/data`. Explain the actual datasets, processing, model assumptions, route method, coverage, and limitations in a browsable source-first format.

Keep `/explore` as a backward-compatible route to the Expedition map (an alias or redirect to a stable map anchor) rather than a second independently designed globe page. Keep `/up` and `/ctx-terrain/:file` operational and out of visitor navigation. Implement equivalent static-export behavior so Rails and `dist/` continue to agree.

Do not create separate Planner, Science Atlas, or Field Guide pages in this pass. Planning is inseparable from the existing Jezero map; a Science Atlas would imply integrated observations that are absent; and field context can be introduced through a short Jezero explainer and sourced Data & Method entries. Revisit a separate science page only when real, geographically referenced science products are integrated. This narrows the previous six-page sketch in `DESIGN_REFERENCE_STUDY.md` to the roles the current data can support.

Primary navigation labels: **Expedition**, **Jezero Field Lab**, **Data & Method**. On the Expedition page, “Open Jezero planner” is the primary task CTA. On the Field Lab, use a clear “Back to global map” link. Show the active link with `aria-current="page"`; do not rely on color alone.

## 3. Content to retain, merge, remove, or add

### Retain and explain

- The NASA Mars Trek **Viking VIS** global color mosaic as optical context, explicitly not elevation.
- MOLA `MEGT44N000HB` as regional topography, with its actual coverage and approximately 7.9 km planner-cell scale visible when selected.
- The HiRISE product `DTEEC_045994_1985_046060_1985_U01` and its 20 m planner derivative, footprint, no-data, source provenance, and processing limits.
- Elevation/slope layers, start/destination interaction, manual routes, route alternatives, warnings, profile inspection, and the existing terrain-analysis behavior.
- The MSL RAD value as a Gale Crater reference only; radiation, temperature, dust, walking speed, and consumables as modeled or assumed, not Jezero observations.
- The synthetic test terrain only as a clearly marked demonstration dataset; it should not occupy the default mission story.

### Merge and relocate

- Merge the Mission Control and Explorer experiences into Expedition; keep only one canonical global map.
- Consolidate the Jezero route editor, route comparison, warnings, elevation profile, and source selector around the regional map. Put advanced numeric projected-coordinate entry in an optional “Precise coordinates” disclosure; keep map placement as the main path.
- Move lengthy source records, processing details, equations, and assumptions to Data & Method. Keep short, source-linked summaries beside the active map layer and route result.
- Replace the repeated three-part “where / what / how” explainer with one concise, sourced mission introduction and contextual help at the relevant task.

### Remove or reframe

- Remove the “NOMINAL,” “readiness,” and unsupported telemetry presentation. Use factual terms such as “planner dataset,” “reference value,” and “scenario result.”
- Remove the empty standalone Science targets panel from the main task flow. Preserve the science route behavior and tests, but show a direct “No source-backed targets are loaded; this objective cannot be calculated” state where relevant.
- Remove duplicated page-specific content, decorative status chips, and repeated card borders when the same fact is already visible in the map legend or selected-source inspector.
- Do not add unintegrated geology, controlled Jezero imagery, MEDA observations, mineralogy, rover telemetry, or safety guarantees. Clearly distinguish a raster elevation product from an optical mosaic.

### Add

- A short opening explanation of the prototype’s actual job and a three-step path: inspect global context → open Jezero terrain → compare modeled traverses.
- Source and method links at the point of use, plus a Data & Method index with status labels: **Integrated**, **Reference/model**, **Not integrated**.
- A concise explanation of why Jezero is relevant, limited to facts already supported by the project sources (the README identifies it as an ancient lake basin and Perseverance landing site). Add a citation in the UI before using that context as a factual claim.
- Clear loading, no-coverage, no-data, request-failure, and retry messages for map layers. Explain when a dataset is absent versus when a cell is scientifically marked no-data.

## 4. Visual design system

### Direction

Treat the site as a **Martian field publication**: editorial titles and captions frame a serious map workspace. Borrow Cargo.site’s freedom in scale, whitespace, alignment, and image-led pacing without reproducing a particular layout. The map, elevation relief, and coordinate grid are the imagery; do not add decorative space backgrounds or unverified photos.

### Palette

Use a light mineral-paper base for narrative and reference content, with charcoal ink and thin warm-gray rules. Reserve dark charcoal for the map work surface so the cartography remains legible. Suggested starting tokens (verify contrast before implementation):

| Role | Starting color | Use |
|---|---|---|
| Paper | `#F1EDE3` | Narrative page background |
| Chalk | `#FAF8F2` | Reading surface and map annotations |
| Basalt ink | `#262A29` | Headings, body text on paper |
| Mineral gray | `#666B67` | Secondary text and coordinates |
| Stone rule | `#C8C1B4` | Dividers and boundaries |
| Martian oxide | `#9B4D35` | Brand accent and selected action, used sparingly |
| Muted olive | `#74765A` | Secondary terrain/data accent |
| Focus blue-gray | `#245B67` | High-contrast keyboard focus indicator |
| Map night | `#15191A` | Canvas-only dark work surface |

Route and elevation colors must retain their current meaning and be distinguishable without color alone. Use text labels and line styles with the route colors. Validate all text and control contrast in both paper and map themes.

### Type and layout

- Display/headings: system serif stack such as `Georgia, "Times New Roman", serif`; body: system sans stack; coordinate and measurement values: `ui-monospace, SFMono-Regular, Consolas, monospace`. Avoid remote font downloads and new dependencies.
- Use a measured type scale: editorial display 40–64 px on wide screens, section titles 24–32 px, body 16–18 px, technical labels no smaller than 12 px except compact map ticks. Preserve tabular numerals for measurements.
- Use an 8 px spacing rhythm (8/16/24/32/48/64), generous outer margins, and a readable text measure around 60–72 characters. Break the grid intentionally for a map edge, pull quote, or source note; do not express every section as a rounded card.
- Use square or lightly softened corners, hairline separators, and flat surfaces. Reserve translucent surfaces for compact controls over imagery; remove broad glass shadows and decorative gradients from the editorial page.

### Interaction principles

- Give links a restrained underline/color change; buttons and selected sources a clear border/fill change. Avoid hover-only information and hover transforms on touch-critical controls.
- Keep pressed, selected, disabled, loading, success, and error states explicit in text and semantics. Controls should have at least 44 px touch targets in the narrow layout.
- Retain a strong `:focus-visible` ring; ensure anchor links do not hide below the sticky header. Respect reduced motion in both CSS and globe/WebGL JavaScript. Pause nonessential rendering when the map is hidden or the document is backgrounded.
- Keep map keyboard actions visible in a short help line and provide an accessible coordinate/terrain readout that does not require pointer hover.

## 5. Page-by-page wireframes

### Expedition (`/`)

1. A slim masthead: wordmark, three navigation links, and one factual dataset status. No “telemetry” or readiness chip.
2. A two-part first view: a compact left editorial introduction (title, one-paragraph purpose, “Open Jezero planner” link); a large, edge-to-edge global Mars map/globe occupying the majority of the width and most of the viewport height. Keep search, fly-to Jezero, reset, scale/coordinates, and imagery attribution adjacent to the map.
3. Beneath the map, three short numbered notes explain the journey and distinguish global optical imagery from numerical terrain. Include a source link and a visible prototype/safety disclaimer.
4. Do not put route cards, survival sliders, or a three-column dashboard above the map. The initial view should communicate both the story and the interactive feature without scrolling past a large generic hero.

### Jezero Field Lab (`/regions/jezero`)

1. Page heading with location, selected terrain product, resolution, and coverage in a compact source strip.
2. Desktop workspace: map about two-thirds width, inspector/planning column about one-third. The map should preserve the raster’s tall footprint while using available height efficiently; show no-data/coverage boundaries, scale, north, coordinates, active layer, and units. Do not label the numerical map as CTX imagery.
3. A compact source/layer control: HiRISE 20 m planner derivative by default; MOLA as coarse regional context; optional CTX terrain only when its catalog is configured. Elevation, slope, and modeled radiation remain separate, labeled map products. The selected source’s provenance and resolution remain visible.
4. Planning inspector: start/destination placement mode, route alternatives in a compact comparison table, warnings directly below the chosen route, and the elevation profile aligned below the map. Manual-route drawing and coordinate entry are secondary actions. Put assumptions in a collapsible, clearly labeled “Model inputs” section.
5. A visible “This is an educational calculation, not an EVA safety assessment” note stays near the result. If data are unavailable or outside coverage, explain the next action and preserve the route; never replace missing terrain with fabricated elevations.

### Data & Method (`/data`)

1. Intro explains how the planner turns a selected elevation product into distance/slope, route costs, profile, and scenario arithmetic.
2. An editorial source register grouped by **Integrated data**, **Reference/model**, and **Not integrated**. Each row has product/provider, instrument, resolution or scale, geographic coverage, use in the app, processing, vertical reference, source link, and limitation/status.
3. A method section explains interpolation/no-data, slope and route objectives, sky-view approximation, dose integration, assumed speed/endurance/reserves, and why the result is not a safety decision. Link to the full project data record for detailed provenance rather than duplicating every metadata field inline.
4. Use a table or archive list with a focused detail view, not a KPI-card grid. Do not plot science observations until source-backed geometry exists.

## 6. Mobile and desktop behavior

- **Wide desktop (≥1100 px):** retain the editorial offset composition; give the map the dominant span. Keep controls in a slim edge rail or one compact toolbar. Place the Jezero planner inspector beside the map, with the profile below.
- **Tablet (720–1099 px):** collapse the side inspector into a docked panel below or beside the map; keep primary controls visible and avoid horizontal scrolling. Use a “Map / Plan” segmented view only if simultaneous visibility becomes cramped.
- **Mobile (<720 px):** one-column reading order: title and source → map → essential map controls → selected route summary → profile → advanced assumptions/provenance. Use a compact menu for navigation, not tiny compressed desktop links. Keep source selection and start/destination placement available without a floating icon rail covering the map.
- Keep canvas aspect ratio and map tools stable when panels open. Allow the map to pan/zoom by touch without making page scroll impossible; offer a visible way to exit map-interaction mode. Test at 390×844, 768×1024, 1366×768, and 1440×900 with browser zoom and keyboard-only navigation.

## 7. Performance improvement priorities

Measurements below are repository observations, not device-independent promises. The saved `tmp/baseline_perf.json` was produced by `tmp/measure_baseline.py` against the local root page; its browser/device/network date is not recorded. It reports 1.429 s to page load, 3.614 s to textured globe, 50 cold requests (39 to NASA), and 27 warm requests (14 to NASA). Use it only as a historical baseline and rerun a reproducible benchmark before setting targets.

1. **Stop work for hidden experiences.** `public/js/app.js` statically imports planner, globe, model, and CTX modules on all three routes; it calls `globe.start()` and starts the perpetual animation loop even on `/regions/jezero`. Split page entry modules and initialize the globe only when the global map is shown. Defer non-visible planner panels and data requests.
2. **Reduce large numeric JSON costs without changing science.** Current public files are about 4.11 MB for the MOLA planner tile and 1.87 MB for the HiRISE tile; the browser auto-loads MOLA on home/Explorer and HiRISE on Jezero. Measure compressed transfer, parse time, and heap on target hardware. Consider a versioned binary/typed-array representation or spatially chunked loading while keeping metadata, no-data, cell values, and existing numerical test equivalence. Do not bundle the raw raster or processed external CTX collection.
3. **Bound image memory and avoid redundant tile traffic.** `mars-globe.js` limits visible selected WebGL tiles to 20/32 and tile concurrency to four, but the decoded-image `IMAGE_CACHE` map has no eviction. Its image-load path also makes a second `fetch()` to populate Cache API after the image request. Measure whether browser HTTP cache prevents duplicate transfer; if not, cache the response from a single fetch. Add a bounded decoded-image policy and clean GPU resources when views are disposed. Keep CTX terrain’s checksum validation, four-request concurrency, and bounded LRU behavior.
4. **Make cost visible in network tests.** Record route-specific JS, CSS, terrain bytes, map requests, and time-to-first-usable-map on cold and warm cache. `/regions/jezero` should make no global imagery/capabilities requests when its globe is not visible; route changes should not refetch already loaded datasets unnecessarily. Preserve the NASA WMTS source and tile math.
5. **Keep drawing work proportional to interaction.** Pause the globe render loop when hidden/backgrounded and draw on animation frames only during motion or map changes where practical. Keep existing selected-tile caps and route-planning work limits; profile before changing scientific computation.
6. **Remove only verified orphan payloads.** `public/js/mars-globe.js.bak` is not imported by the app but is explicitly preserved by the static manifest. Confirm its provenance and whether a user/tool depends on it before removing it from public output; do not delete it as part of an unreviewed cleanup.

For the 8 GB / GTX 1650 class machine, prefer fewer initial requests, bounded decoded textures, binary numeric arrays, and no continuous hidden-canvas rendering. Do not trade away route accuracy or load all high-resolution data eagerly to improve a superficial score.

## 8. Existing functionality that must remain unchanged

- Rails paths, `/up`, the local `/ctx-terrain/` development endpoint, static export entry routes, and Vercel/static hosting intent.
- The source-verified Viking VIS globe imagery, WMTS capabilities and Mars CRS/tile geometry; its correct source name and “imagery, not elevation” label.
- MOLA and HiRISE product IDs, cell values, georeferencing, vertical-reference/unknown fields, no-data semantics, hashes, provenance, and the HiRISE coverage footprint.
- Elevation/slope sampling, coordinate conversion, map clicks/keyboard point setting, route objectives, manual route analysis, warning explanations, profile inspection, and visible units.
- CTX catalog/tile format validation, checksums, external `CTX_TILE_BASE_URL`, bounded terrain cache, retry/error behavior, and the rule that production never silently falls back to the local Rails endpoint.
- Every “observed / modeled / assumed / unavailable” distinction, data attribution, synthetic-demo warning, and non-safety disclaimer.
- Rails and static generated pages should present the same route content and asset behavior; verify the static builder after each template change.

## 9. Staged implementation sequence and acceptance criteria

### Stage 4C.1 — Content truth and route contract

- Obtain or identify the official Space Apps challenge prompt and map only its actual requirements to the project.
- Resolve README’s global-CTX claim against the actual Viking VIS layer; make the active header/source label follow the selected map layer and terrain dataset independently.
- Replace unsupported operational/readiness wording and define the three visitor-facing page roles.

**Accept when:** every visible source, resolution, coverage, and status matches `DATA_SOURCES.md`/WMTS metadata; no unsupported telemetry or “nominal” state remains; route and static-export contracts are documented before view extraction.

### Stage 4C.2 — Page composition and navigation

- Build the three-page information architecture with shared, semantic navigation. Consolidate `/` and `/explore`; keep `/explore` backward compatible. Combine local map and planner under Jezero. Create Data & Method from existing verified records.

**Accept when:** direct visits and refreshes work on all canonical paths in Rails and `dist/`; active navigation and page titles are correct; all existing planning/data actions are reachable; no key content is duplicated across the shared template.

### Stage 4C.3 — Visual system and interaction/accessibility

- Replace dashboard-card styling with the paper/map contrast, editorial typography, clear cartographic labels, and purposeful whitespace. Rework mobile control order and route summary.
- Preserve focus, keyboard, loading, empty, error, and retry states; add a non-pointer accessible readout and reduced-motion handling for JavaScript animation.

**Accept when:** contrast is checked; all actions work keyboard-only and at touch size; map controls remain usable at the listed viewport sizes; reduced-motion users do not receive globe fly/crossfade or continuous nonessential animation; empty science targets and no-data are explicit.

### Stage 4C.4 — Progressive loading and measured optimization

- Split page entry points, defer hidden globe/planner setup, and measure image and terrain costs before choosing binary/chunk formats or cache policies.

**Accept when:** cold/warm network and render measurements are recorded on a named machine/browser; Jezero does not request hidden globe assets; no unnecessary duplicate tile transfer is observed; decoded imagery and CTX elevation cache remain bounded; existing numerical/provenance suites pass unchanged.

### Stage 4C.5 — Release readiness review

- Run Node, Rails, static-build, and Playwright checks where available; inspect all pages/screenshots at desktop, tablet, and mobile sizes. Verify static and Rails outputs, data labels, and citations together.

**Accept when:** every route works by direct URL; tests cover route/content parity, science-source labels, loading/error/retry, keyboard/accessibility, and no-data behavior; there are no broken source links or unsupported science claims; Vercel configuration is verified separately before relying on it.

## Suggested first work in Stage 4C

Start with **Stage 4C.1**: reconcile the Viking-versus-CTX imagery claim, remove the false readiness/telemetry presentation, and confirm the official challenge brief. These are factual and content decisions that affect every visual composition. Then implement the three-page route contract before styling or performance refactoring.
