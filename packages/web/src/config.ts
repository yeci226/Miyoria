import { z } from "zod";

/**
 * `[modules.web]`: her web search (Tavily when a key is set, else DuckDuckGo's HTML endpoint) and page reader.
 *
 * ```toml
 * [modules.web]
 * region = "tw-tzh"
 * read_chars = 12000
 * ```
 */
export const WebConfigSchema = z.object({
  /** DuckDuckGo `kl` (region and language), e.g. `tw-tzh`, `us-en`, `wt-wt`. */
  region: z
    .string()
    .regex(/^[a-z]{2}-[a-z]{2,3}$/)
    .default("tw-tzh"),
  /**
   * Shortest gap between two DuckDuckGo searches: it challenges the third of a quick burst
   * (2026-11-09: two passed, the next six were challenged). Searches wait their turn.
   */
  ddg_gap_ms: z.number().int().min(0).max(60_000).default(4000),
  /** After a challenge DuckDuckGo is left alone this long, so a block is not prolonged. */
  ddg_cooldown_s: z.number().int().min(0).max(86_400).default(600),
  /**
   * Who answers `web_search`. Unset: Tavily when a key is set (`tavily_api_key`, else the
   * `TAVILY_API_KEY` environment variable), DuckDuckGo otherwise. Tavily without a key falls back
   * to DuckDuckGo.
   */
  search_provider: z.enum(["tavily", "duckduckgo"]).optional(),
  /** Tavily API key (`${TAVILY_API_KEY:-}`); never logged. */
  tavily_api_key: z.string().max(500).default(""),
  /** Tavily `search_depth`: `basic`, `fast` and `ultra-fast` cost 1 credit, `advanced` 2. */
  tavily_search_depth: z.enum(["basic", "advanced", "fast", "ultra-fast"]).default("basic"),
  /** Tavily `topic`. */
  tavily_topic: z.enum(["general", "news", "finance"]).default("general"),
  /** Ask Tavily for its short LLM answer and show it above the results. */
  tavily_include_answer: z.boolean().default(false),
  /** Results `web_search` returns when she does not say (she may ask for 1..8). */
  search_results: z.number().int().min(1).max(8).default(5),
  /** Characters of page text `web_read` keeps (v4 plan §4.2: a page, 12,000). */
  read_chars: z.number().int().min(200).max(20_000).default(12_000),
  /**
   * The most characters one `web_read` answer takes, block markers included (§4.2: 12,000).
   * Keep it at or under the agent's `max_tool_result_chars`, or the agent's cut falls inside the
   * block: the agent's own default (4000) allows 4000 until it is raised to match.
   */
  result_chars: z.number().int().min(300).max(20_000).default(12_000),
  /** The most characters one `web_search` answer takes, block markers included. */
  search_chars: z.number().int().min(300).max(20_000).default(3900),
  /** Per request (DuckDuckGo, and each hop of a page). */
  timeout_ms: z.number().int().min(1000).max(60_000).default(10_000),
  /** A page download stops here; what arrived is still read. */
  max_download_bytes: z.number().int().min(10_000).max(10_000_000).default(2_000_000),
  /** Redirects a page may take, each one re-checked. */
  max_redirects: z.number().int().min(0).max(5).default(3),
  /** Ports besides 80 and 443 a page may use. */
  allow_ports: z.array(z.number().int().min(1).max(65_535)).max(20).default([]),
  /** Sent to DuckDuckGo and to every page; honest, no spoofing. The usual crawler form: DuckDuckGo
   * answers a challenge to an agent that calls itself a "bot". */
  user_agent: z
    .string()
    .min(1)
    .max(200)
    .default("Mozilla/5.0 (compatible; Miyoria/0.1; +https://github.com/owenliu0924/Miyoria)"),
  /** The same search or page is answered from memory this long. */
  cache_ttl_s: z.number().int().min(0).max(86_400).default(600),
  cache_entries: z.number().int().min(1).max(1000).default(100),
  /** Rate limits: per person and for everyone, over `window_s`. */
  window_s: z.number().int().min(10).max(86_400).default(600),
  search_per_person: z.number().int().min(1).max(1000).default(6),
  read_per_person: z.number().int().min(1).max(1000).default(10),
  search_global: z.number().int().min(1).max(10_000).default(30),
  read_global: z.number().int().min(1).max(10_000).default(60),
});
export type WebConfig = z.output<typeof WebConfigSchema>;
