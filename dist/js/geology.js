import { latLonToLocal } from "./terrain.js";

const SCHEMA = "mars-survival.usgs-sim3464-geology/1";
const APP_PALETTE = ["#9bc6bc", "#d6ad78", "#aeb8d0", "#d78f79", "#9dbd83", "#c2a4ce", "#80aec0", "#d4ca8b"];
const TYPES = new Set(["Polygon", "MultiPolygon"]);

function validPayload(payload) {
  return payload?.schema === SCHEMA && Array.isArray(payload.units) && Array.isArray(payload.contacts) &&
    payload.map_boundary?.geometry && payload.metadata?.coordinate_reference?.not_wgs84 === true;
}

function colorFor(symbol) {
  let hash = 0;
  for (const character of String(symbol || "")) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return APP_PALETTE[hash % APP_PALETTE.length];
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > point.y) !== (yj > point.y) && point.x < (xj - xi) * (point.y - yi) / ((yj - yi) || Number.EPSILON) + xi) inside = !inside;
  }
  return inside;
}

function geometryPolygons(geometry) {
  if (geometry?.type === "Polygon") return [geometry.coordinates];
  if (geometry?.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

function geometryLines(geometry) {
  if (geometry?.type === "LineString") return [geometry.coordinates];
  if (geometry?.type === "MultiLineString") return geometry.coordinates;
  if (geometry?.type === "GeometryCollection") return geometry.geometries.flatMap(geometryLines);
  return [];
}

function pathForPolygons(polygons, terrain, width, height) {
  const path = new Path2D();
  const localPolygons = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let minLocalX = Infinity, minLocalY = Infinity, maxLocalX = -Infinity, maxLocalY = -Infinity;
  for (const polygon of polygons) {
    const localRings = [];
    for (const ring of polygon) {
      const localRing = [];
      for (const [lon, lat] of ring) {
        const p = latLonToLocal(terrain, lat, lon);
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        localRing.push([p.x, p.y]);
        const x = p.x / terrain.widthM * width, y = p.y / terrain.heightM * height;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (p.x < minLocalX) minLocalX = p.x;
        if (p.x > maxLocalX) maxLocalX = p.x;
        if (p.y < minLocalY) minLocalY = p.y;
        if (p.y > maxLocalY) maxLocalY = p.y;
        if (localRing.length === 1) path.moveTo(x, y); else path.lineTo(x, y);
      }
      if (localRing.length > 2) { path.closePath(); localRings.push(localRing); }
    }
    if (localRings.length) localPolygons.push(localRings);
  }
  return { path, localPolygons, bounds: { minX: minLocalX, minY: minLocalY, maxX: maxLocalX, maxY: maxLocalY },
    screenBounds: { minX, minY, maxX, maxY } };
}

function pathForLines(geometry, terrain, width, height) {
  const path = new Path2D();
  for (const line of geometryLines(geometry)) {
    let started = false;
    for (const [lon, lat] of line) {
      const p = latLonToLocal(terrain, lat, lon);
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) { started = false; continue; }
      const x = p.x / terrain.widthM * width, y = p.y / terrain.heightM * height;
      if (!started) path.moveTo(x, y); else path.lineTo(x, y);
      started = true;
    }
  }
  return path;
}

function pointInFeature(point, polygons) {
  for (const rings of polygons) {
    if (rings.length && pointInRing(point, rings[0]) && !rings.slice(1).some(ring => pointInRing(point, ring))) return true;
  }
  return false;
}

function sourceSummary(feature) {
  const a = feature.source_attributes || {};
  const display = feature.display || {};
  const lines = [
    `${display.name || a.name || "Geologic unit"}${display.symbol ? ` (${display.symbol})` : ""}`,
    `Source feature FID ${feature.source_fid}${a.ORIG_FID != null ? ` · ORIG_FID ${a.ORIG_FID}` : ""}`,
    `Source name: ${a.name ?? "—"} · symbol: ${a.symbol ?? "—"} · symbol_noSub: ${a.symbol_noSub ?? "—"} · subscript: ${a.subscript ?? "null"}`,
    `Unit code: ${a.unit ?? "—"} · Color_ID: ${a.Color_ID ?? "—"}`
  ];
  if (display.correction_note) lines.push(`Display note: ${display.correction_note}`);
  return lines.join("\n");
}

export function createGeologyOverlay({ fetchImpl = (...args) => fetch(...args), url = "/data/jezero-geology.json" } = {}) {
  let payload = null;
  let pending = null;
  let projectedKey = "";
  let projected = null;
  let screenKey = "";
  let overlayCanvas = null;
  let overlayCacheKey = "";

  async function load() {
    if (payload) return payload;
    if (pending) return pending;
    pending = (async () => {
      const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`Geology request failed (${response.status}).`);
      const data = await response.json();
      if (!validPayload(data)) throw new Error("The geology payload has an unsupported schema or coordinate reference.");
      payload = data;
      return payload;
    })().catch(error => { pending = null; throw error; });
    return pending;
  }

  function terrainKey(terrain) {
    const geo = terrain.geo || {};
    return [terrain.widthM, terrain.heightM, geo.type, geo.radiusM, geo.centerLatDeg, geo.centerLonDeg,
      geo.originXM, geo.originYM, geo.standardParallelDeg].join("|");
  }

  function prepare(terrain, width, height) {
    const key = terrainKey(terrain);
    if (key !== projectedKey) {
      projectedKey = key;
      screenKey = "";
    }
    const nextScreenKey = `${key}|${width}|${height}`;
    if (screenKey !== nextScreenKey) {
      // Rebuild paths at the current canvas dimensions; all source coordinates were transformed through terrain.js.
      projected = {
        units: payload.units.map(feature => ({ feature, ...pathForPolygons(geometryPolygons(feature.geometry), terrain, width, height) })),
        contacts: payload.contacts.map(feature => ({ feature, path: pathForLines(feature.geometry, terrain, width, height) })),
        boundary: pathForPolygons(geometryPolygons(payload.map_boundary.geometry), terrain, width, height)
      };
      screenKey = nextScreenKey;
    }
    return projected;
  }

  function paint(ctx, layer, width, height, selectedFid) {
    const u = width / 900;
    ctx.save();
    for (const item of layer.units) {
      ctx.fillStyle = colorFor(item.feature.display?.symbol || item.feature.source_attributes?.symbol);
      ctx.globalAlpha = .28;
      ctx.fill(item.path, "evenodd");
      ctx.globalAlpha = .76;
      ctx.lineWidth = .65 * u;
      ctx.strokeStyle = "rgba(12,18,20,.86)";
      ctx.stroke(item.path);
      if (selectedFid === item.feature.source_fid) {
        ctx.globalAlpha = 1;
        ctx.lineWidth = 3 * u;
        ctx.strokeStyle = "#fff1c7";
        ctx.stroke(item.path);
      }
    }
    for (const item of layer.contacts) {
      const type = item.feature.source_attributes?.TYPE;
      if (type !== "certain" && type !== "approximate") continue;
      ctx.setLineDash(type === "approximate" ? [6 * u, 4 * u] : []);
      ctx.globalAlpha = .95;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = 2.5 * u;
      ctx.strokeStyle = "rgba(10,15,17,.92)";
      ctx.stroke(item.path);
      ctx.lineWidth = 1.15 * u;
      ctx.strokeStyle = type === "certain" ? "#f4eee0" : "#f0bd75";
      ctx.stroke(item.path);
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.lineWidth = 4 * u;
    ctx.strokeStyle = "rgba(8,14,18,.9)";
    ctx.stroke(layer.boundary.path);
    ctx.lineWidth = 2 * u;
    ctx.strokeStyle = "#79d4da";
    ctx.stroke(layer.boundary.path);
    ctx.font = `600 ${Math.max(9, 11 * u)}px system-ui,sans-serif`;
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.lineWidth = 3 * u;
    ctx.strokeStyle = "rgba(8,13,16,.92)";
    ctx.strokeText("USGS SIM 3464 map boundary", width - 12 * u, 10 * u);
    ctx.fillStyle = "#8de1e4";
    ctx.fillText("USGS SIM 3464 map boundary", width - 12 * u, 10 * u);
    for (const item of layer.units) {
      const p = item.feature.label_point;
      if (!p || item.screenBounds.maxX - item.screenBounds.minX < 24 * u || item.screenBounds.maxY - item.screenBounds.minY < 16 * u) continue;
      const local = latLonToLocal(terrain, p[1], p[0]);
      if (!local) continue;
      const x = local.x / terrain.widthM * width, y = local.y / terrain.heightM * height;
      const label = item.feature.display?.symbol || item.feature.source_attributes?.symbol;
      ctx.font = `600 ${Math.max(8, Math.min(12, 10 * u))}px system-ui,sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 3 * u;
      ctx.strokeStyle = "rgba(8,13,16,.92)";
      ctx.strokeText(label, x, y);
      ctx.fillStyle = "#fff7df";
      ctx.fillText(label, x, y);
    }
    ctx.restore();
  }

  function draw(ctx, terrain, width, height, { selectedFid = null } = {}) {
    if (!payload || !terrain?.geo || !width || !height) return;
    const layer = prepare(terrain, width, height);
    const key = `${terrainKey(terrain)}|${width}|${height}|${selectedFid ?? ""}`;
    if (key !== overlayCacheKey) {
      overlayCanvas = document.createElement("canvas");
      overlayCanvas.width = width;
      overlayCanvas.height = height;
      const overlayContext = overlayCanvas.getContext("2d");
      paint(overlayContext, layer, width, height, selectedFid);
      overlayCacheKey = key;
    }
    ctx.drawImage(overlayCanvas, 0, 0);
  }

  function inspectAt(x, y, terrain) {
    if (!payload || !terrain?.geo || !(terrain.widthM > 0) || !(terrain.heightM > 0)) return null;
    const layer = prepare(terrain, 900, Math.round(900 * terrain.heightM / terrain.widthM));
    const candidates = layer.units.filter(item => x >= item.bounds.minX && x <= item.bounds.maxX && y >= item.bounds.minY && y <= item.bounds.maxY);
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (pointInFeature({ x, y }, candidates[i].localPolygons)) return candidates[i].feature;
    }
    return null;
  }

  function legendItems() {
    if (!payload) return [];
    const items = new Map();
    for (const feature of payload.units) {
      const symbol = feature.display?.symbol || feature.source_attributes?.symbol || "?";
      const name = feature.display?.name || feature.source_attributes?.name || "Unlabeled unit";
      if (!items.has(symbol)) items.set(symbol, { symbol, name, color: colorFor(symbol) });
    }
    return [...items.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  return { load, draw, inspectAt, legendItems, get payload() { return payload; }, summarize: sourceSummary };
}
