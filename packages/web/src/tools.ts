// Model tools `web_search` and `web_fetch`, over DeepSeek's Search and Fetch API. The pages are
// fetched on DeepSeek's side, so a url cannot reach anything on this machine's network. What
// comes back is written by strangers: it goes to the model in a data block, and the tools are
// `outside`, so the rest of the turn cannot act on it.

import type { Tool, ToolContext, ToolSpec } from "@miyoria/tools";
import { dataBlock, isJsonObject, type JsonValue } from "@miyoria/types";
import { z } from "zod";
import type { WebConfig } from "./config.js";

export const WEB_SEARCH = "web_search";
export const WEB_FETCH = "web_fetch";

/** Limits of the API. */
const MAX_QUERY_CHARS = 128;
const MAX_URL_CHARS = 8192;

/** Room for the marks and labels of the data block around a result. */
const BLOCK_CHARS = 64;

const REFUSED: Readonly<Record<number, string>> = {
  401: "the API key was refused",
  402: "no balance left on the API account",
  403: "this page is blocked by the search provider",
  404: "no readable content at this url",
  429: "too many requests, try again later",
};

const SearchResponse = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      summary: z.string().nullish(),
      snippet: z.string().nullish(),
      date: z.string().nullish(),
    }),
  ),
});

const FetchResponse = z.object({ title: z.string(), content: z.string() });

async function post<T>(
  cfg: WebConfig,
  name: string,
  body: JsonValue,
  schema: z.ZodType<T>,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(`${cfg.base_url.replace(/\/+$/, "")}/v1/tools/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(REFUSED[response.status] ?? `the web API answered HTTP ${response.status}`);
  }
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error("unexpected answer from the web API");
  return parsed.data;
}

function clip(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}…` : text;
}

function text(args: JsonValue, key: string): string {
  const value = isJsonObject(args) ? args[key] : undefined;
  return typeof value === "string" ? value.trim() : "";
}

function httpUrl(raw: string): boolean {
  if (raw.length > MAX_URL_CHARS || !URL.canParse(raw)) return false;
  const url = new URL(raw);
  return /^https?:$/.test(url.protocol) && url.username === "" && url.password === "";
}

export class WebSearchTool implements Tool {
  readonly spec: ToolSpec = {
    name: WEB_SEARCH,
    description:
      "上網搜尋。遇到你不知道、不確定或可能過時的事(新聞、最近發生的事、要查證的事實)就查,不要亂編。可以用 site:、lang:zh、after:2026-01-01 這些語法。查過之後這一回合只能再用網路工具,想記下來或做別的事要等下一回合。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: `搜尋關鍵字,最多 ${MAX_QUERY_CHARS} 字` },
      },
      required: ["query"],
    },
  };
  readonly outside = true;
  readonly maxResultChars: number;
  readonly #cfg: WebConfig;

  constructor(cfg: WebConfig) {
    this.#cfg = cfg;
    this.maxResultChars = cfg.max_result_chars + BLOCK_CHARS;
  }

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    const query = text(args, "query");
    if (query === "") throw new Error("`query` is required");
    if ([...query].length > MAX_QUERY_CHARS) {
      throw new Error(`\`query\` is longer than ${MAX_QUERY_CHARS} characters`);
    }
    const { results } = await post(
      this.#cfg,
      "search",
      { query, count: this.#cfg.results },
      SearchResponse,
      ctx.signal,
    );
    if (results.length === 0) return "沒有結果。";
    const lines = results.map((r, i) => {
      const date = r.date ? `(${r.date.slice(0, 10)})` : "";
      return `${i + 1}. ${r.title}${date}\n${r.url}\n${r.summary || r.snippet || ""}`.trim();
    });
    return dataBlock(
      WEB_SEARCH,
      "網路搜尋結果",
      clip(lines.join("\n\n"), this.#cfg.max_result_chars),
    );
  }
}

export class WebFetchTool implements Tool {
  readonly spec: ToolSpec = {
    name: WEB_FETCH,
    description:
      "讀一個網頁的內容。搜尋結果的摘要不夠,或別人貼網址給你時用。讀過之後這一回合只能再用網路工具,想記下來或做別的事要等下一回合。",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "完整的 http(s) 網址" } },
      required: ["url"],
    },
  };
  readonly outside = true;
  readonly maxResultChars: number;
  readonly #cfg: WebConfig;

  constructor(cfg: WebConfig) {
    this.#cfg = cfg;
    this.maxResultChars = cfg.max_result_chars + BLOCK_CHARS;
  }

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    const url = text(args, "url");
    if (!httpUrl(url)) throw new Error("`url` must be an http(s) address without a login");
    const page = await post(this.#cfg, "fetch", { url }, FetchResponse, ctx.signal);
    const body = `${page.title}\n${url}\n\n${page.content}`.trim();
    return dataBlock(WEB_FETCH, "網頁內容", clip(body, this.#cfg.max_result_chars));
  }
}
