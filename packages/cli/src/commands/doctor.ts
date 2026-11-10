// `miyoria doctor`: checks everything needed to run, one line per check.

import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { databaseUrl, loadProfile, resolveDatabaseUrl } from "@miyoria/core/light";
import { Config, configureLogging, errorMessage } from "@miyoria/kernel";
import { cliVersion } from "../assets.js";
import { type DeepDeps, deepChecks, type Finding } from "../stack/checks.js";
import { repoRoot, stackConfig } from "../stack/config.js";
import { roleChecks } from "../stack/role-checks.js";
import { describeMachine, machineConfig } from "../stack/roles.js";
import { defaultRunner, probePort, tcpConnect } from "../stack/system.js";
import { dim, green, println, red, yellow } from "../ui.js";

/** Discord application flags for the message content intent. */
const GATEWAY_MESSAGE_CONTENT = 1 << 18;
const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;
const GATEWAY_PRESENCE = 1 << 12;
const GATEWAY_PRESENCE_LIMITED = 1 << 13;
const GATEWAY_GUILD_MEMBERS = 1 << 14;
const GATEWAY_GUILD_MEMBERS_LIMITED = 1 << 15;

export class DoctorError extends Error {
  override readonly name = "DoctorError";
}

export interface DoctorOptions {
  /** Also check the install: ports, builds, JDK, worker config, VRAM, temp files. */
  deep?: boolean;
  /** Only the install checks; no LLM, Discord or database round trips. Implies `deep`. */
  stackOnly?: boolean;
  /** Replaces the system seams in tests. */
  deps?: DeepDeps;
}

function realDeps(): DeepDeps {
  return {
    platform: process.platform,
    run: defaultRunner,
    probe: probePort,
    fetchImpl: fetch,
    env: process.env,
    tmpdir: tmpdir(),
    version: cliVersion(),
    connect: tcpConnect,
  };
}

function printFinding(f: Finding): void {
  const mark = f.level === "ok" ? green("✓") : f.level === "warn" ? yellow("!") : red("✗");
  println(`${mark} ${f.what}  ${f.detail}`);
  for (const line of f.fix ?? []) println(dim(`    修正:${line}`));
}

function stackInput(config: Config, configPath: string, deps: DeepDeps) {
  return {
    config,
    configDir: dirname(configPath),
    root: repoRoot(configPath),
    stack: stackConfig(config),
    deps,
  };
}

/** What this computer's roles need (packages, venvs, model files, addresses); returns how many failed. */
async function roleReport(config: Config, configPath: string, deps: DeepDeps): Promise<number> {
  const input = stackInput(config, configPath, deps);
  if (input.stack.machine === null) return 0;
  println(`\n這台電腦的角色:${describeMachine(input.stack.machine)}`);
  const findings = await roleChecks(input);
  for (const f of findings) printFinding(f);
  return findings.filter((f) => f.level === "fail").length;
}

/** Prints the deep findings; returns how many failed. */
async function deepReport(config: Config, configPath: string, deps: DeepDeps): Promise<number> {
  println(`\n部署檢查(只讀,不會改 Windows、防火牆或防毒設定)`);
  const findings = await deepChecks(stackInput(config, configPath, deps));
  for (const f of findings) printFinding(f);
  return (
    findings.filter((f) => f.level === "fail").length + (await roleReport(config, configPath, deps))
  );
}

export async function run(configPath: string, options: DoctorOptions = {}): Promise<void> {
  // The checks print their own lines; module logs would only interleave with them.
  if (!process.env.MIYORIA_LOG_LEVEL) configureLogging({ level: "warn" });
  let failures = 0;
  const report = (ok: boolean, what: string, detail: string) => {
    if (!ok) failures++;
    println(`${ok ? green("✓") : red("✗")} ${what}  ${detail}`);
  };
  const baseDir = dirname(configPath);

  let config: Config;
  try {
    config = await Config.load(configPath);
    report(true, "設定檔", configPath);
  } catch (error) {
    report(false, "設定檔", `${errorMessage(error)}(先執行 \`miyoria init\`)`);
    throw new DoctorError("無法繼續檢查");
  }

  const deps = options.deps ?? realDeps();
  if (options.stackOnly) {
    failures += await deepReport(config, configPath, deps);
    if (failures > 0) throw new DoctorError(`${failures} 項檢查失敗`);
    println(`\n部署檢查通過`);
    return;
  }

  // A computer that does not run core has no LLM, Discord or database to check.
  const machine = machineConfig(config);
  if (machine !== null && !machine.services.includes("core")) {
    failures += options.deep
      ? await deepReport(config, configPath, deps)
      : await roleReport(config, configPath, deps);
    if (failures > 0) throw new DoctorError(`${failures} 項檢查失敗`);
    println("\n這台電腦需要的都齊了");
    return;
  }

  let profile: Awaited<ReturnType<typeof loadProfile>> | null = null;
  try {
    profile = await loadProfile(config, baseDir);
    report(true, "角色", `${profile.displayName}(${profile.sections.length} 個人格段落)`);
  } catch (error) {
    report(false, "角色", errorMessage(error));
  }

  // The full core (every module package) is only loaded for the checks that need it.
  const core = await import("@miyoria/core");
  const { collectResponse, modelRefString, userMessage } = await import("@miyoria/llm");

  if (profile) {
    try {
      const router = core.llmModule(config, profile).buildRouter();
      const chain = router.chain("chat");
      const started = performance.now();
      const stream = await router.stream(
        "chat",
        { messages: [userMessage("請只回答 OK")], max_tokens: 16 },
        AbortSignal.timeout(60_000),
      );
      const response = await collectResponse(stream);
      const first = chain[0] ? modelRefString(chain[0]) : "";
      report(
        true,
        "LLM",
        `${first} 回應「${response.text.trim()}」,${Math.round(performance.now() - started)} ms`,
      );
    } catch (error) {
      report(false, "LLM", errorMessage(error));
    }
  }

  const discord = config.module("platform.discord.bot");
  const section = discord.config;
  const token =
    section !== null &&
    typeof section === "object" &&
    !Array.isArray(section) &&
    typeof section.token === "string"
      ? section.token
      : "";
  if (!discord.enabled) report(true, "Discord", "已停用");
  else if (token === "") report(false, "Discord", "沒有設定 DISCORD_BOT_TOKEN");
  else {
    try {
      report(true, "Discord", await checkDiscord(token, fetch, wantsPresence(section)));
    } catch (error) {
      report(false, "Discord", errorMessage(error));
    }
  }

  const url = resolveDatabaseUrl(databaseUrl(config), baseDir);
  try {
    const store = await core.openStore(url);
    await store.close();
    report(true, "資料庫", redactUrl(url));
  } catch (error) {
    report(false, "資料庫", `${redactUrl(url)}:${errorMessage(error)}`);
  }

  failures += options.deep
    ? await deepReport(config, configPath, deps)
    : await roleReport(config, configPath, deps);

  if (failures > 0) throw new DoctorError(`${failures} 項檢查失敗`);
  println("\n全部正常!");
}

/**
 * `presenceIntents`: the bot asks for Presence and Server Members too (`presence_intents`, on by
 * default); Discord refuses the connection when they are not switched on in the Developer Portal.
 */
export async function checkDiscord(
  token: string,
  fetchImpl: typeof fetch = fetch,
  presenceIntents = false,
): Promise<string> {
  const response = await fetchImpl("https://discord.com/api/v10/applications/@me", {
    headers: { authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new DoctorError(`Discord API 回應 ${response.status}(token 錯了嗎?)`);
  const app = (await response.json()) as {
    name?: string;
    bot?: { username?: string };
    flags?: number;
  };
  const name = app.bot?.username ?? app.name ?? "?";
  const flags = app.flags ?? 0;
  if ((flags & (GATEWAY_MESSAGE_CONTENT | GATEWAY_MESSAGE_CONTENT_LIMITED)) === 0) {
    throw new DoctorError(
      `bot \`${name}\` 沒有開啟 Message Content Intent(Developer Portal → Bot → Privileged Gateway Intents)`,
    );
  }
  if (presenceIntents) {
    const missing = [
      (flags & (GATEWAY_PRESENCE | GATEWAY_PRESENCE_LIMITED)) === 0 ? "Presence Intent" : null,
      (flags & (GATEWAY_GUILD_MEMBERS | GATEWAY_GUILD_MEMBERS_LIMITED)) === 0
        ? "Server Members Intent"
        : null,
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new DoctorError(
        `bot \`${name}\` 沒有開啟 ${missing.join("、")}(Developer Portal → Bot → Privileged Gateway Intents);或 \`miyoria config set modules."platform.discord.bot".presence_intents false\` 不要這兩項,Discord 會拒絕連線`,
      );
    }
  }
  return `bot \`${name}\``;
}

function wantsPresence(section: unknown): boolean {
  return !(
    section !== null &&
    typeof section === "object" &&
    !Array.isArray(section) &&
    (section as { presence_intents?: unknown }).presence_intents === false
  );
}

export function redactUrl(url: string): string {
  const scheme = url.indexOf("://");
  const at = url.lastIndexOf("@");
  return scheme !== -1 && at > scheme ? `${url.slice(0, scheme)}://***${url.slice(at)}` : url;
}
