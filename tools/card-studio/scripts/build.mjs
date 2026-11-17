// `vite build`, but only where Live2D's files were fetched (vendor.md). They are not in git, so a
// fresh checkout (CI, a machine that never renders cards) has nothing to build: say so and stop.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const needed = ["vendor/live2dcubismcore.min.js", "vendor/framework/src"];
const missing = needed.filter((p) => !existsSync(join(root, p)));
if (missing.length > 0) {
  console.log(
    `card-studio: skipped, Live2D files missing (${missing.join(", ")}); see vendor.md to fetch them`,
  );
  process.exit(0);
}
const vite = spawnSync("vite", ["build"], { cwd: root, stdio: "inherit", shell: true });
process.exit(vite.status ?? 1);
