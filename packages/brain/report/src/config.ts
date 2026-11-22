// `[modules.report]`: problem reports members make through her, turned into GitHub issues on one
// repository. The module is opt-in (Core's `OPT_IN_MODULES`): it runs only with `enabled = true`.
//
// How Core reaches GitHub, recommended first:
//
// * A GitHub App (`app_id`, `private_key`, optionally `installation_id`): the owner creates an App
//   with Repository permissions -> Issues: Read and write (Metadata: Read comes with it), no
//   webhook, and installs it on the one repository only. Core signs a JWT with the App's key and
//   trades it for installation tokens limited to that repository and `issues: write`. Issues show
//   as the App's bot.
// * A fine-grained personal access token (`token`) limited to that repository with "Issues: Read
//   and write": the fallback, used when the App's settings are not complete.
//
// The same App's user authorisation (`client_id`, `client_secret`, `link_redirect_uri`) lets a
// member link their own GitHub account on the member page, to be named on the issues their
// reports become (`link.ts`). Its callback URL is `link_redirect_uri`, exactly.
//
// Every secret comes from the environment through `${VAR}` in `miyoria.toml`, never as plain text
// in the file: `MIYORIA_GITHUB_APP_ID`, `MIYORIA_GITHUB_APP_INSTALLATION_ID`,
// `MIYORIA_GITHUB_APP_PRIVATE_KEY` (the PEM; one line with literal `\n` works),
// `MIYORIA_GITHUB_APP_CLIENT_ID`, `MIYORIA_GITHUB_APP_CLIENT_SECRET`, and
// `MIYORIA_GITHUB_ISSUES_TOKEN` for the fallback. Making the App or the token is the owner's job.
//
// Setting the App up (GitHub -> Settings -> Developer settings -> GitHub Apps -> New GitHub App):
//
// | Field                                                  | Value                                          |
// |--------------------------------------------------------|------------------------------------------------|
// | Homepage URL                                           | the member page's site                         |
// | Callback URL                                           | `https://<site>/api/member/github/callback`, the same as `link_redirect_uri`; only for linking |
// | Request user authorization (OAuth) during installation | off                                            |
// | Webhook                                                | off (Active unticked): none is needed          |
// | Repository permissions                                 | Issues: Read and write (Metadata: Read-only comes with it); nothing else |
// | Organization / Account permissions                     | none                                           |
// | Where can this GitHub App be installed?                | Only on this account                           |
//
// Then: note the App ID; generate a private key (the `.pem`); for linking, note the Client ID and
// generate a client secret; install the App on the one repository only ("Only select
// repositories"). The installation id may stay empty: Core looks it up from the repository. Put
// the values in `.env` under the names above (the PEM in double quotes over several lines, or on
// one line with literal `\n`), reference them from `[modules.report]`, set `repo` and, for linking,
// `link_redirect_uri`, and restart Core. The panel's 運作 / 回報 then says 「以 GitHub App 開」.

import { setting, settingGroups } from "@miyoria/runtime/kernel";
import { z } from "zod";

/** A GitHub numeric id as the config may give it: digits in a string (`${VAR}`), or a number. */
const numericId = () =>
  z.union([z.string().regex(/^\d*$/, "digits"), z.number().int().positive()]).default("");

/** `owner/name`, as GitHub spells a repository. */
export const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * ```toml
 * [modules.report]
 * enabled = true
 * app_id = "${MIYORIA_GITHUB_APP_ID:-}"
 * private_key = "${MIYORIA_GITHUB_APP_PRIVATE_KEY:-}"
 * repo = "owner/name"
 * labels = ["from-discord"]
 * ```
 */
export const ReportConfigSchema = z
  .object({
    /** The GitHub App's id; with `private_key` and `repo`, Core works as the App. */
    app_id: numericId().meta(setting({ kind: "text", label: "GitHub App ID", group: "github" })),
    /** The App's installation on `repo`; empty: looked up from the repository. */
    installation_id: numericId(),
    /** The App's private key (PEM); a key on one line with literal `\n` works too. */
    private_key: z
      .string()
      .default("")
      .meta(
        setting({
          kind: "text",
          label: "GitHub App 私鑰",
          help: "放在環境變數裡,設定檔只引用變數名稱",
          group: "github",
          secret: true,
        }),
      ),
    /** The fallback: a fine-grained token, used when the App's settings are not complete. */
    token: z
      .string()
      .default("")
      .meta(
        setting({
          kind: "text",
          label: "GitHub token",
          help: "只要那一個 repo 的 Issues 讀寫權限;放在環境變數裡,設定檔只引用變數名稱",
          group: "github",
          secret: true,
        }),
      ),
    /** Where issues are opened, `owner/name`; empty: nothing is opened. */
    repo: z
      .string()
      .regex(/^([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})?$/, "owner/name")
      .default("")
      .meta(setting({ kind: "text", label: "Repo", help: "owner/name", group: "github" })),
    /** Labels every issue opened from a report gets (they must exist on the repository). */
    labels: z.array(z.string().min(1).max(50)).max(10).default([]),
    /** Reports one person may make in 24 hours. */
    per_person_daily: z
      .number()
      .int()
      .nonnegative()
      .default(3)
      .meta(setting({ kind: "number", label: "每人每天", group: "limits" })),
    /** Reports everyone together may make in 24 hours. */
    global_daily: z
      .number()
      .int()
      .nonnegative()
      .default(20)
      .meta(setting({ kind: "number", label: "全部每天", group: "limits" })),
    /**
     * A report that passes every guard (the caps, no likely duplicate) opens an issue without
     * waiting for the owner. Off: every report waits as a draft in the panel.
     */
    auto_open: z
      .boolean()
      .default(false)
      .meta(
        setting({
          kind: "switch",
          label: "不經審核直接開",
          danger: "成員說的內容會直接出現在公開的 issue 上",
          group: "github",
        }),
      ),
    /** How often the issues opened from reports are checked for being closed. */
    poll_mins: z.number().int().min(5).default(30),
    /** The REST API's root (GitHub Enterprise has its own). */
    api_url: z.url().default("https://api.github.com"),
    /** Where people sign in to GitHub (the OAuth pages); GitHub Enterprise has its own. */
    web_url: z.url().default("https://github.com"),
    /** The App's OAuth client id, for members linking their GitHub account; empty: no linking. */
    client_id: z.string().max(100).default(""),
    /** The App's OAuth client secret. */
    client_secret: z
      .string()
      .default("")
      .meta(
        setting({
          kind: "text",
          label: "GitHub App client secret",
          help: "放在環境變數裡,設定檔只引用變數名稱",
          group: "link",
          secret: true,
        }),
      ),
    /**
     * The link's callback, exactly as the App has it: the member page's
     * `https://<site>/api/member/github/callback`. Empty: no linking.
     */
    link_redirect_uri: z.union([z.literal(""), z.url({ protocol: /^https?$/ })]).default(""),
  })
  .meta(
    settingGroups([
      { id: "github", label: "GitHub" },
      { id: "limits", label: "次數" },
      { id: "link", label: "成員連結 GitHub" },
    ]),
  );
export type ReportConfig = z.output<typeof ReportConfigSchema>;

export function reportConfig(value: unknown = {}): ReportConfig {
  return ReportConfigSchema.parse(value);
}

/** The App's settings, when they are complete. */
export function appSettings(
  config: ReportConfig,
): { appId: string; installationId: string | null; privateKey: string } | null {
  const appId = String(config.app_id).trim();
  if (appId === "" || config.private_key.trim() === "" || config.repo === "") return null;
  const installation = String(config.installation_id).trim();
  return {
    appId,
    installationId: installation === "" ? null : installation,
    privateKey: config.private_key,
  };
}

/** The link's settings, when they are complete. */
export function linkSettings(
  config: ReportConfig,
): { clientId: string; clientSecret: string; redirectUri: string } | null {
  if (config.client_id === "" || config.client_secret === "" || config.link_redirect_uri === "") {
    return null;
  }
  return {
    clientId: config.client_id,
    clientSecret: config.client_secret,
    redirectUri: config.link_redirect_uri,
  };
}
