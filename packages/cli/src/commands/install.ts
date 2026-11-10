// `miyoria install [role | service ...]`: installs what this computer's services need and it lacks,
// after showing the list with sizes and asking once (`--yes` skips the question):
//   pnpm (through corepack), node packages and builds, a Python 3.11-3.13, each worker's venv with
//   its packages, ffmpeg, and the small model files that have a documented source.
// It only checks and explains: GPU drivers / CUDA, Docker, OBS, VTube Studio, Minecraft / Prism,
// and the model files that are yours (voice reference, RVC model).
// Idempotent: finished steps are skipped, and an existing venv, model file or setting is never
// overwritten. winget on Windows and Homebrew on macOS are run for you; on Linux the apt / dnf
// command is printed and nothing runs with sudo.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildTargets, checkTarget } from "../stack/builds.js";
import { pythonPath, repoRoot, type Stack, stackConfig, type Worker } from "../stack/config.js";
import { downloadFile, type Fetch, modelsFor } from "../stack/downloads.js";
import { autoDownloads, importsFor, manualItems } from "../stack/role-checks.js";
import { describeMachine, expandTargets, machineConfig } from "../stack/roles.js";
import { defaultRunner, type Runner } from "../stack/system.js";
import { bold, dim, fail, note, ok, println, section, warn } from "../ui.js";
import { loadConfig } from "./node.js";
import { installNeeded, buildTarget as runBuild, type UpdateDeps } from "./update.js";

export class InstallError extends Error {
  override readonly name = "InstallError";
}

export interface InstallOptions {
  targets: string[];
  dryRun?: boolean;
}

export interface InstallDeps {
  run: Runner;
  platform: NodeJS.Platform;
  /** The one question: install the listed things? */
  confirm: (message: string) => Promise<boolean>;
  fetchImpl?: Fetch;
}

export function defaultInstallDeps(confirm: InstallDeps["confirm"]): InstallDeps {
  return { run: defaultRunner, platform: process.platform, confirm };
}

const TORCH_INDEX = "https://download.pytorch.org/whl/cu128";
const LONG = 60 * 60_000;
/** Python versions the worker requirements and CUDA torch wheels are known to work with, best first. */
export const PYTHON_VERSIONS = ["3.12", "3.11", "3.13"] as const;

// ---- platform helpers --------------------------------------------------------------------

export interface Pkg {
  winget: string;
  brew: string;
  apt: string;
  dnf: string;
}

export const PKG = {
  python: {
    winget: "Python.Python.3.12",
    brew: "python@3.12",
    apt: "python3.12 python3.12-venv",
    dnf: "python3.12",
  },
  ffmpeg: { winget: "Gyan.FFmpeg", brew: "ffmpeg", apt: "ffmpeg", dnf: "ffmpeg" },
} as const satisfies Record<string, Pkg>;

/** The command that installs a package here, or `null` on Linux (printed, never run). */
export function installCommand(pkg: Pkg, platform: NodeJS.Platform): [string, string[]] | null {
  if (platform === "win32") {
    return [
      "winget",
      [
        "install",
        "-e",
        "--id",
        pkg.winget,
        "--accept-package-agreements",
        "--accept-source-agreements",
      ],
    ];
  }
  if (platform === "darwin") return ["brew", ["install", pkg.brew]];
  return null;
}

export function linuxHint(pkg: Pkg): string {
  return `sudo apt install ${pkg.apt}    (Fedora:sudo dnf install ${pkg.dnf})`;
}

/** An interpreter in 3.11-3.13, as `[command, ...args]`. */
async function findPython(deps: InstallDeps): Promise<string[] | null> {
  const candidates: string[][] = [
    ...PYTHON_VERSIONS.map((v) => (deps.platform === "win32" ? ["py", `-${v}`] : [`python${v}`])),
    ["python3"],
    ["python"],
  ];
  for (const c of candidates) {
    const [cmd, ...pre] = c as [string, ...string[]];
    const r = await deps.run(cmd, [...pre, "--version"], { timeoutMs: 15_000 });
    const m = /Python (\d+)\.(\d+)/.exec(`${r.stdout}${r.stderr}`);
    if (r.missing || r.code !== 0 || !m) continue;
    if (m[1] === "3" && (PYTHON_VERSIONS as readonly string[]).includes(`3.${m[2]}`)) return c;
  }
  return null;
}

/** One pip step: the arguments after `python -m pip install`. */
export interface PipStep {
  label: string;
  args: string[];
  size: string;
  /** Modules whose import says this step is already done. */
  done: string[];
}

/** What to pip install into a worker's venv (CUDA torch first, then the requirements). */
export function pipSteps(w: Worker): PipStep[] {
  const torch = (pins: string[]): PipStep => ({
    label: "CUDA 版 PyTorch",
    args: [...pins, "--index-url", TORCH_INDEX],
    size: "約 3 GB",
    done: ["torch"],
  });
  const reqs = (file: string, size: string): PipStep => ({
    label: file,
    args: ["-r", `${w.name}/${file}`],
    size,
    done: importsFor(w).filter((m) => m !== "torch"),
  });
  switch (w.name) {
    case "asr":
      return (w.env.ASR_BACKEND ?? "").toLowerCase() === "qwen3"
        ? [torch(["torch"]), reqs("requirements-qwen3.txt", "約數百 MB")]
        : [reqs("requirements-sensevoice.txt", "約數十 MB")];
    case "tts":
      return (w.env.TTS_BACKEND ?? "").toLowerCase() === "qwen-tts"
        ? [torch(["torch"]), reqs("requirements.txt", "約數百 MB")]
        : [torch(["torch"]), reqs("requirements-faster.txt", "約數百 MB")];
    case "sing":
      return [
        torch(["torch==2.11.0", "torchaudio==2.11.0"]),
        reqs("requirements.txt", "約 1 GB 以上"),
      ];
    case "turn":
      return [reqs("requirements.txt", "約數十 MB")];
    default:
      return [];
  }
}

/** Build targets a computer needs for its services. */
export function wantedTargets(stack: Stack): Set<string> {
  const ids = new Set<string>();
  if (stack.core) ids.add("sdk").add("panel").add("ext:*");
  if (stack.stage) ids.add("overlay");
  return ids;
}

function wanted(id: string, ids: Set<string>): boolean {
  return ids.has(id) || (id.startsWith("ext:") && ids.has("ext:*"));
}

function pnpmVersion(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      packageManager?: string;
    };
    return /^pnpm@([\d.]+)/.exec(pkg.packageManager ?? "")?.[1] ?? "9.15.0";
  } catch {
    return "9.15.0";
  }
}

// ---- the plan ----------------------------------------------------------------------------

interface Step {
  id: string;
  label: string;
  size?: string;
  /** Steps that must have worked first. */
  needs?: string[];
  run: () => Promise<boolean>;
}

export async function run(
  configPath: string,
  options: InstallOptions,
  deps: InstallDeps,
): Promise<void> {
  const root = repoRoot(configPath);
  if (!root) {
    throw new InstallError(
      "`install` 要在 Miyoria 的原始碼資料夾裡用(找不到 workers/ 和 pnpm-workspace.yaml)",
    );
  }
  const config = await loadConfig(configPath);
  const configDir = dirname(resolve(configPath));
  const machine = machineConfig(config);
  let services: string[];
  try {
    services =
      options.targets.length > 0 ? expandTargets(options.targets) : (machine?.services ?? []);
  } catch (error) {
    throw new InstallError((error as Error).message);
  }
  if (services.length === 0) {
    throw new InstallError(
      "這台電腦還沒選要跑什麼:執行 `miyoria init` 選角色,或 `miyoria install core`(角色:broadcast、core、inference、all)",
    );
  }
  const stack = stackConfig(config, services);
  if (machine && options.targets.length === 0) note(`這台電腦的角色:${describeMachine(machine)}`);

  const steps: Step[] = [];
  const explain: Array<[boolean, string, string]> = [];
  const linux: string[] = [];
  const updateDeps: UpdateDeps = {
    run: deps.run,
    confirm: deps.confirm,
    env: process.env,
    platform: deps.platform,
    now: () => new Date(),
  };

  // ---- pnpm and node packages ---------------------------------------------------------
  const needsNode = stack.core || stack.voiceNode || stack.stage;
  if (needsNode) {
    const version = pnpmVersion(root);
    const pnpm = await deps.run("pnpm", ["--version"], { timeoutMs: 15_000 });
    if (pnpm.missing || pnpm.code !== 0) {
      steps.push({
        id: "pnpm",
        label: `啟用 pnpm ${version}(corepack enable、corepack prepare)`,
        size: "約 20 MB",
        run: async () => {
          const a = await deps.run("corepack", ["enable"], { timeoutMs: 120_000, inherit: true });
          const b = await deps.run("corepack", ["prepare", `pnpm@${version}`, "--activate"], {
            timeoutMs: 300_000,
            inherit: true,
          });
          if (a.code === 0 && b.code === 0) return true;
          fail("corepack 失敗(裝在 Program Files 的 Node 要系統管理員才能 enable)");
          println(
            dim(
              `    修正:用系統管理員終端機執行 corepack enable,或 npm install -g pnpm@${version}`,
            ),
          );
          return false;
        },
      });
    }
    if (installNeeded(root)) {
      steps.push({
        id: "node",
        label: "node 套件(pnpm install)",
        size: "約 1 GB(node_modules)",
        needs: ["pnpm"],
        run: async () =>
          (await deps.run("pnpm", ["install"], { cwd: root, timeoutMs: LONG, inherit: true }))
            .code === 0,
      });
    }
    const ids = wantedTargets(stack);
    for (const t of buildTargets(root, configDir, config)) {
      if (!wanted(t.id, ids)) continue;
      const f = checkTarget(t);
      if (f.state === "fresh" || (f.state === "missing" && t.configured === false)) continue;
      steps.push({
        id: `build:${t.id}`,
        label: `建置 ${t.label}`,
        size: "數分鐘",
        needs: ["node"],
        run: () => runBuild(t, updateDeps),
      });
    }
  }

  // ---- python workers -----------------------------------------------------------------
  const venvOf = (w: Worker) => pythonPath(join(root, w.venv), deps.platform);
  let python: string[] | null = null;
  if (stack.workers.some((w) => !existsSync(venvOf(w)))) {
    python = await findPython(deps);
    if (!python) {
      const cmd = installCommand(PKG.python, deps.platform);
      if (cmd) {
        steps.push({
          id: "python",
          label: `安裝 Python 3.12(${cmd[0]})`,
          size: "約 30 MB",
          run: async () => {
            const r = await deps.run(cmd[0], cmd[1], { timeoutMs: LONG, inherit: true });
            if (r.code === 0) {
              warn(
                "Python 裝好了,但這個終端機還找不到它:關掉重開終端機,再執行一次 `miyoria install`",
              );
            }
            return false;
          },
        });
      } else linux.push(`Python 3.11–3.13:${linuxHint(PKG.python)}`);
    }
  }
  for (const w of stack.workers) {
    const venv = join(root, w.venv);
    const py = venvOf(w);
    const label = `worker ${w.name}`;
    const id = `venv:${w.name}`;
    const exists = existsSync(py);
    if (!exists) {
      if (!python) continue; // waiting for Python
      const [cmd, ...pre] = python as [string, ...string[]];
      steps.push({
        id,
        label: `${label}:建立 ${w.venv}`,
        size: "約 10 MB",
        needs: ["python"],
        run: async () =>
          (
            await deps.run(cmd, [...pre, "-m", "venv", venv], {
              cwd: join(root, "workers"),
              timeoutMs: 300_000,
            })
          ).code === 0,
      });
    }
    for (const step of pipSteps(w)) {
      if (exists) {
        const r = await deps.run(py, ["-c", step.done.map((m) => `import ${m}`).join(";")], {
          timeoutMs: 120_000,
        });
        if (r.code === 0) continue;
      }
      steps.push({
        id: `pip:${w.name}:${step.label}`,
        label: `${label}:pip install ${step.label}`,
        size: step.size,
        needs: exists ? [] : [id],
        run: async () =>
          (
            await deps.run(py, ["-m", "pip", "install", ...step.args], {
              cwd: join(root, "workers"),
              timeoutMs: LONG,
              inherit: true,
            })
          ).code === 0,
      });
    }
  }

  // ---- ffmpeg -------------------------------------------------------------------------
  if (stack.workers.some((w) => w.name === "sing") || stack.voiceNode) {
    const ff = await deps.run("ffmpeg", ["-version"], { timeoutMs: 10_000 });
    if (ff.missing || ff.code !== 0) {
      const cmd = installCommand(PKG.ffmpeg, deps.platform);
      if (cmd) {
        steps.push({
          id: "ffmpeg",
          label: `安裝 ffmpeg(${cmd[0]})`,
          size: "約 100 MB",
          run: async () => {
            const r = await deps.run(cmd[0], cmd[1], { timeoutMs: LONG, inherit: true });
            if (r.code === 0) warn("ffmpeg 裝好了;之後還說找不到的話,關掉重開終端機讓 PATH 更新");
            return r.code === 0;
          },
        });
      } else linux.push(`ffmpeg:${linuxHint(PKG.ffmpeg)}`);
    }
  }

  // ---- model files with a documented source -------------------------------------------
  for (const m of modelsFor(services)) {
    if (existsSync(join(root, m.dest))) continue;
    steps.push({
      id: `model:${m.id}`,
      label: `下載 ${m.what} → ${m.dest}(${m.license})`,
      size: m.size,
      run: async () => {
        try {
          await downloadFile(m.url, join(root, m.dest), deps.fetchImpl);
          return true;
        } catch (error) {
          fail(`${m.what}:${(error as Error).message}`);
          return false;
        }
      },
    });
  }

  // ---- only checked and explained -----------------------------------------------------
  if (stack.workers.some((w) => ["asr", "tts", "sing"].includes(w.name))) {
    const smi = await deps.run("nvidia-smi", ["-L"], { timeoutMs: 15_000 });
    explain.push([
      !smi.missing && smi.code === 0,
      "NVIDIA 顯卡驅動 / CUDA",
      "asr、tts、sing 要 NVIDIA 顯卡和驅動(nvidia-smi 能執行);驅動要自己從 NVIDIA 安裝,這裡不裝",
    ]);
  }
  const modules = config.section("modules");
  const sandbox =
    typeof modules === "object" && modules !== null && !Array.isArray(modules)
      ? (modules as Record<string, unknown>).sandbox
      : undefined;
  if (stack.core && typeof sandbox === "object" && sandbox !== null) {
    const d = await deps.run("docker", ["--version"], { timeoutMs: 10_000 });
    explain.push([
      !d.missing && d.code === 0,
      "Docker Desktop",
      "檔案 / 程式沙箱要用;要自己安裝(需要系統管理員和授權同意)",
    ]);
  }
  if (stack.stage) {
    explain.push([
      false,
      "OBS、VTube Studio",
      "直播機要自己安裝並開啟(OBS WebSocket、VTube Studio API);這裡不裝",
    ]);
  }

  // ---- show, ask once, do -------------------------------------------------------------
  const dry = options.dryRun === true;
  section(`${dry ? "安裝計畫(dry-run,不會改任何東西)" : "安裝計畫"}:${services.join("、")}`);
  if (steps.length === 0) ok("需要安裝的都已經有了");
  for (const [i, s] of steps.entries())
    println(`${i + 1}. ${s.label}  ${s.size ? dim(`(${s.size})`) : ""}`);
  if (steps.length > 0) {
    println(dim("大小是估計值,沒有實測;下載只來自 README 列的來源;已存在的檔案和 venv 不會被覆蓋"));
  }
  for (const l of linux) warn(`要你自己用套件管理員裝(Linux 不替你跑 sudo):${l}`);
  for (const [good, what, why] of explain) {
    (good ? ok : warn)(`${what}  ${good ? "已偵測到" : "沒偵測到"}:${why}`);
  }

  const failed = new Set<string>();
  if (!dry && steps.length > 0) {
    if (!(await deps.confirm(`安裝以上 ${steps.length} 項?`))) {
      warn("沒有安裝任何東西(`miyoria install --yes` 可跳過這個問題)");
      return;
    }
    for (const s of steps) {
      if (s.needs?.some((n) => failed.has(n))) {
        warn(`略過 ${s.label}(前面的步驟沒完成)`);
        failed.add(s.id);
        continue;
      }
      note(`${s.label}…`);
      if (await s.run().catch(() => false)) ok(s.label);
      else {
        fail(`${s.label}  沒有完成`);
        failed.add(s.id);
      }
    }
  }

  // ---- what is still by hand ----------------------------------------------------------
  const downloadable = new Set(modelsFor(services).map((f) => f.dest));
  const missing = manualItems(stack).filter(
    (m) => m.path !== null && !existsSync(join(root, m.path)) && !downloadable.has(m.path),
  );
  const auto = autoDownloads(stack);
  if (missing.length > 0 || auto.length > 0) {
    section("還需要自己處理的");
    for (const m of missing) (m.required ? fail : warn)(`${m.service}:${m.what}  ${m.how}`);
    for (const line of auto) note(line);
  }
  if (stack.core) note("core:LLM API key 和 Discord token 由 `miyoria init` 問");

  if (failed.size > 0) {
    throw new InstallError(`${failed.size} 項沒有完成,見上面的訊息;修好後重新執行(已完成的會跳過)`);
  }
  if (!dry)
    println(
      `\n${bold("完成")}。\`miyoria doctor\` 檢查缺什麼,\`miyoria start\` 在各自的分頁啟動。`,
    );
}
