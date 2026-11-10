import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { InlineConfig } from "vitest/node";

// The Core listens on 127.0.0.1:7878 by default (`[modules.api] bind`).
const core = process.env.MIYORIA_CORE_URL ?? "http://127.0.0.1:7878";

// Vitest resolves its own copy of vite (7) while the panel builds with vite 6, so their
// `UserConfig` types do not line up: `defineConfig` from either one rejects the other's fields.
// The test block is typed by Vitest and added next to the vite config instead of inside it.
const test: InlineConfig = {
  environment: "jsdom",
  globals: true,
  setupFiles: ["./src/test/setup.ts"],
  css: false,
  restoreMocks: true,
};

const config = defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The card's drawing is shared with the Core (it renders the link preview); no build step in between.
      "@miyoria/card-face": fileURLToPath(new URL("../../packages/card-face/src/index.tsx", import.meta.url)),
    },
    dedupe: ["react", "react-dom"],
  },
  // Served by the Core at the root of its own origin. Absolute asset URLs: with clean addresses a
  // page opened directly at a nested path (/card/<serial>, a QR code on a phone) would look for
  // ./assets under /card/ and stay blank.
  base: "/",
  server: {
    port: 5178,
    proxy: {
      // Same-origin for the browser, so the Discord session cookie works in dev
      // too (register http://localhost:5178/api/auth/oauth/callback and open the panel at http://localhost:5178).
      "/api": { target: core, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
    // No manualChunks: splitting React from the libraries that import it produced circular chunks
    // (React's exports were read before its chunk had run, so the page stayed blank).
    chunkSizeWarningLimit: 1500,
  },
});

export default { ...config, test };
