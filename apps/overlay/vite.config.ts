import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// `base: "./"` keeps the asset URLs relative, so the build works wherever it is mounted
// (the Stage serves it at /overlay/, `vite preview` at /, OBS can also open dist/index.html as a file).
export default defineConfig({
  base: "./",
  resolve: {
    alias: {
      // The feed contract, from source like the panel does. The page imports it as types only,
      // so nothing of it (and no zod) is in the bundle.
      "@miyoria/contracts/overlay": fileURLToPath(new URL("../../packages/contracts/overlay/src/index.ts", import.meta.url)),
      // The karaoke lyrics as a page shows them, shared with the member page (plain TS with no
      // imports outside its folder but the song reference's types, so no zod either).
      "@miyoria/play/karaoke/lyrics": fileURLToPath(
        new URL("../../packages/play/karaoke/src/lyrics/index.ts", import.meta.url),
      ),
      // The karaoke score, shared with the member page and Core the same way (plain TS, no
      // imports outside its folder): the lanes judge the notes with its frame credit.
      "@miyoria/play/karaoke/score": fileURLToPath(
        new URL("../../packages/play/karaoke/src/score/index.ts", import.meta.url),
      ),
    },
  },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", sourcemap: false },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
