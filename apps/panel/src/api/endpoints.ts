// One function per Admin API route (`packages/api/src`). To add an endpoint: put its wire
// types in `types.ts`, add a function here and a query key + hook in `app/queries.ts`.

import { type ApiClient, seg } from "./http";
import type {
  AdjustPersonRequest,
  AssignRoleRequest,
  AuthMethods,
  ChannelLevelsView,
  ChannelLevelView,
  ContextKey,
  CostReport,
  DataCategoryId,
  DataInventory,
  DataWipeResult,
  AddDirectiveRequest,
  CauseChain,
  Delivery,
  DirectiveChange,
  DirectivesView,
  ExtensionInfo,
  FactEventsQuery,
  LogEvent,
  McpServerInfo,
  MemoryItem,
  MemoryQuery,
  MemoryRecordView,
  Page,
  PeopleQuery,
  PersonDetail,
  PersonSummary,
  QueueState,
  RemoveMappingRequest,
  RoleAssignment,
  RoleDefinition,
  RoleMapping,
  SayRequest,
  SceneRolesState,
  StageState,
  StreamAction,
  UpdateMemoryRequest,
  UpdatePersonRequest,
  UpsertRoleRequest,
  PersonWalletView,
  WalletAdjustRequest,
  WalletAdjustResult,
  VoiceState,
  SelfView,
  WorldView,
  MindView,
  PendingApproval,
  Thought,
  ThoughtDigest,
  KnowledgeView,
  ConversationNote,
  ReflectionView,

  DecisionRecord,
  DecisionsQuery,
  HealthInfo,
  ModuleAction,
  ModuleInfo,
  IssuedCard,
  BoardView,
  BountyView,
  FortuneDraw,
  FortuneToday,
  GoalView,
  PledgeResult,
  TransferResult,
  CheckinResult,
  FeedItem,
  FeedResult,
  FramesResult,
  GiftExpression,
  MemberCards,
  MemberForgetResult,
  MemberSession,
  MemberView,
  SpendResult,
  WalletView,
  PersonaOverride,
  PersonaSectionInfo,
  PublicSongs,
  PublicStatus,
  SessionInfo,
  SetPersonaRequest,
  SetPersonaResponse,
  UsageMap,
  ControlResult,
  GameStartRequest,
  SongsState,
  TelemetryView,
  LlmCallDetail,
  LlmCallRecord,
  LlmCallsPage,
  LlmCallsQuery,
  LlmCallStats,
  ActivitySnapshot,
  ActivityTask,
  AffectSnapshot,
  ArbiterDecisionsView,
  ArbiterVerdict,
  DayPlanView,
  GoalsView,
  LedgerView,
  PersonCard,
  PromptSummary,
  SavedPrompt,
  TurnMetrics,
  TurnOutcomeKind,
  TurnOutcomeRecord,
} from "./types";

type Opts = { signal?: AbortSignal };

/** A spend: the member routes, with its idempotency key. */
const spend = (key: string) => ({ public: true, headers: { "Idempotency-Key": key } });

export function createApi(client: ApiClient) {
  return {
    health: (o?: Opts) => client.get<HealthInfo>("/api/health", { ...o, public: true }),

    // panel login
    authMethods: (o?: Opts) => client.get<AuthMethods>("/api/auth/methods", { ...o, public: true }),
    session: (o?: Opts) => client.get<SessionInfo>("/api/auth/session", o),
    /** Ends the Discord session (clears the cookie); harmless for the token. */
    logout: () => client.post<void>("/api/auth/logout", undefined, { public: true }),
    /** Where the browser goes to start a Discord login; `next` is a local path such as `/people`. */
    discordLoginUrl: (next: string) => client.url("/api/auth/oauth/login", { next }),

    // what anyone may see, and what a logged-in person has of their own: the cookie alone
    publicStatus: (o?: Opts) => client.get<PublicStatus>("/api/public/status", { ...o, public: true }),
    publicSongs: (o?: Opts) => client.get<PublicSongs>("/api/public/songs", { ...o, public: true }),
    memberSession: (o?: Opts) => client.get<MemberSession>("/api/member/session", { ...o, public: true }),
    memberMe: (o?: Opts) => client.get<MemberView>("/api/member/me", { ...o, public: true }),
    memberExportUrl: () => client.url("/api/member/export"),
    memberForget: () => client.post<MemberForgetResult>("/api/member/forget", { confirm: true }, { public: true }),
    memberRequestSong: (query: string) =>
      client.post<{ accepted: boolean }>("/api/member/songs", { query }, { public: true }),
    memberCards: (o?: Opts) => client.get<MemberCards>("/api/member/card", { ...o, public: true }),
    memberIssueCard: (req: { pose?: string; foil?: boolean } = {}, key?: string) =>
      client.post<IssuedCard>("/api/member/card", req, key ? spend(key) : { public: true }),
    memberRerollCard: (key: string) =>
      client.post<IssuedCard>("/api/member/card/reroll", {}, spend(key)),
    memberWallet: (o?: Opts) => client.get<WalletView>("/api/member/wallet", { ...o, public: true }),
    memberCheckin: () => client.post<CheckinResult>("/api/member/checkin", {}, { public: true }),
    // Spends carry one key per click, so a retried request is charged once.
    memberFeed: (item: FeedItem, count: number, key: string) =>
      client.post<FeedResult>("/api/member/feed", { item, count }, spend(key)),
    memberLetter: (text: string, key: string) =>
      client.post<SpendResult>("/api/member/letter", { text }, spend(key)),
    memberExpression: (expression: GiftExpression, key: string) =>
      client.post<SpendResult>("/api/member/expression", { expression }, spend(key)),
    memberFrame: (req: { buy?: string; select?: string | null }, key: string) =>
      client.post<FramesResult>("/api/member/frame", req, spend(key)),
    memberScreen: (text: string, key: string) =>
      client.post<SpendResult>("/api/member/screen", { text }, spend(key)),
    memberFortune: (o?: Opts) => client.get<FortuneToday>("/api/member/fortune", { ...o, public: true }),
    memberDrawFortune: (key: string) => client.post<FortuneDraw>("/api/member/fortune", {}, spend(key)),
    memberTransfer: (to_discord_id: string, amount: number, key: string) =>
      client.post<TransferResult>("/api/member/transfer", { to_discord_id, amount }, spend(key)),
    memberBoard: (on: boolean) => client.post<{ on_board: boolean }>("/api/member/board", { on }, { public: true }),
    publicBoard: (o?: Opts) => client.get<BoardView>("/api/public/board", { ...o, public: true }),
    memberGoals: (o?: Opts) => client.get<{ goals: GoalView[] }>("/api/member/goals", { ...o, public: true }),
    memberPledge: (id: string, amount: number, key: string) =>
      client.post<PledgeResult>(`/api/member/goals/${seg(id)}/pledge`, { amount }, spend(key)),
    memberBounties: (o?: Opts) =>
      client.get<{ bounties: BountyView[] }>("/api/member/bounties", { ...o, public: true }),
    publicCard: (serial: string, o?: Opts) =>
      client.get<IssuedCard>(`/api/public/card/${seg(serial)}`, { ...o, public: true }),

    modules: (o?: Opts) => client.get<ModuleInfo[]>("/api/modules", o),
    moduleAction: (id: string, action: ModuleAction) =>
      client.post<ModuleInfo>(`/api/modules/${seg(id)}/${action}`),

    decisions: (q: DecisionsQuery = {}, o?: Opts) =>
      client.get<DecisionRecord[]>("/api/decisions", {
        ...o,
        query: { limit: q.limit, context: q.context ? JSON.stringify(q.context) : undefined },
      }),

    llmUsage: (o?: Opts) => client.get<UsageMap>("/api/llm/usage", o),

    persona: (o?: Opts) => client.get<PersonaSectionInfo[]>("/api/persona", o),
    setPersonaSection: (key: string, req: SetPersonaRequest) =>
      client.put<SetPersonaResponse>(`/api/persona/${seg(key)}`, req),
    personaHistory: (key: string, o?: Opts) =>
      client.get<PersonaOverride[]>(`/api/persona/${seg(key)}/history`, o),

    llmCost: (o?: Opts) => client.get<CostReport>("/api/llm/cost", o),

    people: (q: PeopleQuery = {}, o?: Opts) =>
      client.get<Page<PersonSummary>>("/api/people", { ...o, query: { ...q } }),
    person: (id: string, o?: Opts) => client.get<PersonDetail>(`/api/people/${seg(id)}`, o),
    updatePerson: (id: string, req: UpdatePersonRequest) =>
      client.patch<PersonSummary>(`/api/people/${seg(id)}`, req),
    adjustPerson: (id: string, req: AdjustPersonRequest) =>
      client.post<PersonSummary>(`/api/people/${seg(id)}/adjust`, req),
    personWallet: (id: string, o?: Opts) => client.get<PersonWalletView>(`/api/people/${seg(id)}/wallet`, o),
    adjustWallet: (id: string, req: WalletAdjustRequest) =>
      client.post<WalletAdjustResult>(`/api/people/${seg(id)}/wallet/adjust`, req),

    memory: (q: MemoryQuery = {}, o?: Opts) =>
      client.get<Page<MemoryItem>>("/api/memory", { ...o, query: { ...q } }),
    updateMemory: (id: string, req: UpdateMemoryRequest) =>
      client.patch<MemoryRecordView>(`/api/memory/${seg(id)}`, req),
    deleteMemory: (id: string) => client.delete<void>(`/api/memory/${seg(id)}`),

    roles: (o?: Opts) => client.get<RoleDefinition[]>("/api/auth/roles", o),
    assignments: (o?: Opts) => client.get<RoleAssignment[]>("/api/auth/assignments", o),
    assignRole: (req: AssignRoleRequest) =>
      client.post<RoleAssignment>("/api/auth/assignments", req),
    revokeRole: (req: AssignRoleRequest) =>
      client.delete<void>("/api/auth/assignments", { body: req }),
    role: (name: string, o?: Opts) => client.get<RoleDefinition>(`/api/auth/roles/${seg(name)}`, o),
    upsertRole: (name: string, req: UpsertRoleRequest) =>
      client.put<RoleDefinition>(`/api/auth/roles/${seg(name)}`, req),
    deleteRole: (name: string) => client.delete<void>(`/api/auth/roles/${seg(name)}`),
    mappings: (platform: string, guild: string, o?: Opts) =>
      client.get<RoleMapping[]>("/api/auth/mappings", { ...o, query: { platform, guild } }),
    setMapping: (req: RoleMapping) => client.put<RoleMapping>("/api/auth/mappings", req),
    removeMapping: (req: RemoveMappingRequest) =>
      client.delete<void>("/api/auth/mappings", { body: req }),

    extensions: (o?: Opts) => client.get<ExtensionInfo[]>("/api/extensions", o),
    extensionAction: (id: string, action: "enable" | "disable" | "restart") =>
      client.post<ExtensionInfo>(`/api/extensions/${seg(id)}/${action}`),

    mcpServers: (o?: Opts) => client.get<McpServerInfo[]>("/api/mcp", o),
    /** Only `restart` exists at runtime; servers are turned on and off in `miyoria.toml`. */
    mcpRestart: (name: string) => client.post<McpServerInfo>(`/api/mcp/${seg(name)}/restart`),

    queue: (o?: Opts) => client.get<QueueState>("/api/queue", o),
    queueSkip: (id: string) => client.post<QueueState>(`/api/queue/${seg(id)}/skip`),
    queueMove: (id: string, position: number) =>
      client.post<QueueState>(`/api/queue/${seg(id)}/move`, { position }),
    queuePause: (paused: boolean) =>
      client.post<QueueState>(`/api/queue/${paused ? "pause" : "resume"}`),

    stage: (o?: Opts) => client.get<StageState>("/api/stage", o),
    stageScene: (scene: string) => client.post<StageState>("/api/stage/scene", { scene }),
    stageExpression: (expression: string) =>
      client.post<StageState>("/api/stage/expression", { expression }),
    stageStream: (action: StreamAction) => client.post<StageState>("/api/stage/stream", { action }),
    stageSay: (req: SayRequest) => client.post<{ turn: string | null }>("/api/stage/say", req),
    sceneRoles: (o?: Opts) => client.get<SceneRolesState>("/api/stage/scenes", o),
    setSceneRole: (role: string, scene: string | null) =>
      client.put<SceneRolesState>("/api/stage/scenes", { role, scene }),
    classifyScenes: () => client.post<SceneRolesState>("/api/stage/scenes/classify"),

    voice: (o?: Opts) => client.get<VoiceState>("/api/voice", o),

    self: (o?: Opts) => client.get<SelfView>("/api/self", o),
    world: (o?: Opts) => client.get<WorldView>("/api/world", o),
    channelLevels: (o?: Opts) => client.get<ChannelLevelsView>("/api/channels/levels", o),
    /** `mode` `null` goes back to the configured level. */
    setChannelLevel: (context: ContextKey, mode: string | null) =>
      client.put<ChannelLevelView>("/api/channels/level", { context, mode }),

    // her data
    dataInventory: (o?: Opts) => client.get<DataInventory>("/api/data", o),
    /** A JSON backup of `categories` (all exportable ones without). */
    dataExport: (categories?: DataCategoryId[]) =>
      client.download("GET", "/api/data/export", { query: { categories: categories?.join(",") } }),
    dataWipe: (categories: DataCategoryId[], confirm?: string) =>
      client.post<DataWipeResult>("/api/data/wipe", { categories, confirm }),
    /** The full backup a reset needs; its `x-miyoria-backup-token` header unlocks the reset. */
    dataBackup: () => client.download("POST", "/api/data/backup"),
    dataReset: (confirm: string, backupToken: string) =>
      client.post<DataWipeResult>("/api/data/reset", { confirm, backup_token: backupToken }),
    mind: (o?: Opts) => client.get<MindView>("/api/mind", o),
    thoughts: (limit: number, o?: Opts) =>
      client.get<Thought[]>(`/api/mind/thoughts?limit=${limit}`, o),
    approvals: (o?: Opts) => client.get<PendingApproval[]>("/api/mind/approvals", o),
    answerApproval: (id: string, approved: boolean) =>
      client.post<PendingApproval[]>(`/api/mind/approvals/${seg(id)}/${approved ? "approve" : "deny"}`),
    autonomyPause: (paused: boolean) => client.post<MindView>(`/api/mind/${paused ? "pause" : "resume"}`),
    digests: (limit: number, o?: Opts) => client.get<ThoughtDigest[]>(`/api/mind/digests?limit=${limit}`, o),
    knowledge: (o?: Opts) => client.get<KnowledgeView>("/api/knowledge", o),
    conversationNotes: (o?: Opts) => client.get<ConversationNote[]>("/api/knowledge/conversations", o),
    reflection: (days: number, o?: Opts) => client.get<ReflectionView>(`/api/reflection?days=${days}`, o),

    // live controls (through the actuator gate as the panel)
    voiceJoin: (guild: string, channel: string | null) =>
      client.post<ControlResult>("/api/voice/join", { guild, channel }),
    voiceLeave: (guild?: string) => client.post<ControlResult>("/api/voice/leave", { guild: guild ?? null }),
    goLive: (action: StreamAction, guild?: string) =>
      client.post<ControlResult>("/api/voice/golive", { action, guild: guild ?? null }),
    songs: (o?: Opts) => client.get<SongsState>("/api/songs", o),
    requestSong: (query: string, key?: number) =>
      client.post<SongsState & ControlResult>("/api/songs", { query, key: key ?? null }),
    playSong: (song?: number) => client.post<SongsState & ControlResult>("/api/songs/play", { song: song ?? null }),
    stopSong: (all: boolean) => client.post<SongsState & ControlResult>("/api/songs/stop", { all }),
    gameStart: (req: GameStartRequest) => client.post<ControlResult>("/api/game/start", req),
    gameStop: () => client.post<ControlResult>("/api/game/stop", {}),
    gameGoal: (text: string) => client.post<ControlResult>("/api/game/goal", { text }),

    thought: (id: string, o?: Opts) => client.get<Thought>(`/api/mind/thoughts/${seg(id)}`, o),
    llmCalls: (q: LlmCallsQuery, limit: number, before: string | null, o?: Opts) =>
      client.get<LlmCallsPage>("/api/llm/calls", {
        ...o,
        query: {
          purpose: q.purpose,
          model: q.model,
          module: q.module,
          status: q.status,
          trouble: q.trouble ? "true" : undefined,
          thought: q.thought,
          turn: q.turn,
          since: q.since,
          q: q.q,
          limit,
          before: before ?? undefined,
        },
      }),
    llmCall: (id: string, o?: Opts) =>
      client.get<{ call: LlmCallRecord; detail: LlmCallDetail | null }>(`/api/llm/calls/${seg(id)}`, o),
    llmStats: (minutes: number | null, o?: Opts) =>
      client.get<LlmCallStats>("/api/llm/stats", { ...o, query: { minutes: minutes ?? undefined } }),

    // body, arbiter, affect, plan, prompts
    activity: (o?: Opts) => client.get<ActivitySnapshot>("/api/activity", o),
    activityTasks: (limit: number, o?: Opts) =>
      client.get<ActivityTask[]>("/api/activity/tasks", { ...o, query: { limit } }),
    ledger: (context: ContextKey | undefined, limit: number, o?: Opts) =>
      client.get<LedgerView>("/api/arbiter/ledger", {
        ...o,
        query: { limit, context: context ? JSON.stringify(context) : undefined },
      }),
    arbiterDecisions: (q: { limit?: number; verdict?: ArbiterVerdict; context?: ContextKey }, o?: Opts) =>
      client.get<ArbiterDecisionsView>("/api/arbiter/decisions", {
        ...o,
        query: { limit: q.limit, verdict: q.verdict, context: q.context ? JSON.stringify(q.context) : undefined },
      }),
    affect: (o?: Opts) => client.get<AffectSnapshot>("/api/affect", o),
    affectPeople: (o?: Opts) => client.get<PersonCard[]>("/api/affect/people", o),
    goals: (closed: boolean, o?: Opts) =>
      client.get<GoalsView>("/api/mind/goals", { ...o, query: { closed: closed ? "true" : undefined } }),
    dayPlan: (o?: Opts) => client.get<DayPlanView>("/api/mind/plan", o),
    prompts: (limit: number, context?: ContextKey, o?: Opts) =>
      client.get<PromptSummary[]>("/api/prompts", {
        ...o,
        query: { limit, context: context ? JSON.stringify(context) : undefined },
      }),
    prompt: (turn: string, o?: Opts) => client.get<SavedPrompt>(`/api/prompts/${seg(turn)}`, o),
    turnOutcomes: (q: { limit?: number; outcome?: TurnOutcomeKind; context?: ContextKey }, o?: Opts) =>
      client.get<TurnOutcomeRecord[]>("/api/turns/outcomes", {
        ...o,
        query: { limit: q.limit, outcome: q.outcome, context: q.context ? JSON.stringify(q.context) : undefined },
      }),

    turnMetrics: (days: number, o?: Opts) => client.get<TurnMetrics>("/api/turns/metrics", { ...o, query: { days } }),

    factEvents: (q: FactEventsQuery, o?: Opts) =>
      client.get<LogEvent[]>("/api/facts/events", {
        ...o,
        query: { kind: q.kind?.join(","), source: q.source?.join(","), turn: q.turn, since: q.since, until: q.until, before: q.before, order: q.order, limit: q.limit },
      }),
    factDeliveries: (limit: number, o?: Opts) => client.get<Delivery[]>("/api/facts/deliveries", { ...o, query: { limit } }),

    directives: (history: boolean, o?: Opts) =>
      client.get<DirectivesView>("/api/directives", { ...o, query: { history: history ? "1" : undefined } }),
    addDirective: (req: AddDirectiveRequest) => client.post<DirectiveChange>("/api/directives", req),
    removeDirective: (id: string) => client.delete<DirectiveChange>(`/api/directives/${seg(id)}`),
    factChain: (id: string, o?: Opts) => client.get<CauseChain>(`/api/facts/events/${seg(id)}/chain`, o),
    factEffects: (id: string, limit: number, o?: Opts) =>
      client.get<LogEvent[]>(`/api/facts/events/${seg(id)}/effects`, { ...o, query: { limit } }),

    telemetry: (minutes: number, o?: Opts) =>
      client.get<TelemetryView>("/api/telemetry", { ...o, query: { minutes } }),
  };
}

export type Api = ReturnType<typeof createApi>;
