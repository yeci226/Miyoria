// Command line: a small declarative parser with Traditional Chinese help.

import { loadDotenv } from "@miyoria/runtime/kernel";
import { cliVersion } from "./assets.js";
import * as autostart from "./commands/autostart.js";
import * as cluster from "./commands/cluster.js";
import * as configCmd from "./commands/config.js";
import * as dbCmd from "./commands/db.js";
import * as discordCmd from "./commands/discord.js";
import * as doctor from "./commands/doctor.js";
import * as host from "./commands/host.js";
import * as init from "./commands/init.js";
import * as memoryCmd from "./commands/memory.js";
import * as migrate from "./commands/migrate.js";
import * as modelsCmd from "./commands/models.js";
import * as nodeCmd from "./commands/node.js";
import * as remote from "./commands/remote.js";
import * as servicesCmd from "./commands/services.js";
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

const HOST_CONFIG_OPTION: OptionSpec = {
  name: "host-config",
  value: "PATH",
  help: "host.toml 的路徑(預設:miyoria.toml 同一個資料夾的 host.toml;它的資料夾就是工作資料夾)",
};
const FORCE_OPTION: OptionSpec = { name: "force", help: "她在唱歌或直播時也照樣停止" };

function hostTargetOf(ctx: RunContext): host.HostTarget {
  return host.hostTarget(ctx.config, str(ctx, "host-config"));
}

/** The installer's confirmation: `--yes` agrees, a script without a terminal refuses. */
function serviceDepsOf(ctx: RunContext): servicesCmd.ServiceDeps {
  return {
    confirm: async (message) => {
      if (ctx.yes) return true;
      if (!isInteractive()) return false;
      return interactivePrompter().confirm(message, false);
    },
  };
}

function autostartDepsOf(ctx: RunContext): autostart.AutostartDeps {
  return autostart.defaultAutostartDeps({
    yes: ctx.yes,
    confirm: isInteractive() ? (message) => interactivePrompter().confirm(message, false) : null,
  });
}

/** `{ [key]: value }` when there is a value; keeps optional properties out of exact types. */
function optionalString<K extends string>(
  key: K,
  value: string | undefined,
): { [P in K]?: string } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: string });
}

/** An integer option; a text that is not one is an error (the range is the command's). */
function integerOption(ctx: RunContext, name: string, fallback: number): number {
  const text = str(ctx, name);
  if (text === undefined) return fallback;
  if (!/^\d+$/.test(text)) throw new Error(`--${name} 要是整數`);
  return Number.parseInt(text, 10);
}

/** `--timeout SECS`, checked. */
function timeoutOf(ctx: RunContext): { timeoutSecs?: number } {
  const timeout = str(ctx, "timeout");
  if (timeout === undefined) return {};
  const timeoutSecs = Number.parseInt(timeout, 10);
  if (!(timeoutSecs > 0)) throw new Error("--timeout 要是正整數(秒)");
  return { timeoutSecs };
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
      help: "設定精靈:先問這台電腦要做什麼(文字聊天、文字加語音,或只提供服務給別台的 Core),再問 LLM、Discord、資料庫、面板登入;可重複執行,Enter 保留現值",
      options: [
        {
          name: "mode",
          value: "MODE",
          help: "這台電腦要做什麼,跳過第一個問題:text(文字聊天,預設)、voice(文字加語音)、service(只提供服務給別台的 Core)",
        },
        {
          name: "services",
          value: "LIST",
          help: "mode 是 service 時這台提供的服務(逗號分隔,例如 asr,tts);省略 = 互動選擇",
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
        const mode = str(ctx, "mode");
        if (mode !== undefined && !(init.INIT_MODES as readonly string[]).includes(mode)) {
          throw new Error(`--mode 要是 ${init.INIT_MODES.join("、")} 其中一個`);
        }
        const services = str(ctx, "services");
        if (services !== undefined && mode !== "service") {
          throw new Error("--services 只能和 --mode service 一起用");
        }
        await init.run(ctx.config, p, {
          yes: ctx.yes,
          ...(mode !== undefined ? { mode: mode as init.InitMode } : {}),
          ...(services !== undefined
            ? {
                services: services
                  .split(",")
                  .map((name) => name.trim())
                  .filter((name) => name !== ""),
              }
            : {}),
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
      help: "檢查設定檔、角色、LLM、Discord、資料庫,和 host.toml 啟用的每個服務(環境、系統程式、檔案、模型、hostd、Core 連線);--deep 加查匯入、埠、健康檢查、顯存、建置和暫存檔;--fix 只做安全的修復",
      options: [
        {
          name: "deep",
          help: "加查:用環境的 Python 匯入 check_imports、Windows 保留埠、服務健康、顯存預算、dist / mod jar 是否過期、JDK 21、暫存檔",
        },
        { name: "deep-only", help: "只做 --deep 的部署檢查(不連 LLM、Discord、資料庫)" },
        {
          name: "fix",
          help: "只做安全的修復:同步缺的或過期的環境、下載缺的 install.files;不裝系統程式、不改任何系統設定",
        },
        HOST_CONFIG_OPTION,
      ],
      run: (ctx) =>
        doctor.run(ctx.config, {
          deep: flag(ctx, "deep"),
          stackOnly: flag(ctx, "deep-only"),
          fix: flag(ctx, "fix"),
          ...optionalString("hostConfig", str(ctx, "host-config")),
          services: serviceDepsOf(ctx),
        }),
    },
    {
      name: "db",
      help: "資料庫的切換工具(離線):檢查檔案、封存停掉的 V4 資料庫、把身分匯入新的資料庫",
      subcommands: [
        {
          name: "import-links",
          help: "把 V4 資料庫裡的人、帳號、handle、隱私和語音同意、紀念卡資料匯入 core.database_url 的資料庫;只讀舊檔,重跑不會重複",
          options: [
            {
              name: "from",
              value: "FILE",
              help: "V4 的資料庫(通常是 db archive 做的 .single.db)",
            },
            { name: "dry-run", help: "只列出會匯入什麼和數量,不寫入" },
          ],
          run: (ctx) =>
            dbCmd.importLinksCommand(ctx.config, {
              from: str(ctx, "from"),
              dryRun: flag(ctx, "dry-run"),
            }),
        },
        {
          name: "archive",
          help: "把停掉的 V4 資料庫(.db、-wal、-shm 一起)搬進 data/archive/,做單一檔案複本並寫下雜湊;不刪任何檔案,中斷後可重跑",
          args: [{ name: "file", help: "要封存的資料庫;省略 = core.database_url", optional: true }],
          options: [{ name: "dry-run", help: "只檢查有沒有被開著並列出會做的事,不搬動" }],
          run: (ctx) =>
            dbCmd.archiveCommand(
              ctx.config,
              { file: ctx.args[0], dryRun: flag(ctx, "dry-run"), yes: ctx.yes },
              isInteractive() ? interactivePrompter() : null,
            ),
        },
        {
          name: "doctor",
          help: "只讀檢查一個資料庫檔:V4 / V5 / 空的、Core 會不會拒絕、遷移、完整性、人數和事件數;V4 另列 import-links 會帶過來的",
          args: [{ name: "file", help: "要檢查的檔案;省略 = core.database_url", optional: true }],
          run: (ctx) => dbCmd.doctorCommand(ctx.config, ctx.args[0]),
        },
      ],
    },
    {
      name: "memory",
      help: "記憶的離線工具:從事件紀錄重建她的記憶(筆記和情節)",
      subcommands: [
        {
          name: "rebuild",
          help: "把事件紀錄裡的聊天重新跑一遍分段整理(用 config 的模型),補寫筆記行和情節;預設只預覽(段落、行數、預估 token 和費用),不呼叫模型。只新增,不刪也不取代任何現有記憶;進度存在資料庫裡,中斷後可繼續",
          args: [{ name: "file", help: "資料庫檔案;省略 = core.database_url", optional: true }],
          options: [
            {
              name: "since",
              value: "DATE",
              help: "只處理這個時間之後的聊天(ISO 日期)",
              default: "2026-11-15",
            },
            { name: "apply", help: "真的開始(會呼叫模型、花錢);不加就只預覽" },
            {
              name: "max-usd",
              value: "USD",
              help: "花到這個金額就停下來,之後可以繼續",
              default: "2",
            },
            { name: "force", help: "資料庫被別的程式開著(例如 Core 正在跑)也照做" },
          ],
          run: (ctx) =>
            memoryCmd.rebuildCommand(ctx.config, {
              file: ctx.args[0],
              since: str(ctx, "since"),
              apply: flag(ctx, "apply"),
              maxUsd: str(ctx, "max-usd"),
              force: flag(ctx, "force"),
            }),
        },
      ],
    },
    {
      name: "add",
      help: "把服務加進這台電腦:寫進 host.toml,用 uv 建好環境、下載缺的檔案,並列出還缺什麼;不給名字就列出目錄",
      args: [
        {
          name: "service",
          help: "服務名稱(asr、tts、sing、turn、lyrics ...)",
          optional: true,
          variadic: true,
        },
      ],
      options: [
        { name: "no-install", help: "只寫進 host.toml,不建環境、不下載" },
        {
          name: "extra",
          value: "NAME",
          help: "要同步的 extras(逗號分隔,例如 sensevoice);寫進 [services.<名字>] extras,只能用在一個服務",
        },
        HOST_CONFIG_OPTION,
      ],
      run: (ctx) => {
        const extra = str(ctx, "extra");
        const extras =
          extra === undefined
            ? undefined
            : extra
                .split(",")
                .map((e) => e.trim())
                .filter((e) => e !== "");
        return servicesCmd.add(
          hostTargetOf(ctx),
          {
            services: ctx.args,
            noInstall: flag(ctx, "no-install"),
            ...(extras !== undefined ? { extras } : {}),
          },
          serviceDepsOf(ctx),
        );
      },
    },
    {
      name: "remove",
      help: "把服務從這台電腦拿掉:停止它、刪掉它的環境(下載的模型留著)、從 host.toml 移除",
      args: [{ name: "service", help: "服務名稱", variadic: true }],
      options: [{ name: "keep-env", help: "保留環境資料夾" }, FORCE_OPTION, HOST_CONFIG_OPTION],
      run: (ctx) =>
        servicesCmd.remove(
          hostTargetOf(ctx),
          { services: ctx.args, keepEnv: flag(ctx, "keep-env"), force: flag(ctx, "force") },
          serviceDepsOf(ctx),
        ),
    },
    {
      name: "models",
      help: "這台電腦的模型:下載、列出、清掉沒人用的",
      subcommands: [
        {
          name: "pull",
          help: "下載服務 service.toml 列的 Hugging Face 模型;省略名字 = host.toml 啟用的全部",
          args: [{ name: "service", help: "服務名稱", optional: true, variadic: true }],
          options: [HOST_CONFIG_OPTION],
          run: (ctx) =>
            modelsCmd.pull(hostTargetOf(ctx), { services: ctx.args }, serviceDepsOf(ctx)),
        },
        {
          name: "ls",
          help: "列出模型資料夾裡的模型、大小,和哪個服務在用",
          options: [HOST_CONFIG_OPTION],
          run: async (ctx) => modelsCmd.ls(hostTargetOf(ctx)),
        },
        {
          name: "gc",
          help: "列出沒有任何啟用的服務用到的模型,確認後刪掉(-y 直接刪)",
          options: [HOST_CONFIG_OPTION],
          run: (ctx) => modelsCmd.gc(hostTargetOf(ctx), { yes: ctx.yes }, serviceDepsOf(ctx)),
        },
      ],
    },
    {
      name: "hostd",
      help: "在這個終端機執行這台電腦的管家 hostd(`up` 會在背景啟動它);Ctrl+C 停止全部服務",
      options: [
        HOST_CONFIG_OPTION,
        {
          name: "start",
          help: "起來後馬上啟動 host.toml 啟用的全部服務(登入時自動啟動用的就是這個;不加則只啟動管家本身)",
        },
      ],
      run: (ctx) => host.hostd(hostTargetOf(ctx), { start: flag(ctx, "start") }),
    },
    {
      name: "up",
      help: "請 hostd 啟動這台電腦的服務(host.toml 啟用的全部,或指定的);hostd 沒在執行時先在背景啟動它",
      args: [
        {
          name: "service",
          help: "服務名稱;省略 = host.toml 啟用的全部",
          optional: true,
          variadic: true,
        },
      ],
      options: [
        HOST_CONFIG_OPTION,
        {
          name: "foreground",
          help: "不經背景的 hostd,直接在這個終端機監管並顯示狀態;Ctrl+C 依相反順序停止全部",
        },
        {
          name: "timeout",
          value: "SECS",
          help: "最多等幾秒(hostd 會繼續啟動,用 status 查看);預設等到每個服務有結果",
        },
        { name: "no-wait", help: "交給 hostd 後就結束,不等健康檢查" },
        {
          name: "no-link",
          help: "Core 起來後,不要自動把這台電腦連到本機的 Core(預設:這台沒有 host.key 也沒有 [cluster] 時會連,等於 `host join --local`)",
        },
      ],
      run: (ctx) => {
        const target = hostTargetOf(ctx);
        return host.up(target, {
          services: ctx.args,
          foreground: flag(ctx, "foreground"),
          noWait: flag(ctx, "no-wait"),
          ...(flag(ctx, "no-link") ? {} : { selfLink: (h) => cluster.selfLink(target, h) }),
          ...timeoutOf(ctx),
        });
      },
    },
    {
      name: "down",
      help: "停止服務;不指定時停止全部並結束 hostd",
      args: [
        {
          name: "service",
          help: "服務名稱;省略 = 全部,並結束 hostd",
          optional: true,
          variadic: true,
        },
      ],
      options: [HOST_CONFIG_OPTION, FORCE_OPTION],
      run: (ctx) => host.down(hostTargetOf(ctx), { services: ctx.args, force: flag(ctx, "force") }),
    },
    {
      name: "restart",
      help: "重新啟動一個服務;她在唱歌或直播時會拒絕,除非加 --force",
      args: [{ name: "service", help: "服務名稱" }],
      options: [
        HOST_CONFIG_OPTION,
        FORCE_OPTION,
        { name: "timeout", value: "SECS", help: "最多等幾秒" },
      ],
      run: (ctx) =>
        host.restart(hostTargetOf(ctx), {
          service: ctx.args[0] as string,
          force: flag(ctx, "force"),
          ...timeoutOf(ctx),
        }),
    },
    {
      name: "status",
      help: "這台電腦的服務(hostd)和執行中 core 的狀態:模組和 LLM 用量;--all 加上 Core 知道的每一台電腦",
      options: [
        HOST_CONFIG_OPTION,
        { name: "all", help: "也列出 Core 裡每一台電腦,和已連線那些的服務(經 Core 的管理 API)" },
      ],
      run: (ctx) =>
        host.status(hostTargetOf(ctx), flag(ctx, "all") ? { hosts: cluster.hostsSection } : {}),
    },
    {
      name: "logs",
      help: "看一個服務的日誌(<state>/logs/<服務>.log)",
      args: [{ name: "service", help: "服務名稱" }],
      options: [
        HOST_CONFIG_OPTION,
        { name: "follow", short: "f", help: "持續顯示新的行,Ctrl+C 結束" },
        { name: "lines", short: "n", value: "N", help: "先顯示最後幾行", default: "100" },
      ],
      run: (ctx) => {
        const lines = Number.parseInt(str(ctx, "lines") ?? "100", 10);
        if (!Number.isInteger(lines) || lines < 0) throw new Error("--lines 要是 0 或正整數");
        return host.logs(hostTargetOf(ctx), {
          service: ctx.args[0] as string,
          follow: flag(ctx, "follow"),
          lines: Math.min(lines, 2000),
          signal: interruptSignal(),
        });
      },
    },
    {
      name: "host",
      help: "這台電腦的設定(host.toml),和電腦之間的連線:加入 Core、邀請、核准、移除",
      subcommands: [
        {
          name: "invite",
          help: "在跑 Core 的電腦上:產生一組邀請碼(一次性、預設 10 分鐘),並印出另一台電腦要執行的 join 指令",
          options: [
            { name: "name", value: "NAME", help: "指定用這組碼加入的電腦的名字" },
            {
              name: "ttl",
              value: "MINUTES",
              help: "邀請碼有效幾分鐘(1 到 10080)",
              default: "10",
            },
          ],
          run: (ctx) =>
            cluster.invite(hostTargetOf(ctx), {
              ...optionalString("name", str(ctx, "name")),
              ttlMinutes: integerOption(ctx, "ttl", 10),
            }),
        },
        {
          name: "join",
          help: "把這台電腦加入一個 Core:用邀請碼(別台電腦),或 --local(Core 跑在這台)",
          args: [
            {
              name: "core-url",
              help: "Core 管理 API 的位址,例如 http://192.168.1.10:7878",
              optional: true,
            },
          ],
          options: [
            HOST_CONFIG_OPTION,
            { name: "code", value: "CODE", help: "`host invite` 給的邀請碼" },
            {
              name: "name",
              value: "NAME",
              help: "這台電腦在 Core 裡的名字(預設:host.toml 的 name,否則作業系統的主機名稱)",
            },
            {
              name: "local",
              help: "Core 跑在這台:不用邀請碼,由管理 API 直接建立並核准這台(能力取自 host.toml 啟用的服務)",
            },
            { name: "force", help: "這台已經有 host.key 時也重新加入" },
          ],
          conflicts: ["local", "core-url"],
          run: (ctx) =>
            cluster.joinHost(hostTargetOf(ctx), {
              ...optionalString("coreUrl", ctx.args[0]),
              ...optionalString("code", str(ctx, "code")),
              ...optionalString("name", str(ctx, "name")),
              local: flag(ctx, "local"),
              force: flag(ctx, "force"),
            }),
        },
        {
          name: "ls",
          help: "列出 Core 知道的電腦:狀態、連線、核准的能力、平台、版本、最後上線",
          run: (ctx) => cluster.ls(hostTargetOf(ctx)),
        },
        {
          name: "approve",
          help: "核准一台電腦使用它的服務;不列能力時,核准它目前回報的全部",
          args: [
            { name: "name", help: "電腦的名字" },
            {
              name: "capability",
              help: "要核准的能力(asr、tts、sing ...)",
              optional: true,
              variadic: true,
            },
          ],
          run: (ctx) =>
            cluster.approve(hostTargetOf(ctx), ctx.args[0] as string, ctx.args.slice(1)),
        },
        {
          name: "remove",
          help: "把一台電腦從 Core 移除:金鑰失效、連線斷開、它的服務不再被使用",
          args: [{ name: "name", help: "電腦的名字" }],
          run: (ctx) =>
            cluster.removeHost(hostTargetOf(ctx), ctx.args[0] as string, {
              yes: ctx.yes,
              confirm: isInteractive()
                ? (message) => interactivePrompter().confirm(message, false)
                : null,
            }),
        },
        {
          name: "autostart",
          help: "這台電腦登入時自動啟動 hostd(再由它啟動 host.toml 啟用的服務):on 登錄、off 取消、status 查看",
          subcommands: [
            {
              name: "on",
              help: "登錄:這個帳號登入時啟動 hostd(Windows:工作排程器的個人工作;Linux:systemd 使用者單元)。會先印出要執行的指令並確認",
              options: [HOST_CONFIG_OPTION],
              run: (ctx) => autostart.autostartOn(hostTargetOf(ctx), autostartDepsOf(ctx)),
            },
            {
              name: "off",
              help: "取消登錄;沒有登錄時什麼也不做",
              options: [HOST_CONFIG_OPTION],
              run: (ctx) => autostart.autostartOff(hostTargetOf(ctx), autostartDepsOf(ctx)),
            },
            {
              name: "status",
              help: "有沒有登錄、執行的指令、hostd 現在有沒有在跑",
              options: [HOST_CONFIG_OPTION],
              run: (ctx) => autostart.autostartStatus(hostTargetOf(ctx), autostartDepsOf(ctx)),
            },
          ],
        },
        {
          name: "migrate",
          help: "從 miyoria.toml 的 [machine] 和 [stack] 寫出 host.toml:沿用現有的 Python 環境、埠和 worker 環境變數",
          options: [
            HOST_CONFIG_OPTION,
            { name: "force", help: "覆寫已經有的 host.toml" },
            { name: "dry-run", help: "只顯示會寫的內容,不寫入" },
          ],
          run: (ctx) =>
            migrate.migrate(hostTargetOf(ctx), {
              force: flag(ctx, "force"),
              dryRun: flag(ctx, "dry-run"),
            }),
        },
      ],
    },
    {
      name: "update",
      help: "git pull(--ff-only)、安裝相依套件、只重建有變的(SDK、擴充 dist、面板、overlay、Minecraft mod jar)、重新同步過期的 Python 環境,並一個一個重啟跑著且有變的服務(她在唱歌或直播的先不動)",
      options: [
        { name: "no-pull", help: "不執行 git pull" },
        { name: "force", help: "不論有沒有變都全部重建" },
        { name: "skip-mod", help: "不建置也不安裝 Minecraft mod" },
        { name: "dry-run", help: "只列出會做的事" },
        { name: "no-restart", help: "同步環境,但不重啟任何服務" },
        HOST_CONFIG_OPTION,
      ],
      run: (ctx) =>
        update.run(
          ctx.config,
          {
            noPull: flag(ctx, "no-pull"),
            force: flag(ctx, "force"),
            skipMod: flag(ctx, "skip-mod"),
            dryRun: flag(ctx, "dry-run"),
            noRestart: flag(ctx, "no-restart"),
            ...optionalString("hostConfig", str(ctx, "host-config")),
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
