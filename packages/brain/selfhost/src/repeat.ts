// What the old path held back of her own starts, asked of each line of hers on the new runner
// before it goes to the mouth (`MouthOutlet`); a refusal goes back to her as the line's reason:
//
// - A repeat (the Floor's `check` for a `wish`, arbiter/floor.ts): a line of a start of hers that
//   says what she said in that place lately (`DeliveryLedger.saidLately`: `similarLines`, its
//   30-minute window) is not said again.
// - A wish that is done (the Arbiter's `#wish` and `MainTurn.take`, arbiter/arbiter.ts,
//   agent/mainline/main.ts): a line of a start of hers (`wish` or `notable`) about something she
//   wanted to ask one of the people of that place is screened by the wish book (`Wishes.screen`,
//   `sameWish`): answered, told to stop, asked twice, or asked and not yet `followup_hours` ago, it
//   does not go out, with the book's reason.
//
// Lines she owes someone (an answer, a result) and a glance's lines are not checked, as before.

import type { TranscriptEntry } from "@miyoria/memory/transcript";
import {
  type AccountRef,
  accountRefString,
  type ContextKey,
  DeliveryLedgerKey,
  type FloorClaimKind,
  type Handle,
  type MessageRef,
  namedIn,
  type PersonCandidate,
  sameAccount,
  WishesKey,
} from "@miyoria/types";
import type { Agent } from "../../agent/src/index.js";
import {
  floorKind,
  type OutgoingLine,
  sayKind,
  type Wake,
  type WakeAuthor,
  wakeAuthor,
} from "../../self/src/index.js";
import type { OutletClaims } from "./outlet.js";
import { speakersOf } from "./prompt.js";
import { REPEATED_LINE } from "./texts.js";

/** How many of the people who spoke in a place `@name` may link. */
const KNOWN_PEOPLE = 50;

/** What the host knows that the outlet's claims need. */
export interface ClaimsHost {
  /** What woke the text run of `turn`; `null`: no text run of the host. */
  wakeOf(turn: string): Wake | null;
  /** The transcript of `place` she sees. */
  entries(place: ContextKey): readonly TranscriptEntry[];
  /** The people the prompt blocks of the run of `turn` name (its people, block 7's); unset: none. */
  named?(turn: string): readonly { account: AccountRef; name: string }[];
  /** Who is in the voice channel of `place` with her; unset: nobody. */
  members?(place: ContextKey): readonly { account: AccountRef; name: string }[];
}

/** The outlet's claims (`OutletClaims`) for the text runs of a host. */
export function outletClaims(agent: Agent, host: ClaimsHost): OutletClaims {
  const people = (line: OutgoingLine): { account: AccountRef; name: string }[] => {
    // Who spoke there and whoever she answers, then who is in the voice channel there and
    // whoever this run's prompt names (in the place she speaks in).
    const out = knownPeople(host.entries(line.place), host.wakeOf(line.turn));
    const more = [
      ...(host.members?.(line.place) ?? []),
      ...(line.focus ? (host.named?.(line.turn) ?? []) : []),
    ];
    for (const p of more) {
      if (!out.some((o) => sameAccount(o.account, p.account))) {
        out.push({ account: p.account, name: p.name });
      }
    }
    return out.filter((p) => !agent.isBlocked(p.account) && !agent.isSelf(p.account));
  };
  return {
    kind(line: OutgoingLine): FloorClaimKind | null {
      const wake = host.wakeOf(line.turn);
      if (wake === null) return null;
      return line.focus ? floorKind(wake) : sayKind(wake);
    },
    audience(line: OutgoingLine): Handle[] | null {
      const wake = host.wakeOf(line.turn);
      if (wake === null) return null;
      const here = speakersOf(host.entries(line.place));
      const named = here.filter((s) => mentions(line.text, s));
      const asked = line.focus ? askers(wake) : [];
      const to = asked.length > 0 ? asked : named.length > 0 ? [] : here;
      const handles = [...to, ...named].map((s) => agent.handleOf(s.account, s.name));
      return [...new Set(handles)];
    },
    people,
    to(line: OutgoingLine, reply: MessageRef | null): Handle[] | null {
      const wake = host.wakeOf(line.turn);
      if (wake === null) return null;
      if (reply !== null) {
        // The author of the message it replies to: in the transcript, else whoever woke her.
        const parent = host.entries(line.place).find((e) => e.message_id === reply.id);
        const author =
          parent?.account != null
            ? { account: parent.account, name: parent.author ?? parent.account.id }
            : wake.kind === "addressed" && wake.message.id === reply.id
              ? wake.from
              : null;
        if (author !== null) return [agent.handleOf(author.account, author.name)];
      }
      // Whom it names: never the person of the turn only because the turn is theirs (2026-11-22:
      // a question to one person, sent after a reply to another, was taken as asked of the other).
      const candidates: PersonCandidate[] = people(line).map((p) => ({
        key: accountRefString(p.account),
        handle: agent.handleOf(p.account, p.name),
        person: null,
        account: p.account,
        shown: [p.name],
        first: null,
        call: agent.attitude(p.account)?.call_name ?? null,
      }));
      return namedIn(line.text, candidates).map((c) => c.handle);
    },
  };
}

/**
 * The people known in a place: who spoke there lately (`KNOWN_PEOPLE` of them) and whoever the
 * run answers. Who an `@name` may mention and whom a name in her `<feel>` may be.
 */
export function knownPeople(
  entries: readonly TranscriptEntry[],
  wake: Wake | null,
): { account: AccountRef; name: string }[] {
  const out = speakersOf(entries, KNOWN_PEOPLE);
  for (const from of wake === null ? [] : askers(wake)) {
    if (!out.some((o) => sameAccount(o.account, from.account))) {
      out.push({ account: from.account, name: from.name });
    }
  }
  return out;
}

/** Whoever the run answers: the author of what woke her and the others who called her. */
function askers(wake: Wake): WakeAuthor[] {
  if (wake.kind === "addressed") {
    const callers = (wake.callers ?? []).map((c) => c.from);
    const out: WakeAuthor[] = [];
    for (const from of [wake.from, ...callers]) {
      if (!out.some((o) => sameAccount(o.account, from.account))) out.push(from);
    }
    return out;
  }
  const from = wakeAuthor(wake);
  return from === null ? [] : [from];
}

/** Whether `text` names `who` with an `@name` or the platform's own markup of their account. */
function mentions(text: string, who: { account: AccountRef; name: string }): boolean {
  if (!text.includes("@")) return false;
  if (text.includes(`<@${who.account.id}>`) || text.includes(`<@!${who.account.id}>`)) return true;
  if (who.name.trim() === "") return false;
  const pattern = new RegExp(`@${escapeRegExp(who.name)}(?![\\p{L}\\p{N}_])`, "u");
  return pattern.test(text);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A line about to go out, with the Floor claim it makes where it is said. */
export interface CheckedLine {
  place: ContextKey;
  text: string;
  kind: FloorClaimKind;
  /** The people the line is for, whose wishes it may raise. */
  audience: readonly Handle[];
}

/** Why `line` may not go out; `null`: it may. */
export async function lineRefusal(
  agent: Agent,
  line: CheckedLine,
  signal: AbortSignal,
): Promise<string | null> {
  const services = agent.ctx.services;
  if (line.kind === "wish") {
    const said = services.get(DeliveryLedgerKey)?.saidLately(line.text, { context: line.place });
    if (said != null) return REPEATED_LINE;
  }
  if (line.kind !== "wish" && line.kind !== "notable") return null;
  const wishes = services.get(WishesKey);
  if (wishes === undefined) return null;
  for (const person of line.audience) {
    const verdict = await wishes.screen({ person, text: line.text, holder: null }, signal);
    signal.throwIfAborted();
    if (!verdict.raise) return verdict.why;
  }
  return null;
}
