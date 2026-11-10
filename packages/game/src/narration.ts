// What her game narration is about: a stable key per thing that happened, so saying it again in
// other words is still the same thing (a stop-gap for v3 §6 `attention_key`). This file only
// names things; the Arbiter decides whether a key may be said (`Impulse.attention`).
//
// Most repetition on 2026-11-07 was not game events: the decision loop's free-text commentary
// kept bringing up the same thing. So a free line takes the key of what it is about (`keyOf`): an
// earlier fact or line it resembles, else a key of its own.
//
// A line without a key is one the Arbiter must not limit as narration: urgent events and results
// someone asked for. Those never come through here.

import {
  gameEventKey,
  gameEventSubject,
  gameGoalKey,
  gameRemarkKey,
  type Impulse,
  type JsonObject,
  NOTED_GAME_EVENTS,
  similarLines,
} from "@miyoria/types";
import type { ActionCall } from "./decision.js";

/** What a line of narration is about (`Impulse.attention`). */
export type About = NonNullable<Impulse["attention"]>;

/** Facts and lines remembered for `keyOf`. */
const MAX_TOPICS = 64;
/** Her recent lines shown to the decision model. */
const MAX_LINES = 6;

/** Whether two short lines are about the same thing (`similarLines`). */
export const similar = similarLines;

/** The key of a game event (`gameEventKey`, shared with the V3 fact layer). */
export const eventKey = gameEventKey;

/** The key of a goal she reached (`gameGoalKey`, shared with the V3 fact layer). */
export function goalKey(text: string, action: ActionCall | null): string {
  return gameGoalKey(text, action);
}

/** Whether `kind` (or `kind:subject`, like `reflex:lava`) is in `events`. */
export function matchesEvent(
  events: readonly string[],
  kind: string,
  data: JsonObject | null,
): boolean {
  return events.includes(kind) || events.includes(`${kind}:${gameEventSubject(data)}`);
}

/** Whether an event is worth remembering as something she may talk about. */
export function isNoted(kind: string, important: boolean): boolean {
  return important || NOTED_GAME_EVENTS.includes(kind);
}

interface Topic {
  key: string;
  text: string;
}

/**
 * The director's memory of what there is to talk about. It outlives a session (the same world
 * comes back after a restart of the game), not the process.
 */
export class Narration {
  #topics: Topic[] = [];
  #lines: string[] = [];

  /** `text` is about `key`. */
  note(key: string, text: string): void {
    this.#topics = [...this.#topics.filter((t) => t.text !== text), { key, text }].slice(
      -MAX_TOPICS,
    );
  }

  /** The key of a free line: of the newest topic it resembles, else its own. */
  keyOf(text: string): string {
    for (const t of [...this.#topics].reverse()) if (similar(text, t.text)) return t.key;
    return gameRemarkKey(text);
  }

  /** She was told to say `text` (about `key`). */
  said(key: string, text: string): void {
    this.note(key, text);
    this.#lines = [...this.#lines.filter((l) => l !== text), text].slice(-MAX_LINES);
  }

  /** What she was told to say lately, oldest first. */
  lines(): string[] {
    return [...this.#lines];
  }
}
