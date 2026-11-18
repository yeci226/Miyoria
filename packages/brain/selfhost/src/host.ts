// The text conversations on the phase-3 turn runner: the
// agent hands every line of a channel, thread or DM here instead of to its coordinators.
//
// Intake. Each line goes into the transcript of its place as it comes (`entryOfIncoming`): her
// own lines' echoes are skipped (the runner wrote them), a flagged line carries the input
// defence's note, a reply whose parent is not in the transcript gets the quote the platform sent
// along (`attachParent`), and the first line of a place that has no transcript yet comes after the
// earlier lines of the platform and of the message log (the backfill). The agent already dropped
// blocked people and lines the defence ignores. "要她回這則" from a message's menu (`replyTo`) is
// a line that calls her.
//
// When she runs. `triage` decides per line: said to her (mention, name, reply, DM) wakes her,
// after the waits of the place's lane (`lane.ts`); anything else may earn a glance, under the
// place's level (`GLANCES_PER_HOUR`), a cap for the day and the panel's switch that pauses her
// own initiative (the actions gate's `paused`). A long tool she started that comes back (`<owner>
// .task.done|failed`, `activity.done|failed` of the job the call reported) wakes her as `result`.
// What wakes her on her own (a due schedule, a salient world event, her inbox, someone she
// misses, her morning) is her initiative's (`initiative.ts`): an inbox, code gates, then a wake.
// What another module asks her to say (a game's narration, a song's announcement, a notice) comes
// through the Arbiter, whose host this is (`ImpulseHostKey`, `impulses.ts`).
//
// A run. One `SelfRunner` for the process, the text profile, the blocks of `HostPrompt` with the
// files and images of its lines (`LookAround`), the service guard over the real services
// (directives, permissions, budget, Floor, moderation, quiet hours), the mouth as the outlet
// (`MouthOutlet`), `say` to the places she knows (never a DM: that is `message_dm`'s). A run
// holds the Floor from its start to its end, as the old turn did; a glance the Floor refuses is
// not run. Her first line answering one person quotes their line (`#replyTarget`); a line the
// scheduler failed late is marked as not heard. What a run did is published as today's turn
// records.

import {
  type ContentPart,
  currentLlmTag,
  type LlmRouter,
  LlmRouterKey,
  withLlmTag,
} from "@miyoria/llm/llm";
import {
  type EntryInput,
  entryOfIncoming,
  type TranscriptStore,
  transcriptTables,
} from "@miyoria/memory/transcript";
import { errorMessage, type Subscription, sleep } from "@miyoria/runtime/kernel";
import { MessageLogKey, StoreKey } from "@miyoria/store";
import {
  type AccountRef,
  ActionSinkKey,
  type ContextKey,
  contextKeyEquals,
  contextKeyString,
  type Envelope,
  Events,
  holdsBack,
  ImpulseHostKey,
  type IncomingMessage,
  is,
  type MessageRef,
  newId,
  PlatformHistoriesKey,
  PlatformSinksKey,
  parseTaskEvent,
  parseTaskTopic,
  SegmentFlushKey,
  sameAccount,
  type TurnOutcome,
  type TurnReason,
  timestampMs,
  toTimestamp,
} from "@miyoria/types";
import {
  type Agent,
  agentTurns,
  asideOf,
  backfillLimit,
  type CallKind,
  type CorrectionsConfig,
  CorrectionTally,
  callKind,
  callsHer,
  directReason,
  maxDebounceMs,
  type TextLineMarks,
  type TextReplyOutcome,
  type TextRunner,
  type TextRunnerFactory,
  TimeoutError,
  timeout,
  typingRefreshMs,
} from "../../agent/src/index.js";
import type { LocalTime } from "../../arbiter/src/index.js";
import {
  addressedReason,
  composeGuards,
  DEFAULT_COMPACTION,
  floorKind,
  noteGlance,
  type OutgoingLine,
  type OutputChecks,
  PROFILES,
  type RunEvent,
  type RunModel,
  type RunnerOptions,
  type RunResult,
  SelfRunner,
  sayTool,
  serviceGuard,
  type TriageDecision,
  type TriageEvent,
  type TriageState,
  triage,
  type Wake,
  type WakeAuthor,
  wakeAuthor,
  withLimits,
} from "../../self/src/index.js";
import { LookAround } from "./around.js";
import { answeredLine, applyFeel, feelApplies, feelDeps } from "./feel.js";
import { startIdleCompaction } from "./idle-compaction.js";
import { ImpulseDesk } from "./impulses.js";
import { type Initiative, type InitiativeOptions, startInitiative } from "./initiative.js";
import { JobsHost, type JobsHostOptions } from "./jobs.js";
import { type AdmittedInput, Lane, type LaneHost, type LaneRun } from "./lane.js";
import { MouthOutlet, Settlements, submitTyping } from "./outlet.js";
import { ReplyContext } from "./parent.js";
import { resolvePlace } from "./places.js";
import { HostPrompt } from "./prompt.js";
import { knownPeople, outletClaims } from "./repeat.js";
import { PromptKeeper } from "./saved.js";
import { askedLine, SAY_DM } from "./texts.js";
import { VoiceHost } from "./voice.js";

/** Lines of a place before the first one the backfill fetches at most. */
const MAX_BACKFILL = 50;
/** The id prefix of a line the backfill took from the message log (the old `earlier`'s). */
const LOGGED = "log:";
/** Jobs remembered while they run. */
const MAX_JOBS = 256;
/** Lines triage holds that move nothing in their place: no restart, no longer wait. */
const INERT: ReadonlySet<string> = new Set(["own", "bot", "flagged", "muted"]);

export interface SelfHostOptions {
  /** The Arbiter's clock (`[modules.arbiter]`), for the quiet hours; `null`: none. */
  quiet?: LocalTime | null;
  /** Glances a day over all places. Default `[modules.agent.initiative] glances_per_day`. */
  glancesPerDay?: number;
  /** The runner's own options (tests). */
  runner?: RunnerOptions;
  /** The transcripts; default: the store's (`StoreKey`, `transcriptTables`). */
  transcript?: TranscriptStore;
  /** The sub-agent jobs (tests); the config is `[modules.agent.delegate]`. */
  delegate?: JobsHostOptions;
  /** Her own initiative: its numbers, `remind_me`'s time parser, its tables. */
  initiative?: InitiativeOptions;
}

/** `[modules.agent.corrections]` as the runner's output checks. */
function checksOf(c: CorrectionsConfig): OutputChecks {
  return {
    leakScreen: c.leak_screen,
    leakScreenSpoken: c.leak_screen_spoken,
    thinkingBlock: c.thinking_block,
    fallbackLine: c.fallback_line,
    tagStrip: c.tag_strip,
    selfTalk: c.self_talk,
  };
}

/** The factory Core installs on the agent module (`AgentModule.withTextRunner`). */
export function selfHost(options: SelfHostOptions = {}): TextRunnerFactory {
  return (agent) => new SelfHost(agent, options);
}

/** A place on the runner. */
interface Place {
  context: ContextKey;
  session: string;
  lane: Lane;
  /** Intake of its lines, one after another (the backfill comes first). */
  intake: Promise<void>;
}

/** What a run keeps while it goes. */
interface TurnState {
  place: Place;
  run: LaneRun;
  /** Her lines of the run that reached the place. */
  lines: number;
  firstLineAt: number | null;
  /** A line of the run carried the platform's reply reference already. */
  quoted: boolean;
  tally: CorrectionTally;
  /** The files and images of its lines, once asked for (`LookAround`). */
  attached: Promise<ContentPart[]> | null;
  /** Stops the typing notices of the run; `null` before it started, or for a run that needs none. */
  typing: AbortController | null;
  /** Her first visible text of the run streamed. */
  spoke: boolean;
}

/** Something she started that has not come back. */
interface Job {
  context: ContextKey;
  tool: string;
  from: WakeAuthor | null;
}

export class SelfHost implements TextRunner {
  readonly #agent: Agent;
  readonly #o: SelfHostOptions;
  readonly transcript: TranscriptStore;
  readonly runner: SelfRunner;
  readonly prompt: HostPrompt;
  /** The voice conversations (`TextRunner.voice`). */
  readonly voice: VoiceHost;
  /** The sub-agents; `null`: `[modules.agent.delegate] enabled = false`. */
  readonly jobs: JobsHost | null;
  /** Her inbox, her schedules and what wakes her on her own (`initiative.ts`). */
  readonly initiative: Initiative;
  /** What the Arbiter admits, run here (`ImpulseHostKey`). */
  readonly impulses: ImpulseDesk;
  readonly #stopInitiative: () => void;
  readonly #settlements = new Settlements();
  readonly #outlet: MouthOutlet;
  readonly #around: LookAround;
  /** The prompts of recent runs, for the panel (`SavedPromptsKey`). */
  readonly #saved: PromptKeeper;
  readonly #replied: ReplyContext;
  readonly #places = new Map<string, Place>();
  readonly #turns = new Map<string, TurnState>();
  readonly #jobs = new Map<string, Job>();
  /** Lines someone asked her to answer from their menu, until a run takes them. */
  readonly #asked = new Set<string>();
  /** The platform's names of places, by `contextKeyString`. */
  readonly #names = new Map<string, string>();
  /** When she glanced at each place (`contextKeyString`). */
  #glances = new Map<string, readonly number[]>();
  #day = { key: "", count: 0 };
  readonly #stop = new AbortController();
  #subscription: Subscription | null = null;

  constructor(agent: Agent, options: SelfHostOptions = {}) {
    this.#agent = agent;
    this.#o = options;
    const transcript =
      options.transcript ?? agent.ctx.services.get(StoreKey)?.plugin(transcriptTables) ?? null;
    if (transcript === null) throw new Error("the text runner needs the store's transcripts");
    this.transcript = transcript;
    this.#around = new LookAround(agent, transcript);
    this.#saved = new PromptKeeper(agent);
    this.#replied = new ReplyContext(agent, transcript, this.#around.recent);
    const sessionOf = (context: ContextKey) => this.#sessionFor(context);
    this.prompt = new HostPrompt(agent, {
      transcript,
      sessionOf,
      attachments: (input) => this.#attachments(input.turn),
      inbox: (input) => this.initiative.inboxBlock(input),
      startsToday: (now) => this.initiative.gates.startsToday(now),
      slowReads: (input) => this.voice.slowReads(input),
      replyContext: (input) => this.#replyContext(input.turn),
      present: (input) => this.voice.roster(input.session.context),
    });
    this.voice = new VoiceHost(agent, {
      transcript,
      prompt: this.prompt,
      saved: this.#saved,
      runner: () => this.runner,
      sessionOf,
      triage: (context, line) =>
        triage(
          { kind: "line", place: contextKeyString(context), at: this.#now, own: false, ...line },
          this.#triageState(context),
          this.#now,
        ),
      takeGlance: (context) => this.#takeGlance(context),
      initiative: {
        line: (context, answered) => this.initiative.line(context, answered),
        started: (wake, turn, context) => this.initiative.runStarted(wake, turn, context),
        ended: (wake, turn, context, outcome, spoke) =>
          this.initiative.runEnded(wake, turn, context, outcome, spoke),
      },
    });
    this.#outlet = new MouthOutlet(
      agent,
      this.#settlements,
      (line, id) => this.#saidElsewhere(line.place, line.text, line.turn, id),
      (line) => this.#replyTarget(line),
      outletClaims(agent, {
        wakeOf: (turn) => this.#turns.get(turn)?.run.wake ?? null,
        entries: (place) => this.transcript.tail(this.#sessionFor(place)).entries,
        named: (turn) => this.prompt.named(turn),
        members: (place) => this.voice.roster(place),
      }),
    );
    const services = agent.ctx.services;
    const router = (): LlmRouter => {
      const r = services.get(LlmRouterKey);
      if (!r) throw new Error("the llm module is not running");
      return r;
    };
    const model: RunModel = {
      stream: (purpose, request, signal) =>
        this.voice.stream(request, signal, () => router().stream(purpose, request, signal)),
      complete: (purpose, request, signal) => router().complete(purpose, request, signal),
      prices: () => services.get(LlmRouterKey)?.prices() ?? {},
    };
    // The runner's calls only: a sub-agent's are not the prompt of a run.
    const runModel: RunModel = {
      ...model,
      stream: (purpose, request, signal) => {
        this.#saved.sent(currentLlmTag()?.turn, request);
        return model.stream(purpose, request, signal);
      },
    };
    this.runner = new SelfRunner(
      {
        transcript,
        tools: agent.tools,
        model: runModel,
        prompt: this.voice.prompt(this.prompt),
        guard: composeGuards(
          this.voice.guard,
          serviceGuard({ services, quiet: options.quiet ?? null }),
        ),
        outlet: this.voice.outlet(this.#outlet),
        clock: agent.ctx.clock,
        log: agent.log,
        onEvent: (event) => {
          this.#onRunEvent(event);
          this.voice.onRunEvent(event);
          this.#saved.event(event);
        },
        selfAccount: (platform) => agent.selfAccount(platform),
        // Her memory reads the lines before they are summarised (the segment pass).
        beforeCompaction: async (session, upto) =>
          services.get(SegmentFlushKey)?.beforeCompaction(session, upto),
      },
      {
        ...options.runner,
        checks: { ...checksOf(agent.config.corrections), ...options.runner?.checks },
      },
    );
    agent.tools.register(
      sayTool({
        resolve: (name, from) =>
          resolvePlace(
            {
              transcript,
              live: () => [...this.#places.values()].map((p) => p.context),
              sessionOf,
              describe: (context) => this.#describe(context),
            },
            name,
            from,
          ),
        // A DM goes through `message_dm` only: one path for consent, permission and its limits.
        refuses: (place) => (place.kind === "dm" ? SAY_DM : null),
        sayIn: this.runner.sayIn,
      }),
    );
    // Places she only hears are never compacted by a run.
    startIdleCompaction(agent, {
      transcript,
      model,
      budget:
        options.runner?.compaction === undefined ? DEFAULT_COMPACTION : options.runner.compaction,
      signal: this.#stop.signal,
    });
    this.jobs = agent.config.delegate.enabled
      ? new JobsHost(
          agent,
          {
            transcript,
            model,
            quiet: options.quiet ?? null,
            wake: (context, wake) => {
              this.#wake(context, wake);
            },
          },
          options.delegate ?? {},
        )
      : null;
    const started = startInitiative(
      agent,
      {
        transcript,
        quiet: options.quiet ?? null,
        sessionOf,
        wake: (context, wake) => this.#wake(context, wake),
        places: () => [...this.#places.values()].map((p) => p.context),
        inVoice: (context) => this.voice.in(context),
        resolve: async (name, from) =>
          resolvePlace(
            {
              transcript,
              live: () => [...this.#places.values()].map((p) => p.context),
              sessionOf,
              describe: (context) => this.#describe(context),
            },
            name,
            from,
          ),
        describe: (context) => this.#describe(context),
        signal: this.#stop.signal,
      },
      options.initiative ?? {},
    );
    this.initiative = started.initiative;
    this.#stopInitiative = started.stop;
    this.impulses = new ImpulseDesk({
      agent,
      admit: (context: ContextKey, input: AdmittedInput) => this.#admit(context, input),
    });
    agent.ctx.provide(ImpulseHostKey, this.impulses);
    // Every topic: task events come from any owner (`<owner>.task.done`).
    const sub = agent.ctx.subscribe("*");
    this.#subscription = sub;
    agent.ctx.spawn("selfhost.events", async () => {
      for await (const env of sub) {
        try {
          this.#event(env);
        } catch (error) {
          agent.log.warn({ err: errorMessage(error) }, "the text runner could not handle an event");
        }
      }
    });
  }

  get #now(): number {
    return this.#agent.ctx.clock.now();
  }

  // ---- TextRunner ------------------------------------------------------------------------------

  line(msg: IncomingMessage, marks: TextLineMarks): void {
    // Her own line: the runner wrote it when she said it.
    if (marks.own) return;
    const place = this.#place(msg.id.context);
    place.intake = place.intake
      .then(() => this.#take(place, msg, marks))
      .catch((error: unknown) =>
        this.#agent.log.warn({ err: errorMessage(error) }, "the text runner could not take a line"),
      );
  }

  typing(context: ContextKey): void {
    const place = this.#places.get(contextKeyString(context));
    if (place === undefined) return;
    // After the lines before it: a wait their line opens is the one it pushes out.
    place.intake = place.intake.then(() => {
      place.lane.push({ type: "typing" });
    });
  }

  halt(): void {
    for (const place of this.#places.values()) place.lane.push({ type: "halt" });
    this.voice.halt();
  }

  stop(): void {
    this.#stop.abort();
    this.#subscription?.close();
    for (const place of this.#places.values()) place.lane.close();
    this.#places.clear();
    this.voice.stop();
    this.jobs?.stop();
    this.#stopInitiative();
    this.#agent.tools.unregister("say");
  }

  /** Whether a run started `task` and will be woken by its end (a notice of it tells nothing new). */
  follows(task: string | null): boolean {
    return task !== null && (this.#jobs.has(task) || this.voice.follows(task));
  }

  /** The session of `context` on the runner. */
  sessionOf(context: ContextKey): string {
    return this.#sessionFor(context);
  }

  #sessionFor(context: ContextKey): string {
    const key = contextKeyString(context);
    return this.#places.get(key)?.session ?? this.transcript.sessionFor(context) ?? key;
  }

  /** The platform's name of a place (`server / channel`), asked once and kept. */
  async #describe(context: ContextKey): Promise<string | null> {
    const key = contextKeyString(context);
    const known = this.#names.get(key);
    if (known !== undefined) return known;
    const agent = this.#agent;
    const sink = agent.ctx.services.get(PlatformSinksKey)?.get(context.platform);
    const describe = sink?.describe?.bind(sink);
    if (describe === undefined) return null;
    try {
      const name = await timeout(agent.config.history.timeout_ms, agent.ctx.signal, (signal) =>
        describe(context, signal),
      );
      if (name !== null) this.#names.set(key, name);
      return name;
    } catch (error) {
      agent.log.debug({ err: errorMessage(error) }, "no name for a place");
      return null;
    }
  }

  /** Waits until every line handed over so far is in its transcript (tests). */
  async settled(): Promise<void> {
    await Promise.all([...this.#places.values()].map((p) => p.intake));
  }

  // ---- places ----------------------------------------------------------------------------------

  /**
   * A wake of her own goes to the voice conversation of `context` when she is in one; a voice
   * channel she is not in takes none.
   */
  #wake(context: ContextKey, wake: Wake): boolean {
    if (this.voice.wake(context, wake)) return true;
    if (context.kind === "voice") return false;
    return this.#place(context).lane.push({ type: "wake", wake });
  }

  /** What the Arbiter admitted goes to the lane of `context`, the voice one when she is there. */
  #admit(context: ContextKey, input: AdmittedInput): boolean {
    if (this.voice.admit(context, input)) return true;
    if (context.kind === "voice") return false;
    return this.#place(context).lane.push(input);
  }

  #place(context: ContextKey): Place {
    const key = contextKeyString(context);
    const known = this.#places.get(key);
    if (known !== undefined && !known.lane.ended) return known;
    const session = this.#sessionFor(context);
    const lane = new Lane(this.#laneHost(context));
    const place: Place = { context, session, lane, intake: known?.intake ?? Promise.resolve() };
    this.#places.set(key, place);
    this.#agent.ctx.spawn("selfhost.lane", (signal) => {
      const both = AbortSignal.any([signal, this.#stop.signal]);
      return lane.run(both);
    });
    return place;
  }

  #laneHost(context: ContextKey): LaneHost {
    const agent = this.#agent;
    const cfg = agent.config;
    return {
      context,
      now: () => this.#now,
      debounceMs: () => cfg.debounce_ms,
      maxDebounceMs: () => maxDebounceMs(cfg),
      typingExtendMs: () => cfg.typing_extend_ms,
      oneCallerPerTurn: () => cfg.one_caller_per_turn,
      idleMs: () => cfg.session_idle_ms,
      newTurn: () => newId(),
      addressedWake: (inputs) => this.#addressedWake(inputs),
      glanceWake: () => this.#glanceWake(context),
      execute: (run) => this.#execute(context, run),
      delivered: (turn) => this.#turns.get(turn)?.lines ?? 0,
      cancelQueued: async (turn) => {
        await agent.ctx.services.get(ActionSinkKey)?.cancelTurn(turn);
        agent.mainline.lines.cancelUnstarted(turn, "the run was cut");
      },
      handleOf: (author) => agent.handleOf(author.account, author.display_name),
      warn: (what, error) => agent.log.warn({ err: errorMessage(error) }, what),
    };
  }

  // ---- intake ----------------------------------------------------------------------------------

  /** How `msg` relates to her (the coordinator's `#callKind` without the voice facts). */
  #call(msg: IncomingMessage): CallKind {
    const names = this.#agent.persona.names();
    return callKind(msg, directReason(msg, names), null, asideOf(msg, names, [], false));
  }

  async #take(place: Place, msg: IncomingMessage, marks: TextLineMarks): Promise<void> {
    const agent = this.#agent;
    const { session, context } = place;
    // Not the whole tail: only whether the place has a transcript at all.
    if (!this.transcript.started(session)) {
      await this.#backfill(place, msg);
    }
    const entry = entryOfIncoming(msg, {
      person_id: agent.attitude(msg.author.account)?.person ?? null,
    });
    const note = marks.verdict?.note ?? null;
    if (note) entry.flagged = note;
    this.transcript.append(session, [entry], { context });
    this.#around.recent.add(msg);
    this.#attachParent(place, msg);
    const call = this.#call(msg);
    const said = callsHer(call);
    const decision = triage(
      {
        kind: "line",
        place: contextKeyString(context),
        at: this.#now,
        addressed: said
          ? (addressedReason(directReason(msg, agent.persona.names())) ?? "mention")
          : null,
        own: false,
        bot: marks.bot,
        flagged: holdsBack(marks.verdict),
        muted: marks.muted || agent.handle.channelMode(context) === "off",
      },
      this.#triageState(context),
      this.#now,
    );
    agent.log.debug(
      { context: contextKeyString(context), message: msg.id.id, triage: describe(decision) },
      "text line triaged",
    );
    // A person spoke there: her waiting starts there may count as answered.
    if (!marks.bot) this.initiative.line(context, said);
    // The place's lane now: an idle one may have ended while the line was taken in.
    this.#place(context).lane.push({
      type: "line",
      msg,
      call: decision.decision === "wake" ? call : null,
      glance: decision.decision === "glance",
      inert: decision.decision === "hold" && INERT.has(decision.why),
    });
  }

  /** The quote the platform sent with a reply, when its parent is not in the transcript. */
  #attachParent(place: Place, msg: IncomingMessage): void {
    const ref = msg.reply_to ?? null;
    const quoted = msg.referenced ?? null;
    if (ref === null || quoted === null) return;
    const entries = this.transcript.tail(place.session).entries;
    if (entries.some((e) => e.message_id === ref.id && e.kind !== "note")) return;
    this.transcript.attachParent(place.session, msg.id.id, {
      author: quoted.author_name,
      text: quoted.text,
      message_id: ref.id,
      person_id: quoted.author ? (this.#agent.attitude(quoted.author)?.person ?? null) : null,
    });
  }

  /**
   * The lines before `first`, for a place she has no transcript of (the old `startBackfill`, up
   * to `backfillLimit`, within `history.timeout_ms`): the platform's history, and the message log
   * for what it does not give (no history, a failed fetch, or fewer lines than the limit), older
   * than what the platform gave.
   */
  async #backfill(place: Place, first: IncomingMessage): Promise<void> {
    const agent = this.#agent;
    const limit = Math.min(backfillLimit(agent), MAX_BACKFILL);
    if (limit <= 0) return;
    const signal = agent.ctx.signal;
    let read: [IncomingMessage, boolean][] = [];
    try {
      read = await timeout(agent.config.history.timeout_ms, signal, (s) =>
        this.#earlier(place.context, first, limit, s),
      );
    } catch (error) {
      if (!(error instanceof TimeoutError)) {
        agent.log.debug({ err: errorMessage(error) }, "no backfill for a new place");
      }
    }
    const entries: EntryInput[] = [];
    for (const [m, own] of read) {
      if (m.id.id === first.id.id || agent.isBlocked(m.author.account)) continue;
      // A line of the message log has an id of its own, never a platform message's.
      const logged = m.id.id.startsWith(LOGGED);
      if (own) {
        if (m.text.trim() === "") continue;
        entries.push({
          kind: "self",
          content: m.text,
          message_id: logged ? null : m.id.id,
          at: m.ts,
        });
      } else {
        entries.push({ ...entryOfIncoming(m), ...(logged ? { message_id: null } : {}) });
        if (!logged) this.#around.recent.add(m);
      }
    }
    entries.sort((a, b) => timestampMs(a.at ?? first.ts) - timestampMs(b.at ?? first.ts));
    if (entries.length > 0) {
      this.transcript.append(place.session, entries, { context: place.context });
    }
  }

  /** Earlier lines of `context`, each with whether it is hers: the platform's, then the log's. */
  async #earlier(
    context: ContextKey,
    first: IncomingMessage,
    limit: number,
    signal: AbortSignal,
  ): Promise<[IncomingMessage, boolean][]> {
    const agent = this.#agent;
    const services = agent.ctx.services;
    const history = services.get(PlatformHistoriesKey)?.get(context.platform);
    let fetched: IncomingMessage[] = [];
    if (history) {
      try {
        fetched = await history.recent(context, { before: first.id.id, limit }, signal);
      } catch (error) {
        signal.throwIfAborted();
        agent.log.debug({ err: errorMessage(error) }, "no platform history for a new place");
      }
    }
    const out: [IncomingMessage, boolean][] = fetched.map((m) => [
      m,
      agent.isSelf(m.author.account),
    ]);
    const missing = limit - fetched.length;
    const log = services.get(MessageLogKey);
    if (missing <= 0 || !log) return out;
    const profile = agent.persona.read((p) => p.id);
    const oldest = Math.min(timestampMs(first.ts), ...fetched.map((m) => timestampMs(m.ts)));
    // One more than needed: the log may already hold `first` itself.
    const logged = await log.recent(profile, context, limit + 1);
    signal.throwIfAborted();
    const older = logged.filter((e) => Date.parse(e.ts) < oldest).slice(-missing);
    return [
      ...older.map((e): [IncomingMessage, boolean] => [
        {
          id: { context, id: `${LOGGED}${e.id}` },
          author: { account: e.author, display_name: e.author_name, is_bot: false },
          text: e.text,
          mentions_self: false,
          reply_to_self: false,
          attachments: [],
          ts: e.ts,
        },
        e.is_self,
      ]),
      ...out,
    ];
  }

  // ---- triage ----------------------------------------------------------------------------------

  #today(): number {
    const key = new Date(this.#now - (this.#o.quiet?.day_start_hour ?? 4) * 3_600_000)
      .toISOString()
      .slice(0, 10);
    if (this.#day.key !== key) this.#day = { key, count: 0 };
    return this.#day.count;
  }

  #triageState(context: ContextKey): TriageState {
    return {
      config: {
        // The panel's switch for what she starts herself, the same as for her other starts.
        glances: !this.initiative.paused(),
        perDay: this.#o.glancesPerDay ?? this.initiative.glancesPerDay,
      },
      level: () => this.#agent.handle.channelMode(context),
      glances: this.#glances,
      today: this.#today(),
    };
  }

  #addressedWake(inputs: readonly IncomingMessage[]): Wake | null {
    const names = this.#agent.persona.names();
    const calling = inputs.filter((m) => callsHer(this.#call(m)));
    // A line someone asked her to answer from its menu leads, worded as such.
    const asked = calling.find((m) => this.#asked.has(m.id.id));
    if (asked !== undefined) this.#asked.delete(asked.id.id);
    const first = asked ?? calling[0];
    if (first === undefined) return null;
    const reason =
      addressedReason(directReason(first, names)) ?? (first.reply_to_self ? "reply" : "mention");
    const callers: { from: WakeAuthor; message: MessageRef }[] = [];
    for (const m of [first, ...calling]) {
      const from = { account: m.author.account, name: m.author.display_name };
      const known = callers.find((c) => sameAccount(c.from.account, from.account));
      if (known === undefined) callers.push({ from, message: m.id });
      else if (m !== first) known.message = m.id;
    }
    return {
      kind: "addressed",
      reason,
      from: { account: first.author.account, name: first.author.display_name },
      message: first.id,
      ...(asked === undefined ? {} : { line: askedLine(asked.author.display_name, asked.text) }),
      ...(callers.length > 1 ? { callers } : {}),
    };
  }

  /** "要她回這則" (`TextRunner.replyTo`): a run on that line, as if it had called her. */
  replyTo(ref: MessageRef): TextReplyOutcome {
    const agent = this.#agent;
    const context = ref.context;
    const entries = this.transcript.tail(this.#sessionFor(context)).entries;
    const entry = entries.findLast(
      (e) => e.message_id === ref.id && (e.kind === "other" || e.kind === "self"),
    );
    if (entry === undefined || entry.redacted_at !== null) return "unseen";
    if (entry.kind === "self") return "own";
    if (entry.account !== null && agent.isBlocked(entry.account)) return "blocked";
    if (agent.handle.channelMode(context) === "off") return "off";
    const seen = this.#around.recent.get(context, ref.id);
    const msg: IncomingMessage = {
      ...(seen ?? {
        id: ref,
        author: {
          account: entry.account ?? { platform: context.platform, id: "unknown" },
          display_name: entry.author ?? "",
          is_bot: entry.bot,
        },
        text: entry.content,
        reply_to_self: false,
        attachments: [],
        ts: entry.at,
        reply_to: entry.reply_to === null ? null : { context, id: entry.reply_to },
      }),
      mentions_self: true,
    };
    agent.log.debug({ context: contextKeyString(context), message: ref.id }, "asked to answer");
    this.#asked.add(ref.id);
    const pushed = this.#place(context).lane.push({
      type: "line",
      msg,
      call: "address",
      glance: false,
      inert: false,
    });
    if (!pushed) this.#asked.delete(ref.id);
    return pushed ? "ok" : "failed";
  }

  /** A glance at `context` if it is still due (another place may have taken the day's last). */
  #glanceWake(context: ContextKey): Wake | null {
    const place = contextKeyString(context);
    const now = this.#now;
    const event: TriageEvent = {
      kind: "line",
      place,
      at: now,
      addressed: null,
      own: false,
      bot: false,
      flagged: false,
      muted: this.#agent.muted,
    };
    const state = this.#triageState(context);
    if (triage(event, state, now).decision !== "glance") return null;
    const next = noteGlance(state, place, now);
    this.#glances = new Map(next.glances);
    this.#day.count = next.today;
    const entries = this.transcript.tail(this.#place(context).session).entries;
    let lines = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e === undefined || e.kind === "self" || e.kind === "tool_calls") break;
      if (e.kind === "other") lines += 1;
    }
    return lines === 0 ? null : { kind: "glance", lines };
  }

  /** Whether a glance at the voice channel `context` is still due; counted when it is. */
  #takeGlance(context: ContextKey): boolean {
    const place = contextKeyString(context);
    const now = this.#now;
    const state = this.#triageState(context);
    const event: TriageEvent = {
      kind: "line",
      place,
      at: now,
      addressed: null,
      own: false,
      bot: false,
      flagged: false,
      muted: this.#agent.muted,
    };
    if (triage(event, state, now).decision !== "glance") return false;
    const next = noteGlance(state, place, now);
    this.#glances = new Map(next.glances);
    this.#day.count = next.today;
    return true;
  }

  // ---- a run -----------------------------------------------------------------------------------

  async #execute(context: ContextKey, run: LaneRun): Promise<void> {
    const agent = this.#agent;
    const place = this.#place(context);
    const turn = run.turn;
    const state: TurnState = {
      place,
      run,
      lines: 0,
      firstLineAt: null,
      quoted: false,
      tally: new CorrectionTally(false),
      attached: null,
      typing: null,
      spoke: false,
    };
    agent.mainline.own(turn);
    agent.ctx.publish(Events.AgentTurnStarted, { turn, context }, { turn });
    // The Floor, once for the whole run (the old turn's `MainTurn.take`): a glance the Floor
    // refuses is no run at all; any other run holds the mic until it ends.
    const floor = agent.mainline.floor();
    const kind = floorKind(run.wake);
    const refused = kind === "ambient" ? (floor?.refuses("ambient", context) ?? null) : null;
    if (refused !== null) {
      agent.ctx.publish(
        Events.AgentDecision,
        {
          turn,
          context,
          respond: false,
          score: 0,
          reasons: [...decisionReasons(run.wake), `floor: ${refused}`],
        },
        { turn },
      );
      agentTurns.inc({ decision: "ignored" });
      this.#publish(state, null, null, { type: "silence" });
      this.initiative.runEnded(run.wake, turn, context, null, false);
      return;
    }
    floor?.hold(turn, context, kind);
    agent.mainline.holdsFloor(turn, true);
    this.#turns.set(turn, state);
    this.#saved.begin(turn, context);
    agent.ctx.publish(
      Events.AgentDecision,
      {
        turn,
        context,
        respond: true,
        score: 0,
        reasons: [
          ...decisionReasons(run.wake),
          ...this.initiative.runStarted(run.wake, turn, context),
        ],
      },
      { turn },
    );
    agentTurns.inc({ decision: "responded" });
    let result: RunResult | null = null;
    let error: string | null = null;
    try {
      result = await withLlmTag({ module: "agent", turn, label: "self" }, () =>
        this.runner.run({
          session: { id: place.session, context },
          wake: run.wake,
          profile: withLimits(PROFILES.text, { pictureBytes: agent.config.vision.max_total_bytes }),
          signal: run.controller.signal,
          turn,
        }),
      );
    } catch (e) {
      error = errorMessage(e);
      agent.log.warn({ turn, err: error }, "the runner failed");
    } finally {
      state.typing?.abort();
      this.#outlet.ended(turn);
      this.#saved.end(turn);
      this.prompt.ended(turn);
      this.#turns.delete(turn);
      // Freed once its lines settled (`Floor.turnEnded`), cancelled or not.
      agent.mainline.holdsFloor(turn, false);
      floor?.turnEnded(turn);
    }
    if (result?.compacted) this.prompt.forget(place.session);
    if (result !== null) this.#feel(context, place.session, run, result);
    this.#publish(state, result, error);
    const outcome = result?.outcome ?? (error === null ? null : "failed");
    this.initiative.runEnded(run.wake, turn, context, outcome, state.lines > 0);
  }

  /** Her `<feel>` blocks of a run that ended, to the emotion engine and the heart (`feel.ts`). */
  #feel(context: ContextKey, session: string, run: LaneRun, result: RunResult): void {
    if (result.feel.length === 0 || !feelApplies(run)) return;
    try {
      const entries = this.transcript.tail(session).entries;
      applyFeel(feelDeps(this.#agent), {
        turn: run.turn,
        context,
        wake: run.wake,
        feel: result.feel,
        people: [...knownPeople(entries, run.wake), ...this.voice.roster(context)],
        line: answeredLine(run.wake, run.inputs, entries),
      });
    } catch (error) {
      this.#agent.log.warn({ turn: run.turn, err: errorMessage(error) }, "feel not applied");
    }
  }

  /** The lines around a parent the run of `turn` replies to and cannot see (block 7). */
  #replyContext(turn: string): Promise<string | null> {
    const state = this.#turns.get(turn);
    if (state === undefined || state.run.wake.kind !== "addressed") return Promise.resolve(null);
    return this.#replied.block({
      session: state.place.session,
      turn,
      inputs: state.run.inputs,
      signal: state.run.controller.signal,
    });
  }

  /** The files and images of the lines of the run of `turn` (block 6), looked at once. */
  #attachments(turn: string): Promise<ContentPart[]> {
    const state = this.#turns.get(turn);
    if (state === undefined) return Promise.resolve([]);
    state.attached ??= this.#around.parts({
      session: state.place.session,
      context: state.place.context,
      turn,
      inputs: this.#linesOf(state),
      signal: state.run.controller.signal,
    });
    return state.attached;
  }

  /**
   * The lines a run is about: those that called her; for a glance, the other people's lines since
   * her last one. A result or a timer has none.
   */
  #linesOf(state: TurnState): IncomingMessage[] {
    const { run, place } = state;
    if (run.wake.kind === "addressed") return run.inputs;
    if (run.wake.kind !== "glance") return [];
    const entries = this.transcript.tail(place.session).entries;
    const out: IncomingMessage[] = [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e === undefined || e.kind === "self" || e.kind === "tool_calls") break;
      if (e.kind !== "other" || e.message_id === null) continue;
      const msg = this.#around.recent.get(place.context, e.message_id);
      if (msg !== undefined) out.unshift(msg);
    }
    return out;
  }

  async #keepTyping(context: ContextKey, turn: string, signal: AbortSignal): Promise<void> {
    const refresh = typingRefreshMs(this.#agent.config);
    while (!signal.aborted) {
      await submitTyping(this.#agent, context, turn);
      try {
        await sleep(refresh, signal);
      } catch {
        return;
      }
    }
  }

  /**
   * The platform reply reference of a line (`[modules.agent] reply_reference`), as the old turn
   * set it: the first line of a run that answers someone, in a channel or thread (not a DM), and
   * only when one person called her; with several, an unmarked reply quotes nobody.
   */
  #replyTarget(line: OutgoingLine): MessageRef | null {
    const state = this.#turns.get(line.turn);
    const agent = this.#agent;
    if (state === undefined || !line.focus || line.replyTo === null || state.quoted) return null;
    if (!agent.config.reply_reference || line.place.kind === "dm") return null;
    if (state.run.wake.kind !== "addressed") return null;
    const callers: AccountRef[] = [];
    for (const m of state.run.inputs) {
      if (!callsHer(this.#call(m))) continue;
      if (!callers.some((a) => sameAccount(a, m.author.account))) callers.push(m.author.account);
    }
    if (callers.length > 1) return null;
    state.quoted = true;
    return line.replyTo;
  }

  #onRunEvent(event: RunEvent): void {
    const state = this.#turns.get(event.turn);
    if (state === undefined) return;
    const agent = this.#agent;
    const context = state.place.context;
    switch (event.type) {
      case "line": {
        if (contextKeyEquals(event.place, context) && event.via !== "say") {
          state.lines += 1;
          state.firstLineAt ??= this.#now;
        }
        if (event.emotion !== null) {
          agent.ctx.publish(
            Events.AgentEmotion,
            { turn: event.turn, context: event.place, emotion: event.emotion.toLowerCase() },
            { turn: event.turn },
          );
        }
        break;
      }
      case "screened":
        if (event.kind === "feel_cut") {
          agent.log.debug({ turn: event.turn, lines: event.count }, "feel lines left out");
        } else if (event.kind !== "tag_stripped") state.tally.count(event.kind, event.count);
        break;
      case "speaking":
        // Her words began after the notices were stopped (she reacted first): show them again.
        state.spoke = true;
        this.#startTyping(state, context, event.turn);
        break;
      case "tool_start":
        agent.ctx.publish(
          Events.AgentToolRunning,
          { turn: event.turn, context, tool: event.name, state: "started" },
          { turn: event.turn },
        );
        break;
      case "tool_call":
        agent.ctx.publish(
          Events.AgentToolRunning,
          { turn: event.turn, context, tool: event.name, state: "ended" },
          { turn: event.turn },
        );
        // Discord has no "stop typing", a notice lingers about ten seconds. A reaction with no
        // word yet is most often all she does: stop the notices now; `speaking` starts them again.
        if (event.name === "react" && !state.spoke) state.typing?.abort();
        if (event.job !== null) {
          this.#jobs.set(event.job, {
            context,
            tool: event.name,
            from: wakeAuthor(state.run.wake),
          });
          while (this.#jobs.size > MAX_JOBS) {
            const oldest = this.#jobs.keys().next().value;
            if (oldest === undefined) break;
            this.#jobs.delete(oldest);
          }
        }
        break;
      case "refusal":
        agent.log.debug(
          { turn: event.turn, what: event.what, name: event.name, code: event.code },
          "the guard refused",
        );
        break;
      case "step":
        // The run ends with this step and nothing was said: no more notices.
        if (event.calls === 0 && event.text_chars === 0) state.typing?.abort();
        agent.log.debug(
          {
            turn: event.turn,
            round: event.round,
            model: event.model,
            finish: event.finish_reason,
            calls: event.calls,
            cost_usd: event.cost_usd,
          },
          "runner step",
        );
        break;
      case "started":
        // People see that she is answering while she thinks: the wait before her first word is
        // the long part (2026-11-18: notices only once she spoke came with or after the message).
        this.#startTyping(state, context, event.turn);
        break;
      case "finished":
        break;
    }
  }

  /** Starts the typing notices of a run that answers someone, unless they are going already. */
  #startTyping(state: TurnState, context: ContextKey, turn: string): void {
    const kind = state.run.wake.kind;
    if (kind !== "addressed" && kind !== "result") return;
    if (state.typing !== null && !state.typing.signal.aborted) return;
    state.typing = new AbortController();
    void this.#keepTyping(
      context,
      turn,
      AbortSignal.any([state.typing.signal, state.run.controller.signal]),
    );
  }

  /**
   * `agent.tool`, `agent.turn.completed` and `agent.turn.outcome` of a run; `decided`: the outcome
   * of a run that never started (the Floor refused it).
   */
  #publish(
    state: TurnState,
    result: RunResult | null,
    error: string | null,
    decided: TurnOutcome | null = null,
  ): void {
    const agent = this.#agent;
    const { run } = state;
    const turn = run.turn;
    const context = state.place.context;
    for (const call of result?.calls ?? []) {
      agent.ctx.publish(
        Events.AgentTool,
        { turn, context, tool: call.name, ok: call.ok, result: call.text },
        { turn },
      );
    }
    agent.ctx.publish(
      Events.AgentTurnCompleted,
      { turn, context, text: result?.lines.join("\n") ?? "" },
      { turn },
    );
    const outcome: TurnOutcome = decided ?? runOutcome(state, result, error);
    const wake = run.wake;
    const lastInput = run.inputs.at(-1);
    agent.publishOutcome({
      turn,
      context,
      reason: turnReason(wake),
      outcome,
      addressed_by:
        wake.kind === "addressed" ? [agent.handleOf(wake.from.account, wake.from.name)] : [],
      focus: run.inputs.map((m) => ({ ...m.id })),
      restarts: run.restarts,
      reasoning: null,
      latency_ms:
        state.firstLineAt === null || lastInput === undefined
          ? null
          : Math.max(0, state.firstLineAt - timestampMs(lastInput.ts)),
      at: toTimestamp(this.#now),
      ...(result !== null && result.rounds > 0 ? { corrections: state.tally.counts() } : {}),
    });
  }

  /** A `say` of hers went out in another place: that place's transcript has it too. */
  #saidElsewhere(context: ContextKey, text: string, turn: string, id: string | null): void {
    const place = this.#place(context);
    place.intake = place.intake.then(() => {
      this.transcript.append(
        place.session,
        [{ kind: "self", content: text, turn, message_id: id }],
        { context },
      );
    });
  }

  // ---- what comes back -------------------------------------------------------------------------

  #event(env: Envelope): void {
    this.voice.event(env);
    if (is(Events.ActionSettled, env)) {
      const taken = this.#settlements.settled(env.data);
      // Taken as said when the scheduler was slow, then it failed: nobody heard it.
      const turn = env.data.turn;
      if (!taken && !env.data.ok && turn !== null && env.data.type === "send_message") {
        const place = this.#places.get(contextKeyString(env.data.context));
        if (place !== undefined) this.transcript.heard(place.session, { turn }, "");
      }
      // A DM she sent through the main line with no run of the host behind it (`message_dm`): her
      // line belongs in that DM's transcript, where the person's answer will find it.
      const data = env.data;
      if (
        !taken &&
        data.ok &&
        data.type === "send_message" &&
        data.context.kind === "dm" &&
        (turn === null || !this.#turns.has(turn))
      ) {
        this.#saidElsewhere(data.context, data.text, turn ?? newId(), data.message?.id ?? null);
      }
      return;
    }
    if (is(Events.ActivityDone, env) || is(Events.ActivityFailed, env)) {
      const ok = env.type === Events.ActivityDone.type;
      this.#ended(env.data.task, ok, env.data.detail ?? "");
      return;
    }
    // A due timer and a salient world event: her inbox, then her initiative's gates.
    if (is(Events.MindReminder, env) || is(Events.WorldSalient, env)) {
      this.initiative.event(env);
      return;
    }
    if (is(Events.AgentMessageExcluded, env)) {
      this.transcript.redactMessage(env.data.message.id);
      return;
    }
    if (parseTaskTopic(env.type) !== null) {
      const event = parseTaskEvent(env.data);
      if (event === null || (event.type !== "done" && event.type !== "failed")) return;
      this.#ended(event.task, event.type === "done", event.detail);
    }
  }

  /** A job she started ended: the place it was started in hears it. */
  #ended(task: string, ok: boolean, detail: string): void {
    const job = this.#jobs.get(task);
    if (job === undefined) return;
    this.#jobs.delete(task);
    this.initiative.result(job.context, task, ok, detail);
    this.#place(job.context).lane.push({
      type: "wake",
      wake: { kind: "result", tool: job.tool, job: task, ok, text: detail, from: job.from },
    });
  }
}

/** How a run that started ended, as today's turn records say it. */
function runOutcome(state: TurnState, result: RunResult | null, error: string | null): TurnOutcome {
  if (result === null) return { type: "error", error: error ?? "the run failed" };
  if (result.outcome === "cancelled") {
    const cancel = state.run.cancel;
    return { type: "cancelled", cause: cancel?.cause ?? "shutdown", by: cancel?.by ?? null };
  }
  if (state.lines > 0 || result.outcome === "said") {
    return { type: "sent", parts: Math.max(state.lines, result.lines.length) };
  }
  if (result.outcome === "silent") return { type: "silence" };
  return { type: "error", error: result.outcome };
}

function describe(decision: TriageDecision): string {
  return decision.decision === "glance" ? "glance" : `${decision.decision}:${decision.why}`;
}

function decisionReasons(wake: Wake): string[] {
  const reasons = ["runner self"];
  switch (wake.kind) {
    case "addressed":
      reasons.push(`addressed: ${wake.reason}`);
      break;
    case "glance":
      reasons.push(`glance: ${wake.lines} line(s)`);
      break;
    case "result":
      reasons.push(`result: ${wake.tool}${wake.ok ? "" : " (failed)"}`);
      break;
    default:
      reasons.push(wake.kind);
  }
  return reasons;
}

function turnReason(wake: Wake): TurnReason {
  switch (wake.kind) {
    case "addressed":
      return wake.reason === "reply" ? "reply_to_her" : "addressed";
    case "glance":
      return "ambient";
    default:
      return "initiative";
  }
}
