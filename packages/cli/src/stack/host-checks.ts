// `miyoria doctor`, per service: what a service's descriptor says it needs, checked against this
// host (docs/design/v5-hostd.md §9). Everything here is read-only; `--fix` is the caller's, and
// it only syncs an environment or downloads `install.files`. Checking a file hashes it when it is
// new or changed since its hash was remembered (`--deep` hashes every one).

import type { HostInfo } from "@miyoria/contracts/host";
import {
  type CatalogEntry,
  checkServiceFiles,
  formatBytes,
  type InstallDeps,
  inspectService,
  type LoadedHostConfig,
  pythonIn,
  readHostKey,
} from "@miyoria/hostd";
import { isJsonObject } from "@miyoria/types";
import { type DeepDeps, type Finding, fail, type Listener, ok, ping, warn } from "./checks.js";

export interface HostCheckInput {
  host: LoadedHostConfig;
  /** The enabled services, in the order `host.toml` lists them. */
  entries: readonly CatalogEntry[];
  deps: DeepDeps;
  /** The installer's seams (the platform and PATH it looks in); `root` is added. */
  install?: Omit<InstallDeps, "root">;
  /** The catalog root: `install.manual` paths start there. */
  root: string;
  /** What the running daemon says; `null` when none runs for this workspace. */
  daemon: HostInfo | null;
  /** Also run what is slow: the import check, ports, health and the GPU budget. */
  deep: boolean;
}

const name = (entry: CatalogEntry, what: string): string => `${entry.name}  ${what}`;

function installDeps(input: HostCheckInput): InstallDeps {
  return { ...input.install, root: input.root, platform: input.deps.platform, env: input.deps.env };
}

// ---- per service -------------------------------------------------------------------------

/** Platform, runtime, system programs, manual items, files and models of one service. */
export async function serviceChecks(input: HostCheckInput): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const entry of input.entries) {
    const inspected = inspectService(entry, input.host, installDeps(input));
    if (!inspected.platformOk) {
      findings.push(
        fail(
          name(entry, "平台"),
          `只支援 ${entry.descriptor.platforms.join("、")};這台是 ${input.deps.platform}`,
          [`從 host.toml 拿掉 [services.${entry.name}],或用 \`miyoria remove ${entry.name}\``],
        ),
      );
      continue;
    }
    const rt = inspected.runtime;
    if (rt.kind === "managed") {
      const state = rt.state;
      if (state?.state === "ready") {
        findings.push(
          ok(
            name(entry, "環境"),
            `${rt.dir}${rt.extras.length > 0 ? `(extras:${rt.extras.join("、")})` : ""}`,
          ),
        );
        if (input.deep) findings.push(...(await importCheck(input, entry, rt.dir ?? "")));
      } else if (state?.state === "stale") {
        findings.push(
          fail(
            name(entry, "環境"),
            `和目前的 uv.lock、extras 或 service.toml 不一致:${state.reasons.join("、")}`,
            ["`miyoria doctor --fix` 或 `miyoria update` 重新同步"],
          ),
        );
      } else {
        findings.push(
          fail(name(entry, "環境"), `還沒建立:${rt.dir}`, [
            `\`miyoria add ${entry.name}\`(或 \`miyoria doctor --fix\`)建立;沒有 uv 的話先安裝 uv`,
          ]),
        );
      }
    } else if (rt.kind === "user-managed") {
      if (rt.pythonExists) {
        findings.push(ok(name(entry, "環境"), `用 host.toml 指定的 ${rt.dir}(Miyoria 不會動它)`));
        if (input.deep) findings.push(...(await importCheck(input, entry, rt.dir ?? "")));
      } else {
        findings.push(
          fail(name(entry, "環境"), `host.toml 指定的環境不存在:${rt.dir}`, [
            `建立它,或從 [services.${entry.name}] 拿掉 python 讓 Miyoria 自己建`,
          ]),
        );
      }
    }
    for (const s of inspected.system) {
      findings.push(
        s.found
          ? ok(name(entry, `系統程式 ${s.program}`), "在 PATH 上")
          : fail(
              name(entry, `系統程式 ${s.program}`),
              "不在 PATH 上",
              s.hint ? [s.hint] : undefined,
            ),
      );
    }
    for (const m of inspected.manual) {
      findings.push(
        m.present
          ? ok(name(entry, "手動項目"), `${m.what}:${m.path}`)
          : warn(name(entry, "手動項目"), `缺 ${m.what}:${m.path}`, [
              "Miyoria 不會替你下載;自己放好後再 `miyoria doctor`",
            ]),
      );
    }
    // `install.files`: hashed when new or changed since the last check (`--deep`: every one).
    for (const f of await checkServiceFiles(entry, input.host, input.deep ? "deep" : "cached")) {
      const what = name(entry, `檔案 ${f.path}`);
      if (f.state === "verified" || f.state === "present") {
        findings.push(ok(what, `已驗證(${formatBytes(f.size)})`));
      } else if (f.state === "wrong") {
        findings.push(
          fail(what, `不對:${f.detail ?? "檢查碼不符"}`, [
            "`miyoria doctor --fix` 重新下載(會先列出來問你)",
          ]),
        );
      } else {
        const detail = `缺 ${f.what}(${formatBytes(f.size)},授權 ${f.licence},來自 ${f.source})`;
        const fix = [
          "`miyoria doctor --fix` 下載(會先列出來問你)",
          ...(f.optional ? [] : ["缺這個檔案 hostd 不會啟動這個服務"]),
        ];
        findings.push(f.optional ? warn(what, detail, fix) : fail(what, detail, fix));
      }
    }
    for (const m of inspected.models) {
      findings.push(
        m.present
          ? ok(name(entry, `模型 ${m.repo}`), "在快取裡")
          : warn(name(entry, `模型 ${m.repo}`), "還沒下載(第一次啟動會自己下載,但會等很久)", [
              `\`miyoria models pull ${entry.name}\``,
            ]),
      );
    }
  }
  return findings;
}

/** `check_imports` with the environment's Python: the smoke test of `--deep`. */
async function importCheck(
  input: HostCheckInput,
  entry: CatalogEntry,
  envDir: string,
): Promise<Finding[]> {
  const modules = entry.descriptor.install.check_imports;
  if (modules.length === 0) return [];
  const python = pythonIn(envDir, input.deps.platform);
  const result = await input.deps.run(python, ["-c", `import ${modules.join(", ")}`], {
    timeoutMs: 180_000,
  });
  const what = name(entry, "匯入檢查");
  if (result.code === 0) return [ok(what, modules.join("、"))];
  const last = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .pop();
  return [
    fail(
      what,
      result.missing
        ? `找不到 ${python}`
        : `import ${modules.join(", ")} 失敗${result.timedOut ? "(逾時)" : ""}${last ? `:${last}` : ""}`,
      [
        `\`miyoria doctor --fix\` 重新同步;還是不行就 \`miyoria remove ${entry.name}\` 再 \`miyoria add ${entry.name}\``,
      ],
    ),
  ];
}

// ---- hostd, the control link, the host key -----------------------------------------------

export function hostdChecks(input: HostCheckInput): Finding[] {
  const findings: Finding[] = [];
  const { daemon, host } = input;
  if (daemon === null) {
    findings.push(warn("hostd", "沒有在執行", ["`miyoria up` 啟動它(`miyoria status` 看狀態)"]));
  } else {
    const running = daemon.services.filter((s) => s.state === "running").length;
    findings.push(ok("hostd", `${daemon.name},${running} / ${daemon.services.length} 個服務在跑`));
  }
  if (host.config.cluster === undefined) return findings;
  let key: ReturnType<typeof readHostKey> = null;
  let keyError: string | null = null;
  try {
    key = readHostKey(host.state.root);
  } catch (error) {
    keyError = error instanceof Error ? error.message : String(error);
  }
  if (keyError !== null) {
    findings.push(fail("host.key", `讀不了:${keyError}`, ["`miyoria host join` 重新加入 Core"]));
  } else if (key === null) {
    findings.push(
      fail("host.key", `${host.config.cluster.url} 有設定,但這台還沒加入 Core`, [
        "在 Core 那台 `miyoria host invite`,這台照它印出的 `miyoria host join ...` 執行",
      ]),
    );
  } else {
    findings.push(ok("host.key", `已加入 Core(host id ${key.id})`));
  }
  if (daemon !== null) {
    switch (daemon.link) {
      case "connected":
        findings.push(ok("Core 連線", `已連上 ${host.config.cluster.url}`));
        break;
      case "unauthorized":
        findings.push(
          fail("Core 連線", "Core 拒絕了這台(host.key 無效或已撤銷)", [
            "`miyoria host join` 重新加入",
          ]),
        );
        break;
      case "connecting":
        findings.push(
          warn("Core 連線", "連線中;Core 沒開或網址不通就會一直試", [
            `確認 ${host.config.cluster.url} 連得到`,
          ]),
        );
        break;
      default:
        findings.push(warn("Core 連線", "沒有連線", ["`miyoria up` 之後再看 `miyoria status`"]));
    }
  }
  return findings;
}

// ---- listeners, health, VRAM -------------------------------------------------------------

/** The port a service listens on: `host.toml`'s, else the descriptor's number; `null` for `auto`. */
export function portOf(host: LoadedHostConfig, entry: CatalogEntry): number | null {
  const configured = host.config.services[entry.name]?.port;
  if (configured !== undefined) return configured;
  const preferred = entry.descriptor.run?.port;
  return typeof preferred === "number" ? preferred : null;
}

export function listenersOf(input: HostCheckInput): Listener[] {
  const out: Listener[] = [];
  for (const entry of input.entries) {
    const port = portOf(input.host, entry);
    if (port === null) continue;
    const path = entry.descriptor.run?.health.http;
    const status = input.daemon?.services.find((s) => s.name === entry.name);
    out.push({
      label: entry.name,
      host: "127.0.0.1",
      port,
      ...(path !== undefined ? { health: `http://127.0.0.1:${port}${path}` } : {}),
      ...(input.daemon === null
        ? {}
        : { ours: status?.state === "running" || status?.state === "starting" }),
    });
  }
  return out;
}

export async function healthChecks(input: HostCheckInput): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const l of listenersOf(input)) {
    if (l.health === undefined) continue;
    const what = `服務 ${l.label}`;
    const status = input.daemon?.services.find((s) => s.name === l.label);
    if (input.daemon !== null && status?.state !== "running") {
      findings.push(
        warn(what, `沒有在跑(${status?.state ?? "hostd 不認得它"})`, [`\`miyoria up ${l.label}\``]),
      );
      continue;
    }
    const res = await ping(input.deps.fetchImpl, l.health);
    if (!res) {
      findings.push(warn(what, `${l.health} 沒有回應(沒啟動?)`, ["`miyoria up` 啟動"]));
      continue;
    }
    if (!res.ok) {
      findings.push(fail(what, `${l.health} 回應 ${res.status}`));
      continue;
    }
    let version: string | null = null;
    try {
      const body: unknown = await res.json();
      if (isJsonObject(body) && typeof body.version === "string") version = body.version;
      if (isJsonObject(body) && (body.smart_turn === false || body.silero === false)) {
        const missing = [
          body.smart_turn === false ? "smart_turn" : null,
          body.silero === false ? "silero" : null,
        ];
        findings.push(
          warn(what, `${l.health} 在跑,但 ${missing.filter(Boolean).join("、")} 模型沒載入`, [
            "看 /health 的 errors,多半是模型檔不在;`miyoria doctor --fix` 下載後重啟",
          ]),
        );
        continue;
      }
    } catch {
      // health without a JSON body is fine
    }
    if (l.health.endsWith("/api/health") && version && version !== input.deps.version) {
      findings.push(
        warn(what, `執行中的 core 是 ${version},這份 CLI 是 ${input.deps.version}`, [
          "重啟 core 讓它用新版(`miyoria update` 之後要重啟)",
        ]),
      );
    } else findings.push(ok(what, version ? `正常(版本 ${version})` : "正常"));
  }
  return findings;
}

/** The services' `gpu` the way the daemon reads it: `host.toml`'s policy wins. */
function gpuOf(input: HostCheckInput, entry: CatalogEntry) {
  const gpu = entry.descriptor.gpu;
  if (gpu === undefined) return null;
  return {
    policy: input.host.config.services[entry.name]?.gpu?.policy ?? gpu.policy,
    resident: gpu.vram_mb?.resident ?? 0,
  };
}

/**
 * The card's budget: what the services keep loaded (pinned, evictable and reserved memory), and the
 * moment an on-demand service works, when the evictable ones give theirs up. Against the card's
 * total minus `[gpu] reserve_mb`, with 8% headroom.
 */
export async function vramChecks(input: HostCheckInput): Promise<Finding[]> {
  const gpus = input.entries
    .map((entry) => ({ entry, gpu: gpuOf(input, entry) }))
    .filter(
      (s): s is { entry: CatalogEntry; gpu: NonNullable<ReturnType<typeof gpuOf>> } =>
        s.gpu !== null,
    );
  const smi = await input.deps.run(
    "nvidia-smi",
    ["--query-gpu=name,memory.total,memory.used", "--format=csv,noheader,nounits"],
    { timeoutMs: 15_000 },
  );
  if (smi.missing || smi.code !== 0) {
    return [warn("顯存", "沒有 nvidia-smi,略過顯存預算(沒有 NVIDIA 顯卡就不需要)")];
  }
  const [gpuName, total, used] = (smi.stdout.split(/\r?\n/)[0] ?? "")
    .split(",")
    .map((s) => s.trim());
  const totalMb = Number(total);
  const usedMb = Number(used);
  if (!Number.isFinite(totalMb)) return [warn("顯存", "讀不到 nvidia-smi 的輸出")];
  const head = `${gpuName}:${usedMb} / ${totalMb} MB 已用`;
  if (gpus.length === 0) return [ok("顯存", head)];

  const reserve = input.host.config.gpu.reserve_mb;
  const available = totalMb - reserve;
  const sum = (policies: readonly string[]) =>
    gpus.filter((s) => policies.includes(s.gpu.policy)).reduce((n, s) => n + s.gpu.resident, 0);
  let peak = sum(["pinned", "evictable", "reserve"]);
  let peakWhy = "常駐的服務都載入時";
  const pinned = sum(["pinned", "reserve"]);
  for (const s of gpus) {
    if (s.gpu.policy !== "on_demand") continue;
    const during = s.gpu.resident + pinned;
    if (during > peak) {
      peak = during;
      peakWhy = `${s.entry.name} 工作時(可卸下的先卸下)`;
    }
  }
  const detail = `${head};保留 ${reserve} MB;估計尖峰 ${peak} MB(${peakWhy};各服務的估計值在 service.toml 的 [gpu] vram_mb)`;
  if (peak > available * 0.92) {
    return [
      warn("顯存預算", `${detail},超過 ${available} MB 的 92%`, [
        "把 host.toml 的 [services.<名字>.gpu] policy 改成 evictable / on_demand,或改用較小的模型(ASR_QWEN_SIZE=0.6B)",
      ]),
    ];
  }
  return [ok("顯存預算", detail)];
}
