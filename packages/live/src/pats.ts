// Head-pats from the page (docs/design/v4-plan.md §9.2 step 2).
//
// A pat is counted against two limits (per person, everyone together) and joins the batch that
// is open; a batch closes `coalesce_secs` after its first pat and becomes one Observation: "Owen
// patted your head 3 times, and two people you do not know did too". It always has the same
// attention key and a revision that only goes up, it is low salience, and it says nothing for
// her: whether she reacts, and in what words, is the main line's (§15). Nothing here speaks,
// writes a line, or asks for a turn.
//
// Someone she blocked is answered exactly like anyone else and their pat goes nowhere, so the
// page cannot be used to find out who is blocked.

import {
  accountRefString,
  type Handle,
  type LivePart,
  type LivePatOutcome,
  type LivePats,
  type LivePatter,
  type LiveSpot,
  type LiveTouch,
  type Observation,
  type PersonId,
  safeName,
} from "@miyoria/types";
import type { LiveConfig } from "./config.js";
import { classify } from "./video.js";

/** How each kind of touch is told to her, in the order of a batch's summary. */
const TOUCH_WORDS: ReadonlyArray<readonly [LivePart, string]> = [
  ["head", "摸頭"],
  ["face", "戳臉"],
  ["body", "碰身體"],
  ["screen", "點畫面"],
];

const MINUTE_MS = 60_000;
/** People tracked by the per-person limit at once; past this the oldest windows are forgotten. */
const MAX_PEOPLE = 5_000;
/** Names one Observation lists; the rest are counted. */
const MAX_NAMED = 5;

/** The source and attention key of every pat Observation. */
export const PAT_SOURCE = "live.pat";
export const PAT_KEY = "live:pat";
/** Her working-context bucket of pats, and how many batches it keeps. */
export const PAT_WRITER = "live_pats";
const PAT_ENTRIES = 3;

/** Who patted, as far as she is concerned. */
export type PatWho =
  /** Someone she knows: their handle, when they have one. */
  | { kind: "known"; person: PersonId; handle: Handle | null; name: string }
  /** Logged in with Discord, never met. */
  | { kind: "stranger" }
  /** Blocked, or nothing can tell: goes nowhere. */
  | { kind: "blocked" };

/** Fixed-window counter per key, with a bounded number of keys. */
export class Window {
  readonly #hits = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = MAX_PEOPLE,
  ) {}

  /** How many ms until `key` may go again, without counting; `null` when it may now. */
  wait(key: string, now: number): number | null {
    const entry = this.#hits.get(key);
    if (!entry || now - entry.start >= this.windowMs || entry.count < this.limit) return null;
    return this.windowMs - (now - entry.start);
  }

  count(key: string, now: number): void {
    const entry = this.#hits.get(key);
    if (entry && now - entry.start < this.windowMs) {
      entry.count += 1;
      return;
    }
    this.#hits.delete(key);
    while (this.#hits.size >= this.maxKeys) {
      const oldest = this.#hits.keys().next().value;
      if (oldest === undefined) break;
      this.#hits.delete(oldest);
    }
    this.#hits.set(key, { start: now, count: 1 });
  }
}

interface Patter {
  who: Extract<PatWho, { kind: "known" }>;
  count: number;
}

interface Batch {
  /** When the first pat of it came. */
  opened: number;
  known: Map<PersonId, Patter>;
  /** Accounts of people she never met, and their pats. */
  strangers: Map<string, number>;
  /** Touches by kind, everyone together. */
  parts: Map<LivePart, number>;
}

/** Where one pat landed, when it came from the picture. */
export interface PatTouch {
  spot: LiveSpot;
  part: LivePart;
}

/** What one batch tells her. */
export interface PatObservation {
  observation: Observation;
  person: Handle | null;
}

export interface PatDeskOptions {
  config: LiveConfig;
  now: () => number;
  /** Who `account` is to her. */
  who: (by: LivePatter) => Promise<PatWho>;
  /** A batch closed. */
  observe: (batch: PatObservation) => void;
  /**
   * An accepted pat of someone who is not blocked, with a key unique to it. The module forwards it
   * to the economy's participation service; nothing here knows what it pays.
   */
  award?: (by: LivePatter, key: string) => void;
  /** The counts changed: `patted` when somebody just patted (`touch` when it had a spot). */
  changed?: (pats: LivePats, patted: boolean, touch?: PatTouch) => void;
  /** An accepted pat of someone who is not blocked, with a spot: the stage may draw a hand. */
  touched?: (touch: LiveTouch) => void;
}

export class PatDesk {
  readonly #config: LiveConfig;
  readonly #now: () => number;
  readonly #who: PatDeskOptions["who"];
  readonly #observe: PatDeskOptions["observe"];
  readonly #changed: NonNullable<PatDeskOptions["changed"]>;
  readonly #award: PatDeskOptions["award"];
  readonly #touched: PatDeskOptions["touched"];
  /** Makes the key of each pat unique even when two come in the same millisecond. */
  #serial = 0;
  readonly #people: Window;
  readonly #everyone: Window;
  /** When each pat of the last minute came, oldest first. */
  #recent: number[] = [];
  #batch: Batch | null = null;
  /** The last revision written, so two batches never share one. */
  #revision = 0;

  constructor(options: PatDeskOptions) {
    this.#config = options.config;
    this.#now = options.now;
    this.#who = options.who;
    this.#observe = options.observe;
    this.#changed = options.changed ?? (() => {});
    this.#award = options.award;
    this.#touched = options.touched;
    this.#people = new Window(options.config.per_person_per_minute, MINUTE_MS);
    this.#everyone = new Window(options.config.per_minute, MINUTE_MS, 1);
  }

  /** The counts anyone may see. */
  pats(): LivePats {
    this.#forget(this.#now());
    return { recent: this.#recent.length, open: this.#config.pats };
  }

  #forget(now: number): void {
    const cutoff = now - MINUTE_MS;
    let drop = 0;
    while (drop < this.#recent.length && (this.#recent[drop] ?? 0) <= cutoff) drop += 1;
    if (drop > 0) this.#recent = this.#recent.slice(drop);
  }

  async pat(by: LivePatter): Promise<LivePatOutcome> {
    if (!this.#config.pats) return { status: "closed" };
    const key = accountRefString(by.account);
    const now = this.#now();
    const wait = this.#people.wait(key, now) ?? this.#everyone.wait("all", now);
    if (wait !== null) return { status: "too_many", wait_ms: Math.max(wait, 1) };
    // Counted before the lookup, so a burst of clicks cannot slip past while it runs.
    this.#people.count(key, now);
    this.#everyone.count("all", now);
    this.#recent.push(now);
    this.#forget(now);
    const who = await this.#who(by).catch((): PatWho => ({ kind: "blocked" }));
    // No spot is the keyboard button (or an old page): that is her head, as it always was.
    const spot = by.spot;
    const part: LivePart = spot ? classify(spot, this.#config.video) : "head";
    if (who.kind !== "blocked") {
      this.#add(key, who, this.#now(), part);
      this.#serial += 1;
      this.#award?.(by, `pat:${key}:${now}:${this.#serial}`);
      if (spot) this.#touched?.({ x: spot.x, y: spot.y, part });
    }
    const pats = this.pats();
    this.#changed(pats, true, spot ? { spot: { x: spot.x, y: spot.y }, part } : undefined);
    return { status: "ok", pats };
  }

  #add(
    account: string,
    who: Exclude<PatWho, { kind: "blocked" }>,
    now: number,
    part: LivePart,
  ): void {
    if (this.#batch === null) {
      this.#batch = { opened: now, known: new Map(), strangers: new Map(), parts: new Map() };
    }
    const batch = this.#batch;
    batch.parts.set(part, (batch.parts.get(part) ?? 0) + 1);
    if (who.kind === "known") {
      const patter = batch.known.get(who.person);
      if (patter) patter.count += 1;
      else batch.known.set(who.person, { who, count: 1 });
    } else {
      batch.strangers.set(account, (batch.strangers.get(account) ?? 0) + 1);
    }
  }

  /** Closes a batch whose time is up; call it every second or so. */
  tick(): void {
    const now = this.#now();
    const before = this.#recent.length;
    this.#forget(now);
    if (this.#recent.length !== before) this.#changed(this.pats(), false);
    const batch = this.#batch;
    if (batch === null || now - batch.opened < this.#config.coalesce_secs * 1000) return;
    this.#batch = null;
    this.#observe(this.#write(batch, now));
  }

  /** The Observation of a closed batch. */
  #write(batch: Batch, now: number): PatObservation {
    const known = [...batch.known.values()].sort((a, b) => b.count - a.count);
    const strangerPats = [...batch.strangers.values()].reduce((n, c) => n + c, 0);
    const total = known.reduce((n, p) => n + p.count, 0) + strangerPats;
    const named = known
      .slice(0, MAX_NAMED)
      .map((p) => `${safeName(p.who.handle ?? p.who.name)}(${p.count} 下)`);
    const moreKnown = known.length - named.length;
    const parts: string[] = [];
    if (named.length > 0) parts.push(named.join("、"));
    if (moreKnown > 0) parts.push(`還有 ${moreKnown} 個你認識的人`);
    if (batch.strangers.size > 0) parts.push(`${batch.strangers.size} 個你不認識的人`);
    // Only head-pats: the words it always had. Otherwise say what kinds of touches they were.
    const onlyHead = [...batch.parts.keys()].every((p) => p === "head");
    const kinds = TOUCH_WORDS.flatMap(([part, word]) => {
      const n = batch.parts.get(part) ?? 0;
      return n > 0 ? [`${word} ${n} 下`] : [];
    }).join("、");
    const summary = onlyHead
      ? `網頁現場有人摸了摸你的頭,一共 ${total} 下:${parts.join(",")}。`
      : `網頁現場有人在畫面上碰了碰你,一共 ${total} 下(${kinds}):${parts.join(",")}。`;
    // Seconds since the epoch: it only goes up, across restarts too, so the ledger never takes a
    // new batch for one already answered.
    this.#revision = Math.max(Math.floor(now / 1000), this.#revision + 1);
    const top = known[0]?.who.handle ?? null;
    const notable = this.#config.pat_salience === "notable";
    return {
      observation: {
        source: PAT_SOURCE,
        // Ambient is what she knows; notable may ask for the mic, and is still hers to answer.
        silent: !notable,
        salience: notable ? "notable" : "ambient",
        attention_key: PAT_KEY,
        revision: this.#revision,
        summary,
        // Nobody waits for an answer: a pat asks her nothing.
        addressed_to_her: false,
        from: top,
        context: null,
      },
      person: top,
    };
  }
}

/** Her working-context write for a pat Observation: the last few batches, as data. */
export const PAT_BUCKET = {
  op: "append-self",
  writer: PAT_WRITER,
  owner: "live",
  untrusted: true,
  max_entries: PAT_ENTRIES,
} as const;
