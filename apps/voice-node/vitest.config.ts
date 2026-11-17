import { defineConfig } from "vitest/config";

// `@miyoria/source` maps a workspace package (here `@miyoria/contracts`) to its TypeScript source,
// so tests run without building it first; as in the repo's `vitest.shared.ts`. Vite replaces its
// default conditions when `conditions` is set, so the defaults are listed again after ours.
const conditions = ["@miyoria/source", "module", "node", "development|production"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ["@miyoria/source"] } },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
