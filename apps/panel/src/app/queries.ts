import {
  type Query,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  skipToken,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query";
import { isApiError } from "@/api/http";
import type { DecisionsQuery, E2eRecord, FactEventsQuery, LlmCallsQuery, LlmThinkingQuery, MemoryQuery, ModuleAction, PeopleQuery } from "@/api/types";
import type { AddDirectiveRequest, AdjustPersonRequest, UpdatePersonRequest,ClusterInviteRequest, ArbiterVerdict, AssignRoleRequest, ChannelLevelsView, DataCategoryId, GameStartRequest, LotPlanRequest, ModuleInfo, QueueState, RemoveMappingRequest, RoleMapping, SaveSettingsRequest, SayRequest, SceneRolesState, SettleRequest, SongsState, StageState, StreamAction, TurnOutcomeKind, UpdateMemoryRequest, UpsertRoleRequest, WalletAdjustRequest } from "@miyoria/contracts/api";
import type { ApiInputs } from "@miyoria/contracts/api";
import type { ContextKey, Timestamp } from "@miyoria/contracts/wire";
import { type EvalData, loadEvalData } from "@/lib/eval-data";
import { factEventsInput } from "@/lib/fact-events";
import { startOfDay } from "@/lib/rules";
import { fetchTurnEvents } from "@/lib/turn-events";
import { useApi } from "./connection";
import { useLivePoll } from "./events-store";
import { createQueryClient, FINAL } from "./query-client";

export { createQueryClient };

export const queryKeys = {
  modules: ["modules"] as const,
  cluster: ["cluster"] as const,
  clusterHosts: ["cluster", "hosts"] as const,
  clusterEndpoints: ["cluster", "endpoints"] as const,
  clusterCheckout: ["cluster", "checkout"] as const,
  clusterRouting: ["cluster", "routing"] as const,
  clusterInfo: (host: string) => ["cluster", "info", host] as const,
  decisionsAll: ["decisions"] as const,
  decisions: (q: DecisionsQuery) => ["decisions", q] as const,
  usage: ["llm", "usage"] as const,
  cost: ["llm", "cost"] as const,
  people: (q: PeopleQuery) => ["people", q] as const,
  person: (id: string) => ["people", "detail", id] as const,
  personHistory: (id: string, after: string) => ["people", "history", id, after] as const,
  personTrend: (id: string) => ["people", "trend", id] as const,
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
  notes: ["notes"] as const,
  noteDocument: (id: string, outdated: boolean) => ["notes", "document", id, outdated] as const,
  noteHistory: (id: string) => ["notes", "history", id] as const,
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
  goals: ["mind", "goals"] as const,
  prompts: ["prompts"] as const,
  turnOutcomes: (q: object) => ["turns", "outcomes", q] as const,
  turnsAll: ["turns"] as const,
  turnMetrics: (days: number) => ["turns", "metrics", days] as const,
  turnE2e: (turn: string) => ["e2e", turn] as const,
  factEvents: (q: FactEventsQuery) => ["facts", "events", q] as const,
  factChain: (id: string) => ["facts", "chain", id] as const,
  directives: (history: boolean) => ["directives", history] as const,
  directivesAll: ["directives"] as const,
  evalData: (windowMs: number) => ["facts", "eval", windowMs] as const,
  evalLive: ["eval", "live"] as const,
  lifeToday: ["life", "today"] as const,
  reminders: ["life", "reminders"] as const,
  activities: ["life", "activities"] as const,
  economyHealth: ["economy", "health"] as const,
  predictions: ["economy", "predictions"] as const,
  room: ["economy", "room"] as const,
  marketHistory: ["economy", "market"] as const,
  personQuests: (id: string) => ["people", "quests", id] as const,
  personCards: (id: string) => ["people", "cards", id] as const,
  workspace: ["workspace"] as const,
  skills: ["skills"] as const,
  skill: (name: string) => ["skills", name] as const,
  party: ["party"] as const,
  notebook: ["notebook"] as const,
  notebookPage: (path: string) => ["notebook", "page", path] as const,
  recent: (context: ContextKey | null) => ["recent", context] as const,
};


export type ClusterServiceAction = "start" | "stop" | "restart";
/** Body of `POST /api/cluster/routing/controls` (not exported by name from the contracts). */
export type ClusterRoutingControlBody = ApiInputs["cluster"]["routingControl"]["body"];

/** Polls every `ms`, but stops once the route turned out not to exist or the token is bad. */
const poll =
  (ms: number) =>
  (query: Query<any, any, any, any>): number | false => {
    const e = query.state.error;
    return isApiError(e) && FINAL.has(e.kind) ? false : ms;
  };

// --- system ------------------------------------------------------------------

export function useHealth() {
  const { q } = useApi();
  return useQuery({ ...q.health.queryOptions(), refetchInterval: poll(15_000) });
}

export function useModules() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.modules, queryFn: ({ signal }) => api.rpc.modules.list(undefined, { signal }), refetchInterval: poll(20_000) });
}

export function useModuleAction() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: ModuleAction }) => api.rpc.modules.action({ params: { id, action } }),
    onSuccess: (updated) => {
      qc.setQueryData<ModuleInfo[]>(queryKeys.modules, (list) => list?.map((m) => (m.id === updated.id ? updated : m)));
      void qc.invalidateQueries({ queryKey: queryKeys.modules });
    },
  });
}

// --- one module: card, settings, history ---------------------------------------

/**
 * A place a module's settings are read or written for (`?space=&room=`): a server (identity's id),
 * and optionally one of its channels (the platform's channel id). `null`: the whole install.
 */
export interface SettingsPlaceArg {
  space: string;
  room?: string | null;
}

const placeQuery = (place: SettingsPlaceArg | null | undefined) =>
  place ? { space: place.space, ...(place.room ? { room: place.room } : {}) } : {};

/** Never retried: a 404 (no such module) or a 403 is the answer, not a hiccup. */
const settingsKeys = {
  detail: (id: string) => ["modules", "detail", id] as const,
  settings: (id: string, place?: SettingsPlaceArg | null) => ["modules", "settings", id, place?.space ?? "", place?.room ?? ""] as const,
  history: (id: string, place?: SettingsPlaceArg | null) => ["modules", "history", id, place?.space ?? "", place?.room ?? ""] as const,
  rooms: (kind: string, guild: string) => ["places", "rooms", kind, guild] as const,
};

export function useModuleDetail(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: settingsKeys.detail(id),
    queryFn: ({ signal }) => api.rpc.modules.get({ params: { id } }, { signal }),
    refetchInterval: poll(15_000),
    retry: false,
  });
}

/** A module's settings; with `place`, the values at that server or channel. */
export function useModuleSettings(id: string, place?: SettingsPlaceArg | null) {
  const api = useApi();
  return useQuery({
    queryKey: settingsKeys.settings(id, place),
    queryFn: ({ signal }) => api.rpc.modules.settings({ params: { id }, query: placeQuery(place) }, { signal }),
    retry: false,
  });
}

/** The module's change log; with `place`, that place's own changes. */
export function useSettingsHistory(id: string, place?: SettingsPlaceArg | null) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: settingsKeys.history(id, place),
    initialPageParam: undefined as number | undefined,
    queryFn: ({ signal, pageParam }) =>
      api.rpc.modules.settingsHistory(
        { params: { id }, query: { limit: "10", ...placeQuery(place), ...(pageParam === undefined ? {} : { before: String(pageParam) }) } },
        { signal },
      ),
    getNextPageParam: (last) => last.next_before ?? undefined,
    retry: false,
  });
}

/** After a save or a revert: the module's settings (every place's), history, card and the list are stale. */
function useSettingsRefresh(id: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["modules", "settings", id] });
    void qc.invalidateQueries({ queryKey: ["modules", "history", id] });
    void qc.invalidateQueries({ queryKey: settingsKeys.detail(id) });
    void qc.invalidateQueries({ queryKey: queryKeys.modules, exact: true });
  };
}

/** Saves the cluster's values, or with `place` that place's own (in effect at once, no restart). */
export function useSaveSettings(id: string, place?: SettingsPlaceArg | null) {
  const api = useApi();
  const refresh = useSettingsRefresh(id);
  return useMutation({
    mutationFn: (body: SaveSettingsRequest) => api.rpc.modules.saveSettings({ params: { id }, query: placeQuery(place), body }),
    onSuccess: refresh,
  });
}

export function useRevertSettings(id: string) {
  const api = useApi();
  const refresh = useSettingsRefresh(id);
  return useMutation({
    mutationFn: (body: { version: number; expected: number }) => api.rpc.modules.revertSettings({ params: { id }, body }),
    onSuccess: refresh,
  });
}

export function useCardAction() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) => api.rpc.modules.cardAction({ params: { id, action } }),
    onSuccess: (_r, { id }) => {
      void qc.invalidateQueries({ queryKey: queryKeys.modules, exact: true });
      void qc.invalidateQueries({ queryKey: settingsKeys.detail(id) });
    },
  });
}

/** The rooms the channel picker offers; asked only while a picker is open. `guild`: one server's (its platform id). */
export function usePlaceRooms(kind: "text" | "voice" | "thread" | null, enabled: boolean, guild?: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: settingsKeys.rooms(kind ?? "all", guild ?? ""),
    queryFn: ({ signal }) => api.rpc.places.rooms({ query: { ...(kind === null ? {} : { kind }), ...(guild ? { space: guild } : {}) } }, { signal }),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

// --- cluster -----------------------------------------------------------------

/** The cluster's answers change while the owner watches: poll, and retry only a dropped network. */
const clusterRetry = (count: number, error: Error) => isApiError(error) && error.kind === "network" && count < 2;

export function useClusterHosts() {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.clusterHosts,
    queryFn: ({ signal }) => api.rpc.cluster.hosts(undefined, { signal }),
    // Every 2 s while a host updates, so its steps show as they happen.
    refetchInterval: (query) => {
      const active = query.state.data?.some((h) => h.upgrade?.state === "running" || h.upgrade?.state === "waiting");
      return poll(active ? 2_000 : 10_000)(query);
    },
    retry: clusterRetry,
  });
}

/** Core's own checkout: the version an update brings the hosts to. */
export function useClusterCheckout() {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.clusterCheckout,
    queryFn: ({ signal }) => api.rpc.cluster.checkout(undefined, { signal }),
    refetchInterval: poll(30_000),
    retry: clusterRetry,
  });
}

export function useClusterEndpoints(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.clusterEndpoints,
    queryFn: ({ signal }) => api.rpc.cluster.endpoints(undefined, { signal }),
    refetchInterval: poll(10_000),
    retry: clusterRetry,
    enabled,
  });
}

/** Job dispatch (v5-hostd §15). An older Core answers 404, one without routing 503. */
export function useClusterRouting() {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.clusterRouting,
    queryFn: ({ signal }) => api.rpc.cluster.routing(undefined, { signal }),
    refetchInterval: poll(5_000),
    retry: clusterRetry,
  });
}

/** What a connected host's daemon reports. `409` (not connected) is an error the part shows. */
export function useClusterHostInfo(name: string, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.clusterInfo(name),
    queryFn: ({ signal }) => api.rpc.cluster.info({ params: { name } }, { signal }),
    refetchInterval: poll(10_000),
    retry: clusterRetry,
    enabled,
  });
}

export function useClusterMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: queryKeys.cluster });
  return {
    invite: useMutation({ mutationFn: (req: ClusterInviteRequest) => api.rpc.cluster.invite({ body: req }) }),
    approve: useMutation({
      mutationFn: ({ name, capabilities }: { name: string; capabilities: string[] }) =>
        api.rpc.cluster.approve({ params: { name }, body: { capabilities } }),
      onSuccess: refresh,
    }),
    remove: useMutation({ mutationFn: (name: string) => api.rpc.cluster.remove({ params: { name } }), onSuccess: refresh }),
    service: useMutation({
      mutationFn: ({ host, service, action, force }: { host: string; service: string; action: ClusterServiceAction; force?: boolean }) =>
        api.rpc.cluster.service({ params: { name: host, service, action }, body: force ? { force: true } : {} }),
      onSuccess: refresh,
    }),
    upgrade: useMutation({
      mutationFn: (hosts: string[]) => api.rpc.cluster.upgrade({ body: { hosts } }),
      onSuccess: refresh,
    }),
    upgradeCancel: useMutation({
      mutationFn: (name: string) => api.rpc.cluster.upgradeCancel({ params: { name }, body: {} }),
      onSuccess: refresh,
    }),
    /** Answers the routing as it is now: it replaces the cached one at once. */
    routingControl: useMutation({
      mutationFn: (body: ClusterRoutingControlBody) => api.rpc.cluster.routingControl({ body }),
      onSuccess: (routing) => {
        qc.setQueryData(queryKeys.clusterRouting, routing);
        refresh();
      },
    }),
  };
}

export function useExtensions() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.extensions, queryFn: ({ signal }) => api.rpc.extensions.list(undefined, { signal }), refetchInterval: poll(30_000) });
}

export function useExtensionAction() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: ModuleAction }) => api.rpc.extensions.action({ params: { id, action } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.extensions }),
  });
}

export function useMcpServers() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.mcp, queryFn: ({ signal }) => api.rpc.mcp.list(undefined, { signal }), refetchInterval: poll(30_000) });
}

export function useMcpRestart() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.rpc.mcp.action({ params: { name, action: "restart" } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.mcp }),
  });
}

// --- activity ----------------------------------------------------------------

export function useDecisions(q: DecisionsQuery) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.decisions(q), queryFn: ({ signal }) =>
      api.rpc.decisions({ query: { limit: q.limit, context: q.context ? JSON.stringify(q.context) : undefined } }, { signal }) });
}

export function useUsage() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.usage, queryFn: ({ signal }) => api.rpc.llm.usage(undefined, { signal }), refetchInterval: poll(30_000) });
}

export function useCost() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.cost, queryFn: ({ signal }) => api.rpc.llm.cost(undefined, { signal }), refetchInterval: poll(60_000) });
}

// --- character ---------------------------------------------------------------

// The persona routes are on the route table: these hooks are its pattern for a page. The query
// options and keys come from the contract (`api.q`); `q.persona.key()` covers every persona query.

export function usePersona() {
  const { q } = useApi();
  return useQuery(q.persona.list.queryOptions());
}

/** Which profile the Core runs (docs/design/v5-profiles.md): it changes only with a restart. */
export function useRunningProfile() {
  const { q } = useApi();
  return useQuery({ ...q.persona.profile.queryOptions(), staleTime: 5 * 60_000 });
}

export function usePersonaHistory(key: string | undefined) {
  const { q } = useApi();
  return useQuery(q.persona.history.queryOptions({ input: { params: { key: key ?? "" } }, enabled: Boolean(key) }));
}

export function useSetPersona() {
  const { q } = useApi();
  const qc = useQueryClient();
  return useMutation(
    q.persona.set.mutationOptions({
      onSuccess: () => void qc.invalidateQueries({ queryKey: q.persona.key() }),
    }),
  );
}

export function usePeople(q: PeopleQuery, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.people(q), queryFn: ({ signal }) => api.rpc.people.list({ query: q }, { signal }), enabled });
}

/** Changes per page of a person's history. */
const HISTORY_PAGE = 20;
/** Changes a trend chart reads at most. */
const TREND_LIMIT = 500;

export function usePerson(id: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.person(id ?? ""),
    queryFn: ({ signal }) => api.rpc.people.get({ params: { id: id ?? "" }, query: { limit: HISTORY_PAGE } }, { signal }),
    enabled: Boolean(id),
  });
}

/**
 * The pages of a person's history after the one the person page came with (`after`, its
 * `next_before`). Nothing is fetched until `fetchNextPage`; a new first page starts over.
 */
export function usePersonHistory(id: string, after: string) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: queryKeys.personHistory(id, after),
    queryFn: ({ signal, pageParam }) => api.rpc.people.history({ params: { id }, query: { before: pageParam, limit: HISTORY_PAGE } }, { signal }),
    initialPageParam: after,
    getNextPageParam: (last) => last.next_before ?? undefined,
    enabled: false,
  });
}

/** The newest changes of several people at once, for the trend chart. */
export function usePeopleHistories(ids: string[]) {
  const api = useApi();
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: queryKeys.personTrend(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.rpc.people.history({ params: { id }, query: { limit: TREND_LIMIT } }, { signal }),
    })),
  });
}

export function useUpdatePerson(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: UpdatePersonRequest) => api.rpc.people.update({ params: { id }, body: req }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["people"] }),
  });
}

/** Sets or removes the shared memory a tier rests on. */
export function useAnchorMutations(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: queryKeys.person(id) });
  return {
    set: useMutation({
      mutationFn: ({ tier, quote }: { tier: number; quote: string }) => api.rpc.people.setAnchor({ params: { id, tier }, body: { quote } }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (tier: number) => api.rpc.people.removeAnchor({ params: { id, tier } }),
      onSuccess: refresh,
    }),
  };
}

export function usePersonWallet(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.personWallet(id),
    queryFn: ({ signal }) => api.rpc.people.wallet({ params: { id } }, { signal }),
    retry: false,
  });
}

export function useAdjustWallet(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: WalletAdjustRequest) => api.rpc.people.adjustWallet({ params: { id }, body: req }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.personWallet(id) }),
  });
}

export function useAdjustPerson(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: AdjustPersonRequest) => api.rpc.people.adjust({ params: { id }, body: req }),
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
      api.rpc.memory.list(
        {
          query: {
            ...(q.q !== undefined ? { q: q.q } : {}),
            ...(q.kind !== undefined ? { kind: q.kind } : {}),
            ...(q.subject !== undefined ? { subject: q.subject } : {}),
            ...(q.include_superseded ? { include_superseded: "true" as const } : {}),
            limit: String(MEMORY_PAGE),
            ...(pageParam ? { before: pageParam } : {}),
          },
        },
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
}

export function useUpdateMemory() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, req }: { id: string; req: UpdateMemoryRequest }) => api.rpc.memory.update({ params: { id }, body: req }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["memory"] }),
  });
}

export function useDeleteMemory() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.rpc.memory.remove({ params: { id } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["memory"] }),
  });
}

// --- access ------------------------------------------------------------------

export function useRoles() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.roles, queryFn: ({ signal }) => api.rpc.roles.list(undefined, { signal }) });
}

export function useAssignments() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.assignments, queryFn: ({ signal }) => api.rpc.roles.assignments(undefined, { signal }) });
}

export function useMappings(platform: string, guild: string) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.mappings(platform, guild),
    queryFn: ({ signal }) => api.rpc.roles.mappings({ query: { platform, guild } }, { signal }),
    enabled: Boolean(platform && guild),
  });
}

export function useAccessMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const auth = () => void qc.invalidateQueries({ queryKey: ["auth"] });
  return {
    assign: useMutation({ mutationFn: (r: AssignRoleRequest) => api.rpc.roles.assign({ body: r }), onSuccess: auth }),
    revoke: useMutation({ mutationFn: (r: AssignRoleRequest) => api.rpc.roles.revoke({ body: r }), onSuccess: auth }),
    upsertRole: useMutation({
      mutationFn: ({ name, req }: { name: string; req: UpsertRoleRequest }) => api.rpc.roles.upsert({ params: { name }, body: req }),
      onSuccess: auth,
    }),
    deleteRole: useMutation({ mutationFn: (name: string) => api.rpc.roles.remove({ params: { name } }), onSuccess: auth }),
    setMapping: useMutation({ mutationFn: (m: RoleMapping) => api.rpc.roles.setMapping({ body: m }), onSuccess: auth }),
    removeMapping: useMutation({ mutationFn: (m: RemoveMappingRequest) => api.rpc.roles.removeMapping({ body: m }), onSuccess: auth }),
  };
}

// --- live --------------------------------------------------------------------

/** `?space=` of a per-server admin route: left out without a server (the Core's default then). */
const spaceQuery = (space: string | null | undefined) => (space ? { space } : {});

/** One server's song queue (`space`: identity's id; without it the Core's default). */
export function useQueue(space?: string | null) {
  const api = useApi();
  // Fetched again on `queue.changed` while the admin event stream is open (`liveViews`).
  const every = useLivePoll(3_000);
  return useQuery({ queryKey: [...queryKeys.queue, space ?? ""], queryFn: ({ signal }) => api.rpc.queue.list({ query: spaceQuery(space) }, { signal }), refetchInterval: poll(every) });
}

export function useQueueMutations(space?: string | null) {
  const api = useApi();
  const qc = useQueryClient();
  const set = (state: QueueState) => qc.setQueryData([...queryKeys.queue, space ?? ""], state);
  const query = spaceQuery(space);
  return {
    skip: useMutation({ mutationFn: (id: string) => api.rpc.queue.skip({ params: { id }, query }), onSuccess: set }),
    move: useMutation({
      mutationFn: ({ id, position }: { id: string; position: number }) => api.rpc.queue.move({ params: { id }, query, body: { position } }),
      onSuccess: set,
    }),
    pause: useMutation({ mutationFn: (paused: boolean) => (paused ? api.rpc.queue.pause({ query }) : api.rpc.queue.resume({ query })), onSuccess: set }),
  };
}

export function useStage() {
  const api = useApi();
  const every = useLivePoll(5_000);
  return useQuery({ queryKey: queryKeys.stage, queryFn: ({ signal }) => api.rpc.stage.status(undefined, { signal }), refetchInterval: poll(every) });
}

export function useStageMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const set = (state: StageState) => qc.setQueryData(queryKeys.stage, state);
  return {
    scene: useMutation({ mutationFn: (name: string) => api.rpc.stage.scene({ body: { scene: name } }), onSuccess: set }),
    expression: useMutation({ mutationFn: (name: string) => api.rpc.stage.expression({ body: { expression: name } }), onSuccess: set }),
    stream: useMutation({ mutationFn: (action: StreamAction) => api.rpc.stage.stream({ body: { action } }), onSuccess: set }),
    say: useMutation({ mutationFn: (req: SayRequest) => api.rpc.stage.say({ body: req }) }),
  };
}

export function useSceneRoles() {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.sceneRoles,
    queryFn: ({ signal }) => api.rpc.stage.scenes(undefined, { signal }),
    refetchInterval: poll(15_000),
  });
}

export function useSceneRoleMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const set = (state: SceneRolesState) => qc.setQueryData(queryKeys.sceneRoles, state);
  return {
    set: useMutation({
      mutationFn: ({ role, scene }: { role: string; scene: string | null }) => api.rpc.stage.setSceneRole({ body: { role, scene } }),
      onSuccess: set,
    }),
    classify: useMutation({ mutationFn: () => api.rpc.stage.classify(), onSuccess: set }),
  };
}

export function useVoice() {
  const api = useApi();
  const every = useLivePoll(5_000);
  return useQuery({ queryKey: queryKeys.voice, queryFn: ({ signal }) => api.rpc.voice.state(undefined, { signal }), refetchInterval: poll(every) });
}

// --- inner life --------------------------------------------------------------

export function useSelf() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.self, queryFn: ({ signal }) => api.rpc.self(undefined, { signal }), refetchInterval: poll(5_000) });
}

export function useWorld() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.world, queryFn: ({ signal }) => api.rpc.world(undefined, { signal }), refetchInterval: poll(5_000) });
}

export function useChannelLevels() {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.channelLevels,
    queryFn: ({ signal }) => api.rpc.channels.levels(undefined, { signal }),
    refetchInterval: poll(15_000),
  });
}

export function useSetChannelLevel() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ context, mode }: { context: ContextKey; mode: string | null }) => api.rpc.channels.setLevel({ body: { context, mode } }),
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
  return useQuery({ queryKey: queryKeys.data, queryFn: ({ signal }) => api.rpc.data.inventory(undefined, { signal }), refetchInterval: poll(30_000) });
}

/** Deletes and the reset change what every page shows: everything is refetched. */
export function useDataMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const all = () => void qc.invalidateQueries();
  return {
    wipe: useMutation({
      mutationFn: ({ categories, confirm }: { categories: DataCategoryId[]; confirm?: string }) => api.rpc.data.wipe({ body: { categories, confirm } }),
      onSuccess: all,
    }),
    reset: useMutation({
      mutationFn: ({ confirm, token }: { confirm: string; token: string }) => api.rpc.data.reset({ body: { confirm, backup_token: token } }),
      onSuccess: all,
    }),
  };
}
export function useMind() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.mind, queryFn: ({ signal }) => api.rpc.mind.status(undefined, { signal }), refetchInterval: poll(5_000) });
}

export function useThoughts(limit = 50) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.thoughts,
    queryFn: ({ signal }) => api.rpc.mind.thoughts({ query: { limit } }, { signal }),
    refetchInterval: poll(5_000),
  });
}

export function useDigests(limit = 20) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.digests, queryFn: ({ signal }) => api.rpc.mind.digests({ query: { limit } }, { signal }), refetchInterval: poll(60_000) });
}

export function useNoteDocuments() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.notes, queryFn: ({ signal }) => api.rpc.notes.documents({ query: {} }, { signal }), refetchInterval: poll(15_000) });
}

export function useNoteDocument(id: string | null, outdated: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.noteDocument(id ?? "", outdated),
    queryFn: ({ signal }) => api.rpc.notes.document({ params: { id: id as string }, query: outdated ? { outdated: "true" } : {} }, { signal }),
    enabled: id !== null,
    placeholderData: keepPreviousData,
    refetchInterval: poll(15_000),
  });
}

export function useNoteHistory(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.noteHistory(id ?? ""),
    queryFn: ({ signal }) => api.rpc.notes.history({ params: { id: id as string } }, { signal }),
    enabled: id !== null,
  });
}

/** Rolls a document back to a version; every note query is stale afterwards. */
export function useRevertNote() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) => api.rpc.notes.revert({ params: { id }, body: { version } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.notes }),
  });
}

export function useConversationNotes() {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.conversationNotes,
    queryFn: ({ signal }) => api.rpc.knowledge.conversations(undefined, { signal }),
    refetchInterval: poll(15_000),
  });
}

export function useReflection(days = 7) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.reflection, queryFn: ({ signal }) => api.rpc.reflection({ query: { days } }, { signal }), refetchInterval: poll(30_000) });
}

export function useApprovals() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.approvals, queryFn: ({ signal }) => api.rpc.mind.approvals(undefined, { signal }), refetchInterval: poll(5_000) });
}

export function useMindMutations() {
  const api = useApi();
  const qc = useQueryClient();
  return {
    pause: useMutation({
      mutationFn: (paused: boolean) => (paused ? api.rpc.mind.pause : api.rpc.mind.resume)(),
      onSuccess: (view) => qc.setQueryData(queryKeys.mind, view),
    }),
    answer: useMutation({
      mutationFn: ({ id, approved }: { id: string; approved: boolean }) => (approved ? api.rpc.mind.approve : api.rpc.mind.deny)({ params: { id } }),
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
  const every = useLivePoll(3_000);
  return useQuery({ queryKey: queryKeys.songs, queryFn: ({ signal }) => api.rpc.songs.list(undefined, { signal }), refetchInterval: poll(every) });
}

export function useSongMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const set = (s: SongsState) => qc.setQueryData<SongsState>(queryKeys.songs, { playing: s.playing, paused: s.paused, songs: s.songs });
  return {
    request: useMutation({ mutationFn: ({ query, key }: { query: string; key?: number }) => api.rpc.songs.request({ body: { query, key: key ?? null } }), onSuccess: set }),
    play: useMutation({ mutationFn: (song?: number) => api.rpc.songs.play({ body: { song: song ?? null } }), onSuccess: set }),
    stop: useMutation({ mutationFn: (all: boolean) => api.rpc.songs.stop({ body: { all } }), onSuccess: set }),
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
      mutationFn: ({ guild, channel }: { guild: string; channel: string | null }) => api.rpc.voice.join({ body: { guild, channel } }),
      onSuccess: refresh,
    }),
    leave: useMutation({ mutationFn: (guild?: string) => api.rpc.voice.leave({ body: { guild: guild ?? null } }), onSuccess: refresh }),
    goLive: useMutation({
      mutationFn: ({ action, guild }: { action: StreamAction; guild?: string }) => api.rpc.voice.goLive({ body: { action, guild: guild ?? null } }),
      onSuccess: refresh,
    }),
    gameStart: useMutation({ mutationFn: (req: GameStartRequest) => api.rpc.game.start({ body: req }), onSuccess: refresh }),
    gameStop: useMutation({ mutationFn: () => api.rpc.game.stop(), onSuccess: refresh }),
    gameGoal: useMutation({ mutationFn: (text: string) => api.rpc.game.goal({ body: { text } }), onSuccess: refresh }),
  };
}

// --- charts ------------------------------------------------------------------

/** A minute's samples for the last `minutes`; older Cores answer 404 and the charts say so. */
export function useTelemetry(minutes: number) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.telemetry(minutes),
    queryFn: ({ signal }) => api.rpc.telemetry({ query: { minutes: String(minutes) } }, { signal }),
    refetchInterval: poll(60_000),
    placeholderData: (prev) => prev,
  });
}

/** One thought in full (what it saw, the reasoning). */
export function useThought(id: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: [...queryKeys.thoughts, "one", id ?? ""],
    queryFn: ({ signal }) => api.rpc.mind.thought({ params: { id: id ?? "" } }, { signal }),
    enabled: Boolean(id),
    refetchInterval: poll(10_000),
  });
}

const LLM_PAGE = 100;

/** The call inspector's filters as the route reads them: flags as `true`, a page and its cursor. */
function llmCallsInput(q: LlmCallsQuery, limit: number, before: string | null) {
  return {
    purpose: q.purpose,
    model: q.model,
    module: q.module,
    status: q.status,
    trouble: q.trouble ? ("true" as const) : undefined,
    thought: q.thought,
    turn: q.turn,
    since: q.since,
    q: q.q,
    limit: String(limit),
    before: before ?? undefined,
  };
}

function llmThinkingInput(q: LlmThinkingQuery, limit: number, before: string | null) {
  return {
    kind: q.kind,
    reasoned: q.reasoned ? ("true" as const) : undefined,
    since: q.since,
    q: q.q,
    limit: String(limit),
    before: before ?? undefined,
  };
}

/** The call inspector, newest first, one page at a time. */
export function useLlmCalls(q: LlmCallsQuery) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: ["llm", "calls", q],
    queryFn: ({ signal, pageParam }) => api.rpc.llm.calls({ query: llmCallsInput(q, LLM_PAGE, pageParam) }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    refetchInterval: poll(10_000),
    // A new filter keeps the old rows until the new ones arrive.
    placeholderData: (prev) => prev,
  });
}

const THINKING_PAGE = 30;

/** Calls with their chain of thought, newest first. */
export function useLlmThinking(q: LlmThinkingQuery) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: ["llm", "thinking", q],
    queryFn: ({ signal, pageParam }) => api.rpc.llm.thinking({ query: llmThinkingInput(q, THINKING_PAGE, pageParam) }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    refetchInterval: poll(10_000),
    placeholderData: (prev) => prev,
  });
}

export function useLlmCall(id: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: ["llm", "call", id ?? ""],
    queryFn: ({ signal }) => api.rpc.llm.callDetail({ params: { id: id ?? "" } }, { signal }),
    enabled: Boolean(id),
    refetchInterval: (query) => (query.state.data?.call.status === "streaming" ? 2_000 : false),
  });
}

/** Breakdowns of the calls in the last `minutes` (`null`: every kept call). */
export function useLlmStats(minutes: number | null) {
  const api = useApi();
  return useQuery({
    queryKey: ["llm", "stats", minutes],
    queryFn: ({ signal }) => api.rpc.llm.stats({ query: { minutes: minutes === null ? undefined : String(minutes) } }, { signal }),
    refetchInterval: poll(30_000),
    placeholderData: (prev) => prev,
  });
}

/** Up to 300 thoughts for the per-hour chart (the journal shows the newest 50). */
export function useThoughtHistory() {
  const api = useApi();
  return useQuery({
    queryKey: [...queryKeys.thoughts, "history"],
    queryFn: ({ signal }) => api.rpc.mind.thoughts({ query: { limit: 300 } }, { signal }),
    refetchInterval: poll(60_000),
  });
}


// --- body, arbiter, affect, plan, prompts -----------------------------------------
// Older Cores answer 404 and a stopped module 503: `poll` then stops asking.

/** Presence, broadcast, activity and scene. Kept fresh by `activity.changed`. */
export function useActivity() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.activity, queryFn: ({ signal }) => api.rpc.activity.snapshot(undefined, { signal }), refetchInterval: poll(10_000) });
}

export function useActivityTasks(limit = 20) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.activityTasks,
    queryFn: ({ signal }) => api.rpc.activity.tasks({ query: { limit: String(limit) } }, { signal }),
    refetchInterval: poll(10_000),
  });
}

export function useLedger(context?: ContextKey, limit = 50) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.ledger(context),
    queryFn: ({ signal }) =>
      api.rpc.arbiter.ledger({ query: { limit: String(limit), context: context ? JSON.stringify(context) : undefined } }, { signal }),
    refetchInterval: poll(10_000),
  });
}

export function useArbiterDecisions(q: { limit?: number; verdict?: ArbiterVerdict; context?: ContextKey }) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.arbiterDecisions(q),
    queryFn: ({ signal }) =>
      api.rpc.arbiter.decisions(
        { query: { limit: q.limit === undefined ? undefined : String(q.limit), verdict: q.verdict, context: q.context ? JSON.stringify(q.context) : undefined } },
        { signal },
      ),
    refetchInterval: poll(15_000),
  });
}

export function useAffect() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.affect, queryFn: ({ signal }) => api.rpc.affect.snapshot(undefined, { signal }), refetchInterval: poll(10_000) });
}

export function useGoals(closed: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: [...queryKeys.goals, closed],
    queryFn: ({ signal }) => api.rpc.mind.goals({ query: { closed: closed ? "true" : undefined } }, { signal }),
    refetchInterval: poll(15_000),
  });
}


export function usePrompts(limit = 30) {
  const api = useApi();
  return useQuery({
    queryKey: [...queryKeys.prompts, "list", limit],
    queryFn: ({ signal }) => api.rpc.prompts.list({ query: { limit: String(limit) } }, { signal }),
    refetchInterval: poll(15_000),
  });
}

/** The saved prompt of one turn; `404` when it is too old or was not kept. */
export function usePrompt(turn: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: [...queryKeys.prompts, "one", turn ?? ""],
    queryFn: ({ signal }) => api.rpc.prompts.get({ params: { turn: turn ?? "" } }, { signal }),
    enabled: Boolean(turn),
    retry: false,
  });
}

export function useTurnOutcomes(q: { limit?: number; outcome?: TurnOutcomeKind; context?: ContextKey } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.turnOutcomes(q),
    queryFn: ({ signal }) =>
      api.rpc.turns.outcomes(
        { query: { limit: q.limit === undefined ? undefined : String(q.limit), outcome: q.outcome, context: q.context ? JSON.stringify(q.context) : undefined } },
        { signal },
      ),
    refetchInterval: poll(15_000),
  });
}

/** The V4 participation measures per local day (`GET /api/turns/metrics`). */
export function useTurnMetrics(days: number) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.turnMetrics(days),
    queryFn: ({ signal }) => api.rpc.turns.metrics({ query: { days: String(days) } }, { signal }),
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
    queryFn: ({ signal }) => api.rpc.facts.events(factEventsInput(q), { signal }),
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
    queryFn: ({ signal }) => api.rpc.facts.chain({ params: { id: id ?? "" } }, { signal }),
    enabled: id !== null,
    retry: false,
  });
}

/** What one event caused, oldest first. */
export function useFactEffects(id: string | null) {
  const { q } = useApi();
  return useQuery(
    q.facts.effects.queryOptions({
      input: { params: { id: id ?? "" }, query: { limit: 200 } },
      enabled: id !== null,
      retry: false,
    }),
  );
}

/** The newest EventLog lines of the last `ms`, re-read every 10 s. The window moves with the clock. */
export function useFactWindow(ms: number, limit: number) {
  const api = useApi();
  return useQuery({
    queryKey: ["facts", "window", ms, limit] as const,
    queryFn: ({ signal }) => api.rpc.facts.events(factEventsInput({ since: new Date(Date.now() - ms).toISOString(), order: "desc", limit }), { signal }),
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
    queryFn: ({ signal }) => api.rpc.directives.list({ query: history ? { history: "1" } : {} }, { signal }),
    refetchInterval: poll(15_000),
    retry: false,
  });
}

export function useDirectiveMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const changed = () => void qc.invalidateQueries({ queryKey: queryKeys.directivesAll });
  return {
    add: useMutation({ mutationFn: (r: AddDirectiveRequest) => api.rpc.directives.add({ body: r }), onSuccess: changed }),
    remove: useMutation({ mutationFn: (id: string) => api.rpc.directives.remove({ params: { id } }), onSuccess: changed }),
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

/** The live suites' runs (`history.jsonl`, the last 90) and the nightly run's state. */
export function useEvalLive() {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.evalLive,
    queryFn: ({ signal }) => api.rpc.eval.live({ query: {} }, { signal }),
    refetchInterval: poll(60_000),
  });
}

/** What the rules and the gate stopped since local midnight, newest first (`gate` results and dropped proposals). */
export function useBlocksToday() {
  const since = new Date(startOfDay(Date.now())).toISOString();
  return useFactEvents({ kind: ["result", "directive"], source: ["gate", "directive"], since, order: "desc", limit: 500 }, 15_000);
}

// --- the routes V4 added: her life, economy, workspace, party games, notebook --------

/** Like `poll`, and also stops on `unavailable`: the module behind the route is off. */
const OFF = new Set([...FINAL, "unavailable"]);
const pollModule =
  (ms: number) =>
  (query: Query<any, any, any, any>): number | false => {
    const e = query.state.error;
    return isApiError(e) && OFF.has(e.kind) ? false : ms;
  };

export function useLifeToday() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.lifeToday, queryFn: ({ signal }) => api.rpc.life.today(undefined, { signal }), refetchInterval: pollModule(30_000), retry: false });
}

export function useReminders() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.reminders, queryFn: ({ signal }) => api.rpc.life.reminders(undefined, { signal }), refetchInterval: pollModule(15_000), retry: false });
}

export function useCancelReminder() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => api.rpc.life.cancelReminder({ params: { key } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.reminders }),
  });
}

export function useActivities() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.activities, queryFn: ({ signal }) => api.rpc.life.activities(undefined, { signal }), refetchInterval: pollModule(30_000), retry: false });
}

export function useEconomyHealth() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.economyHealth, queryFn: ({ signal }) => api.rpc.economy.health(undefined, { signal }), refetchInterval: pollModule(60_000), retry: false });
}

export function usePredictions(space?: string | null) {
  const api = useApi();
  return useQuery({ queryKey: [...queryKeys.predictions, space ?? ""], queryFn: ({ signal }) => api.rpc.economy.predictions({ query: spaceQuery(space) }, { signal }), refetchInterval: pollModule(30_000), retry: false });
}

export function useRoom() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.room, queryFn: ({ signal }) => api.rpc.economy.room(undefined, { signal }), refetchInterval: pollModule(60_000), retry: false });
}

/** The weekly market's lots and lottery weeks, newest first (`GET /api/market/history`). */
export function useMarketHistory(space?: string | null) {
  const api = useApi();
  return useQuery({ queryKey: [...queryKeys.marketHistory, space ?? ""], queryFn: ({ signal }) => api.rpc.marketAdmin.history({ query: spaceQuery(space) }, { signal }), refetchInterval: pollModule(60_000), retry: false });
}

/** Sets or skips the coming week's lot (`admin.economy.adjust`). */
export function usePlanLot(space?: string | null) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: LotPlanRequest) => api.rpc.marketAdmin.plan({ query: spaceQuery(space), body: req }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.marketHistory }),
  });
}

/** Ends the open lot or draws this week's lottery now (`admin.economy.adjust`). */
export function useSettleMarket(space?: string | null) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (what: SettleRequest["what"]) => api.rpc.marketAdmin.settle({ query: spaceQuery(space), body: { what } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.marketHistory }),
  });
}

export function usePersonQuests(id: string) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.personQuests(id), queryFn: ({ signal }) => api.rpc.people.quests({ params: { id } }, { signal }), retry: false });
}

/** One person's cards, dex, pity and wishlist (`GET /api/people/{id}/cards`). */
export function usePersonCards(id: string) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.personCards(id), queryFn: ({ signal }) => api.rpc.cardsAdmin.person({ params: { id } }, { signal }), retry: false });
}

export function useWorkspace() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.workspace, queryFn: ({ signal }) => api.rpc.workspace(undefined, { signal }), refetchInterval: pollModule(60_000), retry: false });
}

export function useParty() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.party, queryFn: ({ signal }) => api.rpc.party(undefined, { signal }), refetchInterval: pollModule(10_000), retry: false });
}

export function useSkills() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.skills, queryFn: ({ signal }) => api.rpc.skills.list(undefined, { signal }), refetchInterval: pollModule(60_000), retry: false });
}

export function useSkill(name: string | null) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.skill(name ?? ""), queryFn: ({ signal }) => api.rpc.skills.get({ params: { name: name as string } }, { signal }), enabled: name !== null, retry: false });
}

export function useNotebook() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.notebook, queryFn: ({ signal }) => api.rpc.notebook.pages(undefined, { signal }), refetchInterval: pollModule(60_000), retry: false });
}

export function useNotebookPage(path: string | null) {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.notebookPage(path ?? ""), queryFn: ({ signal }) => api.rpc.notebook.page({ query: { path: path as string } }, { signal }), enabled: path !== null, retry: false });
}

export function useRecent(context: ContextKey | null) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.recent(context),
    queryFn: ({ signal }) => api.rpc.recent({ query: { context: JSON.stringify(context) } }, { signal }),
    enabled: context !== null,
    refetchInterval: pollModule(30_000),
    retry: false,
  });
}
