// Shared Vitest settings for Node packages. Every package's `vitest.config.ts` uses `nodeProject()`.
//
// `@miyoria/source` is the export condition that maps a workspace package to its `src/index.ts`,
// so tests run against source without building dependencies first. Vite replaces its default
// conditions when `conditions` is set, so the defaults are listed again after ours.
//
// Every package's tests can also run the bus check: each event published on a bus is checked
// against its topic's payload schema (`vitest.bus-check.ts`; `MIYORIA_BUS_CHECK=report|strict`,
// off by default), and each run prints one summary of what did not fit.
import { fileURLToPath } from "node:url";
import { defineProject, mergeConfig, type ViteUserConfig } from "vitest/config";

export const SOURCE_CONDITION = "@miyoria/source";

const BUS_CHECK_SETUP = fileURLToPath(new URL("./vitest.bus-check.ts", import.meta.url));
const BUS_CHECK_GLOBAL = fileURLToPath(new URL("./vitest.bus-check.global.ts", import.meta.url));

const serverConditions = [SOURCE_CONDITION, "module", "node", "development|production"];

export function nodeProject(overrides: ViteUserConfig = {}): ViteUserConfig {
  return mergeConfig(
    defineProject({
      resolve: { conditions: serverConditions },
      ssr: { resolve: { conditions: serverConditions, externalConditions: [SOURCE_CONDITION] } },
      test: {
        include: ["test/**/*.test.ts", "src/**/*.test.ts"],
        environment: "node",
        restoreMocks: true,
        unstubEnvs: true,
        setupFiles: [BUS_CHECK_SETUP],
        globalSetup: [BUS_CHECK_GLOBAL],
      },
    }),
    overrides,
  );
}
