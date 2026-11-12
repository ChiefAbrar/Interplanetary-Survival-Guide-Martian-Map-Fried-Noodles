# Planetary mapping product design study

Date: 2026-11-09

## Reference inspection

| Product | What was inspected | Effective patterns to carry forward |
|---|---|---|
| [NASA Mars Trek](https://trek.nasa.gov/mars/) | Opened the live web app in the browser and inspected its accessible UI. It exposes search, a menu, projection choice, zoom in/out, reset, fly-to, basemap selection, scale, and live latitude/longitude. Public interface screenshots and tutorials show its layer, measurement, and 2D/3D workflows. | The map stays the main work surface. Navigation is geographic and direct. Search, projection, scale, and coordinates sit close to the map. Tools are grouped by map action rather than presented as unrelated dashboard cards. Primary design reference for `/explore`. |
| [USGS Astrogeology Interactive Mars Maps](https://astrogeology-usgs.hub.arcgis.com/pages/interactive-maps-mars) | Opened the requested ArcGIS Hub page and the USGS planetary interactive-map directory. The requested Mars page is a JavaScript ArcGIS experience and did not expose a readable control tree in this browser session. The USGS directory exposes individual published map experiences and their linked scientific map products. | Geological units need a real cartographic legend and map scale, with unit names and citation tied to the selected map. Treat the geology as a specific scientific map with provenance and GIS downloads, not a decorative colored overlay. |
| [JMARS](https://jmars.mars.asu.edu/) | Inspected the public site, its [Layer Manager documentation](https://jmars.mars.asu.edu/layer-manager), and official interface screenshot descriptions. JMARS is a desktop GIS client, not an in-browser map application; its installed client was not present in the workspace. The docs describe a separate resizable Layer Manager and a Viewing Window. | Layer order is explicit. Each layer has visibility per view, opacity, selection/active state, and drawing/loading/error status. Map overlays (scale bar, north arrow, lat/lon grid, nomenclature) are managed as layers. Borrow this functional organization, not the legacy window styling. |
| [NASA Mars MMGIS](https://mars.nasa.gov/maps/) | Opened the live application in the browser and inspected its accessible UI. The app exposes separate Viewer and Globe panes, copy-link, screenshot, fullscreen, help, mission dataset choices, and a visible attribution/about surface. | Keep map and globe as explicit exploration modes, provide share/capture/fullscreen affordances, and place mission/data context inside the geographical workspace. The map should remain useful while controls open or close. |

## Current app screenshot critique

Inspected current Playwright captures `tmp/ui-screenshots/desktop-globe.png` and `desktop-explorer.png` (1440 px viewport; full-page screenshots).

- Mission Control still looks like the old terrain-planning dashboard. A three-part explainer panel occupies the first screen, the route comparison column competes with the globe, and the actual sphere is small relative to its black viewport. The first view is neither an editorial mission overview nor a clean entry point to geographic exploration.
- Explorer removes most planner content, but its full-page capture still includes the survival/scenario/science panels below the globe. The canvas uses large empty black margins around a small planet. Its search controls float as a generic card in the upper right, separate from a recognizable map-control hierarchy.
- The header status reports the MOLA product even on a global CTX view. A global imagery route should prioritize the active imagery and cursor/scale state; regional terrain status belongs in the Jezero workspace.
- The interface uses the same rounded bordered surfaces for unrelated content. The resulting visual hierarchy comes from card boundaries, not from the geographic task, selected dataset, or map itself.

## Composition proposal for the six application pages

1. **Mission Control (`/`)** — Editorial mission entry, not a dashboard. One broad, real Mars globe/CTX stage with restrained title and region selector over the map; a narrow mission rail lists the selected region and verified dataset readiness as compact rows. Two clear actions enter global exploration or Jezero Field Lab. No route cards or three-column explainer above the map.
2. **Planetary Explorer (`/explore`)** — Full-height globe as the primary viewport. A compact top search/geographic locator, a slim left vertical map tool strip, a collapsible layer/coverage panel, and a small lower map readout for coordinates, scale, CRS, and active imagery. Hide planner-only details from this route. Keep NASA CTX the only globe imagery layer shown as active until other globe layers are actually rendered.
3. **Jezero Field Lab (`/regions/jezero`)** — GIS workstation: map canvas takes the center, a layer stack docks left, and a location/provenance inspector docks right. Organize imagery, topography, geology, science, and environment by group; only enable verified integrations. Color ramps, units, no-data, coverage and source metadata stay attached to each active layer.
4. **Expedition Planner (`/planner`)** — Planning canvas with route editing and waypoints as the main interaction. Route alternatives compare in a compact table beside/below the map; an elevation profile docks across the lower edge. Consumable assumptions stay in a secondary mission-settings panel.
5. **Science Atlas (`/science`)** — Research catalogue paired with a geographic observation map. Observation footprints and geological units are browseable by evidence type; each selection opens a source-first detail panel with product ID, instrument, resolution, footprint, processing, and limitations. No unsupported observations are plotted.
6. **Data Observatory (`/data`)** — Dataset catalogue with real product records, coverage status, resolution, provenance and processing notes. Use an archive/table and focused product detail, not mission KPI cards. Distinguish integrated, available-but-not-connected, and unavailable data.

## Design guardrails for this pass

- Retain the current Liquid Glass material for compact floating controls only; let the map and terrain carry the visual weight.
- Prefer flat, precise map panels with hairline dividers and clear selected/disabled states. Reduce large radii, broad shadows, and decorative gradients.
- Keep coordinate systems, units, scale, layer visibility and dataset status legible at the viewport edge.
- Reuse the existing globe and scientific calculations. Do not invent layer availability, mission activity, or rover telemetry.
- Implement Mission Control and Planetary Explorer first; preserve the already separate Jezero Field Lab route and existing terrain/planner functionality.
