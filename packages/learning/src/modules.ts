// The three modules: `conversation` (continuous compaction), `knowledge` (her documents) and
// `reflect` (feedback signals, lessons, daily and light reflections).

import { ActuatorRegistryKey, actuatorsFor } from "@miyoria/actions";
import {
  defineManifest,
  errorMessage,
  type Module,
  type ModuleContext,
  type ServiceLookup,
  sleep,
  withTimeout,
} from "@miyoria/kernel";
import { LlmRouterKey } from "@miyoria/llm";
import {
  MessageLogKey,
  PeopleStoreKey,
  type SettingsStore,
  SettingsStoreKey,
  StoredHandleDirectory,
  StoreKey,
} from "@miyoria/store";
import { ToolRegistryKey } from "@miyoria/tools";
import {
  type AccountRef,
  type Clock,
  CONVERSATION_FOLDED_TOPIC,
  ConversationStatesKey,
  contextKeyString,
  customEvent,
  type HandleDirectory,
  HandleDirectoryKey,
  isJsonObject,
  type JsonValue,
  KnowledgeKey,
  type KnowledgeSubject,
  LessonsKey,
  type PersonId,
  PersonProfilesKey,
  PlatformSinksKey,
  Principals,
  type ProfileId,
  PromptContributorsKey,
  type PromptRequest,
  REACTION_TOPIC,
  ReflectionKey,
  SocialSignalsKey,
} from "@miyoria/types";
import type { BudgetState } from "./caps.js";
import {
  ConversationConfigSchema,
  KnowledgeConfigSchema,
  peopleInPrompt,
  ReflectConfigSchema,
} from "./config.js";
import { ConversationEngine, FEEDBACK_TOPIC } from "./conversation.js";
import { DIARY_CAPABILITY, Diary, diaryCapability } from "./diary.js";
import { FeedbackTracker } from "./feedback.js";
import { KnowledgeStore } from "./knowledge.js";
import { LessonStore } from "./lessons.js";
import { recapAgeNote } from "./recap-age.js";
import { Reflector } from "./reflect.js";
import { KNOWLEDGE_TOOL, KnowledgeTool } from "./tool.js";

const STORE_TIMEOUT_MS = 5_000;
export const CONVERSATION_CONTRIBUTOR = "conversation";
export const KNOWLEDGE_CONTRIBUTOR = "knowledge";
export const LESSONS_CONTRIBUTOR = "lessons";
/** Published after each document change (`{doc, deleted}`). */
export const KNOWLEDGE_CHANGED_TOPIC = "knowledge.changed";

function budgetOf(services: ServiceLookup): BudgetState {
  return services.get(LlmRouterKey)?.budgetState() ?? "ok";
}

/**
 * The shared handle table, or (apps that did not provide one) a table of this module's own that
 * reads and writes the same settings rows.
 */
async function handlesOf(
  services: ServiceLookup,
  settings: SettingsStore | null,
  clock: Clock,
): Promise<HandleDirectory> {
  const shared = services.get(HandleDirectoryKey);
  if (shared) return shared;
  try {
    return await StoredHandleDirectory.open(settings, clock);
  } catch {
    return new StoredHandleDirectory(null, clock);
  }
}

function personOf(services: ServiceLookup, account: AccountRef): PersonId | null {
  return services.get(SocialSignalsKey)?.attitude(account)?.person ?? null;
}

async function loadWithTimeout(ctx: ModuleContext, what: string, load: () => Promise<void>) {
  try {
    const done = await withTimeout(
      load().then(() => true),
      STORE_TIMEOUT_MS,
    );
    if (done === undefined) ctx.log.warn(`loading ${what} timed out`);
  } catch (error) {
    ctx.log.warn({ err: errorMessage(error) }, `cannot load ${what}`);
  }
}

export interface LearningModuleOptions {
  clock?: Clock;
}

// ---- conversation ---------------------------------------------------------------------------

/**
 * Module `conversation`: folds every context's conversation into her running notes
 * (`ConversationStatesKey`) every few lines or after a pause, in the background. Registers the
 * prompt contributor `conversation` (「這段對話的前情提要」) and publishes `conversation.folded`
 * (memory consolidates right after, reflect notices long sessions).
 */
export class ConversationModule implements Module {
  static readonly ID = "conversation";
  readonly manifest = defineManifest(ConversationModule.ID, "Conversation notes", {
    description: "Continuous conversation compaction into her own structured notes",
    requires: ["llm"],
    optional: ["social", "knowledge"],
    configSchema: ConversationConfigSchema,
  });
  #engine: ConversationEngine | null = null;

  constructor(
    private readonly profile: ProfileId,
    private readonly options: LearningModuleOptions = {},
  ) {}

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(ConversationConfigSchema);
    const s = ctx.services;
    const store = s.get(StoreKey);
    const clock = this.options.clock ?? ctx.clock;
    const engine = new ConversationEngine({
      config,
      profile: this.profile,
      store: s.get(SettingsStoreKey) ?? store?.settings ?? null,
      messages: s.get(MessageLogKey) ?? store?.messages ?? null,
      people: s.get(PeopleStoreKey) ?? store?.people ?? null,
      router: () => s.get(LlmRouterKey),
      knowledge: () => s.get(KnowledgeKey),
      personOf: (account) => personOf(s, account),
      handles: await handlesOf(s, s.get(SettingsStoreKey) ?? store?.settings ?? null, clock),
      clock,
      publish: (e) => ctx.publish(e),
      log: ctx.log,
    });
    await loadWithTimeout(ctx, "conversation states", () => engine.load());
    this.#engine = engine;
    ctx.provide(ConversationStatesKey, engine);
    s.get(PromptContributorsKey)?.register({
      key: CONVERSATION_CONTRIBUTOR,
      // From memory only: safe on the voice hot path.
      contribute: async (request: PromptRequest) => {
        const recap = engine.render(request.context, config.prompt_chars);
        const state = engine.get(request.context);
        if (recap === null || state === null) return [];
        // A recap that fell behind says so (v4 §5.7): she reads it as of then, not as of now.
        const age = recapAgeNote(state, request.now, {
          offsetMinutes: config.utc_offset_minutes,
        });
        const body = age === "" ? recap : `${recap}\n${age}`;
        return [{ key: CONVERSATION_CONTRIBUTOR, title: "這段對話的前情提要", body, order: 5 }];
      },
    });
    const sub = ctx.subscribe(["platform.message.created", "voice.utterance", "voice.playback"]);
    ctx.spawn("lines", async () => {
      for await (const env of sub) {
        const e = env.event;
        if (e.type === "platform_message_created") engine.line(e.data.id.context, clock.now());
        else if (e.type === "voice_utterance") engine.line(e.data.context, clock.now());
        else if (e.type === "voice_playback" && e.data.state === "started") {
          engine.line(e.data.context, clock.now());
        }
      }
    });
    ctx.spawn("fold", async (signal) => {
      const tick = config.tick_secs * 1000;
      while (!signal.aborted) {
        try {
          await sleep(tick, signal);
        } catch {
          return;
        }
        const budget = budgetOf(s);
        for (const context of engine.due(clock.now(), budget)) {
          if (signal.aborted) return;
          try {
            const result = await engine.fold(context, budget, signal);
            if (typeof result !== "string") {
              ctx.log.debug({ context: contextKeyString(context) }, "conversation folded");
            }
          } catch (error) {
            if (signal.aborted) return;
            ctx.log.warn(
              { context: contextKeyString(context), err: errorMessage(error) },
              "fold failed, will retry",
            );
          }
        }
      }
    });
  }

  async stop(): Promise<void> {
    await this.#engine?.flush();
    this.#engine = null;
  }
}

// ---- knowledge ------------------------------------------------------------------------------

/**
 * Module `knowledge`: her self-organized documents (`KnowledgeKey`), the prompt contributor
 * `knowledge` (「你整理的資料」: documents about the people here, this server and topics that
 * came up) and the tool `knowledge_note`.
 */
export class KnowledgeModule implements Module {
  static readonly ID = "knowledge";
  readonly manifest = defineManifest(KnowledgeModule.ID, "Knowledge", {
    description: "Her self-organized documents about people, servers, herself and topics",
    optional: ["social"],
    configSchema: KnowledgeConfigSchema,
  });
  #store: KnowledgeStore | null = null;
  #cleanup: (() => void) | null = null;

  constructor(
    private readonly profile: ProfileId,
    private readonly options: LearningModuleOptions = {},
  ) {}

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(KnowledgeConfigSchema);
    const s = ctx.services;
    const kb = new KnowledgeStore(
      s.get(SettingsStoreKey) ?? s.get(StoreKey)?.settings ?? null,
      this.profile,
      config,
      this.options.clock ?? ctx.clock,
      (doc, deleted) =>
        ctx.publish(
          customEvent(KNOWLEDGE_CHANGED_TOPIC, {
            doc: JSON.parse(JSON.stringify(doc)) as JsonValue,
            deleted,
          }),
        ),
    );
    await loadWithTimeout(ctx, "her documents", () => kb.load());
    this.#store = kb;
    ctx.provide(KnowledgeKey, kb);
    const contributors = s.get(PromptContributorsKey);
    contributors?.register({
      key: KNOWLEDGE_CONTRIBUTOR,
      contribute: async (request: PromptRequest) => {
        const people = peopleInPrompt(config.prompt_people, s.get(PersonProfilesKey) !== undefined);
        const body = kb.render(subjectsFor(kb, request, people), {
          context: request.context,
          maxChars: config.prompt_chars,
        });
        return body === ""
          ? []
          : [{ key: KNOWLEDGE_CONTRIBUTOR, title: "你整理的資料", body, order: 25 }];
      },
    });
    const tools = s.get(ToolRegistryKey);
    if (config.tool && tools) {
      tools.register(
        new KnowledgeTool({
          store: kb,
          personOf: (tc) => personOf(s, tc.account),
          nameOf: () => null,
        }),
      );
    }
    this.#cleanup = () => {
      contributors?.unregister(KNOWLEDGE_CONTRIBUTOR);
      tools?.unregister(KNOWLEDGE_TOOL);
    };
  }

  async stop(): Promise<void> {
    this.#cleanup?.();
    this.#cleanup = null;
    await this.#store?.flush();
    this.#store = null;
  }
}

/**
 * The people of the turn (speakers first, unless `people` is off: the person profiles carry
 * them), this server, topics named in the input, herself.
 */
export function subjectsFor(
  kb: KnowledgeStore,
  request: PromptRequest,
  people = true,
): KnowledgeSubject[] {
  const out: KnowledgeSubject[] = [];
  const speakers = request.participants.filter((p) =>
    request.speakers.some((a) => a.platform === p.account.platform && a.id === p.account.id),
  );
  for (const p of people ? [...speakers, ...request.participants] : []) {
    if (p.person !== null) out.push({ type: "person", person: p.person });
  }
  if (request.context.scope !== null && request.context.kind !== "dm") {
    out.push({ type: "guild", platform: request.context.platform, guild: request.context.scope });
  }
  const text = `${request.query}\n${request.recent.join("\n")}`.toLowerCase();
  for (const doc of kb.docs()) {
    if (doc.subject.type !== "topic") continue;
    const name = doc.subject.name.toLowerCase();
    if ((name.length >= 2 && text.includes(name)) || text.includes(doc.title.toLowerCase())) {
      out.push(doc.subject);
    }
  }
  out.push({ type: "self" });
  return out;
}

// ---- reflect --------------------------------------------------------------------------------

/**
 * Module `reflect`: records feedback signals (reactions to her messages, replies, ignored
 * openings, explicit phrases, refused actions), keeps her lessons (`LessonsKey`, prompt
 * contributor `lessons`) and runs her daily and light reflections (`ReflectionKey`).
 */
export class ReflectModule implements Module {
  static readonly ID = "reflect";
  readonly manifest = defineManifest(ReflectModule.ID, "Reflection", {
    description: "Feedback signals, lessons and her daily reflection",
    requires: ["llm"],
    optional: ["self", "memory", "knowledge", "conversation", "social", "mind", "actions"],
    configSchema: ReflectConfigSchema,
  });
  #flush: (() => Promise<void>) | null = null;
  #cleanup: (() => void) | null = null;

  constructor(
    private readonly profile: ProfileId,
    private readonly options: LearningModuleOptions & {
      name?: string;
      names?: readonly string[];
      persona?: (services: ServiceLookup) => string;
    } = {},
  ) {}

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(ReflectConfigSchema);
    const s = ctx.services;
    const clock = this.options.clock ?? ctx.clock;
    const settings = s.get(SettingsStoreKey) ?? s.get(StoreKey)?.settings ?? null;
    const feedback = new FeedbackTracker(
      settings,
      this.profile,
      {
        utcOffsetMinutes: config.utc_offset_minutes,
        keepDays: config.feedback_days,
        replyWindowMs: config.reply_window_mins * 60_000,
      },
      clock,
    );
    const lessons = new LessonStore(settings, this.profile, config.max_lessons, clock);
    const persona = this.options.persona;
    const reflector = new Reflector({
      config,
      profile: this.profile,
      name: this.options.name ?? "她",
      persona: () => (persona ? persona(s) : ""),
      services: s,
      store: settings,
      clock,
      feedback,
      lessons,
      handles: await handlesOf(s, settings, clock),
    });
    await loadWithTimeout(ctx, "feedback", () => feedback.load());
    await loadWithTimeout(ctx, "lessons", () => lessons.load());
    await loadWithTimeout(ctx, "reflections", () => reflector.load());
    const idle = (): string | null => {
      if (s.get(ActuatorRegistryKey)?.paused) return "paused";
      if (config.max_calls_per_day === 0) return "max_calls_per_day is 0";
      return null;
    };
    ctx.provide(LessonsKey, lessons);
    ctx.provide(ReflectionKey, {
      runs: (limit?: number) => reflector.runs(limit),
      feedback: (days?: number) => feedback.tallies(days),
      stats: () => reflector.stats(budgetOf(s), idle()),
    });
    const contributors = s.get(PromptContributorsKey);
    contributors?.register({
      key: LESSONS_CONTRIBUTOR,
      contribute: async (request: PromptRequest) => {
        const people = request.participants.flatMap((p) => (p.person === null ? [] : [p.person]));
        const lines: string[] = [];
        let used = 0;
        for (const l of lessons.applicable(request.context, people)) {
          const line = `- ${l.text}`;
          used += [...line].length + 1;
          if (used > config.prompt_chars) break;
          lines.push(line);
        }
        return lines.length === 0
          ? []
          : [{ key: LESSONS_CONTRIBUTOR, title: "你學到的事", body: lines.join("\n"), order: 15 }];
      },
    });
    this.#cleanup = () => contributors?.unregister(LESSONS_CONTRIBUTOR);
    this.#flush = async () => {
      await feedback.persist();
      await lessons.flush();
      await reflector.flush();
    };

    const names = (this.options.names ?? []).map((n) => n.toLowerCase()).filter((n) => n !== "");
    const selfIds = new Set<string>();
    const startedTurns = new Set<string>();
    const who = (account: AccountRef, name: string | null) => ({
      account,
      person: personOf(s, account),
      name,
    });
    const sub = ctx.subscribe([
      "platform.ready",
      "platform.message.created",
      "voice.utterance",
      "action.completed",
      REACTION_TOPIC,
      "agent.decision",
      "agent.turn.completed",
      "gate.decision",
      FEEDBACK_TOPIC,
      CONVERSATION_FOLDED_TOPIC,
    ]);
    ctx.spawn("signals", async () => {
      for await (const env of sub) {
        try {
          const e = env.event;
          switch (e.type) {
            case "platform_ready":
              selfIds.add(e.data.self_account.id);
              break;
            case "platform_message_created": {
              const m = e.data;
              reflector.activity(clock.now());
              if (selfIds.has(m.author.account.id)) break;
              const text = m.text.toLowerCase();
              const addressed =
                m.mentions_self ||
                m.reply_to_self ||
                m.id.context.kind === "dm" ||
                names.some((n) => text.includes(n));
              feedback.message(m, who(m.author.account, m.author.display_name), addressed);
              break;
            }
            case "voice_utterance":
              reflector.activity(clock.now());
              break;
            case "action_completed":
              if (e.data.ok && e.data.message) {
                feedback.ownMessage(e.data.message.id, e.data.message.context);
              }
              break;
            case "agent_decision": {
              const first = e.data.reasons[0] ?? "";
              if (
                e.data.respond &&
                (first.startsWith("intent:") || first.startsWith("initiative:"))
              ) {
                startedTurns.add(e.data.turn);
                if (startedTurns.size > 200) {
                  const oldest = startedTurns.values().next().value;
                  if (oldest !== undefined) startedTurns.delete(oldest);
                }
              }
              break;
            }
            case "agent_turn_completed":
              if (e.data.text.trim() !== "") {
                feedback.spoke(e.data.context, startedTurns.delete(e.data.turn));
              }
              break;
            case "custom": {
              const { topic, payload } = e.data;
              if (!isJsonObject(payload)) break;
              if (topic === REACTION_TOPIC) {
                const msg = isJsonObject(payload.message) ? payload.message : null;
                const account = isJsonObject(payload.account) ? payload.account : null;
                if (!msg || !account || typeof msg.id !== "string") break;
                if (typeof account.platform !== "string" || typeof account.id !== "string") break;
                if (selfIds.has(account.id)) break;
                const ref = { platform: account.platform, id: account.id };
                feedback.reaction(
                  msg.id,
                  who(ref, typeof payload.display_name === "string" ? payload.display_name : null),
                  typeof payload.emoji === "string" ? payload.emoji : "",
                  payload.added !== false,
                );
              } else if (topic === "gate.decision") {
                const p = isJsonObject(payload.principal) ? payload.principal : null;
                if (payload.allowed !== false || p?.kind !== "self") break;
                const context = parseCtx(p.context);
                feedback.denied(
                  context,
                  String(payload.capability ?? ""),
                  String(payload.reason ?? ""),
                );
              } else if (topic === FEEDBACK_TOPIC) {
                const account = isJsonObject(payload.account) ? payload.account : null;
                const context = parseCtx(payload.context);
                if (
                  !account ||
                  typeof account.id !== "string" ||
                  typeof account.platform !== "string"
                ) {
                  break;
                }
                feedback.noticed(
                  {
                    account: { platform: account.platform, id: account.id },
                    person: typeof payload.person === "string" ? payload.person : null,
                    name: typeof payload.name === "string" ? payload.name : null,
                  },
                  context,
                  payload.tone === "negative" ? "negative" : "positive",
                  typeof payload.quote === "string" ? payload.quote : "",
                );
              } else if (topic === CONVERSATION_FOLDED_TOPIC) {
                const context = parseCtx(payload.context);
                if (context && typeof payload.session_lines === "number") {
                  reflector.folded(context, payload.session_lines);
                }
              }
              break;
            }
            default:
              break;
          }
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "could not handle a feedback event");
        }
      }
    });
    const diary = new Diary(config.diary, {
      router: () => s.get(LlmRouterKey),
      sinks: () => s.get(PlatformSinksKey),
      persona: () => (persona ? persona(s) : ""),
      name: this.options.name ?? "她",
      store: settings,
      profile: this.profile,
    });
    await loadWithTimeout(ctx, "diary", () => diary.load());
    // With a channel, writing it is hers to choose too (the "diary" row of her activity table);
    // without one the capability is not there and the row stays skipped.
    const actuators = actuatorsFor(ctx);
    if (diary.where() !== null) {
      const off = actuators.register(diaryCapability(diary, () => reflector.runs(5)));
      const cleanup = this.#cleanup;
      this.#cleanup = () => {
        off();
        cleanup?.();
      };
    }
    /** The entry after a daily reflection, through the gate like any of her own actions. */
    const writeDiary = async (): Promise<void> => {
      if (diary.where() === null || !config.diary.after_reflection) return;
      const outcome = await (s.get(ActuatorRegistryKey) ?? actuators).invoke({
        principal: Principals.self(null),
        capability: DIARY_CAPABILITY,
        args: {},
        why: "每日回顧之後寫日記",
        turn: null,
      });
      if (outcome.status === "denied") {
        ctx.log.info({ why: outcome.decision.reason }, "no diary entry after the reflection");
      } else if (outcome.status === "failed") {
        ctx.log.warn({ error: outcome.error }, "she could not write her diary");
      }
    };
    ctx.spawn("reflect", async (signal) => {
      while (!signal.aborted) {
        try {
          await sleep(30_000, signal);
        } catch {
          return;
        }
        feedback.sweep();
        await feedback.persist();
        if (idle() !== null) continue;
        const due = reflector.due(clock.now(), budgetOf(s));
        if (due === null) continue;
        const run = await reflector.reflect(
          due.kind,
          due.kind === "light" ? due.context : null,
          signal,
        );
        if (run) {
          ctx.publish(customEvent("reflect.run", JSON.parse(JSON.stringify(run)) as JsonValue));
          if (run.kind === "daily") {
            void writeDiary().catch((error: unknown) => {
              ctx.log.warn({ error: errorMessage(error) }, "she could not write her diary");
            });
          }
          ctx.log.info(
            { kind: run.kind, error: run.error, lessons: run.lessons.length },
            "she reflected",
          );
        }
      }
    });
  }

  async stop(): Promise<void> {
    this.#cleanup?.();
    this.#cleanup = null;
    await this.#flush?.();
    this.#flush = null;
  }
}

function parseCtx(value: JsonValue | undefined) {
  if (!isJsonObject(value)) return null;
  const { platform, scope, channel, kind } = value;
  if (typeof platform !== "string" || typeof channel !== "string") return null;
  if (kind !== "channel" && kind !== "thread" && kind !== "dm" && kind !== "voice") return null;
  return { platform, scope: typeof scope === "string" ? scope : null, channel, kind } as const;
}
