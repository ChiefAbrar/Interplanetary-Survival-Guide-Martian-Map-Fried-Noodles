require_relative "boot"

require "rails"
require "action_controller/railtie"
require "action_view/railtie"
require "uri"

Bundler.require(*Rails.groups)

module MarsSurvival
  class Application < Rails::Application
    config.load_defaults 7.1
    config.eager_load = false

    # No database, mailer, jobs or storage: this app only serves the mission-control dashboard.
    config.time_zone = "UTC"
    config.generators.system_tests = nil

    # Static assets (public/css, public/js) are served by Rails itself.
    config.public_file_server.enabled = true
    config.public_file_server.headers = { "Cache-Control" => "public, max-age=3600" }

    # Security headers. The page needs: its own JS/CSS, the optional GeoTIFF
    # library from jsDelivr, the optional NASA HiRISE DTM download, and NASA Mars Trek WMTS tiles.
    ctx_tile_base_url = ENV.fetch("CTX_TILE_BASE_URL", "").strip
    ctx_tile_origin = if ctx_tile_base_url.empty?
      nil
    else
      uri = URI.parse(ctx_tile_base_url)
      unless uri.is_a?(URI::HTTPS) && uri.host && !uri.userinfo && !uri.query && !uri.fragment
        raise ArgumentError, "CTX_TILE_BASE_URL must be an absolute HTTPS URL without credentials, query, or fragment."
      end
      uri.port == 443 ? "https://#{uri.host}" : "https://#{uri.host}:#{uri.port}"
    end

    connect_sources = ["'self'", "https://trek.nasa.gov", "https://astro.arcgis.com", "https://www.uahirise.org"]
    connect_sources << ctx_tile_origin if ctx_tile_origin

    csp = [
      "default-src 'self'",
      "script-src 'self' https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://trek.nasa.gov https://astro.arcgis.com",
      "font-src 'self' data:",
      "connect-src #{connect_sources.join(' ')}",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join("; ")

    config.action_dispatch.default_headers = {
      "X-Frame-Options" => "DENY",
      "X-Content-Type-Options" => "nosniff",
      "Referrer-Policy" => "strict-origin-when-cross-origin",
      "Permissions-Policy" => "camera=(), microphone=(), geolocation=()",
      "Content-Security-Policy" => csp
    }
  end
end
