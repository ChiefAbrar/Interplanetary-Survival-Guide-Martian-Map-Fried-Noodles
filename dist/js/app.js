import { cellAt, cellCentre, cellOf, getSkyView, localToLatLon, latLonToLocal, cellSpacingX, TerrainError } from "./terrain.js";
import { parseTile, LIMITS } from "./dem-format.js";
import { planRoute, analyzeManualRoute, OBJECTIVES } from "./routing.js";
import { PARAMS, DUST, RADIATION_SCENARIOS, doseRate, environment, marsClock, assessSurvival, walkSpeedMS } from "./models.js";
import { MarsGlobe } from "./mars-globe.js";
import { createCtxTerrainManager } from "./ctx-tile-manager.js";
import { createCtxTerrainSampler, CtxTerrainSamplerError } from "./ctx-terrain-sampler.js";
import { canRetryCtx, createLayerState, selectLayer, updateCtxLayerStatus, usesAutomaticRouteElevation } from "./layer-state.js";
import { createGeologyOverlay } from "./geology.js";
import { ctxDisplayRange, fitMapCssSize, renderCtxCorePixels, renderElevationPixels, visibleCtxTileRecords } from "./terrain-rendering.js";
import { JEZERO_REGIONAL_EXTENT, createRegionalViewport, sourceLocalToViewport, viewportPixelToSource } from "./map-viewport.js";
import { createOpticalWmtsLayer, JEZERO_OPTICAL_LAYERS } from "./optical-wmts.js";
import { MARS_LOCATIONS, formatMarsLocation, resolveMarsLocation } from "./mars-locations.js";

const JEZERO_LON_E = 77.4;
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtLen = m => (m < 1000 ? `${m.toFixed(0)} m` : `${(m / 1000).toFixed(2)} km`);
const fmtTime = s => { const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`; };

const PARAM_LABELS = { walkSpeedFlatKmh: "Flat walking speed", slopeSpeedScaleDeg: "Slope speed scale", maxSlopeDeg: "Slope limit", baselineDoseMSvPerDay: "Reference dose rate", skyViewSearchM: "Horizon search distance", riskSlopeRefDeg: "Risk slope reference", riskDoseWeight: "Risk radiation weight", scienceReward: "Science reward", scienceRadiusM: "Science target radius", enduranceHours: "Consumable endurance", requiredEndReservePct: "Required end reserve", pressurePa: "Surface pressure" };
const ROUTE_DASH = { shortest: [10, 5], fastest: [], lowrisk: [3, 4], science: [14, 4, 2, 4] };

const initialElevation = location.pathname.replace(/\/+$/, "") === "/regions/jezero" ? "hirise" : "mola";
const layerSelection = createLayerState({ elevation: initialElevation });
const state = { terrain: null, terrainSource: initialElevation, mapExtent: "regional", ctx: null, ctxStatus: "", ctxErrorCode: null, ctxRequestId: 0, layer: "elevation", pointMode: "start", start: -1, goal: -1, selected: "fastest", routes: {}, cursor: -1, layerCache: null, hover: -1, profileAt: null, manualAnalysis: null, geologyEnabled: false, inspectGeology: false, selectedGeologyFid: null, manualRoute: { drawing: false, complete: false, waypoints: [], coordinateReferenceId: `${initialElevation}-local-nw-v1` } };
const geologyOverlay = createGeologyOverlay();
const opticalWmts = createOpticalWmtsLayer();
let opticalSource = "off";
let regionalPhotoError = null;
const manualSessions = { mola: null, hirise: null, ctx: null };
const terrainCache = { mola: null, hirise: null };
const terrainLoadPromises = { mola: null, hirise: null };
let regionalContextPromise = null;
let regionalMolaCanvas = null;
let regionalMolaCanvasSource = null;
const regionalCtxTileCanvases = new Map();
const regionalCtxTileLoads = new Map();
const regionalCtxTileFailures = new Map();
let regionalCtxRangeKey = "";
const elevationSessions = { mola: null, hirise: null };

function ctxTileConfiguration() {
  const configured = document.querySelector('meta[name="ctx-tile-base-url"]')?.content.trim() ||
    window.MARS_SURVIVAL_CONFIG?.ctxTileBaseUrl || "";
  const localDev = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
  if (!configured && !localDev) return null;
  const base = configured || new URL("/ctx-terrain/", location.origin).href;
  const normalized = base.endsWith("/") ? base : `${base}/`;
  return { catalogUrl: new URL("catalog.json", normalized).href, tileBaseUrl: normalized };
}

function ctxMapGeometry() {
  const sampler = state.ctx?.sampler;
  if (!sampler || !sampler.width || !sampler.height) return null;
  return { width: sampler.width, height: sampler.height, cellX: sampler.cellX, cellY: sampler.cellY,
    widthM: sampler.widthM, heightM: sampler.heightM, geo: sampler.geo };
}

function setCtxStatus(message, kind = "loading", errorCode = null) {
  state.ctxStatus = message; state.ctxErrorCode = errorCode;
  layerSelection.ctx = updateCtxLayerStatus(layerSelection, { phase: kind === "error" ? "error" : kind === "ready" ? "ready" : message ? "loading" : "idle", message, errorCode }).ctx;
  const node = $("ctx-terrain-status");
  if (node) { node.hidden = !message || state.terrainSource !== "ctx"; node.textContent = message; node.dataset.kind = kind; }
  const retry = $("retry-ctx-analysis");
  if (retry) retry.hidden = !(state.terrainSource === "ctx" && canRetryCtx(layerSelection));
  renderDatasetSummary();
}

async function initializeCtxTerrain() {
  if (state.ctx?.sampler) return state.ctx.sampler;
  if (state.ctx?.initializing) return state.ctx.initializing;
  const config = ctxTileConfiguration();
  if (!config) {
    setCtxStatus("CTX terrain hosting is not configured for this deployment. Set the ctx-tile-base-url meta value to the hosted catalog and tile directory.", "error", "host-unconfigured");
    throw new CtxTerrainSamplerError("CTX terrain hosting is not configured.", "host-unconfigured");
  }
  setCtxStatus("Loading CTX catalog…", "loading");
  const manager = createCtxTerrainManager({ ...config, maxCachedTiles: 12, maxConcurrentLoads: 4 });
  const sampler = createCtxTerrainSampler({ manager });
  const initializing = sampler.loadCatalog().then(catalog => {
    state.ctx = { manager, sampler, catalog, initializing: null };
    setCtxStatus(`CTX catalog ready · ${sampler.width} × ${sampler.height} cells at ${sampler.cellX} m posting. Route tiles load on demand.`, "ready");
    sizeCanvases(); drawMap(); updateManualRouteControls();
    return sampler;
  }).catch(error => {
    state.ctx = null;
    const code = error.code || "catalog-load-failed";
    setCtxStatus(code === "invalid-catalog" || code.includes("metadata") ? `CTX catalog integrity/metadata failure: ${error.message}` : `CTX catalog network failure: ${error.message}`, "error", code);
    throw error;
  });
  state.ctx = { manager, sampler: null, initializing };
  return initializing;
}

const currentPath = location.pathname.replace(/\/+$/, "");
const currentPage = currentPath === "/explore" ? "explore" : currentPath === "/regions/jezero" ? "jezero" : "mission-control";
document.documentElement.dataset.page = currentPage;
document.querySelectorAll("[data-page-link]").forEach(link => {
  if (link.dataset.pageLink === currentPage) link.setAttribute("aria-current", "page");
});

// ---------- inputs ----------
function settings() {
  const num = (id, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : d; };
  return {
    maxSlope: clamp(num("max-slope", 25), 1, 60), speed: clamp(num("walk-speed", 2.5), .5, 8),
    hour: num("local-hour", 12), dust: $("dust").value, radiation: $("radiation").value,
    reserves: { power: num("res-power", 90), o2: num("res-o2", 90), water: num("res-water", 90) },
    endurance: { power: Math.max(1, num("end-power", 8)), o2: Math.max(1, num("end-o2", 8)), water: Math.max(1, num("end-water", 10)) },
    requiredReserve: clamp(num("req-reserve", 30), 0, 90)
  };
}
const params = s => ({ walkSpeedFlatKmh: s.speed });
const multiplier = s => RADIATION_SCENARIOS[s.radiation].multiplier;
const passable = (t, i, maxSlope) => i >= 0 && Number.isFinite(t.z[i]) && Number.isFinite(t.slope[i]) && t.slope[i] <= maxSlope;

function nearestPassable(t, x, y, maxSlope) {
  const c = cellAt(t, clamp(x, 0, t.widthM - 1e-6), clamp(y, 0, t.heightM - 1e-6)), [ci, cj] = cellOf(t, c);
  for (let r = 0; r < Math.max(t.width, t.height); r++)
    for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) {
      if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r || i < 0 || j < 0 || i >= t.width || j >= t.height) continue;
      if (passable(t, j * t.width + i, maxSlope)) return j * t.width + i;
    }
  return c;
}

// ---------- terrain loading ----------
function useTerrain(t) {
  state.terrain = t; state.layerCache = null;
  terrainCache[state.terrainSource] = t;
  state.manualRoute = { drawing: false, complete: false, waypoints: [], coordinateReferenceId: `${state.terrainSource}-local-nw-v1` };
  manualSessions[state.terrainSource] = null;
  state.manualAnalysis = null;
  renderManualAnalysis();
  const sourceId = t.meta.source?.product_id || t.meta.name;
  $("dataset-indicator").textContent = `${sourceId} · loaded`;
  $("dataset-indicator").dataset.kind = t.meta.kind;
  $("dataset-indicator").previousElementSibling.className = `status-dot${t.meta.kind === "synthetic-test" ? " is-synthetic" : ""}`;
  const s = settings(), d = t.meta.defaultRoute;
  state.start = nearestPassable(t, d ? d.start.x : t.widthM * .15, d ? d.start.y : t.heightM * .3, s.maxSlope);
  state.goal = nearestPassable(t, d ? d.goal.x : t.widthM * .85, d ? d.goal.y : t.heightM * .3, s.maxSlope);
  if (state.goal === state.start) state.goal = nearestPassable(t, t.widthM * .8, t.heightM * .7, s.maxSlope);
  state.cursor = state.start; state.selected = "fastest";
  renderTerrainInfo(); renderDatasetSummary(); renderTargets(); renderParams(); updateManualRouteControls(); recompute(); sizeCanvases();
  updateMapExtentControls();
  scheduleRegionalContext();
}
function snapshotElevationSession() {
  return { start: state.start, goal: state.goal, selected: state.selected, routes: state.routes, cursor: state.cursor,
    manualRoute: state.manualRoute, manualAnalysis: state.manualAnalysis };
}
function restoreElevationSession(session) {
  if (!session) return false;
  Object.assign(state, session);
  renderDatasetSummary(); renderTargets(); renderPoints(); renderManualAnalysis(); drawManualProfile();
  renderAll(); updateManualRouteControls(); sizeCanvases();
  return true;
}
async function selectElevationSource(next) {
  if (next === state.terrainSource) return;
  const previous = state.terrainSource;
  const previousManualRoute = state.manualRoute, previousManualAnalysis = state.manualAnalysis;
  if (usesAutomaticRouteElevation(previous) && state.terrain) {
    elevationSessions[previous] = snapshotElevationSession();
    manualSessions[previous] = { route: state.manualRoute, analysis: state.manualAnalysis };
  } else if (previous === "ctx") {
    manualSessions.ctx = { route: state.manualRoute, analysis: state.manualAnalysis };
  }
  state.ctxRequestId++;
  Object.assign(layerSelection, selectLayer(layerSelection, "elevation", next));
  state.terrainSource = next;
  updateMapExtentControls();
  void setMapView("terrain");
  const manual = manualSessions[next];
  state.manualRoute = manual?.route || { drawing: false, complete: false, waypoints: [], coordinateReferenceId: next === "ctx" ? "ctx-mars-equirectangular-local-nw-v2" : `${next}-local-nw-v1` };
  state.manualAnalysis = manual?.analysis || null;
  document.body.classList.toggle("ctx-manual-mode", next === "ctx");
  $("elevation-error").textContent = "";
  $("elevation-layer").value = next;
  if (next === "ctx") {
    $("coverage-pill").textContent = "Jezero CTX DEM · 20 m source posting · manual routes";
    $("terrain-banner").className = "banner nasa";
    $("terrain-banner").textContent = "CTX is a separate elevation product. Tiles load on demand along a drawn route; CTX automatic routing is unavailable. Its full-mosaic vertical reference is unresolved.";
    $("dataset-indicator").textContent = "Jezero CTX · checking catalog"; $("dataset-indicator").dataset.kind = "derived-from-nasa";
    setCtxStatus("", "ready"); renderDatasetSummary(); renderManualAnalysis(); drawManualProfile(); updateManualRouteControls(); drawMap();
    void initializeCtxTerrain().catch(() => {});
    return;
  }
  setCtxStatus("", "ready");
  if (terrainCache[next]) {
    state.terrain = terrainCache[next];
    renderTerrainInfo();
    const sourceId = state.terrain.meta.source?.product_id || state.terrain.meta.name;
    $("dataset-indicator").textContent = `${sourceId} · loaded`; $("dataset-indicator").dataset.kind = state.terrain.meta.kind;
    $("coverage-pill").textContent = next === "mola" ? "MOLA · regional elevation" : "Jezero HiRISE · local elevation";
    if (!restoreElevationSession(elevationSessions[next])) { state.start = -1; state.goal = -1; useTerrain(state.terrain); }
    renderDatasetSummary(); drawMap();
    return;
  }
  $("elevation-status").textContent = `Loading ${next === "mola" ? "MOLA" : "HiRISE"} elevation grid…`;
  const ok = Boolean(await loadTerrainSource(next, `Loading ${next === "mola" ? "MOLA" : "HiRISE"} elevation…`));
  if (!ok) {
    state.terrainSource = previous;
    state.manualRoute = previousManualRoute; state.manualAnalysis = previousManualAnalysis;
    Object.assign(layerSelection, selectLayer(layerSelection, "elevation", previous));
    $("elevation-layer").value = previous;
    document.body.classList.toggle("ctx-manual-mode", previous === "ctx");
    if (usesAutomaticRouteElevation(previous)) restoreElevationSession(elevationSessions[previous]);
    renderDatasetSummary();
  } else {
    $("coverage-pill").textContent = next === "mola" ? "MOLA · regional elevation" : "Jezero HiRISE · local elevation";
  }
}
function showError(msg) { $("elevation-error").textContent = msg || ""; }
async function runImport(fn, label, source = null) {
  const root = document.body; root.setAttribute("aria-busy", "true"); showError(""); $("map-message").textContent = label;
  try {
    const t = await fn();
    if (source) {
      terrainCache[source] = t;
      if (state.terrainSource === source) useTerrain(t);
    } else useTerrain(t);
    $("map-message").textContent = ""; return true;
  }
  catch (err) {
    const msg = err instanceof TerrainError ? err.message : `Could not load the terrain: ${err.message || err}`;
    showError(`${msg}${state.terrain ? " The previous terrain is still loaded." : " No terrain is loaded for this elevation source."}`);
    if (!state.terrain) { $("terrain-banner").className = "banner"; $("terrain-banner").textContent = "Terrain is unavailable. No elevation or route data is being shown."; $("dataset-indicator").textContent = "Terrain unavailable"; $("dataset-indicator").dataset.kind = "missing"; $("dataset-indicator").previousElementSibling.className = "status-dot is-missing"; }
    $("map-message").textContent = ""; return false;
  } finally { root.removeAttribute("aria-busy"); }
}
async function fetchTile(url, notFoundHelp) {
  let r;
  try { r = await fetch(url); } catch { throw new TerrainError("The download failed (network error or blocked request).", "network"); }
  if (!r.ok) throw new TerrainError(r.status === 404 ? notFoundHelp : `The server answered ${r.status} for ${url}.`, "http");
  const len = +r.headers.get("content-length"); if (len > LIMITS.maxTileBytes) throw new TerrainError(`File is ${(len / 1048576).toFixed(0)} MB; the limit is ${LIMITS.maxTileBytes / 1048576} MB.`, "too-large");
  const text = await r.text(); return parseTile(text, { sizeBytes: text.length });
}

function loadTerrainSource(source, label = `Loading ${source === "mola" ? "regional MOLA" : "Jezero HiRISE"} terrain…`) {
  if (terrainCache[source]) return Promise.resolve(terrainCache[source]);
  if (source === "mola" && regionalContextPromise) return regionalContextPromise.then(terrain => {
    if (terrain && state.terrainSource === source && state.terrain !== terrain) useTerrain(terrain);
    return terrain;
  });
  if (terrainLoadPromises[source]) return terrainLoadPromises[source];
  const path = source === "mola" ? "/data/mola-megt44n000hb.json" : "/data/jezero-hirise-tile.json";
  const notFound = source === "mola" ? "The MOLA regional elevation tile is unavailable." : "The verified Jezero HiRISE planner tile is unavailable.";
  terrainLoadPromises[source] = runImport(() => fetchTile(path, notFound), label, source)
    .then(ok => ok ? terrainCache[source] : null)
    .finally(() => { terrainLoadPromises[source] = null; });
  return terrainLoadPromises[source];
}

async function ensureRegionalContext() {
  if (terrainCache.mola) return terrainCache.mola;
  if (terrainLoadPromises.mola) return terrainLoadPromises.mola;
  if (regionalContextPromise) return regionalContextPromise;
  regionalContextPromise = fetchTile("/data/mola-megt44n000hb.json", "The MOLA regional context tile is unavailable.")
    .then(terrain => {
      terrainCache.mola = terrain;
      regionalMolaCanvas = null; regionalMolaCanvasSource = null;
      updateMapExtentControls();
      renderLegend();
      if (state.mapExtent === "regional") drawMap();
      return terrain;
    })
    .catch(error => {
      const status = $("map-extent-status");
      if (status && state.mapExtent === "regional") status.textContent = `MOLA regional context unavailable: ${error.message}. Source detail and route analysis remain available.`;
      regionalContextPromise = null;
      return null;
    });
  return regionalContextPromise;
}

function scheduleRegionalContext() {
  if (state.mapExtent !== "regional" || $("map")?.hidden || state.terrainSource === "mola" || terrainCache.mola || regionalContextPromise) return;
  updateMapExtentControls();
  const enqueue = window.requestIdleCallback || (callback => window.setTimeout(callback, 350));
  enqueue(() => { if (state.mapExtent === "regional" && !$("map")?.hidden) void ensureRegionalContext(); }, { timeout: 1200 });
}

// ---------- routes ----------
function refreshManualAnalysis() {
  if (state.terrainSource === "ctx") { if (state.manualRoute.complete) void analyzeCtxManualRoute(); return; }
  state.manualAnalysis = state.manualRoute.complete && state.terrain
    ? analyzeManualRoute(state.terrain, state.manualRoute.waypoints, { slopeLimitDeg: settings().maxSlope }) : null;
  renderManualAnalysis();
}
function recompute() {
  const t = state.terrain, s = settings();
  if (!t || !usesAutomaticRouteElevation(state.terrainSource)) return;
  if (!passable(t, state.start, s.maxSlope) || !passable(t, state.goal, s.maxSlope)) { /* planRoute reports which end is blocked */ }
  state.routes = {};
  for (const o of Object.keys(OBJECTIVES))
    state.routes[o] = planRoute(t, state.start, state.goal, { objective: o, maxSlopeDeg: s.maxSlope, targets: t.meta.targets || [], params: params(s), doseMultiplier: multiplier(s) });
  renderPoints();
  if (state.manualRoute.complete) refreshManualAnalysis();
  renderAll();
}
function renderAll() { renderRouteList(); drawMap(); drawProfile(); renderWarnings(); renderSurvival(); renderConditions(); renderLegend(); }

function renderPoints() {
  const t = state.terrain, a = cellCentre(t, state.start), b = cellCentre(t, state.goal);
  $("start-x").value = a.x.toFixed(1); $("start-y").value = a.y.toFixed(1); $("goal-x").value = b.x.toFixed(1); $("goal-y").value = b.y.toFixed(1);
}

function renderRouteList() {
  const R = state.routes, ok = Object.entries(R).filter(([, r]) => r.ok);
  const best = (f, cmp) => { if (ok.length < 2) return null; const v = ok.map(([, r]) => f(r.metrics)); const m = cmp(...v); return v.filter(x => Math.abs(x - m) < 1e-9).length === v.length ? null : m; };
  const minL = best(m => m.lengthM, Math.min), minT = best(m => m.timeS, Math.min), minD = best(m => m.doseOneWayMSv, Math.min), maxS = best(m => m.scienceStops.length, Math.max);
  $("route-list").innerHTML = Object.entries(OBJECTIVES).map(([o, def]) => {
    const r = R[o], tags = [];
    if (r.ok) {
      const m = r.metrics;
      if (minL !== null && Math.abs(m.lengthM - minL) < 1e-9) tags.push("shortest here");
      if (minT !== null && Math.abs(m.timeS - minT) < 1e-9) tags.push("fastest here");
      if (minD !== null && Math.abs(m.doseOneWayMSv - minD) < 1e-9) tags.push("lowest modeled dose");
      if (maxS !== null && maxS > 0 && m.scienceStops.length === maxS) tags.push("most science stops");
    }
    const body = r.ok ? `<dl><dt>Distance</dt><dd>${fmtLen(r.metrics.lengthM)} along the ground</dd><dt>Est. walking time</dt><dd>${fmtTime(r.metrics.timeS)} (assumed speed)</dd><dt>Elevation</dt><dd>+${r.metrics.ascentM.toFixed(0)} m / −${r.metrics.descentM.toFixed(0)} m, net ${r.metrics.netElevationM >= 0 ? "+" : "−"}${Math.abs(r.metrics.netElevationM).toFixed(0)} m</dd><dt>Steepest step</dt><dd>${r.metrics.maxEdgeSlopeDeg.toFixed(1)}°</dd><dt>Modeled dose, one way</dt><dd>${(r.metrics.doseOneWayMSv * 1000).toFixed(1)} µSv</dd>${(state.terrain.meta.targets || []).length ? `<dt>Science stops</dt><dd>${r.metrics.scienceStops.length}</dd>` : ""}</dl>` : `<p class="fail">${esc(r.message)}</p>`;
    return `<label class="route"><span class="head"><span><input type="radio" name="route" value="${o}" ${o === state.selected ? "checked" : ""}> ${esc(def.label)}</span><span class="tag">${tags.join(", ")}</span></span><p class="help">${esc(def.help)}</p>${body}</label>`;
  }).join("");
  document.querySelectorAll('input[name="route"]').forEach(el => el.addEventListener("change", () => { state.selected = el.value; drawMap(); drawProfile(); renderWarnings(); renderSurvival(); renderConditions(); }));
}

function renderWarnings() {
  const t = state.terrain, s = settings(), r = state.routes[state.selected], out = [];
  const add = (level, text, why) => out.push(`<li class="${level}">${esc(text)}${why ? `<span class="why">${esc(why)}</span>` : ""}</li>`);
  const m = r?.ok ? r.metrics : null;
  if (m) {
    const steepest = m.steepestSegment;
    if (!steepest) add("diagnostic-empty", "No valid route segments to summarize.", "Terrain diagnostics are unavailable for this route.");
    else {
      const within = steepest.absoluteSlopeDeg <= m.slopeLimitDeg;
      add(within ? "ok" : "danger", `Steepest valid segment ${steepest.index}: ${steepest.startElevationM.toFixed(1)} m → ${steepest.endElevationM.toFixed(1)} m; slope ${steepest.signedSlopeDeg >= 0 ? "+" : ""}${steepest.signedSlopeDeg.toFixed(1)}° (${steepest.absoluteSlopeDeg.toFixed(1)}° absolute); ${fmtLen(steepest.horizontalDistanceM)} horizontal. ${within ? `Within ${m.slopeLimitDeg}° limit.` : `Exceeds ${m.slopeLimitDeg}° limit.`}`, "Per-segment terrain measurement; not a safety certification.");
    }
    if (m.hasInvalidSegments) {
      const reasons = [...new Set(m.invalidSegments.map(segment => segment.invalidReason))].map(reason => ({
        "start-cell-out-of-range": "start cell is outside the terrain grid",
        "end-cell-out-of-range": "end cell is outside the terrain grid",
        "start-no-data": "start cell has no elevation data",
        "end-no-data": "end cell has no elevation data",
        "invalid-horizontal-distance": "horizontal distance is non-finite or non-positive"
      }[reason] || reason));
      add("danger", `Terrain analysis incomplete: ${m.invalidSegments.length} invalid segment${m.invalidSegments.length === 1 ? "" : "s"}.`, reasons.join("; "));
    }
    if (m.overLimitSegments.length) {
      add("danger", `${m.overLimitSegments.length} segment${m.overLimitSegments.length === 1 ? "" : "s"} exceed the ${m.slopeLimitDeg}° slope limit:`, m.overLimitSegments.map(segment => `Segment ${segment.index}: ${segment.absoluteSlopeDeg.toFixed(1)}° (${(segment.absoluteSlopeDeg - m.slopeLimitDeg).toFixed(1)}° over limit)`).join(" · "));
    }
  } else add("diagnostic-empty", "No valid route segments to summarize.", r?.message || "Select valid start and destination points to calculate route diagnostics.");
  if (t.meta.kind === "synthetic-test") add("warn", "These routes cross synthetic terrain, not Martian ground.", "The loaded model is a test fixture generated by tools/make_test_dem.py.");
  if (!r.ok) add("danger", r.message, r.code === "unreachable" ? "Every step must lie on valid cells with slope at or below the limit, and the limit is currently " + s.maxSlope + "°." : "");
  else {
    const m = r.metrics, slow = walkSpeedMS(m.maxEdgeSlopeDeg, params(s)) / walkSpeedMS(0, params(s));
    if (m.maxEdgeSlopeDeg > 10) add(m.maxEdgeSlopeDeg > 18 ? "danger" : "warn", `Steepest step is ${m.maxEdgeSlopeDeg.toFixed(1)}° (limit ${s.maxSlope}°).`, `On this step the assumed walking speed falls to ${(slow * 100).toFixed(0)} % of the flat-ground speed. Warning levels (above 10° and above 18°) are display thresholds, not safety limits.`);
    else add("ok", `All steps are at or below 10° (steepest ${m.maxEdgeSlopeDeg.toFixed(1)}°).`, "");
    add("warn", `Round trip ≈ ${fmtTime(2 * m.timeS)} if you return the same way.`, "Time is length divided by an assumed slope-dependent speed. It is not a measured walking rate.");
    add("warn", `Modeled round-trip dose ≈ ${(2 * m.doseOneWayMSv * 1000).toFixed(1)} µSv.`, "Illustrative: a Gale Crater reference rate scaled by terrain sky view and the radiation scenario. It is not a Jezero measurement.");
  }
  if (s.dust !== "nominal") add("warn", `${DUST[s.dust].label} is selected.`, "Dust scenarios change the temperature model and the survival check. They are not forecasts.");
  if (t.invalidCount) add("warn", `${t.invalidCount} cells (${(100 * t.invalidCount / (t.width * t.height)).toFixed(1)} %) have no elevation data.`, "Routes treat these cells as impassable.");
  $("warnings").innerHTML = out.join("");
}

function renderSurvival() {
  const s = settings(), r = state.routes[state.selected];
  for (const k of ["power", "o2", "water"]) $(`res-${k}-out`).textContent = s.reserves[k];
  const a = assessSurvival({ route: r, reserves: s.reserves, enduranceH: s.endurance, requiredEndReservePct: s.requiredReserve, dust: s.dust, maxSlopeDeg: s.maxSlope });
  const verdict = a.verdict === "GO" ? "Configured criteria met" : "Configured criteria not met";
  $("survival").innerHTML = `<p class="verdict ${a.verdict === "GO" ? "go" : "nogo"}">Scenario result for the ${esc(OBJECTIVES[state.selected].label.toLowerCase())} route: ${verdict}</p><ul class="checks">${a.checks.map(c => `<li class="${c.ok ? "" : "bad"}">${c.ok ? "Pass" : "Fail"}: ${esc(c.text)}</li>`).join("")}</ul><p class="fine">Assumptions: the return follows the same path; consumables are used in proportion to time; endurance figures are placeholders you can edit above. This is not an astronaut-safety assessment.</p>`;
}

function renderConditions() {
  const s = settings(), t = state.terrain, e = environment({ localHour: s.hour, dust: s.dust }), r = state.routes[state.selected];
  const sv = getSkyView(t)[state.start], rows = [
    ["Local solar time", `${s.hour.toFixed(2)} h`, "Scenario", "Chosen with the slider; 24.66 h per sol."],
    ["Air temperature", `${e.tempC.toFixed(0)} °C`, "Scenario", "−55 °C + A·cos(2π(h − 14)/24.66), A shrinks with dust. Illustrative, not fitted to MEDA."],
    ["Dust opacity τ", `${e.tau.toFixed(1)} (dimensionless)`, "Scenario", "Set by the dust selector."],
    ["Surface pressure", `${e.pressurePa} Pa`, "Assumed constant", "Order of magnitude only."],
    ["Modeled dose rate at start", `${doseRate(sv, multiplier(s)).toFixed(2)} mSv/day`, "Modeled", `0.64 mSv/day reference × sky view ${sv.toFixed(2)} × ${multiplier(s)}.`],
    ["Modeled round-trip dose", r.ok ? `${(2 * r.metrics.doseOneWayMSv * 1000).toFixed(1)} µSv` : "n/a", "Modeled", "Integrated along the selected route, doubled."]
  ];
  $("conditions").innerHTML = "<tr><th>Quantity</th><th>Value</th><th>Status</th><th>Basis</th></tr>" + rows.map(x => `<tr><td>${x[0]}</td><td>${x[1]}</td><td><span class="chip">${x[2]}</span></td><td>${x[3]}</td></tr>`).join("");
}

function renderParams() {
  const s = settings();
  $("params").innerHTML = "<tr><th>Parameter</th><th>Default</th><th>Type</th><th>Basis</th></tr>" + Object.entries(PARAMS).map(([k, p]) =>
    `<tr><td>${PARAM_LABELS[k] || k}</td><td>${typeof p.value === "object" ? Object.entries(p.value).map(([a, b]) => `${a} ${b}`).join(", ") : p.value} ${p.unit}</td><td><span class="chip">${p.kind}</span></td><td>${esc(p.note)}</td></tr>`).join("");
  void s;
}
function renderDatasetSummary() {
  const image = layerSelection.imagery === "viking";
  const imageMarkup = `<article class="dataset-card"><span class="eyebrow">IMAGERY · ${image ? "SELECTED" : "OFF"}</span><h3>${image ? "Viking VIS global color mosaic" : "No imagery layer"}</h3><p>NASA Mars Trek · Viking Orbiter visible-light mosaic · ${image ? "~232 m/pixel, near-global coverage" : "shaded globe only"}.</p><p>${image ? "Optical context only; it is not elevation." : "Imagery selection does not affect elevation or route analysis."}</p><a href="https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars" rel="noopener noreferrer">NASA Mars Trek source and attribution</a></article>`;
  const elevation = layerSelection.elevation;
  const elevationDetails = {
    mola: { title: "MOLA MEGDR · MEGT44N000HB", provider: "Mars Global Surveyor / MOLA · PDS Geosciences Node", scale: "~463 m native posting; ~7.9 km planner cells", coverage: "0–90°E, 0–44°N product tile", attribution: "MGS MOLA Science Team / PDS Geosciences Node", limitation: "Regional low-resolution elevation relative to the MOLA areoid; not global." },
    hirise: { title: "Jezero HiRISE DTM · DTEEC_045994_1985_046060_1985_U01", provider: "Mars Reconnaissance Orbiter / HiRISE", scale: "1 m source posting; ~20 m planner grid", coverage: "~6.4 × 14.4 km at Jezero", attribution: "NASA/JPL-Caltech/University of Arizona", limitation: "Planner grid does not resolve metre-scale hazards; elevation is above the Mars 2000 equipotential surface." },
    ctx: { title: "Jezero CTX DEM · Mars 2020 Science Investigation mosaic", provider: "NASA Mars 2020 / Context Camera (CTX); USGS Astrogeology processing", scale: "20 m source posting; sampled on drawn routes", coverage: "~77.00–78.58°E, 17.58–19.29°N", attribution: "USGS Astrogeology product record; retain source citation", limitation: "Manual drawn-route sampling only. Full-mosaic vertical reference is unresolved; do not compare or merge elevations with MOLA/HiRISE." }
  }[elevation];
  const status = elevation === "ctx" ? (state.ctxStatus || "Not configured on this deployment until the CTX catalog is reached.") : (terrainCache[elevation] ? `${elevation === "mola" ? "MOLA" : "HiRISE"} grid loaded; slope and automatic routes use this source.` : `Loading selected ${elevation === "mola" ? "MOLA" : "HiRISE"} elevation grid…`);
  $("dataset-summary").innerHTML = `${imageMarkup}<article class="dataset-card"><span class="eyebrow">ELEVATION · SELECTED</span><h3>${esc(elevationDetails.title)}</h3><p>${esc(elevationDetails.provider)} · ${esc(elevationDetails.scale)}.</p><p>Coverage: ${esc(elevationDetails.coverage)}.</p><p><strong>Attribution:</strong> ${esc(elevationDetails.attribution)}.</p><p><strong>Limitation:</strong> ${esc(elevationDetails.limitation)}</p></article>`;
  const technical = {
    mola: { details: "Product MEGT44N000HB. Simple-cylindrical, planetocentric PDS source at 128 pixels/degree. The browser derivative is block-averaged to about 7.87 km projected cells; elevations are relative to the MOLA areoid.", href: "https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg128/", label: "PDS MOLA MEGDR archive" },
    hirise: { details: "Product DTEEC_045994_1985_046060_1985_U01. Equirectangular, planetocentric; the derivative uses matching ortho map geometry and 20 × 20 source-pixel block averaging. The DTM label omits map projection metadata; the matching ortho label supplies it.", href: "https://hirise.lpl.arizona.edu/dtm/ESP_045994_1985", label: "HiRISE DTM product page" },
    ctx: { details: "PDS4 LID urn:nasa:pds:mars2020_ctx_basemap_2021:data:m20_ctxdem_mosaic. GeoTIFF, equirectangular, planetocentric, positive east; 4,456 × 5,067 Float32 source. Tile checksums and catalog geometry are validated on load. The source does not specify a resolved vertical datum/accuracy.", href: "https://astrogeology.usgs.gov/search/map/mars_2020_science_investigation_ctx_dem_mosaic", label: "USGS CTX DEM product record" }
  }[elevation];
  $("technical-summary").innerHTML = `<p>${esc(technical.details)}</p><p><a href="${technical.href}" rel="noopener noreferrer">${esc(technical.label)}</a> · <a href="https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars" rel="noopener noreferrer">NASA Mars Trek WMTS and Viking layer reference</a></p><p>CTX and HiRISE optical images are separate NASA Mars Trek WMTS layers. They provide visual context only and never supply elevation or route samples.</p>`;
  $("automatic-route-source").textContent = elevation === "ctx"
    ? `CTX is selected for manual drawn-route sampling. Automatic routes shown remain based on the loaded ${state.terrain?.meta.name?.includes("MOLA") ? "MOLA" : "HiRISE"} grid; CTX Dijkstra routing is not implemented.`
    : `Automatic routes and derived slope use the selected ${elevation === "mola" ? "MOLA" : "HiRISE"} elevation grid. CTX supports separate manual drawn-route sampling only.`;
  const available = $("elevation-status");
  if (available) { available.hidden = elevation === "ctx"; available.textContent = elevation === "ctx" ? "" : status; }
}
function renderTargets() {
  const t = state.terrain, list = t.meta.targets || [];
  $("targets").innerHTML = list.length
    ? `<p class="fine">Targets are supplied by the loaded tile${t.meta.kind === "synthetic-test" ? " and are fictional here" : ""}. The science route reduces its cost near them; it does not judge scientific value.</p><table><tr><th>Name</th><th>Position (m east, m south)</th><th>Radius</th><th>Note / source</th></tr>${list.map(x => `<tr><td>${esc(x.name)}</td><td>${x.x.toFixed(0)}, ${x.y.toFixed(0)}</td><td>${(x.radiusM || PARAMS.scienceRadiusM.value)} m</td><td>${esc(x.note || x.source || "")}</td></tr>`).join("")}</table>`
    : "<p>This terrain tile contains no science targets, so the science route is unavailable. No mineralogy layer (for example CRISM) is integrated in this version. Targets can be added to a tile with a source for each.</p>";
}
function renderTerrainInfo() {
  const t = state.terrain, m = t.meta, src = m.source || {};
  const b = $("terrain-banner");
  b.className = "banner " + (m.kind === "synthetic-test" ? "synthetic" : m.kind === "derived-from-nasa" ? "nasa" : "");
  b.textContent = m.kind === "synthetic-test" ? "Showing synthetic test terrain, not Mars. It is available only to development and test workflows."
    : m.kind === "derived-from-nasa" ? `Terrain derived from NASA data${src.product_id ? ` (${src.product_id})` : ""}. Elevation and slope come from that product; radiation, temperature and dust remain modeled scenarios. Use the displayed grid spacing when interpreting route detail.`
      : "User-supplied terrain. Its provenance is whatever the file declares.";
}

// ---------- map drawing ----------
const RAMPS = {
  slope: [[72, 102, 112], [185, 165, 122], [186, 94, 70]],
  dose: [[236, 240, 244], [150, 170, 196], [44, 70, 120]]
};
const ramp = (stops, t) => { t = clamp(t, 0, 1) * (stops.length - 1); const i = Math.min(stops.length - 2, Math.floor(t)), f = t - i; return stops[i].map((v, k) => v + (stops[i + 1][k] - v) * f); };
const css = c => `rgb(${c.map(Math.round).join(",")})`;

function layerImage() {
  const t = state.terrain, s = settings(), key = `${state.layer}|${s.maxSlope}|${s.radiation}`;
  if (state.layerCache?.key === key) return state.layerCache;
  const img = new ImageData(t.width, t.height);
  let lo, hi;
  if (state.layer === "elevation") {
    const rendered = renderElevationPixels(t);
    img.data.set(rendered.data); lo = rendered.low; hi = rendered.high;
  } else {
    let values;
    if (state.layer === "slope") { lo = 0; hi = s.maxSlope; values = t.slope; }
    else { const sv = getSkyView(t); values = Float32Array.from(sv, v => doseRate(v, multiplier(s))); lo = Infinity; hi = -Infinity; for (const v of values) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
    const span = hi - lo || 1;
    for (let k = 0; k < values.length; k++) {
      const o = k * 4, v = values[k];
      let c = [43, 49, 51];
      if (Number.isFinite(t.z[k]) && Number.isFinite(v)) {
        c = state.layer === "slope" && t.slope[k] > s.maxSlope ? [39, 43, 44] : ramp(RAMPS[state.layer], (v - lo) / span);
      }
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
    }
  }
  const off = document.createElement("canvas"); off.width = t.width; off.height = t.height; off.getContext("2d").putImageData(img, 0, 0);
  return (state.layerCache = { key, canvas: off, lo, hi, displayOnly: state.layer === "elevation" });
}

const map = $("map"), mctx = map.getContext("2d"), prof = $("profile"), pctx = prof.getContext("2d");
const regionalPhoto = $("regional-photo");
const activeMapGeometry = () => state.terrainSource === "ctx" ? ctxMapGeometry() : state.terrain;
function regionalMapGeometry() {
  return createRegionalViewport(JEZERO_REGIONAL_EXTENT);
}
const mapViewportGeometry = () => state.mapExtent === "regional" ? regionalMapGeometry() : activeMapGeometry();

function mapPointForLocal(x, y, source = activeMapGeometry()) {
  const viewport = mapViewportGeometry();
  if (!viewport || !source) return [0, 0];
  if (state.mapExtent !== "regional") return [x / source.widthM * map.width, y / source.heightM * map.height];
  const local = sourceLocalToViewport(source, x, y, viewport);
  if (!local) return [-1e6, -1e6];
  return [local.x / viewport.widthM * map.width, local.y / viewport.heightM * map.height];
}

function mapLocalFromEvent(event, source = activeMapGeometry()) {
  const viewport = mapViewportGeometry(), rect = map.getBoundingClientRect();
  if (!viewport || !source || !rect.width || !rect.height || !map.width || !map.height) return null;
  const px = (event.clientX - rect.left) / rect.width * map.width;
  const py = (event.clientY - rect.top) / rect.height * map.height;
  let local;
  if (state.mapExtent === "regional") {
    local = viewportPixelToSource(px, py, map.width, map.height, viewport, source);
  } else {
    local = { x: px / map.width * source.widthM, y: py / map.height * source.heightM };
  }
  if (!local || local.x < 0 || local.y < 0 || local.x >= source.widthM || local.y >= source.heightM) return null;
  return { ...local, canvasX: px, canvasY: py };
}

function regionalContextImage(terrain) {
  if (!terrain) return null;
  if (regionalMolaCanvas && regionalMolaCanvasSource === terrain) return regionalMolaCanvas;
  const rendered = renderElevationPixels(terrain), canvas = document.createElement("canvas");
  canvas.width = terrain.width; canvas.height = terrain.height;
  const context = canvas.getContext("2d");
  context.putImageData(new ImageData(rendered.data, terrain.width, terrain.height), 0, 0);
  regionalMolaCanvas = canvas; regionalMolaCanvasSource = terrain;
  return canvas;
}

function regionalCtxVisibleRecords() {
  const geometry = ctxMapGeometry();
  if (!geometry || !state.ctx?.catalog) return [];
  return visibleCtxTileRecords(state.ctx.catalog, geometry, regionalMapGeometry());
}

function requestRegionalCtxTiles(records) {
  const config = ctxTileConfiguration();
  if (!config) return;
  if (!state.ctx?.sampler) {
    if (state.ctx?.initializing || state.ctxErrorCode) return;
    void initializeCtxTerrain().then(() => drawMap()).catch(() => drawMap());
    return;
  }
  const ctxState = state.ctx, started = [];
  for (const record of records) {
    if (ctxState.manager.peekCachedTile(record.tile_id) || regionalCtxTileLoads.has(record.tile_id) || regionalCtxTileFailures.has(record.tile_id)) continue;
    const promise = ctxState.manager.loadTile(record.tile_id).then(() => {
      regionalCtxTileFailures.delete(record.tile_id);
    }).catch(error => {
      regionalCtxTileFailures.set(record.tile_id, error);
    }).finally(() => regionalCtxTileLoads.delete(record.tile_id));
    regionalCtxTileLoads.set(record.tile_id, promise);
    started.push(promise);
  }
  if (started.length) void Promise.allSettled(started).then(() => {
    if (state.ctx === ctxState && state.mapExtent === "regional") drawMap();
  });
}

function drawRegionalCtx(ctx) {
  const records = regionalCtxVisibleRecords(), ctxState = state.ctx;
  requestRegionalCtxTiles(records);
  if (!ctxState?.sampler) return { records, loaded: 0, loading: Boolean(ctxTileConfiguration() && !state.ctxErrorCode) };
  if (!records.length) return { records, loaded: 0, loading: false };
  const tiles = records.map(record => ctxState.manager.peekCachedTile(record.tile_id)).filter(Boolean);
  if (records.some(record => regionalCtxTileFailures.has(record.tile_id)))
    return { records, loaded: 0, loading: false, unavailable: true };
  if (records.some(record => !ctxState.manager.peekCachedTile(record.tile_id)))
    return { records, loaded: tiles.length, loading: true };
  const range = ctxDisplayRange(tiles), rangeKey = `${range.low}:${range.high}`;
  if (rangeKey !== regionalCtxRangeKey) {
    regionalCtxRangeKey = rangeKey;
    regionalCtxTileCanvases.clear();
  }
  const source = ctxMapGeometry();
  ctx.imageSmoothingEnabled = false;
  for (const record of records) {
    const tile = ctxState.manager.peekCachedTile(record.tile_id);
    if (!tile) continue;
    let entry = regionalCtxTileCanvases.get(record.tile_id);
    if (!entry || entry.tile !== tile || entry.rangeKey !== rangeKey) {
      const pixels = renderCtxCorePixels(tile, range, source.cellX, source.cellY);
      const canvas = document.createElement("canvas");
      canvas.width = pixels.width; canvas.height = pixels.height;
      canvas.getContext("2d").putImageData(new ImageData(pixels.data, pixels.width, pixels.height), 0, 0);
      entry = { tile, rangeKey, canvas };
      regionalCtxTileCanvases.delete(record.tile_id);
      regionalCtxTileCanvases.set(record.tile_id, entry);
      while (regionalCtxTileCanvases.size > 12) regionalCtxTileCanvases.delete(regionalCtxTileCanvases.keys().next().value);
    } else {
      regionalCtxTileCanvases.delete(record.tile_id);
      regionalCtxTileCanvases.set(record.tile_id, entry);
    }
    const core = record.core_window, x0 = core.col_off * source.cellX, y0 = core.row_off * source.cellY;
    const nw = mapPointForLocal(x0, y0, source), se = mapPointForLocal(x0 + core.width * source.cellX, y0 + core.height * source.cellY, source);
    if (se[0] > 0 && nw[0] < map.width && se[1] > 0 && nw[1] < map.height) {
      ctx.globalAlpha = opticalSource === "off" ? 1 : .34;
      ctx.drawImage(entry.canvas, nw[0], nw[1], se[0] - nw[0], se[1] - nw[1]);
      ctx.globalAlpha = 1;
    }
  }
  return { records, loaded: tiles.length, range };
}

function updateMapExtentControls() {
  const regional = state.mapExtent === "regional";
  const regionalButton = $("view-regional"), localButton = $("view-hirise-detail"), status = $("map-extent-status");
  if (regionalButton) regionalButton.setAttribute("aria-pressed", String(regional));
  if (localButton) {
    localButton.setAttribute("aria-pressed", String(!regional));
    localButton.textContent = state.terrainSource === "ctx" ? "CTX DEM · interactive" : "HiRISE local detail";
  }
  if (!status) return;
  if (regional) {
    status.textContent = "USGS Astrogeology public-domain CTX DEM visualization · 20 m/pixel. Image registration to planner coordinates is unverified; use the CTX or HiRISE DEM view for precise route placement.";
  } else {
    const name = state.terrainSource === "hirise" ? "HiRISE local DTM" : state.terrainSource === "ctx" ? "CTX manual route sampling" : "MOLA source grid";
    status.textContent = `${name} source extent · route calculations and samples remain tied to this selected dataset.`;
  }
}
async function enableGeology(enabled) {
  state.geologyEnabled = enabled;
  state.inspectGeology = false;
  state.selectedGeologyFid = null;
  $("inspect-geology").setAttribute("aria-pressed", "false");
  $("inspect-geology").textContent = "Inspect geology";
  $("inspect-geology").disabled = true;
  $("geology-legend").hidden = !enabled;
  $("geology-inspector").hidden = true;
  const status = $("geology-status");
  if (!enabled) { status.textContent = "Geology off · elevation and route analysis are unchanged."; drawMap(); return; }
  status.textContent = "Loading the USGS regional geology overlay…";
  try {
    const data = await geologyOverlay.load();
    if (!state.geologyEnabled) return;
    $("inspect-geology").disabled = false;
    const legend = $("geology-unit-legend");
    legend.replaceChildren();
    for (const item of geologyOverlay.legendItems()) {
      const entry = document.createElement("span"), swatch = document.createElement("i");
      swatch.className = "geology-chip"; swatch.style.backgroundColor = item.color;
      entry.append(swatch, document.createTextNode(`${item.symbol} · ${item.name}`));
      legend.append(entry);
    }
    status.textContent = `Available · ${data.units.length.toLocaleString()} interpreted units and ${data.contacts.length.toLocaleString()} mapped contacts.`;
    drawMap();
  } catch (error) {
    if (!state.geologyEnabled) return;
    state.geologyEnabled = false;
    $("geology-toggle").checked = false;
    $("geology-legend").hidden = true;
    status.textContent = `Geology unavailable · ${error.message} Select the layer to retry.`;
    drawMap();
  }
}

function inspectGeologyAtEvent(event) {
  const geometry = state.mapExtent === "regional" ? regionalMapGeometry() : activeMapGeometry();
  const point = mapLocalFromEvent(event, geometry);
  if (!point || !geometry) { $("geology-inspector").textContent = "The clicked point is outside the active terrain footprint."; }
  else {
    const feature = geologyOverlay.inspectAt(point.x, point.y, geometry);
    if (feature) {
      state.selectedGeologyFid = feature.source_fid;
      $("geology-inspector").textContent = geologyOverlay.summarize(feature);
    } else {
      state.selectedGeologyFid = null;
      $("geology-inspector").textContent = "No mapped geologic unit at this location (it may be an unmapped gap or map area).";
    }
  }
  $("geology-inspector").hidden = false;
  drawMap();
}

function sizeCanvases() {
  const t = mapViewportGeometry(); if (!t) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2), parentWidth = Math.max(280, $("map").parentElement.clientWidth);
  const { width: wCss, height: hCss } = fitMapCssSize(t, parentWidth, window.innerWidth, window.innerHeight);
  map.width = Math.round(wCss * dpr); map.height = Math.round(hCss * dpr);
  map.style.width = `${wCss}px`; map.style.height = `${hCss}px`;
  prof.width = Math.round(Math.max(280, prof.parentElement.clientWidth - 32) * dpr); prof.height = Math.round(prof.width * (window.innerWidth < 600 ? .6 : .3));
  const manual = $("manual-profile");
  manual.width = prof.width; manual.height = prof.height;
  drawMap(); drawProfile(); drawManualProfile();
}
const pxPerMX = () => map.width / activeMapGeometry().widthM;
const pxPerMY = () => map.height / activeMapGeometry().heightM;
const toPx = (x, y) => mapPointForLocal(x, y);

function niceLength(m) { const p = 10 ** Math.floor(Math.log10(m)), f = m / p; return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * p; }
function drawCtxMap() {
  const geometry = ctxMapGeometry(), ctx = mctx;
  if (!geometry || !map.width) {
    ctx.clearRect(0, 0, map.width, map.height); ctx.fillStyle = "#20282b"; ctx.fillRect(0, 0, map.width, map.height);
    ctx.fillStyle = "#d6dddc"; ctx.font = `${14 * (map.width / 900)}px system-ui`;
    ctx.fillText(state.ctxStatus || "Load the CTX catalog to show the full raster footprint.", 18, 32);
    return;
  }
  const catalog = state.ctx?.catalog, manager = state.ctx?.manager, u = map.width / 900;
  ctx.fillStyle = "#20282b"; ctx.fillRect(0, 0, map.width, map.height);
  drawOpticalLayer(ctx, geometry);
  // Outline catalog tile cores. No tile is fetched just to paint this coverage index.
  for (const record of catalog?.tiles || []) {
    const core = record.core_window, x = core.col_off * geometry.cellX * pxPerMX(), y = core.row_off * geometry.cellY * pxPerMY();
    const w = core.width * geometry.cellX * pxPerMX(), h = core.height * geometry.cellY * pxPerMY();
    const tile = manager?.peekCachedTile(record.tile_id);
    if (tile) {
      const m = tile.metadata, coreInTile = m.core_window_in_tile, thumbW = Math.min(64, core.width), thumbH = Math.min(64, core.height);
      const image = ctx.createImageData(thumbW, thumbH), values = tile.elevations;
      let lo = Infinity, hi = -Infinity;
      for (let row = 0; row < core.height; row++) for (let col = 0; col < core.width; col++) {
        const v = values[(coreInTile.row_off + row) * m.width + coreInTile.col_off + col];
        if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      }
      for (let row = 0; row < thumbH; row++) for (let col = 0; col < thumbW; col++) {
        const srcRow = Math.min(core.height - 1, Math.floor(row * core.height / thumbH));
        const srcCol = Math.min(core.width - 1, Math.floor(col * core.width / thumbW));
        const v = values[(coreInTile.row_off + srcRow) * m.width + coreInTile.col_off + srcCol], offset = (row * thumbW + col) * 4;
        if (!Number.isFinite(v)) { image.data[offset + 3] = 0; continue; }
        const gray = hi > lo ? Math.round(60 + 155 * (v - lo) / (hi - lo)) : 120;
        image.data[offset] = gray; image.data[offset + 1] = Math.round(gray * .94); image.data[offset + 2] = Math.round(gray * .86); image.data[offset + 3] = 255;
      }
      const thumb = document.createElement("canvas"); thumb.width = thumbW; thumb.height = thumbH;
      thumb.getContext("2d").putImageData(image, 0, 0); ctx.imageSmoothingEnabled = true;
      ctx.globalAlpha = opticalSource === "off" ? 1 : .34; ctx.drawImage(thumb, x, y, w, h); ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = "rgba(124,150,151,.12)"; ctx.fillRect(x, y, w, h);
    }
    ctx.strokeStyle = tile ? "rgba(209,220,207,.45)" : "rgba(185,201,199,.23)"; ctx.lineWidth = Math.max(.5, u); ctx.strokeRect(x, y, w, h);
  }
  if (state.geologyEnabled) geologyOverlay.draw(ctx, geometry, map.width, map.height, { selectedFid: state.selectedGeologyFid });
  drawManualRoute(ctx, u);
  const barM = niceLength(geometry.widthM * .2), barPx = barM * pxPerMX(), bx = 14 * u, by = map.height - 18 * u;
  ctx.fillStyle = "rgba(255,255,255,.88)"; ctx.fillRect(bx - 6 * u, by - 24 * u, barPx + 12 * u, 36 * u);
  ctx.fillStyle = "#111"; ctx.fillRect(bx, by, barPx, 4 * u); ctx.fillRect(bx, by - 5 * u, 2 * u, 9 * u); ctx.fillRect(bx + barPx - 2 * u, by - 5 * u, 2 * u, 9 * u);
  ctx.font = `${12 * u}px system-ui`; ctx.textAlign = "left"; ctx.textBaseline = "bottom"; ctx.fillText(fmtLen(barM), bx, by - 7 * u);
  ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillStyle = "rgba(12,18,20,.78)"; ctx.fillRect(10 * u, 10 * u, 210 * u, 32 * u);
  ctx.fillStyle = "#e1e7e3"; ctx.fillText("CTX elevation tiles · unloaded tiles outlined", 17 * u, 18 * u);
  map.setAttribute("aria-label", `Full Jezero CTX terrain coverage, ${geometry.width} by ${geometry.height} cells, 20 metre posting. Shaded blocks are decoded cached DEM tiles; outlined blocks are available to load along a drawn route.`);
}

function drawOpticalLayer(ctx, viewport, source = opticalSource) {
  const selectedSource = source === "auto" ? (state.mapExtent === "source" && state.terrainSource === "hirise" ? "hirise" : "ctx") : source;
  const coverageText = result => result.coverage ? `Coverage ${result.coverage[0].toFixed(2)}–${result.coverage[2].toFixed(2)}°E, ${result.coverage[1].toFixed(2)}–${result.coverage[3].toFixed(2)}°N.` : "";
  const update = () => {
    if (!$('map').hidden && (state.mapExtent === 'regional' || state.mapExtent === 'source')) drawMap();
  };
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const result = opticalWmts.draw(ctx, selectedSource, viewport, map.width, map.height, update);
  const status = $('optical-status');
  if (status) status.textContent = selectedSource === 'off' ? 'Optical imagery off · elevation display and route analysis are unchanged.'
    : result.state === 'unavailable' ? `${JEZERO_OPTICAL_LAYERS[selectedSource].label} unavailable · ${result.error}`
      : result.state === 'partial' ? `${JEZERO_OPTICAL_LAYERS[selectedSource].label} · ${result.drawn} visible tiles loaded; ${result.error} ${coverageText(result)} ${result.attribution}`
      : result.state === 'ready' ? `${opticalSource === 'auto' ? 'Auto · ' : ''}${JEZERO_OPTICAL_LAYERS[selectedSource].label} · tiles loaded. ${coverageText(result)} Outside this footprint remains separate map context. ${result.attribution}`
        : `${opticalSource === 'auto' ? 'Auto · ' : ''}${JEZERO_OPTICAL_LAYERS[selectedSource].label} · ${result.state === 'partial' ? `${result.drawn} tiles loaded; ${result.error}` : 'loading visible tiles'}. ${coverageText(result)} ${JEZERO_OPTICAL_LAYERS[selectedSource].attribution}`;
  return result;
}

function drawRegionalPhoto() {
  if (!regionalPhoto.getAttribute("src") && !regionalPhotoError) {
    regionalPhoto.addEventListener("load", () => {
      if (state.mapExtent === "regional" && !map.hidden) drawMap();
    }, { once: true });
    regionalPhoto.addEventListener("error", () => {
      regionalPhotoError = "The USGS regional image could not be loaded; showing the coarse MOLA fallback.";
      const status = $("map-extent-status"); if (status) status.textContent = regionalPhotoError;
      if (state.mapExtent === "regional" && !map.hidden) drawMap();
    }, { once: true });
    regionalPhoto.src = "/images/jezero-usgs-ctx-dem.jpg";
  }
  const loaded = regionalPhoto.complete && regionalPhoto.naturalWidth > 0;
  const show = loaded && state.mapExtent === "regional" && !map.hidden;
  regionalPhoto.hidden = !show;
  if (!show) return false;
  mctx.clearRect(0, 0, map.width, map.height);
  const status = $("map-extent-status");
  if (status) status.textContent = "USGS Astrogeology Science Center · public-domain CTX DEM visualization · 20 m/pixel. Image-to-planner registration is unverified; use an interactive CTX or HiRISE DEM view for exact route placement.";
  $("coord-readout").textContent = "USGS regional image · rendered visualization only · no verified image-to-coordinate registration.";
  map.setAttribute("aria-label", "USGS Astrogeology Science Center public-domain CTX DEM visualization of Jezero Crater at 20 metres per pixel. The full image is shown without cropping or distortion; image registration to planner coordinates is unverified. Switch to CTX or HiRISE DEM view for map interaction.");
  return true;
}

function drawRegionalRouteOverlays(ctx, u) {
  const terrain = state.terrain;
  if (!terrain) return;
  const order = Object.keys(OBJECTIVES).filter(objective => objective !== state.selected).concat(state.selected);
  for (const objective of order) {
    const route = state.routes[objective]; if (!route?.ok) continue;
    ctx.beginPath();
    route.path.forEach((cell, index) => {
      const point = cellCentre(terrain, cell), [x, y] = mapPointForLocal(point.x, point.y, terrain);
      index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    const selected = objective === state.selected;
    ctx.lineJoin = "round"; ctx.setLineDash([]); ctx.strokeStyle = "rgba(8,12,14,.9)"; ctx.lineWidth = (selected ? 8 : 5) * u; ctx.stroke();
    if (selected) { ctx.strokeStyle = "rgba(255,247,222,.96)"; ctx.lineWidth = 5 * u; ctx.stroke(); }
    ctx.setLineDash(ROUTE_DASH[objective].map(value => value * u)); ctx.strokeStyle = selected ? "#a94d2f" : "#f0d6ae";
    ctx.lineWidth = (selected ? 3.2 : 2.2) * u; ctx.stroke();
  }
  ctx.setLineDash([]);
  drawManualRoute(ctx, u);
  if (state.start < 0 || state.goal < 0) return;
  const start = cellCentre(terrain, state.start), goal = cellCentre(terrain, state.goal);
  let [sx, sy] = mapPointForLocal(start.x, start.y, terrain), [gx, gy] = mapPointForLocal(goal.x, goal.y, terrain);
  if (Math.hypot(sx - gx, sy - gy) < 30 * u) {
    const middleX = (sx + gx) / 2, middleY = (sy + gy) / 2, dx = 12 * u;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(middleX - dx, middleY); ctx.moveTo(gx, gy); ctx.lineTo(middleX + dx, middleY);
    ctx.setLineDash([2 * u, 2 * u]); ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 1.4 * u; ctx.stroke(); ctx.setLineDash([]);
    sx = middleX - dx; gx = middleX + dx; sy = gy = middleY;
  }
  const marker = (x, y, label, square) => {
    const radius = 11 * u; ctx.beginPath();
    square ? ctx.rect(x - radius, y - radius, radius * 2, radius * 2) : ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = "#111"; ctx.fill(); ctx.lineWidth = 2.5 * u; ctx.strokeStyle = "#fff"; ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.font = `bold ${13 * u}px system-ui,sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(label, x, y + .5 * u);
  };
  marker(sx, sy, "S", false); marker(gx, gy, "D", true);
}

function drawRegionalMap() {
  const viewport = regionalMapGeometry(), ctx = mctx, u = clamp(map.width / 900, .7, 1.35);
  if (drawRegionalPhoto()) return;
  regionalPhoto.hidden = true;
  ctx.clearRect(0, 0, map.width, map.height);
  ctx.fillStyle = "#141a1c"; ctx.fillRect(0, 0, map.width, map.height);
  const mola = terrainCache.mola;
  if (mola) {
    const image = regionalContextImage(mola), nw = localToLatLon(viewport, 0, 0), se = localToLatLon(viewport, viewport.widthM, viewport.heightM);
    const sourceNW = latLonToLocal(mola, nw.lat, nw.lon), sourceSE = latLonToLocal(mola, se.lat, se.lon);
    const x0 = Math.max(0, sourceNW.x), y0 = Math.max(0, sourceNW.y), x1 = Math.min(mola.widthM, sourceSE.x), y1 = Math.min(mola.heightM, sourceSE.y);
    if (x1 > x0 && y1 > y0) {
      ctx.imageSmoothingEnabled = false; ctx.drawImage(image,
        x0 / mola.widthM * mola.width, y0 / mola.heightM * mola.height,
        (x1 - x0) / mola.widthM * mola.width, (y1 - y0) / mola.heightM * mola.height,
        (x0 - sourceNW.x) / (sourceSE.x - sourceNW.x) * map.width,
        (y0 - sourceNW.y) / (sourceSE.y - sourceNW.y) * map.height,
        (x1 - x0) / (sourceSE.x - sourceNW.x) * map.width,
        (y1 - y0) / (sourceSE.y - sourceNW.y) * map.height);
    }
  }
  if (opticalSource !== "off") { ctx.globalAlpha = .44; drawOpticalLayer(ctx, viewport); ctx.globalAlpha = 1; }

  const footprint = state.terrainSource === "hirise" ? state.terrain : terrainCache.hirise;
  if (footprint?.geo) {
    const corners = [[0, 0], [footprint.widthM, 0], [footprint.widthM, footprint.heightM], [0, footprint.heightM]]
      .map(([x, y]) => mapPointForLocal(x, y, footprint));
    ctx.beginPath(); corners.forEach(([x, y], index) => index ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath();
    ctx.setLineDash([]); ctx.lineWidth = 2 * u; ctx.strokeStyle = "#f1b28e"; ctx.stroke();
    const [labelX, labelY] = corners[0];
    ctx.font = `600 ${12 * u}px system-ui,sans-serif`; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
    ctx.lineWidth = 3 * u; ctx.strokeStyle = "rgba(12,16,18,.9)"; ctx.strokeText("HiRISE local DTM footprint · 20 m", labelX + 4 * u, labelY - 4 * u);
    ctx.fillStyle = "#ffe0ca"; ctx.fillText("HiRISE local DTM footprint · 20 m", labelX + 4 * u, labelY - 4 * u);
  }
  if (state.geologyEnabled) geologyOverlay.draw(ctx, viewport, map.width, map.height, { selectedFid: state.selectedGeologyFid });
  drawRegionalRouteOverlays(ctx, u);

  const parallel = (JEZERO_REGIONAL_EXTENT.standardParallelDeg || 0) * Math.PI / 180;
  const barGroundM = niceLength(JEZERO_REGIONAL_EXTENT.widthM * Math.cos(parallel) * .2);
  const barPx = barGroundM / (JEZERO_REGIONAL_EXTENT.widthM * Math.cos(parallel)) * map.width;
  const bx = 14 * u, by = map.height - 18 * u;
  ctx.fillStyle = "rgba(15,20,22,.9)"; ctx.fillRect(bx - 7 * u, by - 27 * u, barPx + 14 * u, 39 * u);
  ctx.fillStyle = "#eee8da"; ctx.fillRect(bx, by, barPx, 3 * u); ctx.fillRect(bx, by - 4 * u, 2 * u, 8 * u); ctx.fillRect(bx + barPx - 2 * u, by - 4 * u, 2 * u, 8 * u);
  ctx.font = `600 ${11 * u}px system-ui,sans-serif`; ctx.textAlign = "left"; ctx.textBaseline = "bottom"; ctx.fillText(fmtLen(barGroundM), bx, by - 7 * u);
  const nx = map.width - 24 * u, ny = 25 * u;
  ctx.fillStyle = "rgba(15,20,22,.9)"; ctx.fillRect(nx - 18 * u, ny - 19 * u, 36 * u, 56 * u);
  ctx.fillStyle = "#eee8da"; ctx.beginPath(); ctx.moveTo(nx, ny - 11 * u); ctx.lineTo(nx + 7 * u, ny + 10 * u); ctx.lineTo(nx, ny + 5 * u); ctx.lineTo(nx - 7 * u, ny + 10 * u); ctx.closePath(); ctx.fill();
  ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.font = `bold ${12 * u}px system-ui,sans-serif`; ctx.fillText("N", nx, ny + 15 * u);
  ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillStyle = "rgba(12,18,20,.82)"; ctx.fillRect(10 * u, 10 * u, 330 * u, 36 * u);
  ctx.fillStyle = "#e1e7e3"; ctx.font = `${11 * u}px system-ui,sans-serif`;
  const label = regionalPhotoError ? "USGS image unavailable · MOLA coarse fallback" : "Loading USGS image · MOLA fallback is coarse";
  ctx.fillText(label, 17 * u, 18 * u);
  const status = $("map-extent-status");
  if (status && state.mapExtent === "regional") status.textContent = regionalPhotoError || "Loading the USGS regional visualization; the image has no verified registration to planner coordinates. MOLA fallback is coarse.";
  map.setAttribute("aria-label", `Regional Jezero map context. ${regionalPhotoError || "The unregistered USGS rendered CTX DEM image is loading; the MOLA fallback is coarse."} Switch to an interactive CTX or HiRISE DEM view for coordinate-based route placement.`);
}

function drawMap() {
  if (state.mapExtent === "regional") { drawRegionalMap(); return; }
  if (state.terrainSource === "ctx") { drawCtxMap(); return; }
  const t = state.terrain; if (!t || !map.width) return;
  const L = layerImage(), u = clamp(map.width / 900, .7, 1.35), ctx = mctx;
  ctx.clearRect(0, 0, map.width, map.height);
  ctx.fillStyle = "#141a1c"; ctx.fillRect(0, 0, map.width, map.height);
  drawOpticalLayer(ctx, t);
  ctx.imageSmoothingEnabled = t.cellX >= 1000;
  ctx.globalAlpha = .36;
  ctx.drawImage(L.canvas, 0, 0, map.width, map.height);
  ctx.globalAlpha = 1;
  if (state.geologyEnabled) geologyOverlay.draw(ctx, t, map.width, map.height, { selectedFid: state.selectedGeologyFid });
  // routes
  const order = Object.keys(OBJECTIVES).filter(o => o !== state.selected).concat(state.selected);
  for (const o of order) {
    const r = state.routes[o]; if (!r?.ok) continue;
    const sel = o === state.selected; ctx.beginPath();
    r.path.forEach((c, k) => { const q = cellCentre(t, c), [x, y] = toPx(q.x, q.y); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.lineJoin = "round";
    ctx.setLineDash([]); ctx.strokeStyle = "rgba(10,14,16,.88)"; ctx.lineWidth = (sel ? 8 : 5) * u; ctx.stroke();
    if (sel) { ctx.strokeStyle = "rgba(255,247,222,.96)"; ctx.lineWidth = 5 * u; ctx.stroke(); }
    ctx.setLineDash(ROUTE_DASH[o].map(d => d * u)); ctx.strokeStyle = sel ? "#a94d2f" : "#f0d6ae"; ctx.lineWidth = (sel ? 3.2 : 2.2) * u; ctx.stroke();
  }
  drawManualRoute(ctx, u);
  const selectedRoute = state.routes[state.selected], steepest = selectedRoute?.ok ? selectedRoute.metrics.steepestSegment : null;
  if (steepest && selectedRoute.path[steepest.index] === steepest.startCell && selectedRoute.path[steepest.index + 1] === steepest.endCell) {
    const a = cellCentre(t, steepest.startCell), b = cellCentre(t, steepest.endCell), [x1, y1] = toPx(a.x, a.y), [x2, y2] = toPx(b.x, b.y);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.setLineDash([]); ctx.strokeStyle = "#ffe28a"; ctx.lineWidth = 5 * u; ctx.lineCap = "round"; ctx.stroke();
    ctx.beginPath(); ctx.arc((x1 + x2) / 2, (y1 + y2) / 2, 4 * u, 0, Math.PI * 2); ctx.fillStyle = "#ffe28a"; ctx.fill();
  }
  ctx.setLineDash([]);
  // science targets
  for (const g of t.meta.targets || []) {
    const [x, y] = toPx(g.x, g.y), r = 6 * u; ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
    ctx.fillStyle = "#fff"; ctx.fill(); ctx.lineWidth = 2 * u; ctx.strokeStyle = "#111"; ctx.stroke();
  }
  // markers
  const startPoint = cellCentre(t, state.start), goalPoint = cellCentre(t, state.goal);
  let [startX, startY] = toPx(startPoint.x, startPoint.y), [goalX, goalY] = toPx(goalPoint.x, goalPoint.y);
  if (Math.hypot(startX - goalX, startY - goalY) < 30 * u) {
    const dx = 12 * u, midX = (startX + goalX) / 2, midY = (startY + goalY) / 2;
    ctx.beginPath(); ctx.moveTo(startX, startY); ctx.lineTo(midX - dx, midY); ctx.moveTo(goalX, goalY); ctx.lineTo(midX + dx, midY);
    ctx.setLineDash([2 * u, 2 * u]); ctx.strokeStyle = "rgba(255,255,255,.8)"; ctx.lineWidth = 1.4 * u; ctx.stroke(); ctx.setLineDash([]);
    startX = midX - dx; startY = midY; goalX = midX + dx; goalY = midY;
  }
  const mark = (x, y, letter, square) => {
    const r = 11 * u; ctx.beginPath();
    square ? ctx.rect(x - r, y - r, 2 * r, 2 * r) : ctx.arc(x, y, r, 0, 7);
    ctx.fillStyle = "#111"; ctx.fill(); ctx.lineWidth = 2.5 * u; ctx.strokeStyle = "#fff"; ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.font = `bold ${13 * u}px system-ui,sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(letter, x, y + .5 * u);
  };
  mark(startX, startY, "S", false); mark(goalX, goalY, "D", true);
  if (state.cursor >= 0 && document.activeElement === map) { const q = cellCentre(t, state.cursor), [x, y] = toPx(q.x, q.y); ctx.strokeStyle = "#1b5fb4"; ctx.lineWidth = 2 * u; ctx.strokeRect(x - 9 * u, y - 9 * u, 18 * u, 18 * u); }
  // scale bar
  const midRow = Math.floor(t.height / 2), groundWidthM = t.widthM * cellSpacingX(t, midRow) / t.cellX;
  const barM = niceLength(groundWidthM * .2), barPx = barM / groundWidthM * map.width, bx = 14 * u, by = map.height - 18 * u;
  ctx.fillStyle = "rgba(15,20,22,.88)"; ctx.fillRect(bx - 7 * u, by - 27 * u, barPx + 14 * u, 39 * u);
  ctx.fillStyle = "#eee8da"; ctx.fillRect(bx, by, barPx, 3 * u); ctx.fillRect(bx, by - 4 * u, 2 * u, 8 * u); ctx.fillRect(bx + barPx - 2 * u, by - 4 * u, 2 * u, 8 * u);
  ctx.font = `600 ${11 * u}px system-ui,sans-serif`; ctx.textAlign = "left"; ctx.textBaseline = "bottom"; ctx.fillStyle = "#f4f0e6"; ctx.fillText(fmtLen(barM), bx, by - 7 * u);
  // north arrow (raster is north-up)
  const nx = map.width - 24 * u, ny = 25 * u;
  ctx.fillStyle = "rgba(15,20,22,.88)"; ctx.fillRect(nx - 18 * u, ny - 19 * u, 36 * u, 56 * u);
  ctx.fillStyle = "#eee8da"; ctx.beginPath(); ctx.moveTo(nx, ny - 11 * u); ctx.lineTo(nx + 7 * u, ny + 10 * u); ctx.lineTo(nx, ny + 5 * u); ctx.lineTo(nx - 7 * u, ny + 10 * u); ctx.closePath(); ctx.fill();
  ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.font = `bold ${12 * u}px system-ui,sans-serif`; ctx.fillStyle = "#f4f0e6"; ctx.fillText("N", nx, ny + 15 * u);
  map.setAttribute("aria-label", `Terrain map, ${state.layer} layer, ${fmtLen(t.widthM)} wide. Start at ${fmtXY(state.start)}, destination at ${fmtXY(state.goal)}. Arrow keys move the cursor, S sets the start, D sets the destination.`);
}

function drawManualRoute(ctx, u) {
  const { waypoints, drawing, complete } = state.manualRoute;
  if (!waypoints.length) return;
  ctx.save();
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  if (complete && state.manualAnalysis?.segments.length) {
    for (const segment of state.manualAnalysis.segments) {
      if (!segment.start || !segment.end || !Number.isFinite(segment.start.x) || !Number.isFinite(segment.end.x)) continue;
      const [x1, y1] = toPx(segment.start.x, segment.start.y), [x2, y2] = toPx(segment.end.x, segment.end.y);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      ctx.setLineDash(segment.isValid ? [] : [5 * u, 4 * u]);
      ctx.strokeStyle = !segment.isValid ? "#d6dadd" : segment.exceedsSlopeLimit ? "#ff775e" : "#70e2d3";
      ctx.lineWidth = segment.exceedsSlopeLimit ? 5 * u : 4 * u; ctx.stroke();
    }
  } else {
    ctx.beginPath();
    waypoints.forEach((point, index) => {
      const [x, y] = toPx(point.x, point.y);
      index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.setLineDash(drawing ? [7 * u, 4 * u] : []);
    ctx.strokeStyle = "rgba(5, 18, 24, .85)"; ctx.lineWidth = 8 * u; ctx.stroke();
    ctx.strokeStyle = complete ? "#70e2d3" : "#a7f3e8"; ctx.lineWidth = 4 * u; ctx.stroke();
  }
  waypoints.forEach((point, index) => {
    const [x, y] = toPx(point.x, point.y), radius = (index === 0 || index === waypoints.length - 1 ? 6 : 4.5) * u;
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = index === 0 ? "#b8f36b" : index === waypoints.length - 1 ? "#70e2d3" : "#f5f2df";
    ctx.fill(); ctx.strokeStyle = "#101719"; ctx.lineWidth = 2 * u; ctx.stroke();
  });
  ctx.restore();
}

function updateManualRouteControls() {
  const sourceAvailable = (state.terrainSource === "ctx" ? Boolean(ctxMapGeometry()) : Boolean(state.terrain)) && !map.hidden;
  const available = sourceAvailable && state.mapExtent !== "regional";
  const drawing = state.manualRoute.drawing;
  $("manual-route-controls").hidden = !sourceAvailable;
  $("draw-route").disabled = !available || drawing;
  $("finish-route").disabled = !available || !drawing || state.manualRoute.waypoints.length < 2;
  $("cancel-drawing").disabled = !available || !drawing;
  $("clear-route").disabled = !available || drawing || !state.manualRoute.complete;
  $("draw-route-help").textContent = state.mapExtent === "regional"
    ? "The USGS regional image is not registered to planner coordinates. Switch to the interactive CTX or HiRISE DEM view before drawing."
    : drawing
    ? "Click successive points on the terrain map. Missing DEM coverage is allowed; this route is not yet analyzed."
    : state.manualRoute.complete ? "Manual route analyzed from sampled DEM terrain; see its separate diagnostics below."
      : "Manual route drawing is separate from start/destination planning.";
}

function manualProfilePoints(analysis) {
  let distance = 0;
  return analysis.samples.map((sample, index) => {
    if (index > 0) {
      const segment = analysis.segments[index - 1];
      if (Number.isFinite(segment?.horizontalDistanceM) && segment.horizontalDistanceM >= 0) distance += segment.horizontalDistanceM;
    }
    return { ...sample, distanceM: distance, segment: analysis.segments[index] || null };
  });
}

function renderManualAnalysis() {
  const panel = $("manual-analysis"), analysis = state.manualAnalysis;
  if (!panel) return;
  panel.hidden = !state.manualRoute.complete || !analysis;
  if (!analysis || panel.hidden) { $("manual-profile-inspection").textContent = "Hover the manual profile to inspect a terrain sample."; return; }
  const validSegments = analysis.segments.filter(segment => segment.isValid).length;
  const issues = [];
  const issue = (level, title, detail = "") => issues.push(`<li class="${level}">${esc(title)}${detail ? `<span class="why">${esc(detail)}</span>` : ""}</li>`);
  if (!analysis.segments.length || !validSegments) {
    issue("diagnostic-empty", "No valid route segments to summarize.", analysis.segments.length ? "All sampled segments lack valid terrain or distance data." : "Add distinct route points to create a measurable segment.");
  } else if (analysis.passesSlopeConstraint) {
    issue("ok", "Within configured slope constraint based on sampled DEM terrain.", "This is a terrain-planning result, not a safety certification.");
  } else if (analysis.overLimitSegments.length) {
    issue("danger", `${analysis.overLimitSegments.length} sampled segment${analysis.overLimitSegments.length === 1 ? "" : "s"} exceed the ${analysis.slopeLimitDeg}° slope limit.`, analysis.overLimitSegments.map(segment => `Segment ${segment.index}: ${segment.absoluteSlopeDeg.toFixed(1)}° (${(segment.absoluteSlopeDeg - analysis.slopeLimitDeg).toFixed(1)}° over limit)`).join(" · "));
  } else if (analysis.terrainCoverageComplete) {
    issue("diagnostic-empty", "No valid slope assessment is available for this route.");
  }
  if (!analysis.terrainCoverageComplete || analysis.invalidSegments.length) {
    const reasons = [...new Set(analysis.samples.filter(sample => !sample.isValid).map(sample => sample.invalidReason))];
    issue("warn", `Terrain analysis incomplete: ${analysis.samples.filter(sample => !sample.isValid).length} invalid sample${analysis.samples.filter(sample => !sample.isValid).length === 1 ? "" : "s"} and ${analysis.invalidSegments.length} invalid segment${analysis.invalidSegments.length === 1 ? "" : "s"}.`, reasons.join("; ") || "Some terrain samples could not support a reliable calculation.");
  }
  if (analysis.overLimitSegments.length && !analysis.terrainCoverageComplete) {
    issue("danger", `${analysis.overLimitSegments.length} over-limit segment${analysis.overLimitSegments.length === 1 ? "" : "s"} also detected.`, analysis.overLimitSegments.map(segment => `Segment ${segment.index}: ${segment.absoluteSlopeDeg.toFixed(1)}°; limit ${analysis.slopeLimitDeg}°; ${(segment.absoluteSlopeDeg - analysis.slopeLimitDeg).toFixed(1)}° over`).join(" · "));
  }
  $("manual-analysis-issues").innerHTML = issues.join("");
  const status = analysis.passesSlopeConstraint ? "Within configured slope constraint based on sampled DEM terrain."
    : analysis.overLimitSegments.length ? "Slope constraint exceeded in sampled terrain."
      : !analysis.terrainCoverageComplete || analysis.invalidSegments.length ? "Terrain analysis is incomplete; route constraint status is undetermined."
        : "No valid segments are available for a slope assessment.";
  $("manual-analysis-status").textContent = status;
  $("manual-analysis-status").className = `manual-analysis-status ${analysis.passesSlopeConstraint ? "ok" : analysis.overLimitSegments.length ? "danger" : "warn"}`;
  const value = (n, digits = 1) => Number.isFinite(n) ? `${n.toFixed(digits)} m` : "Unavailable";
  const metrics = [
    ["Horizontal distance", value(analysis.totalHorizontalDistanceM)], ["Elevation gain", value(analysis.totalAscentM)],
    ["Elevation loss", value(analysis.totalDescentM)], ["Net elevation change", value(analysis.netElevationChangeM)],
    ["Maximum valid absolute slope", analysis.maximumAbsoluteSlopeDeg === null ? "Unavailable" : `${analysis.maximumAbsoluteSlopeDeg.toFixed(1)}°`],
    ["Configured slope limit", `${analysis.slopeLimitDeg}°`], ["Sampled terrain points", String(analysis.samples.length)],
    ["Valid segments", String(validSegments)], ["Invalid segments", String(analysis.invalidSegments.length)],
    ["Over-limit segments", String(analysis.overLimitSegments.length)],
    ["Sampling interval", Number.isFinite(analysis.samplingIntervalM) ? `${analysis.samplingIntervalM.toFixed(1)} m` : "Unavailable"]
  ];
  $("manual-analysis-metrics").innerHTML = metrics.map(([label, val]) => `<div><dt>${esc(label)}</dt><dd>${esc(val)}</dd></div>`).join("");
  $("manual-analysis-note").textContent = `${analysis.samplingPolicy} Elevations are interpolated from the source DEM; interpolation does not add source terrain resolution.`;
  drawManualProfile();
}

function drawManualProfile() {
  const canvas = $("manual-profile"); if (!canvas) return;
  const ctx = canvas.getContext("2d"), W = canvas.width, H = canvas.height, u = W / 900;
  ctx.clearRect(0, 0, W, H); ctx.fillStyle = "#171c1f"; ctx.fillRect(0, 0, W, H);
  const analysis = state.manualAnalysis;
  const points = analysis ? manualProfilePoints(analysis) : [];
  const valid = points.filter(point => point.isValid && Number.isFinite(point.elevationM));
  if (!valid.length) {
    ctx.fillStyle = "#a7adb0"; ctx.font = `${14 * u}px system-ui`; ctx.fillText("No valid terrain samples to show.", 16 * u, 30 * u);
    canvas.setAttribute("aria-label", "Manual route elevation profile; no valid terrain samples."); return;
  }
  const lo = Math.min(...valid.map(point => point.elevationM)), hi = Math.max(...valid.map(point => point.elevationM));
  const pad = Math.max(2, (hi - lo) * .1), x0 = 64 * u, x1 = W - 14 * u, y0 = 14 * u, y1 = H - 40 * u;
  const total = Math.max(analysis.totalHorizontalDistanceM, 1), X = distance => x0 + distance / total * (x1 - x0);
  const Y = elevation => y1 - (elevation - (lo - pad)) / ((hi + pad) - (lo - pad)) * (y1 - y0);
  ctx.strokeStyle = "rgba(226,232,233,.13)"; ctx.fillStyle = "#aeb7b7"; ctx.font = `${12 * u}px system-ui`; ctx.lineWidth = u; ctx.textAlign = "right";
  for (let k = 0; k <= 4; k++) { const elevation = lo - pad + k / 4 * (hi - lo + 2 * pad), y = Y(elevation); ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); ctx.fillText(`${elevation.toFixed(0)} m`, x0 - 6 * u, y); }
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (let k = 0; k <= 4; k++) { ctx.textAlign = k === 0 ? "left" : k === 4 ? "right" : "center"; ctx.fillText(fmtLen(total * k / 4), X(total * k / 4), y1 + 6 * u); }
  ctx.textAlign = "center"; ctx.fillText("Distance along manual route", (x0 + x1) / 2, y1 + 22 * u);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (!a.isValid || !b.isValid || !Number.isFinite(a.elevationM) || !Number.isFinite(b.elevationM)) continue;
    ctx.beginPath(); ctx.moveTo(X(a.distanceM), Y(a.elevationM)); ctx.lineTo(X(b.distanceM), Y(b.elevationM));
    ctx.strokeStyle = analysis.segments[i - 1]?.exceedsSlopeLimit ? "#ff775e" : "#e3a07e";
    ctx.lineWidth = (analysis.segments[i - 1]?.exceedsSlopeLimit ? 4 : 2.5) * u; ctx.lineCap = "round"; ctx.stroke();
  }
  for (const point of points) if (point.waypointIndex !== null && point.isValid) {
    ctx.beginPath(); ctx.arc(X(point.distanceM), Y(point.elevationM), 3.5 * u, 0, Math.PI * 2);
    ctx.fillStyle = "#f5f2df"; ctx.fill(); ctx.strokeStyle = "#171c1f"; ctx.lineWidth = 1.5 * u; ctx.stroke();
  }
  canvas.setAttribute("aria-label", `Manual route elevation profile with ${analysis.samples.length} ordered terrain samples and ${analysis.invalidSegments.length} invalid segments.`);
}

function startManualRouteDrawing() {
  if ((!state.terrain && state.terrainSource !== "ctx") || map.hidden) return;
  state.ctxRequestId++;
  state.manualAnalysis = null;
  state.manualRoute = { drawing: true, complete: false, waypoints: [], coordinateReferenceId: state.terrainSource === "ctx" ? "ctx-mars-equirectangular-local-nw-v2" : `${state.terrainSource}-local-nw-v1` };
  manualSessions[state.terrainSource] = null;
  renderManualAnalysis(); drawManualProfile();
  $("map-message").textContent = "Click successive points on the terrain map to draw a manual route.";
  updateManualRouteControls(); drawMap();
}
async function analyzeCtxManualRoute(requestId = ++state.ctxRequestId) {
  const route = state.manualRoute;
  if (!route.complete || route.coordinateReferenceId !== "ctx-mars-equirectangular-local-nw-v2") return;
  setCtxStatus("Loading CTX catalog…", "loading");
  try {
    const sampler = await initializeCtxTerrain();
    if (requestId !== state.ctxRequestId || state.terrainSource !== "ctx" || route !== state.manualRoute) return;
    const geometry = ctxMapGeometry();
    const waypoints = route.waypoints.map(point => {
      const geographic = localToLatLon(geometry, point.x, point.y);
      return geographic ? latLonToLocal(geometry, geographic.lat, geographic.lon) : { x: NaN, y: NaN };
    });
    if (waypoints.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x >= geometry.widthM || point.y >= geometry.heightM)) {
      setCtxStatus("Missing terrain coverage: one or more map waypoints fall outside the validated CTX raster footprint.", "warning", "missing-coverage");
    } else {
      const stats = state.ctx.manager.getCacheStats();
      setCtxStatus(`Loading terrain tiles for the drawn route… cache ${stats.cachedTileCount}/12; at most 4 requests run concurrently.`, "loading");
    }
    const coverage = await sampler.ensureTilesForPath(waypoints);
    if (requestId !== state.ctxRequestId || state.terrainSource !== "ctx" || route !== state.manualRoute) return;
    const analysis = analyzeManualRoute(geometry, waypoints, { slopeLimitDeg: settings().maxSlope, sampleDetailsAt: sampler.sampleDetailsAt });
    state.manualAnalysis = analysis; manualSessions.ctx = { route, analysis };
    const outside = coverage.outsideSampleCount > 0 || !analysis.terrainCoverageComplete;
    const detail = `${coverage.requiredTileCount} route tile${coverage.requiredTileCount === 1 ? "" : "s"} required · ${coverage.loadedTileCount} loaded · ${coverage.cachedTileCount} reused · cache ${state.ctx.manager.getCacheStats().cachedTileCount}/12.`;
    setCtxStatus(outside ? `Missing terrain coverage or no-data along the route. ${detail}` : `Ready for analysis · ${detail}`, outside ? "warning" : "ready", outside ? "missing-coverage" : null);
    renderManualAnalysis(); drawMap(); drawManualProfile();
    $("map-message").textContent = "Manual CTX terrain analysis complete. Review the sampled profile and diagnostics below.";
  } catch (error) {
    if (requestId !== state.ctxRequestId || state.terrainSource !== "ctx" || route !== state.manualRoute) return;
    state.manualAnalysis = null; renderManualAnalysis(); drawManualProfile();
    const code = error.cause?.code || error.code || "tile-load-failed";
    const status = code === "cache-capacity" ? `Route exceeds current tile-cache capacity: ${error.message}`
      : ["checksum-mismatch", "invalid-catalog", "invalid-metadata", "binary-length", "binary-decode", "crypto-unavailable"].includes(code)
        ? `CTX tile integrity/metadata failure: ${error.message}`
        : `CTX network failure while loading route terrain: ${error.message}`;
    setCtxStatus(status, "error", code);
    $("map-message").textContent = status;
  }
}

function finishManualRouteDrawing() {
  if (!state.manualRoute.drawing) return;
  if (state.manualRoute.waypoints.length < 2) {
    $("map-message").textContent = "Add at least two route points before finishing.";
    return;
  }
  state.manualRoute.drawing = false; state.manualRoute.complete = true;
  if (state.terrainSource === "ctx") {
    const id = ++state.ctxRequestId;
    state.manualRoute.coordinateReferenceId = "ctx-mars-equirectangular-local-nw-v2";
    $("map-message").textContent = "Route complete. Loading its CTX terrain tiles for analysis…";
    setCtxStatus("Loading CTX catalog…", "loading"); void analyzeCtxManualRoute(id);
  } else {
    refreshManualAnalysis();
    $("map-message").textContent = "Manual route terrain analysis complete. Review sampled coverage and slope diagnostics below.";
  }
  updateManualRouteControls(); drawMap(); drawManualProfile();
}
function cancelManualRouteDrawing() {
  if (!state.manualRoute.drawing) return;
  state.ctxRequestId++;
  state.manualRoute = { drawing: false, complete: false, waypoints: [], coordinateReferenceId: state.terrainSource === "ctx" ? "ctx-mars-equirectangular-local-nw-v2" : `${state.terrainSource}-local-nw-v1` };
  state.manualAnalysis = null;
  renderManualAnalysis();
  $("map-message").textContent = "Manual route drawing canceled.";
  updateManualRouteControls(); drawMap();
}
function clearManualRoute() {
  if (!state.manualRoute.complete) return;
  state.ctxRequestId++;
  state.manualRoute = { drawing: false, complete: false, waypoints: [], coordinateReferenceId: state.terrainSource === "ctx" ? "ctx-mars-equirectangular-local-nw-v2" : `${state.terrainSource}-local-nw-v1` };
  state.manualAnalysis = null;
  renderManualAnalysis(); drawManualProfile();
  $("map-message").textContent = "Manual route cleared.";
  updateManualRouteControls(); drawMap();
}
const fmtXY = i => { const c = cellCentre(state.terrain, i); return `${c.x.toFixed(0)} m east, ${c.y.toFixed(0)} m south`; };

function renderLegend() {
  const t = state.terrain;
  if (!t) {
    $("legend").innerHTML = state.mapExtent === "regional"
      ? "<div class=\"legend-terrain\"><span>USGS rendered CTX DEM visualization · public domain · 20 m/pixel. Not registered to planner coordinates; switch to an interactive DEM view for route placement.</span></div>"
      : "<div class=\"legend-terrain\"><span>Selected terrain source is loading.</span></div>";
    return;
  }
  const L = state.mapExtent === "regional" ? null : layerImage(), s = settings();
  const grad = stops => `linear-gradient(90deg,${[0, .5, 1].map((p, i) => css(stops[i]) + " " + p * 100 + "%").join(",")})`;
  const groundX = cellSpacingX(t, (t.height - 1) / 2), xResolution = groundX.toFixed(groundX >= 100 ? 0 : 1), yResolution = t.cellY.toFixed(t.cellY >= 100 ? 0 : 1);
  const source = t.meta.source?.product_id || t.meta.name || "Loaded terrain";
  const resolution = `${source} · planner grid ≈ ${xResolution} × ${yResolution} m ground spacing`;
  const terrainLegend = state.mapExtent === "regional"
    ? `<div class="legend-terrain"><span>USGS rendered CTX DEM visualization · public domain · 20 m/pixel; image registration to planner coordinates is unverified.</span><span>Use the interactive CTX or HiRISE DEM extent for exact coordinates, route markers, scale, and route drawing.</span></div>`
    : state.layer === "elevation"
    ? `<div class="legend-terrain"><span>Elevation (m) · display stretch ${L.lo.toFixed(0)} to ${L.hi.toFixed(0)} m (2nd–98th percentile)</span><span class="ramp elevation-ramp" aria-hidden="true"></span><span class="legend-nodata"><i aria-hidden="true"></i> Explicit no-data</span><span class="legend-resolution">${resolution} · multidirectional hillshade is display-only</span></div>`
    : `<div class="legend-terrain"><span>${state.layer === "slope" ? `Slope (°), derived using terrain spacing · limit ${s.maxSlope}°` : "Modeled dose rate (mSv/day), illustrative, not measured at this site"}</span><span class="ramp" style="background:${grad(RAMPS[state.layer])}"></span><span>${L.lo.toFixed(state.layer === "dose" ? 2 : 0)} to ${L.hi.toFixed(state.layer === "dose" ? 2 : 0)}</span>${state.layer === "slope" ? `<span><i class="legend-slope-limit"></i> Above configured limit</span>` : ""}<span class="legend-resolution">${resolution}</span></div>`;
  const sw = (o, label) => `<span><svg width="40" height="8" aria-hidden="true"><line x1="0" y1="4" x2="40" y2="4" stroke="${o === state.selected ? "#e3a07e" : "#aeb7b4"}" stroke-width="3" stroke-dasharray="${ROUTE_DASH[o].join(" ")}"/></svg> ${label}</span>`;
  const routes = Object.entries(OBJECTIVES).map(([o, d]) => sw(o, d.label)).join("");
  const routeLegend = state.mapExtent === "regional" ? "<span>Routes and endpoints remain in planner state; they are intentionally not overlaid on this unregistered image.</span>" : `${routes}<span>● Start &nbsp; ■ Destination${(t.meta.targets || []).length ? " &nbsp; ◇ Science target" : ""}</span>`;
  $("legend").innerHTML = `${terrainLegend}<div class="legend-routes">${routeLegend}</div>`;
}

function drawProfile() {
  const r = state.routes[state.selected], ctx = pctx, W = prof.width, H = prof.height, u = W / 900;
  ctx.clearRect(0, 0, W, H); ctx.fillStyle = "#171c1f"; ctx.fillRect(0, 0, W, H);
  if (!r?.ok) { ctx.fillStyle = "#a7adb0"; ctx.font = `${14 * u}px system-ui`; ctx.fillText("No route to show.", 16 * u, 30 * u); $("profile-summary").textContent = r?.message || ""; $("profile-inspection").textContent = "No profile sample available."; prof.setAttribute("aria-label", "No elevation profile: no valid route."); return; }
  const p = r.metrics.profile, zs = p.map(q => q.z), lo = Math.min(...zs), hi = Math.max(...zs), pad = Math.max(2, (hi - lo) * .1);
  const x0 = 64 * u, x1 = W - 14 * u, y0 = 14 * u, y1 = H - 40 * u, S = r.metrics.lengthM || 1;
  const X = s => x0 + s / S * (x1 - x0), Y = z => y1 - (z - (lo - pad)) / ((hi + pad) - (lo - pad)) * (y1 - y0);
  ctx.strokeStyle = "rgba(226,232,233,.13)"; ctx.fillStyle = "#aeb7b7"; ctx.font = `${12 * u}px system-ui`; ctx.lineWidth = 1 * u; ctx.textBaseline = "middle"; ctx.textAlign = "right";
  for (let k = 0; k <= 4; k++) { const z = lo - pad + k / 4 * (hi - lo + 2 * pad), y = Y(z); ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); ctx.fillText(`${z.toFixed(0)} m`, x0 - 6 * u, y); }
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (let k = 0; k <= 4; k++) { ctx.textAlign = k === 0 ? "left" : k === 4 ? "right" : "center"; ctx.fillText(fmtLen(S * k / 4), X(S * k / 4), y1 + 6 * u); }
  ctx.textAlign = "center";
  ctx.fillText("Distance along the route", (x0 + x1) / 2, y1 + 22 * u);
  ctx.beginPath(); p.forEach((q, k) => k ? ctx.lineTo(X(q.s), Y(q.z)) : ctx.moveTo(X(q.s), Y(q.z)));
  ctx.lineTo(X(S), y1); ctx.lineTo(X(0), y1); ctx.closePath(); ctx.fillStyle = "rgba(207,128,95,.15)"; ctx.fill();
  ctx.beginPath(); p.forEach((q, k) => k ? ctx.lineTo(X(q.s), Y(q.z)) : ctx.moveTo(X(q.s), Y(q.z))); ctx.strokeStyle = "#e3a07e"; ctx.lineWidth = 2.5 * u; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke();
  const steepest = r.metrics.steepestSegment;
  if (steepest && p[steepest.index] && p[steepest.index + 1]) {
    const a = p[steepest.index], b = p[steepest.index + 1];
    ctx.beginPath(); ctx.moveTo(X(a.s), Y(a.z)); ctx.lineTo(X(b.s), Y(b.z)); ctx.strokeStyle = "#ffe28a"; ctx.lineWidth = 5 * u; ctx.lineCap = "round"; ctx.stroke();
  }
  for (const sct of r.metrics.scienceStops) { const q = p.reduce((a, b) => Math.abs(b.s - sct.alongM) < Math.abs(a.s - sct.alongM) ? b : a); ctx.beginPath(); const x = X(q.s), y = Y(q.z); ctx.moveTo(x, y - 7 * u); ctx.lineTo(x + 6 * u, y); ctx.lineTo(x, y + 7 * u); ctx.lineTo(x - 6 * u, y); ctx.closePath(); ctx.fillStyle = "#f1decf"; ctx.fill(); ctx.strokeStyle = "#171c1f"; ctx.lineWidth = 2 * u; ctx.stroke(); }
  if (Number.isFinite(state.profileAt)) {
    const at = clamp(state.profileAt, 0, S); let k = p.findIndex((q, n) => n < p.length - 1 && q.s <= at && p[n + 1].s >= at); if (k < 0) k = p.length - 2;
    const a = p[Math.max(0, k)], b = p[Math.min(k + 1, p.length - 1)], f = b.s === a.s ? 0 : (at - a.s) / (b.s - a.s), z = a.z + (b.z - a.z) * f;
    const x = X(at), y = Y(z); ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.strokeStyle = "rgba(241,222,207,.55)"; ctx.lineWidth = 1 * u; ctx.setLineDash([3 * u, 4 * u]); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(x, y, 4 * u, 0, Math.PI * 2); ctx.fillStyle = "#f5dfd1"; ctx.fill(); ctx.strokeStyle = "#8e523d"; ctx.lineWidth = 2 * u; ctx.stroke();
  }
  const m = r.metrics, txt = `${OBJECTIVES[state.selected].label}: ${fmtLen(m.lengthM)}, elevation from ${zs[0].toFixed(0)} m to ${zs[zs.length - 1].toFixed(0)} m (range ${lo.toFixed(0)} to ${hi.toFixed(0)} m), steepest step ${m.maxEdgeSlopeDeg.toFixed(1)}°.${m.scienceStops.length ? " Passes " + m.scienceStops.map(q => q.name).join(", ") + "." : ""}`;
  $("profile-summary").textContent = txt; prof.setAttribute("aria-label", "Elevation profile. " + txt);
}

prof.addEventListener("pointermove", e => {
  const route = state.routes[state.selected]; if (!route?.ok) return;
  const rect = prof.getBoundingClientRect(), u = prof.width / 900, left = 64 * u, right = prof.width - 14 * u;
  const pixel = clamp((e.clientX - rect.left) / rect.width * prof.width, left, right);
  const distance = (pixel - left) / (right - left) * route.metrics.lengthM;
  const profile = route.metrics.profile;
  let k = profile.findIndex((q, n) => n < profile.length - 1 && q.s <= distance && profile[n + 1].s >= distance);
  if (k < 0) k = Math.max(0, profile.length - 2);
  const a = profile[k], b = profile[Math.min(profile.length - 1, k + 1)], f = b.s === a.s ? 0 : (distance - a.s) / (b.s - a.s);
  const elevation = a.z + (b.z - a.z) * f, slope = a.slope + (b.slope - a.slope) * f;
  state.profileAt = distance;
  $("profile-inspection").textContent = `${fmtLen(distance)} along route · ${elevation.toFixed(1)} m elevation · ${slope.toFixed(1)}° step slope`;
  drawProfile();
});
prof.addEventListener("pointerleave", () => {
  state.profileAt = null;
  $("profile-inspection").textContent = "Hover the profile to inspect a distance and elevation sample.";
  drawProfile();
});

$("manual-profile").addEventListener("pointermove", e => {
  const analysis = state.manualAnalysis;
  if (!analysis) return;
  const points = manualProfilePoints(analysis), rect = $("manual-profile").getBoundingClientRect(), u = prof.width / 900;
  const left = 64 * u, right = prof.width - 14 * u;
  const pixel = clamp((e.clientX - rect.left) / rect.width * prof.width, left, right);
  const total = Math.max(analysis.totalHorizontalDistanceM, 1), distance = (pixel - left) / (right - left) * total;
  let k = points.findIndex((point, index) => index < points.length - 1 && point.distanceM <= distance && points[index + 1].distanceM >= distance);
  if (k < 0) k = Math.max(0, points.length - 1);
  const point = points[k], segment = k > 0 ? analysis.segments[k - 1] : null;
  const provenance = point?.datasetId ? ` · ${point.datasetId}${point.tileId ? ` · ${point.tileId}` : ""}` : "";
  $("manual-profile-inspection").textContent = point?.isValid
    ? `${fmtLen(point.distanceM)} along manual route · ${point.elevationM.toFixed(1)} m elevation${segment?.isValid ? ` · ${segment.signedSlopeDeg >= 0 ? "+" : ""}${segment.signedSlopeDeg.toFixed(1)}° signed segment slope${segment.exceedsSlopeLimit ? ` · exceeds ${analysis.slopeLimitDeg}° limit` : ""}` : " · no valid preceding segment"}${provenance}`
    : `${fmtLen(point?.distanceM ?? distance)} along manual route · terrain sample unavailable (${point?.invalidReason || "no sample"})${provenance}.`;
});
$("manual-profile").addEventListener("pointerleave", () => { $("manual-profile-inspection").textContent = "Hover the manual profile to inspect a terrain sample."; });

// ---------- map interaction ----------
function cellFromEvent(e) {
  if (state.mapExtent === "regional") return -1;
  const t = state.terrain, point = mapLocalFromEvent(e, t);
  return point ? cellAt(t, point.x, point.y) : -1;
}
function terrainPointFromEvent(e) {
  return mapLocalFromEvent(e, activeMapGeometry());
}
function describeCell(i) {
  const t = state.terrain, s = settings(), c = cellCentre(t, i), ll = localToLatLon(t, c.x, c.y);
  const z = t.z[i], sl = t.slope[i], dose = doseRate(getSkyView(t)[i], multiplier(s));
  return `x ${c.x.toFixed(0)} m, y ${c.y.toFixed(0)} m` + (ll ? ` · ${ll.lat.toFixed(4)}° N, ${ll.lon.toFixed(4)}° E` : " · no georeference") + (Number.isFinite(z) ? ` · elevation ${z.toFixed(1)} m · slope ${sl.toFixed(1)}°${sl > s.maxSlope ? " (above limit)" : ""} · modeled dose ${dose.toFixed(2)} mSv/day` : " · no data");
}
function setPoint(kind, i) {
  const s = settings(), t = state.terrain;
  if (i < 0) return;
  if (!passable(t, i, s.maxSlope)) { $("map-message").textContent = `That cell has no data or is steeper than ${s.maxSlope}°, so it cannot be a ${kind === "start" ? "start" : "destination"}. Choose another.`; return; }
  $("map-message").textContent = "";
  if (kind === "start") state.start = i; else state.goal = i;
  recompute();
}
map.addEventListener("pointermove", e => {
  if (state.mapExtent === "regional") {
    if (!regionalPhoto.hidden) {
      $("coord-readout").textContent = "USGS regional image · rendered visualization only · no verified image-to-coordinate registration.";
      return;
    }
    const point = mapLocalFromEvent(e, regionalMapGeometry()), view = regionalMapGeometry();
    if (point) {
      const ll = localToLatLon(view, point.x, point.y);
      $("coord-readout").textContent = `Jezero regional context · ${ll.lat.toFixed(4)}° ${ll.lat < 0 ? "S" : "N"}, ${ll.lon.toFixed(4)}° E · source detail required for route placement`;
    }
    return;
  }
  if (state.terrainSource === "ctx") {
    const point = terrainPointFromEvent(e), geometry = ctxMapGeometry();
    if (point && geometry) { const ll = localToLatLon(geometry, point.x, point.y); $("coord-readout").textContent = `CTX-local ${point.x.toFixed(0)} m east, ${point.y.toFixed(0)} m south${ll ? ` · ${ll.lat.toFixed(4)}° N, ${ll.lon.toFixed(4)}° E` : ""}`; }
    return;
  }
  const i = cellFromEvent(e); if (i >= 0) $("coord-readout").textContent = describeCell(i);
});
map.addEventListener("pointerleave", () => { if (usesAutomaticRouteElevation(state.terrainSource) && state.cursor >= 0) $("coord-readout").textContent = describeCell(state.cursor); });
map.addEventListener("click", e => {
  if (state.mapExtent === "regional" && !regionalPhoto.hidden) { $("map-message").textContent = "The USGS visualization is not registered to planner coordinates. Switch to the interactive CTX or HiRISE DEM view before placing or drawing routes."; return; }
  if (state.inspectGeology) { inspectGeologyAtEvent(e); return; }
  if (state.mapExtent === "regional") { $("map-message").textContent = "Regional context is for geographic overview. Choose an interactive CTX or HiRISE DEM extent to place or draw routes."; return; }
  if (state.manualRoute.drawing) {
    const point = terrainPointFromEvent(e);
    if (!point) { $("map-message").textContent = "That point is outside the terrain map and was not added."; return; }
    state.manualRoute.waypoints.push(point);
    $("map-message").textContent = `Manual route: ${state.manualRoute.waypoints.length} point${state.manualRoute.waypoints.length === 1 ? "" : "s"}. Terrain analysis has not been run.`;
    updateManualRouteControls(); drawMap(); return;
  }
  if (state.terrainSource === "ctx") { $("map-message").textContent = "Full CTX mode is for manual route analysis; automatic Dijkstra planning remains on the separate local terrain grid."; return; }
  const i = cellFromEvent(e); state.cursor = i; setPoint(state.pointMode, i);
});
map.addEventListener("focus", () => { drawMap(); if (usesAutomaticRouteElevation(state.terrainSource) && state.terrain && state.cursor >= 0) $("coord-readout").textContent = describeCell(state.cursor); });
map.addEventListener("blur", drawMap);
map.addEventListener("keydown", e => {
  if (state.mapExtent === "regional") return;
  if (state.terrainSource === "ctx") return;
  if (state.inspectGeology && (e.key === "s" || e.key === "S" || e.key === "d" || e.key === "D")) { e.preventDefault(); return; }
  if (state.manualRoute.drawing && (e.key === "s" || e.key === "S" || e.key === "d" || e.key === "D")) { e.preventDefault(); return; }
  const t = state.terrain, [ci, cj] = cellOf(t, state.cursor), k = e.shiftKey ? 10 : 1;
  const mv = { ArrowLeft: [-k, 0], ArrowRight: [k, 0], ArrowUp: [0, -k], ArrowDown: [0, k] }[e.key];
  if (mv) { e.preventDefault(); state.cursor = clamp(cj + mv[1], 0, t.height - 1) * t.width + clamp(ci + mv[0], 0, t.width - 1); drawMap(); $("coord-readout").textContent = describeCell(state.cursor); }
  else if (e.key === "s" || e.key === "S") setPoint("start", state.cursor);
  else if (e.key === "d" || e.key === "D") setPoint("goal", state.cursor);
});

// ---------- wiring ----------
document.querySelectorAll('input[name="layer"]').forEach(el => el.addEventListener("change", () => { state.layer = el.value; drawMap(); renderLegend(); }));
document.querySelectorAll('input[name="pointmode"]').forEach(el => el.addEventListener("change", () => { state.pointMode = el.value; }));
$("geology-toggle").addEventListener("change", event => { void enableGeology(event.target.checked); });
$("inspect-geology").addEventListener("click", () => {
  if (!state.geologyEnabled) return;
  state.inspectGeology = !state.inspectGeology;
  const button = $("inspect-geology");
  button.setAttribute("aria-pressed", String(state.inspectGeology));
  button.textContent = state.inspectGeology ? "Stop inspecting" : "Inspect geology";
  $("geology-inspector").textContent = state.inspectGeology ? "Click a mapped unit to inspect its source attributes. Route placement is paused while inspection is active." : "Geology inspection stopped.";
  $("geology-inspector").hidden = false;
});
$("elevation-layer").value = initialElevation;
$("elevation-layer").addEventListener("change", event => void selectElevationSource(event.target.value));
const retryCtxAnalysisBtn = $("retry-ctx-analysis");
if (retryCtxAnalysisBtn) {
  retryCtxAnalysisBtn.addEventListener("click", () => {
    setCtxStatus("Retrying CTX terrain request…", "loading");
    if (state.manualRoute.complete) void analyzeCtxManualRoute(); else void initializeCtxTerrain().catch(() => {});
  });
}
$("draw-route").addEventListener("click", startManualRouteDrawing);
$("finish-route").addEventListener("click", finishManualRouteDrawing);
$("cancel-drawing").addEventListener("click", cancelManualRouteDrawing);
$("clear-route").addEventListener("click", clearManualRoute);
$("apply-points").addEventListener("click", () => {
  if (!usesAutomaticRouteElevation(state.terrainSource)) { $("map-message").textContent = "Automatic route points are disabled while CTX manual-only terrain is selected."; return; }
  const t = state.terrain, s = settings(), v = id => parseFloat($(id).value);
  const a = cellAt(t, v("start-x"), v("start-y")), b = cellAt(t, v("goal-x"), v("goal-y"));
  if (a < 0 || b < 0) { $("map-message").textContent = `Coordinates must lie inside the terrain: x 0 to ${t.widthM.toFixed(0)} m, y 0 to ${t.heightM.toFixed(0)} m.`; return; }
  if (!passable(t, a, s.maxSlope) || !passable(t, b, s.maxSlope)) { $("map-message").textContent = `A point has no data or is steeper than ${s.maxSlope}°. Choose other coordinates.`; return; }
  $("map-message").textContent = ""; state.start = a; state.goal = b; recompute();
});
["max-slope", "walk-speed"].forEach(id => $(id).addEventListener("change", () => { state.layerCache = null; recompute(); }));
$("radiation").addEventListener("change", () => { state.layerCache = null; recompute(); });
$("dust").addEventListener("change", () => { renderWarnings(); renderSurvival(); renderConditions(); });
$("local-hour").addEventListener("input", () => { $("local-hour-out").textContent = (+$("local-hour").value).toFixed(2); renderConditions(); });
$("use-now").addEventListener("click", () => { const c = marsClock(new Date(), JEZERO_LON_E); $("local-hour").value = (Math.round(c.localHour * 4) / 4).toString(); $("local-hour-out").textContent = (+$("local-hour").value).toFixed(2); renderConditions(); });
["res-power", "res-o2", "res-water"].forEach(id => $(id).addEventListener("input", renderSurvival));
["req-reserve", "end-power", "end-o2", "end-water"].forEach(id => $(id).addEventListener("change", renderSurvival));
for (const [k, v] of Object.entries(DUST)) $("dust").insertAdjacentHTML("beforeend", `<option value="${k}">${v.label}</option>`);
for (const [k, v] of Object.entries(RADIATION_SCENARIOS)) $("radiation").insertAdjacentHTML("beforeend", `<option value="${k}">${v.label}</option>`);
const globe = new MarsGlobe($("globe"), $("globe-status"), $("globe-readout"));
globe.bindControls();
$("imagery-layer").addEventListener("change", event => {
  Object.assign(layerSelection, selectLayer(layerSelection, "imagery", event.target.value));
  globe.setImageryEnabled(layerSelection.imagery === "viking");
  $("globe-status").textContent = layerSelection.imagery === "viking" ? "NASA Mars Trek · Viking VIS global optical imagery · not elevation." : "Imagery disabled · shaded globe; elevation selection is unchanged.";
  renderDatasetSummary();
});
let currentTransitionToken = 0;
let isTransitioning = false;
let transitionTargetView = null;

async function setMapView(view, options = {}) {
  if (isTransitioning) globe.cancelFlyTo();
  const isGlobe = view === "globe";
  if (isGlobe) regionalPhoto.hidden = true;
  const transitionId = ++currentTransitionToken;
  const globeWasInitialized = globe.initialized;
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const skipAnimation = options.immediate || prefersReducedMotion;

  const btnGlobe = $("view-globe");
  const btnTerrain = $("view-terrain");
  const mapWrap = $("map").parentElement;

  if (!isGlobe && state.terrainSource !== "ctx" && !terrainCache[state.terrainSource])
    void loadTerrainSource(state.terrainSource);

  // If already in the target mode and not transitioning, nothing to do
  if (!options.force && !isTransitioning && ((isGlobe && !$("globe").hidden) || (!isGlobe && !$("map").hidden))) {
    return;
  }

  if (isGlobe) globe.activate();

  // Update button active state immediately
  btnGlobe.setAttribute("aria-pressed", String(isGlobe));
  btnTerrain.setAttribute("aria-pressed", String(!isGlobe));

  // If immediate switch requested or user prefers reduced motion
  if (skipAnimation) {
    if (isGlobe && options.location) {
      globe.viewLocation(options.location.longitude, options.location.latitude);
      globe.distance = 3.2;
      globe.scheduleTiles();
    } else if (isGlobe && !options.force) {
      globe.viewLocation(77.4, 18.4);
      globe.distance = 3.2;
      globe.scheduleTiles();
    }
    isTransitioning = false;
    transitionTargetView = null;
    btnGlobe.disabled = false;
    btnTerrain.disabled = false;
    mapWrap.classList.remove("is-transitioning", "crossfade-active");
    $("globe").style.opacity = "";
    $("globe").style.position = "";
    $("map").style.opacity = "";
    $("map").style.position = "";
    let scrim = mapWrap.querySelector(".transition-scrim");
    if (scrim) scrim.remove();

    $("globe").hidden = !isGlobe;
    $("map").hidden = isGlobe;
    $("terrain-controls").hidden = isGlobe;
    $("globe-status").hidden = !isGlobe;
    $("globe-readout").hidden = !isGlobe;
    $("globe-source").hidden = !isGlobe;
    $("coord-readout").hidden = isGlobe;
    $("legend").hidden = isGlobe;
    updateManualRouteControls();

    $("map-h").textContent = isGlobe ? (currentPage === "explore" ? "Mars, in orbit" : "Expedition Orbital Theatre") : "Jezero Crater · regional relief";
    $("map-eyebrow").textContent = isGlobe ? (currentPage === "explore" ? "PLANETARY EXPLORER · GLOBAL VIKING" : "EXPEDITION · GLOBAL VIKING IMAGERY") : "USGS-STYLE CTX DEM DISPLAY";
    $("coverage-pill").textContent = isGlobe ? "NASA Viking VIS · Streamed WMTS" : "CTX DEM relief · 20 m source · display only";
    if (isGlobe) { $("dataset-indicator").textContent = "NASA Viking VIS · imagery"; $("dataset-indicator").dataset.kind = "imagery"; $("dataset-indicator").previousElementSibling.className = "status-dot"; }

    document.body.classList.toggle("explorer-page", currentPage === "explore");
    document.body.classList.toggle("field-lab-page", currentPage === "jezero");
    document.body.classList.toggle("mission-control-page", currentPage === "mission-control");

    if (currentPage === "explore") { $("intro-h").textContent = "Planetary Explorer"; $("globe").setAttribute("aria-label", "NASA Viking visible imagery on the interactive Mars globe. Drag to rotate, scroll to zoom and inspect coordinates."); }
    if (currentPage === "jezero") $("intro-h").textContent = "Jezero Field Lab";

    if (isGlobe) globe.resize();
    else { globe.deactivate(); if (state.terrain || state.terrainSource === "ctx" || state.mapExtent === "regional") sizeCanvases(); }
    if (options.updateUrl !== false) {
      const nextPath = isGlobe ? "/explore" : "/regions/jezero";
      if ((location.pathname !== nextPath && location.pathname !== "/") || (!isGlobe && location.pathname === "/")) {
        history.pushState({ mode: view }, "", nextPath);
      }
    }
    return;
  }

  // Animated Transition Flow
  isTransitioning = true;
  transitionTargetView = view;
  btnGlobe.disabled = true;
  btnTerrain.disabled = true;
  mapWrap.classList.add("is-transitioning");

  let scrim = mapWrap.querySelector(".transition-scrim");
  if (!scrim) {
    scrim = document.createElement("div");
    scrim.className = "transition-scrim";
    mapWrap.appendChild(scrim);
  }

  try {
    if (!isGlobe) {
      $("globe-status").textContent = "Initiating descent vector to Jezero Crater (18.4°N, 77.4°E)…";
      scrim.classList.add("active");
      mapWrap.classList.add("crossfade-active");
      $("map").hidden = false;
      $("map").style.opacity = "0";
      $("globe").style.opacity = "1";
      if (state.terrain || state.terrainSource === "ctx" || state.mapExtent === "regional") sizeCanvases();
      drawMap();
      const flyPromise = globe.flyTo(77.4, 18.4, 500, 1.45);
      $("globe").style.opacity = "0";
      $("map").style.opacity = "1";
      await flyPromise;
      if (transitionId !== currentTransitionToken) return;

      $("globe").hidden = true;
      $("terrain-controls").hidden = false;
      $("globe-status").hidden = true;
      $("globe-readout").hidden = true;
      $("globe-source").hidden = true;
      $("coord-readout").hidden = false;
      $("legend").hidden = false;
      updateManualRouteControls();

      $("map-h").textContent = "Jezero Crater · regional relief";
      $("map-eyebrow").textContent = "USGS-STYLE CTX DEM DISPLAY";
      $("coverage-pill").textContent = "CTX DEM relief · 20 m source · display only";

      if (state.terrain) sizeCanvases();
    } else {
      globe.activate();
      if (!globeWasInitialized) {
        globe.viewLocation(options.location?.longitude ?? 77.4, options.location?.latitude ?? 18.4);
        globe.distance = 1.45;
      }
      scrim.classList.add("active");
      mapWrap.classList.add("crossfade-active");
      $("globe").hidden = false;
      $("globe").style.opacity = "0";
      $("map").style.opacity = "1";
      globe.resize();

      const target = options.location || { longitude: 77.4, latitude: 18.4 };
      const flyPromise = globe.flyTo(target.longitude, target.latitude, 500, 3.2);
      $("globe").style.opacity = "1";
      $("map").style.opacity = "0";
      await flyPromise;
      if (transitionId !== currentTransitionToken) return;

      // Complete transition to 3D
      $("map").hidden = true;
      $("terrain-controls").hidden = true;
      $("globe-status").hidden = false;
      $("globe-readout").hidden = false;
      $("globe-source").hidden = false;
      $("coord-readout").hidden = true;
      $("legend").hidden = true;
      updateManualRouteControls();

      $("map-h").textContent = "Mars globe";
      $("map-eyebrow").textContent = "PLANETARY EXPLORATION";
      $("coverage-pill").textContent = "NASA Viking VIS · Streamed WMTS";

      globe.resize();
    }
    if (options.updateUrl !== false) {
      const nextPath = isGlobe ? "/explore" : "/regions/jezero";
      if ((location.pathname !== nextPath && location.pathname !== "/") || (!isGlobe && location.pathname === "/")) {
        history.pushState({ mode: view }, "", nextPath);
      }
    }
  } catch (error) {
    if (transitionId === currentTransitionToken) {
      const message = error?.message || String(error);
      $("globe-status").textContent = `3D/2D transition recovered to terrain view: ${message}`;
      // A rendering failure must not strand the interface between canvases.
      void setMapView("terrain", { immediate: true, force: true, updateUrl: false });
    }
  } finally {
    if (transitionId === currentTransitionToken) {
      isTransitioning = false;
      transitionTargetView = null;
      btnGlobe.disabled = false;
      btnTerrain.disabled = false;
      mapWrap.classList.remove("is-transitioning", "crossfade-active");
      $("globe").style.opacity = "";
      $("globe").style.position = "";
      $("map").style.opacity = "";
      $("map").style.position = "";
      scrim.classList.remove("active");
      if (!isGlobe) globe.deactivate();
    }
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (isTransitioning && transitionTargetView) {
      const target = transitionTargetView;
      globe.cancelFlyTo();
      void setMapView(target, { immediate: true, force: true, updateUrl: false });
    } else globe.cancelFlyTo();
  } else if (!$("globe").hidden) {
    globe.activate(); globe.resize();
  }
});
window.addEventListener("marsglobecontextlost", () => {
  if (!$("globe").hidden) void setMapView("terrain", { immediate: true, force: true, updateUrl: false });
});
$("view-globe").addEventListener("click", () => setMapView("globe"));
$("view-terrain").addEventListener("click", () => setMapView("terrain"));
$("view-regional").addEventListener("click", () => {
  state.ctxErrorCode = null; regionalCtxTileFailures.clear();
  state.mapExtent = "regional";
  updateMapExtentControls();
  updateManualRouteControls();
  sizeCanvases(); drawMap(); renderLegend();
  scheduleRegionalContext();
});
$("view-hirise-detail").addEventListener("click", async () => {
  if (state.terrainSource === "ctx") {
    state.mapExtent = "source";
    updateMapExtentControls(); updateManualRouteControls(); sizeCanvases(); drawMap(); renderLegend();
    return;
  }
  if (state.terrainSource !== "hirise") await selectElevationSource("hirise");
  if (state.terrainSource !== "hirise" || !state.terrain) return;
  state.mapExtent = "source";
  updateMapExtentControls();
  updateManualRouteControls();
  sizeCanvases(); drawMap(); renderLegend();
});

function goToLocation(input) {
  const query = String(input || "").trim();
  if (!query) return;
  const target = resolveMarsLocation(query);
  if (!target) {
    $("globe-status").textContent = "Choose a listed Mars location or enter latitude, longitude in degrees.";
    return;
  }
  const preset = MARS_LOCATIONS.find(item => item.name === target.name);
  $("site-search").value = preset ? formatMarsLocation(preset) : `${target.latitude.toFixed(3)}, ${target.longitude.toFixed(3)}`;
  if (target.regional) {
    state.mapExtent = "regional";
    updateMapExtentControls();
    updateManualRouteControls();
    if ($("map").hidden) void setMapView("terrain");
    else {
      updateMapExtentControls(); sizeCanvases(); drawMap(); renderLegend(); scheduleRegionalContext();
    }
    $("globe-status").textContent = `Jezero Crater · ${target.latitude.toFixed(1)}°N, ${target.longitude.toFixed(1)}°E · opening regional terrain.`;
  } else {
    const location = { latitude: target.latitude, longitude: target.longitude };
    if ($("globe").hidden) void setMapView("globe", { location });
    else void globe.flyTo(location.longitude, location.latitude, 700, 3.2);
    $("globe-status").textContent = `${target.name} · ${target.latitude.toFixed(1)}° latitude, ${target.longitude.toFixed(1)}°E · NASA Viking VIS provides optical context only.`;
  }
}
$("optical-source").addEventListener("change", event => {
  opticalSource = event.target.value;
  if (!$("map").hidden) drawMap();
});
$("search-place").addEventListener("click", () => goToLocation($("site-search").value));
$("site-search").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $("search-place").click(); } });
$("open-data-panel")?.addEventListener("click", () => {
  const panel = $("panel-data");
  if (panel) panel.open = true;
});
window.addEventListener("popstate", e => {
  const mode = e.state?.mode || (location.pathname === "/regions/jezero" ? "terrain" : "globe");
  setMapView(mode, { updateUrl: false });
});
new ResizeObserver(() => { if (state.terrain) sizeCanvases(); globe.resize(); }).observe($("map").parentElement);
window.addEventListener("resize", () => globe.resize());
void globe.start({ active: currentPage !== "jezero" });
setMapView(currentPage === "jezero" ? "terrain" : "globe", { immediate: true, force: true, updateUrl: false });

$("imagery-layer").value = layerSelection.imagery;
$("optical-source").value = opticalSource;
globe.setImageryEnabled(layerSelection.imagery === "viking");
renderDatasetSummary(); renderParams();
