// @miyoria/api: the Admin API (module `api`), an HTTP + SSE server for the CLI and the admin
// panel, and the errors the CLI's client fails with (`ClientError`).
//
// Every `/api` route except `GET /api/health`, the login routes, `/api/public/*` and
// `/api/member/*` requires `Authorization: Bearer <token>` or an admin session cookie; panel files
// at `/` never do. Admin sessions need `admin.panel.access`, and `admin.panel.write` for anything
// but `GET`; their changes must also send `X-Miyoria-Request: 1` (CSRF guard). A login without
// `admin.panel.access` is a member session, which every admin route refuses. Unknown `/api/*`
// routes answer
// `404 {"error":"no such endpoint"}`. Errors are `{"error": "..."}`; a missing service (its
// module is stopped) is `503`. Changes are recorded in the `AuditLog` (actor `"api"` for the
// token, `discord:<id>` for a session) when there is one.
//
// Routes (shapes in `types.ts`):
//
// * `GET /api/health` → `{ status, version }`
// * `GET /api/auth/methods`, `GET /api/auth/oauth/login?next=/…`,
//   `GET /api/auth/oauth/callback` (public), `GET /api/auth/session`, `POST /api/auth/logout`
// * `GET /api/modules`, `POST /api/modules/{id}/enable|disable|restart`
// * `GET /api/decisions?limit=50&context=<json ContextKey>` (newest first)
// * `GET /api/llm/usage`, `GET /api/llm/cost`
// * `GET /api/persona`, `PUT /api/persona/{key}`, `GET /api/persona/{key}/history`
// * `GET /api/people?q=&limit=&cursor=` (the one list: bond, ring, values, how much she cares),
//   `GET|PATCH /api/people/{id}` (her words, tier and anchors, history, today's caps, evidence),
//   `GET /api/people/{id}/history?before=&limit=`, `POST /api/people/{id}/adjust` (any number,
//   `{field, value|delta}`), `PUT|DELETE /api/people/{id}/anchors/{tier}`,
//   `GET /api/people/{id}/wallet`,
//   `POST /api/people/{id}/wallet/adjust` (coins by hand, needs `admin.economy.adjust`)
// * `GET /api/memory?q=&kind=&subject=&before=&include_superseded=&limit=`,
//   `PATCH|DELETE /api/memory/{id}`
// * `GET /api/auth/roles`, `GET|PUT|DELETE /api/auth/roles/{name}`,
//   `GET|POST|DELETE /api/auth/assignments`, `GET|PUT|DELETE /api/auth/mappings`
// * `GET /api/extensions`, `POST /api/extensions/{id}/enable|disable|restart`
// * `GET /api/mcp`, `POST /api/mcp/{name}/restart`
// * `GET /api/queue`, `POST /api/queue/{id}/skip|move`, `POST /api/queue/pause|resume`
// * `GET /api/stage`, `POST /api/stage/scene|expression|stream|say`,
//   `GET|PUT /api/stage/scenes` (scene roles), `POST /api/stage/scenes/classify`
// * `GET /api/voice`
// * `POST /api/voice/join|leave|golive`, `GET|POST /api/songs`, `POST /api/songs/play|stop`,
//   `POST /api/game/start|stop|goal` (through the actuator gate as the panel, see `control.ts`)
// * `GET /api/telemetry?minutes=360` (a minute's samples of her state and the LLM counters)
// * `GET /api/llm/calls?purpose=&model=&module=&status=&trouble=&thought=&turn=&since=&until=&q=`,
//   `GET /api/llm/calls/{id}` (request and response, redacted), `GET /api/llm/stats?minutes=`,
//   `GET /api/llm/thinking?kind=&reasoned=&q=` (chains of thought by kind of call)
//   (the call inspector, see `llmcalls.ts`), `GET /api/mind/thoughts/{id}` (one thought in full)
// * `GET /api/self` (her inner state), `GET /api/world` (what she perceives); read-only
// * `GET /api/data`, `GET /api/data/export?categories=`, `POST /api/data/wipe`,
//   `POST /api/data/backup`, `POST /api/data/reset` (her data by category, factory reset;
//   export and changes need `owner.data.manage`, see `data.ts`)
// * `GET /api/mind`, `GET /api/mind/thoughts?limit=50`, `GET /api/mind/approvals`,
//   `POST /api/mind/approvals/{id}/approve|deny`, `POST /api/mind/pause|resume` (changes need
//   `owner.autonomy.approve`)
// * `GET /api/directives?history=1`, `POST /api/directives`, `DELETE /api/directives/{id}` (the
//   rules; what a request may change follows its account, see `directives.ts`)

// * `GET /api/activity` (presence, broadcast, activity, scene), `GET /api/activity/tasks?limit=20`
// * `GET /api/arbiter/ledger?context=&limit=`, `GET /api/arbiter/decisions?limit=&context=&verdict=`
//   (the arbiter's verdicts since the `api` module started)
// * `GET /api/affect` (emotions, mood, drives, biases), how she feels about each person is `/api/people`
// * `GET /api/mind/goals?closed=false` (her agenda)
// * `GET /api/prompts?context=&limit=`, `GET /api/prompts/{turn}` (saved prompts per turn),
//   `GET /api/turns/outcomes?context=&outcome=&limit=` (how turns ended); read-only
// * `GET /api/knowledge` (her documents), `GET /api/knowledge/conversations` (her conversation
//   notes), `GET /api/reflection?days=7` (reflections, lessons, feedback),
//   `GET /api/mind/digests?limit=20`; read-only
// * `GET /api/events?topics=platform.*,agent.*` (Server-Sent Events of bus envelopes)
// * `GET /api/eval/live?limit=90` (the live evaluation's runs and the nightly run's state; see
//   `eval/`, which also holds the `eval` module that starts the nightly run)
// * `GET /api/public/status|songs` (anyone; see `public.ts`), `GET /api/public/card/{serial}`
//   (checks a card's code; see `card.ts`)
// * `GET /api/member/session|me|export|card`, `POST /api/member/forget|songs|card` (a logged-in
//   person's own data; see `member.ts`, `card.ts`)

export { type ApiRpc, contract } from "@miyoria/contracts/api";
export { CARDS_PER_DAY } from "./card.js";
export {
  ClientError,
  type ClientErrorKind,
  responseError,
} from "./client.js";
export {
  BACKUP_TOKEN_HEADER,
  BACKUP_TOKEN_TTL_MS,
  type DataViewId,
  NODE_DATA_MANAGE,
  parseContextKeyString,
  TOOLS_WORKSPACE,
} from "./data.js";
export { ApiError, NO_SUCH_ENDPOINT } from "./errors.js";
export { EVAL_HISTORY_FILE, parseEvalHistory, readEvalHistory } from "./eval/history.js";
export {
  type EvalChild,
  type EvalCommand,
  type EvalConfig,
  EvalConfigSchema,
  type EvalExit,
  EvalModule,
  type EvalModuleOptions,
  EvalNightlyKey,
  type EvalNightlyService,
  type EvalSpawner,
  evalCommand,
  evalHoldback,
  findEvalCheckout,
  type NightlyOptions,
  type NightlyOutcome,
  NightlyRunner,
  nextRunAt,
  spawnEval,
} from "./eval/nightly.js";
export { ContextLabels, LABEL_MISS_TTL_MS, LABEL_TIMEOUT_MS, LABEL_TTL_MS } from "./labels.js";
export { METRICS_PATH } from "./metrics.js";
export {
  type ApiConfig,
  ApiConfigError,
  ApiConfigSchema,
  ApiModule,
  type ApiModuleOptions,
  avatarEmotions,
  DEFAULT_BIND,
  DEFAULT_PANEL_DIR,
  FETCH_BLOCKED_PORTS,
  PRUNE_EVERY_MS,
  parseBind,
} from "./module.js";
export { MONITOR_TOPICS, Monitor, percentile } from "./monitor.js";
export {
  type DiscordOAuthConfig,
  DiscordOAuthConfigSchema,
  OAuthConfigError,
  pkceChallenge,
  safeNext,
} from "./oauth.js";
export { PANEL_DIR_ENV, pickDir } from "./panel.js";
export { summarizePrompt } from "./prompts.js";
export { type PublicConfig, PublicConfigSchema } from "./public.js";
export { ActiveProfileKey, isQueueNotFound, MCP_MODULE_ID } from "./services.js";
export {
  COOKIE,
  CSRF_HEADER,
  PANEL_ACCESS,
  PANEL_WRITE,
  STORE_PREFIX as SESSION_STORE_PREFIX,
  STORE_PROFILE as SESSION_STORE_PROFILE,
} from "./session.js";
export type { Tokenizer } from "./state.js";
export { DecisionTrail, TRAIL_CAPACITY } from "./trail.js";
