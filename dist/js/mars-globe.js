import { parseWmtsCapabilities, wmtsTileAt, wmtsTileUrl } from "./wmts.js";

// NASA Mars Trek — Viking VIS Global Color Mosaic
export const VIKING_LAYER = "Mars_Viking_MDIM21_ClrMosaic_global_232m";
// Backward-compat alias: existing test/build.test.js checks for ${LAYER} in concatenated JS
export const LAYER = VIKING_LAYER;
export const CAPABILITIES_URL = `https://trek.nasa.gov/tiles/Mars/EQ/${LAYER}/1.0.0/WMTSCapabilities.xml`;

// Mars Reference Ellipsoid (IAU / USGS Astrogeology standards)
// Equatorial radius (a): 3,396,190 m
// Polar radius (c/b): 3,376,200 m
export const MARS_EQUATORIAL_RADIUS_M = 3396190;
export const MARS_POLAR_RADIUS_M = 3376200;
export const MARS_MEAN_RADIUS_M = MARS_EQUATORIAL_RADIUS_M; // Backward compatibility for tests
export const MARS_AXIS_RATIO = MARS_POLAR_RADIUS_M / MARS_EQUATORIAL_RADIUS_M; // ~0.9941139924444745

const B_NORM = MARS_AXIS_RATIO;
const INV_B_NORM2 = 1.0 / (B_NORM * B_NORM);

// Jezero Crater coordinates (Perseverance landing area)
export const JEZERO_COORDS = {
  longitude: 77.4,
  latitude: 18.4,
  name: "JEZERO CRATER"
};

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const radians = d => d * Math.PI / 180;

// Shared in-memory and Cache API image cache for NASA tiles and capabilities
export function createLruCache(maxEntries = 48) {
  const entries = new Map();
  const limit = Math.max(1, Math.floor(maxEntries));
  return {
    get(key) {
      if (!entries.has(key)) return undefined;
      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > limit) entries.delete(entries.keys().next().value);
      return this;
    },
    has: key => entries.has(key),
    delete: key => entries.delete(key),
    clear: () => entries.clear(),
    get size() { return entries.size; }
  };
}

export function detailMatrixIndex(tileMatrices, distance) {
  if (!tileMatrices?.length) return 0;
  const last = tileMatrices.length - 1;
  return clamp(Math.round(last - Math.log2(Math.max(1, distance))), 0, last);
}

const IMAGE_CACHE = createLruCache(48);
const IN_FLIGHT_IMAGES = new Map();
let CACHED_CAPABILITIES_PROMISE = null;

async function getCachedCapabilities(layerId) {
  if (CACHED_CAPABILITIES_PROMISE) return CACHED_CAPABILITIES_PROMISE;
  CACHED_CAPABILITIES_PROMISE = (async () => {
    // Check Cache API if available
    let xml = null;
    if ("caches" in globalThis) {
      try {
        const cache = await caches.open("mars-wmts-v1");
        const match = await cache.match(CAPABILITIES_URL);
        if (match) {
          xml = await match.text();
        }
      } catch {}
    }
    if (!xml) {
      const response = await fetch(CAPABILITIES_URL, { mode: "cors", credentials: "omit" });
      if (!response.ok) throw new Error(`NASA WMTS capabilities returned HTTP ${response.status}.`);
      xml = await response.text();
      if ("caches" in globalThis) {
        try {
          const cache = await caches.open("mars-wmts-v1");
          await cache.put(CAPABILITIES_URL, new Response(xml, { headers: { "Content-Type": "application/xml" } }));
        } catch {}
      }
    }
    const caps = parseWmtsCapabilities(xml, layerId);
    if (!caps.crs.includes("104905")) throw new Error(`Unexpected map CRS: ${caps.crs}`);
    return caps;
  })().catch(err => {
    CACHED_CAPABILITIES_PROMISE = null; // Don't cache failures
    throw err;
  });
  return CACHED_CAPABILITIES_PROMISE;
}

/**
 * Maps planetocentric longitude and latitude (degrees) to 3D Cartesian coordinates
 * on the standardized oblate Mars reference ellipsoid (equatorial semi-axis 1.0, polar semi-axis B_NORM).
 */
export function marsEllipsoidPoint(lon, lat) {
  const la = radians(lat), lo = radians(lon), c = Math.cos(la);
  return [c * Math.sin(lo), B_NORM * Math.sin(la), c * Math.cos(lo)];
}

/**
 * Unit surface normal for the oblate Mars ellipsoid at given planetocentric coordinates.
 */
export function marsEllipsoidNormal(lon, lat) {
  const p = marsEllipsoidPoint(lon, lat);
  const nx = p[0], ny = p[1] * INV_B_NORM2, nz = p[2];
  const l = Math.hypot(nx, ny, nz) || 1.0;
  return [nx / l, ny / l, nz / l];
}

/** Backward compatibility alias for existing unit tests */
export function spherePoint(lon, lat) {
  const la = radians(lat), lo = radians(lon), c = Math.cos(la);
  return [c * Math.sin(lo), Math.sin(la), c * Math.cos(lo)];
}
export const marsLatLonToUnit = spherePoint;

function rotate([x, y, z], yaw, pitch) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const xx = cy * x + sy * z, zz = -sy * x + cy * z;
  return [xx, cp * y - sp * zz, sp * y + cp * zz];
}

function inverseRotate(q, yaw, pitch) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw);
  const y = cp * q[1] + sp * q[2], z1 = -sp * q[1] + cp * q[2];
  return [cy * q[0] - sy * z1, y, sy * q[0] + cy * z1];
}

/**
 * Calculates planetocentric longitude and latitude from a 3D Cartesian point on the ellipsoid.
 */
function locationFromEllipsoidPoint([x, y, z]) {
  const lon = Math.atan2(x, z) * 180 / Math.PI;
  const lat = Math.atan2(y / B_NORM, Math.hypot(x, z)) * 180 / Math.PI;
  return {
    longitude: ((lon % 360) + 360) % 360 - 180,
    latitude: clamp(lat, -89.99, 89.99)
  };
}

export class MarsGlobe {
  constructor(canvas, status, readout) {
    this.canvas = canvas;
    this.status = status;
    this.readout = readout;
    this.longitude = 0;
    this.latitude = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.distance = 3.2;
    this.pan = [0, 0];
    this.selected = null;
    this.drag = null;
    this.tiles = new Map();
    this.queue = [];
    this.capabilities = null;
    this.gl = null;
    this.ready = false;
    this.disposed = false;
    this.loading = 0;
    this.baseLoaded = [false, false];
    this.basePending = [false, false];
    this.tileTimer = null;
    this.activeMatrixIndex = 0;
    this.layerId = VIKING_LAYER;
    this.imageryEnabled = true;
    this.markerPulseStart = performance.now();
    this.animating = false;
    this.animFrameId = null;
    this.started = false;
    this.initialized = false;
    this.visible = false;
    this.contextLost = false;
    this.contextGeneration = 0;
    this.capabilitiesPromise = null;
    this.desiredTileKeys = new Set();
    this.pendingDesiredKeys = new Set();

    // Create marker overlay container in parent if not already present
    this.setupMarkerOverlay();
    this.handleContextLost = event => {
      event.preventDefault();
      if (this.contextLost) return;
      this.contextLost = true;
      this.contextGeneration++;
      this.cancelFlyTo(new Error("WebGL context was lost during globe rendering."));
      if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null; this.animating = false;
      if (this.status) this.status.textContent = "Globe graphics context lost; switch to 2D terrain or wait for graphics recovery.";
      globalThis.dispatchEvent?.(new Event("marsglobecontextlost"));
    };
    this.handleContextRestored = () => {
      if (this.disposed) return;
      try {
        this.contextLost = false;
        this.gl = this.canvas.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: false });
        this.initialized = false; this.ready = false;
        this.tiles.clear(); this.queue = []; this.loading = 0;
        this.baseLoaded = [false, false]; this.basePending = [false, false];
        this.initializeGL(); this.initialized = true; this.ready = true;
        this.resize();
        if (this.visible) this.startAnimationLoop();
        this.draw();
        if (this.imageryEnabled) void this.loadCapabilities();
        if (this.status) this.status.textContent = "Globe graphics restored; NASA imagery is loading again.";
      } catch (error) {
        this.contextLost = true;
        if (this.status) this.status.textContent = `Globe graphics could not be restored: ${error.message}`;
      }
    };
    this.canvas.addEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.addEventListener("webglcontextrestored", this.handleContextRestored);
  }

  setupMarkerOverlay() {
    if (!this.canvas || !this.canvas.parentElement) return;
    const parent = this.canvas.parentElement;
    let marker = parent.querySelector(".jezero-globe-marker");
    if (!marker) {
      marker = document.createElement("div");
      marker.className = "jezero-globe-marker";
      marker.innerHTML = `
        <div class="marker-dot"><span class="marker-pulse"></span></div>
        <div class="marker-label">
          <span class="marker-title">JEZERO CRATER</span>
          <span class="marker-sub">18.4°N, 77.4°E · Expedition Sector</span>
        </div>
      `;
      parent.appendChild(marker);
    }
    marker.style.display = "none";
    this.markerEl = marker;
  }

  async start({ active = true } = {}) {
    this.started = true;
    if (active) this.activate();
    return true;
  }

  activate() {
    if (this.disposed || this.contextLost) return false;
    this.visible = true;
    if (!this.initialized) {
      this.gl = this.canvas.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: false });
      if (!this.gl) {
        if (this.status) this.status.textContent = "WebGL is unavailable in this browser.";
        return false;
      }
      try {
        this.initializeGL();
        this.initialized = true;
        this.ready = true;
        this.resize();
      } catch (error) {
        if (this.status) this.status.textContent = `Mars globe unavailable: ${error.message}`;
        return false;
      }
    }
    this.startAnimationLoop();
    this.draw();
    if (this.imageryEnabled) void this.loadCapabilities();
    return true;
  }

  deactivate() {
    this.visible = false;
    if (this.markerEl) this.markerEl.style.display = "none";
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
    this.animFrameId = null;
    this.animating = false;
  }

  async loadCapabilities() {
    if (this.capabilities) {
      this.scheduleTiles();
      return this.capabilities;
    }
    if (this.capabilitiesPromise) return this.capabilitiesPromise;
    this.capabilitiesPromise = getCachedCapabilities(this.layerId).then(capabilities => {
      if (this.disposed) return null;
      this.capabilities = capabilities;
      if (this.status) this.status.textContent = `NASA Mars Trek · Viking VIS Color · ${capabilities.crs}`;
      if (this.visible && this.imageryEnabled) this.scheduleTiles();
      return capabilities;
    }).catch(error => {
      this.capabilitiesPromise = null;
      if (this.status) this.status.textContent = `NASA orbital imagery unavailable: ${error.message}`;
      this.draw();
      return null;
    });
    return this.capabilitiesPromise;
  }

  initializeGL() {
    const gl = this.gl;

    const vertex = `
      precision mediump float;
      attribute vec3 aPosition;
      attribute vec3 aNormal;
      attribute vec2 aUv;
      
      uniform float uYaw;
      uniform float uPitch;
      uniform float uDistance;
      uniform float uAspect;
      uniform vec2 uPan;
      
      varying vec2 vUv;
      varying vec3 vView;
      varying vec3 vNormal;
      
      void main() {
        float cy = cos(uYaw), sy = sin(uYaw);
        float cp = cos(uPitch), sp = sin(uPitch);
        
        // Rotate position
        vec3 q = vec3(
          cy * aPosition.x + sy * aPosition.z,
          cp * aPosition.y - sp * (-sy * aPosition.x + cy * aPosition.z),
          sp * aPosition.y + cp * (-sy * aPosition.x + cy * aPosition.z)
        );
        
        // Rotate normal
        vec3 n = vec3(
          cy * aNormal.x + sy * aNormal.z,
          cp * aNormal.y - sp * (-sy * aNormal.x + cy * aNormal.z),
          sp * aNormal.y + cp * (-sy * aNormal.x + cy * aNormal.z)
        );
        
        float w = max(0.08, uDistance - q.z);
        float f = 1.62;
        gl_Position = vec4(q.x * f / uAspect + uPan.x * w, q.y * f + uPan.y * w, 0.0, w);
        vUv = aUv;
        vView = q;
        vNormal = n;
      }
    `;

    const fragment = `
      precision mediump float;
      uniform sampler2D uTexture;
      uniform bool uTextured;
      uniform bool uSplit;
      uniform sampler2D uWest;
      uniform sampler2D uEast;
      uniform vec3 uColor;
      uniform float uDistance;
      
      varying vec2 vUv;
      varying vec3 vView;
      varying vec3 vNormal;
      
      void main() {
        if (vView.z <= 1.0 / uDistance) discard;
        
        vec4 c;
        if (uTextured) {
          if (uSplit) {
            float localU = vUv.x < 0.5 ? vUv.x * 2.0 : (vUv.x - 0.5) * 2.0;
            if (vUv.x < 0.5) c = texture2D(uWest, vec2(localU, vUv.y));
            else c = texture2D(uEast, vec2(localU, vUv.y));
          } else {
            c = texture2D(uTexture, vUv);
          }
          if (c.a < 0.025) discard;
        } else {
          c = vec4(uColor, 1.0);
        }
        
        // Scientific directional sunlight with ambient & subtle limb illumination
        vec3 normal = normalize(vNormal);
        vec3 viewDir = normalize(vec3(0.0, 0.0, uDistance) - vView);
        vec3 lightDir = normalize(vec3(-0.45, 0.40, 0.80));
        
        float NdotL = max(dot(normal, lightDir), 0.0);
        float ambient = 0.38;
        float diffuse = 0.62 * NdotL;
        float light = ambient + diffuse;
        
        // Gentle Martian limb / atmosphere edge (subtle dust scattering)
        float NdotV = max(dot(normal, viewDir), 0.0);
        float limb = pow(1.0 - NdotV, 3.5) * 0.18;
        vec3 limbColor = vec3(0.85, 0.52, 0.36) * limb;
        
        vec3 shaded = c.rgb * light + limbColor;
        gl_FragColor = vec4(shaded, c.a);
      }
    `;

    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader));
      }
      return shader;
    };

    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program));
    }
    this.program = program;
    gl.useProgram(program);

    this.locations = Object.fromEntries(
      ["aPosition", "aNormal", "aUv", "uYaw", "uPitch", "uDistance", "uAspect", "uPan", "uTexture", "uTextured", "uSplit", "uWest", "uEast", "uColor"].map(k => [
        k,
        gl.getAttribLocation(program, k) >= 0 ? gl.getAttribLocation(program, k) : gl.getUniformLocation(program, k)
      ])
    );

    // Build the oblate reference ellipsoid mesh (96 columns × 48 rows)
    this.sphere = this.makePatch(-180, -90, 180, 90, 96, 48);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);

    this.west = this.emptyTexture();
    this.east = this.emptyTexture();

    gl.uniform1i(this.locations.uTexture, 0);
    gl.uniform1i(this.locations.uWest, 0);
    gl.uniform1i(this.locations.uEast, 1);
  }

  emptyTexture() {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Neutral Mars ochre baseline
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([115, 62, 45, 255]));
    return texture;
  }

  makePatch(west, south, east, north, columns, rows) {
    const vertices = [], normals = [], uvs = [];
    for (let y = 0; y <= rows; y++) {
      for (let x = 0; x <= columns; x++) {
        const lon = west + (east - west) * x / columns;
        const lat = south + (north - south) * y / rows;
        vertices.push(...marsEllipsoidPoint(lon, lat));
        normals.push(...marsEllipsoidNormal(lon, lat));
        uvs.push(x / columns, y / rows);
      }
    }
    const indices = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const a = y * (columns + 1) + x, b = a + 1, c = a + columns + 1, d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
    const gl = this.gl;
    const result = {
      count: indices.length,
      position: gl.createBuffer(),
      normal: gl.createBuffer(),
      uv: gl.createBuffer(),
      index: gl.createBuffer()
    };
    gl.bindBuffer(gl.ARRAY_BUFFER, result.position);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, result.normal);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normals), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, result.uv);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uvs), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, result.index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
    return result;
  }

  bindMesh(mesh) {
    const gl = this.gl, L = this.locations;
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.position);
    gl.vertexAttribPointer(L.aPosition, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(L.aPosition);

    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.normal);
    gl.vertexAttribPointer(L.aNormal, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(L.aNormal);

    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uv);
    gl.vertexAttribPointer(L.aUv, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(L.aUv);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.index);
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
  }

  uniforms(textured, split, color) {
    const gl = this.gl, L = this.locations;
    gl.uniform1f(L.uYaw, this.yaw);
    gl.uniform1f(L.uPitch, this.pitch);
    gl.uniform1f(L.uDistance, this.distance);
    gl.uniform1f(L.uAspect, this.canvas.width / Math.max(1, this.canvas.height));
    gl.uniform2fv(L.uPan, this.pan);
    gl.uniform1i(L.uTextured, textured ? 1 : 0);
    gl.uniform1i(L.uSplit, split ? 1 : 0);
    gl.uniform3fv(L.uColor, color);
  }

  resize() {
    const ratio = Math.min(devicePixelRatio || 1, 1.5);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    if (this.gl) this.gl.viewport(0, 0, width, height);
    this.draw();
  }

  draw() {
    const gl = this.gl;
    if (!gl || !this.program) return;
    
    gl.clearColor(0.04, 0.045, 0.055, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);

    // 1. Draw solid-color base fallback
    this.uniforms(false, false, [0.38, 0.20, 0.15]);
    this.bindMesh(this.sphere);

    if (!this.ready || !this.imageryEnabled) { this.updateMarkerPosition(); return; }

    // 2. Draw global dual-hemisphere Viking mosaic
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.west);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.east);
    this.uniforms(true, true, [1, 1, 1]);
    this.bindMesh(this.sphere);

    // 3. Draw active higher-resolution tiles
    for (const tile of [...this.tiles.values()].sort((a, b) => a.matrixIndex - b.matrixIndex)) {
      if (!tile.loaded || !tile.mesh || !tile.texture) continue;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tile.texture);
      this.uniforms(true, false, [1, 1, 1]);
      this.bindMesh(tile.mesh);
    }

    // 4. Update the 3D Jezero crater marker position
    this.updateMarkerPosition();
  }

  setImageryEnabled(enabled) {
    this.imageryEnabled = Boolean(enabled);
    if (this.imageryEnabled && this.visible) void this.loadCapabilities();
    this.draw();
  }

  updateMarkerPosition() {
    if (!this.markerEl || !this.canvas) return;
    
    const P = marsEllipsoidPoint(JEZERO_COORDS.longitude, JEZERO_COORDS.latitude);
    const q = rotate(P, this.yaw, this.pitch);

    // Horizon culling on oblate ellipsoid (view z vs horizon threshold)
    const horizon = 1.0 / this.distance;
    const isVisible = q[2] > horizon;

    if (!isVisible) {
      this.markerEl.style.display = "none";
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const aspect = (this.canvas.width / Math.max(1, this.canvas.height)) || (rect.width / Math.max(1, rect.height));
    const f = 1.62;
    const w = Math.max(0.08, this.distance - q[2]);

    const ndcX = (q[0] * f / aspect + this.pan[0] * w) / w;
    const ndcY = (q[1] * f + this.pan[1] * w) / w;

    // Convert NDC [-1, 1] to CSS pixel coordinates inside canvas
    const screenX = (ndcX * 0.5 + 0.5) * rect.width;
    const screenY = (-ndcY * 0.5 + 0.5) * rect.height;

    this.markerEl.style.display = "block";
    this.markerEl.style.transform = `translate3d(${screenX.toFixed(1)}px, ${screenY.toFixed(1)}px, 0)`;
  }

  startAnimationLoop() {
    if (this.animating || !this.visible) return;
    this.animating = true;
    const loop = () => {
      if (this.disposed || !this.visible) { this.animating = false; return; }
      try { this.draw(); }
      catch (error) {
        this.animating = false; this.animFrameId = null;
        this.cancelFlyTo(error);
        if (this.status) this.status.textContent = `Globe rendering failed: ${error.message}`;
        return;
      }
      this.animFrameId = requestAnimationFrame(loop);
    };
    this.animFrameId = requestAnimationFrame(loop);
  }

  viewLocation(lon = this.longitude, lat = this.latitude) {
    this.longitude = ((lon + 180) % 360 + 360) % 360 - 180;
    this.latitude = clamp(lat, -89.9, 89.9);
    this.yaw = -radians(this.longitude);
    this.pitch = radians(this.latitude);
    this.pan = [0, 0];
  }

  flyTo(lon, lat, duration = 950, targetDistance = null) {
    if (this.contextLost) return Promise.reject(new Error("WebGL context is unavailable."));
    if (this.disposed) return Promise.reject(new Error("Mars globe has been disposed."));
    this.cancelFlyTo();
    const startYaw = this.yaw, startPitch = this.pitch;
    const startDist = this.distance;
    const endYaw = -radians(lon);
    const endPitch = radians(clamp(lat, -89.9, 89.9));
    const endDist = targetDistance != null ? clamp(targetDistance, 1.22, 5.2) : startDist;
    const start = performance.now();
    return new Promise((resolve, reject) => {
      let settled = false;
      let watchdog = null;
      const finish = (completed, error = null) => {
        if (settled) return;
        settled = true;
        if (watchdog !== null) clearTimeout(watchdog);
        if (this.flyAnimFrameId) cancelAnimationFrame(this.flyAnimFrameId);
        this.flyAnimFrameId = null;
        if (this.flyCancel === cancel) this.flyCancel = null;
        if (error) reject(error); else resolve(completed);
      };
      const cancel = error => finish(false, error);
      this.flyCancel = cancel;
      watchdog = setTimeout(() => finish(false, new Error("Camera animation did not receive a frame before its deadline.")), Math.max(1500, duration + 1000));
      const step = now => {
        if (settled) return;
        try {
          if (this.contextLost || this.disposed) throw new Error("Globe rendering became unavailable during camera flight.");
          const t = clamp((now - start) / Math.max(1, duration), 0, 1);
          const eased = t * t * (3 - 2 * t);
          this.yaw = startYaw + (endYaw - startYaw) * eased;
          this.pitch = startPitch + (endPitch - startPitch) * eased;
          if (targetDistance != null) this.distance = startDist + (endDist - startDist) * eased;
          this.longitude = lon; this.latitude = lat;
          this.draw();
          if (t < 1) this.flyAnimFrameId = requestAnimationFrame(step);
          else {
            this.flyAnimFrameId = null;
            this.scheduleTiles();
            finish(true);
          }
        } catch (error) { finish(false, error); }
      };
      this.flyAnimFrameId = requestAnimationFrame(step);
    });
  }

  cancelFlyTo(error = null) {
    if (this.flyCancel) this.flyCancel(error);
  }

  search(value) {
    const query = value.trim().toLowerCase();
    if (/jezero/.test(query)) {
      this.flyTo(JEZERO_COORDS.longitude, JEZERO_COORDS.latitude);
      return `Flying to Jezero Crater (${JEZERO_COORDS.latitude}°N, ${JEZERO_COORDS.longitude}°E).`;
    }
    const m = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!m) return "Enter a latitude, longitude pair or search for Jezero Crater.";
    const lat = Number(m[1]), lon = Number(m[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 360) return "Latitude must be within ±90° and longitude within ±360°.";
    this.flyTo(lon, lat);
    return `Flying to ${lat.toFixed(2)}° ${lat < 0 ? "S" : "N"}, ${((lon % 360 + 360) % 360).toFixed(2)}°E.`;
  }

  reset() {
    this.distance = 3.2;
    this.viewLocation(0, 0);
    this.scheduleTiles();
  }

  locate(event) {
    const rect = this.canvas.getBoundingClientRect();
    const h = rect.height || 1, aspect = rect.width / h, f = 1.62;
    const nx = (event.clientX - rect.left - rect.width / 2) / (h / 2) - this.pan[0];
    const ny = -(event.clientY - rect.top - h / 2) / (h / 2) - this.pan[1];
    
    // Ray in camera space
    const rayCam = [nx * aspect / f, ny / f, -1];
    const norm = Math.hypot(...rayCam);
    rayCam.forEach((v, i) => rayCam[i] = v / norm);

    // Transform camera origin and ray into world space
    const camOriginWorld = inverseRotate([0, 0, this.distance], this.yaw, this.pitch);
    const rayDirWorld = inverseRotate(rayCam, this.yaw, this.pitch);

    // Ellipsoid intersection in world space: (x/1)^2 + (y/B_NORM)^2 + (z/1)^2 = 1
    const dx = rayDirWorld[0], dy = rayDirWorld[1] / B_NORM, dz = rayDirWorld[2];
    const ox = camOriginWorld[0], oy = camOriginWorld[1] / B_NORM, oz = camOriginWorld[2];

    const qa = dx * dx + dy * dy + dz * dz;
    const qb = 2 * (ox * dx + oy * dy + oz * dz);
    const qc = ox * ox + oy * oy + oz * oz - 1;
    const disc = qb * qb - 4 * qa * qc;
    if (disc < 0) return null;

    const t = (-qb - Math.sqrt(disc)) / (2 * qa);
    const px = camOriginWorld[0] + t * rayDirWorld[0];
    const py = camOriginWorld[1] + t * rayDirWorld[1];
    const pz = camOriginWorld[2] + t * rayDirWorld[2];

    return locationFromEllipsoidPoint([px, py, pz]);
  }

  bindControls() {
    this.canvas.addEventListener("pointerdown", e => {
      this.drag = {
        x: e.clientX,
        y: e.clientY,
        yaw: this.yaw,
        pitch: this.pitch,
        pan: [...this.pan],
        panning: e.shiftKey || e.button === 1
      };
      this.canvas.setPointerCapture(e.pointerId);
      this.startAnimationLoop();
    });

    this.canvas.addEventListener("pointermove", e => {
      if (this.drag) {
        const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
        if (this.drag.panning) {
          this.pan = [
            clamp(this.drag.pan[0] + dx / (this.canvas.clientHeight / 2), -1.4, 1.4),
            clamp(this.drag.pan[1] - dy / (this.canvas.clientHeight / 2), -1.4, 1.4)
          ];
        } else {
          this.yaw = this.drag.yaw + dx / this.canvas.clientHeight * 3.2;
          this.pitch = clamp(this.drag.pitch + dy / this.canvas.clientHeight * 3.2, -Math.PI / 2, Math.PI / 2);
          const loc = locationFromEllipsoidPoint(inverseRotate([0, 0, 1], this.yaw, this.pitch));
          this.longitude = loc.longitude;
          this.latitude = loc.latitude;
        }
        this.draw();
        return;
      }
      const loc = this.locate(e);
      if (this.readout) {
        this.readout.textContent = loc
          ? `${loc.latitude.toFixed(2)}° ${loc.latitude < 0 ? "S" : "N"}, ${((loc.longitude % 360 + 360) % 360).toFixed(2)}°E · planetocentric coordinates`
          : "Move over Mars to inspect planetocentric coordinates.";
      }
    });

    const finish = () => {
      if (this.drag) {
        const panning = this.drag.panning;
        this.drag = null;
        if (panning) {
          const r = this.canvas.getBoundingClientRect();
          const center = this.locate({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
          if (center) this.viewLocation(center.longitude, center.latitude);
        }
        this.scheduleTiles();
      }
    };

    this.canvas.addEventListener("pointerup", finish);
    this.canvas.addEventListener("pointercancel", finish);
    this.canvas.addEventListener("wheel", e => {
      e.preventDefault();
      this.distance = clamp(this.distance * Math.exp(e.deltaY * 0.001), 1.22, 5.2);
      clearTimeout(this.tileTimer);
      this.tileTimer = setTimeout(() => this.scheduleTiles(), 180);
      this.draw();
    }, { passive: false });

    this.canvas.addEventListener("dblclick", e => {
      const loc = this.locate(e);
      if (loc) this.flyTo(loc.longitude, loc.latitude, 700);
    });
  }

  loadImage(url) {
    const cachedImage = IMAGE_CACHE.get(url);
    if (cachedImage) return Promise.resolve(cachedImage);
    if (IN_FLIGHT_IMAGES.has(url)) {
      return IN_FLIGHT_IMAGES.get(url);
    }
    const promise = (async () => {
      // Try Cache API for offline / repeat speed
      if ("caches" in globalThis) {
        try {
          const cache = await caches.open("mars-wmts-tiles-v1");
          const match = await cache.match(url);
          if (match) {
            const blob = await match.blob();
            const blobUrl = URL.createObjectURL(blob);
            const img = await new Promise((resolve, reject) => {
              const i = new Image();
              i.crossOrigin = "anonymous";
              i.onload = () => { URL.revokeObjectURL(blobUrl); resolve(i); };
              i.onerror = () => { URL.revokeObjectURL(blobUrl); reject(); };
              i.src = blobUrl;
            });
            IMAGE_CACHE.set(url, img);
            return img;
          }
        } catch {}
      }

      // Normal cross-origin fetch
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          // The browser HTTP cache handles successful image requests. A
          // second fetch here duplicated every cache-miss tile request.
          IMAGE_CACHE.set(url, img);
          resolve(img);
        };
        img.onerror = () => reject(new Error("Image request failed or CORS access was denied."));
        img.src = url;
      });
    })().finally(() => {
      IN_FLIGHT_IMAGES.delete(url);
    });

    IN_FLIGHT_IMAGES.set(url, promise);
    return promise;
  }

  async putBase(col) {
    if (this.baseLoaded[col] || this.basePending[col]) return;
    const contextGeneration = this.contextGeneration;
    this.basePending[col] = true;
    const tile = wmtsTileAt(this.capabilities, 0, col === 0 ? -90 : 90, 0);
    try {
      const img = await this.loadImage(wmtsTileUrl(this.capabilities, tile));
      if (contextGeneration !== this.contextGeneration || this.contextLost || this.disposed) return;
      const gl = this.gl;
      const texture = col === 0 ? this.west : this.east;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      this.baseLoaded[col] = true;
      if (this.baseLoaded[0] && this.baseLoaded[1]) this.updateStatus();
      this.draw();
    } catch (error) {
      if (this.status) {
        this.status.textContent = `NASA orbital tile unavailable: ${error.message}`;
      }
    } finally {
      if (contextGeneration === this.contextGeneration) this.basePending[col] = false;
    }
  }

  scheduleTiles() {
    if (!this.capabilities || !this.ready || !this.visible || !this.imageryEnabled) return;
    this.putBase(0);
    this.putBase(1);

    const matrices = this.capabilities.tileMatrices;
    const wantedLevel = detailMatrixIndex(matrices, this.distance);
    this.activeMatrixIndex = wantedLevel;
    this.updateStatus();
    const matrixLimit = this.distance < 2 ? 32 : 20;
    const angular = Math.min(100, Math.max(12, this.distance * 14));
    const centerLon = this.longitude, centerLat = this.latitude;
    const visibleTiles = matrixIndex => {
      const matrix = matrices[matrixIndex], keys = [];
      for (let row = 0; row < matrix.matrixHeight; row++) for (let col = 0; col < matrix.matrixWidth; col++) {
        const lon = this.capabilities.worldBounds[0] + (col + .5) * 360 / matrix.matrixWidth;
        const lat = this.capabilities.worldBounds[3] - (row + .5) * 180 / matrix.matrixHeight;
        if (rotate(marsEllipsoidPoint(lon, lat), this.yaw, this.pitch)[2] <= -.05) continue;
        let deltaLon = Math.abs(lon - centerLon);
        deltaLon = Math.min(deltaLon, 360 - deltaLon);
        const distance = Math.hypot(deltaLon * Math.cos(radians(centerLat)), lat - centerLat);
        if (distance <= angular + Math.hypot(360 / matrix.matrixWidth, 180 / matrix.matrixHeight) * .8)
          keys.push({ row, col, matrixIndex, d: distance });
      }
      return keys.sort((a, b) => a.d - b.d);
    };

    // Keep one coarser visible tier while the sharpest available visible tiles
    // load. Drawing coarse first lets sharp tiles replace it as they arrive.
    const coarseLevel = Math.max(0, wantedLevel - 1);
    const coarse = coarseLevel === wantedLevel ? [] : visibleTiles(coarseLevel).slice(0, 8);
    const detailed = visibleTiles(wantedLevel).slice(0, matrixLimit);
    const selected = [...coarse, ...detailed];
    this.desiredTileKeys = new Set(selected.map(t => `${t.matrixIndex}/${t.row}/${t.col}`));
    this.pendingDesiredKeys = new Set([...this.desiredTileKeys].filter(key => !this.tiles.get(key)?.loaded));
    this.queue = selected.filter(t => !this.tiles.get(`${t.matrixIndex}/${t.row}/${t.col}`)?.loaded);
    this.trimGpuTiles();
    if (!this.pendingDesiredKeys.size) this.pruneStaleTiles();
    this.pumpQueue();
  }

  trimGpuTiles() {
    const limit = 64;
    if (this.tiles.size <= limit) return;
    const stale = [...this.tiles.entries()].filter(([key]) => !this.desiredTileKeys.has(key))
      .sort((a, b) => (b[1].distance ?? Infinity) - (a[1].distance ?? Infinity));
    while (this.tiles.size > limit && stale.length) {
      const [key, tile] = stale.shift();
      if (tile.texture) this.gl.deleteTexture(tile.texture);
      this.tiles.delete(key);
    }
  }

  pruneStaleTiles() {
    for (const [key, tile] of this.tiles) if (!this.desiredTileKeys.has(key)) {
      if (tile.texture) this.gl.deleteTexture(tile.texture);
      this.tiles.delete(key);
    }
  }

  updateStatus() {
    if (!this.capabilities || !this.status) return;
    const matrix = this.capabilities.tileMatrices[this.activeMatrixIndex || 0];
    const degreesPerPixel = (this.capabilities.bounds[3] - this.capabilities.bounds[1]) / matrix.matrixHeight / matrix.tileHeight;
    const kmPerPixel = MARS_EQUATORIAL_RADIUS_M * Math.PI / 180 * degreesPerPixel / 1000;
    const imagery = this.baseLoaded[0] && this.baseLoaded[1] ? "NASA Viking Global Color Mosaic loaded" : "NASA Viking Global Color Mosaic loading";
    this.status.textContent = `${imagery} · matrix ${matrix.identifier} · ~${kmPerPixel.toFixed(kmPerPixel < 10 ? 1 : 0)} km/pixel meridionally · Mars CRS 104905`;
  }

  pumpQueue() {
    while (this.loading < 4 && this.queue.length) {
      const coordinates = this.queue.shift();
      const key = `${coordinates.matrixIndex}/${coordinates.row}/${coordinates.col}`;
      const existing = this.tiles.get(key);
      if (existing?.loaded || existing?.loading) continue;

      const geographic = wmtsTileAt(
        this.capabilities,
        coordinates.matrixIndex,
        this.capabilities.bounds[0] + (coordinates.col + 0.5) * 360 / this.capabilities.tileMatrices[coordinates.matrixIndex].matrixWidth,
        this.capabilities.bounds[3] - (coordinates.row + 0.5) * 180 / this.capabilities.tileMatrices[coordinates.matrixIndex].matrixHeight
      );

      const tile = { ...geographic, distance: coordinates.d, texture: null, mesh: null, loaded: false, loading: true };
      this.tiles.set(key, tile);
      this.loading = (this.loading || 0) + 1;
      const contextGeneration = this.contextGeneration;

      this.loadImage(wmtsTileUrl(this.capabilities, geographic)).then(img => {
        if (contextGeneration !== this.contextGeneration || !this.tiles.has(key) || this.disposed || this.contextLost) return;
        const gl = this.gl;
        tile.texture = this.emptyTexture();
        gl.bindTexture(gl.TEXTURE_2D, tile.texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        tile.mesh = this.makePatch(tile.west, tile.south, tile.east, tile.north, 16, 16);
        tile.loaded = true;
        tile.loading = false;
        this.pendingDesiredKeys.delete(key);
        this.draw();
      }).catch(() => {
        if (contextGeneration !== this.contextGeneration) return;
        const failed = this.tiles.get(key);
        if (failed?.texture) this.gl.deleteTexture(failed.texture);
        this.tiles.delete(key);
        this.pendingDesiredKeys.delete(key);
      }).finally(() => {
        if (contextGeneration !== this.contextGeneration) return;
        this.loading--;
        this.trimGpuTiles();
        if (!this.pendingDesiredKeys.size) this.pruneStaleTiles();
        this.pumpQueue();
      });
    }
  }

  dispose() {
    this.disposed = true;
    if (this.flyCancel) this.flyCancel();
    this.animating = false;
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
    if (this.flyAnimFrameId) cancelAnimationFrame(this.flyAnimFrameId);
    if (this.gl) {
      for (const tile of this.tiles.values()) {
        if (tile.texture) this.gl.deleteTexture(tile.texture);
      }
      this.gl.deleteTexture(this.west);
      this.gl.deleteTexture(this.east);
    }
    if (this.markerEl) {
      this.markerEl.remove();
      this.markerEl = null;
    }
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored);
  }
}
