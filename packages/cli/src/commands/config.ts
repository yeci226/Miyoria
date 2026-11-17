// `miyoria config`: an interactive menu to change one area at a time, plus `list` / `get` /
// `set` / `unset` / `edit` for scripts.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { configuredModules } from "@miyoria/core/light";
import { Config } from "@miyoria/runtime/kernel";
import {
  isCancelled,
  isInteractive,
  NotTtyError,
  type Prompter,
  type Reporter,
} from "../prompt.js";
import { display, isSecret, mask, maskUrl, type Source, singleRef, sourceLabel } from "../refs.js";
import * as settings from "../settings.js";
import { type Field, tomlField } from "../settings.js";
import {
  formatKey,
  getIn,
  isTable,
  leaves,
  parseKey,
  parseValue,
  showValue,
  TomlDocument,
} from "../toml-patch.js";
import { bold, dim, eprintln, green, plainReporter, println, red, yellow } from "../ui.js";
import * as validate from "../validate.js";
import { type Change, diffToml, renderChange, type Target, Workspace } from "../workspace.js";
import { clientFor, isRunning, moduleAction } from "./remote.js";

export class ConfigCommandError extends Error {
  override readonly name = "ConfigCommandError";
}

// ---- writing -----------------------------------------------------------------------------

export function changeLines(ws: Workspace, changes: readonly Change[]): string[] {
  const lines: string[] = [];
  for (const path of ws.missingFiles()) lines.push(`${green("+")} 建立 ${ws.shown(path)}`);
  for (const target of ["toml", "env", "profile"] as Target[]) {
    const group = changes.filter((c) => c.target === target);
    if (group.length === 0) continue;
    const path = ws.pathOf(target);
    if (path !== undefined) lines.push(bold(ws.shown(path)));
    for (const c of group) {
      const line = renderChange(c);
      const colored = c.old === null ? green(line) : c.new === null ? red(line) : yellow(line);
      lines.push(`  ${colored}`);
    }
  }
  return lines;
}

/** A file besides the workspace's own (`init` writes `host.toml`): shown, confirmed and written with it. */
export interface ExtraWrite {
  /** Lines of the summary; none = nothing to write. */
  lines: string[];
  /** Writes it; returns what to report as written. */
  save(): string[];
}

/**
 * Shows what will change, asks (unless `yes`) and writes. `null` when nothing was written.
 * `ws` is `null` when only `extra` is written.
 */
export async function commit(
  p: Prompter,
  yes: boolean,
  ws: Workspace | null,
  extra?: ExtraWrite,
): Promise<Change[] | null> {
  for (const w of ws?.warnings.splice(0) ?? []) p.warn(w);
  const changes = ws?.changes() ?? [];
  const extraLines = extra?.lines ?? [];
  if (changes.length === 0 && (ws?.missingFiles().length ?? 0) === 0 && extraLines.length === 0) {
    p.note("沒有變更");
    return null;
  }
  p.box("將變更", [...(ws ? changeLines(ws, changes) : []), ...extraLines]);
  if (!yes && !(await p.confirm("寫入這些變更?", true))) {
    p.warn("沒有寫入任何檔案");
    return null;
  }
  for (const path of ws?.save() ?? []) p.ok(`已寫入 ${ws?.shown(path)}`);
  for (const path of extra?.save() ?? []) p.ok(`已寫入 ${path}`);
  return changes;
}

/** Writes without asking (for `config set` / `unset`). */
function writeNow(r: Reporter, ws: Workspace): Change[] {
  for (const w of ws.warnings.splice(0)) r.warn(w);
  const changes = ws.changes();
  if (changes.length === 0) {
    r.note("沒有變更");
    return changes;
  }
  for (const line of changeLines(ws, changes)) println(`  ${line}`);
  for (const path of ws.save()) r.ok(`已寫入 ${ws.shown(path)}`);
  return changes;
}

/** The part of the system a config key belongs to. */
function areaOf(path: readonly string[]): string {
  const first = path[0];
  if (first === "modules") return path[1] ?? "modules";
  if (first === "stage") return "stage 節點";
  return first ?? "";
}

/** `[module enable/disable toggles, other affected areas]`. */
export function classify(
  ws: Workspace,
  changes: readonly Change[],
): [Array<[string, boolean]>, string[]] {
  const toggles: Array<[string, boolean]> = [];
  const areas = new Set<string>();
  for (const c of changes) {
    if (c.target === "toml") {
      let path: string[];
      try {
        path = parseKey(c.key);
      } catch {
        continue;
      }
      if (path.length === 3 && path[0] === "modules" && path[2] === "enabled") {
        toggles.push([path[1] as string, c.new !== "false"]);
      } else {
        areas.add(areaOf(path));
      }
    } else if (c.target === "env") {
      for (const key of ws.references(c.key)) {
        try {
          areas.add(areaOf(parseKey(key)));
        } catch {
          // unreachable: keys come from the document
        }
      }
    } else {
      areas.add("角色(profile)");
    }
  }
  const toggled = new Set(toggles.map(([id]) => id));
  const sorted = [...areas].filter((a) => !toggled.has(a)).sort();
  return [toggles, sorted];
}

/** The config as the core would see it, with `.env` values from the workspace. */
export function workspaceConfig(ws: Workspace): Config {
  return Config.fromToml(ws.doc.toString(), (name) => ws.lookup(name)?.[0] ?? "");
}

/**
 * After writing: tells what needs a restart and, if a core is running, offers to apply module
 * toggles through the Admin API.
 */
export async function afterWrite(
  p: Prompter | null,
  yes: boolean,
  ws: Workspace,
  changes: readonly Change[],
): Promise<void> {
  const r: Reporter = p ?? plainReporter;
  const [toggles, areas] = classify(ws, changes);
  if (toggles.length === 0 && areas.length === 0) return;
  let client: ReturnType<typeof clientFor>;
  try {
    client = clientFor(workspaceConfig(ws));
  } catch {
    r.note("core 沒有在執行;下次啟動時就會套用。");
    return;
  }
  if (!(await isRunning(client))) {
    r.note("core 沒有在執行;下次啟動時就會套用。");
    return;
  }
  if (toggles.length > 0) {
    const list = toggles.map(([id, on]) => `${on ? "啟用 " : "停用 "}${id}`).join("、");
    const apply =
      yes || (p !== null && (await p.confirm(`core 正在執行,要現在套用(${list})嗎?`, true)));
    if (apply) {
      for (const [id, on] of toggles) {
        try {
          await moduleAction(client, id, on ? "enable" : "disable");
        } catch (error) {
          r.fail(`${id}:${(error as Error).message}`);
        }
      }
    } else {
      r.note("core 正在執行:用 `miyoria module enable|disable <id>` 立即套用");
    }
  }
  if (areas.length > 0) {
    r.warn(
      `core 正在執行。模組設定在 core 啟動時讀取,這些變更要重啟 core 才會生效:${areas.join("、")}`,
    );
    r.note(
      "在執行 core 的視窗按 Ctrl+C,再執行 `miyoria core`(Stage 節點則重新執行 `miyoria stage`)",
    );
  }
}

// ---- interactive menu --------------------------------------------------------------------

export type Area =
  | "profile"
  | "llm"
  | "discord"
  | "oauth"
  | "voice"
  | "stage"
  | "database"
  | "owner"
  | "tokens"
  | "modules"
  | "done";

const AREAS: readonly Area[] = [
  "profile",
  "llm",
  "discord",
  "oauth",
  "voice",
  "stage",
  "database",
  "owner",
  "tokens",
  "modules",
  "done",
];

function isSet(ws: Workspace, field: Field): boolean {
  return settings.current(ws, field).value !== "";
}

function areaLabel(area: Area, ws: Workspace): string {
  const set = (b: boolean) => (b ? "已設定" : "未設定");
  let name: string;
  let status = "";
  switch (area) {
    case "profile":
      name = "角色(profile)";
      status = settings.current(ws, settings.PROFILE).value;
      break;
    case "llm":
      name = "LLM";
      status = settings.llmSummary(ws);
      break;
    case "discord":
      name = "Discord bot";
      status = `token ${set(isSet(ws, settings.DISCORD_TOKEN))}`;
      break;
    case "oauth":
      name = "面板登入(Discord OAuth)";
      status = settings.oauthReady(ws) ? "已開啟" : "未設定";
      break;
    case "voice":
      name = "語音(ASR / TTS worker、voice link)";
      break;
    case "stage":
      name = "Stage(VTube Studio / OBS)";
      break;
    case "database":
      name = "資料庫";
      status = maskUrl(settings.current(ws, settings.DATABASE).value);
      break;
    case "owner": {
      name = "擁有者";
      const v = settings.current(ws, settings.OWNER).value;
      status = v === "" ? "未設定" : v;
      break;
    }
    case "tokens": {
      name = "Tokens(重新產生)";
      const n = settings.TOKENS.filter(([v]) => (ws.lookup(v)?.[0] ?? "") !== "").length;
      status = `${n}/${settings.TOKENS.length} 已設定`;
      break;
    }
    case "modules": {
      name = "模組開關";
      try {
        const mods = configuredModules(workspaceConfig(ws));
        status = `${mods.filter(([, on]) => on).length}/${mods.length} 啟用`;
      } catch {
        status = "";
      }
      break;
    }
    case "done":
      name = "完成";
      break;
  }
  return status === "" ? name : `${name}  · ${status}`;
}

async function modulesArea(p: Prompter, ws: Workspace): Promise<void> {
  const mods = configuredModules(workspaceConfig(ws));
  const labels = mods.map(([id]) => id);
  const defaults = mods.flatMap(([, on], i) => (on ? [i] : []));
  const picked = await p.multiSelect("啟用哪些模組?(空白鍵切換)", labels, defaults);
  mods.forEach(([id, was], i) => {
    const now = picked.includes(i);
    if (now === was) return;
    const key = `modules.${formatKey([id])}.enabled`;
    if (now) ws.unset(key);
    else ws.set(key, false);
  });
}

async function tokensArea(p: Prompter, ws: Workspace): Promise<void> {
  const labels = settings.TOKENS.map(([v, , what]) => {
    const isSetNow = (ws.lookup(v)?.[0] ?? "") !== "";
    return `${v}  ${what}  [${isSetNow ? "已設定" : "未設定"}]`;
  });
  const picked = settings.TOKENS[await p.select("重新產生哪一個 token?", labels, 0)];
  if (!picked) return;
  const [variable] = picked;
  p.warn(`重新產生 ${variable} 後,用舊 token 的連線會失效`);
  ws.setEnv(variable, settings.newToken());
  p.note(`要給其他節點用時:miyoria config get --env ${variable} --reveal`);
}

export async function runArea(area: Area, p: Prompter, ws: Workspace): Promise<void> {
  switch (area) {
    case "profile":
      await settings.profileStep(p, ws);
      return;
    case "llm":
      await settings.llmStep(p, ws, true);
      return;
    case "discord":
      await settings.editFields(p, ws, [settings.DISCORD_TOKEN, settings.DISCORD_GUILDS]);
      return;
    case "oauth":
      await settings.oauthStep(p, ws, false);
      return;
    case "voice":
      await settings.editFields(p, ws, settings.VOICE);
      p.note("voice link token 在「Tokens」項目");
      return;
    case "stage":
      await settings.editFields(p, ws, settings.STAGE);
      return;
    case "database":
      await settings.databaseStep(p, ws);
      return;
    case "owner":
      await settings.ask(p, ws, settings.OWNER);
      if (ws.references("MIYORIA_OWNER_ID").length === 0) {
        p.warn("miyoria.toml 沒有引用 MIYORIA_OWNER_ID([modules.commands] 的 owners)");
      }
      return;
    case "tokens":
      await tokensArea(p, ws);
      return;
    case "modules":
      await modulesArea(p, ws);
      return;
    case "done":
      return;
  }
}

export async function menu(configPath: string, p: Prompter, yes: boolean): Promise<void> {
  let ws = Workspace.open(configPath);
  if (!isInteractive()) throw new NotTtyError();
  // The answers are checked by the root schema, which loads every module package: start now.
  void validate.configSchema();
  p.intro("Miyoria 設定");
  p.note("選一個項目修改,只會動到你選的欄位。Esc 返回,選「完成」離開。");
  let cursor = 0;
  for (;;) {
    const labels = AREAS.map((a) => areaLabel(a, ws));
    let pick: number;
    try {
      pick = await p.select("要設定哪一項?", labels, cursor);
    } catch (error) {
      if (isCancelled(error)) break;
      throw error;
    }
    cursor = pick;
    const area = AREAS[pick] ?? "done";
    if (area === "done") break;
    try {
      await runArea(area, p, ws);
    } catch (error) {
      if (isCancelled(error)) {
        p.warn("已取消這一項,沒有寫入");
        ws = Workspace.open(configPath);
        continue;
      }
      throw error;
    }
    let changes: Change[] | null;
    try {
      changes = await commit(p, yes, ws);
    } catch (error) {
      if (!isCancelled(error)) throw error;
      changes = null;
      p.warn("沒有寫入任何檔案");
    }
    if (changes) await afterWrite(p, yes, ws, changes);
    else ws = Workspace.open(configPath);
  }
  p.outro("設定完成");
}

// ---- scripting commands ------------------------------------------------------------------

function sources(used: ReadonlyArray<[string, Source]>): string {
  return used.map(([v, src]) => `${v}: ${sourceLabel(src)}`).join(", ");
}

export function list(configPath: string, reveal: boolean): void {
  const ws = Workspace.open(configPath);
  println(bold(ws.shown(configPath)));
  const referenced = new Set<string>();
  for (const leaf of leaves(ws.doc.data)) {
    const key = formatKey(leaf.path);
    const last = leaf.path.at(-1) ?? "";
    const raw = showValue(leaf.value);
    const v = leaf.value;
    if (typeof v === "string" && v.includes("${")) {
      const [value, used] = ws.resolve(v);
      const secret = isSecret(last) || used.some(([name]) => isSecret(name));
      for (const [name] of used) referenced.add(name);
      const shown = secret && !reveal ? mask(value) : display("", value, reveal);
      println(`${key} = ${raw}  ${dim("→")} ${shown}  ${dim(`[${sources(used)}]`)}`);
    } else if (typeof v === "string" && isSecret(last) && !reveal) {
      println(`${key} = "${mask(v)}"  ${yellow("(明文;建議改放 .env)")}`);
    } else if (typeof v === "string" && !reveal && v.includes("@")) {
      println(`${key} = "${maskUrl(v)}"`);
    } else if (Array.isArray(v) && raw.includes("${")) {
      const used: Array<[string, Source]> = [];
      const resolved = v.map((item) => {
        if (typeof item !== "string") return showValue(item);
        const [value, u] = ws.resolve(item);
        used.push(...u);
        return value;
      });
      for (const [name] of used) referenced.add(name);
      println(
        `${key} = ${raw}  ${dim("→")} [${resolved.join(", ")}]  ${dim(`[${sources(used)}]`)}`,
      );
    } else {
      println(`${key} = ${raw}`);
    }
  }
  const env = ws.env.entries();
  if (env.length > 0) {
    println(`\n${bold(ws.shown(ws.envPath))}`);
    for (const [name, value] of env) {
      const note = referenced.has(name) ? "" : `  ${dim("(miyoria.toml 沒有引用)")}`;
      println(`${name} = ${display(name, value, reveal)}${note}`);
    }
  }
}

export function get(
  configPath: string,
  key: string | undefined,
  env: string | undefined,
  reveal: boolean,
): void {
  const ws = Workspace.open(configPath);
  if (env !== undefined) {
    const found = ws.lookup(env);
    if (!found) throw new ConfigCommandError(`${env} 沒有設定`);
    println(display(env, found[0], reveal));
    eprintln(dim(`(來源:${sourceLabel(found[1])})`));
    return;
  }
  if (key === undefined) {
    throw new ConfigCommandError("要指定 key,例如 `miyoria config get core.profile`");
  }
  const path = parseKey(key);
  const item = getIn(ws.doc.data, path);
  if (item === undefined) {
    throw new ConfigCommandError(`miyoria.toml 沒有 \`${key}\`(\`miyoria config list\` 看全部)`);
  }
  const last = path.at(-1) ?? "";
  if (isTable(item)) {
    for (const leaf of leaves(item)) {
      println(`${formatKey([...path, ...leaf.path])} = ${showValue(leaf.value)}`);
    }
    return;
  }
  if (typeof item !== "string") {
    println(showValue(item));
    return;
  }
  const [resolved, used] = ws.resolve(item);
  const secret = isSecret(last) || used.some(([name]) => isSecret(name));
  println(secret && !reveal ? mask(resolved) : display("", resolved, reveal));
  if (used.length > 0) eprintln(dim(`(miyoria.toml:${showValue(item)};${sources(used)})`));
}

/** `.env` variable name for a new secret key: `stage.obs.password` → `STAGE_OBS_PASSWORD`. */
export function envNameFor(path: readonly string[]): string {
  return path
    .filter((s) => s !== "modules")
    .map((s) => s.replace(/[^A-Za-z0-9]/g, "_").toUpperCase())
    .join("_");
}

export async function set(
  configPath: string,
  args: readonly string[],
  env: string | undefined,
  yes: boolean,
): Promise<void> {
  const ws = Workspace.open(configPath);
  const r = plainReporter;
  if (env !== undefined) {
    if (args.length !== 1) throw new ConfigCommandError("用法:miyoria config set --env NAME <值>");
    const err = validate.envName(env);
    if (err) throw new ConfigCommandError(err);
    ws.setEnv(env, args[0] as string);
    if (ws.references(env).length === 0) r.warn(`miyoria.toml 沒有引用 \${${env}}`);
  } else {
    if (args.length !== 2) throw new ConfigCommandError("用法:miyoria config set <key> <值>");
    const [key, value] = args as [string, string];
    const path = parseKey(key);
    const shown = formatKey(path);
    const existing = getIn(ws.doc.data, path);
    if (isTable(existing)) {
      throw new ConfigCommandError(`\`${shown}\` 是表格;要指定其中的鍵,例如 \`${shown}.enabled\``);
    }
    const reference = typeof existing === "string" ? singleRef(existing)?.name : undefined;
    const last = path.at(-1) ?? "";
    if (reference !== undefined && !value.includes("${")) {
      // Keep `${VAR}` in miyoria.toml; the value goes to .env.
      ws.setEnv(reference, value);
      r.note(`${shown} 引用 \${${reference}},改寫 .env 的 ${reference}`);
    } else if (isSecret(last) && !value.includes("${")) {
      const known = settings
        .allFields()
        .find((f) => f.key !== null && formatKey(parseKey(f.key)) === shown);
      const variable = known?.env ?? envNameFor(path);
      settings.apply(ws, tomlField("", shown, { type: "secret" }, { env: variable }), value);
      r.note(`密碼類的值放在 .env 的 ${variable},miyoria.toml 引用它`);
    } else {
      const parsed = parseValue(value);
      const ctx = await validate.schemaContext(ws.doc.data);
      const err = validate.valueForKey(path, parsed, ctx);
      if (err) throw new ConfigCommandError(`\`${shown}\`:${err}`);
      ws.doc.set(path, parsed);
    }
  }
  const changes = writeNow(r, ws);
  await afterWrite(null, yes, ws, changes);
}

export async function unset(
  configPath: string,
  key: string | undefined,
  env: string | undefined,
  yes: boolean,
): Promise<void> {
  const ws = Workspace.open(configPath);
  if (key === undefined && env !== undefined) {
    if (!ws.env.unset(env)) throw new ConfigCommandError(`.env 沒有 ${env}`);
  } else if (key !== undefined && env === undefined) {
    if (!ws.unset(key)) throw new ConfigCommandError(`miyoria.toml 沒有 \`${key}\``);
  } else {
    throw new ConfigCommandError(
      "用法:miyoria config unset <key>  或  miyoria config unset --env NAME",
    );
  }
  const changes = writeNow(plainReporter, ws);
  await afterWrite(null, yes, ws, changes);
}

/** `[program, args]` from `$VISUAL` / `$EDITOR` (Windows: Notepad, else vi). */
export function editorCommand(env: NodeJS.ProcessEnv = process.env): [string, string[]] {
  const editor = [env.VISUAL, env.EDITOR].find((e) => e !== undefined && e.trim() !== "");
  if (editor === undefined) return [process.platform === "win32" ? "notepad" : "vi", []];
  // `EDITOR="code -w"` style values carry arguments; a plain path may have spaces.
  if (existsSync(editor)) return [editor, []];
  const [program, ...args] = editor.trim().split(/\s+/);
  return [program ?? "notepad", args];
}

export async function edit(configPath: string, yes: boolean): Promise<void> {
  const before = Workspace.open(configPath);
  const [program, args] = editorCommand();
  plainReporter.note(`用 ${program} 開啟 ${before.shown(configPath)}(關掉編輯器後繼續)`);
  const result = spawnSync(program, [...args, configPath], {
    stdio: "inherit",
    shell: process.platform === "win32" && !existsSync(program),
  });
  if (result.error) {
    throw new ConfigCommandError(
      `無法啟動編輯器 \`${program}\`:${result.error.message}(設定 EDITOR 環境變數)`,
    );
  }
  if (result.status !== 0) throw new ConfigCommandError(`編輯器結束時回報錯誤(${result.status})`);
  const text = readFileSync(configPath, "utf8");
  let doc: TomlDocument;
  try {
    doc = TomlDocument.parse(text);
  } catch (error) {
    throw new ConfigCommandError(
      `${configPath} 不是合法的 TOML,請再執行 \`miyoria config edit\` 修正:\n${(error as Error).message}`,
    );
  }
  const changes = diffToml(before.doc.toString(), doc.data, "toml");
  if (changes.length === 0) {
    plainReporter.note("沒有變更");
    return;
  }
  const after = Workspace.open(configPath);
  for (const line of changeLines(after, changes)) println(`  ${line}`);
  plainReporter.ok(`${after.shown(configPath)} 格式正確`);
  await afterWrite(null, yes, after, changes);
}
