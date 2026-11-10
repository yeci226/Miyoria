// What a computer needs for the services it is set to run: node packages, Python virtualenvs and
// their packages, model files that are not downloaded for you, Docker, and (when roles are split)
// that the other computers' addresses in the config are consistent. Read-only.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "@miyoria/kernel";
import { isJsonObject } from "@miyoria/types";
import { configuredWorkerUrls, type DeepInput, type Finding, fail, ok, warn } from "./checks.js";
import { parseBind, pythonPath, type Stack, type Worker } from "./config.js";
import { isLoopback } from "./roles.js";

/** Services the stack runs on this computer. */
export function stackServices(stack: Stack): string[] {
  return [
    ...stack.workers.map((w) => w.name),
    ...(stack.core ? ["core"] : []),
    ...(stack.voiceNode ? ["voice-node"] : []),
    ...(stack.stage ? ["stage"] : []),
  ];
}

// ---- manual downloads --------------------------------------------------------------------

export interface Manual {
  service: string;
  what: string;
  /** Path relative to the repo root that must exist; `null` = nothing to check. */
  path: string | null;
  how: string;
  /** Missing is a failure (the service cannot work) rather than a warning. */
  required: boolean;
}

/** Things no command here downloads. Paths are relative to the repo root. */
export function manualItems(stack: Stack): Manual[] {
  const out: Manual[] = [];
  const tts = stack.workers.find((w) => w.name === "tts");
  if (tts) {
    const voice = tts.env.TTS_DEFAULT_VOICE ?? "deepseek-chan";
    out.push({
      service: "tts",
      what: `她的聲音參考音(${voice})`,
      path: `workers/voices/${voice}/ref.wav`,
      how: `放 workers/voices/${voice}/ref.wav 和 ref.txt(你的聲音檔,不進 git;見 workers/README.md 第 4 節)`,
      required: true,
    });
  }
  if (stack.workers.some((w) => w.name === "sing")) {
    out.push(
      {
        service: "sing",
        what: "RVC 歌聲模型",
        path: "workers/models/applio",
        how: "把 Applio 訓練好的她的 RVC 模型放在 workers/models/applio/(見 workers/README.md 第 9 節;只用 SING_VOICE=seedvc 時可略過)",
        required: false,
      },
      {
        service: "sing",
        what: "主唱 / 伴唱分離模型(BS-RoFormer karaoke)",
        path: "workers/models/lead-split",
        how: "放到 workers/models/lead-split/becruily-bs/(HF becruily/bs-roformer-karaoke);沒有就不切主唱",
        required: false,
      },
      {
        service: "sing",
        what: "人聲分離模型(Mel-Band RoFormer)",
        path: "workers/models/vocal-split",
        how: "放 MelBandRoformer.ckpt 和 .yaml 到 workers/models/vocal-split/;沒有就退回 Demucs(第一次會自動下載)",
        required: false,
      },
      {
        service: "sing",
        what: "Seed-VC 原始碼",
        path: "workers/models/seed-vc",
        how: "git clone / 下載 github.com/Plachtaa/seed-vc 到 workers/models/seed-vc(只有 seedvc 轉換鏈用得到)",
        required: false,
      },
    );
  }
  if (stack.workers.some((w) => w.name === "turn")) {
    out.push(
      {
        service: "turn",
        what: "Smart Turn 模型",
        path: "workers/models/smart-turn/smart-turn-v3.2-cpu.onnx",
        how: "workers/README.md 第 10 節有 curl 指令(約 9 MB);沒有它 worker 照跑,她退回安靜多久就算講完",
        required: false,
      },
      {
        service: "turn",
        what: "Silero VAD 模型",
        path: "workers/models/silero-vad/silero_vad.onnx",
        how: 'workers/README.md 第 10 節有 curl 指令(約 2 MB);vad_engine = "silero" 要用',
        required: false,
      },
    );
  }
  if (stack.voiceNode) {
    out.push({
      service: "voice-node",
      what: "Self 帳號 token(SELF_TOKEN)",
      path: "apps/voice-node/.env",
      how: "在 apps/voice-node/ 建 .env,填 SELF_TOKEN 和 VOICE_LINK_TOKEN(和 core 的相同);見 apps/voice-node/README.md",
      required: true,
    });
  }
  return out;
}

/** Downloads that happen by themselves the first time a service starts (so nobody wonders). */
export function autoDownloads(stack: Stack): string[] {
  const out: string[] = [];
  const asr = stack.workers.find((w) => w.name === "asr");
  if (asr) {
    const qwen = (asr.env.ASR_BACKEND ?? "").toLowerCase() === "qwen3";
    out.push(
      qwen
        ? `asr 第一次啟動會從 Hugging Face 下載 Qwen3-ASR-${asr.env.ASR_QWEN_SIZE ?? "0.6B"}(約 2 GB)`
        : "asr 用 SenseVoice 時要自己下載模型(workers/README.md 第 1a 節)",
    );
  }
  if (stack.workers.some((w) => w.name === "tts")) {
    out.push("tts 第一次啟動會下載 Qwen3-TTS 模型(約 4–5 GB)並捕捉 CUDA graph,要等幾分鐘");
  }
  if (stack.workers.some((w) => w.name === "sing")) {
    out.push("sing 第一首歌會先下載約 2 GB 的模型");
  }
  return out;
}

// ---- python packages ---------------------------------------------------------------------

/** Modules each worker needs to import, to tell an empty venv from a finished install. */
export function importsFor(w: Worker): string[] {
  switch (w.name) {
    case "asr":
      return (w.env.ASR_BACKEND ?? "sensevoice").toLowerCase() === "qwen3"
        ? ["torch", "qwen_asr"]
        : ["sherpa_onnx"];
    case "tts":
      return (w.env.TTS_BACKEND ?? "auto").toLowerCase() === "qwen-tts"
        ? ["torch", "qwen_tts"]
        : ["torch", "faster_qwen3_tts"];
    case "sing":
      return ["torch", "demucs", "librosa"];
    case "turn":
      return ["onnxruntime"];
    default:
      return [];
  }
}

function envFileValue(file: string, name: string): string {
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && m[1] === name) return (m[2] ?? "").replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // no file
  }
  return "";
}

function bindOf(config: Config, id: string, fallback: string): { host: string; port: number } {
  const modules = config.section("modules");
  const section = isJsonObject(modules) ? modules[id] : undefined;
  const bind = isJsonObject(section) && typeof section.bind === "string" ? section.bind : fallback;
  return parseBind(bind) ?? (parseBind(fallback) as { host: string; port: number });
}

function urlHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// ---- the checks --------------------------------------------------------------------------

export async function roleChecks(input: DeepInput): Promise<Finding[]> {
  const { stack, root, config, deps } = input;
  const out: Finding[] = [];
  const machine = stack.machine;
  const services = stackServices(stack);
  if (services.length === 0) return out;
  const python = (w: Worker) => (root ? pythonPath(join(root, w.venv), deps.platform) : null);

  // Tools the services need before anything is installed.
  if (stack.core || stack.voiceNode || stack.stage) {
    const major = Number(process.versions.node.split(".")[0]);
    out.push(
      major >= 24
        ? ok("Node.js", process.versions.node)
        : fail("Node.js", `${process.versions.node},要 24 以上`, ["從 nodejs.org 安裝 Node 24"]),
    );
    const pnpm = await deps.run("pnpm", ["--version"], { timeoutMs: 15_000 });
    out.push(
      pnpm.missing || pnpm.code !== 0
        ? fail("pnpm", "找不到", ["執行 `node scripts/setup.mjs`,或 `corepack enable`"])
        : ok("pnpm", pnpm.stdout.trim()),
    );
  }
  if (stack.workers.length > 0) {
    let found = "";
    for (const c of [["py", "-3"], ["python3"], ["python"]] as const) {
      const [cmd, ...pre] = c;
      const r = await deps.run(cmd, [...pre, "--version"], { timeoutMs: 15_000 });
      if (!r.missing && r.code === 0) {
        found = `${r.stdout}${r.stderr}`.trim();
        break;
      }
    }
    out.push(
      /Python 3\.(11|12|13)(\.|$)/.test(found) ||
        stack.workers.every((w) => root && existsSync(python(w) ?? ""))
        ? ok("Python", found || "venv 都已建好")
        : warn("Python", found ? `${found};worker 要 3.11–3.13` : "找不到 Python", [
            "執行 `miyoria install`(Windows:winget、macOS:brew;Linux 會印出 apt 指令)",
          ]),
    );
    if (stack.workers.some((w) => ["asr", "tts", "sing"].includes(w.name))) {
      const smi = await deps.run("nvidia-smi", ["-L"], { timeoutMs: 15_000 });
      out.push(
        smi.missing || smi.code !== 0
          ? warn(
              "NVIDIA 顯卡",
              "沒偵測到 nvidia-smi:asr、tts、sing 要 NVIDIA 顯卡和驅動(不會自動安裝)",
              [
                "沒有顯卡就只跑 core(文字聊天);或把語音換成雲端 provider([speech.asr.*] / [speech.tts.*])",
              ],
            )
          : ok("NVIDIA 顯卡", smi.stdout.split("\n")[0] ?? ""),
      );
    }
  }

  // Node packages: everything but the inference machine.
  const needsNode = stack.core || stack.voiceNode || stack.stage;
  if (needsNode && root) {
    if (!existsSync(join(root, "node_modules"))) {
      out.push(fail("node 套件", "還沒執行 pnpm install", ["執行 `miyoria install`"]));
    } else out.push(ok("node 套件", "已安裝"));
    if (stack.voiceNode && !existsSync(join(root, "apps", "voice-node", "node_modules"))) {
      out.push(fail("voice node 套件", "apps/voice-node 還沒安裝套件", ["執行 `miyoria install`"]));
    }
  }

  // Python packages: the venv exists (workerChecks) but may be empty.
  for (const w of stack.workers) {
    const py = python(w);
    if (!py || !existsSync(py)) continue;
    const modules = importsFor(w);
    if (modules.length === 0) continue;
    const r = await deps.run(py, ["-c", modules.map((m) => `import ${m}`).join(";")], {
      timeoutMs: 120_000,
    });
    if (r.code === 0) out.push(ok(`worker ${w.name} 套件`, modules.join("、")));
    else {
      out.push(
        fail(`worker ${w.name} 套件`, `venv 裡 import ${modules.join(" / ")} 失敗`, [
          "執行 `miyoria install`(會補裝 requirements;CUDA 版 torch 先裝)",
        ]),
      );
    }
  }
  if (stack.workers.some((w) => w.name === "sing")) {
    const ff = await deps.run("ffmpeg", ["-version"], { timeoutMs: 10_000 });
    if (ff.missing || ff.code !== 0) {
      out.push(
        fail("ffmpeg", "sing 要 ffmpeg(在 PATH 上)", ["winget install Gyan.FFmpeg,然後重開終端機"]),
      );
    } else out.push(ok("ffmpeg", "在 PATH 上"));
  }

  // Files that are downloaded by hand.
  if (root) {
    for (const m of manualItems(stack)) {
      const present = m.path === null || existsSync(join(root, m.path));
      const what = `${m.service}:${m.what}`;
      if (present) out.push(ok(what, m.path ?? "已設定"));
      else out.push((m.required ? fail : warn)(what, `找不到 ${m.path}`, [m.how]));
    }
    if (stack.voiceNode) {
      const env = join(root, "apps", "voice-node", ".env");
      if (existsSync(env) && envFileValue(env, "SELF_TOKEN") === "") {
        out.push(
          fail("voice node", "apps/voice-node/.env 沒有 SELF_TOKEN", ["填入 self 帳號的 token"]),
        );
      }
    }
  }

  // Docker: only for the file / code sandbox.
  if (stack.core) {
    const modules = config.section("modules");
    const sandbox = isJsonObject(modules) ? modules.sandbox : undefined;
    const enabled = isJsonObject(sandbox) && sandbox.enabled === true;
    if (!enabled) out.push(ok("Docker", "沙箱沒有啟用([modules.sandbox]),不需要"));
    else {
      const d = await deps.run("docker", ["info", "--format", "{{.ServerVersion}}"], {
        timeoutMs: 20_000,
      });
      if (d.missing) {
        out.push(
          fail("Docker", "沙箱啟用了,但找不到 docker", ["安裝 Docker Desktop(WSL2 backend)並啟動"]),
        );
      } else if (d.code !== 0) {
        out.push(
          fail("Docker", "docker 在,但連不到 daemon", ["啟動 Docker Desktop,等它顯示 running"]),
        );
      } else out.push(ok("Docker", `daemon ${d.stdout.trim()}`));
    }
  }

  if (machine) out.push(...(await addressChecks(input, services)));
  return out;
}

/** Cross-machine consistency: the addresses in the config against `[machine.hosts]`. */
export async function addressChecks(input: DeepInput, services: string[]): Promise<Finding[]> {
  const { config, deps, stack } = input;
  const machine = stack.machine;
  const out: Finding[] = [];
  if (!machine) return out;
  const here = (s: string) => services.includes(s);
  const { core: coreHost, inference: infHost } = machine.hosts;
  const split = !isLoopback(coreHost) || !isLoopback(infHost);
  if (!split) return out;

  const voice = bindOf(config, "voice.link", "127.0.0.1:7879");
  const stage = bindOf(config, "stage.link", "127.0.0.1:7882");

  if (here("core")) {
    if (!isLoopback(coreHost)) {
      for (const [label, bind, who] of [
        ["voice.link", voice, "voice-node"],
        ["stage.link", stage, "stage"],
      ] as const) {
        if (!here(who) && isLoopback(bind.host)) {
          out.push(
            warn(`${label} 綁定位址`, `綁在 ${bind.host}:${bind.port},別台電腦連不進來`, [
              `miyoria config set modules."${label}".bind ${coreHost}:${bind.port}`,
            ]),
          );
        }
      }
    }
    if (!here("asr") && !here("tts")) {
      for (const c of configuredWorkerUrls(config)) {
        const host = urlHost(c.url);
        if (host !== null && isLoopback(host) && !isLoopback(infHost)) {
          out.push(
            fail(`設定不一致:${c.key}`, `指向本機(${host}),但推論機在 ${infHost}`, [
              `miyoria config set ${c.key} http://${infHost}:${urlPortOf(c.url)}(或改 .env 的 ${c.worker.toUpperCase()}_URL)`,
            ]),
          );
        }
      }
    }
  }

  if (here("stage")) {
    const url = stageCoreUrl(config);
    const host = url ? urlHost(url) : null;
    if (host !== null && host !== coreHost) {
      out.push(
        fail("設定不一致:stage.core_url", `指向 ${host},但 [machine.hosts] core = ${coreHost}`, [
          `miyoria config set stage.core_url ws://${coreHost}:${stage.port}/stage-link`,
        ]),
      );
    }
  }
  if ((here("stage") || here("voice-node")) && !here("core") && deps.connect) {
    for (const [label, port, who] of [
      ["stage.link", stage.port, "stage"],
      ["voice.link", voice.port, "voice-node"],
    ] as const) {
      if (!here(who)) continue;
      const reachable = await deps.connect(coreHost, port, 3000);
      out.push(
        reachable
          ? ok(`連線 core ${label}`, `${coreHost}:${port} 連得到`)
          : warn(
              `連線 core ${label}`,
              `${coreHost}:${port} 連不到(core 沒開、防火牆擋住,或 core 綁在 127.0.0.1)`,
            ),
      );
    }
  }
  if (here("asr") || here("tts") || here("sing")) {
    if (!here("core") && isLoopback(infHost)) {
      out.push(
        warn("worker 位址", "worker 綁在 127.0.0.1,core 在另一台連不進來", [
          "miyoria config set machine.hosts.inference <這台電腦的區網位址>",
        ]),
      );
    }
  }
  return out;
}

function urlPortOf(url: string): string {
  try {
    return new URL(url).port || "80";
  } catch {
    return "80";
  }
}

function stageCoreUrl(config: Config): string | null {
  const stage = config.section("stage");
  return isJsonObject(stage) && typeof stage.core_url === "string" ? stage.core_url : null;
}
