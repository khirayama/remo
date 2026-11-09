import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// "@remo/timeline-map" is the web app's timeline algorithm, which the MCP
// tools run; wrangler.jsonc has the same alias for the Worker build.
export default defineConfig({
  resolve: {
    alias: {
      "@remo/timeline-map": fileURLToPath(new URL("../web/src/timeline-map.ts", import.meta.url)),
    },
  },
});
