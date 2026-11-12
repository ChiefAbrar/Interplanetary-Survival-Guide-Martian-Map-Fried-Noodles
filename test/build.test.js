import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const read = p => readFileSync(join(root, p), "utf8").replaceAll("\r\n", "\n");
const walk = d => readdirSync(join(root, d)).flatMap(f => statSync(join(root, d, f)).isDirectory() ? walk(join(d, f)).map(x => x) : [join(d, f)]);
const digest = b => createHash("sha256").update(b).digest("hex");
const manifestDefinition = JSON.parse(read("tools/dist_manifest.json"));
const temporaryRoot = mkdtempSync(join(tmpdir(), "mars-build-consistency-"));
const verificationDist = join(temporaryRoot, "dist");
execFileSync(process.env.PYTHON || "python", [join(root, "tools/build_dist.py"), "--dist-dir", verificationDist], { cwd: root, stdio: "pipe" });
const buildManifest = JSON.parse(readFileSync(join(verificationDist, manifestDefinition.generated_manifest), "utf8"));
test.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));

test("generated dist manifest names the three shared app routes and complete assets", () => {
  const layout = read("app/views/layouts/application.html.erb"), view = read("app/views/home/index.html.erb");
  const configuredTileBase = process.env.CTX_TILE_BASE_URL || "";
  const expected = layout.replace("<%= yield %>", view).replace(/(<meta name="ctx-tile-base-url" content=")[^"]*(">)/,
    `$1${configuredTileBase}$2`);
  for (const entry of manifestDefinition.entry_pages) assert.equal(readFileSync(join(verificationDist, entry), "utf8"), expected);
  const generated = new Map(buildManifest.files.map(record => [record.path, record]));
  assert.equal(generated.size, buildManifest.files.length, "generated manifest paths must be unique");
  for (const asset of manifestDefinition.public_assets) assert.ok(generated.has(asset), `missing generated asset record ${asset}`);
  for (const record of buildManifest.files) {
    const bytes = readFileSync(join(verificationDist, record.path));
    assert.equal(bytes.length, record.size_bytes, `size mismatch for dist/${record.path}`);
    assert.equal(digest(bytes), record.sha256, `hash mismatch for dist/${record.path}`);
  }
  for (const required of ["js/ctx-tile-format.js", "js/ctx-tile-manager.js", "js/ctx-terrain-sampler.js", "js/routing.js", "js/app.js", "js/dem-format.js", "js/terrain.js", "js/models.js", "js/wmts.js", "js/mars-globe.js", "js/mars-locations.js", "js/optical-wmts.js"])
    assert.ok(generated.has(required), `missing required module ${required}`);
  for (const asset of ["data/jezero-ctx-relief.png", "data/jezero-ctx-relief.json", "images/jezero-usgs-ctx-dem.jpg"])
    assert.ok(generated.has(asset), `missing registered Jezero relief asset ${asset}`);
  for (const preserved of manifestDefinition.preserved_dist_assets)
    assert.ok(!generated.has(preserved), `independent dist asset must remain outside generated manifest: ${preserved}`);
  for (const entry of manifestDefinition.entry_pages) {
    const html = readFileSync(join(verificationDist, entry), "utf8");
    assert.match(html, /<script type="module" src="\/js\/app\.js/);
    assert.match(html, /href="\/css\/app\.css/);
    assert.match(html, /data-page-link="mission-control"/);
  }
  for (const f of walk("public")) {
    const publicPath = relative("public", f).replaceAll("\\", "/");
    if (manifestDefinition.preserved_dist_assets.includes(publicPath)) {
      assert.ok(!generated.has(publicPath), `preserved public asset must remain outside generated manifest: ${publicPath}`);
      assert.equal(readFileSync(join(verificationDist, publicPath)).equals(readFileSync(join(root, f))), true, `preserved initial copy of ${f} differs`);
    } else {
      assert.ok(generated.has(publicPath), `public asset missing from generated manifest: ${publicPath}`);
      assert.equal(readFileSync(join(verificationDist, publicPath)).equals(readFileSync(join(root, f))), true, `dist copy of ${f} differs`);
    }
  }
});
test("repeated staged builds preserve unmanifested dist assets and are deterministic", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "mars-dist-test-"));
  const dist = join(temporaryRoot, "dist"), sentinel = join(dist, "independent", "keep-me.txt");
  const preserved = join(dist, ...manifestDefinition.preserved_dist_assets[0].split("/"));
  try {
    mkdirSync(join(dist, "independent"), { recursive: true });
    writeFileSync(sentinel, "user maintained asset\n");
    mkdirSync(join(preserved, ".."), { recursive: true });
    writeFileSync(preserved, "preserved backup asset\n");
    const builder = join(root, "tools/build_dist.py");
    const python = process.env.PYTHON || "python";
    const env = { ...process.env, CTX_TILE_BASE_URL: "https://tiles.example.test/ctx/releases/example/" };
    execFileSync(python, [builder, "--dist-dir", dist], { cwd: root, env, stdio: "pipe" });
    const first = readFileSync(join(dist, ".generated-manifest.json"));
    execFileSync(python, [builder, "--dist-dir", dist], { cwd: root, env, stdio: "pipe" });
    assert.deepEqual(readFileSync(join(dist, ".generated-manifest.json")), first);
    assert.equal(readFileSync(sentinel, "utf8"), "user maintained asset\n");
    assert.equal(readFileSync(preserved, "utf8"), "preserved backup asset\n");
    for (const record of JSON.parse(first.toString("utf8")).files) {
      const bytes = readFileSync(join(dist, record.path));
      assert.equal(bytes.length, record.size_bytes);
      assert.equal(digest(bytes), record.sha256);
    }
    for (const entry of manifestDefinition.entry_pages)
      assert.match(readFileSync(join(dist, entry), "utf8"), /content="https:\/\/tiles\.example\.test\/ctx\/releases\/example\/"/);
    const before = readFileSync(join(dist, "index.html"));
    const invalid = spawnSync(python, [builder, "--dist-dir", dist, "--tile-base-url", "http://insecure.example"], { cwd: root, env, encoding: "utf8" });
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /HTTPS/);
    assert.deepEqual(readFileSync(join(dist, "index.html")), before, "invalid configuration must fail before changing dist");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("promotion failure rolls back the complete previous generated manifest", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "mars-dist-rollback-"));
  const dist = join(temporaryRoot, "dist"), builder = join(root, "tools/build_dist.py");
  const python = process.env.PYTHON || "python";
  const runner = String.raw`
import pathlib, sys
sys.path.insert(0, sys.argv[1])
import build_dist
dist = pathlib.Path(sys.argv[2])
calls = 0
real_replace = build_dist.os.replace
def injected_replace(source, target):
    global calls
    calls += 1
    if calls == 5:
        raise OSError("injected promotion failure")
    return real_replace(source, target)
try:
    build_dist.build(dist, replace_file=injected_replace)
except OSError as error:
    if str(error) != "injected promotion failure":
        raise
else:
    raise AssertionError("promotion failure was not injected")
`;
  try {
    mkdirSync(join(dist, "js"), { recursive: true });
    writeFileSync(join(dist, "index.html"), "old page\n");
    writeFileSync(join(dist, "js", "app.js"), "old app\n");
    writeFileSync(join(dist, ".generated-manifest.json"), "old manifest\n");
    writeFileSync(join(dist, "unrelated.txt"), "keep me\n");
    const previous = ["index.html", "js/app.js", ".generated-manifest.json", "unrelated.txt"]
      .map(path => [path, readFileSync(join(dist, path))]);
    const result = spawnSync(python, ["-c", runner, join(root, "tools"), dist], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    for (const [path, bytes] of previous)
      assert.deepEqual(readFileSync(join(dist, path)), bytes, `${path} must be restored after failed promotion`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Vercel serves generated dist and synchronizes tile-host CSP with its build environment", async () => {
  const previous = process.env.CTX_TILE_BASE_URL;
  try {
    process.env.CTX_TILE_BASE_URL = "https://tiles.example.test/ctx/releases/v1/";
    const { config } = await import(`../vercel.mjs?test=${Date.now()}`);
    assert.equal(config.outputDirectory, "dist");
    assert.equal(config.buildCommand, "npm run build");
    const csp = config.headers[0].headers.find(h => h.key === "Content-Security-Policy").value;
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /connect-src 'self' https:\/\/trek\.nasa\.gov https:\/\/astro\.arcgis\.com https:\/\/tiles\.example\.test/);
    assert.match(csp, /img-src 'self' data: blob: https:\/\/trek\.nasa\.gov https:\/\/astro\.arcgis\.com/);
    assert.doesNotMatch(csp, /script-src[^;]*https?:/);
  } finally {
    if (previous === undefined) delete process.env.CTX_TILE_BASE_URL;
    else process.env.CTX_TILE_BASE_URL = previous;
  }
});

test("external app requests are limited to NASA WMTS, ArcGIS tiles and the configured CTX data host", () => {
  const code = walk("public/js").filter(f => f.endsWith(".js")).map(read).join("\n");
  assert.match(code, /https:\/\/trek\.nasa\.gov\/tiles\/Mars\/EQ\/\$\{LAYER\}\/1\.0\.0\/WMTSCapabilities\.xml/);
  assert.match(code, /crossOrigin\s*=\s*["']anonymous["']/);
  assert.doesNotMatch(code, /<script[^>]+src\s*=\s*["']https?:/i);
  assert.match(read("public/js/app.js"), /ctx-tile-base-url/);
});

test("editorial pages distinguish imagery, terrain, models and assumptions", () => {
  const page = read("app/views/home/index.html.erb"), dataSources = read("DATA_SOURCES.md");
  assert.match(page, /NASA Viking VIS · not elevation/);
  assert.doesNotMatch(page, /MISSION READINESS|Operational readiness|<span class="badge badge-ok">NOMINAL/i);
  assert.match(dataSources, /global Viking VIS image layer is distinct from numerical elevation products/i);
  assert.match(dataSources, /not currently loaded.*InSight observations/i);
  assert.match(read("public/js/app.js"), /Configured criteria met/);
  assert.match(read("public/js/app.js"), /NASA Viking VIS · imagery/);
});

test("Rails visitor routes retain Mission Control, Explorer, Field Lab and data-panel access", () => {
  const routes = read("config/routes.rb"), controller = read("app/controllers/home_controller.rb");
  assert.match(routes, /root "home#index"/);
  assert.match(routes, /regions\/jezero.*home#jezero/);
  assert.match(routes, /get "explore" => "home#explore"/);
  assert.doesNotMatch(routes, /get "data"/);
  assert.match(controller, /def explore/);
  assert.match(read("app/views/layouts/application.html.erb"), /ctx-tile-base-url/);
});

test("Rails static export task and Dockerfile reference files that exist", () => {
  assert.ok(existsSync(join(root, "lib/tasks/static.rake")));
  const d = read("Dockerfile"); assert.match(d, /COPY Gemfile Gemfile\.lock/);
  assert.match(read("render.yaml"), /healthCheckPath: \/up/);
  assert.match(read("config/routes.rb"), /get "up"/);
});

test("licence and required documentation files are present", () => {
  for (const f of ["LICENSE", "README.md", "DATA_SOURCES.md", "AI_USAGE.md", "CTX_TERRAIN_HOSTING.md"]) assert.ok(existsSync(join(root, f)), f);
});
