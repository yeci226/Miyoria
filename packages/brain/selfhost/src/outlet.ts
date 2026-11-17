// How a line of hers leaves: through the mouth (`MainLine.say`), so the one-mouth rule, the
// output review and the delivery ledger stay what they are, then the scheduler and the platform.
// The run holds the Floor for all its lines (`SelfHost`, `MainLine.holdsFloor`), so a line takes no
// hold of its own. A line may carry the platform's reply reference (the host says which,
// `replyTo`; `MainLine.replyNext` hands it to the mouth). The outlet waits
// for `action.settled` of the line to tell the runner whether it reached anyone and under which
// platform id.
//
// In the place of the run, the second and later lines wait about as long as typing them takes
// (`paceMs`, today's `#pace`), with the typing indicator shown.
//
// Before a line goes, the checks the old path made on her own starts (`repeat.ts`): a repeat of
// what she said there lately, a wish that is done. A line in another place (`say`) holds and
// counts in that place's Floor under a turn of its own, as a start of hers there.

import { sleep } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  type ActionSettled,
  ActionSinkKey,
  type ContextKey,
  contextKeyString,
  type FloorClaimKind,
  type Handle,
  type MessageRef,
  newAction,
  newId,
  PlatformSinksKey,
  safeName,
  textLane,
} from "@miyoria/types";
import { type Agent, paceMs } from "../../agent/src/index.js";
import type { Delivery, OutgoingLine, Outlet } from "../../self/src/index.js";
import { linkMentions, type MentionTarget } from "./mentions.js";
import { lineRefusal } from "./repeat.js";
import { splitLine } from "./split.js";

/** A line's longest part when `max_message_chars` is 0: Discord's limit. */
const MAX_LINE = 2_000;

/** How a typing indicator lasts. */
export const TYPING_TTL_MS = 10_000;
/** Longest wait for a line's `action.settled` beyond its TTL. */
const SETTLE_SLACK_MS = 5_000;
/** Longest wait for a line's `action.settled`, whatever its TTL. */
const SETTLE_MAX_MS = 30_000;

/** A line's end as the scheduler told it. */
export interface Settled {
  ok: boolean;
  error: string | null;
  message_id: string | null;
  blocked: string | null;
}

function lineKey(turn: string | null, context: ContextKey, text: string): string {
  return `${turn ?? ""}\n${contextKeyString(context)}\n${text.trim()}`;
}

/** Lines handed to the mouth, waiting for how they left the scheduler. */
export class Settlements {
  readonly #waiting = new Map<string, ((s: Settled) => void)[]>();

  /**
   * Resolves with how the line left, `null` after `ms`; rejects when `signal` aborts. Call before
   * the line is handed over: the answer can come before `say` returns.
   */
  wait(
    turn: string,
    context: ContextKey,
    text: string,
    ms: number,
    signal: AbortSignal,
  ): Promise<Settled | null> {
    const key = lineKey(turn, context, text);
    return new Promise<Settled | null>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (value: Settled | null) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        const list = this.#waiting.get(key)?.filter((w) => w !== take) ?? [];
        if (list.length === 0) this.#waiting.delete(key);
        else this.#waiting.set(key, list);
        resolve(value);
      };
      const take = (s: Settled) => done(s);
      const onAbort = () => {
        clearTimeout(timer);
        const list = this.#waiting.get(key)?.filter((w) => w !== take) ?? [];
        if (list.length === 0) this.#waiting.delete(key);
        else this.#waiting.set(key, list);
        reject(signal.reason ?? new Error("aborted"));
      };
      if (signal.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => done(null), ms);
      this.#waiting.set(key, [...(this.#waiting.get(key) ?? []), take]);
    });
  }

  /** `action.settled` of a `send_message`. Returns whether a line waited for it. */
  settled(event: ActionSettled): boolean {
    if (event.type !== "send_message") return false;
    const key = lineKey(event.turn, event.context, event.text);
    const take = this.#waiting.get(key)?.[0];
    if (take === undefined) return false;
    take({
      ok: event.ok,
      error: event.error,
      message_id: event.message?.id ?? null,
      blocked: event.blocked ?? event.message?.blocked ?? null,
    });
    return true;
  }
}

/** What the outlet asks the host of a line before it goes out. */
export interface OutletClaims {
  /**
   * The Floor claim the line makes where it is said: in the place of its run by what woke her,
   * elsewhere as a start of hers (`sayKind`); `null`: not a run of the host (nothing checked).
   */
  kind(line: OutgoingLine): FloorClaimKind | null;
  /**
   * The people the line is for: whoever the run answers (the author of what woke her and the
   * others who called her), else the people the line names with an `@mention`, else the people who
   * spoke lately in its place. They are who a wish is asked of and who the ledger records; `null`:
   * not a run of the host.
   */
  audience(line: OutgoingLine): Handle[] | null;
  /** The people known in the line's place whom an `@name` in it may mention (not blocked ones). */
  people(line: OutgoingLine): { account: AccountRef; name: string }[];
}

/** The outlet of the host: `MainLine.say`, then the scheduler's word on it. */
export class MouthOutlet implements Outlet {
  readonly #agent: Agent;
  readonly #settlements: Settlements;
  /** When the last line of each turn went out (clock ms), for the pace. */
  readonly #lastAt = new Map<string, number>();
  /** A line of hers in another place went out (`say`). */
  readonly #elsewhere: (line: OutgoingLine, messageId: string | null) => void;
  /** The platform reply reference a line carries, if any. */
  readonly #replyTo: (line: OutgoingLine) => MessageRef | null;
  readonly #claims: OutletClaims | null;

  constructor(
    agent: Agent,
    settlements: Settlements,
    elsewhere: (line: OutgoingLine, messageId: string | null) => void,
    replyTo: (line: OutgoingLine) => MessageRef | null = () => null,
    claims: OutletClaims | null = null,
  ) {
    this.#agent = agent;
    this.#settlements = settlements;
    this.#elsewhere = elsewhere;
    this.#replyTo = replyTo;
    this.#claims = claims;
  }

  /** The turn ended: its pace is forgotten. */
  ended(turn: string): void {
    this.#lastAt.delete(turn);
  }

  async deliver(line: OutgoingLine, signal: AbortSignal): Promise<Delivery> {
    const agent = this.#agent;
    if (agent.muted) return { status: "blocked", reason: "緊急停止中" };
    signal.throwIfAborted();
    const kind = this.#claims?.kind(line) ?? null;
    const audience = this.#claims?.audience(line) ?? null;
    if (kind !== null) {
      const refused = await lineRefusal(agent, { ...line, kind, audience: audience ?? [] }, signal);
      if (refused !== null) return { status: "blocked", reason: refused };
    }
    // A line in another place claims and counts in that place's Floor, under a turn of its own:
    // the Floor counts a line in the place its turn holds.
    const floor = !line.focus && kind !== null ? agent.mainline.floor() : null;
    const turn = floor === null || kind === null ? line.turn : newId();
    if (floor !== null && kind !== null) {
      agent.mainline.holdsFloor(turn, true);
      floor.hold(turn, line.place, kind);
    }
    try {
      return await this.#sayAll(line, turn, audience, signal);
    } finally {
      if (turn !== line.turn) {
        if (signal.aborted) {
          void agent.ctx.services.get(ActionSinkKey)?.cancelTurn(turn);
          agent.mainline.lines.cancelUnstarted(turn, "the run was cut");
        }
        agent.mainline.holdsFloor(turn, false);
        floor?.turnEnded(turn);
      }
    }
  }

  /**
   * What is sent of `line`: `@name` of the people known in the place as real mentions
   * (`mention_users`), then cut into messages under `max_message_chars`. The line itself, and so
   * the transcript, keeps what she wrote.
   */
  #parts(line: OutgoingLine): string[] {
    const cfg = this.#agent.config;
    let text = line.text;
    const sink = this.#agent.ctx.services.get(PlatformSinksKey)?.get(line.place.platform);
    if (cfg.mention_users && sink?.mention !== undefined && this.#claims !== null) {
      const targets: MentionTarget[] = [];
      for (const person of this.#claims.people(line)) {
        const markup = sink.mention(person.account);
        if (markup === null) continue;
        // What she calls them (稱呼) is a name she writes for them too.
        const call = this.#agent.attitude(person.account)?.call_name ?? null;
        const aliases = [safeName(person.name), this.#agent.handleOf(person.account, person.name)];
        if (call !== null) aliases.push(call);
        targets.push({ name: person.name, markup, aliases });
      }
      text = linkMentions(text, targets);
    }
    const parts = splitLine(text, cfg.max_message_chars > 0 ? cfg.max_message_chars : MAX_LINE);
    return parts.length === 0 ? [text] : parts;
  }

  /** Every part of `line` to the mouth in turn; the first one's id stands for the line. */
  async #sayAll(
    line: OutgoingLine,
    turn: string,
    audience: readonly Handle[] | null,
    signal: AbortSignal,
  ): Promise<Delivery> {
    let first: Delivery | null = null;
    for (const [index, text] of this.#parts(line).entries()) {
      const delivery = await this.#say(line, text, index === 0, turn, audience, signal);
      if (delivery.status === "blocked") {
        if (first === null) return delivery;
        break;
      }
      first ??= delivery;
    }
    if (first?.status === "delivered" && !line.focus) this.#elsewhere(line, first.message_id);
    return first ?? { status: "blocked", reason: "nothing to send" };
  }

  /** `text`, a part of `line`, to the mouth under `turn`, and how it left the scheduler. */
  async #say(
    line: OutgoingLine,
    text: string,
    first: boolean,
    turn: string,
    audience: readonly Handle[] | null,
    signal: AbortSignal,
  ): Promise<Delivery> {
    const agent = this.#agent;
    agent.mainline.own(turn);
    if (line.focus) await this.#pace(line, text, signal);
    const cfg = agent.config;
    const ms = Math.min(cfg.reply_ttl_ms + SETTLE_SLACK_MS, SETTLE_MAX_MS);
    const settled = this.#settlements.wait(turn, line.place, text, ms, signal);
    settled.catch(() => undefined);
    if (first) agent.mainline.replyNext(turn, line.place, this.#replyTo(line));
    await agent.mainline.say({
      context: line.place,
      text,
      emotion: line.emotion,
      turn,
      source: "self",
      ...(audience === null ? {} : { audience }),
    });
    const end = await settled;
    if (line.focus) this.#lastAt.set(line.turn, agent.ctx.clock.now());
    if (end === null) {
      // The scheduler did not say in time: the line was queued, and is taken as said.
      agent.log.debug({ turn: line.turn }, "no word from the scheduler on a line");
      return { status: "delivered", message_id: null };
    }
    if (!end.ok) return { status: "blocked", reason: end.error ?? "failed" };
    if (end.blocked !== null) return { status: "blocked", reason: end.blocked };
    return { status: "delivered", message_id: end.message_id };
  }

  async #pace(line: OutgoingLine, text: string, signal: AbortSignal): Promise<void> {
    const last = this.#lastAt.get(line.turn);
    if (last === undefined) return;
    const agent = this.#agent;
    const wait = paceMs(agent.rhythm.config, text) - (agent.ctx.clock.now() - last);
    if (wait <= 0) return;
    await submitTyping(agent, line.place, line.turn);
    await sleep(wait, signal);
  }
}

/** Shows her typing in `context` for `turn`. Never throws. */
export async function submitTyping(agent: Agent, context: ContextKey, turn: string): Promise<void> {
  const sink = agent.ctx.services.get(ActionSinkKey);
  if (!sink) return;
  try {
    await sink.submit(
      newAction(
        textLane(context),
        "direct",
        { type: "typing", context },
        {
          ttl: TYPING_TTL_MS,
          turn,
          coalesce_key: `typing:${contextKeyString(context)}`,
        },
      ),
    );
  } catch (error) {
    agent.log.debug({ turn, err: String(error) }, "could not submit a typing action");
  }
}
