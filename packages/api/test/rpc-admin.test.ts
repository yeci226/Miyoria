// The admin groups of the route table (people, modules, decisions, LLM usage, channels, mind,
// roles, extensions, MCP, the queue, the stage, voice, songs, game, data): each route says what the old route enforced (method, path, audience, permission node),
// the shell treats it as an admin route, and the schemas of the shapes other packages own agree
// with those packages' types.

import {
  type ActivitySnapshot as ContractActivitySnapshot,
  type ActivityTask as ContractActivityTask,
  type AffectSnapshot as ContractAffectSnapshot,
  type ArbiterDecisionView as ContractArbiterDecisionView,
  type AuthScope as ContractAuthScope,
  type CauseChain as ContractCauseChain,
  type ConversationNote as ContractConversationNote,
  type CostReport as ContractCostReport,
  type DataCategoryId as ContractDataCategoryId,
  type DataCategoryView as ContractDataCategoryView,
  type DataNote as ContractDataNote,
  type DataWipeResult as ContractDataWipeResult,
  type DecisionRecord as ContractDecisionRecord,
  type Delivery as ContractDelivery,
  type Directive as ContractDirective,
  type EconomyHealth as ContractEconomyHealth,
  type EmergencyReport as ContractEmergencyReport,
  type ExtensionInfo as ContractExtensionInfo,
  type FeedbackTally as ContractFeedbackTally,
  type Goal as ContractGoal,
  type JustNowEntry as ContractJustNowEntry,
  type KnowledgeDoc as ContractKnowledgeDoc,
  type LedgerView as ContractLedgerView,
  type Lesson as ContractLesson,
  type LifeEntry as ContractLifeEntry,
  type LlmCallDetail as ContractLlmCallDetail,
  type LlmCallRecord as ContractLlmCallRecord,
  type LlmCallStats as ContractLlmCallStats,
  type LlmThinkingPage as ContractLlmThinkingPage,
  type LogEvent as ContractLogEvent,
  type McpServerInfo as ContractMcpServerInfo,
  type MemoryRecordView as ContractMemoryRecordView,
  type MindStats as ContractMindStats,
  type ModuleInfo as ContractModuleInfo,
  type NotebookEntry as ContractNotebookEntry,
  type NotebookPage as ContractNotebookPage,
  type PartySnapshot as ContractPartySnapshot,
  type PendingApproval as ContractPendingApproval,
  type Person as ContractPerson,
  type PredictionView as ContractPredictionView,
  type ProposedTool as ContractProposedTool,
  type QuestsView as ContractQuestsView,
  type QueueItemInfo as ContractQueueItemInfo,
  type ReflectionRun as ContractReflectionRun,
  type ReflectionStats as ContractReflectionStats,
  type ReminderView as ContractReminderView,
  type RoleAssignment as ContractRoleAssignment,
  type RoleDefinition as ContractRoleDefinition,
  type RoleMapping as ContractRoleMapping,
  type RoomItem as ContractRoomItem,
  type SandboxHealth as ContractSandboxHealth,
  type SavedPrompt as ContractSavedPrompt,
  type SceneRolesState as ContractSceneRolesState,
  type SelfView as ContractSelfView,
  type SkillFile as ContractSkillFile,
  type SongView as ContractSongView,
  type StageState as ContractStageState,
  type Thought as ContractThought,
  type ThoughtDigest as ContractThoughtDigest,
  type ThoughtSummary as ContractThoughtSummary,
  type TurnOutcomeRecord as ContractTurnOutcomeRecord,
  type VoiceSession as ContractVoiceSession,
  type WorldView as ContractWorldView,
  contract,
  routeMeta,
} from "@miyoria/contracts/api";
import type { Economy2 } from "@miyoria/economy";
import { NODE_APPROVE, type PendingApproval } from "@miyoria/gate/actions";
import type {
  CostReport,
  LlmCallDetail,
  LlmCallRecord,
  LlmCallStats,
  LlmThinkingPage,
  Pricing,
} from "@miyoria/llm/llm";
import type { ItemState } from "@miyoria/play/queue";
import type { ServerStatus } from "@miyoria/plugin-host/mcp";
import type { ModuleStatus } from "@miyoria/runtime/kernel";
import type { SongEntry } from "@miyoria/sing";
import type { SceneRolesView, StageStatus } from "@miyoria/stage";
import type {
  AuthScope,
  CategoryInventory,
  DataCategoryId,
  DecisionRecord,
  MemoryRecord,
  Person,
  RoleAssignment,
  RoleDefinition,
  RoleMapping,
} from "@miyoria/store";
import type {
  ActivitySnapshot,
  ActivityTask,
  AffectSnapshot,
  ArbiterDecision,
  CauseChain,
  ChannelActivity,
  ContextKey,
  ConversationState,
  CountedOutcome,
  Delivery,
  Directive,
  EmergencyReport,
  FeedbackTally,
  Goal,
  JustNowEntry,
  KnowledgeDoc,
  LedgerView,
  Lesson,
  LifeEntry,
  LogEvent,
  MindStats,
  ModuleStateKind,
  NotebookEntry,
  NotebookPage,
  PartySnapshot,
  PersonId,
  ReflectionRun,
  ReflectionStats,
  Reminder,
  SavedPrompt,
  SelfSnapshot,
  SkillShelfFile,
  Thought,
  ThoughtDigest,
  Timestamp,
  VoiceParticipant,
  WorldSnapshot,
} from "@miyoria/types";
import type { ProposedTool, SandboxHealth } from "@miyoria/workspace/sandbox";
import { describe, expect, it } from "vitest";
import { NODE_DATA_MANAGE, type TOOLS_WORKSPACE } from "../src/data.js";
import { rpcRoutes } from "../src/rpc.js";

interface Case {
  /** The route's name in the table: `people.list`. */
  name: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** The path as the old Hono table spelled it. */
  path: string;
  /** The node the old route's handler checked (`null`: none). */
  permission?: string;
  /** What the old route said to a session without the node, when not the usual. */
  refusal?: string;
}

const MANAGE = "owner.data.manage";
const REVIEW_REFUSAL = "reviewing her tools needs `owner.autonomy.approve`";
const MANAGE_REFUSAL = "managing her data needs `owner.data.manage`";

const CASES: Case[] = [
  { name: "people.list", method: "GET", path: "/api/people" },
  { name: "people.get", method: "GET", path: "/api/people/:id" },
  { name: "people.history", method: "GET", path: "/api/people/:id/history" },
  { name: "people.update", method: "PATCH", path: "/api/people/:id" },
  { name: "people.adjust", method: "POST", path: "/api/people/:id/adjust" },
  { name: "people.setAnchor", method: "PUT", path: "/api/people/:id/anchors/:tier" },
  { name: "people.removeAnchor", method: "DELETE", path: "/api/people/:id/anchors/:tier" },
  { name: "people.wallet", method: "GET", path: "/api/people/:id/wallet" },
  {
    name: "people.adjustWallet",
    method: "POST",
    path: "/api/people/:id/wallet/adjust",
    permission: "admin.economy.adjust",
  },
  { name: "modules.list", method: "GET", path: "/api/modules" },
  { name: "modules.action", method: "POST", path: "/api/modules/:id/:action" },
  { name: "decisions", method: "GET", path: "/api/decisions" },
  { name: "llm.usage", method: "GET", path: "/api/llm/usage" },
  { name: "llm.cost", method: "GET", path: "/api/llm/cost" },
  { name: "llm.calls", method: "GET", path: "/api/llm/calls" },
  { name: "llm.callDetail", method: "GET", path: "/api/llm/calls/:id" },
  { name: "llm.thinking", method: "GET", path: "/api/llm/thinking" },
  { name: "llm.stats", method: "GET", path: "/api/llm/stats" },
  { name: "channels.levels", method: "GET", path: "/api/channels/levels" },
  {
    name: "channels.setLevel",
    method: "PUT",
    path: "/api/channels/level",
    permission: "admin.channel.mode",
  },
  { name: "mind.thought", method: "GET", path: "/api/mind/thoughts/:id" },
  { name: "mind.status", method: "GET", path: "/api/mind" },
  { name: "mind.thoughts", method: "GET", path: "/api/mind/thoughts" },
  { name: "mind.approvals", method: "GET", path: "/api/mind/approvals" },
  {
    name: "mind.approve",
    method: "POST",
    path: "/api/mind/approvals/:id/approve",
    permission: "owner.autonomy.approve",
  },
  {
    name: "mind.deny",
    method: "POST",
    path: "/api/mind/approvals/:id/deny",
    permission: "owner.autonomy.approve",
  },
  {
    name: "mind.pause",
    method: "POST",
    path: "/api/mind/pause",
    permission: "owner.autonomy.approve",
  },
  {
    name: "mind.resume",
    method: "POST",
    path: "/api/mind/resume",
    permission: "owner.autonomy.approve",
  },
  { name: "roles.list", method: "GET", path: "/api/auth/roles" },
  { name: "roles.get", method: "GET", path: "/api/auth/roles/:name" },
  { name: "roles.upsert", method: "PUT", path: "/api/auth/roles/:name" },
  { name: "roles.remove", method: "DELETE", path: "/api/auth/roles/:name" },
  { name: "roles.assignments", method: "GET", path: "/api/auth/assignments" },
  { name: "roles.assign", method: "POST", path: "/api/auth/assignments" },
  { name: "roles.revoke", method: "DELETE", path: "/api/auth/assignments" },
  { name: "roles.mappings", method: "GET", path: "/api/auth/mappings" },
  { name: "roles.setMapping", method: "PUT", path: "/api/auth/mappings" },
  { name: "roles.removeMapping", method: "DELETE", path: "/api/auth/mappings" },
  { name: "facts.events", method: "GET", path: "/api/facts/events" },
  { name: "facts.event", method: "GET", path: "/api/facts/events/:id" },
  { name: "facts.chain", method: "GET", path: "/api/facts/events/:id/chain" },
  { name: "facts.effects", method: "GET", path: "/api/facts/events/:id/effects" },
  // No client in this repository calls the next one; only the tests do.
  { name: "facts.deliveries", method: "GET", path: "/api/facts/deliveries" },
  { name: "economy.health", method: "GET", path: "/api/economy/health" },
  { name: "economy.predictions", method: "GET", path: "/api/economy/predictions" },
  {
    name: "economy.resolvePrediction",
    method: "POST",
    path: "/api/economy/predictions/:id/resolve",
    permission: "admin.economy.adjust",
  },
  {
    name: "economy.cancelPrediction",
    method: "POST",
    path: "/api/economy/predictions/:id/cancel",
    permission: "admin.economy.adjust",
  },
  { name: "economy.room", method: "GET", path: "/api/economy/room" },
  { name: "people.quests", method: "GET", path: "/api/people/:id/quests" },
  { name: "activity.snapshot", method: "GET", path: "/api/activity" },
  { name: "activity.tasks", method: "GET", path: "/api/activity/tasks" },
  { name: "arbiter.ledger", method: "GET", path: "/api/arbiter/ledger" },
  { name: "arbiter.decisions", method: "GET", path: "/api/arbiter/decisions" },
  { name: "knowledge.documents", method: "GET", path: "/api/knowledge" },
  { name: "knowledge.conversations", method: "GET", path: "/api/knowledge/conversations" },
  { name: "reflection", method: "GET", path: "/api/reflection" },
  { name: "mind.digests", method: "GET", path: "/api/mind/digests" },
  { name: "life.today", method: "GET", path: "/api/life/today" },
  { name: "life.reminders", method: "GET", path: "/api/life/reminders" },
  { name: "life.cancelReminder", method: "DELETE", path: "/api/life/reminders/:key" },
  { name: "life.activities", method: "GET", path: "/api/life/activities" },
  { name: "workspace", method: "GET", path: "/api/workspace" },
  { name: "skills.list", method: "GET", path: "/api/skills" },
  { name: "skills.get", method: "GET", path: "/api/skills/:name" },
  { name: "sandbox.tools", method: "GET", path: "/api/sandbox/tools" },
  { name: "sandbox.tool", method: "GET", path: "/api/sandbox/tools/:name" },
  {
    name: "sandbox.approve",
    method: "POST",
    path: "/api/sandbox/tools/:name/approve",
    permission: "owner.autonomy.approve",
    refusal: REVIEW_REFUSAL,
  },
  {
    name: "sandbox.reject",
    method: "POST",
    path: "/api/sandbox/tools/:name/reject",
    permission: "owner.autonomy.approve",
    refusal: REVIEW_REFUSAL,
  },
  { name: "self", method: "GET", path: "/api/self" },
  { name: "world", method: "GET", path: "/api/world" },
  { name: "affect.snapshot", method: "GET", path: "/api/affect" },
  { name: "mind.goals", method: "GET", path: "/api/mind/goals" },
  { name: "prompts.list", method: "GET", path: "/api/prompts" },
  { name: "prompts.get", method: "GET", path: "/api/prompts/:turn" },
  { name: "turns.outcomes", method: "GET", path: "/api/turns/outcomes" },
  { name: "turns.metrics", method: "GET", path: "/api/turns/metrics" },
  { name: "telemetry", method: "GET", path: "/api/telemetry" },
  { name: "party", method: "GET", path: "/api/party" },
  { name: "memory.list", method: "GET", path: "/api/memory" },
  { name: "memory.update", method: "PATCH", path: "/api/memory/:id" },
  { name: "memory.remove", method: "DELETE", path: "/api/memory/:id" },
  { name: "notebook.pages", method: "GET", path: "/api/notebook" },
  { name: "notebook.page", method: "GET", path: "/api/notebook/page" },
  { name: "recent", method: "GET", path: "/api/recent" },
  { name: "directives.list", method: "GET", path: "/api/directives" },
  { name: "directives.add", method: "POST", path: "/api/directives" },
  { name: "directives.remove", method: "DELETE", path: "/api/directives/:id" },
  { name: "extensions.list", method: "GET", path: "/api/extensions" },
  { name: "extensions.action", method: "POST", path: "/api/extensions/:id/:action" },
  { name: "mcp.list", method: "GET", path: "/api/mcp" },
  { name: "mcp.action", method: "POST", path: "/api/mcp/:name/:action" },
  { name: "queue.list", method: "GET", path: "/api/queue" },
  { name: "queue.pause", method: "POST", path: "/api/queue/pause" },
  { name: "queue.resume", method: "POST", path: "/api/queue/resume" },
  // The old table had one `/api/queue/:id/:action` for both; each action is a route of its own now.
  { name: "queue.skip", method: "POST", path: "/api/queue/:id/skip" },
  { name: "queue.move", method: "POST", path: "/api/queue/:id/move" },
  { name: "stage.status", method: "GET", path: "/api/stage" },
  { name: "stage.scene", method: "POST", path: "/api/stage/scene" },
  { name: "stage.scenes", method: "GET", path: "/api/stage/scenes" },
  { name: "stage.setSceneRole", method: "PUT", path: "/api/stage/scenes" },
  { name: "stage.classify", method: "POST", path: "/api/stage/scenes/classify" },
  { name: "stage.expression", method: "POST", path: "/api/stage/expression" },
  { name: "stage.stream", method: "POST", path: "/api/stage/stream" },
  { name: "stage.say", method: "POST", path: "/api/stage/say" },
  { name: "voice.state", method: "GET", path: "/api/voice" },
  { name: "voice.join", method: "POST", path: "/api/voice/join" },
  { name: "voice.leave", method: "POST", path: "/api/voice/leave" },
  { name: "voice.goLive", method: "POST", path: "/api/voice/golive" },
  { name: "songs.list", method: "GET", path: "/api/songs" },
  { name: "songs.request", method: "POST", path: "/api/songs" },
  { name: "songs.play", method: "POST", path: "/api/songs/play" },
  { name: "songs.stop", method: "POST", path: "/api/songs/stop" },
  { name: "game.start", method: "POST", path: "/api/game/start" },
  { name: "game.stop", method: "POST", path: "/api/game/stop" },
  { name: "game.goal", method: "POST", path: "/api/game/goal" },
  { name: "cluster.hosts", method: "GET", path: "/api/cluster/hosts" },
  { name: "cluster.invite", method: "POST", path: "/api/cluster/invites" },
  { name: "cluster.create", method: "POST", path: "/api/cluster/hosts" },
  { name: "cluster.approve", method: "POST", path: "/api/cluster/hosts/:name/approve" },
  { name: "cluster.remove", method: "DELETE", path: "/api/cluster/hosts/:name" },
  { name: "cluster.info", method: "GET", path: "/api/cluster/hosts/:name/info" },
  {
    name: "cluster.service",
    method: "POST",
    path: "/api/cluster/hosts/:name/services/:service/:action",
  },
  { name: "cluster.endpoints", method: "GET", path: "/api/cluster/endpoints" },
  { name: "data.inventory", method: "GET", path: "/api/data" },
  {
    name: "data.wipe",
    method: "POST",
    path: "/api/data/wipe",
    permission: MANAGE,
    refusal: MANAGE_REFUSAL,
  },
  {
    name: "data.reset",
    method: "POST",
    path: "/api/data/reset",
    permission: MANAGE,
    refusal: MANAGE_REFUSAL,
  },
];

describe("the admin routes of the table", () => {
  it.each(CASES)("$name is an admin route: $method $path", (c) => {
    expect(routeMeta(contract, c.name.split("."))).toEqual({
      audience: "admin",
      permission: c.permission ?? null,
      ...(c.refusal === undefined ? {} : { refusal: c.refusal }),
    });
  });

  it("holds the shell's flags the old routes had: neither public nor member", () => {
    const state = { publicSide: { config: { enabled: false } }, optional: () => undefined };
    const routes = rpcRoutes(state as never);
    for (const c of CASES) {
      const found = routes.filter((r) => r.method === c.method && r.path === c.path);
      expect(found, c.name).toHaveLength(1);
      expect(Boolean(found[0]?.public), `${c.name} public`).toBe(false);
      expect(Boolean(found[0]?.member), `${c.name} member`).toBe(false);
    }
  });
});

/** Both ways assignable: the schema's type and the owning package's type are one shape. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("the schemas agree with the types of the packages that own the shapes", () => {
  it("people", () => {
    const person: Same<ContractPerson, Person> = true;
    expect([person]).toEqual([true]);
  });

  it("modules, decisions and the cost report", () => {
    const module: Same<ContractModuleInfo, ModuleStatus> = true;
    const decision: Same<ContractDecisionRecord, DecisionRecord> = true;
    const cost: Same<ContractCostReport, CostReport> = true;
    expect([module, decision, cost]).toEqual([true, true, true]);
  });

  it("the mind view, a thought in the journal and an approval", () => {
    // The list leaves out what each thought saw and its reasoning, and says whether it has them.
    type Listed = Omit<Thought, "input" | "reasoning"> & {
      has_input: boolean;
      has_reasoning: boolean;
    };
    const thought: Same<ContractThoughtSummary, Listed> = true;
    const stats: Same<ContractMindStats, MindStats> = true;
    const emergency: Same<ContractEmergencyReport, EmergencyReport> = true;
    const approval: Same<ContractPendingApproval, PendingApproval> = true;
    expect([thought, stats, emergency, approval]).toEqual([true, true, true, true]);
  });

  it("roles, assignments and mappings", () => {
    const role: Same<ContractRoleDefinition, RoleDefinition> = true;
    const assignment: Same<ContractRoleAssignment, RoleAssignment> = true;
    const mapping: Same<ContractRoleMapping, RoleMapping> = true;
    const scope: Same<ContractAuthScope, AuthScope> = true;
    expect([role, assignment, mapping, scope]).toEqual([true, true, true, true]);
  });

  it("the fact layer", () => {
    const event: Same<ContractLogEvent, LogEvent> = true;
    const chain: Same<ContractCauseChain, CauseChain> = true;
    const delivery: Same<ContractDelivery, Delivery> = true;
    expect([event, chain, delivery]).toEqual(Array(3).fill(true));
  });

  it("the call inspector and a thought in full", () => {
    const call: Same<ContractLlmCallRecord, LlmCallRecord> = true;
    const detail: Same<ContractLlmCallDetail, LlmCallDetail> = true;
    const thinking: Same<ContractLlmThinkingPage, Omit<LlmThinkingPage, never> & { kept: number }> =
      true;
    const stats: Same<ContractLlmCallStats, LlmCallStats & { prices: Record<string, Pricing> }> =
      true;
    const thought: Same<ContractThought, Thought> = true;
    expect([call, detail, thinking, stats, thought]).toEqual(Array(5).fill(true));
  });

  it("the body, the arbiter and what she organized and learned", () => {
    const snapshot: Same<ContractActivitySnapshot, ActivitySnapshot> = true;
    const task: Same<ContractActivityTask, ActivityTask> = true;
    const ledger: Same<ContractLedgerView, LedgerView> = true;
    // A decision with where its impulse was aimed and what it was.
    type Decided = ArbiterDecision & { context: ContextKey | null; summary: string | null };
    const decision: Same<ContractArbiterDecisionView, Decided> = true;
    const doc: Same<
      ContractKnowledgeDoc,
      KnowledgeDoc & { short_id: string; subject_label: string }
    > = true;
    const note: Same<ContractConversationNote, ConversationState & { label: string | null }> = true;
    const lesson: Same<ContractLesson, Lesson & { display_name: string | null }> = true;
    const run: Same<ContractReflectionRun, ReflectionRun> = true;
    const stats: Same<ContractReflectionStats, ReflectionStats> = true;
    const tally: Same<ContractFeedbackTally, FeedbackTally> = true;
    const digest: Same<ContractThoughtDigest, ThoughtDigest> = true;
    expect([
      snapshot,
      task,
      ledger,
      decision,
      doc,
      note,
      lesson,
      run,
      stats,
      tally,
      digest,
    ]).toEqual(Array(11).fill(true));
  });

  it("her life, her skills and the tools she wrote", () => {
    const entry: Same<ContractLifeEntry, LifeEntry> = true;
    const reminder: Same<ContractReminderView, Reminder> = true;
    const file: Same<ContractSkillFile, SkillShelfFile> = true;
    const tool: Same<ContractProposedTool, ProposedTool> = true;
    const health: Same<ContractSandboxHealth, SandboxHealth> = true;
    expect([entry, reminder, file, tool, health]).toEqual(Array(5).fill(true));
  });

  it("the economy", () => {
    type Health = Awaited<ReturnType<Economy2["health"]>>;
    type Prediction = Awaited<ReturnType<Economy2["predictions"]>>[number];
    type Room = Awaited<ReturnType<Economy2["room"]>>[number];
    type Quests = Awaited<ReturnType<Economy2["quests"]>>;
    const health: Same<ContractEconomyHealth, Health & { currency: string }> = true;
    const prediction: Same<ContractPredictionView, Prediction> = true;
    const room: Same<ContractRoomItem, Room> = true;
    const quests: Same<ContractQuestsView, Quests & { currency: string }> = true;
    expect([health, prediction, room, quests]).toEqual(Array(4).fill(true));
  });

  it("her inner state, her world, her mood and her goals", () => {
    // The self module's snapshot with her impressions of people from the heart's rows (named), and
    // the world's with its channels named. The panel's person cards are the heart's rows in the old
    // words (`api/src/affect.ts`), with no type of their own to match.
    type Feeling = { person: PersonId; text: string; updated_at: Timestamp };
    type Self = SelfSnapshot & { feelings: (Feeling & { display_name: string | null })[] };
    type World = Omit<WorldSnapshot, "channels"> & {
      channels: (ChannelActivity & { label: string | null })[];
    };
    const self: Same<ContractSelfView, Self> = true;
    const world: Same<ContractWorldView, World> = true;
    const affect: Same<ContractAffectSnapshot, AffectSnapshot> = true;
    const goal: Same<ContractGoal, Goal> = true;
    expect([self, world, affect, goal]).toEqual(Array(4).fill(true));
  });

  it("the saved prompts, how turns ended and the party games", () => {
    const prompt: Same<ContractSavedPrompt, SavedPrompt> = true;
    // A row of the log may carry the corrections that fired in the turn.
    const outcome: Same<ContractTurnOutcomeRecord, CountedOutcome> = true;
    const party: Same<ContractPartySnapshot, PartySnapshot> = true;
    expect([prompt, outcome, party]).toEqual([true, true, true]);
  });

  it("her memories, notebook, just-now timeline and the owner's rules", () => {
    // A record without its search tokens and vector (saying whether it has one) and without who
    // told her and where the origin was recorded: the view never carried those.
    const record: Same<
      ContractMemoryRecordView,
      Omit<MemoryRecord, "tokens" | "embedding" | "source" | "origin" | "source_events"> & {
        has_embedding: boolean;
      }
    > = true;
    const entry: Same<ContractNotebookEntry, NotebookEntry> = true;
    const page: Same<ContractNotebookPage, NotebookPage> = true;
    const line: Same<ContractJustNowEntry, JustNowEntry> = true;
    const directive: Same<ContractDirective, Directive> = true;
    expect([record, entry, page, line, directive]).toEqual(Array(5).fill(true));
  });

  it("extensions, MCP servers, the queue, the stage and the voice monitor", () => {
    const extension: Same<ContractExtensionInfo["state"], ModuleStateKind> = true;
    // The server reports the transport as a string (`stdio` or `http`).
    const transport: Same<ContractMcpServerInfo["transport"], ServerStatus["transport"]> = true;
    const item: Same<ContractQueueItemInfo["state"], ItemState> = true;
    const scenes: Same<ContractSceneRolesState, SceneRolesView> = true;
    const stage: Same<ContractStageState["overlay_url"], StageStatus["overlay_url"]> &
      Same<ContractStageState["obs_warning"], StageStatus["obs_warning"]> = true;
    const participant: Same<ContractVoiceSession["participants"][number], VoiceParticipant> = true;
    const context: Same<ContractVoiceSession["context"], ContextKey> = true;
    expect([extension, transport, item, scenes, stage, participant, context]).toEqual(
      Array(7).fill(true),
    );
  });

  it("songs and data", () => {
    const song: Same<ContractSongView["state"], SongEntry["state"]> = true;
    const category: Same<ContractDataCategoryId, DataCategoryId | typeof TOOLS_WORKSPACE> = true;
    // The inventory is the store's category with what the category table says of it.
    type Category = Omit<CategoryInventory, "id"> & {
      id: DataCategoryId | typeof TOOLS_WORKSPACE;
      shared: boolean;
      kept: boolean;
      exportable: boolean;
      confirm: "typed" | "simple";
      requires: (DataCategoryId | typeof TOOLS_WORKSPACE)[];
    };
    const view: Same<ContractDataCategoryView, Category> = true;
    const note: Same<ContractDataNote, "restart_core" | "consent_cache"> = true;
    const wiped: Same<
      ContractDataWipeResult,
      {
        deleted: (DataCategoryId | typeof TOOLS_WORKSPACE)[];
        counts: Record<string, number>;
        failed_modules: string[];
        notes: ("restart_core" | "consent_cache")[];
      }
    > = true;
    expect([song, category, view, note, wiped]).toEqual(Array(5).fill(true));
  });

  it("the data node and its refusal are the ones the data routes had", () => {
    for (const name of ["wipe", "reset"]) {
      expect(routeMeta(contract, ["data", name])).toMatchObject({
        permission: NODE_DATA_MANAGE,
        refusal: `managing her data needs \`${NODE_DATA_MANAGE}\``,
      });
    }
  });

  it("the owner node is the one the gate's commands use", () => {
    expect(routeMeta(contract, ["mind", "approve"])?.permission).toBe(NODE_APPROVE);
  });
});
