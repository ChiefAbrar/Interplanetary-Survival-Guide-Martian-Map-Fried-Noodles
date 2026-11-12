import test from "node:test";
import assert from "node:assert/strict";
import { canRetryCtx, createLayerState, selectLayer, updateCtxLayerStatus, usesAutomaticRouteElevation } from "../public/js/layer-state.js";
import { readFile } from "node:fs/promises";

test("imagery and elevation selection are independent", () => {
  let state = createLayerState({ elevation: "hirise" });
  state = selectLayer(state, "imagery", "off");
  assert.equal(state.imagery, "off");
  assert.equal(state.elevation, "hirise");
  state = selectLayer(state, "elevation", "mola");
  assert.equal(state.imagery, "off");
  assert.equal(state.elevation, "mola");
});

test("CTX status models loading, retryable failure, and recovery", () => {
  let state = createLayerState({ elevation: "ctx" });
  state = updateCtxLayerStatus(state, { phase: "loading", message: "Loading CTX catalog…" });
  assert.equal(state.ctx.phase, "loading");
  state = updateCtxLayerStatus(state, { phase: "error", message: "Request failed", errorCode: "network" });
  assert.equal(state.ctx.errorCode, "network");
  assert.equal(canRetryCtx(state), true);
  assert.equal(canRetryCtx(updateCtxLayerStatus(state, { phase: "error", errorCode: "cache-capacity" })), false);
  state = updateCtxLayerStatus(state, { phase: "ready", message: "Catalog ready" });
  assert.equal(state.ctx.phase, "ready");
  assert.equal(state.ctx.errorCode, null);
});

test("CTX manual analysis is excluded from automatic route elevation", () => {
  assert.equal(usesAutomaticRouteElevation("mola"), true);
  assert.equal(usesAutomaticRouteElevation("hirise"), true);
  assert.equal(usesAutomaticRouteElevation("ctx"), false);
});

test("public layer interface retains provenance labels and hides developer import controls", async () => {
  const html = await readFile(new URL("../app/views/home/index.html.erb", import.meta.url), "utf8");
  const script = await readFile(new URL("../public/js/app.js", import.meta.url), "utf8");
  assert.match(html, /Viking VIS/);
  assert.match(html, /MOLA MEGDR/);
  assert.match(html, /HiRISE DTM/);
  assert.match(html, /CTX DEM/);
  assert.match(html, /ctx-terrain-status/);
  assert.match(html, /retry-ctx-analysis/);
  assert.doesNotMatch(html, /id="load-test"|id="dem-file"|Load bundled synthetic test terrain|Open a file/);
  assert.match(script, /NASA\/JPL-Caltech\/University of Arizona/);
  assert.match(script, /CTX.*manual|manual.*CTX/i);
  assert.match(script, /!usesAutomaticRouteElevation\(state\.terrainSource\)/);
});
