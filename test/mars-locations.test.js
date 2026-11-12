import test from "node:test";
import assert from "node:assert/strict";
import { MARS_LOCATIONS, formatMarsLocation, resolveMarsLocation } from "../public/js/mars-locations.js";

test("restored quick locations preserve the prior documented Jezero, Olympus and Valles coordinates", () => {
  assert.deepEqual(MARS_LOCATIONS.slice(0, 3).map(({ name, latitude, longitude }) => [name, latitude, longitude]), [
    ["Jezero Crater", 18.4, 77.4], ["Olympus Mons", 18.6, 226.2], ["Valles Marineris", -14.0, 301.0]
  ]);
  assert.equal(formatMarsLocation(MARS_LOCATIONS[2]), "Valles Marineris · 14.0°S, 301.0°E");
});

test("location search resolves named places, datalist values, and entered coordinates", () => {
  assert.equal(resolveMarsLocation("Olympus Mons").longitude, 226.2);
  assert.equal(resolveMarsLocation("Jezero Crater · 18.4°N, 77.4°E").regional, true);
  assert.deepEqual(resolveMarsLocation("-14, 301"), { name: "Entered coordinates", latitude: -14, longitude: 301, regional: false });
  assert.equal(resolveMarsLocation("91, 301"), null);
  assert.equal(resolveMarsLocation("unknown crater"), null);
});
