import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { type StreamStatus, streamEvents } from "../api/sse";
import { asE2eRecord } from "../lib/e2e";
import type { BusEnvelope } from "../lib/events";
import { useConnection } from "./connection";
import { queryKeys } from "./queries";

export const EVENT_BUFFER = 500;

/**
 * The admin live page's views kept fresh by the event stream (v5-architecture §11.4): each is
 * fetched again when a bus topic says it changed, and polled only slowly while the stream is open
 * (`useLivePoll`). After a gap in the stream they are all fetched again. A function, not a
 * constant: `queries.ts` imports this module too.
 */
export const liveViews = (): ReadonlyArray<{ key: readonly unknown[]; topics: (type: string) => boolean }> => [
  { key: queryKeys.queue, topics: (t) => t === "queue.changed" },
  { key: queryKeys.songs, topics: (t) => t.startsWith("sing.") || t === "queue.item_activated" },
  {
    key: queryKeys.voice,
    topics: (t) => t === "voice.joined" || t === "voice.left" || t === "voice.participants" || t === "voice.golive",
  },
  { key: queryKeys.stage, topics: (t) => t === "stage.status" || t === "voice.golive" },
];

/** A view is fetched again at most this often for its topics (a song's progress comes often). */
export const LIVE_REFETCH_MS = 1_000;
/** How often a view kept fresh by the stream is still polled while the stream is open. */
export const LIVE_SAFETY_MS = 60_000;

/**
 * Keeps the body, arbiter, affect, plan and turn views fresh from the v2 topics. The topics that
 * carry the whole new state (`activity.changed`, `affect.changed`) are written straight into the
 * cache; the others only mark their lists stale.
 */
export function applyCustomEvent(queryClient: QueryClient, env: BusEnvelope): void {
  const { type: topic, data: payload } = env;
  const stale = (queryKey: readonly unknown[]) => void queryClient.invalidateQueries({ queryKey });
  switch (topic) {
    case "activity.changed":
      queryClient.setQueryData(queryKeys.activity, payload);
      stale(queryKeys.activityTasks);
      stale(queryKeys.world);
      break;
    case "activity.started":
    case "activity.done":
    case "activity.failed":
      stale(queryKeys.activityTasks);
      break;
    case "arbiter.decision":
    case "arbiter.ledger":
      stale(queryKeys.arbiter);
      break;
    case "affect.changed":
      queryClient.setQueryData(queryKeys.affect, payload);
      break;
    case "plan.goal":
      stale(queryKeys.goals);
      break;
    case "agent.turn.outcome":
      stale(queryKeys.turnsAll);
      break;
    case "agent.prompt":
      stale(queryKeys.prompts);
      break;
    case "voice.latency": {
      // The Core keeps no per-reply history: the panel keeps what it saw, for the turn view.
      const record = asE2eRecord(payload);
      if (record?.turn) queryClient.setQueryData(queryKeys.turnE2e(record.turn), record);
      break;
    }
  }
}

export interface EventSnapshot {
  /** Newest first, at most `EVENT_BUFFER`. */
  events: BusEnvelope[];
  status: StreamStatus;
  /** Events received since the panel opened (not capped). */
  received: number;
}

type Listener = () => void;

/** Ring buffer of bus envelopes; notifies at most every `flushMs`. */
export class EventStore {
  private snapshot: EventSnapshot = { events: [], status: { state: "closed" }, received: 0 };
  private pending: BusEnvelope[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<Listener>();

  constructor(private readonly flushMs = 80) {}

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): EventSnapshot => this.snapshot;

  push(env: BusEnvelope): void {
    this.pending.push(env);
    if (this.timer === undefined) this.timer = setTimeout(() => this.flush(), this.flushMs);
  }

  flush(): void {
    this.timer = undefined;
    if (this.pending.length === 0) return;
    const fresh = this.pending.reverse();
    this.pending = [];
    this.snapshot = {
      ...this.snapshot,
      events: [...fresh, ...this.snapshot.events].slice(0, EVENT_BUFFER),
      received: this.snapshot.received + fresh.length,
    };
    this.emit();
  }

  setStatus(status: StreamStatus): void {
    this.snapshot = { ...this.snapshot, status };
    this.emit();
  }

  clear(): void {
    this.snapshot = { ...this.snapshot, events: [] };
    this.emit();
  }

  private emit() {
    for (const l of this.listeners) l();
  }
}

export const EventStoreContext = createContext<EventStore | null>(null);

/** Keeps one `/api/events` stream open while signed in (token or session) and shares it. */
export function EventStreamProvider({ children }: { children: ReactNode }) {
  const { api } = useConnection();
  const queryClient = useQueryClient();
  const store = useMemo(() => new EventStore(), []);

  // The live views: at most one fetch per `LIVE_REFETCH_MS` each, the last change never lost.
  const later = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const last = useRef(new Map<string, number>());
  useEffect(() => {
    const timers = later.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    const refetch = (key: readonly unknown[]) => {
      const id = JSON.stringify(key);
      if (later.current.has(id)) return;
      const wait = Math.max(0, (last.current.get(id) ?? 0) + LIVE_REFETCH_MS - Date.now());
      later.current.set(
        id,
        setTimeout(() => {
          later.current.delete(id);
          last.current.set(id, Date.now());
          void queryClient.invalidateQueries({ queryKey: key });
        }, wait),
      );
    };
    let wasOpen = false;
    void streamEvents(api.rpc, {
      signal: ctl.signal,
      onStatus: (s) => {
        store.setStatus(s);
        // Back after a gap: what changed meanwhile is fetched, as a snapshot.
        if (s.state === "open" && !wasOpen) for (const view of liveViews()) refetch(view.key);
        wasOpen = s.state === "open";
      },
      onEnvelope: (env) => {
        store.push(env);
        for (const view of liveViews()) if (view.topics(env.type)) refetch(view.key);
        // Keep cached lists fresh without polling.
        const t = env.type;
        if (t === "system.module.state") void queryClient.invalidateQueries({ queryKey: queryKeys.modules });
        else if (t.startsWith("cluster.")) void queryClient.invalidateQueries({ queryKey: queryKeys.cluster });
        else if (t === "agent.decision") void queryClient.invalidateQueries({ queryKey: queryKeys.decisionsAll });
        else if (t === "agent.turn.completed") void queryClient.invalidateQueries({ queryKey: queryKeys.usage });
        else applyCustomEvent(queryClient, env);
      },
    });
    return () => ctl.abort();
  }, [api, queryClient, store]);

  return <EventStoreContext.Provider value={store}>{children}</EventStoreContext.Provider>;
}

export function useEventStore(): EventStore {
  const s = useContext(EventStoreContext);
  if (!s) throw new Error("useEventStore outside EventStreamProvider");
  return s;
}

export function useEvents(): EventSnapshot {
  const store = useEventStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

const noStore = () => () => {};

/**
 * The polling interval of a live view (`liveViews`): `ms` while the admin event stream is not
 * open (or outside the admin shell), `LIVE_SAFETY_MS` while it is.
 */
export function useLivePoll(ms: number): number {
  const store = useContext(EventStoreContext);
  const open = useSyncExternalStore(
    store ? store.subscribe : noStore,
    () => store?.getSnapshot().status.state === "open",
    () => false,
  );
  return open ? Math.max(ms, LIVE_SAFETY_MS) : ms;
}
