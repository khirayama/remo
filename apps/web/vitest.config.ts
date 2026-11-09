import { defineConfig } from "vitest/config";

// The tests exercise plain modules; they do not need the Cloudflare Worker
// environment that vite.config.ts sets up for the build.
// The timeline samples were recorded in Japan Standard Time and days are counted
// in local time, so pin the zone instead of inheriting the machine's (CI runs in
// UTC and would count stays near midnight on different days).
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], env: { TZ: "Asia/Tokyo" } },
});
