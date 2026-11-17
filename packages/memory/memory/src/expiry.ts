// Present-tense notes go stale: 「答應玩 Minecraft 並開直播,已經開台」 was recalled 149 times, in
// every channel, long after the stream ended. A fact or note about a state or a commitment in
// progress gets an expiry; it is kept in the record's `due` (for kinds other than followups,
// `due` is "not true after this", and the record is no longer recalled then).

import type { MemoryKind } from "@miyoria/store";
import { type Timestamp, timestampMs, toTimestamp } from "@miyoria/types";
import type { MemoryConfig } from "./config.js";

const HOUR_MS = 3_600_000;

/** The longest lifetime the summarizer may give a note (hours). */
export const MAX_VALID_HOURS = 24 * 90;

/** Wordings of something that is true right now (progress, current state). */
const NOW_STATE =
  /已經(?:開台|開直播|上線|在)|已開台|開台中|直播中|正在|目前|現在|此刻|剛剛|剛才|還在(?:下載|開|玩|看|聽|唱|打|跑)|進行中|currently|right now|is live|streaming now/i;

/** Wordings of something soon over: today, tonight, in a moment. */
const SOON = /今天|今晚|今夜|等一下|待會|稍後|晚點|馬上|today|tonight|later/i;

/**
 * How long a statement stays true by its wording: present-tense states (`正在下載`, `已經開台`)
 * one `state_note_hours`, "today / in a moment" twice that, anything else `null` (no expiry).
 */
export function wordingTtlHours(text: string, config: MemoryConfig): number | null {
  const base = config.state_note_hours;
  if (base <= 0) return null;
  if (NOW_STATE.test(text)) return base;
  if (SOON.test(text)) return base * 2;
  return null;
}

/**
 * When a new fact / self note stops being true: the lifetime the summarizer gave
 * (`validHours`), else the one its wording implies, else never (`null`). Episodes, followups
 * and the owner's own `remember` notes never expire this way.
 */
export function expiryOf(
  kind: MemoryKind,
  text: string,
  validHours: number | null,
  config: MemoryConfig,
  now: Timestamp,
): Timestamp | null {
  if (kind !== "fact" && kind !== "self_note") return null;
  const hours =
    validHours !== null && validHours > 0
      ? Math.min(MAX_VALID_HOURS, validHours)
      : wordingTtlHours(text, config);
  return hours === null ? null : toTimestamp(timestampMs(now) + hours * HOUR_MS);
}

/** True when a record that is not a followup is past its expiry. */
export function expired(
  record: { kind: MemoryKind; due: Timestamp | null },
  now: Timestamp,
): boolean {
  return (
    record.kind !== "followup" && record.due !== null && timestampMs(record.due) <= timestampMs(now)
  );
}

/**
 * Wordings of what is happening right now (V3 §11: the state machine answers those, long-term
 * memory never holds them). Narrower than `NOW_STATE`: 「目前」 and 「現在」 also open lasting
 * facts (「我現在住在台北」), so they only give a note an expiry, they do not keep it out.
 */
const PRESENT_STATE =
  /已經(?:開台|開直播|上線|在)|已開台|開台中|直播中|正在|此刻|剛剛|剛才|還在(?:下載|開|玩|看|聽|唱|打|跑)|進行中|currently|right now|is live|streaming now/i;

/** True when `text` says what is happening right now. */
export function isPresentState(text: string): boolean {
  return PRESENT_STATE.test(text);
}

/**
 * True when the summarizer said a statement stays true only for a moment (at most
 * `state_note_hours`): a state in progress, whatever its wording.
 */
export function isStateLifetime(validHours: number | null, config: MemoryConfig): boolean {
  return validHours !== null && validHours > 0 && validHours <= config.state_note_hours;
}
