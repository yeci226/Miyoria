// The push streams on the route table (`push.public`, `push.member`; contract in
// `@miyoria/contracts/api` `push.ts`): which topics there are, what each one is (the polled
// route's own `Watch`), and when its views may have changed. The hub (`hub.ts`) does the rest.

import {
  MEMBER_PUSH_TOPICS,
  PUBLIC_PUSH_TOPICS,
  PUSH_MAX_TOPICS,
  PUSH_PARAM,
  type PushEvent,
  type PushTopic,
} from "@miyoria/contracts/api";
import { LIST_KINDS } from "@miyoria/play/exchange";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import { accountRefString } from "@miyoria/types";
import { withEventMeta } from "@orpc/server";
import { os } from "../contract.js";
import { ApiError } from "../errors.js";
import { exchangeListWatch, exchangeTickerWatch } from "../exchange-routes.js";
import { roomsWatch } from "../karaoke-routes.js";
import { publicSongsWatch, publicStatusWatch } from "../public.js";
import { memberStillIn } from "../recheck.js";
import type { SessionRecord } from "../session.js";
import type { ApiContext, ApiState } from "../state.js";
import { danmakuWatch } from "../wallet.js";
import type { Watch } from "../watch.js";
import { isRefusal, PushHub, type Refusal, type Subscription, type TopicTiming } from "./hub.js";

const log = getLogger("api.push");

type Audience = "public" | "member";

interface TopicDef {
  /** Who may follow it: `public` topics are on both streams, `member` ones on the member's. */
  audience: Audience;
  /** Whether it takes a parameter (`~<space>`, what the polled route takes as `?space=`). */
  param: boolean;
  timing: TopicTiming;
  /** The polled route's view for this viewer: its checks throw what the route would answer. */
  open(
    state: ApiState,
    c: ApiContext,
    param: string | undefined,
  ): Watch<unknown> | Promise<Watch<unknown>>;
}

/**
 * The topics. Each `open` is the function its polled route's handler calls, so the two cannot
 * drift apart: what the route refuses, the topic refuses with the same status.
 */
export const TOPICS: Record<PushTopic, TopicDef> = {
  /** Her state on the public pages (`GET /api/public/status`); its numbers of today move by the minute. */
  status: {
    audience: "public",
    param: false,
    timing: {
      triggers: [
        "activity.*",
        "sing.*",
        "speech.pause",
        "voice.joined",
        "voice.left",
        "voice.golive",
      ],
      everyMs: 10_000,
    },
    open: (state) => publicStatusWatch(state),
  },
  /** What she sings and will sing in one server (`GET /api/public/songs?space=`). */
  songs: {
    audience: "public",
    param: true,
    timing: { triggers: ["sing.*", "queue.*", "voice.playback"], everyMs: 5_000 },
    open: (state, _c, param) => publicSongsWatch(state, param),
  },
  /** Whether a karaoke room can be opened (`GET /api/member/karaoke/rooms?space=`). */
  rooms: {
    audience: "member",
    param: true,
    timing: {
      triggers: ["activity.changed", "voice.joined", "voice.left", "karaoke.*", "economy.posted"],
      everyMs: 5_000,
    },
    open: (state, c, param) => roomsWatch(state, c, param),
  },
  /** Whether and at what price a danmaku line can be sent (`GET /api/member/danmaku`). */
  danmaku: {
    audience: "member",
    param: false,
    timing: {
      triggers: [
        "activity.changed",
        "economy.danmaku",
        "economy.danmaku.clear",
        "economy.posted",
        "stage.status",
      ],
      everyMs: 10_000,
    },
    open: (state, c) => danmakuWatch(state, c),
  },
  /**
   * A list of the exchange as this member sees it (`GET /api/member/exchange/list/{kind}`). Quotes
   * are fetched once a pass (`quote_poll_seconds`, a minute by default) and no event says so: the
   * tick finds the new prices within 10 s, and only a list whose rows changed goes out.
   */
  exchange_list: {
    audience: "member",
    param: true,
    timing: { triggers: ["economy.posted"], everyMs: 10_000 },
    open: (state, c, param) => {
      if (param === undefined || !(LIST_KINDS as readonly string[]).includes(param)) {
        throw ApiError.badRequest("no such list");
      }
      return exchangeListWatch(state, c, param as (typeof LIST_KINDS)[number]);
    },
  },
  /** One ticker's line and chart (`GET /api/member/exchange/ticker/{code}`). */
  exchange_ticker: {
    audience: "member",
    param: true,
    timing: { triggers: ["economy.posted"], everyMs: 10_000 },
    open: (state, c, param) => {
      if (param === undefined) throw ApiError.badRequest("which ticker");
      return exchangeTickerWatch(state, c, param);
    },
  },
};

const ALLOWED: Record<Audience, ReadonlySet<string>> = {
  public: new Set(PUBLIC_PUSH_TOPICS),
  member: new Set([...PUBLIC_PUSH_TOPICS, ...MEMBER_PUSH_TOPICS]),
};

/** `?topics=` read: the subscriptions, each once, or `400` naming what is wrong. */
export function parseTopics(text: string, audience: Audience): Subscription[] {
  const out: Subscription[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(",")) {
    const part = raw.trim();
    if (part === "" || seen.has(part)) continue;
    seen.add(part);
    const at = part.indexOf("~");
    const name = at < 0 ? part : part.slice(0, at);
    const param = at < 0 ? null : part.slice(at + 1);
    if (!ALLOWED[audience].has(name))
      throw ApiError.badRequest(`no such topic here: ${name.slice(0, 32)}`);
    const def = TOPICS[name as PushTopic];
    if (param !== null && (!def.param || !PUSH_PARAM.test(param))) {
      throw ApiError.badRequest(`a bad parameter for ${name}`);
    }
    out.push({ topic: name as PushTopic, param });
  }
  if (out.length === 0) throw ApiError.badRequest("no topics");
  if (out.length > PUSH_MAX_TOPICS) throw ApiError.badRequest(`at most ${PUSH_MAX_TOPICS} topics`);
  return out;
}

/** A topic's view for this viewer, or what its route would refuse. */
async function openOne(
  state: ApiState,
  c: ApiContext,
  sub: Subscription,
): Promise<Watch<unknown> | Refusal> {
  try {
    return await TOPICS[sub.topic].open(state, c, sub.param ?? undefined);
  } catch (error) {
    if (error instanceof ApiError)
      return { refused: { status: error.status, message: error.message } };
    log.warn({ topic: sub.topic, error: errorMessage(error) }, "push: a topic could not be opened");
    return { refused: { status: 500, message: "something went wrong" } };
  }
}

/** One hub per running `api` module, following the bus while the module runs. */
const hubs = new WeakMap<ApiState, PushHub>();

export function hubOf(state: ApiState): PushHub {
  const known = hubs.get(state);
  if (known) return known;
  const hub = new PushHub({ now: () => state.now() });
  hubs.set(state, hub);
  const ctx = state.ctx as Partial<Pick<ApiState["ctx"], "subscribe" | "signal">>;
  for (const [topic, def] of Object.entries(TOPICS) as Array<[PushTopic, TopicDef]>) {
    if (typeof ctx.subscribe !== "function") break;
    const sub = ctx.subscribe([...def.timing.triggers]);
    void (async () => {
      for await (const _ of sub) hub.touch(topic);
    })().catch((error: unknown) => {
      log.warn({ topic, error: errorMessage(error) }, "push: stopped following the bus");
    });
  }
  ctx.signal?.addEventListener("abort", () => hub.stop(), { once: true });
  return hub;
}

/** Ends the request's connection at once (Hono's node server keeps the request as `incoming`). */
function dropConnection(c: ApiContext): void {
  const env = c.env as { incoming?: { socket?: { destroy(): void } } } | undefined;
  env?.incoming?.socket?.destroy();
}

/** The account a member stream is for (`platform:id`). */
const accountOf = (c: ApiContext) => accountRefString((c.get("member") as SessionRecord).account);

async function* stream(
  state: ApiState,
  c: ApiContext,
  audience: Audience,
  topics: string,
  lastEventId: string | undefined,
  signal: AbortSignal | undefined,
): AsyncGenerator<PushEvent, void, unknown> {
  // Everything that can refuse the whole stream is checked before its first event, in the handler.
  const subs = parseTopics(topics, audience);
  const side = state.publicSide;
  const client = side.client(c);
  const wait = side.admit(client);
  if (wait !== null) throw ApiError.tooMany(wait);
  const account = audience === "member" ? accountOf(c) : null;
  const hub = hubOf(state);
  const ticket = hub.reserve(client, account);
  let subscriptions: Array<{ sub: Subscription; watch: Watch<unknown> | Refusal }>;
  try {
    subscriptions = await Promise.all(
      subs.map(async (sub) => ({ sub, watch: await openOne(state, c, sub) })),
    );
  } catch (error) {
    ticket.release();
    throw error;
  }
  const keys = subscriptions.map(({ watch }) => (isRefusal(watch) ? null : watch.key));
  const events = hub.open(
    {
      client,
      account,
      subscriptions,
      lastEventId,
      ...(signal ? { signal } : {}),
      recheck: async () => {
        if (audience === "member" && !(await memberStillIn(state, c))) return false;
        // Each topic again, as its route would check it now: a refusal or another view ends it.
        for (let i = 0; i < subs.length; i++) {
          const was = keys[i];
          if (was === null) continue;
          const now = await openOne(state, c, subs[i] as Subscription);
          if (isRefusal(now) || now.key !== was) return false;
        }
        return true;
      },
      drop: () => dropConnection(c),
    },
    ticket,
    (topic) => TOPICS[topic].timing,
  );
  yield* withIds(events);
}

/** The hub's events with their SSE ids. */
async function* withIds(
  events: ReturnType<PushHub["open"]>,
): AsyncGenerator<PushEvent, void, unknown> {
  for await (const out of events)
    yield out.id === null ? out.event : withEventMeta(out.event, { id: out.id });
}

/**
 * Starts a stream: its refusals (a bad topic, the rate limit, too many streams) are answered as
 * statuses, before the stream begins; everything after is events. Returning the stream (the
 * client went away) ends it even while it waits for its next change.
 */
async function begin(
  state: ApiState,
  c: ApiContext,
  audience: Audience,
  topics: string,
  lastEventId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<AsyncIteratorObject<PushEvent, void, unknown>> {
  const stop = new AbortController();
  const ended = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  const events = stream(state, c, audience, topics, lastEventId, ended);
  // Run it to its first event, so what refuses the whole stream is thrown here.
  let head: IteratorResult<PushEvent, void> | null = await events.next();
  const iterator: AsyncIteratorObject<PushEvent, void, unknown> = {
    next: async () => {
      if (head !== null) {
        const first = head;
        head = null;
        return first;
      }
      return events.next();
    },
    return: async (value) => {
      stop.abort();
      return events.return(value);
    },
    throw: async (error) => {
      stop.abort();
      return events.throw(error);
    },
    [Symbol.asyncDispose]: async () => {
      stop.abort();
      await events.return(undefined);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return iterator;
}

export const pushRpc = {
  public: os.push.public.handler(({ input, context, signal, lastEventId }) =>
    begin(context.state, context.c, "public", input.query.topics, lastEventId, signal),
  ),
  member: os.push.member.handler(({ input, context, signal, lastEventId }) =>
    begin(context.state, context.c, "member", input.query.topics, lastEventId, signal),
  ),
};
