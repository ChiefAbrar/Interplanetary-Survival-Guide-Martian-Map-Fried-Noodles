import { MARS_MEAN_RADIUS_M } from "./mars-globe.js";
import { latLonToLocal, localToLatLon } from "./terrain.js";

export const JEZERO_REGIONAL_EXTENT = Object.freeze({
  // Landscape rover-sector frame. The registered CTX footprint extends beyond this crop;
  // its image is clipped by map bounds in geographic coordinates, never stretched.
  widthM: 120_000,
  heightM: 105_000,
  longitude: 77.789999,
  latitude: 18.435353,
  standardParallelDeg: 18.4663
});

export const JEZERO_CTX_RELIEF_BOUNDS = Object.freeze({ west: 76.99743706146002, south: 17.580519910544755,
  east: 78.58256332408818, north: 19.29018700686615 });

export function createRegionalViewport(extent = JEZERO_REGIONAL_EXTENT) {
  const { widthM, heightM, longitude, latitude } = extent;
  return {
    width: widthM, height: heightM, widthM, heightM, cellX: 1, cellY: 1,
    geo: {
      type: "equirectangular", radiusM: MARS_MEAN_RADIUS_M,
      centerLatDeg: latitude, centerLonDeg: longitude,
      originXM: -widthM / 2, originYM: heightM / 2,
      standardParallelDeg: extent.standardParallelDeg ?? 0, planetocentric: true
    }
  };
}

export function sourceLocalToViewport(source, x, y, viewport) {
  const location = localToLatLon(source, x, y);
  return location ? latLonToLocal(viewport, location.lat, location.lon) : null;
}

export function viewportLocalToSource(viewport, x, y, source) {
  const location = localToLatLon(viewport, x, y);
  return location ? latLonToLocal(source, location.lat, location.lon) : null;
}

export function viewportPixelToSource(canvasX, canvasY, pixelWidth, pixelHeight, viewport, source) {
  if (!(pixelWidth > 0) || !(pixelHeight > 0)) return null;
  const x = canvasX / pixelWidth * viewport.widthM;
  const y = canvasY / pixelHeight * viewport.heightM;
  return viewportLocalToSource(viewport, x, y, source);
}
