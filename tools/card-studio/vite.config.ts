import { defineConfig } from "vite";

// The page the headless browser opens. Cubism Core is not bundled: it is Live2D's own file, loaded
// by index.html from `vendor/` (fetched by `vendor.md`, never committed).
export default defineConfig({
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
