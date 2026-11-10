// One-time repair of data polluted before handles were stable (docs/design/v2-architecture.md
// §1.6): lessons, conversation recaps and notes, and agenda text were written with per-call
// codes (`u7`, `p2`) that were handed out again on every call, so "u7 一直嗆我" later pointed at
// somebody else. The repair rewrites what can be resolved from the same record (a code defined
// in the same text, or the one person a lesson is about) and drops the sentence otherwise;
// it never guesses. Running it again changes nothing.
//
// It only edits text fields: `self:state` keeps its shape (its owner is the `self` module), and
// conversation states keep theirs. Run it before the modules that cache these records start,
// or their next save puts the old text back (`core/src/boot.ts` does).

import { errorMessage, getLogger } from "@miyoria/kernel";
import type { SettingsStore } from "@miyoria/store";
import {
  type ConversationState,
  ephemeralHandlesIn,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type PersonId,
  type ProfileId,
  repairHandleJson,
  repairHandleText,
} from "@miyoria/types";
import { parseState, STATE_PREFIX } from "./conversation.js";
import { LESSON_PREFIX } from "./lessons.js";
import { touchUnits } from "./threads.js";

const log = getLogger("learning.repair");

/** The `self` module's settings key (`@miyoria/self` `STATE_KEY`). */
const SELF_STATE_KEY = "self:state";

export interface RepairReport {
  /** Lessons rewritten / deleted (nothing left of their text). */
  lessons_fixed: number;
  lessons_dropped: number;
  /** Conversation states whose recap or notes were rewritten. */
  conversations: number;
  /** Agenda texts (`text` or `why`) rewritten. */
  agenda: number;
  /** Rows that could not be read or written (left as they were). */
  errors: number;
}

export interface RepairOptions {
  settings: SettingsStore;
  profile: ProfileId;
  /** A person's handle, when known: the one code a lesson about them still has is theirs. */
  handleOfPerson?: (person: PersonId) => string | null;
}

/** `text` with every per-call code replaced by 「某人」 (marked, not guessed). */
export function maskCodes(text: string): string {
  let out = text;
  for (const code of ephemeralHandlesIn(text)) {
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${code}(?![A-Za-z0-9_])`, "g"), "某人");
  }
  return out;
}

export function emptyReport(): RepairReport {
  return { lessons_fixed: 0, lessons_dropped: 0, conversations: 0, agenda: 0, errors: 0 };
}

export function repairedAnything(r: RepairReport): boolean {
  return r.lessons_fixed + r.lessons_dropped + r.conversations + r.agenda > 0;
}

async function repairLessons(o: RepairOptions, report: RepairReport): Promise<void> {
  const rows = await o.settings.list(o.profile, LESSON_PREFIX);
  for (const [key, value] of rows) {
    if (!isJsonObject(value) || typeof value.text !== "string") continue;
    if (ephemeralHandlesIn(value.text).length === 0) continue;
    const person = typeof value.person === "string" ? value.person : null;
    const sole = person === null ? null : (o.handleOfPerson?.(person) ?? null);
    const text = repairHandleText(value.text, { sole });
    try {
      if (text === null) {
        await o.settings.set(o.profile, key, null);
        report.lessons_dropped += 1;
      } else {
        await o.settings.set(o.profile, key, { ...value, text });
        report.lessons_fixed += 1;
      }
    } catch (error) {
      report.errors += 1;
      log.warn({ key, err: errorMessage(error) }, "cannot repair a lesson");
    }
  }
}

function dirty(value: JsonValue): boolean {
  return ephemeralHandlesIn(JSON.stringify(value)).length > 0;
}

async function repairConversations(o: RepairOptions, report: RepairReport): Promise<void> {
  const rows = await o.settings.list(o.profile, STATE_PREFIX);
  for (const [key, value] of rows) {
    const state = parseState(value);
    if (!state || !(dirty(state.recap) || dirty(state.notes))) continue;
    const recap = repairHandleText(state.recap) ?? "";
    const notes = (repairHandleJson(state.notes) ?? {}) as JsonObject;
    const next: ConversationState = {
      ...state,
      recap,
      notes,
      // Ages carry over to the rewritten units (the ids are hashes of the text).
      touched: touchUnits(state, notes, state.updated_at, state.updated_at),
    };
    try {
      await o.settings.set(o.profile, key, JSON.parse(JSON.stringify(next)) as JsonValue);
      report.conversations += 1;
    } catch (error) {
      report.errors += 1;
      log.warn({ key, err: errorMessage(error) }, "cannot repair a conversation state");
    }
  }
}

async function repairAgenda(o: RepairOptions, report: RepairReport): Promise<void> {
  const value = await o.settings.get(o.profile, SELF_STATE_KEY);
  if (!isJsonObject(value) || !Array.isArray(value.agenda)) return;
  let changed = 0;
  const agenda = value.agenda.map((item) => {
    if (!isJsonObject(item)) return item;
    const out: JsonObject = { ...item };
    let touched = false;
    for (const field of ["text", "why"] as const) {
      const text = item[field];
      if (typeof text !== "string" || ephemeralHandlesIn(text).length === 0) continue;
      // The agenda's `person` is not trusted to say who a code meant (an item about Owen was
      // once bound to someone else's id): use only what the text itself defines, else mark it.
      const fixed = repairHandleText(text);
      out[field] = fixed ?? (field === "text" ? maskCodes(text) : "");
      touched = true;
    }
    if (touched) changed += 1;
    return out;
  });
  if (changed === 0) return;
  try {
    await o.settings.set(o.profile, SELF_STATE_KEY, { ...value, agenda });
    report.agenda += changed;
  } catch (error) {
    report.errors += 1;
    log.warn({ err: errorMessage(error) }, "cannot repair the agenda");
  }
}

/**
 * Repairs lessons, conversation recaps / notes and agenda text of `profile` that carry
 * per-call codes. Idempotent; failures of single rows are counted, never thrown.
 */
export async function repairEphemeralHandles(o: RepairOptions): Promise<RepairReport> {
  const report = emptyReport();
  for (const step of [repairLessons, repairConversations, repairAgenda]) {
    try {
      await step(o, report);
    } catch (error) {
      report.errors += 1;
      log.warn({ err: errorMessage(error) }, "handle repair step failed");
    }
  }
  if (repairedAnything(report)) log.info(report, "repaired text with per-call codes");
  return report;
}
