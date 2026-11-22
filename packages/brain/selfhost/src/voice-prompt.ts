// The prompt of a voice run: the text host's blocks (`HostPrompt`), so a voice request opens with
// the same prefix as a text one, and the voice pieces on the volatile side (block 7): who is in
// the voice channel and who is talking right now, and the style note as the old voice turn wrote
// it (lorebook entries for speech, no kaomoji). Its slow sources are read warm (`VoiceReads`):
// nothing that does not depend on the line is waited for, the rest only `live_context_ms`.

import type { ContentPart } from "@miyoria/llm/llm";
import type { SpeakerNames } from "@miyoria/memory/transcript";
import {
  AffectStateKey,
  type ContextKey,
  nameKey,
  SelfStateKey,
  type VoiceParticipant,
} from "@miyoria/types";
import {
  type Agent,
  MOOD_MIN,
  readWarm,
  SCAN_LINES,
  styleNote,
  triggeredEntries,
  Warm,
} from "../../agent/src/index.js";
import type { PromptInput, PromptSource } from "../../self/src/index.js";
import type { SpeakerNaming } from "../../self/src/prompt.js";
import { moodStyle, type SlowReads, type WarmSlot } from "./prompt.js";
import { roomLines } from "./voice-texts.js";

/** What the voice prompt knows of a voice channel. */
export interface VoiceRoom {
  /** Who is there, her not included. */
  members(context: ContextKey): readonly VoiceParticipant[];
  /** The display names of who is talking right now. */
  speaking(context: ContextKey): readonly string[];
  /** The newest lines of other people there, oldest first. */
  recent(input: PromptInput, lines: number): readonly string[];
}

/** The values a voice channel keeps warm for its runs (the old turn's `WarmContext`). */
export class WarmValues {
  readonly #slots = new Map<WarmSlot, Warm<unknown>>();

  slot<T>(name: WarmSlot): Warm<T> {
    let warm = this.#slots.get(name);
    if (warm === undefined) {
      warm = new Warm<unknown>();
      this.#slots.set(name, warm);
    }
    return warm as Warm<T>;
  }
}

/**
 * How a voice run reads its slow sources (`[modules.agent.voice] warm_context`): the value kept
 * for the same key and the same listeners, or the load waited for `live_context_ms`. `null` when
 * `warm_context` is off: every source within its own limit, as in text.
 */
export function voiceReads(
  agent: Agent,
  kept: WarmValues,
  listeners: readonly VoiceParticipant[],
  signal: AbortSignal,
): SlowReads | null {
  const v = agent.config.voice;
  if (!v.warm_context) return null;
  // What the other places may show depends on who listens: a value made for others is not used.
  const heard = listeners
    .map((m) => `${m.account.platform}:${m.account.id}`)
    .sort()
    .join(",");
  return {
    voice: true,
    warmContributors: v.warm_contributors,
    liveMs: v.live_context_ms,
    warm: <T>(slot: WarmSlot, key: string, load: () => Promise<T>) =>
      readWarm(
        kept.slot<T>(slot),
        `${heard}|${key}`,
        {
          now: () => agent.ctx.clock.now(),
          maxAgeMs: v.warm_max_age_ms,
          waitMs: v.live_context_ms,
          signal,
        },
        load,
      ),
  };
}

/** The blocks of a run: the text host's, with block 7 of a voice run its own. */
export class VoicePrompt implements PromptSource, SpeakerNaming {
  readonly #agent: Agent;
  readonly #text: PromptSource & SpeakerNaming;
  readonly #room: VoiceRoom;

  constructor(agent: Agent, text: PromptSource & SpeakerNaming, room: VoiceRoom) {
    this.#agent = agent;
    this.#text = text;
    this.#room = room;
  }

  fixed(input: PromptInput): Promise<string | null> {
    return this.#text.fixed(input);
  }

  names(input: PromptInput): SpeakerNames | null {
    return this.#text.names?.(input) ?? null;
  }

  pinned(input: PromptInput): Promise<string | null> {
    return this.#text.pinned(input);
  }

  place(input: PromptInput): Promise<string | null> {
    return this.#text.place(input);
  }

  recalled(input: PromptInput): Promise<string | null> {
    return this.#text.recalled(input);
  }

  async attachments(input: PromptInput): Promise<ContentPart[]> {
    // Spoken, nothing is looked at: what was typed in the voice channel's chat is read as text.
    if (input.profile === "voice") return [];
    return (await this.#text.attachments?.(input)) ?? [];
  }

  async now(input: PromptInput): Promise<string | null> {
    const text = await this.#text.now(input);
    if (input.profile !== "voice") return text;
    const context = input.session.context;
    // Who is there by handle, with the name shown when it is another (it is what is said aloud).
    const members = this.#room.members(context).map((m) => {
      const handle = this.#agent.handleOf(m.account, m.display_name);
      return nameKey(handle) === nameKey(m.display_name) ? handle : `${handle}(${m.display_name})`;
    });
    const room = roomLines(members, this.#room.speaking(context));
    return text === null ? room : `${text}\n${room}`;
  }

  async style(input: PromptInput): Promise<string | null> {
    if (input.profile !== "voice") return (await this.#text.style?.(input)) ?? null;
    // The old voice turn's note: lorebook entries for speech, no kaomoji.
    const scan = this.#room.recent(input, SCAN_LINES).join("\n");
    const lore = triggeredEntries(this.#agent.persona.lorebook(), scan, this.#moods(), true);
    return styleNote(true, [], lore, moodStyle(this.#agent, true));
  }

  /** Her emotions now, by name: the tag she shows and the strongest ones she feels. */
  #moods(): Set<string> {
    const services = this.#agent.ctx.services;
    const moods = new Set<string>();
    try {
      const snap = services.get(AffectStateKey)?.snapshot() ?? null;
      const self = services.get(SelfStateKey) ?? null;
      const shown = snap !== null ? snap.shown : (self?.shown() ?? null);
      if (shown !== null) moods.add(shown.tag);
      const felt = snap !== null ? snap.top : (self?.emotions() ?? []);
      for (const e of felt.slice(0, 2)) if (e.intensity >= MOOD_MIN) moods.add(e.name);
    } catch {
      // No mood: the lorebook reads `neutral`.
    }
    if (moods.size === 0) moods.add("neutral");
    return moods;
  }
}
