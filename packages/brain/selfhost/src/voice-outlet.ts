// How a sentence of hers is said in a voice channel on the new runner: through the mouth
// (`MainLine.say`, which puts it on the voice lane as a `speak` action), so the one-mouth rule, the
// output review and the delivery ledger stay what they are; the scheduler and the voice sink say
// it. A run that started early says nothing until its wait is over (`hold`), and nothing more once
// she was cut off or gave way.
//
// The line is not hers in the transcript yet: the voice host writes it there when it starts
// playing (`Delivery.later`). Links and code blocks are never read out: they go to the voice
// channel's text chat (`[modules.agent.voice] text_aside`) and into the transcript at once.
//
// With `[modules.agent.voice] text_echo` the sentences of a run are also written in that chat as
// one message once the run is over (`echo`): as she wrote them, or as they were said
// (`text_echo_text`), which is known once the last of them has started. A copy for people to read,
// not a line of hers in the transcript, which has them as spoken.
//
// `PlaceOutlet` gives each line to the outlet of its place: voice channels here, the rest to the
// text host's.

import { type ContextKey, VoiceSinkKey } from "@miyoria/types";
import { type Agent, cleanReply, isSpeakable } from "../../agent/src/index.js";
import { asideLine, type Delivery, type OutgoingLine, type Outlet } from "../../self/src/index.js";
import { CUT_OFF, NO_ASIDE, UNSPOKEN } from "./voice-texts.js";

/** What the outlet knows of a run's speech. */
export interface SpokenRun {
  /** Resolves once a run that started early may speak; `null`: it may. */
  readonly hold: Promise<void> | null;
  /** She was cut off or gave way: nothing more is said. */
  readonly stopped: boolean;
}

export interface VoiceOutletHost {
  /** The run of `turn`, when it is a voice run of the host. */
  run(turn: string): SpokenRun | undefined;
  /** A sentence of `turn` was handed to the mouth in `context`. */
  queued(turn: string, context: ContextKey): void;
  /** A line of hers was written in the voice channel's chat: `context`'s transcript has it now. */
  wrote(context: ContextKey, text: string, turn: string): void;
}

export class VoiceOutlet implements Outlet {
  readonly #agent: Agent;
  readonly #host: VoiceOutletHost;
  /** The sentences each run handed to the mouth, for `echo`. */
  readonly #said = new Map<string, { place: ContextKey; lines: EchoLine[] }>();

  constructor(agent: Agent, host: VoiceOutletHost) {
    this.#agent = agent;
    this.#host = host;
  }

  async deliver(line: OutgoingLine, signal: AbortSignal): Promise<Delivery> {
    const agent = this.#agent;
    if (agent.muted) return { status: "blocked", reason: "緊急停止中" };
    signal.throwIfAborted();
    const run = this.#host.run(line.turn);
    const hold = run?.hold ?? null;
    if (hold !== null) await until(hold, signal);
    if (run?.stopped) return { status: "blocked", reason: CUT_OFF };
    agent.mainline.own(line.turn);
    if (asideLine(line.text)) return await this.#aside(line);
    const text = cleanReply(line.text, agent.persona.names());
    if (!isSpeakable(text)) return { status: "blocked", reason: UNSPOKEN };
    agent.ctx.services.get(VoiceSinkKey)?.prepare?.(line.place, text, undefined, line.emotion);
    this.#host.queued(line.turn, line.place);
    await agent.mainline.say({
      context: line.place,
      text,
      emotion: line.emotion,
      turn: line.turn,
      source: "self",
    });
    if (agent.config.voice.text_echo && line.place.kind === "voice") {
      const said = this.#said.get(line.turn) ?? { place: line.place, lines: [] };
      said.lines.push({ written: text, spoken: null });
      this.#said.set(line.turn, said);
    }
    return { status: "delivered", message_id: null, later: true };
  }

  /** The sentence `written` of `turn` started playing, sent to TTS as `spoken`. */
  spoke(turn: string, written: string, spoken: string): void {
    const line = this.#said
      .get(turn)
      ?.lines.find((l) => l.spoken === null && l.written.trim() === written.trim());
    if (line !== undefined) line.spoken = spoken;
  }

  /**
   * The run of `turn` is over: what it said is written in the voice channel's chat, as one
   * message (`text_echo`). Best effort: a failure is only logged.
   */
  async echo(turn: string): Promise<void> {
    const said = this.#said.get(turn);
    if (said === undefined) return;
    this.#said.delete(turn);
    const agent = this.#agent;
    const spoken = agent.config.voice.text_echo_text === "spoken";
    const text = joinSaid(said.lines.map((l) => (spoken ? (l.spoken ?? l.written) : l.written)));
    if (text === "") return;
    // On Discord a voice channel's text chat has the channel's own id.
    const chat: ContextKey = { ...said.place, kind: "channel" };
    try {
      await agent.mainline.say({ context: chat, text, turn, source: "self" });
    } catch (error) {
      agent.log.warn({ turn, err: String(error) }, "the spoken reply was not written in the chat");
    }
  }

  /** A link or a code block: written in the voice channel's chat, never read out. */
  async #aside(line: OutgoingLine): Promise<Delivery> {
    const agent = this.#agent;
    const place = line.place;
    if (!agent.config.voice.text_aside || place.kind !== "voice") {
      return { status: "blocked", reason: NO_ASIDE };
    }
    // On Discord a voice channel's text chat has the channel's own id.
    const chat: ContextKey = { ...place, kind: "channel" };
    await agent.mainline.say({ context: chat, text: line.text, turn: line.turn, source: "self" });
    this.#host.wrote(place, line.text, line.turn);
    return { status: "delivered", message_id: null, later: true };
  }
}

/** A sentence handed to the mouth: as she wrote it, and as it was sent to TTS when that differs. */
interface EchoLine {
  written: string;
  spoken: string | null;
}

/** Sentences as one text: a space only between two that would otherwise run into each other. */
export function joinSaid(lines: readonly string[]): string {
  let out = "";
  for (const line of lines) {
    const text = line.trim();
    if (text === "") continue;
    out += out !== "" && /[!-~]$/.test(out) && /^[!-~]/.test(text) ? ` ${text}` : text;
  }
  return out;
}

/** Each line to the outlet of its place: voice channels to `voice`, the rest to `text`. */
export class PlaceOutlet implements Outlet {
  constructor(
    readonly text: Outlet,
    readonly voice: Outlet,
  ) {}

  deliver(line: OutgoingLine, signal: AbortSignal): Promise<Delivery> {
    return line.place.kind === "voice"
      ? this.voice.deliver(line, signal)
      : this.text.deliver(line, signal);
  }
}

/** Waits for `promise`; rejects when `signal` aborts first. */
export function until(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
