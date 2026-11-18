// The voice conversations on the new runner: the agent hands
// over what is said in a voice channel (`VoiceRunner`), and each channel's runs go through the one
// `SelfRunner` on the voice profile (reasoning off, two rounds, the calls of `VOICE_TOOLS`).
//
// Intake. Every utterance goes into the channel's transcript as it comes, with the `(語音)` mark;
// a line typed in the channel's chat comes rerouted by the agent and goes in without it. Her own
// sentences go in only when they start playing; one she was cut off in keeps only what was heard
// (`TranscriptStore.heard`). The agent keeps its own session of the channel too (who is there,
// her own starts there), as before.
//
// When she runs. `VoiceLane` keeps the old coordinator's voice timing. Said to her (her name, a
// mention, a reply, a question right after she spoke, anything when only one other person is
// there) wakes her; anything else may earn a glance under the same caps as text (the host's
// triage, the voice level of the channel). A long tool she started that comes back wakes her
// there as `result`.
//
// A run. The text host's prompt with block 7 of its own (`VoicePrompt`), slow sources read warm;
// sentences said as they are written (`VoiceOutlet`); a run that started early has its model
// stream held at the first event until its wait is over (`stream`). It holds the Floor from its
// start to its end as a text run does; a glance the Floor refuses is not run. Its records are
// today's: the decision, the tools, `agent.turn.outcome` with `voice_stages`, the voice module's
// marks and filler (`VoiceTurns`), `voice.latency` for the first token and an early start.

import { type ChatRequest, type StreamEvent, withLlmTag } from "@miyoria/llm/llm";
import { entryOfIncoming, type TranscriptStore } from "@miyoria/memory/transcript";
import { errorMessage, metrics } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  ActionSinkKey,
  accountRefString,
  type ContextKey,
  contextKeyEquals,
  contextKeyString,
  type Envelope,
  type EventPayload,
  Events,
  type FloorClaimKind,
  holdsBack,
  type IncomingMessage,
  type InterruptLevel,
  is,
  type MessageRef,
  newId,
  parseTaskEvent,
  parseTaskTopic,
  sameAccount,
  type TurnOutcome,
  type TurnReason,
  timestampMs,
  toTimestamp,
  type VoiceParticipant,
  type VoiceTurnMark,
  type VoiceTurnMarks,
  type VoiceTurnStages,
  VoiceTurnsKey,
} from "@miyoria/types";
import {
  type Agent,
  agentTurns,
  asideOf,
  type CallKind,
  CorrectionTally,
  callKind,
  callsHer,
  directReason,
  speculations,
  speculationWaste,
  type TextLineMarks,
  type VoiceRunner,
} from "../../agent/src/index.js";
import {
  type AddressedReason,
  ALLOW,
  addressedReason,
  floorKind,
  type Guard,
  type ModelStream,
  type Outlet,
  PROFILES,
  type PromptInput,
  type PromptSource,
  type RunEvent,
  type RunResult,
  refuse,
  type SelfRunner,
  type TriageDecision,
  VOICE_TOOLS,
  type Wake,
  type WakeAuthor,
  wakeAuthor,
} from "../../self/src/index.js";
import { answeredLine, applyFeel, feelDeps } from "./feel.js";
import type { AdmittedInput } from "./lane.js";
import type { HostPrompt, SlowReads } from "./prompt.js";
import { knownPeople } from "./repeat.js";
import type { PromptKeeper } from "./saved.js";
import { VoiceLane, type VoiceLaneHost, type VoiceRun } from "./voice-lane.js";
import { PlaceOutlet, until, VoiceOutlet } from "./voice-outlet.js";
import { VoicePrompt, voiceReads, WarmValues } from "./voice-prompt.js";
import { notInVoice, VOICE_WAKE_LINES } from "./voice-texts.js";

/** Lines triage holds that move nothing in their place. */
const INERT: ReadonlySet<string> = new Set(["own", "bot", "flagged", "muted"]);
/** A speaking signal older than this is taken as lost (the old `SPEAKING_STALE_MS`). */
const SPEAKING_STALE_MS = 30_000;
/** A line this long after hers no longer answers it (attention's `FOLLOW_UP_SECS`). */
const FOLLOW_UP_MS = 180_000;
/** Runs whose speech is remembered until it played, at most. */
const MAX_SPEECH = 64;
/** Jobs remembered while they run. */
const MAX_JOBS = 256;

/** Voice runs whose tools ran a while with nothing of hers said first (no wait line any more). */
export const silentWaits = metrics.counter("miyoria_selfhost_voice_silent_waits_total", {
  help: "Rounds of tools in a voice run that ran at least SILENT_WAIT_MS before she said anything.",
});

/** What triage is told of a line (the host fills in the place and the time). */
export interface VoiceLineFacts {
  addressed: AddressedReason | null;
  bot: boolean;
  flagged: boolean;
  muted: boolean;
}

export interface VoiceHostDeps {
  transcript: TranscriptStore;
  /** The text host's prompt: its blocks, and what a run read is forgotten when it ends. */
  prompt: HostPrompt;
  /** The prompts of recent runs, for the panel: a run begins and ends here. */
  saved: PromptKeeper;
  runner: () => SelfRunner;
  /** The session a voice channel's transcript is under. */
  sessionOf(context: ContextKey): string;
  /** Triage of a line of `context` under the glance caps every place shares. */
  triage(context: ContextKey, line: VoiceLineFacts): TriageDecision;
  /** Whether a glance at `context` is still due; counted when it is. */
  takeGlance(context: ContextKey): boolean;
  /** Her initiative's side of a run (`Initiative.runStarted` / `runEnded`); unset: none. */
  initiative?: {
    /** A person spoke at `context` (`answered`: to her): the gates' view of who spoke lately. */
    line(context: ContextKey, answered: boolean): void;
    started(wake: Wake, turn: string, context: ContextKey): string[];
    ended(
      wake: Wake,
      turn: string,
      context: ContextKey,
      outcome: string | null,
      spoke: boolean,
    ): void;
  };
}

/** A voice channel on the runner. */
interface VoicePlace {
  context: ContextKey;
  session: string;
  lane: VoiceLane;
  /** Who is there, her not included. */
  members: VoiceParticipant[];
  /** Who is talking, by account, since when (clock ms). */
  speaking: Map<string, { name: string; since: number }>;
  /** When she was last heard there (clock ms). */
  lastSelfAt: number | null;
  warm: WarmValues;
  /** Intake of its lines, one after another. */
  intake: Promise<void>;
}

/** What a run keeps while it goes. */
interface VoiceTurn {
  place: VoicePlace;
  run: VoiceRun;
  marks: VoiceTurnMarks;
  /** Her sentences of the run handed to the voice sink. */
  lines: number;
  firstLineAt: number | null;
  /** She was cut off or gave way: nothing more is said. */
  stopped: boolean;
  /** The emotion of her last sentence, published once per change. */
  emotion: string | null;
  silentWaits: number;
  tally: CorrectionTally;
}

/** Her speech of a run, until it played: what the transcript gets and when. */
interface Speech {
  place: VoicePlace;
  queued: number;
  started: number;
  ended: number;
  /** The entry of each sentence that started, by its text. */
  seqs: Map<string, number>;
}

/** Something she started that has not come back. */
interface Job {
  context: ContextKey;
  tool: string;
  from: WakeAuthor | null;
}

export class VoiceHost implements VoiceRunner {
  readonly #agent: Agent;
  readonly #d: VoiceHostDeps;
  readonly #places = new Map<string, VoicePlace>();
  readonly #turns = new Map<string, VoiceTurn>();
  /** The turn of the run going on in each session. */
  readonly #bySession = new Map<string, string>();
  readonly #speech = new Map<string, Speech>();
  readonly #jobs = new Map<string, Job>();
  readonly #stop = new AbortController();
  readonly #outlet: VoiceOutlet;

  constructor(agent: Agent, deps: VoiceHostDeps) {
    this.#agent = agent;
    this.#d = deps;
    this.#outlet = new VoiceOutlet(agent, {
      run: (turn) => this.#spoken(turn),
      queued: (turn, context) => this.#queued(turn, context),
      wrote: (context, text, turn) => {
        const place = this.#places.get(contextKeyString(context));
        if (place === undefined) return;
        this.#d.transcript.append(place.session, [{ kind: "self", content: text, turn }], {
          context,
        });
      },
    });
  }

  get #now(): number {
    return this.#agent.ctx.clock.now();
  }

  // ---- what the runner's ports are wrapped in ----------------------------------------------

  /** The runner's outlet: voice lines here, the rest to `text`. */
  outlet(text: Outlet): Outlet {
    return new PlaceOutlet(text, this.#outlet);
  }

  /** The runner's prompt: `text`'s blocks, block 7 of a voice run its own. */
  prompt(text: PromptSource): PromptSource {
    return new VoicePrompt(this.#agent, text, {
      members: (context) => this.#places.get(contextKeyString(context))?.members ?? [],
      speaking: (context) => {
        const place = this.#places.get(contextKeyString(context));
        return place === undefined ? [] : this.#talking(place).map((s) => s.name);
      },
      recent: (input, lines) =>
        this.#d.transcript
          .tail(input.session.id)
          .entries.filter((e) => e.kind === "other" && e.redacted_at === null)
          .slice(-lines)
          .map((e) => e.content),
    });
  }

  /** What a voice run may call: `VOICE_TOOLS`; the rest is refused, and she reads why. */
  readonly guard: Guard = {
    checkCall: async ({ entry }, ctx) =>
      ctx.profile === "voice" && !VOICE_TOOLS.has(entry.name)
        ? refuse("not_in_voice", notInVoice(entry.name))
        : ALLOW,
    checkLine: async () => ALLOW,
  };

  /** How the text host's prompt reads the slow sources of a voice run (`HostPromptOptions`). */
  slowReads(input: PromptInput): SlowReads | null {
    if (input.profile !== "voice") return null;
    const state = this.#turns.get(input.turn);
    if (state === undefined) return null;
    const place = state.place;
    const listeners = place.members.filter((m) => !m.deafened);
    return voiceReads(this.#agent, place.warm, listeners, state.run.controller.signal);
  }

  /**
   * A model call of a voice run: its first event is held until a run that started early may speak;
   * the voice marks of the call (`request`, `first_token`) and the first token's latency are
   * taken on the way.
   */
  async stream(
    request: ChatRequest,
    signal: AbortSignal | undefined,
    open: () => Promise<ModelStream>,
  ): Promise<ModelStream> {
    const session = request.session ?? null;
    const turn = session === null ? undefined : this.#bySession.get(session);
    const state = turn === undefined ? undefined : this.#turns.get(turn);
    if (state === undefined) return await open();
    this.#mark(state, "context");
    this.#mark(state, "request");
    const requestAt = this.#now;
    const stream = await open();
    const held = state.run.hold;
    const first = () => this.#firstToken(state, stream.model ?? null, requestAt);
    const cut = signal ?? state.run.controller.signal;
    async function* events(): AsyncGenerator<StreamEvent> {
      let opened = false;
      for await (const event of stream) {
        if (!opened) {
          opened = true;
          first();
          // Started early: nothing it wrote is said or done before the wait is over.
          if (held !== null) await until(held, cut);
        }
        yield event;
      }
    }
    return Object.assign(events(), { model: stream.model });
  }

  // ---- VoiceRunner ------------------------------------------------------------------------

  line(msg: IncomingMessage, marks: TextLineMarks, spoken: boolean): void {
    // Her own line (the echo of what she wrote in the channel's chat): it is in already.
    if (marks.own) return;
    const place = this.#place(msg.id.context);
    place.intake = place.intake
      .then(() => this.#take(place, msg, marks, spoken))
      .catch((error: unknown) =>
        this.#agent.log.warn({ err: errorMessage(error) }, "the voice host could not take a line"),
      );
  }

  members(context: ContextKey, members: readonly VoiceParticipant[]): void {
    this.#place(context).members = members.filter((m) => !m.is_self);
  }

  /**
   * Who is in the voice channel of `context` with her (the channel itself, or its text chat: the
   * same channel); none when she is not in it.
   */
  roster(context: ContextKey): { account: AccountRef; name: string }[] {
    for (const place of this.#places.values()) {
      const c = place.context;
      if (c.platform !== context.platform || c.scope !== context.scope) continue;
      if (c.channel !== context.channel) continue;
      return place.members.map((m) => ({ account: m.account, name: m.display_name }));
    }
    return [];
  }

  speaking(context: ContextKey, account: AccountRef, speaking: boolean): void {
    const place = this.#places.get(contextKeyString(context));
    if (place === undefined) return;
    const key = accountRefString(account);
    if (speaking) {
      const name = place.members.find((m) => sameAccount(m.account, account))?.display_name;
      if (!place.speaking.has(key)) {
        place.speaking.set(key, { name: name ?? account.id, since: this.#now });
      }
    } else {
      place.speaking.delete(key);
    }
    place.lane.push({ type: "speaking" });
  }

  playback(playback: EventPayload<typeof Events.VoicePlaybackEvent>, heard: string | null): void {
    const { turn, state } = playback;
    if (turn === null) return;
    const speech = this.#speech.get(turn);
    // Not a sentence of the runner's: the agent's own turns keep theirs.
    if (speech === undefined) return;
    const place = speech.place;
    const text = playback.text.trim();
    const now = this.#now;
    const transcript = this.#d.transcript;
    switch (state) {
      case "started": {
        speech.started += 1;
        place.lastSelfAt = now;
        if (text === "") break;
        const [seq] = transcript.append(
          place.session,
          [{ kind: "self", content: text, spoken: true, turn }],
          { context: place.context },
        );
        if (seq !== undefined) speech.seqs.set(text, seq);
        break;
      }
      case "interrupted": {
        speech.ended += 1;
        place.lastSelfAt = now;
        const seq = speech.seqs.get(text);
        // What was really heard stays, not what she meant to say.
        if (seq !== undefined) transcript.heard(place.session, { seq }, heard ?? "");
        else if ((heard ?? "").trim() !== "") {
          transcript.append(
            place.session,
            [{ kind: "self", content: text, spoken: true, turn, interrupted: true, heard }],
            { context: place.context },
          );
        }
        const running = this.#turns.get(turn);
        if (running !== undefined) running.stopped = true;
        break;
      }
      case "finished":
        speech.ended += 1;
        place.lastSelfAt = now;
        break;
      case "failed":
        speech.ended += 1;
        break;
    }
    place.lane.push({ type: "playback", turn, state });
    if (speech.ended >= speech.queued && !this.#turns.has(turn)) this.#speech.delete(turn);
  }

  yieldTo(context: ContextKey, level: InterruptLevel): void {
    if (level === "queue") return;
    this.#places.get(contextKeyString(context))?.lane.push({ type: "yield", level });
  }

  left(context: ContextKey): void {
    const key = contextKeyString(context);
    this.#places.get(key)?.lane.close();
    this.#places.delete(key);
  }

  /** The emergency stop: what runs ends, what waits is dropped. */
  halt(): void {
    for (const place of this.#places.values()) place.lane.push({ type: "halt" });
  }

  stop(): void {
    this.#stop.abort();
    for (const place of this.#places.values()) place.lane.close();
    this.#places.clear();
  }

  /** Waits until every line handed over so far is in its transcript (tests). */
  async settled(): Promise<void> {
    await Promise.all([...this.#places.values()].map((p) => p.intake));
  }

  // ---- the runner's events and the bus ------------------------------------------------------

  onRunEvent(event: RunEvent): void {
    const state = this.#turns.get(event.turn);
    if (state === undefined) return;
    const agent = this.#agent;
    const context = state.place.context;
    switch (event.type) {
      case "line":
        if (contextKeyEquals(event.place, context) && event.via !== "say") {
          state.lines += 1;
          if (state.firstLineAt === null) {
            state.firstLineAt = this.#now;
            agent.focusBoard.phase(event.turn, "speaking");
          }
        }
        if (event.emotion !== null && event.emotion !== state.emotion) {
          state.emotion = event.emotion;
          agent.ctx.publish(
            Events.AgentEmotion,
            { turn: event.turn, context: event.place, emotion: event.emotion.toLowerCase() },
            { turn: event.turn },
          );
        }
        break;
      case "screened":
        if (event.kind === "feel_cut") {
          agent.log.debug({ turn: event.turn, lines: event.count }, "feel lines left out");
        } else if (event.kind !== "tag_stripped") state.tally.count(event.kind, event.count);
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
      case "finished":
        state.silentWaits = event.silent_waits ?? 0;
        if (state.silentWaits > 0) {
          silentWaits.inc({}, state.silentWaits);
          agent.log.debug(
            { turn: event.turn, silent_waits: state.silentWaits },
            "a voice run went quiet while its tools ran",
          );
        }
        break;
      case "step":
        agent.log.debug(
          { turn: event.turn, round: event.round, model: event.model, calls: event.calls },
          "voice runner step",
        );
        break;
      case "refusal":
      case "speaking":
      case "started":
        break;
    }
  }

  /** A bus event: a long tool a voice run started came back. */
  event(env: Envelope): void {
    if (is(Events.ActivityDone, env) || is(Events.ActivityFailed, env)) {
      this.#ended(env.data.task, env.type === Events.ActivityDone.type, env.data.detail ?? "");
      return;
    }
    if (parseTaskTopic(env.type) !== null) {
      const event = parseTaskEvent(env.data);
      if (event === null || (event.type !== "done" && event.type !== "failed")) return;
      this.#ended(event.task, event.type === "done", event.detail);
    }
  }

  /**
   * Puts a wake that was not started here (her initiative, a sub-agent's result) in the voice
   * lane of `context`; `false` when she is in no voice conversation there.
   */
  wake(context: ContextKey, wake: Wake): boolean {
    const place = this.#places.get(contextKeyString(context));
    if (place === undefined || place.lane.ended) return false;
    return place.lane.push({ type: "wake", wake });
  }

  /** Whether she is in the voice channel `context` (it has a running lane). */
  in(context: ContextKey): boolean {
    const place = this.#places.get(contextKeyString(context));
    return place !== undefined && !place.lane.ended;
  }

  /** Hands what the Arbiter admitted to the voice lane of `context`; `false`: no such lane. */
  admit(context: ContextKey, input: AdmittedInput): boolean {
    const place = this.#places.get(contextKeyString(context));
    if (place === undefined || place.lane.ended) return false;
    return place.lane.push(input);
  }

  /** Whether a voice run started `task` and will be woken by its end. */
  follows(task: string): boolean {
    return this.#jobs.has(task);
  }

  #ended(task: string, ok: boolean, detail: string): void {
    const job = this.#jobs.get(task);
    if (job === undefined) return;
    this.#jobs.delete(task);
    this.#places.get(contextKeyString(job.context))?.lane.push({
      type: "wake",
      wake: { kind: "result", tool: job.tool, job: task, ok, text: detail, from: job.from },
    });
  }

  // ---- places -----------------------------------------------------------------------------

  #place(context: ContextKey): VoicePlace {
    const key = contextKeyString(context);
    const known = this.#places.get(key);
    if (known !== undefined && !known.lane.ended) return known;
    const place: VoicePlace = {
      context,
      session: this.#d.sessionOf(context),
      lane: null as unknown as VoiceLane,
      members: known?.members ?? [],
      speaking: new Map(),
      lastSelfAt: known?.lastSelfAt ?? null,
      warm: known?.warm ?? new WarmValues(),
      intake: known?.intake ?? Promise.resolve(),
    };
    place.lane = new VoiceLane(this.#laneHost(place));
    this.#places.set(key, place);
    this.#agent.ctx.spawn("selfhost.voice", (signal) =>
      place.lane.run(AbortSignal.any([signal, this.#stop.signal])),
    );
    return place;
  }

  #talking(place: VoicePlace): { name: string; since: number }[] {
    const now = this.#now;
    return [...place.speaking.values()].filter((s) => now - s.since < SPEAKING_STALE_MS);
  }

  #laneHost(place: VoicePlace): VoiceLaneHost {
    const agent = this.#agent;
    const services = agent.ctx.services;
    return {
      context: place.context,
      now: () => this.#now,
      config: () => agent.config.voice,
      newTurn: () => newId(),
      someoneSpeaking: () => this.#talking(place).length > 0,
      budgetOk: () => agent.handle.llmBudget() === "ok",
      holder: () => {
        const hold = agent.mainline.floor()?.holder(place.context) ?? null;
        return hold === null ? null : { turn: hold.turn, kind: hold.kind };
      },
      interruptLevel: (incoming, holder) =>
        agent.mainline.floor()?.interruptLevel(incoming, holder) ?? "queue",
      addressedWake: (inputs) => this.#addressedWake(place, inputs),
      glanceWake: () => this.#glanceWake(place),
      execute: (run) => this.#execute(place, run),
      queued: (turn) => (this.#speech.get(turn)?.queued ?? 0) > 0,
      played: (turn) => (this.#speech.get(turn)?.started ?? 0) > 0,
      waiting: (turn) => {
        const speech = this.#speech.get(turn);
        return speech !== undefined && speech.queued > 0 && speech.started === 0;
      },
      stop: (turn) => {
        const state = this.#turns.get(turn);
        if (state !== undefined) state.stopped = true;
      },
      cancelQueued: async (turn) => {
        await services.get(ActionSinkKey)?.cancelTurn(turn);
        agent.mainline.lines.cancelUnstarted(turn, "the voice run was cut");
      },
      interrupt: async (turn) => {
        await services.get(ActionSinkKey)?.interruptTurn?.(turn);
      },
      bargedBy: (turn) => agent.bargedBy(turn),
      handleOf: (author) => agent.handleOf(author.account, author.display_name),
      speculation: (run, result, ms) => this.#speculation(place, run, result, ms),
      warn: (what, error) => agent.log.warn({ err: errorMessage(error) }, what),
    };
  }

  // ---- intake -----------------------------------------------------------------------------

  async #take(
    place: VoicePlace,
    msg: IncomingMessage,
    marks: TextLineMarks,
    spoken: boolean,
  ): Promise<void> {
    const agent = this.#agent;
    const entry = entryOfIncoming(msg, {
      person_id: agent.attitude(msg.author.account)?.person ?? null,
      spoken,
    });
    const note = marks.verdict?.note ?? null;
    if (note) entry.flagged = note;
    this.#d.transcript.append(place.session, [entry], { context: place.context });
    const call = this.#call(place, msg);
    const decision = this.#d.triage(place.context, {
      addressed: callsHer(call) ? this.#reason(place, msg) : null,
      bot: marks.bot,
      flagged: holdsBack(marks.verdict),
      muted: marks.muted || agent.handle.channelMode(place.context) === "off",
    });
    agent.log.debug(
      {
        context: contextKeyString(place.context),
        line: msg.id.id,
        triage: decision.decision === "glance" ? "glance" : `${decision.decision}:${decision.why}`,
      },
      "voice line triaged",
    );
    if (!marks.bot) this.#d.initiative?.line(place.context, callsHer(call));
    this.#place(place.context).lane.push({
      type: "line",
      msg,
      call: decision.decision === "wake" ? call : null,
      glance: decision.decision === "glance",
      inert: decision.decision === "hold" && INERT.has(decision.why),
    });
  }

  #roster(place: VoicePlace): string[] {
    return place.members.map((m) => m.display_name);
  }

  /** How `msg` relates to her (the coordinator's `#callKind` in voice). */
  #call(place: VoicePlace, msg: IncomingMessage): CallKind {
    const names = this.#agent.persona.names();
    const roster = this.#roster(place);
    const voice = {
      lastSelfAt: place.lastSelfAt,
      questionWindowMs: this.#agent.config.voice.question_window_ms,
      others: place.members.length,
      roster,
      names,
    };
    return callKind(
      msg,
      directReason(msg, names, roster),
      voice,
      asideOf(msg, names, roster, this.#answersHer(place, msg)),
    );
  }

  /** Her line is among the last three before `msg`, within three minutes (`answersHer`). */
  #answersHer(place: VoicePlace, msg: IncomingMessage): boolean {
    const entries = this.#d.transcript
      .tail(place.session)
      .entries.filter((e) => e.kind !== "note" && e.message_id !== msg.id.id);
    const her = entries
      .slice(-3)
      .reverse()
      .find((e) => e.kind === "self" || (e.kind === "tool_calls" && e.content !== ""));
    return her !== undefined && this.#now - timestampMs(her.at) < FOLLOW_UP_MS;
  }

  /** Why a line that calls her is for her, as a wake's reason. */
  #reason(place: VoicePlace, msg: IncomingMessage): AddressedReason {
    const direct = directReason(msg, this.#agent.persona.names(), this.#roster(place));
    return addressedReason(direct) ?? (msg.reply_to_self ? "reply" : "name");
  }

  #addressedWake(place: VoicePlace, inputs: readonly IncomingMessage[]): Wake | null {
    const calling = inputs.filter((m) => callsHer(this.#call(place, m)));
    const first = calling[0] ?? inputs[0];
    if (first === undefined) return null;
    const reason = this.#reason(place, first);
    const name = first.author.display_name;
    const direct = directReason(first, this.#agent.persona.names(), this.#roster(place));
    const line =
      reason === "reply"
        ? VOICE_WAKE_LINES.reply(name)
        : direct === null && place.members.length === 1
          ? VOICE_WAKE_LINES.alone(name)
          : VOICE_WAKE_LINES.call(name);
    const callers: { from: WakeAuthor; message: MessageRef }[] = [];
    for (const m of calling.length > 0 ? calling : [first]) {
      const from = { account: m.author.account, name: m.author.display_name };
      const known = callers.find((c) => sameAccount(c.from.account, from.account));
      if (known === undefined) callers.push({ from, message: m.id });
      else known.message = m.id;
    }
    return {
      kind: "addressed",
      reason,
      from: { account: first.author.account, name },
      message: first.id,
      line,
      ...(callers.length > 1 ? { callers } : {}),
    };
  }

  /** A glance at the channel if it is still due: the other people's lines since her last one. */
  #glanceWake(place: VoicePlace): Wake | null {
    if (!this.#d.takeGlance(place.context)) return null;
    const entries = this.#d.transcript.tail(place.session).entries;
    let lines = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e === undefined || e.kind === "self" || e.kind === "tool_calls") break;
      if (e.kind === "other") lines += 1;
    }
    return lines === 0 ? null : { kind: "glance", lines };
  }

  // ---- a run ------------------------------------------------------------------------------

  /** The outlet's view of a run (`undefined`: not a voice run of the host). */
  #spoken(turn: string): { hold: Promise<void> | null; stopped: boolean } | undefined {
    const state = this.#turns.get(turn);
    return state === undefined ? undefined : { hold: state.run.hold, stopped: state.stopped };
  }

  #queued(turn: string, context: ContextKey): void {
    const place = this.#places.get(contextKeyString(context));
    if (place === undefined) return;
    let speech = this.#speech.get(turn);
    if (speech === undefined) {
      speech = { place, queued: 0, started: 0, ended: 0, seqs: new Map() };
      this.#speech.set(turn, speech);
      while (this.#speech.size > MAX_SPEECH) {
        const oldest = this.#speech.keys().next().value;
        if (oldest === undefined) break;
        this.#speech.delete(oldest);
      }
    }
    speech.queued += 1;
  }

  /** `turn` reached `mark` (the first time counts); the voice module hears of it. */
  #mark(state: VoiceTurn, mark: VoiceTurnMark): void {
    if (state.marks[mark] !== undefined) return;
    const at = this.#now;
    state.marks[mark] = at;
    const focus = state.run.inputs.map((m) => ({ ...m.id }));
    this.#agent.ctx.services.get(VoiceTurnsKey)?.mark(state.run.turn, focus, mark, at);
  }

  #firstToken(state: VoiceTurn, model: string | null, requestAt: number): void {
    if (state.marks.first_token !== undefined) return;
    this.#mark(state, "first_token");
    this.#agent.ctx.publish(
      Events.VoiceLatency,
      {
        stage: "llm",
        context: { ...state.place.context },
        turn: state.run.turn,
        model: model ?? "",
        first_token_ms: Math.max(0, this.#now - requestAt),
      },
      { turn: state.run.turn },
    );
  }

  #speculation(
    place: VoicePlace,
    run: VoiceRun,
    result: "confirmed" | "dropped",
    ms: number,
  ): void {
    const state = this.#turns.get(run.turn);
    if (result === "confirmed" && state !== undefined) this.#mark(state, "confirmed");
    speculations.inc({ result });
    const requested = state?.marks.request;
    if (result === "dropped") {
      speculationWaste.inc({ part: "turn" }, ms / 1000);
      if (requested !== undefined) {
        speculationWaste.inc({ part: "model" }, (this.#now - requested) / 1000);
      }
    }
    this.#agent.ctx.publish(
      Events.VoiceLatency,
      {
        stage: "speculation",
        context: { ...place.context },
        turn: run.turn,
        result,
        ms,
        model: requested !== undefined,
      },
      { turn: run.turn },
    );
  }

  async #execute(place: VoicePlace, run: VoiceRun): Promise<void> {
    const agent = this.#agent;
    const context = place.context;
    const turn = run.turn;
    const state: VoiceTurn = {
      place,
      run,
      marks: {},
      lines: 0,
      firstLineAt: null,
      stopped: false,
      emotion: null,
      silentWaits: 0,
      tally: new CorrectionTally(true),
    };
    this.#turns.set(turn, state);
    this.#bySession.set(place.session, turn);
    agent.mainline.own(turn);
    agent.ctx.publish(Events.AgentTurnStarted, { turn, context }, { turn });
    this.#mark(state, "started");
    const floor = agent.mainline.floor();
    const kind: FloorClaimKind = floorKind(run.wake);
    const refused = kind === "ambient" ? (floor?.refuses("ambient", context) ?? null) : null;
    if (refused !== null) {
      this.#decision(state, false, [`floor: ${refused}`]);
      agentTurns.inc({ decision: "ignored" });
      this.#forget(state);
      this.#publish(state, null, null, { type: "silence" });
      this.#d.initiative?.ended(run.wake, turn, context, null, false);
      return;
    }
    floor?.hold(turn, context, kind);
    agent.mainline.holdsFloor(turn, true);
    this.#decision(state, true, this.#d.initiative?.started(run.wake, turn, context) ?? []);
    agentTurns.inc({ decision: "responded" });
    agent.focusBoard.start(this.#focus(state));
    this.#mark(state, "decided");
    this.#expect(state);
    this.#d.saved.begin(turn, context);
    let result: RunResult | null = null;
    let error: string | null = null;
    try {
      result = await withLlmTag({ module: "agent", turn, label: "voice" }, () =>
        this.#d.runner().run({
          session: { id: place.session, context },
          wake: run.wake,
          profile: PROFILES.voice,
          signal: run.controller.signal,
          turn,
        }),
      );
    } catch (e) {
      error = errorMessage(e);
      agent.log.warn({ turn, err: error }, "the voice run failed");
    } finally {
      // An early start that was dropped never was: no prompt of it.
      this.#d.saved.end(turn, !run.dropped);
      this.#d.prompt.ended(turn);
      this.#forget(state);
      agent.mainline.holdsFloor(turn, false);
      floor?.turnEnded(turn);
      agent.ctx.services.get(VoiceTurnsKey)?.settle(turn);
      const speech = this.#speech.get(turn);
      if (speech !== undefined && speech.ended < speech.queued && !state.stopped) {
        // Still speaking: barge-in keeps seeing whom it was for.
        agent.focusBoard.phase(turn, "speaking", agent.config.voice.speak_ttl_ms);
      } else {
        agent.focusBoard.end(turn);
        if (speech !== undefined && speech.ended >= speech.queued) this.#speech.delete(turn);
      }
    }
    if (result?.compacted) this.#d.prompt.forget(place.session);
    const outcome = result?.outcome ?? (error === null ? null : "failed");
    this.#d.initiative?.ended(run.wake, turn, context, outcome, state.lines > 0);
    if (run.dropped) {
      // It started early and they went on: it never was.
      agent.ctx.publish(Events.AgentTurnCompleted, { turn, context, text: "" }, { turn });
      return;
    }
    if (result !== null) this.#feel(place, run, result);
    this.#publish(state, result, error);
  }

  /** Her `<feel>` blocks of a voice run that ended (`feel.ts`): those in the channel may be named. */
  #feel(place: VoicePlace, run: VoiceRun, result: RunResult): void {
    if (result.feel.length === 0) return;
    try {
      const entries = this.#d.transcript.tail(place.session).entries;
      const people = [
        ...place.members.map((m) => ({ account: m.account, name: m.display_name })),
        ...knownPeople(entries, run.wake),
      ];
      applyFeel(feelDeps(this.#agent), {
        turn: run.turn,
        context: place.context,
        wake: run.wake,
        feel: result.feel,
        people,
        line: answeredLine(run.wake, run.inputs, entries),
      });
    } catch (error) {
      this.#agent.log.warn({ turn: run.turn, err: errorMessage(error) }, "feel not applied");
    }
  }

  #forget(state: VoiceTurn): void {
    const { place, run } = state;
    this.#turns.delete(run.turn);
    if (this.#bySession.get(place.session) === run.turn) this.#bySession.delete(place.session);
  }

  /** She will answer someone who called her: the voice module may fill a long silence. */
  #expect(state: VoiceTurn): void {
    const { run, place } = state;
    if (run.wake.kind !== "addressed") return;
    const turns = this.#agent.ctx.services.get(VoiceTurnsKey);
    if (turns === undefined) return;
    const startedAt = state.marks.started ?? this.#now;
    const expect = () => {
      if (!run.controller.signal.aborted) turns.expect(place.context, run.turn, startedAt);
    };
    if (run.hold === null) expect();
    else run.hold.then(expect, () => undefined);
  }

  #focus(state: VoiceTurn) {
    const { run, place } = state;
    const agent = this.#agent;
    const wake = run.wake;
    const callers =
      wake.kind === "addressed" ? (wake.callers?.map((c) => c.from) ?? [wake.from]) : [];
    return {
      turn: run.turn,
      context: place.context,
      reason: turnReason(wake),
      addressed_by: callers.map((c) => agent.handleOf(c.account, c.name)),
      addressed_accounts: callers.map((c) => ({ ...c.account })),
      focus: run.inputs.map((m) => ({ ...m.id })),
      background: [],
      restarts: run.restarts,
    };
  }

  #decision(state: VoiceTurn, respond: boolean, more: readonly string[]): void {
    const { run, place } = state;
    const reasons = ["runner self", "voice", ...decisionReasons(run.wake), ...more];
    this.#agent.ctx.publish(
      Events.AgentDecision,
      { turn: run.turn, context: place.context, respond, score: 0, reasons },
      { turn: run.turn },
    );
  }

  /** `agent.tool`, `agent.turn.completed` and `agent.turn.outcome` of a run. */
  #publish(
    state: VoiceTurn,
    result: RunResult | null,
    error: string | null,
    decided: TurnOutcome | null = null,
  ): void {
    const agent = this.#agent;
    const { run, place } = state;
    const turn = run.turn;
    const context = place.context;
    for (const call of result?.calls ?? []) {
      agent.ctx.publish(
        Events.AgentTool,
        { turn, context, tool: call.name, ok: call.ok, result: call.text },
        { turn },
      );
    }
    agent.ctx.publish(
      Events.AgentTurnCompleted,
      { turn, context, text: result?.lines.join("") ?? "" },
      { turn },
    );
    const outcome: TurnOutcome = decided ?? this.#outcome(state, result, error);
    const wake = run.wake;
    const last = run.inputs.at(-1);
    const stages = this.#stages(state, last);
    agent.publishOutcome({
      turn,
      context,
      reason: turnReason(wake),
      outcome,
      addressed_by:
        wake.kind === "addressed" ? [agent.handleOf(wake.from.account, wake.from.name)] : [],
      focus: run.inputs.map((m) => ({ ...m.id })),
      restarts: run.restarts,
      reasoning: result !== null && result.rounds > 0 ? "off" : null,
      latency_ms:
        state.firstLineAt === null || last === undefined
          ? null
          : Math.max(0, state.firstLineAt - timestampMs(last.ts)),
      at: toTimestamp(this.#now),
      ...(result !== null && result.rounds > 0 ? { corrections: state.tally.counts() } : {}),
      ...(stages === null ? {} : { voice_stages: stages }),
    });
  }

  #outcome(state: VoiceTurn, result: RunResult | null, error: string | null): TurnOutcome {
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

  /**
   * Where a voice run's time went, from the person's last sound to her first sentence handed to
   * the voice sink (the old turn's `#voiceStages`); `null` without a line it answers.
   */
  #stages(state: VoiceTurn, last: IncomingMessage | undefined): VoiceTurnStages | null {
    if (last === undefined) return null;
    const m = state.marks;
    const released =
      m.first_token === undefined ? undefined : Math.max(m.first_token, m.confirmed ?? 0);
    const points = [
      timestampMs(last.ts),
      state.run.heardAt ?? undefined,
      m.started,
      m.decided,
      m.context,
      m.request,
      m.first_token,
      released,
      state.firstLineAt ?? undefined,
    ];
    // Made non-decreasing, so no part is negative and the known ones add up.
    let floor = Number.NEGATIVE_INFINITY;
    const t = points.map((v) => {
      if (v === undefined) return null;
      floor = Math.max(floor, v);
      return floor;
    });
    const span = (i: number): number | null => {
      const a = t[i];
      const b = t[i + 1];
      return a === null || a === undefined || b === null || b === undefined ? null : b - a;
    };
    return {
      heard_ms: span(0),
      wait_ms: span(1),
      decide_ms: span(2),
      context_ms: span(3),
      prompt_ms: span(4),
      first_token_ms: span(5),
      held_ms: span(6),
      first_sentence_ms: span(7),
      speculative: state.run.hold !== null,
    };
  }
}

function decisionReasons(wake: Wake): string[] {
  switch (wake.kind) {
    case "addressed":
      return [`addressed: ${wake.reason}`];
    case "glance":
      return [`glance: ${wake.lines} line(s)`];
    case "result":
      return [`result: ${wake.tool}${wake.ok ? "" : " (failed)"}`];
    default:
      return [wake.kind];
  }
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
