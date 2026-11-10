// Typed client for the admin API, used by the CLI.

import type { StreamAction } from "@miyoria/stage";
import type {
  DecisionRecord,
  PersonaOverride,
  RoleAssignment,
  RoleDefinition,
  RoleMapping,
} from "@miyoria/store";
import type {
  ActivitySnapshot,
  ActivityTask,
  AffectSnapshot,
  ArbiterVerdict,
  ContextKey,
  Envelope,
  LedgerView,
  PersonCard,
  PlatformId,
  SavedPrompt,
  ThoughtDigest,
  TurnOutcomeRecord,
} from "@miyoria/types";
import { statusText } from "./errors.js";
import type {
  ArbiterDecisionsView,
  AssignRoleRequest,
  AuthMethods,
  ConversationNoteView,
  CostInfo,
  DayPlanView,
  ErrorBody,
  ExtensionInfo,
  GoalsView,
  HealthInfo,
  KnowledgeView,
  McpServerInfo,
  MemoryItem,
  MemoryListQuery,
  MemoryRecordView,
  MindView,
  ModuleInfo,
  Page,
  PendingApproval,
  PersonaSectionInfo,
  PersonDetail,
  PersonSummary,
  PromptSummary,
  QueueState,
  ReflectionView,
  RemoveMappingRequest,
  SayResponse,
  SceneRolesState,
  SelfView,
  SessionInfo,
  SetPersonaResponse,
  StageState,
  Thought,
  TurnOutcomeKind,
  UpdateMemoryRequest,
  UpdatePersonRequest,
  UpsertRoleRequest,
  UsageInfo,
  VoiceState,
  WorldView,
} from "./types.js";

export type ClientErrorKind = "invalid_url" | "transport" | "api" | "decode";

/** Every failure of `ApiClient`. `status` is set for `api` errors (non-success answers). */
export class ClientError extends Error {
  override readonly name = "ClientError";

  private constructor(
    readonly kind: ClientErrorKind,
    message: string,
    readonly status: number | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }

  static invalidUrl(url: string): ClientError {
    return new ClientError("invalid_url", `invalid API base URL \`${url}\``, null);
  }

  static transport(error: unknown): ClientError {
    let reason = error instanceof Error ? error.message : String(error);
    // `fetch` reports "fetch failed" and keeps the reason (ECONNREFUSED, ...) in `cause`.
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause instanceof Error && cause.message !== "") reason = `${reason}: ${cause.message}`;
    return new ClientError("transport", `cannot reach the admin API: ${reason}`, null, {
      cause: error,
    });
  }

  static api(status: number, message: string): ClientError {
    return new ClientError("api", `admin API returned ${statusText(status)}: ${message}`, status);
  }

  static decode(reason: string): ClientError {
    return new ClientError("decode", `invalid event from the admin API: ${reason}`, null);
  }
}

/** Options every call accepts. */
export interface CallOptions {
  signal?: AbortSignal;
}

/** Bus envelopes from `GET /api/events`. Iterate with `for await`; `close()` ends it early. */
export interface EventStream extends AsyncIterableIterator<Envelope> {
  close(): void;
}

/** Minimal Server-Sent Events parser: yields the `data` of each event. */
export class SseParser {
  #line: number[] = [];
  #data = "";
  #hasData = false;
  readonly #decoder = new TextDecoder("utf-8", { fatal: false });

  feed(chunk: Uint8Array): string[] {
    const out: string[] = [];
    for (const byte of chunk) {
      if (byte !== 0x0a) {
        this.#line.push(byte);
        continue;
      }
      if (this.#line[this.#line.length - 1] === 0x0d) this.#line.pop();
      const line = this.#decoder.decode(Uint8Array.from(this.#line));
      this.#line = [];
      if (line === "") {
        if (this.#hasData) {
          out.push(this.#data);
          this.#data = "";
          this.#hasData = false;
        }
      } else if (line.startsWith("data")) {
        // Other fields (`id`, `event`, `retry`) and `:` comments are ignored.
        let value = line.slice(4);
        if (value.startsWith(":")) value = value.slice(1);
        else if (value !== "") continue;
        if (this.#hasData) this.#data += "\n";
        this.#data += value.startsWith(" ") ? value.slice(1) : value;
        this.#hasData = true;
      }
    }
    return out;
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type Query = Record<string, string | undefined>;

/** Admin API client. */
export class ApiClient {
  readonly #base: URL;
  readonly #token: string;

  /** `baseUrl` is e.g. `http://127.0.0.1:7878`. Throws `ClientError` (`invalid_url`). */
  constructor(baseUrl: string, token: string) {
    let base: URL;
    try {
      base = new URL(baseUrl);
    } catch {
      throw ClientError.invalidUrl(baseUrl);
    }
    if (base.protocol !== "http:" && base.protocol !== "https:") {
      throw ClientError.invalidUrl(baseUrl);
    }
    this.#base = base;
    this.#token = token;
  }

  health(o?: CallOptions): Promise<HealthInfo> {
    return this.#json("GET", ["health"], o);
  }

  /** Which panel logins the Core offers (public). */
  authMethods(o?: CallOptions): Promise<AuthMethods> {
    return this.#json("GET", ["auth", "methods"], o);
  }

  /** Who this client is to the Core (`method: "token"` for the bearer token). */
  session(o?: CallOptions): Promise<SessionInfo> {
    return this.#json("GET", ["auth", "session"], o);
  }

  modules(o?: CallOptions): Promise<ModuleInfo[]> {
    return this.#json("GET", ["modules"], o);
  }

  /** `action` is `"enable"`, `"disable"` or `"restart"`. Returns the module's status afterwards. */
  moduleAction(id: string, action: string, o?: CallOptions): Promise<ModuleInfo> {
    return this.#json("POST", ["modules", id, action], o);
  }

  /** The newest `limit` attention decisions, newest first. */
  decisions(limit: number, o?: CallOptions): Promise<DecisionRecord[]> {
    return this.decisionsIn(null, limit, o);
  }

  /** Like `decisions`, optionally for one context only. */
  decisionsIn(
    context: ContextKey | null,
    limit: number,
    o?: CallOptions,
  ): Promise<DecisionRecord[]> {
    return this.#json("GET", ["decisions"], {
      ...o,
      query: {
        limit: String(limit),
        context: context ? JSON.stringify(context) : undefined,
      },
    });
  }

  /** Token usage per `provider:model` since the core started (keys ascending). */
  async usage(o?: CallOptions): Promise<Map<string, UsageInfo>> {
    const raw = await this.#json<Record<string, UsageInfo>>("GET", ["llm", "usage"], o);
    return new Map(
      Object.keys(raw)
        .sort()
        .map((k) => [k, raw[k] as UsageInfo]),
    );
  }

  persona(o?: CallOptions): Promise<PersonaSectionInfo[]> {
    return this.#json("GET", ["persona"], o);
  }

  /** Replaces a persona section (recorded as edited by `"api"`). Returns the new version. */
  setPersona(key: string, body: string, o?: CallOptions): Promise<number> {
    return this.setPersonaAs(key, body, null, o);
  }

  /** Like `setPersona` with an explicit editor name. */
  async setPersonaAs(
    key: string,
    body: string,
    editedBy: string | null,
    o?: CallOptions,
  ): Promise<number> {
    const request = editedBy === null ? { body } : { body, edited_by: editedBy };
    const response = await this.#json<SetPersonaResponse>("PUT", ["persona", key], {
      ...o,
      body: request,
    });
    return response.version;
  }

  /** Every stored version of a persona section, oldest first. */
  personaHistory(key: string, o?: CallOptions): Promise<PersonaOverride[]> {
    return this.#json("GET", ["persona", key, "history"], o);
  }

  /** Spend today and this month per model, plus the budget state. */
  cost(o?: CallOptions): Promise<CostInfo> {
    return this.#json("GET", ["llm", "cost"], o);
  }

  // ---- people ---------------------------------------------------------------------------

  /**
   * Every known person (with or without a relationship), most recent interaction first. `q`
   * filters by name or account id; `cursor` is a previous `next_cursor`.
   */
  people(
    query: { q?: string; limit?: number; cursor?: string } = {},
    o?: CallOptions,
  ): Promise<Page<PersonSummary>> {
    return this.#json("GET", ["people"], {
      ...o,
      query: {
        q: query.q,
        limit: query.limit === undefined ? undefined : String(query.limit),
        cursor: query.cursor,
      },
    });
  }

  person(id: string, o?: CallOptions): Promise<PersonDetail> {
    return this.#json("GET", ["people", id], o);
  }

  updatePerson(id: string, request: UpdatePersonRequest, o?: CallOptions): Promise<PersonSummary> {
    return this.#json("PATCH", ["people", id], { ...o, body: request });
  }

  /** Adds `affinity` directly (ignoring the daily caps). */
  adjustPerson(id: string, affinity: number, o?: CallOptions): Promise<PersonSummary> {
    return this.#json("POST", ["people", id, "adjust"], { ...o, body: { affinity } });
  }

  // ---- memory ---------------------------------------------------------------------------

  /**
   * Lists (newest first) or, with `q`, searches her memories (hybrid recall when the memory
   * module runs, full text otherwise).
   */
  memory(query: MemoryListQuery = {}, o?: CallOptions): Promise<Page<MemoryItem>> {
    return this.#json("GET", ["memory"], {
      ...o,
      query: {
        q: query.q,
        kind: query.kind,
        subject: query.subject,
        before: query.before,
        include_superseded: query.include_superseded ? "true" : undefined,
        limit: query.limit === undefined ? undefined : String(query.limit),
      },
    });
  }

  updateMemory(
    id: string,
    request: UpdateMemoryRequest,
    o?: CallOptions,
  ): Promise<MemoryRecordView> {
    return this.#json("PATCH", ["memory", id], { ...o, body: request });
  }

  deleteMemory(id: string, o?: CallOptions): Promise<void> {
    return this.#empty("DELETE", ["memory", id], o);
  }

  // ---- roles & permissions --------------------------------------------------------------

  /** Every role, highest rank first. */
  roles(o?: CallOptions): Promise<RoleDefinition[]> {
    return this.#json("GET", ["auth", "roles"], o);
  }

  role(name: string, o?: CallOptions): Promise<RoleDefinition> {
    return this.#json("GET", ["auth", "roles", name], o);
  }

  /** Creates or replaces a role. */
  upsertRole(name: string, request: UpsertRoleRequest, o?: CallOptions): Promise<RoleDefinition> {
    return this.#json("PUT", ["auth", "roles", name], { ...o, body: request });
  }

  deleteRole(name: string, o?: CallOptions): Promise<void> {
    return this.#empty("DELETE", ["auth", "roles", name], o);
  }

  assignments(o?: CallOptions): Promise<RoleAssignment[]> {
    return this.#json("GET", ["auth", "assignments"], o);
  }

  assignRole(request: AssignRoleRequest, o?: CallOptions): Promise<RoleAssignment> {
    return this.#json("POST", ["auth", "assignments"], { ...o, body: request });
  }

  revokeRole(request: AssignRoleRequest, o?: CallOptions): Promise<void> {
    return this.#empty("DELETE", ["auth", "assignments"], { ...o, body: request });
  }

  /** Platform role mappings of one guild. */
  mappings(platform: PlatformId, guild: string, o?: CallOptions): Promise<RoleMapping[]> {
    return this.#json("GET", ["auth", "mappings"], { ...o, query: { platform, guild } });
  }

  setMapping(mapping: RoleMapping, o?: CallOptions): Promise<RoleMapping> {
    return this.#json("PUT", ["auth", "mappings"], { ...o, body: mapping });
  }

  removeMapping(request: RemoveMappingRequest, o?: CallOptions): Promise<void> {
    return this.#empty("DELETE", ["auth", "mappings"], { ...o, body: request });
  }

  // ---- extensions & MCP -----------------------------------------------------------------

  extensions(o?: CallOptions): Promise<ExtensionInfo[]> {
    return this.#json("GET", ["extensions"], o);
  }

  /** `action` is `"enable"`, `"disable"` or `"restart"`. */
  extensionAction(id: string, action: string, o?: CallOptions): Promise<ExtensionInfo> {
    return this.#json("POST", ["extensions", id, action], o);
  }

  mcpServers(o?: CallOptions): Promise<McpServerInfo[]> {
    return this.#json("GET", ["mcp"], o);
  }

  /** Only `"restart"` is supported at runtime. */
  mcpAction(name: string, action: string, o?: CallOptions): Promise<McpServerInfo> {
    return this.#json("POST", ["mcp", name, action], o);
  }

  // ---- request queue --------------------------------------------------------------------

  queue(o?: CallOptions): Promise<QueueState> {
    return this.#json("GET", ["queue"], o);
  }

  queueSkip(id: string, o?: CallOptions): Promise<QueueState> {
    return this.#json("POST", ["queue", id, "skip"], o);
  }

  /** Moves an item to a 0-based index of `QueueState.items`. */
  queueMove(id: string, position: number, o?: CallOptions): Promise<QueueState> {
    return this.#json("POST", ["queue", id, "move"], { ...o, body: { position } });
  }

  queuePause(paused: boolean, o?: CallOptions): Promise<QueueState> {
    return this.#json("POST", ["queue", paused ? "pause" : "resume"], o);
  }

  // ---- stage & voice --------------------------------------------------------------------

  stage(o?: CallOptions): Promise<StageState> {
    return this.#json("GET", ["stage"], o);
  }

  stageScene(scene: string, o?: CallOptions): Promise<StageState> {
    return this.#json("POST", ["stage", "scene"], { ...o, body: { scene } });
  }

  stageExpression(expression: string, o?: CallOptions): Promise<StageState> {
    return this.#json("POST", ["stage", "expression"], { ...o, body: { expression } });
  }

  stageStream(action: StreamAction, o?: CallOptions): Promise<StageState> {
    return this.#json("POST", ["stage", "stream"], { ...o, body: { action } });
  }

  /** Which OBS scene each scene role uses. */
  sceneRoles(o?: CallOptions): Promise<SceneRolesState> {
    return this.#json("GET", ["stage", "scenes"], o);
  }

  /** The panel's scene for `role`; `null` goes back to the automatic classification. */
  setSceneRole(role: string, scene: string | null, o?: CallOptions): Promise<SceneRolesState> {
    return this.#json("PUT", ["stage", "scenes"], { ...o, body: { role, scene } });
  }

  /** Classifies the OBS scenes again. */
  classifyScenes(o?: CallOptions): Promise<SceneRolesState> {
    return this.#json("POST", ["stage", "scenes", "classify"], o);
  }

  /** Speaks `text` in her voice channel without the LLM. */
  stageSay(text: string, emotion: string | null = null, o?: CallOptions): Promise<SayResponse> {
    const body = emotion === null ? { text } : { text, emotion };
    return this.#json("POST", ["stage", "say"], { ...o, body });
  }

  voice(o?: CallOptions): Promise<VoiceState> {
    return this.#json("GET", ["voice"], o);
  }

  // ---- inner life -----------------------------------------------------------------------

  /** Her drives, boredom, policy, agenda, mood and feelings. */
  self(o?: CallOptions): Promise<SelfView> {
    return this.#json("GET", ["self"], o);
  }

  /** What she perceives: people, voice channels, channel activity, her own status. */
  world(o?: CallOptions): Promise<WorldView> {
    return this.#json("GET", ["world"], o);
  }

  // ---- body, arbiter, affect, plan, prompts -----------------------------------------------

  /** Her presence, broadcast, activity and scene. */
  activity(o?: CallOptions): Promise<ActivitySnapshot> {
    return this.#json("GET", ["activity"], o);
  }

  /** Recent activity transition tasks, newest first. */
  activityTasks(limit = 20, o?: CallOptions): Promise<ActivityTask[]> {
    return this.#json("GET", ["activity", "tasks"], { ...o, query: { limit: String(limit) } });
  }

  /** What she did or tried (`context`: entries there first), her limits, topics nobody took up. */
  ledger(context: ContextKey | null = null, limit = 50, o?: CallOptions): Promise<LedgerView> {
    return this.#json("GET", ["arbiter", "ledger"], {
      ...o,
      query: { limit: String(limit), context: context ? JSON.stringify(context) : undefined },
    });
  }

  /** The arbiter's recent verdicts with reasons, newest first (`verdict`: only that kind). */
  arbiterDecisions(
    q: { limit?: number; context?: ContextKey | null; verdict?: ArbiterVerdict } = {},
    o?: CallOptions,
  ): Promise<ArbiterDecisionsView> {
    return this.#json("GET", ["arbiter", "decisions"], {
      ...o,
      query: {
        limit: q.limit === undefined ? undefined : String(q.limit),
        context: q.context ? JSON.stringify(q.context) : undefined,
        verdict: q.verdict,
      },
    });
  }

  /** Her emotions, derived mood, drives and the behaviour biases they imply. */
  affect(o?: CallOptions): Promise<AffectSnapshot> {
    return this.#json("GET", ["affect"], o);
  }

  /** One card per person, highest attachment first. */
  affectPeople(o?: CallOptions): Promise<PersonCard[]> {
    return this.#json("GET", ["affect", "people"], o);
  }

  /** Her goals (`closed`: also the done and dropped ones when the agenda keeps them). */
  goals(closed = false, o?: CallOptions): Promise<GoalsView> {
    return this.#json("GET", ["mind", "goals"], {
      ...o,
      query: { closed: closed ? "true" : undefined },
    });
  }

  /** Today's plan in her words. */
  dayPlan(o?: CallOptions): Promise<DayPlanView> {
    return this.#json("GET", ["mind", "plan"], o);
  }

  /** The saved prompts of recent turns (no text), newest first. */
  prompts(
    context: ContextKey | null = null,
    limit = 30,
    o?: CallOptions,
  ): Promise<PromptSummary[]> {
    return this.#json("GET", ["prompts"], {
      ...o,
      query: { limit: String(limit), context: context ? JSON.stringify(context) : undefined },
    });
  }

  /** The saved prompt of one turn, in full. */
  prompt(turn: string, o?: CallOptions): Promise<SavedPrompt> {
    return this.#json("GET", ["prompts", turn], o);
  }

  /** How turns ended, newest first. */
  turnOutcomes(
    q: { limit?: number; context?: ContextKey | null; outcome?: TurnOutcomeKind } = {},
    o?: CallOptions,
  ): Promise<TurnOutcomeRecord[]> {
    return this.#json("GET", ["turns", "outcomes"], {
      ...o,
      query: {
        limit: q.limit === undefined ? undefined : String(q.limit),
        context: q.context ? JSON.stringify(q.context) : undefined,
        outcome: q.outcome,
      },
    });
  }

  /** Her mind loop: paused or not, call counts, pending approvals. */
  mind(o?: CallOptions): Promise<MindView> {
    return this.#json("GET", ["mind"], o);
  }

  /** Her thought journal, newest first. */
  thoughts(limit = 50, o?: CallOptions): Promise<Thought[]> {
    return this.#json("GET", ["mind", "thoughts"], { ...o, query: { limit: String(limit) } });
  }

  /** High-risk actions waiting for an owner. */
  approvals(o?: CallOptions): Promise<PendingApproval[]> {
    return this.#json("GET", ["mind", "approvals"], o);
  }

  /** Answers a pending approval; resolves with the ones still pending. */
  answerApproval(id: string, approved: boolean, o?: CallOptions): Promise<PendingApproval[]> {
    return this.#json("POST", ["mind", "approvals", id, approved ? "approve" : "deny"], o);
  }

  /** Digests of her older thoughts, newest first. */
  digests(limit = 20, o?: CallOptions): Promise<ThoughtDigest[]> {
    return this.#json("GET", ["mind", "digests"], { ...o, query: { limit: String(limit) } });
  }

  /** Her self-organized documents. */
  knowledge(o?: CallOptions): Promise<KnowledgeView> {
    return this.#json("GET", ["knowledge"], o);
  }

  /** Her running notes on each conversation. */
  conversationNotes(o?: CallOptions): Promise<ConversationNoteView[]> {
    return this.#json("GET", ["knowledge", "conversations"], o);
  }

  /** Her reflections, lessons and the feedback of the last `days` days. */
  reflection(days = 7, o?: CallOptions): Promise<ReflectionView> {
    return this.#json("GET", ["reflection"], { ...o, query: { days: String(days) } });
  }

  /** The emergency stop of her autonomy. */
  autonomyPause(paused: boolean, o?: CallOptions): Promise<MindView> {
    return this.#json("POST", ["mind", paused ? "pause" : "resume"], o);
  }

  /**
   * Streams bus envelopes matching `topics` (e.g. `["platform.*", "agent.*"]`; empty means
   * everything). The subscription is active once this resolves; the stream ends when the
   * server stops, `close()` is called or `signal` aborts.
   */
  async events(topics: readonly string[] = [], o?: CallOptions): Promise<EventStream> {
    const controller = new AbortController();
    const signal = o?.signal ? AbortSignal.any([o.signal, controller.signal]) : controller.signal;
    const response = await this.#send("GET", ["events"], {
      signal,
      query: { topics: topics.length > 0 ? topics.join(",") : undefined },
    });
    const body = response.body;
    if (!body) throw ClientError.transport(new Error("the event stream has no body"));
    const reader = body.getReader();
    const parser = new SseParser();
    const pending: string[] = [];
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      controller.abort();
      void reader.cancel().catch(() => undefined);
    };
    const stream: EventStream = {
      async next(): Promise<IteratorResult<Envelope>> {
        for (;;) {
          const data = pending.shift();
          if (data !== undefined) {
            try {
              return { value: JSON.parse(data) as Envelope, done: false };
            } catch (error) {
              throw ClientError.decode(error instanceof Error ? error.message : String(error));
            }
          }
          if (finished) return { value: undefined, done: true };
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await reader.read();
          } catch (error) {
            if (finished || signal.aborted) {
              finish();
              return { value: undefined, done: true };
            }
            finish();
            throw ClientError.transport(error);
          }
          if (chunk.done) {
            finish();
            continue;
          }
          pending.push(...parser.feed(chunk.value));
        }
      },
      async return(): Promise<IteratorResult<Envelope>> {
        finish();
        pending.length = 0;
        return { value: undefined, done: true };
      },
      close: () => {
        finish();
        pending.length = 0;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return stream;
  }

  /** `<base>/api/<segments...>` with each segment percent-encoded. */
  url(segments: readonly string[], query: Query = {}): URL {
    const url = new URL(this.#base.href);
    let path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
    for (const s of ["api", ...segments]) path += `/${encodeURIComponent(s)}`;
    url.pathname = path;
    url.search = "";
    url.hash = "";
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.append(k, v);
    }
    return url;
  }

  async #send(
    method: Method,
    segments: readonly string[],
    options: CallOptions & { query?: Query; body?: unknown } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token}` };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    let response: Response;
    try {
      response = await fetch(this.url(segments, options.query), {
        method,
        headers,
        body,
        signal: options.signal,
      });
    } catch (error) {
      throw ClientError.transport(error);
    }
    if (response.ok) return response;
    let text = "";
    try {
      text = await response.text();
    } catch {
      text = "";
    }
    let message: string;
    try {
      const parsed = JSON.parse(text) as Partial<ErrorBody>;
      if (typeof parsed.error !== "string") throw new Error("not an error body");
      message = parsed.error;
    } catch {
      message =
        text.trim() !== ""
          ? text.trim()
          : statusText(response.status).split(" ").slice(1).join(" ") || "error";
    }
    throw ClientError.api(response.status, message);
  }

  async #json<T>(
    method: Method,
    segments: readonly string[],
    options?: CallOptions & { query?: Query; body?: unknown },
  ): Promise<T> {
    const response = await this.#send(method, segments, options);
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw ClientError.transport(error);
    }
  }

  /** For routes answering `204 No Content`. */
  async #empty(
    method: Method,
    segments: readonly string[],
    options?: CallOptions & { query?: Query; body?: unknown },
  ): Promise<void> {
    const response = await this.#send(method, segments, options);
    try {
      await response.arrayBuffer();
    } catch (error) {
      throw ClientError.transport(error);
    }
  }
}
