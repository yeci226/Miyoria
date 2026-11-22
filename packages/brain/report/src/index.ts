// @miyoria/brain/report: problems members report through her, turned into GitHub issues.
//
// * `report_problem` (`tool.ts`): she writes a report down as a draft; what the member said is
//   data, cleaned by code (`sanitize.ts`) before anything is kept.
// * `ReportService` (`ReportKey`): caps per person and in all, a duplicate search over the
//   repository's open issues, the owner's decisions (approve, comment on #N, duplicate of #N,
//   reject) and the closure poll, with a follow-up for her when a reported problem was fixed.
// * `GitHubIssues`: the REST calls, over an injected `fetch`, as a `GitHubAuth`: the GitHub App's
//   installation (`AppInstallationAuth`, recommended) or a static token.
// * `GitHubLinker`: a member links their own GitHub account (OAuth with the same App), to be named
//   on the issues their reports become when they allow it.
// * Module `report` (opt-in): `[modules.report]`, the tool and the poll.
// * Storage: the plugin owns `report_drafts` (`schema.ts`, `migrations.ts`); Core opens the store
//   with `reportTables`.

export {
  type AppAuthOptions,
  AppInstallationAuth,
  AppKeyError,
  appJwt,
  type GitHubAuth,
  JWT_BACKDATE_S,
  JWT_LIFETIME_S,
  RENEW_BEFORE_MS,
  readPrivateKey,
  StaticToken,
} from "./auth.js";
export {
  appSettings,
  linkSettings,
  REPO,
  type ReportConfig,
  ReportConfigSchema,
  reportConfig,
} from "./config.js";
export {
  type IssueMatch,
  LIKELY_DUPLICATE,
  likelyDuplicate,
  searchTerms,
  titleSimilarity,
} from "./duplicates.js";
export {
  type FetchLike,
  GitHubError,
  GitHubIssues,
  type GitHubOptions,
  type IssueState,
  type IssueTracker,
  LOGIN,
  type OpenedIssue,
} from "./github.js";
export {
  GitHubLinker,
  LINK_COOKIE,
  LINK_MAX_PENDING,
  LINK_TTL_MS,
  type LinkerOptions,
  type LinkFinish,
} from "./link.js";
export { reportSchema } from "./migrations.js";
export { githubAuth, ReportKey, ReportModule, type ReportModuleOptions } from "./module.js";
export { fixedText, memoryNotifier } from "./notify.js";
export {
  LIMITS,
  markdownText,
  normalizeTitle,
  type PlainOptions,
  plainText,
  REMOVED,
} from "./sanitize.js";
export { REPORT_STATUSES, type ReportStatus, reportDrafts, reportGithubLinks } from "./schema.js";
export {
  AREA_NAMES,
  areaOf,
  CAP_WINDOW_MS,
  commentBody,
  type Decided,
  type FixedNotice,
  issueBody,
  issueTitle,
  type MentionWhy,
  mentionLine,
  POLL_BATCH,
  REPORT_AREAS,
  type Refusal,
  type ReportArea,
  type Reporter,
  type ReportFields,
  type ReportInput,
  type ReportNotifier,
  type ReportOutcome,
  ReportService,
  type ReportServiceDeps,
} from "./service.js";
export {
  FOLLOWED,
  type GithubLink,
  type LinkOutcome,
  type ReportRow,
  ReportTables,
  reportTables,
} from "./store.js";
export { outcomeText, REPORT_PROBLEM, REPORT_TOOL, reportTool } from "./tool.js";
