import { errorMessage, getLogger, interval, SerialQueue } from "@miyoria/runtime/kernel";
import type { SettingsStore } from "@miyoria/store";
import {
  type AccountRef,
  type AnyEventDefinition,
  type Clock,
  type ContextKey,
  Events,
  type JsonObject,
  type JsonValue,
  type Places,
  type Publish,
  type SocialSignals,
  systemClock,
  timestampMs,
  toTimestamp,
} from "@miyoria/types";
import { z } from "zod";
import { type QueueConfig, QueueConfigSchema } from "./config.js";
import {
  type Ballot,
  type ItemId,
  type ItemState,
  QueueError,
  type QueueItem,
  type SubmitRequest,
  tallies,
  type VoteResult,
  type VoteState,
  voteWinner,
  winnerOption,
} from "./types.js";

const log = getLogger("queue");

/** Settings profile the snapshot is stored under. */
export const STATE_PROFILE = "_global";
/** Settings key of the snapshot. */
export const STATE_KEY = "queue:state";

/** Receives the queue's events (the module publishes them on the bus). */
export type Publisher = Publish;

/** One event a mutation publishes once it is applied. */
interface QueueEvent {
  definition: AnyEventDefinition;
  data: JsonValue;
  /** The Space it is about (the envelope's `space_id`): a reader shows one server's queue only. */
  space?: string;
}

/** A new item and where it stands. */
export interface Submitted {
  item: QueueItem;
  /** 1-based place among pending items. */
  position: number;
}

/**
 * What each Space's queue has of its own (phase 6): whether it is paused, who was served how often
 * (fair queuing), its vote. The items are one list with their Space on each, so an item id names
 * one item everywhere.
 */
interface Partition {
  paused: boolean;
  /** How many items each requester got activated (fair queuing credit). */
  served: Array<[AccountRef, number]>;
  vote: VoteState | null;
  last_vote: VoteResult | null;
}

interface State {
  next_id: ItemId;
  /** Pending and active items, in insertion order. */
  items: QueueItem[];
  /** Finished items, oldest first. */
  history: QueueItem[];
  /** By partition key (`RequestQueue.key`): a Space's id, or `""` for the queue of no Space. */
  spaces: Record<string, Partition>;
}

/** One Space's queue (`RequestQueue.of`): the queue's methods with the Space filled in. */
export interface QueueView {
  readonly config: QueueConfig;
  submit(request: SubmitRequest): Submitted;
  next(): QueueItem | null;
  complete(id: ItemId): QueueItem;
  skip(id: ItemId): QueueItem;
  remove(id: ItemId): QueueItem;
  clear(): number;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  setPriority(id: ItemId, priority: number): void;
  moveItem(id: ItemId, position: number): void;
  vote(id: ItemId, voter: AccountRef): number;
  list(): QueueItem[];
  get(id: ItemId): QueueItem | null;
  current(): QueueItem | null;
  history(): QueueItem[];
  startVote(options: readonly string[], durationMs: number): void;
  castVote(account: AccountRef, choice: string): string;
  voteStatus(): VoteState | null;
  lastVote(): VoteResult | null;
  endVote(): VoteResult;
}

/**
 * Where the queue learns the Spaces (identity's `Places`, through the module): which Space a
 * request's context is in, and the default one (the primary). Without it there is one queue.
 */
export interface QueueSpaces {
  /** The Space of a context (identity's id); `null` for a DM or a place it does not know. */
  spaceOf(context: ContextKey): string | null;
  /** The Space a request with no Space goes to: the primary, else the first; `null`: none. */
  primary(): string | null;
}

/** `QueueSpaces` over identity's `Places`; `null` without them. */
export function queueSpaces(places: Places | null): QueueSpaces | null {
  if (places === null) return null;
  return {
    spaceOf: (context) => {
      const at = places.at(context);
      if (at !== null) return at.space_id;
      return context.scope === null
        ? null
        : (places.ofGuild(context.platform, context.scope)?.id ?? null);
    },
    primary: () => places.primary()?.id ?? places.spaces()[0]?.id ?? null,
  };
}

const SONG_LINK =
  /https?:\/\/(?:[a-z0-9-]+\.)*(?:youtube\.com|youtu\.be|soundcloud\.com|bilibili\.com|b23\.tv|nicovideo\.jp|nico\.ms)\//i;
const SONG_WORDS = /^\s*(?:唱|點歌|点歌|sing\b)/i;

/**
 * The kind of a request whose kind was left empty: `song` for a music link or text that asks
 * for a song (「唱…」「點歌…」), else `chat`.
 */
export function guessKind(text: string): string {
  return SONG_LINK.test(text) || SONG_WORDS.test(text) ? "song" : "chat";
}

function newPartition(): Partition {
  return { paused: false, served: [], vote: null, last_vote: null };
}

function newState(): State {
  return { next_id: 0, items: [], history: [], spaces: {} };
}

// --- snapshot schema (serde JSON of the Rust `State`; every field defaults) ---
//
// Version 2 (phase 6) adds `space` to every item and `spaces`, each Space's own partition; the
// top-level `paused`, `served`, `vote`, `last_vote` are still written, as the default Space's, so
// an older build reads the queue it knows. A snapshot without `spaces` is one of before: its
// partition is the default Space's, and each item goes to the Space of its context, else the
// default Space.

const AccountRefSchema = z.object({ platform: z.string(), id: z.string() });
const ContextKeySchema = z.object({
  platform: z.string(),
  scope: z.string().nullable(),
  channel: z.string(),
  kind: z.enum(["channel", "thread", "dm", "voice"]),
});
const ItemSchema = z.object({
  id: z.number(),
  requester: AccountRefSchema,
  requester_name: z.string(),
  kind: z.string(),
  text: z.string(),
  context: ContextKeySchema.nullable().default(null),
  /** Absent in a snapshot of before Spaces. */
  space: z.string().nullable().optional(),
  created_at: z.string(),
  priority: z.number(),
  slot: z.number().nullable().default(null),
  votes: z.number().default(0),
  voters: z.array(AccountRefSchema).default([]),
  state: z.enum(["pending", "active", "done", "skipped", "removed"]),
});
const VoteSchema = z.object({
  options: z.array(z.string()),
  started_at: z.string(),
  ends_at: z.string(),
  ballots: z.array(z.object({ account: AccountRefSchema, option: z.number(), at: z.string() })),
});
const VoteResultSchema = z.object({
  options: z.array(z.string()),
  tallies: z.array(z.number()),
  winner: z.number().nullable(),
  total: z.number(),
  ended_at: z.string(),
});
const PartitionSchema = z.object({
  paused: z.boolean().default(false),
  served: z.array(z.tuple([AccountRefSchema, z.number()])).default([]),
  vote: VoteSchema.nullable().default(null),
  last_vote: VoteResultSchema.nullable().default(null),
});
export const QueueSnapshotSchema = z.object({
  next_id: z.number().default(0),
  items: z.array(ItemSchema).default([]),
  history: z.array(ItemSchema).default([]),
  paused: z.boolean().default(false),
  served: z.array(z.tuple([AccountRefSchema, z.number()])).default([]),
  vote: VoteSchema.nullable().default(null),
  last_vote: VoteResultSchema.nullable().default(null),
  spaces: z.record(z.string(), PartitionSchema).optional(),
});

const accKey = (a: AccountRef): string => `${a.platform}\u0000${a.id}`;
const sameAcc = (a: AccountRef, b: AccountRef): boolean =>
  a.platform === b.platform && a.id === b.id;

function servedOf(part: Partition, account: AccountRef): number {
  return part.served.find(([a]) => sameAcc(a, account))?.[1] ?? 0;
}

function setServed(part: Partition, account: AccountRef, n: number): void {
  const entry = part.served.find(([a]) => sameAcc(a, account));
  if (entry) entry[1] = n;
  else part.served.push([account, n]);
}

function indexOfItem(st: State, id: ItemId): number {
  const index = st.items.findIndex((i) => i.id === id);
  if (index < 0) throw QueueError.notFound(id);
  return index;
}

function item(st: State, index: number): QueueItem {
  return st.items[index] as QueueItem;
}

function push(st: State, req: SubmitRequest, space: string | null, now: number): QueueItem {
  st.next_id += 1;
  const created: QueueItem = {
    id: st.next_id,
    requester: req.requester,
    requester_name: req.requesterName,
    kind: req.kind,
    text: req.text,
    context: req.context ?? null,
    space,
    created_at: toTimestamp(now),
    priority: req.priority ?? 0,
    slot: null,
    votes: 0,
    voters: [],
    state: "pending",
  };
  st.items.push(created);
  return structuredClone(created);
}

/** Moves the item to history with its final `state`. */
function finishItem(st: State, index: number, state: ItemState, limit: number): QueueItem {
  const [removed] = st.items.splice(index, 1) as [QueueItem];
  removed.state = state;
  st.history.push(structuredClone(removed));
  const excess = Math.max(st.history.length - limit, 0);
  st.history.splice(0, excess);
  return removed;
}

/** Ends the vote and returns the result. */
function closeVote(part: Partition, now: number): VoteResult | null {
  const vote = part.vote;
  if (!vote) return null;
  part.vote = null;
  const result: VoteResult = {
    tallies: tallies(vote),
    winner: voteWinner(vote),
    total: vote.ballots.length,
    options: vote.options,
    ended_at: toTimestamp(now),
  };
  part.last_vote = result;
  return structuredClone(result);
}

/** What a mutation did: events to publish after it, and which partitions it changed. */
interface Change<R> {
  value: R;
  events: QueueEvent[];
  changed: boolean;
  /** The partitions whose `queue.changed` goes out (default: the one the mutation was for). */
  keys?: string[];
}

const none = <R>(value: R): Change<R> => ({ value, events: [], changed: false });
const changed = <R>(value: R, ...events: QueueEvent[]): Change<R> => ({
  value,
  events,
  changed: true,
});

const lower = (s: string): string => s.toLowerCase();

/** Rounds half away from zero. */
function roundHalfAway(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

/** A service or the function that looks it up, as a function. */
function lookup(
  social: SocialSignals | (() => SocialSignals | null) | null,
): () => SocialSignals | null {
  return typeof social === "function" ? social : () => social;
}

export interface RequestQueueOptions {
  /**
   * How she feels about requesters, or where to look it up at each use (the module that provides
   * it may restart and provide a new one).
   */
  social?: SocialSignals | (() => SocialSignals | null) | null;
  store?: SettingsStore | null;
  publisher?: Publisher | null;
  clock?: Clock;
  /** The Spaces (phase 6); without them there is one queue. */
  spaces?: QueueSpaces | null;
}

/**
 * The request queue service. All methods are synchronous and quick; only persistence is async.
 *
 * Each Space has its own queue (phase 6): its items, its pause, its vote and its fairness. A
 * method that is about a queue takes the Space (identity's id; left out: the default one, the
 * primary Space's); one that names an item by id works on that item's queue. A request goes to
 * the Space it names, else the Space of its context, else the default one.
 *
 * Ordering of pending items, first criterion first:
 * 1. `priority` (moderator-set), higher first;
 * 2. manual slot from `moveItem`;
 * 3. fair lap: the item's place among its requester's own items, plus how many more items that
 *    requester got activated than the least served one, so nobody gets two turns before
 *    everybody got one;
 * 4. weight: affinity (`SocialSignals`) and upvotes, higher first;
 * 5. age, older first.
 */
export class RequestQueue {
  readonly config: QueueConfig;
  readonly #state: State = newState();
  #social: () => SocialSignals | null;
  #store: SettingsStore | null;
  #publisher: Publisher | null;
  #clock: Clock;
  #spaces: QueueSpaces | null;
  #dirty = false;
  /** When the debounced snapshot is due (epoch ms of the wall clock), if any change is waiting. */
  #saveAt: number | null = null;
  readonly #persistLock = new SerialQueue();

  constructor(
    config: QueueConfig = QueueConfigSchema.parse({}),
    options: RequestQueueOptions = {},
  ) {
    this.config = config;
    this.#social = lookup(options.social ?? null);
    this.#store = options.store ?? null;
    this.#publisher = options.publisher ?? null;
    this.#clock = options.clock ?? systemClock;
    this.#spaces = options.spaces ?? null;
  }

  withSocial(social: SocialSignals | (() => SocialSignals | null) | null): this {
    this.#social = lookup(social);
    return this;
  }

  withStore(store: SettingsStore | null): this {
    this.#store = store;
    return this;
  }

  withPublisher(publisher: Publisher): this {
    this.#publisher = publisher;
    return this;
  }

  withClock(clock: Clock): this {
    this.#clock = clock;
    return this;
  }

  withSpaces(spaces: QueueSpaces | null): this {
    this.#spaces = spaces;
    return this;
  }

  // ----- Spaces -----

  /** The Space of a context (`null`: a DM or a place it does not know; the default queue then). */
  spaceAt(context: ContextKey | null): string | null {
    if (context === null || this.#spaces === null) return null;
    return this.#spaces.spaceOf(context);
  }

  /** One Space's queue (`null`: the default one), as the commands of a place use it. */
  of(space: string | null): QueueView {
    const s = space;
    return {
      config: this.config,
      submit: (request) => this.submit({ ...request, space: request.space ?? s }),
      next: () => this.next(s),
      complete: (id) => this.complete(id),
      skip: (id) => this.skip(id),
      remove: (id) => this.remove(id),
      clear: () => this.clear(s),
      pause: () => this.pause(s),
      resume: () => this.resume(s),
      isPaused: () => this.isPaused(s),
      setPriority: (id, priority) => this.setPriority(id, priority),
      moveItem: (id, position) => this.moveItem(id, position),
      vote: (id, voter) => this.vote(id, voter),
      list: () => this.list(s),
      get: (id) => this.get(id),
      current: () => this.current(s),
      history: () => this.history(s),
      startVote: (options, durationMs) => this.startVote(options, durationMs, s),
      castVote: (account, choice) => this.castVote(account, choice, s),
      voteStatus: () => this.voteStatus(s),
      lastVote: () => this.lastVote(s),
      endVote: () => this.endVote(s),
    };
  }

  /**
   * The partition key of a Space: its id; without one, the default Space's (the primary), or
   * `""` when there is none (no Spaces at all).
   */
  key(space?: string | null): string {
    return space ?? this.#spaces?.primary() ?? "";
  }

  /** The Space a request goes to: the one it names, else its context's; `null`: the default. */
  #spaceOfRequest(req: SubmitRequest): string | null {
    if (req.space != null) return req.space;
    if (req.context == null || this.#spaces === null) return null;
    return this.#spaces.spaceOf(req.context);
  }

  #part(st: State, key: string): Partition {
    let part = st.spaces[key];
    if (part === undefined) {
      part = newPartition();
      st.spaces[key] = part;
    }
    return part;
  }

  #in(it: QueueItem, key: string): boolean {
    return this.key(it.space) === key;
  }

  #pendingOf(st: State, key: string, account: AccountRef): number {
    return st.items.filter(
      (i) => i.state === "pending" && this.#in(i, key) && sameAcc(i.requester, account),
    ).length;
  }

  #pendingTotal(st: State, key: string): number {
    return st.items.filter((i) => i.state === "pending" && this.#in(i, key)).length;
  }

  /**
   * Fair-queuing catch-up: a requester who had nothing pending starts level with the least served
   * requester that has something pending.
   */
  #catchUp(st: State, key: string, account: AccountRef): void {
    if (this.#pendingOf(st, key, account) > 0) return;
    const part = this.#part(st, key);
    let min: number | null = null;
    for (const i of st.items) {
      if (i.state !== "pending" || !this.#in(i, key)) continue;
      const served = servedOf(part, i.requester);
      if (min === null || served < min) min = served;
    }
    if (min !== null && servedOf(part, account) < min) setServed(part, account, min);
  }

  // ----- requests -----

  /** Adds a request. Throws when the requester is blocked, has too many pending or the queue is full. */
  submit(request: SubmitRequest): Submitted {
    const req: SubmitRequest = { ...request, text: request.text.trim() };
    if (req.text === "") throw QueueError.emptyText();
    if ([...req.text].length > this.config.max_text_chars) {
      throw QueueError.textTooLong(this.config.max_text_chars);
    }
    const kind = req.kind.trim().toLowerCase();
    req.kind = kind === "" ? guessKind(req.text) : [...kind].slice(0, 32).join("");
    if (this.#social()?.attitude(req.requester)?.blocked) throw QueueError.blocked();
    const space = this.#spaceOfRequest(req);
    const key = this.key(space);
    return this.#commit(key, (st, now) => {
      if (this.#pendingTotal(st, key) >= this.config.max_pending) {
        throw QueueError.queueFull(this.config.max_pending);
      }
      if (this.#pendingOf(st, key, req.requester) >= this.config.max_pending_per_user) {
        throw QueueError.userLimit(this.config.max_pending_per_user);
      }
      this.#catchUp(st, key, req.requester);
      const created = push(st, req, space, now);
      const position = this.#positionOf(st, key, created.id);
      return changed({ item: created, position });
    });
  }

  /**
   * Pops the best pending item of `space`'s queue and makes it active. `null` while paused or when
   * nothing is pending. Several items may be active at once; the consumer decides when to call
   * `next` again.
   */
  next(space?: string | null): QueueItem | null {
    const key = this.key(space);
    return this.#commit(key, (st) => {
      const part = this.#part(st, key);
      if (part.paused) return none<QueueItem | null>(null);
      const index = this.#ordered(st, key)[0];
      if (index === undefined) return none<QueueItem | null>(null);
      const target = item(st, index);
      target.state = "active";
      const activated = structuredClone(target);
      setServed(part, activated.requester, servedOf(part, activated.requester) + 1);
      return changed<QueueItem | null>(activated, {
        definition: Events.QueueItemActivated,
        data: itemJson(activated, null),
      });
    });
  }

  /** Marks an active item done. */
  complete(id: ItemId): QueueItem {
    return this.#finish(id, "done", ["active"]);
  }

  /** Skips a pending or active item. */
  skip(id: ItemId): QueueItem {
    return this.#finish(id, "skipped", ["pending", "active"]);
  }

  /** Removes a pending or active item. */
  remove(id: ItemId): QueueItem {
    return this.#finish(id, "removed", ["pending", "active"]);
  }

  #finish(id: ItemId, to: ItemState, allowedFrom: readonly ItemState[]): QueueItem {
    return this.#commit(this.#keyOfItem(id), (st) => {
      const index = indexOfItem(st, id);
      if (!allowedFrom.includes(item(st, index).state)) throw QueueError.wrongState(id);
      return changed(finishItem(st, index, to, this.config.history_limit));
    });
  }

  /** The partition of an item (the default one for an unknown id: the mutation then throws). */
  #keyOfItem(id: ItemId): string {
    const found = this.#state.items.find((i) => i.id === id);
    return this.key(found?.space ?? null);
  }

  /** Removes every pending item of `space`'s queue (active ones keep running). Returns how many. */
  clear(space?: string | null): number {
    const key = this.key(space);
    return this.#commit(key, (st) => {
      let count = 0;
      for (;;) {
        const index = st.items.findIndex((i) => i.state === "pending" && this.#in(i, key));
        if (index < 0) break;
        finishItem(st, index, "removed", this.config.history_limit);
        count++;
      }
      return count > 0 ? changed(count) : none(count);
    });
  }

  /** Stops `next` from handing out items of `space`'s queue. Submitting still works. */
  pause(space?: string | null): void {
    this.#setPaused(this.key(space), true);
  }

  resume(space?: string | null): void {
    this.#setPaused(this.key(space), false);
  }

  #setPaused(key: string, paused: boolean): void {
    this.#commit(key, (st) => {
      const part = this.#part(st, key);
      if (part.paused === paused) return none(undefined);
      part.paused = paused;
      return changed(undefined);
    });
  }

  isPaused(space?: string | null): boolean {
    return this.#state.spaces[this.key(space)]?.paused ?? false;
  }

  /** Sets the moderator priority (higher goes first) of a pending item. */
  setPriority(id: ItemId, priority: number): void {
    this.#commit(this.#keyOfItem(id), (st) => {
      const index = indexOfItem(st, id);
      if (item(st, index).state !== "pending") throw QueueError.wrongState(id);
      item(st, index).priority = priority;
      return changed(undefined);
    });
  }

  /**
   * Moves a pending item to a 0-based `position` among the pending items of its queue. The item's
   * priority is adjusted only as far as needed to make it stay there, and all pending items of
   * that queue get a manual slot, so fairness no longer reorders what was arranged by hand.
   */
  moveItem(id: ItemId, position: number): void {
    const key = this.#keyOfItem(id);
    this.#commit(key, (st) => {
      const index = indexOfItem(st, id);
      if (item(st, index).state !== "pending") throw QueueError.wrongState(id);
      const order = this.#ordered(st, key).filter((i) => i !== index);
      const at = Math.min(position, order.length);
      const prev = at > 0 ? item(st, order[at - 1] as number).priority : null;
      const nextIndex = order[at];
      const next = nextIndex === undefined ? null : item(st, nextIndex).priority;
      const lo = next ?? -(2 ** 31);
      const hi = Math.max(prev ?? 2 ** 31 - 1, lo);
      const moved = item(st, index);
      moved.priority = Math.min(Math.max(moved.priority, lo), hi);
      order.splice(at, 0, index);
      order.forEach((i, slot) => {
        item(st, i).slot = slot;
      });
      return changed(undefined);
    });
  }

  /** Upvotes a pending item once per account; returns the new count. */
  vote(id: ItemId, voter: AccountRef): number {
    return this.#commit(this.#keyOfItem(id), (st) => {
      const target = item(st, indexOfItem(st, id));
      if (target.state !== "pending") throw QueueError.wrongState(id);
      if (target.voters.some((v) => sameAcc(v, voter))) return none(target.votes);
      target.voters.push(voter);
      target.votes = target.voters.length;
      return changed(target.votes);
    });
  }

  // ----- queries -----

  /** Active items first, then pending items in the order `next` will take them, of `space`'s queue. */
  list(space?: string | null): QueueItem[] {
    return this.#listing(this.#state, this.key(space)).map(([i]) => i);
  }

  get(id: ItemId): QueueItem | null {
    const st = this.#state;
    const found = [...st.items, ...st.history].find((i) => i.id === id);
    return found ? structuredClone(found) : null;
  }

  /** The first active item of `space`'s queue. */
  current(space?: string | null): QueueItem | null {
    const key = this.key(space);
    const found = this.#state.items.find((i) => i.state === "active" && this.#in(i, key));
    return found ? structuredClone(found) : null;
  }

  /** Finished items, newest last; of `space`'s queue when given, else of every queue. */
  history(space?: string | null): QueueItem[] {
    const all = this.#state.history;
    if (space === undefined) return structuredClone(all);
    const key = this.key(space);
    return structuredClone(all.filter((i) => this.#in(i, key)));
  }

  // ----- voting mode -----

  /** Starts a vote of `durationMs` in `space`'s queue. Needs 2 or more distinct options. */
  startVote(options: readonly string[], durationMs: number, space?: string | null): void {
    const clean: string[] = [];
    for (const raw of options) {
      const option = raw.trim();
      if (option === "" || clean.some((o) => lower(o) === lower(option))) continue;
      clean.push(option);
    }
    if (clean.length < 2 || clean.length > this.config.max_vote_options) {
      throw QueueError.badVote(`need 2 to ${this.config.max_vote_options} distinct options`);
    }
    if (durationMs <= 0 || Math.floor(durationMs / 1000) > this.config.max_vote_seconds) {
      throw QueueError.badVote(`duration must be 1 to ${this.config.max_vote_seconds} seconds`);
    }
    const key = this.key(space);
    this.#commit(key, (st, now) => {
      const part = this.#part(st, key);
      if (part.vote) throw QueueError.voteRunning();
      part.vote = {
        options: clean,
        started_at: toTimestamp(now),
        ends_at: toTimestamp(now + durationMs),
        ballots: [],
      };
      return changed(undefined);
    });
  }

  /**
   * Records the account's ballot for the option named by `choice`: a 1-based number or the
   * option text (case-insensitive). The latest ballot of an account wins. Returns the chosen
   * option.
   */
  castVote(account: AccountRef, choice: string, space?: string | null): string {
    const text = choice.trim();
    const key = this.key(space);
    return this.#commit(key, (st, now) => {
      const vote = this.#part(st, key).vote;
      if (!vote || timestampMs(vote.ends_at) <= now) throw QueueError.noVote();
      let option = -1;
      if (/^\d+$/.test(text)) {
        const n = Number(text) - 1;
        if (n >= 0 && n < vote.options.length) option = n;
      }
      if (option < 0) option = vote.options.findIndex((o) => lower(o) === lower(text));
      if (option < 0) throw QueueError.unknownOption(text);
      const ballot: Ballot = { account, option, at: toTimestamp(now) };
      const chosen = vote.options[option] as string;
      const existing = vote.ballots.find((b) => sameAcc(b.account, account));
      if (existing) {
        if (existing.option === option) return none(chosen);
        existing.option = ballot.option;
        existing.at = ballot.at;
      } else {
        vote.ballots.push(ballot);
      }
      return changed(chosen);
    });
  }

  /** The running vote of `space`'s queue, if any. */
  voteStatus(space?: string | null): VoteState | null {
    const vote = this.#state.spaces[this.key(space)]?.vote ?? null;
    return vote ? structuredClone(vote) : null;
  }

  /** Result of the most recent finished vote of `space`'s queue. */
  lastVote(space?: string | null): VoteResult | null {
    const last = this.#state.spaces[this.key(space)]?.last_vote ?? null;
    return last ? structuredClone(last) : null;
  }

  /** Ends the running vote of `space`'s queue now. */
  endVote(space?: string | null): VoteResult {
    const key = this.key(space);
    return this.#commit(key, (st, now) => {
      if (!this.#part(st, key).vote) throw QueueError.noVote();
      return this.#finishVote(st, key, now);
    });
  }

  /** Ends the votes whose time is up, in every queue. Called periodically by `run`. */
  tick(): VoteResult | null {
    let last: VoteResult | null = null;
    for (const [key, part] of Object.entries(this.#state.spaces)) {
      if (!part.vote) continue;
      const result = this.#commit(key, (st, now) => {
        const vote = this.#part(st, key).vote;
        if (vote && timestampMs(vote.ends_at) <= now) return this.#finishVote(st, key, now);
        return none<VoteResult | null>(null);
      });
      if (result !== null) last = result;
    }
    return last;
  }

  #finishVote(st: State, key: string, now: number): Change<VoteResult> {
    const result = closeVote(this.#part(st, key), now) as VoteResult;
    const event: QueueEvent = {
      definition: Events.QueueVoteResult,
      data: {
        options: result.options,
        tallies: result.tallies,
        winner: result.winner,
        winner_option: winnerOption(result),
        total: result.total,
        ended_at: result.ended_at,
      },
    };
    const winner = winnerOption(result);
    if (this.config.vote_enqueue_winner && winner !== null) {
      push(
        st,
        {
          requester: { platform: "queue", id: "vote" },
          requesterName: "投票",
          kind: "vote",
          text: winner,
          priority: this.config.vote_winner_priority,
        },
        key === "" ? null : key,
        now,
      );
    }
    return changed(result, event);
  }

  // ----- persistence -----

  /** The snapshot: version 2, with the default Space's partition at the top as well. */
  #snapshot(): JsonValue {
    const st = this.#state;
    const own = st.spaces[this.key()] ?? newPartition();
    return structuredClone({
      next_id: st.next_id,
      items: st.items,
      history: st.history,
      paused: own.paused,
      served: own.served,
      vote: own.vote,
      last_vote: own.last_vote,
      spaces: st.spaces,
    }) as unknown as JsonValue;
  }

  /** Writes the snapshot to the settings store (no-op without a store). */
  async persist(): Promise<void> {
    const store = this.#store;
    if (!store) return;
    await this.#persistLock.run(async () => {
      this.#dirty = false;
      const snapshot = this.#snapshot();
      try {
        await store.set(STATE_PROFILE, STATE_KEY, snapshot);
      } catch (error) {
        this.#dirty = true;
        throw error;
      }
    });
  }

  /**
   * Loads the snapshot from the settings store, if one exists. Returns whether state was
   * restored. Throws (and leaves the queue alone) on a corrupt snapshot. A snapshot of before
   * Spaces is read as it is: its pause, fairness and vote become the default Space's, and each
   * item goes to the Space of its context, else the default Space.
   */
  async restore(): Promise<boolean> {
    const store = this.#store;
    if (!store) return false;
    const value = await store.get(STATE_PROFILE, STATE_KEY);
    if (value === null) return false;
    const restored = QueueSnapshotSchema.parse(value);
    const own = this.key();
    const place = (it: z.output<typeof ItemSchema>): QueueItem => {
      const space =
        it.space !== undefined
          ? it.space
          : it.context === null || this.#spaces === null
            ? null
            : this.#spaces.spaceOf(it.context);
      return { ...it, space: space ?? (own === "" ? null : own) } as QueueItem;
    };
    let spaces: Record<string, Partition>;
    if (restored.spaces !== undefined) {
      spaces = { ...restored.spaces };
      // A queue kept while there was no Space is the default Space's once there is one.
      const loose = spaces[""];
      if (loose !== undefined && own !== "" && spaces[own] === undefined) {
        spaces[own] = loose;
        delete spaces[""];
      }
    } else {
      spaces = {
        [own]: {
          paused: restored.paused,
          served: restored.served,
          vote: restored.vote,
          last_vote: restored.last_vote,
        },
      };
    }
    const st = this.#state;
    st.next_id = restored.next_id;
    st.items = restored.items.map(place);
    st.history = restored.history.map(place);
    st.spaces = spaces;
    const keys = new Set([own, ...Object.keys(spaces), ...st.items.map((i) => this.key(i.space))]);
    this.#emit([...keys].map((k) => this.#changedEvent(st, k)));
    return true;
  }

  /**
   * Background loop: closes expired votes and writes debounced snapshots until `signal` aborts
   * (then writes a final one if needed).
   */
  async run(signal: AbortSignal): Promise<void> {
    for await (const _ of interval(Math.max(this.config.tick_ms, 10), signal)) {
      this.tick();
      if (this.#saveAt !== null && Date.now() >= this.#saveAt) {
        this.#saveAt = null;
        try {
          await this.persist();
        } catch (error) {
          log.warn({ error: errorMessage(error) }, "could not save the queue; retrying");
          this.#saveAt = Date.now() + 5_000;
        }
      }
    }
    if (this.#dirty) {
      try {
        await this.persist();
      } catch (error) {
        log.warn({ error: errorMessage(error) }, "could not save the queue on shutdown");
      }
    }
  }

  // ----- internals -----

  /**
   * Runs a mutation of the queue `key`, then marks the state dirty and publishes that queue's
   * `queue.changed` and the mutation's own events. A throwing mutation leaves the state as it was.
   */
  #commit<R>(key: string, f: (st: State, now: number) => Change<R>): R {
    const st = this.#state;
    const change = f(st, this.#clock.now());
    if (!change.changed) return change.value;
    const events = [
      ...(change.keys ?? [key]).map((k) => this.#changedEvent(st, k)),
      ...change.events,
    ];
    this.#dirty = true;
    this.#saveAt ??= Date.now() + this.config.persist_debounce_ms;
    this.#emit(events);
    return change.value;
  }

  #emit(events: QueueEvent[]): void {
    if (!this.#publisher) return;
    for (const event of events) {
      if (event.space === undefined) this.#publisher(event.definition, event.data);
      else this.#publisher(event.definition, event.data, { space_id: event.space });
    }
  }

  #affinity(account: AccountRef): number {
    // Weight counts plain affinity only: bond stacked past 100 does not buy a queue place.
    return Math.min(this.#social()?.attitude(account)?.affinity ?? 0, 100);
  }

  /** Indexes into `st.items` of the pending items of the queue `key`, in service order. */
  #ordered(st: State, key: string): number[] {
    const part = st.spaces[key] ?? newPartition();
    const byUser = new Map<string, { account: AccountRef; indexes: number[] }>();
    st.items.forEach((it, index) => {
      if (it.state !== "pending" || !this.#in(it, key)) return;
      const k = accKey(it.requester);
      const entry = byUser.get(k);
      if (entry) entry.indexes.push(index);
      else byUser.set(k, { account: it.requester, indexes: [index] });
    });
    let minServed = Number.POSITIVE_INFINITY;
    for (const { account } of byUser.values())
      minServed = Math.min(minServed, servedOf(part, account));
    if (!Number.isFinite(minServed)) minServed = 0;
    const slotOf = (i: QueueItem): number => i.slot ?? Number.MAX_SAFE_INTEGER;
    const created = (i: QueueItem): number => timestampMs(i.created_at);
    const keyed: Array<{
      priority: number;
      slot: number;
      lap: number;
      weight: number;
      created: number;
      id: number;
      index: number;
    }> = [];
    for (const { account, indexes } of byUser.values()) {
      indexes.sort((a, b) => {
        const x = item(st, a);
        const y = item(st, b);
        return (
          y.priority - x.priority || slotOf(x) - slotOf(y) || created(x) - created(y) || x.id - y.id
        );
      });
      const base = servedOf(part, account) - minServed;
      const affinity = this.#affinity(account);
      indexes.forEach((index, place) => {
        const it = item(st, index);
        const f = Math.fround;
        const weight = roundHalfAway(
          f(
            f(f(f(affinity) / f(10)) * f(this.config.affinity_weight)) +
              f(f(it.votes) * f(this.config.vote_weight)),
          ),
        );
        keyed.push({
          priority: it.priority,
          slot: slotOf(it),
          lap: base + place,
          weight,
          created: created(it),
          id: it.id,
          index,
        });
      });
    }
    keyed.sort(
      (a, b) =>
        b.priority - a.priority ||
        a.slot - b.slot ||
        a.lap - b.lap ||
        b.weight - a.weight ||
        a.created - b.created ||
        a.id - b.id ||
        a.index - b.index,
    );
    return keyed.map((k) => k.index);
  }

  #positionOf(st: State, key: string, id: ItemId): number {
    const position = this.#ordered(st, key).findIndex((i) => item(st, i).id === id);
    return position < 0 ? 0 : position + 1;
  }

  /** Active items, then pending items with their 1-based place, of the queue `key`. */
  #listing(st: State, key: string): Array<[QueueItem, number | null]> {
    const out: Array<[QueueItem, number | null]> = st.items
      .filter((i) => i.state === "active" && this.#in(i, key))
      .map((i) => [structuredClone(i), null]);
    this.#ordered(st, key).forEach((i, place) => {
      out.push([structuredClone(item(st, i)), place + 1]);
    });
    return out;
  }

  /** `queue.changed` of the queue `key`: its items, its pause, its vote. */
  #changedEvent(st: State, key: string): QueueEvent {
    const items = this.#listing(st, key).map(([it, place]) => itemJson(it, place));
    const part = st.spaces[key] ?? newPartition();
    const payload: JsonObject = { items, paused: part.paused };
    if (part.vote) {
      payload.vote = {
        options: part.vote.options,
        tallies: tallies(part.vote),
        total: part.vote.ballots.length,
        started_at: part.vote.started_at,
        ends_at: part.vote.ends_at,
      };
    }
    // The queue of no Space (`""`, a Core without places) says none.
    return {
      definition: Events.QueueChanged,
      data: payload,
      ...(key === "" ? {} : { space: key }),
    };
  }
}

/** Item as shown to overlays and consumers (voter list and Space left out). */
function itemJson(it: QueueItem, position: number | null): JsonObject {
  return {
    id: it.id,
    requester: it.requester as unknown as JsonObject,
    requester_name: it.requester_name,
    kind: it.kind,
    text: it.text,
    context: it.context as unknown as JsonObject | null,
    created_at: it.created_at,
    priority: it.priority,
    votes: it.votes,
    state: it.state,
    position,
  };
}
