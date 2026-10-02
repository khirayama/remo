import { defineConfig } from "vitest/config";

// The tests exercise plain modules; they do not need the Cloudflare Worker
// environment that vite.config.ts sets up for the build.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
