// `miyoria discord commands reset`: deletes every slash command of the bot (globally and in
// every server it is in). Use it once to remove duplicates left from earlier global / guild
// mode runs; `miyoria core` registers the current set again when it starts.

import type { Config } from "@miyoria/runtime/kernel";
import type { Prompter } from "../prompt.js";
import { bold, dim, fail, ok, println, warn } from "../ui.js";
import { loadConfig } from "./node.js";

const API = "https://discord.com/api/v10";

export class DiscordCommandError extends Error {
  override readonly name = "DiscordCommandError";
}

/** The bot token from `[modules."platform.discord.bot"] token` (after `${VAR}` expansion). */
export function botToken(config: Config): string {
  const section = config.module("platform.discord.bot").config;
  const token =
    section !== null &&
    typeof section === "object" &&
    !Array.isArray(section) &&
    typeof section.token === "string"
      ? section.token.trim()
      : "";
  if (token === "")
    throw new DiscordCommandError("沒有設定 Discord bot token（DISCORD_BOT_TOKEN）");
  return token;
}

/** A tiny Discord REST client: JSON in and out, waits out rate limits. */
export class DiscordApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request(method: "GET" | "PUT", route: `/${string}`, body?: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchImpl(`${API}${route}`, {
        method,
        headers: {
          authorization: `Bot ${this.token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 429 && attempt < 5) {
        const info = (await response.json().catch(() => ({}))) as { retry_after?: number };
        await new Promise((resolve) => setTimeout(resolve, (info.retry_after ?? 1) * 1000 + 50));
        continue;
      }
      if (!response.ok) {
        throw new DiscordCommandError(`Discord API ${method} ${route} 回應 ${response.status}`);
      }
      return response.status === 204 ? null : response.json();
    }
  }

  put(route: `/${string}`, options?: { body?: unknown }): Promise<unknown> {
    return this.request("PUT", route, options?.body);
  }

  async applicationId(): Promise<string> {
    const app = (await this.request("GET", "/applications/@me")) as { id?: string };
    if (!app.id) throw new DiscordCommandError("Discord 沒有回傳 application id");
    return app.id;
  }

  /** Every server the bot is in (paged, 200 at a time). */
  async guildIds(): Promise<string[]> {
    const out: string[] = [];
    let after = "0";
    for (;;) {
      const page = (await this.request("GET", `/users/@me/guilds?limit=200&after=${after}`)) as {
        id: string;
      }[];
      out.push(...page.map((g) => g.id));
      const last = page.at(-1);
      if (page.length < 200 || !last) return out;
      after = last.id;
    }
  }
}

/** `miyoria discord commands reset`. */
export async function commandsReset(
  configPath: string,
  p: Prompter | null,
  yes: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const config = await loadConfig(configPath);
  const api = new DiscordApi(botToken(config), fetchImpl);
  const appId = await api.applicationId();
  const guilds = await api.guildIds();
  println(
    `將刪除 bot 的所有斜線指令：全域，以及 ${guilds.length} 個伺服器的伺服器指令。` +
      dim("（下次啟動 miyoria core 時會重新註冊）"),
  );
  if (!yes) {
    if (!p) throw new DiscordCommandError("非互動環境請加上 --yes");
    if (!(await p.confirm("確定要刪除嗎？", false))) {
      println("已取消。");
      return;
    }
  }
  const { resetCommands } = await import("@miyoria/discord");
  const report = await resetCommands(api, appId, guilds);
  ok(`已清除 ${report.cleared.length} 個範圍的指令`);
  for (const f of report.failed) {
    warn(`${f.scope === "global" ? "全域" : `伺服器 ${f.scope}`}：${f.error}`);
  }
  if (report.failed.length > 0) fail("部分範圍清除失敗（可能是 bot 已被移出該伺服器）");
  println(bold("重新啟動 miyoria core 就會註冊目前的指令。"));
}
