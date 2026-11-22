// The three modules: `conversation` (continuous compaction), `knowledge` (her documents) and
// `reflect` (feedback signals, lessons, daily and light reflections).

import { ActuatorRegistryKey, actuatorsFor } from "@miyoria/gate/actions";
import { LlmRouterKey } from "@miyoria/llm/llm";
import { ToolRegistryKey } from "@miyoria/llm/tools";
import {
  defineManifest,
  errorMessage,
  type Module,
  type ModuleContext,
  type ServiceLookup,
  sleep,
  withTimeout,
} from "@miyoria/runtime/kernel";
import {
  MessageLogKey,
  PeopleStoreKey,
  type SettingsStore,
  SettingsStoreKey,
  StoredHandleDirectory,
  StoreKey,
} from "@miyoria/store";
import {
  type AccountRef,
  type BusEvent,
  type Clock,
  ConversationStatesKey,
  contextKeyString,
  Events,
  type HandleDirectory,
  HandleDirectoryKey,
  is,
  isJsonObject,
  type JsonValue,
  type KnowledgeBase,
  type KnowledgeDoc,
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
  type ReflectGuard,
  ReflectGuardKey,
  ReflectionKey,
  type ReflectionRun,
  type SelfDocument,
  SelfDocumentKey,
  SocialSignalsKey,
} from "@miyoria/types";
import { NotesKnowledge } from "../../notes/src/knowledge.js";
import { type NotesStore, notesTables, SELF_SUBJECT } from "../../notes/src/store.js";
import { NotesSearchKey } from "../../notes/src/vectors.js";
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
import { NightlyTidy } from "./tidy.js";
import { KNOWLEDGE_TOOL, KnowledgeTool } from "./tool.js";

const STORE_TIMEOUT_MS = 5_000;
export const CONVERSATION_CONTRIBUTOR = "conversation";
export const KNOWLEDGE_CONTRIBUTOR = "knowledge";
export const LESSONS_CONTRIBUTOR = "lessons";
/** Topic documents the knowledge section adds when they are close in meaning to the line. */
const TOPICS_BY_MEANING = 2;

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

/**
 * Runs a reflection that is due: under `guard` (the text runner's accounting of the nightly
 * reflection) when there is one, else as it is. `skipped` says why the guard let nothing run.
 */
export async function reflectUnder(
  guard: ReflectGuard | undefined,
  reflect: (signal: AbortSignal) => Promise<ReflectionRun | null>,
  signal: AbortSignal,
): Promise<{ run: ReflectionRun | null; skipped: string | null }> {
  if (guard === undefined) return { run: await reflect(signal), skipped: null };
  const out = await guard.run(reflect, signal);
  return { run: out.result, skipped: out.ran ? null : (out.why ?? "") };
}

/**
 * The nightly reflection on each person (`Reflector.reflectPeople`), under the text runner's
 * accounting of the nightly figure (`ReflectGuardKey`) like the daily reflection. When nothing ran
 * under it (the figure is used up) or the figure ran out on the way, the pass is over for today.
 */
export async function reflectOnPeople(
  ctx: Pick<ModuleContext, "services" | "clock" | "log">,
  reflector: Reflector,
  signal: AbortSignal,
): Promise<string[]> {
  const guard = ctx.services.get(ReflectGuardKey);
  let names: string[] = [];
  try {
    if (guard === undefined) {
      names = await reflector.reflectPeople(signal);
    } else {
      const out = await guard.run((within) => reflector.reflectPeople(within), signal);
      if (!out.ran) {
        ctx.log.info({ why: out.why }, "the nightly reflection on people did not run");
        reflector.peopleFinished(ctx.clock.now());
        return [];
      }
      if (out.result === null) {
        // The guard caught a failure (or the figure ran out): over for today, not tried again at
        // every tick, each try a job row of its own.
        if (signal.aborted) return [];
        ctx.log.warn({ why: out.why }, "the nightly reflection on people failed");
        reflector.peopleFinished(ctx.clock.now());
        return [];
      }
      names = out.result;
    }
  } catch (error) {
    if (signal.aborted) return [];
    ctx.log.warn({ err: errorMessage(error) }, "the nightly reflection on people failed");
    reflector.peopleFinished(ctx.clock.now());
    return [];
  }
  if (names.length > 0) ctx.log.info({ people: names.length }, "she reflected on people");
  return names;
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
    icon: "messages-square",
    category: "her",
    description: "Continuous conversation compaction into her own structured notes",
    requires: ["llm"],
    optional: ["heart", "knowledge"],
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
      publish: ctx.publisher,
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
    const sub = ctx.subscribe([
      Events.PlatformMessageCreated.type,
      Events.VoiceUtteranceEvent.type,
      Events.VoicePlaybackEvent.type,
    ]);
    ctx.spawn("lines", async () => {
      for await (const env of sub) {
        if (is(Events.PlatformMessageCreated, env)) engine.line(env.data.id.context, clock.now());
        else if (is(Events.VoiceUtteranceEvent, env)) engine.line(env.data.context, clock.now());
        else if (is(Events.VoicePlaybackEvent, env) && env.data.state === "started") {
          engine.line(env.data.context, clock.now());
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
    icon: "lightbulb",
    category: "her",
    description: "Her self-organized documents about people, servers, herself and topics",
    optional: ["heart"],
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
        ctx.publish(Events.KnowledgeChanged, {
          doc: JSON.parse(JSON.stringify(doc)) as KnowledgeDoc,
          deleted,
        }),
    );
    await loadWithTimeout(ctx, "her documents", () => kb.load());
    this.#store = kb;
    // Her documents live in the notes, for reading and writing. The old store is the whole of it
    // only where there is no database (a bare test rig); nothing live reads it but the importer.
    const notesStore = s.get(StoreKey)?.plugin(notesTables) ?? null;
    const notes =
      notesStore === null
        ? null
        : new NotesKnowledge({ notes: notesStore, resolver: notesStore.resolver() });
    const base: KnowledgeBase = notes === null ? kb : notes.base();
    ctx.provide(KnowledgeKey, base);
    if (notes !== null) ctx.provide(SelfDocumentKey, new CachedSelfDocument(notes.notes));
    const topics = (request: PromptRequest) =>
      notes === null
        ? kb
        : {
            docs: () =>
              notes.notes
                .list(notes.viewerFor(request.context, request.speakers), { kind: "topic" })
                .map((e) => ({
                  subject: { type: "topic" as const, name: e.document.title },
                  title: e.document.title,
                })),
          };
    const contributors = s.get(PromptContributorsKey);
    contributors?.register({
      key: KNOWLEDGE_CONTRIBUTOR,
      contribute: async (request: PromptRequest, signal?: AbortSignal) => {
        const people = peopleInPrompt(config.prompt_people, s.get(PersonProfilesKey) !== undefined);
        // Where her documents are in the notes, her own document is in the pinned block.
        const subjects = subjectsFor(topics(request), request, people, notes === null);
        const section = (body: string) =>
          body === ""
            ? []
            : [{ key: KNOWLEDGE_CONTRIBUTOR, title: "你整理的資料", body, order: 25 }];
        if (notes === null) {
          return section(
            kb.render(subjects, { context: request.context, maxChars: config.prompt_chars }),
          );
        }
        const viewer = notes.viewerFor(request.context, request.speakers);
        // With embeddings on and the line's vector there in time (a voice turn waits less):
        // lines close to it in meaning come first in each card, and topics it is about come in
        // even when their names are not said. Otherwise words alone, as without embeddings.
        const search = s.get(NotesSearchKey) ?? null;
        const vector =
          search === null
            ? null
            : await search.vector(request.query, {
                voice: request.voice,
                ...(signal === undefined ? {} : { signal }),
              });
        if (search !== null && vector !== null) {
          const found = notes.notes
            .search(request.query, viewer, {
              kind: "topic",
              limit: TOPICS_BY_MEANING,
              vector,
              ranking: search.ranking,
            })
            .map((hit): KnowledgeSubject => ({ type: "topic", name: hit.document.title }));
          subjects.push(...found);
        }
        return section(
          notes.render(subjects, viewer, config.prompt_chars, {
            query: request.query,
            ...(search === null ? {} : search.cardOptions(vector)),
          }),
        );
      },
    });
    const tools = s.get(ToolRegistryKey);
    if (config.tool && tools) {
      tools.register(
        new KnowledgeTool({
          store: base,
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
 * Her self document as the pinned block reads it: kept as read for as long as the document keeps
 * its version, so the block's text changes only when she rewrites it.
 */
export class CachedSelfDocument implements SelfDocument {
  #at: { version: string; budget: number; text: string } | null = null;

  constructor(private readonly notes: NotesStore) {}

  read(budget: number): string {
    const doc = this.notes.document(SELF_SUBJECT);
    const version = doc === null ? "" : `${doc.version}@${doc.updated_at}`;
    const kept = this.#at;
    if (kept !== null && kept.version === version && kept.budget === budget) return kept.text;
    const text = this.notes.readSelf({ budget });
    this.#at = { version, budget, text };
    return text;
  }
}

/**
 * The people of the turn (speakers first, unless `people` is off: the person profiles carry
 * them), this server, topics named in the input, herself (unless `self` is off: the pinned block
 * has her document).
 */
export function subjectsFor(
  kb: { docs(): readonly Pick<KnowledgeDoc, "subject" | "title">[] },
  request: PromptRequest,
  people = true,
  self = true,
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
  if (self) out.push({ type: "self" });
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
    icon: "notebook-pen",
    category: "her",
    description: "Feedback signals, lessons and her daily reflection",
    requires: ["llm"],
    optional: ["self", "memory", "knowledge", "conversation", "heart", "mind", "actions"],
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
      notes: s.get(StoreKey)?.plugin(notesTables) ?? null,
    });
    await loadWithTimeout(ctx, "feedback", () => feedback.load());
    await loadWithTimeout(ctx, "lessons", () => lessons.load());
    await loadWithTimeout(ctx, "reflections", () => reflector.load());
    const tidy = new NightlyTidy({
      config: config.tidy,
      purpose: config.purpose,
      utcOffsetMinutes: config.utc_offset_minutes,
      profile: this.profile,
      store: settings,
      clock,
      log: ctx.log,
    });
    await loadWithTimeout(ctx, "the notes tidy", () => tidy.load());
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
      Events.PlatformReady.type,
      Events.PlatformMessageCreated.type,
      Events.VoiceUtteranceEvent.type,
      Events.ActionCompleted.type,
      Events.PlatformReaction.type,
      Events.AgentDecision.type,
      Events.AgentTurnCompleted.type,
      Events.GateDecision.type,
      FEEDBACK_TOPIC,
      Events.ConversationFolded.type,
    ]);
    // One event of those it follows: what it says about how she is received.
    const signal = (env: BusEvent): void => {
      if (is(Events.PlatformReady, env)) {
        selfIds.add(env.data.self_account.id);
        return;
      } else if (is(Events.PlatformMessageCreated, env)) {
        const m = env.data;
        reflector.activity(clock.now());
        if (selfIds.has(m.author.account.id)) return;
        const text = m.text.toLowerCase();
        const addressed =
          m.mentions_self ||
          m.reply_to_self ||
          m.id.context.kind === "dm" ||
          names.some((n) => text.includes(n));
        feedback.message(m, who(m.author.account, m.author.display_name), addressed);
        return;
      } else if (is(Events.VoiceUtteranceEvent, env)) {
        reflector.activity(clock.now());
        return;
      } else if (is(Events.ActionCompleted, env)) {
        if (env.data.ok && env.data.message) {
          feedback.ownMessage(env.data.message.id, env.data.message.context);
        }
        return;
      } else if (is(Events.AgentDecision, env)) {
        // The runner's own reason comes first (`runner self`), the start's after it.
        const own = env.data.reasons.some(
          (r) => r.startsWith("intent:") || r.startsWith("initiative:"),
        );
        if (env.data.respond && own) {
          startedTurns.add(env.data.turn);
          if (startedTurns.size > 200) {
            const oldest = startedTurns.values().next().value;
            if (oldest !== undefined) startedTurns.delete(oldest);
          }
        }
        return;
      } else if (is(Events.AgentTurnCompleted, env)) {
        if (env.data.text.trim() !== "") {
          feedback.spoke(env.data.context, startedTurns.delete(env.data.turn));
        }
        return;
      } else {
        const topic = env.type;
        const payload = env.data as JsonValue;
        if (!isJsonObject(payload)) return;
        if (topic === Events.PlatformReaction.type) {
          const msg = isJsonObject(payload.message) ? payload.message : null;
          const account = isJsonObject(payload.account) ? payload.account : null;
          if (!msg || !account || typeof msg.id !== "string") return;
          if (typeof account.platform !== "string" || typeof account.id !== "string") return;
          if (selfIds.has(account.id)) return;
          const ref = { platform: account.platform, id: account.id };
          feedback.reaction(
            msg.id,
            who(ref, typeof payload.display_name === "string" ? payload.display_name : null),
            typeof payload.emoji === "string" ? payload.emoji : "",
            payload.added !== false,
          );
        } else if (topic === "gate.decision") {
          const p = isJsonObject(payload.principal) ? payload.principal : null;
          if (payload.allowed !== false || p?.kind !== "self") return;
          const context = parseCtx(p.context);
          feedback.denied(context, String(payload.capability ?? ""), String(payload.reason ?? ""));
        } else if (topic === FEEDBACK_TOPIC) {
          const account = isJsonObject(payload.account) ? payload.account : null;
          const context = parseCtx(payload.context);
          if (!account || typeof account.id !== "string" || typeof account.platform !== "string") {
            return;
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
        } else if (topic === Events.ConversationFolded.type) {
          const context = parseCtx(payload.context);
          if (context && typeof payload.session_lines === "number") {
            reflector.folded(context, payload.session_lines);
          }
        }
        return;
      }
    };
    ctx.spawn("signals", async () => {
      for await (const env of sub) {
        try {
          signal(env);
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
      conversations: () => s.get(ConversationStatesKey)?.list() ?? [],
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
        if (due === null) {
          // After the daily reflection, one call per person (under the same nightly figure).
          if (reflector.peopleDue(clock.now(), budgetOf(s))) {
            await reflectOnPeople(ctx, reflector, signal);
          } else if (tidy.due(clock.now(), reflector.nightOver(clock.now(), budgetOf(s)))) {
            // Then the tidy of her notes, within one scope at a time (same nightly figure).
            await tidy.run(
              s,
              s.get(StoreKey)?.plugin(notesTables) ?? null,
              s.get(LlmRouterKey),
              signal,
            );
          }
          continue;
        }
        const { run, skipped } = await reflectUnder(
          due.kind === "daily" ? ctx.services.get(ReflectGuardKey) : undefined,
          (within) =>
            reflector.reflect(due.kind, due.kind === "light" ? due.context : null, within),
          signal,
        );
        if (skipped !== null) ctx.log.info({ why: skipped }, "the nightly reflection did not run");
        if (run) {
          ctx.publish(Events.ReflectRun, JSON.parse(JSON.stringify(run)) as ReflectionRun);
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
