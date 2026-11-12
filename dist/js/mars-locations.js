export const MARS_LOCATIONS = Object.freeze([
  Object.freeze({ name: "Jezero Crater", latitude: 18.4, longitude: 77.4, regional: true }),
  Object.freeze({ name: "Olympus Mons", latitude: 18.6, longitude: 226.2 }),
  Object.freeze({ name: "Valles Marineris", latitude: -14.0, longitude: 301.0 }),
  Object.freeze({ name: "Gale Crater", latitude: -5.4, longitude: 137.7 })
]);

export function formatMarsLocation(place) {
  return `${place.name} · ${Math.abs(place.latitude).toFixed(1)}°${place.latitude < 0 ? "S" : "N"}, ${place.longitude.toFixed(1)}°E`;
}

export function resolveMarsLocation(input) {
  const query = String(input || "").trim();
  if (!query) return null;
  const place = MARS_LOCATIONS.find(item => query.toLocaleLowerCase().startsWith(item.name.toLocaleLowerCase()));
  if (place) return place;
  const coordinates = query.match(/(-?\d+(?:\.\d+)?)\s*°?\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (!coordinates) return null;
  const latitude = Number(coordinates[1]), longitude = Number(coordinates[2]);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 360) return null;
  return { name: "Entered coordinates", latitude, longitude, regional: false };
}
