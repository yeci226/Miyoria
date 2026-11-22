// `[modules.api.files]`: the file origin her share links point at (v5-architecture §11.2).
//
// ```toml
// [modules.api.files]
// origin = "https://files.example.com"   # empty: no links are issued (attachments still work)
// bind = "127.0.0.1:7886"                # the file origin's own listener (the tunnel points here)
// ```
//
// The file origin is a host of its own with no cookies, so a file someone opens there can never
// reach anyone's login. Without an origin nothing listens and no link is made: there is no fallback
// to the panel's origin (owner 2026-11-22).

import { z } from "zod";

export const DEFAULT_FILES_BIND = "127.0.0.1:7886";

export const FilesConfigSchema = z.object({
  /**
   * The origin links are issued on, `https://<host>` (no path); `http://` only for a loopback
   * host (tests, a look on this machine). Empty: no links at all.
   */
  origin: z.string().trim().default(""),
  /** Where the file origin listens; only while `origin` is set. */
  bind: z.string().default(DEFAULT_FILES_BIND),
  /**
   * The member site a visitor of a link for one person or a server's members is sent to, to log
   * in. Empty: the origin of `[modules.api.discord_oauth] redirect_uri`.
   */
  site: z.string().trim().default(""),
  /** Links issued for what she made for one person, in any rolling 24 hours. */
  links_per_person_per_day: z.number().int().nonnegative().default(20),
  /** Requests to the file origin per visitor address and minute. */
  per_ip_per_minute: z.number().int().positive().default(60),
  /** Requests per link and minute, all visitors together. */
  per_link_per_minute: z.number().int().positive().default(120),
  /** How long a CDN may keep a file of a link anyone can open; 0: not at all. */
  public_cache_secs: z.number().int().min(0).max(3600).default(300),
});
export type FilesConfig = z.output<typeof FilesConfigSchema>;

export class FilesConfigError extends Error {
  override readonly name = "FilesConfigError";
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `value` as a bare origin (`https://files.example.com`), or `null` when empty. */
export function parseOrigin(value: string, key: string): string | null {
  const raw = value.trim();
  if (raw === "") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FilesConfigError(`\`${key}\` is not a URL: \`${raw}\``);
  }
  const loopback = LOOPBACK.has(url.hostname) || url.hostname.startsWith("127.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new FilesConfigError(`\`${key}\` must be https (http only on this machine)`);
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") {
    throw new FilesConfigError(`\`${key}\` is an origin only, without a path: \`${raw}\``);
  }
  if (url.username !== "" || url.password !== "") {
    throw new FilesConfigError(`\`${key}\` cannot carry a user name or password`);
  }
  return url.origin;
}
