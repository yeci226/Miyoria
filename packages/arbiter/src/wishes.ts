// One wish, one key, closed when it is done (`@miyoria/types` `wish.ts`, docs/design/v4-plan.md
// §2.4, §7.6).
//
// 2026-11-10, ten times the same question to one person in 100 minutes: a proposal from memory, a
// commitment written in the turn it opened, a second commitment, then a goal of her Plan that read
// "whenever S speaks, ask about X". She had asked by DM at 11:07 and S had answered at 11:22 and
// 11:33; nothing knew. This book is what knows: it follows the EventLog, so a restart keeps it.
//
// * She asked: a line delivered to an audience with the person in it, or a `message_dm` the hands
//   finished for them, about the same topic; or the main line says a turn raised it.
// * They answered: anything the person said after she asked, in any place (what the memory's
//   `PersonThreads` counts as an answer too). They said "you asked already" or "stop asking":
//   every wish of theirs closes for good.
// * A state change is one `decision` event (source `wish`) with the whole wish; the stores that
//   hold it (commitments, the proposal board, goals, timers) close their entries from it.
// * `screen` is asked before anything raises a wish again. Answered or told to stop: never. Asked
//   and unanswered: one polite follow-up, after `followup_hours`, and never a second.

import {
  type AskedLookup,
  type Delivery,
  type EventLog,
  type Handle,
  type HandleDirectory,
  isJsonObject,
  type JsonValue,
  type LogEvent,
  type MainActionBody,
  type MainResultBody,
  newId,
  type ObservationBody,
  type PersonThreads,
  type Projection,
  sameWish,
  stopsAsking,
  timestampMs,
  toTimestamp,
  WISH_SOURCE,
  type Wish,
  type WishBody,
  type WishEnd,
  type Wishes,
  type WishVerdict,
} from "@miyoria/types";

const HOUR_MS = 3_600_000;
/** Longest topic kept. */
const TOPIC_CHARS = 80;
/** Wishes remembered at most (the oldest closed ones go first). */
const MAX_WISHES = 500;
/** Source of the hands' `action` and `result` events (`@miyoria/agent`'s `HANDS_SOURCE`). */
const HANDS = "mainline.hands";
/** Tools that say something to one person. */
const TALK_TOOLS = new Set(["message_dm", "message.dm"]);

export interface WishConfig {
  /** One follow-up on an unanswered question, no sooner than this after she asked. */
  followup_hours: number;
  /** A wish is remembered this long after it was made or closed. */
  keep_hours: number;
}

export interface WishEnv {
  now(): number;
  log?(): Pick<EventLog, "append"> | null;
  /** The memory's view of her questions across places (`PersonThreadsKey`). */
  threads?(): PersonThreads | null;
  handles?(): HandleDirectory | null;
}

function cut(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

function samePerson(a: string, b: string): boolean {
  return a.trim().replace(/^@/, "").toLowerCase() === b.trim().replace(/^@/, "").toLowerCase();
}

/** What a person said, from the observation of their line. */
function saidIn(body: ObservationBody): string {
  const origin = body.origin?.event;
  if (isJsonObject(origin) && isJsonObject(origin.data)) {
    const text = origin.data.text;
    if (typeof text === "string") return text;
  }
  const summary = body.observation.summary;
  const colon = summary.indexOf(":");
  return colon < 0 ? summary : summary.slice(colon + 1);
}

export class WishBook implements Wishes, Projection {
  readonly #cfg: WishConfig;
  readonly #env: WishEnv;
  readonly #wishes = new Map<string, Wish>();
  readonly #holders = new Map<string, string>();
  /** `message_dm` calls of the hands in flight: call id → who and what. */
  readonly #dms = new Map<string, { to: string; text: string }>();
  #applying = 0;

  constructor(config: WishConfig, env: WishEnv) {
    this.#cfg = config;
    this.#env = env;
  }

  #now(): number {
    return this.#env.now();
  }

  /** Every wish remembered (the panel, tests). */
  all(): Wish[] {
    return [...this.#wishes.values()].map((w) => structuredClone(w));
  }

  #take(wish: Wish): void {
    this.#wishes.set(wish.key, wish);
    for (const h of wish.holders) this.#holders.set(h, wish.key);
    if (this.#wishes.size <= MAX_WISHES) return;
    const oldest = [...this.#wishes.values()].sort(
      (a, b) =>
        (a.state === "closed" ? 0 : 1) - (b.state === "closed" ? 0 : 1) ||
        timestampMs(a.made_at) - timestampMs(b.made_at),
    )[0];
    if (oldest) this.#forget(oldest);
  }

  #forget(wish: Wish): void {
    this.#wishes.delete(wish.key);
    for (const h of wish.holders) if (this.#holders.get(h) === wish.key) this.#holders.delete(h);
  }

  /** Keeps `wish` and writes it to the log (after the event being applied, when inside one). */
  #save(wish: Wish): void {
    this.#take(wish);
    const log = this.#env.log?.() ?? null;
    if (log === null) return;
    const body: WishBody = { wish: structuredClone(wish) };
    const write = () =>
      log.append({
        kind: "decision",
        source: WISH_SOURCE,
        person: wish.person,
        body: body as unknown as JsonValue,
      });
    // A projection must not write in the middle of another event's delivery: the other
    // projections would see the change before the event that caused it.
    if (this.#applying > 0) queueMicrotask(write);
    else write();
  }

  #stale(wish: Wish, now: number): boolean {
    const at = wish.closed_at ?? wish.asked_at ?? wish.made_at;
    return now - timestampMs(at) > this.#cfg.keep_hours * HOUR_MS;
  }

  // ---- Wishes ---------------------------------------------------------------------------------

  of(holder: string): Wish | null {
    const key = this.#holders.get(holder);
    const wish = key === undefined ? undefined : this.#wishes.get(key);
    return wish === undefined ? null : structuredClone(wish);
  }

  find(person: Handle | null, text: string): Wish | null {
    if (person === null || person.trim() === "" || text.trim() === "") return null;
    const now = this.#now();
    let best: Wish | null = null;
    for (const w of this.#wishes.values()) {
      if (!samePerson(w.person, person) || this.#stale(w, now)) continue;
      if (!sameWish(text, w.topic, w.person)) continue;
      if (best === null || timestampMs(w.made_at) > timestampMs(best.made_at)) best = w;
    }
    return best === null ? null : structuredClone(best);
  }

  hold(person: Handle | null, text: string, holder: string): Wish | null {
    const known = this.of(holder);
    if (known !== null) return known;
    if (person === null || person.trim() === "" || text.trim() === "") return null;
    const same = this.find(person, text);
    if (same !== null) {
      const wish = { ...same, holders: [...same.holders, holder] };
      this.#save(wish);
      return structuredClone(wish);
    }
    const now = toTimestamp(this.#now());
    const id = holder.slice(holder.indexOf(":") + 1) || newId();
    const wish: Wish = {
      key: `wish:${person.trim()}:${id}`,
      person: person.trim(),
      topic: cut(text, TOPIC_CHARS),
      holders: [holder],
      state: "open",
      made_at: now,
      asked_at: null,
      asked: 0,
      closed_at: null,
      end: null,
    };
    this.#save(wish);
    return structuredClone(wish);
  }

  asked(key: string, at = this.#now()): void {
    const wish = this.#wishes.get(key);
    if (!wish || wish.state === "closed") return;
    // One raising of it is one asking, however many lines or tools it took.
    const last = wish.asked_at === null ? null : timestampMs(wish.asked_at);
    if (last !== null && at - last < 60_000) return;
    this.#save({ ...wish, state: "asked", asked: wish.asked + 1, asked_at: toTimestamp(at) });
  }

  close(key: string, end: WishEnd): void {
    const wish = this.#wishes.get(key);
    if (!wish || wish.state === "closed") return;
    this.#save({ ...wish, state: "closed", end, closed_at: toTimestamp(this.#now()) });
  }

  async screen(
    input: { person: Handle | null; text: string; holder?: string | null },
    signal?: AbortSignal,
  ): Promise<WishVerdict> {
    const holder = input.holder ?? null;
    let wish = (holder === null ? null : this.of(holder)) ?? this.find(input.person, input.text);
    if (wish === null && input.person !== null && holder !== null) {
      wish = this.hold(input.person, input.text, holder);
    }
    if (wish === null) return { raise: true, wish: null };
    const lookup = await this.#lookup(wish, signal);
    if (lookup !== null) wish = this.#learn(wish, lookup);
    return this.#verdict(wish);
  }

  /** What the memory knows of her asking this person about this, anywhere. */
  async #lookup(wish: Wish, signal?: AbortSignal): Promise<AskedLookup | null> {
    const threads = this.#env.threads?.() ?? null;
    const person = this.#env.handles?.()?.resolve(wish.person)?.person ?? null;
    if (threads === null || person === null) return null;
    try {
      return await threads.asked(person, wish.topic, toTimestamp(this.#now()), signal);
    } catch {
      return null;
    }
  }

  /** The memory saw her ask, or them answer, where this book did not. */
  #learn(wish: Wish, lookup: AskedLookup): Wish {
    if (wish.state === "closed") return wish;
    if (lookup.answered_at !== null) {
      this.close(wish.key, "answered");
      return structuredClone(this.#wishes.get(wish.key) ?? wish);
    }
    if (lookup.times > wish.asked) {
      const next: Wish = {
        ...wish,
        state: "asked",
        asked: lookup.times,
        asked_at: lookup.last_asked_at,
      };
      this.#save(next);
      return next;
    }
    return wish;
  }

  #verdict(wish: Wish): WishVerdict {
    if (wish.state === "open") return { raise: true, wish };
    if (wish.state === "closed") {
      const why =
        wish.end === "stop"
          ? "對方說你已經問過了,這件事不要再提"
          : wish.end === "answered"
            ? "對方已經回答過了,不用再問"
            : wish.end === "asked"
              ? "這件事你已經問過了"
              : "這件事已經過了";
      return { raise: false, wish, why, until: null };
    }
    if (wish.asked >= 2) {
      return {
        raise: false,
        wish,
        why: `你已經問過 ${wish.asked} 次了,等對方自己說`,
        until: null,
      };
    }
    const asked = wish.asked_at === null ? 0 : timestampMs(wish.asked_at);
    const until = asked + this.#cfg.followup_hours * HOUR_MS;
    if (this.#now() < until) {
      return {
        raise: false,
        wish,
        why: "這件事你剛問過了,對方還沒回;隔久一點才能再關心一次",
        until: toTimestamp(until),
      };
    }
    return { raise: true, wish };
  }

  // ---- the log --------------------------------------------------------------------------------

  apply(event: LogEvent): void {
    this.#applying++;
    try {
      this.#apply(event);
    } finally {
      this.#applying--;
    }
  }

  #apply(event: LogEvent): void {
    switch (event.kind) {
      case "decision": {
        if (event.source !== WISH_SOURCE || !isJsonObject(event.body)) return;
        const { wish } = event.body as unknown as Partial<WishBody>;
        if (wish && typeof wish.key === "string") this.#take(structuredClone(wish));
        return;
      }
      case "observation":
        this.#heard(event);
        return;
      case "delivered":
        this.#delivered(event.body as unknown as Delivery, timestampMs(event.at));
        return;
      case "action": {
        if (event.source !== HANDS || !isJsonObject(event.body)) return;
        const body = event.body as unknown as MainActionBody;
        if (!TALK_TOOLS.has(body.tool) || !isJsonObject(body.args)) return;
        const { to, text } = body.args;
        if (typeof to === "string" && typeof text === "string") {
          this.#dms.set(body.call, { to, text });
          while (this.#dms.size > 100) {
            const first = this.#dms.keys().next().value;
            if (first === undefined) break;
            this.#dms.delete(first);
          }
        }
        return;
      }
      case "result": {
        if (event.source !== HANDS || !isJsonObject(event.body)) return;
        const body = event.body as unknown as MainResultBody;
        const dm = this.#dms.get(body.call);
        if (dm === undefined || body.state === "accepted") return;
        this.#dms.delete(body.call);
        if (body.state === "done") this.#reached(dm.to, dm.text, timestampMs(event.at));
        return;
      }
      default:
        return;
    }
  }

  /** A line of hers reached `person`: what it was about is asked. */
  #reached(person: string, said: string, at: number): void {
    for (const w of [...this.#wishes.values()]) {
      if (w.state !== "open" && w.state !== "asked") continue;
      if (!samePerson(w.person, person) || !sameWish(said, w.topic, w.person)) continue;
      this.asked(w.key, at);
    }
  }

  #delivered(delivery: Delivery, at: number): void {
    if (!Array.isArray(delivery?.audience) || typeof delivery.said !== "string") return;
    for (const person of delivery.audience) this.#reached(person, delivery.said, at);
  }

  /** A person said something: an answer to what she asked them, or "stop asking". */
  #heard(event: LogEvent): void {
    if (!isJsonObject(event.body) || !isJsonObject(event.body.observation)) return;
    const body = event.body as unknown as ObservationBody;
    const from = body.observation.from;
    if (body.speech !== true || from === null) return;
    const at = timestampMs(event.at);
    const stop = stopsAsking(saidIn(body));
    for (const w of [...this.#wishes.values()]) {
      if (w.state === "closed" || !samePerson(w.person, from)) continue;
      if (stop) this.close(w.key, "stop");
      else if (w.state === "asked" && w.asked_at !== null && at > timestampMs(w.asked_at)) {
        this.close(w.key, "answered");
      }
    }
  }
}
