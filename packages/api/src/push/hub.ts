// The push hub (v5-architecture §11.4): follows the views that open streams are watching, builds
// each again when something it depends on happened (a bus topic) or its tick came, and hands a
// stream only the views whose value really changed.
//
// * A view is one `Watch` (`watch.ts`): the polled route's own checks and answer. Streams whose
//   watch has the same key share the view, so a crowd on the public page costs one build per
//   change, and a member's own view (their account is in its key) reaches only their streams.
// * Each change gets the next number of this hub (`seq`); an event's id is `<run>.<seq>.<topics>`:
//   which run of the Core it is from, how far the stream was when it was sent, and a hash of what
//   the stream was following. A reconnect with that id gets only the views that changed after
//   `seq`, provided the run and the topics are the same and each view was followed all along (a
//   view nobody watches is kept `PUSH_LINGER_MS`, then forgotten): otherwise every value again.
// * What a stream has not sent yet is one entry per view (the newest value wins), so a slow reader
//   never makes it grow; one whose oldest unsent change is older than `PUSH_SLOW_MS` is dropped.
// * Limits: streams per client address, per account and in all; every stream's caller and topics
//   are checked again every `RECHECK_MS`, and the stream ends when that fails.

import type { PushEvent, PushTopic } from "@miyoria/contracts/api";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import { ApiError } from "../errors.js";
import { RECHECK_MS } from "../recheck.js";
import type { Watch } from "../watch.js";

const log = getLogger("api.push");

/** Streams one client address may hold open (a few tabs; every push stream counts). */
export const PUSH_STREAMS_PER_CLIENT = 6;
/** Streams one logged-in account may hold open, wherever from. */
export const PUSH_STREAMS_PER_ACCOUNT = 6;
/** Streams of everyone together. */
export const PUSH_STREAMS_TOTAL = 256;
/** A change waits this long for the ones right after it before the views are built again. */
export const PUSH_SETTLE_MS = 150;
/** How long a view nobody watches is still followed: a reconnect within it resumes. */
export const PUSH_LINGER_MS = 60_000;
/** A stream whose oldest unsent change is this old belongs to a reader that stopped: dropped. */
export const PUSH_SLOW_MS = 30_000;
/** How often the hub looks over its streams and views. */
export const PUSH_SWEEP_MS = 5_000;
/**
 * A stream with nothing to say sends a `ping` event this often: a client sees it (a comment it
 * would not), so it can tell a quiet stream from a dead one. Well under a tunnel's idle timeout.
 */
export const PUSH_PING_MS = 15_000;

/** One topic a stream asked for: `songs`, or `songs~<space>`. */
export interface Subscription {
  topic: PushTopic;
  param: string | null;
}

/** When a topic's views may have changed. */
export interface TopicTiming {
  /** Bus topic patterns after which they are built again (after `PUSH_SETTLE_MS`). */
  triggers: readonly string[];
  /** Built again this often anyway, for changes no event announces; `null`: never. */
  everyMs: number | null;
}

/** What a stream asks the hub for, its viewer's checks already done. */
export interface StreamRequest {
  /** The client address (`PublicSide.client`). */
  client: string;
  /** The logged-in account (`platform:id`), `null` on a public stream. */
  account: string | null;
  /** Each topic asked for, with its watch, or the refusal its polled route would answer. */
  subscriptions: Array<{ sub: Subscription; watch: Watch<unknown> | Refusal }>;
  /** `Last-Event-ID`, as sent. */
  lastEventId: string | undefined;
  /**
   * Whether the viewer may still have these: the session, and each topic checked again (`false`
   * when one is refused now or names another view). Asked every `RECHECK_MS`.
   */
  recheck: () => Promise<boolean>;
  /** Ends the connection at once (a reader that stopped reading cannot be told to stop). */
  drop: () => void;
  /** The request's: the client went away. */
  signal?: AbortSignal;
}

/** A topic its polled route would refuse: the status and the sentence. */
export interface Refusal {
  refused: { status: number; message: string };
}

/** One event to write and its SSE id (`null`: none, the previous id still holds). */
export interface Outgoing {
  event: PushEvent;
  id: string | null;
}

/** What a reservation gives back. */
export interface Ticket {
  release(): void;
}

export interface HubOptions {
  /** Epoch ms. */
  now: () => number;
  /** This run's name in every event id. */
  run?: string;
  /** Start the settle and sweep timers (`false` in tests, which call `flush` and `sweep`). */
  timers?: boolean;
  limits?: Partial<{ perClient: number; perAccount: number; total: number }>;
  /** How often an idle stream pings (`PUSH_PING_MS`). */
  pingMs?: number;
}

interface View {
  id: string;
  topic: PushTopic;
  timing: TopicTiming;
  build: () => unknown;
  /** The value as JSON (what is compared), `null` before the first build or after a failure. */
  json: string | null;
  data: unknown;
  failure: { status: number; message: string } | null;
  /** The hub's `seq` when this view began to be followed. */
  since: number;
  /** The `seq` of its last change. */
  changed: number;
  builtAt: number;
  viewers: Set<Stream>;
  idleSince: number | null;
  dirty: boolean;
  /** Settles once the first build is done. */
  ready: Promise<void>;
}

export const isRefusal = (w: Watch<unknown> | Refusal): w is Refusal => "refused" in w;

/** FNV-1a of `text`, in base 36: short and stable, not a secret. */
export function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** What a failed build says, as a refusal: the route's own status, never an internal message. */
function failureOf(error: unknown): { status: number; message: string } {
  if (error instanceof ApiError) return { status: error.status, message: error.message };
  log.warn({ error: errorMessage(error) }, "a pushed view could not be built");
  return { status: 500, message: "something went wrong" };
}

/** One open stream. */
class Stream {
  /** Each subscription with its view (`null`: refused when it opened). */
  readonly subs: Array<{ sub: Subscription; view: View | null; refusal: Refusal | null }>;
  /** Views with a change not sent yet, and since when. */
  readonly pending = new Map<View, number>();
  closed = false;
  checkedAt: number;
  #wake: (() => void) | null = null;

  constructor(
    readonly request: StreamRequest,
    readonly ticket: Ticket,
    readonly hash: string,
    subs: Stream["subs"],
    now: number,
  ) {
    this.subs = subs;
    this.checkedAt = now;
  }

  offer(view: View, now: number): void {
    if (this.closed) return;
    if (!this.pending.has(view)) this.pending.set(view, now);
    this.wake();
  }

  wake(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  /** Until a change (or the close) wakes it: `true`; `false` after `ms` of nothing. */
  wait(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#wake = null;
        resolve(false);
      }, ms);
      timer.unref?.();
      this.#wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });
  }

  /** How long its oldest unsent change has waited. */
  behind(now: number): number {
    let oldest = now;
    for (const at of this.pending.values()) oldest = Math.min(oldest, at);
    return now - oldest;
  }

  /** The messages of `view` for every subscription it serves. */
  messages(view: View): PushEvent[] {
    return this.subs.filter((s) => s.view === view).map((s) => message(s.sub, view));
  }
}

function message(sub: Subscription, view: View): PushEvent {
  if (view.failure !== null) {
    return { kind: "refused", topic: sub.topic, param: sub.param, ...view.failure };
  }
  return { kind: "value", topic: sub.topic, param: sub.param, data: view.data } as PushEvent;
}

export class PushHub {
  readonly #now: () => number;
  readonly #timers: boolean;
  readonly #pingMs: number;
  readonly #limits: { perClient: number; perAccount: number; total: number };
  readonly run: string;
  readonly #views = new Map<string, View>();
  readonly #streams = new Set<Stream>();
  readonly #reserved = {
    total: 0,
    clients: new Map<string, number>(),
    accounts: new Map<string, number>(),
  };
  #seq = 0;
  #settle: ReturnType<typeof setTimeout> | undefined;
  #sweeper: ReturnType<typeof setInterval> | undefined;
  #flushing: Promise<void> = Promise.resolve();
  #stopped = false;

  constructor(options: HubOptions) {
    this.#now = options.now;
    this.#timers = options.timers ?? true;
    this.#pingMs = options.pingMs ?? PUSH_PING_MS;
    this.run = options.run ?? shortHash(`${Date.now()}:${Math.random()}`);
    this.#limits = {
      perClient: options.limits?.perClient ?? PUSH_STREAMS_PER_CLIENT,
      perAccount: options.limits?.perAccount ?? PUSH_STREAMS_PER_ACCOUNT,
      total: options.limits?.total ?? PUSH_STREAMS_TOTAL,
    };
  }

  /** The number of the last change. */
  get seq(): number {
    return this.#seq;
  }

  /** Open streams and followed views, for the tests and the logs. */
  get size(): { streams: number; views: number } {
    return { streams: this.#streams.size, views: this.#views.size };
  }

  /**
   * A place for one more stream of `client` (and `account`), or `429` / `503` past a limit. Taken
   * before anything is awaited, so two connects at once cannot both slip under it.
   */
  reserve(client: string, account: string | null): Ticket {
    const r = this.#reserved;
    if (this.#stopped || r.total >= this.#limits.total) {
      throw new ApiError(503, "too many people are watching; try again soon");
    }
    if ((r.clients.get(client) ?? 0) >= this.#limits.perClient) throw ApiError.tooMany(5_000);
    if (account !== null && (r.accounts.get(account) ?? 0) >= this.#limits.perAccount) {
      throw ApiError.tooMany(5_000);
    }
    const bump = (map: Map<string, number>, key: string, by: number) => {
      const n = (map.get(key) ?? 0) + by;
      if (n <= 0) map.delete(key);
      else map.set(key, n);
    };
    r.total += 1;
    bump(r.clients, client, 1);
    if (account !== null) bump(r.accounts, account, 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        r.total -= 1;
        bump(r.clients, client, -1);
        if (account !== null) bump(r.accounts, account, -1);
      },
    };
  }

  /**
   * A stream: the values (or only the changes since `lastEventId`), then `ready`, then each change
   * as it comes, until the client goes, the hub stops, or the stream is closed (`close`). The
   * ticket is released when it ends.
   */
  async *open(
    request: StreamRequest,
    ticket: Ticket,
    timing: (topic: PushTopic) => TopicTiming,
  ): AsyncGenerator<Outgoing, void, unknown> {
    let stream: Stream | null = null;
    try {
      const subs: Stream["subs"] = [];
      const names: string[] = [];
      for (const { sub, watch } of request.subscriptions) {
        const name = sub.param === null ? sub.topic : `${sub.topic}~${sub.param}`;
        if (isRefusal(watch)) {
          subs.push({ sub, view: null, refusal: watch });
          names.push(`${name}!`);
        } else {
          const view = this.#follow(sub.topic, watch, timing(sub.topic));
          subs.push({ sub, view, refusal: null });
          names.push(`${name}=${view.id}`);
        }
      }
      const hash = shortHash(names.sort().join("\n"));
      const opened = new Stream(request, ticket, hash, subs, this.#now());
      stream = opened;
      this.#streams.add(opened);
      for (const s of subs) if (s.view) this.#watch(s.view, opened);
      this.#startTimers();
      // A stream waiting for its next change cannot be returned from: the client going away
      // closes it, which ends that wait.
      request.signal?.addEventListener("abort", () => this.close(opened, false), { once: true });
      if (request.signal?.aborted) this.close(opened, false);

      await Promise.all(subs.map((s) => s.view?.ready));
      if (opened.closed) return;
      // From here to the first yield nothing is awaited: what is sent now is the state at `upTo`.
      const from = this.#resumeFrom(request.lastEventId, hash);
      const upTo = this.#seq;
      opened.pending.clear();
      const first: PushEvent[] = [];
      for (const s of subs) {
        if (s.refusal !== null) {
          first.push({
            kind: "refused",
            topic: s.sub.topic,
            param: s.sub.param,
            ...s.refusal.refused,
          });
          continue;
        }
        const view = s.view as View;
        const known = from !== null && view.since <= from && view.changed <= from;
        if (!known) first.push(message(s.sub, view));
      }
      for (const event of first) yield { event, id: null };
      yield { event: { kind: "ready" }, id: this.#id(upTo, hash) };

      while (!opened.closed) {
        if (opened.pending.size === 0) {
          const woken = await opened.wait(this.#pingMs);
          if (!woken && !opened.closed && opened.pending.size === 0) {
            yield { event: { kind: "ping" }, id: null };
          }
          continue;
        }
        const batchUpTo = this.#seq;
        const views = [...opened.pending.keys()];
        opened.pending.clear();
        const events = views.flatMap((v) => opened.messages(v));
        for (let i = 0; i < events.length; i++) {
          const event = events[i] as PushEvent;
          yield { event, id: i === events.length - 1 ? this.#id(batchUpTo, hash) : null };
        }
      }
    } finally {
      if (stream !== null) this.#forget(stream);
      ticket.release();
    }
  }

  /** Marks every view of `topic` as changed; they are built again after `PUSH_SETTLE_MS`. */
  touch(topic: PushTopic): void {
    let any = false;
    for (const view of this.#views.values()) {
      if (view.topic !== topic) continue;
      view.dirty = true;
      any = true;
    }
    if (any && this.#timers && this.#settle === undefined) {
      this.#settle = setTimeout(() => {
        this.#settle = undefined;
        void this.flush();
      }, PUSH_SETTLE_MS);
      this.#settle.unref?.();
    }
  }

  /** Builds every changed view again and offers the ones whose value changed to their streams. */
  flush(): Promise<void> {
    this.#flushing = this.#flushing.then(async () => {
      const dirty = [...this.#views.values()].filter((v) => v.dirty);
      for (const view of dirty) {
        view.dirty = false;
        await this.#rebuild(view);
      }
    });
    return this.#flushing;
  }

  /**
   * Looks over everything: drops streams that stopped reading, checks callers again, forgets views
   * nobody watched for `PUSH_LINGER_MS`, builds the ones whose tick came.
   */
  async sweep(): Promise<void> {
    const now = this.#now();
    const checks: Promise<void>[] = [];
    for (const stream of this.#streams) {
      if (stream.pending.size > 0 && stream.behind(now) >= PUSH_SLOW_MS) {
        log.info({ client: stream.request.client }, "push: dropped a stream that stopped reading");
        this.close(stream, true);
        continue;
      }
      if (now - stream.checkedAt < RECHECK_MS) continue;
      stream.checkedAt = now;
      checks.push(
        stream.request.recheck().then(
          (ok) => {
            if (!ok) this.close(stream, false);
          },
          () => this.close(stream, false),
        ),
      );
    }
    await Promise.all(checks);
    for (const view of this.#views.values()) {
      if (
        view.viewers.size === 0 &&
        view.idleSince !== null &&
        now - view.idleSince >= PUSH_LINGER_MS
      ) {
        this.#views.delete(view.id);
        continue;
      }
      // A lingering view keeps its tick too, so that a resume within the linger is right.
      if (view.timing.everyMs !== null && now - view.builtAt >= view.timing.everyMs) {
        view.dirty = true;
      }
    }
    await this.flush();
    if (this.#streams.size === 0 && this.#views.size === 0) this.#stopTimers();
  }

  /** Ends a stream: at once (`drop`) for a reader that stopped, else after what it is writing. */
  close(stream: { closed: boolean } | Stream, drop: boolean): void {
    const s = stream as Stream;
    if (s.closed) return;
    s.closed = true;
    this.#forget(s);
    s.ticket.release();
    s.wake();
    if (drop) s.request.drop();
  }

  /** Ends every stream (the module stops); later connects get `503`. */
  stop(): void {
    this.#stopped = true;
    for (const stream of [...this.#streams]) this.close(stream, false);
    this.#views.clear();
    this.#stopTimers();
  }

  /** The open streams, for `close` in tests. */
  streams(): ReadonlyArray<{ closed: boolean; request: StreamRequest }> {
    return [...this.#streams];
  }

  #id(seq: number, hash: string): string {
    return `${this.run}.${seq}.${hash}`;
  }

  /** The `seq` a reconnect may resume after, `null` when it must get every value again. */
  #resumeFrom(lastEventId: string | undefined, hash: string): number | null {
    if (lastEventId === undefined) return null;
    const [run, seq, was, ...rest] = lastEventId.trim().split(".");
    if (rest.length > 0 || run !== this.run || was !== hash || seq === undefined) return null;
    if (!/^\d{1,15}$/.test(seq)) return null;
    const n = Number(seq);
    return n <= this.#seq ? n : null;
  }

  #follow(topic: PushTopic, watch: Watch<unknown>, timing: TopicTiming): View {
    const id = `${topic}|${watch.key}`;
    const known = this.#views.get(id);
    if (known) return known;
    // A new view gets a number of its own: no id sent before it existed can claim to know it.
    this.#seq += 1;
    const view: View = {
      id,
      topic,
      timing,
      build: () => watch.build(),
      json: null,
      data: null,
      failure: null,
      since: this.#seq,
      changed: this.#seq,
      builtAt: this.#now(),
      viewers: new Set(),
      idleSince: null,
      dirty: false,
      ready: Promise.resolve(),
    };
    view.ready = this.#build(view);
    this.#views.set(id, view);
    return view;
  }

  #watch(view: View, stream: Stream): void {
    view.viewers.add(stream);
    view.idleSince = null;
  }

  #forget(stream: Stream): void {
    if (!this.#streams.delete(stream)) return;
    const now = this.#now();
    for (const s of stream.subs) {
      const view = s.view;
      if (view === null) continue;
      view.viewers.delete(stream);
      if (view.viewers.size === 0) view.idleSince = now;
    }
  }

  /** Builds `view` again after any build of it still running. */
  #rebuild(view: View): Promise<void> {
    view.ready = view.ready.then(() => this.#build(view));
    return view.ready;
  }

  /** Builds `view`; a change (value or failure) gets the next `seq` and goes to its streams. */
  async #build(view: View): Promise<void> {
    let json: string | null = null;
    let data: unknown = null;
    let failure: View["failure"] = null;
    try {
      data = await view.build();
      json = JSON.stringify(data);
    } catch (error) {
      failure = failureOf(error);
    }
    const now = this.#now();
    view.builtAt = now;
    const first = view.json === null && view.failure === null;
    const same =
      failure === null
        ? view.json === json
        : view.failure !== null &&
          view.failure.status === failure.status &&
          view.failure.message === failure.message;
    if (same && !first) return;
    view.json = json;
    view.data = data;
    view.failure = failure;
    if (first) return;
    this.#seq += 1;
    view.changed = this.#seq;
    for (const stream of view.viewers) stream.offer(view, now);
  }

  #startTimers(): void {
    if (!this.#timers || this.#sweeper !== undefined) return;
    this.#sweeper = setInterval(() => void this.sweep(), PUSH_SWEEP_MS);
    this.#sweeper.unref?.();
  }

  #stopTimers(): void {
    clearInterval(this.#sweeper);
    this.#sweeper = undefined;
    clearTimeout(this.#settle);
    this.#settle = undefined;
  }
}
