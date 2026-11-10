import { z } from "zod";

/**
 * `[modules.web]`: her web search (DuckDuckGo's HTML endpoint) and page reader.
 *
 * ```toml
 * [modules.web]
 * region = "tw-tzh"
 * read_chars = 4000
 * ```
 */
export const WebConfigSchema = z.object({
  /** DuckDuckGo `kl` (region and language), e.g. `tw-tzh`, `us-en`, `wt-wt`. */
  region: z
    .string()
    .regex(/^[a-z]{2}-[a-z]{2,3}$/)
    .default("tw-tzh"),
  /** Results `web_search` returns when she does not say (she may ask for 1..8). */
  search_results: z.number().int().min(1).max(8).default(5),
  /** Characters of page text `web_read` keeps. */
  read_chars: z.number().int().min(200).max(20_000).default(4000),
  /**
   * The most characters one tool answer takes, block markers included. Keep it under the agent's
   * `max_tool_result_chars`, or the cut falls inside the block.
   */
  result_chars: z.number().int().min(300).max(20_000).default(3900),
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
