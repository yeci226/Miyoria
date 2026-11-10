// First step from a fresh clone: `node scripts/setup.mjs` (or `pnpm bootstrap` once pnpm exists).
// Makes sure pnpm is available (through corepack), installs the node packages, then starts the
// guided `miyoria init`. Needs nothing but Node 24. `--dry-run` only prints what it would do;
// `--no-init` stops before the questions; other arguments go to `miyoria init`.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const noInit = args.includes("--no-init");
const initArgs = args.filter((a) => a !== "--dry-run" && a !== "--no-init");
const win = process.platform === "win32";

const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  console.error(
    `需要 Node.js 24 以上,目前是 ${process.versions.node}。從 https://nodejs.org 安裝(或 nvm / winget install OpenJS.NodeJS)`,
  );
  process.exit(1);
}

function run(cmd, cmdArgs) {
  console.log(`> ${cmd} ${cmdArgs.join(" ")}`);
  if (dry) return 0;
  // pnpm / corepack are .cmd shims on Windows
  return spawnSync(cmd, cmdArgs, { stdio: "inherit", shell: win }).status ?? 1;
}

function has(cmd) {
  return (spawnSync(cmd, ["--version"], { stdio: "ignore", shell: win }).status ?? 1) === 0;
}

const pm =
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).packageManager ??
  "pnpm@9.15.0";
if (!has("pnpm")) {
  console.log("找不到 pnpm:用 corepack 啟用");
  if (run("corepack", ["enable"]) !== 0 || run("corepack", ["prepare", pm, "--activate"]) !== 0) {
    console.error(
      `corepack 失敗。裝在 Program Files 的 Node 要系統管理員終端機;或改用 npm install -g ${pm}`,
    );
    process.exit(1);
  }
}
if (run("pnpm", ["install"]) !== 0) process.exit(1);
if (noInit) process.exit(0);
process.exit(run("pnpm", ["dev", "init", ...initArgs]));
