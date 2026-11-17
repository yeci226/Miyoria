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
    },
  },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", sourcemap: false },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
