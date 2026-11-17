import { errorMessage, getLogger, interval, SerialQueue } from "@miyoria/runtime/kernel";
import type { SettingsStore } from "@miyoria/store";
import {
  type AccountRef,
  type AnyEventDefinition,
  type Clock,
  Events,
  type JsonObject,
  type JsonValue,
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
}

/** A new item and where it stands. */
export interface Submitted {
  item: QueueItem;
  /** 1-based place among pending items. */
  position: number;
}

interface State {
  next_id: ItemId;
  /** Pending and active items, in insertion order. */
  items: QueueItem[];
  /** Finished items, oldest first. */
  history: QueueItem[];
  paused: boolean;
  /** How many items each requester got activated (fair queuing credit). */
  served: Array<[AccountRef, number]>;
  vote: VoteState | null;
  last_vote: VoteResult | null;
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

function newState(): State {
  return {
    next_id: 0,
    items: [],
    history: [],
    paused: false,
    served: [],
    vote: null,
    last_vote: null,
  };
}

// --- snapshot schema (serde JSON of the Rust `State`; every field defaults) ---

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
export const QueueSnapshotSchema = z.object({
  next_id: z.number().default(0),
  items: z.array(ItemSchema).default([]),
  history: z.array(ItemSchema).default([]),
  paused: z.boolean().default(false),
  served: z.array(z.tuple([AccountRefSchema, z.number()])).default([]),
  vote: VoteSchema.nullable().default(null),
  last_vote: VoteResultSchema.nullable().default(null),
});

const accKey = (a: AccountRef): string => `${a.platform}\u0000${a.id}`;
const sameAcc = (a: AccountRef, b: AccountRef): boolean =>
  a.platform === b.platform && a.id === b.id;

function servedOf(st: State, account: AccountRef): number {
  return st.served.find(([a]) => sameAcc(a, account))?.[1] ?? 0;
}

function setServed(st: State, account: AccountRef, n: number): void {
  const entry = st.served.find(([a]) => sameAcc(a, account));
  if (entry) entry[1] = n;
  else st.served.push([account, n]);
}

function indexOfItem(st: State, id: ItemId): number {
  const index = st.items.findIndex((i) => i.id === id);
  if (index < 0) throw QueueError.notFound(id);
  return index;
}

function item(st: State, index: number): QueueItem {
  return st.items[index] as QueueItem;
}

function pendingOf(st: State, account: AccountRef): number {
  return st.items.filter((i) => i.state === "pending" && sameAcc(i.requester, account)).length;
}

function pendingTotal(st: State): number {
  return st.items.filter((i) => i.state === "pending").length;
}

/**
 * Fair-queuing catch-up: a requester who had nothing pending starts level with the least served
 * requester that has something pending.
 */
function catchUp(st: State, account: AccountRef): void {
  if (pendingOf(st, account) > 0) return;
  let min: number | null = null;
  for (const i of st.items) {
    if (i.state !== "pending") continue;
    const served = servedOf(st, i.requester);
    if (min === null || served < min) min = served;
  }
  if (min !== null && servedOf(st, account) < min) setServed(st, account, min);
}

function push(st: State, req: SubmitRequest, now: number): QueueItem {
  st.next_id += 1;
  const created: QueueItem = {
    id: st.next_id,
    requester: req.requester,
    requester_name: req.requesterName,
    kind: req.kind,
    text: req.text,
    context: req.context ?? null,
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
function closeVote(st: State, now: number): VoteResult | null {
  const vote = st.vote;
  if (!vote) return null;
  st.vote = null;
  const result: VoteResult = {
    tallies: tallies(vote),
    winner: voteWinner(vote),
    total: vote.ballots.length,
    options: vote.options,
    ended_at: toTimestamp(now),
  };
  st.last_vote = result;
  return structuredClone(result);
}

/** What a mutation did: events to publish after it. */
interface Change<R> {
  value: R;
  events: QueueEvent[];
  changed: boolean;
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
}

/**
 * The request queue service. All methods are synchronous and quick; only persistence is async.
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
    return this.#commit((st, now) => {
      if (pendingTotal(st) >= this.config.max_pending) {
        throw QueueError.queueFull(this.config.max_pending);
      }
      if (pendingOf(st, req.requester) >= this.config.max_pending_per_user) {
        throw QueueError.userLimit(this.config.max_pending_per_user);
      }
      catchUp(st, req.requester);
      const created = push(st, req, now);
      const position = this.#positionOf(st, created.id);
      return changed({ item: created, position });
    });
  }

  /**
   * Pops the best pending item and makes it active. `null` while paused or when nothing is
   * pending. Several items may be active at once; the consumer decides when to call `next`
   * again.
   */
  next(): QueueItem | null {
    return this.#commit((st) => {
      if (st.paused) return none<QueueItem | null>(null);
      const index = this.#ordered(st)[0];
      if (index === undefined) return none<QueueItem | null>(null);
      const target = item(st, index);
      target.state = "active";
      const activated = structuredClone(target);
      setServed(st, activated.requester, servedOf(st, activated.requester) + 1);
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
    return this.#commit((st) => {
      const index = indexOfItem(st, id);
      if (!allowedFrom.includes(item(st, index).state)) throw QueueError.wrongState(id);
      return changed(finishItem(st, index, to, this.config.history_limit));
    });
  }

  /** Removes every pending item (active ones keep running). Returns how many. */
  clear(): number {
    return this.#commit((st) => {
      let count = 0;
      for (;;) {
        const index = st.items.findIndex((i) => i.state === "pending");
        if (index < 0) break;
        finishItem(st, index, "removed", this.config.history_limit);
        count++;
      }
      return count > 0 ? changed(count) : none(count);
    });
  }

  /** Stops `next` from handing out items. Submitting still works. */
  pause(): void {
    this.#setPaused(true);
  }

  resume(): void {
    this.#setPaused(false);
  }

  #setPaused(paused: boolean): void {
    this.#commit((st) => {
      if (st.paused === paused) return none(undefined);
      st.paused = paused;
      return changed(undefined);
    });
  }

  isPaused(): boolean {
    return this.#state.paused;
  }

  /** Sets the moderator priority (higher goes first) of a pending item. */
  setPriority(id: ItemId, priority: number): void {
    this.#commit((st) => {
      const index = indexOfItem(st, id);
      if (item(st, index).state !== "pending") throw QueueError.wrongState(id);
      item(st, index).priority = priority;
      return changed(undefined);
    });
  }

  /**
   * Moves a pending item to a 0-based `position` among pending items. The item's priority is
   * adjusted only as far as needed to make it stay there, and all pending items get a manual
   * slot, so fairness no longer reorders what was arranged by hand.
   */
  moveItem(id: ItemId, position: number): void {
    this.#commit((st) => {
      const index = indexOfItem(st, id);
      if (item(st, index).state !== "pending") throw QueueError.wrongState(id);
      const order = this.#ordered(st).filter((i) => i !== index);
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
    return this.#commit((st) => {
      const target = item(st, indexOfItem(st, id));
      if (target.state !== "pending") throw QueueError.wrongState(id);
      if (target.voters.some((v) => sameAcc(v, voter))) return none(target.votes);
      target.voters.push(voter);
      target.votes = target.voters.length;
      return changed(target.votes);
    });
  }

  // ----- queries -----

  /** Active items first, then pending items in the order `next` will take them. */
  list(): QueueItem[] {
    return this.#listing(this.#state).map(([i]) => i);
  }

  get(id: ItemId): QueueItem | null {
    const st = this.#state;
    const found = [...st.items, ...st.history].find((i) => i.id === id);
    return found ? structuredClone(found) : null;
  }

  /** The first active item. */
  current(): QueueItem | null {
    const found = this.#state.items.find((i) => i.state === "active");
    return found ? structuredClone(found) : null;
  }

  /** Finished items, newest last. */
  history(): QueueItem[] {
    return structuredClone(this.#state.history);
  }

  // ----- voting mode -----

  /** Starts a vote of `durationMs`. Needs 2 or more distinct options. */
  startVote(options: readonly string[], durationMs: number): void {
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
    this.#commit((st, now) => {
      if (st.vote) throw QueueError.voteRunning();
      st.vote = {
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
  castVote(account: AccountRef, choice: string): string {
    const text = choice.trim();
    return this.#commit((st, now) => {
      const vote = st.vote;
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

  /** The running vote, if any. */
  voteStatus(): VoteState | null {
    return this.#state.vote ? structuredClone(this.#state.vote) : null;
  }

  /** Result of the most recent finished vote. */
  lastVote(): VoteResult | null {
    return this.#state.last_vote ? structuredClone(this.#state.last_vote) : null;
  }

  /** Ends the running vote now. */
  endVote(): VoteResult {
    return this.#commit((st, now) => {
      if (!st.vote) throw QueueError.noVote();
      return this.#finishVote(st, now);
    });
  }

  /** Ends the vote if its time is up. Called periodically by `run`. */
  tick(): VoteResult | null {
    return this.#commit((st, now) => {
      if (st.vote && timestampMs(st.vote.ends_at) <= now) return this.#finishVote(st, now);
      return none<VoteResult | null>(null);
    });
  }

  #finishVote(st: State, now: number): Change<VoteResult> {
    const result = closeVote(st, now) as VoteResult;
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
        now,
      );
    }
    return changed(result, event);
  }

  // ----- persistence -----

  /** Writes the snapshot to the settings store (no-op without a store). */
  async persist(): Promise<void> {
    const store = this.#store;
    if (!store) return;
    await this.#persistLock.run(async () => {
      this.#dirty = false;
      const snapshot = structuredClone(this.#state) as unknown as JsonValue;
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
   * restored. Throws (and leaves the queue alone) on a corrupt snapshot.
   */
  async restore(): Promise<boolean> {
    const store = this.#store;
    if (!store) return false;
    const value = await store.get(STATE_PROFILE, STATE_KEY);
    if (value === null) return false;
    const restored = QueueSnapshotSchema.parse(value);
    const st = this.#state;
    st.next_id = restored.next_id;
    st.items = restored.items;
    st.history = restored.history;
    st.paused = restored.paused;
    st.served = restored.served;
    st.vote = restored.vote;
    st.last_vote = restored.last_vote;
    this.#emit([this.#changedEvent(st)]);
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
   * Runs a mutation, then marks the state dirty and publishes `queue.changed` and the
   * mutation's own events. A throwing mutation leaves the state as it was.
   */
  #commit<R>(f: (st: State, now: number) => Change<R>): R {
    const st = this.#state;
    const change = f(st, this.#clock.now());
    if (!change.changed) return change.value;
    const events = [this.#changedEvent(st), ...change.events];
    this.#dirty = true;
    this.#saveAt ??= Date.now() + this.config.persist_debounce_ms;
    this.#emit(events);
    return change.value;
  }

  #emit(events: QueueEvent[]): void {
    if (!this.#publisher) return;
    for (const event of events) this.#publisher(event.definition, event.data);
  }

  #affinity(account: AccountRef): number {
    // Weight counts plain affinity only: bond stacked past 100 does not buy a queue place.
    return Math.min(this.#social()?.attitude(account)?.affinity ?? 0, 100);
  }

  /** Indexes into `st.items` of the pending items, in service order. */
  #ordered(st: State): number[] {
    const byUser = new Map<string, { account: AccountRef; indexes: number[] }>();
    st.items.forEach((it, index) => {
      if (it.state !== "pending") return;
      const key = accKey(it.requester);
      const entry = byUser.get(key);
      if (entry) entry.indexes.push(index);
      else byUser.set(key, { account: it.requester, indexes: [index] });
    });
    let minServed = Number.POSITIVE_INFINITY;
    for (const { account } of byUser.values())
      minServed = Math.min(minServed, servedOf(st, account));
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
      const base = servedOf(st, account) - minServed;
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

  #positionOf(st: State, id: ItemId): number {
    const position = this.#ordered(st).findIndex((i) => item(st, i).id === id);
    return position < 0 ? 0 : position + 1;
  }

  /** Active items, then pending items with their 1-based place. */
  #listing(st: State): Array<[QueueItem, number | null]> {
    const out: Array<[QueueItem, number | null]> = st.items
      .filter((i) => i.state === "active")
      .map((i) => [structuredClone(i), null]);
    this.#ordered(st).forEach((i, place) => {
      out.push([structuredClone(item(st, i)), place + 1]);
    });
    return out;
  }

  #changedEvent(st: State): QueueEvent {
    const items = this.#listing(st).map(([it, place]) => itemJson(it, place));
    const payload: JsonObject = { items, paused: st.paused };
    if (st.vote) {
      payload.vote = {
        options: st.vote.options,
        tallies: tallies(st.vote),
        total: st.vote.ballots.length,
        started_at: st.vote.started_at,
        ends_at: st.vote.ends_at,
      };
    }
    return { definition: Events.QueueChanged, data: payload };
  }
}

/** Item as shown to overlays and consumers (voter list left out). */
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
