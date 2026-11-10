// `miyoria doctor --deep`: the install problems met on 2026-11-07, each as a finding with a fix.
// Read-only: it reports Windows port reservations and antivirus effects and never changes system,
// firewall or antivirus settings.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "@miyoria/kernel";
import { isJsonObject } from "@miyoria/types";
import {
  buildTargets,
  checkTarget,
  findJdk21,
  installedModJars,
  minecraftModsDir,
  modFreshness,
  modInfo,
  protocolVersions,
} from "./builds.js";
import {
  offloadUrls,
  parseBind,
  pythonPath,
  type Stack,
  type Worker,
  workerUrl,
} from "./config.js";
import {
  inRanges,
  type PortProbe,
  parseDynamicPort,
  parseExcludedRanges,
  type Runner,
} from "./system.js";

export type Level = "ok" | "warn" | "fail";

export interface Finding {
  level: Level;
  what: string;
  detail: string;
  /** How to fix it, one step per line. */
  fix?: string[];
}

export interface DeepDeps {
  platform: NodeJS.Platform;
  run: Runner;
  probe: PortProbe;
  fetchImpl: typeof fetch;
  env: Record<string, string | undefined>;
  tmpdir: string;
  /** Version of this CLI, compared with the running core's. */
  version: string;
  /** Whether something accepts TCP connections at host:port (cross-machine checks). */
  connect?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
}

export interface DeepInput {
  config: Config;
  configDir: string;
  root: string | null;
  stack: Stack;
  deps: DeepDeps;
}

export const ok = (what: string, detail: string): Finding => ({ level: "ok", what, detail });
export const warn = (what: string, detail: string, fix?: string[]): Finding => ({
  level: "warn",
  what,
  detail,
  fix,
});
export const fail = (what: string, detail: string, fix?: string[]): Finding => ({
  level: "fail",
  what,
  detail,
  fix,
});

// ---- ports -------------------------------------------------------------------------------

interface Listener {
  label: string;
  host: string;
  port: number;
  /** URL answering 200 when the service is ours and running. */
  health?: string;
}

function moduleBind(config: Config, id: string): { host: string; port: number } | null {
  const modules = config.section("modules");
  const section = isJsonObject(modules) ? modules[id] : undefined;
  if (!isJsonObject(section) || section.enabled === false) return null;
  return typeof section.bind === "string" ? parseBind(section.bind) : null;
}

export function listeners({ config, stack }: DeepInput): Listener[] {
  const out: Listener[] = [];
  const api = moduleBind(config, "api");
  if (api) {
    out.push({
      label: "Admin API",
      ...api,
      health: `http://${api.host === "0.0.0.0" ? "127.0.0.1" : api.host}:${api.port}/api/health`,
    });
  }
  const voice = moduleBind(config, "voice.link");
  if (voice) out.push({ label: "voice link", ...voice });
  const stage = moduleBind(config, "stage.link");
  if (stage) out.push({ label: "stage link", ...stage });
  if (stack.stage) {
    out.push({ label: "stage 嘴型音量", host: "127.0.0.1", port: 7883 });
    out.push({ label: "stage overlay", host: "127.0.0.1", port: 7884 });
  }
  for (const w of stack.workers) {
    out.push({
      label: `worker ${w.name}`,
      host: w.host,
      port: w.port,
      health: `${workerUrl(w)}/health`,
    });
  }
  return out;
}

async function ping(fetchImpl: typeof fetch, url: string): Promise<Response | null> {
  try {
    return await fetchImpl(url, { signal: AbortSignal.timeout(3000) });
  } catch {
    return null;
  }
}

const WINNAT_FIX = [
  "用系統管理員的 PowerShell 查看保留範圍:netsh interface ipv4 show excludedportrange protocol=tcp",
  "重啟 WinNAT 通常能釋放:net stop winnat 再 net start winnat(重開機後可能又出現)",
  "長期做法是把動態埠範圍移到 49152 以後:netsh int ipv4 set dynamic tcp start=49152 num=16384(要重開機;改不改由你決定,Miyoria 不會替你改)",
];

export async function portChecks(input: DeepInput): Promise<Finding[]> {
  const { deps } = input;
  const findings: Finding[] = [];
  let ranges: ReturnType<typeof parseExcludedRanges> = [];
  if (deps.platform === "win32") {
    const excluded = await deps.run(
      "netsh",
      ["interface", "ipv4", "show", "excludedportrange", "protocol=tcp"],
      { timeoutMs: 10_000 },
    );
    if (!excluded.missing) ranges = parseExcludedRanges(excluded.stdout);
    const dynamic = await deps.run("netsh", ["int", "ipv4", "show", "dynamicport", "tcp"], {
      timeoutMs: 10_000,
    });
    const info = dynamic.missing ? null : parseDynamicPort(dynamic.stdout);
    if (info && info.start < 49152) {
      findings.push(
        warn(
          "動態埠範圍",
          `從 ${info.start} 開始(Windows 預設 49152);Hyper-V / WinNAT 可能在開機時保留 Miyoria 的埠`,
          WINNAT_FIX,
        ),
      );
    } else if (info) {
      findings.push(ok("動態埠範圍", `從 ${info.start} 開始`));
    }
  }
  for (const l of listeners(input)) {
    const range = inRanges(l.port, ranges);
    const state = await deps.probe(l.port, l.host);
    const name = `埠 ${l.port}(${l.label})`;
    if (state === "denied" || (range && state !== "in-use")) {
      const where = range
        ? `落在 Windows 保留範圍 ${range.start}-${range.end}`
        : "Windows 拒絕綁定";
      findings.push(fail(name, `${where},服務會綁不上(EACCES),但沒有程式在用`, WINNAT_FIX));
    } else if (state === "in-use") {
      const res = l.health ? await ping(deps.fetchImpl, l.health) : null;
      if (res?.ok) findings.push(ok(name, "已有 Miyoria 服務在聽"));
      else {
        findings.push(
          warn(name, "已有程式在聽;不是 Miyoria 的話服務會綁不上", [
            `查是誰:netstat -ano | findstr :${l.port}(最後一欄是 PID)`,
            "是舊的 Miyoria 行程就先關掉它;`miyoria up` 不會替你結束別的程式",
          ]),
        );
      }
    } else if (state === "error") {
      findings.push(warn(name, "無法測試這個埠"));
    } else {
      findings.push(ok(name, "可以使用"));
    }
  }
  return findings;
}

// ---- workers -----------------------------------------------------------------------------

/** Rough VRAM a worker holds when loaded (MB); the config's `vram_mb` wins. */
export function estimateVram(w: Worker): number {
  if (w.vramMb !== null) return w.vramMb;
  if (w.name === "asr" || w.entry.includes("asr")) {
    if ((w.env.ASR_BACKEND ?? "").toLowerCase() !== "qwen3") return 0;
    return (w.env.ASR_QWEN_SIZE ?? "0.6B").startsWith("1.7") ? 4500 : 1500;
  }
  if (w.name === "tts") return 5000;
  if (w.name === "sing") return 7500;
  return 0;
}

function urlPort(url: string): number | null {
  try {
    const u = new URL(url);
    return u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

/** What `workers/turn` loads unless `TURN_SMART_MODEL` / `TURN_SILERO_MODEL` say otherwise. */
const TURN_MODELS = [
  {
    env: "TURN_SMART_MODEL",
    file: "models/smart-turn/smart-turn-v3.2-cpu.onnx",
    what: "Smart Turn",
  },
  { env: "TURN_SILERO_MODEL", file: "models/silero-vad/silero_vad.onnx", what: "Silero" },
] as const;

const DEFAULT_TURN_URL = "http://127.0.0.1:8006";

/**
 * URLs in the config that point at a worker: `[speech.asr.*]`, `[speech.tts.*]`, `[modules.sing]`
 * and `turn_url` of `[modules.voice]` (only while Smart Turn or Silero is what the voice module uses).
 */
export function configuredWorkerUrls(
  config: Config,
): Array<{ worker: string; key: string; url: string }> {
  const out: Array<{ worker: string; key: string; url: string }> = [];
  for (const kind of ["asr", "tts"] as const) {
    const providers = config.section(`speech.${kind}`);
    if (!isJsonObject(providers)) continue;
    for (const [name, p] of Object.entries(providers)) {
      if (isJsonObject(p) && p.kind === "http-worker" && typeof p.url === "string") {
        out.push({ worker: kind, key: `speech.${kind}.${name}.url`, url: p.url });
      }
    }
  }
  const sing = config.module("sing").config;
  if (isJsonObject(sing) && typeof sing.url === "string") {
    out.push({ worker: "sing", key: "modules.sing.url", url: sing.url });
  }
  const voice = config.module("voice").config;
  if (
    isJsonObject(voice) &&
    (voice.turn_engine === "smart-turn" || voice.vad_engine === "silero")
  ) {
    const url = typeof voice.turn_url === "string" ? voice.turn_url : DEFAULT_TURN_URL;
    out.push({ worker: "turn", key: "modules.voice.turn_url", url });
  }
  return out;
}

export function workerChecks(input: DeepInput): Finding[] {
  const { stack, root, config } = input;
  const findings: Finding[] = [];
  const workers = stack.workers;
  if (workers.length === 0) return findings;

  const byPort = new Map<number, string[]>();
  for (const w of workers) byPort.set(w.port, [...(byPort.get(w.port) ?? []), w.name]);
  for (const [port, names] of byPort) {
    if (names.length > 1) {
      findings.push(
        fail("worker 埠", `${names.join("、")} 都設成 ${port}`, ["每個 worker 要用不同的 port"]),
      );
    }
  }

  for (const w of workers) {
    const name = `worker ${w.name}`;
    if (root) {
      const venv = join(root, w.venv);
      const python = pythonPath(venv, input.deps.platform);
      if (!existsSync(python)) {
        findings.push(
          fail(name, `找不到 venv 的 Python:${python}`, [
            `建立:python -m venv ${w.venv},再照 workers/README.md 安裝 requirements`,
            `或把 [stack.workers.${w.name}] venv 指到現有的 venv`,
          ]),
        );
      }
      const entry = join(root, "workers", w.dir, w.entry);
      if (!existsSync(entry)) findings.push(fail(name, `找不到 ${entry}`));
      if (w.name === "turn") {
        // The worker runs without its models and Core falls back, so this is a warning.
        for (const m of TURN_MODELS) {
          const file = w.env[m.env] ?? join(root, "workers", m.file);
          if (existsSync(file)) continue;
          findings.push(
            warn(name, `找不到 ${m.what} 模型:${file}(worker 照常跑,但她會退回舊的判斷講完)`, [
              `照 workers/README.md 第 10 節下載模型,或把 env 的 ${m.env} 指到現有的檔案`,
            ]),
          );
        }
      }
    }
    for (const target of w.offload) {
      if (target === w.name || !workers.some((x) => x.name === target)) {
        findings.push(
          fail(name, `offload 的 \`${target}\` 不是 [stack.workers] 裡的其他 worker`, [
            `把 ${target} 加進 [stack.workers],或從 offload 拿掉`,
          ]),
        );
      }
    }
    const explicit = w.env.SING_OFFLOAD_URLS;
    const peers = workers.filter((x) => x.name !== w.name && x.name !== "sing");
    if (w.name === "sing" && w.offload.length === 0 && !explicit && peers.length > 0) {
      findings.push(
        fail(
          name,
          `沒有 offload:${peers.map((p) => p.name).join("、")} 的模型留在顯存裡,做歌時顯存會溢出(轉換慢約 76 倍,worker 不回應)`,
          [`[stack.workers.sing] 加上 offload = [${peers.map((p) => `"${p.name}"`).join(", ")}]`],
        ),
      );
    }
    if (explicit && w.offload.length > 0) {
      const set = (s: string) =>
        new Set(
          s
            .split(",")
            .map((u) => u.trim())
            .filter(Boolean),
        );
      const want = set(offloadUrls(w, workers));
      const have = set(explicit);
      const same = want.size === have.size && [...want].every((u) => have.has(u));
      if (!same) {
        findings.push(
          warn(name, "env.SING_OFFLOAD_URLS 和 offload 算出來的網址不一樣,會用 env 的", [
            "只留一邊:刪掉 env.SING_OFFLOAD_URLS,讓 offload 自動產生",
          ]),
        );
      }
    }
    if (
      (w.env.ASR_BACKEND ?? "").toLowerCase() === "qwen3" &&
      (w.env.ASR_MODEL ?? "").trim() !== ""
    ) {
      findings.push(
        fail(
          name,
          "ASR_BACKEND=qwen3,但 env 裡有 ASR_MODEL(舊的 SenseVoice 設定會讓 Qwen3 載入失敗)",
          [`從 [stack.workers.${w.name}] env 拿掉 ASR_MODEL`],
        ),
      );
    }
  }

  for (const c of configuredWorkerUrls(config)) {
    const w = workers.find((x) => x.name === c.worker);
    const port = urlPort(c.url);
    if (!w || port === null) continue;
    if (port !== w.port) {
      findings.push(
        fail(
          `設定不一致:${c.key}`,
          `指向 port ${port},但 [stack.workers.${w.name}] 跑在 ${w.port}(Core 會連錯 worker)`,
          [
            `miyoria config set ${c.key} http://127.0.0.1:${w.port}(或改 .env 的 ${c.worker.toUpperCase()}_URL)`,
          ],
        ),
      );
    }
  }
  if (findings.length === 0)
    findings.push(ok("worker 組合", `${workers.length} 個 worker 設定一致`));
  return findings;
}

// ---- builds ------------------------------------------------------------------------------

export async function buildChecks(input: DeepInput): Promise<Finding[]> {
  const { root, config, configDir, deps } = input;
  const findings: Finding[] = [];
  if (!root) return findings;
  for (const t of buildTargets(root, configDir, config)) {
    const f = checkTarget(t);
    const what = `建置 ${t.label}`;
    if (f.state === "fresh") findings.push(ok(what, f.detail));
    else if (f.state === "stale") {
      findings.push(fail(what, f.detail, ["執行 `miyoria update` 重建(只重建過期的)"]));
    } else if (t.configured === false) {
      findings.push(
        warn(what, "還沒建置(設定檔沒有用到它)", ["需要時執行 `miyoria update --force`"]),
      );
    } else {
      findings.push(fail(what, "還沒建置,或上次建置失敗留下空的輸出", ["執行 `miyoria update`"]));
    }
  }

  const mod = modInfo(root);
  if (!mod) return findings;
  const built = modFreshness(mod);
  if (built.state === "fresh") findings.push(ok("mod jar(建置)", built.detail));
  else {
    findings.push(
      fail("mod jar(建置)", built.state === "missing" ? "還沒建置" : built.detail, [
        "執行 `miyoria update`(需要 JDK 21)",
      ]),
    );
  }
  const jdk = await findJdk21(deps.run, deps.env, deps.platform);
  if (jdk.jdk21) findings.push(ok("JDK 21", jdk.jdk21.home ?? "在 PATH"));
  else {
    const needed = built.state !== "fresh";
    const msg = `找不到 JDK 21${jdk.onPath ? `(PATH 上的 java 是 ${jdk.onPath})` : ""}`;
    const fix = [
      "安裝 Temurin 21:winget install EclipseAdoptium.Temurin.21.JDK",
      "或設定 JAVA_HOME 指向 JDK 21(`miyoria update` 會用找到的 JDK 21,不改你的系統設定)",
    ];
    findings.push(
      needed ? fail("JDK 21", msg, fix) : warn("JDK 21", `${msg};下次改 mod 時需要`, fix),
    );
  }
  const versions = protocolVersions(root);
  if (versions.source !== null && versions.doc !== null && versions.source !== versions.doc) {
    findings.push(
      fail(
        "mod 協定版本",
        `Protocol.java 是 ${versions.source},PROTOCOL.md 寫 ${versions.doc};adapter 照文件實作`,
        ["兩邊要一起改,改完執行 `miyoria update`"],
      ),
    );
  } else if (versions.source !== null) {
    findings.push(ok("mod 協定版本", `protocol ${versions.source}`));
  }
  const mods = minecraftModsDir(config);
  const ext = config.section("extensions");
  const hasMc = isJsonObject(ext) && isJsonObject(ext["miyoria.minecraft"]);
  if (!mods) {
    if (hasMc) {
      findings.push(
        warn("遊戲裡的 mod", "沒有設定 minecraft_dir,無法比對遊戲裡的 mod jar", [
          '[extensions."miyoria.minecraft"] minecraft_dir = "<Prism 實例>\\.minecraft"',
        ]),
      );
    }
  } else {
    const installed = installedModJars(mods);
    const target = built.state === "missing" ? null : readFileOrNull(mod.jar);
    if (installed.length === 0) {
      findings.push(
        fail("遊戲裡的 mod", `${mods} 裡沒有 miyoria-bridge jar`, [
          "執行 `miyoria update`(會先問再複製)",
        ]),
      );
    } else if (target) {
      const want = sha(target);
      const same = installed.some((p) => {
        const data = readFileOrNull(p);
        return data !== null && sha(data) === want;
      });
      if (same) findings.push(ok("遊戲裡的 mod", "和建置出來的 jar 相同"));
      else {
        findings.push(
          fail(
            "遊戲裡的 mod",
            `${installed.map((p) => p.slice(mods.length + 1)).join("、")} 不是目前建置的版本(找不到 adapter / task executor 的常見原因)`,
            ["先關掉遊戲,執行 `miyoria update`(會備份舊 jar 再複製)"],
          ),
        );
      }
    }
  }
  return findings;
}

function readFileOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function sha(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// ---- writable folders and temp files -----------------------------------------------------

/** Writes and removes a small file; `null` when it worked, else the error code. */
export function writableProbe(dir: string): string | null {
  const file = join(dir, `.miyoria-doctor-${process.pid}`);
  try {
    writeFileSync(file, "x");
    unlinkSync(file);
    return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? "error";
  }
}

function nearestExisting(dir: string): string {
  let cur = dir;
  while (!existsSync(cur) && dirname(cur) !== cur) cur = dirname(cur);
  return cur;
}

export function cacheChecks(input: DeepInput): Finding[] {
  const { stack, root, deps, configDir } = input;
  const findings: Finding[] = [];
  const sing = stack.workers.find((w) => w.name === "sing");
  const base = root ?? configDir;
  const dataDir = sing?.env.SING_DATA_DIR ?? deps.env.SING_DATA_DIR ?? join(base, "data", "songs");
  const cache =
    sing?.env.SING_YTDLP_CACHE ?? deps.env.SING_YTDLP_CACHE ?? join(dataDir, "_ytdlp-cache");
  for (const [label, dir] of [
    ["快取資料夾(yt-dlp)", cache],
    ["資料夾(歌曲)", dataDir],
  ] as const) {
    const where = existsSync(dir) ? dir : nearestExisting(dir);
    const code = writableProbe(where);
    if (code === null)
      findings.push(ok(label, existsSync(dir) ? "可寫入" : `不存在,上層 ${where} 可寫入`));
    else {
      findings.push(
        fail(label, `${where} 不能寫入(${code});yt-dlp 會卡住不動`, [
          "檢查資料夾權限和防毒的保護資料夾設定,或把 SING_DATA_DIR / SING_YTDLP_CACHE 指到別處",
        ]),
      );
    }
  }
  return findings;
}

const AV_PROCESSES: Record<string, string> = {
  "avp.exe": "Kaspersky",
  "ekrn.exe": "ESET",
  "bdagent.exe": "Bitdefender",
  "mbamservice.exe": "Malwarebytes",
};

/** Large temp file write/read/delete (what esbuild does), plus leftovers of a blocked build. */
export async function tempChecks(input: DeepInput): Promise<Finding[]> {
  const { deps } = input;
  const findings: Finding[] = [];
  const file = join(deps.tmpdir, `miyoria-doctor-${process.pid}.tmp`);
  try {
    writeFileSync(file, Buffer.alloc(2 * 1024 * 1024, 1));
    const size = readFileSync(file).length;
    unlinkSync(file);
    findings.push(
      ok("暫存檔", `${deps.tmpdir} 可以寫入、讀取、刪除 ${(size / 1048576).toFixed(0)} MB 檔案`),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "error";
    findings.push(
      fail("暫存檔", `${deps.tmpdir} 的大檔案操作失敗(${code}):常見原因是防毒鎖住暫存檔`, [
        "不要用 `pnpm build:web`;用 `miyoria update`(vite 加 --minify false --target esnext)",
        "也可以把暫存資料夾加進防毒的排除清單(由你自己設定)",
      ]),
    );
    try {
      unlinkSync(file);
    } catch {
      // still locked
    }
  }
  let leftovers = 0;
  try {
    leftovers = readdirSync(deps.tmpdir).filter((n) => /^esbuild-/i.test(n)).length;
  } catch {
    // unreadable temp folder is reported above
  }
  if (leftovers > 0) {
    findings.push(
      warn("esbuild 暫存檔", `${deps.tmpdir} 留有 ${leftovers} 個 esbuild-* 檔案(上次建置被擋住)`, [
        "確認沒有建置在跑後,可以手動刪除;建置請用 `miyoria update`",
      ]),
    );
  }
  if (deps.platform === "win32") {
    const list = await deps.run("tasklist", ["/fo", "csv", "/nh"], { timeoutMs: 15_000 });
    const names = new Set(
      list.stdout.split(/\r?\n/).map((l) => /^"([^"]+)"/.exec(l)?.[1]?.toLowerCase() ?? ""),
    );
    const found = Object.entries(AV_PROCESSES).filter(([exe]) => names.has(exe));
    for (const [, product] of found) {
      findings.push(
        warn("防毒", `偵測到 ${product};它可能鎖住 esbuild 的暫存檔,讓面板建置失敗`, [
          "建置一律用 `miyoria update`(內含 vite build --minify false --target esnext)",
        ]),
      );
    }
  }
  return findings;
}

// ---- VRAM --------------------------------------------------------------------------------

export async function vramChecks(input: DeepInput): Promise<Finding[]> {
  const { stack, deps } = input;
  const smi = await deps.run(
    "nvidia-smi",
    ["--query-gpu=name,memory.total,memory.used", "--format=csv,noheader,nounits"],
    { timeoutMs: 15_000 },
  );
  if (smi.missing || smi.code !== 0) {
    return [warn("顯存", "沒有 nvidia-smi,略過顯存預算(沒有 NVIDIA 顯卡就不需要)")];
  }
  const [name, total, used] = (smi.stdout.split(/\r?\n/)[0] ?? "").split(",").map((s) => s.trim());
  const totalMb = Number(total);
  const usedMb = Number(used);
  if (!Number.isFinite(totalMb)) return [warn("顯存", "讀不到 nvidia-smi 的輸出")];
  const head = `${name}:${usedMb} / ${totalMb} MB 已用`;
  if (stack.workers.length === 0) return [ok("顯存", head)];

  const estimate = new Map(stack.workers.map((w) => [w.name, estimateVram(w)]));
  const sum = (names: Iterable<string>) =>
    [...names].reduce((s, n) => s + (estimate.get(n) ?? 0), 0);
  const all = stack.workers.map((w) => w.name);
  let peak = sum(all);
  let peakWhy = "全部載入時";
  for (const w of stack.workers) {
    if (w.offload.length === 0) continue;
    const during =
      (estimate.get(w.name) ?? 0) + sum(all.filter((n) => n !== w.name && !w.offload.includes(n)));
    if (during > peak) {
      peak = during;
      peakWhy = `${w.name} 工作時`;
    }
  }
  const detail = `${head};估計尖峰 ${peak} MB(${peakWhy};各 worker 的估計值可用 vram_mb 調整)`;
  if (peak > totalMb * 0.92) {
    return [
      warn("顯存預算", `${detail},超過 ${totalMb} MB 的 92%`, [
        "讓 sing 用 offload 暫時卸下 tts / asr,或改用較小的模型(ASR_QWEN_SIZE=0.6B、ASR_BACKEND=sensevoice)",
      ]),
    ];
  }
  return [ok("顯存預算", detail)];
}

// ---- service health ----------------------------------------------------------------------

export async function healthChecks(input: DeepInput): Promise<Finding[]> {
  const { deps, config, stack } = input;
  const findings: Finding[] = [];
  const urls = new Map<string, string>();
  for (const l of listeners(input)) if (l.health) urls.set(l.health, l.label);
  for (const c of configuredWorkerUrls(config))
    urls.set(`${c.url.replace(/\/$/, "")}/health`, c.key);
  for (const w of stack.workers) urls.set(`${workerUrl(w)}/health`, `worker ${w.name}`);
  for (const [url, label] of urls) {
    const res = await ping(deps.fetchImpl, url);
    const what = `服務 ${label}`;
    if (!res) {
      findings.push(warn(what, `${url} 沒有回應(沒啟動?)`, ["`miyoria up` 啟動整組服務"]));
      continue;
    }
    if (!res.ok) {
      findings.push(fail(what, `${url} 回應 ${res.status}`));
      continue;
    }
    let version: string | null = null;
    try {
      const body: unknown = await res.json();
      if (isJsonObject(body) && typeof body.version === "string") version = body.version;
      if (isJsonObject(body) && (body.smart_turn === false || body.silero === false)) {
        // `workers/turn` answers `/health` without its models: Core falls back to the silence timeout.
        const missing = [
          body.smart_turn === false ? "smart_turn" : null,
          body.silero === false ? "silero" : null,
        ];
        findings.push(
          warn(what, `${url} 在跑,但 ${missing.filter(Boolean).join("、")} 模型沒載入`, [
            "看 /health 的 errors,多半是模型路徑;照 workers/README.md 第 10 節放好模型再重啟",
          ]),
        );
        continue;
      }
    } catch {
      // health without a JSON body is fine
    }
    if (url.endsWith("/api/health") && version && version !== deps.version) {
      findings.push(
        warn(what, `執行中的 core 是 ${version},這份 CLI 是 ${deps.version}`, [
          "重啟 core 讓它用新版(`miyoria update` 之後要重啟)",
        ]),
      );
    } else findings.push(ok(what, version ? `正常(版本 ${version})` : "正常"));
  }
  return findings;
}

// ---- leftovers from older setups ---------------------------------------------------------

const V2_AGENT_VOICE_KEYS = ["ambient_factor", "cooldown_ms", "min_cooldown_ms", "interrupt_scale"];

/** Old values that still parse but no longer do anything. Keys only; values are not printed. */
export function legacyConfigNotes(config: Config): string[] {
  const notes: string[] = [];
  const agent = config.module("agent").config;
  if (isJsonObject(agent)) {
    const voice = agent.voice;
    if (isJsonObject(voice)) {
      for (const key of V2_AGENT_VOICE_KEYS) {
        if (key in voice) {
          notes.push(`[modules.agent.voice] ${key} 已經拿掉(留著只會警告),可以刪除`);
        }
      }
    }
    const modes = [
      agent.default_mode,
      ...(isJsonObject(agent.channels) ? Object.values(agent.channels) : []),
    ];
    if (modes.includes("ambient")) {
      notes.push('[modules.agent] 的聊天等級 "ambient" 已改名為 "normal"');
    }
  }
  return notes;
}

export function legacyChecks(input: DeepInput): Finding[] {
  const notes = legacyConfigNotes(input.config);
  return notes.length === 0
    ? [ok("舊設定", "沒有 V2 留下的舊值")]
    : notes.map((n) => warn("舊設定", n, ["`miyoria config unset <key>` 或直接編輯 miyoria.toml"]));
}

// ---- all ---------------------------------------------------------------------------------

export async function deepChecks(input: DeepInput): Promise<Finding[]> {
  const groups: Array<() => Promise<Finding[]> | Finding[]> = [
    () => portChecks(input),
    () => workerChecks(input),
    () => buildChecks(input),
    () => cacheChecks(input),
    () => tempChecks(input),
    () => vramChecks(input),
    () => healthChecks(input),
    () => legacyChecks(input),
  ];
  const out: Finding[] = [];
  for (const group of groups) {
    try {
      out.push(...(await group()));
    } catch (error) {
      out.push(
        warn("檢查", `有一組檢查中斷了:${error instanceof Error ? error.message : String(error)}`),
      );
    }
  }
  return out;
}
