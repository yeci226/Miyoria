// The admin routes that moved to the route table, called the way the CLI's client calls them: the
// bearer token, JSON in and out, a `ClientError` when a call fails. Each function keeps the name
// and the arguments of the client method it replaced, so a test reads as it did.

import type {
  AdjustPersonRequest,
  ArbiterDecisionsView,
  AssignRoleRequest,
  ConversationNote as ConversationNoteView,
  CostReport as CostInfo,
  ExtensionInfo,
  GoalsView,
  HeartHistoryPage,
  KnowledgeView,
  McpServerInfo,
  MemoryItem,
  MemoryPage,
  MemoryRecordView,
  MindView,
  ModuleInfo,
  PersonAnchor,
  PersonPage,
  PersonProfile,
  PersonRow,
  PromptSummary,
  QueueState,
  ReflectionView,
  RemoveMappingRequest,
  SayResponse,
  SceneRolesState,
  SelfView,
  SetAnchorRequest,
  StageState,
  TurnOutcomeKind,
  UpdateMemoryRequest,
  UpdatePersonRequest,
  UpsertRoleRequest,
  UsageInfo,
  VoiceState,
  WorldView,
} from "@miyoria/contracts/api";
import type { PendingApproval } from "@miyoria/gate/actions";
import type { DecisionRecord, RoleAssignment, RoleDefinition, RoleMapping } from "@miyoria/store";
import type {
  ActivitySnapshot,
  ActivityTask,
  AffectSnapshot,
  ArbiterVerdict,
  ContextKey,
  LedgerView,
  PlatformId,
  SavedPrompt,
  ThoughtDigest,
  TurnOutcomeRecord,
} from "@miyoria/types";
import { call } from "./http.js";

/** Query of `GET /api/memory`, as a caller writes it (numbers and flags, not their text). */
type MemoryListQuery = {
  q?: string;
  kind?: MemoryItem["record"]["kind"];
  subject?: string;
  before?: string;
  include_superseded?: boolean;
  limit?: number;
};

type Query = Record<string, string | number | boolean | undefined>;

function withQuery(path: string, query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text === "" ? path : `${path}?${text}`;
}

const seg = encodeURIComponent;

export function adminCalls(base: string, token: string) {
  const get = <T>(path: string, query?: Query) =>
    call<T>(base, token, "GET", withQuery(path, query));
  const send = <T>(method: string, path: string, json?: unknown) =>
    call<T>(base, token, method, path, json);
  return {
    // ---- people
    people: (query: { q?: string; limit?: number; cursor?: string } = {}) =>
      get<PersonPage>("/api/people", query),
    person: (id: string, query: { limit?: number } = {}) =>
      get<PersonProfile>(`/api/people/${seg(id)}`, query),
    personHistory: (id: string, query: { before?: string; limit?: number } = {}) =>
      get<HeartHistoryPage>(`/api/people/${seg(id)}/history`, query),
    updatePerson: (id: string, request: UpdatePersonRequest) =>
      send<PersonRow>("PATCH", `/api/people/${seg(id)}`, request),
    adjustPerson: (id: string, request: AdjustPersonRequest) =>
      send<PersonRow>("POST", `/api/people/${seg(id)}/adjust`, request),
    setAnchor: (id: string, tier: number, request: SetAnchorRequest) =>
      send<PersonAnchor[]>("PUT", `/api/people/${seg(id)}/anchors/${tier}`, request),
    removeAnchor: (id: string, tier: number) =>
      send<PersonAnchor[]>("DELETE", `/api/people/${seg(id)}/anchors/${tier}`),

    // ---- memory
    memory: (query: MemoryListQuery = {}) => get<MemoryPage>("/api/memory", query),
    updateMemory: (id: string, request: UpdateMemoryRequest) =>
      send<MemoryRecordView>("PATCH", `/api/memory/${seg(id)}`, request),
    deleteMemory: (id: string) => send<void>("DELETE", `/api/memory/${seg(id)}`),

    // ---- modules, decisions, LLM usage
    modules: () => get<ModuleInfo[]>("/api/modules"),
    moduleAction: (id: string, action: string) =>
      send<ModuleInfo>("POST", `/api/modules/${seg(id)}/${seg(action)}`),
    decisions: (limit: number) => get<DecisionRecord[]>("/api/decisions", { limit }),
    decisionsIn: (context: ContextKey | null, limit: number) =>
      get<DecisionRecord[]>("/api/decisions", {
        limit,
        context: context ? JSON.stringify(context) : undefined,
      }),
    usage: async () => {
      const raw = await get<Record<string, UsageInfo>>("/api/llm/usage");
      return new Map(
        Object.keys(raw)
          .sort()
          .map((k) => [k, raw[k] as UsageInfo]),
      );
    },

    cost: () => get<CostInfo>("/api/llm/cost"),

    // ---- roles
    roles: () => get<RoleDefinition[]>("/api/auth/roles"),
    role: (name: string) => get<RoleDefinition>(`/api/auth/roles/${seg(name)}`),
    upsertRole: (name: string, request: UpsertRoleRequest) =>
      send<RoleDefinition>("PUT", `/api/auth/roles/${seg(name)}`, request),
    deleteRole: (name: string) => send<void>("DELETE", `/api/auth/roles/${seg(name)}`),
    assignments: () => get<RoleAssignment[]>("/api/auth/assignments"),
    assignRole: (request: AssignRoleRequest) =>
      send<RoleAssignment>("POST", "/api/auth/assignments", request),
    revokeRole: (request: AssignRoleRequest) =>
      send<void>("DELETE", "/api/auth/assignments", request),
    mappings: (platform: PlatformId, guild: string) =>
      get<RoleMapping[]>("/api/auth/mappings", { platform, guild }),
    setMapping: (mapping: RoleMapping) => send<RoleMapping>("PUT", "/api/auth/mappings", mapping),
    removeMapping: (request: RemoveMappingRequest) =>
      send<void>("DELETE", "/api/auth/mappings", request),

    // ---- mind
    mind: () => get<MindView>("/api/mind"),
    thoughts: (limit = 50) => get<unknown[]>("/api/mind/thoughts", { limit }),
    approvals: () => get<PendingApproval[]>("/api/mind/approvals"),
    answerApproval: (id: string, approved: boolean) =>
      send<PendingApproval[]>(
        "POST",
        `/api/mind/approvals/${seg(id)}/${approved ? "approve" : "deny"}`,
      ),
    autonomyPause: (paused: boolean) =>
      send<MindView>("POST", `/api/mind/${paused ? "pause" : "resume"}`),

    // ---- body, arbiter, what she organized and learned
    activity: () => get<ActivitySnapshot>("/api/activity"),
    activityTasks: (limit = 20) => get<ActivityTask[]>("/api/activity/tasks", { limit }),
    ledger: (context: ContextKey | null = null, limit = 50) =>
      get<LedgerView>("/api/arbiter/ledger", {
        limit,
        context: context ? JSON.stringify(context) : undefined,
      }),
    arbiterDecisions: (
      q: { limit?: number; context?: ContextKey | null; verdict?: ArbiterVerdict } = {},
    ) =>
      get<ArbiterDecisionsView>("/api/arbiter/decisions", {
        limit: q.limit,
        context: q.context ? JSON.stringify(q.context) : undefined,
        verdict: q.verdict,
      }),
    digests: (limit = 20) => get<ThoughtDigest[]>("/api/mind/digests", { limit }),
    knowledge: () => get<KnowledgeView>("/api/knowledge"),
    conversationNotes: () => get<ConversationNoteView[]>("/api/knowledge/conversations"),
    reflection: (days = 7) => get<ReflectionView>("/api/reflection", { days }),

    // ---- her inner life, her mood and her plans
    self: () => get<SelfView>("/api/self"),
    world: () => get<WorldView>("/api/world"),
    affect: () => get<AffectSnapshot>("/api/affect"),
    goals: (closed = false) =>
      get<GoalsView>("/api/mind/goals", { closed: closed ? "true" : undefined }),

    // ---- what she was told and how her turns ended
    prompts: (context: ContextKey | null = null, limit = 30) =>
      get<PromptSummary[]>("/api/prompts", {
        limit,
        context: context ? JSON.stringify(context) : undefined,
      }),
    prompt: (turn: string) => get<SavedPrompt>(`/api/prompts/${seg(turn)}`),
    turnOutcomes: (
      q: { limit?: number; context?: ContextKey | null; outcome?: TurnOutcomeKind } = {},
    ) =>
      get<TurnOutcomeRecord[]>("/api/turns/outcomes", {
        limit: q.limit,
        context: q.context ? JSON.stringify(q.context) : undefined,
        outcome: q.outcome,
      }),

    // ---- extensions and MCP
    extensions: () => get<ExtensionInfo[]>("/api/extensions"),
    extensionAction: (id: string, action: string) =>
      send<ExtensionInfo>("POST", `/api/extensions/${seg(id)}/${seg(action)}`),
    mcpServers: () => get<McpServerInfo[]>("/api/mcp"),
    mcpAction: (name: string, action: string) =>
      send<McpServerInfo>("POST", `/api/mcp/${seg(name)}/${seg(action)}`),

    // ---- request queue
    queue: () => get<QueueState>("/api/queue"),
    queueSkip: (id: string) => send<QueueState>("POST", `/api/queue/${seg(id)}/skip`),
    queueMove: (id: string, position: number) =>
      send<QueueState>("POST", `/api/queue/${seg(id)}/move`, { position }),
    queuePause: (paused: boolean) =>
      send<QueueState>("POST", `/api/queue/${paused ? "pause" : "resume"}`),

    // ---- stage and voice
    stage: () => get<StageState>("/api/stage"),
    stageScene: (scene: string) => send<StageState>("POST", "/api/stage/scene", { scene }),
    stageExpression: (expression: string) =>
      send<StageState>("POST", "/api/stage/expression", { expression }),
    stageStream: (action: "start" | "stop") =>
      send<StageState>("POST", "/api/stage/stream", { action }),
    sceneRoles: () => get<SceneRolesState>("/api/stage/scenes"),
    setSceneRole: (role: string, scene: string | null) =>
      send<SceneRolesState>("PUT", "/api/stage/scenes", { role, scene }),
    classifyScenes: () => send<SceneRolesState>("POST", "/api/stage/scenes/classify"),
    stageSay: (text: string, emotion: string | null = null) =>
      send<SayResponse>("POST", "/api/stage/say", emotion === null ? { text } : { text, emotion }),
    voice: () => get<VoiceState>("/api/voice"),
  };
}
