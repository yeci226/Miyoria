import {
  type Query,
  QueryCache,
  QueryClient,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  skipToken,
  useQueryClient,
} from "@tanstack/react-query";
import { isApiError } from "@/api/http";
import type {
  AddDirectiveRequest,
  AdjustPersonRequest,
  ArbiterVerdict,
  AssignRoleRequest,
  ChannelLevelsView,
  ContextKey,
  DataCategoryId,
  DecisionsQuery,
  E2eRecord,
  FactEventsQuery,
  GameStartRequest,
  LlmCallsQuery,
  MemoryQuery,
  ModuleAction,
  ModuleInfo,
  PeopleQuery,
  QueueState,
  RemoveMappingRequest,
  RoleMapping,
  SayRequest,
  SceneRolesState,
  SetPersonaRequest,
  SongsState,
  StageState,
  StreamAction,
  Timestamp,
  TurnOutcomeKind,
  UpdateMemoryRequest,
  UpdatePersonRequest,
  UpsertRoleRequest,
  WalletAdjustRequest,
} from "@/api/types";
import { type EvalData, loadEvalData } from "@/lib/eval-data";
import { startOfDay } from "@/lib/rules";
import { fetchTurnEvents } from "@/lib/turn-events";
import { useApi } from "./connection";

export const queryKeys = {
  health: ["health"] as const,
  modules: ["modules"] as const,
  decisionsAll: ["decisions"] as const,
  decisions: (q: DecisionsQuery) => ["decisions", q] as const,
  usage: ["llm", "usage"] as const,
  cost: ["llm", "cost"] as const,
  persona: ["persona"] as const,
  personaHistory: (key: string) => ["persona", key, "history"] as const,
  people: (q: PeopleQuery) => ["people", q] as const,
  person: (id: string) => ["people", "detail", id] as const,
  personWallet: (id: string) => ["people", "wallet", id] as const,
  memory: (q: Omit<MemoryQuery, "before">) => ["memory", q] as const,
  roles: ["auth", "roles"] as const,
  assignments: ["auth", "assignments"] as const,
  mappings: (platform: string, guild: string) => ["auth", "mappings", platform, guild] as const,
  extensions: ["extensions"] as const,
  mcp: ["mcp"] as const,
  queue: ["queue"] as const,
  stage: ["stage"] as const,
  sceneRoles: ["stage", "scenes"] as const,
  voice: ["voice"] as const,
  self: ["self"] as const,
  world: ["world"] as const,
  channelLevels: ["channels", "levels"] as const,
  data: ["data"] as const,
  mind: ["mind"] as const,
  thoughts: ["mind", "thoughts"] as const,
  approvals: ["mind", "approvals"] as const,
  digests: ["mind", "digests"] as const,
  knowledge: ["knowledge"] as const,
  conversationNotes: ["knowledge", "conversations"] as const,
  reflection: ["reflection"] as const,
  songs: ["songs"] as const,
  telemetry: (minutes: number) => ["telemetry", minutes] as const,
  activity: ["activity"] as const,
  activityTasks: ["activity", "tasks"] as const,
  arbiter: ["arbiter"] as const,
  ledger: (context: ContextKey | undefined) => ["arbiter", "ledger", context ?? null] as const,
  arbiterDecisions: (q: object) => ["arbiter", "decisions", q] as const,
  affect: ["affect"] as const,
  affectPeople: ["affect", "people"] as const,
  goals: ["mind", "goals"] as const,
  dayPlan: ["mind", "plan"] as const,
  prompts: ["prompts"] as const,
  turnOutcomes: (q: object) => ["turns", "outcomes", q] as const,
  turnsAll: ["turns"] as const,
  turnMetrics: (days: number) => ["turns", "metrics", days] as const,
  turnE2e: (turn: string) => ["e2e", turn] as const,
  factEvents: (q: FactEventsQuery) => ["facts", "events", q] as const,
  factChain: (id: string) => ["facts", "chain", id] as const,
  factEffects: (id: string) => ["facts", "effects", id] as const,
  directives: (history: boolean) => ["directives", history] as const,
  directivesAll: ["directives"] as const,
  evalData: (windowMs: number) => ["facts", "eval", windowMs] as const,
};

/** Errors that retrying cannot fix. */
const FINAL = new Set(["unauthorized", "not_provided", "not_found", "bad_response"]);

/** Polls every `ms`, but stops once the route turned out not to exist or the token is bad. */
const poll =
  (ms: number) =>
  (query: Query<any, any, any, any>): number | false => {
    const e = query.state.error;
    return isApiError(e) && FINAL.has(e.kind) ? false : ms;
  };

export function createQueryClient(onError?: (error: Error) => void): QueryClient {
  const client = new QueryClient({
    queryCache: new QueryCache({ onError: (error) => onError?.(error) }),
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        refetchOnWindowFocus: true,
        retry: (count, error) => !(isApiError(error) && FINAL.has(error.kind)) && count < 2,
      },
      mutations: { retry: false },
    },
  });
  // Voice measurements written from the event stream have no fetcher to bring them back.
  client.setQueryDefaults(["e2e"], { gcTime: Number.POSITIVE_INFINITY, staleTime: Number.POSITIVE_INFINITY });
  return client;
}

// --- system ------------------------------------------------------------------

export function useHealth() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.health, queryFn: ({ signal }) => api.health({ signal }), refetchInterval: poll(15_000) });
}

export function useModules() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.modules, queryFn: ({ signal }) => api.modules({ signal }), refetchInterval: poll(20_000) });
}

export function useModuleAction() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: ModuleAction }) => api.moduleAction(id, action),
    onSuccess: (updated) => {
      qc.setQueryData<ModuleInfo[]>(queryKeys.modules, (list) => list?.map((m) => (m.id === updated.id ? updated : m)));
      void qc.invalidateQueries({ queryKey: queryKeys.modules });
    },
  });
}

export function useExtensions() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.extensions, queryFn: ({ signal }) => api.extensions({ signal }), refetchInterval: poll(30_000) });
}

export function useExtensionAction() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: ModuleAction }) => api.extensionAction(id, action),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.extensions }),
  });
}

export function useMcpServers() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.mcp, queryFn: ({ signal }) => api.mcpServers({ signal }), refetchInterval: poll(30_000) });
}

export function useMcpRestart() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.mcpRestart(name),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.mcp }),
  });
}

// --- activity ----------------------------------------------------------------

export function useDecisions(q: DecisionsQuery) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.decisions(q), queryFn: ({ signal }) => api.decisions(q, { signal }) });
}

export function useUsage() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.usage, queryFn: ({ signal }) => api.llmUsage({ signal }), refetchInterval: poll(30_000) });
}

export function useCost() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.cost, queryFn: ({ signal }) => api.llmCost({ signal }), refetchInterval: poll(60_000) });
}

// --- character ---------------------------------------------------------------

export function usePersona() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.persona, queryFn: ({ signal }) => api.persona({ signal }) });
}

export function usePersonaHistory(key: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.personaHistory(key ?? ""),
    queryFn: ({ signal }) => api.personaHistory(key ?? "", { signal }),
    enabled: Boolean(key),
  });
}

export function useSetPersona() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, req }: { key: string; req: SetPersonaRequest }) => api.setPersonaSection(key, req),
    onSuccess: (_res, { key }) => {
      void qc.invalidateQueries({ queryKey: queryKeys.persona });
      void qc.invalidateQueries({ queryKey: queryKeys.personaHistory(key) });
    },
  });
}

export function usePeople(q: PeopleQuery, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.people(q), queryFn: ({ signal }) => api.people(q, { signal }), enabled });
}

export function usePerson(id: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.person(id ?? ""),
    queryFn: ({ signal }) => api.person(id ?? "", { signal }),
    enabled: Boolean(id),
  });
}

export function useUpdatePerson(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: UpdatePersonRequest) => api.updatePerson(id, req),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["people"] }),
  });
}

export function usePersonWallet(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.personWallet(id),
    queryFn: ({ signal }) => api.personWallet(id, { signal }),
    retry: false,
  });
}

export function useAdjustWallet(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: WalletAdjustRequest) => api.adjustWallet(id, req),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.personWallet(id) }),
  });
}

export function useAdjustPerson(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: AdjustPersonRequest) => api.adjustPerson(id, req),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["people"] }),
  });
}

const MEMORY_PAGE = 50;

/** Newest first, one page at a time: `next_cursor` is the `before` of the next page. */
export function useMemory(q: Omit<MemoryQuery, "before" | "limit">) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: queryKeys.memory(q),
    queryFn: ({ signal, pageParam }) =>
      api.memory({ ...q, limit: MEMORY_PAGE, before: pageParam ?? undefined }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
}

export function useUpdateMemory() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, req }: { id: string; req: UpdateMemoryRequest }) => api.updateMemory(id, req),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["memory"] }),
  });
}

export function useDeleteMemory() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteMemory(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["memory"] }),
  });
}

// --- access ------------------------------------------------------------------

export function useRoles() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.roles, queryFn: ({ signal }) => api.roles({ signal }) });
}

export function useAssignments() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.assignments, queryFn: ({ signal }) => api.assignments({ signal }) });
}

export function useMappings(platform: string, guild: string) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.mappings(platform, guild),
    queryFn: ({ signal }) => api.mappings(platform, guild, { signal }),
    enabled: Boolean(platform && guild),
  });
}

export function useAccessMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const auth = () => void qc.invalidateQueries({ queryKey: ["auth"] });
  return {
    assign: useMutation({ mutationFn: (r: AssignRoleRequest) => api.assignRole(r), onSuccess: auth }),
    revoke: useMutation({ mutationFn: (r: AssignRoleRequest) => api.revokeRole(r), onSuccess: auth }),
    upsertRole: useMutation({
      mutationFn: ({ name, req }: { name: string; req: UpsertRoleRequest }) => api.upsertRole(name, req),
      onSuccess: auth,
    }),
    deleteRole: useMutation({ mutationFn: (name: string) => api.deleteRole(name), onSuccess: auth }),
    setMapping: useMutation({ mutationFn: (m: RoleMapping) => api.setMapping(m), onSuccess: auth }),
    removeMapping: useMutation({ mutationFn: (m: RemoveMappingRequest) => api.removeMapping(m), onSuccess: auth }),
  };
}

// --- live --------------------------------------------------------------------

export function useQueue() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.queue, queryFn: ({ signal }) => api.queue({ signal }), refetchInterval: poll(3_000) });
}

export function useQueueMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const set = (state: QueueState) => qc.setQueryData(queryKeys.queue, state);
  return {
    skip: useMutation({ mutationFn: (id: string) => api.queueSkip(id), onSuccess: set }),
    move: useMutation({
      mutationFn: ({ id, position }: { id: string; position: number }) => api.queueMove(id, position),
      onSuccess: set,
    }),
    pause: useMutation({ mutationFn: (paused: boolean) => api.queuePause(paused), onSuccess: set }),
  };
}

export function useStage() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.stage, queryFn: ({ signal }) => api.stage({ signal }), refetchInterval: poll(5_000) });
}

export function useStageMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const set = (state: StageState) => qc.setQueryData(queryKeys.stage, state);
  return {
    scene: useMutation({ mutationFn: (name: string) => api.stageScene(name), onSuccess: set }),
    expression: useMutation({ mutationFn: (name: string) => api.stageExpression(name), onSuccess: set }),
    stream: useMutation({ mutationFn: (action: StreamAction) => api.stageStream(action), onSuccess: set }),
    say: useMutation({ mutationFn: (req: SayRequest) => api.stageSay(req) }),
  };
}

export function useSceneRoles() {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.sceneRoles,
    queryFn: ({ signal }) => api.sceneRoles({ signal }),
    refetchInterval: poll(15_000),
  });
}

export function useSceneRoleMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const set = (state: SceneRolesState) => qc.setQueryData(queryKeys.sceneRoles, state);
  return {
    set: useMutation({
      mutationFn: ({ role, scene }: { role: string; scene: string | null }) => api.setSceneRole(role, scene),
      onSuccess: set,
    }),
    classify: useMutation({ mutationFn: () => api.classifyScenes(), onSuccess: set }),
  };
}

export function useVoice() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.voice, queryFn: ({ signal }) => api.voice({ signal }), refetchInterval: poll(5_000) });
}

// --- inner life --------------------------------------------------------------

export function useSelf() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.self, queryFn: ({ signal }) => api.self({ signal }), refetchInterval: poll(5_000) });
}

export function useWorld() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.world, queryFn: ({ signal }) => api.world({ signal }), refetchInterval: poll(5_000) });
}

export function useChannelLevels() {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.channelLevels,
    queryFn: ({ signal }) => api.channelLevels({ signal }),
    refetchInterval: poll(15_000),
  });
}

export function useSetChannelLevel() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ context, mode }: { context: ContextKey; mode: string | null }) => api.setChannelLevel(context, mode),
    onSuccess: (row) =>
      qc.setQueryData<ChannelLevelsView>(queryKeys.channelLevels, (old) =>
        old
          ? {
              ...old,
              channels: old.channels.map((c) =>
                c.context.platform === row.context.platform &&
                c.context.scope === row.context.scope &&
                c.context.channel === row.context.channel
                  ? row
                  : c,
              ),
            }
          : old,
      ),
  });
}

// --- data --------------------------------------------------------------------

export function useDataInventory() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.data, queryFn: ({ signal }) => api.dataInventory({ signal }), refetchInterval: poll(30_000) });
}

/** Deletes and the reset change what every page shows: everything is refetched. */
export function useDataMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const all = () => void qc.invalidateQueries();
  return {
    wipe: useMutation({
      mutationFn: ({ categories, confirm }: { categories: DataCategoryId[]; confirm?: string }) => api.dataWipe(categories, confirm),
      onSuccess: all,
    }),
    reset: useMutation({
      mutationFn: ({ confirm, token }: { confirm: string; token: string }) => api.dataReset(confirm, token),
      onSuccess: all,
    }),
  };
}
export function useMind() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.mind, queryFn: ({ signal }) => api.mind({ signal }), refetchInterval: poll(5_000) });
}

export function useThoughts(limit = 50) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.thoughts,
    queryFn: ({ signal }) => api.thoughts(limit, { signal }),
    refetchInterval: poll(5_000),
  });
}

export function useDigests(limit = 20) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.digests, queryFn: ({ signal }) => api.digests(limit, { signal }), refetchInterval: poll(60_000) });
}

export function useKnowledge() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.knowledge, queryFn: ({ signal }) => api.knowledge({ signal }), refetchInterval: poll(15_000) });
}

export function useConversationNotes() {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.conversationNotes,
    queryFn: ({ signal }) => api.conversationNotes({ signal }),
    refetchInterval: poll(15_000),
  });
}

export function useReflection(days = 7) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.reflection, queryFn: ({ signal }) => api.reflection(days, { signal }), refetchInterval: poll(30_000) });
}

export function useApprovals() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.approvals, queryFn: ({ signal }) => api.approvals({ signal }), refetchInterval: poll(5_000) });
}

export function useMindMutations() {
  const api = useApi();
  const qc = useQueryClient();
  return {
    pause: useMutation({
      mutationFn: (paused: boolean) => api.autonomyPause(paused),
      onSuccess: (view) => qc.setQueryData(queryKeys.mind, view),
    }),
    answer: useMutation({
      mutationFn: ({ id, approved }: { id: string; approved: boolean }) => api.answerApproval(id, approved),
      onSuccess: (pending) => {
        qc.setQueryData(queryKeys.approvals, pending);
        void qc.invalidateQueries({ queryKey: queryKeys.mind });
      },
    }),
  };
}

// --- live controls -----------------------------------------------------------

export function useSongs() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.songs, queryFn: ({ signal }) => api.songs({ signal }), refetchInterval: poll(3_000) });
}

export function useSongMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const set = (s: SongsState) => qc.setQueryData<SongsState>(queryKeys.songs, { playing: s.playing, paused: s.paused, songs: s.songs });
  return {
    request: useMutation({ mutationFn: ({ query, key }: { query: string; key?: number }) => api.requestSong(query, key), onSuccess: set }),
    play: useMutation({ mutationFn: (song?: number) => api.playSong(song), onSuccess: set }),
    stop: useMutation({ mutationFn: (all: boolean) => api.stopSong(all), onSuccess: set }),
  };
}

/** Voice, Go Live and the game change what `world`, `voice` and `stage` report. */
export function useLiveControls() {
  const api = useApi();
  const qc = useQueryClient();
  const refresh = () => {
    for (const key of [queryKeys.world, queryKeys.voice, queryKeys.stage]) void qc.invalidateQueries({ queryKey: key });
  };
  return {
    join: useMutation({
      mutationFn: ({ guild, channel }: { guild: string; channel: string | null }) => api.voiceJoin(guild, channel),
      onSuccess: refresh,
    }),
    leave: useMutation({ mutationFn: (guild?: string) => api.voiceLeave(guild), onSuccess: refresh }),
    goLive: useMutation({
      mutationFn: ({ action, guild }: { action: StreamAction; guild?: string }) => api.goLive(action, guild),
      onSuccess: refresh,
    }),
    gameStart: useMutation({ mutationFn: (req: GameStartRequest) => api.gameStart(req), onSuccess: refresh }),
    gameStop: useMutation({ mutationFn: () => api.gameStop(), onSuccess: refresh }),
    gameGoal: useMutation({ mutationFn: (text: string) => api.gameGoal(text), onSuccess: refresh }),
  };
}

// --- charts ------------------------------------------------------------------

/** A minute's samples for the last `minutes`; older Cores answer 404 and the charts say so. */
export function useTelemetry(minutes: number) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.telemetry(minutes),
    queryFn: ({ signal }) => api.telemetry(minutes, { signal }),
    refetchInterval: poll(60_000),
    placeholderData: (prev) => prev,
  });
}

/** One thought in full (what it saw, the reasoning). */
export function useThought(id: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: [...queryKeys.thoughts, "one", id ?? ""],
    queryFn: ({ signal }) => api.thought(id ?? "", { signal }),
    enabled: Boolean(id),
    refetchInterval: poll(10_000),
  });
}

const LLM_PAGE = 100;

/** The call inspector, newest first, one page at a time. */
export function useLlmCalls(q: LlmCallsQuery) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: ["llm", "calls", q],
    queryFn: ({ signal, pageParam }) => api.llmCalls(q, LLM_PAGE, pageParam, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    refetchInterval: poll(10_000),
    // A new filter keeps the old rows until the new ones arrive.
    placeholderData: (prev) => prev,
  });
}

export function useLlmCall(id: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: ["llm", "call", id ?? ""],
    queryFn: ({ signal }) => api.llmCall(id ?? "", { signal }),
    enabled: Boolean(id),
    refetchInterval: (query) => (query.state.data?.call.status === "streaming" ? 2_000 : false),
  });
}

/** Breakdowns of the calls in the last `minutes` (`null`: every kept call). */
export function useLlmStats(minutes: number | null) {
  const api = useApi();
  return useQuery({
    queryKey: ["llm", "stats", minutes],
    queryFn: ({ signal }) => api.llmStats(minutes, { signal }),
    refetchInterval: poll(30_000),
    placeholderData: (prev) => prev,
  });
}

/** Up to 300 thoughts for the per-hour chart (the journal shows the newest 50). */
export function useThoughtHistory() {
  const api = useApi();
  return useQuery({
    queryKey: [...queryKeys.thoughts, "history"],
    queryFn: ({ signal }) => api.thoughts(300, { signal }),
    refetchInterval: poll(60_000),
  });
}

/** Details (with the affinity history) of several people at once. */
export function usePeopleDetails(ids: string[]) {
  const api = useApi();
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: queryKeys.person(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.person(id, { signal }),
    })),
  });
}


// --- body, arbiter, affect, plan, prompts -----------------------------------------
// Older Cores answer 404 and a stopped module 503: `poll` then stops asking.

/** Presence, broadcast, activity and scene. Kept fresh by `activity.changed`. */
export function useActivity() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.activity, queryFn: ({ signal }) => api.activity({ signal }), refetchInterval: poll(10_000) });
}

export function useActivityTasks(limit = 20) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.activityTasks,
    queryFn: ({ signal }) => api.activityTasks(limit, { signal }),
    refetchInterval: poll(10_000),
  });
}

export function useLedger(context?: ContextKey, limit = 50) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.ledger(context),
    queryFn: ({ signal }) => api.ledger(context, limit, { signal }),
    refetchInterval: poll(10_000),
  });
}

export function useArbiterDecisions(q: { limit?: number; verdict?: ArbiterVerdict; context?: ContextKey }) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.arbiterDecisions(q),
    queryFn: ({ signal }) => api.arbiterDecisions(q, { signal }),
    refetchInterval: poll(15_000),
  });
}

export function useAffect() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.affect, queryFn: ({ signal }) => api.affect({ signal }), refetchInterval: poll(10_000) });
}

export function useAffectPeople() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.affectPeople, queryFn: ({ signal }) => api.affectPeople({ signal }), refetchInterval: poll(30_000) });
}

export function useGoals(closed: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: [...queryKeys.goals, closed],
    queryFn: ({ signal }) => api.goals(closed, { signal }),
    refetchInterval: poll(15_000),
  });
}

export function useDayPlan() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.dayPlan, queryFn: ({ signal }) => api.dayPlan({ signal }), refetchInterval: poll(60_000) });
}

export function usePrompts(limit = 30) {
  const api = useApi();
  return useQuery({
    queryKey: [...queryKeys.prompts, "list", limit],
    queryFn: ({ signal }) => api.prompts(limit, undefined, { signal }),
    refetchInterval: poll(15_000),
  });
}

/** The saved prompt of one turn; `404` when it is too old or was not kept. */
export function usePrompt(turn: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: [...queryKeys.prompts, "one", turn ?? ""],
    queryFn: ({ signal }) => api.prompt(turn ?? "", { signal }),
    enabled: Boolean(turn),
    retry: false,
  });
}

export function useTurnOutcomes(q: { limit?: number; outcome?: TurnOutcomeKind; context?: ContextKey } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.turnOutcomes(q),
    queryFn: ({ signal }) => api.turnOutcomes(q, { signal }),
    refetchInterval: poll(15_000),
  });
}

/** The V4 participation measures per local day (`GET /api/turns/metrics`). */
export function useTurnMetrics(days: number) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.turnMetrics(days),
    queryFn: ({ signal }) => api.turnMetrics(days, { signal }),
    refetchInterval: poll(60_000),
    placeholderData: (prev) => prev,
    retry: false,
  });
}

// --- fact layer ----------------------------------------------------------------

/** EventLog lines (`GET /api/facts/events`); `every` re-reads on that interval, `false` once. */
export function useFactEvents(q: FactEventsQuery, every: number | false = false, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.factEvents(q),
    queryFn: ({ signal }) => api.factEvents(q, { signal }),
    refetchInterval: every === false ? false : poll(every),
    placeholderData: (prev) => prev,
    enabled,
    retry: false,
  });
}

/** The causes of one event, oldest first. */
export function useFactChain(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.factChain(id ?? ""),
    queryFn: ({ signal }) => api.factChain(id ?? "", { signal }),
    enabled: id !== null,
    retry: false,
  });
}

/** What one event caused, oldest first. */
export function useFactEffects(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.factEffects(id ?? ""),
    queryFn: ({ signal }) => api.factEffects(id ?? "", 200, { signal }),
    enabled: id !== null,
    retry: false,
  });
}

/** The newest EventLog lines of the last `ms`, re-read every 10 s. The window moves with the clock. */
export function useFactWindow(ms: number, limit: number) {
  const api = useApi();
  return useQuery({
    queryKey: ["facts", "window", ms, limit] as const,
    queryFn: ({ signal }) => api.factEvents({ since: new Date(Date.now() - ms).toISOString(), order: "desc", limit }, { signal }),
    refetchInterval: poll(10_000),
    placeholderData: (prev) => prev,
    retry: false,
  });
}

/**
 * The log's lines of one turn (see `fetchTurnEvents`); `window` is what an older Core is read by.
 */
export function useTurnEvents(turn: string, window: { since: Timestamp; until: Timestamp } | null, limit: number, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ["facts", "turn", turn, window, limit] as const,
    queryFn: ({ signal }) => fetchTurnEvents(api, turn, window, limit, signal),
    placeholderData: (prev) => prev,
    enabled,
    retry: false,
  });
}

/** The voice measurement of a turn the log does not have (yet): what this panel saw live. */
export function useTurnE2e(turn: string | undefined) {
  return useQuery<E2eRecord | null>({
    queryKey: queryKeys.turnE2e(turn ?? ""),
    queryFn: skipToken,
    enabled: Boolean(turn),
  });
}

// --- the owner's rules ------------------------------------------------------------

/** The rules in force, or with `history` every rule including the ended ones. */
export function useDirectives(history = false) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.directives(history),
    queryFn: ({ signal }) => api.directives(history, { signal }),
    refetchInterval: poll(15_000),
    retry: false,
  });
}

export function useDirectiveMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const changed = () => void qc.invalidateQueries({ queryKey: queryKeys.directivesAll });
  return {
    add: useMutation({ mutationFn: (r: AddDirectiveRequest) => api.addDirective(r), onSuccess: changed }),
    remove: useMutation({ mutationFn: (id: string) => api.removeDirective(id), onSuccess: changed }),
  };
}

// --- evaluation ----------------------------------------------------------------

/** What §18's measures are computed from, over the last `windowMs`; re-read every minute. */
export function useEvalData(windowMs: number) {
  const api = useApi();
  return useQuery<EvalData>({
    queryKey: queryKeys.evalData(windowMs),
    queryFn: ({ signal }) => loadEvalData(api, Date.now(), windowMs, signal),
    refetchInterval: poll(60_000),
    placeholderData: (prev) => prev,
    retry: false,
  });
}

/** What the rules and the gate stopped since local midnight, newest first (`gate` results and dropped proposals). */
export function useBlocksToday() {
  const since = new Date(startOfDay(Date.now())).toISOString();
  return useFactEvents({ kind: ["result", "directive"], source: ["gate", "directive"], since, order: "desc", limit: 500 }, 15_000);
}
