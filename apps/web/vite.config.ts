import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

import { cloudflare } from "@cloudflare/vite-plugin";

const DEFAULT_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

/** The origin a URL template is served from, with a wildcard for a `{s}` subdomain. */
function originOf(template: string): string | undefined {
  try {
    const url = new URL(template.replace("{s}", "subdomain"));
    return `${url.protocol}//${url.host.replace("subdomain", "*")}`;
  } catch {
    return undefined;
  }
}

/**
 * Writes the `_headers` file Workers static assets serve with every response.
 * The policy only allows what the app loads: its own scripts, the web fonts,
 * the configured map tiles and API, and images it creates itself (blob:).
 */
function securityHeaders(tileUrl: string, apiBaseUrl: string): Plugin {
  const sources = (...values: Array<string | undefined>) => values.filter(Boolean).join(" ");
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    `img-src ${sources("'self'", "blob:", "data:", originOf(tileUrl))}`,
    "media-src 'self' blob:",
    `connect-src ${sources("'self'", apiBaseUrl ? originOf(apiBaseUrl) : undefined)}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  const headers = [
    "/*",
    `  Content-Security-Policy: ${policy}`,
    "  X-Content-Type-Options: nosniff",
    "  X-Frame-Options: DENY",
    // Tile servers see the site's origin, never the path or query.
    "  Referrer-Policy: strict-origin-when-cross-origin",
    "  Permissions-Policy: geolocation=(self), camera=(), microphone=(), payment=()",
    "",
  ].join("\n");
  return {
    name: "remo-security-headers",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "client",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "_headers", source: headers });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "");
  // Empty means the API is served from the same origin through the Worker's
  // /api proxy, which is the production setup.
  const apiBaseUrl = env.VITE_API_BASE_URL ?? "";
  if (mode === "production" && apiBaseUrl !== "" && !apiBaseUrl.startsWith("https://")) {
    throw new Error("Production builds require an empty (same-origin) or https VITE_API_BASE_URL.");
  }
  const tileUrl = env.VITE_MAP_TILE_URL || DEFAULT_TILE_URL;
  if (mode === "production" && !env.VITE_MAP_TILE_URL) {
    console.warn("\n[remo] VITE_MAP_TILE_URL is not set: the map uses OpenStreetMap's own tile servers, which are for light use only. Set a tile provider (and VITE_MAP_TILE_ATTRIBUTION) for production.\n");
  }
  return { plugins: [react(), cloudflare(), securityHeaders(tileUrl, apiBaseUrl)] };
});
