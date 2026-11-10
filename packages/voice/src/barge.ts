// Barge-in: what to do with her playback when somebody talks while she speaks.
//
// docs/design/v2-architecture.md §3.9: she stops only for the people the turn is for, for
// somebody saying her name, or once ASR returns substantive content for her. Anyone else
// talking only ducks her volume. Somebody the turn is for pauses her first; if the transcript
// shows they were not talking to her (a "嗯", an echo, noise) she goes on with the rest of her
// line instead of dropping it.

import { getLogger } from "@miyoria/kernel";
import {
  type AccountRef,
  accountRefString,
  type ContextKey,
  isShortReply,
  type TurnId,
  type TurnPhase,
  type VoiceBargeIn,
  type VoiceBargeInAction,
  type VoiceBargeInReason,
} from "@miyoria/types";
import type { BargeInMode } from "./config.js";
import type { Stoppable } from "./link/playback.js";

const log = getLogger("voice.barge");

// ---- the decision ---------------------------------------------------------------------------

/** How the speaker relates to the turn in flight: `unknown` = no turn focus is known. */
export type SpeakerRole = "focus" | "other" | "unknown";

export interface BargeThresholds {
  /** Somebody who is not for her ducks her after talking this long. */
  duckMs: number;
  /** The focus person pauses her after talking this long. */
  pauseMs: number;
  /** The focus person who keeps talking this long stops her without waiting for ASR. */
  focusStopMs: number;
}

export type BargeFacts =
  /** What the voice activity detector shows: somebody has been talking for `speechRunMs`. */
  | {
      stage: "vad";
      mode: BargeInMode;
      speaker: SpeakerRole;
      speechRunMs: number;
      /** A song is playing: only an addressed utterance counts. */
      music: boolean;
      thresholds: BargeThresholds;
    }
  /** What ASR returned for one of their utterances. */
  | {
      stage: "asr";
      mode: BargeInMode;
      speaker: SpeakerRole;
      text: string;
      /** The transcript says her name. */
      named: boolean;
      /** It is an echo of the ASR prompt or of her own voice. */
      echo: boolean;
      music: boolean;
    };

/**
 * `none`: nothing to do; `duck` / `pause`: lower her volume / hold her line; `stop`: end it;
 * `resume`: whatever `duck` / `pause` did is undone.
 */
export type BargeDecision = {
  action: "none" | "duck" | "pause" | "stop" | "resume";
  reason: VoiceBargeInReason;
};

/**
 * The rule. At the VAD stage: the focus person pauses her (and stops her when they keep
 * going), anybody else ducks her, a song or `ignore` does nothing, and the legacy `stop` mode
 * stops for anyone. At the ASR stage: an echo is not speech; her name stops her; the focus
 * person's real content stops her (a short reply does not); everything else resumes her.
 */
export function decideBargeIn(facts: BargeFacts): BargeDecision {
  if (facts.mode === "ignore") return { action: "none", reason: "other" };
  if (facts.stage === "vad") {
    if (facts.music) return { action: "none", reason: "music" };
    const { duckMs, pauseMs, focusStopMs } = facts.thresholds;
    if (facts.mode === "stop") {
      return facts.speechRunMs >= pauseMs
        ? { action: "stop", reason: "legacy" }
        : { action: "none", reason: "legacy" };
    }
    if (facts.speaker === "focus") {
      if (facts.speechRunMs >= focusStopMs) return { action: "stop", reason: "focus" };
      if (facts.speechRunMs >= pauseMs) return { action: "pause", reason: "focus" };
      return { action: "none", reason: "focus" };
    }
    const reason = facts.speaker === "other" ? "other" : "no_focus";
    return facts.speechRunMs >= duckMs ? { action: "duck", reason } : { action: "none", reason };
  }
  if (facts.mode === "stop") return { action: "none", reason: "legacy" };
  if (facts.echo) return { action: "resume", reason: "echo" };
  if (facts.named) return { action: "stop", reason: "name" };
  if (facts.music) return { action: "resume", reason: "music" };
  if (facts.speaker === "focus") {
    return isShortReply(facts.text)
      ? { action: "resume", reason: "short_reply" }
      : { action: "stop", reason: "substantive" };
  }
  return { action: "resume", reason: facts.speaker === "other" ? "other" : "no_focus" };
}

// ---- the playback side ----------------------------------------------------------------------

/**
 * A playback barge-in can act on. The volume and pause controls return whether the voice node
 * supports them (older nodes do not); without them, ducking does nothing and a pause becomes a
 * stop.
 */
export interface BargeTarget extends Stoppable {
  duck?(gain: number, fadeMs: number): boolean;
  pause?(fadeMs: number): boolean;
  resume?(fadeMs: number): boolean;
}

/** What is playing, for the `voice.barge_in` records. */
export interface PlaybackInfo {
  context: ContextKey;
  turn: TurnId | null;
}

/** Who talked, what the turn in flight looks like from where they sit. */
export interface BargeWho {
  speaker: AccountRef;
  role: SpeakerRole;
  context: ContextKey;
  /** The turn in flight, if known. */
  turn: { id: TurnId; phase: TurnPhase } | null;
  /** A song is playing. */
  music?: boolean;
}

/** An ASR transcript of somebody's utterance. */
export interface BargeVerdict extends BargeWho {
  text: string;
  named: boolean;
  echo: boolean;
}

export interface BargeOptions {
  /** Ducking starts after this much talking. Default 250 (at most the pause threshold). */
  duckMs: number;
  /** Volume while ducked, 0..1. Default 0.3. */
  duckGain: number;
  duckFadeMs: number;
  /** The focus person who talks this long stops her. Default 3000. */
  focusStopMs: number;
  /** Without an utterance this long after somebody stopped talking, they are let go. */
  settleMs: number;
  /** ASR has this long to return a transcript before the hold is let go. */
  asrTimeoutMs: number;
  /** Fade of pausing and resuming. Default 120. */
  pauseFadeMs: number;
  /** How long a stop is remembered for the turn's later lines. Default 30 000. */
  stopMemoryMs: number;
  /** Publishes the `voice.barge_in` record. */
  publish: (record: VoiceBargeIn) => void;
}

export const DEFAULT_BARGE_OPTIONS: Readonly<BargeOptions> = Object.freeze({
  duckMs: 250,
  duckGain: 0.3,
  duckFadeMs: 120,
  focusStopMs: 3_000,
  settleMs: 1_200,
  asrTimeoutMs: 6_000,
  pauseFadeMs: 120,
  stopMemoryMs: 30_000,
  publish: () => undefined,
});

type Level = "none" | "duck" | "pause";

interface Hold {
  speaker: AccountRef | null;
  role: SpeakerRole;
  level: "duck" | "pause";
  /** `speaking`: still talking; `settling`: stopped, waiting for the utterance; `asr`: waiting for the transcript. */
  phase: "speaking" | "settling" | "asr";
  timer: ReturnType<typeof setTimeout> | null;
}

interface Active {
  token: number;
  handle: BargeTarget;
  info: PlaybackInfo | null;
  stopped: boolean;
  duckApplied: boolean;
  paused: boolean;
}

interface GuildBarge {
  active: Active | null;
  holds: Map<string, Hold>;
  /** Turns whose speech was stopped, until when. */
  stopped: Map<TurnId, number>;
  level: Level;
}

/**
 * Tracks her current playback per guild and decides, from who is talking (and later what they
 * said), whether to duck, pause, resume or stop it.
 */
export class BargeIn {
  readonly #mode: BargeInMode;
  readonly #thresholds: BargeThresholds;
  readonly #fadeMs: number;
  readonly #o: BargeOptions;
  readonly #guilds = new Map<string, GuildBarge>();
  readonly #now: () => number;
  #next = 1;

  /**
   * `thresholdMs`: how long somebody must talk over her before she pauses / stops; `fadeMs`:
   * fade of a stop.
   */
  constructor(
    mode: BargeInMode,
    thresholdMs: number,
    fadeMs: number,
    options: Partial<BargeOptions> = {},
    now: () => number = Date.now,
  ) {
    this.#mode = mode;
    this.#fadeMs = fadeMs;
    this.#o = { ...DEFAULT_BARGE_OPTIONS, ...options };
    this.#thresholds = {
      duckMs: Math.min(this.#o.duckMs, thresholdMs),
      pauseMs: thresholdMs,
      focusStopMs: Math.max(thresholdMs, this.#o.focusStopMs),
    };
    this.#now = now;
  }

  get mode(): BargeInMode {
    return this.#mode;
  }

  #guild(guild: string): GuildBarge {
    let g = this.#guilds.get(guild);
    if (!g) {
      g = { active: null, holds: new Map(), stopped: new Map(), level: "none" };
      this.#guilds.set(guild, g);
    }
    return g;
  }

  /**
   * Registers the playback now running in `guild`. Returns a token for `unregister`. A hold that
   * is in force (somebody is talking) applies to it at once.
   */
  register(guild: string, handle: BargeTarget, info: PlaybackInfo | null = null): number {
    const g = this.#guild(guild);
    const token = this.#next++;
    g.active = { token, handle, info, stopped: false, duckApplied: false, paused: false };
    g.level = "none";
    this.#sync(guild, g, null, "other");
    return token;
  }

  unregister(guild: string, token: number): void {
    const g = this.#guilds.get(guild);
    if (g?.active?.token === token) {
      g.active = null;
      g.level = "none";
    }
  }

  /** The speech of `turn` in `guild` was stopped by barge-in (recently). */
  isStopped(guild: string, turn: TurnId | null): boolean {
    if (turn === null) return false;
    const g = this.#guilds.get(guild);
    const until = g?.stopped.get(turn);
    if (until === undefined) return false;
    if (until < this.#now()) {
      g?.stopped.delete(turn);
      return false;
    }
    return true;
  }

  /**
   * Reports that a consented, non-self participant in `guild` has been speaking for
   * `speechRunMs`. Returns whether this stopped a playback. Without `who` the speaker is
   * unknown.
   */
  observe(guild: string, speechRunMs: number, who?: BargeWho): boolean {
    if (this.#mode === "ignore") return false;
    const g = this.#guilds.get(guild);
    const a = g?.active;
    if (!g || !a || a.stopped) return false;
    const key = holdKey(who?.speaker ?? null);
    const hold = g.holds.get(key);
    if (hold && hold.phase !== "speaking" && speechRunMs > 0) {
      hold.phase = "speaking";
      clearHoldTimer(hold);
    }
    const d = decideBargeIn({
      stage: "vad",
      mode: this.#mode,
      speaker: who?.role ?? "unknown",
      speechRunMs,
      music: who?.music ?? false,
      thresholds: this.#thresholds,
    });
    switch (d.action) {
      case "stop":
        this.#stop(guild, g, who ?? null, d.reason);
        return true;
      case "duck":
      case "pause": {
        const level = d.action;
        if (hold) {
          if (level === "pause" && hold.level === "duck") {
            hold.level = "pause";
            this.#sync(guild, g, who?.speaker ?? null, d.reason, who);
          }
        } else {
          g.holds.set(key, {
            speaker: who?.speaker ?? null,
            role: who?.role ?? "unknown",
            level,
            phase: "speaking",
            timer: null,
          });
          this.#sync(guild, g, who?.speaker ?? null, d.reason, who);
        }
        return false;
      }
      default:
        return false;
    }
  }

  /** The speaker stopped talking (their voice activity ended). */
  speechEnded(guild: string, speaker: AccountRef): void {
    const g = this.#guilds.get(guild);
    const hold = g?.holds.get(holdKey(speaker));
    if (!g || !hold || hold.phase !== "speaking") return;
    hold.phase = "settling";
    this.#arm(guild, g, holdKey(speaker), hold, this.#o.settleMs);
  }

  /** The speaker's utterance went to ASR: wait for the transcript. */
  utterance(guild: string, speaker: AccountRef): void {
    const g = this.#guilds.get(guild);
    const hold = g?.holds.get(holdKey(speaker));
    if (!g || !hold || hold.phase === "speaking") return;
    hold.phase = "asr";
    this.#arm(guild, g, holdKey(speaker), hold, this.#o.asrTimeoutMs);
  }

  /** ASR returned a transcript: stop her, or let whatever it did go. */
  verdict(guild: string, v: BargeVerdict): BargeDecision {
    const d = decideBargeIn({
      stage: "asr",
      mode: this.#mode,
      speaker: v.role,
      text: v.text,
      named: v.named,
      echo: v.echo,
      music: v.music ?? false,
    });
    const g = this.#guilds.get(guild);
    if (!g) return d;
    if (d.action === "stop") {
      this.#stop(guild, g, v, d.reason);
    } else if (d.action === "resume") {
      this.#release(guild, g, holdKey(v.speaker), v.speaker, d.reason);
    }
    return d;
  }

  /** The utterance never became a transcript (dropped, failed): let the speaker go. */
  dropped(guild: string, speaker: AccountRef, reason: VoiceBargeInReason): void {
    const g = this.#guilds.get(guild);
    if (!g) return;
    this.#release(guild, g, holdKey(speaker), speaker, reason);
  }

  /** Clears every timer (module stop). */
  close(): void {
    for (const g of this.#guilds.values()) for (const h of g.holds.values()) clearHoldTimer(h);
    this.#guilds.clear();
  }

  #arm(guild: string, g: GuildBarge, key: string, hold: Hold, ms: number): void {
    clearHoldTimer(hold);
    hold.timer = setTimeout(() => {
      hold.timer = null;
      this.#release(guild, g, key, hold.speaker, "timeout");
    }, ms);
    hold.timer.unref?.();
  }

  #release(
    guild: string,
    g: GuildBarge,
    key: string,
    speaker: AccountRef | null,
    reason: VoiceBargeInReason,
  ): void {
    const hold = g.holds.get(key);
    if (!hold) return;
    clearHoldTimer(hold);
    g.holds.delete(key);
    this.#sync(guild, g, speaker, reason);
  }

  #stop(guild: string, g: GuildBarge, who: BargeWho | null, reason: VoiceBargeInReason): void {
    const a = g.active;
    const turn = a?.info?.turn ?? who?.turn?.id ?? null;
    const speaking = a !== null || who?.turn?.phase === "speaking";
    const context = a?.info?.context ?? who?.context ?? null;
    for (const h of g.holds.values()) clearHoldTimer(h);
    g.holds.clear();
    g.level = "none";
    if (a && !a.stopped) {
      a.stopped = true;
      log.info({ guild, reason, account: who?.speaker.id }, "barge-in: stopping playback");
      a.handle.stop(this.#fadeMs);
    } else if (!speaking) {
      return; // She is not speaking: nothing was interrupted.
    }
    if (turn !== null) g.stopped.set(turn, this.#now() + this.#o.stopMemoryMs);
    if (context !== null) {
      this.#o.publish({
        context,
        turn,
        account: who?.speaker ?? null,
        action: "stop",
        reason,
      });
    }
  }

  /** Brings the playback to the level the holds ask for and records the change. */
  #sync(
    guild: string,
    g: GuildBarge,
    speaker: AccountRef | null,
    reason: VoiceBargeInReason,
    who?: BargeWho,
  ): void {
    const a = g.active;
    if (!a || a.stopped) return;
    let level: Level = "none";
    for (const h of g.holds.values()) {
      if (h.level === "pause") level = "pause";
      else if (level === "none") level = "duck";
    }
    const wantDuck = level !== "none";
    const wantPause = level === "pause";
    if (wantDuck && !a.duckApplied) {
      a.handle.duck?.(this.#o.duckGain, this.#o.duckFadeMs);
      a.duckApplied = true;
    }
    if (wantPause && !a.paused) {
      if (a.handle.pause?.(this.#o.pauseFadeMs) === true) {
        a.paused = true;
      } else {
        // The node cannot pause: what the focus person's speech asks for is what always
        // happened, a stop.
        this.#stop(guild, g, who ?? null, reason);
        return;
      }
    }
    if (!wantPause && a.paused) {
      a.handle.resume?.(this.#o.pauseFadeMs);
      a.paused = false;
    }
    if (!wantDuck && a.duckApplied) {
      a.handle.duck?.(1, this.#o.duckFadeMs);
      a.duckApplied = false;
    }
    if (level === g.level) return;
    g.level = level;
    const action: VoiceBargeInAction =
      level === "pause" ? "pause" : level === "duck" ? "duck" : "resume";
    const context = a.info?.context ?? who?.context ?? null;
    if (context === null) return;
    this.#o.publish({
      context,
      turn: a.info?.turn ?? who?.turn?.id ?? null,
      account: speaker,
      action,
      reason,
    });
  }
}

function holdKey(speaker: AccountRef | null): string {
  return speaker === null ? "?" : accountRefString(speaker);
}

function clearHoldTimer(hold: Hold): void {
  if (hold.timer !== null) clearTimeout(hold.timer);
  hold.timer = null;
}
