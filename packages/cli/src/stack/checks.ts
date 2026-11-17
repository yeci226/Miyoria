// `miyoria doctor --deep`: the install problems met on 2026-11-07, each as a finding with a fix.
// Read-only: it reports Windows port reservations and antivirus effects and never changes system,
// firewall or antivirus settings. What each service needs comes from its descriptor
// (`host-checks.ts`); this file holds the findings that are not about one service.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PortProbe } from "@miyoria/hostd";
import type { Config } from "@miyoria/runtime/kernel";
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
import { inRanges, parseDynamicPort, parseExcludedRanges, type Runner } from "./system.js";

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

export interface Listener {
  label: string;
  host: string;
  port: number;
  /** URL answering 200 when the service is ours and running. */
  health?: string;
  /**
   * Whether hostd says this is its own running service: `true` ours, `false` hostd runs and this
   * service is not running (an answering port is somebody else's), `undefined` hostd is not
   * running (the health URL decides).
   */
  ours?: boolean;
}

export async function ping(fetchImpl: typeof fetch, url: string): Promise<Response | null> {
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

/** One finding per listener: free, ours, foreign, or denied by Windows (with the WinNAT hint). */
export async function portChecks(
  input: Pick<DeepInput, "deps">,
  listeners: readonly Listener[],
): Promise<Finding[]> {
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
  for (const l of listeners) {
    const range = inRanges(l.port, ranges);
    const state = await deps.probe(l.port, l.host);
    const name = `埠 ${l.port}(${l.label})`;
    if (state === "denied" || (range && state !== "in-use")) {
      const where = range
        ? `落在 Windows 保留範圍 ${range.start}-${range.end}`
        : "Windows 拒絕綁定";
      findings.push(fail(name, `${where},服務會綁不上(EACCES),但沒有程式在用`, WINNAT_FIX));
    } else if (state === "in-use") {
      const res = l.ours === undefined && l.health ? await ping(deps.fetchImpl, l.health) : null;
      if (l.ours === true || res?.ok) findings.push(ok(name, "已有 Miyoria 服務在聽"));
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
