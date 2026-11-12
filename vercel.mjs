const configuredTileBase = (process.env.CTX_TILE_BASE_URL || "").trim();
let tileOrigin = "";
if (configuredTileBase) {
  let parsed;
  try { parsed = new URL(configuredTileBase); }
  catch { throw new Error("CTX_TILE_BASE_URL must be an absolute HTTPS URL."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error("CTX_TILE_BASE_URL must use HTTPS and cannot include credentials, query parameters, or a fragment.");
  tileOrigin = parsed.origin;
}

const connectSources = ["'self'", "https://trek.nasa.gov", "https://astro.arcgis.com", ...(tileOrigin ? [tileOrigin] : [])];
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://trek.nasa.gov https://astro.arcgis.com",
  "font-src 'self'",
  `connect-src ${connectSources.join(" ")}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

// Vercel's JavaScript configuration reads the same deployment environment as
// the static build, keeping the page's tile base URL and CSP origin in sync.
export const config = {
  "$schema": "https://openapi.vercel.sh/vercel.json",
  framework: null,
  installCommand: null,
  buildCommand: "npm run build",
  outputDirectory: "dist",
  cleanUrls: true,
  headers: [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        { key: "Content-Security-Policy", value: contentSecurityPolicy }
      ]
    },
    {
      source: "/(css|js|data)/(.*)",
      headers: [
        { key: "Cache-Control", value: "public, max-age=3600, must-revalidate" }
      ]
    }
  ]
};

export default config;
