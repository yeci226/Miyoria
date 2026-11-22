// Server push on the page side (docs/design/v5-architecture.md §11.4). One stream per page, its
// audience set by the page (`PushProvider`): the member stream on a logged-in member's pages, the
// public one elsewhere. Each hook that can be pushed says which topic it is and where its polled
// answer lives in the query cache (`usePushed`); the stream writes each value there, so the
// components stay as they are, and while a topic is pushed its polling stops. Whenever the stream
// is not there (it cannot connect, it broke, the Core is older, a topic was refused) the hooks
// poll exactly as before; the stream tries again with backoff and takes over when it works.

import type { ApiRpc, PushEvent, PushTopic } from "@miyoria/contracts/api";
import { getEventMeta } from "@orpc/client";
import { type QueryClient, type QueryKey, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { isApiError } from "@/api/http";
import { backoff } from "@/api/sse";
import { type Death, watchdog } from "@/api/watchdog";
import { useConnection } from "./connection";

export type PushAudience = "public" | "member";

/** A stream that stayed open this long worked: the next reconnect starts the backoff over. */
const STABLE_MS = 10_000;
/** The longest wait between two tries while the stream keeps failing. */
const MAX_WAIT_MS = 60_000;
/** The wait after an answer that will not change soon (an older Core, push turned off, logged out). */
const OFF_WAIT_MS = 5 * 60_000;
/** Hooks mounting together settle into one connection. */
const SETTLE_MS = 50;

/**
 * Whether a parameter can go in a topic (the server's `PUSH_PARAM`, kept here so the contract's
 * schemas stay out of the bundle): a hook with another one simply polls.
 */
export const pushable = (param: string) => /^[A-Za-z0-9._-]{1,64}$/.test(param);

/** One topic a page wants: `songs`, or `songs~<space>`. */
export const topicId = (topic: PushTopic, param: string | null) => (param === null ? topic : `${topic}~${param}`);

interface Want {
  topic: PushTopic;
  param: string | null;
  key: QueryKey;
  count: number;
}

export interface PushClientOptions {
  rpc: ApiRpc;
  queryClient: QueryClient;
  audience: PushAudience;
  /** The wait before try number `attempt`; with jitter by default. */
  delay?: (attempt: number) => number;
  now?: () => number;
}

export type PushState = "idle" | "connecting" | "open" | "waiting";

/** Follows one push stream for whatever the page's hooks want. */
export class PushClient {
  readonly #o: Required<Omit<PushClientOptions, "delay" | "now">> & { delay: (attempt: number) => number; now: () => number };
  readonly #wants = new Map<string, Want>();
  /** Topics whose values come by push right now (their hooks do not poll). */
  readonly #live = new Set<string>();
  readonly #listeners = new Set<() => void>();
  #running = false;
  #connection: AbortController | null = null;
  #topics = "";
  #lastId: string | undefined;
  #lastIdTopics = "";
  #settle: ReturnType<typeof setTimeout> | undefined;
  #state: PushState = "idle";

  constructor(options: PushClientOptions) {
    this.#o = {
      ...options,
      delay: options.delay ?? ((attempt) => backoff(attempt, MAX_WAIT_MS)),
      now: options.now ?? Date.now,
    };
  }

  get state(): PushState {
    return this.#state;
  }

  /** The page wants `topic`; its values go to `key`. Returns the release. */
  want(topic: PushTopic, param: string | null, key: QueryKey): () => void {
    const id = topicId(topic, param);
    const known = this.#wants.get(id);
    if (known) known.count += 1;
    else this.#wants.set(id, { topic, param, key, count: 1 });
    this.#schedule();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const w = this.#wants.get(id);
      if (!w) return;
      w.count -= 1;
      if (w.count > 0) return;
      this.#wants.delete(id);
      if (this.#live.delete(id)) this.#emit();
      this.#schedule();
    };
  }

  isLive(id: string): boolean {
    return this.#live.has(id);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#schedule();
  }

  /** Closes the stream; the hooks poll. `start` follows again. */
  stop(): void {
    this.#running = false;
    clearTimeout(this.#settle);
    this.#settle = undefined;
    this.#close();
  }

  #schedule(): void {
    if (!this.#running || this.#settle !== undefined) return;
    this.#settle = setTimeout(() => {
      this.#settle = undefined;
      this.#reconcile();
    }, SETTLE_MS);
  }

  /** Opens, reopens or closes the stream for what is wanted now. */
  #reconcile(): void {
    const topics = [...this.#wants.keys()].sort().join(",");
    if (topics === this.#topics && this.#connection !== null) return;
    this.#close();
    this.#topics = topics;
    if (topics === "" || !this.#running) return;
    const ctl = new AbortController();
    this.#connection = ctl;
    void this.#follow(topics, ctl.signal);
  }

  /**
   * Closes the stream on purpose (other topics, the page going away): its topics poll until the
   * next stream is ready, which sends their values again, so nothing is fetched now.
   */
  #close(): void {
    this.#connection?.abort();
    this.#connection = null;
    this.#topics = "";
    this.#fallBack(false);
    this.#setState("idle");
  }

  /** Every pushed topic polls again; `refetch`: starting now (the stream broke, it may be stale). */
  #fallBack(refetch = true): void {
    if (this.#live.size === 0) return;
    const keys = [...this.#live].map((id) => this.#wants.get(id)?.key).filter((k) => k !== undefined);
    this.#live.clear();
    this.#emit();
    if (!refetch) return;
    for (const key of keys) void this.#o.queryClient.invalidateQueries({ queryKey: key, exact: true });
  }

  async #follow(topics: string, signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      attempt += 1;
      this.#setState("connecting");
      let openedAt: number | null = null;
      let wait: number | null = null;
      // Nothing at all (no value, `ready` or `ping`, not a byte) for `SILENT_MS`: the stream is
      // dead even if its socket is not closed (a proxy holding a gone connection).
      const inner = new AbortController();
      const both = AbortSignal.any([signal, inner.signal]);
      const died: { why: Death | null } = { why: null };
      const dog = watchdog((why) => {
        died.why = why;
        inner.abort();
      }, this.#o.now);
      try {
        const call = this.#o.audience === "member" ? this.#o.rpc.push.member : this.#o.rpc.push.public;
        const lastEventId = this.#lastIdTopics === topics ? this.#lastId : undefined;
        const stream = await call(
          { query: { topics } },
          { signal: both, context: { onActivity: dog.seen }, ...(lastEventId ? { lastEventId } : {}) },
        );
        openedAt = this.#o.now();
        this.#setState("open");
        const refused = new Set<string>();
        const stop = () => void stream.return().catch(() => undefined);
        both.addEventListener("abort", stop, { once: true });
        try {
          for await (const event of stream) {
            dog.seen();
            const id = getEventMeta(event)?.id;
            if (id !== undefined) {
              this.#lastId = id;
              this.#lastIdTopics = topics;
            }
            this.#take(event, refused);
          }
        } finally {
          both.removeEventListener("abort", stop);
        }
      } catch (error) {
        if (signal.aborted) break;
        // An older Core (no such route), push turned off, a session that ended: not soon again.
        if (died.why === null && isApiError(error) && (error.kind === "not_provided" || error.kind === "unauthorized")) wait = OFF_WAIT_MS;
      } finally {
        dog.stop();
      }
      if (signal.aborted) break;
      // Dead or broken: its topics poll again, starting with a fetch now.
      this.#fallBack();
      if (died.why === "asleep") {
        // The page slept (timers held back, a laptop resumed): reconnect once, now, from the start.
        attempt = 0;
        continue;
      }
      if (openedAt !== null && this.#o.now() - openedAt >= STABLE_MS) attempt = 0;
      this.#setState("waiting");
      await sleep(wait ?? this.#o.delay(Math.max(1, attempt)), signal);
    }
  }

  /** One event: a value into the cache; `ready` hands the topics to the stream. */
  #take(event: PushEvent, refused: Set<string>): void {
    if (event.kind === "ping") return;
    if (event.kind === "ready") {
      let changed = false;
      for (const id of this.#wants.keys()) {
        if (refused.has(id) || this.#live.has(id)) continue;
        this.#live.add(id);
        changed = true;
      }
      if (changed) this.#emit();
      return;
    }
    const id = topicId(event.topic, event.param);
    const want = this.#wants.get(id);
    if (event.kind === "refused") {
      refused.add(id);
      if (this.#live.delete(id)) {
        this.#emit();
        if (want) void this.#o.queryClient.invalidateQueries({ queryKey: want.key, exact: true });
      }
      return;
    }
    if (!want) return;
    this.#o.queryClient.setQueryData(want.key, event.data);
    // A topic refused earlier on this stream is followed again once a value comes.
    if (refused.delete(id) && !this.#live.has(id)) {
      this.#live.add(id);
      this.#emit();
    }
  }

  #setState(state: PushState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#emit();
  }

  #emit(): void {
    for (const l of this.#listeners) l();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

const PushContext = createContext<PushClient | null>(null);

/** The page's push stream for `audience`, while it is mounted. */
export function PushProvider({ audience, children }: { audience: PushAudience; children: ReactNode }) {
  const { api } = useConnection();
  const queryClient = useQueryClient();
  const client = useMemo(() => new PushClient({ rpc: api.rpc, queryClient, audience }), [api, queryClient, audience]);
  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);
  return <PushContext.Provider value={client}>{children}</PushContext.Provider>;
}

/** For tests: a provider around a client made by hand. */
export function PushClientProvider({ client, children }: { client: PushClient; children: ReactNode }) {
  return <PushContext.Provider value={client}>{children}</PushContext.Provider>;
}

const never = () => () => {};
const notLive = () => false;

/**
 * Whether `topic` comes by push now, its values going to `key` (the polled query's own key). A
 * hook polls when this is `false`, and only then. Outside a `PushProvider` it is always `false`
 * (nothing changes for the pages and tests without one). `enabled: false` wants nothing.
 */
export function usePushed(topic: PushTopic, param: string | null, key: QueryKey, enabled = true): boolean {
  const client = useContext(PushContext);
  const id = topicId(topic, param);
  const keyText = JSON.stringify(key);
  useEffect(() => {
    if (!client || !enabled) return;
    return client.want(topic, param, JSON.parse(keyText) as QueryKey);
  }, [client, topic, param, keyText, enabled]);
  return useSyncExternalStore(
    client ? client.subscribe : never,
    client && enabled ? () => client.isLive(id) : notLive,
    notLive,
  );
}
