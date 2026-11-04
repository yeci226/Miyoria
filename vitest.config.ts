// Root Vitest config: `pnpm test:watch` runs every Node project in one process.
// CI and `pnpm test` run each package's own `vitest run` (`pnpm -r test`) instead.
// The panel is not listed: it pins its own Vitest major and runs on its own.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*",
      "apps/overlay",
      "apps/voice-node",
      "extensions/minecraft/adapter",
      "extensions/osu",
      "extensions/threads",
    ],
  },
});
