const clean = value => value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim();

function text(xml, localName) {
  const match = xml.match(new RegExp(`<(?:[\\w.-]+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${localName}\\s*>`, "i"));
  return match ? clean(match[1].replace(/<[^>]*>/g, "")) : "";
}

function blocks(xml, localName) {
  return [...xml.matchAll(new RegExp(`<(?:[\\w.-]+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${localName}\\s*>`, "gi"))].map(m => m[1]);
}

function numbers(value, count, name) {
  const values = value.trim().split(/\s+/).map(Number);
  if (values.length !== count || values.some(v => !Number.isFinite(v))) throw new Error(`Invalid WMTS ${name}.`);
  return values;
}

/** Read the WMTS values that control tile geometry and URL generation from a real Capabilities document. */
export function parseWmtsCapabilities(xml, layerId) {
  if (typeof xml !== "string" || xml.length > 8_000_000) throw new Error("WMTS capabilities are missing or too large.");
  // Commented alternate matrix examples on Trek are documentation, not live
  // TileMatrix entries. Exclude them before parsing the advertised matrix set.
  xml = xml.replace(/<!--[\s\S]*?-->/g, "");
  const layer = blocks(xml, "Layer").find(b => text(b, "Identifier") === layerId);
  if (!layer) throw new Error(`WMTS layer ${layerId} was not found in Capabilities.`);
  const format = text(layer, "Format");
  if (!/^image\/(png|jpeg|jpg)$/i.test(format)) throw new Error(`Unsupported WMTS image format: ${format || "missing"}.`);
  const link = blocks(layer, "TileMatrixSetLink")[0];
  const matrixSetId = text(link || "", "TileMatrixSet");
  const matrixSet = blocks(xml, "TileMatrixSet").find(b => text(b, "Identifier") === matrixSetId);
  if (!matrixSet) throw new Error(`WMTS TileMatrixSet ${matrixSetId || "(missing)"} was not found.`);
  const crs = text(matrixSet, "SupportedCRS");
  if (!/EPSG::104905|Mars/i.test(crs)) throw new Error(`Unsupported planetary CRS: ${crs || "missing"}.`);

  const bbox = [...layer.matchAll(/<(?:[\w.-]+:)?BoundingBox\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?BoundingBox\s*>/gi)]
    .find(m => /EPSG::104905/i.test(m[1]));
  if (!bbox) throw new Error("WMTS layer has no Mars equirectangular coverage bounding box.");
  const min = numbers(text(bbox[2], "LowerCorner"), 2, "lower coverage corner");
  const max = numbers(text(bbox[2], "UpperCorner"), 2, "upper coverage corner");
  if (!(max[0] > min[0] && max[1] > min[1])) throw new Error("WMTS coverage bounds are invalid.");

  const styles = blocks(layer, "Style");
  const styleBlock = styles.find(s => /\bisDefault\s*=\s*["']true["']/i.test(s)) || styles[0];
  const style = text(styleBlock || "", "Identifier");
  const resource = [...layer.matchAll(/<(?:[\w.-]+:)?ResourceURL\b([^>]*)\/?\s*>/gi)]
    .map(m => m[1]).find(a => /resourceType\s*=\s*["']tile["']/i.test(a) && /image\//i.test(a));
  const template = resource?.match(/\btemplate\s*=\s*(["'])(.*?)\1/i)?.[2];
  if (!template || !style) throw new Error("WMTS layer does not provide a default tile style and REST resource template.");
  const tileMatrices = blocks(matrixSet, "TileMatrix").map(block => {
    const identifier = text(block, "Identifier"), corner = numbers(text(block, "TopLeftCorner"), 2, "matrix origin");
    const tileWidth = Number(text(block, "TileWidth")), tileHeight = Number(text(block, "TileHeight"));
    const matrixWidth = Number(text(block, "MatrixWidth")), matrixHeight = Number(text(block, "MatrixHeight"));
    if (!identifier || ![tileWidth, tileHeight, matrixWidth, matrixHeight].every(Number.isFinite) || tileWidth < 1 || tileHeight < 1 || matrixWidth < 1 || matrixHeight < 1)
      throw new Error("WMTS TileMatrix has invalid dimensions.");
    return { identifier, topLeft: corner, tileWidth, tileHeight, matrixWidth, matrixHeight };
  });
  if (!tileMatrices.length) throw new Error("WMTS TileMatrixSet contains no matrices.");
  return { layerId, format, style, matrixSetId, crs, bounds: [min[0], min[1], max[0], max[1]],
    worldBounds: [-180, -90, 180, 90], template: clean(template), tileMatrices };
}

export function wmtsTileAt(capabilities, matrixIndex, longitude, latitude) {
  const matrix = capabilities.tileMatrices[matrixIndex];
  if (!matrix || !Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  // Trek's Mars matrix set tiles the whole equirectangular world. A regional
  // layer BoundingBox describes data coverage, not the matrix tile extent.
  const [worldWest, worldSouth, worldEast, worldNorth] = capabilities.worldBounds || [-180, -90, 180, 90];
  const lon = ((longitude - worldWest) % 360 + 360) % 360 + worldWest;
  const lat = Math.max(worldSouth, Math.min(worldNorth, latitude));
  const spanLon = (worldEast - worldWest) / matrix.matrixWidth;
  const spanLat = (worldNorth - worldSouth) / matrix.matrixHeight;
  const col = Math.max(0, Math.min(matrix.matrixWidth - 1, Math.floor((lon - matrix.topLeft[0]) / spanLon)));
  const row = Math.max(0, Math.min(matrix.matrixHeight - 1, Math.floor((matrix.topLeft[1] - lat) / spanLat)));
  return { row, col, west: matrix.topLeft[0] + col * spanLon, east: matrix.topLeft[0] + (col + 1) * spanLon,
    north: matrix.topLeft[1] - row * spanLat, south: matrix.topLeft[1] - (row + 1) * spanLat,
    matrix: matrix.identifier, matrixIndex };
}

export function wmtsContains(capabilities, longitude, latitude) {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return false;
  const [west, south, east, north] = capabilities.bounds;
  const lon = ((longitude - west) % 360 + 360) % 360 + west;
  return lon >= west && lon <= east && latitude >= south && latitude <= north;
}

export function wmtsTileUrl(capabilities, tile) {
  const values = { Style: capabilities.style, TileMatrixSet: capabilities.matrixSetId, TileMatrix: tile.matrix, TileRow: tile.row, TileCol: tile.col };
  return capabilities.template.replace(/\{(Style|TileMatrixSet|TileMatrix|TileRow|TileCol)\}/g, (_match, key) => encodeURIComponent(values[key]));
}
