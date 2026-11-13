// Turn coordinator: one per conversation context.
//
// Debounces incoming messages into turns and keeps at most one turn in flight. Every turn has a
// focus (focus.ts: whom it answers), and new input is handled by the one cancellation rule,
// `inputDisposition` (docs/design/v2-architecture.md §3.9):
//
// | situation                                              | handling                          |
// |--------------------------------------------------------|-----------------------------------|
// | the turn is still being collected (debounce)           | merged                            |
// | generating, input neither for her nor from the focus   | not cancelled, waits for the next |
// | generating, the focus person adds something substantial | restarted, at most once           |
// | short replies (「對」「嗯」「哈哈」)                     | never cancel                      |
// | voice: written but not played yet                      | played as is, never regenerated   |
// | her own turn (initiative, intent) and someone calls her | it gives way                      |
//
// A text reply is committed once it is handed to the scheduler (from then on input only waits);
// a voice reply is never regenerated. Every turn ends with one `agent.turn.outcome`; the ones
// cancelled here (restarted, superseded, shut down, an intent that expired or was replaced) are
// published by the coordinator, the others by the turn.
//
// In voice channels the debounce is shorter (shorter still when someone calls her, and when a
// model judged the speaker done there is little left to wait for), but it is extended (up to
// `voice.max_debounce_ms`) while someone is speaking. It counts from the person's last sound, not
// from the transcript: the voice node's silence and ASR were already part of the same wait. When
// someone calls her and part of it is left, her turn starts at once and holds its output until
// the wait is over; anything new before that drops it and the merged turn starts over (bounded by
// `voice.speculate_max_per_min`, counted in `miyoria_agent_voice_speculation_*`).
//
// An initiative request starts a turn without input, but only when the context is quiet: no
// turn in flight, no debounce pending, no speech of hers still queued; a wish or followup about
// someone also waits while she answers them, and a minute after (`ANSWERED_HOLD_MS`). While the
// Arbiter runs that is all the coordinator decides (the Arbiter retries a busy place); every rule
// (cooldowns, the level's gap, caps) is the Arbiter's. Without it the old checks apply here: her
// last words a few seconds old and the level's gap.
//
// An intent (something her mind loop decided) waits instead: it never interrupts a turn in
// flight, waiting messages or her speech still queued or playing (nor, in voice, someone still
// talking) and starts once the context is free, unless it expired meanwhile. A turn that
// answered there in the meantime drops it: what she meant to say was decided before that
// answer. A newer intent replaces a waiting one.
//
// A question nobody answered (text channels of the main line) is looked at again once it stood
// `[modules.agent.rhythm] question_secs` with nobody saying anything after it: a turn on that
// message, which attention lets through as a look only if the cap allows (v4 §7.2).
//
// Under `pipeline = "v3"` someone calling her while she speaks on her own, or something urgent,
// cuts in as far as the Floor's interrupt level says (§7.3): `wrap_up` finishes the sentence that
// is playing and drops the rest, `cut_short` and `interrupt` stop that sentence too.

import { errorMessage, metrics } from "@miyoria/kernel";
import {
  type AccountRef,
  ActionSinkKey,
  type ContextKey,
  type ImpulseRun,
  type IncomingMessage,
  type InterruptLevel,
  inputDisposition,
  newId,
  type PlaybackState,
  sameAccount,
  type TurnCancelCause,
  type TurnId,
  type TurnReason,
  timestampMs,
  toTimestamp,
} from "@miyoria/types";
import { answersHer, asideOf, directReason, followsHerLine, isQuestion } from "./attention.js";
import { maxDebounceMs, voiceMaxDebounceMs } from "./config.js";
import {
  type CallKind,
  callKind,
  callsHer,
  type FocusSelection,
  oneCaller,
  selectFocus,
} from "./focus.js";
import { UNCAPPED_INITIATIVES } from "./levels.js";
import type { Agent, Inbox, Initiative, Input, IntentTurn } from "./runtime.js";
import type { Session } from "./session.js";
import { runTurn, type TurnPlan } from "./turn.js";
import { contextId } from "./util.js";

/** Topic of latency measurements (the `voice` package's `LATENCY_TOPIC`). */
const VOICE_LATENCY_TOPIC = "voice.latency";
const MINUTE_MS = 60_000;
/** How long a dropped early start is given to let go of the Floor before the merged turn. */
const DROP_WAIT_MS = 1_000;

/**
 * Initiatives that tell someone what came of their request: not chatter of hers to give way. A
 * result turn superseded by the next person who called her was never told again (2026-11-13
 * 10:35: 「再來 給你白飯」 got 「稍等喔。」, the rice was taken, the result turn was cancelled by
 * Sakana's line, and the second round of lines never came).
 */
const OWED_INITIATIVES: readonly string[] = ["action_result", "notice"];

function owedInitiative(initiative: Initiative | null): boolean {
  return initiative !== null && OWED_INITIATIVES.includes(initiative.reason);
}

/** Voice turns that started before the wait was over, by what came of them. */
export const speculations = metrics.counter("miyoria_agent_voice_speculation_total", {
  help: "Voice turns started before the wait after an utterance was over; result is confirmed or dropped.",
  labels: ["result"],
});

/** What dropped early starts cost: the turn's time, and the model's time of those that asked it. */
export const speculationWaste = metrics.counter(
  "miyoria_agent_voice_speculation_wasted_seconds_total",
  {
    help: "Time spent by voice turns that started early and were dropped; part is turn or model.",
    labels: ["part"],
  },
);

/** Shared between a turn and its coordinator. */
export interface TurnFlags {
  /**
   * Text: the reply was handed to the scheduler. Voice: her speech started playing. From then
   * on new input no longer cancels the turn.
   */
  committed: boolean;
  /** Voice: at least one sentence was submitted. */
  queued: boolean;
  /** Voice: sentences submitted. */
  sentences: number;
  /** Voice: sentences whose playback ended (finished, interrupted or failed). */
  played: number;
  /** Voice: her speech was interrupted; submit no further sentences. */
  interrupted: boolean;
  /** Voice: she gave way to a claim on the Floor; submit no further sentences. */
  yielded?: boolean;
  /**
   * Voice: the turn started before the wait after the utterance was over (`voice.speculate`). It
   * says, does and concludes nothing until this resolves; the person going on drops it instead.
   */
  hold?: Promise<void> | null;
  /** Voice: when the newest of its utterances reached the coordinator (clock ms). */
  heardAt?: number;
  /** Voice: when its model call went out (clock ms), set by the turn. */
  requestedAt?: number;
}

interface Running {
  turn: TurnId;
  inputs: IncomingMessage[];
  flags: TurnFlags;
  controller: AbortController;
  promise: Promise<void>;
  done: boolean;
  plan: TurnPlan;
  /**
   * She started it herself (initiative, intent): it has no focus, and someone calling her
   * supersedes it. Not a result someone waits for (`OWED_INITIATIVES`): that one finishes first.
   */
  selfStarted: boolean;
  /** One of her intents (not an answer to messages or an initiative). */
  intent: boolean;
  /** Voice: started before the wait was over and not confirmed yet (`#confirm` lets it speak). */
  early: { confirm: () => void; startedAt: number } | null;
}

/** A finished voice turn whose speech is queued but has not started playing. */
interface Unplayed {
  turn: TurnId;
  inputs: IncomingMessage[];
  /** Clock ms. */
  since: number;
}

/** A finished voice turn whose speech has not all played yet. */
interface Speaking {
  turn: TurnId;
  flags: TurnFlags;
  /** Clock ms of the turn's end or its last playback event. */
  heard: number;
}

type Wake =
  | { type: "stop" }
  | { type: "input"; input: Input }
  | { type: "deadline" }
  | { type: "recheck" }
  | { type: "turn_done" }
  | { type: "idle" }
  | { type: "tick" };

/** A question nobody answered gets its look a moment after it stood long enough. */
const RECHECK_SLACK_MS = 50;

/**
 * How long after she answered someone her own wishes and followups for them wait. Right after
 * her reply in a DM, a followup turn asked something else and the turn telling the result of
 * that DM answered the person's last message a second time (2026-11-10, 「失敗了誒」).
 */
export const ANSWERED_HOLD_MS = 60_000;

/** A turn of hers that answered someone: when it ended, and whom. */
interface Answered {
  at: number;
  accounts: AccountRef[];
}

/**
 * An initiative that brings something up of her own accord (a wish or a memory followup), not a
 * result, notice, song or game line someone waits for.
 */
function bringsUp(initiative: Initiative): boolean {
  return initiative.claim === "wish" || initiative.reason === "followup";
}

/** Debounce window (clock ms): when it opened and when the turn should start. */
interface Window {
  opened: number;
  deadline: number;
  /** How long the window stays open past a sign of life. */
  wait: number;
}

export class Coordinator {
  readonly #agent: Agent;
  readonly #key: ContextKey;
  readonly #session: Session;
  readonly #inbox: Inbox;

  constructor(agent: Agent, key: ContextKey, session: Session, inbox: Inbox) {
    this.#agent = agent;
    this.#key = key;
    this.#session = session;
    this.#inbox = inbox;
  }

  get #now(): number {
    return this.#agent.ctx.clock.now();
  }

  get #voice(): boolean {
    return this.#key.kind === "voice";
  }

  /** How `msg` relates to her (focus.ts). */
  #callKind(msg: IncomingMessage): CallKind {
    const cfg = this.#agent.config.voice;
    const names = this.#agent.persona.names();
    const roster = this.#voice ? this.#session.voiceMembers().map((m) => m.display_name) : [];
    const voice = this.#voice
      ? {
          lastSelfAt: this.#session.lastSelfAt(),
          questionWindowMs: cfg.question_window_ms,
          others: this.#session.voiceMembers().length,
          roster,
          names,
        }
      : null;
    const follows = answersHer(this.#session, [msg], this.#now);
    return callKind(
      msg,
      directReason(msg, names, roster),
      voice,
      asideOf(msg, names, roster, follows),
    );
  }

  /**
   * When a question nobody answered is worth a look (v4 §7.2): text channels of the main line,
   * a question not said to her (that one she answers anyway). `null`: never.
   */
  #recheckAt(msg: IncomingMessage, kind: CallKind): number | null {
    if (this.#agent.mainline === null || callsHer(kind)) return null;
    if (this.#key.kind === "voice" || this.#key.kind === "dm") return null;
    if (!isQuestion(msg.text.toLowerCase())) return null;
    // By this clock, from when it arrived: a platform's timestamps may be skewed from it.
    return this.#now + this.#agent.rhythm.config.question_secs * 1000 + RECHECK_SLACK_MS;
  }

  async run(signal: AbortSignal): Promise<void> {
    const cfg = this.#agent.config;
    const voice = this.#voice;
    const debounce = voice ? cfg.voice.debounce_ms : cfg.debounce_ms;
    const maxDebounce = voice ? voiceMaxDebounceMs(cfg.voice) : maxDebounceMs(cfg);
    let pending: IncomingMessage[] = [];
    let window: Window | null = null;
    let running: Running | null = null;
    let unplayed: Unplayed | null = null;
    let speaking: Speaking | null = null;
    /** Restarts carried into the next turn (the restarted one's count plus one). */
    let restarts = 0;
    /** Her intent waiting for the context to be free. */
    let waiting: IntentTurn | null = null;
    /** The last line was a question nobody answered yet: look again at `at` (v4 §7.2). */
    let recheck: { msg: IncomingMessage; at: number } | null = null;
    /** Voice: when the newest input of the window arrived. */
    let heardAt: number | null = null;
    /** Voice: when early starts were dropped in the last minute (`speculate_max_per_min`). */
    const dropped: number[] = [];
    /** Clock ms until which her speech of `speaking` still holds `waiting` back. */
    const speechHold = (now: number): number | null => {
      if (speaking === null || waiting === null) return null;
      const f = speaking.flags;
      if (f.interrupted || f.yielded || f.played >= f.sentences) return null;
      const until = speaking.heard + cfg.voice.speak_ttl_ms;
      return now < until ? until : null;
    };
    /** Her turns that answered someone, in the last `ANSWERED_HOLD_MS`. */
    let answered: Answered[] = [];
    for (;;) {
      // Voice contexts live until she leaves the channel.
      const idle =
        pending.length === 0 && running === null && waiting === null && recheck === null && !voice;
      // A turn that started early still waits for the end of the window to speak.
      const timed = running === null || running.early !== null ? window : null;
      const wake = await this.#next(
        signal,
        running,
        timed,
        idle,
        recheck?.at ?? null,
        speechHold(this.#now),
      );
      const now = this.#now;
      switch (wake.type) {
        case "stop": {
          if (running && !running.done) await this.#abort(running, "shutdown", null);
          if (unplayed) await this.#cancel(unplayed.turn);
          if (waiting) {
            this.#agent.intentSkipped(this.#key, waiting, "the context closed");
            this.#cancelled(waiting.turn, "initiative", "shutdown");
          }
          return;
        }
        case "input": {
          const input = wake.input;
          switch (input.type) {
            case "message": {
              const msg = input.message;
              const kind = this.#callKind(msg);
              // Whatever was said since, the question that stood alone does not any more.
              const at = this.#recheckAt(msg, kind);
              recheck = at === null ? null : { msg, at };
              // Voice: they went on while her turn ran ahead of the wait. It is dropped, its
              // input is merged with this, as the wait would have done.
              if (running?.early && !running.done) {
                pending = [...(await this.#drop(running, dropped)), ...pending];
                running = null;
              }
              if (running && !running.flags.committed && !running.done) {
                const r = running;
                const disposition = inputDisposition({
                  phase: r.flags.queued ? "speaking" : "generating",
                  voice,
                  addressesHer: callsHer(kind),
                  fromFocus: (r.plan.selection?.authors ?? []).some((a) =>
                    sameAccount(a, msg.author.account),
                  ),
                  text: msg.text,
                  restarts: r.plan.focus.restarts,
                  selfStarted: r.selfStarted,
                });
                if (disposition === "restart") {
                  const by = this.#agent.handleOf(msg.author.account, msg.author.display_name);
                  const cause: TurnCancelCause = r.selfStarted ? "superseded" : "input";
                  const merged = await this.#abort(r, cause, by);
                  running = null;
                  pending = [...merged, ...pending];
                  window = null;
                  restarts = r.selfStarted ? 0 : r.plan.focus.restarts + 1;
                }
              }
              // Someone calling her cuts into what she says on her own.
              if (callsHer(kind)) {
                await this.#giveWay(kind === "reply" ? "reply" : "addressed", running, unplayed);
              }
              // Her speech that is written but not played yet is played as is (§3.9).
              pending.push(msg);
              let wait = voice && callsHer(kind) ? cfg.voice.direct_debounce_ms : debounce;
              // Voice: the wait counts from their last sound. The node's silence and ASR were
              // part of it (about a second, 2026-11-07 to 11-10), and waiting it again after the
              // transcript asked the same question twice.
              let from = now;
              if (voice && msg.turn_complete === true) {
                wait = Math.min(wait, cfg.voice.turn_debounce_ms);
              } else if (voice && cfg.voice.debounce_from_speech_end) {
                from = Math.min(now, timestampMs(msg.ts));
              }
              const opened: number = window?.opened ?? now;
              window = {
                opened,
                deadline: Math.min(Math.max(from + wait, now), opened + maxDebounce),
                wait,
              };
              if (voice) heardAt = now;
              // Someone called her and part of the wait is left: her turn starts now and speaks
              // once the wait is over.
              if (
                running === null &&
                unplayed === null &&
                this.#mayStartEarly(pending, window, dropped)
              ) {
                running = this.#startEarly(pending, signal, restarts, heardAt);
                pending = [];
              }
              break;
            }
            case "typing":
              if (window) {
                window.deadline = Math.min(
                  Math.max(window.deadline, now + cfg.typing_extend_ms),
                  window.opened + maxDebounce,
                );
              }
              break;
            case "speaking":
              // Started: do not answer over them. Stopped: give the transcript of what they
              // said time to arrive.
              if (window) {
                window.deadline = Math.min(
                  Math.max(window.deadline, now + window.wait),
                  window.opened + maxDebounce,
                );
              }
              break;
            case "playback": {
              const flags =
                running && running.turn === input.turn
                  ? running.flags
                  : speaking && speaking.turn === input.turn
                    ? speaking.flags
                    : null;
              if (speaking && speaking.turn === input.turn) speaking.heard = now;
              if (await this.#playback(input.turn, input.state, flags, unplayed)) unplayed = null;
              break;
            }
            case "initiative": {
              answered = answered.filter((a) => now - a.at < ANSWERED_HOLD_MS);
              const started = await this.#initiative(
                input.initiative,
                running !== null,
                pending.length > 0 || waiting !== null,
                unplayed !== null && now < unplayed.since + cfg.voice.speak_ttl_ms,
                input.reply ?? null,
                this.#justAnswered(input.initiative, answered),
              );
              if (started) running = started;
              break;
            }
            case "yield": {
              const holder = this.#agent.mainline?.floor()?.holder(this.#key)?.turn ?? null;
              if (holder !== null) await this.#apply(input.level, holder, running);
              break;
            }
            case "halt": {
              if (running && !running.done) await this.#abort(running, "shutdown", null);
              running = null;
              if (unplayed) await this.#cancel(unplayed.turn);
              unplayed = null;
              if (waiting) {
                this.#agent.intentSkipped(this.#key, waiting, "the emergency stop");
                this.#cancelled(waiting.turn, "initiative", "shutdown");
              }
              waiting = null;
              pending = [];
              window = null;
              recheck = null;
              restarts = 0;
              break;
            }
            case "intent":
              if (waiting) {
                this.#agent.intentSkipped(this.#key, waiting, "replaced by a newer intent");
                this.#cancelled(waiting.turn, "initiative", "superseded");
              }
              waiting = input.intent;
              break;
          }
          break;
        }
        case "deadline": {
          if (window) {
            const cap = window.opened + maxDebounce;
            if (voice && now < cap && this.#session.someoneSpeaking()) {
              window.deadline = Math.min(now + window.wait, cap);
              break;
            }
          }
          window = null;
          // Voice: the turn that started early may speak now.
          if (running?.early) {
            this.#confirm(running);
            restarts = 0;
            break;
          }
          // Text: several people calling her at once get a turn each, in the order they called.
          // One turn for all of them mixed the answers, unquoted, and read as said to the first
          // (2026-11-13 03:06: 「那站遠一點」 was for When You See It, under 阿鰻's question).
          const { now: inputs, later } =
            voice || !cfg.one_caller_per_turn
              ? { now: pending, later: [] }
              : oneCaller(pending, (m) => this.#callKind(m));
          pending = later;
          // The next caller's turn starts as soon as this one is done (`timed` waits for it).
          if (later.length > 0) window = { opened: now, deadline: now, wait: debounce };
          const heard = voice && heardAt !== null ? { heardAt, hold: null } : null;
          running = this.#start(inputs, null, signal, null, restarts, false, heard);
          restarts = 0;
          break;
        }
        case "recheck": {
          const r = recheck;
          recheck = null;
          // Only into a quiet place, and only once a message: a turn that already answered or
          // looked at it settled it.
          const free = running === null && pending.length === 0 && window === null;
          if (r !== null && free && !this.#agent.rhythm.taken(r.msg.id.id)) {
            running = this.#start([r.msg], null, signal, null, 0, true);
          }
          break;
        }
        case "turn_done": {
          const r = running as Running;
          running = null;
          // An early start that ended on its own (it failed) took the window's input with it.
          if (r.early !== null) window = null;
          const reason = r.plan.focus.reason;
          if (reason === "addressed" || reason === "reply_to_her") {
            answered.push({ at: now, accounts: [...r.plan.focus.addressed_accounts] });
          }
          const flags = r.flags;
          if (voice && flags.queued && !flags.committed && !flags.interrupted) {
            unplayed = { turn: r.turn, inputs: r.inputs, since: now };
          }
          if (voice && flags.queued && !flags.interrupted) {
            // Still speaking: barge-in keeps seeing whom it was for.
            this.#agent.focusBoard.phase(r.turn, "speaking", cfg.voice.speak_ttl_ms);
          } else {
            this.#agent.focusBoard.end(r.turn);
          }
          if (voice && flags.queued && !flags.interrupted) {
            speaking = { turn: r.turn, flags, heard: now };
          }
          if (waiting !== null && !r.intent && (flags.committed || flags.queued)) {
            this.#agent.intentSkipped(this.#key, waiting, "she just answered here");
            this.#cancelled(waiting.turn, "initiative", "superseded");
            waiting = null;
          }
          break;
        }
        case "tick":
          break;
        case "idle":
          if (this.#agent.retire(this.#key, this.#inbox)) {
            this.#agent.log.debug(
              { context: contextId(this.#key) },
              "context idle, session dropped",
            );
            return;
          }
          break;
      }
      if (waiting !== null && running === null && pending.length === 0) {
        const speechQueued = unplayed !== null && now < unplayed.since + cfg.voice.speak_ttl_ms;
        const playing = speechHold(now) !== null;
        if (!speechQueued && !playing && !(voice && this.#session.someoneSpeaking())) {
          const w = waiting;
          waiting = null;
          running = this.#intent(w, signal);
        }
      }
    }
  }

  /** V3: a claim of `kind` arrives while she may be speaking here. */
  async #giveWay(
    kind: "addressed" | "reply",
    running: Running | null,
    unplayed: Unplayed | null,
  ): Promise<void> {
    const floor = this.#agent.mainline?.floor();
    const holder = floor?.holder(this.#key) ?? null;
    if (!floor || holder === null) return;
    // Her own turn still generating is `inputDisposition`'s: it restarts.
    if (running !== null && running.turn === holder.turn && !running.flags.queued) return;
    const turn = unplayed?.turn === holder.turn ? unplayed.turn : holder.turn;
    await this.#apply(floor.interruptLevel(kind, holder.kind), turn, running);
  }

  /** §7.3 on `turn`. */
  async #apply(level: InterruptLevel, turn: TurnId, running: Running | null): Promise<void> {
    if (level === "queue") return;
    if (running?.turn === turn) running.flags.yielded = true;
    this.#agent.log.debug({ turn, level }, "she gives way");
    await this.#cancel(turn);
    if (level === "wrap_up") return;
    const sink = this.#agent.ctx.services.get(ActionSinkKey);
    try {
      await sink?.interruptTurn?.(turn);
    } catch (error) {
      this.#agent.log.debug({ turn, error: errorMessage(error) }, "could not stop her speech");
    }
  }

  /** Starts her intent turn, unless it expired while waiting. */
  #intent(input: IntentTurn, signal: AbortSignal): Running | null {
    if (this.#now >= Date.parse(input.intent.expires_at)) {
      this.#agent.intentSkipped(this.#key, input, "expired");
      this.#cancelled(input.turn, "initiative", "expired");
      return null;
    }
    // The channel's level (checked again: another start may have come first). An intent the
    // Arbiter let through was checked there and booked as her start.
    if (!input.gated) {
      const blocked = this.#agent.startBlocked(this.#key);
      if (blocked !== null) {
        this.#agent.intentSkipped(this.#key, input, blocked);
        return null;
      }
      this.#agent.noteStart(this.#key);
    }
    return this.#start([], null, signal, input);
  }

  /** Waits for the next thing to do (Rust `select!` over the coordinator's sources). */
  async #next(
    signal: AbortSignal,
    running: Running | null,
    window: Window | null,
    idle: boolean,
    recheckAt: number | null = null,
    /** Clock ms to wake at, so a waiting intent is looked at again (`null`: none). */
    tickAt: number | null = null,
  ): Promise<Wake> {
    let idleFired = false;
    for (;;) {
      if (signal.aborted) return { type: "stop" };
      if (running?.done) return { type: "turn_done" };
      const input = this.#inbox.shift();
      if (input) return { type: "input", input };
      if (this.#inbox.closed) return { type: "stop" };
      if (window && this.#now >= window.deadline) return { type: "deadline" };
      if (recheckAt !== null && this.#now >= recheckAt) return { type: "recheck" };
      if (idleFired) return { type: "idle" };
      if (tickAt !== null && this.#now >= tickAt) return { type: "tick" };

      const timers: ReturnType<typeof setTimeout>[] = [];
      let onAbort: (() => void) | undefined;
      const waits: Promise<unknown>[] = [
        this.#inbox.ready(),
        new Promise<void>((resolve) => {
          onAbort = () => resolve();
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ];
      if (running) waits.push(running.promise);
      if (window) {
        const ms = Math.max(window.deadline - this.#now, 0);
        waits.push(new Promise<void>((resolve) => timers.push(setTimeout(resolve, ms))));
      }
      if (recheckAt !== null) {
        const ms = Math.max(recheckAt - this.#now, 0);
        waits.push(new Promise<void>((resolve) => timers.push(setTimeout(resolve, ms))));
      }
      if (tickAt !== null) {
        const ms = Math.max(tickAt - this.#now, 0);
        waits.push(new Promise<void>((resolve) => timers.push(setTimeout(resolve, ms))));
      }
      if (idle) {
        waits.push(
          new Promise<void>((resolve) =>
            timers.push(
              setTimeout(() => {
                idleFired = true;
                resolve();
              }, this.#agent.config.session_idle_ms),
            ),
          ),
        );
      }
      try {
        await Promise.race(waits);
      } finally {
        for (const t of timers) clearTimeout(t);
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
    }
  }

  /**
   * Handles an initiative request; returns the started turn, if any. With `reply` it is an
   * impulse the Arbiter accepted: the rules were the Arbiter's, only whether the place is free
   * is decided here (and told back through `reply`).
   */
  async #initiative(
    initiative: Initiative,
    turnRunning: boolean,
    messagesWaiting: boolean,
    speechQueued: boolean,
    reply: ((run: ImpulseRun) => void) | null,
    answering: string | null = null,
  ): Promise<Running | null> {
    const busy = turnRunning
      ? "a turn is in flight"
      : messagesWaiting
        ? "messages are waiting for a turn"
        : speechQueued
          ? "her speech is still queued"
          : answering;
    if (reply !== null) {
      if (busy !== null || (this.#voice && this.#session.someoneSpeaking())) {
        reply({ status: "busy", detail: busy ?? "someone is speaking" });
        return null;
      }
      const started = this.#start([], initiative, this.#agent.ctx.signal);
      reply({ status: "started", turn: started.turn, task: null, detail: "" });
      return started;
    }
    if (busy !== null) {
      this.#agent.initiativeSkipped(this.#key, initiative.reason, busy);
      return null;
    }
    // Live game commentary is rate-limited by the game director itself, and a result someone
    // is waiting for (`action_result`, `notice`) is no chatter to space out.
    const last =
      initiative.reason === "game" || owedInitiative(initiative)
        ? null
        : this.#session.lastSelfAt();
    const capped = !UNCAPPED_INITIATIVES.includes(initiative.reason);
    if (last !== null) {
      const cooldown = this.#agent.afterSpeechMs(this.#key);
      const since = this.#now - last;
      if (since < cooldown) {
        this.#agent.initiativeSkipped(
          this.#key,
          initiative.reason,
          `cooldown (${since}ms since she spoke)`,
        );
        return null;
      }
    }
    if (capped) {
      const blocked = this.#agent.startBlocked(this.#key);
      if (blocked !== null) {
        this.#agent.initiativeSkipped(this.#key, initiative.reason, blocked);
        return null;
      }
      this.#agent.noteStart(this.#key);
    }
    return this.#start([], initiative, this.#agent.ctx.signal);
  }

  /**
   * Why `initiative` waits because she is talking with the person it is about: she answered them
   * here within `ANSWERED_HOLD_MS` (in a DM, the one person there), or a turn answering them is in
   * flight anywhere. `null`: it does not wait for that. Only what she brings up of her own accord
   * waits (`bringsUp`); a result someone waits for does not.
   */
  #justAnswered(initiative: Initiative, answered: readonly Answered[]): string | null {
    if (!bringsUp(initiative)) return null;
    const about = initiative.about;
    const theirs = (accounts: readonly AccountRef[]) =>
      accounts.some((a) => about.some((b) => sameAccount(a, b)));
    if (answered.some((a) => this.#key.kind === "dm" || theirs(a.accounts))) {
      return "she just answered them";
    }
    for (const focus of this.#agent.focusBoard.all()) {
      if (focus.reason !== "addressed" && focus.reason !== "reply_to_her") continue;
      if (theirs(focus.addressed_accounts)) return "she is answering them";
    }
    return null;
  }

  /** What a new turn is for: its focus split and the focus record. */
  #plan(
    turn: TurnId,
    inputs: readonly IncomingMessage[],
    initiative: Initiative | null,
    restarts: number,
  ): TurnPlan {
    let selection: FocusSelection | null = null;
    let reason: TurnReason;
    if (inputs.length > 0) {
      // Only a line hers to take up is `reply_to_her`: someone else right after she answered one
      // person is ambient (2026-11-10, `followsHerLine`), and never in `addressed`.
      const roster = this.#voice ? this.#session.voiceMembers().map((m) => m.display_name) : [];
      const follows = followsHerLine(
        this.#session,
        inputs,
        this.#now,
        this.#agent.persona.names(),
        roster,
      );
      selection = selectFocus(inputs, (m) => this.#callKind(m), follows);
      reason = selection.reason;
    } else {
      reason = initiative?.reason === "notice" ? "notice" : "initiative";
    }
    const addressed = selection?.addressed ?? [];
    return {
      selection,
      focus: {
        turn,
        context: this.#key,
        reason,
        addressed_by: addressed.map((a) => this.#agent.handleOf(a.account, a.display_name)),
        addressed_accounts: addressed.map((a) => ({ ...a.account })),
        focus: (selection?.focus ?? []).map((m) => ({ ...m.id })),
        background: (selection?.background ?? []).map((m) => ({ ...m.id })),
        restarts,
      },
    };
  }

  #start(
    inputs: IncomingMessage[],
    initiative: Initiative | null,
    signal: AbortSignal,
    intent: IntentTurn | null = null,
    restarts = 0,
    stood = false,
    heard: { heardAt: number; hold: Promise<void> | null } | null = null,
  ): Running {
    const turn = intent?.turn ?? newId();
    this.#agent.ctx.publish(
      { type: "agent_turn_started", data: { turn, context: this.#key } },
      { turn },
    );
    const plan = this.#plan(turn, inputs, initiative, restarts);
    if (stood) plan.stood = true;
    this.#agent.focusBoard.start(plan.focus);
    const flags: TurnFlags = {
      committed: false,
      queued: false,
      sentences: 0,
      played: 0,
      interrupted: false,
      ...(heard === null ? {} : { heardAt: heard.heardAt, hold: heard.hold }),
    };
    const controller = new AbortController();
    if (signal.aborted) controller.abort(signal.reason);
    const running: Running = {
      turn,
      inputs,
      flags,
      controller,
      promise: Promise.resolve(),
      done: false,
      plan,
      selfStarted: inputs.length === 0 && !owedInitiative(initiative),
      intent: intent !== null,
      early: null,
    };
    running.promise = runTurn(
      this.#agent,
      this.#key,
      this.#session,
      turn,
      inputs,
      initiative,
      flags,
      controller.signal,
      intent,
      plan,
    )
      .catch((error: unknown) => {
        this.#agent.log.warn({ turn, error: errorMessage(error) }, "turn failed");
      })
      .finally(() => {
        running.done = true;
      });
    return running;
  }

  // ---- voice: starting before the wait is over (v4 §7.5 item 4) --------------------------------

  /**
   * Whether `pending` starts its turn now rather than at the end of `window`: someone called her
   * (she nearly always answers then: 1489 of 1491, 2026-11-07 to 11-10), part of the wait is left,
   * nobody is talking, the LLM budget is fine and fewer than `speculate_max_per_min` early starts
   * were dropped in the last minute.
   */
  #mayStartEarly(pending: readonly IncomingMessage[], window: Window, dropped: number[]): boolean {
    const cfg = this.#agent.config.voice;
    const now = this.#now;
    if (!this.#voice || !cfg.speculate || window.deadline <= now) return false;
    if (this.#session.someoneSpeaking() || this.#agent.handle.llmBudget() !== "ok") return false;
    // She holds the mic (her own line plays or waits): giving way and barge-in stay as they are.
    if ((this.#agent.mainline?.floor()?.holder(this.#key) ?? null) !== null) return false;
    while (dropped.length > 0 && (dropped[0] as number) <= now - MINUTE_MS) dropped.shift();
    if (dropped.length >= cfg.speculate_max_per_min) return false;
    return pending.some((m) => this.#callKind(m) !== null);
  }

  /** Starts `inputs` now; it says nothing until `#confirm` (or `#drop` ends it). */
  #startEarly(
    inputs: IncomingMessage[],
    signal: AbortSignal,
    restarts: number,
    heardAt: number | null,
  ): Running {
    let confirm: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      confirm = resolve;
    });
    const running = this.#start(inputs, null, signal, null, restarts, false, {
      heardAt: heardAt ?? this.#now,
      hold,
    });
    running.early = { confirm, startedAt: this.#now };
    return running;
  }

  /** The wait is over and nobody went on: the turn that started early may speak. */
  #confirm(running: Running): void {
    const early = running.early;
    if (early === null) return;
    running.early = null;
    early.confirm();
    speculations.inc({ result: "confirmed" });
    this.#speculation(running, "confirmed", this.#now - early.startedAt);
  }

  /**
   * They went on before the wait was over: the turn that started early is dropped (what it did is
   * counted, nothing of it was said or concluded) and its input goes back to the window.
   */
  async #drop(running: Running, dropped: number[]): Promise<IncomingMessage[]> {
    const early = running.early;
    running.early = null;
    running.controller.abort();
    await this.#cancel(running.turn);
    // It lets go of the Floor and of the line it answered when it ends: the merged turn must not
    // find them held. It ends at once (everything it waits on follows the signal).
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      running.promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, DROP_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    this.#agent.focusBoard.end(running.turn);
    this.#agent.ctx.publish(
      { type: "agent_turn_completed", data: { turn: running.turn, context: this.#key, text: "" } },
      { turn: running.turn },
    );
    const now = this.#now;
    dropped.push(now);
    const wasted = early === null ? 0 : now - early.startedAt;
    speculations.inc({ result: "dropped" });
    speculationWaste.inc({ part: "turn" }, wasted / 1000);
    const requested = running.flags.requestedAt;
    if (requested !== undefined) speculationWaste.inc({ part: "model" }, (now - requested) / 1000);
    this.#agent.log.debug(
      { turn: running.turn, context: contextId(this.#key), wasted_ms: wasted },
      "they went on: the turn that started early is dropped",
    );
    this.#speculation(running, "dropped", wasted);
    return running.inputs;
  }

  /** `voice.latency`, stage `speculation`: what an early start came to and what it cost. */
  #speculation(running: Running, result: "confirmed" | "dropped", ms: number): void {
    const requested = running.flags.requestedAt;
    this.#agent.ctx.publish(
      {
        type: "custom",
        data: {
          topic: VOICE_LATENCY_TOPIC,
          payload: {
            stage: "speculation",
            context: { ...this.#key },
            turn: running.turn,
            result,
            // From the early start to this; `model`: it asked the model (a dropped one paid for
            // its prompt and what was streamed until it was cut).
            ms,
            model: requested !== undefined,
          },
        },
      },
      { turn: running.turn },
    );
  }

  /**
   * Her speech of `turn` started, ended or was cut off (`flags`: those of `turn` if it is the
   * running turn). Returns whether `unplayed` is resolved.
   */
  async #playback(
    turn: TurnId,
    state: PlaybackState,
    flags: TurnFlags | null,
    unplayed: Unplayed | null,
  ): Promise<boolean> {
    if (flags) {
      if (state !== "started") flags.played += 1;
      if (state === "started" || state === "finished") {
        flags.committed = true;
      } else if (state === "interrupted") {
        flags.committed = true;
        flags.interrupted = true;
      }
    }
    const resolved = state !== "failed" && unplayed !== null && unplayed.turn === turn;
    if (state === "interrupted") {
      // The rest of what she meant to say would no longer fit.
      this.#agent.log.debug(
        { turn, context: contextId(this.#key) },
        "speech interrupted, dropping the rest",
      );
      this.#agent.focusBoard.end(turn);
      await this.#cancel(turn);
    }
    return resolved;
  }

  /** Drops the queued actions of `turn`. */
  async #cancel(turn: TurnId): Promise<void> {
    const sink = this.#agent.ctx.services.get(ActionSinkKey);
    if (sink) {
      try {
        await sink.cancelTurn(turn);
      } catch (error) {
        this.#agent.log.debug({ turn, error: errorMessage(error) }, "could not cancel turn");
      }
    }
    this.#agent.mainline?.lines.cancelUnstarted(turn, "the turn was cancelled");
  }

  /** The outcome of a turn that never ran or was stopped here. */
  #cancelled(
    turn: TurnId,
    reason: TurnReason,
    cause: TurnCancelCause,
    by: string | null = null,
    running: Running | null = null,
  ): void {
    const f = running?.plan.focus;
    this.#agent.focusBoard.end(turn);
    this.#agent.publishOutcome({
      turn,
      context: this.#key,
      reason: f?.reason ?? reason,
      outcome: { type: "cancelled", cause, by },
      addressed_by: [...(f?.addressed_by ?? [])],
      focus: (f?.focus ?? []).map((m) => ({ ...m })),
      restarts: f?.restarts ?? 0,
      reasoning: null,
      latency_ms: null,
      at: toTimestamp(this.#now),
    });
  }

  /** Cancels a turn whose reply was not committed yet; returns its inputs. */
  async #abort(
    running: Running,
    cause: TurnCancelCause,
    by: string | null,
  ): Promise<IncomingMessage[]> {
    running.controller.abort();
    this.#agent.log.debug(
      { turn: running.turn, context: contextId(this.#key), cause },
      cause === "shutdown" ? "turn stopped" : "turn cancelled by new input",
    );
    await this.#cancel(running.turn);
    this.#agent.ctx.publish(
      {
        type: "agent_turn_completed",
        data: { turn: running.turn, context: this.#key, text: "" },
      },
      { turn: running.turn },
    );
    this.#cancelled(running.turn, running.plan.focus.reason, cause, by, running);
    return running.inputs;
  }
}
