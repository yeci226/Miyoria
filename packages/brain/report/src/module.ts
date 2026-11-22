// Module `report` (opt-in): problem reports members make through her, and the GitHub issues they
// become. It owns the `report` plugin's table and provides `ReportKey` (`ReportService`) for the
// panel. With the GitHub App's settings (or, as the fallback, a token) and a repo it offers her
// `report_problem` and reads the issues back every `poll_mins`; without them it only keeps and
// shows the drafts there are. With the App's user authorisation set, members may link their
// GitHub account (`link.ts`).

import { ToolRegistryKey } from "@miyoria/llm/tools";
import {
  defineManifest,
  errorMessage,
  interval,
  type Module,
  type ModuleCard,
  type ModuleContext,
} from "@miyoria/runtime/kernel";
import { PeopleStoreKey, StoreKey } from "@miyoria/store";
import { type Clock, serviceKey } from "@miyoria/types";
import { AppInstallationAuth, AppKeyError, type GitHubAuth, StaticToken } from "./auth.js";
import { appSettings, linkSettings, type ReportConfig, ReportConfigSchema } from "./config.js";
import { type FetchLike, GitHubIssues, type IssueTracker } from "./github.js";
import { GitHubLinker } from "./link.js";
import { memoryNotifier } from "./notify.js";
import { type ReportNotifier, ReportService } from "./service.js";
import { reportTables } from "./store.js";
import { REPORT_PROBLEM, reportTool } from "./tool.js";

export const ReportKey = serviceKey<ReportService>("Reports");

export interface ReportModuleOptions {
  /** For tests: the `fetch` that reaches GitHub. */
  fetch?: FetchLike;
  /** For tests: replaces the GitHub client altogether. */
  tracker?: IssueTracker;
  /** For tests: replaces the memory follow-up. */
  notifier?: ReportNotifier;
  clock?: Clock;
}

/**
 * Who GitHub is called as: the App when its settings are complete (recommended), else the token;
 * `null` when neither is, or without a repo. A key that cannot be read falls back to the token.
 */
export function githubAuth(
  config: ReportConfig,
  now: () => number,
  fetcher: FetchLike | undefined,
  warn: (msg: string) => void = () => {},
): GitHubAuth | null {
  if (config.repo === "") return null;
  const app = appSettings(config);
  if (app !== null) {
    try {
      return new AppInstallationAuth({
        ...app,
        repo: config.repo,
        apiUrl: config.api_url,
        now,
        ...(fetcher === undefined ? {} : { fetch: fetcher }),
      });
    } catch (error) {
      if (!(error instanceof AppKeyError)) throw error;
      warn(`report: ${error.message}; trying the token`);
    }
  }
  return config.token === "" ? null : new StaticToken(config.token);
}

export class ReportModule implements Module {
  static readonly ID = "report";
  readonly manifest = defineManifest(ReportModule.ID, "Report", {
    icon: "bug",
    category: "system",
    description:
      "Problem reports members make through her: drafts the owner reviews, and the GitHub issues they become",
    optional: ["memory", "agent"],
    configSchema: ReportConfigSchema,
  });
  readonly #options: ReportModuleOptions;
  #untool: (() => void) | null = null;
  #service: ReportService | null = null;

  constructor(options: ReportModuleOptions = {}) {
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(ReportConfigSchema);
    const store = ctx.services.get(StoreKey);
    if (store === undefined) {
      ctx.log.warn("no store: no reports");
      return;
    }
    const clock = this.#options.clock ?? ctx.clock;
    const tables = store.plugin(reportTables);
    const fetcher = this.#options.fetch;
    const auth = githubAuth(
      config,
      () => clock.now(),
      fetcher,
      (msg) => ctx.log.warn(msg),
    );
    const tracker =
      this.#options.tracker ??
      (auth === null
        ? null
        : new GitHubIssues({
            auth,
            repo: config.repo,
            apiUrl: config.api_url,
            ...(fetcher === undefined ? {} : { fetch: fetcher }),
          }));
    const link = linkSettings(config);
    const linker =
      link === null
        ? null
        : new GitHubLinker({
            ...link,
            store: tables,
            webUrl: config.web_url,
            apiUrl: config.api_url,
            now: () => clock.now(),
            ...(fetcher === undefined ? {} : { fetch: fetcher }),
          });
    const service = new ReportService({
      config,
      store: tables,
      tracker,
      linker,
      now: () => clock.now(),
      reporter: async (account) => {
        const person = await ctx.services.get(PeopleStoreKey)?.personByAccount(account);
        if (!person) return null;
        return {
          person: person.id,
          names: [person.display_name, ...person.accounts.map((a) => a.display_name)],
        };
      },
      notifier: () => this.#options.notifier ?? memoryNotifier(ctx.services),
      log: ctx.log,
    });
    const recovered = service.recover();
    if (recovered > 0) ctx.log.warn({ recovered }, "report: drafts left waiting on GitHub");
    ctx.provide(ReportKey, service);
    this.#service = service;

    if (tracker === null) {
      ctx.log.warn("report: no GitHub App, no token or no repo; she is not offered report_problem");
      return;
    }
    const tools = ctx.services.get(ToolRegistryKey);
    if (tools) {
      tools.register(reportTool(() => this.#service));
      this.#untool = () => tools.unregister(REPORT_PROBLEM);
    }
    const every = config.poll_mins * 60_000;
    ctx.spawn("poll", async (signal) => {
      for await (const _ of interval(every, signal)) {
        try {
          await service.poll(signal);
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "report: the poll failed");
        }
      }
    });
    ctx.log.info(
      {
        repo: config.repo,
        auth: auth?.kind ?? "test",
        linking: linker !== null,
        auto_open: config.auto_open,
      },
      "reports running",
    );
  }

  async card(): Promise<ModuleCard> {
    const service = this.#service;
    if (service === null) return { facts: [] };
    const waiting = service.list(["draft"], 1000).length;
    return {
      facts: [
        { label: "待審核", value: String(waiting) },
        { label: "24 小時內", value: String(service.today()) },
        { label: "GitHub", value: service.ready ? service.config.repo : "沒有設定" },
      ],
    };
  }

  async stop(): Promise<void> {
    this.#untool?.();
    this.#untool = null;
    this.#service = null;
  }
}
