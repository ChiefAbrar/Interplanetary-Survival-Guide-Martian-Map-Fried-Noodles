import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createGeologyOverlay } from "../public/js/geology.js";

const payload = {
  schema: "mars-survival.usgs-sim3464-geology/1",
  metadata: { coordinate_reference: { not_wgs84: true } },
  units: [{ source_fid: 112, source_attributes: { name: "Upper etched unit", symbol: "Nue", symbol_noSub: "Nnp", subscript: "2", ORIG_FID: 112, Color_ID: 74 }, display: { name: "Upper etched unit", symbol: "Nue", correction_note: "Conflict retained." } }],
  contacts: [],
  map_boundary: { geometry: { type: "Polygon", coordinates: [] } }
};

test("geology payload is lazy loaded and cached after success", async () => {
  let calls = 0;
  const overlay = createGeologyOverlay({ fetchImpl: async () => { calls++; return { ok: true, json: async () => payload }; } });
  assert.equal(calls, 0);
  const [first, second] = await Promise.all([overlay.load(), overlay.load()]);
  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.equal(overlay.legendItems()[0].symbol, "Nue");
});

test("failed geology payload validation can be retried", async () => {
  let calls = 0;
  const overlay = createGeologyOverlay({ fetchImpl: async () => {
    calls++;
    return { ok: true, json: async () => calls === 1 ? {} : payload };
  } });
  await assert.rejects(overlay.load(), /unsupported schema/);
  assert.equal((await overlay.load()).schema, payload.schema);
  assert.equal(calls, 2);
});

test("geology inspector keeps anomalous source fields visible with the display correction", async () => {
  const overlay = createGeologyOverlay({ fetchImpl: async () => ({ ok: true, json: async () => payload }) });
  const feature = (await overlay.load()).units[0];
  const summary = overlay.summarize(feature);
  assert.match(summary, /Upper etched unit \(Nue\)/);
  assert.match(summary, /symbol: Nue/);
  assert.match(summary, /symbol_noSub: Nnp/);
  assert.match(summary, /subscript: 2/);
  assert.match(summary, /Conflict retained/);
});

test("processed SIM 3464 asset preserves source rows and records the validated topology result", async () => {
  const processed = JSON.parse(await readFile(new URL("../public/data/jezero-geology.json", import.meta.url), "utf8"));
  assert.equal(processed.schema, payload.schema);
  assert.equal(processed.metadata.coordinate_reference.not_wgs84, true);
  assert.equal(processed.metadata.coordinate_reference.sphere_radius_m, 3396190);
  assert.equal(processed.units.length, 1304);
  assert.equal(processed.contacts.length, 2496);
  assert.equal(processed.metadata.simplification.selected_tolerance_m, 15);
  assert.equal(processed.metadata.simplification.candidate_accepted, true);
  assert.deepEqual(processed.metadata.simplification.candidate_checks, {
    source_coverage_valid: true,
    candidate_coverage_valid: true,
    all_features_valid: true,
    all_feature_ids_retained: true,
    polygon_parts_preserved: true,
    holes_preserved: true,
    map_boundary_gap_delta_m2: 0,
    union_symmetric_difference_m2: 0,
    max_discrete_boundary_hausdorff_m: 11.38549115631048
  });
  const byFid = new Map(processed.units.map(feature => [feature.source_fid, feature]));
  assert.equal(byFid.get(112).source_attributes.symbol_noSub, "Nnp");
  assert.equal(byFid.get(112).source_attributes.subscript, "2");
  assert.equal(byFid.get(112).display.symbol, "Nue");
  assert.equal(byFid.get(561).source_attributes.subscript, "2");
  assert.equal(byFid.get(561).display.symbol, "Nrb");
  assert.equal(byFid.get(1004).source_attributes.name, "Crater riim unit");
  assert.equal(byFid.get(1004).display.name, "Crater rim unit");
  assert.equal(processed.metadata.invalid_geometry_overrides.length, 2);
  assert.ok(processed.units.every(feature => ["Polygon", "MultiPolygon"].includes(feature.geometry.type)));
  assert.ok(processed.units.every(feature => feature.geometry.coordinates.length > 0));
  assert.ok(processed.map_boundary.geometry);
});

test("map integration keeps the optional geology overlay below routes and gates map clicks", async () => {
  const app = await readFile(new URL("../public/js/app.js", import.meta.url), "utf8");
  const view = await readFile(new URL("../app/views/home/index.html.erb", import.meta.url), "utf8");
  const background = app.indexOf("ctx.drawImage(L.canvas, 0, 0, map.width, map.height)");
  const overlay = app.indexOf("geologyOverlay.draw(ctx, t, map.width, map.height");
  const routes = app.indexOf("// routes", overlay);
  assert.ok(background >= 0 && overlay > background && routes > overlay);
  assert.match(app, /if \(state\.inspectGeology\) \{ inspectGeologyAtEvent\(e\); return; \}/);
  assert.match(app, /if \(state\.geologyEnabled\) geologyOverlay\.draw\(ctx, geometry, map\.width, map\.height/);
  assert.match(app, /if \(state\.inspectGeology && \(e\.key === "s".*?setPoint\("goal", state\.cursor\);/s);
  assert.match(app, /if \(state\.geologyEnabled\) geologyOverlay\.draw\(ctx, t, map\.width, map\.height/);
  assert.match(view, /id="geology-toggle" type="checkbox"/);
  assert.match(view, /id="inspect-geology"/);
  assert.match(view, /not a route-safety or hazard layer/);
});

