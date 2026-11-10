// Command line: a small declarative parser with Traditional Chinese help (legacy clap setup).

import { loadDotenv } from "@miyoria/kernel";
import { cliVersion } from "./assets.js";
import * as configCmd from "./commands/config.js";
import * as discordCmd from "./commands/discord.js";
import * as doctor from "./commands/doctor.js";
import * as init from "./commands/init.js";
import * as install from "./commands/install.js";
import * as nodeCmd from "./commands/node.js";
import * as remote from "./commands/remote.js";
import * as start from "./commands/start.js";
import * as up from "./commands/up.js";
import * as update from "./commands/update.js";
import { captureProcessEnv } from "./process-env.js";
import {
  ClackPrompter,
  DefaultsPrompter,
  isCancelled,
  isInteractive,
  NotTtyError,
  type Prompter,
} from "./prompt.js";
import { bold, dim, fail, plainReporter, println, warn } from "./ui.js";

export interface OptionSpec {
  name: string;
  short?: string;
  /** Takes a value shown as `<value>` in the help. */
  value?: string;
  help: string;
  default?: string;
}

export interface ArgSpec {
  name: string;
  help: string;
  optional?: boolean;
  variadic?: boolean;
}

export interface RunContext {
  /** `--config` */
  config: string;
  /** `--yes` */
  yes: boolean;
  options: Record<string, string | boolean | undefined>;
  args: string[];
}

export interface CommandSpec {
  name: string;
  help: string;
  options?: OptionSpec[];
  args?: ArgSpec[];
  subcommands?: CommandSpec[];
  /** Unknown `-x` / `--x` tokens are positional values (`config set k -1`). */
  allowHyphenValues?: boolean;
  /** Options that cannot be combined with the positional `args`. */
  conflicts?: [string, string];
  run?: (ctx: RunContext) => Promise<void>;
}

export class UsageError extends Error {
  override readonly name = "UsageError";

  constructor(
    message: string,
    readonly command: CommandSpec[],
  ) {
    super(message);
  }
}

const GLOBAL_OPTIONS: OptionSpec[] = [
  {
    name: "config",
    short: "c",
    value: "PATH",
    help: "miyoria.toml 的路徑",
    default: "miyoria.toml",
  },
  { name: "yes", short: "y", help: "跳過所有確認,直接寫入 / 套用" },
  { name: "help", short: "h", help: "顯示說明" },
];
const VERSION_OPTION: OptionSpec = { name: "version", short: "V", help: "顯示版本" };

function interactivePrompter(): Prompter {
  return new ClackPrompter();
}

function str(ctx: RunContext, name: string): string | undefined {
  const v = ctx.options[name];
  return typeof v === "string" ? v : undefined;
}

function flag(ctx: RunContext, name: string): boolean {
  return ctx.options[name] === true;
}

async function remoteClient(ctx: RunContext) {
  return remote.clientFor(await nodeCmd.loadConfig(ctx.config));
}

/** Aborted on Ctrl+C (for streaming commands). */
function interruptSignal(): AbortSignal {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  return controller.signal;
}

export const COMMANDS: CommandSpec = {
  name: "miyoria",
  help: "Miyoria — AI waifu 框架",
  subcommands: [
    {
      name: "init",
      help: "設定精靈:這台電腦跑哪些服務、LLM、Discord、資料庫、面板登入;可重複執行,Enter 保留現值",
      options: [
        {
          name: "roles",
          value: "LIST",
          help: "這台電腦跑什麼:all、broadcast、core、inference(可逗號分隔),或服務名稱(asr,tts,...);省略 = 互動選擇",
        },
        { name: "core-host", value: "HOST", help: "跑 core 那台電腦的區網位址(預設 127.0.0.1)" },
        {
          name: "inference-host",
          value: "HOST",
          help: "跑 asr / tts / sing 那台電腦的區網位址(預設 127.0.0.1)",
        },
      ],
      run: async (ctx) => {
        let p: Prompter;
        if (isInteractive()) p = interactivePrompter();
        else if (ctx.yes) p = new DefaultsPrompter(plainReporter);
        else {
          throw new NotTtyError(
            "在腳本裡請用 `miyoria init --yes`(全部採用預設值),或 `miyoria config set <key> <value>`",
          );
        }
        const roles = str(ctx, "roles");
        const coreHost = str(ctx, "core-host");
        const inferenceHost = str(ctx, "inference-host");
        await init.run(ctx.config, p, {
          yes: ctx.yes,
          ...(isInteractive()
            ? {
                offerInstall: () =>
                  install.run(
                    ctx.config,
                    { targets: [] },
                    install.defaultInstallDeps(async (m) => interactivePrompter().confirm(m, true)),
                  ),
              }
            : {}),
          machine: {
            ask: isInteractive(),
            ...(roles !== undefined ? { roles } : {}),
            ...(coreHost !== undefined ? { coreHost } : {}),
            ...(inferenceHost !== undefined ? { inferenceHost } : {}),
          },
        });
      },
    },
    {
      name: "config",
      help: "修改設定(不帶子指令時開互動選單,一次改一項)",
      run: (ctx) => configCmd.menu(ctx.config, interactivePrompter(), ctx.yes),
      subcommands: [
        {
          name: "list",
          help: "列出所有設定和實際值(密碼遮蔽,標示哪些來自 .env)",
          options: [{ name: "reveal", help: "顯示密碼原文" }],
          run: async (ctx) => configCmd.list(ctx.config, flag(ctx, "reveal")),
        },
        {
          name: "get",
          help: "顯示一個設定的實際值,例如 `core.profile`",
          args: [
            {
              name: "key",
              help: "以點分隔的鍵,例如 modules.api.bind 或 'modules.\"voice.link\".bind'",
              optional: true,
            },
          ],
          options: [
            { name: "env", value: "NAME", help: "改讀 .env 的變數" },
            { name: "reveal", help: "顯示密碼原文" },
          ],
          conflicts: ["env", "key"],
          run: async (ctx) =>
            configCmd.get(ctx.config, ctx.args[0], str(ctx, "env"), flag(ctx, "reveal")),
        },
        {
          name: "set",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: help text names the ${VAR} syntax
          help: "設定一個值,例如 `set core.log debug`;引用 ${VAR} 的鍵會改寫 .env",
          args: [
            {
              name: "KEY 值",
              help: '<key> <值>(值用 TOML 解析:3、true、["a"];其他當字串)',
              variadic: true,
            },
          ],
          options: [
            { name: "env", value: "NAME", help: "改寫 .env 的變數:`set --env LLM_API_KEY sk-...`" },
          ],
          allowHyphenValues: true,
          run: (ctx) => configCmd.set(ctx.config, ctx.args, str(ctx, "env"), ctx.yes),
        },
        {
          name: "unset",
          help: "刪除一個設定(或 `--env NAME` 刪除 .env 變數)",
          args: [{ name: "key", help: "以點分隔的鍵", optional: true }],
          options: [{ name: "env", value: "NAME", help: "刪除 .env 的變數" }],
          conflicts: ["env", "key"],
          run: (ctx) => configCmd.unset(ctx.config, ctx.args[0], str(ctx, "env"), ctx.yes),
        },
        {
          name: "edit",
          help: "用編輯器開啟 miyoria.toml($VISUAL / $EDITOR,Windows 預設記事本)",
          run: (ctx) => configCmd.edit(ctx.config, ctx.yes),
        },
      ],
    },
    {
      name: "doctor",
      help: "檢查設定檔、角色、LLM、Discord 和資料庫連線;--deep 加查埠、建置、JDK、worker 設定和顯存",
      options: [
        {
          name: "deep",
          help: "加查部署:Windows 保留埠、dist / mod jar 是否過期、JDK 21、worker 設定一致、顯存、暫存檔、服務健康",
        },
        { name: "deep-only", help: "只做 --deep 的部署檢查(不連 LLM、Discord、資料庫)" },
      ],
      run: (ctx) =>
        doctor.run(ctx.config, { deep: flag(ctx, "deep"), stackOnly: flag(ctx, "deep-only") }),
    },
    {
      name: "install",
      help: "安裝這台電腦需要的東西:node 套件和建置、每個 worker 的 venv 與 pip,最後列出還要手動下載的",
      args: [
        {
          name: "target",
          help: "角色(broadcast、core、inference)、all 或服務名稱;省略 = [machine] 設定的",
          optional: true,
          variadic: true,
        },
      ],
      options: [{ name: "dry-run", help: "只列出會做的事" }],
      run: (ctx) =>
        install.run(
          ctx.config,
          { targets: ctx.args, dryRun: flag(ctx, "dry-run") },
          install.defaultInstallDeps(async (message) => {
            if (ctx.yes) return true;
            if (!isInteractive()) return false;
            return interactivePrompter().confirm(message, true);
          }),
        ),
    },
    {
      name: "start",
      help: "每個服務開一個 Windows Terminal 分頁(可看可關);已在執行的不會重複啟動,不會自動重啟",
      args: [
        {
          name: "target",
          help: "角色(broadcast、core、inference)、all 或服務名稱;省略 = [machine] 設定的",
          optional: true,
          variadic: true,
        },
      ],
      options: [
        { name: "dry-run", help: "只列出會啟動什麼、哪些會略過,不啟動" },
        { name: "no-wait", help: "開完分頁就繼續下一個,不等健康檢查" },
        { name: "no-check", help: "略過啟動前的套件、venv、設定檢查" },
        {
          name: "timeout",
          value: "SECS",
          help: "每個服務等健康檢查的秒數(預設 [stack] start_timeout_secs)",
        },
      ],
      run: (ctx) => {
        const timeout = str(ctx, "timeout");
        const timeoutSecs = timeout === undefined ? undefined : Number.parseInt(timeout, 10);
        if (timeoutSecs !== undefined && !(timeoutSecs > 0))
          throw new Error("--timeout 要是正整數(秒)");
        return start.run(ctx.config, {
          targets: ctx.args,
          dryRun: flag(ctx, "dry-run"),
          noWait: flag(ctx, "no-wait"),
          noCheck: flag(ctx, "no-check"),
          ...(timeoutSecs !== undefined ? { timeoutSecs } : {}),
        });
      },
    },
    {
      name: "up",
      help: "依序啟動整組服務(worker、core、voice node、stage)並檢查健康;Ctrl+C 停止這次啟動的服務",
      options: [
        { name: "only", value: "LIST", help: "只啟動這些服務(逗號分隔,例如 asr,core)" },
        { name: "skip", value: "LIST", help: "不啟動這些服務" },
        {
          name: "timeout",
          value: "SECS",
          help: "每個服務等健康檢查的秒數(預設用 [stack] start_timeout_secs)",
        },
        { name: "dry-run", help: "只列出啟動順序和指令,不啟動" },
        { name: "no-check", help: "略過啟動前的 worker 設定和建置檢查" },
      ],
      run: (ctx) => {
        const list = (name: string) =>
          str(ctx, name)
            ?.split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        const timeout = str(ctx, "timeout");
        const timeoutSecs = timeout === undefined ? undefined : Number.parseInt(timeout, 10);
        if (timeoutSecs !== undefined && !(timeoutSecs > 0))
          throw new Error("--timeout 要是正整數(秒)");
        return up.run(ctx.config, {
          only: list("only"),
          skip: list("skip"),
          timeoutSecs,
          dryRun: flag(ctx, "dry-run"),
          noCheck: flag(ctx, "no-check"),
        });
      },
    },
    {
      name: "update",
      help: "git pull、安裝相依套件,只重建有變的:SDK、擴充 dist、面板、overlay、Minecraft mod jar",
      options: [
        { name: "no-pull", help: "不執行 git pull" },
        { name: "force", help: "不論有沒有變都全部重建" },
        { name: "skip-mod", help: "不建置也不安裝 Minecraft mod" },
        { name: "dry-run", help: "只列出會做的事" },
      ],
      run: (ctx) =>
        update.run(
          ctx.config,
          {
            noPull: flag(ctx, "no-pull"),
            force: flag(ctx, "force"),
            skipMod: flag(ctx, "skip-mod"),
            dryRun: flag(ctx, "dry-run"),
          },
          update.defaultUpdateDeps(async (message) => {
            if (ctx.yes) return true;
            if (!isInteractive()) return false;
            return interactivePrompter().confirm(message, false);
          }),
        ),
    },
    {
      name: "core",
      help: "啟動 core 節點(Discord bot、agent ...)",
      run: (ctx) => nodeCmd.core(ctx.config),
    },
    {
      name: "stage",
      help: "在直播機啟動 stage 節點(VTube Studio、OBS、overlay)",
      run: (ctx) => nodeCmd.stage(ctx.config),
      subcommands: [
        {
          name: "obs-setup",
          help: "在 OBS 建好 Miyoria 的場景和來源(背景、唱歌版面、透明立繪、overlay)",
          options: [
            { name: "dry-run", help: "只列出會做的事,不改 OBS" },
            { name: "relayout", help: "已經有的項目也重新擺回預設位置" },
          ],
          run: (ctx) =>
            nodeCmd.stageObsSetup(ctx.config, flag(ctx, "dry-run"), flag(ctx, "relayout")),
        },
      ],
    },
    {
      name: "chat",
      help: "在終端機跟她聊天(不需要 Discord)",
      options: [
        { name: "name", value: "NAME", help: "你在對話裡的名字", default: "你" },
        { name: "with-discord", help: "聊天時也連上 Discord bot" },
      ],
      run: (ctx) => nodeCmd.chat(ctx.config, str(ctx, "name") ?? "你", flag(ctx, "with-discord")),
    },
    {
      name: "status",
      help: "執行中 core 的狀態:模組和 LLM 用量",
      run: async (ctx) => remote.status(await remoteClient(ctx)),
    },
    {
      name: "module",
      help: "管理執行中 core 的模組",
      subcommands: [
        {
          name: "list",
          help: "列出模組(core 沒在執行時顯示設定檔內容)",
          run: async (ctx) => {
            const config = await nodeCmd.loadConfig(ctx.config);
            try {
              const client = remote.clientFor(config);
              if (await remote.isRunning(client)) {
                await remote.modules(client);
                return;
              }
            } catch {
              // no token: show the config file
            }
            println("(core 沒有在執行,顯示設定檔內容)");
            const { configuredModules } = await import("@miyoria/core/light");
            for (const [id, enabled] of configuredModules(config))
              println(`${enabled ? "●" : "○"} ${id}`);
          },
        },
        ...(["enable", "disable", "restart"] as const).map(
          (action): CommandSpec => ({
            name: action,
            help: { enable: "啟用模組", disable: "停用模組", restart: "重新啟動模組" }[action],
            args: [{ name: "id", help: "模組 id" }],
            run: async (ctx) =>
              remote.moduleAction(await remoteClient(ctx), ctx.args[0] as string, action),
          }),
        ),
      ],
    },
    {
      name: "decisions",
      help: "最近的注意力決策(她為什麼回話或保持安靜)",
      options: [{ name: "limit", short: "l", value: "N", help: "顯示幾筆", default: "20" }],
      run: async (ctx) => {
        const limit = Number.parseInt(str(ctx, "limit") ?? "20", 10);
        if (!Number.isFinite(limit) || limit <= 0) throw new Error("--limit 要是正整數");
        await remote.decisions(await remoteClient(ctx), limit);
      },
    },
    {
      name: "events",
      help: "即時追蹤 core 的事件,例如 `miyoria events 'agent.*'`",
      args: [
        {
          name: "topics",
          help: "事件主題(可用萬用字元,省略 = 全部)",
          optional: true,
          variadic: true,
        },
      ],
      run: async (ctx) => remote.events(await remoteClient(ctx), ctx.args, interruptSignal()),
    },
    {
      name: "persona",
      help: "執行中 core 的人格段落",
      subcommands: [
        {
          name: "show",
          help: "顯示所有人格段落",
          run: async (ctx) => remote.personaShow(await remoteClient(ctx)),
        },
        {
          name: "set",
          help: "用檔案內容取代一個段落(`-` 代表 stdin)",
          args: [
            { name: "key", help: "段落名稱" },
            { name: "file", help: "檔案路徑或 `-`" },
          ],
          allowHyphenValues: true,
          run: async (ctx) => {
            const client = await remoteClient(ctx);
            const body = await nodeCmd.readInput(ctx.args[1] as string);
            await remote.personaSet(client, ctx.args[0] as string, body.trim());
          },
        },
      ],
    },
    {
      name: "profile",
      help: "角色工具(離線)",
      subcommands: [
        {
          name: "validate",
          help: "載入並檢查目前的角色",
          run: (ctx) => nodeCmd.profileValidate(ctx.config),
        },
      ],
    },
    {
      name: "discord",
      help: "Discord bot 工具",
      subcommands: [
        {
          name: "commands",
          help: "斜線指令",
          subcommands: [
            {
              name: "reset",
              help: "刪除 bot 在全域與所有伺服器的斜線指令（清掉重複的舊指令，core 下次啟動會重新註冊）",
              run: (ctx) =>
                discordCmd.commandsReset(
                  ctx.config,
                  isInteractive() ? interactivePrompter() : null,
                  ctx.yes,
                ),
            },
          ],
        },
      ],
    },
    {
      name: "ext",
      help: "擴充套件(離線工具,`dev` 會以熱重載啟動 core)",
      subcommands: [
        {
          name: "new",
          help: "建立 TypeScript 擴充套件骨架",
          args: [{ name: "name", help: "套件名稱" }],
          options: [{ name: "dir", value: "DIR", help: "上層資料夾", default: "extensions" }],
          run: (ctx) => nodeCmd.extNew(ctx.args[0] as string, str(ctx, "dir") ?? "extensions"),
        },
        { name: "list", help: "列出找到的擴充套件", run: (ctx) => nodeCmd.extList(ctx.config) },
        {
          name: "install",
          help: "從本機路徑或 git URL 安裝",
          args: [{ name: "source", help: "路徑或 git URL" }],
          run: (ctx) => nodeCmd.extInstall(ctx.config, ctx.args[0] as string),
        },
        {
          name: "validate",
          help: "檢查擴充套件的 manifest",
          args: [{ name: "dir", help: "擴充套件資料夾" }],
          run: async (ctx) => nodeCmd.extValidate(ctx.args[0] as string),
        },
        {
          name: "dev",
          help: "以擴充套件熱重載啟動 core",
          run: (ctx) => nodeCmd.extDev(ctx.config),
        },
      ],
    },
  ],
};

// ---- parsing -----------------------------------------------------------------------------

export interface Parsed {
  path: CommandSpec[];
  ctx: RunContext;
  help: boolean;
  version: boolean;
}

function optionsOf(path: CommandSpec[]): OptionSpec[] {
  const cmd = path.at(-1) as CommandSpec;
  return [
    ...(cmd.options ?? []),
    ...GLOBAL_OPTIONS,
    ...(path.length === 1 ? [VERSION_OPTION] : []),
  ];
}

export function parseArgs(argv: readonly string[], root: CommandSpec = COMMANDS): Parsed {
  const path: CommandSpec[] = [root];
  const options: Record<string, string | boolean | undefined> = {};
  const args: string[] = [];
  const cmd = () => path.at(-1) as CommandSpec;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i] as string;
    if (t === "--") {
      args.push(...argv.slice(i + 1));
      break;
    }
    const isLong = t.startsWith("--") && t.length > 2;
    const isShort = !isLong && /^-[A-Za-z]$/.test(t);
    if (isLong || isShort) {
      const [rawName, inline] = isLong
        ? ((eq) => (eq === -1 ? [t.slice(2), undefined] : [t.slice(2, eq), t.slice(eq + 1)]))(
            t.indexOf("="),
          )
        : [t.slice(1), undefined];
      const spec = optionsOf(path).find((o) => (isLong ? o.name === rawName : o.short === rawName));
      if (!spec) {
        if (cmd().allowHyphenValues) {
          args.push(t);
          continue;
        }
        throw new UsageError(`未知的選項 \`${t}\``, [...path]);
      }
      if (spec.value !== undefined) {
        const value = inline ?? argv[++i];
        if (value === undefined)
          throw new UsageError(`\`${t}\` 需要一個值 <${spec.value}>`, [...path]);
        options[spec.name] = value;
      } else {
        options[spec.name] = true;
      }
      continue;
    }
    const sub = args.length === 0 ? cmd().subcommands?.find((s) => s.name === t) : undefined;
    if (sub) path.push(sub);
    else args.push(t);
  }
  const target = cmd();
  for (const o of optionsOf(path)) {
    if (options[o.name] === undefined && o.default !== undefined) options[o.name] = o.default;
  }
  return {
    path,
    help: options.help === true,
    version: options.version === true,
    ctx: {
      config: (options.config as string | undefined) ?? "miyoria.toml",
      yes: options.yes === true,
      options,
      args: target.run || target.args ? args : args,
    },
  };
}

/** Checks positional arguments against the command's spec. */
export function checkArgs(path: CommandSpec[], ctx: RunContext): void {
  const cmd = path.at(-1) as CommandSpec;
  const specs = cmd.args ?? [];
  const given = ctx.args;
  if (specs.length === 0 && given.length > 0) {
    const what = cmd.subcommands ? "未知的指令" : "多了參數";
    throw new UsageError(`${what} \`${given[0]}\``, path);
  }
  const variadic = specs.some((a) => a.variadic);
  const required = specs.filter((a) => !a.optional).length;
  if (given.length < required) {
    const missing = specs[given.length] as ArgSpec;
    throw new UsageError(`缺少參數 <${missing.name}>`, path);
  }
  if (!variadic && given.length > specs.length) {
    throw new UsageError(`多了參數 \`${given[specs.length]}\``, path);
  }
  if (cmd.conflicts) {
    const [option, arg] = cmd.conflicts;
    if (ctx.options[option] !== undefined && given.length > 0) {
      throw new UsageError(`--${option} 不能和 <${arg}> 一起用`, path);
    }
  }
}

// ---- help --------------------------------------------------------------------------------

function optionLabel(o: OptionSpec): string {
  const short = o.short ? `-${o.short}, ` : "    ";
  return `${short}--${o.name}${o.value ? ` <${o.value}>` : ""}`;
}

export function helpText(path: CommandSpec[]): string {
  const cmd = path.at(-1) as CommandSpec;
  const name = path.map((c) => c.name).join(" ");
  const lines: string[] = [cmd.help, ""];
  const argsUsage = (cmd.args ?? [])
    .map((a) => {
      const inner = `<${a.name}>${a.variadic ? "..." : ""}`;
      return a.optional ? `[${inner}]` : inner;
    })
    .join(" ");
  const sub = cmd.subcommands ? (cmd.run ? " [指令]" : " <指令>") : "";
  lines.push(`${bold("用法:")}${name} [選項]${sub}${argsUsage ? ` ${argsUsage}` : ""}`);
  const table = (title: string, rows: Array<[string, string]>) => {
    if (rows.length === 0) return;
    const width = Math.max(...rows.map(([l]) => l.length)) + 2;
    lines.push("", bold(title));
    for (const [l, h] of rows) lines.push(`  ${l.padEnd(width)}${h}`);
  };
  table(
    "指令:",
    (cmd.subcommands ?? []).map((s) => [s.name, s.help]),
  );
  table(
    "參數:",
    (cmd.args ?? []).map((a) => [`<${a.name}>`, a.help]),
  );
  table(
    "選項:",
    optionsOf(path).map((o) => [
      optionLabel(o),
      o.default !== undefined ? `${o.help} ${dim(`[預設:${o.default}]`)}` : o.help,
    ]),
  );
  return lines.join("\n");
}

// ---- main --------------------------------------------------------------------------------

/** Runs the CLI; resolves to the exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
    if (parsed.help) {
      println(helpText(parsed.path));
      return 0;
    }
    if (parsed.version) {
      println(`miyoria ${cliVersion()}`);
      return 0;
    }
    const cmd = parsed.path.at(-1) as CommandSpec;
    if (!cmd.run) {
      if (parsed.ctx.args.length > 0)
        throw new UsageError(`未知的指令 \`${parsed.ctx.args[0]}\``, parsed.path);
      println(helpText(parsed.path));
      return parsed.path.length === 1 ? 0 : 2;
    }
    checkArgs(parsed.path, parsed.ctx);
  } catch (error) {
    if (error instanceof UsageError) {
      fail(error.message);
      println(`\n${helpText(error.command)}`);
      return 2;
    }
    throw error;
  }

  captureProcessEnv();
  loadDotenv(parsed.ctx.config);
  try {
    await (parsed.path.at(-1) as CommandSpec).run?.(parsed.ctx);
    return 0;
  } catch (error) {
    if (isCancelled(error)) {
      warn("已取消,沒有寫入任何檔案");
      return 130;
    }
    fail(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
