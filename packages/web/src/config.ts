import { z } from "zod";

/**
 * `[modules.web]`: she searches the web and reads pages through DeepSeek's Search and Fetch API.
 * Runs only with a `token` (a DeepSeek API key, whichever model she chats with).
 *
 * ```toml
 * [modules.web]
 * token = "${DEEPSEEK_API_KEY:-}"
 * ```
 */
export const WebConfigSchema = z.object({
  token: z.string().default(""),
  base_url: z.url().default("https://api.deepseek.com"),
  /** Results per search (the price does not depend on it). */
  results: z.number().int().min(1).max(50).default(4),
  /** Characters of a search result or a page she gets to read. */
  max_result_chars: z.number().int().positive().default(4000),
});
export type WebConfig = z.output<typeof WebConfigSchema>;
