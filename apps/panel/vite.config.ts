import { existsSync } from "node:fs";
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
  setupFiles: ["./vitest.setup.ts", "./src/test/setup.ts"],
  css: false,
  restoreMocks: true,
};

// The owner's pictures are game art kept out of git (`public/*.local.*`). The page refers to one
// only when it is there at build time; elsewhere it would ask for it on every load and get a 404.
const art = (name: string) => existsSync(fileURLToPath(new URL(`./public/${name}`, import.meta.url)));

const config = defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __PANEL_ART__: JSON.stringify({ background: art("background.local.jpg"), login: art("login.local.jpg") }),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The exchange's chart and map arithmetic (moving averages, the up/down colours, the heat map's
      // squarified layout with d3-hierarchy), shared with the pictures Discord gets so both agree.
      // Imported only by the lazily loaded chart and map, so it stays out of the main bundle.
      "@miyoria/card-face/market": fileURLToPath(new URL("../../packages/card-face/src/market.ts", import.meta.url)),
      // The card's drawing is shared with the Core (it renders the link preview); no build step in between.
      "@miyoria/card-face": fileURLToPath(new URL("../../packages/card-face/src/index.tsx", import.meta.url)),
      // What the card reads of the bond: the narrow entry with no imports, not all of the types.
      "@miyoria/types/bond": fileURLToPath(new URL("../../packages/types/src/bond.ts", import.meta.url)),
      // What an exchange order's amount says (shares, or $ coins): the same parser as Discord's, no imports.
      "@miyoria/types/exchange-amount": fileURLToPath(new URL("../../packages/types/src/exchange-amount.ts", import.meta.url)),
      // The tier names and the floors of the anchored tiers: the one list, a file with no imports.
      "@miyoria/contracts/wire/tiers": fileURLToPath(new URL("../../packages/contracts/wire/src/tiers.ts", import.meta.url)),
      // The route table: its types from source like the card, and at run time the table without
      // its schemas (`pnpm contracts:gen`), so zod stays out of the bundle.
      "@miyoria/contracts/api": fileURLToPath(new URL("../../packages/contracts/api/src/index.ts", import.meta.url)),
      // Karaoke: the score is shared with the Core (plain TS, no imports outside its folder); the
      // reference format is read for its types only (`import type`), so zod never loads here.
      "@miyoria/play/karaoke/score": fileURLToPath(
        new URL("../../packages/play/karaoke/src/score/index.ts", import.meta.url),
      ),
      // The lyrics as a page shows them, shared with the stream's karaoke scene the same way.
      "@miyoria/play/karaoke/lyrics": fileURLToPath(
        new URL("../../packages/play/karaoke/src/lyrics/index.ts", import.meta.url),
      ),
      // The reference editor's edits and the rules a save must hold, shared with the Core the same way.
      "@miyoria/play/karaoke/edit": fileURLToPath(
        new URL("../../packages/play/karaoke/src/edit/index.ts", import.meta.url),
      ),
      "@miyoria/contracts/workers/karaoke": fileURLToPath(
        new URL("../../packages/contracts/workers/src/karaoke.ts", import.meta.url),
      ),
      "@miyoria/contracts/schema/api.routes.json": fileURLToPath(
        new URL("../../packages/contracts/schema/api.routes.json", import.meta.url),
      ),
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
    // Core serves everything in `dist` to anyone, source maps included: they are written only
    // when asked for (`MIYORIA_PANEL_SOURCEMAP=1 pnpm build`), for debugging a build.
    sourcemap: process.env.MIYORIA_PANEL_SOURCEMAP === "1",
    target: "es2022",
    // No manualChunks: splitting React from the libraries that import it produced circular chunks
    // (React's exports were read before its chunk had run, so the page stayed blank).
    chunkSizeWarningLimit: 1500,
  },
});

export default { ...config, test };
