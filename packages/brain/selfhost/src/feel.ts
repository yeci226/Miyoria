// Her `<feel>` blocks of a run, applied once the run ended (docs/design/v5-heart.md §2.1, §2.9).
//
// The runner swallowed the blocks and gave them in `RunResult.feel`. Here they are read
// (`parseFeel`), each name is matched to one of the people present in the place the way an `@name`
// is (`nameMatcher`: case, the cleaned name, the handle, what she calls them, a unique first word), and the turn's caps
// are kept (two people, three lines). Blocked people and her own accounts are never among them. Her
// own emotion goes to the emotion engine through the entry Appraise uses (`AffectState.appraise`),
// her proposals to the heart (`HeartPeople.feel`, which writes each change with the turn's id),
// and a line of what she felt to her journal (`MindKey.note`, the panel's "內心" page).
// What does not read, names nobody or is over the caps is dropped and counted in a debug line,
// never an error.

import type { TranscriptEntry } from "@miyoria/memory/transcript";
import type { Logger } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  type AffectState,
  AffectStateKey,
  type ContextKey,
  FEEL_FIELD_WORDS,
  FEEL_STRENGTH_WORDS,
  type FeelProposal,
  type Handle,
  HeartKey,
  type HeartPeople,
  type IncomingMessage,
  type Mind,
  MindKey,
  type PersonId,
  sameAccount,
  type TurnCancelCause,
  toTimestamp,
} from "@miyoria/types";
import type { Agent } from "../../agent/src/index.js";
import {
  type FeelLine,
  type FeelSelf,
  limitProposals,
  parseFeel,
  type Wake,
  wakeAuthor,
} from "../../self/src/index.js";
import { nameMatcher } from "./mentions.js";

/** Someone present in the place of a run. */
export interface FeelPerson {
  account: AccountRef;
  name: string;
}

/** What applying needs of the running system (the agent's, in production). */
export interface FeelDeps {
  /** The person behind an account; `null`: nobody she knows. */
  personOf(account: AccountRef): PersonId | null;
  /** Blocked, or one of her own accounts: never a target. */
  excluded(account: AccountRef): boolean;
  handleOf(account: AccountRef, name: string): Handle;
  /** What she calls them (稱呼), a name she may write for them; absent or `null`: none. */
  callName?(account: AccountRef): string | null;
  heart(): HeartPeople | null;
  affect(): AffectState | null;
  /** Her journal (`MindKey`); absent or `null`: nothing is noted. */
  journal?(): Pick<Mind, "note"> | null;
  log: Pick<Logger, "debug">;
  now(): number;
}

export function feelDeps(agent: Agent): FeelDeps {
  return {
    personOf: (account) => agent.attitude(account)?.person ?? null,
    excluded: (account) => agent.isBlocked(account) || agent.isSelf(account),
    handleOf: (account, name) => agent.handleOf(account, name),
    callName: (account) => agent.attitude(account)?.call_name ?? null,
    heart: () => agent.ctx.services.get(HeartKey) ?? null,
    affect: () => agent.ctx.services.get(AffectStateKey) ?? null,
    journal: () => agent.ctx.services.get(MindKey) ?? null,
    log: agent.log,
    now: () => agent.ctx.clock.now(),
  };
}

export interface FeelInput {
  turn: string;
  context: ContextKey;
  wake: Wake;
  /** `RunResult.feel`. */
  feel: readonly string[];
  /** The people present: who may be named. */
  people: readonly FeelPerson[];
  /** The line the run answered (`answeredLine`), for the cause of her emotion; `null`: none. */
  line: AnsweredLine | null;
}

/** The line a run answered and who said it. */
export interface AnsweredLine {
  /** Who said it; `null`: not known. */
  account: AccountRef | null;
  name: string;
  text: string;
}

/**
 * The cause of her emotion in a DM: the emotion engine keeps it and the prompt shows it wherever
 * she is, so a line from a DM is never repeated as the cause.
 */
export const DM_CAUSE = "私訊裡的事";

/** One proposal as applied. */
export interface FeelApplied extends FeelProposal {
  person: PersonId;
  /** The name of the person present it matched. */
  name: string;
}

export interface FeelOutcome {
  self: FeelSelf | null;
  /** Whether her emotion went to the engine. */
  felt: boolean;
  proposals: FeelApplied[];
  /** Changes the heart wrote. */
  applied: number;
  /** Lines whose name is nobody present (or more than one). */
  unmatched: number;
  /** Lines that did not read (an unknown value or emotion word, no quote, no shape). */
  unreadable: number;
  /** Lines over the turn's caps. */
  over: number;
}

/** The longest cause of her emotion kept (characters). */
const MAX_CAUSE = 60;

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : flat;
}

/** What her emotion of the run is about: the line she answered, else what woke her. */
export function feelCause(wake: Wake, line: string | null, quote: string | null): string {
  if (line !== null && line.trim() !== "") return cut(line, MAX_CAUSE);
  switch (wake.kind) {
    case "world":
      return cut(wake.what, MAX_CAUSE);
    case "timer":
      return cut(wake.note, MAX_CAUSE);
    case "result":
      return cut(`${wake.tool} 的結果`, MAX_CAUSE);
    default:
      return quote === null ? "剛剛的對話" : cut(quote, MAX_CAUSE);
  }
}

/**
 * The line a run answered: the newest line that called her, or for a glance the newest line of
 * someone else; `null` for a run nobody's line woke.
 */
export function answeredLine(
  wake: Wake,
  inputs: readonly IncomingMessage[],
  entries: readonly TranscriptEntry[],
): AnsweredLine | null {
  const last = inputs.at(-1);
  if (last !== undefined) {
    return { account: last.author.account, name: last.author.display_name, text: last.text };
  }
  if (wake.kind !== "addressed" && wake.kind !== "glance") return null;
  const other = entries.findLast((e) => e.kind === "other" && e.redacted_at === null);
  return other === undefined
    ? null
    : { account: other.account, name: other.author ?? "", text: other.content };
}

/**
 * The words of `line` as the cause of her emotion toward `from` (`名字: 內容`): only a line `from`
 * said themselves, and never one in a DM (the emotion engine shows its causes wherever she is).
 */
export function causeLine(
  context: ContextKey,
  line: AnsweredLine | null,
  from: { account: AccountRef } | null,
): string | null {
  if (context.kind === "dm" || line === null || from === null || line.account === null) return null;
  return sameAccount(line.account, from.account) ? `${line.name}: ${line.text}` : null;
}

/**
 * Whether the feel of a run that ended is applied. A run cut for a restart (`input`: the person it
 * answers said more before it said anything) is not: the restarted run answers the same lines and
 * writes its own, so applying both would count one exchange twice. Every other run that ended,
 * cancelled or not, is applied with what it wrote.
 */
export function feelApplies(run: { cancel: { cause: TurnCancelCause } | null }): boolean {
  return run.cancel?.cause !== "input";
}

/** Reads the blocks and matches their names; applies nothing. */
export function readFeel(
  deps: Pick<FeelDeps, "personOf" | "excluded" | "handleOf" | "callName">,
  feel: readonly string[],
  people: readonly FeelPerson[],
): Omit<FeelOutcome, "felt" | "applied"> {
  let self: FeelSelf | null = null;
  const lines: FeelLine[] = [];
  let unreadable = 0;
  for (const block of feel) {
    const parsed = parseFeel(block);
    // Steps come in order: what she feels at the end of the run is the last step's.
    if (parsed.self !== null) self = parsed.self;
    lines.push(...parsed.lines);
    unreadable += parsed.dropped.length;
  }
  const targets: { name: string; aliases: string[]; key: string }[] = [];
  const seen: AccountRef[] = [];
  for (const p of people) {
    if (seen.some((a) => sameAccount(a, p.account)) || deps.excluded(p.account)) continue;
    seen.push(p.account);
    const person = deps.personOf(p.account);
    if (person === null) continue;
    const aliases = [deps.handleOf(p.account, p.name)];
    const call = deps.callName?.(p.account) ?? null;
    if (call !== null) aliases.push(call);
    targets.push({ name: p.name, aliases, key: person });
  }
  const match = nameMatcher(targets);
  const matched: FeelApplied[] = [];
  let unmatched = 0;
  for (const line of lines) {
    const person = match(line.name);
    if (person === null) {
      unmatched += 1;
      continue;
    }
    const name = targets.find((t) => t.key === person)?.name ?? line.name;
    matched.push({
      person,
      name,
      field: line.field,
      direction: line.direction,
      quote: line.quote,
    });
  }
  const { kept, over } = limitProposals(matched);
  return { self, proposals: kept, unmatched, unreadable, over };
}

const STRENGTH_WORDS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(FEEL_STRENGTH_WORDS).map(([word, strength]) => [strength, word]),
);

/**
 * Her journal's line for a feel block: her emotion as she wrote it (`開心 中`) and one line per
 * proposal kept (`小明 羈絆 +「他記得」`). What the heart's caps did to them is the heart's log.
 */
export function journalEntry(read: Pick<FeelOutcome, "self" | "proposals">): {
  text: string;
  changes: string[];
} {
  const self = read.self;
  const text = self === null ? "" : `${self.word} ${STRENGTH_WORDS[self.strength] ?? ""}`.trim();
  const changes = read.proposals.map(
    (p) =>
      `${p.name} ${FEEL_FIELD_WORDS[p.field]} ${p.direction === "up" ? "+" : "-"}「${p.quote}」`,
  );
  return { text: text === "" ? (changes[0] ?? "") : text, changes };
}

/** Applies her feel blocks of the run of `input.turn`. */
export function applyFeel(deps: FeelDeps, input: FeelInput): FeelOutcome {
  const read = readFeel(deps, input.feel, input.people);
  let felt = false;
  const affect = read.self?.emotion ? deps.affect() : null;
  if (read.self?.emotion && affect !== null) {
    const from = wakeAuthor(input.wake);
    const toward = from === null ? null : deps.handleOf(from.account, from.name);
    const cause =
      input.context.kind === "dm"
        ? DM_CAUSE
        : feelCause(
            input.wake,
            causeLine(input.context, input.line, from),
            read.proposals[0]?.quote ?? null,
          );
    affect.appraise({
      source: "feel",
      events: [{ emotion: read.self.emotion, strength: read.self.strength, toward, cause }],
      context: input.context,
      at: toTimestamp(deps.now()),
    });
    felt = true;
  }
  let applied = 0;
  const heart = read.proposals.length > 0 ? deps.heart() : null;
  if (heart !== null) {
    const byPerson = new Map<PersonId, FeelProposal[]>();
    for (const p of read.proposals) {
      const list = byPerson.get(p.person) ?? [];
      list.push({ field: p.field, direction: p.direction, quote: p.quote });
      byPerson.set(p.person, list);
    }
    for (const [person, proposals] of byPerson) {
      applied += heart.feel(person, proposals, { turn: input.turn, now: deps.now() });
    }
  }
  const outcome: FeelOutcome = { ...read, felt, applied };
  if (read.self !== null || read.proposals.length > 0) {
    deps.journal?.()?.note?.({ kind: "feel", ...journalEntry(read), context: input.context });
  }
  if (input.feel.length > 0) {
    deps.log.debug(
      {
        turn: input.turn,
        emotion: read.self?.emotion ?? null,
        felt,
        proposals: read.proposals.length,
        applied,
        unmatched: read.unmatched,
        unreadable: read.unreadable,
        over: read.over,
      },
      "feel applied",
    );
  }
  return outcome;
}
