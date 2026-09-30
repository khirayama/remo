import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "");
  const apiBaseUrl = env.VITE_API_BASE_URL ?? "";
  if (mode === "production" && !apiBaseUrl.startsWith("https://")) {
    throw new Error("Production builds require an https VITE_API_BASE_URL.");
  }
  return { plugins: [react(), cloudflare()] };
});